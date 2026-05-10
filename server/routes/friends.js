const express = require('express');
const fetch = require('node-fetch');
const { authMiddleware } = require('../middleware/auth');
const {
  addFriend, getFriends, getPendingFriendRequests,
  updateFriendStatus, getFriendship, getUserByUsername,
} = require('../db');

const router = express.Router();

// GET /api/friends — list accepted friends
router.get('/', authMiddleware, (req, res) => {
  const friends = getFriends(req.user.id);
  res.json({ friends });
});

// GET /api/friends/pending — incoming pending requests
router.get('/pending', authMiddleware, (req, res) => {
  const requests = getPendingFriendRequests(req.user.id);
  res.json({ requests });
});

// POST /api/friends/add — send a friend request to another SpockChat server
// Body: { peerHost: "http://192.168.1.x:3000", peerUsername: "alice" }
router.post('/add', authMiddleware, async (req, res) => {
  const { peerHost, peerUsername } = req.body;

  if (!peerHost || !peerUsername) {
    return res.status(400).json({ error: 'peerHost and peerUsername required' });
  }
  if (peerUsername === req.user.username) {
    return res.status(400).json({ error: 'Cannot add yourself' });
  }

  const existing = getFriendship(req.user.id, peerUsername);
  if (existing) {
    return res.status(409).json({ error: 'Friend request already exists' });
  }

  // Verify the peer exists and send them a request
  const myHost = `http://${getLocalIP()}:${process.env.PORT || 3000}`;

  try {
    const response = await fetch(`${peerHost}/api/federation/friend-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromUsername: req.user.username,
        fromId: req.user.id,
        fromHost: myHost,
        toUsername: peerUsername,
      }),
      timeout: 5000,
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(400).json({ error: err.error || 'Peer server rejected request' });
    }

    // Store locally as pending
    const friendship = addFriend(req.user.id, 'pending-' + Date.now(), peerUsername, peerHost, 'pending');
    res.json({ friendship });
  } catch (err) {
    return res.status(503).json({ error: `Could not reach peer at ${peerHost}: ${err.message}` });
  }
});

// POST /api/friends/:username/respond — accept or reject a friend request
router.post('/:username/respond', authMiddleware, (req, res) => {
  const { action } = req.body;
  const { username } = req.params;

  if (!['accept', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Action must be accept or reject' });
  }

  const status = action === 'accept' ? 'accepted' : 'rejected';
  updateFriendStatus(req.user.id, username, status);
  res.json({ success: true, status });
});

// ─── FEDERATION ENDPOINT (called by peer servers) ────────────────────────────

// POST /api/federation/friend-request — receive request FROM another server
router.post('/federation/friend-request', (req, res) => {
  const { fromUsername, fromId, fromHost, toUsername } = req.body;

  if (!fromUsername || !fromId || !fromHost || !toUsername) {
    return res.status(400).json({ error: 'Missing federation fields' });
  }

  const targetUser = getUserByUsername(toUsername);
  if (!targetUser) {
    return res.status(404).json({ error: `User ${toUsername} not found on this server` });
  }

  const existing = getFriendship(targetUser.id, fromUsername);
  if (existing) {
    return res.status(409).json({ error: 'Request already exists' });
  }

  const friendship = addFriend(targetUser.id, fromId, fromUsername, fromHost, 'pending');

  // Notify the local user via socket if connected
  const io = req.app.get('io');
  const connectedUsers = req.app.get('connectedUsers');
  const socketId = connectedUsers.get(toUsername);
  if (socketId) {
    io.to(socketId).emit('friend:request', {
      fromUsername,
      fromHost,
    });
  }

  res.json({ success: true });
});

// GET /api/federation/lookup/:username — let peers verify a user exists
router.get('/federation/lookup/:username', (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, username: user.username });
});

// ─── UTILITY ─────────────────────────────────────────────────────────────────

function getLocalIP() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

module.exports = router;
