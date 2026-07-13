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

- `db.js` — IndexedDB schema v2: **corners** (one shelf per child), readers shared across corners, books/readings/requests corner-scoped, **audio in its own store** so list screens never load blobs, in-place v1→v2 migration.
- `ui.js` — DOM/format helpers, scrubber, and the shared audio-capture panel (record / pause / import, iOS quirks handled).
- `send.js` — everything "far away": request messages, ✉️/💬/⧉ send row, **invite links** (`#invite=` payload, no server), and the guest recording page they open.
- `app.js` — the shell: state, screen registry + router, player handle, share-target inbox, boot.
- `screens-kid.js` / `screens-adult.js` / `screens-record.js` — the screens; each registers itself with the shell.
- `backup.js` — plain-zip backup/restore, format v2 (still restores v1 zips; corners merge by name).
- `export.js` — video export (16:9 for two-page-spread books, 4:3 for single pages).
- `sw.js` — offline app shell + voice-memo share target. Bump its `VERSION` together with `APP_VERSION` in `app.js` on every deploy, and keep its `SHELL` list current.

## Working on it

Serve statically and open the app:

```
python3 -m http.server 8000
# → http://localhost:8000/app/
```

Before shipping: run the E2E suite (20 steps — full journey, invites, spreads, multi-corner, backup round-trip, v1 migration), and bump `APP_VERSION` + `sw.js` `VERSION` together.

Product spec, build plan, and the append-only project log live in the companion workspace repo (`catherines-corner-app`).
