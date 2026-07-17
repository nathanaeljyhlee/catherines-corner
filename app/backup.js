/* Catherine's Corner — full backup & restore.
   One plain .zip: manifest.json + every audio file + every image, uncompressed (STORE),
   so a family can open it with any zip tool in twenty years — no app required.
   Restore merges by id, so re-importing on the same device never duplicates or destroys.
   Format v2 adds corners (one shelf per child) and per-book page format; v1
   backups still restore — their rows are filed under a corner made from the
   manifest's cornerName.

   PARCELS share the same zip container: one book (or one told story) with its
   readings, packed by one family and addressed to another family's Corner ID.
   The receiving app inspects the parcel, shows what's inside and who it was
   addressed to, then tucks it onto the ACTIVE corner's shelf — readers merge
   by name, ids are collision-safe, and re-accepting the same parcel is a
   no-op. Person-to-person sharing with no server: the file travels however
   the family already talks. */

(function () {
  'use strict';

  // ---------- CRC32 ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---------- zip writer (STORE only) ----------
  // Entries carry {bytes} or {blob}: a blob is read once for its checksum,
  // then the BLOB ITSELF goes into the output (the browser assembles blob
  // parts by reference) — so packing a big book never holds two copies of
  // every photo and recording in memory. That headroom is what lets a whole
  // parcel pack on a phone.
  async function makeZip(entries) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
    for (const e of entries) {
      const name = enc.encode(e.name);
      const bytes = e.bytes || new Uint8Array(await e.blob.arrayBuffer());
      const crc = crc32(bytes), size = bytes.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);       // version needed
      lh.setUint16(6, 0x0800, true);   // UTF-8 names
      lh.setUint16(8, 0, true);        // method: STORE
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true);
      lh.setUint32(22, size, true);
      lh.setUint16(26, name.length, true);
      lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, e.blob || bytes);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, size, true);
      ch.setUint32(24, size, true);
      ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + size;
    }
    let cdSize = 0;
    for (const c of central) cdSize += c.length;
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, entries.length, true);
    eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)], { type: 'application/zip' });
  }

  // ---------- zip reader ----------
  // The app WRITES only STORE zips, but must READ whatever a parcel became on
  // its journey: iOS Files extracts a tapped zip, and re-compressing that
  // folder yields a DEFLATE zip with a wrapping folder and __MACOSX junk.
  // Refusing those is refusing a real family's parcel — so DEFLATE entries
  // are inflated through the browser's built-in DecompressionStream.
  async function inflateRaw(raw) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This zip is compressed in a way this phone can’t unpack — ask for the original parcel file, or update this device’s browser.');
    }
    const out = new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw')));
    return new Uint8Array(await out.arrayBuffer());
  }
  async function parseZip(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    let e = buf.byteLength - 22;
    while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('That file isn’t a zip archive.');
    const count = dv.getUint16(e + 10, true);
    let p = dv.getUint32(e + 16, true);
    const dec = new TextDecoder(), out = new Map();
    for (let i = 0; i < count; i++) {
      const rec = p;
      if (dv.getUint32(rec, true) !== 0x02014b50) throw new Error('The zip file looks damaged.');
      const method = dv.getUint16(rec + 10, true);
      const csize = dv.getUint32(rec + 20, true);
      const size = dv.getUint32(rec + 24, true);
      const nLen = dv.getUint16(rec + 28, true), xLen = dv.getUint16(rec + 30, true), cLen = dv.getUint16(rec + 32, true);
      const lho = dv.getUint32(rec + 42, true);
      const name = dec.decode(u8.subarray(rec + 46, rec + 46 + nLen));
      p = rec + 46 + nLen + xLen + cLen;
      if (name.endsWith('/')) continue;   // folder entries carry no data
      if (method !== 0 && method !== 8) throw new Error('This zip uses compression this app can’t read.');
      const lnLen = dv.getUint16(lho + 26, true), lxLen = dv.getUint16(lho + 28, true);
      const dataStart = lho + 30 + lnLen + lxLen;
      const raw = u8.subarray(dataStart, dataStart + (method === 0 ? size : csize));
      const bytes = method === 0 ? raw : await inflateRaw(raw);
      if (method !== 0 && bytes.length !== size) {
        throw new Error('This backup file is damaged (“' + name + '” doesn’t unpack whole) — nothing was changed. Try another copy.');
      }
      // Families keep these zips for years — verify every checksum, so a
      // bit-rotted or truncated backup is refused whole instead of restoring
      // silently corrupted voices.
      if (crc32(bytes) !== dv.getUint32(rec + 16, true)) {
        throw new Error('This backup file is damaged (“' + name + '” fails its checksum) — nothing was changed. Try another copy of the backup.');
      }
      out.set(name, bytes);
    }
    return out;
  }

  // ---------- mime ↔ extension ----------
  const EXT = {
    'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'aac',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
    'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/flac': 'flac', 'audio/aiff': 'aiff', 'audio/x-caf': 'caf',
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic',
  };
  const extOf = mime => EXT[(mime || '').split(';')[0].trim()] || 'bin';
  // audio files keep a sensible extension even when the browser gave no mime — Apple's default is m4a
  const audioExt = mime => EXT[(mime || '').split(';')[0].trim()] || 'm4a';

  // iOS often hands over .m4a files with an empty or odd mime type; fix the
  // type from the filename so playback, export names, and backups all behave.
  const MIME_BY_EXT = {
    m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', wav: 'audio/wav',
    ogg: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', flac: 'audio/flac', aiff: 'audio/aiff', caf: 'audio/x-caf',
  };
  function normalizeAudioFile(file) {
    const given = (file.type || '').split(';')[0].trim();
    if (given && given !== 'application/octet-stream' && given.startsWith('audio/')) return file;
    const ext = ((file.name || '').split('.').pop() || '').toLowerCase();
    const type = MIME_BY_EXT[ext] || given || 'audio/mp4';
    return new Blob([file], { type });
  }

  // ---------- packing (shared by full backups and parcels) ----------
  async function packBook(b, files) {
    const bo = { id: b.id, title: b.title, cornerId: b.cornerId ?? null, pageFormat: b.pageFormat || 'single', createdAt: b.createdAt, cover: null, pages: [] };
    if (b.cover) {
      const f = 'images/cover-' + b.id + '.' + extOf(b.cover.type);
      files.push({ name: f, blob: b.cover });
      bo.cover = { file: f, mime: b.cover.type };
    }
    for (const p of b.pages || []) {
      const f = 'images/page-' + p.id + '.' + extOf(p.blob.type);
      files.push({ name: f, blob: p.blob });
      bo.pages.push({ id: p.id, type: p.type, file: f, mime: p.blob.type, text: p.text || null });
    }
    return bo;
  }
  async function packReading(r, files) {
    const { audioBlob, ...meta } = r;   // tolerate any pre-v2 stragglers
    const blob = (await DB.audio.get(r.id)) || audioBlob || null;
    let audio = null;
    if (blob) {
      const f = 'audio/' + r.id + '.' + audioExt(blob.type);
      files.push({ name: f, blob });
      audio = { file: f, mime: blob.type };
    }
    return { ...meta, audio };
  }

  // ---------- backup / restore ----------
  // The shared walk: enumerate the whole corner into a manifest + a list of
  // {name, blob} files (audio + images), WITHOUT choosing a container. exportAll
  // zips it; cloud.js (Stage 2) content-hashes each file and uploads by sha —
  // both speak the same manifest, so the cloud is "a backup that syncs".
  async function packAll() {
    const [corners, readers, books, readings, requests, activeCorner] = await Promise.all([
      DB.corners.all(), DB.readers.all(), DB.books.all(), DB.readings.all(), DB.requests.all(), DB.corners.active(),
    ]);
    const files = [];
    const booksOut = [];
    for (const b of books) booksOut.push(await packBook(b, files));
    const readingsOut = [];
    for (const r of readings) readingsOut.push(await packReading(r, files));
    const manifest = {
      format: 'catherines-corner-backup', formatVersion: 2,
      exportedAt: new Date().toISOString(),
      cornerName: activeCorner ? activeCorner.name : null,   // kept for humans reading the manifest
      corners, readers, books: booksOut, readings: readingsOut, requests,
    };
    return { manifest, files };
  }

  async function exportAll() {
    const { manifest, files } = await packAll();
    files.unshift({ name: 'manifest.json', bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 1)) });
    return await makeZip(files);
  }

  // A v1 backup has no corners: its rows are filed under a corner matched (or
  // made) from the manifest's cornerName, so nothing lands invisible.
  async function cornerForV1(m) {
    const corners = await DB.corners.all();
    const name = m.cornerName || null;
    if (name) {
      const hit = corners.find(c => c.name === name);
      if (hit) return hit.id;
      const corner = { id: DB.uid(), name, createdAt: Date.now() };
      await DB.corners.save(corner);
      if (!corners.length) await DB.corners.setActive(corner.id);
      return corner.id;
    }
    const active = await DB.corners.active();
    return active ? active.id : null;
  }

  // Merge incoming rows into existing ones: an id match is the same row, a
  // name match is the same PERSON/CHILD from another device (remapped), and
  // anything else is new. Returns oldId → effectiveId. Used for corners on
  // restore and readers on parcel-accept — the two places two families'
  // worlds meet.
  async function mergeByIdThenName(existing, incoming, save) {
    const map = new Map();
    for (const r of incoming || []) {
      if (existing.some(x => x.id === r.id)) { map.set(r.id, r.id); continue; }
      const byName = existing.find(x => (x.name || '').trim().toLowerCase() === (r.name || '').trim().toLowerCase());
      if (byName) { map.set(r.id, byName.id); continue; }
      await save(r);
      map.set(r.id, r.id);
    }
    return map;
  }

  // Every file the manifest points at must actually be in the zip — checked
  // BEFORE the first write, so a truncated backup can't restore readings with
  // their voices missing.
  function assertComplete(m, map) {
    const missing = [];
    const books = m.books || (m.book ? [m.book] : []);
    for (const b of books) {
      if (b.cover && b.cover.file && !map.has(b.cover.file)) missing.push(b.cover.file);
      for (const p of b.pages || []) if (p.file && !map.has(p.file)) missing.push(p.file);
    }
    for (const r of m.readings || []) if (r.audio && r.audio.file && !map.has(r.audio.file)) missing.push(r.audio.file);
    if (missing.length) {
      throw new Error('This backup is incomplete — ' + missing.length + ' file' + (missing.length === 1 ? ' is' : 's are') +
        ' missing inside the zip. Nothing was changed; try another copy of the backup.');
    }
  }

  // Parse + integrity-check a file WITHOUT writing anything: the UI decides
  // what to do with what's inside (restore a backup / offer to accept a parcel).
  async function inspect(file) {
    let map = await parseZip(await file.arrayBuffer());
    // A parcel that was unpacked on the way (iOS Files extracts a tapped zip)
    // and zipped back up usually gained a wrapping folder and __MACOSX junk —
    // find the manifest wherever it landed and read everything beside it.
    if (!map.has('manifest.json')) {
      const hit = [...map.keys()].find(k => k.endsWith('/manifest.json') && !k.startsWith('__MACOSX/'));
      if (hit) {
        const prefix = hit.slice(0, -'manifest.json'.length);
        const un = new Map();
        for (const [k, v] of map) if (k.startsWith(prefix) && k.length > prefix.length) un.set(k.slice(prefix.length), v);
        map = un;
      }
    }
    const mf = map.get('manifest.json');
    if (!mf) throw new Error('No manifest inside — is this a Catherine’s Corner backup or parcel?');
    let m;
    try { m = JSON.parse(new TextDecoder().decode(mf)); }
    catch (e) { throw new Error('This file’s manifest can’t be read — it may be damaged. Nothing was changed.'); }
    if (m.format !== 'catherines-corner-backup' && m.format !== 'catherines-corner-parcel') {
      throw new Error('This isn’t a Catherine’s Corner backup or parcel.');
    }
    assertComplete(m, map);
    return { manifest: m, map };
  }

  async function importFile(file) {
    const { manifest: m, map } = await inspect(file);
    if (m.format !== 'catherines-corner-backup') throw new Error('That’s a parcel — bring it in from “Keep it safe” so you can see what’s inside first.');
    return importBackup(m, map);
  }

  async function importBackup(m, map) {
    const v1 = !(m.formatVersion >= 2);
    const fallbackCornerId = v1 ? await cornerForV1(m) : null;
    const counts = { corners: 0, readers: 0, books: 0, readings: 0, requests: 0 };
    // Corners merge by id, then by name: restoring onto a device where the
    // same child's corner was just set up must land on THAT shelf, not spawn
    // a twin. Remapped ids are applied to every scoped row below.
    counts.corners = (m.corners || []).length;
    const cornerIdMap = await mergeByIdThenName(await DB.corners.all(), m.corners, c => DB.corners.save(c));
    const mapCorner = id => id == null ? fallbackCornerId : (cornerIdMap.get(id) || id);
    for (const r of m.readers || []) { await DB.readers.save(r); counts.readers++; }
    for (const b of m.books || []) {
      const book = {
        id: b.id, title: b.title, cornerId: mapCorner(b.cornerId),
        pageFormat: b.pageFormat || 'single', createdAt: b.createdAt, cover: null, pages: [],
      };
      if (b.cover && map.has(b.cover.file)) book.cover = new Blob([map.get(b.cover.file)], { type: b.cover.mime });
      for (const p of b.pages || []) {
        if (map.has(p.file)) book.pages.push({ id: p.id, type: p.type, text: p.text || null, blob: new Blob([map.get(p.file)], { type: p.mime }) });
      }
      await DB.books.save(book); counts.books++;
    }
    for (const r of m.readings || []) {
      const { audio, audioBlob, ...meta } = r;
      meta.cornerId = mapCorner(meta.cornerId);
      await DB.readings.save(meta);
      if (audio && map.has(audio.file)) await DB.audio.set(r.id, new Blob([map.get(audio.file)], { type: audio.mime }));
      counts.readings++;
    }
    for (const q of m.requests || []) {
      q.cornerId = mapCorner(q.cornerId);
      await DB.requests.save(q); counts.requests++;
    }
    // Make sure a shelf is showing after a restore onto a fresh device.
    await DB.corners.active();
    return counts;
  }

  // A backup containing only what the OTHER device is missing — the payload
  // of nearby sync. Same format as a full backup, so the receiving side runs
  // the exact restore path (corners merge by id/name, rows merge by id) that
  // device moves have exercised since v1.1.1.
  async function exportDelta(haveReadingIds, haveBookIds) {
    const haveR = new Set(haveReadingIds || []);
    const haveB = new Set(haveBookIds || []);
    const [corners, readers, books, readings, activeCorner] = await Promise.all([
      DB.corners.all(), DB.readers.all(), DB.books.all(), DB.readings.all(), DB.corners.active(),
    ]);
    const sendReadings = readings.filter(r => !haveR.has(r.id));
    const referenced = new Set(sendReadings.map(r => r.bookId).filter(Boolean));
    const sendBooks = books.filter(b => referenced.has(b.id) || !haveB.has(b.id));
    const files = [];
    const booksOut = [];
    for (const b of sendBooks) booksOut.push(await packBook(b, files));
    const readingsOut = [];
    for (const r of sendReadings) readingsOut.push(await packReading(r, files));
    const manifest = {
      format: 'catherines-corner-backup', formatVersion: 2,
      exportedAt: new Date().toISOString(),
      cornerName: activeCorner ? activeCorner.name : null,
      corners, readers, books: booksOut, readings: readingsOut, requests: [],
    };
    files.unshift({ name: 'manifest.json', bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 1)) });
    return { blob: await makeZip(files), counts: { readings: sendReadings.length, books: sendBooks.length } };
  }

  // ---------- parcels: one book (or told story) from one family to another ----------
  // Pack a parcel WITHOUT choosing a container → { manifest, files } (files are
  // {name, blob}, no manifest.json). exportParcel zips it (the file path a family
  // saves and brings in); cloud.js content-hashes the same files and uploads them
  // (the share-link path). One source of truth for the parcel manifest, so both
  // paths hand the receiver the exact same thing.
  async function packParcel({ bookId, readingId, toId }) {
    const corner = await DB.corners.active();
    let book = null, readings = [];
    if (bookId) {
      book = await DB.books.get(bookId);
      if (!book) throw new Error('That book couldn’t be found.');
      readings = await DB.readings.forBook(bookId);
    } else if (readingId) {
      const r = await DB.readings.get(readingId);
      readings = r ? [r] : [];
    }
    if (!readings.length) throw new Error('Nothing to send yet — this needs at least one reading.');
    const files = [];
    const readerIds = new Set(readings.map(r => r.readerId));
    const readers = (await DB.readers.all()).filter(r => readerIds.has(r.id));
    const bookOut = book ? await packBook(book, files) : null;
    const readingsOut = [];
    for (const r of readings) readingsOut.push(await packReading(r, files));
    const manifest = {
      format: 'catherines-corner-parcel', formatVersion: 1,
      exportedAt: new Date().toISOString(),
      from: { id: await DB.familyId(), corner: corner ? corner.name : null },
      // however they typed the code, the parcel carries the canonical id —
      // an unrecognizable scribble is kept as typed so the receiver sees it
      to: DB.familyIdFrom(toId) || (toId || '').trim().toUpperCase() || null,
      readers, book: bookOut, readings: readingsOut,
    };
    return { manifest, files };
  }

  // exportParcel({bookId} | {readingId}, toId?) → {blob, manifest}
  async function exportParcel(args) {
    const { manifest, files } = await packParcel(args);
    const zipFiles = files.slice();
    zipFiles.unshift({ name: 'manifest.json', bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 1)) });
    return { blob: await makeZip(zipFiles), manifest };
  }

  // Accept a parcel into the ACTIVE corner. Semantics that keep it safe:
  // readers merge by id then by name (Grandma isn't duplicated); a book or
  // reading id already living in a SIBLING's corner gets a fresh id here
  // instead of being stolen; a reading already in this corner is skipped, so
  // re-accepting the same parcel changes nothing. Every accepted reading
  // arrives isNew — the child's shelf lights up the way a gift should.
  async function importParcel(m, map, targetCornerId) {
    if (!targetCornerId) throw new Error('Make a corner first, then bring the parcel in.');
    const readerIdMap = await mergeByIdThenName(await DB.readers.all(), m.readers, r => DB.readers.save(r));
    const bookIdMap = new Map();
    if (m.book) {
      const b = m.book;
      const pages = (b.pages || []).filter(p => map.has(p.file))
        .map(p => ({ id: p.id, type: p.type, text: p.text || null, blob: new Blob([map.get(p.file)], { type: p.mime }) }));
      const cover = b.cover && map.has(b.cover.file) ? new Blob([map.get(b.cover.file)], { type: b.cover.mime }) : null;
      const existing = await DB.books.get(b.id);
      if (existing && existing.cornerId === targetCornerId) {
        const have = new Set((existing.pages || []).map(p => p.id));
        existing.pages = (existing.pages || []).concat(pages.filter(p => !have.has(p.id)));
        if (!existing.cover && cover) existing.cover = cover;
        if (!existing.pageFormat && b.pageFormat) existing.pageFormat = b.pageFormat;
        await DB.books.save(existing);
        bookIdMap.set(b.id, b.id);
      } else {
        const id = existing ? DB.uid() : b.id;
        await DB.books.save({
          id, title: b.title, cornerId: targetCornerId, pageFormat: b.pageFormat || 'single',
          cover, pages, createdAt: b.createdAt || Date.now(),
        });
        bookIdMap.set(b.id, id);
      }
    }
    const counts = { readings: 0 };
    for (const r of m.readings || []) {
      const { audio, audioBlob, ...meta } = r;
      const existing = await DB.readings.get(meta.id);
      if (existing && existing.cornerId === targetCornerId) continue;   // already accepted
      if (existing) meta.id = DB.uid();                                 // same id in a sibling's corner
      meta.cornerId = targetCornerId;
      meta.bookId = meta.bookId ? (bookIdMap.get(meta.bookId) || meta.bookId) : null;
      meta.readerId = readerIdMap.get(meta.readerId) || meta.readerId;
      meta.isNew = true;
      if (audio && map.has(audio.file)) {
        await DB.readings.saveWithAudio(meta, new Blob([map.get(audio.file)], { type: audio.mime }));
      } else {
        await DB.readings.save(meta);
      }
      counts.readings++;
    }
    return counts;
  }

  window.Backup = { packAll, exportAll, exportDelta, importFile, inspect, importBackup, packParcel, exportParcel, importParcel, audioExt, normalizeAudioFile };
})();
