#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Embedded Bento artifacts — the shape, and the boundary.
//
//   node scripts/test-type-embed.ts
//
// The boundary is the point. An embed exists to carry MARKUP PRODUCED
// ELSEWHERE into this document, which makes it the most attractive place in
// the whole format to hide a script: it is the one field whose job is to hold
// someone else's HTML. Every document is untrusted input — a hand-written
// #bento-doc block, a file mailed to you, a sync op — so the static render is
// checked before it is ever put in the page.

import { register } from 'node:module';
register('./lib/ts-resolve-hooks.mjs', import.meta.url);

const { safeView, readArtifact, embedHtml, APPS } = await import('../type/src/embed.ts');

let checks = 0, bad = 0;
const ok = (cond: boolean, msg: string) => {
  checks++;
  if (cond) console.log(`  ok    ${msg}`);
  else { bad++; console.log(`  FAIL  ${msg}`); }
};

console.log('\n— a plain chart is allowed through —');
{
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">'
            + '<rect x="2" y="2" width="20" height="46" fill="#c66"/><text x="4" y="20">Q1</text></svg>';
  ok(safeView(svg) === svg, 'an ordinary svg survives unchanged');
  ok(safeView('  ' + svg + '\n') === svg, 'and is trimmed, not rejected, for whitespace');
}

console.log('\n— what must never reach the page —');
const REFUSE: Array<[string, string]> = [
  ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'a script element'],
  ['<svg xmlns="http://www.w3.org/2000/svg"><rect onload="alert(1)"/></svg>', 'an onload handler'],
  ['<svg xmlns="http://www.w3.org/2000/svg"><rect ONMOUSEOVER="x()"/></svg>', 'a handler in capitals'],
  ['<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><b>hi</b></foreignObject></svg>', 'foreignObject'],
  ['<svg xmlns="http://www.w3.org/2000/svg"><iframe src="x"></iframe></svg>', 'an iframe'],
  ['<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil/x.png"/></svg>', 'a remote image'],
  ['<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="javascript:alert(1)">x</a></svg>', 'a javascript: link'],
  ['<svg xmlns="http://www.w3.org/2000/svg"><style>*{x:y}</style></svg>', 'a style element (it would leak document-wide)'],
  ['<div>not an svg at all</div>', 'markup that is not an svg'],
  ['<img src=x onerror=alert(1)>', 'an img with a handler'],
];
for (const [src, what] of REFUSE) ok(safeView(src) === null, `refused: ${what}`);

console.log('\n— refusing is not the same as losing —');
{
  const b = { id: 'e1', kind: 'embed', text: '',
              embed: { app: 'bento/dash', view: '<svg><script>x</script></svg>', doc: { format: 'bento/dash' } } };
  const html = embedHtml(b as never);
  ok(!html.includes('<script'), 'the refused markup is NOT in the output');
  ok(html.includes('could not be displayed safely'), 'and the reader is told why');
  ok((b as { embed: { doc: unknown } }).embed.doc !== undefined, 'while the SOURCE is still there to open elsewhere');
}

console.log('\n— reading another app\'s file —');
{
  const artifact =
    '<!doctype html><html><head><title>x</title></head><body>'
    + '<div data-bento-preview><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg></div>'
    + '<script type="application/json" id="bento-doc">{"format":"bento/dash","docId":"d1","title":"Q3"}</script>'
    + '</body></html>';
  const e = readArtifact(artifact);
  ok(e !== null, 'the artifact is recognised');
  ok(e?.app === 'bento/dash', 'its app comes from the document format');
  ok(typeof e?.view === 'string' && e.view.startsWith('<svg'), 'the still is taken from the saved preview');
  ok((e?.doc as { title?: string })?.title === 'Q3', 'and the source document rides along');

  // Format additivity: an app this build has never heard of must still embed.
  const future = artifact.replace('bento/dash', 'bento/whatever');
  const f = readArtifact(future);
  ok(f?.app === 'bento/whatever', 'an UNKNOWN bento app is accepted, not rejected');
  ok(!(f!.app in APPS), 'and it genuinely is not in the known list');
  ok(embedHtml({ id: 'e', kind: 'embed', text: '', embed: f } as never).includes('bento/whatever'),
     'its name is shown, so the reader knows where to open it');

  ok(readArtifact('<html><body>nothing here</body></html>') === null, 'a non-Bento file is refused');
  ok(readArtifact('<script id="bento-doc">{not json</script>') === null, 'so is a corrupt block');
  ok(readArtifact('<script id="bento-doc">{"format":"text/plain"}</script>') === null,
     'so is a JSON block that is not a Bento document');
}

console.log('\n— a file with no preview still embeds —');
{
  const e = readArtifact('<script id="bento-doc">{"format":"bento/slides","docId":"s1"}</script>');
  ok(e !== null && safeView(e.view) !== null, 'the fallback still is itself safe');
  ok(e!.view.includes('Bento Slides'), 'and says which app it came from');
}

console.log(`\n${checks - bad}/${checks} checks passed`);
if (bad) process.exit(1);
