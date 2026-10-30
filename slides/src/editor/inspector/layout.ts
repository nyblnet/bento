// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Auto layout: a frame's direction, gap, padding, alignment, clip and hug; a child's sizing. The solver is layout.ts.
import { section, row, segmented, mini, field, toggle } from './fields'
import { t } from '../../i18n'
import type { PropsPanel } from '../panels'
import { uid, type FrameLayout, type ShapeElement, type SlideElement } from '../../model'
import { isFrame } from '../../layout'
import { tokenBind } from './tokenbind'

const DIRS: Record<string, string> = { row: 'Row', col: 'Column', grid: 'Grid' }

/** The Auto layout section: on a rect, the frame's own rules; on a frame's child, its sizing. */
export function buildAutoLayout(p: PropsPanel, el: SlideElement) {
  const parent = el.parentId ? p.store.element(el.parentId) : undefined
  if (isFrame(parent)) {
    section(p, t('Auto layout'))
    const axis = (k: 'w' | 'h') => segmented(['fixed', 'fill'], el.sizing?.[k] ?? 'fixed', (v) =>
      p.mutate(el.id, (e) => {
        const s = { ...e.sizing, [k]: v as 'fixed' | 'fill' }
        if (s[k] === 'fixed') delete s[k]
        if (Object.keys(s).length) e.sizing = s; else delete e.sizing
      }, true), { fixed: t('Fixed'), fill: t('Fill') })
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
    return
  }
  if (el.type !== 'shape' || el.shape !== 'rect') return
  const L = el.layout
  const set = (fn: (l: FrameLayout) => void, final = true) => p.mutate(el.id, (e) => fn((e as ShapeElement).layout!), final)
  section(p, t('Auto layout'), L
    ? { add: false, hint: t('Remove auto layout'), run: () => p.mutate(el.id, (e) => { delete (e as ShapeElement).layout }, true) }
    : { add: true, hint: t('Add auto layout'), run: () => p.mutate(el.id, (e) => { (e as ShapeElement).layout = { dir: 'row', gap: 16, pad: [16, 16, 16, 16], hug: true } }, true) })
  if (!L) return
  row(p, 'Direction', segmented(['row', 'col', 'grid'], L.dir, (v) => set((l) => { l.dir = v as FrameLayout['dir'] }),
    Object.fromEntries(Object.entries(DIRS).map(([k, v]) => [k, t(v)]))))
  // gap, columns and each padding side can follow a number token
  const gap = tokenBind(p, mini(t('Gap'), L.gap, (v, fin) => set((l) => { l.gap = v }, fin), undefined, { min: 0 }), el, 'layout.gap')
  const parts = L.dir === 'grid'
    ? [gap, tokenBind(p, mini(t('Columns'), L.cols ?? 2, (v, fin) => set((l) => { l.cols = Math.max(1, Math.round(v)) }, fin), undefined, { min: 1, max: 64 }), el, 'layout.cols')]
    : [gap]
  field(p, ...parts)
  // padding, top right bottom left: the arrow is the label, the side is the name
  const sides = [['↑', 'Top padding'], ['→', 'Right padding'], ['↓', 'Bottom padding'], ['←', 'Left padding']] as const
  field(p, ...sides.map(([glyph, name], i) => {
    const m = mini(glyph, L.pad[i], (v, fin) => set((l) => { l.pad[i] = v }, fin), undefined, { min: 0 })
    m.querySelector('input')!.setAttribute('aria-label', t(name))
    return tokenBind(p, m, el, `layout.pad.${i}`)
  }))
  row(p, 'Alignment', alignMatrix(L, (justify, align) => set((l) => { l.justify = justify; l.align = align })))
  row(p, 'Space between', toggle(L.justify === 'space-between', (on) => set((l) => { l.justify = on ? 'space-between' : 'start' })))
  row(p, 'Stretch children', toggle(L.align === 'stretch', (on) => set((l) => { l.align = on ? 'stretch' : 'start' })))
  if (L.dir !== 'grid') row(p, 'Wrap', toggle(!!L.wrap, (on) => set((l) => { if (on) l.wrap = true; else delete l.wrap })))
  row(p, 'Hug contents', toggle(!!L.hug, (on) => set((l) => { if (on) l.hug = true; else delete l.hug })))
  row(p, 'Clip content', toggle(!!L.clip, (on) => set((l) => { if (on) l.clip = true; else delete l.clip })))
}

/** Penpot's 3×3 alignment box: the cell is where the children sit. Columns are
 *  horizontal, rows vertical, whatever the direction: the solver's main/cross
 *  axes are mapped here, so a column frame's matrix still reads left→right. */
function alignMatrix(L: FrameLayout, pick: (justify: FrameLayout['justify'], align: FrameLayout['align']) => void): HTMLElement {
  const box = document.createElement('div')
  box.className = 'ed-align-matrix'
  box.setAttribute('role', 'group')
  const ends = ['start', 'center', 'end'] as const
  const names = [['Top left', 'Top', 'Top right'], ['Left', 'Center', 'Right'], ['Bottom left', 'Bottom', 'Bottom right']]
  const main = L.dir === 'col' ? 'v' : 'h'
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const b = document.createElement('button')
    b.type = 'button'
    const [justify, align] = main === 'h' ? [ends[c], ends[r]] : [ends[r], ends[c]]
    const on = (L.justify ?? 'start') === justify && (L.align ?? 'start') === align
    b.setAttribute('aria-pressed', String(on))
    b.title = t(names[r][c])
    b.setAttribute('aria-label', b.title)
    b.addEventListener('click', () => pick(justify, align))
    box.appendChild(b)
  }
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
  const els = picked.filter((e) => !inside(e))
  if (!els.length) return
  const x = Math.min(...els.map((e) => e.x)), y = Math.min(...els.map((e) => e.y))
  const r = Math.max(...els.map((e) => e.x + e.w)), b = Math.max(...els.map((e) => e.y + e.h))
  const spreadX = Math.max(...els.map((e) => e.x)) - x, spreadY = Math.max(...els.map((e) => e.y)) - y
  const dir = spreadY > spreadX ? 'col' : 'row'
  // the spacing they already have becomes the gap (the median, so one stray
  // element does not set it); one element keeps the default
  const run = [...els].sort((m, n) => (dir === 'row' ? m.x - n.x : m.y - n.y))
  const gaps = run.slice(1).map((e, i) => (dir === 'row' ? e.x - (run[i].x + run[i].w) : e.y - (run[i].y + run[i].h))).sort((m, n) => m - n)
  const gap = gaps.length ? Math.max(0, Math.round(gaps[Math.floor((gaps.length - 1) / 2)])) : 16
  const pad = 16
  const parent = els.every((e) => e.parentId === els[0].parentId) ? els[0].parentId : undefined
  const frame: ShapeElement = {
    id: `frame-${uid()}`, type: 'shape', shape: 'rect', name: t('Frame'),
    x: x - pad, y: y - pad, w: r - x + 2 * pad, h: b - y + 2 * pad, rotation: 0, opacity: 1,
    fill: 'transparent', stroke: 'transparent', strokeWidth: 0, radius: 0,
    layout: { dir, gap, pad: [pad, pad, pad, pad], hug: true },
    ...(parent ? { parentId: parent } : {}),
  }
  const ids = new Set(els.map((e) => e.id))
  p.store.commit(() => {
    const all = p.store.slide.elements
    const at = all.findIndex((e) => ids.has(e.id))
    for (const e of all) if (ids.has(e.id)) e.parentId = frame.id
    all.splice(at, 0, frame)
  })
  p.store.select([frame.id])
}
