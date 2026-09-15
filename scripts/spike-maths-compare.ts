#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Spike: maths-lite vs Temml. Two halves.
//
//   node scripts/spike-maths-compare.ts            (node half + writes the browser harness)
//
// NODE HALF: the Typst table — every Typst formula and its LaTeX equivalent
// must produce byte-identical MathML through the shared tree. No DOM needed.
//
// BROWSER HALF: writes $CLAUDE_JOB_DIR/tmp/maths-harness/index.html which
// loads temml.min.js and the maths-lite bundle, renders every corpus formula
// plus the standard set through both, normalises the MathML trees, rasterises
// both into a canvas and reports pixel difference. Serve that directory and
// read window.__results in Chrome. The numbers go in the spike handoff.
//
// The standard set is written here from the categories of Temml's supported
// functions page (temml.org/docs/en/supported.html, MIT); no test file of
// Temml's is copied — its npm package ships no test directory.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { renderMath } from '../slides/src/maths/index.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = join(process.env.CLAUDE_JOB_DIR ?? '/tmp', 'tmp')
mkdirSync(join(tmp, 'maths-harness'), { recursive: true })

// --- the standard LaTeX set ---------------------------------------------------
export const STANDARD: Array<[string, boolean]> = [
  ['x^2 + y^2 = z^2', false], ['a_1 + a_2 + \\cdots + a_n', false], ['x_i^2', false], ['e^{i\\pi} + 1 = 0', false],
  ['\\frac{a}{b}', false], ['\\frac{1}{1+\\frac{1}{x}}', true], ['\\dfrac{a}{b}', false], ['\\tfrac{a}{b}', true], ['\\binom{n}{k}', true],
  ['\\sqrt{2}', false], ['\\sqrt[3]{x^3+1}', false], ['\\sqrt{\\frac{a}{b}}', true],
  ['\\sum_{i=1}^{n} i', true], ['\\sum_{i=1}^{n} i', false], ['\\prod_{k=1}^n k', true], ['\\int_a^b f(x)\\,dx', true], ['\\oint_C \\vec{F}\\cdot d\\vec{r}', true], ['\\iint_D f\\,dA', true],
  ['\\lim_{x \\to \\infty} f(x)', true], ['\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1', true], ['\\max_{a \\in A} f(a)', true],
  ['\\left( \\frac{a}{b} \\right)', true], ['\\left[ x \\right]', false], ['\\left\\{ x \\right\\}', false], ['\\left| x \\right|', false], ['\\left\\| v \\right\\|', false], ['\\left\\langle a, b \\right\\rangle', false], ['\\left\\lfloor x \\right\\rfloor', false], ['\\left. \\frac{df}{dx} \\right|_{x=0}', true],
  ['\\bigl( x \\bigr)', false], ['\\Bigl[ x \\Bigr]', false], ['\\biggl\\{ x \\biggr\\}', false],
  ['\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', true], ['\\begin{bmatrix} 1 & 0 \\\\ 0 & 1 \\end{bmatrix}', true], ['\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}', true], ['\\begin{matrix} 1 & 2 \\\\ 3 & 4 \\end{matrix}', true],
  ['f(x) = \\begin{cases} x & x \\ge 0 \\\\ -x & x < 0 \\end{cases}', true], ['\\begin{aligned} a &= b + c \\\\ &= d \\end{aligned}', true],
  ['\\hat{x}', false], ['\\vec{v}', false], ['\\bar{z}', false], ['\\tilde{a}', false], ['\\dot{x} + \\ddot{x}', false], ['\\overline{AB}', false], ['\\underline{x}', false], ['\\widehat{abc}', false],
  ['\\overbrace{a+b+c}^{n}', true], ['\\underbrace{x+y}_{2}', true], ['\\overrightarrow{AB}', false],
  ['\\mathbb{R}', false], ['\\mathbb{N} \\subset \\mathbb{Z} \\subset \\mathbb{Q}', false], ['\\mathcal{L}', false], ['\\mathfrak{g}', false], ['\\mathbf{x}', false], ['\\mathrm{d}x', false], ['\\mathsf{A}', false], ['\\mathtt{code}', false],
  ['\\text{if } x > 0', false], ['\\textcolor{red}{x}', false], ['\\boxed{E = mc^2}', true], ['\\operatorname{sinc}(x)', false],
  ['\\alpha + \\beta = \\gamma', false], ['\\Delta x \\to 0', false], ['\\forall \\epsilon > 0\\, \\exists \\delta', false], ['A \\cup B \\cap C', false], ['x \\in \\emptyset', false], ['a \\le b \\ne c \\ge d', false], ['p \\Rightarrow q \\iff \\neg q \\Rightarrow \\neg p', false],
  ['\\sin^2 \\theta + \\cos^2 \\theta = 1', false], ['\\log_2 n', false], ['\\ln x', false], ['f\'(x)', false], ['f\'\'(x)', false],
  ['a \\quad b \\qquad c', false], ['a\\,b\\;c\\!d', false], ['x \\pm y \\mp z', false], ['\\nabla \\cdot \\vec{E} = \\frac{\\rho}{\\varepsilon_0}', true], ['\\partial_\\mu F^{\\mu\\nu} = J^\\nu', true],
  ['P(A \\mid B) = \\frac{P(B \\mid A)\\,P(A)}{P(B)}', true], ['\\sigma(z)_i = \\frac{e^{z_i}}{\\sum_{j=1}^K e^{z_j}}', true],
]

// --- the Typst table ------------------------------------------------------------
export const TYPST: Array<[string, string]> = [
  ['x^2', 'x^2'], ['x_1', 'x_1'], ['x_i^2', 'x_i^2'], ['x^(n+1)', 'x^{n+1}'], ['e^(i pi) + 1 = 0', 'e^{i\\pi} + 1 = 0'],
  ['a/b', '\\frac{a}{b}'], ['(a+b)/c', '\\frac{a+b}{c}'], ['frac(a, b)', '\\frac{a}{b}'], ['1/(1 + 1/x)', '\\frac{1}{1+\\frac{1}{x}}'], ['binom(n, k)', '\\binom{n}{k}'],
  ['sqrt(2)', '\\sqrt{2}'], ['root(3, x^3 + 1)', '\\sqrt[3]{x^3+1}'], ['sqrt(a/b)', '\\sqrt{\\frac{a}{b}}'],
  ['sum_(i=1)^n i', '\\sum_{i=1}^{n} i'], ['product_(k=1)^n k', '\\prod_{k=1}^n k'], ['integral_a^b f(x) dif x', '\\int_a^b f(x)\\mathrm{d}x'], ['integral.cont_C F', '\\oint_C F'],
  ['lim_(x -> oo) f(x)', '\\lim_{x \\to \\infty} f(x)'], ['lim_(x -> 0) (sin x)/x = 1', '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1'],
  ['abs(x)', '\\left| x \\right|'], ['norm(v)', '\\left\\| v \\right\\|'], ['floor(x)', '\\left\\lfloor x \\right\\rfloor'], ['ceil(x)', '\\left\\lceil x \\right\\rceil'],
  ['mat(a, b; c, d)', '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}'], ['vec(1, 2, 3)', '\\begin{pmatrix} 1 \\\\ 2 \\\\ 3 \\end{pmatrix}'],
  ['cases(x & x >= 0, -x & x < 0)', '\\begin{cases} x & x \\ge 0 \\\\ -x & x < 0 \\end{cases}'],
  ['hat(x)', '\\hat{x}'], ['arrow(v)', '\\vec{v}'], ['bar(z)', '\\bar{z}'], ['tilde(a)', '\\tilde{a}'], ['dot(x) + dot.double(x)', '\\dot{x} + \\ddot{x}'], ['overline(A B)', '\\overline{AB}'], ['underline(x)', '\\underline{x}'],
  ['overbrace(a+b+c, n)', '\\overbrace{a+b+c}^{n}'], ['underbrace(x+y, 2)', '\\underbrace{x+y}_{2}'],
  ['bb(R)', '\\mathbb{R}'], ['bb(N) subset bb(Z) subset bb(Q)', '\\mathbb{N} \\subset \\mathbb{Z} \\subset \\mathbb{Q}'], ['cal(L)', '\\mathcal{L}'], ['frak(g)', '\\mathfrak{g}'], ['bold(x)', '\\mathbf{x}'], ['upright(d) x', '\\mathrm{d}x'], ['sans(A)', '\\mathsf{A}'], ['mono(c o d e)', '\\mathtt{code}'],
  ['"if" x > 0', '\\text{if} x > 0'], ['op("sinc")(x)', '\\operatorname{sinc}(x)'],
  ['alpha + beta = gamma', '\\alpha + \\beta = \\gamma'], ['Delta x -> 0', '\\Delta x \\to 0'], ['forall epsilon > 0 exists delta', '\\forall \\epsilon > 0 \\exists \\delta'], ['A union B sect C', 'A \\cup B \\cap C'], ['x in emptyset', 'x \\in \\emptyset'], ['a <= b != c >= d', 'a \\le b \\ne c \\ge d'], ['p => q <==> not q => not p', 'p \\Rightarrow q \\iff \\neg q \\Rightarrow \\neg p'],
  ['sin^2 theta + cos^2 theta = 1', '\\sin^2 \\theta + \\cos^2 \\theta = 1'], ['log_2 n', '\\log_2 n'], ['ln x', '\\ln x'], ["f'(x)", "f'(x)"],
  ['x plus.minus y minus.plus z', 'x \\pm y \\mp z'], ['nabla dot.op arrow(E) = rho/epsilon_0', '\\nabla \\cdot \\vec{E} = \\frac{\\rho}{\\epsilon_0}'], ['diff_mu F^(mu nu) = J^nu', '\\partial_\\mu F^{\\mu\\nu} = J^\\nu'],
  ['P(A divides B) = (P(B divides A) P(A))/(P(B))', 'P(A \\mid B) = \\frac{P(B \\mid A) P(A)}{P(B)}'],
  ['sigma(z)_i = e^(z_i)/(sum_(j=1)^K e^(z_j))', '\\sigma(z)_i = \\frac{e^{z_i}}{\\sum_{j=1}^K e^{z_j}}'],
]

// Typst's `(…)` is a GROUP (attachments bind to it: `f(x)_i` scripts the
// whole call) where TeX's is two bare operators — that is a real semantic
// difference in the languages, not an engine bug, and the browser draws both
// the same. So two counts: byte-identical, and identical once a plain paren
// group's mrow and the \\left/\\right stretchy spelling are folded.
// Structural fold over our own printer's output (well-formed, attribute-free
// tags apart from what we emit): parse tags to a tree, splice any mrow into
// its parent mrow, drop the stretchy spelling, print back.
type TN = { tag: string; attrs: string; kids: (TN | string)[] }
function fold(s: string): string {
  const root: TN = { tag: '', attrs: '', kids: [] }
  const stack = [root]
  for (const m of s.matchAll(/<(\/?)([a-z]+)([^>]*)>|([^<]+)/g)) {
    if (m[4] !== undefined) { stack[stack.length - 1].kids.push(m[4]); continue }
    if (m[1]) { stack.pop(); continue }
    const n: TN = { tag: m[2], attrs: m[3].replace(/ stretchy="(true|false)"| fence="true"| form="(prefix|postfix)"/g, ''), kids: [] }
    stack[stack.length - 1].kids.push(n)
    if (!m[3].endsWith('/')) stack.push(n)
  }
  const print = (n: TN | string, parentRow: boolean): string => {
    if (typeof n === 'string') return n
    if (n.tag === 'mrow' && parentRow) return n.kids.map((k) => print(k, true)).join('')
    if (n.tag === 'mrow' && n.kids.length === 1) return print(n.kids[0], parentRow)
    const row = n.tag === 'mrow' || n.tag === 'math' || n.tag === 'mtd'
    return `<${n.tag}${n.attrs}>${n.kids.map((k) => print(k, row)).join('')}</${n.tag}>`
  }
  return root.kids.map((k) => print(k, false)).join('')
}
let pass = 0, passFolded = 0
const fails: string[] = []
for (const [ty, tex] of TYPST) {
  for (const display of [false, true]) {
    const a = renderMath(ty, { syntax: 'typst', display })
    const b = renderMath(tex, { display })
    if (a !== null && a === b) { pass++; passFolded++; continue }
    if (a !== null && b !== null && fold(a) === fold(b)) { passFolded++; continue }
    fails.push(`${display ? 'D' : 'I'} typst \`${ty}\` vs latex \`${tex}\`\n    typst: ${a}\n    latex: ${b}`)
  }
}
console.log(`typst table: ${pass}/${TYPST.length * 2} byte-identical MathML, ${passFolded}/${TYPST.length * 2} identical with paren groups folded (inline + display)`)
for (const f of fails) console.log('  DIVERGE ' + f)

// --- LaTeX coverage of the standard set (node): parse or refuse? ----------------
let parsed = 0
const refused: string[] = []
for (const [f, d] of STANDARD) { if (renderMath(f, { display: d }) !== null) parsed++; else refused.push(f) }
console.log(`standard set: ${parsed}/${STANDARD.length} parse in maths-lite; refused: ${refused.map((r) => '`' + r + '`').join(', ') || 'none'}`)

// --- the browser harness ------------------------------------------------------------
const corpus = JSON.parse(readFileSync(join(tmp, 'maths-corpus.json'), 'utf8')).corpus as Array<{ src: string; display: boolean }>
const formulas = [...corpus.map((c) => ({ src: c.src, display: c.display, from: 'corpus' })), ...STANDARD.map(([src, display]) => ({ src, display, from: 'standard' }))]
execFileSync(join(root, 'slides/node_modules/.bin/esbuild'), [join(root, 'slides/src/maths/index.ts'), '--bundle', '--format=iife', '--global-name=mathsLite', '--minify', `--outfile=${join(tmp, 'maths-harness/maths-lite.js')}`, '--log-level=error'])
copyFileSync(join(root, 'slides/node_modules/temml/dist/temml.min.js'), join(tmp, 'maths-harness/temml.min.js'))
writeFileSync(join(tmp, 'maths-harness/formulas.json'), JSON.stringify(formulas))
writeFileSync(join(tmp, 'maths-harness/typst.json'), JSON.stringify(TYPST))
writeFileSync(join(tmp, 'maths-harness/index.html'), `<!doctype html><meta charset="utf-8"><title>maths-lite vs Temml</title>
<style>body{font:20px/1.4 system-ui;margin:20px} .cell{display:inline-block;padding:8px;vertical-align:top;min-width:200px} math{font-size:28px} .row{border-bottom:1px solid #ddd;padding:6px 0} .diff{background:#fee} canvas{display:none}</style>
<script src="temml.min.js"></script><script src="maths-lite.js"></script>
<div id="out"></div>
<script>
(async () => {
  const formulas = await (await fetch('formulas.json')).json()
  // --- tree normalisation: what both engines MEAN, not how they spell it ---
  const DROP_ATTR = new Set(['class', 'data-sym', 'data-msx', 'xmlns', 'style', 'stretchy', 'form', 'lspace', 'rspace', 'accent', 'accentunder', 'largeop', 'movablelimits', 'symmetric', 'fence', 'separator', 'minsize', 'maxsize', 'mathvariant', 'displaystyle', 'scriptlevel', 'columnalign', 'rowspacing', 'columnspacing', 'linethickness', 'width', 'height', 'depth', 'voffset', 'encoding', 'display', 'mathcolor', 'mathbackground', 'href', 'id', 'aria-hidden', 'columnlines', 'rowlines', 'frame', 'notation'])
  function norm(node) {
    if (node.nodeType === 3) { const t = node.textContent.replace(/\\s+/g, ' ').trim(); return t ? { t } : null }
    if (node.nodeType !== 1) return null
    let tag = node.tagName.toLowerCase()
    let kids = [...node.childNodes].map(norm).filter(Boolean)
    // mstyle/mpadded/semantics/annotation are spelling, not structure
    if (tag === 'mstyle' || tag === 'mpadded' || tag === 'semantics') return kids.length === 1 ? kids[0] : { tag: 'mrow', kids }
    if (tag === 'annotation' || tag === 'annotation-xml') return null
    // Temml wraps a lone fenced group in mrow; flatten single-child mrows and
    // splice nested mrows inside mrows (an mrow of mrows is one mrow)
    if (tag === 'mrow') {
      kids = kids.flatMap((k) => (k.tag === 'mrow' ? k.kids : [k]))
      if (kids.length === 1) return kids[0]
      if (kids.length === 0) return null
    }
    // invisible operators (function application U+2061, invisible times U+2062) and
    // zero-width mspace are layout hints, not content
    if (tag === 'mo' && kids.length === 1 && kids[0].t && /^[\\u2061\\u2062\\u2063\\u200b]$/.test(kids[0].t)) return null
    if (tag === 'mspace') return null
    // mtd may wrap a single child in mrow on one side
    const attrs = {}
    for (const a of node.attributes) if (!DROP_ATTR.has(a.name)) attrs[a.name] = a.value
    // mi/mo text: fold the mathvariant-normal question — compare code points only
    return { tag, kids, ...(Object.keys(attrs).length ? { attrs } : {}) }
  }
  const treeOf = (html) => {
    const d = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html')
    const m = d.querySelector('math')
    return m ? JSON.stringify(norm(m)) : null
  }
  // --- rasterise: same font, 4x, compare ink
  const W = 1200, H = 300
  async function raster(html) {
    // the SVG is XML: a <math> without its namespace is an XHTML element
    // there and paints as text (Temml omits xmlns; a browser DOM does not care)
    html = html.replace(/<math(?![^>]*xmlns)/g, '<math xmlns="http://www.w3.org/1998/Math/MathML"')
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="font:56px serif;color:#000;padding:20px;display:inline-block">' + html + '</div></foreignObject></svg>'
    const img = new Image()
    // a data: URL, not a blob: URL — Chrome taints a canvas drawn from a
    // blob-URL SVG that carries foreignObject; from a data: URL it does not
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url })
    const c = document.createElement('canvas'); c.width = W; c.height = H
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.drawImage(img, 0, 0)
    return g.getImageData(0, 0, W, H).data
  }
  // Compare INK, aligned on its bounding box: where a formula sits in the
  // box is the wrapper's business (Temml's <span class="temml"> vs a bare
  // <math>), not the engine's. The size difference of the two boxes is
  // reported separately as the honest "does it lay out the same" number.
  const dark = (d, i) => d[i] < 224 || d[i + 1] < 224 || d[i + 2] < 224
  function bbox(d) {
    let x0 = W, y0 = H, x1 = -1, y1 = -1
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (dark(d, (y * W + x) * 4)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
    return x1 < 0 ? null : { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
  }
  function pixelDiff(a, b) {
    const ba = bbox(a), bb = bbox(b)
    if (!ba || !bb) return { pct: ba === bb ? 0 : 100, size: 0 }
    const w = Math.max(ba.w, bb.w), h = Math.max(ba.h, bb.h)
    let ink = 0, diff = 0
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const ia = x < ba.w && y < ba.h && dark(a, ((ba.y0 + y) * W + ba.x0 + x) * 4)
      const ib = x < bb.w && y < bb.h && dark(b, ((bb.y0 + y) * W + bb.x0 + x) * 4)
      if (ia || ib) ink++
      if (ia !== ib) diff++
    }
    const size = Math.max(Math.abs(ba.w - bb.w) / w, Math.abs(ba.h - bb.h) / h) * 100
    return { pct: ink ? (100 * diff) / ink : 0, size }
  }
  const out = document.getElementById('out')
  const results = []
  for (const f of formulas) {
    let tem = null, lite = null, temErr = null
    try { tem = temml.renderToString(f.src, { displayMode: f.display, throwOnError: true, trust: false }) } catch (e) { temErr = String(e.message || e) }
    lite = mathsLite.renderMath(f.src, { display: f.display })
    const r = { src: f.src, display: f.display, from: f.from, temml: !!tem, lite: !!lite, treeSame: null, pixel: null, temErr }
    if (tem && lite) {
      const ta = treeOf(tem), tb = treeOf(lite)
      r.treeSame = ta === tb
      if (!r.treeSame) { r.treeA = ta; r.treeB = tb }
      try { const d = pixelDiff(await raster(tem), await raster(lite)); r.pixel = +d.pct.toFixed(2); r.size = +d.size.toFixed(1) } catch (e) { r.pixel = -1; r.rasterErr = String(e) }
    }
    results.push(r)
    const row = document.createElement('div'); row.className = 'row' + (r.treeSame === false || (r.pixel ?? 0) >= 0.5 ? ' diff' : '')
    row.innerHTML = '<code>' + f.src.replace(/</g, '&lt;') + '</code><br><span class="cell">' + (tem ?? '<i>temml refused</i>') + '</span><span class="cell">' + (lite ?? '<i>lite refused</i>') + '</span><small>' + (r.treeSame === null ? '' : (r.treeSame ? 'tree =' : 'tree ≠') + ' · ink ' + r.pixel + '% · size ' + r.size + '%') + '</small>'
    out.appendChild(row)
  }
  window.__results = results
  const both = results.filter((r) => r.temml && r.lite)
  window.__summary = {
    total: results.length, bothRender: both.length, temmlOnly: results.filter((r) => r.temml && !r.lite).length, liteOnly: results.filter((r) => !r.temml && r.lite).length, neither: results.filter((r) => !r.temml && !r.lite).length,
    treeIdentical: both.filter((r) => r.treeSame).length, visualIdentical: both.filter((r) => r.pixel !== null && r.pixel >= 0 && r.pixel < 0.5).length,
    pctTree: +(100 * both.filter((r) => r.treeSame).length / both.length).toFixed(1), pctVisual: +(100 * both.filter((r) => r.pixel !== null && r.pixel >= 0 && r.pixel < 0.5).length / both.length).toFixed(1),
  }
  document.title = 'done'
})()
</script>`)
console.log(`harness: ${join(tmp, 'maths-harness')} — ${formulas.length} formulas (${corpus.length} corpus + ${STANDARD.length} standard)`)
