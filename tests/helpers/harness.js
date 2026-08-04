/**
 * Integration test harness.
 *
 * Every test runs against a **real** SpockChat process: spawned with its own
 * database file and port, booted through the real entry point, and torn down
 * afterwards. In-process mocking would not exercise migrations, the boot
 * sequence, graceful shutdown or federation between two independent servers —
 * which is exactly where the original bugs lived.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const ENTRY = path.join(ROOT, 'server', 'index.js');
const TMP_ROOT = path.join(os.tmpdir(), 'spockchat-tests');

// Seed the range from the PID so two test files running in separate processes —
// or a dev server the developer happens to have open — cannot collide and make
// the suite flaky for reasons that have nothing to do with the code under test.
let nextPort = 4100 + ((process.pid * 37) % 1200);
const running = new Set();

function allocatePort() {
  return nextPort++;
}

/**
 * Boot a SpockChat server and wait until /api/health/ready reports ready.
 * Retries on a port clash, which is an environment problem rather than a failure
 * worth reporting as a test result.
 * @returns {Promise<TestServer>}
 */
async function startServer(options = {}) {
  const attempts = options.port ? 1 : 4;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await bootServer(options);
    } catch (err) {
      lastError = err;
      // A busy port, or one Windows has reserved (Hyper-V/WSL exclude whole
      // ranges and return EACCES), is an environment problem — take the next one.
      if (!/EADDRINUSE|already in use|EACCES|Permission denied binding|reserved that port/i.test(err.message)) throw err;
    }
  }
  throw lastError;
}

async function bootServer(options = {}) {
  fs.mkdirSync(TMP_ROOT, { recursive: true });

  const port = options.port || allocatePort();
  const dbPath = options.dbPath || path.join(TMP_ROOT, `db-${randomUUID()}.sqlite`);

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DB_PATH: dbPath,
    JWT_SECRET: options.jwtSecret || 'test-secret-that-is-long-enough-for-tests',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL || 'error',
    BCRYPT_ROUNDS: '4',              // keep the suite fast; production default is 12
    FEDERATION_ALLOW_PRIVATE_HOSTS: 'true',
    FEDERATION_OUTBOX_INTERVAL_MS: '1000',
    TUNNEL_AUTO_RESTART: 'false',
    ...options.env,
  };

  const child = spawn(process.execPath, ['--experimental-sqlite', ENTRY], {
    env,
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', d => logs.push(d.toString()));
  child.stderr.on('data', d => logs.push(d.toString()));

  const server = new TestServer({ child, port, dbPath, logs });
  running.add(server);

  await server.waitUntilReady(options.readyTimeoutMs || 20_000);
  return server;
}

class TestServer {
  constructor({ child, port, dbPath, logs }) {
    this.child = child;
    this.port = port;
    this.dbPath = dbPath;
    this.logs = logs;
    this.url = `http://127.0.0.1:${port}`;
    this.stopped = false;
  }

  get output() { return this.logs.join(''); }

  async waitUntilReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'no attempt made';

    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        throw new Error(`Server exited during startup (code ${this.child.exitCode}):\n${this.output}`);
      }
      try {
        const res = await fetch(`${this.url}/api/health/ready`, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) {
          const body = await res.json();
          if (body.ready) return body;
          lastError = JSON.stringify(body);
        } else {
          lastError = `HTTP ${res.status}`;
        }
      } catch (err) {
        lastError = err.message;
      }
      await sleep(120);
    }
    throw new Error(`Server on port ${this.port} never became ready (${lastError})\n${this.output}`);
  }

  /** Raw request — returns status and parsed body without throwing on 4xx/5xx. */
  async request(method, path, { body, token, headers = {}, timeoutMs = 20_000 } = {}) {
    const res = await fetch(`${this.url}${path.startsWith('/') ? path : '/' + path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON is itself a finding */ }
    return { status: res.status, body: json, text, headers: res.headers, contentType: res.headers.get('content-type') || '' };
  }

  api(method, path, opts) { return this.request(method, `/api${path}`, opts); }

  /** Register a user and return { token, user }. */
  async register(username, password = 'test-password-123') {
    const res = await this.api('POST', '/auth/register', { body: { username, password } });
    if (res.status !== 201) throw new Error(`register(${username}) failed: ${res.text}`);
    return res.body;
  }

  async login(username, password = 'test-password-123') {
    const res = await this.api('POST', '/auth/login', { body: { username, password } });
    if (res.status !== 200) throw new Error(`login(${username}) failed: ${res.text}`);
    return res.body;
  }

  async createChat(token, { name = 'Test Chat', type = 'group', aiEnabled = false, aiModel, aiHost } = {}) {
    const res = await this.api('POST', '/chats', { token, body: { name, type, aiEnabled, aiModel, aiHost } });
    if (res.status !== 201) throw new Error(`createChat failed: ${res.text}`);
    return res.body.chat;
  }

  /** Connect a socket.io client, resolving once connected. */
  async connectSocket(token, options = {}) {
    const { io } = require('socket.io-client');
    const socket = io(this.url, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      ...options,
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket connect timed out')), 10_000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('connect_error', err => {
        clearTimeout(timer);
        reject(Object.assign(new Error(`socket connect_error: ${err.message}`), { data: err.data }));
      });
    });

    return socket;
  }

  async stop({ signal = 'SIGTERM', timeoutMs = 8_000 } = {}) {
    if (this.stopped) return;
    this.stopped = true;
    running.delete(this);

    if (this.child.exitCode !== null) return;

    await new Promise(resolve => {
      const timer = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch {} resolve(); }, timeoutMs);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      try { this.child.kill(signal); } catch { clearTimeout(timer); resolve(); }
    });
  }

  /** Hard kill — simulates a crash, with no graceful shutdown. */
  async kill() {
    this.stopped = true;
    running.delete(this);
    if (this.child.exitCode !== null) return;
    await new Promise(resolve => {
      this.child.once('exit', resolve);
      try { this.child.kill('SIGKILL'); } catch { resolve(); }
      setTimeout(resolve, 3_000);
    });
  }
}

/** A fake Ollama, so AI paths can be tested without a real model installed. */
async function startFakeOllama(handler = {}) {
  const http = require('http');
  const state = { requests: [], mode: handler.mode || 'ok', delayMs: handler.delayMs || 0 };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks).toString() : '';
    state.requests.push({ url: req.url, method: req.method, body });

    if (state.delayMs) await sleep(state.delayMs);

    const send = (code, payload, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };

    if (state.mode === 'down') { req.socket.destroy(); return; }
    if (state.mode === 'html')  return send(200, '<!DOCTYPE html><html><body>not ollama</body></html>', 'text/html');
    if (state.mode === 'error') return send(500, { error: 'internal model failure' });
    if (state.mode === 'missing_model') return send(404, { error: `model "ghost" not found, try pulling it first` });
    if (state.mode === 'empty') return send(200, { message: { content: '' } });
    if (state.mode === 'hang') return; // never responds

    if (req.url.startsWith('/api/tags')) {
      return send(200, { models: [{ name: 'llama3' }, { name: 'phi3' }] });
    }
    if (req.url.startsWith('/api/chat')) {
      return send(200, { message: { role: 'assistant', content: 'Fascinating. The answer is 4.' } });
    }
    send(404, { error: 'not found' });
  });

  const port = allocatePort();
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    setMode: mode => { state.mode = mode; },
    setDelay: ms => { state.delayMs = ms; },
    requestCount: () => state.requests.length,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Wait for a condition, polling — avoids brittle fixed sleeps. */
async function waitFor(predicate, { timeoutMs = 8_000, intervalMs = 60, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Collect socket events of a given name for later assertions. */
function collect(socket, event) {
  const received = [];
  socket.on(event, payload => received.push(payload));
  return received;
}

/** Emit with an ack, promisified. */
function emitWithAck(socket, event, payload, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout for ${event}`)), timeoutMs);
    socket.emit(event, payload, response => { clearTimeout(timer); resolve(response); });
  });
}

async function stopAll() {
  await Promise.all([...running].map(s => s.stop()));
}

process.on('exit', () => {
  for (const server of running) { try { server.child.kill('SIGKILL'); } catch {} }
});

module.exports = {
  startServer, startFakeOllama, stopAll,
  sleep, waitFor, collect, emitWithAck, allocatePort,
  TMP_ROOT, ROOT,
};
