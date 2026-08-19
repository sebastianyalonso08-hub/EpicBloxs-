const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";
const MAX_PLAYERS_PER_ROOM = 50;
const MAX_CHAT_LEN = 200;
const SERVER_ID = "SRV-" + crypto.randomBytes(3).toString("hex").toUpperCase();
const rooms = new Map();
const sessions = new Map();

const publicDir = path.join(__dirname, "public");
const indexPath = path.join(publicDir, "index.html");
const dataDir = path.join(__dirname, "data");
const usersPath = path.join(dataDir, "users.json");

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(usersPath)) fs.writeFileSync(usersPath, "{}", "utf8");
}

function loadUsers() {
  try {
    ensureDataDir();
    return JSON.parse(fs.readFileSync(usersPath, "utf8") || "{}");
  } catch {
    return {};
  }
}

function saveUsersDisk(users) {
  ensureDataDir();
  fs.writeFileSync(usersPath, JSON.stringify(users, null, 2), "utf8");
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password) + "|epicbloxs").digest("hex");
}

function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

function makeId() {
  return crypto.randomBytes(8).toString("hex");
}

function safeText(value, fallback, max) {
  const text = String(value ?? fallback).replace(/[<>]/g, "").trim().slice(0, max);
  return text || fallback;
}

function safeNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(-10000, Math.min(10000, n)) : fallback;
}

function defaultUser(username, passwordHash) {
  return {
    username,
    passwordHash,
    sunnys: 500,
    bio: "Insert Bio.",
    avatar: {
      accessories: [],
      torsoType: "male",
      colors: { head: "#f5c928", arms: "#f5c928", torso: "#1477b9", legs: "#8cae45" }
    },
    inventory: [],
    loginStreak: 0,
    lastStreakClaim: "",
    friends: [],
    friendRequests: [],
    outgoingRequests: [],
    lastDailyLogin: "",
    createdAt: new Date().toISOString()
  };
}

function publicUser(user, key) {
  if (!user) return null;
  return {
    id: key,
    username: user.username,
    bio: user.bio || "",
    sunnys: user.sunnys || 0,
    avatar: user.avatar || {},
    inventory: user.inventory || [],
    friends: user.friends || [],
    friendRequests: user.friendRequests || [],
    outgoingRequests: user.outgoingRequests || [],
    createdAt: user.createdAt
  };
}

function getSessionUser(req) {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !sessions.has(token)) return null;
  const key = sessions.get(token);
  const users = loadUsers();
  if (!users[key]) return null;
  return { token, key, user: users[key], users };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

function json(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  if (req.method === "OPTIONS") return json(res, 204, {});

  if (urlPath === "/health") {
    const players = [...rooms.values()].reduce((n, room) => n + room.players.size, 0);
    const accounts = Object.keys(loadUsers()).length;
    const online = [...rooms.values()].reduce((n, room) => n + room.players.size, 0);
    return json(res, 200, {
      ok: true,
      service: "EpicBloxs Global",
      rooms: rooms.size,
      players: online,
      users: accounts,
      accounts,
      message: accounts + " cuentas registradas, " + online + " en linea"
    });
  }

  if (urlPath === "/api/register" && req.method === "POST") {
    const body = await readBody(req);
    const username = safeText(body.username, "", 20);
    const password = String(body.password || "");
    if (username.length < 3) return json(res, 400, { error: "Usuario minimo 3 caracteres." });
    if (password.length < 6) return json(res, 400, { error: "Contrasena minimo 6 caracteres." });
    const key = username.toLowerCase();
    const users = loadUsers();
    if (users[key]) return json(res, 409, { error: "Ese usuario ya existe." });
    users[key] = defaultUser(username, hashPassword(password));
    saveUsersDisk(users);
    const token = makeToken();
    sessions.set(token, key);
    return json(res, 200, { token, user: publicUser(users[key], key) });
  }

  if (urlPath === "/api/login" && req.method === "POST") {
    const body = await readBody(req);
    const key = safeText(body.username, "", 20).toLowerCase();
    const password = String(body.password || "");
    const users = loadUsers();
    const user = users[key];
    if (!user || user.passwordHash !== hashPassword(password)) {
      return json(res, 401, { error: "Usuario o contrasena incorrectos." });
    }
    const today = new Date().toDateString();
    if (user.lastDailyLogin !== today) {
      user.sunnys = (user.sunnys || 0) + 100;
      user.lastDailyLogin = today;
      users[key] = user;
      saveUsersDisk(users);
    }
    const token = makeToken();
    sessions.set(token, key);
    return json(res, 200, { token, user: publicUser(user, key) });
  }

  if (urlPath === "/api/me" && req.method === "GET") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    return json(res, 200, { user: publicUser(sess.user, sess.key) });
  }

  if (urlPath === "/api/me" && req.method === "POST") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const body = await readBody(req);
    const users = sess.users;
    const user = users[sess.key];
    if (body.avatar) user.avatar = body.avatar;
    if (Array.isArray(body.inventory)) user.inventory = body.inventory;
    if (typeof body.sunnys === "number") user.sunnys = Math.max(0, Math.min(9999999, body.sunnys));
    if (typeof body.bio === "string") user.bio = safeText(body.bio, user.bio, 200);
    if (typeof body.loginStreak === "number") user.loginStreak = Math.max(0, Math.min(9999, body.loginStreak));
    if (typeof body.lastStreakClaim === "string") user.lastStreakClaim = safeText(body.lastStreakClaim, "", 32);
    if (body.avatar && body.avatar.torsoType) {
      user.avatar = user.avatar || {};
      user.avatar.torsoType = body.avatar.torsoType === "female" ? "female" : "male";
    }
    users[sess.key] = user;
    saveUsersDisk(users);
    return json(res, 200, { user: publicUser(user, sess.key) });
  }

  if (urlPath === "/api/users/search" && req.method === "GET") {
    const q = safeText(new URL(req.url, "http://x").searchParams.get("q"), "", 40).toLowerCase();
    const users = loadUsers();
    const results = [];
    for (const [key, user] of Object.entries(users)) {
      if (!q || key.includes(q) || (user.username || "").toLowerCase().includes(q)) {
        results.push({ id: key, username: user.username, bio: user.bio || "", avatar: user.avatar || {} });
        if (results.length >= 20) break;
      }
    }
    return json(res, 200, { results });
  }

  if (urlPath.startsWith("/api/users/") && req.method === "GET") {
    const id = decodeURIComponent(urlPath.replace("/api/users/", "")).toLowerCase();
    if (id && !id.includes("/")) {
      const users = loadUsers();
      if (!users[id]) return json(res, 404, { error: "Usuario no encontrado." });
      return json(res, 200, { user: publicUser(users[id], id) });
    }
  }

  if (urlPath === "/api/friends/request" && req.method === "POST") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const body = await readBody(req);
    const targetKey = safeText(body.username || body.id, "", 40).toLowerCase();
    const users = sess.users;
    if (!users[targetKey]) return json(res, 404, { error: "Usuario no encontrado." });
    if (targetKey === sess.key) return json(res, 400, { error: "No puedes agregarte a ti mismo." });
    const me = users[sess.key];
    const other = users[targetKey];
    me.friends = me.friends || [];
    me.friendRequests = me.friendRequests || [];
    me.outgoingRequests = me.outgoingRequests || [];
    other.friends = other.friends || [];
    other.friendRequests = other.friendRequests || [];
    other.outgoingRequests = other.outgoingRequests || [];
    if (me.friends.includes(targetKey)) return json(res, 400, { error: "Ya son amigos." });
    if (me.friendRequests.includes(targetKey)) {
      me.friendRequests = me.friendRequests.filter((k) => k !== targetKey);
      other.outgoingRequests = (other.outgoingRequests || []).filter((k) => k !== sess.key);
      if (!me.friends.includes(targetKey)) me.friends.push(targetKey);
      if (!other.friends.includes(sess.key)) other.friends.push(sess.key);
      users[sess.key] = me; users[targetKey] = other; saveUsersDisk(users);
      return json(res, 200, { ok: true, accepted: true, user: publicUser(me, sess.key) });
    }
    if (me.outgoingRequests.includes(targetKey)) return json(res, 400, { error: "Ya enviaste una solicitud." });
    if (!other.friendRequests.includes(sess.key)) other.friendRequests.push(sess.key);
    if (!me.outgoingRequests.includes(targetKey)) me.outgoingRequests.push(targetKey);
    users[sess.key] = me; users[targetKey] = other; saveUsersDisk(users);
    return json(res, 200, { ok: true, sent: true, user: publicUser(me, sess.key) });
  }

  if (urlPath === "/api/friends/accept" && req.method === "POST") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const body = await readBody(req);
    const fromKey = safeText(body.id || body.username, "", 40).toLowerCase();
    const users = sess.users;
    if (!users[fromKey]) return json(res, 404, { error: "Usuario no encontrado." });
    const me = users[sess.key];
    const other = users[fromKey];
    me.friendRequests = (me.friendRequests || []).filter((k) => k !== fromKey);
    other.outgoingRequests = (other.outgoingRequests || []).filter((k) => k !== sess.key);
    if (!me.friends.includes(fromKey)) me.friends.push(fromKey);
    if (!other.friends.includes(sess.key)) other.friends.push(sess.key);
    users[sess.key] = me; users[fromKey] = other; saveUsersDisk(users);
    return json(res, 200, { ok: true, user: publicUser(me, sess.key) });
  }

  if (urlPath === "/api/friends/reject" && req.method === "POST") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const body = await readBody(req);
    const fromKey = safeText(body.id || body.username, "", 40).toLowerCase();
    const users = sess.users;
    const me = users[sess.key];
    me.friendRequests = (me.friendRequests || []).filter((k) => k !== fromKey);
    if (users[fromKey]) {
      users[fromKey].outgoingRequests = (users[fromKey].outgoingRequests || []).filter((k) => k !== sess.key);
    }
    users[sess.key] = me; saveUsersDisk(users);
    return json(res, 200, { ok: true, user: publicUser(me, sess.key) });
  }

  if (urlPath === "/api/friends/list" && req.method === "GET") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const users = sess.users;
    const me = sess.user;
    const friends = (me.friends || []).map((k) => publicUser(users[k], k)).filter(Boolean);
    const requests = (me.friendRequests || []).map((k) => publicUser(users[k], k)).filter(Boolean);
    return json(res, 200, { friends, requests });
  }

  if (urlPath === "/" || urlPath === "/index.html") {
    fs.readFile(indexPath, (err, data) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("EpicBloxs client not found.");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

const wss = new WebSocket.Server({ server });

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function publicPlayer(player) {
  return {
    id: player.id, playerId: player.id, gameId: player.gameId, serverId: SERVER_ID,
    username: player.username, avatar: player.avatar,
    x: player.x, y: player.y, z: player.z, rotation: player.rotation
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
    room = { key, name, gameId, players: new Map() };
    rooms.set(key, room);
  }
  return room;
}

function leaveRoom(player) {
  if (!player.roomKey) return;
  const room = rooms.get(player.roomKey);
  const oldKey = player.roomKey;
  player.roomKey = null;
  player.roomName = null;
  if (!room) return;
  room.players.delete(player.id);
  broadcast(room, { type: "playerLeft", id: player.id, username: player.username, count: room.players.size });
  if (room.players.size === 0) rooms.delete(oldKey);
}

wss.on("connection", (ws) => {
  const player = {
    id: makeId(), ws, roomKey: null, roomName: null, gameId: null,
    username: "Player", avatar: null, x: 0, y: 0, z: 0, rotation: 0, lastChatAt: 0
  };
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    if (data.type === "join") {
      const roomName = safeText(data.room, "EpicBloxs Universe", 80);
      const gameId = safeText(data.gameId, "GAME-UNKNOWN", 32);
      if (player.roomKey) leaveRoom(player);
      const room = getOrCreateRoom(roomName, gameId);
      if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
        send(ws, { type: "error", message: "Esta sala esta llena." });
        return;
      }
      player.username = safeText(data.username, "Player", 24);
      player.avatar = data.avatar || null;
      player.x = 0; player.y = 0; player.z = 0; player.rotation = 0;

      // Evitar duplicados: si el mismo username ya esta en alguna sala, echar la sesion vieja
      const unameKey = player.username.toLowerCase();
      for (const r of rooms.values()) {
        for (const [pid, pl] of [...r.players.entries()]) {
          if (pl !== player && pl.username && pl.username.toLowerCase() === unameKey) {
            try {
              r.players.delete(pid);
              broadcast(r, { type: "playerLeft", id: pid, username: pl.username, count: r.players.size });
              if (pl.ws && pl.ws !== ws) {
                try { pl.ws.close(4000, "Replaced by new session"); } catch (e) {}
              }
            } catch (e) {}
          }
        }
      }

      player.roomKey = room.key;
      player.roomName = roomName;
      player.gameId = gameId;
      const existingPlayers = [...room.players.values()]
        .filter(pl => pl.id !== player.id)
        .map(publicPlayer);
      room.players.set(player.id, player);
      send(ws, {
        type: "welcome",
        id: player.id,
        playerId: player.id,
        serverId: SERVER_ID,
        gameId: player.gameId,
        count: room.players.size,
        players: existingPlayers,
        accounts: Object.keys(loadUsers()).length
      });
      broadcast(room, { type: "playerJoined", player: publicPlayer(player), count: room.players.size }, ws);
      for (const p of room.players.values()) {
        send(p.ws, { type: "chat", username: "Sistema", message: player.username + " se unio a la partida.", system: true, ts: Date.now() });
      }
      return;
    }

    if (!player.roomKey) return;
    const room = rooms.get(player.roomKey);
    if (!room) return;

    if (data.type === "move") {
      player.x = safeNumber(data.x, player.x);
      player.y = safeNumber(data.y, player.y);
      player.z = safeNumber(data.z, player.z);
      player.rotation = safeNumber(data.rotation, player.rotation);
      broadcast(room, { type: "playerMoved", player: publicPlayer(player) }, ws);
      return;
    }

    if (data.type === "avatar") {
      player.avatar = data.avatar || null;
      broadcast(room, { type: "playerMoved", player: publicPlayer(player) }, ws);
      return;
    }

    if (data.type === "chat") {
      const now = Date.now();
      if (now - player.lastChatAt < 300) return;
      player.lastChatAt = now;
      const message = safeText(data.message, "", MAX_CHAT_LEN);
      if (!message) return;
      const payload = { type: "chat", id: player.id, username: player.username, message, system: false, ts: now };
      for (const p of room.players.values()) send(p.ws, payload);
    }
  });

  ws.on("close", () => {
    const name = player.username;
    const room = player.roomKey ? rooms.get(player.roomKey) : null;
    leaveRoom(player);
    if (room && room.players.size > 0) {
      for (const p of room.players.values()) {
        send(p.ws, { type: "chat", username: "Sistema", message: name + " salio de la partida.", system: true, ts: Date.now() });
      }
    }
  });
  ws.on("error", () => leaveRoom(player));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) { try { ws.close(1001, "Server restarting"); } catch {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

ensureDataDir();
server.listen(PORT, HOST, () => {
  console.log("EpicBloxs GLOBAL server on http://" + HOST + ":" + PORT);
  console.log("Users file: " + usersPath);
});
