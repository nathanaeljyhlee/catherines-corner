/* Catherine's Corner — full backup & restore.
   One plain .zip: manifest.json + every audio file + every image, uncompressed (STORE),
   so a family can open it with any zip tool in twenty years — no app required.
   Restore merges by id, so re-importing on the same device never duplicates or destroys. */

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
  function makeZip(entries) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
    for (const e of entries) {
      const name = enc.encode(e.name);
      const crc = crc32(e.bytes), size = e.bytes.length;
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
      parts.push(new Uint8Array(lh.buffer), name, e.bytes);

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

  // ---------- zip reader (STORE only) ----------
  function parseZip(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    let e = buf.byteLength - 22;
    while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('That file isn’t a zip archive.');
    const count = dv.getUint16(e + 10, true);
    let p = dv.getUint32(e + 16, true);
    const dec = new TextDecoder(), out = new Map();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('The zip file looks damaged.');
      const method = dv.getUint16(p + 10, true);
      const size = dv.getUint32(p + 24, true);
      const nLen = dv.getUint16(p + 28, true), xLen = dv.getUint16(p + 30, true), cLen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nLen));
      if (method !== 0) throw new Error('This zip uses compression this app can’t read.');
      const lnLen = dv.getUint16(lho + 26, true), lxLen = dv.getUint16(lho + 28, true);
      const dataStart = lho + 30 + lnLen + lxLen;
      out.set(name, u8.subarray(dataStart, dataStart + size));
      p += 46 + nLen + xLen + cLen;
    }
    return out;
  }

  // ---------- backup / restore ----------
  const EXT = {
    'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/aac': 'aac',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg',
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic',
  };
  const extOf = mime => EXT[(mime || '').split(';')[0].trim()] || 'bin';

  async function exportAll() {
    const [readers, books, readings, requests, cornerName] = await Promise.all([
      DB.readers.all(), DB.books.all(), DB.readings.all(), DB.requests.all(), DB.settings.get('cornerName'),
    ]);
    const files = [];
    const booksOut = [];
    for (const b of books) {
      const bo = { id: b.id, title: b.title, createdAt: b.createdAt, cover: null, pages: [] };
      if (b.cover) {
        const f = 'images/cover-' + b.id + '.' + extOf(b.cover.type);
        files.push({ name: f, bytes: new Uint8Array(await b.cover.arrayBuffer()) });
        bo.cover = { file: f, mime: b.cover.type };
      }
      for (const p of b.pages || []) {
        const f = 'images/page-' + p.id + '.' + extOf(p.blob.type);
        files.push({ name: f, bytes: new Uint8Array(await p.blob.arrayBuffer()) });
        bo.pages.push({ id: p.id, type: p.type, file: f, mime: p.blob.type });
      }
      booksOut.push(bo);
    }
    const readingsOut = [];
    for (const r of readings) {
      const { audioBlob, ...meta } = r;
      let audio = null;
      if (audioBlob) {
        const f = 'audio/' + r.id + '.' + extOf(audioBlob.type);
        files.push({ name: f, bytes: new Uint8Array(await audioBlob.arrayBuffer()) });
        audio = { file: f, mime: audioBlob.type };
      }
      readingsOut.push({ ...meta, audio });
    }
    const manifest = {
      format: 'catherines-corner-backup', formatVersion: 1,
      exportedAt: new Date().toISOString(),
      cornerName: cornerName || null,
      readers, books: booksOut, readings: readingsOut, requests,
    };
    files.unshift({ name: 'manifest.json', bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 1)) });
    return makeZip(files);
  }

  async function importFile(file) {
    const map = parseZip(await file.arrayBuffer());
    const mf = map.get('manifest.json');
    if (!mf) throw new Error('No manifest inside — is this a Catherine’s Corner backup?');
    const m = JSON.parse(new TextDecoder().decode(mf));
    if (m.format !== 'catherines-corner-backup') throw new Error('This isn’t a Catherine’s Corner backup.');
    const counts = { readers: 0, books: 0, readings: 0, requests: 0 };
    for (const r of m.readers || []) { await DB.readers.save(r); counts.readers++; }
    for (const b of m.books || []) {
      const book = { id: b.id, title: b.title, createdAt: b.createdAt, cover: null, pages: [] };
      if (b.cover && map.has(b.cover.file)) book.cover = new Blob([map.get(b.cover.file)], { type: b.cover.mime });
      for (const p of b.pages || []) {
        if (map.has(p.file)) book.pages.push({ id: p.id, type: p.type, blob: new Blob([map.get(p.file)], { type: p.mime }) });
      }
      await DB.books.save(book); counts.books++;
    }
    for (const r of m.readings || []) {
      const { audio, ...meta } = r;
      const reading = { ...meta, audioBlob: audio && map.has(audio.file) ? new Blob([map.get(audio.file)], { type: audio.mime }) : null };
      await DB.readings.save(reading); counts.readings++;
    }
    for (const q of m.requests || []) { await DB.requests.save(q); counts.requests++; }
    if (m.cornerName) await DB.settings.set('cornerName', m.cornerName);
    return counts;
  }

  window.Backup = { exportAll, importFile };
})();
