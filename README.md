# Catherine's Corner 📖

The people your child loves, reading their favorite books aloud — kept to listen to for years. This is the deployed alpha: a local-first web app with no build step, no accounts, and no server; everything a family records stays on their device.

## Layout

| Path | What it is |
|------|------------|
| `index.html` | The concept site (what invitees see when they tap "see what it looks like") |
| `app/` | The app itself — plain static files, one module per concern (see below) |
| `e2e/` | Playwright regression suite (`cd e2e && npm install && npm test`) |
| `.github/workflows/` | Deploys the whole repo to GitHub Pages on every push to `main` |

## The app's shape (v1.7)

No bundler — modules are plain scripts wired in `app/index.html`:

- `db.js` — IndexedDB schema v3: **corners** (one shelf per child), readers shared across corners, books/readings/requests corner-scoped, **audio in its own store** so list screens never load blobs, a **metrics** store (usage counts by pain-point area — counts only, never content), in-place migrations from v1/v2.
- `telemetry.js` — **dormant by default.** When the maker sets its `ENDPOINT` (a GoatCounter site, ~3-min signup: create the site, paste `https://<code>.goatcounter.com/count`, bump versions, deploy), every local count also pings the collector — event name only, no identifiers, no cookies. Configuring it automatically adds a plain-language line to the alpha notice and an off switch on the "What gets used" screen. While unconfigured, nothing leaves any device.
- `ui.js` — DOM/format helpers, scrubber, transport bar, and the shared audio-capture panel (record / pause / import, iOS quirks handled) — including **best-effort live word-jotting** via the browser's built-in speech recognition: phrases are stamped with their moment in the recording and never allowed to interfere with the recording itself (any failure silently withdraws the feature).
- `send.js` — everything "far away": request messages, ✉️/💬/⧉ send row, **invite links** (`#invite=` payload, no server), the guest recording page they open, and the **file hand-off sheet** ("packed and ready" → Send/Save buttons). Files are offered in two taps on purpose: `navigator.share()` only works inside a fresh user gesture, and packing eats the original one — every button press is its own gesture, so the share sheet is never refused.
- `app.js` — the shell: state, screen registry + router, player handle, share-target inbox, boot.
- `screens-kid.js` / `screens-adult.js` / `screens-record.js` — the screens; each registers itself with the shell. Includes **read-along words**: a page's text is typed once in pass 2 (it belongs to the Book, like the photo), and the player shows it under the picture, lighting up gently across that page's stretch of the recording — for every voice, and it travels in backups, parcels, and sync.
- `backup.js` — plain-zip backup/restore, format v2 (still restores v1 zips; corners merge by name) — plus **parcels**: one book or told story, voices and pages included, packed by one family and **addressed to another family's Corner ID** (shown under "Keep it safe"). The receiving app inspects the parcel, shows what's inside and who it was addressed to, then tucks it onto the active shelf — readers merge by name, ids are collision-safe, re-accepting is a no-op, and everything arrives marked new for the child. Corner IDs are read generously (lowercase, spaces, missing dashes all canonicalize), the last-used id is remembered, and the zip writer streams original blobs into the archive so packing never doubles a big book in memory. The reader accepts a parcel **however it arrives**: the app writes STORE-only zips, but reads DEFLATE too (via the browser's `DecompressionStream`) and unwraps the folder-plus-junk shape a zip gains when a phone extracts and re-compresses it in transit — CRC-verified either way.
- `whatsnew.js` — the ✨ **what's-new badge** + release-notes carousel. Per-release checklist: add a slide to `RELEASES`, bump versions, deploy — updated devices get the badge automatically; fresh installs never do.
- `sync.js` — **nearby sync**: two of the family's devices on the same WiFi match shelves directly over a LAN-only WebRTC data channel (host candidates, no STUN, no server, no library). The handshake rides in two small hand-carried pairing codes; the payload is a CRC-verified backup **delta**, so merging reuses the restore semantics that have been tested since v1.1.1. Nothing is ever deleted by a sync.
- `export.js` — video export (16:9 for two-page-spread books, 4:3 for single pages).
- `sw.js` — offline app shell + voice-memo share target. Bump its `VERSION` together with `APP_VERSION` in `app.js` on every deploy, and keep its `SHELL` list current. **Updates apply themselves**: the app checks for a new version whenever it comes to the foreground (and hourly), and reloads when the new worker takes over — never during a live recording, an unsaved draft, playback, a sync, or a guest visit (then it applies on next open). IndexedDB is untouched by updates.

## Working on it

Serve statically and open the app:

```
python3 -m http.server 8000
# → http://localhost:8000/app/
```

Before shipping: run the E2E suite (20 steps — full journey, invites, spreads, multi-corner, backup round-trip, v1 migration), and bump `APP_VERSION` + `sw.js` `VERSION` together.

Product spec, build plan, and the append-only project log live in the companion workspace repo (`catherines-corner-app`).
