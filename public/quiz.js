/* global fetch */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const authFetch = (...args) => window.dgAuth.authFetch(...args);

// --- GNU ID decoding (browser) ---
function base64ToBytes(text) {
  const padLen = (4 - (text.length % 4)) % 4;
  const padded = text + '='.repeat(padLen);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToBitsLe(bytes) {
  const bits = [];
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i];
    for (let b = 0; b < 8; b++) bits.push((v >> b) & 1);
  }
  return bits;
}
function decodePositionInto(board, posId) {
  const bytes = base64ToBytes(posId);
  if (bytes.length !== 10) throw new Error('Invalid Position ID payload');
  const bits = bytesToBitsLe(bytes);
  const readSide = (bitsArr) => {
    const arr = new Array(26).fill(0);
    let ptr = 0;
    for (let i = 1; i <= 24; i++) {
      let count = 0;
      while (ptr < bitsArr.length && bitsArr[ptr] === 1) { count++; ptr++; }
      if (ptr < bitsArr.length) ptr++;
      arr[i] = count;
    }
    let bar = 0;
    while (ptr < bitsArr.length && bitsArr[ptr] === 1) { bar++; ptr++; }
    if (ptr < bitsArr.length) ptr++;
    arr[25] = bar;
    return { arr, ptr };
  };
  const first = readSide(bits);
  const secondBits = bits.slice(first.ptr);
  const second = readSide(secondBits);
  // Calculate borne-off checkers (index 0) by counting all checkers on board and bar
  // and subtracting from 15 (total checkers per player)
  const countCheckers = (arr) => {
    let total = 0;
    for (let i = 1; i <= 25; i++) {
      total += arr[i] || 0;
    }
    return total;
  };
  const firstTotal = countCheckers(first.arr);
  const secondTotal = countCheckers(second.arr);
  first.arr[0] = Math.max(0, 15 - firstTotal);
  second.arr[0] = Math.max(0, 15 - secondTotal);
  const onRoll = board.turn === 'player2' ? 'player2' : 'player1';
  const opponent = onRoll === 'player1' ? 'player2' : 'player1';
  board.points[opponent] = first.arr;
  board.points[onRoll] = second.arr;
}
function extractTurnFromMatchId(matchId) {
  // Extract just the turn (rollerBit) from match ID to set board.turn before decoding position
  if (!matchId || matchId.length !== 12) return 'player1';
  try {
    const bytes = base64ToBytes(matchId);
    if (bytes.length !== 9) return 'player1';
    const bits = bytesToBitsLe(bytes);
    let ptr = 0;
    const readBits = (w) => {
      let v = 0;
      for (let i = 0; i < w; i++) v |= (bits[ptr + i] & 1) << i;
      ptr += w;
      return v >>> 0;
    };
    readBits(4); // cubeExp
    readBits(2); // cubeOwnerBits
    const rollerBit = readBits(1); // This is what we need
    return rollerBit === 1 ? 'player2' : 'player1';
  } catch {
    return 'player1';
  }
}

function decodeMatchInto(board, matchId) {
  if (!matchId || matchId.length !== 12) return;
  const bytes = base64ToBytes(matchId);
  if (bytes.length !== 9) return;
  const bits = bytesToBitsLe(bytes);
  let ptr = 0;
  const readBits = (w) => {
    let v = 0;
    for (let i = 0; i < w; i++) v |= (bits[ptr + i] & 1) << i;
    ptr += w;
    return v >>> 0;
  };
  const cubeExp = readBits(4);
  const cubeOwnerBits = readBits(2);
  const rollerBit = readBits(1);
  readBits(1); // crawford
  readBits(3); // game state
  readBits(1); // decision owner
  readBits(1); // double
  readBits(2); // resignation
  const d1 = readBits(3);
  const d2 = readBits(3);
  const mlen = readBits(15);
  const s1 = readBits(15);
  const s2 = readBits(15);
  board.cube = 1 << cubeExp;
  board.cubeOwner = cubeOwnerBits === 0 ? 'player1' : (cubeOwnerBits === 1 ? 'player2' : null);
  board.turn = rollerBit === 1 ? 'player2' : 'player1';
  board.dice = (d1 || d2) ? { die1: d1, die2: d2 } : null;
  board.matchLength = mlen || null;
  board.score = { player1: s1, player2: s2 };
}
function decodeGnuId(gnuId) {
  if (typeof gnuId !== 'string' || !gnuId.includes(':')) throw new Error('Invalid GNU ID');
  const [posId, matchId] = gnuId.split(':', 2);
  const board = {
    points: { player1: new Array(26).fill(0), player2: new Array(26).fill(0) },
    turn: 'player1',
    cube: 1,
    cubeOwner: null,
    score: { player1: 0, player2: 0 },
    matchLength: null,
    dice: null
  };
  // CRITICAL: Extract turn from match ID BEFORE decoding position
  // Position ID encoding stores: opponent first, then player on roll
  // So we need the correct turn to assign points correctly
  board.turn = extractTurnFromMatchId(matchId);
  decodePositionInto(board, posId);
  decodeMatchInto(board, matchId);
  return board;
}

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
  // Points are from the player's perspective (1 = closest to bearing off)
  let pipCount = 0;
  for (let i = 1; i <= 24; i++) {
    pipCount += i * (playerPoints[i] || 0);
  }
  return pipCount;
}

function renderBoard(board, contextDice, quiz = null) {
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
  const hasEnhancedCube = Number(quiz?.cubeValue) > 0;
  const effectiveCubeValue = hasEnhancedCube ? Number(quiz.cubeValue) : Number(board.cube || 1);
  cube.textContent = String(effectiveCubeValue > 0 ? effectiveCubeValue : 1);
  cube.classList.remove('owner-player1', 'owner-player2');
  cube.classList.remove('cube-pos-top', 'cube-pos-bottom', 'cube-pos-center');
  const effectiveCubeOwner = hasEnhancedCube ? quiz?.cubeOwner : board.cubeOwner;
  if (effectiveCubeOwner === 'player1') cube.classList.add('owner-player1');
  if (effectiveCubeOwner === 'player2') cube.classList.add('owner-player2');
  if (hasEnhancedCube) {
    if (effectiveCubeOwner === 'player2') {
      cube.classList.add('cube-pos-top');
    } else if (effectiveCubeOwner === 'player1') {
      cube.classList.add('cube-pos-bottom');
    } else {
      cube.classList.add('cube-pos-center');
    }
  }

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
window.isBoardFlipped = false;
window.isBoardMirrored = false;
window.isBoardOrientationLocked = false;
let currentBoard = null;

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildOptions(quiz) {
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
  return shuffle(out);
}

function renderOptions(quiz) {
  const optionsForm = $('#options');
  clear(optionsForm);
  selection = null;
  const items = buildOptions(quiz);
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
  $('#meta').textContent = state ? 'Loading position…' : '';
  // Hide DailyGammon link when loading (solution not visible yet)
  const dgContainer = $('#dgLinkContainer');
  if (dgContainer) {
    dgContainer.style.display = 'none';
  }
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
  setLoading(true);
  const params = new URLSearchParams();
  if (selectedPlayer) params.set('player', selectedPlayer);
  if (selectedMatch) params.set('match', selectedMatch);
  const qs = params.toString();
  const url = qs ? `getQuiz?${qs}` : 'getQuiz';
  const res = await authFetch(url);
  if (res.status === 204) {
    setAdminNotice('');
    $('#meta').textContent = 'No more quizzes available.';
    setLoading(false);
    const ignoreBtn = $('#ignoreBtn');
    if (ignoreBtn) ignoreBtn.disabled = true;
    return;
  }
  const quiz = await res.json();
  await loadQuiz(quiz);
}

async function loadQuiz(quiz) {
  // eslint-disable-next-line no-console
  console.log('[BG] Quiz payload:', quiz);
  currentQuiz = quiz;
  setAdminNotice(quiz.adminNotice);
  const board = decodeGnuId(String(quiz.gnuId || ''));
  currentBoard = board;
  logBoardCompact(board);
  if (window.isBoardOrientationLocked) {
    enforceBoardOrientation(board);
  }
  renderBoard(board, quiz?.context?.dice || null, quiz);
  // Update header: " - blue/black to move" / " - red/white to move" with color
  const toMoveEl = $('#toMove');
  if (toMoveEl) {
    toMoveEl.classList.remove('blue', 'red');
    const isClassic = document.documentElement.getAttribute('data-theme') === 'classic';
    if (board.turn === 'player1') {
      toMoveEl.textContent = isClassic ? ' - black to move' : ' - blue to move';
      toMoveEl.classList.add('blue');
    } else {
      toMoveEl.textContent = isClassic ? ' - white to move' : ' - red to move';
      toMoveEl.classList.add('red');
    }
  }
  $('#meta').textContent = `To move: ${board.turn === 'player1' ? 'Player 1' : 'Player 2'} • Dice: ${quiz?.context?.dice?.die1 ?? '-'}-${quiz?.context?.dice?.die2 ?? '-'}`;

  // Update match info display
  const matchInfoEl = $('#matchInfo');
  if (matchInfoEl && board.matchLength && Number.isFinite(board.matchLength)) {
    const score1 = board.score?.player1 || 0;
    const score2 = board.score?.player2 || 0;
    matchInfoEl.innerHTML = `Match to <strong>${board.matchLength}</strong> points, <span class="score-blue">${score1}</span> : <span class="score-red">${score2}</span>`;
    matchInfoEl.style.display = '';
  } else {
    matchInfoEl.style.display = 'none';
  }

  renderOptions(quiz);
  $('#rateBtn').disabled = true;

  // Hide DailyGammon link when loading new quiz (solution not visible yet)
  const dgContainer = $('#dgLinkContainer');
  if (dgContainer) {
    dgContainer.style.display = 'none';
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

function showFeedback(quiz, isCorrect, optionsList, selectedKey) {
  const fb = $('#feedback');
  fb.innerHTML = '';
  const result = make('div', 'result ' + (isCorrect ? 'correct' : 'incorrect'), isCorrect ? 'Correct!' : 'Not quite.');
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
    badge.textContent = opt.correct ? 'Best' : (opt.key === 'user' ? 'you' : 'Alt');
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

  // Show DailyGammon link if available
  const dgContainer = $('#dgLinkContainer');
  const dgLink = $('#dgLink');
  if (dgContainer && dgLink && quiz.dgGameId && quiz.dgMoveNumber) {
    const dgUrl = `http://dailygammon.com/bg/game/${quiz.dgGameId}/0/${quiz.dgMoveNumber}`;
    dgLink.href = dgUrl;
    dgContainer.style.display = 'block';
  } else if (dgContainer) {
    dgContainer.style.display = 'none';
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
  if (currentBoard && currentQuiz) {
    renderBoard(currentBoard, currentQuiz?.context?.dice || null);
  }
}

function toggleBoardMirror() {
  window.isBoardMirrored = !window.isBoardMirrored;
  try {
    window.localStorage.setItem('bgBoardMirrored', window.isBoardMirrored ? '1' : '0');
  } catch {
    // ignore storage errors
  }
  if (currentBoard && currentQuiz) {
    renderBoard(currentBoard, currentQuiz?.context?.dice || null);
  }
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
    renderBoard(currentBoard, currentQuiz?.context?.dice || null);
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
  const optionsShown = buildOptions(currentQuiz); // Need the same mapping used in renderOptions
  // But renderOptions shuffled once; keep that order by reading from DOM:
  const domOptions = $$('#options .option');
  const displayed = domOptions.map((row, idx) => {
    const input = row.querySelector('input[type="radio"]');
    const key = input.value;
    const source = ['best', 'user', 'higherSample', 'lowerSample'].includes(key) ? currentQuiz[key] : null;
    return {
      key,
      label: source?.move,
      equity: source?.equity,
      correct: key === 'best'
    };
  });

  const isCorrect = selection && selection.key === 'best';
  // Disable inputs
  $$('#options input[type="radio"]').forEach((i) => { i.disabled = true; });
  $('#rateBtn').disabled = true;
  const ignoreBtn = $('#ignoreBtn');
  if (ignoreBtn) ignoreBtn.disabled = true;

  // Show feedback
  showFeedback(currentQuiz, isCorrect, displayed, selection?.key);
  $('#nextBtn').style.display = 'inline-block';

  // Update backend
  try {
    await authFetch('updateQuiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: String(currentQuiz.id || ''), wasCorrect: !!isCorrect })
    });
  } catch {
    // ignore send errors
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

