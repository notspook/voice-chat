const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { AccessToken } = require('livekit-server-sdk');

/* ============================================================
   DATABASE
   IMPORTANT: on Render, attach a persistent Disk and set
   DATA_DIR to its mount path (e.g. /var/data). Without it the
   filesystem is wiped on every deploy — which is why accounts
   were disappearing.
   ============================================================ */
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const db = new Database(path.join(DATA_DIR, 'data.db'));
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
    type TEXT NOT NULL CHECK(type IN ('voice','text','dm')),
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
  CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_id INTEGER,
    invite_code TEXT UNIQUE NOT NULL,
    icon TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS server_members (
    server_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (server_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS dm_participants (
    channel_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS dm_pairs (
    pair_key TEXT PRIMARY KEY,
    channel_id INTEGER NOT NULL
  );
`);

/* ---- migrations for older databases ---- */
function hasColumn(table, col){
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}
if (!hasColumn('users', 'profile')) db.exec(`ALTER TABLE users ADD COLUMN profile TEXT DEFAULT '{}'`);
if (!hasColumn('users', 'is_bot'))  db.exec(`ALTER TABLE users ADD COLUMN is_bot INTEGER DEFAULT 0`);
if (!hasColumn('channels', 'server_id')) db.exec(`ALTER TABLE channels ADD COLUMN server_id INTEGER`);

/* older CHECK constraint may not allow 'dm'; rebuild table if so */
const chSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='channels'`).get();
if (chSql && chSql.sql && !chSql.sql.includes("'dm'")) {
  db.exec(`
    BEGIN;
    CREATE TABLE channels_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('voice','text','dm')),
      position INTEGER DEFAULT 0,
      server_id INTEGER
    );
    INSERT INTO channels_new (id, name, type, position, server_id)
      SELECT id, name, type, position, server_id FROM channels;
    DROP TABLE channels;
    ALTER TABLE channels_new RENAME TO channels;
    COMMIT;
  `);
}

function generateInvite(){ return crypto.randomBytes(4).toString('hex'); }

/* ---- default server: adopt legacy channels, everyone is a member ---- */
let defaultServer = db.prepare(`SELECT * FROM servers ORDER BY id LIMIT 1`).get();
if (!defaultServer) {
  const r = db.prepare(`INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)`)
    .run('Ripple', null, generateInvite());
  defaultServer = db.prepare(`SELECT * FROM servers WHERE id = ?`).get(r.lastInsertRowid);
}
db.prepare(`UPDATE channels SET server_id = ? WHERE server_id IS NULL AND type != 'dm'`).run(defaultServer.id);
db.prepare(`INSERT OR IGNORE INTO server_members (server_id, user_id) SELECT ?, id FROM users WHERE is_bot = 0`).run(defaultServer.id);

const existingChannels = db.prepare(`SELECT COUNT(*) AS c FROM channels WHERE server_id = ?`).get(defaultServer.id);
if (existingChannels.c === 0) {
  const ins = db.prepare(`INSERT INTO channels (name, type, position, server_id) VALUES (?, ?, ?, ?)`);
  ins.run('General', 'voice', 0, defaultServer.id);
  ins.run('Music', 'voice', 1, defaultServer.id);
  ins.run('general-chat', 'text', 2, defaultServer.id);
}

/* ---- bot account for music feedback messages ---- */
let botUser = db.prepare(`SELECT * FROM users WHERE is_bot = 1 LIMIT 1`).get();
if (!botUser) {
  const name = db.prepare(`SELECT id FROM users WHERE username = 'Ripple'`).get() ? 'Ripple Music' : 'Ripple';
  db.prepare(`INSERT INTO users (username, password_hash, avatar_color, is_bot) VALUES (?, ?, ?, 1)`)
    .run(name, 'x:x', '#17B8A6');
  botUser = db.prepare(`SELECT * FROM users WHERE is_bot = 1 LIMIT 1`).get();
}

/* ============================================================
   AUTH HELPERS
   ============================================================ */
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
function generateToken() { return crypto.randomBytes(48).toString('hex'); }

function sessionUser(req) {
  const auth = req.headers.authorization;
  if (!auth) return null;
  return db.prepare(`
    SELECT u.id, u.username, u.avatar_color, u.profile FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(auth) || null;
}
function requireAuth(req, res) {
  const u = sessionUser(req);
  if (!u) { res.status(401).json({ error: 'Invalid token' }); return null; }
  return u;
}
function isServerMember(serverId, userId) {
  return !!db.prepare(`SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?`).get(serverId, userId);
}
function isDmParticipant(channelId, userId) {
  return !!db.prepare(`SELECT 1 FROM dm_participants WHERE channel_id = ? AND user_id = ?`).get(channelId, userId);
}
function canAccessChannel(channel, userId) {
  if (!channel) return false;
  if (channel.type === 'dm') return isDmParticipant(channel.id, userId);
  return isServerMember(channel.server_id, userId);
}
function publicUser(u){ return { id: u.id, username: u.username, avatar_color: u.avatar_color }; }

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   AUTH
   ============================================================ */
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || username.trim().length < 2) return res.status(400).json({ error: 'Username too short' });
  if (!password || password.length < 4) return res.status(400).json({ error: 'Password too short' });
  const uname = username.trim();
  const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(uname);
  if (existing) return res.status(409).json({ error: 'Username taken' });
  const colors = ['#f97583','#79c0ff','#56d364','#d2a8ff','#ffa657','#7ee787','#a5d6ff','#ff7b72','#bbf0d4','#f0883e'];
  const color = colors[crypto.randomBytes(1)[0] % colors.length];
  const r = db.prepare('INSERT INTO users (username, password_hash, avatar_color) VALUES (?, ?, ?)').run(uname, hashPassword(password), color);
  db.prepare('INSERT OR IGNORE INTO server_members (server_id, user_id) VALUES (?, ?)').run(defaultServer.id, r.lastInsertRowid);
  const user = db.prepare('SELECT id, username, avatar_color FROM users WHERE id = ?').get(r.lastInsertRowid);
  const token = generateToken();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);
  res.json({ token, user });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND is_bot = 0').get((username || '').trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  db.prepare('INSERT OR IGNORE INTO server_members (server_id, user_id) VALUES (?, ?)').run(defaultServer.id, user.id);
  const token = generateToken();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);
  res.json({ token, user: publicUser(user) });
});

app.get('/api/me', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  res.json({ user: { ...publicUser(u), profile: safeParse(u.profile) } });
});

function safeParse(s){ try { return JSON.parse(s || '{}') || {}; } catch { return {}; } }

/* ============================================================
   PROFILES (server-side so they sync across devices/apps)
   ============================================================ */
const PROFILE_LIMITS = { about: 300, nameColor: 16, nameFont: 12, banner: 64, bannerImage: 400000, avatar: 150000 };
function sanitizeProfileServer(p) {
  const s = {};
  if (!p || typeof p !== 'object') return s;
  if (typeof p.about === 'string') s.about = p.about.slice(0, PROFILE_LIMITS.about);
  if (typeof p.nameColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(p.nameColor)) s.nameColor = p.nameColor;
  if (typeof p.nameFont === 'string' && ['','display','serif','mono','cursive'].includes(p.nameFont)) s.nameFont = p.nameFont;
  if (typeof p.banner === 'string' && p.banner.length <= PROFILE_LIMITS.banner &&
      /^(#[0-9a-fA-F]{3,8}|linear-gradient\(135deg,#[0-9a-fA-F]{3,8},#[0-9a-fA-F]{3,8}\))$/.test(p.banner)) s.banner = p.banner;
  if (typeof p.bannerImage === 'string' && p.bannerImage.startsWith('data:image/') && p.bannerImage.length <= PROFILE_LIMITS.bannerImage) s.bannerImage = p.bannerImage;
  if (typeof p.avatar === 'string' && p.avatar.startsWith('data:image/') && p.avatar.length <= PROFILE_LIMITS.avatar) s.avatar = p.avatar;
  return s;
}

app.put('/api/profile', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const clean = sanitizeProfileServer(req.body || {});
  db.prepare('UPDATE users SET profile = ? WHERE id = ?').run(JSON.stringify(clean), u.id);
  io.emit('profile-updated', { userId: u.id, username: u.username, profile: clean });
  res.json({ ok: true, profile: clean });
});

app.get('/api/profiles', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const ids = String(req.query.ids || '').split(',').map(n => parseInt(n, 10)).filter(Boolean).slice(0, 100);
  if (!ids.length) return res.json({});
  const rows = db.prepare(`SELECT id, username, avatar_color, profile FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const out = {};
  rows.forEach(r => out[r.id] = { ...publicUser(r), profile: safeParse(r.profile) });
  res.json(out);
});

app.get('/api/users/search', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const rows = db.prepare(`SELECT id, username, avatar_color FROM users WHERE is_bot = 0 AND id != ? AND username LIKE ? COLLATE NOCASE ORDER BY username LIMIT 12`)
    .all(u.id, `%${q}%`);
  res.json(rows);
});

/* ============================================================
   SERVERS (guilds)
   ============================================================ */
app.get('/api/servers', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const rows = db.prepare(`
    SELECT s.id, s.name, s.owner_id, s.invite_code, s.icon FROM servers s
    JOIN server_members m ON m.server_id = s.id WHERE m.user_id = ? ORDER BY m.joined_at`).all(u.id);
  res.json(rows);
});

app.post('/api/servers', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (name.length < 2) return res.status(400).json({ error: 'Server name too short' });
  const r = db.prepare(`INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)`).run(name, u.id, generateInvite());
  const sid = r.lastInsertRowid;
  db.prepare(`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`).run(sid, u.id);
  const ins = db.prepare(`INSERT INTO channels (name, type, position, server_id) VALUES (?, ?, ?, ?)`);
  ins.run('General', 'voice', 0, sid);
  ins.run('general', 'text', 1, sid);
  res.json(db.prepare(`SELECT id, name, owner_id, invite_code, icon FROM servers WHERE id = ?`).get(sid));
});

app.post('/api/servers/join', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const code = String(req.body.code || '').trim().toLowerCase();
  const s = db.prepare(`SELECT * FROM servers WHERE invite_code = ?`).get(code);
  if (!s) return res.status(404).json({ error: 'Invalid invite code' });
  db.prepare(`INSERT OR IGNORE INTO server_members (server_id, user_id) VALUES (?, ?)`).run(s.id, u.id);
  io.emit('server-members-changed', { serverId: s.id });
  res.json({ id: s.id, name: s.name, owner_id: s.owner_id, invite_code: s.invite_code, icon: s.icon });
});

app.post('/api/servers/:id/leave', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sid = parseInt(req.params.id, 10);
  if (sid === defaultServer.id) return res.status(400).json({ error: "You can't leave the home server" });
  db.prepare(`DELETE FROM server_members WHERE server_id = ? AND user_id = ?`).run(sid, u.id);
  io.emit('server-members-changed', { serverId: sid });
  res.json({ ok: true });
});

app.get('/api/servers/:id/channels', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sid = parseInt(req.params.id, 10);
  if (!isServerMember(sid, u.id)) return res.status(403).json({ error: 'Not a member' });
  res.json(db.prepare(`SELECT id, name, type, position, server_id FROM channels WHERE server_id = ? ORDER BY position, id`).all(sid));
});

app.post('/api/servers/:id/channels', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sid = parseInt(req.params.id, 10);
  const s = db.prepare(`SELECT * FROM servers WHERE id = ?`).get(sid);
  if (!s) return res.status(404).json({ error: 'No such server' });
  if (s.owner_id !== u.id) return res.status(403).json({ error: 'Only the owner can add channels' });
  const name = String(req.body.name || '').trim().slice(0, 32);
  const type = req.body.type === 'voice' ? 'voice' : 'text';
  if (name.length < 1) return res.status(400).json({ error: 'Channel name required' });
  const pos = (db.prepare(`SELECT MAX(position) AS p FROM channels WHERE server_id = ?`).get(sid).p || 0) + 1;
  const r = db.prepare(`INSERT INTO channels (name, type, position, server_id) VALUES (?, ?, ?, ?)`).run(name, type, pos, sid);
  io.emit('channels-changed', { serverId: sid });
  res.json(db.prepare(`SELECT id, name, type, position, server_id FROM channels WHERE id = ?`).get(r.lastInsertRowid));
});

app.get('/api/servers/:id/members', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const sid = parseInt(req.params.id, 10);
  if (!isServerMember(sid, u.id)) return res.status(403).json({ error: 'Not a member' });
  const rows = db.prepare(`
    SELECT u.id, u.username, u.avatar_color, u.profile FROM server_members m
    JOIN users u ON u.id = m.user_id WHERE m.server_id = ? ORDER BY u.username COLLATE NOCASE`).all(sid);
  res.json(rows.map(r => ({ ...publicUser(r), profile: safeParse(r.profile) })));
});

/* ============================================================
   DMs
   ============================================================ */
function getOrCreateDm(a, b) {
  const key = [Math.min(a, b), Math.max(a, b)].join(':');
  const existing = db.prepare(`SELECT channel_id FROM dm_pairs WHERE pair_key = ?`).get(key);
  if (existing) return existing.channel_id;
  const r = db.prepare(`INSERT INTO channels (name, type, position, server_id) VALUES ('dm', 'dm', 0, NULL)`).run();
  const cid = r.lastInsertRowid;
  db.prepare(`INSERT INTO dm_pairs (pair_key, channel_id) VALUES (?, ?)`).run(key, cid);
  const ip = db.prepare(`INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?)`);
  ip.run(cid, a); ip.run(cid, b);
  return cid;
}
function dmOtherUser(channelId, userId) {
  return db.prepare(`
    SELECT u.id, u.username, u.avatar_color FROM dm_participants p
    JOIN users u ON u.id = p.user_id WHERE p.channel_id = ? AND p.user_id != ?`).get(channelId, userId);
}

app.get('/api/dms', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const rows = db.prepare(`
    SELECT p.channel_id AS channelId,
      (SELECT MAX(created_at) FROM messages WHERE channel_id = p.channel_id) AS last_at
    FROM dm_participants p WHERE p.user_id = ? ORDER BY last_at DESC`).all(u.id);
  res.json(rows.map(r => ({ channelId: r.channelId, last_at: r.last_at, other: dmOtherUser(r.channelId, u.id) })).filter(d => d.other));
});

app.post('/api/dms', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const otherId = parseInt(req.body.userId, 10);
  const other = db.prepare(`SELECT id, username, avatar_color FROM users WHERE id = ? AND is_bot = 0`).get(otherId);
  if (!other || other.id === u.id) return res.status(400).json({ error: 'Invalid user' });
  const cid = getOrCreateDm(u.id, other.id);
  res.json({ channelId: cid, other });
});

/* ============================================================
   MESSAGES (channels + DMs, with access checks)
   new-message now includes channel_id and user_id.
   ============================================================ */
function msgById(id) {
  return db.prepare(`
    SELECT m.id, m.channel_id, m.content, m.created_at, m.user_id, u.username, u.avatar_color
    FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`).get(id);
}

app.get('/api/channels/:id/messages', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const ch = db.prepare(`SELECT * FROM channels WHERE id = ?`).get(req.params.id);
  if (!canAccessChannel(ch, u.id)) return res.status(403).json({ error: 'No access' });
  const msgs = db.prepare(`
    SELECT * FROM (
      SELECT m.id, m.channel_id, m.content, m.created_at, m.user_id, u.username, u.avatar_color
      FROM messages m JOIN users u ON u.id = m.user_id
      WHERE m.channel_id = ? ORDER BY m.id DESC LIMIT 100
    ) ORDER BY id ASC`).all(ch.id);
  res.json(msgs);
});

function postMessage(channelId, userId, content) {
  const r = db.prepare(`INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)`).run(channelId, userId, content);
  const msg = msgById(r.lastInsertRowid);
  io.to(`chat:${channelId}`).emit('new-message', msg);
  // DMs also go to each participant's personal room so they get notified
  // even if they've never opened the conversation in this session.
  const ch = db.prepare(`SELECT type FROM channels WHERE id = ?`).get(channelId);
  if (ch && ch.type === 'dm') {
    db.prepare(`SELECT user_id FROM dm_participants WHERE channel_id = ?`).all(channelId)
      .forEach(p => io.to(`user:${p.user_id}`).emit('dm-message', msg));
  }
  return msg;
}

app.post('/api/channels/:id/messages', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const ch = db.prepare(`SELECT * FROM channels WHERE id = ?`).get(req.params.id);
  if (!canAccessChannel(ch, u.id)) return res.status(403).json({ error: 'No access' });
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Empty message' });
  if (content.length > 400000) return res.status(400).json({ error: 'Message too large' });
  res.json(postMessage(ch.id, u.id, content.trim()));
});

/* legacy: default-server channels */
app.get('/api/channels', (req, res) => {
  res.json(db.prepare(`SELECT id, name, type, position FROM channels WHERE server_id = ? ORDER BY position`).all(defaultServer.id));
});

/* ============================================================
   LIVEKIT TOKEN
   Fixed: toJwt() is async in livekit-server-sdk v2 — the old
   code returned a Promise, serialized as {}, so every client
   got an invalid token ("connection failed").
   Rooms are now addressed by channel id: "ch:<id>" or "dm:<id>"
   so same-named channels on different servers don't collide.
   ============================================================ */
function verifyRoomAccess(room, userId) {
  const m = /^(ch|dm):(\d+)$/.exec(String(room || ''));
  if (!m) return null;
  const ch = db.prepare(`SELECT * FROM channels WHERE id = ?`).get(parseInt(m[2], 10));
  if (!ch) return null;
  if (m[1] === 'dm' && ch.type !== 'dm') return null;
  if (m[1] === 'ch' && ch.type === 'dm') return null;
  return canAccessChannel(ch, userId) ? ch : null;
}

app.post('/api/livekit/token', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
    return res.status(500).json({ error: 'LiveKit is not configured on the server' });
  }
  const { room } = req.body;
  const ch = verifyRoomAccess(room, u.id);
  if (!ch) return res.status(403).json({ error: 'No access to that room' });
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: String(u.id),
    name: u.username,
    metadata: JSON.stringify({ id: u.id, username: u.username, avatar_color: u.avatar_color }),
  });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
  const token = await at.toJwt();
  res.json({ token, url: process.env.LIVEKIT_URL });
});

/* ============================================================
   MUSIC BOT
   A server-side LiveKit participant that streams YouTube /
   SoundCloud audio into any voice room. Requires optional deps:
   @livekit/rtc-node, ffmpeg-static, play-dl. If they're missing
   the rest of the app still works and !commands explain why.
   ============================================================ */
let rtc = null, ffmpegPath = null, play = null, musicReady = false;
try {
  rtc = require('@livekit/rtc-node');
  ffmpegPath = require('ffmpeg-static');
  play = require('play-dl');
  musicReady = true;
} catch (e) {
  console.warn('[music] disabled (missing deps):', e.message);
}
if (musicReady) {
  (async () => {
    try {
      const id = await play.getFreeClientID();
      await play.setToken({ soundcloud: { client_id: id } });
      console.log('[music] soundcloud client id acquired');
    } catch (e) { console.warn('[music] soundcloud id failed:', e.message); }
  })();
}

const { spawn } = require('child_process');
const musicSessions = new Map(); // room -> session

async function resolveUrl(input) {
  let url = String(input || '').trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const r = await fetch(url, { redirect: 'follow', method: 'GET', headers: { 'user-agent': 'Mozilla/5.0' } });
    try { r.body?.cancel?.(); } catch {}
    return r.url || url;
  } catch { return url; }
}

async function trackInfo(url) {
  if (play.yt_validate(url) === 'video') {
    const info = await play.video_basic_info(url);
    return { url, title: info.video_details.title, duration: info.video_details.durationInSec, source: 'youtube' };
  }
  if ((await play.so_validate(url)) === 'track') {
    const info = await play.soundcloud(url);
    return { url, title: info.name, duration: Math.round((info.durationInMs || 0) / 1000), source: 'soundcloud' };
  }
  return null;
}

async function getSession(room) {
  let s = musicSessions.get(room);
  if (s) return s;
  s = { room, queue: [], current: null, paused: false, rtcRoom: null, source: null, track: null, ff: null, input: null, feeding: false, feedbackChannelId: null };
  musicSessions.set(room, s);

  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: 'music-bot', name: botUser.username,
    metadata: JSON.stringify({ id: botUser.id, username: botUser.username, avatar_color: botUser.avatar_color, bot: true }),
  });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: false, canPublishData: true });
  const jwt = await at.toJwt();

  s.rtcRoom = new rtc.Room();
  await s.rtcRoom.connect(process.env.LIVEKIT_URL, jwt, { autoSubscribe: false, dynacast: false });
  s.source = new rtc.AudioSource(48000, 2, 1000);
  s.track = rtc.LocalAudioTrack.createAudioTrack('music', s.source);
  const opts = new rtc.TrackPublishOptions();
  opts.source = rtc.TrackSource.SOURCE_MICROPHONE;
  await s.rtcRoom.localParticipant.publishTrack(s.track, opts);

  s.rtcRoom.on(rtc.RoomEvent.ParticipantDisconnected, () => {
    if (s.rtcRoom && s.rtcRoom.remoteParticipants.size === 0) destroySession(room, 'Everyone left the voice channel.');
  });
  s.rtcRoom.on(rtc.RoomEvent.Disconnected, () => { musicSessions.delete(room); });
  return s;
}

function killPipeline(s) {
  try { s.input?.destroy?.(); } catch {}
  try { s.ff?.kill('SIGKILL'); } catch {}
  s.input = null; s.ff = null; s.feeding = false;
}

async function destroySession(room, reason) {
  const s = musicSessions.get(room);
  if (!s) return;
  musicSessions.delete(room);
  killPipeline(s);
  try { await s.rtcRoom?.disconnect(); } catch {}
  if (reason && s.feedbackChannelId) botSay(s.feedbackChannelId, `⏹ Music stopped — ${reason}`);
  broadcastMusicState({ ...s, current: null, queue: [] });
}

function botSay(channelId, text) { try { postMessage(channelId, botUser.id, text); } catch {} }

function fmtDur(sec) {
  if (!sec && sec !== 0) return '?:??';
  const m = Math.floor(sec / 60), ss = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${m}:${ss}`;
}

function broadcastMusicState(s) {
  const state = { room: s.room, current: s.current ? { title: s.current.title, duration: s.current.duration, requestedBy: s.current.requestedBy, source: s.current.source } : null, queue: s.queue.map(t => ({ title: t.title, requestedBy: t.requestedBy })), paused: s.paused };
  io.emit('music-state', state);
}

async function playNext(s) {
  killPipeline(s);
  s.current = s.queue.shift() || null;
  s.paused = false;
  broadcastMusicState(s);
  if (!s.current) return;
  const t = s.current;
  try {
    const st = await play.stream(t.url, { quality: 2 });
    s.input = st.stream;
    s.ff = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    s.input.pipe(s.ff.stdin);
    s.input.on('error', () => {});
    s.ff.stdin.on('error', () => {});
    if (s.feedbackChannelId) botSay(s.feedbackChannelId, `▶️ Now playing: **${t.title}** (${fmtDur(t.duration)}) — requested by ${t.requestedBy}`);
    feedLoop(s, s.ff.stdout).catch(() => {});
    s.ff.on('close', () => { if (musicSessions.get(s.room) === s && s.ff) { s.ff = null; playNext(s); } });
  } catch (e) {
    if (s.feedbackChannelId) botSay(s.feedbackChannelId, `⚠️ Couldn't play **${t.title}**: ${e.message}. Skipping.`);
    playNext(s);
  }
}

async function feedLoop(s, stdout) {
  s.feeding = true;
  const FRAME_SAMPLES = 4800; // 100 ms @ 48k
  const FRAME_BYTES = FRAME_SAMPLES * 2 /*ch*/ * 2 /*bytes*/;
  let buf = Buffer.alloc(0);
  for await (const chunk of stdout) {
    if (!s.feeding) return;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= FRAME_BYTES) {
      while (s.paused && s.feeding) await new Promise(r => setTimeout(r, 120));
      if (!s.feeding) return;
      const slice = buf.subarray(0, FRAME_BYTES);
      buf = buf.subarray(FRAME_BYTES);
      const data = new Int16Array(slice.buffer.slice(slice.byteOffset, slice.byteOffset + FRAME_BYTES));
      const frame = new rtc.AudioFrame(data, 48000, 2, FRAME_SAMPLES);
      await s.source.captureFrame(frame); // backpressure = real-time pacing
    }
  }
}

app.post('/api/music/command', async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { room, channelId, text } = req.body || {};
  const ch = db.prepare(`SELECT * FROM channels WHERE id = ?`).get(parseInt(channelId, 10));
  if (!ch || !canAccessChannel(ch, u.id)) return res.status(403).json({ error: 'No access' });
  res.json({ ok: true }); // respond immediately; feedback arrives as bot messages

  const say = (t) => botSay(ch.id, t);
  if (!musicReady) return say('🎵 Music isn’t set up on this server yet (missing @livekit/rtc-node / ffmpeg-static / play-dl).');

  const m = /^!(\w+)\s*(.*)$/s.exec(String(text || '').trim());
  if (!m) return;
  const cmd = m[1].toLowerCase(), arg = m[2].trim();

  const needRoom = () => {
    if (!verifyRoomAccess(room, u.id)) { say(`🎵 ${u.username}, join a voice channel first, then use !play.`); return null; }
    return room;
  };

  try {
    if (cmd === 'play' || cmd === 'p') {
      const r = needRoom(); if (!r) return;
      if (!arg) return say('Usage: `!play <youtube or soundcloud link>`');
      const url = await resolveUrl(arg);
      const info = await trackInfo(url);
      if (!info) return say(`⚠️ That doesn't look like a playable YouTube or SoundCloud link.`);
      info.requestedBy = u.username;
      const s = await getSession(r);
      s.feedbackChannelId = ch.id;
      s.queue.push(info);
      if (!s.current) playNext(s);
      else { say(`➕ Queued: **${info.title}** (${fmtDur(info.duration)}) — position ${s.queue.length}`); broadcastMusicState(s); }
    } else if (cmd === 'pause') {
      const s = musicSessions.get(room);
      if (!s || !s.current) return say('Nothing is playing.');
      s.paused = true; broadcastMusicState(s); say('⏸ Paused.');
    } else if (cmd === 'resume' || cmd === 'unpause') {
      const s = musicSessions.get(room);
      if (!s || !s.current) return say('Nothing is playing.');
      s.paused = false; broadcastMusicState(s); say('▶️ Resumed.');
    } else if (cmd === 'skip' || cmd === 's') {
      const s = musicSessions.get(room);
      if (!s || !s.current) return say('Nothing to skip.');
      say(`⏭ Skipped **${s.current.title}**.`);
      playNext(s);
    } else if (cmd === 'stop' || cmd === 'leave' || cmd === 'dc') {
      const s = musicSessions.get(room);
      if (!s) return say('The music bot is not in your channel.');
      await destroySession(room, null);
      say('⏹ Stopped and left the channel.');
    } else if (cmd === 'queue' || cmd === 'q' || cmd === 'np') {
      const s = musicSessions.get(room);
      if (!s || !s.current) return say('Queue is empty.');
      const lines = [`▶️ **${s.current.title}**${s.paused ? ' (paused)' : ''}`];
      s.queue.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. ${t.title} — ${t.requestedBy}`));
      if (s.queue.length > 10) lines.push(`…and ${s.queue.length - 10} more`);
      say(lines.join('\n'));
    } else if (cmd === 'help') {
      say('🎵 Music commands: `!play <link>` · `!pause` · `!resume` · `!skip` · `!stop` · `!queue`\nYouTube & SoundCloud links (shortened links are fine).');
    }
  } catch (e) {
    say(`⚠️ Music error: ${e.message}`);
  }
});

/* ============================================================
   SOCKETS — auth, chat, typing, presence/status, DM call rings
   ============================================================ */
const onlineCounts = new Map();  // userId -> socket count
const userStatuses = new Map();  // userId -> 'online' | 'idle' | 'dnd'

io.on('connection', (socket) => {
  socket.on('auth', (token) => {
    const session = db.prepare(`SELECT u.id, u.username, u.avatar_color FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
    if (session) {
      socket.data.user = { id: session.id, username: session.username, avatar_color: session.avatar_color };
      socket.join(`user:${session.id}`);
      const n = (onlineCounts.get(session.id) || 0) + 1;
      onlineCounts.set(session.id, n);
      if (n === 1) io.emit('presence', { userId: session.id, online: true });
      socket.emit('authed', session);
      socket.emit('presence-sync', {
        online: [...onlineCounts.keys()],
        statuses: Object.fromEntries(userStatuses),
      });
    } else {
      socket.emit('authed', null);
    }
  });

  socket.on('chat:join', (channelId) => {
    const u = socket.data.user; if (!u) return;
    const ch = db.prepare(`SELECT * FROM channels WHERE id = ?`).get(channelId);
    if (canAccessChannel(ch, u.id)) socket.join(`chat:${channelId}`);
  });

  socket.on('typing', ({ channelId }) => {
    const u = socket.data.user; if (!u) return;
    socket.to(`chat:${channelId}`).emit('typing', { userId: u.id, username: u.username, channelId });
  });

  socket.on('status:set', (status) => {
    const u = socket.data.user; if (!u) return;
    if (!['online', 'idle', 'dnd'].includes(status)) return;
    userStatuses.set(u.id, status);
    io.emit('status', { userId: u.id, status });
  });

  /* ---- DM call signaling ---- */
  socket.on('call:ring', ({ channelId }) => {
    const u = socket.data.user; if (!u) return;
    if (!isDmParticipant(channelId, u.id)) return;
    const other = dmOtherUser(channelId, u.id);
    if (!other) return;
    io.to(`user:${other.id}`).emit('call:incoming', { channelId, from: publicUser(u) });
  });
  socket.on('call:cancel', ({ channelId }) => {
    const u = socket.data.user; if (!u) return;
    const other = dmOtherUser(channelId, u.id);
    if (other) io.to(`user:${other.id}`).emit('call:cancelled', { channelId });
  });
  socket.on('call:accept', ({ channelId }) => {
    const u = socket.data.user; if (!u) return;
    const other = dmOtherUser(channelId, u.id);
    if (other) io.to(`user:${other.id}`).emit('call:accepted', { channelId });
  });
  socket.on('call:decline', ({ channelId }) => {
    const u = socket.data.user; if (!u) return;
    const other = dmOtherUser(channelId, u.id);
    if (other) io.to(`user:${other.id}`).emit('call:declined', { channelId });
  });

  socket.on('disconnect', () => {
    const u = socket.data.user; if (!u) return;
    const n = (onlineCounts.get(u.id) || 1) - 1;
    if (n <= 0) {
      onlineCounts.delete(u.id);
      userStatuses.delete(u.id);
      io.emit('presence', { userId: u.id, online: false });
    } else {
      onlineCounts.set(u.id, n);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Ripple running on http://localhost:${PORT}`);
  console.log(`[db] ${path.join(DATA_DIR, 'data.db')}${process.env.DATA_DIR ? ' (persistent)' : '  ⚠ set DATA_DIR to a persistent disk on Render or accounts vanish on redeploy'}`);
});
