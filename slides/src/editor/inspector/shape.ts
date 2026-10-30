// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Shapes: fill and stroke.
import { tokenBind } from './tokenbind'
import type { PropsPanel } from '../panels'
import type { ShapeElement, LineEnding, PaintLayer, StrokeLayer } from '../../model'
import { TIPS } from '../../tips'
import { optLabel, parseColor } from './controls'
import { row, labeledSelect, toggle, section, field, mini, opBtn } from './fields'
import { ICONS } from '../../icons'
import { fillLayers, setFillLayers, setStrokeLayers, strokeLayers } from '../../stacks'
import { t } from '../../i18n'
import { fillKind, colorAlpha, gradientRows, gradientChip, gradientFor, paintHost, type PaintKind } from './color'
import { segmented } from './fields'
import { BOOL_OPS, boolUi, flatten, release, setOp } from '../booleans'

/** What only some shapes have: line tips, a second arrow head, a boolean's operation. */
export function buildShapeProps(p: PropsPanel, el: ShapeElement) {
  if (el.bool) {
    // Switching recomputes from the kept operands; Flatten forgets them, Release gives them back.
    const ops = segmented(BOOL_OPS, el.bool.op, (op) => {
      if (!setOp(p.store, el, op as typeof BOOL_OPS[number])) p.toast(t('Nothing would be left of these shapes'))
    }, Object.fromEntries(BOOL_OPS.map((op) => [op, boolUi(op).label])))
    ops.classList.add('ed-bool-ops')
    row(p, 'Boolean', ops)
    const act = (label: string, run: () => void) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ed-btn'
      b.textContent = label
      b.addEventListener('click', run)
      return b
    }
    field(p,
      act(t('Flatten'), () => flatten(p.store, el)),
      act(t('Release shapes'), () => release(p.store, el)))
  }
  // Tips: lines, and open paths (a curved line or connector, #302). The
  // options are tips.ts's catalogue — display labels localized, values the
  // model's words. A closed path (polygon) has no ends to tip.
  if (el.shape === 'line' || (el.shape === 'path' && !/z\s*$/i.test(el.d ?? ''))) {
    const ENDINGS: Array<[string, string]> = TIPS.map((tip) => [tip.kind, optLabel(tip.label)])
    row(p, 'Line start', labeledSelect(ENDINGS, el.lineStart ?? 'none', (v) =>
      p.mutate(el.id, (e) => { (e as ShapeElement).lineStart = v === 'none' ? undefined : (v as LineEnding) }, true)))
    row(p, 'Line end', labeledSelect(ENDINGS, el.lineEnd ?? 'none', (v) =>
      p.mutate(el.id, (e) => { (e as ShapeElement).lineEnd = v === 'none' ? undefined : (v as LineEnding) }, true)))
  }
  if (el.shape === 'arrow') {
    // #304: a head at both ends is a property of the arrow, not a kind
    row(p, 'Double-headed', toggle(el.heads === 2, (on) =>
      p.mutate(el.id, (e) => { const s = e as ShapeElement; if (on) s.heads = 2; else delete s.heads }, true)))
  }
}

export function buildShapeFill(p: PropsPanel, el: ShapeElement) {
  if (el.shape === 'line') return // its one colour is `fill`, shown under Stroke (buildShapeStroke)
  section(p, t('Fill'))
  if (el.fills) {
    buildFillStack(p, el)
    addLayerButton(p, t('Add fill layer'), () => restackFills(p, el, (ls, order) => { ls.push({ color: NEW_LAYER }); order.push(-1) }))
    return
  }
  const grad = el.fillGradient
  const host = paintHost(p, el.id, 'fill', 'fillGradient')
  field(p, fillKind(host.kind, (v) =>
    host.write(v as PaintKind, v === 'solid' ? undefined : gradientFor(v as 'linear' | 'radial', grad, el.fill), undefined, true)))
  if (host.kind === 'solid' || !grad) {
    field(p, colorAlpha(p, el.fill, (v, fin) =>
      p.mutate(el.id, (e) => { (e as ShapeElement).fill = v }, fin),
      { id: el.id, path: 'fill' }, host))
  } else {
    field(p, gradientChip(p, host))
    gradientRows(p, grad, (fn, fin) => p.mutate(el.id, (e) => {
      const g = (e as ShapeElement).fillGradient
      if (g) fn(g)
    }, fin))
  }
  addLayerButton(p, t('Add fill layer'), () => restackFills(p, el, (ls, order) => { ls.push({ color: NEW_LAYER }); order.push(-1) }))
}

/** A new layer: half-transparent, so the one beneath still shows it is there. */
const NEW_LAYER = 'rgba(128, 128, 128, 0.5)'

const swap = <T>(a: T[], i: number, j: number) => { [a[i], a[j]] = [a[j], a[i]] }

/** One edit of the fill layers — one undo step. `order` maps each new slot to
 *  its old index (-1 for a new layer), so colour references move with their layer. */
function restackFills(p: PropsPanel, el: ShapeElement, fn: (layers: PaintLayer[], order: number[]) => void) {
  p.mutate(el.id, (e) => {
    const s = e as ShapeElement
    const layers: PaintLayer[] = JSON.parse(JSON.stringify(fillLayers(s)))
    const order = layers.map((_, i) => i)
    fn(layers, order)
    setFillLayers(s, layers, order)
  }, true)
}

function restackStrokes(p: PropsPanel, el: ShapeElement, fn: (layers: StrokeLayer[], order: number[]) => void) {
  p.mutate(el.id, (e) => {
    const s = e as ShapeElement
    const layers: StrokeLayer[] = JSON.parse(JSON.stringify(strokeLayers(s)))
    const order = layers.map((_, i) => i)
    fn(layers, order)
    setStrokeLayers(s, layers, order)
  }, true)
}

/** The eye, move up, move down and remove of layer `i` of `count`. */
function layerActions<L extends { hidden?: true }>(i: number, count: number, restack: (fn: (layers: L[], order: number[]) => void) => void) {
  return {
    eye: () => restack((ls) => { if (ls[i].hidden) delete ls[i].hidden; else ls[i].hidden = true }),
    up: i < count - 1 ? () => restack((ls, o) => { swap(ls, i, i + 1); swap(o, i, i + 1) }) : undefined,
    down: i > 0 ? () => restack((ls, o) => { swap(ls, i, i - 1); swap(o, i, i - 1) }) : undefined,
    remove: () => restack((ls, o) => { ls.splice(i, 1); o.splice(i, 1) }),
  }
}

/** A layer row: eye, the layer's own controls, then up / down / remove. */
function layerRow(p: PropsPanel, hidden: boolean, act: ReturnType<typeof layerActions>, ...body: HTMLElement[]) {
  const row = document.createElement('div')
  row.className = 'ed-paintlayer' + (hidden ? ' off' : '')
  const btn = (icon: string, label: string, run?: () => void) => {
    const b = opBtn(icon, label, () => run?.()) as HTMLButtonElement
    b.type = 'button'
    b.setAttribute('aria-label', label)
    b.disabled = !run
    return b
  }
  const eye = btn(ICONS.eye, hidden ? t('Show layer') : t('Hide layer'), act.eye)
  eye.classList.add('ed-paintlayer-eye')
  eye.setAttribute('aria-pressed', String(hidden))
  const main = document.createElement('div')
  main.className = 'ed-paintlayer-body'
  main.append(...body)
  row.append(eye, main,
    btn(ICONS.forward, t('Move layer up'), act.up),
    btn(ICONS.backward, t('Move layer down'), act.down),
    btn(ICONS.minus, t('Remove layer'), act.remove))
  p.host.appendChild(row)
}

function addLayerButton(p: PropsPanel, label: string, run: () => void) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'ed-btn ed-addlayer'
  b.innerHTML = ICONS.plus
  const span = document.createElement('span')
  span.textContent = label
  b.append(span)
  b.addEventListener('click', run)
  field(p, b)
}

/** The fill stack, top layer first — the order Figma and Penpot list it in. */
function buildFillStack(p: PropsPanel, el: ShapeElement) {
  const layers = el.fills!
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i]
    const host = paintHost(p, el.id, `fills.${i}.color`, `fills.${i}.gradient`)
    const paint = host.kind === 'solid' || !l.gradient
      ? colorAlpha(p, l.color, (v, fin) => p.mutate(el.id, (e) => {
        const f = (e as ShapeElement).fills?.[i]
        if (f) f.color = v
      }, fin), { id: el.id, path: `fills.${i}.color` }, host)
      : gradientChip(p, host)
    layerRow(p, !!l.hidden, layerActions(i, layers.length, (fn) => restackFills(p, el, fn)), paint)
    if (l.gradient && host.kind !== 'solid') {
      gradientRows(p, l.gradient, (fn, fin) => p.mutate(el.id, (e) => {
        const g = (e as ShapeElement).fills?.[i]?.gradient
        if (g) fn(g)
      }, fin))
    }
  }
}

/** The stroke stack, top layer first: colour, width and position per layer. */
function buildStrokeStack(p: PropsPanel, el: ShapeElement) {
  const layers = el.strokes!
  const def = el.shape === 'rect' || el.shape === 'ellipse' || el.shape === 'triangle' ? 'inside' : 'center'
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i]
    const edit = (fn: (s: StrokeLayer) => void, fin: boolean) => p.mutate(el.id, (e) => {
      const s = (e as ShapeElement).strokes?.[i]
      if (s) fn(s)
    }, fin)
    const paint = colorAlpha(p, l.color, (v, fin) => edit((s) => { s.color = v }, fin), { id: el.id, path: `strokes.${i}.color` })
    const grid = document.createElement('div')
    grid.className = 'ed-grid2'
    const align = labeledSelect([['inside', t('Inside')], ['center', t('Center')], ['outside', t('Outside')]], l.align ?? def, (v) =>
      edit((s) => { if (v === def) delete s.align; else s.align = v as StrokeLayer['align'] }, true))
    align.setAttribute('aria-label', t('Stroke position'))
    grid.append(mini(t('Width'), l.width, (v, fin) => edit((s) => { s.width = Math.max(v, 0) }, fin), undefined, { min: 0 }), align)
    layerRow(p, !!l.hidden, layerActions(i, layers.length, (fn) => restackStrokes(p, el, fn)), paint, grid)
  }
}

/** Stroke — an optional layer for a closed shape; a line IS its stroke, so
 *  a line's cannot be removed. An arrow is a closed polygon (kernel/src/
 *  shape.ts), so its stroke is optional like a rect's. A `line` is drawn in
 *  its `fill` colour, so its Stroke colour field edits `fill` and the panel
 *  shows no Fill section for it; an open path is stroked with `stroke`. */
export function buildShapeStroke(p: PropsPanel, el: ShapeElement) {
  const isLine = el.shape === 'line' || (el.shape === 'path' && !/z\s*$/i.test(el.d ?? ''))
  const on = !!el.strokes || (el.strokeWidth > 0 && parseColor(el.stroke).a > 0)
  section(p, t('Stroke'), isLine ? undefined : on
    ? { add: false, hint: t('Remove stroke'), run: () => p.mutate(el.id, (e) => { setStrokeLayers(e as ShapeElement, [], []) }, true) }
    : { add: true, hint: t('Add stroke'), run: () => p.mutate(el.id, (e) => {
      const s = e as ShapeElement
      s.strokeWidth = 2
      if (parseColor(s.stroke).a === 0) s.stroke = '#1E2A3A'
    }, true) })
  if (!on && !isLine) return
  const addStroke = () => addLayerButton(p, t('Add stroke layer'), () => restackStrokes(p, el, (ls, order) => {
    ls.push({ color: '#1E2A3A', width: 2 })
    order.push(-1)
  }))
  if (el.strokes) {
    buildStrokeStack(p, el)
    addStroke()
    return
  }
  if (el.shape === 'line') {
    field(p, colorAlpha(p, el.fill, (v, fin) =>
      p.mutate(el.id, (e) => { (e as ShapeElement).fill = v }, fin),
      { id: el.id, path: 'fill' }))
  } else {
    field(p, colorAlpha(p, el.stroke === 'transparent' ? 'rgba(30, 42, 58, 0)' : el.stroke, (v, fin) =>
      p.mutate(el.id, (e) => { (e as ShapeElement).stroke = v }, fin)))
  }
  // 'custom' is a dash and gap of the author's own (strokeDashes); the
  // nearest named style stays under it for a shell that predates it
  const style = labeledSelect(
    [['solid', t('Solid')], ['dashed', t('Dashed')], ['dotted', t('Dotted')], ['custom', t('Custom dashes')]],
    el.strokeDashes ? 'custom' : el.strokeStyle ?? (el.strokeDash ? 'dashed' : 'solid'),
    (v) => p.mutate(el.id, (e) => {
      const s = e as ShapeElement
      if (v === 'custom') {
        s.strokeDashes = [Math.max(s.strokeWidth * 3, 6), Math.max(s.strokeWidth * 2, 4)]
        s.strokeStyle = 'dashed'
        return
      }
      delete s.strokeDashes
      s.strokeStyle = v === 'solid' ? undefined : (v as 'dashed' | 'dotted')
      if (v === 'solid') delete s.strokeDash // clear the legacy dash too
    }, true))
  style.title = t('Line style')
  style.setAttribute('aria-label', t('Line style'))
  const grid = document.createElement('div')
  grid.className = 'ed-grid2'
  grid.append(tokenBind(p, mini(t('Width'), el.strokeWidth, (v, fin) =>
    p.mutate(el.id, (e) => { (e as ShapeElement).strokeWidth = Math.max(v, 0) }, fin), undefined, { min: 0 }), el, 'strokeWidth'), style)
  p.host.appendChild(grid)
  if (el.strokeDashes) {
    const dashes = document.createElement('div')
    dashes.className = 'ed-grid2'
    const part = (i: 0 | 1, label: string) => mini(label, el.strokeDashes![i], (v, fin) => p.mutate(el.id, (e) => {
      const s = e as ShapeElement
      if (s.strokeDashes) s.strokeDashes[i] = Math.max(v, 0)
    }, fin), undefined, { min: 0 })
    dashes.append(part(0, t('Dash')), part(1, t('Gap')))
    p.host.appendChild(dashes)
  }
  // Inside | Center | Outside — closed outlines only; a line has no inside
  if (!isLine) {
    const def = el.shape === 'rect' || el.shape === 'ellipse' || el.shape === 'triangle' ? 'inside' : 'center'
    const align = segmented(['inside', 'center', 'outside'], el.strokeAlign ?? def, (v) => p.mutate(el.id, (e) => {
      const s = e as ShapeElement
      if (v === def) delete s.strokeAlign
      else s.strokeAlign = v as 'inside' | 'center' | 'outside'
    }, true), { inside: t('Inside'), center: t('Center'), outside: t('Outside') })
    align.setAttribute('aria-label', t('Stroke position'))
    row(p, 'Stroke position', align)
    addStroke()
  }
}
