/**
 * Authentication and account safety.
 *
 * Everything here runs against real server processes. Two are booted for the
 * whole file:
 *   - `primary` — the server under test. Its JWT_SECRET is pinned so the test
 *     can mint tokens (expired, forged, unknown-user) that the server will
 *     accept as *structurally* valid, which is the only way to exercise the
 *     branches of `authService.authenticate`.
 *   - `foreign` — an identical server with a different JWT_SECRET, so a token
 *     from one machine can be pointed at the other. SpockChat is federated but
 *     accounts are per-machine; a neighbour's token must never authenticate here.
 *
 * Both are started with a very high auth rate limit so the functional tests do
 * not exhaust the bucket. Rate limiting gets its own dedicated servers below,
 * each with a fresh (per-process) token bucket, so those tests stay independent.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');

const { startServer } = require('./helpers/harness');

const PRIMARY_SECRET = 'auth-test-primary-secret-0123456789';
const FOREIGN_SECRET = 'a-totally-different-secret-value';
const PASSWORD = 'test-password-123';

/** Usernames are unique per database; every name in this file carries the file's prefix. */
const NO_LIMIT = { RATE_AUTH_PER_MIN: '5000' };

let primary;
let foreign;

before(async () => {
  [primary, foreign] = await Promise.all([
    startServer({ env: { ...NO_LIMIT, JWT_SECRET: PRIMARY_SECRET } }),
    startServer({ env: { ...NO_LIMIT, JWT_SECRET: FOREIGN_SECRET } }),
  ]);
});

after(async () => {
  await primary?.stop();
  await foreign?.stop();
});

const base64url = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');

// ─── REGISTER ─────────────────────────────────────────────────────────────────

describe('POST /auth/register', () => {
  test('returns 201 with a usable token and the new user, and never echoes the password', async () => {
    const res = await primary.api('POST', '/auth/register', {
      body: { username: 'auth_ok_shape', password: PASSWORD },
    });

    assert.equal(res.status, 201);
    assert.match(res.contentType, /json/);
    assert.equal(typeof res.body.token, 'string');
    assert.equal(res.body.token.split('.').length, 3, 'token should be a JWT');
    assert.equal(res.body.user.username, 'auth_ok_shape');
    assert.equal(typeof res.body.user.id, 'string');
    assert.ok(res.body.user.id.length > 0);
    // The hash must never reach the wire — not as `password`, not as `password_hash`.
    assert.doesNotMatch(res.text, /password/i, `register leaked a password field: ${res.text}`);

    // The token it hands back must actually authenticate.
    const me = await primary.api('GET', '/auth/me', { token: res.body.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, res.body.user.id);
  });

  test('a taken username is a 409 USERNAME_TAKEN, not a 500 from the unique constraint', async () => {
    const first = await primary.api('POST', '/auth/register', {
      body: { username: 'auth_dupe', password: PASSWORD },
    });
    assert.equal(first.status, 201);

    const second = await primary.api('POST', '/auth/register', {
      body: { username: 'auth_dupe', password: 'another-password-9' },
    });

    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'USERNAME_TAKEN');
    assert.ok(second.body.hint, 'a taken username must tell the user what to do instead');
    assert.doesNotMatch(second.text, /SQLITE|UNIQUE constraint/i, 'must not leak the SQL error');

    // The original account must be untouched by the failed second attempt.
    const login = await primary.api('POST', '/auth/login', {
      body: { username: 'auth_dupe', password: PASSWORD },
    });
    assert.equal(login.status, 200);
  });

  test('invalid usernames are rejected with VALIDATION_FAILED', async () => {
    const cases = [
      { label: 'too short', username: 'ab' },
      { label: 'too long', username: 'a'.repeat(25) },
      { label: 'contains a space', username: 'auth has space', hint: true },
      { label: 'contains symbols', username: 'auth!name#1', hint: true },
      { label: 'contains a dash', username: 'auth-name-1', hint: true },
      { label: 'non-ascii', username: 'auth_ünïcode', hint: true },
    ];

    for (const c of cases) {
      const res = await primary.api('POST', '/auth/register', {
        body: { username: c.username, password: PASSWORD },
      });
      assert.equal(res.status, 400, `${c.label}: expected 400, got ${res.status} (${res.text})`);
      assert.equal(res.body.code, 'VALIDATION_FAILED', `${c.label}: wrong code`);
      assert.match(res.contentType, /json/, `${c.label}: must be JSON`);
      if (c.hint) {
        assert.ok(res.body.hint, `${c.label}: a rejected username should suggest a valid one`);
      }
    }
  });

  test('a too-short password is rejected and no account is created', async () => {
    const res = await primary.api('POST', '/auth/register', {
      body: { username: 'auth_shortpw', password: 'short' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'VALIDATION_FAILED');

    // A half-created account would be worse than a rejection: the name would be
    // burned and unrecoverable, so prove nothing was written.
    const login = await primary.api('POST', '/auth/login', {
      body: { username: 'auth_shortpw', password: 'short' },
    });
    assert.equal(login.status, 401);
    assert.equal(login.body.code, 'BAD_CREDENTIALS');

    const retry = await primary.api('POST', '/auth/register', {
      body: { username: 'auth_shortpw', password: PASSWORD },
    });
    assert.equal(retry.status, 201, 'the username must still be free after a rejected register');
  });

  test('missing or wrongly-typed fields are 400, never a crash', async () => {
    const bodies = [
      { label: 'empty body', body: {} },
      { label: 'no password', body: { username: 'auth_missing_1' } },
      { label: 'no username', body: { password: PASSWORD } },
      { label: 'null password', body: { username: 'auth_missing_2', password: null } },
      { label: 'empty password', body: { username: 'auth_missing_3', password: '' } },
      { label: 'numeric username', body: { username: 12345678, password: PASSWORD } },
      { label: 'object password', body: { username: 'auth_missing_4', password: { a: 1 } } },
    ];

    for (const c of bodies) {
      const res = await primary.api('POST', '/auth/register', { body: c.body });
      assert.equal(res.status, 400, `${c.label}: expected 400, got ${res.status} (${res.text})`);
      assert.equal(res.body.code, 'VALIDATION_FAILED', `${c.label}: wrong code`);
      assert.ok(res.body.requestId, `${c.label}: errors must carry a request id`);
    }
  });
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────

describe('POST /auth/login', () => {
  test('correct credentials return the same user identity as registration', async () => {
    const created = await primary.register('auth_login_ok');

    const res = await primary.api('POST', '/auth/login', {
      body: { username: 'auth_login_ok', password: PASSWORD },
    });

    assert.equal(res.status, 200);
    assert.equal(typeof res.body.token, 'string');
    assert.equal(res.body.user.id, created.user.id, 'login must resolve to the registered account');
    assert.equal(res.body.user.username, 'auth_login_ok');
    assert.doesNotMatch(res.text, /password/i);
  });

  test('a wrong password is 401 BAD_CREDENTIALS with a hint', async () => {
    await primary.register('auth_wrongpw');

    const res = await primary.api('POST', '/auth/login', {
      body: { username: 'auth_wrongpw', password: 'definitely-not-it' },
    });

    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'BAD_CREDENTIALS');
    assert.ok(res.body.hint, 'a failed login must explain that accounts are per-machine');
    assert.equal(res.body.token, undefined);
  });

  /**
   * User enumeration guard. An attacker must not be able to learn which
   * usernames exist on a machine by watching login responses, so "no such user"
   * and "wrong password" have to be byte-identical apart from the request id.
   * (The service also runs a dummy bcrypt for unknown users to flatten the
   * timing signal; that is deliberately not asserted here because wall-clock
   * assertions are flaky under a loaded CI box.)
   */
  test('an unknown user is indistinguishable from a wrong password', async () => {
    await primary.register('auth_enum_real');

    const wrongPassword = await primary.api('POST', '/auth/login', {
      body: { username: 'auth_enum_real', password: 'not-the-password' },
    });
    const unknownUser = await primary.api('POST', '/auth/login', {
      body: { username: 'auth_enum_ghost', password: 'not-the-password' },
    });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, wrongPassword.status);
    assert.equal(wrongPassword.body.code, 'BAD_CREDENTIALS');
    assert.equal(unknownUser.body.code, wrongPassword.body.code);
    assert.equal(unknownUser.body.error, wrongPassword.body.error, 'the message must not reveal existence');
    assert.equal(unknownUser.body.hint, wrongPassword.body.hint);
    assert.ok(wrongPassword.body.hint);

    // Nothing about the unknown name may appear in the response either.
    assert.doesNotMatch(unknownUser.text, /auth_enum_ghost/);
  });

  test('surrounding whitespace in the username is trimmed on both register and login', async () => {
    // register() trims via the validator; login() must trim identically or an
    // account created from a form with a stray space becomes unreachable.
    const created = await primary.register('auth_trim');

    const res = await primary.api('POST', '/auth/login', {
      body: { username: '  auth_trim  ', password: PASSWORD },
    });

    assert.equal(res.status, 200, `padded username failed to log in: ${res.text}`);
    assert.equal(res.body.user.id, created.user.id);
  });
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

describe('GET /auth/me', () => {
  test('a valid token resolves to the account, without the password hash', async () => {
    const created = await primary.register('auth_me');

    const res = await primary.api('GET', '/auth/me', { token: created.token });

    assert.equal(res.status, 200);
    assert.equal(res.body.user.id, created.user.id);
    assert.equal(res.body.user.username, 'auth_me');
    assert.equal(res.body.user.password_hash, undefined);
    assert.doesNotMatch(res.text, /password/i, `/auth/me leaked credentials: ${res.text}`);
  });

  test('no token at all is 401 UNAUTHENTICATED', async () => {
    const res = await primary.api('GET', '/auth/me');

    assert.equal(res.status, 401);
    assert.match(res.contentType, /json/);
    assert.equal(res.body.code, 'UNAUTHENTICATED');
    assert.ok(res.body.hint, 'an unauthenticated response must tell the user to log in');
    assert.ok(res.body.requestId);
  });

  test('garbage, tampered and alg:none tokens are 401 TOKEN_INVALID', async () => {
    const created = await primary.register('auth_forge');

    // A JWT with its signature altered — proves the signature is actually checked.
    const tampered = created.token.slice(0, -1) + (created.token.endsWith('A') ? 'B' : 'A');

    // The classic "alg":"none" forgery: a well-formed token for a real account
    // with the signature simply omitted. jsonwebtoken must refuse it.
    const algNone =
      base64url({ alg: 'none', typ: 'JWT' }) +
      '.' +
      base64url({ id: created.user.id, exp: Math.floor(Date.now() / 1000) + 3600 }) +
      '.';

    const cases = [
      { label: 'not a jwt', token: 'total-garbage' },
      { label: 'three empty segments', token: 'a.b.c' },
      { label: 'tampered signature', token: tampered },
      { label: 'alg none forgery', token: algNone },
    ];

    for (const c of cases) {
      const res = await primary.api('GET', '/auth/me', { token: c.token });
      assert.equal(res.status, 401, `${c.label}: expected 401, got ${res.status} (${res.text})`);
      assert.equal(res.body.code, 'TOKEN_INVALID', `${c.label}: wrong code`);
      assert.ok(res.body.hint, `${c.label}: should tell the user to log in again`);
      assert.doesNotMatch(res.text, /JsonWebTokenError|jwt malformed/i, `${c.label}: leaked library internals`);
    }
  });

  /**
   * Federation makes cross-server token confusion a real risk: two SpockChat
   * machines expose the same API, and a token from one is a perfectly formed
   * JWT to the other. Only the signing secret distinguishes them.
   */
  test('a token signed by another server is rejected here but still works there', async () => {
    const created = await foreign.register('auth_foreign');

    const onIssuer = await foreign.api('GET', '/auth/me', { token: created.token });
    assert.equal(onIssuer.status, 200, 'the token must be valid on the server that issued it');

    const onPrimary = await primary.api('GET', '/auth/me', { token: created.token });
    assert.equal(onPrimary.status, 401);
    assert.equal(onPrimary.body.code, 'TOKEN_INVALID');
    assert.ok(onPrimary.body.hint);
  });

  /**
   * The three failure modes below used to collapse into a single "Invalid
   * token" message, so the client could not tell "log in again" from "this
   * database was reset" from "you are on the wrong machine". Keep them distinct.
   */
  test('an expired token is TOKEN_EXPIRED, distinct from TOKEN_INVALID', async () => {
    const created = await primary.register('auth_expired');
    const expired = jwt.sign({ id: created.user.id }, PRIMARY_SECRET, { expiresIn: '-30s' });

    const res = await primary.api('GET', '/auth/me', { token: expired });

    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'TOKEN_EXPIRED');
    assert.ok(res.body.hint);
  });

  test('a correctly signed token for an account that does not exist is 401', async () => {
    // What a client holds after the operator deletes spockchat.db: the signature
    // verifies, but the subject is gone. It must not authenticate as nobody.
    const orphan = jwt.sign({ id: randomUUID() }, PRIMARY_SECRET, { expiresIn: '30d' });

    const res = await primary.api('GET', '/auth/me', { token: orphan });

    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'TOKEN_INVALID');
    assert.ok(res.body.hint, 'should point at the reset database');
  });
});

// ─── PROTECTED ROUTES ─────────────────────────────────────────────────────────

describe('protected routes', () => {
  const ROUTES = [
    { method: 'GET', path: '/chats' },
    { method: 'GET', path: '/friends' },
    { method: 'POST', path: '/tunnel/start' },
  ];

  /**
   * Unmatched and unauthorised /api/* paths once fell through to the SPA
   * fallback and answered 200 with index.html, which is how broken routes went
   * unnoticed for so long. Every one of these must be a JSON 401.
   */
  test('reject unauthenticated access with a JSON 401, never the app shell', async () => {
    for (const route of ROUTES) {
      const res = await primary.api(route.method, route.path);
      const where = `${route.method} ${route.path}`;

      assert.equal(res.status, 401, `${where}: expected 401, got ${res.status}`);
      assert.match(res.contentType, /json/, `${where}: must answer JSON`);
      assert.doesNotMatch(res.text, /<!DOCTYPE|<html/i, `${where}: returned the HTML client`);
      assert.equal(res.body.code, 'UNAUTHENTICATED', `${where}: wrong code`);
      assert.ok(res.body.hint, `${where}: missing hint`);
      assert.ok(res.body.requestId, `${where}: missing requestId`);
    }
  });

  test('reject an invalid token with TOKEN_INVALID and do no work', async () => {
    for (const route of ROUTES) {
      const res = await primary.api(route.method, route.path, { token: 'not-a-real-token' });
      const where = `${route.method} ${route.path}`;

      assert.equal(res.status, 401, `${where}: expected 401, got ${res.status}`);
      assert.equal(res.body.code, 'TOKEN_INVALID', `${where}: wrong code`);
      assert.ok(res.body.hint, `${where}: missing hint`);
      // A rejected caller must not have reached the service layer — e.g. no SSH
      // process may be spawned for /tunnel/start.
      assert.doesNotMatch(res.text, /ssh|tunnel/i, `${where}: the handler appears to have run`);
    }
  });

  test('a valid token gets through to the same routes', async () => {
    // The 401s above are only meaningful if these routes work when authenticated.
    // (/tunnel/start is deliberately excluded — it spawns a real ssh process.)
    const created = await primary.register('auth_protected');

    const chats = await primary.api('GET', '/chats', { token: created.token });
    assert.equal(chats.status, 200);
    assert.ok(Array.isArray(chats.body.chats));

    const friends = await primary.api('GET', '/friends', { token: created.token });
    assert.equal(friends.status, 200);
  });
});

// ─── RATE LIMITING ────────────────────────────────────────────────────────────

describe('rate limiting on /auth', () => {
  // Buckets are per-process and keyed by client IP, and every test here runs
  // from the same address — so each test gets its own server, and therefore its
  // own empty bucket, instead of inheriting whatever the previous test spent.
  const spawned = [];

  after(async () => {
    await Promise.all(spawned.map(s => s.stop()));
  });

  async function limitedServer() {
    const server = await startServer({ env: { RATE_AUTH_PER_MIN: '5' } });
    spawned.push(server);
    return server;
  }

  test('hammering login past the limit returns 429 RATE_LIMITED with Retry-After', async () => {
    const server = await limitedServer();
    await server.register('auth_rl_hammer'); // costs one token of the five

    const statuses = [];
    let limited = null;

    for (let attempt = 0; attempt < 8 && !limited; attempt++) {
      const res = await server.api('POST', '/auth/login', {
        body: { username: 'auth_rl_hammer', password: 'wrong-password-here' },
      });
      statuses.push(res.status);
      if (res.status === 429) limited = res;
    }

    assert.ok(limited, `expected a 429 within 8 attempts, saw: ${statuses.join(',')}`);
    assert.equal(statuses[0], 401, 'the very first attempt must not be throttled');
    assert.ok(
      statuses.filter(s => s === 401).length <= 5,
      `more attempts allowed than RATE_AUTH_PER_MIN=5: ${statuses.join(',')}`
    );

    assert.match(limited.contentType, /json/);
    assert.equal(limited.body.code, 'RATE_LIMITED');
    assert.equal(limited.body.retryable, true);
    assert.ok(limited.body.hint, 'a throttled user must be told to wait');

    const retryAfter = limited.headers.get('retry-after');
    assert.ok(retryAfter, 'Retry-After header is missing — clients cannot back off correctly');
    assert.ok(Number.isFinite(Number(retryAfter)), `Retry-After is not a number: ${retryAfter}`);
    assert.ok(Number(retryAfter) >= 1);
    assert.equal(
      Number(retryAfter),
      limited.body.details?.retryAfterSeconds,
      'header and body must agree on the backoff'
    );

    // Throttling must not leak whether the credentials were right.
    assert.equal(limited.body.token, undefined);
  });

  test('a successful login is refunded and does not consume the budget', async () => {
    // The auth bucket exists to make credential stuffing expensive, not to log
    // out a legitimate user who reconnects a few times; auth.routes refunds the
    // token after a correct password.
    const server = await limitedServer();
    await server.register('auth_rl_refund'); // capacity 5, one spent here

    for (let i = 1; i <= 10; i++) {
      const res = await server.api('POST', '/auth/login', {
        body: { username: 'auth_rl_refund', password: PASSWORD },
      });
      assert.equal(
        res.status,
        200,
        `login #${i} was rejected (${res.status} ${res.body?.code}) — successful logins must be refunded`
      );
      assert.equal(typeof res.body.token, 'string');
    }

    // ...and the budget for *failed* attempts is still there afterwards, which
    // proves the refund did not simply disable the limiter.
    const bad = await server.api('POST', '/auth/login', {
      body: { username: 'auth_rl_refund', password: 'wrong-password-here' },
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.code, 'BAD_CREDENTIALS');
  });
});
