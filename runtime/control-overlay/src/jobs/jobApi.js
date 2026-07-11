import { MODEL_STATUSES } from "../shared/platform.js";
import { isIP } from "node:net";
import { DEFAULT_MODEL_ID, getModelDefinition, resolveModelSelection } from "../shared/modelRegistry.js";
import { buildCodingFlowPlan } from "./codingFlowPlan.js";
import { buildAutonomousCodingLoop } from "./autonomousLoop.js";
import { buildFreeCodingExecutionPlan } from "./freeCodingPlan.js";
import { buildIdriveJobQueuePlan } from "./idriveQueue.js";
import { buildTaskCapsuleWritePlan } from "./taskCapsuleWriter.js";
import { createIdriveLiteCodingJob } from "./idriveLiteJob.js";
import { evaluateWorkerPreflight } from "./workerPreflight.js";

export function createStorageFirstJobEnvelope({ body = {}, env = {}, now = new Date().toISOString() } = {}) {
  const selection = resolveModelSelection({ requestedModel: body.model || body.modelId, profile: "coding", env });
  const modelDefinition = getModelDefinition(selection.selectedModelId) || getModelDefinition(DEFAULT_MODEL_ID);
  const vaultStatus = MODEL_STATUSES[modelDefinition.storage.vaultStatusId];
  const repository = normalizeRepositoryDescriptor(body.repository || body.repo || {});
  const job = createIdriveLiteCodingJob({
    jobId: safeId(body.jobId || `job_${randomJobSuffix()}`, "jobId"),
    projectId: safeId(body.projectId || "project_smejj", "projectId"),
    userId: body.userId ? safeId(body.userId, "userId") : "",
    task: String(body.task || "").trim(),
    modelId: modelDefinition.id,
    createdAt: now,
    contextPaths: body.contextPaths || {},
    limits: body.limits || {},
    repository,
    parentJobId: body.parentJobId || "",
    preview: normalizePreview(body.preview || {}, body.uiChange === true),
    executionMode: normalizeExecutionMode(body.executionMode || body.mode),
    replay: normalizeReplay(body.replay || {})
  });

  const idriveConfigured = hasIdriveConfig(env);
  const preflight = evaluateWorkerPreflight({
    job,
    model: vaultStatus,
    liveStorage: idriveConfigured
      ? { ok: true, objectCount: vaultStatus.verification.idriveObjectCount }
      : { ok: false, objectCount: 0 },
    request: {
      mode: body.workerMode || "planner-vault",
      gpuRequired: body.workerMode === "full-model" || body.workerMode === "gpu-coding",
      minGpuVramGb: Number(body.minGpuVramGb || 24)
    },
    worker: {
      provider: "salad",
      gpuCount: Number(env.SALAD_WORKER_GPU_COUNT || 1),
      gpuVramGb: Number(env.SALAD_WORKER_GPU_VRAM_GB || 24),
      vcpu: Number(env.SALAD_WORKER_VCPU || 16),
      ramGb: Number(env.SALAD_WORKER_RAM_GB || 64),
      localCacheGb: Number(env.SALAD_WORKER_LOCAL_CACHE_GB || 300),
      quotaRemainingReplicas: Number(env.SALAD_QUOTA_REMAINING_REPLICAS || 10)
    },
    now
  });
  const codingFlow = buildCodingFlowPlan({ job, body, env, preflight, now });
  const autonomousLoop = buildAutonomousCodingLoop({
    job,
    uiChange: codingFlow.verification?.uiChange === true,
    now
  });
  const freeCodingPlan = buildFreeCodingExecutionPlan({ job, body, codingFlow, now });
  const taskCapsuleWritePlan = buildTaskCapsuleWritePlan(job, { now, freeCodingPlan });
  const queueWritePlan = buildIdriveJobQueuePlan(job, { status: "open", now });

  return {
    ok: true,
    mode: `${modelDefinition.runtime.storageFirstMode}-job`,
    modelSelection: selection,
    inferenceStarted: false,
    idriveConfigured,
    idriveWrite: {
      requested: body.persistToIdrive === true,
      mode: body.persistToIdrive === true ? "server-side-put-when-configured" : "write-plan-only"
    },
    job,
    codingFlow,
    autonomousLoop,
    freeCodingPlan,
    taskCapsuleWritePlan,
    queueWritePlan,
    preflight
  };
}

export function normalizeExecutionMode(value) {
  return String(value || "").toLowerCase() === "analyze" ? "analyze" : "edit";
}

export function normalizeReplay(value = {}) {
  const sourceJobId = String(value.sourceJobId || "").trim();
  if (sourceJobId && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,120}$/.test(sourceJobId)) {
    throw new Error("replay sourceJobId is invalid");
  }
  const sourceActionLogSha256 = String(value.sourceActionLogSha256 || "").trim().toLowerCase();
  if (sourceActionLogSha256 && !/^[a-f0-9]{64}$/.test(sourceActionLogSha256)) {
    throw new Error("replay sourceActionLogSha256 is invalid");
  }
  return {
    deterministic: value.deterministic === true,
    sourceJobId,
    sourceActionLogSha256
  };
}

export function normalizeRepositoryDescriptor(value = {}) {
  const url = String(value.url || "").trim();
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("repository URL must be valid");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") throw new Error("repository must use https://github.com");
  if (parsed.username || parsed.password) throw new Error("repository URL must not contain credentials");
  if (!/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:\.git)?$/.test(parsed.pathname)) throw new Error("repository path is invalid");
  const baseRef = String(value.baseRef || value.ref || "main").trim();
  if (!/^[a-zA-Z0-9._/-]{1,160}$/.test(baseRef) || baseRef.includes("..")) throw new Error("repository baseRef is invalid");
  return {
    url: `${parsed.origin}${parsed.pathname}`,
    baseRef,
    publishMode: value.publishMode === "draft-pr" ? "draft-pr" : "diff-only",
    visibility: value.visibility === "private" || value.private === true ? "private" : "public"
  };
}

export function normalizePreview(value, uiChange) {
  const url = String(value.url || "").trim();
  const staticPath = String(value.staticPath || "").trim();
  const normalizedUrl = url ? validatePreviewUrl(url) : "";
  if (staticPath && (!/^[^\\]{1,500}$/.test(staticPath) || staticPath.startsWith("/") || staticPath.split("/").includes(".."))) {
    throw new Error("preview staticPath must stay inside the repository");
  }
  return {
    required: uiChange || value.required === true,
    ...(normalizedUrl ? { url: normalizedUrl } : {}),
    ...(staticPath ? { staticPath } : {})
  };
}

export function validatePreviewUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error("preview URL must be valid");
  }
  if (parsed.username || parsed.password) throw new Error("preview URL must not contain credentials");
  const hostname = parsed.hostname.toLowerCase();
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  if (loopback && parsed.protocol === "http:") return parsed.toString();
  if (parsed.protocol !== "https:") throw new Error("preview URL must use HTTPS or local HTTP");
  if (isUnsafeHostname(hostname)) throw new Error("preview URL must not target a private network");
  return parsed.toString();
}

function isUnsafeHostname(hostname) {
  if (!hostname || hostname === "0.0.0.0" || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".localhost")) return true;
  if (isIP(hostname) === 6) return true;
  if (isIP(hostname) !== 4) return false;
  const [a, b] = hostname.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export function hasIdriveConfig(env = {}) {
  return Boolean(env.IDRIVE_E2_ENDPOINT && env.IDRIVE_E2_ACCESS_KEY && env.IDRIVE_E2_SECRET_KEY && env.IDRIVE_E2_BUCKET);
}

function safeId(value, label) {
  const id = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,120}$/.test(id)) throw new Error(`${label} must be a relative safe id`);
  return id;
}

function randomJobSuffix() {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid.replace(/-/g, "").slice(0, 16);
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
