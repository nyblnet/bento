// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A small layered (Sugiyama-style) layout for compound directed graphs.
// Written for mermaid.ts; pure, DOM-free and deterministic: the same input
// gives the same output byte for byte (no randomness, no Map-order surprises:
// every iteration order is the input order). A kernel candidate, with
// mermaid.ts: it has zero app imports.
//
// The phases, per cluster (a subgraph is laid out on its own and then takes
// part in its parent's layout as ONE node of its own size, so a subgraph box
// can never overlap a node outside it):
//
//  1. cycle breaking — depth-first from the sources; an edge that closes a
//     cycle is laid out reversed (it still draws its own way);
//  2. layer assignment — longest path, then sources pulled down next to their
//     first successor so a lone start node does not float at the top;
//  3. every rank is DOUBLED (dagre's trick): real nodes sit on even layers and
//     a labelled edge gets a dummy of its label's size on the odd layer in its
//     middle, so edge labels take up real space and never overlap a node;
//     longer edges get a chain of thin dummies, which become their bends;
//  4. crossing reduction — barycentre sweeps down and up, keeping the best
//     ordering seen (crossings counted exactly with a Fenwick tree);
//  5. coordinates — each layer is placed at the positions its neighbours'
//     mean asks for, subject to the minimum separations: that is isotonic
//     regression, solved exactly by pool-adjacent-violators, a few rounds;
//  6. the direction (TB/BT/LR/RL) is a final transform of a TB layout.

export type Dir = 'TB' | 'BT' | 'LR' | 'RL'
export interface Pt { x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }

/** A node to place. `parent` is the id of the cluster it sits in (null = root). */
export interface LNode { id: string; w: number; h: number; parent: string | null }
/** A cluster (subgraph). `top` is the room its title needs above the content. */
export interface LCluster { id: string; parent: string | null; dir?: Dir; top: number; minW: number }
/** An edge between two node ids. `lw/lh` = the label's size (0 when none). */
export interface LEdge { from: string; to: string; minlen: number; lw: number; lh: number }

export interface LOpts { nodeGap: number; rankGap: number; pad: number; maxDummies: number }

export interface LResult {
  nodes: Map<string, Box>
  clusters: Map<string, Box>
  /** per input edge: the bend points between its two ends (absolute), and the
   *  label centre when it has a label. Endpoints are NOT included — they are
   *  derived on the node borders, the way slides' syncConnectors derives them. */
  edges: Array<{ bends: Pt[]; label?: Pt }>
  w: number
  h: number
  /** true when the dummy budget ran out and some long edges were left straight */
  capped: boolean
}

interface Item { w: number; h: number; dummy: number /* 0 real, 1 bend, 2 label */ }
interface Sub { box: Map<string, Box>; bends: Map<number, Pt[]>; labels: Map<number, Pt>; w: number; h: number }

const r2 = (v: number) => Math.round(v * 100) / 100

export function layout(nodes: LNode[], clusters: LCluster[], edges: LEdge[], dir: Dir, o: LOpts): LResult {
  const parentOf = new Map<string, string | null>()
  for (const c of clusters) parentOf.set(c.id, c.parent)
  for (const n of nodes) parentOf.set(n.id, n.parent)
  const size = new Map<string, { w: number; h: number }>()
  for (const n of nodes) size.set(n.id, n)
  const res: LResult = { nodes: new Map(), clusters: new Map(), edges: edges.map(() => ({ bends: [] })), w: 0, h: 0, capped: false }
  let budget = o.maxDummies
  // local layouts, bottom-up; `rel` holds each child's box relative to its cluster
  const rel = new Map<string | null, Sub>()
  const cdir = new Map<string | null, Dir>([[null, dir]])
  const cinfo = new Map<string, LCluster>()
  for (const c of clusters) cinfo.set(c.id, c)
  // a cluster's direction is its own, or inherited from its parent
  const dirOf = (id: string | null): Dir => {
    if (cdir.has(id)) return cdir.get(id)!
    const c = cinfo.get(id!)!
    const d = c.dir ?? dirOf(c.parent)
    cdir.set(id, d)
    return d
  }
  // which child of `cid` contains node/cluster `x` (undefined when outside)
  const lift = (x: string, cid: string | null): string | undefined => {
    let cur: string | null | undefined = x
    for (let guard = 0; cur != null && guard < 10000; guard++) {
      const p: string | null | undefined = parentOf.get(cur)
      if (p === undefined) return undefined
      if (p === cid) return cur
      cur = p
    }
    return undefined
  }
  // post-order over the cluster tree (children before parents), iteratively
  const kids = new Map<string | null, string[]>()
  for (const c of clusters) {
    if (!kids.has(c.parent)) kids.set(c.parent, [])
    kids.get(c.parent)!.push(c.id)
  }
  const order: Array<string | null> = []
  const stack: Array<string | null> = [null]
  while (stack.length) {
    const c = stack.pop()!
    order.push(c)
    for (const k of kids.get(c) ?? []) stack.push(k)
  }
  order.reverse()
  for (const cid of order) {
    const ids: string[] = []
    for (const n of nodes) if (n.parent === cid) ids.push(n.id)
    for (const c of clusters) if (c.parent === cid) ids.push(c.id)
    const idx = new Map(ids.map((id, i) => [id, i]))
    const es: Array<[number, number, number, number, number, number]> = [] // u v minlen lw lh edgeIndex
    edges.forEach((e, i) => {
      const u = lift(e.from, cid), v = lift(e.to, cid)
      if (u === undefined || v === undefined || u === v) return
      es.push([idx.get(u)!, idx.get(v)!, e.minlen, e.lw, e.lh, i])
    })
    const items: Item[] = ids.map((id) => ({ ...size.get(id)!, dummy: 0 }))
    const d = dirOf(cid)
    const flat = layered(items, es, d, o, () => budget, (n) => { budget -= n })
    if (flat.capped) res.capped = true
    const box = new Map<string, Box>()
    ids.forEach((id, i) => box.set(id, flat.box[i]))
    let w = flat.w, h = flat.h
    if (cid !== null) {
      const c = cinfo.get(cid)!
      w = Math.max(w + 2 * o.pad, c.minW + 2 * o.pad)
      h = h + 2 * o.pad + c.top
      size.set(cid, { w, h })
    }
    rel.set(cid, { box, bends: flat.bends, labels: flat.labels, w, h })
  }
  // top-down: absolute positions
  const place = (cid: string | null, ox: number, oy: number) => {
    const sub = rel.get(cid)!
    let cx = ox, cy = oy
    if (cid !== null) {
      const c = cinfo.get(cid)!
      const inner = sub.w - 2 * o.pad
      const content = [...sub.box.values()].reduce((m, b) => Math.max(m, b.x + b.w), 0)
      cx = ox + o.pad + (inner - content) / 2
      cy = oy + o.pad + c.top
    }
    for (const [id, b] of sub.box) {
      const abs = { x: r2(cx + b.x), y: r2(cy + b.y), w: r2(b.w), h: r2(b.h) }
      if (cinfo.has(id)) {
        res.clusters.set(id, abs)
        place(id, abs.x, abs.y)
      } else res.nodes.set(id, abs)
    }
    for (const [i, pts] of sub.bends) res.edges[i].bends = pts.map((p) => ({ x: r2(cx + p.x), y: r2(cy + p.y) }))
    for (const [i, p] of sub.labels) res.edges[i].label = { x: r2(cx + p.x), y: r2(cy + p.y) }
  }
  place(null, 0, 0)
  const root = rel.get(null)!
  res.w = r2(root.w)
  res.h = r2(root.h)
  return res
}

/** Layered layout of one flat graph. Returns boxes in the given direction. */
function layered(
  items: Item[],
  es: Array<[number, number, number, number, number, number]>,
  dir: Dir,
  o: LOpts,
  budget: () => number,
  spend: (n: number) => void,
): { box: Box[]; bends: Map<number, Pt[]>; labels: Map<number, Pt>; w: number; h: number; capped: boolean } {
  const horiz = dir === 'LR' || dir === 'RL'
  // lay everything out top-to-bottom; LR/RL swap each box's axes first
  const N = items.length
  const W = (it: Item) => (horiz ? it.h : it.w)
  const H = (it: Item) => (horiz ? it.w : it.h)
  const out: number[][] = items.map(() => [])
  es.forEach(([u, v], k) => { if (u !== v) out[u].push(k) })
  // 1. cycle breaking: depth-first from the sources, in input order (a
  // flowchart's "reject → back to start" edge is the one reversed, as in
  // mermaid). A graph with no source — every node on a cycle — is entered at
  // the node with the most (out − in) edges, parallel edges counted, so two
  // edges one way outvote one edge back. An edge that closes a cycle is laid
  // out reversed (it still draws its own way).
  const deg = new Float64Array(N)
  es.forEach(([u, v]) => { if (u !== v) { deg[u]++; deg[v]-- } })
  const hasIn0 = new Uint8Array(N)
  es.forEach(([u, v]) => { if (u !== v) hasIn0[v] = 1 })
  const roots = [...items.keys()].sort((a, b) => hasIn0[a] - hasIn0[b] || (hasIn0[a] ? deg[b] - deg[a] : 0) || a - b)
  const rev = new Set<number>()
  const state = new Uint8Array(N) // 0 new, 1 on stack, 2 done
  for (const s of roots) {
    if (state[s]) continue
    const st: Array<[number, number]> = [[s, 0]]
    state[s] = 1
    while (st.length) {
      const top = st[st.length - 1]
      const [n, i] = top
      if (i < out[n].length) {
        top[1]++
        const k = out[n][i]
        const v = es[k][1]
        if (state[v] === 1) rev.add(k)
        else if (!state[v]) { state[v] = 1; st.push([v, 0]) }
      } else { state[n] = 2; st.pop() }
    }
  }
  const dag = es.map(([u, v, m], k): [number, number, number] => (rev.has(k) ? [v, u, m] : [u, v, m]))
  // 2. longest-path layering (Kahn, input order), minlen doubled
  const indeg = new Int32Array(N)
  const succ: number[][] = items.map(() => [])
  dag.forEach(([u, v], k) => { if (u !== v) { indeg[v]++; succ[u].push(k) } })
  const layer = new Int32Array(N)
  const topo: number[] = []
  for (let i = 0; i < N; i++) if (!indeg[i]) topo.push(i)
  for (let q = 0; q < topo.length; q++) {
    const u = topo[q]
    for (const k of succ[u]) {
      const [, v, m] = dag[k]
      layer[v] = Math.max(layer[v], layer[u] + 2 * Math.max(1, m))
      if (!--indeg[v]) topo.push(v)
    }
  }
  // pull each source down to just above its nearest successor
  const hasIn = new Uint8Array(N)
  for (const [u, v] of dag) if (u !== v) hasIn[v] = 1
  for (let q = topo.length - 1; q >= 0; q--) {
    const u = topo[q]
    if (hasIn[u] || !succ[u].length) continue
    let best = Infinity
    for (const k of succ[u]) best = Math.min(best, layer[dag[k][1]] - 2 * Math.max(1, dag[k][2]))
    if (best > layer[u] && best < Infinity) layer[u] = best
  }
  // 3. dummies: a chain per long edge; a labelled edge's middle dummy has the label's size
  const all: Item[] = items.map((it) => ({ w: W(it), h: H(it), dummy: 0 }))
  const lay: number[] = Array.from(layer)
  const chains = new Map<number, number[]>() // es index → dummy item indices
  const adjUp: number[][] = all.map(() => [])
  const adjDn: number[][] = all.map(() => [])
  const link = (a: number, b: number) => { adjDn[a].push(b); adjUp[b].push(a) }
  let capped = false
  dag.forEach(([u, v], k) => {
    if (u === v) return
    const span = lay[v] - lay[u]
    const lw = es[k][3], lh = es[k][4]
    if (span - 1 > budget()) {
      capped = true
      link(u, v)
      return
    }
    spend(span - 1)
    const mid = lay[u] + (span >> 1) - ((span >> 1) % 2 === 0 ? 1 : 0)
    const chain: number[] = []
    let prev = u
    for (let l = lay[u] + 1; l < lay[v]; l++) {
      const lab = lw > 0 && l === mid
      const it: Item = lab ? { w: horiz ? lh : lw, h: horiz ? lw : lh, dummy: 2 } : { w: 2, h: 0, dummy: 1 }
      all.push(it)
      lay.push(l)
      adjUp.push([])
      adjDn.push([])
      const id = all.length - 1
      chain.push(id)
      link(prev, id)
      prev = id
    }
    link(prev, v)
    chains.set(k, rev.has(k) ? chain.reverse() : chain)
  })
  // 4. ordering: layers in DFS discovery order, then barycentre sweeps
  const L = lay.reduce((m, l) => Math.max(m, l), 0) + 1
  const layers: number[][] = Array.from({ length: L }, () => [])
  const seen = new Uint8Array(all.length)
  for (let s = 0; s < all.length; s++) {
    if (seen[s] || s >= N || hasIn[s]) continue
    const st = [s]
    while (st.length) {
      const n = st.pop()!
      if (seen[n]) continue
      seen[n] = 1
      layers[lay[n]].push(n)
      for (let i = adjDn[n].length - 1; i >= 0; i--) if (!seen[adjDn[n][i]]) st.push(adjDn[n][i])
    }
  }
  for (let s = 0; s < all.length; s++) if (!seen[s]) { seen[s] = 1; layers[lay[s]].push(s) }
  const pos = new Float64Array(all.length)
  const setPos = () => layers.forEach((ly) => ly.forEach((n, i) => { pos[n] = i }))
  setPos()
  const crossings = () => {
    let c = 0
    for (let l = 0; l < L - 1; l++) {
      const pairs: Array<[number, number]> = []
      for (const n of layers[l]) for (const m of adjDn[n]) pairs.push([pos[n], pos[m]])
      pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1])
      const size = layers[l + 1].length + 1
      const bit = new Int32Array(size + 1)
      for (let i = 0; i < pairs.length; i++) {
        // count earlier pairs whose lower end is to the right of this one's
        let s = 0
        for (let j = size; j > 0; j -= j & -j) s += bit[j]
        let le = 0
        for (let j = pairs[i][1] + 1; j > 0; j -= j & -j) le += bit[j]
        c += s - le
        for (let j = pairs[i][1] + 1; j <= size; j += j & -j) bit[j]++
      }
    }
    return c
  }
  let best = layers.map((l) => l.slice())
  let bestC = crossings()
  for (let it = 0; it < 8 && bestC > 0; it++) {
    const down = it % 2 === 0
    for (let k = 1; k < L; k++) {
      const l = down ? k : L - 1 - k
      const nb = down ? adjUp : adjDn
      const key = new Map<number, number>()
      for (const n of layers[l]) {
        const ns = nb[n]
        key.set(n, ns.length ? ns.reduce((s, m) => s + pos[m], 0) / ns.length : pos[n])
      }
      layers[l].sort((a, b) => key.get(a)! - key.get(b)! || pos[a] - pos[b])
      layers[l].forEach((n, i) => { pos[n] = i })
    }
    const c = crossings()
    if (c < bestC) { bestC = c; best = layers.map((l) => l.slice()) }
  }
  for (let l = 0; l < L; l++) layers[l] = best[l]
  setPos()
  // 5. coordinates: pack, then pull toward neighbours (isotonic regression)
  const x = new Float64Array(all.length)
  const sep = (a: number, b: number) => (all[a].w + all[b].w) / 2 + (all[a].dummy && all[b].dummy ? o.nodeGap / 4 : o.nodeGap / (all[a].dummy || all[b].dummy ? 2 : 1))
  for (const ly of layers) {
    let cx = 0
    ly.forEach((n, i) => { if (i) cx += sep(ly[i - 1], n); x[n] = cx })
  }
  const place = (ly: number[], want: (n: number) => number | null) => {
    if (!ly.length) return
    // target t_i = desired_i - offset_i must be non-decreasing: PAVA
    const off: number[] = [0]
    for (let i = 1; i < ly.length; i++) off.push(off[i - 1] + sep(ly[i - 1], ly[i]))
    const blocks: Array<{ v: number; wt: number; n: number }> = []
    ly.forEach((n, i) => {
      const w = want(n)
      const wt = all[n].dummy ? 2 : 1
      blocks.push({ v: (w ?? x[n]) - off[i], wt: w === null ? 0.01 : wt, n: 1 })
      while (blocks.length > 1 && blocks[blocks.length - 2].v >= blocks[blocks.length - 1].v) {
        const b = blocks.pop()!, a = blocks[blocks.length - 1]
        a.v = (a.v * a.wt + b.v * b.wt) / (a.wt + b.wt)
        a.wt += b.wt
        a.n += b.n
      }
    })
    let i = 0
    for (const b of blocks) for (let j = 0; j < b.n; j++, i++) x[ly[i]] = b.v + off[i]
  }
  const mean = (ns: number[]) => (ns.length ? ns.reduce((s, m) => s + x[m], 0) / ns.length : null)
  for (let round = 0; round < 6; round++) {
    const down = round % 2 === 0
    for (let k = 0; k < L; k++) {
      const l = down ? k : L - 1 - k
      place(layers[l], (n) => (round === 5 ? mean(adjUp[n].concat(adjDn[n])) : mean(down ? adjUp[n] : adjDn[n])))
    }
  }
  // normalise x to start at 0; layer y from the tallest item in each layer
  let minX = Infinity, maxX = -Infinity
  for (let n = 0; n < all.length; n++) { minX = Math.min(minX, x[n] - all[n].w / 2); maxX = Math.max(maxX, x[n] + all[n].w / 2) }
  if (!all.length) minX = maxX = 0
  const ly = new Float64Array(L)
  let cy = 0
  for (let l = 0; l < L; l++) {
    const th = layers[l].reduce((m, n) => Math.max(m, all[n].h), 0)
    if (l) cy += o.rankGap / 2
    ly[l] = cy + th / 2
    cy += th
  }
  const TW = maxX - minX, TH = cy
  // 6. direction transform
  const at = (n: number): Pt => {
    const px = x[n] - minX, py = ly[lay[n]]
    if (dir === 'TB') return { x: px, y: py }
    if (dir === 'BT') return { x: px, y: TH - py }
    if (dir === 'LR') return { x: py, y: px }
    return { x: TH - py, y: px }
  }
  const box: Box[] = items.map((it, n) => {
    const c = at(n)
    return { x: c.x - it.w / 2, y: c.y - it.h / 2, w: it.w, h: it.h }
  })
  const bends = new Map<number, Pt[]>()
  const labels = new Map<number, Pt>()
  for (const [k, chain] of chains) {
    const k0 = es[k][5]
    bends.set(k0, chain.map(at))
    const lab = chain.find((n) => all[n].dummy === 2)
    if (lab !== undefined) labels.set(k0, at(lab))
  }
  return { box, bends, labels, w: horiz ? TH : TW, h: horiz ? TW : TH, capped }
}
