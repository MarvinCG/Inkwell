#!/usr/bin/env node
// Inkwell sync server — zero dependencies (Node 20+).
// Serves the web app and a tiny sync API. One file per note on disk, a global revision counter,
// and conflict detection via each change's base revision.
//
// Env:
//   SYNC_TOKEN    required — shared secret the apps send as "Authorization: Bearer <token>"
//   PORT          default 8080
//   HOST          default 0.0.0.0
//   DATA_DIR      default ./data
//   WEB_DIR       default ../web (relative to this file)
//   MAX_BODY_MB   default 50 — largest sync request (notes with photos/voice can be big)
//   CORS_ORIGIN   optional — allow the web app to be hosted on another origin (e.g. https://notes.example.com)
//   TRUST_PROXY   set to 1 to read the client IP from X-Forwarded-For (for the auth rate limit)

'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = '1.1.0';
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const WEB_DIR = path.resolve(process.env.WEB_DIR || path.join(__dirname, '..', 'web'));
const MAX_BODY = (Number(process.env.MAX_BODY_MB) || 50) * 1024 * 1024;
const PAGE_BYTES = 16 * 1024 * 1024; // max payload per pull response; client loops while `more`
const TOKEN = process.env.SYNC_TOKEN || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ITEMS_DIR = path.join(DATA_DIR, 'items');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

if (TOKEN.length < 16) {
  console.error('SYNC_TOKEN must be set and at least 16 characters (try: openssl rand -hex 24)');
  process.exit(1);
}
const TOKEN_HASH = crypto.createHash('sha256').update(TOKEN).digest();

// ───────── storage ─────────
let rev = 0;
const index = new Map(); // id -> { rev, type, updatedAt, deleted, size }

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fh = await fsp.open(tmp, 'w');
  try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
  await fsp.rename(tmp, file);
}

async function loadStore() {
  await fsp.mkdir(ITEMS_DIR, { recursive: true });
  try { rev = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8')).rev || 0; } catch { rev = 0; }
  for (const f of await fsp.readdir(ITEMS_DIR)) {
    if (f.endsWith('.tmp')) { await fsp.rm(path.join(ITEMS_DIR, f), { force: true }); continue; }
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await fsp.readFile(path.join(ITEMS_DIR, f), 'utf8');
      const it = JSON.parse(raw);
      if (!ID_RE.test(it.id)) continue;
      index.set(it.id, { rev: it.rev, type: it.type, updatedAt: it.updatedAt, deleted: !!it.deleted, size: raw.length });
      if (it.rev > rev) rev = it.rev;
    } catch (e) { console.warn(`skipping unreadable ${f}: ${e.message}`); }
  }
  console.log(`loaded ${index.size} items, rev ${rev}, data dir ${DATA_DIR}`);
}

const itemPath = (id) => path.join(ITEMS_DIR, `${id}.json`);
async function readItem(id) { return JSON.parse(await fsp.readFile(itemPath(id), 'utf8')); }

// Serialize all writes so revisions stay strictly ordered.
let chain = Promise.resolve();
function exclusive(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }

async function handleSync(body) {
  const since = Number.isFinite(body.since) ? body.since : 0;
  const changes = Array.isArray(body.changes) ? body.changes : [];
  return exclusive(async () => {
    const accepted = [];
    const conflicts = [];
    for (const c of changes) {
      if (!c || !ID_RE.test(c.id) || !['note', 'folder'].includes(c.type)) continue;
      const cur = index.get(c.id);
      const baseRev = Number(c.baseRev) || 0;
      if (cur && baseRev !== cur.rev) {
        if (cur.deleted && c.deleted) { accepted.push({ id: c.id, rev: cur.rev }); continue; }
        conflicts.push({ id: c.id, server: await readItem(c.id) });
        continue;
      }
      rev += 1;
      const item = {
        id: c.id, type: c.type, rev,
        updatedAt: Number(c.updatedAt) || Date.now(),
        deleted: !!c.deleted,
        data: c.deleted ? null : (c.data ?? null),
      };
      const json = JSON.stringify(item);
      await writeAtomic(itemPath(c.id), json);
      index.set(c.id, { rev, type: c.type, updatedAt: item.updatedAt, deleted: item.deleted, size: json.length });
      accepted.push({ id: c.id, rev });
    }
    if (accepted.length) await writeAtomic(STATE_FILE, JSON.stringify({ rev }));

    // Pull: everything newer than `since`, oldest first, paged by size.
    const skip = new Set(accepted.map((a) => a.id));
    const newer = [...index.entries()].filter(([, m]) => m.rev > since).sort((a, b) => a[1].rev - b[1].rev);
    const out = [];
    let bytes = 0, more = false, lastRev = since;
    for (const [id, m] of newer) {
      if (out.length && bytes + m.size > PAGE_BYTES) { more = true; break; }
      lastRev = m.rev;
      if (skip.has(id)) continue;
      out.push(await readItem(id));
      bytes += m.size;
    }
    return { rev: more ? lastRev : rev, more, accepted, conflicts, changes: out };
  });
}

// ───────── auth + rate limit ─────────
const failures = new Map(); // ip -> { n, first }
function clientIp(req) {
  if (TRUST_PROXY) { const xf = req.headers['x-forwarded-for']; if (xf) return String(xf).split(',')[0].trim(); }
  return req.socket.remoteAddress || '?';
}
function authorized(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return false;
  const got = crypto.createHash('sha256').update(m[1].trim()).digest();
  return crypto.timingSafeEqual(got, TOKEN_HASH);
}
function limited(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60e3) { failures.delete(ip); return false; }
  return f.n >= 10;
}
function noteFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > 15 * 60e3) failures.set(ip, { n: 1, first: Date.now() });
  else f.n += 1;
}

// ───────── http ─────────
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self)',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "connect-src 'self' https://api.github.com",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
};
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...(isBuf || typeof body === 'string' ? {} : { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }),
    ...headers,
  });
  res.end(payload);
}
function cors(req, res) {
  if (!CORS_ORIGIN) return;
  const origin = req.headers.origin;
  if (origin && origin === CORS_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY * 4) { req.destroy(); return; } // absurd upload: just drop it
      if (size <= MAX_BODY) chunks.push(c);                // over the limit: drain, then answer 413
    });
    req.on('end', () => (size > MAX_BODY ? reject(Object.assign(new Error('too large'), { status: 413 })) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
    req.on('close', () => { if (!req.complete) reject(new Error('aborted')); });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'Bad request'); }
  if (rel.includes('\0')) return send(res, 400, 'Bad request');
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(WEB_DIR, '.' + path.posix.normalize('/' + rel));
  if (!file.startsWith(WEB_DIR + path.sep)) return send(res, 403, 'Forbidden');
  let st;
  try { st = await fsp.stat(file); } catch { return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' }); }
  if (!st.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  const ext = path.extname(file).toLowerCase();
  const noCache = ext === '.html' || file.endsWith('sw.js') || ext === '.webmanifest';
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': noCache ? 'no-cache' : 'public, max-age=300',
    ETag: etag,
  };
  if (file.endsWith('sw.js')) headers['Service-Worker-Allowed'] = './';
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ...SECURITY_HEADERS, ...headers }); return res.end(); }
  res.writeHead(200, { ...SECURITY_HEADERS, ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let pathname;
  try { pathname = new URL(req.url, 'http://x').pathname; } catch { return send(res, 400, 'Bad request'); }
  try {
    // Accept /api/... at any mount point (e.g. /notes/api/sync behind a path-based proxy).
    const apiAt = pathname.indexOf('/api/');
    if (apiAt !== -1) {
      cors(req, res);
      if (req.method === 'OPTIONS') return send(res, 204, '');
      const route = pathname.slice(apiAt);
      if (route === '/api/health') return send(res, 200, { ok: true, version: VERSION });
      const ip = clientIp(req);
      if (!authorized(req)) {
        // Wrong tokens are slowed down and, after 10 in 15 min, refused outright. A device with the right
        // token is never locked out (behind Tailscale Serve every device shares the 127.0.0.1 address).
        noteFailure(ip);
        await new Promise((r) => setTimeout(r, 400));
        return send(res, limited(ip) ? 429 : 401, { error: limited(ip) ? 'too many failed attempts' : 'unauthorized' });
      }
      if (route === '/api/ping' && req.method === 'GET') return send(res, 200, { ok: true, version: VERSION, rev, items: [...index.values()].filter((m) => !m.deleted).length });
      if (route === '/api/sync' && req.method === 'POST') {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return send(res, 400, { error: 'invalid json' }); }
        const out = await handleSync(body);
        send(res, 200, out);
        if (out.accepted.length || out.conflicts.length) console.log(`sync from ${ip}: +${out.accepted.length} conflicts ${out.conflicts.length} pulled ${out.changes.length} (${Date.now() - started} ms)`);
        return;
      }
      return send(res, 404, { error: 'not found' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return await serveStatic(req, res, pathname);
  } catch (e) {
    if (e.status === 413) return send(res, 413, { error: `request larger than ${MAX_BODY / 1048576} MB` });
    if (e.message === 'aborted') return;
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'server error' });
  }
});
server.requestTimeout = 5 * 60e3;
server.headersTimeout = 60e3;

loadStore().then(() => {
  server.listen(PORT, HOST, () => console.log(`Inkwell ${VERSION} listening on http://${HOST}:${PORT} (web: ${WEB_DIR})`));
}).catch((e) => { console.error(e); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); chain.finally(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
