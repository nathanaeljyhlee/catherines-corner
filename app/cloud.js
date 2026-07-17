/* Catherine's Corner — cloud.js: the ONLY module that speaks to the network.
   The narrow storage port from ADR-0001. Everything cloud lives here; nothing
   else in the app knows the vendor, so swapping R2/Neon later is a re-write of
   this one file.

   What syncs up is the SAME manifest the zip backup already uses (content-
   addressed blobs + manifest.json), so the cloud is "a backup that syncs" and a
   family can always fall back to the zip they know. Backups are scoped to the
   signed-in family on the server (Neon Auth), never to the semi-public Corner ID.

   Auth is injected: window.CloudAuth.token() returns the current bearer (Neon
   Auth JWT in the app; a test token in the harness). Uses globalThis so the
   same code runs in the browser and under Node for the round-trip test. */
(function () {
  'use strict';
  const g = globalThis;
  const API = g.CC_CLOUD_API || 'https://catherines-corner-cloud.snowbear-llc.workers.dev';

  async function sha256Hex(blob) {
    const buf = blob.arrayBuffer ? await blob.arrayBuffer() : blob;
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function authHeaders(extra) {
    const t = g.CloudAuth && g.CloudAuth.token && g.CloudAuth.token();
    return { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}), ...extra };
  }
  async function api(path, opts) {
    const r = await fetch(API + path, { ...opts, headers: authHeaders(opts && opts.headers) });
    if (!r.ok) throw new Error('cloud ' + path + ' -> ' + r.status + ' ' + (await r.text().catch(() => '')));
    return r.status === 204 ? null : r.json();
  }

  // Bind this signed-in account to its Corner ID on the server (first-claim-wins).
  async function claim() {
    const familyId = await g.DB.familyId();
    return api('/family/claim', { method: 'POST', body: JSON.stringify({ familyId }) });
  }

  // Make this device speak for the SIGNED-IN ACCOUNT's family, not its own local
  // Corner ID. If the account already has a family (backed up from another
  // device), adopt it so this device shares that library; otherwise this is the
  // first device, so claim its Corner ID as the family. Returns the family id.
  async function ensureIdentity() {
    const mine = await api('/family/mine', {});
    const local = await g.DB.familyId();
    if (mine && mine.familyId) {
      if (mine.familyId !== local && g.DB.settings) await g.DB.settings.set('familyId', mine.familyId);
      return mine.familyId;
    }
    await api('/family/claim', { method: 'POST', body: JSON.stringify({ familyId: local }) });
    return local;
  }

  // Enumerate the corner into { manifest (with _blobShas), blobs: Map<sha,{blob,mime}> }.
  // Reuses Backup.packAll's exact walk; content-hashes each file so uploads dedup.
  async function enumerate() {
    const { manifest, files } = await g.Backup.packAll();
    const blobs = new Map();
    const blobShas = {};
    for (const f of files) {
      const blob = f.blob || new Blob([f.bytes]);
      const sha = await sha256Hex(blob);
      blobs.set(sha, { blob, mime: blob.type || 'application/octet-stream' });
      blobShas[f.name] = sha;
    }
    manifest._blobShas = blobShas;   // filename -> sha, so restore can rebuild the map
    return { manifest, blobs };
  }

  // Back the whole corner up to the cloud. Uploads only blobs the cloud lacks
  // (dedup), so a second backup with no new recordings uploads ~0 bytes.
  async function pushBackup(deviceLabel) {
    const familyId = await ensureIdentity();
    // Reconcile first: fold in whatever the cloud already holds for this family
    // — another device's readings, or this account's pre-cloud library arriving
    // on a second device — so the manifest we write is the UNION and no
    // recordings drop out of the cloud index. importBackup only ever merges.
    try { await pullBackup(); } catch (e) { if (!/\b404\b|no backup/i.test(e.message)) throw e; }
    const { manifest, blobs } = await enumerate();
    const manifestBlob = new Blob([JSON.stringify(manifest)], { type: 'application/json' });
    const manSha = await sha256Hex(manifestBlob);

    const all = [...blobs.entries()].map(([sha, v]) => ({ sha256: sha, bytes: v.blob.size, mime: v.mime }));
    all.push({ sha256: manSha, bytes: manifestBlob.size, mime: 'application/json' });

    const { uploads } = await api('/backup/begin', { method: 'POST', body: JSON.stringify({ blobs: all }) });
    const blobFor = (sha) => (sha === manSha ? manifestBlob : blobs.get(sha) && blobs.get(sha).blob);
    let uploaded = 0, bytes = 0;
    for (const u of uploads) {
      if (!u.url) continue;                 // already in the cloud
      const b = blobFor(u.sha256);
      const r = await fetch(u.url, { method: 'PUT', body: b });
      if (!r.ok) throw new Error('blob upload ' + u.sha256 + ' -> ' + r.status);
      uploaded++; bytes += b.size;
    }
    await api('/backup/commit', {
      method: 'POST',
      body: JSON.stringify({ blobs: all, manifest: { key: 'corners/' + familyId + '/' + manSha, sha256: manSha }, device_label: deviceLabel || null }),
    });
    if (g.DB.settings) await g.DB.settings.set('cloudLastBackup', Date.now());
    return { uploaded, skipped: uploads.length - uploaded, bytes, total: all.length };
  }

  // Pull the latest cloud backup and restore it through the SAME merge path the
  // zip restore uses (Backup.importBackup): corners merge by name, ids collision-
  // safe. Safe to run on a fresh device.
  async function pullBackup() {
    await ensureIdentity();
    const latest = await api('/backup/latest', {});
    const manifest = await (await fetch(latest.url)).json();
    const map = new Map();
    for (const [file, sha] of Object.entries(manifest._blobShas || {})) {
      const { url } = await api('/backup/latest?sha256=' + encodeURIComponent(sha), {});
      map.set(file, new Uint8Array(await (await fetch(url)).arrayBuffer()));
    }
    map.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
    return g.Backup.importBackup(manifest, map);
  }

  // Quiet, idempotent auto-backup: run right after sign-in (so a pre-cloud
  // library uploads itself, no second tap) and on app open when stale. Safe to
  // call anytime — it dedups, and it stays silent when offline or not signed in.
  async function autoBackup(reason) {
    try {
      if (!(g.CloudAuth && g.CloudAuth.isSignedIn())) return null;
      const readings = g.DB && g.DB.readings ? await g.DB.readings.all() : [];
      if (!readings.length) return null;
      return await pushBackup(reason || 'auto');
    } catch (e) { return null; }   // offline / transient — a quiet retry next time
  }

  // =========================================================
  // PHASE 3 — share links (a parcel that travels as a URL, not a file)
  // =========================================================
  // Push a parcel (manifest + its files, from Backup.packParcel) to the cloud
  // and mint a share token. Blobs upload content-addressed through the SAME
  // /backup/begin dedup path a backup uses — a reading already backed up rides
  // up as ~0 bytes. Then /share records the manifest and returns a #parcel= link.
  //
  // NOTE (contract deviation, flagged): the contract sketches
  // `pushParcel(manifest, blobs)` with pre-hashed blobs. We take `files`
  // ({name, blob}) instead and hash HERE, so the filename→sha map (`_blobShas`,
  // exactly what backups use) is built in one place and the receiver can rebuild
  // filename→Blob. The HTTP shapes to /backup/begin and /share are unchanged.
  async function pushParcel(manifest, files) {
    await ensureIdentity();                          // first cloud touch claims the family (avoids the 409)
    const blobShas = {};
    const entries = [];
    for (const f of files) {
      const blob = f.blob || new Blob([f.bytes], { type: f.mime || 'application/octet-stream' });
      const sha = await sha256Hex(blob);
      blobShas[f.name] = sha;                        // filename -> sha, so the receiver rebuilds the map
      entries.push({ sha256: sha, blob, bytes: blob.size, mime: blob.type || 'application/octet-stream' });
    }
    manifest._blobShas = blobShas;                   // rides inside the manifest JSON the server stores verbatim
    const begin = await api('/backup/begin', {
      method: 'POST',
      body: JSON.stringify({ blobs: entries.map((e) => ({ sha256: e.sha256, bytes: e.bytes, mime: e.mime })) }),
    });
    const blobFor = new Map(entries.map((e) => [e.sha256, e.blob]));
    for (const u of (begin.uploads || [])) {
      if (!u.url) continue;                          // already in the cloud (dedup)
      const r = await fetch(u.url, { method: 'PUT', body: blobFor.get(u.sha256) });
      if (!r.ok) throw new Error('parcel blob upload ' + u.sha256 + ' -> ' + r.status);
    }
    const title = manifest.book ? manifest.book.title
      : ((manifest.readings && manifest.readings[0] && manifest.readings[0].title) || 'A reading');
    return api('/share', {
      method: 'POST',
      body: JSON.stringify({ manifest, blobSha256: entries.map((e) => e.sha256), title, toFamilyId: manifest.to || null }),
    });                                              // { token, url }
  }

  // Pull a shared parcel by token and shape it EXACTLY as Backup.importParcel
  // wants: { manifest, map } where map is filename -> bytes. No auth needed — the
  // token is the capability. A 404 (expired/garbage) bubbles up as an Error with
  // "404" in it, for a calm message at the call site.
  async function pullParcel(token) {
    const res = await api('/share/' + encodeURIComponent(token), { method: 'GET' });
    const manifest = res.manifest || {};
    const bySha = new Map((res.blobs || []).map((b) => [b.sha256, b.url]));
    const map = new Map();
    for (const [name, sha] of Object.entries(manifest._blobShas || {})) {
      const url = bySha.get(sha);
      if (!url) continue;
      map.set(name, new Uint8Array(await (await fetch(url)).arrayBuffer()));
    }
    return { manifest, map };
  }

  // =========================================================
  // PHASE 4 — invite uploads / inbox ("record at will → put it on the shelf")
  // =========================================================
  // Parent side: mint an invite link a loved one records into.
  async function createInvite(opts) {
    opts = opts || {};
    await ensureIdentity();                          // first cloud touch claims the family (avoids the 409), same as pushParcel
    return api('/invite', {
      method: 'POST',
      body: JSON.stringify({ kidName: opts.kidName || null, bookTitle: opts.bookTitle || null, expiresDays: opts.expiresDays || 30 }),
    });                                              // { inviteToken, url }
  }

  // Parent side: what's waiting to be tucked in. Quiet by design at the call site.
  async function checkInbox() {
    return api('/inbox', {});                        // { items: [{id, fromName, note, blobSha256, mime, createdAt, blobUrl}] }
  }

  // Parent side: fetch the audio behind an inbox item (presigned GET). Lives here
  // so no other module ever touches the network.
  async function fetchArrivalBlob(item) {
    const r = await fetch(item.blobUrl);
    if (!r.ok) throw new Error('arrival download -> ' + r.status);
    return new Blob([await r.arrayBuffer()], { type: item.mime || 'audio/mp4' });
  }

  // Parent side: mark an item received (it leaves the inbox).
  async function acceptInbox(id) {
    return api('/inbox/' + encodeURIComponent(id) + '/accept', { method: 'POST', body: '{}' });
  }

  // Guest side (no session — the invite token in the path is the capability):
  // presign, then PUT the bytes with FOREGROUND progress (XHR, since fetch has no
  // upload-progress event). Returns the sha for the commit. Single PUT — the audio
  // sizes don't need resumable multipart.
  async function inboxUpload(token, blob, onProgress) {
    const sha = await sha256Hex(blob);
    const mime = blob.type || 'audio/mp4';
    const begin = await api('/inbox/' + encodeURIComponent(token) + '/upload', {
      method: 'POST', body: JSON.stringify({ blobs: [{ sha256: sha, bytes: blob.size, mime }] }),
    });
    const up = (begin.uploads || []).find((u) => u.sha256 === sha) || (begin.uploads || [])[0];
    if (up && up.url) await putWithProgress(up.url, blob, onProgress);
    else if (onProgress) onProgress(1);              // already present (dedup) — nothing to send
    return { sha256: sha, mime };
  }

  // Guest side: record the reading against the invite so it appears in the inbox.
  async function inboxCommit(token, meta) {
    return api('/inbox/' + encodeURIComponent(token) + '/commit', {
      method: 'POST',
      body: JSON.stringify({
        blobSha256: meta.blobSha256, mime: meta.mime,
        fromName: meta.fromName || null, note: meta.note || null, readingMeta: meta.readingMeta || null,
      }),
    });                                              // { ok, id }
  }

  // Presigned PUT with progress. No content-type header — the existing backup
  // upload PUTs raw too, so the header set isn't part of the R2 signature.
  function putWithProgress(url, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      if (xhr.upload && onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error('upload -> ' + xhr.status));
      xhr.onerror = () => reject(new Error('The upload didn’t go through — check the connection and try again.'));
      xhr.send(blob);
    });
  }

  g.Cloud = {
    pushBackup, pullBackup, autoBackup, claim, sha256Hex, enumerate, API,
    pushParcel, pullParcel,
    createInvite, checkInbox, fetchArrivalBlob, acceptInbox, inboxUpload, inboxCommit,
  };
})();
