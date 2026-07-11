import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { validateCommand } from "./allowlist.mjs";
import { runSafeSearch } from "./safe-search.mjs";
import { safeRelativePath } from "./path-policy.mjs";

const MAX_OUTPUT = 200_000;
const MAX_FILE_BYTES = 500_000;
const DEFAULT_TIMEOUT_MS = 300_000;

export async function createWorkspace(files = [], { prefix = "smejj.com-worker-", initializeGit = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await prepareProcessDirs(root);
  for (const file of files.slice(0, 500)) {
    await writeWorkspaceFile(root, file.path, file.content);
  }
  if (initializeGit) await initializeRepository(root);
  return workspaceHandle(root);
}

export function workspaceHandle(root) {
  return {
    root,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
      await rm(runtimeRoot(root), { recursive: true, force: true });
    }
  };
}

export async function runAllowed(workspaceRoot, command, options = {}) {
  const validation = validateCommand(command, { allowedScripts: options.allowedScripts || [] });
  if (!validation.ok) {
    return { ok: false, command: commandLabel(command), code: null, stdout: "", stderr: validation.reason };
  }
  if (validation.parts[0] === "rg") {
    try { return await runSafeSearch(workspaceRoot, validation.parts.slice(1)); }
    catch (error) { return { ok: false, command: validation.name, code: 2, stdout: "", stderr: String(error?.message || error).slice(0, 500) }; }
  }
  return runProcess(workspaceRoot, validation.parts, { ...options, commandLabel: validation.name });
}

export async function runTrusted(workspaceRoot, parts, options = {}) {
  if (!Array.isArray(parts) || parts.length === 0) throw new Error("trusted_command_required");
  return runProcess(workspaceRoot, parts.map(String), options);
}

export async function readWorkspaceFile(workspaceRoot, relativePath, { startLine = 1, endLine = 400 } = {}) {
  const safePath = safeRelativePath(relativePath);
  await assertNoSymlink(workspaceRoot, safePath);
  const content = await readFile(path.join(workspaceRoot, safePath), "utf8");
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error("file_too_large");
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, Number(startLine) || 1);
  const end = Math.min(lines.length, Math.max(start, Number(endLine) || start + 399), start + 399);
  return { path: safePath, content: lines.slice(start - 1, end).join("\n"), startLine: start, endLine: end, totalLines: lines.length };
}

export async function writeWorkspaceFile(workspaceRoot, relativePath, content) {
  const safePath = safeRelativePath(relativePath);
  const value = String(content ?? "");
  if (Buffer.byteLength(value, "utf8") > MAX_FILE_BYTES) throw new Error("file_too_large");
  await assertNoSymlink(workspaceRoot, safePath);
  const target = path.join(workspaceRoot, safePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value, "utf8");
  return safePath;
}

export { safeRelativePath } from "./path-policy.mjs";

async function runProcess(workspaceRoot, parts, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  stdin = "",
  env = {},
  commandLabel = "",
  maxOutputChars = MAX_OUTPUT,
  signal = null
} = {}) {
  const [bin, ...args] = parts;
  const executable = bin === "node" ? process.execPath : bin;
  const label = commandLabel || parts.join(" ");
  const outputLimit = Math.min(1_000_001, Math.max(1_000, Number(maxOutputChars) || MAX_OUTPUT));
  await prepareProcessDirs(workspaceRoot);
  if (signal?.aborted) return stoppedResult(label, "job_cancelled");
  return new Promise((resolve) => {
    let settled = false;
    let stopReason = "";
    let forceTimer = null;
    const detached = process.platform !== "win32";
    const child = spawn(executable, args, {
      cwd: workspaceRoot,
      shell: false,
      detached,
      stdio: ["pipe", "pipe", "pipe"],
      env: sanitizedEnvironment(workspaceRoot, env)
    });
    let stdout = "";
    let stderr = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal?.removeEventListener?.("abort", abortHandler);
      resolve(result);
    };
    const stop = (reason) => {
      if (settled || stopReason) return;
      stopReason = reason;
      terminateProcessTree(child, "SIGTERM", detached);
      forceTimer = setTimeout(() => {
        terminateProcessTree(child, "SIGKILL", detached);
        finish(stoppedResult(label, reason, stdout, outputLimit));
      }, 1_000);
    };
    const abortHandler = () => stop("job_cancelled");
    const timer = setTimeout(() => stop("timeout"), Math.min(600_000, Math.max(100, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)));
    signal?.addEventListener?.("abort", abortHandler, { once: true });
    if (signal?.aborted) abortHandler();
    child.stdout.on("data", (chunk) => { stdout = cap(stdout + chunk.toString(), outputLimit); });
    child.stderr.on("data", (chunk) => { stderr = cap(stderr + chunk.toString(), outputLimit); });
    child.stdin.on("error", (error) => {
      if (error?.code === "EPIPE" || error?.code === "ERR_STREAM_DESTROYED") return;
      finish({ ok: false, command: label, code: 127, stdout: "", stderr: cap(error.message, outputLimit) });
    });
    child.on("error", (error) => finish({ ok: false, command: label, code: 127, stdout: "", stderr: cap(error.message, outputLimit) }));
    child.on("close", (code) => finish(stopReason
      ? stoppedResult(label, stopReason, stdout, outputLimit)
      : { ok: code === 0, command: label, code, stdout: cap(stdout, outputLimit), stderr: cap(stderr, outputLimit) }));
    child.stdin.end(String(stdin || ""));
  });
}

function stoppedResult(command, reason, stdout = "", limit = MAX_OUTPUT) {
  return { ok: false, command, code: null, stdout: cap(stdout, limit), stderr: reason };
}

function terminateProcessTree(child, signal, detached) {
  try {
    if (detached && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

async function initializeRepository(root) {
  const init = await runTrusted(root, ["git", "init", "--quiet"]);
  if (!init.ok) throw new Error(`git_init_failed:${init.stderr}`);
  await runTrusted(root, ["git", "config", "user.name", "smejj.com Worker"]);
  await runTrusted(root, ["git", "config", "user.email", "worker@smejj.com"]);
  await runTrusted(root, ["git", "add", "-A"]);
  const commit = await runTrusted(root, ["git", "commit", "--quiet", "--allow-empty", "-m", "smejj.com worker baseline"]);
  if (!commit.ok) throw new Error(`git_baseline_failed:${commit.stderr}`);
}

async function prepareProcessDirs(root) {
  await mkdir(path.join(runtimeRoot(root), "home"), { recursive: true });
  await mkdir(path.join(runtimeRoot(root), "cache"), { recursive: true });
}

function sanitizedEnvironment(root, additions = {}) {
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: path.join(runtimeRoot(root), "home"),
    TMPDIR: os.tmpdir(),
    LANG: "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    npm_config_cache: path.join(runtimeRoot(root), "cache"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    ...Object.fromEntries(Object.entries(additions).map(([key, value]) => [key, String(value)]))
  };
}

function runtimeRoot(root) {
  return `${root}.runtime`;
}

async function assertNoSymlink(root, relativePath) {
  const parts = relativePath.split("/");
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("symlink_path_blocked");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

function commandLabel(command) {
  return Array.isArray(command) ? command.join(" ") : String(command || "");
}

function cap(value, limit = MAX_OUTPUT) {
  const text = String(value || "");
  const tail = text.length > limit * 2 ? text.slice(-limit * 2) : text;
  const redacted = redactSensitiveOutput(tail);
  return redacted.length > limit ? redacted.slice(-limit) : redacted;
}

function redactSensitiveOutput(value) {
  return String(value || "")
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(?:gh[psuoro]|github_pat)_[a-zA-Z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-[a-zA-Z0-9_-]{20,}\b/g, "[REDACTED_API_TOKEN]")
    .replace(/\bBearer\s+[a-zA-Z0-9._~+\/-]{16,}\b/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}
