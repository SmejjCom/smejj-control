// smejj.com — Multi-Modell-Router: EIN einheitlicher OpenAI-kompatibler Adapter
// fuer alle Backends. Prioritaetskette pro Aufgabenprofil, Fallback bei Fehlern,
// fail-closed ohne Konfiguration. Keine Keys im Code — alles aus der Umgebung.
//
// Backends (Reihenfolge per SMEJJ_LLM_PROVIDER_ORDER steuerbar, Standard unten):
//   salad      — eigener GPU-Endpoint (SaladCloud Container Gateway, z. B. Qwen3/TGI)
//   openrouter — Multi-Modell-Router (GPT, Claude, Gemini, DeepSeek, Kimi, GLM, ...)
//   Katalog    — direkte OpenAI-kompatible Anbieter (nur aktiv, wenn Key gesetzt):
//                groq, cerebras, gemini, deepseek, mistral, zhipu, qwen, moonshot,
//                together, fireworks, sambanova, nvidia, openai
//   custom     — generischer OpenAI-kompatibler Endpoint (SMEJJ_LLM_* / lokaler GLM-Server)
//
// Aktivierung je Anbieter: SMEJJ_LLM_<NAME>_API_KEY setzen. Optional uebersteuerbar:
//   SMEJJ_LLM_<NAME>_BASE_URL, SMEJJ_LLM_<NAME>_MODEL, SMEJJ_LLM_<NAME>_MODEL_<PROFIL>
// Anthropic Claude ist nicht OpenAI-kompatibel und wird ueber OpenRouter genutzt.
//
// Profile: coding | reasoning | fast | web | default — steuern nur die Modellwahl.
// GLM bleibt laut Konzept das Qualitaetsmodell (zhipu-Provider, Default glm-5.2);
// dieser Router macht smejj.com unabhaengig von einem einzelnen Anbieter.

import {
  getModelDefinition,
  getModelRuntimeConfig,
  resolveModelSelection
} from "../../../src/shared/modelRegistry.js";
import {
  markModelRuntimeFailure,
  markModelRuntimeSuccess
} from "./modelRuntimeHealth.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export const ROUTING_PROFILES = Object.freeze(["coding", "reasoning", "fast", "web", "default"]);

// Konservative, jederzeit per Env uebersteuerbare Modell-Defaults fuer OpenRouter.
const OPENROUTER_DEFAULT_MODELS = Object.freeze({
  coding: "deepseek/deepseek-chat",
  reasoning: "deepseek/deepseek-reasoner",
  fast: "google/gemini-2.5-flash",
  web: "google/gemini-2.5-flash",
  default: "deepseek/deepseek-chat"
});

// Direkte OpenAI-kompatible Anbieter. "models" sind Defaults pro Profil und per Env
// uebersteuerbar; fehlt ein Profil, greift "default". Free-Tier-freundliche Wahl,
// keine automatischen Upgrades — ohne gesetzten Key ist ein Anbieter INAKTIV.
export const PROVIDER_CATALOG = Object.freeze({
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    models: { default: "llama-3.3-70b-versatile", fast: "llama-3.1-8b-instant", web: "llama-3.3-70b-versatile" }
  },
  cerebras: {
    baseUrl: "https://api.cerebras.ai/v1",
    models: { default: "llama-3.3-70b" }
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: { default: "gemini-2.5-flash", reasoning: "gemini-2.5-pro" }
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    models: { default: "deepseek-chat", reasoning: "deepseek-reasoner", coding: "deepseek-chat" }
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    models: { default: "mistral-small-latest", coding: "codestral-latest" }
  },
  zhipu: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: { default: "glm-5.2", coding: "glm-5.2", reasoning: "glm-5.2" }
  },
  qwen: {
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    models: { default: "qwen-plus", coding: "qwen3-coder-plus" }
  },
  moonshot: {
    baseUrl: "https://api.moonshot.ai/v1",
    models: { default: "kimi-k2-turbo-preview" }
  },
  together: {
    baseUrl: "https://api.together.xyz/v1",
    models: { default: "meta-llama/Llama-3.3-70B-Instruct-Turbo" }
  },
  fireworks: {
    baseUrl: "https://api.fireworks.ai/inference/v1",
    models: { default: "accounts/fireworks/models/llama-v3p3-70b-instruct" }
  },
  sambanova: {
    baseUrl: "https://api.sambanova.ai/v1",
    models: { default: "Meta-Llama-3.3-70B-Instruct" }
  },
  nvidia: {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    models: { default: "meta/llama-3.3-70b-instruct" }
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    models: { default: "gpt-4o-mini", reasoning: "o4-mini", coding: "gpt-4o-mini" }
  }
});

const DEFAULT_PROVIDER_ORDER = Object.freeze([
  "salad", "openrouter",
  "groq", "cerebras", "gemini", "deepseek", "mistral", "zhipu", "qwen",
  "moonshot", "together", "fireworks", "sambanova", "nvidia", "openai",
  "custom"
]);

function trimUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function keyPool(...values) {
  const seen = new Set();
  const keys = [];
  for (const value of values) {
    for (const key of String(value || "").split(/[,\n]/).map((part) => part.trim()).filter(Boolean)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

function expandKeys(backend, keys) {
  if (!backend || keys.length === 0) return [];
  return keys.map((apiKey, index) => ({ ...backend, apiKey, keyIndex: index + 1 }));
}

export function saladBackendFromEnv(env = process.env) {
  const baseUrl = trimUrl(env.SMEJJ_LLM_SALAD_BASE_URL);
  const keys = keyPool(env.SMEJJ_LLM_SALAD_API_KEY, env.SMEJJ_LLM_SALAD_API_KEYS);
  if (!baseUrl || keys.length === 0) return null;
  return {
    name: "salad",
    baseUrl,
    apiKey: keys[0],
    keyIndex: 1,
    apiKeyHeader: "Salad-Api-Key", // Salad Gateway erwartet diesen Header statt Bearer.
    model: String(env.SMEJJ_LLM_SALAD_MODEL || "tgi").trim()
  };
}

export function openrouterBackendFromEnv(env = process.env, profile = "default") {
  const keys = keyPool(env.SMEJJ_LLM_OPENROUTER_API_KEY, env.SMEJJ_LLM_OPENROUTER_API_KEYS);
  if (keys.length === 0) return null;
  const overrideKey = `SMEJJ_LLM_OPENROUTER_MODEL_${profile.toUpperCase()}`;
  return {
    name: "openrouter",
    baseUrl: trimUrl(env.SMEJJ_LLM_OPENROUTER_BASE_URL) || OPENROUTER_BASE_URL,
    apiKey: keys[0],
    keyIndex: 1,
    apiKeyHeader: "Authorization",
    model: String(env[overrideKey] || OPENROUTER_DEFAULT_MODELS[profile] || OPENROUTER_DEFAULT_MODELS.default).trim(),
    extraHeaders: { "HTTP-Referer": "https://smejj.com", "X-Title": "smejj.com" }
  };
}

/** Katalog-Anbieter aus der Env bauen — null, wenn kein Key gesetzt (fail-closed). */
export function providerBackendFromEnv(name, env = process.env, profile = "default") {
  const entry = PROVIDER_CATALOG[name];
  if (!entry) return null;
  const upper = name.toUpperCase();
  const keys = keyPool(env[`SMEJJ_LLM_${upper}_API_KEY`], env[`SMEJJ_LLM_${upper}_API_KEYS`]);
  if (keys.length === 0) return null;
  const overrideProfile = env[`SMEJJ_LLM_${upper}_MODEL_${profile.toUpperCase()}`];
  const overrideDefault = env[`SMEJJ_LLM_${upper}_MODEL`];
  const model = String(
    overrideProfile || overrideDefault || entry.models[profile] || entry.models.default
  ).trim();
  return {
    name,
    baseUrl: trimUrl(env[`SMEJJ_LLM_${upper}_BASE_URL`]) || entry.baseUrl,
    apiKey: keys[0],
    keyIndex: 1,
    apiKeyHeader: "Authorization",
    model
  };
}

export function customBackendFromEnv(env = process.env) {
  const baseUrl = trimUrl(env.SMEJJ_LLM_BASE_URL || env.OPENAI_COMPATIBLE_BASE_URL || env.BRIRT_LLM_BASE_URL);
  const keys = keyPool(
    env.SMEJJ_LLM_API_KEY || env.OPENAI_COMPATIBLE_API_KEY || env.OPENAI_API_KEY,
    env.SMEJJ_LLM_API_KEYS,
    env.OPENAI_COMPATIBLE_API_KEYS,
    env.OPENAI_API_KEYS
  );
  const model = String(env.SMEJJ_LLM_MODEL || env.OPENAI_COMPATIBLE_MODEL || env.OPENAI_MODEL || "").trim();
  if (!baseUrl || baseUrl === "disabled" || !model || model === "disabled" || keys.length === 0) return null;
  return { name: "custom", baseUrl, apiKey: keys[0], keyIndex: 1, apiKeyHeader: "Authorization", model };
}

export function registryBackendFromEnv(modelId, env = process.env, profile = "default") {
  const definition = getModelDefinition(modelId);
  const runtime = getModelRuntimeConfig(definition, env, profile);
  if (!definition || !runtime?.configured) return null;
  return {
    name: runtime.provider,
    logicalModelId: definition.id,
    baseUrl: runtime.baseUrl,
    apiKey: runtime.apiKeys[0],
    keyIndex: 1,
    apiKeyHeader: runtime.apiKeyHeader,
    model: runtime.runtimeModel
  };
}

/** Anbieter-Reihenfolge aus der Env (Kommaliste) oder Standard. Unbekannte Namen werden ignoriert. */
export function providerOrderFromEnv(env = process.env) {
  const raw = String(env.SMEJJ_LLM_PROVIDER_ORDER || "").trim();
  if (!raw) return DEFAULT_PROVIDER_ORDER;
  const known = new Set(["salad", "openrouter", "custom", ...Object.keys(PROVIDER_CATALOG)]);
  const order = raw.split(",").map((part) => part.trim().toLowerCase()).filter((part) => known.has(part));
  return order.length > 0 ? order : DEFAULT_PROVIDER_ORDER;
}

/** Liefert die Fallback-Kette fuer ein Profil — leer, wenn nichts konfiguriert (fail-closed). */
export function resolveChain(profile = "default", env = process.env) {
  const safeProfile = ROUTING_PROFILES.includes(profile) ? profile : "default";
  const chain = [];
  for (const name of providerOrderFromEnv(env)) {
    if (name === "salad") chain.push(...expandKeys(saladBackendFromEnv(env), keyPool(env.SMEJJ_LLM_SALAD_API_KEY, env.SMEJJ_LLM_SALAD_API_KEYS)));
    else if (name === "openrouter") chain.push(...expandKeys(openrouterBackendFromEnv(env, safeProfile), keyPool(env.SMEJJ_LLM_OPENROUTER_API_KEY, env.SMEJJ_LLM_OPENROUTER_API_KEYS)));
    else if (name === "custom") chain.push(...expandKeys(customBackendFromEnv(env), keyPool(env.SMEJJ_LLM_API_KEY || env.OPENAI_COMPATIBLE_API_KEY || env.OPENAI_API_KEY, env.SMEJJ_LLM_API_KEYS, env.OPENAI_COMPATIBLE_API_KEYS, env.OPENAI_API_KEYS)));
    else {
      const upper = name.toUpperCase();
      chain.push(...expandKeys(providerBackendFromEnv(name, env, safeProfile), keyPool(env[`SMEJJ_LLM_${upper}_API_KEY`], env[`SMEJJ_LLM_${upper}_API_KEYS`])));
    }
  }
  return chain.filter(Boolean);
}

/** Registry-gesteuerte Kette fuer eine konkrete Modellwahl inklusive stabilem Fallback. */
export function resolveModelRequest(profile = "default", requestedModel = "", env = process.env) {
  const safeProfile = ROUTING_PROFILES.includes(profile) ? profile : "default";
  const selection = resolveModelSelection({ requestedModel, profile: safeProfile, env });
  const modelChain = [];
  for (const modelId of selection.candidateIds) {
    const runtime = getModelRuntimeConfig(modelId, env, safeProfile);
    modelChain.push(...expandKeys(registryBackendFromEnv(modelId, env, safeProfile), runtime?.apiKeys || []));
  }

  const legacyChain = resolveChain(safeProfile, env).map((backend) => ({
    ...backend,
    logicalModelId: backend.name === "zhipu" ? "glm-5-2" : backend.logicalModelId || "provider-fallback"
  }));
  const chain = dedupeBackends([...modelChain, ...legacyChain]);
  return { selection, chain };
}

// Ein Aufgabentext wird grob einem Profil zugeordnet (leichtgewichtig, deterministisch).
export function classifyProfile(task = "") {
  const text = String(task).toLowerCase();
  if (/\b(code|coding|bug|patch|refactor|implement|funktion|klasse|test|typescript|javascript|python)\b/.test(text)) return "coding";
  if (/\b(warum|analyse|plan|architektur|begruende|vergleiche|reasoning|beweis)\b/.test(text)) return "reasoning";
  if (text.length < 80) return "fast";
  return "default";
}

function buildHeaders(backend) {
  const headers = { "Content-Type": "application/json", ...(backend.extraHeaders || {}) };
  headers[backend.apiKeyHeader] = backend.apiKeyHeader === "Authorization" ? `Bearer ${backend.apiKey}` : backend.apiKey;
  return headers;
}

/**
 * Fuehrt die Anfrage gegen die Kette aus: erster erreichbarer Kandidat gewinnt,
 * bei HTTP-/Netzfehler oder Timeout wird der naechste versucht. Liefert die ROHE
 * fetch-Response des Gewinners (Streaming bleibt erhalten) plus Metadaten.
 * Timeout pro Versuch: SMEJJ_LLM_TIMEOUT_MS (Default 45000 ms) bis zum Antwort-Start;
 * das Streaming selbst wird nicht abgebrochen.
 */
export async function executeWithFallback(chain, messages, {
  fetchImpl = fetch,
  stream = true,
  temperature,
  timeoutMs,
  tools,
  toolChoice,
  maxTokens,
  responseFormat
} = {}) {
  const attempts = [];
  const requestedLimitMs = Number(timeoutMs || process.env.SMEJJ_LLM_TIMEOUT_MS || 45000);
  const limitMs = Number.isFinite(requestedLimitMs) && requestedLimitMs > 0 ? requestedLimitMs : 45000;
  for (const backend of chain) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limitMs);
    try {
      const response = await fetchImpl(`${backend.baseUrl}/chat/completions`, {
        method: "POST",
        headers: buildHeaders(backend),
        signal: controller.signal,
        body: JSON.stringify({
          model: backend.model,
          messages,
          stream,
          ...(temperature === undefined ? {} : { temperature }),
          ...(Array.isArray(tools) && tools.length ? { tools } : {}),
          ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
          ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
          ...(responseFormat === undefined ? {} : { response_format: responseFormat })
        })
      });
      if (response.ok) {
        clearTimeout(timer);
        markModelRuntimeSuccess(backend);
        return {
          ok: true,
          backend: backend.name,
          model: backend.model,
          logicalModelId: backend.logicalModelId || "provider-fallback",
          response,
          attempts
        };
      }
      attempts.push({
        backend: backend.name,
        model: backend.model,
        logicalModelId: backend.logicalModelId || "provider-fallback",
        error: `http_${response.status}`
      });
      markModelRuntimeFailure(backend, `http_${response.status}`);
    } catch (error) {
      const failure = error?.name === "AbortError" ? "timeout" : "network_error";
      attempts.push({
        backend: backend.name,
        model: backend.model,
        logicalModelId: backend.logicalModelId || "provider-fallback",
        error: error?.name === "AbortError" ? "timeout" : String(error?.message || error).slice(0, 120)
      });
      markModelRuntimeFailure(backend, failure);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, attempts };
}

function dedupeBackends(backends) {
  const seen = new Set();
  return backends.filter((backend) => {
    if (!backend) return false;
    const key = [backend.name, backend.baseUrl, backend.model, backend.keyIndex, backend.logicalModelId].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
