/* What every page with a board has in common: the header with its settings,
   the board, the handle between the board and the panel, and "board only".
   A page's HTML holds its own panel and any tools of its header:

     <header class="app-header">
       <div class="header-tools">…</div>         (optional, stays in the header)
       <template data-settings>…</template>      (optional, rows of the settings menu)
     </header>
     <main class="layout">
       <section class="board-area"></section>
       <div class="split-handle" …></div>
       <section class="panel">…</section>
     </main>

   Its script calls initBoardPage() first, as the board's elements come from here. */
import { initSplitter } from './splitter.js';

const BOARD_ONLY_STORAGE = 'bgBoardOnly';

const BOARD_HTML = `
  <div class="board-container">
    <div class="point-numbers point-numbers-top" id="point-numbers-top"></div>
    <div class="board" id="board">
      <div class="bearoff bearoff-left">
        <div class="cube" id="cube">1</div>
      </div>
      <div class="points">
        <div class="points-row points-top" id="points-top"></div>
        <div class="center-strip">
          <div class="dice" id="dice"></div>
        </div>
        <div class="points-row points-bottom" id="points-bottom"></div>
      </div>
      <div class="bearoff bearoff-right">
        <div class="bearoff-p2" id="bearoff-p2">0</div>
        <div class="pipcount pipcount-p2" id="pipcount-p2">0</div>
        <div class="bearoff-p1" id="bearoff-p1">0</div>
        <div class="pipcount pipcount-p1" id="pipcount-p1">0</div>
      </div>
    </div>
    <div class="point-numbers point-numbers-bottom" id="point-numbers-bottom"></div>
  </div>`;

const icon = (path) => `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const ICONS = {
  back: icon('<path d="M15 5l-7 7 7 7"/>'),
  maximize: icon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  settings: icon('<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>')
};

function element(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

function iconButton(id, title, svg) {
  const button = element('button', 'icon-button', svg);
  button.type = 'button';
  button.id = id;
  button.title = title;
  button.setAttribute('aria-label', title);
  return button;
}

/** The settings menu: the page's own rows between the ones every page has. */
function settingsMenu(header, fastMoves) {
  const wrap = element('div', 'settings');
  const button = iconButton('settingsBtn', 'Settings', ICONS.settings);
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', 'settingsPanel');
  const panel = element('div', 'settings-panel');
  panel.id = 'settingsPanel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Settings');
  panel.hidden = true;
  if (fastMoves) {
    panel.append(element('label', 'menu-row', '<input type="checkbox" id="fastMoveToggle"> Fast moves'));
    panel.lastChild.title = 'Click a checker to move it by the first die, click again for the second. ⇄ next to the dice (or S) swaps them.';
  }
  const own = header.querySelector('template[data-settings]');
  if (own) panel.append(own.content);
  const engineMax = element('label', 'menu-row engine-max-toggle', '<input type="checkbox" data-engine-max> Maximum performance');
  engineMax.title = 'Uses all of this device\'s cores for faster and deeper analyses. Warms up the device (nice for cold hands) and drains the battery.';
  engineMax.hidden = true;
  panel.append(engineMax);
  const theme = element('button', 'menu-row menu-button');
  theme.type = 'button';
  theme.id = 'themeBtn';
  const showTheme = () => {
    const classic = document.documentElement.getAttribute('data-theme') === 'classic';
    theme.textContent = classic ? 'Theme: classic board' : 'Theme: dark';
  };
  showTheme();
  theme.addEventListener('click', () => window.toggleTheme());
  window.addEventListener('themechange', showTheme);
  panel.append(theme);
  wrap.append(button, panel);

  const setOpen = (open) => {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };
  button.addEventListener('click', () => setOpen(panel.hidden));
  document.addEventListener('pointerdown', (event) => {
    if (!panel.hidden && !wrap.contains(event.target)) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || panel.hidden) return;
    setOpen(false);
    button.focus();
  });
  return wrap;
}

function buildHeader(header, { subtitle, back, fastMoves }) {
  const tools = header.querySelector('.header-tools');
  const content = element('div', 'header-content', '<h1><span class="brand">Second Roll</span><span id="toMove" class="to-move"></span></h1><div id="matchInfo" class="match-info"></div>');
  content.querySelector('#toMove').textContent = subtitle;
  const menu = settingsMenu(header, fastMoves);
  const parts = [content];
  if (back) {
    const link = element('a', 'icon-button back-button', ICONS.back);
    link.href = back.href;
    link.title = back.label;
    link.setAttribute('aria-label', back.label);
    parts.unshift(link);
  }
  if (tools) parts.push(tools);
  parts.push(iconButton('maximizeBtn', 'Board only (Z)', ICONS.maximize), menu);
  header.replaceChildren(...parts);
}

const isBoardOnly = () => document.documentElement.classList.contains('board-only');

/**
 * Board only: the header, point numbers and most of the panel step aside so the
 * board gets the room. Where the browser allows it the page goes fullscreen as
 * well, and leaving fullscreen leaves board only.
 */
function setBoardOnly(on) {
  const root = document.documentElement;
  root.classList.toggle('board-only', on);
  try {
    window.localStorage.setItem(BOARD_ONLY_STORAGE, on ? '1' : '0');
  } catch {
    // board only is off next time
  }
  if (on && !document.fullscreenElement && root.requestFullscreen) {
    root.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  } else if (!on && document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
}

function bindBoardOnly(panel) {
  const bar = element('div', 'board-only-bar', '<span class="board-only-info"></span>');
  const exit = element('button', 'link-button');
  exit.type = 'button';
  exit.textContent = 'Exit board only';
  exit.title = 'Show everything again (Z or Esc)';
  exit.addEventListener('click', () => setBoardOnly(false));
  bar.append(exit);
  panel.prepend(bar);

  document.querySelector('#maximizeBtn').addEventListener('click', () => setBoardOnly(true));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // An open dialog or menu closes first.
      const dialogOpen = [...document.querySelectorAll('[role="dialog"]')].some((dialog) => dialog.getClientRects().length > 0);
      if (isBoardOnly() && !dialogOpen) setBoardOnly(false);
      return;
    }
    if (event.key.toLowerCase() !== 'z' || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest?.('input:not([type=checkbox]), select, textarea')) return;
    setBoardOnly(!isBoardOnly());
  });
  // A mistake shows just its grade here; tapping it shows everything.
  panel.addEventListener('click', (event) => {
    if (isBoardOnly() && event.target.closest('.play-flag')) setBoardOnly(false);
  });
  let wasFullscreen = false;
  document.addEventListener('fullscreenchange', () => {
    if (wasFullscreen && !document.fullscreenElement) setBoardOnly(false);
    wasFullscreen = Boolean(document.fullscreenElement);
  });
}

/**
 * @param {{ subtitle?: string, back?: { href: string, label: string }, mirror?: boolean, fastMoves?: boolean }} [options]
 *   subtitle: after the title (#toMove); back: a link back in the header;
 *   mirror: a button on the board that mirrors it (see window.isBoardMirrored);
 *   fastMoves: the page's board takes moves, so the setting is offered
 * @returns {{ setBoardInfo: (text: string) => void }} setBoardInfo: the one line
 *   (e.g. the score) that board only shows instead of the header
 */
export function initBoardPage({ subtitle = '', back = null, mirror = false, fastMoves = true } = {}) {
  const panel = document.querySelector('.panel');
  const boardArea = document.querySelector('.board-area');
  buildHeader(document.querySelector('.app-header'), { subtitle, back, fastMoves });
  boardArea.innerHTML = BOARD_HTML;
  if (mirror) {
    const button = element('button', 'board-mirror-button', '⇄');
    button.type = 'button';
    button.id = 'mirrorBoardBtn';
    button.title = 'Mirror board horizontally';
    boardArea.querySelector('.center-strip').append(button);
  }
  initSplitter({
    layout: document.querySelector('.layout'),
    splitter: document.querySelector('.split-handle'),
    board: boardArea
  });
  bindBoardOnly(panel);
  return {
    setBoardInfo(text) {
      panel.querySelector('.board-only-info').textContent = text;
    }
  };
}
