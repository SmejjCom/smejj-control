// smejj.com control-server — Job-Routen (Single Responsibility: Job-Lifecycle-API).
// POST /api/jobs             → Job-Envelope + Task-Capsule-Write-Plan (optional Persistenz auf IDrive e2)
// GET  /api/jobs/{id}        → Statusabfrage (Polling)
// GET  /api/jobs/{id}/events → Status-Streaming per SSE (event-driven)
// POST /api/jobs/{id}/status → Worker-Callback (HMAC-signiert, meldet Statusübergänge)
// POST /api/free-executor    → kostenfreier Executor ohne Inferenzstart
import { ROUTES } from "../../../src/shared/platform.js";
import {
  buildTaskCapsuleWritePlan,
  createStorageFirstJobEnvelope,
  runFreeAppExecutor,
  transitionIdriveLiteJob,
  writeJobEnvelopeToIdrive
} from "../../../src/jobs/index.js";
import { json, readJson, readRawBody } from "../http/respond.js";
import { signedS3Put } from "../storage/s3Signer.js";
import { getJob, listJobs, replaceJob, saveJob, subscribeToJob } from "../jobs/jobStore.js";
import { persistJobApprovalToIdrive, persistJobCancellationToIdrive, persistPublicationAttemptToIdrive, persistWorkerOutcomeToIdrive } from "../jobs/jobArtifacts.js";
import { hydrateJobFromIdrive } from "../jobs/jobHydration.js";
import { openEventStream, sendEvent, startHeartbeat } from "../streaming/sse.js";
import { verifyWorkerSignature } from "../auth/workerAuth.js";
import { buildHttpDispatch, createAutonomousRunner } from "../orchestrator/autonomousRunner.js";
import { createJobScheduler } from "../orchestrator/jobScheduler.js";

let scheduler = null;
let schedulerLimit = 0;
const CANCELLABLE_STATUSES = new Set(["open", "queued", "planning", "fast_path", "starting_worker", "running", "verifying"]);

export function hasLocalIdriveConfig(env = process.env) {
  return Boolean(env.IDRIVE_E2_ENDPOINT && env.IDRIVE_E2_ACCESS_KEY && env.IDRIVE_E2_SECRET_KEY && env.IDRIVE_E2_BUCKET);
}

export async function handleCreateJob(req, res, { env = process.env, writeEnvelope = writeJobEnvelopeToIdrive } = {}) {
  const body = await readJson(req);
  if (!String(body.task || "").trim()) return json(res, 400, { error: "Missing task" });
  const envelope = createStorageFirstJobEnvelope({ body, env });
  if (getJob(envelope.job.id)) return json(res, 409, { ok: false, error: "job_already_exists", jobId: envelope.job.id });

  if (body.persistToIdrive === true) {
    if (!hasLocalIdriveConfig(env)) {
      return json(res, 503, {
        ...envelope,
        ok: false,
        error: "IDrive e2 env is not configured for server-side task capsule writes. Job was not scheduled."
      });
    }
    let result;
    try {
      result = await writeEnvelope(envelope, {
        putObject: (object) => signedS3Put({
          endpoint: env.IDRIVE_E2_ENDPOINT,
          region: env.IDRIVE_E2_REGION || "us-west-2",
          accessKey: env.IDRIVE_E2_ACCESS_KEY,
          secretKey: env.IDRIVE_E2_SECRET_KEY,
          bucket: env.IDRIVE_E2_BUCKET,
          key: object.key,
          body: object.body,
          contentType: object.contentType
        })
      });
    } catch (error) {
      return json(res, 503, {
        ok: false,
        error: "task_capsule_persistence_failed",
        message: String(error?.message || error).slice(0, 300),
        jobId: envelope.job.id
      });
    }
    const durableJob = {
      ...envelope.job,
      durableTaskCapsule: true,
      taskCapsulePersistence: result
    };
    saveJob(durableJob);
    return json(res, 201, { ...envelope, job: durableJob, persisted: result });
  }

  saveJob({ ...envelope.job, durableTaskCapsule: false });
  return json(res, 201, envelope);
}

export function handleListJobs(url, res) {
  const status = String(url.searchParams.get("status") || "").trim();
  const jobs = listJobs({ status, limit: Number(url.searchParams.get("limit") || 100) });
  return json(res, 200, { ok: true, count: jobs.length, jobs, queue: currentScheduler().snapshot() });
}

export function handleJobQueue(res) {
  return json(res, 200, { ok: true, queue: currentScheduler().snapshot() });
}

export async function handleFreeExecutor(req, res) {
  const body = await readJson(req);
  if (!String(body.task || "").trim()) return json(res, 400, { error: "Missing task" });
  const envelope = createStorageFirstJobEnvelope({ body, env: process.env });
  const executor = runFreeAppExecutor({ task: body.task, jobEnvelope: envelope });
  saveJob(envelope.job);
  return json(res, 200, {
    ok: true,
    job: envelope.job,
    executor: {
      ...executor,
      idrive: await persistFreeExecutorToIdrive({ envelope, executor, env: process.env })
    },
    inferenceStarted: false,
    paidServicesStarted: false
  });
}

export async function persistFreeExecutorToIdrive({ envelope, executor, env = process.env, putObject } = {}) {
  if (!hasLocalIdriveConfig(env)) {
    return {
      ok: false,
      mode: "write-plan-only",
      reason: "idrive_e2_not_configured",
      objectCount: 0
    };
  }
  const writer = putObject || ((object) => signedS3Put({
    endpoint: env.IDRIVE_E2_ENDPOINT,
    region: env.IDRIVE_E2_REGION || "us-west-2",
    accessKey: env.IDRIVE_E2_ACCESS_KEY,
    secretKey: env.IDRIVE_E2_SECRET_KEY,
    bucket: env.IDRIVE_E2_BUCKET,
    key: object.key,
    body: object.body,
    contentType: object.contentType
  }));
  try {
    const objects = [
      ...(envelope?.taskCapsuleWritePlan?.objects || []),
      ...(envelope?.queueWritePlan?.objects || []),
      ...(executor?.objects || [])
    ].filter((object) => object?.key && object?.body);
    const written = [];
    for (const object of objects) {
      assertSmallControlObject(object);
      await writer(object);
      written.push(object.key);
    }
    return {
      ok: true,
      provider: "idrive-e2",
      mode: "task-capsule-and-artifacts-persisted",
      objectCount: written.length,
      written
    };
  } catch (error) {
    return {
      ok: false,
      provider: "idrive-e2",
      mode: "persist-failed-write-plan-preserved",
      reason: "idrive_e2_write_failed",
      objectCount: 0,
      error: String(error?.message || error).slice(0, 240)
    };
  }
}

function assertSmallControlObject(object) {
  const key = String(object.key || "");
  const body = String(object.body || "");
  if (!key || key.startsWith("/") || key.includes("..") || /[\\]/.test(key)) throw new Error("Unsafe IDrive object key");
  if (!/^(jobs|projects|memory)\//.test(key)) throw new Error("IDrive object key outside allowed prefixes");
  if (body.length > 1_000_000) throw new Error("IDrive object body too large for control server");
}

export function handleJobStatus(url, res) {
  const jobId = decodeURIComponent(url.pathname.slice(`${ROUTES.api.jobs}/`.length));
  const job = getJob(jobId);
  if (!job) return json(res, 404, { ok: false, error: "Job not found in local memory. Durable source is the IDrive e2 Task Capsule." });
  return json(res, 200, {
    ok: true,
    job,
    queue: currentScheduler().snapshot(),
    taskCapsuleWritePlan: buildTaskCapsuleWritePlan(job),
    inferenceStarted: false
  });
}

export async function handleCancelJob(url, req, res, { env = process.env, persistCancellation = persistJobCancellationToIdrive } = {}) {
  const jobId = routeJobId(url, "/cancel");
  const job = getJob(jobId);
  if (!job) return json(res, 404, { ok: false, error: "job_not_found" });
  if (!CANCELLABLE_STATUSES.has(job.status)) return json(res, 409, { ok: false, error: "job_not_cancellable", status: job.status });
  const schedulerResult = currentScheduler().cancel(jobId);
  const cancelled = transitionIdriveLiteJob(job, "cancelled");
  replaceJob({
    ...cancelled,
    message: "Cancellation requested by human; durable audit pending",
    durableCancellation: false,
    approval: { ...(job.approval || {}), mergeAllowed: false }
  });
  let persistence;
  try {
    persistence = await persistCancellation({ job: getJob(jobId), env });
  } catch (error) {
    persistence = { ok: false, reason: "cancellation_persistence_exception", error: String(error?.message || error).slice(0, 300) };
  }
  if (persistence.ok !== true) {
    replaceJob({
      ...getJob(jobId),
      message: "Cancelled locally; durable cancellation audit failed",
      cancellationPersistence: persistence,
      durableCancellation: false
    });
    return json(res, 503, {
      ok: false,
      error: "cancellation_persistence_failed",
      cancelledLocally: true,
      scheduler: schedulerResult,
      job: getJob(jobId),
      persistence
    });
  }
  replaceJob({
    ...getJob(jobId),
    message: "Cancelled by human request",
    cancellationPersistence: persistence,
    durableCancellation: true
  });
  return json(res, 200, { ok: true, job: getJob(jobId), scheduler: schedulerResult, persistence });
}

export async function handleApproveJob(url, req, res, { env = process.env, persistApproval = persistJobApprovalToIdrive } = {}) {
  const jobId = routeJobId(url, "/approve");
  const job = getJob(jobId);
  if (!job) return json(res, 404, { ok: false, error: "job_not_found" });
  if (job.status !== "passed" || !job.result?.diffSha256) return json(res, 409, { ok: false, error: "verified_diff_required" });
  const body = await readJson(req);
  const diffSha256 = String(body.diffSha256 || "");
  if (diffSha256 !== job.result.diffSha256) return json(res, 409, { ok: false, error: "diff_hash_mismatch" });
  const approval = {
    ...(job.approval || {}),
    status: "human_approved",
    approvedAt: new Date().toISOString(),
    approvedDiffSha256: diffSha256,
    mergeAllowed: false,
    mergeRequiresExternalHumanAction: true
  };
  const persistence = await persistApproval({ job, approval, env });
  if (persistence.ok !== true) return json(res, 503, { ok: false, error: "approval_persistence_failed", persistence, mergePerformed: false });
  const updated = replaceJob({
    ...job,
    approval,
    approvalPersistence: persistence
  });
  return json(res, 200, { ok: true, job: updated, persistence, mergePerformed: false });
}

export async function handleWorkerStatusUpdate(url, req, res, { env = process.env, nowMs = Date.now() } = {}) {
  const rawBody = await readRawBody(req);
  const auth = verifyWorkerSignature({ env, headers: req.headers || {}, rawBody, nowMs });
  if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.reason });

  const suffix = "/status";
  const rawId = url.pathname.slice(`${ROUTES.api.jobs}/`.length, url.pathname.length - suffix.length);
  const jobId = decodeURIComponent(rawId);
  const job = getJob(jobId);
  if (!job) return json(res, 404, { ok: false, error: "Job not found in local memory. Durable source is the IDrive e2 Task Capsule." });

  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return json(res, 400, { ok: false, error: "invalid_json" });
  }
  const status = String(body.status || "").trim();
  if (!status) return json(res, 400, { ok: false, error: "missing_status" });

  let transitioned;
  try {
    transitioned = transitionIdriveLiteJob(job, status, body.updatedAt || new Date(nowMs).toISOString());
  } catch (error) {
    return json(res, 400, { ok: false, error: "unsupported_status", message: error.message });
  }
  if (body.message) transitioned = { ...transitioned, message: String(body.message).slice(0, 500) };
  replaceJob(transitioned);

  return json(res, 200, { ok: true, job: transitioned, inferenceStarted: false });
}

export async function handleAutonomousRun(url, req, res, { env = process.env } = {}) {
  if (env.SMEJJ_AUTONOMOUS_LOOP_ENABLED !== "YES") {
    return json(res, 409, { ok: false, error: "autonomous_loop_disabled", required: "SMEJJ_AUTONOMOUS_LOOP_ENABLED=YES" });
  }
  const dispatch = buildHttpDispatch(env);
  if (!dispatch) {
    return json(res, 409, { ok: false, error: "worker_dispatch_not_configured", required: ["SMEJJ_WORKER_DISPATCH_URL", "SMEJJ_WORKER_TOKEN_SECRET or SMEJJ_WORKER_CALLBACK_SECRET"] });
  }
  const suffix = "/autonomous-run";
  const jobId = decodeURIComponent(url.pathname.slice(`${ROUTES.api.jobs}/`.length, url.pathname.length - suffix.length));
  if (!getJob(jobId) && !await hydrateJobFromIdrive(jobId, { env })) {
    return json(res, 404, { ok: false, error: "Job not found in local memory or IDrive e2 Task Capsule." });
  }
  const job = getJob(jobId);
  if (job?.durableTaskCapsule !== true) {
    return json(res, 409, { ok: false, error: "task_capsule_not_persisted", jobId });
  }
  if (job?.context?.parentJobId && !getJob(job.context.parentJobId)) await hydrateJobFromIdrive(job.context.parentJobId, { env });

  const body = await readJson(req);
  if (!isRunnableJob(job, body)) return json(res, 409, { ok: false, error: "job_not_runnable", status: job.status });
  const runner = createAutonomousRunner({
    dispatch,
    persistOutcome: ({ job, outcome }) => persistWorkerOutcomeToIdrive({ job, outcome, env }),
    persistPublicationAttempt: ({ job, publication }) => persistPublicationAttemptToIdrive({ job, publication, env })
  });
  const queued = currentScheduler(env).enqueue(
    jobId,
    () => runner(jobId, body),
    () => dispatch.cancel?.(jobId) === true
  );
  if (!queued.ok) return json(res, 409, { ok: false, error: queued.reason, jobId });
  return json(res, 202, {
    ok: true,
    started: true,
    queued: true,
    jobId,
    queue: queued.snapshot,
    followEvents: `${ROUTES.api.jobs}/${jobId}/events`
  });
}

function isRunnableJob(job, body) {
  if (new Set(["open", "queued"]).has(job?.status)) return true;
  return job?.status === "passed"
    && body?.publishDraftPr === true
    && job.repository?.publishMode === "draft-pr"
    && job.approval?.status === "human_approved"
    && Boolean(job.approval?.approvedDiffSha256)
    && job.approval.approvedDiffSha256 === job.result?.diffSha256;
}

export function handleJobEvents(url, req, res) {
  const suffix = "/events";
  const rawId = url.pathname.slice(`${ROUTES.api.jobs}/`.length, url.pathname.length - suffix.length);
  const jobId = decodeURIComponent(rawId);
  const job = getJob(jobId);
  if (!job) return json(res, 404, { ok: false, error: "Job not found in local memory. Durable source is the IDrive e2 Task Capsule." });

  openEventStream(res);
  sendEvent(res, "job.status", { ok: true, job, inferenceStarted: false });

  const unsubscribe = subscribeToJob(jobId, ({ event, job: updated }) => {
    sendEvent(res, event, { ok: true, job: updated });
  });
  const stopHeartbeat = startHeartbeat(res);

  req.on("close", () => {
    unsubscribe();
    stopHeartbeat();
  });
}

function currentScheduler(env = process.env) {
  const limit = Math.min(8, Math.max(1, Number(env.SMEJJ_MAX_PARALLEL_JOBS || 1)));
  if (!scheduler || schedulerLimit !== limit) {
    scheduler = createJobScheduler({ maxConcurrency: limit });
    schedulerLimit = limit;
  }
  return scheduler;
}

function routeJobId(url, suffix) {
  const rawId = url.pathname.slice(`${ROUTES.api.jobs}/`.length, url.pathname.length - suffix.length);
  return decodeURIComponent(rawId);
}
