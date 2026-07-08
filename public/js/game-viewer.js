/* Game viewer: replay a completed/ongoing game move by move. */
(function () {
  "use strict";

  CT.renderHeader();

  // Extract the game id from /game/<id>.
  var parts = window.location.pathname.split("/").filter(Boolean);
  var gameId = parts[parts.length - 1];

  var board = null;
  var game = null;          // the game record from the API
  var positions = [];       // positions[i] = { fen, lastMove } after i half-moves
  var ply = 0;              // current half-move index (0 = starting position)

  function precomputePositions(moves) {
    positions = [{ fen: CT.STARTING_FEN, lastMove: null }];
    var c = new Chess();
    for (var i = 0; i < moves.length; i++) {
      var mv = c.move(moves[i]);
      if (!mv) break;
      positions.push({ fen: c.fen(), lastMove: [mv.from, mv.to] });
    }
  }

  function playerBar(player, colorWord) {
    var dotClass = colorWord === "White" ? "white" : "black";
    return (
      '<span class="name">' + CT.escapeHtml(CT.playerName(player)) + "</span>" +
      '<span class="tag"><span class="dot ' + dotClass + '"></span>' + colorWord + "</span>"
    );
  }

  function render() {
    var tpl = document.getElementById("viewer-tpl");
    var host = document.getElementById("viewer");
    host.innerHTML = "";
    host.appendChild(tpl.content.cloneNode(true));

    document.getElementById("game-name").textContent = game.name || "Game";

    // White on the bottom, Black on the top.
    document.getElementById("top-player").innerHTML = playerBar(game.black, "Black");
    document.getElementById("bottom-player").innerHTML = playerBar(game.white, "White");

    setBanner();

    board = new ChessBoard("#board", {
      orientation: "white",
      interactive: false,
      showCoords: true,
    });
    board.el.classList.add("cb-static");

    document.getElementById("nav-start").onclick = function () { goTo(0); };
    document.getElementById("nav-prev").onclick = function () { goTo(ply - 1); };
    document.getElementById("nav-next").onclick = function () { goTo(ply + 1); };
    document.getElementById("nav-end").onclick = function () {
      goTo(positions.length - 1);
    };

    document.addEventListener("keydown", onKey);

    renderMoveList();
    // Start at the final position so the viewer opens on the outcome.
    goTo(positions.length - 1, false);
  }

  function setBanner() {
    var banner = document.getElementById("result-banner");
    if (!banner) return;
    if (game.status === "completed") {
      banner.className = "result-banner " + (game.result || "draw");
      banner.textContent = CT.resultText(game);
      banner.classList.remove("hidden");
    } else if (game.status === "ongoing") {
      banner.className = "result-banner ongoing";
      banner.textContent = "Game in progress";
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  function onKey(e) {
    if (e.key === "ArrowLeft") { goTo(ply - 1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { goTo(ply + 1); e.preventDefault(); }
    else if (e.key === "Home") { goTo(0); e.preventDefault(); }
    else if (e.key === "End") { goTo(positions.length - 1); e.preventDefault(); }
  }

  function goTo(target, animate) {
    if (animate === undefined) animate = true;
    target = Math.max(0, Math.min(target, positions.length - 1));
    var pos = positions[target];
    board.setPosition(pos.fen, animate);
    if (pos.lastMove) board.highlight(pos.lastMove);
    else board.clearHighlights();
    ply = target;
    updateControls();
    highlightActiveMove();
  }

  function updateControls() {
    document.getElementById("nav-start").disabled = ply === 0;
    document.getElementById("nav-prev").disabled = ply === 0;
    document.getElementById("nav-next").disabled = ply === positions.length - 1;
    document.getElementById("nav-end").disabled = ply === positions.length - 1;
  }

  function renderMoveList() {
    var host = document.getElementById("movelist");
    var rows = CT.moveRows(game.moves || []);
    if (!rows.length) {
      host.innerHTML = '<span class="text-muted">No moves recorded.</span>';
      return;
    }
    host.innerHTML = rows
      .map(function (r) {
        var w =
          '<span class="mv" data-ply="' + (r.whiteIdx + 1) + '">' +
          CT.escapeHtml(r.white) + "</span>";
        var b = r.black
          ? '<span class="mv" data-ply="' + (r.blackIdx + 1) + '">' +
            CT.escapeHtml(r.black) + "</span>"
          : "<span></span>";
        return '<span class="mv-num">' + r.num + ".</span>" + w + b;
      })
      .join("");

    Array.prototype.forEach.call(host.querySelectorAll(".mv"), function (el) {
      el.onclick = function () {
        goTo(parseInt(el.dataset.ply, 10));
      };
    });
  }

  function highlightActiveMove() {
    var host = document.getElementById("movelist");
    if (!host) return;
    Array.prototype.forEach.call(host.querySelectorAll(".mv"), function (el) {
      el.classList.toggle("active", parseInt(el.dataset.ply, 10) === ply);
    });
    var active = host.querySelector(".mv.active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  // ---- Live updates -------------------------------------------------------

  var pollTimer = null;

  // Apply a freshly fetched game record without rebuilding the board, so the
  // page updates smoothly while a live game is in progress.
  function applyUpdate(g) {
    var noChange =
      g.status === game.status &&
      (g.moves || []).length === (game.moves || []).length;
    if (noChange) return;

    // If the viewer is sitting on the latest move, keep following the game
    // live; if the user has scrolled back to review, leave them where they are.
    var following = ply === positions.length - 1;
    var statusChanged = g.status !== game.status;

    game = g;
    precomputePositions(g.moves || []);
    renderMoveList();
    if (statusChanged) setBanner();

    if (following) {
      goTo(positions.length - 1, true);
    } else {
      ply = Math.min(ply, positions.length - 1);
      updateControls();
      highlightActiveMove();
    }
  }

  function startLivePolling() {
    if (game.status !== "ongoing") return;
    pollTimer = setInterval(function () {
      CT.api("/api/games/" + encodeURIComponent(gameId))
        .then(function (g) {
          applyUpdate(g);
          if (g.status !== "ongoing" && pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        })
        .catch(function () { /* ignore transient poll errors */ });
    }, 2500);
  }

  // ---- Load ---------------------------------------------------------------

  CT.api("/api/games/" + encodeURIComponent(gameId))
    .then(function (g) {
      game = g;
      precomputePositions(g.moves || []);
      render();
      startLivePolling();
    })
    .catch(function (err) {
      document.getElementById("viewer").innerHTML =
        '<div class="card"><div class="empty">Could not load this game.<br>' +
        CT.escapeHtml(err.message) + "</div></div>";
    });
})();
