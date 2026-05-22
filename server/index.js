require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { networkInterfaces } = require('os');

const app = express();
const server = http.createServer(app);
const PORT = parseInt(process.env.PORT || 3000);

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
const registerSocketHandlers = require('./socket/handlers');
const connectedUsers = registerSocketHandlers(io);
app.set('io', io);
app.set('connectedUsers', connectedUsers);

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'client')));

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/chats',      require('./routes/chats'));
app.use('/api/friends',    require('./routes/friends'));
app.use('/api/ai',         require('./routes/ai'));
app.use('/api/tunnel',     require('./routes/tunnel'));       // v2.1 — public tunneling
app.use('/api/federation', require('./routes/friends'));      // peer-to-peer federation

// ─── SERVER INFO ──────────────────────────────────────────────────────────────
app.get('/api/info', (req, res) => {
  res.json({ app: 'SpockChat', version: '2.1.0', localIP: getLocalIP(), port: PORT });
});

// ─── SPA FALLBACK ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// ─── START ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  const pad = '192.168.xxx.xxx'.length - ip.length;
  const padStr = ' '.repeat(Math.max(0, pad));

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║           SpockChat v2.1.0               ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  Local:    http://localhost:${PORT}         ║`);
  console.log(`║  Network:  http://${ip}:${PORT}${padStr}  ║`);
  console.log(`║  Public:   Click 🌐 in the sidebar        ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});

function getLocalIP() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}
