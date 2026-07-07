/* Home page: live match (polled), leaderboard, upcoming, previous games. */
(function () {
  "use strict";

  CT.renderHeader("home");

  var PAGE_SIZE = 4;
  var previousShown = PAGE_SIZE;
  var ongoingBoard = null;
  var ongoingSig = ""; // signature of the live game to detect changes
  var miniBoards = []; // keep refs so we can render after insertion

  // ---- Live / ongoing match ------------------------------------------------

  function renderOngoing(game) {
    var section = document.getElementById("ongoing-section");
    var host = document.getElementById("ongoing");
    var flag = document.getElementById("live-flag");

    if (!game) {
      flag.innerHTML = "";
      host.innerHTML =
        '<div class="card"><div class="empty">No live match right now.</div></div>';
      ongoingBoard = null;
      ongoingSig = "";
      return;
    }

    flag.innerHTML = '<span class="live-badge">Live</span>';

    var pos = CT.positionFromMoves(game.moves || []);
    var sig = game.id + ":" + (game.moves || []).length;

    // Rebuild the card only when the game identity changes; otherwise just
    // animate the board to the new position to avoid flicker while polling.
    if (sig.split(":")[0] !== ongoingSig.split(":")[0] || !ongoingBoard) {
      host.innerHTML =
        '<div class="card">' +
        '<div class="match-players">' +
        '<span class="side"><span class="dot black"></span>' +
        '<span class="name">' + CT.escapeHtml(CT.playerName(game.black)) + "</span></span>" +
        '<span class="text-muted" style="font-size:.78rem">' +
        CT.escapeHtml(game.timeControl || "") + "</span>" +
        "</div>" +
        '<div style="padding:0 .9rem"><div id="live-board"></div></div>' +
        '<div class="match-players">' +
        '<span class="side"><span class="dot white"></span>' +
        '<span class="name">' + CT.escapeHtml(CT.playerName(game.white)) + "</span></span>" +
        '<a class="text-muted" style="font-size:.8rem" href="/game/' + game.id + '">Open &rsaquo;</a>' +
        "</div>" +
        '<div class="moves" id="live-moves"></div>' +
        "</div>";
      ongoingBoard = new ChessBoard("#live-board", {
        orientation: "white",
        interactive: false,
        showCoords: true,
      });
      ongoingBoard.el.classList.add("cb-static");
      ongoingBoard.setPosition(pos.fen, false);
    } else if (sig !== ongoingSig) {
      ongoingBoard.setPosition(pos.fen, true);
    }

    if (pos.lastMove) ongoingBoard.highlight(pos.lastMove);
    renderLiveMoves(game.moves || [], sig !== ongoingSig);
    ongoingSig = sig;
  }

  function renderLiveMoves(moves, scroll) {
    var host = document.getElementById("live-moves");
    if (!host) return;
    var rows = CT.moveRows(moves);
    var html = rows
      .map(function (r) {
        return (
          '<span class="mv-num">' + r.num + ".</span>" +
          '<span class="mv">' + CT.escapeHtml(r.white) + "</span>" +
          '<span class="mv">' + (r.black ? CT.escapeHtml(r.black) : "") + "</span>"
        );
      })
      .join("");
    host.innerHTML = html || '<span class="text-muted">No moves yet.</span>';
    if (scroll) host.scrollTop = host.scrollHeight;
  }

  // ---- Leaderboard ---------------------------------------------------------

  function renderLeaderboard(rows) {
    var host = document.getElementById("leaderboard");
    var active = rows.filter(function (r) { return r.played > 0; });
    if (!active.length) {
      host.innerHTML = '<div class="empty">No games played yet.</div>';
      return;
    }
    var body = active
      .map(function (r, i) {
        return (
          "<tr>" +
          '<td class="rank">' + (i + 1) + "</td>" +
          "<td>" + CT.escapeHtml(r.name) +
          '<div class="sub">' + CT.escapeHtml(r.department || "") + "</div></td>" +
          '<td class="num">' + r.wins + "</td>" +
          '<td class="num">' + r.losses + "</td>" +
          '<td class="num">' + r.draws + "</td>" +
          '<td class="num pts">' + formatPts(r.points) + "</td>" +
          "</tr>"
        );
      })
      .join("");
    host.innerHTML =
      '<table class="leaderboard"><thead><tr>' +
      '<th class="rank">#</th><th>Player</th>' +
      '<th class="num">W</th><th class="num">L</th><th class="num">D</th>' +
      '<th class="num">Pts</th>' +
      "</tr></thead><tbody>" + body + "</tbody></table>";
  }

  function formatPts(p) {
    return Number.isInteger(p) ? String(p) : p.toFixed(1);
  }

  // ---- Upcoming ------------------------------------------------------------

  function renderUpcoming(games) {
    var host = document.getElementById("upcoming");
    if (!games.length) {
      host.innerHTML = '<div class="empty">No upcoming matches scheduled.</div>';
      return;
    }
    host.innerHTML = games
      .map(function (g) {
        return (
          '<div class="game-row">' +
          '<div class="meta">' +
          '<div class="vs">' + CT.escapeHtml(CT.playerName(g.white)) +
          " vs " + CT.escapeHtml(CT.playerName(g.black)) + "</div>" +
          '<div class="sub">' + CT.escapeHtml(g.name) +
          " · " + CT.escapeHtml(formatTime(g.startTime)) + "</div>" +
          "</div>" +
          '<span class="result-tag upcoming">Upcoming</span>' +
          "</div>"
        );
      })
      .join("");
  }

  function formatTime(iso) {
    if (!iso) return "TBD";
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  }

  // ---- Previous games ------------------------------------------------------

  function renderPrevious(games) {
    var host = document.getElementById("previous");
    var wrap = document.getElementById("loadmore-wrap");
    miniBoards = [];

    if (!games.length) {
      host.innerHTML = '<div class="empty">No completed games yet.</div>';
      wrap.innerHTML = "";
      return;
    }

    var slice = games.slice(0, previousShown);
    host.innerHTML = slice
      .map(function (g, i) {
        var tagClass = g.result || "draw";
        var tagLabel =
          g.result === "white" ? "White" :
          g.result === "black" ? "Black" : "Draw";
        return (
          '<a class="game-row" href="/game/' + g.id + '">' +
          '<div class="cb-mini" id="mini-' + i + '"></div>' +
          '<div class="meta">' +
          '<div class="vs">' + CT.escapeHtml(CT.playerName(g.white)) +
          " vs " + CT.escapeHtml(CT.playerName(g.black)) + "</div>" +
          '<div class="sub">' + CT.escapeHtml(g.name) + "</div>" +
          '<div class="sub">' + CT.escapeHtml(CT.resultText(g)) + "</div>" +
          "</div>" +
          '<span class="result-tag ' + tagClass + '">' + tagLabel + "</span>" +
          "</a>"
        );
      })
      .join("");

    // Render mini final-position boards after the rows are in the DOM.
    slice.forEach(function (g, i) {
      var el = document.getElementById("mini-" + i);
      if (!el) return;
      var pos = CT.positionFromMoves(g.moves || []);
      var mb = new ChessBoard(el, {
        orientation: "white",
        interactive: false,
        showCoords: false,
      });
      mb.el.classList.add("cb-static");
      mb.setPosition(pos.fen, false);
      if (pos.lastMove) mb.highlight(pos.lastMove);
      miniBoards.push(mb);
    });

    if (games.length > previousShown) {
      wrap.innerHTML =
        '<button class="btn btn-block" id="loadmore">Load more</button>';
      document.getElementById("loadmore").onclick = function () {
        previousShown += PAGE_SIZE;
        renderPrevious(games);
      };
    } else {
      wrap.innerHTML = "";
    }
  }

  // ---- Data loading --------------------------------------------------------

  function loadStatic() {
    CT.api("/api/leaderboard").then(renderLeaderboard).catch(noop);
    CT.api("/api/games?status=upcoming").then(renderUpcoming).catch(noop);
    CT.api("/api/games?status=completed").then(function (games) {
      // Most recent first.
      games.sort(function (a, b) {
        return (b.endTime || "").localeCompare(a.endTime || "");
      });
      renderPrevious(games);
    }).catch(noop);
  }

  function pollOngoing() {
    CT.api("/api/games/ongoing").then(renderOngoing).catch(noop);
  }

  function noop() {}

  // ---- Schedule-a-game modal ----------------------------------------------

  var players = [];

  function setupAddModal() {
    var overlay = document.getElementById("add-modal");
    var openBtn = document.getElementById("add-upcoming-btn");
    var closeBtn = document.getElementById("add-close");
    var saveBtn = document.getElementById("add-save");

    function open() {
      // Populate player dropdowns lazily the first time it opens.
      var white = document.getElementById("add-white");
      var black = document.getElementById("add-black");
      var opts = players
        .map(function (p) {
          return '<option value="' + p.id + '">' +
            CT.escapeHtml(p.name) + " (" + CT.escapeHtml(p.department || "") + ")</option>";
        })
        .join("");
      white.innerHTML = '<option value="">Select…</option>' + opts;
      black.innerHTML = '<option value="">Select…</option>' + opts;
      document.getElementById("add-time").value = defaultDateTime();
      overlay.classList.remove("hidden");
    }
    function close() { overlay.classList.add("hidden"); }

    openBtn.onclick = open;
    closeBtn.onclick = close;
    overlay.onclick = function (e) { if (e.target === overlay) close(); };

    saveBtn.onclick = function () {
      var whiteId = document.getElementById("add-white").value;
      var blackId = document.getElementById("add-black").value;
      var name = document.getElementById("add-name").value.trim();
      var tc = document.getElementById("add-tc").value.trim() || "10+0";
      var time = document.getElementById("add-time").value;

      if (!whiteId || !blackId) { CT.toast("Pick both players"); return; }
      if (whiteId === blackId) { CT.toast("Players must differ"); return; }

      saveBtn.disabled = true;
      CT.api("/api/games", {
        method: "POST",
        headers: CT.jsonHeaders,
        body: JSON.stringify({
          name: name || "Untitled Game",
          whitePlayerId: whiteId,
          blackPlayerId: blackId,
          timeControl: tc,
          status: "upcoming",
          startTime: time || undefined,
          moves: [],
        }),
      })
        .then(function () {
          saveBtn.disabled = false;
          close();
          document.getElementById("add-name").value = "";
          CT.toast("Game scheduled");
          loadStatic(); // refresh the upcoming list
        })
        .catch(function (e) {
          saveBtn.disabled = false;
          CT.toast("Could not add: " + e.message);
        });
    };
  }

  // Current local time formatted for a datetime-local input (yyyy-MM-ddTHH:mm).
  function defaultDateTime() {
    var d = new Date();
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  // Initial load + polling for the live board every 2.5s.
  CT.api("/api/players").then(function (p) {
    players = p;
    setupAddModal();
  }).catch(noop);

  loadStatic();
  pollOngoing();
  setInterval(pollOngoing, 2500);
  // Refresh the static sections less often (they change only when a game ends).
  setInterval(loadStatic, 15000);
})();
