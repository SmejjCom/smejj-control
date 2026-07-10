// smejj.com stateless Remote-Browser-Worker.
// Playwright/Chromium laeuft nur hier, nie im Control Server. Jede Anfrage ist
// isoliert: Browser auf, Seite rendern, Screenshot zurueck, Browser zu.
// Scroll-faehig: die Seite wird bis zur Capture-Grenze vorgescrollt (Lazy-Load),
// dann in voller Hoehe aufgenommen — der Client scrollt nativ im Bild.
import http from "node:http";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { runCodingJob } from "../smejj-worker/agentloop.mjs";

const PORT = Number(envValue("PORT", 8080));
const HOST = envValue("SMEJJ_HOST", "0.0.0.0");
const MAX_BODY_BYTES = 64_000;
const NAV_TIMEOUT_MS = Number(envValue("SMEJJ_REMOTE_BROWSER_NAV_TIMEOUT_MS", 25_000));
const TOKEN = String(envValue("SMEJJ_REMOTE_BROWSER_TOKEN", "")).trim();
const MOBILE_WIDTH_MAX = 760;
const MAX_CAPTURE_HEIGHT_PX = clamp(Number(envValue("SMEJJ_REMOTE_BROWSER_MAX_CAPTURE_PX", 6000)), 720, 20000, 6000);
const MAX_LINKS = 200;
const JPEG_QUALITY = clamp(Number(envValue("SMEJJ_REMOTE_BROWSER_JPEG_QUALITY", 70)), 30, 90, 70);
let activeCodingRun = false;
const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 smejj.com-remote-browser";
const MOBILE_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; smejj.com Remote Browser) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36 smejj.com-remote-browser";

function envValue(name, fallback) {
  const mangled = `_${name.toLowerCase().split("").join("_")}`;
  return process.env[name] ?? process.env[name.toLowerCase()] ?? process.env[mangled] ?? fallback;
}

export function isAllowedTarget(rawUrl) {
  let target;
  try {
    target = new URL(String(rawUrl || ""));
  } catch {
    return { ok: false, error: "Ungueltige URL." };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { ok: false, error: "Nur http(s)-URLs sind erlaubt." };
  }
  const host = target.hostname;
  const blocked = [
    /^localhost$/i,
    /^127\./,
    /^0\./,
    /^10\./,
    /^192\.168\./,
    /^169\.254\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /\.(local|internal|lan|home|corp)$/i,
    /^\[?::1\]?$/,
    /^\[?f[cd][0-9a-f]{2}:/i,
    /^\[?fe80:/i
  ].some((pattern) => pattern.test(host));
  return blocked ? { ok: false, error: "Ziel-Host ist blockiert." } : { ok: true, url: target };
}

export function isAuthorized(req, token = TOKEN) {
  if (!token) return false;
  const header = String(req.headers.authorization || "");
  return header === `Bearer ${token}`;
}

// Lazy-Load ausloesen: schrittweise bis zur Capture-Grenze scrollen, dann
// zurueck nach oben. Fehler sind unkritisch (Seite bleibt im Ist-Zustand).
async function warmUpLazyContent(page, viewportHeight, limitPx) {
  if (typeof page.evaluate !== "function") return;
  try {
    await page.evaluate(async ({ step, limit }) => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const maxY = Math.min(limit, Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0));
      for (let y = 0; y < maxY; y += step) {
        window.scrollTo(0, y);
        await delay(120);
      }
      window.scrollTo(0, 0);
      await delay(180);
    }, { step: Math.max(300, viewportHeight), limit: limitPx });
  } catch {
    // Fail-open: Screenshot passiert trotzdem.
  }
}

async function measurePageHeight(page, fallback) {
  if (typeof page.evaluate !== "function") return fallback;
  try {
    const height = await page.evaluate(() => Math.max(
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0
    ));
    return Number.isFinite(height) && height > 0 ? Math.round(height) : fallback;
  } catch {
    return fallback;
  }
}

// Sichtbare Links mit Positionen einsammeln — der Client legt daraus
// klickbare Bereiche ueber den Screenshot (Navigation im Remote-Modus).
async function collectLinks(page, captureWidth, captureHeight) {
  if (typeof page.evaluate !== "function") return [];
  try {
    const links = await page.evaluate(({ maxLinks, width, height }) => {
      const out = [];
      for (const anchor of document.querySelectorAll("a[href]")) {
        if (out.length >= maxLinks) break;
        const href = anchor.href || "";
        if (!/^https?:\/\//i.test(href)) continue;
        const rect = anchor.getBoundingClientRect();
        const x = rect.left + window.scrollX;
        const y = rect.top + window.scrollY;
        if (rect.width < 8 || rect.height < 8) continue;
        if (y >= height || x >= width || y + rect.height <= 0) continue;
        out.push({
          href: href.slice(0, 2000),
          x: Math.round(x),
          y: Math.round(y),
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        });
      }
      return out;
    }, { maxLinks: MAX_LINKS, width: captureWidth, height: captureHeight });
    return Array.isArray(links) ? links : [];
  } catch {
    return [];
  }
}

export async function renderWithPlaywright({ url, viewport = {}, playwrightLoader = loadPlaywright, dnsLookup = lookup } = {}) {
  const parsed = isAllowedTarget(url);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  await assertPublicHostname(parsed.url.hostname, dnsLookup);
  const playwright = await playwrightLoader();
  const browser = await playwright.chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process"]
  });
  try {
    const pageOptions = buildPageOptions(viewport);
    const page = await browser.newPage(pageOptions);
    const networkSafety = new Map();
    if (typeof page.route === "function") {
      await page.route("**/*", async (route) => {
        try {
          await assertPublicRequest(route.request().url(), dnsLookup, networkSafety);
          await route.continue();
        } catch {
          await route.abort("blockedbyclient");
        }
      });
    }
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    const response = await page.goto(parsed.url.toString(), { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    const { width, height } = pageOptions.viewport;
    await warmUpLazyContent(page, height, MAX_CAPTURE_HEIGHT_PX);
    const pageHeight = await measurePageHeight(page, height);
    const captureHeight = Math.min(Math.max(pageHeight, height), MAX_CAPTURE_HEIGHT_PX);
    // Viewport auf volle Capture-Hoehe stellen: exakte Hoehe, kein Clip/FullPage-
    // Sonderfall, und fixierte Header rendern wie beim echten Scrollen oben.
    if (captureHeight > height && typeof page.setViewportSize === "function") {
      await page.setViewportSize({ width, height: captureHeight }).catch(() => {});
      if (typeof page.waitForTimeout === "function") await page.waitForTimeout(250).catch(() => {});
    }
    const title = await page.title().catch(() => parsed.url.hostname);
    const finalUrl = page.url();
    const screenshot = await page.screenshot({ type: "jpeg", quality: JPEG_QUALITY, fullPage: false });
    const links = await collectLinks(page, width, captureHeight);
    return {
      ok: true,
      finalUrl,
      title,
      status: response?.status?.() || 0,
      screenshot: `data:image/jpeg;base64,${screenshot.toString("base64")}`,
      capture: { width, height: captureHeight },
      pageHeight,
      links
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function assertPublicRequest(value, dnsLookup, cache) {
  const url = new URL(value);
  if (["about:", "blob:", "data:"].includes(url.protocol)) return;
  const parsed = isAllowedTarget(url.toString());
  if (!parsed.ok) throw new Error("blocked_remote_browser_request");
  const hostname = parsed.url.hostname;
  if (!cache.has(hostname)) cache.set(hostname, assertPublicHostname(hostname, dnsLookup));
  await cache.get(hostname);
}

async function assertPublicHostname(hostname, dnsLookup) {
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error("blocked_remote_browser_host");
    return;
  }
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(records) || records.length === 0 || records.some((record) => isPrivateAddress(record.address))) {
    throw new Error("blocked_remote_browser_host");
  }
}

function isPrivateAddress(value) {
  const address = String(value || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(address) === 6) return true;
  if (isIP(address) !== 4) return true;
  const [a, b] = address.split(".").map(Number);
  const [, , c] = address.split(".").map(Number);
  return a === 0
    || a === 10
    || a === 127
    || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}

export function buildPageOptions(viewport = {}) {
  const width = clamp(Number(viewport.width), 360, 1920, 1365);
  const height = clamp(Number(viewport.height), 360, 1200, 900);
  const mobile = width <= MOBILE_WIDTH_MAX;
  return {
    viewport: { width, height },
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
    userAgent: mobile ? MOBILE_USER_AGENT : DESKTOP_USER_AGENT
  };
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error("Playwright ist im Worker-Image nicht installiert.");
  }
}

function clamp(value, min, max, fallback) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > maxBytes) throw new Error("Request zu gross.");
  }
  return body ? JSON.parse(body) : {};
}

function send(res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(payload, null, 2));
}

export function createServer({ renderer = renderWithPlaywright, token = TOKEN } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://worker.local");
      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, app: "smejj.com remote-browser-worker", codingWorker: true, activeCodingRun });
      }
      if (req.method === "POST" && url.pathname === "/run") {
        if (activeCodingRun) return send(res, 429, { ok: false, error: "coding_worker_busy" });
        const token = bearerToken(req.headers.authorization);
        if (!token) return send(res, 401, { ok: false, error: "worker_token_missing" });
        const body = await readJson(req, 2 * 1024 * 1024);
        const cancellation = requestCancellation(req, res);
        activeCodingRun = true;
        try {
          const result = await runCodingJob({
            ...body,
            workerToken: token,
            controlOrigin: process.env.SMEJJ_CONTROL_ORIGIN
          }, { signal: cancellation.signal });
          return send(res, 200, result);
        } finally {
          cancellation.dispose();
          activeCodingRun = false;
        }
      }
      if (req.method !== "POST" || url.pathname !== "/render") {
        return send(res, 404, { ok: false, error: "Not found" });
      }
      if (!isAuthorized(req, token)) return send(res, 401, { ok: false, error: "Unauthorized" });
      const body = await readJson(req);
      const result = await renderer(body);
      return send(res, result.ok ? 200 : 400, result);
    } catch (error) {
      return send(res, 500, { ok: false, error: String(error?.message || error).slice(0, 200) });
    }
  });
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

function bearerToken(value) {
  const match = String(value || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

export function startServer({ port = PORT, host = HOST } = {}) {
  const server = createServer();
  server.listen(port, host, () => console.log(`smejj.com remote-browser-worker: http://${host}:${port}`));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
