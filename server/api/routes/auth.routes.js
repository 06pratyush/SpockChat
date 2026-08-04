const express = require('express');
const authService = require('../../services/auth.service');
const { requireAuth } = require('../middleware/auth');
const { rateLimit, refund } = require('../middleware/rate-limit');
const { asyncHandler } = require('../middleware/context');

const router = express.Router();

// Registration and login are the two endpoints worth brute-forcing, and bcrypt
// at cost 12 makes each attempt expensive for us as well as for the attacker.
const authLimit = rateLimit('auth', {
  message: 'Too many sign-in attempts from this address. Wait a moment and try again.',
});

router.post('/register', authLimit, asyncHandler(async (req, res) => {
  const result = await authService.register(req.body || {});
  res.status(201).json(result);
}));

router.post('/login', authLimit, asyncHandler(async (req, res) => {
  const result = await authService.login(req.body || {});
  refund(req); // a correct password should not count against the limit
  res.json(result);
}));

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
