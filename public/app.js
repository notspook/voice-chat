const API = '';
let socket = null;
let token = localStorage.getItem('token');
let currentUser = null;
let channels = [];
let currentChannel = null;
let currentView = null;
let localStream = null;
let screenStream = null;
let isMuted = false;
let isDeafened = false;
let pttMode = false;
let pttActive = false;
let isScreenSharing = false;
let peerConnections = {};
let peerUsers = {};
let localAnalyserInterval = null;
let remoteAnalysers = {};
let remoteAnalyserIntervals = {};
let connectedPeers = new Set();
let typingTimeout = null;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }
];

/* ====== AUTH ====== */
const authScreen = document.getElementById('auth-screen');
const appEl = document.getElementById('app');
const authForm = document.getElementById('auth-form');
const authUsername = document.getElementById('auth-username');
const authPassword = document.getElementById('auth-password');
const authBtn = document.getElementById('auth-btn');
const authError = document.getElementById('auth-error');
const authTabs = document.querySelectorAll('.auth-tab');
let authMode = 'login';

authTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    authTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    authMode = tab.dataset.tab;
    authBtn.textContent = authMode === 'login' ? 'Login' : 'Register';
    authError.textContent = '';
  });
});

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = authUsername.value.trim();
  const password = authPassword.value;
  if (!username || !password) return;
  authBtn.disabled = true;
  authBtn.textContent = '...';
  authError.textContent = '';
  try {
    const res = await fetch(`${API}/api/${authMode}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { authError.textContent = data.error; return; }
    token = data.token;
    localStorage.setItem('token', token);
    currentUser = data.user;
    initApp();
  } catch { authError.textContent = 'Connection error'; }
  finally { authBtn.disabled = false; authBtn.textContent = authMode === 'login' ? 'Login' : 'Register'; }
});

async function checkAuth() {
  if (!token) return false;
  try {
    const res = await fetch(`${API}/api/me`, { headers: { 'Authorization': token } });
    if (!res.ok) { localStorage.removeItem('token'); token = null; return false; }
    const data = await res.json();
    currentUser = data.user;
    return true;
  } catch { return false; }
}

/* ====== INIT ====== */
async function initApp() {
  authScreen.style.display = 'none';
  appEl.style.display = 'flex';
  renderUserInfo();

  const chRes = await fetch(`${API}/api/channels`);
  channels = await chRes.json();

  socket = io();
  socket.emit('auth', token);
  socket.on('authed', (user) => {
    if (!user) { logout(); return; }
    setupSocket();
    renderChannels();
    if (channels.length > 0) {
      const firstVoice = channels.find(c => c.type === 'voice');
      const firstText = channels.find(c => c.type === 'text');
      switchView(firstVoice || firstText);
    }
  });
}

function logout() {
  if (socket) socket.disconnect();
  localStorage.removeItem('token');
  cleanupVoice();
  location.reload();
}

document.getElementById('logout-btn').addEventListener('click', logout);

/* ====== USER INFO ====== */
function renderUserInfo() {
  const avatar = document.getElementById('user-avatar');
  avatar.style.background = currentUser.avatar_color || '#58a6ff';
  avatar.textContent = getInitials(currentUser.username);
  document.getElementById('user-name').textContent = currentUser.username;
}

function getInitials(name) {
  const p = name.trim().split(/\s+/);
  return p.length >= 2 ? (p[0][0] + p[1][0]).toUpperCase() : name.slice(0, 2).toUpperCase();
}

/* ====== CHANNELS ====== */
function renderChannels() {
  const voiceContainer = document.getElementById('voice-channels');
  const textContainer = document.getElementById('text-channels');
  voiceContainer.innerHTML = '';
  textContainer.innerHTML = '';
  channels.forEach(ch => {
    const el = document.createElement('div');
    el.className = 'channel-item';
    el.dataset.id = ch.id;
    el.dataset.type = ch.type;
    el.innerHTML = `<span class="ch-icon">${ch.type === 'voice' ? '🔊' : '💬'}</span><span class="ch-name">${ch.name}</span>`;
    el.addEventListener('click', () => switchView(ch));
    (ch.type === 'voice' ? voiceContainer : textContainer).appendChild(el);
  });
}

function switchView(channel) {
  if (currentChannel && currentChannel.id === channel.id) return;
  currentChannel = channel;
  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
  const item = document.querySelector(`.channel-item[data-id="${channel.id}"]`);
  if (item) item.classList.add('active');

  if (channel.type === 'voice') {
    switchToVoice(channel);
  } else {
    switchToChat(channel);
  }
}

/* ====== VOICE ====== */
let currentVoiceChannel = null;

async function switchToVoice(channel) {
  document.getElementById('chat-view').style.display = 'none';
  document.getElementById('voice-view').style.display = 'flex';
  currentView = 'voice';
  document.getElementById('voice-channel-name').textContent = channel.name;

  if (currentVoiceChannel && currentVoiceChannel.id !== channel.id) {
    cleanupVoice();
  }
  currentVoiceChannel = channel;

  if (!localStream) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true, sampleRate: 48000, channelCount: 2 },
        video: false
      });
      enumerateDevices();
      startLocalTalkingDetection();
    } catch { return; }
  }

  socket.emit('channels:join', channel.id);
}

function cleanupVoice() {
  Object.values(peerConnections).forEach(pc => pc.close());
  peerConnections = {};
  peerUsers = {};
  connectedPeers.clear();
  Object.values(remoteAnalyserIntervals).forEach(clearInterval);
  remoteAnalyserIntervals = {};
  Object.values(remoteAnalysers).forEach(a => a.ctx.close());
  remoteAnalysers = {};
  document.getElementById('voice-peer-grid').innerHTML = '';
  if (isScreenSharing) stopScreenShare();
  currentVoiceChannel = null;
}

socket.on('voice-users', (users) => {
  renderVoiceUsers(users);
  document.getElementById('voice-users-count').textContent = `${users.length} connected`;
  users.forEach(u => {
    if (u.id !== socket.id) {
      createVoiceTile(u.id, u.user);
      connectToPeer(u.id);
    }
  });
});

socket.on('voice-user-joined', (data) => {
  if (data.id === socket.id) return;
  createVoiceTile(data.id, data.user);
  connectToPeer(data.id);
  const users = document.querySelectorAll('.voice-user-tile').length;
  document.getElementById('voice-users-count').textContent = `${users} connected`;
});

socket.on('voice-user-left', (data) => {
  disconnectPeer(data.id);
  const tile = document.querySelector(`.voice-user-tile[data-id="${data.id}"]`);
  if (tile) tile.remove();
  const users = document.querySelectorAll('.voice-user-tile').length;
  document.getElementById('voice-users-count').textContent = `${users} connected`;
});

function renderVoiceUsers(users) {
  const grid = document.getElementById('voice-peer-grid');
  grid.innerHTML = '';
  users.forEach(u => {
    if (u.id !== socket.id) {
      createVoiceTile(u.id, u.user);
    }
  });
}

function createVoiceTile(id, user) {
  const existing = document.querySelector(`.voice-user-tile[data-id="${id}"]`);
  if (existing) return;
  const tile = document.createElement('div');
  tile.className = 'voice-user-tile';
  tile.dataset.id = id;
  const avatarColor = user.avatar_color || '#58a6ff';
  tile.innerHTML = `
    <div class="vu-avatar" style="background:${avatarColor}">${getInitials(user.username)}</div>
    <div class="vu-name">${user.username}</div>
    <div class="vu-indicators">
      <div class="vu-dot"></div>
      <div class="vu-muted">MUTED</div>
    </div>`;
  document.getElementById('voice-peer-grid').appendChild(tile);
}

async function connectToPeer(peerId) {
  if (peerConnections[peerId] || !localStream) return;
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peerConnections[peerId] = pc;

  localStream.getAudioTracks().forEach(track => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('voice-ice', { to: peerId, candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    const tile = document.querySelector(`.voice-user-tile[data-id="${peerId}"]`);
    if (!tile) return;
    let audio = tile.querySelector('audio');
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      tile.appendChild(audio);
    }
    audio.srcObject = e.streams[0];
    audio.play().catch(() => {});
    startRemoteTalkingDetection(peerId, e.streams[0]);
  };

  pc.onconnectionstatechange = () => {
    const ind = document.getElementById('connection-indicator');
    const txt = document.getElementById('connection-status-text');
    if (pc.connectionState === 'connected') {
      connectedPeers.add(peerId);
      ind.className = '';
      txt.textContent = `Connected (${connectedPeers.size} peer${connectedPeers.size !== 1 ? 's' : ''})`;
    } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      connectedPeers.delete(peerId);
      ind.className = 'warning';
      txt.textContent = `Reconnecting...`;
      setTimeout(() => connectToPeer(peerId), 2000);
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('voice-offer', { to: peerId, offer });
}

socket.on('voice-offer', async (data) => {
  if (!localStream) return;
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peerConnections[data.from] = pc;
  localStream.getAudioTracks().forEach(track => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('voice-ice', { to: data.from, candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    const tile = document.querySelector(`.voice-user-tile[data-id="${data.from}"]`);
    if (!tile) return;
    let audio = tile.querySelector('audio');
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      tile.appendChild(audio);
    }
    audio.srcObject = e.streams[0];
    audio.play().catch(() => {});
    startRemoteTalkingDetection(data.from, e.streams[0]);
  };

  pc.onconnectionstatechange = () => {
    const ind = document.getElementById('connection-indicator');
    const txt = document.getElementById('connection-status-text');
    if (pc.connectionState === 'connected') {
      connectedPeers.add(data.from);
      ind.className = '';
      txt.textContent = `Connected (${connectedPeers.size} peer${connectedPeers.size !== 1 ? 's' : ''})`;
    } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      connectedPeers.delete(data.from);
      ind.className = 'warning';
      txt.textContent = 'Reconnecting...';
    }
  };

  await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('voice-answer', { to: data.from, answer });
});

socket.on('voice-answer', async (data) => {
  const pc = peerConnections[data.from];
  if (pc && pc.localDescription && pc.localDescription.type === 'offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
  }
});

socket.on('voice-ice', async (data) => {
  const pc = peerConnections[data.from];
  if (pc && pc.remoteDescription) {
    await pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
  }
});

function disconnectPeer(peerId) {
  if (peerConnections[peerId]) {
    peerConnections[peerId].close();
    delete peerConnections[peerId];
  }
  connectedPeers.delete(peerId);
  stopRemoteTalkingDetection(peerId);
}

/* ====== TALKING DETECTION ====== */
function startLocalTalkingDetection() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(localStream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);
  if (localAnalyserInterval) clearInterval(localAnalyserInterval);
  localAnalyserInterval = setInterval(() => {
    if (!localStream || isDeafened) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const talking = avg > 15 && !isMuted && !pttActive;
    const tile = document.querySelector(`.voice-user-tile[data-id="local"]`);
    if (tile) tile.classList.toggle('talking', talking);
  }, 100);
}

function startRemoteTalkingDetection(peerId, stream) {
  if (remoteAnalyserIntervals[peerId]) clearInterval(remoteAnalyserIntervals[peerId]);
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);
  remoteAnalysers[peerId] = { ctx, analyser };
  remoteAnalyserIntervals[peerId] = setInterval(() => {
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const talking = avg > 12;
    const tile = document.querySelector(`.voice-user-tile[data-id="${peerId}"]`);
    if (tile) tile.classList.toggle('talking', talking);
  }, 100);
}

function stopRemoteTalkingDetection(peerId) {
  if (remoteAnalyserIntervals[peerId]) { clearInterval(remoteAnalyserIntervals[peerId]); delete remoteAnalyserIntervals[peerId]; }
  if (remoteAnalysers[peerId]) { remoteAnalysers[peerId].ctx.close(); delete remoteAnalysers[peerId]; }
}

/* ====== VOICE CONTROLS ====== */
const muteBtn = document.getElementById('mute-btn');
const deafenBtn = document.getElementById('deafen-btn');
const screenShareBtn = document.getElementById('screen-share-btn');
const pttBtn = document.getElementById('ptt-btn');
const micSelect = document.getElementById('mic-select');
const speakerSelect = document.getElementById('speaker-select');

muteBtn.addEventListener('click', () => {
  isMuted = !isMuted;
  if (localStream) localStream.getAudioTracks().forEach(t => (t.enabled = !isMuted));
  muteBtn.classList.toggle('active', isMuted);
  muteBtn.querySelector('.vc-label').textContent = isMuted ? 'Muted' : 'Mute';
  const tile = document.querySelector('.voice-user-tile[data-id="local"]');
  if (tile) tile.classList.toggle('muted', isMuted);
});

deafenBtn.addEventListener('click', () => {
  isDeafened = !isDeafened;
  deafenBtn.classList.toggle('active', isDeafened);
  deafenBtn.querySelector('.vc-label').textContent = isDeafened ? 'Deafened' : 'Deafen';
  if (isDeafened) {
    muteBtn.classList.add('active');
    muteBtn.querySelector('.vc-label').textContent = 'Muted';
    if (localStream) localStream.getAudioTracks().forEach(t => (t.enabled = false));
  } else {
    isMuted = false;
    muteBtn.classList.remove('active');
    muteBtn.querySelector('.vc-label').textContent = 'Mute';
    if (localStream) localStream.getAudioTracks().forEach(t => (t.enabled = true));
  }
});

pttBtn.addEventListener('click', () => {
  pttMode = !pttMode;
  pttBtn.classList.toggle('active', pttMode);
  pttBtn.querySelector('.vc-label').textContent = pttMode ? 'PTT On' : 'PTT';
  if (!pttMode && localStream) localStream.getAudioTracks().forEach(t => (t.enabled = !isMuted));
  pttActive = false;
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && pttMode && currentView === 'voice' && !e.repeat) {
    e.preventDefault();
    pttActive = true;
    if (localStream) localStream.getAudioTracks().forEach(t => (t.enabled = true));
    const tile = document.querySelector(`.voice-user-tile[data-id="local"]`);
    if (tile) tile.classList.add('talking');
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && pttMode) {
    pttActive = false;
    if (localStream) localStream.getAudioTracks().forEach(t => (t.enabled = !isMuted));
    const tile = document.querySelector(`.voice-user-tile[data-id="local"]`);
    if (tile) tile.classList.remove('talking');
  }
});

async function enumerateDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  micSelect.innerHTML = '';
  speakerSelect.innerHTML = '';
  const currentMic = localStream?.getAudioTracks()[0]?.getSettings().deviceId;
  devices.forEach(d => {
    if (d.kind === 'audioinput') {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Mic ${micSelect.length + 1}`;
      if (d.deviceId === currentMic) opt.selected = true;
      micSelect.appendChild(opt);
    }
    if (d.kind === 'audiooutput') {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Speaker ${speakerSelect.length + 1}`;
      speakerSelect.appendChild(opt);
    }
  });
}

navigator.mediaDevices.addEventListener('devicechange', enumerateDevices);

micSelect.addEventListener('change', async () => {
  if (!localStream) return;
  const oldStream = localStream;
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: micSelect.value ? { exact: micSelect.value } : undefined, noiseSuppression: true, echoCancellation: true },
    video: false
  });
  oldStream.getTracks().forEach(t => t.stop());
  Object.entries(peerConnections).forEach(([id, pc]) => {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
    if (sender) sender.replaceTrack(localStream.getAudioTracks()[0]);
  });
});

speakerSelect.addEventListener('change', () => {
  document.querySelectorAll('audio').forEach(el => {
    if (el.srcObject && typeof el.setSinkId === 'function') el.setSinkId(speakerSelect.value).catch(() => {});
  });
});

/* ====== SCREEN SHARE ====== */
screenShareBtn.addEventListener('click', () => {
  if (isScreenSharing) stopScreenShare();
  else startScreenShare();
});

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false
    });
    isScreenSharing = true;
    screenShareBtn.classList.add('active');
    screenShareBtn.querySelector('.vc-label').textContent = 'Stop';
    document.getElementById('local-screen-preview').style.display = 'flex';
    document.getElementById('local-screen-video').srcObject = screenStream;
    screenStream.getVideoTracks()[0].onended = stopScreenShare;
  } catch {}
}

function stopScreenShare() {
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  isScreenSharing = false;
  screenShareBtn.classList.remove('active');
  screenShareBtn.querySelector('.vc-label').textContent = 'Share';
  document.getElementById('local-screen-preview').style.display = 'none';
  document.getElementById('local-screen-video').srcObject = null;
}

document.getElementById('stop-screen-btn').addEventListener('click', stopScreenShare);

/* ====== CHAT ====== */
const chatView = document.getElementById('chat-view');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send-btn');
const chatTyping = document.getElementById('chat-typing');
let currentChatChannel = null;

async function switchToChat(channel) {
  document.getElementById('voice-view').style.display = 'none';
  chatView.style.display = 'flex';
  currentView = 'chat';
  currentChatChannel = channel;
  document.getElementById('chat-channel-name').textContent = channel.name;
  chatMessages.innerHTML = '';
  chatTyping.textContent = '';

  socket.emit('chat:join', channel.id);

  const res = await fetch(`${API}/api/channels/${channel.id}/messages`);
  const msgs = await res.json();
  msgs.forEach(msg => renderMessage(msg));
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderMessage(msg) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = `
    <div class="chat-msg-avatar" style="background:${msg.avatar_color || '#58a6ff'}">${getInitials(msg.username)}</div>
    <div class="chat-msg-body">
      <div class="chat-msg-header">
        <span class="chat-msg-user">${msg.username}</span>
        <span class="chat-msg-time">${formatTime(msg.created_at)}</span>
      </div>
      <div class="chat-msg-content">${escapeHtml(msg.content)}</div>
    </div>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function formatTime(dateStr) {
  const d = new Date(dateStr + 'Z');
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

socket.on('new-message', (msg) => {
  if (currentChatChannel && msg.channel_id === currentChatChannel.id) {
    renderMessage(msg);
  }
});

chatSendBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

chatInput.addEventListener('input', () => {
  if (!currentChatChannel) return;
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  socket.emit('typing', { channelId: currentChatChannel.id });
});

socket.on('typing', (data) => {
  if (!currentChatChannel) return;
  if (data.userId === currentUser.id) return;
  chatTyping.textContent = `${data.username} is typing...`;
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => { chatTyping.textContent = ''; }, 2000);
});

async function sendMessage() {
  const content = chatInput.value.trim();
  if (!content || !currentChatChannel || !token) return;
  chatInput.value = '';
  chatInput.style.height = 'auto';
  chatTyping.textContent = '';
  try {
    await fetch(`${API}/api/channels/${currentChatChannel.id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': token },
      body: JSON.stringify({ content })
    });
  } catch {}
}

/* ====== SETUP SOCKET ====== */
function setupSocket() {
  socket.on('voice-offer', async (data) => { /* handled above */ });
  socket.on('voice-answer', async (data) => { /* handled above */ });
  socket.on('voice-ice', async (data) => { /* handled above */ });
  socket.on('voice-users', (users) => { /* handled above */ });
  socket.on('voice-user-joined', (data) => { /* handled above */ });
  socket.on('voice-user-left', (data) => { /* handled above */ });
  socket.on('new-message', (msg) => { /* handled above */ });
  socket.on('typing', (data) => { /* handled above */ });
}

/* ====== START ====== */
(async () => {
  if (await checkAuth()) {
    initApp();
  } else {
    /* openid_token is not set or expired */
  }
})();
