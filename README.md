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
| `/`          | Home — live match (polled every 2.5s), upcoming, previous games. |
| `/game/<id>` | Game viewer — replay any game with ⏮ ◀ ▶ ⏭ controls and a clickable move list. |
| `/log`       | Supervisor page — set up a game, then drag/click pieces to record moves (auto-saved), and finish with a result. |

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
