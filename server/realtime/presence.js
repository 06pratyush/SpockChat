/**
 * Who is connected, and on how many sockets.
 *
 * The original stored `Map<username, socketId>` — a single socket per user. Open
 * SpockChat in two tabs and the second overwrote the first; close either one and
 * `delete(username)` removed the *only* entry, so the remaining tab silently
 * stopped receiving invites and friend requests. Presence is now a set of
 * sockets per user, and a user is offline only when the last one goes.
 */

class Presence {
  constructor() {
    this.byUsername = new Map(); // username → Set<socketId>
    this.byUserId = new Map();   // userId   → Set<socketId>
    this.sockets = new Map();    // socketId → { userId, username, connectedAt }
  }

  add(socketId, user) {
    if (!this.byUsername.has(user.username)) this.byUsername.set(user.username, new Set());
    if (!this.byUserId.has(user.id)) this.byUserId.set(user.id, new Set());

    this.byUsername.get(user.username).add(socketId);
    this.byUserId.get(user.id).add(socketId);
    this.sockets.set(socketId, { userId: user.id, username: user.username, connectedAt: Date.now() });

    return this.byUsername.get(user.username).size;
  }

  remove(socketId) {
    const entry = this.sockets.get(socketId);
    if (!entry) return { removed: false, remaining: 0 };

    this.sockets.delete(socketId);

    const byName = this.byUsername.get(entry.username);
    byName?.delete(socketId);
    if (byName && byName.size === 0) this.byUsername.delete(entry.username);

    const byId = this.byUserId.get(entry.userId);
    byId?.delete(socketId);
    if (byId && byId.size === 0) this.byUserId.delete(entry.userId);

    return { removed: true, remaining: byName?.size ?? 0, username: entry.username, userId: entry.userId };
  }

  socketIdsForUsername(username) {
    return [...(this.byUsername.get(username) || [])];
  }

  socketIdsForUserId(userId) {
    return [...(this.byUserId.get(userId) || [])];
  }

  isOnline(username) {
    return this.byUsername.has(username);
  }

  usernames() {
    return [...this.byUsername.keys()];
  }

  get connectionCount() {
    return this.sockets.size;
  }

  snapshot() {
    return {
      connections: this.sockets.size,
      users: this.byUsername.size,
      online: [...this.byUsername.entries()].map(([username, ids]) => ({ username, sockets: ids.size })),
    };
  }
}

module.exports = { Presence };
