#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Connectors for diagrams (#302 curved connectors, #303 tip styles, #304 the
// double-headed arrow). Bundled with esbuild in CI (tips.ts reaches the
// bezier core through an extensionless import):
//
//   slides/node_modules/.bin/esbuild scripts/test-slides-connectors.ts --bundle --platform=node --format=esm --outfile=/tmp/t.mjs && node /tmp/t.mjs
//
// WHAT THIS PROVES. The tip catalogue is ONE list: the model's LineEnding
// union, the shape gate, the panel's options and the renderer's markers all
// read tips.ts, so no tip can exist in one place and not another. Each tip's
// endpoint inset is positive, a hollow tip's inset is at least the depth of
// its head (the stroke stops at the back edge, nothing shows through), and
// the three original kinds keep their 2.6 (an old deck renders as before).
// The double arrow's polygon is mirror-symmetric about the box centre. The
// end-tangent of a cubic comes from the end handle, falls back to the
// neighbour's handle, then the chord. Re-routing a curved connector moves
// only its first/last on-curve point — interior points byte-identical — and
// a legacy straight connector routes exactly as it did.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { TIPS, TIP_KINDS, tipSpec, tipInsetPx, endTangent, shortenPathEnds, movePathEnds, pathEnds } from '../slides/src/tips.ts'
import { parseBezier } from '../slides/src/editor/bezier.ts'
import { borderPoint, lineEndpoints, setLineEndpoints, boxCenter, sideMidpoint, connectorEndpoint, boxAnchors, nearestAnchor, boxContains, type ConnectorSide, type Box, type Pt as GPt } from '../kernel/src/geom.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
// bundled and run from a temp dir in CI: the repo root is the cwd then
const here = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = existsSync(join(here, 'slides/src/model.ts')) ? here : process.cwd()
const read = (f: string) => readFileSync(join(root, f), 'utf8')
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps

console.log('one tip catalogue\n')
const model = read('slides/src/model.ts')
const union = /export type LineEnding = ([^\n]+)/.exec(model)![1]
const modelKinds = [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
ok(modelKinds.join() === TIP_KINDS.join(), `the model's LineEnding union is the catalogue, in order (${TIP_KINDS.length} kinds)`)
const gate = read('slides/src/untrusted.ts')
ok(/lineStart: oneOf\(\.\.\.TIP_KINDS\), lineEnd: oneOf\(\.\.\.TIP_KINDS\)/.test(gate), 'the shape gate admits exactly the catalogue')
const panels = read('slides/src/editor/panels.ts')
const editor = read('slides/src/editor/editor.ts')
ok(/TIPS\.map\(\(tip\) => \[tip\.kind, t\(tip\.label\)\]\)/.test(panels), 'the panel lists the catalogue — model words as values, translated labels for display')
ok(/el\.shape === 'line' \|\| \(el\.shape === 'path' && !\/z\\s\*\$\/i\.test/.test(panels), 'tips are offered on lines and OPEN paths, never on a polygon')
const render = read('slides/src/render.ts')
ok(/const spec = tipSpec\(kind\)/.test(render) && !/'M 0 0\.4 L 7\.6 4 L 0 7\.6 Z'/.test(render), 'the renderer builds markers from the catalogue, not from its own geometry')
ok(new Set(TIP_KINDS).size === TIP_KINDS.length, 'no duplicate kinds')
ok(TIPS.every((s) => s.label.length > 0), 'every tip has a panel label')

console.log('\ninsets\n')
for (const s of TIPS) {
  if (s.kind === 'none') { ok(s.inset === 0 && tipSpec('none') === undefined, 'none: no inset, no marker'); continue }
  ok(s.inset > 0, `${s.kind}: inset ${s.inset} > 0`)
  if (s.hollow) {
    const depth = (s.tipX - s.refX) * s.size / 8
    ok(s.inset >= depth - 0.01, `${s.kind}: hollow — inset ${s.inset} covers the head depth ${depth.toFixed(2)} so no stroke shows inside`)
  }
}
ok(tipSpec('arrow')!.inset === 2.6 && tipSpec('dot')!.inset === 2.6 && tipSpec('bar')!.inset === 2.6, 'arrow, dot, bar keep 2.6 — an old deck renders as it did')
ok(tipSpec('arrow')!.refX === 6.4 && tipSpec('arrow')!.size === 5.5, 'the original arrow keeps refX 6.4 / size 5.5')
ok(close(tipInsetPx('triangle-open', 3), tipSpec('triangle-open')!.inset * 3), 'tipInsetPx scales by the stroke width')
ok(tipInsetPx(undefined, 3) === 0 && tipInsetPx('none', 3) === 0, 'no tip → no inset')

console.log('\nthe double arrow\n')
ok(/if \(el\.heads === 2\) \{/.test(render.slice(render.indexOf("case 'arrow': {"), render.indexOf("case 'line': {"))), 'render.ts draws the two-headed polygon inside the ARROW branch')
ok(/heads: num\(2, 2\)/.test(gate), 'the gate admits heads: 2 on a shape')
ok(/heads\?: 2/.test(model), 'the model has heads?: 2 on ShapeElement')
ok(!/arrow2/.test(model) && !/arrow2/.test(gate) && !/'arrow2'/.test(render), 'no new shape kind anywhere — arrow2 is gone')
const kinds = /export type ShapeKind = ([^\n]+)/.exec(model)![1]
ok(kinds === "'rect' | 'ellipse' | 'triangle' | 'arrow' | 'line' | 'path'", 'ShapeKind is exactly what 1.1.0 knows (no new kinds — a shipped shell throws on one)')
ok(/kind: 'arrow', label: 'Double arrow', icon: ICONS\.arrow2, heads: 2/.test(editor) && /defaultShape\(item\.kind, item\.heads \? \{ heads: item\.heads \} : \{\}\)/.test(editor), 'the Shape menu makes a Double arrow as {shape: arrow, heads: 2}')
ok(/this\.row\('Double-headed', this\.toggle\(el\.heads === 2/.test(panels) && /if \(on\) s\.heads = 2; else delete s\.heads/.test(panels), 'the panel toggle writes heads: 2 and deletes it when off')
// mirror the polygon exactly as render.ts computes it
const w = 300, h = 120
const shaftH = h * 0.44, headW = Math.min(w * 0.3, h), y0 = (h - shaftH) / 2
const pts = [[0, h / 2], [headW, 0], [headW, y0], [w - headW, y0], [w - headW, 0], [w, h / 2], [w - headW, h], [w - headW, y0 + shaftH], [headW, y0 + shaftH], [headW, h]]
const mirrored = pts.map(([x, y]) => [w - x, h - y])
const key = (p: number[][]) => p.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).sort().join(' ')
ok(key(pts) === key(mirrored), 'the two-headed polygon is symmetric under a 180° turn about the box centre (a head at each end, same shape)')
ok(pts.filter(([x]) => x === 0).length === 1 && pts.filter(([x]) => x === w).length === 1, 'exactly one point on each end — the two tips')

console.log('\nwhat 1.1.0 does with a deck that uses this (frozen fixture)\n')
// FROZEN from origin/main render.ts at 3a7eb8fb (the 1.1.0 renderer). Two
// facts about that code decide what an old shell does with a new deck:
//   (1) renderShape: `let node: SVGElement` then `switch (el.shape)` with
//       these case labels and NO default — an unknown kind leaves `node`
//       unassigned and `svg.appendChild(node)` throws a TypeError, which is
//       why the double arrow is a PROPERTY on 'arrow', not a new kind;
//   (2) markerRef: `if (kind === 'arrow') … else if (kind === 'dot') … else
//       { rect x=3.2 width=1.6 … }` — the else branch is the BAR, so any tip
//       kind 1.1.0 does not know is drawn as a bar, not as a plain end.
const FROZEN_MAIN_SHA = '3a7eb8fb'
const FROZEN_SWITCH_CASES = ['path', 'rect', 'ellipse', 'triangle', 'arrow', 'line'] // verbatim order of `case '…': {` in renderShape
const FROZEN_MARKER_ELSE = `  } else {
    tip = document.createElementNS(SVG_NS, 'rect')
    tip.setAttribute('x', '3.2')
    tip.setAttribute('y', '0.4')
    tip.setAttribute('width', '1.6')
    tip.setAttribute('height', '7.2')
    marker.setAttribute('refX', '4')
  }`
// the fixture as behaviour: what 1.1.0's renderer does with a kind / a tip
const frozenRenderShape = (shape: string): 'single-arrow' | 'other' | 'THROWS' => {
  let node: string | undefined
  switch (shape) {
    case 'path': case 'rect': case 'ellipse': case 'triangle': case 'line': node = 'other'; break
    case 'arrow': node = 'single-arrow'; break
    // no default — exactly as at 3a7eb8fb
  }
  if (node === undefined) return 'THROWS' // svg.appendChild(undefined) → TypeError
  return node
}
const frozenMarker = (kind: string): 'arrow' | 'dot' | 'bar' => (kind === 'arrow' ? 'arrow' : kind === 'dot' ? 'dot' : 'bar')
ok(FROZEN_SWITCH_CASES.join() === 'path,rect,ellipse,triangle,arrow,line' && kinds.replace(/'| /g, '').split('|').every((k) => FROZEN_SWITCH_CASES.includes(k)), `every ShapeKind on this branch is a case 1.1.0's switch has (frozen at ${FROZEN_MAIN_SHA})`)
ok(frozenRenderShape('arrow2') === 'THROWS', 'the fixture shows why: an unknown kind would throw in 1.1.0 (the bug the review caught)')
ok(frozenRenderShape('arrow') === 'single-arrow', 'a deck with {shape: arrow, heads: 2} renders in 1.1.0 as a single arrow — a degrade, not a crash')
ok(/rect'\)\n\s+tip\.setAttribute\('x', '3\.2'\)/.test(FROZEN_MARKER_ELSE), 'the frozen else-branch is the bar geometry')
for (const s of TIPS) {
  if (['none', 'arrow', 'dot', 'bar'].includes(s.kind)) continue
  ok(frozenMarker(s.kind) === 'bar', `${s.kind}: 1.1.0 draws a BAR at that end (not a plain end) — no throw`)
}
ok(/in 1\.1\.0 and older the renderer matches only\n \* 'arrow' and 'dot' and draws a BAR/.test(read('slides/src/tips.ts')), 'tips.ts states the degrade')
ok(/those shells draw a bar where a\n  new tip should be; a double arrow shows there as a single one/.test(read('CHANGELOG.md')), 'the changelog states the same degrade, no softer')

console.log('\nend tangent\n')
const up = parseBezier('M 0 0 C 30 0 100 -50 100 -100').nodes // last handle points straight up into the endpoint
let t = endTangent(up, true)!
ok(close(t.x, 0) && close(t.y, -1), 'end tangent follows the last handle (straight up), not the chord')
t = endTangent(up, false)!
ok(close(t.x, -1) && close(t.y, 0), 'start tangent points OUT of the start, along the first handle')
const degenerate = parseBezier('M 0 0 C 30 0 100 -100 100 -100').nodes // zero-length last handle
t = endTangent(degenerate, true)!
const L = Math.hypot(70, 100)
ok(close(t.x, 70 / L) && close(t.y, -100 / L), 'zero-length end handle → falls back to the neighbour handle (30,0)→(100,-100), not the chord')
const bothZero = parseBezier('M 0 0 C 0 0 100 -100 100 -100').nodes
t = endTangent(bothZero, true)!
ok(close(t.x, Math.SQRT1_2) && close(t.y, -Math.SQRT1_2), 'both handles degenerate → the chord')
ok(endTangent(parseBezier('M 5 5').nodes, true) === null, 'a single point has no tangent')

console.log('\nshortening ends for a tip\n')
const d0 = 'M 0 0 C 30 0 100 -50 100 -100'
const d1 = shortenPathEnds(d0, 0, 10)
const n1 = parseBezier(d1).nodes
ok(close(n1[n1.length - 1].p.x, 100) && close(n1[n1.length - 1].p.y, -90), 'end pulled back 10 along its tangent (down the vertical arrival)')
ok(close(n1[0].p.x, 0) && close(n1[0].p.y, 0), 'start untouched when only the end has a tip')
ok(shortenPathEnds(d0, 0, 0) === d0, 'no tip → the d comes back unchanged')
ok(shortenPathEnds('M 0 0 L 10 0 L 10 10 Z', 2, 2) === 'M 0 0 L 10 0 L 10 10 Z', 'a closed path is never shortened')

console.log('\nre-routing a curved connector\n')
const bow = 'M 0 0 C 33.33 33.33 66.67 66.67 100 100 C 133.33 133.33 166.67 116.67 200 100'
const before = parseBezier(bow).nodes
const moved = movePathEnds(bow, { x: -20, y: 10 }, null)
const after = parseBezier(moved).nodes
ok(close(after[0].p.x, -20) && close(after[0].p.y, 10), 'the first on-curve point moved to the new anchor')
ok(after.slice(1).every((n, i) => close(n.p.x, before[i + 1].p.x) && close(n.p.y, before[i + 1].p.y)), 'every other on-curve point is exactly where it was')
ok(close(after[2].p.x, 200) && close(after[2].p.y, 100) && close(after[1].out!.x, before[1].out!.x), 'the far end and its outgoing handle are byte-identical')
const moved2 = movePathEnds(bow, null, { x: 250, y: 60 })
const after2 = parseBezier(moved2).nodes
ok(close(after2[2].p.x, 250) && close(after2[2].p.y, 60) && close(after2[0].p.x, 0), 'moving only the end leaves the start alone')
ok(movePathEnds(bow, null, null) === bow, 'nothing to move → unchanged')
const ends = pathEnds(bow)!
ok(close(ends[0].x, 0) && close(ends[1].x, 200), 'pathEnds reads the two on-curve ends')

console.log('\nthe legacy straight connector\n')
// These three functions routed every connector before this change. The
// diagram-engine lift moved them to the kernel (kernel/src/geom.ts), which —
// unlike lineedit.ts — is pure and node-loadable, so instead of pinning their
// TEXT (the old workaround for "lineedit can't import in node") we now exercise
// their OUTPUT: a stronger guarantee that the relocation changed nothing.
{
  const ep = lineEndpoints({ x: 0, y: 0, w: 100, h: 4, rotation: 0 })
  ok(ep[0].x === 0 && ep[0].y === 2 && ep[1].x === 100 && ep[1].y === 2, 'lineEndpoints splits a flat box into its two ends')
  // deno-lint-ignore no-explicit-any
  const el: any = { h: 4 }
  setLineEndpoints(el, { x: 0, y: 0 }, { x: 100, y: 0 })
  ok(el.w === 100 && el.x === 0 && el.y === -2 && el.rotation === 0, 'setLineEndpoints rebuilds the box from two endpoints')
  const bp = borderPoint({ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: 50 })
  ok(bp.x === 100 && bp.y === 50, 'borderPoint lands on the border along the ray to the target')
}
// and the marker numbers an old deck was drawn with
ok(/inset the endpoints so the tip's point lands on the box edge/.test(render) && /tipInsetPx\(el\.lineStart, lw\)/.test(render), 'a line insets by the catalogue — 2.6 for the original three (asserted above)')
ok(/el\.shape !== 'line' && el\.shape !== 'path'/.test(editor) && /if \(isPath\) setPathEndpoints\(c, na, nb\)\n\s+else setLineEndpoints\(c, na, nb\)/.test(editor), 'syncConnectors routes lines through setLineEndpoints and paths through setPathEndpoints')
const canvas = read('slides/src/editor/canvas.ts')
ok(/kind === 'curve-connector'/.test(canvas) && /el\.lineEnd = 'arrow'\n\s+if \(fromA\) el\.from/.test(canvas), 'the Curved connector tool draws a path with a tip and anchors like Connector')
ok(/label: 'Curved connector'/.test(editor) && /label: 'Double arrow'/.test(editor), 'both new shapes are in the Shape menu')

console.log('\nconnector routing + snapping moved to the kernel (byte-identical)\n')
// The diagram-engine lift (step 3) moved the connector SEMANTICS — border/side
// routing, the box anchor set, nearest-anchor snapping and the padded hit-test —
// into kernel/src/geom.ts, and slides' editor.ts/canvas.ts now call them. Pin the
// relocation to the exact inline code it replaced: reference implementations are
// verbatim what synced/anchorsFor/snap/elementAt computed before, and the kernel
// helpers must agree byte-for-byte across side, auto and free-end cases.
{
  type Side = ConnectorSide
  const SIDES: Array<Side | undefined> = [undefined, 'auto', 'top', 'right', 'bottom', 'left']
  // OLD inline code, verbatim:
  const oldEnd = (box: Box, side: Side | undefined, toward: GPt): GPt =>
    side && side !== 'auto' ? sideMidpoint(box, side) : borderPoint(box, toward)
  const oldAnchors = (e: Box) => [
    { side: 'top' as const, pt: { x: e.x + e.w / 2, y: e.y } },
    { side: 'right' as const, pt: { x: e.x + e.w, y: e.y + e.h / 2 } },
    { side: 'bottom' as const, pt: { x: e.x + e.w / 2, y: e.y + e.h } },
    { side: 'left' as const, pt: { x: e.x, y: e.y + e.h / 2 } },
    { side: 'auto' as const, pt: { x: e.x + e.w / 2, y: e.y + e.h / 2 } },
  ]
  type Snap = { el: string; side: Side; pt: GPt } | null
  const oldSnap = (anchors: ReturnType<typeof oldAnchors>, p: GPt, tol: number): Snap => {
    let best: Snap = null
    let bd = tol
    for (const cand of anchors) {
      const d = Math.hypot(p.x - cand.pt.x, p.y - cand.pt.y)
      if (d < bd) { bd = d; best = { el: 'x', side: cand.side, pt: cand.pt } }
    }
    return best
  }
  const oldContains = (e: Box, pt: GPt, pad: number) =>
    pt.x >= e.x - pad && pt.x <= e.x + e.w + pad && pt.y >= e.y - pad && pt.y <= e.y + e.h + pad

  const eq = (a: GPt, b: GPt) => a.x === b.x && a.y === b.y
  // deterministic LCG so a failure reproduces
  let seed = 0x2f6df6
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const box = (): Box => ({ x: rnd() * 2000 - 500, y: rnd() * 2000 - 500, w: 1 + rnd() * 600, h: 1 + rnd() * 400 })
  const pt = (): GPt => ({ x: rnd() * 2000 - 500, y: rnd() * 2000 - 500 })

  let endOk = true, anchorOk = true, snapOk = true, containsOk = true, scenarioOk = true
  for (let i = 0; i < 4000; i++) {
    const b = box(), toward = pt(), side = SIDES[Math.floor(rnd() * SIDES.length)]
    if (!eq(connectorEndpoint(b, side, toward), oldEnd(b, side, toward))) endOk = false
    const a1 = boxAnchors(b), a0 = oldAnchors(b)
    if (JSON.stringify(a1) !== JSON.stringify(a0)) anchorOk = false
    const p = pt(), tol = rnd() * 60
    const n1 = nearestAnchor(a1, p, tol), n0 = oldSnap(a0, p, tol)
    if (JSON.stringify(n1 && { side: n1.side, pt: n1.pt }) !== JSON.stringify(n0 && { side: n0.side, pt: n0.pt })) snapOk = false
    const pad = rnd() * 30
    if (boxContains(b, p, pad) !== oldContains(b, p, pad)) containsOk = false
  }
  ok(endOk, 'connectorEndpoint == the old inline end() across side / auto / free-end (4000 cases)')
  ok(anchorOk, 'boxAnchors == the old anchorsFor list, same order (4000 boxes)')
  ok(snapOk, 'nearestAnchor == the old snap selection, same tie-order (4000 points)')
  ok(containsOk, 'boxContains == the old elementAt predicate (4000 points × pads)')

  // full connector scenarios: two boxes, each kind of anchoring, na/nb both ways
  for (let i = 0; i < 2000; i++) {
    const fb = box(), tb = box()
    const [la, lb] = lineEndpoints({ x: Math.min(fb.x, tb.x), y: fb.y, w: 200, h: 4, rotation: 0 })
    for (const fs of SIDES) for (const ts of SIDES) {
      const na1 = connectorEndpoint(fb, fs, boxCenter(tb))
      const nb1 = connectorEndpoint(tb, ts, boxCenter(fb))
      const na0 = oldEnd(fb, fs, boxCenter(tb))
      const nb0 = oldEnd(tb, ts, boxCenter(fb))
      if (!eq(na1, na0) || !eq(nb1, nb0)) scenarioOk = false
    }
    // free end: one side anchored, the other rides toward the loose endpoint
    if (!eq(connectorEndpoint(fb, undefined, lb), oldEnd(fb, undefined, lb))) scenarioOk = false
    if (!eq(connectorEndpoint(tb, 'auto', la), oldEnd(tb, 'auto', la))) scenarioOk = false
  }
  ok(scenarioOk, 'two-box connectors route identically for every from/to side pair + a free end (2000 × 38)')

  // slides imports the kernel helpers through ./lineedit (the one import site)
  ok(/export \{ boxCenter, borderPoint, sideMidpoint, boxAnchors, connectorEndpoint, nearestAnchor, boxContains/.test(read('slides/src/editor/lineedit.ts')), 'lineedit re-exports the connector geom — ./lineedit stays the import site')
  ok(/connectorEndpoint\(fromBox, c\.from\?\.side/.test(editor) && !/const end = \(box/.test(editor), 'editor.ts syncConnectors calls connectorEndpoint, inline end() gone')
  ok(/boxAnchors\(this\.store\.slide\.elements\.find/.test(canvas) && /nearestAnchor\(anchorsFor\(id\)/.test(canvas) && /boxContains\(e, pt, pad\)/.test(canvas), 'canvas.ts uses boxAnchors / nearestAnchor / boxContains, inline dups gone')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
