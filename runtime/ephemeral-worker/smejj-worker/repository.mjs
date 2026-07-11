import { lstat, mkdtemp, readdir, readFile } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createWorkspace, runTrusted, workspaceHandle } from "./sandbox.mjs";
import { isBlockedRelativePath } from "./path-policy.mjs";

const SKIP_DIRS = new Set([".git", "node_modules", ".pnpm-store", "dist", "build", "coverage", "model-files"]);
const SOURCE_PATHSPEC = Object.freeze([
  ".",
  ":(exclude)node_modules/**",
  ":(exclude).pnpm-store/**",
  ":(exclude).pytest_cache/**",
  ":(exclude)**/__pycache__/**",
  ":(exclude)**/*.pyc",
  ":(exclude).nyc_output/**",
  ":(exclude)coverage/**",
  ":(exclude)playwright-report/**",
  ":(exclude)test-results/**"
]);
const MAX_CHANGE_SET_BYTES = 650_000;
const ALLOWED_GIT_MODES = new Set(["100644", "100755"]);

export async function prepareRepository(payload = {}, { signal = null } = {}) {
  throwIfAborted(signal);
  const repository = normalizeRepository(payload.repository || payload.repo || {});
  if (!repository.url) {
    const workspace = await createWorkspace(payload.files || []);
    const baseCommit = await revision(workspace.root, "HEAD");
    const branch = branchName(payload.jobId);
    await requireOk(runTrusted(workspace.root, ["git", "checkout", "-b", branch]), "git_branch_failed");
    return { ...workspace, repository: { ...repository, baseCommit, branch, mode: "inline-files" } };
  }

  const workspace = workspaceHandle(await mkdtemp(path.join(os.tmpdir(), "smejj.com-worker-repo-")));
  const cloneArgs = ["git", "clone", "--depth", "1", "--no-tags", "--single-branch", "--branch", repository.baseRef, repository.url, "."];
  const clone = await runTrusted(workspace.root, safeGit(cloneArgs.slice(1)), {
    timeoutMs: 300_000,
    env: { ...isolatedGitEnvironment(), ...gitAuthEnvironment(repository.token) },
    signal
  });
  if (!clone.ok) {
    await workspace.cleanup();
    throw new Error(`git_clone_failed:${clone.stderr || clone.stdout}`);
  }
  throwIfAborted(signal);
  await runTrusted(workspace.root, ["git", "config", "user.name", "smejj.com Worker"]);
  await runTrusted(workspace.root, ["git", "config", "user.email", "worker@smejj.com"]);
  const baseCommit = await revision(workspace.root, "HEAD");
  const branch = branchName(payload.jobId);
  await requireOk(runTrusted(workspace.root, ["git", "checkout", "-b", branch]), "git_branch_failed");
  return { ...workspaceHandle(workspace.root), repository: { ...withoutToken(repository), baseCommit, branch, mode: "git-clone" } };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("job_cancelled");
}

export async function buildRepositorySummary(root, { maxFiles = 1200 } = {}) {
  const files = [];
  await walk(root, "", files, maxFiles);
  let packageScripts = [];
  try {
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    packageScripts = Object.keys(packageJson.scripts || {}).slice(0, 80);
  } catch {
    packageScripts = [];
  }
  return {
    fileCount: files.length,
    files: files.slice(0, maxFiles),
    packageScripts,
    truncated: files.length >= maxFiles
  };
}

export async function repositoryDiff(root) {
  const env = isolatedGitEnvironment();
  const intent = await runTrusted(root, safeGit(["add", "--intent-to-add", "--all", "--", ...SOURCE_PATHSPEC]), { timeoutMs: 30_000, env });
  if (!intent.ok) throw new Error(`git_intent_to_add_failed:${intent.stderr}`);
  const names = await runTrusted(root, safeGit(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "HEAD", "--", ...SOURCE_PATHSPEC]), { timeoutMs: 30_000, maxOutputChars: 200_000, env });
  if (!names.ok) throw new Error(`git_diff_names_failed:${names.stderr}`);
  const changed = names.stdout.split("\0").filter(Boolean);
  const blocked = changed.filter((name) => isBlockedRelativePath(name));
  if (blocked.length) throw new Error(`sensitive_diff_path_blocked:${blocked.slice(0, 10).join(",")}`);
  for (const name of changed) {
    try {
      if ((await lstat(path.join(root, name))).isSymbolicLink()) throw new Error(`symlink_diff_path_blocked:${name}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const result = await runTrusted(root, safeGit(["diff", "--no-ext-diff", "--no-textconv", "--text", "HEAD", "--", ...SOURCE_PATHSPEC]), { timeoutMs: 30_000, maxOutputChars: 1_000_001, env });
  if (!result.ok) throw new Error(`git_diff_failed:${result.stderr}`);
  if (result.stdout.length > 1_000_000) throw new Error("git_diff_too_large");
  return result.stdout;
}

export async function repositoryStatus(root) {
  const result = await runTrusted(root, safeGit(["status", "--short"]), { timeoutMs: 10_000, env: isolatedGitEnvironment() });
  return result.ok ? result.stdout.slice(0, 100_000) : "";
}

export async function buildVerifiedChangeSet(root, { expectedDiffSha256 } = {}) {
  if (!/^[a-f0-9]{64}$/.test(String(expectedDiffSha256 || ""))) throw new Error("change_set_diff_hash_required");
  const diff = await repositoryDiff(root);
  if (sha256(diff) !== expectedDiffSha256) throw new Error("change_set_diff_hash_mismatch");
  const env = isolatedGitEnvironment();
  const names = await runTrusted(root, safeGit([
    "diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--no-renames",
    "HEAD", "--", ...SOURCE_PATHSPEC
  ]), { timeoutMs: 30_000, maxOutputChars: 200_000, env });
  if (!names.ok) throw new Error(`change_set_names_failed:${names.stderr}`);
  const changed = parseNameStatus(names.stdout);
  const changes = [];
  let totalBytes = 0;
  for (const entry of changed) {
    if (isBlockedRelativePath(entry.path)) throw new Error(`change_set_sensitive_path_blocked:${entry.path}`);
    const base = entry.status === "A" ? null : await treeEntry(root, entry.path, env);
    if (entry.status !== "A" && !base) throw new Error(`change_set_base_blob_missing:${entry.path}`);
    if (entry.status === "D") {
      changes.push({ status: "deleted", path: entry.path, mode: base.mode, baseBlobSha: base.sha, bytes: 0, contentSha256: null, contentBase64: null });
      continue;
    }
    const file = await lstat(path.join(root, entry.path));
    if (!file.isFile() || file.isSymbolicLink()) throw new Error(`change_set_file_type_blocked:${entry.path}`);
    const mode = file.mode & 0o111 ? "100755" : "100644";
    const bytes = await readFile(path.join(root, entry.path));
    if (bytes.includes(0) || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) {
      throw new Error(`change_set_binary_file_blocked:${entry.path}`);
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_CHANGE_SET_BYTES) throw new Error("change_set_content_too_large");
    changes.push({
      status: entry.status === "A" ? "added" : "modified",
      path: entry.path,
      mode,
      baseBlobSha: base?.sha || null,
      bytes: bytes.length,
      contentSha256: sha256(bytes),
      contentBase64: bytes.toString("base64")
    });
  }
  return {
    schemaVersion: 1,
    baseCommit: await safeRevision(root, "HEAD", env),
    diffSha256: expectedDiffSha256,
    totalBytes,
    changes: changes.sort((left, right) => left.path.localeCompare(right.path))
  };
}

export async function commitVerifiedChanges(root, message, { expectedDiffSha256 = "" } = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedDiffSha256)) throw new Error("git_expected_diff_hash_required");
  const env = isolatedGitEnvironment();
  const baseCommit = await safeRevision(root, "HEAD", env);
  await requireOk(runTrusted(root, safeGit(["add", "-A", "--", ...SOURCE_PATHSPEC]), { env }), "git_add_failed");
  const staged = await runTrusted(root, safeGit(["diff", "--cached", "--quiet", "--no-ext-diff"]), { env });
  if (staged.code === 0) return { changed: false, commit: await revision(root, "HEAD") };
  if (staged.code !== 1) throw new Error(`git_staged_diff_failed:${staged.stderr}`);
  const commit = await runTrusted(root, safeGit([
    "commit", "--quiet", "--no-verify", "--no-gpg-sign",
    "-m", String(message || "Verified smejj.com agent change").slice(0, 160)
  ]), { env });
  if (!commit.ok) throw new Error(`git_commit_failed:${commit.stderr}`);
  const committedDiff = await runTrusted(root, safeGit([
    "diff", "--no-ext-diff", "--no-textconv", "--text", baseCommit, "HEAD", "--", ...SOURCE_PATHSPEC
  ]), { timeoutMs: 30_000, maxOutputChars: 1_000_001, env });
  if (!committedDiff.ok || committedDiff.stdout.length > 1_000_000 || sha256(committedDiff.stdout) !== expectedDiffSha256) {
    throw new Error("git_committed_diff_hash_mismatch");
  }
  return { changed: true, commit: await safeRevision(root, "HEAD", env) };
}

export async function applyUnifiedDiff(root, diff) {
  const result = await runTrusted(root, safeGit(["apply", "--whitespace=nowarn", "-"]), {
    stdin: String(diff || ""),
    timeoutMs: 30_000,
    env: isolatedGitEnvironment()
  });
  if (!result.ok) throw new Error(`git_apply_failed:${result.stderr || result.stdout}`);
}

export function gitAuthEnvironment(token) {
  if (!token) return {};
  const authorization = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
    GIT_TERMINAL_PROMPT: "0"
  };
}

function safeGit(parts) {
  return [
    "git",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "commit.gpgSign=false",
    "-c", "credential.helper=",
    "-c", "http.proxy=",
    "-c", "https.proxy=",
    "-c", "http.followRedirects=false",
    ...parts
  ];
}

function parseNameStatus(value) {
  const fields = String(value || "").split("\0").filter(Boolean);
  const output = [];
  for (let index = 0; index < fields.length;) {
    let status = fields[index++];
    let filePath = "";
    const combined = status.match(/^([AMD])\t(.+)$/);
    if (combined) {
      status = combined[1];
      filePath = combined[2];
    } else {
      filePath = fields[index++] || "";
    }
    if (!new Set(["A", "M", "D"]).has(status) || !filePath || filePath.includes("\0")) {
      throw new Error("change_set_status_invalid");
    }
    output.push({ status, path: filePath });
  }
  return output;
}

async function treeEntry(root, filePath, env) {
  const result = await runTrusted(root, safeGit(["ls-tree", "-z", "HEAD", "--", filePath]), { timeoutMs: 10_000, env });
  if (!result.ok) throw new Error(`change_set_tree_read_failed:${filePath}`);
  const match = result.stdout.match(/^(\d{6}) blob ([a-f0-9]{40})\t/);
  if (!match || !ALLOWED_GIT_MODES.has(match[1])) return null;
  return { mode: match[1], sha: match[2] };
}

async function safeRevision(root, ref, env = isolatedGitEnvironment()) {
  const result = await runTrusted(root, safeGit(["rev-parse", ref]), { timeoutMs: 10_000, env });
  if (!result.ok || !/^[a-f0-9]{40}$/.test(result.stdout.trim())) throw new Error(`git_revision_failed:${result.stderr}`);
  return result.stdout.trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function isolatedGitEnvironment() {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0"
  };
}

export function normalizeRepository(value = {}) {
  let url = String(value.url || "").trim();
  if (url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") throw new Error("repository_host_not_allowed");
    if (!/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:\.git)?$/.test(parsed.pathname)) throw new Error("repository_path_invalid");
    enforceOwnerAllowlist(parsed.pathname.split("/")[1]);
    parsed.username = "";
    parsed.password = "";
    url = `${parsed.origin}${parsed.pathname}`;
  }
  const baseRef = String(value.baseRef || value.ref || "main").trim();
  if (!/^[a-zA-Z0-9._/-]{1,160}$/.test(baseRef) || baseRef.includes("..")) throw new Error("repository_ref_invalid");
  return {
    url,
    baseRef,
    token: String(value.token || "").trim(),
    publishMode: String(value.publishMode || "diff-only"),
    visibility: value.visibility === "private" ? "private" : "public"
  };
}

function enforceOwnerAllowlist(owner) {
  if (process.env.SMEJJ_WORKER_REQUIRE_REPO_ALLOWLIST !== "YES") return;
  const allowed = new Set(String(process.env.SMEJJ_WORKER_GITHUB_OWNER_ALLOWLIST || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
  if (!allowed.size || !allowed.has(String(owner || "").toLowerCase())) throw new Error("repository_owner_not_allowed");
}

function withoutToken(repository) {
  const { token, ...safe } = repository;
  void token;
  return safe;
}

function branchName(jobId) {
  const safe = String(jobId || "job").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
  return `smejj.com/agent/${safe}`;
}

async function revision(root, ref) {
  const result = await runTrusted(root, ["git", "rev-parse", ref], { timeoutMs: 10_000 });
  if (!result.ok) throw new Error(`git_revision_failed:${result.stderr}`);
  return result.stdout.trim();
}

async function walk(root, relative, output, maxFiles) {
  if (output.length >= maxFiles) return;
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (output.length >= maxFiles) return;
    if (entry.isSymbolicLink()) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (isBlockedRelativePath(child)) continue;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(root, child, output, maxFiles);
    } else if (entry.isFile()) {
      output.push(child);
    }
  }
}

async function requireOk(promise, label) {
  const result = await promise;
  if (!result.ok) throw new Error(`${label}:${result.stderr || result.stdout}`);
  return result;
}
