/* Board rendering and checker input shared by the quiz and play pages. */
export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// --- Rendering helpers ---
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
export function make(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}
export function renderDie(n) {
  const d = make('div', 'die', String(n));
  return d;
}
export function renderStack(count, player, orientation) {
  // orientation: 'top' or 'bottom'
  const stack = make('div', 'stack');
  const shown = Math.min(5, count);
  for (let i = 0; i < shown; i++) {
    const ch = make('div', `checker ${player === 'player1' ? 'p1' : 'p2'}`);
    stack.appendChild(ch);
  }
  if (count > 5) {
    // Put count on the innermost checker (closest to center)
    const idx = orientation === 'top' ? shown - 1 : 0;
    const checker = stack.children[idx];
    checker.classList.add('count');
    checker.textContent = String(count);
  }
  return stack;
}

export function pointIndexForTop(col) {
  // With vertical bar at col 6:
  // col 0..5 -> points 13..18
  // col 6 -> vbar (null)
  // col 7..12 -> points 19..24
  if (col === 6) return null;
  return col < 6 ? (13 + col) : (13 + col - 1);
}
export function pointIndexForBottom(col) {
  // With vertical bar at col 6:
  // col 0..5 -> points 12..7
  // col 6 -> vbar (null)
  // col 7..12 -> points 6..1
  if (col === 6) return null;
  return col < 6 ? (12 - col) : (12 - (col - 1));
}
export function p1IndexFromAbsolute(absPoint) {
  return absPoint;
}
export function p2IndexFromAbsolute(absPoint) {
  return 25 - absPoint;
}

export function calculatePipCount(playerPoints) {
  // Pip count is the sum of (point number × checker count) for points 1-24
  // plus 25 for each checker on the bar (index 25).
  // Points are from the player's perspective (1 = closest to bearing off)
  let pipCount = 0;
  for (let i = 1; i <= 25; i++) {
    pipCount += i * (playerPoints[i] || 0);
  }
  return pipCount;
}

export function renderBoard(board, contextDice) {
  const rawTop = $('#points-top');
  const rawBottom = $('#points-bottom');
  const bearP1 = $('#bearoff-p1');
  const bearP2 = $('#bearoff-p2');
  const pipCountP1 = $('#pipcount-p1');
  const pipCountP2 = $('#pipcount-p2');
  const cube = $('#cube');
  const dice = $('#dice');
  const rawPointNumbersTop = $('#point-numbers-top');
  const rawPointNumbersBottom = $('#point-numbers-bottom');

  // Clear both physical rows and number strips
  clear(rawTop); clear(rawBottom); clear(dice);
  clear(rawPointNumbersTop); clear(rawPointNumbersBottom);

  // Depending on orientation, swap which DOM rows act as logical top/bottom
  const top = window.isBoardFlipped ? rawBottom : rawTop;
  const bottom = window.isBoardFlipped ? rawTop : rawBottom;
  const pointNumbersTop = window.isBoardFlipped ? rawPointNumbersBottom : rawPointNumbersTop;
  const pointNumbersBottom = window.isBoardFlipped ? rawPointNumbersTop : rawPointNumbersBottom;

  // Build 13 columns per row (with vertical bar at col 6)
  let vbarTopEl = null;
  let vbarBottomEl = null;
  for (let col = 0; col < 13; col++) {
    // When mirrored, swap columns across the bar (col 6 stays)
    const mapCol = window.isBoardMirrored && col !== 6 ? (12 - col) : col;
    const effectiveCol = mapCol > 6 ? mapCol - 1 : mapCol;

    // Top row
    if (col === 6) {
      const vbarTop = make('div', 'vbar');
      vbarTop.id = 'bar-top';
      vbarTopEl = vbarTop;
      top.appendChild(vbarTop);
    } else {
      const pTop = make('div', 'point' + ((effectiveCol % 2 === 0) ? ' striped' : ''));
      const absTop = pointIndexForTop(mapCol);
      if (absTop != null) {
        pTop.dataset.abs = String(absTop);
        const countTopP1 = board.points.player1[p1IndexFromAbsolute(absTop)] || 0;
        const countTopP2 = board.points.player2[p2IndexFromAbsolute(absTop)] || 0;
        if ((countTopP1 + countTopP2) > 0) {
          const player = countTopP2 > 0 ? 'player2' : 'player1';
          const count = countTopP2 > 0 ? countTopP2 : countTopP1;
          const stackTop = renderStack(count, player, 'top');
          pTop.appendChild(stackTop);
        }
      }
      top.appendChild(pTop);
    }

    // Bottom row
    if (col === 6) {
      const vbarBottom = make('div', 'vbar');
      vbarBottom.id = 'bar-bottom';
      vbarBottomEl = vbarBottom;
      bottom.appendChild(vbarBottom);
    } else {
      const pBot = make('div', 'point' + ((effectiveCol % 2 === 0) ? '' : ' striped'));
      const absBot = pointIndexForBottom(mapCol);
      if (absBot != null) {
        pBot.dataset.abs = String(absBot);
        const countBotP1 = board.points.player1[p1IndexFromAbsolute(absBot)] || 0;
        const countBotP2 = board.points.player2[p2IndexFromAbsolute(absBot)] || 0;
        if ((countBotP1 + countBotP2) > 0) {
          const player = countBotP1 > 0 ? 'player1' : 'player2';
          const count = countBotP1 > 0 ? countBotP1 : countBotP2;
          const stackBot = renderStack(count, player, 'bottom');
          pBot.appendChild(stackBot);
        }
      }
      bottom.appendChild(pBot);
    }
  }

  // Bar
  if (vbarTopEl) {
    const barCountTop = board.points.player2[25] || 0;
    clear(vbarTopEl);
    if (barCountTop > 0) vbarTopEl.appendChild(renderStack(barCountTop, 'player2', 'top'));
  }
  if (vbarBottomEl) {
    const barCountBottom = board.points.player1[25] || 0;
    clear(vbarBottomEl);
    if (barCountBottom > 0) vbarBottomEl.appendChild(renderStack(barCountBottom, 'player1', 'bottom'));
  }

  // Bearoff (right side): top = player2, bottom = player1
  bearP2.textContent = String(board.points.player2[0] || 0);
  bearP1.textContent = String(board.points.player1[0] || 0);

  // Pip counts
  const pip1 = calculatePipCount(board.points.player1);
  const pip2 = calculatePipCount(board.points.player2);
  pipCountP1.textContent = `Pips: ${pip1}`;
  pipCountP2.textContent = `Pips: ${pip2}`;

  // Cube on left
  // In the Crawford game nobody may double: the cube shows "CR", dimmed.
  const crawford = board.ogid?.crawford === true;
  cube.textContent = crawford ? 'CR' : String(board.cube || 1);
  cube.classList.toggle('crawford', crawford);
  cube.title = crawford ? 'Crawford game: no doubling' : '';
  cube.classList.remove('owner-player1', 'owner-player2');
  if (board.cubeOwner === 'player1') cube.classList.add('owner-player1');
  if (board.cubeOwner === 'player2') cube.classList.add('owner-player2');
  placeCube(cube, board.cubeOwner);

  // Dice in center right
  const d = contextDice || board.dice;
  if (d && d.die1 && d.die2) {
    dice.appendChild(renderDie(d.die1));
    dice.appendChild(renderDie(d.die2));
  }

  // Point numbers from current player's perspective
  const currentPlayer = board.turn;

  // Helper to convert absolute point to player's perspective point number
  const getPlayerPointNumber = (absPoint) => {
    if (absPoint < 1 || absPoint > 24) return null;
    if (currentPlayer === 'player1') {
      return absPoint; // Player1's perspective: absolute point = their point number
    } else {
      return 25 - absPoint; // Player2's perspective: mirrored
    }
  };

  // Create point numbers row for top
  const topNumbersRow = make('div', 'point-numbers-row');
  for (let col = 0; col < 13; col++) {
    if (col === 6) {
      const spacer = make('div', 'point-number-spacer');
      topNumbersRow.appendChild(spacer);
    } else {
      const mapColNum = window.isBoardMirrored ? (12 - col) : col;
      const absTop = pointIndexForTop(mapColNum);
      const playerPointNum = absTop != null ? getPlayerPointNumber(absTop) : null;
      const numEl = make('div', 'point-number', playerPointNum != null ? String(playerPointNum) : '');
      topNumbersRow.appendChild(numEl);
    }
  }
  pointNumbersTop.appendChild(topNumbersRow);

  // Create point numbers row for bottom
  const bottomNumbersRow = make('div', 'point-numbers-row');
  for (let col = 0; col < 13; col++) {
    if (col === 6) {
      const spacer = make('div', 'point-number-spacer');
      bottomNumbersRow.appendChild(spacer);
    } else {
      const mapColNum = window.isBoardMirrored ? (12 - col) : col;
      const absBot = pointIndexForBottom(mapColNum);
      const playerPointNum = absBot != null ? getPlayerPointNumber(absBot) : null;
      const numEl = make('div', 'point-number', playerPointNum != null ? String(playerPointNum) : '');
      bottomNumbersRow.appendChild(numEl);
    }
  }
  pointNumbersBottom.appendChild(bottomNumbersRow);
}

/**
 * An owned cube sits on its owner's side, level with the outermost checkers;
 * a centred cube stays in the middle. The cube column has the same rows as
 * the points (half, centre strip, half), each half with a lane as tall as
 * the checker stacks. Player 1's checkers are at the bottom unless flipped.
 */
function placeCube(cube, owner) {
  const column = cube.closest('.bearoff-left');
  if (!column.querySelector('.cube-slot')) {
    for (const position of ['top', 'middle', 'bottom']) {
      const slot = make('div', `cube-slot cube-slot-${position}`);
      slot.appendChild(make('div', 'cube-lane'));
      column.appendChild(slot);
    }
  }
  let position = 'middle';
  if (owner) {
    const ownerAtBottom = owner === 'player1' ? !window.isBoardFlipped : Boolean(window.isBoardFlipped);
    position = ownerAtBottom ? 'bottom' : 'top';
  }
  const lane = column.querySelector(`.cube-slot-${position} .cube-lane`);
  if (cube.parentElement !== lane) lane.appendChild(cube);
}

/**
 * A board for `base` with the mover's side replaced by a position in the
 * window.checkerPlay format (seen from base.turn).
 */
export function boardFromPosition(base, points) {
  const me = base.turn;
  const opp = me === 'player1' ? 'player2' : 'player1';
  const mine = new Array(26).fill(0);
  const theirs = new Array(26).fill(0);
  for (let point = 1; point <= 24; point++) {
    if (points[point] > 0) mine[point] = points[point];
    else if (points[point] < 0) theirs[25 - point] = -points[point];
  }
  mine[25] = points[25];
  theirs[25] = points[0];
  const onBoard = (side) => side.slice(1).reduce((sum, count) => sum + count, 0);
  mine[0] = 15 - onBoard(mine);
  theirs[0] = 15 - onBoard(theirs);
  return { ...base, points: { [me]: mine, [opp]: theirs } };
}

/**
 * Moving checkers on the board, by dragging or by tapping a checker and then
 * its destination. The server sends every legal play with a key for the
 * position it leads to; window.checkerPlay accepts a move while it can still
 * end in one of them. Movable checkers are deliberately not marked: only the
 * picked-up checker and its destinations are highlighted.
 *
 * In fast mode a tap on a checker moves it by the first unused die, in the
 * order the dice are shown (the other die if the first can't be played from
 * there); a ⇄ next to the dice swaps that order. Dragging works as always.
 */
export class MoveInput {
  /** @param {{ onChange?: () => void }} [options] called after every move, undo or reset */
  constructor({ onChange } = {}) {
    this.onChange = onChange || (() => {});
    this.base = null;
    this.dice = null;
    this.play = null;
    this.active = false;
    this.selected = null;
    this.drag = null;
    this.previewMove = null;
    this.fastMove = false;
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onPointerCancel = this.onPointerCancel.bind(this);
    $('#board').addEventListener('pointerdown', this.onPointerDown);
  }

  /** Show a position without accepting moves. */
  show(board, dice) {
    this.endDrag();
    this.base = board;
    this.dice = dice || null;
    this.play = null;
    this.active = false;
    this.selected = null;
    this.previewMove = null;
    this.redraw();
  }

  /**
   * Show the position after a play in move notation (e.g. a play picked in
   * an analysis), with the points it leaves and reaches marked; null shows
   * the board as before. The play starts from the shown position, before any
   * checkers moved on the board.
   */
  preview(move) {
    const next = move || null;
    if (next === this.previewMove) return;
    this.previewMove = next;
    this.redraw();
  }

  previewPoints() {
    if (!this.previewMove || !this.base) return null;
    return window.checkerPlay.applyMoveText(window.checkerPlay.positionFromBoard(this.base), this.previewMove);
  }

  /**
   * Accept moves for the player on roll in the shown position.
   * @param {{ position: number[], dice: number[], plays: Array<{ move: string, key: string }> }} legal
   */
  enable(legal) {
    const start = window.checkerPlay.positionFromBoard(this.base);
    if (window.checkerPlay.positionKey(start) !== window.checkerPlay.positionKey(legal.position)) {
      throw new Error('Legal plays do not belong to the position on the board');
    }
    this.play = window.checkerPlay.createPlay(start, legal.dice, legal.plays);
    this.active = true;
    this.selected = null;
    this.previewMove = null;
    this.redraw();
  }

  setActive(active) {
    this.active = Boolean(active && this.play);
    this.selected = null;
    if (!this.active) this.endDrag();
    this.redraw();
  }

  displayedBoard() {
    const previewed = this.previewPoints();
    if (previewed) return boardFromPosition(this.base, previewed);
    if (this.play && this.play.moveCount > 0) return boardFromPosition(this.base, this.play.points);
    return this.base;
  }

  redraw() {
    if (!this.base) return;
    renderBoard(this.displayedBoard(), this.dice);
    this.decorate();
    this.decorateSwap();
    this.markPreview();
  }

  /** Mark where a previewed play takes checkers from and to. */
  markPreview() {
    const after = this.previewPoints();
    // Some elements (the trays) survive a redraw.
    $$('.preview-from, .preview-to').forEach((el) => el.classList.remove('preview-from', 'preview-to'));
    $('#board').classList.toggle('previewing', Boolean(after));
    if (!after) return;
    const before = window.checkerPlay.positionFromBoard(this.base);
    const mover = this.base.turn;
    const point = (mp) => $(`#board .point[data-abs="${mover === 'player1' ? mp : 25 - mp}"]`);
    for (let mp = 1; mp <= 24; mp++) {
      const was = Math.max(0, before[mp]);
      const now = Math.max(0, after[mp]);
      if (now < was) point(mp)?.classList.add('preview-from');
      if (now > was) point(mp)?.classList.add('preview-to');
    }
    const { BAR } = window.checkerPlay;
    if (after[BAR] < before[BAR]) $(mover === 'player1' ? '#bar-bottom' : '#bar-top')?.classList.add('preview-from');
    const onBoard = (points) => points.slice(1).reduce((sum, count) => sum + Math.max(0, count), 0);
    if (onBoard(after) < onBoard(before)) $(mover === 'player1' ? '#bearoff-p1' : '#bearoff-p2')?.classList.add('preview-to');
  }

  undo() {
    if (this.play?.undo()) this.changed();
  }

  setFastMove(enabled) {
    this.fastMove = Boolean(enabled);
    this.selected = null;
    this.redraw();
  }

  /** Swap the order of the dice, which decides the die a fast-mode tap plays first. */
  swapDice() {
    if (!this.dice) return;
    this.dice = { ...this.dice, die1: this.dice.die2, die2: this.dice.die1 };
    this.redraw();
  }

  /** Fast mode: move the checker on `from` by the first die in the shown order that can be played. */
  moveFirstDie(from) {
    const remaining = this.play.remaining;
    const order = [this.dice?.die1, this.dice?.die2].filter((die) => remaining.includes(die));
    for (const die of order.length ? order : remaining) {
      if (this.play.moveDie(from, die)) {
        this.changed();
        return true;
      }
    }
    this.select(null);
    return false;
  }

  /** The ⇄ beside the dice, while swapping them can still change a fast-mode play. */
  decorateSwap() {
    const dice = this.dice;
    const show = this.fastMove && this.active && this.play?.moveCount === 0
      && dice && dice.die1 !== dice.die2;
    if (!show) return;
    const swap = make('span', 'dice-swap', '⇄');
    swap.title = 'Swap the dice: play the other one first (S)';
    swap.setAttribute('role', 'button');
    swap.addEventListener('pointerdown', (event) => event.stopPropagation());
    swap.addEventListener('click', (event) => {
      event.stopPropagation();
      this.swapDice();
    });
    $('#dice')?.prepend(swap);
  }

  reset() {
    if (!this.play || this.play.moveCount === 0) return;
    this.play.reset();
    this.changed();
  }

  changed() {
    this.selected = null;
    this.redraw();
    this.onChange();
  }

  /** Mark the board elements with the mover's point numbers and highlight moves. */
  decorate() {
    const boardEl = $('#board');
    const interactive = Boolean(this.active && this.play);
    boardEl.classList.toggle('interactive', interactive);
    $$('#board [data-mp]').forEach((el) => {
      delete el.dataset.mp;
      el.classList.remove('movable', 'selected', 'target');
    });
    if (!interactive) return;

    const mover = this.base.turn;
    $$('#board .point[data-abs]').forEach((el) => {
      const abs = Number(el.dataset.abs);
      el.dataset.mp = String(mover === 'player1' ? abs : 25 - abs);
    });
    const bar = $(mover === 'player1' ? '#bar-bottom' : '#bar-top');
    if (bar) bar.dataset.mp = String(window.checkerPlay.BAR);
    const tray = $(mover === 'player1' ? '#bearoff-p1' : '#bearoff-p2');
    if (tray) tray.dataset.mp = String(window.checkerPlay.OFF);

    const { play, selected } = this;
    const sources = play.movableFrom();
    const targets = selected != null ? play.destinationsFrom(selected).map((entry) => entry.to) : [];
    $$('#board [data-mp]').forEach((el) => {
      const mp = Number(el.dataset.mp);
      el.classList.toggle('movable', sources.includes(mp));
      el.classList.toggle('selected', mp === selected);
      el.classList.toggle('target', targets.includes(mp));
    });

    // Dim the dice that are used up.
    const dice = this.dice;
    const dieEls = $$('#dice .die');
    if (dice && dieEls.length === 2) {
      const remaining = play.remaining;
      if (dice.die1 === dice.die2) {
        dieEls.forEach((el, index) => el.classList.toggle('used', remaining.length <= (1 - index) * 2));
      } else {
        dieEls[0].classList.toggle('used', !remaining.includes(dice.die1));
        dieEls[1].classList.toggle('used', !remaining.includes(dice.die2));
      }
    }
  }

  moveTo(from, to) {
    if (!this.play?.move(from, to)) return false;
    this.changed();
    return true;
  }

  select(point) {
    this.selected = point;
    this.decorate();
  }

  onPointerDown(event) {
    if (!this.active || !this.play || event.button > 0) return;
    if (this.previewMove) {
      // A play shown from an analysis gives way as soon as checkers are moved.
      this.previewMove = null;
      this.redraw();
    }
    const el = event.target.closest('#board [data-mp]');
    if (!el) {
      if (this.selected != null) this.select(null);
      return;
    }
    const point = Number(el.dataset.mp);
    const { play, selected } = this;
    if (!this.fastMove && selected != null && selected !== point && play.destinationsFrom(selected).some((entry) => entry.to === point)) {
      event.preventDefault();
      this.moveTo(selected, point);
      return;
    }
    if (!play.movableFrom().includes(point)) {
      this.select(null);
      return;
    }
    event.preventDefault();
    this.drag = {
      from: point,
      wasSelected: selected === point,
      startX: event.clientX,
      startY: event.clientY,
      ghost: null
    };
    this.select(point);
    // Follow the pointer outside the board too, until it is released.
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerCancel);
  }

  endDrag() {
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerCancel);
    if (this.drag?.ghost) this.drag.ghost.remove();
    this.drag = null;
  }

  onPointerMove(event) {
    const drag = this.drag;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.ghost && Math.hypot(dx, dy) > 6) {
      drag.ghost = make('div', `checker drag-ghost ${this.base.turn === 'player1' ? 'p1' : 'p2'}`);
      document.body.appendChild(drag.ghost);
    }
    if (drag.ghost) {
      drag.ghost.style.left = `${event.clientX}px`;
      drag.ghost.style.top = `${event.clientY}px`;
    }
  }

  onPointerUp(event) {
    const drag = this.drag;
    if (!drag) return;
    const dragged = Boolean(drag.ghost);
    this.endDrag();
    if (dragged) {
      const el = document.elementFromPoint(event.clientX, event.clientY)?.closest('#board [data-mp]');
      const target = el ? Number(el.dataset.mp) : null;
      // Dropped elsewhere: keep the checker selected so a tap can finish the move.
      if (target != null && target !== drag.from) this.moveTo(drag.from, target);
      return;
    }
    if (this.fastMove) {
      this.moveFirstDie(drag.from);
      return;
    }
    // A tap on the checker that was already selected deselects it.
    if (drag.wasSelected) this.select(null);
  }

  onPointerCancel() {
    this.endDrag();
  }
}
