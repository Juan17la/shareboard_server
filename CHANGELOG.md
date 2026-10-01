# Changelog

All notable changes to the Shareboard server. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). `git_scripts/release.sh` turns
`Unreleased` into the released version.

## [Unreleased]

## [1.2.0-beta] - 2026-09-30

### Added

- Shapes may carry `startAxis` / `endAxis` (an elbow's direction at each end) and
  `curveFrom` / `curveTo` (a curve's two handles); patched and validated like the
  other shape fields.

### Changed

- A polygon has at least four sides (`LIMITS.minSides`); a stored one with fewer
  is raised into range when it loads instead of being refused.

### Added

- Shapes may carry `labelAt` (0..1): where a line's label stands along it. Patched
  and validated like the other shape fields.

### Fixed

- An update's patch is validated key by key: wrong types are refused, numbers
  are clamped, unknown keys are dropped (they used to be stored and broadcast
  as sent).
- A refused batch of ops is followed by a `resync` frame with the board as it
  stands, so the sender no longer keeps showing changes the server never took.

## [1.1.0-beta] - 2026-09-29

### Added

- `/health` also reports the running `version`, so a release can wait until the
  new server is the one answering before the app that needs it is built.

- Nicknames may be 40 characters long (was 24), so full names with two
  surnames are no longer refused or cut.

- Selection locks: a `select` message holds elements for its sender (first
  come, first served; carried as `Participant.selection`); an edit to an
  element someone else holds is dropped and its sender gets the element's
  current state back (`op` from `server`). Leaving releases the hold.

### Fixed

- A WebSocket message of an unknown type is ignored instead of being handled
  as a cursor.

- `font` (`sans` | `serif` | `mono` | `hand`) on text and shape labels.

- Element model: `polygon` shapes with `sides` (3–12), `rotation` (radians)
  on any element, `width` (wrap width) on text; the font size limit is now
  400. The AI can draw polygons.

- `POST /boards/:id/ai` with `preview: true` returns the drawing's elements
  without adding them, for the apps' accept/discard preview. Without it the
  old behaviour (added and broadcast) is kept for apps up to 1.0.0-beta.4.
- Everything one AI answer draws shares a group, so it selects and moves as one.

### Changed

- Short codes are also accepted with the `·` (or `.`) separator the apps now
  display, e.g. `ABC·DEF`.

## [1.0.0-beta.4] - 2026-09-26

### Changed

- No server changes; released alongside the app fix in mobile 1.0.0-beta.4.

## [1.0.0-beta.3] - 2026-09-26

## [1.0.0-beta.2] - 2026-09-26

### Fixed

- **Boards are no longer lost on restart or redeploy.** A new board is saved
  to MongoDB before its id is returned, and every change within
  `WRITE_DELAY_MS` (1 s; bursts share one write) instead of every 2 minutes.
  Writes to a board never overlap, a failed write is retried, and a board
  stays in memory until its changes are stored.
- Two clients opening the same cold board at once now share one copy (they
  could split across two, and one side's edits were lost).
- A board deleted while a save was pending could be written back.

### Added

- `render.yaml` Blueprint for Render; `GET /health` checks MongoDB (503 when
  unreachable) so a deploy only takes traffic once it can save.
- `MONGO_URL` is required: the server used to fall back to memory silently,
  and every board was "not found" after a restart. `MEMORY_ONLY=true` opts out
  explicitly. A failed connection exits with a hint about Atlas Network Access.
- `MONGO_POOL_SIZE` (20) caps connections per process; `npm run
  check:persistence` tests saving against a real MongoDB.

## [1.0.0-beta.1] - 2026-09-25

First public beta.

### Added

- **Draw with AI** — `POST /boards/:id/ai` sends a prompt to any
  OpenAI-compatible provider (presets for Gemini, Groq, OpenRouter and Ollama;
  `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL`) and adds the drawing
  to the board for everyone: separate figures with editable labels, text, and
  arrows bound to the figures they connect. Editors only, 10 requests a minute
  per user. `npm run check:ai` tests it against a stub provider.
- REST API: create a board, look it up by its 6-character code, join (PIN for
  private boards, unique nicknames, presence colour and emoji avatar), rename,
  change permissions (public/private; everyone, selected people or creator
  only), export a snapshot, import a file as a new board, delete a board
  (disconnects everyone on it).
- Realtime WebSocket: ops ordered by a board-wide sequence, live cursors,
  presence, permission changes pushed to every client, server-owned paint order.
- Board model: strokes; rectangles, ellipses, triangles, lines and arrows with
  labels, 15 end markers, straight/curved/elbow routes with an adjustable fold,
  dash styles and ends bound to shapes; text; images.
- Validation of everything a client sends, and rate limits (10 new boards an
  hour per IP, 5 PIN attempts a minute, 60 ops a second per client).
- Memory-only by default; optional MongoDB persistence (`MONGO_URL`) with idle
  and periodic flushes.
- `npm run smoke`: end-to-end check against a running server.

### Known limitations

- Without `MONGO_URL`, boards are lost when the server restarts.
- Each AI prompt is independent: the model does not see what is already on the
  board.
