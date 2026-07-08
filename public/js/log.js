/* Supervisor log page: drive a live game, validate moves, auto-save. */
(function () {
  "use strict";

  CT.renderHeader("log");

  var chess = new Chess();   // authoritative game state
  var board = null;
  var game = null;           // server game record once started
  var players = [];
  var upcoming = [];         // scheduled games available to start
  var pendingEnd = null;     // { result, endReason } selected but not committed
  var pendingPromotion = null; // { from, to } awaiting piece choice
  var finished = false;

  // ---- Setup ---------------------------------------------------------------

  function fillPlayerSelects() {
    var white = document.getElementById("white-select");
    var black = document.getElementById("black-select");
    // Preserve any current picks across a refresh (e.g. after adding a player).
    var prevWhite = white.value;
    var prevBlack = black.value;
    var opts = players
      .map(function (p) {
        return '<option value="' + p.id + '">' +
          CT.escapeHtml(p.name) + " (" + CT.escapeHtml(p.department || "") + ")</option>";
      })
      .join("");
    white.innerHTML = '<option value="">Select…</option>' + opts;
    black.innerHTML = '<option value="">Select…</option>' + opts;
    white.value = prevWhite;
    black.value = prevBlack;
  }

  // ---- Add player ----------------------------------------------------------

  function setupPlayerModal() {
    var overlay = document.getElementById("player-modal");
    var nameEl = document.getElementById("player-name");
    var deptEl = document.getElementById("player-dept");
    var saveBtn = document.getElementById("player-save");

    function open() {
      nameEl.value = "";
      deptEl.value = "";
      overlay.classList.remove("hidden");
      nameEl.focus();
    }
    function close() { overlay.classList.add("hidden"); }

    document.getElementById("add-player-btn").onclick = open;
    document.getElementById("player-close").onclick = close;
    overlay.onclick = function (e) { if (e.target === overlay) close(); };

    saveBtn.onclick = function () {
      var name = nameEl.value.trim();
      if (!name) { CT.toast("Enter a name"); nameEl.focus(); return; }
      saveBtn.disabled = true;
      CT.api("/api/players", {
        method: "POST",
        headers: CT.jsonHeaders,
        body: JSON.stringify({ name: name, department: deptEl.value.trim() }),
      })
        .then(function (p) {
          players.push(p);
          fillPlayerSelects();
          saveBtn.disabled = false;
          close();
          CT.toast("Added " + p.name);
        })
        .catch(function (e) {
          saveBtn.disabled = false;
          CT.toast(e.message);
        });
    };
  }

  function fillUpcomingSelect() {
    var sel = document.getElementById("upcoming-select");
    var field = document.getElementById("upcoming-field");
    if (!upcoming.length) {
      // Nothing scheduled — hide the picker entirely to keep the form clean.
      field.classList.add("hidden");
      return;
    }
    field.classList.remove("hidden");
    var opts = upcoming
      .map(function (g) {
        var label = CT.playerName(g.white) + " vs " + CT.playerName(g.black) +
          " — " + g.name;
        return '<option value="' + g.id + '">' + CT.escapeHtml(label) + "</option>";
      })
      .join("");
    sel.innerHTML = '<option value="">New game (enter details below)</option>' + opts;
  }

  // When a scheduled game is picked, prefill the form from its details.
  function onUpcomingChange() {
    var id = document.getElementById("upcoming-select").value;
    var g = upcoming.filter(function (u) { return u.id === id; })[0];
    if (!g) return;
    document.getElementById("white-select").value = g.whitePlayerId;
    document.getElementById("black-select").value = g.blackPlayerId;
    document.getElementById("game-name").value = g.name || "";
    document.getElementById("time-control").value = g.timeControl || "10+0";
  }

  function startGame() {
    var upcomingId = document.getElementById("upcoming-select").value;
    var whiteId = document.getElementById("white-select").value;
    var blackId = document.getElementById("black-select").value;
    var name = document.getElementById("game-name").value.trim();
    var tc = document.getElementById("time-control").value.trim() || "10+0";

    if (!whiteId || !blackId) {
      CT.toast("Pick both players");
      return;
    }
    if (whiteId === blackId) {
      CT.toast("Players must differ");
      return;
    }

    var payload = {
      name: name || "Untitled Game",
      whitePlayerId: whiteId,
      blackPlayerId: blackId,
      timeControl: tc,
      status: "ongoing",
    };

    // Starting a scheduled game converts it in place (upcoming -> ongoing) so
    // it leaves the upcoming list; a blank pick creates a brand-new game.
    var request = upcomingId
      ? CT.api("/api/games/" + upcomingId, {
          method: "PUT",
          headers: CT.jsonHeaders,
          body: JSON.stringify(payload),
        })
      : CT.api("/api/games", {
          method: "POST",
          headers: CT.jsonHeaders,
          body: JSON.stringify(Object.assign({ moves: [] }, payload)),
        });

    request
      .then(function (g) {
        game = g;
        chess = new Chess();
        (g.moves || []).forEach(function (m) { chess.move(m); });
        beginActiveUI();
      })
      .catch(function (e) { CT.toast("Could not start: " + e.message); });
  }

  // ---- Active game UI ------------------------------------------------------

  function beginActiveUI() {
    document.getElementById("setup-section").classList.add("hidden");
    document.getElementById("game-section").classList.remove("hidden");
    document.getElementById("active-name").textContent = game.name;

    document.getElementById("top-player").innerHTML =
      '<span class="name">' + CT.escapeHtml(CT.playerName(game.black)) +
      '</span><span class="tag"><span class="dot black"></span>Black</span>';
    document.getElementById("bottom-player").innerHTML =
      '<span class="name">' + CT.escapeHtml(CT.playerName(game.white)) +
      '</span><span class="tag"><span class="dot white"></span>White</span>';

    board = new ChessBoard("#board", {
      orientation: "white",
      interactive: true,
      showCoords: true,
      onDrop: onDrop,
    });
    board.setPosition(chess.fen(), false);

    document.getElementById("undo-btn").onclick = undoMove;
    document.getElementById("finish-btn").onclick = commitFinish;
    document.getElementById("delete-btn").onclick = showDeleteConfirm;
    document.getElementById("delete-no").onclick = hideDeleteConfirm;
    document.getElementById("delete-yes").onclick = deleteGame;

    Array.prototype.forEach.call(
      document.querySelectorAll("[data-end]"),
      function (btn) {
        btn.onclick = function () { selectEnd(btn.dataset.end); };
      }
    );

    // Re-highlight the last move and restore any terminal state. This matters
    // when resuming an in-progress game that already has moves recorded.
    var hist = chess.history({ verbose: true });
    if (hist.length) {
      var last = hist[hist.length - 1];
      board.highlight([last.from, last.to]);
    }

    renderMoves();
    updateTurnLine();
    detectTerminal();
  }

  // ---- Move handling -------------------------------------------------------

  function onDrop(from, to) {
    if (finished) return "snapback";

    // Detect promotion: a pawn reaching the last rank.
    var piece = chess.get(from);
    var isPromotion =
      piece && piece.type === "p" &&
      ((piece.color === "w" && to[1] === "8") ||
       (piece.color === "b" && to[1] === "1"));

    if (isPromotion) {
      // Only prompt if the move is otherwise legal.
      var legal = chess.moves({ square: from, verbose: true }).some(function (m) {
        return m.to === to;
      });
      if (!legal) return "snapback";
      pendingPromotion = { from: from, to: to };
      showPromotion(piece.color);
      return "snapback"; // snap back until a piece is chosen
    }

    var move = chess.move({ from: from, to: to, promotion: "q" });
    if (!move) return "snapback";
    afterMove(move);
    return true;
  }

  function afterMove(move) {
    board.setPosition(chess.fen(), true);
    board.highlight([move.from, move.to]);
    renderMoves();
    updateTurnLine();
    autoSave();
    detectTerminal();
  }

  function undoMove() {
    if (finished) return;
    var undone = chess.undo();
    if (!undone) return;
    board.setPosition(chess.fen(), true);
    var hist = chess.history({ verbose: true });
    if (hist.length) {
      var last = hist[hist.length - 1];
      board.highlight([last.from, last.to]);
    } else {
      board.clearHighlights();
    }
    // Undoing clears any auto-detected terminal state.
    pendingEnd = null;
    updateEndBanner();
    renderMoves();
    updateTurnLine();
    autoSave();
  }

  // ---- Promotion picker ----------------------------------------------------

  function showPromotion(color) {
    var host = document.getElementById("board").parentNode;
    var existing = document.getElementById("promo-overlay");
    if (existing) existing.remove();

    var pieces = ["q", "r", "b", "n"];
    var overlay = document.createElement("div");
    overlay.id = "promo-overlay";
    overlay.style.cssText =
      "position:absolute;inset:0;background:rgba(43,43,43,.75);display:flex;" +
      "align-items:center;justify-content:center;gap:.5rem;z-index:60;border-radius:6px";
    overlay.innerHTML = pieces
      .map(function (p) {
        var sprite = (color === "w" ? "w" : "b") + p.toUpperCase();
        return (
          '<button class="btn" data-promo="' + p + '" ' +
          'style="width:56px;height:56px;padding:6px;background:#fff">' +
          '<img src="/public/img/pieces/' + sprite + '.svg" ' +
          'style="width:100%;height:100%" alt="' + p + '"></button>'
        );
      })
      .join("");
    // Ensure the board container is positioned so the overlay anchors to it.
    host.style.position = "relative";
    host.appendChild(overlay);

    Array.prototype.forEach.call(
      overlay.querySelectorAll("[data-promo]"),
      function (btn) {
        btn.onclick = function () {
          choosePromotion(btn.dataset.promo);
        };
      }
    );
  }

  function choosePromotion(pieceType) {
    var overlay = document.getElementById("promo-overlay");
    if (overlay) overlay.remove();
    if (!pendingPromotion) return;
    var move = chess.move({
      from: pendingPromotion.from,
      to: pendingPromotion.to,
      promotion: pieceType,
    });
    pendingPromotion = null;
    if (!move) return;
    afterMove(move);
  }

  // ---- Terminal detection --------------------------------------------------

  function detectTerminal() {
    if (chess.in_checkmate()) {
      // The side to move is checkmated, so the other side won.
      var winner = chess.turn() === "w" ? "black" : "white";
      autoSelectEnd(winner, "checkmate",
        (winner === "white" ? "White" : "Black") + " wins by checkmate");
    } else if (chess.in_stalemate()) {
      autoSelectEnd("draw", "stalemate", "Draw by stalemate");
    } else if (chess.insufficient_material()) {
      autoSelectEnd("draw", "insufficient", "Draw — insufficient material");
    } else if (chess.in_threefold_repetition()) {
      autoSelectEnd("draw", "repetition", "Draw by repetition");
    }
  }

  function autoSelectEnd(result, endReason, label) {
    pendingEnd = { result: result, endReason: endReason };
    updateEndBanner(label);
    CT.toast(label);
  }

  // ---- End game ------------------------------------------------------------

  var END_MAP = {
    "resign-white": { result: "black", endReason: "resignation",
      label: "Black wins — White resigned" },
    "resign-black": { result: "white", endReason: "resignation",
      label: "White wins — Black resigned" },
    "draw": { result: "draw", endReason: "draw_agreement",
      label: "Draw agreed" },
    "timeout-white": { result: "black", endReason: "timeout",
      label: "Black wins — White flagged" },
    "timeout-black": { result: "white", endReason: "timeout",
      label: "White wins — Black flagged" },
  };

  function selectEnd(key) {
    var e = END_MAP[key];
    if (!e) return;
    pendingEnd = { result: e.result, endReason: e.endReason };
    updateEndBanner(e.label);
  }

  function updateEndBanner(labelOverride) {
    var banner = document.getElementById("end-banner");
    var finishBtn = document.getElementById("finish-btn");
    if (!pendingEnd) {
      banner.classList.add("hidden");
      finishBtn.disabled = true;
      return;
    }
    var label = labelOverride || describePending();
    banner.className = "result-banner " + pendingEnd.result;
    banner.textContent = "Selected: " + label;
    banner.classList.remove("hidden");
    finishBtn.disabled = false;
  }

  function describePending() {
    return CT.resultText({
      status: "completed",
      result: pendingEnd.result,
      endReason: pendingEnd.endReason,
    });
  }

  function commitFinish() {
    if (!pendingEnd || finished) return;
    finished = true;
    document.getElementById("finish-btn").disabled = true;

    CT.api("/api/games/" + game.id, {
      method: "PUT",
      headers: CT.jsonHeaders,
      body: JSON.stringify({
        moves: chess.history(),
        status: "completed",
        result: pendingEnd.result,
        endReason: pendingEnd.endReason,
      }),
    })
      .then(function () {
        document.getElementById("active-live").textContent = "Finished";
        document.getElementById("active-live").className = "";
        CT.toast("Game saved");
        setTimeout(function () { window.location.href = "/"; }, 900);
      })
      .catch(function (e) {
        finished = false;
        document.getElementById("finish-btn").disabled = false;
        CT.toast("Save failed: " + e.message);
      });
  }

  // ---- Delete / discard ----------------------------------------------------

  function showDeleteConfirm() {
    document.getElementById("delete-confirm").classList.remove("hidden");
    document.getElementById("delete-btn").classList.add("hidden");
  }

  function hideDeleteConfirm() {
    document.getElementById("delete-confirm").classList.add("hidden");
    document.getElementById("delete-btn").classList.remove("hidden");
  }

  function deleteGame() {
    if (!game) return;
    document.getElementById("delete-yes").disabled = true;
    CT.api("/api/games/" + game.id, { method: "DELETE" })
      .then(function () {
        CT.toast("Game deleted");
        // Back to a fresh setup form (no ongoing game remains to resume).
        setTimeout(function () { window.location.href = "/log"; }, 500);
      })
      .catch(function (e) {
        document.getElementById("delete-yes").disabled = false;
        CT.toast("Delete failed: " + e.message);
      });
  }

  // ---- Persistence ---------------------------------------------------------

  var saveTimer = null;
  function autoSave() {
    if (!game) return;
    var status = document.getElementById("save-status");
    status.textContent = "Saving…";
    status.className = "status-line";

    if (saveTimer) clearTimeout(saveTimer);
    // Small debounce so rapid moves collapse into one write.
    saveTimer = setTimeout(function () {
      CT.api("/api/games/" + game.id, {
        method: "PUT",
        headers: CT.jsonHeaders,
        body: JSON.stringify({ moves: chess.history(), status: "ongoing" }),
      })
        .then(function () {
          status.textContent = "Saved";
          status.className = "status-line saved";
        })
        .catch(function (e) {
          status.textContent = "Save error";
          status.className = "status-line";
          CT.toast("Auto-save failed: " + e.message);
        });
    }, 250);
  }

  // ---- Rendering -----------------------------------------------------------

  function renderMoves() {
    var host = document.getElementById("movelist");
    var rows = CT.moveRows(chess.history());
    if (!rows.length) {
      host.innerHTML = '<span class="text-muted">No moves yet.</span>';
      return;
    }
    host.innerHTML = rows
      .map(function (r) {
        return (
          '<span class="mv-num">' + r.num + ".</span>" +
          '<span class="mv">' + CT.escapeHtml(r.white) + "</span>" +
          '<span class="mv">' + (r.black ? CT.escapeHtml(r.black) : "") + "</span>"
        );
      })
      .join("");
    host.scrollTop = host.scrollHeight;
  }

  function updateTurnLine() {
    var line = document.getElementById("turn-line");
    if (chess.in_checkmate()) { line.textContent = "Checkmate"; return; }
    if (chess.in_draw()) { line.textContent = "Drawn position"; return; }
    var side = chess.turn() === "w" ? "White" : "Black";
    var check = chess.in_check() ? " · Check!" : "";
    line.textContent = side + " to move" + check;
  }

  // ---- Resume --------------------------------------------------------------

  // Rebuild the game state from a persisted ongoing game so a refresh, closed
  // tab, or dropped connection returns the supervisor to exactly where they
  // left off instead of the new-game form.
  function resumeGame(g) {
    game = g;
    chess = new Chess();
    var moves = g.moves || [];
    for (var i = 0; i < moves.length; i++) {
      if (!chess.move(moves[i])) break;
    }
    beginActiveUI();
    CT.toast("Resumed game in progress");
  }

  // ---- Init ----------------------------------------------------------------

  function start() {
    document.getElementById("start-btn").onclick = startGame;
    document.getElementById("upcoming-select").onchange = onUpcomingChange;
    setupPlayerModal();

    // Load players first (needed for the setup form), then check whether a game
    // is already in progress and, if so, resume it. Otherwise load the list of
    // scheduled games the supervisor can start.
    CT.api("/api/players")
      .then(function (p) {
        players = p;
        fillPlayerSelects();
        return CT.api("/api/games/ongoing");
      })
      .then(function (ongoing) {
        if (ongoing && ongoing.id) {
          resumeGame(ongoing);
          return null;
        }
        return CT.api("/api/games?status=upcoming");
      })
      .then(function (list) {
        if (list) {
          upcoming = list;
          fillUpcomingSelect();
        }
      })
      .catch(function (e) { CT.toast("Load failed: " + e.message); });
  }

  // The log page is supervisor-only. Non-supervisors are sent to the login
  // page (and the server rejects their writes regardless).
  CT.getAuthStatus()
    .then(function (s) {
      if (!s || !s.authenticated) { window.location.replace("/login"); return; }
      start();
    })
    .catch(function () { window.location.replace("/login"); });
})();
