// Multi-device: one person, two devices (different local Corner IDs), same email.
// Device B must adopt the account's family and restore device A's backup — not
// create its own empty family. Drives the real app/cloud.js.
import { SignJWT } from 'jose'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const enc = new TextEncoder()
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787'
const MAGIC = process.env.MAGIC_SECRET
let pass = 0, fail = 0
const check = (ok, label, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ }
const mintMagic = (email) => new SignJWT({ email, purpose: 'magic', jti: randomUUID() }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('15m').sign(enc.encode(MAGIC))

globalThis.CC_CLOUD_API = BASE
let LOCAL_FAMILY = 'CC-DEVA-0001', TOKEN = null
globalThis.CloudAuth = { token: () => TOKEN }
const _s = {}
globalThis.DB = { familyId: async () => LOCAL_FAMILY, settings: { get: async (k) => _s[k], set: async (k, v) => { _s[k] = v } } }
const audio1 = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'audio/mp4' })
const audio2 = new Blob([new Uint8Array([9, 8, 7, 6, 5, 4])], { type: 'audio/mp4' })
const MAN = { format: 'catherines-corner-backup', formatVersion: 2, exportedAt: '2026-07-16T00:00:00.000Z', cornerName: 'MD', corners: [{ id: 'c1', name: 'MD', createdAt: 1 }], readers: [{ id: 'rd1', name: 'Dad' }], books: [], requests: [], readings: [{ id: 'r1', cornerId: 'c1', readerId: 'rd1', audio: { file: 'audio/r1.m4a', mime: 'audio/mp4' } }, { id: 'r2', cornerId: 'c1', readerId: 'rd1', audio: { file: 'audio/r2.m4a', mime: 'audio/mp4' } }] }
let restored = null
globalThis.Backup = {
  packAll: async () => ({ manifest: JSON.parse(JSON.stringify(MAN)), files: [{ name: 'audio/r1.m4a', blob: audio1 }, { name: 'audio/r2.m4a', blob: audio2 }] }),
  importBackup: async (m, map) => { restored = { m, map }; return { readings: (m.readings || []).length } },
}
eval(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'cloud.js'), 'utf8'))
const Cloud = globalThis.Cloud

async function signIn(email) {
  const r = await fetch(BASE + '/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: await mintMagic(email) }) })
  return (await r.json()).token
}

try {
  const EMAIL = 'md-parent-' + Date.now() + '@example.com'   // fresh account each run

  // Device A (Corner CC-DEVA) backs up
  LOCAL_FAMILY = 'CC-DEVA-0001'; TOKEN = await signIn(EMAIL)
  const pushA = await Cloud.pushBackup('device-A')
  check(pushA.uploaded === 3, 'device A backs up', JSON.stringify(pushA))

  // Device B: DIFFERENT local Corner (CC-DEVB), SAME person
  LOCAL_FAMILY = 'CC-DEVB-0002'; TOKEN = await signIn(EMAIL)
  const mine = await (await fetch(BASE + '/family/mine', { headers: { authorization: 'Bearer ' + TOKEN } })).json()
  check(mine.familyId === 'CC-DEVA-0001', 'device B adopts the account family (CC-DEVA), not its own CC-DEVB', JSON.stringify(mine))

  restored = null
  const pullB = await Cloud.pullBackup()
  check(pullB.readings === 2 && restored && restored.map.has('audio/r1.m4a'), 'device B restores device A backup', JSON.stringify(pullB))

  // and pushing from device B does NOT fork a second family
  const pushB = await Cloud.pushBackup('device-B')
  const mine2 = await (await fetch(BASE + '/family/mine', { headers: { authorization: 'Bearer ' + TOKEN } })).json()
  check(mine2.familyId === 'CC-DEVA-0001', 'device B still on the one shared family after its own push', JSON.stringify(mine2))
} catch (e) { console.error('EXCEPTION', e && e.stack || e); fail++ }

console.log(`\nMulti-device verify: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
