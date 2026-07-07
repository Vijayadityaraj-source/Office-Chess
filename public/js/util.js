/* Shared helpers used across the home, viewer, and log pages. */
(function (global) {
  "use strict";

  var STARTING_FEN =
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

  // Thin fetch wrapper returning parsed JSON, throwing on non-2xx.
  function api(path, options) {
    return fetch(path, options).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (b) {
          throw new Error(b.error || res.statusText);
        });
      }
      if (res.status === 204) return null;
      return res.json();
    });
  }

  var jsonHeaders = { "Content-Type": "application/json" };

  // Replay a list of SAN moves and return { fen, lastMove:[from,to] }.
  // Passing `upto` limits how many half-moves are applied.
  function positionFromMoves(moves, upto) {
    var game = new Chess();
    var last = null;
    var n = upto == null ? moves.length : Math.min(upto, moves.length);
    for (var i = 0; i < n; i++) {
      var mv = game.move(moves[i]);
      if (mv) last = [mv.from, mv.to];
      else break;
    }
    return { fen: game.fen(), lastMove: last };
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function playerName(p, fallback) {
    return p && p.name ? p.name : fallback || "Unknown";
  }

  var RESULT_LABEL = {
    white: "White wins",
    black: "Black wins",
    draw: "Draw",
  };

  var END_REASON_LABEL = {
    checkmate: "checkmate",
    stalemate: "stalemate",
    timeout: "timeout",
    resignation: "resignation",
    draw_agreement: "by agreement",
    insufficient: "insufficient material",
    repetition: "repetition",
  };

  // Human sentence describing how a completed game ended.
  function resultText(game) {
    if (game.status !== "completed") return "";
    var base = RESULT_LABEL[game.result] || "Finished";
    var reason = END_REASON_LABEL[game.endReason];
    if (game.result === "draw") {
      return reason ? "Draw — " + reason : "Draw";
    }
    return reason ? base + " by " + reason : base;
  }

  // Render the shared sticky header into the page.
  function renderHeader(active) {
    var links = [
      { href: "/", label: "Home", key: "home" },
      { href: "/log", label: "Log Game", key: "log" },
    ];
    var nav = links
      .map(function (l) {
        var cls = l.key === active ? "active" : "";
        return '<a href="' + l.href + '" class="' + cls + '">' + l.label + "</a>";
      })
      .join("");
    var html =
      '<header class="app-header">' +
      '<a class="brand" href="/"><span class="mark">&#9822;</span> Office Chess</a>' +
      "<nav>" + nav + "</nav>" +
      "</header>";
    var mount = document.getElementById("header");
    if (mount) mount.outerHTML = html;
  }

  // Lightweight bottom toast.
  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove("show");
    }, 1800);
  }

  // Format a pair of move strings into numbered rows for the move grid.
  function moveRows(moves) {
    var rows = [];
    for (var i = 0; i < moves.length; i += 2) {
      rows.push({
        num: i / 2 + 1,
        white: moves[i],
        whiteIdx: i,
        black: moves[i + 1] || null,
        blackIdx: moves[i + 1] ? i + 1 : null,
      });
    }
    return rows;
  }

  global.CT = {
    STARTING_FEN: STARTING_FEN,
    api: api,
    jsonHeaders: jsonHeaders,
    positionFromMoves: positionFromMoves,
    escapeHtml: escapeHtml,
    playerName: playerName,
    resultText: resultText,
    renderHeader: renderHeader,
    toast: toast,
    moveRows: moveRows,
  };
})(window);
