// Menus, toasts and dialogs.
import { icon, hydrateIcons } from './icons.js';
import { escapeHTML } from './sanitize.js';

const menuEl = () => document.getElementById('menu');
const toastEl = () => document.getElementById('toast');
const dlgEl = () => document.getElementById('dlg');

// ───────── toast ─────────
let toastTimer = 0;
export function toast(message, { action, onAction, ms = 3800 } = {}) {
  const el = toastEl();
  clearTimeout(toastTimer);
  el.innerHTML = `<span>${escapeHTML(message)}</span>${action ? `<button type="button">${escapeHTML(action)}</button>` : ''}`;
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; onAction && onAction(); };
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ───────── menu ─────────
let menuCleanup = null;
export function closeMenu() {
  const el = menuEl();
  if (el.hidden) return false;
  el.hidden = true;
  el.innerHTML = '';
  if (menuCleanup) { menuCleanup(); menuCleanup = null; }
  return true;
}
export function menuOpen() { return !menuEl().hidden; }

/**
 * items: { label, icon, onClick, danger, checked, disabled } | 'sep' | { head } |
 *        { swatches: [color|null], onPick, active }
 * anchor: element, or { x, y } point.
 */
export function showMenu(anchor, items, { align = 'end' } = {}) {
  closeMenu();
  const el = menuEl();
  const actions = [];
  let html = '';
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') { html += '<div class="menu-sep"></div>'; continue; }
    if (it.head) { html += `<div class="menu-head">${escapeHTML(it.head)}</div>`; continue; }
    if (it.swatches) {
      html += '<div class="menu-swatches">';
      for (const c of it.swatches) {
        const idx = actions.push(() => it.onPick(c)) - 1;
        html += c
          ? `<button type="button" data-a="${idx}" aria-label="${c}" style="background:${c}"></button>`
          : `<button type="button" data-a="${idx}" class="none" aria-label="Default"></button>`;
      }
      html += '</div>';
      continue;
    }
    const idx = actions.push(it.onClick) - 1;
    html += `<button type="button" role="menuitem" data-a="${idx}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>
      ${it.icon ? icon(it.icon) : ''}<span>${escapeHTML(it.label)}</span>${it.checked ? `<span class="check">${icon('check')}</span>` : ''}</button>`;
  }
  el.innerHTML = html;
  el.hidden = false;
  hydrateIcons(el);

  // position
  const mw = el.offsetWidth, mh = el.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let x, y;
  if (anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    x = align === 'start' ? r.left : r.right - mw;
    y = r.bottom + 6;
    if (y + mh > vh - 8) y = Math.max(8, r.top - mh - 6);
  } else { x = anchor.x; y = anchor.y; if (y + mh > vh - 8) y = Math.max(8, vh - mh - 8); }
  x = Math.max(8, Math.min(x, vw - mw - 8));
  el.style.left = x + 'px';
  el.style.top = y + 'px';

  // keep focus where it was (e.g., text selection in the editor)
  el.onmousedown = (e) => e.preventDefault();
  el.onclick = (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const fn = actions[+b.dataset.a];
    closeMenu();
    fn && fn();
  };
  const outside = (e) => { if (!el.contains(e.target)) closeMenu(); };
  const onResize = () => closeMenu();
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  window.addEventListener('resize', onResize);
  menuCleanup = () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', onResize); };
  const first = el.querySelector('button:not([disabled])');
  if (first && matchMedia('(pointer: fine)').matches && !(document.activeElement && document.activeElement.isContentEditable)) first.focus({ preventScroll: true });
}

// ───────── dialog ─────────
export function dialogOpen() { return dlgEl().open; }

/** Returns a promise resolving to the clicked action's value (or null when dismissed). */
export function dialog({ title, html = '', actions = [{ label: 'Close', value: null }], onOpen }) {
  const d = dlgEl();
  if (d.open) d.close();
  d.innerHTML = `<form method="dialog" class="dlg-inner">
    ${title ? `<h2>${escapeHTML(title)}</h2>` : ''}
    <div class="dlg-body">${html}</div>
    <div class="dlg-actions">${actions.map((a, i) => `<button type="${a.primary ? 'submit' : 'button'}" class="btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}" data-i="${i}">${escapeHTML(a.label)}</button>`).join('')}</div>
  </form>`;
  hydrateIcons(d);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; if (d.open) d.close(); resolve(v); };
    d.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const a = actions.find((x) => x.primary);
      finish(a ? (typeof a.value === 'function' ? a.value(d) : a.value ?? true) : true);
    });
    d.querySelectorAll('.dlg-actions button[type="button"]').forEach((b) => {
      b.addEventListener('click', () => { const a = actions[+b.dataset.i]; finish(typeof a.value === 'function' ? a.value(d) : a.value ?? null); });
    });
    d.addEventListener('cancel', () => finish(null), { once: true });
    d.addEventListener('close', () => finish(null), { once: true });
    d.showModal();
    if (onOpen) onOpen(d);
  });
}

export async function confirmDialog(title, message, okLabel = 'OK', danger = false) {
  const v = await dialog({
    title,
    html: `<p style="margin:0;line-height:1.5;color:var(--text-2)">${escapeHTML(message)}</p>`,
    actions: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: !danger, danger }],
  });
  return v === true;
}

export async function promptDialog(title, label, value = '') {
  const v = await dialog({
    title,
    html: `<label class="field"><span>${escapeHTML(label)}</span><input type="text" name="v" value="${escapeHTML(value)}" maxlength="80" autocomplete="off"></label>`,
    actions: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: (d) => d.querySelector('input').value.trim() }],
    onOpen: (d) => { const i = d.querySelector('input'); i.focus(); i.select(); },
  });
  return v || null;
}
