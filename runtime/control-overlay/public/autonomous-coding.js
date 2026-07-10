import { API_ORIGIN, CLIENT_ROUTES } from "./config.js";

const API_TOKEN_KEY = "smejj.apiToken.v1";
const ACTIVE_STATUSES = new Set(["open", "queued", "planning", "fast_path", "starting_worker", "running", "verifying"]);
const TERMINAL_STATUSES = new Set(["passed", "failed", "cancelled", "blocked", "done"]);

let selectedJob = null;
let streamController = null;
let pollTimer = null;
let handoffGeneration = 0;

export function initAutonomousCodingSurface() {
  const view = document.querySelector("#automation");
  if (!view || view.dataset.autonomousReady === "true") return;
  view.dataset.autonomousReady = "true";
  loadStyles();
  const placeholder = view.querySelector(":scope > .output");
  const surface = document.createElement("div");
  surface.className = "autonomous-coding";
  surface.innerHTML = surfaceMarkup();
  placeholder?.replaceWith(surface);
  bindSurface(surface);
  window.addEventListener("message", handleSessionHandoff);
  window.addEventListener("smejj:job-selected", (event) => selectJob(event.detail?.jobId));
  refreshSession().catch(showError);
}

function surfaceMarkup() {
  return `
    <section class="ac-command" aria-labelledby="acCommandTitle">
      <div class="ac-section-header">
        <div><p>Autonomer Lauf</p><h3 id="acCommandTitle">Aufgabe</h3></div>
        <span id="acAuthState" class="ac-state ac-state-muted">Anmeldung pruefen</span>
      </div>
      <div class="ac-form-grid">
        <label class="ac-task-field">Aufgabe
          <textarea id="acTask" maxlength="20000" placeholder="Konkrete Codeaenderung und Erfolgskriterien"></textarea>
        </label>
        <label>Repository
          <input id="acRepository" type="url" value="https://github.com/SmejjCom/smejj-control" spellcheck="false">
        </label>
        <label>Basis-Branch
          <input id="acBaseRef" value="main" spellcheck="false">
        </label>
        <label>Ausgabe
          <select id="acPublishMode"><option value="diff-only">Diff</option><option value="draft-pr">Draft-PR</option></select>
        </label>
        <label>Browser-Pruefung
          <select id="acUiChange"><option value="false">Nicht erforderlich</option><option value="true">Erforderlich</option></select>
        </label>
        <label class="ac-preview-field">Preview-URL
          <input id="acPreviewUrl" type="url" placeholder="https://preview.example" spellcheck="false">
        </label>
      </div>
      <div class="ac-actions">
        <button id="acStart" type="button" class="ac-primary">Starten</button>
        <button id="acConnect" type="button">Anmelden</button>
        <button id="acRefresh" type="button">Aktualisieren</button>
      </div>
      <p id="acNotice" class="ac-notice" aria-live="polite"></p>
    </section>
    <section class="ac-jobs" aria-labelledby="acJobsTitle">
      <div class="ac-section-header"><div><p>Queue</p><h3 id="acJobsTitle">Aufgaben</h3></div><span id="acQueueState" class="ac-state ac-state-muted">0 aktiv</span></div>
      <div class="ac-table-wrap"><table><thead><tr><th>Status</th><th>Aufgabe</th><th>Aktualisiert</th></tr></thead><tbody id="acJobRows"></tbody></table></div>
    </section>
    <section class="ac-detail" aria-labelledby="acDetailTitle">
      <div class="ac-section-header"><div><p id="acDetailId">Kein Job</p><h3 id="acDetailTitle">Ergebnis</h3></div><span id="acDetailState" class="ac-state ac-state-muted">Bereit</span></div>
      <div class="ac-progress" aria-label="Job-Fortschritt"><span id="acProgressBar"></span></div>
      <dl class="ac-facts"><div><dt>Phase</dt><dd id="acPhase">-</dd></div><div><dt>Modell</dt><dd id="acModel">-</dd></div><div><dt>Diff SHA-256</dt><dd id="acDiffHash">-</dd></div></dl>
      <div class="ac-actions ac-job-actions">
        <button id="acCancel" type="button" disabled>Abbrechen</button>
        <button id="acApprove" type="button" disabled>Diff freigeben</button>
        <button id="acPublish" type="button" disabled>Draft-PR erstellen</button>
        <button id="acReplay" type="button" disabled>Wiederholen</button>
        <button id="acDownloadDiff" type="button" disabled>Diff herunterladen</button>
      </div>
      <div class="ac-follow-up"><label>Follow-up<input id="acFollowUpTask" maxlength="20000" placeholder="Naechste Aenderung im selben Kontext"></label><button id="acFollowUp" type="button" disabled>Starten</button></div>
      <pre id="acVerification" class="ac-verification">Noch kein Ergebnis.</pre>
      <pre id="acDiff" class="ac-diff" tabindex="0">Noch kein Diff.</pre>
    </section>`;
}

function bindSurface(surface) {
  surface.querySelector("#acStart").addEventListener("click", () => createAndRun().catch(showError));
  surface.querySelector("#acConnect").addEventListener("click", () => openSessionHandoff().catch(showError));
  surface.querySelector("#acRefresh").addEventListener("click", () => refreshJobs(true).catch(showError));
  surface.querySelector("#acCancel").addEventListener("click", () => cancelSelected().catch(showError));
  surface.querySelector("#acApprove").addEventListener("click", () => approveSelected().catch(showError));
  surface.querySelector("#acPublish").addEventListener("click", () => publishSelected().catch(showError));
  surface.querySelector("#acReplay").addEventListener("click", () => replaySelected().catch(showError));
  surface.querySelector("#acFollowUp").addEventListener("click", () => followUpSelected().catch(showError));
  surface.querySelector("#acDownloadDiff").addEventListener("click", downloadSelectedDiff);
  surface.querySelector("#acJobRows").addEventListener("click", (event) => {
    const row = event.target.closest("button[data-job-id]");
    if (row) selectJob(row.dataset.jobId).catch(showError);
  });
}

async function refreshSession() {
  try {
    const current = await api(`${API_ORIGIN}/api/auth/me`);
    if (current.authenticated !== true) {
      sessionStorage.removeItem(API_TOKEN_KEY);
      setAuthState(false);
      return false;
    }
    const session = await api(`${API_ORIGIN}/api/auth/session-token`);
    if (session.accessToken) sessionStorage.setItem(API_TOKEN_KEY, session.accessToken);
    setAuthState(true, session.user);
    await refreshJobs(true);
    return true;
  } catch (error) {
    sessionStorage.removeItem(API_TOKEN_KEY);
    setAuthState(false);
    if (error.status !== 401) throw error;
    return false;
  }
}

async function openSessionHandoff() {
  const generation = ++handoffGeneration;
  const returnOrigin = location.origin;
  const popup = window.open("about:blank", "smejj-session-handoff", "popup,width=520,height=720");
  if (!popup) {
    setNotice("Popup wurde blockiert.");
    return;
  }
  setNotice("Sichere Anmeldung wird vorbereitet.");
  try {
    const started = await api(`${API_ORIGIN}/api/auth/session-handoff/start`, {
      method: "POST",
      body: { returnOrigin }
    });
    const handoffId = String(started.id || "");
    if (!/^[A-Za-z0-9_-]{43}$/.test(handoffId)) throw new Error("Anmeldecode ist ungueltig.");
    popup.location.replace(`${API_ORIGIN}/api/auth/session-handoff/complete?handoffId=${encodeURIComponent(handoffId)}`);
    setNotice("Anmeldung wird verbunden.");
    await pollSessionHandoff({ generation, handoffId, expiresAt: Number(started.expiresAt), popup });
  } catch (error) {
    try { popup.close(); } catch {}
    throw error;
  }
}

async function handleSessionHandoff(event) {
  if (event.origin !== new URL(API_ORIGIN).origin || event.data?.type !== "smejj:session-handoff") return;
  await activateHandoffSession(event.data);
}

async function pollSessionHandoff({ generation, handoffId, expiresAt, popup }) {
  while (generation === handoffGeneration && Date.now() < expiresAt) {
    const result = await api(`${API_ORIGIN}/api/auth/session-handoff/${encodeURIComponent(handoffId)}`);
    if (result.state === "completed") {
      try { popup.close(); } catch {}
      await activateHandoffSession(result);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  try { popup.close(); } catch {}
  if (generation === handoffGeneration) throw new Error("Anmeldung ist abgelaufen. Bitte erneut versuchen.");
}

async function activateHandoffSession(data) {
  const token = String(data.accessToken || "");
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return;
  sessionStorage.setItem(API_TOKEN_KEY, token);
  setAuthState(true, data.user);
  setNotice("Anmeldung aktiv.");
  await refreshJobs(true).catch(showError);
}

async function createAndRun(options = {}) {
  requireAuth();
  const task = String(options.task ?? value("#acTask")).trim();
  if (!task) throw new Error("Aufgabe fehlt.");
  const repository = options.repository || {
    url: value("#acRepository").trim(),
    baseRef: value("#acBaseRef").trim() || "main",
    publishMode: value("#acPublishMode")
  };
  const uiChange = options.uiChange ?? value("#acUiChange") === "true";
  const previewUrl = options.previewUrl ?? value("#acPreviewUrl").trim();
  const payload = {
    jobId: newJobId(),
    projectId: "project_smejj_autonomous",
    task,
    model: "GLM-5.2",
    persistToIdrive: true,
    repository,
    parentJobId: options.parentJobId || "",
    uiChange,
    preview: { required: uiChange, ...(previewUrl ? { url: previewUrl } : {}) }
  };
  setBusy(true);
  setNotice("Task Capsule wird gespeichert.");
  try {
    const created = await api(CLIENT_ROUTES.api.jobs, { method: "POST", body: payload });
    selectedJob = created.job;
    renderJob(selectedJob);
    setNotice("Job wird eingeplant.");
    await api(jobUrl(selectedJob.id, "autonomous-run"), { method: "POST", body: {} });
    startTracking(selectedJob.id);
    await refreshJobs(false);
  } finally {
    setBusy(false);
  }
}

async function refreshJobs(hydrate) {
  requireAuth();
  const data = await api(`${CLIENT_ROUTES.api.jobs}?limit=50${hydrate ? "&hydrate=1" : ""}`);
  renderJobs(data.jobs || []);
  const queue = data.queue || {};
  text("#acQueueState", `${queue.active?.length || 0} aktiv, ${queue.queued?.length || 0} wartend`);
  const remembered = sessionStorage.getItem("smejj.autonomous.selectedJob.v1");
  if (!selectedJob && remembered && (data.jobs || []).some((job) => job.id === remembered)) await selectJob(remembered);
}

function renderJobs(jobs) {
  const tbody = document.querySelector("#acJobRows");
  tbody.replaceChildren();
  if (!jobs.length) {
    const row = document.createElement("tr");
    row.innerHTML = '<td colspan="3" class="ac-empty">Keine Jobs.</td>';
    tbody.append(row);
    return;
  }
  for (const job of jobs) {
    const row = document.createElement("tr");
    const status = document.createElement("td");
    status.append(stateNode(job.status));
    const task = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.jobId = job.id;
    button.textContent = job.task || job.id;
    task.append(button);
    const updated = document.createElement("td");
    updated.textContent = formatTime(job.updatedAt || job.createdAt);
    row.append(status, task, updated);
    tbody.append(row);
  }
}

async function selectJob(jobId) {
  if (!jobId) return;
  requireAuth();
  const data = await api(jobUrl(jobId));
  selectedJob = data.job;
  sessionStorage.setItem("smejj.autonomous.selectedJob.v1", selectedJob.id);
  renderJob(selectedJob);
  if (ACTIVE_STATUSES.has(selectedJob.status)) startTracking(selectedJob.id);
}

function renderJob(job) {
  if (!job) return;
  const result = job.result || {};
  text("#acDetailId", job.id);
  text("#acDetailState", statusLabel(job.status));
  document.querySelector("#acDetailState").className = `ac-state ac-state-${stateClass(job.status)}`;
  text("#acPhase", job.message || job.phase || job.status);
  text("#acModel", job.model?.name || "GLM-5.2");
  text("#acDiffHash", result.diffSha256 || "-");
  document.querySelector("#acProgressBar").style.width = `${Math.round(Math.max(0, Math.min(1, Number(job.progress || 0))) * 100)}%`;
  text("#acDiff", result.diff || "Noch kein Diff.");
  text("#acVerification", verificationText(job));
  setDisabled("#acCancel", !ACTIVE_STATUSES.has(job.status));
  setDisabled("#acApprove", job.status !== "passed" || !result.diffSha256 || job.approval?.status === "human_approved");
  const publishReady = job.status === "passed" && job.repository?.publishMode === "draft-pr" && job.approval?.status === "human_approved";
  setDisabled("#acPublish", !publishReady);
  setDisabled("#acReplay", !TERMINAL_STATUSES.has(job.status));
  setDisabled("#acFollowUp", job.status !== "passed" || !result.diffSha256);
  setDisabled("#acDownloadDiff", !result.diff);
}

function verificationText(job) {
  const verification = job.result?.verification;
  const browser = job.result?.browser;
  const lines = [
    `Status: ${statusLabel(job.status)}`,
    `Capsule: ${job.taskCapsule?.rootPrefix || "-"}`
  ];
  for (const check of verification?.checks || []) lines.push(`${check.stage}: ${check.ok ? "OK" : check.skipped ? "SKIP" : "FEHLER"}`);
  if (browser) lines.push(`Browser: ${browser.required ? (browser.ok ? "OK" : "FEHLER") : "nicht erforderlich"}`);
  if (job.result?.finalReport) lines.push("", job.result.finalReport);
  return lines.join("\n");
}

async function cancelSelected() {
  requireSelected();
  if (!window.confirm(`Job ${selectedJob.id} abbrechen?`)) return;
  const data = await api(jobUrl(selectedJob.id, "cancel"), { method: "POST", body: {} });
  selectedJob = data.job;
  renderJob(selectedJob);
  await refreshJobs(false);
}

async function approveSelected() {
  requireSelected();
  const hash = selectedJob.result?.diffSha256;
  if (!hash || !window.confirm(`Geprueften Diff ${hash.slice(0, 12)} freigeben? Kein Merge wird ausgefuehrt.`)) return;
  const data = await api(jobUrl(selectedJob.id, "approve"), { method: "POST", body: { diffSha256: hash } });
  selectedJob = data.job;
  renderJob(selectedJob);
}

async function publishSelected() {
  requireSelected();
  if (!window.confirm("Freigegebenen Diff als Draft-PR veroeffentlichen? Kein Merge wird ausgefuehrt.")) return;
  await api(jobUrl(selectedJob.id, "autonomous-run"), { method: "POST", body: { publishDraftPr: true } });
  startTracking(selectedJob.id);
}

async function replaySelected() {
  requireSelected();
  await createAndRun({
    task: selectedJob.task,
    repository: selectedJob.repository,
    uiChange: selectedJob.preview?.required === true,
    previewUrl: selectedJob.preview?.url || ""
  });
}

async function followUpSelected() {
  requireSelected();
  const task = value("#acFollowUpTask").trim();
  if (!task) throw new Error("Follow-up-Aufgabe fehlt.");
  await createAndRun({
    task,
    repository: selectedJob.repository,
    parentJobId: selectedJob.id,
    uiChange: selectedJob.preview?.required === true,
    previewUrl: selectedJob.preview?.url || ""
  });
}

function startTracking(jobId) {
  streamController?.abort();
  clearInterval(pollTimer);
  streamController = new AbortController();
  pollTimer = setInterval(() => selectJob(jobId).catch(() => {}), 2500);
  streamJob(jobId, streamController.signal).catch(() => {});
}

async function streamJob(jobId, signal) {
  const response = await authenticatedFetch(jobUrl(jobId, "events"), { signal, headers: { Accept: "text/event-stream" } });
  if (!response.ok || !response.body) throw await responseError(response);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n").filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim()).join("\n");
      if (!data) continue;
      const payload = JSON.parse(data);
      if (payload.job?.id !== jobId) continue;
      selectedJob = payload.job;
      renderJob(selectedJob);
      if (TERMINAL_STATUSES.has(selectedJob.status)) {
        clearInterval(pollTimer);
        await refreshJobs(false).catch(() => {});
        return;
      }
    }
  }
}

function downloadSelectedDiff() {
  const diff = selectedJob?.result?.diff;
  if (!diff) return;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([diff], { type: "text/x-diff" }));
  link.download = `${selectedJob.id}.diff`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

async function api(url, { method = "GET", body } = {}) {
  const headers = new Headers({ Accept: "application/json" });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await authenticatedFetch(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function authenticatedFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = sessionStorage.getItem(API_TOKEN_KEY) || "";
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...options, headers });
}

async function responseError(response) {
  const data = await response.json().catch(() => ({}));
  const error = new Error(data.error || `HTTP ${response.status}`);
  error.status = response.status;
  return error;
}

function setAuthState(authenticated, user) {
  const state = document.querySelector("#acAuthState");
  state.textContent = authenticated ? `Angemeldet${user?.email ? `: ${user.email}` : ""}` : "Anmeldung erforderlich";
  state.className = `ac-state ac-state-${authenticated ? "passed" : "blocked"}`;
  document.querySelector("#acConnect").hidden = authenticated;
}

function stateNode(status) {
  const node = document.createElement("span");
  node.className = `ac-state ac-state-${stateClass(status)}`;
  node.textContent = statusLabel(status);
  return node;
}

function stateClass(status) {
  if (status === "passed" || status === "done") return "passed";
  if (status === "failed" || status === "blocked" || status === "cancelled") return "blocked";
  if (ACTIVE_STATUSES.has(status)) return "active";
  return "muted";
}

function statusLabel(status) {
  return ({ open: "Offen", queued: "Wartet", planning: "Plant", running: "Laeuft", verifying: "Prueft", passed: "Bestanden", failed: "Fehlgeschlagen", cancelled: "Abgebrochen", blocked: "Blockiert", done: "Fertig" })[status] || String(status || "Bereit");
}

function newJobId() {
  const value = globalThis.crypto?.randomUUID?.().replaceAll("-", "") || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `job_web_${value.slice(0, 24)}`;
}

function jobUrl(jobId, suffix = "") {
  return `${CLIENT_ROUTES.api.jobs}/${encodeURIComponent(jobId)}${suffix ? `/${suffix}` : ""}`;
}

function requireAuth() {
  if (!sessionStorage.getItem(API_TOKEN_KEY) && location.origin !== new URL(API_ORIGIN).origin) throw new Error("Bitte zuerst anmelden.");
}

function requireSelected() {
  if (!selectedJob) throw new Error("Kein Job ausgewaehlt.");
}

function setBusy(busy) {
  setDisabled("#acStart", busy);
  setDisabled("#acRefresh", busy);
}

function showError(error) {
  if (error?.status === 401) setAuthState(false);
  setNotice(error?.message || String(error));
}

function setNotice(message) { text("#acNotice", message); }
function text(selector, value) { const node = document.querySelector(selector); if (node) node.textContent = String(value ?? ""); }
function value(selector) { return document.querySelector(selector)?.value || ""; }
function setDisabled(selector, disabled) { const node = document.querySelector(selector); if (node) node.disabled = disabled; }
function formatTime(value) { const date = new Date(value || 0); return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }); }

function loadStyles() {
  if (document.querySelector('link[href="/assets/autonomous-coding.css"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/assets/autonomous-coding.css";
  document.head.append(link);
}
