/* A friendly match between two people. The first two browsers that open this
   page take the two seats; the server rolls the dice and grades both players.
   Each player sees the board from their own side: "me" is always drawn as
   player1 (blue), the friend as player2 (red). The page polls the state, so
   it follows the friend's moves. */
import { $, $$, make, clear, MoveInput } from './boardView.js';
import { bindFastMoveToggle, bindShortcuts } from './gameControls.js';
import { playFetch, storedKey, storeKey } from './playClient.js';
import { initSplitter } from './splitter.js';
import { renderCubeAnalysis, renderMoveAnalysis, signed } from './analysisView.js';

const NAME_STORAGE = 'bgFriendName';
const POLL_MS = 1000;

let table = null;
let moveInput = null;
let sending = false;
let shownMatch = '';
let shownPlayers = '';
let shownLobby = '';
let shownGame = null;
let lastSeq = 0;
let historyOpen = false;
// The luck of each player's latest roll, for the log line of the move that follows.
const rollLuck = {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const other = (seat) => (seat === 'player1' ? 'player2' : 'player1');

function storedName() {
  try {
    return window.localStorage.getItem(NAME_STORAGE) || '';
  } catch {
    return '';
  }
}

function storeName(name) {
  try {
    window.localStorage.setItem(NAME_STORAGE, name);
  } catch {
    // the name is asked for again next time
  }
}

function isClassic() {
  return document.documentElement.getAttribute('data-theme') === 'classic';
}

/** "me" plays the blue (classic: black) checkers, the friend red (white). */
function colorOf(seat) {
  const mine = seat === table?.you;
  if (mine) return isClassic() ? 'Black' : 'Blue';
  return isClassic() ? 'White' : 'Red';
}

function nameOf(seat) {
  return table?.match?.names?.[seat] || table?.seats?.[seat]?.name || (seat === table?.you ? 'You' : 'Your friend');
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

/**
 * A board from an OGID, seen from `viewer`'s side: the viewer becomes
 * player1, so their checkers are drawn at the bottom and numbered for them.
 */
function boardFor(ogid, viewer) {
  const board = window.ogidCodec.decodeOgid(ogid);
  if (viewer === 'player1') return { ...board, turn: 'player1' };
  const swap = (seat) => (seat === 'player1' ? 'player2' : (seat === 'player2' ? 'player1' : seat));
  return {
    ...board,
    points: { player1: board.points.player2, player2: board.points.player1 },
    score: { player1: board.score.player2, player2: board.score.player1 },
    cubeOwner: swap(board.cubeOwner),
    turn: 'player1'
  };
}

// --- Rendering ---

function playerCard(seat) {
  const seatInfo = table.seats[seat];
  const match = table.match;
  const mine = seat === table.you;
  const card = make('div', `friend-player ${mine ? 'mine' : 'theirs'}`);
  const head = make('div', 'friend-player-head');
  head.appendChild(make('span', `friend-dot ${mine ? 'score-blue' : 'score-red'}`, '●'));
  head.appendChild(make('strong', null, seatInfo ? seatInfo.name : 'Waiting…'));
  if (mine) head.appendChild(make('span', 'meta', ' (you)'));
  if (seatInfo && !seatInfo.online) head.appendChild(make('span', 'meta', ' offline'));
  card.appendChild(head);
  if (match) {
    card.appendChild(make('div', 'friend-score', `${match.score[seat]}`));
    const stats = match.stats[seat];
    const pr = stats.pr ? `${stats.pr.value.toFixed(1)}` : '–';
    const rows = make('div', 'friend-stats');
    const stat = (label, value, title, extraClass = '') => {
      const cell = make('div', `friend-stat ${extraClass}`);
      cell.title = title;
      cell.appendChild(make('span', 'friend-stat-label', label));
      cell.appendChild(make('span', 'friend-stat-value', value));
      rows.appendChild(cell);
    };
    stat('PR', pr, stats.pr ? `${stats.pr.label}, over ${stats.rated} rated decisions (lower is better)` : 'No rated decisions yet');
    const luckClass = stats.luck > 0.005 ? 'lucky' : (stats.luck < -0.005 ? 'unlucky' : '');
    stat('Luck', signed(stats.luck, 2), `Equity won (+) or lost (−) by the dice over ${stats.rolls} rolls`, luckClass);
    card.appendChild(rows);
    const awesome = make('div', 'friend-awesome', `Awesome: ${stats.awesome}, best: ${stats.bestAwesome}`);
    awesome.title = 'Best checker plays in a row (moves without a real choice do not count), and the longest such run in this match';
    card.appendChild(awesome);
    const label = stats.pr ? `${stats.pr.label} • ` : '';
    card.appendChild(make('div', 'meta friend-pr-label',
      `${label}${stats.flagged} flagged of ${stats.decisions} decision${stats.decisions === 1 ? '' : 's'}`));
  } else if (seatInfo?.wantLength) {
    card.appendChild(make('div', 'meta', `wants a ${seatInfo.wantLength}-point match`));
  }
  return card;
}

function renderPlayers() {
  const key = JSON.stringify([table.you, table.seats, table.match?.stats, table.match?.score, isClassic()]);
  if (key === shownPlayers) return;
  shownPlayers = key;
  const box = $('#friendPlayers');
  clear(box);
  // Your own card first.
  const order = table.you === 'player2' ? ['player2', 'player1'] : ['player1', 'player2'];
  order.forEach((seat) => box.appendChild(playerCard(seat)));
}

function renderLobby() {
  const match = table.match;
  const show = !match || match.phase === 'match-over';
  $('#lobby').hidden = !show;
  if (!show) return;
  const friend = table.seats[other(table.you)];
  const mine = table.seats[table.you];
  // Only redraw on a change, so a click never lands on a button that is being replaced.
  const key = JSON.stringify([match?.id, friend?.name, friend?.wantLength, mine?.wantLength]);
  if (key === shownLobby) return;
  shownLobby = key;
  $('#lobbyStatus').textContent = match
    ? `${matchOverText(match)} Another match? Choose the length.`
    : (friend ? 'Choose the match length.' : 'Waiting for your friend to open this page…');
  const buttons = $('#lengthButtons');
  clear(buttons);
  for (const length of table.lengths) {
    const button = make('button', mine?.wantLength === length ? 'friend-length chosen' : 'friend-length secondary', `${length} points`);
    button.type = 'button';
    if (friend?.wantLength === length) button.appendChild(make('span', 'friend-length-tag', `${friend.name} ✓`));
    button.addEventListener('click', () => send('friend/length', { length }));
    buttons.appendChild(button);
  }
  $('#lobbyMeta').textContent = friend?.wantLength && mine?.wantLength && friend.wantLength !== mine.wantLength
    ? `${friend.name} chose ${friend.wantLength} points.`
    : 'The match starts as soon as you both chose the same length.';
}

function setButtons(visible) {
  for (const id of ['rollBtn', 'doubleBtn', 'doneBtn', 'undoBtn', 'takeBtn', 'passBtn', 'nextGameBtn']) {
    const button = $(`#${id}`);
    button.hidden = !visible.includes(id);
    button.disabled = sending;
  }
}

function canRoll() {
  const match = table?.match;
  return !sending && match?.phase === 'turn' && match.onTurn === table.you;
}

function updateBoardActions() {
  const boardEl = $('#board');
  const play = moveInput.play;
  const rollable = canRoll();
  const canFinish = !sending && table?.match?.phase === 'move' && table.match.onTurn === table.you
    && Boolean(play?.isComplete() && play.moveCount > 0);
  boardEl.classList.toggle('can-roll', rollable);
  boardEl.classList.toggle('can-double', rollable);
  boardEl.classList.toggle('can-finish', canFinish);
  const dice = $('#dice');
  $$('#dice .die.ready').forEach((die) => die.remove());
  if (rollable) {
    dice.appendChild(make('div', 'die ready'));
    dice.appendChild(make('div', 'die ready'));
  }
  dice.title = rollable ? 'Roll' : (canFinish ? 'Finish the move' : '');
}

function updateMoveStatus() {
  const match = table?.match;
  const play = moveInput.play;
  if (!play || match?.phase !== 'move' || match.onTurn !== table.you) return;
  const [d1, d2] = match.legal.dice;
  if (play.isComplete() && play.moveCount > 0) $('#playStatus').textContent = `Your move: ${play.finalMove()}`;
  else if (play.moveCount > 0) $('#playStatus').textContent = `Dice left: ${play.remaining.join(' ')}`;
  else $('#playStatus').textContent = `Your roll: ${d1}-${d2}`;
  $('#doneBtn').disabled = sending || !(play.isComplete() && play.moveCount > 0);
  $('#undoBtn').disabled = sending || play.moveCount === 0;
  updateBoardActions();
}

function describeResult(result) {
  const points = `${result.points} point${result.points === 1 ? '' : 's'}`;
  const winner = result.winner === table.you ? 'You win' : `${nameOf(result.winner)} wins`;
  if (result.kind === 'pass') {
    const loser = other(result.winner) === table.you ? 'You pass' : `${nameOf(other(result.winner))} passes`;
    return `${loser}. ${winner} ${points}.`;
  }
  const how = { gammon: ' a gammon', backgammon: ' a backgammon' }[result.kind] || '';
  return `${winner}${how}: ${points}.`;
}

function matchOverText(match) {
  const winner = match.score.player1 > match.score.player2 ? 'player1' : 'player2';
  const score = `${match.score[winner]}:${match.score[other(winner)]}`;
  return winner === table.you ? `You win the match ${score}!` : `${nameOf(winner)} wins the match ${score}.`;
}

function describeEvent(event) {
  const who = event.who ? nameOf(event.who) : '';
  switch (event.type) {
  case 'opening': {
    const { player1, player2 } = event.dice;
    return `Opening roll: ${nameOf('player1')} ${player1}, ${nameOf('player2')} ${player2}. ${nameOf(event.starter)} starts.`;
  }
  case 'roll':
    rollLuck[event.who] = event.luck;
    return null;
  case 'move': {
    const dice = event.dice ? ` (${event.dice.die1}-${event.dice.die2})` : '';
    const luck = rollLuck[event.who];
    const luckText = luck != null && Math.abs(luck) >= 0.005 ? ` • luck ${signed(luck, 2)}` : '';
    return `${who}${dice}: ${event.move || 'cannot move'}${event.forced ? ' (forced)' : ''}${luckText}`;
  }
  case 'double':
    return `${who} doubles to ${event.cube}.`;
  case 'take':
    return `${who} takes.`;
  case 'pass':
    return `${who} passes.`;
  case 'game-over':
    return describeResult(event);
  default:
    return null;
  }
}

function renderLog(match) {
  const log = $('#playLog');
  if (match.gameNumber !== shownGame) {
    clear(log);
    shownGame = match.gameNumber;
    lastSeq = 0;
  }
  for (const event of match.events) {
    if (event.seq <= lastSeq) continue;
    lastSeq = event.seq;
    const text = describeEvent(event);
    if (!text) continue;
    log.appendChild(make('li', `play-log-${event.who === table.you ? 'you' : (event.who ? 'engine' : 'info')}`, text));
  }
  log.scrollTop = log.scrollHeight;
}

function markButton(item) {
  const button = make('button', 'link-button mark-button', item.marked ? '★ Marked' : '☆ Mark');
  button.type = 'button';
  button.setAttribute('aria-pressed', String(item.marked));
  button.title = item.marked ? 'Click to unmark' : 'Keep this position to look at it after the match';
  button.addEventListener('click', async () => {
    button.disabled = true;
    const { ok, payload } = await playFetch('friend/mark', { id: item.id, marked: !item.marked });
    if (ok) {
      item.marked = payload.marked;
      button.textContent = item.marked ? '★ Marked' : '☆ Mark';
      button.setAttribute('aria-pressed', String(item.marked));
    }
    button.disabled = false;
  });
  return button;
}

/** The latest graded decisions of both players: both see each other's mistakes. */
function renderFeedback(match) {
  const container = $('#playFeedback');
  clear(container);
  const order = table.you === 'player2' ? ['player2', 'player1'] : ['player1', 'player2'];
  for (const seat of order) {
    for (const item of match.recent[seat].filter((entry) => entry.grade)) {
      const row = make('div', `play-flag ${item.grade}`);
      const label = window.analysisText?.gradeLabel(item.loss) || item.grade;
      const who = seat === table.you ? 'You' : nameOf(seat);
      row.appendChild(make('strong', null, `${who}: ${label} (−${item.loss.toFixed(3)})`));
      const what = item.kind === 'move' ? ` Played ${item.action}.` : ` Chose ${item.action}.`;
      row.appendChild(make('span', null, `${what}${item.best ? ` Best: ${item.best}.` : ''}`));
      row.appendChild(markButton(item));
      container.appendChild(row);
    }
  }
}

function renderGame() {
  const match = table.match;
  const view = $('#gameView');
  view.hidden = !match;
  if (!match) {
    $('#matchInfo').textContent = '';
    if (!historyOpen) moveInput.show(startingBoard(), null);
    return;
  }
  const crawford = match.crawford ? ' • Crawford game' : '';
  const info = $('#matchInfo');
  clear(info);
  const me = table.you || 'player1';
  info.append('Match to ', make('strong', null, String(match.length)), ' points, ',
    make('span', 'score-blue', String(match.score[me])), ' : ', make('span', 'score-red', String(match.score[other(me)])), crawford);
  renderLog(match);
  renderFeedback(match);
  if (historyOpen) return;

  const board = match.ogid ? boardFor(match.ogid, me) : startingBoard();
  const mine = match.onTurn === table.you;
  const friend = nameOf(other(me));
  const status = $('#playStatus');
  switch (match.phase) {
  case 'turn':
    moveInput.show(board, null);
    status.textContent = mine ? 'Your turn: roll (R) or double.' : `${friend}'s turn.`;
    setButtons(mine ? ['rollBtn', 'doubleBtn'] : []);
    break;
  case 'move':
    moveInput.show(board, board.dice);
    if (mine && match.legal) {
      moveInput.enable(match.legal);
      setButtons(['doneBtn', 'undoBtn']);
      updateMoveStatus();
    } else {
      status.textContent = `${friend} rolled ${match.dice.die1}-${match.dice.die2} and is moving.`;
      setButtons([]);
    }
    break;
  case 'respond':
    moveInput.show(board, null);
    if (match.offer.to === table.you) {
      status.textContent = `${friend} doubles to ${match.offer.cube}. Take or pass?`;
      setButtons(['takeBtn', 'passBtn']);
    } else {
      status.textContent = `You double to ${match.offer.cube}. Waiting for ${friend}.`;
      setButtons([]);
    }
    break;
  case 'game-over':
    moveInput.show(board, null);
    status.textContent = describeResult(match.result) + (match.nextCrawford ? ' Next is the Crawford game.' : '');
    setButtons(['nextGameBtn']);
    break;
  case 'match-over':
    // The result is shown above, with the choice of the next match length.
    moveInput.show(board, null);
    status.textContent = '';
    setButtons([]);
    break;
  default:
    moveInput.show(board, null);
    status.textContent = 'Analysing…';
    setButtons([]);
  }
  updateBoardActions();
  if (match.error) status.textContent = `Something went wrong: ${match.error}. Please try again.`;
}

/** Render a new state; the board is only redrawn when the match changed, so a move in progress stays. */
function render(force = false) {
  if (!table) return;
  const seated = Boolean(table.you);
  $('#joinForm').hidden = seated;
  $('#friendPanel').hidden = !seated || historyOpen;
  if (!seated) {
    const full = table.seats.player1 && table.seats.player2;
    $('#joinMessage').textContent = full
      ? `${table.seats.player1.name} and ${table.seats.player2.name} are playing. A seat frees up when a player leaves or is away for two minutes.`
      : '';
    return;
  }
  renderPlayers();
  renderLobby();
  const match = table.match;
  const key = match
    ? JSON.stringify([match.id, match.phase, match.ogid, match.onTurn, match.busy, match.error, match.events.length,
      match.recent, match.score, match.offer])
    : 'none';
  if (!force && key === shownMatch) return;
  shownMatch = key;
  renderGame();
}

window.refreshPlayLabels = () => {
  shownPlayers = '';
  render(true);
};

// --- Talking to the server ---

function showKeyForm(message) {
  $('#friendPanel').hidden = true;
  $('#joinForm').hidden = true;
  $('#keyForm').hidden = false;
  $('#keyForm label').textContent = message || 'Access key';
  $('#keyInput').focus();
}

async function send(path, body) {
  if (sending) return;
  sending = true;
  moveInput.setActive(false);
  setButtons([]);
  updateBoardActions();
  try {
    const { ok, status, payload } = await playFetch(path, body);
    if (status === 404 && payload.error === 'Not found') {
      showKeyForm('The access key was not accepted.');
      return;
    }
    if (!ok) throw new Error(payload.error || `Request failed (${status})`);
    table = payload;
  } catch (error) {
    sending = false;
    shownMatch = '';
    render();
    $('#playStatus').textContent = `Something went wrong: ${error.message}`;
    return;
  }
  sending = false;
  shownMatch = '';
  render();
}

function act(type, extra = {}) {
  return send('friend/action', { type, ...extra });
}

async function poll() {
  for (;;) {
    if (!sending && $('#keyForm').hidden) {
      const { ok, status, payload } = await playFetch('friend/state').catch(() => ({ ok: false }));
      if (status === 404) {
        showKeyForm(storedKey() ? 'The access key was not accepted.' : 'Access key');
      } else if (ok && !sending) {
        table = payload;
        render();
      }
    }
    await sleep(POLL_MS);
  }
}

async function join(name) {
  const { ok, status, payload } = await playFetch('friend/join', { name });
  if (status === 404) {
    showKeyForm('The access key was not accepted.');
    return;
  }
  if (!ok) {
    $('#joinForm').hidden = false;
    $('#joinMessage').textContent = payload.error || `Could not sit down (${status})`;
    return;
  }
  storeName(name);
  table = payload;
  shownMatch = '';
  shownPlayers = '';
  render();
}

async function start() {
  const { ok, status, payload } = await playFetch('friend/state');
  if (status === 404) {
    showKeyForm(storedKey() ? 'The access key was not accepted.' : 'Access key');
    return;
  }
  $('#keyForm').hidden = true;
  if (!ok) {
    $('#joinForm').hidden = false;
    $('#joinMessage').textContent = `Could not load: ${payload.error || status}`;
    return;
  }
  table = payload;
  // Sit down again under the remembered name (e.g. after a reload or a server restart).
  const name = storedName();
  if (!table.you && name) await join(name);
  else render();
  $('#nameInput').value = storedName();
}

// --- History of our matches and the marked positions ---

let history = null;
let shownMarked = null;
const analysisCache = new Map();

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

async function showHistory() {
  historyOpen = true;
  $('#friendPanel').hidden = true;
  $('#historyView').hidden = false;
  $('#markedView').hidden = true;
  $('#historySummary').textContent = 'Loading…';
  const { ok, payload, status } = await playFetch('friend/history');
  if (!ok) {
    $('#historySummary').textContent = `Could not load the matches (${payload.error || status}).`;
    return;
  }
  history = payload;
  const list = $('#historyList');
  clear(list);
  const wins = {};
  const pr = (value) => (value == null ? '–' : value.toFixed(1));
  for (const match of history.matches) {
    const winner = match.player1.score > match.player2.score ? match.player1 : match.player2;
    wins[winner.name] = (wins[winner.name] || 0) + 1;
    const item = make('div', 'friend-history-item');
    item.appendChild(make('div', 'meta', `${formatDate(match.finishedAt)} • ${match.length}-point match`));
    const grid = make('div', 'friend-history-grid');
    for (const side of [match.player1, match.player2]) {
      const won = side === winner;
      grid.appendChild(make('strong', won ? 'friend-history-winner' : null, `${side.name}${won ? ' ✓' : ''}`));
      grid.appendChild(make('span', 'friend-history-score', String(side.score)));
      grid.appendChild(make('span', null, `PR ${pr(side.pr)}`));
      const luck = make('span', side.luck > 0.005 ? 'lucky' : (side.luck < -0.005 ? 'unlucky' : null), `Luck ${signed(side.luck, 2)}`);
      grid.appendChild(luck);
    }
    item.appendChild(grid);
    if (match.marked.length) {
      const marked = make('div', 'friend-history-marked');
      marked.appendChild(make('span', 'meta', 'Marked: '));
      match.marked.forEach((entry) => {
        const button = make('button', 'link-button', `${entry.name}: ${entry.action}`);
        button.type = 'button';
        button.title = `Lost ${entry.loss.toFixed(3)}; best ${entry.best}`;
        button.addEventListener('click', () => showMarked(match, entry));
        marked.appendChild(button);
      });
      item.appendChild(marked);
    }
    list.appendChild(item);
  }
  const tally = Object.entries(wins).map(([name, count]) => `${name} ${count}`).join(', ');
  $('#historySummary').textContent = history.matches.length
    ? `${history.matches.length} match${history.matches.length === 1 ? '' : 'es'}. Won: ${tally}.`
    : 'No finished matches yet.';
  const depth = $('#depthSelect');
  clear(depth);
  for (let plies = 1; plies <= history.analysis.maxPlies; plies++) {
    const option = make('option', null, `${plies}-ply`);
    option.value = String(plies);
    option.selected = plies === history.analysis.plies;
    depth.appendChild(option);
  }
}

function hideHistory() {
  historyOpen = false;
  $('#historyView').hidden = true;
  shownMatch = '';
  shownMarked = null;
  render(true);
}

/** A marked decision: its position on the board, from the deciding player's side. */
function showMarked(match, item) {
  shownMarked = item;
  const board = window.ogidCodec.decodeOgid(item.ogid);
  moveInput.show(boardFor(item.ogid, board.turn), board.dice);
  $('#markedView').hidden = false;
  $('#markedTitle').textContent = `${item.name}: ${item.action}`;
  $('#markedMeta').textContent = `${formatDate(match.finishedAt)} • ${item.kind === 'move' ? 'Checker play' : 'Cube decision'}, `
    + `lost ${item.loss.toFixed(3)}. Best: ${item.best}.`;
  $('#analysisStatus').textContent = '';
  clear($('#analysisResults'));
  const cached = analysisCache.get(`${item.ogid}|${$('#depthSelect').value}`);
  if (cached) showAnalysis(item, cached);
}

function showAnalysis(item, result) {
  const results = $('#analysisResults');
  clear(results);
  results.appendChild(result.kind === 'move'
    ? renderMoveAnalysis(result, { marks: [[item.action, item.name]] })
    : renderCubeAnalysis(result));
}

async function analyseMarked() {
  const item = shownMarked;
  if (!item) return;
  const plies = Number($('#depthSelect').value);
  const kind = item.kind === 'move' ? 'move' : 'cube';
  const status = $('#analysisStatus');
  status.textContent = 'Working…';
  $('#analyseBtn').disabled = true;
  try {
    const { ok, payload, status: code } = await playFetch('friend/analysis', {
      kind, ogid: item.ogid, played: kind === 'move' ? item.action : undefined, plies
    });
    if (!ok) throw new Error(payload.error || `Analysis failed (${code})`);
    analysisCache.set(`${item.ogid}|${plies}`, payload);
    status.textContent = '';
    if (shownMarked === item) showAnalysis(item, payload);
  } catch (error) {
    status.textContent = `Could not analyse: ${error.message}`;
  } finally {
    $('#analyseBtn').disabled = false;
  }
}

// --- Setup ---

function bindEvents() {
  moveInput = new MoveInput({ onChange: updateMoveStatus });
  initSplitter({
    layout: $('.layout'), splitter: $('#friendSplitter'), board: $('.board-area'),
    storageKey: 'bgFriendBoardWidth', minBoard: 360, minPanel: 300
  });
  bindFastMoveToggle(moveInput);
  bindShortcuts(() => historyOpen);
  $('#keyForm').addEventListener('submit', (event) => {
    event.preventDefault();
    storeKey($('#keyInput').value.trim());
    start();
  });
  $('#joinForm').addEventListener('submit', (event) => {
    event.preventDefault();
    join($('#nameInput').value.trim());
  });
  $('#renameBtn').addEventListener('click', () => {
    const name = window.prompt('Your name', storedName());
    if (name && name.trim()) join(name.trim());
  });
  $('#leaveBtn').addEventListener('click', () => {
    const running = table?.match && table.match.phase !== 'match-over';
    if (running && !window.confirm('Leave the table? The running match ends and is not recorded.')) return;
    send('friend/leave');
  });
  $('#historyBtn').addEventListener('click', showHistory);
  $('#historyCloseBtn').addEventListener('click', hideHistory);
  $('#analyseBtn').addEventListener('click', analyseMarked);
  $('#rollBtn').addEventListener('click', () => act('roll'));
  $('#doubleBtn').addEventListener('click', () => act('double'));
  $('#takeBtn').addEventListener('click', () => act('take'));
  $('#passBtn').addEventListener('click', () => act('pass'));
  $('#nextGameBtn').addEventListener('click', () => act('next-game'));
  $('#undoBtn').addEventListener('click', () => moveInput.undo());
  $('#doneBtn').addEventListener('click', () => {
    const play = moveInput.play;
    if (play?.isComplete()) act('move', { key: play.finalKey() });
  });
  $('#dice').addEventListener('click', () => {
    if (canRoll()) {
      act('roll');
      return;
    }
    const play = moveInput.play;
    if (!sending && table?.match?.phase === 'move' && play?.isComplete() && play.moveCount > 0) {
      act('move', { key: play.finalKey() });
    }
  });
  $('#cube').addEventListener('click', () => {
    if (canRoll()) act('double');
  });
}

async function init() {
  bindEvents();
  moveInput.show(startingBoard(), null);
  await start();
  poll();
}

document.addEventListener('DOMContentLoaded', init);
