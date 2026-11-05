/**
 * Sliding-window rate limiter (security specification section 2.2/2.3).
 *
 * S-Way has no server: every operation runs on the visitor's own device. The
 * limiter therefore protects that device (and the browser tab) from runaway,
 * scripted or accidental repeated heavy processing — e.g. a stuck key or a
 * page script re-submitting OCR in a loop. State lives only in memory and is
 * discarded when the tab closes. No IP address or identifier is recorded.
 *
 * If S-Way is ever extended with a server API, this module is NOT sufficient
 * on its own: limits must also be enforced server-side / at the edge.
 */
import { RATE_LIMITS } from '../config.js';

export const RATE_LIMIT_MESSAGE = 'Too many analysis requests. Please wait before trying again.';

export class RateLimitError extends Error {
  constructor(retryAfterSec) {
    super(RATE_LIMIT_MESSAGE);
    this.name = 'RateLimitError';
    this.status = 429;
    this.retryAfterSec = retryAfterSec;
  }
}

export class SlidingWindowLimiter {
  /**
   * @param {Record<string,{limit:number,windowMs:number}>} config
   * @param {() => number} [now] injectable clock for tests
   */
  constructor(config = RATE_LIMITS, now = () => Date.now()) {
    this.config = { ...config };
    this.now = now;
    this.events = new Map();
  }

  /** Inspect without consuming. */
  peek(op) {
    const cfg = this.config[op];
    if (!cfg) throw new Error(`Unknown rate-limited operation: ${op}`);
    const t = this.now();
    const list = (this.events.get(op) || []).filter((ts) => t - ts < cfg.windowMs);
    this.events.set(op, list);
    if (list.length < cfg.limit) return { allowed: true, remaining: cfg.limit - list.length, retryAfterSec: 0 };
    const retryAfterMs = cfg.windowMs - (t - list[0]);
    return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  /** Consume one unit or throw RateLimitError (the in-browser equivalent of HTTP 429 + Retry-After). */
  consume(op, units = 1) {
    const state = this.peek(op);
    const cfg = this.config[op];
    const list = this.events.get(op);
    if (!state.allowed || list.length + units > cfg.limit) {
      throw new RateLimitError(state.retryAfterSec || Math.ceil(cfg.windowMs / 1000));
    }
    const t = this.now();
    for (let i = 0; i < units; i++) list.push(t);
    return { remaining: cfg.limit - list.length };
  }

  reset() {
    this.events.clear();
  }
}

export const limiter = new SlidingWindowLimiter();
