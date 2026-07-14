const socket = io();
let localStream = null;
let screenStream = null;
let peerConnections = {};
let screenPeerConnections = {};
let pendingCandidates = {};
let screenPendingCandidates = {};
let userName = '';
let isMuted = false;
let isScreenSharing = false;
let peers = {};
let remoteAnalysers = {};
let localAnalyserInterval = null;
let remoteAnalyserIntervals = {};

const APP_COLORS = [
  '#f97583', '#79c0ff', '#56d364', '#d2a8ff', '#ffa657',
  '#7ee787', '#a5d6ff', '#ff7b72', '#bbf0d4', '#f0883e'
];

function getColorForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return APP_COLORS[Math.abs(hash) % APP_COLORS.length];
}

function getInitials(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

const joinScreen = document.getElementById('join-screen');
const roomScreen = document.getElementById('room-screen');
const joinBtn = document.getElementById('join-btn');
const leaveBtn = document.getElementById('leave-btn');
const displayNameInput = document.getElementById('display-name');
const userCount = document.getElementById('user-count');
const peerGrid = document.getElementById('peer-grid');
const micSelect = document.getElementById('mic-select');
const speakerSelect = document.getElementById('speaker-select');
const muteBtn = document.getElementById('mute-btn');
const screenShareBtn = document.getElementById('screen-share-btn');
const localScreenPreview = document.getElementById('local-screen-preview');
const localScreenVideo = document.getElementById('local-screen-video');
const stopScreenBtn = document.getElementById('stop-screen-btn');

async function getDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  micSelect.innerHTML = '';
  speakerSelect.innerHTML = '';
  const currentMic = localStream?.getAudioTracks()[0]?.getSettings().deviceId;
  devices.forEach(d => {
    if (d.kind === 'audioinput') {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Microphone ${micSelect.length + 1}`;
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

async function startLocalAudio(deviceId) {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
  }
  const constraints = {
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
      sampleRate: 48000,
      channelCount: 2
    },
    video: false
  };
  localStream = await navigator.mediaDevices.getUserMedia(constraints);
  await getDevices();
  startLocalTalkingDetection();
  return localStream;
}

function startLocalTalkingDetection() {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(localStream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);

  if (localAnalyserInterval) clearInterval(localAnalyserInterval);
  localAnalyserInterval = setInterval(() => {
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const talking = avg > 15 && !isMuted;
    const tile = document.querySelector(`.peer-tile[data-peer="local"]`);
    if (tile) tile.classList.toggle('talking', talking);
  }, 100);
}

function startRemoteTalkingDetection(peerId, stream) {
  if (remoteAnalyserIntervals[peerId]) {
    clearInterval(remoteAnalyserIntervals[peerId]);
  }
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);
  remoteAnalysers[peerId] = { ctx: audioCtx, analyser };

  remoteAnalyserIntervals[peerId] = setInterval(() => {
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const talking = avg > 12;
    const tile = document.querySelector(`.peer-tile[data-peer="${peerId}"]`);
    if (tile) tile.classList.toggle('talking', talking);
  }, 100);
}

function stopRemoteTalkingDetection(peerId) {
  if (remoteAnalyserIntervals[peerId]) {
    clearInterval(remoteAnalyserIntervals[peerId]);
    delete remoteAnalyserIntervals[peerId];
  }
  if (remoteAnalysers[peerId]) {
    remoteAnalysers[peerId].ctx.close();
    delete remoteAnalysers[peerId];
  }
}

function getPending(peerId, isScreen) {
  const map = isScreen ? screenPendingCandidates : pendingCandidates;
  if (!map[peerId]) map[peerId] = [];
  return map[peerId];
}

function drainPending(peerId, isScreen) {
  const map = isScreen ? screenPendingCandidates : pendingCandidates;
  const candidates = map[peerId] || [];
  delete map[peerId];
  const connections = isScreen ? screenPeerConnections : peerConnections;
  const pc = connections[peerId];
  if (pc) {
    candidates.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {}));
  }
}

function createPeerConnection(peerId, stream, isScreen = false) {
  const config = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }
    ]
  };
  const pc = new RTCPeerConnection(config);
  const connections = isScreen ? screenPeerConnections : peerConnections;

  if (connections[peerId]) {
    connections[peerId].close();
  }
  connections[peerId] = pc;

  if (stream) {
    stream.getTracks().forEach(track => {
      pc.addTrack(track, stream);
    });
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      const eventType = isScreen ? 'screen-share-ice' : 'ice-candidate';
      socket.emit(eventType, { to: peerId, candidate: e.candidate });
    }
  };

  pc.ontrack = (e) => {
    if (isScreen) {
      handleScreenTrack(peerId, e.streams[0]);
    } else {
      handleAudioTrack(peerId, e.streams[0]);
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      cleanupPeer(peerId, isScreen);
    }
  };

  return pc;
}

function handleAudioTrack(peerId, stream) {
  const tile = document.querySelector(`.peer-tile[data-peer="${peerId}"]`);
  if (!tile) return;
  let audioEl = tile.querySelector('audio');
  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.style.display = 'none';
    tile.appendChild(audioEl);

    const speakerId = speakerSelect.value;
    if (speakerId && typeof audioEl.setSinkId === 'function') {
      audioEl.setSinkId(speakerId).catch(() => {});
    }
  }
  audioEl.srcObject = stream;
  audioEl.play().catch(() => {});

  startRemoteTalkingDetection(peerId, stream);
}

function handleScreenTrack(peerId, stream) {
  let container = document.querySelector(`.screen-share-container[data-screen="${peerId}"]`);
  if (!container) {
    container = document.createElement('div');
    container.className = 'screen-share-container';
    container.dataset.screen = peerId;
    const header = document.createElement('div');
    header.className = 'screen-share-header';
    const name = peers[peerId] || 'Someone';
    header.innerHTML = `<span>${name}'s screen</span>`;
    container.appendChild(header);
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.style.width = '100%';
    container.appendChild(video);
    peerGrid.parentNode.insertBefore(container, peerGrid.nextSibling);
  }
  container.classList.add('active');
  const video = container.querySelector('video');
  if (video) video.srcObject = stream;
}

function createPeerTile(id, name, isLocal) {
  const existing = document.querySelector(`.peer-tile[data-peer="${id}"]`);
  if (existing) return existing;

  const tile = document.createElement('div');
  tile.className = 'peer-tile';
  tile.dataset.peer = id;

  const avatar = document.createElement('div');
  avatar.className = 'peer-avatar';
  avatar.style.background = getColorForName(name);
  avatar.textContent = getInitials(name);

  const label = document.createElement('div');
  label.className = 'peer-name-label';
  label.textContent = isLocal ? `${name} (you)` : name;

  const indicators = document.createElement('div');
  indicators.className = 'peer-indicators';

  const talkingDot = document.createElement('div');
  talkingDot.className = 'talking-indicator';
  indicators.appendChild(talkingDot);

  const mutedBadge = document.createElement('div');
  mutedBadge.className = 'muted-indicator';
  mutedBadge.textContent = 'MUTED';
  indicators.appendChild(mutedBadge);

  const screenBadge = document.createElement('div');
  screenBadge.className = 'screen-share-badge';
  screenBadge.textContent = 'SHARING';
  indicators.appendChild(screenBadge);

  tile.appendChild(avatar);
  tile.appendChild(label);
  tile.appendChild(indicators);

  peerGrid.appendChild(tile);
  return tile;
}

function cleanupPeer(peerId, isScreen = false) {
  const connections = isScreen ? screenPeerConnections : peerConnections;
  if (connections[peerId]) {
    connections[peerId].close();
    delete connections[peerId];
  }
  if (isScreen) {
    const container = document.querySelector(`.screen-share-container[data-screen="${peerId}"]`);
    if (container) {
      container.querySelector('video').srcObject = null;
      container.classList.remove('active');
    }
  } else {
    stopRemoteTalkingDetection(peerId);
    const tile = document.querySelector(`.peer-tile[data-peer="${peerId}"]`);
    if (tile) tile.remove();
    delete peers[peerId];
  }
}

async function createAndSendOffer(peerId, isScreen = false) {
  const stream = isScreen ? screenStream : localStream;
  const pc = createPeerConnection(peerId, stream, isScreen);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const eventType = isScreen ? 'screen-share-offer' : 'offer';
  socket.emit(eventType, { to: peerId, offer });
}

async function handleOffer(data, isScreen = false) {
  const stream = isScreen ? screenStream : localStream;
  const pc = createPeerConnection(data.from, stream, isScreen);
  await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
  drainPending(data.from, isScreen);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  const eventType = isScreen ? 'screen-share-answer' : 'answer';
  socket.emit(eventType, { to: data.from, answer });
}

async function handleAnswer(data, isScreen = false) {
  const connections = isScreen ? screenPeerConnections : peerConnections;
  const pc = connections[data.from];
  if (pc && pc.localDescription && pc.localDescription.type === 'offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    drainPending(data.from, isScreen);
  }
}

async function handleIceCandidate(data, isScreen = false) {
  const connections = isScreen ? screenPeerConnections : peerConnections;
  const pc = connections[data.from];
  if (pc && pc.remoteDescription) {
    await pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
  } else if (pc) {
    getPending(data.from, isScreen).push(data.candidate);
  }
}

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 }
      },
      audio: false
    });

    isScreenSharing = true;
    screenShareBtn.textContent = 'Stop Sharing';
    screenShareBtn.classList.add('screen-active');

    localScreenVideo.srcObject = screenStream;
    localScreenPreview.style.display = 'flex';

    const peersList = Object.keys(peerConnections);
    for (const peerId of peersList) {
      await createAndSendOffer(peerId, true);
    }

    screenStream.getVideoTracks()[0].onended = () => {
      stopScreenShare();
    };

    const localTile = document.querySelector(`.peer-tile[data-peer="local"]`);
    if (localTile) localTile.classList.add('screen-sharing');

  } catch (err) {
    console.log('Screen share cancelled or failed:', err);
  }
}

function stopScreenShare() {
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  isScreenSharing = false;
  screenShareBtn.textContent = 'Share Screen';
  screenShareBtn.classList.remove('screen-active');
  localScreenPreview.style.display = 'none';
  localScreenVideo.srcObject = null;

  document.querySelectorAll('.screen-share-container').forEach(el => {
    const video = el.querySelector('video');
    if (video) video.srcObject = null;
    el.classList.remove('active');
  });

  Object.keys(screenPeerConnections).forEach(peerId => {
    if (screenPeerConnections[peerId]) {
      screenPeerConnections[peerId].close();
      delete screenPeerConnections[peerId];
    }
  });

  const localTile = document.querySelector(`.peer-tile[data-peer="local"]`);
  if (localTile) localTile.classList.remove('screen-sharing');
}

stopScreenBtn.addEventListener('click', stopScreenShare);

joinBtn.addEventListener('click', async () => {
  const name = displayNameInput.value.trim();
  if (!name) return;

  userName = name;

  try {
    await startLocalAudio();
    socket.emit('join', { userName });

    joinScreen.style.display = 'none';
    roomScreen.style.display = 'flex';

    createPeerTile('local', name, true);
  } catch (err) {
    alert('Could not access microphone. Please allow microphone access.');
    console.error(err);
  }
});

displayNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
});

leaveBtn.addEventListener('click', () => {
  if (localAnalyserInterval) clearInterval(localAnalyserInterval);
  Object.values(remoteAnalyserIntervals).forEach(clearInterval);
  socket.disconnect();
  location.reload();
});

muteBtn.addEventListener('click', () => {
  if (localStream) {
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(t => (t.enabled = !isMuted));
    muteBtn.textContent = isMuted ? 'Unmute' : 'Mute';
    muteBtn.classList.toggle('muted', isMuted);
    const localTile = document.querySelector(`.peer-tile[data-peer="local"]`);
    if (localTile) localTile.classList.toggle('muted', isMuted);
  }
});

screenShareBtn.addEventListener('click', () => {
  if (isScreenSharing) {
    stopScreenShare();
  } else {
    startScreenShare();
  }
});

micSelect.addEventListener('change', async () => {
  if (!localStream) return;
  await startLocalAudio(micSelect.value);
  const peersList = Object.keys(peerConnections);
  for (const peerId of peersList) {
    if (peerConnections[peerId]) {
      const pc = peerConnections[peerId];
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
      if (sender) {
        const newTrack = localStream.getAudioTracks()[0];
        await sender.replaceTrack(newTrack);
      }
    }
  }
});

speakerSelect.addEventListener('change', () => {
  const deviceId = speakerSelect.value;
  document.querySelectorAll('audio').forEach(el => {
    if (el.srcObject && typeof el.setSinkId === 'function') {
      el.setSinkId(deviceId).catch(() => {});
    }
  });
});

navigator.mediaDevices.addEventListener('devicechange', getDevices);

socket.on('room-users', (users) => {
  userCount.textContent = `${users.length} online`;
  users.forEach(u => {
    if (u.id !== socket.id) {
      peers[u.id] = u.name;
      createPeerTile(u.id, u.name, false);
      createAndSendOffer(u.id);
    }
  });
});

socket.on('user-joined', (data) => {
  const count = Object.keys(peers).length + 1;
  userCount.textContent = `${count} online`;
  peers[data.id] = data.name;
  createPeerTile(data.id, data.name, false);
});

socket.on('user-left', (data) => {
  const count = Math.max(0, Object.keys(peers).length - 1);
  userCount.textContent = `${count} online`;
  cleanupPeer(data.id);
  cleanupPeer(data.id, true);
});

socket.on('offer', (data) => handleOffer(data));
socket.on('answer', (data) => handleAnswer(data));
socket.on('ice-candidate', (data) => handleIceCandidate(data));

socket.on('screen-share-offer', (data) => handleOffer(data, true));
socket.on('screen-share-answer', (data) => handleAnswer(data, true));
socket.on('screen-share-ice', (data) => handleIceCandidate(data, true));
