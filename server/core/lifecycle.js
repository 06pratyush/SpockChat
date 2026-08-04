/**
 * Process lifecycle: crash guards + ordered graceful shutdown.
 *
 * Previously an unhandled rejection anywhere (a socket handler, a fetch) killed
 * the process instantly, dropping every connected client and potentially leaving
 * the SQLite WAL uncheckpointed. Now:
 *
 *   - `unhandledRejection` and `uncaughtException` are logged with full context.
 *     Rejections are treated as recoverable (log and continue); uncaught
 *     exceptions leave the process in an unknown state, so we shut down cleanly
 *     and exit non-zero for a supervisor to restart.
 *   - Shutdown hooks run in reverse registration order (last registered, first
 *     torn down), each with its own timeout so one stuck hook cannot hang exit.
 */

const { createLogger } = require('./logger');
const { config } = require('../config');

const log = createLogger('lifecycle');

const hooks = [];
let shuttingDown = false;
let installed = false;

/**
 * @param {string} name
 * @param {() => Promise<void>|void} fn
 * @param {{timeoutMs?:number}} [opts]
 */
function onShutdown(name, fn, opts = {}) {
  hooks.push({ name, fn, timeoutMs: opts.timeoutMs ?? 5_000 });
}

function isShuttingDown() { return shuttingDown; }

async function runHook(hook) {
  const start = Date.now();
  try {
    await Promise.race([
      Promise.resolve().then(hook.fn),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`timed out after ${hook.timeoutMs}ms`)), hook.timeoutMs).unref?.()
      ),
    ]);
    log.debug(`shutdown hook done: ${hook.name}`, { ms: Date.now() - start });
  } catch (err) {
    log.warn(`shutdown hook failed: ${hook.name}`, { err, ms: Date.now() - start });
  }
}

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutting down (${reason})`);

  const deadline = setTimeout(() => {
    log.error('graceful shutdown exceeded its budget — forcing exit');
    process.exit(exitCode || 1);
  }, config.server.shutdownGraceMs);
  deadline.unref?.();

  for (const hook of [...hooks].reverse()) await runHook(hook);

  clearTimeout(deadline);
  log.info('shutdown complete');
  process.exit(exitCode);
}

function install() {
  if (installed) return;
  installed = true;

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    log.error('unhandled promise rejection — this is a bug, but the server will keep running', { err });
  });

  process.on('uncaughtException', (err) => {
    log.error('uncaught exception — process state is unreliable, restarting', { err });
    shutdown('uncaughtException', 1);
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Windows sends SIGHUP on console close.
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning') return; // node:sqlite is expected
    log.warn(`node warning: ${warning.name}`, { message: warning.message });
  });
}

module.exports = { install, onShutdown, shutdown, isShuttingDown };
