# freelancer-mcp

MCP server para operar **Freelancer.com** desde Claude Code: buscar proyectos,
postular bids (con aprobación) y leer/responder mensajes — sin abrir el navegador.

Es una herramienta local (stdio), **no se deploya**. Vive en el repo del radar
porque reusa el mismo patrón de la API que el adaptador de fuente
(`lib/sources/freelancer.ts`) y comparte el token.

## Filosofía de seguridad (anti-ban)

Freelancer **no banea por usar la API oficial** — banea el *patrón de bot*:
postular muchos bids muy rápido, spamear desconocidos. Por eso:

| Tipo | Tools | Gateo |
|---|---|---|
| **Read** (riesgo nulo) | `search_projects`, `get_project`, `list_my_bids`, `list_threads`, `get_messages` | ninguno |
| **Write** (riesgo si es patrón bot) | `place_bid`, `send_message` | (1) Claude pide tu aprobación explícita del texto · (2) Claude Code pide permiso por cada llamada · (3) `place_bid` tiene tope por sesión |

La redacción de propuestas y respuestas la hace Claude con sus skills de
copywriting; el server sólo transporta el texto **ya aprobado**.

## Setup

### 1. Generar el token OAuth (único paso manual)

1. Entrá a <https://accounts.freelancer.com/settings/develop> (logueado).
2. Creá una app / generá un **Personal OAuth token** con scopes de
   `basic`, `fln:project_manage` y `fln:message_manage` (proyectos + mensajes).
3. Copiá el token. Es el **mismo** `FREELANCER_OAUTH_TOKEN` que usa el radar.

### 2. Instalar y buildear

```bash
cd freelancer-mcp
npm install
npm run build
```

### 3. Registrar el MCP en Claude Code

Agregá esto a `~/.claude.json` dentro de `mcpServers` (reemplazá el token):

```json
"freelancer": {
  "command": "node",
  "args": ["C:\\MisProyectos\\Armagedon\\radar\\freelancer-mcp\\dist\\index.mjs"],
  "env": {
    "FREELANCER_OAUTH_TOKEN": "TU_TOKEN_ACÁ",
    "FREELANCER_DAILY_BID_CAP": "8"
  }
}
```

Reiniciá Claude Code. Probá con: *"corré freelancer_whoami"* — si devuelve tu
usuario, está andando.

## Tools

- `freelancer_whoami` — confirma el token, devuelve tu cuenta.
- `freelancer_search_projects` — busca proyectos activos (query, presupuesto, tipo, idioma).
- `freelancer_get_project` — detalle completo de un proyecto.
- `freelancer_list_my_bids` — bids que ya postaste.
- `freelancer_list_threads` — inbox con el último mensaje de cada conversación.
- `freelancer_get_messages` — mensajes de un thread.
- `freelancer_place_bid` — postula un bid **(write, gateado)**.
- `freelancer_send_message` — responde en un thread **(write, gateado)**.

## Variables de entorno

Ver [`.env.example`](./.env.example). En producción van en el bloque `env` del
MCP en `~/.claude.json` (el token **nunca** se commitea).

| Var | Default | Qué hace |
|---|---|---|
| `FREELANCER_OAUTH_TOKEN` | — | Token OAuth personal (requerido para todo). |
| `FREELANCER_DAILY_BID_CAP` | `8` | Tope de bids por sesión (anti-bot). |
| `FREELANCER_API_URL` | `https://www.freelancer.com` | Base de la API (cambiable a `.in`). |

## Desarrollo

```bash
npm run typecheck   # tsc --noEmit
npm run build       # esbuild → dist/index.mjs
npm start           # build + arranca el server (stdio)
```

> Nota: algunos endpoints de mensajería (listar mensajes de un thread) se
> construyeron contra la API documentada pero **no se pudieron probar en vivo
> sin token**. Al activar el token, verificar `get_messages`/`list_threads` y
> ajustar params si la API difiere.
