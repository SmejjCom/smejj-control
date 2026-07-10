import { isSensitiveRelativePath } from "./path-policy.mjs";

const PACKAGE_BINS = new Set(["npm", "pnpm", "yarn"]);
const SAFE_TOKEN = /^[a-zA-Z0-9._@/+,:=-]{1,240}$/;

export function parseCommand(command) {
  if (Array.isArray(command)) return command.map((part) => String(part)).filter(Boolean).slice(0, 48);
  const value = String(command || "").trim();
  if (!value) return [];
  if (/[;&|<>`$\\'\"]/.test(value)) return [];
  return value.split(/\s+/).filter(Boolean).slice(0, 48);
}

export function validateCommand(command, { allowedScripts = [] } = {}) {
  const parts = parseCommand(command);
  const [bin, ...args] = parts;
  if (!bin) return deny("empty_or_unsafe_command");
  if (parts.some((part) => !SAFE_TOKEN.test(part))) return deny("unsafe_argument");
  if (parts.some(hasPathEscape)) return deny("path_escape_argument");

  if (PACKAGE_BINS.has(bin)) return validatePackageCommand(bin, args, allowedScripts, parts);
  if (bin === "corepack") return validateCorepack(args, allowedScripts, parts);
  if (bin === "node" && args[0] === "--check" && args.length === 2 && safeCodePath(args[1])) return allow(parts);
  if (bin === "python3" && args.length === 2 && args[0] === "-m" && args[1] === "pytest") return allow(parts);
  if (bin === "git") return validateGit(args, parts);
  if (bin === "rg" && validSearchArguments(args)) return allow(parts);
  return deny("command_not_allowed");
}

function validateGit(args, parts) {
  if (args.length === 1 && args[0] === "status") return allow(parts);
  if (args.length === 2 && args[0] === "status" && new Set(["--short", "--porcelain"]).has(args[1])) return allow(parts);
  if (args[0] === "diff" && (args.length === 1 || (args.length === 2 && new Set(["--check", "--stat", "--name-only"]).has(args[1])))) return allow(parts);
  if (args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD") return allow(parts);
  return deny("git_signature_not_allowed");
}

function safeCodePath(value) {
  return /\.(?:cjs|js|mjs)$/i.test(String(value || "")) && !isSensitiveRelativePath(value);
}

function validSearchArguments(args) {
  if (!args.length || args.some((arg) => arg === "--pre" || arg.startsWith("--pre="))) return false;
  const flags = new Set(["--files", "-n", "--line-number", "-l", "--files-with-matches", "-i", "--ignore-case", "-F", "--fixed-strings", "--hidden"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("-")) continue;
    if (!flags.has(arg)) return false;
  }
  return true;
}

function validatePackageCommand(bin, args, allowedScripts, parts) {
  if (bin === "npm" && args[0] === "ci" && installFlagsOnly(args.slice(1))) return allow(parts);
  if (bin === "pnpm" && args[0] === "install" && installFlagsOnly(args.slice(1))) return allow(parts);
  if (bin === "yarn" && args[0] === "install" && installFlagsOnly(args.slice(1))) return allow(parts);
  if (args[0] === "test" && args.length === 1) return allow(parts);
  if (args[0] !== "run" || args.length !== 2) return deny("command_signature_not_allowed");
  const scripts = new Set(allowedScripts.map((item) => String(item)));
  return scripts.has(args[1]) ? allow(parts) : deny("package_script_not_allowed");
}

function validateCorepack(args, allowedScripts, parts) {
  const [manager, ...rest] = args;
  if (!new Set(["pnpm", "yarn"]).has(manager)) return deny("corepack_manager_not_allowed");
  return validatePackageCommand(manager, rest, allowedScripts, parts);
}

function installFlagsOnly(args) {
  const allowed = new Set(["--frozen-lockfile", "--ignore-scripts", "--no-audit", "--no-fund", "--fund=false"]);
  return args.every((arg) => allowed.has(arg));
}

function hasPathEscape(value) {
  return String(value).split("=").some((part) => part === ".." || part.startsWith("../") || part.includes("/../") || part.startsWith("/"));
}

function allow(parts) {
  return { ok: true, parts, name: parts.join(" ") };
}

function deny(reason) {
  return { ok: false, reason };
}
