// Phase 1b verify: the full worker-native magic-link auth chain + backup, driving
// the REAL app/cloud.js with a worker-issued session token.
//   /auth/request -> 200 (Resend accepted)
//   mint magic -> /auth/verify -> session token; reuse magic -> 403 (single-use)
//   session -> claim + push + dedup + pull/restore (bytes match)
//   second account cannot claim the first's Corner (403) nor read its backup (404)
// Env: BASE_URL, MAGIC_SECRET (dev), REQUEST_EMAIL (optional real recipient).
import { SignJWT } from 'jose'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const enc = new TextEncoder()
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787'
const MAGIC = process.env.MAGIC_SECRET
if (!MAGIC) { console.error('no MAGIC_SECRET'); process.exit(1) }
let pass = 0, fail = 0
const check = (ok, label, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ }
const post = (p, body, tok) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) })
const mintMagic = (email, jti) => new SignJWT({ email, purpose: 'magic', jti }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('15m').sign(enc.encode(MAGIC))

// --- load real cloud.js with mocks ---
globalThis.CC_CLOUD_API = BASE
let TOKEN = null, FAMILY_ID = 'CC-AAAA-0001'
globalThis.CloudAuth = { token: () => TOKEN }
globalThis.DB = { familyId: async () => FAMILY_ID, settings: { set: async () => {} } }
const audio1 = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'audio/mp4' })
const audio2 = new Blob([new Uint8Array([9, 8, 7, 6, 5, 4])], { type: 'audio/mp4' })
const MAN = { format: 'catherines-corner-backup', formatVersion: 2, exportedAt: '2026-07-16T00:00:00.000Z', cornerName: 'Test', corners: [{ id: 'c1', name: 'Test', createdAt: 1 }], readers: [{ id: 'rd1', name: 'Dad' }], books: [], requests: [], readings: [{ id: 'r1', cornerId: 'c1', readerId: 'rd1', audio: { file: 'audio/r1.m4a', mime: 'audio/mp4' } }, { id: 'r2', cornerId: 'c1', readerId: 'rd1', audio: { file: 'audio/r2.m4a', mime: 'audio/mp4' } }] }
let restored = null
globalThis.Backup = {
  packAll: async () => ({ manifest: JSON.parse(JSON.stringify(MAN)), files: [{ name: 'audio/r1.m4a', blob: audio1 }, { name: 'audio/r2.m4a', blob: audio2 }] }),
  importBackup: async (m, map) => { restored = { m, map }; return { readings: (m.readings || []).length } },
}
const __dir = dirname(fileURLToPath(import.meta.url))
eval(readFileSync(join(__dir, '..', '..', 'app', 'cloud.js'), 'utf8'))
const Cloud = globalThis.Cloud

async function signIn(email) {
  const jti = randomUUID()
  const magic = await mintMagic(email, jti)
  const r = await post('/auth/verify', { token: magic })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, token: j.token, magic }
}

try {
  const reqEmail = process.env.REQUEST_EMAIL || 'harness@example.com'
  const rr = await post('/auth/request', { email: reqEmail })
  check(rr.ok, 'auth/request sends magic email (Resend)', 'HTTP ' + rr.status + (reqEmail !== 'harness@example.com' ? ' -> ' + reqEmail : ''))

  const a = await signIn('parent-a@example.com')
  check(a.ok && a.token, 'magic verify -> session token', 'HTTP ' + a.status)

  // single-use: replaying the same magic link fails
  const replay = await post('/auth/verify', { token: a.magic })
  check(replay.status === 403, 'used magic link rejected (single-use)', 'HTTP ' + replay.status)

  // backup round-trip with the real session token
  TOKEN = a.token; FAMILY_ID = 'CC-AAAA-0001'
  const p1 = await Cloud.pushBackup('deviceA')
  check(p1.uploaded === 3 && p1.skipped === 0, 'first push uploads all', JSON.stringify(p1))
  const p2 = await Cloud.pushBackup('deviceA')
  check(p2.uploaded === 0 && p2.skipped === 3, 'second push dedups', JSON.stringify(p2))
  restored = null
  const counts = await Cloud.pullBackup()
  const r1 = restored && restored.map.get('audio/r1.m4a')
  check(counts.readings === 2 && r1 && r1.length === 5 && r1[0] === 1, 'pull restores, bytes match', JSON.stringify(counts))

  // second account: cannot claim A's Corner, cannot read A's backup
  const b = await signIn('parent-b@example.com')
  const claimConflict = await post('/family/claim', { familyId: 'CC-AAAA-0001' }, b.token)
  check(claimConflict.status === 403, 'second account cannot claim another family Corner', 'HTTP ' + claimConflict.status)
  TOKEN = b.token; FAMILY_ID = 'CC-BBBB-0002'
  let blocked = false
  try { await Cloud.pullBackup() } catch (e) { blocked = /404|no backup/i.test(e.message) }
  check(blocked, 'second family cannot read first family backup', blocked ? '404' : 'LEAK')
} catch (e) { console.error('EXCEPTION', e && e.stack || e); fail++ }

console.log(`\nPhase 1b verify: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
