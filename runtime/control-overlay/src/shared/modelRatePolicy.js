import { createRateLimiter } from "./rateLimiter.js";

export function createPublicModelRateGate(env = process.env) {
  const perClientMax = boundedInteger(env.SMEJJ_CONTROL_AI_RATE_PER_MINUTE, 1, 5_000, 120);
  const globalMax = boundedInteger(env.SMEJJ_PUBLIC_AI_GLOBAL_RATE_PER_MINUTE, perClientMax, 20_000, 120);
  const perClient = createRateLimiter({ windowMs: 60_000, max: perClientMax, maxKeys: 10_000 });
  const global = createRateLimiter({ windowMs: 60_000, max: globalMax, maxKeys: 1 });
  return {
    limits: { perClientPerMinute: perClientMax, globalPerMinute: globalMax },
    check(req) {
      const client = perClient.check(clientKey(req));
      if (!client.allowed) return client;
      return global.check("global");
    }
  };
}

function clientKey(req) {
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded
    || String(req?.headers?.["x-real-ip"] || "").trim()
    || String(req?.socket?.remoteAddress || "unknown");
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}
