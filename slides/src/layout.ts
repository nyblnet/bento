// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Auto layout. A frame is a rect shape carrying `layout`; the elements whose
// `parentId` names it are laid out inside it, Figma/Penpot style (row, column
// or grid, gap, padding, alignment, fill and hug).
//
// The result is WRITTEN into the model — each child's x/y/w/h, and the
// frame's own size when it hugs. Derived, not committed, exactly like
// connectors.ts: every replica computes the same boxes from the same inputs,
// so it is never an undo step and never a CRDT op of its own. That is what
// keeps the format additive: a renderer, the morph, an export or a shell that
// predates frames reads plain positioned elements and draws the same picture.
//
// Order along the main axis is the children's CURRENT start coordinate (ties
// keep array order), so dragging a child past a sibling reorders it, and a
// child that grows keeps its place.

import type { ShapeElement, Slide, SlideElement } from './model'

/** Whether `frameId` can take `ids`: it is an unlocked auto-layout frame on
 *  the slide, and none of the moving elements is that frame or holds it. */
export function canAccept(slide: Slide, ids: readonly string[], frameId: string): boolean {
  const f = slide.elements.find((e) => e.id === frameId)
  if (!isFrame(f) || f.locked) return false
  const units = withDescendants(slide, slide.elements.filter((e) => ids.includes(e.id)))
  return !units.some((e) => e.id === frameId)
}

/**
 * Put `ids` inside frame `frameId` at slot `slot` of its children (layout
 * order), each with everything inside it. The frame's whole subtree is laid
 * back into the array as one block — the frame, then each child's unit in
 * flow order — so the children paint above their frame, and the solver,
 * reading ties by array order after reflowByArray, flows them in that order.
 * Reports whether anything moved; refuses a cycle or a frame that can't take them.
 */
export function moveIntoFrame(slide: Slide, ids: readonly string[], frameId: string, slot: number): boolean {
  if (!ids.length || !canAccept(slide, ids, frameId)) return false
  const f = slide.elements.find((e) => e.id === frameId) as Frame
  const moving = slide.elements.filter((e) => ids.includes(e.id))
  const stay = frameChildren(slide, f).filter((e) => !ids.includes(e.id))
  const at = Math.max(0, Math.min(stay.length, slot))
  const order = [...stay.slice(0, at), ...moving, ...stay.slice(at)]
  for (const m of moving) { m.parentId = frameId; delete m.sizing }
  layBlock(slide, f, order)
  reflowByArray(slide, frameId)
  return true
}

/** Lay frame `f`'s whole subtree back into the array as one block where the
 *  frame stands: the frame, then each child's unit in `order` — so every
 *  child paints above its frame, and its own contents above it. */
function layBlock(slide: Slide, f: Frame, order: SlideElement[]): void {
  const block = [f, ...order.flatMap((c) => withDescendants(slide, [c]))]
  const inBlock = new Set(block.map((e) => e.id))
  const rest = slide.elements.filter((e) => !inBlock.has(e.id))
  const before = slide.elements.slice(0, slide.elements.indexOf(f)).filter((e) => !inBlock.has(e.id)).length
  rest.splice(before, 0, ...block)
  slide.elements = rest
}

/** Take `ids` out of their frames to the slide's top level, keeping where they
 *  sit on the slide; each lands just above (or below) `targetId`'s unit in
 *  paint order. Reports whether anything changed. */
export function moveOutBeside(slide: Slide, ids: readonly string[], targetId: string | null, above: boolean): boolean {
  const moving = slide.elements.filter((e) => ids.includes(e.id))
  if (!moving.length) return false
  for (const m of moving) { delete m.parentId; delete m.sizing }
  const units = withDescendants(slide, moving)
  const inUnits = new Set(units.map((e) => e.id))
  const rest = slide.elements.filter((e) => !inUnits.has(e.id))
  const target = targetId ? rest.find((e) => e.id === targetId) : undefined
  let at = rest.length
  if (target) {
    const tb = withDescendants({ elements: rest } as Slide, [target])
    at = above ? rest.indexOf(tb[tb.length - 1]) + 1 : rest.indexOf(tb[0])
  }
  rest.splice(at, 0, ...units)
  slide.elements = rest
  layoutSlide(slide)
  return true
}

type Frame = ShapeElement & { layout: NonNullable<ShapeElement['layout']> }

export const isFrame = (el: SlideElement | undefined): el is Frame =>
  !!el && el.type === 'shape' && el.shape === 'rect' && !!(el as ShapeElement).layout

/** The ids that are locked (or hidden) in effect: their own flag, or any
 *  frame's they sit in — a locked frame locks its contents and a hidden one
 *  hides them, as one unit, the way delete and duplicate already treat it.
 *  Each element's own flag is untouched, so unlocking the frame gives the
 *  children back exactly as they were. Cycle-safe on a hand-written file. */
export function flagged(slide: Pick<Slide, 'elements'>, key: 'locked' | 'hidden'): Set<string> {
  const byId = new Map(slide.elements.map((e) => [e.id, e]))
  const memo = new Map<string, boolean>()
  const on = (e: SlideElement, seen: Set<string>): boolean => {
    const known = memo.get(e.id)
    if (known !== undefined) return known
    let v = !!e[key]
    const up = e.parentId ? byId.get(e.parentId) : undefined
    if (!v && up && !seen.has(up.id)) v = on(up, seen.add(e.id))
    memo.set(e.id, v)
    return v
  }
  return new Set(slide.elements.filter((e) => on(e, new Set())).map((e) => e.id))
}

/** The elements and everything inside them (a frame's children, theirs, …),
 *  in paint order. A frame and its contents are one unit: copy, duplicate
 *  and delete act on this, never on the frame alone. */
export function withDescendants(slide: Slide, els: readonly SlideElement[]): SlideElement[] {
  const ids = new Set(els.map((e) => e.id))
  for (let grew = true; grew;) {
    grew = false
    for (const e of slide.elements) if (e.parentId && ids.has(e.parentId) && !ids.has(e.id)) { ids.add(e.id); grew = true }
  }
  return slide.elements.filter((e) => ids.has(e.id))
}

/** Children of a frame, in layout order. */
export function frameChildren(slide: Slide, frame: Frame): SlideElement[] {
  const kids = slide.elements.filter((e) => e.parentId === frame.id && e.id !== frame.id)
  const L = frame.layout
  if (L.dir === 'grid') {
    // the cell each child sits nearest, read by inverting place(): a settled
    // grid reads back its own order, and a child dropped on another cell moves there
    const g = gridGeom(frame, kids)
    const { justify = 'start', align = 'start' } = L
    const cell = (k: SlideElement) => {
      const col = Math.min(g.cols - 1, Math.max(0, Math.round((k.x - inCell(justify, g.cw, k.w) - g.x0) / (g.cw + L.gap || 1))))
      const row = Math.max(0, Math.round((k.y - inCell(align, g.ch, k.h) - g.y0) / (g.ch + L.gap || 1)))
      return row * g.cols + col
    }
    return stableSort(kids, (k) => cell(k) * 1e7 + k.x)
  }
  if (L.wrap) return wrapOrder(kids, L.dir === 'row')
  return stableSort(kids, (k) => (L.dir === 'row' ? k.x : k.y))
}

/** A wrapping run reads line by line: children whose cross-axis spans overlap
 *  share a line, and a line reads along the main axis. So a child dragged
 *  onto another line moves there, and a settled layout reads back the same. */
function wrapOrder(kids: SlideElement[], row: boolean): SlideElement[] {
  const [P, Q, C] = row ? (['x', 'y', 'h'] as const) : (['y', 'x', 'w'] as const)
  const byCross = stableSort(kids, (k) => k[Q] + k[C] / 2)
  const out: SlideElement[][] = []
  let end = -Infinity
  for (const k of byCross) {
    const mid = k[Q] + k[C] / 2
    if (!out.length || mid > end) { out.push([k]); end = k[Q] + k[C] }
    else { out[out.length - 1].push(k); end = Math.max(end, k[Q] + k[C]) }
  }
  return out.flatMap((line) => stableSort(line, (k) => k[P]))
}

function stableSort<T>(xs: T[], key: (x: T) => number): T[] {
  return xs.map((x, i) => ({ x, i, k: key(x) })).sort((a, b) => a.k - b.k || a.i - b.i).map((o) => o.x)
}

const r2 = (n: number) => Math.round(n * 100) / 100

/** Lay out every frame on every slide. True when anything moved. */
export function layoutAll(doc: { slides: Slide[]; layouts?: Slide[] }): boolean {
  let changed = false
  for (const s of [...doc.slides, ...(doc.layouts ?? [])]) if (layoutSlide(s)) changed = true
  return changed
}

/** Lay out one slide's frames: hug sizes inner-first, then positions outer-first. */
export function layoutSlide(slide: Slide): boolean {
  const byId = new Map(slide.elements.map((e) => [e.id, e]))
  let changed = false
  // a child whose frame is gone (deleted, or no longer a frame) is an
  // ordinary element again — the dangling link is dropped, as connectors drop theirs
  for (const e of slide.elements) if (e.parentId && !isFrame(byId.get(e.parentId))) { delete e.parentId; delete e.sizing; changed = true }
  // so is one whose chain of frames leads back to itself (a hand-written file,
  // a bad merge): the first element in paint order on the loop lets go, which
  // every replica decides the same way
  for (const e of slide.elements) {
    const seen = new Set<string>()
    for (let p = e.parentId; p && !seen.has(p); p = byId.get(p)?.parentId) {
      if (p === e.id) { delete e.parentId; delete e.sizing; changed = true; break }
      seen.add(p)
    }
  }
  const frames = slide.elements.filter(isFrame)
  if (!frames.length) return changed
  const depth = (el: SlideElement): number => {
    const p = el.parentId ? byId.get(el.parentId) : undefined
    return isFrame(p) ? 1 + depth(p) : 0 // acyclic now
  }
  const order = frames.map((f) => ({ f, d: depth(f) }))
  const set = (el: SlideElement, k: 'x' | 'y' | 'w' | 'h', v: number) => {
    if (!Number.isFinite(v)) return // a bad input (NaN gap, a token gone wrong) never reaches the model
    v = r2(Math.max(k === 'w' || k === 'h' ? 1 : -1e6, v))
    if (el[k] !== v) { el[k] = v; changed = true }
  }
  // a frame that fills its own parent on an axis is sized there by that parent, not by hugging
  const hugSet = (f: Frame): Put => (el, k, v) => { if (el !== f || !ownedByParent(f, byId, k as 'w' | 'h')) set(el, k, v) }
  for (const { f } of [...order].sort((a, b) => b.d - a.d)) if (f.layout.hug) hug(slide, f, hugSet(f))
  for (const { f } of [...order].sort((a, b) => a.d - b.d)) place(slide, f, set)
  return changed
}

type Put = (el: SlideElement, k: 'x' | 'y' | 'w' | 'h', v: number) => void

/** Grid columns as the solver uses them: a whole number 1..64, whatever the file or a token says. */
export const colsOf = (f: Frame) => { const c = Math.round(f.layout.cols ?? 2); return Number.isFinite(c) ? Math.min(64, Math.max(1, c)) : 2 }

/** Whether `f`'s parent frame sets `f`'s size on axis k (fill on that axis, or stretch across). */
function ownedByParent(f: Frame, byId: Map<string, SlideElement>, k: 'w' | 'h'): boolean {
  const p = f.parentId ? byId.get(f.parentId) : undefined
  if (!isFrame(p)) return false
  if (f.sizing?.[k] === 'fill') return true
  const cross = p.layout.dir === 'grid' || (p.layout.dir === 'row' ? k === 'h' : k === 'w')
  return cross && p.layout.align === 'stretch'
}

function hug(slide: Slide, f: Frame, set: Put) {
  const kids = frameChildren(slide, f)
  if (!kids.length) return
  const { dir, gap, pad } = f.layout
  const sum = (ks: SlideElement[], k: 'w' | 'h') => ks.reduce((a, e) => a + e[k], 0)
  const max = (ks: SlideElement[], k: 'w' | 'h') => Math.max(...ks.map((e) => e[k]))
  if (dir === 'grid') {
    const cols = Math.min(colsOf(f), kids.length)
    const rows = Math.ceil(kids.length / cols)
    const g = gridGeom(f, kids) // the cells place() will use
    set(f, 'w', pad[1] + pad[3] + cols * g.cw + gap * (cols - 1))
    set(f, 'h', pad[0] + pad[2] + rows * g.ch + gap * (rows - 1))
  } else if (f.layout.wrap) {
    // a wrapping frame keeps its main size (the lines break against it) and hugs across
    const row = dir === 'row'
    const ls = lines(kids, row ? 'w' : 'h', (row ? f.w - pad[1] - pad[3] : f.h - pad[0] - pad[2]), gap)
    const across = ls.reduce((a, l) => a + max(l, row ? 'h' : 'w'), 0) + gap * (ls.length - 1)
    if (row) set(f, 'h', pad[0] + pad[2] + across)
    else set(f, 'w', pad[1] + pad[3] + across)
  } else if (dir === 'row') {
    set(f, 'w', pad[1] + pad[3] + sum(kids, 'w') + gap * (kids.length - 1))
    set(f, 'h', pad[0] + pad[2] + max(kids, 'h'))
  } else {
    set(f, 'h', pad[0] + pad[2] + sum(kids, 'h') + gap * (kids.length - 1))
    set(f, 'w', pad[1] + pad[3] + max(kids, 'w'))
  }
}

/** Where a size sits in a room under a justify/align word. */
const inCell = (a: string, room: number, size: number) => (a === 'center' ? (room - size) / 2 : a === 'end' ? room - size : 0)

/** A grid frame's cells: one geometry for ordering (frameChildren) and placing (place). */
function gridGeom(f: Frame, kids: SlideElement[]) {
  const { gap, pad } = f.layout
  const cols = colsOf(f)
  const rows = Math.max(1, Math.ceil(kids.length / cols))
  const iw = Math.max(0, f.w - pad[1] - pad[3]), ih = Math.max(0, f.h - pad[0] - pad[2])
  // a hugging grid sizes its cells by the children that keep their own size:
  // a child that fills (or is stretched) takes the cell's size, so it cannot also set it
  const own = (k: 'w' | 'h') => kids.filter((c) => c.sizing?.[k] !== 'fill' && f.layout.align !== 'stretch')
  const cw = f.layout.hug ? Math.max(1, ...own('w').map((k) => k.w)) : (iw - gap * (cols - 1)) / cols
  const ch = f.layout.hug ? Math.max(1, ...own('h').map((k) => k.h)) : (ih - gap * (rows - 1)) / rows
  return { cols, cw, ch, x0: f.x + pad[3], y0: f.y + pad[0] }
}

function place(slide: Slide, f: Frame, set: Put) {
  const kids = frameChildren(slide, f)
  if (!kids.length) return
  const { dir, gap, pad, justify = 'start', align = 'start' } = f.layout
  const x0 = f.x + pad[3], y0 = f.y + pad[0]
  const iw = Math.max(0, f.w - pad[1] - pad[3]), ih = Math.max(0, f.h - pad[0] - pad[2])
  const at = inCell

  if (dir === 'grid') {
    const { cols, cw, ch } = gridGeom(f, kids)
    kids.forEach((k, i) => {
      const cx = x0 + (i % cols) * (cw + gap), cy = y0 + Math.floor(i / cols) * (ch + gap)
      if (k.sizing?.w === 'fill' || align === 'stretch') set(k, 'w', cw)
      if (k.sizing?.h === 'fill' || align === 'stretch') set(k, 'h', ch)
      set(k, 'x', cx + at(justify, cw, k.w))
      set(k, 'y', cy + at(align, ch, k.h))
    })
    return
  }

  // main axis M (w for a row), cross axis C
  const row = dir === 'row'
  const M = row ? 'w' : 'h', C = row ? 'h' : 'w', P = row ? 'x' : 'y', Q = row ? 'y' : 'x'
  const room = row ? iw : ih, cross = row ? ih : iw
  if (f.layout.wrap) {
    // each line breaks with its fill children at their minimum, then they share that line's free space
    let q = row ? y0 : x0
    for (const line of lines(kids, M, room, gap)) {
      const lineFills = line.filter((k) => k.sizing?.[M] === 'fill')
      const fixed = line.filter((k) => k.sizing?.[M] !== 'fill').reduce((a, k) => a + k[M], 0)
      const free = room - fixed - gap * (line.length - 1)
      for (const k of lineFills) set(k, M, Math.max(minOf(k, M), free / lineFills.length))
      const thick = Math.max(...line.map((k) => k[C]))
      const used = line.reduce((a, k) => a + k[M], 0) + gap * (line.length - 1)
      let step = gap
      let pos = (row ? x0 : y0)
      if (lineFills.length) { /* the fills took the slack */ }
      else if (justify === 'space-between' && line.length > 1) step = Math.max(gap, (room - used + gap * (line.length - 1)) / (line.length - 1))
      else pos += at(justify, room, used)
      for (const k of line) {
        if (align === 'stretch' || k.sizing?.[C] === 'fill') set(k, C, thick)
        set(k, P, pos)
        set(k, Q, q + at(align, thick, k[C]))
        pos += k[M] + step
      }
      q += thick + gap
    }
    return
  }
  const fills = kids.filter((k) => k.sizing?.[M] === 'fill')
  const fixed = kids.filter((k) => k.sizing?.[M] !== 'fill').reduce((a, k) => a + k[M], 0)
  const free = room - fixed - gap * (kids.length - 1)
  if (fills.length) for (const k of fills) set(k, M, free / fills.length)
  const used = kids.reduce((a, k) => a + k[M], 0) + gap * (kids.length - 1)
  let step = gap
  let pos = (row ? x0 : y0)
  if (!fills.length) {
    if (justify === 'space-between' && kids.length > 1) step = Math.max(gap, (room - used + gap * (kids.length - 1)) / (kids.length - 1))
    else pos += at(justify, room, used)
  }
  for (const k of kids) {
    if (align === 'stretch' || k.sizing?.[C] === 'fill') set(k, C, cross)
    set(k, P, pos)
    set(k, Q, (row ? y0 : x0) + at(align, cross, k[C]))
    pos += k[M] + step
  }
}

/** The largest box a NEW child can take in frame `f` without passing its
 *  edges: the inner box (size less padding), and for a fixed-size row or
 *  column what is left along the main axis after the children it has (fill
 *  children at their least size) and one more gap; a fixed grid's cell width.
 *  A frame that hugs grows to fit, so it sets no limit. */
export function roomIn(slide: Slide, f: Frame): { w: number; h: number } {
  if (f.layout.hug) return { w: Infinity, h: Infinity }
  const { dir, gap, pad } = f.layout
  const iw = Math.max(1, f.w - pad[1] - pad[3]), ih = Math.max(1, f.h - pad[0] - pad[2])
  const kids = frameChildren(slide, f)
  if (dir === 'grid') { const c = colsOf(f); return { w: Math.max(1, (iw - gap * (c - 1)) / c), h: ih } }
  if (f.layout.wrap || !kids.length) return { w: iw, h: ih }
  const M = dir === 'row' ? 'w' : 'h'
  const used = kids.reduce((a, k) => a + (k.sizing?.[M] === 'fill' ? minOf(k, M) : k[M]), 0) + gap * kids.length
  const free = Math.max(1, (M === 'w' ? iw : ih) - used)
  return M === 'w' ? { w: free, h: ih } : { w: iw, h: free }
}

/** A fill child's least size on axis M (sizing.minW/minH, else 0). */
const minOf = (k: SlideElement, M: 'w' | 'h') => (M === 'w' ? k.sizing?.minW : k.sizing?.minH) ?? 0

/** Greedy line breaking for a wrapping run: a child starts a new line when it would pass `room`.
 *  A fill child counts as its minimum, so its own filled size never decides its line. */
function lines(kids: SlideElement[], M: 'w' | 'h', room: number, gap: number): SlideElement[][] {
  const out: SlideElement[][] = []
  let cur: SlideElement[] = [], used = 0
  for (const k of kids) {
    const size = k.sizing?.[M] === 'fill' ? minOf(k, M) : k[M]
    if (cur.length && used + gap + size > room + 0.01) { out.push(cur); cur = [], used = 0 }
    used += (cur.length ? gap : 0) + size
    cur.push(k)
  }
  if (cur.length) out.push(cur)
  return out
}

/** Clip a frame child to its frame, as an inset in the child's own box. '' when not clipped. */
export function frameClip(el: SlideElement, byId: Map<string, SlideElement>): string {
  const f = el.parentId ? byId.get(el.parentId) : undefined
  if (!isFrame(f) || !f.layout.clip) return ''
  if (el.rotation) {
    // clip-path is in the element's untransformed box; the element turns about its centre
    const a = (-el.rotation * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a)
    const cx = el.x + el.w / 2, cy = el.y + el.h / 2
    const pt = (x: number, y: number) => {
      const dx = x - cx, dy = y - cy
      return `${r2(dx * cos - dy * sin + el.w / 2)}px ${r2(dx * sin + dy * cos + el.h / 2)}px`
    }
    return `polygon(${pt(f.x, f.y)}, ${pt(f.x + f.w, f.y)}, ${pt(f.x + f.w, f.y + f.h)}, ${pt(f.x, f.y + f.h)})`
  }
  const top = Math.max(0, f.y - el.y), left = Math.max(0, f.x - el.x)
  const bottom = Math.max(0, el.y + el.h - (f.y + f.h)), right = Math.max(0, el.x + el.w - (f.x + f.w))
  if (!top && !left && !bottom && !right) return ''
  return `inset(${r2(top)}px ${r2(right)}px ${r2(bottom)}px ${r2(left)}px)`
}

/**
 * A frame child's clip mid-morph: the frame's box `f` (slide px, as it stands
 * at that moment) mapped into the child node's own untransformed box. The node
 * is drawn as the morph draws it (present.ts runMorph, editor/morph.ts): put
 * at (x, y), scaled (sx, sy), and turned r° about the centre of its resting
 * box (bw × bh) — rotate first, then scale. So a slide point F lies at
 * c + R⁻¹((F − (x, y)) ⁄ s − c) in the node's box. At rest (s = 1) this is
 * frameClip's polygon.
 */
export function morphClip(f: { x: number; y: number; w: number; h: number }, x: number, y: number, sx: number, sy: number, r: number, bw: number, bh: number): string {
  const a = (-r * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a)
  const cx = bw / 2, cy = bh / 2
  const pt = (X: number, Y: number) => {
    const vx = (X - x) / (sx || 1) - cx, vy = (Y - y) / (sy || 1) - cy
    return `${r2(vx * cos - vy * sin + cx)}px ${r2(vx * sin + vy * cos + cy)}px`
  }
  return `polygon(${pt(f.x, f.y)}, ${pt(f.x + f.w, f.y)}, ${pt(f.x + f.w, f.y + f.h)}, ${pt(f.x, f.y + f.h)})`
}

/**
 * Lay a frame's children out in their ARRAY order. The solver reads order from
 * position (ties by array order), so the children are stacked at the frame's
 * origin and laid out again: the order becomes exactly the array's. This is
 * how an explicit reorder — a drop slot, an arrow key, a Layers drag — tells
 * the solver what it means without a format field for order.
 */
export function reflowByArray(slide: Slide, frameId: string): void {
  const f = slide.elements.find((e) => e.id === frameId)
  if (!f) return
  for (const e of slide.elements) if (e.parentId === frameId) { e.x = f.x; e.y = f.y }
  layoutSlide(slide)
}

/** Move a frame's child to slot `to` of its siblings (layout order). Reports
 *  whether the order changed. Paint order among the siblings follows the
 *  flow order, each child moving with everything inside it (layBlock): a
 *  card that only swapped its own slot would paint over its own texts. */
export function moveInFrame(slide: Slide, id: string, to: number): boolean {
  const child = slide.elements.find((e) => e.id === id)
  const f = child?.parentId ? slide.elements.find((e) => e.id === child.parentId) : undefined
  if (!child || !isFrame(f)) return false
  const order = frameChildren(slide, f)
  const from = order.indexOf(child)
  const at = Math.max(0, Math.min(order.length - 1, to))
  if (from < 0 || from === at) return false
  order.splice(from, 1)
  order.splice(at, 0, child)
  layBlock(slide, f, order)
  reflowByArray(slide, f.id)
  return true
}
