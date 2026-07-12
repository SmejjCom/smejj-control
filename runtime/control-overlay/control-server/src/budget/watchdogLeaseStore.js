// smejj.com control-server — immutable IDrive e2 ledger for Salad watchdog leases.
import crypto from "node:crypto";
import { parseS3ListPage, signedS3Get, signedS3List, signedS3Put } from "../storage/s3Signer.js";

const MAX_RUNTIME_MINUTES = 24 * 60;
const RECORD_TYPE = "smejj.com-salad-watchdog-lease";
const COMPLETION_RECORD_TYPE = "smejj.com-salad-watchdog-completion";
const JSON_TYPE = "application/json; charset=utf-8";
const MAX_LIST_PAGES = 1_000;
const MAX_LIST_KEYS = 1_000_000;
const MAX_CONTINUATION_TOKEN_BYTES = 4_096;

/** Builds a secret-free lease that must be persisted before Salad may start. */
export function buildWatchdogLease({
  env = process.env,
  nowMs = Date.now(),
  leaseId = `lease-${crypto.randomUUID()}`
} = {}) {
  const groupName = String(env.SALAD_CONTAINER_GROUP_NAME || "smejj-glm-worker").trim();
  const maxRuntimeMinutes = Number(env.SMEJJ_BUDGET_MAX_RUNTIME_MINUTES);
  const budgetUsd = Number(env.SMEJJ_WORKER_BUDGET_USD);
  if (!Number.isFinite(nowMs) || nowMs <= 0) return { ok: false, reason: "watchdog_clock_invalid" };
  if (!Number.isFinite(maxRuntimeMinutes) || maxRuntimeMinutes <= 0 || maxRuntimeMinutes > MAX_RUNTIME_MINUTES) {
    return { ok: false, reason: "watchdog_runtime_limit_invalid" };
  }
  const validation = validateLease({
    schemaVersion: 1,
    leaseId,
    groupName,
    preparedAt: new Date(nowMs).toISOString(),
    deadlineAt: new Date(nowMs + maxRuntimeMinutes * 60_000).toISOString(),
    maxRuntimeMinutes,
    budgetUsd: Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : 0
  });
  return validation.ok ? { ok: true, lease: validation.lease } : validation;
}

/**
 * Appends one unique lease. A start is permitted only after conditional-create,
 * a second-PUT 412 proof and an exact GET digest readback all succeed.
 */
export async function persistWatchdogLease(lease, {
  env = process.env,
  putObject,
  getObject
} = {}) {
  const config = idriveConfig(env);
  if (!config.ok) return persistenceFailure("watchdog_idrive_config_required");
  const validation = validateLease(lease);
  if (!validation.ok) return persistenceFailure(validation.reason);
  const key = leaseKey(validation.lease);
  const record = createRecord(validation.lease);
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const bodySha256 = sha256(body);
  const object = { key, contentType: JSON_TYPE, body, ifNoneMatch: "*" };
  const writer = putObject || ((entry) => signedS3Put({ ...config.value, ...entry }));
  const reader = getObject || ((objectKey) => signedS3Get({ ...config.value, key: objectKey }));

  try {
    const created = await writer(object);
    if (created?.status === 412) return persistenceFailure("watchdog_lease_collision");
    if (created?.ok !== true || created?.created !== true || created?.conditionEnforced !== true) {
      return persistenceFailure("watchdog_lease_conditional_create_failed");
    }

    const proof = await writer(object);
    if (proof?.status !== 412 || proof?.created !== false || proof?.conditionEnforced !== true) {
      return persistenceFailure("watchdog_lease_overwrite_proof_failed");
    }

    const readback = await reader(key);
    const readBody = readBodyOrNull(readback);
    if (readBody === null || sha256(readBody) !== bodySha256) {
      return persistenceFailure("watchdog_lease_readback_digest_failed");
    }
    const verified = parseStoredRecord(readBody, { expectedGroup: validation.lease.groupName, expectedKey: key });
    if (!verified.ok) return persistenceFailure("watchdog_lease_readback_invalid");

    return {
      ok: true,
      persisted: true,
      immutable: true,
      contentVerified: true,
      key,
      sha256: bodySha256,
      proofStatus: 412
    };
  } catch {
    return persistenceFailure("watchdog_lease_write_failed");
  }
}

/** Appends a terminal event after provider stop evidence has been verified. */
export async function persistWatchdogCompletion(event, {
  env = process.env,
  putObject,
  getObject
} = {}) {
  const config = idriveConfig(env);
  if (!config.ok) return persistenceFailure("watchdog_idrive_config_required");
  const normalized = normalizeCompletionEvent(event);
  if (!normalized.ok) return persistenceFailure(normalized.reason);
  const key = completionKey(normalized.event.lease);
  const record = createCompletionRecord(normalized.event);
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const bodySha256 = sha256(body);
  const object = { key, contentType: JSON_TYPE, body, ifNoneMatch: "*" };
  const writer = putObject || ((entry) => signedS3Put({ ...config.value, ...entry }));
  const reader = getObject || ((objectKey) => signedS3Get({
    ...config.value,
    key: objectKey,
    allowNotFound: true
  }));

  try {
    const created = await writer(object);
    const idempotent = created?.status === 412 && created?.created === false && created?.conditionEnforced === true;
    if (!idempotent && (created?.ok !== true || created?.created !== true || created?.conditionEnforced !== true)) {
      return persistenceFailure("watchdog_completion_conditional_create_failed");
    }
    let proofStatus = 412;
    if (!idempotent) {
      const proof = await writer(object);
      if (proof?.status !== 412 || proof?.created !== false || proof?.conditionEnforced !== true) {
        return persistenceFailure("watchdog_completion_overwrite_proof_failed");
      }
      proofStatus = proof.status;
    }
    const readback = await reader(key);
    const readBody = readBodyOrNull(readback);
    if (readBody === null || sha256(readBody) !== bodySha256) {
      return persistenceFailure(idempotent
        ? "watchdog_completion_collision"
        : "watchdog_completion_readback_digest_failed");
    }
    const verified = parseCompletionRecord(readBody, {
      expectedLease: normalized.event.lease,
      expectedKey: key
    });
    if (!verified.ok) return persistenceFailure("watchdog_completion_readback_invalid");
    return {
      ok: true,
      persisted: true,
      immutable: true,
      contentVerified: true,
      createdNow: !idempotent,
      idempotent,
      key,
      sha256: bodySha256,
      proofStatus
    };
  } catch {
    return persistenceFailure("watchdog_completion_write_failed");
  }
}

/** Loads the newest valid append-only lease for restart recovery. */
export async function loadCurrentWatchdogLease({
  env = process.env,
  listObjects,
  getObject
} = {}) {
  const config = idriveConfig(env);
  if (!config.ok) return recoveryFailure("watchdog_idrive_config_required");
  const groupName = String(env.SALAD_CONTAINER_GROUP_NAME || "smejj-glm-worker").trim();
  if (!validGroupName(groupName)) return recoveryFailure("watchdog_group_name_invalid");
  const prefix = leasePrefix(groupName);
  const lister = listObjects || ((objectPrefix, continuationToken) => signedS3List({
    ...config.value,
    prefix: objectPrefix,
    continuationToken
  }));
  const reader = getObject || ((key) => signedS3Get({
    ...config.value,
    key,
    allowNotFound: true
  }));

  let keys;
  try {
    keys = await listAllKeys(lister, prefix);
    if (!keys) return recoveryFailure("watchdog_recovery_list_failed");
  } catch {
    return recoveryFailure("watchdog_recovery_list_failed");
  }

  const candidates = [...new Set(keys)]
    .filter((key) => key.startsWith(prefix) && key.endsWith("/lease.json"));
  if (!candidates.length) {
    return { ok: true, found: false, reason: "watchdog_recovery_lease_not_found" };
  }

  const validRecords = [];
  for (const key of candidates) {
    let body;
    try {
      body = readBodyOrNull(await reader(key));
    } catch {
      return recoveryFailure("watchdog_recovery_read_failed");
    }
    if (body === null) return recoveryFailure("watchdog_recovery_read_failed");
    const parsed = parseStoredRecord(body, { expectedGroup: groupName, expectedKey: key });
    if (parsed.ok) validRecords.push({ ...parsed, key, recordSha256: sha256(body) });
  }
  if (!validRecords.length) return recoveryFailure("watchdog_recovery_no_valid_lease");

  validRecords.sort((left, right) => {
    const timeDelta = Date.parse(right.lease.preparedAt) - Date.parse(left.lease.preparedAt);
    return timeDelta || right.lease.leaseId.localeCompare(left.lease.leaseId);
  });
  const newest = validRecords[0];
  const terminalKey = completionKey(newest.lease);
  let terminalRead;
  try {
    terminalRead = await reader(terminalKey);
  } catch {
    return recoveryFailure("watchdog_recovery_completion_read_failed");
  }
  if (!isNotFound(terminalRead)) {
    const terminalBody = readBodyOrNull(terminalRead);
    if (terminalBody === null) return recoveryFailure("watchdog_recovery_completion_read_failed");
    const terminal = parseCompletionRecord(terminalBody, {
      expectedLease: newest.lease,
      expectedKey: terminalKey
    });
    if (!terminal.ok) return recoveryFailure("watchdog_recovery_completion_invalid");
    return {
      ok: true,
      found: false,
      terminal: true,
      reason: "watchdog_recovery_lease_completed",
      leaseId: newest.lease.leaseId,
      completedAt: terminal.completedAt,
      key: terminalKey,
      sha256: sha256(terminalBody)
    };
  }
  return {
    ok: true,
    found: true,
    lease: newest.lease,
    key: newest.key,
    sha256: newest.recordSha256
  };
}

/** Loads every unfinished ephemeral lease so a restarted Control Server can stop all orphaned groups. */
export async function loadActiveWatchdogLeases({
  env = process.env,
  groupPrefix = "smejj-job-",
  maxLeases = 1_000,
  listObjects,
  getObject
} = {}) {
  const config = idriveConfig(env);
  if (!config.ok) return recoveryFailure("watchdog_idrive_config_required");
  if (!/^[a-z][a-z0-9-]{2,30}$/.test(String(groupPrefix || ""))) {
    return recoveryFailure("watchdog_group_prefix_invalid");
  }
  const limit = Number(maxLeases);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    return recoveryFailure("watchdog_recovery_limit_invalid");
  }
  const rootPrefix = "workers/salad/watchdogs/";
  const lister = listObjects || ((prefix, continuationToken) => signedS3List({
    ...config.value,
    prefix,
    continuationToken
  }));
  const reader = getObject || ((key) => signedS3Get({
    ...config.value,
    key,
    allowNotFound: true
  }));
  let keys;
  try {
    keys = await listAllKeys(lister, rootPrefix);
  } catch {
    return recoveryFailure("watchdog_recovery_list_failed");
  }
  if (!keys) return recoveryFailure("watchdog_recovery_list_failed");
  const candidates = [...new Set(keys)].filter((key) => {
    const match = String(key).match(/^workers\/salad\/watchdogs\/([a-z][a-z0-9-]{1,62})\/([a-zA-Z0-9][a-zA-Z0-9._-]{7,120})\/lease\.json$/);
    return match && match[1].startsWith(groupPrefix);
  });
  const active = [];
  for (const key of candidates) {
    const groupName = key.split("/")[3];
    let leaseRead;
    try {
      leaseRead = await reader(key);
    } catch {
      return recoveryFailure("watchdog_recovery_read_failed");
    }
    const leaseBody = readBodyOrNull(leaseRead);
    if (leaseBody === null) return recoveryFailure("watchdog_recovery_read_failed");
    const parsed = parseStoredRecord(leaseBody, { expectedGroup: groupName, expectedKey: key });
    if (!parsed.ok) return recoveryFailure("watchdog_recovery_lease_invalid");
    const terminalKey = completionKey(parsed.lease);
    let terminalRead;
    try {
      terminalRead = await reader(terminalKey);
    } catch {
      return recoveryFailure("watchdog_recovery_completion_read_failed");
    }
    if (isNotFound(terminalRead)) {
      if (active.length >= limit) return recoveryFailure("watchdog_recovery_limit_exceeded");
      active.push({ lease: parsed.lease, key, sha256: sha256(leaseBody), completionKey: terminalKey });
      continue;
    }
    const terminalBody = readBodyOrNull(terminalRead);
    if (terminalBody === null || !parseCompletionRecord(terminalBody, {
      expectedLease: parsed.lease,
      expectedKey: terminalKey
    }).ok) return recoveryFailure("watchdog_recovery_completion_invalid");
  }
  active.sort((left, right) => Date.parse(left.lease.preparedAt) - Date.parse(right.lease.preparedAt));
  return { ok: true, found: active.length > 0, count: active.length, leases: active };
}

function createRecord(lease) {
  return {
    schemaVersion: 1,
    recordType: RECORD_TYPE,
    state: "prepared",
    lease,
    leaseSha256: sha256(JSON.stringify(lease))
  };
}

function createCompletionRecord(event) {
  return {
    schemaVersion: 1,
    recordType: COMPLETION_RECORD_TYPE,
    state: "stop-verified",
    leaseId: event.lease.leaseId,
    groupName: event.lease.groupName,
    leaseSha256: sha256(JSON.stringify(event.lease)),
    completedAt: event.completedAt,
    reason: event.reason,
    verification: event.verification
  };
}

function parseStoredRecord(body, { expectedGroup, expectedKey } = {}) {
  let record;
  try {
    record = JSON.parse(String(body));
  } catch {
    return { ok: false };
  }
  if (record?.schemaVersion !== 1 || record?.recordType !== RECORD_TYPE || record?.state !== "prepared") {
    return { ok: false };
  }
  const validation = validateLease(record.lease);
  if (!validation.ok || validation.lease.groupName !== expectedGroup) return { ok: false };
  if (record.leaseSha256 !== sha256(JSON.stringify(validation.lease))) return { ok: false };
  if (expectedKey && leaseKey(validation.lease) !== expectedKey) return { ok: false };
  return { ok: true, lease: validation.lease };
}

function parseCompletionRecord(body, { expectedLease, expectedKey } = {}) {
  let record;
  try {
    record = JSON.parse(String(body));
  } catch {
    return { ok: false };
  }
  const normalized = normalizeCompletionEvent({
    lease: expectedLease,
    completedAt: record?.completedAt,
    reason: record?.reason,
    verification: record?.verification
  });
  if (!normalized.ok || record?.schemaVersion !== 1 || record?.recordType !== COMPLETION_RECORD_TYPE ||
      record?.state !== "stop-verified" || record?.leaseId !== normalized.event.lease.leaseId ||
      record?.groupName !== normalized.event.lease.groupName ||
      record?.leaseSha256 !== sha256(JSON.stringify(normalized.event.lease))) return { ok: false };
  if (expectedKey && completionKey(normalized.event.lease) !== expectedKey) return { ok: false };
  if (JSON.stringify(record.verification) !== JSON.stringify(normalized.event.verification)) return { ok: false };
  return {
    ok: true,
    completedAt: normalized.event.completedAt,
    reason: normalized.event.reason,
    verification: normalized.event.verification
  };
}

function normalizeCompletionEvent(value) {
  const validation = validateLease(value?.lease);
  if (!validation.ok) return { ok: false, reason: validation.reason };
  const completedMs = Date.parse(value?.completedAt);
  if (!Number.isFinite(completedMs) || completedMs < Date.parse(validation.lease.preparedAt)) {
    return { ok: false, reason: "watchdog_completion_timestamp_invalid" };
  }
  const reason = String(value?.reason || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,120}$/.test(reason)) {
    return { ok: false, reason: "watchdog_completion_reason_invalid" };
  }
  const verification = normalizeStopVerification(value?.verification);
  if (!verification) return { ok: false, reason: "watchdog_completion_verification_invalid" };
  return {
    ok: true,
    event: {
      lease: validation.lease,
      completedAt: new Date(completedMs).toISOString(),
      reason,
      verification
    }
  };
}

function normalizeStopVerification(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const providerStatus = value.providerStatus;
  const activeReplicas = value.activeReplicas;
  const configuredReplicas = value.configuredReplicas;
  const providerAbsent = value.providerAbsent;
  const lifecycleState = value.lifecycleState;
  const statusValid = typeof providerStatus === "number" && Number.isInteger(providerStatus);
  const activeValid = typeof activeReplicas === "number" && activeReplicas === 0;
  const configuredValid = configuredReplicas === null || (Number.isInteger(configuredReplicas) && configuredReplicas >= 0);
  const absentProof = providerAbsent === true && providerStatus === 404 && lifecycleState === "not-found";
  const stoppedProof = providerAbsent === false && providerStatus >= 200 && providerStatus <= 299 &&
    lifecycleState === "stopped";
  const failedProof = providerAbsent === false && providerStatus >= 200 && providerStatus <= 299 &&
    lifecycleState === "failed";
  if (value.verified !== true || typeof providerAbsent !== "boolean" || !statusValid || !activeValid ||
      !configuredValid || (!absentProof && !stoppedProof && !failedProof)) return null;
  return {
    verified: true,
    providerAbsent,
    providerStatus,
    configuredReplicas,
    activeReplicas: 0,
    lifecycleState
  };
}

function validateLease(value) {
  const lease = value && typeof value === "object" ? value : {};
  const leaseId = String(lease.leaseId || "");
  const groupName = String(lease.groupName || "");
  if (!validLeaseId(leaseId)) return { ok: false, reason: "watchdog_lease_id_invalid" };
  if (!validGroupName(groupName)) return { ok: false, reason: "watchdog_group_name_invalid" };
  const preparedMs = Date.parse(lease.preparedAt);
  const deadlineMs = Date.parse(lease.deadlineAt);
  const maxRuntimeMinutes = Number(lease.maxRuntimeMinutes);
  if (!Number.isFinite(preparedMs) || !Number.isFinite(deadlineMs) || deadlineMs <= preparedMs) {
    return { ok: false, reason: "watchdog_lease_deadline_invalid" };
  }
  if (!Number.isFinite(maxRuntimeMinutes) || maxRuntimeMinutes <= 0 || maxRuntimeMinutes > MAX_RUNTIME_MINUTES) {
    return { ok: false, reason: "watchdog_runtime_limit_invalid" };
  }
  if (deadlineMs - preparedMs !== maxRuntimeMinutes * 60_000) {
    return { ok: false, reason: "watchdog_lease_duration_mismatch" };
  }
  const budgetUsd = Number(lease.budgetUsd);
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) return { ok: false, reason: "watchdog_budget_invalid" };
  return {
    ok: true,
    lease: {
      schemaVersion: 1,
      leaseId,
      groupName,
      preparedAt: new Date(preparedMs).toISOString(),
      deadlineAt: new Date(deadlineMs).toISOString(),
      maxRuntimeMinutes,
      budgetUsd
    }
  };
}

async function listAllKeys(lister, prefix) {
  const keys = [];
  const seenTokens = new Set();
  let continuationToken = null;
  for (let pageNumber = 1; pageNumber <= MAX_LIST_PAGES; pageNumber += 1) {
    const listing = await lister(prefix, continuationToken);
    const page = listingPage(listing);
    if (!page) return null;
    keys.push(...page.keys);
    if (keys.length > MAX_LIST_KEYS) return null;
    if (!page.isTruncated) return keys;
    if (!validContinuationToken(page.nextContinuationToken) || seenTokens.has(page.nextContinuationToken)) return null;
    seenTokens.add(page.nextContinuationToken);
    continuationToken = page.nextContinuationToken;
  }
  return null;
}

function listingPage(listing) {
  if (Array.isArray(listing?.keys) && listing?.ok === true) {
    const isTruncated = listing.isTruncated === true;
    if (listing.isTruncated !== undefined && typeof listing.isTruncated !== "boolean") return null;
    return {
      keys: listing.keys.map(String),
      isTruncated,
      nextContinuationToken: isTruncated ? String(listing.nextContinuationToken || "") : null
    };
  }
  if (listing?.response?.ok !== true) return null;
  const page = parseS3ListPage(String(listing.body || ""));
  if (typeof page.isTruncated !== "boolean") return null;
  return page;
}

function validContinuationToken(value) {
  const token = String(value || "");
  return token.length > 0 && Buffer.byteLength(token, "utf8") <= MAX_CONTINUATION_TOKEN_BYTES &&
    !/[\u0000-\u001f\u007f]/.test(token);
}

function readBodyOrNull(result) {
  if (typeof result === "string") return result;
  if (!result || result.ok !== true || typeof result.body !== "string") return null;
  return result.body;
}

function isNotFound(result) {
  return result?.ok === false && result?.status === 404;
}

function leaseKey(lease) {
  return `${leasePrefix(lease.groupName)}${lease.leaseId}/lease.json`;
}

function completionKey(lease) {
  return `${leasePrefix(lease.groupName)}${lease.leaseId}/completion.json`;
}

function leasePrefix(groupName) {
  return `workers/salad/watchdogs/${groupName}/`;
}

function validLeaseId(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{7,120}$/.test(value);
}

function validGroupName(value) {
  return /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function persistenceFailure(reason) {
  return { ok: false, persisted: false, reason };
}

function recoveryFailure(reason) {
  return { ok: false, found: false, reason };
}

function idriveConfig(env) {
  const value = {
    endpoint: String(env.IDRIVE_E2_WATCHDOG_ENDPOINT || "").replace(/\/+$/, ""),
    region: String(env.IDRIVE_E2_WATCHDOG_REGION || ""),
    accessKey: String(env.IDRIVE_E2_WATCHDOG_ACCESS_KEY || ""),
    secretKey: String(env.IDRIVE_E2_WATCHDOG_SECRET_KEY || ""),
    bucket: String(env.IDRIVE_E2_WATCHDOG_BUCKET || ""),
    timeoutMs: Number(env.IDRIVE_E2_WATCHDOG_TIMEOUT_MS || 5_000)
  };
  if (!value.endpoint || !value.region || !value.accessKey || !value.secretKey || !value.bucket ||
      !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 30_000 ||
      String(env.IDRIVE_E2_WATCHDOG_ALLOWED_PREFIX || "") !== "workers/salad/watchdogs/") {
    return { ok: false };
  }
  try {
    const endpoint = new URL(value.endpoint);
    const host = endpoint.hostname.toLowerCase();
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        !["", "/"].includes(endpoint.pathname) ||
        (host !== "idrivee2.com" && !host.endsWith(".idrivee2.com"))) return { ok: false };
  } catch {
    return { ok: false };
  }
  return { ok: true, value };
}
