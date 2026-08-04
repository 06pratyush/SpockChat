/**
 * Friendships across independent SpockChat servers.
 *
 * What was broken before:
 *   - the federation routes were mounted at the wrong path, so *every* friend
 *     add failed with a JSON parse error
 *   - accepting a request only updated the accepter's row; the requester stayed
 *     "pending" forever, because nothing ever told their server
 *   - a peer that was momentarily offline lost the request entirely
 *
 * The flow now:
 *
 *   Alice@A adds bob@B
 *     A ── ping ──────────────▶ B      confirm B really is SpockChat
 *     A ── lookup/bob ────────▶ B      confirm bob exists there
 *     A ── friend-request ────▶ B      queued + retried if B is down
 *     A: friendship(bob) = pending/outgoing
 *     B: friendship(alice) = pending/incoming  → socket notification
 *
 *   Bob accepts
 *     B: friendship(alice) = accepted
 *     B ── friend-response ───▶ A      queued + retried if A is down
 *     A: friendship(bob) = accepted    → socket notification
 */

const friends = require('../db/repositories/friends.repo');
const users = require('../db/repositories/users.repo');
const federation = require('./federation.service');
const identity = require('./identity.service');
const validate = require('../core/validate');
const { createLogger } = require('../core/logger');
const { badRequest, conflict, notFound, Codes } = require('../core/errors');

const log = createLogger('friends');

/** Anything the client needs to render a friend row, including failure state. */
function present(row) {
  return {
    username: row.friend_username,
    host: row.friend_host,
    status: row.status,
    direction: row.direction || 'outgoing',
    remote: !isLocalHost(row.friend_host),
    lastError: row.last_error || null,
    updatedAt: row.updated_at || row.created_at,
  };
}

function isLocalHost(host) {
  return host === identity.lanUrl() || /localhost|127\.0\.0\.1/.test(host || '');
}

function list(userId) {
  const all = friends.listAll(userId);
  return {
    accepted: all.filter(f => f.status === 'accepted').map(present),
    incoming: all.filter(f => f.status === 'pending' && f.direction === 'incoming').map(present),
    outgoing: all.filter(f => f.status === 'pending' && f.direction === 'outgoing').map(present),
  };
}

/**
 * Send a friend request to a user on another server.
 *
 * Fails fast and specifically: unreachable host, not-a-SpockChat-server, and
 * no-such-user are three different errors with three different fixes, where the
 * original produced one opaque 503 for all of them.
 */
async function requestFriendship(user, { peerHost, peerUsername }, req = null) {
  const host = validate.hostUrl(peerHost, 'peerHost', { allowPrivate: true });
  const name = validate.username(peerUsername, 'peerUsername');

  const existing = friends.find(user.id, name);
  if (existing && existing.status === 'accepted') {
    throw conflict(`You and ${name} are already friends.`, { code: Codes.FRIEND_EXISTS });
  }
  if (existing && existing.status === 'pending' && existing.direction === 'outgoing') {
    throw conflict(`You already have a pending request to ${name}.`, {
      code: Codes.FRIEND_EXISTS,
      hint: 'Ask them to open SpockChat and check their friend requests.',
    });
  }
  if (existing && existing.status === 'pending' && existing.direction === 'incoming') {
    // They asked us first — treat this as an acceptance rather than a new request.
    return acceptFriendship(user, name);
  }

  const selfAddress = identity.reachableUrl(req);
  if (name === user.username && host === selfAddress) {
    throw badRequest('You cannot add yourself.', { hint: 'Enter your friend’s address and username instead.' });
  }

  // 1. Is anything there, and is it SpockChat?
  await federation.ping(host);

  // 2. Does that user exist there?
  const peer = await federation.lookupUser(host, name);

  // 3. Deliver the request (queued and retried if their machine drops out).
  const payload = {
    fromUsername: user.username,
    fromId: user.id,
    fromHost: selfAddress,
    toUsername: name,
  };
  const delivery = await federation.deliver(host, 'friend-request', payload);

  if (!delivery.delivered && !delivery.queued) {
    throw delivery.error || badRequest('The other server rejected the request.', { code: Codes.PEER_REJECTED });
  }

  friends.upsert({
    userId: user.id,
    friendId: peer?.id || `remote:${host}:${name}`,
    friendUsername: name,
    friendHost: host,
    status: 'pending',
    direction: 'outgoing',
  });

  if (delivery.queued) {
    friends.setLastError(user.id, name, delivery.error?.message || 'Delivery pending');
  }

  log.info('friend request sent', { to: name, host, queued: delivery.queued });

  return {
    friendship: present(friends.find(user.id, name)),
    delivered: delivery.delivered,
    queued: delivery.queued,
    ...(delivery.queued
      ? {
          warning: `${name}'s server did not answer, so the request is queued.`,
          hint: 'SpockChat will keep retrying in the background. They will get it when their machine is back online.',
        }
      : {}),
  };
}

/** Record an inbound request that arrived from a peer server. */
function receiveRequest({ fromUsername, fromId, fromHost, toUsername }) {
  const name = validate.username(fromUsername, 'fromUsername');
  const host = validate.hostUrl(fromHost, 'fromHost', { allowPrivate: true });
  const target = validate.username(toUsername, 'toUsername');

  const localUser = users.findByUsernameLoose(target);
  if (!localUser) {
    throw notFound(`No user named "${target}" exists on this server.`, {
      code: Codes.PEER_USER_NOT_FOUND,
      hint: 'Check the spelling of the username you were given.',
    });
  }

  const existing = friends.find(localUser.id, name);
  if (existing?.status === 'accepted') {
    // Already friends — treat as success so the sender's retry converges.
    return { user: localUser, friendship: present(existing), alreadyFriends: true };
  }

  friends.upsert({
    userId: localUser.id,
    friendId: fromId || `remote:${host}:${name}`,
    friendUsername: name,
    friendHost: host,
    status: 'pending',
    direction: 'incoming',
  });

  log.info('friend request received', { from: name, host, for: target });
  return { user: localUser, friendship: present(friends.find(localUser.id, name)), alreadyFriends: false };
}

/**
 * Accept a pending incoming request and tell the requester's server.
 * The notification goes through the outbox, so it lands even if their machine is
 * asleep right now.
 */
async function acceptFriendship(user, friendUsername) {
  const name = validate.username(friendUsername, 'username');
  const record = friends.find(user.id, name);

  if (!record) {
    throw notFound(`You have no friend request from ${name}.`, {
      code: Codes.FRIEND_NOT_FOUND,
      hint: 'They may have withdrawn it, or it never arrived. Ask them to send it again.',
    });
  }
  if (record.status === 'accepted') {
    return { friendship: present(record), alreadyAccepted: true, delivered: true, queued: false };
  }

  friends.setStatus(user.id, name, 'accepted');

  const delivery = await federation.deliver(record.friend_host, 'friend-response', {
    fromUsername: user.username,
    fromHost: identity.reachableUrl(),
    toUsername: name,
    action: 'accept',
  });

  if (delivery.queued) {
    friends.setLastError(user.id, name, 'Waiting to notify their server that you accepted.');
  } else if (delivery.delivered) {
    friends.setLastError(user.id, name, null);
  }

  log.info('friend request accepted', { friend: name, delivered: delivery.delivered, queued: delivery.queued });

  return {
    friendship: present(friends.find(user.id, name)),
    delivered: delivery.delivered,
    queued: delivery.queued,
    ...(delivery.queued
      ? { warning: `You are now friends here, but ${name}'s server could not be reached yet.`,
          hint: 'They will see the acceptance as soon as their machine is back online.' }
      : {}),
  };
}

async function rejectFriendship(user, friendUsername) {
  const name = validate.username(friendUsername, 'username');
  const record = friends.find(user.id, name);
  if (!record) {
    throw notFound(`You have no friend request from ${name}.`, { code: Codes.FRIEND_NOT_FOUND });
  }

  friends.setStatus(user.id, name, 'rejected');
  // Best-effort: the requester does not need to know urgently, and never retried.
  federation
    .sendFriendResponse(record.friend_host, {
      fromUsername: user.username,
      fromHost: identity.reachableUrl(),
      toUsername: name,
      action: 'reject',
    })
    .catch(err => log.debug('could not deliver rejection', { peer: record.friend_host, reason: err.message }));

  return { friendship: present(friends.find(user.id, name)) };
}

/** Apply a response that came back from the peer we originally asked. */
function receiveResponse({ fromUsername, toUsername, action }) {
  const responder = validate.username(fromUsername, 'fromUsername');
  const target = validate.username(toUsername, 'toUsername');
  validate.oneOf(action, 'action', ['accept', 'reject']);

  const localUser = users.findByUsernameLoose(target);
  if (!localUser) {
    throw notFound(`No user named "${target}" exists on this server.`, { code: Codes.PEER_USER_NOT_FOUND });
  }

  const record = friends.find(localUser.id, responder);
  if (!record) {
    throw notFound('No matching outgoing friend request.', {
      code: Codes.FRIEND_NOT_FOUND,
      hint: 'The request may have been removed on this side.',
    });
  }

  friends.setStatus(localUser.id, responder, action === 'accept' ? 'accepted' : 'rejected');
  friends.setLastError(localUser.id, responder, null);

  log.info('friend response received', { from: responder, action });
  return { user: localUser, friendship: present(friends.find(localUser.id, responder)), action };
}

function remove(user, friendUsername) {
  const name = validate.username(friendUsername, 'username');
  if (!friends.remove(user.id, name)) {
    throw notFound(`${name} is not in your friend list.`, { code: Codes.FRIEND_NOT_FOUND });
  }
  return { removed: name };
}

module.exports = {
  list, present, requestFriendship, receiveRequest,
  acceptFriendship, rejectFriendship, receiveResponse, remove,
};
