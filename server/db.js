// Uses Node.js 22+ built-in sqlite (run with --experimental-sqlite)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, '..', 'spockchat.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    username     TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at   INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS friendships (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    friend_id       TEXT NOT NULL,
    friend_username TEXT NOT NULL,
    friend_host     TEXT NOT NULL,
    status          TEXT DEFAULT 'pending',
    created_at      INTEGER DEFAULT (unixepoch()),
    UNIQUE(user_id, friend_username)
  );
  CREATE TABLE IF NOT EXISTS chats (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL,
    admin_id   TEXT,
    ai_enabled INTEGER DEFAULT 0,
    ai_model   TEXT DEFAULT 'llama3',
    ai_host    TEXT DEFAULT 'http://localhost:11434',
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS chat_members (
    chat_id   TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    username  TEXT NOT NULL,
    is_admin  INTEGER DEFAULT 0,
    joined_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (chat_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    chat_id         TEXT NOT NULL,
    sender_id       TEXT,
    sender_username TEXT NOT NULL,
    content         TEXT NOT NULL,
    type            TEXT DEFAULT 'text',
    created_at      INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS invites (
    id               TEXT PRIMARY KEY,
    chat_id          TEXT NOT NULL,
    chat_name        TEXT NOT NULL,
    inviter_id       TEXT NOT NULL,
    inviter_username TEXT NOT NULL,
    invitee_username TEXT NOT NULL,
    status           TEXT DEFAULT 'pending',
    created_at       INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user_id);
  CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_invites_invitee ON invites(invitee_username, status);
`);

const plain = r => r ? Object.assign({}, r) : null;
const plainAll = rows => rows.map(r => Object.assign({}, r));

// USERS
function createUser(username, passwordHash) {
  const id = uuidv4();
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(id, username, passwordHash);
  return { id, username };
}
function getUserByUsername(username) { return plain(db.prepare('SELECT * FROM users WHERE username = ?').get(username)); }
function getUserById(id) { return plain(db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(id)); }

// FRIENDSHIPS
function addFriend(userId, friendId, friendUsername, friendHost, status = 'pending') {
  const id = uuidv4();
  db.prepare(`INSERT OR IGNORE INTO friendships (id,user_id,friend_id,friend_username,friend_host,status) VALUES (?,?,?,?,?,?)`).run(id, userId, friendId, friendUsername, friendHost, status);
  return { id, userId, friendId, friendUsername, friendHost, status };
}
function getFriends(userId) { return plainAll(db.prepare(`SELECT * FROM friendships WHERE user_id=? AND status='accepted'`).all(userId)); }
function getPendingFriendRequests(userId) { return plainAll(db.prepare(`SELECT * FROM friendships WHERE user_id=? AND status='pending'`).all(userId)); }
function updateFriendStatus(userId, friendUsername, status) { return db.prepare(`UPDATE friendships SET status=? WHERE user_id=? AND friend_username=?`).run(status, userId, friendUsername); }
function getFriendship(userId, friendUsername) { return plain(db.prepare(`SELECT * FROM friendships WHERE user_id=? AND friend_username=?`).get(userId, friendUsername)); }

// CHATS
function createChat(name, type, adminId, aiEnabled = false, aiModel = 'llama3', aiHost = 'http://localhost:11434') {
  const id = uuidv4();
  db.prepare(`INSERT INTO chats (id,name,type,admin_id,ai_enabled,ai_model,ai_host) VALUES (?,?,?,?,?,?,?)`).run(id, name, type, adminId, aiEnabled ? 1 : 0, aiModel, aiHost);
  return getChatById(id);
}
function getChatById(id) { return plain(db.prepare('SELECT * FROM chats WHERE id=?').get(id)); }
function getUserChats(userId) {
  return plainAll(db.prepare(`
    SELECT c.*, cm.is_admin,
      (SELECT COUNT(*) FROM chat_members WHERE chat_id=c.id) as member_count,
      (SELECT sender_username||': '||content FROM messages WHERE chat_id=c.id ORDER BY created_at DESC LIMIT 1) as last_message
    FROM chats c JOIN chat_members cm ON cm.chat_id=c.id
    WHERE cm.user_id=? ORDER BY c.created_at DESC
  `).all(userId));
}
function updateChatAI(chatId, enabled, model, host) { db.prepare(`UPDATE chats SET ai_enabled=?,ai_model=?,ai_host=? WHERE id=?`).run(enabled ? 1 : 0, model, host, chatId); }
function addChatMember(chatId, userId, username, isAdmin = false) { db.prepare(`INSERT OR IGNORE INTO chat_members (chat_id,user_id,username,is_admin) VALUES (?,?,?,?)`).run(chatId, userId, username, isAdmin ? 1 : 0); }
function getChatMembers(chatId) { return plainAll(db.prepare(`SELECT * FROM chat_members WHERE chat_id=?`).all(chatId)); }
function isChatMember(chatId, userId) { return !!plain(db.prepare(`SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?`).get(chatId, userId)); }
function getChatMemberCount(chatId) { return (plain(db.prepare(`SELECT COUNT(*) as count FROM chat_members WHERE chat_id=?`).get(chatId))?.count || 0); }

// MESSAGES
function saveMessage(chatId, senderId, senderUsername, content, type = 'text') {
  const id = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO messages (id,chat_id,sender_id,sender_username,content,type,created_at) VALUES (?,?,?,?,?,?,?)`).run(id, chatId, senderId, senderUsername, content, type, now);
  return { id, chat_id: chatId, sender_id: senderId, sender_username: senderUsername, content, type, created_at: now };
}
function getChatHistory(chatId) { return plainAll(db.prepare(`SELECT * FROM messages WHERE chat_id=? ORDER BY created_at ASC LIMIT 100`).all(chatId)); }
function getChatContext(chatId) { return plainAll(db.prepare(`SELECT sender_username,content,type FROM messages WHERE chat_id=? ORDER BY created_at DESC LIMIT 40`).all(chatId)).reverse(); }

// INVITES
function createInvite(chatId, chatName, inviterId, inviterUsername, inviteeUsername) {
  const id = uuidv4();
  db.prepare(`INSERT INTO invites (id,chat_id,chat_name,inviter_id,inviter_username,invitee_username) VALUES (?,?,?,?,?,?)`).run(id, chatId, chatName, inviterId, inviterUsername, inviteeUsername);
  return getInviteById(id);
}
function getPendingInvites(username) { return plainAll(db.prepare(`SELECT * FROM invites WHERE invitee_username=? AND status='pending'`).all(username)); }
function updateInviteStatus(inviteId, inviteeUsername, status) { return db.prepare(`UPDATE invites SET status=? WHERE id=? AND invitee_username=?`).run(status, inviteId, inviteeUsername); }
function getInviteById(id) { return plain(db.prepare('SELECT * FROM invites WHERE id=?').get(id)); }

module.exports = {
  createUser, getUserByUsername, getUserById,
  addFriend, getFriends, getPendingFriendRequests, updateFriendStatus, getFriendship,
  createChat, getChatById, getUserChats, updateChatAI,
  addChatMember, getChatMembers, isChatMember, getChatMemberCount,
  saveMessage, getChatHistory, getChatContext,
  createInvite, getPendingInvites, updateInviteStatus, getInviteById,
};
