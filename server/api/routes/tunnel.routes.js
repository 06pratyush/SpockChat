const express = require('express');

const tunnelService = require('../../services/tunnel.service');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/context');

const router = express.Router();
router.use(requireAuth);

router.post('/start', asyncHandler(async (req, res) => {
  const result = await tunnelService.start();
  res.json(result);
}));

router.delete('/stop', (req, res) => {
  res.json(tunnelService.stop());
});

router.get('/status', (req, res) => {
  res.json(tunnelService.snapshot());
});

module.exports = router;
