import crypto from "node:crypto";

const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function issueSessionToken({ secret, user, nowMs = Date.now(), ttlMs = MAX_TTL_MS } = {}) {
  if (!String(secret || "")) throw new Error("session_token_secret_missing");
  const safeUser = normalizeUser(user);
  if (!safeUser) throw new Error("session_token_user_invalid");
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    user: safeUser,
    issuedAt: nowMs,
    expiresAt: nowMs + Math.min(MAX_TTL_MS, Math.max(60_000, Number(ttlMs) || MAX_TTL_MS))
  })).toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

export function verifySessionToken(token, { secret, nowMs = Date.now() } = {}) {
  if (!String(secret || "")) return null;
  const [payloadPart, signaturePart] = String(token || "").split(".");
  if (!payloadPart || !signaturePart || !sameText(sign(secret, payloadPart), signaturePart)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    if (payload.version !== 1 || Number(payload.expiresAt || 0) <= nowMs || Number(payload.issuedAt || 0) > nowMs + 60_000) return null;
    return normalizeUser(payload.user);
  } catch {
    return null;
  }
}

export function bearerSessionToken(headers = {}) {
  const match = String(headers.authorization || headers.Authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function normalizeUser(value) {
  if (!value || typeof value !== "object") return null;
  const user = {};
  for (const key of ["userId", "email", "name", "method", "sub", "picture", "sid"]) {
    const text = String(value[key] || "").trim();
    if (text) user[key] = text.slice(0, key === "picture" ? 500 : 200);
  }
  return user.userId || user.email || user.sub ? user : null;
}

function sign(secret, payload) {
  return crypto.createHmac("sha256", String(secret)).update(payload).digest("base64url");
}

function sameText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
