/* Catherine's Corner E2E — shared harness bits for the Stage 2 (Phase 3 +
   Phase 4) specs. Factored out of e2e.js's own inline helpers so the new
   cloud specs don't duplicate ~150 lines of static-server/asset/assert
   plumbing — e2e.js itself is left untouched (it stays a single, deliberately
   monolithic file per its own header comment, and it must keep passing with
   NO fake cloud attached — the offline regression guarantee). */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
// Prefer an explicit override (CC_E2E_CHROMIUM — useful when the installed
// playwright version's expected browser revision isn't the one cached
// locally), then a pre-provisioned Chromium (remote dev containers), else
// let Playwright resolve its own downloaded browser.
const CHROMIUM = process.env.CC_E2E_CHROMIUM
  || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', png: 'image/png', zip: 'application/zip' };

// ---------- tiny static server (serves the repo, same as e2e.js's) ----------
function startStaticServer(port) {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0].split('#')[0];
    if (url === '/blank.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>blank</title>ok'); }
    let p = path.join(ROOT, decodeURIComponent(url));
    // path.join normalizes to the platform separator, so on win32 a
    // directory URL like /app/ becomes ...\app\ — check both, not just '/'
    // (e2e.js's own copy of this check only handles '/' and is POSIX-only;
    // harmless there since it's normally run in Linux dev containers, but
    // this harness needs to work on this Windows box too).
    if (p.endsWith('/') || p.endsWith(path.sep)) p += 'index.html';
    fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); return res.end('nope'); }
      res.writeHead(200, { 'content-type': MIME[p.split('.').pop()] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return {
    listen: () => new Promise((resolve) => server.listen(port, resolve)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---------- test assets ----------
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR4nGNgYGD4z4AGmNAFRr4gAI/vAROmk8sCAAAAAElFTkSuQmCC';
function writePngs(tmpDir, n1 = 'ph1.png', n2 = 'ph2.png') {
  const buf = Buffer.from(PNG_B64, 'base64');
  const p1 = path.join(tmpDir, n1), p2 = path.join(tmpDir, n2);
  fs.writeFileSync(p1, buf); fs.writeFileSync(p2, buf);
  return [p1, p2];
}
function makeWav(seconds = 1) {
  const rate = 8000, n = rate * seconds;
  const buf = Buffer.alloc(44 + n);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write('data', 36); buf.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) buf[44 + i] = 128 + Math.round(60 * Math.sin(i / 8)); // a soft hum, not silence
  return buf;
}
function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function guessMime(name) {
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.wav')) return 'audio/wav';
  if (name.endsWith('.webm')) return 'audio/webm';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

// Minimal STORE-zip reader (mirror of e2e.js's own mirror of the app's zip
// format — the app writes parcels with makeZip()'s STORE method, no
// compression). Lets this harness unpack a REAL parcel zip produced by the
// app's existing #parcel button and hash its entries in Node, so Phase 3's
// share-link tests can drive the fake-cloud REST contract directly instead
// of depending on a not-yet-built "send as a link" button.
function readZip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(p + 24);
    const nLen = buf.readUInt16LE(p + 28), xLen = buf.readUInt16LE(p + 30), cLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nLen).toString('utf8');
    const lnLen = buf.readUInt16LE(lho + 26), lxLen = buf.readUInt16LE(lho + 28);
    const ds = lho + 30 + lnLen + lxLen;
    out.push({ name, bytes: buf.slice(ds, ds + size) });
    p += 46 + nLen + xLen + cLen;
  }
  return out;
}

// ---------- harness ----------
function makeStepper() {
  let stepNo = 0;
  return { step(msg) { stepNo++; console.log(`  ${String(stepNo).padStart(2)}. ${msg}`); }, count: () => stepNo };
}
function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function enterPin(page, digits) {
  for (const d of digits) await page.click(`.pinpad button:text-is("${d}")`);
}

// Headless Chromium (this box's cached revision, at least) exposes
// `navigator.share` as a function that silently resolves without any OS
// share sheet — so Send.shareText()'s `if (navigator.share) { ... return; }`
// branch swallows the link and NEVER reaches the clipboard.writeText()
// fallback the harness reads. Neutralize it so every context deterministically
// takes the clipboard path (same category of stub as e2e.js's fake
// SpeechRecognition / --use-fake-device-for-media-stream — real product code
// is untouched, only the test browser's environment is shaped).
async function stubNoShare(ctx) {
  await ctx.addInitScript(() => { try { Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); } catch (e) {} });
}

// Catherine's Corner reads its #parcel=/#give=/#invite= boot payload ONCE,
// inside a `DOMContentLoaded` listener in app.js. Navigating from an
// ALREADY-LOADED `.../app/` page to `.../app/#token=X` on the SAME path is a
// same-document fragment navigation per the HTML spec — the browser does not
// reload, so DOMContentLoaded never refires and the boot handler never sees
// the new hash (confirmed against the real app while building this harness;
// it silently stays on whatever screen was already rendered, no error at
// all). A real recipient always opens these links fresh (a text message, a
// new tab) with the hash present from the very first request, so this
// bounce through about:blank isn't a workaround for a product bug — it's
// just how to reproduce "opening a fresh link" from a page that already has
// the app loaded, the way this harness's device contexts are reused.
async function gotoHash(page, url) {
  await page.goto('about:blank');
  await page.goto(url);
}

module.exports = {
  ROOT, CHROMIUM, startStaticServer, writePngs, makeWav, sha256Hex, guessMime, readZip,
  makeStepper, assert, sleep, enterPin, stubNoShare, gotoHash,
};
