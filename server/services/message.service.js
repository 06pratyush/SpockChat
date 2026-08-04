/**
 * Message ingestion — the single path every message takes, whether it arrives
 * over a socket or over HTTP.
 *
 * Having one path matters for reliability: the HTTP endpoint is the fallback a
 * client uses when its socket is down, and it must produce byte-identical
 * results (same idempotency, same sequence numbering) or a retry over the
 * fallback would duplicate the message.
 */

const { config } = require('../config');
const messages = require('../db/repositories/messages.repo');
const chats = require('../db/repositories/chats.repo');
const chatService = require('./chat.service');
const validate = require('../core/validate');
const { createLogger } = require('../core/logger');

const log = createLogger('messages');

const AI_MENTION = /@ai\b/i;

/**
 * Persist a message from a human.
 *
 * @returns {{message:object, duplicate:boolean, chat:object, shouldTriggerAi:boolean}}
 *   `duplicate` is true when this exact `clientMsgId` was already stored — the
 *   caller should still acknowledge success, because the sender's retry has now
 *   provably been received.
 */
function ingest({ chatId, user, content, clientMsgId, source = 'socket' }) {
  const chat = chatService.requireMembership(chatId, user.id);
  const body = validate.messageContent(content);
  const idempotencyKey = validate.clientMessageId(clientMsgId);

  const { message, duplicate } = messages.append({
    chatId,
    senderId: user.id,
    senderUsername: user.username,
    content: body,
    type: 'text',
    clientMsgId: idempotencyKey,
  });

  if (!duplicate) {
    chats.touch(chatId);
    // The sender has, by definition, seen their own message.
    messages.setCursor(chatId, user.id, message.seq);
  } else {
    log.debug('idempotent replay suppressed', { chatId, clientMsgId: idempotencyKey, seq: message.seq });
  }

  return {
    message,
    duplicate,
    chat,
    shouldTriggerAi: !duplicate && shouldTriggerAi(chat, body),
  };
}

/**
 * Should this message wake the AI?
 *
 * 1v1 AI chats answer every message — that is the entire point of them, and the
 * original code silently required "@AI" there too, so a 1v1 chat never replied.
 * Group chats answer only when explicitly tagged, so the model does not butt in.
 */
function shouldTriggerAi(chat, content) {
  if (!chat.ai_enabled) return false;
  if (chat.type === '1v1') return true;
  return AI_MENTION.test(content);
}

/** Store an AI reply (or an AI failure notice) as a first-class message. */
function recordAiMessage(chatId, content, { type = 'ai' } = {}) {
  const { message } = messages.append({
    chatId,
    senderId: null,
    senderUsername: 'SpockAI',
    content: String(content).slice(0, config.chat.maxMessageLength),
    type,
  });
  chats.touch(chatId);
  return message;
}

/**
 * Store a system notice (AI failure, member joined, tunnel dropped…).
 *
 * Persisting failures is deliberate. The original emitted `ai:error` over the
 * socket and dropped it if the user was not looking at that chat — so a failed
 * answer left no trace at all and the user just saw their question go unanswered.
 */
function recordSystemNotice(chatId, text) {
  return recordAiMessage(chatId, text, { type: 'system' });
}

function contextFor(chatId) {
  return messages.contextWindow(chatId, config.chat.aiContextMessages);
}

/** Strip the @AI tag before handing the question to the model. */
function extractQuestion(content) {
  const stripped = content.replace(/@ai\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return stripped || content.trim();
}

module.exports = {
  ingest, shouldTriggerAi, recordAiMessage, recordSystemNotice,
  contextFor, extractQuestion, AI_MENTION,
};
