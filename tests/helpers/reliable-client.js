/**
 * A headless implementation of the browser client's delivery algorithm.
 *
 * It is deliberately the *same* algorithm as the outbox in client/index.html:
 * persist before sending, send with an acknowledgement deadline, retry with
 * jittered backoff, fall back to HTTP when the socket is down, and rely on the
 * server's `clientMsgId` deduplication to make retries safe.
 *
 * Keeping a testable copy here means the packet-loss guarantees can be asserted
 * in CI without a browser.
 */

const { randomBytes } = require('crypto');

class ReliableClient {
  constructor({ url, token, ackTimeoutMs = 2500, maxAttempts = 25 }) {
    this.url = url;
    this.token = token;
    this.ackTimeoutMs = ackTimeoutMs;
    this.maxAttempts = maxAttempts;

    this.socket = null;
    this.outbox = [];
    this.acked = new Map();     // clientMsgId → stored message
    this.received = new Map();  // messageId → message (duplicate detection)
    this.cursors = {};
    this.stats = { socketSends: 0, httpSends: 0, ackTimeouts: 0, retries: 0, duplicateAcks: 0 };
  }

  connect() {
    const { io } = require('socket.io-client');
    this.socket = io(this.url, {
      auth: { token: this.token },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 100,
      reconnectionDelayMax: 800,
      timeout: 3000,
      forceNew: true,
    });

    this.socket.on('message:new', ({ message }) => {
      this.received.set(message.id, message);
      if (!this.cursors[message.chat_id] || message.seq > this.cursors[message.chat_id]) {
        this.cursors[message.chat_id] = message.seq;
      }
    });

    this.socket.on('connect', () => this.sync());

    return new Promise(resolve => {
      const timer = setTimeout(resolve, 6000);
      this.socket.once('connect', () => { clearTimeout(timer); resolve(); });
    });
  }

  /** Reconnect backfill — ask for everything after the cursors we hold. */
  sync() {
    if (!this.socket?.connected) return;
    this.socket.timeout(4000).emit('chats:sync', { cursors: this.cursors }, (err, res) => {
      if (err || !res?.ok) return;
      for (const [chatId, info] of Object.entries(res.chats || {})) {
        for (const message of info.missed || []) this.received.set(message.id, message);
        this.cursors[chatId] = Math.max(this.cursors[chatId] || 0, info.latestSeq || 0);
      }
    });
  }

  enqueue(chatId, content) {
    const entry = {
      clientMsgId: randomBytes(12).toString('hex'),
      chatId,
      content,
      attempts: 0,
      done: false,
      fatal: false,
    };
    this.outbox.push(entry);
    return entry;
  }

  /** Drive the outbox until it is empty or every entry has given up. */
  async drain({ timeoutMs = 60_000 } = {}) {
    const deadline = Date.now() + timeoutMs;

    while (this.outbox.some(e => !e.done && !e.fatal)) {
      if (Date.now() > deadline) {
        const stuck = this.outbox.filter(e => !e.done && !e.fatal).length;
        throw new Error(`drain timed out with ${stuck} message(s) undelivered`);
      }

      for (const entry of this.outbox) {
        if (entry.done || entry.fatal) continue;
        if (entry.attempts >= this.maxAttempts) {
          entry.fatal = true;
          continue;
        }
        entry.attempts++;
        if (entry.attempts > 1) this.stats.retries++;

        try {
          const result = this.socket?.connected
            ? await this.#sendOverSocket(entry)
            : await this.#sendOverHttp(entry);

          entry.done = true;
          if (result.duplicate) this.stats.duplicateAcks++;
          this.acked.set(entry.clientMsgId, result.message);
          this.received.set(result.message.id, result.message);
        } catch (err) {
          if (err.fatal) { entry.fatal = true; entry.error = err.message; continue; }
          const backoff = Math.min(1200, 80 * 2 ** Math.min(entry.attempts, 4));
          await sleep(backoff * (0.5 + Math.random() * 0.5));
        }
      }
    }

    return this.outbox.filter(e => e.fatal);
  }

  #sendOverSocket(entry) {
    this.stats.socketSends++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.stats.ackTimeouts++;
        reject(new Error('ack timeout'));
      }, this.ackTimeoutMs);

      try {
        this.socket.emit(
          'message:send',
          { chatId: entry.chatId, content: entry.content, clientMsgId: entry.clientMsgId },
          response => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (!response?.ok) {
              const err = new Error(response?.error || 'rejected');
              err.fatal = response?.retryable === false;
              reject(err);
              return;
            }
            resolve(response);
          }
        );
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async #sendOverHttp(entry) {
    this.stats.httpSends++;
    const res = await fetch(`${this.url}/api/chats/${entry.chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ content: entry.content, clientMsgId: entry.clientMsgId }),
      signal: AbortSignal.timeout(this.ackTimeoutMs),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || `HTTP ${res.status}`);
      err.fatal = res.status >= 400 && res.status < 500 && res.status !== 429;
      throw err;
    }
    return { ok: true, message: body.message, duplicate: body.duplicate };
  }

  close() {
    this.socket?.removeAllListeners();
    this.socket?.close();
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = { ReliableClient };
