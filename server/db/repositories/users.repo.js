const { randomUUID } = require('crypto');
const { getDb, plain, isUniqueViolation } = require('../index');
const { conflict, Codes } = require('../../core/errors');

function create(username, passwordHash) {
  const id = randomUUID();
  try {
    getDb()
      .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
      .run(id, username, passwordHash);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict(`The username "${username}" is already registered on this machine.`, {
        code: Codes.USERNAME_TAKEN,
        hint: 'Pick a different name, or log in if this account is yours.',
      });
    }
    throw err;
  }
  return { id, username };
}

function findByUsername(username) {
  return plain(getDb().prepare('SELECT * FROM users WHERE username = ?').get(username));
}

/** Case-insensitive lookup — used by federation so "Alice" finds "alice". */
function findByUsernameLoose(username) {
  return plain(
    getDb().prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username)
  );
}

function findById(id) {
  return plain(getDb().prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(id));
}

function count() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM users').get()?.n ?? 0;
}

module.exports = { create, findByUsername, findByUsernameLoose, findById, count };
