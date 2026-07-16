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
  completeness checks, nothing written), a hostile invite payload renders
  inert, a browser without MediaRecorder degrades to import-only, and a
  broken database opens a calm failure screen instead of a blank page
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
