import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ROOTS = Object.freeze(["src", "control-server", "public", "worker-templates", "scripts/deploy"]);
const MAX_SOURCE_FILES = 5_000;

export async function checkControlRuntime(root = process.env.SMEJJ_CONTROL_RUNTIME_ROOT || process.cwd(), {
  execFile = execFileSync,
  logger = console.log
} = {}) {
  const files = [];
  for (const sourceRoot of SOURCE_ROOTS) {
    await collectSources(path.join(root, sourceRoot), files);
  }
  files.sort();
  if (files.length === 0 || files.length > MAX_SOURCE_FILES) throw new Error("control_runtime_source_count_invalid");
  for (const file of files) {
    execFile(process.execPath, ["--check", file], { stdio: "pipe", maxBuffer: 2 * 1024 * 1024 });
  }
  const result = { ok: true, app: "smejj.com", checkedFiles: files.length };
  logger(JSON.stringify(result));
  return result;
}

async function collectSources(directory, files) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectSources(target, files);
    else if (entry.isFile() && /\.(?:m?js)$/.test(entry.name)) files.push(target);
    if (files.length > MAX_SOURCE_FILES) throw new Error("control_runtime_source_count_invalid");
  }
}

const directPath = import.meta.url.startsWith("file:") && process.argv[1] ? path.resolve(process.argv[1]) : "";
if (directPath && fileURLToPath(import.meta.url) === directPath) await checkControlRuntime();
