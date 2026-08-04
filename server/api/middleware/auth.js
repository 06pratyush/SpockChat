const authService = require('../../services/auth.service');
const { unauthorized, Codes } = require('../../core/errors');

function extractToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  // Socket.IO polling and <img>/EventSource style clients cannot set headers.
  if (typeof req.query?.access_token === 'string') return req.query.access_token;
  return null;
}

function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      throw unauthorized('You are not signed in.', {
        code: Codes.UNAUTHENTICATED,
        hint: 'Log in, then try again.',
      });
    }
    req.user = authService.authenticate(token);
    next();
  } catch (err) {
    next(err);
  }
}

/** Attaches req.user when a valid token is present, but never rejects. */
function optionalAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (token) req.user = authService.authenticate(token);
  } catch {
    // anonymous is fine here
  }
  next();
}

module.exports = { requireAuth, optionalAuth, extractToken };
