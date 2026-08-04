/**
 * AI integration — the happy path, and every way Ollama can let us down.
 *
 * No test here touches a real Ollama: `startFakeOllama` stands in for it and can
 * be told to be healthy, dead, wrong, empty or missing a model on demand. The
 * default OLLAMA_HOST of every server started below points at a black hole, so a
 * developer who happens to have Ollama running on this machine cannot
 * accidentally make these tests pass (or fail) for the wrong reason.
 *
 * Three historical bugs are guarded explicitly and marked in the tests:
 *   - 1v1 chats silently required "@AI" and therefore never answered at all
 *   - AI failures were emitted over a socket and dropped, leaving no trace: the
 *     user saw a thinking indicator and then nothing, forever
 *   - a dead Ollama cost a full timeout on *every* mention, with no fast fail
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  startServer, startFakeOllama, waitFor, collect, emitWithAck, sleep,
} = require('./helpers/harness');

/**
 * Port 1 has nothing on it. Any code path that forgets to use the fake host will
 * fail loudly instead of quietly talking to the developer's real Ollama.
 */
const NO_REAL_OLLAMA = Object.freeze({
  OLLAMA_HOST: 'http://127.0.0.1:1',
  OLLAMA_MODEL: 'llama3',
});

const BREAKER_STATES = ['closed', 'open', 'half_open'];

const openFakes = [];
const openSockets = [];

async function newFake(options) {
  const fake = await startFakeOllama(options);
  openFakes.push(fake);
  return fake;
}

async function newSocket(server, token) {
  const socket = await server.connectSocket(token);
  openSockets.push(socket);
  return socket;
}

/**
 * Teardown order matters: client sockets first, then the SpockChat process, and
 * only then the fake Ollama — an http server finishes closing only once nothing
 * is still connected to it, and undici keeps connections alive for seconds.
 */
async function teardown(server) {
  for (const socket of openSockets.splice(0)) {
    try { socket.removeAllListeners(); socket.close(); } catch { /* already gone */ }
  }
  await server?.stop();
  await Promise.all(openFakes.splice(0).map(fake => fake.close().catch(() => {})));
}

// ─────────────────────────────────────────────────────────────────────────────

describe('AI over HTTP', () => {
  let server;
  let token;
  let fake;

  before(async () => {
    server = await startServer({ env: { ...NO_REAL_OLLAMA } });
    ({ token } = await server.register('ai_http_user'));
    fake = await newFake({ mode: 'ok' });
  });

  after(async () => { await teardown(server); });

  test('GET /ai/models lists what the host has installed', async () => {
    fake.setMode('ok');

    const res = await server.api('GET', `/ai/models?host=${encodeURIComponent(fake.url)}`, { token });

    assert.equal(res.status, 200);
    assert.equal(res.body.online, true);
    assert.deepEqual(res.body.models, ['llama3', 'phi3']);
    assert.equal(res.body.error, null);
    assert.equal(res.body.host, fake.url);
  });

  test('GET /ai/models on an unreachable host is a state to render, not a crash', async () => {
    // An Ollama that is simply not running is the single most common situation
    // in a local-first app. It must never surface as a 5xx the UI cannot render.
    fake.setMode('down');

    const res = await server.api('GET', `/ai/models?host=${encodeURIComponent(fake.url)}`, { token });

    assert.equal(res.status, 200, 'an unreachable Ollama is a state, not an HTTP error');
    assert.equal(res.body.online, false);
    assert.deepEqual(res.body.models, []);
    assert.equal(res.body.code, 'AI_UNREACHABLE');
    assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0, 'the reason must be renderable');
    assert.ok(res.body.hint, 'the user must be told what to do about it');
  });

  test('GET /ai/status reports online true/false and includes the breaker state', async () => {
    fake.setMode('ok');
    const up = await server.api('GET', `/ai/status?host=${encodeURIComponent(fake.url)}&force=true`, { token });

    assert.equal(up.status, 200);
    assert.equal(up.body.online, true);
    assert.ok(up.body.models.includes('llama3'));
    assert.ok(up.body.breaker, 'the status panel needs the breaker to explain a fast failure');
    assert.ok(BREAKER_STATES.includes(up.body.breaker.state), `unexpected state ${up.body.breaker.state}`);
    assert.equal(up.body.breaker.state, 'closed');

    // `force` bypasses the health cache, so this is a fresh probe of a dead host.
    fake.setMode('down');
    const down = await server.api('GET', `/ai/status?host=${encodeURIComponent(fake.url)}&force=true`, { token });

    assert.equal(down.status, 200);
    assert.equal(down.body.online, false);
    assert.ok(down.body.error, 'offline status must carry the reason');
    assert.ok(BREAKER_STATES.includes(down.body.breaker.state), `unexpected state ${down.body.breaker.state}`);
  });

  test('POST /ai/ask returns the model reply', async () => {
    fake.setMode('ok');
    const before = fake.requestCount();

    const res = await server.api('POST', '/ai/ask', {
      token,
      body: { prompt: 'What is 2 plus 2?', host: fake.url, model: 'llama3' },
    });

    assert.equal(res.status, 200);
    assert.match(res.body.reply, /the answer is 4/i);
    assert.equal(res.body.model, 'llama3');
    assert.ok(Number.isFinite(res.body.durationMs));
    assert.equal(fake.requestCount(), before + 1, 'exactly one generation call');
  });

  test('a model that is not pulled fails with AI_MODEL_MISSING and an "ollama pull" hint', async () => {
    fake.setMode('missing_model');

    const res = await server.api('POST', '/ai/ask', {
      token,
      body: { prompt: 'hello', host: fake.url, model: 'ghost' },
    });

    assert.equal(res.status, 400, 'a missing model is a user error, not a server outage');
    assert.equal(res.body.code, 'AI_MODEL_MISSING');
    assert.match(res.body.hint, /ollama pull ghost/i, 'the hint must be the exact command to run');
  });

  test('a host that answers with a web page fails with AI_BAD_RESPONSE', async () => {
    // Something answered — a proxy, a tunnel login page, the wrong port — but it
    // is not Ollama. That must not be mistaken for a reply.
    fake.setMode('html');

    const res = await server.api('POST', '/ai/ask', {
      token,
      body: { prompt: 'hello', host: fake.url, model: 'llama3' },
    });

    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'AI_BAD_RESPONSE');
    assert.ok(res.body.hint, 'a user-facing failure must carry a hint');
  });

  test('an empty completion fails with AI_BAD_RESPONSE instead of posting an empty reply', async () => {
    fake.setMode('empty');

    const res = await server.api('POST', '/ai/ask', {
      token,
      body: { prompt: 'hello', host: fake.url, model: 'llama3' },
    });

    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'AI_BAD_RESPONSE');
    assert.ok(res.body.hint);
  });

  test('POST /ai/chat/:id on a chat with AI turned off fails with AI_DISABLED', async () => {
    const chat = await server.createChat(token, { name: 'Humans only', type: 'group', aiEnabled: false });

    const res = await server.api('POST', `/ai/chat/${chat.id}`, { token, body: { query: 'are you there?' } });

    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'AI_DISABLED');
    assert.ok(res.body.hint, 'tell the user who can turn it on');
  });

  test('POST /ai/ask refuses hosts that are not plain http(s) addresses', async () => {
    // The SSRF boundary: without it any account could aim the server at
    // link-local metadata, a unix path, or an internal service.
    for (const host of ['not a url', 'file:///etc/passwd']) {
      const res = await server.api('POST', '/ai/ask', { token, body: { prompt: 'hello', host } });

      assert.equal(res.status, 400, `expected ${host} to be rejected`);
      assert.equal(res.body.code, 'INVALID_HOST', `expected INVALID_HOST for ${host}`);
      assert.ok(res.body.hint, `expected a hint for ${host}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('AI replies inside chats', () => {
  let server;
  let fake;

  before(async () => {
    server = await startServer({ env: { ...NO_REAL_OLLAMA } });
    fake = await newFake({ mode: 'ok' });
  });

  after(async () => { await teardown(server); });

  test('a 1v1 AI chat answers a plain message that never mentions @AI', async () => {
    // HISTORICAL BUG: the trigger check required "@AI" in every chat type, so a
    // 1v1 chat — whose entire purpose is talking to the model — never replied.
    fake.setMode('ok');
    const { token } = await server.register('ai_direct_user');
    const chat = await server.createChat(token, {
      name: 'Ask Spock', type: '1v1', aiHost: fake.url, aiModel: 'llama3',
    });
    const socket = await newSocket(server, token);

    const thinking = collect(socket, 'ai:thinking');
    const incoming = collect(socket, 'message:new');

    const ack = await emitWithAck(socket, 'message:send', {
      chatId: chat.id,
      content: 'What is 2 plus 2?',
      clientMsgId: 'ai-1v1-plain-0001',
    });
    assert.equal(ack.ok, true, ack.error);

    await waitFor(() => thinking.length > 0, { label: 'ai:thinking in a 1v1 chat' });
    const reply = await waitFor(() => incoming.find(e => e.message.type === 'ai'), { label: 'a stored AI reply' });

    assert.match(reply.message.content, /the answer is 4/i);
    assert.equal(reply.message.sender_username, 'SpockAI');

    const history = await server.api('GET', `/chats/${chat.id}/messages`, { token });
    assert.equal(history.status, 200);
    assert.ok(
      history.body.messages.some(m => m.type === 'ai'),
      'the reply must live in history, not only on the wire'
    );
  });

  test('a group chat stays quiet until it is tagged with @AI', async () => {
    fake.setMode('ok');
    const { token } = await server.register('ai_group_user');
    const chat = await server.createChat(token, {
      name: 'Bridge crew', type: 'group', aiEnabled: true, aiHost: fake.url, aiModel: 'llama3',
    });
    const socket = await newSocket(server, token);

    const thinking = collect(socket, 'ai:thinking');
    const incoming = collect(socket, 'message:new');
    const callsBefore = fake.requestCount();

    const plain = await emitWithAck(socket, 'message:send', {
      chatId: chat.id,
      content: 'morning everyone',
      clientMsgId: 'ai-group-plain-001',
    });
    assert.equal(plain.ok, true, plain.error);

    // The send is acknowledged, so the server has finished deciding. Give the
    // responder a generous extra window to (wrongly) wake up anyway.
    await sleep(700);
    assert.equal(thinking.length, 0, 'a group chat must not answer an untagged message');
    assert.equal(fake.requestCount(), callsBefore, 'no model should have been contacted');
    assert.ok(!incoming.some(e => e.message.type === 'ai'), 'no AI message should exist yet');

    const tagged = await emitWithAck(socket, 'message:send', {
      chatId: chat.id,
      content: '@AI what is 2 plus 2?',
      clientMsgId: 'ai-group-tagged-01',
    });
    assert.equal(tagged.ok, true, tagged.error);

    await waitFor(() => thinking.length > 0, { label: 'ai:thinking after an @AI mention' });
    const reply = await waitFor(() => incoming.find(e => e.message.type === 'ai'), { label: 'the tagged AI reply' });
    assert.match(reply.message.content, /the answer is 4/i);
    assert.ok(fake.requestCount() > callsBefore, 'the tagged message must reach the model');
  });

  test('an AI failure is announced, ends the spinner, and is stored in the chat', async () => {
    // HISTORICAL BUG: `ai:error` went to the room and was dropped unless the user
    // happened to be looking at that chat, so a failed answer left no trace at
    // all. Every outcome must now be durable and must clear the thinking state.
    fake.setMode('down');
    const { token } = await server.register('ai_failure_user');
    const chat = await server.createChat(token, {
      name: 'Dead model', type: '1v1', aiHost: fake.url, aiModel: 'llama3',
    });
    const socket = await newSocket(server, token);

    const errors = collect(socket, 'ai:error');
    const done = collect(socket, 'ai:done');

    const ack = await emitWithAck(socket, 'message:send', {
      chatId: chat.id,
      content: 'are you there?',
      clientMsgId: 'ai-failure-0000001',
    });
    assert.equal(ack.ok, true, 'the human message itself must still be stored');

    // (a) the failure is reported with a code and a way out
    const failure = await waitFor(() => errors[0], { timeoutMs: 15_000, label: 'ai:error' });
    assert.equal(failure.code, 'AI_UNREACHABLE');
    assert.ok(failure.error, 'the failure must say what broke');
    assert.ok(failure.hint, 'the failure must say what to do about it');

    // (b) the spinner always ends, whatever happened
    await waitFor(() => done.length > 0, { timeoutMs: 10_000, label: 'ai:done' });

    // (c) and the failure outlives the socket event
    const history = await server.api('GET', `/chats/${chat.id}/messages`, { token });
    assert.equal(history.status, 200);
    const notice = history.body.messages.find(m => m.type === 'system');

    assert.ok(notice, 'the failure must be persisted as a system message');
    assert.match(notice.content, /could not answer/i);
    assert.ok(notice.content.includes(failure.error), 'the stored notice must carry the same reason');
    assert.equal(notice.id, failure.messageId, 'the event must point at the stored notice');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('AI circuit breaker', () => {
  let server;
  let token;
  let fake;

  before(async () => {
    server = await startServer({
      env: {
        ...NO_REAL_OLLAMA,
        AI_BREAKER_FAILURES: '2',
        AI_RETRIES: '0',
        AI_BREAKER_RESET_MS: '60000',
      },
    });
    ({ token } = await server.register('ai_breaker_user'));
    fake = await newFake({ mode: 'down' });
  });

  after(async () => { await teardown(server); });

  test('opens after the configured failures, then fails fast without calling Ollama', async () => {
    // HISTORICAL BUG: with Ollama down, every single mention paid the full
    // request timeout before failing. After the threshold the answer must be
    // immediate and must not involve the network at all.
    const ask = () => server.api('POST', '/ai/ask', {
      token,
      body: { prompt: 'ping', host: fake.url, model: 'llama3' },
    });

    const first = await ask();
    assert.equal(first.status, 503);
    assert.equal(first.body.code, 'AI_UNREACHABLE', 'the first failure is a real attempt');

    const second = await ask();
    assert.equal(second.body.code, 'AI_UNREACHABLE', 'the second failure trips the breaker');

    const callsBefore = fake.requestCount();
    assert.equal(callsBefore, 2, 'with AI_RETRIES=0 each attempt is exactly one call');

    const startedAt = Date.now();
    const third = await ask();
    const elapsedMs = Date.now() - startedAt;

    assert.equal(third.status, 503);
    assert.equal(third.body.code, 'AI_CIRCUIT_OPEN');
    assert.ok(third.body.hint, 'an open circuit must tell the user when it will try again');
    assert.ok(elapsedMs < 600, `an open circuit must fail fast, took ${elapsedMs}ms`);
    assert.equal(fake.requestCount(), callsBefore, 'an open circuit must not touch the host at all');
  });
});

describe('AI circuit breaker recovery', () => {
  let server;
  let token;
  let fake;

  before(async () => {
    server = await startServer({
      env: {
        ...NO_REAL_OLLAMA,
        AI_BREAKER_FAILURES: '2',
        AI_RETRIES: '0',
        AI_BREAKER_RESET_MS: '1200',
      },
    });
    ({ token } = await server.register('ai_recovery_user'));
    fake = await newFake({ mode: 'down' });
  });

  after(async () => { await teardown(server); });

  test('closes again once the reset window passes and the host is healthy', async () => {
    // A breaker that never recovers is just an outage with better manners: once
    // "ollama serve" is running again the next question has to work.
    const ask = () => server.api('POST', '/ai/ask', {
      token,
      body: { prompt: 'ping', host: fake.url, model: 'llama3' },
    });

    await ask();
    await ask();
    const tripped = await ask();
    assert.equal(tripped.body.code, 'AI_CIRCUIT_OPEN', 'the breaker should be open before recovery');

    fake.setMode('ok');

    const recovered = await waitFor(
      async () => {
        const res = await ask();
        return res.status === 200 ? res : null;
      },
      { timeoutMs: 12_000, intervalMs: 200, label: 'the breaker to close again' }
    );

    assert.match(recovered.body.reply, /the answer is 4/i);

    // Read the state without probing the host, so this observes the recovery
    // rather than causing it.
    const diagnostics = await server.api('GET', '/ai/diagnostics', { token });
    const breaker = diagnostics.body.breakers.find(b => b.name === `ollama:${fake.url}`);

    assert.ok(breaker, 'the breaker for this host should appear in diagnostics');
    assert.equal(breaker.state, 'closed', 'a successful call must close the breaker again');
  });
});
