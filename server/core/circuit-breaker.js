/**
 * Circuit breaker for outbound dependencies (Ollama hosts, peer servers).
 *
 * Without one, a dead Ollama means every @AI mention waits the full 2-minute
 * timeout before failing — the UI hangs, the queue backs up, and the user gets
 * no signal that anything is wrong. With a breaker, the first few failures are
 * paid for, then the circuit opens and subsequent calls fail *instantly* with an
 * actionable message until a probe shows the dependency is healthy again.
 *
 *   CLOSED    ──failureThreshold consecutive failures──▶ OPEN
 *   OPEN      ──resetTimeout elapsed──▶ HALF_OPEN
 *   HALF_OPEN ──probe succeeds──▶ CLOSED
 *   HALF_OPEN ──probe fails──▶ OPEN (timer restarts)
 */

const States = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' };

class CircuitBreaker {
  constructor({ name, failureThreshold = 5, resetTimeoutMs = 30_000, onStateChange = null } = {}) {
    this.name = name || 'breaker';
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.onStateChange = onStateChange;

    this.state = States.CLOSED;
    this.failures = 0;
    this.openedAt = 0;
    this.lastError = null;
    this.totals = { success: 0, failure: 0, rejected: 0 };
  }

  /** True when a call would be rejected without being attempted. */
  isOpen() {
    if (this.state === States.OPEN && Date.now() - this.openedAt >= this.resetTimeoutMs) {
      this.#transition(States.HALF_OPEN);
    }
    return this.state === States.OPEN;
  }

  /** Milliseconds until the breaker will next allow a probe. 0 when closed. */
  retryAfterMs() {
    if (this.state !== States.OPEN) return 0;
    return Math.max(0, this.resetTimeoutMs - (Date.now() - this.openedAt));
  }

  /**
   * Run `fn` under the breaker.
   * @param {() => Promise<T>} fn
   * @param {(err:Error)=>Error} onRejected maps the "circuit is open" case to a
   *        domain error, so callers can surface a good message.
   */
  async run(fn, onRejected) {
    if (this.isOpen()) {
      this.totals.rejected++;
      const err = onRejected ? onRejected(this.lastError, this.retryAfterMs()) : null;
      throw err || Object.assign(new Error(`${this.name} is unavailable (circuit open)`), { code: 'CIRCUIT_OPEN' });
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure(err);
      throw err;
    }
  }

  recordSuccess() {
    this.totals.success++;
    this.failures = 0;
    this.lastError = null;
    if (this.state !== States.CLOSED) this.#transition(States.CLOSED);
  }

  recordFailure(err) {
    this.totals.failure++;
    this.lastError = err;
    if (this.state === States.HALF_OPEN) {
      this.openedAt = Date.now();
      this.#transition(States.OPEN);
      return;
    }
    this.failures++;
    if (this.failures >= this.failureThreshold) {
      this.openedAt = Date.now();
      this.#transition(States.OPEN);
    }
  }

  reset() {
    this.failures = 0;
    this.lastError = null;
    this.#transition(States.CLOSED);
  }

  snapshot() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      retryAfterMs: this.retryAfterMs(),
      lastError: this.lastError?.message || null,
      totals: { ...this.totals },
    };
  }

  #transition(next) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.onStateChange?.({ name: this.name, from: prev, to: next, lastError: this.lastError });
  }
}

/** Keeps one breaker per target host so a dead peer cannot trip a healthy one. */
class BreakerRegistry {
  constructor(options = {}) {
    this.options = options;
    this.breakers = new Map();
  }

  for(key) {
    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = new CircuitBreaker({ ...this.options, name: `${this.options.name || 'dep'}:${key}` });
      this.breakers.set(key, breaker);
    }
    return breaker;
  }

  snapshot() {
    return [...this.breakers.values()].map(b => b.snapshot());
  }
}

module.exports = { CircuitBreaker, BreakerRegistry, States };
