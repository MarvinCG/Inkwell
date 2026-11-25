// PDF export made in the browser — works where printing doesn't (e.g. iPad home-screen apps).
// The note is laid out at its own page width, rendered to an image with html2canvas (vendor/, MIT),
// the handwriting is drawn on top, and the result is cut into A4 pages between lines of text.

import { drawStroke, bbox } from './ink.js';

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 36; // pt (½ inch)
const MAX_PIXELS = 14e6; // stay below Safari's 16.7-megapixel canvas limit

let h2c = null;
function loadHtml2canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  if (!h2c) {
    h2c = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/html2canvas.min.js';
      s.onload = () => resolve(window.html2canvas);
      s.onerror = () => { h2c = null; reject(new Error('the PDF renderer could not be loaded (offline?)')); };
      document.head.append(s);
    });
  }
  return h2c;
}

/** Copy of the editor page, at scale 1, in light colors, ready to render. */
function buildCopy(pageEl, title, pageWidth) {
  const area = document.createElement('div');
  area.className = 'pdf-area';
  const page = pageEl.cloneNode(true);
  page.removeAttribute('id');
  page.style.transform = 'none';
  page.style.minHeight = '0';
  page.style.width = pageWidth + 'px';
  const t = page.querySelector('.note-title');
  const td = document.createElement('div');
  td.className = 'note-title';
  td.textContent = title;
  t.replaceWith(td);
  if (!title) td.remove();
  const body = page.querySelector('.note-body');
  body.removeAttribute('contenteditable');
  body.removeAttribute('id');
  body.style.minHeight = '0';
  page.querySelectorAll('img.sel').forEach((i) => i.classList.remove('sel'));
  page.querySelectorAll('.voice audio').forEach((a) => a.remove());
  area.append(page);
  document.body.append(area);
  return { area, page };
}

/** Vertical ranges (page px) that must not be cut: lines of text, images, dividers. */
function solidRanges(page) {
  const top = page.getBoundingClientRect().top;
  const out = [];
  const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) if (r.height > 0) out.push([r.top - top, r.bottom - top]);
  }
  page.querySelectorAll('img, hr, .voice, li').forEach((e) => {
    const r = e.getBoundingClientRect();
    if (e.tagName === 'LI') { out.push([r.top - top, Math.min(r.bottom, r.top + 32) - top]); return; } // checkbox/bullet row
    out.push([r.top - top, r.bottom - top]);
  });
  return out;
}

function pageBreaks(totalH, sliceH, solids) {
  const breaks = [];
  let y = 0;
  while (totalH - y > sliceH) {
    let cut = y + sliceH;
    for (let guard = 0; guard < 50; guard++) {
      const hit = solids.find(([a, b]) => a < cut - 0.5 && b > cut + 0.5);
      if (!hit) break;
      cut = hit[0] - 1;
    }
    if (cut - y < sliceH * 0.5) cut = y + sliceH; // a huge image: cut through it rather than leave a near-empty page
    breaks.push(cut);
    y = cut;
  }
  return breaks;
}

function canvasToJpeg(canvas, quality = 0.88) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (b) => {
      if (!b) { reject(new Error('the page image could not be encoded')); return; }
      resolve(new Uint8Array(await b.arrayBuffer()));
    }, 'image/jpeg', quality);
  });
}

function pdfString(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, (c) => '\\' + c)})`;
  let hex = 'FEFF';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) { const v = cp - 0x10000; hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0'); }
    else hex += cp.toString(16).padStart(4, '0');
  }
  return `<${hex.toUpperCase()}>`;
}

/** Minimal PDF: one JPEG per A4 page. */
export function buildPDF(pages, title) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let offset = 0;
  const push = (d) => { const b = typeof d === 'string' ? enc.encode(d) : d; chunks.push(b); offset += b.length; };
  const obj = (n, parts) => { offsets[n] = offset; push(`${n} 0 obj\n`); for (const p of [].concat(parts)) push(p); push('\nendobj\n'); };
  push('%PDF-1.4\n');
  push(new Uint8Array([37, 226, 227, 207, 211, 10]));
  const d = new Date();
  const stamp = `D:${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + 3 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  obj(3, `<< /Title ${pdfString(title || 'Note')} /Producer (Inkwell Notes) /CreationDate (${stamp}) >>`);
  pages.forEach((pg, i) => {
    const P = 4 + 3 * i;
    const content = `q ${pg.w.toFixed(2)} 0 0 ${pg.h.toFixed(2)} ${MARGIN.toFixed(2)} ${(A4.h - MARGIN - pg.h).toFixed(2)} cm /Im0 Do Q`;
    obj(P, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Resources << /XObject << /Im0 ${P + 2} 0 R >> >> /Contents ${P + 1} 0 R >>`);
    obj(P + 1, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
    obj(P + 2, [`<< /Type /XObject /Subtype /Image /Width ${pg.pxW} /Height ${pg.pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.jpeg.length} >>\nstream\n`, pg.jpeg, '\nendstream']);
  });
  const n = 4 + 3 * pages.length;
  const xref = offset;
  push(`xref\n0 ${n}\n0000000000 65535 f \n`);
  for (let i = 1; i < n; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${n} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}

/** Render a note to a PDF Blob. */
export async function notePDF({ pageEl, title, strokes, pageWidth }) {
  const html2canvas = await loadHtml2canvas();
  const { area, page } = buildCopy(pageEl, title, pageWidth);
  try {
    await Promise.all([...page.querySelectorAll('img')].map((i) => (i.decode ? i.decode().catch(() => {}) : null)));
    let inkBottom = 0;
    for (const s of strokes) inkBottom = Math.max(inkBottom, bbox(s).y1);
    const H = Math.ceil(Math.max(page.offsetHeight, inkBottom + 24));
    page.style.height = H + 'px';
    const k = Math.min(2.5, Math.sqrt(MAX_PIXELS / (pageWidth * H)));
    const full = await html2canvas(page, {
      scale: k, backgroundColor: '#ffffff', logging: false, useCORS: true,
      width: pageWidth, height: H, windowWidth: Math.max(pageWidth + 40, window.innerWidth),
    });
    const ctx = full.getContext('2d');
    ctx.setTransform(full.width / pageWidth, 0, 0, full.height / H, 0, 0);
    for (const s of strokes) drawStroke(ctx, s);

    const ptPerPx = (A4.w - 2 * MARGIN) / pageWidth;
    const sliceH = (A4.h - 2 * MARGIN) / ptPerPx;
    const cuts = [0, ...pageBreaks(H, sliceH, solidRanges(page)), H];
    const pxPerCss = full.height / H;
    const pages = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const y0 = Math.round(cuts[i] * pxPerCss), y1 = Math.round(cuts[i + 1] * pxPerCss);
      if (y1 - y0 < 2) continue;
      const c = document.createElement('canvas');
      c.width = full.width;
      c.height = y1 - y0;
      const cx = c.getContext('2d');
      cx.fillStyle = '#fff';
      cx.fillRect(0, 0, c.width, c.height);
      cx.drawImage(full, 0, y0, full.width, y1 - y0, 0, 0, c.width, c.height);
      pages.push({ jpeg: await canvasToJpeg(c), pxW: c.width, pxH: c.height, w: pageWidth * ptPerPx, h: (cuts[i + 1] - cuts[i]) * ptPerPx });
    }
    return buildPDF(pages, title);
  } finally {
    area.remove();
  }
}
