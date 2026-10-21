// Session storage + sign-in + calls to the Apps Script backend.
(function () {
  const cfg = window.APP_CONFIG;
  const SESSION_KEY = 'acs-tracker-session';

  function store(kind) {
    try { return window[kind]; } catch (e) { return null; }
  }

  const Session = {
    get() {
      try { return JSON.parse(store('localStorage').getItem(SESSION_KEY)); } catch (e) { return null; }
    },
    set(value) {
      try { store('localStorage').setItem(SESSION_KEY, JSON.stringify(value)); } catch (e) { /* private mode */ }
    },
    clear() {
      try { store('localStorage').removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
    },
  };

  const Auth = {
    async login(username, password) {
      const result = await call('login', { username: username, password: password });
      Session.set(result);
      return result;
    },

    logout() {
      Session.clear();
      location.reload();
    },
  };

  async function call(action, payload) {
    const session = Session.get();
    let res;
    try {
      res = await fetch(cfg.APPS_SCRIPT_URL, {
        method: 'POST',
        // text/plain avoids a CORS preflight, which Apps Script cannot answer.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: action, token: session && session.token, payload: payload || {} }),
      });
    } catch (e) {
      throw new Error('Cannot reach the server. Check your connection.');
    }
    let json;
    try { json = await res.json(); } catch (e) { throw new Error('Unexpected server response.'); }
    if (!json.ok) {
      if (json.code === 401 && action !== 'login') {
        Session.clear();
        window.dispatchEvent(new CustomEvent('session-expired', { detail: json.error }));
      }
      throw new Error(json.error || 'Request failed');
    }
    return json.data;
  }

  window.Api = { call: call, Session: Session, Auth: Auth };
})();
