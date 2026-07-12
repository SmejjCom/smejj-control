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
import { hydrateJobFromIdrive, hydrateRecentJobsFromIdrive } from "../jobs/jobHydration.js";
import { authenticatedUserId, filterJobsForUser, filterSchedulerSnapshot, isJobOwnedByUser } from "../jobs/jobAccess.js";
import { createJobClaimStore } from "../jobs/jobClaimStore.js";
import { assertGithubRepositoryAllowed, attachGithubInstallationToken } from "../github/githubApp.js";
import { publishVerifiedJobToGithub } from "../github/trustedPublisher.js";
import { openEventStream, sendEvent, startHeartbeat } from "../streaming/sse.js";
import { verifyWorkerSignature } from "../auth/workerAuth.js";
import { buildHttpDispatch, createAutonomousRunner } from "../orchestrator/autonomousRunner.js";
import { createReviewedEphemeralWorkerDispatch as createEphemeralWorkerDispatch } from "../orchestrator/ephemeralWorkerDispatch.js";
import { createJobScheduler } from "../orchestrator/jobScheduler.js";

let scheduler = null;
let schedulerLimit = 0;
const CANCELLABLE_STATUSES = new Set(["open", "queued", "planning", "fast_path", "starting_worker", "running", "verifying"]);

export function hasLocalIdriveConfig(env = process.env) {
  return Boolean(env.IDRIVE_E2_ENDPOINT && env.IDRIVE_E2_ACCESS_KEY && env.IDRIVE_E2_SECRET_KEY && env.IDRIVE_E2_BUCKET);
}

export async function handleCreateJob(req, res, { env = process.env, writeEnvelope = writeJobEnvelopeToIdrive } = {}) {
  const input = await readJson(req);
  const ownedInput = req.authUser ? { ...input, userId: authenticatedUserId(req.authUser) } : input;
  const body = inferDeterministicReplay(ownedInput, ownedInput.userId);
  if (!String(body.task || "").trim()) return json(res, 400, { error: "Missing task" });
  const repository = body.repository || body.repo;
  const guardedRepository = repository?.visibility === "private"
    || repository?.private === true
    || repository?.publishMode === "draft-pr"
    || env.SMEJJ_WORKER_REQUIRE_REPO_ALLOWLIST === "YES";
  if (repository?.url && guardedRepository) {
    try {
      assertGithubRepositoryAllowed(repository, env);
    } catch {
      return json(res, 403, { ok: false, error: "repository_not_allowed" });
    }
  }
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

export async function handleListJobs(url, res, {
  env = process.env,
  hydrateJobs = hydrateRecentJobsFromIdrive,
  authUser = null
} = {}) {
  if (url.searchParams.get("hydrate") === "1") {
    await hydrateJobs({ env, limit: Number(url.searchParams.get("limit") || 50) }).catch(() => null);
  }
  const status = String(url.searchParams.get("status") || "").trim();
  const allJobs = listJobs({ status, limit: Number(url.searchParams.get("limit") || 100) });
  const jobs = (authUser ? filterJobsForUser(allJobs, authUser) : allJobs).map(jobSummary);
  return json(res, 200, {
    ok: true,
    count: jobs.length,
    jobs,
    queue: visibleQueue(authUser, currentScheduler(env).snapshot())
  });
}

export function handleJobQueue(res, { env = process.env, authUser = null } = {}) {
  return json(res, 200, { ok: true, queue: visibleQueue(authUser, currentScheduler(env).snapshot()) });
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

export async function handleJobStatus(url, res, {
  env = process.env,
  hydrateJob = hydrateJobFromIdrive,
  authUser = null
} = {}) {
  const jobId = decodeURIComponent(url.pathname.slice(`${ROUTES.api.jobs}/`.length));
  const job = getJob(jobId) || await hydrateJob(jobId, { env });
  if (!job) return json(res, 404, { ok: false, error: "Job not found in local memory. Durable source is the IDrive e2 Task Capsule." });
  if (authUser && !isJobOwnedByUser(job, authUser)) return json(res, 404, { ok: false, error: "job_not_found" });
  return json(res, 200, {
    ok: true,
    job,
    queue: visibleQueue(authUser, currentScheduler(env).snapshot()),
    taskCapsuleWritePlan: buildTaskCapsuleWritePlan(job),
    inferenceStarted: false
  });
}

export async function handleCancelJob(url, req, res, { env = process.env, persistCancellation = persistJobCancellationToIdrive } = {}) {
  const jobId = routeJobId(url, "/cancel");
  const job = getJob(jobId);
  if (!job) return json(res, 404, { ok: false, error: "job_not_found" });
  if (req.authUser && !isJobOwnedByUser(job, req.authUser)) return json(res, 404, { ok: false, error: "job_not_found" });
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
  if (req.authUser && !isJobOwnedByUser(job, req.authUser)) return json(res, 404, { ok: false, error: "job_not_found" });
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

export async function handleAutonomousRun(url, req, res, {
  env = process.env,
  claimStore = null,
  dispatchFactory = buildHttpDispatch,
  ephemeralDispatchFactory = createEphemeralWorkerDispatch,
  publishJob = publishVerifiedJobToGithub,
  persistPublication = persistPublicationAttemptToIdrive
} = {}) {
  if (env.SMEJJ_AUTONOMOUS_LOOP_ENABLED !== "YES") {
    return json(res, 409, { ok: false, error: "autonomous_loop_disabled", required: "SMEJJ_AUTONOMOUS_LOOP_ENABLED=YES" });
  }
  const suffix = "/autonomous-run";
  const jobId = decodeURIComponent(url.pathname.slice(`${ROUTES.api.jobs}/`.length, url.pathname.length - suffix.length));
  if (!getJob(jobId) && !await hydrateJobFromIdrive(jobId, { env })) {
    return json(res, 404, { ok: false, error: "Job not found in local memory or IDrive e2 Task Capsule." });
  }
  const job = getJob(jobId);
  if (req.authUser && !isJobOwnedByUser(job, req.authUser)) return json(res, 404, { ok: false, error: "job_not_found" });
  if (job?.durableTaskCapsule !== true) {
    return json(res, 409, { ok: false, error: "task_capsule_not_persisted", jobId });
  }
  if (job?.context?.parentJobId && !getJob(job.context.parentJobId)) await hydrateJobFromIdrive(job.context.parentJobId, { env });
  if (job?.replay?.sourceJobId && !getJob(job.replay.sourceJobId)) await hydrateJobFromIdrive(job.replay.sourceJobId, { env });

  const body = await readJson(req);
  if (body?.publishDraftPr === true) {
    return handleTrustedPublication(res, { job, body, env, publishJob, persistPublication });
  }

  const dispatch = env.SMEJJ_EPHEMERAL_WORKER_ENABLED === "YES"
    ? ephemeralDispatchFactory({ env, job })
    : dispatchFactory(env);
  if (!dispatch) {
    if (env.SMEJJ_EPHEMERAL_WORKER_ENABLED === "YES") {
      return json(res, 409, { ok: false, error: "ephemeral_worker_not_ready" });
    }
    return json(res, 409, { ok: false, error: "worker_dispatch_not_configured", required: ["SMEJJ_WORKER_DISPATCH_URL", "SMEJJ_WORKER_TOKEN_SECRET or SMEJJ_WORKER_CALLBACK_SECRET"] });
  }
  if (!isRunnableJob(job, body)) return json(res, 409, { ok: false, error: "job_not_runnable", status: job.status });
  const claims = claimStore || createJobClaimStore({ env });
  const claim = await claims.claim(job);
  if (claim.ok !== true) {
    const status = claim.reason === "job_claim_active" || claim.reason === "job_claim_race_lost" ? 409 : 503;
    return json(res, status, { ok: false, error: claim.reason || "job_claim_failed", jobId });
  }
  let finalizationPromise = null;
  const finalizeWorker = (reason) => {
    if (typeof dispatch.close !== "function") return Promise.resolve(null);
    if (!finalizationPromise) finalizationPromise = dispatch.close(jobId, reason);
    return finalizationPromise;
  };
  const runner = createAutonomousRunner({
    dispatch,
    prepareWorkerPayload: (payload) => attachGithubInstallationToken(payload, { env }),
    persistOutcome: async ({ job: outcomeJob, outcome }) => {
      const workerRuntime = await finalizeWorker("worker_outcome_ready");
      if (workerRuntime) outcome.workerRuntime = workerRuntime;
      return persistWorkerOutcomeToIdrive({
        job: outcomeJob,
        outcome,
        env
      });
    },
    persistPublicationAttempt: async ({ job: publicationJob, publication }) => {
      const workerRuntime = await finalizeWorker("publication_outcome_ready");
      if (workerRuntime) publication.workerRuntime = workerRuntime;
      return persistPublicationAttemptToIdrive({
        job: publicationJob,
        publication,
        env
      });
    }
  });
  const heartbeat = createClaimHeartbeat({ claims, job, lease: claim.lease, dispatch });
  heartbeat.start();
  const queued = currentScheduler(env).enqueue(
    jobId,
    async () => {
      try {
        return await runner(jobId, body);
      } finally {
        heartbeat.stop();
        const statusBeforeClose = getJob(jobId)?.status || "unknown";
        try {
          const workerRuntime = await finalizeWorker(statusBeforeClose === "cancelled" ? "job_cancelled" : "job_completed");
          if (workerRuntime && getJob(jobId)) {
            replaceJob({ ...getJob(jobId), workerRuntime }, { emitEvent: false });
          }
        } catch {
          const current = getJob(jobId);
          if (current && current.status !== "cancelled") {
            replaceJob({ ...current, status: "failed", phase: "failed", message: "Ephemeral worker stop could not be durably verified" });
          }
        }
        const finalStatus = getJob(jobId)?.status || statusBeforeClose;
        const completion = finalStatus === "cancelled"
          ? await claims.release(job, claim.lease, finalStatus)
          : await claims.complete(job, claim.lease, finalStatus);
        if (completion.ok !== true && getJob(jobId)) {
          replaceJob({ ...getJob(jobId), claimCompletion: completion }, { emitEvent: false });
        }
      }
    },
    () => {
      heartbeat.stop();
      void claims.release(job, claim.lease, "cancelled");
      dispatch.cancel?.(jobId);
      return true;
    }
  );
  if (!queued.ok) {
    heartbeat.stop();
    await claims.release(job, claim.lease, queued.reason);
    return json(res, 409, { ok: false, error: queued.reason, jobId });
  }
  return json(res, 202, {
    ok: true,
    started: true,
    queued: true,
    jobId,
    queue: visibleQueue(req.authUser, queued.snapshot),
    followEvents: `${ROUTES.api.jobs}/${jobId}/events`
  });
}

async function handleTrustedPublication(res, { job, body, env, publishJob, persistPublication }) {
  if (job.publication?.attemptedAt) {
    return json(res, 409, { ok: false, error: "publication_already_attempted", jobId: job.id, mergePerformed: false });
  }
  const attemptedAt = new Date().toISOString();
  let outcome;
  try {
    outcome = await publishJob({
      job,
      env,
      title: String(body.title || ""),
      body: String(body.body || "")
    });
  } catch {
    outcome = { ok: false, reason: "github_publisher_exception", mergePerformed: false };
  }
  const publication = {
    status: outcome?.ok === true ? "draft_pr_created" : "failed",
    attemptedAt,
    draftPullRequest: outcome?.draftPullRequest || null,
    errors: outcome?.ok === true ? [] : [{ source: "github_publisher", detail: safeReason(outcome?.reason || "publication_failed") }],
    mergePerformed: false,
    verifiedResultPreserved: true,
    baseCommitVerified: outcome?.baseCommitVerified === true,
    changeSetVerified: outcome?.changeSetVerified === true
  };
  let persistence;
  try {
    persistence = await persistPublication({ job, publication, env });
  } catch {
    persistence = { ok: false, reason: "publication_audit_persistence_failed" };
  }
  const audited = {
    ...publication,
    auditPersisted: persistence?.ok === true,
    auditPersistence: persistence
  };
  replaceJob({
    ...job,
    publication: audited,
    publicationPersistence: persistence,
    approval: { ...(job.approval || {}), mergeAllowed: false }
  }, { event: "job.publication" });
  if (persistence?.ok !== true) {
    return json(res, 503, {
      ok: false,
      error: "publication_audit_persistence_failed",
      publication: audited,
      verifiedResultPreserved: true,
      mergePerformed: false
    });
  }
  const status = outcome?.ok === true ? 200 : publicationFailureStatus(outcome?.reason);
  return json(res, status, {
    ok: outcome?.ok === true,
    error: outcome?.ok === true ? null : safeReason(outcome?.reason || "publication_failed"),
    publication: audited,
    verifiedResultPreserved: true,
    mergePerformed: false
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

function publicationFailureStatus(reason) {
  return new Set([
    "github_publisher_not_enabled",
    "github_publisher_app_not_configured",
    "github_publish_human_approval_required",
    "github_publish_diff_approval_mismatch",
    "github_publish_repository_not_allowed",
    "github_free_private_draft_pr_unavailable",
    "github_publish_repository_state_invalid",
    "github_publish_change_set_invalid"
  ]).has(String(reason || "")) ? 409 : 502;
}

function safeReason(value) {
  return String(value || "publication_failed").toLowerCase().replace(/[^a-z0-9._:-]/g, "_").slice(0, 160);
}

export async function handleJobEvents(url, req, res, {
  env = process.env,
  hydrateJob = hydrateJobFromIdrive
} = {}) {
  const suffix = "/events";
  const rawId = url.pathname.slice(`${ROUTES.api.jobs}/`.length, url.pathname.length - suffix.length);
  const jobId = decodeURIComponent(rawId);
  const job = getJob(jobId) || await hydrateJob(jobId, { env });
  if (!job) return json(res, 404, { ok: false, error: "Job not found in local memory. Durable source is the IDrive e2 Task Capsule." });
  if (req.authUser && !isJobOwnedByUser(job, req.authUser)) return json(res, 404, { ok: false, error: "job_not_found" });

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

function visibleQueue(authUser, snapshot) {
  return authUser ? filterSchedulerSnapshot(snapshot, authUser, getJob) : snapshot;
}

export function inferDeterministicReplay(body = {}, ownerId = "", {
  jobs = listJobs({ limit: 200 }),
  nowMs = Date.now()
} = {}) {
  if (!ownerId || body.parentJobId) return body;
  const requestedSource = String(body.replay?.sourceJobId || "");
  const executionMode = String(body.executionMode || body.mode || "").toLowerCase() === "analyze" ? "analyze" : "edit";
  const repository = body.repository || body.repo || {};
  const candidates = jobs.filter((job) => {
    if (job.userId !== ownerId || job.status !== "passed" || !job.result?.actionLog || !job.result?.actionLogSha256) return false;
    if (requestedSource) return job.id === requestedSource;
    const age = nowMs - Date.parse(job.updatedAt || job.createdAt || 0);
    return age >= 0
      && age <= 30 * 60_000
      && job.task === String(body.task || "").trim()
      && job.executionMode === executionMode
      && job.repository?.url === String(repository.url || "").trim()
      && job.repository?.baseRef === String(repository.baseRef || repository.ref || "main").trim();
  });
  const source = candidates.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))[0];
  if (!source) {
    if (body.replay?.deterministic === true) throw new Error("deterministic replay source is unavailable");
    return body;
  }
  return {
    ...body,
    replay: {
      deterministic: true,
      sourceJobId: source.id,
      sourceActionLogSha256: source.result.actionLogSha256
    }
  };
}

function jobSummary(job) {
  const result = job.result ? {
    ok: job.result.ok,
    status: job.result.status,
    diffSha256: job.result.diffSha256 || null,
    finalReport: String(job.result.finalReport || "").slice(0, 500),
    repository: job.result.repository || null
  } : null;
  return { ...job, task: String(job.task || "").slice(0, 500), ...(result ? { result } : {}) };
}

function createClaimHeartbeat({ claims, job, lease, dispatch }) {
  let timer = null;
  let inFlight = false;
  const intervalMs = Math.max(5_000, Math.floor(Number(claims.ttlMs || 120_000) / 3));
  return {
    start() {
      if (timer) return;
      timer = setInterval(async () => {
        if (inFlight) return;
        inFlight = true;
        try {
          const renewed = await renewJobClaimHeartbeat({ claims, job, lease });
          if (renewed.ok !== true) {
            clearInterval(timer);
            timer = null;
            const current = getJob(job.id);
            if (current) {
              replaceJob({
                ...current,
                claimHeartbeatFailure: {
                  reason: renewed.reason || "job_claim_heartbeat_failed",
                  attempts: Number(renewed.attempts || 1),
                  failedAt: new Date().toISOString()
                }
              }, { emitEvent: false });
            }
            dispatch.cancel?.(job.id);
          } else {
            lease = renewed.lease;
          }
        } finally {
          inFlight = false;
        }
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    }
  };
}

export async function renewJobClaimHeartbeat({
  claims,
  job,
  lease,
  attempts = 3,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  const limit = Math.min(3, Math.max(1, Number(attempts) || 1));
  let result = { ok: false, reason: "job_claim_heartbeat_failed" };
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    try {
      result = await claims.heartbeat(job, lease);
    } catch {
      result = { ok: false, reason: "job_claim_heartbeat_exception" };
    }
    if (result?.ok === true) return { ...result, attempts: attempt };
    if (!TRANSIENT_CLAIM_HEARTBEAT_FAILURES.has(result?.reason) || attempt === limit) {
      return { ...(result || {}), ok: false, attempts: attempt };
    }
    await sleep(250 * attempt);
  }
  return { ...result, ok: false, attempts: limit };
}

const TRANSIENT_CLAIM_HEARTBEAT_FAILURES = new Set([
  "job_claim_head_read_failed",
  "job_claim_head_write_failed",
  "job_claim_readback_mismatch",
  "job_claim_heartbeat_exception"
]);
