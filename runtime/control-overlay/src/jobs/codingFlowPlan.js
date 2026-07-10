const DEFAULT_VERIFICATION_COMMANDS = Object.freeze([
  "build",
  "typecheck",
  "tests"
]);

export function buildCodingFlowPlan({
  job,
  body = {},
  env = {},
  preflight = {},
  now = new Date().toISOString()
} = {}) {
  if (!job?.taskCapsule?.rootPrefix) throw new Error("Task capsule is required");

  const task = String(job.task || body.task || "");
  const uiChange = body.uiChange === true || /\b(ui|frontend|css|layout|button|screen|page|pwa|browser)\b/i.test(task);
  const budget = buildBudgetGate({ body, preflight, env, now });
  const verification = buildVerificationGate({ job, uiChange });
  const worker = buildWorkerGate({ job, body, budget, preflight });

  return {
    ok: true,
    mode: `${String(job.model?.runtime || "glm-5.2-storage-first").replace(/-storage-first$/, "")}-ai-coding-os-flow`,
    createdAt: now,
    taskCapsule: {
      required: true,
      ready: true,
      provider: "idrive-e2",
      rootPrefix: job.taskCapsule.rootPrefix,
      replayable: job.replay?.replayable === true
    },
    repoPack: buildRepoPackGate(job),
    contextPlanner: buildContextPlannerGate(job),
    budget,
    rollback: {
      requiredBeforePatch: true,
      prepared: true,
      manifestKey: job.taskCapsule.rollbackManifest,
      patchAllowedWithoutRollback: false
    },
    verification,
    memory: {
      learnDirectlyFromModelOutput: false,
      learnOnlyWhen: "verification_passed",
      updateKey: job.taskCapsule.memoryUpdate,
      status: "blocked_until_verified_success"
    },
    worker
  };
}

function buildRepoPackGate(job) {
  return {
    required: true,
    strategy: "targeted-repo-pack",
    fullRepoCloneAllowed: true,
    fullRepoModelContextAllowed: false,
    blindFullRepoLoadAllowed: false,
    manifestKey: job.taskCapsule.repoPackManifest,
    sourceProjectManifest: job.storage?.projectManifest,
    selectedContextKey: job.taskCapsule.selectedContext
  };
}

function buildContextPlannerGate(job) {
  return {
    required: true,
    strategy: "targeted-repo-pack",
    contextPlanKey: job.taskCapsule.contextPlan,
    selectedContextKey: job.taskCapsule.selectedContext,
    maxContextTokens: Number(job.model?.contextTokens || 1_000_000),
    reserveOutputTokens: 16_000,
    fullRepoCloneAllowed: true,
    fullRepoModelContextAllowed: false,
    fullRepoLoadAllowed: false
  };
}

function buildBudgetGate({ body, preflight, env, now }) {
  const explicitApproval = body.budgetApproved === true || body.budgetApproval === true;
  const maxUsd = Number(body.maxUsd ?? body.budgetUsd ?? 0);
  const workerRequested = body.workerMode === "full-model" || body.workerMode === "gpu-coding";
  const idriveConfigured = Boolean(env.IDRIVE_E2_ENDPOINT && env.IDRIVE_E2_ACCESS_KEY && env.IDRIVE_E2_SECRET_KEY && env.IDRIVE_E2_BUCKET);
  const reasons = [];

  if (!idriveConfigured) reasons.push("idrive_required_before_durable_job");
  if (workerRequested && !explicitApproval) reasons.push("explicit_budget_approval_required_for_gpu_worker");
  if (workerRequested && maxUsd <= 0) reasons.push("positive_budget_required_for_gpu_worker");
  if (workerRequested && preflight?.ok !== true) reasons.push("worker_preflight_must_pass_before_gpu_worker");

  return {
    required: true,
    checkedAt: now,
    approved: reasons.length === 0 && (!workerRequested || explicitApproval),
    maxUsd,
    workerRequested,
    freeOnlyPlatforms: true,
    paidPlatformServicesAllowed: false,
    reasons
  };
}

function buildVerificationGate({ job, uiChange }) {
  const commands = [...DEFAULT_VERIFICATION_COMMANDS];
  const required = [
    "rollback-prepared",
    "build-passed",
    "typecheck-passed",
    "tests-passed"
  ];

  if (uiChange) {
    commands.push("browser-screenshot");
    required.push("browser-screenshot-passed");
  }

  return {
    required,
    commands,
    uiChange,
    testResultsKey: job.taskCapsule.testResults,
    browserResultsKey: job.taskCapsule.browserResults,
    screenshotsPrefix: job.taskCapsule.browserScreenshots,
    verifierReportKey: job.taskCapsule.verifierReport,
    patchFinalWithoutVerification: false
  };
}

function buildWorkerGate({ job, body, budget, preflight }) {
  const mode = body.workerMode || "planner-vault";
  const gpuRequested = mode === "full-model" || mode === "gpu-coding";
  const explicitWorkerStart = body.startWorker === true || body.allowWorkerStart === true;
  const reasons = [];

  if (!gpuRequested) reasons.push("gpu_not_requested");
  if (!budget.approved) reasons.push("budget_not_approved");
  if (preflight?.ok !== true) reasons.push("worker_preflight_not_accept");
  if (!explicitWorkerStart) reasons.push("explicit_worker_start_required");

  return {
    provider: "salad",
    modelId: job.model?.id || "glm-5-2",
    mode,
    gpuRequested,
    inferenceStarted: false,
    startAllowed: reasons.length === 0,
    startRequiresExplicitOperatorAction: true,
    autoStartAllowed: false,
    stopAfterIdleMinutes: 5,
    reasons
  };
}
