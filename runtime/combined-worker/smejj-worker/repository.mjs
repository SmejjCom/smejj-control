import { lstat, mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspace, runTrusted, workspaceHandle } from "./sandbox.mjs";
import { isBlockedRelativePath } from "./path-policy.mjs";

const SKIP_DIRS = new Set([".git", "node_modules", ".pnpm-store", "dist", "build", "coverage", "model-files"]);

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
  const clone = await runTrusted(workspace.root, cloneArgs, { timeoutMs: 300_000, env: gitAuthEnvironment(repository.token), signal });
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
  const intent = await runTrusted(root, ["git", "add", "--intent-to-add", "--all"], { timeoutMs: 30_000 });
  if (!intent.ok) throw new Error(`git_intent_to_add_failed:${intent.stderr}`);
  const names = await runTrusted(root, ["git", "diff", "--name-only", "-z", "HEAD"], { timeoutMs: 30_000, maxOutputChars: 200_000 });
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
  const result = await runTrusted(root, ["git", "diff", "--no-ext-diff", "--text", "HEAD"], { timeoutMs: 30_000, maxOutputChars: 1_000_001 });
  if (!result.ok) throw new Error(`git_diff_failed:${result.stderr}`);
  if (result.stdout.length > 1_000_000) throw new Error("git_diff_too_large");
  return result.stdout;
}

export async function repositoryStatus(root) {
  const result = await runTrusted(root, ["git", "status", "--short"], { timeoutMs: 10_000 });
  return result.ok ? result.stdout.slice(0, 100_000) : "";
}

export async function commitVerifiedChanges(root, message) {
  await requireOk(runTrusted(root, ["git", "add", "-A"]), "git_add_failed");
  const staged = await runTrusted(root, ["git", "diff", "--cached", "--quiet"]);
  if (staged.code === 0) return { changed: false, commit: await revision(root, "HEAD") };
  if (staged.code !== 1) throw new Error(`git_staged_diff_failed:${staged.stderr}`);
  const commit = await runTrusted(root, ["git", "commit", "--quiet", "-m", String(message || "Verified smejj.com agent change").slice(0, 160)]);
  if (!commit.ok) throw new Error(`git_commit_failed:${commit.stderr}`);
  return { changed: true, commit: await revision(root, "HEAD") };
}

export async function applyUnifiedDiff(root, diff) {
  const result = await runTrusted(root, ["git", "apply", "--whitespace=nowarn", "-"], { stdin: String(diff || ""), timeoutMs: 30_000 });
  if (!result.ok) throw new Error(`git_apply_failed:${result.stderr || result.stdout}`);
}

export function gitAuthEnvironment(token) {
  if (!token) return {};
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
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
    publishMode: String(value.publishMode || "diff-only")
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
