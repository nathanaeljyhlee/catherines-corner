/* Catherine's Corner — export a reading as a video.
   Renders the story pages to a canvas in sync with the voice and records
   canvas + audio into one file (mp4 where the browser can, else webm).
   Runs in real time — an export takes as long as the reading plays. */

(function () {
  'use strict';

  function loadImg(blob) {
    return new Promise((res, rej) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => res({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('image failed to load')); };
      img.src = url;
    });
  }

  function pickMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    return ['video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m)) || '';
  }

  // exportReading({reading, audioBlob, book, reader, onProgress}) -> {blob, ext}
  async function exportReading({ reading, audioBlob, book, reader, onProgress }) {
    const pages = (book && book.pages) || [];
    // Two-page spreads are wide — render them on a 16:9 canvas so both pages
    // show big; single pages keep the book-shaped 4:3 frame.
    const spread = !!(book && book.pageFormat === 'spread' && pages.length);
    const W = 1280, H = spread ? 720 : 960;
    const loaded = await Promise.all(pages.map(p => loadImg(p.blob)));
    const cover = book && book.cover ? await loadImg(book.cover) : null;
    const title = book ? book.title : (reading.title || 'A bedtime story');
    const byline = 'read by ' + (reader ? reader.name : 'someone who loves you') +
      (reading.episodeIndex != null ? ' · Chapter ' + reading.episodeIndex : '');

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    const AC = window.AudioContext || window.webkitAudioContext;
    const actx = new AC();
    const audioUrl = URL.createObjectURL(audioBlob || reading.audioBlob);
    const audioEl = new Audio(audioUrl);
    await new Promise((res, rej) => { audioEl.onloadedmetadata = res; audioEl.onerror = () => rej(new Error('audio failed to load')); });
    const srcNode = actx.createMediaElementSource(audioEl); // diverts sound into the graph — export is silent to the room
    const dest = actx.createMediaStreamDestination();
    srcNode.connect(dest);

    const stream = new MediaStream([
      ...canvas.captureStream(30).getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);
    const mime = pickMime();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };

    function pageIndex(tSec) {
      let i = 0;
      for (const tt of reading.pageTurns || []) { if (tSec * 1000 >= tt) i++; else break; }
      return i;
    }
    function applySkips() {
      const t = audioEl.currentTime * 1000;
      for (const r of reading.skipRanges || []) {
        if (t >= r.start && t < r.end - 40) { audioEl.currentTime = r.end / 1000; return; }
      }
    }
    function drawContain(img, x, y, w, h) {
      const s = Math.min(w / img.width, h / img.height);
      const dw = img.width * s, dh = img.height * s;
      ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    }
    function draw(tSec) {
      ctx.fillStyle = '#FAF4EA';
      ctx.fillRect(0, 0, W, H);
      const FOOT = 96;
      const current = loaded.length ? loaded[Math.min(pageIndex(tSec), loaded.length - 1)] : cover;
      if (current) {
        drawContain(current.img, 40, 34, W - 80, H - FOOT - 62);
      } else {
        ctx.fillStyle = '#2C2722';
        ctx.font = '600 150px Georgia, serif';
        ctx.textAlign = 'center';
        ctx.fillText('🌙', W / 2, H / 2 - 60);
      }
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, H - FOOT, W, FOOT);
      ctx.strokeStyle = '#E9DFCE';
      ctx.beginPath(); ctx.moveTo(0, H - FOOT); ctx.lineTo(W, H - FOOT); ctx.stroke();
      ctx.textAlign = 'left';
      ctx.fillStyle = '#2C2722';
      ctx.font = '600 34px Georgia, serif';
      ctx.fillText(title, 44, H - FOOT + 42, W - 380);
      ctx.fillStyle = '#80766a';
      ctx.font = '22px system-ui, sans-serif';
      ctx.fillText(byline, 44, H - FOOT + 76, W - 380);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#34557A';
      ctx.font = '600 24px Georgia, serif';
      ctx.fillText('Catherine’s Corner', W - 44, H - FOOT + 58);
    }

    const done = new Promise((res, rej) => {
      let raf;
      audioEl.onended = () => {
        cancelAnimationFrame(raf);
        draw(audioEl.duration || 0);
        setTimeout(() => rec.state !== 'inactive' && rec.stop(), 250);
      };
      rec.onstop = () => res();
      rec.onerror = e => rej(e.error || new Error('recording failed'));
      const loop = () => {
        applySkips();
        draw(audioEl.currentTime);
        if (onProgress && audioEl.duration) onProgress(Math.min(1, audioEl.currentTime / audioEl.duration));
        raf = requestAnimationFrame(loop);
      };
      loop();
    });

    await actx.resume();
    rec.start(250);
    try {
      await audioEl.play();
      await done;
    } finally {
      URL.revokeObjectURL(audioUrl);
      loaded.forEach(l => URL.revokeObjectURL(l.url));
      if (cover) URL.revokeObjectURL(cover.url);
      actx.close().catch(() => {});
    }
    const type = mime || 'video/webm';
    return { blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm' };
  }

  window.VideoExport = { exportReading };
})();
