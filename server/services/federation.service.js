/**
 * Peer-to-peer client + durable delivery.
 *
 * Two halves:
 *
 *   **Client** — typed calls to another SpockChat server, each with a timeout, a
 *   circuit breaker per peer host, retry with jitter, and error mapping that can
 *   tell "nothing is listening" from "something is listening but it is not
 *   SpockChat" from "SpockChat answered and said no".
 *
 *   **Outbox worker** — anything that fails transiently is written to the
 *   `federation_outbox` table and retried in the background with exponential
 *   backoff. A friend request sent while the other laptop is closed is delivered
 *   when it reopens, instead of being lost forever the way it used to be.
 */

const { config } = require('../config');
const { createLogger } = require('../core/logger');
const { requestJson, HttpError, toAppError } = require('../core/http');
const { withRetry } = require('../core/retry');
const { BreakerRegistry } = require('../core/circuit-breaker');
const { AppError, Codes, unavailable, notFound } = require('../core/errors');
const { onShutdown } = require('../core/lifecycle');
const outbox = require('../db/repositories/outbox.repo');

const log = createLogger('federation');

const breakers = new BreakerRegistry({
  name: 'peer',
  failureThreshold: config.federation.breaker.failureThreshold,
  resetTimeoutMs: config.federation.breaker.resetTimeoutMs,
  onStateChange: ({ name, from, to }) => log.warn(`peer circuit ${from} → ${to}`, { peer: name }),
});

function headersFor(peerHost) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': `SpockChat/${config.app.version}`,
    'X-SpockChat-Version': config.app.version,
  };
  // Legacy localtunnel installs show an interstitial without this header.
  if (peerHost.includes('.loca.lt')) headers['bypass-tunnel-reminder'] = 'true';
  return headers;
}

/** One peer call, breaker-wrapped, retried on transient network faults only. */
async function call(peerHost, path, { method = 'GET', body = null, timeoutMs = config.federation.requestTimeoutMs, retries = config.federation.retries } = {}) {
  const breaker = breakers.for(peerHost);
  const url = `${peerHost}${path}`;

  return breaker.run(
    () =>
      withRetry(
        () =>
          requestJson(url, {
            method,
            headers: headersFor(peerHost),
            body: body ? JSON.stringify(body) : null,
            timeoutMs,
          }),
        {
          retries,
          baseDelayMs: 300,
          shouldRetry: err =>
            err instanceof HttpError &&
            ['CONNECTION_RESET', 'NETWORK_ERROR', 'TIMEOUT'].includes(err.code),
          onRetry: ({ attempt, delay, err }) =>
            log.debug('retrying peer call', { peerHost, path, attempt, delay, reason: err.message }),
        }
      ),
    (lastError, retryAfterMs) =>
      unavailable(`${peerHost} has been unreachable, so SpockChat has paused calls to it.`, {
        code: Codes.PEER_UNREACHABLE,
        hint:
          `It will be retried automatically in ${Math.ceil(retryAfterMs / 1000)}s. ` +
          `Check that their SpockChat is running and the address is current.` +
          (lastError ? ` Last error: ${lastError.message}` : ''),
      })
  );
}

// ─── TYPED CALLS ──────────────────────────────────────────────────────────────

/** Confirm the address really is a SpockChat server before doing anything else. */
async function ping(peerHost) {
  try {
    const res = await call(peerHost, '/api/federation/ping', { retries: 1, timeoutMs: 5_000 });
    if (!res.ok || res.json?.app !== 'SpockChat') {
      throw unavailable(`${peerHost} answered, but it is not a SpockChat server.`, {
        code: Codes.PEER_NOT_SPOCKCHAT,
        hint: 'Check the address. A tunnel URL that has expired often lands on a provider error page.',
      });
    }
    return { ok: true, version: res.json.version, protocol: res.json.protocol ?? 1 };
  } catch (err) {
    throw toAppError(err, { code: Codes.PEER_UNREACHABLE });
  }
}

async function lookupUser(peerHost, username) {
  try {
    const res = await call(peerHost, `/api/federation/lookup/${encodeURIComponent(username)}`, { retries: 1 });
    if (res.status === 404) {
      throw notFound(`No user named "${username}" exists on ${peerHost}.`, {
        code: Codes.PEER_USER_NOT_FOUND,
        hint: 'Usernames are per-machine. Ask your friend for the exact name they registered with on their own server.',
      });
    }
    if (!res.ok) {
      throw unavailable(`${peerHost} could not look that user up (HTTP ${res.status}).`, { code: Codes.PEER_REJECTED });
    }
    return res.json;
  } catch (err) {
    throw toAppError(err, { code: Codes.PEER_UNREACHABLE });
  }
}

async function sendFriendRequest(peerHost, payload) {
  const res = await call(peerHost, '/api/federation/friend-request', { method: 'POST', body: payload });
  if (!res.ok) {
    throw new AppError(Codes.PEER_REJECTED, res.json?.error || `${peerHost} rejected the friend request.`, {
      status: 400,
      hint: res.json?.hint || 'Their server declined it. They may already have a request from you.',
    });
  }
  return res.json;
}

async function sendFriendResponse(peerHost, payload) {
  const res = await call(peerHost, '/api/federation/friend-response', { method: 'POST', body: payload });
  if (!res.ok) {
    throw new AppError(Codes.PEER_REJECTED, res.json?.error || `${peerHost} rejected the response.`, { status: 400 });
  }
  return res.json;
}

const ENDPOINTS = {
  'friend-request': sendFriendRequest,
  'friend-response': sendFriendResponse,
};

// ─── DURABLE DELIVERY ─────────────────────────────────────────────────────────

/**
 * Try to deliver now; if the failure is transient, queue it and keep trying in
 * the background.
 *
 * @returns {Promise<{delivered:boolean, queued:boolean, error?:AppError}>}
 */
async function deliver(peerHost, endpoint, payload) {
  const send = ENDPOINTS[endpoint];
  if (!send) throw new Error(`Unknown federation endpoint: ${endpoint}`);

  try {
    await send(peerHost, payload);
    return { delivered: true, queued: false };
  } catch (err) {
    const mapped = err instanceof AppError ? err : toAppError(err);
    // A definitive "no" from the peer must not be retried forever.
    if (mapped.code === Codes.PEER_REJECTED || mapped.code === Codes.PEER_USER_NOT_FOUND) {
      return { delivered: false, queued: false, error: mapped };
    }
    outbox.enqueue({ peerHost, endpoint, payload, delayMs: config.federation.outboxIntervalMs });
    log.warn('peer call queued for retry', { peerHost, endpoint, reason: mapped.message });
    return { delivered: false, queued: true, error: mapped };
  }
}

let workerTimer = null;

function startOutboxWorker() {
  if (workerTimer) return;

  const tick = async () => {
    let jobs = [];
    try {
      jobs = outbox.due(10);
    } catch (err) {
      log.error('could not read the federation outbox', { err });
      return;
    }

    for (const job of jobs) {
      const send = ENDPOINTS[job.endpoint];
      const attempts = job.attempts + 1;

      if (!send) {
        outbox.markFailed(job.id, `unknown endpoint "${job.endpoint}"`, Date.now(), attempts, true);
        continue;
      }

      try {
        await send(job.peer_host, job.payload);
        outbox.markDelivered(job.id);
        log.info('queued peer call delivered', { peerHost: job.peer_host, endpoint: job.endpoint, attempts });
      } catch (err) {
        const exhausted = attempts >= config.federation.outboxMaxAttempts;
        // Exponential backoff, capped at 10 minutes.
        const backoff = Math.min(600_000, config.federation.outboxIntervalMs * 2 ** Math.min(attempts, 8));
        const jitter = Math.round(Math.random() * backoff * 0.25);
        outbox.markFailed(job.id, err.message, Date.now() + backoff + jitter, attempts, exhausted);
        if (exhausted) {
          log.error('giving up on peer call', { peerHost: job.peer_host, endpoint: job.endpoint, attempts, reason: err.message });
        }
      }
    }

    try { outbox.prune(); } catch { /* housekeeping only */ }
  };

  workerTimer = setInterval(() => { tick().catch(err => log.error('outbox worker crashed', { err })); }, config.federation.outboxIntervalMs);
  workerTimer.unref?.();
  onShutdown('federation-outbox', () => stopOutboxWorker());
  log.info('federation outbox worker started', { everyMs: config.federation.outboxIntervalMs });
}

function stopOutboxWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}

function snapshot() {
  let pending = 0;
  let failed = 0;
  try { pending = outbox.pendingCount(); failed = outbox.failedCount(); } catch { /* db may be closing */ }
  return { breakers: breakers.snapshot(), outbox: { pending, failed } };
}

module.exports = {
  ping, lookupUser, sendFriendRequest, sendFriendResponse,
  deliver, startOutboxWorker, stopOutboxWorker, snapshot, breakers,
};
