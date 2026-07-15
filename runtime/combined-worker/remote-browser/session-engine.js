// smejj.com Remote-Browser Session-Engine.
// Interaktive Browser-Sessions fuer den Live-Browser: eine Playwright-Seite
// bleibt pro Session offen, Aktionen (Klick, Tippen, Scrollen, Navigation)
// werden deterministisch ausgefuehrt und liefern jeweils einen frischen
// Viewport-Screenshot zurueck. Fail-closed: unbekannte Aktionen, unbekannte
// Sessions und blockierte Ziele werden abgelehnt. Sessions enden automatisch
// (Idle-Timeout + Hard-Limit) — keine laufenden Fixkosten.
// Sicherheits-Helfer (SSRF-Schutz) kommen per Dependency Injection aus
// worker.js, damit exakt dieselben Pruefungen gelten wie beim Einmal-Rendern.
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";

export const SESSION_DEFAULTS = {
  maxSessions: 2,
  idleTimeoutMs: 90_000,
  hardLimitMs: 600_000,
  actionTimeoutMs: 15_000,
  navTimeoutMs: 25_000,
  settleTimeoutMs: 4_000,
  jpegQuality: 70,
  typeMaxChars: 2_000,
  scrollMaxPx: 4_000
};

export const SESSION_ALLOWED_KEYS = new Set([
  "Enter", "Tab", "Escape", "Backspace", "Delete",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "PageUp", "PageDown", "Home", "End"
]);

// Pure Validierung des Aktions-Objekts (ohne Playwright testbar).
// Liefert fail-closed { ok:false, error } oder { ok:true, action } mit
// normalisierten Werten.
export function validateSessionAction(action, limits = SESSION_DEFAULTS) {
  if (!action || typeof action !== "object" || typeof action.type !== "string") {
    return { ok: false, error: "action_missing" };
  }
  switch (action.type) {
    case "click": {
      const xPct = Number(action.xPct);
      const yPct = Number(action.yPct);
      if (!Number.isFinite(xPct) || !Number.isFinite(yPct) || xPct < 0 || xPct > 100 || yPct < 0 || yPct > 100) {
        return { ok: false, error: "click_coordinates_invalid" };
      }
      const button = action.button === "right" ? "right" : "left";
      const clicks = action.clicks === 2 ? 2 : 1;
      return { ok: true, action: { type: "click", xPct, yPct, button, clicks } };
    }
    case "type": {
      const text = typeof action.text === "string" ? action.text : "";
      if (!text || text.length > limits.typeMaxChars) return { ok: false, error: "type_text_invalid" };
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return { ok: false, error: "type_text_invalid" };
      return { ok: true, action: { type: "type", text } };
    }
    case "key": {
      const key = String(action.key || "");
      if (!SESSION_ALLOWED_KEYS.has(key)) return { ok: false, error: "key_not_allowed" };
      return { ok: true, action: { type: "key", key } };
    }
    case "scroll": {
      const deltaY = Number(action.deltaY);
      if (!Number.isFinite(deltaY) || deltaY === 0) return { ok: false, error: "scroll_delta_invalid" };
      const clamped = Math.max(-limits.scrollMaxPx, Math.min(limits.scrollMaxPx, Math.round(deltaY)));
      return { ok: true, action: { type: "scroll", deltaY: clamped } };
    }
    case "navigate": {
      const url = String(action.url || "");
      if (!/^https?:\/\//i.test(url) || url.length > 2_000) return { ok: false, error: "navigate_url_invalid" };
      return { ok: true, action: { type: "navigate", url } };
    }
    case "back":
    case "forward":
    case "reload":
      return { ok: true, action: { type: action.type } };
    default:
      return { ok: false, error: "action_unknown" };
  }
}

export function createSessionEngine({
  isAllowedTarget,
  buildPageOptions,
  assertPublicHostname,
  assertPublicRequest,
  playwrightLoader,
  dnsLookup = lookup,
  now = Date.now,
  randomId = () => randomBytes(16).toString("hex"),
  ...overrides
} = {}) {
  if (typeof isAllowedTarget !== "function" || typeof buildPageOptions !== "function"
    || typeof assertPublicHostname !== "function" || typeof assertPublicRequest !== "function"
    || typeof playwrightLoader !== "function") {
    throw new Error("session_engine_dependencies_missing");
  }
  const cfg = { ...SESSION_DEFAULTS, ...overrides };
  const sessions = new Map();

  function fail(status, error) {
    return { ok: false, status, error: String(error || "session_error").slice(0, 200) };
  }

  function expiresInMs(session) {
    const idleLeft = cfg.idleTimeoutMs;
    const hardLeft = Math.max(0, session.createdAt + cfg.hardLimitMs - now());
    return Math.min(idleLeft, hardLeft);
  }

  function touch(session) {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      destroy(session.id).catch(() => {});
    }, cfg.idleTimeoutMs);
    // Der Timer darf einen ansonsten fertigen Prozess nicht am Leben halten.
    session.idleTimer.unref?.();
  }

  async function destroy(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    sessions.delete(sessionId);
    clearTimeout(session.idleTimer);
    await session.browser.close().catch(() => {});
    return true;
  }

  async function snapshot(session) {
    const page = session.page;
    const screenshot = await page.screenshot({ type: "jpeg", quality: cfg.jpegQuality });
    const title = await page.title().catch(() => "");
    return {
      ok: true,
      sessionId: session.id,
      screenshot: `data:image/jpeg;base64,${screenshot.toString("base64")}`,
      finalUrl: page.url(),
      title,
      viewport: session.viewport,
      expiresInMs: expiresInMs(session)
    };
  }

  async function open({ url, viewport = {} } = {}) {
    if (sessions.size >= cfg.maxSessions) return fail(429, "session_limit_reached");
    const parsed = isAllowedTarget(url);
    if (!parsed.ok) return fail(400, parsed.error);
    try {
      await assertPublicHostname(parsed.url.hostname, dnsLookup);
    } catch {
      return fail(400, "Ziel-Host ist blockiert.");
    }
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
      page.setDefaultTimeout(cfg.actionTimeoutMs);
      await page.goto(parsed.url.toString(), { waitUntil: "domcontentloaded", timeout: cfg.navTimeoutMs });
      await page.waitForLoadState("networkidle", { timeout: cfg.settleTimeoutMs }).catch(() => {});
      const session = {
        id: randomId(),
        browser,
        page,
        viewport: pageOptions.viewport,
        createdAt: now(),
        idleTimer: null,
        busy: false
      };
      sessions.set(session.id, session);
      touch(session);
      return await snapshot(session);
    } catch (error) {
      await browser.close().catch(() => {});
      return fail(502, error?.message || error);
    }
  }

  async function performAction(session, action) {
    const page = session.page;
    const { width, height } = session.viewport;
    switch (action.type) {
      case "click": {
        const x = Math.round((action.xPct / 100) * width);
        const y = Math.round((action.yPct / 100) * height);
        await page.mouse.click(x, y, { button: action.button, clickCount: action.clicks });
        await page.waitForLoadState("domcontentloaded", { timeout: cfg.settleTimeoutMs }).catch(() => {});
        await page.waitForTimeout?.(350)?.catch?.(() => {});
        return;
      }
      case "type":
        await page.keyboard.type(action.text, { delay: 15 });
        return;
      case "key":
        await page.keyboard.press(action.key);
        await page.waitForLoadState("domcontentloaded", { timeout: cfg.settleTimeoutMs }).catch(() => {});
        await page.waitForTimeout?.(250)?.catch?.(() => {});
        return;
      case "scroll":
        await page.mouse.wheel(0, action.deltaY);
        await page.waitForTimeout?.(150)?.catch?.(() => {});
        return;
      case "navigate": {
        const parsed = isAllowedTarget(action.url);
        if (!parsed.ok) throw new Error(parsed.error);
        await assertPublicHostname(parsed.url.hostname, dnsLookup);
        await page.goto(parsed.url.toString(), { waitUntil: "domcontentloaded", timeout: cfg.navTimeoutMs });
        await page.waitForLoadState("networkidle", { timeout: cfg.settleTimeoutMs }).catch(() => {});
        return;
      }
      case "back":
        await page.goBack({ waitUntil: "domcontentloaded", timeout: cfg.navTimeoutMs }).catch(() => {});
        return;
      case "forward":
        await page.goForward({ waitUntil: "domcontentloaded", timeout: cfg.navTimeoutMs }).catch(() => {});
        return;
      case "reload":
        await page.reload({ waitUntil: "domcontentloaded", timeout: cfg.navTimeoutMs }).catch(() => {});
        return;
      default:
        throw new Error("action_unknown");
    }
  }

  async function act({ sessionId, action } = {}) {
    const session = sessions.get(String(sessionId || ""));
    if (!session) return fail(404, "session_unknown");
    if (now() - session.createdAt > cfg.hardLimitMs) {
      await destroy(session.id);
      return fail(410, "session_expired");
    }
    const verdict = validateSessionAction(action, cfg);
    if (!verdict.ok) return fail(400, verdict.error);
    if (session.busy) return fail(409, "session_busy");
    session.busy = true;
    try {
      await performAction(session, verdict.action);
      touch(session);
      return await snapshot(session);
    } catch (error) {
      return fail(502, error?.message || error);
    } finally {
      session.busy = false;
    }
  }

  async function close({ sessionId } = {}) {
    const closed = await destroy(String(sessionId || ""));
    return { ok: true, closed };
  }

  async function closeAll() {
    const ids = [...sessions.keys()];
    for (const id of ids) await destroy(id);
    return { ok: true, closed: ids.length };
  }

  return { open, act, close, closeAll, count: () => sessions.size };
}
