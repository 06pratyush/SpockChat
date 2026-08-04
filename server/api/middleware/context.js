/**
 * Request context: a correlation id on every request, plus access logging.
 *
 * When a user reports "adding my friend failed", the id in the error response
 * maps directly to the server log line that has the peer host, the timing and
 * the underlying socket error.
 */

const { randomUUID } = require('crypto');
const { createLogger } = require('../../core/logger');
const { isShuttingDown } = require('../../core/lifecycle');
const { AppError, Codes } = require('../../core/errors');

const log = createLogger('http');

function requestContext(req, res, next) {
  req.id = req.headers['x-request-id'] || randomUUID().slice(0, 8);
  req.startedAt = Date.now();
  res.setHeader('X-Request-Id', req.id);

  res.on('finish', () => {
    const ms = Date.now() - req.startedAt;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
    log[level](`${req.method} ${req.originalUrl} ${res.statusCode}`, {
      reqId: req.id,
      ms,
      ...(req.user ? { user: req.user.username } : {}),
    });
  });

  next();
}

/**
 * During shutdown, refuse new work with a clear 503 instead of accepting a
 * request that will be cut off mid-flight.
 */
function rejectWhenShuttingDown(req, res, next) {
  if (!isShuttingDown()) return next();
  res.setHeader('Connection', 'close');
  next(
    new AppError(Codes.SHUTTING_DOWN, 'This SpockChat server is shutting down.', {
      status: 503,
      retryable: true,
      hint: 'Start it again, then retry.',
    })
  );
}

/** Wrap an async route so a rejected promise reaches the error handler. */
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { requestContext, rejectWhenShuttingDown, asyncHandler };
