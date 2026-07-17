/* Catherine's Corner E2E — Stage 2 Phase 4 (invite uploads / inbox).
   Locked contract: snowbear-hq/sprints/2026-07-17/1156/CONTRACT.md

   Same two-part shape as phase3-share.js:

   PART A — CONTRACT-LEVEL (pure HTTP, no browser): drives e2e/lib/fake-cloud.js
   directly. Covers everything the contract can be checked against WITHOUT any
   new UI existing yet: invite minting, guest upload+commit with NO session
   (invite-token-only auth), the parent's /inbox view, accept, and BOTH
   invariant #4 cases — a hostile second family cannot read or accept family
   A's inbox, and an expired invite token cannot upload. Runnable TODAY.

   PART B — FULL-STACK (Playwright): drives the REAL app end to end. The
   parent signs in through the EXISTING "Keep it safe" cloud-auth UI, mints a
   real "🔗 record on the shelf" invite from the Book requests screen
   (app/screens-adult.js, [data-shelf] → Cloud.createInvite + Send.shareText —
   real client code, already landed), and reads the resulting `#give=` link
   back off the clipboard (same technique as phase3-share.js). The guest opens
   that link for real (app/send.js giveScreen, #gname/#gnote/#put — also
   landed) and it uploads through Cloud.inboxUpload/inboxCommit. The parent
   then uses the real "🎁 Check for recordings sent to the shelf" link
   (#checkarr, under Keep it safe) and the real arrived-card on the home
   screen (renderArrivals in screens-adult.js) to accept it — which hands off
   to the EXISTING App.startRecordFlow (who → told → pass 2, same path the
   original e2e.js suite already exercises for the local share-target). */
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const {
  CHROMIUM, startStaticServer, makeStepper, assert, sleep, enterPin, sha256Hex, stubNoShare, gotoHash,
} = require('./lib/harness');
const { createFakeCloud } = require('./lib/fake-cloud');

const APP_PORT = 8909;
const CLOUD_PORT = 8919;
const TMP = path.join(__dirname, '.artifacts');
fs.mkdirSync(TMP, { recursive: true });
const { step } = makeStepper();
const APP_URL = `http://localhost:${APP_PORT}/app/`;

function authHeaders(token) { return { 'content-type': 'application/json', authorization: 'Bearer ' + token }; }
async function signInViaFakeAuth(email) {
  let r = await fetch(`http://localhost:${CLOUD_PORT}/auth/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  const code = (await r.json()).code;
  r = await fetch(`http://localhost:${CLOUD_PORT}/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code }) });
  return r.json(); // { token, email }
}

(async () => {
  const staticServer = startStaticServer(APP_PORT);
  const cloud = createFakeCloud({ port: CLOUD_PORT, appOrigin: APP_URL });
  await staticServer.listen();
  await cloud.listen();

  // ============ PART A: contract-level — fake-cloud alone, no browser ============
  step('CONTRACT: parent signs in, claims a family, mints an invite');
  const parent = await signInViaFakeAuth('p4-parent@example.com');
  assert(parent.token, 'parent has a session token');
  let r = await fetch(cloud.url + '/family/claim', { method: 'POST', headers: authHeaders(parent.token), body: JSON.stringify({ familyId: 'CC-P4PA-RENT' }) });
  assert((await r.json()).claimed === 'CC-P4PA-RENT', 'parent claims her family');
  r = await fetch(cloud.url + '/invite', { method: 'POST', headers: authHeaders(parent.token), body: JSON.stringify({ kidName: 'Pip', bookTitle: null, expiresDays: 30 }) });
  const invite = await r.json();
  assert(invite.inviteToken && invite.url === `${APP_URL}#give=${invite.inviteToken}`, 'invite response carries a #give= url built from APP_URL');

  step('CONTRACT: guest uploads + commits with NO session — only the invite token');
  const memo = Buffer.from('grandma reads goodnight moon, a fake memo for the contract check');
  const memoSha = sha256Hex(memo);
  r = await fetch(cloud.url + `/inbox/${invite.inviteToken}/upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blobs: [{ sha256: memoSha, bytes: memo.length, mime: 'audio/webm' }] }) });
  const upload = await r.json();
  assert(upload.uploads[0].url, 'guest gets a presigned PUT with no Authorization header at all');
  r = await fetch(upload.uploads[0].url, { method: 'PUT', body: memo });
  assert(r.ok, 'guest PUT lands the recording');
  r = await fetch(cloud.url + `/inbox/${invite.inviteToken}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blobSha256: [memoSha], mime: 'audio/webm', fromName: 'Grandma', note: 'a bedtime story' }) });
  const commit = await r.json();
  assert(commit.ok && commit.id, 'commit creates an inbox_item');

  step('CONTRACT: parent sees the arrival; the recorded bytes are exactly what the guest sent');
  r = await fetch(cloud.url + '/inbox', { headers: authHeaders(parent.token) });
  const parentInbox = await r.json();
  assert(parentInbox.items.length === 1 && parentInbox.items[0].fromName === 'Grandma' && parentInbox.items[0].note === 'a bedtime story', 'inbox item carries fromName + note');
  r = await fetch(parentInbox.items[0].blobUrl);
  assert(Buffer.compare(Buffer.from(await r.arrayBuffer()), memo) === 0, 'inbox blobUrl returns the exact recorded bytes');

  step('CONTRACT (invariant #4): a hostile second family cannot read or accept the parent\'s inbox');
  const hostile = await signInViaFakeAuth('p4-hostile@example.com');
  r = await fetch(cloud.url + '/family/claim', { method: 'POST', headers: authHeaders(hostile.token), body: JSON.stringify({ familyId: 'CC-P4HO-STILE' }) });
  assert(r.ok, 'hostile family claims its OWN corner');
  r = await fetch(cloud.url + '/inbox', { headers: authHeaders(hostile.token) });
  assert((await r.json()).items.length === 0, "hostile family's GET /inbox does not leak the parent's item");
  r = await fetch(cloud.url + `/inbox/${commit.id}/accept`, { method: 'POST', headers: authHeaders(hostile.token) });
  assert(r.status === 404, "hostile family cannot accept the parent's item (got " + r.status + ')');
  r = await fetch(cloud.url + '/inbox', { headers: authHeaders(parent.token) });
  assert((await r.json()).items.length === 1, 'the item is still open for the rightful family after the hostile attempt');

  step('CONTRACT: the rightful family accepts; the item drops out of the open inbox');
  r = await fetch(cloud.url + `/inbox/${commit.id}/accept`, { method: 'POST', headers: authHeaders(parent.token) });
  assert(r.ok, 'parent accepts her own item');
  r = await fetch(cloud.url + '/inbox', { headers: authHeaders(parent.token) });
  assert((await r.json()).items.length === 0, 'accepted items are no longer "open"');

  step('CONTRACT (invariant #4): an expired invite token cannot upload');
  r = await fetch(cloud.url + '/invite', { method: 'POST', headers: authHeaders(parent.token), body: JSON.stringify({ kidName: 'Pip', expiresDays: 1 }) });
  const staleInvite = await r.json();
  await fetch(cloud.url + '/__test/expire-invite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken: staleInvite.inviteToken }) });
  r = await fetch(cloud.url + `/inbox/${staleInvite.inviteToken}/upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blobs: [{ sha256: 'x', bytes: 1, mime: 'audio/wav' }] }) });
  assert(!r.ok, 'expired invite token refuses an upload (got ' + r.status + ')');
  r = await fetch(cloud.url + `/inbox/garbage-token-xyz/upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blobs: [] }) });
  assert(!r.ok, 'a garbage invite token refuses too (got ' + r.status + ')');

  console.log('\n  PART A (contract-level) GREEN — fake-cloud satisfies the Phase 4 endpoint contract + isolation invariant on its own.\n');

  // ============ PART B: full-stack — the real app in Chromium ============
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const errors = [];

  const ctxP = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['clipboard-read', 'clipboard-write'] });
  await ctxP.addInitScript((api) => { window.CC_CLOUD_API = api; }, cloud.url);
  await stubNoShare(ctxP);
  const pageP = await ctxP.newPage();
  pageP.on('pageerror', e => errors.push('P: ' + e.message));
  pageP.on('dialog', d => d.accept(''));

  const ctxG = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['microphone'], acceptDownloads: true });
  await ctxG.addInitScript((api) => { window.CC_CLOUD_API = api; }, cloud.url);
  const pageG = await ctxG.newPage();
  pageG.on('pageerror', e => errors.push('G: ' + e.message));
  pageG.on('dialog', d => d.accept(''));

  step('boot parent P — PIN, corner "Pip", add reader "Mom", sign in via the EXISTING "Keep it safe" cloud UI');
  await pageP.goto(APP_URL);
  await pageP.click('#ack');
  await pageP.click('#gate');
  await enterPin(pageP, '3141'); await enterPin(pageP, '3141');
  await pageP.fill('#nm', 'Pip');
  await pageP.click('#save');
  await pageP.waitForSelector('.home-grid');
  await pageP.click('.home-card:has-text("The people who read")');
  await pageP.fill('#nm', 'Mom'); await pageP.fill('#rel', 'Mom');
  await pageP.click('#add');
  await pageP.waitForSelector('.rowitem:has-text("Mom")');
  await pageP.click('.back');
  await pageP.click('.home-card:has-text("Keep it safe")');
  await pageP.waitForSelector('#cemail');
  await pageP.fill('#cemail', 'p4-parent-ui@example.com');
  await pageP.click('#csend');
  await pageP.waitForSelector('#ccode');
  let lastCode = null;
  for (let i = 0; i < 40 && !lastCode; i++) {
    const j = await pageP.evaluate((u) => fetch(u).then(x => x.json()), cloud.url + '/__test/lastcode?email=p4-parent-ui@example.com');
    lastCode = j.code; if (!lastCode) await sleep(150);
  }
  assert(lastCode, 'the fake cloud emailed (echoed) a code for the parent');
  await pageP.fill('#ccode', lastCode);
  await pageP.click('#cverify');
  await pageP.waitForSelector('#cpush', { timeout: 15000 });
  // BUG FOUND (see report): Cloud.createInvite() posts straight to /invite
  // with no ensureIdentity()/claim() first, unlike Cloud.pushParcel — a
  // freshly signed-in parent who hasn't backed up yet gets a silent 409 and
  // a generic "Couldn't make a shelf link just now" toast that never says
  // why. Claiming explicitly here so the rest of THIS test can proceed;
  // a real family would only avoid this by having already pushed a backup.
  await pageP.evaluate(() => Cloud.claim());
  await pageP.click('.back');

  step('P: mint a real "🔗 record on the shelf" invite from Book requests');
  await pageP.click('.home-card:has-text("Book requests")');
  await pageP.click('#add'); // no reader/book selected -> "anyone who loves them" / "any book"
  await pageP.waitForSelector('.rowitem.stacked');
  const shelfBtn = await pageP.$('[data-shelf]');
  assert(shelfBtn, '"🔗 record on the shelf" button rendered on the open request (Cloud + CloudAuth both present)');
  await shelfBtn.click();
  let giveUrl = null;
  for (let i = 0; i < 40 && !giveUrl; i++) {
    const t = await pageP.evaluate(() => navigator.clipboard.readText().catch(() => '')).catch(() => '');
    if (t && t.includes('#give=')) giveUrl = t;
    if (!giveUrl) await sleep(150);
  }
  assert(giveUrl, 'Send.shareText copied a #give= link to the clipboard (real Cloud.createInvite round trip)');

  step('guest opens the real #give=<token> link, records, and puts it on the shelf');
  await pageG.goto(giveUrl);
  await pageG.waitForSelector('#rec', { timeout: 20000 });
  await pageG.click('#rec');
  await sleep(1500);
  await pageG.click('#stop');
  await pageG.waitForSelector('#put', { timeout: 15000 });
  await pageG.fill('#gname', 'Grandma');
  await pageG.fill('#gnote', 'a bedtime story');
  await pageG.click('#put');
  await pageG.waitForFunction(() => document.body.innerText.toLowerCase().includes('on the shelf'), null, { timeout: 20000 });

  step('P: "🎁 Check for recordings sent to the shelf" -> arrived card on the home screen -> accept -> real audio saved');
  await pageP.click('.back'); // Book requests -> grown-up home
  await pageP.waitForSelector('.home-grid');
  await pageP.click('.home-card:has-text("Keep it safe")');
  await pageP.waitForSelector('#checkarr', { timeout: 15000 });
  await pageP.click('#checkarr');
  await pageP.waitForSelector('.home-card:has-text("A recording from Grandma arrived")', { timeout: 20000 });
  await pageP.click('.home-card:has-text("A recording from Grandma arrived")');
  // Cloud.acceptInbox + App.startRecordFlow({audioBlob, duration, imported:true})
  // hand off to the SAME who->told->pass2 path e2e.js's own share-target test
  // already exercises (Part F, "A recording arrived" card).
  await pageP.waitForSelector('.pick:has-text("Mom")', { timeout: 15000 });
  await pageP.click('.pick:has-text("Mom")');
  await pageP.click('#told');
  await pageP.fill('#st', 'From Grandma, on the shelf');
  await pageP.click('#next');
  await pageP.waitForSelector('h1:has-text("Pass 2")', { timeout: 15000 }); // audio already exists -> pass 1 skipped
  await pageP.click('#save');
  await pageP.waitForSelector('.rec-hero:has-text("reading is ready")');
  const parentState = await pageP.evaluate(async () => {
    const corner = await DB.corners.active();
    const readings = await DB.readings.all(corner.id);
    const r = readings.find(x => x.title === 'From Grandma, on the shelf');
    const blob = r ? await DB.audio.get(r.id) : null;
    return { found: !!r, audioSize: blob ? blob.size : 0 };
  });
  assert(parentState.found, 'the inbox recording became a real reading, filed under Mom');
  assert(parentState.audioSize > 0, 'with real audio bytes (got ' + parentState.audioSize + ')');
  // and the accepted item really left the cloud inbox (checked through the
  // app's own signed-in session, not a fresh fetch)
  const remaining = await pageP.evaluate(() => Cloud.checkInbox());
  assert(remaining.items.length === 0, 'the accepted item no longer shows up in the parent\'s own inbox (got ' + remaining.items.length + ')');

  step('HOSTILE (full-stack): a second family signed in for real cannot see the parent\'s inbox');
  const ctxH = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctxH.addInitScript((api) => { window.CC_CLOUD_API = api; }, cloud.url);
  const pageH = await ctxH.newPage();
  pageH.on('pageerror', e => errors.push('H: ' + e.message));
  pageH.on('dialog', d => d.accept(''));
  await pageH.goto(APP_URL);
  await pageH.click('#ack');
  await pageH.click('#gate');
  await enterPin(pageH, '9753'); await enterPin(pageH, '9753');
  await pageH.fill('#nm', 'Hostile');
  await pageH.click('#save');
  await pageH.click('.home-card:has-text("Keep it safe")');
  await pageH.waitForSelector('#cemail');
  await pageH.fill('#cemail', 'p4-hostile-ui@example.com');
  await pageH.click('#csend');
  await pageH.waitForSelector('#ccode');
  let hCode = null;
  for (let i = 0; i < 40 && !hCode; i++) {
    const j = await pageH.evaluate((u) => fetch(u).then(x => x.json()), cloud.url + '/__test/lastcode?email=p4-hostile-ui@example.com');
    hCode = j.code; if (!hCode) await sleep(150);
  }
  await pageH.fill('#ccode', hCode);
  await pageH.click('#cverify');
  await pageH.waitForSelector('#cpush', { timeout: 15000 });
  await pageH.evaluate(() => Cloud.claim()); // give hostile her OWN real claimed family (same createInvite-style gap as the parent hit — see report)
  const hostileItems = await pageH.evaluate((u) => fetch(u, { headers: { authorization: 'Bearer ' + CloudAuth.token() } }).then(r => r.json()), cloud.url + '/inbox');
  assert(Array.isArray(hostileItems.items) && hostileItems.items.length === 0, "a real signed-in hostile session, with her OWN claimed family, cannot see the parent's arrivals (got " + JSON.stringify(hostileItems) + ')');

  await browser.close();
  await staticServer.close();
  await cloud.close();

  if (errors.length) { console.error('\nPAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
  console.log('\nALL PHASE 4 STEPS GREEN ✅');
})().catch(async e => {
  console.error('\n💥 ' + e.stack);
  process.exit(1);
});
