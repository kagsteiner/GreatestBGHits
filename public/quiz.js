/* global fetch */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

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
  const onRoll = board.turn === 'player2' ? 'player2' : 'player1';
  const opponent = onRoll === 'player1' ? 'player2' : 'player1';
  board.points[opponent] = first.arr;
  board.points[onRoll] = second.arr;
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
  // col 0..11 -> points 13..24
  return 13 + col;
}
function pointIndexForBottom(col) {
  // col 0..11 -> points 12..1
  return 12 - col;
}
function p1IndexFromAbsolute(absPoint) {
  return absPoint;
}
function p2IndexFromAbsolute(absPoint) {
  return 25 - absPoint;
}

function renderBoard(board, contextDice) {
  const top = $('#points-top');
  const bottom = $('#points-bottom');
  const barTop = $('#bar-top');
  const barBottom = $('#bar-bottom');
  const bearP1 = $('#bearoff-p1');
  const bearP2 = $('#bearoff-p2');
  const cube = $('#cube');
  const dice = $('#dice');

  clear(top); clear(bottom); clear(barTop); clear(barBottom); clear(dice);

  // Build 12 columns each row
  for (let col = 0; col < 12; col++) {
    const pTop = make('div', 'point' + ((col % 2 === 0) ? ' striped' : ''));
    const absTop = pointIndexForTop(col);
    const countTopP1 = board.points.player1[p1IndexFromAbsolute(absTop)] || 0;
    const countTopP2 = board.points.player2[p2IndexFromAbsolute(absTop)] || 0;
    if ((countTopP1 + countTopP2) > 0) {
      const player = countTopP2 > 0 ? 'player2' : 'player1';
      const count = countTopP2 > 0 ? countTopP2 : countTopP1;
      const stackTop = renderStack(count, player, 'top');
      pTop.appendChild(stackTop);
    }
    top.appendChild(pTop);

    const pBot = make('div', 'point' + ((col % 2 === 0) ? '' : ' striped'));
    const absBot = pointIndexForBottom(col);
    const countBotP1 = board.points.player1[p1IndexFromAbsolute(absBot)] || 0;
    const countBotP2 = board.points.player2[p2IndexFromAbsolute(absBot)] || 0;
    if ((countBotP1 + countBotP2) > 0) {
      const player = countBotP1 > 0 ? 'player1' : 'player2';
      const count = countBotP1 > 0 ? countBotP1 : countBotP2;
      const stackBot = renderStack(count, player, 'bottom');
      pBot.appendChild(stackBot);
    }
    bottom.appendChild(pBot);
  }

  // Bar
  const barCountTop = board.points.player2[25] || 0;
  if (barCountTop > 0) barTop.appendChild(renderStack(barCountTop, 'player2', 'top'));
  const barCountBottom = board.points.player1[25] || 0;
  if (barCountBottom > 0) barBottom.appendChild(renderStack(barCountBottom, 'player1', 'bottom'));

  // Bearoff (right side): top = player2, bottom = player1
  bearP2.textContent = String(board.points.player2[0] || 0);
  bearP1.textContent = String(board.points.player1[0] || 0);

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

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildOptions(quiz) {
  const options = [
    { key: 'best', label: quiz.best?.move, equity: quiz.best?.equity, correct: true },
    { key: 'user', label: quiz.user?.move, equity: quiz.user?.equity, correct: false },
    { key: 'higherSample', label: quiz.higherSample?.move, equity: quiz.higherSample?.equity, correct: false },
    { key: 'lowerSample', label: quiz.lowerSample?.move, equity: quiz.lowerSample?.equity, correct: false }
  ].filter(x => x.label);
  return shuffle(options);
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
  const res = await fetch('/getQuiz');
  if (res.status === 204) {
    $('#meta').textContent = 'No more quizzes available.';
    return;
  }
  const quiz = await res.json();
  // eslint-disable-next-line no-console
  console.log('[BG] Quiz payload:', quiz);
  currentQuiz = quiz;
  const board = decodeGnuId(String(quiz.gnuId || ''));
  logBoardCompact(board);
  renderBoard(board, quiz?.context?.dice || null);
  $('#meta').textContent = `To move: ${board.turn === 'player1' ? 'Player 1' : 'Player 2'} • Dice: ${quiz?.context?.dice?.die1 ?? '-'}-${quiz?.context?.dice?.die2 ?? '-'}`;
  renderOptions(quiz);
  $('#rateBtn').disabled = true;
  setLoading(false);
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
    badge.textContent = opt.correct ? 'Best' : 'Alt';
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
    await fetch('/updateQuiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: String(currentQuiz.id || ''), wasCorrect: !!isCorrect })
    });
  } catch {
    // ignore send errors
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
}

function init() {
  bindEvents();
  fetchQuiz();
}

document.addEventListener('DOMContentLoaded', init);


