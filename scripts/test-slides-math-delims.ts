#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Where formulas are found in a text box: the four delimiters, display maths
// across line breaks, and the editor's "not rendered" hint (#540).
//
//   node scripts/test-slides-math-delims.ts
//
// WHAT THIS PROVES. 1.2.0 read only `$…$` and `$$…$$`, and only inside one
// text run, so three things a reporter pasted stayed raw:
//   - `\(…\)` and `\[…\]`, the delimiters ChatGPT, Claude and most Markdown
//     emit;
//   - a `$$ … $$` typed over several lines — Enter in a text box puts <br> or
//     <div> between the lines, and the formula was never one text run;
//   - and nothing told the author WHY a formula stayed raw.
// slides/src/maths/delimiters.ts is DOM-free, so this drives the code render.ts
// runs, with the real engine behind it. The #465 guarantee (a formula never
// enters or crosses a tag other than a line break) is re-proved here for the
// new forms; test-slides-math-href.ts keeps the original cases.
//
// The paste and commit paths are here too: markdown's escape stripping and
// emphasis rules must not reach inside a formula, or `\_` (LaTeX's literal
// underscore) lost its backslash when the text box was committed.

import { resolveMathHtml } from '../slides/src/maths/delimiters.ts'
import { renderMath, mathError } from '../slides/src/maths/index.ts'
import { markdownToHtml, stripMarkerEscapes } from '../slides/src/editor/markdown.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const engine = (src: string, display: boolean) => renderMath(src, { display })
const hint = (src: string, display: boolean, spaced?: boolean) =>
  spaced ? 'Not rendered: spaces' : ((why) => (why ? `Not rendered: ${why}` : null))(mathError(src, { display }))
const resolve = (html: string) => resolveMathHtml(html, engine)
const hinted = (html: string) => resolveMathHtml(html, engine, hint)
const inline = (src: string) => renderMath(src, { display: false })!
const display = (src: string) => renderMath(src, { display: true })!
const maths = (html: string) => (html.match(/<math\b/g) ?? []).length

console.log('the four delimiters\n')
ok(resolve('area \\(\\pi r^2\\) here') === `area ${inline('\\pi r^2')} here`, '\\(…\\) is inline maths')
ok(resolve('\\[\\int_0^1 x\\,dx\\]') === display('\\int_0^1 x\\,dx'), '\\[…\\] is display maths')
ok(resolve('$x^2$ and $$y^2$$') === `${inline('x^2')} and ${display('y^2')}`, '$…$ and $$…$$ as before')
ok(resolve('\\(a\\)\\(b\\)') === inline('a') + inline('b'), 'two \\(…\\) back to back both render')
ok(resolve('\\(a\\) costs $5') === `${inline('a')} costs $5`, 'a lone price beside a formula stays a price')
ok(resolve('\\[ \\sum_{i=1}^n i \\]') === display(' \\sum_{i=1}^n i '), 'spaces inside \\[ \\] are fine — only $…$ is fussy')

console.log('\nescapes stay literal\n')
ok(resolve('\\\\(x\\\\)') === '\\(x\\)', '\\\\( … \\\\) shows \\( … \\) as typed')
ok(resolve('\\\\[x\\\\]') === '\\[x\\]', '\\\\[ … \\\\] shows \\[ … \\]')
ok(resolve('\\$x\\$') === '$x$', '\\$ is a dollar, as before')
ok(resolve('\\(\\$5\\)') === inline('\\$5'), 'an escaped dollar inside \\(…\\) is the formula\'s own')

console.log('\nprose stays prose\n')
ok(resolve('it costs $5 and $10') === 'it costs $5 and $10', '"$5 and $10" is not a formula')
ok(resolve('$ x^2 $') === '$ x^2 $', '$ x^2 $ with spaces inside stays prose, by design')
ok(resolve('(see note) [1]') === '(see note) [1]', 'plain parentheses and brackets are untouched')
ok(resolve('a\\(b') === 'a\\(b', 'an unclosed \\( is left as typed')

console.log('\nnever inside a tag (#465)\n')
const link = '<a href="https://x.example/\\(a\\)$b$">link</a>'
ok(resolve(link) === link, 'delimiters of every kind inside an href are untouched')
ok(resolve(`${link} and \\(x\\)`) === `${link} and ${inline('x')}`, 'a formula beside the link renders; the href is whole')
ok(resolve('<img alt="\\[x\\]">') === '<img alt="\\[x\\]">', 'any attribute, not just href')
ok(resolve('\\(a <b>b\\)</b>') === '\\(a <b>b\\)</b>', 'an inline pair split by a tag does not pair')
ok(resolve('$$a <b>b</b> c$$') === '$$a <b>b</b> c$$', 'a display pair split by a tag that is not a line break does not pair')

console.log('\ndisplay maths across line breaks\n')
const two = display('a = b\n+ c')
ok(resolve('$$a = b<br>+ c$$') === two, '$$ … <br> … $$ joins the lines and renders once')
ok(resolve('\\[a = b<br>+ c\\]') === two, '\\[ … <br> … \\] too')
ok(resolve('x<div>$$a = b</div><div>+ c$$</div>') === `x<div><div>${two}</div></div>`, 'across <div> lines: the swallowed tags are put back balanced around the formula')
ok(resolve('<p>$$a = b</p><p>+ c$$</p>') === `<p><p>${two}</p></p>`, 'across <p> lines')
ok(resolve('$$\\begin{aligned} a &= b \\\\<br> c &= d \\end{aligned}$$') === display('\\begin{aligned} a &= b \\\\\n c &= d \\end{aligned}'), 'an aligned block typed one row per line')
ok(resolve('before $$a<br>b$$ after $x$') === `before ${display('a\nb')} after ${inline('x')}`, 'text before and after a spanned formula carries on, and later formulas still render')
ok(resolve('$$a<b>b</b><br>c$$') === '$$a<b>b</b><br>c$$', 'a span meeting any other tag stays raw — a formula never crosses <b>')
ok(resolve('$$a<div>b</p>c$$') === '$$a<div>b</p>c$$', '<div> and <p> are never mixed in one span')
ok(resolve('$$a<br>b') === '$$a<br>b', 'an opener with no closer is left as typed')
ok(resolve('$$a$$<br>$$b$$') === `${display('a')}<br>${display('b')}`, 'two one-line formulas are not mistaken for one span')
ok(resolve('$$\\foo<br>b$$') === '$$\\foo<br>b$$', 'a span that does not render is left as typed')

console.log('\nthe editor hint\n')
ok(resolve('$\\foo$') === '$\\foo$' && maths(resolve('$\\foo$')) === 0, 'without a hint function nothing is marked — thumbnails, present, print, the static preview')
ok(hinted('$\\foo x$') === '<span class="bento-math-miss" title="Not rendered: \\foo">$\\foo x$</span>', 'an unknown command is named in the title, the text stays as typed')
ok(hinted('\\(\\bar{\\foo}\\)').includes('title="Not rendered: \\foo"'), 'the FIRST unknown command')
ok(hinted('\\[a^{b\\]').includes('class="bento-math-miss"'), 'a \\[…\\] that fails is marked')
ok(hinted('$ x^2 $') === '<span class="bento-math-miss" title="Not rendered: spaces">$ x^2 $</span>', '$ x^2 $ is marked with the spaces reason')
ok(hinted('it costs $5 and $10') === 'it costs $5 and $10', 'prices are never marked')
ok(hinted('a $b c$ d') === resolve('a $b c$ d'), 'a formula that renders is not marked')
ok(hinted('$x} and {y$') === '$x} and {y$', 'a failed $…$ that does not look like maths (no \\, ^ or _) is not marked')
ok(hinted('<a href="$\\foo$">x</a>') === '<a href="$\\foo$">x</a>', 'no hint inside an attribute')
ok(hinted('\\(\\foo "x"\\)').includes('>\\(\\foo "x"\\)</span>') && !/title="[^"]*"x"/.test(hinted('\\(\\foo "x"\\)')), 'the title is escaped')
ok(hinted('$$\\foo$$ then $x$') === `<span class="bento-math-miss" title="Not rendered: \\foo">$$\\foo$$</span> then ${inline('x')}`, 'a marked miss is closed off: its dollars never pair with a later one')

console.log('\npaste and commit keep backslashes in formulas\n')
ok(stripMarkerEscapes('\\*not bold\\*') === '*not bold*', 'outside a formula a markdown escape still drops its backslash')
ok(stripMarkerEscapes('$\\text{a\\_b}$ and \\_') === '$\\text{a\\_b}$ and _', 'inside $…$ the \\_ is LaTeX and keeps it')
ok(stripMarkerEscapes('\\(a\\_b\\) \\[c\\*\\]') === '\\(a\\_b\\) \\[c\\*\\]', 'inside \\(…\\) and \\[…\\] too')
ok(markdownToHtml('\\(x^* + y^*\\)') === '\\(x^* + y^*\\)', 'a pasted formula is not read as emphasis')
ok(markdownToHtml('see \\(\\frac{a}{b}\\) and $a\\_1$') === 'see \\(\\frac{a}{b}\\) and $a\\_1$', 'pasted \\( and \\_ keep their backslashes')
ok(markdownToHtml('$a < b$ **bold**') === '$a &lt; b$ <b>bold</b>', 'a parked formula is still HTML-escaped, and markdown outside it still works')
ok(resolve(markdownToHtml('\\[\\sum_i x_i\\]')) === display('\\sum_i x_i'), 'pasted, then rendered: the whole round trip')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
