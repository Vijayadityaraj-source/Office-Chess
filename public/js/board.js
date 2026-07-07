/*
 * ChessBoard — a minimal, dependency-free board renderer.
 *
 * Renders an 8x8 board (chess.com green theme), places pieces from a FEN
 * position, animates moves, highlights the last move, and optionally supports
 * interactive drag / click-to-move with legal-move validation delegated to a
 * caller-supplied onDrop handler.
 *
 * Usage:
 *   const board = new ChessBoard(el, { orientation: 'white', interactive: true,
 *                                      onDrop: (from, to) => 'snapback' | true });
 *   board.setPosition(fen, animate);
 *   board.highlight(['e2', 'e4']);
 */
(function (global) {
  "use strict";

  var FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
  var PIECE_PATH = "/public/img/pieces/";

  // Map a FEN piece letter to a "<color><Piece>" sprite name (e.g. wP, bN).
  function spriteName(fenChar) {
    var color = fenChar === fenChar.toUpperCase() ? "w" : "b";
    return color + fenChar.toUpperCase();
  }

  // Parse the piece-placement field of a FEN into { square: fenChar }.
  function parseFen(fen) {
    var placement = fen.split(" ")[0];
    var rows = placement.split("/");
    var map = {};
    for (var r = 0; r < 8; r++) {
      var rank = 8 - r;
      var file = 0;
      var row = rows[r];
      for (var i = 0; i < row.length; i++) {
        var ch = row[i];
        if (/\d/.test(ch)) {
          file += parseInt(ch, 10);
        } else {
          map[FILES[file] + rank] = ch;
          file += 1;
        }
      }
    }
    return map;
  }

  function ChessBoard(el, opts) {
    opts = opts || {};
    this.el = typeof el === "string" ? document.querySelector(el) : el;
    this.orientationValue = opts.orientation || "white";
    this.interactive = !!opts.interactive;
    this.showCoords = opts.showCoords !== false;
    this.onDrop = opts.onDrop || null;
    this.position = {}; // square -> fenChar
    this.pieceEls = {}; // square -> element
    this.selected = null; // currently selected square (click-to-move)
    this._drag = null;

    this._build();
  }

  ChessBoard.prototype._build = function () {
    this.el.classList.add("cb-board");
    this.el.innerHTML = "";

    // Squares layer (colours, coordinates, highlight targets).
    this.squaresLayer = document.createElement("div");
    this.squaresLayer.className = "cb-squares";
    this.el.appendChild(this.squaresLayer);

    this.squareEls = {};
    for (var r = 0; r < 8; r++) {
      for (var f = 0; f < 8; f++) {
        var sq = document.createElement("div");
        var dark = (r + f) % 2 === 1;
        sq.className = "cb-square " + (dark ? "cb-dark" : "cb-light");
        this.squaresLayer.appendChild(sq);
        this.squareEls[r * 8 + f] = sq;
      }
    }

    // Piece layer (absolutely positioned pieces that animate independently).
    this.pieceLayer = document.createElement("div");
    this.pieceLayer.className = "cb-pieces";
    this.el.appendChild(this.pieceLayer);

    this._renderCoords();

    if (this.interactive) {
      this._bindInteraction();
    }
  };

  // Compute the [col, row] grid cell for a square given board orientation.
  ChessBoard.prototype._cell = function (square) {
    var fileIdx = FILES.indexOf(square[0]);
    var rank = parseInt(square[1], 10);
    if (this.orientationValue === "white") {
      return [fileIdx, 8 - rank];
    }
    return [7 - fileIdx, rank - 1];
  };

  // Inverse of _cell: grid cell -> square name.
  ChessBoard.prototype._square = function (col, row) {
    var fileIdx, rank;
    if (this.orientationValue === "white") {
      fileIdx = col;
      rank = 8 - row;
    } else {
      fileIdx = 7 - col;
      rank = row + 1;
    }
    if (fileIdx < 0 || fileIdx > 7 || rank < 1 || rank > 8) return null;
    return FILES[fileIdx] + rank;
  };

  ChessBoard.prototype._renderCoords = function () {
    // Clear any existing coordinate labels.
    var old = this.el.querySelectorAll(".cb-coord");
    old.forEach(function (n) { n.remove(); });
    if (!this.showCoords) return;

    for (var i = 0; i < 8; i++) {
      var fileLabel = document.createElement("div");
      fileLabel.className = "cb-coord cb-coord-file";
      var rankLabel = document.createElement("div");
      rankLabel.className = "cb-coord cb-coord-rank";
      if (this.orientationValue === "white") {
        fileLabel.textContent = FILES[i];
        rankLabel.textContent = 8 - i;
      } else {
        fileLabel.textContent = FILES[7 - i];
        rankLabel.textContent = i + 1;
      }
      fileLabel.style.left = i * 12.5 + 1 + "%";
      rankLabel.style.top = i * 12.5 + 0.5 + "%";
      this.el.appendChild(fileLabel);
      this.el.appendChild(rankLabel);
    }
  };

  ChessBoard.prototype._placePieceEl = function (pieceEl, square) {
    var cell = this._cell(square);
    pieceEl.style.left = cell[0] * 12.5 + "%";
    pieceEl.style.top = cell[1] * 12.5 + "%";
  };

  ChessBoard.prototype._makePieceEl = function (fenChar, square) {
    var pieceEl = document.createElement("div");
    pieceEl.className = "cb-piece";
    pieceEl.dataset.square = square;
    pieceEl.style.backgroundImage =
      "url(" + PIECE_PATH + spriteName(fenChar) + ".svg)";
    this._placePieceEl(pieceEl, square);
    return pieceEl;
  };

  /**
   * Set the board to a FEN position. When animate is true, pieces that move to
   * an already-occupied-by-them-adjacent square glide; new/removed pieces fade.
   */
  ChessBoard.prototype.setPosition = function (fen, animate) {
    var next = parseFen(fen);
    var self = this;

    if (!animate) {
      this.pieceLayer.innerHTML = "";
      this.pieceEls = {};
      Object.keys(next).forEach(function (sq) {
        var pe = self._makePieceEl(next[sq], sq);
        self.pieceLayer.appendChild(pe);
        self.pieceEls[sq] = pe;
      });
      this.position = next;
      return;
    }

    // Diff old vs new. Find the piece that moved (from -> to) so it animates.
    var prev = this.position;
    var removed = [];
    var added = [];
    var sq;
    for (sq in prev) {
      if (next[sq] !== prev[sq]) removed.push(sq);
    }
    for (sq in next) {
      if (prev[sq] !== next[sq]) added.push(sq);
    }

    var newEls = {};
    // Reuse existing elements where the same piece appears on a destination,
    // gliding them from their old square.
    added.forEach(function (toSq) {
      var piece = next[toSq];
      // Find a removed square holding the same piece type to glide from.
      var fromSq = null;
      for (var i = 0; i < removed.length; i++) {
        if (prev[removed[i]] === piece && !newEls[removed[i]]) {
          fromSq = removed[i];
          break;
        }
      }
      if (fromSq && self.pieceEls[fromSq]) {
        var el = self.pieceEls[fromSq];
        // If something already sits on the destination (capture), remove it.
        if (self.pieceEls[toSq]) {
          self.pieceEls[toSq].remove();
        }
        el.dataset.square = toSq;
        self._placePieceEl(el, toSq);
        newEls[toSq] = el;
        removed.splice(removed.indexOf(fromSq), 1);
        delete self.pieceEls[fromSq];
      } else {
        // Brand new piece: fade in.
        if (self.pieceEls[toSq]) self.pieceEls[toSq].remove();
        var pe = self._makePieceEl(piece, toSq);
        pe.classList.add("cb-fade-in");
        self.pieceLayer.appendChild(pe);
        newEls[toSq] = pe;
      }
    });

    // Remove leftover pieces that vanished (e.g. captured en passant).
    removed.forEach(function (fromSq) {
      if (self.pieceEls[fromSq]) {
        self.pieceEls[fromSq].remove();
        delete self.pieceEls[fromSq];
      }
    });

    // Merge unchanged pieces.
    for (sq in this.pieceEls) {
      if (!newEls[sq]) newEls[sq] = this.pieceEls[sq];
    }
    this.pieceEls = newEls;
    this.position = next;
  };

  ChessBoard.prototype.highlight = function (squares) {
    this.clearHighlights();
    var self = this;
    (squares || []).forEach(function (sq) {
      var cell = self._cell(sq);
      var idx = cell[1] * 8 + cell[0];
      var el = self.squareEls[idx];
      if (el) el.classList.add("cb-highlight");
    });
  };

  ChessBoard.prototype.clearHighlights = function () {
    var els = this.squaresLayer.querySelectorAll(".cb-highlight");
    els.forEach(function (n) { n.classList.remove("cb-highlight"); });
  };

  ChessBoard.prototype._clearSelection = function () {
    var els = this.squaresLayer.querySelectorAll(".cb-select, .cb-move-dot");
    els.forEach(function (n) {
      n.classList.remove("cb-select", "cb-move-dot");
    });
    this.selected = null;
  };

  ChessBoard.prototype._markSelection = function (square) {
    var cell = this._cell(square);
    var idx = cell[1] * 8 + cell[0];
    var el = this.squareEls[idx];
    if (el) el.classList.add("cb-select");
    this.selected = square;
  };

  ChessBoard.prototype.setOrientation = function (o) {
    this.orientationValue = o;
    this._renderCoords();
    var self = this;
    Object.keys(this.pieceEls).forEach(function (sq) {
      self._placePieceEl(self.pieceEls[sq], sq);
    });
  };

  // ---- Interaction (drag + click-to-move) --------------------------------

  ChessBoard.prototype._squareFromEvent = function (evt) {
    var rect = this.el.getBoundingClientRect();
    var x = (evt.clientX - rect.left) / rect.width;
    var y = (evt.clientY - rect.top) / rect.height;
    var col = Math.floor(x * 8);
    var row = Math.floor(y * 8);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return this._square(col, row);
  };

  ChessBoard.prototype._bindInteraction = function () {
    var self = this;

    this.el.addEventListener("pointerdown", function (evt) {
      var square = self._squareFromEvent(evt);
      if (!square) return;
      var pieceEl = self.pieceEls[square];

      // Click-to-move: a square is already selected -> attempt the move.
      if (self.selected && self.selected !== square) {
        var from = self.selected;
        self._clearSelection();
        self._attemptMove(from, square);
        return;
      }

      if (!pieceEl) {
        self._clearSelection();
        return;
      }

      // Begin a potential drag while also arming click-to-move selection.
      evt.preventDefault();
      self._clearSelection();
      self._markSelection(square);

      self._drag = {
        from: square,
        el: pieceEl,
        moved: false,
        startX: evt.clientX,
        startY: evt.clientY,
      };
      pieceEl.classList.add("cb-dragging");
      pieceEl.setPointerCapture && pieceEl.setPointerCapture(evt.pointerId);
    });

    this.el.addEventListener("pointermove", function (evt) {
      if (!self._drag) return;
      var d = self._drag;
      var dx = evt.clientX - d.startX;
      var dy = evt.clientY - d.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
      // Offset the piece from its resting cell by the pointer delta.
      d.el.style.transform = "translate(" + dx + "px," + dy + "px)";
      d.el.style.zIndex = 20;
    });

    var endDrag = function (evt) {
      if (!self._drag) return;
      var d = self._drag;
      d.el.classList.remove("cb-dragging");
      d.el.style.transform = "";
      d.el.style.zIndex = "";

      if (d.moved) {
        var target = self._squareFromEvent(evt);
        self._clearSelection();
        if (target && target !== d.from) {
          self._attemptMove(d.from, target);
        }
      }
      // If not moved, selection stays for click-to-move.
      self._drag = null;
    };

    this.el.addEventListener("pointerup", endDrag);
    this.el.addEventListener("pointercancel", endDrag);
  };

  ChessBoard.prototype._attemptMove = function (from, to) {
    if (!this.onDrop) return;
    var result = this.onDrop(from, to);
    // If the handler rejects the move it returns 'snapback'; snap the piece
    // back to its origin position.
    if (result === "snapback") {
      var el = this.pieceEls[from];
      if (el) this._placePieceEl(el, from);
    }
  };

  global.ChessBoard = ChessBoard;
})(window);
