// smejj.com — Unit-Tests fuer die Live-Internet-Suche und Hilfsmodule.
// Ausfuehren: node --test src/search/webSearch.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { isSafePublicUrl, isAdOrRedirectUrl, shouldSearchWeb, searchWeb, clearSearchCache, parseSearxngResults, looksLikeProse, cleanSnippet, resolveBingLink, parseBingHtml } from "./webSearch.js";
import { createTtlCache } from "./searchCache.js";
import { createRateLimiter } from "../shared/rateLimiter.js";

test("isSafePublicUrl akzeptiert normale https-Ziele", () => {
  assert.equal(isSafePublicUrl("https://openai.com/"), true);
  assert.equal(isSafePublicUrl("https://de.wikipedia.org/wiki/OpenAI"), true);
});

test("isSafePublicUrl blockiert http, private Hosts und IPs", () => {
  assert.equal(isSafePublicUrl("http://example.com"), false);
  assert.equal(isSafePublicUrl("https://localhost/x"), false);
  assert.equal(isSafePublicUrl("https://127.0.0.1/x"), false);
  assert.equal(isSafePublicUrl("https://192.168.0.5/x"), false);
  assert.equal(isSafePublicUrl("https://10.0.0.1/x"), false);
  assert.equal(isSafePublicUrl("nicht-eine-url"), false);
});

test("Werbe-/Redirect-Links werden erkannt und aussortiert", () => {
  assert.equal(isAdOrRedirectUrl("https://duckduckgo.com/y.js?ad_provider=bingv7aa"), true);
  assert.equal(isAdOrRedirectUrl("https://www.bing.com/aclick?ld=x"), true);
  assert.equal(isAdOrRedirectUrl("https://openai.com/"), false);
  assert.equal(isSafePublicUrl("https://duckduckgo.com/y.js?ad_domain=x"), false);
});

test("shouldSearchWeb trifft bei aktuellen/zeitkritischen Fragen zu", () => {
  assert.equal(shouldSearchWeb("Wetter heute in Berlin"), true);
  assert.equal(shouldSearchWeb("Aktuelle Nachrichten"), true);
  assert.equal(shouldSearchWeb("Oeffnungszeiten Rewe Berlin"), true);
  assert.equal(shouldSearchWeb("Bitcoin Preis"), true);
  assert.equal(shouldSearchWeb("Wer hat die Wahl 2026 gewonnen?"), true);
  assert.equal(shouldSearchWeb("Welche Version von Node ist aktuell?"), true);
});

test("shouldSearchWeb trifft bei Adressen und ausdruecklicher Recherche zu", () => {
  assert.equal(shouldSearchWeb("Was steht auf https://smejj.com ?"), true);
  assert.equal(shouldSearchWeb("Nenne mir bitte eine Quelle dafuer"), true);
  assert.equal(shouldSearchWeb("Suche mir ein gutes Restaurant"), true);
});

// Option B: statisches Allgemeinwissen beantwortet das Modell direkt — wie bei
// fuehrenden Assistenten. Spart Zeit und Traffic, kein unnoetiger Suchlauf.
test("shouldSearchWeb sucht NICHT bei statischem Allgemeinwissen", () => {
  assert.equal(shouldSearchWeb("Was ist die Hauptstadt von Australien?"), false);
  assert.equal(shouldSearchWeb("Deutschland, Einwohnerzahl"), false);
  assert.equal(shouldSearchWeb("Was ergibt sieben mal acht?"), false);
  assert.equal(shouldSearchWeb("Erklaere mir Photosynthese"), false);
});

test("shouldSearchWeb ignoriert Smalltalk, Coding-Aufgaben und Codebloecke", () => {
  assert.equal(shouldSearchWeb("Refactor this function"), false);
  assert.equal(shouldSearchWeb("Bitte einen unified diff erstellen"), false);
  assert.equal(shouldSearchWeb("```js\nconst x = 1;\n```"), false);
  assert.equal(shouldSearchWeb(""), false);
  assert.equal(shouldSearchWeb("Hallo"), false);
  assert.equal(shouldSearchWeb("danke!"), false);
  assert.equal(shouldSearchWeb("ok"), false);
});

test("parseSearxngResults filtert Ads/private Ziele und begrenzt", () => {
  const data = {
    results: [
      { url: "https://openai.com/", title: "OpenAI", content: "Forschung" },
      { url: "https://duckduckgo.com/y.js?ad_provider=x", title: "Werbung", content: "Ad" },
      { url: "https://127.0.0.1/intern", title: "Intern", content: "privat" },
      { url: "https://de.wikipedia.org/wiki/KI", title: "KI", content: "Enzyklopaedie" }
    ]
  };
  const out = parseSearxngResults(data, 8);
  assert.equal(out.length, 2);
  assert.equal(out[0].url, "https://openai.com/");
  assert.equal(out[1].url, "https://de.wikipedia.org/wiki/KI");
  assert.equal(parseSearxngResults(data, 1).length, 1);
  assert.deepEqual(parseSearxngResults(null), []);
  assert.deepEqual(parseSearxngResults({}), []);
});

test("looksLikeProse erkennt Fliesstext und verwirft Markup-Fragmente", () => {
  assert.equal(looksLikeProse("Die Einwohnerzahl Deutschlands betraegt aktuell etwa 83,5 Millionen Menschen und waechst durch Zuwanderung."), true);
  assert.equal(looksLikeProse('"Anrede":{"wt":"[[Exzellenz (Titel)|Exzellenz]]"} <ref name=\\"x\\"> {{Internetquelle |url=...}}'), false);
  assert.equal(looksLikeProse("zu kurz"), false);
  assert.equal(looksLikeProse(""), false);
});

test("cleanSnippet entschaerft Pipe-/Menue-Ketten und kuerzt", () => {
  assert.equal(cleanSnippet("Bitcoin Kurs | Bitcoin live | BTC EUR | Wechselkurs"), "Bitcoin Kurs - Bitcoin live - BTC EUR - Wechselkurs");
  assert.equal(cleanSnippet("Normale Prosa ohne Trennzeichen."), "Normale Prosa ohne Trennzeichen.");
  assert.ok(cleanSnippet("x".repeat(400)).length <= 220);
  assert.equal(cleanSnippet(""), "");
});

test("TTL-Cache liefert Werte, verfaellt und haelt Kapazitaet", () => {
  const cache = createTtlCache({ ttlMs: 50, maxEntries: 2 });
  cache.set("a", 1);
  assert.equal(cache.get("a"), 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), 3);
});

test("TTL-Cache verfaellt nach Ablauf", async () => {
  const cache = createTtlCache({ ttlMs: 20, maxEntries: 10 });
  cache.set("k", "v");
  assert.equal(cache.get("k"), "v");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(cache.get("k"), undefined);
});

test("Rate-Limiter laesst bis zum Limit durch und blockt danach", () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 3 });
  assert.equal(limiter.check("ip1").allowed, true);
  assert.equal(limiter.check("ip1").allowed, true);
  assert.equal(limiter.check("ip1").allowed, true);
  const blocked = limiter.check("ip1");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  assert.equal(limiter.check("ip2").allowed, true);
});

test("Rate-Limiter oeffnet nach Fensterablauf wieder", async () => {
  const limiter = createRateLimiter({ windowMs: 30, max: 1 });
  assert.equal(limiter.check("x").allowed, true);
  assert.equal(limiter.check("x").allowed, false);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(limiter.check("x").allowed, true);
});

test("searchWeb ist bei leerer Query leer und stabil (Cache leerbar)", async () => {
  clearSearchCache();
  const empty = await searchWeb("");
  assert.deepEqual(empty, []);
});

// Bing-Redirects (/ck/a mit u=a1<base64url>) muessen auf die echte Ziel-URL dekodiert werden.
test("resolveBingLink dekodiert /ck/a-Redirects auf die Ziel-URL", () => {
  const target = "https://www.tagesschau.de/";
  const encoded = Buffer.from(target, "utf8").toString("base64url");
  const href = "https://www.bing.com/ck/a?!&&p=abc&u=a1" + encoded + "&ntb=1";
  assert.equal(resolveBingLink(href), target);
});

test("resolveBingLink laesst direkte https-Links durch und verwirft Muell", () => {
  assert.equal(resolveBingLink("https://example.org/x"), "https://example.org/x");
  assert.equal(resolveBingLink("https://www.bing.com/ck/a?!&&p=abc&ntb=1"), "");
  assert.equal(resolveBingLink(""), "");
});

test("parseBingHtml liefert echte URL + Snippet aus b_algo-Bloecken", () => {
  const encoded = Buffer.from("https://www.wetteronline.de/", "utf8").toString("base64url");
  const html = '<ol id="b_results"><li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&u=a1' + encoded + '&ntb=1">Wetter <b>Berlin</b></a></h2><div class="b_caption"><p>Aktuelle Wettervorhersage fuer Berlin mit Temperatur und Regenradar.</p></div></li></ol>';
  const results = parseBingHtml(html);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, "https://www.wetteronline.de/");
  assert.equal(results[0].title, "Wetter Berlin");
  assert.ok(results[0].snippet.includes("Wettervorhersage"));
});
