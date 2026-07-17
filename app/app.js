/* Catherine's Corner — app shell (local-first).
   Two flows are the whole product: a grown-up records, a child plays.
   Kid mode is the default; the PIN is the switch (set lazily on first exit).

   This file owns the frame: state, the screen registry + router, the shared
   player handle, the share-target inbox, and boot. Screens live in their own
   modules (screens-kid / screens-adult / screens-record / send) and register
   themselves here — adding a screen is one App.register call, no shell edit. */

(function () {
  'use strict';

  const APP_VERSION = '1.15.0';
  const { el, esc, toast } = UI;

  // ---------- app state ----------
  const S = {
    mode: 'kid',            // 'kid' | 'adult'
    screen: 'shelf',
    params: {},
    rec: null,              // in-progress recording draft
    shared: null,           // audio that arrived via the share target (e.g. a voice memo)
  };

  // ---------- screen registry ----------
  const screens = {};       // name -> render fn(root, ctx)
  const screenMeta = {};    // name -> { guest }
  function register(name, fn, meta) {
    screens[name] = fn;
    screenMeta[name] = meta || {};
  }

  function go(screen, params) {
    S.screen = screen;
    S.params = params || {};
    render();
  }

  // ---------- player engine ----------
  const player = {
    audio: null, reading: null, book: null, reader: null,
    raf: null, ended: false,
    stop() {
      if (this.audio) { this.audio.pause(); this.audio.src = ''; this.audio = null; }
      if (this.raf) cancelAnimationFrame(this.raf);
      this.reading = null; this.ended = false;
    },
  };

  // ---------- share-target inbox ----------
  // A recording shared from another app (voice memo, etc.) waits in a cache
  // inbox written by the service worker's share-target handler.
  async function checkSharedInbox() {
    if (!('caches' in window)) return;
    try {
      const cache = await caches.open('cc-shared-inbox');
      const res = await cache.match('./__shared-audio');
      if (!res) return;
      const raw = await res.blob();
      const name = decodeURIComponent(res.headers.get('x-name') || 'shared recording');
      const blob = Backup.normalizeAudioFile(new File([raw], name, { type: raw.type }));
      S.shared = { blob, name };
      DB.metrics.bump('record.shared_arrived');
      toast('A recording arrived 🎙 — open “for grown-ups” to turn it into a reading.');
    } catch (e) { /* inbox is best-effort */ }
  }
  async function consumeShared() {
    const shared = S.shared;
    if (!shared) return null;
    S.shared = null;
    try { const c = await caches.open('cc-shared-inbox'); await c.delete('./__shared-audio'); } catch (e) {}
    const duration = await UI.probeDuration(shared.blob);
    return { blob: shared.blob, name: shared.name, duration: duration || 0 };
  }

  // ---------- shell ----------
  const $app = document.getElementById('app');

  // If the library can't open (blocked upgrade, private-mode storage, a bug
  // mid-boot), say so calmly instead of a blank screen — the data itself is
  // untouched, and reopening usually clears it.
  function renderFailure(err) {
    $app.innerHTML = '';
    $app.appendChild(el(
      '<div class="card" style="max-width:560px; margin:40px auto 0">' +
      '<div class="kicker">a hiccup, not a loss</div>' +
      '<h1 class="screen-title" style="font-size:22px">The app couldn’t open its library just now</h1>' +
      '<p class="screen-sub" style="margin-bottom:10px">Everything recorded on this device is still stored — nothing is deleted. ' +
      'Close any other Catherine’s Corner tabs, then try again.</p>' +
      '<p class="hint">' + esc((err && err.message) || err || 'unknown error') + '</p>' +
      '<div class="btn-row"><button class="btn primary big" id="retry">Try again</button></div></div>'));
    $app.querySelector('#retry').onclick = () => location.reload();
  }

  async function render() {
    try { await renderInner(); } catch (err) { renderFailure(err); }
  }

  async function renderInner() {
    player.stop();
    const isGuest = !!(screenMeta[S.screen] && screenMeta[S.screen].guest);
    const [corner, corners] = isGuest ? [null, []] : await Promise.all([DB.corners.active(), DB.corners.all()]);
    const ctx = { corner, corners, cornerName: corner ? corner.name : null };
    // The alpha notice gates everything on the owner's device — but never an
    // invited guest, whose page carries its own honest framing.
    if (!isGuest && S.screen !== 'alphaNotice' && S.screen !== 'join' && !(await DB.settings.get('alphaAck'))) {
      S.mode = 'kid';
      S.screen = 'alphaNotice';
    }
    $app.innerHTML = '';
    $app.classList.remove('wide');

    const pill = isGuest ? '<span class="mode-pill">alpha · an invitation</span>'
      : S.mode === 'adult'
        ? '<span class="mode-pill">alpha &middot; grown-up mode &middot; <button id="to-kid">back to kid mode</button></span>'
        : '<span class="mode-pill">alpha · early test build</span>';
    // ✨ appears whenever the app updated since this device last looked.
    const unseen = !isGuest && window.WhatsNew && await WhatsNew.hasUnseen();
    const bar = el('<div class="topbar"><span class="mark"><b>Catherine’s</b> Corner</span>' +
      (unseen ? '<button class="newpill" id="newbadge" title="see what changed">✨ new</button>' : '') + pill + '</div>');
    $app.appendChild(bar);
    if (unseen) bar.querySelector('#newbadge').onclick = () => go('whatsnew');
    if (!isGuest && S.mode === 'adult') bar.querySelector('#to-kid').onclick = () => { S.mode = 'kid'; go('shelf'); };

    const fn = screens[S.screen] || screens.shelf;
    const body = document.createElement('div');
    $app.appendChild(body);
    await fn(body, ctx);

    const foot = el('<footer class="appfoot">' +
      (isGuest ? (S.screen === 'give'
          ? 'Recorded right here. Your reading goes straight to their shelf. · v' + APP_VERSION
          : 'Recorded right here, sent back by you — nothing is uploaded anywhere. · v' + APP_VERSION)
        : 'Everything stays on this device — back it up under “Keep it safe.” · ' +
          '<button class="foot-ver" id="vlink" title="what’s new in this version">v' + APP_VERSION + ' ✨</button>') +
      '</footer>');
    $app.appendChild(foot);
    const vlink = foot.querySelector('#vlink');
    if (vlink) vlink.onclick = () => go('whatsnew');
  }

  // =========================================================
  // ALPHA NOTICE — shown once, before anything else
  // =========================================================
  register('alphaNotice', async function alphaNotice(root) {
    const card = el(
      '<div class="card" style="max-width:560px; margin:26px auto 0">' +
      '<div class="kicker">an early test build</div>' +
      '<h1 class="screen-title" style="font-size:24px">Before you tuck anything precious in here…</h1>' +
      '<p class="screen-sub" style="margin-bottom:14px">Catherine’s Corner is in <b>alpha</b> — you’re testing it early, and the honest state of things is:</p>' +
      '<div class="stack">' +
      '<div class="rowitem"><span style="font-size:19px">📍</span><div class="grow"><div class="t">Recordings live only on this device</div>' +
      '<div class="d">In this browser, on this phone or tablet. Your recordings aren’t uploaded anywhere unless you turn on cloud backup (under Keep it safe).</div></div></div>' +
      (window.Telemetry && Telemetry.configured()
        ? '<div class="rowitem"><span style="font-size:19px">📊</span><div class="grow"><div class="t">Anonymous usage counts help fix rough spots</div>' +
          '<div class="d">Simple counts of what gets used — never recordings, names, or titles — reach the maker. Turn it off any time: for grown-ups → What gets used.</div></div></div>'
        : '') +
      '<div class="rowitem"><span style="font-size:19px">⚠️</span><div class="grow"><div class="t">They can be lost</div>' +
      '<div class="d">Clearing this browser’s data, deleting the app, or losing the device deletes the recordings with it.</div></div></div>' +
      '<div class="rowitem"><span style="font-size:19px">🗄️</span><div class="grow"><div class="t">Back up anything you’d hate to lose</div>' +
      '<div class="d">for grown-ups → Keep it safe → Back up everything. That one zip file is yours to keep anywhere, forever.</div></div></div>' +
      '<div class="rowitem"><span style="font-size:19px">🔧</span><div class="grow"><div class="t">Things will change</div>' +
      '<div class="d">This build exists to be tested. Features may move or break between versions — your feedback shapes it.</div></div></div>' +
      '</div>' +
      '<div class="btn-row" style="margin-top:18px"><button class="btn primary big" id="ack">I understand — take me in</button></div>' +
      '</div>');
    root.appendChild(card);
    card.querySelector('#ack').onclick = async () => {
      await DB.settings.set('alphaAck', Date.now());
      await WhatsNew.markSeen();   // fresh install: everything is new, no badge
      S.mode = 'kid';
      go('shelf');
    };
  });

  // ---------- self-updating ----------
  // New versions install eagerly (the service worker skipWaitings and claims);
  // this side notices the takeover and reloads to show it — but only when
  // nothing precious is mid-flight. A live recording, an unsaved draft,
  // playback, a sync, or a guest visit is never interrupted: the update then
  // simply applies on the next open. Recordings live in IndexedDB, which an
  // update never touches.
  function updateSafe() {
    const recordingLive = !!document.querySelector('.rec-dot.live');
    const unsavedDraft = !!(S.rec && S.rec.audioBlob);
    const playing = !!(player.audio && !player.audio.paused);
    return !recordingLive && !unsavedDraft && !playing && S.screen !== 'guest' && S.screen !== 'give' && S.screen !== 'sync' && S.screen !== 'join';
  }
  function initUpdates() {
    if (!('serviceWorker' in navigator)) return;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;   // first claim on a fresh install is not an update
      reloaded = true;
      if (updateSafe()) location.reload();
      else toast('A little update is ready — it’ll apply next time you open the app.');
    });
    // Look for updates whenever the app comes back to the foreground (how a
    // home-screen app usually "restarts"), and hourly while it stays open.
    const check = () => navigator.serviceWorker.ready.then(r => r.update()).catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    setInterval(check, 60 * 60 * 1000);
  }

  // ---------- boot ----------
  document.addEventListener('DOMContentLoaded', async () => {
    // A magic sign-in link (#magic=…) is handled FIRST and awaited, so the
    // session is set before the app paints (the cloud card shows signed-in and
    // there's no render race). CloudAuth.init also loads any stored session.
    let magicMsg = null;
    if (window.CloudAuth) {
      try {
        const res = await CloudAuth.init();
        if (res && res.email) magicMsg = 'Signed in as ' + res.email + '. Cloud backup is under “for grown-ups → Keep it safe.”';
        else if (res && res.error) magicMsg = res.error;
      } catch (e) { /* offline / cloud unreachable — the app still opens */ }
    }
    initUpdates();
    // A #join= link brings a co-parent in: they sign in (if needed), redeem the
    // token, and land pending until the owner approves. Suppress auto-claim FIRST
    // so no cloud touch on this path claims this device's own local corner as a
    // new family — the joiner must stay uncorner'd until approval adopts the
    // owner's shelf. The join screen carries its own framing + sign-in.
    const joinM = (location.hash || '').match(/[#&]join=([A-Za-z0-9\-_]+)/);
    if (joinM && window.Cloud) {
      history.replaceState(null, '', location.pathname + location.search);
      Cloud.setSuppressAutoClaim(true);
      S.screen = 'join';
      S.params = { joinToken: joinM[1] };
      render();
      return;
    }
    // A #give= link opens the cloud guest page directly — the guest records and
    // it uploads straight to the family's shelf. Like #invite: no PIN, no setup.
    const give = Send.giveFromHash();
    if (give) {
      S.screen = 'give';
      S.params = { give };
      render();
      return;
    }
    // An invite link opens the guest page directly — no PIN, no shelf, no setup.
    const invite = Send.inviteFromHash();
    if (invite) {
      S.screen = 'guest';
      S.params = { invite };
      render();
      return;
    }
    // A #parcel= share link (Phase 3): pull the parcel from the cloud, then route
    // into the SAME accept screen a file parcel uses (zero new merge code). Calm
    // on an expired/garbage token or when offline — the app still opens normally.
    const pm = (location.hash || '').match(/[#&]parcel=([^&]+)/);
    if (pm && window.Cloud) {
      const token = decodeURIComponent(pm[1]);
      history.replaceState(null, '', location.pathname + location.search);
      await checkSharedInbox();
      render();
      Cloud.pullParcel(token)
        .then(({ manifest, map }) => go('acceptParcel', { parcel: { m: manifest, map } }))
        .catch((err) => toast(/40[34]|not found/i.test((err && err.message) || '')
          ? 'That share link has expired or isn’t valid anymore — ask for a fresh one.'
          : 'Couldn’t open that shared parcel just now — you may be offline.'));
      return;
    }
    await checkSharedInbox();
    render();
    if (magicMsg) toast(magicMsg);
    // On open: if signed in, quietly keep the cloud backup fresh (idempotent,
    // silent when offline). This is what makes cloud backup "seamless" after the
    // one-time sign-in — new recordings ride up on their own.
    if (window.Cloud && window.CloudAuth && CloudAuth.isSignedIn()) {
      DB.readings.all().then((rs) => {
        if (rs.length) {
          DB.settings.get('cloudLastBackup').then((last) => {
            if (!last || Date.now() - last > 12 * 3600 * 1000) Cloud.autoBackup('open');
          }).catch(() => {});
          return;
        }
        // A signed-in device with an empty local shelf — a fresh install, a new
        // owner device, or a JUST-APPROVED CO-PARENT — quietly adopts the
        // account's family library on open (merge-only, never deletes). A
        // still-pending co-parent pulls nothing: ensureIdentity won't resolve a
        // family yet, so pullBackup throws and is swallowed. This is the
        // "library appears on next open" half of co-parent join.
        Cloud.pullBackup().then(() => { if (UI.clearURLCache) UI.clearURLCache(); render(); }).catch(() => {});
      }).catch(() => {});
    }
    // Devices already holding readings should be marked must-keep even if
    // they saved before persistence was requested (or the browser said no
    // once) — re-ask quietly whenever there is something worth keeping.
    DB.readings.all().then(rs => { if (rs.length) DB.requestPersistence(); }).catch(() => {});
  });

  window.App = { VERSION: APP_VERSION, S, go, render, register, player, consumeShared, updateSafe };
})();
