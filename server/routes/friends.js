const express = require('express');
const fetch = require('node-fetch');
const { authMiddleware } = require('../middleware/auth');
const {
  addFriend, getFriends, getPendingFriendRequests,
  updateFriendStatus, getFriendship, getUserByUsername,
} = require('../db');

const router = express.Router();

// Build headers for peer fetch calls
function peerHeaders(peerHost) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'SpockChat/2.1.1' };
  // localhost.run tunnels don't need special headers — SSH tunnel is transparent
  // localtunnel.me tunnels need bypass header (for users still on old setup)
  if (peerHost.includes('.loca.lt')) headers['bypass-tunnel-reminder'] = 'true';
  return headers;
}

// GET /api/friends
router.get('/', authMiddleware, (req, res) => {
  res.json({ friends: getFriends(req.user.id) });
});

// GET /api/friends/pending
router.get('/pending', authMiddleware, (req, res) => {
  res.json({ requests: getPendingFriendRequests(req.user.id) });
});

// POST /api/friends/add
router.post('/add', authMiddleware, async (req, res) => {
  let { peerHost, peerUsername } = req.body;
  if (!peerHost || !peerUsername) {
    return res.status(400).json({ error: 'peerHost and peerUsername are required' });
  }
  if (peerUsername === req.user.username) {
    return res.status(400).json({ error: 'Cannot add yourself' });
  }

  peerHost = peerHost.replace(/\/$/, ''); // strip trailing slash

  const existing = getFriendship(req.user.id, peerUsername);
  if (existing) {
    return res.status(409).json({ error: 'Friend request already sent or friendship exists' });
  }

  // Verify the user exists on the peer server
  let friendId;
  try {
    const lookupRes = await fetch(
      `${peerHost}/api/federation/lookup/${encodeURIComponent(peerUsername)}`,
      { headers: peerHeaders(peerHost), timeout: 10000 }
    );
    if (!lookupRes.ok) {
      return res.status(404).json({
        error: `User "${peerUsername}" not found on ${peerHost}`,
        hint: 'Double-check the username. Make sure their SpockChat server is running.',
      });
    }
    const data = await lookupRes.json();
    friendId = data.id || ('remote-' + Date.now());
  } catch (err) {
    const isSSHTunnel = peerHost.includes('.lhr.life');
    return res.status(503).json({
      error: `Cannot reach ${peerHost}: ${err.message}`,
      hint: isSSHTunnel
        ? 'The tunnel URL may have expired. Ask your friend to restart the tunnel and share the new URL.'
        : 'Make sure both machines are on the same network and SpockChat is running on port 3000. Check Windows Firewall if needed.',
    });
  }

  // Send friend request to their server
  try {
    const myHost = getMyHost(req);
    const reqRes = await fetch(`${peerHost}/api/federation/friend-request`, {
      method: 'POST',
      headers: peerHeaders(peerHost),
      body: JSON.stringify({
        fromUsername: req.user.username,
        fromId: req.user.id,
        fromHost: myHost,
        toUsername: peerUsername,
      }),
      timeout: 10000,
    });

    if (!reqRes.ok) {
      const err = await reqRes.json().catch(() => ({}));
      return res.status(400).json({ error: err.error || 'Peer server rejected the request' });
    }
  } catch (err) {
    return res.status(503).json({
      error: `Connected to peer but request delivery failed: ${err.message}`,
    });
  }

  const friendship = addFriend(req.user.id, friendId, peerUsername, peerHost, 'pending');
  res.json({ friendship });
});

// POST /api/friends/:username/respond
router.post('/:username/respond', authMiddleware, (req, res) => {
  const { action } = req.body;
  if (!['accept', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Action must be accept or reject' });
  }
  updateFriendStatus(req.user.id, req.params.username, action === 'accept' ? 'accepted' : 'rejected');
  res.json({ success: true });
});

// ─── FEDERATION (called by peer SpockChat servers) ────────────────────────────

// POST /api/federation/friend-request
router.post('/federation/friend-request', (req, res) => {
  const { fromUsername, fromId, fromHost, toUsername } = req.body;
  if (!fromUsername || !fromId || !fromHost || !toUsername) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const targetUser = getUserByUsername(toUsername);
  if (!targetUser) {
    return res.status(404).json({ error: `User "${toUsername}" not found on this server` });
  }
  const existing = getFriendship(targetUser.id, fromUsername);
  if (existing) return res.status(409).json({ error: 'Request already exists' });

  addFriend(targetUser.id, fromId, fromUsername, fromHost, 'pending');

  // Real-time notification to the target user
  const io = req.app.get('io');
  const connectedUsers = req.app.get('connectedUsers');
  const socketId = connectedUsers?.get(toUsername);
  if (socketId) io.to(socketId).emit('friend:request', { fromUsername, fromHost });

  res.json({ success: true });
});

// GET /api/federation/lookup/:username
router.get('/federation/lookup/:username', (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, username: user.username });
});

// ─── HELPER ──────────────────────────────────────────────────────────────────

function getMyHost(req) {
  const forwarded = req.headers['x-forwarded-host'];
  const proto = req.headers['x-forwarded-proto'] || 'http';
  if (forwarded) return `${proto}://${forwarded}`;
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return `http://${net.address}:${process.env.PORT || 3000}`;
      }
    }
  }
  return `http://localhost:${process.env.PORT || 3000}`;
}

module.exports = router;
