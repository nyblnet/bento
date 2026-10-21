#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Generates home/fixtures/gate1/, the gate-1 conformance corpus (bento/connect
// K5): every host's verifier (JS, Swift, Kotlin, Rust) must reach the stated
// verdict on every row.
//
//   node scripts/gen-gate1-corpus.ts
//
// Every row DECLARES its expected verdict. The generator then checks the
// kernel's reference (kernel/src/gate1.ts) against each one and refuses to
// write the corpus if they disagree. The answers are the rules, not whatever
// the JS happens to do. The releases are small synthetic files with the real
// shape: code blocks, a loader, a preview with its remover. The history is
// signed with a THROWAWAY TEST key whose public half is in the corpus.
// Signatures are random, so regenerating changes those bytes but no verdict.

import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyServed, verifyStrict, strictExpectedFrom, acceptHistory, type History, type Pins } from '../kernel/src/gate1.ts'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'home/fixtures/gate1')
const S = 'scr' + 'ipt'
const hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const csp = (s: string) => `sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}`

// --- the synthetic releases ---------------------------------------------------------
const REMOVER = "(function(){var a=document.querySelectorAll('[data-bento-preview]');for(var i=0;i<a.length;i++)a[i].remove()})()"
interface R { version: string; rt: string; css: string; loader: string; remover: string | null }
const RELEASES: R[] = [
  { version: '0.9.0', rt: 'RT0', css: 'CSS0', loader: 'load0()', remover: null }, // before previews
  { version: '1.0.0', rt: 'RT1', css: 'CSS1', loader: 'load1()', remover: REMOVER },
  { version: '1.1.0', rt: 'RT1', css: 'CSS1', loader: 'load2()', remover: REMOVER }, // shares 1.0.0's runtime
  { version: '1.2.0', rt: 'RT3', css: 'CSS3', loader: 'load3()', remover: REMOVER },
]
const file = (r: R, o: { title?: string; doc?: string; preview?: string | null } = {}) => {
  const preview = r.remover && o.preview !== null
    ? `<div data-bento-preview="1">${o.preview ?? '<p>Page one</p>'}</div><${S} data-bento-preview="1">${r.remover}</${S}>\n`
    : ''
  return '<!DOCTYPE html>\n<html lang="en"><head>\n<meta charset="UTF-8">\n' +
    `<title>${o.title ?? 'A deck'}</title>\n<style>body{margin:0}</style>\n` +
    `<${S} type="application/bento+json" id="bento-doc">${o.doc ?? '{"format":"bento/test","title":"A deck"}'}</${S}>\n` +
    `<${S} type="bento/deflate-b86" id="bento-rt-css" data-len="${r.css.length}">${r.css}</${S}>\n` +
    `<${S} type="bento/deflate-b86" id="bento-rt" data-len="${r.rt.length}">${r.rt}</${S}>\n` +
    `</head><body>\n${preview}<${S}>${r.loader}</${S}>\n</body></html>\n`
}
const pinsOf = (r: R): Pins => ({
  v: 1,
  blocks: { 'bento-rt': hex(r.rt), 'bento-rt-css': hex(r.css), loader: hex(r.loader), remover: r.remover ? hex(r.remover) : null },
  scriptSrc: r.remover ? [csp(r.loader), csp(r.remover)] : [csp(r.loader)],
})
const shaOf = (r: R) => hex(file(r, { preview: null }))
const history: History = {
  app: 'bento-test', v: 1,
  releases: [...RELEASES].reverse().map((r) => ({ version: r.version, sha256: shaOf(r), at: '2026-10-21T00:00:00.000Z', pins: pinsOf(r) })),
}

// --- served rows: does ONE release match EVERY block? -----------------------------
const [r09, r1, r11, r12] = RELEASES
const g = file(r1)
const head = (x: string) => g.replace('</head>', x + '</head>')
const body = (x: string) => g.replace('</body>', x + '</body>')
type Served = { name: string; html: string; verdict: 'genuine' | 'unknown'; release?: string; why: string }
const served: Served[] = [
  { name: 'genuine-1.0.0', html: g, verdict: 'genuine', release: '1.0.0', why: 'a genuine saved file' },
  { name: 'genuine-1.1.0-shared-runtime', html: file(r11), verdict: 'genuine', release: '1.1.0', why: 'shares 1.0.0\'s runtime; the loader tells them apart' },
  { name: 'genuine-1.2.0', html: file(r12), verdict: 'genuine', release: '1.2.0', why: 'a genuine saved file' },
  { name: 'genuine-0.9.0-no-remover', html: file(r09), verdict: 'genuine', release: '0.9.0', why: 'a release from before previews saves no remover' },
  { name: 'genuine-1.0.0-shell', html: file(r1, { preview: null }), verdict: 'genuine', release: '1.0.0', why: 'the built shell itself: no preview yet' },
  { name: 'genuine-other-content', html: file(r1, { title: 'Other', doc: '{"format":"bento/test","title":"Other","slides":[{"x":"\\u003cb\\u003e"}]}', preview: '<h1 style="color:red">Other</h1>' }), verdict: 'genuine', release: '1.0.0', why: 'the document, title and inert preview vary freely' },
  // the grammar: only Bento's exact data types are inert
  { name: 'src-script', html: head(`<${S} src="https://evil.example/x.js"></${S}>`), verdict: 'unknown', why: 'any src= is executable, and never pinned' },
  { name: 'unknown-type', html: head(`<${S} type="text/x-template">x</${S}>`), verdict: 'unknown', why: 'an unknown type is executable' },
  { name: 'type-module', html: head(`<${S} type="module">x</${S}>`), verdict: 'unknown', why: 'module is executable' },
  { name: 'type-Module-case', html: head(`<${S} type="Module">x</${S}>`), verdict: 'unknown', why: 'module in any case is executable' },
  { name: 'type-text-JavaScript', html: head(`<${S} type="text/JavaScript">x</${S}>`), verdict: 'unknown', why: 'a JS type in mixed case is executable' },
  { name: 'data-type-other-case', html: g.replace('type="application/bento+json"', 'type="Application/Bento+JSON"'), verdict: 'unknown', why: 'the data allowlist is exact: another case is executable' },
  { name: 'uppercase-SCRIPT', html: head('<SCRIPT>x</SCRIPT>'), verdict: 'unknown', why: 'an uppercase tag is still a script' },
  { name: 'nul-in-type-name', html: g.replace('type="bento/deflate-b86" id="bento-rt"', 'ty\u0000pe="bento/deflate-b86" id="bento-rt"'), verdict: 'unknown', why: 'a NUL makes it another attribute: the script has no type, so it runs' },
  { name: 'extra-plain-script', html: body(`<${S}>evil()</${S}>`), verdict: 'unknown', why: 'an executable script that is neither the loader nor the remover' },
  { name: 'loader-byte-changed', html: g.replace('load1()', 'load1( )'), verdict: 'unknown', why: 'the loader no longer matches its pin' },
  { name: 'runtime-byte-changed', html: g.replace('>RT1<', '>RT2<'), verdict: 'unknown', why: 'the runtime block no longer matches its pin' },
  { name: 'two-runtime-blocks', html: head(`<${S} type="bento/deflate-b86" id="bento-rt">RT1</${S}>`), verdict: 'unknown', why: 'exactly one block per id' },
  { name: 'loader-of-another-release', html: g.replace('load1()', 'load3()'), verdict: 'unknown', why: 'a partial match (1.0.0 runtime, 1.2.0 loader) is not a release' },
  // markup a genuine file never carries
  { name: 'iframe', html: body('<iframe src="https://evil.example/"></iframe>'), verdict: 'unknown', why: '<iframe>' },
  { name: 'object', html: body('<object data="x"></object>'), verdict: 'unknown', why: '<object>' },
  { name: 'embed', html: body('<embed src="x">'), verdict: 'unknown', why: '<embed>' },
  { name: 'base', html: head('<base href="https://evil.example/">'), verdict: 'unknown', why: '<base>' },
  { name: 'meta-refresh', html: head('<meta http-equiv="refresh" content="0;url=https://evil.example/">'), verdict: 'unknown', why: 'a <meta> refresh' },
  { name: 'meta-csp', html: head(`<meta http-equiv='Content-Security-Policy' content="script-src *">`), verdict: 'unknown', why: 'a <meta> CSP' },
  { name: 'on-attribute', html: g.replace('<body>', '<body onload="evil()">'), verdict: 'unknown', why: 'an on*= attribute' },
  { name: 'on-attribute-in-preview', html: g.replace('<p>Page one</p>', '<img src=x onerror="evil()">'), verdict: 'unknown', why: 'an on*= attribute inside the preview' },
  // scanner-split rows: every host's scanner must agree
  { name: 'script-in-comment-before-loader', html: g.replace('</head>', `<!-- <${S}>evil()</${S}> --></head>`), verdict: 'unknown', why: 'a comment holding a <script>' },
  { name: 'script-in-textarea', html: body(`<textarea><${S}>x</${S}></textarea>`), verdict: 'unknown', why: 'a <script> inside <textarea>' },
  { name: 'script-in-title', html: g.replace('<title>A deck</title>', `<title><${S}>x</${S}></title>`), verdict: 'unknown', why: 'a <script> inside <title>' },
  { name: 'script-in-style', html: g.replace('<style>body{margin:0}</style>', `<style>/* <${S}>x</${S}> */body{margin:0}</style>`), verdict: 'unknown', why: 'a <style> holding a <script>' },
  { name: 'doc-block-raw-lt', html: g.replace('"title":"A deck"}', '"title":"<b>"}'), verdict: 'unknown', why: 'a data block containing "<" (Bento always escapes it)' },
  { name: 'doc-block-double-escape', html: g.replace('"title":"A deck"}', `"title":"<!--<${S}>"}`), verdict: 'unknown', why: '"<!--<script" inside a data block' },
  // the attribute tokenizer (security and vault, #825): "/" separates attributes,
  // a quoted value ends one, and the FIRST duplicate wins, as a browser reads them
  { name: 'slash-before-js-type', html: head(`<${S} /type="text/javascript" type="application/bento+json">x</${S}>`), verdict: 'unknown', why: '"/" separates attributes: the browser reads the FIRST type, JavaScript, and runs it' },
  { name: 'slash-module-first', html: head(`<${S}/type="module" type="application/bento+json">x</${S}>`), verdict: 'unknown', why: '"/" right after the tag name: the first type is module, and it runs' },
  { name: 'duplicate-type-js-first', html: head(`<${S} type="text/javascript" type="application/bento+json">x</${S}>`), verdict: 'unknown', why: 'the FIRST duplicate wins: JavaScript' },
  { name: 'no-separator-after-quoted', html: head(`<${S} type="text/javascript"type="application/bento+json">x</${S}>`), verdict: 'unknown', why: 'a quoted value ends the attribute with no separator: two types, the first JavaScript' },
  { name: 'form-feed-js-type', html: head(`<${S}\ftype="text/javascript">x</${S}>`), verdict: 'unknown', why: 'form feed is a separator: a JavaScript type' },
  { name: 'equals-without-value', html: head(`<${S} type=>x</${S}>`), verdict: 'unknown', why: 'type= with no value is the empty type, which runs' },
  { name: 'leading-equals-name', html: head(`<${S} =type="application/bento+json">x</${S}>`), verdict: 'unknown', why: 'an attribute NAMED "=type" is not type: the script has no type, so it runs' },
  { name: 'entity-encoded-module', html: head(`<${S} type="&#x6d;odule">x</${S}>`), verdict: 'unknown', why: 'a browser decodes the type to "module"' },
  { name: 'doc-block-slash-duplicate', html: g.replace(`<${S} type="application/bento+json" id="bento-doc">`, `<${S} /type="text/javascript" type="application/bento+json" id="bento-doc">`), verdict: 'unknown', why: 'the doc block opened with a JavaScript type first: it runs (home-android)' },
  { name: 'slash-in-data-tag', html: g.replace(`<${S} type="bento/deflate-b86" id="bento-rt"`, `<${S}/type="bento/deflate-b86" id="bento-rt"`), verdict: 'unknown', why: 'Bento never writes "/" in a script tag: refused outright, whatever it means' },
  { name: 'form-feed-separators', html: g.replace(`<${S} type="bento/deflate-b86" id="bento-rt"`, `<${S}\ftype="bento/deflate-b86"\fid="bento-rt"`), verdict: 'genuine', release: '1.0.0', why: 'form feed between attributes is whitespace: the same block' },
  { name: 'src-with-loader-body', html: g.replace(`<${S}>load1()</${S}>`, `<${S} src="https://example.invalid/x.js">load1()</${S}>`), verdict: 'unknown', why: 'the browser runs the src and ignores the body: the genuine loader text is no excuse (home-android)' },
  // tags glued together (home-ios, found by a WebKit oracle): a tag name runs to
  // whitespace, "/" or ">", so "<meta<style>" is ONE tag and what follows is real
  { name: 'meta-glued-style', html: g.replace('<meta charset="UTF-8">', `<meta<style><${S}>window.pwned=3</${S}></style> charset="UTF-8">`), verdict: 'unknown', why: '"<meta<style>" is one tag: the script after it is real and runs' },
  { name: 'p-glued-script', html: body(`<p<${S}>x</${S}>`), verdict: 'unknown', why: 'a start tag named "p<script": Bento writes only plain names' },
  { name: 'div-glued-style', html: body('<div<style>a{}</style>'), verdict: 'unknown', why: 'a start tag named "div<style"' },
  { name: 'a-glued-comment', html: body('<a<!-- x -->'), verdict: 'unknown', why: 'a start tag named "a<!--"' },
  { name: 'empty-comment-then-script', html: body(`<!--><${S}>window.pwned=4</${S}>`), verdict: 'unknown', why: '"<!-->" is a whole comment: the script after it is real' },
  { name: 'empty-comment-alone', html: body('<!--><!---><p>after</p>'), verdict: 'genuine', release: '1.0.0', why: '"<!-->" and "<!--->" end at once: nothing after them is swallowed' },
  // END tags are tokenized like start tags, quoted attribute values and all: in
  // `</p a="><b c='">` the tag ends at the SECOND ">", so the script after it runs.
  // Skipping an end tag to its first ">" read `<b c='">'<script>` as one tag.
  { name: 'endtag-quoted-gt', html: body(`</p a="><b c='">'<${S}>window.pwned=5</${S}>'>`), verdict: 'unknown', why: 'the end tag ends at its second ">": the script after it is real and runs' },
  { name: 'endtag-attribute', html: body('<p>x</p class="x">'), verdict: 'unknown', why: 'an end tag carrying attributes: a browser drops them, but they move where the tag ends, and Bento writes none' },
  { name: 'endtag-on-pinned-script', html: g.replace(/<\/script>/, '</script a=">">'), verdict: 'unknown', why: 'an attribute on a pinned script\'s END tag: the block text is unchanged, and still refused' },
  { name: 'endtag-glued-name', html: body('<p>x</p<b>'), verdict: 'unknown', why: 'an end tag named "p<b"' },
  { name: 'endtag-empty', html: body('<p>x</>y</p>'), verdict: 'genuine', release: '1.0.0', why: '"</>" is ignored entirely: nothing after it is swallowed' },
  // the browser's reading must WIN in the genuine direction too (home-desktop):
  // a walk that ends raw text at any "</name", or doesn't know "<!-->", would
  // wrongly refuse these, and no unknown row could tell
  { name: 'empty-comment-in-paragraph', html: body('<p><!--></p><p>after</p>'), verdict: 'genuine', release: '1.0.0', why: '"<!-->" ends at once: the paragraph after it is markup, not comment' },
  { name: 'style-false-close', html: body('<style>a{}</stylex><b onclick=x></style>'), verdict: 'genuine', release: '1.0.0', why: '"</stylex>" doesn\'t end the style: the <b onclick> is style TEXT, not an element' },
  { name: 'title-false-close', html: body('<title>t</titlex><b onclick=x></title>'), verdict: 'genuine', release: '1.0.0', why: '"</titlex>" doesn\'t end the title: the <b onclick> is title TEXT' },
  // the case fold must not change length (home-desktop): toLowerCase() makes 'İ' two units
  { name: 'case-fold-breakout', html: body('<p>' + 'İ'.repeat(20) + `</p><style>a{}</style><${S}>window.pwned=1</${S}>`), verdict: 'unknown', why: 'a length-changing case fold would skip this script entirely' },
  { name: 'genuine-length-changing-text', html: file(r1, { title: 'İstanbul ı ß ﬃ Σ', doc: '{"format":"bento/test","title":"İstanbul ı ß ﬃ ΣΑΣ İİİİ"}', preview: '<p>İİİİ ß ﬃ Σ</p>' }), verdict: 'genuine', release: '1.0.0', why: "a genuine document in Turkish (and ß, ﬃ, Σ) is still genuine" },
  { name: 'single-quoted-attributes', html: g.replace(/type="bento\/deflate-b86"/g, "type='bento/deflate-b86'"), verdict: 'genuine', release: '1.0.0', why: 'single-quoted attributes parse the same' },
  { name: 'unquoted-attributes', html: g.replace(/type="bento\/deflate-b86"/g, 'type=bento/deflate-b86'), verdict: 'genuine', release: '1.0.0', why: 'unquoted attributes parse the same' },
  { name: 'close-tag-with-space', html: g.replace(`>RT1</${S}>`, `>RT1</${S} >`), verdict: 'genuine', release: '1.0.0', why: '"</script >" closes a block like "</script>"' },
  { name: 'tabs-and-newlines-in-tag', html: g.replace(`<${S} type="bento/deflate-b86" id="bento-rt"`, `<${S}\ttype="bento/deflate-b86"\nid="bento-rt"`), verdict: 'genuine', release: '1.0.0', why: 'whitespace between attributes is whitespace' },
]

// --- strict rows: the file:// fallback (security §15: both genuine saves pass, all 16 tampers refuse)
const save1 = file(r1)
const save2 = file(r1, { title: 'Second', doc: '{"format":"bento/test","title":"Second"}', preview: '<h2>Second deck</h2>' })
const expected = strictExpectedFrom(save1)
type Strict = { name: string; html: string; ok: boolean; why: string }
const at = (h: string, find: string, put: string) => { if (!h.includes(find)) throw new Error(`strict row: ${find} not found`); return h.replace(find, put) }
const strict: Strict[] = [
  { name: 'genuine-save1', html: save1, ok: true, why: 'a genuine save' },
  { name: 'genuine-save2', html: save2, ok: true, why: 'another genuine save: doc, title and preview differ' },
  { name: 'genuine-save-length-changing-text', html: file(r1, { title: 'İstanbul ß', doc: '{"format":"bento/test","title":"İstanbul ı ß ﬃ"}', preview: '<p>İİİİ ﬃ</p>' }), ok: true, why: 'a genuine save in Turkish (and ß, ﬃ)' },
  // vault's 9
  { name: 'sec1-transient-script', html: at(save1, '</body>', `<${S} data-bento-transient>evil()</${S}></body>`), ok: false, why: 'a script under a stripped selector (§13)' },
  { name: 'sec2-extra-preview-script', html: at(save1, '</body>', `<${S} data-bento-preview>evil()</${S}></body>`), ok: false, why: 'a second remover-shaped script' },
  { name: 'sec3-loader-byte', html: at(save1, 'load1()', 'load1( )'), ok: false, why: 'one loader byte changed' },
  { name: 'sec4-plain-script', html: at(save1, '</body>', `<${S}>evil()</${S}></body>`), ok: false, why: 'a plain script' },
  { name: 'sec5-onclick', html: at(save1, '<body>', '<body onclick="x">'), ok: false, why: 'onclick on body' },
  { name: 'v1-doc-executable', html: at(save1, 'type="application/bento+json" id="bento-doc"', 'type="text/javascript" id="bento-doc"'), ok: false, why: 'the doc block retyped as executable' },
  { name: 'v2-script-in-preview', html: at(save1, 'data-bento-preview="1"><p>', `data-bento-preview="1"><${S}>evil()</${S}><p>`), ok: false, why: 'a script inside the preview markup' },
  { name: 'v3-onerror-in-preview', html: at(save1, '<p>Page one</p>', '<img src=x onerror="evil()">'), ok: false, why: 'onerror inside the preview markup' },
  { name: 'v4-second-doc-anchor', html: at(save1, '</body>', `<${S} id="bento-doc">evil()</${S}></body>`), ok: false, why: 'a second doc anchor' },
  // security's 7
  { name: 's1-script-after-html', html: save1 + `<${S}>evil()</${S}>`, ok: false, why: 'a trailing script after </html>' },
  { name: 's2-trailing-bytes', html: save1 + 'x', ok: false, why: 'trailing bytes' },
  { name: 's3-leading-bytes', html: 'x' + save1, ok: false, why: 'leading bytes before <!DOCTYPE' },
  { name: 's4-uppercase-preview-script', html: at(save1, '</body>', `<SCRIPT DATA-BENTO-PREVIEW>evil()</SCRIPT></body>`), ok: false, why: 'an uppercase <SCRIPT DATA-BENTO-PREVIEW>' },
  { name: 's5-decoy-preview-div', html: at(save1, '<div data-bento-preview="1">', `<div data-bento-preview="1"><${S}>evil()</${S}></div><div data-bento-preview="1">`), ok: false, why: 'an attacker preview div placed to shift the span' },
  { name: 's6-crlf', html: save1.replace(/\n/g, '\r\n'), ok: false, why: 'CRLF in the skeleton' },
  { name: 's7-tab-script', html: at(save1, '</body>', `<\t${S}>evil()</${S}></body>`), ok: false, why: '"<\\tscript>"' },
]
if (strict.filter((r) => !r.ok).length !== 16) throw new Error('the strict corpus must carry exactly the 16 tamper rows')

// --- history rows: anti-rollback (acceptHistory) ---------------------------------------
const without = (h: History, v: string): History => ({ ...h, releases: h.releases.filter((e) => e.version !== v) })
const older = without(history, '1.2.0')
const histories: Array<{ name: string; held: History | null; incoming: History; ok: boolean; why: string }> = [
  { name: 'first', held: null, incoming: history, ok: true, why: 'the first history a host sees' },
  { name: 'newer-superset', held: older, incoming: history, ok: true, why: 'a newer history keeping every held entry' },
  { name: 'same-again', held: history, incoming: history, ok: true, why: 'the same history again' },
  { name: 'replayed-older', held: history, incoming: older, ok: false, why: 'ROLLBACK: a replayed older history' },
  { name: 'lacks-held-entry', held: history, incoming: without(history, '1.0.0'), ok: false, why: 'ROLLBACK: it lacks an entry the host holds' },
  { name: 'changed-entry', held: history, incoming: { ...history, releases: history.releases.map((e) => (e.version === '1.0.0' ? { ...e, sha256: 'c'.repeat(64) } : e)) }, ok: false, why: 'an entry changed' },
  { name: 'other-app', held: null, incoming: { ...history, app: 'bento-other' }, ok: false, why: "another app's history" },
  { name: 'not-newest-first', held: null, incoming: { ...history, releases: [...history.releases].reverse() }, ok: false, why: 'malformed: not newest first' },
]

// --- an ambiguous history: two entries with identical blocks (unsigned: it's about the
// matching rule, not the signature). A file matching both is UNKNOWN, never "the first".
const twins: History = { ...history, releases: [{ ...history.releases.find((e) => e.version === '1.0.0')!, version: '1.3.0' }, ...history.releases] }
const ambiguous = [{ name: 'twin-entries', history: twins, html: g, verdict: 'unknown' as const, why: 'two entries match every block: ambiguous' }]

// --- check the reference agrees with every declared verdict, then write -----------------
const disagree: string[] = []
for (const r of served) {
  const v = await verifyServed(r.html, history)
  const got = v.verdict === 'genuine' ? `genuine ${v.release.version}` : 'unknown'
  const want = r.verdict === 'genuine' ? `genuine ${r.release}` : 'unknown'
  if (got !== want) disagree.push(`served ${r.name}: declared ${want}, the reference says ${got}`)
}
for (const r of ambiguous) if ((await verifyServed(r.html, r.history)).verdict !== r.verdict) disagree.push(`ambiguous ${r.name}: declared ${r.verdict}`)
for (const r of strict) if (verifyStrict(r.html, expected).ok !== r.ok) disagree.push(`strict ${r.name}: declared ${r.ok ? 'pass' : 'refuse'}`)
for (const r of histories) if (acceptHistory(r.held, r.incoming, 'bento-test').ok !== r.ok) disagree.push(`history ${r.name}: declared ${r.ok ? 'accept' : 'refuse'}`)
if (disagree.length) { console.error(`the reference disagrees with the declared verdicts:\n  ${disagree.join('\n  ')}`); process.exit(1) }

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const payload = JSON.stringify(history)
const envelope = { payload, sig: sign('sha256', Buffer.from(payload, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') }

// clear only what this generator owns: README.md is written by hand and stays
for (const d of ['served', 'strict']) rmSync(join(OUT, d), { recursive: true, force: true })
mkdirSync(join(OUT, 'served'), { recursive: true }); mkdirSync(join(OUT, 'strict'), { recursive: true })
for (const r of served) writeFileSync(join(OUT, 'served', `${r.name}.html`), r.html)
for (const r of strict) writeFileSync(join(OUT, 'strict', `${r.name}.html`), r.html)
writeFileSync(join(OUT, 'history.json'), JSON.stringify(envelope, null, 2) + '\n')
writeFileSync(join(OUT, 'test-public-key.json'), JSON.stringify(publicKey.export({ format: 'jwk' }), null, 2) + '\n')
writeFileSync(join(OUT, 'strict-expected.json'), JSON.stringify(expected, null, 2) + '\n')
writeFileSync(join(OUT, 'expected.json'), JSON.stringify({
  note: 'gate-1 conformance corpus (bento/connect K5). Every host must reach each verdict. Regenerate with node scripts/gen-gate1-corpus.ts; check with node scripts/test-gate1.ts.',
  app: 'bento-test',
  served: served.map((r) => ({ case: `served/${r.name}.html`, verdict: r.verdict, ...(r.release ? { release: r.release } : {}), why: r.why })),
  strict: strict.map((r) => ({ case: `strict/${r.name}.html`, ok: r.ok, why: r.why })),
  history: histories.map((r) => ({ name: r.name, held: r.held, incoming: r.incoming, ok: r.ok, why: r.why })),
  ambiguous: ambiguous.map((r) => { writeFileSync(join(OUT, 'served', `${r.name}.html`), r.html); return { case: `served/${r.name}.html`, history: r.history, verdict: r.verdict, why: r.why } }),
}, null, 2) + '\n')
console.log(`wrote ${OUT}: ${served.length} served rows, ${strict.length} strict rows (16 tampers), ${histories.length} history rows`)
