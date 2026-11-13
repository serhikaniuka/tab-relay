'use strict';
/*
 * Minimal MHTML (multipart/related, as written by Chrome's pageCapture) reader.
 * Chrome refuses to render MHTML fetched over http(s) (it downloads it instead), so the server
 * unpacks the archive: the root HTML is served as text/html and every reference to another part
 * (by Content-Location URL or cid:) is rewritten to a URL that serves that part.
 */

function parseHeaders(block) {
  const headers = {};
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

function decodeQuotedPrintable(s) {
  return Buffer.from(
    s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))),
    'latin1');
}

function decodeBody(body, encoding) {
  switch ((encoding || '').toLowerCase()) {
    case 'base64': return Buffer.from(body.replace(/\s+/g, ''), 'base64');
    case 'quoted-printable': return decodeQuotedPrintable(body);
    default: return Buffer.from(body, 'latin1');
  }
}

// Returns { root: index of the main HTML part, parts: [{type, charset, location, cid, body: Buffer}] }.
function parseMhtml(buf) {
  const text = buf.toString('latin1');   // byte-preserving
  const headEnd = text.search(/\r?\n\r?\n/);
  if (headEnd < 0) throw new Error('not an MHTML file');
  const top = parseHeaders(text.slice(0, headEnd));
  const m = /boundary="?([^";]+)"?/i.exec(top['content-type'] || '');
  if (!/multipart\/related/i.test(top['content-type'] || '') || !m) throw new Error('not a multipart/related archive');
  const delim = `--${m[1]}`;
  const parts = [];
  const chunks = text.slice(headEnd).split(delim);
  for (const chunk of chunks.slice(1)) {
    if (chunk.startsWith('--')) break;   // closing delimiter
    const c = chunk.replace(/^\r?\n/, '');
    const sep = c.search(/\r?\n\r?\n/);
    if (sep < 0) continue;
    const h = parseHeaders(c.slice(0, sep));
    const rawBody = c.slice(sep).replace(/^\r?\n\r?\n/, '').replace(/\r?\n$/, '');
    const ct = h['content-type'] || 'application/octet-stream';
    parts.push({
      type: ct.split(';')[0].trim().toLowerCase(),
      charset: (/charset="?([^";]+)"?/i.exec(ct) || [])[1] || '',
      location: h['content-location'] || '',
      cid: (h['content-id'] || '').replace(/^<|>$/g, ''),
      body: decodeBody(rawBody, h['content-transfer-encoding']),
    });
  }
  if (!parts.length) throw new Error('empty archive');
  const startLoc = top['snapshot-content-location'];
  let root = parts.findIndex((p) => p.type === 'text/html' && startLoc && p.location === startLoc);
  if (root < 0) root = parts.findIndex((p) => p.type === 'text/html');
  if (root < 0) root = 0;
  return { root, parts, url: startLoc || parts[root].location };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Build a function that rewrites references to archive parts inside HTML/CSS text.
function makeRewriter(mh, urlFor) {
  const map = new Map();
  mh.parts.forEach((p, i) => {
    const target = urlFor(i);
    if (p.location) {
      map.set(p.location, target);
      if (p.location.includes('&')) map.set(p.location.replace(/&/g, '&amp;'), target);
    }
    if (p.cid) map.set(`cid:${p.cid}`, target);
  });
  if (!map.size) return (s) => s;
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);   // longest first
  const re = new RegExp(keys.map(escapeRe).join('|'), 'g');
  return (s) => s.replace(re, (k) => map.get(k));
}

// A stylesheet served from this server would resolve its relative url(...)/@import against our
// URL, so make them absolute against the stylesheet's original location first.
function absolutizeCss(css, baseUrl) {
  if (!baseUrl) return css;
  const abs = (ref) => {
    if (/^(data:|[a-z][a-z0-9+.-]*:|#)/i.test(ref)) return ref;
    try { return new URL(ref, baseUrl).href; } catch (e) { return ref; }
  };
  return css
    .replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi, (m, q, ref) => `url(${q}${abs(ref)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, ref) => `@import ${q}${abs(ref)}${q}`);
}

// Render part `index` (default: root) for the browser: {type, body}. HTML and CSS get their
// references rewritten; the root HTML gets a <base> pointing at the original page so remaining
// relative links lead to the live site.
function renderPart(mh, index, urlFor) {
  const p = mh.parts[index];
  if (!p) return null;
  const charset = p.charset ? `; charset=${p.charset}` : '';
  if (p.type !== 'text/html' && p.type !== 'text/css') return { type: p.type + charset, body: p.body };
  let s = p.body.toString('latin1');
  if (p.type === 'text/css') s = absolutizeCss(s, /^https?:/i.test(p.location) ? p.location : mh.url);
  s = makeRewriter(mh, urlFor)(s);
  if (index === mh.root && p.type === 'text/html' && mh.url && /^https?:/i.test(mh.url) && !/<base[\s>]/i.test(s)) {
    const base = `<base href="${mh.url.replace(/"/g, '&quot;')}">`;
    s = /<head[^>]*>/i.test(s) ? s.replace(/<head[^>]*>/i, (h) => h + base) : base + s;
  }
  return { type: p.type + charset, body: Buffer.from(s, 'latin1') };
}

module.exports = { parseMhtml, renderPart };
