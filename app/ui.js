/* Catherine's Corner — shared UI kit.
   Small, dependency-free helpers every screen leans on: DOM building, object-URL
   caching, toasts, the scrubber, playback timing math, and the one audio-capture
   panel (record / pause / import) used wherever a voice comes into the app. */

(function () {
  'use strict';

  // iOS Safari mishandles accept="audio/*" on file inputs (greys out audio in
  // Files, offers only video/camera). There: no accept filter, validate in JS.
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const AV_COLORS = ['#34557A', '#D08A4E', '#5B7B5A', '#8A5A83', '#A85B4B', '#446A92', '#7A6A34'];

  // ---------- object-URL cache ----------
  const urlCache = new Map();
  function blobURL(key, blob) {
    if (!blob) return null;
    if (!urlCache.has(key)) urlCache.set(key, URL.createObjectURL(blob));
    return urlCache.get(key);
  }
  function dropURL(key) {
    if (urlCache.has(key)) { URL.revokeObjectURL(urlCache.get(key)); urlCache.delete(key); }
  }
  function clearURLCache() {
    for (const key of [...urlCache.keys()]) dropURL(key);
  }

  // ---------- text + DOM ----------
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

  // The one back-link every screen ends with.
  function backLink(labelHtml, onClick) {
    const b = el('<button class="back">' + labelHtml + '</button>');
    b.onclick = onClick;
    return b;
  }

  // Filenames that survive every OS's picker.
  function safeName(s) { return String(s).replace(/[/\\?%*:|"<>]/g, '-'); }

  // Hand a file to the browser's downloader; owns (and later revokes) the
  // object URL when given a Blob, borrows the URL when given a string.
  function downloadBlob(source, fname) {
    const a = document.createElement('a');
    const owned = source instanceof Blob;
    a.href = owned ? URL.createObjectURL(source) : source;
    a.download = safeName(fname);
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (owned) setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  // Base64url JSON — the codec under invite links and sync pairing codes.
  function b64uEncode(obj) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64uDecode(str) {
    try {
      const b64 = String(str).trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(b64))));
    } catch (e) { return null; }
  }

  // Hand mail/messages links to the OS the same way a tapped
  // <a href="mailto:…"> would — the pattern phones handle best.
  function launchHref(href) {
    const a = document.createElement('a');
    a.href = href;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---------- playback timing ----------
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

  // Read an audio file's duration without keeping anything alive.
  function probeDuration(blob) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      a.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(isFinite(a.duration) ? a.duration : 0); };
      a.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    });
  }

  // ---------- the transport bar ----------
  // One play/scrub bar for everywhere audio plays (the kid player, pass 2):
  // play/pause, the finger-sized scrubber, optional ±5s nudges, and a paint
  // loop that runs only while this audio is the app's active player — so
  // navigating anywhere else always stops it.
  // opts: { bare, nudge, durFallback(), onPaint(userSeek), onFrame(), onEnded() }
  function playerBar(audio, opts) {
    opts = opts || {};
    const root = el(
      '<div class="p-bar"' + (opts.bare ? ' style="border-top:none"' : '') + '>' +
      '<button class="p-play" id="pp" aria-label="play">▶</button>' +
      (opts.nudge
        ? '<button class="p-nudge" data-b5 aria-label="back five seconds">↺5</button>' +
          '<button class="p-nudge" data-f5 aria-label="forward five seconds">5↻</button>'
        : '') +
      '<div class="p-track"><i></i></div><span class="p-time">0:00</span></div>');
    const $pp = root.querySelector('.p-play'), $fill = root.querySelector('.p-track i');
    const $time = root.querySelector('.p-time'), $track = root.querySelector('.p-track');
    const dur = () => (audio.duration && isFinite(audio.duration)) ? audio.duration
      : (opts.durFallback ? opts.durFallback() : 0);
    function paint(userSeek) {
      const d = dur();
      $fill.style.width = d ? (audio.currentTime / d * 100) + '%' : '0%';
      $time.textContent = fmt(audio.currentTime) + (d ? ' / ' + fmt(d) : '');
      if (opts.onPaint) opts.onPaint(!!userSeek);
    }
    function tickLoop() {
      if (window.App.player.audio !== audio) return;   // another screen took over
      if (opts.onFrame) opts.onFrame();
      paint(false);
      window.App.player.raf = requestAnimationFrame(tickLoop);
    }
    function start() { audio.play(); $pp.textContent = '❘❘'; tickLoop(); }
    $pp.onclick = () => {
      if (audio.paused) start();
      else { audio.pause(); $pp.textContent = '▶'; }
    };
    makeScrubber($track, audio, dur, () => paint(true));
    if (opts.nudge) {
      root.querySelector('[data-b5]').onclick = () => { audio.currentTime = Math.max(0, audio.currentTime - 5); paint(false); };
      root.querySelector('[data-f5]').onclick = () => { const d = dur(); audio.currentTime = d ? Math.min(d, audio.currentTime + 5) : audio.currentTime + 5; paint(false); };
    }
    audio.onended = () => { $pp.textContent = '▶'; if (opts.onEnded) opts.onEnded(); };
    window.App.player.audio = audio;
    return { el: root, paint, start, dur };
  }

  // ---------- audio capture panel ----------
  // The one way a voice enters the app: live recording (with pause) or an
  // imported file, iOS quirks handled. Used by pass 1 and the invite page.
  // opts: { statusIdle, note (html), onAudio(blob, durationSec, imported) }
  function capturePanel(opts) {
    // Degrade honestly where live recording isn't possible (no MediaRecorder,
    // no mic API, or a non-HTTPS address): keep the import path front and
    // center instead of a button that can only fail.
    const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
    const recordUI = canRecord
      ? '<div><span class="rec-dot" id="dot"></span><span id="stat" class="hint">' + (opts.statusIdle || 'ready when you are') + '</span></div>' +
        '<div class="rec-time" id="tm">0:00</div>' +
        '<div class="btn-row" style="justify-content:center">' +
        '<button class="btn warm big" id="rec">● Start recording</button>' +
        '<button class="btn big" id="pause" style="display:none">❘❘ Pause</button>' +
        '<button class="btn primary big" id="stop" style="display:none">■ Done reading</button>' +
        '</div>'
      : '<div class="hint" style="margin-bottom:6px">🎙 This browser can’t record directly' +
        (window.isSecureContext === false ? ' (recording needs a secure https:// address)' : '') +
        ' — record a voice memo with any recorder app, then bring it in below.</div>';
    const hero = el(
      '<div class="rec-hero">' + recordUI +
      (opts.note ? '<p class="rec-note">' + opts.note + '</p>' : '') +
      '<div class="btn-row" style="justify-content:center">' +
      '<span class="btn filebtn" id="impbtn">⤓ Import audio<input type="file" id="imp"' +
      (IS_IOS ? '' : ' accept="audio/*,.m4a,.aac,.mp3,.wav,.caf"') + '></span>' +
      '</div></div>');

    let mediaRecorder = null, chunks = [], t0 = 0, elapsedBefore = 0, timer = null;
    const $tm = hero.querySelector('#tm'), $dot = hero.querySelector('#dot'), $stat = hero.querySelector('#stat');
    const $rec = hero.querySelector('#rec'), $pause = hero.querySelector('#pause'), $stop = hero.querySelector('#stop');

    function tickTime() {
      const t = elapsedBefore + (mediaRecorder && mediaRecorder.state === 'recording' ? (Date.now() - t0) / 1000 : 0);
      $tm.textContent = fmt(t);
    }

    if ($rec) $rec.onclick = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        chunks = [];
        mediaRecorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        mediaRecorder.onstop = () => {
          stream.getTracks().forEach(t => t.stop());
          clearInterval(timer);
          const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
          opts.onAudio(blob, elapsedBefore + (t0 ? (Date.now() - t0) / 1000 : 0), false);
        };
        mediaRecorder.start();
        t0 = Date.now(); elapsedBefore = 0;
        timer = setInterval(tickTime, 250);
        $dot.classList.add('live'); $stat.textContent = 'recording — just read';
        $rec.style.display = 'none'; $pause.style.display = ''; $stop.style.display = '';
      } catch (err) {
        if (window.DB) DB.metrics.bump('error.mic_denied');
        toast(err && err.name === 'NotFoundError'
          ? 'No microphone could be found on this device — import a voice memo instead.'
          : 'The microphone said no — check permissions and try again.');
      }
    };
    if ($pause) $pause.onclick = () => {
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
    if ($stop) $stop.onclick = () => {
      if (!mediaRecorder) return;
      if (mediaRecorder.state === 'paused') { /* elapsedBefore already counted */ t0 = 0; }
      else if (mediaRecorder.state === 'recording') { elapsedBefore += (Date.now() - t0) / 1000; t0 = 0; }
      mediaRecorder.stop();
    };
    hero.querySelector('#imp').onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      // iOS hands over .m4a with a missing/odd mime type — normalize so
      // playback, backups, and download names all treat it as audio/mp4.
      const blob = Backup.normalizeAudioFile(f);
      const duration = await probeDuration(blob);
      if (duration != null) return opts.onAudio(blob, duration, true);
      if ((blob.type || '').startsWith('audio/')) {
        // declared audio but this device can't read its length — keep it
        toast('Couldn’t read that recording’s length here — it’s kept as-is and will play where the format is supported.');
        opts.onAudio(blob, 0, true);
      } else {
        if (window.DB) DB.metrics.bump('error.import_rejected');
        e.target.value = '';
        toast('That file doesn’t look like a recording — pick an audio file (a voice memo works).');
      }
    };
    return hero;
  }

  window.UI = {
    IS_IOS, AV_COLORS,
    blobURL, dropURL, clearURLCache,
    fmt, esc, el, toast, avatar, launchHref,
    backLink, safeName, downloadBlob, b64uEncode, b64uDecode,
    currentPageIndex, applySkips, makeScrubber, pageInk, probeDuration,
    capturePanel, playerBar,
  };
})();
