/* Catherine's Corner — usage telemetry (dormant until the maker configures it).
   Rides on the local metrics counters: every DB.metrics.bump() also pings the
   maker's collector — counts only, never recordings, names, or titles, and no
   identifiers of any kind. While ENDPOINT is empty this module does nothing,
   the app stays fully local, and no disclosure is shown anywhere.

   To go live (once, ~3 minutes):
   1. Create a free GoatCounter site (privacy-first, no cookies): goatcounter.com
   2. Set ENDPOINT below, e.g. 'https://catherines-corner.goatcounter.com/count'
   3. Bump APP_VERSION (app.js) + VERSION (sw.js) and deploy.
   The alpha notice then discloses the sharing plainly, and the "What gets
   used" screen grows an off switch. Swapping collectors later (e.g. a
   Supabase events table once ADR-001's backend exists) touches only send(). */

(function () {
  'use strict';

  let ENDPOINT = '';   // empty = telemetry OFF, app is fully local

  let off = false;     // the family's off switch (settings: telemetryOff)
  const ready = DB.settings.get('telemetryOff').then(v => { off = !!v; }).catch(() => {});

  function configured() { return !!ENDPOINT; }
  function active() { return configured() && !off; }

  function send(key) {
    if (!active()) return;
    try {
      // GoatCounter's event pixel: one GET with the event name as a path and
      // nothing else. The random param only defeats the browser's image
      // cache, so the same event can count twice.
      const img = new Image();
      img.src = ENDPOINT + '?p=' + encodeURIComponent('/' + key) + '&e=true&r=' + Math.random().toString(36).slice(2);
    } catch (e) { /* telemetry must never break the app */ }
  }

  // Wrap the local counter: local count always happens; the ping follows
  // only when configured and not switched off.
  const localBump = DB.metrics.bump.bind(DB.metrics);
  DB.metrics.bump = key => { ready.then(() => send(key)); return localBump(key); };

  async function setOff(v) {
    off = !!v;
    await DB.settings.set('telemetryOff', off ? Date.now() : null);
  }

  window.Telemetry = {
    configured, active, setOff,
    isOff: () => off,
    configure: url => { ENDPOINT = url || ''; },   // also handy from the console and in tests
  };
})();
