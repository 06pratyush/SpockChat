/**
 * Token-bucket rate limiter — in-process, dependency-free.
 *
 * Protects three things:
 *   1. Login/register from credential-stuffing (bcrypt at cost 12 is ~250ms of
 *      CPU per attempt; 40 concurrent guesses would wedge the event loop).
 *   2. Message and AI floods from a buggy or malicious client.
 *   3. Federation endpoints, which are unauthenticated by design.
 *
 * Buckets are swept periodically so a long-running server does not accumulate an
 * entry per IP forever.
 */

class RateLimiter {
  /**
   * @param {object} opts
   * @param {number} opts.capacity      max burst
   * @param {number} opts.refillPerMin  sustained rate
   * @param {string} opts.name
   */
  constructor({ capacity, refillPerMin, name = 'limiter' }) {
    this.capacity = capacity;
    this.refillRatePerMs = refillPerMin / 60_000;
    this.name = name;
    this.buckets = new Map();

    this.sweeper = setInterval(() => this.sweep(), 5 * 60_000);
    this.sweeper.unref?.();
  }

  /**
   * @returns {{allowed:boolean, remaining:number, retryAfterMs:number}}
   */
  take(key, cost = 1) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, updated: now };
      this.buckets.set(key, bucket);
    }

    const elapsed = now - bucket.updated;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillRatePerMs);
    bucket.updated = now;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }

    const deficit = cost - bucket.tokens;
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.ceil(deficit / this.refillRatePerMs),
    };
  }

  /** Give tokens back — used when an attempt turns out to be legitimate (successful login). */
  refund(key, amount = 1) {
    const bucket = this.buckets.get(key);
    if (bucket) bucket.tokens = Math.min(this.capacity, bucket.tokens + amount);
  }

  reset(key) { this.buckets.delete(key); }

  sweep() {
    const now = Date.now();
    const fullRefillMs = this.capacity / this.refillRatePerMs;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updated > fullRefillMs) this.buckets.delete(key);
    }
  }

  stop() { clearInterval(this.sweeper); }

  snapshot() { return { name: this.name, tracked: this.buckets.size, capacity: this.capacity }; }
}

module.exports = { RateLimiter };
