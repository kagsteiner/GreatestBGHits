/* In the <head> of every page with a board, before anything is drawn: the saved
   theme and "board only" apply at once, without a flash. toggleTheme() switches
   the theme; the window gets 'themechange' for labels that name the colors. */
(function setUpTheme() {
  'use strict';
  const root = document.documentElement;
  const classic = () => root.getAttribute('data-theme') === 'classic';

  function apply(theme) {
    if (theme === 'classic') root.setAttribute('data-theme', 'classic');
    else root.removeAttribute('data-theme');
  }

  try {
    apply(localStorage.getItem('sr-theme'));
    if (localStorage.getItem('bgBoardOnly') === '1') root.classList.add('board-only');
  } catch {
    // the defaults, then
  }

  window.toggleTheme = function toggleTheme() {
    const next = classic() ? 'dark' : 'classic';
    try {
      localStorage.setItem('sr-theme', next);
    } catch {
      // only for this page then
    }
    apply(next);
    window.dispatchEvent(new Event('themechange'));
  };
})();
