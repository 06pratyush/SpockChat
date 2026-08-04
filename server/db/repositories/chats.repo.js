const { randomUUID } = require('crypto');
const { getDb, plain, plainAll, transaction } = require('../index');

function create({ name, type, adminId, aiEnabled = false, aiModel, aiHost }) {
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    INSERT INTO chats (id, name, type, admin_id, ai_enabled, ai_model, ai_host, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, type, adminId, aiEnabled ? 1 : 0, aiModel, aiHost, now, now);
  return findById(id);
}

function findById(id) {
  return plain(getDb().prepare('SELECT * FROM chats WHERE id = ?').get(id));
}

/**
 * Chats for a user, newest activity first, with the data the sidebar needs:
 * member count, last message preview, latest sequence number and unread count.
 * One query instead of N+1 round trips.
 */
function listForUser(userId) {
  return plainAll(getDb().prepare(`
    SELECT c.*,
           cm.is_admin,
           (SELECT COUNT(*) FROM chat_members WHERE chat_id = c.id)                       AS member_count,
           (SELECT sender_username || ': ' || content
              FROM messages WHERE chat_id = c.id ORDER BY seq DESC LIMIT 1)               AS last_message,
           (SELECT COALESCE(MAX(seq), 0) FROM messages WHERE chat_id = c.id)              AS latest_seq,
           (SELECT COALESCE(MAX(created_at_ms), c.created_at * 1000)
              FROM messages WHERE chat_id = c.id)                                          AS last_activity_ms,
           COALESCE((SELECT last_seq FROM delivery_cursors
                      WHERE chat_id = c.id AND user_id = cm.user_id), 0)                   AS read_seq
      FROM chats c
      JOIN chat_members cm ON cm.chat_id = c.id
     WHERE cm.user_id = ? AND COALESCE(c.archived, 0) = 0
     ORDER BY last_activity_ms DESC
  `).all(userId));
}

function updateAi(chatId, { aiEnabled, aiModel, aiHost }) {
  getDb().prepare(`
    UPDATE chats SET ai_enabled = ?, ai_model = ?, ai_host = ?, updated_at = ? WHERE id = ?
  `).run(aiEnabled ? 1 : 0, aiModel, aiHost, Math.floor(Date.now() / 1000), chatId);
  return findById(chatId);
}

function touch(chatId) {
  getDb().prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), chatId);
}

// ─── MEMBERSHIP ───────────────────────────────────────────────────────────────

function addMember(chatId, userId, username, isAdmin = false) {
  getDb().prepare(`
    INSERT OR IGNORE INTO chat_members (chat_id, user_id, username, is_admin) VALUES (?, ?, ?, ?)
  `).run(chatId, userId, username, isAdmin ? 1 : 0);
}

/**
 * Join under a hard capacity check, inside one transaction.
 * Without this, two invitees accepting simultaneously could both pass a
 * "count < max" check and push the group over its limit.
 * @returns {{joined:boolean, reason?:string, memberCount:number}}
 */
function addMemberCapped(chatId, userId, username, maxMembers) {
  return transaction(db => {
    const already = db.prepare('SELECT 1 AS x FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
    const count = db.prepare('SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?').get(chatId)?.n ?? 0;
    if (already) return { joined: false, reason: 'already_member', memberCount: count };
    if (count >= maxMembers) return { joined: false, reason: 'full', memberCount: count };

    db.prepare('INSERT INTO chat_members (chat_id, user_id, username, is_admin) VALUES (?, ?, ?, 0)')
      .run(chatId, userId, username);
    return { joined: true, memberCount: count + 1 };
  });
}

function removeMember(chatId, userId) {
  getDb().prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chatId, userId);
}

function members(chatId) {
  return plainAll(getDb().prepare('SELECT * FROM chat_members WHERE chat_id = ? ORDER BY is_admin DESC, joined_at ASC').all(chatId));
}

function isMember(chatId, userId) {
  return !!getDb().prepare('SELECT 1 AS x FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
}

function isAdmin(chatId, userId) {
  return !!getDb().prepare('SELECT 1 AS x FROM chat_members WHERE chat_id = ? AND user_id = ? AND is_admin = 1').get(chatId, userId);
}

function memberCount(chatId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?').get(chatId)?.n ?? 0;
}

function chatIdsForUser(userId) {
  return plainAll(getDb().prepare('SELECT chat_id FROM chat_members WHERE user_id = ?').all(userId)).map(r => r.chat_id);
}

module.exports = {
  create, findById, listForUser, updateAi, touch,
  addMember, addMemberCapped, removeMember, members,
  isMember, isAdmin, memberCount, chatIdsForUser,
};
