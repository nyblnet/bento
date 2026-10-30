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

type Frame = ShapeElement & { layout: NonNullable<ShapeElement['layout']> }

export const isFrame = (el: SlideElement | undefined): el is Frame =>
  !!el && el.type === 'shape' && el.shape === 'rect' && !!(el as ShapeElement).layout

/** Children of a frame, in layout order. */
export function frameChildren(slide: Slide, frame: Frame): SlideElement[] {
  const kids = slide.elements.filter((e) => e.parentId === frame.id)
  const L = frame.layout
  if (L.dir === 'grid') {
    // row band first, then x: a child dropped into another cell moves there
    const band = Math.max(1, ...kids.map((k) => k.h)) + L.gap
    const key = (k: SlideElement) => Math.round((k.y - frame.y - L.pad[0]) / band) * 1e7 + k.x
    return stableSort(kids, key)
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
  const frames = slide.elements.filter(isFrame)
  if (!frames.length) return changed
  const depth = (el: SlideElement, seen = new Set<string>()): number => {
    const p = el.parentId ? byId.get(el.parentId) : undefined
    if (!isFrame(p) || seen.has(el.id)) return 0 // a cycle or dangling parent counts as top level
    seen.add(el.id)
    return 1 + depth(p, seen)
  }
  const order = frames.map((f) => ({ f, d: depth(f) }))
  const set = (el: SlideElement, k: 'x' | 'y' | 'w' | 'h', v: number) => {
    v = r2(Math.max(k === 'w' || k === 'h' ? 1 : -1e6, v))
    if (el[k] !== v) { el[k] = v; changed = true }
  }
  for (const { f } of [...order].sort((a, b) => b.d - a.d)) if (f.layout.hug) hug(slide, f, set)
  for (const { f } of [...order].sort((a, b) => a.d - b.d)) place(slide, f, set)
  return changed
}

type Put = (el: SlideElement, k: 'x' | 'y' | 'w' | 'h', v: number) => void

function hug(slide: Slide, f: Frame, set: Put) {
  const kids = frameChildren(slide, f)
  if (!kids.length) return
  const { dir, gap, pad } = f.layout
  const sum = (ks: SlideElement[], k: 'w' | 'h') => ks.reduce((a, e) => a + e[k], 0)
  const max = (ks: SlideElement[], k: 'w' | 'h') => Math.max(...ks.map((e) => e[k]))
  if (dir === 'grid') {
    const cols = Math.min(f.layout.cols ?? 2, kids.length)
    const rows = Math.ceil(kids.length / cols)
    set(f, 'w', pad[1] + pad[3] + cols * max(kids, 'w') + gap * (cols - 1))
    set(f, 'h', pad[0] + pad[2] + rows * max(kids, 'h') + gap * (rows - 1))
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

function place(slide: Slide, f: Frame, set: Put) {
  const kids = frameChildren(slide, f)
  if (!kids.length) return
  const { dir, gap, pad, justify = 'start', align = 'start' } = f.layout
  const x0 = f.x + pad[3], y0 = f.y + pad[0]
  const iw = Math.max(0, f.w - pad[1] - pad[3]), ih = Math.max(0, f.h - pad[0] - pad[2])
  const at = (a: string, room: number, size: number) => (a === 'center' ? (room - size) / 2 : a === 'end' ? room - size : 0)

  if (dir === 'grid') {
    const cols = f.layout.cols ?? 2
    const rows = Math.ceil(kids.length / cols)
    const cw = f.layout.hug ? Math.max(...kids.map((k) => k.w)) : (iw - gap * (cols - 1)) / cols
    const ch = f.layout.hug ? Math.max(...kids.map((k) => k.h)) : (ih - gap * (rows - 1)) / rows
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
    // ponytail: in a wrapping run, fill children keep their size (Figma wraps fixed items only)
    let q = row ? y0 : x0
    for (const line of lines(kids, M, room, gap)) {
      const thick = Math.max(...line.map((k) => k[C]))
      const used = line.reduce((a, k) => a + k[M], 0) + gap * (line.length - 1)
      let step = gap
      let pos = (row ? x0 : y0)
      if (justify === 'space-between' && line.length > 1) step = (room - used + gap * (line.length - 1)) / (line.length - 1)
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
    if (justify === 'space-between' && kids.length > 1) step = (room - used + gap * (kids.length - 1)) / (kids.length - 1)
    else pos += at(justify, room, used)
  }
  for (const k of kids) {
    if (align === 'stretch' || k.sizing?.[C] === 'fill') set(k, C, cross)
    set(k, P, pos)
    set(k, Q, (row ? y0 : x0) + at(align, cross, k[C]))
    pos += k[M] + step
  }
}

/** Greedy line breaking for a wrapping run: a child starts a new line when it would pass `room`. */
function lines(kids: SlideElement[], M: 'w' | 'h', room: number, gap: number): SlideElement[][] {
  const out: SlideElement[][] = []
  let cur: SlideElement[] = [], used = 0
  for (const k of kids) {
    if (cur.length && used + gap + k[M] > room + 0.01) { out.push(cur); cur = [], used = 0 }
    used += (cur.length ? gap : 0) + k[M]
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
