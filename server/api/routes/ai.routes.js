const express = require('express');

const { config } = require('../../config');
const aiService = require('../../services/ai.service');
const chatService = require('../../services/chat.service');
const messageService = require('../../services/message.service');
const validate = require('../../core/validate');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/context');
const { badRequest, Codes } = require('../../core/errors');

const router = express.Router();
router.use(requireAuth);

/**
 * List models. Always 200 — an unreachable Ollama is a *state* to render, not an
 * error to throw, and the UI needs the reason to display something useful.
 */
router.get('/models', asyncHandler(async (req, res) => {
  const host = req.query.host ? validate.hostUrl(req.query.host, 'host', { allowPrivate: true }) : config.ai.defaultHost;
  res.json(await aiService.listModels(host));
}));

router.get('/status', asyncHandler(async (req, res) => {
  const host = req.query.host ? validate.hostUrl(req.query.host, 'host', { allowPrivate: true }) : config.ai.defaultHost;
  const health = await aiService.health(host, { force: req.query.force === 'true' });
  const breaker = aiService.breakers.for(host).snapshot();
  res.json({ ...health, breaker });
}));

/** One-shot query with no chat attached. */
router.post('/ask', asyncHandler(async (req, res) => {
  const prompt = validate.string(req.body?.prompt, 'prompt', { min: 1, max: config.chat.maxMessageLength });
  const model = req.body?.model ? validate.string(req.body.model, 'model', { min: 1, max: 100 }) : config.ai.defaultModel;
  const host = req.body?.host ? validate.hostUrl(req.body.host, 'host', { allowPrivate: true }) : config.ai.defaultHost;

  const result = await aiService.chat({
    host,
    model,
    messages: aiService.buildMessages({ contextMessages: [], question: prompt, isDirect: true }),
  });

  res.json({ reply: result.reply, model: result.model, durationMs: result.durationMs });
}));

/** Context-aware query against a chat the caller belongs to. */
router.post('/chat/:chatId', asyncHandler(async (req, res) => {
  const query = validate.string(req.body?.query, 'query', { min: 1, max: config.chat.maxMessageLength });
  const chat = chatService.requireMembership(req.params.chatId, req.user.id);

  if (!chat.ai_enabled) {
    throw badRequest('AI is turned off for this chat.', {
      code: Codes.AI_DISABLED,
      hint: 'The group admin can enable it in the chat settings.',
    });
  }

  const context = messageService.contextFor(chat.id);
  const result = await aiService.chat({
    host: chat.ai_host,
    model: chat.ai_model,
    messages: aiService.buildMessages({
      chatName: chat.name,
      contextMessages: context,
      question: messageService.extractQuestion(query),
      isDirect: chat.type === '1v1',
    }),
  });

  res.json({ reply: result.reply, model: result.model, contextUsed: context.length, durationMs: result.durationMs });
}));

/** Breaker/queue diagnostics — used by the health page and the AI status panel. */
router.get('/diagnostics', (req, res) => {
  res.json(aiService.snapshot());
});

module.exports = router;
