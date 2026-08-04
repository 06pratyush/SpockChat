const express = require('express');

const chatService = require('../../services/chat.service');
const messageService = require('../../services/message.service');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/context');
const realtime = require('../../realtime/registry');

const router = express.Router();
router.use(requireAuth);

// ─── INVITES ──────────────────────────────────────────────────────────────────
// Declared before "/:id" so the literal path is not swallowed by the parameter.

router.get('/invites/pending', (req, res) => {
  res.json({ invites: chatService.pendingInvites(req.user.username) });
});

router.post('/invites/:id/respond', asyncHandler(async (req, res) => {
  const result = chatService.respondToInvite(req.params.id, req.user, req.body?.action);

  if (result.joined) {
    realtime.joinUserToChat(req.user.id, result.invite.chat_id);
    realtime.toChat(result.invite.chat_id, 'member:joined', {
      chatId: result.invite.chat_id,
      user: { id: req.user.id, username: req.user.username },
      members: chatService.details(result.invite.chat_id, req.user.id).members,
    });
  }

  res.json(result);
}));

// ─── CHATS ────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  res.json({ chats: chatService.listForUser(req.user.id) });
});

router.post('/', asyncHandler(async (req, res) => {
  const chat = chatService.create(req.user, req.body || {});
  realtime.joinUserToChat(req.user.id, chat.id);
  res.status(201).json({ chat });
}));

router.get('/:id', (req, res) => {
  res.json(chatService.details(req.params.id, req.user.id));
});

router.patch('/:id/ai', asyncHandler(async (req, res) => {
  const chat = chatService.updateAiConfig(req.params.id, req.user.id, req.body || {});
  realtime.toChat(chat.id, 'chat:updated', { chat });
  res.json({ chat });
}));

// ─── MESSAGES ─────────────────────────────────────────────────────────────────

/**
 * History, backfill and pagination in one endpoint.
 *   GET /messages              → most recent page
 *   GET /messages?after=<seq>  → everything missed while disconnected
 *   GET /messages?before=<seq> → older page (scroll up)
 */
router.get('/:id/messages', (req, res) => {
  res.json(chatService.history(req.params.id, req.user.id, {
    after: req.query.after,
    before: req.query.before,
    limit: req.query.limit,
  }));
});

/**
 * HTTP fallback for sending.
 *
 * This is the escape hatch when a client's WebSocket is blocked or flapping: it
 * shares the exact same ingest path as the socket handler, including the
 * `clientMsgId` idempotency key, so a message sent twice across the two
 * transports still lands exactly once.
 */
router.post('/:id/messages', asyncHandler(async (req, res) => {
  const result = messageService.ingest({
    chatId: req.params.id,
    user: req.user,
    content: req.body?.content,
    clientMsgId: req.body?.clientMsgId,
    source: 'http',
  });

  if (!result.duplicate) {
    realtime.toChat(req.params.id, 'message:new', { message: result.message });
    if (result.shouldTriggerAi) realtime.triggerAi(result.chat, result.message);
  }

  res.status(result.duplicate ? 200 : 201).json({
    message: result.message,
    duplicate: result.duplicate,
  });
}));

/** Persist how far this user has actually read — drives unread badges. */
router.post('/:id/read', asyncHandler(async (req, res) => {
  res.json(chatService.markRead(req.params.id, req.user.id, req.body?.seq));
}));

router.post('/:id/invite', asyncHandler(async (req, res) => {
  const invite = chatService.invite(req.params.id, req.user, req.body?.inviteeUsername);
  realtime.toUser(invite.invitee_username, 'invite:received', { invite });
  res.status(201).json({ invite });
}));

module.exports = router;
