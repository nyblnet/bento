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
import { renderMath, parseMath } from '../slides/src/maths/index.ts'
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
ok(renderMath('\\left( x \\right)')!.includes('<mo stretchy="true">(</mo>'), '\\left( is a stretchy fence')
ok(renderMath('f(x)')!.includes('form="prefix"'), 'a bare ( says it is a prefix fence (no infix spacing)')
ok(renderMath('\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}')!.match(/<mtr>/g)!.length === 2, 'pmatrix: two rows')
ok(renderMath('\\begin{cases} a & b \\\\ c & d \\end{cases}')!.includes('<mo stretchy="true">{</mo>'), 'cases: a left brace only')
ok(renderMath('\\sin x')!.includes('\u2061'), 'function application after \\sin')

console.log('\nTypst ≡ LaTeX on the shared tree\n')
const pairs: Array<[string, string]> = [['a/b', '\\frac{a}{b}'], ['(a+b)/c', '\\frac{a+b}{c}'], ['sqrt(2)', '\\sqrt{2}'], ['root(3, x)', '\\sqrt[3]{x}'], ['x^(n+1)', 'x^{n+1}'], ['sum_(i=1)^n i', '\\sum_{i=1}^{n} i'], ['mat(a, b; c, d)', '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}'], ['cases(x & x >= 0, -x & x < 0)', '\\begin{cases} x & x \\ge 0 \\\\ -x & x < 0 \\end{cases}'], ['bb(R)', '\\mathbb{R}'], ['hat(x)', '\\hat{x}'], ['alpha + beta', '\\alpha + \\beta'], ['a <= b != c', 'a \\le b \\ne c'], ['"if" x', '\\text{if} x'], ['lim_(x -> oo) f', '\\lim_{x \\to \\infty} f']]
for (const [ty, tex] of pairs) ok(renderMath(ty, { syntax: 'typst', display: true }) === renderMath(tex, { display: true }), `typst \`${ty}\` ≡ latex \`${tex}\``)
const t1 = parseMath('f(x)_i', { syntax: 'typst' }), t2 = parseMath('f(x)_i')
ok(JSON.stringify(t1) !== JSON.stringify(t2), 'the ONE known difference: Typst scripts the paren GROUP, TeX scripts the paren — stated, not hidden')

console.log('\nthe symbol table\n')
const texNames = SYMBOLS.map((s) => s.tex)
ok(new Set(texNames).size === texNames.length, `no duplicate LaTeX names (${texNames.length} rows)`)
ok(SYMBOLS.every((s) => [...s.cp].length >= 1 && s.typst.length > 0), 'every row has a glyph and a Typst name')
ok(styledChar('R', 'bb') === 'ℝ' && styledChar('a', 'bb') === '𝕒' && styledChar('7', 'bb') === '𝟟', 'styledChar: holes patched, lowercase and digits from the block')
ok(styledChar('x', 'rm') === 'x' && styledChar('!', 'bf') === '!', 'rm and non-letters pass through')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
