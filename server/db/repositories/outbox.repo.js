/**
 * Durable outbox for peer-to-peer (federation) calls.
 *
 * The original sent friend requests with a single `fetch`. If the other machine
 * was asleep, on a different network, or briefly unreachable, the request was
 * gone — the user saw an error and nothing was ever retried.
 *
 * Now every peer call that fails transiently is written here and retried in the
 * background with exponential backoff until it succeeds or exhausts its
 * attempts. This is what makes friendship state converge across a flaky link
 * instead of silently diverging.
 */

const { randomUUID } = require('crypto');
const { getDb, plain, plainAll } = require('../index');

function enqueue({ peerHost, endpoint, payload, delayMs = 0 }) {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO federation_outbox (id, peer_host, endpoint, payload, attempts, next_retry_at, created_at, status)
    VALUES (?, ?, ?, ?, 0, ?, ?, 'pending')
  `).run(id, peerHost, endpoint, JSON.stringify(payload), Date.now() + delayMs, Math.floor(Date.now() / 1000));
  return findById(id);
}

function findById(id) {
  const row = plain(getDb().prepare('SELECT * FROM federation_outbox WHERE id = ?').get(id));
  if (row) row.payload = safeParse(row.payload);
  return row;
}

function due(limit = 20) {
  const rows = plainAll(getDb().prepare(`
    SELECT * FROM federation_outbox
     WHERE status = 'pending' AND next_retry_at <= ?
     ORDER BY next_retry_at ASC LIMIT ?
  `).all(Date.now(), limit));
  for (const row of rows) row.payload = safeParse(row.payload);
  return rows;
}

function markDelivered(id) {
  getDb().prepare(`UPDATE federation_outbox SET status = 'delivered', last_error = NULL WHERE id = ?`).run(id);
}

function markFailed(id, error, nextRetryAt, attempts, exhausted = false) {
  getDb().prepare(`
    UPDATE federation_outbox
       SET attempts = ?, next_retry_at = ?, last_error = ?, status = ?
     WHERE id = ?
  `).run(attempts, nextRetryAt, String(error || '').slice(0, 500), exhausted ? 'failed' : 'pending', id);
}

function pendingCount() {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM federation_outbox WHERE status = 'pending'`).get()?.n ?? 0;
}

function failedCount() {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM federation_outbox WHERE status = 'failed'`).get()?.n ?? 0;
}

/** Housekeeping: drop delivered rows older than a day. */
function prune(olderThanSeconds = 86_400) {
  return getDb().prepare(`
    DELETE FROM federation_outbox WHERE status = 'delivered' AND created_at < ?
  `).run(Math.floor(Date.now() / 1000) - olderThanSeconds).changes;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return {}; }
}

module.exports = { enqueue, findById, due, markDelivered, markFailed, pendingCount, failedCount, prune };
