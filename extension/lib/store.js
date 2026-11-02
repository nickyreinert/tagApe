// IndexedDB access shared by the service worker (only writer of recording data) and the side panel (reader).
// Layout: docs/spec/data-model.md §2.
const DB_NAME = 'aajr';
const DB_VERSION = 2;
// chrome.storage.local `settings` defaults (data-model.md §4.8).
export const DEFAULT_SETTINGS = { schema_version: 1, detection: { custom_patterns: [] }, masking: { rules: [] }, retain_raw: true, active_filter_profile_id: null, active_funnel_id: null, pinned: [], favorites: [], title_field: null, screenshots: false };
export const SESSION_STORES = ['tabs', 'navigations', 'requests', 'events', 'screenshots'];

let dbp = null;
export function openDb() {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = (ev) => {
      // Forward-only migrations; never drop recording data (data-model.md §7).
      const db = r.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'session_id' }).createIndex('started_at', 'started_at');
        const tabs = db.createObjectStore('tabs', { keyPath: 'tab_id' });
        tabs.createIndex('session_id', 'session_id');
        tabs.createIndex('session_tab', ['session_id', 'browser_tab_id']);
        const navs = db.createObjectStore('navigations', { keyPath: 'navigation_id' });
        navs.createIndex('session_id', 'session_id');
        navs.createIndex('tab_id', 'tab_id');
        const reqs = db.createObjectStore('requests', { keyPath: 'capture_id' });
        reqs.createIndex('session_id', 'session_id');
        reqs.createIndex('dedup_key', 'dedup_key', { unique: true });
        const evs = db.createObjectStore('events', { keyPath: 'event_id' });
        evs.createIndex('session_id', 'session_id');
        evs.createIndex('session_time', ['session_id', 'timestamp']);
        evs.createIndex('capture_id', 'capture_id');
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      // v2: screenshots taken on user interaction (T-013); image stored as a JPEG Blob.
      if (ev.oldVersion < 2) {
        const shots = db.createObjectStore('screenshots', { keyPath: 'shot_id' });
        shots.createIndex('session_id', 'session_id');
      }
      r.transaction.objectStore('meta').put({ key: 'schema_version', value: DB_VERSION });
    };
    r.onsuccess = () => {
      r.result.onversionchange = () => { r.result.close(); dbp = null; };
      resolve(r.result);
    };
    r.onerror = () => { dbp = null; reject(r.error); };
  });
  return dbp;
}

export const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

// Runs fn inside one transaction; resolves with fn's value after the transaction commits.
export async function run(stores, mode, fn) {
  const t = (await openDb()).transaction(stores, mode);
  const finished = new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new DOMException('Transaction aborted', 'AbortError'));
  });
  try {
    const value = await fn(t);
    await finished;
    return value;
  } catch (e) {
    try { t.abort(); } catch { /* already finished */ }
    finished.catch(() => {});
    throw e;
  }
}

export const listSessions = () => run(['sessions'], 'readonly', (t) => req(t.objectStore('sessions').getAll()));
export const getSession = (id) => run(['sessions'], 'readonly', (t) => req(t.objectStore('sessions').get(id)));
export const bySession = (store, id) => run([store], 'readonly', (t) => req(t.objectStore(store).index('session_id').getAll(id)));

// One transaction over all stores (data-model.md §7).
export function deleteSession(id) {
  return run(['sessions', ...SESSION_STORES], 'readwrite', async (t) => {
    t.objectStore('sessions').delete(id);
    for (const name of SESSION_STORES) {
      const store = t.objectStore(name);
      for (const key of await req(store.index('session_id').getAllKeys(id))) store.delete(key);
    }
  });
}
export const countBySession = (store, id) => run([store], 'readonly', (t) => req(t.objectStore(store).index('session_id').count(id)));

// Removes every session and all its rows in one transaction (T-016).
export function deleteAllSessions() {
  return run(['sessions', ...SESSION_STORES], 'readwrite', (t) => {
    for (const name of ['sessions', ...SESSION_STORES]) t.objectStore(name).clear();
  });
}
