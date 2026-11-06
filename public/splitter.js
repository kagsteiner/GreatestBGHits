/* The handle between the board and the panel: side by side in landscape, one
   above the other in portrait. Drag it (or use the arrow keys) to give either
   more room, double-click to go back to the default split. The split is
   remembered for each orientation, on all pages, as a share of the room, so it
   fits a rotated or resized screen. The layout reads --split-board and
   --split-panel; without them it keeps its default (see boardPage.css). */

const MIN_SIZES = {
  landscape: { board: 240, panel: 200 },
  portrait: { board: 140, panel: 90 }
};
const KEY_STEP = 24;

/** @param {{ layout: HTMLElement, splitter: HTMLElement, board: HTMLElement }} options */
export function initSplitter({ layout, splitter, board }) {
  const portrait = window.matchMedia('(orientation: portrait)');
  const orientation = () => (portrait.matches ? 'portrait' : 'landscape');
  const storageKey = () => `bgBoardSplit-${orientation()}`;

  /** The pixels the board and the panel share along the split's direction. */
  function room() {
    const style = getComputedStyle(layout);
    if (portrait.matches) {
      return layout.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
        - splitter.offsetHeight - 2 * (parseFloat(style.rowGap) || 0);
    }
    return layout.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      - splitter.offsetWidth - 2 * (parseFloat(style.columnGap) || 0);
  }

  function setSize(pixels) {
    const { board: minBoard, panel: minPanel } = MIN_SIZES[orientation()];
    const size = Math.round(Math.max(minBoard, Math.min(pixels, room() - minPanel)));
    layout.style.setProperty('--split-board', `${size}px`);
    layout.style.setProperty('--split-panel', 'minmax(0, 1fr)');
    return size;
  }

  function clearSize() {
    layout.style.removeProperty('--split-board');
    layout.style.removeProperty('--split-panel');
  }

  function save(pixels) {
    try {
      if (pixels == null) window.localStorage.removeItem(storageKey());
      else window.localStorage.setItem(storageKey(), String(pixels / room()));
    } catch {
      // the default split is used next time
    }
  }

  function restore() {
    splitter.setAttribute('aria-orientation', portrait.matches ? 'horizontal' : 'vertical');
    let share = 0;
    try {
      share = Number(window.localStorage.getItem(storageKey()));
    } catch {
      // keep the default split
    }
    if (share > 0 && share < 1) setSize(share * room());
    else clearSize();
  }

  restore();
  window.addEventListener('resize', restore);
  portrait.addEventListener('change', restore);

  const boardSize = () => (portrait.matches ? board.offsetHeight : board.offsetWidth);

  splitter.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add('dragging');
    const box = board.getBoundingClientRect();
    const start = portrait.matches ? box.top : box.left;
    let size = null;
    const move = (moveEvent) => {
      size = setSize((portrait.matches ? moveEvent.clientY : moveEvent.clientX) - start);
    };
    const end = () => {
      splitter.classList.remove('dragging');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', end);
      splitter.removeEventListener('pointercancel', end);
      if (size != null) save(size);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', end);
    splitter.addEventListener('pointercancel', end);
  });
  splitter.addEventListener('keydown', (event) => {
    const [less, more] = portrait.matches ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    if (event.key !== less && event.key !== more) return;
    event.preventDefault();
    event.stopPropagation();
    save(setSize(boardSize() + (event.key === less ? -KEY_STEP : KEY_STEP)));
  });
  splitter.addEventListener('dblclick', () => {
    clearSize();
    save(null);
  });
}
