// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Position, size, alignment and stacking order of the selection.
import { blendPairs } from './shape'
import { tokenBind } from './tokenbind'
import type { PropsPanel } from '../panels'
import { BOOL_OPS, boolOperands, boolUi, combine } from '../booleans'
import { ratioLocked, type ImageElement, type SlideElement, type ShapeElement } from '../../model'
import { section, row, labeledSelect, mini, withIcon } from './fields'
import { t } from '../../i18n'
import { optLabel, relOf } from './controls'
import { applyRel } from './numexpr'
import { isMacOS } from '../../screens'
import { ICONS } from '../../icons'
import { childResizing } from './layout'
import { openCtxMenu } from '../ctxmenu'

export function buildLayoutRole(p: PropsPanel, el: SlideElement) {
  // What the box IS to the slide's layout — its own section, said in
  // words: a bare 'Layout role' dropdown among the text settings told
  // nobody what it did.
  // named for what it holds: beside 'Auto layout' a second 'Layout' read as the same thing
  section(p, t('Placeholder role'))
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
  const bar = (label: string, ...buttons: HTMLElement[]) => {
    const row = document.createElement('div')
    row.className = 'ed-toolbar'
    row.setAttribute('role', 'toolbar')
    row.setAttribute('aria-label', label)
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
  // One toolbar, as Figma and Penpot head their design panels: align, then
  // spacing and size, flip, stacking order (one menu: four buttons cost a
  // line), group and boolean, each kind set off by a hairline. A kind never
  // splits; the bar wraps at a kind's edge only when the panel is too narrow,
  // so no tool is ever covered or pushed out of it (styles.css).
  const kind = (...buttons: HTMLElement[]) => {
    const k = document.createElement('div')
    k.className = 'ed-toolbar-kind'
    k.style.setProperty('--n', String(buttons.length))
    k.append(...buttons)
    return k
  }
  // A frame's child is placed by its frame: aligning it would write X/Y the
  // layout overwrites at once, so the frame's own alignment is offered instead.
  const tools: HTMLElement[] = []
  // one child or several, every one placed by a frame: align and spacing would
  // do nothing (the layout puts them back), so say why and point at the frame
  const inFrame = els.length > 0 && els.every((e) => !!e.parentId && !!p.store.element(e.parentId))
  const tip = (id: string, label: string) => p.titleOf(id, label)
  if (inFrame) {
    const frames = [...new Set(els.map((e) => e.parentId!))]
    const hint = document.createElement('p')
    hint.className = 'ed-hint ed-keep ed-frame-placed'
    hint.textContent = t('Placed by its frame’s auto layout — align and space it on the frame.')
    const go = document.createElement('button')
    go.type = 'button'
    go.className = 'ed-btn ed-link-btn'
    go.textContent = t('Select the frame')
    go.addEventListener('click', () => p.store.select(frames))
    hint.append(' ', go)
    block.appendChild(hint)
  } else {
    tools.push(
      kind(
        iconBtn(ICONS.arrLeft, tip('align-left', t('Align left')), () => align(p, els, 'left')),
        iconBtn(ICONS.arrCenterX, tip('align-center', t('Align centers')), () => align(p, els, 'centerX')),
        iconBtn(ICONS.arrRight, tip('align-right', t('Align right')), () => align(p, els, 'right')),
        iconBtn(ICONS.arrTop, tip('align-top', t('Align top')), () => align(p, els, 'top')),
        iconBtn(ICONS.arrMiddleY, tip('align-middle', t('Align middles')), () => align(p, els, 'middleY')),
        iconBtn(ICONS.arrBottom, tip('align-bottom', t('Align bottom')), () => align(p, els, 'bottom')),
      ),
      ...(els.length >= 2 ? [kind(
        ...(els.length >= 3 ? [
          iconBtn(ICONS.distX, tip('distribute-x', t('Space evenly across (3 or more)')), () => distribute(p, els, 'x')),
          iconBtn(ICONS.distY, tip('distribute-y', t('Space evenly down (3 or more)')), () => distribute(p, els, 'y')),
        ] : []),
        iconBtn(ICONS.matchW, t('Same width as the first selected (2 or more)'), () => matchSize(p, els, 'w')),
        iconBtn(ICONS.matchH, t('Same height as the first selected (2 or more)'), () => matchSize(p, els, 'h')),
      )] : []),
    )
  }
  const order = iconBtn(ICONS.viewLayers, t('Stacking order'), () => {
    const r = order.getBoundingClientRect()
    openCtxMenu(r.left, r.bottom + 4, [
      { label: t('Bring to front'), icon: ICONS.toFront, run: () => p.reorder(els, 'front') },
      { label: t('Bring forward'), icon: ICONS.forward, run: () => step(p, els, +1) },
      { label: t('Send backward'), icon: ICONS.backward, run: () => step(p, els, -1) },
      { label: t('Send to back'), icon: ICONS.toBack, run: () => p.reorder(els, 'back') },
    ])
  })
  order.setAttribute('aria-haspopup', 'menu')
  bar(t('Arrange'),
    ...tools,
    kind(
      iconBtn(ICONS.flipH, tip('flip-h', t('Flip horizontal')), () => flip(p, els, 'flipX')),
      iconBtn(ICONS.flipV, tip('flip-v', t('Flip vertical')), () => flip(p, els, 'flipY')),
    ),
    kind(order),
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
    const blend = labeledSelect(blendPairs(), el.blend || 'normal',
      (v) => p.mutate(el.id, (e) => {
        if (v === 'normal') delete e.blend
        else e.blend = v
      }, true))
    blend.title = t('Blend mode')
    blend.setAttribute('aria-label', t('Blend mode'))
    layer.append(withIcon(blend, ICONS.blendMode))
  }
  const opacity = measure(p, els, 'opacity', '%', { min: 0, max: 100, scale: 100 })
  opacity.title = t('Opacity')
  opacity.querySelector('input')!.setAttribute('aria-label', opacity.title) // not '%'
  layer.append(single ? tokenBind(p, opacity, single, 'opacity', ['opacity', 'number']) : opacity)
  block.appendChild(layer)

  const geo = document.createElement('div')
  geo.className = 'ed-grid2'
  // W and H can follow a size token — not where auto layout derives the size
  // (a frame's child, a hugging frame): layout.ts would overwrite the literal
  // and the binding would read as a hand edit and drop
  const derived = !single || !!single.parentId || (single.type === 'shape' && !!single.layout?.hug)
  const size = (key: 'w' | 'h', label: string) => {
    const f = measure(p, els, key, label, { min: 1 })
    return derived ? f : tokenBind(p, f, single!, key)
  }
  // the padlock rides inside W's field, at its end: the pair keeps the
  // panel's one two-column grid (Figma puts it beside W the same way)
  const w = size('w', t('W'))
  if (single && !derived) { w.classList.add('ed-has-lock'); w.append(ratioLock(p, single)) }
  geo.append(
    w,
    size('h', t('H')),
    readOnlyIf(inFrame, measure(p, els, 'x', t('X'))),
    readOnlyIf(inFrame, measure(p, els, 'y', t('Y'))),
    measure(p, els, 'rotation', t('Angle'), { icon: ICONS.rotate, unit: '°' }),
  )
  let corners: HTMLElement | null = null
  if (single?.type === 'shape' && single.shape === 'rect') {
    const el = single
    // One radius for every corner, or (the corners button) one each. The
    // single field sets them all; `radius` stays the largest corner, which
    // is what a shell without `radii` draws.
    const one = tokenBind(p, mini(t('Corner radius'), el.radius ?? 0, (v, fin) =>
      p.mutate(el.id, (e) => { const s = e as ShapeElement; s.radius = Math.max(v, 0); delete s.radii }, fin), ICONS.radius, { min: 0 }), el, 'radius')
    const split = iconBtn(ICONS.corners, t('Independent corners'), () => p.mutate(el.id, (e) => {
      const s = e as ShapeElement
      if (s.radii) delete s.radii
      else s.radii = [s.radius ?? 0, s.radius ?? 0, s.radius ?? 0, s.radius ?? 0]
    }, true))
    split.setAttribute('aria-pressed', String(!!el.radii))
    split.classList.add('ed-corners-btn')
    one.appendChild(split)
    geo.append(one)
    if (el.radii) {
      corners = document.createElement('div')
      corners.className = 'ed-grid4 ed-corners'
      const names = ['Top left', 'Top right', 'Bottom right', 'Bottom left']
      el.radii.forEach((r, i) => {
        const f = mini(['↖', '↗', '↘', '↙'][i], r, (v, fin) => p.mutate(el.id, (e) => {
          const s = e as ShapeElement
          if (!s.radii) return
          s.radii[i] = Math.max(v, 0)
          s.radius = Math.max(...s.radii)
        }, fin), undefined, { min: 0 })
        f.title = t(names[i])
        f.querySelector('input')!.setAttribute('aria-label', `${t('Corner radius')} · ${t(names[i])}`)
        corners!.appendChild(f)
      })
    }
  }
  block.appendChild(geo)
  if (corners) block.appendChild(corners)
  // A frame's child sizes by its frame: Hug / Fixed / Fill sit right under W
  // and H, which they decide — Figma keeps them there too, not in a section
  // further down.
  if (els.length === 1) childResizing(p, els[0])
}

/**
 * Flip. One element mirrors its content in its own box; all flip together (if
 * any is unflipped they all flip, else they all unflip). Several elements
 * mirror as ONE picture across the selection's box, as Figma does: each centre
 * reflects across the box's middle, each turn reverses, and each element's own
 * content flips. One undo step.
 */
export function flip(p: PropsPanel, els: SlideElement[], key: 'flipX' | 'flipY') {
  if (!els.length) return
  if (els.length === 1) {
    const on = els.some((e) => !e[key])
    p.edit(() => {
      const el = p.store.element(els[0].id)
      if (!el) return
      if (on) el[key] = true
      else delete el[key]
    }, true)
    return
  }
  // the selection's box: the turned corners of every element
  const xs: number[] = [], ys: number[] = []
  for (const e of els) {
    const a = ((e.rotation || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
    const cx = e.x + e.w / 2, cy = e.y + e.h / 2
    for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const x = (dx * e.w) / 2, y = (dy * e.h) / 2
      xs.push(cx + x * c - y * s); ys.push(cy + x * s + y * c)
    }
  }
  const mid = key === 'flipX' ? (Math.min(...xs) + Math.max(...xs)) / 2 : (Math.min(...ys) + Math.max(...ys)) / 2
  p.edit(() => {
    for (const e of els) {
      const el = p.store.element(e.id)
      if (!el) continue
      if (key === 'flipX') el.x = 2 * mid - (el.x + el.w / 2) - el.w / 2
      else el.y = 2 * mid - (el.y + el.h / 2) - el.h / 2
      if (el.rotation) el.rotation = -el.rotation
      if (el[key]) delete el[key]
      else el[key] = true
    }
  }, true)
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
    // Mixed: a relative entry (+12, *2, an arrow step, a scrub) works on each
    // element's own value; a plain value sets them all
    const rel = !mixed ? null : final ? relOf(input) : { op: '+' as const, x: v }
    p.edit(() => els.forEach((e, i) => {
      const el = p.store.element(e.id)
      if (!el) return
      const before = el[key]
      el[key] = hold(rel ? applyRel(rel, vals[i]) : v) / k
      // a locked element's other side follows a typed or scrubbed W/H
      if ((key === 'w' || key === 'h') && ratioLocked(el) && before > 0) {
        const other = key === 'w' ? 'h' : 'w'
        el[other] = Math.max(1, el[other] * el[key] / before)
      }
    }), final)
  }, o.icon, mixed ? { unit: o.unit } : { min: o.min, max: o.max, unit: o.unit })
  const input = wrap.querySelector('input')!
  return wrap
}

/** X and Y of a frame's child: shown, not editable — the frame places it. */
function readOnlyIf(on: boolean, f: HTMLElement): HTMLElement {
  if (!on) return f
  const input = f.querySelector('input')!
  input.readOnly = true
  input.setAttribute('aria-readonly', 'true')
  f.classList.add('ed-readonly')
  f.title = t('Set by the frame’s auto layout')
  return f
}

/** Same width/height for the whole selection — first selected is the reference. */
export function matchSize(p: PropsPanel, els: SlideElement[], dim: 'w' | 'h') {
  if (els.length < 2) return
  const ref = els[0][dim]
  p.edit(() => { for (const el of els) el[dim] = ref }, true)
}

/** The box an element covers on the slide — its turned corners' bounds. */
export function turnedBox(e: SlideElement): { x0: number; y0: number; x1: number; y1: number } {
  const a = ((e.rotation || 0) * Math.PI) / 180
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a))
  const hw = (e.w * c + e.h * s) / 2, hh = (e.w * s + e.h * c) / 2
  const cx = e.x + e.w / 2, cy = e.y + e.h / 2
  return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh }
}

/** Single element aligns to the slide; a multi-selection aligns to its own
 *  bounds. What lines up is what you see: a turned element by its turned box. */
export function align(p: PropsPanel, els: SlideElement[], edge: 'left' | 'centerX' | 'right' | 'top' | 'middleY' | 'bottom') {
  const { width, height } = p.store.doc.size
  const boxes = els.map(turnedBox)
  const box = els.length === 1
    ? { x0: 0, y0: 0, x1: width, y1: height }
    : {
        x0: Math.min(...boxes.map((b) => b.x0)),
        y0: Math.min(...boxes.map((b) => b.y0)),
        x1: Math.max(...boxes.map((b) => b.x1)),
        y1: Math.max(...boxes.map((b) => b.y1)),
      }
  p.edit(() => {
    els.forEach((e, i) => {
      const el = p.store.element(e.id)
      if (!el) return
      const b = boxes[i]
      if (edge === 'left') el.x += box.x0 - b.x0
      if (edge === 'right') el.x += box.x1 - b.x1
      if (edge === 'centerX') el.x += (box.x0 + box.x1) / 2 - (b.x0 + b.x1) / 2
      if (edge === 'top') el.y += box.y0 - b.y0
      if (edge === 'bottom') el.y += box.y1 - b.y1
      if (edge === 'middleY') el.y += (box.y0 + box.y1) / 2 - (b.y0 + b.y1) / 2
    })
  }, true)
}

/** Even gaps between elements, first and last stay put. */
export function distribute(p: PropsPanel, els: SlideElement[], axis: 'x' | 'y') {
  if (els.length < 3) return
  // by the turned boxes, as align: the gaps you see are the gaps made equal
  const [lo, hi] = axis === 'x' ? ['x0', 'x1'] as const : ['y0', 'y1'] as const
  const sorted = els.map((e) => ({ e, b: turnedBox(e) })).sort((a, b) => a.b[lo] - b.b[lo])
  const span = sorted[sorted.length - 1].b[hi] - sorted[0].b[lo]
  const total = sorted.reduce((s, { b }) => s + b[hi] - b[lo], 0)
  const gap = (span - total) / (sorted.length - 1)
  p.edit(() => {
    let cursor = sorted[0].b[hi] + gap
    for (const { e, b } of sorted.slice(1, -1)) {
      const el = p.store.element(e.id)
      if (el) el[axis] += cursor - b[lo]
      cursor += b[hi] - b[lo] + gap
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

/** The padlock between W and H: resizes keep the element's proportions. */
function ratioLock(p: PropsPanel, el: SlideElement): HTMLElement {
  const on = ratioLocked(el)
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'ed-btn ed-tool ed-ratio-lock'
  b.innerHTML = on ? ICONS.lock : ICONS.unlock
  b.setAttribute('aria-pressed', String(on))
  b.title = on ? t('Proportions locked — click to unlock') : t('Lock proportions')
  b.setAttribute('aria-label', t('Lock proportions'))
  b.addEventListener('click', () => p.mutate(el.id, (e) => {
    // an image is locked when the key is absent; anything else when it is true
    if (e.type === 'image') { if (on) { e.keepAspectRatio = false; (e as ImageElement).fit = 'fill' } else delete e.keepAspectRatio }
    else if (on) delete e.keepAspectRatio
    else e.keepAspectRatio = true
  }, true))
  return b
}
