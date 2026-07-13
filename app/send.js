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
  function encodeInvite(payload) {
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeInvite(str) {
    try {
      const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
      return sanitizeInvite(JSON.parse(decodeURIComponent(escape(atob(b64)))));
    } catch (e) { return null; }
  }
  function inviteLink(payload) {
    return appURL() + '#invite=' + encodeInvite(sanitizeInvite(payload));
  }
  function inviteFromHash() {
    const m = (location.hash || '').match(/#invite=([A-Za-z0-9\-_]+)/);
    return m ? decodeInvite(m[1]) : null;
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

  // Share any file through the sheet, falling back to a plain download —
  // used for parcels (and anything else that must reach another person).
  async function shareFile(blob, fname, text) {
    const file = new File([blob], fname, { type: blob.type || 'application/zip' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], text }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; /* sheet failed — fall back */ }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast('Saved “' + fname + '” — send the file over any way you like.');
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
      const fname = ('for ' + kid + ' - ' + (book || 'a story') + '.' + ext).replace(/[/\\?%*:|"<>]/g, '-');
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

  window.Send = { appURL, siteURL, inviteLink, decodeInvite, inviteFromHash, requestMessage, sendRow, shareText, shareFile };
})();
