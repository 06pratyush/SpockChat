/**
 * Express application assembly.
 *
 * Kept separate from `index.js` so tests can build an app (and a real HTTP
 * server on an ephemeral port) without the console banner, signal handlers or
 * background workers of a production boot.
 *
 * Middleware order matters and is deliberate:
 *   1. request context   — every later log line and error carries a request id
 *   2. shutdown guard    — reject new work while draining
 *   3. cors / body       — with a size limit, unlike the original
 *   4. static + API      — API first so a file named like a route cannot shadow it
 *   5. api 404 (JSON)    — before the SPA fallback, so /api/* never returns HTML
 *   6. SPA fallback      — HTML for everything else
 *   7. error handler     — last, catches everything above
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

const { config } = require('./config');
const { requestContext, rejectWhenShuttingDown } = require('./api/middleware/context');
const { rateLimit } = require('./api/middleware/rate-limit');
const { apiNotFound, errorHandler } = require('./api/middleware/error-handler');

const CLIENT_DIR = path.join(__dirname, '..', 'client');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  if (config.server.trustProxy) app.set('trust proxy', true);

  app.use(requestContext);
  app.use(rejectWhenShuttingDown);
  app.use(cors({ origin: config.server.corsOrigin, exposedHeaders: ['X-Request-Id', 'Retry-After'] }));
  app.use(express.json({ limit: config.server.jsonBodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: config.server.jsonBodyLimit }));

  // A blanket ceiling so no single client can monopolise the server, generous
  // enough that normal use never notices it.
  app.use('/api', rateLimit('api'));

  // ── API ─────────────────────────────────────────────────────────────────────
  app.use('/api/health', require('./api/routes/health.routes'));
  app.use('/api/auth', require('./api/routes/auth.routes'));
  app.use('/api/chats', require('./api/routes/chats.routes'));
  app.use('/api/friends', require('./api/routes/friends.routes'));
  app.use('/api/ai', require('./api/routes/ai.routes'));
  app.use('/api/tunnel', require('./api/routes/tunnel.routes'));

  // Federation gets its own mount — the original nested it inside the friends
  // router, which put the real paths at /api/federation/federation/... and broke
  // every cross-machine feature in the app.
  app.use('/api/federation', require('./api/routes/federation.routes'));

  // Kept at the documented top-level path for compatibility with the old client.
  app.get('/api/info', ...require('./api/routes/health.routes').infoHandler);

  // ── STATIC + SPA ────────────────────────────────────────────────────────────
  app.use(express.static(CLIENT_DIR, { maxAge: config.app.isProduction ? '1h' : 0, index: false }));

  app.use(apiNotFound); // JSON 404 for /api/*, before the HTML fallback

  app.get('*', (req, res) => {
    res.sendFile(path.join(CLIENT_DIR, 'index.html'), err => {
      if (err) res.status(500).type('text/plain').send('SpockChat client files are missing from the client/ folder.');
    });
  });

  app.use(errorHandler);

  return app;
}

module.exports = { createApp, CLIENT_DIR };
