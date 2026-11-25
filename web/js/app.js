// Inkwell Notes — main app
import { store, uid } from './store.js';
import { Sync } from './sync.js';
import { InkLayer, PALETTE, DEFAULT_SIZES, renderThumb, drawStroke, bbox } from './ink.js';
import { sanitizeHTML, htmlToText, firstImage, escapeHTML } from './sanitize.js';
import { icon, hydrateIcons, setIcon } from './icons.js';
import { toast, showMenu, closeMenu, menuOpen, dialog, dialogOpen, confirmDialog, promptDialog } from './ui.js';

const VERSION = '1.2.1';
const FRAMED = (() => { try { return window.self !== window.top; } catch { return true; } })();
const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), sidebar: $('sidebar'), scrim: $('scrim'), nav: $('nav'),
  listView: $('listView'), listTitle: $('listTitle'), search: $('search'), notes: $('notes'), empty: $('empty'),
  trashBar: $('trashBar'), fab: $('fab'), btnMenu: $('btnMenu'), btnSync: $('btnSync'), btnSort: $('btnSort'), btnView: $('btnView'),
  editor: $('editorView'), btnBack: $('btnBack'), modeText: $('modeText'), modeDraw: $('modeDraw'), saveState: $('saveState'),
  btnUndo: $('btnUndo'), btnRedo: $('btnRedo'), btnFav: $('btnFav'), btnNoteMenu: $('btnNoteMenu'),
  textToolbar: $('textToolbar'), drawToolbar: $('drawToolbar'), swatches: $('swatches'), customColor: $('customColor'),
  sizeRange: $('sizeRange'), sizeDot: $('sizeDot'), btnPenOnly: $('btnPenOnly'),
  stage: $('stage'), scroller: $('scroller'), wrap: $('pageWrap'), page: $('page'), title: $('noteTitle'), body: $('noteBody'),
  ink: $('inkCanvas'), live: $('liveCanvas'), selBox: $('selBox'),
  zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomReset: $('zoomReset'), btnFull: $('btnFull'), fsHandle: $('fsHandle'),
  recBar: $('recBar'), recTime: $('recTime'), recStop: $('recStop'), recCancel: $('recCancel'),
  fileImage: $('fileImage'), fileImport: $('fileImport'), printArea: $('printArea'),
};

const FOLDER_COLORS = ['#f26b1d', '#e5484d', '#d6409f', '#8e4ec6', '#1f6feb', '#0b8a7a', '#2e9d44', '#f2b600', '#8d5a3b', '#5f6368'];
const TEXT_COLORS = ['#1a1a1a', '#e5484d', '#f26b1d', '#c99400', '#2e9d44', '#0b8a7a', '#1f6feb', '#8e4ec6', '#d6409f', '#8d5a3b', '#5f6368', null];
const HL_COLORS = ['#fff176', '#ffcc80', '#ef9a9a', '#f48fb1', '#ce93d8', '#90caf9', '#80deea', '#a5d6a7', '#e6ee9c', '#e0e0e0', '#bcaaa4', null];
const PATTERNS = [['none', 'Blank'], ['lined', 'Lined'], ['grid', 'Grid'], ['dots', 'Dots']];
const PAPERS = [['white', 'White'], ['cream', 'Cream'], ['mint', 'Mint'], ['sky', 'Sky']];
const TRASH_DAYS = 30;
const NARROW_PAGE = 480, WIDE_PAGE = 800;

const state = {
  view: 'all', query: '', current: null, draft: null, sessionNew: false,
  drawing: false, zoom: 1, fit: 1, pageWidth: WIDE_PAGE,
  editorDirty: false, inkDirty: false, range: null, listStale: false,
  installEvent: null, rec: null,
};
const pref = (k, d) => store.getMeta(k, d);
const setPref = (k, v) => store.setMeta(k, v);

// ═════════════════════════ helpers ═════════════════════════
const isDark = () => document.documentElement.dataset.theme === 'dark';
function hexLum(hex) {
  const m = /^#?([\da-f]{6})$/i.exec(hex || '');
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
/** Dark mode shows near-black ink as light (and white ink as dark), like Samsung Notes. */
function inkColor(c, t) {
  if (!isDark()) return c;
  const l = hexLum(c);
  if (l < 0.03) return '#ececec';
  if (l > 0.85 && t !== 'hl') return '#262626';
  return c;
}
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return fmtDate(ts);
}
const debounce = (fn, ms) => { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const narrowScreen = () => window.innerWidth < 700;

function decorate(item) {
  if (item.type !== 'note' || item.deleted || !item.data) return item;
  const d = item.data;
  item.text = htmlToText(d.html);
  item.picture = firstImage(d.html);
  item.preview = renderThumb(d.ink, d.pageWidth || WIDE_PAGE);
  return item;
}
function isEmptyData(d) {
  return !d.title && !(d.ink && d.ink.length) && !htmlToText(d.html) && !/<(img|audio)/i.test(d.html || '');
}
function noteTitle(it) {
  const d = it.data || {};
  if (d.title) return d.title;
  const line = (it.text || '').split('\n').find((l) => l.trim());
  if (line) return line.trim().slice(0, 80);
  if (d.ink && d.ink.length) return 'Handwritten note';
  return 'Untitled';
}
function folderById(id) { const f = id && store.get(id); return f && !f.deleted && f.type === 'folder' ? f : null; }
function folders() { return store.all('folder').sort((a, b) => (a.data.order ?? 0) - (b.data.order ?? 0) || a.data.name.localeCompare(b.data.name)); }

async function saveItem(item, source = 'local') {
  item.updatedAt = Date.now();
  item.dirty = true;
  await store.put(item, source);
  sync.schedule();
  requestPersistence();
}
async function updateNote(id, fn) {
  const cur = store.get(id);
  if (!cur) return;
  const item = { ...cur, data: { ...cur.data } };
  fn(item.data, item);
  await saveItem(item);
}
let persistAsked = false;
function requestPersistence() {
  if (persistAsked) return;
  persistAsked = true;
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* ignore */ }
}

// ═════════════════════════ theme ═════════════════════════
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const mode = pref('theme', 'system');
  const dark = mode === 'dark' || (mode === 'system' && darkMQ.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#151515' : '#f6f4f1'));
  if (ink) { ink.hlAlpha = dark ? 0.5 : 0.32; ink.renderNow(); updateSizeDot(); }
}
darkMQ.addEventListener('change', applyTheme);

// ═════════════════════════ sync ═════════════════════════
const sync = new Sync({
  decorate,
  beforeSync: () => saveNow(),
  onStatus: (s, msg) => {
    const prev = el.btnSync.dataset.state;
    el.btnSync.dataset.state = s;
    el.btnSync.title = s === 'off' ? 'Sync is off — tap to set up' : msg || s;
    if (s === 'error' && (prev !== 'error' || el.btnSync.dataset.lastError !== msg)) toast(msg || 'Sync failed');
    if (s === 'error') el.btnSync.dataset.lastError = msg;
  },
  onConflict: (title) => toast(`“${title}” was edited on two devices — kept both copies.`, { ms: 6000 }),
});

// ═════════════════════════ sidebar / nav ═════════════════════════
function openDrawer(open) {
  el.sidebar.classList.toggle('open', open);
  el.scrim.hidden = !open;
}
function renderNav() {
  const notes = store.all('note');
  const live = notes.filter((n) => !n.data.trashedAt);
  const count = { all: live.length, fav: live.filter((n) => n.data.favorite).length, trash: notes.length - live.length };
  const perFolder = new Map();
  for (const n of live) if (n.data.folderId) perFolder.set(n.data.folderId, (perFolder.get(n.data.folderId) || 0) + 1);
  const item = (view, ico, label, n, extra = '') =>
    `<button type="button" class="nav-item ${state.view === view ? 'active' : ''}" data-view="${view}">${ico}<span>${escapeHTML(label)}</span>${extra}<span class="count">${n || ''}</span></button>`;
  let html = item('all', icon('notes'), 'All notes', count.all) + item('fav', icon('star'), 'Favorites', count.fav);
  html += `<div class="nav-label"><span>Folders</span><button type="button" id="btnAddFolder" aria-label="New folder">${icon('folderPlus')}</button></div>`;
  for (const f of folders()) {
    html += item(`folder:${f.id}`, `<span class="fdot" style="background:${escapeHTML(f.data.color)}"></span>`, f.data.name, perFolder.get(f.id),
      `<span class="more" data-folder-menu="${f.id}" role="button" aria-label="Folder options">${icon('more')}</span>`);
  }
  if (!folders().length) html += '<div class="nav-label" style="text-transform:none;letter-spacing:0;padding-top:2px">No folders yet</div>';
  html += '<div style="height:10px"></div>' + item('trash', icon('trash'), 'Trash', count.trash);
  el.nav.innerHTML = html;
}
el.nav.addEventListener('click', (e) => {
  const fm = e.target.closest('[data-folder-menu]');
  if (fm) { e.stopPropagation(); folderMenu(fm, fm.dataset.folderMenu); return; }
  if (e.target.closest('#btnAddFolder')) { editFolder(); return; }
  const b = e.target.closest('[data-view]');
  if (b) { setView(b.dataset.view); openDrawer(false); }
});
function setView(v) {
  if (v.startsWith('folder:') && !folderById(v.slice(7))) v = 'all';
  state.view = v;
  setPref('view', v);
  renderNav();
  renderList(true);
}

// ═════════════════════════ notes list ═════════════════════════
const cardCache = new Map();
function visibleNotes() {
  const v = state.view;
  let list = store.all('note').filter((n) => {
    const d = n.data;
    if (v === 'trash') return !!d.trashedAt;
    if (d.trashedAt) return false;
    if (v === 'fav') return !!d.favorite;
    if (v.startsWith('folder:')) return d.folderId === v.slice(7);
    return true;
  });
  const q = state.query.trim().toLowerCase();
  if (q) {
    const terms = q.split(/\s+/);
    list = list.filter((n) => { const hay = `${n.data.title || ''}\n${n.text || ''}`.toLowerCase(); return terms.every((t) => hay.includes(t)); });
  }
  const sort = pref('sort', 'updated');
  if (sort === 'title') list.sort((a, b) => noteTitle(a).localeCompare(noteTitle(b), undefined, { sensitivity: 'base' }));
  else if (sort === 'created') list.sort((a, b) => (b.data.createdAt || 0) - (a.data.createdAt || 0));
  else list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list;
}
function miniHTML(it) {
  const d = it.data;
  const doc = new DOMParser().parseFromString(`<body>${d.html || ''}</body>`, 'text/html');
  const kids = [...doc.body.childNodes];
  kids.slice(30).forEach((k) => k.remove());
  doc.querySelectorAll('audio').forEach((a) => a.remove());
  doc.querySelectorAll('img').forEach((i) => i.setAttribute('decoding', 'async'));
  return doc.body.innerHTML;
}
function cardEl(it) {
  const d = it.data;
  const f = folderById(d.folderId);
  const cached = cardCache.get(it.id);
  const key = `${it.updatedAt}|${state.view === 'trash'}|${f ? f.updatedAt : 0}`;
  if (cached && cached.key === key) return cached.el;
  const pw = d.pageWidth || WIDE_PAGE;
  const a = document.createElement('article');
  a.className = 'card';
  a.tabIndex = 0;
  a.dataset.id = it.id;
  a.setAttribute('role', 'listitem');
  a.innerHTML = `
    <div class="card-thumb" data-pw="${pw}">
      <div class="page mini pat-${escapeHTML(d.pattern || 'none')} paper-${escapeHTML(d.paper || 'white')}" style="width:${pw}px">
        ${d.title ? `<div class="mini-title">${escapeHTML(d.title)}</div>` : ''}
        <div class="note-body">${miniHTML(it)}</div>
      </div>
      ${it.preview ? `<img class="ink-thumb" alt="" src="${it.preview}">` : ''}
    </div>
    <div class="card-meta">
      <div class="card-title">${escapeHTML(noteTitle(it))}</div>
      <div class="card-preview">${escapeHTML((it.text || '').replace(/\s+/g, ' ').slice(0, 140))}</div>
      <div class="card-sub">${f ? `<span class="fdot" style="background:${escapeHTML(f.data.color)}"></span>` : ''}<span>${fmtDate(state.view === 'trash' ? d.trashedAt : it.updatedAt)}</span>${d.favorite ? `<span class="star">${icon('star')}</span>` : ''}</div>
    </div>
    <button type="button" class="card-more" aria-label="Note options">${icon('more')}</button>`;
  cardCache.set(it.id, { key, el: a });
  return a;
}
function scaleMinis() {
  el.notes.querySelectorAll('.card-thumb').forEach((t) => {
    const w = t.clientWidth;
    if (!w) return;
    const k = w / +t.dataset.pw;
    if (t._k !== k) { t._k = k; t.firstElementChild.style.transform = `scale(${k})`; }
  });
}
new ResizeObserver(() => scaleMinis()).observe(el.notes);

function renderList(resetScroll = false) {
  if (!el.editor.hidden) { state.listStale = true; return; }
  state.listStale = false;
  const v = state.view;
  const f = v.startsWith('folder:') ? folderById(v.slice(7)) : null;
  el.listTitle.textContent = v === 'fav' ? 'Favorites' : v === 'trash' ? 'Trash' : f ? f.data.name : 'All notes';
  document.title = `${el.listTitle.textContent} · Inkwell`;
  const list = visibleNotes();
  el.trashBar.hidden = v !== 'trash' || !list.length;
  el.fab.hidden = v === 'trash';
  const layout = pref('layout', 'grid');
  el.notes.className = `notes ${layout}`;
  setIcon(el.btnView, layout === 'grid' ? 'list' : 'grid');
  const frag = document.createDocumentFragment();
  for (const it of list) frag.append(cardEl(it));
  el.notes.replaceChildren(frag);
  // drop cache entries for notes that no longer exist
  if (cardCache.size > list.length + 200) for (const id of cardCache.keys()) if (!store.get(id)) cardCache.delete(id);
  el.empty.hidden = list.length > 0;
  if (!list.length) {
    el.empty.innerHTML = state.query
      ? `${icon('search')}<div>No notes match “${escapeHTML(state.query)}”.</div>`
      : v === 'trash' ? `${icon('trash')}<div>Trash is empty.</div>`
        : v === 'fav' ? `${icon('star')}<div>No favorites yet.<br>Tap the star in a note to add it here.</div>`
          : `${icon('notes')}<div>No notes here yet.<br>Tap <b>+</b> to write one.</div>`;
  }
  if (resetScroll) el.notes.scrollTop = 0;
  requestAnimationFrame(scaleMinis);
}
const renderAll = debounce(() => { renderNav(); renderList(); }, 120);

el.search.addEventListener('input', debounce(() => { state.query = el.search.value; renderList(true); }, 120));
el.fab.addEventListener('click', () => newNote());
el.btnMenu.addEventListener('click', () => openDrawer(true));
el.scrim.addEventListener('click', () => openDrawer(false));
el.btnView.addEventListener('click', () => { setPref('layout', pref('layout', 'grid') === 'grid' ? 'list' : 'grid'); renderList(); });
el.btnSort.addEventListener('click', () => {
  const s = pref('sort', 'updated');
  const pick = (v) => { setPref('sort', v); renderList(true); };
  showMenu(el.btnSort, [
    { head: 'Sort by' },
    { label: 'Date modified', checked: s === 'updated', onClick: () => pick('updated') },
    { label: 'Date created', checked: s === 'created', onClick: () => pick('created') },
    { label: 'Title', checked: s === 'title', onClick: () => pick('title') },
  ]);
});
el.btnSync.addEventListener('click', () => {
  if (!sync.configured()) { openSettings('sync'); return; }
  showMenu(el.btnSync, [
    { head: sync.state === 'ok' ? `Synced ${timeAgo(pref('lastSyncAt'))}` : sync.message || sync.state },
    { label: 'Sync now', icon: 'restore', onClick: () => sync.syncNow() },
    { label: 'Sync settings', icon: 'settings', onClick: () => openSettings('sync') },
  ]);
});
el.btnEmptyTrash = $('btnEmptyTrash');
el.btnEmptyTrash.addEventListener('click', async () => {
  const trashed = store.all('note').filter((n) => n.data.trashedAt);
  if (!trashed.length) return;
  if (!(await confirmDialog('Empty trash?', `${trashed.length} note${trashed.length === 1 ? '' : 's'} will be deleted for good on all your devices.`, 'Delete forever', true))) return;
  await store.putMany(trashed.map(tombstone));
  sync.schedule(500);
});

// card interactions
let longPressTimer = 0, longPressed = false, pressStart = null;
el.notes.addEventListener('pointerdown', (e) => {
  const card = e.target.closest('.card');
  longPressed = false;
  if (!card || e.pointerType === 'mouse') return;
  pressStart = { x: e.clientX, y: e.clientY };
  longPressTimer = setTimeout(() => { longPressed = true; noteMenu(card.dataset.id, { x: pressStart.x, y: pressStart.y }); }, 520);
});
el.notes.addEventListener('pointermove', (e) => { if (pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) clearTimeout(longPressTimer); });
['pointerup', 'pointercancel', 'scroll'].forEach((t) => el.notes.addEventListener(t, () => { clearTimeout(longPressTimer); pressStart = null; }, { passive: true }));
el.notes.addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault();
  clearTimeout(longPressTimer);
  if (!longPressed) noteMenu(card.dataset.id, { x: e.clientX, y: e.clientY });
  longPressed = true;
});
el.notes.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  if (longPressed) { longPressed = false; return; }
  if (e.target.closest('.card-more')) { noteMenu(card.dataset.id, e.target.closest('.card-more')); return; }
  if (state.view === 'trash') { noteMenu(card.dataset.id, { x: e.clientX, y: e.clientY }); return; }
  openNote(card.dataset.id);
});
el.notes.addEventListener('keydown', (e) => {
  const card = e.target.closest('.card');
  if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openNote(card.dataset.id); }
});

function noteMenu(id, anchor) {
  const it = store.get(id);
  if (!it) return;
  const d = it.data;
  if (d.trashedAt) {
    showMenu(anchor, [
      { label: 'Restore', icon: 'restore', onClick: () => updateNote(id, (x) => { x.trashedAt = null; }).then(() => toast('Note restored')) },
      { label: 'Delete forever', icon: 'trash', danger: true, onClick: async () => {
        if (await confirmDialog('Delete forever?', 'This note will be removed from all your devices.', 'Delete', true)) { await store.put(tombstone(it)); sync.schedule(500); }
      } },
    ]);
    return;
  }
  showMenu(anchor, [
    { label: 'Open', icon: 'notes', onClick: () => openNote(id) },
    { label: d.favorite ? 'Remove from favorites' : 'Add to favorites', icon: 'star', onClick: () => updateNote(id, (x) => { x.favorite = !x.favorite; }) },
    { label: 'Move to folder…', icon: 'move', onClick: () => moveToFolder(id, anchor) },
    { label: 'Duplicate', icon: 'copy', onClick: () => duplicateNote(id) },
    'sep',
    { label: 'Move to trash', icon: 'trash', danger: true, onClick: () => trashNote(id) },
  ]);
}
function moveToFolder(id, anchor) {
  const it = store.get(id);
  const cur = it && it.data.folderId;
  const items = [{ head: 'Move to' }, { label: 'No folder', checked: !cur, onClick: () => updateNote(id, (x) => { x.folderId = null; }) }];
  for (const f of folders()) items.push({ label: f.data.name, checked: cur === f.id, onClick: () => updateNote(id, (x) => { x.folderId = f.id; }) });
  items.push('sep', { label: 'New folder…', icon: 'folderPlus', onClick: async () => { const f = await editFolder(); if (f) updateNote(id, (x) => { x.folderId = f.id; }); } });
  showMenu(anchor instanceof Element && document.contains(anchor) ? anchor : { x: window.innerWidth / 2 - 110, y: 120 }, items);
}
async function duplicateNote(id) {
  const it = store.get(id);
  if (!it) return;
  const now = Date.now();
  const copy = decorate({ id: uid(), type: 'note', updatedAt: now, deleted: false, dirty: true, baseRev: 0,
    data: { ...structuredClone(it.data), title: `${noteTitle(it)} (copy)`, createdAt: now, trashedAt: null } });
  await saveItem(copy);
  toast('Note duplicated');
}
async function trashNote(id) {
  await updateNote(id, (x) => { x.trashedAt = Date.now(); });
  toast('Moved to trash', { action: 'Undo', onAction: () => updateNote(id, (x) => { x.trashedAt = null; }) });
}
function tombstone(it) { return { id: it.id, type: it.type, updatedAt: Date.now(), deleted: true, dirty: true, baseRev: it.baseRev || 0, data: null }; }
async function purgeOldTrash() {
  const cutoff = Date.now() - TRASH_DAYS * 864e5;
  const old = store.all('note').filter((n) => n.data.trashedAt && n.data.trashedAt < cutoff);
  if (old.length) await store.putMany(old.map(tombstone));
}

// ═════════════════════════ folders ═════════════════════════
async function editFolder(id) {
  const f = id ? store.get(id) : null;
  let color = f ? f.data.color : FOLDER_COLORS[folders().length % FOLDER_COLORS.length];
  const res = await dialog({
    title: f ? 'Edit folder' : 'New folder',
    html: `<label class="field"><span>Name</span><input type="text" id="fName" maxlength="60" value="${escapeHTML(f ? f.data.name : '')}" placeholder="e.g. Work" autocomplete="off"></label>
      <div class="field"><span style="display:block;font-size:13px;color:var(--text-2);margin-bottom:8px">Color</span>
      <div class="color-row" id="fColors">${FOLDER_COLORS.map((c) => `<button type="button" data-c="${c}" style="background:${c}" class="${c === color ? 'active' : ''}" aria-label="${c}"></button>`).join('')}</div></div>`,
    actions: [{ label: 'Cancel', value: null }, { label: f ? 'Save' : 'Create', primary: true, value: (d) => ({ name: d.querySelector('#fName').value.trim(), color }) }],
    onOpen: (d) => {
      const i = d.querySelector('#fName'); i.focus();
      d.querySelector('#fColors').addEventListener('click', (e) => {
        const b = e.target.closest('[data-c]'); if (!b) return;
        color = b.dataset.c;
        d.querySelectorAll('#fColors button').forEach((x) => x.classList.toggle('active', x === b));
      });
    },
  });
  if (!res || !res.name) return null;
  const item = f ? { ...f, data: { ...f.data, name: res.name, color: res.color } }
    : { id: uid(), type: 'folder', deleted: false, baseRev: 0, data: { name: res.name, color: res.color, order: folders().length, createdAt: Date.now() } };
  await saveItem(item);
  return item;
}
function folderMenu(anchor, id) {
  showMenu(anchor, [
    { label: 'Rename or recolor', icon: 'edit', onClick: () => editFolder(id) },
    { label: 'Delete folder', icon: 'trash', danger: true, onClick: async () => {
      const f = store.get(id);
      if (!f || !(await confirmDialog(`Delete “${f.data.name}”?`, 'Its notes are kept and move to All notes.', 'Delete folder', true))) return;
      const moved = store.all('note').filter((n) => n.data.folderId === id).map((n) => ({ ...n, data: { ...n.data, folderId: null }, updatedAt: Date.now(), dirty: true }));
      await store.putMany([...moved, tombstone(f)]);
      if (state.view === `folder:${id}`) setView('all');
      sync.schedule(500);
    } },
  ], { align: 'start' });
}

// ═════════════════════════ editor ═════════════════════════
const ink = new InkLayer({
  stage: el.stage, scroller: el.scroller, wrap: el.wrap, canvas: el.ink, live: el.live, selBox: el.selBox,
  colorFn: inkColor,
  view: { getScale: () => scale(), getZoom: () => state.zoom, zoomTo: (z, x, y, a) => zoomTo(z, x, y, a), toLogical: (x, y) => toLogical(x, y) },
  onChange: () => { state.inkDirty = true; markDirty(); requestLayout(); },
  onHistory: () => updateUndo(),
  onPen: () => penDetected(),
});

function scale() { return state.fit * state.zoom; }
function toLogical(cx, cy) { const r = el.wrap.getBoundingClientRect(); const s = scale(); return { x: (cx - r.left) / s, y: (cy - r.top) / s }; }

let layoutRaf = 0;
function requestLayout() { if (!layoutRaf) layoutRaf = requestAnimationFrame(() => { layoutRaf = 0; layout(); }); }
/** Phone-sized touch screen (S26 Ultra in either orientation), not a tablet or laptop. */
const isPhone = () => matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
function layout() {
  if (el.editor.hidden) return;
  const pw = state.pageWidth;
  const w = el.scroller.clientWidth;
  // Full screen and phones: the page fills the width. Tablets/laptops: capped so text stays a sane size.
  const fill = state.fs || isPhone();
  const gutter = state.fs ? 0 : fill ? 8 : w < 600 ? 16 : 48;
  const oldS = state.lastScale || 0;
  const topLogical = oldS ? (el.scroller.scrollTop - el.wrap.offsetTop) / oldS : 0;
  state.fit = clamp((w - gutter) / pw, 0.3, fill ? 4 : 1.1);
  const s = scale();
  el.page.style.width = pw + 'px';
  el.page.style.transform = `scale(${s})`;
  const viewH = el.scroller.clientHeight / s;
  el.page.style.minHeight = Math.ceil(Math.max(viewH - 32 / s, ink.maxY() + viewH * 0.6)) + 'px';
  const h = el.page.offsetHeight;
  el.wrap.style.width = pw * s + 'px';
  el.wrap.style.height = h * s + 'px';
  el.zoomReset.textContent = Math.round(state.zoom * 100) + '%';
  // Width changed (rotation, entering full screen): keep the same line of the note at the top.
  if (oldS && Math.abs(oldS - s) > 1e-3 && !state.anchoring) el.scroller.scrollTop = Math.max(0, el.wrap.offsetTop + topLogical * s);
  state.lastScale = s;
  ink.render();
}
function zoomTo(z, cx, cy, anchor) {
  z = clamp(z, 0.4, 4);
  const sr = el.scroller.getBoundingClientRect();
  if (cx == null) { cx = sr.left + sr.width / 2; cy = sr.top + sr.height / 2; }
  const a = anchor || toLogical(cx, cy);
  state.zoom = z;
  state.anchoring = true;
  layout();
  state.anchoring = false;
  const s = scale();
  el.scroller.scrollLeft = el.wrap.offsetLeft + a.x * s - (cx - sr.left);
  el.scroller.scrollTop = el.wrap.offsetTop + a.y * s - (cy - sr.top);
  ink.renderNow();
  saveZoom();
}
const saveZoom = debounce(() => setPref('zoom', state.zoom), 500);
el.zoomIn.addEventListener('click', () => zoomTo(state.zoom * 1.25));
el.zoomOut.addEventListener('click', () => zoomTo(state.zoom / 1.25));
el.zoomReset.addEventListener('click', () => zoomTo(1));
el.scroller.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  zoomTo(state.zoom * Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
}, { passive: false });
new ResizeObserver(() => { if (!el.editor.hidden) { layout(); ink.resize(); } }).observe(el.stage);

function applyPageStyle(d) {
  el.page.className = `page pat-${d.pattern || 'none'} paper-${d.paper || 'white'}`;
}

function newNote() {
  const now = Date.now();
  const v = state.view;
  const item = {
    id: uid(), type: 'note', updatedAt: now, deleted: false, dirty: true, baseRev: 0,
    data: {
      title: '', html: '', ink: [], pageWidth: narrowScreen() ? NARROW_PAGE : WIDE_PAGE,
      pattern: pref('defaultPattern', 'none'), paper: pref('defaultPaper', 'white'),
      folderId: v.startsWith('folder:') ? v.slice(7) : null, favorite: v === 'fav', trashedAt: null, createdAt: now,
    },
  };
  state.draft = item;
  openNote(item.id, { isNew: true });
}

function openNote(id, { isNew = false } = {}) {
  const it = isNew ? state.draft : store.get(id);
  if (!it || it.deleted) return;
  closeMenu();
  openDrawer(false);
  state.current = id;
  state.sessionNew = isNew;
  if (!isNew) state.draft = null;
  state.editorDirty = false;
  state.inkDirty = false;
  state.range = null;
  loadIntoEditor(it);
  el.editor.hidden = false;
  try { if (!history.state || !history.state.editor) history.pushState({ editor: id }, ''); } catch { /* sandboxed preview */ }
  state.zoom = pref('zoom', 1);
  state.lastScale = 0;
  ink.resize();
  layout();
  el.scroller.scrollTop = 0;
  el.scroller.scrollLeft = 0;
  const penFirst = isNew && ink.penOnly;
  setMode(penFirst);
  if (isNew && !penFirst) (narrowScreen() ? el.body : el.title).focus();
  document.title = `${noteTitle(it)} · Inkwell`;
}
function loadIntoEditor(it) {
  const d = it.data;
  state.pageWidth = d.pageWidth || WIDE_PAGE;
  applyPageStyle(d);
  el.title.value = d.title || '';
  el.body.innerHTML = sanitizeHTML(d.html || '');
  ink.load(structuredClone(d.ink || []));
  el.btnFav.classList.toggle('on', !!d.favorite);
  el.saveState.textContent = '';
}

async function closeEditor() {
  if (el.editor.hidden) return;
  if (state.rec) stopRecording(true);
  await saveNow();
  const id = state.current;
  const it = store.get(id);
  if (it && state.sessionNew && isEmptyData(it.data)) await store.put(tombstone(it));
  setMode(false);
  exitFull();
  el.editor.hidden = true;
  state.current = null;
  state.draft = null;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  renderNav();
  renderList();
  sync.schedule(800);
}
el.btnBack.addEventListener('click', () => { if (history.state && history.state.editor) history.back(); else closeEditor(); });
window.addEventListener('popstate', () => { if (!el.editor.hidden) closeEditor(); });

// ───────── save ─────────
let saveTimer = 0;
function markDirty() {
  state.editorDirty = true;
  el.saveState.textContent = '';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
}
function bodyHTML() {
  const h = el.body.innerHTML;
  return /^(\s|<br\s*\/?>|<p>\s*(<br\s*\/?>)?\s*<\/p>|<div>\s*(<br\s*\/?>)?\s*<\/div>)*$/i.test(h) ? '' : h;
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!state.current || !state.editorDirty) return;
  state.editorDirty = false;
  const base = store.get(state.current) || state.draft;
  if (!base) return;
  const data = { ...base.data, title: el.title.value.trim(), html: bodyHTML(), ink: structuredClone(ink.serialize()), pageWidth: state.pageWidth };
  if (!store.get(state.current) && isEmptyData(data)) return; // empty new note stays a draft
  const item = { ...base, data, deleted: false };
  item.text = htmlToText(data.html);
  item.picture = firstImage(data.html);
  if (state.inkDirty || base.preview === undefined) item.preview = renderThumb(data.ink, data.pageWidth);
  state.inkDirty = false;
  state.draft = null;
  await saveItem(item, 'editor');
  el.saveState.textContent = 'Saved';
}
window.addEventListener('pagehide', () => { saveNow(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { saveNow().then(() => sync.syncNow(true)); } });

// ───────── modes ─────────
function setMode(draw) {
  if (draw && !state.drawing && !state.fs && fullPref() !== 'off' && !el.editor.hidden) enterFull();
  state.drawing = draw;
  el.editor.classList.toggle('drawing', draw);
  el.textToolbar.hidden = draw;
  el.drawToolbar.hidden = !draw;
  el.modeText.classList.toggle('active', !draw);
  el.modeDraw.classList.toggle('active', draw);
  el.modeText.setAttribute('aria-pressed', String(!draw));
  el.modeDraw.setAttribute('aria-pressed', String(draw));
  ink.setEnabled(draw);
  if (draw && document.activeElement && (document.activeElement === el.body || document.activeElement === el.title)) document.activeElement.blur();
  el.editor.classList.toggle(`tool-${ink.tool}`, draw);
  updateUndo();
}
el.modeText.addEventListener('click', () => setMode(false));
el.modeDraw.addEventListener('click', () => setMode(true));

function updateUndo() {
  const u = state.drawing ? !ink.undoStack.length : false;
  const r = state.drawing ? !ink.redoStack.length : false;
  el.btnUndo.disabled = u;
  el.btnRedo.disabled = r;
  document.querySelectorAll('[data-fs="undo"]').forEach((b) => { b.disabled = u; });
  document.querySelectorAll('[data-fs="redo"]').forEach((b) => { b.disabled = r; });
}

// ───────── full-screen writing ─────────
// Hides the editor's top bar, puts every tool in one slim row (which can be tucked away), lets the page
// fill the screen edge to edge, and — where the browser allows it (Chrome on Android) — hides Android's
// status and navigation bars too.
const canFullscreen = !!(document.fullscreenEnabled && document.documentElement.requestFullscreen);
const fullPref = () => pref('fullscreen', isPhone() ? 'writing' : 'off'); // 'writing' | 'always' | 'off'
function systemFullscreen() {
  if (!canFullscreen || document.fullscreenElement) return;
  document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}
function enterFull() {
  if (el.editor.hidden) return;
  state.fs = true;
  el.editor.classList.add('fs');
  el.btnFull.classList.add('on');
  systemFullscreen();
  layout();
}
function exitFull() {
  if (!state.fs) return;
  state.fs = false;
  el.editor.classList.remove('fs', 'tools-hidden');
  el.fsHandle.hidden = true;
  el.btnFull.classList.remove('on');
  if (document.fullscreenElement && fullPref() !== 'always') document.exitFullscreen().catch(() => {});
  layout();
}
document.addEventListener('fullscreenchange', () => {
  // Android back gesture / swipe leaves system full screen: leave the writing layout with it.
  if (!document.fullscreenElement && state.fs && canFullscreen) exitFull();
});
// "Always": go full screen on the first tap of a session (browsers require a tap to allow it).
document.addEventListener('click', () => { if (fullPref() === 'always') systemFullscreen(); }, true);
function buildFullscreenBars() {
  for (const bar of [el.textToolbar, el.drawToolbar]) {
    const isDraw = bar === el.drawToolbar;
    const g = document.createElement('span');
    g.className = 'fs-only fs-group';
    g.innerHTML = `<button type="button" class="tb" data-fs="exit" aria-label="Leave full screen" data-icon="collapse"></button>
      <button type="button" class="tb" data-fs="mode" aria-label="${isDraw ? 'Switch to typing' : 'Switch to handwriting'}" data-icon="${isDraw ? 'type' : 'pen'}"></button>
      <button type="button" class="tb" data-fs="undo" aria-label="Undo" data-icon="undo"></button>
      <button type="button" class="tb" data-fs="redo" aria-label="Redo" data-icon="redo"></button>
      <span class="tb-sep"></span>`;
    bar.prepend(g);
    if (isDraw) {
      const cc = document.createElement('button');
      cc.type = 'button';
      cc.className = 'swatch fs-only fs-color';
      cc.dataset.fs = 'color';
      cc.setAttribute('aria-label', 'Color');
      bar.querySelector('.colors').after(cc);
    }
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'tb fs-only fs-hide';
    hide.dataset.fs = 'hide';
    hide.dataset.icon = 'chevronUp';
    hide.setAttribute('aria-label', 'Hide tools');
    bar.append(hide);
    hydrateIcons(bar);
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fs]');
      if (!b) return;
      e.stopPropagation();
      const a = b.dataset.fs;
      if (a === 'exit') exitFull();
      else if (a === 'mode') setMode(!state.drawing);
      else if (a === 'undo') el.btnUndo.click();
      else if (a === 'redo') el.btnRedo.click();
      else if (a === 'hide') { el.editor.classList.add('tools-hidden'); el.fsHandle.hidden = false; }
      else if (a === 'color') {
        showMenu(b, [
          { head: 'Color' },
          { swatches: PALETTE, onPick: (c) => selectColor(c) },
          { label: 'Custom color…', icon: 'edit', onClick: () => el.customColor.click() },
        ], { align: 'start' });
      }
    });
  }
  el.fsHandle.addEventListener('click', () => { el.editor.classList.remove('tools-hidden'); el.fsHandle.hidden = true; });
  el.btnFull.addEventListener('click', () => (state.fs ? exitFull() : enterFull()));
}
el.btnUndo.addEventListener('mousedown', (e) => e.preventDefault());
el.btnRedo.addEventListener('mousedown', (e) => e.preventDefault());
el.btnUndo.addEventListener('click', () => { if (state.drawing) ink.undo(); else { restoreSelection(); document.execCommand('undo'); markDirty(); } });
el.btnRedo.addEventListener('click', () => { if (state.drawing) ink.redo(); else { restoreSelection(); document.execCommand('redo'); markDirty(); } });
el.btnFav.addEventListener('click', async () => {
  await saveNow();
  const it = store.get(state.current) || state.draft;
  if (!it) return;
  it.data.favorite = !it.data.favorite;
  el.btnFav.classList.toggle('on', it.data.favorite);
  state.editorDirty = true;
  await saveNow();
});

// ───────── text editing ─────────
try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* ignore */ }
document.addEventListener('selectionchange', () => {
  const sel = document.getSelection();
  if (!sel || !sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  if (el.body.contains(r.commonAncestorContainer)) { state.range = r.cloneRange(); updateToolbarState(); }
});
function restoreSelection() {
  if (document.activeElement !== el.body) el.body.focus({ preventScroll: true });
  const sel = document.getSelection();
  if (state.range && el.body.contains(state.range.commonAncestorContainer)) {
    sel.removeAllRanges();
    sel.addRange(state.range);
  } else if (!sel.rangeCount || !el.body.contains(sel.anchorNode)) {
    const r = document.createRange();
    r.selectNodeContents(el.body);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }
}
function exec(cmd, val = null) {
  restoreSelection();
  try { document.execCommand('styleWithCSS', false, cmd === 'foreColor' || cmd === 'hiliteColor'); } catch { /* ignore */ }
  document.execCommand(cmd, false, val);
  markDirty();
  requestLayout();
  updateToolbarState();
}
/** "Default" color: paint with a sentinel color, then strip it so the text follows the theme again. */
function clearColor(prop) {
  const sentinel = prop === 'color' ? '#010203' : '#010204';
  const rgb = prop === 'color' ? 'rgb(1, 2, 3)' : 'rgb(1, 2, 4)';
  exec(prop === 'color' ? 'foreColor' : 'hiliteColor', sentinel);
  el.body.querySelectorAll('[style]').forEach((n) => {
    const v = (n.style.getPropertyValue(prop) || '').toLowerCase();
    if (v !== rgb && v !== sentinel) return;
    n.style.removeProperty(prop);
    if (!n.getAttribute('style')) n.removeAttribute('style');
    if (n.tagName === 'SPAN' && !n.attributes.length) n.replaceWith(...n.childNodes);
  });
  el.body.querySelectorAll('font[color]').forEach((f) => { if (f.getAttribute('color').toLowerCase() === sentinel) f.replaceWith(...f.childNodes); });
  markDirty();
}
function updateToolbarState() {
  if (el.textToolbar.hidden) return;
  for (const b of el.textToolbar.querySelectorAll('[data-cmd]')) {
    const c = b.dataset.cmd;
    let on = false;
    try {
      if (['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'].includes(c)) on = document.queryCommandState(c);
      else if (c === 'h1' || c === 'h2') on = document.queryCommandValue('formatBlock').toLowerCase() === c;
      else if (c === 'checklist') on = !!closestInBody('ul.checklist');
    } catch { /* ignore */ }
    if (c === 'insertUnorderedList' && closestInBody('ul.checklist')) on = false;
    b.classList.toggle('active', on);
  }
}
function closestInBody(selector) {
  const sel = document.getSelection();
  if (!sel || !sel.anchorNode) return null;
  const n = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
  const hit = n && n.closest(selector);
  return hit && el.body.contains(hit) ? hit : null;
}
function toggleChecklist() {
  restoreSelection();
  const cl = closestInBody('ul.checklist');
  if (cl) { document.execCommand('insertUnorderedList'); markDirty(); return; } // list off
  const ul = closestInBody('ul');
  if (ul) ul.classList.add('checklist');
  else {
    document.execCommand('insertUnorderedList');
    const nu = closestInBody('ul');
    if (nu) nu.classList.add('checklist');
  }
  markDirty();
  updateToolbarState();
}

el.textToolbar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
el.textToolbar.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cmd]');
  if (!b) return;
  const c = b.dataset.cmd;
  switch (c) {
    case 'h1': case 'h2': {
      restoreSelection();
      const cur = (document.queryCommandValue('formatBlock') || '').toLowerCase();
      exec('formatBlock', cur === c ? '<p>' : `<${c}>`);
      break;
    }
    case 'p': exec('formatBlock', '<p>'); break;
    case 'checklist': toggleChecklist(); break;
    case 'foreColor':
      showMenu(b, [{ head: 'Text color' }, { swatches: TEXT_COLORS, onPick: (col) => { if (col) { b.style.setProperty('--tc', col); exec('foreColor', col); } else clearColor('color'); } }], { align: 'start' });
      break;
    case 'hiliteColor':
      showMenu(b, [{ head: 'Highlight' }, { swatches: HL_COLORS, onPick: (col) => { if (col) { b.style.setProperty('--hc', col); exec('hiliteColor', col); } else clearColor('background-color'); } }], { align: 'start' });
      break;
    case 'align':
      showMenu(b, [
        { label: 'Align left', icon: 'alignLeft', onClick: () => exec('justifyLeft') },
        { label: 'Center', icon: 'alignCenter', onClick: () => exec('justifyCenter') },
        { label: 'Align right', icon: 'alignRight', onClick: () => exec('justifyRight') },
      ], { align: 'start' });
      break;
    case 'image': restoreSelection(); el.fileImage.click(); break;
    case 'voice': startRecording(); break;
    default: exec(c);
  }
});

el.title.addEventListener('input', () => { markDirty(); document.title = `${el.title.value || 'Untitled'} · Inkwell`; });
el.title.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    el.body.focus();
    const r = document.createRange(); r.selectNodeContents(el.body); r.collapse(true);
    const s = document.getSelection(); s.removeAllRanges(); s.addRange(r);
  }
});
el.body.addEventListener('input', (e) => {
  if (e.inputType === 'insertParagraph') {
    // A new checklist item starts unchecked (the browser copies the attribute when splitting).
    const li = closestInBody('ul.checklist > li');
    for (const x of [li, li && li.previousElementSibling]) if (x && !x.textContent.trim()) x.removeAttribute('data-checked');
  }
  markDirty();
  requestLayout();
});
/** The checkbox of a checklist item under the pointer, if any (the 30px gutter left of the text). */
function checkboxHit(e) {
  const li = e.target.closest && e.target.closest('ul.checklist > li');
  if (!li || !el.body.contains(li)) return null;
  const r = li.getBoundingClientRect();
  return e.clientX - r.left < 30 * scale() ? li : null;
}
el.body.addEventListener('pointerdown', (e) => {
  const li = checkboxHit(e);
  if (!li) return;
  e.preventDefault(); // don't move the caret or pop the keyboard
  if (li.dataset.checked === 'true') li.removeAttribute('data-checked'); else li.dataset.checked = 'true';
  markDirty();
});
el.body.addEventListener('mousedown', (e) => { if (checkboxHit(e)) e.preventDefault(); });
el.body.addEventListener('click', (e) => {
  if (checkboxHit(e)) { e.preventDefault(); return; }
  const img = e.target.closest('img');
  if (img && el.body.contains(img)) {
    el.body.querySelectorAll('img.sel').forEach((i) => i.classList.remove('sel'));
    img.classList.add('sel');
    const set = (w) => { img.classList.remove('sel'); if (w) img.setAttribute('width', w); else img.removeAttribute('width'); markDirty(); requestLayout(); };
    showMenu({ x: e.clientX, y: e.clientY }, [
      { head: 'Image size' },
      { label: 'Small', onClick: () => set('33%') }, { label: 'Medium', onClick: () => set('60%') }, { label: 'Full width', onClick: () => set(null) },
      'sep',
      { label: 'Delete image', icon: 'trash', danger: true, onClick: () => { img.remove(); markDirty(); requestLayout(); } },
    ]);
    return;
  }
  const a = e.target.closest('a[href]');
  if (a && (e.ctrlKey || e.metaKey)) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); }
});
el.body.addEventListener('paste', (e) => {
  const cd = e.clipboardData;
  if (!cd) return;
  const files = [...(cd.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); insertImages(files); return; }
  const html = cd.getData('text/html');
  if (html) {
    e.preventDefault();
    const doc = new DOMParser().parseFromString(sanitizeHTML(html), 'text/html');
    doc.querySelectorAll('[style]').forEach((n) => { const ta = n.style.textAlign; n.removeAttribute('style'); if (ta) n.style.textAlign = ta; });
    doc.querySelectorAll('font').forEach((f) => f.replaceWith(...f.childNodes));
    exec('insertHTML', doc.body.innerHTML);
  }
});
el.body.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer && e.dataTransfer.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  const pos = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
  if (pos) state.range = pos;
  insertImages(files);
});

// ───────── images ─────────
el.fileImage.addEventListener('change', () => { const files = [...el.fileImage.files]; el.fileImage.value = ''; insertImages(files); });
async function compressImage(file, max = 1600) {
  let src;
  try { src = await createImageBitmap(file); } catch {
    src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  }
  const w0 = src.width, h0 = src.height;
  const k = Math.min(1, max / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}
async function insertImages(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try { exec('insertHTML', `<img src="${await compressImage(f)}" alt=""><p><br></p>`); }
    catch (e) { console.error(e); toast('Could not read that image'); }
  }
}

// ───────── voice notes ─────────
async function startRecording() {
  if (state.rec) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    toast(window.isSecureContext ? 'Voice recording is not supported in this browser' : 'Voice recording needs HTTPS');
    return;
  }
  restoreSelection();
  const range = state.range && state.range.cloneRange();
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { toast('Microphone permission denied'); return; }
  const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
  const chunks = [];
  const started = Date.now();
  state.rec = { rec, stream, range, cancel: false, timer: 0 };
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const r = state.rec;
    state.rec = null;
    el.recBar.hidden = true;
    clearInterval(r.timer);
    if (r.cancel || !chunks.length) return;
    const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
    const url = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
    const secs = Math.round((Date.now() - started) / 1000);
    state.range = r.range;
    setMode(false);
    exec('insertHTML', `<div class="voice" contenteditable="false"><audio controls src="${url}"></audio><span>Voice · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}</span></div><p><br></p>`);
  };
  rec.start(1000);
  el.recBar.hidden = false;
  el.recTime.textContent = '0:00';
  state.rec.timer = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    el.recTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s >= 900) stopRecording(false); // 15 min cap
  }, 500);
}
function stopRecording(cancel) {
  if (!state.rec) return;
  state.rec.cancel = cancel;
  try { state.rec.rec.stop(); } catch { /* ignore */ }
}
el.recStop.addEventListener('click', () => stopRecording(false));
el.recCancel.addEventListener('click', () => stopRecording(true));

// ───────── handwriting toolbar ─────────
const TOOL_RANGE = { pen: [0.5, 14], pencil: [0.5, 14], hl: [6, 44], eraser: [2, 40] };
function buildSwatches() {
  el.swatches.innerHTML = PALETTE.map((c) => `<button type="button" class="swatch" data-color="${c}" style="background:${c}" aria-label="Color ${c}"></button>`).join('');
}
function selectTool(t) {
  ink.setTool(t);
  setPref('tool', t);
  el.drawToolbar.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  el.editor.classList.remove('tool-pen', 'tool-pencil', 'tool-hl', 'tool-eraser', 'tool-lasso');
  if (state.drawing) el.editor.classList.add(`tool-${t}`);
  const range = TOOL_RANGE[t];
  el.sizeRange.disabled = !range;
  if (range) { el.sizeRange.min = range[0]; el.sizeRange.max = range[1]; el.sizeRange.value = ink.sizes[t]; }
  updateSizeDot();
}
function selectColor(c) {
  ink.color = c;
  setPref('color', c);
  el.swatches.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('active', b.dataset.color === c));
  el.customColor.parentElement.classList.toggle('active', !PALETTE.includes(c));
  document.querySelectorAll('.fs-color').forEach((b) => { b.style.background = c; });
  if (ink.tool === 'eraser' || ink.tool === 'lasso') { if (!ink.selection) selectTool('pen'); }
  updateSizeDot();
}
function updateSizeDot() {
  const t = ink.tool;
  const size = ink.sizes[t] || 3;
  const d = t === 'eraser' ? Math.min(24, 4 + size * 0.5) : Math.min(24, Math.max(3, size * (t === 'hl' ? 0.55 : 1.3)));
  el.sizeDot.style.setProperty('--d', d + 'px');
  el.sizeDot.style.setProperty('--c', t === 'eraser' ? 'var(--text-3)' : inkColor(ink.color, t));
}
el.drawToolbar.addEventListener('click', (e) => {
  const tb = e.target.closest('[data-tool]');
  if (tb) { selectTool(tb.dataset.tool); return; }
  const sw = e.target.closest('[data-color]');
  if (sw) selectColor(sw.dataset.color);
});
el.customColor.addEventListener('input', () => selectColor(el.customColor.value));
el.sizeRange.addEventListener('input', () => {
  ink.sizes[ink.tool] = +el.sizeRange.value;
  setPref('sizes', ink.sizes);
  updateSizeDot();
});
function applyPenMode() {
  const mode = pref('penMode', 'auto');
  ink.penOnly = mode === 'on' || (mode === 'auto' && pref('penSeen', false));
  el.btnPenOnly.setAttribute('aria-pressed', String(ink.penOnly));
}
el.btnPenOnly.addEventListener('click', () => { setPref('penMode', ink.penOnly ? 'off' : 'on'); applyPenMode(); toast(ink.penOnly ? 'Pen only: fingers scroll and zoom' : 'Fingers draw too (two fingers scroll)'); });
function penDetected() {
  if (pref('penSeen', false)) return;
  setPref('penSeen', true);
  applyPenMode();
  if (ink.penOnly) toast('Pen detected — fingers now scroll and zoom while you write.', { ms: 5000 });
}

// ───────── note menu ─────────
el.btnNoteMenu.addEventListener('click', () => {
  const it = store.get(state.current) || state.draft;
  if (!it) return;
  showMenu(el.btnNoteMenu, [
    { label: 'Page style', icon: 'page', onClick: pageStyleDialog },
    { label: 'Move to folder…', icon: 'move', onClick: async () => { state.editorDirty = true; await saveNow(); if (store.get(state.current)) moveToFolder(state.current, el.btnNoteMenu); } },
    { label: 'Insert image', icon: 'image', onClick: () => { setMode(false); restoreSelection(); el.fileImage.click(); } },
    { label: 'Record voice', icon: 'mic', onClick: () => { setMode(false); startRecording(); } },
    'sep',
    { label: 'Export PDF / print', icon: 'print', onClick: printNote },
    navigator.share ? { label: 'Share as text', icon: 'upload', onClick: shareNote } : null,
    { label: 'Duplicate', icon: 'copy', onClick: async () => { state.editorDirty = true; await saveNow(); if (store.get(state.current)) duplicateNote(state.current); } },
    { label: 'Clear handwriting', icon: 'eraser', disabled: !ink.strokes.length, onClick: () => { ink.clearAll(); toast('Handwriting cleared', { action: 'Undo', onAction: () => ink.undo() }); } },
    'sep',
    { label: 'Move to trash', icon: 'trash', danger: true, onClick: async () => {
      const id = state.current;
      state.editorDirty = true;
      await saveNow();
      state.sessionNew = false;
      if (store.get(id)) await trashNote(id);
      if (history.state && history.state.editor) history.back(); else closeEditor();
    } },
  ]);
});
async function pageStyleDialog() {
  const it = store.get(state.current) || state.draft;
  const d = it.data;
  let pattern = d.pattern || 'none', paper = d.paper || 'white', width = state.pageWidth;
  const row = (name, opts, cur) => `<div class="choice-row" data-row="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${String(v) === String(cur) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const res = await dialog({
    title: 'Page style',
    html: `<div class="field"><span style="display:block;font-size:13px;color:var(--text-2);margin:4px 0 8px">Pattern</span>${row('pattern', PATTERNS, pattern)}</div>
      <div class="field"><span style="display:block;font-size:13px;color:var(--text-2);margin:14px 0 8px">Paper</span>${row('paper', PAPERS, paper)}</div>
      <div class="field"><span style="display:block;font-size:13px;color:var(--text-2);margin:14px 0 8px">Page width</span>${row('width', [[NARROW_PAGE, 'Phone (narrow)'], [WIDE_PAGE, 'Tablet / laptop (wide)']], width)}
      <p class="hint">Notes keep their page width on every device so handwriting stays lined up with text. Changing it rescales the handwriting.</p></div>
      <label class="switch"><span>Use this style for new notes</span><input type="checkbox" id="psDefault"></label>`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Done', primary: true, value: (dd) => ({ def: dd.querySelector('#psDefault').checked }) }],
    onOpen: (dd) => dd.querySelectorAll('[data-row]').forEach((r) => r.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]'); if (!b) return;
      r.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      if (r.dataset.row === 'pattern') pattern = b.dataset.v;
      if (r.dataset.row === 'paper') paper = b.dataset.v;
      if (r.dataset.row === 'width') width = +b.dataset.v;
      applyPageStyle({ pattern, paper });
    })),
  });
  if (!res) { applyPageStyle(d); return; }
  if (res.def) { setPref('defaultPattern', pattern); setPref('defaultPaper', paper); }
  const cur = store.get(state.current) || state.draft;
  cur.data = { ...cur.data, pattern, paper };
  if (width !== state.pageWidth) { ink.scaleAll(width / state.pageWidth); state.pageWidth = width; state.inkDirty = true; }
  applyPageStyle(cur.data);
  state.editorDirty = true;
  layout();
  await saveNow();
}
async function shareNote() {
  await saveNow();
  const it = store.get(state.current);
  if (!it) return;
  try { await navigator.share({ title: noteTitle(it), text: `${it.data.title ? it.data.title + '\n\n' : ''}${it.text || ''}` }); } catch { /* cancelled */ }
}
async function printNote() {
  state.editorDirty = true;
  await saveNow();
  const pw = state.pageWidth;
  const page = el.page.cloneNode(true);
  page.removeAttribute('id');
  page.style.transform = 'none';
  page.style.minHeight = '0';
  const t = page.querySelector('.note-title');
  const tdiv = document.createElement('div');
  tdiv.className = 'note-title';
  tdiv.textContent = el.title.value;
  t.replaceWith(tdiv);
  page.querySelector('.note-body').removeAttribute('contenteditable');
  el.printArea.replaceChildren(page);
  page.style.zoom = String(Math.min(1, 680 / pw));
  const H = Math.ceil(Math.max(el.title.offsetHeight + 12 + el.body.offsetHeight + 80, ink.maxY() + 40));
  page.style.height = H + 'px';
  if (ink.strokes.length) {
    const k = Math.min(2, Math.sqrt(16e6 / (pw * H)));
    const c = document.createElement('canvas');
    c.width = Math.round(pw * k); c.height = Math.round(H * k);
    const ctx = c.getContext('2d');
    ctx.setTransform(k, 0, 0, k, 0, 0);
    for (const s of ink.strokes) drawStroke(ctx, s);
    const img = new Image();
    img.className = 'ink-img';
    img.style.width = pw + 'px'; img.style.height = H + 'px';
    img.src = c.toDataURL('image/png');
    page.append(img);
    await img.decode().catch(() => {});
  }
  setTimeout(() => window.print(), 50);
}
window.addEventListener('afterprint', () => el.printArea.replaceChildren());

// ═════════════════════════ settings ═════════════════════════
async function openSettings(focus) {
  const st = sync.state;
  const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const theme = pref('theme', 'system'), penMode = pref('penMode', 'auto');
  const choice = (name, opts, cur) => `<div class="choice-row" data-choice="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${v === cur ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const statusText = st === 'off' ? 'Not set up — notes are only on this device.'
    : st === 'ok' ? `Connected · last sync ${timeAgo(pref('lastSyncAt'))}` : st === 'syncing' ? 'Syncing…' : sync.message || st;
  const mb = (n) => (n / 1048576).toFixed(n > 1e8 ? 0 : 1) + ' MB';

  const res = await dialog({
    title: 'Settings',
    html: `
      <div class="section" style="border:0;margin:0;padding:0">
        <h3>Sync between devices</h3>
        ${choice('syncMode', [['github', 'GitHub repo'], ['server', 'Own server'], ['off', 'Off']], sync.mode)}
        <div data-pane="github">
          <label class="field"><span>Data repository (private)</span><input type="text" id="gRepo" value="${escapeHTML(sync.ghRepo)}" placeholder="owner/name" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
          <label class="field"><span>GitHub token</span><input type="password" id="gToken" value="${escapeHTML(sync.ghToken)}" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
          <p class="hint">A <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a> with access to <b>only</b> this repository and the permission <b>Contents: Read and write</b>. Each device needs it once.</p>
        </div>
        <div data-pane="server">
          <label class="field"><span>Server address</span><input type="url" id="sUrl" placeholder="Leave empty if this app is opened from your Inkwell server" value="${escapeHTML(sync.url)}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
          <label class="field"><span>Sync token</span><input type="password" id="sToken" value="${escapeHTML(sync.token)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="The SYNC_TOKEN from your server's .env"></label>
        </div>
        <label class="switch"><span>Sync automatically</span><input type="checkbox" id="sAuto" ${sync.auto ? 'checked' : ''}></label>
        <div class="row"><button type="button" class="btn" id="sTest">Test connection</button><button type="button" class="btn" id="sNow">Sync now</button><button type="button" class="btn" id="sRedl">Re-download all</button></div>
        <div class="status-line" id="sStatus">${escapeHTML(statusText)}</div>
      </div>
      <div class="section">
        <h3>Pen &amp; touch</h3>
        ${choice('penMode', [['auto', 'Auto'], ['on', 'Pen only'], ['off', 'Fingers draw too']], penMode)}
        <div style="height:10px"></div>
        <span style="display:block;font-size:13px;color:var(--text-2);margin:6px 0 8px">Full screen</span>
        ${choice('fullscreen', [['writing', 'While writing'], ['always', 'Always'], ['off', 'Off']], fullPref())}
        <p class="hint">Full screen hides the note's top bar and Android's status and navigation bars, so the page uses the whole display. Swipe in from the edge to see the bars; the back gesture leaves full screen. The ⤢ button in a note toggles it any time.</p>
        <p class="hint">Auto switches to “pen only” the first time an S Pen or Apple Pencil touches the page: then fingers scroll and pinch-zoom, and your palm is ignored. Holding the S Pen button (or flipping to an eraser end) erases.</p>
      </div>
      <div class="section">
        <h3>Appearance</h3>
        ${choice('theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], theme)}
      </div>
      <div class="section">
        <h3>Your data</h3>
        <div class="row"><button type="button" class="btn" id="sExport">${icon('download')} Export backup</button><button type="button" class="btn" id="sImport">${icon('upload')} Import backup</button></div>
        <p class="hint">${store.persistent ? `Saved on this device${persisted ? ' (protected from automatic cleanup)' : ''}.` : 'This browser blocks offline storage here — notes last until the tab closes. Install the app or use sync.'}
        ${est ? ` Using ${mb(est.usage || 0)}.` : ''}</p>
      </div>
      <div class="section">
        <h3>Install</h3>
        ${standalone ? '<p class="hint">Installed as an app on this device. ✓</p>'
    : state.installEvent ? '<button type="button" class="btn primary" id="sInstall">Install Inkwell</button>'
      : isIOS ? '<p class="hint">On iPad/iPhone: tap the Share button in Safari, then <b>Add to Home Screen</b>.</p>'
        : '<p class="hint">Use your browser’s menu → <b>Install app</b> (Chrome, Edge, Samsung Internet).</p>'}
      </div>
      <p class="hint" style="margin-top:16px">Inkwell ${VERSION}</p>`,
    actions: [{ label: 'Close', value: null }, { label: 'Save', primary: true, value: (d) => readSyncForm(d) }],
    onOpen: (d) => {
      const status = d.querySelector('#sStatus');
      const showPanes = (mode) => d.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== mode; });
      showPanes(sync.mode);
      d.querySelectorAll('[data-choice]').forEach((r) => r.addEventListener('click', (e) => {
        const b = e.target.closest('[data-v]'); if (!b) return;
        r.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
        if (r.dataset.choice === 'theme') { setPref('theme', b.dataset.v).then(applyTheme); }
        if (r.dataset.choice === 'penMode') { setPref('penMode', b.dataset.v).then(applyPenMode); }
        if (r.dataset.choice === 'syncMode') showPanes(b.dataset.v);
        if (r.dataset.choice === 'fullscreen') { setPref('fullscreen', b.dataset.v); if (b.dataset.v === 'always') systemFullscreen(); else if (b.dataset.v === 'off' && document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
      }));
      d.querySelector('#sTest').addEventListener('click', async () => {
        const f = readSyncForm(d);
        if (f.mode === 'off') { status.textContent = 'Sync is off.'; return; }
        status.textContent = 'Testing…';
        try {
          const r = await sync.test(f);
          if (f.mode === 'github') {
            status.textContent = !r.private ? '⚠ Connected, but this repository is PUBLIC — anyone could read your notes. Make it private on GitHub.'
              : !r.canPush ? '✗ The token can read this repository but not write to it (needs Contents: Read and write).'
                : `✓ Connected to a private repository${r.empty ? ' (empty — it will be set up on the first sync)' : ''}.`;
          } else status.textContent = `✓ Connected — server has ${r.items} item${r.items === 1 ? '' : 's'}.`;
        } catch (e) { status.textContent = `✗ ${e.message}`; }
      });
      d.querySelector('#sNow').addEventListener('click', async () => {
        await applySyncSettings(d);
        status.textContent = 'Syncing…';
        await sync.syncNow();
        status.textContent = sync.state === 'ok' ? `✓ ${sync.message}` : `✗ ${sync.message}`;
      });
      d.querySelector('#sRedl').addEventListener('click', async () => {
        await applySyncSettings(d);
        status.textContent = 'Downloading…';
        await sync.redownload();
        status.textContent = sync.state === 'ok' ? `✓ ${sync.message}` : `✗ ${sync.message}`;
      });
      d.querySelector('#sExport').addEventListener('click', exportBackup);
      d.querySelector('#sImport').addEventListener('click', () => el.fileImport.click());
      const inst = d.querySelector('#sInstall');
      if (inst) inst.addEventListener('click', async () => { state.installEvent.prompt(); await state.installEvent.userChoice.catch(() => {}); state.installEvent = null; inst.remove(); });
      if (focus === 'sync') d.querySelector(sync.mode === 'github' ? '#gToken' : '#sToken').focus();
    },
  });
  if (res) {
    await applySyncSettings(null, res);
    if (sync.configured()) sync.syncNow(); else sync.setStatus('off');
  }
}
function readSyncForm(d) {
  const active = d.querySelector('[data-choice="syncMode"] .active');
  return {
    mode: active ? active.dataset.v : sync.mode,
    url: d.querySelector('#sUrl').value.trim(), token: d.querySelector('#sToken').value.trim(),
    repo: d.querySelector('#gRepo').value.trim(), ghToken: d.querySelector('#gToken').value.trim(),
    auto: d.querySelector('#sAuto').checked,
  };
}
async function applySyncSettings(d, values) {
  const v = values || readSyncForm(d);
  const target = () => (sync.mode === 'github' ? `github|${sync.ghRepo.toLowerCase()}` : sync.mode === 'server' ? `server|${sync.url}` : 'off');
  const before = target();
  await setPref('syncMode', v.mode);
  await setPref('serverUrl', v.url);
  await setPref('syncToken', v.token);
  await setPref('ghRepo', v.repo);
  await setPref('ghToken', v.ghToken);
  await setPref('autoSync', v.auto);
  const after = target();
  // Pointed at a different place than before: upload everything there, pull what it has.
  if (before !== after && after !== 'off' && [...store.items.values()].some((it) => it.baseRev)) await sync.resetForNewServer();
}
$('btnSettings').addEventListener('click', () => { openDrawer(false); openSettings(); });

function exportBackup() {
  const items = [...store.items.values()].filter((i) => !i.deleted).map(({ id, type, updatedAt, data }) => ({ id, type, updatedAt, data }));
  const blob = new Blob([JSON.stringify({ app: 'inkwell', version: 1, exportedAt: new Date().toISOString(), items })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `inkwell-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
el.fileImport.addEventListener('change', async () => {
  const f = el.fileImport.files[0];
  el.fileImport.value = '';
  if (!f) return;
  try {
    const json = JSON.parse(await f.text());
    if (json.app !== 'inkwell' || !Array.isArray(json.items)) throw new Error('Not an Inkwell backup');
    const puts = [];
    for (const it of json.items) {
      if (!it || !it.id || !/^[\w-]{1,64}$/.test(it.id) || !['note', 'folder'].includes(it.type) || !it.data) continue;
      const cur = store.get(it.id);
      if (cur && !cur.deleted && cur.updatedAt >= it.updatedAt) continue;
      const data = it.type === 'note' ? { ...it.data, html: sanitizeHTML(it.data.html || '') } : it.data;
      puts.push(decorate({ id: it.id, type: it.type, updatedAt: it.updatedAt || Date.now(), deleted: false, dirty: true, baseRev: cur ? cur.baseRev || 0 : 0, data }));
    }
    await store.putMany(puts);
    sync.schedule(500);
    toast(`Imported ${puts.length} item${puts.length === 1 ? '' : 's'}`);
  } catch (e) { toast(`Import failed: ${e.message}`); }
});

// ═════════════════════════ store events, keys, boot ═════════════════════════
store.onChange((ids, source) => {
  if (source === 'quota') { toast('Device storage is full — some changes could not be saved.', { ms: 8000 }); return; }
  if (source === 'editor') { state.listStale = true; renderNav(); return; }
  renderAll();
  if (source === 'sync' && state.current && ids.includes(state.current)) {
    const it = store.get(state.current);
    if (!it || it.deleted || (it.data && it.data.trashedAt)) {
      toast('This note was deleted on another device');
      state.editorDirty = false;
      state.sessionNew = false;
      if (history.state && history.state.editor) history.back(); else closeEditor();
    } else if (!state.editorDirty && !it.dirty) {
      const top = el.scroller.scrollTop;
      loadIntoEditor(it);
      layout();
      el.scroller.scrollTop = top;
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (dialogOpen()) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName) || (document.activeElement && document.activeElement.isContentEditable);
  if (e.key === 'Escape') {
    if (closeMenu()) return;
    if (!el.editor.hidden) {
      if (state.drawing && ink.selection) ink.clearSelection();
      else if (state.fs && el.editor.classList.contains('tools-hidden')) el.fsHandle.click();
      else if (state.fs && !document.fullscreenElement) exitFull();
      else el.btnBack.click();
    }
    else if (el.sidebar.classList.contains('open')) openDrawer(false);
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (!el.editor.hidden) {
    if (mod && e.altKey && (e.key === 'd' || e.key === 'D' || e.code === 'KeyD')) { e.preventDefault(); setMode(!state.drawing); return; }
    if (state.drawing && !typing && mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) ink.redo(); else ink.undo(); return; }
    if (state.drawing && !typing && mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); ink.redo(); return; }
    if (state.drawing && !typing && (e.key === 'Delete' || e.key === 'Backspace') && ink.selection) { e.preventDefault(); ink.deleteSelection(); return; }
    if (mod && e.key === 's') { e.preventDefault(); state.editorDirty = true; saveNow(); return; }
    return;
  }
  if (typing || mod || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); el.search.focus(); }
  else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); newNote(); }
});

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installEvent = e; });

async function main() {
  window.__inkLayer = ink; // handy from devtools (and used by the tests)
  hydrateIcons();
  await store.init();
  applyTheme();
  buildSwatches();
  buildFullscreenBars();
  const sizes = pref('sizes', null);
  if (sizes) Object.assign(ink.sizes, DEFAULT_SIZES, sizes);
  selectColor(pref('color', PALETTE[0]));
  selectTool(pref('tool', 'pen'));
  applyPenMode();
  state.view = pref('view', 'all');
  if (state.view.startsWith('folder:') && !folderById(state.view.slice(7))) state.view = 'all';
  await purgeOldTrash();
  renderNav();
  renderList();
  sync.start();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('Inkwell was updated', { action: 'Reload', onAction: () => location.reload(), ms: 10000 });
    });
  }
  if (new URLSearchParams(location.search).has('new')) { history.replaceState(null, '', location.pathname); newNote(); }
  if (FRAMED && !pref('previewNoted', false)) {
    setPref('previewNoted', true);
    toast('Preview: notes stay in this browser. Sync, voice notes and PDF export work once Inkwell runs on your own server.', { ms: 9000 });
  } else if (!store.persistent) toast('Offline storage is blocked here — notes are kept only until this tab closes.', { ms: 7000 });
}
main();
