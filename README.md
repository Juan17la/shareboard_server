# Live Whiteboard — Server

Fastify + TypeScript backend: REST for everything that is not realtime, and a
plain WebSocket for live board sync. Standalone project — the web and mobile
clients only depend on the wire contract.

Specified by `../mobile/docs` (02-backend-connection, 05-model-date,
06-loading-exporting, 07-websockets).

## Run

```bash
cp .env.example .env         # optional; the defaults work
npm install
npm run dev                  # http://localhost:3000
```

With no `MONGO_URL` the server runs in memory only and boards are lost on
restart. Set it to enable persistence.

## REST

| Action | Route | Auth |
|---|---|---|
| Health | `GET /health` | — |
| Create board | `POST /boards` | `X-User-Id` |
| Get board | `GET /boards/:id` | — |
| Resolve short code | `GET /boards/code/:code` | — |
| Join | `POST /boards/:id/join` | — |
| Rename | `PATCH /boards/:id` | creator token |
| Permissions | `PATCH /boards/:id/permissions` | creator token |
| Snapshot | `GET /boards/:id/snapshot` | board token |
| Import | `POST /boards/import` | `X-User-Id` |

Errors always use `{ "error": { "code": "...", "message": "..." } }` with the
codes listed in docs/02.

`POST /boards/:id/join` validates the PIN, assigns the role and returns a
short-lived `boardToken` (HMAC-signed). The token goes on the WebSocket as
`?token=` and as `Authorization: Bearer` on owner-only routes.

## WebSocket

`ws://localhost:3000/ws?boardId=<id>&token=<boardToken>`

Client sends `join | op | cursor | leave | ping`; the server replies with
`joined | op | participants | cursor | permissions | error | pong`. Every
broadcast `op` carries the board's monotonic `seq`. A viewer's op is rejected
with `error FORBIDDEN` and never applied. A second socket for the same
`(userId, boardId)` closes the first one with code `4001`.

## Layout

```
src/
  model/    types, permission rules, ops, validation, short codes, protocol
  store/    active boards in memory + optional MongoDB persistence
  routes/   REST endpoints and request auth helpers
  ws/       socket handler and the per-board client registry
  app.ts    Fastify wiring and the error envelope
  index.ts  startup, timers, graceful shutdown
```

## Persistence

Active boards live in memory. Dirty boards are written every ~2 min, evicted
after 5 min idle with nobody connected, and all flushed on SIGTERM/SIGINT.
