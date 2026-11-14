'use strict';
/*
 * Page descriptions: extraction from HTML, and a guarded server-side fetch used as a fallback for
 * tabs the extension couldn't read (discarded/unloaded tabs, archived tabs).
 *
 * The fetch is LAN-safe: http/https only, every DNS answer is checked and private / loopback /
 * link-local / multicast / reserved addresses are refused (also after redirects, and the checked
 * address is the one connected to, so DNS rebinding can't swap it), 5 s deadline, size cap.
 */
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

const MAX_DESC = 200;

// ---------- text helpers ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch (err) { return m; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Collapse whitespace and cut to ~max chars at a word boundary.
function clampDescription(s, max = MAX_DESC) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
}

// Same priority as the extension: meta description, og:description, twitter:description,
// otherwise the first paragraph with real text.
function extractDescription(html) {
  if (!html) return '';
  const head = html.slice(0, 300_000);
  const metas = head.match(/<meta\b[^>]*>/gi) || [];
  const found = {};
  for (const tag of metas) {
    const key = (attr(tag, 'name') || attr(tag, 'property') || '').toLowerCase();
    const content = attr(tag, 'content');
    if (content && content.trim() && !(key in found)) found[key] = content;
  }
  for (const k of ['description', 'og:description', 'twitter:description']) {
    if (found[k]) return clampDescription(decodeEntities(found[k]));
  }
  const body = head
    .replace(/<(script|style|noscript|template|svg|nav|header|footer)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(body))) {
    const text = decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ')
      .replace(/ ([.,;:!?)\]»”])/g, '$1').replace(/([(\[«“]) /g, '$1').trim();   // undo spaces left by inline tags
    if (text.length >= 40) return clampDescription(text);
  }
  return '';
}

// ---------- address checks ----------

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224               // this-net, private, loopback, multicast/reserved
      || (a === 100 && b >= 64 && b <= 127)                           // CGNAT
      || (a === 169 && b === 254)                                     // link-local
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2))               // IETF / TEST-NET-1
      || (a === 198 && (b === 18 || b === 19))                        // benchmarking
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    const mapped = /^::ffff:(?:0:)?(.+)$/.exec(l);
    if (mapped) {
      if (net.isIPv4(mapped[1])) return isPrivateAddress(mapped[1]);
      const h = mapped[1].split(':');
      if (h.length === 2) {
        const n = (parseInt(h[0], 16) << 16 >>> 0) + parseInt(h[1], 16);
        return isPrivateAddress([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255].join('.'));
      }
      return true;
    }
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff') || l.startsWith('2001:db8') || l.startsWith('100::');
  }
  return true;
}

function guardedLookup(allowPrivate) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    dns.lookup(hostname, { all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!allowPrivate && addrs.some((a) => isPrivateAddress(a.address))) {
        const e = new Error(`blocked: ${hostname} resolves to a private/reserved address`);
        e.code = 'EBLOCKED';
        return cb(e);
      }
      if (!addrs.length) return cb(new Error(`no address for ${hostname}`));
      if (options && options.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

// ---------- fetch ----------

function charsetOf(contentType, headBytes) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || '');
  if (fromHeader) return fromHeader[1];
  const sniff = headBytes.toString('latin1');
  const m = /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff);
  return m ? m[1] : 'utf-8';
}

function decode(buf, contentType) {
  const cs = charsetOf(contentType, buf.subarray(0, 4096));
  try { return new TextDecoder(cs).decode(buf); } catch (e) { return new TextDecoder('utf-8').decode(buf); }
}

function getOnce(url, { allowPrivate, deadline, maxBytes }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    // IP-literal hosts never go through `lookup`, so check them here.
    const literal = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(literal) && !allowPrivate && isPrivateAddress(literal)) {
      const e = new Error(`blocked: ${literal} is a private/reserved address`);
      e.code = 'EBLOCKED';
      return reject(e);
    }
    const left = deadline - Date.now();
    if (left <= 0) return reject(new Error('timeout'));
    const req = mod.get(u, {
      lookup: guardedLookup(allowPrivate),
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; TabRelay/1.0; page description fetch)',
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'accept-language': 'en,uk;q=0.8,*;q=0.5',
      },
      timeout: left,
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), left);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('response', (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        clearTimeout(timer);
        return resolve({ redirect: new URL(res.headers.location, u).href });
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        clearTimeout(timer);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const ct = res.headers['content-type'] || '';
      if (ct && !/html|xml/i.test(ct)) {
        res.destroy();
        clearTimeout(timer);
        return reject(new Error(`not html (${ct.split(';')[0]})`));
      }
      const chunks = [];
      let size = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ html: decode(Buffer.concat(chunks), ct) });
      };
      res.on('data', (c) => {
        if (done) return;
        chunks.push(c);
        size += c.length;
        if (size >= maxBytes) { finish(); res.destroy(); }   // the head is what matters
      });
      res.on('end', finish);
      res.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    });
  });
}

// Fetch `url` and extract its description. Rejects on blocked/failed/non-HTML responses.
async function fetchDescription(url, { allowPrivate = false, timeoutMs = 5000, maxBytes = 512 * 1024, maxRedirects = 3 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    if (!/^https?:\/\//i.test(current)) throw new Error('only http/https URLs are fetched');
    const r = await getOnce(current, { allowPrivate, deadline, maxBytes });
    if (r.redirect) { current = r.redirect; continue; }
    return extractDescription(r.html);
  }
  throw new Error('too many redirects');
}

// ---------- queue ----------

/*
 * Background fetch queue: a few requests at a time, at most one request per host per interval,
 * bounded queue, and a delay before fetching so the extension gets the first chance to report a
 * description from the live page. Results are written through `store(url, description, error)`;
 * `stillMissing(url)` is re-checked right before fetching.
 */
class MetaFetcher {
  constructor({ store, stillMissing, allowPrivate = false, concurrency = 2, perHostIntervalMs = 2000,
    delayMs = 15000, timeoutMs = 5000, maxQueue = 500, fetchImpl = fetchDescription } = {}) {
    Object.assign(this, { store, stillMissing, allowPrivate, concurrency, perHostIntervalMs, delayMs, timeoutMs, maxQueue, fetchImpl });
    this.queue = [];             // {url, host, notBefore}
    this.pending = new Set();    // queued or in flight
    this.active = 0;
    this.lastHit = new Map();    // host -> time of last request
    this.timer = null;
    this.idleWaiters = [];
  }

  enqueue(url) {
    let host;
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      host = u.hostname;
    } catch (e) { return false; }
    if (this.pending.has(url) || this.pending.size >= this.maxQueue) return false;
    this.pending.add(url);
    this.queue.push({ url, host, notBefore: Date.now() + this.delayMs });
    this._pump();
    return true;
  }

  _pump() {
    clearTimeout(this.timer);
    this.timer = null;
    const now = Date.now();
    let wait = Infinity;
    for (let i = 0; i < this.queue.length && this.active < this.concurrency;) {
      const job = this.queue[i];
      const hostReady = (this.lastHit.get(job.host) || 0) + this.perHostIntervalMs;
      const readyAt = Math.max(job.notBefore, hostReady);
      if (readyAt > now) { wait = Math.min(wait, readyAt - now); i++; continue; }
      this.queue.splice(i, 1);
      this.lastHit.set(job.host, now);
      this._run(job);
    }
    if (this.queue.length && wait < Infinity) {
      this.timer = setTimeout(() => this._pump(), Math.max(wait, 10));
      this.timer.unref?.();
    }
    this._checkIdle();
  }

  async _run(job) {
    this.active++;
    try {
      if (this.stillMissing && !this.stillMissing(job.url)) return;
      try {
        const d = await this.fetchImpl(job.url, { allowPrivate: this.allowPrivate, timeoutMs: this.timeoutMs });
        this.store(job.url, d, d ? null : 'no description found');
      } catch (e) {
        this.store(job.url, '', e.message || String(e));
      }
    } catch (e) {
      // store failures must not kill the queue
    } finally {
      this.active--;
      this.pending.delete(job.url);
      this._pump();
    }
  }

  _checkIdle() {
    if (!this.queue.length && !this.active) for (const w of this.idleWaiters.splice(0)) w();
  }

  // For tests: resolves when the queue is empty and nothing is in flight.
  idle() {
    return new Promise((r) => { this.idleWaiters.push(r); this._checkIdle(); });
  }

  stop() {
    clearTimeout(this.timer);
    this.queue = [];
  }
}

module.exports = { extractDescription, clampDescription, decodeEntities, isPrivateAddress, fetchDescription, MetaFetcher, MAX_DESC };
