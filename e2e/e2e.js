/* Catherine's Corner v1.7.0 — end-to-end regression + new-feature suite.
   Runs the real app in the bundled Chromium with a fake microphone. */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8907;
const TMP = path.join(__dirname, '.artifacts');
fs.mkdirSync(TMP, { recursive: true });
// Prefer a pre-provisioned Chromium (remote dev containers); else Playwright's own.
const CHROMIUM = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;

// ---------- tiny static server (with a synthetic /blank.html for DB seeding) ----------
const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', png: 'image/png', zip: 'application/zip' };
const countHits = [];   // the fake telemetry collector's inbox
let swTag = null;       // when set, sw.js is served with this VERSION — simulates a new release
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0].split('#')[0];
  if (swTag && url === '/app/sw.js') {
    const src = fs.readFileSync(path.join(ROOT, 'app/sw.js'), 'utf8').replace(/const VERSION = '[^']+';/, "const VERSION = '" + swTag + "';");
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' });
    return res.end(src);
  }
  if (url === '/count') {
    countHits.push(new URL(req.url, 'http://x').searchParams.get('p'));
    res.writeHead(200, { 'content-type': 'image/gif' });
    return res.end();
  }
  if (url === '/blank.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>blank</title>ok'); }
  let p = path.join(ROOT, decodeURIComponent(url));
  if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': MIME[p.split('.').pop()] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- test assets ----------
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR4nGNgYGD4z4AGmNAFRr4gAI/vAROmk8sCAAAAAElFTkSuQmCC';
function writePngs() {
  const buf = Buffer.from(PNG_B64, 'base64');
  const p1 = path.join(TMP, 'page1.png'), p2 = path.join(TMP, 'page2.png');
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

// STORE-only zip writer (mirror of the app's) to craft a v1-format backup.
function crc32(bytes) {
  const T = crc32.T || (crc32.T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })());
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = T[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.bytes), size = e.bytes.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(size, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, e.bytes);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(size, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + size;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}
function makeV1BackupZip() {
  const wav = makeWav(1);
  const manifest = {
    format: 'catherines-corner-backup', formatVersion: 1, exportedAt: new Date().toISOString(),
    cornerName: 'Pip',
    readers: [{ id: 'v1-reader', name: 'Gran', relationship: 'Grandma', color: '#5B7B5A', createdAt: 1 }],
    books: [{ id: 'v1-book', title: 'The Pip Book', createdAt: 1, cover: null, pages: [] }],
    readings: [{ id: 'v1-reading', bookId: 'v1-book', readerId: 'v1-reader', title: null, episodeIndex: null,
      duration: 1, imported: false, pageTurns: [], skipRanges: [], isNew: false, createdAt: 2,
      audio: { file: 'audio/v1-reading.wav', mime: 'audio/wav' } }],
    requests: [],
  };
  return makeZip([
    { name: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest), 'utf8') },
    { name: 'audio/v1-reading.wav', bytes: wav },
  ]);
}

// ---------- harness ----------
let stepNo = 0;
function step(msg) { stepNo++; console.log(`  ${String(stepNo).padStart(2)}. ${msg}`); }
function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function enterPin(page, digits) {
  for (const d of digits) await page.click(`.pinpad button:text-is("${d}")`);
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const [png1, png2] = writePngs();
  fs.writeFileSync(path.join(TMP, 'v1-backup.zip'), makeV1BackupZip());

  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
      '--disable-features=WebRtcHideLocalIpsWithMdns'],
  });
  const errors = [];

  // ============ PART A: full owner journey on a fresh device ============
  const ctxA = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['microphone'], acceptDownloads: true });
  const page = await ctxA.newPage();
  page.on('pageerror', e => errors.push('A: ' + e.message));
  let promptAnswer = '';   // what window.prompt returns on page A this moment
  page.on('dialog', d => d.accept(d.type() === 'prompt' ? promptAnswer : undefined));

  step('boot fresh → alpha notice → acknowledge');
  await page.goto(`http://localhost:${PORT}/app/`);
  await page.click('#ack');
  await page.waitForSelector('.empty');
  assert(await page.textContent('.empty').then(t => t.includes('Nothing on the shelf yet')), 'empty shelf greeting');

  step('PIN gate (create 1234) → corner setup "Mei"');
  await page.click('#gate');
  await enterPin(page, '1234'); await enterPin(page, '1234');
  await page.waitForSelector('#nm');
  await page.fill('#nm', 'Mei');
  await page.click('#save');
  await page.waitForSelector('.home-grid');
  assert((await page.textContent('.kicker')).includes('Mei'), 'home kicker names the corner');

  step('add reader Dad (with email)');
  await page.click('.home-card:has-text("The people who read")');
  await page.fill('#nm', 'Dad'); await page.fill('#rel', 'Dad'); await page.fill('#em', 'dad@example.com');
  await page.click('#add');
  await page.waitForSelector('.rowitem:has-text("Dad")');
  await page.click('.back');

  step('record flow: who → new book "Goodnight Moon" → whole book → record');
  await page.click('.home-card:has-text("Record a reading")');
  await page.click('.pick:has-text("Dad")');
  await page.click('#newb');
  await page.fill('#ti', 'Goodnight Moon');
  await page.click('#save');                      // returnTo recWhat
  await page.click('.rowitem:has-text("Goodnight Moon")');
  await page.click('.pick:has-text("The whole book")');
  await page.waitForSelector('#rec');
  await page.click('#rec');
  await sleep(1800);
  await page.click('#stop');
  await page.waitForSelector('.pagestrip');

  step('pass 2: choose SPREAD format, add 2 page photos, tap a turn, save');
  await page.click('.seg button[data-v="spread"]');
  await page.setInputFiles('#pgs', [png1, png2]);
  await page.waitForSelector('.pagestrip.spread .pg');
  assert(await page.$$('.pagestrip .pg').then(x => x.length === 2), 'two page thumbs in the strip');
  await page.click('#tap');
  await page.click('#save');
  await page.waitForSelector('.rec-hero:has-text("reading is ready")');

  step('kid mode: shelf tile → player has spread stage + rotate hint (portrait)');
  await page.click('#kid');
  await page.click('.tile:has-text("Goodnight Moon")');
  await page.waitForSelector('.p-stage.spread');
  await page.waitForSelector('.rotate-hint');
  const hintShown = await page.$eval('.rotate-hint', n => getComputedStyle(n).display !== 'none');
  assert(hintShown, 'rotate hint visible in portrait');

  step('playback runs and reaches the calm end (no autoplay after)');
  await page.click('#pp');
  await page.waitForFunction(() => window.App.player.audio && window.App.player.audio.currentTime > 0.2);
  await page.waitForSelector('.calm', { timeout: 15000 });
  assert((await page.textContent('.calm')).includes('The end'), 'calm end screen');
  await page.click('#shelf2');

  step('landscape: rotate hint melts away, wide layout kicks in');
  await page.setViewportSize({ width: 844, height: 390 });
  await page.click('.tile:has-text("Goodnight Moon")');
  await page.waitForSelector('.p-stage.spread');
  const hintHidden = await page.$eval('.rotate-hint', n => getComputedStyle(n).display === 'none');
  assert(hintHidden, 'rotate hint hidden in landscape');
  assert(await page.$eval('#app', n => n.classList.contains('wide')), '#app.wide for spread book');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('.back');

  step('book request carries an #invite= link (✉️/💬/⧉ + preview)');
  await page.click('#gate');
  await enterPin(page, '1234');
  await page.click('.home-card:has-text("Book requests")');
  await page.selectOption('#rd', { label: 'Dad' });
  await page.selectOption('#bk', { label: 'Goodnight Moon' });
  await page.fill('#nt', 'do the bunny voice');
  await page.click('#add');
  await page.waitForSelector('.rowitem.stacked:has-text("Goodnight Moon")');
  const inviteHref = await page.getAttribute('a.btn[target="_blank"]', 'href');
  assert(inviteHref && inviteHref.includes('#invite='), 'preview link holds the invite payload');

  step('guest page: explains the app, shows the ask, records, offers send-back');
  const guest = await ctxA.newPage();
  guest.on('pageerror', e => errors.push('guest: ' + e.message));
  await guest.goto(inviteHref);
  await guest.waitForSelector('h1.screen-title');
  const gTitle = await guest.textContent('h1.screen-title');
  assert(gTitle.includes('Read to Mei'), 'guest page addresses the child by name');
  assert((await guest.textContent('body')).includes('Goodnight Moon'), 'guest page shows the requested book');
  assert((await guest.textContent('body')).includes('do the bunny voice'), 'guest page shows the note');
  assert(!(await guest.$('#gate')), 'no grown-up gate on the guest page');
  await guest.click('#rec');
  await sleep(1200);
  await guest.click('#stop');
  await guest.waitForSelector('#send');
  assert(await guest.$('audio'), 'guest can listen back');
  assert(await guest.$('#dl[href]'), 'guest can save the file');
  assert((await guest.textContent('footer.appfoot')).includes('nothing is uploaded'), 'honest guest footer');
  await guest.close();

  step('multi-corner: add "Theo", shelves scoped, pills switch');
  await page.click('.back'); // requests → home
  await page.click('#cornerslink');
  await page.waitForSelector('h1:has-text("Corners")');
  await page.fill('#nm', 'Theo');
  await page.click('#add');
  await page.waitForSelector('.home-grid');
  assert((await page.textContent('.kicker')).includes('Theo'), 'active corner switched to Theo');
  assert((await page.textContent('.home-card:has-text("The library")')).includes('0 books'), "Theo's library is his own");
  await page.click('#to-kid');
  await page.waitForSelector('.corner-pills');
  assert((await page.textContent('.empty')).includes('Nothing on the shelf yet'), "Theo's shelf is empty");
  await page.click('.corner-pill:has-text("Mei")');
  await page.waitForSelector('.tile:has-text("Goodnight Moon")');

  step('backup: export the whole corner as one zip');
  await page.click('#gate');
  await enterPin(page, '1234');
  await page.click('.home-card:has-text("Keep it safe")');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#backup')]);
  const zipPath = path.join(TMP, 'backup-v2.zip');
  await download.saveAs(zipPath);
  assert(fs.statSync(zipPath).size > 1000, 'backup zip has real content');

  step('wipe the device → fresh setup "Mei" → restore merges onto her shelf');
  await page.goto(`http://localhost:${PORT}/blank.html`);
  await page.evaluate(() => new Promise((res, rej) => {
    const req = indexedDB.deleteDatabase('catherines-corner');
    req.onsuccess = res; req.onerror = () => rej(req.error); req.onblocked = () => rej(new Error('blocked'));
  }));
  await page.goto(`http://localhost:${PORT}/app/`);
  await page.click('#ack');
  await page.click('#gate');
  await enterPin(page, '1234'); await enterPin(page, '1234');
  await page.fill('#nm', 'Mei');
  await page.click('#save');
  await page.click('.home-card:has-text("Keep it safe")');
  await page.setInputFiles('#restorefile', zipPath);
  await page.waitForSelector('.toast.show:has-text("Restored")');
  await page.click('.back');
  assert((await page.textContent('.home-card:has-text("The library")')).includes('1 book'), 'library back after restore');
  const cornersAfter = await page.evaluate(() => DB.corners.all());
  assert(cornersAfter.length === 2, 'Mei merged by name + Theo imported = 2 corners, no twins (got ' + cornersAfter.length + ')');
  await page.click('#to-kid');
  await page.waitForSelector('.tile:has-text("Goodnight Moon")');

  step('kid playback works from restored data (audio store round-trip)');
  await page.click('.tile:has-text("Goodnight Moon")');
  await page.waitForSelector('.p-stage.spread');
  await page.click('#pp');
  await page.waitForFunction(() => window.App.player.audio && window.App.player.audio.currentTime > 0.2);
  await page.click('.back');

  step('v1 backup zip restores: corner made from cornerName, audio in the audio store');
  await page.click('#gate');
  await enterPin(page, '1234');
  await page.click('.home-card:has-text("Keep it safe")');
  await page.setInputFiles('#restorefile', path.join(TMP, 'v1-backup.zip'));
  await page.waitForSelector('.toast.show:has-text("Restored")');
  const v1check = await page.evaluate(async () => {
    const corners = await DB.corners.all();
    const pip = corners.find(c => c.name === 'Pip');
    const reading = await DB.readings.get('v1-reading');
    const blob = await DB.audio.get('v1-reading');
    return { pip: !!pip, cornerOk: !!(pip && reading && reading.cornerId === pip.id), blobSize: blob ? blob.size : 0, noInline: reading && !('audioBlob' in reading) };
  });
  assert(v1check.pip, 'corner "Pip" created from v1 cornerName');
  assert(v1check.cornerOk, 'v1 reading filed under Pip');
  assert(v1check.blobSize > 4000, 'v1 audio landed in the audio store');
  assert(v1check.noInline, 'no inline audioBlob on the reading row');

  step('video export renders (spread book → 16:9 canvas, audio from the audio store)');
  await page.click('.back'); // safety → home
  await page.click('.home-card:has-text("The library")');
  await page.click('.rowitem:has-text("Goodnight Moon")');
  await page.waitForSelector('h1:has-text("Goodnight Moon")');
  const [vidDl] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.click('[data-vx]'),
  ]);
  const vidPath = path.join(TMP, 'export.' + (vidDl.suggestedFilename().split('.').pop()));
  await vidDl.saveAs(vidPath);
  assert(fs.statSync(vidPath).size > 5000, 'exported video has real content');
  await page.waitForSelector('.toast.show:has-text("Video ready")');
  await page.click('.back'); await page.click('.back'); // book → library → home

  step('told story + edit flow + gentle skip still work');
  await page.click('.home-card:has-text("Record a reading")');
  await page.click('.pick:has-text("Dad")');
  await page.click('#told');
  await page.fill('#st', 'The Dragon Who Couldn’t Sleep');
  await page.click('#next');
  await page.click('#rec'); await sleep(1200); await page.click('#stop');
  await page.waitForSelector('#sk');
  await page.click('#sk'); await page.click('#sk'); // zero-length skip → ignored
  await page.click('#save');
  await page.waitForSelector('.rec-hero:has-text("reading is ready")');
  await page.click('#home');
  await page.click('.home-card:has-text("The library")');
  await page.waitForSelector('.rowitem:has-text("The Dragon Who")');
  await page.click('.rowitem:has-text("The Dragon Who") [data-ed]');
  await page.waitForSelector('h1:has-text("Adjust the pages & turns")');
  await page.click('#save');
  await page.waitForSelector('h1:has-text("The library")');

  // ---------- hardening ----------
  step('HARDEN: a failed save is loud and lossless (quota → draft kept, no orphan rows)');
  await page.click('.back'); // library → home
  await page.click('.home-card:has-text("Record a reading")');
  await page.click('.pick:has-text("Dad")');
  await page.click('#told');
  await page.fill('#st', 'The Quota Story');
  await page.click('#next');
  await page.click('#rec'); await sleep(1200); await page.click('#stop');
  await page.waitForSelector('#sk');
  const countBefore = await page.evaluate(async () => (await DB.readings.all()).length);
  await page.evaluate(() => {
    DB.readings._origSWA = DB.readings.saveWithAudio;
    DB.readings.saveWithAudio = () => { const e = new Error('quota'); e.name = 'QuotaExceededError'; return Promise.reject(e); };
  });
  await page.click('#save');
  await page.waitForSelector('.toast.show:has-text("storage is full")');
  assert(await page.$('h1:has-text("Pass 2")'), 'still on pass 2 — the draft is not thrown away');
  assert(!(await page.evaluate(() => App.updateSafe())), 'auto-update holds back while a draft is unsaved');
  const countMid = await page.evaluate(async () => (await DB.readings.all()).length);
  assert(countMid === countBefore, 'no orphan reading row after the failed save');
  await page.evaluate(() => { DB.readings.saveWithAudio = DB.readings._origSWA; });
  await page.click('#save');
  await page.waitForSelector('.rec-hero:has-text("reading is ready")');
  const countAfter = await page.evaluate(async () => (await DB.readings.all()).length);
  assert(countAfter === countBefore + 1, 'retry after freeing space saves exactly once');
  await page.click('#home');

  step('ANALYTICS: pain-point areas counted locally; usage screen + snapshot share');
  const m = await page.evaluate(async () => {
    const rows = await DB.metrics.all();
    return Object.fromEntries(rows.map(r => [r.key, r.n]));
  });
  assert((m['record.flow_started'] || 0) >= 2, 'record flows counted (got ' + m['record.flow_started'] + ')');
  assert((m['record.reading_saved'] || 0) >= 1, 'saved readings counted');
  assert((m['record.audio_recorded'] || 0) >= 1, 'live recordings counted');
  assert((m['error.save_failed'] || 0) >= 1, 'failed saves counted as a pain point');
  assert((m['safety.restore_done'] || 0) >= 2, 'restores counted');
  assert((m['record.edit_saved'] || 0) >= 1, 'edit flow counted');
  await page.click('#usagelink'); // we are on grown-up home after the quota retry
  await page.waitForSelector('h1:has-text("What gets used")');
  assert((await page.textContent('body')).includes('kept on this device'), 'usage screen carries the honesty line');
  assert(await page.$('.card .kicker:has-text("recording")'), 'recording area rendered');
  assert(await page.$('.card .kicker:has-text("rough edges")'), 'error area rendered');
  assert(await page.$('#share:not([disabled])'), 'snapshot share offered');
  await page.click('.back'); // usage → home

  step('TELEMETRY: dormant by default; pings the maker only when configured; off switch respected');
  assert(countHits.length === 0, 'no telemetry left any device while unconfigured (got ' + countHits.length + ' hits)');
  await page.evaluate(origin => Telemetry.configure(origin + '/count'), `http://localhost:${PORT}`);
  await page.evaluate(() => DB.metrics.bump('e2e.telemetry_ping'));
  await page.waitForFunction(() => true); // let the pixel fire
  for (let i = 0; i < 40 && !countHits.includes('/e2e.telemetry_ping'); i++) await sleep(100);
  assert(countHits.includes('/e2e.telemetry_ping'), 'configured telemetry delivers the event to the collector');
  const before = countHits.length;
  await page.evaluate(() => Telemetry.setOff(true));
  await page.evaluate(() => DB.metrics.bump('e2e.telemetry_muted'));
  await sleep(800);
  assert(!countHits.includes('/e2e.telemetry_muted') && countHits.length === before, 'the family off switch stops all sending');
  const localStillCounts = await page.evaluate(async () => (await DB.metrics.all()).some(r => r.key === 'e2e.telemetry_muted'));
  assert(localStillCounts, 'local counting continues even when sending is off');
  // usage screen discloses + offers the switch when configured
  await page.click('#usagelink');
  await page.waitForSelector('.card .kicker:has-text("sharing with the maker")');
  assert(await page.$('#ttoggle'), 'off/on switch rendered');
  await page.evaluate(() => { Telemetry.configure(''); return Telemetry.setOff(false); }); // back to dormant for the rest
  await page.click('.back'); // usage → home

  step('PARCELS: family A packs a book addressed to family B\'s Corner ID');
  const ctxE = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const pageE = await ctxE.newPage();
  pageE.on('pageerror', e => errors.push('E: ' + e.message));
  pageE.on('dialog', d => d.accept(''));
  await pageE.goto(`http://localhost:${PORT}/app/`);
  await pageE.click('#ack');
  await pageE.click('#gate');
  await enterPin(pageE, '5678'); await enterPin(pageE, '5678');
  await pageE.fill('#nm', 'Ben');
  await pageE.click('#save');
  const benId = await pageE.evaluate(() => DB.familyId());
  assert(/^CC-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(benId), 'Corner ID has the shareable shape (got ' + benId + ')');
  // family A packs Goodnight Moon for Ben
  await page.click('.home-card:has-text("The library")');
  await page.click('.rowitem:has-text("Goodnight Moon")');
  promptAnswer = benId.toLowerCase();   // sloppy typing is normalized on pack
  const [parcelDl] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#parcel'),
  ]);
  promptAnswer = '';
  const parcelPath = path.join(TMP, 'parcel.zip');
  await parcelDl.saveAs(parcelPath);
  assert(fs.statSync(parcelPath).size > 1000, 'parcel has real content');
  await page.click('.back'); await page.click('.back'); // book → library → home

  step('PARCELS: family B accepts — book, voices and pages land on Ben\'s shelf, marked new');
  await pageE.click('.home-card:has-text("Keep it safe")');
  await pageE.setInputFiles('#restorefile', parcelPath);
  await pageE.waitForSelector('h1:has-text("Goodnight Moon")');
  assert((await pageE.textContent('body')).includes('✓ addressed to this corner'), 'address matches — no warning');
  await pageE.click('#accept');
  await pageE.waitForSelector('h1:has-text("The library")');
  assert(await pageE.$('.rowitem:has-text("Goodnight Moon")'), 'book in Ben\'s library');
  const benState = await pageE.evaluate(async () => {
    const readers = await DB.readers.all();
    const corner = await DB.corners.active();
    const readings = await DB.readings.all(corner.id);
    return { dads: readers.filter(r => r.name === 'Dad').length, readings: readings.length, allNew: readings.every(r => r.isNew) };
  });
  assert(benState.dads === 1, 'reader Dad traveled with the parcel, once');
  assert(benState.readings >= 1 && benState.allNew, 'accepted readings arrive marked new');
  await pageE.click('#to-kid');
  await pageE.waitForSelector('.tile:has-text("Goodnight Moon") .badge-new');
  await pageE.click('.tile:has-text("Goodnight Moon")');
  await pageE.waitForSelector('.p-stage.spread');
  await pageE.click('#pp');
  await pageE.waitForFunction(() => window.App.player.audio && window.App.player.audio.currentTime > 0.2);

  step('PARCELS: re-accepting is a no-op; a mis-addressed parcel warns before it tucks in');
  await pageE.click('.back');
  await pageE.click('#gate'); await enterPin(pageE, '5678');
  await pageE.click('.home-card:has-text("Keep it safe")');
  await pageE.setInputFiles('#restorefile', parcelPath);
  await pageE.waitForSelector('#accept');
  await pageE.click('#accept');
  await pageE.waitForSelector('.toast.show:has-text("already on the shelf")');
  const benCount2 = await pageE.evaluate(async () => (await DB.readings.all((await DB.corners.active()).id)).length);
  assert(benCount2 === benState.readings, 're-accept adds nothing');
  await ctxE.close();
  // family A opens the SAME parcel (addressed to Ben, not to A) → warning
  await page.click('.home-card:has-text("Keep it safe")');
  await page.setInputFiles('#restorefile', parcelPath);
  await page.waitForSelector('#accept');
  assert((await page.textContent('body')).includes('addressed to a different corner') ||
         (await page.textContent('body')).includes('was addressed to'), 'mis-addressed parcel warns plainly');
  await page.click('#nope'); // decline
  await page.waitForSelector('h1:has-text("Keep it safe")');
  assert((await page.textContent('body')).includes('your corner id'.toLowerCase()) || await page.$('#fid'), 'Corner ID surfaced under Keep it safe');
  await page.click('.back'); // safety → home

  step('WHAT\'S NEW: badge appears after an update, walkthrough carousel opens, badge clears');
  assert(!(await page.$('#newbadge')), 'no badge when this version has been seen');
  await page.evaluate(() => DB.settings.set('seenVersion', '1.7.1'));   // simulate a device that updated
  await page.reload();
  await page.waitForSelector('#newbadge');
  await page.click('#newbadge');
  await page.waitForSelector('h1:has-text("What’s new")');
  const slideCount = await page.$$('.carousel .slide').then(x => x.length);
  assert(slideCount >= 5, 'walkthrough carousel has slides (got ' + slideCount + ')');
  assert((await page.textContent('.carousel')).includes('Sync nearby') || (await page.textContent('.carousel')).includes('sync nearby'), 'newest feature leads');
  await page.click('.back');
  await page.waitForSelector('.shelf-head');   // kid mode → back to the shelf
  assert(!(await page.$('#newbadge')), 'badge gone once the walkthrough was seen');

  step('NEARBY SYNC: two devices pair by hand-carried codes and merge over the wire');
  const ctxG = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['microphone'] });
  const pageG = await ctxG.newPage();
  pageG.on('pageerror', e => errors.push('G: ' + e.message));
  pageG.on('dialog', d => d.accept(''));
  await pageG.goto(`http://localhost:${PORT}/app/`);
  await pageG.click('#ack');
  await pageG.click('#gate');
  await enterPin(pageG, '9999'); await enterPin(pageG, '9999');
  await pageG.fill('#nm', 'Zoe');
  await pageG.click('#save');
  // Zoe's device records its own told story, so the merge is genuinely two-way
  await pageG.click('.home-card:has-text("The people who read")');
  await pageG.fill('#nm', 'Mum'); await pageG.click('#add');
  await pageG.waitForSelector('.rowitem:has-text("Mum")');
  await pageG.click('.back');
  await pageG.click('.home-card:has-text("Record a reading")');
  await pageG.click('.pick:has-text("Mum")');
  await pageG.click('#told');
  await pageG.fill('#st', 'Zoe and the Comet');
  await pageG.click('#next');
  await pageG.click('#rec'); await sleep(1200); await pageG.click('#stop');
  await pageG.waitForSelector('#sk');
  await pageG.click('#save');
  await pageG.waitForSelector('.rec-hero:has-text("reading is ready")');
  await pageG.click('#home');
  const preSync = {
    a: await page.evaluate(async () => (await DB.readings.all()).length),
    g: await pageG.evaluate(async () => (await DB.readings.all()).length),
  };
  // device A starts and shows its code
  await page.click('#gate'); await enterPin(page, '1234');
  await page.click('.home-card:has-text("Keep it safe")');
  await page.click('#syncbtn');
  await page.click('#mkoffer');
  await page.waitForFunction(() => { const n = document.querySelector('#mycode'); return n && n.value.length > 50; });
  const offerCode = await page.$eval('#mycode', n => n.value);
  // device G answers with its reply code
  await pageG.click('.home-card:has-text("Keep it safe")');
  await pageG.click('#syncbtn');
  await pageG.click('#haveoffer');
  await pageG.fill('#theirs', offerCode);
  await pageG.click('#accept');
  await pageG.waitForFunction(() => { const n = document.querySelector('#mycode'); return n && n.value.length > 50; });
  const answerCode = await pageG.$eval('#mycode', n => n.value);
  // back on A: enter the reply → channel opens → both merge
  await page.fill('#theirs', answerCode);
  await page.click('#accept');
  await page.waitForSelector('.sync-done', { timeout: 30000 });
  await pageG.waitForSelector('.sync-done', { timeout: 30000 });
  const postSync = {
    a: await page.evaluate(async () => (await DB.readings.all()).length),
    g: await pageG.evaluate(async () => (await DB.readings.all()).length),
  };
  assert(postSync.a === postSync.g, 'both devices hold the same number of readings (' + postSync.a + ' vs ' + postSync.g + ')');
  assert(postSync.a === preSync.a + preSync.g, 'merge is lossless: ' + preSync.a + ' + ' + preSync.g + ' = ' + postSync.a);
  const gGot = await pageG.evaluate(async () => {
    const corners = await DB.corners.all();
    const mei = corners.find(c => c.name === 'Mei');
    const books = await DB.books.all(mei && mei.id);
    return { hasMei: !!mei, hasMoon: books.some(b => b.title === 'Goodnight Moon'), corners: corners.length };
  });
  assert(gGot.hasMei && gGot.hasMoon, "Zoe's device received Mei's corner and book");
  const aGot = await page.evaluate(async () => {
    const corners = await DB.corners.all();
    const zoe = corners.find(c => c.name === 'Zoe');
    const told = zoe ? await DB.readings.told(zoe.id) : [];
    return { hasZoe: !!zoe, hasComet: told.some(r => r.title === 'Zoe and the Comet') };
  });
  assert(aGot.hasZoe && aGot.hasComet, "device A received Zoe's corner and told story");
  // synced audio actually plays on the receiving side
  await page.click('#home2');            // A: done → home
  await pageG.click('#home2');           // G: done → home
  await pageG.click('#to-kid');
  await pageG.waitForSelector('.corner-pills');
  await pageG.click('.corner-pill:has-text("Mei")');
  await pageG.click('.tile:has-text("Goodnight Moon")');
  await pageG.waitForSelector('.p-stage.spread');
  await pageG.click('#pp');
  await pageG.waitForFunction(() => window.App.player.audio && window.App.player.audio.currentTime > 0.2);
  // and syncing again finds nothing to do (idempotent) — checked via delta counts
  const deltaCheck = await pageG.evaluate(async invA => {
    const { counts } = await Backup.exportDelta(invA.r, invA.b);
    return counts;
  }, await page.evaluate(async () => {
    const [r, b] = await Promise.all([DB.readings.all(), DB.books.all()]);
    return { r: r.map(x => x.id), b: b.map(x => x.id) };
  }));
  assert(deltaCheck.readings === 0 && deltaCheck.books === 0, 'a second sync would have nothing to carry');
  await ctxG.close();
  // A's "done" button already landed it on grown-up home — ready for the next steps

  step('HARDEN: a corrupted backup zip is refused whole — nothing written');
  const corrupted = fs.readFileSync(zipPath);
  corrupted[Math.floor(corrupted.length * 0.4)] ^= 0xFF; // bit-rot one byte in an entry
  const corruptPath = path.join(TMP, 'backup-corrupted.zip');
  fs.writeFileSync(corruptPath, corrupted);
  const preCounts = await page.evaluate(async () => ({
    r: (await DB.readings.all()).length, b: (await DB.books.all()).length, c: (await DB.corners.all()).length,
  }));
  await page.click('.home-card:has-text("Keep it safe")');
  await page.waitForSelector('#storagestatus'); // storage honesty line under Keep it safe
  await page.setInputFiles('#restorefile', corruptPath);
  await page.waitForSelector('.toast.show');
  const corruptToast = await page.textContent('.toast');
  assert(/damaged|checksum|zip/i.test(corruptToast), 'corrupted zip called out honestly (got: ' + corruptToast + ')');
  const postCounts = await page.evaluate(async () => ({
    r: (await DB.readings.all()).length, b: (await DB.books.all()).length, c: (await DB.corners.all()).length,
  }));
  assert(JSON.stringify(preCounts) === JSON.stringify(postCounts), 'database untouched by the refused restore');

  step('HARDEN: a hostile invite payload renders inert (no crash, no markup)');
  const hostile = Buffer.from(JSON.stringify({ kid: { x: 1 }, book: 123, note: '<img src=x onerror=window.__pwned=1>' }), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const hostilePage = await ctxA.newPage();
  hostilePage.on('pageerror', e => errors.push('hostile: ' + e.message));
  await hostilePage.goto(`http://localhost:${PORT}/app/#invite=${hostile}`);
  await hostilePage.waitForSelector('h1.screen-title');
  assert((await hostilePage.textContent('h1.screen-title')).includes('someone little'), 'non-string fields fall back to safe defaults');
  assert(!(await hostilePage.$('.card img')), 'note markup is escaped, never parsed');
  assert(!(await hostilePage.evaluate(() => window.__pwned)), 'no script ran from the payload');
  await hostilePage.close();

  await ctxA.close();

  // ============ capability + boot-failure degradation ============
  const ctxC = await browser.newContext({ viewport: { width: 390, height: 844 } });
  step('HARDEN: no MediaRecorder → capture panel degrades to import-only');
  const pageC = await ctxC.newPage();
  pageC.on('pageerror', e => errors.push('C: ' + e.message));
  await pageC.addInitScript(() => { try { delete window.MediaRecorder; } catch (e) { window.MediaRecorder = undefined; } });
  await pageC.goto(inviteHref);
  await pageC.waitForSelector('.rec-hero');
  assert(!(await pageC.$('#rec')), 'no dead record button');
  assert((await pageC.textContent('.rec-hero')).includes('can’t record directly'), 'honest capability note');
  assert(await pageC.$('#imp'), 'import path still offered');
  await pageC.close();

  step('HARDEN: a broken database opens a calm failure screen, not a blank page');
  const pageC2 = await ctxC.newPage();
  await pageC2.addInitScript(() => { indexedDB.open = () => { throw new Error('boom'); }; });
  await pageC2.goto(`http://localhost:${PORT}/app/`);
  await pageC2.waitForSelector('.card:has-text("a hiccup, not a loss")');
  assert((await pageC2.textContent('.card')).includes('still stored'), 'reassures that data is intact');
  assert(await pageC2.$('#retry'), 'offers a retry');
  await pageC2.close();
  await ctxC.close();

  // ============ PART B: in-place v1 → v2 IndexedDB migration ============
  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pageB = await ctxB.newPage();
  pageB.on('pageerror', e => errors.push('B: ' + e.message));

  step('seed a real v1 database (audio inline on the reading, cornerName setting)');
  await pageB.goto(`http://localhost:${PORT}/blank.html`);
  const wavB64 = makeWav(1).toString('base64');
  await pageB.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const audioBlob = new Blob([bytes], { type: 'audio/wav' });
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('catherines-corner', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('readers', { keyPath: 'id' });
        d.createObjectStore('books', { keyPath: 'id' });
        const s = d.createObjectStore('readings', { keyPath: 'id' });
        s.createIndex('byBook', 'bookId'); s.createIndex('byReader', 'readerId');
        d.createObjectStore('requests', { keyPath: 'id' });
        d.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    await new Promise((res, rej) => {
      const t = db.transaction(['readers', 'books', 'readings', 'settings'], 'readwrite');
      t.objectStore('settings').put({ key: 'cornerName', value: 'Mei' });
      t.objectStore('settings').put({ key: 'alphaAck', value: 1 });
      t.objectStore('settings').put({ key: 'pin', value: '1234' });
      t.objectStore('readers').put({ id: 'r-dad', name: 'Dad', relationship: 'Dad', color: '#34557A', createdAt: 1 });
      t.objectStore('books').put({ id: 'b-moon', title: 'Old Moon Book', cover: null, pages: [], createdAt: 1 });
      t.objectStore('readings').put({ id: 'rd-1', bookId: 'b-moon', readerId: 'r-dad', title: null, episodeIndex: null,
        audioBlob, duration: 1, imported: false, pageTurns: [], skipRanges: [], isNew: false, createdAt: 2 });
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
    db.close();
  }, wavB64);

  step('open the new app → migration runs → shelf shows the old book');
  await pageB.goto(`http://localhost:${PORT}/app/`);
  await pageB.waitForSelector('.tile:has-text("Old Moon Book")');
  const mig = await pageB.evaluate(async () => {
    const corners = await DB.corners.all();
    const active = await DB.corners.active();
    const reading = await DB.readings.get('rd-1');
    const book = await DB.books.get('b-moon');
    const blob = await DB.audio.get('rd-1');
    return {
      corners: corners.length, activeName: active && active.name,
      readingCorner: reading.cornerId === (active && active.id),
      bookCorner: book.cornerId === (active && active.id),
      inline: 'audioBlob' in reading, blobSize: blob ? blob.size : 0,
    };
  });
  assert(mig.corners === 1 && mig.activeName === 'Mei', 'one corner "Mei" from cornerName (got ' + JSON.stringify(mig) + ')');
  assert(mig.readingCorner && mig.bookCorner, 'rows stamped with the corner');
  assert(!mig.inline && mig.blobSize > 4000, 'audio lifted out of the reading row into the audio store');

  step('migrated reading still plays');
  await pageB.click('.tile:has-text("Old Moon Book")');
  await pageB.waitForSelector('.p-stage');
  await pageB.click('#pp');
  await pageB.waitForFunction(() => window.App.player.audio && window.App.player.audio.currentTime > 0.2);

  await ctxB.close();

  // ============ PART C: v2 → v3 migration (what LIVE users on v1.7.1 hit) ============
  const ctxD = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pageD = await ctxD.newPage();
  pageD.on('pageerror', e => errors.push('D: ' + e.message));

  step('seed a real v2 database (corners + audio store, no metrics) → v3 adds counting only');
  await pageD.goto(`http://localhost:${PORT}/blank.html`);
  await pageD.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('catherines-corner', 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('readers', { keyPath: 'id' });
        d.createObjectStore('books', { keyPath: 'id' });
        const s = d.createObjectStore('readings', { keyPath: 'id' });
        s.createIndex('byBook', 'bookId'); s.createIndex('byReader', 'readerId');
        d.createObjectStore('requests', { keyPath: 'id' });
        d.createObjectStore('settings', { keyPath: 'key' });
        d.createObjectStore('corners', { keyPath: 'id' });
        d.createObjectStore('audio', { keyPath: 'id' });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    await new Promise((res, rej) => {
      const t = db.transaction(['readers', 'books', 'readings', 'settings', 'corners', 'audio'], 'readwrite');
      t.objectStore('settings').put({ key: 'alphaAck', value: 1 });
      t.objectStore('settings').put({ key: 'activeCornerId', value: 'c-mei' });
      t.objectStore('corners').put({ id: 'c-mei', name: 'Mei', createdAt: 1 });
      t.objectStore('readers').put({ id: 'r-dad', name: 'Dad', relationship: 'Dad', color: '#34557A', createdAt: 1 });
      t.objectStore('books').put({ id: 'b-v2', title: 'The v2 Book', cornerId: 'c-mei', pageFormat: 'single', cover: null, pages: [], createdAt: 1 });
      t.objectStore('readings').put({ id: 'rd-v2', bookId: 'b-v2', readerId: 'r-dad', cornerId: 'c-mei', title: null, episodeIndex: null,
        duration: 1, imported: false, pageTurns: [], skipRanges: [], isNew: false, createdAt: 2 });
      t.objectStore('audio').put({ id: 'rd-v2', blob: new Blob([bytes], { type: 'audio/wav' }) });
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
    db.close();
  }, wavB64);
  await pageD.goto(`http://localhost:${PORT}/app/`);
  await pageD.waitForSelector('.tile:has-text("The v2 Book")');
  const v2mig = await pageD.evaluate(async () => {
    await DB.metrics.bump('e2e.migration_probe');
    const rows = await DB.metrics.all();
    const blob = await DB.audio.get('rd-v2');
    return { metricsWork: rows.some(r => r.key === 'e2e.migration_probe'), blobSize: blob ? blob.size : 0 };
  });
  assert(v2mig.metricsWork, 'metrics store created by v2→v3 upgrade and counting works');
  assert(v2mig.blobSize > 4000, 'v2 data untouched by the upgrade');
  await pageD.click('.tile:has-text("The v2 Book")');
  await pageD.waitForSelector('.p-stage');
  await pageD.click('#pp');
  await pageD.waitForFunction(() => window.App.player.audio && window.App.player.audio.currentTime > 0.2);
  await ctxD.close();

  // ============ PART E: the app updates itself when a new version ships ============
  const ctxH = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pageH = await ctxH.newPage();
  pageH.on('pageerror', e => errors.push('H: ' + e.message));

  step('SELF-UPDATE: a controlled page notices a new release and reloads itself when idle');
  await pageH.goto(`http://localhost:${PORT}/app/`);
  await pageH.click('#ack');
  await sleep(1000);             // let the first SW install + claim settle
  await pageH.reload();          // now the page starts CONTROLLED — the normal state for an existing user
  await pageH.waitForSelector('.empty');
  assert(await pageH.evaluate(() => !!navigator.serviceWorker.controller), 'page is service-worker controlled');
  assert(await pageH.evaluate(() => App.updateSafe()), 'idle shelf is safe to refresh');
  swTag = 'cc-e2e-update';       // ship a "new release"
  await pageH.evaluate(() => { window.__preUpdate = true; navigator.serviceWorker.ready.then(r => r.update()); });
  await pageH.waitForFunction(() => window.__preUpdate === undefined, null, { timeout: 20000 });   // it reloaded itself
  await pageH.waitForSelector('.empty');
  assert(await pageH.evaluate(async () => !!(await DB.settings.get('alphaAck'))), 'IndexedDB untouched by the self-update');
  swTag = null;
  await ctxH.close();

  await browser.close();
  server.close();

  if (errors.length) {
    console.error('\nPAGE ERRORS:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log('\nALL ' + stepNo + ' STEPS GREEN ✅');
})().catch(e => { console.error('\n💥 ' + e.stack); process.exit(1); });
