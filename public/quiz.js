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

function renderBoard(board, contextDice) {
  const top = $('#points-top');
  const bottom = $('#points-bottom');
  const bearP1 = $('#bearoff-p1');
  const bearP2 = $('#bearoff-p2');
  const pipCountP1 = $('#pipcount-p1');
  const pipCountP2 = $('#pipcount-p2');
  const cube = $('#cube');
  const dice = $('#dice');
  const pointNumbersTop = $('#point-numbers-top');
  const pointNumbersBottom = $('#point-numbers-bottom');

  clear(top); clear(bottom); clear(dice);
  clear(pointNumbersTop); clear(pointNumbersBottom);

  // Build 13 columns per row (with vertical bar at col 6)
  let vbarTopEl = null;
  let vbarBottomEl = null;
  for (let col = 0; col < 13; col++) {
    // Top row
    if (col === 6) {
      const vbarTop = make('div', 'vbar');
      vbarTop.id = 'bar-top';
      vbarTopEl = vbarTop;
      top.appendChild(vbarTop);
    } else {
      const pTop = make('div', 'point' + ((col % 2 === 0) ? ' striped' : ''));
      const absTop = pointIndexForTop(col);
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
      const pBot = make('div', 'point' + ((col % 2 === 0) ? '' : ' striped'));
      const absBot = pointIndexForBottom(col);
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
      const absTop = pointIndexForTop(col);
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
      const absBot = pointIndexForBottom(col);
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
  $('#nextBtn').style.display = 'none';
  $('#feedback').classList.remove('visible');
  $('#feedback').innerHTML = '';
  $('#meta').textContent = state ? 'Loading position…' : '';
}

async function fetchQuiz() {
  setLoading(true);
  const url = selectedPlayer ? `/getQuiz?player=${encodeURIComponent(selectedPlayer)}` : '/getQuiz';
  const res = await authFetch(url);
  if (res.status === 204) {
    $('#meta').textContent = 'No more quizzes available.';
    setLoading(false);
    return;
  }
  const quiz = await res.json();
  await loadQuiz(quiz);
}

async function loadQuiz(quiz) {
  // eslint-disable-next-line no-console
  console.log('[BG] Quiz payload:', quiz);
  currentQuiz = quiz;
  const board = decodeGnuId(String(quiz.gnuId || ''));
  logBoardCompact(board);
  renderBoard(board, quiz?.context?.dice || null);
  // Update header: " - blue to move" / " - red to move" with color
  const toMoveEl = $('#toMove');
  if (toMoveEl) {
    toMoveEl.classList.remove('blue', 'red');
    if (board.turn === 'player1') {
      toMoveEl.textContent = ' - blue to move';
      toMoveEl.classList.add('blue');
    } else {
      toMoveEl.textContent = ' - red to move';
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
  
  // Update debug quiz ID field if debug mode is enabled
  updateQuizIdField();
  
  setLoading(false);
}

async function fetchQuizById(id) {
  if (!id || !id.trim()) {
    $('#meta').textContent = 'Please enter a quiz ID.';
    return;
  }
  setLoading(true);
  try {
    const res = await authFetch(`/getQuiz/${encodeURIComponent(id.trim())}`);
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

function showFeedback(quiz, isCorrect, optionsList) {
  const fb = $('#feedback');
  fb.innerHTML = '';
  const result = make('div', 'result', isCorrect ? 'Correct!' : 'Not quite.');
  result.style.color = isCorrect ? '#7cd67c' : '#ff8c8c';
  fb.appendChild(result);
  const moves = make('div', 'moves');
  // Preserve the displayed randomized order, but annotate
  optionsList.forEach((opt) => {
    const row = make('div', 'move');
    const left = make('div', null, opt.label);
    const right = make('div');
    const badge = make('span', 'badge' + (opt.correct ? ' good' : ''));
    badge.textContent = opt.correct ? 'Best' : (opt.key === 'user' ? 'you' : 'Alt');
    const eq = make('span', null, (opt.equity != null ? (opt.equity >= 0 ? '+' : '') + opt.equity.toFixed(3) : ''));
    right.appendChild(eq);
    right.appendChild(document.createTextNode(' '));
    right.appendChild(badge);
    row.appendChild(left);
    row.appendChild(right);
    moves.appendChild(row);
  });
  fb.appendChild(moves);
  fb.classList.add('visible');
}

async function submitAnswer() {
  if (!currentQuiz || !selection) return;
  const optionsShown = buildOptions(currentQuiz); // Need the same mapping used in renderOptions
  // But renderOptions shuffled once; keep that order by reading from DOM:
  const domOptions = $$('#options .option');
  const displayed = domOptions.map((row, idx) => {
    const input = row.querySelector('input[type="radio"]');
    const key = input.value;
    const source = ['best','user','higherSample','lowerSample'].includes(key) ? currentQuiz[key] : null;
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

  // Show feedback
  showFeedback(currentQuiz, isCorrect, displayed);
  $('#nextBtn').style.display = 'inline-block';

  // Update backend
  try {
    await authFetch('/updateQuiz', {
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
    const res = await authFetch('/getPlayers');
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
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[BG] Error loading players:', error);
  }
}

function bindEvents() {
  $('#rateBtn').addEventListener('click', (e) => {
    e.preventDefault();
    submitAnswer();
  });
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
          fetchQuizById(id);
        }
      }
    });
  }
}

async function init() {
  await window.dgAuth.whenReady();
  bindEvents();
  await loadPlayers();
  
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


