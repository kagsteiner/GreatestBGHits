/* global fetch */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const authFetch = (...args) => window.dgAuth.authFetch(...args);

// --- Rendering helpers ---
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
function make(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}
function renderDie(n) {
  const d = make('div', 'die', String(n));
  return d;
}
function renderStack(count, player, orientation) {
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

function pointIndexForTop(col) {
  // With vertical bar at col 6:
  // col 0..5 -> points 13..18
  // col 6 -> vbar (null)
  // col 7..12 -> points 19..24
  if (col === 6) return null;
  return col < 6 ? (13 + col) : (13 + col - 1);
}
function pointIndexForBottom(col) {
  // With vertical bar at col 6:
  // col 0..5 -> points 12..7
  // col 6 -> vbar (null)
  // col 7..12 -> points 6..1
  if (col === 6) return null;
  return col < 6 ? (12 - col) : (12 - (col - 1));
}
function p1IndexFromAbsolute(absPoint) {
  return absPoint;
}
function p2IndexFromAbsolute(absPoint) {
  return 25 - absPoint;
}

function calculatePipCount(playerPoints) {
  // Pip count is the sum of (point number × checker count) for points 1-24
  // plus 25 for each checker on the bar (index 25).
  // Points are from the player's perspective (1 = closest to bearing off)
  let pipCount = 0;
  for (let i = 1; i <= 25; i++) {
    pipCount += i * (playerPoints[i] || 0);
  }
  return pipCount;
}

function renderBoard(board, contextDice) {
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
  cube.textContent = String(board.cube || 1);
  cube.classList.remove('owner-player1', 'owner-player2');
  if (board.cubeOwner === 'player1') cube.classList.add('owner-player1');
  if (board.cubeOwner === 'player2') cube.classList.add('owner-player2');

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

// --- Debug helpers ---
function logBoardCompact(board) {
  const p1 = board.points.player1;
  const p2 = board.points.player2;
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  const pointParts = [];
  for (let i = 1; i <= 24; i++) {
    const a = p1[i] || 0;
    const b = p2[i] || 0;
    if (a || b) {
      const who = [];
      if (a) who.push(`P1=${a}`);
      if (b) who.push(`P2=${b}`);
      pointParts.push(`${i}:` + who.join(','));
    }
  }
  const compact = [
    `turn=${board.turn}`,
    `cube=${board.cube}${board.cubeOwner ? `(${board.cubeOwner})` : ''}`,
    `dice=${board.dice ? `${board.dice.die1}-${board.dice.die2}` : '-'}`,
    `P1 total=${sum(p1)} off=${p1[0] || 0} bar=${p1[25] || 0}`,
    `P2 total=${sum(p2)} off=${p2[0] || 0} bar=${p2[25] || 0}`,
    `points=[ ${pointParts.join(' | ')} ]`
  ].join(' • ');
  // One compact line plus a structured object for inspection
  // eslint-disable-next-line no-console
  console.log('[BG] Board compact:', compact, { p1, p2 });
}

// --- Quiz flow ---
let currentQuiz = null;
let selection = null;
let selectedPlayer = '';
let selectedMatch = '';
let selectedMode = 'mixed';
let renderedOptions = [];
let answeredSelection = null;
let quizRequestSequence = 0;
window.isBoardFlipped = false;
window.isBoardMirrored = false;
window.isBoardOrientationLocked = false;
let currentBoard = null;

// --- Moving checkers on the board ---
// The server sends every legal play with a key for the position it leads to;
// window.checkerPlay accepts a move while it can still end in one of them.
// A finished play selects the matching answer option, or adds the play as an
// extra option that the engine rates when the answer is submitted.
let boardPlay = null; // { quizId, status: 'loading'|'ready'|'unavailable', play, options, selected, active }
let boardDrag = null;
const CUSTOM_OPTION_KEY = 'custom';

function boardFromPosition(base, points) {
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

function displayedBoard() {
  if (boardPlay?.play && boardPlay.play.moveCount > 0) {
    return boardFromPosition(currentBoard, boardPlay.play.points);
  }
  return currentBoard;
}

function redrawBoard() {
  if (!currentBoard || !currentQuiz) return;
  renderBoard(displayedBoard(), currentQuiz?.context?.dice || null);
  decorateBoard();
}

/** Mark the board elements with the mover's point numbers and highlight moves. */
function decorateBoard() {
  const boardEl = $('#board');
  const interactive = Boolean(boardPlay?.active && boardPlay.play);
  boardEl.classList.toggle('interactive', interactive);
  $$('#board [data-mp]').forEach((el) => {
    delete el.dataset.mp;
    el.classList.remove('movable', 'selected', 'target');
  });
  if (!interactive) return;

  const mover = currentBoard.turn;
  $$('#board .point[data-abs]').forEach((el) => {
    const abs = Number(el.dataset.abs);
    el.dataset.mp = String(mover === 'player1' ? abs : 25 - abs);
  });
  const bar = $(mover === 'player1' ? '#bar-bottom' : '#bar-top');
  if (bar) bar.dataset.mp = String(window.checkerPlay.BAR);
  const tray = $(mover === 'player1' ? '#bearoff-p1' : '#bearoff-p2');
  if (tray) tray.dataset.mp = String(window.checkerPlay.OFF);

  const { play, selected } = boardPlay;
  const sources = play.movableFrom();
  const targets = selected != null ? play.destinationsFrom(selected).map((entry) => entry.to) : [];
  $$('#board [data-mp]').forEach((el) => {
    const mp = Number(el.dataset.mp);
    el.classList.toggle('movable', sources.includes(mp));
    el.classList.toggle('selected', mp === selected);
    el.classList.toggle('target', targets.includes(mp));
  });

  // Dim the dice that are used up.
  const dice = currentQuiz?.context?.dice;
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

function updateBoardPlayPanel() {
  const panel = $('#boardPlay');
  const status = $('#boardPlayStatus');
  if (!panel || !status) return;
  if (!boardPlay) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const play = boardPlay.play;
  const showButtons = Boolean(play && boardPlay.active);
  $('#boardUndoBtn').hidden = !showButtons;
  $('#boardResetBtn').hidden = !showButtons;
  if (boardPlay.status === 'loading') {
    status.textContent = 'Preparing the board for moving checkers…';
  } else if (boardPlay.status === 'unavailable') {
    status.textContent = 'Moving checkers on the board is unavailable right now.';
  } else if (!play) {
    status.textContent = '';
  } else if (play.moveCount === 0) {
    status.textContent = boardPlay.active ? 'Or move the checkers on the board.' : '';
  } else if (play.isComplete()) {
    status.textContent = `Your move: ${play.finalMove()}`;
  } else {
    status.textContent = `Dice left: ${play.remaining.join(' ')}`;
  }
  $('#boardUndoBtn').disabled = !play || play.moveCount === 0;
  $('#boardResetBtn').disabled = !play || play.moveCount === 0;
}

function removeCustomOption() {
  $$('#options .option.custom-option').forEach((row) => row.remove());
  renderedOptions = renderedOptions.filter((option) => option.key !== CUSTOM_OPTION_KEY);
  if (selection?.key === CUSTOM_OPTION_KEY) selection = null;
}

/** Select the answer option that the play on the board corresponds to. */
function syncSelectionWithBoard() {
  removeCustomOption();
  const play = boardPlay?.play;
  if (!play || play.moveCount === 0 || !play.isComplete()) {
    if (selection?.fromBoard || (play && play.moveCount > 0)) {
      $$('#options input[type="radio"]').forEach((input) => { input.checked = false; });
      selection = null;
      $('#rateBtn').disabled = true;
    }
    return;
  }
  const key = play.finalKey();
  const match = renderedOptions.find((option) => boardPlay.options[option.key] === key);
  if (match) {
    const input = $$('#options input[type="radio"]').find((el) => el.value === match.key);
    if (input) input.checked = true;
    selection = { ...match, fromBoard: true };
  } else {
    const custom = {
      key: CUSTOM_OPTION_KEY,
      label: play.finalMove(),
      equity: null,
      correct: false,
      custom: true
    };
    renderedOptions.push(custom);
    const row = make('div', 'option custom-option');
    const input = make('input');
    input.type = 'radio';
    input.name = 'move';
    input.value = CUSTOM_OPTION_KEY;
    input.id = 'opt-custom';
    input.checked = true;
    input.addEventListener('change', () => {
      selection = { ...custom, fromBoard: true };
      $('#rateBtn').disabled = false;
    });
    const label = make('label', null, `${custom.label} (your move)`);
    label.setAttribute('for', input.id);
    row.appendChild(input);
    row.appendChild(label);
    $('#options').appendChild(row);
    selection = { ...custom, fromBoard: true };
  }
  $('#rateBtn').disabled = false;
}

function boardPlayChanged() {
  if (boardPlay) boardPlay.selected = null;
  redrawBoard();
  syncSelectionWithBoard();
  updateBoardPlayPanel();
}

/** A radio button was picked: a different answer discards the play on the board. */
function onOptionPicked(option) {
  const play = boardPlay?.play;
  if (!play || play.moveCount === 0) return;
  if (play.isComplete() && boardPlay.options[option.key] === play.finalKey()) return;
  play.reset();
  removeCustomOption();
  selection = option;
  boardPlay.selected = null;
  redrawBoard();
  updateBoardPlayPanel();
}

async function startBoardPlay(quiz, board) {
  boardPlay = null;
  boardDrag = null;
  if (quizGroup(quiz) !== 'checker' || !quiz?.id || !window.checkerPlay) {
    updateBoardPlayPanel();
    return;
  }
  const quizId = String(quiz.id);
  boardPlay = { quizId, status: 'loading', play: null, options: {}, selected: null, active: false };
  updateBoardPlayPanel();
  try {
    const response = await authFetch(`legalPlays/${encodeURIComponent(quizId)}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Legal plays request failed (${response.status})`);
    if (boardPlay?.quizId !== quizId || currentQuiz?.id !== quiz.id) return;
    const start = window.checkerPlay.positionFromBoard(board);
    if (window.checkerPlay.positionKey(start) !== window.checkerPlay.positionKey(payload.position)) {
      throw new Error('Legal plays do not belong to the position on the board');
    }
    boardPlay.play = window.checkerPlay.createPlay(start, payload.dice, payload.plays);
    boardPlay.options = payload.options || {};
    boardPlay.status = 'ready';
    boardPlay.active = !answeredSelection;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[BG] Moving checkers unavailable:', error);
    if (boardPlay?.quizId !== quizId) return;
    boardPlay.status = 'unavailable';
  }
  redrawBoard();
  updateBoardPlayPanel();
}

function stopBoardPlay() {
  if (!boardPlay) return;
  boardPlay.active = false;
  boardPlay.selected = null;
  endBoardDrag();
  redrawBoard();
  updateBoardPlayPanel();
}

function moveOnBoard(from, to) {
  if (!boardPlay?.play?.move(from, to)) return false;
  boardPlayChanged();
  return true;
}

function setBoardSelection(point) {
  if (!boardPlay) return;
  boardPlay.selected = point;
  decorateBoard();
}

function removeDragGhost() {
  if (boardDrag?.ghost) boardDrag.ghost.remove();
  boardDrag = null;
}

function boardPointAt(x, y) {
  const el = document.elementFromPoint(x, y)?.closest('#board [data-mp]');
  return el ? Number(el.dataset.mp) : null;
}

function onBoardPointerDown(event) {
  if (!boardPlay?.active || !boardPlay.play || event.button > 0) return;
  const el = event.target.closest('#board [data-mp]');
  if (!el) {
    if (boardPlay.selected != null) setBoardSelection(null);
    return;
  }
  const point = Number(el.dataset.mp);
  const { play, selected } = boardPlay;
  if (selected != null && selected !== point && play.destinationsFrom(selected).some((entry) => entry.to === point)) {
    event.preventDefault();
    moveOnBoard(selected, point);
    return;
  }
  if (!play.movableFrom().includes(point)) {
    setBoardSelection(null);
    return;
  }
  event.preventDefault();
  boardDrag = {
    from: point,
    wasSelected: selected === point,
    startX: event.clientX,
    startY: event.clientY,
    ghost: null
  };
  setBoardSelection(point);
  // Follow the pointer outside the board too, until it is released.
  window.addEventListener('pointermove', onBoardPointerMove);
  window.addEventListener('pointerup', onBoardPointerUp);
  window.addEventListener('pointercancel', onBoardPointerCancel);
}

function endBoardDrag() {
  window.removeEventListener('pointermove', onBoardPointerMove);
  window.removeEventListener('pointerup', onBoardPointerUp);
  window.removeEventListener('pointercancel', onBoardPointerCancel);
  removeDragGhost();
}

function onBoardPointerMove(event) {
  if (!boardDrag) return;
  const dx = event.clientX - boardDrag.startX;
  const dy = event.clientY - boardDrag.startY;
  if (!boardDrag.ghost && Math.hypot(dx, dy) > 6) {
    const ghost = make('div', `checker drag-ghost ${currentBoard.turn === 'player1' ? 'p1' : 'p2'}`);
    document.body.appendChild(ghost);
    boardDrag.ghost = ghost;
  }
  if (boardDrag.ghost) {
    boardDrag.ghost.style.left = `${event.clientX}px`;
    boardDrag.ghost.style.top = `${event.clientY}px`;
  }
}

function onBoardPointerUp(event) {
  if (!boardDrag) return;
  const drag = boardDrag;
  const dragged = Boolean(drag.ghost);
  endBoardDrag();
  if (dragged) {
    const target = boardPointAt(event.clientX, event.clientY);
    if (target != null && target !== drag.from && moveOnBoard(drag.from, target)) return;
    // Dropped elsewhere: keep the checker selected so a tap can finish the move.
    return;
  }
  // A tap on the checker that was already selected deselects it.
  if (drag.wasSelected) setBoardSelection(null);
}

function onBoardPointerCancel() {
  endBoardDrag();
}

function bindBoardPlayEvents() {
  const boardEl = $('#board');
  boardEl.addEventListener('pointerdown', onBoardPointerDown);
  $('#boardUndoBtn').addEventListener('click', (e) => {
    e.preventDefault();
    if (boardPlay?.play?.undo()) boardPlayChanged();
  });
  $('#boardResetBtn').addEventListener('click', (e) => {
    e.preventDefault();
    if (!boardPlay?.play) return;
    boardPlay.play.reset();
    boardPlayChanged();
  });
}

/** Ask the engine to rate a play that is not one of the answer options. */
async function rateCustomMove(option) {
  const response = await authFetch('evaluateMove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: String(currentQuiz.id), move: option.label })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Rating failed (${response.status})`);
  return payload;
}

function quizGroup(quiz) {
  return quiz?.type === 'cube-offer' || quiz?.type === 'cube-response' ? 'cube' : 'checker';
}

function playerColorLabel(player) {
  const isClassic = document.documentElement.getAttribute('data-theme') === 'classic';
  if (player === 'player2') return isClassic ? 'White' : 'Red';
  return isClassic ? 'Black' : 'Blue';
}

function renderQuizPrompt(quiz, board) {
  const questionEl = $('#quizQuestion');
  if (quiz?.type === 'cube-offer') {
    questionEl.textContent = `${playerColorLabel(quiz.context?.player)} is on roll. Double or no double?`;
    $('#meta').textContent = `Cube: ${quiz.context?.cubeValue || 1} • Offered value: ${quiz.context?.offeredCubeValue || 2}`;
  } else if (quiz?.type === 'cube-response') {
    questionEl.textContent = `${playerColorLabel(quiz.context?.player)} was offered the cube. Take or pass?`;
    $('#meta').textContent = `Current cube: ${quiz.context?.cubeValue || 1} • Offered value: ${quiz.context?.offeredCubeValue || 2}`;
  } else {
    questionEl.textContent = 'Choose the best checker play';
    $('#meta').textContent = `To move: ${board.turn === 'player1' ? 'Player 1' : 'Player 2'} • Dice: ${quiz?.context?.dice?.die1 ?? '-'}-${quiz?.context?.dice?.die2 ?? '-'}`;
  }
}

window.refreshQuizLabels = () => {
  if (currentQuiz && currentBoard) renderQuizPrompt(currentQuiz, currentBoard);
};

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildOptions(quiz, randomize = true) {
  if (quiz?.type === 'cube-offer' || quiz?.type === 'cube-response') {
    const cubeOptions = (Array.isArray(quiz.options) ? quiz.options : []).map((option) => ({
      key: option.key || option.action,
      action: option.action,
      label: option.label,
      equity: option.equity,
      correct: option.correct === true,
      played: option.played === true
    }));
    return randomize ? shuffle(cubeOptions) : cubeOptions;
  }
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const candidates = [
    { key: 'best', label: quiz.best?.move, equity: quiz.best?.equity, correct: true },
    { key: 'user', label: quiz.user?.move, equity: quiz.user?.equity, correct: false },
    { key: 'higherSample', label: quiz.higherSample?.move, equity: quiz.higherSample?.equity, correct: false },
    { key: 'lowerSample', label: quiz.lowerSample?.move, equity: quiz.lowerSample?.equity, correct: false }
  ];
  const seen = new Set();
  const out = [];
  for (const opt of candidates) {
    if (!opt.label) continue;
    const n = norm(opt.label);
    if (opt.key === 'best' || opt.key === 'user') {
      // Always keep best and user
      out.push(opt);
      seen.add(n);
    } else {
      if (!seen.has(n)) {
        out.push(opt);
        seen.add(n);
      }
    }
  }
  return randomize ? shuffle(out) : out;
}

function renderOptions(quiz) {
  const optionsForm = $('#options');
  clear(optionsForm);
  selection = null;
  const items = buildOptions(quiz);
  renderedOptions = items;
  optionsForm.classList.toggle('cube-options', quiz?.type === 'cube-offer' || quiz?.type === 'cube-response');
  items.forEach((opt, idx) => {
    const id = `opt-${idx}`;
    const row = make('div', 'option');
    const input = make('input');
    input.type = 'radio';
    input.name = 'move';
    input.value = opt.key;
    input.id = id;
    input.addEventListener('change', () => {
      selection = opt;
      onOptionPicked(opt);
      $('#rateBtn').disabled = false;
    });
    const label = make('label', null, opt.label);
    label.setAttribute('for', id);
    row.appendChild(input);
    row.appendChild(label);
    optionsForm.appendChild(row);
  });
}

function setLoading(state) {
  $('#rateBtn').disabled = true;
  const ignoreBtn = $('#ignoreBtn');
  if (ignoreBtn) ignoreBtn.disabled = state;
  $('#nextBtn').style.display = 'none';
  $('#feedback').classList.remove('visible');
  $('#feedback').innerHTML = '';
  if (state) $('#meta').textContent = 'Loading position…';
  if (state) $('#quizQuestion').textContent = '';
  // Hide external analysis links when loading (solution not visible yet)
  const externalLinkContainer = $('#externalLinkContainer');
  if (externalLinkContainer) {
    externalLinkContainer.style.display = 'none';
  }
  answeredSelection = null;
  if (state) {
    boardPlay = null;
    endBoardDrag();
    updateBoardPlayPanel();
  }
}

function setQuizContentVisible(visible) {
  const boardArea = $('.board-area');
  const actions = $('.quiz-area .actions');
  if (boardArea) boardArea.hidden = !visible;
  if (actions) actions.hidden = !visible;
}

function showNoQuizAvailable() {
  currentQuiz = null;
  currentBoard = null;
  selection = null;
  renderedOptions = [];
  boardPlay = null;
  updateBoardPlayPanel();
  setAdminNotice('');
  setLoading(false);
  setQuizContentVisible(false);
  clear($('#options'));
  $('#options').classList.remove('cube-options');
  const labels = {
    cube: 'cube-decision quizzes',
    checker: 'checker-play quizzes',
    mixed: 'quizzes'
  };
  $('#quizQuestion').textContent = `No ${labels[selectedMode]} available`;
  $('#meta').textContent = selectedPlayer || selectedMatch
    ? 'No quizzes match the selected filters. Try All players or All matches.'
    : 'There are currently no active quizzes in this training mode.';
  const toMoveEl = $('#toMove');
  if (toMoveEl) toMoveEl.textContent = '';
  const matchInfoEl = $('#matchInfo');
  if (matchInfoEl) matchInfoEl.style.display = 'none';
  const ignoreBtn = $('#ignoreBtn');
  if (ignoreBtn) ignoreBtn.disabled = true;
}

function showQuizLoadError() {
  currentQuiz = null;
  currentBoard = null;
  boardPlay = null;
  updateBoardPlayPanel();
  setLoading(false);
  setQuizContentVisible(false);
  clear($('#options'));
  $('#quizQuestion').textContent = 'Unable to load a quiz';
  $('#meta').textContent = 'Please try again.';
}

function setAdminNotice(text) {
  const el = $('#adminNotice');
  if (!el) return;
  const normalized = typeof text === 'string' ? text.trim() : '';
  if (!normalized) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  el.textContent = normalized;
  el.style.display = 'block';
}

async function fetchQuiz() {
  const requestId = ++quizRequestSequence;
  setQuizContentVisible(false);
  setLoading(true);
  const params = new URLSearchParams();
  if (selectedPlayer) params.set('player', selectedPlayer);
  if (selectedMatch) params.set('match', selectedMatch);
  params.set('mode', selectedMode);
  if (selectedMode === 'mixed' && currentQuiz) {
    params.set('afterType', quizGroup(currentQuiz));
  }
  const qs = params.toString();
  const url = qs ? `getQuiz?${qs}` : 'getQuiz';
  try {
    const res = await authFetch(url);
    if (requestId !== quizRequestSequence) return;
    if (res.status === 204) {
      showNoQuizAvailable();
      return;
    }
    if (!res.ok) throw new Error(`Quiz request failed with status ${res.status}`);
    const quiz = await res.json();
    if (requestId !== quizRequestSequence) return;
    await loadQuiz(quiz);
  } catch (error) {
    if (requestId !== quizRequestSequence) return;
    // eslint-disable-next-line no-console
    console.error('[BG] Error fetching quiz:', error);
    showQuizLoadError();
  }
}

async function loadQuiz(quiz) {
  // eslint-disable-next-line no-console
  console.log('[BG] Quiz payload:', quiz);
  currentQuiz = quiz;
  answeredSelection = null;
  setQuizContentVisible(true);
  setAdminNotice(quiz.adminNotice);
  const board = window.ogidCodec.decodeOgid(String(quiz.ogid || ''));
  currentBoard = board;
  logBoardCompact(board);
  if (window.isBoardOrientationLocked) {
    enforceBoardOrientation(board);
  }
  renderBoard(board, quiz?.context?.dice || null);
  const cubeQuiz = quiz?.type === 'cube-offer' || quiz?.type === 'cube-response';
  // Update header: " - blue/black to move" / " - red/white to move" with color
  const toMoveEl = $('#toMove');
  if (toMoveEl) {
    toMoveEl.classList.remove('blue', 'red');
    const isClassic = document.documentElement.getAttribute('data-theme') === 'classic';
    if (cubeQuiz) {
      toMoveEl.textContent = ' - cube decision';
    } else if (board.turn === 'player1') {
      toMoveEl.textContent = isClassic ? ' - black to move' : ' - blue to move';
      toMoveEl.classList.add('blue');
    } else {
      toMoveEl.textContent = isClassic ? ' - white to move' : ' - red to move';
      toMoveEl.classList.add('red');
    }
  }
  renderQuizPrompt(quiz, board);

  // Update match info display
  const matchInfoEl = $('#matchInfo');
  if (matchInfoEl && board.matchLength && Number.isFinite(board.matchLength)) {
    const score1 = board.score?.player1 || 0;
    const score2 = board.score?.player2 || 0;
    const variantPrefix = quiz.variant === 'nackgammon' ? 'Nack ' : '';
    matchInfoEl.innerHTML = `${variantPrefix}Match to <strong>${board.matchLength}</strong> points, <span class="score-blue">${score1}</span> : <span class="score-red">${score2}</span>`;
    matchInfoEl.style.display = '';
  } else {
    matchInfoEl.style.display = 'none';
  }

  renderOptions(quiz);
  $('#rateBtn').disabled = true;
  startBoardPlay(quiz, board);

  // Hide external analysis links when loading a new quiz (solution not visible yet)
  const externalLinkContainer = $('#externalLinkContainer');
  if (externalLinkContainer) {
    externalLinkContainer.style.display = 'none';
  }

  // Update debug quiz ID field if debug mode is enabled
  updateQuizIdField();

  setLoading(false);
}

async function fetchQuizById(id, useDebugEndpoint = false) {
  if (!id || !id.trim()) {
    $('#meta').textContent = 'Please enter a quiz ID.';
    return;
  }
  setLoading(true);
  try {
    // Use debug endpoint to search across all users when debug mode is enabled
    const endpoint = useDebugEndpoint
      ? `getQuizDebug/${encodeURIComponent(id.trim())}`
      : `getQuiz/${encodeURIComponent(id.trim())}`;
    const res = await authFetch(endpoint);
    if (res.status === 404) {
      $('#meta').textContent = 'Quiz not found.';
      setLoading(false);
      return;
    }
    if (!res.ok) {
      $('#meta').textContent = 'Error loading quiz.';
      setLoading(false);
      return;
    }
    const quiz = await res.json();
    await loadQuiz(quiz);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[BG] Error fetching quiz by ID:', error);
    $('#meta').textContent = 'Error loading quiz.';
    setLoading(false);
  }
}

function updateQuizIdField() {
  const input = $('#quizIdInput');
  if (input && currentQuiz && currentQuiz.id) {
    input.value = currentQuiz.id;
  }
}

function toggleDebugMode(enabled) {
  const debugControls = $('#debugControls');
  if (debugControls) {
    debugControls.style.display = enabled ? 'flex' : 'none';
  }
  if (enabled) {
    updateQuizIdField();
  }
}

function showFeedback(quiz, evaluation, optionsList, selectedKey) {
  const fb = $('#feedback');
  fb.innerHTML = '';
  const resultClass = evaluation.isSolved ? 'correct' : 'incorrect';
  const result = make('div', `result ${resultClass}`, evaluation.message);
  fb.appendChild(result);
  const moves = make('div', 'moves');
  const bestOpt = optionsList.find((o) => o.correct);
  const bestEquity = bestOpt?.equity;
  const sorted = optionsList.slice().sort((a, b) => {
    if (a.equity == null && b.equity == null) return 0;
    if (a.equity == null) return 1;
    if (b.equity == null) return -1;
    return b.equity - a.equity;
  });
  sorted.forEach((opt) => {
    const classes = 'move' + (opt.key === selectedKey ? ' selected' : '');
    const row = make('div', classes);
    const left = make('div', null, opt.label);
    const right = make('div');
    const badge = make('span', 'badge' + (opt.correct ? ' good' : ''));
    badge.textContent = opt.correct ? 'Best' : (opt.played || opt.key === 'user' ? 'played' : (opt.custom ? 'yours' : 'Alt'));
    let eqText = '';
    if (opt.equity != null) {
      if (opt.correct) {
        // Best move: show actual equity
        eqText = (opt.equity >= 0 ? '+' : '') + opt.equity.toFixed(3);
      } else if (bestEquity != null) {
        // Other moves: show delta in parentheses (always negative or zero)
        const delta = opt.equity - bestEquity;
        eqText = '(' + (delta >= 0 ? '+' : '') + delta.toFixed(3) + ')';
      } else {
        // Fallback if no best equity available
        eqText = (opt.equity >= 0 ? '+' : '') + opt.equity.toFixed(3);
      }
    }
    const eq = make('span', null, eqText);
    right.appendChild(eq);
    right.appendChild(document.createTextNode(' '));
    right.appendChild(badge);
    row.appendChild(left);
    row.appendChild(right);
    moves.appendChild(row);
  });
  fb.appendChild(moves);
  fb.classList.add('visible');

  // Show the external review tools after the answer has been revealed.
  const externalLinkContainer = $('#externalLinkContainer');
  const dgLink = $('#dgLink');
  const deepAnalysisBtn = $('#deepAnalysisBtn');
  let hasExternalLink = false;
  if (dgLink && quiz.dgGameId && quiz.dgMoveNumber) {
    const dgUrl = `http://dailygammon.com/bg/game/${quiz.dgGameId}/0/${quiz.dgMoveNumber}`;
    dgLink.href = dgUrl;
    dgLink.style.display = 'inline-flex';
    hasExternalLink = true;
  } else if (dgLink) {
    dgLink.style.display = 'none';
  }
  if (deepAnalysisBtn && quiz.id) {
    deepAnalysisBtn.style.display = 'inline-flex';
    hasExternalLink = true;
    updateDeepAnalysisControl(quiz);
  } else if (deepAnalysisBtn) {
    deepAnalysisBtn.style.display = 'none';
  }
  if (externalLinkContainer) {
    externalLinkContainer.style.display = hasExternalLink ? 'flex' : 'none';
  }
}

function deepAnalysisDisplay(quiz) {
  const deep = quiz?.deepAnalysis;
  if (deep?.status !== 'complete') return null;
  return Number.isInteger(deep.plies) ? `${deep.plies}-ply analysis complete` : 'Deep analysis complete';
}

function updateDeepAnalysisControl(quiz, state = 'ready', message = '') {
  const button = $('#deepAnalysisBtn');
  const status = $('#deepAnalysisStatus');
  if (!button) return;
  const completed = deepAnalysisDisplay(quiz);
  if (completed) {
    button.disabled = true;
    button.textContent = 'Deep Analysis complete';
    button.title = completed;
    if (status) status.textContent = completed;
    return;
  }
  button.disabled = state === 'working' || state === 'saving';
  button.textContent = state === 'working' ? 'Analyzing deeply…' : 'Deep Analysis';
  button.title = 'Re-analyze this quiz with a deeper engine search.';
  if (status) status.textContent = message;
}

function sameAnsweredOption(option, answered) {
  if (!option || !answered) return false;
  if (answered.action) return option.action === answered.action;
  const normalize = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return normalize(option.label) === normalize(answered.label);
}

async function runDeepAnalysis() {
  if (!currentQuiz?.id || !answeredSelection) return;
  const quizId = String(currentQuiz.id);
  const nextButton = $('#nextBtn');
  updateDeepAnalysisControl(currentQuiz, 'working', 'This can take a while.');
  if (nextButton) nextButton.disabled = true;
  try {
    const response = await authFetch('deepAnalyzeQuiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: quizId })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Deep analysis failed (${response.status})`);
    if (String(currentQuiz?.id || '') !== quizId) return;

    currentQuiz = payload;
    const options = buildOptions(payload, false);
    let selected = options.find((option) => sameAnsweredOption(option, answeredSelection));
    if (!selected && answeredSelection.custom) {
      // Rate the play made on the board again at the deep analysis depth.
      const rating = await rateCustomMove(answeredSelection);
      if (String(currentQuiz?.id || '') !== quizId) return;
      selected = { ...answeredSelection, equity: rating.equity, correct: rating.isBest === true };
      options.push(selected);
    }
    if (!selected) {
      selected = { ...answeredSelection, key: 'answered', equity: null, correct: false };
      options.push(selected);
    }
    const best = options.find((option) => option.correct && !option.custom);
    const evaluation = window.quizEvaluation.evaluateSelection(selected, best);
    showFeedback(payload, evaluation, options, selected.key);
  } catch (error) {
    if (String(currentQuiz?.id || '') === quizId) {
      updateDeepAnalysisControl(currentQuiz, 'ready', error.message || 'Deep analysis failed.');
    }
  } finally {
    if (nextButton) nextButton.disabled = false;
  }
}

function toggleBoardOrientation() {
  window.isBoardFlipped = !window.isBoardFlipped;
  try {
    window.localStorage.setItem('bgBoardFlipped', window.isBoardFlipped ? '1' : '0');
  } catch {
    // ignore storage errors
  }
  if (window.isBoardOrientationLocked) {
    setOrientationLock(false);
  }
  redrawBoard();
}

function toggleBoardMirror() {
  window.isBoardMirrored = !window.isBoardMirrored;
  try {
    window.localStorage.setItem('bgBoardMirrored', window.isBoardMirrored ? '1' : '0');
  } catch {
    // ignore storage errors
  }
  redrawBoard();
}

function setOrientationLock(enabled) {
  window.isBoardOrientationLocked = enabled;
  try {
    window.localStorage.setItem('bgBoardOrientationLocked', enabled ? '1' : '0');
  } catch {
    // ignore storage errors
  }
  const btn = $('#lockBoardBtn');
  if (btn) {
    btn.setAttribute('aria-pressed', String(enabled));
    btn.textContent = enabled ? '🔒 Lock' : '🔓 Lock';
  }
}

function toggleOrientationLock() {
  const newState = !window.isBoardOrientationLocked;
  setOrientationLock(newState);
  if (newState && currentBoard) {
    enforceBoardOrientation(currentBoard);
    redrawBoard();
  }
}

function enforceBoardOrientation(board) {
  // player1 moves from high points (24) toward low (1)
  // Default (unflipped) board: top row = 13-24, bottom row = 12-1
  // So for player1: home (1-6) is already at bottom → no flip needed
  // For player2: home (their 1-6 = absolute 24-19) is at top → flip needed
  const needsFlip = board.turn === 'player2';
  window.isBoardFlipped = needsFlip;
  try {
    window.localStorage.setItem('bgBoardFlipped', needsFlip ? '1' : '0');
  } catch {
    // ignore storage errors
  }
}

async function submitAnswer() {
  if (!currentQuiz || !selection) return;
  const quizId = String(currentQuiz.id || '');
  const custom = renderedOptions.find((option) => option.key === CUSTOM_OPTION_KEY);
  if (selection.key === CUSTOM_OPTION_KEY && custom && !Number.isFinite(custom.equity)) {
    // A play made on the board that is not an answer option: the engine rates it.
    const status = $('#boardPlayStatus');
    $('#rateBtn').disabled = true;
    if (boardPlay) boardPlay.active = false;
    decorateBoard();
    if (status) status.textContent = `Rating ${custom.label}…`;
    try {
      const rating = await rateCustomMove(custom);
      if (String(currentQuiz?.id || '') !== quizId) return;
      custom.equity = rating.equity;
      custom.correct = rating.isBest === true;
    } catch (error) {
      if (String(currentQuiz?.id || '') !== quizId) return;
      if (boardPlay) boardPlay.active = true;
      decorateBoard();
      updateBoardPlayPanel();
      if (status) status.textContent = `Could not rate your move: ${error.message}`;
      $('#rateBtn').disabled = false;
      return;
    }
  }
  stopBoardPlay();
  // Keep the order and option mapping from the already-rendered DOM.
  const domOptions = $$('#options .option');
  const displayed = domOptions.map((row) => {
    const input = row.querySelector('input[type="radio"]');
    const key = input.value;
    return renderedOptions.find((option) => option.key === key) || { key };
  });

  const selectedOption = displayed.find((option) => option.key === selection.key);
  const bestOption = displayed.find((option) => option.correct && !option.custom);
  const evaluation = window.quizEvaluation.evaluateSelection(selectedOption, bestOption);
  answeredSelection = selectedOption ? { ...selectedOption } : null;
  // Disable inputs
  $$('#options input[type="radio"]').forEach((i) => { i.disabled = true; });
  $('#rateBtn').disabled = true;
  const ignoreBtn = $('#ignoreBtn');
  if (ignoreBtn) ignoreBtn.disabled = true;

  // Show feedback
  showFeedback(currentQuiz, evaluation, displayed, selection?.key);
  updateDeepAnalysisControl(currentQuiz, 'saving', 'Saving answer…');
  $('#nextBtn').style.display = 'inline-block';

  // Update backend
  try {
    const response = await authFetch('updateQuiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: quizId, wasCorrect: evaluation.isSolved })
    });
    const updated = response.ok ? await response.json() : null;
    if (updated && String(currentQuiz?.id || '') === quizId) currentQuiz = updated;
  } catch {
    // ignore send errors
  } finally {
    if (String(currentQuiz?.id || '') === quizId) updateDeepAnalysisControl(currentQuiz);
  }
}

async function loadPlayers() {
  try {
    const res = await authFetch('getPlayers');
    if (!res.ok) return;
    const players = await res.json();
    const select = $('#playerFilter');
    if (!select) return;

    // Clear existing options except "All players"
    while (select.options.length > 1) {
      select.remove(1);
    }

    // Add player options
    players.forEach(player => {
      const option = document.createElement('option');
      option.value = player;
      option.textContent = player;
      select.appendChild(option);
    });

    // Set default to current player if available
    try {
      const creds = await window.dgAuth.whenReady();
      const currentUsername = creds?.username;
      if (currentUsername && players.includes(currentUsername)) {
        select.value = currentUsername;
        selectedPlayer = currentUsername;
      }
    } catch (error) {
      // If we can't get current username, just leave it as "All players"
      // eslint-disable-next-line no-console
      console.warn('[BG] Could not get current username for default selection:', error);
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[BG] Error loading players:', error);
  }
}

async function loadMatches() {
  try {
    const res = await authFetch('getMatches');
    if (!res.ok) return;
    const matches = await res.json();
    const select = $('#matchFilter');
    if (!select) return;

    // Clear existing options except "All matches"
    while (select.options.length > 1) {
      select.remove(1);
    }

    // Add match options
    matches.forEach(m => {
      const option = document.createElement('option');
      option.value = m.matchId;
      const lenStr = m.matchLength ? `${m.matchLength}pt` : '?pt';
      const oppStr = m.opponent || '?';
      option.textContent = `Match ${m.matchId} (${lenStr} vs ${oppStr})`;
      select.appendChild(option);
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[BG] Error loading matches:', error);
  }
}

async function ignoreQuiz() {
  if (!currentQuiz?.id) return;
  const ignoreBtn = $('#ignoreBtn');
  if (ignoreBtn) ignoreBtn.disabled = true;
  try {
    await authFetch('updateQuiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: String(currentQuiz.id), ignored: true })
    });
    await fetchQuiz();
  } catch {
    // ignore send errors
    if (ignoreBtn) ignoreBtn.disabled = false;
  }
}

function bindEvents() {
  bindBoardPlayEvents();
  $('#rateBtn').addEventListener('click', (e) => {
    e.preventDefault();
    submitAnswer();
  });
  const ignoreBtn = $('#ignoreBtn');
  if (ignoreBtn) {
    ignoreBtn.addEventListener('click', (e) => {
      e.preventDefault();
      ignoreQuiz();
    });
  }
  $('#nextBtn').addEventListener('click', (e) => {
    e.preventDefault();
    fetchQuiz();
  });

  const deepAnalysisBtn = $('#deepAnalysisBtn');
  if (deepAnalysisBtn) {
    deepAnalysisBtn.addEventListener('click', (e) => {
      e.preventDefault();
      runDeepAnalysis();
    });
  }

  // Player filter dropdown
  const playerFilter = $('#playerFilter');
  if (playerFilter) {
    playerFilter.addEventListener('change', (e) => {
      selectedPlayer = e.target.value || '';
      fetchQuiz(); // Reload quiz with new filter
    });
  }

  // Match filter dropdown
  const matchFilter = $('#matchFilter');
  if (matchFilter) {
    matchFilter.addEventListener('change', (e) => {
      selectedMatch = e.target.value || '';
      fetchQuiz(); // Reload quiz with new filter
    });
  }

  const trainingMode = $('#trainingMode');
  if (trainingMode) {
    trainingMode.addEventListener('change', (e) => {
      selectedMode = e.target.value || 'mixed';
      try {
        window.localStorage.setItem('bgTrainingMode', selectedMode);
      } catch {
        // ignore storage errors
      }
      currentQuiz = null;
      fetchQuiz();
    });
  }

  // Debug toggle
  const debugToggle = $('#debugToggle');
  if (debugToggle) {
    debugToggle.addEventListener('change', (e) => {
      toggleDebugMode(e.target.checked);
    });
  }

  // Quiz ID input - handle Enter key
  const quizIdInput = $('#quizIdInput');
  if (quizIdInput) {
    quizIdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const id = quizIdInput.value.trim();
        if (id) {
          // When debug mode is enabled, use the debug endpoint to search across all users
          const debugToggle = $('#debugToggle');
          const useDebugEndpoint = debugToggle && debugToggle.checked;
          fetchQuizById(id, useDebugEndpoint);
        }
      }
    });
  }

  // Board orientation toggle
  const flipBtn = $('#flipBoardBtn');
  if (flipBtn) {
    flipBtn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleBoardOrientation();
    });
  }

  // Board mirror toggle
  const mirrorBtn = $('#mirrorBoardBtn');
  if (mirrorBtn) {
    mirrorBtn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleBoardMirror();
    });
  }

  // Board orientation lock toggle
  const lockBtn = $('#lockBoardBtn');
  if (lockBtn) {
    lockBtn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleOrientationLock();
    });
  }
}

async function init() {
  await window.dgAuth.whenReady();
  // Load stored board orientation preferences
  try {
    const stored = window.localStorage.getItem('bgBoardFlipped');
    if (stored === '1') {
      window.isBoardFlipped = true;
    }
  } catch {
    window.isBoardFlipped = false;
  }
  try {
    const storedMirror = window.localStorage.getItem('bgBoardMirrored');
    if (storedMirror === '1') {
      window.isBoardMirrored = true;
    }
  } catch {
    window.isBoardMirrored = false;
  }
  try {
    const storedLock = window.localStorage.getItem('bgBoardOrientationLocked');
    if (storedLock === '1') {
      window.isBoardOrientationLocked = true;
    }
  } catch {
    window.isBoardOrientationLocked = false;
  }
  try {
    const storedMode = window.localStorage.getItem('bgTrainingMode');
    if (['mixed', 'checker', 'cube'].includes(storedMode)) selectedMode = storedMode;
  } catch {
    selectedMode = 'mixed';
  }
  const trainingMode = $('#trainingMode');
  if (trainingMode) trainingMode.value = selectedMode;
  // Sync lock button visual state with persisted value
  const lockBtnInit = $('#lockBoardBtn');
  if (lockBtnInit) {
    lockBtnInit.setAttribute('aria-pressed', String(window.isBoardOrientationLocked));
    lockBtnInit.textContent = window.isBoardOrientationLocked ? '🔒 Lock' : '🔓 Lock';
  }

  bindEvents();
  await loadPlayers();
  await loadMatches();

  // Check if there's an ID parameter in the URL
  const urlParams = new URLSearchParams(window.location.search);
  const quizId = urlParams.get('id');

  if (quizId) {
    await fetchQuizById(quizId);
  } else {
    fetchQuiz();
  }
}

document.addEventListener('DOMContentLoaded', init);
