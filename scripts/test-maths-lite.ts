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
ok(reference.formulas.length === 152 && reference.temml === '0.13.3', `the reference is the spike's 91 formulas plus issue #540's 61, frozen from Temml ${reference.temml} on ${reference.frozen}`)
const corpus = reference.formulas.filter((f) => f.from.startsWith('corpus:') && !f.src.includes('…'))
ok(corpus.length >= 9 && corpus.every((c) => renderMath(c.src, { display: c.display }) !== null), `every formula our decks and rigs carry renders (${corpus.length})`)
// Known residuals -- each one a place where Temml's tree is NOT what we want:
// menclose is blank on Chrome (we draw the rule), and one extra mrow level
// with 0.0% pixel difference. Anything else that differs is a regression.
const RESIDUAL = new Set(['\\overline{AB}', '\\underline{x}', '\\sigma(z)_i = \\frac{e^{z_i}}{\\sum_{j=1}^K e^{z_j}}',
  // #540: Temml wraps a \mathop word as <mo><mi>Res</mi></mo>; ours is the
  // function-name <mi>, which spaces the same and is valid MathML
  '\\mathop{\\rm Res} f',
  // #540: Temml's multline is three columns with an equation-number <span>
  // in the third (its stylesheet, which Bento never loads, positions it);
  // ours is the one column of lines, centred like every Bento table
  '\\begin{multline} a + b \\\\ + c \\end{multline}'])
// Where maths-lite deliberately renders what Temml refused (#540): \vspace
// is dropped (a slide formula has no vertical flow to space), eqnarray is
// aligned like align, and \tag outside display mode is still a label
const BEYOND_TEMML = new Set(['a \\vspace{1em} b', '\\begin{eqnarray} a &=& b \\\\ c &=& d \\end{eqnarray}', 'a = b \\tag{1}'])
// DRAWN (#551): the arrows Chrome will not stretch (→ ↔ ↦ ↠ = ⇌ …) are an
// inline SVG sized by the layout, so their tree is a table (or a padded row)
// where Temml's is an mover — different on purpose, measured in Chrome. They
// are named here, must still carry the svg, and stay out of the percentage.
const DRAWN = new Set(['\\overrightarrow{AB}', 'A \\xrightarrow{f} B', 'A \\xleftrightarrow{h} B'])
let both = 0, same = 0
const unexpected: string[] = []
const drawnSeen: string[] = []
for (const f of reference.formulas) {
  const lite = renderMath(f.src, { display: f.display })
  const key = lite ? treeKey(lite) : null
  if (!f.tree || !key) { if (!!f.tree !== !!key && !(key && BEYOND_TEMML.has(f.src))) unexpected.push(`${f.src} (temml ${!!f.tree}, ours ${!!key})`); continue }
  if (DRAWN.has(f.src)) { if (lite!.includes('<svg role="img" aria-label=')) drawnSeen.push(f.src); continue }
  both++
  if (key === f.tree) same++
  else if (!RESIDUAL.has(f.src)) unexpected.push(f.src)
}
ok(both + DRAWN.size === 147, '147 formulas render in both (refused by both: the canvas placeholder hint, twice; three render only here — BEYOND_TEMML)')
ok(drawnSeen.length === DRAWN.size, `the drawn arrows are drawn (${drawnSeen.length}/${DRAWN.size}), out of the comparison on purpose`)
ok(same / both >= 0.95, `>=95% identical normalised trees: ${same}/${both} = ${(100 * same / both).toFixed(1)}%`)
ok(unexpected.length === 0, `every mismatch is a listed residual -- unexpected: ${unexpected.join(' · ') || 'none'}`)
ok(both - same === RESIDUAL.size, `and every listed residual still differs (${both - same} of ${RESIDUAL.size}) -- remove one from the list when it is closed`)

// THE HARD LIST (#540). The 95% gate let 57 commands Temml rendered fall
// back to raw text in 1.2.0 — a percentage cannot see a regression that is
// small against the whole set. Every formula here must render: one null and
// this goes red, whatever the percentage says.
const hard = JSON.parse(readFileSync(join(root, 'scripts/fixtures/maths-540.json'), 'utf8')) as { mustRender: string[] }
const nulls = hard.mustRender.filter((src) => renderMath(src, { display: /\\begin\{(multline|eqnarray)\}/.test(src) }) === null)
ok(hard.mustRender.length === 61 && nulls.length === 0, `every must-render formula renders (${hard.mustRender.length - nulls.length}/${hard.mustRender.length})${nulls.length ? ' — null: ' + nulls.join(' · ') : ''}`)
ok(hard.mustRender.every((src) => reference.formulas.some((f) => f.src === src)), 'and every one is in the frozen reference, so its tree is gated too')

console.log('\n#540: the shapes the new commands take\n')
ok(renderMath('\\frac12')!.includes('<mfrac><mn>1</mn><mn>2</mn></mfrac>') && renderMath('\\sqrt2')!.includes('<msqrt><mn>2</mn></msqrt>'), 'a macro argument is ONE token: \\frac12 is ½, \\sqrt2 is √2')
ok(renderMath('12')!.includes('<mn>12</mn>'), '…while 12 in a row stays the number twelve')
ok(renderMath('{a+1 \\over b}')!.includes('<mfrac><mrow><mi>a</mi><mo>+</mo><mn>1</mn></mrow><mi>b</mi></mfrac>'), '\\over splits the whole group')
ok(renderMath('n \\choose k')!.includes('stretchy="true">(</mo><mfrac linethickness="0">'), '\\choose is a binomial')
ok(renderMath('A \\xleftarrow[u]{o} B')!.includes('<munderover><mo stretchy="true" lspace="0em" rspace="0em">←</mo>'), '\\xleftarrow[under]{over} labels both sides (← stretches natively)')
// the last of Temml's vocabulary (#551)
const cd = renderMath('\\begin{CD} A @>f>> B \\\\ @VgVV @VVhV \\\\ C @>>k> D \\end{CD}', { display: true })!
ok(cd.startsWith('<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mtable displaystyle="true"><mtr>') && (cd.match(/aria-label="→"/g) ?? []).length === 2 && (cd.match(/>↓<\/mo>/g) ?? []).length === 2, 'CD: object rows interleave objects and drawn → arrows; the arrow row puts ↓ under each object')
ok(/<mi>A<\/mi><\/mtd><mtd[^>]*>.*<\/mtd><mtd[^>]*><mi>B<\/mi>/.test(cd) && /↓<\/mo>.*<\/mtd><mtd[^>]*><mrow><\/mrow><\/mtd><mtd/.test(cd), 'CD: A → B across; the vertical row leaves the arrow column empty')
ok(renderMath('a\\kern3pt b') === renderMath('a\\kern{3pt} b') && renderMath('a\\mskip4mu b') === renderMath('a\\mskip{4mu} b'), 'an unbraced dimension is read whole, as TeX does (\\kern3pt, \\mskip4mu)')
ok(!/<mi>m<\/mi><mi>u<\/mi>/.test(renderMath('\\vb{a} \\cp \\vb{b}')!) && !/<mi>m<\/mi><mi>u<\/mi>/.test(renderMath('\\curl f')!), '\\cp and \\curl leave no stray "mu"')
// mhchem (#551): \pu wraps unit LETTERS in \mathrm, and only then inserts
// \cdot and \mathord{/} — the other order wrapped the words "cdot" and
// "mathord" themselves and the formula fell back to raw text
const pu = renderMath('\\pu{1.2e3 kJ/mol} \\quad \\pu{3 kg.m/s}')!
ok(pu.includes('<mi mathvariant="normal">J</mi></mrow><mi>/</mi><mrow><mi mathvariant="normal">m</mi>') && pu.includes('<mo>⋅</mo>') && !/cdot|mathord|<mi[^>]*>[cm]<\/mi><mi[^>]*>[do]<\/mi><mi[^>]*>[ot]<\/mi>/.test(pu), '\\pu: units upright, a / and a ⋅ between them, no command name leaks into the text')
ok(renderMath('\\ce{CuSO4.5H2O}')!.includes('<mo>⋅</mo><mn>5</mn>'), '\\ce: the count after a hydrate dot is a number')
ok(renderMath('7\\longdiv{364}')!.includes('<mo stretchy="true">)</mo><mrow style="border-top:0.065em solid;padding-top:0.1em">'), '\\longdiv: a stretchy ) and a rule over the dividend')

// TABLE RULES (#551). The tree comparison drops `style` by design, so it
// could never see that maths-lite dropped array's | and \hline: Temml draws
// them as plain cell borders, which showed in Bento before 1.2.0 without its
// stylesheet, and every ruled array lost its lines in 1.2.0. These are the
// border declarations Temml 0.13.3 writes per cell (captured 2026-09-25),
// compared as sets so declaration order does not matter.
const borders = (html: string) => [...html.matchAll(/<mtd[^>]*style="([^"]*)"/g)].map((m) => m[1].split(';').filter((d) => d.startsWith('border')).sort().join(' | '))
const S = 'border-bottom:0.06em solid', T = 'border-top:0.06em solid', L = 'border-left:0.06em solid', RS = 'border-right:0.06em solid'
const TEMML_RULES: [string, string[]][] = [
  ['\\begin{array}{|c|c|} \\hline a & b \\\\ \\hline c & d \\\\ \\hline \\end{array}', [[L, RS, S, T].sort().join(' | '), [RS, S, T].sort().join(' | '), [L, RS, S].sort().join(' | '), [RS, S].sort().join(' | ')]],
  ['\\begin{array}{c:c} a & b \\\\ \\hdashline c & d \\end{array}', ['border-bottom:0.06em dashed | border-right:0.06em dashed', 'border-bottom:0.06em dashed', 'border-right:0.06em dashed', '']],
  ['\\begin{array}{c||c} a & b \\\\ \\hline\\hline c & d \\end{array}', ['border-bottom:0.15em double | border-right:0.15em double', 'border-bottom:0.15em double', 'border-right:0.15em double', '']],
  ['\\begin{pmatrix} 1 & 0 \\\\ \\hline 0 & 1 \\end{pmatrix}', [S, S, '', '']],
]
for (const [src, want] of TEMML_RULES) ok(JSON.stringify(borders(renderMath(src, { display: true })!)) === JSON.stringify(want), `rules drawn as Temml draws them: ${src}`)
ok(!borders(renderMath('\\begin{array}{cc} a & b \\\\ c & d \\end{array}', { display: true })!).some(Boolean), 'no rules asked for, no borders drawn')
ok(renderMath('\\genfrac{(}{]}{0pt}{2}{a}{b}')!.includes('<mstyle displaystyle="false" scriptlevel="1"><mfrac linethickness="0">'), '\\genfrac style 2 is script size, as Temml sets it')
// #551: Chrome will not stretch → (measured): it is drawn, sized by a table
// column as wide as its wider label, announced as → to assistive tech
const xr = renderMath('A \\xrightarrow[u]{\\text{over}} B')!
ok(/<mtable><mtr><mtd style="padding:0"><mrow scriptlevel="1" displaystyle="false">.*over.*<\/mtd><\/mtr><mtr><mtd style="padding:0;position:relative;min-width:3.5em;height:0.6em"><mtext><svg role="img" aria-label="→"/.test(xr) && xr.includes('<mphantom>'), '\\xrightarrow: the over label, then the drawn arrow at the column\'s width, then the under label (each row balanced by a phantom of the other)')
ok(renderMath('\\overrightarrow{AB}')!.startsWith('<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow style="position:relative;padding-top:0.5em">') && !renderMath('\\vec{v}')!.includes('<svg'), '\\overrightarrow: the arrow drawn over the base, baseline kept; a small \\vec stays a glyph')
ok(renderMath('a \\equiv b \\pmod{n}')!.includes('<mi>mod</mi>'), '\\pmod writes (mod n)')
ok(renderMath('\\left\\{ x \\middle| x > 0 \\right\\}')!.includes('<mo lspace="0.05em" rspace="0.05em" stretchy="true">|</mo>'), '\\middle| is one stretchy bar')
ok(renderMath('f \\colon A \\to B')!.includes('<mo lspace="0em" rspace="0.1667em">:</mo>'), '\\colon: no space before, a thin one after')
ok(renderMath('a = b \\tag{1}')!.includes('<mtext>(1)</mtext>') && renderMath('a = b \\tag*{A}')!.includes('<mtext>A</mtext>'), '\\tag is a label after the formula, in parentheses; \\tag* without')
ok(renderMath('a = b \\notag') === renderMath('a = b') && renderMath('a \\vspace{2em} b') === renderMath('a b'), '\\notag, \\nonumber and \\vspace render as nothing')
ok(renderMath('\\operatorname*{argmax}_x f', { display: true })!.includes('<munder>') && renderMath('\\operatorname*{argmax}_x f')!.includes('<msub>'), '\\operatorname*: limits under in display, at the side inline')
ok(renderMath('\\emph{note}')!.includes('<mtext>𝑛𝑜𝑡𝑒</mtext>'), '\\emph is italic text')

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
// Column alignment is TeX's since #551 (the maintainer reversed the
// 2026-09-15 centred look, docs/DECISIONS.md 2026-09-24): an `&=` lines up.
// (the -webkit- keyword is the one Chrome's mtd honours — measured: plain
// left/right/center all lay out at the start edge; columnalign for the rest)
ok(renderMath('\\begin{cases} a & b \\\\ c & d \\end{cases}')!.includes('<mtd columnalign="left" style="text-align:-webkit-left;padding-left:1em;padding-right:0em">'), 'cases: 1em before the condition column, every column left-aligned')
ok(renderMath('\\begin{aligned} a &= b \\end{aligned}')!.includes('<mtable displaystyle="true">') && renderMath('\\begin{aligned} a &= b \\end{aligned}')!.includes('<mtd columnalign="right" style="text-align:-webkit-right;padding-left:0em;padding-right:0em"><mi>a</mi></mtd><mtd columnalign="left" style="text-align:-webkit-left;padding-left:0em;padding-right:0em">'), 'aligned: display style, no column padding, right|left so the relations line up')
ok(!/text-align|columnalign/.test(renderMath('\\begin{pmatrix} 1 & 2 \\end{pmatrix}')!) && renderMath('\\begin{pmatrix*}[r] 1 & -2 \\end{pmatrix*}')!.includes('text-align:-webkit-right'), 'a matrix stays centred; a starred matrix takes its [r]')
ok(renderMath('\\vec{v}')!.includes('<mo stretchy="false">→</mo>') && renderMath('\\hat{x}')!.includes('style="math-depth:0"'), "\\vec shrinks to script size, \\hat stays full — Temml's look")
ok(renderMath('\\overleftarrow{AB}')!.includes('stretchy="true" style="math-depth:0"'), 'a stretchy arrow accent stays full size')
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
const ALLOWED = new Set(['xmlns', 'display', 'mathvariant', 'stretchy', 'fence', 'form', 'lspace', 'rspace', 'style', 'linethickness', 'displaystyle', 'accent', 'width', 'minsize', 'maxsize', 'separator', 'symmetric', 'largeop', 'movablelimits', 'columnalign', 'rowspacing', 'columnspacing', 'scriptlevel', 'height', 'depth', 'voffset', 'mathcolor', 'mathbackground', 'columnlines', 'rowlines', 'frame', 'notation', 'accentunder',
  // the drawn arrows' svg (#551): every value a constant of the printer
  'role', 'aria-label', 'viewBox', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'd', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'overflow'])
for (const src of ['\\href{javascript:alert(1)}{x}', 'x" onload="alert(1)', '<img src=x onerror=alert(1)>', '\\text{<script>1</script>}', '\\textcolor{red;background:url(x)}{y}', '\\textcolor{url(javascript:1)}{y}', '\\mathrm{a} onclick=1',
  // #551: the drawn arrows carry svg; its attributes are all constants, and
  // author text only ever reaches it as an escaped label
  // (the injected attribute is `zz` so the word check above cannot mistake
  // correctly escaped label TEXT for an attribute; attrsOf is the real test)
  'A \\xrightarrow{\\text{x" zz="1}} B', 'A \\xrightleftharpoons[\\text{<svg zz=1>}]{} B', '\\overrightarrow{\\text{"><b zz=1>}}']) {
  const out = renderMath(src) ?? renderMath(src, { syntax: 'typst' }) ?? ''
  ok(!/<script|onload|onerror|onclick|javascript:|url\(/i.test(out) && attrsOf(out).every((a) => ALLOWED.has(a)), `no author-controlled attribute or tag survives: ${JSON.stringify(src)} -> ${out ? out.slice(0, 60) + '…' : 'refused'}`)
}
ok(renderMath('\\textcolor{#ff0000}{x}')!.includes('style="color:#ff0000"') && renderMath('\\textcolor{rebeccapurple}{x}')!.includes('color:rebeccapurple'), '\\textcolor takes a hex or a named colour')
// The style VALUE, not just the attribute name: every style="…" the emitter
// can produce is one of its own constant forms, or `color:` + a value of the
// colour shape isCssColor admits — one declaration, no `;`, no `(` outside
// rgb/hsl. A loosened isCssColor that lets a `;` through goes red here.
const STYLE_FORMS = [
  /^margin-left:-?[\d.]+em;$/, /^math-depth:0$/, /^transform:translateX\(-(100|50)%\)$/,
  // the drawn arrows (#551): constant boxes, no author text reaches them
  /^padding:0$/, /^padding:0;position:relative;min-width:3\.5em;height:0\.6em$/, /^position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible$/,
  /^position:relative;padding-(top|bottom):0\.5em$/, /^position:absolute;left:0;(top|bottom):0;width:100%;height:0\.45em$/,
  // the last of Temml's vocabulary: mhchem's drawn bonds, raised pieces,
  // \angl / \longdiv rules, \reflectbox
  /^background:currentColor$/, /^padding-top:[\d.]+em$/,
  /^border-top:0\.065em solid;border-right:0\.065em solid;padding:0\.1em 0\.12em 0 0\.1em$/, /^border-top:0\.065em solid;padding-top:0\.1em$/, /^transform:scaleX\(-1\)$/,
  // (a cell may end with the table's rules: \hline, array | : ||)
  /^(text-align:-webkit-(left|right);)?padding-left:(0|1)em;padding-right:0em(;border-(top|bottom|left|right):0\.(06em (solid|dashed)|15em double))*$/,
  /^(text-align:-webkit-(left|right);)?padding-left:(0em|5\.9776pt);padding-right:(0em|5\.9776pt)(;border-(top|bottom|left|right):0\.(06em (solid|dashed)|15em double))*$/,
]
const COLOR_SHAPE = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|(rgba?|hsla?)\([\d.%,\s/]+\))$/i
// the constant declarations the style node can emit (#551 added the cancel
// variants, sizes, bold, and the \colorbox/\fcolorbox colours — whose VALUE
// is author text and must pass the same colour shape as \textcolor's)
const GRAD = /^linear-gradient\(to (top right|bottom right|bottom),transparent 47%,currentColor 47%,currentColor 53%,transparent 53%\)$/
const declOk = (d: string) => d === 'padding:3pt' || d === 'border:1px solid' || d === 'font-weight:bold' || d === 'padding:0.3em' || /^font-size:[\d.]+em$/.test(d)
  || (d.startsWith('background:') && d.slice(11).split(/,(?=linear)/).every((g) => GRAD.test(g)))
  || (d.startsWith('color:') && COLOR_SHAPE.test(d.slice(6))) || (d.startsWith('background-color:') && COLOR_SHAPE.test(d.slice(17)))
  || (d.startsWith('border:0.0667em solid ') && COLOR_SHAPE.test(d.slice(22)))
const styleOk = (v: string) => STYLE_FORMS.some((re) => re.test(v)) || v.split(';').every(declOk)
const styleValues = (html: string) => [...html.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1])
const STYLE_PROBES = ['\\textcolor{red}{x}', '\\textcolor{#abc}{x}', '\\textcolor{rgb(1, 2, 3)}{x}', '\\boxed{\\textcolor{blue}{y}}', '\\cancel{x}', 'a\\!b', '\\hat{x}', '\\begin{cases} a & b \\\\ c & d \\end{cases}', '\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}', '\\begin{aligned} a &= b \\end{aligned}',
  '\\textcolor{red;position:fixed}{x}', '\\textcolor{red;font-size:900px}{x}', '\\textcolor{red}{x};background:url(x)', '\\textcolor{expression(1)}{x}', '\\textcolor{var(--x)}{x}', '\\textcolor{rgb(1,2,3);color:red}{x}',
  // #551: every new style the engine can write, and the two new places an
  // author's colour reaches a style attribute, attacked the same way
  '\\bcancel{x}', '\\xcancel{x}', '\\sout{x}', '\\large x', '\\pmb{x}', '\\llap{x}', '\\clap{x}', '\\colorbox{yellow}{x}', '\\fcolorbox{red}{#ff0}{x}', 'A \\xrightarrow{f} B', '\\overrightarrow{AB}',
  '\\angl{n}', '7\\longdiv{364}', '\\reflectbox{x}', 'C\\tripleDashBetweenDoubleLine C', '\\begin{CD} A @>f>> B \\end{CD}',
  '\\begin{array}{|c:c||c|} \\hline a & b & c \\\\ \\hdashline d & e & f \\\\ \\hline\\hline \\end{array}',
  '\\colorbox{red;position:fixed}{x}', '\\colorbox{url(x)}{x}', '\\fcolorbox{red;top:0}{blue}{x}', '\\fcolorbox{red}{blue;left:0}{x}', '\\colorbox{var(--x)}{x}']
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
const firstUnnamed = SYMBOLS.findIndex((s) => !s.typst)
ok(SYMBOLS.every((s) => [...s.cp].length >= 1) && firstUnnamed > 150 && SYMBOLS.slice(0, firstUnnamed).every((s) => s.typst.length > 0), 'every row has a glyph; every hand-written row has a Typst name (only the packed Temml rows, #551, go without)')
ok(styledChar('R', 'bb') === 'ℝ' && styledChar('a', 'bb') === '𝕒' && styledChar('7', 'bb') === '𝟟', 'styledChar: holes patched, lowercase and digits from the block')
ok(styledChar('x', 'rm') === 'x' && styledChar('!', 'bf') === '!', 'rm and non-letters pass through')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
