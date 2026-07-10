import crypto from "node:crypto";

const DEFAULT_TTL_MS = 65 * 60 * 1000;

export function workerTokenSecret(env = process.env) {
  return String(env.SMEJJ_WORKER_TOKEN_SECRET || env.SMEJJ_WORKER_CALLBACK_SECRET || "").trim();
}

export function issueWorkerToken({ secret, jobId, scopes = ["validate", "model"], nowMs = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!secret) throw new Error("worker_token_secret_missing");
  if (!safeJobId(jobId)) throw new Error("worker_token_job_id_invalid");
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    jobId,
    scopes: [...new Set(scopes.map(String))],
    issuedAt: nowMs,
    expiresAt: nowMs + Math.min(DEFAULT_TTL_MS, Math.max(60_000, Number(ttlMs) || DEFAULT_TTL_MS)),
    nonce: crypto.randomBytes(12).toString("base64url")
  })).toString("base64url");
  return `${payload}.${signature(secret, payload)}`;
}

export function verifyWorkerToken(token, { secret, jobId = "", scope = "", nowMs = Date.now() } = {}) {
  if (!secret) return invalid("worker_token_secret_missing", 503);
  const [payloadPart, signaturePart] = String(token || "").split(".");
  if (!payloadPart || !signaturePart) return invalid("worker_token_invalid");
  const expected = signature(secret, payloadPart);
  if (!sameText(expected, signaturePart)) return invalid("worker_token_invalid");
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return invalid("worker_token_invalid");
  }
  if (!safeJobId(payload.jobId) || Number(payload.expiresAt || 0) <= nowMs) return invalid("worker_token_expired");
  if (jobId && payload.jobId !== jobId) return invalid("worker_token_job_mismatch");
  if (scope && (!Array.isArray(payload.scopes) || !payload.scopes.includes(scope))) return invalid("worker_token_scope_missing", 403);
  return { ok: true, status: 200, claims: payload };
}

export function bearerToken(headers = {}) {
  const match = String(headers.authorization || headers.Authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function signature(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function sameText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function safeJobId(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,120}$/.test(String(value || ""));
}

function invalid(reason, status = 401) {
  return { ok: false, status, reason };
}
