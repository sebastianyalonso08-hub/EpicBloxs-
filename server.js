function resolveUserKey(users, identifier) {
    const raw = String(identifier ?? "").trim();

    if (!raw) return null;

    const normalized = raw.toLowerCase();

    // Buscar por la clave interna
    if (users && users[normalized]) {
        return normalized;
    }

    // Buscar por username
    for (const [key, user] of Object.entries(users || {})) {
        if (
            String(user?.username || "")
                .trim()
                .toLowerCase() === normalized
        ) {
            return key;
        }
    }

    // Buscar por userId
    for (const [key, user] of Object.entries(users || {})) {
        if (String(user?.userId ?? "").trim() === raw) {
            return key;
        }
    }

    return null;
}
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

ensureDataDir();

server.listen(PORT, HOST, () => {
  console.log("EpicBloxs GLOBAL server on http://" + HOST + ":" + PORT);
  console.log("Users file: " + usersPath);
});
