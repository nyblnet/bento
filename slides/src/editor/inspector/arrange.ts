// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Position, size, alignment and stacking order of the selection.
import { tokenBind } from './tokenbind'
import type { PropsPanel } from '../panels'
import { BOOL_OPS, boolOperands, boolUi, combine } from '../booleans'
import type { SlideElement, ShapeElement } from '../../model'
import { section, row, labeledSelect, mini } from './fields'
import { t } from '../../i18n'
import { optLabel } from './controls'
import { isMacOS } from '../../screens'
import { ICONS } from '../../icons'

export function buildLayoutRole(p: PropsPanel, el: SlideElement) {
  // What the box IS to the slide's layout — its own section, said in
  // words: a bare 'Layout role' dropdown among the text settings told
  // nobody what it did.
  section(p, t('Layout'))
  const why = document.createElement('p')
  why.className = 'ed-hint ed-keep' // the section's whole point: shown, not folded behind '?'
  why.textContent = t('Which box of the slide’s layout this is. When you switch the slide to another layout, the content moves into the new layout’s box with the same role — as a placeholder does in PowerPoint.')
  p.host.appendChild(why)
  row(p, 'Layout role', labeledSelect(
    (['none', 'title', 'subtitle', 'body', 'kicker'] as const).map((r): [string, string] => [r, optLabel(r)]),
    el.role ?? 'none',
    (v) => p.mutate(el.id, (e) => {
      if (v === 'none') delete e.role
      else e.role = v
    }, true)))
}

/** The block above the sections, as Penpot heads its Design tab: the align
 *  and order toolbars, blend mode with opacity, then the measures — the
 *  labels inside the fields. */
export function layerBlock(p: PropsPanel, els: SlideElement[]) {
  const block = document.createElement('div')
  block.className = 'ed-layer-block'
  block.dataset.tab = 'format'
  p.host.appendChild(block)
  const iconBtn = (icon: string, hint: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-btn ed-tool'
    b.innerHTML = icon
    b.title = hint
    b.setAttribute('aria-label', hint.replace(/\s*\(.*\)$/, ''))
    b.addEventListener('click', onClick)
    return b
  }
  const bar = (...buttons: HTMLElement[]) => {
    const row = document.createElement('div')
    row.className = 'ed-toolbar'
    row.append(...buttons)
    block.appendChild(row)
    return row
  }
  // Controls the selection cannot use are left out, not greyed: matching
  // sizes needs two elements, even gaps three.
  const mod = isMacOS() ? '⌘' : 'Ctrl+'
  const grouped = els.some((e) => e.groupId)
  const allSame = els.length > 1 && els.every((e) => e.groupId && e.groupId === els[0].groupId)
  const groupBtn = els.length > 1 || grouped
    ? (allSame || (grouped && els.length === 1)
      ? iconBtn(ICONS.ungroup, `${t('Ungroup')} (⇧${mod}G)`, () => p.ungroup(els))
      : iconBtn(ICONS.group, `${t('Group')} (${mod}G)`, () => p.group(els)))
    : null
  // One toolbar, Penpot's: align | order | spacing | group, a hairline
  // between the kinds; it wraps at a kind's edge when the panel is narrow.
  const kind = (...buttons: HTMLElement[]) => {
    const k = document.createElement('div')
    k.className = 'ed-toolbar-kind'
    k.style.setProperty('--n', String(buttons.length))
    k.append(...buttons)
    return k
  }
  bar(
    kind(
      iconBtn(ICONS.arrLeft, t('Align left'), () => align(p, els, 'left')),
      iconBtn(ICONS.arrCenterX, t('Align centers'), () => align(p, els, 'centerX')),
      iconBtn(ICONS.arrRight, t('Align right'), () => align(p, els, 'right')),
      iconBtn(ICONS.arrTop, t('Align top'), () => align(p, els, 'top')),
      iconBtn(ICONS.arrMiddleY, t('Align middles'), () => align(p, els, 'middleY')),
      iconBtn(ICONS.arrBottom, t('Align bottom'), () => align(p, els, 'bottom')),
    ),
    kind(
      iconBtn(ICONS.toFront, t('Bring to front'), () => p.reorder(els, 'front')),
      iconBtn(ICONS.forward, t('Bring forward'), () => step(p, els, +1)),
      iconBtn(ICONS.backward, t('Send backward'), () => step(p, els, -1)),
      iconBtn(ICONS.toBack, t('Send to back'), () => p.reorder(els, 'back')),
    ),
    ...(els.length >= 2 ? [kind(
      ...(els.length >= 3 ? [
        iconBtn(ICONS.distX, t('Space evenly across (3 or more)'), () => distribute(p, els, 'x')),
        iconBtn(ICONS.distY, t('Space evenly down (3 or more)'), () => distribute(p, els, 'y')),
      ] : []),
      iconBtn(ICONS.matchW, t('Same width as the first selected (2 or more)'), () => matchSize(p, els, 'w')),
      iconBtn(ICONS.matchH, t('Same height as the first selected (2 or more)'), () => matchSize(p, els, 'h')),
    )] : []),
    ...(groupBtn ? [kind(groupBtn)] : []),
    ...(boolOperands(p.store, els)
      ? [kind(...BOOL_OPS.map((op) => {
        const ui = boolUi(op)
        return iconBtn(ui.icon, `${ui.label} (${ui.key})`, () => combine(p.store, els, op))
      }))]
      : []),
  )
  const single = els.length === 1 ? els[0] : null

  const layer = document.createElement('div')
  layer.className = 'ed-grid2 ed-grid-wide'
  if (single) {
    const el = single
    const blend = labeledSelect(
      [['normal', t('Normal')], ['multiply', t('Multiply')], ['screen', t('Screen')], ['overlay', t('Overlay')],
        ['darken', t('Darken')], ['lighten', t('Lighten')], ['difference', t('Difference')], ['exclusion', t('Exclusion')]],
      el.blend || 'normal',
      (v) => p.mutate(el.id, (e) => {
        if (v === 'normal') delete e.blend
        else e.blend = v
      }, true))
    blend.title = t('Blend mode')
    blend.setAttribute('aria-label', t('Blend mode'))
    layer.append(blend)
  }
  const opacity = measure(p, els, 'opacity', '%', { min: 0, max: 100, scale: 100 })
  opacity.title = t('Opacity')
  opacity.querySelector('input')!.setAttribute('aria-label', opacity.title) // not '%'
  layer.append(single ? tokenBind(p, opacity, single, 'opacity') : opacity)
  block.appendChild(layer)

  const geo = document.createElement('div')
  geo.className = 'ed-grid2'
  geo.append(
    measure(p, els, 'w', t('W'), { min: 1 }),
    measure(p, els, 'h', t('H'), { min: 1 }),
    measure(p, els, 'x', t('X')),
    measure(p, els, 'y', t('Y')),
    measure(p, els, 'rotation', t('Angle'), { icon: ICONS.rotate, unit: '°' }),
  )
  if (single?.type === 'shape' && single.shape === 'rect') {
    const el = single
    geo.append(tokenBind(p, mini(t('Corner radius'), el.radius ?? 0, (v, fin) =>
      p.mutate(el.id, (e) => { (e as ShapeElement).radius = Math.max(v, 0) }, fin), ICONS.radius, { min: 0 }), el, 'radius'))
  }
  block.appendChild(geo)
}

type Measure = 'x' | 'y' | 'w' | 'h' | 'rotation' | 'opacity'

/**
 * One measure of the selection, for one element or many. When the elements
 * agree it is an ordinary field; when they differ it shows Mixed, and an edit
 * is RELATIVE: a scrub (which starts from 0) or a typed `+12` moves every
 * element by that much from its own value, while a plain typed value sets
 * them all. Limits hold per element, not on the field — a Mixed W scrubbed
 * left shrinks each box down to its own 1px. One undo step per edit.
 */
function measure(p: PropsPanel, els: SlideElement[], key: Measure, label: string,
  o: { min?: number; max?: number; scale?: number; icon?: string; unit?: string } = {}): HTMLElement {
  const k = o.scale ?? 1
  const vals = els.map((e) => e[key] * k)
  const mixed = vals.some((v) => Math.abs(v - vals[0]) > 1e-9)
  const hold = (v: number) => Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, v))
  const wrap = mini(label, mixed ? NaN : vals[0], (v, final) => {
    const rel = input.dataset.rel
    const delta = mixed ? (final ? (rel === undefined ? null : parseFloat(rel)) : v) : null
    p.edit(() => els.forEach((e, i) => {
      const el = p.store.element(e.id)
      if (el) el[key] = hold(delta === null ? v : vals[i] + delta) / k
    }), final)
  }, o.icon, mixed ? { unit: o.unit } : { min: o.min, max: o.max, unit: o.unit })
  const input = wrap.querySelector('input')!
  return wrap
}

/** Same width/height for the whole selection — first selected is the reference. */
export function matchSize(p: PropsPanel, els: SlideElement[], dim: 'w' | 'h') {
  if (els.length < 2) return
  const ref = els[0][dim]
  p.edit(() => { for (const el of els) el[dim] = ref }, true)
}

/** Single element aligns to the slide; a multi-selection aligns to its own bounds. */
export function align(p: PropsPanel, els: SlideElement[], edge: 'left' | 'centerX' | 'right' | 'top' | 'middleY' | 'bottom') {
  const { width, height } = p.store.doc.size
  const box = els.length === 1
    ? { x0: 0, y0: 0, x1: width, y1: height }
    : {
        x0: Math.min(...els.map((e) => e.x)),
        y0: Math.min(...els.map((e) => e.y)),
        x1: Math.max(...els.map((e) => e.x + e.w)),
        y1: Math.max(...els.map((e) => e.y + e.h)),
      }
  p.edit(() => {
    for (const el of els) {
      if (edge === 'left') el.x = box.x0
      if (edge === 'right') el.x = box.x1 - el.w
      if (edge === 'centerX') el.x = (box.x0 + box.x1) / 2 - el.w / 2
      if (edge === 'top') el.y = box.y0
      if (edge === 'bottom') el.y = box.y1 - el.h
      if (edge === 'middleY') el.y = (box.y0 + box.y1) / 2 - el.h / 2
    }
  }, true)
}

/** Even gaps between elements, first and last stay put. */
export function distribute(p: PropsPanel, els: SlideElement[], axis: 'x' | 'y') {
  if (els.length < 3) return
  const size = axis === 'x' ? 'w' : 'h'
  const sorted = [...els].sort((a, b) => a[axis] - b[axis])
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const span = last[axis] + last[size] - first[axis]
  const total = sorted.reduce((s, e) => s + e[size], 0)
  const gap = (span - total) / (sorted.length - 1)
  p.edit(() => {
    let cursor = first[axis] + first[size] + gap
    for (const el of sorted.slice(1, -1)) {
      el[axis] = cursor
      cursor += el[size] + gap
    }
  }, true)
}

/** Move the selection one step up/down the paint order (adjacent swap). */
export function step(p: PropsPanel, els: SlideElement[], dir: 1 | -1) {
  const ids = new Set(els.map((e) => e.id))
  p.store.commit(() => {
    const arr = p.store.slide.elements
    const idxs = arr.map((e, i) => (ids.has(e.id) ? i : -1)).filter((i) => i >= 0)
    const ordered = dir > 0 ? [...idxs].reverse() : idxs
    for (const i of ordered) {
      const j = i + dir
      if (j < 0 || j >= arr.length || ids.has(arr[j].id)) continue
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
  })
}
