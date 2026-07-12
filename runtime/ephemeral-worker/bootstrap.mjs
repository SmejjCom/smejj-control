import crypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const MAX_FILE_BYTES = 1_000_000;
const MAX_MANIFEST_BYTES = 100_000;
const EXPECTED_NODE = "v20.15.1";
const EXPECTED_GIT = "git version 2.45.4";
const EXPECTED_PYTHON = "Python 3.12.13";
const EXPECTED_PYTEST = "8.3.5";
const EXPECTED_PLAYWRIGHT = "1.49.1";
const EXPECTED_BROWSER = "Chromium 131.0.6778.108 Alpine Linux";
const BROWSER_NOT_REQUIRED = "not-required";
export const EPHEMERAL_RUNTIME_VERSIONS = Object.freeze({
  node: EXPECTED_NODE,
  git: EXPECTED_GIT,
  python: EXPECTED_PYTHON,
  pytest: EXPECTED_PYTEST,
  playwright: EXPECTED_PLAYWRIGHT,
  browser: EXPECTED_BROWSER
});

export async function startEphemeralWorker({
  env = process.env,
  appRoot = "/app",
  fetchImpl = fetch,
  runCommand = runRuntimeCommand,
  importModule = (url) => import(url),
  nodeVersion = process.version,
  dropPrivileges = dropRuntimePrivileges
} = {}) {
  appRoot = validateEphemeralAppRoot(appRoot);
  const browserRequired = env.SMEJJ_WORKER_BROWSER_REQUIRED === "YES";
  const sourceBase = validateSourceBase(env.SMEJJ_EPHEMERAL_WORKER_SOURCE_BASE);
  const expectedManifestSha256 = requiredSha256(env.SMEJJ_EPHEMERAL_WORKER_MANIFEST_SHA256, "ephemeral_worker_manifest_sha256_required");
  assertRuntimeVersion(nodeVersion, EXPECTED_NODE, "node_runtime_version_mismatch");

  const manifestText = await fetchText(`${sourceBase}/manifest.json`, MAX_MANIFEST_BYTES, fetchImpl);
  if (sha256(manifestText) !== expectedManifestSha256) throw new Error("ephemeral_worker_manifest_sha256_mismatch");
  const manifest = parseManifest(manifestText);
  const downloaded = await Promise.all(manifest.files.map(async (file) => {
    const content = await fetchText(`${sourceBase}/${file.path}`, MAX_FILE_BYTES, fetchImpl);
    if (sha256(content) !== file.sha256) throw new Error(`ephemeral_worker_file_sha256_mismatch:${file.path}`);
    return [path.join(appRoot, file.path), content];
  }));

  await mkdir(appRoot, { recursive: true });
  for (const [target, content] of downloaded) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  await writeFile(path.join(appRoot, "package.json"), `${JSON.stringify({
    name: "smejj.com-ephemeral-worker-runtime",
    private: true,
    type: "module",
    dependencies: { playwright: EXPECTED_PLAYWRIGHT }
  }, null, 2)}\n`, "utf8");

  const commands = runtimeInstallCommands(appRoot, { browserRequired });
  for (const command of commands) await runCommand(command.file, command.args, { env });
  const gitVersion = String((await runCommand("git", ["--version"], { env })).stdout || "").trim();
  assertRuntimeVersion(gitVersion, EXPECTED_GIT, "git_runtime_version_mismatch");
  const pythonVersion = String((await runCommand("python3", ["--version"], { env })).stdout || "").trim();
  assertRuntimeVersion(pythonVersion, EXPECTED_PYTHON, "python_runtime_version_mismatch");
  const pytestVersion = String((await runCommand("python3", ["-m", "pytest", "--version"], { env })).stdout || "").trim();
  if (!pytestVersion.startsWith(`pytest ${EXPECTED_PYTEST}`)) throw new Error("pytest_runtime_version_mismatch");
  const playwrightPackage = JSON.parse(await readFile(path.join(appRoot, "node_modules/playwright/package.json"), "utf8"));
  if (playwrightPackage.version !== EXPECTED_PLAYWRIGHT) throw new Error("playwright_runtime_version_mismatch");
  let browserVersion = BROWSER_NOT_REQUIRED;
  if (browserRequired) {
    browserVersion = String((await runCommand("chromium-browser", ["--version"], { env })).stdout || "").trim();
    assertRuntimeVersion(browserVersion, EXPECTED_BROWSER, "browser_runtime_version_mismatch");
    process.env.SMEJJ_PLAYWRIGHT_CHROMIUM_EXECUTABLE = "/usr/bin/chromium-browser";
  } else {
    delete process.env.SMEJJ_PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  }
  process.env.SMEJJ_RUNTIME_NODE_VERSION = EXPECTED_NODE;
  process.env.SMEJJ_RUNTIME_GIT_VERSION = EXPECTED_GIT;
  process.env.SMEJJ_RUNTIME_PYTHON_VERSION = EXPECTED_PYTHON;
  process.env.SMEJJ_RUNTIME_PYTEST_VERSION = EXPECTED_PYTEST;
  process.env.SMEJJ_RUNTIME_PLAYWRIGHT_VERSION = EXPECTED_PLAYWRIGHT;
  process.env.SMEJJ_RUNTIME_BROWSER_VERSION = browserVersion;
  process.env.SMEJJ_RUNTIME_PROFILE = browserRequired ? "browser" : "coding";
  await dropPrivileges();

  const worker = await importModule(`file://${path.join(appRoot, "smejj-worker/worker.mjs")}`);
  if (typeof worker.startServer !== "function") throw new Error("ephemeral_worker_entry_contract_invalid");
  return worker.startServer({
    port: Number(env.SMEJJ_WORKER_PORT || env.PORT || 8080),
    host: env.SMEJJ_HOST || "::"
  });
}

export function runtimeInstallCommands(appRoot = "/app", { browserRequired = false } = {}) {
  const packages = [
    "git=2.45.4-r0",
    "python3=3.12.13-r0",
    "py3-pip=24.0-r2",
    ...(browserRequired ? ["chromium=131.0.6778.108-r0"] : [])
  ];
  return [
    {
      file: "apk",
      args: ["add", "--no-cache", ...packages]
    },
    {
      file: "npm",
      args: ["install", "--prefix", appRoot, "--ignore-scripts", "--no-audit", "--fund=false", `playwright@${EXPECTED_PLAYWRIGHT}`]
    },
    {
      file: "python3",
      args: [
        "-m", "pip", "install", "--break-system-packages", "--no-cache-dir", "--disable-pip-version-check",
        `pytest==${EXPECTED_PYTEST}`,
        "iniconfig==2.0.0",
        "packaging==24.2",
        "pluggy==1.5.0",
        "exceptiongroup==1.2.2",
        "tomli==2.2.1"
      ]
    }
  ];
}

export function validateSourceBase(value) {
  const source = String(value || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[a-f0-9]{40}\/runtime\/ephemeral-worker$/i.test(source)) {
    throw new Error("ephemeral_worker_source_must_be_commit_pinned");
  }
  return source;
}

export function dropRuntimePrivileges({ uid = 1000, gid = 1000 } = {}) {
  if (typeof process.getuid !== "function") throw new Error("runtime_uid_verification_unavailable");
  const current = process.getuid();
  if (current === 0) {
    process.setgroups?.([]);
    process.setgid(gid);
    process.setuid(uid);
  }
  if (process.getuid() !== uid || (typeof process.getgid === "function" && process.getgid() !== gid)) {
    throw new Error("runtime_privilege_drop_failed");
  }
  process.env.HOME = "/home/node";
  process.env.USER = "node";
  process.env.LOGNAME = "node";
  return { uid, gid, privileged: false };
}

function parseManifest(value) {
  let manifest;
  try {
    manifest = JSON.parse(value);
  } catch {
    throw new Error("ephemeral_worker_manifest_invalid");
  }
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 40) {
    throw new Error("ephemeral_worker_manifest_invalid");
  }
  const seen = new Set();
  const files = manifest.files.map((entry) => {
    const filePath = String(entry?.path || "");
    const digest = String(entry?.sha256 || "").toLowerCase();
    if (!/^smejj-worker\/[a-z0-9][a-z0-9.-]*\.(?:mjs|js)$/i.test(filePath) || filePath.includes("..") || seen.has(filePath)) {
      throw new Error("ephemeral_worker_manifest_path_invalid");
    }
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("ephemeral_worker_manifest_digest_invalid");
    seen.add(filePath);
    return { path: filePath, sha256: digest };
  });
  if (!seen.has("smejj-worker/worker.mjs")) throw new Error("ephemeral_worker_entry_missing");
  return { schemaVersion: 1, files };
}

async function fetchText(url, limit, fetchImpl) {
  const response = await fetchImpl(url, { redirect: "error", cache: "no-store" });
  if (!response.ok) throw new Error(`ephemeral_worker_fetch_failed:${response.status}`);
  const content = await response.text();
  if (!content || Buffer.byteLength(content, "utf8") > limit) throw new Error("ephemeral_worker_source_size_invalid");
  return content;
}

async function runRuntimeCommand(file, args, { env = process.env } = {}) {
  const result = await execFile(file, args, {
    env: {
      PATH: env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/tmp/smejj.com-bootstrap-home",
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      npm_config_audit: "false",
      npm_config_fund: "false"
    },
    maxBuffer: 2 * 1024 * 1024,
    timeout: 10 * 60_000
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function assertRuntimeVersion(actual, expected, reason) {
  if (String(actual || "").trim() !== expected) throw new Error(reason);
}

function requiredSha256(value, reason) {
  const digest = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(reason);
  return digest;
}

export function validateEphemeralAppRoot(value) {
  const root = path.resolve(String(value || ""));
  if (!path.isAbsolute(root)
    || root === path.parse(root).root
    || (root !== "/app" && root.length < 5)) {
    throw new Error("ephemeral_worker_app_root_invalid");
  }
  return root;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

const directPath = process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
if (directPath) await startEphemeralWorker();
