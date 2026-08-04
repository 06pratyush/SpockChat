/**
 * Health and diagnostics.
 *
 *   GET /api/health        liveness — is the process answering at all
 *   GET /api/health/ready  readiness — is every dependency actually usable
 *   GET /api/health/deep   full diagnostics, including Ollama (auth required)
 *   GET /api/info          the address other machines should use to reach you
 *
 * `/ready` is what you point a supervisor, a load balancer or a friend's
 * "is your server up?" question at: it fails when the database is unwritable,
 * which liveness alone would happily hide.
 */

const express = require('express');

const { config } = require('../../config');
const db = require('../../db');
const aiService = require('../../services/ai.service');
const federation = require('../../services/federation.service');
const tunnel = require('../../services/tunnel.service');
const identity = require('../../services/identity.service');
const rateLimit = require('../middleware/rate-limit');
const realtime = require('../../realtime/registry');
const { optionalAuth, requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/context');
const { isShuttingDown } = require('../../core/lifecycle');

const router = express.Router();
const startedAt = Date.now();

function baseStatus() {
  return {
    app: config.app.name,
    version: config.app.version,
    status: isShuttingDown() ? 'shutting_down' : 'ok',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  };
}

router.get('/', (req, res) => {
  res.status(isShuttingDown() ? 503 : 200).json(baseStatus());
});

router.get('/ready', (req, res) => {
  const database = db.health();
  const ready = database.ok && !isShuttingDown();

  res.status(ready ? 200 : 503).json({
    ...baseStatus(),
    ready,
    checks: {
      database: database.ok
        ? { ok: true, latencyMs: database.latencyMs, schemaVersion: database.schemaVersion }
        : { ok: false, error: database.error, hint: 'The database file may be locked by another SpockChat process, or the disk is full.' },
      realtime: { ok: true, connections: realtime.connectionCount(), users: realtime.onlineUsernames().length },
    },
  });
});

router.get('/deep', requireAuth, asyncHandler(async (req, res) => {
  const database = db.health();
  const ai = await aiService.health(req.query.host);

  res.json({
    ...baseStatus(),
    config: {
      port: config.server.port,
      maxGroupMembers: config.chat.maxGroupMembers,
      maxMessageLength: config.chat.maxMessageLength,
      aiContextMessages: config.chat.aiContextMessages,
      jwtSecretIsEphemeral: config.auth.jwtSecretIsEphemeral,
    },
    database,
    ai: { reachable: ai.online, host: ai.host, models: ai.models, error: ai.error, ...aiService.snapshot() },
    federation: federation.snapshot(),
    tunnel: tunnel.snapshot(),
    realtime: realtime.snapshot(),
    rateLimiters: rateLimit.snapshot(),
    process: {
      node: process.version,
      pid: process.pid,
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      platform: process.platform,
    },
  });
}));

/** Public server info — how to reach this machine, and any local networking warnings. */
function infoHandler(req, res) {
  res.json({ ...baseStatus(), ...identity.describe(req) });
}

router.get('/info', optionalAuth, infoHandler);

module.exports = router;
module.exports.infoHandler = [optionalAuth, infoHandler];
