/* In the <head> of every page, before anything is drawn: the saved theme and
   "board only" apply at once, without a flash. toggleTheme() switches the theme;
   the window gets 'themechange' for labels that name the colors. A page without
   a board has an empty <button class="theme-toggle"> for it (see site.css). */
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

  document.addEventListener('DOMContentLoaded', () => {
    const button = document.querySelector('.theme-toggle');
    if (!button) return;
    button.innerHTML = `
      <svg class="icon-sun" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="5" />
        <path stroke-linecap="round" d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
      </svg>
      <svg class="icon-board" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
      </svg>`;
    button.addEventListener('click', window.toggleTheme);
  });
})();
