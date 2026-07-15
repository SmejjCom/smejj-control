// smejj.com — Live-Internet-Suche (free-only, ohne API-Key, fail-closed).
// Quellen: DuckDuckGo HTML, DuckDuckGo Lite, Bing HTML — alle kostenlos, keine Keys,
// keine Paid-Fallbacks. Sicherheit: nur https, keine privaten Ziele (SSRF-Schutz),
// harte Timeouts, begrenzte Antwortgroessen. Fehler ergeben leere Resultate, nie Abbruch.
// Ergebnisse werden kurz gecacht (TTL), damit identische Anfragen die Suchmaschinen
// nicht wiederholt treffen (Schutz vor Blocking, schnellere Antworten).
import { createTtlCache } from "./searchCache.js";

const SEARCH_CACHE_TTL_MS = 600000;
const searchResultCache = createTtlCache({ ttlMs: SEARCH_CACHE_TTL_MS, maxEntries: 500 });

// Nur fuer Tests: Cache leeren, damit Faelle deterministisch bleiben.
export function clearSearchCache() {
  searchResultCache.clear();
}

// SearXNG (optional, konfigurierbar): bevorzugte JSON-Quelle, wenn ein eigener
// SearXNG-Endpunkt gesetzt ist (open-source, kostenlos, kein Key). Standard ist AUS
// (leerer String) -> Verhalten identisch zu vorher (DuckDuckGo/Bing). Fail-safe:
// leeres/fehlerhaftes Ergebnis faellt automatisch auf die HTML-Suche zurueck.
const SEARXNG_URL = String((globalThis.process && globalThis.process.env && globalThis.process.env.SMEJJ_SEARXNG_URL) || "").trim().replace(/\/+$/, "");

const SEARCH_TIMEOUT_MS = 8000;
const PAGE_TIMEOUT_MS = 6000;
const MAX_BODY_BYTES = 600000;
const MAX_EXCERPT_CHARS = 2200;
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 smejj-live-search";

const PRIVATE_HOST_PATTERN = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1)/i;

function decodeEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, String.fromCharCode(34))
    .replace(/&#x27;/g, String.fromCharCode(39))
    .replace(/&#39;/g, String.fromCharCode(39))
    .replace(/&nbsp;/g, " ");
}

function stripTags(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

// Werbe-/Redirect-Links der Suchmaschinen (keine echten Treffer) aussortieren.
const AD_URL_PATTERN = /(duckduckgo\.com\/y\.js|\/aclick|bing\.com\/aclk|duckduckgo\.com\/l\/|ad_provider=|ad_domain=)/i;

export function isAdOrRedirectUrl(target) {
  return AD_URL_PATTERN.test(String(target || ""));
}

export function isSafePublicUrl(target) {
  let parsed;
  try { parsed = new URL(target); } catch { return false; }
  if (parsed.protocol !== "https:") return false;
  if (PRIVATE_HOST_PATTERN.test(parsed.hostname)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname)) return false;
  if (isAdOrRedirectUrl(target)) return false;
  return true;
}

async function fetchText(target, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "de,en;q=0.8",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5"
      }
    });
    if (!response.ok) return "";
    const type = String(response.headers.get("content-type") || "");
    if (!/text\/html|text\/plain|application\/xhtml/.test(type)) return "";
    const reader = response.body && response.body.getReader ? response.body.getReader() : null;
    if (!reader) return (await response.text()).slice(0, MAX_BODY_BYTES);
    const chunks = [];
    let received = 0;
    while (received < MAX_BODY_BYTES) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
      received += part.value.length;
    }
    try { await reader.cancel(); } catch { /* Stream bereits beendet */ }
    let merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(merged.slice(0, MAX_BODY_BYTES));
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function resolveDuckDuckGoLink(href) {
  const raw = decodeEntities(String(href || ""));
  if (raw.includes("duckduckgo.com/l/")) {
    const match = raw.match(/[?&]uddg=([^&]+)/);
    if (!match) return "";
    try { return decodeURIComponent(match[1]); } catch { return ""; }
  }
  if (raw.startsWith("http")) return raw;
  return "";
}

function parseDuckDuckGoHtml(html) {
  const results = [];
  const linkPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetPattern = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [];
  let match;
  while ((match = snippetPattern.exec(html)) !== null) snippets.push(stripTags(match[1]));
  let index = 0;
  while ((match = linkPattern.exec(html)) !== null) {
    const url = resolveDuckDuckGoLink(match[1]);
    const title = stripTags(match[2]);
    if (url && title && isSafePublicUrl(url)) {
      results.push({ title, url, snippet: snippets[index] || "" });
    }
    index += 1;
  }
  return results;
}

function parseDuckDuckGoLite(html) {
  const results = [];
  const pattern = /<a[^>]+href="([^"]+)"[^>]*class=.result-link.[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const url = resolveDuckDuckGoLink(match[1]);
    const title = stripTags(match[2]);
    if (url && title && isSafePublicUrl(url)) results.push({ title, url, snippet: "" });
  }
  return results;
}

// Bing verpackt organische Treffer in /ck/a-Redirects (u=a1<base64url>).
// Wir dekodieren auf die echte Ziel-URL; ohne dekodierbare URL wird der Treffer verworfen.
export function resolveBingLink(href) {
  const raw = decodeEntities(String(href || ""));
  if (/bing\.[a-z.]+\/ck\/a/i.test(raw)) {
    const match = raw.match(/[?&]u=a1([^&"]+)/);
    if (!match) return "";
    try {
      const b64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      const decoded = Buffer.from(padded, "base64").toString("utf8");
      return decoded.startsWith("http") ? decoded : "";
    } catch { return ""; }
  }
  if (raw.startsWith("http")) return raw;
  return "";
}

export function parseBingHtml(html) {
  const results = [];
  const pattern = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<li class="b_algo"|<\/ol>|$)/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const url = resolveBingLink(match[1]);
    const title = stripTags(match[2]);
    const caption = match[3].match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const snippet = caption ? stripTags(caption[1]) : "";
    if (title && isSafePublicUrl(url)) results.push({ title, url, snippet });
  }
  return results;
}

// SearXNG-JSON-Antwort in unser Ergebnisformat wandeln (rein, testbar).
// Wendet denselben SSRF-/Ad-Filter an wie die HTML-Quellen (isSafePublicUrl).
export function parseSearxngResults(data, limit = 8) {
  const rows = Array.isArray(data && data.results) ? data.results : [];
  const out = [];
  for (const row of rows) {
    const url = String((row && row.url) || "");
    const title = stripTags(String((row && row.title) || ""));
    if (url && title && isSafePublicUrl(url)) {
      out.push({ title, url, snippet: stripTags(String((row && row.content) || "")) });
    }
    if (out.length >= limit) break;
  }
  return out;
}

// Konfigurierten SearXNG-Endpunkt abfragen (JSON). Trusted Operator-Config:
// die Basis-URL darf http/https sein; Ergebnis-URLs bleiben SSRF-gefiltert.
async function searxngJson(query, limit) {
  if (!SEARXNG_URL) return [];
  let base;
  try {
    base = new URL(SEARXNG_URL);
    if (base.protocol !== "https:" && base.protocol !== "http:") return [];
  } catch {
    return [];
  }
  const target = SEARXNG_URL + "/search?format=json&language=de&safesearch=1&q=" + encodeURIComponent(query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" }
    });
    if (!response.ok) return [];
    const data = await response.json();
    return parseSearxngResults(data, limit);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function searchWeb(query, options) {
  const settings = options || {};
  const limit = Math.min(Math.max(Number(settings.limit) || 5, 1), 10);
  const trimmed = String(query || "").trim().slice(0, 300);
  if (!trimmed) return [];
  const cacheKey = trimmed.toLowerCase() + "|" + limit;
  const cached = searchResultCache.get(cacheKey);
  if (cached) return cached.slice();
  // Bevorzugt SearXNG (falls konfiguriert), sonst HTML-Suchmaschinen als Fallback.
  if (SEARXNG_URL) {
    const sx = await searxngJson(trimmed, limit);
    if (sx.length > 0) {
      searchResultCache.set(cacheKey, sx);
      return sx.slice();
    }
  }
  const encoded = encodeURIComponent(trimmed);
  const attempts = [
    { url: "https://html.duckduckgo.com/html/?q=" + encoded + "&kl=de-de", parse: parseDuckDuckGoHtml },
    { url: "https://lite.duckduckgo.com/lite/?q=" + encoded, parse: parseDuckDuckGoLite },
    { url: "https://www.bing.com/search?q=" + encoded + "&setlang=de", parse: parseBingHtml }
  ];
  for (const attempt of attempts) {
    const html = await fetchText(attempt.url, SEARCH_TIMEOUT_MS);
    if (!html) continue;
    const results = attempt.parse(html);
    if (results.length > 0) {
      const limited = results.slice(0, limit);
      searchResultCache.set(cacheKey, limited);
      return limited.slice();
    }
  }
  return [];
}

// Prueft, ob ein Text ueberwiegend Fliesstext (Prosa) ist und nicht Roh-Markup,
// JSON- oder Menue-Fragmente. Verhindert, dass unlesbare Auszuege ins Modell gelangen.
export function looksLikeProse(text) {
  const value = String(text || "").trim();
  if (value.length < 40) return false;
  const markup = (value.match(/[{}\[\]|<>]|":"|"wt"/g) || []).length;
  const words = value.split(/\s+/).length;
  return markup / Math.max(words, 1) < 0.06;
}

export async function fetchPageExcerpt(target) {
  if (!isSafePublicUrl(target)) return "";
  const html = await fetchText(target, PAGE_TIMEOUT_MS);
  if (!html) return "";
  // Nur den Body, ohne Navigation/Kopf-/Fusszeilen/Seitenleisten/Formulare.
  const body = html
    .replace(/^[\s\S]*?<body[^>]*>/i, " ")
    .replace(/<\/body>[\s\S]*$/i, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ");
  // Reste von Wiki-/Template-Markup entfernen, dann Text extrahieren.
  const text = stripTags(body)
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_EXCERPT_CHARS);
  // Unlesbare (markuplastige) Auszuege verwerfen -> Modell nutzt dann Titel/Snippet.
  return looksLikeProse(text) ? text : "";
}

// Reine Smalltalk-/Begruessungs-Eingaben brauchen keine Websuche.
const SMALLTALK_PATTERN = /^(hi|hallo|hey|servus|moin|hey smejj|danke|dankeschoen|merci|ok|okay|alles klar|tschuess|tschuss|bye|ciao|gute nacht|guten morgen|guten tag)\b[\s!.?]*$/i;
// Klare Coding-Absicht wird separat behandelt und braucht keine Websuche.
const CODING_SKIP_PATTERN = /unified diff|\bpatch\b|\brefactor|\bdebug\b|\bstack ?trace\b/i;

// Zeitkritische/veraenderliche Fakten -> Websuche ist Pflicht.
const RECENCY_PATTERN = /\b(aktuell|aktuelle|aktuelles|aktuellen|aktueller|heute|heutige|heutigen|gestern|morgen|jetzt|gerade|momentan|derzeit|neu|neue|neuen|neueste|neuesten|letzte|letzten|live|news|nachrichten|schlagzeilen|wetter|temperatur|vorhersage|regen|schnee|sturm|preis|preise|kosten|kurs|kurse|aktie|aktien|bitcoin|wechselkurs|inflation|oeffnungszeit|oeffnungszeiten|fahrplan|verspaetung|spielstand|ergebnis|ergebnisse|tabelle|wahl|wahlen|umfrage|version|release|changelog|verfuegbar|stand|trend|trends)\b/i;
// Jahres- oder Monatsbezug deutet auf eine Aktualitaetsfrage hin.
const DATE_PATTERN = /\b(19|20)\d{2}\b|\b(januar|februar|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\b/i;
// Nutzer verlangt ausdruecklich Quellen, Links oder eine Recherche.
const EXPLICIT_SEARCH_PATTERN = /\b(quelle|quellen|beleg|belege|belegt|link|links|url|website|webseite|internet|google|recherche|recherchier|nachschlagen|zusammenfass)\b|\bsuch(e|en)\b/i;
// Eine konkrete Adresse im Text soll immer live geholt werden.
const URL_IN_TEXT_PATTERN = /https?:\/\/[^\s)]+/i;

// smejj.com sucht wie fuehrende Assistenten NUR dann live im Internet, wenn die
// Frage Aktualitaet, eine konkrete Adresse oder einen ausdruecklichen Beleg braucht.
// Statisches Allgemeinwissen beantwortet das Modell direkt: schneller, guenstiger
// und ohne unnoetigen Traffic. Fail-safe: im Zweifel keine Suche.
export function shouldSearchWeb(task) {
  const text = String(task || "").trim();
  if (text.length < 3 || text.length > 400) return false;
  if (text.includes(String.fromCharCode(96, 96, 96))) return false;
  if (SMALLTALK_PATTERN.test(text)) return false;
  if (CODING_SKIP_PATTERN.test(text)) return false;
  if (URL_IN_TEXT_PATTERN.test(text)) return true;
  if (EXPLICIT_SEARCH_PATTERN.test(text)) return true;
  if (RECENCY_PATTERN.test(text)) return true;
  if (DATE_PATTERN.test(text)) return true;
  return false;
}

// Snippet aufraeumen: Pipe-/Menue-Ketten und Navigationsreste entschaerfen, kuerzen.
// So bekommt das Modell weniger Roh-Ticker-Text zum Wiedergeben (bessere Zusammenfassung).
export function cleanSnippet(text) {
  return String(text || "")
    .replace(/\s*[|›»·•]\s*/g, " - ")
    .replace(/\s{2,}/g, " ")
    .replace(/(?:\s-\s){2,}/g, " - ")
    .trim()
    .slice(0, 220);
}

export async function buildWebContextBlock(query, options) {
  try {
    const settings = options || {};
    const results = await searchWeb(query, { limit: settings.maxResults || 5 });
    if (results.length === 0) return "";
    const lines = results.map(function (result, index) {
      const head = (index + 1) + ". " + result.title;
      const src = "   " + result.url;
      const snippet = cleanSnippet(result.snippet);
      return snippet ? head + "\n" + src + "\n   " + snippet : head + "\n" + src;
    });
    const excerpts = [];
    const pageCount = Math.min(settings.withPages === undefined ? 2 : settings.withPages, results.length);
    for (let index = 0; index < pageCount; index += 1) {
      const excerpt = await fetchPageExcerpt(results[index].url);
      if (excerpt) excerpts.push("Auszug aus " + results[index].url + ":\n" + excerpt);
    }
    const header = "Live-Internet-Kontext (Websuche vom " + new Date().toISOString() + "):";
    return [header, lines.join("\n")].concat(excerpts).join("\n\n");
  } catch {
    return "";
  }
}
