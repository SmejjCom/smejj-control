export function createJobScheduler({ maxConcurrency = 1 } = {}) {
  const limit = Math.min(8, Math.max(1, Number(maxConcurrency) || 1));
  const queue = [];
  const active = new Map();

  function enqueue(jobId, run, cancel = null) {
    if (!jobId || typeof run !== "function") throw new Error("scheduler_job_invalid");
    if (active.has(jobId) || queue.some((item) => item.jobId === jobId)) return { ok: false, reason: "job_already_scheduled" };
    queue.push({ jobId, run, cancel: typeof cancel === "function" ? cancel : null, queuedAt: new Date().toISOString() });
    drain();
    return { ok: true, jobId, position: queue.findIndex((item) => item.jobId === jobId) + 1, snapshot: snapshot() };
  }

  function cancel(jobId) {
    const index = queue.findIndex((item) => item.jobId === jobId);
    if (index >= 0) {
      queue.splice(index, 1);
      return { ok: true, cancelled: "queued" };
    }
    const running = active.get(jobId);
    if (!running) return { ok: false, reason: "job_not_scheduled" };
    if (running.cancellationRequested) return { ok: true, cancelled: "running", abortRequested: true };
    running.cancellationRequested = true;
    const abortRequested = running.cancel?.() === true;
    return { ok: true, cancelled: "running", abortRequested };
  }

  function snapshot() {
    return {
      maxConcurrency: limit,
      active: [...active.keys()],
      queued: queue.map((item) => ({ jobId: item.jobId, queuedAt: item.queuedAt }))
    };
  }

  function drain() {
    while (active.size < limit && queue.length > 0) {
      const item = queue.shift();
      const promise = Promise.resolve().then(item.run);
      active.set(item.jobId, { promise, cancel: item.cancel, cancellationRequested: false });
      promise.catch(() => {}).finally(() => {
        active.delete(item.jobId);
        drain();
      });
    }
  }

  return { enqueue, cancel, snapshot };
}
