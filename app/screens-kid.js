/* Catherine's Corner — kid mode.
   The shelf, the voice picker, chapters, the player, and the cover studio.
   Everything here is play-only; the PIN gate is the only door out. */

(function () {
  'use strict';

  const { el, esc, fmt, toast, avatar, blobURL, dropURL, currentPageIndex, applySkips, makeScrubber } = UI;
  const { S, go, register, player } = App;

  // =========================================================
  // KID SHELF
  // =========================================================
  register('shelf', async function kidShelf(root, ctx) {
    const cornerId = ctx.corner ? ctx.corner.id : null;
    const [books, readers, told, allReadings] = await Promise.all([
      DB.books.all(cornerId), DB.readers.all(), DB.readings.told(cornerId), DB.readings.all(cornerId),
    ]);
    const readerMap = new Map(readers.map(r => [r.id, r]));

    root.appendChild(el(
      '<div class="shelf-head"><h1>' + esc(ctx.cornerName ? ctx.cornerName + '’s shelf' : 'Your shelf') + '</h1>' +
      '<button class="gate-link" id="gate">for grown-ups</button></div>'));
    root.querySelector('#gate').onclick = () => go('pin');

    // More than one child on this device? Their shelves sit side by side.
    if (ctx.corners.length > 1) {
      const pills = el('<div class="corner-pills"></div>');
      for (const c of ctx.corners.slice().sort((a, b) => a.createdAt - b.createdAt)) {
        const p = el('<button class="corner-pill' + (cornerId === c.id ? ' on' : '') + '">' + esc(c.name) + '</button>');
        p.onclick = async () => { await DB.corners.setActive(c.id); go('shelf'); };
        pills.appendChild(p);
      }
      root.appendChild(pills);
    }

    const withReadings = books.filter(b => allReadings.some(r => r.bookId === b.id));
    if (!withReadings.length && !told.length) {
      root.appendChild(el(
        '<div class="empty"><div class="big">🌙</div>Nothing on the shelf yet.<br>' +
        'A grown-up can record the first reading — or invite someone far away to read one.<br>' +
        'Tap “for grown-ups” above.</div>'));
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
  });

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

  register('voicePick', async function kidVoicePick(root) {
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
  });

  register('episodes', async function kidEpisodes(root) {
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
  });

  // =========================================================
  // PLAYER
  // =========================================================
  register('player', async function kidPlayer(root) {
    const reading = await DB.readings.get(S.params.readingId);
    if (!reading) return go('shelf');
    const audioBlob = (await DB.audio.get(reading.id)) || reading.audioBlob || null;
    if (!audioBlob) { toast('This reading’s sound couldn’t be found on this device.'); return go('shelf'); }
    const book = reading.bookId ? await DB.books.get(reading.bookId) : null;
    const reader = await DB.readers.get(reading.readerId);
    const pages = (book && book.pages) || [];
    const spread = !!(book && book.pageFormat === 'spread' && pages.length);

    if (reading.isNew) { reading.isNew = false; await DB.readings.save(reading); }

    const title = book ? book.title : (reading.title || 'A bedtime story');
    const sub = (reading.episodeIndex != null ? 'Chapter ' + reading.episodeIndex + ' · ' : '') +
      'read by ' + (reader ? reader.name : 'someone who loves you');

    const wrap = el(
      '<div class="player">' +
      '<div class="p-top"><div><div class="p-title">' + esc(title) + '</div><div class="p-by">' + esc(sub) + '</div></div>' +
      avatar(reader) + '</div>' +
      '<div class="p-stage' + (spread ? ' spread' : '') + '" id="stage"></div>' +
      '<div class="p-bar">' +
      '<button class="p-play" id="pp" aria-label="play">▶</button>' +
      '<div class="p-track" id="track"><i id="fill"></i></div>' +
      '<span class="p-time" id="time">0:00</span>' +
      '</div></div>');
    root.appendChild(wrap);
    // Spread pages are wide — let the player breathe in landscape.
    if (spread) document.getElementById('app').classList.add('wide');
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
        // Two-page spreads fit best sideways; the hint melts away in landscape (CSS).
        if (spread) stage.appendChild(el('<span class="rotate-hint">🔄 turn the screen sideways — both pages fit</span>'));
      } else if (book && book.cover) {
        stage.appendChild(el('<img alt="book cover" src="' + blobURL('cover-' + book.id, book.cover) + '">'));
      } else {
        stage.appendChild(el('<div class="noart"><div class="big">🌙</div><div class="cap">Close your eyes and listen.</div></div>'));
      }
    }
    renderStage(0);

    const audio = new Audio(blobURL('aud-' + reading.id, audioBlob));
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
  });

  // =========================================================
  // COVER STUDIO — a child designs the book's colorful cover
  // =========================================================
  register('studio', async function coverStudio(root) {
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
    const ctx2d = cv.getContext('2d');
    let color = COLORS[4], size = SIZES[1], stamp = null, bg = BGS[0];
    let drawing = false, undoStack = [];

    function paintBg(c) {
      ctx2d.fillStyle = c;
      ctx2d.fillRect(0, 0, cv.width, cv.height);
    }
    paintBg(bg);

    function snapshot() {
      undoStack.push(ctx2d.getImageData(0, 0, cv.width, cv.height));
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
        ctx2d.font = '90px serif';
        ctx2d.textAlign = 'center';
        ctx2d.textBaseline = 'middle';
        ctx2d.fillText(stamp, p.x, p.y);
        return;
      }
      drawing = true;
      cv.setPointerCapture(e.pointerId);
      ctx2d.lineCap = ctx2d.lineJoin = 'round';
      ctx2d.strokeStyle = color;
      ctx2d.lineWidth = size;
      ctx2d.beginPath();
      ctx2d.moveTo(p.x, p.y);
      ctx2d.lineTo(p.x + 0.1, p.y + 0.1);
      ctx2d.stroke();
    });
    cv.addEventListener('pointermove', e => {
      if (!drawing) return;
      const p = pos(e);
      ctx2d.lineTo(p.x, p.y);
      ctx2d.stroke();
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
        const art = ctx2d.getImageData(0, 0, cv.width, cv.height);
        const tmp = document.createElement('canvas');
        tmp.width = cv.width; tmp.height = cv.height;
        tmp.getContext('2d').putImageData(art, 0, 0);
        bg = c;
        paintBg(bg);
        ctx2d.drawImage(tmp, 0, 0);
      };
      $bgs.appendChild(b);
    });
    wrap.querySelector('#undo').onclick = () => {
      const prev = undoStack.pop();
      if (prev) ctx2d.putImageData(prev, 0, 0);
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
  });
})();
