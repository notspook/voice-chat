const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const users = {};

io.on('connection', (socket) => {
  socket.on('join', ({ userName }) => {
    const roomId = 'global';
    socket.join(roomId);
    socket.data.userName = userName;

    users[socket.id] = { id: socket.id, name: userName };
    socket.emit('room-users', Object.values(users));
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
      delete users[socket.id];
      socket.to(roomId).emit('user-left', { id: socket.id });
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Voice chat server running on http://localhost:${PORT}`);
});
