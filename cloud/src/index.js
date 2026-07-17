// Catherine's Corner — Stage 2 cloud API Worker
//
// The ONLY server component. Verifies a Neon Auth (Better Auth) JWT, resolves
// the caller's family from Postgres membership, and issues short-lived presigned
// R2 URLs so blobs upload/download DIRECTLY to R2 and never transit this worker
// (ADR-0001 driver #3). Neon holds accounts/metadata.
//
// AUTH (Phase 1):
//   Production  = Neon Auth JWT, RS256, verified against the project JWKS.
//                 The token proves WHO you are (auth user id); the FAMILY you
//                 can touch is resolved from Postgres membership, NOT from the
//                 semi-public Corner ID. This is the security boundary.
//   Test only   = an HS256 token with a `fam` claim, accepted ONLY when
//                 env.TEST_MODE === '1' (dev/.dev.vars; NEVER a prod secret),
//                 so the E2E suite runs offline without a real login.

import { AwsClient } from 'aws4fetch'
import { jwtVerify, createRemoteJWKSet } from 'jose'
import { neon } from '@neondatabase/serverless'

const enc = new TextEncoder()
const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

// --- auth ---------------------------------------------------------------
let _jwks = null
function jwks(env) {
  if (!_jwks) _jwks = createRemoteJWKSet(new URL(env.NEON_AUTH_JWKS_URL))
  return _jwks
}

// Returns { authUserId, email } for a real user, { testFam } for the test path,
// or { err: Response } on failure.
async function auth(request, env) {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)
  if (!m) return { err: json(401, { error: 'missing bearer token' }) }
  const token = m[1]
  // production: Neon Auth JWT via JWKS
  if (env.NEON_AUTH_JWKS_URL) {
    try {
      const { payload } = await jwtVerify(token, jwks(env))
      if (payload.sub) return { authUserId: String(payload.sub), email: payload.email || null }
    } catch (_) { /* fall through to test path / reject */ }
  }
  // test-only: HS256 with a fam claim, gated by TEST_MODE
  if (env.TEST_MODE === '1' && env.JWT_SECRET) {
    try {
      const { payload } = await jwtVerify(token, enc.encode(env.JWT_SECRET), { algorithms: ['HS256'] })
      if (payload.fam) return { testFam: String(payload.fam) }
    } catch (_) { /* reject below */ }
  }
  return { err: json(403, { error: 'invalid token' }) }
}

// --- R2 presigning ------------------------------------------------------
const r2 = (env) =>
  new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, region: 'auto', service: 's3' })
const blobKey = (fam, sha) => `corners/${fam}/${sha}`
const objUrl = (env, k) => `${env.R2_ENDPOINT.replace(/\/+$/, '')}/${env.R2_BUCKET}/${k}`
async function presign(env, k, method, expires = 600) {
  const url = new URL(objUrl(env, k))
  url.searchParams.set('X-Amz-Expires', String(expires))
  return (await r2(env).sign(url.toString(), { method, aws: { signQuery: true } })).url
}

// --- DB + family resolution --------------------------------------------
const db = (env) => neon(env.DATABASE_URL)

async function ensureAccount(sql, authUserId, email) {
  const rows = await sql`INSERT INTO account (auth_user_id, email) VALUES (${authUserId}, ${email})
                         ON CONFLICT (auth_user_id) DO UPDATE SET email = COALESCE(EXCLUDED.email, account.email)
                         RETURNING id`
  return rows[0].id
}

// The family this caller may touch. Real users: their claimed membership.
// Test path: the fam from the token (bypasses claim). Returns familyId or null.
async function resolveFamily(sql, a) {
  if (a.testFam) {
    await sql`INSERT INTO family (id) VALUES (${a.testFam}) ON CONFLICT (id) DO NOTHING`
    return a.testFam
  }
  const accountId = await ensureAccount(sql, a.authUserId, a.email)
  const rows = await sql`SELECT family_id FROM family_member WHERE account_id = ${accountId} ORDER BY created_at LIMIT 1`
  return rows.length ? rows[0].family_id : null
}

// --- router -------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname, method = request.method

    if (path === '/health') return json(200, { ok: true, service: 'catherines-corner-cloud', phase: 1 })

    const needsAuth = path === '/family/claim' || path.startsWith('/backup/')
    if (!needsAuth) return json(404, { error: 'not found' })

    const a = await auth(request, env)
    if (a.err) return a.err
    const sql = db(env)

    // Bind this account to a familyId (first-claim-wins; others need membership).
    if (path === '/family/claim' && method === 'POST') {
      const body = await request.json().catch(() => ({}))
      const fam = String(body.familyId || '').trim()
      if (!fam) return json(400, { error: 'familyId required' })
      if (a.testFam) return json(200, { claimed: fam, role: 'test' })
      const accountId = await ensureAccount(sql, a.authUserId, a.email)
      const existing = await sql`SELECT owner_account_id FROM family WHERE id = ${fam}`
      if (!existing.length) {
        await sql`INSERT INTO family (id, owner_account_id) VALUES (${fam}, ${accountId})`
        await sql`INSERT INTO family_member (family_id, account_id, role) VALUES (${fam}, ${accountId}, 'owner')
                  ON CONFLICT (family_id, account_id) DO NOTHING`
        return json(200, { claimed: fam, role: 'owner' })
      }
      const member = await sql`SELECT role FROM family_member WHERE family_id = ${fam} AND account_id = ${accountId}`
      if (member.length) return json(200, { claimed: fam, role: member[0].role })
      // family exists, owned by someone else, caller not a member
      return json(403, { error: 'this Corner is already claimed by another account' })
    }

    // All /backup routes are scoped to the caller's resolved family.
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
        await sql`INSERT INTO blob_object (family_id, sha256, bytes, mime)
                  VALUES (${fam}, ${b.sha256}, ${b.bytes || 0}, ${b.mime || null})
                  ON CONFLICT (family_id, sha256) DO NOTHING`
        stored++
      }
      const man = body.manifest || {}
      await sql`INSERT INTO backup_state (family_id, manifest_key, manifest_sha256, device_label, pushed_at)
                VALUES (${fam}, ${man.key || blobKey(fam, 'manifest')}, ${man.sha256 || null}, ${body.device_label || null}, now())
                ON CONFLICT (family_id) DO UPDATE SET
                  manifest_key = EXCLUDED.manifest_key, manifest_sha256 = EXCLUDED.manifest_sha256,
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
