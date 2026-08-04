/**
 * Chats, membership, invites and history correctness.
 *
 * The centrepiece here is the history regression (see "history pagination"
 * below): the original server read history with `ORDER BY created_at ASC LIMIT
 * 100`, so once a chat passed a hundred messages every client was permanently
 * shown the *first* hundred and the conversation looked frozen. That bug is
 * cheap to reintroduce and invisible in a chat with 20 messages, so the test
 * seeds 120 and asserts the newest page comes back.
 *
 * Everything runs against a real spawned server. Error assertions are on the
 * stable `code` values from server/core/errors.js — never on message text.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { startServer } = require('./helpers/harness');

// Usernames are unique per database and this file shares one server, so every
// account here carries a file-specific prefix.
const U = name => `chat_${name}`;

/** How many messages the history fixture writes. Must exceed the 100 page size. */
const SEEDED = 120;

/** A chat id that is syntactically fine but was never created. */
const GHOST_CHAT = randomUUID();

let server;

before(async () => { server = await startServer(); });
after(async () => { await server?.stop(); });

/** Find one chat in the GET /chats sidebar payload. */
function findChat(listBody, chatId) {
  return listBody.chats.find(c => c.id === chatId);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('chat creation', () => {
  let owner;

  before(async () => { owner = await server.register(U('creator')); });

  test('a group chat is created with the caller as its only, admin, member', async () => {
    const res = await server.api('POST', '/chats', {
      token: owner.token,
      body: { name: 'Engineering', type: 'group', aiEnabled: false },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.chat.name, 'Engineering');
    assert.equal(res.body.chat.type, 'group');
    assert.equal(res.body.chat.is_admin, 1);
    assert.equal(res.body.chat.member_count, 1);
    assert.equal(res.body.chat.latest_seq, 0);
    assert.ok(!res.body.chat.ai_enabled, 'a group must respect aiEnabled:false');

    const details = await server.api('GET', `/chats/${res.body.chat.id}`, { token: owner.token });
    assert.equal(details.status, 200);
    assert.equal(details.body.members.length, 1);
    assert.equal(details.body.members[0].username, U('creator'));
    assert.equal(details.body.latestSeq, 0);
    assert.equal(details.body.capacity.current, 1);
  });

  /**
   * Regression: a 1v1 chat exists only to talk to the model, but the client
   * sends aiEnabled:false by default (and the old server honoured it), which
   * produced a 1v1 chat that could never answer. AI must be forced on there
   * regardless of what the caller asked for.
   */
  test('a 1v1 chat always comes back with AI enabled, even when asked not to', async () => {
    const res = await server.api('POST', '/chats', {
      token: owner.token,
      body: { name: 'Just me and the model', type: '1v1', aiEnabled: false },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.chat.type, '1v1');
    assert.ok(res.body.chat.ai_enabled, 'ai_enabled must be truthy on a 1v1 chat');

    // …and it survives the round trip through the database, not just the insert.
    const details = await server.api('GET', `/chats/${res.body.chat.id}`, { token: owner.token });
    assert.ok(details.body.chat.ai_enabled, 'ai_enabled must persist on a 1v1 chat');
  });

  test('malformed create payloads are rejected with VALIDATION_FAILED', async () => {
    const cases = [
      ['missing name',   { type: 'group' }],
      ['empty name',     { name: '', type: 'group' }],
      ['whitespace name', { name: '   ', type: 'group' }],
      ['200-character name', { name: 'x'.repeat(200), type: 'group' }],
      ['unknown type',   { name: 'Fine name', type: 'telepathy' }],
      ['missing type',   { name: 'Fine name' }],
    ];

    for (const [label, body] of cases) {
      const res = await server.api('POST', '/chats', { token: owner.token, body });
      assert.equal(res.status, 400, `${label} should be a 400, got ${res.status} (${res.text})`);
      assert.equal(res.body.code, 'VALIDATION_FAILED', `${label} produced the wrong code`);
      assert.ok(res.body.error, `${label} must explain what went wrong`);
      assert.ok(res.body.requestId, `${label} must be correlatable`);
    }
  });

  test('the type error names the values that would have worked', async () => {
    const res = await server.api('POST', '/chats', {
      token: owner.token,
      body: { name: 'Fine name', type: 'telepathy' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'VALIDATION_FAILED');
    assert.deepEqual(res.body.details.allowed, ['1v1', 'group']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('access control', () => {
  let owner, outsider, chat;

  before(async () => {
    owner = await server.register(U('owner'));
    outsider = await server.register(U('outsider'));
    chat = await server.createChat(owner.token, { name: 'Private Room' });
    const seed = await server.api('POST', `/chats/${chat.id}/messages`, {
      token: owner.token,
      body: { content: 'members only', clientMsgId: 'access-seed-0001' },
    });
    assert.equal(seed.status, 201);
  });

  test('a non-member is refused on details, history and sending', async () => {
    const attempts = [
      ['GET',  `/chats/${chat.id}`, undefined],
      ['GET',  `/chats/${chat.id}/messages`, undefined],
      ['POST', `/chats/${chat.id}/messages`, { content: 'let me in', clientMsgId: 'access-int-0001' }],
      ['POST', `/chats/${chat.id}/read`, { seq: 1 }],
      ['POST', `/chats/${chat.id}/invite`, { inviteeUsername: U('outsider') }],
    ];

    for (const [method, path, body] of attempts) {
      const res = await server.api(method, path, { token: outsider.token, body });
      assert.equal(res.status, 403, `${method} ${path} should be 403, got ${res.status} (${res.text})`);
      assert.equal(res.body.code, 'NOT_A_MEMBER', `${method} ${path} produced the wrong code`);
      assert.ok(res.body.hint, `${method} ${path} must tell the user how to get access`);
    }
  });

  test('a non-member never learns the contents of the chat', async () => {
    const res = await server.api('GET', `/chats/${chat.id}/messages`, { token: outsider.token });
    assert.equal(res.status, 403);
    assert.doesNotMatch(res.text, /members only/, 'the refusal must not leak message content');

    const list = await server.api('GET', '/chats', { token: outsider.token });
    assert.equal(list.status, 200);
    assert.equal(findChat(list.body, chat.id), undefined, 'the chat must not appear in a non-member sidebar');
  });

  test('a chat id that does not exist is a 404 CHAT_NOT_FOUND, not a 403', async () => {
    const attempts = [
      ['GET',  `/chats/${GHOST_CHAT}`, undefined],
      ['GET',  `/chats/${GHOST_CHAT}/messages`, undefined],
      ['POST', `/chats/${GHOST_CHAT}/messages`, { content: 'hello?', clientMsgId: 'ghost-send-0001' }],
    ];

    for (const [method, path, body] of attempts) {
      const res = await server.api(method, path, { token: owner.token, body });
      assert.equal(res.status, 404, `${method} ${path} should be 404, got ${res.status} (${res.text})`);
      assert.equal(res.body.code, 'CHAT_NOT_FOUND', `${method} ${path} produced the wrong code`);
      assert.ok(res.body.hint, `${method} ${path} must suggest a recovery`);
    }
  });

  test('an unauthenticated caller is rejected before membership is even considered', async () => {
    const res = await server.api('GET', `/chats/${chat.id}/messages`);
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'UNAUTHENTICATED');
    assert.ok(res.body.hint);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('history pagination', () => {
  let author, chat;

  before(async () => {
    author = await server.register(U('historian'));
    chat = await server.createChat(author.token, { name: 'Long Thread' });

    // Written one at a time and in order: seq is assigned on insert, so
    // parallel writes would make "message N has seq N" untrue.
    for (let i = 1; i <= SEEDED; i++) {
      const res = await server.api('POST', `/chats/${chat.id}/messages`, {
        token: author.token,
        body: { content: `message ${i}`, clientMsgId: `hist-${String(i).padStart(4, '0')}` },
      });
      assert.equal(res.status, 201, `seeding message ${i} failed: ${res.text}`);
      assert.equal(res.body.message.seq, i, `message ${i} got seq ${res.body.message.seq}`);
    }
  });

  /**
   * THE historical bug. `ORDER BY created_at ASC LIMIT 100` returned the first
   * hundred messages ever sent, so every chat past 100 messages was stuck
   * showing its own prehistory: the newest thing a user could see was message
   * 100, forever. The default page must be the *newest* page.
   */
  test('GET /messages with no params returns the NEWEST page, not the oldest', async () => {
    const res = await server.api('GET', `/chats/${chat.id}/messages`, { token: author.token });

    assert.equal(res.status, 200);
    assert.equal(res.body.mode, 'recent');
    assert.equal(res.body.latestSeq, SEEDED, 'latestSeq must reflect every stored message');

    const { messages } = res.body;
    assert.equal(messages.length, 100, 'the default page size is 100');

    // The assertion the original build would have failed on.
    assert.equal(messages.at(-1).content, `message ${SEEDED}`, 'the last message must be the newest one');
    assert.equal(messages.at(-1).seq, SEEDED);
    assert.notEqual(messages.at(-1).content, 'message 100', 'this is the frozen-history bug');

    // Oldest-first inside the page, contiguous, with no gaps or duplicates.
    assert.equal(messages[0].seq, SEEDED - 99);
    for (let i = 1; i < messages.length; i++) {
      assert.equal(messages[i].seq, messages[i - 1].seq + 1, `seq jumped at index ${i}`);
      assert.equal(messages[i].content, `message ${messages[i].seq}`);
    }
    assert.equal(res.body.complete, false, 'older messages remain, so the page is not the whole history');
  });

  test('?before=<seq> returns the preceding page, oldest-first', async () => {
    const newest = await server.api('GET', `/chats/${chat.id}/messages`, { token: author.token });
    const oldestOnScreen = newest.body.messages[0].seq; // 21

    const res = await server.api('GET', `/chats/${chat.id}/messages?before=${oldestOnScreen}`, { token: author.token });

    assert.equal(res.status, 200);
    assert.equal(res.body.mode, 'before');
    assert.equal(res.body.latestSeq, SEEDED);

    const { messages } = res.body;
    assert.equal(messages.length, oldestOnScreen - 1, 'everything older than the first page');
    assert.equal(messages[0].seq, 1, 'oldest-first ordering');
    assert.equal(messages.at(-1).seq, oldestOnScreen - 1, 'strictly before the cursor, never overlapping it');
    assert.ok(messages.every(m => m.seq < oldestOnScreen), 'no message may be at or after the cursor');
    assert.equal(res.body.complete, true, 'reaching seq 1 means the history is fully loaded');
  });

  test('?after=<seq> returns only newer messages — the reconnect backfill', async () => {
    const from = SEEDED - 3;
    const res = await server.api('GET', `/chats/${chat.id}/messages?after=${from}`, { token: author.token });

    assert.equal(res.status, 200);
    assert.equal(res.body.mode, 'after');
    assert.equal(res.body.messages.length, 3);
    assert.ok(res.body.messages.every(m => m.seq > from), 'the cursor message must not be resent');
    assert.equal(res.body.messages[0].seq, from + 1);
    assert.equal(res.body.messages.at(-1).seq, SEEDED);
    assert.equal(res.body.complete, true);

    // A client that is already current gets an empty, complete answer.
    const current = await server.api('GET', `/chats/${chat.id}/messages?after=${SEEDED}`, { token: author.token });
    assert.equal(current.status, 200);
    assert.deepEqual(current.body.messages, []);
    assert.equal(current.body.complete, true);
  });

  test('?limit is honoured and still yields the newest messages', async () => {
    const res = await server.api('GET', `/chats/${chat.id}/messages?limit=5`, { token: author.token });

    assert.equal(res.status, 200);
    assert.equal(res.body.messages.length, 5);
    assert.equal(res.body.messages[0].seq, SEEDED - 4);
    assert.equal(res.body.messages.at(-1).seq, SEEDED);
    assert.equal(res.body.messages.at(-1).content, `message ${SEEDED}`);

    const paged = await server.api('GET', `/chats/${chat.id}/messages?before=${SEEDED - 4}&limit=5`, { token: author.token });
    assert.equal(paged.body.messages.length, 5);
    assert.equal(paged.body.messages.at(-1).seq, SEEDED - 5);
    assert.equal(paged.body.messages[0].seq, SEEDED - 9);
  });

  test('a nonsensical pagination cursor is a validation error, not a silent empty page', async () => {
    const bad = await server.api('GET', `/chats/${chat.id}/messages?limit=99999`, { token: author.token });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'VALIDATION_FAILED');
    assert.ok(bad.body.error);
  });

  test('resending the same clientMsgId does not create a second message', async () => {
    const replay = await server.api('POST', `/chats/${chat.id}/messages`, {
      token: author.token,
      body: { content: `message ${SEEDED}`, clientMsgId: `hist-${String(SEEDED).padStart(4, '0')}` },
    });

    assert.equal(replay.status, 200, 'a replay is acknowledged, not re-created');
    assert.equal(replay.body.duplicate, true);
    assert.equal(replay.body.message.seq, SEEDED, 'the original row is returned');

    const res = await server.api('GET', `/chats/${chat.id}/messages`, { token: author.token });
    assert.equal(res.body.latestSeq, SEEDED, 'the sequence must not have advanced');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('invites', () => {
  let inviter, joiner, rejecter, meddler;

  before(async () => {
    inviter = await server.register(U('inviter'));
    joiner = await server.register(U('joiner'));
    rejecter = await server.register(U('rejecter'));
    meddler = await server.register(U('meddler'));
  });

  /** Each test gets a fresh chat + invite so none of them depend on each other. */
  async function inviteTo(inviteeUsername, chatName) {
    const chat = await server.createChat(inviter.token, { name: chatName });
    const res = await server.api('POST', `/chats/${chat.id}/invite`, {
      token: inviter.token,
      body: { inviteeUsername },
    });
    assert.equal(res.status, 201, `invite failed: ${res.text}`);
    return { chat, invite: res.body.invite };
  }

  test('accepting an invite joins the chat', async () => {
    const { chat, invite } = await inviteTo(U('joiner'), 'Bridge Crew');

    assert.equal(invite.chat_id, chat.id);
    assert.equal(invite.invitee_username, U('joiner'));
    assert.equal(invite.status, 'pending');

    const pending = await server.api('GET', '/chats/invites/pending', { token: joiner.token });
    assert.equal(pending.status, 200);
    assert.ok(pending.body.invites.some(i => i.id === invite.id), 'the invitee should see the invite');

    // Before accepting, the invitee is still an outsider.
    const beforeJoin = await server.api('GET', `/chats/${chat.id}`, { token: joiner.token });
    assert.equal(beforeJoin.status, 403);
    assert.equal(beforeJoin.body.code, 'NOT_A_MEMBER');

    const accept = await server.api('POST', `/chats/invites/${invite.id}/respond`, {
      token: joiner.token,
      body: { action: 'accept' },
    });
    assert.equal(accept.status, 200);
    assert.equal(accept.body.status, 'accepted');
    assert.equal(accept.body.joined, true);

    const afterJoin = await server.api('GET', `/chats/${chat.id}`, { token: joiner.token });
    assert.equal(afterJoin.status, 200);
    assert.equal(afterJoin.body.members.length, 2);
    assert.equal(afterJoin.body.capacity.current, 2);

    const list = await server.api('GET', '/chats', { token: joiner.token });
    assert.ok(findChat(list.body, chat.id), 'the chat must appear in the new member sidebar');

    // And a new member can actually participate.
    const post = await server.api('POST', `/chats/${chat.id}/messages`, {
      token: joiner.token,
      body: { content: 'reporting for duty', clientMsgId: 'invite-join-0001' },
    });
    assert.equal(post.status, 201);
  });

  /**
   * A double-clicked "Accept" used to run the join twice. The status transition
   * and the join are now one atomic step, so the second answer must be refused.
   */
  test('answering the same invite twice is a 409 INVITE_ALREADY_ANSWERED', async () => {
    const { chat, invite } = await inviteTo(U('joiner'), 'Double Click');

    const first = await server.api('POST', `/chats/invites/${invite.id}/respond`, {
      token: joiner.token,
      body: { action: 'accept' },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.joined, true);

    const second = await server.api('POST', `/chats/invites/${invite.id}/respond`, {
      token: joiner.token,
      body: { action: 'accept' },
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'INVITE_ALREADY_ANSWERED');
    assert.ok(second.body.hint, 'the user needs to be told the invite is already settled');

    // The double answer must not have produced a duplicate membership row.
    const details = await server.api('GET', `/chats/${chat.id}`, { token: inviter.token });
    assert.equal(details.body.members.length, 2);
    assert.equal(details.body.capacity.current, 2);
  });

  test('rejecting an invite does not join the chat', async () => {
    const { chat, invite } = await inviteTo(U('rejecter'), 'Not Interested');

    const reject = await server.api('POST', `/chats/invites/${invite.id}/respond`, {
      token: rejecter.token,
      body: { action: 'reject' },
    });
    assert.equal(reject.status, 200);
    assert.equal(reject.body.status, 'rejected');
    assert.equal(reject.body.joined, false);

    const details = await server.api('GET', `/chats/${chat.id}`, { token: rejecter.token });
    assert.equal(details.status, 403);
    assert.equal(details.body.code, 'NOT_A_MEMBER');
    assert.ok(details.body.hint);

    const asAdmin = await server.api('GET', `/chats/${chat.id}`, { token: inviter.token });
    assert.equal(asAdmin.body.members.length, 1, 'a rejection must not add a member');

    // The rejected invite is settled, so it cannot be flipped to an accept later.
    const flip = await server.api('POST', `/chats/invites/${invite.id}/respond`, {
      token: rejecter.token,
      body: { action: 'accept' },
    });
    assert.equal(flip.status, 409);
    assert.equal(flip.body.code, 'INVITE_ALREADY_ANSWERED');
  });

  test('responding to somebody else\'s invite is forbidden', async () => {
    const { chat, invite } = await inviteTo(U('joiner'), 'Wrong Recipient');

    const res = await server.api('POST', `/chats/invites/${invite.id}/respond`, {
      token: meddler.token,
      body: { action: 'accept' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'FORBIDDEN');

    const details = await server.api('GET', `/chats/${chat.id}`, { token: inviter.token });
    assert.equal(details.body.members.length, 1, 'the meddler must not have joined');
    assert.ok(!details.body.members.some(m => m.username === U('meddler')));

    // The real invitee can still use it — the failed attempt did not consume it.
    const accept = await server.api('POST', `/chats/invites/${invite.id}/respond`, {
      token: joiner.token,
      body: { action: 'accept' },
    });
    assert.equal(accept.status, 200);
    assert.equal(accept.body.joined, true);
  });

  test('an unknown invite id is a 404 INVITE_NOT_FOUND', async () => {
    const res = await server.api('POST', `/chats/invites/${randomUUID()}/respond`, {
      token: joiner.token,
      body: { action: 'accept' },
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'INVITE_NOT_FOUND');
    assert.ok(res.body.hint);

    const badAction = await server.api('POST', `/chats/invites/${randomUUID()}/respond`, {
      token: joiner.token,
      body: { action: 'maybe' },
    });
    assert.equal(badAction.status, 400);
    assert.equal(badAction.body.code, 'VALIDATION_FAILED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('group capacity', () => {
  // A dedicated server so the limit can be lowered without slowing the suite
  // down by inviting the default five members.
  let capped, admin, second, third, fourth, chat;

  before(async () => {
    capped = await startServer({ env: { MAX_GROUP_MEMBERS: '3' } });
    admin = await capped.register('cap_admin');
    second = await capped.register('cap_second');
    third = await capped.register('cap_third');
    fourth = await capped.register('cap_fourth');
    chat = await capped.createChat(admin.token, { name: 'Small Away Team' });
  });

  after(async () => { await capped?.stop(); });

  test('the invite that would exceed MAX_GROUP_MEMBERS fails with GROUP_FULL', async () => {
    const join = async (user, username) => {
      const invite = await capped.api('POST', `/chats/${chat.id}/invite`, {
        token: admin.token,
        body: { inviteeUsername: username },
      });
      assert.equal(invite.status, 201, `invite of ${username} failed: ${invite.text}`);
      const accept = await capped.api('POST', `/chats/invites/${invite.body.invite.id}/respond`, {
        token: user.token,
        body: { action: 'accept' },
      });
      assert.equal(accept.status, 200, `accept by ${username} failed: ${accept.text}`);
      assert.equal(accept.body.joined, true);
    };

    await join(second, 'cap_second');
    await join(third, 'cap_third');

    const full = await capped.api('GET', `/chats/${chat.id}`, { token: admin.token });
    assert.equal(full.body.capacity.current, 3);
    assert.equal(full.body.capacity.max, 3);

    const overflow = await capped.api('POST', `/chats/${chat.id}/invite`, {
      token: admin.token,
      body: { inviteeUsername: 'cap_fourth' },
    });
    assert.equal(overflow.status, 400, `expected GROUP_FULL, got ${overflow.status} (${overflow.text})`);
    assert.equal(overflow.body.code, 'GROUP_FULL');
    assert.ok(overflow.body.hint, 'a full group must tell the admin what to do about it');

    const unchanged = await capped.api('GET', `/chats/${chat.id}`, { token: admin.token });
    assert.equal(unchanged.body.members.length, 3, 'a refused invite must not change membership');

    const outsiderList = await capped.api('GET', '/chats', { token: fourth.token });
    assert.equal(outsiderList.body.chats.length, 0, 'the refused invitee joined nothing');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('read cursors and unread counts', () => {
  let readerA, readerB, chat;

  before(async () => {
    readerA = await server.register(U('reader_a'));
    readerB = await server.register(U('reader_b'));
    chat = await server.createChat(readerA.token, { name: 'Unread Tracking' });

    const invite = await server.api('POST', `/chats/${chat.id}/invite`, {
      token: readerA.token,
      body: { inviteeUsername: U('reader_b') },
    });
    assert.equal(invite.status, 201);
    const accept = await server.api('POST', `/chats/invites/${invite.body.invite.id}/respond`, {
      token: readerB.token,
      body: { action: 'accept' },
    });
    assert.equal(accept.status, 200);
  });

  test('marking read clears unread, and later messages from someone else raise it again', async () => {
    const post = async (token, n) => {
      const res = await server.api('POST', `/chats/${chat.id}/messages`, {
        token,
        body: { content: `unread ${n}`, clientMsgId: `unread-${String(n).padStart(4, '0')}` },
      });
      assert.equal(res.status, 201, `posting message ${n} failed: ${res.text}`);
      return res.body.message;
    };
    const unreadFor = async token => {
      const list = await server.api('GET', '/chats', { token });
      assert.equal(list.status, 200);
      return findChat(list.body, chat.id).unread;
    };

    for (let n = 1; n <= 3; n++) await post(readerA.token, n);

    // The sender has, by definition, already read their own messages.
    assert.equal(await unreadFor(readerA.token), 0, 'your own messages are never unread');
    assert.equal(await unreadFor(readerB.token), 3, 'the recipient has three unread messages');

    const read = await server.api('POST', `/chats/${chat.id}/read`, {
      token: readerB.token,
      body: { seq: 3 },
    });
    assert.equal(read.status, 200);
    assert.equal(read.body.readSeq, 3);
    assert.equal(await unreadFor(readerB.token), 0, 'marking read must clear the badge');

    // A new message from the other participant lifts the badge again…
    await post(readerA.token, 4);
    assert.equal(await unreadFor(readerB.token), 1);
    assert.equal(await unreadFor(readerA.token), 0);

    // …but a message B sends themselves does not.
    await post(readerB.token, 5);
    assert.equal(await unreadFor(readerB.token), 0, 'sending marks the sender caught up');
    assert.equal(await unreadFor(readerA.token), 1, 'and raises the badge for the other side');

    // The cursor only ever moves forward, so a stale client cannot rewind it.
    const rewind = await server.api('POST', `/chats/${chat.id}/read`, {
      token: readerB.token,
      body: { seq: 1 },
    });
    assert.equal(rewind.status, 200);
    assert.equal(rewind.body.readSeq, 5, 'a lower cursor must be ignored, not applied');
    assert.equal(await unreadFor(readerB.token), 0);
  });

  test('the read cursor is rejected without a sequence number', async () => {
    const res = await server.api('POST', `/chats/${chat.id}/read`, { token: readerB.token, body: {} });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'VALIDATION_FAILED');
    assert.ok(res.body.error);
  });
});
