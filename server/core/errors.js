/**
 * Error taxonomy.
 *
 * Every failure surfaced to a client is an `AppError` carrying:
 *   - `status`     HTTP status (also used to shape socket error payloads)
 *   - `code`       stable machine-readable string the UI can branch on
 *   - `message`    plain-language description of what went wrong
 *   - `hint`       what the user can actually DO about it — this is the field
 *                  that turns a dead end into a recoverable situation
 *   - `retryable`  whether retrying the same operation could succeed
 *
 * Anything thrown that is *not* an AppError is treated as a bug: it is logged
 * with a stack trace and reported to the client as an opaque INTERNAL error, so
 * we never leak internals the way the old HTML stack-trace pages did.
 */

class AppError extends Error {
  constructor(code, message, { status = 400, hint = null, retryable = false, cause = null, details = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.hint = hint;
    this.retryable = retryable;
    this.details = details;
    if (cause) this.cause = cause;
    Error.captureStackTrace?.(this, AppError);
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.retryable ? { retryable: true } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/** Error codes, grouped by concern. Keep these stable — the client branches on them. */
const Codes = {
  // request shape
  VALIDATION: 'VALIDATION_FAILED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  MALFORMED_JSON: 'MALFORMED_JSON',
  NOT_FOUND: 'NOT_FOUND',

  // auth
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  BAD_CREDENTIALS: 'BAD_CREDENTIALS',
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  FORBIDDEN: 'FORBIDDEN',

  // chat
  CHAT_NOT_FOUND: 'CHAT_NOT_FOUND',
  NOT_A_MEMBER: 'NOT_A_MEMBER',
  GROUP_FULL: 'GROUP_FULL',
  MESSAGE_TOO_LONG: 'MESSAGE_TOO_LONG',
  MESSAGE_EMPTY: 'MESSAGE_EMPTY',
  INVITE_NOT_FOUND: 'INVITE_NOT_FOUND',
  INVITE_ALREADY_ANSWERED: 'INVITE_ALREADY_ANSWERED',

  // friends / federation
  FRIEND_EXISTS: 'FRIEND_EXISTS',
  FRIEND_NOT_FOUND: 'FRIEND_NOT_FOUND',
  PEER_UNREACHABLE: 'PEER_UNREACHABLE',
  PEER_REJECTED: 'PEER_REJECTED',
  PEER_NOT_SPOCKCHAT: 'PEER_NOT_SPOCKCHAT',
  PEER_USER_NOT_FOUND: 'PEER_USER_NOT_FOUND',
  INVALID_HOST: 'INVALID_HOST',

  // ai
  AI_UNREACHABLE: 'AI_UNREACHABLE',
  AI_TIMEOUT: 'AI_TIMEOUT',
  AI_MODEL_MISSING: 'AI_MODEL_MISSING',
  AI_DISABLED: 'AI_DISABLED',
  AI_BUSY: 'AI_BUSY',
  AI_CIRCUIT_OPEN: 'AI_CIRCUIT_OPEN',
  AI_BAD_RESPONSE: 'AI_BAD_RESPONSE',

  // tunnel
  TUNNEL_SSH_MISSING: 'TUNNEL_SSH_MISSING',
  TUNNEL_TIMEOUT: 'TUNNEL_TIMEOUT',
  TUNNEL_FAILED: 'TUNNEL_FAILED',
  TUNNEL_NOT_RUNNING: 'TUNNEL_NOT_RUNNING',

  // infrastructure
  RATE_LIMITED: 'RATE_LIMITED',
  DB_UNAVAILABLE: 'DB_UNAVAILABLE',
  SHUTTING_DOWN: 'SHUTTING_DOWN',
  INTERNAL: 'INTERNAL_ERROR',
};

// ─── Factories for the failures we raise most often ──────────────────────────

const badRequest = (message, opts = {}) =>
  new AppError(opts.code || Codes.VALIDATION, message, { status: 400, ...opts });

const unauthorized = (message = 'Your session is not valid.', opts = {}) =>
  new AppError(opts.code || Codes.UNAUTHENTICATED, message, {
    status: 401,
    hint: 'Log in again to get a fresh session.',
    ...opts,
  });

const forbidden = (message = 'You do not have access to this.', opts = {}) =>
  new AppError(opts.code || Codes.FORBIDDEN, message, { status: 403, ...opts });

const notFound = (message = 'Not found.', opts = {}) =>
  new AppError(opts.code || Codes.NOT_FOUND, message, { status: 404, ...opts });

const conflict = (message, opts = {}) =>
  new AppError(opts.code || Codes.VALIDATION, message, { status: 409, ...opts });

const tooManyRequests = (message, opts = {}) =>
  new AppError(Codes.RATE_LIMITED, message, {
    status: 429,
    retryable: true,
    hint: 'Slow down for a moment and try again.',
    ...opts,
  });

const unavailable = (message, opts = {}) =>
  new AppError(opts.code || Codes.INTERNAL, message, { status: 503, retryable: true, ...opts });

const internal = (message = 'Something went wrong on this server.', opts = {}) =>
  new AppError(Codes.INTERNAL, message, {
    status: 500,
    hint: 'Check the SpockChat server log for details.',
    ...opts,
  });

/** True when the failure is worth retrying (transient network/infra, not user error). */
function isRetryable(err) {
  if (err instanceof AppError) return err.retryable;
  const transient = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
    'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET', 'ABORT_ERR',
  ]);
  return transient.has(err?.code) || err?.name === 'AbortError' || err?.name === 'TimeoutError';
}

module.exports = {
  AppError, Codes,
  badRequest, unauthorized, forbidden, notFound, conflict,
  tooManyRequests, unavailable, internal, isRetryable,
};
