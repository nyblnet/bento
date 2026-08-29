#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Per-selection typeface and size.
//
//   node scripts/test-type-font.ts
//
// A font is a CHARACTER property — "make these three words Verdana" — so it is
// a mark, and doc.type stays the document's default. Two things are easy to
// get wrong and both lose the user's work silently: setting a size must not
// discard the family under it, and a family written into a `style` attribute
// is untrusted document data going into CSS.

import { register } from 'node:module';
register('./lib/ts-resolve-hooks.mjs', import.meta.url);

const inline = await import('../type/src/inline.ts');
const { setFont, fontAt, fontAcross, safeFamily, safeSize, fontStyle, toHtml, normalize } = inline;

let checks = 0, bad = 0;
const ok = (c: boolean, m: string) => { checks++; if (c) console.log(`  ok    ${m}`); else { bad++; console.log(`  FAIL  ${m}`); } };
const eq = (a: unknown, b: unknown, m: string) => {
  const same = JSON.stringify(a) === JSON.stringify(b);
  checks++;
  if (same) console.log(`  ok    ${m}`);
  else { bad++; console.log(`  FAIL  ${m}\n        got  ${JSON.stringify(a)}\n        want ${JSON.stringify(b)}`); }
};
const LEN = 20;
const fonts = (ms: unknown[]) => (ms as Array<{ t: string }>).filter(m => m.t === 'font');

console.log('\n— setting a family —');
{
  const ms = setFont([], LEN, 0, 5, { family: 'Verdana' });
  eq(fonts(ms).length, 1, 'one font mark');
  eq([fonts(ms)[0].from, fonts(ms)[0].to], [0, 5], 'over exactly the range');
  eq(fonts(ms)[0].family, 'Verdana', 'carrying the family');
  ok(fonts(ms)[0].size === undefined, 'and no size it was not asked for');
}

console.log('\n— a font REPLACES, it does not nest —');
{
  let ms = setFont([], LEN, 0, 10, { family: 'Georgia' });
  ms = setFont(ms, LEN, 0, 10, { family: 'Verdana' });
  eq(fonts(ms).length, 1, 'still one mark over the range');
  eq(fonts(ms)[0].family, 'Verdana', 'the new family wins outright');
}

console.log('\n— setting a SIZE keeps the family under it —');
{
  let ms = setFont([], LEN, 0, 10, { family: 'Verdana' });
  ms = setFont(ms, LEN, 0, 10, { size: 14 });
  const f = fonts(ms);
  eq(f.length, 1, 'one mark');
  eq([f[0].family, f[0].size], ['Verdana', 14], 'BOTH survive — this is the one that silently lost work');
}

console.log('\n— a size over PART of a fonted run —');
{
  let ms = setFont([], LEN, 0, 10, { family: 'Verdana' });
  ms = setFont(ms, LEN, 4, 7, { size: 18 });
  const f = fonts(ms).sort((a, b) => a.from - b.from);
  eq(f.length, 3, 'the run splits in three');
  eq(f.map(m => [m.from, m.to, m.family ?? null, m.size ?? null]),
     [[0, 4, 'Verdana', null], [4, 7, 'Verdana', 18], [7, 10, 'Verdana', null]],
     'and every piece keeps Verdana, with the size only in the middle');
}

console.log('\n— clearing —');
{
  let ms = setFont([], LEN, 0, 10, { family: 'Verdana', size: 14 });
  ms = setFont(ms, LEN, 0, 10, { family: null });
  eq(fonts(ms)[0].family, undefined, 'null clears the family');
  eq(fonts(ms)[0].size, 14, 'and leaves the size');
  const gone = setFont(ms, LEN, 0, 10, { size: null });
  eq(fonts(gone).length, 0, 'clearing the last attribute drops the mark entirely');
}

console.log('\n— what the picker shows —');
{
  let ms = setFont([], LEN, 0, 10, { family: 'Verdana' });
  eq(fontAcross(ms, 0, 10).family, 'Verdana', 'one family across the range');
  ms = setFont(ms, LEN, 5, 10, { family: 'Georgia' });
  eq(fontAcross(ms, 0, 10).family, 'mixed', 'two families read as mixed, not as the first one');
  eq(fontAcross(ms, 0, 5).family, 'Verdana', 'and a uniform sub-range still reads plainly');
  eq(fontAcross([], 0, 10).family, undefined, 'no mark at all is undefined, not mixed');
  eq(fontAt(ms, 7)?.family, 'Georgia', 'fontAt reads the run at an offset');
}

console.log('\n— different fonts must not merge —');
{
  const ms = normalize([{ t: 'font', from: 0, to: 5, family: 'Verdana' },
                        { t: 'font', from: 5, to: 10, family: 'Georgia' }] as never, LEN);
  eq(fonts(ms).length, 2, 'two abutting runs stay two');
  eq(fonts(ms).map(m => m.family), ['Verdana', 'Georgia'], 'each keeps its own family');
  const same = normalize([{ t: 'font', from: 0, to: 5, family: 'Verdana' },
                          { t: 'font', from: 5, to: 10, family: 'Verdana' }] as never, LEN);
  eq(fonts(same).length, 1, 'but two runs of the SAME family do merge');
}

console.log('\n— the CSS boundary —');
{
  ok(safeFamily('Georgia, serif') === 'Georgia, serif', 'an ordinary stack passes');
  ok(safeFamily('"Iowan Old Style", Palatino, serif') === '"Iowan Old Style", Palatino, serif', 'quoted names pass');
  const ATTACKS: Array<[string, string]> = [
    ['Georgia; background: url(https://tracker/x.png)', 'a second declaration'],
    ['Georgia; behavior: url(#x)', 'a behavior url'],
    ['expression(alert(1))', 'an expression()'],
    ['url(javascript:alert(1))', 'a javascript url'],
    ['Georgia"><script>alert(1)</script>', 'an attribute break-out'],
    ['a'.repeat(300), 'an absurdly long value'],
  ];
  for (const [attack, what] of ATTACKS) ok(safeFamily(attack) === null, `refused: ${what}`);

  eq(safeSize(14), 14, 'a plain size passes');
  eq(safeSize(0), null, 'zero is refused');
  eq(safeSize(1e6), null, 'and so is a page-breaking one');
  eq(safeSize(NaN), null, 'and NaN');

  // the rendered attribute, which is what actually reaches the page
  eq(fontStyle({ t: 'font', from: 0, to: 1, family: 'Georgia', size: 14 } as never),
     'font-family:Georgia;font-size:14px', 'a good mark renders both properties');
  eq(fontStyle({ t: 'font', from: 0, to: 1, family: 'Georgia; background: url(x)' } as never),
     '', 'a refused family renders NOTHING, not a broken declaration');

  const html = toHtml('hello world', [{ t: 'font', from: 0, to: 5, family: 'Georgia"><script>alert(1)</script>' }] as never);
  ok(!html.includes('<script'), 'and no script reaches the output');
  ok(html.includes('hello'), 'while the text itself survives');
}

console.log('\n— it reaches paper —');
{
  // print.ts renders through render.ts blockHtml, which is the same toHtml
  // this rig has been testing. A per-run typeface that only existed on screen
  // would be a strange thing for a word processor to have.
  const { blockHtml } = await import('../type/src/render.ts');
  const html = blockHtml({ id: 'p', kind: 'para', text: 'hello world',
                           marks: [{ t: 'font', from: 0, to: 5, family: 'Verdana, sans-serif', size: 14 }] } as never);
  ok(/font-family:Verdana, sans-serif/.test(html), 'the print path emits the family');
  ok(/font-size:14px/.test(html), 'and the size');
}

console.log('\n— the DOM round trip, which is what every keystroke does —');
{
  // The editor reads a block back out of contentEditable on EVERY keystroke
  // (render.ts readBlock -> fromDom). A mark whose payload does not survive
  // that trip is silently destroyed by the next character typed. This was a
  // live bug for tracked changes: <ins> was in no map and vanished, and <del>
  // mapped to a plain strikethrough, so a tracked deletion came back as
  // ordinary struck text with its author gone.
  const { JSDOM } = await (async () => {
    try { return await import('jsdom'); } catch { return { JSDOM: null as never }; }
  })();
  if (!JSDOM) {
    console.log('  --    skipped: jsdom is not installed (the browser check below covers it)');
  } else {
    const dom = new JSDOM('<div></div>');
    const g = globalThis as { document?: unknown };
    const had = g.document;
    g.document = dom.window.document;
    const trip = (text: string, marks: unknown[]) => {
      const host = dom.window.document.createElement('div');
      host.innerHTML = toHtml(text, marks as never);
      return inline.fromDom(host);
    };

    const font = trip('hello world', [{ t: 'font', from: 0, to: 5, family: 'Verdana, sans-serif', size: 14 }]);
    eq(font.text, 'hello world', 'font: text survives');
    eq(font.marks, [{ t: 'font', from: 0, to: 5, family: 'Verdana, sans-serif', size: 14 }],
       'font: family AND size survive the round trip');

    const ins = trip('abc', [{ t: 'ins', from: 0, to: 3, by: 'Counsel', at: '2026-08-18T10:00:00Z' }]);
    eq(ins.marks, [{ t: 'ins', from: 0, to: 3, by: 'Counsel', at: '2026-08-18T10:00:00Z' }],
       'ins: survives WITH its author and timestamp');

    const del = trip('abc', [{ t: 'del', from: 0, to: 3, by: 'Counsel', at: '2026-08-18T10:00:00Z' }]);
    eq(del.marks, [{ t: 'del', from: 0, to: 3, by: 'Counsel', at: '2026-08-18T10:00:00Z' }],
       'del: stays a DELETION, not a strikethrough');

    const bold = trip('abc', [{ t: 'b', from: 0, to: 3 }]);
    eq(bold.marks, [{ t: 'b', from: 0, to: 3 }], 'plain marks are unaffected');

    // a <del> from OUTSIDE bento still means strikethrough, as it does
    // everywhere else on the web
    const host = dom.window.document.createElement('div');
    host.innerHTML = '<del>abc</del>';
    eq(inline.fromDom(host).marks, [{ t: 's', from: 0, to: 3 }], 'a pasted <del> is still a strikethrough');

    if (had === undefined) delete g.document; else g.document = had;
  }
}

console.log(`\n${checks - bad}/${checks} checks passed`);
if (bad) process.exit(1);
