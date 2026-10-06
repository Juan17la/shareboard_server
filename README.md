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

`MONGO_URL` is required: without it the server exits with a message instead of
silently keeping boards in memory, where a restart would lose them. A local
`mongod` (`mongodb://127.0.0.1:27017`) or a free Atlas cluster both work.
`MEMORY_ONLY=true` is the explicit opt-out for throwaway runs.

Boards are served from memory and written behind to MongoDB: a new board is
saved before `POST /boards` answers, and every change is saved within
`WRITE_DELAY_MS` (1 s), so a crash or redeploy loses at most that window. A
board stays in memory while anyone is on it and for 5 minutes after the last
change, and it only leaves memory once it is stored; after that it is loaded
back from MongoDB on the next visit.

## Deploy (Render)

`render.yaml` is a Blueprint: Dashboard → New → Blueprint → this repo, then
fill `MONGO_URL`, `CORS_ORIGIN` and `AI_API_KEY`. On MongoDB Atlas, add Render
under **Network Access** (`0.0.0.0/0`, or the service's outbound IPs) — without
it the connection fails with `tlsv1 alert internal error` (SSL alert 80) and
the server exits. `GET /health` answers 503 until the database does, so a
deploy only takes traffic once it can save boards.

One instance holds each board in memory, so run a single instance (plenty for
~100 users). To scale out with Redis, three per-process pieces change, each
marked `ponytail:` in the code: `ws/hub.ts` broadcasts over a Redis channel per
board, `rate-limit.ts` counts with `INCR`/`PEXPIRE`, and the load balancer
routes each board id to one instance (sticky) so `store/boards.ts` keeps a
single live copy. MongoDB stays the source of truth.

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
with `error FORBIDDEN` and never applied. One user may have several sockets on
a board (two tabs, a laptop and a phone), each sent everything; only a second
socket from the same tab (`tab` in `join`) closes the first one with code
`4001`. A broadcast `op` carries the sender's `tab`, so a tab knows its own echo.

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
