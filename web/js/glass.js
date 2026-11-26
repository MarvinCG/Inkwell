// Liquid Glass helpers.
//  • Lenses: on Chromium (Chrome, Edge, Samsung Internet) each glass control gets an SVG filter as its
//    backdrop-filter. A displacement map, computed for the control's exact size and corner radius,
//    bends what's behind the rim the way a curved glass edge does. Safari can't render SVG filters in
//    backdrop-filter, so on the iPad the CSS frosted glass (blur + rim light) is used as is.
//  • Light: a small glow follows the mouse/pen over controls and fades in under a finger on press.

export const LENS_OK = (() => {
  try {
    const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
    return brands.some((b) => /Chromium/i.test(b.brand)) && !/iPhone|iPad|iPod/.test(navigator.userAgent);
  } catch { return false; }
})();

const SVGNS = 'http://www.w3.org/2000/svg';
const defs = () => document.querySelector('#glassDefs defs');
const filters = new Map(); // key → { id, users }
const using = new WeakMap(); // element → key
let seq = 0;

/** Displacement map for a rounded rectangle: zero in the middle, bending inward toward the rim. */
function lensMap(w, h, r, bezel) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const hw = w / 2, hh = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - hw, py = y + 0.5 - hh;
      const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
      const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
      const out = Math.hypot(ox, oy);
      const e = r - out - Math.min(Math.max(qx, qy), 0); // distance in from the edge
      let dx = 0, dy = 0;
      if (e < bezel) {
        let nx, ny;
        if (qx > 0 && qy > 0) { nx = ox / (out || 1); ny = oy / (out || 1); }
        else if (qx > qy) { nx = 1; ny = 0; } else { nx = 0; ny = 1; }
        nx *= Math.sign(px) || 1; ny *= Math.sign(py) || 1;
        const t = Math.min(1, Math.max(0, 1 - e / bezel)); // 0 inside the bezel … 1 at the rim
        const m = 1 - Math.sqrt(1 - t * t); // circular (convex) rim profile: flat middle, steep edge
        dx = -nx * m; dy = -ny * m; // look inward, like a magnifying edge
      }
      const i = (y * w + x) * 4;
      d[i] = 128 + dx * 127; d[i + 1] = 128 + dy * 127; d[i + 2] = 128; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = c.toDataURL('image/png');
  c.width = c.height = 0;
  return url;
}

function filterFor(w, h, r, blur) {
  const bezel = Math.max(6, Math.min(r, h / 2) * 0.75);
  const scale = Math.round(Math.min(34, Math.min(w, h) * 0.42));
  const key = `${w}x${h}r${r}b${blur}`;
  let f = filters.get(key);
  if (f) return f;
  const id = `lens${++seq}`;
  const el = document.createElementNS(SVGNS, 'filter');
  el.id = id;
  for (const [k, v] of Object.entries({ x: 0, y: 0, width: w, height: h, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' })) el.setAttribute(k, v);
  el.innerHTML = `<feImage href="${lensMap(w, h, r, bezel)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>
    <feGaussianBlur in="SourceGraphic" stdDeviation="${blur}" edgeMode="duplicate" result="soft"/>
    <feDisplacementMap in="soft" in2="map" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="bent"/>
    <feColorMatrix in="bent" type="saturate" values="1.7"/>`;
  defs().append(el);
  f = { id, el, users: 0 };
  filters.set(key, f);
  return f;
}

function release(elm) {
  const key = using.get(elm);
  if (!key) return;
  using.delete(elm);
  const f = filters.get(key);
  if (f && --f.users <= 0) { f.el.remove(); filters.delete(key); }
}

function applyLens(elm) {
  const w = Math.round(elm.offsetWidth), h = Math.round(elm.offsetHeight);
  if (!w || !h || w > 2400 || h > 400) return; // hidden, or too big to be worth it
  const cs = getComputedStyle(elm);
  const raw = cs.borderTopLeftRadius;
  let r = raw.endsWith('%') ? (parseFloat(raw) / 100) * Math.min(w, h) : parseFloat(raw) || 0;
  r = Math.max(2, Math.min(r, w / 2, h / 2));
  const blur = elm.classList.contains('clear') ? 1.5 : 3.5;
  const key = `${w}x${h}r${Math.round(r)}b${blur}`;
  if (using.get(elm) === key) return;
  release(elm);
  const f = filterFor(w, h, Math.round(r), blur);
  f.users++;
  using.set(elm, key);
  elm.style.backdropFilter = `url(#${f.id})`;
}

const ro = LENS_OK ? new ResizeObserver((entries) => {
  for (const e of entries) applyLens(e.target);
}) : null;

/** Light that follows the pointer, and glows under a finger while pressed. */
function bindLight(elm) {
  let raf = 0, lx = 0, ly = 0;
  const put = () => { raf = 0; elm.style.setProperty('--lx', lx + '%'); elm.style.setProperty('--ly', ly + '%'); };
  const at = (e) => {
    const r = elm.getBoundingClientRect();
    lx = Math.round(((e.clientX - r.left) / (r.width || 1)) * 100);
    ly = Math.round(((e.clientY - r.top) / (r.height || 1)) * 100);
    if (!raf) raf = requestAnimationFrame(put);
  };
  elm.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') at(e); }, { passive: true });
  elm.addEventListener('pointerdown', (e) => { at(e); elm.classList.add('lit'); }, { passive: true });
  const off = () => elm.classList.remove('lit');
  elm.addEventListener('pointerup', off, { passive: true });
  elm.addEventListener('pointercancel', off, { passive: true });
  elm.addEventListener('pointerleave', off, { passive: true }); // keep the position: the light fades out where it was
}

/** Set up every glass control under root (call again for controls added later). */
export function initGlass(root = document) {
  for (const elm of root.querySelectorAll('.glass')) {
    if (elm._glass) continue;
    elm._glass = true;
    // Big translucent panels (sidebar, menus, dialogs, toasts) are frosted only: no lens and no
    // press light (on a whole panel it read as a white flash in dark mode).
    if (elm.matches('.thick, .dark')) continue;
    bindLight(elm);
    if (ro) ro.observe(elm);
  }
}
