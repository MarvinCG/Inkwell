// Sync client. Offline-first: every change is saved locally and marked dirty; a sync pushes dirty
// items and pulls whatever changed elsewhere. Two backends:
//   • 'github' — a private GitHub repository (see github.js); per-item version = git blob sha
//   • 'server' — the bundled Inkwell server (server/server.js); per-item version = server revision
// Conflicts (the same note edited on two devices between syncs) never lose work: the remote copy
// keeps the original note and the local version is saved as "… (conflict copy)".

import { store, uid } from './store.js';
import { GitHubRepo, extractMedia, mediaRefs, inlineMedia, itemPath, mediaPath } from './github.js';

const PUSH_BATCH_BYTES = 8e6;

function wire(it) {
  return { id: it.id, type: it.type, baseRev: it.baseRev || 0, updatedAt: it.updatedAt, deleted: !!it.deleted, data: it.deleted ? null : it.data };
}
function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux/.test(ua)) return 'Linux';
  if (/Mac/.test(ua)) return 'Mac';
  return 'browser';
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

export class Sync {
  constructor({ decorate, beforeSync, onStatus, onConflict }) {
    this.decorate = decorate || ((x) => x);
    this.beforeSync = beforeSync;
    this.onStatus = onStatus;
    this.onConflict = onConflict;
    this.state = 'off';
    this.message = '';
    this.running = null;
    this.again = false;
    this.timer = 0;
    this.lastPush = 0;
  }

  // ───────── configuration ─────────
  get mode() { return store.getMeta('syncMode', location.hostname.endsWith('github.io') ? 'github' : 'server'); }
  get url() { return (store.getMeta('serverUrl', '') || '').trim(); }
  get token() { return (store.getMeta('syncToken', '') || '').trim(); }
  get ghRepo() { return (store.getMeta('ghRepo', 'MarvinCG/inkwell-data') || '').trim(); }
  get ghToken() { return (store.getMeta('ghToken', '') || '').trim(); }
  get auto() { return store.getMeta('autoSync', true) !== false; }
  configured() {
    if (this.mode === 'github') return !!(this.ghToken && this.ghRepo);
    if (this.mode === 'server') return !!this.token;
    return false;
  }
  base() {
    const u = this.url;
    if (!u) return new URL('./', location.href).href;
    return u.endsWith('/') ? u : u + '/';
  }
  github(repo = this.ghRepo, token = this.ghToken) {
    return new GitHubRepo({ repo, token, api: store.getMeta('ghApi', 'https://api.github.com') });
  }

  setStatus(state, message = '') {
    this.state = state;
    this.message = message;
    this.onStatus && this.onStatus(state, message);
  }

  // ───────── scheduling ─────────
  schedule(ms = 2500) {
    if (!this.configured() || !this.auto) return;
    // GitHub: batch edits into fewer commits (and stay far below its write rate limits).
    if (this.mode === 'github') ms = Math.max(ms, 12000, 15000 - (Date.now() - this.lastPush));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.syncNow(true), ms);
  }

  start() {
    const tick = () => { if (document.visibilityState === 'visible' && navigator.onLine !== false) this.syncNow(true); };
    setInterval(tick, 60000);
    window.addEventListener('online', () => this.syncNow(true));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.syncNow(true); });
    if (!this.configured()) this.setStatus('off');
    else this.syncNow(true);
  }

  async syncNow(quiet = false) {
    if (!this.configured()) { this.setStatus('off'); return; }
    if (this.running) { this.again = true; return this.running; }
    clearTimeout(this.timer);
    this.running = (async () => {
      if (!quiet || this.state !== 'ok') this.setStatus('syncing');
      try {
        if (this.beforeSync) await this.beforeSync();
        const pulled = this.mode === 'github' ? await this.runGitHub() : await this.runServer();
        await store.setMeta('lastSyncAt', Date.now());
        this.setStatus('ok', pulled ? `Synced · ${pulled} update${pulled === 1 ? '' : 's'}` : 'Synced');
      } catch (e) {
        console.warn('[sync]', e);
        this.setStatus(e.code === 'offline' ? 'offline' : 'error', e.message || String(e));
      } finally {
        this.running = null;
        if (this.again) { this.again = false; setTimeout(() => this.syncNow(true), 300); }
      }
    })();
    return this.running;
  }

  // ───────── shared merge logic ─────────
  fromRemote(it, rev) {
    return this.decorate({
      id: it.id, type: it.type, rev, baseRev: rev, updatedAt: it.updatedAt,
      deleted: !!it.deleted, data: it.deleted ? null : (it.data || null), dirty: false,
    });
  }

  /** Local item was edited, and so was the remote copy. Returns { puts, again }. */
  resolveConflict(local, remote, rev) {
    if (!local || local.deleted || !local.dirty) return { puts: [this.fromRemote(remote, rev)] };
    // Deleted elsewhere but edited here: the edit wins (uploaded again).
    if (remote.deleted) return { puts: [{ ...local, baseRev: rev }], again: true };
    if (JSON.stringify(local.data) === JSON.stringify(remote.data)) return { puts: [this.fromRemote(remote, rev)] };
    const puts = [this.fromRemote(remote, rev)];
    if (local.type === 'note') {
      const title = (local.data && local.data.title) || 'Untitled';
      puts.push(this.decorate({
        ...local, id: uid(), baseRev: 0, rev: 0, dirty: true, deleted: false, updatedAt: Date.now(),
        data: { ...local.data, title: `${title} (conflict copy)` },
      }));
      this.onConflict && this.onConflict(title);
    }
    return { puts, again: local.type === 'note' };
  }

  // ───────── backend: GitHub repository ─────────
  async runGitHub() {
    const gh = this.github();
    let pulled = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      let head = await gh.head();
      if (!head) { await gh.init(); head = await gh.head(); }
      const dirtyNow = store.dirty();
      if (head === store.getMeta('ghHead', null) && !dirtyNow.length) return pulled;

      const { treeSha, entries } = await gh.treeOf(head);
      const remote = new Map();   // item id → blob sha
      const mediaSha = new Map(); // media hash → blob sha
      for (const e of entries) {
        let m = /^items\/([\w-]{1,64})\.json$/.exec(e.path);
        if (m) { remote.set(m[1], e.sha); continue; }
        m = /^media\/([a-z0-9]+)\.txt$/.exec(e.path);
        if (m) mediaSha.set(m[1], e.sha);
      }

      // ── pull ──
      const pending = new Map();
      const cur = (id) => pending.get(id) || store.get(id);
      let deferred = false;
      const changed = [...remote].filter(([id, sha]) => { const l = store.get(id); return !l || l.baseRev !== sha; });
      const fetched = await pool(changed, 6, async ([id, sha]) => {
        try { return { id, sha, item: JSON.parse(await gh.blob(sha)) }; } catch (e) { if (e.code) throw e; return { id, sha, item: null }; }
      });
      const mediaCache = new Map();
      for (const f of fetched) {
        if (!f.item || f.item.id !== f.id) continue;
        let item = f.item;
        if (item.type === 'note' && item.data && item.data.html) {
          const refs = mediaRefs(item.data.html);
          if (refs.length) {
            // reuse media we already hold in the local copy, download the rest
            const local = store.get(f.id);
            if (local && local.data && local.data.html) {
              const { media } = await extractMedia(local.data.html);
              for (const [h, u] of media) mediaCache.set(h, u);
            }
            const missing = refs.filter((h) => !mediaCache.has(h));
            if (missing.some((h) => !mediaSha.has(h))) { deferred = true; continue; } // media not uploaded yet
            await pool(missing, 4, async (h) => mediaCache.set(h, await gh.blob(mediaSha.get(h))));
            item = { ...item, data: { ...item.data, html: inlineMedia(item.data.html, mediaCache) } };
          }
        }
        const local = cur(f.id);
        if (local && local.dirty) {
          const r = this.resolveConflict(local, item, f.sha);
          for (const p of r.puts) pending.set(p.id, p);
        } else {
          pending.set(f.id, this.fromRemote(item, f.sha));
          pulled++;
        }
      }
      // Items that vanished from the repository were deleted on another device.
      for (const it of store.items.values()) {
        if (pending.has(it.id) || typeof it.baseRev !== 'string' || !it.baseRev || remote.has(it.id)) continue;
        if (it.deleted) { if (it.dirty) pending.set(it.id, { ...it, dirty: false, baseRev: null }); continue; }
        if (it.dirty) pending.set(it.id, { ...it, baseRev: null }); // edited here: upload it again
        else { pending.set(it.id, { id: it.id, type: it.type, updatedAt: Date.now(), deleted: true, dirty: false, baseRev: null, data: null }); pulled++; }
      }
      if (pending.size) await store.putMany([...pending.values()], 'sync');

      // ── push ──
      const files = [];
      const pushed = new Map(); // id → updatedAt snapshot
      const queuedMedia = new Set();
      let size = 0, more = false;
      for (const it of store.dirty()) {
        if (it.deleted) {
          if (remote.has(it.id)) files.push({ path: itemPath(it.id), content: null });
          pushed.set(it.id, it.updatedAt);
          continue;
        }
        let data = it.data;
        const add = [];
        if (it.type === 'note' && data && data.html) {
          const { html, media } = await extractMedia(data.html);
          data = { ...data, html };
          for (const [h, u] of media) if (!mediaSha.has(h) && !queuedMedia.has(h)) { add.push({ path: mediaPath(h), content: u }); queuedMedia.add(h); }
        }
        const json = JSON.stringify({ id: it.id, type: it.type, updatedAt: it.updatedAt, deleted: false, data });
        const bytes = json.length + add.reduce((n, f) => n + f.content.length, 0);
        if (files.length && size + bytes > PUSH_BATCH_BYTES) { more = true; for (const f of add) queuedMedia.delete(f.path.slice(6, -4)); break; }
        files.push(...add, { path: itemPath(it.id), content: json });
        pushed.set(it.id, it.updatedAt);
        size += bytes;
      }

      let newHead = head;
      if (files.length) {
        const n = pushed.size;
        newHead = await gh.commit(head, treeSha, files, `Inkwell: ${n} change${n === 1 ? '' : 's'} from ${deviceLabel()}`);
        if (!newHead) continue; // another device pushed first: pull its changes and try again
        this.lastPush = Date.now();
      }
      // Record the new versions (blob shas) of what we pushed.
      if (pushed.size) {
        const shas = new Map();
        if (files.length) {
          const { entries: after } = await gh.treeOf(newHead);
          for (const e of after) { const m = /^items\/([\w-]{1,64})\.json$/.exec(e.path); if (m) shas.set(m[1], e.sha); }
        }
        const done = [];
        for (const [id, snap] of pushed) {
          const it = store.get(id);
          if (!it) continue;
          const next = { ...it, baseRev: it.deleted ? null : (shas.get(id) || it.baseRev), rev: shas.get(id) || it.rev };
          if (it.updatedAt === snap) next.dirty = false; else more = true; // edited while syncing
          done.push(next);
        }
        await store.putMany(done, 'sync');
      }
      await store.setMeta('ghHead', deferred ? null : newHead);
      if (!more && !store.dirty().some((it) => !pushed.has(it.id))) return pulled;
    }
    return pulled;
  }

  // ───────── backend: Inkwell server ─────────
  async api(path, body, { timeout = 90000, token = this.token, base = this.base() } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(base + path, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        cache: 'no-store',
      });
      if (res.status === 401) throw Object.assign(new Error('The server rejected the sync token.'), { code: 'auth' });
      if (res.status === 429) throw Object.assign(new Error('Too many failed attempts — wait 15 minutes.'), { code: 'auth' });
      if (res.status === 413) throw Object.assign(new Error('A note is larger than the server allows (MAX_BODY_MB).'), { code: 'size' });
      if (!res.ok) throw Object.assign(new Error(`Server error ${res.status}`), { code: 'server' });
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError') throw Object.assign(new Error('The server did not answer in time.'), { code: 'offline' });
      if (e instanceof TypeError) throw Object.assign(new Error('Server unreachable (offline, or VPN off?).'), { code: 'offline' });
      throw e;
    } finally { clearTimeout(t); }
  }

  async runServer() {
    let rounds = 0, more = true, pulled = 0;
    while (more && rounds++ < 40) {
      more = false;
      const batch = [];
      let size = 0;
      for (const it of store.dirty()) {
        const w = wire(it);
        const len = JSON.stringify(w).length;
        if (batch.length && size + len > PUSH_BATCH_BYTES) { more = true; break; }
        batch.push({ w, id: it.id, updatedAt: it.updatedAt });
        size += len;
      }
      const snap = new Map(batch.map((b) => [b.id, b.updatedAt]));
      const since = store.getMeta('lastRev', 0) || 0;
      const res = await this.api('api/sync', { since, changes: batch.map((b) => b.w) });

      const pending = new Map();
      const cur = (id) => pending.get(id) || store.get(id);
      for (const a of res.accepted || []) {
        const it = cur(a.id);
        if (!it) continue;
        const next = { ...it, baseRev: a.rev, rev: a.rev };
        if (it.updatedAt === snap.get(a.id)) next.dirty = false; else more = true;
        pending.set(a.id, next);
      }
      const handled = new Set();
      for (const c of res.conflicts || []) {
        const r = this.resolveConflict(cur(c.id), c.server, c.server.rev);
        for (const p of r.puts) pending.set(p.id, p);
        handled.add(c.id);
        if (r.again) more = true;
      }
      for (const it of res.changes || []) {
        if (handled.has(it.id) || snap.has(it.id)) continue;
        const local = cur(it.id);
        if (local && local.dirty) { more = true; continue; }
        pending.set(it.id, this.fromRemote(it, it.rev));
        pulled++;
      }
      if (pending.size) await store.putMany([...pending.values()], 'sync');
      await store.setMeta('lastRev', res.rev);
      if (res.more) more = true;
      if (!more) more = store.dirty().some((it) => !snap.has(it.id) || snap.get(it.id) !== it.updatedAt);
    }
    return pulled;
  }

  // ───────── settings helpers ─────────
  async test({ mode, url, token, repo, ghToken }) {
    if (mode === 'github') {
      const gh = this.github(repo, ghToken);
      const info = await gh.info();
      const head = await gh.head();
      return { ...info, empty: !head };
    }
    const base = !url ? new URL('./', location.href).href : (url.endsWith('/') ? url : url + '/');
    return this.api('api/ping', null, { timeout: 15000, token, base });
  }

  /** Switched backend or server: upload everything we have, pull everything it has. */
  async resetForNewServer() {
    await store.setMeta('lastRev', 0);
    await store.setMeta('ghHead', null);
    const all = [...store.items.values()].map((it) => ({ ...it, dirty: true, baseRev: null, rev: null }));
    await store.putMany(all, 'sync');
  }
  async redownload() {
    await store.setMeta('lastRev', 0);
    await store.setMeta('ghHead', null);
    if (this.mode === 'github') {
      const all = [...store.items.values()].filter((it) => !it.dirty && typeof it.baseRev === 'string' && it.baseRev).map((it) => ({ ...it, baseRev: 'refetch' }));
      await store.putMany(all, 'sync');
    }
    return this.syncNow();
  }
}
