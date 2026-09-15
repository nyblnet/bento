#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// maths-lite (SPIKE): the engine's own contract, DOM-free.
//
//   node scripts/test-maths-lite.ts
//
// WHAT THIS PROVES. Every corpus formula (what our decks actually carry) and
// every formula of the standard set parses; a refused formula returns null
// rather than throwing (the never-throws contract render.ts relies on); the
// Typst front end and the LaTeX front end agree on the shared tree for the
// equivalence table (byte-identical apart from Typst's paren GROUPS, folded);
// the symbol table has no duplicate LaTeX names; every styled letter is a
// real Mathematical Alphanumeric code point (Chrome ignores mathvariant).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { renderMath, parseMath, isTypst, stripMarker } from '../slides/src/maths/index.ts'
import { SYMBOLS, styledChar } from '../slides/src/maths/symbols.ts'

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

console.log('\nthe corpus and the standard set\n')
const corpusPath = join(process.env.CLAUDE_JOB_DIR ?? '', 'tmp/maths-corpus.json')
let corpus: Array<{ src: string; display: boolean }> = []
try { corpus = JSON.parse(readFileSync(corpusPath, 'utf8')).corpus } catch { /* built by spike-maths-corpus.mjs; the starter trio below stands in */ }
const STARTER = ['ax^2 + bx + c = 0', '\\left(x + \\frac{b}{2a}\\right)^2 = \\frac{b^2 - 4ac}{4a^2}', 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', 'E=mc^2']
for (const f of STARTER) ok(renderMath(f, { display: true }) !== null, `starter deck: ${f}`)
const real = corpus.filter((c) => !c.src.includes('…'))
ok(real.every((c) => renderMath(c.src, { display: c.display }) !== null), `every corpus formula renders (${real.length} from the corpus file, or the starter trio when absent)`)

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
ok(renderMath('\\begin{cases} a & b \\\\ c & d \\end{cases}')!.includes('padding-left:1em;padding-right:0em'), 'cases: 1em before the condition column')
ok(renderMath('\\begin{aligned} a &= b \\end{aligned}')!.includes('<mtable displaystyle="true">') && renderMath('\\begin{aligned} a &= b \\end{aligned}')!.includes('padding-left:0em;padding-right:0em'), 'aligned: display style, no column padding')
ok(renderMath('\\vec{v}')!.includes('<mo stretchy="false">→</mo>') && renderMath('\\hat{x}')!.includes('style="math-depth:0"'), "\\vec shrinks to script size, \\hat stays full — Temml's look")
ok(renderMath('\\overrightarrow{AB}')!.includes('stretchy="true" style="math-depth:0"'), 'a stretchy arrow accent stays full size')
ok(renderMath('\\overline{AB}')!.includes('<mover><mrow><mi>A</mi><mi>B</mi></mrow><mo stretchy="true" style="math-depth:0">‾</mo></mover>'), "\\overline draws a stretchy rule (Temml's menclose is blank on Chrome — kept ours)")
ok(renderMath('\\binom{n}{k}')!.includes('stretchy="true">(</mo><mfrac linethickness="0">'), 'binom parens stretch')
ok(renderMath('\\int_0^1', { display: true })!.includes('<msubsup>'), 'integrals keep side limits in display mode')
ok(renderMath('\\begin{pmatrix} a \\\\ b \\end{pmatrix}')!.includes('<mtd style="padding-left:0em;padding-right:0em">'), 'a centred cell says nothing about alignment (the 2 px that kept matrices off Temml)')

console.log('\nthe syntax marker (decided: $typst: …$)\n')
ok(isTypst('typst: a/b') && isTypst('typst:a/b'), 'typst: at the start, with or without a space')
ok(!isTypst(' typst: a/b') && !isTypst('Typst: a/b') && !isTypst('TYPST: a/b'), 'not after whitespace, not another case')
ok(!isTypst('a typst: b') && !isTypst('\\frac{typst:}{b}'), 'not anywhere else in the formula')
ok(stripMarker('typst:  a/b') === 'a/b' && stripMarker('\\frac{a}{b}') === '\\frac{a}{b}', 'stripMarker removes exactly the marker')
const render = readFileSync(join(root, 'slides/src/render.ts'), 'utf8')
ok(/const m = \/\^\(typst\|temml\):\\s\*\/\.exec\(tex\)/.test(render), 'render.ts applies the exact marker (case-sensitive, at the start)')
ok(/import temml from 'temml'/.test(render), 'SPIKE SHELL ONLY: the temml control import is present here (must be removed for the ship variant)')

console.log('\nTypst ≡ LaTeX on the shared tree\n')
const pairs: Array<[string, string]> = [['a/b', '\\frac{a}{b}'], ['(a+b)/c', '\\frac{a+b}{c}'], ['sqrt(2)', '\\sqrt{2}'], ['root(3, x)', '\\sqrt[3]{x}'], ['x^(n+1)', 'x^{n+1}'], ['sum_(i=1)^n i', '\\sum_{i=1}^{n} i'], ['mat(a, b; c, d)', '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}'], ['cases(x & x >= 0, -x & x < 0)', '\\begin{cases} x & x \\ge 0 \\\\ -x & x < 0 \\end{cases}'], ['bb(R)', '\\mathbb{R}'], ['hat(x)', '\\hat{x}'], ['alpha + beta', '\\alpha + \\beta'], ['a <= b != c', 'a \\le b \\ne c'], ['"if" x', '\\text{if} x'], ['lim_(x -> oo) f', '\\lim_{x \\to \\infty} f']]
for (const [ty, tex] of pairs) ok(renderMath(ty, { syntax: 'typst', display: true }) === renderMath(tex, { display: true }), `typst \`${ty}\` ≡ latex \`${tex}\``)
// Round 2 closed the one difference there was: a LaTeX paren group is now
// ONE node too (as Temml prints it), so f(x)_i scripts the group in both.
const noExplicit = (k: string, v: unknown) => (k === 'explicit' ? undefined : v) // Typst sizes its groups (\\left-like); the STRUCTURE is what must agree
ok(JSON.stringify(parseMath('f(x)_i', { syntax: 'typst' }), noExplicit) === JSON.stringify(parseMath('f(x)_i'), noExplicit), 'f(x)_i: both front ends script the paren group')

console.log('\nthe symbol table\n')
const texNames = SYMBOLS.map((s) => s.tex)
ok(new Set(texNames).size === texNames.length, `no duplicate LaTeX names (${texNames.length} rows)`)
ok(SYMBOLS.every((s) => [...s.cp].length >= 1 && s.typst.length > 0), 'every row has a glyph and a Typst name')
ok(styledChar('R', 'bb') === 'ℝ' && styledChar('a', 'bb') === '𝕒' && styledChar('7', 'bb') === '𝟟', 'styledChar: holes patched, lowercase and digits from the block')
ok(styledChar('x', 'rm') === 'x' && styledChar('!', 'bf') === '!', 'rm and non-letters pass through')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
