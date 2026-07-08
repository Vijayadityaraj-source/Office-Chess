/* Home page: live match (polled), upcoming, previous games. */
(function () {
  "use strict";

  CT.renderHeader("home");

  var PAGE_SIZE = 4;
  var previousShown = PAGE_SIZE;
  var ongoingSig = null; // identity of the live game (null forces first render)
  var miniBoards = []; // keep refs so we can render after insertion
  var isSupervisor = false; // gates the compose box, delete buttons, add game

  // ---- Live / ongoing match ------------------------------------------------

  // The home page no longer embeds the live board; it shows a compact matchup
  // card with a button that opens the (auto-refreshing) live game page.
  function renderOngoing(game) {
    var section = document.getElementById("ongoing-section");
    var host = document.getElementById("ongoing");
    var flag = document.getElementById("live-flag");

    // The card depends only on which game is live, so skip re-rendering while
    // polling unless the live game itself changed (started / ended / swapped).
    var sig = game ? game.id : "";
    if (sig === ongoingSig) return;
    ongoingSig = sig;

    if (!game) {
      // Nothing live — hide the whole section (heading included) rather than
      // leaving a lonely "Live Match" title over an empty card.
      section.classList.add("hidden");
      flag.innerHTML = "";
      host.innerHTML = "";
      return;
    }

    section.classList.remove("hidden");
    flag.innerHTML = '<span class="live-badge">Live</span>';
    host.innerHTML =
      '<div class="card card-pad">' +
      '<div class="match-players" style="padding:0 0 .85rem">' +
      '<span class="side"><span class="dot white"></span>' +
      '<span class="name">' + CT.escapeHtml(CT.playerName(game.white)) + "</span></span>" +
      '<span class="text-muted" style="font-size:.85rem">vs</span>' +
      '<span class="side"><span class="name">' +
      CT.escapeHtml(CT.playerName(game.black)) + "</span>" +
      '<span class="dot black"></span></span>' +
      "</div>" +
      '<a class="btn btn-primary btn-block" href="/game/' + game.id + '">Watch Live &rarr;</a>' +
      "</div>";
  }

  // ---- Announcements -------------------------------------------------------

  function renderAnnouncements(items) {
    var host = document.getElementById("announcements");
    if (!items.length) {
      host.classList.remove("scrollable");
      host.style.maxHeight = "";
      host.innerHTML = '<div class="empty">No announcements yet.</div>';
      return;
    }
    host.innerHTML = items
      .map(function (a) {
        var isResult = a.kind === "result";
        // Only supervisors get a delete control.
        var del = isSupervisor
          ? '<button class="announce-del" data-id="' + a.id +
            '" title="Delete" aria-label="Delete">&times;</button>'
          : "";
        return (
          '<div class="announce-row' + (isResult ? " result" : "") + '">' +
          '<div class="announce-body">' +
          '<div class="announce-text">' + CT.escapeHtml(a.text) + "</div>" +
          '<div class="announce-time">' +
          CT.escapeHtml(formatTime(a.createdAt)) + "</div>" +
          "</div>" + del +
          "</div>"
        );
      })
      .join("");
    Array.prototype.forEach.call(
      host.querySelectorAll(".announce-del"),
      function (btn) {
        btn.onclick = function () { deleteAnnouncement(btn.dataset.id); };
      }
    );

    // Contain the list to the first 3 announcements; scroll for the rest.
    // Measuring the 4th row keeps exactly 3 visible even when text wraps.
    var rows = host.querySelectorAll(".announce-row");
    if (rows.length > 3) {
      host.classList.add("scrollable");
      host.style.maxHeight = (rows[3].offsetTop - rows[0].offsetTop) + "px";
    } else {
      host.classList.remove("scrollable");
      host.style.maxHeight = "";
    }
  }

  function loadAnnouncements() {
    CT.api("/api/announcements").then(renderAnnouncements).catch(noop);
  }

  function postAnnouncement() {
    var input = document.getElementById("announce-input");
    var btn = document.getElementById("announce-post");
    var text = input.value.trim();
    if (!text) { input.focus(); return; }
    btn.disabled = true;
    CT.api("/api/announcements", {
      method: "POST",
      headers: CT.jsonHeaders,
      body: JSON.stringify({ text: text }),
    })
      .then(function () {
        input.value = "";
        btn.disabled = false;
        loadAnnouncements();
      })
      .catch(function (e) {
        btn.disabled = false;
        CT.toast(e.message);
      });
  }

  function deleteAnnouncement(id) {
    CT.api("/api/announcements/" + encodeURIComponent(id), { method: "DELETE" })
      .then(loadAnnouncements)
      .catch(function (e) { CT.toast(e.message); });
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
    loadAnnouncements();
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

  // Reveal supervisor-only controls (compose box, schedule button) once we know
  // the auth state, and re-render announcements so delete buttons appear.
  function applyAuthUI() {
    document.getElementById("announce-compose-card")
      .classList.toggle("hidden", !isSupervisor);
    document.getElementById("add-upcoming-btn")
      .classList.toggle("hidden", !isSupervisor);
    loadAnnouncements();
  }

  CT.getAuthStatus()
    .then(function (s) { isSupervisor = !!(s && s.authenticated); })
    .catch(function () { isSupervisor = false; })
    .then(applyAuthUI);

  // Players are only needed for the supervisor's schedule-a-game modal.
  CT.api("/api/players").then(function (p) {
    players = p;
    setupAddModal();
  }).catch(noop);

  document.getElementById("announce-post").onclick = postAnnouncement;

  loadStatic();
  pollOngoing();
  setInterval(pollOngoing, 2500);
  // Refresh the static sections less often (they change only when a game ends).
  setInterval(loadStatic, 15000);
})();
