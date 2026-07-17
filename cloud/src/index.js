// Catherine's Corner — Stage 2 cloud API Worker (Phase 0 foundations)
//
// The ONLY server component. Verifies a JWT, checks family scope, and issues
// short-lived presigned R2 URLs so blobs upload/download DIRECTLY to R2 and
// never transit this worker (ADR-0001 driver #3). Neon holds metadata.
//
// Phase 0 scope: JWT verify (HS256 test key; real Neon Auth JWKS = Phase 1),
// presigned PUT/GET, and enough Neon writes (family + blob_object + backup_state)
// to prove the migration + DB connectivity. Endpoints follow the plan's names.

import { AwsClient } from 'aws4fetch'
import { jwtVerify } from 'jose'
import { neon } from '@neondatabase/serverless'

const enc = new TextEncoder()
const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

// --- auth ---------------------------------------------------------------
async function auth(request, env) {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)
  if (!m) return { err: json(401, { error: 'missing bearer token' }) }
  try {
    const { payload } = await jwtVerify(m[1], enc.encode(env.JWT_SECRET), { algorithms: ['HS256'] })
    if (!payload.fam) return { err: json(403, { error: 'token missing family claim' }) }
    return { fam: String(payload.fam), sub: payload.sub }
  } catch (e) {
    return { err: json(403, { error: 'invalid token', detail: e.message }) }
  }
}

// --- R2 presigning ------------------------------------------------------
const r2 = (env) =>
  new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, region: 'auto', service: 's3' })
const key = (fam, sha) => `corners/${fam}/${sha}`
const objUrl = (env, k) => `${env.R2_ENDPOINT.replace(/\/+$/, '')}/${env.R2_BUCKET}/${k}`

async function presign(env, k, method, expires = 600) {
  const url = new URL(objUrl(env, k))
  url.searchParams.set('X-Amz-Expires', String(expires))
  const signed = await r2(env).sign(url.toString(), { method, aws: { signQuery: true } })
  return signed.url
}

// --- DB -----------------------------------------------------------------
const db = (env) => neon(env.DATABASE_URL)

async function ensureFamily(sql, fam) {
  await sql`INSERT INTO family (id) VALUES (${fam}) ON CONFLICT (id) DO NOTHING`
}

// --- router -------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method

    if (path === '/health') return json(200, { ok: true, service: 'catherines-corner-cloud', phase: 0 })

    // Every /backup route requires auth
    if (path.startsWith('/backup/')) {
      const a = await auth(request, env)
      if (a.err) return a.err
      const sql = db(env)

      // presign PUTs for the blobs the client wants to upload (missing ones only, if committed already)
      if (path === '/backup/begin' && method === 'POST') {
        const body = await request.json().catch(() => ({}))
        const blobs = Array.isArray(body.blobs) ? body.blobs : []
        await ensureFamily(sql, a.fam)
        const have = new Set(
          (await sql`SELECT sha256 FROM blob_object WHERE family_id = ${a.fam}`).map((r) => r.sha256)
        )
        const uploads = []
        for (const b of blobs) {
          if (!b.sha256) continue
          const k = key(a.fam, b.sha256)
          uploads.push({ sha256: b.sha256, key: k, url: have.has(b.sha256) ? null : await presign(env, k, 'PUT') })
        }
        return json(200, { fam: a.fam, uploads })
      }

      // record uploaded blobs + the manifest pointer (proves Neon write path)
      if (path === '/backup/commit' && method === 'POST') {
        const body = await request.json().catch(() => ({}))
        const blobs = Array.isArray(body.blobs) ? body.blobs : []
        await ensureFamily(sql, a.fam)
        let stored = 0
        for (const b of blobs) {
          if (!b.sha256) continue
          await sql`INSERT INTO blob_object (family_id, sha256, bytes, mime)
                    VALUES (${a.fam}, ${b.sha256}, ${b.bytes || 0}, ${b.mime || null})
                    ON CONFLICT (family_id, sha256) DO NOTHING`
          stored++
        }
        const man = body.manifest || {}
        await sql`INSERT INTO backup_state (family_id, manifest_key, manifest_sha256, device_label, pushed_at)
                  VALUES (${a.fam}, ${man.key || key(a.fam, 'manifest')}, ${man.sha256 || null}, ${body.device_label || null}, now())
                  ON CONFLICT (family_id) DO UPDATE SET
                    manifest_key = EXCLUDED.manifest_key,
                    manifest_sha256 = EXCLUDED.manifest_sha256,
                    device_label = EXCLUDED.device_label,
                    pushed_at = now()`
        return json(200, { ok: true, stored })
      }

      // presigned GET for restore: the manifest, or a specific ?sha256=
      if (path === '/backup/latest' && method === 'GET') {
        const sha = url.searchParams.get('sha256')
        if (sha) return json(200, { url: await presign(env, key(a.fam, sha), 'GET') })
        const row = (await sql`SELECT manifest_key, manifest_sha256, pushed_at FROM backup_state WHERE family_id = ${a.fam}`)[0]
        if (!row) return json(404, { error: 'no backup for family' })
        return json(200, { manifest_key: row.manifest_key, manifest_sha256: row.manifest_sha256, pushed_at: row.pushed_at, url: await presign(env, row.manifest_key, 'GET') })
      }

      return json(404, { error: 'unknown backup route' })
    }

    return json(404, { error: 'not found' })
  },
}
