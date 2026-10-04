#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Web links and bullets in text (discussions #373/#374 → issue #421; #255, #368).
//
//   node scripts/test-slides-links.ts
//
// WHAT THIS PROVES. A link is one thing in four places — `isWebUrl` — and
// every surface that lets a URL in or out asks it: the shape gate for an
// element `link`, the text sanitizer for an `<a href>`, the markdown
// converters for `[caption](url)`, and the show before it opens anything.
// http and https only; `javascript:` is text, `data:` is text. What opens is
// a NEW tab with noopener+noreferrer, never a navigation of the deck, and
// never in the editor (a click on a link there edits text). The offline
// switch is honoured. The pure halves run here; the DOM halves are pinned by
// shape against their files, and test-sanitize.ts drives the sanitizer in a
// real browser.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isWebUrl } from '../slides/src/model.ts'
import { markdownToHtml } from '../slides/src/editor/markdown.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

console.log('isWebUrl — the one scheme test\n')
ok(isWebUrl('https://bento.page/') && isWebUrl('http://localhost:5199/x?y=1#z'), 'http and https are links')
ok(!isWebUrl('javascript:alert(1)') && !isWebUrl('data:text/html,hi') && !isWebUrl('file:///etc/passwd'), 'javascript:, data: and file: are not')
ok(!isWebUrl('bento.page') && !isWebUrl('slide-3') && !isWebUrl(''), 'a bare host or a slide id is not a web URL (so element links keep meaning slides)')
ok(!isWebUrl('https://x.y/"onclick=1') && !isWebUrl('https://x.y/<script>'), 'a URL carrying a quote or angle bracket is refused (attribute breakout)')
ok(!isWebUrl('https://' + 'a'.repeat(2100)), 'length is bounded')
ok(!isWebUrl(42) && !isWebUrl(null), 'non-strings are not links')

console.log('\nmarkdownToHtml — bullets\n')
// The glyph is followed by an NBSP (U+00A0), never a plain space: at the end
// of a text node a plain space is a collapsed trailing space that the next
// typed character replaces — "- " then "x" gave "•x" (discussion #501).
const NB = '\u00a0'
ok(markdownToHtml('- one\n- two') === `•${NB}one<br>•${NB}two`, '"- " makes a bullet, glyph + NBSP')
ok(markdownToHtml('* one\n* two') === `•${NB}one<br>•${NB}two`, '"* " makes a bullet too (#255)')
ok(markdownToHtml('- top\n  - sub\n    * subsub') === `•${NB}top<br>${NB}${NB}◦${NB}sub<br>${NB}${NB}${NB}${NB}◦${NB}subsub`,
  'two or more leading spaces make an indented sub-bullet, indent kept as NBSPs (#368)')
{
  const src = readFileSync(new URL('../slides/src/editor/markdown.ts', import.meta.url), 'utf8')
  const typed = /bullet\[1\] \? '◦(.)' : '•(.)'/.exec(src)
  ok(!!typed && typed[1] === NB && typed[2] === NB, 'typing "- " inserts the glyph + NBSP too (the autoformat literal, #501)')
  ok(!/[•◦] '/.test(src.replace(/\/\/[^\n]*/g, '')), 'no glyph is followed by a plain space anywhere in the converter')
}
ok(markdownToHtml('\\- not a bullet') === '- not a bullet' && markdownToHtml('\\* not a bullet') === '* not a bullet', 'escaped markers stay literal')
ok(markdownToHtml('2 * 3 = 6') === '2 * 3 = 6', 'a * mid-line is arithmetic, not a bullet')
ok(markdownToHtml('*em*') === '<i>em</i>', '*italic* still works — a bullet needs the trailing space at line start')

console.log('\nmarkdownToHtml — links\n')
ok(markdownToHtml('see [Bento](https://bento.page/) now') === 'see <a href="https://bento.page/">Bento</a> now', '[caption](https://…) becomes an anchor')
ok(markdownToHtml('[x](javascript:alert(1))') === '[x](javascript:alert(1))', 'a javascript: "link" stays literal text')
ok(markdownToHtml('[x](data:text/html,hi)') === '[x](data:text/html,hi)', 'so does data:')
ok(markdownToHtml('[q](https://x.y/?a=1&b=2)') === '<a href="https://x.y/?a=1&amp;b=2">q</a>', 'an ampersand in the URL is escaped for the attribute')
ok(markdownToHtml('[**bold**](https://x.y/)') === '<a href="https://x.y/"><b>bold</b></a>', 'inline formatting inside the caption survives')
ok(markdownToHtml('a [b](https://x.y/) and - c') === 'a <a href="https://x.y/">b</a> and - c', 'a link mid-line, a dash mid-line: only the link converts')

console.log('\nevery surface asks isWebUrl\n')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')
const render = read('slides/src/render.ts')
ok(/'H1', 'H2', 'A',/.test(render) && /elChild\.tagName === 'A'[\s\S]{0,300}isWebUrl\(href\)/.test(render),
  'render.ts sanitizeHtml: <a> is allowed, keeps href only when isWebUrl, and is unwrapped otherwise')
ok(/if \(isWebUrl\(href\)\) elChild\.setAttribute\('href', href\)[\s\S]{0,80}else \{ walk\(elChild\); while \(elChild\.firstChild\)/.test(render),
  'render.ts: an anchor with a non-web href is unwrapped to its text, not kept without href')
const present = read('slides/src/present.ts')
ok(/window\.open\(url, '_blank', 'noopener,noreferrer'\)/.test(present), 'present.ts opens a NEW tab with noopener,noreferrer')
ok(/const openWeb = \(url: string\) => \{\s*if \(offlineEnabled\(\)\)/.test(present), 'present.ts honours the offline switch before opening')
ok(/closest<HTMLAnchorElement>\('a\[href\]'\)[\s\S]{0,200}ev\.preventDefault\(\)[\s\S]{0,200}if \(isWebUrl\(href\)\) openWeb\(href\)/.test(present),
  'present.ts intercepts anchors inside text: preventDefault always, open only a web URL')
ok(/const link = target\.dataset\.link \?\? ''\s*if \(isWebUrl\(link\)\)/.test(present), 'present.ts: an element link that is a web URL opens; a slide id still jumps')
ok(/closest\('a\[href\]'\)\) ev\.preventDefault\(\)/.test(read('slides/src/editor/canvas.ts')), 'canvas.ts: a link click in the editor never navigates')
ok(/addEventListener\('auxclick'[\s\S]{0,300}ev\.preventDefault\(\)[\s\S]{0,200}if \(isWebUrl\(href\)\) openWeb\(href\)/.test(present),
  'present.ts: a middle-click on an anchor goes through the same door (auxclick would otherwise bypass the offline gate and noreferrer)')
// Behavioural, not a regex over the source: the gate is bundled (it is not
// node-importable unbundled) and fed a web URL, a slide id and a javascript:
// URL. #488 wrapped every check in schema metadata and the old source pin
// broke while the behaviour did not — a pin on the source proves nothing.
{
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'links-gate-'))
  const entry = join(dir, 'probe.ts')
  writeFileSync(entry, `
    import { sanitizeElement } from '${join(root, 'slides/src/untrusted.ts').replace(/\\/g, '/')}'
    const el = (link: string) => ({ id: 'e', type: 'text', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1, html: 'x', fontSize: 20, link })
    const out = ['https://example.org/a', 's2', 'javascript:alert(1)', 'data:text/html,x'].map((l) => (sanitizeElement(el(l)) as { link?: string } | null)?.link ?? null)
    console.log(JSON.stringify(out))
  `)
  const bundle = join(dir, 'probe.mjs')
  execFileSync(join(root, 'slides/node_modules/.bin/esbuild'), [entry, '--bundle', '--platform=node', '--format=esm', '--log-level=error', `--outfile=${bundle}`])
  const got = JSON.parse(execFileSync(process.execPath, [bundle], { encoding: 'utf8' }).trim()) as (string | null)[]
  rmSync(dir, { recursive: true, force: true })
  ok(got[0] === 'https://example.org/a', 'the gate keeps a web link')
  ok(got[1] === 's2', 'the gate keeps a slide-id link')
  // A non-web link is a slide id: the gate keeps the string, and present.ts
  // only ever looks it up as a slide — javascript:/data: are never opened
  // (asserted on the present side below). What matters here is that the gate
  // does not turn them into web links.
  ok(got[2] !== null && !isWebUrl(got[2]) && got[3] !== null && !isWebUrl(got[3]), 'the gate keeps javascript:/data: only as slide-id text, never as a web link')
}
ok(!/target="_blank"|rel="noopener"/.test(render), 'render.ts stores no target/rel — those are decided at click time, never in the document')
ok(/querySelectorAll<HTMLAnchorElement>\('a\[href\]'\)\)\) a\.rel = 'noopener noreferrer'/.test(present),
  'present.ts sets rel at MOUNT on show anchors — the context-menu and drag routes, which bypass the click handler, then send no referrer')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
