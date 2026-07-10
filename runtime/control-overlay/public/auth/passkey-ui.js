// smejj.com — Passkey-UI-Verdrahtung (Single Responsibility: Buttons im Konto-View).
// Bewusst als eigenes Modul, damit app.js unveraendert bleibt (Ratchet-Baseline).
// Bindet "Passkey einrichten" und "Mit Passkey anmelden" an public/auth/passkey.js.
import { hasPlatformAuthenticator, isPasskeySupported, loginWithPasskey, registerPasskey } from "./passkey.js";
import { API_ORIGIN } from "../config.js";

const SESSION_KEY = "smejj.session.v1";
const API_TOKEN_KEY = "smejj.apiToken.v1";

installAuthenticatedFetch();
completeSessionHandoff().catch((error) => writeOutput(`Anmeldung konnte nicht uebergeben werden: ${error?.message || error}`));

function ready(fn) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
  else fn();
}

function writeOutput(message) {
  const out = document.getElementById("profileOutput");
  if (out) out.textContent = message;
}

function setSessionStatus(text) {
  const el = document.getElementById("sessionStatus");
  if (el) el.textContent = text;
}

function persistSession(user, accessToken = "") {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      authenticated: true,
      mode: "passkey",
      user: { name: user?.name || "Passkey Nutzer", email: user?.email || "", userId: user?.userId || "" }
    }));
    if (accessToken) sessionStorage.setItem(API_TOKEN_KEY, accessToken);
  } catch {
    // Speichern ist optional.
  }
}

ready(async () => {
  const registerBtn = document.getElementById("passkeyRegister");
  const loginBtn = document.getElementById("passkeyLogin");
  if (!registerBtn && !loginBtn) return;

  if (!isPasskeySupported()) {
    for (const btn of [registerBtn, loginBtn]) {
      if (!btn) continue;
      btn.disabled = true;
      btn.title = "Dieses Geraet/dieser Browser unterstuetzt keine Passkeys.";
    }
    return;
  }
  // Reiner Hinweis, ob Face ID/Touch ID (Plattform-Authenticator) verfuegbar ist.
  const platform = await hasPlatformAuthenticator();
  if (platform && registerBtn) registerBtn.title = "Face ID / Touch ID / Fingerabdruck einrichten";

  registerBtn?.addEventListener("click", async () => {
    const email = document.getElementById("profileEmail")?.value?.trim() || "";
    const displayName = document.getElementById("profileName")?.value?.trim() || email || "smejj.com Nutzer";
    registerBtn.disabled = true;
    writeOutput("Passkey wird eingerichtet — bitte per Face ID / Touch ID / Fingerabdruck bestaetigen ...");
    try {
      const result = await registerPasskey({ email, displayName });
      persistSession(result.user, result.accessToken);
      setSessionStatus(`angemeldet (Passkey) — ${result.user?.email || result.user?.name || ""}`.trim());
      writeOutput("Passkey eingerichtet und angemeldet. Kein Passwort wurde gespeichert oder gesendet.");
    } catch (error) {
      writeOutput(`Passkey einrichten fehlgeschlagen: ${error?.message || error}`);
    } finally {
      registerBtn.disabled = false;
    }
  });

  loginBtn?.addEventListener("click", async () => {
    const email = document.getElementById("profileEmail")?.value?.trim() || "";
    loginBtn.disabled = true;
    writeOutput("Anmeldung mit Passkey — bitte per Face ID / Touch ID / Fingerabdruck bestaetigen ...");
    try {
      const result = await loginWithPasskey({ email });
      persistSession(result.user, result.accessToken);
      setSessionStatus(`angemeldet (Passkey) — ${result.user?.email || result.user?.name || ""}`.trim());
      writeOutput("Mit Passkey angemeldet. Kein Passwort wurde gespeichert oder gesendet.");
    } catch (error) {
      writeOutput(`Passkey-Anmeldung fehlgeschlagen: ${error?.message || error}`);
    } finally {
      loginBtn.disabled = false;
    }
  });
});

function installAuthenticatedFetch() {
  if (globalThis.__smejjAuthenticatedFetchInstalled || typeof globalThis.fetch !== "function") return;
  globalThis.__smejjAuthenticatedFetchInstalled = true;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init = {}) => {
    const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
    const options = { ...init };
    if (target.origin === API_ORIGIN && target.pathname.startsWith("/api/")) {
      const token = sessionStorage.getItem(API_TOKEN_KEY) || "";
      if (token) {
        const headers = new Headers(init.headers || (typeof input === "object" ? input.headers : undefined));
        if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
        options.headers = headers;
      }
    }
    const response = await originalFetch(input, options);
    if (target.origin === API_ORIGIN && /\/api\/auth\/(?:google|passkey\/(?:register|login)\/verify)$/.test(target.pathname)) {
      const data = await response.clone().json().catch(() => ({}));
      if (data.accessToken) sessionStorage.setItem(API_TOKEN_KEY, String(data.accessToken));
    }
    if (target.origin === API_ORIGIN && target.pathname === "/api/auth/logout" && response.ok) sessionStorage.removeItem(API_TOKEN_KEY);
    return response;
  };
}

async function completeSessionHandoff() {
  const params = new URLSearchParams(location.search);
  if (params.get("session-handoff") !== "1") return;
  const returnOrigin = String(params.get("returnOrigin") || "");
  const allowed = new Set(["https://smejj.com", "https://www.smejj.com"]);
  if (/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(returnOrigin)) allowed.add(returnOrigin);
  if (!allowed.has(returnOrigin) || !window.opener) throw new Error("Ungueltiges Rueckgabeziel.");
  const response = await fetch(`${API_ORIGIN}/api/auth/session-token`, { headers: { Accept: "application/json" } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.accessToken) throw new Error(data.error || "Anmeldung erforderlich.");
  window.opener.postMessage({
    type: "smejj:session-handoff",
    accessToken: data.accessToken,
    user: data.user || null
  }, returnOrigin);
  writeOutput("Anmeldung verbunden. Dieses Fenster kann geschlossen werden.");
  setTimeout(() => window.close(), 250);
}
