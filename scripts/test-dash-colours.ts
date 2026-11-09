#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash: a colour from the document draws only as a colour.
//
//   node scripts/test-dash-colours.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. Every dash surface that paints a colour the FILE chose —
// a conditional format's background or text colour, a colour-scale stop, a
// data bar, a chart series on a dashboard tile — builds markup as a string,
// and a colour is author data. Each paint path is driven here with values
// that are not colours (a quote that would end the attribute, a `;` that
// would start a declaration, `url(` that would fetch, `}` that would leave the
// rule) and must draw nothing of them; and each path is driven with a real
// colour first — the POSITIVE CONTROL — which must arrive intact, so a path
// that drew nothing at all could not pass.
//
// The browser half (test-dash-colours-browser.mjs) opens a built file whose
// rules carry these values and hovers the cells.

import { registerHooks } from 'node:module'

// dashboard.ts imports its stylesheet — Vite's job, not Node's.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const { safeColor } = await import('../dash/src/color.ts')
const { condCellCss, dataBarHtml, evaluateRules, mixColors, colorScale } = await import('../dash/src/condfmt.ts')
const { optionFor } = await import('../dash/src/chart.ts')
const { _internals } = await import('../dash/src/dashboard.ts')
const { styleColor } = await import('../dash/src/print.ts')
const { cssColor } = await import('../dash/src/preview.ts')
type TableSheet = import('../dash/src/model.ts').TableSheet
type Rule = import('../dash/src/condfmt.ts').Rule

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// Real colours, in every notation the app or a hand edit writes.
const GOOD = ['#ff0000', '#abc', '#11223344', 'rgba(1, 2, 3, 0.5)', 'hsl(120 50% 50% / 0.5)', 'red', 'transparent', 'var(--accent)']
// Not colours. Each one is something a string-built attribute or style would
// otherwise carry out of the colour's slot. MARK is what a test looks for.
const MARK = 'zqmark'
const BAD = [
  `x" onmouseover="${MARK}()`,
  `#f00" onmouseover="${MARK}()`,
  `x' onmouseover='${MARK}()`,
  `red;background:url(https://e.invalid/${MARK})`,
  `url(https://e.invalid/${MARK})`,
  `#fff}body{${MARK}:none`,
  `expression(${MARK}())`,
  `red\\3b ${MARK}`,
  `red<img src=x onerror=${MARK}()>`,
  `@import ${MARK}`,
  `#${'a'.repeat(30)}${MARK}`,
]
const NOT_STRINGS: unknown[] = [42, null, undefined, { toString: () => MARK }, [MARK]]

/** `s` carries no part of a hostile value out of its slot. */
const clean = (s: string): boolean => !s.includes(MARK) && !/onmouseover|onerror|url\(|expression|[{};]\s*zq/i.test(s)

// --- 1. the rule itself --------------------------------------------------------
for (const c of GOOD) ok(safeColor(c) === c, `safeColor keeps a colour: ${c}`)
for (const c of BAD) ok(safeColor(c) === null, `safeColor refuses: ${c}`)
for (const c of NOT_STRINGS) ok(safeColor(c) === null, `safeColor refuses a non-string: ${String(c)}`)
// preview and print delegate to it now; a regression in either is a regression here
ok(cssColor(BAD[0], '#123456') === '#123456' && cssColor('#abcdef', '#123456') === '#abcdef',
  'preview cssColor falls back on a non-colour and keeps a colour')
ok(styleColor(BAD[3]) === null && styleColor('#abcdef') === '#abcdef',
  'print styleColor refuses a non-colour and keeps a colour')

// --- 2. a conditional format's cell CSS (grid paint) ----------------------------
// The attribute it lands in is `style="…"`, so the fragment must hold no quote.
ok(condCellCss({ bg: '#ff0000', color: '#00ff00', bold: true }) === ';background:#ff0000;color:#00ff00;font-weight:600',
  'condCellCss: control — background, colour and weight all arrive')
for (const c of BAD) {
  const bg = condCellCss({ bg: c })
  ok(bg === '' && clean(bg), `condCellCss bg refuses: ${c}`)
  const fg = condCellCss({ color: c })
  ok(fg === '' && clean(fg), `condCellCss color refuses: ${c}`)
}
ok(condCellCss({ bg: BAD[0], color: '#00ff00' }) === ';color:#00ff00',
  'condCellCss: a bad background does not take the good colour down with it')
ok(condCellCss({ color: BAD[0], bg: '#ff0000' }) === ';background:#ff0000',
  'condCellCss: a bad colour does not take the good background down with it')

// --- 3. a data bar (grid paint) -------------------------------------------------
const quotes = (s: string): number => (s.match(/"/g) ?? []).length
{
  const h = dataBarHtml({ bar: { pct: 40, color: '#3366ff', axis: 10 } })
  ok(h === '<span class="dg-bar" style="left:10%;width:40%;background:#3366ff"></span>',
    `dataBarHtml: control — position, width and colour arrive (${h})`)
  const n = dataBarHtml({ bar: { pct: 25, color: '#3366ff', axis: 50, negative: true } })
  ok(n.includes('left:25%;width:25%'), `dataBarHtml: a negative bar runs left of the axis (${n})`)
}
for (const c of BAD) {
  const h = dataBarHtml({ bar: { pct: 40, color: c, axis: 0 } })
  ok(clean(h) && quotes(h) === 4 && h.includes('width:40%'), `dataBarHtml colour refuses, bar still drawn: ${c}`)
}
{
  const h = dataBarHtml({ bar: { pct: `1" onmouseover="${MARK}()` as unknown as number, color: '#fff', axis: `x;${MARK}` as unknown as number } })
  ok(clean(h) && quotes(h) === 4, `dataBarHtml: a width or axis that is not a number draws as 0 (${h})`)
}
ok(dataBarHtml(null) === '' && dataBarHtml({ bg: '#fff' }) === '', 'dataBarHtml: no bar, no markup')

// --- 4. rules out of the file, through evaluation, into the CSS ------------------
// The path the grid actually takes: document rule → evaluateRules → condCellCss
// / dataBarHtml, starting with a colour-scale stop.
const VALS = [10, 20, 30, 40, 50]
const paint = (rules: Rule[]): string[] => evaluateRules(rules, VALS).map((s) => condCellCss(s) + dataBarHtml(s))
{
  const ctrl = paint([{ kind: 'colorScale', colors: ['#ff0000', '#00ff00'] }])
  ok(ctrl[0].includes('background:#ff0000') && ctrl[4].includes('background:#00ff00'),
    `colour scale: control — the stops paint the ends (${ctrl[0]} … ${ctrl[4]})`)
}
for (const c of BAD) {
  for (const colors of [[c, '#00ff00'], ['#ff0000', c], ['#ff0000', c, '#00ff00'], [c, c]]) {
    const out = paint([{ kind: 'colorScale', colors } as Rule])
    ok(out.every(clean), `colour scale ${JSON.stringify(colors)} draws nothing of it`)
  }
  ok(clean(mixColors(c, '#000000', 0.2)) && clean(mixColors('#000000', c, 0.8)),
    `mixColors does not snap to a stop that is not a colour: ${c}`)
}
ok(mixColors('red', '#000000', 0.2) === 'red', 'mixColors: control — an unparseable REAL colour still snaps to itself')
ok(colorScale([1, 2], ['red', 'blue'])[0] === 'red', 'colorScale: control — named stops still paint')
{
  const ctrl = paint([{ kind: 'dataBar', color: '#3366ff' }])
  ok(ctrl[4].includes('background:#3366ff'), `data bar rule: control — the colour arrives (${ctrl[4]})`)
  for (const c of BAD) {
    ok(paint([{ kind: 'dataBar', color: c }]).every(clean), `data bar rule colour draws nothing of it: ${c}`)
    ok(evaluateRules([{ kind: 'dataBar', color: '#fff', negativeColor: c }], [-5, 5])
      .map((s) => dataBarHtml(s)).every(clean), `data bar negative colour draws nothing of it: ${c}`)
  }
}
{
  const style = { bg: '#ff0000', color: '#00ff00' }
  const ctrl = paint([{ kind: 'cellValue', op: '>', value: 25, style }])
  ok(ctrl[4].includes('background:#ff0000;color:#00ff00') && ctrl[0] === '',
    `cell-value rule: control — the style paints the matches only (${ctrl[4]})`)
  for (const c of BAD) {
    const kinds: Rule[] = [
      { kind: 'cellValue', op: '>', value: 0, style: { bg: c, color: c } },
      { kind: 'topN', n: 2, style: { bg: c, color: c } },
      { kind: 'duplicates', style: { bg: c, color: c } },
    ]
    for (const r of kinds) ok(paint([r]).every(clean), `${r.kind} rule style draws nothing of: ${c}`)
  }
}

// --- 5. a chart binding's colours (the option every chart surface draws) --------
const sheet = (): TableSheet => ({
  id: 'sh', name: 'S', kind: 'table',
  rids: [[1, 4]],
  columns: [
    { id: 'region', name: 'Region', type: 'text', w: 120 },
    { id: 'a', name: 'A', type: 'number', w: 120 },
    { id: 'b', name: 'B', type: 'number', w: 120 },
  ],
  data: {
    region: { enc: 'dict', dict: ['North', 'South'], idx: [0, 1, 0, 1] },
    a: { enc: 'raw', v: [1, 2, 3, 4] },
    b: { enc: 'raw', v: [5, 6, 7, 8] },
  },
  steps: [],
} as unknown as TableSheet)
{
  const o = optionFor(sheet(), { x: 'region', series: ['a', 'b'], kind: 'bar', aggregate: 'sum', colors: { a: '#123456', b: 'teal' } })
  ok(JSON.stringify(o.color) === JSON.stringify(['#123456', 'teal']), `chart binding: control — chosen colours arrive (${JSON.stringify(o.color)})`)
}
for (const c of BAD) {
  const o = optionFor(sheet(), { x: 'region', series: ['a', 'b'], kind: 'bar', aggregate: 'sum', colors: { a: c, b: '#123456' } })
  const cols = o.color as string[]
  ok(clean(JSON.stringify(cols)) && cols[1] === '#123456' && typeof cols[0] === 'string' && safeColor(cols[0]) === cols[0],
    `chart binding colour falls back to the palette: ${c}`)
}

// --- 6. a dashboard tile's SVG and legend ---------------------------------------
// Fed a tile whose colours are NOT colours directly, so each drawing site is
// held on its own and not only through the binding guard above.
const pick = { tile: 't1', col: 'region' }
const tile = (chart: 'bar' | 'line' | 'pie', colors: string[], series = 2) => ({
  kind: 'chart' as const, chart, cats: ['North', 'South'], rows: 4, colors,
  series: Array.from({ length: series }, (_, i) => ({ name: `S${i}`, data: [3 + i, 5 + i] })),
})
for (const chart of ['bar', 'line', 'pie'] as const) {
  const ctrl = _internals.chartSvg(tile(chart, ['#123456', '#654321']), pick, new Set())
  ok(ctrl.includes('#123456') && (chart === 'pie' || ctrl.includes('#654321')),
    `dashboard ${chart}: control — the series colours are drawn`)
  for (const c of BAD) {
    const svg = _internals.chartSvg(tile(chart, [c, c]), pick, new Set())
    ok(clean(svg) && svg.includes('#888'), `dashboard ${chart} draws grey, nothing of: ${c}`)
  }
}
{
  // the legend's style="background:…" — only drawn for several series
  const ctrl = _internals.chartSvg(tile('bar', ['#123456', '#654321']), pick, new Set())
  ok(/<i style="background:#123456">/.test(ctrl), 'dashboard legend: control — the swatch colour is drawn')
  for (const c of BAD) {
    const svg = _internals.chartSvg(tile('bar', ['#123456', c]), pick, new Set())
    const legend = svg.slice(0, svg.indexOf('<svg'))
    ok(clean(legend) && legend.includes('background:#888'), `dashboard legend swatch draws grey, nothing of: ${c}`)
  }
}

console.log(`\n${checks - failures}/${checks} passed${failures ? `, ${failures} FAILED` : ''}`)
process.exit(failures ? 1 : 0)
