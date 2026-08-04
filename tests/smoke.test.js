/**
 * Smoke tests — the harness itself, plus the boot-level guarantees.
 * If this file fails, nothing else in the suite is meaningful.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/harness');

describe('boot and health', () => {
  let server;

  before(async () => { server = await startServer(); });
  after(async () => { await server?.stop(); });

  test('liveness endpoint answers', async () => {
    const res = await server.api('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.app, 'SpockChat');
    assert.equal(res.body.status, 'ok');
  });

  test('readiness proves the database is usable', async () => {
    const res = await server.api('GET', '/health/ready');
    assert.equal(res.status, 200);
    assert.equal(res.body.ready, true);
    assert.equal(res.body.checks.database.ok, true);
    assert.ok(res.body.checks.database.schemaVersion >= 5, 'migrations should have run');
  });

  test('server info advertises a reachable address', async () => {
    const res = await server.api('GET', '/info');
    assert.equal(res.status, 200);
    assert.ok(res.body.reachableUrl.startsWith('http'));
    assert.ok(Array.isArray(res.body.interfaces));
  });

  test('unknown API routes return JSON 404, not the HTML app shell', async () => {
    const res = await server.api('GET', '/definitely-not-a-route');
    assert.equal(res.status, 404);
    assert.match(res.contentType, /json/);
    assert.equal(res.body.code, 'NOT_FOUND');
  });

  test('a non-API path still serves the client', async () => {
    const res = await server.request('GET', '/some/spa/route');
    assert.equal(res.status, 200);
    assert.match(res.contentType, /html/);
  });

  test('malformed JSON produces a clean error, not an HTML stack trace', async () => {
    const res = await server.api('POST', '/auth/login', { body: '{"username":' });
    assert.equal(res.status, 400);
    assert.match(res.contentType, /json/);
    assert.equal(res.body.code, 'MALFORMED_JSON');
    assert.ok(res.body.hint, 'errors should carry a hint');
    assert.doesNotMatch(res.text, /SyntaxError|at JSON\.parse/, 'must not leak internals');
  });

  test('every error response carries a request id for correlation', async () => {
    const res = await server.api('GET', '/chats');
    assert.equal(res.status, 401);
    assert.ok(res.body.requestId, 'requestId missing');
    assert.ok(res.headers.get('x-request-id'));
  });

  test('oversized bodies are rejected instead of buffered', async () => {
    const huge = JSON.stringify({ username: 'x'.repeat(600 * 1024), password: 'y' });
    const res = await server.api('POST', '/auth/register', { body: huge });
    assert.ok(res.status === 413 || res.status === 400, `expected rejection, got ${res.status}`);
  });
});

describe('graceful shutdown', () => {
  test('shutdown runs every teardown hook and closes the database cleanly', async () => {
    const { spawn } = require('node:child_process');
    const path = require('node:path');
    const os = require('node:os');
    const { randomUUID } = require('node:crypto');
    const { allocatePort, TMP_ROOT } = require('./helpers/harness');
    require('node:fs').mkdirSync(TMP_ROOT, { recursive: true });

    const child = spawn(
      process.execPath,
      ['--experimental-sqlite', path.join(__dirname, 'helpers', 'shutdown-probe.js')],
      {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          LOG_LEVEL: 'info',
          PORT: String(allocatePort()),
          DB_PATH: path.join(TMP_ROOT, `shutdown-${randomUUID()}.sqlite`),
          JWT_SECRET: 'test-secret-that-is-long-enough-for-tests',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });

    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`shutdown never completed:\n${output}`)); }, 20_000);
      child.on('exit', c => { clearTimeout(timer); resolve(c); });
    });

    assert.equal(code, 0, `expected a clean exit, got ${code}\n${output}`);
    assert.match(output, /shutting down \(test-probe\)/);
    assert.match(output, /database closed cleanly/);
    assert.match(output, /shutdown complete/);
    assert.doesNotMatch(output, /forcing exit/, 'no hook should have hung');
  });

  test('data survives a restart on the same database file', async () => {
    const first = await startServer();
    const { token } = await first.register('persist_user');
    const chat = await first.createChat(token, { name: 'Durable' });
    await first.api('POST', `/chats/${chat.id}/messages`, {
      token,
      body: { content: 'written before the restart', clientMsgId: 'persist-check-0001' },
    });
    await first.stop();

    const second = await startServer({ dbPath: first.dbPath, port: first.port });
    const { token: token2 } = await second.login('persist_user');
    const history = await second.api('GET', `/chats/${chat.id}/messages`, { token: token2 });

    assert.equal(history.status, 200);
    assert.equal(history.body.messages.at(-1).content, 'written before the restart');
    await second.stop();
  });
});
