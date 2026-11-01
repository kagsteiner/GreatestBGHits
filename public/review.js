/* Reviewing a recorded match against the engine: step through every move and
   cube action on the board, and analyse each step (up to 4-ply; with the
   engine in this browser, or LOCAL_ANALYSIS=1 on the server, up to 7-ply and
   rollouts). */
import { $, make, clear, MoveInput } from './boardView.js';
import { downloadMatchFile, playFetch } from './playClient.js';
import { initSplitter } from './splitter.js';
import {
  depthOptionText, fillRolloutOptions, mergeDeepened, playPreview, rankedPlays, renderCubeAnalysis as cubeView,
  renderCubeRollout as rolloutCubeView, renderMoveAnalysis as moveView, renderMoveRollout as rolloutMoveView
} from './analysisView.js';

let review = null;
let gameIndex = 0;
let stepIndex = 0;
let moveInput = null;
// A play clicked in an analysis table, shown on the board.
const preview = playPreview({ preview: (move) => moveInput?.preview(move) }, () => $('#analysisResults'));
// Analysis results by step and request, so stepping back does not recompute.
const analysisCache = new Map();
let analysisRequest = 0;


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
  preview.reset();
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

// --- Analysis ---

function cacheKey(stepRef, request) {
  return `${stepRef}|${JSON.stringify(request)}`;
}

/** The cube value in the step's position: amounts in "games" are in points. */
function cubeValue(step) {
  return Math.max(1, Number(window.ogidCodec.decodeOgid(step.before).cube) || 1);
}

/**
 * The points each side still needs in the step's position, from the view of
 * `who` ('you' or 'engine'): gammons may not count at the score. The human is
 * player1 in the position IDs. Null for money play.
 */
function scoreFor(step, who) {
  const { matchLength, score } = window.ogidCodec.decodeOgid(step.before);
  if (!matchLength) return null;
  const you = matchLength - score.player1;
  const engine = matchLength - score.player2;
  return who === 'you' ? { away: you, opponentAway: engine } : { away: engine, opponentAway: you };
}

/** Who doubled in a cube step: the one doubling, or the opponent of the one taking or passing. */
function doublerOf(step) {
  if (step.type === 'no-double' || step.type === 'double') return step.who;
  return step.who === 'you' ? 'engine' : 'you';
}

/** All plays of a checker analysis; for your moves with the summary above. */
function renderMoveAnalysis(result, step) {
  const playedMove = result.played?.move ?? step.move;
  let summary = [];
  const { full } = rankedPlays(result);
  if (step.who === 'you' && full.length) {
    const played = full.find((move) => move.move === playedMove);
    summary = window.analysisText.describeMove({
      played, best: full[0], next: full[1], cube: cubeValue(step), score: scoreFor(step, 'you')
    });
  }
  return moveView(result, {
    marks: [[playedMove, 'played']],
    summary,
    deepen: { busy: deepening, onClick: (move) => deepenPlay(result, move, step) },
    preview
  });
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
    mergeDeepened(result, payload);
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
  return cubeView(result, window.analysisText.describeCube({
    step: step.type, who: step.who, analysis: result, cube: cubeValue(step), score: scoreFor(step, doublerOf(step))
  }));
}

function renderMoveRollout(result, step) {
  return rolloutMoveView(result, {
    marks: step.move ? [[step.move, 'played']] : [],
    focus: step.who === 'you' ? step.move : null,
    describe: (played, best, next) => window.analysisText.describeMove({
      played, best, next, cube: cubeValue(step), score: scoreFor(step, 'you')
    }),
    preview
  });
}

function render(result, step) {
  switch (result.kind) {
  case 'move': return renderMoveAnalysis(result, step);
  case 'cube': return renderCubeAnalysis(result, step);
  case 'rollout-move': return renderMoveRollout(result, step);
  case 'rollout-cube': return rolloutCubeView(result);
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
  // The key keeps the width readers chose before the handle was shared with the quiz page.
  initSplitter({
    layout: $('.layout'), splitter: $('#reviewSplitter'), board: $('.board-area'),
    storageKey: 'bgReviewBoardWidth', minBoard: 360, minPanel: 380
  });
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
    fillAnalysisControls();
    window.addEventListener('enginebridgechange', fillAnalysisControls);
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
    if (event.key === 'Escape' && preview.selected) {
      preview.choose(null);
      return;
    }
    if (event.target.closest('select, input, textarea, [role="separator"]')) return;
    if (event.key === 'ArrowLeft') step(-1);
    if (event.key === 'ArrowRight') step(1);
  });
  window.refreshReview = () => select(gameIndex, stepIndex);
  select(0, 0);
}

/**
 * The depths and rollouts on offer: more with the engine in this browser
 * (or LOCAL_ANALYSIS on the server). Keeps the chosen ones where possible.
 */
function fillAnalysisControls() {
  const limits = window.engineBridge ? window.engineBridge.limits(review.analysis) : review.analysis;
  const depth = $('#depthSelect');
  const previous = Number(depth.value) || review.analysis.plies;
  clear(depth);
  for (let plies = 1; plies <= limits.maxPlies; plies++) {
    const option = make('option', null, depthOptionText(plies, limits));
    option.value = String(plies);
    depth.appendChild(option);
  }
  depth.value = String(Math.min(previous, limits.maxPlies));
  const rollouts = fillRolloutOptions($('#rolloutSelect'), limits);
  $('#rolloutSelect').hidden = !rollouts;
  $('#rolloutBtn').hidden = !rollouts;
}

document.addEventListener('DOMContentLoaded', init);
