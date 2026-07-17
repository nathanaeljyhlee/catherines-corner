/* Catherine's Corner — sending words (and invitations) to loved ones.
   One kit for every "reach someone far away" moment: the request to read, the
   invite link that opens a guest recording page right in the app, and the
   thank-you once their reading is on the shelf. Local-first stays honest:
   nothing is uploaded — the guest records HERE, then sends the file BACK, and
   the grown-up tucks it onto the shelf. */

(function () {
  'use strict';

  const { el, esc, toast, launchHref, fmt, capturePanel, IS_IOS } = UI;

  // ---------- where the app lives ----------
  // The canonical URL of this deployment — what travels inside invites.
  function appURL() {
    return (location.origin + location.pathname).replace(/index\.html$/, '');
  }
  // The concept site sits one level above the app on the same host.
  function siteURL() {
    return appURL().replace(/app\/$/, '');
  }

  // ---------- invite links ----------
  // The invitation is the URL: a small payload (child, book, note) rides in
  // the hash — never sent to any server — and opens the guest page below.
  // Anyone can craft one of these links, so the payload is distrusted on the
  // way in: every field is coerced to a clamped plain string (and rendered
  // through esc() like everything else).
  const strField = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';
  function sanitizeInvite(p) {
    if (!p || typeof p !== 'object') return null;
    return { v: 1, kid: strField(p.kid, 40), book: strField(p.book, 120), note: strField(p.note, 200) };
  }
  const decodeInvite = str => sanitizeInvite(UI.b64uDecode(str));
  function inviteLink(payload) {
    return appURL() + '#invite=' + UI.b64uEncode(sanitizeInvite(payload));
  }
  function inviteFromHash() {
    const m = (location.hash || '').match(/#invite=([A-Za-z0-9\-_]+)/);
    return m ? decodeInvite(m[1]) : null;
  }
  // A #give= link is the cloud cousin of #invite: the guest records HERE and the
  // recording uploads straight to the family's shelf (Phase 4), instead of the
  // guest saving a file to send back by hand. The token names the invite row.
  function giveFromHash() {
    const m = (location.hash || '').match(/[#&]give=([A-Za-z0-9\-_]+)/);
    return m ? m[1] : null;
  }

  // ---------- the words that travel ----------
  // Honest about the loop: the recording comes back to the grown-up, who
  // tucks it onto the shelf. The link shows the invitee what it's all for.
  function requestMessage(kid, bookTitle, note, link) {
    return (kid || 'Someone little') + ' would love you to read ' +
      (bookTitle ? '“' + bookTitle + '” aloud' : 'them a story aloud — any book you love') +
      (note ? ' — “' + note + '”' : '') +
      '. This link shows you what it’s for, and you can record right there: ' + link +
      ' — or just record a voice memo on your phone. Either way, send the recording back to me and I’ll tuck it onto their shelf in Catherine’s Corner.';
  }

  // A row of ✉️ / 💬 / ⧉ buttons that opens the right app with the message
  // written out, pre-addressed from the reader's saved contact when there is
  // one. Callers may append their own extra buttons to the returned row.
  function sendRow(reader, subject, text, area) {
    const track = how => { if (area) DB.metrics.bump(area + '.' + how); };
    const row = el(
      '<div class="btn-row rowbtns">' +
      '<button class="btn" data-em title="opens your mail app with the message written out">✉️ email</button>' +
      '<button class="btn" data-sm title="opens your messages app with the message written out">💬 text</button>' +
      '<button class="btn" data-share>⧉ share</button></div>');
    row.querySelector('[data-em]').onclick = () => {
      track('sent_email');
      launchHref('mailto:' + encodeURIComponent(reader && reader.email || '') +
        '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(text));
    };
    row.querySelector('[data-sm]').onclick = () => {
      track('sent_text');
      const num = reader && reader.phone ? reader.phone.replace(/[^\d+]/g, '') : '';
      // iOS wants "sms:num&body=", Android "sms:num?body=" — both open
      // the messages app with the message typed and ready to send.
      launchHref('sms:' + num + (IS_IOS ? '&' : '?') + 'body=' + encodeURIComponent(text));
    };
    row.querySelector('[data-share]').onclick = () => { track('sent_share'); shareText(text); };
    return row;
  }

  // Share sheet → clipboard → an old-fashioned copy prompt: the message
  // always has SOME way out of the app, whatever this browser supports.
  async function shareText(text) {
    if (navigator.share) {
      try { await navigator.share({ text }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; /* sheet failed — fall through */ }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied — paste it into any message.');
      return;
    } catch (e) { /* clipboard unavailable — fall through */ }
    prompt('Copy this message:', text);
  }

  // Get a FILE to another person. Deliberately TWO taps: packing a file can
  // take a while, and browsers only allow navigator.share() inside a fresh
  // tap — call it after seconds of packing and iOS/Android refuse the share
  // sheet outright (and a silent blob download is no rescue on an installed
  // iPhone app). So packing finishes first, then this sheet offers real
  // buttons; each press is its own gesture, so the share sheet always opens.
  // The file is shared alone (some apps drop attachments when text rides
  // along); the note is shown here to copy as a follow-up message instead.
  function shareFile(blob, fname, text) {
    return new Promise(resolve => {
      const file = new File([blob], fname, { type: blob.type || 'application/zip' });
      const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
      const size = blob.size >= 1048576 ? (blob.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(blob.size / 1024)) + ' KB';
      const sheet = el(
        '<div class="handoff"><div class="card">' +
        '<div class="kicker">packed and ready</div>' +
        '<p style="margin:8px 0 0; word-break:break-word"><b>' + esc(fname) + '</b> <span class="hint">· ' + size + '</span></p>' +
        '<div class="btn-row" style="margin-top:12px">' +
        (canShare ? '<button class="btn primary" data-hshare>📤 Send it</button>' : '') +
        '<button class="btn' + (canShare ? '' : ' primary') + '" data-hsave>⤓ Save the file</button>' +
        '<button class="btn ghost" data-hdone>done</button></div>' +
        (canShare ? '' : '<p class="hint" style="margin-top:10px">This browser can’t hand files straight to other apps — save it, then send it over any way you like.</p>') +
        (text ? '<p class="hint" style="margin-top:10px">Words to send along: “' + esc(text) + '” <button class="btn ghost" data-hcopy style="padding:4px 10px; font-size:12px">⧉ copy</button></p>' : '') +
        '</div></div>');
      const close = () => { sheet.remove(); resolve(); };
      const shareBtn = sheet.querySelector('[data-hshare]');
      if (shareBtn) shareBtn.onclick = async () => {
        try { await navigator.share({ files: [file] }); close(); }
        catch (e) {
          if (e && e.name === 'AbortError') return;   // they closed the OS sheet — the offer stays
          toast('The share sheet didn’t take it — “Save the file” works everywhere.');
        }
      };
      sheet.querySelector('[data-hsave]').onclick = () => {
        UI.downloadBlob(blob, fname);
        toast('Saved “' + fname + '” — send the file over any way you like.');
      };
      const copyBtn = sheet.querySelector('[data-hcopy]');
      if (copyBtn) copyBtn.onclick = async () => {
        try { await navigator.clipboard.writeText(text); toast('Copied — paste it into any message.'); }
        catch (e) { prompt('Copy this message:', text); }
      };
      sheet.querySelector('[data-hdone]').onclick = close;
      document.body.appendChild(sheet);
    });
  }

  // =========================================================
  // GUEST PAGE — what an invite link opens, on the invitee's own phone.
  // No PIN, no setup, nothing saved here: record → send it back.
  // =========================================================
  async function guestScreen(root) {
    const inv = App.S.params.invite || {};
    const kid = (inv.kid || '').slice(0, 40) || 'someone little';
    const book = (inv.book || '').slice(0, 120) || null;
    const note = (inv.note || '').slice(0, 200) || null;
    DB.metrics.bump('guest.opened');

    root.appendChild(el(
      '<div class="kicker">an invitation to read</div>' +
      '<h1 class="screen-title">Read to ' + esc(kid) + ' — from right where you are</h1>' +
      '<p class="screen-sub">Catherine’s Corner is a little app where the people ' + esc(kid) +
      ' loves read favorite books aloud — every recording is kept on ' + esc(kid) + '’s own shelf, to listen to for years. ' +
      'Nothing to install, no account: record right here, send it back, and it lands on their shelf. ' +
      '<a href="' + esc(siteURL()) + '" target="_blank" rel="noopener">See what it looks like ↗</a></p>'));

    root.appendChild(el(
      '<div class="card" style="margin-bottom:14px"><div class="kicker">they asked for</div>' +
      '<h2 class="serif" style="font-size:20px; font-weight:600; margin-top:6px">' +
      (book ? '“' + esc(book) + '”' : 'Any book or story you love — your pick') + '</h2>' +
      (note ? '<p class="hint" style="margin-top:6px">“' + esc(note) + '”</p>' : '') +
      '<p class="hint" style="margin-top:8px">Just read the way you always do — pauses, giggles and all. ' +
      'The pictures come later, on their side.</p></div>'));

    const stageWrap = el('<div></div>');
    root.appendChild(stageWrap);

    function showCapture() {
      stageWrap.innerHTML = '';
      stageWrap.appendChild(capturePanel({
        statusIdle: 'ready when you are',
        note: '…or bring a recording you already made — a voice memo works beautifully.',
        onAudio: (blob, duration) => { DB.metrics.bump('guest.recorded'); showSend(blob, duration); },
      }));
      stageWrap.appendChild(el(
        '<p class="hint" style="margin-top:12px">💡 Keep this link — any time you’d like to send ' + esc(kid) +
        ' a new story, come back here and record another.</p>'));
    }

    function showSend(blob, duration) {
      stageWrap.innerHTML = '';
      const ext = Backup.audioExt(blob.type);
      const fname = UI.safeName('for ' + kid + ' - ' + (book || 'a story') + '.' + ext);
      const url = URL.createObjectURL(blob);
      const card = el(
        '<div class="card"><div class="kicker">your reading — ' + fmt(duration || 0) + '</div>' +
        '<p class="hint" style="margin-top:8px">Listen back if you like, then send it on its way. ' +
        'The easiest way: reply to the text or email that brought you here, with this recording attached.</p>' +
        '<audio controls style="width:100%; margin-top:12px" src="' + url + '"></audio>' +
        '<div class="btn-row">' +
        '<button class="btn primary big" id="send">⧉ Send it back</button>' +
        '<a class="btn" id="dl" download="' + esc(fname) + '" href="' + url + '">⤓ Save the file</a>' +
        '<button class="btn ghost" id="again">↺ record again</button>' +
        '</div>' +
        '<p class="hint" style="margin-top:10px">Nothing was uploaded anywhere — this recording exists only here until you send it.</p></div>');
      stageWrap.appendChild(card);
      card.querySelector('#send').onclick = async () => {
        DB.metrics.bump('guest.sendback');
        const file = new File([blob], fname, { type: blob.type || 'audio/webm' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file], text: 'A reading for ' + kid + ' 🌙' }); return; }
          catch (e) { if (e && e.name === 'AbortError') return; /* sheet failed — fall back to the file */ }
        }
        card.querySelector('#dl').click();
        toast('Saved the file — attach it to a reply so it reaches ' + kid + '’s shelf.');
      };
      card.querySelector('#again').onclick = () => { URL.revokeObjectURL(url); showCapture(); };
    }

    showCapture();
  }

  App.register('guest', guestScreen, { guest: true });

  // =========================================================
  // GIVE PAGE — what a #give= link opens on the guest's own phone.
  // Same warmth as the invite guest page, but the recording is UPLOADED to the
  // family's cloud inbox (Cloud does the only networking) — it lands on the
  // child's shelf the moment the grown-up taps to accept it. No PIN, no account,
  // nothing kept on this device.
  // =========================================================
  async function giveScreen(root) {
    const token = App.S.params.give;
    DB.metrics.bump('give.opened');

    root.appendChild(el(
      '<div class="kicker">an invitation to read</div>' +
      '<h1 class="screen-title">Read a story — it lands right on their shelf</h1>' +
      '<p class="screen-sub">Catherine’s Corner keeps the voices of the people a little one loves, to listen to for years. ' +
      'Nothing to install, no account: read aloud right here, and when you send it, it goes straight onto their shelf. ' +
      '<a href="' + esc(siteURL()) + '" target="_blank" rel="noopener">See what it looks like ↗</a></p>'));

    const stageWrap = el('<div></div>');
    root.appendChild(stageWrap);

    function showCapture() {
      stageWrap.innerHTML = '';
      stageWrap.appendChild(capturePanel({
        statusIdle: 'ready when you are',
        note: '…or bring a recording you already made — a voice memo works beautifully.',
        onAudio: (blob, duration) => { DB.metrics.bump('give.recorded'); showSend(blob, duration); },
      }));
      stageWrap.appendChild(el(
        '<p class="hint" style="margin-top:12px">💡 Keep this link — any time you’d like to send another story, come back here and record again.</p>'));
    }

    function showSend(blob, duration) {
      stageWrap.innerHTML = '';
      const url = URL.createObjectURL(blob);
      const card = el(
        '<div class="card"><div class="kicker">your reading — ' + fmt(duration || 0) + '</div>' +
        '<p class="hint" style="margin-top:8px">Listen back if you like, then put it on the shelf.</p>' +
        '<audio controls style="width:100%; margin-top:12px" src="' + url + '"></audio>' +
        '<div class="field" style="margin-top:12px"><label>Your name (so they know who read)</label>' +
        '<input type="text" id="gname" placeholder="e.g. Grandma" maxlength="60"></div>' +
        '<div class="field"><label>A little note (optional)</label>' +
        '<input type="text" id="gnote" placeholder="e.g. love you to the moon" maxlength="200"></div>' +
        '<div class="btn-row">' +
        '<button class="btn primary big" id="put">📚 Put it on the shelf</button>' +
        '<button class="btn ghost" id="again">↺ record again</button></div>' +
        '<div id="gprog" class="hint" style="margin-top:10px"></div></div>');
      stageWrap.appendChild(card);
      card.querySelector('#again').onclick = () => { URL.revokeObjectURL(url); showCapture(); };
      card.querySelector('#put').onclick = async () => {
        const put = card.querySelector('#put'), prog = card.querySelector('#gprog');
        const fromName = (card.querySelector('#gname').value || '').trim();
        const note = (card.querySelector('#gnote').value || '').trim();
        put.disabled = true;
        try {
          prog.textContent = 'Sending… 0%';
          const { sha256, mime } = await Cloud.inboxUpload(token, blob, (p) => { prog.textContent = 'Sending… ' + Math.round(p * 100) + '%'; });
          prog.textContent = 'Almost there…';
          await Cloud.inboxCommit(token, { blobSha256: [sha256], mime, fromName, note });
          DB.metrics.bump('give.sent');
          URL.revokeObjectURL(url);
          showDone(fromName);
        } catch (e) {
          put.disabled = false; prog.textContent = '';
          toast(/40[34]|not found|expired/i.test(e.message || '')
            ? 'This invitation has expired — ask them to send a fresh link.'
            : 'That didn’t go through — check your connection and try again.');
        }
      };
    }

    function showDone(fromName) {
      stageWrap.innerHTML = '';
      const done = el(
        '<div class="card" style="text-align:center"><div style="font-size:40px">✓</div>' +
        '<h2 class="serif" style="font-size:22px; margin-top:6px">It’s on the shelf.</h2>' +
        '<p class="hint" style="margin-top:8px">Thank you' + (fromName ? ', ' + esc(fromName) : '') +
        ' — your voice is waiting for them now. Come back to this link any time to send another.</p>' +
        '<div class="btn-row" style="justify-content:center"><button class="btn" id="more">Record another</button></div></div>');
      stageWrap.appendChild(done);
      done.querySelector('#more').onclick = () => showCapture();
    }

    showCapture();
  }

  App.register('give', giveScreen, { guest: true });

  window.Send = { appURL, siteURL, inviteLink, decodeInvite, inviteFromHash, giveFromHash, requestMessage, sendRow, shareText, shareFile };
})();
