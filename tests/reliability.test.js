/**
 * The socket delivery contract.
 *
 * Where chaos.test.js proves the guarantees hold over a hostile network, this
 * file pins down the protocol itself: acknowledgements, idempotency, sequence
 * numbering, reconnect backfill, presence and back-pressure. Each test names the
 * v2 behaviour it replaces where one existed.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startServer, sleep, waitFor, collect, emitWithAck } = require('./helpers/harness');

let n = 0;
const uniq = prefix => `rel_${prefix}_${Date.now().toString(36)}_${n++}`;

describe('acknowledgements and idempotency', () => {
  let server, alice, socket, chat;

  before(async () => {
    server = await startServer();
    alice = await server.register(uniq('alice'));
    chat = await server.createChat(alice.token, { name: 'Ack Contract' });
    socket = await server.connectSocket(alice.token);
  });

  after(async () => { socket?.close(); await server?.stop(); });

  test('a send is acknowledged with the stored message and its sequence number', async () => {
    const ack = await emitWithAck(socket, 'message:send', {
      chatId: chat.id, content: 'hello there', clientMsgId: 'ack-basic-000001',
    });

    assert.equal(ack.ok, true);
    assert.equal(ack.duplicate, false);
    assert.equal(ack.message.content, 'hello there');
    assert.equal(ack.message.seq, 1);
    assert.equal(ack.seq, 1);
    assert.ok(ack.message.id, 'the ack must carry the stored row, not just a boolean');
  });

  test('replaying the same clientMsgId stores one message and reports duplicate', async () => {
    const payload = { chatId: chat.id, content: 'exactly once', clientMsgId: 'ack-idem-000001' };

    const first = await emitWithAck(socket, 'message:send', payload);
    const second = await emitWithAck(socket, 'message:send', payload);
    const third = await emitWithAck(socket, 'message:send', payload);

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(third.duplicate, true);
    assert.equal(second.message.id, first.message.id);
    assert.equal(third.message.seq, first.message.seq);

    const history = await server.api('GET', `/chats/${chat.id}/messages?limit=500`, { token: alice.token });
    const matches = history.body.messages.filter(m => m.content === 'exactly once');
    assert.equal(matches.length, 1, 'the retry created a duplicate row');
  });

  test('the socket and the HTTP fallback share one message identity', async () => {
    // This is what lets a client switch transports mid-retry without duplicating.
    const clientMsgId = 'ack-cross-transport-01';

    const viaHttp = await server.api('POST', `/chats/${chat.id}/messages`, {
      token: alice.token,
      body: { content: 'transport agnostic', clientMsgId },
    });
    assert.equal(viaHttp.status, 201);
    assert.equal(viaHttp.body.duplicate, false);

    const viaSocket = await emitWithAck(socket, 'message:send', {
      chatId: chat.id, content: 'transport agnostic', clientMsgId,
    });
    assert.equal(viaSocket.duplicate, true);
    assert.equal(viaSocket.message.id, viaHttp.body.message.id);

    const again = await server.api('POST', `/chats/${chat.id}/messages`, {
      token: alice.token,
      body: { content: 'transport agnostic', clientMsgId },
    });
    assert.equal(again.status, 200, 'a duplicate over HTTP should be 200, not a second 201');
    assert.equal(again.body.duplicate, true);

    const history = await server.api('GET', `/chats/${chat.id}/messages?limit=500`, { token: alice.token });
    assert.equal(
      history.body.messages.filter(m => m.content === 'transport agnostic').length, 1,
      'the same clientMsgId produced more than one row across transports'
    );
  });

  test('sequence numbers are contiguous within a chat and independent between chats', async () => {
    const other = await server.createChat(alice.token, { name: 'Separate Sequence' });

    const a1 = await emitWithAck(socket, 'message:send', { chatId: other.id, content: 'first', clientMsgId: 'seq-other-01' });
    const a2 = await emitWithAck(socket, 'message:send', { chatId: other.id, content: 'second', clientMsgId: 'seq-other-02' });

    assert.equal(a1.message.seq, 1, 'a fresh chat starts at sequence 1');
    assert.equal(a2.message.seq, 2);

    const main = await server.api('GET', `/chats/${chat.id}/messages?limit=500`, { token: alice.token });
    const seqs = main.body.messages.map(m => m.seq);
    for (let i = 1; i < seqs.length; i++) {
      assert.equal(seqs[i], seqs[i - 1] + 1, 'sequence gap in the original chat');
    }
    assert.ok(seqs[seqs.length - 1] > 2, 'the two chats should not share a counter');
  });
});

describe('rejection paths always answer the sender', () => {
  let server, alice, mallory, socket, chat;

  before(async () => {
    server = await startServer({ env: { MAX_MESSAGE_LENGTH: '200' } });
    alice = await server.register(uniq('alice'));
    mallory = await server.register(uniq('mallory'));
    chat = await server.createChat(alice.token, { name: 'Rejections' });
    socket = await server.connectSocket(alice.token);
  });

  after(async () => { socket?.close(); await server?.stop(); });

  test('an oversized message is refused with a code and a hint, and nothing is stored', async () => {
    const before = await server.api('GET', `/chats/${chat.id}/messages`, { token: alice.token });

    const ack = await emitWithAck(socket, 'message:send', {
      chatId: chat.id, content: 'x'.repeat(5000), clientMsgId: 'reject-toolong-01',
    });

    assert.equal(ack.ok, false);
    assert.equal(ack.code, 'MESSAGE_TOO_LONG');
    assert.ok(ack.hint, 'a refusal must tell the user what to do');

    const after = await server.api('GET', `/chats/${chat.id}/messages`, { token: alice.token });
    assert.equal(after.body.messages.length, before.body.messages.length);
  });

  test('an empty message is refused rather than silently dropped', async () => {
    const ack = await emitWithAck(socket, 'message:send', {
      chatId: chat.id, content: '   \n\t  ', clientMsgId: 'reject-empty-01',
    });
    assert.equal(ack.ok, false);
    assert.equal(ack.code, 'MESSAGE_EMPTY');
  });

  test('a non-member is refused and nothing is written to the chat', async () => {
    const intruder = await server.connectSocket(mallory.token);
    try {
      const ack = await emitWithAck(intruder, 'message:send', {
        chatId: chat.id, content: 'I should not be here', clientMsgId: 'reject-nonmember-1',
      });
      assert.equal(ack.ok, false);
      assert.equal(ack.code, 'NOT_A_MEMBER');

      const history = await server.api('GET', `/chats/${chat.id}/messages?limit=500`, { token: alice.token });
      assert.ok(!history.body.messages.some(m => m.content === 'I should not be here'));
    } finally {
      intruder.close();
    }
  });

  test('a send to a chat that does not exist is refused, not ignored', async () => {
    const ack = await emitWithAck(socket, 'message:send', {
      chatId: '00000000-0000-4000-8000-000000000000',
      content: 'into the void',
      clientMsgId: 'reject-nochat-0001',
    });
    assert.equal(ack.ok, false);
    assert.equal(ack.code, 'CHAT_NOT_FOUND');
  });
});

describe('reconnect backfill', () => {
  let server, alice, bob, chat;

  before(async () => {
    server = await startServer();
    alice = await server.register(uniq('alice'));
    bob = await server.register(uniq('bob'));
    chat = await server.createChat(alice.token, { name: 'Backfill Contract' });

    const invite = await server.api('POST', `/chats/${chat.id}/invite`, {
      token: alice.token, body: { inviteeUsername: bob.user.username },
    });
    await server.api('POST', `/chats/invites/${invite.body.invite.id}/respond`, {
      token: bob.token, body: { action: 'accept' },
    });
  });

  after(async () => { await server?.stop(); });

  test('chats:sync returns exactly the messages after the supplied cursor', async () => {
    for (let i = 1; i <= 5; i++) {
      await server.api('POST', `/chats/${chat.id}/messages`, {
        token: alice.token, body: { content: `sync-${i}`, clientMsgId: `sync-msg-000${i}` },
      });
    }

    const socket = await server.connectSocket(bob.token);
    try {
      const fromStart = await emitWithAck(socket, 'chats:sync', { cursors: { [chat.id]: 0 } });
      assert.equal(fromStart.ok, true);
      assert.equal(fromStart.chats[chat.id].missed.length, 5);
      assert.equal(fromStart.chats[chat.id].latestSeq, 5);
      assert.equal(fromStart.chats[chat.id].complete, true);

      const fromMiddle = await emitWithAck(socket, 'chats:sync', { cursors: { [chat.id]: 3 } });
      const missed = fromMiddle.chats[chat.id].missed;
      assert.equal(missed.length, 2);
      assert.deepEqual(missed.map(m => m.content), ['sync-4', 'sync-5']);
      assert.deepEqual(missed.map(m => m.seq), [4, 5]);

      const upToDate = await emitWithAck(socket, 'chats:sync', { cursors: { [chat.id]: 5 } });
      assert.equal(upToDate.chats[chat.id].missed.length, 0);
      assert.equal(upToDate.chats[chat.id].complete, true);
    } finally {
      socket.close();
    }
  });

  test('a client that was disconnected recovers everything it missed', async () => {
    const socket = await server.connectSocket(bob.token);
    const received = collect(socket, 'message:new');

    await server.api('POST', `/chats/${chat.id}/messages`, {
      token: alice.token, body: { content: 'seen live', clientMsgId: 'gap-live-000001' },
    });
    await waitFor(() => received.length >= 1, { label: 'the live message' });
    const cursor = received[received.length - 1].message.seq;

    socket.disconnect();
    await sleep(150);

    for (let i = 1; i <= 4; i++) {
      await server.api('POST', `/chats/${chat.id}/messages`, {
        token: alice.token, body: { content: `while-away-${i}`, clientMsgId: `gap-away-00000${i}` },
      });
    }

    const reconnected = await server.connectSocket(bob.token);
    try {
      const sync = await emitWithAck(reconnected, 'chats:sync', { cursors: { [chat.id]: cursor } });
      const recovered = sync.chats[chat.id].missed.map(m => m.content);
      assert.deepEqual(recovered, ['while-away-1', 'while-away-2', 'while-away-3', 'while-away-4']);
    } finally {
      reconnected.close();
      socket.close();
    }
  });

  test('rooms are joined automatically on connect, with no client-side join call', async () => {
    // v2 required the client to emit chats:join before it would receive anything,
    // so a message sent in the gap between connect and join was never delivered.
    const socket = await server.connectSocket(bob.token);
    const received = collect(socket, 'message:new');
    try {
      await server.api('POST', `/chats/${chat.id}/messages`, {
        token: alice.token, body: { content: 'no join needed', clientMsgId: 'autojoin-000001' },
      });
      await waitFor(() => received.some(r => r.message.content === 'no join needed'), {
        label: 'delivery without an explicit join',
      });
    } finally {
      socket.close();
    }
  });

  test('backfill still works after the server has been restarted', async () => {
    // The cursor lives in the database, not in server memory, so a restart is
    // just another kind of outage.
    const socket = await server.connectSocket(bob.token);
    const latest = (await server.api('GET', `/chats/${chat.id}/messages`, { token: bob.token })).body.latestSeq;
    socket.close();

    await server.api('POST', `/chats/${chat.id}/messages`, {
      token: alice.token, body: { content: 'before restart', clientMsgId: 'restart-pre-0001' },
    });

    const dbPath = server.dbPath;
    const port = server.port;
    await server.stop();
    server = await startServer({ dbPath, port });

    const bobAgain = await server.login(bob.user.username);
    const reconnected = await server.connectSocket(bobAgain.token);
    try {
      const sync = await emitWithAck(reconnected, 'chats:sync', { cursors: { [chat.id]: latest } });
      const contents = sync.chats[chat.id].missed.map(m => m.content);
      assert.ok(contents.includes('before restart'), 'the pre-restart message was not recovered');
    } finally {
      reconnected.close();
    }
  });
});

describe('presence and back-pressure', () => {
  let server;

  after(async () => { await server?.stop(); });

  test('a user with two tabs keeps receiving after one closes', async () => {
    // v2 stored one socket per username, so closing any tab silently unsubscribed
    // the others from invites and friend requests.
    server = await startServer();
    const alice = await server.register(uniq('alice'));
    const bob = await server.register(uniq('bob'));
    const chat = await server.createChat(alice.token, { name: 'Two Tabs' });

    const tabOne = await server.connectSocket(bob.token);
    const tabTwo = await server.connectSocket(bob.token);
    const onTabTwo = collect(tabTwo, 'invite:received');

    tabOne.close();
    await sleep(250);

    await server.api('POST', `/chats/${chat.id}/invite`, {
      token: alice.token, body: { inviteeUsername: bob.user.username },
    });

    await waitFor(() => onTabTwo.length > 0, { label: 'the surviving tab to receive the invite' });
    assert.equal(onTabTwo[0].invite.chat_name, 'Two Tabs');

    tabTwo.close();
    await server.stop();
  });

  test('a message flood is rate limited with an actionable refusal', async () => {
    server = await startServer({ env: { RATE_MESSAGES_PER_MIN: '5' } });
    const alice = await server.register(uniq('flood'));
    const chat = await server.createChat(alice.token, { name: 'Flood' });
    const socket = await server.connectSocket(alice.token);

    const acks = [];
    for (let i = 0; i < 12; i++) {
      acks.push(await emitWithAck(socket, 'message:send', {
        chatId: chat.id, content: `flood-${i}`, clientMsgId: `flood-msg-0000${i}`,
      }));
    }

    const limited = acks.filter(a => a.code === 'RATE_LIMITED');
    assert.ok(limited.length > 0, 'the flood was never rate limited');
    assert.ok(limited[0].hint, 'a rate-limit refusal must say how long to wait');
    assert.ok(limited[0].retryable, 'rate limiting is a retryable condition');

    socket.close();
    await server.stop();
  });

  test('a socket with an invalid token is rejected with a machine-readable reason', async () => {
    server = await startServer();
    await assert.rejects(
      () => server.connectSocket('not-a-real-token'),
      err => {
        assert.match(err.message, /connect_error/);
        assert.equal(err.data?.code, 'TOKEN_INVALID');
        assert.ok(err.data?.hint);
        return true;
      }
    );
    await server.stop();
  });
});
