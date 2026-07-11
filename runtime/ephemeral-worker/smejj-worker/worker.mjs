#!/usr/bin/env node
import http from "node:http";
import { fileURLToPath } from "node:url";
import { runCodingJob } from "./agentloop.mjs";

export const WORKER_VERSION = "20260710-phase2-v1";
const PORT = Number(process.env.SMEJJ_WORKER_PORT || process.env.PORT || 8080);
const HOST = process.env.SMEJJ_HOST || "0.0.0.0";
let activeRun = false;

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "worker.local"}`);
      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, {
          ok: true,
          app: "smejj.com coding worker",
          version: WORKER_VERSION,
          role: "stateless-cpu-sandbox",
          activeRun,
          privileged: typeof process.getuid === "function" ? process.getuid() === 0 : null,
          runtime: {
            node: process.version,
            python: process.env.SMEJJ_RUNTIME_PYTHON_VERSION || "unverified",
            pytest: process.env.SMEJJ_RUNTIME_PYTEST_VERSION || "unverified",
            playwright: process.env.SMEJJ_RUNTIME_PLAYWRIGHT_VERSION || "unverified"
          },
          secretsExposed: false
        });
      }
      if (req.method === "POST" && url.pathname === "/run") {
        if (activeRun) return send(res, 429, { ok: false, error: "worker_busy" });
        const token = bearerToken(req.headers.authorization);
        if (!token) return send(res, 401, { ok: false, error: "worker_token_missing" });
        const payload = await readJson(req);
        const cancellation = requestCancellation(req, res);
        activeRun = true;
        try {
          const result = await runCodingJob({
            ...payload,
            workerToken: token,
            controlOrigin: process.env.SMEJJ_CONTROL_ORIGIN
          }, { signal: cancellation.signal });
          return send(res, 200, result);
        } finally {
          cancellation.dispose();
          activeRun = false;
        }
      }
      return send(res, 404, { ok: false, error: "not_found" });
    } catch (error) {
      activeRun = false;
      return send(res, 500, { ok: false, error: String(error?.message || error).slice(0, 1_000) });
    }
  });
}

export function startServer({ port = PORT, host = HOST } = {}) {
  const server = createServer();
  server.listen(port, host, () => console.log(`smejj.com coding worker: http://${host}:${port}`));
  return server;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function bearerToken(value) {
  const match = String(value || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function send(res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function requestCancellation(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort("job_cancelled");
  const close = () => { if (!res.writableEnded) abort(); };
  req.once?.("aborted", abort);
  res.once?.("close", close);
  return {
    signal: controller.signal,
    dispose() {
      req.off?.("aborted", abort);
      res.off?.("close", close);
    }
  };
}

const directPath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (directPath) startServer();
