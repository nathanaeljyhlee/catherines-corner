/* Catherine's Corner — local-first storage (IndexedDB).
   Aggregates per spec: Reader · Book (owns pages) · Reading (owns audio + timing) · BookRequest.
   Blobs live in the row; metadata is plain fields. Export is first-class (permanence anti-pattern 8). */

const DB_NAME = 'catherines-corner';
const DB_VERSION = 1;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
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

function getOne(store, id) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

function put(store, obj) { return tx(store, 'readwrite', s => { s.put(obj); return obj; }); }
function del(store, id) { return tx(store, 'readwrite', s => { s.delete(id); }); }

function uid() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

const DBAPI = {
  readers: {
    all: () => getAll('readers'),
    get: id => getOne('readers', id),
    save: r => put('readers', r),
    remove: id => del('readers', id),
  },
  books: {
    all: () => getAll('books'),
    get: id => getOne('books', id),
    save: b => put('books', b),
    remove: id => del('books', id),
  },
  readings: {
    all: () => getAll('readings'),
    get: id => getOne('readings', id),
    save: r => put('readings', r),
    remove: id => del('readings', id),
    forBook: async bookId => (await getAll('readings')).filter(r => r.bookId === bookId),
    told: async () => (await getAll('readings')).filter(r => !r.bookId),
  },
  requests: {
    all: () => getAll('requests'),
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
