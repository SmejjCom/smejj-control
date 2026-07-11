const REQUEST_TIMEOUT_MS = 120_000;

export async function validateWorkerSession({ controlOrigin, token, jobId, fetchImpl = fetch, signal = null }) {
  const response = await controlRequest(controlOrigin, "/api/workers/validate", token, { jobId }, fetchImpl, signal);
  if (!response.ok) throw new Error(`worker_token_rejected:${response.status}`);
  const result = await response.json();
  if (result.ok !== true || result.jobId !== jobId) throw new Error("worker_token_rejected");
  return result;
}

export async function requestModelAction({ controlOrigin, token, jobId, messages, fetchImpl = fetch, signal = null }) {
  const response = await controlRequest(controlOrigin, "/api/workers/model-action", token, { jobId, messages }, fetchImpl, signal);
  const text = await response.text();
  let result;
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`model_action_invalid_json:${text.slice(0, 240)}`);
  }
  if (!response.ok || result.ok !== true) {
    throw new Error(`model_action_failed:${result.error || response.status}`);
  }
  return result;
}

async function controlRequest(controlOrigin, pathname, token, body, fetchImpl, externalSignal) {
  const origin = normalizeControlOrigin(controlOrigin);
  if (!token) throw new Error("worker_token_missing");
  const controller = new AbortController();
  const externalAbort = () => controller.abort("job_cancelled");
  if (externalSignal?.aborted) externalAbort();
  else externalSignal?.addEventListener?.("abort", externalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(`${origin}${pathname}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Origin: "https://smejj.com"
      },
      body: JSON.stringify(body)
    });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.("abort", externalAbort);
  }
}

function normalizeControlOrigin(value) {
  const origin = String(value || "").trim().replace(/\/+$/, "");
  if (/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin)) return origin;
  if (/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(origin)) return origin;
  throw new Error("control_origin_invalid");
}
