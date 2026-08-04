/**
 * Bounded concurrency queue.
 *
 * A local LLM is a single scarce resource. Firing five generations at one Ollama
 * instance does not make them finish faster — it makes all five slow, can push
 * the box into swap, and can OOM the model runtime. So AI work is serialised per
 * host, with a bounded backlog: past `maxQueue` we reject *immediately* with a
 * clear "AI is busy" message instead of accepting work we cannot service.
 */

class QueueFullError extends Error {
  constructor(name, depth) {
    super(`${name} queue is full (${depth} waiting)`);
    this.name = 'QueueFullError';
    this.code = 'QUEUE_FULL';
    this.depth = depth;
  }
}

class TaskQueue {
  constructor({ concurrency = 1, maxQueue = 8, name = 'queue' } = {}) {
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
    this.name = name;
    this.active = 0;
    this.pending = [];
    this.totals = { run: 0, rejected: 0 };
  }

  get depth() { return this.pending.length; }

  /**
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   * @throws {QueueFullError} when the backlog is already at capacity
   */
  push(fn) {
    if (this.pending.length >= this.maxQueue) {
      this.totals.rejected++;
      return Promise.reject(new QueueFullError(this.name, this.pending.length));
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ fn, resolve, reject });
      this.#drain();
    });
  }

  #drain() {
    while (this.active < this.concurrency && this.pending.length) {
      const job = this.pending.shift();
      this.active++;
      this.totals.run++;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--;
          this.#drain();
        });
    }
  }

  snapshot() {
    return { name: this.name, active: this.active, queued: this.pending.length, ...this.totals };
  }
}

/** One queue per host key. */
class QueueRegistry {
  constructor(options = {}) {
    this.options = options;
    this.queues = new Map();
  }

  for(key) {
    let queue = this.queues.get(key);
    if (!queue) {
      queue = new TaskQueue({ ...this.options, name: `${this.options.name || 'queue'}:${key}` });
      this.queues.set(key, queue);
    }
    return queue;
  }

  snapshot() { return [...this.queues.values()].map(q => q.snapshot()); }
}

module.exports = { TaskQueue, QueueRegistry, QueueFullError };
