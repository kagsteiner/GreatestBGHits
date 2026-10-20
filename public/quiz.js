/* global fetch */
import { $, $$, clear, make, MoveInput } from './boardView.js';
import { mergeDeepened, playPreview, rankedPlays, renderCubeAnalysis, renderMoveAnalysis } from './analysisView.js';
import { initSplitter } from './splitter.js';

const authFetch = (...args) => window.dgAuth.authFetch(...args);


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
window.isBoardOrientationLocked = true;
let currentBoard = null;

// --- Moving checkers on the board ---
// A finished play on the board selects the matching answer option, or adds
// the play as an extra option that the engine rates when it is submitted.
let moveInput = null;
let boardPlay = null; // { quizId, status: 'loading'|'ready'|'unavailable', options }
const CUSTOM_OPTION_KEY = 'custom';

function redrawBoard() {
  if (!currentBoard || !currentQuiz || !moveInput) return;
  moveInput.redraw();
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
  const play = moveInput.play;
  const showButtons = Boolean(play && moveInput.active);
  $('#boardUndoBtn').hidden = !showButtons;
  $('#boardResetBtn').hidden = !showButtons;
  if (boardPlay.status === 'loading') {
    status.textContent = 'Preparing the board for moving checkers…';
  } else if (boardPlay.status === 'unavailable') {
    status.textContent = 'Moving checkers on the board is unavailable right now.';
  } else if (!play) {
    status.textContent = '';
  } else if (play.moveCount === 0) {
    status.textContent = moveInput.active ? 'Or move the checkers on the board.' : '';
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
  const play = boardPlay ? moveInput.play : null;
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
  syncSelectionWithBoard();
  updateBoardPlayPanel();
}

/** A radio button was picked: a different answer discards the play on the board. */
function onOptionPicked(option) {
  const play = boardPlay ? moveInput.play : null;
  if (!play || play.moveCount === 0) return;
  if (play.isComplete() && boardPlay.options[option.key] === play.finalKey()) return;
  play.reset();
  removeCustomOption();
  selection = option;
  moveInput.setActive(true);
  updateBoardPlayPanel();
}

async function startBoardPlay(quiz) {
  boardPlay = null;
  if (quizGroup(quiz) !== 'checker' || !quiz?.id || !window.checkerPlay) {
    updateBoardPlayPanel();
    return;
  }
  const quizId = String(quiz.id);
  boardPlay = { quizId, status: 'loading', options: {} };
  updateBoardPlayPanel();
  try {
    const response = await authFetch(`legalPlays/${encodeURIComponent(quizId)}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Legal plays request failed (${response.status})`);
    if (boardPlay?.quizId !== quizId || currentQuiz?.id !== quiz.id) return;
    moveInput.enable(payload);
    if (answeredSelection) moveInput.setActive(false);
    boardPlay.options = payload.options || {};
    boardPlay.status = 'ready';
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[BG] Moving checkers unavailable:', error);
    if (boardPlay?.quizId !== quizId) return;
    boardPlay.status = 'unavailable';
  }
  updateBoardPlayPanel();
}

function stopBoardPlay() {
  if (!boardPlay) return;
  moveInput.setActive(false);
  updateBoardPlayPanel();
}

function bindBoardPlayEvents() {
  moveInput = new MoveInput({ onChange: boardPlayChanged });
  $('#boardUndoBtn').addEventListener('click', (e) => {
    e.preventDefault();
    moveInput.undo();
  });
  $('#boardResetBtn').addEventListener('click', (e) => {
    e.preventDefault();
    moveInput.reset();
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
    moveInput?.setActive(false);
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
  resetAnalysisPanel();
  setQuizContentVisible(true);
  setAdminNotice(quiz.adminNotice);
  const board = window.ogidCodec.decodeOgid(String(quiz.ogid || ''));
  currentBoard = board;
  logBoardCompact(board);
  if (window.isBoardOrientationLocked) {
    enforceBoardOrientation(board, quiz);
  }
  moveInput.show(board, quiz?.context?.dice || null);
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
  startBoardPlay(quiz);

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
  const analysisBtn = $('#analysisBtn');
  let hasExternalLink = false;
  if (dgLink && quiz.dgGameId && quiz.dgMoveNumber) {
    const dgUrl = `http://dailygammon.com/bg/game/${quiz.dgGameId}/0/${quiz.dgMoveNumber}`;
    dgLink.href = dgUrl;
    dgLink.style.display = 'inline-flex';
    hasExternalLink = true;
  } else if (dgLink) {
    dgLink.style.display = 'none';
  }
  if (analysisBtn && quiz.id) {
    analysisBtn.style.display = 'inline-flex';
    analysisBtn.title = quizGroup(quiz) === 'cube'
      ? 'The engine\'s analysis of this cube decision'
      : 'The engine\'s analysis of all plays';
    hasExternalLink = true;
    updateAnalysisButtons();
  } else if (analysisBtn) {
    analysisBtn.style.display = 'none';
  }
  if (externalLinkContainer) {
    externalLinkContainer.style.display = hasExternalLink ? 'flex' : 'none';
  }
}

// --- Analysis panel: all plays or the cube decision, as in the match review ---
// The full analysis at the deep depth (savePlies) also updates the quiz, as
// the former "Deep Analysis" button did.
let analysisLimits = null; // { plies, maxPlies, savePlies }, from the server
let analysisState = null; // { quizId, busy, timer, results: Map<plies, { analysis, answer }> }
let answerSaving = false;
// A play clicked in the analysis table, shown on the board.
const preview = playPreview({ preview: (move) => moveInput?.preview(move) }, () => $('#quizAnalysisResult'));

const normalizeMove = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();

async function quizAnalysisRequest(body) {
  const response = await authFetch('quizAnalysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Analysis failed (${response.status})`);
  return payload;
}

async function loadAnalysisLimits() {
  if (analysisLimits) return analysisLimits;
  const response = await authFetch('quizAnalysis/limits');
  const payload = await response.json().catch(() => ({}));
  if (response.status === 404) throw new Error('this server does not offer it yet (restart it after an update)');
  if (!response.ok) throw new Error(payload.error || `the server answered ${response.status}`);
  analysisLimits = payload;
  return payload;
}

function quizIsDeepAnalysed(quiz) {
  return quiz?.deepAnalysis?.status === 'complete';
}

function resetAnalysisPanel() {
  if (analysisState?.timer) clearInterval(analysisState.timer);
  analysisState = null;
  preview.reset();
  const panel = $('#quizAnalysis');
  if (!panel) return;
  panel.hidden = true;
  $('#analysisBtn').setAttribute('aria-expanded', 'false');
  $('#quizAnalysisControls').hidden = true;
  clear($('#quizAnalysisResult'));
  $('#quizAnalysisStatus').textContent = '';
}

function updateAnalysisButtons() {
  const button = $('#analysisBtn');
  if (button) button.disabled = answerSaving;
  const analyse = $('#quizAnalyseBtn');
  if (analyse) analyse.disabled = answerSaving || analysisState?.busy === true;
  // The ⇢ buttons of a table drawn while an analysis was still running.
  $$('#quizAnalysisResult .deepen-button').forEach((deepen) => { deepen.disabled = analysisState?.busy === true; });
}

/** Depths 1 to the server's maximum; the quiz's own depth is preselected. */
function fillDepthSelect(quiz) {
  const select = $('#quizDepthSelect');
  const previous = select.value;
  clear(select);
  for (let plies = 1; plies <= analysisLimits.maxPlies; plies++) {
    const saves = plies === analysisLimits.savePlies && !quizIsDeepAnalysed(quiz);
    const option = make('option', null, `${plies}-ply${saves ? ' (updates this quiz)' : ''}`);
    option.value = String(plies);
    select.appendChild(option);
  }
  const graded = Number.isInteger(quiz.analysis?.plies) ? quiz.analysis.plies : analysisLimits.plies;
  const keep = [...select.options].some((option) => option.value === previous);
  select.value = keep ? previous : String(Math.min(graded, analysisLimits.maxPlies));
}

async function toggleAnalysisPanel() {
  const panel = $('#quizAnalysis');
  if (!currentQuiz?.id || !answeredSelection) return;
  if (!panel.hidden) {
    panel.hidden = true;
    $('#analysisBtn').setAttribute('aria-expanded', 'false');
    preview.choose(null);
    return;
  }
  panel.hidden = false;
  $('#analysisBtn').setAttribute('aria-expanded', 'true');
  const quizId = String(currentQuiz.id);
  if (analysisState?.quizId !== quizId) analysisState = { quizId, busy: false, timer: null, results: new Map() };
  try {
    await loadAnalysisLimits();
  } catch (error) {
    $('#quizAnalysisStatus').textContent = `Analysis unavailable: ${error.message}`;
    return;
  }
  if (analysisState?.quizId !== String(currentQuiz?.id || '')) return;
  // The depth controls show once the server has said which depths it offers.
  $('#quizAnalysisControls').hidden = false;
  fillDepthSelect(currentQuiz);
  const plies = Number($('#quizDepthSelect').value);
  if (analysisState.results.has(plies)) showQuizAnalysis(plies);
  else runQuizAnalysis();
}

function setAnalysisBusy(busy, message = '') {
  const status = $('#quizAnalysisStatus');
  if (analysisState.timer) clearInterval(analysisState.timer);
  analysisState.timer = null;
  analysisState.busy = busy;
  status.textContent = message;
  if (busy) {
    const started = Date.now();
    analysisState.timer = setInterval(() => {
      status.textContent = `${message} ${Math.round((Date.now() - started) / 1000)} s`;
    }, 1000);
  }
  updateAnalysisButtons();
}

async function runQuizAnalysis() {
  if (!currentQuiz?.id || !answeredSelection || !analysisState || analysisState.busy || !analysisLimits) return;
  const quiz = currentQuiz;
  const state = analysisState;
  const plies = Number($('#quizDepthSelect').value);
  if (state.results.has(plies)) {
    showQuizAnalysis(plies);
    return;
  }
  const cube = quizGroup(quiz) === 'cube';
  const saves = plies === analysisLimits.savePlies && !quizIsDeepAnalysed(quiz);
  setAnalysisBusy(true, saves
    ? `Analysing at ${plies}-ply and updating this quiz… This can take a while.`
    : `Analysing at ${plies}-ply…`);
  let done = '';
  try {
    const payload = await quizAnalysisRequest({
      id: String(quiz.id),
      kind: cube ? 'cube' : 'move',
      plies,
      answer: cube ? undefined : answeredSelection.label
    });
    if (analysisState !== state) return;
    state.results.set(plies, { analysis: payload.analysis, answer: payload.answer });
    if (payload.quiz) {
      await applyReanalysedQuiz(payload.quiz);
      if (analysisState !== state) return;
      fillDepthSelect(currentQuiz);
      done = `Saved: this quiz now uses the ${plies}-ply analysis.`;
    }
    showQuizAnalysis(plies);
  } catch (error) {
    done = `Could not analyse: ${error.message}`;
  } finally {
    if (analysisState === state) setAnalysisBusy(false, done);
  }
}

/** The points each side still needs, from `player`'s view; null for money play. */
function awayFor(board, player) {
  if (!board.matchLength || !player) return null;
  const other = player === 'player1' ? 'player2' : 'player1';
  return { away: board.matchLength - board.score[player], opponentAway: board.matchLength - board.score[other] };
}

function checkerSummary(quiz, board, analysis, answerMove) {
  const { full } = rankedPlays(analysis);
  const played = full.find((move) => move.move === answerMove);
  if (!played) return [];
  return window.analysisText.describeMove({
    played, best: full[0], next: full[1], cube: Math.max(1, board.cube || 1), score: awayFor(board, board.turn)
  });
}

function cubeSummary(quiz, board, analysis) {
  const action = answeredSelection?.action;
  if (!action) return [];
  const doubler = quiz.context?.onRoll || quiz.context?.offeredBy || quiz.context?.player;
  return window.analysisText.describeCube({
    step: action,
    who: 'you',
    analysis,
    cube: Math.max(1, Number(quiz.context?.cubeValue) || board.cube || 1),
    score: awayFor(board, doubler),
    opponent: 'Your opponent'
  });
}

function showQuizAnalysis(plies) {
  const container = $('#quizAnalysisResult');
  clear(container);
  const entry = analysisState?.results.get(plies);
  if (!entry) return;
  const quiz = currentQuiz;
  const board = window.ogidCodec.decodeOgid(String(quiz.ogid || ''));
  if (entry.analysis.kind === 'cube') {
    container.appendChild(renderCubeAnalysis(entry.analysis, cubeSummary(quiz, board, entry.analysis)));
    return;
  }
  const { analysis } = entry;
  const rows = [...analysis.moves, ...(analysis.played ? [analysis.played] : [])];
  const matchMove = rows.find((move) => normalizeMove(move.move) === normalizeMove(quiz.user?.move))?.move;
  const marks = [];
  if (entry.answer) marks.push([entry.answer, 'your answer']);
  if (matchMove) marks.push([matchMove, 'played in the match']);
  container.appendChild(renderMoveAnalysis(analysis, {
    marks,
    summary: checkerSummary(quiz, board, analysis, entry.answer),
    deepen: { busy: analysisState.busy, onClick: (move) => deepenQuizPlay(plies, move) },
    preview
  }));
}

/** Search one shallow play to the table's depth and move it into the ranking. */
async function deepenQuizPlay(plies, move) {
  const state = analysisState;
  const entry = state?.results.get(plies);
  if (!entry || state.busy) return;
  setAnalysisBusy(true, `Searching ${move} to ${plies}-ply…`);
  showQuizAnalysis(plies);
  let done = '';
  try {
    const payload = await quizAnalysisRequest({ id: state.quizId, kind: 'deepen', plies, move });
    mergeDeepened(entry.analysis, payload.analysis);
  } catch (error) {
    done = `Could not search ${move}: ${error.message}`;
  } finally {
    if (analysisState === state) {
      setAnalysisBusy(false, done);
      showQuizAnalysis(plies);
    }
  }
}

function sameAnsweredOption(option, answered) {
  if (!option || !answered) return false;
  if (answered.action) return option.action === answered.action;
  const normalize = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return normalize(option.label) === normalize(answered.label);
}

/** The quiz was analysed again and saved: grade the given answer against the new result. */
async function applyReanalysedQuiz(updated) {
  const quizId = String(updated.id);
  currentQuiz = updated;
  const options = buildOptions(updated, false);
  let selected = options.find((option) => sameAnsweredOption(option, answeredSelection));
  if (!selected && answeredSelection.custom) {
    // Rate the play made on the board again at the new depth.
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
  showFeedback(updated, evaluation, options, selected.key);
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
    enforceBoardOrientation(currentBoard, currentQuiz);
    redrawBoard();
  }
}

/**
 * The player who makes the quiz's decision: the one offered the cube in a
 * take/pass quiz (the doubler is on roll), else the player on roll.
 */
function decidingPlayer(board, quiz) {
  if (quiz?.type === 'cube-response') {
    return quiz.context?.player || (board.turn === 'player1' ? 'player2' : 'player1');
  }
  return board.turn;
}

function enforceBoardOrientation(board, quiz) {
  // player1 moves from high points (24) toward low (1)
  // Default (unflipped) board: top row = 13-24, bottom row = 12-1
  // So for player1: home (1-6) is already at bottom → no flip needed
  // For player2: home (their 1-6 = absolute 24-19) is at top → flip needed
  // The board is shown from the side of the player who decides.
  const needsFlip = decidingPlayer(board, quiz) === 'player2';
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
    moveInput.setActive(false);
    if (status) status.textContent = `Rating ${custom.label}…`;
    try {
      const rating = await rateCustomMove(custom);
      if (String(currentQuiz?.id || '') !== quizId) return;
      custom.equity = rating.equity;
      custom.correct = rating.isBest === true;
    } catch (error) {
      if (String(currentQuiz?.id || '') !== quizId) return;
      moveInput.setActive(true);
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
  answerSaving = true;
  showFeedback(currentQuiz, evaluation, displayed, selection?.key);
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
    answerSaving = false;
    updateAnalysisButtons();
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
  initSplitter({
    layout: $('.layout'), splitter: $('#quizSplitter'), board: $('.board-area'),
    storageKey: 'bgQuizBoardWidth', minBoard: 360, minPanel: 300
  });
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

  $('#analysisBtn').addEventListener('click', (e) => {
    e.preventDefault();
    toggleAnalysisPanel();
  });
  $('#quizAnalyseBtn').addEventListener('click', (e) => {
    e.preventDefault();
    runQuizAnalysis();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && preview.selected) preview.choose(null);
  });
  $('#quizDepthSelect').addEventListener('change', () => {
    // A cached depth shows at once; a new one waits for "Analyse" (the deep one saves).
    const plies = Number($('#quizDepthSelect').value);
    if (analysisState?.results.has(plies)) {
      showQuizAnalysis(plies);
    } else {
      clear($('#quizAnalysisResult'));
      if (!analysisState?.busy) $('#quizAnalysisStatus').textContent = '';
    }
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
  // Locked (home board of the player on roll at the bottom) is the default;
  // only an explicit choice to unlock is remembered.
  window.isBoardOrientationLocked = true;
  try {
    if (window.localStorage.getItem('bgBoardOrientationLocked') === '0') {
      window.isBoardOrientationLocked = false;
    }
  } catch {
    // keep the default
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
