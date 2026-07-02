/* Catherine's Corner — v1.1 web app (local-first).
   Two flows are the whole product: a grown-up records, a child plays.
   Kid mode is the default; the PIN is the switch (set lazily on first exit). */

(function () {
  'use strict';

  const $app = document.getElementById('app');
  const APP_VERSION = '1.2.0';
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
  };

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
      studio: coverStudio,
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
        '<span class="meta"><span class="t">' + esc(b.title) + '</span>' +
        '<span class="by"><span class="av-row">' +
        voiceIds.slice(0, 4).map(id => avatar(readerMap.get(id), 'sm')).join('') +
        '</span>' + (voiceIds.length === 1 ? esc((readerMap.get(voiceIds[0]) || {}).name || '') : voiceIds.length + ' voices') + '</span></span>' +
        '</button>');
      tile.onclick = () => openBookKid(b, rs, voiceIds);
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

    function tick() {
      if (!player.audio) return;
      applySkips(reading, audio);
      const d = audio.duration && isFinite(audio.duration) ? audio.duration : (reading.duration || 0);
      $fill.style.width = d ? (audio.currentTime / d * 100) + '%' : '0%';
      $time.textContent = fmt(audio.currentTime) + (d ? ' / ' + fmt(d) : '');
      const idx = currentPageIndex(reading, audio.currentTime);
      if (idx !== lastIdx) { lastIdx = idx; renderStage(idx); }
      player.raf = requestAnimationFrame(tick);
    }
    $pp.onclick = () => {
      if (audio.paused) { audio.play(); $pp.textContent = '❘❘'; tick(); }
      else { audio.pause(); $pp.textContent = '▶'; }
    };
    $track.onclick = (e) => {
      const r = $track.getBoundingClientRect();
      const d = audio.duration && isFinite(audio.duration) ? audio.duration : (reading.duration || 0);
      if (d) audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d;
    };
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
      '<p class="hint" id="ph">' + (creating ? 'Four digits. This keeps recording and settings away from little hands.' : 'Enter the four-digit code.') + '</p>' +
      '<div class="pin-dots" id="dots">' + '<i></i>'.repeat(4) + '</div>' +
      '<div class="pinpad" id="pad"></div>' +
      '<div class="pin-err" id="err"></div>' +
      '<button class="back" id="back">‹ back to the shelf</button>' +
      '</div>');
    root.appendChild(wrap);
    wrap.querySelector('#back').onclick = () => { S.mode = 'kid'; go('shelf'); };

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
      const row = el(
        '<div class="rowitem">' + avatar(r) +
        '<div class="grow"><div class="t">' + esc(r.name) + '</div><div class="d">' + esc(r.relationship || '') + '</div></div>' +
        '<button class="btn danger" data-x>remove</button></div>');
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
      '<button class="btn primary" id="add">Add reader</button></div>');
    root.appendChild(card);
    card.querySelector('#add').onclick = async () => {
      const name = card.querySelector('#nm').value.trim();
      if (!name) return toast('A name, so the child knows whose voice it is.');
      await DB.readers.save({
        id: DB.uid(), name, relationship: card.querySelector('#rel').value.trim(),
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
        stack.appendChild(el(
          '<div class="rowitem"><span class="chip">🌙 told story</span>' +
          '<div class="grow"><div class="t">' + esc(st.title || 'A bedtime story') + '</div>' +
          '<div class="d">told by ' + esc(rd ? rd.name : '') + ' · ' + fmt(st.duration || 0) + '</div></div></div>'));
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
      '<div class="btn-row"><button class="btn primary" id="save">Add to the library</button></div></div>');
    root.appendChild(card);
    card.querySelector('#cv').onchange = e => {
      coverFile = e.target.files[0] || null;
      card.querySelector('#cvname').textContent = coverFile ? coverFile.name : 'You can also add it later.';
    };
    card.querySelector('#save').onclick = async () => {
      const title = card.querySelector('#ti').value.trim();
      if (!title) return toast('Every book needs its title.');
      const b = { id: DB.uid(), title, cover: coverFile ? await readAsBlob(coverFile) : null, pages: [], createdAt: Date.now() };
      await DB.books.save(b);
      toast('“' + title + '” is on the shelf.');
      go(S.params.returnTo || 'books');
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
        '<button class="btn" data-dl>⤓ keep a copy</button>' +
        '<button class="btn" data-vx>🎞 video</button>' +
        '<button class="btn danger" data-x>delete</button></div>');
      row.querySelector('[data-dl]').onclick = () => {
        const a = document.createElement('a');
        a.href = blobURL('aud-' + r.id, r.audioBlob);
        a.download = (book.title + (r.episodeIndex != null ? ' - chapter ' + r.episodeIndex : '') + ' - ' + (rd ? rd.name : 'reading') + '.webm').replace(/[/\\?%*:|"<>]/g, '-');
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

  async function adultRequests(root, cornerName) {
    const [requests, books, readers] = await Promise.all([DB.requests.all(), DB.books.all(), DB.readers.all()]);
    root.appendChild(el(
      '<h1 class="screen-title">Book requests</h1>' +
      '<p class="screen-sub">' + esc(cornerName || 'Your child') + ' asks; a loved one records — from anywhere. Share the request; when the recording is made here, mark it read.</p>'));

    const stack = el('<div class="stack"></div>');
    for (const q of requests.sort((a, b) => b.createdAt - a.createdAt)) {
      const rd = readers.find(r => r.id === q.readerId);
      const bk = books.find(b => b.id === q.bookId);
      const row = el(
        '<div class="rowitem"><span class="chip ' + (q.status === 'open' ? 'open' : '') + '">' + (q.status === 'open' ? 'open' : 'read ✓') + '</span>' +
        '<div class="grow"><div class="t">' + esc(bk ? bk.title : q.bookTitle || 'A book') + '</div>' +
        '<div class="d">asked of ' + esc(rd ? rd.name : 'anyone who loves them') + (q.note ? ' · “' + esc(q.note) + '”' : '') + '</div></div>' +
        (q.status === 'open'
          ? '<button class="btn" data-share>share</button><button class="btn warm" data-rec>record now</button><button class="btn" data-done>mark read</button>'
          : '<button class="btn danger" data-x>remove</button>') +
        '</div>');
      if (q.status === 'open') {
        row.querySelector('[data-share]').onclick = async () => {
          const kid = await DB.settings.get('cornerName');
          const text = (kid || 'Someone little') + ' would love you to read “' + (bk ? bk.title : q.bookTitle) + '” aloud for their Catherine’s Corner' +
            (q.note ? ' — “' + q.note + '”' : '') + '. Record it on your phone (voice memo is perfect) and send it over; it goes straight onto their shelf.';
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
      '<div class="card" style="margin-top:14px"><div class="kicker">ask for a book</div>' +
      '<div class="field" style="margin-top:10px"><label>Which book?</label><select id="bk">' +
      '<option value="">— pick from the library —</option>' +
      books.map(b => '<option value="' + b.id + '"' + (S.params.prefillBookId === b.id ? ' selected' : '') + '>' + esc(b.title) + '</option>').join('') +
      '</select><input type="text" id="bt" placeholder="…or type a title not in the library yet" style="margin-top:8px"></div>' +
      '<div class="field"><label>Ask whom?</label><select id="rd"><option value="">anyone who loves them</option>' +
      readers.map(r => '<option value="' + r.id + '">' + esc(r.name) + '</option>').join('') + '</select></div>' +
      '<div class="field"><label>A little note (optional)</label><input type="text" id="nt" placeholder="e.g. do the bear voice!"></div>' +
      '<button class="btn primary" id="add">Add the request</button></div>');
    root.appendChild(card);
    card.querySelector('#add').onclick = async () => {
      const bookId = card.querySelector('#bk').value || null;
      const bookTitle = card.querySelector('#bt').value.trim();
      if (!bookId && !bookTitle) return toast('Which book shall we ask for?');
      await DB.requests.save({
        id: DB.uid(), bookId, bookTitle: bookId ? null : bookTitle,
        readerId: card.querySelector('#rd').value || null,
        note: card.querySelector('#nt').value.trim(), status: 'open', createdAt: Date.now(),
      });
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
    wrap.querySelector('#save').onclick = () => {
      cv.toBlob(async blob => {
        book.cover = blob;
        await DB.books.save(book);
        dropURL('cover-' + book.id);
        toast('The artist’s cover is on the shelf. 🖍️');
        go('bookDetail', { bookId: book.id });
      }, 'image/png');
    };

    const back = el('<button class="back">‹ back to the book</button>');
    back.onclick = () => go('bookDetail', { bookId: book.id });
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

  function stepper(now) {
    const steps = ['Who’s reading', 'What are we reading', 'Read & record', 'Line up the pages', 'Saved'];
    return '<div class="stepper">' + steps.map((s, i) =>
      '<span class="' + (i < now ? 'done' : i === now ? 'now' : '') + '">' + (i + 1) + ' · ' + s + '</span>').join('') + '</div>';
  }

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
        const p = el('<button class="pick"><span class="av" style="background:var(--warm)">📬</span>' +
          '<span><span class="nm">' + esc(bk ? bk.title : q.bookTitle) + '</span><br><span class="rel">' + (q.note ? '“' + esc(q.note) + '”' : 'an open request') + '</span></span>' +
          '<span class="spacer"></span><span class="chev">›</span></button>');
        p.onclick = () => {
          if (bk) { S.rec.bookId = bk.id; S.rec.requestId = q.id; go('recShape'); }
          else toast('Add “' + q.bookTitle + '” to the library first, then record it.');
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
      p.onclick = () => { S.rec.bookId = b.id; go('recShape'); };
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
    row.querySelector('#told').onclick = () => { S.rec.told = true; S.rec.bookId = null; go('recShape'); };
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
        go('recPass1');
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
    whole.onclick = () => { S.rec.episode = false; go('recPass1'); };
    stack.appendChild(whole);
    const chap = el('<button class="pick"><span class="av" style="background:var(--warm)">' + nextIdx + '</span>' +
      '<span><span class="nm">' + (nextIdx === 1 ? 'Start it as a serial — Chapter 1' : 'The next chapter — Chapter ' + nextIdx) + '</span><br>' +
      '<span class="rel">for the big books · something to look forward to</span></span>' +
      '<span class="spacer"></span><span class="chev">›</span></button>');
    chap.onclick = () => {
      S.rec.episode = true; S.rec.episodeIndex = nextIdx;
      const t = prompt('A name for this chapter? (optional)', '');
      S.rec.episodeTitle = (t || '').trim();
      go('recPass1');
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

    const hero = el(
      '<div class="rec-hero">' +
      '<div><span class="rec-dot" id="dot"></span><span id="stat" class="hint">ready when you are' + (reader ? ', ' + esc(reader.name) : '') + '</span></div>' +
      '<div class="rec-time" id="tm">0:00</div>' +
      '<div class="btn-row" style="justify-content:center">' +
      '<button class="btn warm big" id="rec">● Start recording</button>' +
      '<button class="btn big" id="pause" style="display:none">❘❘ Pause</button>' +
      '<button class="btn primary big" id="stop" style="display:none">■ Done reading</button>' +
      '</div>' +
      '<p class="rec-note">…or bring a recording you already have — a voice memo from Grandma’s phone works beautifully.</p>' +
      '<div class="btn-row" style="justify-content:center">' +
      '<span class="btn filebtn" id="impbtn">⤓ Import audio<input type="file" id="imp" accept="audio/*"></span>' +
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
    hero.querySelector('#imp').onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      S.rec.audioBlob = await readAsBlob(f);
      S.rec.imported = true;
      // measure duration
      const a = new Audio(URL.createObjectURL(f));
      a.onloadedmetadata = () => { S.rec.duration = isFinite(a.duration) ? a.duration : 0; URL.revokeObjectURL(a.src); go('recPass2'); };
      a.onerror = () => { S.rec.duration = 0; go('recPass2'); };
    };

    const back = el('<button class="back">‹ back</button>');
    back.onclick = () => go('recShape');
    root.appendChild(back);
  }

  async function recPass2(root) {
    const book = S.rec.bookId ? await DB.books.get(S.rec.bookId) : null;
    const pages = book ? (book.pages || []).slice() : [];
    let newPages = [];   // added this session (stored onto the Book at save)
    let turns = [];      // ms timestamps
    let skips = S.rec.skipRanges.slice();
    let skipStart = null;

    root.appendChild(el(stepper(3) +
      '<h1 class="screen-title">Pass 2 — line up the pages</h1>' +
      '<p class="screen-sub">' + (S.rec.told
        ? 'A told story needs no pages — listen back if you like, mark anything to skip gently, and save.'
        : 'Play your reading back and, as you listen, tap at each page turn. Add page photos (or the child’s drawings) — or reuse the ones this book already has.') + '</p>'));

    const url = URL.createObjectURL(S.rec.audioBlob);
    const audio = new Audio(url);
    const bar = el(
      '<div class="player"><div class="p-bar" style="border-top:none">' +
      '<button class="p-play" id="pp">▶</button>' +
      '<div class="p-track" id="track"><i id="fill"></i></div>' +
      '<span class="p-time" id="time">0:00</span></div></div>');
    root.appendChild(bar);
    const $pp = bar.querySelector('#pp'), $fill = bar.querySelector('#fill'), $time = bar.querySelector('#time'), $track = bar.querySelector('#track');
    let raf = null;
    function dur() { return audio.duration && isFinite(audio.duration) ? audio.duration : (S.rec.duration || 0); }
    function tick() {
      const d = dur();
      $fill.style.width = d ? (audio.currentTime / d * 100) + '%' : '0%';
      $time.textContent = fmt(audio.currentTime) + ' / ' + fmt(d);
      paintStrip();
      raf = requestAnimationFrame(tick);
    }
    $pp.onclick = () => {
      if (audio.paused) { audio.play(); $pp.textContent = '❘❘'; tick(); }
      else { audio.pause(); $pp.textContent = '▶'; if (raf) cancelAnimationFrame(raf); }
    };
    $track.onclick = e => {
      const r = $track.getBoundingClientRect();
      const d = dur();
      if (d) audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d;
    };
    audio.onended = () => { $pp.textContent = '▶'; if (raf) cancelAnimationFrame(raf); };

    let strip = null, tapBtn = null;
    if (!S.rec.told) {
      const sec = el(
        '<div style="margin-top:16px"><div class="kicker">the pages</div>' +
        '<div class="pagestrip" id="strip"></div>' +
        '<div class="btn-row">' +
        '<button class="btn warm big" id="tap" ' + (pages.length ? '' : 'disabled') + '>👆 Tap — page turn</button>' +
        '<button class="btn" id="undo">undo last turn</button>' +
        '<span class="btn filebtn">📷 Add page photos<input type="file" id="pgs" accept="image/*" multiple></span>' +
        '</div>' +
        '<p class="hint">Each tap while listening stamps when the next page appears. ' + (pages.length ? 'This book already has its pages — just tap along.' : '') + '</p></div>');
      root.appendChild(sec);
      strip = sec.querySelector('#strip');
      tapBtn = sec.querySelector('#tap');
      sec.querySelector('#pgs').onchange = async e => {
        for (const f of e.target.files) {
          const type = confirmType();
          newPages.push({ id: DB.uid(), type, blob: await readAsBlob(f) });
        }
        tapBtn.disabled = false;
        paintStrip(true);
      };
      function confirmType() { return 'book_page'; } // typed art is a tap away post-v1; default = page of the book
      tapBtn.onclick = () => {
        const all = pages.concat(newPages);
        if (turns.length >= all.length - 1 && all.length) { toast('That’s every page — lovely.'); return; }
        turns.push(Math.round(audio.currentTime * 1000));
        turns.sort((a, b) => a - b);
        paintStrip();
      };
      sec.querySelector('#undo').onclick = () => { turns.pop(); paintStrip(); };
    }

    function paintStrip(rebuild) {
      if (!strip) return;
      const all = pages.concat(newPages);
      if (rebuild || strip.childElementCount !== all.length + 1) {
        strip.innerHTML = '';
        all.forEach((p, i) => {
          strip.appendChild(el('<div class="pg" data-i="' + i + '">' +
            '<img alt="" src="' + blobURL('pg-' + p.id, p.blob) + '"><span class="k">' + (i + 1) + '</span><span class="stamp" style="display:none"></span></div>'));
        });
        const add = el('<button class="addpg">+ add<br>photos</button>');
        add.onclick = () => strip.parentElement.querySelector('#pgs').click();
        strip.appendChild(add);
      }
      const cur = (() => { let i = 0; for (const t of turns) { if (audio.currentTime * 1000 >= t) i++; } return i; })();
      strip.querySelectorAll('.pg').forEach((n, i) => {
        n.classList.toggle('current', i === cur);
        const st = n.querySelector('.stamp');
        if (i > 0 && turns[i - 1] != null) { st.style.display = ''; st.textContent = fmt(turns[i - 1] / 1000); }
        else st.style.display = 'none';
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
        row.querySelector('button').onclick = () => { skips.splice(i, 1); paintSkips(); };
        $sl.appendChild(row);
      });
    }
    $sk.onclick = () => {
      const t = Math.round(audio.currentTime * 1000);
      if (skipStart == null) { skipStart = t; $sk.textContent = '⏱ …end the skip here'; $sk.classList.add('warm'); }
      else {
        if (t > skipStart + 200) skips.push({ start: skipStart, end: t });
        skipStart = null; $sk.textContent = '⏱ Start a skip here'; $sk.classList.remove('warm');
        paintSkips();
      }
    };
    paintSkips();

    const saveRow = el(
      '<div class="btn-row" style="margin-top:18px">' +
      '<button class="btn primary big" id="save">Save the reading</button>' +
      '<button class="btn danger" id="discard">discard</button></div>');
    root.appendChild(saveRow);
    saveRow.querySelector('#save').onclick = async () => {
      audio.pause(); if (raf) cancelAnimationFrame(raf);
      if (book && newPages.length) {
        book.pages = pages.concat(newPages);
        await DB.books.save(book);
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
      if (!confirm('Throw this recording away?')) return;
      audio.pause(); URL.revokeObjectURL(url); S.rec = null; go('home');
    };
  }

  async function recDone(root, cornerName) {
    const reading = await DB.readings.get(S.params.readingId);
    const reader = await DB.readers.get(reading.readerId);
    const book = reading.bookId ? await DB.books.get(reading.bookId) : null;
    const what = book ? book.title + (reading.episodeIndex != null ? ' — Chapter ' + reading.episodeIndex : '') : (reading.title || 'A bedtime story');
    root.appendChild(el(stepper(4) +
      '<div class="rec-hero"><div style="font-size:44px">🌟</div>' +
      '<h1 class="screen-title" style="margin-top:10px">' + esc(reader ? reader.name : 'Your') + '’s reading is ready</h1>' +
      '<p class="screen-sub" style="margin:6px auto 0; max-width:44ch">“' + esc(what) + '” is on ' + esc(cornerName ? cornerName + '’s' : 'the') + ' shelf' +
      (reading.episodeIndex != null ? ' — they’ll see there’s a new chapter waiting.' : '.') + '</p>' +
      '<div class="btn-row" style="justify-content:center; margin-top:20px">' +
      '<button class="btn primary big" id="kid">See the shelf (kid mode)</button>' +
      (book ? '<button class="btn" id="another">Record the next chapter</button>' : '') +
      '<button class="btn ghost" id="home">grown-up home</button>' +
      '</div>' +
      '<p class="hint" style="margin-top:16px">Alpha reminder: this reading lives only on this device until you back it up (Keep it safe).</p>' +
      '</div>'));
    root.querySelector('#kid').onclick = () => { S.mode = 'kid'; go('shelf'); };
    if (book) root.querySelector('#another').onclick = () => startRecordFlow({ bookId: book.id, readerId: reading.readerId });
    root.querySelector('#home').onclick = () => go('home');
  }

  // ---------- boot ----------
  render();
})();
