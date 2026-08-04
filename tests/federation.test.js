/**
 * Federation — two real SpockChat servers talking to each other.
 *
 * This whole feature was broken end to end, in three separate ways, and each of
 * them is guarded here:
 *
 *   1. the federation handlers were declared *inside* the friends router as
 *      `/federation/...` while that router was mounted at `/api/federation`, so
 *      the real paths were `/api/federation/federation/...`. The documented paths
 *      fell through to the SPA fallback and returned `index.html` with HTTP 200,
 *      which is why every friend add died with "Unexpected token '<'".
 *   2. accepting a request only updated the accepter's row — nothing ever told
 *      the requester's server, so the requester stayed "pending" forever.
 *   3. a peer that was offline for a moment lost the message entirely; there was
 *      no queue and no retry.
 *
 * Everything below runs against real spawned processes with their own databases
 * and ports, because none of these bugs are reproducible in-process.
 */

const http = require('node:http');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startServer, waitFor, allocatePort } = require('./helpers/harness');

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * A server whose advertised address is deterministic loopback.
 *
 * Without PUBLIC_URL the server advertises its LAN IP, which is real behaviour
 * but makes cross-server delivery depend on the host's network and firewall.
 * Pinning it keeps these tests about federation logic, not about the machine.
 */
async function startPeerServer(extra = {}) {
  const port = extra.port || allocatePort();
  return startServer({
    ...extra,
    port,
    env: { PUBLIC_URL: `http://127.0.0.1:${port}`, ...(extra.env || {}) },
  });
}

/** Something that answers on HTTP but is emphatically not SpockChat. */
async function startNotSpockChat() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><body><h1>Router configuration</h1></body></html>');
  });
  const port = allocatePort();
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/** The core regression: /api/* must always be data, never the HTML app shell. */
function assertJson(res, label) {
  assert.match(res.contentType, /json/, `${label}: expected JSON, got "${res.contentType}" — body: ${res.text.slice(0, 120)}`);
  assert.doesNotMatch(res.text, /^\s*<(?:!doctype|html)/i, `${label}: served the HTML app shell instead of data`);
}

function assertHint(res, label) {
  assert.equal(typeof res.body?.hint, 'string', `${label}: a user-facing failure must carry a hint — got ${res.text}`);
  assert.ok(res.body.hint.length > 0, `${label}: hint was empty`);
}

// ─── the peer-facing protocol ─────────────────────────────────────────────────

describe('federation protocol endpoints', () => {
  let peer;
  let existing;

  before(async () => {
    peer = await startPeerServer();
    existing = await peer.register('fed_p_target');
  });

  after(async () => { await peer?.stop(); });

  test('GET /api/federation/ping identifies the server as SpockChat, in JSON', async () => {
    const res = await peer.api('GET', '/federation/ping');

    assertJson(res, 'GET /api/federation/ping');
    assert.equal(res.status, 200);
    assert.equal(res.body.app, 'SpockChat');
    assert.ok(res.body.version, 'ping should advertise a version');
    assert.equal(typeof res.body.protocol, 'number');
  });

  test('GET /api/federation/lookup/:username resolves a real user to id + username only', async () => {
    const res = await peer.api('GET', `/federation/lookup/${existing.user.username}`);

    assertJson(res, 'lookup of a real user');
    assert.equal(res.status, 200);
    assert.equal(res.body.username, 'fed_p_target');
    assert.equal(res.body.id, existing.user.id);
    // Unauthenticated endpoint: it must confirm existence and nothing more.
    assert.equal(res.body.password_hash, undefined);
    assert.equal(res.body.passwordHash, undefined);
  });

  test('lookup of an unknown user is a JSON 404 PEER_USER_NOT_FOUND', async () => {
    const res = await peer.api('GET', '/federation/lookup/fed_p_nobody');

    assertJson(res, 'lookup of an unknown user');
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'PEER_USER_NOT_FOUND');
  });

  test('lookup is case-insensitive, so "Fed_P_Target" still resolves', async () => {
    const res = await peer.api('GET', '/federation/lookup/Fed_P_Target');

    assertJson(res, 'case-insensitive lookup');
    assert.equal(res.status, 200);
    assert.equal(res.body.username, 'fed_p_target');
  });

  /**
   * The original bug: the routes really lived at /api/federation/federation/...
   * and the documented paths returned index.html with HTTP 200. If the doubled
   * path ever works again, the mount has regressed — and either way this must
   * never be HTML.
   */
  test('the historically doubled /api/federation/federation/* path is a JSON 404, not HTML 200', async () => {
    for (const path of ['/federation/federation/ping', '/federation/federation/lookup/fed_p_target']) {
      const res = await peer.api('GET', path);
      assertJson(res, `GET /api${path}`);
      assert.equal(res.status, 404, `GET /api${path} should not exist`);
      assert.equal(res.body.code, 'NOT_FOUND');
    }
  });

  test('an inbound friend-request for a user who does not exist here is refused with a hint', async () => {
    const res = await peer.api('POST', '/federation/friend-request', {
      body: {
        fromUsername: 'fed_p_stranger',
        fromHost: 'http://127.0.0.1:39999',
        toUsername: 'fed_p_ghost',
      },
    });

    assertJson(res, 'inbound friend-request for an unknown local user');
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'PEER_USER_NOT_FOUND');
    assertHint(res, 'inbound friend-request for an unknown local user');
  });
});

// ─── friendships across two servers ───────────────────────────────────────────

describe('friend requests across two servers', () => {
  let A;
  let B;
  let impostor;
  let deadHost;

  before(async () => {
    [A, B, impostor] = await Promise.all([startPeerServer(), startPeerServer(), startNotSpockChat()]);
    // Allocated but never bound — a plausible address with nothing behind it.
    deadHost = `http://127.0.0.1:${allocatePort()}`;
  });

  after(async () => {
    await Promise.all([A?.stop(), B?.stop(), impostor?.close()]);
  });

  test('alice on A adds bob on B, bob accepts, and BOTH sides end up accepted', async () => {
    const alice = await A.register('fed_alice');
    const bob = await B.register('fed_bob');

    const add = await A.api('POST', '/friends/add', {
      token: alice.token,
      body: { peerHost: B.url, peerUsername: 'fed_bob' },
    });

    assertJson(add, 'POST /friends/add');
    assert.equal(add.status, 201, `expected 201 from a reachable peer, got ${add.status}: ${add.text}`);
    assert.equal(add.body.delivered, true);
    assert.equal(add.body.queued, false);
    assert.equal(add.body.friendship.username, 'fed_bob');
    assert.equal(add.body.friendship.status, 'pending');
    assert.equal(add.body.friendship.direction, 'outgoing');

    // B recorded it as incoming — the request really crossed the wire.
    const bobPending = await B.api('GET', '/friends', { token: bob.token });
    assert.equal(bobPending.status, 200);
    assert.ok(
      bobPending.body.incoming.some(f => f.username === 'fed_alice'),
      `bob should see an incoming request from alice: ${bobPending.text}`
    );

    const alicePending = await A.api('GET', '/friends', { token: alice.token });
    assert.equal(alicePending.status, 200);
    assert.ok(
      alicePending.body.outgoing.some(f => f.username === 'fed_bob'),
      `alice should see an outgoing request to bob: ${alicePending.text}`
    );

    const accept = await B.api('POST', '/friends/fed_alice/accept', { token: bob.token });
    assertJson(accept, 'POST /friends/:username/accept');
    assert.equal(accept.status, 200, `accept should not have been queued: ${accept.text}`);
    assert.equal(accept.body.delivered, true);

    await waitFor(async () => {
      const res = await B.api('GET', '/friends', { token: bob.token });
      return res.body?.accepted?.some(f => f.username === 'fed_alice');
    }, { timeoutMs: 8_000, intervalMs: 150, label: "bob's list to show alice as accepted" });

    // The historical bug: nothing ever told the REQUESTER's server, so alice's
    // row stayed pending forever while bob's said accepted.
    const aliceRow = await waitFor(async () => {
      const res = await A.api('GET', '/friends', { token: alice.token });
      return res.body?.accepted?.find(f => f.username === 'fed_bob');
    }, { timeoutMs: 8_000, intervalMs: 150, label: "alice's list to show bob as accepted" });

    assert.equal(aliceRow.status, 'accepted');
    assert.equal(aliceRow.lastError, null, 'a converged friendship should have no lingering error');
  });

  test('adding a user who does not exist on the peer is a 404 PEER_USER_NOT_FOUND with a hint', async () => {
    const asker = await A.register('fed_a_missing');

    const res = await A.api('POST', '/friends/add', {
      token: asker.token,
      body: { peerHost: B.url, peerUsername: 'fed_b_ghost' },
    });

    assertJson(res, 'add of a peer user that does not exist');
    assert.equal(res.status, 404, `expected 404, got ${res.status}: ${res.text}`);
    assert.equal(res.body.code, 'PEER_USER_NOT_FOUND');
    assertHint(res, 'add of a peer user that does not exist');
  });

  test('adding against a host with nothing listening is a 503 PEER_UNREACHABLE with a hint', async () => {
    const asker = await A.register('fed_a_dead');

    const res = await A.api('POST', '/friends/add', {
      token: asker.token,
      body: { peerHost: deadHost, peerUsername: 'fed_b_anyone' },
    });

    assertJson(res, 'add against a dead host');
    assert.equal(res.status, 503, `expected 503, got ${res.status}: ${res.text}`);
    assert.equal(res.body.code, 'PEER_UNREACHABLE');
    assertHint(res, 'add against a dead host');
  });

  /**
   * "Something answered, but it is not SpockChat" is a different problem with a
   * different fix than "nothing answered" — an expired tunnel URL landing on a
   * provider page is the common case. The original collapsed both into an opaque
   * failure, and the HTML body then broke the client's JSON parse.
   */
  test('adding against a host that answers with HTML is PEER_NOT_SPOCKCHAT, and the reply is still JSON', async () => {
    const asker = await A.register('fed_a_html');

    const res = await A.api('POST', '/friends/add', {
      token: asker.token,
      body: { peerHost: impostor.url, peerUsername: 'fed_b_anyone' },
    });

    assertJson(res, 'add against a non-SpockChat host');
    assert.equal(res.body.code, 'PEER_NOT_SPOCKCHAT', `expected PEER_NOT_SPOCKCHAT, got ${res.text}`);
    assert.equal(res.status, 503);
    assertHint(res, 'add against a non-SpockChat host');
  });

  test('a duplicate friend request is a 409 FRIEND_EXISTS instead of a second pending row', async () => {
    const asker = await A.register('fed_a_dup');
    await B.register('fed_b_dup');

    const first = await A.api('POST', '/friends/add', {
      token: asker.token,
      body: { peerHost: B.url, peerUsername: 'fed_b_dup' },
    });
    assert.equal(first.status, 201, `first add should succeed: ${first.text}`);

    const second = await A.api('POST', '/friends/add', {
      token: asker.token,
      body: { peerHost: B.url, peerUsername: 'fed_b_dup' },
    });

    assertJson(second, 'duplicate POST /friends/add');
    assert.equal(second.status, 409, `expected 409, got ${second.status}: ${second.text}`);
    assert.equal(second.body.code, 'FRIEND_EXISTS');
    assertHint(second, 'duplicate POST /friends/add');

    const list = await A.api('GET', '/friends', { token: asker.token });
    assert.equal(
      list.body.outgoing.filter(f => f.username === 'fed_b_dup').length,
      1,
      'the duplicate must not have created a second row'
    );
  });
});

// ─── durability ───────────────────────────────────────────────────────────────

describe('federation outbox retry', () => {
  let A;
  let B;

  before(async () => {
    [A, B] = await Promise.all([startPeerServer(), startPeerServer()]);
  });

  after(async () => {
    await Promise.all([A?.stop(), B?.stop()]);
  });

  /**
   * The resilience feature. Before the outbox, a peer call made while the other
   * machine was closed was simply lost: bob's acceptance vanished and alice's
   * request stayed pending forever with no way to recover short of deleting and
   * re-sending it.
   */
  test('an acceptance sent while the requester\'s server is down is delivered after it restarts', async () => {
    const alice = await A.register('fed_out_alice');
    const bob = await B.register('fed_out_bob');
    const portA = A.port;
    const dbPathA = A.dbPath;

    const add = await A.api('POST', '/friends/add', {
      token: alice.token,
      body: { peerHost: B.url, peerUsername: 'fed_out_bob' },
    });
    assert.equal(add.status, 201, `setup add should succeed: ${add.text}`);

    // Alice's machine goes away before bob gets around to accepting.
    await A.stop();
    A = null;

    const accept = await B.api('POST', '/friends/fed_out_alice/accept', { token: bob.token });
    assertJson(accept, 'accept while the peer is down');
    assert.equal(accept.status, 202, `an undeliverable acceptance should be queued (202), got ${accept.status}: ${accept.text}`);
    assert.equal(accept.body.queued, true);
    assert.equal(accept.body.delivered, false);
    assert.ok(accept.body.warning, 'the user must be told the peer could not be reached');
    assertHint(accept, 'accept while the peer is down');
    // Locally it is already a friendship — only the notification is outstanding.
    assert.equal(accept.body.friendship.status, 'accepted');

    // Alice's machine comes back, same database, same address.
    A = await startPeerServer({ port: portA, dbPath: dbPathA });
    const aliceAgain = await A.login('fed_out_alice');

    // The outbox worker ticks every 1000ms in tests and backs off exponentially,
    // so allow a generous window for the queued call to land.
    const converged = await waitFor(async () => {
      const res = await A.api('GET', '/friends', { token: aliceAgain.token });
      return res.body?.accepted?.find(f => f.username === 'fed_out_bob');
    }, { timeoutMs: 15_000, intervalMs: 250, label: "the queued acceptance to reach alice's restarted server" });

    assert.equal(converged.status, 'accepted');

    // And it must no longer be sitting in the pending buckets.
    const finalList = await A.api('GET', '/friends', { token: aliceAgain.token });
    assert.equal(finalList.body.outgoing.some(f => f.username === 'fed_out_bob'), false);
    assert.equal(finalList.body.incoming.some(f => f.username === 'fed_out_bob'), false);
  });
});

// ─── abuse resistance ─────────────────────────────────────────────────────────

describe('federation rate limiting', () => {
  let peer;

  before(async () => {
    // Federation endpoints are unauthenticated by design, so the limiter is the
    // only thing standing between a peer and unbounded user-enumeration.
    peer = await startPeerServer({ env: { RATE_FEDERATION_PER_MIN: '5' } });
  });

  after(async () => { await peer?.stop(); });

  test('hammering /api/federation/ping trips a JSON 429 RATE_LIMITED', async () => {
    const responses = [];
    for (let i = 0; i < 12; i++) {
      responses.push(await peer.api('GET', '/federation/ping'));
    }

    assert.equal(responses[0].status, 200, `the first request must be allowed: ${responses[0].text}`);

    const limited = responses.find(r => r.status === 429);
    assert.ok(limited, `expected a 429 within 12 requests, got ${responses.map(r => r.status).join(',')}`);

    assertJson(limited, 'rate-limited federation ping');
    assert.equal(limited.body.code, 'RATE_LIMITED');
    assert.equal(limited.body.retryable, true);
    assertHint(limited, 'rate-limited federation ping');
    assert.ok(limited.headers.get('retry-after'), 'a 429 must say when to try again');

    // The limit must be the configured one, not an accident of ordering.
    assert.ok(
      responses.slice(0, 5).every(r => r.status === 200),
      `the first 5 requests should fit in the budget: ${responses.map(r => r.status).join(',')}`
    );
  });
});
