// smejj.com control-server — fail-closed Salad lifecycle control.
import {
  buildSaladGlmWorkerPlan,
  saladCreateContainerGroup,
  saladGetContainerGroup,
  saladListGpuClasses,
  saladStartContainerGroup,
  saladStopContainerGroup,
  transitionIdriveLiteJob
} from "../../../src/jobs/index.js";
import { json, privateJson } from "../http/respond.js";
import { evaluateWorkerBudget } from "../budget/budgetGate.js";
import { createRuntimeWatchdog, evaluateContainerGroupStopped } from "../budget/runtimeWatchdog.js";
import {
  buildWatchdogLease,
  loadCurrentWatchdogLease,
  persistWatchdogCompletion,
  persistWatchdogLease
} from "../budget/watchdogLeaseStore.js";
import { activeJobs, activeWorkerCount, replaceJob } from "../jobs/jobStore.js";

export const runtimeWatchdog = createRuntimeWatchdog({
  stopWorker: () => saladStopContainerGroup({ ...process.env, CONFIRM_SALAD_STOP: "YES" }),
  getWorkerStatus: () => saladGetContainerGroup(process.env),
  persistLease: (lease) => persistWatchdogLease(lease, { env: process.env }),
  persistCompletion: (event) => persistWatchdogCompletion(event, { env: process.env }),
  listActiveJobs: activeJobs,
  failJob: (job, reason) => {
    const failed = transitionIdriveLiteJob(job, "failed");
    replaceJob({ ...failed, message: `Runtime watchdog: ${reason}` });
  }
});

function currentBudget(env = process.env, activeWorkers = activeWorkerCount()) {
  return evaluateWorkerBudget({ env, activeWorkers });
}

export function handleSaladPlan(res, { env = process.env, watchdog = runtimeWatchdog } = {}) {
  return json(res, 200, {
    ...buildSaladGlmWorkerPlan({ env }),
    budget: currentBudget(env),
    runtimeWatchdog: watchdog.status()
  });
}

export async function handleSaladStatus(res, {
  env = process.env,
  getStatus = saladGetContainerGroup
} = {}) {
  const result = await safeMutation(() => getStatus(env));
  return privateJson(res, 200, publicStatusResult(result));
}

export async function handleSaladGpuClasses(res, { env = process.env } = {}) {
  return json(res, 200, await saladListGpuClasses(env));
}

export async function handleSaladCreate(res, {
  env = process.env,
  createGroup = saladCreateContainerGroup,
  watchdog = runtimeWatchdog,
  activeWorkers = activeWorkerCount()
} = {}) {
  const budget = currentBudget(env, activeWorkers);
  if (!budget.ok) return budgetDenied(res, budget);
  const plan = buildSaladGlmWorkerPlan({ env });
  if (env.CONFIRM_SALAD_CREATE !== "YES" || !plan.ok) {
    return json(res, 409, {
      ok: false,
      reason: env.CONFIRM_SALAD_CREATE === "YES" ? "salad_plan_not_ready" : "confirm_salad_create_required",
      workerStarted: false,
      paidServicesStarted: false,
      budget,
      runtimeWatchdog: watchdog.status()
    });
  }
  const result = await safeMutation(() => createGroup({ env, plan }));
  return json(res, result.ok ? 200 : 502, {
    ...publicMutationResult(result),
    workerStarted: false,
    paidServicesStarted: false,
    budget,
    runtimeWatchdog: watchdog.status()
  });
}

export async function handleSaladStart(res, {
  env = process.env,
  startGroup = saladStartContainerGroup,
  leaseBuilder = buildWatchdogLease,
  watchdog = runtimeWatchdog,
  activeWorkers = activeWorkerCount()
} = {}) {
  const budget = currentBudget(env, activeWorkers);
  if (!budget.ok) return budgetDenied(res, budget);
  if (env.CONFIRM_SALAD_START !== "YES") {
    return json(res, 409, {
      ok: false,
      reason: "confirm_salad_start_required",
      workerStarted: false,
      paidServicesStarted: false,
      budget,
      runtimeWatchdog: watchdog.status()
    });
  }
  if (env.SMEJJ_SALAD_WATCHDOG_RECOVERY_ENABLED !== "YES") {
    return json(res, 503, {
      ok: false,
      reason: "watchdog_recovery_not_enabled",
      workerStarted: false,
      paidServicesStarted: false,
      budget,
      runtimeWatchdog: watchdog.status()
    });
  }
  const leasePlan = leaseBuilder({ env });
  if (leasePlan?.ok !== true || !leasePlan.lease) {
    return json(res, 503, {
      ok: false,
      reason: safeReason(leasePlan?.reason || "watchdog_lease_build_failed"),
      workerStarted: false,
      paidServicesStarted: false,
      budget,
      runtimeWatchdog: watchdog.status()
    });
  }
  const prepared = await watchdog.prepareLease(leasePlan.lease);
  if (prepared?.ok !== true || prepared?.persisted !== true) {
    return json(res, 503, {
      ok: false,
      reason: safeReason(prepared?.reason || "watchdog_lease_persistence_failed"),
      workerStarted: false,
      paidServicesStarted: false,
      budget,
      runtimeWatchdog: watchdog.status()
    });
  }
  const result = await safeMutation(() => startGroup(env));
  if (result.ok !== true) {
    void watchdog.enforceStop("start_state_uncertain");
    await watchdog.waitForFirstAttempt();
    return json(res, 502, {
      ...publicMutationResult(result),
      workerStarted: false,
      paidServicesStarted: null,
      startStateUncertain: true,
      budget,
      runtimeWatchdog: watchdog.status()
    });
  }
  const armed = watchdog.armPreparedLease();
  if (armed?.ok !== true || armed?.armed !== true) {
    void watchdog.enforceStop("watchdog_arm_failed_after_start");
    await watchdog.waitForFirstAttempt();
    return json(res, 503, {
      ok: false,
      reason: "watchdog_arm_failed_after_start",
      workerStarted: false,
      paidServicesStarted: null,
      startStateUncertain: true,
      budget,
      runtimeWatchdog: watchdog.status()
    });
  }
  return json(res, 200, {
    ...publicMutationResult(result),
    workerStarted: true,
    paidServicesStarted: true,
    budget,
    runtimeWatchdog: watchdog.status()
  });
}

export async function handleSaladStop(res, { watchdog = runtimeWatchdog } = {}) {
  void watchdog.enforceStop("manual_stop");
  await watchdog.waitForFirstAttempt();
  const state = watchdog.status();
  return json(res, state.stopVerified ? 200 : 202, {
    ok: state.stopVerified,
    stopVerified: state.stopVerified,
    enforcementPending: !state.stopVerified,
    runtimeWatchdog: state
  });
}

export async function recoverRuntimeWatchdogFromIdrive({
  env = process.env,
  watchdog = runtimeWatchdog,
  loadLease = loadCurrentWatchdogLease,
  getWorkerStatus = saladGetContainerGroup
} = {}) {
  const loaded = await loadLease({ env });
  if (loaded?.ok !== true) {
    const providerStatus = await safeMutation(() => getWorkerStatus(env));
    if (providerStatus.status === 404 || evaluateContainerGroupStopped(providerStatus).verified) {
      return {
        ok: false,
        recovered: false,
        workerSafe: true,
        reason: safeReason(loaded?.reason || "watchdog_recovery_failed")
      };
    }
    void watchdog.enforceStop("watchdog_recovery_state_uncertain");
    await watchdog.waitForFirstAttempt();
    return {
      ok: false,
      recovered: false,
      workerSafe: watchdog.status().stopVerified,
      reason: safeReason(loaded?.reason || "watchdog_recovery_failed")
    };
  }
  if (loaded.found !== true) {
    const providerStatus = await safeMutation(() => getWorkerStatus(env));
    if (providerStatus.status === 404) {
      return { ok: true, recovered: false, reason: "salad_group_not_found" };
    }
    if (evaluateContainerGroupStopped(providerStatus).verified) {
      return { ok: true, recovered: false, reason: "salad_group_already_stopped" };
    }
    void watchdog.enforceStop("watchdog_recovery_lease_missing");
    await watchdog.waitForFirstAttempt();
    const state = watchdog.status();
    return {
      ok: state.stopVerified,
      recovered: false,
      reason: state.stopVerified ? "missing_lease_stop_verified" : "missing_lease_stop_pending"
    };
  }
  const recovered = await watchdog.recoverLease(loaded.lease);
  return {
    ok: recovered?.ok === true,
    recovered: recovered?.recovered === true,
    reason: recovered?.ok === true ? "watchdog_lease_recovered" : safeReason(recovered?.reason || "watchdog_recovery_failed")
  };
}

function budgetDenied(res, budget) {
  return json(res, 402, {
    ok: false,
    error: "budget_gate_denied",
    workerStarted: false,
    paidServicesStarted: false,
    budget
  });
}

async function safeMutation(operation) {
  try {
    const result = await operation();
    return result && typeof result === "object"
      ? result
      : { ok: false, status: 0, reason: "salad_result_invalid", uncertain: true };
  } catch {
    return { ok: false, status: 0, reason: "salad_api_unreachable", uncertain: true };
  }
}

function publicMutationResult(result) {
  return {
    ok: result?.ok === true,
    providerStatus: strictProviderStatus(result?.status),
    reason: safeReason(result?.reason || (result?.ok === true ? "accepted" : "salad_request_failed")),
    uncertain: result?.uncertain === true
  };
}

function publicStatusResult(result) {
  const verification = evaluateContainerGroupStopped(result);
  const providerStatus = strictProviderStatus(result?.status);
  const ok = result?.ok === true && providerStatus >= 200 && providerStatus <= 299;
  return {
    ok,
    providerStatus,
    reason: safeReason(result?.reason || (ok ? "accepted" : "salad_request_failed")),
    uncertain: result?.uncertain === true,
    providerAbsent: verification.providerAbsent,
    configuredReplicas: verification.configuredReplicas,
    activeReplicas: verification.activeReplicas,
    lifecycleState: verification.lifecycleState,
    stopVerified: verification.verified
  };
}

function strictProviderStatus(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 599 ? value : 0;
}

function safeReason(value) {
  const reason = String(value || "operation_failed").toLowerCase();
  return /^[a-z0-9][a-z0-9._:-]{0,120}$/.test(reason) ? reason : "operation_failed";
}
