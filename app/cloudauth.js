/* Catherine's Corner — CloudAuth: email sign-in for cloud backup.
   Worker-native (Resend): enter email -> get a 6-digit CODE + a same-device
   link. The CODE is primary — you read it on any device (your phone) and type
   it into the app, which matters on a shared tablet / installed PWA where a
   link would open on the wrong device or in Safari, not the app. Either way the
   app gets a 30-day session token, stored on-device. cloud.js reads
   CloudAuth.token() for its Bearer — the ONLY thing that reaches this family's
   cloud backup; the semi-public Corner ID never grants access. */
(function () {
  'use strict';
  const g = globalThis;
  const API = g.CC_CLOUD_API || 'https://catherines-corner-cloud.snowbear-llc.workers.dev';
  let _token = null, _email = null;

  async function _load() {
    if (g.DB && g.DB.settings) {
      _token = await g.DB.settings.get('cloudSession');
      _email = await g.DB.settings.get('cloudEmail');
    }
  }

  // If we arrived via a magic link (#magic=…), trade it for a session and scrub
  // the token out of the URL/history immediately.
  async function _consumeMagic() {
    const m = (location.hash || '').match(/[#&]magic=([^&]+)/);
    if (!m) return null;
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const r = await fetch(API + '/auth/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: decodeURIComponent(m[1]) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { error: j.error || 'This sign-in link didn’t work.' };
      _token = j.token; _email = j.email;
      if (g.DB && g.DB.settings) { await g.DB.settings.set('cloudSession', _token); await g.DB.settings.set('cloudEmail', _email); }
      return { email: _email };
    } catch (e) { return { error: 'Could not reach the cloud to finish signing in.' }; }
  }

  const CloudAuth = {
    // Called once at boot. Returns {email} if a link was just redeemed, {error}, or null.
    async init() { await _load(); return await _consumeMagic(); },
    isSignedIn: () => !!_token,
    token: () => _token,
    email: () => _email,
    // Step 1: email me a code (+ same-device link).
    async signIn(email) {
      const r = await fetch(API + '/auth/request', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: String(email || '').trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Could not send the sign-in email.');
      return true;
    },
    // Step 2: type the emailed code to finish signing in (works cross-device).
    async verifyCode(email, code) {
      const r = await fetch(API + '/auth/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: String(email || '').trim(), code: String(code || '').replace(/\D/g, '') }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'That code didn’t work.');
      _token = j.token; _email = j.email;
      if (g.DB && g.DB.settings) { await g.DB.settings.set('cloudSession', _token); await g.DB.settings.set('cloudEmail', _email); }
      return { email: _email };
    },
    async signOut() {
      _token = null; _email = null;
      if (g.DB && g.DB.settings) { await g.DB.settings.set('cloudSession', null); await g.DB.settings.set('cloudEmail', null); }
    },
    _setToken(t, e) { _token = t; _email = e || null; },   // test hook
  };
  g.CloudAuth = CloudAuth;
})();
