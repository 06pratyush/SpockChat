const { randomUUID } = require('crypto');
const { getDb, plain, plainAll } = require('../index');

/**
 * Upsert a friendship row.
 *
 * The original used INSERT OR IGNORE, so a friendship that already existed in a
 * `rejected` or stale state could never be revived and no state transition was
 * ever recorded. Here the row is upserted and `updated_at` always moves.
 */
function upsert({ userId, friendId, friendUsername, friendHost, status = 'pending', direction = 'outgoing' }) {
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    INSERT INTO friendships (id, user_id, friend_id, friend_username, friend_host, status, direction, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, friend_username) DO UPDATE SET
      friend_id   = excluded.friend_id,
      friend_host = excluded.friend_host,
      status      = excluded.status,
      direction   = excluded.direction,
      updated_at  = excluded.updated_at,
      last_error  = NULL
  `).run(id, userId, friendId, friendUsername, friendHost, status, direction, now, now);
  return find(userId, friendUsername);
}

function find(userId, friendUsername) {
  return plain(
    getDb().prepare('SELECT * FROM friendships WHERE user_id = ? AND friend_username = ?').get(userId, friendUsername)
  );
}

function listAccepted(userId) {
  return plainAll(
    getDb().prepare(`SELECT * FROM friendships WHERE user_id = ? AND status = 'accepted' ORDER BY friend_username`).all(userId)
  );
}

function listIncoming(userId) {
  return plainAll(
    getDb().prepare(`
      SELECT * FROM friendships
       WHERE user_id = ? AND status = 'pending' AND direction = 'incoming'
       ORDER BY created_at DESC
    `).all(userId)
  );
}

function listOutgoing(userId) {
  return plainAll(
    getDb().prepare(`
      SELECT * FROM friendships
       WHERE user_id = ? AND status = 'pending' AND direction = 'outgoing'
       ORDER BY created_at DESC
    `).all(userId)
  );
}

function listAll(userId) {
  return plainAll(getDb().prepare('SELECT * FROM friendships WHERE user_id = ? ORDER BY friend_username').all(userId));
}

function setStatus(userId, friendUsername, status) {
  const result = getDb().prepare(`
    UPDATE friendships SET status = ?, updated_at = ? WHERE user_id = ? AND friend_username = ?
  `).run(status, Math.floor(Date.now() / 1000), userId, friendUsername);
  return result.changes > 0;
}

/** Record why a peer interaction failed, so the UI can explain a stuck request. */
function setLastError(userId, friendUsername, message) {
  getDb().prepare('UPDATE friendships SET last_error = ?, updated_at = ? WHERE user_id = ? AND friend_username = ?')
    .run(message ? String(message).slice(0, 500) : null, Math.floor(Date.now() / 1000), userId, friendUsername);
}

function remove(userId, friendUsername) {
  return getDb().prepare('DELETE FROM friendships WHERE user_id = ? AND friend_username = ?')
    .run(userId, friendUsername).changes > 0;
}

module.exports = {
  upsert, find, listAccepted, listIncoming, listOutgoing, listAll,
  setStatus, setLastError, remove,
};
