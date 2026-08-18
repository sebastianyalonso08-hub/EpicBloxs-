const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";
const MAX_PLAYERS_PER_ROOM = 50;
const SERVER_ID = "SRV-" + crypto.randomBytes(3).toString("hex").toUpperCase();
const rooms = new Map();

const publicDir = path.join(__dirname, "public");
const indexPath = path.join(publicDir, "index.html");

const server = http.createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  if (urlPath === "/health") {
    const players = [...rooms.values()].reduce((n, room) => n + room.players.size, 0);
    res.writeHead(200, {"Content-Type":"application/json; charset=utf-8"});
    res.end(JSON.stringify({
      ok: true,
      service: "EpicBloxs Multiplayer",
      rooms: rooms.size,
      players
    }));
    return;
  }

  if (urlPath === "/" || urlPath === "/index.html") {
    fs.readFile(indexPath, (err, data) => {
      if (err) {
        res.writeHead(500, {"Content-Type":"text/plain; charset=utf-8"});
        res.end("EpicBloxs client not found.");
        return;
      }
      res.writeHead(200, {
        "Content-Type":"text/html; charset=utf-8",
        "Cache-Control":"no-cache"
      });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, {"Content-Type":"text/plain; charset=utf-8"});
  res.end("Not found");
});

const wss = new WebSocket.Server({ server });

function makeId() {
  return crypto.randomBytes(8).toString("hex");
}

function safeText(value, fallback, max) {
  const text = String(value ?? fallback)
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, max);
  return text || fallback;
}

function safeNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n)
    ? Math.max(-10000, Math.min(10000, n))
    : fallback;
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function publicPlayer(player) {
  return {
    id: player.id,
    playerId: player.id,
    gameId: player.gameId,
    serverId: SERVER_ID,
    username: player.username,
    avatar: player.avatar,
    x: player.x,
    y: player.y,
    z: player.z,
    rotation: player.rotation
  };
}

function broadcast(room, data, exceptWs = null) {
  for (const player of room.players.values()) {
    if (player.ws !== exceptWs) send(player.ws, data);
  }
}

function getOrCreateRoom(name, gameId) {
  const key = gameId + "::" + name;
  let room = rooms.get(key);
  if (!room) {
    room = {
      key,
      name,
      gameId,
      players: new Map()
    };
    rooms.set(key, room);
  }
  return room;
}

function leaveRoom(player) {
  if (!player.roomName) return;

  const room = rooms.get(player.roomName);
  const oldRoomName = player.roomName;
  player.roomName = null;

  if (!room) return;

  room.players.delete(player.id);

  broadcast(room, {
    type: "playerLeft",
    id: player.id,
    count: room.players.size
  });

  if (room.players.size === 0) {
    rooms.delete(oldRoomName);
  }
}

wss.on("connection", (ws) => {
  const player = {
    id: makeId(),
    ws,
    roomName: null,
    gameId: null,
    username: "Player",
    avatar: null,
    x: 0,
    y: 0,
    z: 0,
    rotation: 0,
    alive: true
  };

  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.type === "join") {
      const roomName = safeText(data.room, "EpicBloxs Universe", 80);
      const gameId = safeText(data.gameId, "GAME-UNKNOWN", 32);

      if (player.roomName) leaveRoom(player);

      const room = getOrCreateRoom(roomName, gameId);

      if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
        send(ws, {
          type: "error",
          message: "Esta sala está llena."
        });
        return;
      }

      player.roomName = roomName;
      player.gameId = gameId;
      player.username = safeText(data.username, "Player", 24);
      player.avatar = data.avatar || null;
      player.x = 0;
      player.y = 0;
      player.z = 0;
      player.rotation = 0;

      const existingPlayers = [...room.players.values()].map(publicPlayer);
      room.players.set(player.id, player);

      send(ws, {
        type: "welcome",
        id: player.id,
        playerId: player.id,
        serverId: SERVER_ID,
        gameId: player.gameId,
        count: room.players.size,
        players: existingPlayers
      });

      broadcast(room, {
        type: "playerJoined",
        player: publicPlayer(player),
        count: room.players.size
      }, ws);

      send(ws, {
        type: "roomInfo",
        gameId: room.gameId,
        serverId: SERVER_ID,
        count: room.players.size
      });

      return;
    }

    if (!player.roomName) return;

    const room = rooms.get(player.roomName);
    if (!room) return;

    if (data.type === "move") {
      player.x = safeNumber(data.x, player.x);
      player.y = safeNumber(data.y, player.y);
      player.z = safeNumber(data.z, player.z);
      player.rotation = safeNumber(data.rotation, player.rotation);

      broadcast(room, {
        type: "playerMoved",
        player: publicPlayer(player)
      }, ws);

      return;
    }

    if (data.type === "avatar") {
      player.avatar = data.avatar || null;

      broadcast(room, {
        type: "playerMoved",
        player: publicPlayer(player)
      }, ws);

      return;
    }
  });

  ws.on("close", () => leaveRoom(player));
  ws.on("error", () => leaveRoom(player));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

function shutdown() {
  clearInterval(heartbeat);

  for (const ws of wss.clients) {
    try {
      ws.close(1001, "Server restarting");
    } catch {}
  }

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, HOST, () => {
  console.log(`EpicBloxs server running on http://${HOST}:${PORT}`);
});
