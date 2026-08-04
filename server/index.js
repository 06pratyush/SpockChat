/**
 * SpockChat entry point.
 *
 * Boot order is deliberate — each step can fail with a clear, actionable message
 * rather than a stack trace, and nothing starts listening until the things it
 * depends on are proven healthy.
 *
 *   1. install crash guards and signal handlers
 *   2. validate configuration          (bad .env → explain and exit)
 *   3. open the database, run migrations (locked/corrupt → explain and exit)
 *   4. build the HTTP app
 *   5. attach the realtime layer
 *   6. start background workers
 *   7. listen                           (port in use → explain and exit)
 */

const http = require('http');

const lifecycle = require('./core/lifecycle');
lifecycle.install();

const { config, warnings, assertValid } = require('./config');
const { createLogger } = require('./core/logger');

const log = createLogger('boot');

function fail(message, hint) {
  process.stderr.write(`\n✖ ${config?.app?.name || 'SpockChat'} could not start\n\n  ${message}\n`);
  if (hint) process.stderr.write(`\n  💡 ${hint}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

async function main() {
  // 1–2. Configuration
  try {
    assertValid();
  } catch (err) {
    fail(err.message);
  }
  for (const warning of warnings) log.warn(warning);

  // 3. Database
  const db = require('./db');
  try {
    db.open();
  } catch (err) {
    fail(err.message, err.hint);
  }

  // 4. HTTP application
  const { createApp } = require('./app');
  const app = createApp();
  const server = http.createServer(app);

  // Slow-loris protection: a client that opens a socket and never finishes its
  // headers used to be able to hold a connection open indefinitely.
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 30_000;

  // 5. Realtime
  const realtime = require('./realtime');
  realtime.attach(server);

  // 6. Background workers
  const federation = require('./services/federation.service');
  federation.startOutboxWorker();

  lifecycle.onShutdown('http-server', () =>
    new Promise(resolve => {
      server.close(() => resolve());
      // Sockets idling in keep-alive would otherwise hold the close open.
      setTimeout(resolve, 4_000).unref?.();
    })
  , { timeoutMs: 5_000 });

  // 7. Listen
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      fail(
        `Port ${config.server.port} is already in use.`,
        'Another SpockChat (or another program) is using it. Close it, or set PORT=3001 in your .env file.'
      );
    }
    if (err.code === 'EACCES') {
      fail(
        `Permission denied binding to port ${config.server.port}.`,
        config.server.port < 1024
          ? 'Ports below 1024 need administrator rights. Use a port above 1024, e.g. PORT=3000.'
          : 'The operating system refused that port. Another program may hold it exclusively, or ' +
            'it may fall inside a reserved range (on Windows, check "netsh interface ipv4 show ' +
            'excludedportrange protocol=tcp"). Pick a different PORT in your .env file.'
      );
    }
    fail(`The HTTP server failed to start: ${err.message}`);
  });

  server.listen(config.server.port, config.server.host, () => {
    printBanner();
  });

  return server;
}

function printBanner() {
  const identity = require('./services/identity.service');
  const info = identity.describe();
  const WIDTH = 52; // interior columns between the box edges

  // Emoji occupy two terminal columns but one JS char, so pad by display width
  // or the right-hand border drifts.
  const displayWidth = text => [...text].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2100 ? 2 : 1), 0);
  const row = text => `║${text}${' '.repeat(Math.max(0, WIDTH - displayWidth(text)))}║`;
  const line = (label, value) => row(`  ${label.padEnd(9)} ${value}`);

  const rows = [
    '╔' + '═'.repeat(WIDTH) + '╗',
    row(`  ${config.app.name} v${config.app.version}`),
    '╠' + '═'.repeat(WIDTH) + '╣',
    line('Local:', `http://localhost:${config.server.port}`),
    line('Network:', info.lanUrl),
    line('Public:', 'click 🌐 in the sidebar'),
    line('Health:', `http://localhost:${config.server.port}/api/health/ready`),
    '╚' + '═'.repeat(WIDTH) + '╝',
  ];
  process.stdout.write('\n' + rows.join('\n') + '\n\n');

  for (const warning of info.warnings) log.warn(warning);
  if (config.auth.jwtSecretIsEphemeral) {
    log.warn('Sessions will not survive a restart until you set JWT_SECRET in .env');
  }
}

if (require.main === module) {
  main().catch(err => {
    // Anything that escapes here is a boot bug, not a user error.
    process.stderr.write(`\n✖ SpockChat crashed during startup:\n${err?.stack || err}\n\n`);
    process.exit(1);
  });
}

module.exports = { main };
