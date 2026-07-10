import crypto from "node:crypto";

const DEFAULT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_PENDING = 128;
const DEFAULT_MAX_PER_ORIGIN = 8;
const HANDOFF_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createSessionHandoffStore({
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
  ttlMs = DEFAULT_TTL_MS,
  maxPending = DEFAULT_MAX_PENDING,
  maxPerOrigin = DEFAULT_MAX_PER_ORIGIN
} = {}) {
  const records = new Map();

  function start(returnOrigin) {
    const origin = normalizeOrigin(returnOrigin);
    cleanup();
    if (!origin) return failure(400, "session_handoff_origin_invalid");
    const activeForOrigin = [...records.values()].filter((record) => record.returnOrigin === origin).length;
    if (records.size >= maxPending || activeForOrigin >= maxPerOrigin) {
      return failure(429, "session_handoff_capacity_reached");
    }
    const id = randomBytes(32).toString("base64url");
    if (!HANDOFF_ID_PATTERN.test(id) || records.has(id)) return failure(503, "session_handoff_id_unavailable");
    const expiresAt = now() + boundedTtl(ttlMs);
    records.set(id, { id, returnOrigin: origin, expiresAt, status: "pending", token: "", user: null });
    return { ok: true, status: 201, id, expiresAt };
  }

  function complete(id, { token, user } = {}) {
    cleanup();
    const record = records.get(normalizeId(id));
    if (!record) return failure(404, "session_handoff_not_found");
    if (!String(token || "") || !user) return failure(400, "session_handoff_completion_invalid");
    record.status = "completed";
    record.token = String(token);
    record.user = user;
    return { ok: true, status: 200, expiresAt: record.expiresAt };
  }

  function consume(id, requestOrigin) {
    cleanup();
    const record = records.get(normalizeId(id));
    if (!record) return failure(404, "session_handoff_not_found");
    if (normalizeOrigin(requestOrigin) !== record.returnOrigin) return failure(403, "session_handoff_origin_mismatch");
    if (record.status !== "completed") {
      return { ok: true, status: 202, state: "pending", expiresAt: record.expiresAt };
    }
    records.delete(record.id);
    return {
      ok: true,
      status: 200,
      state: "completed",
      accessToken: record.token,
      user: record.user,
      tokenStorage: "session-only"
    };
  }

  function cleanup() {
    const current = now();
    for (const [id, record] of records) {
      if (record.expiresAt <= current) records.delete(id);
    }
  }

  return { start, complete, consume, size: () => records.size };
}

export function isSessionHandoffId(value) {
  return HANDOFF_ID_PATTERN.test(String(value || ""));
}

function normalizeId(value) {
  const id = String(value || "");
  return HANDOFF_ID_PATTERN.test(id) ? id : "";
}

function normalizeOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/^https?:$/.test(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function boundedTtl(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(5 * 60 * 1000, Math.max(30_000, Math.floor(number))) : DEFAULT_TTL_MS;
}

function failure(status, error) {
  return { ok: false, status, error };
}
