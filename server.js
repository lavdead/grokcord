const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Важно: обслуживаем статические файлы из папки public
app.use(express.static(path.join(__dirname, 'public')));

// Все остальные GET-запросы отдаём index.html (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

console.log('Сервер настроен для Railway');

// Хранилище комнат (in-memory)
const rooms = new Map(); // roomId → { name, users: Map<socketId, {nickname}>, messages: [], voiceUsers: Set<socketId> }

io.on('connection', (socket) => {
  console.log('✅ Пользователь подключился:', socket.id);

  // Получить список всех комнат
  socket.on('get-rooms', () => {
    const list = Array.from(rooms.entries()).map(([id, room]) => ({
      id,
      name: room.name,
      userCount: room.users.size
    }));
    socket.emit('rooms-list', list);
  });

  // Создать новую комнату
  socket.on('create-room', ({ roomName }) => {
    if (!roomName) return;
    const roomId = 'room-' + Math.random().toString(36).substring(2, 9).toUpperCase();
    rooms.set(roomId, {
      name: roomName,
      users: new Map(),
      messages: [],
      voiceUsers: new Set()
    });
    socket.emit('room-created', { roomId, name: roomName });
  });

  // Присоединиться к комнате
  socket.on('join-room', ({ roomId, nickname }) => {
    if (!rooms.has(roomId) || !nickname) return socket.emit('error', 'Комната не найдена');

    // Если уже был в другой комнате — выходим
    if (socket.currentRoom) leaveRoom(socket);

    socket.currentRoom = roomId;
    socket.nickname = nickname;
    socket.join(roomId);

    const room = rooms.get(roomId);
    room.users.set(socket.id, { nickname });

    // Отправляем текущее состояние новому пользователю
    socket.emit('joined-room', {
      roomId,
      name: room.name,
      users: Array.from(room.users.values()),
      messages: room.messages,
      voiceUsers: Array.from(room.voiceUsers)
    });

    // Сообщаем остальным
    socket.to(roomId).emit('user-joined-room', { id: socket.id, nickname });
  });

  // Отправка текстового сообщения
  socket.on('send-message', ({ roomId, text }) => {
    if (socket.currentRoom !== roomId || !text.trim()) return;
    const room = rooms.get(roomId);
    const msg = { id: Date.now(), nickname: socket.nickname, text: text.trim() };
    room.messages.push(msg);
    if (room.messages.length > 200) room.messages.shift();
    io.to(roomId).emit('new-message', msg);
  });

  // Присоединиться к голосовому каналу
  socket.on('join-voice', ({ roomId }) => {
    if (socket.currentRoom !== roomId) return;
    const room = rooms.get(roomId);
    if (!room.voiceUsers.has(socket.id)) {
      room.voiceUsers.add(socket.id);
      io.to(roomId).emit('user-joined-voice', { id: socket.id, nickname: socket.nickname });

      // Отправляем новому пользователю список уже находящихся в голосе
      const currentVoice = Array.from(room.voiceUsers).filter(id => id !== socket.id);
      socket.emit('current-voice-users', currentVoice);
    }
  });

  // Выйти из голоса
  socket.on('leave-voice', () => {
    if (!socket.currentRoom) return;
    const room = rooms.get(socket.currentRoom);
    if (room && room.voiceUsers.has(socket.id)) {
      room.voiceUsers.delete(socket.id);
      io.to(socket.currentRoom).emit('user-left-voice', { id: socket.id });
    }
  });

  // === WebRTC сигнализация ===
  socket.on('offer', ({ targetId, sdp }) => {
    io.to(targetId).emit('offer-received', { from: socket.id, sdp });
  });

  socket.on('answer', ({ targetId, sdp }) => {
    io.to(targetId).emit('answer-received', { from: socket.id, sdp });
  });

  socket.on('ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('ice-candidate-received', { from: socket.id, candidate });
  });

  // Выход из комнаты
  socket.on('leave-room', () => {
    if (socket.currentRoom) leaveRoom(socket);
  });

  function leaveRoom(socket) {
    const roomId = socket.currentRoom;
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);

    // Выходим из голоса
    if (room.voiceUsers.has(socket.id)) {
      room.voiceUsers.delete(socket.id);
      io.to(roomId).emit('user-left-voice', { id: socket.id });
    }

    room.users.delete(socket.id);
    socket.leave(roomId);
    io.to(roomId).emit('user-left-room', { id: socket.id });

    // Если комната пуста — удаляем
    if (room.users.size === 0) rooms.delete(roomId);

    socket.currentRoom = null;
    socket.nickname = null;
  }

  socket.on('disconnect', () => {
    if (socket.currentRoom) leaveRoom(socket);
    console.log('❌ Пользователь отключился:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер запущен: http://localhost:${PORT}`));