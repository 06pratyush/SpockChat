/**
 * Database connection, migrations, health and transaction helpers.
 *
 * Hardening over the original:
 *   - `busy_timeout` so concurrent writers wait instead of throwing SQLITE_BUSY
 *   - WAL auto-checkpointing on an interval so the -wal file cannot grow forever
 *   - a real migration runner (see ./migrations.js)
 *   - `transaction()` helper with rollback, so a half-applied invite acceptance
 *     can no longer leave the DB inconsistent
 *   - a health probe used by /api/health/ready
 *   - clear, actionable failure when node:sqlite is unavailable
 */

const path = require('path');
const fs = require('fs');

const { config } = require('../config');
const { createLogger } = require('../core/logger');
const { onShutdown } = require('../core/lifecycle');
const { AppError, Codes } = require('../core/errors');
const { migrations, LATEST_VERSION } = require('./migrations');

const log = createLogger('db');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  throw new Error(
    'node:sqlite is not available in this Node.js build.\n' +
      `You are running Node ${process.version}. SpockChat needs Node 22.5 or newer.\n` +
      'Install a current Node from https://nodejs.org and try again.'
  );
}

let db = null;
let checkpointTimer = null;
let healthy = false;

function open() {
  if (db) return db;

  const file = config.db.file;
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  try {
    db = new DatabaseSync(file);
  } catch (err) {
    throw new AppError(Codes.DB_UNAVAILABLE, `Could not open the database at ${file}: ${err.message}`, {
      status: 500,
      hint:
        'Another SpockChat process may already have it open, or the folder is read-only. ' +
        'Close other instances, or set DB_PATH in .env to a writable location.',
      cause: err,
    });
  }

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = ${config.db.busyTimeoutMs};
  `);

  runMigrations();
  verifyIntegrity();

  checkpointTimer = setInterval(() => {
    try {
      db.exec('PRAGMA wal_checkpoint(PASSIVE);');
    } catch (err) {
      log.warn('WAL checkpoint failed', { err });
    }
  }, config.db.checkpointIntervalMs);
  checkpointTimer.unref?.();

  healthy = true;
  onShutdown('database', () => close());

  log.info('database ready', { file, schemaVersion: LATEST_VERSION });
  return db;
}

function currentVersion() {
  const row = db.prepare('PRAGMA user_version').get();
  return row?.user_version ?? 0;
}

function runMigrations() {
  const from = currentVersion();
  if (from > LATEST_VERSION) {
    throw new AppError(
      Codes.DB_UNAVAILABLE,
      `The database was written by a newer version of SpockChat (schema v${from}, this build understands v${LATEST_VERSION}).`,
      { status: 500, hint: 'Upgrade SpockChat, or point DB_PATH at a different file.' }
    );
  }
  if (from === LATEST_VERSION) return;

  log.info(`migrating schema v${from} → v${LATEST_VERSION}`);

  for (const migration of migrations) {
    if (migration.version <= from) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
      log.info(`applied migration ${migration.version}: ${migration.name}`);
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* rollback of a failed BEGIN is fine to ignore */ }
      throw new AppError(
        Codes.DB_UNAVAILABLE,
        `Migration ${migration.version} (${migration.name}) failed: ${err.message}`,
        {
          status: 500,
          hint: `Your data was left untouched. Back up ${config.db.file} and report this with the message above.`,
          cause: err,
        }
      );
    }
  }
}

function verifyIntegrity() {
  try {
    const result = db.prepare('PRAGMA quick_check').get();
    const verdict = result?.quick_check;
    if (verdict && verdict !== 'ok') {
      log.error('database integrity check failed', { verdict });
      throw new AppError(Codes.DB_UNAVAILABLE, `The database file appears to be corrupted: ${verdict}`, {
        status: 500,
        hint: `Restore a backup, or move ${config.db.file} aside to start fresh.`,
      });
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    log.warn('integrity check could not run', { err });
  }
}

function getDb() {
  if (!db) open();
  return db;
}

/**
 * Run `fn` inside an IMMEDIATE transaction. Rolls back on any throw.
 * Nested calls reuse the outer transaction (SQLite has no real nesting here, and
 * a savepoint would only complicate the two places that need this).
 */
let txDepth = 0;
function transaction(fn) {
  const handle = getDb();
  if (txDepth > 0) return fn(handle);

  handle.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const result = fn(handle);
    handle.exec('COMMIT');
    return result;
  } catch (err) {
    try { handle.exec('ROLLBACK'); } catch (rollbackErr) {
      log.error('rollback failed', { err: rollbackErr });
    }
    throw err;
  } finally {
    txDepth--;
  }
}

/** node:sqlite returns null-prototype rows; copy them so they behave like objects. */
const plain = row => (row ? Object.assign({}, row) : null);
const plainAll = rows => (rows || []).map(row => Object.assign({}, row));

/** Readiness probe: proves the file is open AND writable. */
function health() {
  try {
    const handle = getDb();
    const started = Date.now();
    handle.prepare('SELECT 1 AS ok').get();
    handle.exec('PRAGMA wal_checkpoint(PASSIVE);');
    return { ok: true, latencyMs: Date.now() - started, schemaVersion: currentVersion(), file: config.db.file };
  } catch (err) {
    healthy = false;
    return { ok: false, error: err.message, file: config.db.file };
  }
}

function close() {
  if (checkpointTimer) clearInterval(checkpointTimer);
  checkpointTimer = null;
  if (!db) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db.close();
    log.info('database closed cleanly');
  } catch (err) {
    log.warn('error while closing the database', { err });
  } finally {
    db = null;
    healthy = false;
  }
}

/** Detect the unique-constraint case without string-matching at every call site. */
function isUniqueViolation(err) {
  return /UNIQUE constraint failed/i.test(err?.message || '');
}

module.exports = {
  open, getDb, close, transaction, health,
  plain, plainAll, isUniqueViolation, currentVersion,
  get isHealthy() { return healthy; },
};
