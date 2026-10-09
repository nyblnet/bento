#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Mermaid flowcharts ⇄ slides-shaped diagram elements (spaces/src/diagram/).
//
//   node scripts/test-diagram-mermaid.ts            # run
//   node scripts/test-diagram-mermaid.ts --update   # rewrite the layout snapshots
//
// WHAT THIS PROVES, and why each one fails silently:
//
//   1. SYNTAX. Each construct we claim to read (directions, the node shapes,
//      the link kinds and both label forms, chains and `&`, subgraphs,
//      classDef/class/style, comments) parses to the AST it means. A parser
//      that gets `-- text -->` wrong still produces a diagram — a wrong one.
//   2. REAL FLOWCHARTS. A corpus lifted from GitHub READMEs (MIT/Apache repos,
//      source in each file's first line) and the mermaid docs. Every one must
//      lay out with NO overlapping nodes, every connector end must sit on a
//      real element exactly where slides' syncConnectors would put it (or the
//      diagram jumps on its first edit) — checked with the kernel's own
//      connectorEndpoint, the call syncConnectors makes — every curved
//      connector's `d` must be the bytes slides' curve writer (setPathAnchors:
//      round the anchors, then the kernel's anchorsToPath) gives for its
//      anchors, and it must be byte-for-byte the same every run and match the
//      committed snapshot.
//   2b. ROUTING. No edge is drawn through a node it does not connect, or
//      through a subgraph box holding neither of its ends; no edge label sits
//      on another edge; no two edges share both ends unless the source says
//      so twice. Corpus totals are ratcheted: they may only go down.
//   3. ROUND TRIP. mermaid → elements → mermaid is semantically equal: same
//      nodes, labels, shapes, edges, edge labels and kinds, subgraph
//      membership, colours and direction.
//   4. LOSS IS REPORTED. diagramToMermaid names every element property it
//      drops — exactly those, no more.
//   5. HOSTILE INPUT. Huge graphs cap with a warning, deep nesting flattens,
//      `__proto__` ids pollute nothing, script in a label stays inert text,
//      pathological cycles and 10k-character labels finish inside a time
//      budget, and random token soup never throws.
//   6. SIZE. The module is budgeted in minified bytes.
//
// Every checker is run once against a planted defect first (NEGATIVE
// CONTROLS below): a checker that cannot fail proves nothing.

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  mermaidToDiagram, diagramToMermaid, parseMermaid, diagramLayout, makeIds, validColor, LIMITS, PALETTE,
  type DElement, type DShape, type DText, type FlowAST,
} from '../spaces/src/diagram/mermaid.ts'
import { anchorsToPath, boxCenter, connectorEndpoint, parseAnchors, type ConnectorSide } from '../kernel/src/geom.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIX = join(root, 'scripts/fixtures/mermaid-flowcharts')
const SNAP = join(FIX, 'snapshots.json')
const UPDATE = process.argv.includes('--update')

let checks = 0, failures = 0
function ok(cond: unknown, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
}
function section(t: string) { console.log(`\n${t}`) }

// --- geometry helpers ---------------------------------------------------------
// Where a connector end belongs is the KERNEL's connectorEndpoint — the exact
// call slides' syncConnectors makes since the diagram-engine lift — not a copy
// of its formula here, so this cannot drift from what the editor does.

type Box = { x: number; y: number; w: number; h: number }
type Pt = { x: number; y: number }
const center = boxCenter
/** a connector's two ends in slide coords: line = centre ± half-width along rotation;
 *  path = first and last on-curve points of `d`, mapped out of pathBox */
function ends(e: DShape): [Pt, Pt] {
  if (e.shape === 'line') {
    const c = center(e), r = (e.rotation * Math.PI) / 180, dx = Math.cos(r) * e.w / 2, dy = Math.sin(r) * e.w / 2
    return [{ x: c.x - dx, y: c.y - dy }, { x: c.x + dx, y: c.y + dy }]
  }
  const n = (e.d ?? '').match(/-?\d*\.?\d+(?:e-?\d+)?/g)!.map(Number)
  const [px, py, pw, ph] = e.pathBox ?? [0, 0, e.w, e.h]
  const m = (x: number, y: number) => ({ x: e.x + (x - px) * e.w / pw, y: e.y + (y - py) * e.h / ph })
  return [m(n[0], n[1]), m(n[n.length - 2], n[n.length - 1])]
}
const isConn = (e: DElement): e is DShape => e.type === 'shape' && !!(e.from || e.to)
const isNode = (e: DElement): e is DShape => e.type === 'shape' && !e.from && !e.to && e.role !== 'subgraph'
const isGroup = (e: DElement): e is DShape => e.type === 'shape' && e.role === 'subgraph'

// --- the checkers --------------------------------------------------------------

function overlapping(els: DElement[]): string[] {
  const nodes = els.filter(isNode)
  const bad: string[] = []
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j]
    if (a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01) bad.push(`${a.id}×${b.id}`)
  }
  return bad
}
/** subgraph boxes contain their members and no other node */
function groupFaults(els: DElement[]): string[] {
  const bad: string[] = []
  const inside = (a: Box, b: Box) => a.x >= b.x - 0.01 && a.y >= b.y - 0.01 && a.x + a.w <= b.x + b.w + 0.01 && a.y + a.h <= b.y + b.h + 0.01
  const hit = (a: Box, b: Box) => a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01
  const groups = els.filter(isGroup)
  for (const g of groups) {
    for (const n of els.filter(isNode)) {
      if (n.groupId === g.id && !inside(n, g)) bad.push(`${n.id} outside ${g.id}`)
      // a node may only overlap its own box and that box's ancestors
      const own = groups.find((o) => o.id === n.groupId)
      if (n.groupId !== g.id && hit(n, g) && !(own && inside(own, g))) bad.push(`${n.id} intrudes ${g.id}`)
    }
  }
  return bad
}
/** every connector end names a real node/box and sits exactly where syncConnectors would put it */
function attachFaults(els: DElement[]): string[] {
  const bad: string[] = []
  const byId = new Map(els.map((e) => [e.id, e]))
  for (const e of els.filter(isConn)) {
    const A = e.from && byId.get(e.from.el), B = e.to && byId.get(e.to.el)
    if (!A || !B || A.type !== 'shape' || B.type !== 'shape' || isConn(A) || isConn(B)) { bad.push(`${e.id}: dangling`); continue }
    const [a, b] = ends(e)
    const wa = connectorEndpoint(A, e.from!.side as ConnectorSide | undefined, center(B))
    const wb = connectorEndpoint(B, e.to!.side as ConnectorSide | undefined, center(A))
    if (Math.hypot(a.x - wa.x, a.y - wa.y) > 0.6) bad.push(`${e.id}: start ${JSON.stringify(a)} ≠ ${JSON.stringify(wa)}`)
    if (Math.hypot(b.x - wb.x, b.y - wb.y) > 0.6) bad.push(`${e.id}: end ${JSON.stringify(b)} ≠ ${JSON.stringify(wb)}`)
  }
  return bad
}
/** every curved connector is what slides' curve writer would write for its own
 *  anchors (setPathAnchors: anchors rounded, then anchorsToPath) — so the first
 *  edit in the curve editor rewrites nothing. Self-loops (pinned sides) are
 *  hand-drawn cubics and exempt. */
function curveFaults(els: DElement[]): string[] {
  return els.filter(isConn)
    .filter((e) => e.shape === 'path' && e.from?.side === 'auto' && e.to?.side === 'auto')
    .filter((e) => anchorsToPath(parseAnchors(e.d ?? '')) !== e.d)
    .map((e) => e.id)
}
/** label html is inert: nothing but escaped text and <br> */
function htmlFaults(els: DElement[]): string[] {
  return els.filter((e): e is DText => e.type === 'text').filter((t) => /<(?!br>)/.test(t.html) || /[<>]/.test(t.html.replace(/<br>/g, ''))).map((t) => t.id)
}
/** a connector's drawn path as a polyline (cubics sampled 8 per segment) */
function polyline(e: DShape): Pt[] {
  if (e.shape === 'line') return ends(e)
  const n = (e.d ?? '').match(/-?\d*\.?\d+(?:e-?\d+)?/g)!.map(Number)
  const [px, py, pw, ph] = e.pathBox ?? [0, 0, e.w, e.h]
  const m = (x: number, y: number) => ({ x: e.x + (x - px) * e.w / pw, y: e.y + (y - py) * e.h / ph })
  const out: Pt[] = [m(n[0], n[1])]
  for (let i = 2; i + 5 < n.length; i += 6) {
    const p0 = out[out.length - 1], c1 = m(n[i], n[i + 1]), c2 = m(n[i + 2], n[i + 3]), p1 = m(n[i + 4], n[i + 5])
    for (let t = 0.125; t <= 1.0001; t += 0.125) {
      const u = 1 - t
      out.push({ x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x, y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y })
    }
  }
  return out
}
/** Liang–Barsky: does segment ab enter box r? */
function segHits(a: Pt, b: Pt, r: Box): boolean {
  let t0 = 0, t1 = 1
  const dx = b.x - a.x, dy = b.y - a.y
  for (const [p, q] of [[-dx, a.x - r.x], [dx, r.x + r.w - a.x], [-dy, a.y - r.y], [dy, r.y + r.h - a.y]]) {
    if (p === 0) { if (q < 0) return false; continue }
    const t = q / p
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t } else { if (t < t0) return false; if (t < t1) t1 = t }
  }
  return t0 < t1
}
const crosses = (pl: Pt[], r: Box) => pl.some((p, i) => i > 0 && segHits(pl[i - 1], p, r))
/** edges drawn through nodes they do not connect / boxes holding neither end / labels on other edges */
function routing(els: DElement[]) {
  const conns = els.filter(isConn), nodes = els.filter(isNode), boxes = els.filter(isGroup)
  const byId = new Map(els.map((e) => [e.id, e]))
  const within = (a: Box, b: Box) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h
  const node: string[] = [], box: string[] = [], label: string[] = []
  for (const c of conns) {
    const pl = polyline(c), A = byId.get(c.from!.el)!, B = byId.get(c.to!.el)!
    for (const n of nodes) if (n !== A && n !== B && crosses(pl, { x: n.x + 2, y: n.y + 2, w: n.w - 4, h: n.h - 4 })) node.push(`${c.id} through ${n.id}`)
    for (const b of boxes) if (b !== A && b !== B && !within(A, b) && !within(B, b) && crosses(pl, { x: b.x + 2, y: b.y + 2, w: b.w - 4, h: b.h - 4 })) box.push(`${c.id} through ${b.id}`)
    const t = els.find((x) => x.id === `${c.id}-label`)
    // the label's inked core: the text box carries 12px of slack on its trailing side
    if (t) for (const o of conns) if (o !== c && crosses(polyline(o), { x: t.x + 6, y: t.y + 2, w: Math.max(0, t.w - 18), h: t.h - 4 })) label.push(`${t.id} on ${o.id}`)
  }
  return { node, box, label }
}
/** pairs of connectors sharing both ends, beyond what the source declared */
function doubled(els: DElement[], ast: FlowAST): string[] {
  const idOf = makeIds(), m = new Map<string, string>()
  for (const n of ast.nodes) m.set(n.id, idOf(n.id))
  for (const g of ast.subgraphs) m.set(g.id, idOf(g.id))
  const key = (a: string, b: string) => [a, b].sort().join(' ~ ')
  const declared = new Map<string, number>()
  for (const e of ast.edges) if (e.stroke !== 'invisible') { const k = key(m.get(e.from)!, m.get(e.to)!); declared.set(k, (declared.get(k) ?? 0) + 1) }
  const drawn = new Map<string, number>()
  for (const c of els.filter(isConn)) { const k = key(c.from!.el, c.to!.el); drawn.set(k, (drawn.get(k) ?? 0) + 1) }
  return [...drawn].filter(([k, n]) => n > (declared.get(k) ?? 0)).map(([k, n]) => `${k} ×${n}`)
}
function idFaults(els: DElement[]): string[] {
  const seen = new Set<string>(), bad: string[] = []
  for (const e of els) {
    if (seen.has(e.id)) bad.push(`dup ${e.id}`)
    seen.add(e.id)
    if (!/^[\w-]+$/.test(e.id) || e.id in Object.prototype) bad.push(`unsafe ${e.id}`)
  }
  return bad
}

/** The semantic content of an AST, with ids as the elements will spell them. */
function semantics(ast: FlowAST) {
  const idOf = makeIds(), m = new Map<string, string>()
  for (const n of ast.nodes) m.set(n.id, idOf(n.id))
  for (const g of ast.subgraphs) m.set(g.id, idOf(g.id))
  const nodes = ast.nodes.map((n) => `${m.get(n.id)} ${n.shape} ${JSON.stringify(n.label)} in:${n.parent ? m.get(n.parent) : '-'} ${n.style.fill ?? ''}/${n.style.stroke ?? ''}/${n.style.color ?? ''}`).sort()
  // effective direction (mermaid's rule): a subgraph whose members link outside
  // follows its context; otherwise its own direction, or the context's turned
  const par = new Map<string, string | null>([...ast.nodes.map((n) => [n.id, n.parent] as const), ...ast.subgraphs.map((g) => [g.id, g.parent] as const)])
  const anc = (x: string) => { const o: string[] = []; for (let p = par.get(x); p; p = par.get(p) ?? null) o.push(p); return o }
  const linked = new Set<string>()
  for (const e of ast.edges) {
    const A = anc(e.from), B = anc(e.to)
    for (const c of A) if (!B.includes(c) && c !== e.to) linked.add(c)
    for (const c of B) if (!A.includes(c) && c !== e.from) linked.add(c)
  }
  const eff = (g: string | null): string => {
    if (!g) return ast.dir
    const sg = ast.subgraphs.find((x) => x.id === g)!
    const ctx = eff(sg.parent)
    return linked.has(g) ? ctx : sg.dir ?? (ctx === 'TB' ? 'LR' : 'TB')
  }
  const groups = ast.subgraphs.map((g) => `${m.get(g.id)} ${JSON.stringify(g.label)} in:${g.parent ? m.get(g.parent) : '-'} ${g.style.fill ?? ''}/${g.style.stroke ?? ''} dir:${eff(g.id)}`).sort()
  const edges = ast.edges.filter((e) => e.stroke !== 'invisible').map((e) => {
    let [a, b, s, t] = [m.get(e.from)!, m.get(e.to)!, e.start, e.end]
    if (s !== 'none' && t === 'none') [a, b, s, t] = [b, a, t, s]
    return `${a}→${b} ${s}/${t} ${e.stroke} ${JSON.stringify(e.label)}`
  }).sort()
  return { dir: ast.dir, nodes, groups, edges }
}
function diffSemantics(a: ReturnType<typeof semantics>, b: ReturnType<typeof semantics>, withDir: boolean): string[] {
  const out: string[] = []
  if (withDir && a.dir !== b.dir) out.push(`dir ${a.dir} ≠ ${b.dir}`)
  for (const k of ['nodes', 'groups', 'edges'] as const) {
    const A = a[k], B = b[k]
    const miss = A.filter((x, i) => x !== B[i])
    if (A.length !== B.length || miss.length) out.push(`${k}: ${JSON.stringify(A.filter((x) => !B.includes(x)).slice(0, 3))} vs ${JSON.stringify(B.filter((x) => !A.includes(x)).slice(0, 3))}`)
  }
  return out
}
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)

// --- 0. negative controls: every checker must catch a planted defect ----------

section('negative controls')
{
  const r = mermaidToDiagram('flowchart TD\nA[One] --> B[Two]\nsubgraph S\nC\nend\nB --> C', { w: 800, h: 600 })
  const els = structuredClone(r.elements)
  ok(!overlapping(els).length && !attachFaults(els).length && !groupFaults(els).length && !htmlFaults(els).length && !idFaults(els).length, 'clean baseline passes every checker')
  const moved = structuredClone(els)
  const b = moved.find((e) => e.id === 'B')!
  const a = moved.find((e) => e.id === 'A')!
  b.x = a.x + 5; b.y = a.y + 5
  ok(overlapping(moved).length > 0, 'overlap checker catches two stacked nodes')
  const shifted = structuredClone(els)
  shifted.find((e) => e.id === 'A-B')!.x += 5
  ok(attachFaults(shifted).length > 0, 'attach checker catches a connector 5px off its node')
  const dangling = structuredClone(els)
  ;(dangling.find((e) => e.id === 'A-B') as DShape).to = { el: 'nope', side: 'auto' }
  ok(attachFaults(dangling).length > 0, 'attach checker catches a dangling end')
  const bent = mermaidToDiagram('flowchart TD\nA --> B --> C --> D\nA --> D', { w: 800, h: 600 }).elements
  const curve = bent.find((e) => e.type === 'shape' && e.shape === 'path' && e.from) as DShape | undefined
  ok(curve && !curveFaults(bent).length, 'curve baseline: a bent connector is the curve writer\'s bytes')
  if (curve) {
    // nudge ONE control handle by 0.01 — the size of the rounding slip this guards
    let k = 0
    curve.d = curve.d!.replace(/-?\d*\.?\d+/g, (v) => (k++ === 2 ? String(Math.round((+v + 0.01) * 100) / 100) : v))
    ok(curveFaults(bent).length > 0, 'curve checker catches a control handle 0.01 off the writer\'s')
  }
  const escaped = structuredClone(els)
  const t = escaped.find((e) => e.type === 'text') as DText
  t.html = '<img src=x onerror=alert(1)>'
  ok(htmlFaults(escaped).length > 0, 'html checker catches live markup')
  const outside = structuredClone(els)
  outside.find((e) => e.id === 'C')!.x += 2000
  ok(groupFaults(outside).length > 0, 'group checker catches a member outside its box')
  const dup = [...structuredClone(els), structuredClone(els[0])]
  ok(idFaults(dup).length > 0, 'id checker catches a duplicate id')
  const rr = mermaidToDiagram('flowchart LR\nA --> B\nA -->|a label| C\nD', { w: 800, h: 600 })
  const clean = routing(rr.elements)
  ok(!clean.node.length && !clean.box.length && !clean.label.length && !doubled(rr.elements, rr.ast).length, 'clean routing baseline passes')
  const blocked = structuredClone(rr.elements)
  const D = blocked.find((e) => e.id === 'D')!, AB = blocked.find((e) => e.id === 'A-B') as DShape
  const [p0, p1] = ends(AB)
  D.x = (p0.x + p1.x) / 2 - D.w / 2; D.y = (p0.y + p1.y) / 2 - D.h / 2
  ok(routing(blocked).node.length > 0, 'routing checker catches an edge through a node')
  const onEdge = structuredClone(rr.elements)
  const lab = onEdge.find((e) => e.id === 'A-C-label')!
  lab.x = (p0.x + p1.x) / 2 - lab.w / 2; lab.y = (p0.y + p1.y) / 2 - lab.h / 2
  ok(routing(onEdge).label.length > 0, 'routing checker catches a label on another edge')
  const twice = [...structuredClone(rr.elements), { ...structuredClone(AB), id: 'A-B-again' }]
  ok(doubled(twice, rr.ast).length > 0, 'doubled-edge checker catches a second A–B connector the source never declared')
  ok(!doubled(mermaidToDiagram('flowchart LR\nA --> B\nA --> B\nB --> A', { w: 800, h: 600 }).elements, parseMermaid('flowchart LR\nA --> B\nA --> B\nB --> A').ast).length, 'doubled-edge checker allows edges the source declares twice')
  const sd = semantics(parseMermaid('flowchart TB\nsubgraph s\nx --> y\nend').ast), sd2 = semantics(parseMermaid('flowchart TB\nsubgraph s\ndirection TB\nx --> y\nend').ast)
  ok(diffSemantics(sd, sd2, true).length > 0, 'round-trip comparator catches a changed subgraph direction')
  const s1 = semantics(parseMermaid('flowchart TD\nA[x] --> B').ast)
  for (const [bad, what] of [['flowchart TD\nA[y] --> B', 'a changed label'], ['flowchart TD\nA(x) --> B', 'a changed shape'], ['flowchart TD\nA[x] --- B', 'a changed head'], ['flowchart TD\nA[x]\nB', 'a dropped edge'], ['flowchart LR\nA[x] --> B', 'a changed direction']])
    ok(diffSemantics(s1, semantics(parseMermaid(bad).ast), true).length > 0, `round-trip comparator catches ${what}`)
}

// --- 1. syntax coverage ----------------------------------------------------------

section('syntax')
const P = (src: string) => parseMermaid(src)
const N = (src: string) => Object.fromEntries(P(src).ast.nodes.map((n) => [n.id, `${n.shape}:${n.label}`]))
const E = (src: string) => P(src).ast.edges.map((e) => `${e.from}>${e.to} ${e.start}/${e.end} ${e.stroke} ${e.len} ${JSON.stringify(e.label)}`)
{
  for (const [h, d] of [['flowchart TD', 'TB'], ['flowchart TB', 'TB'], ['graph BT', 'BT'], ['graph LR', 'LR'], ['flowchart RL', 'RL'], ['graph', 'TB'], ['flowchart-elk LR', 'LR']])
    ok(P(`${h}\nA-->B`).ast.dir === d, `header "${h}" → ${d}`)
  const shapes: Array<[string, string]> = [
    ['A[t]', 'rect'], ['A(t)', 'round'], ['A([t])', 'stadium'], ['A[[t]]', 'subroutine'], ['A[(t)]', 'cylinder'], ['A((t))', 'circle'],
    ['A(((t)))', 'dblcircle'], ['A{t}', 'diamond'], ['A{{t}}', 'hexagon'], ['A[/t/]', 'lean-r'], ['A[\\t\\]', 'lean-l'], ['A[/t\\]', 'trap-b'],
    ['A[\\t/]', 'trap-t'], ['A>t]', 'odd'], ['A@{ shape: tri, label: "t" }', 'tri'], ['A@{ shape: cyl, label: "t" }', 'cylinder'],
    ['A@{ shape: diamond, label: "t" }', 'diamond'], ['A@{ shape: rounded, label: "t" }', 'round'],
  ]
  for (const [src, shape] of shapes) ok(N(`flowchart TD\n${src}`).A === `${shape}:t`, `shape ${src} → ${shape}`)
  const unk = P('flowchart TD\nA@{ shape: bolt, label: "t" }')
  ok(N('flowchart TD\nA@{ shape: bolt, label: "t" }').A === 'rect:t' && unk.warnings.some((w) => /shape bolt unsupported/.test(w)), 'unknown shape → rect + warning')
  ok(N('flowchart TD\nA["a (b) [c] {d}"]').A === 'rect:a (b) [c] {d}', 'quoted label holds brackets')
  ok(N('flowchart TD\nA[messages[] in]').A === 'rect:messages[] in', 'unquoted label with balanced brackets')
  ok(N('flowchart TD\nA["#quot;q#quot; #35; #9829; &amp; &lt;"]').A === 'rect:"q" # ♥ & <', 'entity codes decode')
  ok(N('flowchart TD\nA["one<br>two<br/>three"]').A === 'rect:one\ntwo\nthree', '<br> is a line break')
  ok(N('flowchart TD\nA["`md\nstring`"]').A === 'rect:md\nstring', 'markdown string spans lines, backticks dropped')
  ok(N('flowchart TD\nA[fa:fa-car Car]').A === 'rect:Car', 'font-awesome icon token dropped')
  const links: Array<[string, string]> = [
    ['A-->B', 'A>B none/arrow normal 1 ""'], ['A --- B', 'A>B none/none normal 1 ""'], ['A-.->B', 'A>B none/arrow dotted 1 ""'],
    ['A-.-B', 'A>B none/none dotted 1 ""'], ['A==>B', 'A>B none/arrow thick 1 ""'], ['A===B', 'A>B none/none thick 1 ""'],
    ['A --o B', 'A>B none/circle normal 1 ""'], ['A --x B', 'A>B none/cross normal 1 ""'], ['A <--> B', 'A>B arrow/arrow normal 1 ""'],
    ['A o--o B', 'A>B circle/circle normal 1 ""'], ['A x--x B', 'A>B cross/cross normal 1 ""'], ['A ---> B', 'A>B none/arrow normal 2 ""'],
    ['A ----> B', 'A>B none/arrow normal 3 ""'], ['A -..-> B', 'A>B none/arrow dotted 2 ""'], ['A ===> B', 'A>B none/arrow thick 2 ""'],
    ['A-->|hi there|B', 'A>B none/arrow normal 1 "hi there"'], ['A -- hi there --> B', 'A>B none/arrow normal 1 "hi there"'],
    ['A-- This is the text! ---C', 'A>C none/none normal 1 "This is the text!"'], ['A---|t|D', 'A>D none/none normal 1 "t"'],
    ['A-. t .->B', 'A>B none/arrow dotted 1 "t"'], ['A == t ==> B', 'A>B none/arrow thick 1 "t"'], ['A --"q: x"--> B', 'A>B none/arrow normal 1 "q: x"'],
    ['A -.ship.-> B', 'A>B none/arrow dotted 1 "ship"'], ['A --as--o B', 'A>B none/circle normal 1 "as"'], ['A -- one --> B', 'A>B none/arrow normal 1 "one"'],
    ['A --one--> B', 'A>B none/arrow normal 1 "one"'], ['A ~~~ B', 'A>B none/none invisible 1 ""'], ['A -->|"a|b"| B', 'A>B none/arrow normal 1 "a|b"'],
  ]
  for (const [src, want] of links) ok(E(`flowchart LR\n${src}`)[0] === want, `link ${src} → ${want} (got ${E(`flowchart LR\n${src}`)[0]})`)
  ok(E('flowchart LR\nA --> B --> C').join() === 'A>B none/arrow normal 1 "",B>C none/arrow normal 1 ""', 'chain A --> B --> C')
  ok(E('flowchart LR\nA & B --> C & D').length === 4, 'A & B --> C & D is four edges')
  ok(E('flowchart LR\na --> b & c--> d').join('|') === 'a>b none/arrow normal 1 ""|a>c none/arrow normal 1 ""|b>d none/arrow normal 1 ""|c>d none/arrow normal 1 ""', 'mixed chain and &')
  ok(E('graph TD;A-->B;B-->C;').length === 2 && P('graph TD;A-->B;').ast.dir === 'TB', 'semicolon statements, header on the same line')
  ok(N('flowchart TD\nA["x;y"] --> B').A === 'rect:x;y', 'semicolon inside a quoted label')
  const sg = P('flowchart TB\nA\nsubgraph one [First one]\n  direction LR\n  a1-->a2\n  subgraph inner\n    x\n  end\nend\nsubgraph "Quoted title"\n y\nend\nsubgraph t2\nA\nend\na1 --> one')
  const g = Object.fromEntries(sg.ast.subgraphs.map((s) => [s.id, `${s.label}|${s.parent}|${s.dir ?? ''}`]))
  ok(g.one === 'First one|null|LR' && g.inner === 'inner|one|' && g['Quoted title'] === 'Quoted title|null|', `subgraph ids, titles, nesting, direction (${JSON.stringify(g)})`)
  const par = Object.fromEntries(sg.ast.nodes.map((n) => [n.id, n.parent]))
  ok(par.a1 === 'one' && par.x === 'inner' && par.y === 'Quoted title' && par.A === 't2', 'membership: first subgraph that mentions a node')
  ok(sg.ast.edges.some((e) => e.to === 'one') && !sg.ast.nodes.some((n) => n.id === 'one'), 'an edge may point at a subgraph')
  const st = P('flowchart TD\nA:::hot --> B\nC\nclassDef hot fill:#f96,stroke:#333,stroke-width:4px,color:rgb(1, 2, 3)\nclassDef default fill:#eee\nclass B,C cool\nclassDef cool stroke:blue\nstyle C fill:hsl(10 20% 30%),color:url(x)\nstyle A fill:red;background:url(javascript:alert(1))')
  const sty = Object.fromEntries(st.ast.nodes.map((n) => [n.id, JSON.stringify(n.style)]))
  ok(sty.A === '{"fill":"red","stroke":"#333","color":"rgb(1, 2, 3)"}', `classDef + ::: + style, fill/stroke/color only (${sty.A})`)
  ok(sty.B === '{"fill":"#eee","stroke":"blue"}' && sty.C === '{"fill":"hsl(10 20% 30%)","stroke":"blue"}', `class list + default class + style (${sty.B} ${sty.C})`)
  ok(st.warnings.some((w) => /stroke-width unsupported/.test(w)) && st.warnings.some((w) => /bad colour url\(x\)/.test(w)), 'unsupported style keys and non-colours warn')
  for (const [v, good] of [['#abc', true], ['#aabbcc80', true], ['rgb(1,2,3)', true], ['rgba(1, 2, 3, 0.5)', true], ['hsl(1 2% 3%)', true], ['teal', true], ['url(x)', false], ['red;x:y', false], ['expression(alert(1))', false], ['#12', false], ['', false]] as const)
    ok(!!validColor(v) === good, `validColor ${JSON.stringify(v)} → ${good}`)
  const cm = P('flowchart TD\n%% a comment\nA --> B %% trailing\n%%{init: {"theme":"dark"}}%%\nB --> C')
  ok(cm.ast.edges.length === 2 && cm.warnings.some((w) => /directive/.test(w)), 'comments, trailing comments, directives')
  const bad = P('flowchart TD\nA --> B\nclick A "http://x"\nlinkStyle 0 stroke:red\nA --> ??? ---\naccTitle: t\naccDescr {\n  long\n}\nC')
  ok(bad.ast.nodes.map((n) => n.id).join() === 'A,B,C' && bad.warnings.some((w) => /click unsupported/.test(w)) && bad.warnings.some((w) => /linkStyle unsupported/.test(w)) && bad.warnings.some((w) => /could not read/.test(w)), `unsupported statements warn, the rest still parses (${bad.warnings.join('; ')})`)
  const seq = mermaidToDiagram('sequenceDiagram\nAlice->>Bob: hi', { w: 400, h: 300 })
  ok(seq.elements.length === 0 && seq.warnings.some((w) => /sequenceDiagram/.test(w)), 'other diagram types: no elements, a warning')
  ok(mermaidToDiagram('', { w: 400, h: 300 }).warnings.includes('empty'), 'empty source warns')
  const fm = P('---\ntitle: T\n---\nflowchart LR\nA-->B')
  ok(fm.ast.edges.length === 1 && fm.ast.dir === 'LR', 'front matter skipped')
}

// --- 2 + 3. corpus: invariants, determinism, snapshots, round trip ----------------

section('corpus')
const files = readdirSync(FIX).filter((f) => f.endsWith('.mmd')).sort()
ok(files.length >= 30, `corpus has ≥ 30 flowcharts (${files.length})`)
ok(files.filter((f) => f.startsWith('readme-')).length >= 20, 'corpus has ≥ 20 GitHub README flowcharts')
const snaps: Record<string, string> = existsSync(SNAP) ? JSON.parse(readFileSync(SNAP, 'utf8')) : {}
const fresh: Record<string, string> = {}
// fixtures that are NOT valid mermaid (kept on purpose: they must warn, not crash)
const INVALID = new Set(['readme-21-ainativelang.mmd'])
let totalNodes = 0, totalEdges = 0
// routing ratchet: corpus totals may only go down (measured when the compound
// layout landed: 14 edges through nodes, 5 through boxes, 5 labels on edges
// before it; the numbers below after it)
const RATCHET = { node: 2, box: 2, label: 3, length: 33360, area: 9974 }
const totals = { node: 0, box: 0, label: 0, length: 0, area: 0 }
// fixtures that must route perfectly clean
const CLEAN = new Set(['docs-subgraphs.mmd', 'docs-subgraph-direction.mmd', 'docs-christmas.mmd', 'readme-23-architecture-as-code.mmd', 'readme-24-architecture-as-code.mmd', 'readme-46-temporalio-graphs.mmd', 'readme-10-tachi.mmd', 'readme-09-flowchestra.mmd'])
for (const f of files) {
  const src = readFileSync(join(FIX, f), 'utf8')
  ok(/^%% source: https:\/\/\S+ \((MIT|Apache-2\.0)[^)]*\)/.test(src), `${f}: attributed to a permissively licensed source`)
  let r: ReturnType<typeof mermaidToDiagram>
  try { r = mermaidToDiagram(src, { w: 1200, h: 800 }) } catch (e) { ok(false, `${f}: threw ${e}`); continue }
  totalNodes += r.ast.nodes.length; totalEdges += r.ast.edges.length
  if (!INVALID.has(f)) ok(!r.warnings.some((w) => /could not read/.test(w)), `${f}: every statement read (${r.warnings.filter((w) => /could not read/.test(w)).join('; ')})`)
  if (!INVALID.has(f)) ok(r.ast.nodes.length > 0, `${f}: has nodes`)
  const els = r.elements
  for (const [name, faults] of [['overlap', overlapping(els)], ['attach', attachFaults(els)], ['groups', groupFaults(els)], ['html', htmlFaults(els)], ['ids', idFaults(els)], ['curves', curveFaults(els)]] as const)
    ok(!faults.length, `${f}: ${name} ${faults.slice(0, 3).join(', ')}`)
  const dbl = doubled(els, r.ast)
  ok(!dbl.length, `${f}: no two edges share both ends unless declared twice (${dbl.join(', ')})`)
  const rt = routing(els)
  totals.node += rt.node.length; totals.box += rt.box.length; totals.label += rt.label.length
  if (CLEAN.has(f)) ok(!rt.node.length && !rt.box.length && !rt.label.length, `${f}: routes clear of nodes, boxes and labels (${[...rt.node, ...rt.box, ...rt.label].join('; ')})`)
  // compactness, measured unscaled: total connector length and drawing area
  const big = mermaidToDiagram(src, { w: 1e5, h: 1e5 }).elements
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const e of big) {
    if (isConn(e)) totals.length += polyline(e).reduce((m, p, i, a) => (i ? m + Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) : 0), 0)
    x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y); x1 = Math.max(x1, e.x + e.w); y1 = Math.max(y1, e.y + e.h)
  }
  if (big.length) totals.area += (x1 - x0) * (y1 - y0) / 1000
  const nodeIds = new Set(els.filter(isNode).map((e) => e.id))
  ok(nodeIds.size === r.ast.nodes.length, `${f}: one shape per node`)
  const texts = els.filter((e): e is DText => e.type === 'text')
  for (const n of els.filter(isNode)) {
    const t = texts.find((x) => x.id === `${n.id}-label`)
    ok(t && center(t).x >= n.x && center(t).x <= n.x + n.w && center(t).y >= n.y && center(t).y <= n.y + n.h, `${f}: ${n.id} has its label inside it`)
  }
  ok(els.every((e) => e.x >= -0.01 && e.y >= -0.01 && e.x + e.w <= 1200.01 && e.y + e.h <= 800.01 || isConn(e)), `${f}: fits the 1200×800 frame`)
  // determinism: a second run is byte-identical, and matches the snapshot
  const again = mermaidToDiagram(src, { w: 1200, h: 800 })
  ok(JSON.stringify(again) === JSON.stringify(r), `${f}: same input, same bytes`)
  fresh[f] = hash(r.elements)
  if (!UPDATE) ok(snaps[f] === fresh[f], `${f}: matches layout snapshot (${snaps[f]} → ${fresh[f]}; run with --update if the change is intended)`)
  // round trip
  if (INVALID.has(f)) continue
  const back = diagramToMermaid(els)
  const r2 = parseMermaid(back.src)
  ok(!r2.warnings.length, `${f}: emitted mermaid parses clean (${r2.warnings.join('; ')})`)
  const d = diffSemantics(semantics(r.ast), semantics(r2.ast), r.ast.edges.length > 0)
  ok(!d.length, `${f}: round trip is semantically equal ${d.join(' | ')}`)
  ok(!back.lost.length, `${f}: nothing lost on the way back (${JSON.stringify(back.lost.slice(0, 3))})`)
  // and the emitted source is itself a fixed point
  ok(diagramToMermaid(mermaidToDiagram(back.src, { w: 1200, h: 800 }).elements).src === back.src, `${f}: emitted source is a fixed point`)
}
console.log(`  ${files.length} flowcharts, ${totalNodes} nodes, ${totalEdges} edges`)
totals.length = Math.round(totals.length); totals.area = Math.round(totals.area)
console.log(`  routing: ${totals.node} edges through nodes, ${totals.box} through boxes, ${totals.label} labels on edges; ${totals.length} px of connectors over ${totals.area}k px² unscaled`)
for (const k of ['node', 'box', 'label', 'length', 'area'] as const) ok(totals[k] <= RATCHET[k], `layout ratchet: ${k} ${totals[k]} ≤ ${RATCHET[k]}`)

section('subgraph layout')
{
  const get = (els: DElement[], id: string) => els.find((e) => e.id === id)!
  const sg = mermaidToDiagram(readFileSync(join(FIX, 'docs-subgraphs.mmd'), 'utf8'), { w: 1200, h: 800 }).elements
  const b1 = get(sg, 'b1'), b2 = get(sg, 'b2')
  ok(Math.abs(center(b1).y - center(b2).y) < 1 && b2.x > b1.x + b1.w, 'docs-subgraphs: "two" has no outside links, so it turns LR (b1 → b2 sideways), as in mermaid')
  const one = get(sg, 'one'), two = get(sg, 'two'), three = get(sg, 'three')
  const apart = (a: Box, b: Box) => a.x + a.w <= b.x || b.x + b.w <= a.x
  ok(apart(three, one) && apart(three, two), '"three" stands beside "one" and "two", not stacked on them')
  ok(one.y + one.h <= two.y, '"one" sits above "two" (one --> two)')
  ok(three.y <= get(sg, 'c1').y && three.y + three.h >= get(sg, 'c2').y + get(sg, 'c2').h && get(sg, 'c2').y > two.y, '"three" spans from c1 down past "two" to c2')
  ok((get(sg, 'one-two') as DShape).shape === 'line' && (get(sg, 'three-two') as DShape).shape === 'line', 'an edge drawn to a compound box goes straight (its layout bends belong to a member, not the box)')
  const sd = mermaidToDiagram(readFileSync(join(FIX, 'docs-subgraph-direction.mmd'), 'utf8'), { w: 1200, h: 800 }).elements
  const [i1, f1, i2, f2] = ['i1', 'f1', 'i2', 'f2'].map((id) => get(sd, id))
  ok(f1.x + f1.w <= i1.x && Math.abs(center(f1).y - center(i1).y) < 1, 'direction RL inside a subgraph is honoured (f1 left of i1)')
  ok(f2.y + f2.h <= i2.y && Math.abs(center(f2).x - center(i2).x) < 1, 'direction BT inside a subgraph is honoured (f2 above i2)')
  const ig = mermaidToDiagram('flowchart TB\nsubgraph s\ndirection LR\nx --> y\nend\ny --> z', { w: 800, h: 600 })
  const [x, y] = ['x', 'y'].map((id) => get(ig.elements, id))
  ok(ig.warnings.some((w) => /direction in subgraph s ignored/.test(w)) && y.y > x.y + x.h, 'direction on a subgraph whose members link outside is ignored, with a warning (as in mermaid)')
  // compound nesting: members of nested subgraphs that link out keep strangers out of every box
  const nest = mermaidToDiagram('flowchart TB\nsubgraph A\n a1\n subgraph B\n  b1 --> b2\n  subgraph C\n   c1\n  end\n end\nend\nsubgraph D\n d1\nend\nr1 --> a1 --> b1\nb2 --> c1 --> d1 --> r2\nr1 --> d1\nc1 --> r2\na1 --> r2', { w: 1200, h: 800 })
  ok(!groupFaults(nest.elements).length && !overlapping(nest.elements).length && !attachFaults(nest.elements).length, `nested compound subgraphs: clean (${groupFaults(nest.elements).join()})`)
}
if (UPDATE) { writeFileSync(SNAP, JSON.stringify(fresh, null, 1) + '\n'); console.log(`  wrote ${SNAP}`) }
else ok(Object.keys(snaps).sort().join() === Object.keys(fresh).sort().join(), 'snapshot file lists exactly the corpus')

// --- sidecar ----------------------------------------------------------------------

section('layout sidecar')
{
  const src = 'flowchart TD\nA --> B --> C\nA --> D'
  const first = mermaidToDiagram(src, { w: 800, h: 600 })
  const side = diagramLayout(first.elements)
  ok(Object.keys(side).join() === 'A,B,C,D', 'diagramLayout names every node')
  side.B = { x: 600, y: 40, w: 150, h: 60 }
  const moved = mermaidToDiagram(src, { w: 800, h: 600, layout: side })
  const B = moved.elements.find((e) => e.id === 'B')!
  ok(B.x === 600 && B.y === 40 && B.w === 150 && B.h === 60, 'a sidecar position wins')
  ok(!attachFaults(moved.elements).length, 'connectors re-attach to moved nodes')
  const grown = mermaidToDiagram(src + '\nC --> E\nD --> F\nB --> G', { w: 800, h: 600, layout: side })
  ok(!overlapping(grown.elements).length, `new nodes are placed around pinned ones (${overlapping(grown.elements).join()})`)
  for (const id of ['A', 'B', 'C', 'D']) {
    const e = grown.elements.find((x) => x.id === id)!
    ok(e.x === side[id].x && e.y === side[id].y, `pinned ${id} keeps its place when the source grows`)
  }
  ok(JSON.stringify(grown) === JSON.stringify(mermaidToDiagram(src + '\nC --> E\nD --> F\nB --> G', { w: 800, h: 600, layout: side })), 'sidecar layout is deterministic')
  const proto = JSON.parse('{"__proto__": {"x": 1, "y": 1, "w": 10, "h": 10}, "constructor": 5}')
  const hostile = mermaidToDiagram('flowchart TD\nA-->B', { w: 400, h: 300, layout: proto })
  ok(hostile.elements.length > 0 && !overlapping(hostile.elements).length, 'a hostile sidecar is ignored, not obeyed')
  const bogus = mermaidToDiagram('flowchart TD\nA-->B', { w: 400, h: 300, layout: { A: { x: NaN, y: 0, w: 10, h: 10 }, B: { x: 0, y: 0, w: -5, h: 10 } } })
  ok(bogus.elements.every((e) => Number.isFinite(e.x) && e.w > 0), 'non-finite or negative sidecar boxes are ignored')
}

// --- 4. what diagramToMermaid reports lost ------------------------------------------

section('edge labels step off other edges')
{
  // pinned so that edge C→D crosses the middle of A→B, where its label would go
  const side = { A: { x: 300, y: 100, w: 60, h: 40 }, B: { x: 300, y: 500, w: 60, h: 40 }, C: { x: 40, y: 300, w: 60, h: 40 }, D: { x: 700, y: 300, w: 60, h: 40 } }
  const r = mermaidToDiagram('flowchart TD\nA -->|a label here| B\nC --> D', { w: 800, h: 600, layout: side })
  ok(!routing(r.elements).label.length, `a label whose spot is crossed by another edge moves along its own edge (${routing(r.elements).label.join()})`)
  const lab = r.elements.find((e) => e.id === 'A-B-label')!
  ok(lab.y + lab.h < 320 || lab.y > 340, 'it moved off the crossing, not merely beside it')
  // with nowhere clear to go the layout's spot stands
  const fan = 'flowchart LR\n' + Array.from({ length: 12 }, (_, i) => `A -->|label ${i}| N${i}`).join('\n')
  ok(mermaidToDiagram(fan, { w: 800, h: 600 }).elements.filter((e) => e.type === 'text').length === 25, 'a crowded fan still gets every label')
}

section('reverse: loss is reported exactly')
{
  const base = mermaidToDiagram('flowchart LR\nA[One] --> B[Two]', { w: 800, h: 600 }).elements
  ok(diagramToMermaid(base).lost.length === 0, 'a pure mermaid diagram loses nothing')
  const els = structuredClone(base) as Array<DElement & Record<string, unknown>>
  const A = els.find((e) => e.id === 'A')!, B = els.find((e) => e.id === 'B')!
  A.rotation = 15
  B.opacity = 0.5
  ;(A as Record<string, unknown>).fillGradient = { angle: 0, stops: [] }
  ;(B as Record<string, unknown>).shadow = { blur: 4, color: '#000' }
  const ab = els.find((e) => e.id === 'A-B') as DShape
  ab.fill = '#ff0000'
  ab.lineEnd = 'diamond'
  const bl = els.find((e) => e.id === 'B-label') as DText
  bl.html = '<b>Two</b>'
  els.push({ id: 'img1', type: 'image' } as never)
  els.push({ id: 'note', type: 'text', x: 5000, y: 5000, w: 10, h: 10, rotation: 0, opacity: 1, html: 'free', fontSize: 12, fontFamily: '', fontWeight: 400, color: '#000', align: 'left', valign: 'top', lineHeight: 1 } as DText)
  els.push({ id: 'free', type: 'shape', shape: 'line', x: 0, y: 0, w: 10, h: 4, rotation: 0, opacity: 1, fill: '#000', stroke: 'transparent', strokeWidth: 2, radius: 0 } as DShape)
  const out = diagramToMermaid(els)
  const got = out.lost.map((l) => `${l.el}:${l.what}`).sort()
  const want = ['A:rotation', 'A:gradient', 'B:opacity', 'B:shadow or blur', 'A-B:edge colour', 'A-B:tip "diamond"', 'B-label:rich text formatting', 'img1:image element', 'note:free text', 'free:unanchored line'].sort()
  ok(got.join() === want.join(), `lost list is exactly ${JSON.stringify(want)} (got ${JSON.stringify(got)})`)
  ok(/B\[Two\]/.test(out.src), 'rich text keeps its words')
  // colours survive as style statements
  const styled = mermaidToDiagram('flowchart TD\nA --> B\nstyle A fill:#f96,stroke:#333,color:#fff', { w: 400, h: 300 })
  ok(/style A fill:#f96,stroke:#333,color:#fff/.test(diagramToMermaid(styled.elements).src), 'node colours come back as a style statement')
  // hand-made elements: containment finds labels, sizes pick shapes
  const hand: DElement[] = [
    { id: 's1', type: 'shape', shape: 'rect', x: 0, y: 0, w: 100, h: 40, rotation: 0, opacity: 1, fill: PALETTE.fill, stroke: PALETTE.stroke, strokeWidth: 1.5, radius: 20 },
    { id: 't9', type: 'text', x: 10, y: 5, w: 80, h: 30, rotation: 0, opacity: 1, html: 'Start &amp; go', fontSize: 16, fontFamily: '', fontWeight: 400, color: PALETTE.ink, align: 'center', valign: 'middle', lineHeight: 1.2 },
    { id: 'e2', type: 'shape', shape: 'ellipse', x: 0, y: 200, w: 60, h: 60, rotation: 0, opacity: 1, fill: PALETTE.fill, stroke: PALETTE.stroke, strokeWidth: 1.5, radius: 0 },
    { id: 'c', type: 'shape', shape: 'line', x: 0, y: 100, w: 150, h: 4, rotation: 90, opacity: 1, fill: PALETTE.edge, stroke: 'transparent', strokeWidth: 2, radius: 0, lineStart: 'arrow', from: { el: 's1' }, to: { el: 'e2' } },
  ]
  const hm = diagramToMermaid(hand).src
  ok(hm.includes('s1(["Start & go"])') && hm.includes('e2((" "))') && hm.includes('e2 --> s1') && hm.startsWith('flowchart TD'), `hand-drawn diagram: stadium by radius, label by containment, start-arrow flips the edge (${hm.replace(/\n/g, ' / ')})`)
}

// --- 5. hostile input, with a time budget ----------------------------------------------

section('hostile input')
const BUDGET_MS = 2500
function timed<T>(label: string, fn: () => T): T {
  const t = performance.now()
  const v = fn()
  const ms = performance.now() - t
  ok(ms < BUDGET_MS, `${label}: ${ms.toFixed(0)}ms < ${BUDGET_MS}ms`)
  console.log(`  ${label}: ${ms.toFixed(0)}ms`)
  return v
}
{
  const protoBefore = Object.getOwnPropertyNames(Object.prototype).sort().join()
  const chain = 'flowchart TD\n' + Array.from({ length: 3000 }, (_, i) => `n${i} --> n${i + 1}`).join('\n')
  const big = timed('3000-node chain', () => mermaidToDiagram(chain, { w: 1200, h: 800 }))
  ok(big.warnings.some((w) => w.includes(`over ${LIMITS.nodes} nodes`)) && big.elements.filter(isNode).length === LIMITS.nodes, `huge graph capped at ${LIMITS.nodes} nodes with a warning`)
  ok(!overlapping(big.elements).length && !attachFaults(big.elements).length, 'capped graph still lays out cleanly')
  const K = 45
  const dense = 'flowchart LR\n' + Array.from({ length: K }, (_, i) => Array.from({ length: K }, (_, j) => (i !== j ? `k${i} --> k${j}` : '')).filter(Boolean).join('\n')).join('\n')
  const kd = timed(`complete digraph K${K} (${K * (K - 1)} edges, every pair a cycle)`, () => mermaidToDiagram(dense, { w: 1200, h: 800 }))
  ok(!overlapping(kd.elements).length && !attachFaults(kd.elements).length, 'complete digraph lays out cleanly')
  const wide = 'flowchart TD\n' + Array.from({ length: 2500 }, (_, i) => `root --> w${i}`).join('\n')
  const wd = timed('2500-edge fan-out', () => mermaidToDiagram(wide, { w: 1200, h: 800 }))
  ok(wd.warnings.some((w) => /nodes, rest dropped|edges, rest dropped/.test(w)), 'fan-out capped with a warning')
  const longEdges = 'flowchart TD\n' + Array.from({ length: 499 }, (_, i) => `c${i} --> c${i + 1}`).join('\n') + '\n' + Array.from({ length: 1400 }, (_, i) => `c${i % 50} --> c${499 - (i % 400)}`).join('\n')
  const le = timed('499-rank chain with 1400 long back/forward edges', () => mermaidToDiagram(longEdges, { w: 1200, h: 800 }))
  ok(!overlapping(le.elements).length && !attachFaults(le.elements).length, 'long-edge graph lays out cleanly (dummy budget)')
  const deep = 'flowchart TD\n' + Array.from({ length: 300 }, (_, i) => `subgraph s${i}`).join('\n') + '\nleaf1 --> leaf2\n' + 'end\n'.repeat(300)
  const dp = timed('300-deep subgraph nesting', () => mermaidToDiagram(deep, { w: 1200, h: 800 }))
  ok(dp.warnings.some((w) => /deeper than/.test(w)) && dp.ast.subgraphs.length === LIMITS.depth, `nesting flattened at ${LIMITS.depth} with a warning`)
  ok(!groupFaults(dp.elements).length && !overlapping(dp.elements).length, 'deep nesting: boxes still contain their members')
  const deepC = 'flowchart TD\nroot\n' + Array.from({ length: 30 }, (_, i) => `subgraph g${i}\nm${i}`).join('\n') + '\n' + 'end\n'.repeat(30) + Array.from({ length: 24 }, (_, i) => `m${i} --> root`).join('\n')
  const dc = timed('24 nested subgraphs, every level linking out', () => mermaidToDiagram(deepC, { w: 1200, h: 800 }))
  ok(!groupFaults(dc.elements).length && !overlapping(dc.elements).length && !attachFaults(dc.elements).length, 'deep compound nesting: boxes contain members and nothing else')
  let seed2 = 7
  const r2n = () => ((seed2 = (Math.imul(seed2 ^ (seed2 >>> 13), 0x5bd1e995) + 0x9e3779b9) | 0) >>> 0) / 2 ** 32
  const many = 'flowchart LR\n' + Array.from({ length: 20 }, (_, g) => `subgraph s${g}\n` + Array.from({ length: 20 }, (_, i) => `  n${g}_${i}`).join('\n') + '\nend').join('\n') + '\n' + Array.from({ length: 900 }, () => `n${Math.floor(r2n() * 20)}_${Math.floor(r2n() * 20)} --> n${Math.floor(r2n() * 20)}_${Math.floor(r2n() * 20)}`).join('\n')
  const mc = timed('400 nodes in 20 subgraphs, 900 random edges across them', () => mermaidToDiagram(many, { w: 1200, h: 800 }))
  ok(!groupFaults(mc.elements).length && !overlapping(mc.elements).length && !attachFaults(mc.elements).length, 'many compound subgraphs with random cross edges: clean')
  const proto = mermaidToDiagram('flowchart TD\n__proto__ --> constructor\nconstructor --> toString\nhasOwnProperty["#constructor; #__proto__; &constructor;"] --> __proto__\nclassDef __proto__ fill:red\nclass toString __proto__\nsubgraph prototype\nvalueOf\nend\nstyle __proto__ fill:#fff', { w: 800, h: 600 })
  ok(Object.getOwnPropertyNames(Object.prototype).sort().join() === protoBefore && !('fill' in Object.prototype), 'Object.prototype untouched')
  ok(!idFaults(proto.elements).length && proto.elements.filter(isNode).length === 5, `__proto__-style ids become safe, distinct element ids (${proto.elements.map((e) => e.id).join()})`)
  ok((proto.elements.find((e) => e.id === 'hasOwnProperty_-label') as DText)?.html === '#constructor; #__proto__; &amp;constructor;', 'entity names that are Object.prototype keys stay literal')
  ok(proto.ast.nodes.find((n) => n.id === 'toString')!.style.fill === 'red', 'a class named __proto__ works as a class')
  const xss = mermaidToDiagram('flowchart TD\nA["<script>alert(1)</script>"] --> B["<img src=x onerror=alert(1)>"]\nB -->|"<svg onload=alert(1)>"| C[#lt;b#gt;x#lt;/b#gt;]\nC --> D["javascript:alert(1)"]', { w: 800, h: 600 })
  ok(!htmlFaults(xss.elements).length, 'script-ish labels are escaped text')
  ok((xss.elements.find((e) => e.id === 'A-label') as DText).html === '&lt;script&gt;alert(1)&lt;/script&gt;', 'the text itself survives, inert')
  const xback = diagramToMermaid(xss.elements).src
  ok(!/[<>](?!br>)/.test(xback.replace(/-->|<br>/g, '')) && semantics(parseMermaid(xback).ast).nodes.join() === semantics(xss.ast).nodes.join(), 'emitted mermaid carries no raw < or > (GitHub would render it as HTML) and round-trips')
  const long = 'x'.repeat(10000), words = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(' ')
  const ll = timed('10k-character labels', () => mermaidToDiagram(`flowchart TD\nA["${long}"] --> B["${words}"] -->|${long}| C`, { w: 1200, h: 800 }))
  ok(ll.warnings.some((w) => /longer than/.test(w)), 'over-long labels warn')
  ok((ll.elements.find((e) => e.id === 'A-label') as DText).html === long, 'a 10k label keeps all of its text')
  ok(!overlapping(ll.elements).length && !attachFaults(ll.elements).length, '10k labels still lay out cleanly')
  const comments = 'flowchart TD\n' + '%% comment line\n'.repeat(100000) + 'A --> B'
  timed('100k comment lines', () => mermaidToDiagram(comments, { w: 400, h: 300 }))
  const unterminated = ['flowchart TD\nA[unterminated', 'flowchart TD\nA["unterminated --> B', 'flowchart TD\nsubgraph x\nA', 'flowchart TD\nend\nend', 'flowchart TD\nA -->', 'flowchart TD\n--> B', 'flowchart TD\nA@{ shape: ', 'flowchart TD\nA -- never closes', 'flowchart TD\n"q" --> B', 'flowchart TD\nA(((x)) --> B', 'graph TD\n\u0000‮\ud800 --> B']
  for (const u of unterminated) {
    let r: ReturnType<typeof mermaidToDiagram> | null = null
    try { r = mermaidToDiagram(u, { w: 400, h: 300 }) } catch (e) { ok(false, `${JSON.stringify(u)} threw ${e}`) }
    if (r) ok(!overlapping(r.elements).length && !attachFaults(r.elements).length && !htmlFaults(r.elements).length, `${JSON.stringify(u)}: no crash, clean output`)
  }
  // seeded token soup: never throws, output always sound
  let seed = 0x9e3779b9
  const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0) >>> 0) / 2 ** 32
  const T = ['A', 'B', 'c1', '__proto__', '-->', '---', '-.->', '==>', '--', '-.', '==', '|', '"', '[', ']', '(', ')', '{', '}', '((', '))', '>', '/', '\\', '&', ';', '\n', ' ', 'subgraph', 'end', 'classDef', 'class', 'style', ':::', 'fill:#f00', 'x', 'o', '<', '%%', '@{', 'shape:', '#quot;', '<br>', 'direction', 'LR']
  let soupFaults = 0, threw = 0, lively = 0
  const soup = timed('2000 random token soups', () => {
    for (let n = 0; n < 2000; n++) {
      // half plausible statements with random corruption, half raw token soup
      const pick = <X,>(xs: X[]) => xs[Math.floor(rnd() * xs.length)]
      let s = rnd() < 0.9 ? pick(['flowchart TD\n', 'graph LR\n', 'flowchart BT;', 'flowchart RL\n']) : ''
      const len = 1 + Math.floor(rnd() * 30)
      for (let k = 0; k < len; k++) {
        if (rnd() < 0.5) {
          const node = () => pick(['A', 'B', 'c1', 'end', '__proto__', 'x', 'o', 'q.r', 'n-1']) + (rnd() < 0.5 ? pick(['[t]', '(t)', '{t}', '((t))', '[/t\\]', '>t]', '["a;b"]', '@{ shape: tri }', '[[t]]', '{{t}}']) : '')
          s += node()
          for (let m = Math.floor(rnd() * 3); m >= 0; m--) s += ' ' + pick(['-->', '---', '-.->', '==>', '-- l -->', '-->|l|', '<-->', '--o', '--x', '~~~', '&']) + ' ' + node()
          s += pick(['\n', ';', '\n', ' ' + pick(T)])
        } else s += pick(T) + (rnd() < 0.5 ? ' ' : '')
      }
      try {
        const r = mermaidToDiagram(s, { w: 600, h: 400 })
        if (r.elements.some(isConn)) lively++
        if (overlapping(r.elements).length || attachFaults(r.elements).length || htmlFaults(r.elements).length || idFaults(r.elements).length || groupFaults(r.elements).length) { if (!soupFaults++) console.log('   first fault:', JSON.stringify(s)) }
        diagramToMermaid(r.elements)
      } catch (e) { if (!threw++) console.log('   first throw:', JSON.stringify(s), e) }
    }
    return true
  })
  ok(soup && !threw, `token soup never throws (${threw})`)
  ok(!soupFaults, `token soup output is always sound (${soupFaults})`)
  ok(lively >= 200, `the soup is not all rejects: ${lively} of 2000 produce connectors`)
}

// --- 6. size budget ------------------------------------------------------------------

section('size')
{
  const esbuild = join(root, 'slides/node_modules/.bin/esbuild')
  ok(existsSync(esbuild), 'esbuild is installed (npm ci in slides/) — the size budget cannot be skipped')
  if (existsSync(esbuild)) {
    // Minified bytes. The brief's target was 10 KB for parser + layout; see the
    // PR for why it sits above that. These budgets stop it GROWING unnoticed.
    const BUDGET = { 'parser + layout': 20500, 'mermaid → elements': 31000, 'whole module (both directions)': 37000 }
    const entries: Record<keyof typeof BUDGET, string> = {
      'parser + layout': "export { parseMermaid } from './spaces/src/diagram/mermaid.ts'; export { layout } from './spaces/src/diagram/layout.ts'",
      'mermaid → elements': "export { mermaidToDiagram } from './spaces/src/diagram/mermaid.ts'",
      'whole module (both directions)': "export * from './spaces/src/diagram/mermaid.ts'",
    }
    const tmp = mkdtempSync(join(tmpdir(), 'bento-mermaid-size-'))
    try {
      for (const [name, code] of Object.entries(entries) as Array<[keyof typeof BUDGET, string]>) {
        const r = spawnSync(esbuild, ['--bundle', '--minify', '--format=esm', '--sourcefile=entry.ts', '--loader=ts'], { input: code, encoding: 'utf8', cwd: root })
        const bytes = Buffer.byteLength(r.stdout ?? '')
        ok(r.status === 0 && bytes > 1000, `${name}: bundles (${r.stderr?.slice(0, 200)})`)
        ok(bytes <= BUDGET[name], `${name}: ${bytes} B ≤ ${BUDGET[name]} B minified`)
        console.log(`  ${name}: ${bytes} B minified`)
      }
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) { console.log(`${failures} FAILED`); process.exit(1) }
