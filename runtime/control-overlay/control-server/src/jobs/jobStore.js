// smejj.com control-server — event-getriebener In-Memory-Job-Store (Single Responsibility: Job-Zustand + Events).
// Flüchtiger Cache für Status-Streaming. Die dauerhafte Quelle der Wahrheit ist immer
// die Task Capsule auf IDrive e2 (Object Brain).

const jobs = new Map();
const listeners = new Map();

export function saveJob(job) {
  if (!job || !job.id) throw new Error("saveJob requires a job with an id");
  jobs.set(job.id, job);
  emit(job.id, "job.saved", job);
  return job;
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

export function updateJobStatus(jobId, status, updatedAt = new Date().toISOString()) {
  const job = jobs.get(jobId);
  if (!job) return null;
  const updated = { ...job, status, updatedAt };
  jobs.set(jobId, updated);
  emit(jobId, "job.status", updated);
  return updated;
}

export function subscribeToJob(jobId, listener) {
  if (typeof listener !== "function") throw new Error("subscribeToJob requires a listener function");
  if (!listeners.has(jobId)) listeners.set(jobId, new Set());
  listeners.get(jobId).add(listener);
  return function unsubscribe() {
    const set = listeners.get(jobId);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) listeners.delete(jobId);
  };
}

export function replaceJob(job, { emitEvent = true, event = "job.status" } = {}) {
  if (!job || !job.id) throw new Error("replaceJob requires a job with an id");
  if (!jobs.has(job.id)) return null;
  jobs.set(job.id, job);
  if (emitEvent) emit(job.id, event, job);
  return job;
}

const ACTIVE_WORKER_STATUSES = new Set(["starting_worker", "running", "verifying"]);

export function activeWorkerCount() {
  return activeJobs().length;
}

export function activeJobs() {
  return [...jobs.values()].filter((job) => ACTIVE_WORKER_STATUSES.has(job.status));
}

export function jobCount() {
  return jobs.size;
}

export function listJobs({ status = "", limit = 100 } = {}) {
  return [...jobs.values()]
    .filter((job) => !status || job.status === status)
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
    .slice(0, Math.min(200, Math.max(1, Number(limit) || 100)));
}

export function clearJobs() {
  jobs.clear();
  listeners.clear();
}

function emit(jobId, event, job) {
  const set = listeners.get(jobId);
  if (!set) return;
  for (const listener of set) {
    try {
      listener({ event, job });
    } catch {
      // Ein defekter Listener darf andere Subscriber nicht blockieren (fail-closed pro Listener).
    }
  }
}
