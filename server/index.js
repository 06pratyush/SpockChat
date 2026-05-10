require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { networkInterfaces } = require('os');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

// ─── SOCKET.IO ───────────────────────────────────────────────────────────────

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const registerSocketHandlers = require('./socket/handlers');
const connectedUsers = registerSocketHandlers(io);

// Share io and connectedUsers with routes
app.set('io', io);
app.set('connectedUsers', connectedUsers);

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());

// Serve static client files
app.use(express.static(path.join(__dirname, '..', 'client')));

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.use('/api/auth', require('./routes/auth'));
app.use('/api/chats', require('./routes/chats'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/ai', require('./routes/ai'));

// Federation endpoints (peer-to-peer calls from other SpockChat servers)
app.use('/api/federation', require('./routes/friends'));

// ─── SERVER INFO ENDPOINT ────────────────────────────────────────────────────

app.get('/api/info', (req, res) => {
  res.json({
    app: 'SpockChat',
    version: '1.0.0',
    localIP: getLocalIP(),
    port: PORT,
  });
});

// ─── CATCH-ALL → SPA ─────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// ─── START ───────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║             SpockChat v1.0.0             ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  Local:    http://localhost:${PORT}         ║`);
  console.log(`║  Network:  http://${ip}:${PORT}  ║`);
  console.log(`╚══════════════════════════════════════════╝`);
  console.log(`\n  Share your Network address with friends to connect.\n`);
});

function getLocalIP() {
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
