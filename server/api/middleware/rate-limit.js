const { config } = require('../../config');
const { RateLimiter } = require('../../core/rate-limiter');
const { tooManyRequests } = require('../../core/errors');
const { onShutdown } = require('../../core/lifecycle');

const limiters = {
  auth: new RateLimiter({ name: 'auth', capacity: config.limits.authAttemptsPerMinute, refillPerMin: config.limits.authAttemptsPerMinute }),
  api: new RateLimiter({ name: 'api', capacity: config.limits.apiRequestsPerMinute, refillPerMin: config.limits.apiRequestsPerMinute }),
  federation: new RateLimiter({ name: 'federation', capacity: config.limits.federationPerMinute, refillPerMin: config.limits.federationPerMinute }),
};

onShutdown('rate-limiters', () => Object.values(limiters).forEach(l => l.stop()));

function clientKey(req) {
  if (config.server.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * @param {'auth'|'api'|'federation'} bucket
 * @param {{message?:string, cost?:number}} [opts]
 */
function rateLimit(bucket, opts = {}) {
  const limiter = limiters[bucket];
  return (req, res, next) => {
    const key = `${bucket}:${clientKey(req)}`;
    const result = limiter.take(key, opts.cost ?? 1);

    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    if (result.allowed) {
      req.rateLimitKey = key;
      req.rateLimitBucket = bucket;
      return next();
    }

    const seconds = Math.ceil(result.retryAfterMs / 1000);
    res.setHeader('Retry-After', String(seconds));
    next(
      tooManyRequests(opts.message || `Too many requests. Try again in ${seconds}s.`, {
        details: { retryAfterSeconds: seconds },
      })
    );
  };
}

/** Give a token back after a legitimate action (e.g. a successful login). */
function refund(req) {
  if (req.rateLimitKey && limiters[req.rateLimitBucket]) {
    limiters[req.rateLimitBucket].refund(req.rateLimitKey);
  }
}

function snapshot() {
  return Object.values(limiters).map(l => l.snapshot());
}

module.exports = { rateLimit, refund, limiters, snapshot };
