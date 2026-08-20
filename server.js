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
const sessionStamps = new Map();
const SESSION_TTL_MS = Infinity; // las sesiones NO caducan nunca
const presence = new Map();
const trades = new Map();
const tradeByUser = new Map();
const MAX_TRADE_ITEMS = 20;
const MAX_TRADE_SUNNYS = 9999999;
const PRESENCE_TTL_MS = 25000;

const publicDir = path.join(__dirname, "public");
const indexPath = path.join(publicDir, "index.html");
const dataDir = process.env.EPICBLOXS_DATA_DIR
  ? path.resolve(process.env.EPICBLOXS_DATA_DIR)
  : path.join(__dirname, "data");
const usersPath = path.join(dataDir, "users.json");
const catalogPath = path.join(dataDir, "catalog.json");
const sessionsPath = path.join(dataDir, "sessions.json");
const dmsPath = path.join(dataDir, "dms.json");
const groupsPath = path.join(dataDir, "groups.json");
const sessionSecretPath = path.join(dataDir, "session-secret.txt");
const adminsPath = path.join(dataDir, "admins.json");

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(usersPath)) fs.writeFileSync(usersPath, "{}", "utf8");
  if (!fs.existsSync(catalogPath)) fs.writeFileSync(catalogPath, "[]", "utf8");
  if (!fs.existsSync(adminsPath)) fs.writeFileSync(adminsPath, "[]", "utf8");

  // Si usamos /var/data en Render y el disco persistente se acaba de crear,
  // copia una base inicial del repositorio SOLO si el almacenamiento persistente
  // todavía está vacío. Nunca sobrescribe cuentas existentes.
  try {
    const repoUsers = path.join(__dirname, "data", "users.json");
    const repoCatalog = path.join(__dirname, "data", "catalog.json");
    const currentUsers = readJsonObject(usersPath);
    if (Object.keys(currentUsers).length === 0 && fs.existsSync(repoUsers)) {
      const seedUsers = readJsonObject(repoUsers);
      if (Object.keys(seedUsers).length) fs.writeFileSync(usersPath, JSON.stringify(seedUsers, null, 2), "utf8");
    }
    const currentCatalog = (() => { try { return JSON.parse(fs.readFileSync(catalogPath, "utf8") || "[]"); } catch { return []; } })();
    if (!currentCatalog.length && fs.existsSync(repoCatalog)) {
      const seedCatalog = (() => { try { return JSON.parse(fs.readFileSync(repoCatalog, "utf8") || "[]"); } catch { return []; } })();
      if (Array.isArray(seedCatalog) && seedCatalog.length) fs.writeFileSync(catalogPath, JSON.stringify(seedCatalog, null, 2), "utf8");
    }
  } catch {}
}

function getPersistentSessionSecret() {
  ensureDataDir();
  if (process.env.SESSION_SECRET) return String(process.env.SESSION_SECRET);
  try {
    if (fs.existsSync(sessionSecretPath)) {
      const existing = fs.readFileSync(sessionSecretPath, "utf8").trim();
      if (existing) return existing;
    }
    const generated = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(sessionSecretPath, generated, "utf8");
    return generated;
  } catch {
    // Fallback for local read-only environments.
    return "epicbloxs-session-key-v1";
  }
}

function readJsonObject(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw || "{}");
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function mergeUserStores(target, source) {
  let changed = false;
  for (const [key, value] of Object.entries(source || {})) {
    if (!value || typeof value !== "object") continue;
    const normalizedKey = String(key).trim().toLowerCase();
    if (!normalizedKey) continue;
    // El archivo principal siempre gana. Los backups/archivos antiguos solo
    // recuperan cuentas que ya no estén en el registro actual.
    if (!target[normalizedKey]) {
      target[normalizedKey] = value;
      changed = true;
    }
  }
  return changed;
}

function loadUsers() {
  ensureDataDir();
  const users = readJsonObject(usersPath);
  let changed = false;

  // El proyecto traía una cuenta de prueba llamada SebUser. No es una cuenta
  // real y nunca debe volver a aparecer en el buscador. Solo eliminamos esa
  // semilla exacta; cualquier otra cuenta se conserva.
  const fakeSeedHash = "ca7afd6a5b83ee0bc412d15c060f8388fa35e192e7d9086fa8bb4ebe88695166";
  for (const [key, value] of Object.entries(users)) {
    if (String(key).toLowerCase() === "sebuser" && value && value.passwordHash === fakeSeedHash && Number(value.userId) === 1001) {
      delete users[key];
      changed = true;
    }
  }

  // Recuperación automática de cuentas antiguas. Esto permite actualizar el
  // servidor sin perder cuentas que estaban en una versión anterior.
  const legacyFiles = [
    path.join(dataDir, "users.backup.json"),
    path.join(dataDir, "users.legacy.json"),
    path.join(dataDir, "accounts.json"),
    path.join(dataDir, "accounts.backup.json"),
    path.join(dataDir, "old_users.json")
  ];
  for (const file of legacyFiles) changed = mergeUserStores(users, readJsonObject(file)) || changed;

  if (changed) saveUsersDisk(users);
  return users;
}

function saveUsersDisk(users) {
  ensureDataDir();
  const clean = users && typeof users === "object" ? users : {};
  const tempPath = usersPath + ".tmp";
  const backupPath = path.join(dataDir, "users.backup.json");
  try {
    // Backup antes de cada escritura: si una actualización falla, las cuentas
    // antiguas siguen disponibles para la recuperación automática.
    if (fs.existsSync(usersPath)) {
      try { fs.copyFileSync(usersPath, backupPath); } catch {}
    }
    fs.writeFileSync(tempPath, JSON.stringify(clean, null, 2), "utf8");
    fs.renameSync(tempPath, usersPath);
  } catch (err) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
    console.error("No se pudo guardar users.json:", err.message);
    throw err;
  }
}

// Las sesiones se guardan en disco para que el token siga sirviendo aunque
// el servidor se reinicie o se duerma (antes daba "No autenticado.").
function loadSessionsDisk() {
  try {
    ensureDataDir();
    const raw = JSON.parse(fs.readFileSync(sessionsPath, "utf8") || "{}");
    const now = Date.now();
    let changed = false;
    for (const [token, entry] of Object.entries(raw)) {
      const key = typeof entry === "string" ? entry : entry && entry.key;
      const ts = (entry && entry.ts) || now;
      if (!key) { changed = true; continue; } // nunca se descartan por tiempo
      sessions.set(token, key);
      sessionStamps.set(token, ts);
    }
    if (changed) saveSessionsDisk();
  } catch {}
}

function saveSessionsDisk() {
  try {
    ensureDataDir();
    const out = {};
    for (const [token, key] of sessions.entries()) {
      out[token] = { key, ts: sessionStamps.get(token) || Date.now() };
    }
    fs.writeFileSync(sessionsPath, JSON.stringify(out), "utf8");
  } catch {}
}

function registerSession(token, key) {
  sessions.set(token, key);
  sessionStamps.set(token, Date.now());
  saveSessionsDisk();
}

// ---- Mensajes directos (chat privado) ----
function loadDMs() {
  try { ensureDataDir(); return JSON.parse(fs.readFileSync(dmsPath, "utf8") || "{}"); } catch { return {}; }
}
function saveDMs(data) {
  try { ensureDataDir(); fs.writeFileSync(dmsPath, JSON.stringify(data), "utf8"); } catch {}
}
function loadGroups() {
  try { ensureDataDir(); return JSON.parse(fs.readFileSync(groupsPath, "utf8") || "{}"); } catch { return {}; }
}
function saveGroups(data) {
  try { ensureDataDir(); fs.writeFileSync(groupsPath, JSON.stringify(data), "utf8"); } catch {}
}
function dmConvKey(a, b) {
  return [String(a), String(b)].sort().join("|");
}
function tradeId() {
  return "TRD-" + crypto.randomBytes(8).toString("hex");
}

function normalizeTradeItems(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of items.slice(0, MAX_TRADE_ITEMS)) {
    const id = String(raw ?? "").trim().slice(0, 160);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function removeTradeIndexesForUser(key, tradeIdValue) {
  if (tradeByUser.get(key) === tradeIdValue) tradeByUser.delete(key);
}

function friendPair(users, aKey, bKey) {
  const a = users[aKey], b = users[bKey];
  return !!(a && b && aKey !== bKey && Array.isArray(a.friends) && a.friends.includes(bKey) && Array.isArray(b.friends) && b.friends.includes(aKey));
}

function tradeSummaryForUser(trade, viewerKey, users) {
  const fromUser = users[trade.from], toUser = users[trade.to];
  const from = trade.from === viewerKey ? fromUser : toUser;
  const other = trade.from === viewerKey ? toUser : fromUser;
  return {
    id: trade.id,
    status: trade.status,
    createdAt: trade.createdAt,
    from: { id: String(fromUser.userId), username: fromUser.username },
    to: { id: String(toUser.userId), username: toUser.username },
    other: { id: String(other.userId), username: other.username },
    youOffer: trade.from === viewerKey ? { sunnys: trade.fromSunnys, items: trade.fromItems } : { sunnys: trade.toSunnys, items: trade.toItems },
    theyOffer: trade.from === viewerKey ? { sunnys: trade.toSunnys, items: trade.toItems } : { sunnys: trade.fromSunnys, items: trade.fromItems },
    accepted: trade.accepted
  };
}

function collectTradeState(viewerKey, users) {
  const incoming = [], outgoing = [];
  for (const trade of trades.values()) {
    if (trade.status !== "pending") continue;
    if (trade.to === viewerKey) incoming.push(tradeSummaryForUser(trade, viewerKey, users));
    if (trade.from === viewerKey) outgoing.push(tradeSummaryForUser(trade, viewerKey, users));
  }
  incoming.sort((a,b)=>b.createdAt-a.createdAt);
  outgoing.sort((a,b)=>b.createdAt-a.createdAt);
  return { incoming, outgoing };
}

function validateTradeOffer(user, items, sunnys) {
  const inv = Array.isArray(user.avatarInventory) ? user.avatarInventory : [];
  const counts = new Map();
  for (const id of inv) counts.set(id, (counts.get(id) || 0) + 1);
  for (const id of items) {
    if ((counts.get(id) || 0) !== 1) return `No puedes intercambiar ${id}: el artículo no está en una cantidad segura. Vacía/repara tu inventario antes de comerciar.`;
  }
  if (!Number.isSafeInteger(sunnys) || sunnys < 0 || sunnys > MAX_TRADE_SUNNYS) return "Cantidad de Sunnys inválida.";
  if (sunnys > Number(user.sunnys || 0)) return "No tienes suficientes Sunnys para esa oferta.";
  return null;
}

function finishTrade(trade, users) {
  const a = users[trade.from], b = users[trade.to];
  if (!a || !b) throw new Error("Una de las cuentas ya no existe.");
  if (!friendPair(users, trade.from, trade.to)) throw new Error("Ya no son amigos. El Trade fue cancelado.");

  const aErr = validateTradeOffer(a, trade.fromItems, trade.fromSunnys);
  if (aErr) throw new Error("La oferta de " + a.username + " ya no es válida: " + aErr);
  const bErr = validateTradeOffer(b, trade.toItems, trade.toSunnys);
  if (bErr) throw new Error("La oferta de " + b.username + " ya no es válida: " + bErr);

  const overlap = new Set(trade.fromItems);
  for (const id of trade.toItems) if (overlap.has(id)) throw new Error("No se puede intercambiar el mismo artículo en ambos lados.");

  const bInv = Array.isArray(b.avatarInventory) ? b.avatarInventory : [];
  const aInv = Array.isArray(a.avatarInventory) ? a.avatarInventory : [];
  for (const id of trade.fromItems) if (bInv.includes(id)) throw new Error(`${b.username} ya posee ${id}.`);
  for (const id of trade.toItems) if (aInv.includes(id)) throw new Error(`${a.username} ya posee ${id}.`);

  a.avatarInventory = aInv.filter(id => !trade.fromItems.includes(id));
  b.avatarInventory = bInv.filter(id => !trade.toItems.includes(id));
  a.avatarInventory.push(...trade.toItems);
  b.avatarInventory.push(...trade.fromItems);
  a.sunnys = Number(a.sunnys || 0) - trade.fromSunnys + trade.toSunnys;
  b.sunnys = Number(b.sunnys || 0) - trade.toSunnys + trade.fromSunnys;
  a.inventory = []; b.inventory = [];

  const fromSet = new Set(trade.fromItems);
  const toSet = new Set(trade.toItems);
  a.avatar.accessories = (Array.isArray(a.avatar && a.avatar.accessories) ? a.avatar.accessories : []).filter(id => !fromSet.has(id));
  b.avatar.accessories = (Array.isArray(b.avatar && b.avatar.accessories) ? b.avatar.accessories : []).filter(id => !toSet.has(id));

  users[trade.from] = a; users[trade.to] = b;
  saveUsersDisk(users);
}


function loadCatalog() {
  try { ensureDataDir(); return JSON.parse(fs.readFileSync(catalogPath, "utf8") || "[]"); } catch { return []; }
}
function saveCatalog(items) {
  ensureDataDir();
  fs.writeFileSync(catalogPath, JSON.stringify(items, null, 2), "utf8");
}

function loadAccessConfig() {
  ensureDataDir();
  try {
    const raw = JSON.parse(fs.readFileSync(adminsPath, "utf8") || "[]");
    // Compatibilidad: la versión anterior usaba simplemente ["User1","User2"].
    if (Array.isArray(raw)) return { admins: raw, creators: [] };
    if (raw && typeof raw === "object") {
      return {
        admins: Array.isArray(raw.admins) ? raw.admins : [],
        creators: Array.isArray(raw.creators) ? raw.creators : []
      };
    }
  } catch {}
  return { admins: [], creators: [] };
}

function loadAdmins() {
  return loadAccessConfig().admins
    .map(v => String(v).trim())
    .filter(Boolean);
}

function loadCreators() {
  return loadAccessConfig().creators
    .map(v => String(v).trim())
    .filter(Boolean);
}

function matchesConfiguredUser(user, key, values) {
  const configured = new Set(values.map(v => String(v).trim().toLowerCase()).filter(Boolean));
  return configured.has(String(key || "").toLowerCase())
    || configured.has(String(user?.username || "").trim().toLowerCase())
    || configured.has(String(user?.userId || "").trim().toLowerCase());
}

function isAdminUser(user, key) {
  if (!user) return false;
  const configured = loadAdmins();
  const envValues = String(process.env.ADMIN_USER_IDS || process.env.EPICBLOXS_ADMIN_USERS || "")
    .split(",").map(v => v.trim()).filter(Boolean);
  configured.push(...envValues);
  const owner = String(process.env.EPICBLOXS_OWNER_USERNAME || "").trim();
  if (owner) configured.push(owner);
  return matchesConfiguredUser(user, key, configured);
}

function isCreatorUser(user, key) {
  if (!user) return false;
  const configured = loadCreators();
  const envValues = String(process.env.CREATOR_USER_IDS || process.env.EPICBLOXS_CREATORS || "")
    .split(",").map(v => v.trim()).filter(Boolean);
  configured.push(...envValues);
  return matchesConfiguredUser(user, key, configured) || isAdminUser(user, key);
}

function banRemainingMs(user) {
  const until = Number(user && user.banUntil || 0);
  return Number.isFinite(until) && until > Date.now() ? until - Date.now() : 0;
}

function banMessage(user) {
  const remaining = banRemainingMs(user);
  if (!remaining) return "";
  const days = Math.max(1, Math.ceil(remaining / 86400000));
  return `Esta cuenta esta baneada por ${days} dia(s).${user.banReason ? " Motivo: " + user.banReason : ""}`;
}

function normalizeAvatarData(user) {
  if (!user || typeof user !== "object") return;
  user.avatar = user.avatar && typeof user.avatar === "object" ? user.avatar : {};
  if (!Array.isArray(user.avatar.accessories)) user.avatar.accessories = [];
  user.avatar.colors = user.avatar.colors && typeof user.avatar.colors === "object"
    ? user.avatar.colors : { head:"#f5c928", arms:"#f5c928", torso:"#1477b9", legs:"#8cae45" };
  if (!user.avatar.torsoType) user.avatar.torsoType = "male";
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

// Secreto de firma persistente. En Render se guarda dentro del disco de datos,
// así un redeploy no invalida los tokens existentes. SESSION_SECRET sigue
// teniendo prioridad si el propietario del servidor la configuró.
const SESSION_SECRET = getPersistentSessionSecret();

function signSession(payload) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex").slice(0, 32);
}

function makeToken(key) {
  // Token firmado y SIN caducidad: se puede validar sin guardar nada.
  if (key) {
    const payload = Buffer.from(String(key), "utf8").toString("base64url") + "." + crypto.randomBytes(6).toString("hex");
    return payload + "." + signSession(payload);
  }
  return crypto.randomBytes(24).toString("hex");
}

// Si el token no esta en memoria ni en disco, se acepta cuando la firma es valida.
function keyFromSignedToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const payload = parts[0] + "." + parts[1];
  if (signSession(payload) !== parts[2]) return null;
  try { return Buffer.from(parts[0], "base64url").toString("utf8") || null; } catch { return null; }
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

// Normaliza cuentas antiguas para que TODAS (incluso las creadas hace mucho)
// tengan ID numerico, listas de amigos y los campos que usa la web actual.
function ensureUserIds(users) {
  let changed = false;
  let next = nextNumericUserId(users);
  for (const [key, user] of Object.entries(users || {})) {
    if (!user || typeof user !== "object") continue;
    if (!Number.isInteger(Number(user.userId))) {
      user.userId = next++;
      changed = true;
    }
    if (typeof user.username !== "string" || !user.username.trim()) {
      user.username = key;
      changed = true;
    }
    for (const field of ["friends", "friendRequests", "outgoingRequests"]) {
      if (!Array.isArray(user[field])) { user[field] = []; changed = true; }
    }
    if (!Array.isArray(user.avatarInventory)) {
      user.avatarInventory = Array.isArray(user.inventory) ? user.inventory.slice(0, 20) : [];
      changed = true;
    }
    if (Array.isArray(user.avatarInventory) && user.avatarInventory.length > 20) { user.avatarInventory = user.avatarInventory.slice(0, 20); changed = true; }
    if (!Array.isArray(user.gameInventory)) { user.gameInventory = []; changed = true; }
    if (Array.isArray(user.gameInventory) && user.gameInventory.length > 20) { user.gameInventory = user.gameInventory.slice(0, 20); changed = true; }
    if (!user.avatar || typeof user.avatar !== "object") {
      user.avatar = { accessories: [], torsoType: "male", colors: { head: "#f5c928", arms: "#f5c928", torso: "#1477b9", legs: "#8cae45" } };
      changed = true;
    }
    if (!Array.isArray(user.avatar.accessories)) { user.avatar.accessories = []; changed = true; }
    if (typeof user.banUntil !== "number") { user.banUntil = 0; changed = true; }
    if (typeof user.banReason !== "string") { user.banReason = ""; changed = true; }
    if (!user.avatar.colors || typeof user.avatar.colors !== "object") {
      user.avatar.colors = { head: "#f5c928", arms: "#f5c928", torso: "#1477b9", legs: "#8cae45" };
      changed = true;
    }
    if (typeof user.createdAt !== "string" || !user.createdAt) {
      user.createdAt = new Date(0).toISOString();
      changed = true;
    }
  }
  if (changed) saveUsersDisk(users);
  return users;
}

// Registro global: cada cuenta que se crea queda en users.json y las cuentas
// antiguas se normalizan sin borrarse. Se ejecuta al arrancar y en cada
// operación que depende del registro.
function syncUserRegistry() {
  return ensureUserIds(loadUsers());
}

// Relacion entre la cuenta que consulta y otra cuenta cualquiera.
function relationBetween(users, myKey, otherKey) {
  if (!myKey || !otherKey) return "none";
  if (myKey === otherKey) return "self";
  const me = users[myKey] || {};
  if ((me.friends || []).includes(otherKey)) return "friend";
  if ((me.outgoingRequests || []).includes(otherKey)) return "outgoing";
  if ((me.friendRequests || []).includes(otherKey)) return "incoming";
  return "none";
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
    banUntil: 0,
    banReason: "",
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
    avatarInventory: (user.avatarInventory || user.inventory || []).slice(0, 20),
    gameInventory: (user.gameInventory || []).slice(0, 20),
    inventory: [],
    friends: user.friends || [],
    friendRequests: user.friendRequests || [],
    outgoingRequests: user.outgoingRequests || [],
    bannedUntil: Number(user.banUntil || 0),
    isAdmin: isAdminUser(user, key),
    isCreator: isCreatorUser(user, key),
    createdAt: user.createdAt
  };
}

function getSessionUser(req) {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || token.length < 20) return null;

  // Primero usamos la tabla de sesiones persistida. Si el servidor se reinició,
  // también podemos reconstruir una sesión desde el token firmado.
  let key = sessions.get(token);
  if (!key) {
    key = keyFromSignedToken(token);
    if (!key) return null;
    const users = ensureUserIds(loadUsers());
    if (!users[key]) return null;
    registerSession(token, key);
  }

  sessionStamps.set(token, Date.now());
  const users = ensureUserIds(loadUsers());
  if (!users[key]) {
    sessions.delete(token);
    sessionStamps.delete(token);
    saveSessionsDisk();
    return null;
  }
  if (banRemainingMs(users[key]) > 0 && !isAdminUser(users[key], key)) {
    sessions.delete(token);
    sessionStamps.delete(token);
    saveSessionsDisk();
    return null;
  }
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
    const online = [...rooms.values()].reduce((n, room) => n + room.players.size, 0);
    let accounts = 0;
    try { accounts = Object.keys(syncUserRegistry()).length; } catch (err) {
      console.error("Health datastore warning:", err.message);
    }
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
    const users = syncUserRegistry();
    if (users[key]) return json(res, 409, { error: "Ese usuario ya existe." });
    users[key] = defaultUser(username, hashPassword(password), nextNumericUserId(users));
    saveUsersDisk(users);
    const token = makeToken(key);
    registerSession(token, key);
    return json(res, 200, { token, user: publicUser(users[key], key) });
  }

  if (urlPath === "/api/login" && req.method === "POST") {
    const body = await readBody(req);
    const key = safeText(body.username, "", 20).toLowerCase();
    const password = String(body.password || "");
    const users = syncUserRegistry();
    const user = users[key];
    if (user && banRemainingMs(user) > 0) return json(res, 403, { error: banMessage(user) });
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
    const token = makeToken(key);
    registerSession(token, key);
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
    if (Array.isArray(body.avatarInventory)) user.avatarInventory = body.avatarInventory.slice(0, 20);
    normalizeAvatarData(user);
    // Nunca permitas equipar un objeto que la cuenta no posee.
    // Esto tambien repara cuentas antiguas que perdieron la separacion entre inventario y equipamiento.
    const ownedAvatarItems = new Set(Array.isArray(user.avatarInventory) ? user.avatarInventory : []);
    user.avatar.accessories = user.avatar.accessories
      .map(id => String(id))
      .filter((id, i, arr) => arr.indexOf(id) === i && ownedAvatarItems.has(id))
      .slice(0, 20);
    if (Array.isArray(body.gameInventory)) user.gameInventory = body.gameInventory.slice(0, 20);
    // Compatibilidad con versiones anteriores: nunca vuelve a usarse como inventario de juego.
    user.inventory = [];
    if (typeof body.sunnys === "number") user.sunnys = Math.max(0, Math.min(9999999, body.sunnys));
    if (typeof body.bio === "string") user.bio = safeText(body.bio, user.bio, 200);
    if (typeof body.theme === "string") user.theme = ["light","dark","blue","purple"].includes(body.theme) ? body.theme : (user.theme || "light");
    if (body.avatar && body.avatar.torsoType) {
      user.avatar = user.avatar || {};
      user.avatar.torsoType = body.avatar.torsoType === "female" ? "female" : "male";
    }
    users[sess.key] = user;
    saveUsersDisk(users);
    return json(res, 200, { user: publicUser(user, sess.key) });
  }


  if (urlPath === "/api/trade/state" && req.method === "GET") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const users = syncUserRegistry();
    return json(res, 200, collectTradeState(sess.key, users));
  }

  if (urlPath === "/api/trade/offer" && req.method === "POST") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const users = syncUserRegistry();
    const me = users[sess.key];
    const body = await readBody(req);
    const targetKey = resolveUserKey(users, body.id ?? body.username ?? "");
    if (!targetKey || targetKey === sess.key) return json(res, 400, { error: "Amigo no encontrado." });
    if (!friendPair(users, sess.key, targetKey)) return json(res, 403, { error: "Solo puedes hacer Trade con amigos." });
    if (tradeByUser.has(sess.key) || tradeByUser.has(targetKey)) return json(res, 409, { error: "Uno de los jugadores ya tiene un Trade pendiente. Esperen a terminarlo o rechazarlo." });

    const fromItems = normalizeTradeItems(body.items);
    const fromSunnys = Number(body.sunnys || 0);
    const err = validateTradeOffer(me, fromItems, fromSunnys);
    if (err) return json(res, 400, { error: err });

    const trade = { id: tradeId(), from: sess.key, to: targetKey, fromItems, toItems: [], fromSunnys, toSunnys: 0, accepted: { [sess.key]: false, [targetKey]: false }, status: "pending", createdAt: Date.now() };
    trades.set(trade.id, trade); tradeByUser.set(sess.key, trade.id); tradeByUser.set(targetKey, trade.id);
    return json(res, 201, { ok: true, trade: tradeSummaryForUser(trade, sess.key, users) });
  }

  if (urlPath === "/api/trade/respond" && req.method === "POST") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const users = syncUserRegistry();
    const body = await readBody(req);
    const trade = trades.get(String(body.tradeId || ""));
    const action = String(body.action || "").toLowerCase();
    if (!trade || trade.status !== "pending") return json(res, 404, { error: "Ese Trade ya no está disponible." });
    if (trade.from !== sess.key && trade.to !== sess.key) return json(res, 403, { error: "No puedes modificar este Trade." });

    if (action === "decline" || action === "cancel") {
      trade.status = "cancelled";
      trades.delete(trade.id);
      removeTradeIndexesForUser(trade.from, trade.id);
      removeTradeIndexesForUser(trade.to, trade.id);
      return json(res, 200, { ok: true, status: "cancelled" });
    }

    if (action === "accept") {
      trade.accepted[sess.key] = true;
      if (trade.accepted[trade.from] && trade.accepted[trade.to]) {
        try { finishTrade(trade, users); }
        catch (err) {
          trades.delete(trade.id);
          removeTradeIndexesForUser(trade.from, trade.id);
          removeTradeIndexesForUser(trade.to, trade.id);
          return json(res, 409, { error: err.message || "El Trade no pudo completarse. No se cambió ningún inventario." });
        }
        trades.delete(trade.id);
        removeTradeIndexesForUser(trade.from, trade.id);
        removeTradeIndexesForUser(trade.to, trade.id);
        return json(res, 200, { ok: true, status: "completed", users: { self: publicUser(users[sess.key], sess.key) } });
      }
      return json(res, 200, { ok: true, status: "pending", trade: tradeSummaryForUser(trade, sess.key, users) });
    }

    return json(res, 400, { error: "Acción de Trade inválida." });
  }

  if (urlPath === "/api/users/search" && req.method === "GET") {
    const params = new URL(req.url, "http://x").searchParams;
    const rawQuery = safeText(params.get("q"), "", 40);
    const q = rawQuery.toLowerCase();
    const limit = Math.max(1, Math.min(5000, Number(params.get("limit")) || 500));
    const users = syncUserRegistry();
    const sess = getSessionUser(req);
    const myKey = sess ? sess.key : null;
    const results = [];
    // El buscador de amigos usa EXCLUSIVAMENTE cuentas registradas en EpicBloxs.
    // Nunca toma jugadores de rooms/WebSocket: estar en una partida no crea una cuenta.
    for (const [key, user] of Object.entries(users)) {
      const username = String(user.username || "");
      const usernameLower = username.toLowerCase();
      const idText = String(user.userId || "");
      const match = !q || key.includes(q) || usernameLower.includes(q) || idText === q;
      if (!match) continue;
      results.push({
        id: String(user.userId),
        userId: Number(user.userId),
        usernameKey: key,
        username,
        bio: user.bio || "",
        avatar: user.avatar || {},
        createdAt: user.createdAt || "",
        presence: getPresence(key),
        relation: relationBetween(users, myKey, key)
      });
    }
    results.sort((a, b) => {
      const ae = String(a.username || "").toLowerCase() === q;
      const be = String(b.username || "").toLowerCase() === q;
      if (ae !== be) return ae ? -1 : 1;
      const ap = (a.presence && (a.presence.playing || a.presence.online)) ? 0 : 1;
      const bp = (b.presence && (b.presence.playing || b.presence.online)) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return String(a.username || "").localeCompare(String(b.username || ""));
    });
    return json(res, 200, {
      total: results.length,
      results: results.slice(0, limit),
      exact: results.find(r => String(r.username || "").toLowerCase() === q) || null
    });
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
      const sess = getSessionUser(req);
      return json(res, 200, {
        user: {
          ...publicFriendUser(users[key], key),
          relation: relationBetween(users, sess ? sess.key : null, key)
        }
      });
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
    if (me.outgoingRequests.includes(targetKey)) {
      return json(res, 400, { error: "No se pudo enviar la solicitud: ya tienes una solicitud pendiente para este usuario." });
    }
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

  if (urlPath === "/api/friends/cancel" && req.method === "POST") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const body = await readBody(req);
    const users = ensureUserIds(sess.users);
    const targetKey = resolveUserKey(users, safeText(body.id || body.username, "", 80));
    if (!targetKey) return json(res, 404, { error: "Usuario no encontrado." });
    const me = users[sess.key];
    me.outgoingRequests = (me.outgoingRequests || []).filter((k) => k !== targetKey);
    if (users[targetKey]) {
      users[targetKey].friendRequests = (users[targetKey].friendRequests || []).filter((k) => k !== sess.key);
    }
    users[sess.key] = me; saveUsersDisk(users);
    return json(res, 200, { ok: true, user: publicUser(me, sess.key) });
  }

  if (urlPath === "/api/friends/remove" && req.method === "POST") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const body = await readBody(req);
    const users = ensureUserIds(sess.users);
    const targetKey = resolveUserKey(users, safeText(body.id || body.username, "", 80));
    if (!targetKey) return json(res, 404, { error: "Usuario no encontrado." });
    const me = users[sess.key];
    me.friends = (me.friends || []).filter((k) => k !== targetKey);
    me.outgoingRequests = (me.outgoingRequests || []).filter((k) => k !== targetKey);
    me.friendRequests = (me.friendRequests || []).filter((k) => k !== targetKey);
    if (users[targetKey]) {
      const other = users[targetKey];
      other.friends = (other.friends || []).filter((k) => k !== sess.key);
      other.outgoingRequests = (other.outgoingRequests || []).filter((k) => k !== sess.key);
      other.friendRequests = (other.friendRequests || []).filter((k) => k !== sess.key);
      users[targetKey] = other;
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
    if (!isCreatorUser(sess.user, sess.key)) {
      return json(res, 403, { error: "Solo los creadores autorizados pueden publicar ropa." });
    }
    const body = await readBody(req);
    const name = safeText(body.name, "", 40);
    const description = safeText(body.description, "", 200);
    // Solo se publica ROPA 2D (camisas y pantalones). El creador de accesorios 3D fue retirado.
    const category = ["shirts","pants"].includes(body.category) ? body.category : "shirts";
    const type = "2d";
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
    if (!body.data || !body.data.imageData) return json(res, 400, { error: "Falta el diseno de la ropa." });
    if (!/^data:image\/(png|jpeg|webp);base64,/i.test(String(body.data.imageData))) {
      return json(res, 400, { error: "Formato de imagen no permitido." });
    }
    const items = loadCatalog();
    const item = {
      id: "U-" + Date.now() + "-" + Math.random().toString(36).slice(2,7),
      ownerId: Number(sess.user.userId), owner: sess.user.username, name, description, category, type, price,
      data: body.data || {}, status: "approved",
      createdAt: new Date().toISOString(),
      publishedAt: new Date().toISOString()
    };
    items.push(item);
    saveCatalog(items);
    return json(res, 200, { ok: true, published: true, item, message: "Publicado en el catalogo correctamente." });
  }


  // ================= ADMINISTRACION =================
  if (urlPath === "/api/admin/status" && req.method === "GET") {
    const sess = getSessionUser(req);
    if (!sess || !isAdminUser(sess.user, sess.key)) return json(res, 403, { error: "No tienes permisos de administrador." });
    const users = syncUserRegistry();
    const catalog = loadCatalog();
    return json(res, 200, {
      ok: true,
      isAdmin: true,
      creators: loadCreators(),
      users: Object.entries(users).map(([key, user]) => ({
        id: String(user.userId), username: user.username, usernameKey: key,
        sunnys: Number(user.sunnys || 0), banUntil: Number(user.banUntil || 0),
        createdAt: user.createdAt || ""
      })),
      items: catalog.filter(item => item && item.ownerId != null).map(item => ({
        id: item.id, name: item.name, category: item.category, type: item.type,
        ownerId: item.ownerId, owner: item.owner, price: Number(item.price || 0),
        status: item.status || "approved", createdAt: item.createdAt || ""
      }))
    });
  }

  if (urlPath === "/api/admin/gift-sunnys" && req.method === "POST") {
    const sess = getSessionUser(req);
    if (!sess || !isAdminUser(sess.user, sess.key)) return json(res, 403, { error: "No tienes permisos de administrador." });
    const body = await readBody(req);
    const users = syncUserRegistry();
    const targetKey = resolveUserKey(users, body.target ?? body.username ?? body.id);
    if (!targetKey || !users[targetKey]) return json(res, 404, { error: "Usuario no encontrado." });
    const amount = Math.floor(Number(body.amount));
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > 9999999) return json(res, 400, { error: "Cantidad de Sunnys invalida." });
    users[targetKey].sunnys = Math.min(9999999, Number(users[targetKey].sunnys || 0) + amount);
    saveUsersDisk(users);
    return json(res, 200, { ok: true, user: publicUser(users[targetKey], targetKey), gifted: amount });
  }

  if (urlPath === "/api/admin/ban" && req.method === "POST") {
    const sess = getSessionUser(req);
    if (!sess || !isAdminUser(sess.user, sess.key)) return json(res, 403, { error: "No tienes permisos de administrador." });
    const body = await readBody(req);
    const users = syncUserRegistry();
    const targetKey = resolveUserKey(users, body.target ?? body.username ?? body.id);
    if (!targetKey || !users[targetKey]) return json(res, 404, { error: "Usuario no encontrado." });
    if (isAdminUser(users[targetKey], targetKey)) return json(res, 400, { error: "No puedes banear a otro administrador desde este panel." });
    const days = Math.floor(Number(body.days));
    if (!Number.isSafeInteger(days) || days < 1 || days > 36500) return json(res, 400, { error: "Los dias deben estar entre 1 y 36500." });
    users[targetKey].banUntil = Date.now() + days * 86400000;
    users[targetKey].banReason = safeText(body.reason || "", "", 160);
    saveUsersDisk(users);

    for (const [token, key] of [...sessions.entries()]) {
      if (key === targetKey) {
        sessions.delete(token); sessionStamps.delete(token);
      }
    }
    saveSessionsDisk();
    closePlayersByAccount(targetKey, 4003, "Cuenta baneada");
    return json(res, 200, { ok: true, username: users[targetKey].username, banUntil: users[targetKey].banUntil });
  }

  if (urlPath === "/api/admin/unban" && req.method === "POST") {
    const sess = getSessionUser(req);
    if (!sess || !isAdminUser(sess.user, sess.key)) return json(res, 403, { error: "No tienes permisos de administrador." });
    const body = await readBody(req);
    const users = syncUserRegistry();
    const targetKey = resolveUserKey(users, body.target ?? body.username ?? body.id);
    if (!targetKey || !users[targetKey]) return json(res, 404, { error: "Usuario no encontrado." });
    users[targetKey].banUntil = 0;
    users[targetKey].banReason = "";
    saveUsersDisk(users);
    return json(res, 200, { ok: true });
  }

  if (urlPath === "/api/admin/delete-item" && req.method === "POST") {
    const sess = getSessionUser(req);
    if (!sess || !isAdminUser(sess.user, sess.key)) return json(res, 403, { error: "No tienes permisos de administrador." });
    const body = await readBody(req);
    const itemId = safeText(body.itemId, "", 180);
    if (!itemId) return json(res, 400, { error: "Falta el ID del articulo." });
    const catalog = loadCatalog();
    const item = catalog.find(x => String(x.id) === itemId);
    if (!item) return json(res, 404, { error: "Ropa no encontrada." });
    if (item.ownerId == null) return json(res, 400, { error: "Ese objeto no fue creado por un jugador." });
    const nextCatalog = catalog.filter(x => String(x.id) !== itemId);
    saveCatalog(nextCatalog);

    const users = syncUserRegistry();
    for (const [key, user] of Object.entries(users)) {
      if (Array.isArray(user.avatarInventory)) user.avatarInventory = user.avatarInventory.filter(id => id !== itemId);
      if (Array.isArray(user.avatar && user.avatar.accessories)) user.avatar.accessories = user.avatar.accessories.filter(id => id !== itemId);
      users[key] = user;
    }
    saveUsersDisk(users);
    return json(res, 200, { ok: true, deleted: itemId });
  }

  if (urlPath === "/api/streak/claim" && req.method === "POST") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const users = sess.users;
    const user = users[sess.key];
    const now = new Date();
    const today = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
    if (user.lastStreakClaim === today) return json(res, 409, { error: "Ya reclamaste la racha de hoy.", user: publicUser(user, sess.key) });
    const yesterdayDate = new Date(now);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = yesterdayDate.getFullYear() + "-" + String(yesterdayDate.getMonth() + 1).padStart(2, "0") + "-" + String(yesterdayDate.getDate()).padStart(2, "0");
    user.loginStreak = user.lastStreakClaim === yesterday ? (Number(user.loginStreak) || 0) + 1 : 1;
    const reward = Math.min(500, 25 + user.loginStreak * 25);
    user.sunnys = (Number(user.sunnys) || 0) + reward;
    user.lastStreakClaim = today;
    users[sess.key] = user;
    saveUsersDisk(users);
    return json(res, 200, { ok: true, reward, user: publicUser(user, sess.key) });
  }

  // ================= GRUPOS (hasta 20 amigos por grupo) =================
  if (urlPath === "/api/groups" && req.method === "GET") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const users = sess.users;
    const groups = loadGroups();
    const result = Object.values(groups).filter(group => Array.isArray(group.memberKeys) && group.memberKeys.includes(sess.key)).map(group => {
      const messages = Array.isArray(group.messages) ? group.messages : [];
      const readAt = (group.readAt || {})[sess.key] || 0;
      const last = messages[messages.length - 1] || null;
      return {
        id: group.id, name: group.name, ownerId: String(users[group.ownerKey] && users[group.ownerKey].userId || ""),
        members: group.memberKeys.map(key => publicFriendUser(users[key], key)).filter(Boolean),
        unread: messages.filter(message => message.from !== sess.key && message.ts > readAt).length,
        lastMessage: last ? { username: users[last.from] && users[last.from].username || "Usuario", text: last.text, ts: last.ts } : null,
        createdAt: group.createdAt
      };
    });
    result.sort((a, b) => ((b.lastMessage && b.lastMessage.ts) || 0) - ((a.lastMessage && a.lastMessage.ts) || 0));
    return json(res, 200, { groups: result, unreadTotal: result.reduce((total, group) => total + group.unread, 0) });
  }

  if (urlPath === "/api/groups" && req.method === "POST") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const body = await readBody(req);
    const name = safeText(body.name, "", 40);
    if (name.length < 2) return json(res, 400, { error: "El grupo necesita un nombre." });
    if (hasBannedTerm(name)) return json(res, 400, { error: "Ese nombre de grupo no esta permitido." });
    const users = ensureUserIds(sess.users);
    const me = users[sess.key];
    const friendSet = new Set(me.friends || []);
    const requested = Array.isArray(body.memberIds) ? body.memberIds : [];
    const memberKeys = [...new Set(requested.map(identifier => resolveUserKey(users, identifier)).filter(key => key && key !== sess.key && friendSet.has(key)))].slice(0, 20);
    if (!memberKeys.length) return json(res, 400, { error: "Selecciona al menos un amigo del grupo." });
    const group = { id: "G-" + crypto.randomBytes(6).toString("hex"), name, ownerKey: sess.key, memberKeys: [sess.key, ...memberKeys], messages: [], readAt: {}, createdAt: new Date().toISOString() };
    const groups = loadGroups();
    groups[group.id] = group;
    saveGroups(groups);
    return json(res, 201, { ok: true, group: { id: group.id, name: group.name, members: group.memberKeys.map(key => publicFriendUser(users[key], key)).filter(Boolean), unread: 0, lastMessage: null, createdAt: group.createdAt } });
  }

  if (urlPath === "/api/groups/thread" && req.method === "GET") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const groupId = safeText(new URL(req.url, "http://x").searchParams.get("id"), "", 80);
    const groups = loadGroups();
    const group = groups[groupId];
    if (!group || !Array.isArray(group.memberKeys) || !group.memberKeys.includes(sess.key)) return json(res, 404, { error: "Grupo no encontrado." });
    group.readAt = group.readAt || {};
    group.readAt[sess.key] = Date.now();
    saveGroups(groups);
    const users = sess.users;
    return json(res, 200, { group: { id: group.id, name: group.name, members: group.memberKeys.map(key => publicFriendUser(users[key], key)).filter(Boolean) }, messages: (group.messages || []).slice(-120).map(message => ({ from: message.from === sess.key ? "me" : "them", username: users[message.from] && users[message.from].username || "Usuario", text: message.text, ts: message.ts })) });
  }

  if (urlPath === "/api/groups/message" && req.method === "POST") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const body = await readBody(req);
    const groupId = safeText(body.groupId, "", 80);
    const groups = loadGroups();
    const group = groups[groupId];
    if (!group || !Array.isArray(group.memberKeys) || !group.memberKeys.includes(sess.key)) return json(res, 404, { error: "Grupo no encontrado." });
    const text = censorText(safeText(body.text, "", MAX_CHAT_LEN));
    if (!text) return json(res, 400, { error: "Escribe un mensaje." });
    group.messages = Array.isArray(group.messages) ? group.messages : [];
    const now = Date.now();
    const last = group.messages[group.messages.length - 1];
    if (last && last.from === sess.key && now - last.ts < 400) return json(res, 429, { error: "Vas muy rapido, espera un momento." });
    group.messages.push({ from: sess.key, text, ts: now });
    if (group.messages.length > 400) group.messages = group.messages.slice(-400);
    group.readAt = group.readAt || {};
    group.readAt[sess.key] = now;
    groups[groupId] = group;
    saveGroups(groups);
    return json(res, 200, { ok: true, message: { from: "me", username: sess.user.username, text, ts: now } });
  }

  // ================= CHAT DIRECTO (mensajes privados) =================
  if (urlPath === "/api/dm/inbox" && req.method === "GET") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const users = sess.users;
    const dms = loadDMs();
    const list = [];
    for (const [conv, data] of Object.entries(dms)) {
      const parts = conv.split("|");
      if (!parts.includes(sess.key)) continue;
      const otherKey = parts[0] === sess.key ? parts[1] : parts[0];
      const other = users[otherKey];
      if (!other) continue;
      const msgs = (data && data.messages) || [];
      const last = msgs[msgs.length - 1] || null;
      const readAt = ((data && data.readAt) || {})[sess.key] || 0;
      const unread = msgs.filter(m => m.from !== sess.key && m.ts > readAt).length;
      list.push({
        id: String(other.userId),
        username: other.username,
        avatar: other.avatar || {},
        presence: getPresence(otherKey),
        unread,
        lastMessage: last ? { from: last.from === sess.key ? "me" : "them", text: last.text, ts: last.ts } : null
      });
    }
    list.sort((a, b) => ((b.lastMessage && b.lastMessage.ts) || 0) - ((a.lastMessage && a.lastMessage.ts) || 0));
    return json(res, 200, { conversations: list, unreadTotal: list.reduce((n, c) => n + c.unread, 0) });
  }

  if (urlPath === "/api/dm/thread" && req.method === "GET") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const params = new URL(req.url, "http://x").searchParams;
    const otherKey = resolveUserKey(sess.users, safeText(params.get("id"), "", 40));
    if (!otherKey) return json(res, 404, { error: "Usuario no encontrado." });
    const conv = dmConvKey(sess.key, otherKey);
    const dms = loadDMs();
    const data = dms[conv] || { messages: [], readAt: {} };
    data.readAt = data.readAt || {};
    data.readAt[sess.key] = Date.now();
    dms[conv] = data;
    saveDMs(dms);
    const other = sess.users[otherKey];
    return json(res, 200, {
      user: { ...publicFriendUser(other, otherKey), relation: relationBetween(sess.users, sess.key, otherKey) },
      messages: (data.messages || []).slice(-120).map(m => ({
        from: m.from === sess.key ? "me" : "them",
        username: m.from === sess.key ? sess.user.username : other.username,
        text: m.text,
        ts: m.ts
      }))
    });
  }

  if (urlPath === "/api/dm/send" && req.method === "POST") {
    const sess = getSessionUser(req);
    if (!sess) return json(res, 401, { error: "No autenticado." });
    const body = await readBody(req);
    const otherKey = resolveUserKey(sess.users, safeText(body.id, "", 40));
    if (!otherKey) return json(res, 404, { error: "No se pudo enviar el mensaje: ese usuario ya no existe en EpicBloxs." });
    if (otherKey === sess.key) return json(res, 400, { error: "No puedes enviarte mensajes a ti mismo." });
    const text = censorText(safeText(body.text, "", 300)).trim();
    if (!text) return json(res, 400, { error: "Escribe un mensaje." });
    const conv = dmConvKey(sess.key, otherKey);
    const dms = loadDMs();
    const data = dms[conv] || { messages: [], readAt: {} };
    data.messages = data.messages || [];
    const last = data.messages[data.messages.length - 1];
    if (last && last.from === sess.key && Date.now() - last.ts < 400) {
      return json(res, 429, { error: "Vas muy rapido, espera un momento." });
    }
    data.messages.push({ from: sess.key, text, ts: Date.now() });
    if (data.messages.length > 400) data.messages = data.messages.slice(-400);
    data.readAt = data.readAt || {};
    data.readAt[sess.key] = Date.now();
    dms[conv] = data;
    saveDMs(dms);
    // Aviso instantaneo si el destinatario esta conectado por WebSocket.
    try {
      for (const room of rooms.values()) {
        for (const p of room.players.values()) {
          if (p.username && p.username.toLowerCase() === otherKey && p.ws && p.ws.readyState === 1) {
            p.ws.send(JSON.stringify({ type: "dm", from: String(sess.user.userId), username: sess.user.username, text, ts: Date.now() }));
          }
        }
      }
    } catch (e) {}
    return json(res, 200, { ok: true, message: { from: "me", text, ts: Date.now() } });
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
    const users = ensureUserIds(sess.users);
    const me = users[sess.key];
    const friends = (me.friends || []).map((k) => publicFriendUser(users[k], k)).filter(Boolean);
    const requests = (me.friendRequests || []).map((k) => publicFriendUser(users[k], k)).filter(Boolean);
    const outgoing = (me.outgoingRequests || []).map((k) => publicFriendUser(users[k], k)).filter(Boolean);
    return json(res, 200, { friends, requests, outgoing });
  }

  if (urlPath.startsWith("/perfil/")) {
    const identifier = decodeURIComponent(urlPath.replace("/perfil/", ""));
    const users = syncUserRegistry();
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


function closePlayersByAccount(accountKey, code = 4000, reason = "Sesion cerrada") {
  for (const room of rooms.values()) {
    for (const player of [...room.players.values()]) {
      if (player.accountKey === accountKey) {
        try { player.ws.close(code, reason); } catch {}
        leaveRoom(player);
      }
    }
  }
}

function getAccountFromToken(token) {
  const raw = String(token || "");
  const key = keyFromSignedToken(raw);
  if (!key) return null;
  const users = ensureUserIds(loadUsers());
  const user = users[key];
  if (!user) return null;
  if (banRemainingMs(user) > 0 && !isAdminUser(user, key)) return null;
  return { key, user, users };
}

const wss = new WebSocket.Server({ server });

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function publicPlayer(player) {
  return {
    id: player.id, playerId: player.id, gameId: player.gameId, serverId: SERVER_ID,
    username: censorText(player.username), avatar: player.avatar,
    isAdmin: !!player.isAdmin,
    isCreator: !!player.isCreator,
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

loadSessionsDisk();

wss.on("connection", (ws) => {
  const player = {
    id: makeId(), ws, roomKey: null, roomName: null, gameId: null,
    username: "Player", accountKey: null, isAdmin: false, isCreator: false, adminFly: false,
    avatar: null, x: 0, y: 0, z: 0, rotation: 0, lastChatAt: 0, lastEmoteAt: 0
  };
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    if (data.type === "join") {
      const roomName = safeText(data.room, "EpicBloxs Universe", 80);
      const gameId = safeText(data.gameId, "GAME-UNKNOWN", 32);
      const account = getAccountFromToken(data.token);
      if (!account) {
        send(ws, { type: "error", code: "AUTH_REQUIRED", message: "Sesion invalida o cuenta baneada." });
        try { ws.close(4001, "Authentication required"); } catch {}
        return;
      }
      if (player.roomKey) leaveRoom(player);
      player.accountKey = account.key;
      player.isAdmin = isAdminUser(account.user, account.key);
      player.isCreator = isCreatorUser(account.user, account.key);
      player.adminFly = false;
      const room = getOrCreateRoom(roomName, gameId);
      if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
        send(ws, { type: "error", message: "Esta sala esta llena." });
        return;
      }
      // El servidor toma el nombre/avatar de la cuenta autenticada. El cliente
      // no puede suplantar a otro usuario cambiando el username del join.
      player.username = safeText(account.user.username, "Player", 24);
      player.avatar = account.user.avatar || data.avatar || null;
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
        isAdmin: !!player.isAdmin,
        isCreator: !!player.isCreator,
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

    if (data.type === "adminAction") {
      if (!player.isAdmin) {
        send(ws, { type: "adminError", message: "No tienes permisos de administrador." });
        return;
      }
      const action = safeText(data.action, "", 20).toLowerCase();

      if (action === "fly") {
        player.adminFly = !player.adminFly;
        send(ws, { type: "adminFly", enabled: player.adminFly });
        return;
      }

      const targetId = safeText(data.targetId, "", 80);
      const targetUsername = safeText(data.targetUsername, "", 40).toLowerCase();
      let target = null;
      for (const p of room.players.values()) {
        if ((targetId && p.id === targetId) || (targetUsername && p.username.toLowerCase() === targetUsername)) {
          target = p; break;
        }
      }
      if (!target) {
        send(ws, { type: "adminError", message: "Jugador no encontrado en esta partida." });
        return;
      }
      if (target === player) {
        send(ws, { type: "adminError", message: "No puedes aplicar esa accion a ti mismo." });
        return;
      }
      if (target.isAdmin) {
        send(ws, { type: "adminError", message: "No puedes moderar a otro administrador." });
        return;
      }

      if (action === "kick") {
        send(target.ws, { type: "kicked", message: "Un administrador te saco de la partida." });
        try { target.ws.close(4002, "Kicked by admin"); } catch {}
        return;
      }

      if (action === "ban") {
        const days = Math.floor(Number(data.days));
        if (!Number.isSafeInteger(days) || days < 1 || days > 36500) {
          send(ws, { type: "adminError", message: "Los dias deben estar entre 1 y 36500." });
          return;
        }
        const users = syncUserRegistry();
        const targetUser = users[target.accountKey];
        if (!targetUser) {
          send(ws, { type: "adminError", message: "La cuenta del jugador no existe." });
          return;
        }
        targetUser.banUntil = Date.now() + days * 86400000;
        targetUser.banReason = safeText(data.reason || "Moderacion en juego", "", 160);
        saveUsersDisk(users);
        for (const [token, key] of [...sessions.entries()]) {
          if (key === target.accountKey) {
            sessions.delete(token); sessionStamps.delete(token);
          }
        }
        saveSessionsDisk();
        send(target.ws, { type: "banned", message: banMessage(targetUser) });
        try { target.ws.close(4003, "Banned by admin"); } catch {}
        return;
      }

      send(ws, { type: "adminError", message: "Accion de administrador desconocida." });
      return;
    }

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

    // EMOTES: /e dance y similares. El servidor solo reenvia el emote a la sala.
    if (data.type === "emote") {
      const now = Date.now();
      if (now - (player.lastEmoteAt || 0) < 700) return;
      player.lastEmoteAt = now;
      const name = safeText(data.name, "dance1", 24);
      broadcast(room, { type: "emote", id: player.id, username: player.username, name, ts: now });
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
syncUserRegistry();
server.listen(PORT, HOST, () => {
  console.log("EpicBloxs GLOBAL server on http://" + HOST + ":" + PORT);
  console.log("Users file: " + usersPath);
});
