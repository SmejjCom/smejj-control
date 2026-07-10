import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { safeRelativePath } from "./sandbox.mjs";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 }
];

export async function runBrowserVerification(root, preview = {}, { loadPlaywright, signal = null } = {}) {
  if (preview.required !== true) return { required: false, ok: true, checks: [], screenshots: [] };
  throwIfAborted(signal);
  const url = previewUrl(root, preview);
  if (!url) return { required: true, ok: false, error: "preview_url_required", checks: [], screenshots: [] };

  let playwright;
  try {
    playwright = loadPlaywright ? await loadPlaywright() : await import("playwright");
  } catch {
    return { required: true, ok: false, error: "playwright_runtime_missing", checks: [], screenshots: [] };
  }

  const browser = await playwright.chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const checks = [];
  const screenshots = [];
  const networkSafety = new Map();
  const abortBrowser = () => browser.close().catch(() => {});
  signal?.addEventListener?.("abort", abortBrowser, { once: true });
  try {
    for (const viewport of VIEWPORTS) {
      throwIfAborted(signal);
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error.message || error).slice(0, 500)));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text().slice(0, 500)); });
      await page.route("**/*", async (route) => {
        try {
          await assertSafeRequestUrl(root, route.request().url(), networkSafety);
          await route.continue();
        } catch (error) {
          errors.push(String(error?.message || error).slice(0, 500));
          await route.abort("blockedbyclient");
        }
      });
      const response = await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
      const bytes = await page.screenshot({ type: "jpeg", quality: 70, fullPage: false });
      screenshots.push({ name: `${viewport.name}.jpg`, contentType: "image/jpeg", base64: Buffer.from(bytes).toString("base64") });
      checks.push({
        name: viewport.name,
        ok: (!response || response.ok()) && errors.length === 0,
        status: response?.status() || 200,
        errors
      });
      await page.close();
    }
  } finally {
    signal?.removeEventListener?.("abort", abortBrowser);
    await browser.close();
  }
  return { required: true, ok: checks.every((check) => check.ok), url, checks, screenshots };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("job_cancelled");
}

function previewUrl(root, preview) {
  const external = String(preview.url || "").trim();
  if (external) return validatedExternalUrl(external);
  if (preview.staticPath) return pathToFileURL(path.join(root, safeRelativePath(preview.staticPath))).toString();
  return "";
}

async function assertSafeRequestUrl(root, value, cache) {
  const parsed = new URL(value);
  if (["about:", "blob:", "data:"].includes(parsed.protocol)) return;
  if (parsed.protocol === "file:") {
    const relative = path.relative(path.resolve(root), path.resolve(fileURLToPath(parsed)));
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("browser_file_request_outside_workspace");
    return;
  }
  const normalized = validatedExternalUrl(value);
  const target = new URL(normalized);
  if (isLoopback(target.hostname)) return;
  if (!cache.has(target.hostname)) cache.set(target.hostname, resolvePublicHostname(target.hostname));
  await cache.get(target.hostname);
}

function validatedExternalUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { throw new Error("browser_preview_url_invalid"); }
  if (parsed.username || parsed.password) throw new Error("browser_preview_credentials_forbidden");
  if (isLoopback(parsed.hostname) && parsed.protocol === "http:") return parsed.toString();
  if (parsed.protocol !== "https:" || isUnsafeAddress(parsed.hostname)) throw new Error("browser_preview_private_network_forbidden");
  return parsed.toString();
}

async function resolvePublicHostname(hostname) {
  if (isIP(hostname)) return;
  let records;
  try { records = await lookup(hostname, { all: true, verbatim: true }); } catch { throw new Error("browser_preview_dns_failed"); }
  if (!records.length || records.some((record) => isUnsafeAddress(record.address))) throw new Error("browser_preview_private_network_forbidden");
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isUnsafeAddress(hostname) {
  const value = String(hostname || "").toLowerCase();
  if (!value || isLoopback(value) || value === "0.0.0.0" || value.endsWith(".local") || value.endsWith(".internal") || value.endsWith(".localhost")) return true;
  if (isIP(value) === 6) return true;
  if (isIP(value) !== 4) return false;
  const [a, b] = value.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
