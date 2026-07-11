import path from "node:path";

const BLOCKED_ROOTS = new Set([".git", "node_modules", ".pnpm-store", "model-files"]);
const BLOCKED_DIRECTORIES = new Set([".aws", ".gnupg", ".ssh"]);
const BLOCKED_FILES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials.json",
  "id_dsa",
  "id_ed25519",
  "id_ecdsa",
  "id_rsa"
]);

export function safeRelativePath(value) {
  const input = String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(input);
  const segments = normalized.split("/").filter(Boolean);
  if (!normalized || normalized === "." || segments.some((part) => part === "..")) throw new Error("unsafe_path");
  if (isBlockedRelativePath(normalized)) throw new Error("blocked_path");
  if (!/^[a-zA-Z0-9._@/+ -]+$/.test(normalized)) throw new Error("unsafe_path_chars");
  if (normalized.length > 240) throw new Error("path_too_long");
  return normalized;
}

export function isBlockedRelativePath(value) {
  const normalized = path.posix.normalize(String(value || "").replace(/\\/g, "/"));
  const segments = normalized.split("/").filter(Boolean);
  return BLOCKED_ROOTS.has(String(segments[0] || "").toLowerCase()) || isSensitiveRelativePath(normalized);
}

export function isSensitiveRelativePath(value) {
  const normalized = path.posix.normalize(String(value || "").replace(/\\/g, "/"));
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((part) => BLOCKED_DIRECTORIES.has(part.toLowerCase()))) return true;
  const name = String(segments.at(-1) || "").toLowerCase();
  if (BLOCKED_FILES.has(name)) return true;
  if (name === ".env" || (name.startsWith(".env.") && !/\.(?:example|sample|template)$/.test(name))) return true;
  if (/^(?:service[-_.]?account|credentials)[^/]*\.json$/.test(name)) return true;
  return /\.(?:key|pem|p12|pfx)$/.test(name);
}
