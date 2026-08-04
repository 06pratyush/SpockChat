/**
 * Ollama integration.
 *
 * The original called `fetch` with a 2-minute timeout and surfaced whatever came
 * back, which produced messages like `AI error: request to
 * http://localhost:11434/api/chat failed, reason:` — literally an empty reason.
 * If Ollama was down, every @AI mention still paid the full timeout.
 *
 * This service adds, per Ollama host:
 *   - a **circuit breaker**: after a few consecutive failures the next calls fail
 *     instantly with "Ollama is not responding" and a retry countdown, instead of
 *     hanging for two minutes each
 *   - a **bounded queue**: one generation at a time (a local GPU cannot do more),
 *     with a shallow backlog and an immediate, honest "AI is busy" past that
 *   - **retry with jitter** for transient socket errors only — never for a
 *     model-not-found, which would just fail again
 *   - **error classification**: model missing, host down, timeout, bad response
 *     and out-of-memory each get their own message and fix-it hint
 *   - a **health cache** so the UI can show AI status without hammering Ollama
 */

const { config } = require('../config');
const { createLogger } = require('../core/logger');
const { request, requestJson, HttpError } = require('../core/http');
const { withRetry } = require('../core/retry');
const { BreakerRegistry } = require('../core/circuit-breaker');
const { QueueRegistry, QueueFullError } = require('../core/task-queue');
const { AppError, Codes, unavailable, badRequest } = require('../core/errors');

const log = createLogger('ai');

const breakers = new BreakerRegistry({
  name: 'ollama',
  failureThreshold: config.ai.breaker.failureThreshold,
  resetTimeoutMs: config.ai.breaker.resetTimeoutMs,
  onStateChange: ({ name, from, to }) => {
    const level = to === 'closed' ? 'info' : 'warn';
    log[level](`circuit ${from} → ${to}`, { host: name });
  },
});

const queues = new QueueRegistry({
  name: 'ollama',
  concurrency: config.ai.maxConcurrentPerHost,
  maxQueue: config.ai.maxQueueDepth,
});

/** host → { online, models, checkedAt, error } */
const healthCache = new Map();
const HEALTH_TTL_MS = 10_000;

// ─── ERROR MAPPING ────────────────────────────────────────────────────────────

/**
 * Turn any Ollama failure into an AppError whose `message` says what broke and
 * whose `hint` says what to do about it.
 */
function classify(err, { host, model }) {
  if (err instanceof AppError) return err;

  if (err instanceof QueueFullError) {
    return unavailable('The AI is busy with earlier requests.', {
      code: Codes.AI_BUSY,
      hint: 'Local models answer one at a time. Wait for the current reply, then ask again.',
      cause: err,
    });
  }

  if (err instanceof HttpError) {
    if (err.code === 'TIMEOUT') {
      return unavailable(`${model} did not finish within ${Math.round(config.ai.requestTimeoutMs / 1000)}s.`, {
        code: Codes.AI_TIMEOUT,
        hint: 'Large models are slow on first load. Try a smaller model (phi3, llama3.2) or ask a shorter question.',
        cause: err,
      });
    }
    if (err.code === 'CONNECTION_REFUSED') {
      return unavailable(`Ollama is not running at ${host}.`, {
        code: Codes.AI_UNREACHABLE,
        hint: 'Open a terminal and run "ollama serve", then try again.',
        cause: err,
      });
    }
    if (err.code === 'NOT_SPOCKCHAT' || err.code === 'BAD_JSON') {
      return unavailable(`${host} answered, but not like an Ollama server.`, {
        code: Codes.AI_BAD_RESPONSE,
        hint: 'Check the AI host address in the chat settings — Ollama normally listens on http://localhost:11434.',
        cause: err,
      });
    }
    return unavailable(err.message, {
      code: Codes.AI_UNREACHABLE,
      hint: err.body || 'Check that Ollama is running and reachable from this machine.',
      cause: err,
    });
  }

  return unavailable(`AI request failed: ${err.message}`, { code: Codes.AI_UNREACHABLE, cause: err });
}

/** Ollama returns 404 for an unpulled model — the single most common user error. */
function classifyHttpStatus(res, { host, model }) {
  const body = (res.json && (res.json.error || res.json.message)) || res.text || '';
  const text = String(body).toLowerCase();

  if (res.status === 404 || text.includes('not found') || text.includes('try pulling')) {
    return badRequest(`The model "${model}" is not installed on ${host}.`, {
      code: Codes.AI_MODEL_MISSING,
      status: 400,
      hint: `Run "ollama pull ${model}" on the machine hosting the model, then try again.`,
    });
  }
  if (res.status === 413 || text.includes('context') && text.includes('exceed')) {
    return badRequest('The conversation is too long for this model’s context window.', {
      code: Codes.AI_BAD_RESPONSE,
      hint: 'Start a new chat, or lower AI_CONTEXT_MESSAGES in .env.',
    });
  }
  if (text.includes('out of memory') || text.includes('cuda') || res.status === 500) {
    return unavailable(`Ollama could not run "${model}" (${res.status}).`, {
      code: Codes.AI_UNREACHABLE,
      hint: 'The model may be too large for this machine’s RAM/VRAM. Try a smaller model such as phi3.',
    });
  }
  return unavailable(`Ollama returned HTTP ${res.status}.`, {
    code: Codes.AI_UNREACHABLE,
    hint: String(body).slice(0, 200) || 'Check the Ollama server log for details.',
  });
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Ask a model to continue a conversation.
 *
 * @param {object}  opts
 * @param {string}  opts.host
 * @param {string}  opts.model
 * @param {Array<{role:string,content:string}>} opts.messages
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{reply:string, model:string, host:string, durationMs:number}>}
 */
async function chat({ host, model, messages, signal = null }) {
  const targetHost = host || config.ai.defaultHost;
  const targetModel = model || config.ai.defaultModel;
  const breaker = breakers.for(targetHost);
  const queue = queues.for(targetHost);
  const started = Date.now();

  try {
    return await queue.push(() =>
      breaker.run(
        () =>
          withRetry(
            async () => {
              const res = await request(`${targetHost}/api/chat`, {
                method: 'POST',
                body: JSON.stringify({ model: targetModel, messages, stream: false }),
                timeoutMs: config.ai.requestTimeoutMs,
                signal,
              });

              if (!res.ok) {
                const mapped = classifyHttpStatus(res, { host: targetHost, model: targetModel });
                // A missing model will never fix itself on retry, and it must not
                // count towards opening the circuit for an otherwise healthy host.
                if (mapped.code === Codes.AI_MODEL_MISSING) {
                  mapped.doNotTrip = true;
                  throw mapped;
                }
                throw mapped;
              }

              const reply = res.json?.message?.content ?? res.json?.response ?? '';
              if (typeof reply !== 'string' || !reply.trim()) {
                throw unavailable('The model returned an empty response.', {
                  code: Codes.AI_BAD_RESPONSE,
                  hint: 'This usually means the model was interrupted. Try asking again.',
                });
              }

              return {
                reply: reply.trim(),
                model: targetModel,
                host: targetHost,
                durationMs: Date.now() - started,
              };
            },
            {
              retries: config.ai.retries,
              baseDelayMs: 400,
              signal,
              shouldRetry: err =>
                err instanceof HttpError &&
                ['CONNECTION_RESET', 'NETWORK_ERROR', 'CONNECTION_REFUSED'].includes(err.code),
              onRetry: ({ attempt, delay, err }) =>
                log.warn('retrying Ollama call', { host: targetHost, attempt, delay, reason: err.message }),
            }
          ),
        (lastError, retryAfterMs) =>
          unavailable(`Ollama at ${targetHost} is not responding.`, {
            code: Codes.AI_CIRCUIT_OPEN,
            hint:
              `SpockChat stopped calling it after repeated failures and will try again in ` +
              `${Math.ceil(retryAfterMs / 1000)}s. Start Ollama with "ollama serve", then retry.` +
              (lastError ? ` Last error: ${lastError.message}` : ''),
          })
      )
    );
  } catch (err) {
    // A model-not-found is a user error, not a host failure: undo the breaker hit.
    if (err?.doNotTrip) breaker.recordSuccess();
    const mapped = classify(err, { host: targetHost, model: targetModel });
    log.warn('AI call failed', { host: targetHost, model: targetModel, code: mapped.code, msg: mapped.message });
    throw mapped;
  }
}

/** List installed models. Never throws — an unreachable host returns an empty list plus the reason. */
async function listModels(host) {
  const targetHost = host || config.ai.defaultHost;
  try {
    const res = await requestJson(`${targetHost}/api/tags`, { timeoutMs: config.ai.probeTimeoutMs });
    if (!res.ok) throw classifyHttpStatus(res, { host: targetHost, model: '(list)' });
    const models = (res.json?.models || [])
      .map(m => m?.name)
      .filter(Boolean)
      .sort();
    breakers.for(targetHost).recordSuccess();
    healthCache.set(targetHost, { online: true, models, checkedAt: Date.now(), error: null });
    return { host: targetHost, online: true, models, error: null };
  } catch (err) {
    const mapped = classify(err, { host: targetHost, model: '(list)' });
    healthCache.set(targetHost, { online: false, models: [], checkedAt: Date.now(), error: mapped.message });
    return { host: targetHost, online: false, models: [], error: mapped.message, hint: mapped.hint, code: mapped.code };
  }
}

/**
 * Cheap health probe with a short TTL cache, so a sidebar polling every few
 * seconds does not turn into a denial of service against the user's own Ollama.
 */
async function health(host, { force = false } = {}) {
  const targetHost = host || config.ai.defaultHost;
  const cached = healthCache.get(targetHost);
  if (!force && cached && Date.now() - cached.checkedAt < HEALTH_TTL_MS) {
    return { host: targetHost, online: cached.online, models: cached.models, error: cached.error, cached: true };
  }
  const result = await listModels(targetHost);
  return { ...result, cached: false };
}

/** Diagnostics for /api/health and the AI status panel. */
function snapshot() {
  return {
    breakers: breakers.snapshot(),
    queues: queues.snapshot(),
    hosts: [...healthCache.entries()].map(([host, v]) => ({
      host, online: v.online, models: v.models.length, checkedAt: v.checkedAt, error: v.error,
    })),
  };
}

/** Build the system + user turn pair used for group and 1v1 chats alike. */
function buildMessages({ chatName, contextMessages, question, isDirect }) {
  const transcript = contextMessages
    .map(m => `${m.sender_username}: ${m.content}`)
    .join('\n');

  const system = isDirect
    ? 'You are SpockAI, a local AI assistant running privately on the user\'s own machine. ' +
      'Be concise, clear and logical. If you are unsure, say so plainly.'
    : `You are SpockAI, an AI assistant embedded in a group chat called "${chatName}". ` +
      'You can see the recent conversation. Answer the question that was asked, referencing the ' +
      'conversation when it is relevant. Be concise.\n\n' +
      `Recent conversation (${contextMessages.length} message${contextMessages.length === 1 ? '' : 's'}):\n` +
      `${transcript || '(no messages yet)'}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: question },
  ];
}

module.exports = { chat, listModels, health, snapshot, buildMessages, breakers, queues };
