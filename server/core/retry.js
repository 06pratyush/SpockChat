/**
 * Retry with exponential backoff and full jitter.
 *
 * Jitter matters here: when a peer or Ollama comes back after an outage, every
 * queued caller would otherwise stampede it at exactly the same instants.
 */

const { isRetryable } = require('./errors');

// Deliberately NOT unref'd: a backoff between attempts is in-flight work, and
// letting the process exit in the middle of it would silently abandon a retry.
// Delays are bounded by maxDelayMs, so this cannot meaningfully stall shutdown.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {() => Promise<T>} fn            operation to attempt
 * @param {object}  opts
 * @param {number}  opts.retries           extra attempts after the first (default 2)
 * @param {number}  opts.baseDelayMs       first backoff step (default 250)
 * @param {number}  opts.maxDelayMs        backoff ceiling (default 5000)
 * @param {(e:Error)=>boolean} opts.shouldRetry
 * @param {(info:{attempt:number,delay:number,err:Error})=>void} opts.onRetry
 * @param {AbortSignal} opts.signal        abort between attempts
 * @returns {Promise<T>}
 */
async function withRetry(fn, opts = {}) {
  const {
    retries = 2,
    baseDelayMs = 250,
    maxDelayMs = 5_000,
    shouldRetry = isRetryable,
    onRetry = null,
    signal = null,
  } = opts;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw signal.reason || new Error('Aborted');
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const isLast = attempt === retries;
      if (isLast || !shouldRetry(err)) throw err;

      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delay = Math.round(Math.random() * ceiling); // full jitter
      onRetry?.({ attempt: attempt + 1, delay, err });
      await sleep(delay);
    }
  }
  throw lastError;
}

module.exports = { withRetry, sleep };
