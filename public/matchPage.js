/* What the pages where a match is played have in common (against the engine,
   against a friend): the access key, the game's buttons with the clickable dice
   and cube, the score, and how a result or a mistake is told. A page's HTML holds
   the empty places, its script says what they mean in its own kind of match:

     <form class="play-key" id="keyForm" hidden></form>
     <div class="play-controls"></div>

   Its script calls initBoardPage() first, as the board's elements come from there. */
import { $, $$, make, clear, MoveInput } from './boardView.js';
import { bindFastMoveToggle, bindShortcuts } from './gameControls.js';
import { playFetch, storedKey, storeKey } from './playClient.js';

// id, text, class, title
const BUTTONS = [
  ['rollBtn', 'Roll', null, 'Roll the dice (R)'],
  ['doubleBtn', 'Double', 'secondary'],
  ['doneBtn', 'Done', null, 'Finish your move (Enter or R)'],
  ['undoBtn', 'Undo', 'secondary', 'Take back the last checker move (U or E)'],
  ['takeBtn', 'Take'],
  ['passBtn', 'Pass', 'secondary'],
  ['nextGameBtn', 'Next game']
];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The color of the player whose side the board is seen from. */
export function ownColor() {
  return document.documentElement.getAttribute('data-theme') === 'classic' ? 'Black' : 'Blue';
}

export function startingBoard() {
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
export function boardFor(ogid, viewer = 'player1') {
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

/**
 * The form asking for the access key.
 * @param {{ replaces: string[], onKey: () => void }} options what it hides while shown, and what to do with a new key
 * @returns {() => void} shows the form
 */
export function createKeyForm({ replaces, onKey }) {
  const form = $('#keyForm');
  const label = make('label', 'quiz-question', 'Access key');
  label.htmlFor = 'keyInput';
  const input = make('input', 'quiz-id-input');
  input.type = 'password';
  input.id = 'keyInput';
  input.autocomplete = 'off';
  input.required = true;
  const submit = make('button', null, 'Continue');
  submit.type = 'submit';
  form.append(label, input, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    storeKey(input.value.trim());
    onKey();
  });
  return () => {
    replaces.forEach((selector) => { $(selector).hidden = true; });
    form.hidden = false;
    label.textContent = storedKey() ? 'The access key was not accepted.' : 'Access key';
    input.focus();
  };
}

/**
 * The game's buttons, the clickable dice and cube and the keys for them.
 * @param {object} options
 * @param {(type: string, extra?: object) => void} options.act does a game action
 * @param {() => boolean} options.busy an action is under way
 * @param {() => boolean} options.canRoll it is the player's turn to roll or double
 * @param {() => object|null} options.legal the player's legal plays, while it is their move
 * @param {(play: object) => void} [options.onPlayChange] the player's move started or changed
 * @param {() => boolean} [options.paused] a dialog or form should keep the keys
 */
export function createMatchControls({ act, busy, canRoll, legal, onPlayChange = () => {}, paused }) {
  const box = $('.play-controls');
  for (const [id, text, className, title] of BUTTONS) {
    const button = make('button', className, text);
    button.type = 'button';
    button.id = id;
    button.hidden = true;
    if (title) button.title = title;
    box.appendChild(button);
  }
  $('#doneBtn').disabled = true;

  const moveInput = new MoveInput({ onChange: updateMoveStatus });
  bindFastMoveToggle(moveInput);
  bindShortcuts(paused);

  function moveFinished() {
    const play = moveInput.play;
    return Boolean(legal() && play?.isComplete() && play.moveCount > 0);
  }

  function finishMove() {
    if (moveFinished()) act('move', { key: moveInput.play.finalKey() });
  }

  function setButtons(visible) {
    for (const [id] of BUTTONS) {
      const button = $(`#${id}`);
      button.hidden = !visible.includes(id);
      button.disabled = busy();
    }
  }

  /** Blank dice to roll, the cube to double, and the dice again to finish a complete move. */
  function updateBoardActions() {
    const boardEl = $('#board');
    const rollable = !busy() && canRoll();
    const finishable = !busy() && moveFinished();
    boardEl.classList.toggle('can-roll', rollable);
    boardEl.classList.toggle('can-double', rollable);
    boardEl.classList.toggle('can-finish', finishable);
    const dice = $('#dice');
    $$('#dice .die.ready').forEach((die) => die.remove());
    if (rollable) {
      dice.appendChild(make('div', 'die ready'));
      dice.appendChild(make('div', 'die ready'));
    }
    dice.title = rollable ? 'Roll' : (finishable ? 'Finish the move' : '');
    if (rollable) $('#cube').title = `Double to ${moveInput.base.cube * 2}`;
  }

  function updateMoveStatus() {
    const play = moveInput.play;
    const plays = legal();
    if (!play || !plays) return;
    const status = $('#playStatus');
    const finished = moveFinished();
    if (finished) status.textContent = `Your move: ${play.finalMove()}`;
    else if (play.moveCount > 0) status.textContent = `Dice left: ${play.remaining.join(' ')}`;
    else status.textContent = `Your roll: ${plays.dice[0]}-${plays.dice[1]}`;
    $('#doneBtn').disabled = busy() || !finished;
    $('#undoBtn').disabled = busy() || play.moveCount === 0;
    updateBoardActions();
    onPlayChange(play);
  }

  $('#rollBtn').addEventListener('click', () => act('roll'));
  $('#doubleBtn').addEventListener('click', () => act('double'));
  $('#takeBtn').addEventListener('click', () => act('take'));
  $('#passBtn').addEventListener('click', () => act('pass'));
  $('#nextGameBtn').addEventListener('click', () => act('next-game'));
  $('#undoBtn').addEventListener('click', () => moveInput.undo());
  $('#doneBtn').addEventListener('click', finishMove);
  $('#dice').addEventListener('click', () => {
    if (busy()) return;
    if (canRoll()) act('roll');
    else finishMove();
  });
  $('#cube').addEventListener('click', () => {
    if (!busy() && canRoll()) act('double');
  });

  return { moveInput, setButtons, updateBoardActions, updateMoveStatus };
}

/**
 * The score in the header and on the board in "board only"; null for none.
 * @param {{ setBoardInfo: (text: string) => void }} page from initBoardPage
 * @param {{ length: number, you: number, opponent: number, crawford: boolean }|null} score
 */
export function showScore(page, score) {
  const info = $('#matchInfo');
  clear(info);
  if (!score) {
    page.setBoardInfo('');
    return;
  }
  const { length, you, opponent, crawford } = score;
  page.setBoardInfo(`${you} : ${opponent} (to ${length})${crawford ? ' Crawford' : ''}`);
  info.append('Match to ', make('strong', null, String(length)), ' points, ',
    make('span', 'score-blue', String(you)), ' : ', make('span', 'score-red', String(opponent)),
    crawford ? ' • Crawford game' : '');
}

/**
 * How a game ended.
 * @param {{ points: number, kind: string }} result
 * @param {boolean} won the player won it
 * @param {string} opponent the name of the other player
 */
export function resultText(result, won, opponent) {
  const points = `${result.points} point${result.points === 1 ? '' : 's'}`;
  const winner = won ? 'You win' : `${opponent} wins`;
  if (result.kind === 'pass') return `${won ? `${opponent} passes` : 'You pass'}. ${winner} ${points}.`;
  const how = { gammon: ' a gammon', backgammon: ' a backgammon' }[result.kind] || '';
  return `${winner}${how}: ${points}.`;
}

/**
 * A row telling about a decision graded as a mistake.
 * @param {{ grade: string, loss: number, kind: string, action: string, best?: string }} item
 * @param {string} [who] whose decision it was, if the page shows those of both players
 */
export function flagRow(item, who) {
  const row = make('div', `play-flag ${item.grade}`);
  // The wording module splits blunders into levels ("Big blunder", "Severe blunder").
  const label = window.analysisText?.gradeLabel(item.loss)
    || item.grade.charAt(0).toUpperCase() + item.grade.slice(1);
  row.appendChild(make('strong', null, `${who ? `${who}: ` : ''}${label} (−${item.loss.toFixed(3)})`));
  const verb = item.kind === 'move' ? 'played' : 'chose';
  const what = who ? `${verb.charAt(0).toUpperCase()}${verb.slice(1)}` : `You ${verb}`;
  row.appendChild(make('span', null, ` ${what} ${item.action}.${item.best ? ` Best: ${item.best}.` : ''}`));
  return row;
}

/**
 * The button to keep a decision for later.
 * @param {object} options
 * @param {string} options.path where to save it
 * @param {string} options.id the decision
 * @param {() => boolean} options.isMarked
 * @param {(marked: boolean) => void} options.setMarked
 * @param {string} options.hint the button's title while it is not marked
 * @param {string} [options.suffix] goes on after "Mark"
 */
export function markButton({ path, id, isMarked, setMarked, hint, suffix = '' }) {
  const button = make('button', 'link-button mark-button');
  button.type = 'button';
  const show = () => {
    const marked = isMarked();
    button.textContent = marked ? `★ Marked${suffix}` : `☆ Mark${suffix}`;
    button.setAttribute('aria-pressed', String(marked));
    button.title = marked ? 'Click to unmark' : hint;
  };
  show();
  button.addEventListener('click', async () => {
    const marked = !isMarked();
    button.disabled = true;
    const { ok } = await playFetch(path, { id, marked });
    button.disabled = false;
    if (!ok) {
      button.textContent = 'Could not mark it';
      return;
    }
    setMarked(marked);
    show();
  });
  return button;
}
