import { json, readJson } from "../http/respond.js";
import { bearerToken, verifyWorkerToken, workerTokenSecret } from "../auth/workerToken.js";
import { getJob, replaceJob } from "../jobs/jobStore.js";
import { hydrateJobFromIdrive } from "../jobs/jobHydration.js";
import { executeWithFallback, resolveModelRequest } from "../llm/modelRouter.js";
import { signedS3Put } from "../storage/s3Signer.js";

const ALLOWED_TOOLS = new Set(["read_file", "write_file", "run_cmd", "finish"]);
const ACTIVE_JOB_STATUSES = new Set(["planning", "running", "verifying"]);
export const CODING_TOOLS = Object.freeze([
  tool("read_file", "Read up to 400 lines from a repository-relative text file.", {
    path: { type: "string" },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 }
  }, ["path"]),
  tool("write_file", "Replace one repository-relative text file with complete content.", {
    path: { type: "string" },
    content: { type: "string" }
  }, ["path", "content"]),
  tool("run_cmd", "Run one allowlisted command as an argument array without a shell.", {
    command: { type: "array", minItems: 1, maxItems: 48, items: { type: "string" } }
  }, ["command"]),
  tool("finish", "Request the mandatory verification pipeline after the implementation is ready.", {
    summary: { type: "string" }
  }, ["summary"])
]);

export async function handleWorkerValidate(req, res, { env = process.env, nowMs = Date.now() } = {}) {
  const body = await readJson(req);
  const auth = authenticate(req, body.jobId, "validate", env, nowMs);
  if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.reason });
  const job = getJob(auth.claims.jobId) || await hydrateJobFromIdrive(auth.claims.jobId, { env });
  if (!job) return json(res, 404, { ok: false, error: "job_not_found" });
  if (job.status === "cancelled") return json(res, 409, { ok: false, error: "job_cancelled" });
  if (!ACTIVE_JOB_STATUSES.has(job.status)) return json(res, 409, { ok: false, error: "job_not_active" });
  const maxModelActions = clampInteger(env.SMEJJ_WORKER_MAX_MODEL_ACTIONS, 1, 25, 25);
  const modelActions = Number(job.executionBudget?.modelActions || 0);
  if (modelActions >= maxModelActions) return json(res, 429, { ok: false, error: "job_model_action_budget_exhausted", maxModelActions });
  return json(res, 200, {
    ok: true,
    jobId: job.id,
    status: job.status,
    expiresAt: auth.claims.expiresAt,
    modelActions,
    maxModelActions
  });
}

export async function handleWorkerModelAction(req, res, { env = process.env, nowMs = Date.now(), fetchImpl = fetch, persistBudget = persistModelActionBudget } = {}) {
  const body = await readJson(req);
  const auth = authenticate(req, body.jobId, "model", env, nowMs);
  if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.reason });
  const job = getJob(auth.claims.jobId) || await hydrateJobFromIdrive(auth.claims.jobId, { env });
  if (!job) return json(res, 404, { ok: false, error: "job_not_found" });
  if (job.status === "cancelled") return json(res, 409, { ok: false, error: "job_cancelled" });
  if (!ACTIVE_JOB_STATUSES.has(job.status)) return json(res, 409, { ok: false, error: "job_not_active" });
  const budget = reserveModelAction(job, env);
  if (!budget.ok) return json(res, 429, { ok: false, error: budget.error, maxModelActions: budget.maxModelActions });
  const budgetPersistence = await persistBudget({ job: budget.job, env, nowMs });
  if (budgetPersistence.ok !== true) {
    return json(res, 503, {
      ok: false,
      error: "model_action_budget_persistence_failed",
      budgetPersistence
    });
  }

  const messages = sanitizeMessages(body.messages);
  if (messages.length === 0) return json(res, 400, { ok: false, error: "messages_required" });
  const { chain, selection } = resolveModelRequest("coding", job.model?.id || "glm-5-2", env);
  if (chain.length === 0) return json(res, 503, { ok: false, error: "model_backend_not_configured" });
  const result = await executeWithFallback(chain, messages, {
    fetchImpl,
    stream: false,
    temperature: 0.2,
    tools: CODING_TOOLS,
    toolChoice: "required",
    maxTokens: clampInteger(env.SMEJJ_WORKER_MODEL_MAX_TOKENS, 1_024, 16_000, 8_192)
  });
  if (!result.ok) return json(res, 502, { ok: false, error: "model_backends_failed", attempts: result.attempts });

  let payload;
  try {
    payload = await result.response.json();
  } catch {
    return json(res, 502, { ok: false, error: "model_response_invalid_json" });
  }
  const assistant = payload?.choices?.[0]?.message;
  const rawCall = assistant?.tool_calls?.[0];
  const name = String(rawCall?.function?.name || "");
  if (!ALLOWED_TOOLS.has(name)) return json(res, 502, { ok: false, error: "model_missing_allowed_tool_call" });
  let args;
  try {
    args = JSON.parse(String(rawCall.function.arguments || "{}"));
  } catch {
    return json(res, 502, { ok: false, error: "model_tool_arguments_invalid" });
  }
  const id = String(rawCall.id || `call_${nowMs}`);
  res.setHeader("x-smejj-model-backend", `${result.backend}:${result.model}`);
  return json(res, 200, {
    ok: true,
    jobId: job.id,
    requestedModelId: selection.requestedModelId,
    modelId: result.logicalModelId,
    usage: normalizeUsage(payload?.usage),
    toolCall: { id, name, arguments: args },
    assistant: {
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
    }
  });
}

function normalizeUsage(value = {}) {
  return {
    promptTokens: Math.max(0, Number(value.prompt_tokens || value.promptTokens || 0)),
    completionTokens: Math.max(0, Number(value.completion_tokens || value.completionTokens || 0)),
    totalTokens: Math.max(0, Number(value.total_tokens || value.totalTokens || 0))
  };
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}

function reserveModelAction(job, env) {
  const maxModelActions = clampInteger(env.SMEJJ_WORKER_MAX_MODEL_ACTIONS, 1, 25, 25);
  const modelActions = Math.max(0, Number(job.executionBudget?.modelActions || 0));
  if (modelActions >= maxModelActions) {
    return { ok: false, error: "job_model_action_budget_exhausted", maxModelActions };
  }
  const updated = replaceJob({
    ...job,
    executionBudget: {
      ...(job.executionBudget || {}),
      modelActions: modelActions + 1,
      maxModelActions
    }
  }, { emitEvent: false });
  return { ok: true, modelActions: modelActions + 1, maxModelActions, job: updated };
}

export async function persistModelActionBudget({ job, env = process.env, nowMs = Date.now(), putObject } = {}) {
  const hasIdrive = Boolean(env.IDRIVE_E2_ENDPOINT && env.IDRIVE_E2_ACCESS_KEY && env.IDRIVE_E2_SECRET_KEY && env.IDRIVE_E2_BUCKET);
  if (!hasIdrive) {
    return env.SMEJJ_AUTONOMOUS_LOOP_ENABLED === "YES"
      ? { ok: false, reason: "idrive_e2_required_for_autonomous_budget" }
      : { ok: true, mode: "memory-only-non-autonomous" };
  }
  if (!job?.taskCapsule?.budget) return { ok: false, reason: "task_capsule_budget_required" };
  const object = {
    key: job.taskCapsule.budget,
    contentType: "application/json; charset=utf-8",
    body: `${JSON.stringify({
      version: 1,
      jobId: job.id,
      approved: false,
      gpuBudgetApproved: false,
      paidPlatformServicesAllowed: false,
      saladWorkerAutoStartAllowed: false,
      execution: {
        modelActions: Number(job.executionBudget?.modelActions || 0),
        maxModelActions: Number(job.executionBudget?.maxModelActions || 0)
      },
      updatedAt: new Date(nowMs).toISOString()
    }, null, 2)}\n`
  };
  const writer = putObject || ((item) => signedS3Put({
    endpoint: env.IDRIVE_E2_ENDPOINT,
    region: env.IDRIVE_E2_REGION || "us-west-2",
    accessKey: env.IDRIVE_E2_ACCESS_KEY,
    secretKey: env.IDRIVE_E2_SECRET_KEY,
    bucket: env.IDRIVE_E2_BUCKET,
    ...item
  }));
  try {
    await writer(object);
    return { ok: true, mode: "idrive-e2-budget-persisted", key: object.key };
  } catch (error) {
    return { ok: false, reason: "idrive_e2_budget_write_failed", error: String(error?.message || error).slice(0, 300) };
  }
}

function authenticate(req, jobId, scope, env, nowMs) {
  return verifyWorkerToken(bearerToken(req.headers || {}), {
    secret: workerTokenSecret(env),
    jobId: String(jobId || ""),
    scope,
    nowMs
  });
}

function sanitizeMessages(value) {
  const messages = Array.isArray(value) ? value.slice(-64) : [];
  let remaining = 160_000;
  const result = [];
  for (const message of messages) {
    const role = String(message?.role || "");
    if (!new Set(["system", "user", "assistant", "tool"]).has(role)) continue;
    const item = { role };
    if (role === "assistant" && Array.isArray(message.tool_calls)) item.tool_calls = message.tool_calls.slice(0, 1);
    if (role === "tool") item.tool_call_id = String(message.tool_call_id || "").slice(0, 160);
    const content = message.content === null ? null : String(message.content || "").slice(0, remaining);
    item.content = content;
    remaining -= content?.length || 0;
    result.push(item);
    if (remaining <= 0) break;
  }
  return result;
}

function tool(name, description, properties, required) {
  return { type: "function", function: { name, description, parameters: { type: "object", additionalProperties: false, properties, required } } };
}
