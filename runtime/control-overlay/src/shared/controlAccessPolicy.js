import { ROUTES } from "./platform.js";
import { isAllowedRequestOrigin } from "./securityPolicy.js";

const USER_PROTECTED_EXACT_PATHS = new Set([
  ROUTES.api.jobs,
  ROUTES.api.jobQueue,
  ROUTES.api.freeExecutor,
  ROUTES.api.authSessionToken,
  ROUTES.api.authSessionHandoffComplete,
  ROUTES.api.passkeyRegisterOptions,
  ROUTES.api.passkeyRegisterVerify,
  ROUTES.api.terminalRun,
  ROUTES.api.mausRun,
  ROUTES.api.fileRead,
  ROUTES.api.fileWrite,
  ROUTES.api.gitStatus,
  ROUTES.api.gitCommit,
  ROUTES.api.storagePresign,
  ROUTES.api.saladStatus,
  ROUTES.api.trainingConsent,
  ROUTES.api.trainingConsentDecision,
  ROUTES.api.trainingConsentRevoke
]);

const USER_PROTECTED_MUTATIONS = new Set([
  ROUTES.api.saladCreate,
  ROUTES.api.saladStart,
  ROUTES.api.saladStop
]);

export function requiresAuthenticatedControlAccess(req, url) {
  const method = String(req?.method || "GET").toUpperCase();
  const pathname = String(url?.pathname || "");
  const workerCallback = method === "POST"
    && pathname.startsWith(`${ROUTES.api.jobs}/`)
    && pathname.endsWith("/status");
  if (workerCallback) return false;
  if (USER_PROTECTED_EXACT_PATHS.has(pathname)) return true;
  if (pathname.startsWith(`${ROUTES.api.jobs}/`)) return true;
  return method === "POST" && USER_PROTECTED_MUTATIONS.has(pathname);
}

export function isSafeMutatingControlRequest(req, url) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(String(req?.method || "").toUpperCase())) return true;
  const origin = String(req?.headers?.origin || "");
  const host = safeHost(req?.headers?.host);
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const selfOrigins = host
    ? forwardedProto === "http" || forwardedProto === "https"
      ? [`${forwardedProto}://${host}`]
      : [`https://${host}`, `http://${host}`]
    : [];
  const allowed = [...selfOrigins, "https://smejj.com", "https://www.smejj.com"];
  if (url?.pathname === ROUTES.api.authGoogle) allowed.push("https://accounts.google.com");
  return isAllowedRequestOrigin(origin, allowed);
}

function safeHost(value) {
  const host = String(value || "").trim().toLowerCase();
  return /^[a-z0-9.-]+(?::\d{1,5})?$/.test(host) ? host : "";
}
