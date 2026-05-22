const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');

let activeTunnel = null;
let tunnelUrl = null;

// POST /api/tunnel/start — open a public tunnel
router.post('/start', authMiddleware, async (req, res) => {
  // Already running — return existing URL
  if (activeTunnel && tunnelUrl) {
    return res.json({ url: tunnelUrl, active: true });
  }

  try {
    const localtunnel = require('localtunnel');
    const port = parseInt(process.env.PORT || 3000);

    console.log(`[Tunnel] Opening public tunnel on port ${port}...`);

    const tunnel = await localtunnel({ port });
    activeTunnel = tunnel;
    tunnelUrl = tunnel.url;

    console.log(`[Tunnel] ✓ Public URL: ${tunnel.url}`);

    tunnel.on('close', () => {
      console.log('[Tunnel] Closed');
      activeTunnel = null;
      tunnelUrl = null;
    });

    tunnel.on('error', (err) => {
      console.error('[Tunnel] Error:', err.message);
      activeTunnel = null;
      tunnelUrl = null;
    });

    res.json({ url: tunnel.url, active: true });
  } catch (err) {
    console.error('[Tunnel] Failed to start:', err.message);
    res.status(500).json({
      error: 'Could not open tunnel: ' + err.message,
      hint: 'Check your internet connection and try again.',
    });
  }
});

// DELETE /api/tunnel/stop — close the tunnel
router.delete('/stop', authMiddleware, (req, res) => {
  if (activeTunnel) {
    activeTunnel.close();
    activeTunnel = null;
    tunnelUrl = null;
  }
  res.json({ active: false });
});

// GET /api/tunnel/status — is a tunnel running?
router.get('/status', authMiddleware, (req, res) => {
  res.json({
    active: !!activeTunnel,
    url: tunnelUrl || null,
  });
});

module.exports = router;
