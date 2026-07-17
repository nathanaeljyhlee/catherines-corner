/* Catherine's Corner E2E — fake cloud server (Stage 2, Phase 3 + Phase 4 + v1.15).
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

   v1.15 additions (snowbear-hq/sprints/2026-07-17/1406/CONTRACT.md):
     GET  /shares                        POST /share/{token}/revoke
     POST /inbox/{token}/upload/init     POST /inbox/{token}/upload/complete
     POST /inbox/{token}/upload/abort    (invite-token auth, in-memory multipart)
     POST /family/invite                 POST /family/join
     GET  /family/requests               POST /family/members/{accountId}/approve
     POST /family/members/{accountId}/decline
   PLUS the cross-cutting invariant: every family-scoped route requires an
   ACTIVE family_member row. A `pending` co-parent must see NOTHING — no
   /inbox items, no /backup/latest, no /shares, nothing scoped to the family
   — until an owner approves them. `familyOf` (one row per account) from
   v1.14 is replaced with `familyMembers` (keyed by family+account, carrying
   a status) so pending vs. active is representable at all.

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
     POST /__test/fail-part-once {uploadId, partNumber}
                                        — make the NEXT PUT to that multipart
                                          part fail with 500 (one-shot), so a
                                          dropped-part-then-retry can be
                                          reproduced deterministically.
     POST /__test/reset                — wipe all state between spec files.

   "Presigned" URLs are plain URLs back to this same server's /__blob/ (whole
   object) or /__mpu/ (multipart part) routes (`PUT` stores bytes, `GET`
   returns them) — nothing here is signed because nothing here is real; the
   capability is "know the URL", same as the real worker's short-TTL presign,
   just without the TTL or the AWS SigV4 math. */
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
  // family_member, one row per (familyId, accountId), carrying a status —
  // this is what makes "pending" representable (v1.14's familyOf could only
  // ever hold one active-looking row per account).
  const familyMembers = new Map();     // `${familyId}:${accountId}` -> { familyId, accountId, role, status, createdAt }
  const families = new Map();          // familyId -> { ownerAccountId, createdAt }
  const familyInvites = new Map();     // token -> { familyId, createdBy, createdAt, expiresAt, usedAt }
  const objects = new Map();           // R2 stand-in: key -> { bytes: Buffer, mime }
  const blobMeta = new Map();          // `${family}:${sha256}` -> { bytes, mime }  (blob_object)
  const backupState = new Map();       // familyId -> { manifestKey, manifestSha256, deviceLabel, pushedAt }
  const shareLinks = new Map();        // token -> { familyId, kind, manifestKey, title, toFamilyId, blobSha256[], createdAt, expiresAt, revokedAt }
  const invites = new Map();           // id -> { familyId, kidName, bookTitle, createdAt, expiresAt, revokedAt }
  const inboxItems = new Map();        // id -> { familyId, inviteId, blobSha256, mime, fromName, note, createdAt, acceptedAt }
  const multipartUploads = new Map();  // uploadId -> { familyId, key, sha256, mime, expectedParts, parts: Map<partNumber,{bytes,etag}>, createdAt }
  const failOnce = new Set();          // `${uploadId}:${partNumber}` — one-shot part-PUT failure injection

  const base = () => `http://localhost:${port}`;
  const blobKey = (fam, sha) => `corners/${fam}/${sha}`;
  const presign = (key) => `${base()}/__blob/${key}`; // capability = knowing the URL; nothing to sign in a fake

  function ensureAccount(email) {
    if (!accountsByEmail.has(email)) accountsByEmail.set(email, crypto.randomUUID());
    return accountsByEmail.get(email);
  }
  function emailOf(accountId) {
    for (const [email, id] of accountsByEmail.entries()) if (id === accountId) return email;
    return null;
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

  // ---- membership helpers (the active-only gate lives here) ----
  const memberKey = (familyId, accountId) => `${familyId}:${accountId}`;
  // resolveFamily(sql, a) equivalent: ACTIVE membership only. A pending row
  // is invisible to every family-scoped route that calls this.
  function activeFamilyOf(accountId) {
    let best = null;
    for (const m of familyMembers.values()) {
      if (m.accountId === accountId && m.status === 'active' && (!best || m.createdAt < best.createdAt)) best = m;
    }
    return best ? best.familyId : null;
  }
  function pendingFamilyOf(accountId) {
    let best = null;
    for (const m of familyMembers.values()) {
      if (m.accountId === accountId && m.status === 'pending' && (!best || m.createdAt < best.createdAt)) best = m;
    }
    return best ? best.familyId : null;
  }
  function ownerFamilyOf(accountId) {
    for (const [fid, f] of families.entries()) if (f.ownerAccountId === accountId) return fid;
    return null;
  }

  const NEEDS_SESSION = new Set([
    '/family/claim', '/family/mine', '/family/invite', '/family/join', '/family/requests',
    '/backup/begin', '/backup/commit', '/backup/latest',
    '/share', '/shares', '/invite', '/inbox',
  ]);
  const DYNAMIC_SESSION_ROUTES = [
    /^\/inbox\/[^/]+\/accept$/,
    /^\/share\/[^/]+\/revoke$/,
    /^\/family\/members\/[^/]+\/(approve|decline)$/,
  ];
  function isSessionRoute(p) {
    return NEEDS_SESSION.has(p) || DYNAMIC_SESSION_ROUTES.some((re) => re.test(p));
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'authorization,content-type');
    // Real multipart uploads need the browser to be able to READ the ETag
    // response header off the PUT (that's how the client captures it for
    // /upload/complete) — S3/R2 requires ExposeHeaders:["ETag"] in bucket
    // CORS for this to work from a browser. Flagging this here because it's
    // a genuinely easy-to-miss cross-cutting requirement for the REAL R2
    // bucket config (not e2e's to fix, but e2e is where it'll silently bite
    // if missed — see report).
    res.setHeader('access-control-expose-headers', 'etag');
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

      // ---- multipart part stand-in: PUT stores ONE part, keyed by
      //      (uploadId, partNumber), separate from the assembled object so a
      //      dropped/re-PUT part can't corrupt bytes already accepted for
      //      other parts. Real S3/R2 semantics: last PUT to a given part
      //      number wins, and PutPart returns an ETag the client must carry
      //      into CompleteMultipartUpload. ----
      if (p.startsWith('/__mpu/')) {
        const segs = p.split('/'); // ['', '__mpu', uploadId, partNumber]
        const uploadId = segs[2], partNumber = Number(segs[3]);
        if (method === 'PUT') {
          const failKey = `${uploadId}:${partNumber}`;
          if (failOnce.has(failKey)) {
            failOnce.delete(failKey); // one-shot
            res.writeHead(500); return res.end('simulated dropped part');
          }
          const mpu = multipartUploads.get(uploadId);
          if (!mpu) { res.writeHead(404); return res.end(); }
          const bytes = await readBody(req);
          const etag = '"' + crypto.createHash('md5').update(bytes).digest('hex') + '"';
          mpu.parts.set(partNumber, { bytes, etag });
          res.writeHead(200, { etag }); return res.end();
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
      if (p === '/__test/fail-part-once' && method === 'POST') {
        const { uploadId, partNumber } = await readJson(req);
        failOnce.add(`${uploadId}:${partNumber}`);
        return json(res, 200, { ok: true });
      }
      if (p === '/__test/reset' && method === 'POST') {
        [accountsByEmail, sessions, authCodes, familyMembers, families, familyInvites,
          objects, blobMeta, backupState, shareLinks, invites, inboxItems,
          multipartUploads, failOnce].forEach(m => m.clear());
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
      if (isSessionRoute(p)) {
        const a = authenticate(req);
        if (a.err) return json(res, a.err[0], a.err[1]);

        if (p === '/family/claim' && method === 'POST') {
          const { familyId } = await readJson(req);
          const fam = String(familyId || '').trim();
          if (!fam) return json(res, 400, { error: 'familyId required' });
          if (!families.has(fam)) {
            families.set(fam, { ownerAccountId: a.accountId, createdAt: Date.now() });
            familyMembers.set(memberKey(fam, a.accountId), { familyId: fam, accountId: a.accountId, role: 'owner', status: 'active', createdAt: Date.now() });
            return json(res, 200, { claimed: fam, role: 'owner' });
          }
          if (activeFamilyOf(a.accountId) === fam) {
            const m = familyMembers.get(memberKey(fam, a.accountId));
            return json(res, 200, { claimed: fam, role: m ? m.role : 'owner' });
          }
          return json(res, 403, { error: 'this Corner is already claimed by another account' });
        }
        if (p === '/family/mine' && method === 'GET') {
          return json(res, 200, { familyId: activeFamilyOf(a.accountId), pendingFamilyId: pendingFamilyOf(a.accountId) });
        }

        // ---- v1.15 Feature 3: co-parent invite / join / requests / approve / decline ----
        if (p === '/family/invite' && method === 'POST') {
          const fid = ownerFamilyOf(a.accountId);
          if (!fid) return json(res, 403, { error: 'only the owner can invite' });
          const token = randToken(16);
          familyInvites.set(token, { familyId: fid, createdBy: a.accountId, createdAt: Date.now(), expiresAt: Date.now() + 14 * 86400000, usedAt: null });
          return json(res, 200, { joinToken: token, url: `${APP_URL}#join=${token}` });
        }
        if (p === '/family/join' && method === 'POST') {
          const { token } = await readJson(req);
          const inv = familyInvites.get(token);
          if (!inv) return json(res, 404, { error: 'not found' });
          if (inv.usedAt) return json(res, 410, { error: 'this invite has already been used' });
          if (inv.expiresAt < Date.now()) return json(res, 410, { error: 'this invite has expired' });
          const already = activeFamilyOf(a.accountId);
          if (already) return json(res, 409, { error: 'you already have a corner', hint: 'co-parent join is for an account without its own corner' });
          const key = memberKey(inv.familyId, a.accountId);
          if (!familyMembers.has(key)) {
            familyMembers.set(key, { familyId: inv.familyId, accountId: a.accountId, role: 'member', status: 'pending', createdAt: Date.now() });
          } // else idempotent: leave existing status untouched (ON CONFLICT DO UPDATE SET status = family_member.status)
          inv.usedAt = Date.now();
          const m = familyMembers.get(key);
          return json(res, 200, { status: m.status, familyId: inv.familyId });
        }
        if (p === '/family/requests' && method === 'GET') {
          const fid = ownerFamilyOf(a.accountId);
          if (!fid) return json(res, 403, { error: 'only the owner can view requests' });
          const requests = [...familyMembers.values()]
            .filter((m) => m.familyId === fid && m.status === 'pending')
            .sort((x, y) => x.createdAt - y.createdAt)
            .map((m) => ({ accountId: m.accountId, email: emailOf(m.accountId), requestedAt: m.createdAt }));
          return json(res, 200, { requests });
        }
        const famMemberMatch = /^\/family\/members\/([^/]+)\/(approve|decline)$/.exec(p);
        if (famMemberMatch && method === 'POST') {
          const targetAccountId = famMemberMatch[1], action = famMemberMatch[2];
          const fid = ownerFamilyOf(a.accountId);
          if (!fid) return json(res, 403, { error: `only the owner can ${action} a request` });
          const key = memberKey(fid, targetAccountId);
          const m = familyMembers.get(key);
          if (!m || m.status !== 'pending') return json(res, 404, { error: 'not found' });
          if (action === 'approve') { m.status = 'active'; return json(res, 200, { ok: true }); }
          familyMembers.delete(key); // decline
          return json(res, 200, { ok: true });
        }

        const fam = activeFamilyOf(a.accountId);

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
        // v1.15 Feature 1: list + revoke this family's own share links.
        if (p === '/shares' && method === 'GET') {
          if (!fam) return json(res, 409, { error: 'no family' });
          const shares = [...shareLinks.entries()]
            .filter(([, s]) => s.familyId === fam && !s.revokedAt && s.expiresAt > Date.now())
            .sort((x, y) => y[1].createdAt - x[1].createdAt)
            .map(([token, s]) => ({ token, title: s.title, url: `${APP_URL}#parcel=${token}`, createdAt: s.createdAt, expiresAt: s.expiresAt }));
          return json(res, 200, { shares });
        }
        const revokeMatch = /^\/share\/([^/]+)\/revoke$/.exec(p);
        if (revokeMatch && method === 'POST') {
          const token = revokeMatch[1];
          const s = shareLinks.get(token);
          if (!s || s.revokedAt) return json(res, 404, { error: 'not found' });
          if (s.familyId !== fam) return json(res, 403, { error: 'not your link' });
          s.revokedAt = Date.now();
          return json(res, 200, { ok: true });
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
          // never leaking whether the row exists for someone else. A pending
          // member has fam===null here, so it 404s the same way (falls out of
          // `it.familyId !== fam` naturally — no special-casing needed).
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

      // ---- v1.15 Feature 2: resumable multipart guest upload (invite-token auth) ----
      const mpuMatch = /^\/inbox\/([^/]+)\/upload\/(init|complete|abort)$/.exec(p);
      if (mpuMatch && method === 'POST') {
        const inv = invites.get(mpuMatch[1]);
        if (!inv) return json(res, 404, { error: 'this invitation could not be found' });
        if (inv.revokedAt) return json(res, 410, { error: 'this invitation was cancelled' });
        if (inv.expiresAt && inv.expiresAt < Date.now()) return json(res, 410, { error: 'this invitation has expired' });
        const action = mpuMatch[2];
        const body = await readJson(req);

        if (action === 'init') {
          const { sha256, mime, parts } = body;
          if (!sha256 || !Number.isInteger(parts) || parts < 1) return json(res, 400, { error: 'sha256 + parts (int count) required' });
          const uploadId = randToken(12);
          const key = blobKey(inv.familyId, sha256);
          multipartUploads.set(uploadId, { familyId: inv.familyId, key, sha256, mime: mime || null, expectedParts: parts, parts: new Map(), createdAt: Date.now() });
          const partList = [];
          for (let n = 1; n <= parts; n++) partList.push({ partNumber: n, url: `${base()}/__mpu/${uploadId}/${n}` });
          return json(res, 200, { uploadId, key, parts: partList });
        }

        if (action === 'complete') {
          const { sha256, uploadId, parts } = body;
          const mpu = multipartUploads.get(uploadId);
          if (!mpu || mpu.sha256 !== sha256) return json(res, 404, { error: 'upload not found' });
          if (!Array.isArray(parts) || parts.length !== mpu.expectedParts) return json(res, 400, { error: 'all parts required to complete' });
          const ordered = [...parts].sort((x, y) => x.partNumber - y.partNumber);
          const chunks = [];
          for (const part of ordered) {
            const stored = mpu.parts.get(part.partNumber);
            if (!stored) return json(res, 409, { error: `part ${part.partNumber} was never uploaded` });
            if (stored.etag !== part.etag) return json(res, 409, { error: `part ${part.partNumber} etag mismatch — re-upload it` });
            chunks.push(stored.bytes);
          }
          const full = Buffer.concat(chunks);
          objects.set(mpu.key, { bytes: full, mime: mpu.mime || 'application/octet-stream' });
          multipartUploads.delete(uploadId);
          return json(res, 200, { ok: true });
        }

        // abort
        const { uploadId } = body;
        multipartUploads.delete(uploadId);
        return json(res, 200, { ok: true });
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
    _state: { accountsByEmail, sessions, familyMembers, families, familyInvites, objects, blobMeta, backupState, shareLinks, invites, inboxItems, multipartUploads },
  };
}

module.exports = { createFakeCloud };
