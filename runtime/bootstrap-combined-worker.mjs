import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const WORKER_FILES = [
  "allowlist.mjs",
  "path-policy.mjs",
  "safe-search.mjs",
  "sandbox.mjs",
  "repository.mjs",
  "verification.mjs",
  "model-client.mjs",
  "browser-verification.mjs",
  "publish.mjs",
  "agentloop.mjs"
];

export async function startCombinedWorker({
  sourceBase = process.env.SMEJJ_COMBINED_WORKER_SOURCE_BASE,
  appRoot = "/app",
  fetchImpl = fetch,
  importModule = (url) => import(url)
} = {}) {
  const base = validateSourceBase(sourceBase, "combined-worker");
  const requests = [
    ["remote-browser/worker.js", path.join(appRoot, "remote-browser/worker.js")],
    ...WORKER_FILES.map((name) => [`smejj-worker/${name}`, path.join(appRoot, "smejj-worker", name)])
  ];
  const downloaded = await Promise.all(requests.map(async ([source, target]) => {
    const response = await fetchImpl(`${base}/${source}`, { redirect: "error" });
    if (!response.ok) throw new Error(`combined_worker_fetch_failed:${source}:${response.status}`);
    const content = await response.text();
    if (content.length > 1_000_000) throw new Error(`combined_worker_file_too_large:${source}`);
    return [target, content];
  }));
  const backups = [];
  try {
    for (const [target, content] of downloaded) {
      let before = null;
      try { before = await readFile(target); } catch {}
      backups.push([target, before]);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    const runtime = await importModule(`file://${path.join(appRoot, "remote-browser/worker.js")}`);
    return runtime.startServer();
  } catch (error) {
    for (const [target, before] of backups.reverse()) {
      if (before === null) await rm(target, { force: true }).catch(() => {});
      else await writeFile(target, before).catch(() => {});
    }
    throw error;
  }
}

function validateSourceBase(value, folder) {
  const source = String(value || "").trim().replace(/\/+$/, "");
  const pattern = new RegExp(`^https://raw\\.githubusercontent\\.com/[^/]+/[^/]+/[a-f0-9]{40}/runtime/${folder}$`, "i");
  if (!pattern.test(source)) throw new Error("combined_worker_source_must_be_commit_pinned");
  return source;
}

if (process.argv[1]?.endsWith("bootstrap-combined-worker.mjs")) await startCombinedWorker();
