const express = require('express');
const bcrypt = require('bcryptjs');
const { createUser, getUserByUsername } = require('../db');
const { signToken } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (username.length < 3 || username.length > 24) {
    return res.status(400).json({ error: 'Username must be 3–24 characters' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Username: letters, numbers, underscores only' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const existing = getUserByUsername(username);
  if (existing) {
    return res.status(409).json({ error: 'Username already taken on this machine' });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const user = createUser(username, hash);
    const token = signToken(user.id);
    res.status(201).json({ token, user: { id: user.id, username: user.username } });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = getUserByUsername(username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signToken(user.id);
  res.json({ token, user: { id: user.id, username: user.username } });
});

// GET /api/auth/me — validate existing token
router.get('/me', require('../middleware/auth').authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
