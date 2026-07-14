// smejj.com control-server — Maus-Engine-Bridge (modellunabhaengig).
// Der Control Server plant und dispatcht nur: er baut den Planer-Aufruf
// ueber den bestehenden AI Router (GLM-5.2 zuerst, jedes Modell via
// requestedModel/BYOK moeglich), validiert fail-closed und delegiert die
// Ausfuehrung an den stateless Maus-Engine-Worker hinter dem bestehenden
// Budget-Gate. Keine Browserarbeit, keine Artefakte im Control Server.
import { json } from "../http/respond.js";
import { clientKeyFromRequest, createRateLimiter } from "../http/rateLimiter.js";
import { evaluateWorkerBudget } from "../budget/budgetGate.js";
import { resolveModelRequest, executeWithFallback } from "../llm/modelRouter.js";
import { planAndExecute } from "../../../workers/maus-engine/planner-roundtrip.mjs";

const MAX_BODY_BYTES = 128_000;
const WORKER_TIMEOUT_MS = 330_000;
const RATE_CAPACITY = 6;
const RATE_REFILL_PER_SEC = 0.05;
const defaultLimiter = createRateLimiter({ capacity: RATE_CAPACITY, refillPerSec: RATE_REFILL_PER_SEC });

// Budget-Defaults gemaess docs/architecture/MAUS_ENGINE.md (Freigabe Phase 0);
// Overrides aus dem Request werden hart auf die Schema-Grenzen geklemmt.
const BUDGET_DEFAULTS = Object.freeze({
  maxActions: 60,
  maxLocalRetries: 2,
  maxPlannerRoundtrips: 2,
  maxDurationMs: 300_000,
  defaultActionTimeoutMs: 30_000
});
const BUDGET_LIMITS = Object.freeze({
  maxActions: [1, 500],
  maxLocalRetries: [0, 5],
  maxPlannerRoundtrips: [0, 3],
  maxDurationMs: [1000, 1_800_000],
  defaultActionTimeoutMs: [100, 120_000]
});

export function readMausEngineConfig(env = process.env) {
  const workerUrl = String(env.SMEJJ_MAUS_ENGINE_WORKER_URL || "").trim().replace(/\/$/, "");
  const token = String(env.SMEJJ_MAUS_ENGINE_TOKEN || "").trim();
  const enabled = env.SMEJJ_MAUS_ENGINE_ENABLED === "YES";
  const missing = [
    !enabled && "SMEJJ_MAUS_ENGINE_ENABLED=YES",
    !workerUrl && "SMEJJ_MAUS_ENGINE_WORKER_URL",
    !token && "SMEJJ_MAUS_ENGINE_TOKEN"
  ].filter(Boolean);
  return { configured: missing.length === 0, enabled, workerUrl, token, tokenPresent: Boolean(token), missing };
}

// Der EINE modellneutrale Planer-Zugang: AI Router entscheidet das Modell
// (Default-Kette beginnt bei GLM-5.2); die Engine sieht nur Plan-JSON.
export function buildPlannerClient({ env = process.env, fetchImpl = fetch, requestedModel = "" } = {}) {
  return async (prompt) => {
    const { chain } = resolveModelRequest("coding", requestedModel, env);
    if (!chain.length) throw new Error("kein_planer_backend_konfiguriert");
    // Modellneutral: KEINE feste temperature. Provider wie Moonshot/Kimi-Coding
    // erzwingen modellabhaengige Werte und lehnen andere mit HTTP 400 ab
    // (Live-Befund 2026-07-14); der Provider-Default gilt fuer jedes Modell.
    const result = await executeWithFallback(chain, [{ role: "user", content: prompt }], {
      fetchImpl,
      stream: false
    });
    if (!result.ok) throw new Error("planer_nicht_erreichbar");
    const payload = await result.response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("planer_leere_antwort");
    return content;
  };
}

function clampBudget(overrides = {}) {
  const budget = { ...BUDGET_DEFAULTS };
  for (const [key, [min, max]] of Object.entries(BUDGET_LIMITS)) {
    const value = Number.parseInt(overrides?.[key], 10);
    if (Number.isFinite(value)) budget[key] = Math.min(max, Math.max(min, value));
  }
  return budget;
}

function sanitizedFiles(files) {
  if (!files || typeof files !== "object") return undefined;
  const out = {};
  if (files.downloadAllowed === true) out.downloadAllowed = true;
  if (files.uploadAllowed === true) out.uploadAllowed = true;
  if (Array.isArray(files.allowedExtensions)) out.allowedExtensions = files.allowedExtensions.slice(0, 20).map(String);
  if (Number.isFinite(files.maxFileBytes)) out.maxFileBytes = Math.min(1_073_741_824, Math.max(1, Math.floor(files.maxFileBytes)));
  return Object.keys(out).length ? out : undefined;
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_zu_gross");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Worker-Aufruf: Ausfuehrung ausschliesslich im stateless Salad-Worker.
// 422 (Plan abgelehnt) wird als Abbruch an den Roundtrip zurueckgemeldet.
function buildRunPlan({ config, fetchImpl, saveAsMacro }) {
  return async (plan) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WORKER_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${config.workerUrl}/run`, {
        method: "POST",
        signal: controller.signal,
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify({ plan, ...(saveAsMacro ? { saveAsMacro } : {}) })
      });
      const summary = await response.json().catch(() => null);
      if (!summary || typeof summary !== "object") {
        return { ok: false, aborted: true, abortReason: `worker_antwort_ungueltig_http_${response.status}` };
      }
      if (summary.rejected === true) {
        return { ok: false, aborted: true, abortReason: `plan_abgelehnt: ${(summary.errors || []).slice(0, 3).join(" | ")}` };
      }
      return summary;
    } catch (error) {
      const reason = error?.name === "AbortError" ? "worker_timeout" : `worker_fehler: ${String(error?.message || error).slice(0, 160)}`;
      return { ok: false, aborted: true, abortReason: reason };
    } finally {
      clearTimeout(timer);
    }
  };
}

// GET /api/maus/run — Statussicht (auth-gated ueber controlAccessPolicy).
export function handleMausStatus(req, res, { env = process.env, activeWorkers = 0 } = {}) {
  if (!req?.authUser) return json(res, 401, { ok: false, error: "authentication_required" });
  const config = readMausEngineConfig(env);
  const budget = evaluateWorkerBudget({ env, activeWorkers });
  return json(res, 200, {
    ok: config.configured && budget.ok,
    engine: "smejj.com maus-engine",
    configured: config.configured,
    missing: config.missing,
    budget: { ok: budget.ok, reason: budget.reason ?? null },
    startsCompute: false
  });
}

// POST /api/maus/run — Aufgabe -> Plan (AI Router) -> Maus-Engine-Worker.
export async function handleMausRun(req, res, {
  env = process.env,
  fetchImpl = fetch,
  limiter = defaultLimiter,
  activeWorkers = 0,
  plannerClient = null,
  budgetEvaluator = evaluateWorkerBudget
} = {}) {
  if (!req?.authUser) return json(res, 401, { ok: false, error: "authentication_required" });
  if (limiter) {
    const verdict = limiter.take(clientKeyFromRequest(req));
    if (!verdict.allowed) {
      res.setHeader?.("Retry-After", String(verdict.retryAfterSec));
      return json(res, 429, { ok: false, error: "Zu viele Maus-Engine-Anfragen. Bitte kurz warten.", retryAfterSec: verdict.retryAfterSec });
    }
  }
  const config = readMausEngineConfig(env);
  if (!config.configured) {
    return json(res, 503, { ok: false, error: "maus_engine_nicht_konfiguriert", missing: config.missing });
  }
  const budgetVerdict = budgetEvaluator({ env, activeWorkers });
  if (!budgetVerdict.ok) {
    return json(res, 503, { ok: false, error: "budget_gate_blockiert", reason: budgetVerdict.reason ?? null });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { ok: false, error: "kein_gueltiges_json" });
  }
  const task = typeof body?.task === "string" ? body.task.trim() : "";
  const capsuleRef = typeof body?.capsuleRef === "string" ? body.capsuleRef.trim() : "";
  const domainAllowlist = Array.isArray(body?.domainAllowlist) ? body.domainAllowlist.slice(0, 20).map(String) : [];
  if (!task || task.length > 4000) return json(res, 400, { ok: false, error: "task_fehlt_oder_zu_lang" });
  if (!capsuleRef) return json(res, 400, { ok: false, error: "capsuleRef_fehlt (Task Capsule First)" });
  if (domainAllowlist.length === 0) return json(res, 400, { ok: false, error: "domainAllowlist_fehlt (fail-closed Pflicht)" });

  const policyInput = {
    capsuleRef,
    domainAllowlist,
    budget: clampBudget(body?.budget),
    files: sanitizedFiles(body?.files),
    // Stufe 3 (Vision) ist bis zur separaten Phase-3-Freigabe hart aus —
    // unabhaengig davon, was der Request behauptet.
    visionAllowed: false
  };
  const requestedModel = typeof body?.plannerModel === "string" ? body.plannerModel.trim() : "";
  const saveAsMacro = typeof body?.saveAsMacro === "string" && body.saveAsMacro.trim() ? body.saveAsMacro.trim() : undefined;

  try {
    const outcome = await planAndExecute({
      task,
      policyInput,
      plannerClient: plannerClient || buildPlannerClient({ env, fetchImpl, requestedModel }),
      runPlan: buildRunPlan({ config, fetchImpl, saveAsMacro })
    });
    if (outcome.ok) {
      const { artifacts, ...resultSummary } = outcome.result || {};
      return json(res, 200, {
        ok: true,
        planId: outcome.plan.planId,
        capsuleRef,
        plannerCalls: outcome.plannerCalls,
        history: outcome.history,
        result: resultSummary
      });
    }
    return json(res, 502, {
      ok: false,
      error: outcome.error || "maus_engine_lauf_fehlgeschlagen",
      plannerCalls: outcome.plannerCalls ?? null,
      history: outcome.history || [],
      lastFailure: outcome.lastFailure
        ? { failedStep: outcome.lastFailure.failedStep ?? null, aborted: outcome.lastFailure.aborted === true, abortReason: outcome.lastFailure.abortReason ?? null, errors: outcome.lastFailure.errors }
        : null
    });
  } catch (error) {
    return json(res, 500, { ok: false, error: String(error?.message || error).slice(0, 300) });
  }
}
