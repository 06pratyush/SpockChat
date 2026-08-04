/**
 * The single place an HTTP failure becomes a response.
 *
 * Before, an invalid JSON body produced Express's default HTML error page — with
 * a full stack trace — and the browser client then died on `res.json()` with
 * "Unexpected token '<'". Unknown `/api/*` paths fell through to the SPA
 * fallback and returned `index.html` with **HTTP 200**, which is what hid the
 * broken federation routes for so long.
 *
 * Now: `/api/*` always answers with JSON, always with an accurate status, always
 * with a code and (where we can offer one) a hint. Internals never leak.
 */

const { AppError, Codes, internal } = require('../../core/errors');
const { createLogger } = require('../../core/logger');
const { config } = require('../../config');

const log = createLogger('http');

/** JSON 404 for unmatched API routes — must be mounted before the SPA fallback. */
function apiNotFound(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  res.status(404).json({
    error: `No such endpoint: ${req.method} ${req.path}`,
    code: Codes.NOT_FOUND,
    hint: 'Check the API reference in the README. This server is running SpockChat v' + config.app.version + '.',
    requestId: req.id,
  });
}

/** Map framework/library errors onto the app's error taxonomy. */
function normalize(err) {
  if (err instanceof AppError) return err;

  // body-parser
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError && 'body' in err) {
    return new AppError(Codes.MALFORMED_JSON, 'The request body was not valid JSON.', {
      status: 400,
      hint: 'This is usually a client bug or a truncated upload. Retry the action.',
      cause: err,
    });
  }
  if (err.type === 'entity.too.large') {
    return new AppError(Codes.PAYLOAD_TOO_LARGE, `The request body exceeded the ${config.server.jsonBodyLimit} limit.`, {
      status: 413,
      hint: 'Send less data — very long messages should be split up.',
      cause: err,
    });
  }
  if (err.code === 'EBADCSRFTOKEN') {
    return new AppError(Codes.FORBIDDEN, 'Request rejected for security reasons.', { status: 403, cause: err });
  }
  if (err.status === 404) {
    return new AppError(Codes.NOT_FOUND, 'Not found.', { status: 404, cause: err });
  }

  return internal('Something went wrong on this server.', { cause: err });
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
function errorHandler(err, req, res, next) {
  const appError = normalize(err);

  if (appError.status >= 500) {
    log.error(`${req.method} ${req.originalUrl} failed`, { reqId: req.id, err: err, code: appError.code });
  } else {
    log.warn(`${req.method} ${req.originalUrl} → ${appError.status} ${appError.code}`, {
      reqId: req.id,
      msg: appError.message,
    });
  }

  if (res.headersSent) return next(err);

  const body = { ...appError.toJSON(), requestId: req.id };
  // Stacks are for the operator's terminal, never for the wire — except in dev,
  // where they save a trip to the log file.
  if (!config.app.isProduction && appError.status >= 500 && err?.stack) {
    body.stack = err.stack.split('\n').slice(0, 8);
  }

  res.status(appError.status).json(body);
}

module.exports = { apiNotFound, errorHandler, normalize };
