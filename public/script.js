const socket = io();
let currentRoomId = null;
let myNickname = '';
let localStream = null;
let isMuted = false;
let peers = new Map(); // peerId → RTCPeerConnection

// ==================== UI helpers ====================
function updateRoomsList(rooms) {
  const container = document.getElementById('rooms-list');
  container.innerHTML = rooms.map(room => `
    <div onclick="joinRoom('${room.id}')" class="px-3 py-2 hover:bg-zinc-700 rounded-2xl cursor-pointer flex justify-between items-center">
      <span class="truncate">${room.name}</span>
      <span class="text-xs bg-zinc-700 px-2 py-0.5 rounded-full">${room.userCount}</span>
    </div>
  `).join('') || '<p class="text-zinc-400 px-3">Комнат пока нет</p>';
}

function updateRoomUsers(users) {
  const container = document.getElementById('room-users');
  container.innerHTML = users.map(u => `
    <div class="flex items-center gap-2 px-3 py-2 bg-zinc-700 rounded-2xl">
      👤 <span>${u.nickname}</span>
    </div>
  `).join('');
}

function updateVoiceUsers(voiceIds, allUsers) {
  const container = document.getElementById('voice-users');
  const map = new Map(allUsers.map(u => [u.nickname, u])); // упрощено
  container.innerHTML = voiceIds.map(id => {
    // В реальной реализации лучше хранить nickname по id, но для простоты
    const user = Array.from(document.querySelectorAll('#room-users span')).find(s => s.textContent.includes(id)) || {textContent: 'Пользователь'};
    return `<div class="flex items-center gap-2 px-3 py-2 bg-emerald-900/30 rounded-2xl text-emerald-400">🎤 ${user.textContent}</div>`;
  }).join('') || '<p class="text-zinc-400 text-sm">Никто не в голосе</p>';
}

// ==================== WebRTC ====================
const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection(config);

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('ice-candidate', { targetId: peerId, candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    const audio = document.createElement('audio');
    audio.srcObject = e.streams[0];
    audio.autoplay = true;
    audio.style.display = 'none';
    document.body.appendChild(audio);
  };

  peers.set(peerId, pc);
  return pc;
}

// ==================== Голосовые события ====================
socket.on('current-voice-users', (userIds) => {
  userIds.forEach(async (peerId) => {
    if (peers.has(peerId)) return;
    const pc = createPeerConnection(peerId);
    if (localStream) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { targetId: peerId, sdp: offer });
  });
});

socket.on('offer-received', async ({ from, sdp }) => {
  let pc = peers.get(from);
  if (!pc) pc = createPeerConnection(from);

  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  await pc.setRemoteDescription(sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { targetId: from, sdp: answer });
});

socket.on('answer-received', async ({ from, sdp }) => {
  const pc = peers.get(from);
  if (pc) await pc.setRemoteDescription(sdp);
});

socket.on('ice-candidate-received', ({ from, candidate }) => {
  const pc = peers.get(from);
  if (pc) pc.addIceCandidate(candidate);
});

socket.on('user-joined-voice', () => {
  // Новый пользователь уже отправил offers, нам ничего делать не нужно
});

socket.on('user-left-voice', ({ id }) => {
  const pc = peers.get(id);
  if (pc) {
    pc.close();
    peers.delete(id);
  }
});

// ==================== Основная логика ====================
function showCreateModal() { document.getElementById('create-modal').classList.remove('hidden'); }
function hideCreateModal() { document.getElementById('create-modal').classList.add('hidden'); }

async function createRoom() {
  const name = document.getElementById('room-name-input').value.trim();
  if (!name) return;
  socket.emit('create-room', { roomName: name });
  hideCreateModal();
}

function joinRoom(roomId) {
  if (!myNickname) {
    myNickname = prompt('Введите ваш никнейм (например: Alex)') || 'Гость' + Math.floor(Math.random()*100);
    document.getElementById('my-nickname').textContent = myNickname;
  }
  socket.emit('join-room', { roomId, nickname: myNickname });
}

function sendMessage() {
  const input = document.getElementById('message-input');
  if (!currentRoomId || !input.value.trim()) return;
  socket.emit('send-message', { roomId: currentRoomId, text: input.value });
  input.value = '';
}

function toggleVoice() {
  if (!currentRoomId) return;
  if (localStream) {
    leaveVoice();
  } else {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => {
        localStream = stream;
        document.getElementById('voice-btn').classList.add('hidden');
        document.getElementById('voice-controls').classList.remove('hidden');
        socket.emit('join-voice', { roomId: currentRoomId });
      })
      .catch(err => alert('Не удалось получить доступ к микрофону: ' + err));
  }
}

function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks()[0].enabled = !isMuted;
  document.getElementById('mute-text').textContent = isMuted ? 'Включить микрофон' : 'Выключить микрофон';
}

function leaveVoice() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  peers.forEach(pc => pc.close());
  peers.clear();
  document.getElementById('voice-controls').classList.add('hidden');
  document.getElementById('voice-btn').classList.remove('hidden');
  socket.emit('leave-voice');
}

function leaveRoom() {
  if (currentRoomId) {
    leaveVoice();
    socket.emit('leave-room');
    currentRoomId = null;
    document.getElementById('header').classList.add('hidden');
    document.getElementById('chat-messages').innerHTML = '';
  }
}

// ==================== Socket listeners ====================
socket.on('rooms-list', updateRoomsList);
socket.on('room-created', ({ roomId }) => {
  alert(`Комната создана! ID: ${roomId}`);
  socket.emit('get-rooms');
  joinRoom(roomId);
});

socket.on('joined-room', (data) => {
  currentRoomId = data.roomId;
  document.getElementById('header').classList.remove('hidden');
  document.getElementById('room-name').textContent = data.name;
  document.getElementById('chat-messages').innerHTML = data.messages.map(m => `
    <div class="message"><span class="text-emerald-400">${m.nickname}:</span> ${m.text}</div>
  `).join('');
  updateRoomUsers(data.users);
  updateVoiceUsers(data.voiceUsers, data.users);
});

socket.on('new-message', (msg) => {
  const chat = document.getElementById('chat-messages');
  chat.innerHTML += `<div class="message"><span class="text-emerald-400">${msg.nickname}:</span> ${msg.text}</div>`;
  chat.scrollTop = chat.scrollHeight;
});

socket.on('user-joined-room', (user) => {
  // Обновляем список участников
  socket.emit('get-rooms'); // или вручную добавить, но проще перезапросить
});

socket.on('user-left-room', () => socket.emit('get-rooms'));

// При загрузке страницы сразу просим список комнат
socket.emit('get-rooms');

// Автоматически обновляем список комнат каждые 5 сек
setInterval(() => { if (!currentRoomId) socket.emit('get-rooms'); }, 5000);

console.log('%cGrokCord загружен и готов к работе!', 'color: #10b981; font-size: 16px');