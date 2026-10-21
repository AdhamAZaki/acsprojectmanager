// Session storage + Zoho sign-in + calls to the Apps Script backend.
(function () {
  const cfg = window.APP_CONFIG;
  const SESSION_KEY = 'acs-tracker-session';
  const STATE_KEY = 'acs-tracker-oauth-state';

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

  function redirectUri() {
    if (cfg.REDIRECT_URI) return cfg.REDIRECT_URI;
    return location.origin + location.pathname.replace(/index\.html$/, '');
  }

  function randomState() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  const Auth = {
    startLogin() {
      const state = randomState();
      try { store('sessionStorage').setItem(STATE_KEY, state); } catch (e) { /* ignore */ }
      const params = new URLSearchParams({
        response_type: 'token',
        client_id: cfg.ZOHO_CLIENT_ID,
        scope: 'AaaServer.profile.READ',
        redirect_uri: redirectUri(),
        state: state,
      });
      location.assign(cfg.ZOHO_ACCOUNTS_URL.replace(/\/+$/, '') + '/oauth/v2/auth?' + params);
    },

    /** If we just came back from Zoho, exchange the token for a session. Returns true if handled. */
    async handleRedirect() {
      const source = location.hash.length > 1 ? location.hash.slice(1) : location.search.slice(1);
      const params = new URLSearchParams(source);
      if (!params.has('access_token') && !params.has('error')) return false;
      history.replaceState(null, '', location.pathname);

      if (params.get('error')) throw new Error('Zoho sign-in was cancelled or failed: ' + params.get('error'));
      let expected = null;
      try { expected = store('sessionStorage').getItem(STATE_KEY); store('sessionStorage').removeItem(STATE_KEY); } catch (e) { /* ignore */ }
      if (!expected || expected !== params.get('state')) throw new Error('Sign-in check failed. Please try again.');

      const result = await call('login', { zohoToken: params.get('access_token') });
      Session.set(result);
      return true;
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
