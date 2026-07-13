/* Catherine's Corner — local-first storage (IndexedDB), schema v2.
   Aggregates per spec: Corner (a child's shelf) · Reader (global — people read
   to every child) · Book (owns pages, belongs to a corner) · Reading (timing +
   metadata, belongs to a corner) · BookRequest (belongs to a corner).

   v2 structural decisions, both for pilot scale:
   - Audio lives in its own store keyed by reading id. Reading rows are light
     metadata, so shelf/home/library screens never haul megabytes of blobs
     into memory just to count or list things.
   - Corners are first-class rows, not a single settings string — one device
     can hold a shelf per child, and every book/reading/request is scoped to
     its corner. v1 data is migrated in place (one corner, everything filed
     under it) the first time the new code opens the database. */

const DB_NAME = 'catherines-corner';
const DB_VERSION = 3;   // v3 adds the metrics store (usage counters — counts only, never content)

let _db = null;

function uid() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

// v1 → v2, inside the versionchange transaction (plain IDB callbacks only —
// awaiting anything foreign here would let the transaction close under us).
function migrateV1(t) {
  const settings = t.objectStore('settings');
  const corners = t.objectStore('corners');
  const cornerId = uid();
  const nameReq = settings.get('cornerName');
  nameReq.onsuccess = () => {
    const name = nameReq.result && nameReq.result.value;
    if (name) {
      corners.put({ id: cornerId, name, createdAt: Date.now() });
      settings.put({ key: 'activeCornerId', value: cornerId });
    }
    const stamp = store => {
      const cur = t.objectStore(store).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        const row = c.value;
        if (name && row.cornerId == null) { row.cornerId = cornerId; c.update(row); }
        c.continue();
      };
    };
    stamp('books');
    stamp('requests');
    // readings: stamp the corner AND lift the audio blob into its own store
    const audio = t.objectStore('audio');
    const cur = t.objectStore('readings').openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      const row = c.value;
      if (row.audioBlob) { audio.put({ id: row.id, blob: row.audioBlob }); delete row.audioBlob; }
      if (name && row.cornerId == null) row.cornerId = cornerId;
      c.update(row);
      c.continue();
    };
  };
}

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = req.result;
      if (!db.objectStoreNames.contains('readers')) db.createObjectStore('readers', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('readings')) {
        const s = db.createObjectStore('readings', { keyPath: 'id' });
        s.createIndex('byBook', 'bookId');
        s.createIndex('byReader', 'readerId');
      }
      if (!db.objectStoreNames.contains('requests')) db.createObjectStore('requests', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('corners')) db.createObjectStore('corners', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('metrics')) db.createObjectStore('metrics', { keyPath: 'key' });
      if (e.oldVersion >= 1 && e.oldVersion < 2) migrateV1(req.transaction);
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error || new Error('The library on this device couldn’t be opened.'));
    // Another tab holding an older schema blocks the upgrade forever — say so
    // instead of hanging on a blank screen.
    req.onblocked = () => reject(new Error('Catherine’s Corner is open in another tab — close it and reopen this one. Nothing is lost.'));
  });
}

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
  }));
}

function getAll(store) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

function getAllByIndex(store, index, key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).index(index).getAll(key);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

function getOne(store, id) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

function put(store, obj) { return tx(store, 'readwrite', s => { s.put(obj); return obj; }); }
function del(store, id) { return tx(store, 'readwrite', s => { s.delete(id); }); }

// Corner scoping: rows are filtered in JS after a cheap metadata getAll —
// explicit, and rows never vanish behind a sparse index.
const inCorner = (rows, cornerId) => cornerId == null ? rows : rows.filter(r => r.cornerId === cornerId);

const DBAPI = {
  corners: {
    all: () => getAll('corners'),
    get: id => getOne('corners', id),
    save: c => put('corners', c),
    remove: id => del('corners', id),
    // The corner whose shelf is showing. Falls back to the first corner and
    // heals the pointer, so a deleted/never-set active id can't strand the UI.
    async active() {
      const [corners, activeId] = await Promise.all([getAll('corners'), DBAPI.settings.get('activeCornerId')]);
      if (!corners.length) return null;
      const hit = corners.find(c => c.id === activeId);
      if (hit) return hit;
      const first = corners.sort((a, b) => a.createdAt - b.createdAt)[0];
      await DBAPI.settings.set('activeCornerId', first.id);
      return first;
    },
    setActive: id => DBAPI.settings.set('activeCornerId', id),
  },
  readers: {
    all: () => getAll('readers'),
    get: id => getOne('readers', id),
    save: r => put('readers', r),
    remove: id => del('readers', id),
  },
  books: {
    all: async cornerId => inCorner(await getAll('books'), cornerId),
    get: id => getOne('books', id),
    save: b => put('books', b),
    remove: id => del('books', id),
  },
  readings: {
    all: async cornerId => inCorner(await getAll('readings'), cornerId),
    get: id => getOne('readings', id),
    save: r => put('readings', r),
    remove: async id => { await del('readings', id); await del('audio', id); },
    forBook: bookId => getAllByIndex('readings', 'byBook', bookId),
    told: async cornerId => inCorner(await getAll('readings'), cornerId).filter(r => !r.bookId),
    // The one write that must never half-happen: reading metadata and its
    // voice land in ONE transaction (a quota abort rolls both back — no
    // orphan rows), then the audio is read back to prove the browser really
    // kept it before anyone is told "saved".
    async saveWithAudio(reading, blob) {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const t = db.transaction(['readings', 'audio'], 'readwrite');
        t.objectStore('audio').put({ id: reading.id, blob });
        t.objectStore('readings').put(reading);
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error || new Error('save failed'));
        t.onabort = () => reject(t.error || new Error('save aborted'));
      });
      const back = await DBAPI.audio.get(reading.id);
      if (!back || back.size !== blob.size) {
        await DBAPI.readings.remove(reading.id).catch(() => {});
        throw new Error('The recording didn’t survive the write — nothing was saved.');
      }
      return reading;
    },
  },
  // A reading's voice, fetched only when something actually plays or exports.
  audio: {
    get: async readingId => { const row = await getOne('audio', readingId); return row ? row.blob : null; },
    set: (readingId, blob) => put('audio', { id: readingId, blob }),
    remove: readingId => del('audio', readingId),
  },
  requests: {
    all: async cornerId => inCorner(await getAll('requests'), cornerId),
    get: id => getOne('requests', id),
    save: r => put('requests', r),
    remove: id => del('requests', id),
  },
  settings: {
    get: async key => { const row = await getOne('settings', key); return row ? row.value : null; },
    set: (key, value) => put('settings', { key, value }),
  },
  // This install's shareable identity — the "account id" until real accounts
  // exist (ADR-001). Family give it to each other so parcels can be addressed;
  // it names the install, never a person, and travels nowhere on its own.
  async familyId() {
    let id = await DBAPI.settings.get('familyId');
    if (!id) {
      const chunk = () => Math.random().toString(36).slice(2, 6).toUpperCase();
      id = 'CC-' + chunk() + '-' + chunk();
      await DBAPI.settings.set('familyId', id);
    }
    return id;
  },
  // Usage counters, so pain points show up as numbers instead of guesses.
  // Counts only — event names like 'record.audio_imported', never recordings,
  // names, or titles. Everything stays on this device; a grown-up can share a
  // snapshot from the "what gets used" screen. Counting must never break the
  // app: bump() is fire-and-forget and swallows its own failures.
  metrics: {
    async bump(key) {
      try {
        const db = await openDB();
        await new Promise((resolve, reject) => {
          const t = db.transaction('metrics', 'readwrite');
          const s = t.objectStore('metrics');
          const req = s.get(key);
          req.onsuccess = () => {
            const now = Date.now();
            const day = new Date(now).toISOString().slice(0, 10);
            const row = req.result || { key, n: 0, first: now, days: {} };
            row.n++; row.last = now;
            row.days[day] = (row.days[day] || 0) + 1;
            const dayKeys = Object.keys(row.days).sort();     // keep a 60-day window
            while (dayKeys.length > 60) delete row.days[dayKeys.shift()];
            s.put(row);
          };
          t.oncomplete = resolve;
          t.onerror = () => reject(t.error);
        });
      } catch (e) { /* a lost count is fine; a broken flow is not */ }
    },
    all: () => getAll('metrics'),
    reset: () => openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction('metrics', 'readwrite');
      t.objectStore('metrics').clear();
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    })),
  },
  // Ask the browser to treat the corner as must-keep, and report honestly
  // whether it agreed (surfaced under "Keep it safe").
  async requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
    } catch (e) { /* not offered here */ }
    return null;
  },
  async storageStatus() {
    const out = { persisted: null, usage: null, quota: null };
    try { if (navigator.storage && navigator.storage.persisted) out.persisted = await navigator.storage.persisted(); } catch (e) {}
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        out.usage = e.usage ?? null; out.quota = e.quota ?? null;
      }
    } catch (e) {}
    return out;
  },
  uid,
};

window.DB = DBAPI;
