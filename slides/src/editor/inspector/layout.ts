// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Auto layout: a frame's direction, gap, padding, alignment, clip and hug; a child's sizing. The solver is layout.ts.
import { section, row, segmented, mini, field, toggle } from './fields'
import { t } from '../../i18n'
import type { PropsPanel } from '../panels'
import { uid, type FrameLayout, type ShapeElement, type SlideElement } from '../../model'
import { isFrame } from '../../layout'
import { tokenBind } from './tokenbind'
import { ICONS } from '../../icons'
import { roving } from './controls'

const DIRS: Record<string, string> = { row: 'Row', col: 'Column', grid: 'Grid' }

/** The Auto layout section: on a rect, the frame's own rules; on a frame's child, its sizing. */
export function buildAutoLayout(p: PropsPanel, el: SlideElement) {
  if (el.type !== 'shape' || el.shape !== 'rect') return
  const L = el.layout
  const set = (fn: (l: FrameLayout) => void, final = true) => p.mutate(el.id, (e) => fn((e as ShapeElement).layout!), final)
  section(p, t('Auto layout'), L
    ? { add: false, hint: t('Remove auto layout'), run: () => p.mutate(el.id, (e) => { delete (e as ShapeElement).layout }, true) }
    : { add: true, hint: t('Add auto layout'), run: () => p.mutate(el.id, (e) => { (e as ShapeElement).layout = { dir: 'row', gap: 16, pad: [16, 16, 16, 16], hug: true } }, true) })
  if (!L) return
  row(p, 'Direction', segmented(['row', 'col', 'grid'], L.dir, (v) => set((l) => { l.dir = v as FrameLayout['dir'] }),
    Object.fromEntries(Object.entries(DIRS).map(([k, v]) => [k, t(v)])), { row: ICONS.frameRow, col: ICONS.frameCol, grid: ICONS.frameGrid }))
  // gap, columns and each padding side can follow a number token
  const gap = tokenBind(p, mini(t('Gap'), L.gap, (v, fin) => set((l) => { l.gap = v }, fin), ICONS.gap, { min: 0 }), el, 'layout.gap')
  const parts = L.dir === 'grid'
    ? [gap, tokenBind(p, mini(t('Columns'), L.cols ?? 2, (v, fin) => set((l) => { l.cols = Math.max(1, Math.round(v)) }, fin), undefined, { min: 1, max: 64 }), el, 'layout.cols')]
    : [gap]
  field(p, ...parts)
  // padding: the arrow is the label, the side is the name. Two to a row, in the
  // panel's one grid — four in a row left each value ~20px ("16" read "1(").
  // Vertical sides, then horizontal, as Penpot pairs them; pad keeps its
  // top-right-bottom-left order.
  const side = (i: number, glyph: string, name: string) =>
    tokenBind(p, mini(t(name), L.pad[i], (v, fin) => set((l) => { l.pad[i] = v }, fin), glyph, { min: 0 }), el, `layout.pad.${i}`)
  field(p, side(0, ICONS.dirUp, 'Top padding'), side(2, ICONS.dirDown, 'Bottom padding'))
  field(p, side(3, ICONS.dirLeft, 'Left padding'), side(1, ICONS.dirRight, 'Right padding'))
  row(p, 'Alignment', alignMatrix(L, (justify, align) => set((l) => { l.justify = justify; l.align = align })))
  row(p, 'Space between', toggle(L.justify === 'space-between', (on) => set((l) => { l.justify = on ? 'space-between' : 'start' })))
  row(p, 'Stretch children', toggle(L.align === 'stretch', (on) => set((l) => { l.align = on ? 'stretch' : 'start' })))
  if (L.dir !== 'grid') row(p, 'Wrap', toggle(!!L.wrap, (on) => set((l) => { if (on) l.wrap = true; else delete l.wrap })))
  row(p, 'Hug contents', toggle(!!L.hug, (on) => set((l) => { if (on) l.hug = true; else delete l.hug })))
  row(p, 'Clip content', toggle(!!L.clip, (on) => set((l) => { if (on) l.clip = true; else delete l.clip })))
}

/**
 * How a frame's child takes its size, Figma's three words per axis: Hug (a
 * frame child sizes to its own content), Fixed, Fill container. Fill is
 * refused where the parent hugs — a frame sized by its children has no free
 * space to hand out — and says so. A nested frame shows this AND its own
 * Auto layout section below.
 */
/** A frame's child: its sizing rows, laid out in the header-less top block
 *  right under W and H (arrange.ts layerBlock). Nothing for a free element. */
export function childResizing(p: PropsPanel, el: SlideElement) {
  const parent = el.parentId ? p.store.element(el.parentId) : undefined
  if (isFrame(parent)) resizing(p, el, parent)
}

function resizing(p: PropsPanel, el: SlideElement, parent: ShapeElement & { layout: FrameLayout }) {
  const own = isFrame(el)
  const modeOf = (k: 'w' | 'h') => el.sizing?.[k] === 'fill' ? 'fill' : own && el.layout.hug ? 'hug' : 'fixed'
  const axis = (k: 'w' | 'h') => {
    const seg = segmented(own ? ['hug', 'fixed', 'fill'] : ['fixed', 'fill'], modeOf(k), (v) =>
      p.mutate(el.id, (e) => {
        const s = { ...e.sizing }
        if (v === 'fill') s[k] = 'fill'
        else delete s[k]
        if (Object.keys(s).length) e.sizing = s; else delete e.sizing
        // ponytail: hug is one switch for both axes (layout.ts); per-axis hug when a deck needs it
        const L = (e as ShapeElement).layout
        if (L) { if (v === 'hug') L.hug = true; else if (v === 'fixed') delete L.hug }
      }, true), { hug: t('Hug contents'), fixed: t('Fixed'), fill: t('Fill container') },
      { hug: ICONS.sizeHug, fixed: ICONS.sizeFixed, fill: ICONS.sizeFill })
    seg.dataset.axis = k
    if (parent.layout.hug && modeOf(k) !== 'fill') {
      const fill = seg.querySelector<HTMLButtonElement>('[data-value="fill"]')
      if (fill) { fill.disabled = true; fill.title = t('The frame sizes itself to its children, so there is no space to fill — turn off its Hug contents first') }
    }
    return seg
  }
  // in a wrapping frame a fill child needs a least size, or every fill shares one line
  const least = (k: 'w' | 'h') => {
    const key = k === 'w' ? 'minW' : 'minH'
    return mini(t('Min'), el.sizing?.[key] ?? 0, (v, fin) => p.mutate(el.id, (e) => {
      const s = { ...e.sizing }
      if (v > 0) s[key] = v; else delete s[key]
      if (Object.keys(s).length) e.sizing = s; else delete e.sizing
    }, fin), undefined, { min: 0 })
  }
  const wraps = !!parent.layout.wrap && parent.layout.dir !== 'grid'
  for (const [k, label] of [['w', 'Width'], ['h', 'Height']] as const) {
    row(p, label, axis(k))
    if (wraps && el.sizing?.[k] === 'fill') field(p, least(k))
  }
}

/** Penpot's 3×3 alignment box: the cell is where the children sit. Columns are
 *  horizontal, rows vertical, whatever the direction: the solver's main/cross
 *  axes are mapped here, so a column frame's matrix still reads left→right. */
function alignMatrix(L: FrameLayout, pick: (justify: FrameLayout['justify'], align: FrameLayout['align']) => void): HTMLElement {
  const box = document.createElement('div')
  box.className = 'ed-align-matrix'
  // one tab stop: the arrows walk the 3×3 (roving), as a radio group
  box.setAttribute('role', 'radiogroup')
  box.setAttribute('aria-label', t('Alignment'))
  const ends = ['start', 'center', 'end'] as const
  const names = [['Top left', 'Top', 'Top right'], ['Left', 'Center', 'Right'], ['Bottom left', 'Bottom', 'Bottom right']]
  const main = L.dir === 'col' ? 'v' : 'h'
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const b = document.createElement('button')
    b.type = 'button'
    const [justify, align] = main === 'h' ? [ends[c], ends[r]] : [ends[r], ends[c]]
    const on = (L.justify ?? 'start') === justify && (L.align ?? 'start') === align
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-checked', String(on))
    b.title = t(names[r][c])
    b.setAttribute('aria-label', b.title)
    b.addEventListener('click', () => pick(justify, align))
    box.appendChild(b)
  }
  roving(box, 'radio', 3)
  return box
}

/**
 * ⇧A: wrap the selection in a new auto-layout frame, one undo step. The frame
 * goes in behind the lowest selected element, takes their bounds plus the
 * padding, and runs along the axis they are already spread on.
 */
export function wrapInFrame(p: PropsPanel, picked: SlideElement[]) {
  // a picked element inside another picked one rides along with it: wrapping
  // a card and its own text must not pull the text out of the card
  const ids0 = new Set(picked.map((e) => e.id))
  const byId = new Map(p.store.slide.elements.map((e) => [e.id, e]))
  const inside = (e: SlideElement) => { for (let q = e.parentId, n = 0; q && n < 64; q = byId.get(q)?.parentId, n++) if (ids0.has(q)) return true; return false }
  const top = picked.filter((e) => !inside(e))
  if (!top.length) return
  // a card built of loose shapes: a plain rect with picked elements lying on
  // it (inside its box, above it in paint order) is one unit. The rect
  // becomes a hugging column frame holding them — its paint and id stay, the
  // padding and gap are the ones it had — and the units are what get laid out
  const all = p.store.slide.elements
  const idx = new Map(all.map((e, i) => [e.id, i]))
  const within = (e: SlideElement, c: SlideElement) => e.x >= c.x - 1 && e.y >= c.y - 1 && e.x + e.w <= c.x + c.w + 1 && e.y + e.h <= c.y + c.h + 1
  const cards = new Map<SlideElement, SlideElement[]>()
  for (const e of top) {
    // the outermost holder, so a rect on a rect on a rect is one card
    const c = top.filter((c) => c !== e && c.type === 'shape' && c.shape === 'rect' && !c.layout && !c.rotation && idx.get(c.id)! < idx.get(e.id)! && within(e, c))
      .sort((m, n) => n.w * n.h - m.w * m.h)[0]
    if (c) cards.set(c, [...(cards.get(c) ?? []), e])
  }
  const held = new Set([...cards.values()].flat())
  const els = top.filter((e) => !held.has(e))
  const makeCards = () => {
    for (const [c, kids] of cards) {
      const x0 = Math.min(...kids.map((e) => e.x)), y0 = Math.min(...kids.map((e) => e.y))
      const x1 = Math.max(...kids.map((e) => e.x + e.w)), y1 = Math.max(...kids.map((e) => e.y + e.h))
      const side = (v: number) => Math.max(0, Math.round(v))
      ;(c as ShapeElement).layout = { dir: 'col', gap: spacing(kids, 'col'), pad: [side(y0 - c.y), side(c.x + c.w - x1), side(c.y + c.h - y1), side(x0 - c.x)], hug: true }
      for (const k of kids) k.parentId = c.id
    }
  }
  if (cards.size && els.length === 1) {
    // one card and nothing else: the card is the frame
    p.store.commit(makeCards)
    p.store.select([els[0].id])
    return
  }
  const x = Math.min(...els.map((e) => e.x)), y = Math.min(...els.map((e) => e.y))
  const r = Math.max(...els.map((e) => e.x + e.w)), b = Math.max(...els.map((e) => e.y + e.h))
  const spreadX = Math.max(...els.map((e) => e.x)) - x, spreadY = Math.max(...els.map((e) => e.y)) - y
  const dir = spreadY > spreadX ? 'col' : 'row'
  const gap = spacing(els, dir)
  const pad = 16
  const parent = els.every((e) => e.parentId === els[0].parentId) ? els[0].parentId : undefined
  const frame: ShapeElement = {
    id: `frame-${uid()}`, type: 'shape', shape: 'rect',
    x: x - pad, y: y - pad, w: r - x + 2 * pad, h: b - y + 2 * pad, rotation: 0, opacity: 1,
    fill: 'transparent', stroke: 'transparent', strokeWidth: 0, radius: 0,
    layout: { dir, gap, pad: [pad, pad, pad, pad], hug: true },
    ...(parent ? { parentId: parent } : {}),
  }
  const ids = new Set(els.map((e) => e.id))
  p.store.commit(() => {
    makeCards()
    const all = p.store.slide.elements
    const at = all.findIndex((e) => ids.has(e.id))
    for (const e of all) if (ids.has(e.id)) e.parentId = frame.id
    all.splice(at, 0, frame)
  })
  p.store.select([frame.id])
}

/** The spacing elements already have along `dir`, as a frame's gap: the
 *  median, so one stray element does not set it. Overlapping copies (⌘D
 *  offsets 24px) have no real spacing to keep: 16, as with one element. */
function spacing(els: SlideElement[], dir: 'row' | 'col'): number {
  const run = [...els].sort((m, n) => (dir === 'row' ? m.x - n.x : m.y - n.y))
  const gaps = run.slice(1).map((e, i) => (dir === 'row' ? e.x - (run[i].x + run[i].w) : e.y - (run[i].y + run[i].h))).sort((m, n) => m - n)
  const median = gaps.length ? Math.round(gaps[Math.floor((gaps.length - 1) / 2)]) : 0
  return median > 0 ? median : 16
}
