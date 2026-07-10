import { CLIENT_ROUTES } from "./config.js";

const STATIC_RESULTS = Object.freeze([
  ["Arbeitsbereiche", "Neu", "Neuer Chat oder neue Aufgabe starten", "start", "neu chat aufgabe start"],
  ["Arbeitsbereiche", "Coding", "Code schreiben, pruefen und umbauen", "smejjClaw", "coding code programmieren terminal"],
  ["Arbeitsbereiche", "Projekte", "Projekt oeffnen oder wechseln", "projects", "projekt projekte workspace"],
  ["Arbeitsbereiche", "Dateien", "Projektdateien und Uploads finden", "files", "dateien files uploads quellen"],
  ["Arbeitsbereiche", "Verlauf", "Alte Chats und Aufgaben finden", "chatHistory", "verlauf history chat task"],
  ["Einstellungen", "Einstellungen", "Konto, Modelle, API-Keys und Sprache", "settings", "settings einstellungen konto modell api key"],
  ["Einstellungen", "Kosten & Limits", "Kostenstatus und Limits pruefen", "cost", "kosten limits budget"],
  ["Einstellungen", "Nutzer", "Lokalen Nutzer und Login pruefen", "profile", "nutzer login konto profil"],
  ["Werkzeuge", "Browser", "Websites oeffnen und pruefen", "websites", "browser websites web"],
  ["Werkzeuge", "Quellen", "Referenzen und Projektdateien", "files", "quellen referenzen links dokumente"],
  ["Werkzeuge", "GitHub", "Repository, Branch und Commit-Status", "settings", "github repo branch commit pr"],
  ["Werkzeuge", "Vorschau", "App oder Website Preview", "browser", "vorschau preview app website"],
  ["Werkzeuge", "Status", "Tests, Build, Deploy und Fehler", "tools", "status tests build deploy fehler"],
  ["Werkzeuge", "Automatisierung", "Wiederholbare Ablaufe und Agenten", "automation", "automatisierung automation agenten"]
]);

export function initGlobalSearch({ $, goToView, showTaskIndicator, showToast, state, workspace }) {
  const form = $("#searchForm");
  const input = $("#searchQuery");
  const log = $("#searchLog");
  if (!form || !input || !log) return;
  let latest = [];
  const run = async () => {
    latest = await findResults(input.value, state, workspace);
    renderResults(log, latest, input.value);
  };
  input.addEventListener("input", () => { run().catch(() => {}); });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (latest.length) openResult(latest[0], goToView, showTaskIndicator, showToast);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!latest.length) return run().catch(() => {});
    openResult(latest[0], goToView, showTaskIndicator, showToast);
  });
  log.addEventListener("click", (event) => {
    const button = event.target.closest("[data-search-view]");
    if (!button) return;
    openResult({ view: button.dataset.searchView, label: button.dataset.searchLabel, jobId: button.dataset.searchJobId }, goToView, showTaskIndicator, showToast);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    goToView("search");
    requestAnimationFrame(() => input.focus());
  });
  renderResults(log, [], "");
}

async function findResults(query, state, workspace) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const [projectRows, jobRows] = await Promise.all([
    workspace.listProjects().catch(() => []),
    loadJobRows()
  ]);
  const chatRows = Array.from(document.querySelectorAll("#startLog .entry"))
    .slice(-50)
    .map((entry, index) => ["Chats", entry.textContent?.slice(0, 120) || `Chat ${index + 1}`, "Chat-Verlauf", "chatHistory", entry.textContent || ""]);
  const dynamic = [
    ...projectRows.map((project) => ["Projekte", project.name || project.id, `Projekt ${project.id}`, "projects", `${project.id} ${project.name} ${project.syncStatus}`]),
    ...jobRows.map((job) => ["Aufgaben", job.task || job.id, `${job.status} - ${job.id}`, "automation", `${job.id} ${job.task} ${job.status}`, job.id]),
    ...chatRows,
    ["Memory", "Memory/RAG", "Lokale Memory- und RAG-Notizen", "memory", `${state.memory || ""} ${state.rag || ""}`],
    ...state.uploads.map((file) => ["Dateien", file.name, "Lokaler Upload", "files", `${file.name} ${file.type} ${file.preview || ""}`])
  ];
  return [...STATIC_RESULTS, ...dynamic]
    .filter(([, label, detail,, text]) => `${label} ${detail} ${text}`.toLowerCase().includes(needle))
    .map(([group, label, detail, view, _text, jobId]) => ({ group, label, detail, view, jobId }));
}

async function loadJobRows() {
  try {
    const headers = new Headers({ Accept: "application/json" });
    const token = sessionStorage.getItem("smejj.apiToken.v1") || "";
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${CLIENT_ROUTES.api.jobs}?limit=30`, { headers });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch {
    return [];
  }
}

function renderResults(log, results, query) {
  log.replaceChildren();
  if (!query.trim()) return log.append(empty("Suche ueber Chats, Projekte, Dateien, Code, Quellen und Verlauf. Enter oeffnet den besten Treffer."));
  if (!results.length) return log.append(empty("Keine lokalen Treffer. Nutze Browser/Quellen fuer Websuche."));
  const groups = results.reduce((map, item) => map.set(item.group, [...(map.get(item.group) || []), item]), new Map());
  for (const [group, items] of groups.entries()) {
    const section = document.createElement("section");
    section.className = "search-empty";
    const title = document.createElement("strong");
    title.textContent = group;
    section.append(title);
    for (const item of items.slice(0, 6)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "nav-button";
      button.dataset.searchView = item.view;
      button.dataset.searchLabel = item.label;
      if (item.jobId) button.dataset.searchJobId = item.jobId;
      button.textContent = `${item.label} - ${item.detail}`;
      section.append(button);
    }
    log.append(section);
  }
}

function empty(text) {
  const node = document.createElement("div");
  node.className = "search-empty";
  node.textContent = text;
  return node;
}

function openResult(result, goToView, showTaskIndicator, showToast) {
  showTaskIndicator("done");
  goToView(result.view);
  if (result.jobId) window.dispatchEvent(new CustomEvent("smejj:job-selected", { detail: { jobId: result.jobId } }));
  showToast?.(`${result.label || "Treffer"} geoeffnet`);
}
