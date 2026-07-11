import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function normalizeSecret(value) {
  const secret = String(value || "").trim();
  if (!secret || secret === "replace_with_long_random_secret") return "";
  return secret;
}

export function loadDotEnv(file) {
  try {
    const text = readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // .env is optional.
  }
}

/** Resolves secrets outside cloud-synchronized project directories. */
export function secureLocalEnvPath(env = process.env, { homeDirectory = homedir() } = {}) {
  const configured = String(env?.SMEJJ_LOCAL_ENV_FILE || "").trim();
  const candidate = configured || path.join(homeDirectory, ".config", "smejj.com", "env.local");
  if (!path.isAbsolute(candidate)) throw new Error("secure_local_env_path_must_be_absolute");
  return path.normalize(candidate);
}

/** Loads the secure local secret file when present; absence remains fail-closed. */
export function loadSecureLocalEnv(env = process.env, options) {
  loadDotEnv(secureLocalEnvPath(env, options));
}
