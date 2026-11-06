/* Reviewing a match, against the engine or (?friend=id&as=seat) a friend: step
   through every move and cube action on the board, and analyse each step (up
   to 4-ply; with the engine in this browser, or LOCAL_ANALYSIS=1 on the server,
   up to 7-ply and rollouts). Between friends, the other player has the place of
   the engine ("engine" in the steps). ?running=1 and ?friend=running review the
   match going on, as far as it was played. */
import { $, make, clear, MoveInput } from './boardView.js';
import { initBoardPage } from './boardPage.js';
import { boardFor, ownColor } from './matchPage.js';
import { downloadMatchFile, playFetch, positionRequest } from './playClient.js';
import { rankedPlays } from './analysisView.js';
import { awayFor, createAnalysisPanel } from './analysisPanel.js';

const query = new URLSearchParams(window.location.search);
const friendMatchId = query.get('friend');
const friendSeat = query.get('as') === 'player2' ? 'player2' : 'player1';
const runningMatch = friendMatchId === 'running' || query.has('running');
// Where the page asks for things.
const API = friendMatchId ? 'friend' : 'play';
// While a friend plays on, new decisions show up here.
const RUNNING_POLL_MS = 4000;

const page = initBoardPage({
  subtitle: runningMatch ? 'match so far' : 'match review',
  fastMoves: false,
  back: {
    href: friendMatchId ? 'friend.html' : 'play.html',
    label: runningMatch ? 'Back to the match' : (friendMatchId ? 'Back to the friendly match' : 'Back to playing')
  }
});

let review = null;
let gameIndex = 0;
let stepIndex = 0;
let moveInput = null;
const panel = createAnalysisPanel($('#analysisPanel'), { preview: (move) => moveInput?.preview(move) });

/** The other player's name, or "Engine". */
function opponent() {
  return review.opponent || 'Engine';
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
  const you = step.who === 'you';
  const who = you ? `You (${ownColor()})` : opponent();
  switch (step.type) {
  case 'move': {
    const dice = `${step.dice.die1}-${step.dice.die2}`;
    if (!step.move) return `${who} roll${you ? '' : 's'} ${dice} and cannot move`;
    return `${who} play${you ? '' : 's'} ${dice}: ${step.move}${step.forced ? ' (forced)' : ''}`;
  }
  case 'no-double': return you ? 'You roll instead of doubling' : `${opponent()} rolls instead of doubling`;
  case 'double': return `${who} double${step.who === 'you' ? '' : 's'} to ${step.cube}`;
  case 'take': return `${who} take${step.who === 'you' ? '' : 's'}`;
  case 'pass': return `${who} pass${step.who === 'you' ? '' : 'es'}`;
  case 'game-over': {
    const kind = { single: '', gammon: ' a gammon', backgammon: ' a backgammon', pass: '' }[step.kind] || '';
    const winner = you ? 'You win' : (review.opponent ? `${review.opponent} wins` : 'The engine wins');
    return `${winner}${kind}: ${step.points} point${step.points === 1 ? '' : 's'}`;
  }
  default: return step.type;
  }
}

function shortStep(step) {
  if (step.type === 'move') {
    const dice = `${step.dice.die1}${step.dice.die2}`;
    return `${step.who === 'you' ? 'You' : opponent()} ${dice}: ${step.move || 'no move'}`;
  }
  return describeStep(step);
}

function showBoard(step) {
  // Moves are shown before they are made, with their dice; game ends after.
  const ogid = step.type === 'game-over' ? step.after : step.before;
  const board = boardFor(ogid);
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
  if (grade.marked) row.appendChild(make('div', 'review-marked', friendMatchId ? '★ Marked during the match' : '★ You marked this for review'));
  container.appendChild(row);
}

function renderSteps({ scroll = true } = {}) {
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
  if (scroll) list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
}

function select(game, step) {
  gameIndex = game;
  stepIndex = step;
  $('#gameSelect').value = String(gameIndex);
  const current = currentStep();
  panel.reset();
  showBoard(current);
  $('#stepTitle').textContent = describeStep(current);
  const steps = currentGame().steps.length;
  const cube = boardFor(current.before);
  const crawford = currentGame().crawford ? ' • Crawford game' : '';
  $('#stepMeta').textContent = `Step ${stepIndex + 1} of ${steps} • Score ${currentGame().score.you}:${currentGame().score.engine}`
    + ` • Cube ${cube.cube}${cube.cubeOwner ? (cube.cubeOwner === 'player1' ? ' (yours)' : ` (${review.opponent || 'engine'})`) : ''}${crawford}`;
  renderGrade(current);
  renderSteps();
  page.setBoardInfo(`Step ${stepIndex + 1} of ${steps} • ${currentGame().score.you}:${currentGame().score.engine}`);
  updateStepButtons();
  panel.show(decisionFor(current));
}

function updateStepButtons() {
  $('#prevBtn').disabled = gameIndex === 0 && stepIndex === 0;
  $('#nextBtn').disabled = gameIndex === review.games.length - 1 && stepIndex === currentGame().steps.length - 1;
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
  return awayFor(window.ogidCodec.decodeOgid(step.before), who === 'you' ? 'player1' : 'player2');
}

/** Who doubled in a cube step: the one doubling, or the opponent of the one taking or passing. */
function doublerOf(step) {
  if (step.type === 'no-double' || step.type === 'double') return step.who;
  return step.who === 'you' ? 'engine' : 'you';
}

/** What the analysis panel shows for a step; null if there is nothing to decide in it. */
function decisionFor(step) {
  const kind = review.analysis ? analysable(step) : null;
  if (!kind) return null;
  const describe = (played, best, next) => window.analysisText.describeMove({
    played, best, next, cube: cubeValue(step), score: scoreFor(step, 'you')
  });
  return {
    key: `${gameIndex}:${stepIndex}`,
    kind,
    request: positionRequest(step.before, kind === 'move' ? step.move : null),
    marks: (result) => {
      const played = result.played?.move ?? step.move;
      return played ? [[played, 'played']] : [];
    },
    // Your own moves are compared with the best one.
    summary: (result) => {
      const { full } = rankedPlays(result);
      if (step.who !== 'you' || !full.length) return [];
      const played = full.find((move) => move.move === (result.played?.move ?? step.move));
      return describe(played, full[0], full[1]);
    },
    cubeSummary: (result) => window.analysisText.describeCube({
      step: step.type, who: step.who, analysis: result, cube: cubeValue(step), score: scoreFor(step, doublerOf(step))
    }),
    focus: () => (step.who === 'you' ? step.move : null),
    describe
  };
}

// --- Setup ---

function renderHeader() {
  const { match } = review;
  const started = new Date(match.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const status = match.status === 'finished'
    ? (match.score.you > match.score.engine ? 'won' : 'lost')
    : match.status;
  const pr = match.pr != null ? ` • PR ${match.pr.toFixed(1)}` : '';
  const info = $('#matchInfo');
  if (review.opponent) {
    const theirs = match.opponentPr != null ? `, ${review.opponent} ${match.opponentPr.toFixed(1)}` : '';
    info.textContent = `${review.player} ${match.score.you} : ${match.score.engine} ${review.opponent} (${status})${pr}${theirs}`
      + ` • ${match.length}-point match, ${started}`;
  } else {
    info.textContent = `${review.player} ${match.score.you} : ${match.score.engine} engine (${status})${pr}`
      + ` • ${match.length}-point match, ${match.plies}-ply, ${started}`;
  }
  // It may not fit the header.
  info.title = info.textContent;
}

/** Take over what the server sent; a game just started has no steps to show yet. */
function adopt(payload) {
  review = { ...payload, games: payload.games.filter((game) => game.steps.length) };
}

function fillGames() {
  const games = $('#gameSelect');
  clear(games);
  review.games.forEach((game, index) => {
    const option = make('option', null, `Game ${game.number} (${game.score.you}:${game.score.engine})`);
    option.value = String(index);
    games.appendChild(option);
  });
  games.value = String(gameIndex);
}

function updateMarked() {
  const marked = markedSteps().length;
  $('#nextMarkedBtn').hidden = !marked;
  $('#nextMarkedBtn').title = `Next of the ${marked} decision${marked === 1 ? '' : 's'} marked for review`;
}

const stepCount = () => review.games.reduce((sum, game) => sum + game.steps.length, 0);

function renderRunningNote(text) {
  const note = $('#runningNote');
  note.hidden = !text;
  $('#runningNoteText').textContent = text || '';
}

/** What the friend did meanwhile comes in without moving you from the step you are looking at. */
async function followRunningMatch() {
  let answer;
  try {
    answer = await playFetch(`${API}/running/review`);
  } catch {
    return; // the next try may reach the server
  }
  if (!answer.ok) {
    renderRunningNote('The match is not at the table any more.');
    return;
  }
  const before = stepCount();
  adopt(answer.payload);
  renderHeader();
  if (stepCount() !== before) {
    fillGames();
    updateMarked();
    renderSteps({ scroll: false });
    updateStepButtons();
  }
  renderRunningNote(review.yourTurn ? 'It is your turn.' : '');
}

async function init() {
  moveInput = new MoveInput();
  const id = friendMatchId || query.get('id');
  const message = $('#reviewMessage');
  if (!id && !runningMatch) {
    message.textContent = 'No match selected. Open a match from "My matches" on the play page.';
    return;
  }
  const seat = friendMatchId && !runningMatch ? `?as=${friendSeat}` : '';
  const path = runningMatch ? `${API}/running/review` : `${API}/history/${encodeURIComponent(id)}/review${seat}`;
  const { ok, status, payload } = await playFetch(path);
  if (!ok) {
    message.textContent = status === 401
      ? 'Please log in on the play page first.'
      : (runningMatch ? 'No match is going on right now.' : `This match could not be loaded (${payload.error || status}).`);
    return;
  }
  adopt(payload);
  if (!review.games.length) {
    message.textContent = runningMatch ? 'No decision has been made in this match yet.' : 'This match has no recorded moves.';
    return;
  }
  renderHeader();
  panel.setLimits(review.analysis);
  // The match going on has no file yet.
  $('#matBtn').hidden = runningMatch;
  fillGames();
  $('#gameSelect').addEventListener('change', () => select(Number($('#gameSelect').value), 0));
  $('#matBtn').addEventListener('click', () => downloadMatchFile(review.match.id, `${API}/history/${encodeURIComponent(id)}/mat${seat}`));
  updateMarked();
  $('#nextMarkedBtn').addEventListener('click', nextMarked);
  $('#prevBtn').addEventListener('click', () => step(-1));
  $('#nextBtn').addEventListener('click', () => step(1));
  document.addEventListener('keydown', (event) => {
    if (event.target.closest('select, input, textarea, [role="separator"]')) return;
    if (event.key === 'ArrowLeft') step(-1);
    if (event.key === 'ArrowRight') step(1);
  });
  window.addEventListener('themechange', () => select(gameIndex, stepIndex));
  if (runningMatch) {
    // The latest decision is the one you came for.
    const last = review.games.length - 1;
    select(last, review.games[last].steps.length - 1);
    if (friendMatchId && review.running) {
      renderRunningNote(review.yourTurn ? 'It is your turn.' : '');
      setInterval(followRunningMatch, RUNNING_POLL_MS);
    }
  } else {
    select(0, 0);
  }
}

document.addEventListener('DOMContentLoaded', init);
