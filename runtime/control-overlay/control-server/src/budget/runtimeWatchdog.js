// smejj.com control-server — durable Salad runtime watchdog.
// A stop is complete only after Salad reports a terminal lifecycle state with zero active instances.

export const STOP_RETRY_DELAYS_MS = Object.freeze([5_000, 15_000, 30_000, 60_000]);

const INSTANCE_COUNT_KEYS = Object.freeze([
  "allocating_count",
  "creating_count",
  "running_count",
  "stopping_count"
]);

/** Returns a fail-closed, secret-free interpretation of a Salad group status. */
export function evaluateContainerGroupStopped(result) {
  const providerStatus = normalizedProviderStatus(result?.status);
  if (providerStatus === 404) {
    return {
      verified: true,
      providerAbsent: true,
      providerStatus,
      configuredReplicas: 0,
      activeReplicas: 0,
      lifecycleState: "not-found"
    };
  }
  const responseOk = result?.ok === true && providerStatus >= 200 && providerStatus <= 299;
  const payload = isPlainObject(result?.data) ? result.data : {};
  const configuredReplicas = nonNegativeInteger(payload.replicas);
  const currentState = isPlainObject(payload.current_state) ? payload.current_state : {};
  const lifecycleState = safeLifecycleState(currentState.status);
  const counts = isPlainObject(currentState.instance_status_counts)
    ? currentState.instance_status_counts
    : null;
  const countValues = INSTANCE_COUNT_KEYS.map((key) => nonNegativeInteger(counts?.[key]));
  const countsKnown = countValues.every((value) => value !== null);
  const activeReplicas = countsKnown ? countValues.reduce((total, value) => total + value, 0) : null;
  const verified = responseOk
    && activeReplicas === 0
    && new Set(["stopped", "failed"]).has(lifecycleState);
  return {
    verified,
    providerAbsent: false,
    providerStatus,
    configuredReplicas,
    activeReplicas,
    lifecycleState
  };
}

/**
 * Creates one group-scoped watchdog. Leases must be durably persisted before
 * they can be armed. Stop retries remain active until Salad proves a terminal
 * stopped/failed state and all four active instance counters are zero.
 * Configured replicas are advisory.
 */
export function createRuntimeWatchdog({
  stopWorker,
  getWorkerStatus,
  persistLease,
  persistCompletion,
  listActiveJobs = () => [],
  failJob = () => {},
  now = () => Date.now(),
  schedule = setTimeout,
  cancel = clearTimeout,
  retryDelaysMs = STOP_RETRY_DELAYS_MS
} = {}) {
  const state = {
    phase: "idle",
    lease: null,
    deadlineTimer: null,
    retryTimer: null,
    stopPromise: null,
    resolveStop: null,
    firstAttemptPromise: null,
    attempts: 0,
    nextRetryAt: 0,
    failedJobIds: [],
    jobsFailed: false,
    stopReason: null,
    lastEnforcement: null,
    completionEvent: null,
    completionPersisted: false,
    durableCompletionExists: false,
    prepareToken: null
  };

  function status() {
    return {
      phase: state.phase,
      armed: state.phase === "armed",
      enforcingStop: state.phase === "enforcing-stop",
      stopVerified: state.phase === "stop-verified",
      leaseId: state.lease?.leaseId || null,
      groupName: state.lease?.groupName || null,
      preparedAt: state.lease?.preparedAt || null,
      deadlineAt: state.lease?.deadlineAt || null,
      maxRuntimeMinutes: Number(state.lease?.maxRuntimeMinutes || 0),
      attempts: state.attempts,
      completionPersisted: state.completionPersisted,
      nextRetryAt: state.nextRetryAt ? new Date(state.nextRetryAt).toISOString() : null,
      lastEnforcement: state.lastEnforcement
    };
  }

  async function prepareLease(lease) {
    const validation = validateLease(lease);
    if (!validation.ok) return { ...status(), ok: false, reason: validation.reason };
    if (!canInstallLease(state.phase) || state.prepareToken) {
      return { ...status(), ok: false, reason: "watchdog_lease_already_active" };
    }
    if (typeof persistLease !== "function") {
      return { ...status(), ok: false, reason: "watchdog_lease_persistence_required" };
    }
    const previousPhase = state.phase;
    const prepareToken = Symbol("watchdog-lease-prepare");
    state.prepareToken = prepareToken;
    state.phase = "preparing";
    let persistence;
    try {
      persistence = await persistLease(validation.lease);
    } catch {
      rollbackPreparation(prepareToken, previousPhase);
      return { ...status(), ok: false, reason: "watchdog_lease_persistence_failed" };
    }
    if (persistence?.ok !== true || persistence?.persisted !== true) {
      rollbackPreparation(prepareToken, previousPhase);
      return { ...status(), ok: false, reason: "watchdog_lease_persistence_failed" };
    }
    if (state.prepareToken !== prepareToken || state.phase !== "preparing") {
      if (state.prepareToken === prepareToken) state.prepareToken = null;
      return { ...status(), ok: false, reason: "watchdog_lease_prepare_superseded" };
    }
    installLease(validation.lease);
    return { ...status(), ok: true, persisted: true };
  }

  function armPreparedLease() {
    if (state.phase !== "prepared" || !state.lease) {
      return { ...status(), ok: false, reason: "persisted_watchdog_lease_required" };
    }
    const remainingMs = Date.parse(state.lease.deadlineAt) - now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      void enforceStop("runtime_deadline_already_exceeded");
      return { ...status(), ok: false, reason: "runtime_deadline_already_exceeded" };
    }
    clearDeadlineTimer();
    state.deadlineTimer = schedule(() => {
      state.deadlineTimer = null;
      void enforceStop("runtime_budget_exceeded");
    }, remainingMs);
    unrefTimer(state.deadlineTimer);
    state.phase = "armed";
    return { ...status(), ok: true };
  }

  function enforceStop(reason = "runtime_budget_exceeded") {
    if (state.phase === "enforcing-stop" && state.stopPromise) return state.stopPromise;
    if (state.phase === "stop-verified") resetCompletedEnforcement();
    state.prepareToken = null;
    clearDeadlineTimer();
    clearRetryTimer();
    state.phase = "enforcing-stop";
    state.stopReason = safeReason(reason);
    failActiveJobsOnce(state.stopReason);
    state.stopPromise = new Promise((resolve) => { state.resolveStop = resolve; });
    state.firstAttemptPromise = attemptStop();
    return state.stopPromise;
  }

  async function attemptStop() {
    state.attempts += 1;
    const attempt = state.attempts;
    const attemptedAt = new Date(now()).toISOString();
    state.completionEvent = null;
    state.completionPersisted = false;
    let stopResult;
    try {
      stopResult = typeof stopWorker === "function"
        ? await stopWorker()
        : { ok: false, reason: "stop_worker_unavailable", uncertain: true };
    } catch {
      stopResult = { ok: false, reason: "stop_request_failed", uncertain: true };
    }
    let statusResult;
    try {
      statusResult = typeof getWorkerStatus === "function"
        ? await getWorkerStatus()
        : { ok: false, reason: "worker_status_unavailable", uncertain: true };
    } catch {
      statusResult = { ok: false, reason: "worker_status_failed", uncertain: true };
    }
    const verification = evaluateContainerGroupStopped(statusResult);
    state.lastEnforcement = {
      reason: state.stopReason,
      attemptedAt,
      attempt,
      stopRequest: safeProviderResult(stopResult),
      verification,
      failedJobIds: [...state.failedJobIds],
      completion: {
        ok: false,
        required: Boolean(state.lease),
        persisted: false,
        reason: "provider_stop_not_verified"
      }
    };
    if (verification.verified) {
      if (state.lease) {
        state.completionEvent = Object.freeze({
          lease: state.lease,
          completedAt: attemptedAt,
          reason: state.stopReason,
          verification: Object.freeze({ ...verification })
        });
      }
      const completion = state.durableCompletionExists
        ? existingDurableCompletion()
        : await persistTerminalCompletion();
      state.lastEnforcement.completion = completion;
      if (completion.ok) return finishStopVerification(completion);
    }
    scheduleRetry(attempt);
    return status();
  }

  async function persistTerminalCompletion() {
    if (!state.lease) {
      return { ok: true, required: false, persisted: false, reason: "no_lease_to_complete" };
    }
    if (!state.completionEvent || typeof persistCompletion !== "function") {
      return { ok: false, required: true, persisted: false, reason: "completion_persistence_required" };
    }
    let result;
    try {
      result = await persistCompletion(state.completionEvent);
    } catch {
      return { ok: false, required: true, persisted: false, reason: "completion_persistence_failed" };
    }
    const proven = result?.ok === true && result?.persisted === true && result?.immutable === true &&
      result?.contentVerified === true;
    return {
      ok: proven,
      required: true,
      persisted: proven,
      immutable: result?.immutable === true,
      contentVerified: result?.contentVerified === true,
      idempotent: result?.idempotent === true,
      reason: proven ? "completion_persisted" : "completion_persistence_failed"
    };
  }

  function finishStopVerification(completion) {
    state.completionPersisted = completion.persisted === true;
    state.durableCompletionExists ||= completion.persisted === true;
    state.phase = "stop-verified";
    state.nextRetryAt = 0;
    clearRetryTimer();
    const completed = status();
    const resolveStop = state.resolveStop;
    state.resolveStop = null;
    state.stopPromise = null;
    state.firstAttemptPromise = null;
    resolveStop?.(completed);
    return completed;
  }

  function scheduleRetry(attempt) {
    const delays = normalizedRetryDelays(retryDelaysMs);
    const delay = delays[Math.min(attempt - 1, delays.length - 1)];
    state.nextRetryAt = now() + delay;
    state.retryTimer = schedule(() => {
      state.retryTimer = null;
      void attemptStop();
    }, delay);
  }

  async function waitForFirstAttempt() {
    if (!state.firstAttemptPromise) return status();
    await state.firstAttemptPromise;
    return status();
  }

  async function recoverLease(lease) {
    const validation = validateLease(lease);
    if (!validation.ok) return { ...status(), ok: false, reason: validation.reason };
    if (!canInstallLease(state.phase) || state.prepareToken) {
      return { ...status(), ok: false, reason: "watchdog_lease_already_active" };
    }
    installLease(validation.lease);
    if (Date.parse(validation.lease.deadlineAt) <= now()) {
      void enforceStop("recovered_runtime_deadline_exceeded");
      await waitForFirstAttempt();
      return { ...status(), ok: true, recovered: true };
    }
    return { ...armPreparedLease(), recovered: true };
  }

  function disarm() {
    if (!["idle", "prepared", "stop-verified"].includes(state.phase)) {
      return { ...status(), ok: false, reason: "stop_verification_required" };
    }
    clearDeadlineTimer();
    clearRetryTimer();
    state.phase = "idle";
    state.lease = null;
    state.stopPromise = null;
    state.resolveStop = null;
    state.firstAttemptPromise = null;
    state.completionEvent = null;
    state.completionPersisted = false;
    state.durableCompletionExists = false;
    return { ...status(), ok: true };
  }

  function installLease(lease) {
    clearDeadlineTimer();
    clearRetryTimer();
    state.phase = "prepared";
    state.lease = Object.freeze({ ...lease });
    state.stopPromise = null;
    state.resolveStop = null;
    state.firstAttemptPromise = null;
    state.attempts = 0;
    state.nextRetryAt = 0;
    state.failedJobIds = [];
    state.jobsFailed = false;
    state.stopReason = null;
    state.lastEnforcement = null;
    state.completionEvent = null;
    state.completionPersisted = false;
    state.durableCompletionExists = false;
    state.prepareToken = null;
  }

  function rollbackPreparation(prepareToken, previousPhase) {
    if (state.prepareToken !== prepareToken) return;
    state.prepareToken = null;
    if (state.phase === "preparing") state.phase = previousPhase;
  }

  function resetCompletedEnforcement() {
    state.stopPromise = null;
    state.resolveStop = null;
    state.firstAttemptPromise = null;
    state.attempts = 0;
    state.nextRetryAt = 0;
    state.failedJobIds = [];
    state.jobsFailed = false;
    state.stopReason = null;
    state.lastEnforcement = null;
    state.completionEvent = null;
    state.completionPersisted = false;
    state.prepareToken = null;
  }

  function existingDurableCompletion() {
    return {
      ok: true,
      required: true,
      persisted: true,
      immutable: true,
      contentVerified: true,
      idempotent: true,
      reason: "completion_already_persisted"
    };
  }

  function failActiveJobsOnce(reason) {
    if (state.jobsFailed) return;
    state.jobsFailed = true;
    for (const job of listActiveJobs()) {
      try {
        failJob(job, reason);
        state.failedJobIds.push(job.id);
      } catch {
        // One malformed job cannot prevent the cost kill-switch.
      }
    }
  }

  function clearDeadlineTimer() {
    if (state.deadlineTimer) cancel(state.deadlineTimer);
    state.deadlineTimer = null;
  }

  function clearRetryTimer() {
    if (state.retryTimer) cancel(state.retryTimer);
    state.retryTimer = null;
  }

  return {
    prepareLease,
    armPreparedLease,
    enforceStop,
    fire: enforceStop,
    waitForFirstAttempt,
    recoverLease,
    disarm,
    status
  };
}

function validateLease(value) {
  const lease = value && typeof value === "object" ? value : {};
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{7,120}$/.test(String(lease.leaseId || ""))) {
    return { ok: false, reason: "watchdog_lease_id_invalid" };
  }
  if (!/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(String(lease.groupName || ""))) {
    return { ok: false, reason: "watchdog_group_name_invalid" };
  }
  const preparedAt = Date.parse(lease.preparedAt);
  const deadlineAt = Date.parse(lease.deadlineAt);
  const maxRuntimeMinutes = Number(lease.maxRuntimeMinutes);
  if (!Number.isFinite(preparedAt) || !Number.isFinite(deadlineAt) || deadlineAt <= preparedAt) {
    return { ok: false, reason: "watchdog_lease_deadline_invalid" };
  }
  if (!Number.isFinite(maxRuntimeMinutes) || maxRuntimeMinutes <= 0) {
    return { ok: false, reason: "watchdog_lease_runtime_invalid" };
  }
  return {
    ok: true,
    lease: {
      schemaVersion: 1,
      leaseId: String(lease.leaseId),
      groupName: String(lease.groupName),
      preparedAt: new Date(preparedAt).toISOString(),
      deadlineAt: new Date(deadlineAt).toISOString(),
      maxRuntimeMinutes,
      budgetUsd: nonNegativeNumber(lease.budgetUsd)
    }
  };
}

function normalizedRetryDelays(value) {
  const delays = Array.isArray(value)
    ? value.map(Number).filter((delay) => Number.isFinite(delay) && delay > 0)
    : [];
  return delays.length ? delays : [...STOP_RETRY_DELAYS_MS];
}

function safeProviderResult(result) {
  return {
    ok: result?.ok === true,
    status: normalizedProviderStatus(result?.status),
    reason: safeReason(result?.reason || (result?.ok === true ? "accepted" : "provider_request_failed")),
    uncertain: result?.uncertain === true
  };
}

function normalizedProviderStatus(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 599 ? value : 0;
}

function safeReason(value) {
  const reason = String(value || "operation_failed").toLowerCase();
  return /^[a-z0-9][a-z0-9._:-]{0,120}$/.test(reason) ? reason : "operation_failed";
}

function safeLifecycleState(value) {
  const state = typeof value === "string" ? value.toLowerCase() : "";
  return ["pending", "running", "stopped", "failed", "deploying"].includes(state) ? state : "unknown";
}

function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function canInstallLease(phase) {
  return phase === "idle" || phase === "stop-verified";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function unrefTimer(timer) {
  if (timer && typeof timer.unref === "function") timer.unref();
}
