/**
 * A TCP proxy that deliberately misbehaves.
 *
 * Real packet loss cannot be simulated by "not calling emit". It has to happen
 * *underneath* the application: connections that die mid-frame, connections that
 * are refused outright, and latency that pushes an acknowledgement past its
 * timeout so the client retries something the server already stored. That last
 * case is the one that produces duplicate messages in naive implementations, and
 * it is only reachable with a real lossy transport.
 *
 * Clients connect to the proxy; the proxy forwards to the real server while
 * injecting faults according to its configuration.
 */

const net = require('net');

class ChaosProxy {
  /**
   * @param {object}  opts
   * @param {number}  opts.targetPort     the real server
   * @param {number}  [opts.listenPort]
   * @param {number}  [opts.dropRate]     probability a live connection is severed each tick
   * @param {number}  [opts.refuseRate]   probability a new connection is refused immediately
   * @param {number}  [opts.latencyMs]    artificial delay added to forwarded data
   * @param {number}  [opts.tickMs]       how often live connections are rolled against dropRate
   */
  constructor({ targetPort, listenPort = 0, dropRate = 0, refuseRate = 0, latencyMs = 0, tickMs = 250 }) {
    this.targetPort = targetPort;
    this.listenPort = listenPort;
    this.dropRate = dropRate;
    this.refuseRate = refuseRate;
    this.latencyMs = latencyMs;
    this.tickMs = tickMs;

    this.connections = new Set();
    this.stats = { accepted: 0, refused: 0, dropped: 0, bytesIn: 0, bytesOut: 0 };
    this.blackhole = false; // full outage — everything is refused

    this.server = net.createServer(socket => this.#handle(socket));
    this.ticker = null;
  }

  #handle(clientSocket) {
    if (this.blackhole || Math.random() < this.refuseRate) {
      this.stats.refused++;
      clientSocket.destroy();
      return;
    }

    this.stats.accepted++;
    const upstream = net.connect(this.targetPort, '127.0.0.1');
    const pair = { clientSocket, upstream };
    this.connections.add(pair);

    const teardown = () => {
      this.connections.delete(pair);
      clientSocket.destroy();
      upstream.destroy();
    };

    // Delay is applied through a per-direction promise chain rather than a bare
    // setTimeout per chunk. A naive timer would reorder the stream the moment
    // `latencyMs` changed — and a reordered TCP byte stream is corruption, not
    // latency, which would make every result from this proxy meaningless.
    const forward = (from, to, counter) => {
      let chain = Promise.resolve();
      from.on('data', chunk => {
        this.stats[counter] += chunk.length;
        chain = chain.then(async () => {
          if (this.latencyMs) await new Promise(r => setTimeout(r, this.latencyMs));
          if (!to.destroyed) to.write(chunk);
        });
      });
    };

    forward(clientSocket, upstream, 'bytesIn');
    forward(upstream, clientSocket, 'bytesOut');

    clientSocket.on('error', teardown);
    upstream.on('error', teardown);
    clientSocket.on('close', teardown);
    upstream.on('close', teardown);
  }

  /** Sever a proportion of live connections — the "WiFi glitched" event. */
  severRandom() {
    for (const pair of [...this.connections]) {
      if (Math.random() < this.dropRate) {
        this.stats.dropped++;
        pair.clientSocket.destroy();
        pair.upstream.destroy();
        this.connections.delete(pair);
      }
    }
  }

  /** Cut everything for a while — the "router rebooted" event. */
  async outage(durationMs) {
    this.blackhole = true;
    for (const pair of [...this.connections]) {
      this.stats.dropped++;
      pair.clientSocket.destroy();
      pair.upstream.destroy();
    }
    this.connections.clear();
    await new Promise(resolve => setTimeout(resolve, durationMs));
    this.blackhole = false;
  }

  async start() {
    await new Promise(resolve => this.server.listen(this.listenPort, '127.0.0.1', resolve));
    this.listenPort = this.server.address().port;
    if (this.dropRate > 0) {
      this.ticker = setInterval(() => this.severRandom(), this.tickMs);
      this.ticker.unref?.();
    }
    return this;
  }

  get url() { return `http://127.0.0.1:${this.listenPort}`; }

  async stop() {
    if (this.ticker) clearInterval(this.ticker);
    for (const pair of [...this.connections]) {
      pair.clientSocket.destroy();
      pair.upstream.destroy();
    }
    this.connections.clear();
    await new Promise(resolve => this.server.close(resolve));
  }
}

module.exports = { ChaosProxy };
