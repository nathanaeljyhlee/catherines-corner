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
  const rows = await sql`SELECT family_id FROM family_member WHERE account_id = ${a.accountId} ORDER BY created_at LIMIT 1`
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
      if (a.testFam) return json(200, { familyId: a.testFam })
      const rows = await sql`SELECT family_id FROM family_member WHERE account_id = ${a.accountId} ORDER BY created_at LIMIT 1`
      return json(200, { familyId: rows.length ? rows[0].family_id : null })
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

    return json(404, { error: 'unknown route' })
  },
}
