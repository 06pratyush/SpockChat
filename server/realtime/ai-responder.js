/**
 * AI replies in a chat, with failure made visible instead of vanishing.
 *
 * What went wrong before: `triggerAIResponse` emitted `ai:error` to the room, and
 * the client dropped it unless the user happened to be looking at that exact
 * chat. A failed answer therefore left *no trace at all* — the user asked a
 * question, saw a thinking indicator, and then nothing, forever.
 *
 * Now every outcome is durable and observable:
 *   - success  → the reply is stored as a message, like any other
 *   - failure  → a `system` message is stored in the chat explaining what broke
 *                and what to do about it, so it survives reloads and is visible
 *                to everyone in the group
 *   - always   → an `ai:done` event fires, so no client is left with a stuck
 *                spinner even if the request died in an unexpected way
 *
 * Concurrent @AI mentions in the same chat are collapsed: a second mention while
 * one is generating gets a clear "still working on the previous question"
 * instead of queueing up a pile of duplicate generations.
 */

const { config } = require('../config');
const aiService = require('../services/ai.service');
const messageService = require('../services/message.service');
const { createLogger } = require('../core/logger');
const { AppError, Codes } = require('../core/errors');

const log = createLogger('ai-responder');

/** chatId → { startedAt, question } */
const inFlight = new Map();

// A generation can legitimately take minutes; this is the backstop that
// guarantees `inFlight` is released even if something goes badly wrong.
const HARD_CEILING_MS = config.ai.requestTimeoutMs + 30_000;

function isBusy(chatId) {
  const entry = inFlight.get(chatId);
  if (!entry) return false;
  if (Date.now() - entry.startedAt > HARD_CEILING_MS) {
    inFlight.delete(chatId);
    return false;
  }
  return true;
}

/**
 * @param {object} io           socket.io server
 * @param {object} chat         chat row
 * @param {object} triggerMessage the message that mentioned the AI
 */
async function respond(io, chat, triggerMessage) {
  const chatId = chat.id;

  if (isBusy(chatId)) {
    io.to(chatId).emit('ai:busy', {
      chatId,
      error: 'SpockAI is still working on the previous question in this chat.',
      code: Codes.AI_BUSY,
      hint: 'Local models answer one at a time. Your question was not sent — ask again once the current answer arrives.',
    });
    return { skipped: true, reason: 'busy' };
  }

  inFlight.set(chatId, { startedAt: Date.now(), question: triggerMessage.content });
  io.to(chatId).emit('ai:thinking', { chatId, model: chat.ai_model, since: Date.now() });

  try {
    const context = messageService.contextFor(chatId);
    const question = messageService.extractQuestion(triggerMessage.content);

    const result = await aiService.chat({
      host: chat.ai_host,
      model: chat.ai_model,
      messages: aiService.buildMessages({
        chatName: chat.name,
        contextMessages: context,
        question,
        isDirect: chat.type === '1v1',
      }),
    });

    const message = messageService.recordAiMessage(chatId, result.reply);
    io.to(chatId).emit('message:new', { message });

    log.info('AI replied', {
      chatId, model: result.model, ms: result.durationMs, contextMessages: context.length,
    });

    return { ok: true, message };
  } catch (err) {
    const appError = err instanceof AppError ? err : null;
    const reason = appError?.message || err.message || 'Unknown AI failure';
    const hint = appError?.hint;

    // Persist the failure as a visible system message. This is the difference
    // between "the AI ignored me" and "the AI could not run, and here is why".
    let notice = null;
    try {
      notice = messageService.recordSystemNotice(
        chatId,
        `⚠️ SpockAI could not answer: ${reason}${hint ? `\n💡 ${hint}` : ''}`
      );
      io.to(chatId).emit('message:new', { message: notice });
    } catch (persistErr) {
      log.error('could not persist the AI failure notice', { chatId, err: persistErr });
    }

    io.to(chatId).emit('ai:error', {
      chatId,
      error: reason,
      code: appError?.code || Codes.AI_UNREACHABLE,
      hint,
      retryable: appError?.retryable ?? true,
      messageId: notice?.id || null,
    });

    log.warn('AI failed to answer', { chatId, code: appError?.code, reason });
    return { ok: false, error: reason };
  } finally {
    inFlight.delete(chatId);
    io.to(chatId).emit('ai:done', { chatId });
  }
}

function snapshot() {
  return {
    inFlight: [...inFlight.entries()].map(([chatId, v]) => ({ chatId, elapsedMs: Date.now() - v.startedAt })),
  };
}

module.exports = { respond, isBusy, snapshot };
