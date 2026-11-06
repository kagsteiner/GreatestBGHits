/* The analysis of a decision, the same on every page: a depth and a rollout to
   ask for, and the results of this decision, the latest on top. A page says
   what is being looked at with show(decision):

   {
     key,                   results are kept per key
     kind,                  'move' or 'cube'
     request(body),         does { kind, plies, mode, move }; resolves to { analysis, note? }
     marks(result),         labels plays: [[move, label]]
     summary(result),       sentences above a checker analysis
     cubeSummary(result),   sentences above a cube analysis
     focus(result),         the play a rollout's summary is about
     describe,              (played, best, next) => sentences for that summary
     rolloutLabel,          the rollout button, if not the usual one
     analysing(plies),      the status line during an analysis, if not the usual one
     rollingOut,            the same for a rollout
     defaultPlies,          the depth to preselect for this decision, if not the last one chosen
     depthNote(plies),      a note on a depth in the list
     autoRun                analyse at once when first shown
   }

   All but key, kind and request are optional. */
import { clear, make } from './boardView.js';
import {
  depthOptionText, fillRolloutOptions, mergeDeepened, playPreview,
  renderCubeAnalysis, renderCubeRollout, renderMoveAnalysis, renderMoveRollout
} from './analysisView.js';

/**
 * @param {HTMLElement} root an empty element to build the panel in
 * @param {{ preview: (move: string|null) => void }} board shows a play clicked in a table
 */
export function createAnalysisPanel(root, board) {
  root.classList.add('analysis-panel');
  root.hidden = true;

  const engineStatus = make('p', 'meta engine-status');
  engineStatus.dataset.engineStatus = '';
  engineStatus.hidden = true;

  const controls = make('div', 'analysis-controls');
  controls.id = 'analysisControls';
  controls.hidden = true;
  const select = (id, label) => {
    const element = make('select', 'training-mode-select');
    element.id = id;
    element.setAttribute('aria-label', label);
    return element;
  };
  const button = (id, classes) => {
    const element = make('button', classes);
    element.id = id;
    element.type = 'button';
    return element;
  };
  const depth = select('depthSelect', 'Search depth');
  const analyseBtn = button('analyseBtn');
  const rolloutMode = select('rolloutSelect', 'Rollout strength');
  [
    ['quick', 'Quick rollout (1,296 trials)'],
    ['precise', 'Precise rollout (variance reduction)'],
    ['deep', 'Very precise rollout (5,184 trials, variance reduction)']
  ].forEach(([value, text]) => {
    const option = make('option', null, text);
    option.value = value;
    rolloutMode.appendChild(option);
  });
  rolloutMode.value = 'precise';
  const rolloutBtn = button('rolloutBtn', 'secondary');
  rolloutMode.hidden = true;
  rolloutBtn.hidden = true;
  controls.append(depth, analyseBtn, rolloutMode, rolloutBtn);

  const status = make('div', 'analysis-status meta');
  status.id = 'analysisStatus';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const results = make('div', 'analysis-results');
  results.id = 'analysisResults';

  root.append(engineStatus, controls, status, results);

  const preview = playPreview(board, () => results);
  // decision key -> Map(request -> result), in the order they were asked for
  const stored = new Map();
  const autoRan = new Set();
  let current = null;
  let baseLimits = null;
  let busy = false;
  let disabled = false;
  let timer = null;
  // Clearing the panel leaves answers still on their way without a place to go.
  let generation = 0;

  const resultsOf = (decision) => {
    if (!stored.has(decision.key)) stored.set(decision.key, new Map());
    return stored.get(decision.key);
  };

  /** What the engine in this browser offers: null while it loads, and then the controls are hidden. */
  const limits = () => {
    if (!baseLimits) return null;
    return window.engineBridge ? window.engineBridge.limits(baseLimits) : baseLimits;
  };

  function updateButtons() {
    analyseBtn.disabled = busy || disabled;
    rolloutBtn.disabled = busy || disabled;
    // The ⇢ buttons of a table drawn while an analysis was still running.
    results.querySelectorAll('.deepen-button').forEach((deepen) => { deepen.disabled = busy; });
  }

  function setBusy(message) {
    clearInterval(timer);
    timer = null;
    busy = Boolean(message);
    if (message) {
      status.textContent = message;
      const started = Date.now();
      timer = setInterval(() => {
        status.textContent = `${message} ${Math.round((Date.now() - started) / 1000)} s`;
      }, 1000);
    }
    updateButtons();
  }

  function render(result, decision) {
    // A cube result lists no plays to label.
    const marks = () => decision.marks?.(result) || [];
    switch (result.kind) {
    case 'cube':
      return renderCubeAnalysis(result, decision.cubeSummary?.(result) || []);
    case 'rollout-cube':
      return renderCubeRollout(result);
    case 'rollout-move':
      return renderMoveRollout(result, { marks: marks(), focus: decision.focus?.(result), describe: decision.describe, preview });
    default:
      return renderMoveAnalysis(result, {
        marks: marks(),
        summary: decision.summary?.(result) || [],
        deepen: { busy, onClick: (move) => deepen(result, move, decision) },
        preview
      });
    }
  }

  function draw() {
    clear(results);
    if (!current) return;
    const decision = current;
    [...resultsOf(decision).values()].reverse().forEach((result) => {
      const section = make('section', 'analysis-result');
      section.appendChild(render(result, decision));
      results.appendChild(section);
    });
  }

  /** Ask once for what `name` stands for; the same request again brings its result back to the top. */
  async function run(name, body, message) {
    const decision = current;
    if (!decision || busy) return;
    const entries = resultsOf(decision);
    if (entries.has(name)) {
      const result = entries.get(name);
      entries.delete(name);
      entries.set(name, result);
      status.textContent = '';
      draw();
      return;
    }
    const ours = generation;
    setBusy(message);
    let done = '';
    try {
      const { analysis, note } = await decision.request(body);
      if (ours !== generation) return;
      entries.set(name, analysis);
      done = note || '';
    } catch (error) {
      if (ours !== generation) return;
      done = `Could not analyse: ${error.message}`;
    }
    setBusy(null);
    if (current?.key === decision.key) {
      status.textContent = done;
      draw();
    } else {
      status.textContent = '';
    }
    // A saved analysis changes the notes on the depths.
    fillControls();
  }

  function analyse() {
    if (!current || !limits()) return undefined;
    const plies = Number(depth.value);
    const message = current.analysing?.(plies) || `Analysing at ${plies}-ply…`;
    return run(`${current.kind}:${plies}`, { kind: current.kind, plies }, message);
  }

  function rollout() {
    if (!current) return undefined;
    const mode = rolloutMode.value;
    const kind = `rollout-${current.kind}`;
    return run(`${kind}:${mode}`, { kind, mode }, current.rollingOut || 'Rolling out…');
  }

  /** Search one shallow play to the table's depth and move it into the ranking. */
  async function deepen(result, move, decision) {
    if (busy) return;
    const ours = generation;
    setBusy(`Searching ${move} to ${result.plies}-ply…`);
    draw();
    let done = '';
    try {
      const { analysis } = await decision.request({ kind: 'deepen', plies: result.plies, move });
      if (ours !== generation) return;
      mergeDeepened(result, analysis);
    } catch (error) {
      if (ours !== generation) return;
      done = `Could not search ${move}: ${error.message}`;
    }
    setBusy(null);
    if (current?.key === decision.key) {
      status.textContent = done;
      draw();
    }
  }

  function fillControls() {
    if (!current) return;
    const offered = limits();
    controls.hidden = !offered;
    if (!offered) return;
    const previous = Number(depth.value) || baseLimits.plies;
    const wanted = current.defaultPlies && !resultsOf(current).size && !autoRan.has(current.key)
      ? current.defaultPlies
      : previous;
    clear(depth);
    for (let plies = 1; plies <= offered.maxPlies; plies++) {
      const option = make('option', null, depthOptionText(plies, offered, current.depthNote?.(plies) || ''));
      option.value = String(plies);
      depth.appendChild(option);
    }
    depth.value = String(Math.min(wanted, offered.maxPlies));
    const hasRollouts = fillRolloutOptions(rolloutMode, offered, current.kind === 'cube');
    rolloutMode.hidden = !hasRollouts;
    rolloutBtn.hidden = !hasRollouts;
    if (current.autoRun && !autoRan.has(current.key) && !busy && !resultsOf(current).size) {
      autoRan.add(current.key);
      analyse();
    }
  }

  analyseBtn.addEventListener('click', analyse);
  rolloutBtn.addEventListener('click', rollout);
  window.addEventListener('enginebridgechange', fillControls);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && preview.selected) preview.choose(null);
  });

  return {
    /** The depths and rollouts on offer, from the server (localAnalysis.viewLimits). */
    setLimits(value) {
      baseLimits = value;
      fillControls();
    },

    /** Show the analysis of a decision; null hides the panel. The page has already reset the board. */
    show(decision) {
      if (!decision) {
        this.hide();
        return;
      }
      if (current?.key !== decision.key) {
        preview.reset();
        if (!busy) status.textContent = '';
      }
      current = decision;
      root.hidden = false;
      analyseBtn.textContent = decision.kind === 'move' ? 'Analyse plays' : 'Analyse cube';
      rolloutBtn.textContent = decision.rolloutLabel || (decision.kind === 'move' ? 'Roll out top 5' : 'Roll out cube');
      fillControls();
      draw();
    },

    /** Hide it, and take a play shown from it off the board. */
    hide() {
      root.hidden = true;
      if (preview.selected) preview.choose(null);
      current = null;
    },

    /** Forget everything: the next decision starts afresh. */
    clear() {
      generation += 1;
      setBusy(null);
      stored.clear();
      autoRan.clear();
      preview.reset();
      current = null;
      root.hidden = true;
      controls.hidden = true;
      status.textContent = '';
      clear(results);
    },

    /** No new analyses for the moment. */
    setDisabled(value) {
      disabled = value;
      updateButtons();
    },

    setStatus(text) {
      status.textContent = text;
    },

    reset() {
      preview.reset();
    }
  };
}

/** The points each side still needs, from `player`'s view; null for money play. */
export function awayFor(board, player) {
  if (!board.matchLength || !player) return null;
  const other = player === 'player1' ? 'player2' : 'player1';
  return { away: board.matchLength - board.score[player], opponentAway: board.matchLength - board.score[other] };
}
