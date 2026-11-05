/**
 * Processing limits, timeouts, cancellation and a bounded job queue
 * (security specification sections 2.5 and 4).
 */
import { QUEUE_LIMITS, TIMEOUTS } from '../config.js';
import { secureId } from './sanitize.js';

export class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} took longer than ${Math.round(ms / 1000)} seconds and was stopped.`);
    this.name = 'TimeoutError';
    this.label = label;
  }
}

export class CancelledError extends Error {
  constructor() {
    super('The analysis was cancelled.');
    this.name = 'CancelledError';
  }
}

export class QueueFullError extends Error {
  constructor() {
    super('An analysis is already running. Wait for it to finish or cancel it before starting another.');
    this.name = 'QueueFullError';
  }
}

export class DuplicateJobError extends Error {
  constructor() {
    super('This exact analysis is already queued or running.');
    this.name = 'DuplicateJobError';
  }
}

/** Cooperative cancellation token shared by every stage of a job. */
export class CancelToken {
  constructor() {
    this.cancelled = false;
    this.listeners = new Set();
  }
  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const fn of this.listeners) { try { fn(); } catch { /* listener errors never block cancellation */ } }
    this.listeners.clear();
  }
  onCancel(fn) {
    if (this.cancelled) fn();
    else this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  throwIfCancelled() {
    if (this.cancelled) throw new CancelledError();
  }
}

/**
 * Race a promise against a timeout and an optional cancel token.
 * `onAbort` runs when the timeout fires or the job is cancelled; use it to
 * terminate workers so the abandoned computation really stops.
 */
export function withTimeout(promise, ms, label, { token, onAbort } = {}) {
  let timer;
  let unlisten = () => {};
  const guard = new Promise((_, rejectFn) => {
    timer = setTimeout(() => {
      try { onAbort?.(); } finally { rejectFn(new TimeoutError(label, ms)); }
    }, ms);
    if (token) {
      unlisten = token.onCancel(() => {
        try { onAbort?.(); } finally { rejectFn(new CancelledError()); }
      });
    }
  });
  return Promise.race([promise, guard]).finally(() => {
    clearTimeout(timer);
    unlisten();
  });
}

/** Give the browser a chance to paint between heavy steps. */
export const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

/**
 * Bounded queue. Rejects new work when full instead of letting requests
 * accumulate in memory, refuses duplicates, expires jobs that wait too long,
 * and always runs the job's cleanup in a finally block.
 */
export class JobQueue {
  constructor({ maxConcurrent = QUEUE_LIMITS.maxConcurrentJobs, maxPending = QUEUE_LIMITS.maxPendingJobs, maxWaitMs = TIMEOUTS.queueWaitMs } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.maxPending = maxPending;
    this.maxWaitMs = maxWaitMs;
    this.running = new Map();
    this.pending = [];
    this.stats = { completed: 0, failed: 0, cancelled: 0, timedOut: 0, rejected: 0, cleanupOk: 0, cleanupFailed: 0 };
  }

  get size() { return this.running.size + this.pending.length; }

  /**
   * @param {string} fingerprint identifies identical requests
   * @param {(token: CancelToken) => Promise<any>} run
   * @param {() => void|Promise<void>} cleanup always executed
   */
  submit(fingerprint, run, cleanup = () => {}) {
    const all = [...this.running.values(), ...this.pending];
    if (all.some((j) => j.fingerprint === fingerprint)) { this.stats.rejected++; throw new DuplicateJobError(); }
    if (this.running.size >= this.maxConcurrent && this.pending.length >= this.maxPending) { this.stats.rejected++; throw new QueueFullError(); }
    const job = { id: secureId(8), fingerprint, run, cleanup, token: new CancelToken(), enqueuedAt: Date.now(), state: 'queued' };
    job.promise = new Promise((resolve, rejectFn) => { job.resolve = resolve; job.reject = rejectFn; });
    this.pending.push(job);
    this.#pump();
    return job;
  }

  cancel(jobId) {
    const idx = this.pending.findIndex((j) => j.id === jobId);
    if (idx >= 0) {
      const [job] = this.pending.splice(idx, 1);
      job.state = 'cancelled';
      this.stats.cancelled++;
      this.#cleanup(job).finally(() => job.reject(new CancelledError()));
      return true;
    }
    const job = this.running.get(jobId);
    if (job) { job.token.cancel(); return true; }
    return false;
  }

  cancelAll() {
    for (const j of [...this.pending]) this.cancel(j.id);
    for (const j of this.running.values()) j.token.cancel();
  }

  async #cleanup(job) {
    try { await job.cleanup(); this.stats.cleanupOk++; } catch { this.stats.cleanupFailed++; }
  }

  #pump() {
    while (this.running.size < this.maxConcurrent && this.pending.length) {
      const job = this.pending.shift();
      if (Date.now() - job.enqueuedAt > this.maxWaitMs) {
        job.state = 'expired';
        this.stats.timedOut++;
        this.#cleanup(job).finally(() => job.reject(new TimeoutError('Waiting in the queue', this.maxWaitMs)));
        continue;
      }
      this.running.set(job.id, job);
      job.state = 'running';
      (async () => {
        try {
          const value = await job.run(job.token);
          job.state = 'completed';
          this.stats.completed++;
          job.resolve(value);
        } catch (err) {
          if (err instanceof CancelledError) { job.state = 'cancelled'; this.stats.cancelled++; }
          else if (err instanceof TimeoutError) { job.state = 'timed_out'; this.stats.timedOut++; }
          else { job.state = 'failed'; this.stats.failed++; }
          job.reject(err);
        } finally {
          await this.#cleanup(job);
          this.running.delete(job.id);
          this.#pump();
        }
      })();
    }
  }
}
