const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { config } = require('../config');
const users = require('../db/repositories/users.repo');
const validate = require('../core/validate');
const { unauthorized, Codes, AppError } = require('../core/errors');
const { createLogger } = require('../core/logger');

const log = createLogger('auth');

function signToken(userId) {
  return jwt.sign({ id: userId }, config.auth.jwtSecret, { expiresIn: config.auth.tokenTtl });
}

/**
 * Verify a token and load the user.
 *
 * Distinguishes expired from malformed from "the account no longer exists", so
 * the client can decide whether to re-login silently or show a message — the old
 * code collapsed all three into "Invalid token".
 */
function authenticate(token) {
  if (!token) {
    throw unauthorized('No session token was provided.', { code: Codes.UNAUTHENTICATED });
  }

  let payload;
  try {
    payload = jwt.verify(token, config.auth.jwtSecret);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw unauthorized('Your session has expired.', {
        code: Codes.TOKEN_EXPIRED,
        hint: 'Log in again to continue.',
      });
    }
    throw unauthorized('Your session token is not valid for this server.', {
      code: Codes.TOKEN_INVALID,
      hint: config.auth.jwtSecretIsEphemeral
        ? 'JWT_SECRET is not set in .env, so every server restart invalidates sessions. Set it to keep people logged in.'
        : 'Log in again to get a fresh token.',
    });
  }

  const user = users.findById(payload.id);
  if (!user) {
    throw unauthorized('That account no longer exists on this server.', {
      code: Codes.TOKEN_INVALID,
      hint: 'The database may have been reset. Register again.',
    });
  }
  return user;
}

async function register({ username, password }) {
  const name = validate.username(username);
  const pass = validate.password(password);

  const hash = await bcrypt.hash(pass, config.auth.bcryptRounds);
  const user = users.create(name, hash); // throws USERNAME_TAKEN on conflict
  log.info('user registered', { username: name });

  return { token: signToken(user.id), user: { id: user.id, username: user.username } };
}

async function login({ username, password }) {
  const name = typeof username === 'string' ? username.trim() : '';
  const record = name ? users.findByUsername(name) : null;

  // Always run a bcrypt comparison, even when the user does not exist, so the
  // response time does not reveal which usernames are registered.
  const hash = record?.password_hash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi';
  const ok = await bcrypt.compare(typeof password === 'string' ? password : '', hash);

  if (!record || !ok) {
    throw new AppError(Codes.BAD_CREDENTIALS, 'That username and password do not match.', {
      status: 401,
      hint: 'Accounts are per-machine — if you registered on a friend’s server, log in there instead.',
    });
  }

  return { token: signToken(record.id), user: { id: record.id, username: record.username } };
}

module.exports = { register, login, authenticate, signToken };
