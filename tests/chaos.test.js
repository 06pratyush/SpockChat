/**
 * Packet-loss / chaos tests.
 *
 * These are the tests that actually justify the phrase "failure proof". Every
 * client here talks to SpockChat through a TCP proxy that severs connections
 * mid-flight, refuses new ones, and delays traffic past the acknowledgement
 * deadline. The assertions are the delivery contract:
 *
 *   1. NO LOSS       — every message the client accepted is stored
 *   2. NO DUPLICATES — retrying across a lost ack stores it exactly once
 *   3. NO GAPS       — sequence numbers stay contiguous under concurrency
 *   4. RECOVERY      — a client that was offline can prove what it missed
 *
 * Baseline behaviour (v2): a single dropped connection silently discarded the
 * message and the sender was never told.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startServer, sleep, waitFor } = require('./helpers/harness');
const { ChaosProxy } = require('./helpers/chaos-proxy');
const { ReliableClient } = require('./helpers/reliable-client');

describe('delivery under packet loss', () => {
  let server;

  before(async () => {
    server = await startServer({ env: { RATE_MESSAGES_PER_MIN: '10000', RATE_API_PER_MIN: '100000' } });
  });

  after(async () => { await server?.stop(); });

  test('no message is lost when connections are severed mid-flight', async () => {
    const { token } = await server.register('chaos_sender');
    const chat = await server.createChat(token, { name: 'Lossy Link' });

    const proxy = await new ChaosProxy({
      targetPort: server.port,
      dropRate: 0.5,    // half of all live connections die every tick
      tickMs: 30,       // fast enough that a burst of sends spans many ticks
      latencyMs: 12,    // keeps the run long enough for the chaos to actually bite
    }).start();

    const client = new ReliableClient({ url: proxy.url, token, ackTimeoutMs: 1500 });
    await client.connect();

    const TOTAL = 60;
    for (let i = 1; i <= TOTAL; i++) client.enqueue(chat.id, `chaos-${i}`);

    const failed = await client.drain({ timeoutMs: 90_000 });
    assert.equal(failed.length, 0, `${failed.length} messages gave up entirely`);

    // Read the truth from the server, bypassing the lossy proxy.
    const history = await server.api('GET', `/chats/${chat.id}/messages?limit=500`, { token });
    const contents = history.body.messages.map(m => m.content);

    for (let i = 1; i <= TOTAL; i++) {
      assert.ok(contents.includes(`chaos-${i}`), `chaos-${i} was lost`);
    }

    assert.equal(new Set(contents).size, contents.length, 'duplicate messages were stored');
    assert.equal(contents.length, TOTAL, `expected exactly ${TOTAL} messages, found ${contents.length}`);

    const seqs = history.body.messages.map(m => m.seq);
    for (let i = 1; i < seqs.length; i++) {
      assert.equal(seqs[i], seqs[i - 1] + 1, `sequence gap between ${seqs[i - 1]} and ${seqs[i]}`);
    }

    assert.ok(
      proxy.stats.dropped > 0,
      'the chaos proxy never severed a connection, so this test proved nothing'
    );

    client.close();
    await proxy.stop();
  });

  test('a lost acknowledgement does not duplicate the message', async () => {
    const { token } = await server.register('chaos_ack');
    const chat = await server.createChat(token, { name: 'Slow Acks' });

    // Latency exceeds the client's ack deadline, so the first attempts *appear*
    // to fail while actually reaching the server and being stored. The client
    // therefore retries messages that already exist. Without the clientMsgId
    // idempotency key this stores each message several times over.
    const proxy = await new ChaosProxy({ targetPort: server.port, latencyMs: 700 }).start();

    const client = new ReliableClient({ url: proxy.url, token, ackTimeoutMs: 300 });
    await client.connect();

    // The link heals partway through, so the retries can finally be acknowledged
    // — at which point the server must return the ORIGINAL stored message.
    const healer = setTimeout(() => { proxy.latencyMs = 0; }, 2_500);

    const TOTAL = 12;
    for (let i = 1; i <= TOTAL; i++) client.enqueue(chat.id, `slowack-${i}`);
    await client.drain({ timeoutMs: 60_000 });
    clearTimeout(healer);

    const history = await server.api('GET', `/chats/${chat.id}/messages?limit=500`, { token });
    const contents = history.body.messages.map(m => m.content);

    assert.equal(contents.length, TOTAL, `expected ${TOTAL} stored messages, found ${contents.length}`);
    assert.equal(new Set(contents).size, TOTAL, 'duplicates were stored despite the idempotency key');
    assert.ok(
      client.stats.ackTimeouts > 0,
      'the latency injection did not produce any ack timeouts, so this test proved nothing'
    );
    assert.ok(
      client.stats.duplicateAcks > 0,
      'no retry was answered with duplicate:true — the idempotency path was never exercised'
    );

    client.close();
    await proxy.stop();
  });

  test('messages queued during a total outage are delivered when the link returns', async () => {
    const { token } = await server.register('chaos_outage');
    const chat = await server.createChat(token, { name: 'Outage' });

    const proxy = await new ChaosProxy({ targetPort: server.port }).start();
    const client = new ReliableClient({ url: proxy.url, token, ackTimeoutMs: 1000, maxAttempts: 200 });
    await client.connect();

    // Full blackout: nothing can connect at all.
    const outage = proxy.outage(2_500);

    for (let i = 1; i <= 10; i++) client.enqueue(chat.id, `offline-${i}`);
    const draining = client.drain({ timeoutMs: 60_000 });

    await outage;
    const failed = await draining;

    assert.equal(failed.length, 0, 'messages were abandoned instead of being retried after the outage');

    const history = await server.api('GET', `/chats/${chat.id}/messages?limit=500`, { token });
    const contents = history.body.messages.map(m => m.content);
    for (let i = 1; i <= 10; i++) assert.ok(contents.includes(`offline-${i}`), `offline-${i} never arrived`);
    assert.equal(contents.length, 10, 'outage produced duplicates');

    client.close();
    await proxy.stop();
  });

  test('a reconnecting client recovers exactly the messages it missed', async () => {
    const alice = await server.register('chaos_alice');
    const bob = await server.register('chaos_bob');

    const chat = await server.createChat(alice.token, { name: 'Backfill' });
    const invite = await server.api('POST', `/chats/${chat.id}/invite`, {
      token: alice.token,
      body: { inviteeUsername: 'chaos_bob' },
    });
    await server.api('POST', `/chats/invites/${invite.body.invite.id}/respond`, {
      token: bob.token,
      body: { action: 'accept' },
    });

    const proxy = await new ChaosProxy({ targetPort: server.port }).start();

    const bobClient = new ReliableClient({ url: proxy.url, token: bob.token });
    await bobClient.connect();

    // Bob sees one message, then his link dies.
    await server.api('POST', `/chats/${chat.id}/messages`, {
      token: alice.token,
      body: { content: 'before the outage', clientMsgId: 'backfill-pre-0001' },
    });
    await waitFor(() => bobClient.received.size >= 1, { label: 'bob to receive the first message' });
    const cursorBeforeOutage = bobClient.cursors[chat.id];

    bobClient.socket.io.engine.close(); // sever the transport without a clean disconnect

    // Five messages arrive while Bob is dark.
    for (let i = 1; i <= 5; i++) {
      await server.api('POST', `/chats/${chat.id}/messages`, {
        token: alice.token,
        body: { content: `missed-${i}`, clientMsgId: `backfill-missed-000${i}` },
      });
    }

    // Socket.IO reconnects, and the client's own sync() backfills the gap.
    await waitFor(
      () => bobClient.cursors[chat.id] >= cursorBeforeOutage + 5,
      { timeoutMs: 20_000, label: 'bob to backfill the missed messages' }
    );

    const recovered = [...bobClient.received.values()].map(m => m.content);
    for (let i = 1; i <= 5; i++) {
      assert.ok(recovered.includes(`missed-${i}`), `missed-${i} was never recovered`);
    }

    bobClient.close();
    await proxy.stop();
  });

  test('concurrent senders on a lossy link produce contiguous, gap-free sequences', async () => {
    const users = await Promise.all([1, 2, 3].map(i => server.register(`chaos_multi_${i}`)));
    const chat = await server.createChat(users[0].token, { name: 'Concurrent' });

    for (const user of users.slice(1)) {
      const invite = await server.api('POST', `/chats/${chat.id}/invite`, {
        token: users[0].token,
        body: { inviteeUsername: user.user.username },
      });
      await server.api('POST', `/chats/invites/${invite.body.invite.id}/respond`, {
        token: user.token,
        body: { action: 'accept' },
      });
    }

    const proxy = await new ChaosProxy({
      targetPort: server.port, dropRate: 0.4, tickMs: 30, latencyMs: 10,
    }).start();

    const clients = users.map(u => new ReliableClient({ url: proxy.url, token: u.token, ackTimeoutMs: 1500 }));
    await Promise.all(clients.map(c => c.connect()));

    const PER_CLIENT = 15;
    clients.forEach((client, index) => {
      for (let i = 1; i <= PER_CLIENT; i++) client.enqueue(chat.id, `u${index}-m${i}`);
    });

    const failures = (await Promise.all(clients.map(c => c.drain({ timeoutMs: 90_000 })))).flat();
    assert.equal(failures.length, 0, 'some messages were abandoned');

    const history = await server.api('GET', `/chats/${chat.id}/messages?limit=500`, { token: users[0].token });
    const messages = history.body.messages;

    assert.equal(messages.length, clients.length * PER_CLIENT, 'wrong total — messages were lost or duplicated');

    const seqs = messages.map(m => m.seq);
    assert.equal(new Set(seqs).size, seqs.length, 'two messages share a sequence number');
    for (let i = 1; i < seqs.length; i++) {
      assert.equal(seqs[i], seqs[i - 1] + 1, `sequence gap at index ${i}`);
    }

    assert.ok(proxy.stats.dropped > 0, 'the proxy never severed a connection during the concurrent run');

    clients.forEach(c => c.close());
    await proxy.stop();
  });
});
