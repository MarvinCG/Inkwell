// GitHub repository as the sync backend (Git Data API, fine-grained token with Contents: read & write).
//
// Layout in the data repo:
//   items/<id>.json      one note or folder: { id, type, updatedAt, deleted, data }
//   media/<hash>.txt     a photo or voice note (data: URL), stored once, referenced as "inkwell-media:<hash>"
//
// Every sync is at most one commit. Pushes use a fast-forward-only ref update, so two devices
// syncing at the same moment can't overwrite each other: the loser re-reads and tries again.

const MEDIA_RE = /(src=")(data:(?:image|audio)\/[^"]+)(")/g;
const PLACEHOLDER_RE = /(src=")inkwell-media:([a-z0-9]+)(")/g;

export class GitHubError extends Error {
  constructor(message, code, status) { super(message); this.code = code; this.status = status; }
}

export class GitHubRepo {
  constructor({ repo, token, api = 'https://api.github.com' }) {
    const m = /^\s*(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?\s*$/i.exec(repo || '');
    if (!m) throw new GitHubError('Repository should look like owner/name, e.g. MarvinCG/inkwell-data', 'config');
    this.owner = m[1];
    this.name = m[2];
    this.token = (token || '').trim();
    this.api = api.replace(/\/$/, '');
    this.branch = null;
  }
  get slug() { return `${this.owner}/${this.name}`; }

  async req(method, path, body, { raw = false, timeout = 120000, allow = [] } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(`${this.api}/repos/${this.owner}/${this.name}${path}`, {
        method,
        headers: {
          Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new GitHubError('GitHub did not answer in time.', 'offline');
      throw new GitHubError('Can’t reach GitHub (offline?).', 'offline');
    } finally { clearTimeout(t); }
    if (allow.includes(res.status)) return { status: res.status };
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).message || ''; } catch { /* ignore */ }
      if (res.status === 401) throw new GitHubError('GitHub rejected the token (expired or mistyped?).', 'auth', 401);
      if (res.status === 403 || res.status === 429) {
        if (res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(msg)) throw new GitHubError('GitHub rate limit reached — sync resumes in a few minutes.', 'rate', res.status);
        throw new GitHubError('The token can’t write to this repository (needs Contents: Read and write).', 'auth', 403);
      }
      if (res.status === 404) throw new GitHubError(`Repository ${this.slug} not found, or the token can’t see it.`, 'auth', 404);
      throw new GitHubError(`GitHub error ${res.status}${msg ? `: ${msg}` : ''}`, res.status === 409 || res.status === 422 ? 'conflict' : 'server', res.status);
    }
    if (raw) return res.text();
    return res.status === 204 ? null : res.json();
  }

  async info() {
    const r = await this.req('GET', '');
    this.branch = r.default_branch || 'main';
    return { private: !!r.private, canPush: !r.permissions || !!r.permissions.push, branch: this.branch };
  }

  /** Head commit sha of the default branch, or null when the repository has no commits yet. */
  async head() {
    if (!this.branch) await this.info();
    const r = await this.req('GET', `/git/ref/heads/${encodeURIComponent(this.branch)}`, null, { allow: [404, 409] });
    if (r.status) return null;
    return r.object.sha;
  }

  async init() {
    const text = '# Inkwell data\n\nNotes synced by the Inkwell app. Keep this repository **private**.\n\n'
      + '- `items/<id>.json` — one file per note or folder\n- `media/<hash>.txt` — photos and voice notes, stored once\n';
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(text))); // UTF-8 safe
    await this.req('PUT', '/contents/README.md', { message: 'Initialize Inkwell data', content: b64 }, { allow: [422] });
  }

  async treeOf(commitSha) {
    const c = await this.req('GET', `/git/commits/${commitSha}`);
    const t = await this.req('GET', `/git/trees/${c.tree.sha}?recursive=1`);
    if (t.truncated) throw new GitHubError('The data repository is too large to list in one go.', 'server');
    return { treeSha: c.tree.sha, entries: t.tree.filter((e) => e.type === 'blob') };
  }

  blob(sha) { return this.req('GET', `/git/blobs/${sha}`, null, { raw: true }); }

  /** Write files (content string, or null to delete) as one commit on top of `parent`. Returns the commit sha, or null if the branch moved. */
  async commit(parent, baseTree, files, message) {
    const tree = files.map((f) => (f.content == null
      ? { path: f.path, mode: '100644', type: 'blob', sha: null }
      : { path: f.path, mode: '100644', type: 'blob', content: f.content }));
    const t = await this.req('POST', '/git/trees', { base_tree: baseTree, tree });
    const c = await this.req('POST', '/git/commits', { message, tree: t.sha, parents: parent ? [parent] : [] });
    const r = await this.req('PATCH', `/git/refs/heads/${encodeURIComponent(this.branch)}`, { sha: c.sha, force: false }, { allow: [409, 422] });
    if (r && r.status) return null; // someone else pushed first
    return c.sha;
  }
}

// ───────── media ─────────
async function hashText(s) {
  if (crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Non-secure context fallback (no SubtleCrypto): two 53-bit hashes + length.
  const h = (seed) => {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  };
  return `c${h(1)}${h(2)}${s.length.toString(16)}`;
}

/** Replace inline photos/voice notes with references. Returns { html, media: Map(hash → dataURL) }. */
export async function extractMedia(html) {
  const media = new Map();
  if (!html || !html.includes('data:')) return { html: html || '', media };
  const urls = [...html.matchAll(MEDIA_RE)].map((m) => m[2]);
  const hashes = await Promise.all(urls.map(hashText));
  urls.forEach((u, i) => media.set(hashes[i], u));
  let i = 0;
  const out = html.replace(MEDIA_RE, (_, a, _u, c) => `${a}inkwell-media:${hashes[i++]}${c}`);
  return { html: out, media };
}

export function mediaRefs(html) {
  return html ? [...new Set([...html.matchAll(PLACEHOLDER_RE)].map((m) => m[2]))] : [];
}

export function inlineMedia(html, lookup) {
  return html ? html.replace(PLACEHOLDER_RE, (all, a, h, c) => (lookup.has(h) ? `${a}${lookup.get(h)}${c}` : all)) : html;
}

export const itemPath = (id) => `items/${id}.json`;
export const mediaPath = (hash) => `media/${hash}.txt`;
