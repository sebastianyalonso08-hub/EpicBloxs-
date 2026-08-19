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
