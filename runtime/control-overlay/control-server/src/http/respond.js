// smejj.com control-server — HTTP-Antwort- und Body-Helfer (Single Responsibility: Request/Response-I/O).
import { SECURITY_HEADERS } from "../../../src/shared/platform.js";
import { SECURITY_LIMITS } from "../../../src/shared/securityPolicy.js";

export function json(res, status, payload) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

export function privateJson(res, status, payload) {
  if (typeof res.setHeader === "function") res.setHeader("Cache-Control", "private, no-store");
  return json(res, status, payload);
}

export function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > SECURITY_LIMITS.maxJsonBodyBytes) reject(new Error("Request too large"));
    });
    req.on("end", () => resolve(raw));
  });
}

export async function readJson(req) {
  const raw = await readRawBody(req);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error("Invalid JSON");
  }
}
