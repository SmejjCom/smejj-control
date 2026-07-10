import { ROUTES } from "./platform.js";

const USER_PROTECTED_EXACT_PATHS = new Set([
  ROUTES.api.jobs,
  ROUTES.api.jobQueue,
  ROUTES.api.freeExecutor,
  ROUTES.api.passkeyRegisterOptions,
  ROUTES.api.passkeyRegisterVerify,
  ROUTES.api.terminalRun,
  ROUTES.api.fileRead,
  ROUTES.api.fileWrite,
  ROUTES.api.gitStatus,
  ROUTES.api.gitCommit,
  ROUTES.api.storagePresign
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
