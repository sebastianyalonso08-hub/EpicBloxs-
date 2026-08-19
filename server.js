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
const presence = new Map();
const PRESENCE_TTL_MS = 25000;

const publicDir = path.join(__dirname, "public");
const indexPath = path.join(publicDir, "index.html");
const dataDir = path.join(__dirname, "data");
const usersPath = path.join(dataDir, "users.json");
const catalogPath = path.join(dataDir, "catalog.json");

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(usersPath)) fs.writeFileSync(usersPath, "{}", "utf8");
  if (!fs.existsSync(catalogPath)) fs.writeFileSync(catalogPath, "[]", "utf8");
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

function loadCatalog() {
  try { ensureDataDir(); return JSON.parse(fs.readFileSync(catalogPath, "utf8") || "[]"); } catch { return []; }
}
function saveCatalog(items) {
  ensureDataDir();
  fs.writeFileSync(catalogPath, JSON.stringify(items, null, 2), "utf8");
}

const BANNED_TERMS = [
  // Español
  "puta","puto","putas","putos","mierda","joder","coño","cojones","cabron","cabrona","cabronas","cabrones","pendejo","pendeja","pendejos","pendejas","gilipollas","imbecil","imbécil","idiota","idiotas","estupido","estúpido","estupida","estúpida","maricon","maricón","marica","zorra","culero","culera","verga","polla","chingar","chingada","chingado","malparido","malparida","perra","perro","bastardo","bastarda",
  // English
  "fuck","fucking","fucked","shit","bullshit","bitch","bitches","asshole","assholes","dick","dickhead","pussy","cunt","bastard","motherfucker","damn","crap","slut","whore","jerk","idiot","stupid",
  // Português
  "puta","puto","merda","porra","caralho","cacete","viado","veado","bicha","babaca","idiota","otario","otária","cu","foder","fodase","fodasse","desgraçado","desgracado","vagabunda","vagabundo",
  // Français
  "merde","putain","connard","connasse","encule","enculé","salope","pute","nique","foutre","bite","couille","con","conne","idiot","idiote",
  // Italiano
  "cazzo","merda","puttana","stronzo","stronza","bastardo","bastarda","vaffanculo","fanculo","coglione","cogliona","troia","sborra",
  // Deutsch
  "scheisse","scheiße","fuck","arschloch","fotze","hurensohn","hure","wichser","mistkerl","idiot","dummkopf",
  // Nederlands
  "klootzak","kut","hoer","hoer","fuck","tering","tyfus","godverdomme","eikel","sukkel",
  // Polski / Česky / Slovensky
  "kurwa","cholera","dupa","skurwysyn","suka","cipa","jebac","jebać","pierdol","pierdolony","debil","idiota","kurva","hovno","kokot",
  // Русский / Ukrainian transliterations and common forms
  "blyad","blyat","bljad","suka","suka","pizda","khuy","hui","xuy","yob","ebat","ebat","mudak","durak","debил","gavno","govno",
  // Referencias sexuales / contenido explícito común
  "porn","porno","pornografia","pornography","xxx","nsfw","sexcam","sexting","nudes","nudez","desnudo","desnuda","desnudos","desnudas","sexo","sexual","genitales","genitals","masturb","masturbacion","masturbación","ereccion","erección","semen","cumshot","blowjob","handjob","anal","hentai","fetish","fetiche","prostituta","prostitucion","prostitución",
  // Referencias de violencia / autolesión comunes para el chat social
  "suicide","suicidio","kill yourself","kys","selfharm","self harm","autolesion","autolesión","matarte","muerete","muérete","kill yourself",
  // Slurs / lenguaje degradante común (incluidos algunos censurados por seguridad de comunidades)
  "nigger","nigga","faggot","fag","dyke","retard","retarded","tranny","spic","kike","chink","coon","wetback","gook","cracker"
];

function normalizedModerationText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    // Algunas sustituciones comunes de leetspeak/confusables.
    .replace(/[4@]/g, 'a')
    .replace(/[3€]/g, 'e')
    .replace(/[1!|]/g, 'i')
    .replace(/[0]/g, 'o')
    .replace(/[$5]/g, 's')
    .replace(/[7]/g, 't')
    .replace(/[9]/g, 'g')
    // Confusables latinos/cirílicos frecuentes.
    .replace(/[аa]/g, 'a').replace(/[еe]/g, 'e').replace(/[іi]/g, 'i')
    .replace(/[оo]/g, 'o').replace(/[рp]/g, 'p').replace(/[сc]/g, 'c')
    .replace(/[хx]/g, 'x').replace(/[уy]/g, 'y').replace(/[кk]/g, 'k')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function moderationVariants(term) {
  const compact = normalizedModerationText(term);
  if (!compact) return [];
  const collapsed = compact.replace(/([a-z])\1+/g, '$1');
  return [...new Set([compact, collapsed])];
}

function isWordChar(ch) {
  return /[\p{L}\p{N}_]/u.test(ch || '');
}

function censoredRanges(source, terms = BANNED_TERMS) {
  const chars = Array.from(String(source || ''));
  const normalizedChars = chars.map((ch, idx) => ({
    idx,
    norm: normalizedModerationText(ch)
  }));
  const ranges = [];

  for (const term of terms) {
    for (const variant of moderationVariants(term)) {
      if (!variant) continue;
      for (let pos = 0; pos < normalizedChars.length;) {
        let j = pos;
        let built = '';
        const indices = [];
        while (j < normalizedChars.length && built.length < variant.length) {
          if (normalizedChars[j].norm) {
            built += normalizedChars[j].norm;
            indices.push(normalizedChars[j].idx);
          }
          j++;
        }
        if (built !== variant || !indices.length) {
          pos++;
          continue;
        }
        const first = indices[0];
        const last = indices[indices.length - 1];
        const before = first > 0 ? chars[first - 1] : '';
        const after = last < chars.length - 1 ? chars[last + 1] : '';
        // No censuramos una coincidencia incrustada dentro de otra palabra.
        if (!isWordChar(before) && !isWordChar(after)) {
          ranges.push([first, last]);
        }
        pos = Math.max(j, pos + 1);
      }
    }
  }
  return ranges;
}

function censorText(text) {
  const source = String(text || '');
  if (!source) return source;
  const result = Array.from(source);
  for (const [first, last] of censoredRanges(source)) {
    for (let i = first; i <= last; i++) result[i] = '#';
  }
  return result.join('');
}

function hasBannedTerm(text) {
  return censoredRanges(String(text || '')).length > 0;
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

function nextNumericUserId(users) {
  let max = 1000;
  for (const user of Object.values(users || {})) {
    const n = Number(user && user.userId);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

function ensureUserIds(users) {
  let changed = false;
  let next = nextNumericUserId(users);
  for (const user of Object.values(users || {})) {
    if (!Number.isInteger(Number(user.userId))) {
      user.userId = next++;
      changed = true;
    }
  }
  if (changed) saveUsersDisk(users);
  return users;
}

function resolveUserKey(users, identifier) {
  const raw = String(identifier ?? "").trim();
  if (!raw) return null;
  const key = raw.toLowerCase();
  if (users[key]) return key;

  // Buscar también por Username real, incluso si la clave interna de users.json
  // no coincide exactamente con el username (compatibilidad con cuentas antiguas).
  for (const [k, user] of Object.entries(users || {})) {
    if (String(user && user.username || "").trim().toLowerCase() === key) return k;
  }

  const wanted = Number(raw);
  if (Number.isInteger(wanted)) {
    for (const [k, user] of Object.entries(users || {})) {
      if (Number(user && user.userId) === wanted) return k;
    }
  }
  return null;
}

function defaultUser(username, passwordHash, userId) {
  return {
    username,
    userId,
    passwordHash,
    sunnys: 500,
    bio: "Insert Bio.",
    theme: "light",
    avatar: {
      accessories: [],
      torsoType: "male",
      colors: { head: "#f5c928", arms: "#f5c928", torso: "#1477b9", legs: "#8cae45" }
    },
    avatarInventory: [],
    gameInventory: [],
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
    id: String(user.userId),
    userId: Number(user.userId),
    usernameKey: key,
    username: user.username,
    bio: user.bio || "",
    theme: user.theme || "light",
    sunnys: user.sunnys || 0,
    avatar: user.avatar || {},
    avatarInventory: user.avatarInventory || user.inventory || [],
    gameInventory: user.gameInventory || [],
    inventory: [],
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
  const users = ensureUserIds(loadUsers());
  if (!users[key]) return null;
  return { token, key, user: users[key], users };
}

function setPresence(key, data = {}) {
  if (!key) return;
  const prev = presence.get(key) || {};
  presence.set(key, {
    online: true,
    playing: !!data.playing,
    gameId: data.gameId || (data.playing ? prev.gameId || null : null),
    gameName: data.gameName || (data.playing ? prev.gameName || null : null),
    roomName: data.roomName || (data.playing ? prev.roomName || null : null),
    serverId: data.serverId || (data.playing ? prev.serverId || SERVER_ID : null),
    lastSeen: Date.now()
  });
}

function clearPlaying(key) {
  if (!key) return;
  const prev = presence.get(key);
  if (!prev) return;
  presence.set(key, { ...prev, playing: false, gameId: null, gameName: null, roomName: null, serverId: null, lastSeen: Date.now() });
}

function getPresence(key) {
  const p = presence.get(key);
  if (!p) return { online: false, playing: false };
  const fresh = (Date.now() - Number(p.lastSeen || 0)) <= PRESENCE_TTL_MS;
  if (!fresh) {
    presence.delete(key);
    return { online: false, playing: false };
  }
  return {
    online: !!p.online,
    playing: !!p.playing,
    gameId: p.gameId || null,
    gameName: p.gameName || null,
    roomName: p.roomName || null,
    serverId: p.serverId || null,
    lastSeen: p.lastSeen || 0
  };
}

function publicFriendUser(user, key) {
  if (!user) return null;
  return { ...publicUser(user, key), presence: getPresence(key) };
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
    if (hasBannedTerm(username)) return json(res, 400, { error: "Ese nombre de usuario no esta permitido." });
    if (password.length < 6) return json(res, 400, { error: "Contrasena minimo 6 caracteres." });
    const key = username.toLowerCase();
    const users = ensureUserIds(loadUsers());
    if (users[key]) return json(res, 409, { error: "Ese usuario ya existe." });
    users[key] = defaultUser(username, hashPassword(password), nextNumericUserId(users));
    saveUsersDisk(users);
    const token = makeToken();
    sessions.set(token, key);
    return json(res, 200, { token, user: publicUser(users[key], key) });
  }

  if (urlPath === "/api/login" && req.method === "POST") {
    const body = await readBody(req);
    const key = safeText(body.username, "", 20).toLowerCase();
    const password = String(body.password || "");
    const users = ensureUserIds(loadUsers());
    const user = users[key];
    if (user && hasBannedTerm(user.username)) return json(res, 403, { error: "Esta cuenta no puede iniciar sesion por el nombre de usuario." });
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
    if (Array.isArray(body.avatarInventory)) user.avatarInventory = body.avatarInventory;
    if (Array.isArray(body.gameInventory)) user.gameInventory = body.gameInventory;
    // Compatibilidad con versiones anteriores: nunca vuelve a usarse como inventario de juego.
    user.inventory = [];
    if (typeof body.sunnys === "number") user.sunnys = Math.max(0, Math.min(9999999, body.sunnys));
    if (typeof body.bio === "string") user.bio = safeText(body.bio, user.bio, 200);
    if (typeof body.theme === "string") user.theme = ["light","dark","blue","purple"].includes(body.theme) ? body.theme : (user.theme || "light");
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
    const rawQuery = safeText(new URL(req.url, "http://x").searchParams.get("q"), "", 40);
    const q = rawQuery.toLowerCase();
    const users = ensureUserIds(loadUsers());
    const results = [];
    for (const [key, user] of Object.entries(users)) {
      const username = String(user.username || "");
      const usernameLower = username.toLowerCase();
      if (!q || key === q || usernameLower === q || key.includes(q) || usernameLower.includes(q)) {
        results.push({
          id: String(user.userId),
          userId: Number(user.userId),
          usernameKey: key,
          username,
          bio: user.bio || "",
          avatar: user.avatar || {}
        });
      }
    }
    results.sort((a, b) => {
      const ae = String(a.username || "").toLowerCase() === q;
      const be = String(b.username || "").toLowerCase() === q;
      if (ae !== be) return ae ? -1 : 1;
      return String(a.username || "").localeCompare(String(b.username || ""));
    });
    return json(res, 200, { results, exact: results.find(r => String(r.username || "").toLowerCase() === q) || null });
  }

  if (urlPath === "/api/users/lookup" && req.method === "GET") {
    const rawQuery = safeText(new URL(req.url, "http://x").searchParams.get("username"), "", 40);
    const q = rawQuery.toLowerCase();
    const users = ensureUserIds(loadUsers());
    // Username exacto: primero por clave interna y luego por el campo username real.
    const key = Object.keys(users).find(k => k.toLowerCase() === q)
      || Object.keys(users).find(k => String(users[k].username || "").trim().toLowerCase() === q);
    if (!key) return json(res, 404, { error: "Usuario no encontrado." });
    // Asegurar ID numérico persistente para solicitudes y perfiles.
    ensureUserIds(users);
    saveUsersDisk(users);
    return json(res, 200, {
      user: {
        id: String(users[key].userId),
        userId: Number(users[key].userId),
        usernameKey: key,
        username: users[key].username,
        bio: users[key].bio || "",
        avatar: users[key].avatar || {}
      }
    });
  }

  if (urlPath.startsWith("/api/users/") && req.method === "GET") {
    const identifier = decodeURIComponent(urlPath.replace("/api/users/", ""));
    if (identifier && !identifier.includes("/")) {
      const users = ensureUserIds(loadUsers());
      const key = resolveUserKey(users, identifier);
      if (!key) return json(res, 404, { error: "Usuario no encontrado." });
      return json(res, 200, { user: publicUser(users[key], key) });
    }
  }

  if (urlPath === "/api/presence" && req.method === "POST") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const body = await readBody(req);
    setPresence(sess.key, {
      playing: !!body.playing,
      gameId: safeText(body.gameId || "", "", 40),
      gameName: safeText(body.gameName || "", "", 80),
      roomName: safeText(body.roomName || "", "", 80),
      serverId: safeText(body.serverId || SERVER_ID, SERVER_ID, 40)
    });
    return json(res, 200, { ok: true, presence: getPresence(sess.key) });
  }

  if (urlPath === "/api/friends/request" && req.method === "POST") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const body = await readBody(req);
    const users = ensureUserIds(sess.users);
    const identifier = safeText(body.username || body.id, "", 80);
    const targetKey = resolveUserKey(users, identifier);
    if (!targetKey) return json(res, 404, { error: "Usuario no encontrado." });
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
    const users = ensureUserIds(sess.users);
    const fromKey = resolveUserKey(users, safeText(body.id || body.username, "", 80));
    if (!fromKey) return json(res, 404, { error: "Usuario no encontrado." });
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
    const users = ensureUserIds(sess.users);
    const fromKey = resolveUserKey(users, safeText(body.id || body.username, "", 80));
    const me = users[sess.key];
    me.friendRequests = (me.friendRequests || []).filter((k) => k !== fromKey);
    if (users[fromKey]) {
      users[fromKey].outgoingRequests = (users[fromKey].outgoingRequests || []).filter((k) => k !== sess.key);
    }
    users[sess.key] = me; saveUsersDisk(users);
    return json(res, 200, { ok: true, user: publicUser(me, sess.key) });
  }

  if (urlPath === "/api/catalog/custom" && req.method === "GET") {
    const items = loadCatalog().filter(item => item.status === "approved");
    return json(res, 200, { items });
  }

  if (urlPath === "/api/creator/publish" && req.method === "POST") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const body = await readBody(req);
    const name = safeText(body.name, "", 40);
    const description = safeText(body.description, "", 200);
    const category = ["hats","shirts","pants","gear"].includes(body.category) ? body.category : "gear";
    const type = body.type === "2d" ? "2d" : "accessory3d";
    const price = Math.floor(Number(body.price ?? 0));
    if (!Number.isFinite(price) || price < 0 || price > 1000000) return json(res, 400, { error: "El precio debe estar entre 0 y 1.000.000 Sunnys." });
    if (name.length < 2) return json(res, 400, { error: "Pon un nombre al objeto." });
    if (hasBannedTerm(name) || hasBannedTerm(description)) {
      const items = loadCatalog();
      items.push({ id: "REMOVED-" + Date.now(), ownerId: Number(sess.user.userId), owner: sess.user.username, name: censorText(name), description: censorText(description), category, type, status: "removed", reason: "moderation", createdAt: new Date().toISOString() });
      saveCatalog(items);
      return json(res, 400, { error: "La publicacion fue retirada automaticamente por moderacion.", removed: true });
    }
    const payloadText = JSON.stringify(body.data || {});
    if (payloadText.length > 2500000) return json(res, 413, { error: "El recurso es demasiado grande." });
    if (type === "2d" && body.data && body.data.imageData && !/^data:image\/(png|jpeg|webp);base64,/i.test(String(body.data.imageData))) {
      return json(res, 400, { error: "Formato de imagen no permitido." });
    }
    const items = loadCatalog();
    const item = {
      id: "U-" + Date.now() + "-" + Math.random().toString(36).slice(2,7),
      ownerId: Number(sess.user.userId), owner: sess.user.username, name, description, category, type, price,
      data: body.data || {}, status: type === "2d" && body.data && body.data.imageData ? "pending" : "approved",
      createdAt: new Date().toISOString()
    };
    items.push(item); saveCatalog(items);
    if (item.status !== "approved") return json(res, 202, { ok: true, pending: true, message: "Ropa subida. Quedo en revision antes de aparecer en el catalogo.", item });
    return json(res, 200, { ok: true, item, message: "Accesorio publicado en el catalogo." });
  }

  if (urlPath === "/api/chat/moderate" && req.method === "POST") {
    const body = await readBody(req);
    return json(res, 200, { message: censorText(safeText(body.message, "", 200)) });
  }

  if (urlPath === "/api/games/stats" && req.method === "GET") {
    const stats = {};
    for (const room of rooms.values()) {
      const id = room.gameId || "GAME-UNKNOWN";
      stats[id] = (stats[id] || 0) + room.players.size;
    }
    return json(res, 200, { stats, updatedAt: Date.now() });
  }

  if (urlPath === "/api/friends/list" && req.method === "GET") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const users = sess.users;
    const me = sess.user;
    const friends = (me.friends || []).map((k) => publicFriendUser(users[k], k)).filter(Boolean);
    const requests = (me.friendRequests || []).map((k) => publicFriendUser(users[k], k)).filter(Boolean);
    return json(res, 200, { friends, requests });
  }

  if (urlPath.startsWith("/perfil/")) {
    const identifier = decodeURIComponent(urlPath.replace("/perfil/", ""));
    const users = ensureUserIds(loadUsers());
    const key = resolveUserKey(users, identifier);
    if (!key) return json(res, 404, { error: "Perfil no encontrado." });
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
    username: censorText(player.username), avatar: player.avatar,
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
  broadcast(room, { type: "playerLeft", id: player.id, username: censorText(player.username), count: room.players.size });
  if (player.username) clearPlaying(player.username.toLowerCase());
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
      setPresence(player.username.toLowerCase(), { playing: true, gameId, gameName: roomName, roomName, serverId: SERVER_ID });

      // Evitar duplicados: si el mismo username ya esta en alguna sala, echar la sesion vieja
      const unameKey = player.username.toLowerCase();
      for (const r of rooms.values()) {
        for (const [pid, pl] of [...r.players.entries()]) {
          if (pl !== player && pl.username && pl.username.toLowerCase() === unameKey) {
            try {
              r.players.delete(pid);
              broadcast(r, { type: "playerLeft", id: pid, username: censorText(pl.username), count: r.players.size });
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
        send(p.ws, { type: "chat", username: "Sistema", message: censorText(player.username) + " se unio a la partida.", system: true, ts: Date.now() });
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
      const message = censorText(safeText(data.message, "", MAX_CHAT_LEN));
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
        send(p.ws, { type: "chat", username: "Sistema", message: censorText(name) + " salio de la partida.", system: true, ts: Date.now() });
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
