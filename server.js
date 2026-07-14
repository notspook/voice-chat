const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { AccessToken } = require('livekit-server-sdk');

const db = new Database('data.db');
db.pragma('journal_mode=WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_color TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('voice','text')),
    position INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (channel_id) REFERENCES channels(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

const existingChannels = db.prepare('SELECT COUNT(*) as count FROM channels').get();
if (existingChannels.count === 0) {
  const insert = db.prepare('INSERT INTO channels (name, type, position) VALUES (?, ?, ?)');
  insert.run('General', 'voice', 0);
  insert.run('Music', 'voice', 1);
  insert.run('general-chat', 'text', 2);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const verify = crypto.scryptSync(password, salt, 64).toString('hex');
  return hash === verify;
}

function generateToken() {
  return crypto.randomBytes(48).toString('hex');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || username.length < 2) return res.status(400).json({ error: 'Username too short' });
  if (!password || password.length < 4) return res.status(400).json({ error: 'Password too short' });
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Username taken' });
  const colors = ['#f97583','#79c0ff','#56d364','#d2a8ff','#ffa657','#7ee787','#a5d6ff','#ff7b72','#bbf0d4','#f0883e'];
  const color = colors[Math.abs(crypto.randomBytes(1)[0]) % colors.length];
  db.prepare('INSERT INTO users (username, password_hash, avatar_color) VALUES (?, ?, ?)').run(username, hashPassword(password), color);
  const user = db.prepare('SELECT id, username, avatar_color FROM users WHERE username = ?').get(username);
  const token = generateToken();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);
  res.json({ token, user });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = generateToken();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);
  res.json({ token, user: { id: user.id, username: user.username, avatar_color: user.avatar_color } });
});

app.get('/api/me', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  const session = db.prepare('SELECT s.token, u.id, u.username, u.avatar_color FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(auth);
  if (!session) return res.status(401).json({ error: 'Invalid token' });
  res.json({ user: { id: session.id, username: session.username, avatar_color: session.avatar_color } });
});

app.get('/api/channels', (req, res) => {
  const channels = db.prepare('SELECT id, name, type, position FROM channels ORDER BY position').all();
  res.json(channels);
});

app.get('/api/channels/:id/messages', (req, res) => {
  const msgs = db.prepare('SELECT m.id, m.content, m.created_at, u.username, u.avatar_color FROM messages m JOIN users u ON u.id = m.user_id WHERE m.channel_id = ? ORDER BY m.created_at ASC LIMIT 100').all(req.params.id);
  res.json(msgs);
});

app.post('/api/channels/:id/messages', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  const session = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(auth);
  if (!session) return res.status(401).json({ error: 'Invalid token' });
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Empty message' });
  const result = db.prepare('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)').run(req.params.id, session.user_id, content.trim());
  const msg = db.prepare('SELECT m.id, m.content, m.created_at, u.username, u.avatar_color FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?').get(result.lastInsertRowid);
  io.to(`chat:${req.params.id}`).emit('new-message', msg);
  res.json(msg);
});

app.post('/api/livekit/token', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  const session = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(auth);
  if (!session) return res.status(401).json({ error: 'Invalid token' });
  const user = db.prepare('SELECT id, username, avatar_color FROM users WHERE id = ?').get(session.user_id);
  if (!user) return res.status(401).json({ error: 'User not found' });
  const { room } = req.body;
  if (!room) return res.status(400).json({ error: 'Room required' });
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: user.username,
    name: user.username,
    metadata: JSON.stringify({ username: user.username, avatar_color: user.avatar_color }),
  });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
  res.json({ token: at.toJwt(), url: process.env.LIVEKIT_URL });
});

io.on('connection', (socket) => {
  socket.on('auth', (token) => {
    const session = db.prepare('SELECT u.id, u.username, u.avatar_color FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);
    if (session) {
      socket.data.user = { id: session.id, username: session.username, avatar_color: session.avatar_color };
      socket.emit('authed', session);
    } else {
      socket.emit('authed', null);
    }
  });

  socket.on('chat:join', (channelId) => {
    socket.join(`chat:${channelId}`);
  });

  socket.on('typing', ({ channelId }) => {
    socket.to(`chat:${channelId}`).emit('typing', { userId: socket.data.user?.id, username: socket.data.user?.username });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
