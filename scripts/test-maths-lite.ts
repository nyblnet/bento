#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Bento's maths engine (slides/src/maths): its contract, DOM-free.
//
//   node scripts/test-maths-lite.ts
//
// WHAT THIS PROVES. Every formula of the reference set (11 from our own decks
// and rigs, 80 from the categories of Temml's supported-functions page)
// parses; a refused formula returns null rather than throwing (the
// never-throws contract render.ts relies on); the engine's NORMALISED MathML
// tree matches the tree Temml produced for the same formula on >=95% of the
// set -- Temml's trees were frozen into scripts/fixtures/maths-reference.json
// on the day it left the shell (scripts/maths-freeze-reference.ts), and every
// mismatch must be on the explicit residual list, so a printer change that
// moves a glyph goes red here rather than on a slide; the Typst front end and
// the LaTeX front end agree on the shared tree for the equivalence table;
// the emitter constructs every attribute itself (no href, no handlers, no
// author style -- the trust:false Temml ran with is structural here); the
// symbol table has no duplicate LaTeX names; every styled letter is a real
// Mathematical Alphanumeric code point (Chrome ignores mathvariant).
//
// Pixels stay out of CI: the spike measured 97.8% visually identical against
// Temml in Chrome (docs/DECISIONS.md, 2026-09-15), and there is no Temml in
// the tree any more to draw the other side.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { renderMath, parseMath, isTypst, stripMarker } from '../slides/src/maths/index.ts'
import { SYMBOLS, styledChar } from '../slides/src/maths/symbols.ts'
import { treeKey } from './lib/mathml-tree.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

console.log('the never-throws contract\n')
ok(renderMath('\\frac{a}{b}') !== null, '\\frac{a}{b} renders')
ok(renderMath('\\frac{a}') === null, 'a broken fraction → null, no throw')
ok(renderMath('\\nosuchcommand x') === null, 'an unknown command → null')
ok(renderMath('x = \\frac{…}') === null, 'the canvas placeholder hint (\\frac{…} with one arg) → null, as Temml refused it')
ok(renderMath('a/b', { syntax: 'typst' }) !== null && renderMath('mat(1, 2; 3', { syntax: 'typst' }) === null, 'typst: valid renders, unterminated → null')
ok(renderMath('') === null || renderMath('') === '<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow></mrow></math>', 'empty input does not throw')

console.log('\nthe reference set, against the frozen Temml trees\n')
type Ref = { src: string; display: boolean; from: string; tree: string | null }
const reference = JSON.parse(readFileSync(join(root, 'scripts/fixtures/maths-reference.json'), 'utf8')) as { temml: string; frozen: string; formulas: Ref[] }
ok(reference.formulas.length === 91 && reference.temml === '0.13.3', `the reference is the spike's 91-formula set, frozen from Temml ${reference.temml} on ${reference.frozen}`)
const corpus = reference.formulas.filter((f) => f.from.startsWith('corpus:') && !f.src.includes('…'))
ok(corpus.length >= 9 && corpus.every((c) => renderMath(c.src, { display: c.display }) !== null), `every formula our decks and rigs carry renders (${corpus.length})`)
// Known residuals -- each one a place where Temml's tree is NOT what we want:
// menclose is blank on Chrome (we draw the rule), and one extra mrow level
// with 0.0% pixel difference. Anything else that differs is a regression.
const RESIDUAL = new Set(['\\overline{AB}', '\\underline{x}', '\\sigma(z)_i = \\frac{e^{z_i}}{\\sum_{j=1}^K e^{z_j}}'])
let both = 0, same = 0
const unexpected: string[] = []
for (const f of reference.formulas) {
  const lite = renderMath(f.src, { display: f.display })
  const key = lite ? treeKey(lite) : null
  if (!f.tree || !key) { if (!!f.tree !== !!key) unexpected.push(`${f.src} (temml ${!!f.tree}, ours ${!!key})`); continue }
  both++
  if (key === f.tree) same++
  else if (!RESIDUAL.has(f.src)) unexpected.push(f.src)
}
ok(both === 89, '89 formulas render in both (the two refused are the canvas placeholder hint, refused by both)')
ok(same / both >= 0.95, `>=95% identical normalised trees: ${same}/${both} = ${(100 * same / both).toFixed(1)}%`)
ok(unexpected.length === 0, `every mismatch is a listed residual -- unexpected: ${unexpected.join(' · ') || 'none'}`)
ok(both - same === RESIDUAL.size, `and every listed residual still differs (${both - same} of ${RESIDUAL.size}) -- remove one from the list when it is closed`)

console.log('\nMathML shape\n')
const q = renderMath('x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', { display: true })!
ok(q.startsWith('<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">'), 'display mode sets display="block"')
ok(/<mfrac><mrow><mo>−<\/mo><mi>b<\/mi><mo>±<\/mo><msqrt>/.test(q), 'the quadratic formula: minus is U+2212, ± from the table, the root is msqrt')
ok(/<msup><mi>b<\/mi><mn>2<\/mn><\/msup>/.test(q), 'b^2 is msup with an mn')
ok(renderMath('\\sum_{i=1}^n', { display: true })!.includes('<munderover>'), 'display-mode sum takes under/over limits')
ok(renderMath('\\sum_{i=1}^n')!.includes('<msubsup>'), 'inline sum keeps side scripts')
ok(renderMath('\\int_0^1', { display: true })!.includes('<msubsup>'), 'an integral keeps side limits even in display mode (TeX default)')
ok(renderMath('\\mathbb{R}')!.includes('ℝ') && renderMath('\\mathbb{A}')!.includes('𝔸'), '\\mathbb becomes code points: ℝ from the Letterlike block, 𝔸 from the Mathematical Alphanumerics')
ok(renderMath('\\mathcal{L}')!.includes('ℒ') && renderMath('\\mathfrak{g}')!.includes('𝔤'), 'cal and frak likewise')
ok(renderMath('\\text{if } x')!.includes('<mtext>if\u00a0</mtext>'), '\\text keeps its trailing space as a no-break space')
ok(renderMath('\\textcolor{red}{x}')!.includes('style="color:red"'), '\\textcolor → colour style')
ok(renderMath('\\boxed{x}')!.includes('border:'), '\\boxed → border emulation')
ok(renderMath('\\left( x \\right)')!.includes('<mo fence="true" form="prefix" stretchy="true">(</mo>'), '\\left( is a stretchy fence')
ok(renderMath('f(x)')!.includes('form="prefix"'), 'a bare ( says it is a prefix fence (no infix spacing)')
ok(renderMath('\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}')!.match(/<mtr>/g)!.length === 2, 'pmatrix: two rows')
ok(renderMath('\\begin{cases} a & b \\\\ c & d \\end{cases}')!.includes('<mo fence="true" form="prefix" stretchy="true">{</mo>'), 'cases: a left brace only')
ok(renderMath('\\sin x')!.includes('\u2061'), 'function application after \\sin')

console.log('\nround 2: the divergences closed against Temml (each was a measured miss)\n')
ok(renderMath('A \\mid B')!.includes('<mo lspace="0.22em" rspace="0.22em" stretchy="false">|</mo>'), '\\mid is a bar with relation spacing')
ok(renderMath('a\\!b')!.includes('<mrow style="margin-left:-0.1667em;"></mrow>'), '\\! is a negative margin, not a negative mspace')
ok(!renderMath('\\operatorname{sinc}(x)')!.includes('<mspace'), 'no thin space between a function name and a paren group')
ok(renderMath('\\sin x')!.includes('\u2061</mo><mspace width="0.1667em"></mspace><mi>x</mi>'), '…but a thin space before a bare operand')
ok(renderMath('\\Delta x')!.includes('<mi mathvariant="normal">Δ</mi>'), 'Greek capitals are upright')
ok(renderMath('\\alpha')!.includes('<mi>α</mi>'), 'Greek lowercase stays italic')
ok(renderMath("f''")!.includes('<msup><mi>f</mi><mrow><mo lspace="0em" rspace="0em">′</mo><mo lspace="0em" rspace="0em">′</mo></mrow></msup>'), 'primes: one mo each, no spacing, grouped')
ok(renderMath('a \\iff b')!.includes('<mspace width="0.2778em"></mspace><mo>⟺</mo><mspace width="0.2778em"></mspace>'), '\\iff carries a thick space each side')
ok(renderMath('a <==> b', { syntax: 'typst' }) === renderMath('a \\iff b'), 'typst <==> is the same node')
ok(renderMath('\\boxed{E}')!.includes('style="padding:3pt;border:1px solid"'), "\\boxed uses Temml's metric")
ok(renderMath('\\forall x')!.includes('<mi>∀</mi>'), '\\forall / \\exists are identifiers')
ok(renderMath('\\nabla \\cdot v')!.includes('<mo>∇</mo><mo form="prefix" stretchy="false">⋅</mo>'), 'an operator after an operator is prefix (no left space)')
ok(renderMath('a + \\cdots + b')!.includes('<mo>+</mo><mo>⋯</mo><mo>+</mo>'), '…but not after dots: + ⋯ + keeps its spacing')
ok(renderMath('\\sigma(z)_i')!.includes('<msub><mrow><mo fence="true" form="prefix" stretchy="false">(</mo><mi>z</mi><mo fence="true" form="postfix" stretchy="false">)</mo></mrow><mi>i</mi></msub>'), 'a paren group is one node: the script attaches to the group, as Temml and Typst do')
ok(renderMath('\\left( x \\right)')!.includes('<mo fence="true" form="prefix" stretchy="true">(</mo>'), '\\left( says fence/form as well as stretchy')
ok(renderMath('\\begin{cases} a & b \\\\ c & d \\end{cases}')!.includes('<mtd style="padding-left:1em;padding-right:0em">'), "cases: 1em before the condition column, columns CENTRED (Temml-in-Bento look, the maintainer's choice)")
ok(renderMath('\\begin{aligned} a &= b \\end{aligned}')!.includes('<mtable displaystyle="true">') && renderMath('\\begin{aligned} a &= b \\end{aligned}')!.includes('<mtd style="padding-left:0em;padding-right:0em">'), 'aligned: display style, no column padding, columns centred')
ok(!/text-align|columnalign/.test(renderMath('\\begin{cases} a & b \\end{cases}')!), 'no cell says an alignment — centred is the default, as Temml renders in Bento today')
ok(renderMath('\\vec{v}')!.includes('<mo stretchy="false">→</mo>') && renderMath('\\hat{x}')!.includes('style="math-depth:0"'), "\\vec shrinks to script size, \\hat stays full — Temml's look")
ok(renderMath('\\overrightarrow{AB}')!.includes('stretchy="true" style="math-depth:0"'), 'a stretchy arrow accent stays full size')
ok(renderMath('\\overline{AB}')!.includes('<mover><mrow><mi>A</mi><mi>B</mi></mrow><mo stretchy="true" style="math-depth:0">‾</mo></mover>'), "\\overline draws a stretchy rule (Temml's menclose is blank on Chrome — kept ours)")
ok(renderMath('\\binom{n}{k}')!.includes('stretchy="true">(</mo><mfrac linethickness="0">'), 'binom parens stretch')
ok(renderMath('\\int_0^1', { display: true })!.includes('<msubsup>'), 'integrals keep side limits in display mode')
ok(renderMath('\\begin{pmatrix} a \\\\ b \\end{pmatrix}')!.includes('<mtd style="padding-left:0em;padding-right:0em">'), 'a centred cell says nothing about alignment (the 2 px that kept matrices off Temml)')

console.log('\nround 3: Typst function application is tight (byte-identical to LaTeX)\n')
for (const [ty, tex] of [['f(x) = cases(x & x >= 0, -x & x < 0)', 'f(x) = \\begin{cases} x & x \\ge 0 \\\\ -x & x < 0 \\end{cases}'], ['g(x, y)', 'g(x, y)'], ['sin(x)', '\\sin(x)'], ['f(x)_i', 'f(x)_i']] as const)
  ok(renderMath(ty, { syntax: 'typst', display: true }) === renderMath(tex, { display: true }), `typst \`${ty}\` is byte-identical to latex \`${tex}\` — no gap around the group`)
ok(renderMath('f(x)', { syntax: 'typst' })!.includes('<mo fence="true" form="prefix" stretchy="false">('), 'a plain Typst group is the tight, non-stretchy paren')
ok(renderMath('(a/b)', { syntax: 'typst' })!.includes('<mo fence="true" form="prefix" stretchy="true">('), 'a group around a fraction stretches (Typst sizes to content)')

console.log('\nthe syntax marker (decided: $typst: …$)\n')
ok(isTypst('typst: a/b') && isTypst('typst:a/b'), 'typst: at the start, with or without a space')
ok(!isTypst(' typst: a/b') && !isTypst('Typst: a/b') && !isTypst('TYPST: a/b'), 'not after whitespace, not another case')
ok(!isTypst('a typst: b') && !isTypst('\\frac{typst:}{b}'), 'not anywhere else in the formula')
ok(stripMarker('typst:  a/b') === 'a/b' && stripMarker('\\frac{a}{b}') === '\\frac{a}{b}', 'stripMarker removes exactly the marker')
const render = readFileSync(join(root, 'slides/src/render.ts'), 'utf8')
ok(/const m = \/\^typst:\\s\*\/\.exec\(tex\)/.test(render), 'render.ts applies the exact marker (case-sensitive, at the start)')
ok(!/temml/i.test(render.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')), 'render.ts imports nothing from temml -- the engine is ours')
ok(!/"temml"/.test(readFileSync(join(root, 'slides/package.json'), 'utf8')), 'temml is not a dependency of slides any more')

console.log('\ntrust: every attribute is ours\n')
const attrsOf = (html: string) => [...html.matchAll(/\s([a-zA-Z-]+)="/g)].map((m) => m[1])
const ALLOWED = new Set(['xmlns', 'display', 'mathvariant', 'stretchy', 'fence', 'form', 'lspace', 'rspace', 'style', 'linethickness', 'displaystyle', 'accent', 'width', 'minsize', 'maxsize', 'separator', 'symmetric', 'largeop', 'movablelimits', 'columnalign', 'rowspacing', 'columnspacing', 'scriptlevel', 'height', 'depth', 'voffset', 'mathcolor', 'mathbackground', 'columnlines', 'rowlines', 'frame', 'notation', 'accentunder'])
for (const src of ['\\href{javascript:alert(1)}{x}', 'x" onload="alert(1)', '<img src=x onerror=alert(1)>', '\\text{<script>1</script>}', '\\textcolor{red;background:url(x)}{y}', '\\textcolor{url(javascript:1)}{y}', '\\mathrm{a} onclick=1']) {
  const out = renderMath(src) ?? renderMath(src, { syntax: 'typst' }) ?? ''
  ok(!/<script|onload|onerror|onclick|javascript:|url\(/i.test(out) && attrsOf(out).every((a) => ALLOWED.has(a)), `no author-controlled attribute or tag survives: ${JSON.stringify(src)} -> ${out ? out.slice(0, 60) + '…' : 'refused'}`)
}
ok(renderMath('\\textcolor{#ff0000}{x}')!.includes('style="color:#ff0000"') && renderMath('\\textcolor{rebeccapurple}{x}')!.includes('color:rebeccapurple'), '\\textcolor takes a hex or a named colour')
// The style VALUE, not just the attribute name: every style="…" the emitter
// can produce is one of its own constant forms, or `color:` + a value of the
// colour shape isCssColor admits — one declaration, no `;`, no `(` outside
// rgb/hsl. A loosened isCssColor that lets a `;` through goes red here.
const STYLE_FORMS = [
  /^margin-left:-?[\d.]+em;$/, /^math-depth:0$/,
  /^padding-left:(0|1)em;padding-right:0em$/, /^padding-left:(0em|5\.9776pt);padding-right:(0em|5\.9776pt)$/,
]
const COLOR_SHAPE = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|(rgba?|hsla?)\([\d.%,\s/]+\))$/i
const styleOk = (v: string) => STYLE_FORMS.some((re) => re.test(v)) || v.split(';').every((d) => d === 'padding:3pt' || d === 'border:1px solid' || d.startsWith('background:linear-gradient(to top right,transparent 47%,currentColor 47%,currentColor 53%,transparent 53%)') || (d.startsWith('color:') && COLOR_SHAPE.test(d.slice(6))))
const styleValues = (html: string) => [...html.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1])
const STYLE_PROBES = ['\\textcolor{red}{x}', '\\textcolor{#abc}{x}', '\\textcolor{rgb(1, 2, 3)}{x}', '\\boxed{\\textcolor{blue}{y}}', '\\cancel{x}', 'a\\!b', '\\hat{x}', '\\begin{cases} a & b \\\\ c & d \\end{cases}', '\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}', '\\begin{aligned} a &= b \\end{aligned}',
  '\\textcolor{red;position:fixed}{x}', '\\textcolor{red;font-size:900px}{x}', '\\textcolor{red}{x};background:url(x)', '\\textcolor{expression(1)}{x}', '\\textcolor{var(--x)}{x}', '\\textcolor{rgb(1,2,3);color:red}{x}']
for (const src of STYLE_PROBES) {
  const out = renderMath(src) ?? ''
  const vals = styleValues(out)
  ok(vals.every(styleOk), `every style value is a known form or a bare colour: ${JSON.stringify(src)} → ${JSON.stringify(vals)}`)
}
ok(!(renderMath('\\textcolor{red;position:fixed}{x}') ?? '').includes('style='), 'a colour carrying a `;` declaration is dropped entirely — no style at all')
ok(!(renderMath('\\textcolor{red;font-size:9px}{x}') ?? '').includes('font-size'), 'a `;`-declaration without url( is refused too')
ok(renderMath('\\text{a"b}')!.includes('a&quot;b') && !/<mtext>[^<]*"/.test(renderMath('\\text{a"b}')!), 'a `"` in text is escaped to &quot; (no text may ever end an attribute)')
ok(renderMath('"a<b>c"', { syntax: 'typst' })!.includes('&lt;b&gt;'), 'typst quoted text escapes too')

console.log('\nTypst ≡ LaTeX on the shared tree\n')
const pairs: Array<[string, string]> = [['a/b', '\\frac{a}{b}'], ['(a+b)/c', '\\frac{a+b}{c}'], ['sqrt(2)', '\\sqrt{2}'], ['root(3, x)', '\\sqrt[3]{x}'], ['x^(n+1)', 'x^{n+1}'], ['sum_(i=1)^n i', '\\sum_{i=1}^{n} i'], ['mat(a, b; c, d)', '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}'], ['cases(x & x >= 0, -x & x < 0)', '\\begin{cases} x & x \\ge 0 \\\\ -x & x < 0 \\end{cases}'], ['bb(R)', '\\mathbb{R}'], ['hat(x)', '\\hat{x}'], ['alpha + beta', '\\alpha + \\beta'], ['a <= b != c', 'a \\le b \\ne c'], ['"if" x', '\\text{if} x'], ['lim_(x -> oo) f', '\\lim_{x \\to \\infty} f']]
for (const [ty, tex] of pairs) ok(renderMath(ty, { syntax: 'typst', display: true }) === renderMath(tex, { display: true }), `typst \`${ty}\` ≡ latex \`${tex}\``)
// Round 2 closed the one difference there was: a LaTeX paren group is now
// ONE node too (as Temml prints it), so f(x)_i scripts the group in both.
const noExplicit = (k: string, v: unknown) => (k === 'explicit' ? undefined : v) // Typst sizes its groups (\\left-like); the STRUCTURE is what must agree
ok(JSON.stringify(parseMath('f(x)_i', { syntax: 'typst' }), noExplicit) === JSON.stringify(parseMath('f(x)_i'), noExplicit), 'f(x)_i: both front ends script the paren group')

console.log('\nthe formula cache is bounded\n')
ok(/const MATH_CACHE_MAX = 256/.test(render) && /if \(mathCache\.size > MATH_CACHE_MAX\) mathCache\.delete\(mathCache\.keys\(\)\.next\(\)\.value!\)/.test(render), 'a 256-entry LRU: the oldest key is evicted past the cap')
ok(/mathCache\.delete\(key\); mathCache\.set\(key, hit\)/.test(render), 'a hit is re-inserted so it becomes the newest (Map insertion order = LRU)')

console.log('\nmorph: the engine gives the morph nothing new to handle\n')
// present.ts pairs elements by data-flip-id and tweens the ELEMENT box; the
// <math> inside rides along, exactly as Temml's did. DOM-free, that reduces
// to: the same source renders to the same string on every call (the cache
// key is display+source), so the paired elements carry identical MathML and
// nothing about the engine can make a pair diverge. Measured live in Chrome
// (PR body, "Morph"): both engines gave the same rects at every sample.
ok(renderMath('\\frac{a}{b}') === renderMath('\\frac{a}{b}') && renderMath('\\frac{a}{b}', { display: true }) !== renderMath('\\frac{a}{b}'), 'same source → same string; display mode is part of the identity')
ok(renderMath('a^2')!.startsWith('<math ') && renderMath('a^2 + b^2')!.startsWith('<math '), 'a changed formula is still a <math> — the box morphs, the content snaps')
ok(!/\son[a-z]+=|\sid=|<script/i.test(renderMath('x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}')!), 'no ids or handlers that a flip pairing could collide on')

console.log('\nthe symbol table\n')
const texNames = SYMBOLS.map((s) => s.tex)
ok(new Set(texNames).size === texNames.length, `no duplicate LaTeX names (${texNames.length} rows)`)
ok(SYMBOLS.every((s) => [...s.cp].length >= 1 && s.typst.length > 0), 'every row has a glyph and a Typst name')
ok(styledChar('R', 'bb') === 'ℝ' && styledChar('a', 'bb') === '𝕒' && styledChar('7', 'bb') === '𝟟', 'styledChar: holes patched, lowercase and digits from the block')
ok(styledChar('x', 'rm') === 'x' && styledChar('!', 'bf') === '!', 'rm and non-letters pass through')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
