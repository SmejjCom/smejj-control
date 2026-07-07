import test from "node:test";
import assert from "node:assert/strict";
import { buildIndex, searchIndex, tokenize } from "../control-server/src/rag/bm25Index.js";
import { chunkMarkdown, loadKnowledgeChunks } from "../control-server/src/rag/knowledgeLoader.js";
import { buildRagContextBlock } from "../control-server/src/rag/agentContext.js";
import { buildRagIndexArtifact, exportRagIndex, idriveConfigFromEnv } from "../scripts/rag/export_rag_index_to_idrive.mjs";

test("rag index export is fail-closed without idrive env and uploads with injected writer", async () => {
  const emptyEnv = {};
  assert.equal(idriveConfigFromEnv(emptyEnv).complete, false);
  const dry = await exportRagIndex({ env: emptyEnv, now: new Date("2026-07-03T10:00:00Z") });
  assert.equal(dry.ok, false);
  assert.equal(dry.mode, "write-plan-only");
  assert.ok(dry.chunkCount > 20);
  assert.deepEqual(dry.plannedObjects, ["rag/knowledge-index/2026-07-03/index.json", "rag/knowledge-index/latest.json"]);

  const fullEnv = { IDRIVE_E2_ENDPOINT: "https://s3.example.test", IDRIVE_E2_BUCKET: "b", IDRIVE_E2_ACCESS_KEY: "a", IDRIVE_E2_SECRET_KEY: "s" };
  const puts = [];
  const uploaded = await exportRagIndex({ env: fullEnv, put: async (object) => puts.push(object.key), now: new Date("2026-07-03T10:00:00Z") });
  assert.equal(uploaded.ok, true);
  assert.deepEqual(puts, ["rag/knowledge-index/2026-07-03/index.json", "rag/knowledge-index/latest.json"]);
  assert.equal(uploaded.sha256, dry.sha256, "artifact must be deterministic for same time input");
});

test("rag index artifact is valid, self-describing json", async () => {
  const artifact = await buildRagIndexArtifact(process.cwd(), new Date("2026-07-03T10:00:00Z"));
  const parsed = JSON.parse(artifact.body);
  assert.equal(parsed.artifact, "smejj.com-rag-knowledge-index");
  assert.equal(parsed.chunkCount, artifact.chunkCount);
  assert.ok(parsed.index.documents.length === parsed.chunkCount);
});

test("agent rag context block marks project knowledge as internal background", async () => {
  const block = await buildRagContextBlock(process.cwd(), "Wie wurde der Cloudflare Exit umgesetzt?", 3);
  assert.ok(block.startsWith("Internes Projektwissen"));
  assert.ok(block.includes("niemals als oeffentliche Quelle"));
  assert.ok(block.includes("[intern:"), "expected internal source markers");
  assert.ok(/Memory_Bank\.md|docs\//.test(block));
});

test("agent rag context block is fail-closed on unusable input", async () => {
  assert.equal(await buildRagContextBlock(process.cwd(), "", 3), "");
  assert.equal(await buildRagContextBlock("/pfad/der/nicht/existiert", "irgendwas", 3), "");
});

test("tokenizer folds german umlauts and drops stopwords", () => {
  const terms = tokenize("Die Prüfung läuft über die Wörter");
  assert.ok(terms.includes("pruefung"));
  assert.ok(terms.includes("laeuft"));
  assert.ok(terms.includes("woerter"));
  assert.ok(!terms.includes("die"));
  assert.ok(!terms.includes("ueber"));
});

test("bm25 ranks the document containing the query terms first", () => {
  const index = buildIndex([
    { id: "a", source: "a.md", text: "Der Control Server routet Jobs und streamt Status." },
    { id: "b", source: "b.md", text: "IDrive e2 ist das Object Brain fuer Task Capsules und Modelle." },
    { id: "c", source: "c.md", text: "Salad Worker starten nur bei echter Rechenarbeit." }
  ]);
  const hits = searchIndex(index, "Object Brain Task Capsule", 3);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].id, "b");
  assert.ok(hits[0].score > 0);
  assert.ok(hits[0].snippet.includes("Object Brain"));
});

test("empty query and empty index are fail-closed", () => {
  const index = buildIndex([{ id: "a", source: "a.md", text: "Inhalt" }]);
  assert.deepEqual(searchIndex(index, "   ", 5), []);
  assert.deepEqual(searchIndex(buildIndex([]), "irgendwas", 5), []);
});

test("markdown chunking splits at headings and keeps the source reference", () => {
  const chunks = chunkMarkdown("# Titel\nAbsatz eins.\n## Abschnitt\nAbsatz zwei.", "doku.md");
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].source, "doku.md");
  assert.equal(chunks[0].heading, "Titel");
  assert.ok(chunks[1].text.includes("Absatz zwei."));
});

test("project knowledge loads and answers a real memory question", async () => {
  const chunks = await loadKnowledgeChunks(process.cwd());
  assert.ok(chunks.length > 20, "expected project markdown knowledge to be loaded");
  const index = buildIndex(chunks);
  const hits = searchIndex(index, "Cloudflare Exit GitHub Pages Hosting", 3);
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((hit) => hit.source.includes("Memory_Bank.md") || hit.source.includes("docs/")));
});
