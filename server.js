const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, userName }) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.userName = userName;

    if (!rooms[roomId]) {
      rooms[roomId] = [];
    }
    rooms[roomId].push({ id: socket.id, name: userName });

    socket.emit('room-users', rooms[roomId]);
    socket.to(roomId).emit('user-joined', { id: socket.id, name: userName });

    socket.on('offer', ({ to, offer }) => {
      io.to(to).emit('offer', { from: socket.id, offer, name: userName });
    });

    socket.on('answer', ({ to, answer }) => {
      io.to(to).emit('answer', { from: socket.id, answer });
    });

    socket.on('ice-candidate', ({ to, candidate }) => {
      io.to(to).emit('ice-candidate', { from: socket.id, candidate });
    });

    socket.on('screen-share-offer', ({ to, offer }) => {
      io.to(to).emit('screen-share-offer', { from: socket.id, offer, name: userName });
    });

    socket.on('screen-share-answer', ({ to, answer }) => {
      io.to(to).emit('screen-share-answer', { from: socket.id, answer });
    });

    socket.on('screen-share-ice', ({ to, candidate }) => {
      io.to(to).emit('screen-share-ice', { from: socket.id, candidate });
    });

    socket.on('disconnect', () => {
      if (rooms[roomId]) {
        rooms[roomId] = rooms[roomId].filter(u => u.id !== socket.id);
        if (rooms[roomId].length === 0) {
          delete rooms[roomId];
        }
      }
      socket.to(roomId).emit('user-left', { id: socket.id });
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Voice chat server running on http://localhost:${PORT}`);
});
