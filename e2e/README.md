# E2E suite

Drives the real app in headless Chromium with a fake microphone — the whole
owner journey plus the seams that history shows break quietly:

- fresh boot → alpha notice → PIN → corner setup → reader → full record flow
- **spread page format**: pass-2 toggle, wide player stage, portrait rotate
  hint (and its disappearance in landscape), 16:9 video export
- **invite links**: request → `#invite=` link → guest page (explains the app,
  records with no PIN/setup, offers send-back)
- **multi-corner**: second child, scoped libraries, shelf pills
- **backup v2** round-trip onto a wiped device (corners merge by name — no
  twin shelves), **v1 backup import**, and the in-place **v1→v2 IndexedDB
  migration** (audio lifted out of reading rows, corner from `cornerName`)
- told stories, the edit flow, gentle skips, calm end screen
- **hardening cases**: a quota-failed save stays loud and lossless (draft
  kept, no orphan rows), a corrupted backup zip is refused whole (CRC +
  completeness checks, nothing written), a **re-zipped parcel** (extracted
  by a phone in transit, re-compressed with real DEFLATE, wrapped in a
  folder with Mac junk files) still opens and knows whose it is, a hostile
  invite payload renders inert, a browser without MediaRecorder degrades to
  import-only, and a broken database opens a calm failure screen instead of
  a blank page
- **local usage analytics**: pain-point areas counted through the whole
  journey (including failed saves), the "what gets used" screen renders with
  its honesty line and snapshot share, and BOTH live-user migrations are
  seeded and verified (v1 → v3 and v2 → v3, data untouched, playback intact)
- **telemetry**: proven dormant while unconfigured (zero requests across the
  whole suite), delivers events to a fake collector once configured, and the
  family off switch stops sending while local counting continues
- **what's new**: the badge appears only for updated devices, opens the
  walkthrough carousel, and clears once seen
- **nearby sync**: a real two-device WebRTC merge over loopback — pairing by
  hand-carried codes, lossless both-ways merge (counts add up exactly),
  synced audio plays on the receiving side, and a repeat sync carries nothing
- **self-update**: a service-worker-controlled page notices a newly published
  release, reloads itself while idle, and IndexedDB survives untouched;
  auto-update holds back while an unsaved draft exists
- **parcels**: a full two-family exchange — family A packs a book addressed
  to family B's Corner ID (typed sloppily: lowercase, spaces, no dashes — the
  canonical id still lands), the packed-and-ready hand-off sheet offers its
  own Send/Save taps (so the share sheet is never refused for a stale
  gesture), the next parcel remembers the last-used id, B accepts (reader
  merged once, readings marked new, spread playback works), re-accepting adds
  nothing, and a mis-addressed parcel warns plainly before anything is tucked
  in

- **live-promise coverage**: every user-facing claim is exercised — read-along
  words (auto-jotted during pass 1 via a stubbed speech recognizer, dropped
  onto pages with "use the words I read", typed words still ruling, the
  transcript persisted on the reading; lit up in the player, surviving backup
  round-trips),
  ✨ suggested turns, "add a cover photo later", keep-a-copy downloads, serial
  chapters (badge → episode list → next-chapter offer), the quiet multi-voice
  picker, the kid cover studio, and the voice-memo share target (POST → toast
  → arrived card → pass 1 skipped → thank-you loop)

Run it:

```
cd e2e && npm install && npm test
```

No app dependencies change — the suite serves the repo statically and drives
it, the same way a phone would.

## Stage 2 Phase 3 + Phase 4 (share links / invite uploads)

`phase3-share.js` and `phase4-inbox.js` cover the Stage 2 cloud contract
(`snowbear-hq/sprints/2026-07-17/1156/CONTRACT.md`) — Phase 3 share links and
Phase 4 invite-upload/inbox. Each file has two halves:

- **PART A (contract-level, no browser)** drives `lib/fake-cloud.js` — a
  keyless, in-memory fake of the Cloudflare Worker (same pattern as e2e.js's
  own fake telemetry collector) — directly over HTTP. Covers every endpoint
  in the contract table, both isolation invariants (a hostile second family
  can't read/accept another family's inbox), and both calm-refusal invariants
  (garbage/expired share and invite tokens). This half has no dependency on
  the app or worker and runs in under a second.
- **PART B (full-stack, Playwright)** drives the REAL app against the fake
  cloud (`window.CC_CLOUD_API` override) — real sign-in, real recording, the
  real "🔗 Send as a link" / "🔗 record on the shelf" buttons, the real
  `#parcel=`/`#give=` boot-hash handling, the real guest give-page, and the
  real "check for arrivals" → arrived-card → accept flow.

Run them:

```
cd e2e && npm install && npm run test:cloud
```

(or `npm run test:phase3` / `npm run test:phase4` individually). `lib/`
holds the shared harness (`harness.js`) and the fake-cloud server
(`fake-cloud.js`) both specs import — `e2e.js` itself is untouched and keeps
passing with no fake cloud attached, per the offline regression guarantee.

If chromium won't launch on this machine (a cached browser revision
mismatch, not an app problem), set `CC_E2E_CHROMIUM=/path/to/chrome` to point
at any locally cached Chromium binary.

## v1.15 (share revocation / resumable guest upload / co-parent join)

`v15-revoke.js`, `v15-multipart.js`, `v15-coparent.js` cover the v1.15 cloud
contract (`snowbear-hq/sprints/2026-07-17/1406/CONTRACT.md`) — share-link
revocation, resumable multipart guest uploads (>5MB), and owner-approved
co-parent join, plus the cross-cutting **active-only membership invariant**
(a `pending` co-parent must read NOTHING). Same two-part shape as Phase 3/4:

- **PART A (contract-level, no browser)** drives the same extended
  `lib/fake-cloud.js` directly. Fully runnable today — no dependency on
  app/ or cloud/ landing. `v15-coparent.js` Part A is the security-critical
  one: it proves a pending co-parent's access is byte-for-byte identical to
  a total stranger's on every family-scoped route (inbox, backup, shares,
  accept), then proves the SAME pre-existing family inbox item becomes
  visible the moment (and only the moment) the owner approves.
- **PART B (full-stack, Playwright)** is written against the contract's
  client/UI bullets, but **capability-gated**: each file signs in for real,
  then probes whether the relevant `Cloud.*` method exists yet
  (`Cloud.listShares`/`revokeShare`, `Cloud.inboxUploadResumable`,
  `Cloud.createFamilyInvite`/`joinFamily`/`familyRequests`/`approveMember`/
  `declineMember`). As of this write **app/cloud.js does not yet implement
  any of the v1.15 client methods** (client lands separately, in parallel,
  per the contract), so Part B currently prints a `BLOCKED` message and
  exits green rather than hard-failing on a client that was never supposed
  to be there yet. Once the client + screens land, these files start
  exercising the real UI with no edits needed here.

Run them:

```
cd e2e && npm install && npm run test:v15
```

(or `test:v15-revoke` / `test:v15-multipart` / `test:v15-coparent`
individually.) `lib/fake-cloud.js` was extended in place (not forked) to
implement the new endpoints — Phase 3/4 keep passing unmodified against the
same file (verified: `npm run test:cloud` after the v1.15 extension shows no
behavior change to any pre-existing endpoint).
