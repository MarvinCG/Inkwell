// Allow-list HTML sanitizer for note bodies (used on load, on paste and on incoming sync).

const TAGS = new Set([
  'P', 'DIV', 'BR', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'SUB', 'SUP', 'MARK',
  'H1', 'H2', 'H3', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'HR', 'A', 'IMG', 'AUDIO', 'FONT',
]);
const DROP_WITH_CONTENT = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT', 'SVG', 'MATH', 'TITLE', 'META', 'LINK', 'HEAD', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'VIDEO', 'CANVAS']);
const STYLE_PROPS = new Set(['color', 'background-color', 'text-align', 'text-decoration', 'text-decoration-line', 'font-weight', 'font-style']);
const CLASSES = new Set(['checklist', 'voice']);

function cleanStyle(style) {
  const out = [];
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (!STYLE_PROPS.has(prop)) continue;
    if (/url\(|expression|javascript:|@import|[<>]/i.test(val)) continue;
    if (val.length > 60) continue;
    out.push(`${prop}: ${val}`);
  }
  return out.join('; ');
}

function safeUrl(url, kind) {
  const u = (url || '').trim();
  if (kind === 'href') return /^(https?:|mailto:|tel:)/i.test(u) ? u : null;
  if (kind === 'img') return /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,/i.test(u) || /^https:\/\//i.test(u) || /^blob:/i.test(u) ? u : null;
  if (kind === 'audio') return /^data:audio\/[\w.+-]+(;[\w=.+-]+)*;base64,/i.test(u) || /^blob:/i.test(u) ? u : null;
  return null;
}

function walk(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 3) continue; // text
    if (child.nodeType !== 1) { child.remove(); continue; }
    const tag = child.tagName.toUpperCase();
    if (DROP_WITH_CONTENT.has(tag)) { child.remove(); continue; }
    if (!TAGS.has(tag)) {
      walk(child);
      child.replaceWith(...child.childNodes); // unwrap unknown tags, keep text
      continue;
    }
    for (const attr of [...child.attributes]) {
      const name = attr.name.toLowerCase();
      const val = attr.value;
      let keep = null;
      if (name === 'style') keep = cleanStyle(val) || null;
      else if (name === 'class') keep = val.split(/\s+/).filter((c) => CLASSES.has(c)).join(' ') || null;
      else if (name === 'data-checked' && tag === 'LI') keep = val === 'true' ? 'true' : null;
      else if (name === 'href' && tag === 'A') keep = safeUrl(val, 'href');
      else if (name === 'src' && tag === 'IMG') keep = safeUrl(val, 'img');
      else if (name === 'src' && tag === 'AUDIO') keep = safeUrl(val, 'audio');
      else if (name === 'alt' && tag === 'IMG') keep = val.slice(0, 200);
      else if (name === 'controls' && tag === 'AUDIO') keep = '';
      else if (name === 'color' && tag === 'FONT') keep = /^#?[\w]{3,20}$/.test(val) ? val : null;
      else if (name === 'contenteditable' && tag === 'DIV') keep = val === 'false' ? 'false' : null;
      else if (name === 'width' && tag === 'IMG') keep = /^\d{1,4}%?$/.test(val) ? val : null;
      if (keep === null) child.removeAttribute(attr.name);
      else if (keep !== val) child.setAttribute(attr.name, keep);
    }
    if (tag === 'A') { child.setAttribute('rel', 'noopener noreferrer'); child.setAttribute('target', '_blank'); }
    if ((tag === 'IMG' || tag === 'AUDIO') && !child.getAttribute('src')) { child.remove(); continue; }
    walk(child);
  }
}

export function sanitizeHTML(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  walk(doc.body);
  return doc.body.innerHTML;
}

export function htmlToText(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  doc.querySelectorAll('p,div,li,h1,h2,h3,blockquote,pre').forEach((b) => b.append('\n'));
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

export function firstImage(html) {
  if (!html) return null;
  const m = /<img[^>]+src="(data:image\/[^"]+|https:\/\/[^"]+)"/i.exec(html);
  return m ? m[1] : null;
}

export function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
