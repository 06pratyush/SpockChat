/**
 * Realtime layer — Socket.IO server, presence, and the delivery guarantees that
 * make SpockChat survive a lossy network.
 *
 * ── How a message is *not* lost ──────────────────────────────────────────────
 *
 * 1. **Acknowledgements.** `message:send` takes a callback. The client does not
 *    consider a message sent until the server acknowledges it with a stored row.
 *    The original had no ack at all: `socket.emit(...)` on a dead connection
 *    silently discarded the message and the UI happily cleared the input box.
 *
 * 2. **Idempotency.** Every send carries a `clientMsgId`. Retrying after a lost
 *    ack returns the *original* stored message, so "retry until acknowledged" is
 *    safe and can never duplicate.
 *
 * 3. **Sequence numbers.** Every message has a per-chat `seq` that increases by
 *    one. Clients track the highest seq they hold.
 *
 * 4. **Gap detection and backfill.** On (re)connect the client sends its last
 *    known seq per chat via `chats:sync`; the server replies with everything
 *    missed. Nothing has to be remembered in memory on either side, so this
 *    works across a server restart too.
 *
 * 5. **Transport recovery.** Socket.IO connection-state recovery replays packets
 *    across brief drops, and the ack + backfill path covers everything longer.
 *
 * 6. **Server-side heartbeats.** ping/pong detects half-open TCP connections —
 *    the "connected but nothing arrives" state that a laptop lid-close creates.
 */

const { Server } = require('socket.io');

const { config } = require('../config');
const { createLogger } = require('../core/logger');
const { RateLimiter } = require('../core/rate-limiter');
const { AppError, Codes, internal } = require('../core/errors');
const { onShutdown } = require('../core/lifecycle');

const authService = require('../services/auth.service');
const chatService = require('../services/chat.service');
const messageService = require('../services/message.service');
const chats = require('../db/repositories/chats.repo');
const messages = require('../db/repositories/messages.repo');

const { Presence } = require('./presence');
const aiResponder = require('./ai-responder');
const registry = require('./registry');
const tunnelService = require('../services/tunnel.service');

const log = createLogger('socket');

/** Uniform failure shape for every socket callback. */
function failure(err) {
  const appError = err instanceof AppError ? err : internal();
  return {
    ok: false,
    error: appError.message,
    code: appError.code,
    hint: appError.hint || null,
    retryable: appError.retryable ?? false,
  };
}

/** Callbacks are optional on the wire; never throw because one was omitted. */
function reply(ack, payload) {
  if (typeof ack === 'function') {
    try { ack(payload); } catch (err) { log.warn('ack callback threw', { err }); }
  }
  return payload;
}

function attach(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: config.server.corsOrigin, methods: ['GET', 'POST'] },
    pingInterval: config.realtime.pingIntervalMs,
    pingTimeout: config.realtime.pingTimeoutMs,
    maxHttpBufferSize: config.realtime.maxHttpBufferSize,
    connectionStateRecovery: {
      maxDisconnectionDuration: config.realtime.connectionRecoveryMs,
      skipMiddlewares: false,
    },
  });

  const presence = new Presence();

  const messageLimiter = new RateLimiter({
    name: 'socket-messages',
    capacity: config.limits.messagesPerMinute,
    refillPerMin: config.limits.messagesPerMinute,
  });
  const aiLimiter = new RateLimiter({
    name: 'socket-ai',
    capacity: config.limits.aiRequestsPerMinute,
    refillPerMin: config.limits.aiRequestsPerMinute,
  });

  // ── AUTH HANDSHAKE ──────────────────────────────────────────────────────────
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    try {
      socket.data.user = authService.authenticate(token);
      next();
    } catch (err) {
      const appError = err instanceof AppError ? err : internal();
      // Socket.IO surfaces `data` to the client's connect_error handler, so the
      // UI can tell "expired, log in again" from "server restarted, retry".
      const wrapped = new Error(appError.message);
      wrapped.data = { code: appError.code, hint: appError.hint, retryable: appError.retryable };
      next(wrapped);
    }
  });

  io.on('connection', socket => {
    const user = socket.data.user;
    const connections = presence.add(socket.id, user);
    const recovered = socket.recovered;

    log.info(`${user.username} connected`, { socketId: socket.id, connections, recovered });

    // Join every room this user belongs to, immediately — no client round trip,
    // so a message sent one millisecond after connect is still delivered.
    const memberChatIds = chats.chatIdsForUser(user.id);
    for (const chatId of memberChatIds) socket.join(chatId);

    socket.emit('ready', {
      user: { id: user.id, username: user.username },
      chatIds: memberChatIds,
      serverTime: Date.now(),
      recovered,
      limits: {
        maxMessageLength: config.chat.maxMessageLength,
        messagesPerMinute: config.limits.messagesPerMinute,
      },
    });

    // ── SYNC: the reconnect backfill ─────────────────────────────────────────
    // The client sends { chatId: lastSeqItHas }. The server returns everything
    // after that point, so a disconnection of any length heals automatically.
    socket.on('chats:sync', ({ cursors } = {}, ack) => {
      try {
        const result = {};
        const requested = cursors && typeof cursors === 'object' ? cursors : {};

        for (const chatId of chats.chatIdsForUser(user.id)) {
          socket.join(chatId);
          const from = Number.isFinite(Number(requested[chatId])) ? Number(requested[chatId]) : 0;
          const latest = messages.latestSeq(chatId);
          const missed = from < latest ? messages.since(chatId, from, 200) : [];
          result[chatId] = { latestSeq: latest, missed, complete: missed.length === 0 || missed[missed.length - 1].seq >= latest };
          if (missed.length) {
            log.debug('backfilled missed messages', { chatId, user: user.username, count: missed.length, from });
          }
        }

        reply(ack, { ok: true, chats: result, serverTime: Date.now() });
      } catch (err) {
        log.error('chats:sync failed', { err, user: user.username });
        reply(ack, failure(err));
      }
    });

    socket.on('chat:join', ({ chatId } = {}, ack) => {
      try {
        chatService.requireMembership(chatId, user.id);
        socket.join(chatId);
        reply(ack, { ok: true, chatId, latestSeq: messages.latestSeq(chatId) });
      } catch (err) {
        reply(ack, failure(err));
      }
    });

    // ── SEND ─────────────────────────────────────────────────────────────────
    socket.on('message:send', ({ chatId, content, clientMsgId } = {}, ack) => {
      try {
        const limit = messageLimiter.take(user.id);
        if (!limit.allowed) {
          throw new AppError(Codes.RATE_LIMITED, 'You are sending messages too quickly.', {
            status: 429,
            retryable: true,
            hint: `Wait ${Math.ceil(limit.retryAfterMs / 1000)}s and try again.`,
          });
        }

        const result = messageService.ingest({ chatId, user, content, clientMsgId, source: 'socket' });

        // Acknowledge the sender first: their retry loop can stop immediately.
        reply(ack, {
          ok: true,
          message: result.message,
          duplicate: result.duplicate,
          seq: result.message.seq,
        });

        if (!result.duplicate) {
          io.to(chatId).emit('message:new', { message: result.message });
          if (result.shouldTriggerAi) {
            aiResponder.respond(io, result.chat, result.message)
              .catch(err => log.error('AI responder crashed', { err, chatId }));
          }
        }
      } catch (err) {
        if (!(err instanceof AppError)) log.error('message:send failed', { err, user: user.username });
        reply(ack, failure(err));
        socket.emit('message:failed', {
          chatId,
          clientMsgId: clientMsgId || null,
          ...failure(err),
        });
      }
    });

    // ── READ CURSOR ──────────────────────────────────────────────────────────
    socket.on('message:read', ({ chatId, seq } = {}, ack) => {
      try {
        reply(ack, { ok: true, ...chatService.markRead(chatId, user.id, seq) });
      } catch (err) {
        reply(ack, failure(err));
      }
    });

    // ── TYPING ───────────────────────────────────────────────────────────────
    socket.on('typing:start', ({ chatId } = {}) => {
      if (!chatId || !chats.isMember(chatId, user.id)) return;
      socket.to(chatId).emit('typing:update', { chatId, username: user.username, isTyping: true });
    });

    socket.on('typing:stop', ({ chatId } = {}) => {
      if (!chatId || !chats.isMember(chatId, user.id)) return;
      socket.to(chatId).emit('typing:update', { chatId, username: user.username, isTyping: false });
    });

    // ── EXPLICIT AI TRIGGER ──────────────────────────────────────────────────
    socket.on('ai:query', async ({ chatId, query } = {}, ack) => {
      try {
        const limit = aiLimiter.take(user.id);
        if (!limit.allowed) {
          throw new AppError(Codes.RATE_LIMITED, 'Too many AI requests.', {
            status: 429,
            retryable: true,
            hint: `Wait ${Math.ceil(limit.retryAfterMs / 1000)}s before asking again.`,
          });
        }

        const chat = chatService.requireMembership(chatId, user.id);
        if (!chat.ai_enabled) {
          throw new AppError(Codes.AI_DISABLED, 'AI is turned off for this chat.', {
            status: 400,
            hint: 'The group admin can enable it in chat settings.',
          });
        }

        reply(ack, { ok: true, accepted: true });
        await aiResponder.respond(io, chat, { content: query || '' });
      } catch (err) {
        reply(ack, failure(err));
        socket.emit('ai:error', { chatId, ...failure(err) });
      }
    });

    // ── HEARTBEAT ────────────────────────────────────────────────────────────
    // An explicit round trip the client can time, so the UI can show "connection
    // is slow" before the connection actually dies.
    socket.on('ping:check', (sentAt, ack) => {
      reply(ack, { serverTime: Date.now(), clientTime: sentAt ?? null });
    });

    socket.on('error', err => {
      log.warn('socket error', { socketId: socket.id, user: user.username, err });
    });

    socket.on('disconnect', reason => {
      const { remaining } = presence.remove(socket.id);
      log.info(`${user.username} disconnected`, { reason, remainingSockets: remaining });
    });
  });

  io.engine.on('connection_error', err => {
    log.warn('handshake rejected', { code: err.code, message: err.message });
  });

  // ── TUNNEL STATE PUSH ──────────────────────────────────────────────────────
  // The tunnel can drop and reconnect with a *different* public URL. Clients are
  // told, so nobody keeps sharing an address that no longer routes anywhere.
  tunnelService.events.on('change', state => {
    io.emit('tunnel:state', state);
  });

  // ── FAÇADE FOR HTTP ROUTES ─────────────────────────────────────────────────
  const facade = {
    io,
    presence,
    toChat: (chatId, event, payload) => io.to(chatId).emit(event, payload),
    toUser: (username, event, payload) => {
      for (const socketId of presence.socketIdsForUsername(username)) {
        io.to(socketId).emit(event, payload);
      }
    },
    joinUserToChat: (userId, chatId) => {
      for (const socketId of presence.socketIdsForUserId(userId)) {
        io.sockets.sockets.get(socketId)?.join(chatId);
      }
    },
    triggerAi: (chat, message) =>
      aiResponder.respond(io, chat, message).catch(err => log.error('AI responder crashed', { err })),
    connectionCount: () => presence.connectionCount,
    onlineUsernames: () => presence.usernames(),
    isOnline: username => presence.isOnline(username),
    snapshot: () => ({ ...presence.snapshot(), ai: aiResponder.snapshot() }),
  };

  registry.register(facade);

  onShutdown('socket-server', async () => {
    messageLimiter.stop();
    aiLimiter.stop();
    // Tell clients this was deliberate so they show "server stopped", not "network error".
    io.emit('server:shutdown', { message: 'This SpockChat server is shutting down.' });
    await new Promise(resolve => {
      io.close(resolve);
      setTimeout(resolve, 3_000).unref?.();
    });
  }, { timeoutMs: 6_000 });

  return facade;
}

module.exports = { attach };
