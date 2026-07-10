// smejj.com — Passkey/WebAuthn-Routen (Single Responsibility: 4 Zeremonie-Endpunkte).
// register/options, register/verify, login/options, login/verify.
// Kein Klartext-Passwort, nur oeffentliche Schluessel. Challenge liegt signiert im
// Cookie (stateless). Bei Erfolg wird die bestehende smejj_session gesetzt.
import crypto from "node:crypto";
import { json, readJson } from "../http/respond.js";
import { allowedOriginsFromEnv } from "../http/cors.js";
import { bufferToBase64Url } from "../auth/webauthn/encoding.js";
import { verifyAuthentication, verifyRegistration } from "../auth/webauthn/ceremony.js";
import { createChallenge, signChallengeToken, verifyChallengeToken } from "../auth/webauthn/challenge.js";
import { findCredential, listCredentials, saveCredential, updateSignCount } from "../auth/passkeyStore.js";

const PUBKEY_PARAMS = [
  { type: "public-key", alg: -7 },   // ES256 (Face ID/Touch ID/Passkeys)
  { type: "public-key", alg: -257 }  // RS256 (Fallback)
];

function passkeyConfig(env) {
  return {
    rpId: env.SMEJJ_PASSKEY_RP_ID || "smejj.com",
    rpName: env.SMEJJ_PASSKEY_RP_NAME || "smejj.com",
    allowedOrigins: allowedOriginsFromEnv(env),
    secret: String(env.SMEJJ_SESSION_SECRET || env.GOOGLE_SESSION_SECRET || "").trim(),
    secure: env.SMEJJ_PASSKEY_INSECURE_COOKIE !== "true"
  };
}

function userIdFor(email, name) {
  const seed = String(email || name || "").trim().toLowerCase();
  if (seed) return `u_${crypto.createHash("sha256").update(seed).digest("base64url").slice(0, 24)}`;
  return `u_${crypto.randomBytes(16).toString("base64url")}`;
}

// POST /api/auth/passkey/register/options
export async function handlePasskeyRegisterOptions(req, res, { env = process.env } = {}) {
  const cfg = passkeyConfig(env);
  if (!cfg.secret) return json(res, 503, { error: "Session Secret fehlt." });
  const principal = registrationPrincipal(req.authUser);
  if (!principal) return json(res, 401, { error: "authentication_required" });
  await readJson(req).catch(() => ({}));
  const { email, displayName, userId } = principal;
  const challenge = createChallenge();
  const existing = await listCredentials(userId, env).catch(() => []);

  const challengeToken = signChallengeToken({ secret: cfg.secret, challenge, type: "reg", userId });
  return json(res, 200, {
    challenge,
    challengeToken,
    rp: { id: cfg.rpId, name: cfg.rpName },
    user: { id: bufferToBase64Url(Buffer.from(userId, "utf8")), name: email || displayName, displayName },
    pubKeyCredParams: PUBKEY_PARAMS,
    timeout: 120000,
    attestation: "none",
    authenticatorSelection: { residentKey: "preferred", requireResidentKey: false, userVerification: "preferred" },
    excludeCredentials: existing.map((c) => ({ type: "public-key", id: c.credentialId }))
  });
}

// POST /api/auth/passkey/register/verify
export async function handlePasskeyRegisterVerify(req, res, { env = process.env, makeSessionCookie, makeAccessToken } = {}) {
  const cfg = passkeyConfig(env);
  if (!cfg.secret) return json(res, 503, { error: "Session Secret fehlt." });
  const principal = registrationPrincipal(req.authUser);
  if (!principal) return json(res, 401, { error: "authentication_required" });
  const body = await readJson(req).catch(() => ({}));
  let challengeData;
  try {
    challengeData = verifyChallengeToken({ secret: cfg.secret, token: body.challengeToken, expectedType: "reg" });
  } catch (error) {
    return json(res, 400, { error: `Challenge ungueltig: ${error.message}` });
  }
  if (challengeData.userId !== principal.userId) return json(res, 403, { error: "passkey_registration_identity_mismatch" });
  const response = body.response || {};
  let credential;
  try {
    credential = verifyRegistration({
      attestationObject: response.attestationObject,
      clientDataJSON: response.clientDataJSON,
      expectedChallenge: challengeData.challenge,
      allowedOrigins: cfg.allowedOrigins,
      expectedRpId: cfg.rpId
    });
  } catch (error) {
    return json(res, 400, { error: `Registrierung ungueltig: ${error.message}` });
  }

  const userId = principal.userId;
  await saveCredential(userId, credential, { displayName: principal.displayName, label: body.label || "Passkey" }, env);

  const user = { userId, name: principal.displayName, email: principal.email, method: "passkey" };
  finishAuthenticated(res, user, makeSessionCookie, makeAccessToken);
}

// POST /api/auth/passkey/login/options
export async function handlePasskeyLoginOptions(req, res, { env = process.env } = {}) {
  const cfg = passkeyConfig(env);
  if (!cfg.secret) return json(res, 503, { error: "Session Secret fehlt." });
  const body = await readJson(req).catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  const userId = email ? userIdFor(email) : "";
  const allowCredentials = userId
    ? (await listCredentials(userId, env).catch(() => [])).map((c) => ({ type: "public-key", id: c.credentialId }))
    : [];
  const challenge = createChallenge();
  const challengeToken = signChallengeToken({ secret: cfg.secret, challenge, type: "auth", userId });
  return json(res, 200, {
    challenge,
    challengeToken,
    rpId: cfg.rpId,
    timeout: 120000,
    userVerification: "preferred",
    allowCredentials
  });
}

// POST /api/auth/passkey/login/verify
export async function handlePasskeyLoginVerify(req, res, { env = process.env, makeSessionCookie, makeAccessToken } = {}) {
  const cfg = passkeyConfig(env);
  if (!cfg.secret) return json(res, 503, { error: "Session Secret fehlt." });
  const body = await readJson(req).catch(() => ({}));
  let challengeData;
  try {
    challengeData = verifyChallengeToken({ secret: cfg.secret, token: body.challengeToken, expectedType: "auth" });
  } catch (error) {
    return json(res, 400, { error: `Challenge ungueltig: ${error.message}` });
  }
  const response = body.response || {};
  // userHandle (base64url) -> userId-String; sonst userId aus der Challenge.
  const userId = response.userHandle
    ? Buffer.from(String(response.userHandle), "base64url").toString("utf8")
    : challengeData.userId;
  if (!userId) return json(res, 400, { error: "Kein Nutzer fuer diese Anmeldung ermittelbar." });

  const credentialId = String(body.id || body.rawId || "");
  const credential = await findCredential(userId, credentialId, env);
  if (!credential) return json(res, 404, { error: "Passkey nicht gefunden." });

  let result;
  try {
    result = verifyAuthentication({
      credential,
      authenticatorData: response.authenticatorData,
      clientDataJSON: response.clientDataJSON,
      signature: response.signature,
      expectedChallenge: challengeData.challenge,
      allowedOrigins: cfg.allowedOrigins,
      expectedRpId: cfg.rpId
    });
  } catch (error) {
    return json(res, 400, { error: `Anmeldung ungueltig: ${error.message}` });
  }
  await updateSignCount(userId, credentialId, result.newSignCount, env);

  const user = { userId, name: "Passkey Nutzer", method: "passkey" };
  finishAuthenticated(res, user, makeSessionCookie, makeAccessToken);
}

// Erfolgreiche Anmeldung: optional smejj_session als Cookie (best-effort, funktioniert
// same-origin), plus {authenticated,user} im Body — der Client speichert den Zustand
// wie beim Google-Login lokal.
function finishAuthenticated(res, user, makeSessionCookie, makeAccessToken) {
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (typeof makeSessionCookie === "function") headers["Set-Cookie"] = makeSessionCookie(user);
  res.writeHead(200, headers);
  res.end(JSON.stringify({ ok: true, authenticated: true, user, accessToken: typeof makeAccessToken === "function" ? makeAccessToken(user) : undefined }, null, 2));
}

function registrationPrincipal(value) {
  if (!value || typeof value !== "object") return null;
  const email = String(value.email || "").trim().toLowerCase();
  const displayName = String(value.name || email || "smejj.com Nutzer").slice(0, 120);
  const existingUserId = String(value.userId || "").trim();
  const userId = existingUserId || userIdFor(email, value.sub || displayName);
  if (!/^u_[a-zA-Z0-9_-]{8,80}$/.test(userId)) return null;
  return { email, displayName, userId };
}
