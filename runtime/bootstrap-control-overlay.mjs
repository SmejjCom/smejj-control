import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const FILES = [
  "package.json",
  "scripts/deploy/check-control-runtime.mjs",
  "public/autonomous-coding.js",
  "public/autonomous-coding.css",
  "public/premium-surfaces.js",
  "public/search.js",
  "public/auth/passkey-ui.js",
  "src/server.js",
  "src/shared/env.js",
  "src/shared/platform.js",
  "src/shared/modelRegistry.js",
  "src/shared/controlAccessPolicy.js",
  "src/shared/modelRatePolicy.js",
  "src/shared/terminalPolicy.js",
  "src/jobs/idriveLiteJob.js",
  "src/jobs/jobApi.js",
  "src/jobs/codingFlowPlan.js",
  "src/jobs/taskCapsuleWriter.js",
  "control-server/src/auth/workerToken.js",
  "control-server/src/auth/sessionToken.js",
  "control-server/src/auth/sessionHandoff.js",
  "control-server/src/budget/runtimeWatchdog.js",
  "control-server/src/budget/watchdogLeaseStore.js",
  "control-server/src/http/respond.js",
  "control-server/src/jobs/jobStore.js",
  "control-server/src/jobs/memoryEligibility.js",
  "control-server/src/jobs/jobArtifacts.js",
  "control-server/src/jobs/jobHydration.js",
  "control-server/src/llm/aiAvailability.js",
  "control-server/src/llm/modelRouter.js",
  "control-server/src/orchestrator/autonomousRunner.js",
  "control-server/src/orchestrator/jobScheduler.js",
  "control-server/src/routes/jobRoutes.js",
  "control-server/src/routes/passkeyRoutes.js",
  "control-server/src/routes/saladRoutes.js",
  "control-server/src/routes/workerModelRoutes.js",
  "control-server/src/storage/s3Signer.js"
];

export async function applyControlOverlay({
  sourceBase = process.env.SMEJJ_CONTROL_OVERLAY_BASE,
  appRoot = "/app",
  fetchImpl = fetch,
  importModule = (url) => import(url)
} = {}) {
  const base = validateSourceBase(sourceBase, "control-overlay");
  const downloaded = await Promise.all(FILES.map(async (file) => {
    const response = await fetchImpl(`${base}/${file}`, { redirect: "error" });
    if (!response.ok) throw new Error(`overlay_fetch_failed:${file}:${response.status}`);
    const content = await response.text();
    if (content.length > 1_000_000) throw new Error(`overlay_file_too_large:${file}`);
    return [file, content];
  }));
  const backups = [];
  try {
    for (const [file, content] of downloaded) {
      const target = path.join(appRoot, file);
      let before = null;
      try { before = await readFile(target); } catch {}
      backups.push([target, before]);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    return await importModule(`file://${path.join(appRoot, "src/server.js")}`);
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
  if (!pattern.test(source)) throw new Error("control_overlay_source_must_be_commit_pinned");
  return source;
}

if (process.argv[1]?.endsWith("bootstrap-control-overlay.mjs")) await applyControlOverlay();
