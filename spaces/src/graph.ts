// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE GRAPH VIEW: a space drawn as its pages and the links between them.
//
// WHY THIS FILE EXISTS AT ALL, given that nothing here is new information.
// `buildIndex` (model.ts) already computes `backlinks` — target page id → every
// block that points at it — and the page tree already knows every parent. A
// space therefore HAS a graph from the moment it is loaded; it has simply never
// been drawn. So this is a rendering problem, and the one rule it follows is
// that it must not become a data problem: there is NO second link index here.
// Everything `buildGraph` returns is derived from `SpaceIndex.backlinks` and
// `Page.parent`, at open, and thrown away at close. A stored layout would be a
// document field that means nothing to the next reader's window size, and a
// second link scanner would be a second answer to "what links to this page".
//
// THREE DECISIONS WORTH THE INK:
//
//  1. NO LIBRARY, AND NO NETWORK. This app ships as one HTML file and every
//     byte is paid on every open, by every reader, forever. d3-force is ~30KB
//     for a hundred lines of arithmetic that is written out below instead.
//
//  2. THE LAYOUT IS COMPUTED ONCE, SYNCHRONOUSLY, AND IS DETERMINISTIC.
//     Initial positions come from a golden-angle spiral, not `Math.random`, so
//     the same space lays out the same way twice — which is what makes the
//     layout testable at all (scripts/test-spaces-model.ts asserts on it) and
//     what stops the picture jumping when you close and reopen it. The
//     animation is then a pure INTERPOLATION from the spiral to that settled
//     answer. That is not a shortcut: a live simulation has to re-fit the
//     camera every frame as the cloud grows, which is the jitter that makes
//     home-made force graphs look accidental. Here the camera is framed once,
//     against final positions, and the nodes glide into it.
//
//  3. IDLE COSTS NOTHING. Once the reveal has played there is no timer and no
//     rAF: a graph on screen is a still picture until you touch it. Obsidian's
//     graph never stops simmering and it is the reason that tab warms a laptop.
//
// REDUCED MOTION is the viewer preference slides established (present.ts):
// localStorage 'bento-reduce-motion' over the OS `prefers-reduced-motion`, never
// the document. When it is on there is no reveal — the settled layout is drawn
// on the first frame, which is the same picture, immediately.

import type { SpacesDoc, SpaceIndex } from './model.ts'
import { ICONS } from './icons.ts'
import { t } from './i18n.ts'

// ————— the graph itself ————————————————————————————————————————————————————

export interface GraphNode {
  id: string
  title: string
  icon?: string
  /** how many distinct pages this one is connected to — what the size shows */
  deg: number
  /** every reference, so a page linked five times reads heavier than once */
  weight: number
  x: number
  y: number
  vx: number
  vy: number
  r: number
}

/**
 * One undirected edge.
 *
 * UNDIRECTED ON PURPOSE. A → B and B → A are one relationship on a picture of
 * a wiki; drawn as two lines they are two lines in exactly the same place, and
 * the only thing that changes is that the pair looks twice as connected as it
 * is. `links` counts the references behind it (so a heavily-cross-referenced
 * pair draws thicker) and `tree` says the two are also parent and child.
 */
export interface GraphEdge {
  a: number
  b: number
  /** number of `[[wikilink]]`/pagelink references between the two, either way */
  links: number
  /** true when one is the other's parent in the page tree */
  tree: boolean
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** page id → node position in `nodes`; absent for archived pages */
  at: Map<string, number>
}

/**
 * Node radius from connectedness.
 *
 * sqrt, not linear: a page with 40 backlinks is not 40 times more interesting
 * than one with one, and a linear map makes the hub a disc that swallows its
 * own neighbourhood. Floor 4 so an orphan is still a thing you can click.
 */
export const nodeRadius = (deg: number): number => Math.min(4 + 3.1 * Math.sqrt(deg), 20)

/** Golden-angle spiral: even, deterministic, and not a grid. */
function seedPosition(i: number): { x: number; y: number } {
  const a = i * 2.399963229728653
  const r = 26 * Math.sqrt(i + 0.5)
  return { x: Math.cos(a) * r, y: Math.sin(a) * r }
}

/**
 * The pages and the links between them — ARCHIVED PAGES EXCLUDED.
 *
 * An archive is the author saying "out of the way"; a picture of the space
 * that puts them back in the middle of it is not the space they are looking at.
 * They stay searchable and linkable, exactly as the sidebar has them, and a
 * link INTO one simply has no edge to draw.
 */
export function buildGraph(doc: SpacesDoc, index: SpaceIndex): Graph {
  const nodes: GraphNode[] = []
  const at = new Map<string, number>()
  for (const p of doc.pages) {
    if (p.archived) continue
    at.set(p.id, nodes.length)
    const seed = seedPosition(nodes.length)
    nodes.push({
      id: p.id,
      title: p.title || t('Untitled'),
      // `Page.icon` is EITHER a name in the ICONS set (an svg, which a canvas
      // cannot paint without rasterising it first) OR an emoji, which is just
      // text. Keep the second kind and drop the first — before this test the
      // labels read "compass Welcome", the icon's NAME beside the title.
      icon: typeof p.icon === 'string' && !Object.hasOwn(ICONS, p.icon) ? p.icon : undefined,
      deg: 0,
      weight: 0,
      x: seed.x,
      y: seed.y,
      vx: 0,
      vy: 0,
      r: nodeRadius(0),
    })
  }

  const edges: GraphEdge[] = []
  const seen = new Map<number, number>() // packed pair key → edge position
  const key = (a: number, b: number) => (a < b ? a : b) * nodes.length + (a < b ? b : a)
  const edgeFor = (a: number, b: number): GraphEdge => {
    const k = key(a, b)
    const hit = seen.get(k)
    if (hit !== undefined) return edges[hit]
    const e: GraphEdge = { a: Math.min(a, b), b: Math.max(a, b), links: 0, tree: false }
    seen.set(k, edges.length)
    edges.push(e)
    return e
  }

  // THE ONE LINK INDEX. `backlinks` is target → sources, already built.
  for (const [target, sources] of index.backlinks) {
    const b = at.get(target)
    if (b === undefined) continue
    for (const s of sources) {
      const a = at.get(s.pageId)
      // a self-link is a real thing to write and a nothing to draw
      if (a === undefined || a === b) continue
      edgeFor(a, b).links++
    }
  }
  // …and the tree, which is a relationship the reader can see in the sidebar
  // and would otherwise be missing from the picture entirely: a space where
  // nobody has written a wikilink yet would draw as a field of dust.
  for (const p of doc.pages) {
    if (p.archived || !p.parent) continue
    const a = at.get(p.id)
    const b = at.get(p.parent)
    if (a === undefined || b === undefined || a === b) continue
    edgeFor(a, b).tree = true
  }

  for (const e of edges) {
    nodes[e.a].deg++
    nodes[e.b].deg++
    const w = e.links + (e.tree ? 1 : 0)
    nodes[e.a].weight += w
    nodes[e.b].weight += w
  }
  for (const n of nodes) n.r = nodeRadius(n.deg)
  return { nodes, edges, at }
}

// ————— the force simulation ————————————————————————————————————————————————

/** Everything the layout is tuned by, in one place so a tweak is one number. */
const REPULSION = 5200
/** past this the pairwise term is noise; gravity is what keeps the cloud one cloud */
const REPULSION_RANGE = 620
const SPRING = 0.022
const REST_LINK = 96
const REST_TREE = 78
const GRAVITY = 0.011
/**
 * Gravity has to WEAKEN as a space grows, or a big space is a dot.
 *
 * The cloud settles where the outward push of n nodes balances the inward
 * pull, which for a fixed gravity puts its radius at roughly (n·REPULSION/G)^⅓
 * — so the AREA per page falls as n^-⅓ and every page you write makes the
 * picture denser. Measured on a synthetic space: 400 pages settled only 2.29×
 * wider than 40, and at 213 pages the whole graph drew as a uniform ball about
 * 300px across in a 690px frame with its structure invisible inside it.
 * Scaling gravity by 1/√n makes the radius grow like √n instead — constant
 * area per page — and the same pair measures 3.01× apart. Normalised at 24, so
 * small spaces are unchanged.
 */
const gravityFor = (n: number): number => GRAVITY * Math.sqrt(24 / Math.max(n, 24))
const DAMPING = 0.74
const TICKS = 460

/**
 * One step. Exported so the rig can watch the energy fall rather than trust
 * that it does.
 *
 * O(n²) in the repulsion, deliberately: at 200 pages that is 20k pairs, and
 * measured at 500 pages the whole 460-tick layout runs in well under half a
 * second, once, on open. A quadtree would be another 80 lines of code that can
 * be subtly wrong in ways a picture does not reveal.
 */
export function stepLayout(g: Graph, alpha: number): void {
  const { nodes, edges } = g
  const n = nodes.length
  for (let i = 0; i < n; i++) {
    const a = nodes[i]
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j]
      let dx = a.x - b.x
      let dy = a.y - b.y
      let d2 = dx * dx + dy * dy
      if (d2 > REPULSION_RANGE * REPULSION_RANGE) continue
      if (d2 < 0.25) {
        // two nodes exactly on top of each other have no direction to separate
        // along; give them one that depends only on their positions in the
        // array, so the layout stays reproducible
        dx = ((i * 7 + j) % 11) - 5
        dy = ((i * 5 + j * 3) % 11) - 5
        d2 = dx * dx + dy * dy || 1
      }
      const d = Math.sqrt(d2)
      const f = REPULSION / (d2 * d)
      const fx = dx * f
      const fy = dy * f
      a.vx += fx
      a.vy += fy
      b.vx -= fx
      b.vy -= fy
    }
  }
  for (const e of edges) {
    const a = nodes[e.a]
    const b = nodes[e.b]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01
    const rest = e.links > 0 ? REST_LINK : REST_TREE
    const f = (SPRING * (d - rest)) / d
    // A hub is pulled by everything it is connected to, so an equal share each
    // would make it the one node that never sits still. Inverse mass by degree
    // is what turns hubs into anchors and leaves into the things that arrange
    // themselves around them.
    const ma = 1 / (1 + 0.5 * Math.sqrt(a.deg))
    const mb = 1 / (1 + 0.5 * Math.sqrt(b.deg))
    a.vx += dx * f * ma
    a.vy += dy * f * ma
    b.vx -= dx * f * mb
    b.vy -= dy * f * mb
  }
  const grav = gravityFor(n)
  for (const p of nodes) {
    p.vx -= p.x * grav
    p.vy -= p.y * grav
    p.vx *= DAMPING
    p.vy *= DAMPING
    p.x += p.vx * alpha
    p.y += p.vy * alpha
  }
}

/**
 * Settle the whole thing and centre it on the origin.
 *
 * Returns the graph so a caller can chain; mutates in place because the nodes
 * are the things being laid out.
 */
export function layoutGraph(g: Graph, ticks = TICKS): Graph {
  let alpha = 1
  for (let i = 0; i < ticks; i++) {
    stepLayout(g, alpha)
    alpha *= 0.99
  }
  if (!g.nodes.length) return g
  let cx = 0
  let cy = 0
  for (const p of g.nodes) {
    cx += p.x
    cy += p.y
  }
  cx /= g.nodes.length
  cy /= g.nodes.length
  for (const p of g.nodes) {
    p.x -= cx
    p.y -= cy
    p.vx = 0
    p.vy = 0
  }
  return g
}

/** The box the settled graph occupies, node radii included. */
export function graphBounds(g: Graph): { x0: number; y0: number; x1: number; y1: number } {
  if (!g.nodes.length) return { x0: -1, y0: -1, x1: 1, y1: 1 }
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of g.nodes) {
    x0 = Math.min(x0, p.x - p.r)
    y0 = Math.min(y0, p.y - p.r)
    x1 = Math.max(x1, p.x + p.r)
    y1 = Math.max(y1, p.y + p.r)
  }
  return { x0, y0, x1, y1 }
}

// ————— the viewer preference ————————————————————————————————————————————————

/**
 * Reduced motion, by slides' rule (present.ts): an explicit localStorage
 * choice, else the OS. A VIEWER preference — it is never in the document.
 */
export function prefersReducedMotion(): boolean {
  let stored: string | null = null
  try {
    stored = localStorage.getItem('bento-reduce-motion')
  } catch { /* private mode: fall through to the OS */ }
  if (stored === 'on') return true
  if (stored === 'off') return false
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch { return false }
}

// ————— drawing ——————————————————————————————————————————————————————————————

/**
 * The overlay's own CSS, injected once.
 *
 * NOT in styles.css: three branches are editing that file in parallel and this
 * whole feature is otherwise one new file. Marked `data-bento-transient` so it
 * can never be serialized into a saved document — the rule the compressed
 * shell's inflated stylesheet taught (kernel/src/save.ts serializeBody).
 */
const CSS = `
.sp-overlay-graph { align-items: center; padding: 14px; padding-top: 14px; }
.sp-graph {
  width: min(1180px, calc(100vw - 28px));
  height: min(820px, calc(100vh - 28px));
  max-height: none; padding: 0; overflow: hidden;
  display: flex; flex-direction: column;
}
.sp-graph-head {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border-bottom: 1px solid var(--line); flex: 0 0 auto;
}
.sp-graph-head .sp-card-h { margin: 0; }
.sp-graph-count { color: var(--muted); font-size: 12px; }
.sp-graph-spacer { flex: 1 1 auto; }
.sp-graph-btn {
  font: inherit; font-size: 12px; color: var(--muted); cursor: pointer;
  background: none; border: 1px solid var(--line); border-radius: 8px; padding: 5px 9px;
}
.sp-graph-btn:hover { background: var(--chrome-2); color: var(--ink); }
.sp-graph-stage { position: relative; flex: 1 1 auto; min-height: 0; background: var(--bg); }
.sp-graph-stage canvas { display: block; width: 100%; height: 100%; touch-action: none; }
.sp-graph-empty {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: var(--muted); font-size: 13px; text-align: center; padding: 0 24px;
}
.sp-graph-foot {
  flex: 0 0 auto; padding: 7px 12px; border-top: 1px solid var(--line);
  color: var(--muted); font-size: 11.5px;
}
`

function css(): void {
  if (document.getElementById('sp-graph-css')) return
  const s = document.createElement('style')
  s.id = 'sp-graph-css'
  s.setAttribute('data-bento-transient', '')
  s.textContent = CSS
  document.head.append(s)
}

const mk = <K extends keyof HTMLElementTagNameMap>(
  tag: K, cls: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/**
 * The theme, read out of the CSS tokens.
 *
 * A canvas is outside CSS: `var(--ink)` means nothing to `ctx.fillStyle`, so
 * the tokens have to be resolved to strings and re-resolved whenever the theme
 * changes underneath. This is the whole reason a canvas graph looks broken in
 * dark mode — someone wrote `#fff` once.
 */
interface Palette {
  bg: string; ink: string; muted: string; line: string
  edge: string; accent: string; blue: string; surface: string
}
function palette(): Palette {
  const s = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback
  return {
    bg: v('--bg', '#ffffff'),
    ink: v('--ink', '#1e2a3a'),
    muted: v('--muted', '#5b6472'),
    line: v('--line', '#e3e8ef'),
    edge: v('--edge', '#b9c3d2'),
    accent: v('--accent', '#f7a600'),
    blue: v('--blue', '#5b8def'),
    surface: v('--surface', '#ffffff'),
  }
}

export interface GraphViewOpts {
  doc: SpacesDoc
  index: SpaceIndex
  /** the page being read, ringed so you can find yourself */
  currentId: string
  /** clicking a node: the caller closes the overlay and goes there */
  open: (pageId: string) => void
  /** Close, Escape, or a click on the backdrop — the editor owns teardown */
  close: () => void
}

export interface GraphView {
  /** the overlay element, for the caller's `this.overlay` */
  el: HTMLElement
  /** unhook listeners; the caller removes `el` */
  destroy: () => void
  /** what was drawn, for the console and for measurement */
  graph: Graph
}

/**
 * Open the graph over the workspace.
 *
 * Returns the overlay rather than mounting policy: the editor owns what an
 * overlay IS (one at a time, `this.overlay` takes the keyboard), and this
 * module owns what it looks like.
 */
export function openGraphView(opts: GraphViewOpts): GraphView {
  css()
  const reduced = prefersReducedMotion()

  const g = buildGraph(opts.doc, opts.index)
  const t0 = performance.now()
  layoutGraph(g)
  const layoutMs = performance.now() - t0

  const back = mk('div', 'sp-overlay sp-overlay-graph')
  const card = mk('div', 'sp-card sp-graph')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.setAttribute('aria-label', t('Graph'))

  const head = mk('div', 'sp-graph-head')
  head.append(mk('h2', 'sp-card-h', t('Graph')))
  const linkCount = g.edges.reduce((s, e) => s + e.links, 0)
  head.append(mk('span', 'sp-graph-count',
    t('{pages} pages · {links} links', { pages: g.nodes.length, links: linkCount })))
  head.append(mk('div', 'sp-graph-spacer'))
  const fitBtn = mk('button', 'sp-graph-btn', t('Fit'))
  fitBtn.type = 'button'
  const closeBtn = mk('button', 'sp-graph-btn', t('Close'))
  closeBtn.type = 'button'
  head.append(fitBtn, closeBtn)

  const stage = mk('div', 'sp-graph-stage')
  const canvas = mk('canvas', '')
  stage.append(canvas)
  if (!g.nodes.length) {
    stage.append(mk('div', 'sp-graph-empty',
      t('Nothing to draw yet — link two pages with [[ and they will appear here.')))
  }

  const foot = mk('div', 'sp-graph-foot',
    t('Click a page to open it · drag to move · scroll to zoom'))

  card.append(head, stage, foot)
  back.append(card)

  // ——— camera ———
  let scale = 1
  let panX = 0
  let panY = 0
  let W = 0
  let H = 0
  let pal = palette()

  const fit = () => {
    const b = graphBounds(g)
    const bw = Math.max(b.x1 - b.x0, 1)
    const bh = Math.max(b.y1 - b.y0, 1)
    scale = Math.min((W - 80) / bw, (H - 80) / bh, 1.6)
    if (!isFinite(scale) || scale <= 0) scale = 1
    panX = W / 2 - ((b.x0 + b.x1) / 2) * scale
    panY = H / 2 - ((b.y0 + b.y1) / 2) * scale
  }

  const ctx = canvas.getContext('2d')

  // ——— the reveal ———
  // 0 → 1 over the reveal; each node interpolates from its spiral seed to its
  // settled place. With reduced motion this starts at 1 and never moves.
  let reveal = reduced ? 1 : 0
  const seeds = g.nodes.map((_, i) => seedPosition(i))
  let hover = -1
  const neighbours = new Set<number>()

  const resize = () => {
    const r = stage.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const w = Math.max(1, Math.round(r.width))
    const h = Math.max(1, Math.round(r.height))
    const first = W === 0
    W = w
    H = h
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (first) fit()
    draw()
  }

  const nx = (n: GraphNode, i: number) => (reveal >= 1 ? n.x : seeds[i].x + (n.x - seeds[i].x) * reveal)
  const ny = (n: GraphNode, i: number) => (reveal >= 1 ? n.y : seeds[i].y + (n.y - seeds[i].y) * reveal)
  const sx = (x: number) => x * scale + panX
  const sy = (y: number) => y * scale + panY

  function draw(): void {
    if (!ctx) return
    ctx.save()
    ctx.fillStyle = pal.bg
    ctx.fillRect(0, 0, W, H)

    const dim = hover >= 0
    // edges first, so a node always sits on top of what it is joined to
    ctx.lineCap = 'round'
    for (const e of g.edges) {
      const a = g.nodes[e.a]
      const b = g.nodes[e.b]
      const lit = dim && (hover === e.a || hover === e.b)
      const faded = dim && !lit
      ctx.globalAlpha = faded ? 0.08 : e.links > 0 ? 0.7 : 0.42
      ctx.strokeStyle = lit ? pal.accent : pal.edge
      ctx.lineWidth = Math.min(0.7 + 0.45 * (e.links || 1), 3) * Math.min(scale, 1.4)
      ctx.beginPath()
      ctx.moveTo(sx(nx(a, e.a)), sy(ny(a, e.a)))
      ctx.lineTo(sx(nx(b, e.b)), sy(ny(b, e.b)))
      ctx.stroke()
    }

    ctx.globalAlpha = 1
    const labels: Array<{ x: number; y: number; text: string; lit: boolean; deg: number }> = []
    for (let i = 0; i < g.nodes.length; i++) {
      const n = g.nodes[i]
      const X = sx(nx(n, i))
      const Y = sy(ny(n, i))
      const R = Math.max(2.2, n.r * Math.min(scale, 2))
      if (X < -60 || Y < -60 || X > W + 60 || Y > H + 60) continue
      const lit = i === hover || neighbours.has(i)
      ctx.globalAlpha = dim && !lit ? 0.22 : 1
      ctx.beginPath()
      ctx.arc(X, Y, R, 0, Math.PI * 2)
      // An orphan is a real state of a page and the picture should say so
      // rather than colour it like everything else.
      ctx.fillStyle = i === hover ? pal.accent : n.deg === 0 ? pal.muted : pal.blue
      ctx.fill()
      // a hairline in the ground colour, so touching nodes stay countable
      ctx.lineWidth = 1
      ctx.strokeStyle = pal.bg
      ctx.stroke()
      if (n.id === opts.currentId) {
        ctx.beginPath()
        ctx.arc(X, Y, R + 3.5, 0, Math.PI * 2)
        ctx.strokeStyle = pal.accent
        ctx.lineWidth = 2
        ctx.stroke()
      }
      labels.push({ x: X, y: Y + R + 11, text: n.icon ? `${n.icon} ${n.title}` : n.title, lit, deg: n.deg })
    }

    ctx.globalAlpha = 1
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = '11.5px system-ui, -apple-system, "Segoe UI", sans-serif'
    ctx.lineJoin = 'round'

    // WHICH LABELS GET DRAWN. Every label, at 200 pages, is a grey smear —
    // and a threshold on node size (the first answer here) labelled five of
    // thirteen pages in a space with room for all thirteen. So: offer them all,
    // most-connected first, and take the ones that FIT. A label whose box
    // overlaps one already placed is dropped, which is a rule that needs no
    // tuning per space size: a sparse graph labels everything, a dense one
    // labels its hubs, and zooming in spreads the boxes apart so more of them
    // survive. Whatever you are pointing at, and what it touches, is placed
    // first and unconditionally — that is what hovering is FOR.
    const order = labels
      .map((l, i) => ({ l, i }))
      .sort((p, q) => (Number(q.l.lit) - Number(p.l.lit)) || (q.l.deg - p.l.deg) || (p.i - q.i))
    const placed: Array<[number, number, number, number]> = []
    for (const { l } of order) {
      const text = l.text.length > 34 ? `${l.text.slice(0, 33)}…` : l.text
      const w = ctx.measureText(text).width
      const box: [number, number, number, number] = [l.x - w / 2 - 2, l.y - 7, l.x + w / 2 + 2, l.y + 7]
      if (!l.lit) {
        let clash = false
        for (const b of placed) {
          if (box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]) { clash = true; break }
        }
        if (clash) continue
      }
      placed.push(box)
      ctx.globalAlpha = dim && !l.lit ? 0.25 : 1
      // a halo in the ground colour: the only thing that keeps a label legible
      // where it crosses an edge, in either theme
      ctx.lineWidth = 3
      ctx.strokeStyle = pal.bg
      ctx.strokeText(text, l.x, l.y)
      ctx.fillStyle = l.lit ? pal.ink : pal.muted
      ctx.fillText(text, l.x, l.y)
    }
    ctx.restore()
  }

  // ——— the reveal animation ———
  //
  // WITH A WALL-CLOCK SETTLE GUARANTEE, which is not belt-and-braces: rAF is
  // throttled to ZERO in a hidden or occluded tab, so a graph opened in a
  // background window would freeze halfway between the spiral and its answer
  // and STAY there — a picture that is wrong rather than merely unanimated,
  // because the camera was framed against the settled positions. Measured in
  // exactly that state before this existed, and measured again after: the
  // debug hook below reported `frames: 0` (rAF never ran once) with
  // `reveal: 1`. slides carries the same guarantee for entrance tweens
  // (present.ts) for the same reason.
  let raf = 0
  let settle = 0
  let frames = 0
  const DUR = 620
  const land = () => {
    if (reveal >= 1) return
    reveal = 1
    draw()
  }
  if (!reduced) {
    const start = performance.now()
    const tick = () => {
      const p = Math.min(1, (performance.now() - start) / DUR)
      // ease-out cubic: fast out of the spiral, gentle into place
      reveal = 1 - Math.pow(1 - p, 3)
      frames++
      draw()
      raf = p < 1 ? requestAnimationFrame(tick) : 0
    }
    raf = requestAnimationFrame(tick)
    settle = window.setTimeout(land, DUR + 260)
  }

  // ——— pointer ———
  const hitTest = (px: number, py: number): number => {
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < g.nodes.length; i++) {
      const n = g.nodes[i]
      const dx = px - sx(nx(n, i))
      const dy = py - sy(ny(n, i))
      const R = Math.max(6, n.r * Math.min(scale, 2) + 3)
      const d = dx * dx + dy * dy
      if (d <= R * R && d < bestD) { best = i; bestD = d }
    }
    return best
  }

  const setHover = (i: number) => {
    if (i === hover) return
    hover = i
    neighbours.clear()
    if (i >= 0) {
      for (const e of g.edges) {
        if (e.a === i) neighbours.add(e.b)
        else if (e.b === i) neighbours.add(e.a)
      }
    }
    canvas.style.cursor = i >= 0 ? 'pointer' : 'default'
    draw()
  }

  let drag: { id: number; x: number; y: number; node: number; moved: boolean } | null = null

  const local = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  canvas.addEventListener('pointerdown', (e) => {
    const p = local(e)
    const node = hitTest(p.x, p.y)
    drag = { id: e.pointerId, x: p.x, y: p.y, node, moved: false }
    canvas.setPointerCapture(e.pointerId)
  })

  canvas.addEventListener('pointermove', (e) => {
    const p = local(e)
    if (!drag) { setHover(hitTest(p.x, p.y)); return }
    const dx = p.x - drag.x
    const dy = p.y - drag.y
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
    if (!drag.moved) return
    if (drag.node >= 0) {
      // dragging a node moves that node — the layout is not re-run, because a
      // picture that rearranges itself while you are holding one piece of it is
      // a picture you cannot arrange
      const n = g.nodes[drag.node]
      n.x += dx / scale
      n.y += dy / scale
      seeds[drag.node] = { x: n.x, y: n.y }
    } else {
      panX += dx
      panY += dy
    }
    drag.x = p.x
    drag.y = p.y
    draw()
  })

  const endDrag = (e: PointerEvent) => {
    if (!drag) return
    const d = drag
    drag = null
    try { canvas.releasePointerCapture(e.pointerId) } catch { /* already gone */ }
    if (!d.moved && d.node >= 0) opts.open(g.nodes[d.node].id)
  }
  canvas.addEventListener('pointerup', endDrag)
  canvas.addEventListener('pointercancel', endDrag)
  canvas.addEventListener('pointerleave', () => { if (!drag) setHover(-1) })

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    const p = { x: e.clientX - canvas.getBoundingClientRect().left, y: e.clientY - canvas.getBoundingClientRect().top }
    const k = Math.exp(-e.deltaY * 0.0016)
    const next = Math.max(0.12, Math.min(5, scale * k))
    // zoom about the pointer, not the centre: the thing under the cursor is the
    // thing you are looking at
    panX = p.x - ((p.x - panX) / scale) * next
    panY = p.y - ((p.y - panY) / scale) * next
    scale = next
    draw()
  }, { passive: false })

  fitBtn.addEventListener('click', () => { fit(); draw() })
  closeBtn.addEventListener('click', () => opts.close())
  back.addEventListener('click', (e) => { if (e.target === back) opts.close() })

  // ——— theme + size, both of which move under us ———
  const ro = new ResizeObserver(() => resize())
  const mo = new MutationObserver(() => { pal = palette(); draw() })
  let scheme: MediaQueryList | null = null
  const onScheme = () => { pal = palette(); draw() }

  const mount = () => {
    ro.observe(stage)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    try {
      scheme = matchMedia('(prefers-color-scheme: dark)')
      scheme.addEventListener('change', onScheme)
    } catch { /* ancient browser: the explicit toggle still works */ }
    resize()
  }
  // the stage has no size until it is in the document
  queueMicrotask(mount)

  const destroy = () => {
    if (raf) cancelAnimationFrame(raf)
    if (settle) clearTimeout(settle)
    ro.disconnect()
    mo.disconnect()
    scheme?.removeEventListener('change', onScheme)
  }

  // MEASURABLE RATHER THAN CLAIMED. Three of the properties this file claims
  // about itself are invisible from outside — that the layout cost what it says,
  // that reduced motion really does skip the reveal instead of playing it fast,
  // and that the wall-clock guarantee lands the picture when rAF never runs.
  // Each was checked through these rather than by looking at the screen:
  // `frames: 0` beside `reveal: 1` is the proof that a graph opened in a
  // background tab still arrives. Six numbers on a node thrown away at close.
  ;(back as unknown as { __graph: unknown }).__graph = {
    nodes: g.nodes.length, edges: g.edges.length, layoutMs, reduced,
    get reveal() { return reveal },
    get frames() { return frames },
  }

  return { el: back, destroy, graph: g }
}
