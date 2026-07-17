/* Catherine's Corner E2E — v1.15 Feature 2 (resumable multipart guest upload).
   Locked contract: snowbear-hq/sprints/2026-07-17/1406/CONTRACT.md

   PART A — CONTRACT-LEVEL (pure HTTP, no browser): drives e2e/lib/fake-cloud.js
   directly. Runnable TODAY. Covers:
   - the existing single-PUT small-blob path keeps working unmodified
     (regression guard — multipart is additive, per invariant #4 in the
     contract's closing checklist)
   - a >5MB blob: init -> per-part presigned PUTs -> complete, with the
     assembled object verified BYTE-IDENTICAL to the original (not just
     "some bytes landed")
   - the actual point of "resumable": one part fails on its first PUT
     attempt (via the fail-part-once test hook) and succeeds on retry — the
     complete call still succeeds and the assembled bytes are still exact,
     proving a dropped part doesn't corrupt or require restarting the whole
     upload
   - complete refuses if a part's ETag doesn't match what was actually
     stored (409) and if the part count is short (400) — a client can't
     silently under-report parts
   - abort actually frees the upload (a completed-with-old-uploadId call
     404s afterward)
   - the finished object flows into the existing /inbox/{token}/commit +
     parent GET /inbox path unchanged, so a multipart-uploaded recording
     shows up as a normal inbox_item with a working blobUrl

   PART B — FULL-STACK (Playwright): would drive Cloud.inboxUploadResumable
   directly in the guest's page context (constructing an in-browser Blob
   >5MB rather than trying to fake a 5-minute microphone recording — the
   client function is the unit under test here, not the recorder UI, which
   the contract doesn't change). As of this write app/cloud.js does NOT
   expose inboxUploadResumable yet (client hasn't landed). This half probes
   for it and skips with a clear BLOCKED message otherwise. Written against
   the contract, dry-checked (`node --check`) only — not runtime-verified on
   this box (no local Chromium). */
'use strict';
const { chromium } = require('playwright');
const crypto = require('crypto');
const {
  CHROMIUM, startStaticServer, makeStepper, assert, sha256Hex, enterPin, sleep,
} = require('./lib/harness');
const { createFakeCloud } = require('./lib/fake-cloud');

const APP_PORT = 8911;
const CLOUD_PORT = 8921;
const { step } = makeStepper();
const APP_URL = `http://localhost:${APP_PORT}/app/`;

function authHeaders(token) { return { 'content-type': 'application/json', authorization: 'Bearer ' + token }; }
async function signInViaFakeAuth(email) {
  let r = await fetch(`http://localhost:${CLOUD_PORT}/auth/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  const code = (await r.json()).code;
  r = await fetch(`http://localhost:${CLOUD_PORT}/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code }) });
  return r.json();
}
const PART_SIZE = 5 * 1024 * 1024; // S3/R2's real minimum part size (except the last part)

(async () => {
  const staticServer = startStaticServer(APP_PORT);
  const cloud = createFakeCloud({ port: CLOUD_PORT, appOrigin: APP_URL });
  await staticServer.listen();
  await cloud.listen();

  // ============ PART A: contract-level — fake-cloud alone, no browser ============
  step('CONTRACT: parent signs in, claims a family, mints an invite');
  const parent = await signInViaFakeAuth('v15m-parent@example.com');
  let r = await fetch(cloud.url + '/family/claim', { method: 'POST', headers: authHeaders(parent.token), body: JSON.stringify({ familyId: 'CC-V15M-PRNT' }) });
  assert((await r.json()).claimed === 'CC-V15M-PRNT', 'parent claims her family');
  r = await fetch(cloud.url + '/invite', { method: 'POST', headers: authHeaders(parent.token), body: JSON.stringify({ kidName: 'Pip', expiresDays: 30 }) });
  const invite = await r.json();
  assert(invite.inviteToken, 'invite minted');

  step('CONTRACT (regression): the existing single-PUT small-blob path still works, untouched by multipart');
  const small = Buffer.from('a short bedtime memo, well under 5MB');
  const smallSha = sha256Hex(small);
  r = await fetch(cloud.url + `/inbox/${invite.inviteToken}/upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blobs: [{ sha256: smallSha, bytes: small.length, mime: 'audio/webm' }] }) });
  const smallUp = await r.json();
  r = await fetch(smallUp.uploads[0].url, { method: 'PUT', body: small });
  assert(r.ok, 'small single-PUT upload still lands');
  r = await fetch(cloud.url + `/inbox/${invite.inviteToken}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blobSha256: [smallSha], mime: 'audio/webm', fromName: 'Grandpa', note: 'a quick one' }) });
  assert((await r.json()).ok, 'small-blob commit still works (single-PUT path is additive, not replaced)');

  step('CONTRACT: >5MB guest upload — init returns one presigned PUT url per part');
  const big = crypto.randomBytes(PART_SIZE + 1200000); // ~6.14MB: one full 5MB part + one ~1.14MB tail part
  const bigSha = sha256Hex(big);
  const part1 = big.subarray(0, PART_SIZE);
  const part2 = big.subarray(PART_SIZE);
  r = await fetch(cloud.url + `/inbox/${invite.inviteToken}/upload/init`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha256: bigSha, mime: 'audio/webm', parts: 2 }) });
  assert(r.ok, 'init succeeds, got ' + r.status);
  const init = await r.json();
  assert(init.uploadId && init.key && Array.isArray(init.parts) && init.parts.length === 2, 'init returns an uploadId, key, and 2 part urls');
  assert(init.parts[0].partNumber === 1 && init.parts[1].partNumber === 2, 'parts are numbered 1 and 2 in order');

  step('CONTRACT: part 2 drops on the first attempt (simulated) — retry succeeds, capturing an ETag both times');
  await fetch(cloud.url + '/__test/fail-part-once', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: init.uploadId, partNumber: 2 }) });
  r = await fetch(init.parts[0].url, { method: 'PUT', body: part1 });
  assert(r.ok, 'part 1 PUT succeeds first try, got ' + r.status);
  const etag1 = r.headers.get('etag');
  assert(etag1, 'part 1 PUT returns an ETag header the client is meant to capture');
  r = await fetch(init.parts[1].url, { method: 'PUT', body: part2 });
  assert(r.status === 500, 'part 2 first attempt is a SIMULATED drop (500), proving the failure hook actually bites, got ' + r.status);
  r = await fetch(init.parts[1].url, { method: 'PUT', body: part2 }); // the client's retry — same URL, same bytes
  assert(r.ok, 'part 2 RETRY succeeds (re-PUTing the same part number is exactly how a resumable client recovers a dropped part), got ' + r.status);
  const etag2 = r.headers.get('etag');
  assert(etag2, 'the retried part also returns an ETag');

  step('CONTRACT: complete assembles the parts into a BYTE-IDENTICAL object');
  r = await fetch(cloud.url + `/inbox/${invite.inviteToken}/upload/complete`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sha256: bigSha, uploadId: init.uploadId, parts: [{ partNumber: 1, etag: etag1 }, { partNumber: 2, etag: etag2 }] }),
  });
  assert(r.ok, 'complete succeeds, got ' + r.status);
  assert((await r.json()).ok === true, 'complete responds {ok:true}');
  r = await fetch(cloud.url + '/__blob/' + init.key);
  assert(r.ok, 'the assembled object is fetchable, got ' + r.status);
  const assembled = Buffer.from(await r.arrayBuffer());
  assert(assembled.length === big.length, `assembled object is byte-COMPLETE: expected ${big.length} bytes, got ${assembled.length}`);
  assert(Buffer.compare(assembled, big) === 0, 'assembled object is byte-IDENTICAL to the original (part order + boundaries are exactly right, not just right length)');

  step('CONTRACT: the multipart-uploaded blob commits into a normal inbox_item, visible to the parent with a working blobUrl');
  r = await fetch(cloud.url + `/inbox/${invite.inviteToken}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blobSha256: [bigSha], mime: 'audio/webm', fromName: 'Uncle Theo', note: 'the whole book, one take' }) });
  const commit = await r.json();
  assert(commit.ok && commit.id, 'the inbox_item commits (multipart is invisible past this point — same commit contract as single-PUT)');
  r = await fetch(cloud.url + '/inbox', { headers: authHeaders(parent.token) });
  const inbox = await r.json();
  const arrived = inbox.items.find(it => it.id === commit.id);
  assert(arrived && arrived.fromName === 'Uncle Theo', 'the item is in the parent\'s open inbox');
  r = await fetch(arrived.blobUrl);
  const fromInbox = Buffer.from(await r.arrayBuffer());
  assert(Buffer.compare(fromInbox, big) === 0, 'the inbox blobUrl serves the exact multipart-assembled bytes, not a truncated/corrupt copy');

  step('CONTRACT: complete rejects a wrong ETag (409) and a short part list (400) — a client cannot under-report or fake parts');
  r = await fetch(cloud.url + `/inbox/${invite.inviteToken}/upload/init`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha256: 'deadbeef'.repeat(8), mime: 'audio/webm', parts: 2 }) });
  const init2 = await r.json();
  await fetch(init2.parts[0].url, { method: 'PUT', body: crypto.randomBytes(PART_SIZE) });
  await fetch(init2.parts[1].url, { method: 'PUT', body: crypto.randomBytes(1000) });
  r = await fetch(cloud.url + `/inbox/${invite.inviteToken}/upload/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha256: 'deadbeef'.repeat(8), uploadId: init2.uploadId, parts: [{ partNumber: 1, etag: '"wrong-etag"' }] }) });
  assert(r.status === 400, 'a short parts list (missing part 2) 400s, got ' + r.status);
  r = await fetch(cloud.url + `/inbox/${invite.inviteToken}/upload/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha256: 'deadbeef'.repeat(8), uploadId: init2.uploadId, parts: [{ partNumber: 1, etag: '"wrong-etag"' }, { partNumber: 2, etag: '"also-wrong"' }] }) });
  assert(r.status === 409, 'a mismatched ETag is refused rather than silently trusted, got ' + r.status);

  step('CONTRACT: abort actually frees the upload — completing an aborted uploadId 404s afterward');
  r = await fetch(cloud.url + `/inbox/${invite.inviteToken}/upload/init`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha256: 'abababab'.repeat(8), mime: 'audio/webm', parts: 1 }) });
  const init3 = await r.json();
  await fetch(init3.parts[0].url, { method: 'PUT', body: crypto.randomBytes(1000) });
  r = await fetch(cloud.url + `/inbox/${invite.inviteToken}/upload/abort`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha256: 'abababab'.repeat(8), uploadId: init3.uploadId }) });
  assert(r.ok, 'abort succeeds, got ' + r.status);
  r = await fetch(cloud.url + `/inbox/${invite.inviteToken}/upload/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha256: 'abababab'.repeat(8), uploadId: init3.uploadId, parts: [{ partNumber: 1, etag: 'x' }] }) });
  assert(r.status === 404, 'completing an aborted upload 404s (the uploadId is genuinely gone), got ' + r.status);
  r = await fetch(cloud.url + '/__blob/' + blobKeyFor(invite, 'abababab'.repeat(8)));
  assert(r.status === 404, 'nothing was ever assembled at that key for the aborted upload, got ' + r.status);

  step('CONTRACT (invariant #4): multipart routes are invite-token-gated the same as single-PUT — garbage/expired invite refuses init');
  r = await fetch(cloud.url + `/inbox/garbage-invite-xyz/upload/init`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha256: 'x', mime: 'audio/webm', parts: 1 }) });
  assert(!r.ok, 'garbage invite token refuses init, got ' + r.status);
  r = await fetch(cloud.url + '/invite', { method: 'POST', headers: authHeaders(parent.token), body: JSON.stringify({ kidName: 'Pip', expiresDays: 1 }) });
  const stale = await r.json();
  await fetch(cloud.url + '/__test/expire-invite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken: stale.inviteToken }) });
  r = await fetch(cloud.url + `/inbox/${stale.inviteToken}/upload/init`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha256: 'x', mime: 'audio/webm', parts: 1 }) });
  assert(!r.ok, 'expired invite token refuses init, got ' + r.status);

  console.log('\n  PART A (contract-level) GREEN — fake-cloud satisfies the v1.15 resumable-multipart contract, including a real dropped-part-then-retry.\n');

  // helper used only by the abort assertion above (needs the family id, which
  // lives on the invite — resolved via the fake server's exposed _state so this
  // spec doesn't have to duplicate the worker's blobKey() convention by hand)
  function blobKeyFor(inv, sha) {
    const invRow = cloud._state.invites.get(inv.inviteToken);
    return `corners/${invRow.familyId}/${sha}`;
  }

  // ============ PART B: full-stack — the real app in Chromium (capability-gated) ============
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((api) => { window.CC_CLOUD_API = api; }, cloud.url);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept(''));

  step('boot the real app as the guest, land on the invite give-page (real UI, already landed in Phase 4)');
  await page.goto(APP_URL);
  await page.click('#ack');
  await page.click('#gate');
  await enterPin(page, '7284'); await enterPin(page, '7284');
  await page.fill('#nm', 'Probe');
  await page.click('#save');
  await page.waitForSelector('.home-grid');

  step('CAPABILITY PROBE: does app/cloud.js expose Cloud.inboxUploadResumable yet?');
  const hasClient = await page.evaluate(() => typeof Cloud !== 'undefined' && typeof Cloud.inboxUploadResumable === 'function');
  if (!hasClient) {
    console.log('\n  PART B BLOCKED — app/cloud.js does not yet implement Cloud.inboxUploadResumable');
    console.log('  (contract Feature 2 client section: >5MB -> multipart, <=5MB -> existing inboxUpload).');
    console.log('  Needs a live integration pass once client lands.\n');
    await browser.close(); await staticServer.close(); await cloud.close();
    console.log('ALL RUNNABLE V15-MULTIPART STEPS GREEN ✅ (Part B skipped — client not landed)');
    return;
  }

  step('drive Cloud.inboxUploadResumable directly with an in-browser >5MB Blob (the client function is the unit under test, not the recorder)');
  const result = await page.evaluate(async ({ token, size }) => {
    const bytes = new Uint8Array(size);
    crypto.getRandomValues(bytes.subarray(0, 65536)); // a real random prefix is enough to prove it's not all-zero fallback content
    const blob = new Blob([bytes], { type: 'audio/webm' });
    const progress = [];
    const r = await Cloud.inboxUploadResumable(token, blob, await Cloud.sha256Hex(blob), 'audio/webm', (p) => progress.push(p));
    return { sha256: r.sha256, mime: r.mime, progressCalls: progress.length, lastProgress: progress[progress.length - 1] };
  }, { token: invite.inviteToken, size: PART_SIZE + 1200000 }).catch(e => ({ error: e.message }));
  assert(!result.error, 'Cloud.inboxUploadResumable ran without throwing: ' + (result.error || ''));
  assert(result.sha256, 'resumable upload returns a sha256, same shape as the existing inboxUpload');
  assert(result.progressCalls > 0, 'progress callback fired at least once across the multi-part upload');

  step('commit + parent-side visibility, same as the contract-level check above but through the real client');
  await page.evaluate(({ token, meta }) => Cloud.inboxCommit(token, meta), { token: invite.inviteToken, meta: { blobSha256: result.sha256, mime: result.mime, fromName: 'Real Client Probe', note: 'via Cloud.inboxUploadResumable' } });
  r = await fetch(cloud.url + '/inbox', { headers: authHeaders(parent.token) });
  const inboxAfter = await r.json();
  assert(inboxAfter.items.some(it => it.fromName === 'Real Client Probe'), 'the real client\'s resumable upload landed a real inbox_item');

  await browser.close();
  await staticServer.close();
  await cloud.close();
  if (errors.length) { console.error('\nPAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
  console.log('\nALL V15-MULTIPART STEPS GREEN ✅');
})().catch(async e => {
  console.error('\n💥 ' + e.stack);
  process.exit(1);
});
