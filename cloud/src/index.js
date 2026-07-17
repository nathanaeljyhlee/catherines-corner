// Catherine's Corner — Stage 2 cloud API Worker
//
// The ONLY server component + its own tiny auth authority. Verifies a session
// token, resolves the caller's family from Postgres membership, and issues
// short-lived presigned R2 URLs so blobs upload/download DIRECTLY to R2 and
// never transit this worker (ADR-0001 driver #3).
//
// AUTH (email sign-in via Resend):
//   /auth/request { email }  -> emails a 6-digit CODE (primary) + a same-device
//                               magic link (convenience). One active code/email.
//   /auth/verify  { email, code } | { token }  -> a 30-day session JWT.
//   The CODE is the right primitive for a shared tablet / installed PWA (a link
//   opens on the wrong device or in Safari, not the app). Codes are hashed,
//   single-use, expire in 15 min, and lock after 5 wrong tries.
//   Test path = HS256 `fam` token, accepted ONLY when env.TEST_MODE === '1'.

import { AwsClient } from 'aws4fetch'
import { jwtVerify, SignJWT } from 'jose'
import { neon } from '@neondatabase/serverless'

const enc = new TextEncoder()
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-max-age': '86400',
}
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...CORS } })
const secret = (s) => enc.encode(s)

async function sha256hex(s) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(s))
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
function sixDigitCode() {
  const a = new Uint32Array(1); crypto.getRandomValues(a)
  return String(100000 + (a[0] % 900000))
}
// url-safe capability token for a share link (>=16 random bytes -> base64url)
function urlToken(bytes = 18) {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a)
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
// invite / inbox ids are Postgres uuids; reject garbage BEFORE it hits a uuid cast
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
const isPast = (ts) => ts && new Date(ts) < new Date()

// --- tokens -------------------------------------------------------------
const mintMagic = (env, email, jti) =>
  new SignJWT({ email, purpose: 'magic', jti }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('15m').sign(secret(env.MAGIC_SECRET))
const mintSession = (env, accountId, email) =>
  new SignJWT({ sub: accountId, email, purpose: 'session' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('30d').sign(secret(env.SESSION_SECRET))

async function auth(request, env) {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)
  if (!m) return { err: json(401, { error: 'missing bearer token' }) }
  if (env.SESSION_SECRET) {
    try {
      const { payload } = await jwtVerify(m[1], secret(env.SESSION_SECRET), { algorithms: ['HS256'] })
      if (payload.purpose === 'session' && payload.sub) return { accountId: String(payload.sub), email: payload.email || null }
    } catch (_) {}
  }
  if (env.TEST_MODE === '1' && env.JWT_SECRET) {
    try {
      const { payload } = await jwtVerify(m[1], secret(env.JWT_SECRET), { algorithms: ['HS256'] })
      if (payload.fam) return { testFam: String(payload.fam) }
    } catch (_) {}
  }
  return { err: json(403, { error: 'invalid token' }) }
}

// --- R2 -----------------------------------------------------------------
const r2 = (env) => new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, region: 'auto', service: 's3' })
const blobKey = (fam, sha) => `corners/${fam}/${sha}`
const objUrl = (env, k) => `${env.R2_ENDPOINT.replace(/\/+$/, '')}/${env.R2_BUCKET}/${k}`
async function presign(env, k, method, expires = 600) {
  const url = new URL(objUrl(env, k)); url.searchParams.set('X-Amz-Expires', String(expires))
  return (await r2(env).sign(url.toString(), { method, aws: { signQuery: true } })).url
}
// --- resumable multipart (S3 MPU on R2) ---------------------------------
// The worker SIGNS the create/complete/abort (server-to-server, needs the
// XML response); the per-part PUTs are presigned so bytes go DIRECT to R2.
async function mpuCreate(env, k) {
  const req = await r2(env).sign(objUrl(env, k) + '?uploads', { method: 'POST' })
  const res = await fetch(req)
  if (!res.ok) return null
  const xml = await res.text()
  return (xml.match(/<UploadId>([^<]+)<\/UploadId>/) || [])[1] || null
}
// presign a single part PUT: partNumber + uploadId are part of the signed query
async function presignPart(env, k, partNumber, uploadId, expires = 3600) {
  const url = new URL(objUrl(env, k))
  url.searchParams.set('partNumber', String(partNumber))
  url.searchParams.set('uploadId', uploadId)
  url.searchParams.set('X-Amz-Expires', String(expires))
  return (await r2(env).sign(url.toString(), { method: 'PUT', aws: { signQuery: true } })).url
}
async function mpuComplete(env, k, uploadId, parts) {
  const ordered = [...parts].sort((x, y) => x.partNumber - y.partNumber)
  const body = `<CompleteMultipartUpload>${ordered
    .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
    .join('')}</CompleteMultipartUpload>`
  const req = await r2(env).sign(objUrl(env, k) + '?uploadId=' + encodeURIComponent(uploadId), { method: 'POST', body })
  const res = await fetch(req)
  // S3/R2 CompleteMultipartUpload can return HTTP 200 with an <Error> body — treat that as failure.
  const text = await res.text().catch(() => '')
  return res.ok && !/<Error[\s>]/.test(text)
}
async function mpuAbort(env, k, uploadId) {
  const req = await r2(env).sign(objUrl(env, k) + '?uploadId=' + encodeURIComponent(uploadId), { method: 'DELETE' })
  return (await fetch(req)).ok
}

// --- DB -----------------------------------------------------------------
const db = (env) => neon(env.DATABASE_URL)
const normEmail = (e) => String(e || '').trim().toLowerCase()
async function ensureAccount(sql, email) {
  const rows = await sql`INSERT INTO account (auth_user_id, email) VALUES (${'email:' + email}, ${email})
                         ON CONFLICT (auth_user_id) DO UPDATE SET email = EXCLUDED.email RETURNING id`
  return rows[0].id
}
async function resolveFamily(sql, a) {
  if (a.testFam) { await sql`INSERT INTO family (id) VALUES (${a.testFam}) ON CONFLICT (id) DO NOTHING`; return a.testFam }
  const rows = await sql`SELECT family_id FROM family_member WHERE account_id = ${a.accountId} AND status = 'active' ORDER BY created_at LIMIT 1`
  return rows.length ? rows[0].family_id : null
}

// --- email --------------------------------------------------------------
async function sendSignInEmail(env, email, code, link) {
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:440px;margin:0 auto;color:#2b2b2b">
    <h2 style="font-weight:600">Sign in to Catherine's Corner</h2>
    <p>Enter this code in the app to turn on cloud backup:</p>
    <p style="font-size:34px;font-weight:700;letter-spacing:8px;margin:18px 0;color:#6b4f8a">${code}</p>
    <p style="color:#888;font-size:13px">It works once and expires in 15 minutes.</p>
    <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
    <p style="color:#888;font-size:13px">On the same device? You can just <a href="${link}" style="color:#6b4f8a">tap here to sign in</a>.</p>
    <p style="color:#aaa;font-size:12px">If you didn't ask to sign in, ignore this email — nothing happens until the code is entered.</p>
  </div>`
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.RESEND_FROM, to: email, subject: `Your Catherine's Corner sign-in code: ${code}`, html }),
  })
  return r.ok
}

// --- router -------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname, method = request.method
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    if (path === '/health') return json(200, { ok: true, service: 'catherines-corner-cloud', phase: 1 })
    const sql = db(env)

    // Request a sign-in code (+ same-device link)
    if (path === '/auth/request' && method === 'POST') {
      const body = await request.json().catch(() => ({}))
      const email = normEmail(body.email)
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: 'a valid email is required' })
      const code = sixDigitCode()
      const codeHash = await sha256hex(code)
      await sql`INSERT INTO auth_code (email, code_hash, expires_at, attempts, used)
                VALUES (${email}, ${codeHash}, now() + interval '15 minutes', 0, false)
                ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, used = false, created_at = now()`
      const token = await mintMagic(env, email, crypto.randomUUID())
      const link = env.APP_URL.replace(/\/+$/, '') + '/#magic=' + encodeURIComponent(token)
      const sent = await sendSignInEmail(env, email, code, link)
      // TEST_MODE (dev only) echoes the code so the E2E can verify it; never set in prod.
      return sent ? json(200, { ok: true, ...(env.TEST_MODE === '1' ? { code } : {}) }) : json(502, { error: 'could not send the email; try again' })
    }

    // Verify a code OR a same-device link -> session token
    if (path === '/auth/verify' && method === 'POST') {
      const body = await request.json().catch(() => ({}))
      let email = null
      if (body.token) {
        let payload
        try { ({ payload } = await jwtVerify(String(body.token), secret(env.MAGIC_SECRET), { algorithms: ['HS256'] })) }
        catch (_) { return json(403, { error: 'this sign-in link is invalid or has expired' }) }
        if (payload.purpose !== 'magic' || !payload.email || !payload.jti) return json(403, { error: 'invalid link' })
        const used = await sql`INSERT INTO magic_used (jti, email) VALUES (${payload.jti}, ${payload.email})
                               ON CONFLICT (jti) DO NOTHING RETURNING jti`
        if (!used.length) return json(403, { error: 'this sign-in link has already been used' })
        email = normEmail(payload.email)
      } else if (body.email && body.code) {
        email = normEmail(body.email)
        const code = String(body.code).replace(/\D/g, '')
        const row = (await sql`SELECT code_hash, attempts FROM auth_code WHERE email = ${email} AND used = false AND expires_at > now()`)[0]
        if (!row) return json(403, { error: 'that code has expired — request a new one' })
        if (row.attempts >= 5) return json(403, { error: 'too many tries — request a new code' })
        if ((await sha256hex(code)) !== row.code_hash) {
          await sql`UPDATE auth_code SET attempts = attempts + 1 WHERE email = ${email}`
          return json(403, { error: 'that code is not right' })
        }
        await sql`UPDATE auth_code SET used = true WHERE email = ${email}`
      } else {
        return json(400, { error: 'email + code (or a link token) required' })
      }
      const accountId = await ensureAccount(sql, email)
      return json(200, { token: await mintSession(env, accountId, email), email })
    }

    // --- capability-token routes (Phase 3/4): the URL token IS the authority,
    //     so these are handled BEFORE the session-JWT gate below ---

    // Fetch a shared parcel by its token (no auth). 404 (calm) on unknown/expired.
    let mShare
    if ((mShare = path.match(/^\/share\/([^/]+)$/)) && method === 'GET') {
      const token = decodeURIComponent(mShare[1])
      const row = (await sql`SELECT family_id, manifest_key, title, to_family_id, expires_at, claimed_at, revoked_at FROM share_link WHERE token = ${token}`)[0]
      if (!row || isPast(row.expires_at) || row.revoked_at) return json(404, { error: 'not found' })
      // server-side read of the envelope we wrote at share time (manifest + declared sha list)
      let env0
      try { env0 = await (await fetch(await presign(env, row.manifest_key, 'GET'))).json() }
      catch (_) { return json(404, { error: 'not found' }) }
      const manifest = env0 && env0.manifest ? env0.manifest : env0
      const shas = Array.isArray(env0 && env0.blobSha256) ? env0.blobSha256 : []
      const blobs = []
      // presign ONLY this share's family's blobs — never cross-family
      for (const sha of shas) blobs.push({ sha256: sha, url: await presign(env, blobKey(row.family_id, sha), 'GET') })
      return json(200, { manifest, blobs, title: row.title, toFamilyId: row.to_family_id })
    }

    // Guest uploads to an invite ("put it on the shelf"): invite token, NOT a session.
    let mIup
    if ((mIup = path.match(/^\/inbox\/([^/]+)\/upload$/)) && method === 'POST') {
      const inviteToken = decodeURIComponent(mIup[1])
      if (!isUuid(inviteToken)) return json(404, { error: 'not found' })
      const inv = (await sql`SELECT id, family_id, expires_at, revoked_at FROM invite WHERE id = ${inviteToken}`)[0]
      if (!inv || inv.revoked_at || isPast(inv.expires_at)) return json(404, { error: 'not found' })
      const body = await request.json().catch(() => ({}))
      const blobs = Array.isArray(body.blobs) ? body.blobs : []
      const uploads = []
      // blobs land content-addressed in THIS invite's family space; the guest can write nowhere else
      for (const b of blobs) { if (!b.sha256) continue; uploads.push({ sha256: b.sha256, url: await presign(env, blobKey(inv.family_id, b.sha256), 'PUT') }) }
      return json(200, { uploads })
    }

    // Resumable multipart for a long recording (invite token, NOT a session).
    // init -> client PUTs each part direct to R2 -> complete (or abort). Blobs
    // still land content-addressed in THIS invite's family space; nowhere else.
    // These three sit ABOVE the single-PUT route only in intent; the `$` anchors
    // keep /upload, /upload/init, /upload/complete, /upload/abort disjoint.
    async function inviteFor(token) {
      if (!isUuid(token)) return null
      const inv = (await sql`SELECT id, family_id, expires_at, revoked_at FROM invite WHERE id = ${token}`)[0]
      if (!inv || inv.revoked_at || isPast(inv.expires_at)) return null
      return inv
    }
    let mMpInit
    if ((mMpInit = path.match(/^\/inbox\/([^/]+)\/upload\/init$/)) && method === 'POST') {
      const inv = await inviteFor(decodeURIComponent(mMpInit[1]))
      if (!inv) return json(404, { error: 'not found' })
      const body = await request.json().catch(() => ({}))
      const sha = body.sha256, count = Number(body.parts)
      if (!sha || !Number.isInteger(count) || count < 1) return json(400, { error: 'sha256 and a part count are required' })
      const key = blobKey(inv.family_id, sha)
      const uploadId = await mpuCreate(env, key)
      if (!uploadId) return json(502, { error: 'could not start the upload' })
      const parts = []
      for (let n = 1; n <= count; n++) parts.push({ partNumber: n, url: await presignPart(env, key, n, uploadId) })
      return json(200, { uploadId, key, parts })
    }
    let mMpDone
    if ((mMpDone = path.match(/^\/inbox\/([^/]+)\/upload\/complete$/)) && method === 'POST') {
      const inv = await inviteFor(decodeURIComponent(mMpDone[1]))
      if (!inv) return json(404, { error: 'not found' })
      const body = await request.json().catch(() => ({}))
      const sha = body.sha256, uploadId = body.uploadId
      const parts = Array.isArray(body.parts) ? body.parts.filter((p) => p && p.partNumber && p.etag) : []
      if (!sha || !uploadId || !parts.length) return json(400, { error: 'sha256, uploadId and parts are required' })
      const ok = await mpuComplete(env, blobKey(inv.family_id, sha), uploadId, parts)
      if (!ok) return json(502, { error: 'could not finish the upload' })
      return json(200, { ok: true })
    }
    let mMpStop
    if ((mMpStop = path.match(/^\/inbox\/([^/]+)\/upload\/abort$/)) && method === 'POST') {
      const inv = await inviteFor(decodeURIComponent(mMpStop[1]))
      if (!inv) return json(404, { error: 'not found' })
      const body = await request.json().catch(() => ({}))
      const sha = body.sha256, uploadId = body.uploadId
      if (!sha || !uploadId) return json(400, { error: 'sha256 and uploadId are required' })
      await mpuAbort(env, blobKey(inv.family_id, sha), uploadId)
      return json(200, { ok: true })
    }

    // Guest commits an inbox_item after the bytes are up (invite token, NOT a session).
    let mIcm
    if ((mIcm = path.match(/^\/inbox\/([^/]+)\/commit$/)) && method === 'POST') {
      const inviteToken = decodeURIComponent(mIcm[1])
      if (!isUuid(inviteToken)) return json(404, { error: 'not found' })
      const inv = (await sql`SELECT id, family_id, expires_at, revoked_at FROM invite WHERE id = ${inviteToken}`)[0]
      if (!inv || inv.revoked_at || isPast(inv.expires_at)) return json(404, { error: 'not found' })
      const body = await request.json().catch(() => ({}))
      const shas = Array.isArray(body.blobSha256) ? body.blobSha256.filter(Boolean) : []
      const sha = shas[0] || null
      if (!sha) return json(400, { error: 'blobSha256 required' })
      const rows = await sql`INSERT INTO inbox_item (family_id, invite_id, blob_sha256, mime, from_name, note)
                             VALUES (${inv.family_id}, ${inv.id}, ${sha}, ${body.mime || null}, ${body.fromName || null}, ${body.note || null}) RETURNING id`
      return json(200, { ok: true, id: rows[0].id })
    }

    // --- everything below needs a session ---
    const a = await auth(request, env)
    if (a.err) return a.err

    if (path === '/family/claim' && method === 'POST') {
      const body = await request.json().catch(() => ({}))
      const fam = String(body.familyId || '').trim()
      if (!fam) return json(400, { error: 'familyId required' })
      if (a.testFam) return json(200, { claimed: fam, role: 'test' })
      const existing = await sql`SELECT owner_account_id FROM family WHERE id = ${fam}`
      if (!existing.length) {
        await sql`INSERT INTO family (id, owner_account_id) VALUES (${fam}, ${a.accountId})`
        await sql`INSERT INTO family_member (family_id, account_id, role) VALUES (${fam}, ${a.accountId}, 'owner') ON CONFLICT DO NOTHING`
        return json(200, { claimed: fam, role: 'owner' })
      }
      const member = await sql`SELECT role FROM family_member WHERE family_id = ${fam} AND account_id = ${a.accountId}`
      if (member.length) return json(200, { claimed: fam, role: member[0].role })
      return json(403, { error: 'this Corner is already claimed by another account' })
    }

    // Which family does THIS account already belong to? A new device adopts this
    // instead of claiming its own local Corner ID (multi-device support).
    if (path === '/family/mine' && method === 'GET') {
      if (a.testFam) return json(200, { familyId: a.testFam, pendingFamilyId: null })
      const act = await sql`SELECT family_id FROM family_member WHERE account_id = ${a.accountId} AND status = 'active' ORDER BY created_at LIMIT 1`
      const pend = await sql`SELECT family_id FROM family_member WHERE account_id = ${a.accountId} AND status = 'pending' ORDER BY created_at LIMIT 1`
      return json(200, { familyId: act.length ? act[0].family_id : null, pendingFamilyId: pend.length ? pend[0].family_id : null })
    }

    // --- Feature 3: co-parent join (owner-approved family_member) ---
    // These live ABOVE the resolveFamily 409 gate because a joiner has no active
    // family yet. Owner-only routes independently prove ownership via
    // family.owner_account_id; approval flips a member from 'pending' -> 'active'.
    const ownerFamily = async () => (await sql`SELECT id FROM family WHERE owner_account_id = ${a.accountId}`)[0]

    // Owner mints a 14-day join link.
    if (path === '/family/invite' && method === 'POST') {
      const own = await ownerFamily()
      if (!own) return json(403, { error: 'only the owner can invite' })
      const token = urlToken()
      await sql`INSERT INTO family_invite (token, family_id, created_by, expires_at)
                VALUES (${token}, ${own.id}, ${a.accountId}, now() + interval '14 days')`
      return json(200, { joinToken: token, url: env.APP_URL.replace(/\/+$/, '') + '/#join=' + token })
    }

    // Co-parent redeems the link -> lands 'pending'. 409 if they already own/belong to a DIFFERENT corner.
    if (path === '/family/join' && method === 'POST') {
      const body = await request.json().catch(() => ({}))
      const token = String(body.token || '').trim()
      if (!token) return json(400, { error: 'token required' })
      const inv = (await sql`SELECT token, family_id, expires_at, used_at FROM family_invite WHERE token = ${token}`)[0]
      if (!inv || isPast(inv.expires_at) || inv.used_at) return json(404, { error: 'not found' })
      const mine = await resolveFamily(sql, a)
      if (mine) {
        if (mine === inv.family_id) return json(200, { status: 'active', familyId: mine }) // already an active member of this corner
        return json(409, { error: 'you already have a corner', hint: 'co-parent join is for an account without its own corner' })
      }
      // idempotent: re-redeem keeps existing status (a pending member stays pending)
      await sql`INSERT INTO family_member (family_id, account_id, role, status)
                VALUES (${inv.family_id}, ${a.accountId}, 'member', 'pending')
                ON CONFLICT (family_id, account_id) DO UPDATE SET status = family_member.status`
      await sql`UPDATE family_invite SET used_at = now() WHERE token = ${token} AND used_at IS NULL`
      const cur = (await sql`SELECT status FROM family_member WHERE family_id = ${inv.family_id} AND account_id = ${a.accountId}`)[0]
      return json(200, { status: cur ? cur.status : 'pending', familyId: inv.family_id })
    }

    // Owner lists pending join requests (with the requester's email).
    if (path === '/family/requests' && method === 'GET') {
      const own = await ownerFamily()
      if (!own) return json(403, { error: 'only the owner can view requests' })
      const rows = await sql`SELECT fm.account_id, acc.email, fm.created_at
                             FROM family_member fm JOIN account acc ON acc.id = fm.account_id
                             WHERE fm.family_id = ${own.id} AND fm.status = 'pending' ORDER BY fm.created_at`
      return json(200, { requests: rows.map((r) => ({ accountId: r.account_id, email: r.email, requestedAt: r.created_at })) })
    }

    // Owner approves a pending member -> 'active' (existing family-scoped flows just work).
    let mApprove
    if ((mApprove = path.match(/^\/family\/members\/([^/]+)\/approve$/)) && method === 'POST') {
      const target = decodeURIComponent(mApprove[1])
      if (!isUuid(target)) return json(404, { error: 'not found' })
      const own = await ownerFamily()
      if (!own) return json(403, { error: 'only the owner can approve' })
      const upd = await sql`UPDATE family_member SET status = 'active'
                            WHERE family_id = ${own.id} AND account_id = ${target} AND status = 'pending' RETURNING account_id`
      if (!upd.length) return json(404, { error: 'not found' })
      return json(200, { ok: true })
    }

    // Owner declines a pending member -> removed.
    let mDecline
    if ((mDecline = path.match(/^\/family\/members\/([^/]+)\/decline$/)) && method === 'POST') {
      const target = decodeURIComponent(mDecline[1])
      if (!isUuid(target)) return json(404, { error: 'not found' })
      const own = await ownerFamily()
      if (!own) return json(403, { error: 'only the owner can decline' })
      await sql`DELETE FROM family_member WHERE family_id = ${own.id} AND account_id = ${target} AND status = 'pending'`
      return json(200, { ok: true })
    }

    const fam = await resolveFamily(sql, a)
    if (!fam) return json(409, { error: 'no family claimed', hint: 'POST /family/claim { familyId } first' })

    if (path === '/backup/begin' && method === 'POST') {
      const body = await request.json().catch(() => ({}))
      const blobs = Array.isArray(body.blobs) ? body.blobs : []
      const have = new Set((await sql`SELECT sha256 FROM blob_object WHERE family_id = ${fam}`).map((r) => r.sha256))
      const uploads = []
      for (const b of blobs) {
        if (!b.sha256) continue
        const k = blobKey(fam, b.sha256)
        uploads.push({ sha256: b.sha256, key: k, url: have.has(b.sha256) ? null : await presign(env, k, 'PUT') })
      }
      return json(200, { fam, uploads })
    }

    if (path === '/backup/commit' && method === 'POST') {
      const body = await request.json().catch(() => ({}))
      const blobs = Array.isArray(body.blobs) ? body.blobs : []
      let stored = 0
      for (const b of blobs) {
        if (!b.sha256) continue
        await sql`INSERT INTO blob_object (family_id, sha256, bytes, mime) VALUES (${fam}, ${b.sha256}, ${b.bytes || 0}, ${b.mime || null})
                  ON CONFLICT (family_id, sha256) DO NOTHING`
        stored++
      }
      const man = body.manifest || {}
      await sql`INSERT INTO backup_state (family_id, manifest_key, manifest_sha256, device_label, pushed_at)
                VALUES (${fam}, ${man.key || blobKey(fam, 'manifest')}, ${man.sha256 || null}, ${body.device_label || null}, now())
                ON CONFLICT (family_id) DO UPDATE SET manifest_key = EXCLUDED.manifest_key, manifest_sha256 = EXCLUDED.manifest_sha256,
                  device_label = EXCLUDED.device_label, pushed_at = now()`
      return json(200, { ok: true, stored })
    }

    if (path === '/backup/latest' && method === 'GET') {
      const sha = url.searchParams.get('sha256')
      if (sha) return json(200, { url: await presign(env, blobKey(fam, sha), 'GET') })
      const row = (await sql`SELECT manifest_key, manifest_sha256, pushed_at FROM backup_state WHERE family_id = ${fam}`)[0]
      if (!row) return json(404, { error: 'no backup for family' })
      return json(200, { manifest_key: row.manifest_key, manifest_sha256: row.manifest_sha256, pushed_at: row.pushed_at, url: await presign(env, row.manifest_key, 'GET') })
    }

    // --- Phase 3: mint a share link (JWT + family) ---
    if (path === '/share' && method === 'POST') {
      const body = await request.json().catch(() => ({}))
      const manifest = body.manifest || {}
      const blobSha256 = Array.isArray(body.blobSha256) ? body.blobSha256.filter(Boolean) : []
      const token = urlToken()
      const manifestKey = `shares/${token}.json`
      // store manifest + declared sha list together so GET /share presigns exactly these blobs
      const envelope = JSON.stringify({ manifest, blobSha256, title: body.title || null, toFamilyId: body.toFamilyId || null })
      const put = await fetch(await presign(env, manifestKey, 'PUT'), { method: 'PUT', body: envelope, headers: { 'content-type': 'application/json' } })
      if (!put.ok) return json(502, { error: 'could not store the share' })
      await sql`INSERT INTO share_link (token, family_id, kind, manifest_key, title, to_family_id, expires_at)
                VALUES (${token}, ${fam}, 'parcel', ${manifestKey}, ${body.title || null}, ${body.toFamilyId || null}, now() + interval '30 days')`
      return json(200, { token, url: env.APP_URL.replace(/\/+$/, '') + '/#parcel=' + token })
    }

    // --- Feature 1: list a family's live share links (JWT + active family) ---
    if (path === '/shares' && method === 'GET') {
      const rows = await sql`SELECT token, title, created_at, expires_at FROM share_link
                             WHERE family_id = ${fam} AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`
      return json(200, { shares: rows.map((r) => ({ token: r.token, title: r.title, url: env.APP_URL.replace(/\/+$/, '') + '/#parcel=' + r.token, createdAt: r.created_at, expiresAt: r.expires_at })) })
    }

    // --- Feature 1: cancel a share link (JWT + family owns it) ---
    // Regex anchored with /revoke so it never collides with the GET /share/{token}
    // capability route above; POST-only, in the session-gated section.
    let mRevoke
    if ((mRevoke = path.match(/^\/share\/([^/]+)\/revoke$/)) && method === 'POST') {
      const token = decodeURIComponent(mRevoke[1])
      const upd = await sql`UPDATE share_link SET revoked_at = now()
                            WHERE token = ${token} AND family_id = ${fam} AND revoked_at IS NULL RETURNING token`
      if (!upd.length) {
        // exists under another family -> 403; otherwise unknown/already-revoked -> calm 404
        const row = (await sql`SELECT family_id FROM share_link WHERE token = ${token}`)[0]
        if (row && row.family_id !== fam) return json(403, { error: 'not your link' })
        return json(404, { error: 'not found' })
      }
      return json(200, { ok: true })
    }

    // --- Phase 4: mint an upload invite (JWT + family) ---
    if (path === '/invite' && method === 'POST') {
      const body = await request.json().catch(() => ({}))
      const days = Number.isFinite(body.expiresDays) ? body.expiresDays : 30
      const rows = await sql`INSERT INTO invite (family_id, kid_name, book_title, expires_at)
                             VALUES (${fam}, ${body.kidName || null}, ${body.bookTitle || null}, now() + make_interval(days => ${days})) RETURNING id`
      const id = rows[0].id
      return json(200, { inviteToken: id, url: env.APP_URL.replace(/\/+$/, '') + '/#give=' + id })
    }

    // --- Phase 4: list open arrivals for the caller's family (JWT + family) ---
    if (path === '/inbox' && method === 'GET') {
      const rows = await sql`SELECT id, from_name, note, blob_sha256, mime, created_at
                             FROM inbox_item WHERE family_id = ${fam} AND accepted_at IS NULL ORDER BY created_at`
      const items = []
      for (const r of rows) items.push({ id: r.id, fromName: r.from_name, note: r.note, blobSha256: r.blob_sha256, mime: r.mime, createdAt: r.created_at, blobUrl: await presign(env, blobKey(fam, r.blob_sha256), 'GET') })
      return json(200, { items })
    }

    // --- Phase 4: accept an arrival (JWT + family ownership check) ---
    let mAcc
    if ((mAcc = path.match(/^\/inbox\/([^/]+)\/accept$/)) && method === 'POST') {
      const id = decodeURIComponent(mAcc[1])
      if (!isUuid(id)) return json(404, { error: 'not found' })
      const upd = await sql`UPDATE inbox_item SET accepted_at = now() WHERE id = ${id} AND family_id = ${fam} AND accepted_at IS NULL RETURNING id`
      if (!upd.length) {
        // adversarial: another family's item must be refused, not silently no-op'd
        const it = (await sql`SELECT family_id FROM inbox_item WHERE id = ${id}`)[0]
        if (it && it.family_id !== fam) return json(403, { error: 'not your item' })
        return json(404, { error: 'not found' })
      }
      return json(200, { ok: true })
    }

    return json(404, { error: 'unknown route' })
  },
}
