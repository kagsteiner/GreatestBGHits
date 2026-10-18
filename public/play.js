/* Playing a match against the engine. The server rolls the dice and plays the
   engine; this page shows its moves and lets the human move checkers. */
import { $, $$, make, clear, MoveInput } from './boardView.js';
import { drawPrChart } from './prChart.js';
import { downloadMatchFile, playFetch, storedKey, storeKey, storedSession, storeSession } from './playClient.js';

const LEVEL_STORAGE = 'bgPlayLevel';
const ENGINE_PAUSE_MS = 700;
const POLL_MS = 1000;
const LEVEL_LABELS = {
  1: '1-ply (instant)',
  2: '2-ply',
  3: '3-ply',
  4: '4-ply (~½ s per move)',
  5: '5-ply (a few s per move)',
  6: '6-ply (up to a minute per turn)'
};

let match = null;
let matchLengths = [];
let busy = false;
let moveInput = null;
let shownBoard = null;
let currentUser = null;
let historyMatches = [];
// Events of the running action that are already shown.
let seen = { actionId: null, count: 0 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function storedLevel(fallback) {
  try {
    const level = Number(window.localStorage.getItem(LEVEL_STORAGE));
    return Number.isInteger(level) && level > 0 ? level : fallback;
  } catch {
    return fallback;
  }
}

function storeLevel(level) {
  try {
    window.localStorage.setItem(LEVEL_STORAGE, String(level));
  } catch {
    // the default level is used next time
  }
}

function isClassic() {
  return document.documentElement.getAttribute('data-theme') === 'classic';
}

function colorOf(who) {
  if (who === 'you') return isClassic() ? 'Black' : 'Blue';
  return isClassic() ? 'White' : 'Red';
}

/** A board from the server's OGID, always numbered from the human's side. */
function boardFromOgid(ogid) {
  const board = window.ogidCodec.decodeOgid(ogid);
  return { ...board, turn: 'player1' };
}

function startingBoard() {
  const side = () => {
    const points = new Array(26).fill(0);
    points[24] = 2;
    points[13] = 5;
    points[8] = 3;
    points[6] = 5;
    return points;
  };
  return { points: { player1: side(), player2: side() }, turn: 'player1', cube: 1, cubeOwner: null, dice: null };
}

function showBoard(board, dice) {
  shownBoard = board;
  moveInput.show(board, dice);
}

// --- Rendering ---

function describeResult(result) {
  const points = `${result.points} point${result.points === 1 ? '' : 's'}`;
  const how = { single: '', gammon: ' a gammon', backgammon: ' a backgammon', pass: '' }[result.kind] || '';
  if (result.winner === 'you') {
    return result.kind === 'pass' ? `The engine passes. You win ${points}.` : `You win${how}: ${points}.`;
  }
  return result.kind === 'pass' ? `You pass. The engine wins ${points}.` : `The engine wins${how}: ${points}.`;
}

function describeEvent(event) {
  switch (event.type) {
  case 'opening':
    return `Opening roll: you ${event.you}, engine ${event.engine}. ${event.you > event.engine ? 'You start.' : 'The engine starts.'}`;
  case 'roll':
    return null;
  case 'move': {
    const dice = event.dice ? ` (${event.dice.die1}-${event.dice.die2})` : '';
    const move = event.move || 'cannot move';
    if (event.who === 'engine') return `Engine${dice}: ${move}`;
    return event.forced ? `You${dice}: ${move} (forced)` : `You${dice}: ${move}`;
  }
  case 'double':
    return event.who === 'engine' ? `Engine doubles to ${event.cube}.` : `You double to ${event.cube}.`;
  case 'take':
    return event.who === 'engine' ? 'Engine takes.' : 'You take.';
  case 'pass':
    return event.who === 'engine' ? 'Engine passes.' : 'You pass.';
  case 'game-over':
    return describeResult(event);
  default:
    return null;
  }
}

function appendLog(event) {
  const text = describeEvent(event);
  if (!text) return;
  const log = $('#playLog');
  if (event.type === 'opening') clear(log);
  const item = make('li', `play-log-${event.who || 'info'}`, text);
  log.appendChild(item);
  // Scroll only the log itself: moving the whole panel (on a phone) would
  // hide the feedback on a mistake, which matters more than the latest move.
  log.scrollTop = log.scrollHeight;
}

let shownFlags = '';

function renderFeedback(items) {
  const container = $('#playFeedback');
  clear(container);
  const flagged = (items || []).filter((item) => item.grade);
  for (const item of flagged) {
    const row = make('div', `play-flag ${item.grade}`);
    const label = item.grade.charAt(0).toUpperCase() + item.grade.slice(1);
    row.appendChild(make('strong', null, `${label} (−${item.loss.toFixed(3)})`));
    const what = item.kind === 'move' ? `You played ${item.action}.` : `You chose ${item.action}.`;
    const best = item.best ? ` Best: ${item.best}.` : '';
    row.appendChild(make('span', null, ` ${what}${best}`));
    container.appendChild(row);
  }
  // Bring a new mistake into view once (feedback is re-rendered while polling).
  // When the panel scrolls (on a phone), go to its top so the status and the
  // buttons above the feedback stay visible too.
  const key = JSON.stringify(flagged);
  if (flagged.length && key !== shownFlags) {
    const panel = container.closest('.play-area');
    if (panel && panel.scrollHeight > panel.clientHeight) panel.scrollTo({ top: 0 });
    else container.scrollIntoView({ block: 'nearest' });
  }
  shownFlags = key;
}

function setButtons(visible) {
  for (const id of ['rollBtn', 'doubleBtn', 'doneBtn', 'undoBtn', 'takeBtn', 'passBtn', 'nextGameBtn']) {
    const button = $(`#${id}`);
    button.hidden = !visible.includes(id);
    button.disabled = busy;
  }
}

/**
 * Clickable dice and cube: blank dice to roll, the cube to double, and the
 * dice again to finish a complete move.
 */
function updateBoardActions() {
  const boardEl = $('#board');
  const phase = busy ? null : match?.phase;
  const play = moveInput.play;
  const canRoll = phase === 'human-turn';
  const canFinish = phase === 'human-move' && Boolean(play?.isComplete() && play.moveCount > 0);
  boardEl.classList.toggle('can-roll', canRoll);
  boardEl.classList.toggle('can-double', canRoll);
  boardEl.classList.toggle('can-finish', canFinish);
  const dice = $('#dice');
  $$('#dice .die.ready').forEach((die) => die.remove());
  if (canRoll) {
    dice.appendChild(make('div', 'die ready'));
    dice.appendChild(make('div', 'die ready'));
  }
  dice.title = canRoll ? 'Roll' : (canFinish ? 'Finish the move' : '');
  if (canRoll) $('#cube').title = `Double to ${match.cube * 2}`;
}

function onDiceClick() {
  if (busy || !match) return;
  if (match.phase === 'human-turn') {
    act('roll');
    return;
  }
  const play = moveInput.play;
  if (match.phase === 'human-move' && play?.isComplete() && play.moveCount > 0) {
    act('move', { key: play.finalKey() });
  }
}

function onCubeClick() {
  if (!busy && match?.phase === 'human-turn') act('double');
}

function updateMoveStatus() {
  const play = moveInput.play;
  if (!play || match?.phase !== 'human-move') return;
  const [d1, d2] = match.legal.dice;
  if (play.isComplete() && play.moveCount > 0) {
    $('#playStatus').textContent = `Your move: ${play.finalMove()}`;
  } else if (play.moveCount > 0) {
    $('#playStatus').textContent = `Dice left: ${play.remaining.join(' ')}`;
  } else {
    $('#playStatus').textContent = `Your roll: ${d1}-${d2}`;
  }
  $('#doneBtn').disabled = busy || !(play.isComplete() && play.moveCount > 0);
  $('#undoBtn').disabled = busy || play.moveCount === 0;
  updateBoardActions();
}

function render() {
  const info = $('#matchInfo');
  const status = $('#playStatus');
  const meta = $('#playMeta');
  if (!match) {
    info.textContent = '';
    status.textContent = 'Start a match against the engine.';
    meta.textContent = '';
    setButtons([]);
    showBoard(startingBoard(), null);
    return;
  }
  const crawford = match.crawford ? ' • Crawford game' : '';
  info.innerHTML = '';
  info.append(`Match to `, make('strong', null, String(match.length)), ` points, `,
    make('span', 'score-blue', String(match.score.you)), ' : ', make('span', 'score-red', String(match.score.engine)), crawford);
  const { pr, rated, flagged } = match.stats;
  const rating = pr
    ? `PR ${pr.value.toFixed(1)} (${pr.label}) over ${rated} decision${rated === 1 ? '' : 's'}, ${flagged} flagged`
    : 'No rated decisions yet';
  meta.textContent = `You are ${colorOf('you')} • Engine and grading ${match.plies}-ply • ${rating}`;

  const board = match.ogid ? boardFromOgid(match.ogid) : startingBoard();
  switch (match.phase) {
  case 'human-turn':
    showBoard(board, null);
    status.textContent = 'Your turn: click the dice to roll, or the cube to double.';
    setButtons(['rollBtn', 'doubleBtn']);
    break;
  case 'human-move':
    showBoard(board, board.dice);
    moveInput.enable(match.legal);
    setButtons(['doneBtn', 'undoBtn']);
    updateMoveStatus();
    break;
  case 'human-respond':
    showBoard(board, null);
    status.textContent = `The engine doubles to ${match.offeredCube}. Take or pass?`;
    setButtons(['takeBtn', 'passBtn']);
    break;
  case 'game-over':
    showBoard(board, null);
    status.textContent = describeResult(match.result) + (match.nextCrawford ? ' Next is the Crawford game.' : '');
    setButtons(['nextGameBtn']);
    break;
  case 'match-over': {
    showBoard(board, null);
    const won = match.score.you > match.score.engine;
    const pr = match.stats.pr ? ` Your PR: ${match.stats.pr.value.toFixed(1)} (${match.stats.pr.label}).` : '';
    status.textContent = `${describeResult(match.result)} ${won ? 'You win the match!' : 'The engine wins the match.'}${pr}`;
    setButtons([]);
    break;
  }
  case 'thinking':
    showBoard(board, null);
    status.textContent = 'The engine is thinking…';
    setButtons([]);
    break;
  default:
    status.textContent = 'Start a new match.';
    setButtons([]);
  }
  updateBoardActions();
}

window.refreshPlayLabels = () => render();

// --- Actions ---

/** Show the engine's moves one by one before the final state. */
async function playEvents(events) {
  for (const event of events) {
    appendLog(event);
    if (event.type !== 'move') continue;
    const after = boardFromOgid(event.ogid);
    if (event.who === 'engine') {
      if (shownBoard) showBoard(shownBoard, event.dice);
      await sleep(ENGINE_PAUSE_MS / 2);
      showBoard(after, event.dice);
      await sleep(ENGINE_PAUSE_MS);
    } else if (event.forced) {
      showBoard(after, null);
      await sleep(ENGINE_PAUSE_MS / 2);
    } else {
      showBoard(after, null);
    }
  }
}

/** Show the events of the running action that are not shown yet. */
async function showProgress(state) {
  if (state.actionId !== seen.actionId) seen = { actionId: state.actionId, count: 0 };
  const fresh = state.events.slice(seen.count);
  seen.count = state.events.length;
  await playEvents(fresh);
}

/**
 * Follow an action until it is finished. Slow engine levels answer before
 * the action is done; the state is then polled for further progress.
 */
async function follow(state) {
  const started = Date.now();
  for (;;) {
    renderFeedback(state.feedback);
    await showProgress(state);
    if (!state.busy) return state;
    const seconds = Math.round((Date.now() - started) / 1000);
    $('#playStatus').textContent = seconds >= 2 ? `The engine is thinking… ${seconds} s` : 'The engine is thinking…';
    await sleep(POLL_MS);
    const { ok, status, payload } = await playFetch('play/state');
    if (!ok || !payload.match) throw new Error(payload.error || `Request failed (${status})`);
    state = payload.match;
  }
}

async function send(path, body) {
  if (busy) return;
  busy = true;
  moveInput.setActive(false);
  setButtons([]);
  updateBoardActions();
  $('#playStatus').textContent = 'The engine is thinking…';
  let error = null;
  try {
    const { ok, status, payload } = await playFetch(path, body);
    if (status === 404 && payload.error === 'Not found') {
      busy = false;
      showKeyForm('The access key was not accepted.');
      return;
    }
    if (!ok) throw new Error(payload.error || `Request failed (${status})`);
    match = await follow(payload.match);
    error = match.error;
  } catch (caught) {
    error = caught.message;
  }
  busy = false;
  render();
  if (error) $('#playStatus').textContent = `Something went wrong: ${error}`;
}

function act(type, extra = {}) {
  return send('play/action', { type, ...extra });
}

function startMatch(event) {
  event.preventDefault();
  const running = match && !['match-over', 'starting'].includes(match.phase);
  if (running && !window.confirm('Abandon the current match and start a new one?')) return;
  clear($('#playLog'));
  renderFeedback([]);
  shownBoard = null;
  const plies = Number($('#levelSelect').value);
  storeLevel(plies);
  send('play/new', { length: Number($('#lengthSelect').value), plies });
}

// --- Account and match history ---

function renderAccount() {
  $('#accountStatus').textContent = currentUser ? `Logged in as ${currentUser}.` : 'Playing without an account.';
  $('#historyBtn').hidden = !currentUser;
  $('#logoutBtn').hidden = !currentUser;
  $('#loginBtn').hidden = Boolean(currentUser);
  if (currentUser) $('#loginForm').hidden = true;
}

async function submitLogin(mode) {
  const name = $('#loginName').value.trim();
  const password = $('#loginPassword').value;
  const message = $('#loginMessage');
  if (!name || !password) {
    message.textContent = 'Enter a name and a password.';
    return;
  }
  const { ok, payload } = await playFetch(mode === 'register' ? 'play/register' : 'play/login', { name, password });
  if (!ok) {
    message.textContent = payload.error || 'That did not work.';
    return;
  }
  storeSession(payload.token);
  $('#loginPassword').value = '';
  $('#loginForm').hidden = true;
  // Any match in progress continues under the account.
  await loadState();
}

async function logout() {
  await playFetch('play/logout', {});
  storeSession('');
  currentUser = null;
  await loadState();
}

/** A table cell with the date above the time. */
function dateTimeCell(iso) {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const cell = make('td', 'history-when');
  cell.appendChild(make('div', null, date.toLocaleDateString(undefined, {
    day: '2-digit', month: '2-digit', year: sameYear ? undefined : '2-digit'
  })));
  cell.appendChild(make('div', null, date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })));
  return cell;
}

function downloadMat(entry) {
  return downloadMatchFile(entry.id);
}

async function showHistory() {
  const { ok, payload } = await playFetch('play/history');
  if (!ok) return;
  const rows = $('#historyRows');
  clear(rows);
  const matches = payload.matches || [];
  historyMatches = matches;
  $('#prChartBtn').hidden = !matches.some((entry) => entry.pr != null);
  const finished = matches.filter((entry) => entry.status === 'finished');
  const won = finished.filter((entry) => entry.score.you > entry.score.engine).length;
  const rated = matches.filter((entry) => entry.pr != null);
  const averagePr = rated.length ? rated.reduce((sum, entry) => sum + entry.pr, 0) / rated.length : null;
  $('#historySummary').textContent = matches.length
    ? `${matches.length} match${matches.length === 1 ? '' : 'es'}, ${won} of ${finished.length} finished won`
      + (averagePr != null ? ` • average PR ${averagePr.toFixed(1)}` : '')
    : 'No matches yet. Matches you play while logged in appear here.';
  for (const entry of matches) {
    const row = make('tr');
    const status = entry.status === 'finished'
      ? (entry.score.you > entry.score.engine ? 'won' : 'lost')
      : (entry.status === 'abandoned' ? 'abandoned' : 'playing');
    const mark = { won: 'W', lost: 'L', abandoned: '–', playing: '…' }[status];
    row.appendChild(dateTimeCell(entry.startedAt));
    row.appendChild(make('td', null, `${entry.length} pt · ${entry.plies}-ply`));
    const score = make('td', `history-${status}`, `${mark} ${entry.score.you}:${entry.score.engine}`);
    score.title = status;
    row.appendChild(score);
    row.appendChild(make('td', null, entry.pr != null ? entry.pr.toFixed(1) : '–'));
    row.appendChild(make('td', null, `${entry.flagged}/${entry.rated}`));
    const cell = make('td', 'history-actions');
    const reviewLink = make('a', 'link-button', 'Review');
    reviewLink.href = `review.html?id=${encodeURIComponent(entry.id)}`;
    reviewLink.title = 'Step through this match';
    cell.appendChild(reviewLink);
    const button = make('button', 'link-button', '.mat');
    button.type = 'button';
    button.title = 'Download the match for XG or gnubg';
    button.addEventListener('click', () => downloadMat(entry));
    cell.appendChild(button);
    row.appendChild(cell);
    rows.appendChild(row);
  }
  $('#playPanel').hidden = true;
  $('#historyView').hidden = false;
}

function drawChart() {
  drawPrChart($('#prChart'), historyMatches);
}

function showPrChart() {
  $('#prChartDialog').hidden = false;
  // Draw once the dialog has its size.
  requestAnimationFrame(drawChart);
  $('#prChartCloseBtn').focus();
}

function hidePrChart() {
  $('#prChartDialog').hidden = true;
  $('#prChartBtn').focus();
}

function hideHistory() {
  $('#historyView').hidden = true;
  $('#playPanel').hidden = false;
}

// --- Setup ---

function showKeyForm(message) {
  $('#playPanel').hidden = true;
  $('#keyForm').hidden = false;
  const label = $('#keyForm label');
  label.textContent = message || 'Access key';
  $('#keyInput').focus();
}

async function loadState() {
  const { ok, status, payload } = await playFetch('play/state');
  if (status === 404) {
    showKeyForm(storedKey() ? 'The access key was not accepted.' : 'Access key');
    return;
  }
  if (!ok) {
    $('#playPanel').hidden = false;
    $('#playStatus').textContent = `Could not load: ${payload.error || status}`;
    return;
  }
  $('#keyForm').hidden = true;
  $('#playPanel').hidden = false;
  currentUser = payload.user || null;
  // A login that the server no longer knows (e.g. after logging out elsewhere).
  if (!currentUser && storedSession()) storeSession('');
  renderAccount();
  matchLengths = payload.matchLengths || [];
  const select = $('#lengthSelect');
  clear(select);
  for (const length of matchLengths) {
    const option = make('option', null, String(length));
    option.value = String(length);
    if (length === 7) option.selected = true;
    select.appendChild(option);
  }
  const levels = $('#levelSelect');
  clear(levels);
  // A saved level above the server's limit falls back to the default.
  const allowed = payload.levels || [];
  const saved = storedLevel(payload.defaultLevel);
  const preferred = allowed.includes(saved) ? saved : payload.defaultLevel;
  for (const level of allowed) {
    const option = make('option', null, LEVEL_LABELS[level] || `${level}-ply`);
    option.value = String(level);
    if (level === preferred) option.selected = true;
    levels.appendChild(option);
  }
  match = payload.match;
  // After a reload, earlier events are not replayed.
  if (match) seen = { actionId: match.actionId, count: match.events.length };
  render();
  if (match?.busy) {
    busy = true;
    try {
      match = await follow(match);
    } catch (error) {
      match = { ...match, error: error.message };
    }
    busy = false;
    render();
    if (match.error) $('#playStatus').textContent = `Something went wrong: ${match.error}`;
  }
}

function bindEvents() {
  moveInput = new MoveInput({ onChange: updateMoveStatus });
  $('#keyForm').addEventListener('submit', (event) => {
    event.preventDefault();
    storeKey($('#keyInput').value.trim());
    loadState();
  });
  $('#setupForm').addEventListener('submit', startMatch);
  $('#loginBtn').addEventListener('click', () => {
    $('#loginForm').hidden = false;
    $('#loginName').focus();
  });
  $('#loginCancelBtn').addEventListener('click', () => { $('#loginForm').hidden = true; });
  $('#loginForm').addEventListener('submit', (event) => {
    event.preventDefault();
    submitLogin('login');
  });
  $('#registerBtn').addEventListener('click', () => submitLogin('register'));
  $('#logoutBtn').addEventListener('click', logout);
  $('#historyBtn').addEventListener('click', showHistory);
  $('#historyCloseBtn').addEventListener('click', hideHistory);
  $('#prChartBtn').addEventListener('click', showPrChart);
  $('#prChartCloseBtn').addEventListener('click', hidePrChart);
  $('#prChartDialog').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) hidePrChart();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#prChartDialog').hidden) hidePrChart();
  });
  window.addEventListener('resize', () => {
    if (!$('#prChartDialog').hidden) drawChart();
  });
  $('#rollBtn').addEventListener('click', () => act('roll'));
  $('#doubleBtn').addEventListener('click', () => act('double'));
  $('#takeBtn').addEventListener('click', () => act('take'));
  $('#passBtn').addEventListener('click', () => act('pass'));
  $('#nextGameBtn').addEventListener('click', () => act('next-game'));
  $('#undoBtn').addEventListener('click', () => moveInput.undo());
  $('#dice').addEventListener('click', onDiceClick);
  $('#cube').addEventListener('click', onCubeClick);
  $('#doneBtn').addEventListener('click', () => {
    const play = moveInput.play;
    if (play?.isComplete()) act('move', { key: play.finalKey() });
  });
}

async function init() {
  bindEvents();
  showBoard(startingBoard(), null);
  await loadState();
}

document.addEventListener('DOMContentLoaded', init);
