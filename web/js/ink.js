// Handwriting layer: pressure-sensitive strokes, highlighter, eraser, lasso, undo/redo,
// palm rejection, touch pan/pinch. Strokes live in page coordinates (logical px).
//
// Stroke: { id, t: 'pen'|'pencil'|'hl', c: '#rrggbb', w: number, p: [x, y, pressure, x, y, pressure, ...] }

import { uid } from './store.js';

export const PALETTE = ['#1a1a1a', '#5f6368', '#1f6feb', '#0b8a7a', '#2e9d44', '#f2b600', '#f26b1d', '#e5484d', '#d6409f', '#8e4ec6', '#8d5a3b', '#ffffff'];
export const DEFAULT_SIZES = { pen: 3, pencil: 2.5, hl: 16, eraser: 10 };

const TILE = 512; // CSS px: height of an ink strip (width = page width, up to MAX_TW)
const MAX_TW = 2048;
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

const bboxCache = new WeakMap();
const pathCache = new WeakMap(); // stroke → { path, width, alpha } (rebuilt when the stroke's points change)
export function bbox(s) {
  let b = bboxCache.get(s);
  if (b) return b;
  const p = s.p;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const pad = s.w;
  b = { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  bboxCache.set(s, b);
  return b;
}
const invalidate = (s) => { bboxCache.delete(s); pathCache.delete(s); };

function penWidth(s, pr) { return s.w * (0.28 + 0.95 * Math.pow(Math.max(0.02, pr), 0.85)); }

/**
 * Centerline samples of a stroke: the same midpoint-quadratic smoothing the app has always used,
 * flattened into points (x, y, pressure) so a pen stroke can be drawn as ONE filled outline.
 */
function centerline(p) {
  const n = p.length / 3;
  const out = [p[0], p[1], p[2]];
  const quad = (x0, y0, p0, cx, cy, pc, x1, y1, p1) => {
    const len = Math.hypot(cx - x0, cy - y0) + Math.hypot(x1 - cx, y1 - cy);
    const steps = Math.min(8, Math.max(1, Math.ceil(len / 3)));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, u = 1 - t;
      out.push(u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1, u * p0 + t * p1 + 0 * pc);
    }
  };
  let sx = (p[0] + p[3]) / 2, sy = (p[1] + p[4]) / 2, sp = (p[2] + p[5]) / 2;
  out.push(sx, sy, sp);
  for (let i = 1; i < n - 1; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], pr = p[i * 3 + 2];
    const mx = (x + p[i * 3 + 3]) / 2, my = (y + p[i * 3 + 4]) / 2, mp = (pr + p[i * 3 + 5]) / 2;
    quad(sx, sy, sp, x, y, pr, mx, my, mp);
    sx = mx; sy = my; sp = mp;
  }
  out.push(p[(n - 1) * 3], p[(n - 1) * 3 + 1], p[(n - 1) * 3 + 2]);
  return out;
}

/** Variable-width pen stroke as a single closed outline (+ round caps). */
function penPath(s) {
  const p = s.p, n = p.length / 3;
  const path = new Path2D();
  if (n === 1) { const r = penWidth(s, p[2]) / 2; path.moveTo(p[0] + r, p[1]); path.arc(p[0], p[1], r, 0, Math.PI * 2); return path; }
  const c = centerline(p);
  const m = c.length / 3;
  const L = new Float64Array(m * 2), R = new Float64Array(m * 2);
  let r0 = 0, r1 = 0;
  for (let i = 0; i < m; i++) {
    const a = Math.max(0, i - 1), b = Math.min(m - 1, i + 1);
    let dx = c[b * 3] - c[a * 3], dy = c[b * 3 + 1] - c[a * 3 + 1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const r = penWidth(s, c[i * 3 + 2]) / 2;
    if (i === 0) r0 = r;
    if (i === m - 1) r1 = r;
    L[i * 2] = c[i * 3] - dy * r; L[i * 2 + 1] = c[i * 3 + 1] + dx * r;
    R[i * 2] = c[i * 3] + dy * r; R[i * 2 + 1] = c[i * 3 + 1] - dx * r;
  }
  path.moveTo(L[0], L[1]);
  for (let i = 1; i < m; i++) path.lineTo(L[i * 2], L[i * 2 + 1]);
  for (let i = m - 1; i >= 0; i--) path.lineTo(R[i * 2], R[i * 2 + 1]);
  path.closePath();
  // round caps
  const ex = c[(m - 1) * 3], ey = c[(m - 1) * 3 + 1];
  path.moveTo(c[0] + r0, c[1]); path.arc(c[0], c[1], r0, 0, Math.PI * 2);
  path.moveTo(ex + r1, ey); path.arc(ex, ey, r1, 0, Math.PI * 2);
  return path;
}

/** Highlighter / pencil: one centerline stroked at a constant width. */
function linePath(s) {
  const p = s.p, n = p.length / 3;
  let avg = 0;
  for (let i = 2; i < p.length; i += 3) avg += p[i];
  avg /= n;
  const width = s.t === 'hl' ? s.w : s.w * (0.55 + 0.6 * avg);
  const alpha = s.t === 'hl' ? null : 0.5 + 0.45 * avg;
  const path = new Path2D();
  if (n === 1) { path.moveTo(p[0] + width / 2, p[1]); path.arc(p[0], p[1], width / 2, 0, Math.PI * 2); return { path, width, alpha, dot: true }; }
  path.moveTo(p[0], p[1]);
  for (let i = 1; i < n - 1; i++) {
    const x = p[i * 3], y = p[i * 3 + 1];
    path.quadraticCurveTo(x, y, (x + p[i * 3 + 3]) / 2, (y + p[i * 3 + 4]) / 2);
  }
  path.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
  return { path, width, alpha, dot: false };
}

function geometry(s, cache) {
  let g = cache ? pathCache.get(s) : null;
  if (!g) {
    g = s.t === 'hl' || s.t === 'pencil' ? linePath(s) : { path: penPath(s), dot: true };
    if (cache) pathCache.set(s, g);
  }
  return g;
}

/**
 * Draw one stroke in logical coordinates onto ctx (transform already set).
 * cache=false for the stroke being drawn right now (its points change every frame).
 */
/** Copy strokes (much faster than structuredClone for big notes: 450k numbers in a few ms). */
export function cloneInk(list) {
  return (list || []).map((x) => ({ ...x, p: x.p.slice() }));
}
export function drawStroke(ctx, s, colorFn = (c) => c, hlAlpha = 0.32, cache = true) {
  if (!s.p.length) return;
  const g = geometry(s, cache);
  const color = colorFn(s.c, s.t);
  ctx.globalAlpha = s.t === 'hl' ? hlAlpha : g.alpha == null ? 1 : g.alpha;
  if (g.dot) { ctx.fillStyle = color; ctx.fill(g.path); }
  else {
    ctx.strokeStyle = color;
    ctx.lineWidth = g.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(g.path);
  }
  ctx.globalAlpha = 1;
}

/** Thumbnail of the top of the page (pageWidth × 1.2·pageWidth). Returns a PNG data URL or null. */
export function renderThumb(strokes, pageWidth, outW = 360) {
  if (!strokes || !strokes.length) return null;
  const regionH = pageWidth * 1.2;
  const visible = strokes.filter((s) => bbox(s).y0 < regionH);
  if (!visible.length) return null;
  try {
    const c = document.createElement('canvas');
    c.width = outW; c.height = Math.round(outW * 1.2);
    const ctx = c.getContext('2d');
    const k = outW / pageWidth;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    for (const s of visible) drawStroke(ctx, s);
    return c.toDataURL('image/png');
  } catch { return null; }
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return Math.sqrt(x * x + y * y);
}
function hitStroke(s, x, y, r) {
  const p = s.p, n = p.length / 3;
  const half = (s.t === 'hl' ? s.w : s.w * 1.2) / 2;
  const lim = r + half;
  if (n === 1) return Math.hypot(p[0] - x, p[1] - y) <= lim;
  for (let i = 0; i < n - 1; i++) {
    if (distToSeg(x, y, p[i * 3], p[i * 3 + 1], p[i * 3 + 3], p[i * 3 + 4]) <= lim) return true;
  }
  return false;
}
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export class InkLayer {
  /**
   * opts: { stage, scroller, wrap, canvas, live, selBox, view: { getScale, getZoom, zoomTo, toLogical },
   *         onChange, onPen, onHistory, colorFn }
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.ctx = this.canvas.getContext('2d');
    this.lctx = this.live.getContext('2d');
    this.strokes = [];
    this.enabled = false;
    this.tool = 'pen';
    this.color = PALETTE[0];
    this.sizes = { ...DEFAULT_SIZES };
    // How touches (fingers, simple capacitive styluses) behave in handwriting mode:
    //   'pen'     only an active pen (S Pen, Apple Pencil) draws; fingers scroll and zoom
    //   'stylus'  "hand rest": a fingertip or simple stylus draws, large contacts (a resting palm) are ignored
    //   'fingers' every touch draws, whatever its size
    this.touchMode = 'stylus';
    this.undoStack = [];
    this.redoStack = [];
    this.selection = null; // array of strokes
    this.lifted = null; // Set of strokes being dragged (drawn on the overlay, not the strips)
    this.active = null;
    this.touches = new Map();
    this.ignored = new Set();
    this.gesture = null;
    this.lastPen = -1e9;
    this.dpr = 1;
    this._raf = 0;
    this._liveRaf = 0;
    this.cursor = null;
    this.hlAlpha = 0.32;
    this.tiles = new Map();
    this.tileScale = 0;
    this.tw = TILE;
    this.tilesEl = document.createElement('div');
    this.tilesEl.className = 'ink-tiles';
    this.wrap.append(this.tilesEl);

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e, false));
    c.addEventListener('pointercancel', (e) => this.onUp(e, true));
    c.addEventListener('lostpointercapture', (e) => { if (this.active && this.active.id === e.pointerId) this.onUp(e, false); });
    c.addEventListener('touchstart', (e) => { if (this.enabled) e.preventDefault(); }, { passive: false });
    c.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && !this.active) { this.cursor = null; this.drawLive(); } });
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('touchmove', (e) => { if (this.enabled) e.preventDefault(); }, { passive: false });
    this.scroller.addEventListener('scroll', () => this.render(), { passive: true });

    this.selBox.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sel]');
      if (!b) return;
      const act = b.dataset.sel;
      if (act === 'delete') this.deleteSelection();
      else if (act === 'duplicate') this.duplicateSelection();
      else if (act === 'recolor') this.recolorSelection();
    });
  }

  get penOnly() { return this.touchMode === 'pen'; }

  // ───────── state ─────────
  load(strokes) {
    this.strokes = Array.isArray(strokes) ? strokes.filter((s) => s && Array.isArray(s.p) && s.p.length >= 3) : [];
    this.undoStack = [];
    this.redoStack = [];
    this.clearSelection(false);
    this.history();
    for (const t of this.tiles.values()) t.dirty = true;
    this.syncBlend();
    this.render();
  }
  serialize() { return this.strokes; }
  maxY() { let m = 0; for (const s of this.strokes) { const b = bbox(s); if (b.y1 > m) m = b.y1; } return m; }
  maxX() { let m = 0; for (const s of this.strokes) { const b = bbox(s); if (b.x1 > m) m = b.x1; } return m; }
  scaleAll(k) {
    for (const s of this.strokes) { for (let i = 0; i < s.p.length; i += 3) { s.p[i] = r1(s.p[i] * k); s.p[i + 1] = r1(s.p[i + 1] * k); } invalidate(s); }
    this.undoStack = []; this.redoStack = []; this.history();
    this.renderNow();
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) { this.cancelActive(); this.clearSelection(false); this.cursor = null; this.drawLive(); }
  }
  setTool(t) {
    this.tool = t;
    if (t !== 'lasso') this.clearSelection(false);
    this.drawLive();
  }

  // ───────── geometry ─────────
  resize() {
    const w = this.scroller.clientWidth, h = this.scroller.clientHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    for (const c of [this.canvas, this.live]) {
      c.style.width = w + 'px';
      c.style.height = h + 'px';
      const W = Math.max(1, Math.round(w * this.dpr)), H = Math.max(1, Math.round(h * this.dpr));
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    }
    this._overlayDirty = true;
    this.render();
    this.drawLive();
  }
  transform() {
    const sr = this.canvas.getBoundingClientRect();
    const pr = this.wrap.getBoundingClientRect();
    const s = this.view.getScale(), d = this.dpr;
    return {
      s, d,
      a: d * s, e: (pr.left - sr.left) * d, f: (pr.top - sr.top) * d,
      x0: (sr.left - pr.left) / s, y0: (sr.top - pr.top) / s,
      x1: (sr.right - pr.left) / s, y1: (sr.bottom - pr.top) / s,
      ox: pr.left - sr.left, oy: pr.top - sr.top,
    };
  }

  // ───────── rendering ─────────
  // Committed strokes live in TILES: canvases inside the page that scroll natively with it, so
  // scrolling never redraws handwriting. Only tiles coming into view are drawn (a few per frame),
  // tiles far away are dropped to save memory. The viewport-sized #inkCanvas only shows the
  // selection glow; #liveCanvas shows the stroke being drawn.
  tileRes() { return Math.max(1, Math.min(this.dpr || 1, 3, 4096 / this.tw)); }
  /** Logical (stroke-space) rectangle covered by a tile. */
  tileRect(t) {
    const s = this.tileScale;
    return { x0: (t.i * this.tw) / s, y0: (t.j * TILE) / s, x1: ((t.i + 1) * this.tw) / s, y1: ((t.j + 1) * TILE) / s };
  }
  /** Schedule: create/draw tiles that came into view, refresh the selection overlay. */
  render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.updateTiles(6); this.renderOverlay(); });
  }
  /** Redraw everything now (new note loaded, theme changed, undo…). */
  renderNow() {
    for (const t of this.tiles.values()) t.dirty = true;
    this.updateTiles(8); // on-screen strips now, the ones above/below over the next frames
    this.renderOverlay();
  }
  /** Redraw only the tiles touched by these strokes (bounding boxes collected before and after a change). */
  refreshBoxes(boxes) {
    if (!boxes.length) return;
    for (const t of this.tiles.values()) {
      const r = this.tileRect(t);
      if (boxes.some((b) => b.x1 >= r.x0 && b.x0 <= r.x1 && b.y1 >= r.y0 && b.y0 <= r.y1)) t.dirty = true;
    }
    this.render();
  }
  refreshStrokes(list) { this.refreshBoxes(list.map((x) => bbox(x))); }
  neededTiles() {
    const sc = this.scroller, s = this.view.getScale();
    const W = this.wrap.offsetWidth, H = this.wrap.offsetHeight;
    const wl = this.wrap.offsetLeft, wt = this.wrap.offsetTop;
    const marginY = sc.clientHeight * 0.5;
    const x0 = Math.max(0, sc.scrollLeft - wl), x1 = Math.min(W, sc.scrollLeft + sc.clientWidth - wl);
    const y0 = Math.max(0, sc.scrollTop - wt - marginY), y1 = Math.min(H, sc.scrollTop + sc.clientHeight - wt + marginY);
    const out = [];
    if (x1 <= x0 || y1 <= y0 || !s) return out;
    const v0 = sc.scrollTop - wt, v1 = v0 + sc.clientHeight; // on screen right now
    for (let j = Math.floor(y0 / TILE); j <= Math.floor((y1 - 1) / TILE); j++)
      for (let i = Math.floor(x0 / this.tw); i <= Math.floor((x1 - 1) / this.tw); i++) out.push([i, j, (j + 1) * TILE > v0 && j * TILE < v1]);
    // nearest to the middle of the screen first
    const cy = (sc.scrollTop - wt + sc.clientHeight / 2) / TILE;
    out.sort((a, b) => Math.abs(a[1] + 0.5 - cy) - Math.abs(b[1] + 0.5 - cy));
    return out;
  }
  /** budget = ms per frame for strips that aren't on screen yet (on-screen ones always finish). */
  updateTiles(budget) {
    const s = this.view.getScale();
    const tw = Math.min(MAX_TW, Math.max(64, Math.ceil(this.wrap.offsetWidth)));
    if (tw !== this.tw && s === this.tileScale) { this.dropTiles(); this.tw = tw; }
    if (s !== this.tileScale) {
      // Zoom / rotation: stretch the old tiles for a moment (smooth pinch), redraw crisp ones when it settles.
      if (this.tiles.size && this.tileScale) {
        this.tilesEl.style.transform = `scale(${s / this.tileScale})`;
        clearTimeout(this._rescale);
        this._rescale = setTimeout(() => { this.dropTiles(); this.tileScale = 0; this.tilesEl.style.transform = ''; this.render(); }, 160);
        return;
      }
      this.dropTiles();
      this.tileScale = s;
      this.tw = tw;
      this.tilesEl.style.transform = '';
    }
    const need = this.neededTiles();
    const keep = new Set();
    const deadline = performance.now() + budget;
    let pending = false;
    for (const [i, j, onScreen] of need) {
      const key = i + ',' + j;
      keep.add(key);
      let t = this.tiles.get(key);
      if (!t) { t = this.makeTile(i, j); this.tiles.set(key, t); }
      if (t.dirty || t.queue) {
        // strips on screen are finished now; those just ahead of the scroll a few ms per frame
        if (onScreen) this.drawTile(t, Infinity);
        else if (performance.now() < deadline) this.drawTile(t, deadline);
        pending = pending || t.dirty || !!t.queue;
      }
    }
    for (const [key, t] of this.tiles) if (!keep.has(key)) { this.freeTile(t); this.tiles.delete(key); }
    if (pending) this.render(); // continue next frame
  }
  makeTile(i, j) {
    const c = document.createElement('canvas');
    const r = this.tileRes();
    c.width = Math.round(this.tw * r);
    c.height = Math.round(TILE * r);
    c.style.cssText = `left:${i * this.tw}px;top:${j * TILE}px;width:${this.tw}px;height:${TILE}px`;
    this.tilesEl.append(c);
    return { i, j, canvas: c, ctx: c.getContext('2d'), dirty: true, queue: null, qi: 0, r };
  }
  /** Draw a strip, possibly over several frames: t.queue holds the strokes still to draw. */
  drawTile(t, deadline) {
    const ctx = t.ctx, s = this.tileScale, r = t.r;
    if (t.dirty) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, t.canvas.width, t.canvas.height);
      const R = this.tileRect(t);
      const L = this.lifted;
      t.queue = this.strokes.filter((st) => { if (L && L.has(st)) return false; const b = bbox(st); return !(b.x1 < R.x0 || b.x0 > R.x1 || b.y1 < R.y0 || b.y0 > R.y1); });
      t.qi = 0;
      t.dirty = false;
    }
    ctx.setTransform(s * r, 0, 0, s * r, -t.i * this.tw * r, -t.j * TILE * r);
    const q = t.queue;
    let k = t.qi;
    while (k < q.length) {
      drawStroke(ctx, q[k++], this.colorFn, this.hlAlpha);
      if ((k & 15) === 0 && performance.now() > deadline) break;
    }
    if (k >= q.length) t.queue = null;
    else t.qi = k;
  }
  // Zero-size the canvas so Safari gives the memory back now rather than at the next GC.
  freeTile(t) { t.canvas.width = t.canvas.height = 0; t.canvas.remove(); }
  dropTiles() { for (const t of this.tiles.values()) this.freeTile(t); this.tiles.clear(); }
  /** Blending (highlighter that doesn't wash out text) costs a lot while scrolling: only on when needed. */
  syncBlend() { this.tilesEl.classList.toggle('blend', this.strokes.some((x) => x.t === 'hl')); }
  /** Free tile memory (note closed). */
  release() { this.dropTiles(); this.tileScale = 0; }
  /** End of a drag: the lifted strokes go back into the strips at their new place. */
  drop() {
    if (!this.lifted) return;
    const list = [...this.lifted];
    this.lifted = null;
    this.refreshStrokes(list);
  }
  /** Selection glow on the viewport overlay; only drawn while something is selected. */
  renderOverlay() {
    const ctx = this.ctx;
    const hasSel = this.selection && this.selection.length;
    if (!hasSel && !this._overlayDirty) { this.selBox.hidden = true; return; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._overlayDirty = !!hasSel;
    const T = this.transform();
    if (hasSel) {
      ctx.setTransform(T.a, 0, 0, T.a, T.e, T.f);
      ctx.save();
      ctx.shadowColor = 'rgba(242,107,29,.85)';
      ctx.shadowBlur = 6 * T.d;
      for (const st of this.selection) drawStroke(ctx, st, this.colorFn, this.hlAlpha);
      ctx.restore();
      if (this.lifted) for (const st of this.selection) drawStroke(ctx, st, this.colorFn, this.hlAlpha); // crisp on top of the glow
    }
    this.placeSelBox(T);
  }
  /** A just-finished stroke: draw it straight onto the tiles it touches (no redraw). */
  drawOnTop(stroke) {
    const b = bbox(stroke), s = this.tileScale;
    if (stroke.t === 'hl') this.tilesEl.classList.add('blend');
    if (!s) { this.render(); return; }
    for (const t of this.tiles.values()) {
      const R = this.tileRect(t);
      if (b.x1 < R.x0 || b.x0 > R.x1 || b.y1 < R.y0 || b.y0 > R.y1 || t.dirty) continue;
      if (t.queue) { t.queue.push(stroke); continue; } // still being drawn: keep the stacking order
      t.ctx.setTransform(s * t.r, 0, 0, s * t.r, -t.i * this.tw * t.r, -t.j * TILE * t.r);
      drawStroke(t.ctx, stroke, this.colorFn, this.hlAlpha);
    }
    this.render(); // the stroke may have grown the page: make sure new tiles exist
  }
  drawLive() {
    if (this._liveRaf) return;
    this._liveRaf = requestAnimationFrame(() => {
      this._liveRaf = 0;
      const ctx = this.lctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.live.width, this.live.height);
      if (!this.enabled) return;
      const T = this.transform();
      ctx.setTransform(T.a, 0, 0, T.a, T.e, T.f);
      const a = this.active;
      if (a && a.stroke) drawStroke(ctx, a.stroke, this.colorFn, this.hlAlpha, false);
      if (a && a.kind === 'lasso' && a.poly.length > 2) {
        ctx.save();
        ctx.lineWidth = 1.5 / T.s;
        ctx.setLineDash([6 / T.s, 5 / T.s]);
        ctx.strokeStyle = '#f26b1d';
        ctx.fillStyle = 'rgba(242,107,29,.07)';
        ctx.beginPath();
        ctx.moveTo(a.poly[0], a.poly[1]);
        for (let i = 2; i < a.poly.length; i += 2) ctx.lineTo(a.poly[i], a.poly[i + 1]);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.restore();
      }
      if (this.cursor && (this.tool === 'eraser' || (a && a.tool === 'eraser'))) {
        ctx.save();
        ctx.lineWidth = 1.2 / T.s;
        ctx.strokeStyle = 'rgba(120,120,120,.9)';
        ctx.fillStyle = 'rgba(255,255,255,.25)';
        ctx.beginPath(); ctx.arc(this.cursor.x, this.cursor.y, this.eraserRadius(), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.restore();
      }
    });
  }
  eraserRadius() { return 3 + this.sizes.eraser * 1.2; }

  // ───────── input ─────────
  pt(e) { return this.view.toLogical(e.clientX, e.clientY); }
  pressure(e) {
    if (e.pointerType === 'pen') return e.pressure > 0 ? e.pressure : 0.5;
    return 0.5;
  }
  capture(e) { try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or released */ } }

  onDown(e) {
    if (!this.enabled) return;
    const now = performance.now();
    this.stopInertia();
    if (e.pointerType === 'pen') { this.lastPen = now; this.onPen && this.onPen(); if (this.gesture) this.endGesture(true); }

    if (e.pointerType === 'touch') {
      e.preventDefault();
      // First finger down means no other finger is on the glass: forget any touch whose lift event the
      // browser never delivered (iPadOS drops some), so it can't make later touches look like two-finger scrolls.
      if (e.isPrimary) this.resetTouches();
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.capture(e);
      // Palm rejection only matters while a pen is in use. A finger's reported size varies a lot (iPad Safari
      // reports it in coarse steps), so size is never used to throw away a touch when fingers draw.
      const penBusy = (this.active && this.active.pointerType === 'pen') || now - this.lastPen < 600;
      if (penBusy || this.isPalm(e)) { this.ignore(e.pointerId); return; }
      if (this.touchMode === 'pen') { this.startGesture(); return; }
      if (this.touches.size > 1) {
        const a = this.active;
        if (a && a.pointerType === 'touch' && a.kind === 'stroke') {
          const writing = this.extent(a.stroke) > 6 / this.view.getScale();
          if (writing && now - a.t0 > 180) { this.ignore(e.pointerId); return; } // resting knuckle/palm while writing
          if (!writing && this.touchMode === 'stylus') {
            // The first contact sat still (side of the hand): hand the stroke over to the new touch.
            const old = a.id;
            this.cancelActive();
            this.ignore(old);
          } else { this.cancelActive(); this.startGesture(); return; } // two fingers together: scroll / pinch
        } else {
          if (a && a.pointerType === 'touch') this.cancelActive();
          this.startGesture();
          return;
        }
      }
      // one drawing touch: falls through
    } else if (e.pointerType === 'mouse') {
      if (e.button === 1) { e.preventDefault(); this.startMousePan(e); return; }
      if (e.button !== 0) return;
    }

    // A primary pointer of the same kind going down while we think one is still drawing: that earlier
    // pointer's lift was lost. Finish it instead of blocking all input.
    if (this.active && e.isPrimary && this.active.pointerType === e.pointerType && this.active.id !== e.pointerId) this.finish(this.active, false);
    if (this.active) return; // one drawing pointer at a time
    e.preventDefault();
    this.capture(e);
    let tool = this.tool;
    if (e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) || (e.buttons & 2))) tool = 'eraser';
    const p = this.pt(e);
    this.active = { id: e.pointerId, pointerType: e.pointerType, tool, kind: 'stroke', t0: now };

    if (tool === 'eraser') {
      this.active.kind = 'erase';
      this.active.removed = [];
      this.cursor = p;
      this.eraseAt(p.x, p.y);
    } else if (tool === 'lasso') {
      const sb = this.selBounds();
      if (sb && p.x >= sb.x0 - 8 && p.x <= sb.x1 + 8 && p.y >= sb.y0 - 8 && p.y <= sb.y1 + 8) {
        this.active.kind = 'move';
        this.active.last = p; this.active.dx = 0; this.active.dy = 0;
      } else {
        this.clearSelection(false);
        this.active.kind = 'lasso';
        this.active.poly = [p.x, p.y];
        this.renderOverlay();
      }
    } else {
      const s = { id: uid(10), t: tool, c: this.color, w: this.sizes[tool] || 3, p: [] };
      this.active.stroke = s;
      this.active.pe = this.pressure(e);
      this.addPoint(p.x, p.y, this.active.pe, true);
    }
    this.drawLive();
  }

  addPoint(x, y, pr, force = false) {
    const a = this.active, s = a.stroke, P = s.p, n = P.length;
    a.pe = a.pe * 0.55 + pr * 0.45;
    if (!force && n >= 3) {
      const dx = x - P[n - 3], dy = y - P[n - 2];
      const min = 0.7 / this.view.getScale();
      if (dx * dx + dy * dy < min * min) { P[n - 1] = r2(Math.max(P[n - 1], a.pe)); return; }
    }
    P.push(r1(x), r1(y), r2(a.pe));
  }

  onMove(e) {
    if (!this.enabled) return;
    if (e.pointerType === 'pen' && !this.active) this.lastPen = performance.now(); // hovering S Pen / Pencil
    if (e.pointerType === 'touch') {
      if (this.ignored.has(e.pointerId)) return;
      if (this.touches.has(e.pointerId)) {
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.gesture) { this.moveGesture(); return; }
      }
    }
    if (this.mousePan && e.pointerId === this.mousePan.id) {
      this.scroller.scrollLeft -= e.clientX - this.mousePan.x;
      this.scroller.scrollTop -= e.clientY - this.mousePan.y;
      this.mousePan.x = e.clientX; this.mousePan.y = e.clientY;
      return;
    }
    const a = this.active;
    if (!a || a.id !== e.pointerId) {
      if (!a && e.pointerType !== 'touch' && this.tool === 'eraser') { this.cursor = this.pt(e); this.drawLive(); }
      return;
    }
    if (e.pointerType === 'touch' && this.isPalm(e)) {
      // A contact that spreads out while moving is a palm settling down, not the stylus.
      if (performance.now() - a.t0 < 400) this.cancelActive(); else this.finish(a, false);
      this.ignore(e.pointerId);
      return;
    }
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    if (a.kind === 'stroke') {
      for (const ev of evs) { const p = this.view.toLogical(ev.clientX, ev.clientY); this.addPoint(p.x, p.y, this.pressure(ev)); }
      this.drawLive();
    } else if (a.kind === 'erase') {
      for (const ev of evs) { const p = this.view.toLogical(ev.clientX, ev.clientY); this.eraseAt(p.x, p.y); this.cursor = p; }
      this.drawLive();
    } else if (a.kind === 'lasso') {
      const p = this.pt(e);
      a.poly.push(r1(p.x), r1(p.y));
      this.drawLive();
    } else if (a.kind === 'move') {
      const p = this.pt(e);
      const dx = p.x - a.last.x, dy = p.y - a.last.y;
      a.last = p; a.dx += dx; a.dy += dy;
      // While dragging, the selection is "lifted" off the strips and drawn on the overlay only, so a
      // drag costs one strip redraw at pick-up and one at drop instead of one per pointer move.
      if (!this.lifted) { this.lifted = new Set(this.selection); this.refreshStrokes(this.selection); }
      this.translate(this.selection, dx, dy);
      this.render();
    }
  }

  onUp(e, cancelled) {
    if (e.pointerType === 'pen') this.lastPen = performance.now();
    if (e.pointerType === 'touch') {
      this.ignored.delete(e.pointerId);
      if (this.touches.has(e.pointerId)) {
        this.touches.delete(e.pointerId);
        if (this.gesture) {
          if (this.touches.size === 0) this.endGesture(false);
          else this.startGesture(); // pinch → pan with the remaining finger
          return;
        }
      }
    }
    if (this.mousePan && e.pointerId === this.mousePan.id) { this.mousePan = null; return; }
    const a = this.active;
    if (!a || a.id !== e.pointerId) return;
    this.finish(a, cancelled, e.pointerType);
  }

  /** End the current tool action: commit the stroke / erase / lasso / move. */
  finish(a, cancelled, pointerType = a.pointerType) {
    if (this.active === a) this.active = null;
    if (a.kind === 'stroke') {
      if (cancelled && a.stroke.p.length < 9) { this.drawLive(); return; }
      this.strokes.push(a.stroke);
      this.push({ t: 'add', strokes: [a.stroke] });
      this.drawOnTop(a.stroke);
      this.changed();
    } else if (a.kind === 'erase') {
      if (a.removed.length) { this.push({ t: 'erase', items: a.removed }); this.changed(); }
      if (pointerType !== 'mouse') this.cursor = null;
    } else if (a.kind === 'lasso') {
      this.finishLasso(a.poly);
    } else if (a.kind === 'move') {
      this.drop();
      if (Math.abs(a.dx) + Math.abs(a.dy) > 0.5) { this.push({ t: 'move', strokes: [...this.selection], dx: a.dx, dy: a.dy }); this.changed(); }
    }
    this.drawLive();
  }

  ignore(id) { this.ignored.add(id); this.touches.delete(id); }
  /** Hand-rest mode: a contact bigger than ~60×60 px is a palm (same rule as v1.1). Pen-only: only very big ones. */
  isPalm(e) {
    const w = e.width || 0, h = e.height || 0;
    if (this.touchMode === 'stylus') return w * h > 3600;
    if (this.touchMode === 'pen') return Math.max(w, h) > 80;
    return false;
  }
  extent(s) {
    const p = s.p;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
    return p.length ? Math.max(x1 - x0, y1 - y0) : 0;
  }
  resetTouches() {
    this.touches.clear();
    this.ignored.clear();
    this.gesture = null;
    if (this.active && this.active.pointerType === 'touch') this.finish(this.active, false);
  }

  cancelActive() {
    if (!this.active) return;
    const a = this.active;
    this.active = null;
    if (a.kind === 'move' && this.selection) {
      // interrupted (e.g. a second finger started a pinch): put the selection back where it was
      this.translate(this.selection, -a.dx, -a.dy);
      this.drop();
    }
    if (a.kind === 'erase' && a.removed.length) {
      // restore what this gesture erased
      for (let i = a.removed.length - 1; i >= 0; i--) this.strokes.splice(a.removed[i].index, 0, a.removed[i].stroke);
      this.refreshStrokes(a.removed.map((x) => x.stroke));
    }
    this.drawLive();
  }

  onWheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.scroller.clientHeight : 1;
    if (e.ctrlKey || e.metaKey) {
      const z = this.view.getZoom() * Math.exp(-e.deltaY * k * 0.0025);
      this.view.zoomTo(z, e.clientX, e.clientY);
    } else {
      this.scroller.scrollLeft += (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * k;
      this.scroller.scrollTop += (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * k;
    }
  }

  // ───────── touch pan / pinch ─────────
  startGesture() {
    const pts = [...this.touches.values()];
    if (!pts.length) { this.gesture = null; return; }
    if (pts.length >= 2) {
      const [a, b] = pts;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.gesture = { mode: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: this.view.getZoom(), anchor: this.view.toLogical(mid.x, mid.y) };
    } else {
      this.gesture = { mode: 'pan', last: { ...pts[0] }, samples: [{ t: performance.now(), x: pts[0].x, y: pts[0].y }] };
    }
  }
  moveGesture() {
    const g = this.gesture;
    const pts = [...this.touches.values()];
    if (g.mode === 'pan') {
      if (pts.length >= 2) { this.startGesture(); return; }
      const p = pts[0];
      this.scroller.scrollLeft -= p.x - g.last.x;
      this.scroller.scrollTop -= p.y - g.last.y;
      g.last = { ...p };
      const now = performance.now();
      g.samples.push({ t: now, x: p.x, y: p.y });
      while (g.samples.length > 2 && now - g.samples[0].t > 100) g.samples.shift();
    } else if (pts.length >= 2) {
      const [a, b] = pts;
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      this.view.zoomTo(g.z0 * (d / g.d0), (a.x + b.x) / 2, (a.y + b.y) / 2, g.anchor);
    }
  }
  endGesture(abort) {
    const g = this.gesture;
    this.gesture = null;
    if (abort || !g || g.mode !== 'pan' || g.samples.length < 2) return;
    const s0 = g.samples[0], s1 = g.samples[g.samples.length - 1];
    const dt = s1.t - s0.t;
    if (dt <= 0 || performance.now() - s1.t > 80) return;
    let vx = (s1.x - s0.x) / dt, vy = (s1.y - s0.y) / dt; // px/ms
    let last = performance.now();
    const step = (now) => {
      const ms = now - last; last = now;
      this.scroller.scrollLeft -= vx * ms;
      this.scroller.scrollTop -= vy * ms;
      const decay = Math.pow(0.995, ms);
      vx *= decay; vy *= decay;
      if (Math.abs(vx) + Math.abs(vy) > 0.02) this._inertia = requestAnimationFrame(step);
      else this._inertia = 0;
    };
    this._inertia = requestAnimationFrame(step);
  }
  stopInertia() { if (this._inertia) { cancelAnimationFrame(this._inertia); this._inertia = 0; } }
  startMousePan(e) { this.capture(e); this.mousePan = { id: e.pointerId, x: e.clientX, y: e.clientY }; }

  // ───────── tools ─────────
  eraseAt(x, y) {
    const r = this.eraserRadius();
    let hit = false;
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const s = this.strokes[i], b = bbox(s);
      if (x < b.x0 - r || x > b.x1 + r || y < b.y0 - r || y > b.y1 + r) continue;
      if (hitStroke(s, x, y, r)) {
        this.strokes.splice(i, 1);
        this.active.removed.push({ stroke: s, index: i });
        hit = (hit || []).concat(b);
      }
    }
    if (hit) this.refreshBoxes(hit);
  }

  finishLasso(poly) {
    if (poly.length < 6) { this.renderOverlay(); return; }
    const sel = [];
    for (const s of this.strokes) {
      const p = s.p, n = p.length / 3;
      const step = Math.max(1, Math.floor(n / 24));
      let inside = 0, total = 0;
      for (let i = 0; i < n; i += step) { total++; if (pointInPoly(p[i * 3], p[i * 3 + 1], poly)) inside++; }
      if (total && inside / total >= 0.5) sel.push(s);
    }
    this.selection = sel.length ? sel : null;
    this._overlayDirty = true;
    this.renderOverlay();
  }
  selBounds() {
    if (!this.selection || !this.selection.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of this.selection) { const b = bbox(s); x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
    return { x0, y0, x1, y1 };
  }
  placeSelBox(T) {
    const b = this.selBounds();
    if (!b || !this.enabled) { this.selBox.hidden = true; return; }
    const left = T.ox + b.x0 * T.s, top = T.oy + b.y0 * T.s;
    const w = (b.x1 - b.x0) * T.s, h = (b.y1 - b.y0) * T.s;
    Object.assign(this.selBox.style, { left: left + 'px', top: top + 'px', width: w + 'px', height: h + 'px' });
    this.selBox.classList.toggle('below', top < 64);
    this.selBox.hidden = false;
  }
  clearSelection(render = true) {
    this.drop();
    this.selection = null;
    this.selBox.hidden = true;
    this._overlayDirty = true;
    if (render) this.renderOverlay();
  }
  translate(list, dx, dy) {
    if (!list) return;
    for (const s of list) { for (let i = 0; i < s.p.length; i += 3) { s.p[i] = r1(s.p[i] + dx); s.p[i + 1] = r1(s.p[i + 1] + dy); } invalidate(s); }
  }
  deleteSelection() {
    if (!this.selection) return;
    const set = new Set(this.selection);
    const removed = [];
    for (let i = this.strokes.length - 1; i >= 0; i--) if (set.has(this.strokes[i])) { removed.push({ stroke: this.strokes[i], index: i }); this.strokes.splice(i, 1); }
    this.push({ t: 'erase', items: removed });
    this.clearSelection();
    this.refreshStrokes(removed.map((x) => x.stroke));
    this.changed();
  }
  duplicateSelection() {
    if (!this.selection) return;
    const copies = this.selection.map((s) => ({ id: uid(10), t: s.t, c: s.c, w: s.w, p: s.p.map((v, i) => (i % 3 === 2 ? v : r1(v + 20))) }));
    this.strokes.push(...copies);
    this.push({ t: 'add', strokes: copies });
    this.selection = copies;
    this.refreshStrokes(copies);
    this._overlayDirty = true;
    this.renderOverlay();
    this.changed();
  }
  recolorSelection() {
    if (!this.selection) return;
    const items = this.selection.map((s) => ({ stroke: s, from: s.c }));
    for (const s of this.selection) s.c = this.color;
    this.push({ t: 'recolor', items, to: this.color });
    this.refreshStrokes(this.selection);
    this.renderOverlay();
    this.changed();
  }
  clearAll() {
    if (!this.strokes.length) return;
    const removed = [];
    for (let i = this.strokes.length - 1; i >= 0; i--) removed.push({ stroke: this.strokes[i], index: i });
    this.strokes = [];
    this.push({ t: 'erase', items: removed });
    this.clearSelection();
    this.renderNow();
    this.changed();
  }

  // ───────── history ─────────
  push(op) { this.undoStack.push(op); if (this.undoStack.length > 300) this.undoStack.shift(); this.redoStack = []; this.history(); }
  history() { this.onHistory && this.onHistory(this.undoStack.length > 0, this.redoStack.length > 0); }
  changed() { this.onChange && this.onChange(); }
  apply(op, dir) {
    if (op.t === 'add') {
      if (dir < 0) { const set = new Set(op.strokes); this.strokes = this.strokes.filter((s) => !set.has(s)); }
      else this.strokes.push(...op.strokes);
    } else if (op.t === 'erase') {
      if (dir < 0) { for (let i = op.items.length - 1; i >= 0; i--) this.strokes.splice(op.items[i].index, 0, op.items[i].stroke); }
      else { const set = new Set(op.items.map((x) => x.stroke)); this.strokes = this.strokes.filter((s) => !set.has(s)); }
    } else if (op.t === 'move') {
      this.translate(op.strokes, dir * op.dx, dir * op.dy);
    } else if (op.t === 'recolor') {
      for (const it of op.items) it.stroke.c = dir < 0 ? it.from : op.to;
    }
  }
  undo() { const op = this.undoStack.pop(); if (!op) return false; this.apply(op, -1); this.redoStack.push(op); this.after(); return true; }
  redo() { const op = this.redoStack.pop(); if (!op) return false; this.apply(op, 1); this.undoStack.push(op); this.after(); return true; }
  after() { this.clearSelection(false); this.history(); this.syncBlend(); this.renderNow(); this.changed(); }
}
