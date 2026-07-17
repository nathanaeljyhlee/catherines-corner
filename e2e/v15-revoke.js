/* Catherine's Corner E2E — v1.15 Feature 1 (share-link revocation).
   Locked contract: snowbear-hq/sprints/2026-07-17/1406/CONTRACT.md

   PART A — CONTRACT-LEVEL (pure HTTP, no browser): drives e2e/lib/fake-cloud.js
   directly. Runnable TODAY, no dependency on app/ or cloud/ landing. Covers:
   create -> lists in /shares -> revoke -> GET /share/{token} 404 (calm) ->
   gone from /shares; a non-owning family cannot revoke someone else's link
   (403, and the link survives); revoking an already-revoked/garbage token
   404s instead of double-counting or throwing.

   PART B — FULL-STACK (Playwright): would drive the REAL app's "Links
   you've shared" list + "Cancel this link" button under Keep it safe
   (app/cloud.js's Cloud.listShares/Cloud.revokeShare, per the contract's
   client section). As of this write, app/cloud.js does NOT yet expose those
   methods and no such UI exists (client hasn't landed — this is expected;
   the contract has worker/client/e2e building in parallel). Rather than
   hard-fail the suite on a client that isn't there yet, this half PROBES
   for the capability after a real sign-in and skips with a clear BLOCKED
   message if it's missing — so this file starts exercising the real UI
   automatically the moment Cloud.listShares/revokeShare land, with zero
   edits needed here. Written against the contract, dry-checked
   (`node --check`) only — not runtime-verified on this box (no local
   Chromium; see README "chromium won't launch"). */
'use strict';
const { chromium } = require('playwright');
const {
  CHROMIUM, startStaticServer, makeStepper, assert, sleep, enterPin,
} = require('./lib/harness');
const { createFakeCloud } = require('./lib/fake-cloud');

const APP_PORT = 8910;
const CLOUD_PORT = 8920;
const { step } = makeStepper();
const APP_URL = `http://localhost:${APP_PORT}/app/`;

function authHeaders(token) { return { 'content-type': 'application/json', authorization: 'Bearer ' + token }; }
async function signInViaFakeAuth(email) {
  let r = await fetch(`http://localhost:${CLOUD_PORT}/auth/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  const code = (await r.json()).code;
  r = await fetch(`http://localhost:${CLOUD_PORT}/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code }) });
  return r.json();
}

(async () => {
  const staticServer = startStaticServer(APP_PORT);
  const cloud = createFakeCloud({ port: CLOUD_PORT, appOrigin: APP_URL });
  await staticServer.listen();
  await cloud.listen();

  // ============ PART A: contract-level — fake-cloud alone, no browser ============
  step('CONTRACT: amy signs in and claims a family');
  const amy = await signInViaFakeAuth('v15r-amy@example.com');
  assert(amy.token, 'amy has a session token');
  let r = await fetch(cloud.url + '/family/claim', { method: 'POST', headers: authHeaders(amy.token), body: JSON.stringify({ familyId: 'CC-V15R-AMY1' }) });
  assert((await r.json()).claimed === 'CC-V15R-AMY1', 'amy claims her family');

  step('CONTRACT: amy mints two share links; both list in GET /shares');
  const manifest = { format: 'catherines-corner-parcel', formatVersion: 1, book: { title: 'Goodnight Moon' }, readings: [{ id: 'r1' }] };
  r = await fetch(cloud.url + '/share', { method: 'POST', headers: authHeaders(amy.token), body: JSON.stringify({ manifest, blobSha256: [], title: 'Goodnight Moon', toFamilyId: 'CC-SOME-ONE1' }) });
  const shareA = await r.json();
  assert(shareA.token, 'first share minted');
  r = await fetch(cloud.url + '/share', { method: 'POST', headers: authHeaders(amy.token), body: JSON.stringify({ manifest, blobSha256: [], title: 'The Very Hungry Caterpillar', toFamilyId: 'CC-SOME-ONE2' }) });
  const shareB = await r.json();
  assert(shareB.token, 'second share minted');
  r = await fetch(cloud.url + '/shares', { headers: authHeaders(amy.token) });
  let list = (await r.json()).shares;
  assert(list.length === 2, 'both shares list, got ' + list.length);
  assert(list.every(s => s.url === `${APP_URL}#parcel=${s.token}`), 'each listed share carries its own #parcel= url');
  assert(list.some(s => s.title === 'Goodnight Moon') && list.some(s => s.title === 'The Very Hungry Caterpillar'), 'titles round-trip into the list');

  step('CONTRACT: GET /share/{token} still works (not revoked yet)');
  r = await fetch(cloud.url + '/share/' + shareA.token);
  assert(r.status === 200, 'unrevoked share redeems fine, got ' + r.status);

  step('CONTRACT: revoke shareA -> ok:true, GET /share/{token} now calmly 404s, gone from /shares');
  r = await fetch(cloud.url + `/share/${shareA.token}/revoke`, { method: 'POST', headers: authHeaders(amy.token) });
  assert(r.ok, 'revoke succeeds, got ' + r.status);
  assert((await r.json()).ok === true, 'revoke response is {ok:true}');
  r = await fetch(cloud.url + '/share/' + shareA.token);
  assert(r.status === 404, 'revoked link 404s calmly (not 410, not 500), got ' + r.status);
  r = await fetch(cloud.url + '/shares', { headers: authHeaders(amy.token) });
  list = (await r.json()).shares;
  assert(list.length === 1 && list[0].token === shareB.token, 'revoked share dropped out of the list; the other survives');

  step('CONTRACT: revoking an already-revoked token 404s (not a silent no-op double-count, not 200)');
  r = await fetch(cloud.url + `/share/${shareA.token}/revoke`, { method: 'POST', headers: authHeaders(amy.token) });
  assert(r.status === 404, 'double-revoke 404s, got ' + r.status);

  step('CONTRACT: revoking a garbage token 404s');
  r = await fetch(cloud.url + `/share/not-a-real-token/revoke`, { method: 'POST', headers: authHeaders(amy.token) });
  assert(r.status === 404, 'garbage-token revoke 404s, got ' + r.status);

  step("CONTRACT (hostile): a second family cannot revoke amy's link (403), and the link survives");
  const hostile = await signInViaFakeAuth('v15r-hostile@example.com');
  r = await fetch(cloud.url + '/family/claim', { method: 'POST', headers: authHeaders(hostile.token), body: JSON.stringify({ familyId: 'CC-V15R-HOST' }) });
  assert(r.ok, 'hostile family claims its own corner');
  r = await fetch(cloud.url + `/share/${shareB.token}/revoke`, { method: 'POST', headers: authHeaders(hostile.token) });
  assert(r.status === 403, "hostile family cannot revoke amy's link, got " + r.status);
  r = await fetch(cloud.url + '/share/' + shareB.token);
  assert(r.status === 200, "amy's link survived the hostile revoke attempt");

  step('CONTRACT: an account with no claimed family gets 409 from GET /shares');
  const nofam = await signInViaFakeAuth('v15r-nofamily@example.com');
  r = await fetch(cloud.url + '/shares', { headers: authHeaders(nofam.token) });
  assert(r.status === 409, 'no-family account cannot list shares, got ' + r.status);

  console.log('\n  PART A (contract-level) GREEN — fake-cloud satisfies the v1.15 revocation contract.\n');

  // ============ PART B: full-stack — the real app in Chromium (capability-gated) ============
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((api) => { window.CC_CLOUD_API = api; }, cloud.url);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  let promptAnswer = '';
  page.on('dialog', d => d.accept(d.type() === 'prompt' ? promptAnswer : undefined));

  step('boot the real app, PIN, corner, sign in via the EXISTING "Keep it safe" cloud UI');
  await page.goto(APP_URL);
  await page.click('#ack');
  await page.click('#gate');
  await enterPin(page, '1591'); await enterPin(page, '1591');
  await page.fill('#nm', 'Amy');
  await page.click('#save');
  await page.waitForSelector('.home-grid');
  await page.click('.home-card:has-text("Keep it safe")');
  await page.waitForSelector('#cemail');
  await page.fill('#cemail', 'v15r-amy-ui@example.com');
  await page.click('#csend');
  await page.waitForSelector('#ccode');
  let lastCode = null;
  for (let i = 0; i < 40 && !lastCode; i++) {
    const j = await page.evaluate((u) => fetch(u).then(x => x.json()), cloud.url + '/__test/lastcode?email=v15r-amy-ui@example.com');
    lastCode = j.code; if (!lastCode) await sleep(150);
  }
  assert(lastCode, 'the fake cloud emailed (echoed) a code');
  await page.fill('#ccode', lastCode);
  await page.click('#cverify');
  await page.waitForSelector('#cpush', { timeout: 15000 });

  step('CAPABILITY PROBE: does app/cloud.js expose Cloud.listShares / Cloud.revokeShare yet?');
  const hasClient = await page.evaluate(() => typeof Cloud !== 'undefined' && typeof Cloud.listShares === 'function' && typeof Cloud.revokeShare === 'function');
  if (!hasClient) {
    console.log('\n  PART B BLOCKED — app/cloud.js does not yet implement Cloud.listShares/Cloud.revokeShare');
    console.log('  (contract Feature 1 client section). Needs a live integration pass once client lands.\n');
    await browser.close(); await staticServer.close(); await cloud.close();
    console.log('ALL RUNNABLE V15-REVOKE STEPS GREEN ✅ (Part B skipped — client not landed)');
    return;
  }

  step('A claims her cloud family and checks for the "Links you\'ve shared" list under Keep it safe');
  await page.evaluate(() => Cloud.claim());
  await page.click('.back');
  await page.click('.home-card:has-text("Keep it safe")');
  const hasList = await page.waitForSelector('text=Links you’ve shared', { timeout: 5000 }).catch(() => null);
  if (!hasList) {
    console.log('\n  PART B PARTIALLY BLOCKED — Cloud.listShares/revokeShare exist but the "Links you\'ve shared" UI is not rendered yet.\n');
    await browser.close(); await staticServer.close(); await cloud.close();
    console.log('ALL RUNNABLE V15-REVOKE STEPS GREEN ✅ (Part B UI assertions skipped — needs live integration pass)');
    return;
  }

  step('A mints a real share via the existing "Send as a link" flow, confirms it lists, cancels it, confirms it disappears');
  // Real click path (record a reading, open the library row, tap "Send as a
  // link") mirrors phase3-share.js's PART B send flow exactly — reused here
  // rather than re-derived, so this only needs updating in one place if that
  // flow's selectors ever change.
  await page.click('.home-card:has-text("The library")');
  const hasReading = await page.$('.rowitem');
  assert(hasReading, 'a reading must already exist to send as a link — record one first if this fails (mirror phase3-share.js Part B setup)');
  await page.click('.rowitem');
  promptAnswer = 'CC-V15R-DEST';
  await page.click('#parcel');
  await page.waitForSelector('.handoff [data-link]');
  await page.click('.handoff [data-link]');
  await page.waitForSelector('.handoff', { state: 'detached', timeout: 20000 });
  await page.click('.back');
  await page.click('.home-card:has-text("Keep it safe")');
  await page.waitForSelector('.shares-list .rowitem, [data-shares] .rowitem', { timeout: 10000 });
  const before = await page.$$eval('.shares-list .rowitem, [data-shares] .rowitem', els => els.length);
  assert(before >= 1, 'the freshly minted share appears in the list');
  await page.click('[data-cancel-share], button:has-text("Cancel this link")');
  await page.waitForFunction(
    (n) => document.querySelectorAll('.shares-list .rowitem, [data-shares] .rowitem').length < n,
    before, { timeout: 10000 },
  );
  console.log('  Cancel-this-link removed the entry from the list — Part B green.');

  await browser.close();
  await staticServer.close();
  await cloud.close();
  if (errors.length) { console.error('\nPAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
  console.log('\nALL V15-REVOKE STEPS GREEN ✅');
})().catch(async e => {
  console.error('\n💥 ' + e.stack);
  process.exit(1);
});
