/* Talking to the play endpoints: the access key, this browser's player id
   and the login of a play account, as kept in the browser by the play page. */

const KEY_STORAGE = 'bgPlayKey';
const PLAYER_STORAGE = 'bgPlayPlayer';
const SESSION_STORAGE = 'bgPlaySession';

export function storedKey() {
  try {
    return window.localStorage.getItem(KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

export function storeKey(key) {
  try {
    window.localStorage.setItem(KEY_STORAGE, key);
  } catch {
    // the key is then asked for again next time
  }
}

/**
 * This browser's player id. No DailyGammon account is needed to play: the
 * access key admits the player and the id keeps their match apart. Without
 * browser storage the id lasts until the page is reloaded.
 */
let sessionPlayer = null;
function newPlayerId() {
  // getRandomValues works on plain HTTP too, unlike crypto.randomUUID().
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function playerId() {
  try {
    let id = window.localStorage.getItem(PLAYER_STORAGE);
    if (!id) {
      id = newPlayerId();
      window.localStorage.setItem(PLAYER_STORAGE, id);
    }
    return id;
  } catch {
    sessionPlayer = sessionPlayer || newPlayerId();
    return sessionPlayer;
  }
}

/** The login of a play account (to keep a match history), if any. */
export function storedSession() {
  try {
    return window.localStorage.getItem(SESSION_STORAGE) || '';
  } catch {
    return '';
  }
}

export function storeSession(token) {
  try {
    if (token) window.localStorage.setItem(SESSION_STORAGE, token);
    else window.localStorage.removeItem(SESSION_STORAGE);
  } catch {
    // without storage the login lasts until the page is reloaded
  }
}

export function playHeaders() {
  const headers = { 'X-Play-Key': storedKey(), 'X-Play-Player': playerId() };
  const session = storedSession();
  if (session) headers['X-Play-Session'] = session;
  return headers;
}

export async function playFetch(path, body) {
  const headers = playHeaders();
  const options = body === undefined
    ? { headers }
    : { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const response = await window.fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, payload };
}

/** Download a recorded match as a .mat file (for XG or gnubg). */
export async function downloadMatchFile(matchId) {
  const response = await window.fetch(`play/history/${encodeURIComponent(matchId)}/mat`, { headers: playHeaders() });
  if (!response.ok) return false;
  const disposition = response.headers.get('Content-Disposition') || '';
  const name = (disposition.match(/filename="?([^";]+)"?/) || [])[1] || `match-${matchId}.mat`;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
