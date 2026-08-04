/**
 * Input validation.
 *
 * Every value that crosses the process boundary — HTTP body, query string,
 * socket event payload — goes through here. Failures throw an AppError with a
 * VALIDATION_FAILED code and a message naming the offending field, so the UI can
 * show something better than "Request failed".
 */

const { badRequest, Codes } = require('./errors');
const { config } = require('../config');

const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;

function requireFields(body, fields) {
  const missing = fields.filter(f => body?.[f] === undefined || body?.[f] === null || body?.[f] === '');
  if (missing.length) {
    throw badRequest(`Missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`, {
      details: { missing },
      hint: 'Fill in every field and try again.',
    });
  }
}

function string(value, field, { min = 0, max = 10_000, trim = true } = {}) {
  if (typeof value !== 'string') throw badRequest(`"${field}" must be text.`);
  const out = trim ? value.trim() : value;
  if (out.length < min) throw badRequest(`"${field}" must be at least ${min} character${min === 1 ? '' : 's'}.`);
  if (out.length > max) throw badRequest(`"${field}" must be at most ${max} characters (got ${out.length}).`);
  return out;
}

function username(value, field = 'username') {
  const out = string(value, field, { min: 3, max: 24 });
  if (!USERNAME_RE.test(out)) {
    throw badRequest('Usernames may contain only letters, numbers and underscores, and must be 3–24 characters.', {
      hint: 'Try something like "spock_42".',
    });
  }
  return out;
}

function password(value, field = 'password') {
  if (typeof value !== 'string') throw badRequest(`"${field}" must be text.`);
  if (value.length < config.auth.minPasswordLength) {
    throw badRequest(`Password must be at least ${config.auth.minPasswordLength} characters.`);
  }
  if (value.length > 200) throw badRequest('Password must be at most 200 characters.');
  return value;
}

function oneOf(value, field, allowed) {
  if (!allowed.includes(value)) {
    throw badRequest(`"${field}" must be one of: ${allowed.join(', ')}.`, { details: { allowed } });
  }
  return value;
}

function integer(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = undefined } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw badRequest(`"${field}" is required.`);
  }
  const out = Number.parseInt(value, 10);
  if (!Number.isFinite(out)) throw badRequest(`"${field}" must be a whole number.`);
  if (out < min || out > max) throw badRequest(`"${field}" must be between ${min} and ${max}.`);
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value, field = 'id') {
  const out = string(value, field, { min: 1, max: 64 });
  if (!UUID_RE.test(out)) throw badRequest(`"${field}" is not a valid identifier.`);
  return out;
}

/**
 * Validate and normalise a peer/Ollama host URL supplied by a user.
 *
 * This is the SSRF boundary: without it, anyone with an account could point
 * `aiHost` at `http://169.254.169.254/` or an internal service and use the
 * server as a proxy. We restrict to http/https, forbid credentials and
 * non-standard ports below 1024, and optionally block private ranges.
 */
function hostUrl(value, field = 'host', { allowPrivate = config.federation.allowPrivateHosts } = {}) {
  let raw = string(value, field, { min: 4, max: 300 });
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  raw = raw.replace(/\/+$/, '');

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest(`"${field}" is not a valid address.`, {
      code: Codes.INVALID_HOST,
      hint: 'Use something like http://192.168.1.42:3000 or https://abc123.lhr.life',
    });
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw badRequest(`"${field}" must start with http:// or https://`, { code: Codes.INVALID_HOST });
  }
  if (url.username || url.password) {
    throw badRequest(`"${field}" must not contain a username or password.`, { code: Codes.INVALID_HOST });
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw badRequest(`"${field}" must be a bare server address without a path.`, {
      code: Codes.INVALID_HOST,
      hint: `Drop the "${url.pathname}" part — just the host and port.`,
    });
  }

  if (!allowPrivate && isPrivateHostname(url.hostname)) {
    throw badRequest(`"${field}" points at a private or loopback address, which is not allowed here.`, {
      code: Codes.INVALID_HOST,
      hint: 'Set FEDERATION_ALLOW_PRIVATE_HOSTS=true in .env if you are deliberately connecting over a LAN.',
    });
  }

  return url.origin;
}

function isPrivateHostname(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1' || h === '[::1]') return true;

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/** Message body: enforces the size cap that used to be missing entirely. */
function messageContent(value) {
  if (typeof value !== 'string') {
    throw badRequest('Message content must be text.', { code: Codes.MESSAGE_EMPTY });
  }
  const out = value.trim();
  if (!out) {
    throw badRequest('Cannot send an empty message.', { code: Codes.MESSAGE_EMPTY });
  }
  if (out.length > config.chat.maxMessageLength) {
    throw badRequest(
      `Message is ${out.length} characters — the limit is ${config.chat.maxMessageLength}.`,
      { code: Codes.MESSAGE_TOO_LONG, hint: 'Split it into a few shorter messages.' }
    );
  }
  return out;
}

/** Client-generated idempotency key. Optional, but strongly recommended. */
function clientMessageId(value) {
  if (value === undefined || value === null || value === '') return null;
  const out = string(value, 'clientMsgId', { min: 8, max: 64 });
  if (!/^[A-Za-z0-9_-]+$/.test(out)) throw badRequest('"clientMsgId" may contain only letters, numbers, "-" and "_".');
  return out;
}

module.exports = {
  requireFields, string, username, password, oneOf, integer, id,
  hostUrl, isPrivateHostname, messageContent, clientMessageId, USERNAME_RE,
};
