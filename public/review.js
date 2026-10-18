/* Reviewing a recorded match against the engine: step through every move and
   cube action on the board. With LOCAL_ANALYSIS=1 on the server, each step can
   be analysed at depth and rolled out. */
import { $, make, clear, MoveInput } from './boardView.js';
import { downloadMatchFile, playFetch } from './playClient.js';

let review = null;
let gameIndex = 0;
let stepIndex = 0;
let moveInput = null;
// Analysis results by step and request, so stepping back does not recompute.
const analysisCache = new Map();
let analysisRequest = 0;

const pct = (value) => (value == null ? '–' : `${(value * 100).toFixed(1)}%`);
const num = (value) => (value == null ? '–' : (value * 100).toFixed(1));
const signed = (value, digits = 3) => (value == null ? '–' : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`);

function isClassic() {
  return document.documentElement.getAttribute('data-theme') === 'classic';
}

function colorOf(who) {
  if (who === 'you') return isClassic() ? 'Black' : 'Blue';
  return isClassic() ? 'White' : 'Red';
}

function currentGame() {
  return review.games[gameIndex];
}

function currentStep() {
  return currentGame().steps[stepIndex];
}

/** Whose view an analysis takes: the player on roll in the step's position. */
function analysable(step) {
  if (step.type === 'move') return step.move ? 'move' : null;
  if (['no-double', 'double', 'take', 'pass'].includes(step.type)) return 'cube';
  return null;
}

function describeStep(step) {
  const who = step.who === 'you' ? `You (${colorOf('you')})` : 'Engine';
  switch (step.type) {
  case 'move': {
    const dice = `${step.dice.die1}-${step.dice.die2}`;
    if (!step.move) return `${who} roll ${dice} and cannot move`;
    return `${who} play ${dice}: ${step.move}${step.forced ? ' (forced)' : ''}`;
  }
  case 'no-double': return 'You roll instead of doubling';
  case 'double': return `${who} double${step.who === 'you' ? '' : 's'} to ${step.cube}`;
  case 'take': return `${who} take${step.who === 'you' ? '' : 's'}`;
  case 'pass': return `${who} pass${step.who === 'you' ? '' : 'es'}`;
  case 'game-over': {
    const kind = { single: '', gammon: ' a gammon', backgammon: ' a backgammon', pass: '' }[step.kind] || '';
    return `${step.who === 'you' ? 'You win' : 'The engine wins'}${kind}: ${step.points} point${step.points === 1 ? '' : 's'}`;
  }
  default: return step.type;
  }
}

function shortStep(step) {
  if (step.type === 'move') {
    const dice = `${step.dice.die1}${step.dice.die2}`;
    return `${step.who === 'you' ? 'You' : 'Engine'} ${dice}: ${step.move || 'no move'}`;
  }
  return describeStep(step);
}

/** A board numbered from the human's side, as on the play page. */
function boardFromOgid(ogid) {
  return { ...window.ogidCodec.decodeOgid(ogid), turn: 'player1' };
}

function showBoard(step) {
  // Moves are shown before they are made, with their dice; game ends after.
  const ogid = step.type === 'game-over' ? step.after : step.before;
  const board = boardFromOgid(ogid);
  moveInput.show(board, step.type === 'move' ? step.dice : null);
}

function renderGrade(step) {
  const container = $('#stepGrade');
  clear(container);
  const grade = step.grade;
  if (!grade) return;
  const row = make('div', grade.grade ? `play-flag ${grade.grade}` : 'play-flag');
  if (grade.grade) {
    const label = window.analysisText.gradeLabel(grade.loss)
      || grade.grade.charAt(0).toUpperCase() + grade.grade.slice(1);
    row.appendChild(make('strong', null, `During play: ${label} (−${grade.loss.toFixed(3)})`));
  } else {
    row.appendChild(make('strong', null, 'During play: no error'));
  }
  if (grade.best) row.appendChild(make('span', null, ` Best: ${grade.best}.`));
  if (grade.marked) row.appendChild(make('div', 'review-marked', '★ You marked this for review'));
  container.appendChild(row);
}

function renderSteps() {
  const list = $('#stepList');
  clear(list);
  currentGame().steps.forEach((step, index) => {
    const item = make('li', `review-step play-log-${step.who === 'engine' ? 'engine' : 'info'}`);
    if (index === stepIndex) item.classList.add('current');
    const flag = step.grade?.grade
      ? ` ⚑ ${(window.analysisText.gradeLabel(step.grade.loss) || step.grade.grade).toLowerCase()}`
      : '';
    const star = step.grade?.marked ? '★ ' : '';
    item.textContent = `${star}${shortStep(step)}${flag}`;
    item.addEventListener('click', () => select(gameIndex, index));
    list.appendChild(item);
  });
  list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
}

function select(game, step) {
  gameIndex = game;
  stepIndex = step;
  $('#gameSelect').value = String(gameIndex);
  const current = currentStep();
  showBoard(current);
  $('#stepTitle').textContent = describeStep(current);
  const steps = currentGame().steps.length;
  const cube = boardFromOgid(current.before);
  const crawford = currentGame().crawford ? ' • Crawford game' : '';
  $('#stepMeta').textContent = `Step ${stepIndex + 1} of ${steps} • Score ${currentGame().score.you}:${currentGame().score.engine}`
    + ` • Cube ${cube.cube}${cube.cubeOwner ? (cube.cubeOwner === 'player1' ? ' (yours)' : ' (engine)') : ''}${crawford}`;
  renderGrade(current);
  renderSteps();
  $('#prevBtn').disabled = gameIndex === 0 && stepIndex === 0;
  $('#nextBtn').disabled = gameIndex === review.games.length - 1 && stepIndex === steps - 1;
  renderAnalysisPanel();
}

/** Every step marked for review during play, in match order. */
function markedSteps() {
  return review.games.flatMap((game, gameNumber) => game.steps
    .filter((entry) => entry.grade?.marked)
    .map((entry) => ({ game: gameNumber, index: entry.index })));
}

function nextMarked() {
  const marked = markedSteps();
  if (!marked.length) return;
  const after = marked.find((entry) => entry.game > gameIndex || (entry.game === gameIndex && entry.index > stepIndex));
  const target = after || marked[0];
  select(target.game, target.index);
}

function step(delta) {
  let game = gameIndex;
  let index = stepIndex + delta;
  if (index < 0 && game > 0) {
    game -= 1;
    index = review.games[game].steps.length - 1;
  } else if (index >= currentGame().steps.length && game < review.games.length - 1) {
    game += 1;
    index = 0;
  }
  if (index < 0 || index >= review.games[game].steps.length) return;
  select(game, index);
}

// --- Analysis (LOCAL_ANALYSIS only) ---

function cacheKey(stepRef, request) {
  return `${stepRef}|${JSON.stringify(request)}`;
}

function probabilityCells(row, evaluation) {
  if (!evaluation) {
    row.appendChild(make('td', null, '–'));
    row.appendChild(make('td', null, '–'));
    return;
  }
  const lose = 1 - evaluation.win;
  row.appendChild(make('td', null, `${num(evaluation.win)} (${num(evaluation.gammonWin)} / ${num(evaluation.backgammonWin)})`));
  row.appendChild(make('td', null, `${num(lose)} (${num(evaluation.gammonLoss)} / ${num(evaluation.backgammonLoss)})`));
}

function table(headers) {
  const element = make('table', 'review-table');
  const head = make('tr');
  headers.forEach((header) => head.appendChild(make('th', null, header)));
  const thead = make('thead');
  thead.appendChild(head);
  element.appendChild(thead);
  const body = make('tbody');
  element.appendChild(body);
  return { element, body };
}

/** The plain-language comparison above an analysis (shared/analysisText.js). */
function summaryBox(sentences) {
  const box = make('div', 'review-summary');
  sentences.forEach((sentence) => box.appendChild(make('p', null, sentence)));
  return box;
}

/** The cube value in the step's position: amounts in "games" are in points. */
function cubeValue(step) {
  return Math.max(1, Number(window.ogidCodec.decodeOgid(step.before).cube) || 1);
}

/**
 * A deep checker search answered from the engine's result cache (e.g. the
 * position was graded at this depth during play) takes no measurable time.
 * Cube searches can be genuinely that fast, so they only show the time.
 */
function timing(result, cacheHint = false) {
  const seconds = (result.durationMs || 0) / 1000;
  return cacheHint && seconds < 0.1 && result.plies >= 4 ? 'answered from the engine\'s cache' : `${seconds.toFixed(1)} s`;
}

/**
 * The engine searches only the most promising plays (and the played one) to
 * the full depth; the rest keep a shallower value. Values of different depths
 * are not comparable (odd and even depths differ systematically), so the
 * plays are grouped by depth and ranked and compared within the full depth.
 */
function renderMoveAnalysis(result, step) {
  const container = make('div');
  const playedMove = result.played?.move ?? step.move;
  container.appendChild(make('div', 'meta',
    `${result.plies}-ply, ${result.legalMoves} legal plays, ${timing(result, true)}. `
    + 'Win and lose with gammons / backgammons in brackets; for the player on roll.'));
  const { element, body } = table(['#', 'Play', 'Depth', 'Equity', 'Diff', 'Win % (g / bg)', 'Lose % (g / bg)']);
  const rows = result.moves.slice();
  if (result.played && !rows.some((move) => move.move === result.played.move)) {
    rows.push({ ...result.played, evaluation: result.played.evaluation });
  }
  const full = rows.filter((move) => move.ply === result.plies).sort((a, b) => b.equity - a.equity);
  const shallow = rows.filter((move) => move.ply !== result.plies)
    .sort((a, b) => (b.ply - a.ply) || (b.equity - a.equity));
  const best = full[0]?.equity;
  const addRow = (move, rank, isFull) => {
    const classes = [move.move === playedMove ? 'played' : '', isFull ? '' : 'shallow'].filter(Boolean).join(' ');
    const row = make('tr', classes);
    row.appendChild(make('td', null, rank));
    row.appendChild(make('td', null, `${move.move || '(no move)'}${move.move === playedMove ? ' ◀ played' : ''}`));
    const depthCell = make('td', 'review-depth', move.ply ? `${move.ply}-ply` : '');
    if (!isFull && move.move) {
      const deepen = make('button', 'deepen-button', `⇢${result.plies}`);
      deepen.type = 'button';
      deepen.title = `Search this play to ${result.plies}-ply`;
      deepen.setAttribute('aria-label', `Search ${move.move} to ${result.plies}-ply`);
      deepen.disabled = deepening;
      deepen.addEventListener('click', () => deepenPlay(result, move.move, step));
      depthCell.appendChild(deepen);
    }
    row.appendChild(depthCell);
    row.appendChild(make('td', null, signed(move.equity)));
    row.appendChild(make('td', null, isFull && best != null && move.equity !== best ? signed(move.equity - best) : ''));
    probabilityCells(row, move.evaluation);
    body.appendChild(row);
  };
  if (step.who === 'you' && full.length) {
    const played = full.find((move) => move.move === playedMove);
    const sentences = window.analysisText.describeMove({
      played, best: full[0], next: full[1], cube: cubeValue(step)
    });
    if (sentences.length) container.insertBefore(summaryBox(sentences), container.firstChild);
  }
  full.forEach((move, index) => addRow(move, String(index + 1), true));
  if (shallow.length) {
    const separator = make('tr', 'separator');
    const cell = make('td', null,
      'Searched less deeply by the engine\'s move filter: not comparable with the plays above.'
      + ` Click ⇢${result.plies} to search a play to ${result.plies}-ply too.`);
    cell.colSpan = 7;
    separator.appendChild(cell);
    body.appendChild(separator);
    shallow.forEach((move) => addRow(move, '–', false));
  }
  container.appendChild(element);
  return container;
}

let deepening = false;

/** Search one shallow play to the table's depth and move it into the ranking. */
async function deepenPlay(result, move, step) {
  if (deepening) return;
  deepening = true;
  const stepRef = `${gameIndex}:${stepIndex}`;
  const status = $('#analysisStatus');
  const started = Date.now();
  const timer = setInterval(() => {
    status.textContent = `Searching ${move} to ${result.plies}-ply… ${Math.round((Date.now() - started) / 1000)} s`;
  }, 1000);
  status.textContent = `Searching ${move} to ${result.plies}-ply…`;
  showResults(stepRef);
  try {
    const { ok, payload, status: code } = await playFetch('play/analysis', {
      kind: 'deepen', ogid: step.before, move, plies: result.plies
    });
    if (!ok) throw new Error(payload.error || `Analysis failed (${code})`);
    const index = result.moves.findIndex((entry) => entry.move === move);
    if (index >= 0) result.moves[index] = payload.move;
    else result.moves.push(payload.move);
    if (`${gameIndex}:${stepIndex}` === stepRef) status.textContent = '';
  } catch (error) {
    status.textContent = `Could not search ${move}: ${error.message}`;
  } finally {
    clearInterval(timer);
    deepening = false;
    if (`${gameIndex}:${stepIndex}` === stepRef) showResults(stepRef);
  }
}

function renderCubeAnalysis(result, step) {
  const container = make('div');
  container.appendChild(summaryBox(window.analysisText.describeCube({
    step: step.type, who: step.who, analysis: result, cube: cubeValue(step)
  })));
  container.appendChild(make('div', 'review-verdict', `${result.decision}`));
  container.appendChild(make('div', 'meta',
    `${result.plies}-ply, for the player on roll (the doubler), ${timing(result)}.`));
  const { element, body } = table(['', 'Equity (EMG)', 'Match winning chances']);
  [['No double', 'noDouble'], ['Double, take', 'doubleTake'], ['Double, pass', 'doublePass']].forEach(([label, key]) => {
    const row = make('tr');
    row.appendChild(make('th', null, label));
    row.appendChild(make('td', null, signed(result.equity[key])));
    row.appendChild(make('td', null, result.mwc ? pct(result.mwc[key]) : '–'));
    body.appendChild(row);
  });
  container.appendChild(element);
  container.appendChild(probabilitySummary(result.evaluation));
  return container;
}

function probabilitySummary(evaluation) {
  const { element, body } = table(['Player on roll', 'Win', 'Gammon', 'Backgammon']);
  if (!evaluation) return element;
  const rows = [
    ['Wins', evaluation.win, evaluation.gammonWin, evaluation.backgammonWin],
    ['Loses', 1 - evaluation.win, evaluation.gammonLoss, evaluation.backgammonLoss]
  ];
  for (const [label, ...values] of rows) {
    const row = make('tr');
    row.appendChild(make('th', null, label));
    values.forEach((value) => row.appendChild(make('td', null, pct(value))));
    body.appendChild(row);
  }
  return element;
}

function renderMoveRollout(result, step) {
  const container = make('div');
  const trials = result.moves[0]?.trials;
  container.appendChild(make('div', 'meta',
    `Rollout (${result.mode}), ${trials} trials per play with 1-ply play, ${((result.durationMs || 0) / 1000).toFixed(1)} s.`));
  const { element, body } = table(['#', 'Play', 'Cubeful equity', 'Diff', 'Win % (g / bg)', 'Lose % (g / bg)']);
  const sorted = result.moves.slice().sort((a, b) => b.cubefulEquity - a.cubefulEquity);
  const playedEntry = sorted.find((move) => move.move === step.move);
  if (step.who === 'you' && playedEntry) {
    const asPlay = (move) => move && ({ move: move.move, equity: move.cubefulEquity, evaluation: move.evaluation });
    const sentences = window.analysisText.describeMove({
      played: asPlay(playedEntry), best: asPlay(sorted[0]), next: asPlay(sorted[1]), cube: cubeValue(step)
    });
    // A difference within two standard errors is too close to call.
    const best = sorted[0];
    const error = Math.hypot(best.stdError?.cubeful ?? 0, playedEntry.stdError?.cubeful ?? 0);
    if (playedEntry !== best && best.cubefulEquity - playedEntry.cubefulEquity < 2 * error) {
      sentences[0] = `Too close to call: within the rollout's precision, your play and ${best.move} are equally good.`;
    }
    container.insertBefore(summaryBox(sentences), container.firstChild);
  }
  sorted.forEach((move, index) => {
    const row = make('tr', move.move === step.move ? 'played' : '');
    row.appendChild(make('td', null, String(index + 1)));
    row.appendChild(make('td', null, `${move.move || '(no move)'}${move.move === step.move ? ' ◀ played' : ''}`));
    row.appendChild(make('td', null, `${signed(move.cubefulEquity)} ± ${(move.stdError?.cubeful ?? 0).toFixed(3)}`));
    row.appendChild(make('td', null, index === 0 ? '' : signed(move.cubefulEquity - sorted[0].cubefulEquity)));
    probabilityCells(row, move.evaluation);
    body.appendChild(row);
  });
  container.appendChild(element);
  if (!sorted.some((move) => move.move === step.move) && step.move) {
    container.appendChild(make('div', 'meta', `Your play ${step.move} was not among the rolled-out candidates.`));
  }
  return container;
}

function renderCubeRollout(result) {
  const container = make('div');
  container.appendChild(make('div', 'review-verdict', `Rollout: ${result.verdict.text}`));
  container.appendChild(make('div', 'meta',
    `Rollout (${result.mode}), ${result.trials} trials each for "no double" and "double, take", 1-ply play,`
    + ` ${((result.durationMs || 0) / 1000).toFixed(1)} s. Compared in match winning chances for the doubler.`));
  const { element, body } = table(['', 'Match winning chances', 'Std. error (equity)']);
  [['No double', 'noDouble'], ['Double, take', 'doubleTake'], ['Double, pass', 'doublePass']].forEach(([label, key]) => {
    const row = make('tr');
    row.appendChild(make('th', null, label));
    row.appendChild(make('td', null, pct(result.mwc[key])));
    row.appendChild(make('td', null, result.stdError[key] == null ? 'exact' : `± ${result.stdError[key].toFixed(4)}`));
    body.appendChild(row);
  });
  container.appendChild(element);
  container.appendChild(probabilitySummary(result.evaluation));
  return container;
}

function render(result, step) {
  switch (result.kind) {
  case 'move': return renderMoveAnalysis(result, step);
  case 'cube': return renderCubeAnalysis(result, step);
  case 'rollout-move': return renderMoveRollout(result, step);
  case 'rollout-cube': return renderCubeRollout(result);
  default: return make('div');
  }
}

function showResults(stepRef) {
  const results = $('#analysisResults');
  clear(results);
  for (const [key, entry] of analysisCache) {
    if (!key.startsWith(`${stepRef}|`)) continue;
    const section = make('section', 'review-result');
    section.appendChild(render(entry, currentStep()));
    results.appendChild(section);
  }
}

function renderAnalysisPanel() {
  const panel = $('#analysisPanel');
  const step = currentStep();
  const kind = review.analysis ? analysable(step) : null;
  panel.hidden = !kind;
  if (!kind) return;
  $('#analyseBtn').textContent = kind === 'move' ? 'Analyse plays' : 'Analyse cube';
  $('#rolloutBtn').textContent = kind === 'move' ? 'Roll out top 5' : 'Roll out cube';
  $('#analysisStatus').textContent = '';
  showResults(`${gameIndex}:${stepIndex}`);
}

async function runAnalysis(rollout) {
  const step = currentStep();
  const kind = analysable(step);
  if (!kind) return;
  const stepRef = `${gameIndex}:${stepIndex}`;
  const request = rollout
    ? { kind: `rollout-${kind}`, ogid: step.before, mode: $('#rolloutSelect').value, candidates: 5 }
    : { kind, ogid: step.before, played: kind === 'move' ? step.move : undefined, plies: Number($('#depthSelect').value) };
  const key = cacheKey(stepRef, request);
  if (analysisCache.has(key)) return;
  const id = ++analysisRequest;
  const status = $('#analysisStatus');
  const started = Date.now();
  const timer = setInterval(() => {
    status.textContent = `Working… ${Math.round((Date.now() - started) / 1000)} s`;
  }, 1000);
  status.textContent = 'Working…';
  $('#analyseBtn').disabled = true;
  $('#rolloutBtn').disabled = true;
  try {
    const { ok, payload, status: code } = await playFetch('play/analysis', request);
    if (!ok) throw new Error(payload.error || `Analysis failed (${code})`);
    analysisCache.set(key, payload);
    if (`${gameIndex}:${stepIndex}` === stepRef) {
      status.textContent = '';
      showResults(stepRef);
    }
  } catch (error) {
    if (id === analysisRequest) status.textContent = `Could not analyse: ${error.message}`;
  } finally {
    clearInterval(timer);
    $('#analyseBtn').disabled = false;
    $('#rolloutBtn').disabled = false;
  }
}

// --- Resizable split between board and analysis (wide screens) ---

const SPLIT_STORAGE = 'bgReviewBoardWidth';
const MIN_BOARD = 360;
const MIN_PANEL = 380;

function applyBoardWidth(width) {
  const layout = $('.layout');
  if (width == null) {
    layout.style.removeProperty('--review-board');
    return null;
  }
  const box = layout.getBoundingClientRect();
  const max = box.width - MIN_PANEL - 12 - 2 * 8 - 40;
  const clamped = Math.round(Math.max(MIN_BOARD, Math.min(width, max)));
  layout.style.setProperty('--review-board', `${clamped}px`);
  return clamped;
}

function saveBoardWidth(width) {
  try {
    if (width == null) window.localStorage.removeItem(SPLIT_STORAGE);
    else window.localStorage.setItem(SPLIT_STORAGE, String(width));
  } catch {
    // the default split is used next time
  }
}

function initSplitter() {
  const splitter = $('#reviewSplitter');
  const board = () => $('.board-area').getBoundingClientRect();
  try {
    const saved = Number(window.localStorage.getItem(SPLIT_STORAGE));
    if (saved > 0) applyBoardWidth(saved);
  } catch {
    // keep the default split
  }
  splitter.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add('dragging');
    const left = board().left;
    let width = null;
    const move = (moveEvent) => { width = applyBoardWidth(moveEvent.clientX - left - 4); };
    const end = () => {
      splitter.classList.remove('dragging');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', end);
      splitter.removeEventListener('pointercancel', end);
      if (width != null) saveBoardWidth(width);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', end);
    splitter.addEventListener('pointercancel', end);
  });
  splitter.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const width = applyBoardWidth(board().width + (event.key === 'ArrowLeft' ? -40 : 40));
    saveBoardWidth(width);
  });
  splitter.addEventListener('dblclick', () => {
    applyBoardWidth(null);
    saveBoardWidth(null);
  });
}

// --- Setup ---

function renderHeader() {
  const { match } = review;
  const started = new Date(match.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const status = match.status === 'finished'
    ? (match.score.you > match.score.engine ? 'won' : 'lost')
    : match.status;
  const pr = match.pr != null ? ` • PR ${match.pr.toFixed(1)}` : '';
  $('#matchInfo').textContent = `${match.length}-point match, ${match.plies}-ply, ${started} • `
    + `${review.player} ${match.score.you} : ${match.score.engine} engine (${status})${pr}`;
}

async function init() {
  moveInput = new MoveInput();
  initSplitter();
  const id = new URLSearchParams(window.location.search).get('id');
  const message = $('#reviewMessage');
  if (!id) {
    message.textContent = 'No match selected. Open a match from "My matches" on the play page.';
    return;
  }
  const { ok, status, payload } = await playFetch(`play/history/${encodeURIComponent(id)}/review`);
  if (!ok) {
    message.textContent = status === 401
      ? 'Please log in on the play page first.'
      : `This match could not be loaded (${payload.error || status}).`;
    return;
  }
  review = payload;
  if (!review.games.length || !review.games.some((game) => game.steps.length)) {
    message.textContent = 'This match has no recorded moves.';
    return;
  }
  renderHeader();
  const games = $('#gameSelect');
  review.games.forEach((game, index) => {
    const option = make('option', null, `Game ${game.number} (${game.score.you}:${game.score.engine})`);
    option.value = String(index);
    games.appendChild(option);
  });
  games.addEventListener('change', () => select(Number(games.value), 0));
  if (review.analysis) {
    const depth = $('#depthSelect');
    for (let plies = 1; plies <= review.analysis.maxPlies; plies++) {
      const option = make('option', null, `${plies}-ply`);
      option.value = String(plies);
      if (plies === review.analysis.plies) option.selected = true;
      depth.appendChild(option);
    }
  }
  $('#matBtn').addEventListener('click', () => downloadMatchFile(review.match.id));
  const marked = markedSteps().length;
  $('#nextMarkedBtn').hidden = !marked;
  $('#nextMarkedBtn').title = `Next of the ${marked} decision${marked === 1 ? '' : 's'} you marked for review`;
  $('#nextMarkedBtn').addEventListener('click', nextMarked);
  $('#prevBtn').addEventListener('click', () => step(-1));
  $('#nextBtn').addEventListener('click', () => step(1));
  $('#analyseBtn').addEventListener('click', () => runAnalysis(false));
  $('#rolloutBtn').addEventListener('click', () => runAnalysis(true));
  document.addEventListener('keydown', (event) => {
    if (event.target.closest('select, input, textarea, [role="separator"]')) return;
    if (event.key === 'ArrowLeft') step(-1);
    if (event.key === 'ArrowRight') step(1);
  });
  window.refreshReview = () => select(gameIndex, stepIndex);
  select(0, 0);
}

document.addEventListener('DOMContentLoaded', init);
