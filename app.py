"""
Office Chess Tournament Tracker — Flask backend.

Serves the mobile-first web app and a small JSON API backed by flat files
(data/players.json, data/games.json). All writes go through a file lock so
concurrent auto-saves from the supervisor page don't corrupt the store.
"""

import hmac
import json
import os
import threading
import urllib.request
from datetime import datetime, timedelta

from flask import (
    Flask, jsonify, request, send_from_directory, abort, session,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
VIEWS_DIR = os.path.join(BASE_DIR, "views")

PLAYERS_FILE = os.path.join(DATA_DIR, "players.json")
GAMES_FILE = os.path.join(DATA_DIR, "games.json")
ANNOUNCEMENTS_FILE = os.path.join(DATA_DIR, "announcements.json")

# Guards all reads/writes to the JSON files. The tournament is small, so a
# single global lock is more than enough and keeps the store consistent.
_lock = threading.Lock()

app = Flask(
    __name__,
    static_folder='public',      # Tells Flask where CSS/JS/images are
    template_folder='views'     # Tells Flask where HTML files are
)

# ---------------------------------------------------------------------------
# Supervisor auth
#
# A single shared supervisor password gates every write action. Login state is
# kept in a Flask signed-cookie session, so it works across gunicorn workers as
# long as SECRET_KEY is stable (set it in the deploy environment). Read-only
# endpoints stay public — anyone can view games and announcements.
# ---------------------------------------------------------------------------

# SECRET_KEY signs the session cookie; it MUST be set (and stable) in prod so
# sessions survive restarts and are shared across workers. The dev fallback is
# only for local use.
app.secret_key = os.environ.get("SECRET_KEY") or "dev-only-insecure-secret"
app.permanent_session_lifetime = timedelta(days=7)

# The shared supervisor password. Override via env in production.
SUPERVISOR_PASSWORD = os.environ.get("SUPERVISOR_PASSWORD", "chess")


def is_supervisor():
    return bool(session.get("supervisor"))


def require_supervisor():
    """Abort with 401 unless the current session is a logged-in supervisor."""
    if not is_supervisor():
        abort(401, description="Supervisor login required")


# ---------------------------------------------------------------------------
# Storage helpers
#
# Render's free tier runs on an ephemeral filesystem: the container disk is
# wiped back to the Git repo contents on every spin-down / redeploy / restart,
# so any games written to the local JSON files are lost. When the two Upstash
# env vars are present we treat Upstash Redis as the durable source of truth
# (via its HTTP REST API — no persistent socket, ideal for a stateless app).
# With no env vars we fall back to plain local files, so local dev is unchanged.
# ---------------------------------------------------------------------------

UPSTASH_URL = os.environ.get("UPSTASH_REDIS_REST_URL")
UPSTASH_TOKEN = os.environ.get("UPSTASH_REDIS_REST_TOKEN")
USE_REDIS = bool(UPSTASH_URL and UPSTASH_TOKEN)

# Which Redis key mirrors each local data file.
_REDIS_KEYS = {
    PLAYERS_FILE: "chess:players",
    GAMES_FILE: "chess:games",
    ANNOUNCEMENTS_FILE: "chess:announcements",
}


def _redis_command(*parts):
    """Run one Redis command via the Upstash REST API and return its result."""
    req = urllib.request.Request(
        UPSTASH_URL,
        data=json.dumps(list(parts)).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + UPSTASH_TOKEN,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.load(resp).get("result")


def _read_file_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _write_file_json(path, data):
    """Write atomically: dump to a temp file then replace the original."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def _read_json(path):
    if USE_REDIS:
        key = _REDIS_KEYS.get(path)
        if key:
            raw = _redis_command("GET", key)
            if raw is None:
                # First run: key doesn't exist yet. Seed Redis from the file
                # committed to the repo (e.g. the 22 players, an empty games
                # list) so it becomes the durable baseline.
                data = _read_file_json(path)
                _redis_command("SET", key, json.dumps(data, ensure_ascii=False))
                return data
            return json.loads(raw)
    return _read_file_json(path)


def _write_json(path, data):
    if USE_REDIS:
        key = _REDIS_KEYS.get(path)
        if key:
            _redis_command("SET", key, json.dumps(data, ensure_ascii=False))
            return
    _write_file_json(path, data)


def load_players():
    return _read_json(PLAYERS_FILE).get("players", [])


def save_players(players):
    _write_json(PLAYERS_FILE, {"players": players})


def load_games():
    return _read_json(GAMES_FILE).get("games", [])


def save_games(games):
    _write_json(GAMES_FILE, {"games": games})


def load_announcements():
    return _read_json(ANNOUNCEMENTS_FILE).get("announcements", [])


def save_announcements(items):
    _write_json(ANNOUNCEMENTS_FILE, {"announcements": items})


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


def next_announcement_id(items):
    return _next_id(items, "a")


def _make_announcement(items, text, kind="manual", game_id=None):
    """Append a new announcement to `items` and return it."""
    ann = {
        "id": next_announcement_id(items),
        "text": text,
        "kind": kind,          # "manual" (typed) or "result" (auto on finish)
        "gameId": game_id,
        "createdAt": now_iso(),
    }
    items.append(ann)
    return ann


# How each end reason reads in a result announcement.
_END_REASON_PHRASE = {
    "checkmate": "by checkmate",
    "stalemate": "by stalemate",
    "timeout": "on time",
    "resignation": "by resignation",
    "draw_agreement": "by agreement",
    "insufficient": "by insufficient material",
    "repetition": "by repetition",
}


def _result_announcement_text(game, players):
    """Build the auto-announcement sentence for a just-finished game."""
    white = players.get(game.get("whitePlayerId")) or {}
    black = players.get(game.get("blackPlayerId")) or {}
    wname = white.get("name", "White")
    bname = black.get("name", "Black")
    reason = _END_REASON_PHRASE.get(game.get("endReason"), "")
    name = game.get("name") or "the match"
    result = game.get("result")

    if result == "draw":
        body = "{} and {} drew".format(wname, bname)
        if reason:
            body += " " + reason
        return "\U0001F91D {} in “{}”.".format(body, name)  # 🤝

    if result == "black":
        winner, loser = bname, wname
    else:  # default to white for any non-draw result
        winner, loser = wname, bname
    body = "{} beat {}".format(winner, loser)
    if reason:
        body += " " + reason
    return "\U0001F3C6 {} in “{}”.".format(body, name)  # 🏆


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Static pages & assets
# ---------------------------------------------------------------------------

@app.route('/')
def home():
    return send_from_directory(VIEWS_DIR, "index.html")


@app.route("/game/<game_id>")
def game_page(game_id):
    # game_id is consumed client-side via the URL; just serve the shell.
    return send_from_directory(VIEWS_DIR, "game.html")


@app.route("/log")
def log_page():
    return send_from_directory(VIEWS_DIR, "log.html")


@app.route("/login")
def login_page():
    return send_from_directory(VIEWS_DIR, "login.html")


@app.route("/public/<path:filename>")
def public_files(filename):
    return send_from_directory(PUBLIC_DIR, filename)


# ---------------------------------------------------------------------------
# API — auth
# ---------------------------------------------------------------------------

@app.route("/api/auth/status", methods=["GET"])
def api_auth_status():
    return jsonify({"authenticated": is_supervisor()})


@app.route("/api/auth/login", methods=["POST"])
def api_login():
    body = request.get_json(force=True, silent=True) or {}
    password = body.get("password") or ""
    # Constant-time comparison avoids leaking the password via timing.
    if hmac.compare_digest(password, SUPERVISOR_PASSWORD):
        session["supervisor"] = True
        session.permanent = True
        return jsonify({"authenticated": True})
    abort(401, description="Incorrect password")


@app.route("/api/auth/logout", methods=["POST"])
def api_logout():
    session.pop("supervisor", None)
    return jsonify({"authenticated": False})


# ---------------------------------------------------------------------------
# API — players
# ---------------------------------------------------------------------------

@app.route("/api/players", methods=["GET"])
def api_players():
    return jsonify(load_players())


@app.route("/api/players", methods=["POST"])
def api_create_player():
    require_supervisor()
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
    require_supervisor()
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
    require_supervisor()
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
        newly_completed = (
            target.get("status") == "completed" and prev_status != "completed"
        )
        if target.get("status") == "completed" and not target.get("endTime"):
            target["endTime"] = now_iso()

        save_games(games)

        # Auto-post a "who won and how" announcement the first time a game
        # transitions to completed (the transition check prevents duplicates
        # if the game is PUT again after finishing).
        if newly_completed:
            items = load_announcements()
            _make_announcement(
                items,
                _result_announcement_text(target, player_map()),
                kind="result",
                game_id=target.get("id"),
            )
            save_announcements(items)

    return jsonify(_enrich(target, player_map()))


@app.route("/api/games/<game_id>", methods=["DELETE"])
def api_delete_game(game_id):
    require_supervisor()
    with _lock:
        games = load_games()
        remaining = [g for g in games if g.get("id") != game_id]
        if len(remaining) == len(games):
            abort(404, description="Game not found")
        save_games(remaining)
    return jsonify({"deleted": game_id})


# ---------------------------------------------------------------------------
# API — announcements
# ---------------------------------------------------------------------------

@app.route("/api/announcements", methods=["GET"])
def api_announcements():
    with _lock:
        items = load_announcements()
    items = sorted(items, key=lambda a: a.get("createdAt", ""), reverse=True)
    return jsonify(items)


@app.route("/api/announcements", methods=["POST"])
def api_create_announcement():
    require_supervisor()
    body = request.get_json(force=True, silent=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        abort(400, description="Announcement text is required")
    if len(text) > 500:
        abort(400, description="Announcement is too long (max 500 characters)")

    with _lock:
        items = load_announcements()
        ann = _make_announcement(items, text, kind="manual")
        save_announcements(items)
    return jsonify(ann), 201


@app.route("/api/announcements/<ann_id>", methods=["DELETE"])
def api_delete_announcement(ann_id):
    require_supervisor()
    with _lock:
        items = load_announcements()
        remaining = [a for a in items if a.get("id") != ann_id]
        if len(remaining) == len(items):
            abort(404, description="Announcement not found")
        save_announcements(remaining)
    return jsonify({"deleted": ann_id})


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
@app.errorhandler(401)
@app.errorhandler(404)
@app.errorhandler(409)
def _json_error(err):
    return jsonify({"error": getattr(err, "description", str(err))}), err.code


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
