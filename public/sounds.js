/* Sounds of the game: the dice, a checker being placed (seven variations,
   picked at random), and a voice saying "awesome" for a best play (three
   takes each by a female and a male speaker). Sounds can overlap; browsers
   play them only after the player has clicked on the page once. The
   #soundToggle checkbox turns all of them on and off, the #speechSelect
   chooses the voice (or none); both choices are remembered. */
import { $ } from './boardView.js';

const SOUND_STORAGE = 'bgSound';
const SPEECH_STORAGE = 'bgSpeech';
const CHECKER_SOUNDS = [1, 2, 3, 4, 5, 6, 7].map((n) => `sounds/mv${n}.mp3`);
const DICE_SOUND = 'sounds/dice_roll.mp3';
const AWESOME_SOUNDS = {
  female: [1, 2, 3].map((n) => `sounds/awesome_f${n}.mp3`),
  male: [1, 2, 3].map((n) => `sounds/awesome_m${n}.mp3`)
};
// Several checkers moved at once (e.g. the friend's whole play) click one after the other.
const CHECKER_GAP_MS = 180;

let enabled = true;
let speech = 'none';
const lastPicked = new Map();
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

/** One of `sounds` at random, never the same twice in a row. */
function pick(sounds) {
  let index = Math.floor(Math.random() * sounds.length);
  if (index === lastPicked.get(sounds)) index = (index + 1) % sounds.length;
  lastPicked.set(sounds, index);
  return sounds[index];
}

/** One checker placed: one of the seven clicks. */
export function playChecker() {
  play(pick(CHECKER_SOUNDS));
}

/** A best play: the chosen voice says "awesome", after `delayMs`. */
export function playAwesome(delayMs = 0) {
  const sounds = AWESOME_SOUNDS[speech];
  if (!sounds) return;
  setTimeout(() => play(pick(sounds)), delayMs);
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

function storedSpeech() {
  try {
    const value = window.localStorage.getItem(SPEECH_STORAGE);
    return value in AWESOME_SOUNDS ? value : 'none';
  } catch {
    return 'none';
  }
}

function storeSpeech(value) {
  try {
    window.localStorage.setItem(SPEECH_STORAGE, value);
  } catch {
    // no speech next time
  }
}

/** Load the sounds and connect the #soundToggle checkbox and the #speechSelect. */
export function initSounds() {
  [...CHECKER_SOUNDS, DICE_SOUND, ...AWESOME_SOUNDS.female, ...AWESOME_SOUNDS.male].forEach(preload);
  enabled = storedEnabled();
  speech = storedSpeech();
  const toggle = $('#soundToggle');
  if (toggle) {
    toggle.checked = enabled;
    toggle.addEventListener('change', () => {
      enabled = toggle.checked;
      storeEnabled(enabled);
    });
  }
  const select = $('#speechSelect');
  if (select) {
    select.value = speech;
    select.addEventListener('change', () => {
      speech = select.value in AWESOME_SOUNDS ? select.value : 'none';
      storeSpeech(speech);
      // Let the player hear the voice they chose; give the keys back to the game shortcuts.
      playAwesome();
      select.blur();
    });
  }
}
