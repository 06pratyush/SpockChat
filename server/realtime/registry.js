/**
 * A tiny façade over the realtime layer.
 *
 * HTTP routes need to push events ("you were invited", "a member joined") but
 * must not import the socket module directly — that would create a require cycle
 * (routes → socket → handlers → services → routes). The realtime layer registers
 * itself here at boot; before that, every call is a safe no-op, so unit tests can
 * exercise services without a socket server at all.
 */

let impl = null;

function register(implementation) { impl = implementation; }

/** Emit to everyone in a chat room. */
function toChat(chatId, event, payload) {
  impl?.toChat(chatId, event, payload);
}

/** Emit to every socket a username has open (all tabs, all devices). */
function toUser(username, event, payload) {
  impl?.toUser(username, event, payload);
}

/** Pull a user's live sockets into a chat room they just gained access to. */
function joinUserToChat(userId, chatId) {
  impl?.joinUserToChat(userId, chatId);
}

/** Kick off an AI reply for a message that mentioned it. */
function triggerAi(chat, message) {
  return impl?.triggerAi(chat, message);
}

const connectionCount = () => impl?.connectionCount() ?? 0;
const onlineUsernames = () => impl?.onlineUsernames() ?? [];
const isOnline = username => impl?.isOnline(username) ?? false;
const snapshot = () => impl?.snapshot() ?? { connections: 0, users: 0, online: [] };

module.exports = {
  register, toChat, toUser, joinUserToChat, triggerAi,
  connectionCount, onlineUsernames, isOnline, snapshot,
};
