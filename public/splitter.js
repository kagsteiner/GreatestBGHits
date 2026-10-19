/* A handle between the board and the side panel on wide screens: drag it (or
   use the arrow keys) to give the board or the panel more room, double-click
   to go back to the page's own split. The width is remembered per page. The
   layout reads --split-board and --split-panel; without them it keeps its
   default columns (see quiz.css). */

/**
 * @param {{ layout: HTMLElement, splitter: HTMLElement, board: HTMLElement,
 *   storageKey: string, minBoard?: number, minPanel?: number }} options
 */
export function initSplitter({ layout, splitter, board, storageKey, minBoard = 360, minPanel = 300 }) {
  function apply(width) {
    if (width == null) {
      layout.style.removeProperty('--split-board');
      layout.style.removeProperty('--split-panel');
      return null;
    }
    const style = getComputedStyle(layout);
    const inner = layout.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const max = inner - minPanel - splitter.offsetWidth - 2 * (parseFloat(style.columnGap) || 0);
    const clamped = Math.round(Math.max(minBoard, Math.min(width, max)));
    layout.style.setProperty('--split-board', `${clamped}px`);
    layout.style.setProperty('--split-panel', `minmax(${minPanel}px, 1fr)`);
    return clamped;
  }

  function save(width) {
    try {
      if (width == null) window.localStorage.removeItem(storageKey);
      else window.localStorage.setItem(storageKey, String(width));
    } catch {
      // the default split is used next time
    }
  }

  try {
    const saved = Number(window.localStorage.getItem(storageKey));
    if (saved > 0) apply(saved);
  } catch {
    // keep the default split
  }
  splitter.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add('dragging');
    const left = board.getBoundingClientRect().left;
    let width = null;
    const move = (moveEvent) => { width = apply(moveEvent.clientX - left - 4); };
    const end = () => {
      splitter.classList.remove('dragging');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', end);
      splitter.removeEventListener('pointercancel', end);
      if (width != null) save(width);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', end);
    splitter.addEventListener('pointercancel', end);
  });
  splitter.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    save(apply(board.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? -40 : 40)));
  });
  splitter.addEventListener('dblclick', () => {
    apply(null);
    save(null);
  });
}
