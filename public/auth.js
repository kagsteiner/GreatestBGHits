(function () {
  const STORAGE_KEY = 'dgCredentials';
  const waiters = [];
  let overlay;
  let form;
  let usernameInput;
  let passwordInput;
  let userIdInput;
  let submitButton;

  function safeParse(value) {
    try {
      return JSON.parse(value) || null;
    } catch (_) {
      return null;
    }
  }

  function getCredentials() {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return safeParse(raw);
  }

  function hasCredentials() {
    const creds = getCredentials();
    return creds && creds.username && creds.password;
  }

  function notifyWaiters(creds) {
    while (waiters.length) {
      const resolve = waiters.shift();
      resolve(creds);
    }
  }

  function saveCredentials(creds) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
    if (creds.username && creds.password) {
      notifyWaiters(creds);
    }
  }

  function whenReady() {
    if (hasCredentials()) {
      return Promise.resolve(getCredentials());
    }
    return new Promise((resolve) => waiters.push(resolve));
  }

  async function authFetch(url, options = {}) {
    const creds = await whenReady();
    const headers = new Headers(options.headers || {});
    const token = window.btoa(`${creds.username}:${creds.password}`);
    headers.set('Authorization', `Basic ${token}`);
    const init = { ...options, headers };
    return window.fetch(url, init);
  }

  function applyOverlayStyles() {
    if (document.getElementById('dg-auth-styles')) return;
    const style = document.createElement('style');
    style.id = 'dg-auth-styles';
    style.textContent = `
.dg-auth-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}
.dg-auth-overlay.hidden {
  display: none;
}
.dg-auth-modal {
  background: #0f1117;
  border: 1px solid #1f2430;
  border-radius: 12px;
  padding: 32px;
  width: min(420px, 90vw);
  color: #f5f5f5;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
}
.dg-auth-modal h2 {
  margin: 0 0 12px;
  font-size: 1.5rem;
}
.dg-auth-field {
  display: flex;
  flex-direction: column;
  margin-bottom: 16px;
}
.dg-auth-field label {
  margin-bottom: 6px;
  font-size: 0.9rem;
  color: #cbd5f5;
}
.dg-auth-field input {
  border-radius: 8px;
  border: 1px solid #2a3142;
  padding: 10px 12px;
  font-size: 1rem;
  background: #141821;
  color: #f5f5f5;
}
.dg-auth-field small {
  margin-top: 6px;
  color: #94a3b8;
  font-size: 0.8rem;
}
.dg-auth-actions {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
}
.dg-auth-actions button {
  border: none;
  border-radius: 8px;
  padding: 10px 18px;
  background: #2563eb;
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}
.dg-auth-actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
`;
    document.head.appendChild(style);
  }

  function buildModal() {
    applyOverlayStyles();
    overlay = document.createElement('div');
    overlay.className = 'dg-auth-overlay hidden';
    overlay.innerHTML = `
      <div class="dg-auth-modal" role="dialog" aria-modal="true" aria-labelledby="dgAuthTitle">
        <h2 id="dgAuthTitle">DailyGammon Login</h2>
        <p>Please store your DailyGammon credentials so the app can fetch your matches.</p>
        <form class="dg-auth-form">
          <div class="dg-auth-field">
            <label for="dgAuthUsername">Username</label>
            <input id="dgAuthUsername" name="username" autocomplete="username" required />
          </div>
          <div class="dg-auth-field">
            <label for="dgAuthPassword">Password</label>
            <input id="dgAuthPassword" type="password" name="password" autocomplete="current-password" required />
          </div>
          <div class="dg-auth-field">
            <label for="dgAuthUserId">DailyGammon User ID (optional)</label>
            <input id="dgAuthUserId" name="userId" inputmode="numeric" />
            <small>Only needed if automatic detection fails.</small>
          </div>
          <div class="dg-auth-actions">
            <button type="submit" disabled>Save & Continue</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    form = overlay.querySelector('.dg-auth-form');
    usernameInput = form.querySelector('#dgAuthUsername');
    passwordInput = form.querySelector('#dgAuthPassword');
    userIdInput = form.querySelector('#dgAuthUserId');
    submitButton = form.querySelector('button[type="submit"]');

    const onInput = () => {
      const hasUser = usernameInput.value.trim().length > 0;
      const hasPass = passwordInput.value.trim().length > 0;
      submitButton.disabled = !(hasUser && hasPass);
    };

    usernameInput.addEventListener('input', onInput);
    passwordInput.addEventListener('input', onInput);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const creds = {
        username: usernameInput.value.trim(),
        password: passwordInput.value,
        userId: userIdInput.value.trim() || null
      };
      saveCredentials(creds);
      overlay.classList.add('hidden');
    });
  }

  function openModal(prefill = true) {
    if (!overlay) buildModal();
    const creds = getCredentials();
    if (prefill && creds) {
      usernameInput.value = creds.username || '';
      passwordInput.value = creds.password || '';
      userIdInput.value = creds.userId || '';
    } else {
      usernameInput.value = '';
      passwordInput.value = '';
      userIdInput.value = '';
    }
    const hasUser = usernameInput.value.trim().length > 0;
    const hasPass = passwordInput.value.trim().length > 0;
    submitButton.disabled = !(hasUser && hasPass);
    overlay.classList.remove('hidden');
    setTimeout(() => usernameInput.focus(), 0);
  }

  function ensureCredentials() {
    if (!hasCredentials()) {
      openModal(false);
    }
  }

  function init() {
    if (!overlay) buildModal();
    if (hasCredentials()) {
      notifyWaiters(getCredentials());
    } else {
      ensureCredentials();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.dgAuth = {
    getCredentials,
    getUserId() {
      const creds = getCredentials();
      return creds && creds.userId ? creds.userId : null;
    },
    whenReady,
    authFetch,
    requireCredentials: ensureCredentials,
    showLogin: openModal,
    clearCredentials() {
      window.localStorage.removeItem(STORAGE_KEY);
    },
    authFetchJson: async (url, options = {}) => {
      const response = await authFetch(url, options);
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      return response.json();
    }
  };
})();


