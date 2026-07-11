import crypto from "node:crypto";
import { signedS3Put } from "../storage/s3Signer.js";
import { evaluateMemoryEligibility } from "./memoryEligibility.js";

const MAX_OBJECT_BYTES = 1_000_000;

export async function persistWorkerOutcomeToIdrive({ job, outcome, env = process.env, putObject } = {}) {
  if (!hasIdrive(env)) return { ok: false, mode: "write-plan-only", reason: "idrive_e2_not_configured", objectCount: 0 };
  const writer = putObject || idriveWriter(env);
  const objects = buildWorkerOutcomeObjects(job, outcome);
  const written = [];
  try {
    for (const object of objects) {
      assertObject(object);
      await writer(object);
      written.push(object.key);
    }
    return { ok: true, mode: "verified-worker-outcome-persisted", objectCount: written.length, written };
  } catch (error) {
    return { ok: false, mode: "persist_failed", reason: "idrive_e2_write_failed", objectCount: written.length, written, error: String(error?.message || error).slice(0, 500) };
  }
}

export async function persistJobApprovalToIdrive({ job, approval, env = process.env, putObject } = {}) {
  if (!hasIdrive(env)) return { ok: false, mode: "write-plan-only", reason: "idrive_e2_not_configured", objectCount: 0 };
  if (!job?.taskCapsule?.rootPrefix || approval?.status !== "human_approved") throw new Error("verified_job_approval_required");
  const writer = putObject || idriveWriter(env);
  const event = durableEvent(job.taskCapsule, {
    type: "human_approval_requested",
    createdAt: approval.approvedAt,
    diffSha256: approval.approvedDiffSha256,
    mergeAllowed: false
  });
  const objects = [
    jsonObject(event.key, event),
    jsonObject(`${job.taskCapsule.rootPrefix}approval.json`, approval)
  ];
  const written = [];
  try {
    for (const object of objects) {
      assertObject(object);
      await writer(object);
      written.push(object.key);
    }
    return { ok: true, mode: "human-approval-persisted", objectCount: written.length, written };
  } catch (error) {
    return { ok: false, mode: "persist_failed", reason: "idrive_e2_write_failed", objectCount: written.length, written, error: String(error?.message || error).slice(0, 500) };
  }
}

export async function persistJobCancellationToIdrive({ job, env = process.env, putObject, now = new Date().toISOString() } = {}) {
  if (!hasIdrive(env)) return { ok: false, mode: "write-plan-only", reason: "idrive_e2_not_configured", objectCount: 0 };
  if (!job?.taskCapsule?.rootPrefix) throw new Error("task_capsule_required");
  const writer = putObject || idriveWriter(env);
  const capsule = job.taskCapsule;
  const event = durableEvent(capsule, { type: "cancellation_requested", createdAt: now });
  const queueEntry = { version: 1, jobId: job.id, projectId: job.projectId, status: "cancelled", taskCapsuleRoot: capsule.rootPrefix, updatedAt: now };
  const objects = [
    jsonObject(event.key, event),
    jsonObject(`jobs/cancelled/${job.id}.json`, queueEntry),
    jsonObject(`projects/${job.projectId}/jobs/cancelled/${job.id}.json`, queueEntry),
    jsonObject(`jobs/open/${job.id}.json`, { ...queueEntry, status: "moved", movedTo: `jobs/cancelled/${job.id}.json` }),
    jsonObject(capsule.status, { jobId: job.id, status: "cancelled", phase: "cancelled", progress: 1, message: "Cancelled by human request", updatedAt: now })
  ];
  const written = [];
  try {
    for (const object of objects) {
      assertObject(object);
      await writer(object);
      written.push(object.key);
    }
    return { ok: true, mode: "job-cancellation-persisted", objectCount: written.length, written };
  } catch (error) {
    return { ok: false, mode: "persist_failed", reason: "idrive_e2_write_failed", objectCount: written.length, written, error: String(error?.message || error).slice(0, 500) };
  }
}

export async function persistPublicationAttemptToIdrive({ job, publication, env = process.env, putObject } = {}) {
  if (!hasIdrive(env)) return { ok: false, mode: "write-plan-only", reason: "idrive_e2_not_configured", objectCount: 0 };
  if (!job?.taskCapsule?.rootPrefix || !publication?.attemptedAt) throw new Error("publication_audit_required");
  const writer = putObject || idriveWriter(env);
  const event = durableEvent(job.taskCapsule, {
    type: `draft_pr_publication_${publication.status || "failed"}`,
    createdAt: publication.attemptedAt,
    mergeAllowed: false
  });
  const objects = [
    jsonObject(event.key, event),
    jsonObject(`${job.taskCapsule.rootPrefix}publication.json`, { ...publication, mergePerformed: false })
  ];
  const written = [];
  try {
    for (const object of objects) {
      assertObject(object);
      await writer(object);
      written.push(object.key);
    }
    return { ok: true, mode: "publication-attempt-persisted", objectCount: written.length, written };
  } catch (error) {
    return { ok: false, mode: "persist_failed", reason: "idrive_e2_write_failed", objectCount: written.length, written, error: String(error?.message || error).slice(0, 500) };
  }
}

export function buildWorkerOutcomeObjects(job, outcome, options = {}) {
  if (!job?.taskCapsule?.rootPrefix) throw new Error("task_capsule_required");
  const capsule = job.taskCapsule;
  const now = options.now || outcome.verification?.finishedAt || job.updatedAt || job.createdAt || new Date().toISOString();
  const status = outcome.ok ? "passed" : "failed";
  const outcomeEvent = durableEvent(capsule, {
    type: status,
    createdAt: now,
    diffSha256: outcome.diffSha256 || null
  });
  const transitionEvents = (capsule.events || [])
    .filter((event) => !(event.seq === 1 && event.type === "created"))
    .map((event) => durableEvent(capsule, event));
  const queueEntry = {
    version: 1,
    jobId: job.id,
    projectId: job.projectId,
    status,
    taskCapsuleRoot: capsule.rootPrefix,
    diffSha256: outcome.diffSha256 || null,
    updatedAt: now
  };
  const verification = compactVerification(outcome.verification);
  const iterations = compactIterations(outcome.iterations);
  const errors = compactErrors(outcome.errors);
  const browser = { ...(outcome.browser || {}), screenshots: (outcome.browser?.screenshots || []).map((item) => ({ name: item.name, contentType: item.contentType })) };
  const memoryEligibility = evaluateMemoryEligibility(outcome);
  const memoryMayLearn = memoryEligibility.eligible;
  const finalStatus = jsonObject(capsule.status, {
    jobId: job.id,
    status,
    phase: status,
    progress: 1,
    message: outcome.finalReport || status,
    memoryMayLearn,
    memoryUpdateKey: memoryMayLearn ? capsule.memoryUpdate : null,
    memoryEligibilityReasons: memoryEligibility.reasons,
    trainingEligible: false,
    trainingEligibilityKey: capsule.trainingEligibility || null,
    updatedAt: now
  });
  const objects = [
    textObject(capsule.patch, outcome.diff || "", "text/x-diff; charset=utf-8"),
    jsonObject(`${capsule.rootPrefix}change-set.json`, outcome.changeSet || { schemaVersion: 1, changes: [] }),
    jsonObject(capsule.testResults, verification || { ok: false, error: "missing_verification" }),
    jsonObject(capsule.browserResults, browser),
    jsonObject(capsule.errors, { status, errors }),
    jsonObject(capsule.selfFixAttempts, { status, attempts: iterations }),
    jsonObject(capsule.actionLog || `${capsule.rootPrefix}action-log.json`, compactActionLog(outcome.actionLog, outcome.actionLogSha256, job.id, now)),
    textObject(capsule.verifierReport, verifierReport(outcome), "text/markdown; charset=utf-8"),
    jsonObject(capsule.benchmarkResults, { status, durationMs: outcome.verification?.durationMs || 0, metrics: [] }),
    textObject(capsule.finalReport, outcome.finalReport || "", "text/markdown; charset=utf-8"),
    jsonObject(capsule.memoryUpdate, pendingMemoryUpdate(outcome, capsule, memoryEligibility)),
    jsonObject(capsule.trainingEligibility || `${capsule.rootPrefix}training-eligibility.json`, {
      schemaVersion: 1,
      jobId: job.id,
      trainingEligible: false,
      state: "operational-outcome-not-training-cleared",
      automaticPromotionAllowed: false,
      operationalMemoryIsTrainingPermission: false,
      reasons: ["separate-training-rights-privacy-quality-gate-required"],
      createdAt: now
    }),
    jsonObject(capsule.rollbackManifest, outcome.rollback || { baseCommit: null }),
    jsonObject(`${capsule.rootPrefix}repository.json`, compactRepository(outcome.repository)),
    jsonObject(`${capsule.rootPrefix}approval.json`, outcome.approval || { required: true }),
    jsonObject(`${capsule.rootPrefix}worker-runtime.json`, compactWorkerRuntime(outcome.workerRuntime)),
    jsonObject(`${capsule.rootPrefix}execution-log.json`, iterations),
    ...transitionEvents.map((event) => jsonObject(event.key, event)),
    jsonObject(outcomeEvent.key, outcomeEvent),
    jsonObject(`jobs/${status}/${job.id}.json`, queueEntry),
    jsonObject(`projects/${job.projectId}/jobs/${status}/${job.id}.json`, queueEntry),
    jsonObject(`jobs/open/${job.id}.json`, { ...queueEntry, status: "moved", movedTo: `jobs/${status}/${job.id}.json` })
  ];
  for (const screenshot of outcome.browser?.screenshots || []) {
    const name = String(screenshot.name || "");
    if (!/^[a-zA-Z0-9._-]+\.(?:png|jpe?g)$/.test(name)) continue;
    const bytes = Buffer.from(String(screenshot.base64 || ""), "base64");
    const contentType = /\.png$/i.test(name) ? "image/png" : "image/jpeg";
    if (bytes.length > 0) objects.push({ key: `${capsule.browserScreenshots}${name}`, body: bytes, contentType });
  }
  objects.push(finalStatus);
  return objects;
}

function pendingMemoryUpdate(outcome, capsule, eligibility) {
  if (eligibility?.eligible !== true) {
    return { learn: false, state: "blocked", reasons: eligibility?.reasons || ["memory_eligibility_not_proven"] };
  }
  const { learn: _ignored, ...candidate } = outcome.memoryUpdate || {};
  return {
    learn: false,
    state: "candidate_pending_committed_status",
    activateOnlyWhen: { statusKey: capsule.status, status: "passed", memoryMayLearn: true },
    candidate
  };
}

function durableEvent(capsule, value = {}) {
  const createdAt = validTimestamp(value.createdAt);
  const type = String(value.type || "event").toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 80) || "event";
  const seq = Date.parse(createdAt);
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({
    jobId: capsule.jobId,
    type,
    createdAt,
    diffSha256: value.diffSha256 || null,
    sourceSeq: value.seq || null
  })).digest("hex").slice(0, 12);
  const key = `${capsule.eventsPrefix}${String(seq).padStart(13, "0")}-${type}-${fingerprint}.json`;
  return { ...value, seq, type, key, createdAt };
}

function validTimestamp(value) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) throw new Error("task_capsule_event_timestamp_invalid");
  return date.toISOString();
}

function compactVerification(value) {
  if (!value) return null;
  return {
    ...value,
    checks: (value.checks || []).slice(0, 30).map((check) => ({ ...check, stdout: limitText(check.stdout, 20_000), stderr: limitText(check.stderr, 20_000) })),
    errors: compactErrors(value.errors)
  };
}

function compactIterations(value) {
  return (Array.isArray(value) ? value : []).slice(0, 60).map((item) => ({
    ...item,
    stdout: limitText(item.stdout, 4_000),
    stderr: limitText(item.stderr, 4_000),
    error: limitText(item.error, 2_000)
  }));
}

function compactActionLog(value, actionLogSha256, jobId, createdAt) {
  if (!value || !/^[a-f0-9]{64}$/.test(String(actionLogSha256 || ""))) {
    return {
      schemaVersion: 1,
      jobId,
      status: "unavailable",
      deterministicReplayReady: false,
      actions: [],
      createdAt
    };
  }
  return {
    schemaVersion: 1,
    jobId,
    status: "ready",
    deterministicReplayReady: true,
    actionLogSha256,
    plan: {
      ...value,
      actions: (value.actions || []).slice(0, 200)
    },
    createdAt
  };
}

function compactErrors(value) {
  return (Array.isArray(value) ? value : []).slice(0, 60).map((item) => ({ ...item, detail: limitText(item.detail, 4_000) }));
}

function compactRepository(value = {}) {
  return { ...value, workingTreeStatus: limitText(value?.workingTreeStatus, 50_000) };
}

function compactWorkerRuntime(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { mode: "not-recorded", stopVerified: false, completionPersisted: false };
  }
  const allowed = [
    "mode", "provider", "groupName", "image", "sourceCommit", "manifestSha256",
    "leaseId", "deadlineAt", "budgetApproved", "gatewayOrigin", "stopVerified",
    "completionPersisted", "stopAttempts", "deletionPerformed", "secretsInContainerEnvironment"
  ];
  return Object.fromEntries(allowed.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function limitText(value, limit) {
  const text = String(value || "");
  return text.length > limit ? text.slice(-limit) : text;
}

function verifierReport(outcome) {
  return [
    `# smejj.com Worker Verification`,
    "",
    `Status: ${outcome.ok ? "PASSED" : "FAILED"}`,
    `Diff SHA-256: ${outcome.diffSha256 || "none"}`,
    `Checks: ${(outcome.verification?.checks || []).map((check) => `${check.stage}=${check.ok ? "ok" : "failed"}`).join(", ")}`,
    `Browser: ${outcome.browser?.required ? (outcome.browser.ok ? "passed" : "failed") : "not required"}`,
    `Merge performed: no`
  ].join("\n");
}

function jsonObject(key, value) {
  return textObject(key, `${JSON.stringify(value, null, 2)}\n`, "application/json; charset=utf-8");
}

function textObject(key, body, contentType) {
  return { key, body: String(body || ""), contentType };
}

function assertObject(object) {
  if (!/^(jobs|projects)\//.test(object.key) || object.key.includes("..") || object.key.includes("\\")) throw new Error("unsafe_task_capsule_key");
  const bytes = Buffer.isBuffer(object.body) ? object.body.length : Buffer.byteLength(String(object.body || ""), "utf8");
  if (bytes > MAX_OBJECT_BYTES) throw new Error(`task_capsule_object_too_large:${object.key}`);
}

function hasIdrive(env) {
  return Boolean(env.IDRIVE_E2_ENDPOINT && env.IDRIVE_E2_ACCESS_KEY && env.IDRIVE_E2_SECRET_KEY && env.IDRIVE_E2_BUCKET);
}

function idriveWriter(env) {
  return (object) => signedS3Put({
    endpoint: env.IDRIVE_E2_ENDPOINT,
    region: env.IDRIVE_E2_REGION || "us-west-2",
    accessKey: env.IDRIVE_E2_ACCESS_KEY,
    secretKey: env.IDRIVE_E2_SECRET_KEY,
    bucket: env.IDRIVE_E2_BUCKET,
    key: object.key,
    body: object.body,
    contentType: object.contentType
  });
}
