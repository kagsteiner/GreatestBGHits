/* A friendly match between two people. The first two browsers that open this
   page take the two seats; the server rolls the dice and grades both players.
   A player's name is their seat: under it they come back from any browser.
   Each player sees the board from their own side: "me" is always drawn as
   player1 (blue), the friend as player2 (red). The page polls the state, so
   it follows the friend's moves. */
import { $, make, clear } from './boardView.js';
import { initBoardPage } from './boardPage.js';
import {
  boardFor, createKeyForm, createMatchControls, flagRow, markButton, resultText, showScore, sleep, startingBoard
} from './matchPage.js';
import { playFetch, positionRequest } from './playClient.js';
import { checkersMoved, initSounds, playAwesome, playChecker, playCheckers, playDice } from './sounds.js';
import { signed } from './analysisView.js';
import { createAnalysisPanel } from './analysisPanel.js';

const NAME_STORAGE = 'bgFriendName';
const POLL_MS = 1000;
// While the friend is moving, so that their checkers do not lag behind.
const WATCH_POLL_MS = 350;

const page = initBoardPage({ subtitle: 'friendly match' });

let table = null;
let sending = false;
let shownMatch = '';
let shownPlayers = '';
let shownLobby = '';
let shownGame = null;
let shownMatchId = null;
let lastSeq = 0;
let historyOpen = false;
// Sounds: none for the events already there when the page opens; the dice of
// your own roll sound when you click, not again when the server's answer
// arrives; a click for each checker you place (counted by shownMoveCount).
let soundsLive = false;
let ownRollPending = false;
let shownMoveCount = 0;
// The checkers placed in the friend's move in progress: they clicked already, so not again at the end.
let heardTentative = 0;
const DICE_PAUSE_MS = 700;
const CHECKER_GAP_MS = 180;
const AWESOME_PAUSE_MS = 1300;

const other = (seat) => (seat === 'player1' ? 'player2' : 'player1');

const { moveInput, setButtons, updateBoardActions, updateMoveStatus } = createMatchControls({
  act,
  busy: () => sending,
  canRoll: () => table?.match?.phase === 'turn' && table.match.onTurn === table.you,
  legal: () => (table?.match?.phase === 'move' && table.match.onTurn === table.you ? table.match.legal : null),
  onPlayChange: (play) => {
    if (play.moveCount > shownMoveCount) playChecker();
    shownMoveCount = play.moveCount;
    // Also when your move starts (again, after a reload): the friend sees that too.
    reportTentative();
  },
  paused: () => historyOpen
});
const showKeyForm = createKeyForm({ replaces: ['#friendPanel', '#joinForm'], onKey: start });

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

function nameOf(seat) {
  return table?.match?.names?.[seat] || table?.seats?.[seat]?.name || (seat === table?.you ? 'You' : 'Your friend');
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
  if (mine) head.appendChild(make('span', 'friend-player-note', ' (you)'));
  if (seatInfo && !seatInfo.online) head.appendChild(make('span', 'friend-player-note', ' offline'));
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
  const key = JSON.stringify([table.you, table.seats, table.match?.stats, table.match?.score]);
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
  const key = JSON.stringify([match?.id, friend?.name, friend?.wantLength, mine?.wantLength, table.notice, table.adjourned]);
  if (key === shownLobby) return;
  shownLobby = key;
  const notice = table.notice
    ? `${table.notice.by === table.you ? 'You aborted the match.' : table.notice.text} `
    : '';
  $('#lobbyStatus').textContent = match
    ? `${matchOverText(match)} Another match? Choose the length.`
    : `${notice}${friend ? 'Choose the match length.' : 'Waiting for your friend to open this page…'}${adjournedText(mine?.name)}`;
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

/** The saved matches of `name` (all, without one), and that they go on when both sit down. */
function adjournedText(name) {
  const mine = (open) => !name || [open.names.player1, open.names.player2].some((player) => player.toLowerCase() === name.toLowerCase());
  const matches = (table.adjourned || []).filter(mine);
  if (!matches.length) return '';
  const list = matches.map((open) => `${open.names.player1} ${open.score.player1} : ${open.score.player2} ${open.names.player2} (${open.length} points)`);
  return ` Saved: ${list.join(', ')}. A saved match goes on as soon as both players sit down under these names.`;
}

function describeResult(result) {
  return resultText(result, result.winner === table.you, nameOf(other(table.you)));
}

function matchOverText(match) {
  const winner = match.score.player1 > match.score.player2 ? 'player1' : 'player2';
  const score = `${match.score[winner]}:${match.score[other(winner)]}`;
  return winner === table.you ? `You win the match ${score}!` : `${nameOf(winner)} wins the match ${score}.`;
}

/** " ⚑ big blunder" for a decision graded as a mistake, as in the match review. */
function flagText(event) {
  if (!event.grade) return '';
  return ` ⚑ ${(window.analysisText?.gradeLabel(event.loss) || event.grade).toLowerCase()}`;
}

function describeEvent(event) {
  const who = event.who ? nameOf(event.who) : '';
  const flag = flagText(event);
  switch (event.type) {
  case 'opening': {
    const { player1, player2 } = event.dice;
    return `Opening roll: ${nameOf('player1')} ${player1}, ${nameOf('player2')} ${player2}. ${nameOf(event.starter)} starts.`;
  }
  case 'move': {
    const dice = event.dice ? ` (${event.dice.die1}-${event.dice.die2})` : '';
    return `${who}${dice}: ${event.move || 'cannot move'}${event.forced ? ' (forced)' : ''}${flag}`;
  }
  case 'no-double':
    return flag ? `${who} did not double.${flag}` : null;
  case 'double':
    return `${who} doubles to ${event.cube}.`;
  case 'double-graded':
    return `${who}'s double:${flag}`;
  case 'take':
    return `${who} takes.${flag}`;
  case 'pass':
    return `${who} passes.${flag}`;
  case 'game-over':
    return describeResult(event);
  default:
    return null;
  }
}

function renderLog(match) {
  const log = $('#playLog');
  // A saved match going on brings its past along: that makes no sounds.
  const past = match.id !== shownMatchId && match.resumed;
  if (match.id !== shownMatchId || match.gameNumber !== shownGame) {
    clear(log);
    shownMatchId = match.id;
    shownGame = match.gameNumber;
    lastSeq = 0;
  }
  // Sounds of the new events, one after the other.
  let delay = 0;
  for (const event of match.events) {
    if (event.seq <= lastSeq) continue;
    lastSeq = event.seq;
    if (soundsLive && !past) delay = eventSound(event, delay);
    const text = describeEvent(event);
    if (!text) continue;
    log.appendChild(make('li', `play-log-${event.who === table.you ? 'you' : (event.who ? 'engine' : 'info')}`, text));
  }
  log.scrollTop = log.scrollHeight;
}

/** Play the sound of an event after `delay` ms; returns when the next one may start. */
function eventSound(event, delay) {
  if (event.type === 'roll') {
    if (event.who === table.you && ownRollPending) {
      ownRollPending = false;
      return delay;
    }
    setTimeout(playDice, delay);
    return delay + DICE_PAUSE_MS;
  }
  if (event.type === 'move') {
    // Your own moves clicked while you placed the checkers; forced ones were made for you;
    // the friend's clicked when you saw them placed.
    if (event.forced || (event.who !== table.you && !heardTentative)) {
      const count = checkersMoved(event.move);
      playCheckers(count, delay);
      delay += count * CHECKER_GAP_MS;
    }
    // A best play (as for the awesome streak), by either player.
    if (event.awesome) {
      playAwesome(delay);
      delay += AWESOME_PAUSE_MS;
    }
  }
  return delay;
}

function laterMark(item) {
  return markButton({
    path: 'friend/mark',
    id: item.id,
    isMarked: () => item.marked,
    setMarked: (marked) => { item.marked = marked; },
    hint: 'Keep this position to look at it after the match'
  });
}

/** The latest graded decisions of both players: both see each other's mistakes. */
function renderFeedback(match) {
  const container = $('#playFeedback');
  clear(container);
  const order = table.you === 'player2' ? ['player2', 'player1'] : ['player1', 'player2'];
  for (const seat of order) {
    for (const item of match.recent[seat].filter((entry) => entry.grade)) {
      const row = flagRow(item, seat === table.you ? 'You' : nameOf(seat));
      row.appendChild(laterMark(item));
      container.appendChild(row);
    }
  }
}

/**
 * The dice look like the checkers of the player who rolled them: yours in
 * your color on the right half of the board, your friend's in theirs on the
 * left half (see #dice.dice-mine / .dice-theirs in game.css).
 */
function showDiceOf(owner) {
  const dice = $('#dice');
  dice.classList.toggle('dice-mine', owner === 'mine');
  dice.classList.toggle('dice-theirs', owner === 'theirs');
}

function renderGame() {
  const match = table.match;
  const view = $('#gameView');
  view.hidden = !match;
  const me = table.you || 'player1';
  showScore(page, match && { length: match.length, you: match.score[me], opponent: match.score[other(me)], crawford: match.crawford });
  if (!match) {
    if (!historyOpen) moveInput.show(startingBoard(), null);
    return;
  }
  renderLog(match);
  renderFeedback(match);
  if (historyOpen) return;

  showDiceOf(match.onTurn === table.you ? 'mine' : 'theirs');
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
      shownMoveCount = 0;
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

/** The friend's move in progress: on the board, with a click for each checker placed. */
function showTentative() {
  if (historyOpen) return;
  const tentative = table.match?.tentative;
  const moved = tentative?.moved ?? 0;
  if (moved > heardTentative && soundsLive) playChecker();
  heardTentative = moved;
  // The friend is always drawn as player2 here.
  moveInput.showTentative(tentative ? { points: tentative.points, mover: 'player2' } : null);
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
      ? `${table.seats.player1.name} and ${table.seats.player2.name} are at the table. If you are one of them, enter your name to continue here.`
      : adjournedText().trim();
    return;
  }
  renderPlayers();
  renderLobby();
  $('#abortBtn').hidden = !table.match || table.match.phase === 'match-over';
  $('#analyseLink').hidden = !table.match || !(table.match.gameNumber > 1 || table.match.events.some((event) => event.type === 'move'));
  const match = table.match;
  const key = match
    ? JSON.stringify([match.id, match.phase, match.ogid, match.onTurn, match.busy, match.error, match.events.length,
      match.recent, match.score, match.offer])
    : 'none';
  if (force || key !== shownMatch) {
    shownMatch = key;
    renderGame();
  }
  showTentative();
}

window.addEventListener('themechange', () => {
  shownPlayers = '';
  render(true);
});

// --- Talking to the server ---

async function send(path, body) {
  if (sending) return;
  sending = true;
  moveInput.setActive(false);
  setButtons([]);
  updateBoardActions();
  try {
    // Always a POST: playFetch sends a GET when there is no body (abort and leave have none).
    const { ok, status, payload } = await playFetch(path, body ?? {});
    if (status === 404 && payload.error === 'Not found') {
      sending = false;
      showKeyForm();
      return;
    }
    if (!ok) throw new Error(payload.error || `Request failed (${status})`);
    table = payload;
  } catch (error) {
    sending = false;
    ownRollPending = false;
    shownMatch = '';
    render();
    $('#playStatus').textContent = `Something went wrong: ${error.message}`;
    return;
  }
  sending = false;
  shownMatch = '';
  render();
}

let tentativeToSend = null;
let tentativeSending = false;

/** Tell the friend where your checkers are now. One request at a time, the latest position wins. */
async function reportTentative() {
  const play = moveInput.play;
  if (!play || !table?.match) return;
  tentativeToSend = { seq: table.match.seq, points: play.points, moved: play.moveCount };
  if (tentativeSending) return;
  tentativeSending = true;
  while (tentativeToSend) {
    const body = tentativeToSend;
    tentativeToSend = null;
    // If this fails the friend just sees your move when it is finished.
    await playFetch('friend/tentative', body).catch(() => {});
  }
  tentativeSending = false;
}

function friendIsMoving() {
  const match = table?.match;
  return Boolean(table?.you && match && match.onTurn !== table.you && (match.phase === 'move' || match.phase === 'thinking'));
}

function act(type, extra = {}) {
  if (type === 'roll' && !sending) {
    playDice();
    ownRollPending = true;
  }
  return send('friend/action', { type, ...extra });
}

async function poll() {
  for (;;) {
    if (!sending && $('#keyForm').hidden) {
      const { ok, status, payload } = await playFetch('friend/state').catch(() => ({ ok: false }));
      if (status === 404) {
        showKeyForm();
      } else if (ok && !sending) {
        // The seat is gone without us leaving: after a server restart it can be taken again.
        const lostSeat = table?.you && !payload.you;
        table = payload;
        render();
        if (lostSeat && storedName()) await join(storedName(), { ask: false });
      }
    }
    await sleep(friendIsMoving() && !document.hidden ? WATCH_POLL_MS : POLL_MS);
  }
}

/** @param {{ ask?: boolean, takeOver?: boolean }} [options] ask: offer to take over a seat in use in another browser */
async function join(name, { ask = true, takeOver = false } = {}) {
  const { ok, status, payload } = await playFetch('friend/join', { name, takeOver });
  if (status === 404) {
    showKeyForm();
    return;
  }
  if (payload.takeOver && ask && window.confirm(`${payload.error}. Continue here? The other browser then loses the seat.`)) {
    await join(name, { takeOver: true });
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
    showKeyForm();
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
  if (!table.you && name) await join(name, { ask: false });
  else render();
  // What happens from now on makes sounds; what was there when the page opened did not.
  soundsLive = true;
  $('#nameInput').value = storedName();
}

// --- History of our matches and the marked positions ---

let history = null;
// The analysis of a marked decision.
const panel = createAnalysisPanel($('#analysisPanel'), moveInput);

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
    if (match.hasGames) {
      // Seen from your own side, if you are one of the two.
      const seat = match.player2.name.toLowerCase() === storedName().toLowerCase() ? 'player2' : 'player1';
      const review = make('a', 'link-button', 'Review and analyse');
      review.href = `review.html?friend=${encodeURIComponent(match.id)}&as=${seat}`;
      review.title = 'Step through this match and analyse every decision';
      item.appendChild(review);
    }
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
  panel.setLimits(history.analysis);
}

function hideHistory() {
  historyOpen = false;
  $('#historyView').hidden = true;
  shownMatch = '';
  panel.hide();
  render(true);
}

/** A marked decision: its position on the board, from the deciding player's side. */
function showMarked(match, item) {
  const board = window.ogidCodec.decodeOgid(item.ogid);
  // Shown from the deciding player's side, so their dice are "mine".
  showDiceOf('mine');
  moveInput.show(boardFor(item.ogid, board.turn), board.dice);
  $('#markedView').hidden = false;
  $('#markedTitle').textContent = `${item.name}: ${item.action}`;
  $('#markedMeta').textContent = `${formatDate(match.finishedAt)} • ${item.kind === 'move' ? 'Checker play' : 'Cube decision'}, `
    + `lost ${item.loss.toFixed(3)}. Best: ${item.best}.`;
  panel.reset();
  panel.show({
    key: `${match.id}:${item.id}`,
    kind: item.kind === 'move' ? 'move' : 'cube',
    request: positionRequest(item.ogid, item.kind === 'move' ? item.action : null),
    marks: () => [[item.action, item.name]]
  });
}

// --- Setup ---

function bindEvents() {
  initSounds();
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
    if (running && !window.confirm('Leave the table? The match is saved: sit down again under the same name, in any browser, to go on.')) return;
    send('friend/leave');
  });
  $('#abortBtn').addEventListener('click', () => {
    if (!window.confirm('Really abort this match? It ends for both of you and is not saved.')) return;
    send('friend/abort');
  });
  $('#historyBtn').addEventListener('click', showHistory);
  $('#historyCloseBtn').addEventListener('click', hideHistory);
}

async function init() {
  bindEvents();
  moveInput.show(startingBoard(), null);
  await start();
  poll();
}

document.addEventListener('DOMContentLoaded', init);
