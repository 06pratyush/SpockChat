const express = require('express');
const fetch = require('node-fetch');
const { authMiddleware } = require('../middleware/auth');
const { getChatById, getChatContext, isChatMember } = require('../db');

const router = express.Router();

// GET /api/ai/models?host=http://localhost:11434 — list available local models
router.get('/models', authMiddleware, async (req, res) => {
  const host = req.query.host || 'http://localhost:11434';

  try {
    const response = await fetch(`${host}/api/tags`, { timeout: 4000 });
    if (!response.ok) throw new Error('Ollama not responding');
    const data = await response.json();
    res.json({ models: (data.models || []).map(m => m.name) });
  } catch (err) {
    res.status(503).json({ error: 'Cannot reach Ollama at ' + host, models: [] });
  }
});

// POST /api/ai/ask — direct 1v1 AI query (no chat context required)
router.post('/ask', authMiddleware, async (req, res) => {
  const { prompt, model, host } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  const aiHost = host || 'http://localhost:11434';
  const aiModel = model || 'llama3';

  try {
    const reply = await callOllama(aiHost, aiModel, [
      { role: 'system', content: 'You are SpockAI, a helpful local AI assistant running privately on the user\'s machine. Be concise, clear, and logical.' },
      { role: 'user', content: prompt },
    ]);
    res.json({ reply });
  } catch (err) {
    res.status(503).json({ error: `AI error: ${err.message}` });
  }
});

// POST /api/ai/chat/:chatId — context-aware group AI query
router.post('/chat/:chatId', authMiddleware, async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Query required' });

  const chat = getChatById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (!isChatMember(req.params.chatId, req.user.id)) {
    return res.status(403).json({ error: 'Not a member' });
  }
  if (!chat.ai_enabled) {
    return res.status(400).json({ error: 'AI not enabled in this chat' });
  }

  // Pull last 40 messages as context
  const context = getChatContext(req.params.chatId);
  const contextText = context
    .map(m => `${m.sender_username}: ${m.content}`)
    .join('\n');

  const messages = [
    {
      role: 'system',
      content: `You are SpockAI, an AI assistant embedded in a group chat called "${chat.name}". 
You have access to the recent conversation history. Answer questions accurately, referencing the chat context when relevant. 
Be concise and helpful. If tagged with @AI, answer the specific question asked.

Recent chat context (${context.length} messages):
${contextText || '(no messages yet)'}`,
    },
    { role: 'user', content: query },
  ];

  try {
    const reply = await callOllama(chat.ai_host, chat.ai_model, messages);
    res.json({ reply, contextUsed: context.length });
  } catch (err) {
    res.status(503).json({ error: `AI error: ${err.message}` });
  }
});

// GET /api/ai/status?host=... — check if Ollama is reachable
router.get('/status', authMiddleware, async (req, res) => {
  const host = req.query.host || 'http://localhost:11434';
  try {
    const r = await fetch(`${host}/api/tags`, { timeout: 3000 });
    res.json({ online: r.ok, host });
  } catch {
    res.json({ online: false, host });
  }
});

// ─── OLLAMA HELPER ────────────────────────────────────────────────────────────

async function callOllama(host, model, messages) {
  const response = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
    }),
    timeout: 120000, // 2 min for slow local models
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama returned ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.message?.content || data.response || '';
}

module.exports = router;
