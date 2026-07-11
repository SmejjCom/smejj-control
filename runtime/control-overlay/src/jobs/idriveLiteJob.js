import { DEFAULT_MODEL_ID, getModelDefinition } from "../shared/modelRegistry.js";

const JOB_STATUSES = new Set([
  "open",
  "queued",
  "planning",
  "fast_path",
  "starting_worker",
  "running",
  "verifying",
  "passed",
  "done",
  "failed",
  "cancelled",
  "blocked"
]);

export function createIdriveLiteCodingJob({
  jobId,
  projectId,
  userId = "",
  task = "",
  modelId = DEFAULT_MODEL_ID,
  createdAt = new Date().toISOString(),
  contextPaths = {},
  limits = {},
  repository = null,
  parentJobId = "",
  preview = null,
  executionMode = "edit",
  replay = null
} = {}) {
  const safeJobId = normalizeId(jobId, "jobId");
  const safeProjectId = normalizeId(projectId, "projectId");
  const safeUserId = userId ? normalizeId(userId, "userId") : "";
  const taskText = String(task || "").slice(0, 20_000);
  const modelDefinition = getModelDefinition(modelId) || getModelDefinition(DEFAULT_MODEL_ID);
  const capsule = buildTaskCapsule(safeJobId, safeProjectId, modelDefinition.id, createdAt);

  return {
    version: 1,
    id: safeJobId,
    status: "queued",
    phase: "created",
    progress: 0,
    message: "Job created",
    createdAt,
    userId: safeUserId,
    projectId: safeProjectId,
    task: taskText,
    repository,
    executionMode: executionMode === "analyze" ? "analyze" : "edit",
    context: {
      parentJobId: parentJobId ? normalizeId(parentJobId, "parentJobId") : "",
      followUp: Boolean(parentJobId)
    },
    preview,
    approval: {
      required: true,
      status: "pending",
      mergeAllowed: false
    },
    model: {
      id: modelDefinition.id,
      name: modelDefinition.name,
      provider: modelDefinition.provider,
      storageProvider: "idrive-e2",
      modelPath: modelDefinition.storage.prefix,
      contextTokens: modelDefinition.contextTokens,
      codingCapability: modelDefinition.codingCapability,
      requiresChecksumBeforeRun: true,
      runtime: modelDefinition.runtime.storageFirstMode,
      engineCandidates: [...modelDefinition.runtime.workerEngines],
      fallback: "disabled"
    },
    taskCapsule: capsule,
    storage: buildJobStorage(safeJobId, safeProjectId, contextPaths, capsule),
    serverLimits: {
      ramGb: Number(limits.ramGb || modelDefinition.runtime.recommendedRamGb),
      localCacheGb: Number(limits.localCacheGb || modelDefinition.runtime.requiredLocalCacheGb),
      keepLargeFilesLocal: false,
      deleteLocalCacheAfterJob: true,
      preferRagBeforeModel: true
    },
    costPolicy: {
      githubPaidAllowed: false,
      paidHostingAllowed: false,
      trialServicesAllowed: false,
      autoBillingFallbackAllowed: false
    },
    replay: {
      replayable: true,
      input: capsule.input,
      repoSnapshotHash: contextPaths.repoSnapshotHash || null,
      selectedContextHash: contextPaths.selectedContextHash || null,
      modelId: modelDefinition.id,
      deterministic: replay?.deterministic === true,
      sourceJobId: replay?.sourceJobId || "",
      sourceActionLogSha256: replay?.sourceActionLogSha256 || ""
    }
  };
}

export function transitionIdriveLiteJob(job, status, updatedAt = new Date().toISOString()) {
  if (!JOB_STATUSES.has(status)) throw new Error(`Unsupported job status: ${status}`);
  const capsule = job.taskCapsule || buildTaskCapsule(job.id, job.projectId, job.model?.id, job.createdAt);
  const nextEvent = buildTaskEvent(capsule, status, updatedAt);

  return {
    ...job,
    status,
    phase: status,
    progress: statusProgress(status),
    message: statusMessage(status),
    updatedAt,
    taskCapsule: {
      ...capsule,
      status: `${capsule.rootPrefix}status.json`,
      events: [...(capsule.events || []), nextEvent]
    },
    storage: {
      ...job.storage,
      statusManifest: `${capsule.rootPrefix}status.json`,
      eventsPrefix: capsule.eventsPrefix
    }
  };
}

function buildJobStorage(jobId, projectId, contextPaths, capsule) {
  return {
    provider: "idrive-e2",
    statusManifest: capsule.status,
    inputPrefix: `${capsule.rootPrefix}input/`,
    contextPrefix: `${capsule.rootPrefix}context/`,
    logPrefix: `${capsule.rootPrefix}logs/`,
    resultPrefix: `${capsule.rootPrefix}results/`,
    projectManifest: contextPaths.projectManifest || `projects/${projectId}/current-manifest.json`,
    searchIndex: contextPaths.searchIndex || `indexes/${projectId}/search-index.json`,
    chunks: contextPaths.chunks || `indexes/${projectId}/chunks.jsonl`,
    eventsPrefix: capsule.eventsPrefix,
    memory: {
      hot: "memory/hot-memory.json",
      codePatterns: "memory/code-patterns.json",
      knownFixes: `projects/${projectId}/solved-errors/`,
      failedAttempts: `projects/${projectId}/failed-attempts/`,
      qaHistory: "memory/qa-history.json"
    }
  };
}

function buildTaskCapsule(jobId, projectId, modelId, createdAt) {
  const rootPrefix = taskCapsulePrefix(jobId, createdAt);

  return {
    version: 1,
    projectId,
    jobId,
    rootPrefix,
    input: `${rootPrefix}input.json`,
    status: `${rootPrefix}status.json`,
    projectContext: `${rootPrefix}project_context.json`,
    budget: `${rootPrefix}budget.json`,
    contextPlan: `${rootPrefix}context-plan.json`,
    repoPackManifest: `${rootPrefix}repo-pack-manifest.json`,
    promptBlocks: `${rootPrefix}prompt-blocks.json`,
    selectedContext: `${rootPrefix}selected-context.json`,
    relevantFiles: `${rootPrefix}relevant_files.json`,
    plan: `${rootPrefix}plan.md`,
    patch: `${rootPrefix}patch.diff`,
    terminalLog: `${rootPrefix}terminal.log.zst`,
    testResults: `${rootPrefix}test-results.json`,
    browserResults: `${rootPrefix}browser-results.json`,
    browserScreenshots: `${rootPrefix}browser-screenshots/`,
    browserVideo: `${rootPrefix}browser-video/`,
    errors: `${rootPrefix}errors.json`,
    selfFixAttempts: `${rootPrefix}self-fix-attempts.json`,
    actionLog: `${rootPrefix}action-log.json`,
    verifierReport: `${rootPrefix}verifier-report.md`,
    verificationGates: `${rootPrefix}verification-gates.json`,
    benchmarkResults: `${rootPrefix}benchmark-results.json`,
    finalReport: `${rootPrefix}final-report.md`,
    memoryUpdate: `${rootPrefix}memory-update.json`,
    trainingEligibility: `${rootPrefix}training-eligibility.json`,
    rollbackManifest: `${rootPrefix}rollback-manifest.json`,
    eventsPrefix: `${rootPrefix}events/`,
    events: [
      {
        seq: 1,
        type: "created",
        key: `${rootPrefix}events/000001-created.json`,
        createdAt,
        modelId
      }
    ]
  };
}

function taskCapsulePrefix(jobId, createdAt) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) throw new Error("createdAt must be a valid date");
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `jobs/${year}/${month}/${day}/${shardId(jobId)}/${jobId}/`;
}

function buildTaskEvent(capsule, status, createdAt) {
  const seq = (capsule.events?.length || 0) + 1;
  return {
    seq,
    type: status,
    key: `${capsule.eventsPrefix}${String(seq).padStart(6, "0")}-${status}.json`,
    createdAt
  };
}

function statusProgress(status) {
  return {
    open: 0,
    queued: 0.05,
    planning: 0.15,
    fast_path: 0.35,
    starting_worker: 0.45,
    running: 0.6,
    verifying: 0.8,
    passed: 1,
    done: 1,
    failed: 1,
    cancelled: 1,
    blocked: 1
  }[status];
}

function statusMessage(status) {
  return {
    open: "Job open",
    queued: "Job queued",
    planning: "Context planning",
    fast_path: "Fast path running",
    starting_worker: "Worker starting",
    running: "Job running",
    verifying: "Verification running",
    passed: "Job passed",
    done: "Job done",
    failed: "Job failed",
    cancelled: "Job cancelled",
    blocked: "Job blocked"
  }[status];
}

function shardId(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 2);
}

function normalizeId(value, label) {
  const id = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,120}$/.test(id)) {
    throw new Error(`${label} must be a relative safe id`);
  }
  return id;
}
