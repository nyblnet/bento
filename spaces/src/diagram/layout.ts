// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A small layered (Sugiyama-style) layout for compound directed graphs.
// Written for mermaid.ts; pure, DOM-free and deterministic: the same input
// gives the same output byte for byte (no randomness, no Map-order surprises:
// every iteration order is the input order). A kernel candidate, with
// mermaid.ts: it has zero app imports.
//
// SUBGRAPHS, the way mermaid treats them:
//  · a subgraph none of whose members links outside it is laid out on its own
//    (in its own `direction`, or the parent's flipped: TB ⇄ LR, as mermaid
//    does) and then takes part in its parent as ONE node of its own size;
//  · a subgraph whose members DO link outside is a compound: its members take
//    part in the parent's layering and ordering, kept contiguous in every
//    layer, and its box is solved together with everything around it, so a
//    non-member never lands inside it. Edges between subgraphs get their bend
//    points in the space BETWEEN the boxes. (Mermaid ignores `direction` on
//    such a subgraph, and so do we.)
//
// The phases of one layered pass:
//  1. cycle breaking — depth-first from the sources; an edge that closes a
//     cycle is laid out reversed (it still draws its own way);
//  2. layer assignment — longest path, then sources pulled down next to their
//     first successor so a lone start node does not float at the top;
//  3. every rank is DOUBLED (dagre's trick): real nodes sit on even layers and
//     a labelled edge gets a dummy of its label's size on the odd layer in its
//     middle, so edge labels take up real space and never overlap a node;
//     longer edges get a chain of thin dummies, which become their bends. A
//     dummy belongs to the innermost subgraph holding both ends of its edge;
//  4. crossing reduction — barycentre sweeps down and up, keeping the best
//     ordering seen (crossings counted exactly with a Fenwick tree). The sort
//     key is hierarchical, so a subgraph's members stay contiguous, and a
//     subgraph's key is global, so sibling subgraphs keep one order in every
//     layer (otherwise their boxes could not both be rectangles);
//  5. coordinates — each layer, subgraph borders included, is placed at the
//     positions its neighbours' mean asks for, subject to the minimum
//     separations: isotonic regression, solved exactly by pool-adjacent-
//     violators, a few rounds. Then one longest-path pass over the separation
//     constraints, with each subgraph's left and right border as ONE variable
//     across all its layers, makes the result legal;
//  6. the direction (TB/BT/LR/RL) is a final transform of a TB layout.

export type Dir = 'TB' | 'BT' | 'LR' | 'RL'
export interface Pt { x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }

/** A node to place. `parent` is the id of the cluster it sits in (null = root). */
export interface LNode { id: string; w: number; h: number; parent: string | null }
/** A cluster (subgraph). `top` is the room its title needs above the content. */
export interface LCluster { id: string; parent: string | null; dir?: Dir; top: number; minW: number }
/** An edge between two node or cluster ids. `lw/lh` = the label's size (0 when none). */
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
  /** subgraphs whose `direction` was ignored because their members link outside */
  ignoredDir: string[]
}

/** one entry of a layer. kind: 0 item, 1 bend, 2 label, 3 filler, 4 left border, 5 right border */
interface Ent { w: number; h: number; g: number; kind: number }
interface Sub { box: Box[]; groups: Box[]; bends: Map<number, Pt[]>; labels: Map<number, Pt>; w: number; h: number }
type LE = [number, number, number, number, number, number, number] // u v minlen lw lh edgeIndex group

const r2 = (v: number) => Math.round(v * 100) / 100

export function layout(nodes: LNode[], clusters: LCluster[], edges: LEdge[], dir: Dir, o: LOpts): LResult {
  const parentOf = new Map<string, string | null>()
  const cinfo = new Map<string, LCluster>()
  for (const c of clusters) { parentOf.set(c.id, c.parent); cinfo.set(c.id, c) }
  for (const n of nodes) parentOf.set(n.id, n.parent)
  const anc = (x: string): string[] => {
    const out: string[] = []
    for (let p = parentOf.get(x); p != null && out.length < 1000; p = parentOf.get(p)) out.push(p)
    return out
  }
  // a subgraph is COMPOUND when an edge has exactly one end strictly inside it
  // (an edge to the subgraph itself does not count)
  const compound = new Set<string>()
  for (const e of edges) {
    const A = anc(e.from), B = anc(e.to)
    for (const c of A) if (!B.includes(c) && c !== e.to) compound.add(c)
    for (const c of B) if (!A.includes(c) && c !== e.from) compound.add(c)
  }
  // the context an id is laid out in: its nearest non-compound ancestor (null = root)
  const ctxOf = (x: string): string | null => anc(x).find((c) => !compound.has(c)) ?? null
  const res: LResult = { nodes: new Map(), clusters: new Map(), edges: edges.map(() => ({ bends: [] })), w: 0, h: 0, capped: false, ignoredDir: [] }
  let budget = o.maxDummies
  const size = new Map<string, { w: number; h: number }>()
  for (const n of nodes) size.set(n.id, n)
  const cdir = new Map<string | null, Dir>([[null, dir]])
  // contexts, children before parents: deeper first, then input order
  const ctxs: Array<string | null> = clusters.filter((c) => !compound.has(c.id)).map((c) => c.id)
  ctxs.sort((a, b) => anc(b!).length - anc(a!).length)
  ctxs.push(null)
  for (const c of clusters) if (compound.has(c.id) && c.dir) res.ignoredDir.push(c.id)
  const dirOf = (k: string | null): Dir => {
    if (cdir.has(k)) return cdir.get(k)!
    const pd = dirOf(ctxOf(k!))
    const d = cinfo.get(k!)!.dir ?? (pd === 'TB' ? 'LR' : 'TB')
    cdir.set(k, d)
    return d
  }
  const subs = new Map<string | null, { sub: Sub; items: string[]; groups: string[] }>()
  for (const K of ctxs) {
    // items: nodes and non-compound subgraphs whose context is K; groups: compound subgraphs in K
    const items: string[] = [], groups: string[] = []
    for (const n of nodes) if (ctxOf(n.id) === K) items.push(n.id)
    for (const c of clusters) if (c.id !== K && ctxOf(c.id) === K) (compound.has(c.id) ? groups : items).push(c.id)
    const ii = new Map(items.map((id, i) => [id, i]))
    const gi = new Map(groups.map((id, i) => [id, i]))
    const grpOf = (id: string) => { const p = parentOf.get(id); return p != null && gi.has(p) ? gi.get(p)! : -1 }
    const gpar = groups.map(grpOf)
    // lift an endpoint into K: an item, or a compound group (drawn to its box)
    const lift = (x: string): { i?: number; g?: number } | null => {
      for (let cur: string | null | undefined = x; cur != null && cur !== K; cur = parentOf.get(cur)) {
        if (ii.has(cur)) return { i: ii.get(cur)! }
        if (gi.has(cur)) return cur === x ? { g: gi.get(cur)! } : null
      }
      return null
    }
    const inGroup = (i: number, g: number) => { for (let p = grpOf(items[i]); p >= 0; p = gpar[p]) if (p === g) return true; return false }
    const lifted: Array<[{ i?: number; g?: number }, { i?: number; g?: number }, number]> = []
    edges.forEach((e, k) => {
      const a = lift(e.from), b = lift(e.to)
      if (a && b) lifted.push([a, b, k])
    })
    // an edge to a compound subgraph's box is laid out against one of its
    // members: a source member for an edge coming in, a sink member going out
    const rep = (g: number, incoming: boolean): number => {
      let first = -1
      for (let i = 0; i < items.length; i++) {
        if (!inGroup(i, g)) continue
        if (first < 0) first = i
        if (!lifted.some(([a, b]) => a.i !== undefined && b.i !== undefined && inGroup(a.i, g) && inGroup(b.i, g) && (incoming ? b.i === i : a.i === i) && a.i !== b.i)) return i
      }
      return first
    }
    const chainG = (x: { i?: number; g?: number }): number[] => {
      const c: number[] = []
      for (let g = x.i !== undefined ? grpOf(items[x.i]) : gpar[x.g!]; g >= 0; g = gpar[g]) c.push(g)
      return c
    }
    const es: LE[] = []
    const toBox = new Set<number>()
    for (const [a, b, k] of lifted) {
      if (a.g !== undefined || b.g !== undefined) toBox.add(k)
      const u = a.i ?? rep(a.g!, false), v = b.i ?? rep(b.g!, true)
      if (u < 0 || v < 0 || u === v) continue
      const cb = chainG(b)
      const lca = chainG(a).find((g) => cb.includes(g)) ?? -1
      es.push([u, v, edges[k].minlen, edges[k].lw, edges[k].lh, k, lca])
    }
    const its = items.map((id) => ({ ...size.get(id)!, group: grpOf(id) }))
    const gs = groups.map((id, i) => ({ parent: gpar[i], top: cinfo.get(id)!.top, minW: cinfo.get(id)!.minW }))
    const sub = layered(its, gs, es, dirOf(K), o, () => budget, (n) => { budget -= n })
    if (sub.capped) res.capped = true
    // an edge drawn to a compound box was laid out against one of its members:
    // its bends belong to that member, not the box, so it is drawn straight
    for (const k of toBox) { sub.bends.delete(k); sub.labels.delete(k) }
    if (K !== null) {
      const c = cinfo.get(K)!
      size.set(K, { w: Math.max(sub.w + 2 * o.pad, c.minW + 2 * o.pad), h: sub.h + 2 * o.pad + c.top })
    }
    subs.set(K, { sub: { ...sub, w: sub.w, h: sub.h }, items, groups })
  }
  // top-down: absolute positions
  const place = (K: string | null, ox: number, oy: number) => {
    const { sub, items, groups } = subs.get(K)!
    let cx = ox, cy = oy
    if (K !== null) {
      const c = cinfo.get(K)!, sz = size.get(K)!
      cx = ox + o.pad + (sz.w - 2 * o.pad - sub.w) / 2
      cy = oy + o.pad + c.top
    }
    const abs = (b: Box): Box => ({ x: r2(cx + b.x), y: r2(cy + b.y), w: r2(b.w), h: r2(b.h) })
    groups.forEach((id, g) => res.clusters.set(id, abs(sub.groups[g])))
    items.forEach((id, i) => {
      const b = abs(sub.box[i])
      if (cinfo.has(id)) { res.clusters.set(id, b); place(id, b.x, b.y) } else res.nodes.set(id, b)
    })
    for (const [i, pts] of sub.bends) res.edges[i].bends = pts.map((p) => ({ x: r2(cx + p.x), y: r2(cy + p.y) }))
    for (const [i, p] of sub.labels) res.edges[i].label = { x: r2(cx + p.x), y: r2(cy + p.y) }
  }
  place(null, 0, 0)
  const root = subs.get(null)!.sub
  res.w = r2(root.w)
  res.h = r2(root.h)
  return res
}

/** Layered layout of one context: items, compound groups, edges. TB-space inside. */
function layered(
  items: Array<{ w: number; h: number; group: number }>,
  groups: Array<{ parent: number; top: number; minW: number }>,
  es: LE[],
  dir: Dir,
  o: LOpts,
  budget: () => number,
  spend: (n: number) => void,
): Sub & { capped: boolean } {
  const horiz = dir === 'LR' || dir === 'RL'
  const N = items.length, G = groups.length
  const gpar = groups.map((g) => g.parent)
  // a group's padding in TB-space: the title sits on whichever side becomes the top
  const padTop = (g: number) => o.pad + (dir === 'TB' ? groups[g].top : 0)
  const padBot = (g: number) => o.pad + (dir === 'BT' ? groups[g].top : 0)
  const padLeft = (g: number) => o.pad + (horiz ? groups[g].top : 0)
  const out: number[][] = items.map(() => [])
  es.forEach(([u, v], k) => { if (u !== v) out[u].push(k) })
  // 1. cycle breaking: depth-first from the sources, in input order (a
  // flowchart's "reject → back to start" edge is the one reversed, as in
  // mermaid). A graph with no source — every node on a cycle — is entered at
  // the node with the most (out − in) edges, parallel edges counted.
  const deg = new Float64Array(N)
  const hasIn = new Uint8Array(N)
  es.forEach(([u, v]) => { if (u !== v) { deg[u]++; deg[v]--; hasIn[v] = 1 } })
  const roots = [...items.keys()].sort((a, b) => hasIn[a] - hasIn[b] || (hasIn[a] ? deg[b] - deg[a] : 0) || a - b)
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
  const dagIn = new Uint8Array(N)
  dag.forEach(([u, v], k) => { if (u !== v) { indeg[v]++; succ[u].push(k); dagIn[v] = 1 } })
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
  for (let q = topo.length - 1; q >= 0; q--) {
    const u = topo[q]
    if (dagIn[u] || !succ[u].length) continue
    let best = Infinity
    for (const k of succ[u]) best = Math.min(best, layer[dag[k][1]] - 2 * Math.max(1, dag[k][2]))
    if (best > layer[u] && best < Infinity) layer[u] = best
  }
  // 3. dummies: a chain per long edge; a labelled edge's middle dummy has the label's size
  const all: Ent[] = items.map((it) => ({ w: horiz ? it.h : it.w, h: horiz ? it.w : it.h, g: it.group, kind: 0 }))
  const lay: number[] = Array.from(layer)
  const chains = new Map<number, number[]>() // es index → dummy entry indices
  const adjUp: number[][] = all.map(() => [])
  const adjDn: number[][] = all.map(() => [])
  const add = (e: Ent, l: number) => { all.push(e); lay.push(l); adjUp.push([]); adjDn.push([]); return all.length - 1 }
  const link = (a: number, b: number) => { adjDn[a].push(b); adjUp[b].push(a) }
  let capped = false
  dag.forEach(([u, v], k) => {
    if (u === v) return
    const span = lay[v] - lay[u]
    const [, , , lw, lh, , grp] = es[k]
    if (span - 1 > budget()) { capped = true; link(u, v); return }
    spend(span - 1)
    const mid = lay[u] + (span >> 1) - ((span >> 1) % 2 === 0 ? 1 : 0)
    const chain: number[] = []
    let prev = u
    for (let l = lay[u] + 1; l < lay[v]; l++) {
      const lab = lw > 0 && l === mid
      const id = add(lab ? { w: horiz ? lh : lw, h: horiz ? lw : lh, g: grp, kind: 2 } : { w: 2, h: 0, g: grp, kind: 1 }, l)
      chain.push(id)
      link(prev, id)
      prev = id
    }
    link(prev, v)
    chains.set(k, rev.has(k) ? chain.reverse() : chain)
  })
  // groups: root-first ancestor chains, layer spans, and a filler wherever a
  // group spans a layer it has nothing in (else a stranger could sit inside its box)
  const up = (g: number) => { const c: number[] = []; for (; g >= 0; g = gpar[g]) c.unshift(g); return c }
  const gchain = groups.map((_, g) => up(g))
  const lo = new Array<number>(G).fill(Infinity), hi = new Array<number>(G).fill(-Infinity)
  const has = new Set<number>() // g * Lmax + l
  let Lmax = 0
  for (const l of lay) Lmax = Math.max(Lmax, l + 1)
  const mark = (g: number, l: number) => { for (const x of gchain[g]) { lo[x] = Math.min(lo[x], l); hi[x] = Math.max(hi[x], l); has.add(x * Lmax + l) } }
  all.forEach((e, n) => { if (e.g >= 0) mark(e.g, lay[n]) })
  for (let g = G - 1; g >= 0; g--) for (let l = lo[g]; l <= hi[g]; l++) if (!has.has(g * Lmax + l)) { add({ w: 0, h: 0, g, kind: 3 }, l); mark(g, l) }
  const chainOf = (n: number) => (all[n].g >= 0 ? gchain[all[n].g] : [])
  // 4. ordering: layers in DFS discovery order, then hierarchical barycentre sweeps
  const L = Lmax || 1
  const layers: number[][] = Array.from({ length: L }, () => [])
  const seen = new Uint8Array(all.length)
  for (let s = 0; s < N; s++) {
    if (seen[s] || dagIn[s]) continue
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
  const rel = (n: number) => (pos[n] + 0.5) / layers[lay[n]].length
  const nkey = new Float64Array(all.length)
  const gkey = new Float64Array(G)
  const sortLayer = (l: number) => {
    layers[l].sort((a, b) => {
      const ca = chainOf(a), cb = chainOf(b)
      let i = 0
      while (i < ca.length && i < cb.length && ca[i] === cb[i]) i++
      const ka = i < ca.length ? gkey[ca[i]] : nkey[a], kb = i < cb.length ? gkey[cb[i]] : nkey[b]
      return ka - kb || (i < ca.length ? ca[i] : G + pos[a]) - (i < cb.length ? cb[i] : G + pos[b])
    })
    layers[l].forEach((n, i) => { pos[n] = i })
  }
  const groupKeys = () => {
    const sum = new Float64Array(G), cnt = new Float64Array(G)
    all.forEach((_, n) => { for (const g of chainOf(n)) { sum[g] += rel(n); cnt[g]++ } })
    for (let g = 0; g < G; g++) gkey[g] = cnt[g] ? sum[g] / cnt[g] : 0
  }
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
  // the first pass only makes groups contiguous and consistently ordered
  groupKeys()
  for (let n = 0; n < all.length; n++) nkey[n] = rel(n)
  for (let l = 0; l < L; l++) sortLayer(l)
  let best = layers.map((l) => l.slice())
  let bestC = crossings()
  for (let it = 0; it < 8 && bestC > 0; it++) {
    const down = it % 2 === 0
    groupKeys()
    for (let k = 1; k < L; k++) {
      const l = down ? k : L - 1 - k
      const nb = down ? adjUp : adjDn
      for (const n of layers[l]) {
        const ns = nb[n]
        nkey[n] = ns.length ? ns.reduce((s, m) => s + rel(m), 0) / ns.length : rel(n)
      }
      sortLayer(l)
    }
    const c = crossings()
    if (c < bestC) { bestC = c; best = layers.map((l) => l.slice()) }
  }
  for (let l = 0; l < L; l++) layers[l] = best[l]
  setPos()
  // 5. coordinates. Each layer becomes a token list with each group's left and
  // right borders as zero-width tokens around its members.
  const E0 = all.length
  const side = new Map<number, number>() // (g * L + l) * 2 + right → token entry
  const tokens: number[][] = layers.map((ly, l) => {
    const t: number[] = [], open: number[] = []
    const close = (keep: number) => { while (open.length > keep) { const g = open.pop()!; const id = add({ w: 0, h: 0, g, kind: 5 }, l); side.set((g * L + l) * 2 + 1, id); t.push(id) } }
    for (const n of ly) {
      const c = chainOf(n)
      let i = 0
      while (i < open.length && i < c.length && open[i] === c[i]) i++
      close(i)
      for (; i < c.length; i++) { const id = add({ w: 0, h: 0, g: c[i], kind: 4 }, l); side.set((c[i] * L + l) * 2, id); t.push(id); open.push(c[i]) }
      t.push(n)
    }
    close(0)
    return t
  })
  const half = (n: number) => (all[n].kind < 4 ? all[n].w / 2 : 0)
  const light = (n: number) => all[n].kind === 1 || all[n].kind === 2 || all[n].kind === 3
  const gap = (a: number, b: number) => {
    const A = all[a], B = all[b]
    if (A.kind === 4) return padLeft(A.g)
    if (B.kind === 5) return o.pad
    return light(a) && light(b) ? o.nodeGap / 4 : light(a) || light(b) ? o.nodeGap / 2 : o.nodeGap
  }
  const sep = (a: number, b: number) => half(a) + gap(a, b) + half(b)
  const x = new Float64Array(all.length)
  for (const t of tokens) {
    let cx = 0
    t.forEach((n, i) => { if (i) cx += sep(t[i - 1], n); x[n] = cx })
  }
  const place = (t: number[], want: (n: number) => number | null) => {
    if (!t.length) return
    // target_i = desired_i − offset_i must be non-decreasing: PAVA
    const off: number[] = [0]
    for (let i = 1; i < t.length; i++) off.push(off[i - 1] + sep(t[i - 1], t[i]))
    const blocks: Array<{ v: number; wt: number; n: number }> = []
    t.forEach((n, i) => {
      const w = want(n)
      const wt = all[n].kind >= 4 ? 4 : all[n].kind ? 2 : 1
      blocks.push({ v: (w ?? x[n]) - off[i], wt: w === null ? 0.01 : wt, n: 1 })
      while (blocks.length > 1 && blocks[blocks.length - 2].v >= blocks[blocks.length - 1].v) {
        const b = blocks.pop()!, a = blocks[blocks.length - 1]
        a.v = (a.v * a.wt + b.v * b.wt) / (a.wt + b.wt)
        a.wt += b.wt
        a.n += b.n
      }
    })
    let i = 0
    for (const b of blocks) for (let j = 0; j < b.n; j++, i++) x[t[i]] = b.v + off[i]
  }
  const mean = (ns: number[]) => (ns.length ? ns.reduce((s, m) => s + x[m], 0) / ns.length : null)
  // a border wants to line up with the same border one layer up and down
  const border = (n: number, l: number, dirs: number[]) => {
    const e = all[n], ns: number[] = []
    for (const d of dirs) { const m = side.get((e.g * L + l + d) * 2 + (e.kind - 4)); if (m !== undefined && l + d >= 0 && l + d < L) ns.push(m) }
    return mean(ns)
  }
  for (let round = 0; round < 6; round++) {
    const down = round % 2 === 0
    for (let k = 0; k < L; k++) {
      const l = down ? k : L - 1 - k
      const d = round === 5 ? [-1, 1] : [down ? -1 : 1]
      place(tokens[l], (n) => (all[n].kind >= 4 ? border(n, l, d) : all[n].kind === 3 ? null : mean(round === 5 ? adjUp[n].concat(adjDn[n]) : down ? adjUp[n] : adjDn[n])))
    }
  }
  // legalise: longest path over the separation constraints, a group's left
  // (and right) border being ONE variable in every layer it spans
  const V = E0 + 2 * G
  const vOf = (n: number) => (all[n].kind === 4 ? E0 + 2 * all[n].g : all[n].kind === 5 ? E0 + 2 * all[n].g + 1 : n)
  const val = new Float64Array(V).fill(-Infinity)
  for (let n = 0; n < E0; n++) val[n] = x[n]
  const outs: Array<Array<[number, number]>> = Array.from({ length: V }, () => [])
  const indg = new Int32Array(V)
  const need = (a: number, b: number, d: number) => { outs[a].push([b, d]); indg[b]++ }
  for (let n = E0; n < all.length; n++) if (all[n].kind === 4) val[vOf(n)] = Math.min(val[vOf(n)] === -Infinity ? Infinity : val[vOf(n)], x[n])
  for (let g = 0; g < G; g++) if (!horiz) need(E0 + 2 * g, E0 + 2 * g + 1, groups[g].minW + 2 * o.pad)
  for (const t of tokens) for (let i = 1; i < t.length; i++) need(vOf(t[i - 1]), vOf(t[i]), sep(t[i - 1], t[i]))
  const q: number[] = []
  for (let v = 0; v < V; v++) if (!indg[v]) q.push(v)
  const done = new Uint8Array(V)
  const relax = (v: number) => { done[v] = 1; for (const [w, d] of outs[v]) { if (val[v] + d > val[w]) val[w] = val[v] + d; if (!--indg[w]) q.push(w) } }
  for (let i = 0; i < q.length; i++) relax(q[i])
  for (let v = 0; v < V; v++) if (!done[v]) relax(v) // a cycle (should not happen): best effort
  // pull each left border in as far as its contents allow, innermost first
  for (const g of [...groups.keys()].sort((a, b) => gchain[b].length - gchain[a].length)) {
    const Lv = E0 + 2 * g
    let m = val[Lv + 1] - (horiz ? 0 : groups[g].minW) - 2 * o.pad
    for (const [w, d] of outs[Lv]) if (w !== Lv + 1) m = Math.min(m, val[w] - d)
    if (m > val[Lv]) val[Lv] = m
  }
  // then improve without ever breaking a constraint: shift each group whole
  // (members, nested groups and borders together) toward where its members
  // want to be, as far as its slack allows; then each entry alone, within its
  // neighbours; then pull the borders tight again
  const ins: Array<Array<[number, number]>> = Array.from({ length: V }, () => [])
  outs.forEach((os, v) => { for (const [w, d] of os) ins[w].push([v, d]) })
  const vch = (v: number) => (v < E0 ? chainOf(v) : gchain[(v - E0) >> 1])
  const mem: number[][] = groups.map(() => [])
  for (let v = 0; v < V; v++) for (const g of vch(v)) mem[g].push(v)
  const want = (v: number) => {
    const ns = all[v].kind < 3 ? adjUp[v].concat(adjDn[v]) : []
    return ns.length ? ns.reduce((s, m) => s + val[m], 0) / ns.length : null
  }
  const lower = (v: number, skip?: number) => ins[v].reduce((m, [u, d]) => (skip !== undefined && vch(u).includes(skip) ? m : Math.max(m, val[u] + d)), -Infinity)
  const upper = (v: number, skip?: number) => outs[v].reduce((m, [w, d]) => (skip !== undefined && vch(w).includes(skip) ? m : Math.min(m, val[w] - d)), Infinity)
  const outer = [...groups.keys()].sort((a, b) => gchain[a].length - gchain[b].length)
  for (let round = 0; round < 8; round++) {
    for (const g of outer) {
      let sum = 0, cnt = 0, lo = -Infinity, hi = Infinity
      for (const v of mem[g]) {
        const w = v < E0 ? want(v) : null
        if (w !== null) { sum += w - val[v]; cnt++ }
        lo = Math.max(lo, lower(v, g) - val[v])
        hi = Math.min(hi, upper(v, g) - val[v])
      }
      const d = cnt ? Math.max(lo, Math.min(hi, sum / cnt)) : 0
      if (d) for (const v of mem[g]) val[v] += d
    }
    for (let v = 0; v < E0; v++) {
      const w = want(v)
      if (w !== null) val[v] = Math.max(lower(v), Math.min(upper(v), w))
    }
    for (const g of [...outer].reverse()) {
      const Lv = E0 + 2 * g
      val[Lv] = Math.max(lower(Lv), upper(Lv))
      val[Lv + 1] = Math.min(upper(Lv + 1), lower(Lv + 1))
    }
  }
  for (let n = 0; n < E0; n++) x[n] = val[n]
  // y: layer thickness, plus room above and below for the groups that start or end there
  const extT = new Float64Array(G), extB = new Float64Array(G)
  for (const g of [...groups.keys()].sort((a, b) => gchain[b].length - gchain[a].length)) {
    extT[g] += padTop(g); extB[g] += padBot(g)
    const p = gpar[g]
    if (p >= 0) { if (lo[p] === lo[g]) extT[p] = Math.max(extT[p], extT[g]); if (hi[p] === hi[g]) extB[p] = Math.max(extB[p], extB[g]) }
  }
  const gapT = new Float64Array(L), gapB = new Float64Array(L)
  for (let g = 0; g < G; g++) if (lo[g] <= hi[g]) { gapT[lo[g]] = Math.max(gapT[lo[g]], extT[g]); gapB[hi[g]] = Math.max(gapB[hi[g]], extB[g]) }
  const ly = new Float64Array(L)
  let cy = 0
  for (let l = 0; l < L; l++) {
    const th = layers[l].reduce((m, n) => Math.max(m, all[n].h), 0)
    cy += (l ? o.rankGap / 2 + gapB[l - 1] : 0) + gapT[l]
    ly[l] = cy + th / 2
    cy += th
  }
  cy += L ? gapB[L - 1] : 0
  // group boxes in TB-space, innermost first
  const gb: Box[] = groups.map(() => ({ x: 0, y: Infinity, w: 0, h: -Infinity }))
  for (let n = 0; n < E0; n++) {
    const g = all[n].g
    if (g < 0) continue
    const b = gb[g]
    b.y = Math.min(b.y, ly[lay[n]] - all[n].h / 2)
    b.h = Math.max(b.h, ly[lay[n]] + all[n].h / 2)
  }
  for (const g of [...groups.keys()].sort((a, b) => gchain[b].length - gchain[a].length)) {
    const b = gb[g]
    b.y -= padTop(g); b.h += padBot(g)
    b.x = val[E0 + 2 * g]
    b.w = val[E0 + 2 * g + 1] - b.x
    const p = gpar[g]
    if (p >= 0) { gb[p].y = Math.min(gb[p].y, b.y); gb[p].h = Math.max(gb[p].h, b.h) }
    b.h -= b.y
  }
  let minX = Infinity, maxX = -Infinity
  for (let n = 0; n < E0; n++) { minX = Math.min(minX, x[n] - all[n].w / 2); maxX = Math.max(maxX, x[n] + all[n].w / 2) }
  for (const b of gb) { minX = Math.min(minX, b.x); maxX = Math.max(maxX, b.x + b.w) }
  if (!E0) minX = maxX = 0
  const TW = maxX - minX, TH = cy
  // 6. direction transform, of boxes (TB-space → final)
  const tr = (b: Box): Box => {
    const bx = b.x - minX
    if (dir === 'TB') return { x: bx, y: b.y, w: b.w, h: b.h }
    if (dir === 'BT') return { x: bx, y: TH - b.y - b.h, w: b.w, h: b.h }
    if (dir === 'LR') return { x: b.y, y: bx, w: b.h, h: b.w }
    return { x: TH - b.y - b.h, y: bx, w: b.h, h: b.w }
  }
  const at = (n: number): Pt => { const b = tr({ x: x[n], y: ly[lay[n]], w: 0, h: 0 }); return { x: b.x, y: b.y } }
  const box = items.map((_, n) => tr({ x: x[n] - all[n].w / 2, y: ly[lay[n]] - all[n].h / 2, w: all[n].w, h: all[n].h }))
  const bends = new Map<number, Pt[]>()
  const labels = new Map<number, Pt>()
  for (const [k, chain] of chains) {
    const k0 = es[k][5]
    bends.set(k0, chain.map(at))
    const lab = chain.find((n) => all[n].kind === 2)
    if (lab !== undefined) labels.set(k0, at(lab))
  }
  return { box, groups: gb.map(tr), bends, labels, w: horiz ? TH : TW, h: horiz ? TW : TH, capped }
}
