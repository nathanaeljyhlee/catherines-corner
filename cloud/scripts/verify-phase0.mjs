// Phase 0 acceptance: drives the running worker end-to-end against LIVE Neon + R2.
//   valid JWT -> presigned PUT -> R2 write -> Neon commit -> presigned GET -> bytes match
//   hostile/absent token -> refused
// Env: BASE_URL (worker), JWT_SECRET. Exit non-zero on any failure.
import { SignJWT } from 'jose'
import { createHash } from 'node:crypto'

const enc = new TextEncoder()
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787'
const SECRET = process.env.JWT_SECRET
if (!SECRET) { console.error('no JWT_SECRET in env'); process.exit(1) }
const FAM = 'CC-TEST-0001'

let pass = 0, fail = 0
const check = (ok, label, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ }
const mint = (fam = FAM) => new SignJWT({ fam, sub: 'tester' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('10m').sign(enc.encode(SECRET))

const jwt = await mint()
const body = 'catherines corner phase0 ' + Date.now()
const sha = createHash('sha256').update(body).digest('hex')
const bytes = Buffer.byteLength(body)
const H = (t) => ({ authorization: 'Bearer ' + t, 'content-type': 'application/json' })

try {
  let r = await fetch(BASE + '/health'); check(r.ok, 'health', 'HTTP ' + r.status)

  r = await fetch(BASE + '/backup/begin', { method: 'POST', headers: H(jwt), body: JSON.stringify({ blobs: [{ sha256: sha, bytes, mime: 'text/plain' }] }) })
  let j = await r.json().catch(() => ({}))
  const up = j.uploads && j.uploads[0]
  check(r.ok && up && up.url, 'begin -> presigned PUT url', 'HTTP ' + r.status)

  let put = await fetch(up.url, { method: 'PUT', body })
  check(put.ok, 'PUT blob to R2 via presigned url', 'HTTP ' + put.status)

  r = await fetch(BASE + '/backup/commit', { method: 'POST', headers: H(jwt), body: JSON.stringify({ blobs: [{ sha256: sha, bytes, mime: 'text/plain' }], manifest: { key: `corners/${FAM}/${sha}`, sha256: sha }, device_label: 'verify' }) })
  j = await r.json().catch(() => ({}))
  check(r.ok && j.ok, 'commit -> Neon blob_object + backup_state', 'HTTP ' + r.status + ' stored=' + j.stored)

  r = await fetch(BASE + `/backup/latest?sha256=${sha}`, { headers: H(jwt) })
  j = await r.json().catch(() => ({}))
  check(r.ok && j.url, 'latest -> presigned GET url', 'HTTP ' + r.status)

  let get = await fetch(j.url); let got = await get.text()
  check(get.ok && got === body, 'GET blob back, bytes match', 'match=' + (got === body))

  r = await fetch(BASE + '/backup/begin', { method: 'POST', headers: H('garbage.token.here'), body: '{}' })
  check(r.status === 403 || r.status === 401, 'hostile token refused', 'HTTP ' + r.status)

  r = await fetch(BASE + '/backup/begin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  check(r.status === 401, 'missing token refused', 'HTTP ' + r.status)
} catch (e) {
  console.error('EXCEPTION', e?.message || e); fail++
}

console.log(`\nPhase 0 verify: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
