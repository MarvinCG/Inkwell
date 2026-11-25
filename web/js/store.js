// Local storage layer: IndexedDB, with an in-memory fallback when IDB is unavailable
// (private windows, sandboxed previews). Everything is also kept in a Map for fast reads.
//
// Item shape (both notes and folders):
//   { id, type: 'note'|'folder', updatedAt, deleted, dirty, baseRev, data, ...localOnly }
// `data` is what syncs. Local-only fields (text, preview, picture) are rebuilt on each device.

const DB_NAME = 'inkwell';
const DB_VERSION = 1;

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

class Store {
  constructor() {
    this.items = new Map();
    this.meta = new Map();
    this.db = null;
    this.persistent = false;
    this.listeners = new Set();
  }

  async init() {
    try {
      if (!('indexedDB' in self)) throw new Error('no idb');
      this.db = await new Promise((res, rej) => {
        const open = indexedDB.open(DB_NAME, DB_VERSION);
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        };
        open.onsuccess = () => res(open.result);
        open.onerror = () => rej(open.error);
        open.onblocked = () => rej(new Error('idb blocked'));
        setTimeout(() => rej(new Error('idb timeout')), 4000);
      });
      const tx = this.db.transaction(['items', 'meta'], 'readonly');
      const all = await req(tx.objectStore('items').getAll());
      for (const it of all) this.items.set(it.id, it);
      const keys = await req(tx.objectStore('meta').getAllKeys());
      const vals = await req(tx.objectStore('meta').getAll());
      keys.forEach((k, i) => this.meta.set(k, vals[i]));
      this.persistent = true;
    } catch (e) {
      console.warn('[store] IndexedDB unavailable, using memory only:', e);
      this.db = null;
      try {
        const raw = localStorage.getItem('inkwell.meta');
        if (raw) for (const [k, v] of Object.entries(JSON.parse(raw))) this.meta.set(k, v);
      } catch { /* ignore */ }
    }
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ids, source) { for (const fn of this.listeners) { try { fn(ids, source); } catch (e) { console.error(e); } } }

  get(id) { return this.items.get(id); }
  all(type) {
    const out = [];
    for (const it of this.items.values()) if ((!type || it.type === type) && !it.deleted) out.push(it);
    return out;
  }
  dirty() { return [...this.items.values()].filter((it) => it.dirty); }

  async put(item, source = 'local') { return this.putMany([item], source); }

  async putMany(list, source = 'local') {
    if (!list.length) return;
    for (const it of list) this.items.set(it.id, it);
    if (this.db) {
      try {
        const tx = this.db.transaction('items', 'readwrite');
        const os = tx.objectStore('items');
        for (const it of list) os.put(it);
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
      } catch (e) {
        console.error('[store] write failed', e);
        if (e && e.name === 'QuotaExceededError') this.emit([], 'quota');
      }
    }
    this.emit(list.map((i) => i.id), source);
  }

  async remove(id) {
    this.items.delete(id);
    if (this.db) {
      try { const tx = this.db.transaction('items', 'readwrite'); tx.objectStore('items').delete(id); } catch (e) { console.error(e); }
    }
  }

  getMeta(key, fallback) { return this.meta.has(key) ? this.meta.get(key) : fallback; }
  async setMeta(key, value) {
    this.meta.set(key, value);
    if (this.db) {
      try {
        const tx = this.db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put(value, key);
        await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; });
      } catch (e) { console.error(e); }
    } else {
      try { localStorage.setItem('inkwell.meta', JSON.stringify(Object.fromEntries(this.meta))); } catch { /* ignore */ }
    }
  }
}

export const store = new Store();

export function uid(len = 16) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (const b of a) s += chars[b % 36];
  return s;
}
