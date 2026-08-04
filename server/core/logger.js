/**
 * Minimal structured logger — no dependency, level-filtered, correlation-aware.
 *
 * Every log line carries a `scope` so failures can be traced to a subsystem, and
 * optionally a `reqId` so a single request can be followed across layers.
 */

const { config } = require('../config');

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const threshold = LEVELS[config.log.level] ?? LEVELS.info;

const COLOR = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[36m',
  debug: '\x1b[90m',
  reset: '\x1b[0m',
  dim: '\x1b[90m',
};

const useColor = !config.log.json && process.stdout.isTTY;

function serialize(value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: value.code, stack: value.stack };
  }
  return value;
}

function emit(level, scope, message, meta) {
  if (LEVELS[level] > threshold) return;

  const record = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: message,
    ...(meta ? { ...meta } : {}),
  };
  if (meta && meta.err) record.err = serialize(meta.err);

  if (config.log.json) {
    process.stdout.write(JSON.stringify(record) + '\n');
    return;
  }

  const time = record.ts.slice(11, 23);
  const tag = level.toUpperCase().padEnd(5);
  const head = useColor
    ? `${COLOR.dim}${time}${COLOR.reset} ${COLOR[level]}${tag}${COLOR.reset} ${COLOR.dim}[${scope}]${COLOR.reset}`
    : `${time} ${tag} [${scope}]`;

  const extras = { ...record };
  delete extras.ts; delete extras.level; delete extras.scope; delete extras.msg;
  const err = extras.err;
  delete extras.err;

  const tail = Object.keys(extras).length ? ` ${COLOR.dim}${JSON.stringify(extras)}${useColor ? COLOR.reset : ''}` : '';
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${head} ${message}${tail}\n`);
  if (err && err.stack && threshold >= LEVELS.debug) stream.write(`${err.stack}\n`);
}

function createLogger(scope) {
  return {
    error: (msg, meta) => emit('error', scope, msg, meta),
    warn: (msg, meta) => emit('warn', scope, msg, meta),
    info: (msg, meta) => emit('info', scope, msg, meta),
    debug: (msg, meta) => emit('debug', scope, msg, meta),
    child: sub => createLogger(`${scope}:${sub}`),
  };
}

module.exports = { createLogger, LEVELS };
