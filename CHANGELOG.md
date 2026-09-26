# Changelog

All notable changes to the Shareboard server. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). `git_scripts/release.sh` turns
`Unreleased` into the released version.

## [Unreleased]

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
