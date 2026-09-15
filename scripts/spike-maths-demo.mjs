#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Spike demo deck: every formula three times — LaTeX via maths-lite, Typst
// via maths-lite, LaTeX via Temml (the control) — with the raw source under
// each. Spliced into the SPIKE shell (built from spike-maths-lite, which
// carries both engines) the way build-404-deck.mjs splices.
//
//   node scripts/spike-maths-demo.mjs [shell] [out]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const shellPath = process.argv[2] ?? join(root, 'slides/dist-single/Bento_Slides.bento.html')
const out = process.argv[3] ?? join(root, 'working/pr-test/maths-lite-demo.bento.html')

const INK = '#0f172a', PANEL = '#111c33', MIST = '#a8b3c7', PEACH = '#ff9e8a', STEEL = '#5b8def'
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

let n = 0
const id = (p) => `${p}-${++n}`
const text = (x, y, w, h, html, extra = {}) => ({ id: id('t'), type: 'text', x, y, w, h, rotation: 0, opacity: 1, html, fontSize: 22, fontWeight: 400, color: '#fff', align: 'left', valign: 'top', lineHeight: 1.3, ...extra })

/** One family slide: a title, then rows of [label, latex, typst]; three cells per row. */
function family(title, rows, note = '') {
  const els = [text(64, 36, 1150, 50, title, { fontSize: 34, fontWeight: 700 })]
  const heads = ['LaTeX → maths-lite', 'Typst → maths-lite', 'LaTeX → Temml (control)']
  heads.forEach((h, i) => els.push(text(64 + i * 390, 92, 370, 24, h, { fontSize: 13, color: i === 2 ? PEACH : STEEL, fontWeight: 700, letterSpacing: 1 })))
  const rowH = Math.min(150, Math.floor(560 / rows.length))
  rows.forEach(([label, tex, ty], r) => {
    const y = 122 + r * rowH
    const cells = [`$$${tex}$$`, ty ? `$$typst: ${ty}$$` : '<i>(no Typst form)</i>', `$$temml: ${tex}$$`]
    const srcs = [tex, ty ? 'typst: ' + ty : '', 'temml: ' + tex]
    cells.forEach((c, i) => {
      els.push(text(64 + i * 390, y, 370, rowH - 34, c, { fontSize: rows.length > 3 ? 20 : 26, align: 'center', valign: 'middle' }))
      els.push(text(64 + i * 390, y + rowH - 34, 370, 28, `<code>${esc(srcs[i])}</code>`, { fontSize: 10, color: MIST, align: 'center' }))
    })
    if (label) els.push(text(64, y - 2, 1150, 16, label, { fontSize: 10, color: MIST, letterSpacing: 1 }))
  })
  return { id: id('s'), background: INK, transition: 'fade', notes: note, elements: els }
}

const slides = [
  {
    id: id('s'), background: PANEL, transition: 'fade',
    notes: 'The spike shell carries both engines. Normal $…$ goes through maths-lite; the markers below select the others.',
    elements: [
      text(64, 60, 1150, 80, 'maths-lite — spike demo', { fontSize: 48, fontWeight: 700 }),
      text(64, 160, 1150, 300, [
        'Every slide shows the same formula three times: <b>LaTeX through maths-lite</b>, <b>Typst through maths-lite</b>, and <b>LaTeX through Temml</b> as the control — the raw source in small type under each.',
        '',
        'Syntax — <b>decided</b> (maintainer, 2026-09-15): the marker is <code>typst:</code> right after the opening delimiter, case-sensitive.',
        // the dollars in this prose are escaped (\\$) so resolveMath leaves them
        '&nbsp;&nbsp;<code>\\$…\\$</code> and <code>\\$\\$…\\$\\$</code> — LaTeX, exactly as today',
        '&nbsp;&nbsp;<code>\\$typst: …\\$</code> and <code>\\$\\$typst: …\\$\\$</code> — Typst maths',
        '&nbsp;&nbsp;<code>\\$temml: …\\$</code> — the Temml control, in this spike shell only; it does not ship',
        '',
        'The document keeps raw source; nothing in the format changed. Shell size without Temml: see the handoff.',
      ].join('<br>'), { fontSize: 20, lineHeight: 1.5, color: MIST }),
    ],
  },
  family('Fractions & roots', [
    ['', 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', 'x = (-b plus.minus sqrt(b^2 - 4 a c)) / (2 a)'],
    ['', '\\frac{1}{1+\\frac{1}{x}} + \\sqrt[3]{x^3+1}', '1/(1 + 1/x) + root(3, x^3 + 1)'],
    ['', '\\binom{n}{k} = \\frac{n!}{k!\\,(n-k)!}', 'binom(n, k) = (n!)/(k! (n-k)!)'],
  ]),
  family('Scripts & limits', [
    ['', '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}', 'sum_(i=1)^n i = (n(n+1))/2'],
    ['', '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}', 'integral_0^oo e^(-x^2) dif x = sqrt(pi)/2'],
    ['', '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1', 'lim_(x -> 0) (sin x)/x = 1'],
  ]),
  family('Brackets & big delimiters', [
    ['', '\\left( x + \\frac{b}{2a} \\right)^2', '(x + b/(2 a))^2'],
    ['', '\\left\\lfloor \\frac{n}{2} \\right\\rfloor + \\left\\| v \\right\\|', 'floor(n/2) + norm(v)'],
    ['', '\\Bigl[ \\bigl( a \\bigr) \\Bigr]', null],
  ]),
  family('Matrices, cases, align', [
    ['', '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix} \\begin{bmatrix} 1 \\\\ 0 \\end{bmatrix}', 'mat(a, b; c, d) vec(1, 0)'],
    ['', 'f(x) = \\begin{cases} x & x \\ge 0 \\\\ -x & x < 0 \\end{cases}', 'f(x) = cases(x & x >= 0, -x & x < 0)'],
    ['', '\\begin{aligned} a &= b + c \\\\ &= d \\end{aligned}', null],
  ]),
  family('Accents & decorations', [
    ['', '\\hat{x} + \\vec{v} + \\bar{z} + \\tilde{a} + \\dot{x}', 'hat(x) + arrow(v) + bar(z) + tilde(a) + dot(x)'],
    ['', '\\overline{AB} + \\underline{x} + \\widehat{abc}', 'overline(A B) + underline(x) + hat(a b c)'],
    ['', '\\overbrace{a+b+c}^{n} + \\underbrace{x+y}_{2}', 'overbrace(a+b+c, n) + underbrace(x+y, 2)'],
  ]),
  family('Fonts', [
    ['', '\\mathbb{R}^n, \\mathbb{N} \\subset \\mathbb{Z} \\subset \\mathbb{Q}', 'bb(R)^n, bb(N) subset bb(Z) subset bb(Q)'],
    ['', '\\mathcal{L} \\mathcal{H} \\mathfrak{g} \\mathfrak{su}(2)', 'cal(L) cal(H) frak(g) frak(s u)(2)'],
    ['', '\\mathbf{x} \\mathrm{d}x \\mathsf{A} \\mathtt{code}', 'bold(x) upright(d) x sans(A) mono(c o d e)'],
  ]),
  family('Text & colour', [
    ['', '\\text{if } x > 0 \\text{ then } y', '"if " x > 0 " then " y'],
    ['', '\\textcolor{red}{x} + \\textcolor{#5b8def}{y}', null],
    ['', '\\boxed{E = mc^2}', null],
  ]),
  family("Maxwell's equations", [
    ['', '\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0} \\qquad \\nabla \\cdot \\mathbf{B} = 0', 'nabla dot.op bold(E) = rho/epsilon_0 quad nabla dot.op bold(B) = 0'],
    ['', '\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t}', 'nabla times bold(E) = -(diff bold(B))/(diff t)'],
    ['', '\\nabla \\times \\mathbf{B} = \\mu_0 \\mathbf{J} + \\mu_0 \\varepsilon_0 \\frac{\\partial \\mathbf{E}}{\\partial t}', 'nabla times bold(B) = mu_0 bold(J) + mu_0 epsilon_0 (diff bold(E))/(diff t)'],
  ]),
  family('Bayes & softmax', [
    ['', 'P(A \\mid B) = \\frac{P(B \\mid A)\\,P(A)}{P(B)}', 'P(A divides B) = (P(B divides A) P(A))/(P(B))'],
    ['', '\\sigma(\\mathbf{z})_i = \\frac{e^{z_i}}{\\sum_{j=1}^{K} e^{z_j}}', 'sigma(bold(z))_i = e^(z_i)/(sum_(j=1)^K e^(z_j))'],
  ]),
  family('What still differs after round 2 (3 kinds of 89; the rest match)', [
    ["Temml's: \\underline / \\overline are menclose, which Chrome does not draw — maths-lite draws the rule", '\\underline{x} + \\overline{AB}', 'underline(x) + overline(A B)'],
    ['Sub-pixel: matrix / cases / aligned rows sit a fraction of a pixel apart (size 0.0%; the same by eye)', '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', 'mat(a, b; c, d)'],
    ['Tree only: Temml nests (z) then msub; ours is msub of the group — pixels identical', '\\sigma(z)_i', 'sigma(z)_i'],
  ]),
]

const doc = {
  format: 'bento/slides', version: 1, title: 'maths-lite spike demo',
  size: { width: 1280, height: 720 },
  theme: { background: INK, color: '#fff', accent: PEACH, fontFamily: 'system-ui, sans-serif' },
  slides, modified: new Date().toISOString(),
}
const json = JSON.stringify(doc).replace(/</g, '\\u003c')
const shell = readFileSync(shellPath, 'utf8')
const blockRe = /<script type="application\/bento\+json" id="bento-doc">[\s\S]*?<\/script>/
// a FUNCTION replacement: the JSON is full of `$$`, which a string
// replacement would read as a replacement pattern and collapse to `$`
const spliced = shell.replace(blockRe, () => `<script type="application/bento+json" id="bento-doc">\n${json}\n</scr` + 'ipt>')
if (!spliced.includes(json)) throw new Error('splice failed')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, spliced)
console.log(`demo deck → ${out} (${spliced.length} bytes, ${slides.length} slides)`)
