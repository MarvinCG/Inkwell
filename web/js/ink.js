// Handwriting layer: pressure-sensitive strokes, highlighter, eraser, lasso, undo/redo,
// palm rejection, touch pan/pinch. Strokes live in page coordinates (logical px).
//
// Stroke: { id, t: 'pen'|'pencil'|'hl', c: '#rrggbb', w: number, p: [x, y, pressure, x, y, pressure, ...] }

import { uid } from './store.js';

export const PALETTE = ['#1a1a1a', '#5f6368', '#1f6feb', '#0b8a7a', '#2e9d44', '#f2b600', '#f26b1d', '#e5484d', '#d6409f', '#8e4ec6', '#8d5a3b', '#ffffff'];
export const DEFAULT_SIZES = { pen: 3, pencil: 2.5, hl: 16, eraser: 10 };

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

const bboxCache = new WeakMap();
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
const invalidate = (s) => bboxCache.delete(s);

function penWidth(s, pr) { return s.w * (0.28 + 0.95 * Math.pow(Math.max(0.02, pr), 0.85)); }

/** Draw one stroke in logical coordinates onto ctx (transform already set). */
export function drawStroke(ctx, s, colorFn = (c) => c, hlAlpha = 0.32) {
  const p = s.p, n = p.length / 3;
  if (!n) return;
  const color = colorFn(s.c, s.t);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (s.t === 'hl' || s.t === 'pencil') {
    let avg = 0;
    for (let i = 2; i < p.length; i += 3) avg += p[i];
    avg /= n;
    if (s.t === 'hl') { ctx.globalAlpha = hlAlpha; ctx.lineWidth = s.w; }
    else { ctx.globalAlpha = 0.5 + 0.45 * avg; ctx.lineWidth = s.w * (0.55 + 0.6 * avg); }
    if (n === 1) {
      ctx.beginPath(); ctx.arc(p[0], p[1], ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      for (let i = 1; i < n - 1; i++) {
        const x = p[i * 3], y = p[i * 3 + 1];
        ctx.quadraticCurveTo(x, y, (x + p[i * 3 + 3]) / 2, (y + p[i * 3 + 4]) / 2);
      }
      ctx.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  // Pen: variable width. Pieces between midpoints, grouped while width is similar.
  if (n === 1) {
    ctx.beginPath(); ctx.arc(p[0], p[1], penWidth(s, p[2]) / 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    return;
  }
  const tol = Math.max(0.12, s.w * 0.06);
  let curW = -1;
  let sx = p[0], sy = p[1];
  const begin = (w, x, y) => { ctx.beginPath(); ctx.lineWidth = w; curW = w; ctx.moveTo(x, y); };
  const flush = () => { if (curW >= 0) ctx.stroke(); };
  // first piece: P0 -> M0
  {
    const w = penWidth(s, (p[2] + p[5]) / 2);
    begin(w, sx, sy);
    const mx = (p[0] + p[3]) / 2, my = (p[1] + p[4]) / 2;
    ctx.lineTo(mx, my);
    sx = mx; sy = my;
  }
  for (let i = 1; i < n - 1; i++) {
    const x = p[i * 3], y = p[i * 3 + 1];
    const mx = (x + p[i * 3 + 3]) / 2, my = (y + p[i * 3 + 4]) / 2;
    const w = penWidth(s, p[i * 3 + 2]);
    if (Math.abs(w - curW) > tol) { flush(); begin(w, sx, sy); }
    ctx.quadraticCurveTo(x, y, mx, my);
    sx = mx; sy = my;
  }
  {
    const w = penWidth(s, p[(n - 1) * 3 + 2]);
    if (Math.abs(w - curW) > tol) { flush(); begin(w, sx, sy); }
    ctx.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
  }
  flush();
  ctx.restore();
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
    this.penOnly = false;
    this.undoStack = [];
    this.redoStack = [];
    this.selection = null; // array of strokes
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

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e, false));
    c.addEventListener('pointercancel', (e) => this.onUp(e, true));
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

  // ───────── state ─────────
  load(strokes) {
    this.strokes = Array.isArray(strokes) ? strokes.filter((s) => s && Array.isArray(s.p) && s.p.length >= 3) : [];
    this.undoStack = [];
    this.redoStack = [];
    this.clearSelection(false);
    this.history();
    this.render();
  }
  serialize() { return this.strokes; }
  maxY() { let m = 0; for (const s of this.strokes) { const b = bbox(s); if (b.y1 > m) m = b.y1; } return m; }
  maxX() { let m = 0; for (const s of this.strokes) { const b = bbox(s); if (b.x1 > m) m = b.x1; } return m; }
  scaleAll(k) {
    for (const s of this.strokes) { for (let i = 0; i < s.p.length; i += 3) { s.p[i] = r1(s.p[i] * k); s.p[i + 1] = r1(s.p[i + 1] * k); } invalidate(s); }
    this.undoStack = []; this.redoStack = []; this.history();
    this.render();
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
    this.renderNow();
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
  render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.renderNow(); });
  }
  renderNow() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const T = this.transform();
    ctx.setTransform(T.a, 0, 0, T.a, T.e, T.f);
    const sel = this.selection ? new Set(this.selection) : null;
    for (const s of this.strokes) {
      const b = bbox(s);
      if (b.x1 < T.x0 || b.x0 > T.x1 || b.y1 < T.y0 || b.y0 > T.y1) continue;
      if (sel && sel.has(s)) {
        ctx.save();
        ctx.shadowColor = 'rgba(242,107,29,.85)';
        ctx.shadowBlur = 6 * T.d;
        drawStroke(ctx, s, this.colorFn, this.hlAlpha);
        ctx.restore();
      } else drawStroke(ctx, s, this.colorFn, this.hlAlpha);
    }
    this.placeSelBox(T);
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
      if (a && a.stroke) drawStroke(ctx, a.stroke, this.colorFn, this.hlAlpha);
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
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.capture(e);
      const palm = (e.width || 0) * (e.height || 0) > 3600; // ~60×60 CSS px contact = palm, not a finger
      const penBusy = (this.active && this.active.pointerType === 'pen') || now - this.lastPen < 600;
      if (palm || penBusy) { this.ignored.add(e.pointerId); this.touches.delete(e.pointerId); return; }
      const fingers = this.touches.size;
      if (this.penOnly || fingers > 1) {
        if (this.active && this.active.pointerType === 'touch') this.cancelActive();
        this.startGesture();
        return;
      }
      // finger drawing (pen-only off): falls through
    } else if (e.pointerType === 'mouse') {
      if (e.button === 1) { e.preventDefault(); this.startMousePan(e); return; }
      if (e.button !== 0) return;
    }

    if (this.active) return; // one drawing pointer at a time
    e.preventDefault();
    this.capture(e);
    let tool = this.tool;
    if (e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) || (e.buttons & 2))) tool = 'eraser';
    const p = this.pt(e);
    this.active = { id: e.pointerId, pointerType: e.pointerType, tool, kind: 'stroke' };

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
        this.renderNow();
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
    this.active = null;
    if (a.kind === 'stroke') {
      if (cancelled && a.stroke.p.length < 9) { this.drawLive(); return; }
      this.strokes.push(a.stroke);
      this.push({ t: 'add', strokes: [a.stroke] });
      this.renderNow();
      this.changed();
    } else if (a.kind === 'erase') {
      if (a.removed.length) { this.push({ t: 'erase', items: a.removed }); this.changed(); }
      if (e.pointerType !== 'mouse') this.cursor = null;
    } else if (a.kind === 'lasso') {
      this.finishLasso(a.poly);
    } else if (a.kind === 'move') {
      if (Math.abs(a.dx) + Math.abs(a.dy) > 0.5) { this.push({ t: 'move', strokes: [...this.selection], dx: a.dx, dy: a.dy }); this.changed(); }
    }
    this.drawLive();
  }

  cancelActive() {
    if (!this.active) return;
    const a = this.active;
    this.active = null;
    if (a.kind === 'erase' && a.removed.length) {
      // restore what this gesture erased
      for (let i = a.removed.length - 1; i >= 0; i--) this.strokes.splice(a.removed[i].index, 0, a.removed[i].stroke);
      this.renderNow();
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
        hit = true;
      }
    }
    if (hit) this.renderNow();
  }

  finishLasso(poly) {
    if (poly.length < 6) { this.renderNow(); return; }
    const sel = [];
    for (const s of this.strokes) {
      const p = s.p, n = p.length / 3;
      const step = Math.max(1, Math.floor(n / 24));
      let inside = 0, total = 0;
      for (let i = 0; i < n; i += step) { total++; if (pointInPoly(p[i * 3], p[i * 3 + 1], poly)) inside++; }
      if (total && inside / total >= 0.5) sel.push(s);
    }
    this.selection = sel.length ? sel : null;
    this.renderNow();
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
    this.selection = null;
    this.selBox.hidden = true;
    if (render) this.renderNow();
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
    this.changed();
  }
  duplicateSelection() {
    if (!this.selection) return;
    const copies = this.selection.map((s) => ({ id: uid(10), t: s.t, c: s.c, w: s.w, p: s.p.map((v, i) => (i % 3 === 2 ? v : r1(v + 20))) }));
    this.strokes.push(...copies);
    this.push({ t: 'add', strokes: copies });
    this.selection = copies;
    this.renderNow();
    this.changed();
  }
  recolorSelection() {
    if (!this.selection) return;
    const items = this.selection.map((s) => ({ stroke: s, from: s.c }));
    for (const s of this.selection) s.c = this.color;
    this.push({ t: 'recolor', items, to: this.color });
    this.renderNow();
    this.changed();
  }
  clearAll() {
    if (!this.strokes.length) return;
    const removed = [];
    for (let i = this.strokes.length - 1; i >= 0; i--) removed.push({ stroke: this.strokes[i], index: i });
    this.strokes = [];
    this.push({ t: 'erase', items: removed });
    this.clearSelection();
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
  after() { this.clearSelection(false); this.history(); this.renderNow(); this.changed(); }
}
