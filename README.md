# Office Chess Tournament Tracker

A mobile-first, minimal web app for tracking office chess games. A supervisor
logs moves on one device during the live game; everyone else watches the board
update in near real-time, sees upcoming matches, and replays finished games.

## Stack

- **Backend:** Python / Flask, JSON flat-file storage (`data/players.json`,
  `data/games.json`).
- **Frontend:** vanilla HTML/CSS/JS. Move validation via
  [chess.js](https://github.com/jhlywa/chess.js) (bundled, v0.10.3). The board
  is a small custom renderer (`public/js/board.js`) — no jQuery, no chessboard.js
  — using the chess.com green theme and open-source cburnett SVG pieces.

## Running

```bash
pip install -r requirements.txt
python app.py
```

Then open <http://localhost:5000>.

## Pages

| Route        | Purpose                                                          |
| ------------ | ---------------------------------------------------------------- |
| `/`          | Home — live match (polled every 2.5s), announcements, upcoming, previous games. |
| `/game/<id>` | Game viewer — replay any game with ⏮ ◀ ▶ ⏭ controls and a clickable move list. |
| `/login`     | Supervisor login (shared password). |
| `/log`       | Supervisor page (login required) — set up a game, then drag/click pieces to record moves (auto-saved), and finish with a result. |

## Supervisor auth

Viewing is public. Writing (logging games, posting/deleting announcements,
adding players, scheduling games) requires a supervisor login — a single shared
password held in a Flask signed-cookie session. Configure via environment:

| Env var              | Purpose                                                        |
| -------------------- | -------------------------------------------------------------- |
| `SUPERVISOR_PASSWORD`| The shared supervisor password (defaults to `chess` for dev).  |
| `SECRET_KEY`         | Signs the session cookie. **Set a strong, stable value in prod** so sessions survive restarts and are shared across workers. |

Auth endpoints: `GET /api/auth/status`, `POST /api/auth/login` `{password}`,
`POST /api/auth/logout`. All write endpoints return `401` without a session.

## Keeping the Render free instance awake

Render free web services spin down after ~15 min idle; the next visit pays a
cold start (~30–60s). Data is safe regardless (it lives in Upstash), so this is
purely about latency.

The app self-pings to stay warm: on Render, `RENDER_EXTERNAL_URL` is set
automatically, and a background thread hits `GET /health` every
`KEEPALIVE_SECONDS` (default 600). No setup needed — it's a no-op locally where
that env var is absent. Set `KEEPALIVE_SECONDS=0` to disable.

Self-ping keeps a running instance warm but can't wake one that has already
spun down (e.g. right after a redeploy, before any visit). For belt-and-braces
reliability, also point an external monitor (e.g. UptimeRobot or cron-job.org)
at `https://<your-app>/health` on a 5–10 min interval — that both keeps it warm
and revives it after any downtime.

## API

| Method & path            | Description                                     |
| ------------------------ | ----------------------------------------------- |
| `GET /api/players`       | All players.                                    |
| `GET /api/games`         | All games. `?status=ongoing|completed|upcoming` filters. |
| `GET /api/games/ongoing` | The single live game (or `null`).               |
| `GET /api/games/<id>`    | One game.                                       |
| `POST /api/games`        | Create a game.                                  |
| `PUT /api/games/<id>`    | Update a game (append moves / finish it).       |
| `GET /api/leaderboard`   | Computed W/L/D and points (win 1, draw 0.5).    |

Game and player objects returned by the games endpoints are enriched with
`white` and `black` player objects for convenient rendering.

## Data model

`data/games.json`:

```json
{
  "id": "g1",
  "name": "Quarter Final - Match 1",
  "whitePlayerId": "p1",
  "blackPlayerId": "p2",
  "status": "ongoing | completed | upcoming",
  "timeControl": "10+0",
  "moves": ["e4", "e5", "Nf3", "Nc6"],
  "result": null,
  "endReason": null,
  "startTime": "2026-06-30T10:00:00",
  "endTime": null
}
```

`result` is `null | "white" | "black" | "draw"`; `endReason` is `null |
"checkmate" | "stalemate" | "timeout" | "resignation" | "draw_agreement" |
"insufficient" | "repetition"`.

## Notes

- Only one game can be `ongoing` at a time (one physical board in the office),
  which is what the home page's live section shows.
- Writes are atomic (temp file + replace) and guarded by a lock, so the
  supervisor's rapid auto-saves can't corrupt the store.
- Checkmate, stalemate, insufficient material, and threefold repetition are
  auto-detected on the log page; resignations, timeouts, and agreed draws are
  one tap.
