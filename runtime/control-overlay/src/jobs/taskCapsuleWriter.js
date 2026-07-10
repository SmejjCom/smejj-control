const REQUIRED_TASK_FILES = [
  "input",
  "budget",
  "contextPlan",
  "repoPackManifest",
  "status",
  "selectedContext",
  "patch",
  "testResults",
  "browserResults",
  "errors",
  "selfFixAttempts",
  "verificationGates",
  "benchmarkResults",
  "verifierReport",
  "finalReport",
  "memoryUpdate",
  "rollbackManifest"
];

export function buildTaskCapsuleWritePlan(job, { now = new Date().toISOString(), freeCodingPlan = null } = {}) {
  if (!job?.taskCapsule?.rootPrefix) throw new Error("Task capsule is required");
  if (job.storage?.provider !== "idrive-e2") throw new Error("Task capsule must target IDrive e2");
  const capsule = job.taskCapsule;
  assertSafeJobPrefix(capsule.rootPrefix);
  const selectedFiles = Array.isArray(freeCodingPlan?.repoPack?.selectedFiles)
    ? freeCodingPlan.repoPack.selectedFiles
    : [];

  const objects = [
    jsonObject(capsule.input, {
      version: 1,
      jobId: job.id,
      projectId: job.projectId,
      userId: job.userId || "",
      task: job.task || "",
      repository: job.repository || null,
      context: job.context || { parentJobId: "", followUp: false },
      preview: job.preview || { required: false },
      model: job.model,
      replay: job.replay,
      createdAt: job.createdAt
    }),
    jsonObject(capsule.status, {
      jobId: job.id,
      status: job.status,
      phase: job.phase,
      progress: job.progress,
      message: job.message,
      updatedAt: now
    }),
    jsonObject(capsule.budget, {
      version: 1,
      jobId: job.id,
      approved: false,
      gpuBudgetApproved: false,
      paidPlatformServicesAllowed: false,
      saladWorkerAutoStartAllowed: false,
      createdAt: now
    }),
    jsonObject(capsule.contextPlan, {
      version: 1,
      jobId: job.id,
      strategy: "targeted-repo-pack",
      fullRepoCloneAllowed: true,
      fullRepoModelContextAllowed: false,
      blindFullRepoLoadAllowed: false,
      selectedContextKey: capsule.selectedContext,
      repoPackManifestKey: capsule.repoPackManifest,
      promptBlocksKey: capsule.promptBlocks,
      rules: freeCodingPlan?.contextPlanner?.rules || [],
      createdAt: now
    }),
    jsonObject(capsule.repoPackManifest, {
      version: 1,
      jobId: job.id,
      projectId: job.projectId,
      sourceProjectManifest: job.storage?.projectManifest,
      selectedFiles,
      fullRepoCloneAllowed: true,
      fullRepoModelContextAllowed: false,
      fullRepoLoadAllowed: false,
      blindFullRepoLoadAllowed: false,
      excludedPrefixes: freeCodingPlan?.repoPack?.excludedPrefixes || [],
      createdAt: now
    }),
    jsonObject(capsule.selectedContext, {
      version: 1,
      jobId: job.id,
      files: selectedFiles,
      memoryKeys: [],
      ragShardKeys: [],
      createdAt: now
    }),
    jsonObject(capsule.testResults, {
      version: 1,
      jobId: job.id,
      build: "pending",
      typecheck: "pending",
      tests: "pending",
      createdAt: now
    }),
    jsonObject(capsule.browserResults, {
      version: 1,
      jobId: job.id,
      requiredWhenUiChanged: true,
      status: "pending",
      screenshotsPrefix: capsule.browserScreenshots,
      createdAt: now
    }),
    jsonObject(capsule.errors, {
      version: 1,
      jobId: job.id,
      status: "pending",
      source: "worker-verification",
      errors: [],
      createdAt: now
    }),
    jsonObject(capsule.selfFixAttempts, {
      version: 1,
      jobId: job.id,
      status: "pending",
      maxAttempts: 3,
      attempts: [],
      stopWhen: "verification_passed_or_attempt_cap_reached",
      createdAt: now
    }),
    jsonObject(capsule.verificationGates, {
      version: 1,
      jobId: job.id,
      required: ["rollback-prepared", "build-passed", "typecheck-passed", "tests-passed"],
      patchFinalWithoutVerification: false,
      createdAt: now
    }),
    jsonObject(capsule.benchmarkResults, {
      version: 1,
      jobId: job.id,
      status: "pending",
      metrics: [],
      createdAt: now
    }),
    jsonObject(capsule.memoryUpdate, {
      version: 1,
      jobId: job.id,
      learn: false,
      learnOnlyWhen: "verification_passed",
      sourceCapsule: capsule.rootPrefix,
      createdAt: now
    }),
    jsonObject(capsule.rollbackManifest, {
      version: 1,
      jobId: job.id,
      projectId: job.projectId,
      repoSnapshotHash: job.replay?.repoSnapshotHash || null,
      affectedFiles: selectedFiles.map((file) => file.path),
      rollbackRequiredBeforePatch: true,
      createdAt: now
    })
  ];

  for (const event of capsule.events || []) {
    objects.push(jsonObject(event.key, event));
  }

  return {
    ok: true,
    provider: "idrive-e2",
    rootPrefix: capsule.rootPrefix,
    requiredFiles: REQUIRED_TASK_FILES,
    objects
  };
}

export async function writeTaskCapsuleToIdrive(job, { putObject, now = new Date().toISOString() } = {}) {
  if (typeof putObject !== "function") throw new Error("putObject function is required");
  const plan = buildTaskCapsuleWritePlan(job, { now });
  const written = [];
  for (const object of plan.objects) {
    await putObject(object);
    written.push(object.key);
  }
  return {
    ok: true,
    provider: plan.provider,
    rootPrefix: plan.rootPrefix,
    objectCount: written.length,
    written
  };
}

export async function writeJobEnvelopeToIdrive(envelope, { putObject } = {}) {
  if (typeof putObject !== "function") throw new Error("putObject function is required");
  if (!envelope?.taskCapsuleWritePlan?.objects) throw new Error("Task capsule write plan is required");
  if (!envelope?.queueWritePlan?.objects) throw new Error("Queue write plan is required");

  const objects = [
    ...envelope.taskCapsuleWritePlan.objects,
    ...envelope.queueWritePlan.objects
  ];
  const written = [];
  for (const object of objects) {
    await putObject(object);
    written.push(object.key);
  }

  return {
    ok: true,
    provider: "idrive-e2",
    taskCapsuleRoot: envelope.taskCapsuleWritePlan.rootPrefix,
    queueEntryKey: envelope.queueWritePlan.currentEntryKey,
    objectCount: written.length,
    written
  };
}

function jsonObject(key, value) {
  assertSafeJobKey(key);
  return {
    key,
    contentType: "application/json; charset=utf-8",
    body: `${JSON.stringify(value, null, 2)}\n`
  };
}

function assertSafeJobPrefix(prefix) {
  if (!/^jobs\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{2}\/[a-zA-Z0-9][a-zA-Z0-9._-]{1,120}\/$/.test(String(prefix || ""))) {
    throw new Error("Unsafe task capsule prefix");
  }
}

function assertSafeJobKey(key) {
  const value = String(key || "");
  if (!value.startsWith("jobs/") || value.includes("..") || value.startsWith("/") || /[\\]/.test(value)) {
    throw new Error("Unsafe task capsule key");
  }
}
