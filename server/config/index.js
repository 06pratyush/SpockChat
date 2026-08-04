/**
 * Configuration — single source of truth for every tunable in SpockChat.
 *
 * Rules:
 *  - Everything is read once, at boot, and frozen. No `process.env` reads elsewhere.
 *  - Every value is validated. A bad config fails the process at boot with a clear
 *    message rather than producing a confusing runtime failure hours later.
 *  - Every value has a safe default so `npm start` works with an empty .env.
 */

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');

const APP_VERSION = require('../../package.json').version;

const problems = [];
const warnings = [];

function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    problems.push(`${name} must be an integer (got "${raw}")`);
    return fallback;
  }
  if (value < min || value > max) {
    problems.push(`${name} must be between ${min} and ${max} (got ${value})`);
    return fallback;
  }
  return value;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
  problems.push(`${name} must be true/false (got "${raw}")`);
  return fallback;
}

function str(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

// ─── JWT SECRET ───────────────────────────────────────────────────────────────
// A missing secret is not fatal (this is a local-first app and we do not want to
// block a first run), but tokens must not be forgeable by anyone who read the
// source, so we generate an ephemeral one and warn loudly.
const PLACEHOLDER_SECRETS = new Set([
  'replace-this-with-a-random-secret-string-in-production',
  'spockchat-local-secret-change-in-prod',
  'changeme',
  'secret',
]);

let jwtSecret = str('JWT_SECRET', '');
let jwtSecretIsEphemeral = false;
if (!jwtSecret || PLACEHOLDER_SECRETS.has(jwtSecret)) {
  jwtSecret = crypto.randomBytes(48).toString('hex');
  jwtSecretIsEphemeral = true;
  warnings.push(
    'JWT_SECRET is unset or still the placeholder. A random secret was generated for ' +
      'this process — every restart will log all users out. Set JWT_SECRET in .env to fix.'
  );
} else if (jwtSecret.length < 24) {
  warnings.push(`JWT_SECRET is only ${jwtSecret.length} characters. Use at least 32 for real security.`);
}

const env = str('NODE_ENV', 'development');

const config = Object.freeze({
  app: Object.freeze({
    name: 'SpockChat',
    version: APP_VERSION,
    env,
    isProduction: env === 'production',
    isTest: env === 'test',
  }),

  server: Object.freeze({
    port: int('PORT', 3000, { min: 1, max: 65535 }),
    host: str('HOST', '0.0.0.0'),
    // How long to let in-flight requests finish during shutdown before forcing exit.
    shutdownGraceMs: int('SHUTDOWN_GRACE_MS', 10_000, { min: 100, max: 120_000 }),
    // Rejected bodies larger than this. Prevents a single client exhausting memory.
    jsonBodyLimit: str('JSON_BODY_LIMIT', '256kb'),
    trustProxy: bool('TRUST_PROXY', false),
    corsOrigin: str('CORS_ORIGIN', '*'),
    // Explicit address to advertise to peers, when a proxy or DNS name fronts us.
    publicUrl: str('PUBLIC_URL', '').replace(/\/+$/, ''),
  }),

  auth: Object.freeze({
    jwtSecret,
    jwtSecretIsEphemeral,
    tokenTtl: str('JWT_TTL', '30d'),
    bcryptRounds: int('BCRYPT_ROUNDS', 12, { min: 4, max: 15 }),
    minPasswordLength: int('MIN_PASSWORD_LENGTH', 6, { min: 6, max: 128 }),
  }),

  db: Object.freeze({
    file: str('DB_PATH', path.join(__dirname, '..', '..', 'spockchat.db')),
    // SQLite blocks instead of throwing SQLITE_BUSY for this long under write contention.
    busyTimeoutMs: int('DB_BUSY_TIMEOUT_MS', 5_000, { min: 0, max: 60_000 }),
    // WAL grows without bound unless checkpointed; do it on an interval.
    checkpointIntervalMs: int('DB_CHECKPOINT_INTERVAL_MS', 60_000, { min: 5_000 }),
  }),

  chat: Object.freeze({
    maxGroupMembers: int('MAX_GROUP_MEMBERS', 5, { min: 2, max: 50 }),
    maxMessageLength: int('MAX_MESSAGE_LENGTH', 8_000, { min: 1, max: 100_000 }),
    historyPageSize: int('HISTORY_PAGE_SIZE', 100, { min: 1, max: 1_000 }),
    aiContextMessages: int('AI_CONTEXT_MESSAGES', 40, { min: 1, max: 200 }),
    maxChatNameLength: 64,
  }),

  ai: Object.freeze({
    defaultHost: str('OLLAMA_HOST', 'http://localhost:11434'),
    defaultModel: str('OLLAMA_MODEL', 'llama3'),
    // Local models on cold start can take a while; this is a hard ceiling.
    requestTimeoutMs: int('AI_TIMEOUT_MS', 120_000, { min: 1_000, max: 600_000 }),
    probeTimeoutMs: int('AI_PROBE_TIMEOUT_MS', 4_000, { min: 250, max: 60_000 }),
    // Serialise generations per host — a local GPU cannot usefully run 5 at once.
    maxConcurrentPerHost: int('AI_MAX_CONCURRENT', 1, { min: 1, max: 16 }),
    maxQueueDepth: int('AI_MAX_QUEUE', 8, { min: 1, max: 128 }),
    retries: int('AI_RETRIES', 1, { min: 0, max: 5 }),
    breaker: Object.freeze({
      failureThreshold: int('AI_BREAKER_FAILURES', 4, { min: 1, max: 100 }),
      resetTimeoutMs: int('AI_BREAKER_RESET_MS', 20_000, { min: 1_000 }),
    }),
  }),

  federation: Object.freeze({
    requestTimeoutMs: int('FEDERATION_TIMEOUT_MS', 8_000, { min: 500, max: 60_000 }),
    retries: int('FEDERATION_RETRIES', 2, { min: 0, max: 5 }),
    breaker: Object.freeze({
      failureThreshold: int('FEDERATION_BREAKER_FAILURES', 5, { min: 1, max: 100 }),
      resetTimeoutMs: int('FEDERATION_BREAKER_RESET_MS', 30_000, { min: 1_000 }),
    }),
    // Peers that could not be reached are retried in the background this often.
    outboxIntervalMs: int('FEDERATION_OUTBOX_INTERVAL_MS', 15_000, { min: 1_000 }),
    outboxMaxAttempts: int('FEDERATION_OUTBOX_MAX_ATTEMPTS', 12, { min: 1, max: 100 }),
    // Refuse to call private/loopback addresses from user-supplied hosts in prod.
    allowPrivateHosts: bool('FEDERATION_ALLOW_PRIVATE_HOSTS', true),
  }),

  realtime: Object.freeze({
    pingIntervalMs: int('SOCKET_PING_INTERVAL_MS', 20_000, { min: 1_000 }),
    pingTimeoutMs: int('SOCKET_PING_TIMEOUT_MS', 25_000, { min: 1_000 }),
    // Socket.IO replays missed packets for this long after a transient drop.
    connectionRecoveryMs: int('SOCKET_RECOVERY_MS', 120_000, { min: 0, max: 600_000 }),
    maxHttpBufferSize: int('SOCKET_MAX_BUFFER', 512 * 1024, { min: 1024 }),
  }),

  limits: Object.freeze({
    // requests per window, per IP
    authAttemptsPerMinute: int('RATE_AUTH_PER_MIN', 10, { min: 1, max: 10_000 }),
    apiRequestsPerMinute: int('RATE_API_PER_MIN', 600, { min: 10, max: 100_000 }),
    federationPerMinute: int('RATE_FEDERATION_PER_MIN', 30, { min: 1, max: 10_000 }),
    // per socket
    messagesPerMinute: int('RATE_MESSAGES_PER_MIN', 120, { min: 1, max: 10_000 }),
    aiRequestsPerMinute: int('RATE_AI_PER_MIN', 12, { min: 1, max: 1_000 }),
  }),

  tunnel: Object.freeze({
    provider: str('TUNNEL_HOST', 'localhost.run'),
    user: str('TUNNEL_USER', 'nokey'),
    startTimeoutMs: int('TUNNEL_START_TIMEOUT_MS', 30_000, { min: 1_000 }),
    // Reconnect automatically if the SSH process dies unexpectedly.
    autoRestart: bool('TUNNEL_AUTO_RESTART', true),
    maxRestarts: int('TUNNEL_MAX_RESTARTS', 5, { min: 0, max: 100 }),
  }),

  log: Object.freeze({
    level: str('LOG_LEVEL', env === 'test' ? 'error' : 'info'),
    json: bool('LOG_JSON', false),
  }),
});

function assertValid() {
  if (problems.length) {
    const message =
      'SpockChat cannot start — invalid configuration:\n' +
      problems.map(p => `  • ${p}`).join('\n') +
      '\n\nFix these values in your .env file and start again.';
    throw new Error(message);
  }
}

module.exports = { config, warnings, assertValid, APP_VERSION };
