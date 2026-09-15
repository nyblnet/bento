#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Maths in links: resolveMath transforms TEXT RUNS only.
//
//   node scripts/test-slides-math-href.ts
//
// WHAT THIS PROVES. The sanitized HTML that reaches resolveMath can carry a
// `$` inside an attribute — a web link's href (#465). Since links arrived,
// `<a href="https://x.example/$a$b">` had its two dollars paired as an inline
// formula and a <math> written into the attribute: the xmlns quote ended the
// href and the `>` closed the tag — a dead link plus stray markup. Nothing an
// author chose became an attribute (the sanitizer had already run), so it was
// an integrity bug, not a hole. render.ts now splits on tags and transforms
// only the non-tag parts, so a `$` in a tag never pairs with anything, and a
// pair split across a tag boundary does not pair either. The split itself is
// re-applied here to the same rules; the Chrome measurement (PR body) showed
// the link intact and clickable with `$x^2$` rendering beside it.
//
// render.ts is not node-importable (DOM), so the rig holds the SOURCE to the
// split and drives the split's behaviour with the same regexes.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const render = readFileSync(join(root, 'slides/src/render.ts'), 'utf8')

console.log('the source\n')
const rm = render.slice(render.indexOf('export function resolveMath'), render.indexOf('export function resolveMath') + 1600)
ok(/html\.split\(\/\(<\[\^>\]\*>\)\/\)\.map\(\(part, i\) => \(i % 2 \? part : resolveMathText\(part\)\)\)\.join\(''\)/.test(rm), 'resolveMath splits on tags and hands only the text runs to resolveMathText')
ok(/function resolveMathText\(text: string\)/.test(render), 'the $$/$ rules live on the text-run function')
ok(!/html\.replace\(\/\(\^\|\[\^\\\\\]\)\\\$\\\$/.test(rm), 'no rule runs over the whole HTML any more')
ok(/\$\$…\$\$ first \(display\), then \$…\$ \(inline\)/.test(rm), 'the fussy inline rule is unchanged (no whitespace inside, no digit after)')

console.log('\nthe behaviour, with the same split and a stand-in renderer\n')
// the stand-in: any source becomes a <math> stub — what matters is WHERE the
// rules are allowed to look, not what the engine prints
const stub = (src: string) => `<math>${src}</math>`
const text = (t: string) => {
  let out = t.replace(/(^|[^\\])\$\$([^$]+?)\$\$/g, (_m, pre: string, src: string) => pre + stub(src))
  out = out.replace(/(^|[^\\$])\$(\S(?:[^$\n]*?\S)?)\$(?!\d)/g, (_m, pre: string, src: string) => pre + stub(src))
  return out.replace(/\\\$/g, '$')
}
const resolve = (html: string) => html.split(/(<[^>]*>)/).map((p, i) => (i % 2 ? p : text(p))).join('')

const link = '<a href="https://x.example/$a$b" rel="noopener">link</a>'
ok(resolve(link) === link, 'a $ pair inside an href is untouched — the link is intact')
ok(resolve('see <a href="https://x.example/$a$b">link</a> and $x^2$ after') === 'see <a href="https://x.example/$a$b">link</a> and <math>x^2</math> after', 'a formula in the text beside a link renders; the href is still whole')
ok(resolve('a $b <b>c$ d</b>') === 'a $b <b>c$ d</b>', 'a $ pair split across a tag boundary does not pair')
ok(resolve('<b>$x^2$</b>') === '<b><math>x^2</math></b>', 'a formula wholly inside a tag still renders')
ok(resolve('<a href="https://x.example/?q=$1">$5 off</a>') === '<a href="https://x.example/?q=$1">$5 off</a>', 'a $ in the href and a price in the link text never pair')
ok(resolve('$$\\frac{a}{b}$$ then <i>x</i>') === '<math>\\frac{a}{b}</math> then <i>x</i>', 'display maths before a tag renders')
ok(resolve('it costs $5 and $10') === 'it costs $5 and $10', 'prose with prices is still prose (the fussy rule, unchanged)')
ok(resolve('<img alt="$x$">') === '<img alt="$x$">', 'any attribute, not just href')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
