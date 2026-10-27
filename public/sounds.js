/* Sounds of the game: the dice, and a checker being placed (seven variations,
   picked at random). Sounds can overlap; browsers play them only after the
   player has clicked on the page once. The #soundToggle checkbox turns them
   on and off; the choice is remembered. */
import { $ } from './boardView.js';

const SOUND_STORAGE = 'bgSound';
const CHECKER_SOUNDS = [1, 2, 3, 4, 5, 6, 7].map((n) => `sounds/mv${n}.mp3`);
const DICE_SOUND = 'sounds/dice_roll.mp3';
// Several checkers moved at once (e.g. the friend's whole play) click one after the other.
const CHECKER_GAP_MS = 180;

let enabled = true;
let lastChecker = -1;
const preloaded = new Map();

function storedEnabled() {
  try {
    return window.localStorage.getItem(SOUND_STORAGE) !== '0';
  } catch {
    return true;
  }
}

function storeEnabled(on) {
  try {
    window.localStorage.setItem(SOUND_STORAGE, on ? '1' : '0');
  } catch {
    // sound stays on next time
  }
}

function preload(src) {
  const audio = new Audio(src);
  audio.preload = 'auto';
  preloaded.set(src, audio);
}

function play(src) {
  if (!enabled) return;
  const base = preloaded.get(src);
  // A copy per play, so a sound can start again before the last one ended.
  const audio = base ? base.cloneNode() : new Audio(src);
  audio.play().catch(() => {
    // not allowed yet (no click on the page so far) or not loadable: stay silent
  });
}

export function playDice() {
  play(DICE_SOUND);
}

/** One checker placed: one of the seven clicks, never the same twice in a row. */
export function playChecker() {
  let index = Math.floor(Math.random() * CHECKER_SOUNDS.length);
  if (index === lastChecker) index = (index + 1) % CHECKER_SOUNDS.length;
  lastChecker = index;
  play(CHECKER_SOUNDS[index]);
}

/** `count` checkers placed one after the other, starting after `delayMs`. */
export function playCheckers(count, delayMs = 0) {
  for (let i = 0; i < count; i++) setTimeout(playChecker, delayMs + i * CHECKER_GAP_MS);
}

/** How many checkers a play in move notation moves, e.g. "13/7(2) 8/2*" -> 3. */
export function checkersMoved(move) {
  return String(move || '').trim().split(/\s+/).filter(Boolean).reduce((sum, token) => {
    const count = token.match(/\((\d+)\)$/);
    return sum + (count ? Number(count[1]) : 1);
  }, 0);
}

/** Load the sounds and connect the #soundToggle checkbox. */
export function initSounds() {
  [...CHECKER_SOUNDS, DICE_SOUND].forEach(preload);
  const toggle = $('#soundToggle');
  enabled = storedEnabled();
  if (!toggle) return;
  toggle.checked = enabled;
  toggle.addEventListener('change', () => {
    enabled = toggle.checked;
    storeEnabled(enabled);
  });
}
