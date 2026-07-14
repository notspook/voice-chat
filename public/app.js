const socket = io();
let localStream = null;
let screenStream = null;
let peerConnections = {};
let screenPeerConnections = {};
let userName = '';
let roomId = '';
let isMuted = false;
let isScreenSharing = false;

const joinScreen = document.getElementById('join-screen');
const roomScreen = document.getElementById('room-screen');
const joinBtn = document.getElementById('join-btn');
const leaveBtn = document.getElementById('leave-btn');
const displayNameInput = document.getElementById('display-name');
const roomNameInput = document.getElementById('room-name');
const roomLabel = document.getElementById('room-label');
const peerGrid = document.getElementById('peer-grid');
const micSelect = document.getElementById('mic-select');
const speakerSelect = document.getElementById('speaker-select');
const muteBtn = document.getElementById('mute-btn');
const screenShareBtn = document.getElementById('screen-share-btn');

async function getDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  micSelect.innerHTML = '';
  speakerSelect.innerHTML = '';
  devices.forEach(d => {
    if (d.kind === 'audioinput') {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Microphone ${micSelect.length + 1}`;
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
  return localStream;
}

function createPeerConnection(peerId, stream, isScreen = false) {
  const config = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };
  const pc = new RTCPeerConnection(config);
  const connections = isScreen ? screenPeerConnections : peerConnections;
  connections[peerId] = pc;

  if (stream) {
    stream.getTracks().forEach(track => {
      if (localStream) {
        pc.addTrack(track, stream);
      }
    });
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      const eventType = isScreen ? 'screen-share-ice' : 'ice-candidate';
      socket.emit(eventType, { to: peerId, candidate: e.candidate });
    }
  };

  pc.ontrack = (e) => {
    const container = isScreen
      ? getOrCreateScreenContainer(peerId)
      : getOrCreatePeerContainer(peerId, false);
    let videoEl = container.querySelector('video');
    if (!videoEl) {
      videoEl = document.createElement('video');
      videoEl.autoplay = true;
      videoEl.playsInline = true;
      container.appendChild(videoEl);

      if (!isScreen) {
        const audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        audioEl.style.display = 'none';
        container.appendChild(audioEl);
      }
    }
    if (e.streams[0]) {
      videoEl.srcObject = e.streams[0];
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      cleanupPeer(peerId, isScreen);
    }
  };

  return pc;
}

function getOrCreatePeerContainer(peerId, isLocal) {
  let container = document.querySelector(`.peer-video-container[data-peer="${peerId}"]`);
  if (!container) {
    container = document.createElement('div');
    container.className = `peer-video-container${isLocal ? ' local' : ''}`;
    container.dataset.peer = peerId;
    peerGrid.appendChild(container);
  }
  return container;
}

function getOrCreateScreenContainer(peerId) {
  let container = document.querySelector(`.peer-video-container[data-screen="${peerId}"]`);
  if (!container) {
    container = document.createElement('div');
    container.className = 'peer-video-container screen-share';
    container.dataset.screen = peerId;
    peerGrid.appendChild(container);
  }
  return container;
}

function cleanupPeer(peerId, isScreen = false) {
  const connections = isScreen ? screenPeerConnections : peerConnections;
  if (connections[peerId]) {
    connections[peerId].close();
    delete connections[peerId];
  }
  if (isScreen) {
    const el = document.querySelector(`[data-screen="${peerId}"]`);
    if (el) el.remove();
  } else {
    const el = document.querySelector(`[data-peer="${peerId}"]`);
    if (el && !el.classList.contains('local')) el.remove();
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
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  const eventType = isScreen ? 'screen-share-answer' : 'answer';
  socket.emit(eventType, { to: data.from, answer });
}

async function handleAnswer(data, isScreen = false) {
  const connections = isScreen ? screenPeerConnections : peerConnections;
  const pc = connections[data.from];
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
  }
}

async function handleIceCandidate(data, isScreen = false) {
  const connections = isScreen ? screenPeerConnections : peerConnections;
  const pc = connections[data.from];
  if (pc) {
    await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
  }
}

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60 }
      },
      audio: false
    });

    isScreenSharing = true;
    screenShareBtn.textContent = 'Stop Sharing';
    screenShareBtn.classList.add('screen-active');

    const peers = Object.keys(peerConnections);
    for (const peerId of peers) {
      await createAndSendOffer(peerId, true);
    }

    screenStream.getVideoTracks()[0].onended = () => {
      stopScreenShare();
    };

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

  const screenEls = document.querySelectorAll('[data-screen]');
  screenEls.forEach(el => el.remove());

  Object.keys(screenPeerConnections).forEach(peerId => {
    if (screenPeerConnections[peerId]) {
      screenPeerConnections[peerId].close();
      delete screenPeerConnections[peerId];
    }
  });
}

joinBtn.addEventListener('click', async () => {
  const name = displayNameInput.value.trim();
  const room = roomNameInput.value.trim();
  if (!name || !room) return;

  userName = name;
  roomId = room;

  try {
    await getDevices();
    await startLocalAudio();

    socket.emit('join-room', { roomId, userName });

    joinScreen.style.display = 'none';
    roomScreen.style.display = 'flex';
    roomLabel.textContent = `Room: ${room}`;

    const localContainer = getOrCreatePeerContainer('local', true);
    const nameLabel = document.createElement('div');
    nameLabel.className = 'peer-name';
    nameLabel.textContent = `${name} (you)`;
    localContainer.appendChild(nameLabel);

  } catch (err) {
    alert('Could not access microphone. Please allow microphone access.');
    console.error(err);
  }
});

leaveBtn.addEventListener('click', () => {
  socket.disconnect();
  location.reload();
});

muteBtn.addEventListener('click', () => {
  if (localStream) {
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(t => (t.enabled = !isMuted));
    muteBtn.textContent = isMuted ? 'Unmute' : 'Mute';
    muteBtn.classList.toggle('active', isMuted);
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
  if (!roomId) return;
  await startLocalAudio(micSelect.value);
  const peers = Object.keys(peerConnections);
  for (const peerId of peers) {
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
  document.querySelectorAll('video, audio').forEach(el => {
    if (el.srcObject && typeof el.setSinkId === 'function') {
      el.setSinkId(deviceId).catch(() => {});
    }
  });
});

socket.on('room-users', (users) => {
  users.forEach(u => {
    if (u.id !== socket.id) {
      const container = getOrCreatePeerContainer(u.id, false);
      const nameLabel = document.createElement('div');
      nameLabel.className = 'peer-name';
      nameLabel.textContent = u.name;
      container.appendChild(nameLabel);
      createAndSendOffer(u.id);
    }
  });
});

socket.on('user-joined', (data) => {
  const container = getOrCreatePeerContainer(data.id, false);
  const nameLabel = document.createElement('div');
  nameLabel.className = 'peer-name';
  nameLabel.textContent = data.name;
  container.appendChild(nameLabel);
  createAndSendOffer(data.id);
});

socket.on('user-left', (data) => {
  cleanupPeer(data.id);
  cleanupPeer(data.id, true);
});

socket.on('offer', (data) => handleOffer(data));
socket.on('answer', (data) => handleAnswer(data));
socket.on('ice-candidate', (data) => handleIceCandidate(data));

socket.on('screen-share-offer', (data) => handleOffer(data, true));
socket.on('screen-share-answer', (data) => handleAnswer(data, true));
socket.on('screen-share-ice', (data) => handleIceCandidate(data, true));
