/**
 * SpockChat Tunnel — SSH-based cross-network tunneling
 *
 * Uses system SSH (built into Windows 10+, macOS, Linux) to create a
 * reverse tunnel to localhost.run — zero npm packages, zero audit issues.
 *
 * How it works:
 *   ssh -R 80:localhost:3000 nokey@localhost.run
 * This gives a free public HTTPS URL like https://abc123.lhr.life
 */

const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const { authMiddleware } = require('../middleware/auth');

let tunnelProcess = null;
let tunnelUrl = null;

// POST /api/tunnel/start
router.post('/start', authMiddleware, async (req, res) => {
  // Already running — return existing URL
  if (tunnelProcess && tunnelUrl) {
    return res.json({ url: tunnelUrl, active: true });
  }

  const port = parseInt(process.env.PORT || 3000);

  try {
    const url = await openSSHTunnel(port);
    res.json({ url, active: true });
  } catch (err) {
    console.error('[Tunnel] Failed:', err.message);
    res.status(500).json({
      error: err.message,
      hint: err.hint || 'Make sure SSH is installed. On Windows, open PowerShell and run: ssh -V',
    });
  }
});

// DELETE /api/tunnel/stop
router.delete('/stop', authMiddleware, (req, res) => {
  stopTunnel();
  res.json({ active: false });
});

// GET /api/tunnel/status
router.get('/status', authMiddleware, (req, res) => {
  res.json({ active: !!tunnelProcess, url: tunnelUrl || null });
});

// ─── SSH TUNNEL LOGIC ────────────────────────────────────────────────────────

function openSSHTunnel(port) {
  return new Promise((resolve, reject) => {
    console.log(`[Tunnel] Opening SSH tunnel on port ${port}...`);

    // Primary: port 22 to localhost.run
    // Fallback: port 443 (bypasses firewalls that block 22)
    startSSH(port, 22)
      .then(resolve)
      .catch(() => {
        console.log('[Tunnel] Port 22 blocked, trying port 443...');
        return startSSH(port, 443);
      })
      .then(resolve)
      .catch(reject);
  });
}

function startSSH(port, sshPort) {
  return new Promise((resolve, reject) => {
    // Timeout if no URL received in 30s
    const timeout = setTimeout(() => {
      child.kill();
      reject(Object.assign(
        new Error(`Tunnel timeout — could not connect on port ${sshPort}. Check your internet connection.`),
        { hint: 'Try again. If it keeps failing, check if SSH is installed: run "ssh -V" in your terminal.' }
      ));
    }, 30000);

    const args = [
      '-o', 'StrictHostKeyChecking=no',  // skip host key prompt
      '-o', 'ServerAliveInterval=30',     // keep alive every 30s
      '-o', 'ConnectTimeout=15',          // connection timeout
      '-o', 'ExitOnForwardFailure=yes',   // fail fast if port forward fails
      '-p', String(sshPort),              // SSH port (22 or 443 fallback)
      '-R', `80:localhost:${port}`,       // reverse tunnel: their 80 → our port
      'nokey@localhost.run',              // no account needed
    ];

    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    tunnelProcess = child;

    const parseUrl = (data) => {
      const text = data.toString();
      // localhost.run prints lines like: "abc123.lhr.life tunneled with tls termination"
      const match = text.match(/https?:\/\/[a-zA-Z0-9-]+\.lhr\.life/i)
        || text.match(/([a-zA-Z0-9-]+\.lhr\.life)/i);

      if (match) {
        const url = match[0].startsWith('http') ? match[0] : `https://${match[1]}`;
        clearTimeout(timeout);
        tunnelUrl = url;
        console.log(`[Tunnel] ✓ Public URL: ${url}`);
        resolve(url);
      }
    };

    child.stdout.on('data', parseUrl);
    child.stderr.on('data', parseUrl);

    child.on('exit', (code) => {
      tunnelProcess = null;
      tunnelUrl = null;
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        reject(new Error(`SSH exited with code ${code}. SSH may not be installed, or the tunnel service is unreachable.`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      tunnelProcess = null;
      tunnelUrl = null;
      if (err.code === 'ENOENT') {
        reject(Object.assign(
          new Error('SSH not found. Install OpenSSH to use cross-network tunneling.'),
          { hint: 'Windows: Settings → Apps → Optional Features → OpenSSH Client. Then restart SpockChat.' }
        ));
      } else {
        reject(err);
      }
    });
  });
}

function stopTunnel() {
  if (tunnelProcess) {
    tunnelProcess.kill();
    tunnelProcess = null;
    tunnelUrl = null;
    console.log('[Tunnel] Stopped');
  }
}

// Clean up tunnel when server shuts down
process.on('exit', stopTunnel);
process.on('SIGINT', () => { stopTunnel(); process.exit(0); });
process.on('SIGTERM', () => { stopTunnel(); process.exit(0); });

module.exports = router;
