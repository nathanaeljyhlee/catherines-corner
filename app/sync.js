/* Catherine's Corner — nearby sync.
   Two devices on the same WiFi match shelves directly, with no server, no
   account, and no library: a WebRTC data channel using HOST candidates only
   (nothing outside the local network is even attempted).

   The one thing browsers can't do alone is the introduction — so the
   handshake rides in two small PAIRING CODES the grown-up carries between
   the devices by hand (copy/paste, a text to yourself, anything). The codes
   are a compact form of the WebRTC session description: ICE credentials,
   the DTLS fingerprint, and the local-network candidates — a few hundred
   characters. The recordings themselves — the megabytes — then travel
   device-to-device over the family's own WiFi, encrypted by DTLS.

   What travels is a backup DELTA (only what the other side is missing), in
   the exact zip format restores have used since v1.1.1 — so merging inherits
   the battle-tested semantics: corners merge by id then name, rows merge by
   id, nothing is ever deleted, and the CRC check runs on arrival. */

(function () {
  'use strict';

  const { el, esc, toast } = UI;
  const { S, go, register } = App;

  // ---------- pairing-code codec (minimal SDP) ----------
  function b64u(obj) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(str) {
    try {
      const p = JSON.parse(decodeURIComponent(escape(atob(String(str).trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')))));
      return p && typeof p.u === 'string' && typeof p.p === 'string' && typeof p.f === 'string' && Array.isArray(p.c) ? p : null;
    } catch (e) { return null; }
  }
  function extract(sdp) {
    const get = re => (sdp.match(re) || [])[1] || '';
    const fhex = get(/a=fingerprint:sha-256 ([^\r\n]+)/i).replace(/:/g, '');
    const f = btoa((fhex.match(/../g) || []).map(h => String.fromCharCode(parseInt(h, 16))).join(''));
    const c = [];
    for (const m of sdp.matchAll(/a=candidate:\S+ 1 (?:udp|UDP) (\d+) (\S+) (\d+) typ host/g)) {
      c.push([m[2], +m[3], +m[1]]);
    }
    return { v: 1, u: get(/a=ice-ufrag:([^\r\n]+)/), p: get(/a=ice-pwd:([^\r\n]+)/), f, c };
  }
  function buildSDP(d, kind) {   // kind: 'offer' | 'answer'
    const fhex = atob(d.f).split('').map(ch => ch.charCodeAt(0).toString(16).padStart(2, '0')).join(':').toUpperCase();
    let sdp =
      'v=0\r\n' +
      'o=- 1 2 IN IP4 127.0.0.1\r\n' +
      's=-\r\n' +
      't=0 0\r\n' +
      'a=group:BUNDLE 0\r\n' +
      'a=msid-semantic: WMS\r\n' +
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' +
      'c=IN IP4 0.0.0.0\r\n' +
      'a=ice-ufrag:' + d.u + '\r\n' +
      'a=ice-pwd:' + d.p + '\r\n' +
      'a=fingerprint:sha-256 ' + fhex + '\r\n' +
      'a=setup:' + (kind === 'offer' ? 'actpass' : 'active') + '\r\n' +
      'a=mid:0\r\n' +
      'a=sctp-port:5000\r\n' +
      'a=max-message-size:262144\r\n';
    (d.c || []).slice(0, 8).forEach((cand, i) => {
      sdp += 'a=candidate:' + (i + 1) + ' 1 udp ' + (cand[2] || 2113937151) + ' ' + cand[0] + ' ' + cand[1] + ' typ host generation 0\r\n';
    });
    return sdp;
  }
  function waitGathering(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(res => {
      const done = () => { pc.removeEventListener('icegatheringstatechange', check); res(); };
      const check = () => { if (pc.iceGatheringState === 'complete') done(); };
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(done, 3500);   // mDNS/host gathering is quick; don't hang the UI
    });
  }

  // ---------- session ----------
  let session = null;
  function closeSession() {
    if (!session) return;
    try { if (session.ch) session.ch.close(); } catch (e) {}
    try { session.pc.close(); } catch (e) {}
    session = null;
  }

  const supported = () => typeof RTCPeerConnection !== 'undefined';

  async function startSession(isOfferer, remoteCode, ui) {
    closeSession();
    const pc = new RTCPeerConnection({ iceServers: [] });   // LAN only — no STUN, ever
    session = { pc, ch: null, ui, sent: null, received: null, chunks: [], finished: false };
    pc.onconnectionstatechange = () => {
      if (!session || session.pc !== pc) return;
      if ((pc.connectionState === 'failed' || pc.connectionState === 'disconnected') && !session.finished) {
        ui.fail('The devices couldn’t reach each other. Make sure both are on the same WiFi and try fresh codes — or use a backup file instead.');
      }
    };
    if (isOfferer) {
      wireChannel(pc.createDataChannel('cc-sync'));
      await pc.setLocalDescription(await pc.createOffer());
    } else {
      pc.ondatachannel = e => wireChannel(e.channel);
      const d = unb64u(remoteCode);
      if (!d) throw new Error('That doesn’t look like a whole pairing code — copy everything in the box.');
      await pc.setRemoteDescription({ type: 'offer', sdp: buildSDP(d, 'offer') });
      await pc.setLocalDescription(await pc.createAnswer());
    }
    await waitGathering(pc);
    return b64u(extract(pc.localDescription.sdp));
  }

  async function acceptAnswer(code) {
    const d = unb64u(code);
    if (!d) throw new Error('That doesn’t look like a whole pairing code — copy everything in the box.');
    await session.pc.setRemoteDescription({ type: 'answer', sdp: buildSDP(d, 'answer') });
  }

  function wireChannel(ch) {
    session.ch = ch;
    ch.binaryType = 'arraybuffer';
    const send = obj => ch.send(JSON.stringify(obj));
    ch.onopen = async () => {
      session.ui.status('Connected — comparing shelves…');
      const [readings, books] = await Promise.all([DB.readings.all(), DB.books.all()]);
      send({ t: 'inv', r: readings.map(x => x.id), b: books.map(x => x.id) });
    };
    ch.onerror = () => { if (!session.finished) session.ui.fail('The connection stumbled — try fresh codes.'); };
    ch.onmessage = async e => {
      try {
        if (typeof e.data !== 'string') { session.chunks.push(e.data); return; }
        const m = JSON.parse(e.data);
        if (m.t === 'inv') {
          const { blob, counts } = await Backup.exportDelta(m.r, m.b);
          if (!counts.readings && !counts.books) {
            send({ t: 'empty' });
            session.sent = { readings: 0, books: 0 };
          } else {
            session.ui.status('Sending ' + counts.readings + ' reading' + (counts.readings === 1 ? '' : 's') + ' over WiFi…');
            send({ t: 'zip', counts });
            await sendBlob(ch, blob);
            send({ t: 'zipend' });
            session.sent = counts;
          }
          maybeDone();
        } else if (m.t === 'empty') {
          session.received = { readings: 0, books: 0 };
          maybeDone();
        } else if (m.t === 'zip') {
          session.chunks = [];
          session.ui.status('Receiving ' + m.counts.readings + ' reading' + (m.counts.readings === 1 ? '' : 's') + '…');
        } else if (m.t === 'zipend') {
          const zip = new Blob(session.chunks, { type: 'application/zip' });
          session.chunks = [];
          const { manifest, map } = await Backup.inspect(zip);   // CRC-checked, even over WiFi
          const counts = await Backup.importBackup(manifest, map);
          UI.clearURLCache();
          session.received = counts;
          maybeDone();
        }
      } catch (err) {
        DB.metrics.bump('error.sync_failed');
        session.ui.fail((err && err.message) || 'Something went wrong mid-sync — nothing was lost; try again.');
      }
    };
  }

  async function sendBlob(ch, blob) {
    const CHUNK = 64 * 1024;
    const buf = await blob.arrayBuffer();
    for (let o = 0; o < buf.byteLength; o += CHUNK) {
      if (ch.bufferedAmount > 4 * 1024 * 1024) {
        await new Promise(res => { ch.bufferedAmountLowThreshold = 1024 * 1024; ch.onbufferedamountlow = () => { ch.onbufferedamountlow = null; res(); }; });
      }
      ch.send(buf.slice(o, Math.min(o + CHUNK, buf.byteLength)));
    }
  }

  function maybeDone() {
    if (!session || !session.sent || !session.received) return;
    session.finished = true;
    DB.metrics.bump('sync.merged');
    session.ui.done(session.sent, session.received);
  }

  // ---------- the screen ----------
  register('sync', async function syncScreen(root) {
    closeSession();   // a fresh visit always starts clean
    DB.metrics.bump('sync.opened');

    root.appendChild(el(
      '<div class="kicker">same WiFi, no internet needed</div>' +
      '<h1 class="screen-title">Sync with a nearby device</h1>' +
      '<p class="screen-sub">Match shelves between two of your own devices — the family tablet and your phone. ' +
      'A small pairing code goes between them (copy it, text it to yourself, anything); the recordings themselves travel ' +
      'directly over your WiFi, never the internet. Nothing is ever deleted by a sync — both sides only gain.</p>'));

    if (!supported()) {
      root.appendChild(el('<div class="empty">This browser can’t make device-to-device connections. Use “Keep it safe” — a backup file moves everything too.</div>'));
      const backA = el('<button class="back">‹ keep it safe</button>');
      backA.onclick = () => go('safety');
      root.appendChild(backA);
      return;
    }

    const box = el('<div></div>');
    root.appendChild(box);

    const ui = {
      status: t => { const n = box.querySelector('#syncstat'); if (n) n.textContent = t; },
      fail: t => {
        box.innerHTML = '';
        box.appendChild(el('<div class="card"><div class="kicker">that didn’t take</div><p class="hint" style="margin-top:8px">' + esc(t) + '</p>' +
          '<div class="btn-row"><button class="btn primary" id="again">try again</button></div></div>'));
        box.querySelector('#again').onclick = () => go('sync');
      },
      done: (sent, received) => {
        box.innerHTML = '';
        box.appendChild(el(
          '<div class="card sync-done"><div class="kicker">shelves matched ✓</div>' +
          '<p style="margin-top:8px">This device received <b>' + received.readings + '</b> reading' + (received.readings === 1 ? '' : 's') +
          ' and sent <b>' + sent.readings + '</b> — both devices now hold everything.</p>' +
          '<p class="hint" style="margin-top:8px">New things appear on the shelf right away. Sync again any time — it only ever adds.</p>' +
          '<div class="btn-row"><button class="btn primary big" id="home2">lovely — done</button></div></div>'));
        box.querySelector('#home2').onclick = () => { closeSession(); go('home'); };
      },
    };

    function roleChooser() {
      box.innerHTML = '';
      const pick = el(
        '<div class="stack">' +
        '<button class="pick" id="mkoffer"><span class="av" style="background:var(--accent)">1</span>' +
        '<span><span class="nm">Start here — show this device’s code</span><br><span class="rel">then enter the other device’s reply</span></span>' +
        '<span class="spacer"></span><span class="chev">›</span></button>' +
        '<button class="pick" id="haveoffer"><span class="av" style="background:var(--warm)">2</span>' +
        '<span><span class="nm">I have a code from the other device</span><br><span class="rel">paste it and get your reply code</span></span>' +
        '<span class="spacer"></span><span class="chev">›</span></button>' +
        '</div>');
      box.appendChild(pick);
      pick.querySelector('#mkoffer').onclick = () => offerFlow();
      pick.querySelector('#haveoffer').onclick = () => answerFlow();
    }

    function codeCard(code, hint) {
      const card = el(
        '<div class="card" style="margin-top:14px"><div class="kicker">this device’s pairing code</div>' +
        '<textarea class="code-box" id="mycode" readonly rows="4"></textarea>' +
        '<div class="btn-row"><button class="btn" id="copycode">⧉ copy</button><button class="btn" id="sharecode">⧉ share</button></div>' +
        '<p class="hint" style="margin-top:8px">' + hint + '</p></div>');
      card.querySelector('#mycode').value = code;
      card.querySelector('#copycode').onclick = async () => {
        try { await navigator.clipboard.writeText(code); toast('Copied — get it to the other device any way you like.'); }
        catch (e) { card.querySelector('#mycode').select(); toast('Select-all and copy the box.'); }
      };
      card.querySelector('#sharecode').onclick = () => Send.shareText(code);
      return card;
    }

    function theirsCard(label, onGo) {
      const card = el(
        '<div class="card" style="margin-top:14px"><div class="kicker">' + label + '</div>' +
        '<textarea class="code-box" id="theirs" rows="4" placeholder="paste the whole code here"></textarea>' +
        '<div class="btn-row"><button class="btn primary" id="accept">connect</button></div>' +
        '<p class="hint" id="syncstat" style="margin-top:8px"></p></div>');
      card.querySelector('#accept').onclick = async e => {
        const v = card.querySelector('#theirs').value;
        if (!v.trim()) return toast('Paste the code from the other device first.');
        e.currentTarget.disabled = true;
        try { await onGo(v); ui.status('Connecting over WiFi…'); }
        catch (err) { toast(err.message || 'That code didn’t work.'); e.currentTarget.disabled = false; }
      };
      return card;
    }

    async function offerFlow() {
      box.innerHTML = '<p class="hint">making this device’s code…</p>';
      try {
        const code = await startSession(true, null, ui);
        box.innerHTML = '';
        box.appendChild(codeCard(code, 'On the other device: for grown-ups → Keep it safe → Sync → “I have a code” → paste this, then bring its reply code back here.'));
        box.appendChild(theirsCard('the other device’s reply code', v => acceptAnswer(v)));
      } catch (err) { ui.fail(err.message || 'Couldn’t start — try again.'); }
    }

    function answerFlow() {
      box.innerHTML = '';
      box.appendChild(theirsCard('the code from the other device', async v => {
        const code = await startSession(false, v, ui);
        const st = box.querySelector('#syncstat');
        box.insertBefore(codeCard(code, 'Now enter this reply code on the other device — the sync starts the moment it does.'), box.firstChild);
        if (st) st.textContent = 'Waiting for the other device…';
      }));
    }

    roleChooser();

    const back = el('<button class="back">‹ keep it safe</button>');
    back.onclick = () => { closeSession(); go('safety'); };
    root.appendChild(back);
  });
})();
