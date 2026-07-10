import { GLM_5_2_FP8_STATUS, KIMI_K2_7_STATUS } from "./platform.js";

export const DEFAULT_MODEL_ID = "glm-5-2";
export const AUTO_MODEL_ID = "auto";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

export const MODEL_REGISTRY = Object.freeze({
  [DEFAULT_MODEL_ID]: Object.freeze({
    id: DEFAULT_MODEL_ID,
    name: "GLM-5.2",
    aliases: Object.freeze(["glm-5.2", "glm-5-2-fp8", "smejj 1.0", "smejj code"]),
    provider: "zhipu",
    status: "production-primary",
    contextTokens: 1_000_000,
    codingCapability: "flagship",
    enabledByDefault: true,
    featureFlag: "SMEJJ_GLM_5_2_ENABLED",
    fallbackModelId: null,
    storage: Object.freeze({
      provider: "idrive-e2",
      bucketEnv: "IDRIVE_E2_MODEL_BUCKET",
      prefix: "model-files/glm-5-2-fp8/original/",
      vaultStatusId: GLM_5_2_FP8_STATUS.id
    }),
    capabilities: Object.freeze({
      chat: true,
      coding: true,
      fileAnalysis: true,
      projectAnalysis: true,
      agentTasks: true,
      streaming: true,
      patchPlanning: true,
      testExplanation: true
    }),
    runtime: Object.freeze({
      envPrefix: "ZHIPU",
      defaultBaseUrl: "https://api.z.ai/api/paas/v4",
      defaultModel: "glm-5.2",
      defaultHeader: "Authorization",
      storageFirstMode: "glm-5.2-storage-first",
      engines: Object.freeze(["openai-compatible", "sglang", "vllm", "ktransformers"]),
      workerEngines: Object.freeze(["sglang", "vllm", "ktransformers"]),
      requiredLocalCacheGb: 704,
      recommendedRamGb: 64
    })
  }),
  "kimi-k2-7": Object.freeze({
    id: "kimi-k2-7",
    name: "Kimi K2.7",
    aliases: Object.freeze(["kimi k2.7", "kimi-k2.7", "kimi k2.7 code", "kimi-k2-7-code"]),
    provider: "kimi",
    status: "storage-verified-runtime-configurable",
    contextTokens: 262_144,
    codingCapability: "agentic-coding",
    enabledByDefault: false,
    featureFlag: "SMEJJ_KIMI_K2_7_ENABLED",
    fallbackModelId: DEFAULT_MODEL_ID,
    storage: Object.freeze({
      provider: "idrive-e2",
      bucketEnv: "IDRIVE_E2_MODEL_BUCKET",
      prefix: "model-files/kimi-k2-7/original/",
      vaultStatusId: KIMI_K2_7_STATUS.id
    }),
    capabilities: Object.freeze({
      chat: true,
      coding: true,
      fileAnalysis: true,
      projectAnalysis: true,
      agentTasks: true,
      streaming: true,
      patchPlanning: true,
      testExplanation: true
    }),
    runtime: Object.freeze({
      envPrefix: "KIMI",
      defaultBaseUrl: "",
      defaultModel: "moonshotai/Kimi-K2.7-Code",
      defaultHeader: "Authorization",
      storageFirstMode: "kimi-k2.7-storage-first",
      engines: Object.freeze(["openai-compatible", "sglang", "vllm", "ktransformers"]),
      workerEngines: Object.freeze(["sglang", "vllm", "ktransformers"]),
      requiredLocalCacheGb: 555,
      recommendedRamGb: 128
    })
  })
});

const MODEL_ALIASES = new Map(
  Object.values(MODEL_REGISTRY).flatMap((model) => (
    [model.id, model.name, ...model.aliases].map((alias) => [normalizeAlias(alias), model.id])
  ))
);

export function getModelDefinition(modelId) {
  return MODEL_REGISTRY[normalizeModelId(modelId)] || null;
}

export function normalizeModelId(value) {
  const alias = normalizeAlias(value);
  if (!alias) return DEFAULT_MODEL_ID;
  if (alias === AUTO_MODEL_ID) return AUTO_MODEL_ID;
  return MODEL_ALIASES.get(alias) || null;
}

export function isModelEnabled(modelOrId, env = process.env) {
  const model = typeof modelOrId === "string" ? getModelDefinition(modelOrId) : modelOrId;
  if (!model) return false;
  return readFlag(env[model.featureFlag], model.enabledByDefault);
}

export function getModelRuntimeConfig(modelOrId, env = process.env, profile = "default") {
  const model = typeof modelOrId === "string" ? getModelDefinition(modelOrId) : modelOrId;
  if (!model) return null;
  const prefix = model.runtime.envPrefix;
  const keys = uniqueKeys(env[`SMEJJ_LLM_${prefix}_API_KEY`], env[`SMEJJ_LLM_${prefix}_API_KEYS`]);
  const profileKey = `SMEJJ_LLM_${prefix}_MODEL_${String(profile || "default").toUpperCase()}`;
  const baseUrl = trimUrl(env[`SMEJJ_LLM_${prefix}_BASE_URL`] || model.runtime.defaultBaseUrl);
  const runtimeModel = String(env[profileKey] || env[`SMEJJ_LLM_${prefix}_MODEL`] || model.runtime.defaultModel || "").trim();
  const apiKeyHeader = String(env[`SMEJJ_LLM_${prefix}_HEADER`] || model.runtime.defaultHeader).trim();
  return {
    modelId: model.id,
    provider: model.provider,
    baseUrl,
    runtimeModel,
    apiKeyHeader,
    apiKeys: keys,
    configured: Boolean(baseUrl && runtimeModel && keys.length > 0)
  };
}

export function resolveModelSelection({ requestedModel, profile = "default", env = process.env } = {}) {
  const requestedId = normalizeModelId(requestedModel);
  const defaultId = enabledDefaultModelId(env);
  const autoRequested = requestedId === AUTO_MODEL_ID;
  const autoEnabled = readFlag(env.SMEJJ_MODEL_AUTO_ENABLED, false);
  let selectedId = requestedId && requestedId !== AUTO_MODEL_ID ? requestedId : defaultId;
  let reason = requestedId ? "explicit_model" : "default_model";

  if (autoRequested) {
    selectedId = autoEnabled ? autoModelId(profile, env, defaultId) : defaultId;
    reason = autoEnabled ? "auto_profile_selection" : "auto_disabled_default_used";
  }

  const selected = MODEL_REGISTRY[selectedId] || MODEL_REGISTRY[defaultId];
  const enabled = isModelEnabled(selected, env);
  const fallbackAllowed = readFlag(env.SMEJJ_MODEL_FALLBACK_ENABLED, true);
  const candidateIds = [];
  if (enabled) candidateIds.push(selected.id);
  if ((!enabled || selected.id !== defaultId) && fallbackAllowed && !candidateIds.includes(defaultId)) candidateIds.push(defaultId);

  return {
    requestedModel: String(requestedModel || ""),
    requestedModelId: requestedId || defaultId,
    selectedModelId: enabled ? selected.id : defaultId,
    candidateIds,
    fallbackAllowed,
    autoRequested,
    autoEnabled,
    reason: enabled ? reason : "requested_model_inactive"
  };
}

export function getPublicModelRegistry(env = process.env, runtimeHealth = {}) {
  const defaultModelId = enabledDefaultModelId(env);
  const models = Object.values(MODEL_REGISTRY).map((model) => {
    const active = isModelEnabled(model, env);
    const runtime = getModelRuntimeConfig(model, env);
    const runtimeConfigured = active && runtime.configured;
    const health = publicRuntimeHealth(runtimeHealth[model.id]);
    const runtimeAvailable = runtimeConfigured && health?.available === true;
    return {
      id: model.id,
      name: model.name,
      provider: model.provider,
      status: modelPublicStatus({ active, runtimeConfigured, health }),
      contextTokens: model.contextTokens,
      codingCapability: model.codingCapability,
      active,
      selectable: active,
      runtimeConfigured,
      runtimeAvailable,
      default: model.id === defaultModelId,
      fallbackModelId: model.fallbackModelId,
      storage: model.storage,
      capabilities: model.capabilities,
      runtime: {
        model: runtime.runtimeModel,
        engines: model.runtime.engines,
        health
      }
    };
  });
  return {
    version: 1,
    defaultModelId,
    auto: {
      id: AUTO_MODEL_ID,
      active: readFlag(env.SMEJJ_MODEL_AUTO_ENABLED, false),
      status: readFlag(env.SMEJJ_MODEL_AUTO_ENABLED, false) ? "ready" : "prepared-inactive"
    },
    models
  };
}

function modelPublicStatus({ active, runtimeConfigured, health }) {
  if (!active) return "inactive";
  if (!runtimeConfigured) return "fallback-only";
  if (health?.available === false) return "degraded";
  if (health?.available === true) return "ready";
  return "configured-unverified";
}

function publicRuntimeHealth(health) {
  if (!health || typeof health !== "object") return null;
  return {
    status: String(health.status || "unknown"),
    available: health.available === true,
    checkedAt: health.checkedAt || null,
    source: health.source || null,
    consecutiveFailures: Number(health.consecutiveFailures || 0),
    reason: health.reason || null
  };
}

function enabledDefaultModelId(env) {
  const configured = normalizeModelId(env.SMEJJ_MODEL_DEFAULT);
  if (configured && configured !== AUTO_MODEL_ID && isModelEnabled(configured, env)) return configured;
  return DEFAULT_MODEL_ID;
}

function autoModelId(profile, env, defaultId) {
  const kimi = MODEL_REGISTRY["kimi-k2-7"];
  const runtime = getModelRuntimeConfig(kimi, env, profile);
  if (profile === "coding" && isModelEnabled(kimi, env) && runtime.configured) return kimi.id;
  return defaultId;
}

function readFlag(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (ENABLED_VALUES.has(normalized)) return true;
  if (DISABLED_VALUES.has(normalized)) return false;
  return fallback;
}

function normalizeAlias(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function trimUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function uniqueKeys(...values) {
  return [...new Set(values.flatMap((value) => String(value || "").split(/[,\n]/)).map((key) => key.trim()).filter(Boolean))];
}
