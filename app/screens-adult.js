/* Catherine's Corner — grown-up mode.
   The PIN gate, setup, home, corners (one shelf per child), the library,
   the people who read, book requests, the voice-memo guide, and Keep it safe. */

(function () {
  'use strict';

  const { el, esc, fmt, toast, avatar, blobURL, dropURL, clearURLCache, AV_COLORS, backLink, downloadBlob, safeName } = UI;
  const { S, go, register, render } = App;

  // =========================================================
  // PIN GATE (lazy — set on first exit from kid mode)
  // =========================================================
  register('pin', async function pinScreen(root) {
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
          DB.metrics.bump('gate.pin_reset');
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
    async function enterAdult() {
      S.mode = 'adult';
      const corner = await DB.corners.active();
      go(corner ? 'home' : 'setup');
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
          await enterAdult();
        } else {
          firstPass = null; entered = ''; paint();
          wrap.querySelector('#pt').textContent = 'Choose a grown-up code';
          wrap.querySelector('#err').textContent = 'Those didn’t match — start again.';
        }
      } else if (entered === savedPin) {
        await enterAdult();
      } else {
        entered = ''; paint();
        wrap.querySelector('#err').textContent = 'That’s not it — try again.';
      }
    }

    // Desktop: type digits / Backspace on the keyboard, not just tapping the pad.
    // Self-cleans when the PIN screen is gone; ignores the "forgot code" sub-view.
    const onKey = (e) => {
      if (!document.body.contains(wrap)) { document.removeEventListener('keydown', onKey); return; }
      if (!wrap.querySelector('#pad')) return;
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); key(e.key); }
      else if (e.key === 'Backspace') { e.preventDefault(); key('⌫'); }
    };
    document.addEventListener('keydown', onKey);
  });

  // =========================================================
  // SETUP — the first corner
  // =========================================================
  register('setup', async function adultSetup(root) {
    root.appendChild(el(
      '<div class="kicker">first things first</div>' +
      '<h1 class="screen-title">Whose corner is this?</h1>' +
      '<p class="screen-sub">One child, one corner. Their shelf, the voices they love. (More children can get their own corners later.)</p>'));
    const card = el(
      '<div class="card"><div class="field"><label>The child’s name</label>' +
      '<input type="text" id="nm" placeholder="e.g. Mei" maxlength="30"></div>' +
      '<button class="btn primary big" id="save">Make the corner</button>' +
      '<p class="hint" style="margin-top:12px">Moving from another device? Make the corner, then under “Keep it safe” <b>sign in with your email to pull your cloud backup</b> — or bring in a backup file.</p></div>');
    root.appendChild(card);
    card.querySelector('#save').onclick = async () => {
      const v = card.querySelector('#nm').value.trim();
      if (!v) return toast('A name makes it theirs.');
      await DB.corners.create(v);
      go('home');
    };
  });

  // =========================================================
  // GROWN-UP HOME
  // =========================================================
  register('home', async function adultHome(root, ctx) {
    const cornerId = ctx.corner ? ctx.corner.id : null;
    const [readers, books, requests, readings] = await Promise.all([
      DB.readers.all(), DB.books.all(cornerId), DB.requests.all(cornerId), DB.readings.all(cornerId),
    ]);
    const open = requests.filter(r => r.status === 'open');
    const since = (await DB.settings.get('readingsSinceBackup')) || 0;
    const lastBackup = await DB.settings.get('lastBackupAt');
    const safetyDesc = since >= 1
      ? since + ' reading' + (since === 1 ? '' : 's') + ' not backed up yet'
      : lastBackup ? 'Backed up ' + new Date(lastBackup).toLocaleDateString() : 'Download everything as one file';
    root.appendChild(el(
      '<div class="kicker">' + esc(ctx.cornerName || 'the corner') +
      (ctx.corners.length > 1 ? ' · <button class="linklike" id="sw">switch corner</button>' : '') + '</div>' +
      '<h1 class="screen-title">What would you like to do?</h1>'));
    if (ctx.corners.length > 1) root.querySelector('#sw').onclick = () => go('corners');

    if (S.shared) {
      const sh = el(
        '<button class="home-card" style="border-color:var(--warm); background:var(--highlight)">' +
        '<span class="ic">🎙</span><span class="t">A recording arrived</span>' +
        '<span class="d">“' + esc(S.shared.name) + '” was shared from another app — turn it into a reading now. (It isn’t saved until you do.)</span></button>');
      sh.onclick = async () => {
        const got = await App.consumeShared();
        if (!got || !got.duration) return toast('That file couldn’t be read as audio.');
        App.startRecordFlow({ audioBlob: got.blob, duration: got.duration, imported: true });
      };
      root.appendChild(sh);
    }

    // First-boot import nudge: an existing user (has recordings, not signed in)
    // gets a one-time prompt to fold their pre-cloud library into cloud backup.
    if (window.Cloud && window.CloudAuth && !CloudAuth.isSignedIn() && readings.length && !(await DB.settings.get('cloudNudgeDismissed'))) {
      const nudge = el(
        '<button class="home-card" style="border-color:var(--warm); background:var(--highlight)">' +
        '<span class="ic">☁️</span><span class="t">New — keep these safe in the cloud</span>' +
        '<span class="d">Your recordings live only on this device today. Sign in once under Keep it safe and they’re backed up, so a lost device never means losing the voices. <span class="linklike" id="cloudlater">Not now</span></span></button>');
      nudge.onclick = (e) => {
        if (e.target && e.target.id === 'cloudlater') { e.stopPropagation(); DB.settings.set('cloudNudgeDismissed', 1).then(render); return; }
        go('safety');
      };
      root.appendChild(nudge);
    }

    const grid = el('<div class="home-grid"></div>');
    const cards = [
      ['record', '🎙️', 'Record a reading', 'Just read — pages come after. Or import a recording you already have.'],
      ['books', '📚', 'The library', books.length + ' book' + (books.length === 1 ? '' : 's') + ' · ' + readings.length + ' reading' + (readings.length === 1 ? '' : 's')],
      ['readers', '👥', 'The people who read', readers.length ? readers.map(r => r.name).join(', ') : 'Add the people who read to ' + esc(ctx.cornerName || 'your child')],
      ['requests', '📬', 'Book requests', open.length ? open.length + ' open request' + (open.length === 1 ? '' : 's') : 'Ask someone to read a favorite'],
      ['safety', '🗄️', 'Keep it safe', safetyDesc],
    ];
    for (const [id, ic, t, d] of cards) {
      const c = el('<button class="home-card"><span class="ic">' + ic + '</span><span class="t">' + t + '</span><span class="d">' + d + '</span></button>');
      if (id === 'safety' && since >= 3) c.style.borderColor = 'var(--warm)';
      c.onclick = () => {
        if (id === 'record') App.startRecordFlow();
        else go(id);
      };
      grid.appendChild(c);
    }
    root.appendChild(grid);

    // Before the first reading exists, the far-away option is easy to miss
    // three levels deep — surface it right where the journey starts.
    if (!readings.length) {
      const inv = el(
        '<button class="home-card" id="invite" style="margin-top:12px; width:100%; border-color:var(--warm); background:var(--highlight)">' +
        '<span class="ic">💌</span><span class="t">Someone far away can read the first one</span>' +
        '<span class="d">Send a book request to Grandma, Papa — anyone who loves ' + esc(ctx.cornerName || 'your child') + '. The request carries a link where they can record right away; you tuck what comes back onto the shelf.</span></button>');
      inv.onclick = () => go('requests');
      root.appendChild(inv);
    }

    const helpLine = el(
      '<p class="hint" style="margin-top:14px">🎙 Someone already recorded a voice memo on their phone? <a href="#" id="memohelp">Here’s how to bring it in</a>.' +
      '<br>👧 Reading to more than one child? <a href="#" id="cornerslink">Every child can have their own corner</a>.' +
      '<br>📊 Curious (or the maker asked)? <a href="#" id="usagelink">What gets used</a> — counts only, kept on this device.' +
      '<br>✨ <a href="#" id="wnlink">What’s new lately</a> — the walkthrough is always here, not just after an update.</p>');
    helpLine.querySelector('#memohelp').onclick = e => { e.preventDefault(); go('memoHelp'); };
    helpLine.querySelector('#cornerslink').onclick = e => { e.preventDefault(); go('corners'); };
    helpLine.querySelector('#usagelink').onclick = e => { e.preventDefault(); go('usage'); };
    helpLine.querySelector('#wnlink').onclick = e => { e.preventDefault(); go('whatsnew'); };
    root.appendChild(helpLine);
  });

  // =========================================================
  // CORNERS — one shelf per child, on the same device
  // =========================================================
  register('corners', async function adultCorners(root, ctx) {
    const [corners, readings, books] = await Promise.all([DB.corners.all(), DB.readings.all(), DB.books.all()]);
    root.appendChild(el(
      '<h1 class="screen-title">Corners</h1>' +
      '<p class="screen-sub">Each child gets their own corner: their shelf, their books, their requests. The people who read are shared — Grandma reads to everyone.</p>'));

    const stack = el('<div class="stack"></div>');
    for (const c of corners.sort((a, b) => a.createdAt - b.createdAt)) {
      const n = readings.filter(r => r.cornerId === c.id).length;
      const nb = books.filter(b => b.cornerId === c.id).length;
      const active = ctx.corner && ctx.corner.id === c.id;
      const row = el(
        '<div class="rowitem"><span class="av" style="background:var(--accent)">' + esc((c.name || '?')[0].toUpperCase()) + '</span>' +
        '<div class="grow"><div class="t">' + esc(c.name) + (active ? ' <span class="chip open">shelf showing</span>' : '') + '</div>' +
        '<div class="d">' + nb + ' book' + (nb === 1 ? '' : 's') + ' · ' + n + ' reading' + (n === 1 ? '' : 's') + '</div></div>' +
        (active ? '' : '<button class="btn" data-sw>show this shelf</button>') +
        '<button class="btn" data-rn>rename</button>' +
        (n || nb || corners.length === 1 ? '' : '<button class="btn danger" data-x>remove</button>') +
        '</div>');
      const sw = row.querySelector('[data-sw]');
      if (sw) sw.onclick = async () => { DB.metrics.bump('corners.switched'); await DB.corners.setActive(c.id); render(); };
      row.querySelector('[data-rn]').onclick = async () => {
        const v = prompt('This corner belongs to…', c.name);
        if (v && v.trim()) { c.name = v.trim().slice(0, 30); await DB.corners.save(c); render(); }
      };
      const x = row.querySelector('[data-x]');
      if (x) x.onclick = async () => { await DB.corners.remove(c.id); render(); };
      stack.appendChild(row);
    }
    root.appendChild(stack);

    const card = el(
      '<div class="card" style="margin-top:14px"><div class="kicker">another child</div>' +
      '<div class="field" style="margin-top:10px"><label>Their name</label><input type="text" id="nm" placeholder="e.g. Theo" maxlength="30"></div>' +
      '<button class="btn primary" id="add">Make their corner</button></div>');
    root.appendChild(card);
    card.querySelector('#add').onclick = async () => {
      const v = card.querySelector('#nm').value.trim();
      if (!v) return toast('A name makes it theirs.');
      await DB.corners.create(v);
      DB.metrics.bump('corners.added');
      toast(v + '’s corner is ready — their shelf is showing now.');
      go('home');
    };
    root.appendChild(backLink('‹ grown-up home', () => go('home')));
  });

  // =========================================================
  // VOICE-MEMO GUIDE — how a memo becomes a reading, per platform
  // =========================================================
  register('memoHelp', async function memoHelp(root) {
    DB.metrics.bump('help.memo_guide_opened');
    const isIOS = UI.IS_IOS;
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

    const backTo = S.params.returnTo === 'requests' ? 'requests' : 'home';
    root.appendChild(backLink('' + (backTo === 'requests' ? '‹ book requests' : '‹ grown-up home') + '', () => go(backTo)));
  });

  // =========================================================
  // KEEP IT SAFE — backup & restore
  // =========================================================
  register('safety', async function adultSafety(root) {
    const [readings, lastBackup, storage] = await Promise.all([
      DB.readings.all(), DB.settings.get('lastBackupAt'), DB.storageStatus(),
    ]);
    root.appendChild(el(
      '<h1 class="screen-title">Keep it safe</h1>' +
      '<p class="screen-sub">Everything lives on this device by default. A backup puts the whole corner — every child’s shelf, every voice, every page — into one plain zip file you can keep anywhere and open with anything, even without this app. You can also turn on cloud backup below, so a lost device never means losing the voices.</p>'));

    // Say honestly how this browser is treating the data.
    const gb = n => (n / 1073741824).toFixed(n >= 1073741824 ? 1 : 2);
    const parts = [];
    if (storage.persisted === true) parts.push('🛡 the browser has marked this corner as must-keep');
    else if (storage.persisted === false) parts.push('⚠️ storage here is <b>best-effort</b> — the browser may clean it under pressure, so back up often (home-screen install helps)');
    if (storage.usage != null && storage.quota) parts.push('about ' + gb(storage.usage) + ' GB used of the ~' + gb(storage.quota) + ' GB this browser allows');
    if (parts.length) {
      const line = el('<p class="hint" id="storagestatus" style="margin:-8px 0 14px">' + parts.join(' · ') +
        (storage.persisted === false ? ' · <a href="#" id="askpersist">ask the browser to protect it</a>' : '') + '</p>');
      const ask = line.querySelector('#askpersist');
      if (ask) ask.onclick = async e => {
        e.preventDefault();
        const ok = await DB.requestPersistence();
        toast(ok ? 'Protected — the browser will treat these recordings as must-keep.' : 'The browser didn’t agree yet — installing to the home screen usually convinces it.');
        render();
      };
      root.appendChild(line);
    }

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
        downloadBlob(await Backup.exportAll(), 'catherines-corner-backup-' + new Date().toISOString().slice(0, 10) + '.zip');
        await DB.settings.set('lastBackupAt', Date.now());
        await DB.settings.set('readingsSinceBackup', 0);
        DB.metrics.bump('safety.backup_done');
        toast('Backed up — keep that file somewhere safe.');
        render();
      } catch (err) {
        toast('Backup didn’t finish: ' + err.message);
        btn.disabled = false; btn.textContent = '⤓ Back up everything';
      }
    };

    // ---- Cloud backup (Stage 2) ----
    if (window.Cloud && window.CloudAuth) {
      const cloudLast = await DB.settings.get('cloudLastBackup');
      const ccard = el('<div class="card" style="margin-top:14px"><div class="kicker">cloud backup</div>' +
        '<p class="hint" style="margin-top:8px">Keep a copy safely in the cloud, so a lost or broken device never means losing the voices. You sign in with your email (this is your cloud account — separate from the grown-up code on this device), and your recordings stay private to your family.' +
        (cloudLast ? ' · last cloud backup ' + new Date(cloudLast).toLocaleDateString() : '') + '</p><div id="cloudbody"></div></div>');
      root.appendChild(ccard);
      const body = ccard.querySelector('#cloudbody');
      const signedIn = () => {
        body.innerHTML = '<p class="hint" style="margin:2px 0 8px">Signed in as <b>' + esc(CloudAuth.email() || '') + '</b></p>' +
          '<div class="btn-row"><button class="btn primary" id="cpush">☁️ Back up to the cloud</button>' +
          '<button class="btn" id="cpull">⤓ Restore from the cloud</button></div>' +
          '<p class="hint" style="margin-top:8px"><a href="#" id="cout">Sign out of cloud backup</a></p>';
        body.querySelector('#cpush').onclick = async () => {
          const b = body.querySelector('#cpush'); b.disabled = true; b.textContent = 'Backing up…';
          try { const r = await Cloud.pushBackup('this device'); await DB.settings.set('cloudLastBackup', Date.now()); DB.metrics.bump('cloud.backup_done'); toast('Backed up to the cloud — ' + r.uploaded + ' new item' + (r.uploaded === 1 ? '' : 's') + ' uploaded.'); render(); }
          catch (e) { toast('Cloud backup didn’t finish: ' + e.message); b.disabled = false; b.textContent = '☁️ Back up to the cloud'; }
        };
        body.querySelector('#cpull').onclick = async () => {
          const b = body.querySelector('#cpull'); b.disabled = true; b.textContent = 'Restoring…';
          try { const c = await Cloud.pullBackup(); clearURLCache(); DB.metrics.bump('cloud.restore_done'); toast('Restored from the cloud — ' + c.readings + ' reading' + (c.readings === 1 ? '' : 's') + '.'); render(); }
          catch (e) { toast(/404|no backup/i.test(e.message) ? 'No cloud backup found for this account yet.' : 'Restore didn’t finish: ' + e.message); b.disabled = false; b.textContent = '⤓ Restore from the cloud'; }
        };
        body.querySelector('#cout').onclick = async (e) => { e.preventDefault(); await CloudAuth.signOut(); render(); };
      };
      // Step 2: type the emailed code (works cross-device — read on your phone,
      // type on the tablet — unlike a link that would open on the wrong device).
      const codeStep = (email) => {
        body.innerHTML = '<p class="hint" style="margin:2px 0 8px">📧 We emailed a 6-digit code to <b>' + esc(email) + '</b>. Read it on any device and type it here — it works once, for 15 minutes.</p>' +
          '<div class="btn-row" style="gap:8px;flex-wrap:wrap"><input type="text" id="ccode" placeholder="6-digit code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" style="flex:1;min-width:130px;padding:10px;border:1px solid #d8cdbb;border-radius:10px;font:inherit;letter-spacing:3px"><button class="btn primary" id="cverify">Sign in</button></div>' +
          '<p class="hint" style="margin-top:8px"><a href="#" id="cresend">Send a new code</a> · on this same device you can also just tap the link in the email.</p>';
        body.querySelector('#cverify').onclick = async () => {
          const code = body.querySelector('#ccode').value.trim();
          if (!code) return toast('Enter the code from your email.');
          const b = body.querySelector('#cverify'); b.disabled = true; b.textContent = 'Signing in…';
          try {
            await CloudAuth.verifyCode(email, code);
            render();
            toast('Signed in. Backing up your recordings to the cloud…');
            const r = await Cloud.autoBackup('sign-in');   // fold the existing library up automatically
            if (r) { DB.metrics.bump('cloud.backup_done'); toast('Your recordings are safe in the cloud.'); render(); }
          }
          catch (e) { toast(e.message); b.disabled = false; b.textContent = 'Sign in'; }
        };
        body.querySelector('#cresend').onclick = async (e) => { e.preventDefault(); try { await CloudAuth.signIn(email); toast('A new code is on its way.'); } catch (err) { toast(err.message); } };
      };
      // Step 1: enter email to get a code.
      const signedOut = () => {
        body.innerHTML = '<div class="btn-row" style="gap:8px;flex-wrap:wrap"><input type="email" id="cemail" placeholder="your email" autocomplete="email" inputmode="email" style="flex:1;min-width:170px;padding:10px;border:1px solid #d8cdbb;border-radius:10px;font:inherit"><button class="btn primary" id="csend">✉️ Email me a code</button></div>';
        body.querySelector('#csend').onclick = async () => {
          const email = body.querySelector('#cemail').value.trim();
          if (!email) return toast('Enter your email first.');
          const b = body.querySelector('#csend'); b.disabled = true; b.textContent = 'Sending…';
          try { await CloudAuth.signIn(email); codeStep(email); }
          catch (e) { toast(e.message); b.disabled = false; b.textContent = '✉️ Email me a code'; }
        };
      };
      (CloudAuth.isSignedIn() ? signedIn : signedOut)();
    }

    const scard = el(
      '<div class="card" style="margin-top:14px"><div class="kicker">two devices?</div>' +
      '<p class="hint" style="margin-top:8px">📶 The family tablet and your phone can match shelves directly, over your own WiFi — no internet, nothing uploaded.</p>' +
      '<div class="btn-row"><button class="btn" id="syncbtn">🔁 Sync with a nearby device</button></div></div>');
    root.appendChild(scard);
    scard.querySelector('#syncbtn').onclick = () => go('sync');

    const rcard = el(
      '<div class="card" style="margin-top:14px"><div class="kicker">restore · accept a parcel</div>' +
      '<p class="hint" style="margin-top:8px">Bring in a backup from this or another device, or a 📦 parcel another family sent you. Nothing here ever deletes anything.</p>' +
      '<div class="btn-row"><span class="btn filebtn">⤒ Bring in a backup or parcel<input type="file" id="restorefile" accept=".zip,application/zip,application/x-zip-compressed,application/octet-stream"></span></div>' +
      '<p class="hint" style="margin-top:10px">Got it in Messages or WhatsApp? Tap the file there → share → <b>Save to Files</b>, then choose it here. ' +
      'If tapping it in Files unpacked a folder, that’s fine — still choose the original <b>.zip</b>.</p></div>');
    root.appendChild(rcard);
    rcard.querySelector('#restorefile').onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const { manifest: m, map } = await Backup.inspect(f);
        if (m.format === 'catherines-corner-parcel') return go('acceptParcel', { parcel: { m, map } });
        const counts = await Backup.importBackup(m, map);
        DB.metrics.bump('safety.restore_done');
        clearURLCache();
        toast('Restored ' + counts.readings + ' reading' + (counts.readings === 1 ? '' : 's') + ', ' +
          counts.books + ' book' + (counts.books === 1 ? '' : 's') + ', ' + counts.readers + ' reader' + (counts.readers === 1 ? '' : 's') + '.');
        render();
      } catch (err) {
        DB.metrics.bump('error.restore_failed');
        toast(err.message || 'That file couldn’t be restored.');
      }
    };

    // This install's shareable address — parcels from other families are
    // addressed to it, so they land on the right shelf with no server at all.
    const myId = await DB.familyId();
    const idcard = el(
      '<div class="card" style="margin-top:14px"><div class="kicker">your corner id</div>' +
      '<p style="margin-top:8px; font-variant-numeric:tabular-nums"><b style="font-size:18px; letter-spacing:.06em" id="fid">' + esc(myId) + '</b>' +
      ' <button class="btn" id="copyid" style="padding:5px 11px; font-size:12px; margin-left:8px">⧉ copy</button></p>' +
      '<p class="hint" style="margin-top:6px">Give it to family who keep their own Corner: when they 📦 send a book from their library, they address it to this id and it lands on your shelf.</p></div>');
    root.appendChild(idcard);
    idcard.querySelector('#copyid').onclick = async () => {
      try { await navigator.clipboard.writeText(myId); toast('Copied — send it to whoever wants to share with you.'); }
      catch (e) { prompt('Copy your Corner ID:', myId); }
    };

    root.appendChild(el(
      '<p class="hint" style="margin-top:14px">New phone, or lending it to family? <a href="check.html">Run the 30-second device check</a> to make sure recording and storage behave there.</p>'));

    root.appendChild(backLink('‹ grown-up home', () => go('home')));
  });

  // =========================================================
  // THE PEOPLE WHO READ (shared across every corner)
  // =========================================================
  register('readers', async function adultReaders(root) {
    const readers = await DB.readers.all();
    root.appendChild(el(
      '<h1 class="screen-title">The people who read</h1>' +
      '<p class="screen-sub">Only people you add here can record. No strangers, ever. Everyone here can read to every child on this device.</p>'));
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
    root.appendChild(backLink('‹ grown-up home', () => go('home')));
  });

  // =========================================================
  // THE LIBRARY
  // =========================================================
  register('books', async function adultBooks(root, ctx) {
    const cornerId = ctx.corner ? ctx.corner.id : null;
    const books = await DB.books.all(cornerId);
    const readings = await DB.readings.all(cornerId);
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
        '<div class="d">' + n + ' reading' + (n === 1 ? '' : 's') + ' · ' + (b.pages || []).length +
        (b.pageFormat === 'spread' ? ' spread photo' : ' page photo') + ((b.pages || []).length === 1 ? '' : 's') + '</div></div>' +
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
          '<button class="btn" data-ed title="adjust the gentle skips">✎ edit</button>' +
          '<button class="btn" data-pk title="pack this story for another family’s Corner">📦 send</button></div>');
        row.querySelector('[data-ed]').onclick = () => App.startEditFlow(st);
        row.querySelector('[data-pk]').onclick = e => sendParcel({ readingId: st.id }, st.title || 'A bedtime story', e.currentTarget);
        stack.appendChild(row);
      }
    }
    if (!books.length && !told.length) stack.appendChild(el('<div class="empty"><div class="big">📖</div>No books yet.</div>'));
    root.appendChild(stack);

    const row = el('<div class="btn-row"><button class="btn primary" id="add">📷 Add a book</button></div>');
    root.appendChild(row);
    row.querySelector('#add').onclick = () => go('addBook');
    root.appendChild(backLink('‹ grown-up home', () => go('home')));
  });

  register('addBook', async function adultAddBook(root, ctx) {
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
      const b = {
        id: DB.uid(), title, cover: coverFile || null, pages: [], pageFormat: 'single',
        cornerId: ctx.corner ? ctx.corner.id : null, createdAt: Date.now(),
      };
      await DB.books.save(b);
      DB.metrics.bump('library.book_added');
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
    root.appendChild(backLink('‹ the library', () => go('books')));
  });

  register('bookDetail', async function adultBookDetail(root) {
    const book = await DB.books.get(S.params.bookId);
    if (!book) return go('books');
    const readings = await DB.readings.forBook(book.id);
    const readers = await DB.readers.all();
    root.appendChild(el(
      '<h1 class="screen-title">' + esc(book.title) + '</h1>' +
      '<p class="screen-sub">' + (book.pages || []).length +
      (book.pageFormat === 'spread' ? ' two-page spread photos' : ' page photos') +
      ' · pages belong to the book, so every new voice reuses them.</p>'));

    const stack = el('<div class="stack"></div>');
    for (const r of readings.sort((a, b) => (a.episodeIndex ?? 0) - (b.episodeIndex ?? 0))) {
      const rd = readers.find(x => x.id === r.readerId);
      const label = (r.episodeIndex != null ? 'Chapter ' + r.episodeIndex + (r.title ? ' · ' + r.title : '') : 'The whole book');
      const row = el(
        '<div class="rowitem stacked">' +
        '<div class="rowhead">' + avatar(rd) +
        '<div class="grow"><div class="t">' + esc(label) + '</div>' +
        '<div class="d">' + esc(rd ? rd.name : '') + ' · ' + fmt(r.duration || 0) +
        ((r.skipRanges || []).length ? ' · ' + r.skipRanges.length + ' gentle skip' + (r.skipRanges.length > 1 ? 's' : '') : '') + '</div></div></div>' +
        '<div class="btn-row rowbtns">' +
        '<button class="btn" data-ed title="adjust the pages, turns and skips">✎ edit</button>' +
        '<button class="btn" data-dl>⤓ keep a copy</button>' +
        '<button class="btn" data-vx>🎞 video</button>' +
        '<button class="btn danger" data-x>delete</button></div></div>');
      row.querySelector('[data-ed]').onclick = () => App.startEditFlow(r);
      row.querySelector('[data-dl]').onclick = async () => {
        const audioBlob = await DB.audio.get(r.id);
        if (!audioBlob) return toast('This reading’s sound couldn’t be found on this device.');
        downloadBlob(blobURL('aud-' + r.id, audioBlob),
          book.title + (r.episodeIndex != null ? ' - chapter ' + r.episodeIndex : '') + ' - ' + (rd ? rd.name : 'reading') + '.' + Backup.audioExt(audioBlob.type));
      };
      row.querySelector('[data-vx]').onclick = async e => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          const audioBlob = await DB.audio.get(r.id);
          if (!audioBlob) throw new Error('no audio on this device');
          const out = await VideoExport.exportReading({
            reading: r, audioBlob, book, reader: rd,
            onProgress: p => { btn.textContent = '🎞 ' + Math.round(p * 100) + '%'; },
          });
          downloadBlob(out.blob, book.title + (r.episodeIndex != null ? ' - chapter ' + r.episodeIndex : '') + ' - ' + (rd ? rd.name : 'reading') + '.' + out.ext);
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
      '<span class="btn filebtn">📷 New cover photo<input type="file" id="cvlater" accept="image/*" capture="environment"></span>' +
      (readings.length ? '<button class="btn" id="parcel" title="pack this book — pages, voices and all — for another family’s Corner">📦 Send to another Corner</button>' : '') +
      '</div>');
    root.appendChild(row);
    row.querySelector('#rec').onclick = () => App.startRecordFlow({ bookId: book.id });
    row.querySelector('#ask').onclick = () => go('requests', { prefillBookId: book.id });
    row.querySelector('#art').onclick = () => go('studio', { bookId: book.id });
    // "You can also add it later" (add-book screen) — this is the later.
    row.querySelector('#cvlater').onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      book.cover = f;
      await DB.books.save(book);
      dropURL('cover-' + book.id);
      DB.metrics.bump('library.cover_photographed');
      toast('The new cover is on the shelf.');
      render();
    };
    const parcelBtn = row.querySelector('#parcel');
    if (parcelBtn) parcelBtn.onclick = () => sendParcel({ bookId: book.id }, book.title, parcelBtn);
    root.appendChild(backLink('‹ the library', () => go('books')));
  });

  // =========================================================
  // WHAT GETS USED — local usage counts, grouped by pain-point area.
  // Counts only, kept on this device; they leave only when a grown-up
  // taps share — that snapshot is how alpha pain points reach the maker.
  // =========================================================
  const AREA_ORDER = ['record', 'invite', 'guest', 'share', 'sync', 'play', 'library', 'corners', 'safety', 'help', 'gate', 'error'];
  const AREA_LABELS = {
    record: '🎙 recording', invite: '💌 inviting', guest: '🌍 invited guests', share: '📦 parcels', sync: '🔁 nearby sync', play: '📖 listening',
    library: '📚 the library', corners: '👧 corners', safety: '🗄 keep it safe', help: '❓ help',
    gate: '🔢 the grown-up code', error: '⚠️ rough edges',
  };
  function last7days(row) {
    const cutoff = Date.now() - 7 * 86400000;
    let s = 0;
    for (const [d, n] of Object.entries(row.days || {})) {
      if (new Date(d + 'T23:59:59Z').getTime() >= cutoff) s += n;
    }
    return s;
  }
  register('usage', async function adultUsage(root, ctx) {
    const [rows, readings, books] = await Promise.all([DB.metrics.all(), DB.readings.all(), DB.books.all()]);
    root.appendChild(el(
      '<h1 class="screen-title">What gets used</h1>' +
      '<p class="screen-sub">Simple counts of what happens in the app, grouped by area — so the rough spots show up as numbers instead of guesses. ' +
      '<b>Counts only' + (window.Telemetry && Telemetry.active() ? ' — shared with the maker anonymously (off switch below)' : ', kept on this device') + ':</b> ' +
      'never recordings, never names or titles.</p>'));

    // When the maker has a collector configured, say so plainly and hand the
    // family the switch.
    if (window.Telemetry && Telemetry.configured()) {
      const on = !Telemetry.isOff();
      const tcard = el(
        '<div class="card" style="margin-bottom:12px"><div class="kicker">sharing with the maker</div>' +
        '<p class="hint" style="margin-top:8px">' + (on
          ? 'These counts are sent automatically as they happen — anonymous, counts only, so the rough spots get fixed first.'
          : 'Automatic sharing is off. Counts stay on this device unless you share a snapshot below.') + '</p>' +
        '<div class="btn-row"><button class="btn" id="ttoggle">' + (on ? 'stop sending automatically' : 'turn automatic sharing back on') + '</button></div></div>');
      tcard.querySelector('#ttoggle').onclick = async () => { await Telemetry.setOff(on); render(); };
      root.appendChild(tcard);
    }

    const byArea = new Map();
    for (const r of rows) {
      const dot = r.key.indexOf('.');
      const area = dot > 0 ? r.key.slice(0, dot) : 'other';
      if (!byArea.has(area)) byArea.set(area, []);
      byArea.get(area).push(r);
    }
    const areas = [...new Set([...AREA_ORDER.filter(a => byArea.has(a)), ...byArea.keys()])];

    if (!rows.length) {
      root.appendChild(el('<div class="empty"><div class="big">📊</div>Nothing counted yet — use the app a little and look back here.</div>'));
    }
    const snapshotLines = ['Catherine’s Corner usage snapshot · v' + App.VERSION + ' · ' + new Date().toISOString().slice(0, 10),
      '(counts only — no recordings, names, or titles)', ''];
    for (const area of areas) {
      const list = byArea.get(area).sort((a, b) => b.n - a.n);
      const card = el('<div class="card" style="margin-bottom:12px"><div class="kicker">' + (AREA_LABELS[area] || area) + '</div><div class="stack" style="margin-top:10px"></div></div>');
      const stack = card.querySelector('.stack');
      const parts = [];
      for (const r of list) {
        const name = r.key.slice(area.length + 1).replace(/_/g, ' ');
        const week = last7days(r);
        stack.appendChild(el(
          '<div class="rowitem"><div class="grow"><div class="t" style="font-family:Inter,system-ui,sans-serif; font-size:13.5px">' + esc(name) + '</div></div>' +
          '<span class="chip">' + r.n + ' total</span>' + (week ? '<span class="chip open">' + week + ' this week</span>' : '') + '</div>'));
        parts.push(name.replace(/ /g, '_') + ' ' + r.n + (week ? ' (7d ' + week + ')' : ''));
      }
      root.appendChild(card);
      snapshotLines.push((AREA_LABELS[area] || area).replace(/^[^ ]+ /, '') + ': ' + parts.join(' · '));
    }
    snapshotLines.push('', 'context: ' + ctx.corners.length + ' corner' + (ctx.corners.length === 1 ? '' : 's') +
      ' · ' + books.length + ' books · ' + readings.length + ' readings · ' +
      (UI.IS_IOS ? 'iOS' : 'not iOS') + ' · installed: ' +
      ((window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true) ? 'yes' : 'no'));
    const snapshot = snapshotLines.join('\n');

    const row = el(
      '<div class="btn-row">' +
      '<button class="btn primary" id="share" ' + (rows.length ? '' : 'disabled') + '>⧉ Share this snapshot</button>' +
      '<button class="btn danger" id="reset" ' + (rows.length ? '' : 'disabled') + '>start counting fresh</button></div>' +
      '<p class="hint" style="margin-top:10px">Sharing sends the text above to whoever you choose — it’s how your testing shapes what gets fixed first.</p>');
    root.appendChild(row);
    row.querySelector('#share').onclick = () => Send.shareText(snapshot);
    row.querySelector('#reset').onclick = async () => {
      if (!confirm('Reset all usage counts to zero? (Recordings and books are untouched.)')) return;
      await DB.metrics.reset();
      render();
    };
    root.appendChild(backLink('‹ grown-up home', () => go('home')));
  });

  // =========================================================
  // PARCELS — a book or story travels from one family's Corner to another's.
  // No server: the parcel is a zip addressed to the other family's Corner ID;
  // it goes over any channel they already use, and their app accepts it.
  // =========================================================
  async function sendParcel(what, title, btn) {
    // sending a few books to the same family shouldn't mean re-typing the
    // code each time — the last used Corner ID comes back as the default
    const last = (await DB.settings.get('lastParcelTo')) || '';
    const toId = prompt(
      'Their Corner ID? (optional — they can find it under Keep it safe.\n' +
      'Addressed parcels land on the right shelf without a second thought; leave blank to send it open.)', last);
    if (toId === null) return;   // changed their mind
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '📦 packing…'; }
    try {
      const { blob, manifest } = await Backup.exportParcel(Object.assign({}, what, { toId }));
      if (manifest.to) await DB.settings.set('lastParcelTo', manifest.to);
      const fname = safeName('parcel - ' + title + (manifest.to ? ' - for ' + manifest.to : '') + '.zip');
      DB.metrics.bump('share.parcel_sent');
      await Send.shareFile(blob, fname,
        'A parcel from Catherine’s Corner 🌙 — “' + title + '”, voices and all. ' +
        'To tuck it onto the shelf: open Catherine’s Corner → for grown-ups → Keep it safe → Bring in a backup or parcel.');
    } catch (err) {
      toast(err.message || 'The parcel couldn’t be packed.');
    }
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }

  register('acceptParcel', async function acceptParcel(root, ctx) {
    const parcel = S.params.parcel;
    if (!parcel) return go('safety');
    const { m, map } = parcel;
    const myId = await DB.familyId();
    const addressed = m.to || null;
    // older parcels may carry a hand-typed address — read it generously
    const mine = addressed && (DB.familyIdFrom(addressed) || addressed) === myId;
    const what = m.book ? m.book.title : ((m.readings && m.readings[0] && m.readings[0].title) || 'A bedtime story');
    const readerNames = (m.readers || []).map(r => r.name).filter(Boolean);

    root.appendChild(el(
      '<div class="kicker">a parcel arrived</div>' +
      '<h1 class="screen-title">“' + esc(what) + '”</h1>' +
      '<p class="screen-sub">Sent from ' + esc(m.from && m.from.corner ? m.from.corner + '’s corner' : 'another corner') +
      (m.from && m.from.id ? ' (' + esc(m.from.id) + ')' : '') + ' — ' +
      (m.readings || []).length + ' reading' + ((m.readings || []).length === 1 ? '' : 's') +
      (readerNames.length ? ', read by ' + esc(readerNames.join(', ')) : '') +
      (m.book && (m.book.pages || []).length ? ' · ' + m.book.pages.length + ' page photos' : '') + '.</p>'));

    if (addressed && !mine) {
      root.appendChild(el(
        '<div class="card" style="border-color:var(--warm); background:var(--highlight); margin-bottom:14px">' +
        '<p class="hint">⚠️ This parcel was addressed to <b>' + esc(addressed) + '</b> — this device is <b>' + esc(myId) + '</b>. ' +
        'It may have been meant for someone else’s shelf. You can still tuck it in if it’s yours.</p></div>'));
    } else if (mine) {
      root.appendChild(el('<p class="hint" style="margin:-8px 0 14px">✓ addressed to this corner (' + esc(myId) + ')</p>'));
    }

    const row = el(
      '<div class="btn-row">' +
      '<button class="btn primary big" id="accept">Tuck it onto ' + esc(ctx.cornerName ? ctx.cornerName + '’s' : 'the') + ' shelf</button>' +
      '<button class="btn ghost" id="nope">not now</button></div>');
    root.appendChild(row);
    row.querySelector('#accept').onclick = async e => {
      e.currentTarget.disabled = true;
      try {
        const counts = await Backup.importParcel(m, map, ctx.corner && ctx.corner.id);
        DB.metrics.bump('share.parcel_accepted');
        clearURLCache();
        toast(counts.readings
          ? '“' + what + '” is on the shelf — ' + (ctx.cornerName || 'the little one') + ' will see something new. 🌙'
          : 'Everything in this parcel was already on the shelf.');
        go('books');
      } catch (err) {
        DB.metrics.bump('error.parcel_refused');
        toast(err.message || 'The parcel couldn’t be brought in.');
        e.currentTarget.disabled = false;
      }
    };
    row.querySelector('#nope').onclick = () => go('safety');
    root.appendChild(el('<p class="hint" style="margin-top:12px">Accepting adds to the shelf — it never replaces or deletes anything already here.</p>'));
  });

  // =========================================================
  // BOOK REQUESTS — ask a loved one, from anywhere
  // =========================================================
  register('requests', async function adultRequests(root, ctx) {
    const cornerId = ctx.corner ? ctx.corner.id : null;
    const [requests, books, readers] = await Promise.all([DB.requests.all(cornerId), DB.books.all(cornerId), DB.readers.all()]);
    root.appendChild(el(
      '<h1 class="screen-title">Book requests</h1>' +
      '<p class="screen-sub">' + esc(ctx.cornerName || 'Your child') + ' asks; a loved one records — from anywhere. The request travels with a link that shows them what it’s for and lets them record right there; when their recording comes back, bring it in and it lands on the shelf.</p>'));

    const stack = el('<div class="stack"></div>');
    for (const q of requests.sort((a, b) => b.createdAt - a.createdAt)) {
      const rd = readers.find(r => r.id === q.readerId);
      const bk = books.find(b => b.id === q.bookId);
      const what = bk ? bk.title : (q.bookTitle || 'Anything they love — reader’s pick');
      const row = el(
        '<div class="rowitem stacked">' +
        '<div class="rowhead"><span class="chip ' + (q.status === 'open' ? 'open' : '') + '">' + (q.status === 'open' ? 'open' : 'read ✓') + '</span>' +
        '<div class="grow"><div class="t">' + esc(what) + '</div>' +
        '<div class="d">asked of ' + esc(rd ? rd.name : 'anyone who loves them') + (q.note ? ' · “' + esc(q.note) + '”' : '') + '</div></div></div>' +
        (q.status === 'open' ? '' : '<div class="btn-row rowbtns"><button class="btn danger" data-x>remove</button></div>') +
        '</div>');
      if (q.status === 'open') {
        const link = Send.inviteLink({ kid: ctx.cornerName, book: bk ? bk.title : q.bookTitle, note: q.note });
        const text = Send.requestMessage(ctx.cornerName, bk ? bk.title : q.bookTitle, q.note, link);
        const btns = Send.sendRow(rd, 'A reading for ' + (ctx.cornerName || 'someone little'), text, 'invite');
        const pv = el('<a class="btn" href="' + esc(link) + '" target="_blank" rel="noopener" title="the page the link opens for them">👀 preview</a>');
        pv.onclick = () => DB.metrics.bump('invite.previewed');
        btns.appendChild(pv);
        btns.appendChild(el('<button class="btn warm" data-rec>record now</button>'));
        btns.appendChild(el('<button class="btn" data-done>mark read</button>'));
        btns.querySelector('[data-rec]').onclick = () => { DB.metrics.bump('invite.record_now'); App.startRecordFlow({ bookId: q.bookId, requestId: q.id, readerId: q.readerId }); };
        btns.querySelector('[data-done]').onclick = async () => { q.status = 'done'; await DB.requests.save(q); render(); };
        row.appendChild(btns);
        // The half of the loop that lands back here: say plainly how the
        // recording they send back becomes a reading.
        const hint = el('<p class="hint" style="margin-top:8px">When their recording comes back, bring it in: <b>Record a reading → ⤓ Import audio</b>. <a href="#" data-guide>Step-by-step guide</a></p>');
        hint.querySelector('[data-guide]').onclick = e => { e.preventDefault(); go('memoHelp', { returnTo: 'requests' }); };
        row.appendChild(hint);
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
        note: card.querySelector('#nt').value.trim(), status: 'open',
        cornerId, createdAt: Date.now(),
      });
      DB.metrics.bump('invite.request_created');
      toast('Request added — send it on its way with ✉️ or 💬.');
      render();
    };
    root.appendChild(backLink('‹ grown-up home', () => go('home')));
  });
})();
