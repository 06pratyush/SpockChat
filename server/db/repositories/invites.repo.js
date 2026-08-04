const { randomUUID } = require('crypto');
const { getDb, plain, plainAll, transaction } = require('../index');

function create({ chatId, chatName, inviterId, inviterUsername, inviteeUsername, originHost = null }) {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO invites (id, chat_id, chat_name, inviter_id, inviter_username, invitee_username, origin_host, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, chatId, chatName, inviterId, inviterUsername, inviteeUsername, originHost, Math.floor(Date.now() / 1000));
  return findById(id);
}

function findById(id) {
  return plain(getDb().prepare('SELECT * FROM invites WHERE id = ?').get(id));
}

function pendingFor(username) {
  return plainAll(
    getDb().prepare(`SELECT * FROM invites WHERE invitee_username = ? AND status = 'pending' ORDER BY created_at DESC`)
      .all(username)
  );
}

function findPendingForChat(chatId, inviteeUsername) {
  return plain(
    getDb().prepare(`SELECT * FROM invites WHERE chat_id = ? AND invitee_username = ? AND status = 'pending'`)
      .get(chatId, inviteeUsername)
  );
}

/**
 * Transition an invite exactly once.
 *
 * Returns false if somebody already answered it — which makes double-clicking
 * "Accept" harmless instead of racing two joins.
 */
function answer(inviteId, inviteeUsername, status) {
  return transaction(db => {
    const result = db.prepare(`
      UPDATE invites SET status = ?, responded_at = ?
       WHERE id = ? AND invitee_username = ? AND status = 'pending'
    `).run(status, Math.floor(Date.now() / 1000), inviteId, inviteeUsername);
    return result.changes > 0;
  });
}

function expireOlderThan(seconds) {
  return getDb().prepare(`
    UPDATE invites SET status = 'expired'
     WHERE status = 'pending' AND created_at < ?
  `).run(Math.floor(Date.now() / 1000) - seconds).changes;
}

module.exports = { create, findById, pendingFor, findPendingForChat, answer, expireOlderThan };
