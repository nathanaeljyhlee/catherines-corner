/* Catherine's Corner — v1.1 web app (local-first).
   Two flows are the whole product: a grown-up records, a child plays.
   Kid mode is the default; the PIN is the switch (set lazily on first exit). */

(function () {
  'use strict';

  const $app = document.getElementById('app');
  const APP_VERSION = '1.5.1';
  // iOS Safari mishandles accept="audio/*" on file inputs (greys out audio in
  // Files, offers only video/camera). There: no accept filter, validate in JS.
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const AV_COLORS = ['#34557A', '#D08A4E', '#5B7B5A', '#8A5A83', '#A85B4B', '#446A92', '#7A6A34'];

  // ---------- tiny helpers ----------
  const urlCache = new Map();
  function blobURL(key, blob) {
    if (!blob) return null;
    if (!urlCache.has(key)) urlCache.set(key, URL.createObjectURL(blob));
    return urlCache.get(key);
  }
  function dropURL(key) {
    if (urlCache.has(key)) { URL.revokeObjectURL(urlCache.get(key)); urlCache.delete(key); }
  }
  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    if (t.content.childElementCount === 1) return t.content.firstElementChild;
    const d = document.createElement('div');
    d.appendChild(t.content);
    return d;
  }
  let toastTimer = null;
  function toast(msg) {
    let t = document.querySelector('.toast');
    if (!t) { t = el('<div class="toast"></div>'); document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function avatar(reader, cls) {
    if (!reader) return '<span class="av ' + (cls || '') + '" style="background:#c6bba8">?</span>';
    return '<span class="av ' + (cls || '') + '" style="background:' + reader.color + '">' + esc((reader.name || '?')[0].toUpperCase()) + '</span>';
  }
  function readAsBlob(file) {
    return Promise.resolve(file); // File is already a Blob; stored directly.
  }

  // ---------- app state ----------
  const S = {
    mode: 'kid',            // 'kid' | 'adult'
    screen: 'shelf',
    params: {},
    rec: null,              // in-progress recording draft
    shared: null,           // audio that arrived via the share target (e.g. a voice memo)
  };

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
      toast('A recording arrived 🎙 — open “for grown-ups” to turn it into a reading.');
    } catch (e) { /* inbox is best-effort */ }
  }
  async function consumeShared() {
    const shared = S.shared;
    if (!shared) return null;
    S.shared = null;
    try { const c = await caches.open('cc-shared-inbox'); await c.delete('./__shared-audio'); } catch (e) {}
    const url = URL.createObjectURL(shared.blob);
    const duration = await new Promise(res => {
      const a = new Audio(url);
      a.onloadedmetadata = () => res(isFinite(a.duration) ? a.duration : 0);
      a.onerror = () => res(0);
    });
    URL.revokeObjectURL(url);
    return { blob: shared.blob, name: shared.name, duration };
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

  function currentPageIndex(reading, tSec) {
    const turns = reading.pageTurns || [];
    let i = 0;
    for (const tt of turns) { if (tSec * 1000 >= tt) i++; else break; }
    return i;
  }

  function applySkips(reading, audio) {
    const ranges = reading.skipRanges || [];
    const t = audio.currentTime * 1000;
    for (const r of ranges) {
      if (t >= r.start && t < r.end - 40) { audio.currentTime = r.end / 1000; return; }
    }
  }

  // A real slider: tap anywhere on the track or drag the thumb to move through
  // the recording — forwards and backwards, playing or paused.
  function makeScrubber($track, audio, durFn, onSeek) {
    let dragging = false;
    function seekTo(clientX) {
      const r = $track.getBoundingClientRect();
      const d = durFn();
      if (!d || !r.width) return;
      audio.currentTime = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * d;
      if (onSeek) onSeek();
    }
    $track.addEventListener('pointerdown', e => {
      e.preventDefault();
      dragging = true;
      try { $track.setPointerCapture(e.pointerId); } catch (err) {}
      seekTo(e.clientX);
    });
    $track.addEventListener('pointermove', e => { if (dragging) seekTo(e.clientX); });
    $track.addEventListener('pointerup', () => { dragging = false; });
    $track.addEventListener('pointercancel', () => { dragging = false; });
  }

  // How much is printed on a page — dark pixels stand in for text, so wordy
  // pages get a bigger share of the recording when turns are suggested. The
  // floor means a picture-only page still gets a beat of its own.
  function pageInk(blob) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        let weight = 1;
        try {
          const w = 64;
          const h = Math.max(8, Math.round(w * img.height / img.width)) || 64;
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const x = c.getContext('2d');
          x.drawImage(img, 0, 0, w, h);
          const d = x.getImageData(0, 0, w, h).data;
          let ink = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 < 118) ink++;
          }
          weight = ink + w * h * 0.08;
        } catch (err) { /* tainted or unreadable image — even share */ }
        URL.revokeObjectURL(url);
        resolve(weight);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(1); };
      img.src = url;
    });
  }

  // ---------- data helpers ----------
  async function readingsGrouped(bookId) {
    const rows = await DB.readings.forBook(bookId);
    const byReader = new Map();
    for (const r of rows) {
      if (!byReader.has(r.readerId)) byReader.set(r.readerId, []);
      byReader.get(r.readerId).push(r);
    }
    for (const list of byReader.values()) {
      list.sort((a, b) => (a.episodeIndex ?? 0) - (b.episodeIndex ?? 0) || a.createdAt - b.createdAt);
    }
    return byReader;
  }
  async function nextEpisodeIndex(bookId, readerId) {
    const rows = (await DB.readings.forBook(bookId)).filter(r => r.readerId === readerId && r.episodeIndex != null);
    return rows.length ? Math.max(...rows.map(r => r.episodeIndex)) + 1 : 1;
  }

  // ---------- shell ----------
  async function render() {
    player.stop();
    const cornerName = await DB.settings.get('cornerName');
    if (S.screen !== 'alphaNotice' && !(await DB.settings.get('alphaAck'))) {
      S.mode = 'kid';
      S.screen = 'alphaNotice';
    }
    $app.innerHTML = '';

    const bar = el(
      '<div class="topbar">' +
      '<span class="mark"><b>Catherine’s</b> Corner</span>' +
      (S.mode === 'adult'
        ? '<span class="mode-pill">alpha &middot; grown-up mode &middot; <button id="to-kid">back to kid mode</button></span>'
        : '<span class="mode-pill">alpha · early test build</span>') +
      '</div>');
    $app.appendChild(bar);
    if (S.mode === 'adult') bar.querySelector('#to-kid').onclick = () => { S.mode = 'kid'; go('shelf'); };

    const screens = {
      alphaNotice: alphaNotice,
      shelf: kidShelf, voicePick: kidVoicePick, episodes: kidEpisodes, player: kidPlayer,
      pin: pinScreen,
      home: adultHome, setup: adultSetup, readers: adultReaders, books: adultBooks,
      bookDetail: adultBookDetail, addBook: adultAddBook, requests: adultRequests, safety: adultSafety,
      studio: coverStudio, memoHelp: memoHelp,
      recWho: recWho, recWhat: recWhat, recShape: recShape, recPass1: recPass1, recPass2: recPass2, recDone: recDone,
    };
    const fn = screens[S.screen] || kidShelf;
    const body = document.createElement('div');
    $app.appendChild(body);
    await fn(body, cornerName);

    $app.appendChild(el('<footer class="appfoot">Everything stays on this device — back it up under “Keep it safe.” · v' + APP_VERSION + '</footer>'));
  }

  // =========================================================
  // ALPHA NOTICE — shown once, before anything else
  // =========================================================
  async function alphaNotice(root) {
    const card = el(
      '<div class="card" style="max-width:560px; margin:26px auto 0">' +
      '<div class="kicker">an early test build</div>' +
      '<h1 class="screen-title" style="font-size:24px">Before you tuck anything precious in here…</h1>' +
      '<p class="screen-sub" style="margin-bottom:14px">Catherine’s Corner is in <b>alpha</b> — you’re testing it early, and the honest state of things is:</p>' +
      '<div class="stack">' +
      '<div class="rowitem"><span style="font-size:19px">📍</span><div class="grow"><div class="t">Recordings live only on this device</div>' +
      '<div class="d">In this browser, on this phone or tablet. Nothing is uploaded anywhere.</div></div></div>' +
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
      S.mode = 'kid';
      go('shelf');
    };
  }

  // =========================================================
  // KID MODE
  // =========================================================
  async function kidShelf(root, cornerName) {
    const [books, readers, told] = await Promise.all([DB.books.all(), DB.readers.all(), DB.readings.told()]);
    const readerMap = new Map(readers.map(r => [r.id, r]));
    const allReadings = await DB.readings.all();

    root.appendChild(el(
      '<div class="shelf-head"><h1>' + esc(cornerName ? cornerName + '’s shelf' : 'Your shelf') + '</h1>' +
      '<button class="gate-link" id="gate">for grown-ups</button></div>'));
    root.querySelector('#gate').onclick = () => go('pin');

    const withReadings = books.filter(b => allReadings.some(r => r.bookId === b.id));
    if (!withReadings.length && !told.length) {
      root.appendChild(el(
        '<div class="empty"><div class="big">🌙</div>Nothing on the shelf yet.<br>' +
        'A grown-up can record the first reading — tap “for grown-ups” above.</div>'));
      return;
    }

    const grid = el('<div class="grid"></div>');
    for (const b of withReadings) {
      const rs = allReadings.filter(r => r.bookId === b.id);
      const hasNew = rs.some(r => r.isNew);
      const voiceIds = [...new Set(rs.map(r => r.readerId))];
      const coverSrc = b.cover ? blobURL('cover-' + b.id, b.cover) : null;
      const tile = el(
        '<button class="tile">' +
        (hasNew ? '<span class="badge-new">new chapter</span>' : '') +
        (coverSrc ? '<img class="cover" alt="" src="' + coverSrc + '">'
          : '<span class="cover ph">' + esc(b.title) + '</span>') +
        '<span class="tile-crayon" role="button" aria-label="decorate this book" title="decorate">🖍️</span>' +
        '<span class="meta"><span class="t">' + esc(b.title) + '</span>' +
        '<span class="by"><span class="av-row">' +
        voiceIds.slice(0, 4).map(id => avatar(readerMap.get(id), 'sm')).join('') +
        '</span>' + (voiceIds.length === 1 ? esc((readerMap.get(voiceIds[0]) || {}).name || '') : voiceIds.length + ' voices') + '</span></span>' +
        '</button>');
      tile.onclick = () => openBookKid(b, rs, voiceIds);
      tile.querySelector('.tile-crayon').onclick = e => {
        e.stopPropagation();
        go('studio', { bookId: b.id });
      };
      grid.appendChild(tile);
    }
    for (const st of told) {
      const rd = readerMap.get(st.readerId);
      const tile = el(
        '<button class="tile story">' +
        (st.isNew ? '<span class="badge-new">new story</span>' : '') +
        '<span class="cover ph">🌙</span>' +
        '<span class="meta"><span class="t">' + esc(st.title || 'A bedtime story') + '</span>' +
        '<span class="by">' + avatar(rd, 'sm') + 'told by ' + esc(rd ? rd.name : '') + '</span></span>' +
        '</button>');
      tile.onclick = () => go('player', { readingId: st.id });
      grid.appendChild(tile);
    }
    root.appendChild(grid);
  }

  async function openBookKid(book, readings, voiceIds) {
    // Multi-voice picker only appears when a book truly has 2+ voices (feedback: not central).
    if (voiceIds.length > 1) return go('voicePick', { bookId: book.id });
    return afterVoice(book.id, voiceIds[0]);
  }

  async function afterVoice(bookId, readerId) {
    const rows = (await DB.readings.forBook(bookId)).filter(r => r.readerId === readerId);
    const episodes = rows.filter(r => r.episodeIndex != null);
    if (episodes.length) return go('episodes', { bookId, readerId });
    const whole = rows.sort((a, b) => b.createdAt - a.createdAt)[0];
    return go('player', { readingId: whole.id });
  }

  async function kidVoicePick(root) {
    const book = await DB.books.get(S.params.bookId);
    const grouped = await readingsGrouped(book.id);
    const readers = await DB.readers.all();
    root.appendChild(el('<h1 class="screen-title">' + esc(book.title) + '</h1><p class="screen-sub">Whose voice tonight?</p>'));
    const stack = el('<div class="stack"></div>');
    for (const [readerId, rows] of grouped) {
      const rd = readers.find(r => r.id === readerId);
      const eps = rows.filter(r => r.episodeIndex != null).length;
      const p = el(
        '<button class="pick">' + avatar(rd) +
        '<span><span class="nm">' + esc(rd ? rd.name : 'Someone') + '</span><br>' +
        '<span class="rel">' + esc(rd ? rd.relationship : '') + (eps ? ' · ' + eps + ' chapter' + (eps > 1 ? 's' : '') : '') + '</span></span>' +
        '<span class="spacer"></span><span class="chev">›</span></button>');
      p.onclick = () => afterVoice(book.id, readerId);
      stack.appendChild(p);
    }
    root.appendChild(stack);
    const back = el('<button class="back">‹ back to the shelf</button>');
    back.onclick = () => go('shelf');
    root.appendChild(back);
  }

  async function kidEpisodes(root) {
    const book = await DB.books.get(S.params.bookId);
    const rd = await DB.readers.get(S.params.readerId);
    const rows = (await DB.readings.forBook(book.id))
      .filter(r => r.readerId === S.params.readerId)
      .sort((a, b) => (a.episodeIndex ?? 0) - (b.episodeIndex ?? 0));
    root.appendChild(el(
      '<h1 class="screen-title">' + esc(book.title) + '</h1>' +
      '<p class="screen-sub">Read by ' + esc(rd ? rd.name : '') + ', a chapter at a time — like your shows.</p>'));
    const stack = el('<div class="stack"></div>');
    for (const r of rows) {
      const label = r.episodeIndex != null ? 'Chapter ' + r.episodeIndex + (r.title ? ' · ' + r.title : '') : (r.title || 'The whole book');
      const p = el(
        '<button class="pick"><span class="av" style="background:var(--warm)">' + (r.episodeIndex ?? '•') + '</span>' +
        '<span><span class="nm">' + esc(label) + '</span><br><span class="rel">' + fmt((r.duration || 0)) + '</span></span>' +
        '<span class="spacer"></span>' +
        (r.isNew ? '<span class="chip open">new tonight</span>' : '') +
        '<span class="chev">›</span></button>');
      p.onclick = () => go('player', { readingId: r.id });
      stack.appendChild(p);
    }
    root.appendChild(stack);
    const back = el('<button class="back">‹ back to the shelf</button>');
    back.onclick = () => go('shelf');
    root.appendChild(back);
  }

  async function kidPlayer(root) {
    const reading = await DB.readings.get(S.params.readingId);
    if (!reading) return go('shelf');
    const book = reading.bookId ? await DB.books.get(reading.bookId) : null;
    const reader = await DB.readers.get(reading.readerId);
    const pages = (book && book.pages) || [];

    if (reading.isNew) { reading.isNew = false; await DB.readings.save(reading); }

    const title = book ? book.title : (reading.title || 'A bedtime story');
    const sub = (reading.episodeIndex != null ? 'Chapter ' + reading.episodeIndex + ' · ' : '') +
      'read by ' + (reader ? reader.name : 'someone who loves you');

    const wrap = el(
      '<div class="player">' +
      '<div class="p-top"><div><div class="p-title">' + esc(title) + '</div><div class="p-by">' + esc(sub) + '</div></div>' +
      avatar(reader) + '</div>' +
      '<div class="p-stage" id="stage"></div>' +
      '<div class="p-bar">' +
      '<button class="p-play" id="pp" aria-label="play">▶</button>' +
      '<div class="p-track" id="track"><i id="fill"></i></div>' +
      '<span class="p-time" id="time">0:00</span>' +
      '</div></div>');
    root.appendChild(wrap);
    const back = el('<button class="back">‹ back to the shelf</button>');
    back.onclick = () => go('shelf');
    root.appendChild(back);

    const stage = wrap.querySelector('#stage');
    const TAGS = { book_page: '📖 from the book', child_art: '🖍️ drawn for this page', family_photo: '📷 a family photo' };
    function renderStage(idx) {
      stage.innerHTML = '';
      if (pages.length) {
        const p = pages[Math.min(idx, pages.length - 1)];
        stage.appendChild(el('<img alt="story page" src="' + blobURL('pg-' + p.id, p.blob) + '">'));
        stage.appendChild(el('<span class="p-tag">' + (TAGS[p.type] || '') + '</span>'));
        stage.appendChild(el('<span class="p-count">' + (Math.min(idx, pages.length - 1) + 1) + ' / ' + pages.length + '</span>'));
      } else if (book && book.cover) {
        stage.appendChild(el('<img alt="book cover" src="' + blobURL('cover-' + book.id, book.cover) + '">'));
      } else {
        stage.appendChild(el('<div class="noart"><div class="big">🌙</div><div class="cap">Close your eyes and listen.</div></div>'));
      }
    }
    renderStage(0);

    const audio = new Audio(blobURL('aud-' + reading.id, reading.audioBlob));
    player.audio = audio; player.reading = reading;
    const $pp = wrap.querySelector('#pp'), $fill = wrap.querySelector('#fill'), $time = wrap.querySelector('#time'), $track = wrap.querySelector('#track');
    let lastIdx = 0;

    function dur() { return audio.duration && isFinite(audio.duration) ? audio.duration : (reading.duration || 0); }
    // userSeek: only a deliberate scrub may sweep the calm end-screen away —
    // the frame loop must never repaint over it.
    function paintNow(userSeek) {
      const d = dur();
      $fill.style.width = d ? (audio.currentTime / d * 100) + '%' : '0%';
      $time.textContent = fmt(audio.currentTime) + (d ? ' / ' + fmt(d) : '');
      const idx = currentPageIndex(reading, audio.currentTime);
      if (idx !== lastIdx || (userSeek && stage.querySelector('.calm'))) { lastIdx = idx; renderStage(idx); }
    }
    function tick() {
      if (!player.audio) return;
      applySkips(reading, audio);
      paintNow(false);
      player.raf = requestAnimationFrame(tick);
    }
    $pp.onclick = () => {
      if (audio.paused) { audio.play(); $pp.textContent = '❘❘'; tick(); }
      else { audio.pause(); $pp.textContent = '▶'; }
    };
    makeScrubber($track, audio, dur, () => paintNow(true));
    audio.onended = async () => {
      $pp.textContent = '▶';
      // the calm close — no autoplay, no feed
      const next = reading.episodeIndex != null
        ? (await DB.readings.forBook(reading.bookId)).find(r => r.readerId === reading.readerId && r.episodeIndex === reading.episodeIndex + 1)
        : null;
      stage.innerHTML = '';
      const calm = el(
        '<div class="calm"><div class="moon">🌙</div><h2>The end.</h2>' +
        '<p>' + (next ? 'The next chapter is waiting whenever you are.' : 'Sweet dreams.') + '</p>' +
        '<div class="btn-row" style="justify-content:center">' +
        '<button class="btn" id="again">Read it again</button>' +
        (next ? '<button class="btn primary" id="next">Chapter ' + next.episodeIndex + ' ›</button>' : '') +
        '<button class="btn ghost" id="shelf2">Back to the shelf</button>' +
        '</div></div>');
      stage.appendChild(calm);
      calm.querySelector('#again').onclick = () => { renderStage(0); lastIdx = 0; audio.currentTime = 0; audio.play(); $pp.textContent = '❘❘'; tick(); };
      if (next) calm.querySelector('#next').onclick = () => go('player', { readingId: next.id });
      calm.querySelector('#shelf2').onclick = () => go('shelf');
    };
  }

  // =========================================================
  // PIN GATE (lazy — set on first exit from kid mode)
  // =========================================================
  async function pinScreen(root) {
    const savedPin = await DB.settings.get('pin');
    const creating = !savedPin;
    let entered = '', firstPass = null;

    const wrap = el(
      '<div class="pinwrap card">' +
      '<div class="kicker">for grown-ups</div>' +
      '<h1 class="screen-title" id="pt" style="font-size:22px">' + (creating ? 'Choose a grown-up code' : 'Grown-up code') + '</h1>' +
      '<p class="hint" id="ph">' + (creating
        ? 'Four digits. It keeps little fingers out of the settings — nothing more. It works on <b>this device only</b>: family using their own phone or tablet choose their own code there.'
        : 'Enter the four-digit code for this device.') + '</p>' +
      '<div class="pin-dots" id="dots">' + '<i></i>'.repeat(4) + '</div>' +
      '<div class="pinpad" id="pad"></div>' +
      '<div class="pin-err" id="err"></div>' +
      (creating ? '' : '<button class="gate-link" id="forgot" style="margin-top:12px">I forgot the code</button>') +
      '<button class="back" id="back" style="display:block; margin:14px auto 0">‹ back to the shelf</button>' +
      '</div>');
    root.appendChild(wrap);
    wrap.querySelector('#back').onclick = () => { S.mode = 'kid'; go('shelf'); };

    // Forgot-the-code escape: the code is a kid-gate, not a lock. A quick
    // grown-up check clears it so a new one can be chosen — recordings untouched.
    const forgotBtn = wrap.querySelector('#forgot');
    if (forgotBtn) forgotBtn.onclick = () => {
      const a = 3 + Math.floor(Math.random() * 7), b = 3 + Math.floor(Math.random() * 7);
      wrap.innerHTML = '';
      wrap.appendChild(el(
        '<div><div class="kicker">a quick grown-up check</div>' +
        '<h1 class="screen-title" style="font-size:22px">What is ' + a + ' × ' + b + '?</h1>' +
        '<p class="hint">The code only keeps little fingers out — a grown-up can always reset it. Everything on the shelf stays exactly as it is.</p>' +
        '<div class="field" style="margin-top:14px"><input type="number" id="ans" inputmode="numeric" placeholder="your answer"></div>' +
        '<div class="pin-err" id="ferr"></div>' +
        '<div class="btn-row"><button class="btn primary" id="chk">That’s my answer</button>' +
        '<button class="btn ghost" id="fback">never mind</button></div></div>'));
      wrap.querySelector('#chk').onclick = async () => {
        if (parseInt(wrap.querySelector('#ans').value, 10) === a * b) {
          await DB.settings.set('pin', null);
          toast('Code cleared — choose a new one.');
          go('pin');
        } else {
          wrap.querySelector('#ferr').textContent = 'Not quite — try again.';
        }
      };
      wrap.querySelector('#fback').onclick = () => go('pin');
    };

    const pad = wrap.querySelector('#pad');
    for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫']) {
      const b = el('<button' + (k === '' ? ' disabled style="visibility:hidden"' : '') + '>' + k + '</button>');
      b.onclick = () => key(k);
      pad.appendChild(b);
    }
    function paint() {
      wrap.querySelectorAll('#dots i').forEach((d, i) => d.classList.toggle('on', i < entered.length));
    }
    async function key(k) {
      wrap.querySelector('#err').textContent = '';
      if (k === '⌫') { entered = entered.slice(0, -1); return paint(); }
      if (entered.length >= 4) return;
      entered += k; paint();
      if (entered.length < 4) return;
      if (creating) {
        if (firstPass === null) {
          firstPass = entered; entered = ''; paint();
          wrap.querySelector('#pt').textContent = 'Once more to be sure';
          wrap.querySelector('#ph').textContent = 'Type the same four digits again.';
        } else if (entered === firstPass) {
          await DB.settings.set('pin', entered);
          S.mode = 'adult';
          const named = await DB.settings.get('cornerName');
          go(named ? 'home' : 'setup');
        } else {
          firstPass = null; entered = ''; paint();
          wrap.querySelector('#pt').textContent = 'Choose a grown-up code';
          wrap.querySelector('#err').textContent = 'Those didn’t match — start again.';
        }
      } else if (entered === savedPin) {
        S.mode = 'adult';
        const named = await DB.settings.get('cornerName');
        go(named ? 'home' : 'setup');
      } else {
        entered = ''; paint();
        wrap.querySelector('#err').textContent = 'That’s not it — try again.';
      }
    }
  }

  // =========================================================
  // ADULT MODE
  // =========================================================
  async function adultSetup(root) {
    root.appendChild(el(
      '<div class="kicker">first things first</div>' +
      '<h1 class="screen-title">Whose corner is this?</h1>' +
      '<p class="screen-sub">One child, one corner. Their shelf, the voices they love.</p>'));
    const card = el(
      '<div class="card"><div class="field"><label>The child’s name</label>' +
      '<input type="text" id="nm" placeholder="e.g. Mei" maxlength="30"></div>' +
      '<button class="btn primary big" id="save">Make the corner</button>' +
      '<p class="hint" style="margin-top:12px">Moving from another device? Make the corner, then restore your backup under “Keep it safe.”</p></div>');
    root.appendChild(card);
    card.querySelector('#save').onclick = async () => {
      const v = card.querySelector('#nm').value.trim();
      if (!v) return toast('A name makes it theirs.');
      await DB.settings.set('cornerName', v);
      go('home');
    };
  }

  async function adultHome(root, cornerName) {
    const [readers, books, requests, readings] = await Promise.all([DB.readers.all(), DB.books.all(), DB.requests.all(), DB.readings.all()]);
    const open = requests.filter(r => r.status === 'open');
    const since = (await DB.settings.get('readingsSinceBackup')) || 0;
    const lastBackup = await DB.settings.get('lastBackupAt');
    const safetyDesc = since >= 1
      ? since + ' reading' + (since === 1 ? '' : 's') + ' not backed up yet'
      : lastBackup ? 'Backed up ' + new Date(lastBackup).toLocaleDateString() : 'Download everything as one file';
    root.appendChild(el(
      '<div class="kicker">' + esc(cornerName || 'the corner') + '</div>' +
      '<h1 class="screen-title">What would you like to do?</h1>'));

    if (S.shared) {
      const sh = el(
        '<button class="home-card" style="border-color:var(--warm); background:var(--highlight)">' +
        '<span class="ic">🎙</span><span class="t">A recording arrived</span>' +
        '<span class="d">“' + esc(S.shared.name) + '” was shared from another app — turn it into a reading now. (It isn’t saved until you do.)</span></button>');
      sh.onclick = async () => {
        const got = await consumeShared();
        if (!got || !got.duration) return toast('That file couldn’t be read as audio.');
        startRecordFlow({ audioBlob: got.blob, duration: got.duration, imported: true });
      };
      root.appendChild(sh);
    }

    const grid = el('<div class="home-grid"></div>');
    const cards = [
      ['record', '🎙️', 'Record a reading', 'Just read — pages come after. Or import a recording you already have.'],
      ['books', '📚', 'The library', books.length + ' book' + (books.length === 1 ? '' : 's') + ' · ' + readings.length + ' reading' + (readings.length === 1 ? '' : 's')],
      ['readers', '👥', 'The people who read', readers.length ? readers.map(r => r.name).join(', ') : 'Add the people who read to ' + esc(cornerName || 'your child')],
      ['requests', '📬', 'Book requests', open.length ? open.length + ' open request' + (open.length === 1 ? '' : 's') : 'Ask someone to read a favorite'],
      ['safety', '🗄️', 'Keep it safe', safetyDesc],
    ];
    for (const [id, ic, t, d] of cards) {
      const c = el('<button class="home-card"><span class="ic">' + ic + '</span><span class="t">' + t + '</span><span class="d">' + d + '</span></button>');
      if (id === 'safety' && since >= 3) c.style.borderColor = 'var(--warm)';
      c.onclick = () => {
        if (id === 'record') startRecordFlow();
        else go(id);
      };
      grid.appendChild(c);
    }
    root.appendChild(grid);

    const helpLine = el('<p class="hint" style="margin-top:14px">🎙 Someone already recorded a voice memo on their phone? <a href="#" id="memohelp">Here’s how to bring it in</a>.</p>');
    helpLine.querySelector('#memohelp').onclick = e => { e.preventDefault(); go('memoHelp'); };
    root.appendChild(helpLine);
  }

  // =========================================================
  // VOICE-MEMO GUIDE — how a memo becomes a reading, per platform
  // =========================================================
  async function memoHelp(root) {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

    root.appendChild(el(
      '<h1 class="screen-title">Bringing a voice memo in</h1>' +
      '<p class="screen-sub">A recording made anywhere — Grandma’s Voice Memos, any recorder app — can become a reading here. The steps depend on the phone.</p>'));

    const stepCard = (kicker, title, steps, note) => el(
      '<div class="card" style="margin-bottom:14px"><div class="kicker">' + kicker + '</div>' +
      '<h2 class="serif" style="font-size:19px; font-weight:600; margin-top:6px">' + title + '</h2>' +
      '<div class="stack" style="margin-top:12px">' +
      steps.map((s, i) =>
        '<div class="rowitem"><span class="av" style="background:var(--accent); width:26px; height:26px; font-size:13px">' + (i + 1) + '</span>' +
        '<div class="grow"><div class="d" style="font-size:13.5px; color:var(--ink)">' + s + '</div></div></div>').join('') +
      '</div>' + (note ? '<p class="hint" style="margin-top:10px">' + note + '</p>' : '') + '</div>');

    const installCard = stepCard('first, once per device', 'Put Catherine’s Corner on the home screen',
      isIOS
        ? ['In <b>Safari</b>, tap the share button <b>⎋</b> (the square with the arrow).',
           'Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.']
        : ['In <b>Chrome</b>, tap the <b>⋮</b> menu (top right).',
           'Tap <b>Add to home screen</b> (or <b>Install app</b>), then confirm.'],
      isIOS
        ? 'This protects the recordings from Safari’s storage clean-ups.'
        : 'This is the step that adds <b>Catherine’s Corner to the phone’s share menu</b> — without it, the share option below won’t appear.');
    if (standalone) installCard.querySelector('.kicker').textContent = 'already done on this device ✓';

    const iosCard = stepCard('on iPhone', 'Voice Memos → Files → here',
      ['In <b>Voice Memos</b>, open the recording and tap <b>⋯</b> (or select it and tap the share button).',
       'Tap <b>Share</b> → <b>Save to Files</b> and pick any folder. <i>(Voice Memos don’t appear in Files until you do this — that’s an Apple thing, not yours.)</i>',
       'Back here: <b>for grown-ups → Record a reading</b>, pick who’s reading and the book.',
       'On the “read &amp; record” step, tap <b>⤓ Import audio</b> → <b>Choose Files</b> → pick the memo.'],
      'iPhones don’t let web apps into the share menu yet, so Files is the bridge.');

    const androidCard = stepCard('on Android', 'Share straight to Catherine’s Corner',
      ['In the recorder app, tap <b>Share</b> on the recording.',
       'Pick <b>Catherine’s Corner</b> in the share menu <i>(appears after the home-screen step above)</i>.',
       'The app opens; go to <b>for grown-ups</b> — a “recording arrived” card is waiting.',
       'Tap it, pick who’s reading and the book, and it goes straight to lining up the pages.'],
      null);

    root.appendChild(installCard);
    if (isIOS) { root.appendChild(iosCard); root.appendChild(androidCard); }
    else { root.appendChild(androidCard); root.appendChild(iosCard); }

    const back = el('<button class="back">‹ grown-up home</button>');
    back.onclick = () => go('home');
    root.appendChild(back);
  }

  async function adultSafety(root, cornerName) {
    const [readings, lastBackup] = await Promise.all([DB.readings.all(), DB.settings.get('lastBackupAt')]);
    root.appendChild(el(
      '<h1 class="screen-title">Keep it safe</h1>' +
      '<p class="screen-sub">Everything lives on this device. A backup puts the whole corner — every voice, every page — into one plain zip file you can keep anywhere and open with anything, even without this app.</p>'));

    const card = el(
      '<div class="card"><div class="kicker">back up</div>' +
      '<p class="hint" style="margin-top:8px">' + readings.length + ' reading' + (readings.length === 1 ? '' : 's') + ' on this device' +
      (lastBackup ? ' · last backup ' + new Date(lastBackup).toLocaleDateString() : ' · never backed up') + '</p>' +
      '<div class="btn-row"><button class="btn primary big" id="backup" ' + (readings.length ? '' : 'disabled') + '>⤓ Back up everything</button></div></div>');
    root.appendChild(card);
    card.querySelector('#backup').onclick = async () => {
      const btn = card.querySelector('#backup');
      btn.disabled = true; btn.textContent = 'Packing the corner…';
      try {
        const blob = await Backup.exportAll();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'catherines-corner-backup-' + new Date().toISOString().slice(0, 10) + '.zip';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 30000);
        await DB.settings.set('lastBackupAt', Date.now());
        await DB.settings.set('readingsSinceBackup', 0);
        toast('Backed up — keep that file somewhere safe.');
        render();
      } catch (err) {
        toast('Backup didn’t finish: ' + err.message);
        btn.disabled = false; btn.textContent = '⤓ Back up everything';
      }
    };

    const rcard = el(
      '<div class="card" style="margin-top:14px"><div class="kicker">restore</div>' +
      '<p class="hint" style="margin-top:8px">Bring a backup file from this or another device. Restoring adds to what’s here — it never deletes anything.</p>' +
      '<div class="btn-row"><span class="btn filebtn">⤒ Restore a backup<input type="file" id="restorefile" accept=".zip,application/zip"></span></div></div>');
    root.appendChild(rcard);
    rcard.querySelector('#restorefile').onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const counts = await Backup.importFile(f);
        for (const key of [...urlCache.keys()]) dropURL(key);
        toast('Restored ' + counts.readings + ' reading' + (counts.readings === 1 ? '' : 's') + ', ' +
          counts.books + ' book' + (counts.books === 1 ? '' : 's') + ', ' + counts.readers + ' reader' + (counts.readers === 1 ? '' : 's') + '.');
        render();
      } catch (err) {
        toast(err.message || 'That file couldn’t be restored.');
      }
    };

    root.appendChild(el(
      '<p class="hint" style="margin-top:14px">New phone, or lending it to family? <a href="check.html">Run the 30-second device check</a> to make sure recording and storage behave there.</p>'));

    const back = el('<button class="back">‹ grown-up home</button>');
    back.onclick = () => go('home');
    root.appendChild(back);
  }

  async function adultReaders(root) {
    const readers = await DB.readers.all();
    root.appendChild(el(
      '<h1 class="screen-title">The people who read</h1>' +
      '<p class="screen-sub">Only people you add here can record. No strangers, ever.</p>'));
    const stack = el('<div class="stack"></div>');
    for (const r of readers) {
      const contact = [r.email, r.phone].filter(Boolean).join(' · ');
      const row = el(
        '<div class="rowitem">' + avatar(r) +
        '<div class="grow"><div class="t">' + esc(r.name) + '</div><div class="d">' + esc(r.relationship || '') + (contact ? ' · ' + esc(contact) : '') + '</div></div>' +
        '<button class="btn" data-c title="email & phone — used to send book requests">✉️ contact</button>' +
        '<button class="btn danger" data-x>remove</button></div>');
      row.querySelector('[data-c]').onclick = async () => {
        const em = prompt('Email for ' + r.name + '? (used to send book requests — leave blank for none)', r.email || '');
        if (em !== null) r.email = em.trim() || null;
        const ph = prompt('Phone number for ' + r.name + '? (used to text book requests — leave blank for none)', r.phone || '');
        if (ph !== null) r.phone = ph.trim() || null;
        if (em !== null || ph !== null) { await DB.readers.save(r); render(); }
      };
      row.querySelector('[data-x]').onclick = async () => {
        const rs = (await DB.readings.all()).filter(x => x.readerId === r.id);
        if (rs.length) return toast(r.name + ' has recordings on the shelf — those stay; remove them first.');
        await DB.readers.remove(r.id); render();
      };
      stack.appendChild(row);
    }
    root.appendChild(stack);

    const card = el(
      '<div class="card" style="margin-top:14px"><div class="kicker">add someone</div>' +
      '<div class="field" style="margin-top:10px"><label>Name</label><input type="text" id="nm" placeholder="e.g. Grandma Rose"></div>' +
      '<div class="field"><label>Who they are to the child</label><input type="text" id="rel" placeholder="e.g. Grandma"></div>' +
      '<div class="field"><label>Email (optional — so book requests can be emailed to them)</label><input type="email" id="em" placeholder="e.g. rose@example.com"></div>' +
      '<div class="field"><label>Phone (optional — so book requests can be texted to them)</label><input type="tel" id="ph" placeholder="e.g. +1 555 010 1234"></div>' +
      '<button class="btn primary" id="add">Add reader</button></div>');
    root.appendChild(card);
    card.querySelector('#add').onclick = async () => {
      const name = card.querySelector('#nm').value.trim();
      if (!name) return toast('A name, so the child knows whose voice it is.');
      await DB.readers.save({
        id: DB.uid(), name, relationship: card.querySelector('#rel').value.trim(),
        email: card.querySelector('#em').value.trim() || null,
        phone: card.querySelector('#ph').value.trim() || null,
        color: AV_COLORS[(await DB.readers.all()).length % AV_COLORS.length], createdAt: Date.now(),
      });
      render();
    };
    const back = el('<button class="back">‹ grown-up home</button>');
    back.onclick = () => go('home');
    root.appendChild(back);
  }

  async function adultBooks(root) {
    const books = await DB.books.all();
    const readings = await DB.readings.all();
    const told = readings.filter(r => !r.bookId);
    root.appendChild(el(
      '<h1 class="screen-title">The library</h1>' +
      '<p class="screen-sub">Your own books — photograph the copy you actually own, crayon marks and all.</p>'));
    const stack = el('<div class="stack"></div>');
    for (const b of books) {
      const n = readings.filter(r => r.bookId === b.id).length;
      const cover = b.cover ? '<img class="thumb" alt="" src="' + blobURL('cover-' + b.id, b.cover) + '">' : '<span class="chip">no cover</span>';
      const row = el(
        '<button class="rowitem">' + cover +
        '<div class="grow"><div class="t">' + esc(b.title) + '</div>' +
        '<div class="d">' + n + ' reading' + (n === 1 ? '' : 's') + ' · ' + (b.pages || []).length + ' page photo' + ((b.pages || []).length === 1 ? '' : 's') + '</div></div>' +
        '<span class="chev">›</span></button>');
      row.onclick = () => go('bookDetail', { bookId: b.id });
      stack.appendChild(row);
    }
    if (told.length) {
      const readers = await DB.readers.all();
      for (const st of told) {
        const rd = readers.find(r => r.id === st.readerId);
        const row = el(
          '<div class="rowitem"><span class="chip">🌙 told story</span>' +
          '<div class="grow"><div class="t">' + esc(st.title || 'A bedtime story') + '</div>' +
          '<div class="d">told by ' + esc(rd ? rd.name : '') + ' · ' + fmt(st.duration || 0) + '</div></div>' +
          '<button class="btn" data-ed title="adjust the gentle skips">✎ edit</button></div>');
        row.querySelector('[data-ed]').onclick = () => startEditFlow(st);
        stack.appendChild(row);
      }
    }
    if (!books.length && !told.length) stack.appendChild(el('<div class="empty"><div class="big">📖</div>No books yet.</div>'));
    root.appendChild(stack);

    const row = el('<div class="btn-row"><button class="btn primary" id="add">📷 Add a book</button></div>');
    root.appendChild(row);
    row.querySelector('#add').onclick = () => go('addBook');
    const back = el('<button class="back">‹ grown-up home</button>');
    back.onclick = () => go('home');
    root.appendChild(back);
  }

  async function adultAddBook(root) {
    root.appendChild(el(
      '<h1 class="screen-title">Add a new book</h1>' +
      '<p class="screen-sub">Photograph the cover of your own copy — we never pull book art from the internet.</p>'));
    let coverFile = null;
    const card = el(
      '<div class="card">' +
      '<div class="field"><label>Cover photo</label>' +
      '<span class="btn filebtn" id="cvbtn">📷 Photograph the cover<input type="file" id="cv" accept="image/*" capture="environment"></span>' +
      '<span class="hint" id="cvname">You can also add it later — or let your child design one (🖍️ on the book’s page).</span></div>' +
      '<div class="field"><label>Title</label><input type="text" id="ti" placeholder="e.g. Goodnight, Little Bear"></div>' +
      '<div class="btn-row"><button class="btn primary" id="save">Add to the library</button>' +
      '<button class="btn" id="design">🖍️ Design the cover instead</button></div></div>');
    root.appendChild(card);
    card.querySelector('#cv').onchange = e => {
      coverFile = e.target.files[0] || null;
      card.querySelector('#cvname').textContent = coverFile ? coverFile.name : 'You can also add it later — or let your child design one (🖍️ on the book’s page).';
    };
    async function createBook() {
      const title = card.querySelector('#ti').value.trim();
      if (!title) { toast('Every book needs its title.'); return null; }
      const b = { id: DB.uid(), title, cover: coverFile ? await readAsBlob(coverFile) : null, pages: [], createdAt: Date.now() };
      await DB.books.save(b);
      return b;
    }
    card.querySelector('#save').onclick = async () => {
      const b = await createBook();
      if (!b) return;
      toast('“' + b.title + '” is on the shelf.');
      // land where the features are: back into the record flow if we came from
      // there, otherwise the book's own page (record / import / ask / design).
      if (S.params.returnTo === 'recWhat') go('recWhat');
      else go('bookDetail', { bookId: b.id });
    };
    card.querySelector('#design').onclick = async () => {
      const b = await createBook();
      if (!b) return;
      go('studio', { bookId: b.id, returnTo: S.params.returnTo === 'recWhat' ? 'recWhat' : null });
    };
    const back = el('<button class="back">‹ the library</button>');
    back.onclick = () => go('books');
    root.appendChild(back);
  }

  async function adultBookDetail(root) {
    const book = await DB.books.get(S.params.bookId);
    if (!book) return go('books');
    const readings = await DB.readings.forBook(book.id);
    const readers = await DB.readers.all();
    root.appendChild(el(
      '<h1 class="screen-title">' + esc(book.title) + '</h1>' +
      '<p class="screen-sub">' + (book.pages || []).length + ' page photos · pages belong to the book, so every new voice reuses them.</p>'));

    const stack = el('<div class="stack"></div>');
    for (const r of readings.sort((a, b) => (a.episodeIndex ?? 0) - (b.episodeIndex ?? 0))) {
      const rd = readers.find(x => x.id === r.readerId);
      const label = (r.episodeIndex != null ? 'Chapter ' + r.episodeIndex + (r.title ? ' · ' + r.title : '') : 'The whole book');
      const row = el(
        '<div class="rowitem">' + avatar(rd) +
        '<div class="grow"><div class="t">' + esc(label) + '</div>' +
        '<div class="d">' + esc(rd ? rd.name : '') + ' · ' + fmt(r.duration || 0) +
        ((r.skipRanges || []).length ? ' · ' + r.skipRanges.length + ' gentle skip' + (r.skipRanges.length > 1 ? 's' : '') : '') + '</div></div>' +
        '<button class="btn" data-ed title="adjust the pages, turns and skips">✎ edit</button>' +
        '<button class="btn" data-dl>⤓ keep a copy</button>' +
        '<button class="btn" data-vx>🎞 video</button>' +
        '<button class="btn danger" data-x>delete</button></div>');
      row.querySelector('[data-ed]').onclick = () => startEditFlow(r);
      row.querySelector('[data-dl]').onclick = () => {
        const a = document.createElement('a');
        a.href = blobURL('aud-' + r.id, r.audioBlob);
        const ext = Backup.audioExt(r.audioBlob && r.audioBlob.type);
        a.download = (book.title + (r.episodeIndex != null ? ' - chapter ' + r.episodeIndex : '') + ' - ' + (rd ? rd.name : 'reading') + '.' + ext).replace(/[/\\?%*:|"<>]/g, '-');
        a.click();
      };
      row.querySelector('[data-vx]').onclick = async e => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          const out = await VideoExport.exportReading({
            reading: r, book, reader: rd,
            onProgress: p => { btn.textContent = '🎞 ' + Math.round(p * 100) + '%'; },
          });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(out.blob);
          a.download = (book.title + (r.episodeIndex != null ? ' - chapter ' + r.episodeIndex : '') + ' - ' + (rd ? rd.name : 'reading') + '.' + out.ext).replace(/[/\\?%*:|"<>]/g, '-');
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 30000);
          toast('Video ready — pages and voice in one file to share.');
        } catch (err) {
          toast('Video export didn’t finish: ' + (err && err.message || err));
        }
        btn.disabled = false;
        btn.textContent = '🎞 video';
      };
      row.querySelector('[data-x]').onclick = async () => {
        if (!confirm('Delete this reading? The voice recording cannot be brought back.')) return;
        await DB.readings.remove(r.id); dropURL('aud-' + r.id); render();
      };
      stack.appendChild(row);
    }
    if (!readings.length) stack.appendChild(el('<div class="empty">No readings of this book yet.</div>'));
    root.appendChild(stack);

    const row = el(
      '<div class="btn-row">' +
      '<button class="btn primary" id="rec">🎙️ Record this book</button>' +
      '<button class="btn" id="ask">📬 Ask someone to read it</button>' +
      '<button class="btn" id="art">🖍️ Design a colorful cover</button>' +
      '</div>');
    root.appendChild(row);
    row.querySelector('#rec').onclick = () => startRecordFlow({ bookId: book.id });
    row.querySelector('#ask').onclick = () => go('requests', { prefillBookId: book.id });
    row.querySelector('#art').onclick = () => go('studio', { bookId: book.id });
    const back = el('<button class="back">‹ the library</button>');
    back.onclick = () => go('books');
    root.appendChild(back);
  }

  // The words that travel to the loved one — with or without a chosen book.
  function requestMessage(kid, bookTitle, note) {
    return (kid || 'Someone little') + ' would love you to read ' +
      (bookTitle ? '“' + bookTitle + '” aloud' : 'them a story aloud — any book you love') +
      ' for their Catherine’s Corner' + (note ? ' — “' + note + '”' : '') +
      '. Record it on your phone (a voice memo is perfect) and send it over; it goes straight onto their shelf.';
  }

  async function adultRequests(root, cornerName) {
    const [requests, books, readers] = await Promise.all([DB.requests.all(), DB.books.all(), DB.readers.all()]);
    root.appendChild(el(
      '<h1 class="screen-title">Book requests</h1>' +
      '<p class="screen-sub">' + esc(cornerName || 'Your child') + ' asks; a loved one records — from anywhere. Send the request straight to their email or phone; when the recording is made here, mark it read.</p>'));

    const stack = el('<div class="stack"></div>');
    for (const q of requests.sort((a, b) => b.createdAt - a.createdAt)) {
      const rd = readers.find(r => r.id === q.readerId);
      const bk = books.find(b => b.id === q.bookId);
      const what = bk ? bk.title : (q.bookTitle || 'Anything they love — reader’s pick');
      const row = el(
        '<div class="rowitem reqitem">' +
        '<div class="reqhead"><span class="chip ' + (q.status === 'open' ? 'open' : '') + '">' + (q.status === 'open' ? 'open' : 'read ✓') + '</span>' +
        '<div class="grow"><div class="t">' + esc(what) + '</div>' +
        '<div class="d">asked of ' + esc(rd ? rd.name : 'anyone who loves them') + (q.note ? ' · “' + esc(q.note) + '”' : '') + '</div></div></div>' +
        (q.status === 'open'
          ? '<div class="btn-row reqbtns">' +
            '<button class="btn" data-em title="opens your mail app with the request written out">✉️ email</button>' +
            '<button class="btn" data-sm title="opens your messages app with the request written out">💬 text</button>' +
            '<button class="btn" data-share>⧉ share</button>' +
            '<button class="btn warm" data-rec>record now</button>' +
            '<button class="btn" data-done>mark read</button></div>'
          : '<div class="btn-row reqbtns"><button class="btn danger" data-x>remove</button></div>') +
        '</div>');
      if (q.status === 'open') {
        const text = requestMessage(cornerName, bk ? bk.title : q.bookTitle, q.note);
        // Hand mail/messages links to the OS the same way a tapped
        // <a href="mailto:…"> would — the pattern phones handle best.
        const launch = href => {
          const a = document.createElement('a');
          a.href = href;
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          a.remove();
        };
        row.querySelector('[data-em]').onclick = () => {
          launch('mailto:' + encodeURIComponent(rd && rd.email || '') +
            '?subject=' + encodeURIComponent('A reading for ' + (cornerName || 'someone little')) +
            '&body=' + encodeURIComponent(text));
        };
        row.querySelector('[data-sm]').onclick = () => {
          const num = rd && rd.phone ? rd.phone.replace(/[^\d+]/g, '') : '';
          // iOS wants "sms:num&body=", Android "sms:num?body=" — both open
          // the messages app with the request typed and ready to send.
          launch('sms:' + num + (IS_IOS ? '&' : '?') + 'body=' + encodeURIComponent(text));
        };
        row.querySelector('[data-share]').onclick = async () => {
          if (navigator.share) { try { await navigator.share({ text }); } catch (e) { /* user closed the sheet */ } }
          else { await navigator.clipboard.writeText(text); toast('Request copied — paste it into any message.'); }
        };
        row.querySelector('[data-rec]').onclick = () => startRecordFlow({ bookId: q.bookId, requestId: q.id, readerId: q.readerId });
        row.querySelector('[data-done]').onclick = async () => { q.status = 'done'; await DB.requests.save(q); render(); };
      } else {
        row.querySelector('[data-x]').onclick = async () => { await DB.requests.remove(q.id); render(); };
      }
      stack.appendChild(row);
    }
    if (!requests.length) stack.appendChild(el('<div class="empty"><div class="big">📬</div>No requests yet.</div>'));
    root.appendChild(stack);

    const card = el(
      '<div class="card" style="margin-top:14px"><div class="kicker">ask someone to read</div>' +
      '<div class="field" style="margin-top:10px"><label>Ask whom?</label><select id="rd"><option value="">anyone who loves them</option>' +
      readers.map(r => '<option value="' + r.id + '"' + (S.params.prefillReaderId === r.id ? ' selected' : '') + '>' + esc(r.name) +
        (r.email || r.phone ? '' : ' (no email or phone saved)') + '</option>').join('') + '</select>' +
      '<span class="hint">With an email or phone saved under “The people who read,” the ✉️ and 💬 buttons address the message for you.</span></div>' +
      '<div class="field"><label>Which book? (optional — they can pick)</label><select id="bk">' +
      '<option value="">any book they love — their pick</option>' +
      books.map(b => '<option value="' + b.id + '"' + (S.params.prefillBookId === b.id ? ' selected' : '') + '>' + esc(b.title) + '</option>').join('') +
      '</select><input type="text" id="bt" placeholder="…or type a title not in the library yet" style="margin-top:8px"></div>' +
      '<div class="field"><label>A little note (optional)</label><input type="text" id="nt" placeholder="e.g. do the bear voice!"></div>' +
      '<button class="btn primary" id="add">Add the request</button></div>');
    root.appendChild(card);
    card.querySelector('#add').onclick = async () => {
      const bookId = card.querySelector('#bk').value || null;
      const bookTitle = card.querySelector('#bt').value.trim();
      await DB.requests.save({
        id: DB.uid(), bookId, bookTitle: bookId ? null : (bookTitle || null),
        readerId: card.querySelector('#rd').value || null,
        note: card.querySelector('#nt').value.trim(), status: 'open', createdAt: Date.now(),
      });
      toast('Request added — send it on its way with ✉️ or 💬.');
      render();
    };
    const back = el('<button class="back">‹ grown-up home</button>');
    back.onclick = () => go('home');
    root.appendChild(back);
  }

  // =========================================================
  // COVER STUDIO — a child designs the book's colorful cover
  // =========================================================
  async function coverStudio(root) {
    const book = await DB.books.get(S.params.bookId);
    if (!book) return go('books');
    const COLORS = ['#E5484D', '#F76B15', '#FFC53D', '#46A758', '#0090FF', '#8E4EC6', '#E93D82', '#2C2722'];
    const BGS = ['#FFFFFF', '#FFF7E6', '#E6F3FF', '#FFE9F2', '#EAF7EA'];
    const STAMPS = ['🌙', '⭐', '🐻', '🦊', '🌈', '🚀'];
    const SIZES = [6, 14, 26];

    root.appendChild(el(
      '<h1 class="screen-title">Design the cover 🖍️</h1>' +
      '<p class="screen-sub">Hand it to the artist. Fingers welcome — draw, stamp, and it becomes the cover of “' + esc(book.title) + '”.</p>'));

    const wrap = el(
      '<div class="studio-wrap">' +
      '<canvas class="studio-canvas" id="cv" width="600" height="800"></canvas>' +
      '<div class="studio-tools">' +
      '<div class="tool-row" id="colors"></div>' +
      '<div class="tool-row"><span class="hint">brush</span><span id="sizes"></span><span class="hint" style="margin-left:10px">stamps</span><span id="stamps"></span></div>' +
      '<div class="tool-row"><span class="hint">paper</span><span id="bgs"></span>' +
      '<button class="btn" id="undo" style="margin-left:10px">↩ undo</button>' +
      '<button class="btn danger" id="clear">start over</button></div>' +
      '<div class="btn-row" style="justify-content:center">' +
      '<button class="btn primary big" id="save">Make it the cover</button>' +
      '</div></div></div>');
    root.appendChild(wrap);

    const cv = wrap.querySelector('#cv');
    const ctx = cv.getContext('2d');
    let color = COLORS[4], size = SIZES[1], stamp = null, bg = BGS[0];
    let drawing = false, undoStack = [];

    function paintBg(c) {
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, cv.width, cv.height);
    }
    paintBg(bg);

    function snapshot() {
      undoStack.push(ctx.getImageData(0, 0, cv.width, cv.height));
      if (undoStack.length > 25) undoStack.shift();
    }
    function pos(e) {
      const r = cv.getBoundingClientRect();
      return { x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height };
    }
    cv.addEventListener('pointerdown', e => {
      e.preventDefault();
      snapshot();
      const p = pos(e);
      if (stamp) {
        ctx.font = '90px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(stamp, p.x, p.y);
        return;
      }
      drawing = true;
      cv.setPointerCapture(e.pointerId);
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.strokeStyle = color;
      ctx.lineWidth = size;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + 0.1, p.y + 0.1);
      ctx.stroke();
    });
    cv.addEventListener('pointermove', e => {
      if (!drawing) return;
      const p = pos(e);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    });
    const stop = () => { drawing = false; };
    cv.addEventListener('pointerup', stop);
    cv.addEventListener('pointercancel', stop);

    const $colors = wrap.querySelector('#colors');
    COLORS.forEach(c => {
      const b = el('<button class="swatch' + (c === color ? ' sel' : '') + '" style="background:' + c + '" aria-label="color"></button>');
      b.onclick = () => {
        color = c; stamp = null;
        wrap.querySelectorAll('.swatch').forEach(s => s.classList.toggle('sel', s === b));
        wrap.querySelectorAll('.stamp').forEach(s => s.classList.remove('sel'));
      };
      $colors.appendChild(b);
    });
    const $sizes = wrap.querySelector('#sizes');
    SIZES.forEach(s => {
      const b = el('<button class="brushsize' + (s === size ? ' sel' : '') + '"><i style="width:' + (s * 0.8) + 'px;height:' + (s * 0.8) + 'px"></i></button>');
      b.onclick = () => {
        size = s; stamp = null;
        wrap.querySelectorAll('.brushsize').forEach(x => x.classList.toggle('sel', x === b));
        wrap.querySelectorAll('.stamp').forEach(x => x.classList.remove('sel'));
      };
      $sizes.appendChild(b);
    });
    const $stamps = wrap.querySelector('#stamps');
    STAMPS.forEach(st => {
      const b = el('<button class="stamp">' + st + '</button>');
      b.onclick = () => {
        stamp = st;
        wrap.querySelectorAll('.stamp').forEach(x => x.classList.toggle('sel', x === b));
        wrap.querySelectorAll('.brushsize').forEach(x => x.classList.remove('sel'));
      };
      $stamps.appendChild(b);
    });
    const $bgs = wrap.querySelector('#bgs');
    BGS.forEach(c => {
      const b = el('<button class="bgdot" style="background:' + c + '" aria-label="paper color"></button>');
      b.onclick = () => {
        snapshot();
        // repaint background behind the drawing: composite old art over new bg
        const art = ctx.getImageData(0, 0, cv.width, cv.height);
        const tmp = document.createElement('canvas');
        tmp.width = cv.width; tmp.height = cv.height;
        tmp.getContext('2d').putImageData(art, 0, 0);
        bg = c;
        paintBg(bg);
        ctx.drawImage(tmp, 0, 0);
      };
      $bgs.appendChild(b);
    });
    wrap.querySelector('#undo').onclick = () => {
      const prev = undoStack.pop();
      if (prev) ctx.putImageData(prev, 0, 0);
    };
    wrap.querySelector('#clear').onclick = () => { snapshot(); paintBg(bg); };
    const leave = () => {
      if (S.mode === 'kid') return go('shelf');
      if (S.params.returnTo === 'recWhat') return go('recWhat');
      go('bookDetail', { bookId: book.id });
    };
    wrap.querySelector('#save').onclick = () => {
      cv.toBlob(async blob => {
        book.cover = blob;
        await DB.books.save(book);
        dropURL('cover-' + book.id);
        toast('The artist’s cover is on the shelf. 🖍️');
        leave();
      }, 'image/png');
    };

    const back = el('<button class="back">' + (S.mode === 'kid' ? '‹ back to the shelf' : '‹ back') + '</button>');
    back.onclick = leave;
    root.appendChild(back);
  }

  // =========================================================
  // RECORD FLOW — who → what → shape → pass 1 → pass 2 → done
  // =========================================================
  function startRecordFlow(prefill) {
    S.rec = Object.assign({
      readerId: null, bookId: null, requestId: null,
      told: false, storyTitle: '',
      episode: false, episodeIndex: null, episodeTitle: '',
      audioBlob: null, duration: 0, imported: false,
      pageTurns: [], skipRanges: [],
    }, prefill || {});
    go('recWho');
  }

  // Reopen a saved reading in the pass-2 editor: page turns, page photos and
  // gentle skips stay editable after the book is done.
  function startEditFlow(reading) {
    S.rec = {
      editingId: reading.id,
      readerId: reading.readerId, bookId: reading.bookId || null, requestId: null,
      told: !reading.bookId, storyTitle: reading.title || '',
      episode: reading.episodeIndex != null, episodeIndex: reading.episodeIndex, episodeTitle: reading.title || '',
      audioBlob: reading.audioBlob, duration: reading.duration || 0, imported: !!reading.imported,
      pageTurns: (reading.pageTurns || []).slice(), skipRanges: (reading.skipRanges || []).slice(),
    };
    go('recPass2');
  }

  // Completed steps are buttons: any earlier step can be revisited without
  // losing what's already been chosen or recorded.
  function stepper(now, opts) {
    const linkable = !(opts && opts.static);
    const steps = ['Who’s reading', 'What are we reading', 'Read & record', 'Line up the pages', 'Saved'];
    return '<div class="stepper">' + steps.map((s, i) => {
      const label = (i + 1) + ' · ' + s;
      if (i < now && linkable) return '<button type="button" class="done" data-step="' + i + '" title="go back to this step">' + label + '</button>';
      return '<span class="' + (i < now ? 'done' : i === now ? 'now' : '') + '">' + label + '</span>';
    }).join('') + '</div>';
  }
  const STEP_SCREENS = ['recWho', 'recWhat', 'recPass1', 'recPass2'];
  $app.addEventListener('click', e => {
    const b = e.target.closest('.stepper [data-step]');
    if (!b || !S.rec) return;
    go(STEP_SCREENS[+b.dataset.step] || 'recWho');
  });

  async function recWho(root) {
    const readers = await DB.readers.all();
    root.appendChild(el(stepper(0) +
      '<h1 class="screen-title">Who’s reading today?</h1>' +
      '<p class="screen-sub">On a shared tablet, we just ask each time — no logins.</p>'));
    const stack = el('<div class="stack"></div>');
    for (const r of readers) {
      const p = el('<button class="pick">' + avatar(r) +
        '<span><span class="nm">' + esc(r.name) + '</span><br><span class="rel">' + esc(r.relationship || '') + '</span></span>' +
        '<span class="spacer"></span><span class="chev">›</span></button>');
      p.onclick = () => { S.rec.readerId = r.id; go('recWhat'); };
      stack.appendChild(p);
    }
    root.appendChild(stack);
    const addBtn = el('<div class="btn-row"><button class="btn" id="addr">+ Someone new</button></div>');
    root.appendChild(addBtn);
    addBtn.querySelector('#addr').onclick = () => go('readers');
    if (!readers.length) root.appendChild(el('<p class="hint" style="margin-top:8px">Add the first reader — Dad, Grandma, a big sister…</p>'));
    const back = el('<button class="back">‹ grown-up home</button>');
    back.onclick = () => go('home');
    root.appendChild(back);
  }

  async function recWhat(root) {
    const books = await DB.books.all();
    const requests = (await DB.requests.all()).filter(r => r.status === 'open');
    root.appendChild(el(stepper(1) +
      '<h1 class="screen-title">What are we reading?</h1>'));

    if (requests.length && !S.rec.bookId) {
      const box = el('<div class="card" style="margin-bottom:14px"><div class="kicker">they asked for…</div><div class="stack" style="margin-top:10px"></div></div>');
      const st = box.querySelector('.stack');
      for (const q of requests) {
        const bk = books.find(b => b.id === q.bookId);
        const anyBook = !q.bookId && !q.bookTitle;  // "read them anything" request
        const sel = S.rec.requestId === q.id;
        const p = el('<button class="pick"><span class="av" style="background:var(--warm)">📬</span>' +
          '<span><span class="nm">' + esc(bk ? bk.title : (q.bookTitle || 'Anything you love — your pick')) + '</span><br>' +
          '<span class="rel">' + (q.note ? '“' + esc(q.note) + '”' : 'an open request') + '</span></span>' +
          '<span class="spacer"></span>' + (sel ? '<span class="chip open">✓ recording this</span>' : '<span class="chev">›</span>') + '</button>');
        p.onclick = () => {
          if (bk) {
            if (S.rec.bookId !== bk.id) { S.rec.pageTurns = []; S.rec.newPages = []; } // another book's stamps/photos don't carry over
            S.rec.told = false; S.rec.bookId = bk.id; S.rec.requestId = q.id; go('recShape');
          } else if (anyBook) {
            S.rec.requestId = sel ? null : q.id;
            go('recWhat');
            if (!sel) toast('Lovely — now pick the book below, or tell a story.');
          } else toast('Add “' + q.bookTitle + '” to the library first, then record it.');
        };
        st.appendChild(p);
      }
      root.appendChild(box);
    }

    const stack = el('<div class="stack"></div>');
    for (const b of books) {
      const cover = b.cover ? '<img class="thumb" alt="" src="' + blobURL('cover-' + b.id, b.cover) + '">' : '<span class="av" style="background:var(--accent)">📖</span>';
      const p = el('<button class="rowitem">' + cover +
        '<div class="grow"><div class="t">' + esc(b.title) + '</div><div class="d">' + (b.pages || []).length + ' page photos already captured</div></div>' +
        '<span class="chev">›</span></button>');
      p.onclick = () => {
        if (S.rec.bookId !== b.id) { S.rec.pageTurns = []; S.rec.newPages = []; } // another book's stamps/photos don't carry over
        S.rec.told = false; S.rec.bookId = b.id; go('recShape');
      };
      stack.appendChild(p);
    }
    root.appendChild(stack);

    const row = el(
      '<div class="btn-row">' +
      '<button class="btn" id="newb">📷 A book not in the library yet</button>' +
      '<button class="btn" id="told">🌙 No book — just a story I’ll tell</button>' +
      '</div>');
    root.appendChild(row);
    row.querySelector('#newb').onclick = () => go('addBook', { returnTo: 'recWhat' });
    row.querySelector('#told').onclick = () => { S.rec.told = true; S.rec.bookId = null; S.rec.pageTurns = []; S.rec.newPages = []; go('recShape'); };
    const back = el('<button class="back">‹ who’s reading</button>');
    back.onclick = () => go('recWho');
    root.appendChild(back);
  }

  async function recShape(root) {
    // Told story: just name it. Book: whole book or a chapter (serials — like a show).
    if (S.rec.told) {
      root.appendChild(el(stepper(1) +
        '<h1 class="screen-title">A told story</h1>' +
        '<p class="screen-sub">The made-up ones are often the best ones. Give it a name the child will recognize.</p>'));
      const card = el('<div class="card"><div class="field"><label>What’s the story called?</label>' +
        '<input type="text" id="st" placeholder="e.g. The Dragon Who Couldn’t Sleep"></div>' +
        '<button class="btn primary big" id="next">Ready to tell it ›</button></div>');
      root.appendChild(card);
      card.querySelector('#next').onclick = () => {
        S.rec.storyTitle = card.querySelector('#st').value.trim() || 'A bedtime story';
        go(S.rec.audioBlob ? 'recPass2' : 'recPass1');
      };
      const back = el('<button class="back">‹ what are we reading</button>');
      back.onclick = () => go('recWhat');
      root.appendChild(back);
      return;
    }

    const book = await DB.books.get(S.rec.bookId);
    const nextIdx = await nextEpisodeIndex(S.rec.bookId, S.rec.readerId);
    root.appendChild(el(stepper(1) +
      '<h1 class="screen-title">' + esc(book.title) + '</h1>' +
      '<p class="screen-sub">Short book? Read it in one go. Long book? Read a chapter at a time — new chapters appear on the shelf like new episodes of a show.</p>'));
    const stack = el('<div class="stack"></div>');
    const whole = el('<button class="pick"><span class="av" style="background:var(--accent)">📖</span>' +
      '<span><span class="nm">The whole book</span><br><span class="rel">one sitting, start to finish</span></span>' +
      '<span class="spacer"></span><span class="chev">›</span></button>');
    whole.onclick = () => { S.rec.episode = false; go(S.rec.audioBlob ? 'recPass2' : 'recPass1'); };
    stack.appendChild(whole);
    const chap = el('<button class="pick"><span class="av" style="background:var(--warm)">' + nextIdx + '</span>' +
      '<span><span class="nm">' + (nextIdx === 1 ? 'Start it as a serial — Chapter 1' : 'The next chapter — Chapter ' + nextIdx) + '</span><br>' +
      '<span class="rel">for the big books · something to look forward to</span></span>' +
      '<span class="spacer"></span><span class="chev">›</span></button>');
    chap.onclick = () => {
      S.rec.episode = true; S.rec.episodeIndex = nextIdx;
      const t = prompt('A name for this chapter? (optional)', '');
      S.rec.episodeTitle = (t || '').trim();
      go(S.rec.audioBlob ? 'recPass2' : 'recPass1');
    };
    stack.appendChild(chap);
    root.appendChild(stack);
    const back = el('<button class="back">‹ what are we reading</button>');
    back.onclick = () => go('recWhat');
    root.appendChild(back);
  }

  async function recPass1(root) {
    const reader = await DB.readers.get(S.rec.readerId);
    const book = S.rec.bookId ? await DB.books.get(S.rec.bookId) : null;
    const what = S.rec.told ? (S.rec.storyTitle || 'your story')
      : book.title + (S.rec.episode ? ' — Chapter ' + S.rec.episodeIndex : '');

    root.appendChild(el(stepper(2) +
      '<h1 class="screen-title">Pass 1 — read & record</h1>' +
      '<p class="screen-sub">Just read ' + esc(what) + ' the way you always do. No camera, no page-tapping — that comes after, calmly. If little voices interrupt, pause, or keep it in: the interruptions are often the treasure.</p>'));

    // Came back from a later step? The recording made earlier is still here.
    if (S.rec.audioBlob) {
      const keep = el(
        '<div class="card" style="margin-bottom:14px; border-color:var(--warm)"><div class="kicker">already recorded</div>' +
        '<p class="hint" style="margin-top:6px">Your ' + fmt(S.rec.duration || 0) + ' recording from before is safe. Keep it — or record or import below to replace it.</p>' +
        '<div class="btn-row" style="margin-top:10px"><button class="btn primary" id="keep">Keep it — line up the pages ›</button></div></div>');
      keep.querySelector('#keep').onclick = () => go('recPass2');
      root.appendChild(keep);
    }

    const hero = el(
      '<div class="rec-hero">' +
      '<div><span class="rec-dot" id="dot"></span><span id="stat" class="hint">ready when you are' + (reader ? ', ' + esc(reader.name) : '') + '</span></div>' +
      '<div class="rec-time" id="tm">0:00</div>' +
      '<div class="btn-row" style="justify-content:center">' +
      '<button class="btn warm big" id="rec">● Start recording</button>' +
      '<button class="btn big" id="pause" style="display:none">❘❘ Pause</button>' +
      '<button class="btn primary big" id="stop" style="display:none">■ Done reading</button>' +
      '</div>' +
      '<p class="rec-note">…or bring a recording you already have — a voice memo works beautifully. ' +
      '<a href="#" id="p1help">Step-by-step: getting a voice memo in</a></p>' +
      '<div class="btn-row" style="justify-content:center">' +
      '<span class="btn filebtn" id="impbtn">⤓ Import audio<input type="file" id="imp"' +
      (IS_IOS ? '' : ' accept="audio/*,.m4a,.aac,.mp3,.wav,.caf"') + '></span>' +
      '</div></div>');
    root.appendChild(hero);

    let mediaRecorder = null, chunks = [], t0 = 0, elapsedBefore = 0, timer = null;
    const $tm = hero.querySelector('#tm'), $dot = hero.querySelector('#dot'), $stat = hero.querySelector('#stat');
    const $rec = hero.querySelector('#rec'), $pause = hero.querySelector('#pause'), $stop = hero.querySelector('#stop');

    function tickTime() {
      const t = elapsedBefore + (mediaRecorder && mediaRecorder.state === 'recording' ? (Date.now() - t0) / 1000 : 0);
      $tm.textContent = fmt(t);
    }

    $rec.onclick = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        chunks = [];
        mediaRecorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        mediaRecorder.onstop = () => {
          stream.getTracks().forEach(t => t.stop());
          clearInterval(timer);
          const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
          S.rec.audioBlob = blob;
          S.rec.duration = elapsedBefore + (t0 ? (Date.now() - t0) / 1000 : 0);
          S.rec.imported = false;
          go('recPass2');
        };
        mediaRecorder.start();
        t0 = Date.now(); elapsedBefore = 0;
        timer = setInterval(tickTime, 250);
        $dot.classList.add('live'); $stat.textContent = 'recording — just read';
        $rec.style.display = 'none'; $pause.style.display = ''; $stop.style.display = '';
      } catch (err) {
        toast('The microphone said no — check permissions and try again.');
      }
    };
    $pause.onclick = () => {
      if (!mediaRecorder) return;
      if (mediaRecorder.state === 'recording') {
        mediaRecorder.pause();
        elapsedBefore += (Date.now() - t0) / 1000; t0 = 0;
        $dot.classList.remove('live'); $stat.textContent = 'paused — little interruptions welcome';
        $pause.textContent = '▶ Keep reading';
      } else if (mediaRecorder.state === 'paused') {
        mediaRecorder.resume(); t0 = Date.now();
        $dot.classList.add('live'); $stat.textContent = 'recording — just read';
        $pause.textContent = '❘❘ Pause';
      }
    };
    $stop.onclick = () => {
      if (!mediaRecorder) return;
      if (mediaRecorder.state === 'paused') { /* elapsedBefore already counted */ t0 = 0; }
      else if (mediaRecorder.state === 'recording') { elapsedBefore += (Date.now() - t0) / 1000; t0 = 0; }
      mediaRecorder.stop();
    };
    hero.querySelector('#p1help').onclick = e => { e.preventDefault(); go('memoHelp'); };
    hero.querySelector('#imp').onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      // iOS hands over .m4a with a missing/odd mime type — normalize so
      // playback, backups, and download names all treat it as audio/mp4.
      const blob = Backup.normalizeAudioFile(f);
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      const accept = duration => {
        URL.revokeObjectURL(url);
        S.rec.audioBlob = blob;
        S.rec.duration = duration;
        S.rec.imported = true;
        go('recPass2');
      };
      a.onloadedmetadata = () => accept(isFinite(a.duration) ? a.duration : 0);
      a.onerror = () => {
        URL.revokeObjectURL(url);
        if ((blob.type || '').startsWith('audio/')) {
          // declared audio but this device can't read its length — keep it
          toast('Couldn’t read that recording’s length here — it’s kept as-is and will play where the format is supported.');
          accept(0);
        } else {
          e.target.value = '';
          toast('That file doesn’t look like a recording — pick an audio file (a voice memo works).');
        }
      };
    };

    const back = el('<button class="back">‹ back</button>');
    back.onclick = () => go('recShape');
    root.appendChild(back);
  }

  async function recPass2(root) {
    const editing = !!S.rec.editingId;
    const book = S.rec.bookId ? await DB.books.get(S.rec.bookId) : null;
    const pages = book ? (book.pages || []).slice() : [];
    // Pages added this session live on the draft (stored onto the Book at
    // save), so stepping back to re-record doesn't throw the photos away.
    S.rec.newPages = S.rec.newPages || [];
    const newPages = S.rec.newPages;
    let turns = (S.rec.pageTurns || []).slice().sort((a, b) => a - b);   // ms timestamps
    let skips = (S.rec.skipRanges || []).slice();
    let skipStart = null;
    // Every change lands back on the draft, so stepping back and forth — or
    // an accidental re-render — never loses the taps.
    function sync() { S.rec.pageTurns = turns.slice(); S.rec.skipRanges = skips.slice(); }

    root.appendChild(el((editing ? '' : stepper(3)) +
      '<h1 class="screen-title">' + (editing ? 'Adjust the pages & turns' : 'Pass 2 — line up the pages') + '</h1>' +
      '<p class="screen-sub">' + (S.rec.told
        ? 'A told story needs no pages — listen back if you like, mark anything to skip gently, and save.'
        : 'Play your reading back — or drag the slider anywhere — and tap at each page turn. Not sure where they fall? ✨ Suggest the turns looks at how much is printed on each page and spaces them out; every turn stays fixable.') + '</p>'));

    const url = URL.createObjectURL(S.rec.audioBlob);
    const audio = new Audio(url);
    player.audio = audio; // registered so navigating anywhere else stops playback
    const bar = el(
      '<div class="player"><div class="p-bar" style="border-top:none">' +
      '<button class="p-play" id="pp">▶</button>' +
      '<button class="p-nudge" id="b5" aria-label="back five seconds">↺5</button>' +
      '<button class="p-nudge" id="f5" aria-label="forward five seconds">5↻</button>' +
      '<div class="p-track" id="track"><i id="fill"></i></div>' +
      '<span class="p-time" id="time">0:00</span></div></div>');
    root.appendChild(bar);
    const $pp = bar.querySelector('#pp'), $fill = bar.querySelector('#fill'), $time = bar.querySelector('#time'), $track = bar.querySelector('#track');
    let raf = null;
    function dur() { return audio.duration && isFinite(audio.duration) ? audio.duration : (S.rec.duration || 0); }
    function paintBar() {
      const d = dur();
      $fill.style.width = d ? (audio.currentTime / d * 100) + '%' : '0%';
      $time.textContent = fmt(audio.currentTime) + ' / ' + fmt(d);
      paintStrip();
    }
    function tick() {
      if (player.audio !== audio) return;
      paintBar();
      raf = requestAnimationFrame(tick);
    }
    $pp.onclick = () => {
      if (audio.paused) { audio.play(); $pp.textContent = '❘❘'; tick(); }
      else { audio.pause(); $pp.textContent = '▶'; if (raf) cancelAnimationFrame(raf); }
    };
    makeScrubber($track, audio, dur, paintBar);
    bar.querySelector('#b5').onclick = () => { audio.currentTime = Math.max(0, audio.currentTime - 5); paintBar(); };
    bar.querySelector('#f5').onclick = () => { const d = dur(); audio.currentTime = d ? Math.min(d, audio.currentTime + 5) : audio.currentTime + 5; paintBar(); };
    audio.onended = () => { $pp.textContent = '▶'; if (raf) cancelAnimationFrame(raf); };

    let strip = null, tapBtn = null;
    if (!S.rec.told) {
      const sec = el(
        '<div style="margin-top:16px"><div class="kicker">the pages</div>' +
        '<div class="pagestrip" id="strip"></div>' +
        '<div class="btn-row">' +
        '<button class="btn warm big" id="tap" ' + (pages.length + newPages.length ? '' : 'disabled') + '>👆 Tap — page turn</button>' +
        '<button class="btn" id="suggest" ' + (pages.length + newPages.length > 1 ? '' : 'disabled') + '>✨ Suggest the turns</button>' +
        '<button class="btn" id="undo">undo last turn</button>' +
        '<span class="btn filebtn">📷 Add page photos<input type="file" id="pgs" accept="image/*" multiple></span>' +
        '</div>' +
        '<p class="hint">Each tap while listening stamps when the next page appears. Tap a page to jump to its moment; tap a stamped time to remove that turn. ' +
        (pages.length ? 'This book already has its pages — just tap along.' : '') + '</p></div>');
      root.appendChild(sec);
      strip = sec.querySelector('#strip');
      tapBtn = sec.querySelector('#tap');
      const sgBtn = sec.querySelector('#suggest');
      sec.querySelector('#pgs').onchange = async e => {
        for (const f of e.target.files) {
          const type = confirmType();
          newPages.push({ id: DB.uid(), type, blob: await readAsBlob(f) });
        }
        tapBtn.disabled = false;
        sgBtn.disabled = pages.concat(newPages).length < 2;
        paintStrip(true);
      };
      function confirmType() { return 'book_page'; } // typed art is a tap away post-v1; default = page of the book
      tapBtn.onclick = () => {
        const all = pages.concat(newPages);
        if (turns.length >= all.length - 1 && all.length) { toast('That’s every page — lovely.'); return; }
        turns.push(Math.round(audio.currentTime * 1000));
        turns.sort((a, b) => a - b);
        sync();
        paintStrip();
      };
      sec.querySelector('#undo').onclick = () => { turns.pop(); sync(); paintStrip(); };
      // Suggested turns: split the recording across the pages in proportion to
      // how much text each page photo carries — a starting point to fix by ear.
      sgBtn.onclick = async () => {
        const all = pages.concat(newPages);
        if (all.length < 2) return toast('Add the page photos first — then turns can be suggested.');
        const d = dur();
        if (!d) return toast('This recording’s length isn’t known yet — press play for a moment first.');
        sgBtn.disabled = true; sgBtn.textContent = '✨ reading the pages…';
        const weights = await Promise.all(all.map(p => pageInk(p.blob)));
        const total = weights.reduce((a, b) => a + b, 0) || all.length;
        let acc = 0;
        const out = [];
        for (let i = 0; i < all.length - 1; i++) { acc += weights[i]; out.push(Math.round((acc / total) * d * 1000)); }
        turns = out; sync(); paintStrip();
        sgBtn.disabled = false; sgBtn.textContent = '✨ Suggest the turns';
        toast('Turns placed by each page’s text — play it back and fix any of them by tapping or dragging the slider.');
      };
    }

    function paintStrip(rebuild) {
      if (!strip) return;
      const all = pages.concat(newPages);
      if (rebuild || strip.childElementCount !== all.length + 1) {
        strip.innerHTML = '';
        all.forEach((p, i) => {
          const pg = el('<div class="pg" data-i="' + i + '">' +
            '<img alt="" src="' + blobURL('pg-' + p.id, p.blob) + '"><span class="k">' + (i + 1) + '</span><span class="stamp" style="display:none"></span></div>');
          pg.querySelector('img').onclick = () => {
            const t = i === 0 ? 0 : turns[i - 1];
            if (t == null) return;
            audio.currentTime = t / 1000;
            paintBar();
          };
          pg.querySelector('.stamp').onclick = () => {
            if (turns[i - 1] == null) return;
            turns.splice(i - 1, 1); sync(); paintStrip();
          };
          strip.appendChild(pg);
        });
        const add = el('<button class="addpg">+ add<br>photos</button>');
        add.onclick = () => strip.parentElement.querySelector('#pgs').click();
        strip.appendChild(add);
      }
      const cur = (() => { let i = 0; for (const t of turns) { if (audio.currentTime * 1000 >= t) i++; } return i; })();
      strip.querySelectorAll('.pg').forEach((n, i) => {
        n.classList.toggle('current', i === cur);
        const st = n.querySelector('.stamp');
        if (i > 0 && turns[i - 1] != null) {
          st.style.display = '';
          st.textContent = fmt(turns[i - 1] / 1000) + ' ×';
          st.title = 'remove this turn';
        } else st.style.display = 'none';
      });
    }
    paintStrip(true);

    // gentle skips (non-destructive — playback skips, the audio is never cut)
    const skipSec = el(
      '<div style="margin-top:16px"><div class="kicker">gentle skips (optional)</div>' +
      '<p class="hint" style="margin-top:6px">If a long interruption should be skipped at playback, mark it here. Nothing is deleted — you can always change your mind.</p>' +
      '<div class="btn-row"><button class="btn" id="sk">⏱ Start a skip here</button></div>' +
      '<div class="skiplist" id="sl"></div></div>');
    root.appendChild(skipSec);
    const $sk = skipSec.querySelector('#sk'), $sl = skipSec.querySelector('#sl');
    function paintSkips() {
      $sl.innerHTML = '';
      skips.forEach((r, i) => {
        const row = el('<div class="sk">skip ' + fmt(r.start / 1000) + ' → ' + fmt(r.end / 1000) + '<button>keep it in</button></div>');
        row.querySelector('button').onclick = () => { skips.splice(i, 1); sync(); paintSkips(); };
        $sl.appendChild(row);
      });
    }
    $sk.onclick = () => {
      const t = Math.round(audio.currentTime * 1000);
      if (skipStart == null) { skipStart = t; $sk.textContent = '⏱ …end the skip here'; $sk.classList.add('warm'); }
      else {
        if (t > skipStart + 200) skips.push({ start: skipStart, end: t });
        skipStart = null; $sk.textContent = '⏱ Start a skip here'; $sk.classList.remove('warm');
        sync();
        paintSkips();
      }
    };
    paintSkips();

    function leaveEdit() {
      audio.pause(); if (raf) cancelAnimationFrame(raf);
      URL.revokeObjectURL(url);
      const bookId = S.rec.bookId;
      S.rec = null;
      go(bookId ? 'bookDetail' : 'books', bookId ? { bookId } : {});
    }

    const saveRow = el(
      '<div class="btn-row" style="margin-top:18px">' +
      '<button class="btn primary big" id="save">' + (editing ? 'Save the changes' : 'Save the reading') + '</button>' +
      '<button class="btn danger" id="discard">' + (editing ? 'cancel' : 'discard') + '</button></div>');
    root.appendChild(saveRow);
    saveRow.querySelector('#save').onclick = async () => {
      audio.pause(); if (raf) cancelAnimationFrame(raf);
      if (book && newPages.length) {
        book.pages = pages.concat(newPages);
        await DB.books.save(book);
      }
      if (editing) {
        const existing = await DB.readings.get(S.rec.editingId);
        if (existing) {
          existing.pageTurns = turns;
          existing.skipRanges = skips;
          await DB.readings.save(existing);
          toast('Saved — the shelf plays it the new way.');
        }
        leaveEdit();
        return;
      }
      const reading = {
        id: DB.uid(),
        bookId: S.rec.bookId || null,
        readerId: S.rec.readerId,
        title: S.rec.told ? S.rec.storyTitle : (S.rec.episodeTitle || null),
        episodeIndex: S.rec.episode ? S.rec.episodeIndex : null,
        audioBlob: S.rec.audioBlob,
        duration: S.rec.duration,
        imported: !!S.rec.imported,
        pageTurns: turns,
        skipRanges: skips,
        isNew: true,
        createdAt: Date.now(),
      };
      await DB.readings.save(reading);
      const since = (await DB.settings.get('readingsSinceBackup')) || 0;
      await DB.settings.set('readingsSinceBackup', since + 1);
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      if (S.rec.requestId) {
        const q = (await DB.requests.all()).find(x => x.id === S.rec.requestId);
        if (q) { q.status = 'done'; await DB.requests.save(q); }
      }
      URL.revokeObjectURL(url);
      go('recDone', { readingId: reading.id });
    };
    saveRow.querySelector('#discard').onclick = () => {
      if (editing) return leaveEdit();
      if (!confirm('Throw this recording away?')) return;
      audio.pause(); URL.revokeObjectURL(url); S.rec = null; go('home');
    };

    const back = el('<button class="back">' + (editing ? '‹ back (nothing changes)' : '‹ read & record') + '</button>');
    back.onclick = () => {
      if (editing) return leaveEdit();
      audio.pause(); if (raf) cancelAnimationFrame(raf);
      URL.revokeObjectURL(url);
      go('recPass1');
    };
    root.appendChild(back);
  }

  async function recDone(root, cornerName) {
    const reading = await DB.readings.get(S.params.readingId);
    const reader = await DB.readers.get(reading.readerId);
    const book = reading.bookId ? await DB.books.get(reading.bookId) : null;
    const what = book ? book.title + (reading.episodeIndex != null ? ' — Chapter ' + reading.episodeIndex : '') : (reading.title || 'A bedtime story');
    root.appendChild(el(stepper(4, { static: true }) +
      '<div class="rec-hero"><div style="font-size:44px">🌟</div>' +
      '<h1 class="screen-title" style="margin-top:10px">' + esc(reader ? reader.name : 'Your') + '’s reading is ready</h1>' +
      '<p class="screen-sub" style="margin:6px auto 0; max-width:44ch">“' + esc(what) + '” is on ' + esc(cornerName ? cornerName + '’s' : 'the') + ' shelf' +
      (reading.episodeIndex != null ? ' — they’ll see there’s a new chapter waiting.' : '.') + '</p>' +
      '<div class="btn-row" style="justify-content:center; margin-top:20px">' +
      '<button class="btn primary big" id="kid">See the shelf (kid mode)</button>' +
      (book ? '<button class="btn" id="another">Record the next chapter</button>' : '') +
      '<button class="btn" id="adjust">✎ Adjust the pages & turns</button>' +
      '<button class="btn ghost" id="home">grown-up home</button>' +
      '</div>' +
      '<p class="hint" style="margin-top:16px">Changed your mind about a turn or a skip? Nothing is locked — adjust it now, or any time later from the library.</p>' +
      '<p class="hint" style="margin-top:8px">Alpha reminder: this reading lives only on this device until you back it up (Keep it safe).</p>' +
      '</div>'));
    root.querySelector('#kid').onclick = () => { S.mode = 'kid'; go('shelf'); };
    if (book) root.querySelector('#another').onclick = () => startRecordFlow({ bookId: book.id, readerId: reading.readerId });
    root.querySelector('#adjust').onclick = () => startEditFlow(reading);
    root.querySelector('#home').onclick = () => go('home');
  }

  // ---------- boot ----------
  checkSharedInbox().finally(render);
})();
