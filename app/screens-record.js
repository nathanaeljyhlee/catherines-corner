/* Catherine's Corner — the record flow.
   who → what → shape → pass 1 (just read) → pass 2 (line up the pages) → done.
   Also the edit flow: a saved reading reopens in pass 2 at any time. */

(function () {
  'use strict';

  const { el, esc, fmt, toast, avatar, blobURL, makeScrubber, pageInk, capturePanel } = UI;
  const { S, go, register, player } = App;

  function startRecordFlow(prefill) {
    S.rec = Object.assign({
      readerId: null, bookId: null, requestId: null,
      told: false, storyTitle: '',
      episode: false, episodeIndex: null, episodeTitle: '',
      audioBlob: null, duration: 0, imported: false,
      pageTurns: [], skipRanges: [], pageFormat: null,
    }, prefill || {});
    go('recWho');
  }

  // Reopen a saved reading in the pass-2 editor: page turns, page photos and
  // gentle skips stay editable after the book is done.
  async function startEditFlow(reading) {
    const audioBlob = (await DB.audio.get(reading.id)) || reading.audioBlob || null;
    if (!audioBlob) return toast('This reading’s sound couldn’t be found on this device.');
    S.rec = {
      editingId: reading.id,
      readerId: reading.readerId, bookId: reading.bookId || null, requestId: null,
      told: !reading.bookId, storyTitle: reading.title || '',
      episode: reading.episodeIndex != null, episodeIndex: reading.episodeIndex, episodeTitle: reading.title || '',
      audioBlob, duration: reading.duration || 0, imported: !!reading.imported,
      pageTurns: (reading.pageTurns || []).slice(), skipRanges: (reading.skipRanges || []).slice(),
      pageFormat: null,
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
  document.getElementById('app').addEventListener('click', e => {
    const b = e.target.closest('.stepper [data-step]');
    if (!b || !S.rec) return;
    go(STEP_SCREENS[+b.dataset.step] || 'recWho');
  });

  register('recWho', async function recWho(root) {
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
  });

  register('recWhat', async function recWhat(root, ctx) {
    const cornerId = ctx.corner ? ctx.corner.id : null;
    const books = await DB.books.all(cornerId);
    const requests = (await DB.requests.all(cornerId)).filter(r => r.status === 'open');
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
  });

  async function nextEpisodeIndex(bookId, readerId) {
    const rows = (await DB.readings.forBook(bookId)).filter(r => r.readerId === readerId && r.episodeIndex != null);
    return rows.length ? Math.max(...rows.map(r => r.episodeIndex)) + 1 : 1;
  }

  register('recShape', async function recShape(root) {
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
  });

  register('recPass1', async function recPass1(root) {
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

    const hero = capturePanel({
      statusIdle: 'ready when you are' + (reader ? ', ' + esc(reader.name) : ''),
      note: '…or bring a recording you already have — a voice memo works beautifully. ' +
        '<a href="#" id="p1help">Step-by-step: getting a voice memo in</a>',
      onAudio: (blob, duration, imported) => {
        S.rec.audioBlob = blob;
        S.rec.duration = duration;
        S.rec.imported = imported;
        go('recPass2');
      },
    });
    root.appendChild(hero);
    hero.querySelector('#p1help').onclick = e => { e.preventDefault(); go('memoHelp'); };

    const back = el('<button class="back">‹ back</button>');
    back.onclick = () => go('recShape');
    root.appendChild(back);
  });

  register('recPass2', async function recPass2(root, ctx) {
    const editing = !!S.rec.editingId;
    const book = S.rec.bookId ? await DB.books.get(S.rec.bookId) : null;
    const pages = book ? (book.pages || []).slice() : [];
    // Pages added this session live on the draft (stored onto the Book at
    // save), so stepping back to re-record doesn't throw the photos away.
    S.rec.newPages = S.rec.newPages || [];
    const newPages = S.rec.newPages;
    if (book && !S.rec.pageFormat) S.rec.pageFormat = book.pageFormat || 'single';
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
        '<div class="seg" id="fmt" role="radiogroup" aria-label="what each photo shows">' +
        '<button data-v="single"' + (S.rec.pageFormat !== 'spread' ? ' class="on"' : '') + '>each photo is one page</button>' +
        '<button data-v="spread"' + (S.rec.pageFormat === 'spread' ? ' class="on"' : '') + '>two pages side by side</button>' +
        '</div>' +
        '<p class="hint" style="margin:6px 0 4px">Large-print picture books often work best as <b>spreads</b> — photograph both pages in one shot (hold the phone sideways): half as many taps, and at playback both pages show big in landscape.</p>' +
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
      const seg = sec.querySelector('#fmt');
      seg.querySelectorAll('button').forEach(b => {
        b.onclick = () => {
          S.rec.pageFormat = b.dataset.v;
          seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
          paintStrip(true);
        };
      });
      sec.querySelector('#pgs').onchange = e => {
        for (const f of e.target.files) {
          newPages.push({ id: DB.uid(), type: 'book_page', blob: f });
        }
        tapBtn.disabled = false;
        sgBtn.disabled = pages.concat(newPages).length < 2;
        paintStrip(true);
      };
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
      strip.classList.toggle('spread', S.rec.pageFormat === 'spread');
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

    async function saveBookIfChanged() {
      if (!book) return;
      const formatChanged = S.rec.pageFormat && S.rec.pageFormat !== (book.pageFormat || 'single');
      if (!newPages.length && !formatChanged) return;
      if (newPages.length) book.pages = pages.concat(newPages);
      if (S.rec.pageFormat) book.pageFormat = S.rec.pageFormat;
      await DB.books.save(book);
    }

    // A failed save must be loud AND lossless: the draft stays right here,
    // storage-full gets called by name, and no half-written rows are left.
    function saveErrorMessage(err) {
      const full = err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''));
      return full
        ? 'This device’s storage is full, so the reading was NOT saved — it’s still right here. Free some space, then tap save again.'
        : 'Saving didn’t finish — nothing was lost, your recording is still here. ' + ((err && err.message) || '') + ' Try again.';
    }

    const saveRow = el(
      '<div class="btn-row" style="margin-top:18px">' +
      '<button class="btn primary big" id="save">' + (editing ? 'Save the changes' : 'Save the reading') + '</button>' +
      '<button class="btn danger" id="discard">' + (editing ? 'cancel' : 'discard') + '</button></div>');
    root.appendChild(saveRow);
    saveRow.querySelector('#save').onclick = async e => {
      const btn = e.currentTarget;
      audio.pause(); if (raf) cancelAnimationFrame(raf);
      btn.disabled = true;
      try {
        await saveBookIfChanged();
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
        const corner = await DB.corners.active();
        const reading = {
          id: DB.uid(),
          cornerId: book ? (book.cornerId ?? (corner && corner.id)) : (corner && corner.id) || null,
          bookId: S.rec.bookId || null,
          readerId: S.rec.readerId,
          title: S.rec.told ? S.rec.storyTitle : (S.rec.episodeTitle || null),
          episodeIndex: S.rec.episode ? S.rec.episodeIndex : null,
          duration: S.rec.duration,
          imported: !!S.rec.imported,
          pageTurns: turns,
          skipRanges: skips,
          isNew: true,
          createdAt: Date.now(),
        };
        // metadata + voice in one transaction, read back before "saved"
        await DB.readings.saveWithAudio(reading, S.rec.audioBlob);
        // best-effort bookkeeping — never scary once the reading is safe
        try {
          const since = (await DB.settings.get('readingsSinceBackup')) || 0;
          await DB.settings.set('readingsSinceBackup', since + 1);
          await DB.requestPersistence();
          if (S.rec.requestId) {
            const q = await DB.requests.get(S.rec.requestId);
            if (q) { q.status = 'done'; await DB.requests.save(q); }
          }
        } catch (err) { /* the reading is saved; nudges can wait */ }
        URL.revokeObjectURL(url);
        go('recDone', { readingId: reading.id });
      } catch (err) {
        toast(saveErrorMessage(err));
        btn.disabled = false;
      }
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
  });

  register('recDone', async function recDone(root, ctx) {
    const reading = await DB.readings.get(S.params.readingId);
    const reader = await DB.readers.get(reading.readerId);
    const book = reading.bookId ? await DB.books.get(reading.bookId) : null;
    const cornerName = ctx.cornerName;
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

    // Close the loop: when the voice came from afar (an imported memo or a
    // fulfilled request), the giver never sees the shelf — tell them it
    // landed. The same send kit as requests, pre-addressed if we know them.
    const fromAfar = reading.imported || !!(S.rec && S.rec.requestId);
    if (reader && fromAfar) {
      const thanks = '“' + what + '” is tucked onto ' + (cornerName ? cornerName + '’s' : 'the') + ' shelf now — ' +
        (cornerName || 'the little one') + ' can hear your voice any night they like. Thank you for reading. 🌙';
      const card = el(
        '<div class="card" style="margin-top:14px"><div class="kicker">close the loop</div>' +
        '<p class="hint" style="margin-top:8px">' + esc(reader.name) + ' read this from afar — let them know it made it to the shelf. It means a lot on the other end.</p></div>');
      card.appendChild(Send.sendRow(reader, 'It’s on ' + (cornerName ? cornerName + '’s' : 'the') + ' shelf 🌙', thanks));
      root.appendChild(card);
    }
  });

  App.startRecordFlow = startRecordFlow;
  App.startEditFlow = startEditFlow;
})();
