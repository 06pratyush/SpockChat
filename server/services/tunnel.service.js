/**
 * Cross-network tunnel over the system SSH client.
 *
 * Fixes over the original implementation:
 *   - the old fallback chain `.then(resolve).catch(...).then(resolve).catch(reject)`
 *     could leave a *second* SSH process running and overwrite `tunnelProcess`
 *     with a losing attempt; attempts are now sequential and cleaned up
 *   - a tunnel that died silently left `/status` reporting stale success and the
 *     UI claiming "PUBLIC — ACTIVE" with a dead URL; the process is now watched
 *     and **auto-restarts** with backoff, emitting state changes to clients
 *   - stderr from SSH was thrown away, so "permission denied" or "port already
 *     forwarded" surfaced as a generic timeout; the last lines are now captured
 *     and included in the failure message
 *   - the tunnel URL is registered with the identity service, so friend requests
 *     sent while a tunnel is open advertise the *public* address
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const { config } = require('../config');
const { createLogger } = require('../core/logger');
const { onShutdown } = require('../core/lifecycle');
const { AppError, Codes, unavailable } = require('../core/errors');
const identity = require('./identity.service');

const log = createLogger('tunnel');

const state = {
  status: 'stopped', // stopped | starting | active | restarting | failed
  url: null,
  child: null,
  sshPort: null,
  restarts: 0,
  startedAt: null,
  lastError: null,
  intentionalStop: false,
};

const events = new EventEmitter();

// localhost.run announces the hostname on stdout; other providers use stderr.
const URL_PATTERN = /(?:https?:\/\/)?([a-z0-9][a-z0-9-]*\.(?:lhr\.life|localhost\.run))/i;

function snapshot() {
  return {
    status: state.status,
    active: state.status === 'active',
    url: state.url,
    sshPort: state.sshPort,
    restarts: state.restarts,
    uptimeMs: state.startedAt ? Date.now() - state.startedAt : 0,
    lastError: state.lastError,
  };
}

function attempt(localPort, sshPort) {
  return new Promise((resolve, reject) => {
    const args = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ConnectTimeout=15',
      '-o', 'ExitOnForwardFailure=yes',
      '-p', String(sshPort),
      '-R', `80:localhost:${localPort}`,
      `${config.tunnel.user}@${config.tunnel.provider}`,
    ];

    log.info('opening SSH tunnel', { localPort, sshPort, provider: config.tunnel.provider });

    let child;
    try {
      child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(sshMissingError(err));
      return;
    }

    let settled = false;
    const output = [];

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(
        reject,
        new AppError(Codes.TUNNEL_TIMEOUT, `No tunnel URL from ${config.tunnel.provider} on port ${sshPort} within ${Math.round(config.tunnel.startTimeoutMs / 1000)}s.`, {
          status: 504,
          retryable: true,
          hint: lastLines(output) || 'Check your internet connection. Some networks block outbound SSH entirely.',
        })
      );
    }, config.tunnel.startTimeoutMs);
    timer.unref?.();

    const scan = data => {
      const text = data.toString();
      output.push(text);
      if (output.length > 40) output.shift();

      const match = text.match(URL_PATTERN);
      if (match) {
        const url = `https://${match[1]}`;
        finish(resolve, { url, child, sshPort });
      }
    };

    child.stdout.on('data', scan);
    child.stderr.on('data', scan);

    child.on('error', err => {
      finish(reject, err.code === 'ENOENT' ? sshMissingError(err) : err);
    });

    child.on('exit', code => {
      finish(
        reject,
        new AppError(Codes.TUNNEL_FAILED, `SSH exited with code ${code} while opening the tunnel on port ${sshPort}.`, {
          status: 502,
          retryable: true,
          hint: lastLines(output) || 'The tunnel provider may be down, or this network blocks outbound SSH.',
        })
      );
    });
  });
}

function lastLines(chunks) {
  const text = chunks.join('').split('\n').map(l => l.trim()).filter(Boolean);
  const meaningful = text.filter(l => !/^\s*$/.test(l)).slice(-3);
  return meaningful.length ? `SSH said: ${meaningful.join(' | ')}` : null;
}

function sshMissingError(cause) {
  return new AppError(Codes.TUNNEL_SSH_MISSING, 'The SSH client is not installed on this machine.', {
    status: 501,
    hint:
      'Windows: Settings → Apps → Optional Features → Add → OpenSSH Client, then restart SpockChat. ' +
      'macOS and Linux already have it. Verify with "ssh -V" in a terminal.',
    cause,
  });
}

/** Watch a live tunnel; restart it automatically if it dies unexpectedly. */
function supervise(child) {
  child.on('exit', code => {
    if (state.child !== child) return; // superseded by a newer attempt

    state.child = null;
    const wasActive = state.status === 'active';
    identity.setTunnelUrl(null);

    if (state.intentionalStop) {
      state.status = 'stopped';
      state.url = null;
      events.emit('change', snapshot());
      return;
    }

    state.lastError = `The tunnel closed unexpectedly (SSH exit code ${code}).`;
    log.warn('tunnel dropped', { code, restarts: state.restarts });

    if (wasActive && config.tunnel.autoRestart && state.restarts < config.tunnel.maxRestarts) {
      state.restarts++;
      state.status = 'restarting';
      state.url = null;
      events.emit('change', { ...snapshot(), message: 'Tunnel dropped — reconnecting…' });

      const delay = Math.min(30_000, 2_000 * 2 ** (state.restarts - 1));
      const timer = setTimeout(() => {
        start()
          .then(result => {
            log.info('tunnel restored with a new URL', { url: result.url });
            events.emit('change', { ...snapshot(), message: 'Tunnel restored. The public URL has changed — share the new one.' });
          })
          .catch(err => {
            state.status = 'failed';
            state.lastError = err.message;
            events.emit('change', { ...snapshot(), message: 'Tunnel could not be restored.' });
          });
      }, delay);
      timer.unref?.();
      return;
    }

    state.status = 'failed';
    state.url = null;
    events.emit('change', {
      ...snapshot(),
      message:
        state.restarts >= config.tunnel.maxRestarts
          ? 'Tunnel gave up after repeated drops. Click the globe icon to try again.'
          : 'Tunnel closed.',
    });
  });
}

/**
 * Open a tunnel. Tries the standard SSH port first, then 443 — many corporate
 * and campus networks block 22 outbound but leave 443 open.
 */
async function start() {
  if (state.status === 'active' && state.url && state.child) {
    return { ...snapshot(), reused: true };
  }
  if (state.status === 'starting') {
    throw unavailable('A tunnel is already being opened.', {
      code: Codes.TUNNEL_FAILED,
      hint: 'Give it a few more seconds.',
    });
  }

  state.status = 'starting';
  state.intentionalStop = false;
  state.lastError = null;
  events.emit('change', snapshot());

  const ports = [22, 443];
  let lastError = null;

  for (const sshPort of ports) {
    try {
      const result = await attempt(config.server.port, sshPort);
      state.child = result.child;
      state.url = result.url;
      state.sshPort = result.sshPort;
      state.status = 'active';
      state.startedAt = Date.now();
      state.lastError = null;
      identity.setTunnelUrl(result.url);
      supervise(result.child);
      log.info('tunnel active', { url: result.url, sshPort });
      events.emit('change', snapshot());
      return snapshot();
    } catch (err) {
      lastError = err;
      // No SSH binary means the second port will fail identically.
      if (err instanceof AppError && err.code === Codes.TUNNEL_SSH_MISSING) break;
      if (sshPort !== ports[ports.length - 1]) {
        log.warn(`tunnel on port ${sshPort} failed, trying 443`, { reason: err.message });
      }
    }
  }

  state.status = 'failed';
  state.url = null;
  state.lastError = lastError?.message || 'Unknown tunnel failure';
  identity.setTunnelUrl(null);
  events.emit('change', snapshot());

  throw lastError instanceof AppError
    ? lastError
    : new AppError(Codes.TUNNEL_FAILED, state.lastError, {
        status: 502,
        retryable: true,
        hint: 'Check your internet connection, then try again.',
      });
}

function stop() {
  state.intentionalStop = true;
  state.restarts = 0;
  const had = !!state.child;

  if (state.child) {
    try { state.child.kill(); } catch (err) { log.warn('could not kill the SSH process', { err }); }
    state.child = null;
  }

  state.status = 'stopped';
  state.url = null;
  state.startedAt = null;
  identity.setTunnelUrl(null);
  events.emit('change', snapshot());

  if (had) log.info('tunnel stopped');
  return snapshot();
}

onShutdown('tunnel', () => stop());

module.exports = { start, stop, snapshot, events };
