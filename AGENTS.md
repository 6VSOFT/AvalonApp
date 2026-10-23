# AGENTS.md

Guidance for coding agents (OpenAI Codex and others) working in this repository.

## What this is

A judge-free **Avalon (阿瓦隆)** PWA for 5–10 players sitting at the same table, each on their own phone. The app replaces the moderator, role cards, vote tokens and mission cards. Players still talk face to face; the app only deals secret roles, runs the phases, collects votes and mission cards, and decides the winner.

Stack: plain Node.js (no framework) + Server-Sent Events + vanilla JS frontend. One runtime dependency (`qrcode`). Deployed on Render as a single long-running instance (`render.yaml`).

## Commands

```bash
npm install          # Node 18+ (Render uses 20)
npm start            # http://localhost:3000  (PORT, DATA_FILE env vars)
npm test             # node:test, all tests in test/*.test.js
node scripts/make-icons.js   # only if you change the icon shapes
```

Run `npm test` before every commit. All tests must pass.

## Layout

| Path | Role |
|---|---|
| `src/game.js` | Rules engine. Boards (`BOARDS`), roles (`ROLES`), presets (`PRESETS`), 5-rejection rules (`REJECT_RULES`), `applyAction()` (the only place state changes), `viewFor()` (the only place client data is built). Pure, no I/O. |
| `server.js` | HTTP routes, SSE broadcast, rate limits, JSON persistence + `migrate()` for old saved rooms, QR codes, static files. |
| `public/app.js` | Whole client: rendering, events, session in `localStorage`, SSE reconnect. |
| `public/style.css`, `index.html`, `manifest.webmanifest`, `sw.js`, `icons/` | PWA shell. Blue/white "tech" style; the palette is CSS variables on `:root`. |
| `public/roles/<role>.svg` | Original role artwork, one per role id in `ROLES`. Good roles blue, evil roles red/orange, same hexagon frame. A new role needs a new SVG and an entry in `SHELL` in `sw.js`. |
| `test/game.test.js` | Engine tests (rules, presets, secrecy of views). |
| `test/server.test.js` | HTTP tests (auth, secrecy over the wire, concurrent duplicate requests, SSE). |

## Hard rules

Secret information is the core of the game. Breaking these rules ruins real games.

1. **The server is authoritative.** Every game action goes through `applyAction()` in `src/game.js`, which checks phase, player and permission. Never add a client-side shortcut that changes state, and never rely on hiding a button for security.
2. **Only `viewFor()` produces client data.** It must never include: another player's token, the full `roles` table, other players' roles (before the game ends), individual votes before everyone has voted, or individual mission cards (only counts, after all cards are in). If you add a field to game state, decide explicitly whether `viewFor()` may expose it.
3. **Every new action or rule needs a test**, including the illegal cases (wrong phase, wrong player, duplicate submit). Secrecy changes need a test asserting what a player can *not* see.
4. **Rules data lives in `src/game.js` only.** The client reads boards, presets, role names and the role guide text (`ability`, `tip`) from `GET /api/options`; do not duplicate those tables in `public/app.js`. `test/game.test.js` pins the official mission table and the agreed preset line-ups. Change those tests only when the rules are meant to change.
5. **Actions must be idempotent-safe.** A repeated or concurrent request must be rejected (`GameError` with code `duplicate` → HTTP 409), never counted twice. Node runs each action synchronously; keep `applyAction()` free of `await`.
6. **Don't break saved rooms.** Rooms persist to `data/rooms.json`. If you change the state shape, extend `migrate()` in `server.js`.
7. **Single instance.** State is in memory plus one JSON file. Don't introduce anything that assumes multiple instances or serverless.

## Game rules implemented

- Player counts 5–10. Mission sizes per round: 5p `2 3 2 3 3`, 6p `2 3 4 3 4`, 7p `2 3 3 4 4`, 8–10p `3 4 4 5 5`. With 7+ players round 4 needs 2 fail cards.
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
- Every push to `main` redeploys on Render and restarts the server, which drops games in progress on the free plan. Keep `main` deployable.

## Testing a full game by hand

Each browser profile holds one player session (one device = one player). To play a whole game alone, open the app in one browser and add the other players through the API: `POST /api/rooms/:code/join` `{name}` returns a token, then `POST /api/rooms/:code/action` with header `X-Player-Token` and a body such as `{"type":"ready","value":true}`, `{"type":"ack"}`, `{"type":"vote","approve":true}`.
