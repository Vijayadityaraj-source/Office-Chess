"""
Office Chess Tournament Tracker — Flask backend.

Serves the mobile-first web app and a small JSON API backed by flat files
(data/players.json, data/games.json). All writes go through a file lock so
concurrent auto-saves from the supervisor page don't corrupt the store.
"""

import json
import os
import threading
from datetime import datetime

from flask import Flask, jsonify, request, send_from_directory, abort, render_template, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
VIEWS_DIR = os.path.join(BASE_DIR, "views")

PLAYERS_FILE = os.path.join(DATA_DIR, "players.json")
GAMES_FILE = os.path.join(DATA_DIR, "games.json")

# Guards all reads/writes to the JSON files. The tournament is small, so a
# single global lock is more than enough and keeps the store consistent.
_lock = threading.Lock()

app = Flask(
    __name__, 
    static_folder='public',      # Tells Flask where CSS/JS/images are
    template_folder='views'     # Tells Flask where HTML files are
)


# ---------------------------------------------------------------------------
# Storage helpers
# ---------------------------------------------------------------------------

def _read_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _write_json(path, data):
    """Write atomically: dump to a temp file then replace the original."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def load_players():
    return _read_json(PLAYERS_FILE).get("players", [])


def save_players(players):
    _write_json(PLAYERS_FILE, {"players": players})


def load_games():
    return _read_json(GAMES_FILE).get("games", [])


def save_games(games):
    _write_json(GAMES_FILE, {"games": games})


def player_map():
    return {p["id"]: p for p in load_players()}


def _next_id(items, prefix):
    """Return the next <prefix><N> id not already present in items."""
    max_n = 0
    for it in items:
        iid = it.get("id", "")
        if iid.startswith(prefix) and iid[len(prefix):].isdigit():
            max_n = max(max_n, int(iid[len(prefix):]))
    return "{}{}".format(prefix, max_n + 1)


def next_game_id(games):
    return _next_id(games, "g")


def next_player_id(players):
    return _next_id(players, "p")


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Static pages & assets
# ---------------------------------------------------------------------------

@app.route('/')
def home():
    return render_template('index.html')


@app.route("/game/<game_id>")
def game_page(game_id):
    # game_id is consumed client-side via the URL; just serve the shell.
    return send_from_directory(VIEWS_DIR, "game.html")


@app.route("/log")
def log_page():
    return send_from_directory(VIEWS_DIR, "log.html")


@app.route("/public/<path:filename>")
def public_files(filename):
    return send_from_directory(PUBLIC_DIR, filename)


# ---------------------------------------------------------------------------
# API — players
# ---------------------------------------------------------------------------

@app.route("/api/players", methods=["GET"])
def api_players():
    return jsonify(load_players())


@app.route("/api/players", methods=["POST"])
def api_create_player():
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        abort(400, description="Player name is required")

    with _lock:
        players = load_players()
        # Reject case-insensitive duplicate names to keep the roster clean.
        if any(p.get("name", "").strip().lower() == name.lower() for p in players):
            abort(409, description="A player with that name already exists")
        player = {
            "id": next_player_id(players),
            "name": name,
            "department": (body.get("department") or "").strip(),
        }
        players.append(player)
        save_players(players)

    return jsonify(player), 201


# ---------------------------------------------------------------------------
# API — games
# ---------------------------------------------------------------------------

def _enrich(game, players):
    """Attach denormalized player objects for convenient client rendering."""
    g = dict(game)
    g["white"] = players.get(game.get("whitePlayerId"))
    g["black"] = players.get(game.get("blackPlayerId"))
    return g


@app.route("/api/games", methods=["GET"])
def api_games():
    with _lock:
        games = load_games()
    players = player_map()

    status = request.args.get("status")
    if status:
        games = [g for g in games if g.get("status") == status]

    result = [_enrich(g, players) for g in games]
    return jsonify(result)


@app.route("/api/games/ongoing", methods=["GET"])
def api_ongoing():
    with _lock:
        games = load_games()
    players = player_map()
    for g in games:
        if g.get("status") == "ongoing":
            return jsonify(_enrich(g, players))
    return jsonify(None)


@app.route("/api/games/<game_id>", methods=["GET"])
def api_game(game_id):
    with _lock:
        games = load_games()
    players = player_map()
    for g in games:
        if g.get("id") == game_id:
            return jsonify(_enrich(g, players))
    abort(404, description="Game not found")


@app.route("/api/games", methods=["POST"])
def api_create_game():
    body = request.get_json(force=True, silent=True) or {}
    required = ["whitePlayerId", "blackPlayerId"]
    for field in required:
        if not body.get(field):
            abort(400, description="Missing field: {}".format(field))

    with _lock:
        games = load_games()
        game = {
            "id": next_game_id(games),
            "name": body.get("name") or "Untitled Game",
            "whitePlayerId": body["whitePlayerId"],
            "blackPlayerId": body["blackPlayerId"],
            "status": body.get("status", "ongoing"),
            "timeControl": body.get("timeControl", "10+0"),
            "moves": body.get("moves", []),
            "result": None,
            "endReason": None,
            # Upcoming games carry their scheduled time; live games start now.
            "startTime": body.get("startTime") or now_iso(),
            "endTime": None,
        }
        games.append(game)
        save_games(games)

    return jsonify(_enrich(game, player_map())), 201


# Fields a client is allowed to update via PUT.
_UPDATABLE = {
    "name", "whitePlayerId", "blackPlayerId", "status", "timeControl",
    "moves", "result", "endReason", "startTime", "endTime",
}


@app.route("/api/games/<game_id>", methods=["PUT"])
def api_update_game(game_id):
    body = request.get_json(force=True, silent=True) or {}

    with _lock:
        games = load_games()
        target = None
        for g in games:
            if g.get("id") == game_id:
                target = g
                break
        if target is None:
            abort(404, description="Game not found")

        prev_status = target.get("status")

        for key, value in body.items():
            if key in _UPDATABLE:
                target[key] = value

        # When an upcoming (or otherwise not-yet-live) game becomes ongoing,
        # stamp the actual start time over the scheduled one.
        if target.get("status") == "ongoing" and prev_status != "ongoing":
            target["startTime"] = now_iso()

        # When a game is marked finished, stamp the end time if the client
        # didn't provide one.
        if target.get("status") == "completed" and not target.get("endTime"):
            target["endTime"] = now_iso()

        save_games(games)

    return jsonify(_enrich(target, player_map()))


@app.route("/api/games/<game_id>", methods=["DELETE"])
def api_delete_game(game_id):
    with _lock:
        games = load_games()
        remaining = [g for g in games if g.get("id") != game_id]
        if len(remaining) == len(games):
            abort(404, description="Game not found")
        save_games(remaining)
    return jsonify({"deleted": game_id})


# ---------------------------------------------------------------------------
# API — leaderboard
# ---------------------------------------------------------------------------

@app.route("/api/leaderboard", methods=["GET"])
def api_leaderboard():
    with _lock:
        games = load_games()
    players = load_players()

    stats = {
        p["id"]: {
            "id": p["id"],
            "name": p["name"],
            "department": p.get("department", ""),
            "wins": 0,
            "losses": 0,
            "draws": 0,
            "played": 0,
            "points": 0.0,
        }
        for p in players
    }

    for g in games:
        if g.get("status") != "completed":
            continue
        white = g.get("whitePlayerId")
        black = g.get("blackPlayerId")
        result = g.get("result")
        if white not in stats or black not in stats:
            continue

        stats[white]["played"] += 1
        stats[black]["played"] += 1

        if result == "white":
            stats[white]["wins"] += 1
            stats[white]["points"] += 1.0
            stats[black]["losses"] += 1
        elif result == "black":
            stats[black]["wins"] += 1
            stats[black]["points"] += 1.0
            stats[white]["losses"] += 1
        elif result == "draw":
            stats[white]["draws"] += 1
            stats[black]["draws"] += 1
            stats[white]["points"] += 0.5
            stats[black]["points"] += 0.5

    board = sorted(
        stats.values(),
        key=lambda s: (-s["points"], -s["wins"], s["losses"], s["name"]),
    )
    return jsonify(board)


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------

@app.errorhandler(400)
@app.errorhandler(404)
@app.errorhandler(409)
def _json_error(err):
    return jsonify({"error": getattr(err, "description", str(err))}), err.code


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
