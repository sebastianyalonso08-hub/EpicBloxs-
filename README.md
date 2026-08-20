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


## Registro global de cuentas

Las cuentas reales se guardan en `users.json`. En Render se recomienda usar el disco persistente montado en `/var/data`; el servidor detecta Render automáticamente y usa ese directorio. La cuenta de prueba `SebUser` ya no se crea.


## Administradores

El panel de administracion se controla **en el servidor**, no desde JavaScript del navegador.

Puedes elegir administradores de dos formas:

- Variable de Render `EPICBLOXS_OWNER_USERNAME`: tu usuario principal.
- Variable `ADMIN_USER_IDS`: lista separada por comas de usernames o IDs numericos, por ejemplo `1001,amigo1`.
- Tambien existe `data/admins.json` (lista JSON de usernames/IDs) para administradores adicionales.

El panel permite:
- eliminar ropa creada por jugadores;
- banear/desbanear cuentas por dias;
- regalar Sunnys a cualquier cuenta o a tu propia cuenta;
- dentro de una partida: kick, ban por dias y activar/desactivar vuelo.

**Importante:** las acciones se validan en `server.js`; ocultar el boton del panel no es la medida de seguridad.

## Persistencia en Render

EpicBloxs guarda cuentas, sesiones, catalogo, bans y administradores en `EPICBLOXS_DATA_DIR`.

El `render.yaml` de este proyecto usa `/var/data` y un persistent disk de 1 GB. Render indica que el filesystem normal es efimero y que los cambios locales se pierden al redeploy; un persistent disk conserva los cambios bajo su mount path. El disk requiere un servicio de pago. Si el servicio actual es Free, conecta un datastore persistente (por ejemplo Render Postgres) o cambia a un servicio de pago con disk antes de depender de `users.json` para cuentas reales.


## Admins y creadores

`data/admins.json` usa este formato:

```json
{
  "admins": ["TuUsuario"],
  "creators": ["UsuarioCreador1"]
}
```

- `admins`: panel completo, Sunnys, ropa, bans, kicks y herramientas dentro de juegos.
- `creators`: pueden publicar ropa mediante el sistema de creadores.
- Un admin también cuenta como creador automáticamente.
- También puedes usar `ADMIN_USER_IDS` y `CREATOR_USER_IDS` en las variables de entorno, separadas por comas.

## Persistencia en Render

Los datos se escriben en `/var/data`. El `render.yaml` configura un persistent disk de 1 GB para que `users.json`, catálogo, sesiones y moderación sobrevivan a los deploys. Render requiere un servicio de pago para persistent disks; además, un servicio con disco debe ejecutarse con una sola instancia. 
