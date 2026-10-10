#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash conditional-formatting rig.
//
//   node scripts/test-dash-condfmt.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. Conditional formatting is the feature people reach for
// straight after totals, and every one of its failures is SILENT — a colour is
// never obviously wrong the way a number is, so nothing here can be caught by
// looking at the grid:
//
//   1. DEGENERATE DATA. An empty column, an all-equal column, a column of text.
//      Each one is a 0/0 waiting to happen, and NaN reaches CSS as
//      `#NaNNaNNaN` — which paints nothing, on the day the data went flat.
//   2. A MUDDY MIDPOINT. Averaging sRGB BYTES loses about half the luminance
//      in the middle of a ramp, so red→green peaks at a dark olive-brown
//      instead of yellow. It looks like a design choice rather than a bug,
//      which is why it survives in so many heatmaps.
//   3. BARS ANCHORED AT THE LEFT EDGE. Map each value onto (v − min)/(max − min)
//      from the left and the most negative row draws a bar of length ZERO —
//      invisible, and it is the row that most needs to be seen.
//   4. A RULE THAT SILENTLY DOES NOTHING. First-match-wins means a colour scale
//      and a "negatives in red" rule cannot coexist: one of them is discarded
//      and the author is never told which.
//
// So each of those is asserted BOTH ways: the right answer lands, and the
// plausible wrong answer is refused by name.

import {
  colorScale, dataBarWidths, evaluateRules, mixColors,
  type CellStyle, type CompareOp, type Rule,
} from '../dash/src/condfmt.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps
const isHex = (s: string): boolean => /^#[0-9a-f]{6}$/.test(s)
const noNaN = (s: string): boolean => !/nan/i.test(s)

// ------------------------------------------------------- the empty column
// Every entry point takes the empty array, because a filtered-to-nothing view
// is a normal state of the grid, not an error one.
{
  ok(colorScale([], ['#ff0000', '#00ff00']).length === 0,
    'an empty value set gives an empty colour list — no divide by zero')
  ok(dataBarWidths([]).length === 0, 'and an empty bar list')
  const rules: Rule[] = [
    { kind: 'colorScale', colors: ['#ff0000', '#ffff00', '#00aa00'] },
    { kind: 'dataBar', color: '#4488cc' },
    { kind: 'cellValue', op: '>', value: 0, style: { bold: true } },
    { kind: 'topN', n: 3, style: { bold: true } },
    { kind: 'duplicates', style: { italic: true } },
    { kind: 'formula', expr: 'value > 1', style: { color: '#fff' } },
  ]
  ok(evaluateRules(rules, []).length === 0,
    'every rule kind survives an empty column without throwing')
}

// ---------------------------------------------------- the all-equal column
{
  const c = colorScale([7, 7, 7], ['#ff0000', '#ffff00', '#00aa00'])
  ok(c.every(noNaN), 'all-equal values produce no NaN in a colour scale')
  ok(c.every((x) => x === c[0]) && isHex(c[0]), 'and one uniform, valid colour')
  ok(c[0] === '#ffff00',
    'which is the MID colour: with no spread nothing is lowest and nothing is highest')

  const b = dataBarWidths([5, 5, 5])
  ok(b.every((w) => Number.isFinite(w.pct)), 'all-equal values produce no NaN percentages')
  ok(b.every((w) => w.pct === 100),
    'and full bars — the domain includes zero, so 5 of a 0..5 range is the whole width')
  ok(b.every((w) => w.axis === 0), 'zero sits at the left edge when nothing is negative')

  const z = dataBarWidths([0, 0, 0])
  ok(z.every((w) => w.pct === 0 && Number.isFinite(w.pct)),
    'an all-ZERO column draws nothing rather than dividing 0 by 0')
}

// -------------------------------------------------- a column with no numbers
{
  const c = colorScale(['north', 'south', null], ['#ff0000', '#00ff00'])
  ok(c.every((x) => x === ''), 'text has no position on a numeric scale, so it gets NO colour')
  ok(!c.includes('#ff0000'),
    'and specifically NOT the low colour, which would claim "this is the smallest value"')
  const b = dataBarWidths(['x', null, 3])
  ok(b[0].pct === 0 && b[1].pct === 0 && b[2].pct === 100, 'non-numeric rows draw no bar')
}

// ------------------------------------------------ gamma-correct interpolation
{
  const mid = mixColors('#ff0000', '#00ff00', 0.5)
  ok(mid === '#bcbc00', `red→green at the midpoint is #bcbc00 (got ${mid})`)
  ok(mid !== '#808000',
    'and NOT #808000 — the byte average, a dark olive-brown that is half the light')
  ok(parseInt(mid.slice(1, 3), 16) > 128,
    'the linear-light midpoint is brighter than the naive one, which is the whole point')
  ok(mixColors('#ff0000', '#00ff00', 0) === '#ff0000'
    && mixColors('#ff0000', '#00ff00', 1) === '#00ff00',
    'the endpoints round-trip EXACTLY through the encode/decode — no drift at a stop')
  ok(mixColors('#000000', '#ffffff', 0.5) === '#bcbcbc',
    'mid grey is #bcbc — 50% LIGHT, not 50% of the byte')
  ok(mixColors('#ff0000', '#00ff00', -3) === '#ff0000'
    && mixColors('#ff0000', '#00ff00', 9) === '#00ff00', 't outside [0,1] clamps')
  ok(mixColors('#f00', '#0f0', 0.5) === mid, 'three-digit hex expands')
  ok(mixColors('#FF0000', '#00FF00', 0.5) === mid, 'and uppercase normalises')
  ok(mixColors('rgb(255, 0, 0)', 'rgb(0, 255, 0)', 0.5) === mid, 'rgb() parses too')
  ok(mixColors('#ff000000', '#ff0000ff', 0.5) === 'rgba(255, 0, 0, 0.5)',
    'alpha interpolates LINEARLY — it is coverage, not light')
  ok(mixColors('rebeccapurple', '#00ff00', 0.2) === 'rebeccapurple',
    'an unresolvable colour snaps to the nearest stop rather than inventing black')
}

// ------------------------------------------------------------- colour scales
{
  const stops: [string, string, string] = ['#ff0000', '#ffff00', '#00aa00']
  const c = colorScale([0, 50, 100], stops)
  ok(c[1] === '#ffff00', 'a scale over [0,50,100] gives the EXACT mid colour at 50')
  ok(c[0] === '#ff0000' && c[2] === '#00aa00', 'and the exact end colours at the ends')
  ok(c.every(isHex), 'every colour is a valid six-digit hex')

  const two = colorScale([0, 50, 100], ['#ff0000', '#00ff00'])
  ok(two[1] === '#bcbc00', 'a TWO-stop scale blends gamma-correctly at its middle value')
  ok(two[1] !== '#808000', 'and does not fall back to the byte average')

  // an off-centre mid: pinning neutral to zero on a −20..+300 column
  const div = colorScale([-20, 0, 300], stops, { mid: 0 })
  ok(div[1] === '#ffff00', 'an explicit mid VALUE puts the neutral colour on that value')
  ok(div[0] === '#ff0000' && div[2] === '#00aa00', 'with both ramps still reaching their ends')
  ok(colorScale([140], stops, { min: -20, max: 300 })[0] === '#ffff00'
    && colorScale([0], stops, { min: -20, max: 300 })[0] !== '#ffff00',
    'and without it the neutral colour lands on 140, the midpoint of the range — not on zero')

  const pinned = colorScale([5, 500], stops, { min: 0, max: 100 })
  ok(pinned[1] === '#00aa00', 'a value above an explicit max clamps to the top colour')
  ok(pinned.every(isHex), 'clamping keeps every channel in range — no #ff01ff overflow')
  ok(colorScale([-999], stops, { min: 0, max: 100 })[0] === '#ff0000',
    'and below an explicit min clamps to the bottom colour')

  const mixed = colorScale([1, 'n/a', 9], ['#ff0000', '#00ff00'])
  ok(mixed[1] === '' && mixed[0] === '#ff0000' && mixed[2] === '#00ff00',
    'a text row is skipped and does not drag the extent')
  ok(colorScale([1, 2], ['#ff0000', '#00ff00'])[1] === '#00ff00',
    'a NaN-free extent: the max of the numeric values sets the top, not the text')
}

// ---------------------------------------------------------------- data bars
{
  const sym = dataBarWidths([-100, 100])
  ok(sym[0].axis === 50 && sym[1].axis === 50,
    'with symmetric negatives, ZERO sits in the MIDDLE of the cell')
  ok(sym[0].axis !== 0,
    'and NOT at the left edge — the naive answer, which hides the sign entirely')
  ok(sym[0].negative === true && sym[1].negative === false, 'the sign is reported per row')
  ok(sym[0].pct === 50 && sym[1].pct === 50, 'both bars run 50% of the width from the axis')

  const b = dataBarWidths([-50, 0, 100])
  ok(near(b[0].axis, 100 / 3), 'an asymmetric column puts zero at |min|/(|min|+max) = 33.3%')
  ok(b[0].pct > 0,
    'the MOST NEGATIVE value gets a visible bar — left-anchored scaling gives it zero length')
  ok(near(b[0].pct, b[2].pct / 2),
    'one shared scale: a −50 bar is exactly half a +100 bar')
  ok(!near(b[0].pct, b[2].pct),
    'and NOT the same length, which per-side normalisation would give')
  ok(b[1].pct === 0 && b[1].negative === false, 'a zero value sits on the axis with no bar')
  ok(b.every((w) => (w.negative ? w.pct <= w.axis + 1e-9 : w.axis + w.pct <= 100 + 1e-9)),
    'no bar overflows its side of the axis')
  // The old check compared entries to each other, but `axis` is computed once
  // outside the map and closed over — two entries cannot differ without a
  // refactor, so it could not fail. Check the VALUE instead: an all-positive
  // set puts the axis hard left, which is what "no negatives, no split bar"
  // means, and a naive implementation that always centres it fails here.
  const allPos = dataBarWidths([10, 20, 30])
  ok(allPos.every((w) => w.axis === 0),
    'an all-positive set puts the zero axis at the LEFT edge — an implementation that always centres it fails here')
  ok(allPos[2].pct === 100 && allPos[0].pct > 0,
    'and the largest fills the width while the smallest still shows')

  const neg = dataBarWidths([-5, -1])
  ok(neg[0].axis === 100, 'an all-negative column puts zero at the RIGHT edge')
  ok(neg[0].pct === 100 && neg[1].pct === 20, 'and scales the bars leftwards from it')

  const pos = dataBarWidths([10, 20])
  ok(pos[0].pct === 50 && pos[1].pct === 100,
    'an all-positive column measures from ZERO, so 10 is half of 20')
  ok(pos[0].pct !== 0,
    'not from the minimum — that would make the smallest value invisible')

  const fixed = dataBarWidths([50, 500], { min: 0, max: 100 })
  ok(fixed[0].pct === 50 && fixed[1].pct === 100, 'an explicit domain clamps rather than rescales')
}

// ---------------------------------------------------- composition, not shadow
{
  const scale: Rule = { kind: 'colorScale', colors: ['#ffffff', '#000000'] }
  const negatives: Rule = { kind: 'cellValue', op: '<', value: 0, style: { color: '#cc0000', bold: true } }
  const out = evaluateRules([scale, negatives], [-1, 1])
  ok(out[0]?.bg === '#ffffff', 'the earlier rule KEEPS its background under a later match')
  ok(out[0]?.color === '#cc0000' && out[0]?.bold === true, 'and the later rule adds its own properties')
  ok(!(out[0]?.bg === undefined),
    'first-match-wins would have discarded the scale silently — refused')
  ok(out[1]?.bg === '#000000' && out[1]?.color === undefined,
    'a row the later rule does not match keeps only the scale')

  const a: Rule = { kind: 'cellValue', op: '>', value: 0, style: { bg: '#111111' } }
  const b: Rule = { kind: 'cellValue', op: '>', value: 0, style: { bg: '#222222' } }
  ok(evaluateRules([a, b], [1])[0]?.bg === '#222222', 'the LAST rule to set a property wins it')
  ok(evaluateRules([b, a], [1])[0]?.bg === '#111111', 'so order is meaningful')

  // the shape a UI produces after clearing a field
  const cleared: Rule = { kind: 'cellValue', op: '>', value: 0, style: { bg: undefined, bold: true } as CellStyle }
  const kept = evaluateRules([a, cleared], [1])[0]
  ok(kept?.bg === '#111111',
    'an explicit `bg: undefined` in a later style does NOT erase an earlier background')
  ok(kept?.bold === true, 'while its defined properties still apply')

  ok(evaluateRules([negatives], [5])[0] === null, 'a row no rule matches is null, not an empty style')

  const style = { bold: true }
  const got = evaluateRules([{ kind: 'topN', n: 1, style }], [1])[0]!
  got.bold = false
  ok(style.bold === true, 'the returned style is a COPY — a caller cannot mutate the rule')

  const unknown = { kind: 'sparkline', style: { bold: true } } as unknown as Rule
  ok(evaluateRules([unknown, negatives], [-1])[0]?.color === '#cc0000',
    'a rule kind from a later build is ignored, and the rules around it still apply')

  // Rules are DOCUMENT data: a hand-edited file can put anything in the list,
  // and this runs in the grid's paint path, where a throw blanks the grid.
  const junk = [
    null, 'nonsense', { kind: 'colorScale' }, { kind: 'colorScale', colors: ['#ff0000'] },
    { kind: 'cellValue', op: '>', value: 0 }, { kind: 'topN', n: 1 },
  ] as unknown as Rule[]
  ok(evaluateRules([...junk, negatives], [-1])[0]?.color === '#cc0000',
    'malformed rules are skipped rather than thrown on, and the valid ones still apply')
  ok(colorScale([1, 2], ['#ff0000'] as unknown as [string, string]).every((x) => x === ''),
    'a ramp with fewer than two stops has nothing to interpolate, so it gives no colour')
}

// ------------------------------------------------------------ cell-value ops
{
  const style = { bold: true }
  const hit = (op: CompareOp, value: unknown, vals: unknown[], to?: unknown) =>
    JSON.stringify(evaluateRules([{ kind: 'cellValue', op, value, to, style }], vals)
      .map((s) => s !== null))

  ok(hit('>', 10, [9, 10, 11]) === '[false,false,true]', '>')
  ok(hit('>=', 10, [9, 10, 11]) === '[false,true,true]', '>=')
  ok(hit('<>', 10, [9, 10]) === '[true,false]', '<>')
  ok(hit('between', 10, [9, 10, 15, 20, 21], 20) === '[false,true,true,true,false]',
    'between is inclusive at both ends')
  ok(hit('between', 20, [15], 10) === '[true]',
    'and sorts its bounds — a reversed pair is a typo, not an empty set')
  ok(hit('contains', 'ACME', ['acme ltd', 'other']) === '[true,false]', 'contains is case-insensitive')
  ok(hit('contains', '', ['anything']) === '[false]',
    'an EMPTY needle matches nothing — a rule that would light up every cell is refused')
  ok(hit('startsWith', 'a', ['abc', 'bac']) === '[true,false]', 'startsWith')
  ok(hit('endsWith', 'c', ['abc', 'cba']) === '[true,false]', 'endsWith')
  ok(hit('blank', undefined, [null, '', '  ', 0, 'x']) === '[true,true,true,false,false]',
    'blank counts null and whitespace, but NOT zero')
  ok(hit('notBlank', undefined, [null, 0]) === '[false,true]', 'notBlank')
  ok(hit('>', 9, ['10']) === '[true]',
    'numeric TEXT compares numerically — "10" > 9, not lexically less than "9"')
  ok(hit('>', 'b', ['c', 'a']) === '[true,false]', 'and text against text compares lexically')
}

// --------------------------------------------------------------- top / bottom
{
  const style = { bold: true }
  const top = (n: number, vals: unknown[], bottom?: boolean) =>
    evaluateRules([{ kind: 'topN', n, ...(bottom ? { bottom } : {}), style }], vals)
      .map((s) => s !== null)

  ok(JSON.stringify(top(2, [5, 1, 9, 7])) === '[false,false,true,true]', 'top 2 is 9 and 7')
  ok(JSON.stringify(top(2, [5, 1, 9, 7], true)) === '[true,true,false,false]',
    'bottom 2 is 1 and 5 — the same sort read from the other end')
  ok(JSON.stringify(top(1, [10, 10, 9])) === '[true,true,false]',
    'a TIE for the last place is included — picking one of two identical numbers would')
  ok(JSON.stringify(top(1, [10, 10, 9])) !== '[true,false,false]',
    'show a difference in the grid that does not exist in the data')
  ok(JSON.stringify(top(9, [1, 2])) === '[true,true]', 'n larger than the column takes everything')
  ok(JSON.stringify(top(0, [1, 2])) === '[false,false]', 'n of 0 takes nothing')
  ok(JSON.stringify(top(-1, [1, 2])) === '[false,false]', 'and a negative n does not throw')
  ok(JSON.stringify(top(1, ['a', 'b'])) === '[false,false]', 'a column with no numbers has no top')
  ok(JSON.stringify(top(1, [3, 'zzz'])) === '[true,false]', 'text never outranks a number')
}

// ----------------------------------------------------------------- duplicates
{
  const style = { italic: true }
  const dup = (vals: unknown[]) =>
    evaluateRules([{ kind: 'duplicates', style }], vals).map((s) => s !== null)

  ok(JSON.stringify(dup(['a', 'b', 'a'])) === '[true,false,true]', 'both copies are flagged')
  ok(JSON.stringify(dup(['ACME', 'acme '])) === '[true,true]',
    'case and surrounding space do not make two values different to the eye')
  ok(JSON.stringify(dup([null, '', null, 'x'])) === '[false,false,false,false]',
    'BLANKS are never duplicates — absence repeated is still absence')
  ok(JSON.stringify(dup([1, 2, 3])) === '[false,false,false]', 'a unique column flags nothing')
}

// -------------------------------------------------------------- formula rules
{
  const style = { bold: true }
  const f = (expr: string, vals: unknown[], cols?: Record<string, unknown[]>) =>
    evaluateRules([{ kind: 'formula', expr, style }], vals, cols).map((s) => s !== null)

  ok(JSON.stringify(f('value > 10', [9, 11])) === '[false,true]', 'the column is bound to `value`')
  ok(JSON.stringify(f('VALUE > 10', [9, 11])) === '[false,true]', 'and the name is case-insensitive')
  ok(JSON.stringify(f('value > AVERAGE(value)', [1, 2, 3])) === '[false,false,true]',
    'an aggregate mixes with the per-row value in ONE vectorised pass')
  ok(JSON.stringify(f('MOD(value,2)=0', [1, 2, 3, 4])) === '[false,true,false,true]',
    'the whole function library is available')
  ok(JSON.stringify(f('value > [Target]', [8, 12], { Target: [10, 10] })) === '[false,true]',
    'a cross-column rule compares against another column when the caller passes one')
  ok(JSON.stringify(f('1/0', [1, 2])) === '[false,false]',
    'an ERROR never matches — a formatting rule must not paint on a wrong answer')
  ok(JSON.stringify(f('Nope > 1', [1])) === '[false]', 'nor does an unknown column reference')
  ok(JSON.stringify(f('UPPER(value)', ['a', 'b'])) === '[false,false]',
    'a non-empty STRING is not true — JS truthiness would light up the whole column')
  ok(JSON.stringify(f('"true"', [1])) === '[true]', 'but the word "true" is')
  ok(JSON.stringify(f('1=1', [1, 2])) === '[true,true]',
    'a scalar result broadcasts to every row')
  ok(JSON.stringify(f(')(nonsense', [1])) === '[false]', 'and an unparseable expression matches nothing')
}

// ------------------------------------------------------------- the bar style
{
  const rule: Rule = { kind: 'dataBar', color: '#4488cc', negativeColor: '#cc4444' }
  const out = evaluateRules([rule], [-50, 0, 100])
  ok(out[0]?.bar?.color === '#cc4444' && out[2]?.bar?.color === '#4488cc',
    'negatives take the negative colour')
  ok(out[0]?.bar?.negative === true && out[2]?.bar?.negative === undefined,
    'and carry the direction flag')
  ok(near(out[0]?.bar?.axis ?? -1, 100 / 3),
    'the axis rides on the cell style — a renderer sees one row at a time and cannot recompute it')
  ok(evaluateRules([{ kind: 'dataBar', color: '#4488cc' }], [-1])[0]?.bar?.color === '#4488cc',
    'without a negative colour, negatives use the one colour given')
  ok(evaluateRules([rule], ['text'])[0] === null, 'a non-numeric row gets no bar style at all')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
