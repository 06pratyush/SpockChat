const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const {
  createChat, getChatById, getUserChats, updateChatAI,
  addChatMember, getChatMembers, isChatMember, getChatMemberCount,
  getChatHistory,
  createInvite, getPendingInvites, updateInviteStatus, getInviteById,
  getFriends,
} = require('../db');

const router = express.Router();

// GET /api/chats — list user's chats
router.get('/', authMiddleware, (req, res) => {
  const chats = getUserChats(req.user.id);
  res.json({ chats });
});

// POST /api/chats — create new chat
router.post('/', authMiddleware, (req, res) => {
  const { name, type, aiEnabled, aiModel, aiHost } = req.body;

  if (!name || !type) {
    return res.status(400).json({ error: 'Name and type required' });
  }
  if (!['1v1', 'group'].includes(type)) {
    return res.status(400).json({ error: 'Type must be 1v1 or group' });
  }
  if (name.length < 1 || name.length > 64) {
    return res.status(400).json({ error: 'Name must be 1–64 characters' });
  }

  const chat = createChat(
    name, type, req.user.id,
    !!aiEnabled,
    aiModel || 'llama3',
    aiHost || 'http://localhost:11434'
  );

  addChatMember(chat.id, req.user.id, req.user.username, true);

  res.status(201).json({ chat: { ...chat, is_admin: 1, member_count: 1 } });
});

// GET /api/chats/:id — chat details + members
router.get('/:id', authMiddleware, (req, res) => {
  const chat = getChatById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (!isChatMember(req.params.id, req.user.id)) {
    return res.status(403).json({ error: 'Not a member' });
  }

  const members = getChatMembers(req.params.id);
  res.json({ chat, members });
});

// GET /api/chats/:id/messages — chat history
router.get('/:id/messages', authMiddleware, (req, res) => {
  const chat = getChatById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (!isChatMember(req.params.id, req.user.id)) {
    return res.status(403).json({ error: 'Not a member' });
  }

  const messages = getChatHistory(req.params.id);
  res.json({ messages });
});

// POST /api/chats/:id/invite — invite a friend to group chat
router.post('/:id/invite', authMiddleware, (req, res) => {
  const { inviteeUsername } = req.body;
  if (!inviteeUsername) {
    return res.status(400).json({ error: 'inviteeUsername required' });
  }

  const chat = getChatById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (!isChatMember(req.params.id, req.user.id)) {
    return res.status(403).json({ error: 'Not a member' });
  }
  if (chat.type !== 'group') {
    return res.status(400).json({ error: 'Can only invite to group chats' });
  }

  const memberCount = getChatMemberCount(req.params.id);
  if (memberCount >= 5) {
    return res.status(400).json({ error: 'Group is full (max 5 members)' });
  }

  const invite = createInvite(
    chat.id, chat.name,
    req.user.id, req.user.username,
    inviteeUsername
  );

  // Notify the invitee via socket if they're connected
  const io = req.app.get('io');
  const connectedUsers = req.app.get('connectedUsers'); // Map<username, socketId>
  const targetSocketId = connectedUsers.get(inviteeUsername);
  if (targetSocketId) {
    io.to(targetSocketId).emit('invite:received', { invite });
  }

  res.json({ invite });
});

// GET /api/invites — pending invites for current user
router.get('/invites/pending', authMiddleware, (req, res) => {
  const invites = getPendingInvites(req.user.username);
  res.json({ invites });
});

// POST /api/invites/:id/respond — accept or reject
router.post('/invites/:id/respond', authMiddleware, (req, res) => {
  const { action } = req.body; // 'accept' or 'reject'
  if (!['accept', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Action must be accept or reject' });
  }

  const invite = getInviteById(req.params.id);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.invitee_username !== req.user.username) {
    return res.status(403).json({ error: 'Not your invite' });
  }
  if (invite.status !== 'pending') {
    return res.status(400).json({ error: 'Invite already responded to' });
  }

  const status = action === 'accept' ? 'accepted' : 'rejected';
  updateInviteStatus(invite.id, req.user.username, status);

  if (action === 'accept') {
    const chat = getChatById(invite.chat_id);
    if (chat) {
      const memberCount = getChatMemberCount(chat.id);
      if (memberCount < 5) {
        addChatMember(chat.id, req.user.id, req.user.username, false);

        // Notify all chat members
        const io = req.app.get('io');
        io.to(invite.chat_id).emit('member:joined', {
          chatId: invite.chat_id,
          user: { id: req.user.id, username: req.user.username },
        });
      }
    }
  }

  res.json({ status, invite: { ...invite, status } });
});

// PATCH /api/chats/:id/ai — admin updates AI config
router.patch('/:id/ai', authMiddleware, (req, res) => {
  const { aiEnabled, aiModel, aiHost } = req.body;
  const chat = getChatById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  const members = getChatMembers(req.params.id);
  const isAdmin = members.some(m => m.user_id === req.user.id && m.is_admin);
  if (!isAdmin) return res.status(403).json({ error: 'Only admin can modify AI settings' });

  updateChatAI(
    req.params.id,
    aiEnabled !== undefined ? aiEnabled : chat.ai_enabled,
    aiModel || chat.ai_model,
    aiHost || chat.ai_host
  );

  res.json({ success: true });
});

module.exports = router;
