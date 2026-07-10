import { CLIENT_ROUTES, STORAGE_KEYS } from "./config.js";
import { applyServerAiStatus } from "/assets/storage/index.js";
import { initAutonomousCodingSurface } from "./autonomous-coding.js";

export function enhancePremiumSurfaces() {
  loadPremiumStyles();
  document.querySelectorAll(".view:not(#start)").forEach((view) => view.classList.add("premium-view"));
  enhanceProjectActions();
  enhanceModelRegistry();
  initAutonomousCodingSurface();
  syncServerAiStatus();
}

// Holt den echten Server-AI-Zustand vom Control-Server (/api/health) und
// aktualisiert die Statusanzeigen (Statusseite, Home-Zusammenfassung, Kosten).
// Fail-closed: bei Netz-/Serverfehlern bleibt die Anzeige auf "disabled".
// Es werden keine Secrets angezeigt — nur "enabled (provider:modell)".
async function syncServerAiStatus() {
  try {
    const response = await fetch(CLIENT_ROUTES.api.health, { cache: "no-store" });
    if (!response.ok) return;
    const health = await response.json();
    const status = applyServerAiStatus(health);
    for (const selector of ["#aiModeText", "#homeAiSummary", "#costAiMode"]) {
      const node = document.querySelector(selector);
      if (node) node.textContent = status.aiMode;
    }
    renderModelRegistry(health.modelRegistry);
  } catch {
    // fail-closed: Anzeige bleibt "disabled", keine Fehlermeldung noetig.
  }
}

function enhanceModelRegistry() {
  const grid = document.querySelector("#ai .panel-grid");
  if (!grid || document.querySelector("#systemModelSelect")) return;
  const field = document.createElement("label");
  field.className = "system-model-field";
  field.textContent = "Coding-Modell";
  const select = document.createElement("select");
  select.id = "systemModelSelect";
  select.setAttribute("aria-label", "Coding-Modell");
  field.append(select);
  grid.prepend(field);

  const registry = document.createElement("div");
  registry.id = "modelRegistryPanel";
  registry.className = "model-registry-panel";
  registry.setAttribute("aria-label", "Verfuegbare KI-Modelle");
  grid.after(registry);

  select.addEventListener("change", () => {
    const option = select.options[select.selectedIndex];
    const model = option?.dataset.modelName || "GLM-5.2";
    window.dispatchEvent(new CustomEvent("smejj:model-selected", { detail: { model } }));
    const output = document.querySelector("#aiOutput");
    if (output) output.textContent = option?.dataset.runtimeAvailable === "true"
      ? `${model}: bereit`
      : `${model}: GLM-5.2-Fallback aktiv`;
  });

  renderModelRegistry({
    defaultModelId: "glm-5-2",
    auto: { active: false },
    models: [
      fallbackModel("glm-5-2", "GLM-5.2", true),
      fallbackModel("kimi-k2-7", "Kimi K2.7", false)
    ]
  });
}

function renderModelRegistry(registry) {
  const select = document.querySelector("#systemModelSelect");
  const panel = document.querySelector("#modelRegistryPanel");
  if (!select || !panel || !Array.isArray(registry?.models)) return;
  const selectedName = localStorage.getItem(STORAGE_KEYS.model) || "GLM-5.2";
  select.replaceChildren();
  panel.replaceChildren();

  for (const model of registry.models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.name;
    option.disabled = model.selectable !== true;
    option.dataset.modelName = model.name;
    option.dataset.runtimeAvailable = String(model.runtimeAvailable === true);
    option.selected = selectedName === model.name
      || (selectedName === "smejj 1.0" && model.id === registry.defaultModelId);
    select.append(option);
    panel.append(modelRegistryRow(model));
  }

  if (registry.auto?.active) {
    const option = document.createElement("option");
    option.value = "auto";
    option.textContent = "Auto";
    option.dataset.modelName = "Auto";
    option.dataset.runtimeAvailable = "true";
    select.append(option);
  }
}

function modelRegistryRow(model) {
  const row = document.createElement("div");
  row.className = "model-registry-row";
  const identity = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = model.name;
  const provider = document.createElement("span");
  provider.textContent = model.provider;
  identity.append(name, provider);
  const context = document.createElement("span");
  context.textContent = `${formatContext(model.contextTokens)} Kontext`;
  const coding = document.createElement("span");
  coding.textContent = model.codingCapability || "coding";
  const status = document.createElement("span");
  status.className = `model-state model-state-${model.status || "inactive"}`;
  status.textContent = modelStatusLabel(model.status);
  row.append(identity, context, coding, status);
  return row;
}

function fallbackModel(id, name, active) {
  return {
    id,
    name,
    provider: id === "glm-5-2" ? "zhipu" : "kimi",
    contextTokens: id === "glm-5-2" ? 1_000_000 : 262_144,
    codingCapability: id === "glm-5-2" ? "flagship" : "agentic-coding",
    active,
    selectable: active,
    runtimeAvailable: false,
    status: active ? "fallback-only" : "inactive"
  };
}

function formatContext(tokens) {
  const value = Number(tokens || 0);
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
  return `${Math.round(value / 1024)}K`;
}

function modelStatusLabel(status) {
  if (status === "ready") return "Bereit";
  if (status === "fallback-only") return "Fallback";
  return "Inaktiv";
}

export function renderProjectCards(projects) {
  const target = document.querySelector("#projectList");
  if (!target) return;
  const cards = projects.map((project) => `
    <article class="project-card">
      <div>
        <strong>${escapeHtml(project.name || "smejj.com Projekt")}</strong>
        <span>${escapeHtml(project.id)}</span>
      </div>
      <div class="project-meta">
        <span>${escapeHtml(project.syncStatus || "local")}</span>
        <span>${escapeHtml(project.ownerUserId || "local-only")}</span>
      </div>
    </article>
  `).join("");
  target.innerHTML = `<div class="project-card-list">${cards}</div>`;
}

function loadPremiumStyles() {
  if (document.querySelector('link[href="/assets/app-surfaces.css"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/assets/app-surfaces.css";
  document.head.append(link);
}

function enhanceProjectActions() {
  const toolbar = document.querySelector("#projects .toolbar");
  const moreItems = ["projectManifest", "projectExport", "projectImport", "projectDelete"]
    .map((id) => document.querySelector(`#${id}`))
    .filter(Boolean);
  if (!toolbar || toolbar.querySelector(".more-actions") || moreItems.length === 0) return;
  const more = document.createElement("details");
  more.className = "more-actions";
  const summary = document.createElement("summary");
  summary.textContent = "Mehr";
  more.append(summary);
  const menu = document.createElement("div");
  menu.className = "more-menu";
  for (const item of moreItems) {
    if (item.id === "projectDelete") item.classList.add("danger-action");
    menu.append(item);
  }
  more.append(menu);
  toolbar.append(more);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
