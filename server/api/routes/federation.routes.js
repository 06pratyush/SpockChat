/**
 * Server-to-server endpoints, called by *other* SpockChat instances.
 *
 * ⚠️ The bug this file exists to fix: the original mounted the friends router at
 * both `/api/friends` and `/api/federation`, while the federation handlers were
 * declared *inside* it as `/federation/...`. The real paths were therefore
 * `/api/federation/federation/lookup/:username`, and the documented ones fell
 * through to the SPA fallback and returned `index.html` with HTTP 200. Every
 * friend add in the project failed with "Unexpected token '<'". Federation now
 * lives in its own router with its own mount point, and the contract is tested.
 *
 * These endpoints are unauthenticated by design — a peer has no account here.
 * They are therefore rate-limited, strictly validated, and write-only: nothing
 * here can read another user's data.
 */

const express = require('express');

const { config } = require('../../config');
const friendService = require('../../services/friend.service');
const users = require('../../db/repositories/users.repo');
const { rateLimit } = require('../middleware/rate-limit');
const { asyncHandler } = require('../middleware/context');
const { notFound, Codes } = require('../../core/errors');
const realtime = require('../../realtime/registry');

const router = express.Router();

router.use(rateLimit('federation', {
  message: 'Too many federation requests from this address.',
}));

/** Handshake: proves this address is a SpockChat server before anything else. */
router.get('/ping', (req, res) => {
  res.json({
    app: 'SpockChat',
    version: config.app.version,
    protocol: 1,
    time: Date.now(),
  });
});

/** Confirms a username exists here. Returns only the id and name — nothing else. */
router.get('/lookup/:username', (req, res) => {
  const user = users.findByUsernameLoose(req.params.username);
  if (!user) {
    throw notFound(`No user named "${req.params.username}" on this server.`, {
      code: Codes.PEER_USER_NOT_FOUND,
    });
  }
  res.json({ id: user.id, username: user.username });
});

/** Inbound friend request from a peer. */
router.post('/friend-request', asyncHandler(async (req, res) => {
  const result = friendService.receiveRequest(req.body || {});

  realtime.toUser(result.user.username, 'friend:request', {
    friendship: result.friendship,
    fromUsername: result.friendship.username,
    fromHost: result.friendship.host,
  });

  res.json({ success: true, alreadyFriends: result.alreadyFriends });
}));

/** Inbound accept/reject for a request we originally sent. */
router.post('/friend-response', asyncHandler(async (req, res) => {
  const result = friendService.receiveResponse(req.body || {});

  realtime.toUser(result.user.username, 'friend:response', {
    friendship: result.friendship,
    action: result.action,
  });

  res.json({ success: true });
}));

module.exports = router;
