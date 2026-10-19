/* Engine analyses as tables with a plain-language summary above them, shared
   by the match review and the quiz page. Probabilities are for the player on
   roll; amounts are per unit of the cube, as the engine reports them. */
import { make } from './boardView.js';

export const pct = (value) => (value == null ? '–' : `${(value * 100).toFixed(1)}%`);
const num = (value) => (value == null ? '–' : (value * 100).toFixed(1));
export const signed = (value, digits = 3) => (value == null ? '–' : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`);

/** Win and lose, each with gammons / backgammons in brackets. */
export function probabilityCells(row, evaluation) {
  if (!evaluation) {
    row.appendChild(make('td', null, '–'));
    row.appendChild(make('td', null, '–'));
    return;
  }
  const lose = 1 - evaluation.win;
  row.appendChild(make('td', null, `${num(evaluation.win)} (${num(evaluation.gammonWin)} / ${num(evaluation.backgammonWin)})`));
  row.appendChild(make('td', null, `${num(lose)} (${num(evaluation.gammonLoss)} / ${num(evaluation.backgammonLoss)})`));
}

export function table(headers) {
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
export function summaryBox(sentences) {
  const box = make('div', 'review-summary');
  sentences.forEach((sentence) => box.appendChild(make('p', null, sentence)));
  return box;
}

/**
 * A deep checker search answered from the engine's result cache (e.g. the
 * position was graded at this depth before) takes no measurable time.
 * Cube searches can be genuinely that fast, so they only show the time.
 */
export function timing(result, cacheHint = false) {
  const seconds = (result.durationMs || 0) / 1000;
  return cacheHint && seconds < 0.1 && result.plies >= 4 ? 'answered from the engine\'s cache' : `${seconds.toFixed(1)} s`;
}

/**
 * The plays of a checker analysis, the played one included. The engine
 * searches only the most promising plays (and the played one) to the full
 * depth; the rest keep a shallower value. Values of different depths are not
 * comparable (odd and even depths differ systematically), so `full` holds the
 * plays at the full depth, best first, and `shallow` the rest.
 */
export function rankedPlays(result) {
  const rows = result.moves.slice();
  if (result.played && !rows.some((move) => move.move === result.played.move)) {
    rows.push({ ...result.played, evaluation: result.played.evaluation });
  }
  const full = rows.filter((move) => move.ply === result.plies).sort((a, b) => b.equity - a.equity);
  const shallow = rows.filter((move) => move.ply !== result.plies)
    .sort((a, b) => (b.ply - a.ply) || (b.equity - a.equity));
  return { full, shallow };
}

/**
 * A checker analysis as a table, ranked within the full depth.
 *
 * @param {object} result a 'move' analysis
 * @param {{ marks?: Array<[string, string]>, summary?: string[],
 *   deepen?: { busy: boolean, onClick: (move: string) => void } }} view
 *   `marks` labels plays ("played", "your answer"); `deepen` offers to search
 *   a shallow play to the full depth
 */
export function renderMoveAnalysis(result, { marks = [], summary = [], deepen = null } = {}) {
  const container = make('div');
  if (summary.length) container.appendChild(summaryBox(summary));
  container.appendChild(make('div', 'meta',
    `${result.plies}-ply, ${result.legalMoves} legal plays, ${timing(result, true)}. `
    + 'Win and lose with gammons / backgammons in brackets; for the player on roll.'));
  const { element, body } = table(['#', 'Play', 'Depth', 'Equity', 'Diff', 'Win % (g / bg)', 'Lose % (g / bg)']);
  const { full, shallow } = rankedPlays(result);
  const best = full[0]?.equity;
  const addRow = (move, rank, isFull) => {
    const labels = marks.filter(([marked]) => marked === move.move).map(([, label]) => label);
    const classes = [labels.length ? 'played' : '', isFull ? '' : 'shallow'].filter(Boolean).join(' ');
    const row = make('tr', classes);
    row.appendChild(make('td', null, rank));
    row.appendChild(make('td', null, `${move.move || '(no move)'}${labels.map((label) => ` ◀ ${label}`).join('')}`));
    const depthCell = make('td', 'review-depth', move.ply ? `${move.ply}-ply` : '');
    if (!isFull && move.move && deepen) {
      const button = make('button', 'deepen-button', `⇢${result.plies}`);
      button.type = 'button';
      button.title = `Search this play to ${result.plies}-ply`;
      button.setAttribute('aria-label', `Search ${move.move} to ${result.plies}-ply`);
      button.disabled = deepen.busy;
      button.addEventListener('click', () => deepen.onClick(move.move));
      depthCell.appendChild(button);
    }
    row.appendChild(depthCell);
    row.appendChild(make('td', null, signed(move.equity)));
    row.appendChild(make('td', null, isFull && best != null && move.equity !== best ? signed(move.equity - best) : ''));
    probabilityCells(row, move.evaluation);
    body.appendChild(row);
  };
  full.forEach((move, index) => addRow(move, String(index + 1), true));
  if (shallow.length) {
    const separator = make('tr', 'separator');
    const cell = make('td', null,
      'Searched less deeply by the engine\'s move filter: not comparable with the plays above.'
      + (deepen ? ` Click ⇢${result.plies} to search a play to ${result.plies}-ply too.` : ''));
    cell.colSpan = 7;
    separator.appendChild(cell);
    body.appendChild(separator);
    shallow.forEach((move) => addRow(move, '–', false));
  }
  container.appendChild(element);
  return container;
}

/** A play searched to the full depth ('deepen' result) replaces its shallow entry. */
export function mergeDeepened(result, deepened) {
  const index = result.moves.findIndex((entry) => entry.move === deepened.move.move);
  if (index >= 0) result.moves[index] = deepened.move;
  else result.moves.push(deepened.move);
}

export function probabilitySummary(evaluation) {
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

/** A cube analysis: the engine's verdict, the three equities and the probabilities. */
export function renderCubeAnalysis(result, summary = []) {
  const container = make('div');
  if (summary.length) container.appendChild(summaryBox(summary));
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
