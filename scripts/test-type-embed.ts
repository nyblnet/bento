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

console.log('\n— embedded documents don\'t carry sharing keys —');
{
  // The source document's collab block is that document's sharing keys: the
  // room's read key and, in a writer's or owner's copy, private keys and an
  // invite. Embedding copies the source document into ours; it must arrive
  // without them.
  const ENVELOPE = { on: true, room: 'w123', key: 'READ-KEY', owner: 'OWNER-PUB', ownerPriv: 'OWNER-KEY',
                     writerPub: 'WRITER-PUB', writerPriv: 'WRITER-KEY', invite: { pub: 'IP', priv: 'INVITE-KEY', role: 'writer', sig: 'S' } };
  const SECRETS = ['READ-KEY', 'OWNER-KEY', 'WRITER-KEY', 'INVITE-KEY'];
  const shell = (doc: object) => '<script id="bento-doc">' + JSON.stringify(doc) + '</script>';

  const e = readArtifact(shell({ format: 'bento/slides', docId: 's9', title: 'Roadmap', collab: ENVELOPE }));
  const blob = JSON.stringify(e!.doc);
  for (const secret of SECRETS) ok(!blob.includes(secret), `the ${secret} does not survive intake`);
  ok(!('collab' in (e!.doc as object)), 'the whole collab block is gone, not just its keys');
  ok((e!.doc as { title?: string }).title === 'Roadmap', 'while the document itself is intact');
  ok((e!.doc as { docId?: string }).docId === 's9', 'and docId is KEPT — it names the source, and is not a capability');

  // NESTED: an embedded bento/type document can carry embeds of its own. The
  // kernel's withoutCaps is shallow, so this is the case it alone would miss.
  const inner = { format: 'bento/slides', docId: 'deck-1', collab: ENVELOPE };
  const middle = { format: 'bento/type', docId: 'type-2', collab: ENVELOPE,
                   body: [{ id: 'e', kind: 'embed', text: '', embed: { app: 'bento/slides', view: '<svg/>', doc: inner } }] };
  const n = readArtifact(shell(middle));
  const nblob = JSON.stringify(n!.doc);
  ok(SECRETS.every(x => !nblob.includes(x)), 'an embed INSIDE an embedded document arrives without its keys too');
  ok(nblob.includes('deck-1'), 'and the inner document is still there to open');
}

// ─────────────────────────────── a footnote id is ESCAPED into its attribute
// A synced op never passes parseDoc, so the escape at render is the layer it
// meets. Unescaped, an id could close data-note="…" and add an event handler
// (it did: measured in the editor). Asserted on the string render produces.
{
  const { blockHtml } = await import('../type/src/render.ts');
  const NID = 'n1" onmouseover="window.__pwned=1" data-x="';
  const html = blockHtml({ id: 'b1', kind: 'para', text: 'Hello world', notes: [{ id: NID, at: 5 }] } as never);
  ok(html.includes('data-note='), 'control: the note marker IS rendered for the hostile id');
  ok(!/data-note="[^"]*"\s+onmouseover=/.test(html) && !html.includes('" onmouseover="'),
     `a footnote id cannot close its attribute: the quote is escaped (${html.match(/data-note="[^>]*/)?.[0].slice(0, 60)})`);
  const { parseDoc } = await import('../type/src/model.ts');
  const r = parseDoc(JSON.stringify({ format: 'bento/type', docId: 'd', title: 't', footnotes: { [NID]: 'x', ok1: 'y' },
    body: [{ id: 'b1', kind: 'para', text: 'Hello world', notes: [{ id: NID, at: 2 }, { id: 'ok1', at: 5 }] }] }));
  ok(r.ok && !Object.hasOwn(r.doc.footnotes, NID) && Object.hasOwn(r.doc.footnotes, 'ok1')
     && (r.doc.body[0].notes ?? []).map(n => n.id).join() === 'ok1',
     'and a FILE cannot carry such an id at all: parseDoc keeps only ids of a safe charset (a normal id survives)');
}

console.log(`\n${checks - bad}/${checks} checks passed`);
if (bad) process.exit(1);
