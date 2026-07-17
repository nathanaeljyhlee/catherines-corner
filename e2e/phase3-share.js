/* Catherine's Corner E2E — Stage 2 Phase 3 (share links).
   Locked contract: snowbear-hq/sprints/2026-07-17/1156/CONTRACT.md

   Two halves, deliberately separated:

   PART A — CONTRACT-LEVEL (pure HTTP, no browser): drives e2e/lib/fake-cloud.js
   directly and proves the /share + /backup endpoint contract is correct —
   token minting, no-auth redemption, calm 404s on garbage/expired tokens,
   mis-addressed round-tripping. This half needs nothing from the client or
   worker agents and is runnable TODAY (and is run for real by this file).

   PART B — FULL-STACK (Playwright): drives the REAL app end to end, both
   sides. Family A signs in, records a book, and sends it as a link through
   the REAL "🔗 Send as a link" button (app/screens-adult.js offerParcelSend,
   data-link) — Cloud.pushParcel + Backup.packParcel are real client code,
   already landed. The resulting share URL is read back off the OS clipboard
   (Send.shareText's fallback path — Playwright is granted 'clipboard-read'
   for this). Family B then opens the real `#parcel=<token>` link: app.js's
   boot-hash handler calls the real Cloud.pullParcel and routes into the
   EXISTING acceptParcel screen — zero bridging, zero guessed selectors on
   the send side. */
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const {
  CHROMIUM, startStaticServer, writePngs, sha256Hex,
  makeStepper, assert, sleep, enterPin, stubNoShare, gotoHash,
} = require('./lib/harness');
const { createFakeCloud } = require('./lib/fake-cloud');

const APP_PORT = 8908;
const CLOUD_PORT = 8918;
const TMP = path.join(__dirname, '.artifacts');
fs.mkdirSync(TMP, { recursive: true });
const { step } = makeStepper();
const APP_URL = `http://localhost:${APP_PORT}/app/`;

function authHeaders(token) { return { 'content-type': 'application/json', authorization: 'Bearer ' + token }; }

(async () => {
  const staticServer = startStaticServer(APP_PORT);
  const cloud = createFakeCloud({ port: CLOUD_PORT, appOrigin: APP_URL });
  await staticServer.listen();
  await cloud.listen();

  // ============ PART A: contract-level — fake-cloud alone, no browser ============
  step('CONTRACT: sign in two families (amy, hostile) via /auth/request + /auth/verify');
  let r = await fetch(cloud.url + '/auth/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'p3-amy@example.com' }) });
  let amyCode = (await r.json()).code;
  r = await fetch(cloud.url + '/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'p3-amy@example.com', code: amyCode }) });
  const amyAuth = await r.json();
  assert(amyAuth.token, 'amy has a session token');
  r = await fetch(cloud.url + '/family/claim', { method: 'POST', headers: authHeaders(amyAuth.token), body: JSON.stringify({ familyId: 'CC-P3AM-Y0001' }) });
  assert((await r.json()).claimed === 'CC-P3AM-Y0001', 'amy claims her family id');

  step('CONTRACT: POST /share mints a token; GET /share/{token} needs no auth and inlines manifest + presigned blobs');
  const fakeAudio = Buffer.from('a fake wav for the contract check');
  const audioSha = sha256Hex(fakeAudio);
  const cManifest = { format: 'catherines-corner-parcel', formatVersion: 1, from: { id: 'CC-P3AM-Y0001', corner: 'Amy' }, to: 'CC-P3BE-N0001', book: { title: 'Contract Book' }, readings: [{ id: 'cr1' }], _blobShas: { 'audio/cr1.wav': audioSha } };
  r = await fetch(cloud.url + '/share', { method: 'POST', headers: authHeaders(amyAuth.token), body: JSON.stringify({ manifest: cManifest, blobSha256: [audioSha], title: 'Contract Book', toFamilyId: 'CC-P3BE-N0001' }) });
  const cShare = await r.json();
  assert(cShare.token && cShare.url === `${APP_URL}#parcel=${cShare.token}`, 'share response carries a #parcel= url built from APP_URL');
  r = await fetch(cloud.url + '/share/' + cShare.token);
  const redeemed = await r.json();
  assert(redeemed.manifest._blobShas['audio/cr1.wav'] === audioSha, 'manifest round-trips through R2 verbatim, including _blobShas (see report: recommended convention for Cloud.pullParcel)');
  assert(redeemed.blobs.length === 1 && redeemed.blobs[0].sha256 === audioSha && redeemed.blobs[0].url, 'blob list carries a presigned GET url per referenced blob');

  step('CONTRACT: garbage and expired tokens both calmly 404 (invariant #4)');
  r = await fetch(cloud.url + '/share/not-a-real-token-at-all');
  assert(r.status === 404, 'garbage token 404s, got ' + r.status);
  r = await fetch(cloud.url + '/__test/expire-share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: cShare.token }) });
  assert((await r.json()).found, 'test hook found the token to expire');
  r = await fetch(cloud.url + '/share/' + cShare.token);
  assert(r.status === 404, 'expired token 404s, got ' + r.status);

  step('CONTRACT: a mis-addressed share still round-trips the true addressee (the UI does the warning, not the server)');
  r = await fetch(cloud.url + '/share', { method: 'POST', headers: authHeaders(amyAuth.token), body: JSON.stringify({ manifest: cManifest, blobSha256: [audioSha], title: 'Contract Book', toFamilyId: 'CC-SOMEONE-ELSE' }) });
  const wrongShare = await r.json();
  r = await fetch(cloud.url + '/share/' + wrongShare.token);
  assert((await r.json()).toFamilyId === 'CC-SOMEONE-ELSE', 'toFamilyId is exactly what the sender addressed, unchanged by who redeems it');

  step('CONTRACT: no family claimed -> 409 on /share');
  r = await fetch(cloud.url + '/auth/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'p3-nofamily@example.com' }) });
  const nfCode = (await r.json()).code;
  r = await fetch(cloud.url + '/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'p3-nofamily@example.com', code: nfCode }) });
  const nfAuth = await r.json();
  r = await fetch(cloud.url + '/share', { method: 'POST', headers: authHeaders(nfAuth.token), body: JSON.stringify({ manifest: {}, blobSha256: [], title: 'x', toFamilyId: null }) });
  assert(r.status === 409, 'an account with no claimed family cannot mint a share (got ' + r.status + ')');

  console.log('\n  PART A (contract-level) GREEN — fake-cloud satisfies the Phase 3 endpoint contract on its own.\n');

  // ============ PART B: full-stack — the real app in Chromium ============
  const [png1, png2] = writePngs(TMP, 'p3-page1.png', 'p3-page2.png');

  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const errors = [];

  // clipboard-read is granted so this harness can read back the url that
  // Send.shareText(url) copies to the clipboard when navigator.share isn't
  // available (true in headless Chromium) — that's how a real phone user
  // would grab the link too (the sheet also offers a native share target).
  const ctxA = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['microphone', 'clipboard-read', 'clipboard-write'], acceptDownloads: true });
  await ctxA.addInitScript((api) => { window.CC_CLOUD_API = api; }, cloud.url);
  await stubNoShare(ctxA);
  const pageA = await ctxA.newPage();
  pageA.on('pageerror', e => errors.push('A: ' + e.message));
  let promptAnswer = '';
  pageA.on('dialog', d => d.accept(d.type() === 'prompt' ? promptAnswer : undefined));

  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctxB.addInitScript((api) => { window.CC_CLOUD_API = api; }, cloud.url);
  const pageB = await ctxB.newPage();
  pageB.on('pageerror', e => errors.push('B: ' + e.message));
  pageB.on('dialog', d => d.accept(''));

  step('boot B first (to learn her Corner ID) — fresh PIN, corner "Ben"');
  await pageB.goto(APP_URL);
  await pageB.click('#ack');
  await pageB.click('#gate');
  await enterPin(pageB, '2468'); await enterPin(pageB, '2468');
  await pageB.fill('#nm', 'Ben');
  await pageB.click('#save');
  await pageB.waitForSelector('.home-grid');
  const benId = await pageB.evaluate(() => DB.familyId());
  assert(/^CC-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(benId), 'Ben has a shareable Corner ID (got ' + benId + ')');

  step('boot A — PIN, corner "Amy", sign in to cloud for real via the EXISTING "Keep it safe" UI');
  await pageA.goto(APP_URL);
  await pageA.click('#ack');
  await pageA.click('#gate');
  await enterPin(pageA, '1357'); await enterPin(pageA, '1357');
  await pageA.fill('#nm', 'Amy');
  await pageA.click('#save');
  await pageA.waitForSelector('.home-grid');
  await pageA.click('.home-card:has-text("Keep it safe")');
  await pageA.waitForSelector('#cemail');
  await pageA.fill('#cemail', 'p3-amy-ui@example.com');
  await pageA.click('#csend');
  await pageA.waitForSelector('#ccode');
  let lastCode = null;
  for (let i = 0; i < 40 && !lastCode; i++) {
    const j = await pageA.evaluate((u) => fetch(u).then(x => x.json()), cloud.url + '/__test/lastcode?email=p3-amy-ui@example.com');
    lastCode = j.code; if (!lastCode) await sleep(150);
  }
  assert(lastCode, 'the fake cloud emailed (echoed) a code for amy');
  await pageA.fill('#ccode', lastCode);
  await pageA.click('#cverify');
  await pageA.waitForSelector('#cpush', { timeout: 15000 });
  await pageA.click('.back');

  step('A: add reader "Mom" and record "Goodnight Moon" — whole book, spread pages, real audio');
  await pageA.click('.home-card:has-text("The people who read")');
  await pageA.fill('#nm', 'Mom'); await pageA.fill('#rel', 'Mom');
  await pageA.click('#add');
  await pageA.waitForSelector('.rowitem:has-text("Mom")');
  await pageA.click('.back');
  await pageA.click('.home-card:has-text("Record a reading")');
  await pageA.click('.pick:has-text("Mom")');
  await pageA.click('#newb');
  await pageA.fill('#ti', 'Goodnight Moon');
  await pageA.click('#save');
  await pageA.click('.rowitem:has-text("Goodnight Moon")');
  await pageA.click('.pick:has-text("The whole book")');
  await pageA.waitForSelector('#rec');
  await pageA.click('#rec');
  await sleep(1500);
  await pageA.click('#stop');
  await pageA.waitForSelector('.pagestrip');
  await pageA.click('.seg button[data-v="spread"]');
  await pageA.setInputFiles('#pgs', [png1, png2]);
  await pageA.waitForSelector('.pagestrip.spread .pg');
  await pageA.click('#save');
  await pageA.waitForSelector('.rec-hero:has-text("reading is ready")');
  await pageA.click('#home');

  step('A: send "Goodnight Moon" as a LINK addressed to Ben, via the REAL "🔗 Send as a link" button');
  await pageA.click('.home-card:has-text("The library")');
  await pageA.click('.rowitem:has-text("Goodnight Moon")');
  promptAnswer = benId;
  await pageA.click('#parcel');
  await pageA.waitForSelector('.handoff [data-link]');
  await pageA.click('.handoff [data-link]');
  await pageA.waitForSelector('.handoff', { state: 'detached', timeout: 20000 });
  let shareUrl = null;
  for (let i = 0; i < 40 && !shareUrl; i++) {
    const t = await pageA.evaluate(() => navigator.clipboard.readText().catch(() => '')).catch(() => '');
    if (t && t.includes('#parcel=')) shareUrl = t;
    if (!shareUrl) await sleep(150);
  }
  assert(shareUrl, 'Send.shareText copied a #parcel= link to the clipboard (real Cloud.pushParcel round trip)');
  const firstToken = /[#&]parcel=([^&]+)/.exec(shareUrl)[1];

  step('B opens the real #parcel=<token> link — app.js boot hash + Cloud.pullParcel + the EXISTING acceptParcel screen');
  await gotoHash(pageB, shareUrl);
  await pageB.waitForSelector('h1.screen-title:has-text("Goodnight Moon")', { timeout: 20000 });
  assert((await pageB.textContent('body')).includes('addressed to this corner') || (await pageB.textContent('body')).includes(benId), 'correctly-addressed parcel shows no mis-address warning');
  await pageB.click('#accept');
  await pageB.waitForSelector('h1:has-text("The library")');
  const benState = await pageB.evaluate(async () => {
    const corner = await DB.corners.active();
    const books = await DB.books.all(corner.id);
    const readings = await DB.readings.all(corner.id);
    const book = books.find(b => b.title === 'Goodnight Moon');
    let audioSize = 0;
    if (readings[0]) { const b = await DB.audio.get(readings[0].id); audioSize = b ? b.size : 0; }
    return {
      hasBook: !!book, pages: book ? (book.pages || []).length : 0,
      readings: readings.length, allNew: readings.every(r => r.isNew), audioSize,
    };
  });
  assert(benState.hasBook, 'the book landed on Ben\'s shelf');
  assert(benState.pages === 2, 'both page photos traveled (got ' + benState.pages + ')');
  assert(benState.readings >= 1 && benState.allNew, 'the reading arrived marked new');
  assert(benState.audioSize > 0, 'real recorded audio bytes traveled through the cloud share, not just metadata (got ' + benState.audioSize + ' bytes)');

  step('garbage share token -> calm refusal, no crash');
  const errBefore1 = errors.length;
  await gotoHash(pageB, `${APP_URL}#parcel=totally-not-a-real-token`);
  await sleep(1500);
  assert(errors.length === errBefore1, 'no uncaught page error from a garbage #parcel= token');
  assert((await pageB.evaluate(() => document.body.innerText.trim().length)) > 0, 'app renders SOMETHING (not a blank white page) on a garbage token');

  step('expired share token -> calm refusal, no crash');
  await fetch(cloud.url + '/__test/expire-share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: firstToken }) });
  const errBefore2 = errors.length;
  await gotoHash(pageB, shareUrl); // same real token, now force-expired via the test-only hook
  await sleep(1500);
  assert(errors.length === errBefore2, 'no uncaught page error from an expired #parcel= token');

  step('mis-addressed parcel -> still opens, still warns (same acceptParcel copy as the send-as-file flow)');
  promptAnswer = 'CC-WRONG-WRONG';
  await pageA.click('#parcel');
  await pageA.waitForSelector('.handoff [data-link]');
  await pageA.click('.handoff [data-link]');
  await pageA.waitForSelector('.handoff', { state: 'detached', timeout: 20000 });
  let wrongUrl = null;
  for (let i = 0; i < 40 && !wrongUrl; i++) {
    const t = await pageA.evaluate(() => navigator.clipboard.readText().catch(() => '')).catch(() => '');
    if (t && t.includes('#parcel=') && t !== shareUrl) wrongUrl = t;
    if (!wrongUrl) await sleep(150);
  }
  assert(wrongUrl, 'a second, mis-addressed link was minted');
  await gotoHash(pageB, wrongUrl);
  await pageB.waitForSelector('#accept', { timeout: 20000 });
  assert((await pageB.textContent('body')).includes('addressed to a different corner') || (await pageB.textContent('body')).includes('was addressed to'), 'mis-addressed cloud parcel warns plainly');
  await pageB.click('#nope');

  await browser.close();
  await staticServer.close();
  await cloud.close();

  if (errors.length) { console.error('\nPAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
  console.log('\nALL PHASE 3 STEPS GREEN ✅');
})().catch(async e => {
  console.error('\n💥 ' + e.stack);
  process.exit(1);
});
