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

Run it:

```
cd e2e && npm install && npm test
```

No app dependencies change — the suite serves the repo statically and drives
it, the same way a phone would.
