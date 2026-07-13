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

  const browser = await playwright.chromium.launch(browserLaunchOptions());
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
      const failedRequests = [];
      page.on("pageerror", (error) => errors.push(String(error.message || error).slice(0, 500)));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text().slice(0, 500)); });
      page.on("requestfailed", (request) => failedRequests.push({ url: safeUrl(request.url()), error: String(request.failure()?.errorText || "request_failed").slice(0, 200) }));
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
      const actions = await runActions(page, preview.actions);
      const evidence = await collectPageEvidence(page);
      const accessibility = await accessibilitySnapshot(page);
      const bytes = await page.screenshot({ type: "jpeg", quality: 70, fullPage: false });
      screenshots.push({ name: `${viewport.name}.jpg`, contentType: "image/jpeg", base64: Buffer.from(bytes).toString("base64") });
      checks.push({
        name: viewport.name,
        ok: (!response || response.ok()) && errors.length === 0 && failedRequests.length === 0 && actions.every((action) => action.ok) && accessibility.ok,
        status: response?.status() || 200,
        errors,
        failedRequests,
        actions,
        evidence,
        accessibility
      });
      await page.close();
    }
  } finally {
    signal?.removeEventListener?.("abort", abortBrowser);
    await browser.close();
  }
  return { required: true, ok: checks.every((check) => check.ok), url, checks, screenshots };
}

async function collectPageEvidence(page) {
  return page.evaluate(() => {
    const clean = (value, limit = 500) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
    const sensitive = (element) => /password|secret|token|api.?key|one.?time|otp/i.test([
      element.type,
      element.name,
      element.id,
      element.autocomplete,
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder")
    ].join(" "));
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const safeHref = (element) => {
      try {
        const url = new URL(element.href, location.href);
        return `${url.origin}${url.pathname}`.slice(0, 300);
      } catch {
        return "";
      }
    };
    const interactive = Array.from(document.querySelectorAll("a[href],button,input,textarea,select,[role='button'],[role='link'],[role='textbox']"))
      .filter((element) => visible(element) && !sensitive(element))
      .slice(0, 80)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        role: clean(element.getAttribute("role"), 40),
        type: clean(element.getAttribute("type"), 40),
        id: clean(element.id, 120),
        name: clean(element.getAttribute("name"), 120),
        ariaLabel: clean(element.getAttribute("aria-label"), 200),
        placeholder: clean(element.getAttribute("placeholder"), 200),
        text: clean(element.innerText || element.textContent, 240),
        href: element.matches("a[href]") ? safeHref(element) : ""
      }));
    return {
      title: clean(document.title, 240),
      url: String(location.href).slice(0, 500),
      headings: Array.from(document.querySelectorAll("h1,h2,h3"))
        .filter(visible)
        .slice(0, 30)
        .map((element) => ({ level: element.tagName.toLowerCase(), text: clean(element.innerText || element.textContent, 300) })),
      interactive,
      visibleText: clean(document.body?.innerText, 6_000)
    };
  });
}

function browserLaunchOptions() {
  const executablePath = process.env.SMEJJ_PLAYWRIGHT_CHROMIUM_EXECUTABLE === "/usr/bin/chromium-browser"
    ? "/usr/bin/chromium-browser"
    : undefined;
  return {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-software-rasterizer"],
    ...(executablePath ? { executablePath } : {})
  };
}

async function runActions(page, actions) {
  const results = [];
  for (const action of Array.isArray(actions) ? actions.slice(0, 20) : []) {
    let normalized = { type: String(action?.type || ""), selector: String(action?.selector || "") };
    try {
      normalized = safeAction(action);
      const locator = page.locator(normalized.selector);
      if (await locator.count() !== 1) throw new Error("browser_action_selector_not_unique");
      if (normalized.type === "click") await locator.click({ timeout: 10_000 });
      if (normalized.type === "fill") {
        const forbidden = await locator.evaluate((element) => element.type === "password" || /password|secret|token|api.?key/i.test(`${element.name} ${element.id} ${element.autocomplete}`));
        if (forbidden) throw new Error("browser_sensitive_input_forbidden");
        await locator.fill(normalized.value, { timeout: 10_000 });
      }
      if (normalized.type === "press") await locator.press(normalized.value, { timeout: 10_000 });
      results.push({ type: normalized.type, selector: normalized.selector, ok: true });
    } catch (error) {
      results.push({ type: normalized.type, selector: normalized.selector, ok: false, error: String(error?.message || error).slice(0, 300) });
    }
  }
  return results;
}

function safeAction(action = {}) {
  const type = String(action.type || "");
  const selector = String(action.selector || "").trim();
  const value = String(action.value || "");
  if (!new Set(["click", "fill", "press"]).has(type) || !selector || selector.length > 200 || /password|secret|token|api.?key/i.test(selector)) throw new Error("browser_action_invalid");
  if (type === "fill" && value.length > 2_000) throw new Error("browser_action_value_too_large");
  if (type === "press" && !new Set(["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]).has(value)) throw new Error("browser_action_key_forbidden");
  return { type, selector, value };
}

async function accessibilitySnapshot(page) {
  return page.evaluate(() => {
    const unlabeledInputs = Array.from(document.querySelectorAll("input,textarea,select")).filter((element) => {
      if (element.type === "hidden") return false;
      return !element.getAttribute("aria-label") && !element.getAttribute("aria-labelledby") && !element.labels?.length;
    }).length;
    const missingAlt = Array.from(document.images).filter((image) => !image.hasAttribute("alt")).length;
    return { ok: unlabeledInputs === 0 && missingAlt === 0, unlabeledInputs, missingAlt };
  });
}

function safeUrl(value) {
  try { const url = new URL(value); return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 500); }
  catch { return "invalid-url"; }
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
