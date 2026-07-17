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
    await claim();
    const familyId = await g.DB.familyId();
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
    await claim();
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

  g.Cloud = { pushBackup, pullBackup, claim, sha256Hex, enumerate, API };
})();
