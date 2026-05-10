const { verifyToken } = require('../middleware/auth');
const { saveMessage, getChatById, isChatMember, getChatContext } = require('../db');
const fetch = require('node-fetch');

/**
 * connectedUsers: Map<username, socketId>
 * Used for targeted delivery of invites, friend requests, notifications.
 */

module.exports = function registerSocketHandlers(io) {
  const connectedUsers = new Map(); // username → socketId

  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('No auth token'));

    const payload = verifyToken(token);
    if (!payload) return next(new Error('Invalid token'));

    socket.userId = payload.id;
    next();
  });

  io.on('connection', (socket) => {
    // ── ON CONNECT ──────────────────────────────────────────────────────────
    const { getUserById } = require('../db');
    const user = getUserById(socket.userId);
    if (!user) return socket.disconnect();

    socket.username = user.username;
    connectedUsers.set(user.username, socket.id);
    console.log(`[Socket] ${user.username} connected (${socket.id})`);

    // ── JOIN CHAT ROOMS ─────────────────────────────────────────────────────
    socket.on('chats:join', ({ chatIds }) => {
      if (!Array.isArray(chatIds)) return;
      chatIds.forEach(chatId => {
        if (isChatMember(chatId, socket.userId)) {
          socket.join(chatId);
        }
      });
    });

    socket.on('chat:join', ({ chatId }) => {
      if (isChatMember(chatId, socket.userId)) {
        socket.join(chatId);
      }
    });

    // ── SEND MESSAGE ────────────────────────────────────────────────────────
    socket.on('message:send', async ({ chatId, content }) => {
      if (!chatId || !content?.trim()) return;
      if (!isChatMember(chatId, socket.userId)) return;

      const chat = getChatById(chatId);
      if (!chat) return;

      // Save to DB
      const message = saveMessage(chatId, socket.userId, socket.username, content.trim(), 'text');

      // Broadcast to all in room (including sender for confirmation)
      io.to(chatId).emit('message:new', { message });

      // If message contains @AI and AI is enabled, trigger AI response
      if (chat.ai_enabled && content.includes('@AI')) {
        triggerAIResponse(io, socket, chat, chatId, content);
      }
    });

    // ── TYPING INDICATOR ────────────────────────────────────────────────────
    socket.on('typing:start', ({ chatId }) => {
      if (!isChatMember(chatId, socket.userId)) return;
      socket.to(chatId).emit('typing:update', {
        username: socket.username,
        isTyping: true,
      });
    });

    socket.on('typing:stop', ({ chatId }) => {
      socket.to(chatId).emit('typing:update', {
        username: socket.username,
        isTyping: false,
      });
    });

    // ── MANUAL AI TRIGGER ───────────────────────────────────────────────────
    socket.on('ai:query', async ({ chatId, query }) => {
      if (!chatId || !query?.trim()) return;
      if (!isChatMember(chatId, socket.userId)) return;

      const chat = getChatById(chatId);
      if (!chat || !chat.ai_enabled) {
        socket.emit('ai:error', { chatId, error: 'AI not enabled in this chat' });
        return;
      }

      triggerAIResponse(io, socket, chat, chatId, query);
    });

    // ── DISCONNECT ──────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      connectedUsers.delete(socket.username);
      console.log(`[Socket] ${socket.username} disconnected`);
    });
  });

  // Expose connectedUsers map so routes can do targeted emits
  io.connectedUsers = connectedUsers;
  return connectedUsers;
};

// ─── AI RESPONSE HELPER ───────────────────────────────────────────────────────

async function triggerAIResponse(io, socket, chat, chatId, userMessage) {
  // Broadcast "AI is thinking" state
  io.to(chatId).emit('ai:thinking', { chatId });

  try {
    const context = getChatContext(chatId);
    const contextText = context.map(m => `${m.sender_username}: ${m.content}`).join('\n');

    const messages = [
      {
        role: 'system',
        content: `You are SpockAI, an AI assistant in a group chat called "${chat.name}". 
You have access to recent chat history. Be concise, helpful, and reference the conversation when relevant.
The user tagged @AI to ask you something.

Recent chat context (${context.length} messages):
${contextText || '(no messages yet)'}`,
      },
      {
        role: 'user',
        content: userMessage.replace(/@AI\s*/gi, '').trim() || userMessage,
      },
    ];

    const response = await fetch(`${chat.ai_host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: chat.ai_model, messages, stream: false }),
      timeout: 120000,
    });

    if (!response.ok) throw new Error(`Ollama error ${response.status}`);
    const data = await response.json();
    const reply = data.message?.content || data.response || '(no response)';

    // Save AI message to DB
    const aiMessage = saveMessage(chatId, null, 'SpockAI', reply, 'ai');

    // Broadcast AI response
    io.to(chatId).emit('message:new', { message: aiMessage });
    io.to(chatId).emit('ai:done', { chatId });
  } catch (err) {
    io.to(chatId).emit('ai:error', { chatId, error: err.message });
    io.to(chatId).emit('ai:done', { chatId });
  }
}
