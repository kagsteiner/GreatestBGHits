/* Controls shared by the pages where a match is played (against the engine,
   against a friend): keyboard shortcuts and the fast move entry toggle. */
import { $ } from './boardView.js';

const FAST_MOVE_STORAGE = 'bgPlayFastMove';

// Keyboard shortcuts for the game controls. Each one clicks its control, so it only works while
// that control is shown and enabled - the same rules as clicking it.
const SHORTCUTS = { Enter: '#doneBtn', u: '#undoBtn', r: '#rollBtn', s: '#dice .dice-swap' };

/** @param {() => boolean} [paused] true while a dialog or form should keep the keys */
export function bindShortcuts(paused = () => false) {
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    if (event.target.closest?.('input:not([type=checkbox]), select, textarea, [contenteditable]')) return;
    if (paused()) return;
    const selector = SHORTCUTS[event.key.length === 1 ? event.key.toLowerCase() : event.key];
    const control = selector && $(selector);
    // Without a Done button to press, Enter keeps its usual meaning for the focused control.
    if (!control || control.hidden) return;
    event.preventDefault();
    if (!control.disabled) control.click();
  });
}

function storedFastMove() {
  try {
    return window.localStorage.getItem(FAST_MOVE_STORAGE) === '1';
  } catch {
    return false;
  }
}

function storeFastMove(enabled) {
  try {
    window.localStorage.setItem(FAST_MOVE_STORAGE, enabled ? '1' : '0');
  } catch {
    // fast moves stay off next time
  }
}

/** Connect the #fastMoveToggle checkbox to the board's move input; the choice is remembered. */
export function bindFastMoveToggle(moveInput) {
  const toggle = $('#fastMoveToggle');
  toggle.checked = storedFastMove();
  moveInput.setFastMove(toggle.checked);
  toggle.addEventListener('change', () => {
    storeFastMove(toggle.checked);
    moveInput.setFastMove(toggle.checked);
  });
}
