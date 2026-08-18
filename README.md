# EpicBloxs Internet Multiplayer + IDs

## IDs
- Game ID: identifica qué juego es.
- Server ID: identifica el servidor/instancia.
- Player ID: identifica al jugador dentro del servidor.

Ejemplo:
GAME ID: OBBY-91AC
SERVER ID: SRV-4A21BC
PLAYER ID: P-...

Los clientes no inventan jugadores. El servidor es la autoridad: cuando un jugador entra, el servidor asigna/entrega su Player ID y envía la lista real de jugadores de esa sala.

## Publicar
1. Sube esta carpeta a GitHub.
2. En Render crea un Web Service.
3. Build: `npm install`
4. Start: `npm start`
5. Comparte la URL `https://...onrender.com`.

El cliente detecta HTTPS y usa WebSocket seguro (`wss://`) automáticamente.

## Prueba
Abre la URL en dos navegadores/cuentas y entra al mismo juego. Ambos deben tener el mismo Game ID y Server ID, y cada jugador tendrá un Player ID distinto.
