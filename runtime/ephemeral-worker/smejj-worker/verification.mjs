import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { runAllowed } from "./sandbox.mjs";
import { repositoryDiff } from "./repository.mjs";

const SCRIPT_STAGES = [
  ["build", ["build"]],
  ["typecheck", ["typecheck", "check:types"]],
  ["lint", ["lint"]],
  ["unit", ["test:unit"]],
  ["integration", ["test:integration"]],
  ["security", ["check:security", "security"]]
];

export async function runVerification(root, options = {}) {
  const startedAt = Date.now();
  const packageInfo = await readPackageInfo(root);
  const allowedScripts = Object.keys(packageInfo.scripts);
  const checks = [];

  if (packageInfo.exists && packageInfo.hasLockfile && options.install !== false && Object.keys(packageInfo.dependencies).length > 0) {
    checks.push(await runCheck(root, "install", installCommand(packageInfo), allowedScripts, stageTimeout(options, 600_000), options.signal));
  } else {
    checks.push(skipped("install", packageInfo.exists ? "no_dependencies_or_disabled" : "no_package_json"));
  }

  for (const [stage, candidates] of SCRIPT_STAGES) {
    const script = candidates.find((name) => packageInfo.scripts[name]);
    checks.push(script
      ? await runCheck(root, stage, packageCommand(packageInfo, script), allowedScripts, stageTimeout(options, 600_000), options.signal)
      : skipped(stage, "script_not_present"));
  }

  if (packageInfo.scripts.test && !packageInfo.scripts["test:unit"] && !packageInfo.scripts["test:integration"]) {
    checks.push(await runCheck(root, "tests", packageCommand(packageInfo, "test"), allowedScripts, stageTimeout(options, 600_000), options.signal));
  } else if (!packageInfo.scripts.test) {
    checks.push(await pythonOrStaticTest(root, allowedScripts, options));
  }

  const diff = await repositoryDiff(root);
  checks.push(await runCheck(root, "repository-hygiene", ["git", "diff", "--check"], allowedScripts, stageTimeout(options, 30_000), options.signal));
  checks.push(securityScan(diff));
  const failed = checks.filter((check) => check.required !== false && check.ok !== true);
  return {
    ok: failed.length === 0,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    manager: packageInfo.manager,
    checks,
    errors: failed.map((check) => ({ source: check.stage, detail: summarizeFailure(check) }))
  };
}

async function readPackageInfo(root) {
  try {
    const raw = await readFile(path.join(root, "package.json"), "utf8");
    const value = JSON.parse(raw);
    const manager = await detectManager(root, value.packageManager);
    return {
      exists: true,
      scripts: value.scripts || {},
      dependencies: { ...(value.dependencies || {}), ...(value.devDependencies || {}) },
      manager,
      managerCommand: await managerCommandPrefix(manager),
      hasLockfile: await hasLockfile(root)
    };
  } catch {
    return { exists: false, scripts: {}, dependencies: {}, manager: "npm", managerCommand: ["npm"], hasLockfile: false };
  }
}

async function detectManager(root, declaredPackageManager = "") {
  if (await exists(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(root, "yarn.lock"))) return "yarn";
  if (await exists(path.join(root, "package-lock.json")) || await exists(path.join(root, "npm-shrinkwrap.json"))) return "npm";
  const declared = String(declaredPackageManager || "").trim().match(/^(npm|pnpm|yarn)(?:@|$)/)?.[1];
  if (declared) return declared;
  return "npm";
}

async function hasLockfile(root) {
  return await exists(path.join(root, "package-lock.json"))
    || await exists(path.join(root, "npm-shrinkwrap.json"))
    || await exists(path.join(root, "pnpm-lock.yaml"))
    || await exists(path.join(root, "yarn.lock"));
}

function installCommand(packageInfo) {
  const { manager, managerCommand } = packageInfo;
  if (manager === "pnpm" || manager === "yarn") return [...managerCommand, "install", "--frozen-lockfile", "--ignore-scripts"];
  return ["npm", "ci", "--ignore-scripts", "--no-audit", "--fund=false"];
}

function packageCommand(packageInfo, script) {
  return [...packageInfo.managerCommand, "run", script];
}

async function managerCommandPrefix(manager) {
  if (manager === "npm" || await executableOnPath(manager)) return [manager];
  if (await executableOnPath("corepack")) return ["corepack", manager];
  return [manager];
}

async function executableOnPath(command) {
  const directories = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    try {
      await access(path.join(directory, command), fsConstants.X_OK);
      return true;
    } catch {
      // Keep searching the worker PATH.
    }
  }
  return false;
}

async function runCheck(root, stage, command, allowedScripts, timeoutMs, signal = null) {
  const startedAt = Date.now();
  if (timeoutMs <= 0) {
    return { stage, required: true, ok: false, command: command.join(" "), code: null, durationMs: 0, stdout: "", stderr: "job_deadline_exceeded" };
  }
  const result = await runAllowed(root, command, { allowedScripts, timeoutMs, signal });
  return {
    stage,
    required: true,
    ok: result.ok,
    command: result.command,
    code: result.code,
    durationMs: Date.now() - startedAt,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

async function pythonOrStaticTest(root, allowedScripts, options) {
  if (await exists(path.join(root, "pyproject.toml")) || await exists(path.join(root, "pytest.ini"))) {
    return runCheck(root, "tests", ["python3", "-m", "pytest"], allowedScripts, stageTimeout(options, 600_000), options.signal);
  }
  return skipped("tests", "no_test_runner_present");
}

function stageTimeout(options, requested) {
  const deadline = Number(options?.deadlineMs || 0);
  if (!deadline) return requested;
  return Math.min(requested, Math.max(0, deadline - Date.now()));
}

function securityScan(diff) {
  const added = String(diff || "").split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const findings = [];
  const rules = [
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private_key_material"],
    [/\bAKIA[0-9A-Z]{16}\b/, "aws_access_key"],
    [/\b(?:ghp|github_pat)_[a-zA-Z0-9_]{20,}\b/, "github_token"],
    [/\bsk-[a-zA-Z0-9]{24,}\b/, "api_secret"]
  ];
  for (const line of added) {
    for (const [pattern, name] of rules) if (pattern.test(line)) findings.push(name);
  }
  return {
    stage: "security-scan",
    required: true,
    ok: findings.length === 0,
    command: "built-in added-line secret scan",
    code: findings.length === 0 ? 0 : 1,
    durationMs: 0,
    stdout: findings.length === 0 ? "No secret material detected in added lines." : "",
    stderr: findings.join(", "),
    findings
  };
}

function skipped(stage, reason) {
  return { stage, required: false, skipped: true, ok: true, command: "", code: 0, durationMs: 0, stdout: reason, stderr: "" };
}

function summarizeFailure(check) {
  return `${check.command || check.stage}: ${check.stderr || check.stdout || `exit_${check.code}`}`.slice(0, 4_000);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
