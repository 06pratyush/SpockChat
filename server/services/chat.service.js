/**
 * Chat, membership and invite rules.
 *
 * All authorisation lives here rather than in the routes, so the HTTP layer and
 * the socket layer cannot drift apart on who is allowed to do what — a real risk
 * in the original, where `message:send` and `GET /messages` checked membership
 * with two different code paths.
 */

const { config } = require('../config');
const chats = require('../db/repositories/chats.repo');
const messages = require('../db/repositories/messages.repo');
const invites = require('../db/repositories/invites.repo');
const validate = require('../core/validate');
const { notFound, forbidden, badRequest, conflict, Codes } = require('../core/errors');

// ─── ACCESS ───────────────────────────────────────────────────────────────────

function requireChat(chatId) {
  const chat = chats.findById(chatId);
  if (!chat) {
    throw notFound('That chat no longer exists.', {
      code: Codes.CHAT_NOT_FOUND,
      hint: 'It may have been deleted, or you may be looking at a stale link. Refresh the page.',
    });
  }
  return chat;
}

function requireMembership(chatId, userId) {
  const chat = requireChat(chatId);
  if (!chats.isMember(chatId, userId)) {
    throw forbidden('You are not a member of this chat.', {
      code: Codes.NOT_A_MEMBER,
      hint: 'Ask the group admin to invite you.',
    });
  }
  return chat;
}

function requireAdmin(chatId, userId) {
  const chat = requireMembership(chatId, userId);
  if (!chats.isAdmin(chatId, userId)) {
    throw forbidden('Only the group admin can change this.', { code: Codes.FORBIDDEN });
  }
  return chat;
}

// ─── CHATS ────────────────────────────────────────────────────────────────────

function create(user, { name, type, aiEnabled, aiModel, aiHost }) {
  const chatName = validate.string(name, 'name', { min: 1, max: config.chat.maxChatNameLength });
  const chatType = validate.oneOf(type, 'type', ['1v1', 'group']);
  const model = aiModel ? validate.string(aiModel, 'aiModel', { min: 1, max: 100 }) : config.ai.defaultModel;
  const host = aiHost ? validate.hostUrl(aiHost, 'aiHost', { allowPrivate: true }) : config.ai.defaultHost;

  // A 1v1 chat exists purely to talk to the model, so AI is always on there.
  const enabled = chatType === '1v1' ? true : !!aiEnabled;

  const chat = chats.create({ name: chatName, type: chatType, adminId: user.id, aiEnabled: enabled, aiModel: model, aiHost: host });
  chats.addMember(chat.id, user.id, user.username, true);

  return { ...chat, is_admin: 1, member_count: 1, latest_seq: 0, read_seq: 0 };
}

function listForUser(userId) {
  return chats.listForUser(userId).map(chat => ({
    ...chat,
    unread: Math.max(0, (chat.latest_seq || 0) - (chat.read_seq || 0)),
  }));
}

function details(chatId, userId) {
  const chat = requireMembership(chatId, userId);
  return {
    chat,
    members: chats.members(chatId),
    latestSeq: messages.latestSeq(chatId),
    readSeq: messages.getCursor(chatId, userId),
    capacity: { current: chats.memberCount(chatId), max: config.chat.maxGroupMembers },
  };
}

function updateAiConfig(chatId, userId, { aiEnabled, aiModel, aiHost }) {
  const chat = requireAdmin(chatId, userId);
  const enabled = aiEnabled === undefined ? !!chat.ai_enabled : !!aiEnabled;
  const model = aiModel ? validate.string(aiModel, 'aiModel', { min: 1, max: 100 }) : chat.ai_model;
  const host = aiHost ? validate.hostUrl(aiHost, 'aiHost', { allowPrivate: true }) : chat.ai_host;
  return chats.updateAi(chatId, { aiEnabled: enabled, aiModel: model, aiHost: host });
}

// ─── HISTORY ──────────────────────────────────────────────────────────────────

/**
 * Read history. Three modes, all membership-checked:
 *   - default:      the most recent page (newest messages — the old code returned
 *                   the *oldest* page and made long chats look frozen)
 *   - `?after=N`:   everything after sequence N — the reconnect backfill
 *   - `?before=N`:  the page preceding sequence N — scroll-up pagination
 */
function history(chatId, userId, { after, before, limit } = {}) {
  requireMembership(chatId, userId);
  const pageSize = validate.integer(limit, 'limit', { min: 1, max: 500, fallback: config.chat.historyPageSize });
  const latestSeq = messages.latestSeq(chatId);

  if (after !== undefined && after !== null && after !== '') {
    const fromSeq = validate.integer(after, 'after', { min: 0, fallback: 0 });
    const rows = messages.since(chatId, fromSeq, pageSize);
    return {
      messages: rows,
      latestSeq,
      mode: 'after',
      // Tells the client whether one more backfill round is needed.
      complete: rows.length === 0 || rows[rows.length - 1].seq >= latestSeq,
    };
  }

  if (before !== undefined && before !== null && before !== '') {
    const toSeq = validate.integer(before, 'before', { min: 1 });
    const rows = messages.before(chatId, toSeq, pageSize);
    return { messages: rows, latestSeq, mode: 'before', complete: rows.length === 0 || rows[0].seq === 1 };
  }

  const rows = messages.recent(chatId, pageSize);
  return {
    messages: rows,
    latestSeq,
    mode: 'recent',
    complete: rows.length === 0 || rows[0].seq === 1,
  };
}

function markRead(chatId, userId, seq) {
  requireMembership(chatId, userId);
  const value = validate.integer(seq, 'seq', { min: 0 });
  messages.setCursor(chatId, userId, value);
  return { chatId, readSeq: messages.getCursor(chatId, userId) };
}

// ─── INVITES ──────────────────────────────────────────────────────────────────

function invite(chatId, user, inviteeUsername) {
  const name = validate.username(inviteeUsername, 'inviteeUsername');
  const chat = requireMembership(chatId, user.id);

  if (chat.type !== 'group') {
    throw badRequest('Only group chats can have more members.', {
      hint: 'Create a group chat if you want to invite people.',
    });
  }
  if (name === user.username) {
    throw badRequest('You are already in this chat.');
  }

  const members = chats.members(chatId);
  if (members.some(m => m.username === name)) {
    throw conflict(`${name} is already in this chat.`, { code: Codes.FRIEND_EXISTS });
  }
  if (members.length >= config.chat.maxGroupMembers) {
    throw badRequest(`This group is full (${config.chat.maxGroupMembers} members maximum).`, {
      code: Codes.GROUP_FULL,
      hint: 'Remove someone, or start a second group.',
    });
  }

  const existing = invites.findPendingForChat(chatId, name);
  if (existing) {
    throw conflict(`${name} already has a pending invite to this chat.`, {
      code: Codes.FRIEND_EXISTS,
      hint: 'Wait for them to respond, or ask them to check their invites.',
    });
  }

  return invites.create({
    chatId,
    chatName: chat.name,
    inviterId: user.id,
    inviterUsername: user.username,
    inviteeUsername: name,
  });
}

function pendingInvites(username) {
  return invites.pendingFor(username);
}

/**
 * Accept or reject an invite.
 * The status transition and the join happen atomically, so a double-click cannot
 * add the member twice or take the group over capacity.
 */
function respondToInvite(inviteId, user, action) {
  validate.oneOf(action, 'action', ['accept', 'reject']);
  const invite = invites.findById(inviteId);

  if (!invite) {
    throw notFound('That invite no longer exists.', {
      code: Codes.INVITE_NOT_FOUND,
      hint: 'It may have been withdrawn. Ask for a new one.',
    });
  }
  if (invite.invitee_username !== user.username) {
    throw forbidden('That invite was not sent to you.', { code: Codes.FORBIDDEN });
  }

  const status = action === 'accept' ? 'accepted' : 'rejected';
  const transitioned = invites.answer(inviteId, user.username, status);
  if (!transitioned) {
    throw conflict('You have already responded to this invite.', {
      code: Codes.INVITE_ALREADY_ANSWERED,
      hint: 'Refresh to see the current state.',
    });
  }

  if (action === 'reject') return { status, invite: { ...invite, status }, joined: false };

  const chat = chats.findById(invite.chat_id);
  if (!chat) {
    throw notFound('The chat behind this invite no longer exists.', { code: Codes.CHAT_NOT_FOUND });
  }

  const result = chats.addMemberCapped(chat.id, user.id, user.username, config.chat.maxGroupMembers);
  if (!result.joined && result.reason === 'full') {
    throw badRequest(`"${chat.name}" filled up before you accepted.`, {
      code: Codes.GROUP_FULL,
      hint: 'Ask the admin to make room and invite you again.',
    });
  }

  return { status, invite: { ...invite, status }, joined: true, chat };
}

module.exports = {
  requireChat, requireMembership, requireAdmin,
  create, listForUser, details, updateAiConfig,
  history, markRead,
  invite, pendingInvites, respondToInvite,
};
