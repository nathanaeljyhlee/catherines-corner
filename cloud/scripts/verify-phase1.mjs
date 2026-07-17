// Phase 1 backend verify: drives the REAL app/cloud.js (loaded into Node with
// mocked DB/Backup + a TEST_MODE token) end-to-end against the running worker.
//   claim -> push (uploads all) -> push again (dedup, 0 new) -> pull (restore
//   round-trip, bytes match) -> hostile family cannot read another's backup.
// Env: BASE_URL, JWT_SECRET (the TEST_MODE HS256 key from .dev.vars).
import { SignJWT } from 'jose'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const enc = new TextEncoder()
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787'
const SECRET = process.env.JWT_SECRET
if (!SECRET) { console.error('no JWT_SECRET'); process.exit(1) }

let pass = 0, fail = 0
const check = (ok, label, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ }
const mintFam = (fam) => new SignJWT({ fam }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('10m').sign(enc.encode(SECRET))

// --- inject browser-ish globals + mocks, then load the real cloud.js ---
globalThis.CC_CLOUD_API = BASE
let CURRENT_TOKEN = null
globalThis.CloudAuth = { token: () => CURRENT_TOKEN }
let FAMILY_ID = 'CC-AAAA-0001'
globalThis.DB = { familyId: async () => FAMILY_ID, settings: { set: async () => {} } }

// deterministic synthetic corner: two audio blobs (fixed bytes => stable sha)
const audio1 = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'audio/mp4' })
const audio2 = new Blob([new Uint8Array([9, 8, 7, 6, 5, 4])], { type: 'audio/mp4' })
const FIXED_MANIFEST = {
  format: 'catherines-corner-backup', formatVersion: 2, exportedAt: '2026-07-16T00:00:00.000Z', cornerName: 'Test',
  corners: [{ id: 'c1', name: 'Test', createdAt: 1 }], readers: [{ id: 'rd1', name: 'Dad' }],
  books: [], requests: [],
  readings: [{ id: 'r1', cornerId: 'c1', readerId: 'rd1', audio: { file: 'audio/r1.m4a', mime: 'audio/mp4' } },
             { id: 'r2', cornerId: 'c1', readerId: 'rd1', audio: { file: 'audio/r2.m4a', mime: 'audio/mp4' } }],
}
let restored = null
globalThis.Backup = {
  packAll: async () => ({
    manifest: JSON.parse(JSON.stringify(FIXED_MANIFEST)),
    files: [{ name: 'audio/r1.m4a', blob: audio1 }, { name: 'audio/r2.m4a', blob: audio2 }],
  }),
  importBackup: async (m, map) => { restored = { m, map }; return { readings: (m.readings || []).length } },
}

const __dir = dirname(fileURLToPath(import.meta.url))
eval(readFileSync(join(__dir, '..', '..', 'app', 'cloud.js'), 'utf8'))   // sets globalThis.Cloud
const Cloud = globalThis.Cloud

try {
  CURRENT_TOKEN = await mintFam(FAMILY_ID)

  const p1 = await Cloud.pushBackup('deviceA')
  check(p1.uploaded === 3 && p1.skipped === 0, 'first push uploads all', JSON.stringify(p1))

  const p2 = await Cloud.pushBackup('deviceA')
  check(p2.uploaded === 0 && p2.skipped === 3, 'second push dedups (0 new bytes)', JSON.stringify(p2))

  restored = null
  const counts = await Cloud.pullBackup()
  const okRestore = counts.readings === 2 && restored &&
    restored.map.has('audio/r1.m4a') && restored.map.has('audio/r2.m4a') && restored.map.has('manifest.json')
  check(okRestore, 'pull restores manifest + both blobs', JSON.stringify(counts))
  // bytes integrity: the pulled r1 audio equals what we pushed
  const r1 = restored && restored.map.get('audio/r1.m4a')
  const same = r1 && r1.length === 5 && r1[0] === 1 && r1[4] === 5
  check(!!same, 'restored blob bytes match original', 'len=' + (r1 && r1.length))

  // hostile family: B cannot read A's backup
  FAMILY_ID = 'CC-BBBB-0002'
  CURRENT_TOKEN = await mintFam('CC-BBBB-0002')
  let blocked = false
  try { await Cloud.pullBackup() } catch (e) { blocked = /404|no backup/i.test(e.message) }
  check(blocked, 'hostile family cannot read another family backup', blocked ? 'got 404' : 'LEAK')
} catch (e) {
  console.error('EXCEPTION', e && e.stack || e); fail++
}

console.log(`\nPhase 1 verify: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
