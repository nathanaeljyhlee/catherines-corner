/* Catherine's Corner E2E — fake cloud server (Stage 2, Phase 3 + Phase 4).
   Keyless, in-memory, offline — the same shape as the existing fake
   telemetry collector in e2e.js (a tiny http.createServer standing in for a
   real vendor), just enough surface to drive the client through
   app/cloud.js's `g.CC_CLOUD_API` override.

   Implements every endpoint in the locked contract
   (snowbear-hq/sprints/2026-07-17/1156/CONTRACT.md) PLUS the Phase 0/1
   routes it builds on (verified against the real `cloud/src/index.js`):
     /health
     /auth/request  /auth/verify
     /family/claim  /family/mine
     /backup/begin  /backup/commit  /backup/latest
     POST /share            GET /share/{token}
     POST /invite
     POST /inbox/{token}/upload   POST /inbox/{token}/commit   (invite-token auth)
     GET /inbox              POST /inbox/{id}/accept            (session auth)

   Plus a handful of `/__test/*` routes that exist ONLY for this harness —
   never called by production code:
     GET  /__test/lastcode?email=      — the real worker echoes the emailed
                                          code in TEST_MODE; CloudAuth.signIn()
                                          throws that away, so this is the
                                          side-channel the harness reads to
                                          finish a real sign-in without a mailbox.
     POST /__test/expire-share  {token}
     POST /__test/expire-invite {inviteToken}   — force an item into the past
                                          so the calm-404 / expired-upload
                                          paths are actually reachable in a
                                          fresh in-memory server.
     POST /__test/reset                — wipe all state between spec files.

   "Presigned" URLs are plain URLs back to this same server's /__blob/ route
   (`PUT` stores bytes, `GET` returns them) — nothing here is signed because
   nothing here is real; the capability is "know the URL", same as the real
   worker's short-TTL presign, just without the TTL or the AWS SigV4 math. */
'use strict';
const http = require('http');
const crypto = require('crypto');

function randToken(bytes) { return crypto.randomBytes(bytes).toString('base64url'); }
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
async function readJson(req) {
  const b = await readBody(req);
  try { return JSON.parse(b.toString('utf8') || '{}'); } catch (e) { return {}; }
}
function normEmail(e) { return String(e || '').trim().toLowerCase(); }
function sixDigit() { return String(100000 + Math.floor(Math.random() * 900000)); }

function createFakeCloud({ port, appOrigin }) {
  // Kept exactly as passed (including any trailing slash) so callers can
  // assert url === `${APP_URL}#parcel=${token}` without guessing our
  // normalization — this is a fake server, not a URL-hygiene test.
  const APP_URL = String(appOrigin || '');

  // ---- in-memory state (mirrors the Neon tables in cloud/migrations/*.sql) ----
  const accountsByEmail = new Map();   // email -> accountId
  const sessions = new Map();          // token -> { accountId, email }
  const authCodes = new Map();         // email -> { code, expiresAt, attempts }
  const familyOf = new Map();          // accountId -> familyId  (family_member, simplified to one row/account)
  const families = new Map();          // familyId -> { ownerAccountId, createdAt }
  const objects = new Map();           // R2 stand-in: key -> { bytes: Buffer, mime }
  const blobMeta = new Map();          // `${family}:${sha256}` -> { bytes, mime }  (blob_object)
  const backupState = new Map();       // familyId -> { manifestKey, manifestSha256, deviceLabel, pushedAt }
  const shareLinks = new Map();        // token -> { familyId, kind, manifestKey, title, toFamilyId, blobSha256[], createdAt, expiresAt, revokedAt }
  const invites = new Map();           // id -> { familyId, kidName, bookTitle, createdAt, expiresAt, revokedAt }
  const inboxItems = new Map();        // id -> { familyId, inviteId, blobSha256, mime, fromName, note, createdAt, acceptedAt }

  const base = () => `http://localhost:${port}`;
  const blobKey = (fam, sha) => `corners/${fam}/${sha}`;
  const presign = (key) => `${base()}/__blob/${key}`; // capability = knowing the URL; nothing to sign in a fake

  function ensureAccount(email) {
    if (!accountsByEmail.has(email)) accountsByEmail.set(email, crypto.randomUUID());
    return accountsByEmail.get(email);
  }
  function mintSession(accountId, email) {
    const t = randToken(24);
    sessions.set(t, { accountId, email });
    return t;
  }
  function authenticate(req) {
    const h = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return { err: [401, { error: 'missing bearer token' }] };
    const s = sessions.get(m[1]);
    if (!s) return { err: [403, { error: 'invalid token' }] };
    return s;
  }

  const NEEDS_SESSION = new Set(['/family/claim', '/family/mine', '/backup/begin', '/backup/commit', '/backup/latest', '/share', '/invite', '/inbox']);

  const server = http.createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,OPTIONS');
    res.setHeader('access-control-allow-headers', 'authorization,content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    let u;
    try { u = new URL(req.url, base()); } catch (e) { res.writeHead(400); return res.end(); }
    const p = u.pathname, method = req.method;

    try {
      // ---- R2 stand-in: what a presigned URL actually points at ----
      if (p.startsWith('/__blob/')) {
        const key = p.slice('/__blob/'.length);
        if (method === 'PUT') {
          const bytes = await readBody(req);
          objects.set(key, { bytes, mime: req.headers['content-type'] || 'application/octet-stream' });
          res.writeHead(200); return res.end();
        }
        if (method === 'GET') {
          const o = objects.get(key);
          if (!o) { res.writeHead(404); return res.end(); }
          res.writeHead(200, { 'content-type': o.mime }); return res.end(o.bytes);
        }
      }

      // ---- test-only seams (never called by app code) ----
      if (p === '/__test/lastcode' && method === 'GET') {
        const c = authCodes.get(normEmail(u.searchParams.get('email')));
        return json(res, 200, { code: c ? c.code : null });
      }
      if (p === '/__test/expire-share' && method === 'POST') {
        const { token } = await readJson(req);
        const s = shareLinks.get(token);
        if (s) s.expiresAt = Date.now() - 1000;
        return json(res, 200, { ok: true, found: !!s });
      }
      if (p === '/__test/expire-invite' && method === 'POST') {
        const { inviteToken } = await readJson(req);
        const inv = invites.get(inviteToken);
        if (inv) inv.expiresAt = Date.now() - 1000;
        return json(res, 200, { ok: true, found: !!inv });
      }
      if (p === '/__test/reset' && method === 'POST') {
        [accountsByEmail, sessions, authCodes, familyOf, families, objects, blobMeta, backupState, shareLinks, invites, inboxItems].forEach(m => m.clear());
        return json(res, 200, { ok: true });
      }

      if (p === '/health') return json(res, 200, { ok: true, service: 'catherines-corner-cloud-fake', phase: 'e2e' });

      // ---- auth (no session required) ----
      if (p === '/auth/request' && method === 'POST') {
        const body = await readJson(req);
        const email = normEmail(body.email);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'a valid email is required' });
        const code = sixDigit();
        authCodes.set(email, { code, expiresAt: Date.now() + 15 * 60000, attempts: 0 });
        // Fake server = always "test mode": echo the code, same trick the real
        // worker uses when env.TEST_MODE==='1' (see cloud/src/index.js).
        return json(res, 200, { ok: true, code });
      }
      if (p === '/auth/verify' && method === 'POST') {
        const body = await readJson(req);
        if (body.token) {
          // magic-link path — not exercised by the harness today (real email
          // delivery isn't available in tests) but implemented for completeness.
          return json(res, 403, { error: 'this sign-in link is invalid or has expired' });
        }
        const email = normEmail(body.email);
        if (!body.email || !body.code) return json(res, 400, { error: 'email + code (or a link token) required' });
        const row = authCodes.get(email);
        if (!row || row.expiresAt < Date.now()) return json(res, 403, { error: 'that code has expired — request a new one' });
        if (row.attempts >= 5) return json(res, 403, { error: 'too many tries — request a new code' });
        if (String(body.code).replace(/\D/g, '') !== row.code) {
          row.attempts++;
          return json(res, 403, { error: 'that code is not right' });
        }
        authCodes.delete(email);
        const accountId = ensureAccount(email);
        return json(res, 200, { token: mintSession(accountId, email), email });
      }

      // ---- session-gated routes ----
      if (NEEDS_SESSION.has(p) || /^\/inbox\/[^/]+\/accept$/.test(p)) {
        const a = authenticate(req);
        if (a.err) return json(res, a.err[0], a.err[1]);

        if (p === '/family/claim' && method === 'POST') {
          const { familyId } = await readJson(req);
          const fam = String(familyId || '').trim();
          if (!fam) return json(res, 400, { error: 'familyId required' });
          if (!families.has(fam)) {
            families.set(fam, { ownerAccountId: a.accountId, createdAt: Date.now() });
            familyOf.set(a.accountId, fam);
            return json(res, 200, { claimed: fam, role: 'owner' });
          }
          if (familyOf.get(a.accountId) === fam) return json(res, 200, { claimed: fam, role: 'owner' });
          return json(res, 403, { error: 'this Corner is already claimed by another account' });
        }
        if (p === '/family/mine' && method === 'GET') {
          return json(res, 200, { familyId: familyOf.get(a.accountId) || null });
        }

        const fam = familyOf.get(a.accountId) || null;

        if (p === '/backup/begin' && method === 'POST') {
          if (!fam) return json(res, 409, { error: 'no family claimed', hint: 'POST /family/claim { familyId } first' });
          const { blobs } = await readJson(req);
          const uploads = (Array.isArray(blobs) ? blobs : []).filter(b => b.sha256).map(b => ({
            sha256: b.sha256, key: blobKey(fam, b.sha256),
            url: blobMeta.has(`${fam}:${b.sha256}`) ? null : presign(blobKey(fam, b.sha256)),
          }));
          return json(res, 200, { fam, uploads });
        }
        if (p === '/backup/commit' && method === 'POST') {
          if (!fam) return json(res, 409, { error: 'no family claimed' });
          const body = await readJson(req);
          for (const b of (body.blobs || [])) {
            if (!b.sha256) continue;
            blobMeta.set(`${fam}:${b.sha256}`, { bytes: b.bytes || 0, mime: b.mime || null });
          }
          const man = body.manifest || {};
          backupState.set(fam, { manifestKey: man.key || blobKey(fam, 'manifest'), manifestSha256: man.sha256 || null, deviceLabel: body.device_label || null, pushedAt: Date.now() });
          return json(res, 200, { ok: true, stored: (body.blobs || []).length });
        }
        if (p === '/backup/latest' && method === 'GET') {
          if (!fam) return json(res, 409, { error: 'no family claimed' });
          const sha = u.searchParams.get('sha256');
          if (sha) return json(res, 200, { url: presign(blobKey(fam, sha)) });
          const row = backupState.get(fam);
          if (!row) return json(res, 404, { error: 'no backup for family' });
          return json(res, 200, { manifest_key: row.manifestKey, manifest_sha256: row.manifestSha256, pushed_at: row.pushedAt, url: presign(row.manifestKey) });
        }

        if (p === '/share' && method === 'POST') {
          if (!fam) return json(res, 409, { error: 'no family' });
          const body = await readJson(req);
          const token = randToken(16);
          const manifestKey = `shares/${token}.json`;
          objects.set(manifestKey, { bytes: Buffer.from(JSON.stringify(body.manifest || {})), mime: 'application/json' });
          shareLinks.set(token, {
            familyId: fam, kind: 'parcel', manifestKey, title: body.title || null,
            toFamilyId: body.toFamilyId || null, blobSha256: Array.isArray(body.blobSha256) ? body.blobSha256 : [],
            createdAt: Date.now(), expiresAt: Date.now() + 30 * 86400000, revokedAt: null,
          });
          return json(res, 200, { token, url: `${APP_URL}#parcel=${token}` });
        }

        if (p === '/invite' && method === 'POST') {
          if (!fam) return json(res, 409, { error: 'no family' });
          const body = await readJson(req);
          const id = crypto.randomUUID();
          const days = Number.isFinite(body.expiresDays) ? body.expiresDays : 30;
          invites.set(id, {
            familyId: fam, kidName: body.kidName || null, bookTitle: body.bookTitle || null,
            createdAt: Date.now(), expiresAt: Date.now() + days * 86400000, revokedAt: null,
          });
          return json(res, 200, { inviteToken: id, url: `${APP_URL}#give=${id}` });
        }

        if (p === '/inbox' && method === 'GET') {
          if (!fam) return json(res, 409, { error: 'no family' });
          const items = [...inboxItems.entries()]
            .filter(([, it]) => it.familyId === fam && !it.acceptedAt)
            .map(([id, it]) => ({
              id, fromName: it.fromName, note: it.note, blobSha256: it.blobSha256, mime: it.mime,
              createdAt: it.createdAt, blobUrl: presign(blobKey(fam, it.blobSha256)),
            }));
          return json(res, 200, { items });
        }

        const acceptMatch = /^\/inbox\/([^/]+)\/accept$/.exec(p);
        if (acceptMatch && method === 'POST') {
          const it = inboxItems.get(acceptMatch[1]);
          // Isolation (contract invariant #4): a family can only see/accept its
          // OWN inbox rows — unknown id AND cross-family id both read as 404,
          // never leaking whether the row exists for someone else.
          if (!it || it.familyId !== fam) return json(res, 404, { error: 'not found' });
          it.acceptedAt = Date.now();
          return json(res, 200, { ok: true });
        }
      }

      // ---- share redemption: NO auth, the token IS the capability ----
      const shareMatch = /^\/share\/([^/]+)$/.exec(p);
      if (shareMatch && method === 'GET') {
        const s = shareLinks.get(shareMatch[1]);
        if (!s || s.revokedAt || (s.expiresAt && s.expiresAt < Date.now())) return json(res, 404, { error: 'not found' });
        const manObj = objects.get(s.manifestKey);
        const manifest = manObj ? JSON.parse(manObj.bytes.toString('utf8')) : null;
        const blobs = s.blobSha256.map(sha => ({ sha256: sha, url: presign(blobKey(s.familyId, sha)) }));
        return json(res, 200, { manifest, blobs, title: s.title, toFamilyId: s.toFamilyId });
      }

      // ---- invite-token auth (guest upload/commit — NOT a session JWT) ----
      const uploadMatch = /^\/inbox\/([^/]+)\/upload$/.exec(p);
      if (uploadMatch && method === 'POST') {
        const inv = invites.get(uploadMatch[1]);
        if (!inv) return json(res, 404, { error: 'this invitation could not be found' });
        if (inv.revokedAt) return json(res, 410, { error: 'this invitation was cancelled' });
        if (inv.expiresAt && inv.expiresAt < Date.now()) return json(res, 410, { error: 'this invitation has expired' });
        const { blobs } = await readJson(req);
        const uploads = (Array.isArray(blobs) ? blobs : []).filter(b => b.sha256)
          .map(b => ({ sha256: b.sha256, url: presign(blobKey(inv.familyId, b.sha256)) }));
        return json(res, 200, { uploads });
      }
      const commitMatch = /^\/inbox\/([^/]+)\/commit$/.exec(p);
      if (commitMatch && method === 'POST') {
        const inv = invites.get(commitMatch[1]);
        if (!inv) return json(res, 404, { error: 'this invitation could not be found' });
        if (inv.revokedAt) return json(res, 410, { error: 'this invitation was cancelled' });
        if (inv.expiresAt && inv.expiresAt < Date.now()) return json(res, 410, { error: 'this invitation has expired' });
        const body = await readJson(req);
        const sha = Array.isArray(body.blobSha256) ? body.blobSha256[0] : body.blobSha256;
        if (!sha) return json(res, 400, { error: 'blobSha256 required' });
        const id = crypto.randomUUID();
        inboxItems.set(id, {
          familyId: inv.familyId, inviteId: commitMatch[1], blobSha256: sha, mime: body.mime || null,
          fromName: body.fromName || null, note: body.note || null, createdAt: Date.now(), acceptedAt: null,
        });
        return json(res, 200, { ok: true, id });
      }

      return json(res, 404, { error: 'unknown route' });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  });

  return {
    url: base(),
    listen: () => new Promise((resolve) => server.listen(port, resolve)),
    close: () => new Promise((resolve) => server.close(resolve)),
    // exposed for specs that want to peek at state without a fresh HTTP round trip
    _state: { accountsByEmail, sessions, familyOf, families, objects, blobMeta, backupState, shareLinks, invites, inboxItems },
  };
}

module.exports = { createFakeCloud };
