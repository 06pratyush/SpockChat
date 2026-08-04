const express = require('express');

const friendService = require('../../services/friend.service');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/context');
const realtime = require('../../realtime/registry');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  res.json(friendService.list(req.user.id));
});

/**
 * Add a friend on another SpockChat server.
 *
 * Responds 202 when the peer could not be reached but the request was queued for
 * background retry — the user gets an honest "queued, we'll keep trying" instead
 * of a hard failure for what is usually a temporary outage.
 */
router.post('/add', asyncHandler(async (req, res) => {
  const result = await friendService.requestFriendship(req.user, req.body || {}, req);
  res.status(result.queued ? 202 : 201).json(result);
}));

router.post('/:username/accept', asyncHandler(async (req, res) => {
  const result = await friendService.acceptFriendship(req.user, req.params.username);
  res.status(result.queued ? 202 : 200).json(result);
}));

router.post('/:username/reject', asyncHandler(async (req, res) => {
  res.json(await friendService.rejectFriendship(req.user, req.params.username));
}));

/** Kept for compatibility with the original `{action}` body shape. */
router.post('/:username/respond', asyncHandler(async (req, res) => {
  const action = req.body?.action;
  const result = action === 'accept'
    ? await friendService.acceptFriendship(req.user, req.params.username)
    : await friendService.rejectFriendship(req.user, req.params.username);
  res.status(result.queued ? 202 : 200).json(result);
}));

router.delete('/:username', asyncHandler(async (req, res) => {
  const result = friendService.remove(req.user, req.params.username);
  realtime.toUser(req.user.username, 'friend:removed', result);
  res.json(result);
}));

module.exports = router;
