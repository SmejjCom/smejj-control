const ALLOWED_SCRIPTS = new Set(["check", "check:guidelines", "check:architecture", "check:frontend", "check:start-lock", "release:preflight"]);
const SAFE_TOKEN = /^[a-zA-Z0-9._@/+,:=-]{1,200}$/;

export function resolveTerminalCommand(value) {
  const raw = String(value || "").trim();
  if (!raw || /[;&|<>`$\\'\"]/.test(raw)) return denied("unsafe_command_syntax");
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.some((part) => !SAFE_TOKEN.test(part) || hasPathEscape(part))) return denied("unsafe_command_argument");
  const [bin, ...args] = parts;

  if (new Set(["npm", "pnpm", "yarn"]).has(bin) && args[0] === "run" && args.length === 2 && ALLOWED_SCRIPTS.has(args[1])) {
    return { ok: true, bin: "npm", args, display: `${bin} ${args.join(" ")}` };
  }
  if (bin === "npm" && args.length === 1 && args[0] === "test") return { ok: true, bin, args, display: raw };
  if (bin === "node" && args[0] === "--check" && args.length === 2 && /\.(?:c|m)?js$/.test(args[1])) {
    return { ok: true, bin: process.execPath, args, display: raw };
  }
  if (bin === "git" && args[0] === "status" && args.every((arg) => new Set(["status", "--short", "--branch"]).has(arg))) {
    return { ok: true, bin, args, display: raw };
  }
  if (bin === "git" && args[0] === "diff" && args.every((arg) => new Set(["diff", "--check", "--stat"]).has(arg))) {
    return { ok: true, bin, args, display: raw };
  }
  return denied("command_signature_not_allowed");
}

function hasPathEscape(value) {
  return value === ".." || value.startsWith("../") || value.includes("/../") || value.startsWith("/");
}

function denied(reason) {
  return { ok: false, reason };
}
