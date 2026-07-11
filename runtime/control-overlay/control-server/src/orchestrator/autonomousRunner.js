// smejj.com control-server: dispatch and verify stateless coding-worker runs.
import crypto from "node:crypto";
import { transitionIdriveLiteJob } from "../../../src/jobs/index.js";
import { issueWorkerToken, workerTokenSecret } from "../auth/workerToken.js";
import { getJob, replaceJob } from "../jobs/jobStore.js";
import { evaluateMemoryEligibility } from "../jobs/memoryEligibility.js";

const MAX_SELF_FIX_ATTEMPTS = 3;

export function createAutonomousRunner({
  dispatch,
  loadJob = getJob,
  applyTransition = (job, status, message) => {
    const next = transitionIdriveLiteJob(job, status);
    return replaceJob(message ? { ...next, message } : next);
  },
  persistOutcome = async () => ({ ok: true, mode: "persistence_not_requested" }),
  persistPublicationAttempt = async () => ({ ok: true, mode: "persistence_not_requested" }),
  prepareWorkerPayload = async (payload) => payload,
  maxSelfFixAttempts = MAX_SELF_FIX_ATTEMPTS,
  now = () => new Date().toISOString()
} = {}) {
  if (typeof dispatch !== "function") throw new Error("createAutonomousRunner requires a dispatch function");

  return async function run(jobId, input = {}) {
    const job = loadJob(jobId);
    if (!job) return { ok: false, stage: "claim", reason: "job_not_found", memoryMayLearn: false };
    const publicationRun = isDraftPublishAuthorized(job, input);
    if (!new Set(["open", "queued"]).has(job.status) && !publicationRun) {
      return { ok: false, stage: "claim", reason: "job_not_runnable", status: job.status, memoryMayLearn: false };
    }
    let current = job;
    if (!publicationRun) {
      current = applyTransition(job, "planning", "Autonomous loop started");
      current = applyTransition(current, "running", "Queued for stateless worker dispatch");
    }
    const attempts = [];
    let previousErrors = [];
    let lastOutcome = null;
    let persistence = null;
    let workerVerified = false;
    const attemptLimit = publicationRun ? 1 : maxSelfFixAttempts;

    for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
      if (loadJob(jobId)?.status === "cancelled") {
        return { ok: false, stage: "cancelled", attempts, memoryMayLearn: false, memoryUpdate: null, finishedAt: now() };
      }
      try {
        const payload = workerPayload(job, input, { attempt, maxAttempts: attemptLimit, previousErrors }, loadJob);
        lastOutcome = await dispatch(await prepareWorkerPayload(payload, { job, input, attempt }));
      } catch (error) {
        lastOutcome = { ok: false, errors: [{ source: "dispatch", detail: String(error?.message || error).slice(0, 500) }] };
      }
      attempts.push({ attempt, ok: lastOutcome.ok === true, at: now(), errorCount: (lastOutcome.errors || []).length });
      if (loadJob(jobId)?.status === "cancelled") {
        return { ok: false, stage: "cancelled", attempts, memoryMayLearn: false, memoryUpdate: null, finishedAt: now() };
      }

      if (lastOutcome.ok === true) {
        if (publicationRun) {
          const publication = publicationRecord(lastOutcome, attempts, now());
          persistence = await persistWithRetry(() => persistPublicationAttempt({ job, publication, outcome: lastOutcome }));
          const auditedPublication = {
            ...publication,
            auditPersisted: persistence.ok === true,
            auditPersistence: persistence
          };
          replaceJob({
            ...job,
            publication: auditedPublication,
            publicationPersistence: persistence,
            approval: { ...(job.approval || {}), mergeAllowed: false }
          }, { event: "job.publication" });
          return {
            ok: persistence.ok === true,
            stage: persistence.ok === true ? "publication" : "publication_audit",
            attempts,
            publication: auditedPublication,
            persistence,
            verifiedResultPreserved: true,
            memoryMayLearn: false,
            memoryUpdate: null,
            finishedAt: now()
          };
        }
        workerVerified = true;
        current = applyTransition(current, "verifying", "Worker verification passed; persisting Task Capsule evidence");
        persistence = await persistWithRetry(() => persistOutcome({ job: current, outcome: lastOutcome }));
        if (persistence.ok === true) {
          const memoryEligibility = evaluateMemoryEligibility(lastOutcome);
          current = replaceJob({
            ...current,
            result: resultForJob(lastOutcome),
            artifactPersistence: persistence,
            approval: { ...(current.approval || {}), ...lastOutcome.approval, mergeAllowed: false }
          }, { emitEvent: false });
          current = applyTransition(current, "passed", `Autonomous loop passed after ${attempt} attempt(s)`);
          return {
            ok: true,
            stage: "done",
            attempts,
            result: resultForJob(lastOutcome),
            persistence,
            memoryMayLearn: memoryEligibility.eligible,
            memoryUpdate: memoryEligibility.eligible ? lastOutcome.memoryUpdate : null,
            memoryEligibilityReasons: memoryEligibility.reasons,
            finishedAt: now()
          };
        }
        lastOutcome = { ...lastOutcome, ok: false, errors: [{ source: "task_capsule", detail: persistence.error || persistence.reason || "persistence_failed" }] };
        break;
      }

      previousErrors = lastOutcome.errors || [];
      if (attempt < attemptLimit) current = applyTransition(current, "running", `Self-fix attempt ${attempt + 1}/${attemptLimit}`);
    }

    if (publicationRun) {
      const publication = {
        status: "failed",
        attemptedAt: now(),
        attempts,
        errors: (lastOutcome?.errors || previousErrors || []).slice(0, 20),
        mergePerformed: false,
        verifiedResultPreserved: true
      };
      persistence = await persistWithRetry(() => persistPublicationAttempt({ job, publication, outcome: lastOutcome }));
      replaceJob({
        ...job,
        publication,
        publicationPersistence: persistence,
        approval: { ...(job.approval || {}), mergeAllowed: false }
      }, { event: "job.publication" });
      return {
        ok: false,
        stage: "publication",
        attempts,
        persistence,
        verifiedResultPreserved: true,
        memoryMayLearn: false,
        memoryUpdate: null,
        finishedAt: now()
      };
    }
    if (!workerVerified) persistence = await persistWithRetry(() => persistOutcome({ job: current, outcome: lastOutcome || { ok: false, errors: previousErrors } }));
    current = replaceJob({ ...current, result: resultForJob(lastOutcome || {}), artifactPersistence: persistence }, { emitEvent: false });
    const message = workerVerified
      ? "Worker verification passed, but durable Task Capsule persistence failed"
      : `Autonomous loop failed after ${attemptLimit} attempt(s)`;
    applyTransition(current, "failed", message);
    return { ok: false, stage: workerVerified ? "artifact_persistence" : "failed", attempts, persistence, memoryMayLearn: false, memoryUpdate: null, finishedAt: now() };
  };
}

function publicationRecord(outcome, attempts, attemptedAt) {
  const publish = outcome?.approval?.publish || {};
  return {
    status: publish.status === "draft_pr_created" ? "draft_pr_created" : "failed",
    attemptedAt,
    attempts,
    draftPullRequest: publish.draftPullRequest || null,
    errors: (outcome?.errors || []).slice(0, 20),
    mergePerformed: false,
    verifiedResultPreserved: true
  };
}

async function persistWithRetry(write, attempts = 3) {
  let result = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      result = await write();
    } catch (error) {
      result = { ok: false, reason: "persistence_exception", error: String(error?.message || error).slice(0, 500) };
    }
    if (result?.ok === true) return { ...result, persistenceAttempts: attempt };
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
  }
  return { ...(result || { ok: false, reason: "persistence_failed" }), persistenceAttempts: attempts };
}

export function buildHttpDispatch(env = {}, { fetchImpl = fetch, tokenIssuer = issueWorkerToken } = {}) {
  const dispatchUrl = normalizeDispatchUrl(env.SMEJJ_WORKER_DISPATCH_URL);
  const secret = workerTokenSecret(env);
  if (!dispatchUrl || !secret) return null;
  const activeControllers = new Map();
  const dispatch = async function dispatch(payload) {
    const token = tokenIssuer({ secret, jobId: payload.jobId, scopes: ["validate", "model"] });
    const controller = new AbortController();
    activeControllers.set(payload.jobId, controller);
    const timeoutMs = Math.min(70 * 60_000, Math.max(60_000, Number(env.SMEJJ_WORKER_REQUEST_TIMEOUT_MS || 65 * 60_000)));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(dispatchUrl, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload)
      });
      if (!response.ok) return { ok: false, errors: [{ source: "worker_http", detail: `status_${response.status}` }] };
      return await response.json();
    } finally {
      clearTimeout(timer);
      if (activeControllers.get(payload.jobId) === controller) activeControllers.delete(payload.jobId);
    }
  };
  dispatch.cancel = (jobId) => {
    const controller = activeControllers.get(jobId);
    if (!controller) return false;
    controller.abort("job_cancelled");
    return true;
  };
  return dispatch;
}

function workerPayload(job, input, attempt, loadJob = getJob) {
  const parent = job.context?.parentJobId ? loadJob(job.context.parentJobId) : null;
  const replaySource = job.replay?.sourceJobId ? loadJob(job.replay.sourceJobId) : null;
  const followUp = verifiedFollowUpContext(job, parent);
  const replayPlan = verifiedReplayPlan(job, replaySource);
  const publishDraftPr = isDraftPublishAuthorized(job, input);
  return {
    jobId: job.id,
    task: String(job.task || ""),
    previousErrors: attempt.previousErrors,
    attempt: attempt.attempt,
    maxAttempts: attempt.maxAttempts,
    repository: job.repository || null,
    files: [],
    edits: [],
    commands: [],
    modelMode: publishDraftPr || replayPlan ? "disabled" : "enabled",
    ...(publishDraftPr ? { approvedDiff: job.result.diff } : {}),
    taskCapsule: job.taskCapsule,
    preview: job.preview || { required: false },
    verification: {},
    executionMode: job.executionMode || "edit",
    approval: {
      createDraftPr: publishDraftPr,
      approvedDiffSha256: publishDraftPr ? job.approval.approvedDiffSha256 : null
    },
    maxIterations: 25,
    followUpContext: followUp,
    replayPlan
  };
}

function verifiedReplayPlan(job, source) {
  if (job.replay?.deterministic !== true) return null;
  if (!source || source.status !== "passed" || !source.result?.actionLog) throw new Error("deterministic_replay_source_unavailable");
  const expectedHash = String(job.replay.sourceActionLogSha256 || "");
  if (!/^[a-f0-9]{64}$/.test(expectedHash)
    || source.result.actionLogSha256 !== expectedHash
    || sha256(JSON.stringify(source.result.actionLog)) !== expectedHash) {
    throw new Error("deterministic_replay_action_log_mismatch");
  }
  const sameTask = source.task === job.task;
  const sameMode = source.executionMode === job.executionMode;
  const sameRepository = source.repository?.url === job.repository?.url
    && source.repository?.baseRef === job.repository?.baseRef;
  if (!sameTask || !sameMode || !sameRepository || source.userId !== job.userId) {
    throw new Error("deterministic_replay_scope_mismatch");
  }
  return { actionLog: source.result.actionLog, actionLogSha256: expectedHash };
}

function isDraftPublishAuthorized(job, input) {
  return job.status === "passed"
    && input.publishDraftPr === true
    && job.repository?.publishMode === "draft-pr"
    && job.approval?.status === "human_approved"
    && Boolean(job.approval?.approvedDiffSha256)
    && job.approval.approvedDiffSha256 === job.result?.diffSha256;
}

function verifiedFollowUpContext(job, parent) {
  if (!parent?.result?.diff || !parent.result.diffSha256 || !job.repository) return null;
  if (String(parent.result.diff).length > 1_000_000) return null;
  const parentRepository = parent.result.repository || {};
  const sameRepository = parentRepository.url === job.repository.url
    && parentRepository.baseRef === job.repository.baseRef;
  if (!sameRepository || sha256(parent.result.diff) !== parent.result.diffSha256) return null;
  return {
    parentJobId: parent.id,
    diff: String(parent.result.diff),
    diffSha256: parent.result.diffSha256,
    finalReport: parent.result.finalReport,
    repository: {
      url: parentRepository.url,
      baseRef: parentRepository.baseRef,
      baseCommit: parentRepository.baseCommit
    }
  };
}

function normalizeDispatchUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname);
    if (url.username || url.password || url.hash || url.search) return "";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function resultForJob(outcome) {
  return {
    ok: outcome.ok === true,
    status: outcome.status || (outcome.ok ? "verified" : "failed"),
    executionMode: outcome.executionMode || "edit",
    diff: String(outcome.diff || "").slice(0, 1_000_000),
    diffSha256: outcome.diffSha256 || null,
    changeSet: outcome.changeSet || null,
    repository: outcome.repository || null,
    analysis: outcome.analysis || null,
    actionLog: outcome.actionLog || null,
    actionLogSha256: outcome.actionLogSha256 || null,
    replay: outcome.replay || null,
    workerRuntime: outcome.workerRuntime || null,
    verification: outcome.verification || null,
    browser: outcome.browser ? { ...outcome.browser, screenshots: (outcome.browser.screenshots || []).map((item) => ({ name: item.name })) } : null,
    approval: outcome.approval || null,
    finalReport: outcome.finalReport || ""
  };
}
