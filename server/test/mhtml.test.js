'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMhtml, renderPart } = require('../src/mhtml');

const mk = (parts) => Buffer.from([
  'Snapshot-Content-Location: https://site.test/dir/page',
  'Content-Type: multipart/related; type="text/html"; boundary="X"', '', '',
  ...parts.flatMap((p) => ['--X', ...p]), '--X--', '',
].join('\r\n'), 'latin1');

test('relative CSS urls resolve against the stylesheet location, then map to parts', () => {
  const mh = parseMhtml(mk([
    ['Content-Type: text/html', 'Content-Location: https://site.test/dir/page', '', '<head></head><link rel="stylesheet" href="https://site.test/s/a.css">'],
    ['Content-Type: text/css', 'Content-Location: https://site.test/s/a.css', '',
      '@import "b.css"; .x{background:url(/img/in.png)} .y{background:url(\'../img/out.png\')} .z{background:url(data:image/png;base64,AA==)}'],
    ['Content-Type: image/png', 'Content-Transfer-Encoding: base64', 'Content-Location: https://site.test/img/in.png', '', 'AA=='],
  ]));
  assert.equal(mh.root, 0);
  const css = renderPart(mh, 1, (i) => `/part/${i}`).body.toString();
  assert.equal(css, '@import "https://site.test/s/b.css"; .x{background:url(/part/2)} '
    + ".y{background:url('https://site.test/img/out.png')} .z{background:url(data:image/png;base64,AA==)}");
  const html = renderPart(mh, 0, (i) => `/part/${i}`).body.toString();
  assert.equal(html, '<head><base href="https://site.test/dir/page"></head><link rel="stylesheet" href="/part/1">');
});

test('rejects non-MHTML input', () => {
  assert.throws(() => parseMhtml(Buffer.from('hello')));
  assert.throws(() => parseMhtml(Buffer.from('Content-Type: text/html\r\n\r\n<p>')));
});
