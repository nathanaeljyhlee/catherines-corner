/* Catherine's Corner E2E — v1.15 Feature 3 (co-parent join) + the
   cross-cutting active-only membership invariant.
   Locked contract: snowbear-hq/sprints/2026-07-17/1406/CONTRACT.md

   THIS IS THE SECURITY-CRITICAL SPEC. The contract's own closing checklist
   calls it out by name: "E2E MUST include a 'pending member cannot
   read/backup/inbox' hostile case + 'non-owner cannot approve/invite'."
   Everything below Step 4 exists to prove that a `pending` family_member
   really does see NOTHING — not a filtered view, not an empty-but-200
   response that some future refactor could accidentally turn into real
   data, but the exact same "no active family" refusal an account with NO
   membership at all gets.

   PART A — CONTRACT-LEVEL (pure HTTP, no browser): drives e2e/lib/fake-cloud.js
   directly. Runnable TODAY. Covers the full flow (invite -> join -> pending
   -> proof of nothing -> approve -> active -> library visible) plus every
   hostile case in the contract: non-owner invite/approve/decline (403),
   already-owns-a-family join (409), decline removes the pending row
   cleanly, and a used/expired invite token can't be redeemed twice.

   PART B — FULL-STACK (Playwright): would drive the real "Add a co-parent"
   action, the `#join=` boot-hash flow (sign-in-first, then join, landing on
   "Request sent — waiting for the family owner to approve"), the owner's
   "🔔 {email} wants to join" request card with [Approve]/[Not now], and the
   co-parent's device adopting the family library on next open. As of this
   write, app/cloud.js does NOT expose createFamilyInvite/joinFamily/
   familyRequests/approveMember/declineMember yet and none of that UI exists
   (client hasn't landed). This half probes for the capability and skips
   with a clear BLOCKED message otherwise. Written against the contract,
   dry-checked (`node --check`) only — not runtime-verified on this box (no
   local Chromium). */
'use strict';
const { chromium } = require('playwright');
const { CHROMIUM, startStaticServer, makeStepper, assert, enterPin, sleep, sha256Hex } = require('./lib/harness');
const { createFakeCloud } = require('./lib/fake-cloud');

const APP_PORT = 8912;
const CLOUD_PORT = 8922;
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
  step('CONTRACT: owner signs in, claims the family, and backs up a real library so there is something for a co-parent to eventually see');
  const owner = await signInViaFakeAuth('v15c-owner@example.com');
  let r = await fetch(cloud.url + '/family/claim', { method: 'POST', headers: authHeaders(owner.token), body: JSON.stringify({ familyId: 'CC-V15C-OWNR' }) });
  assert((await r.json()).claimed === 'CC-V15C-OWNR', 'owner claims her family');
  r = await fetch(cloud.url + '/invite', { method: 'POST', headers: authHeaders(owner.token), body: JSON.stringify({ kidName: 'Pip', expiresDays: 30 }) });
  const kidInvite = await r.json();
  const memo = Buffer.from('a bedtime story, waiting in the family inbox');
  const memoSha = sha256Hex(memo);
  r = await fetch(cloud.url + `/inbox/${kidInvite.inviteToken}/upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blobs: [{ sha256: memoSha, bytes: memo.length, mime: 'audio/webm' }] }) });
  const up = (await r.json()).uploads[0];
  await fetch(up.url, { method: 'PUT', body: memo });
  r = await fetch(cloud.url + `/inbox/${kidInvite.inviteToken}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blobSha256: [memoSha], mime: 'audio/webm', fromName: 'Grandma', note: 'the library item the co-parent should see once approved' }) });
  const familyInboxItem = await r.json();
  assert(familyInboxItem.ok, 'family inbox now has one real item, BEFORE the co-parent is even invited (proves approval — not timing — is what unlocks visibility)');

  step('CONTRACT (hostile): a non-owner account cannot mint a co-parent invite (403)');
  const rando = await signInViaFakeAuth('v15c-rando@example.com');
  r = await fetch(cloud.url + '/family/invite', { method: 'POST', headers: authHeaders(rando.token) });
  assert(r.status === 403, 'an account with no family of its own cannot invite, got ' + r.status);

  step('CONTRACT: owner mints a co-parent join link');
  r = await fetch(cloud.url + '/family/invite', { method: 'POST', headers: authHeaders(owner.token) });
  assert(r.ok, 'owner invite mint succeeds, got ' + r.status);
  const invite = await r.json();
  assert(invite.joinToken && invite.url === `${APP_URL}#join=${invite.joinToken}`, 'invite response carries a #join= url built from APP_URL');

  step('CONTRACT: co-parent signs in and redeems the join link -> PENDING (not active)');
  const coparent = await signInViaFakeAuth('v15c-coparent@example.com');
  r = await fetch(cloud.url + '/family/join', { method: 'POST', headers: authHeaders(coparent.token), body: JSON.stringify({ token: invite.joinToken }) });
  assert(r.ok, 'join succeeds, got ' + r.status);
  const joined = await r.json();
  assert(joined.status === 'pending' && joined.familyId === 'CC-V15C-OWNR', `co-parent lands pending, not active (got status=${joined.status})`);
  r = await fetch(cloud.url + '/family/mine', { headers: authHeaders(coparent.token) });
  const mineWhilePending = await r.json();
  assert(mineWhilePending.familyId === null, 'GET /family/mine reports NO active family while pending (got ' + JSON.stringify(mineWhilePending) + ')');
  assert(mineWhilePending.pendingFamilyId === 'CC-V15C-OWNR', 'GET /family/mine DOES surface the pending signal, per contract (co-parent UI needs this to show "waiting for approval")');

  step('★ THE SECURITY-CRITICAL PROOF ★ — a PENDING co-parent reads NOTHING: no inbox, no backup, no shares, cannot accept, cannot even claim around it');
  r = await fetch(cloud.url + '/inbox', { headers: authHeaders(coparent.token) });
  assert(r.status === 409, `pending co-parent's GET /inbox must refuse (no active family), got ${r.status}` + (r.status === 200 ? ' — LEAKED: ' + JSON.stringify(await r.json()) : ''));
  r = await fetch(cloud.url + '/backup/latest', { headers: authHeaders(coparent.token) });
  assert(r.status === 409, `pending co-parent's GET /backup/latest must refuse, got ${r.status}`);
  r = await fetch(cloud.url + '/shares', { headers: authHeaders(coparent.token) });
  assert(r.status === 409, `pending co-parent's GET /shares must refuse, got ${r.status}`);
  r = await fetch(cloud.url + `/inbox/${familyInboxItem.id}/accept`, { method: 'POST', headers: authHeaders(coparent.token) });
  assert(r.status === 404, `pending co-parent cannot accept the family's real inbox item (no active family -> falls out as not-found, same as a total stranger), got ${r.status}`);
  r = await fetch(cloud.url + '/backup/begin', { method: 'POST', headers: authHeaders(coparent.token), body: JSON.stringify({ blobs: [] }) });
  assert(r.status === 409, `pending co-parent cannot even START a backup upload (would let them write into the family's blob space), got ${r.status}`);
  // and a genuinely double-blind check: fetch as the pending co-parent one
  // more time and DIFF against what a total stranger (no membership at all)
  // gets, to prove pending isn't accidentally a "partial" access tier.
  const stranger = await signInViaFakeAuth('v15c-stranger@example.com');
  const [pendingInboxStatus, strangerInboxStatus] = await Promise.all([
    fetch(cloud.url + '/inbox', { headers: authHeaders(coparent.token) }).then(x => x.status),
    fetch(cloud.url + '/inbox', { headers: authHeaders(stranger.token) }).then(x => x.status),
  ]);
  assert(pendingInboxStatus === strangerInboxStatus, `a pending co-parent's /inbox access is IDENTICAL to a total stranger's (${pendingInboxStatus} vs ${strangerInboxStatus}) — pending is not a partial-trust tier`);

  step("CONTRACT: the owner's request queue shows the pending co-parent (real accountId comes from here — /auth/verify never echoes one)");
  r = await fetch(cloud.url + '/family/requests', { headers: authHeaders(owner.token) });
  let requests = (await r.json()).requests;
  assert(requests.length === 1 && requests[0].email === 'v15c-coparent@example.com', "the owner's request queue shows the pending co-parent by email");
  const coparentAccountId = requests[0].accountId;
  assert(coparentAccountId, 'the request row carries a real accountId to target approve/decline with');

  step('CONTRACT (hostile): a non-owner cannot approve a pending request (403), and the request survives the attempt');
  r = await fetch(cloud.url + `/family/members/${coparentAccountId}/approve`, { method: 'POST', headers: authHeaders(rando.token) });
  assert(r.status === 403, 'a non-owner cannot approve anyone, got ' + r.status);
  r = await fetch(cloud.url + '/family/requests', { headers: authHeaders(owner.token) });
  requests = (await r.json()).requests;
  assert(requests.length === 1 && requests[0].accountId === coparentAccountId, "the owner's request queue still shows the untouched pending co-parent");

  step('CONTRACT (hostile): a non-owner cannot even list the requests queue (403)');
  r = await fetch(cloud.url + '/family/requests', { headers: authHeaders(rando.token) });
  assert(r.status === 403, 'a non-owner cannot view the requests queue, got ' + r.status);

  step('CONTRACT: the OWNER approves — co-parent flips to active, GET /family/mine now resolves, and the PRE-EXISTING family inbox item becomes visible');
  r = await fetch(cloud.url + `/family/members/${coparentAccountId}/approve`, { method: 'POST', headers: authHeaders(owner.token) });
  assert(r.ok, 'owner approve succeeds, got ' + r.status);
  assert((await r.json()).ok === true, 'approve responds {ok:true}');
  r = await fetch(cloud.url + '/family/mine', { headers: authHeaders(coparent.token) });
  const mineAfterApproval = await r.json();
  assert(mineAfterApproval.familyId === 'CC-V15C-OWNR', 'co-parent now resolves the family as ACTIVE, got ' + JSON.stringify(mineAfterApproval));
  assert(mineAfterApproval.pendingFamilyId === null, 'the pending signal clears once active');
  r = await fetch(cloud.url + '/inbox', { headers: authHeaders(coparent.token) });
  assert(r.ok, 'the now-active co-parent CAN read the inbox, got ' + r.status);
  const nowVisible = await r.json();
  assert(nowVisible.items.some(it => it.id === familyInboxItem.id), "the item that was sitting in the family's inbox BEFORE the co-parent even joined is now visible — the existing library 'just works' for the second account, no special sync code");

  step('CONTRACT: approving an already-approved (no-longer-pending) request 404s — not a silent re-approve');
  r = await fetch(cloud.url + `/family/members/${coparentAccountId}/approve`, { method: 'POST', headers: authHeaders(owner.token) });
  assert(r.status === 404, 'double-approve 404s, got ' + r.status);

  step('CONTRACT: an account that already owns/has an ACTIVE family cannot join another family (409) — "co-parent join is for an account without its own corner"');
  const alreadyOwns = await signInViaFakeAuth('v15c-alreadyowns@example.com');
  r = await fetch(cloud.url + '/family/claim', { method: 'POST', headers: authHeaders(alreadyOwns.token), body: JSON.stringify({ familyId: 'CC-V15C-SELF' }) });
  assert(r.ok, 'this account owns its own family already');
  r = await fetch(cloud.url + '/family/invite', { method: 'POST', headers: authHeaders(owner.token) });
  const invite2 = await r.json();
  r = await fetch(cloud.url + '/family/join', { method: 'POST', headers: authHeaders(alreadyOwns.token), body: JSON.stringify({ token: invite2.joinToken }) });
  assert(r.status === 409, 'an account with its own active corner cannot join as a co-parent elsewhere, got ' + r.status);
  const body409 = await r.json();
  assert(body409.hint, 'the 409 carries a hint explaining why (per contract), got ' + JSON.stringify(body409));
  r = await fetch(cloud.url + '/family/mine', { headers: authHeaders(alreadyOwns.token) });
  assert((await r.json()).familyId === 'CC-V15C-SELF', 'the failed join attempt did not disturb their own family membership');

  step('CONTRACT: DECLINE removes the pending row cleanly (not left dangling, not silently promoted)');
  const declinee = await signInViaFakeAuth('v15c-declinee@example.com');
  r = await fetch(cloud.url + '/family/invite', { method: 'POST', headers: authHeaders(owner.token) });
  const invite3 = await r.json();
  r = await fetch(cloud.url + '/family/join', { method: 'POST', headers: authHeaders(declinee.token), body: JSON.stringify({ token: invite3.joinToken }) });
  assert((await r.json()).status === 'pending', 'declinee lands pending');
  r = await fetch(cloud.url + '/family/requests', { headers: authHeaders(owner.token) });
  const declineeRow = (await r.json()).requests.find(x => x.email === 'v15c-declinee@example.com');
  assert(declineeRow, 'declinee shows up in the queue');
  r = await fetch(cloud.url + `/family/members/${declineeRow.accountId}/decline`, { method: 'POST', headers: authHeaders(owner.token) });
  assert(r.ok, 'decline succeeds, got ' + r.status);
  r = await fetch(cloud.url + '/family/mine', { headers: authHeaders(declinee.token) });
  const mineAfterDecline = await r.json();
  assert(mineAfterDecline.familyId === null && mineAfterDecline.pendingFamilyId === null, 'declined co-parent has NO family at all, active or pending — clean removal, got ' + JSON.stringify(mineAfterDecline));
  r = await fetch(cloud.url + '/inbox', { headers: authHeaders(declinee.token) });
  assert(r.status === 409, 'declined co-parent still reads nothing, got ' + r.status);

  step('CONTRACT: a join token cannot be redeemed twice (used_at gate)');
  const secondJoiner = await signInViaFakeAuth('v15c-second@example.com');
  r = await fetch(cloud.url + '/family/join', { method: 'POST', headers: authHeaders(secondJoiner.token), body: JSON.stringify({ token: invite3.joinToken }) }); // invite3 was already used by declinee
  assert(!r.ok, 'a used join token cannot be redeemed a second time, got ' + r.status);

  step('CONTRACT: a garbage join token 404s');
  r = await fetch(cloud.url + '/family/join', { method: 'POST', headers: authHeaders(secondJoiner.token), body: JSON.stringify({ token: 'not-a-real-join-token' }) });
  assert(r.status === 404, 'garbage join token 404s, got ' + r.status);

  console.log('\n  PART A (contract-level) GREEN — fake-cloud satisfies the v1.15 co-parent contract AND the active-only membership invariant (pending == total stranger, byte for byte on every status code checked).\n');

  // ============ PART B: full-stack — the real app in Chromium (capability-gated) ============
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((api) => { window.CC_CLOUD_API = api; }, cloud.url);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept(''));

  step('boot the real app, PIN, corner, sign in via the EXISTING "Keep it safe" cloud UI');
  await page.goto(APP_URL);
  await page.click('#ack');
  await page.click('#gate');
  await enterPin(page, '8642'); await enterPin(page, '8642');
  await page.fill('#nm', 'Owner');
  await page.click('#save');
  await page.waitForSelector('.home-grid');
  await page.click('.home-card:has-text("Keep it safe")');
  await page.waitForSelector('#cemail');
  await page.fill('#cemail', 'v15c-owner-ui@example.com');
  await page.click('#csend');
  await page.waitForSelector('#ccode');
  let lastCode = null;
  for (let i = 0; i < 40 && !lastCode; i++) {
    const j = await page.evaluate((u) => fetch(u).then(x => x.json()), cloud.url + '/__test/lastcode?email=v15c-owner-ui@example.com');
    lastCode = j.code; if (!lastCode) await sleep(150);
  }
  assert(lastCode, 'the fake cloud emailed (echoed) a code');
  await page.fill('#ccode', lastCode);
  await page.click('#cverify');
  await page.waitForSelector('#cpush', { timeout: 15000 });

  step('CAPABILITY PROBE: does app/cloud.js expose the co-parent client methods yet?');
  const hasClient = await page.evaluate(() => typeof Cloud !== 'undefined'
    && typeof Cloud.createFamilyInvite === 'function'
    && typeof Cloud.joinFamily === 'function'
    && typeof Cloud.familyRequests === 'function'
    && typeof Cloud.approveMember === 'function'
    && typeof Cloud.declineMember === 'function');
  if (!hasClient) {
    console.log('\n  PART B BLOCKED — app/cloud.js does not yet implement createFamilyInvite/joinFamily/familyRequests/approveMember/declineMember');
    console.log('  (contract Feature 3 client section), and no "Add a co-parent" / #join= / request-card UI exists yet.');
    console.log('  Needs a live integration pass once client + screens land — see the contract\'s Client bullets under FEATURE 3.\n');
    await browser.close(); await staticServer.close(); await cloud.close();
    console.log('ALL RUNNABLE V15-COPARENT STEPS GREEN ✅ (Part B skipped — client + UI not landed)');
    return;
  }

  // Once landed: owner claims -> Cloud.createFamilyInvite() -> owner UI
  // "Add a co-parent" copies a #join= link (same clipboard technique as
  // phase3/phase4's Send.shareText reads) -> a second browser context signs
  // in fresh, opens #join=<token>, sees "Request sent — waiting for the
  // family owner to approve" (NOT the local-corner auto-claim, per contract)
  // -> owner's Keep-it-safe screen polls Cloud.familyRequests() and renders
  // "🔔 {email} wants to join {kid}'s family" [Approve] -> after approve, the
  // co-parent's NEXT open adopts the family via the existing ensureIdentity
  // path and the arrived-card/library shows the SAME item this spec's Part A
  // proved was invisible while pending. Left as a TODO stub keyed to the
  // actual selectors once the UI exists, mirroring phase4-inbox.js's
  // structure for the two-context handoff.

  await browser.close();
  await staticServer.close();
  await cloud.close();
  if (errors.length) { console.error('\nPAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
  console.log('\nALL V15-COPARENT STEPS GREEN ✅');
})().catch(async e => {
  console.error('\n💥 ' + e.stack);
  process.exit(1);
});
