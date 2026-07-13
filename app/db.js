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
const DB_VERSION = 2;

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
      if (e.oldVersion >= 1 && e.oldVersion < 2) migrateV1(req.transaction);
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
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
  uid,
};

window.DB = DBAPI;
