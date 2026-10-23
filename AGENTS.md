# AGENTS.md

Guidance for coding agents (OpenAI Codex and others) working in this repository.

## What this is

A judge-free **Avalon (阿瓦隆)** PWA for 5–10 players sitting at the same table, each on their own phone. The app replaces the moderator, role cards, vote tokens and mission cards. Players still talk face to face; the app only deals secret roles, runs the phases, collects votes and mission cards, and decides the winner.

Stack: plain Node.js (no framework) + vanilla JS frontend that polls the server every 1.5 s. Runtime dependencies: `qrcode`, `@netlify/database`. **Production runs on Netlify** (project `avaloapp`, https://avaloapp.netlify.app): `public/` is the static site and `/api/*` is a Netlify Function backed by Netlify Database (Postgres) (`netlify.toml`). `npm start` runs the same API locally with an in-memory store.

## Commands

```bash
npm install          # Node 18+
npm start            # http://localhost:3000  (PORT, DATA_FILE env vars)
npm test             # node:test, all tests in test/*.test.js
node scripts/make-icons.js   # only if you change the icon shapes
```

Run `npm test` before every commit. All tests must pass.

## Layout

| Path | Role |
|---|---|
| `src/game.js` | Rules engine. Boards (`BOARDS`), roles (`ROLES`), presets (`PRESETS`), 5-rejection rules (`REJECT_RULES`), `applyAction()` (the only place state changes), `viewFor()` (the only place client data is built). Pure, no I/O. |
| `src/api.js` | All `/api` routes as a web `Request` → `Response` handler, independent of hosting. Rooms come from a pluggable store; `withRoom()` does read-modify-write with compare-and-set on the room's etag and retries on conflict. Also `migrate()` for old saved rooms, rate limits, QR codes, presence (online dots), and `memoryStore()`. |
| `netlify/functions/api.mjs` | Production: the shared API on Netlify Database. A room is one row (`rooms.data` JSONB + `version`); writes are `UPDATE … WHERE version = <read version>`. |
| `netlify/database/migrations/` | Schema (`rooms`, `presence`). Applied automatically on deploy. Never edit an applied migration; add a new timestamped one. |
| `netlify/functions/cleanup.mjs` | Hourly scheduled function deleting rooms idle for 12 h. |
| `server.js` | Local server: static files + the shared API on an in-memory store saved to `data/rooms.json`. |
| `public/app.js` | Whole client: rendering, events, session in `localStorage`, polling `GET /api/rooms/:code/state` (1.5 s visible, 8 s hidden). |
| `public/style.css`, `index.html`, `manifest.webmanifest`, `sw.js`, `icons/` | PWA shell. Blue/white "tech" style; the palette is CSS variables on `:root`. |
| `public/roles/<role>.svg` | Original role artwork, one per role id in `ROLES`. Good roles blue, evil roles red/orange, same hexagon frame. A new role needs a new SVG and an entry in `SHELL` in `sw.js`. |
| `test/game.test.js` | Engine tests (rules, presets, secrecy of views). |
| `test/server.test.js` | HTTP tests (auth, secrecy over the wire, concurrent requests, polling, and a forced write conflict that must retry without losing either write). |

## Hard rules

Secret information is the core of the game. Breaking these rules ruins real games.

1. **The server is authoritative.** Every game action goes through `applyAction()` in `src/game.js`, which checks phase, player and permission. Never add a client-side shortcut that changes state, and never rely on hiding a button for security.
2. **Only `viewFor()` produces client data.** It must never include: another player's token, the full `roles` table, other players' roles (before the game ends), individual votes before everyone has voted, or individual mission cards (only counts, after all cards are in). If you add a field to game state, decide explicitly whether `viewFor()` may expose it.
3. **Every new action or rule needs a test**, including the illegal cases (wrong phase, wrong player, duplicate submit). Secrecy changes need a test asserting what a player can *not* see.
4. **Rules data lives in `src/game.js` only.** The client reads boards, presets, role names and the role guide text (`ability`, `tip`) from `GET /api/options`; do not duplicate those tables in `public/app.js`. `test/game.test.js` pins the official mission table and the agreed preset line-ups. Change those tests only when the rules are meant to change.
5. **Actions must be idempotent-safe.** A repeated or concurrent request must be rejected (`GameError` with code `duplicate` → HTTP 409), never counted twice. Every state change goes through `withRoom()` in `src/api.js`, which only commits if nobody else wrote in between; on conflict it re-reads and re-runs the action, so validation always sees current state. Keep `applyAction()` synchronous and free of side effects outside the room object.
6. **Don't break saved rooms.** Rooms persist in Netlify Database (and `data/rooms.json` locally). If you change the state shape, extend `migrate()` in `src/api.js`.
7. **Stateless functions.** On Netlify every request may hit a different instance. Never keep game state in module variables; read and write it through the store.
8. **Don't store rooms in Netlify Blobs.** Its conditional writes lost updates under real concurrency in a live test (10 simultaneous joins). Room state needs the database's atomic `UPDATE … WHERE version`.

## Game rules implemented

- Player counts 5–10. Mission sizes per round: 5p `2 3 2 3 3`, 6p `2 3 4 3 4`, 7p `2 3 3 4 4`, 8–10p `3 4 4 5 5`. With 7+ players round 4 needs 2 fail cards.
- Seats: the lobby list is the seating (`player.seat`). Joiners take the lowest free seat; a player can move to an empty seat at once, or ask another player to swap (`seat` → `swap_answer` by the other player). The game keeps this order (`game.seats`) and the leader rotates through it; only the first leader is random.
- Team approval needs a strict majority (`floor(n/2)+1`).
- After 5 consecutive rejections: `evil_wins`, or `forced` (next leader's team skips the vote and goes straight to the mission).
- Night info: Merlin sees evil except Mordred; Percival sees Merlin + Morgana without knowing which; evil see each other except Oberon (who sees no one); servants see no one.
- 3 failed missions → evil wins. 3 successful → assassin picks a target; hitting Merlin → evil wins, otherwise good wins.
- Roles revealed only when the game ends. Restart re-deals roles.

## Conventions

- **UI text is Simplified Chinese.** Keep new strings in Chinese, matching the existing tone. Code, comments and commit messages are in English.
- Match the surrounding style: `'use strict'`, CommonJS, 2-space indent, single quotes, small comments that explain *why*.
- Always escape user text in the client with `esc()` before putting it in HTML.
- Mobile first: check layouts at 375px width; buttons stay large (≥44px).
- App code is served `no-cache` so redeploys reach phones immediately; bump `CACHE` in `public/sw.js` when you change the shell file list.
- No new dependencies without a clear need.
- Deploys don't lose rooms (they live in the database), but a deploy with a breaking state change will hit games in progress. Keep `main` deployable; the Netlify build runs `npm test`.

## Testing a full game by hand

Each browser profile holds one player session (one device = one player). To play a whole game alone, open the app in one browser and add the other players through the API: `POST /api/rooms/:code/join` `{name}` returns a token, then `POST /api/rooms/:code/action` with header `X-Player-Token` and a body such as `{"type":"ready","value":true}`, `{"type":"ack"}`, `{"type":"vote","approve":true}`.
