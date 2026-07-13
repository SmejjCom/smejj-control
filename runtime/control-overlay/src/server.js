import http from "node:http";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { APP_INFO, CAPABILITIES, COST_POLICY, ROUTES, SECURITY_HEADERS, STORAGE } from "./shared/platform.js";
import { SECURITY_LIMITS } from "./shared/securityPolicy.js";
import { json, readJson } from "../control-server/src/http/respond.js";
import { parseS3Keys, signedS3List } from "../control-server/src/storage/s3Signer.js";
import {
  handleApproveJob,
  handleAutonomousRun,
  handleCancelJob,
  handleCreateJob,
  handleFreeExecutor,
  handleJobEvents,
  handleJobQueue,
  handleJobStatus,
  handleListJobs,
  handleWorkerStatusUpdate
} from "../control-server/src/routes/jobRoutes.js";
import { handleSaladCreate, handleSaladGpuClasses, handleSaladPlan, handleSaladStart, handleSaladStatus, handleSaladStop } from "../control-server/src/routes/saladRoutes.js";
import { recoverWorkerRuntimeOnStartup } from "../control-server/src/orchestrator/startupRecovery.js";
import { handleStoragePresign } from "../control-server/src/routes/storagePresignRoutes.js";
import { handleBrowserFetch } from "../control-server/src/routes/browserProxyRoutes.js";
import { handleBrowserRemote } from "../control-server/src/routes/browserRemoteRoutes.js";
import { handlePasskeyLoginOptions, handlePasskeyLoginVerify, handlePasskeyRegisterOptions, handlePasskeyRegisterVerify } from "../control-server/src/routes/passkeyRoutes.js";
import { handleModelStatus, handleModelsStatus, handleWorkerPreflight } from "../control-server/src/routes/modelRoutes.js";
import { handleWorkerModelAction, handleWorkerValidate } from "../control-server/src/routes/workerModelRoutes.js";
import { refreshModelRuntimeHealth } from "../control-server/src/llm/modelRuntimeHealth.js";
import { buildRagContextBlock, searchKnowledge } from "../control-server/src/rag/agentContext.js";
import { buildWebContextBlock, searchWeb, shouldSearchWeb } from "./search/webSearch.js";
import { createRateLimiter } from "./shared/rateLimiter.js";
import { classifyProfile, executeWithFallback, resolveModelRequest } from "../control-server/src/llm/modelRouter.js";
import { evaluateAiAvailability } from "../control-server/src/llm/aiAvailability.js";
import { pipeVisibleModelStream } from "../control-server/src/llm/streamFilter.js";
import { allowedOriginsFromEnv, corsHeadersFor, handlePreflight } from "../control-server/src/http/cors.js";
import { installCrashGuard } from "../control-server/src/http/crashGuard.js";
import { createStaticHandlers } from "./http/staticServing.js";
import { loadSecureLocalEnv, normalizeSecret } from "./shared/env.js";
import { resolveTerminalCommand } from "./shared/terminalPolicy.js";
import { isSafeMutatingControlRequest, requiresAuthenticatedControlAccess } from "./shared/controlAccessPolicy.js";
import { createPublicModelRateGate } from "./shared/modelRatePolicy.js";
import { bearerSessionToken, issueSessionToken, verifySessionToken } from "../control-server/src/auth/sessionToken.js";
import { createSessionHandoffStore, isSessionHandoffId } from "../control-server/src/auth/sessionHandoff.js";
import { handleTrainingConsentRoute } from "../control-server/src/routes/trainingConsentRoutes.js";
import { signGoogleAuthState, verifyGoogleAuthState, verifyGoogleIdToken } from "./auth/googleAuth.js";

installCrashGuard(); // kein stiller Tod: unbehandelte Fehler -> Log mit Stack + Exit 1 (Probes uebernehmen)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");
const storageSourceDir = path.resolve(__dirname, "storage");
const aiSourceDir = path.resolve(__dirname, "ai");
const sharedSourceDir = path.resolve(__dirname, "shared");
const { isAppRoute, isPublicAsset, serveAiModule, serveFile, serveSharedModule, serveStorageModule } = createStaticHandlers({
  publicDir,
  storageSourceDir,
  aiSourceDir,
  sharedSourceDir
});

loadSecureLocalEnv();

const config = {
  port: Number(process.env.PORT || 3000),
  projectRoot: path.resolve(process.env.PROJECT_ROOT || process.cwd()),
  baseUrl: (process.env.SMEJJ_LLM_BASE_URL || process.env.OPENAI_COMPATIBLE_BASE_URL || process.env.OPENAI_BASE_URL || process.env.BRIRT_LLM_BASE_URL || "").replace(/\/$/, ""),
  apiKey: process.env.SMEJJ_LLM_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || process.env.OPENAI_API_KEY || process.env.BRIRT_LLM_API_KEY || "",
  model: process.env.SMEJJ_LLM_MODEL || process.env.OPENAI_COMPATIBLE_MODEL || process.env.OPENAI_MODEL || process.env.BRIRT_LLM_MODEL || "",
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleAllowedEmail: (process.env.GOOGLE_ALLOWED_EMAIL || "smejjcom@gmail.com").toLowerCase(),
  sessionSecret: normalizeSecret(process.env.SMEJJ_SESSION_SECRET || process.env.GOOGLE_SESSION_SECRET || "")
};

const forbiddenSegments = new Set([".env", ".git", "node_modules", "dist", "build"]);
const publicModelRateGate = createPublicModelRateGate(process.env);
const sessionHandoffStore = createSessionHandoffStore();
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      if (handlePreflight(req, res)) return; // OPTIONS-Preflight (204 erlaubt / 403 fremd)
      const cors = corsHeadersFor(req.headers.origin);
      if (cors) for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);
    }
    if (!isSafeMutatingControlRequest(req, url)) return json(res, 403, { error: "Origin not allowed" });
    if (requiresAuthenticatedControlAccess(req, url)) {
      res.setHeader("Cache-Control", "private, no-store");
      const authenticatedUser = readSession(req);
      if (!authenticatedUser) return json(res, 401, { ok: false, error: "authentication_required" });
      req.authUser = authenticatedUser;
    }
    const readMethod = req.method === "GET" || req.method === "HEAD";
    if (readMethod && url.pathname === ROUTES.root) return serveFile(res, "index.html");
    if (readMethod && (url.pathname === "/auth/login" || url.pathname === "/auth/login/")) return serveFile(res, "auth/login/index.html");
    if (readMethod && (url.pathname === "/auth/register" || url.pathname === "/auth/register/")) return serveFile(res, "auth/register/index.html");
    if (readMethod && url.pathname.startsWith("/assets/storage/")) return serveStorageModule(res, url.pathname.replace("/assets/storage/", ""));
    if (readMethod && url.pathname.startsWith("/assets/ai/")) return serveAiModule(res, url.pathname.replace("/assets/ai/", ""));
    if (readMethod && url.pathname.startsWith("/assets/shared/")) return serveSharedModule(res, url.pathname.replace("/assets/shared/", ""));
    if (readMethod && url.pathname.startsWith("/assets/")) return serveFile(res, url.pathname.replace("/assets/", ""));
    if (readMethod && isPublicAsset(url.pathname)) return serveFile(res, url.pathname.slice(1));
    if (readMethod && url.pathname === "/impressum") return serveFile(res, "impressum.html");
    if (readMethod && url.pathname === "/datenschutz") return serveFile(res, "datenschutz.html");
    if (readMethod && url.pathname === ROUTES.api.health) return handleHealth(res);
    if (readMethod && url.pathname === ROUTES.api.capabilities) return handleCapabilities(res);
    if (readMethod && url.pathname === ROUTES.api.authConfig) return handleAuthConfig(res);
    if (readMethod && url.pathname === ROUTES.api.authMe) return handleAuthMe(req, res);
    if (readMethod && url.pathname === ROUTES.api.authSessionToken) return handleAuthSessionToken(req, res);
    if (req.method === "POST" && url.pathname === ROUTES.api.authSessionHandoffStart) return await handleSessionHandoffStart(req, res);
    if (["GET", "POST"].includes(req.method) && url.pathname === ROUTES.api.authSessionHandoffComplete) return await handleSessionHandoffComplete(req, url, res);
    if (readMethod && url.pathname.startsWith(`${ROUTES.api.authSessionHandoff}/`)) return handleSessionHandoffPoll(req, url, res);
    if (readMethod && url.pathname === ROUTES.api.authGoogle) {
      try {
        return await handleGoogleAuthStart(req, res, url);
      } catch (error) {
        return json(res, 400, { error: error.message || "Google Login konnte nicht gestartet werden." });
      }
    }
    if (req.method === "POST" && url.pathname === ROUTES.api.authGoogle) {
      try {
        return await handleGoogleAuth(req, res);
      } catch (error) {
        return json(res, 400, { error: error.message || "Google Login fehlgeschlagen." });
      }
    }
    if (req.method === "POST" && url.pathname === ROUTES.api.authLogout) return handleAuthLogout(res);
    if (req.method === "POST" && url.pathname === ROUTES.api.passkeyRegisterOptions) return await handlePasskeyRegisterOptions(req, res, { env: process.env });
    if (req.method === "POST" && url.pathname === ROUTES.api.passkeyRegisterVerify) return await handlePasskeyRegisterVerify(req, res, { env: process.env, makeSessionCookie: serializeSessionCookie, makeAccessToken: serializeSessionToken });
    if (req.method === "POST" && url.pathname === ROUTES.api.passkeyLoginOptions) return await handlePasskeyLoginOptions(req, res, { env: process.env });
    if (req.method === "POST" && url.pathname === ROUTES.api.passkeyLoginVerify) return await handlePasskeyLoginVerify(req, res, { env: process.env, makeSessionCookie: serializeSessionCookie, makeAccessToken: serializeSessionToken });
    if (readMethod && url.pathname === ROUTES.api.ragSearch) return await handleRagSearch(url, res);
    if (readMethod && url.pathname === ROUTES.api.webSearch) return await handleWebSearch(req, url, res);
    if (readMethod && url.pathname === ROUTES.api.browserFetch) return await handleBrowserFetch(url, res, { req });
    if (readMethod && url.pathname === ROUTES.api.browserRemote) return await handleBrowserRemote(url, res, { req });
    if (req.method === "POST" && url.pathname === ROUTES.api.chat) {
      if (!allowPublicModelRequest(req, res)) return;
      return await handleChat(req, res);
    }
    if (req.method === "POST" && url.pathname === ROUTES.api.agent) {
      if (!allowPublicModelRequest(req, res)) return;
      return await handleAgent(req, res);
    }
    if (req.method === "POST" && url.pathname === ROUTES.api.fileRead) return await handleRead(req, res);
    if (req.method === "POST" && url.pathname === ROUTES.api.fileWrite) return await handleWrite(req, res);
    if (req.method === "POST" && url.pathname === ROUTES.api.terminalRun) return await handleTerminal(req, res);
    if (readMethod && url.pathname === ROUTES.api.gitStatus) return handleGitStatus(res);
    if (req.method === "POST" && url.pathname === ROUTES.api.gitCommit) return await handleGitCommit(req, res);
    if (req.method === "POST" && url.pathname === ROUTES.api.storagePresign) return await handleStoragePresign(req, res);
    if (readMethod && url.pathname === ROUTES.api.storageStatus) return await handleStorageStatus(res);
    if (url.pathname.startsWith(ROUTES.api.trainingConsent)) return await handleTrainingConsentRoute(req, url, res);
    if (readMethod && url.pathname === ROUTES.api.modelStatus) return await handleModelStatus(res, "kimi-k2-7");
    if (readMethod && url.pathname === ROUTES.api.glmModelStatus) return await handleModelStatus(res, "glm-5-2");
    if (readMethod && url.pathname === ROUTES.api.modelsStatus) return await handleModelsStatus(res);
    if (readMethod && url.pathname === ROUTES.api.workerPreflight) return await handleWorkerPreflight(url, res);
    if (req.method === "POST" && url.pathname === ROUTES.api.workerValidate) return await handleWorkerValidate(req, res);
    if (req.method === "POST" && url.pathname === ROUTES.api.workerModelAction) return await handleWorkerModelAction(req, res);

    if (readMethod && url.pathname === ROUTES.api.saladPlan) return handleSaladPlan(res);
    if (readMethod && url.pathname === ROUTES.api.saladStatus) return await handleSaladStatus(res);
    if (readMethod && url.pathname === ROUTES.api.saladGpuClasses) return await handleSaladGpuClasses(res);
    if (req.method === "POST" && url.pathname === ROUTES.api.saladCreate) return await handleSaladCreate(res);
    if (req.method === "POST" && url.pathname === ROUTES.api.saladStart) return await handleSaladStart(res);
    if (req.method === "POST" && url.pathname === ROUTES.api.saladStop) return await handleSaladStop(res);
    if (req.method === "POST" && url.pathname === ROUTES.api.jobs) return await handleCreateJob(req, res);
    if (readMethod && url.pathname === ROUTES.api.jobs) return await handleListJobs(url, res, { authUser: req.authUser });
    if (readMethod && url.pathname === ROUTES.api.jobQueue) return handleJobQueue(res, { authUser: req.authUser });
    if (req.method === "POST" && url.pathname === ROUTES.api.freeExecutor) return await handleFreeExecutor(req, res);
    if (req.method === "POST" && url.pathname.startsWith(`${ROUTES.api.jobs}/`) && url.pathname.endsWith("/status")) return await handleWorkerStatusUpdate(url, req, res);
    if (req.method === "POST" && url.pathname.startsWith(`${ROUTES.api.jobs}/`) && url.pathname.endsWith("/cancel")) return await handleCancelJob(url, req, res);
    if (req.method === "POST" && url.pathname.startsWith(`${ROUTES.api.jobs}/`) && url.pathname.endsWith("/approve")) return await handleApproveJob(url, req, res);
    if (req.method === "POST" && url.pathname.startsWith(`${ROUTES.api.jobs}/`) && url.pathname.endsWith("/autonomous-run")) return await handleAutonomousRun(url, req, res);
    if (readMethod && url.pathname.startsWith(`${ROUTES.api.jobs}/`) && url.pathname.endsWith("/events")) return await handleJobEvents(url, req, res);
    if (readMethod && url.pathname.startsWith(`${ROUTES.api.jobs}/`)) return await handleJobStatus(url, res, { authUser: req.authUser });
    if (readMethod && isAppRoute(url.pathname)) return serveFile(res, "index.html");
    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, 500, { error: error.message || "Internal error" });
  }
});

// HOST bleibt lokal 127.0.0.1 (sicher); Container/Salad setzen SMEJJ_HOST=0.0.0.0.
const listenHost = process.env.SMEJJ_HOST || "127.0.0.1";
await recoverWorkerRuntimeOnStartup({ env: process.env });
server.listen(config.port, listenHost, () => {
  console.log(`smejj.com Code MVP: http://${listenHost}:${config.port}`);
  console.log(`Sandbox: ${config.projectRoot}`);
});

// RAG: semantische Suche (BM25) ueber das Projektwissen. Nur lesend, Cache im agentContext-Modul.
async function handleRagSearch(url, res) {
  const query = String(url.searchParams.get("q") || "").trim();
  if (!query) return json(res, 400, { ok: false, error: "Missing query parameter q" });
  const hits = await searchKnowledge(config.projectRoot, query, Number(url.searchParams.get("k") || 5));
  return json(res, 200, { ok: true, query, hits });
}

async function handleChat(req, res) {
  const body = await readJson(req);
  const messages = Array.isArray(body.messages) ? body.messages : [{ role: "user", content: String(body.message || "") }];
  return streamLLM(res, messages, { requestedModel: body.model });
}

async function handleHealth(res) {
  // ai spiegelt den echten Router-Zustand: Gate + Budget + Provider-Kette (fail-closed).
  await refreshModelRuntimeHealth(process.env);
  const aiStatus = evaluateAiAvailability(process.env);
  json(res, 200, {
    ok: true,
    app: APP_INFO.name,
    costPolicy: COST_POLICY,
    ai: aiStatus.ai,
    aiBackend: aiStatus.aiBackend,
    activeModelId: aiStatus.activeModelId,
    modelRegistry: aiStatus.registry,
    storage: Boolean(process.env.IDRIVE_E2_ENDPOINT && process.env.IDRIVE_E2_ACCESS_KEY && process.env.IDRIVE_E2_SECRET_KEY && process.env.IDRIVE_E2_BUCKET)
  });
}

async function handleCapabilities(res) {
  json(res, 200, {
    ok: true,
    app: APP_INFO.name,
    costPolicy: COST_POLICY,
    capabilities: CAPABILITIES
  });
}

function handleAuthConfig(res) {
  json(res, 200, {
    configured: Boolean(config.googleClientId),
    clientId: config.googleClientId,
    allowedEmail: config.googleAllowedEmail
  });
}

function handleAuthMe(req, res) {
  const user = readSession(req);
  json(res, 200, { authenticated: Boolean(user), user });
}

function handleAuthSessionToken(req, res) {
  const user = readSession(req);
  if (!user) return json(res, 401, { authenticated: false, error: "authentication_required" });
  return json(res, 200, {
    authenticated: true,
    user,
    accessToken: serializeSessionToken(user),
    tokenStorage: "session-only"
  });
}

async function handleSessionHandoffStart(req, res) {
  const origin = requestOrigin(req);
  const body = await readJson(req);
  const returnOrigin = String(body.returnOrigin || "").replace(/\/$/, "");
  if (!allowedOriginsFromEnv(process.env).includes(origin) || returnOrigin !== origin) {
    return noStoreJson(res, 403, { ok: false, error: "session_handoff_origin_not_allowed" });
  }
  const result = sessionHandoffStore.start(returnOrigin);
  return noStoreJson(res, result.status, result);
}

async function handleSessionHandoffComplete(req, url, res) {
  const handoffId = req.method === "GET"
    ? url.searchParams.get("handoffId")
    : (await readJson(req)).handoffId;
  const result = sessionHandoffStore.complete(handoffId, {
    token: serializeSessionToken(req.authUser),
    user: req.authUser
  });
  if (req.method === "GET" && result.ok) {
    res.writeHead(303, {
      ...SECURITY_HEADERS,
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      Location: "/profile?session-handoff-complete=1"
    });
    return res.end();
  }
  return noStoreJson(res, result.status, result.ok
    ? { ok: true, state: "completed", expiresAt: result.expiresAt }
    : result);
}

function handleSessionHandoffPoll(req, url, res) {
  const handoffId = decodeURIComponent(url.pathname.slice(`${ROUTES.api.authSessionHandoff}/`.length));
  if (!isSessionHandoffId(handoffId)) return noStoreJson(res, 404, { ok: false, error: "session_handoff_not_found" });
  const result = sessionHandoffStore.consume(handoffId, requestOrigin(req));
  return noStoreJson(res, result.status, result);
}

function noStoreJson(res, status, payload) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  return json(res, status, payload);
}

function requestOrigin(req) {
  return String(req.headers.origin || "").trim().replace(/\/$/, "");
}

async function handleGoogleAuth(req, res) {
  if (!config.googleClientId) return json(res, 503, { error: "Google Login ist noch nicht konfiguriert." });
  if (!config.sessionSecret) return json(res, 503, { error: "Session Secret fehlt." });
  const body = await readAuthBody(req);
  const state = body.state ? verifyGoogleAuthState(String(body.state), config.sessionSecret) : null;
  const payload = await verifyGoogleIdToken(String(body.credential || body.idToken || ""), {
    clientId: config.googleClientId,
    expectedNonce: state?.nonce
  });
  const email = String(payload.email || "").toLowerCase();
  if (!payload.email_verified) return json(res, 403, { error: "Google E-Mail ist nicht verifiziert." });
  if (config.googleAllowedEmail && email !== config.googleAllowedEmail) {
    return json(res, 403, { error: "Dieses Google Konto ist fuer smejj.com nicht freigegeben." });
  }
  const user = {
    email,
    name: String(payload.name || email),
    picture: String(payload.picture || ""),
    sub: String(payload.sub || "")
  };
  const headers = {
    ...SECURITY_HEADERS,
    "Set-Cookie": serializeSessionCookie(user)
  };
  if (body.redirect) {
    res.writeHead(303, { ...headers, Location: state?.returnTo || "/profile?google=ok" });
    return res.end();
  }
  res.writeHead(200, { ...headers, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ authenticated: true, user, accessToken: serializeSessionToken(user) }, null, 2));
}

async function handleGoogleAuthStart(req, res, url) {
  if (!config.googleClientId) return json(res, 503, { error: "Google Login ist noch nicht konfiguriert." });
  if (!config.sessionSecret) return json(res, 503, { error: "Session Secret fehlt." });
  const proto = req.headers["x-forwarded-proto"] || (url.hostname === "localhost" ? "http" : "https");
  const origin = `${proto}://${req.headers.host}`;
  const nonce = crypto.randomBytes(18).toString("base64url");
  const state = signGoogleAuthState({
    nonce,
    returnTo: "/profile?google=ok",
    exp: Date.now() + 10 * 60 * 1000
  }, config.sessionSecret);
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", config.googleClientId);
  authUrl.searchParams.set("redirect_uri", `${origin}${ROUTES.api.authGoogle}`);
  authUrl.searchParams.set("response_type", "id_token");
  authUrl.searchParams.set("response_mode", "form_post");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "select_account");
  authUrl.searchParams.set("login_hint", config.googleAllowedEmail);
  res.writeHead(303, { ...SECURITY_HEADERS, Location: authUrl.toString() });
  res.end();
}

function handleAuthLogout(res) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": "smejj_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  });
  res.end(JSON.stringify({ authenticated: false }, null, 2));
}

// Rate-Limit fuer die offene Websuche: 20 Anfragen / 60s pro IP (free-safe, in-memory).
const webSearchRateLimiter = createRateLimiter({ windowMs: 60000, max: 20 });

function allowPublicModelRequest(req, res) {
  const gate = publicModelRateGate.check(req);
  if (gate.allowed) return true;
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil(gate.retryAfterMs / 1_000))));
  res.setHeader("Access-Control-Expose-Headers", "x-smejj-model-backend, Retry-After");
  json(res, 429, { error: "public_ai_rate_limit_reached" });
  return false;
}

function clientIpFrom(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

// Live-Internet-Suche als eigener Endpunkt (GET /api/search/web?q=...). Free-only,
// fail-closed: Fehler liefern eine leere Ergebnisliste, niemals Kosten oder Abbruch.
async function handleWebSearch(req, url, res) {
  const gate = webSearchRateLimiter.check(clientIpFrom(req));
  if (!gate.allowed) {
    res.setHeader("Retry-After", String(Math.ceil(gate.retryAfterMs / 1000)));
    res.setHeader("Access-Control-Expose-Headers", "Retry-After");
    return json(res, 429, { error: "Zu viele Suchanfragen. Bitte kurz warten." });
  }
  const query = String(url.searchParams.get("q") || "").trim();
  if (!query) return json(res, 400, { error: "Missing q" });
  const results = await searchWeb(query, { limit: 8 });
  return json(res, 200, { ok: true, query, count: results.length, results });
}

// Erkennt echte Coding-Aufgaben (nur dann Code-Agent-Modus mit Plan/Diff).
// Alles andere gilt als Wissens-/Aktualitaetsfrage und wird live im Internet recherchiert.
function isCodingTask(task) {
  const t = String(task || "");
  if (/```/.test(t)) return true;
  if (/\b(refactor|debug|stack ?trace|compile|dockerfile|commit|deploy|npm |pnpm |yarn |git )\b/i.test(t)) return true;
  if (/\b(schreib\w*|erstell\w*|implementier\w*|programmier\w*|cod\w*|bau\w*|fix\w*|beheb\w*)\b/i.test(t)
      && /\b(funktion|function|klasse|class|script|komponente|component|endpoint|modul|module|css|html|javascript|typescript|python|react|node|bug|fehler|datei|file|repo)\b/i.test(t)) return true;
  return false;
}

async function handleAgent(req, res) {
  const body = await readJson(req);
  const task = String(body.task || "").trim();
  const files = Array.isArray(body.files) ? body.files.slice(0, 8) : [];
  if (!task) return json(res, 400, { error: "Missing task" });

  const fileBlocks = [];
  for (const file of files) {
    const safePath = safeResolve(file);
    const content = await readLimited(safePath, 120_000);
    fileBlocks.push(`--- ${file} ---\n${content}`);
  }

  // Coding-Aufgabe -> Code-Agent. Sonst Wissens-/Aktualitaetsfrage -> Live-Websuche.
  const codingTask = fileBlocks.length > 0 || isCodingTask(task);
  const webContext = (!codingTask && shouldSearchWeb(task))
    ? await buildWebContextBlock(task, { maxResults: 6, withPages: 2 })
    : "";
  // Projektwissen (RAG) ergaenzt, ersetzt aber nie die Live-Suche.
  const ragContext = await buildRagContextBlock(config.projectRoot, task, 3);

  let systemLines;
  if (codingTask) {
    systemLines = [
      "You are smejj.com Code Agent.",
      "Return a concise plan and unified diff suggestions only.",
      "Do not claim that files were changed.",
      "Dangerous terminal, git, network, secrets, and deletion actions require user approval."
    ];
  } else if (webContext) {
    systemLines = [
      "Du bist der Assistent von smejj.com mit Live-Internet-Suchergebnissen.",
      "Beantworte die Frage direkt, korrekt und kompakt in der Sprache des Nutzers.",
      "Nutze VORRANGIG die Live-Internet-Ergebnisse unten und fasse die relevanten Infos zusammen.",
      "Fasse in EIGENEN WORTEN und klaren, vollstaendigen Saetzen zusammen; gib NIEMALS rohen Seitentext, Code-, JSON- oder Markup-Fragmente wieder.",
      "Beispiel: aus der Kontext-Zeile 'Bitcoin 54.792 -0,7% Euro' antwortest du 'Ein Bitcoin kostet aktuell rund 54.792 Euro.' - kopiere niemals ganze Ticker-, Snippet- oder Menue-Zeilen.",
      "Nenne am Ende die genutzte(n) Quelle(n) als URL samt Abrufzeit (Stand).",
      "Wenn die Ergebnisse die Antwort nicht enthalten, sage das ehrlich und nenne, was du gefunden hast; erfinde nichts."
    ];
  } else {
    systemLines = [
      "Du bist der Assistent von smejj.com.",
      "Beantworte die Frage hilfreich, korrekt und kompakt in der Sprache des Nutzers.",
      "Wenn dir fuer tagesaktuelle Fakten (Wetter, News, Preise, Oeffnungszeiten) aktuelle Daten fehlen, sage das ehrlich statt zu raten."
    ];
  }
  systemLines.push(
    "Internes Projektwissen ist nur Hintergrund. Nenne interne Dateinamen, Pfade, Memory_Bank.md, Project_Goals.md oder docs/* niemals als oeffentliche Quelle, URL oder Markdown-Link."
  );

  const userParts = [`Frage/Aufgabe:\n${task}`];
  if (webContext) userParts.push(webContext);
  if (ragContext) userParts.push(ragContext);
  if (fileBlocks.length) userParts.push(`Dateien:\n${fileBlocks.join("\n\n")}`);

  const messages = [
    { role: "system", content: systemLines.join("\n") },
    { role: "user", content: userParts.join("\n\n") }
  ];
  // Profilwahl: Web-Fragen nutzen das Web-Zusammenfassungsprofil des Routers.
  const profile = webContext ? "web" : classifyProfile(task);
  return streamLLM(res, messages, { profile, requestedModel: body.model });
}

async function handleRead(req, res) {
  const body = await readJson(req);
  const safePath = safeResolve(body.path);
  const content = await readLimited(safePath, 250_000);
  json(res, 200, { path: path.relative(config.projectRoot, safePath), content });
}

async function handleWrite(req, res) {
  const body = await readJson(req);
  const safePath = safeResolve(body.path);
  const content = String(body.content || "");
  if (content.length > 500_000) return json(res, 413, { error: "File too large" });
  if (body.apply !== true) {
    return json(res, 200, {
      approved: false,
      message: "Preview only. Send apply:true after user review to write.",
      path: path.relative(config.projectRoot, safePath),
      proposedContent: content
    });
  }
  await mkdir(path.dirname(safePath), { recursive: true });
  await writeFile(safePath, content, "utf8");
  json(res, 200, { approved: true, path: path.relative(config.projectRoot, safePath) });
}

async function handleTerminal(req, res) {
  const body = await readJson(req);
  const command = String(body.command || "").trim();
  const resolved = resolveTerminalCommand(command);
  if (!resolved.ok) return json(res, 403, { error: "Command not allowed", reason: resolved.reason });
  const result = await run(resolved.bin, resolved.args, config.projectRoot, 30_000);
  json(res, 200, result);
}

async function handleGitStatus(res) {
  const result = await run("git", ["status", "--short"], config.projectRoot, 10_000);
  json(res, 200, result);
}

async function handleGitCommit(req, res) {
  const body = await readJson(req);
  const message = String(body.message || "").trim();
  if (!message) return json(res, 400, { error: "Missing commit message" });
  const result = await run("git", ["commit", "-am", message], config.projectRoot, 30_000);
  json(res, 200, result);
}

async function handleStorageStatus(res) {
  const endpoint = process.env.IDRIVE_E2_ENDPOINT;
  const accessKey = process.env.IDRIVE_E2_ACCESS_KEY;
  const secretKey = process.env.IDRIVE_E2_SECRET_KEY;
  const bucket = process.env.IDRIVE_E2_BUCKET;
  const region = process.env.IDRIVE_E2_REGION || "us-west-2";
  const prefix = process.env.MODEL_S3_PREFIX || STORAGE.defaultModelPrefix;
  if (!endpoint || !accessKey || !secretKey || !bucket) {
    return json(res, 200, {
      configured: false,
      ok: false,
      message: "IDrive e2 is not configured in local environment."
    });
  }

  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const { response, body } = await signedS3List({
    endpoint,
    region,
    accessKey,
    secretKey,
    bucket,
    prefix: normalizedPrefix
  });
  if (!response.ok) {
    return json(res, 502, {
      configured: true,
      ok: false,
      provider: STORAGE.provider,
      bucket,
      prefix: normalizedPrefix,
      status: response.status,
      message: body.slice(0, 300),
      storageRole: STORAGE.role
    });
  }
  const keys = parseS3Keys(body);
  json(res, 200, {
    configured: true,
    ok: true,
    provider: STORAGE.provider,
    bucket,
    prefix: normalizedPrefix,
    objectCount: keys.length,
    keys,
    storageRole: STORAGE.role
  });
}

async function streamLLM(res, messages, { profile = "default", requestedModel = "" } = {}) {
  if (process.env.SMEJJ_SERVER_AI_ENABLED !== "true") {
    return localAssistantStream(res, messages);
  }
  const remaining = Number(process.env.SMEJJ_SERVER_AI_REMAINING || 0);
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return json(res, 429, { error: "AI rate limit reached or unclear." });
  }
  const { chain, selection } = resolveModelRequest(profile, requestedModel, process.env);
  if (chain.length === 0) {
    return json(res, 400, {
      error: "AI mode disabled. No active model runtime or approved fallback is configured.",
      requestedModelId: selection.requestedModelId
    });
  }
  const result = await executeWithFallback(chain, messages, {
    temperature: 1.0,
    maxTokens: boundedInteger(process.env.SMEJJ_PUBLIC_MODEL_MAX_TOKENS, 512, 8_192, 4_096)
  });
  if (!result.ok || !result.response.body) {
    return json(res, 502, { error: "All model backends failed.", attempts: result.attempts });
  }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "x-smejj-model-backend": `${result.backend}:${result.model}`,
    "x-smejj-model-id": result.logicalModelId,
    "x-smejj-requested-model-id": selection.requestedModelId,
    "x-smejj-model-fallback": String(result.logicalModelId !== selection.requestedModelId)
  });
  await pipeVisibleModelStream(result.response.body, res);
  res.end();
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}

function localAssistantStream(res, messages) {
  const prompt = latestUserMessage(messages);
  const lower = prompt.toLowerCase();
  const wantsGreeting = /^(hi|hallo|hey|servus|moin)\b/i.test(prompt);
  const wantsCode = /\b(code|coding|programm|bug|fehler|test|datei|repo|patch|fix|build)\b/i.test(lower);
  const wantsModel = /\b(glm|kimi|idrive|salad|modell|model|ki|ai|gpu|compute)\b/i.test(lower);
  const reply = buildLocalAssistantReply({ prompt, wantsGreeting, wantsCode, wantsModel });
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function buildLocalAssistantReply({ prompt, wantsGreeting, wantsCode, wantsModel }) {
  if (!prompt) return "Ich bin da. Schreib mir, was ich fuer dich bauen, pruefen oder verbessern soll.";
  if (wantsGreeting) return "Hi, ich bin da. Was soll ich als Naechstes fuer dich bauen oder pruefen?";
  if (wantsCode) {
    return [
      "Verstanden. Ich behandle das als Coding-Aufgabe.",
      "Ich wuerde so vorgehen:",
      "1. Relevante Dateien gezielt lesen.",
      "2. Ursache finden, nicht blind umbauen.",
      "3. Kleine, messbare Aenderung machen.",
      "4. Danach genau den passenden Test laufen lassen.",
      "Sag mir die konkrete Datei, Fehlermeldung oder Aufgabe, dann gehe ich direkt rein."
    ].join("\n");
  }
  if (wantsModel) {
    return [
      "GLM-5.2 ist als IDrive-e2-Vault vorbereitet und bleibt der Hauptpfad fuer Coding und Planung.",
      "Salad/Compute startet nur mit expliziter Freigabe, damit keine GPU-Kosten unbemerkt loslaufen.",
      "Ich kann Architektur, Jobs, Storage, Worker-Planung und Tests hier weiter ausarbeiten."
    ].join("\n");
  }
  return [
    "Verstanden.",
    "Ich kann daraus eine konkrete Aufgabe machen, die Dateien pruefen, einen Plan schreiben oder direkt eine kleine Aenderung umsetzen.",
    "Schick mir den naechsten Schritt oder sag, welchen Bereich ich anfassen soll."
  ].join("\n");
}

function latestUserMessage(messages) {
  const userMessages = Array.isArray(messages) ? messages.filter((message) => message?.role === "user") : [];
  const content = String(userMessages.at(-1)?.content || "").trim();
  return content.replace(/\s+/g, " ").slice(0, 180);
}

function safeResolve(inputPath) {
  const rel = String(inputPath || "").replace(/^\/+/, "");
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => forbiddenSegments.has(part))) throw new Error("Path is not allowed");
  const resolved = path.resolve(config.projectRoot, rel);
  if (!resolved.startsWith(config.projectRoot + path.sep) && resolved !== config.projectRoot) {
    throw new Error("Path escapes project sandbox");
  }
  return resolved;
}

async function readLimited(file, limit) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error("Path is not a file");
  if (info.size > limit) throw new Error(`File too large. Limit: ${limit} bytes`);
  return readFile(file, "utf8");
}

function run(bin, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: "", stderr: error.message || "Command failed to start" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.slice(-20_000), stderr: stderr.slice(-20_000) });
    });
  });
}

function readAuthBody(req) {
  const contentType = String(req.headers["content-type"] || "");
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > SECURITY_LIMITS.maxJsonBodyBytes) reject(new Error("Request too large"));
    });
    req.on("end", () => {
      try {
        if (contentType.includes("application/x-www-form-urlencoded")) {
          const params = new URLSearchParams(raw);
          return resolve({
            credential: params.get("credential") || "",
            idToken: params.get("id_token") || "",
            state: params.get("state") || "",
            redirect: true
          });
        }
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid auth request"));
      }
    });
  });
}

function serializeSessionCookie(user) {
  return `smejj_session=${serializeSessionToken(user)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
}

function serializeSessionToken(user) {
  return issueSessionToken({ secret: config.sessionSecret, user });
}

function readSession(req) {
  const match = String(req.headers.cookie || "").match(/(?:^|;\s*)smejj_session=([^;]+)/);
  const token = bearerSessionToken(req.headers || {}) || match?.[1] || "";
  return verifySessionToken(token, { secret: config.sessionSecret });
}
