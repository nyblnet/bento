// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Shapes: fill and stroke.
import { tokenBind } from './tokenbind'
import type { PropsPanel } from '../panels'
import type { ShapeElement, LineEnding, PaintLayer, StrokeLayer, SlideElement, TextElement } from '../../model'
import { TIPS } from '../../tips'
import { optLabel, parseColor, SHADOW_PRESETS, roving, relOf } from './controls'
import { applyRel } from './numexpr'
import { row, labeledSelect, toggle, section, field, mini, opBtn } from './fields'
import { ICONS } from '../../icons'
import { fillLayers, setFillLayers, setStrokeLayers, strokeLayers } from '../../stacks'
import { t } from '../../i18n'
import { colorAlpha, gradientRows, gradientChip, paintHost } from './color'
import { segmented } from './fields'
import { BOOL_OPS, boolUi, flatten, release, setOp } from '../booleans'
import { openCtxMenu } from '../ctxmenu'

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
    // start · swap · end, each a glyph that opens the catalogue as previews
    const set = (k: 'lineStart' | 'lineEnd', v: string) =>
      p.mutate(el.id, (e) => { (e as ShapeElement)[k] = v === 'none' ? undefined : (v as LineEnding) }, true)
    const swap = opBtn(ICONS.swap, t('Swap ends'), () => p.mutate(el.id, (e) => {
      const s = e as ShapeElement
      const [a, b] = [s.lineStart, s.lineEnd]
      if (b) s.lineStart = b; else delete s.lineStart
      if (a) s.lineEnd = a; else delete s.lineEnd
    }, true))
    const ends = document.createElement('div')
    ends.className = 'ed-tips'
    ends.append(tipPicker(t('Line start'), el.lineStart, true, (v) => set('lineStart', v)), swap,
      tipPicker(t('Line end'), el.lineEnd, false, (v) => set('lineEnd', v)))
    row(p, 'Ends', ends)
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
  if (host.kind === 'solid' || !grad) {
    field(p, colorAlpha(p, el.fill, (v, fin) =>
      p.mutate(el.id, (e) => { (e as ShapeElement).fill = v }, fin),
      { id: el.id, path: 'fill' }, host))
  } else {
    field(p, gradientChip(p, host))
    gradientRows(p, grad, (fn, fin) => p.mutate(el.id, (e) => {
      const g = (e as ShapeElement).fillGradient
      if (g) fn(g)
    }, fin), host.target)
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
    /** dragged here from layer `from` (drag-to-reorder; up/down stay the keyboard path) */
    moveFrom: (from: number) => restack((ls, o) => {
      if (from === i || !ls[from]) return
      ls.splice(i, 0, ls.splice(from, 1)[0])
      o.splice(i, 0, o.splice(from, 1)[0])
    }),
  }
}

/** CSS mix-blend-mode words a layer offers ('normal' = none). */
const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'] as const
const BLEND_LABEL: Record<string, string> = {
  normal: 'Normal', multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', darken: 'Darken', lighten: 'Lighten',
  'color-dodge': 'Color dodge', 'color-burn': 'Color burn', 'hard-light': 'Hard light', 'soft-light': 'Soft light',
  difference: 'Difference', exclusion: 'Exclusion', hue: 'Hue', saturation: 'Saturation', color: 'Color', luminosity: 'Luminosity',
}

/** The one blend list, for a layer and for the element alike. */
export const blendPairs = (): Array<[string, string]> => BLENDS.map((b) => [b, t(BLEND_LABEL[b])])

/** A layer's blend mode — absent is normal. */
function blendSelect(value: string | undefined, set: (v: string | undefined) => void): HTMLElement {
  const sel = labeledSelect(blendPairs(), value ?? 'normal', (v) => set(v === 'normal' ? undefined : v))
  sel.title = t('Layer blend mode')
  sel.setAttribute('aria-label', sel.title)
  sel.classList.add('ed-layer-blend')
  return sel
}

/** Which layer rows have their ⋯ open, by element and layer — kept across
 *  the rebuild every edit inside them causes. */
const openExtras = new Set<string>()

/**
 * A layer row, Figma's: grip · eye · the paint · ⋯. What a layer needs less
 * often — its blend, a stroke's dashes, moving it, removing it — sits behind
 * ⋯, so the paint keeps the row's width at every panel size. The grip drags
 * the row onto another of the same stack (`stack` names it, so a fill never
 * lands among strokes); Move up / Move down are the keyboard's way.
 */
function layerRow(p: PropsPanel, el: { id: string }, stack: 'fill' | 'stroke', i: number, hidden: boolean, act: ReturnType<typeof layerActions>, paint: HTMLElement, extras: HTMLElement[], under: HTMLElement[] = []) {
  const row = document.createElement('div')
  row.className = 'ed-paintlayer' + (hidden ? ' off' : '')
  row.dataset.layer = `${stack}${i}`
  const grip = document.createElement('span')
  grip.className = 'ed-paintlayer-grip'
  grip.textContent = '⠿'
  grip.title = t('Drag to reorder')
  grip.setAttribute('aria-hidden', 'true')
  // only the grip starts a drag: a draggable row would steal its fields' text selection
  grip.addEventListener('pointerdown', () => { row.draggable = true })
  row.addEventListener('dragend', () => { row.draggable = false; row.classList.remove('is-dragging') })
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer?.setData('application/x-bento-layer', `${stack}:${i}`)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
    row.classList.add('is-dragging')
  })
  const ours = (e: DragEvent) => e.dataTransfer?.types.includes('application/x-bento-layer')
  row.addEventListener('dragover', (e) => { if (ours(e)) { e.preventDefault(); row.classList.add('is-over') } })
  row.addEventListener('dragleave', () => row.classList.remove('is-over'))
  row.addEventListener('drop', (e) => {
    row.classList.remove('is-over')
    const [kind, from] = (e.dataTransfer?.getData('application/x-bento-layer') ?? '').split(':')
    if (kind !== stack || from === undefined) return
    e.preventDefault()
    act.moveFrom(+from)
  })
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
  main.append(paint)
  const key = `${el.id}:${stack}${i}`
  const more = btn(ICONS.more, t('More layer options'), () => {
    if (openExtras.has(key)) openExtras.delete(key)
    else openExtras.add(key)
    const open = openExtras.has(key)
    box.hidden = !open
    more.setAttribute('aria-expanded', String(open))
  })
  more.classList.add('ed-paintlayer-more')
  const box = document.createElement('div')
  box.className = 'ed-paintlayer-extras'
  box.id = `ed-extras-${key.replace(/\W/g, '-')}`
  more.setAttribute('aria-controls', box.id)
  more.setAttribute('aria-expanded', String(openExtras.has(key)))
  box.hidden = !openExtras.has(key)
  const moves = document.createElement('div')
  moves.className = 'ed-paintlayer-moves'
  moves.append(
    btn(ICONS.forward, t('Move layer up'), act.up),
    btn(ICONS.backward, t('Move layer down'), act.down),
    btn(ICONS.minus, t('Remove layer'), act.remove))
  box.append(...extras, moves)
  row.append(grip, eye, main, more, ...under, box)
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
    const blend = blendSelect(l.blend, (v) => p.mutate(el.id, (e) => {
      const f = (e as ShapeElement).fills?.[i]
      if (f) { if (v) f.blend = v; else delete f.blend }
    }, true))
    layerRow(p, el, 'fill', i, !!l.hidden, layerActions(i, layers.length, (fn) => restackFills(p, el, fn)), paint, [blend])
    if (l.gradient && host.kind !== 'solid') {
      gradientRows(p, l.gradient, (fn, fin) => p.mutate(el.id, (e) => {
        const g = (e as ShapeElement).fills?.[i]?.gradient
        if (g) fn(g)
      }, fin), host.target)
    }
  }
}

/** The stroke stack, top layer first: paint (solid or gradient), width,
 *  position (closed outlines only), dash and gap, blend — per layer. */
function buildStrokeStack(p: PropsPanel, el: ShapeElement, open: boolean) {
  const layers = el.strokes!
  const def = el.shape === 'rect' || el.shape === 'ellipse' || el.shape === 'triangle' ? 'inside' : 'center'
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i]
    const edit = (fn: (s: StrokeLayer) => void, fin: boolean) => p.mutate(el.id, (e) => {
      const s = (e as ShapeElement).strokes?.[i]
      if (s) fn(s)
    }, fin)
    const host = paintHost(p, el.id, `strokes.${i}.color`, `strokes.${i}.gradient`)
    const paint = host.kind === 'solid' || !l.gradient
      ? colorAlpha(p, l.color, (v, fin) => edit((s) => { s.color = v }, fin), { id: el.id, path: `strokes.${i}.color` }, host)
      : gradientChip(p, host)
    const grid = document.createElement('div')
    grid.className = 'ed-grid2'
    const width = mini(t('Width'), l.width, (v, fin) => edit((s) => { s.width = Math.max(v, 0) }, fin), undefined, { min: 0 })
    if (open) grid.append(width)
    else {
      const align = segmented(['inside', 'center', 'outside'], l.align ?? def, (v) =>
        edit((s) => { if (v === def) delete s.align; else s.align = v as StrokeLayer['align'] }, true), alignWords(), ALIGN_GLYPHS)
      align.setAttribute('aria-label', t('Stroke position'))
      grid.append(width, align)
    }
    // width and position are the stroke itself: under the paint; dashes and blend behind ⋯
    layerRow(p, el, 'stroke', i, !!l.hidden, layerActions(i, layers.length, (fn) => restackStrokes(p, el, fn)), paint, [
      dashFields(l.dashes, (k, v, fin) => edit((s) => {
        const d: [number, number] = s.dashes ? [...s.dashes] : [0, 0]
        d[k] = Math.max(v, 0)
        if (d[0] > 0) s.dashes = d
        else delete s.dashes // no dash length: a solid stroke
      }, fin)),
      blendSelect(l.blend, (v) => edit((s) => { if (v) s.blend = v; else delete s.blend }, true))], [grid])
    if (l.gradient && host.kind !== 'solid') {
      gradientRows(p, l.gradient, (fn, fin) => edit((s) => { if (s.gradient) fn(s.gradient) }, fin), host.target)
    }
  }
}

/** A stroke layer's dash and gap; a dash of 0 is a solid stroke. */
function dashFields(dashes: [number, number] | undefined, set: (k: 0 | 1, v: number, final: boolean) => void): HTMLElement {
  const grid = document.createElement('div')
  grid.className = 'ed-grid2'
  grid.append(
    mini(t('Dash'), dashes?.[0] ?? 0, (v, fin) => set(0, v, fin), undefined, { min: 0 }),
    mini(t('Gap'), dashes?.[1] ?? 0, (v, fin) => set(1, v, fin), undefined, { min: 0 }))
  return grid
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
    buildStrokeStack(p, el, isLine)
    addStroke()
    return
  }
  // solid, or a gradient along the stroke (strokeGradient; the colour stays its fallback)
  const solidKey = el.shape === 'line' ? 'fill' : 'stroke'
  const host = paintHost(p, el.id, solidKey, 'strokeGradient')
  if (host.kind !== 'solid' && el.strokeGradient) {
    field(p, gradientChip(p, host))
    gradientRows(p, el.strokeGradient, (fn, fin) => p.mutate(el.id, (e) => {
      const g = (e as ShapeElement).strokeGradient
      if (g) fn(g)
    }, fin), host.target)
  } else if (el.shape === 'line') {
    field(p, colorAlpha(p, el.fill, (v, fin) =>
      p.mutate(el.id, (e) => { (e as ShapeElement).fill = v }, fin),
      { id: el.id, path: 'fill' }, host))
  } else {
    field(p, colorAlpha(p, el.stroke === 'transparent' ? 'rgba(30, 42, 58, 0)' : el.stroke, (v, fin) =>
      p.mutate(el.id, (e) => { (e as ShapeElement).stroke = v }, fin), undefined, host))
  }
  // 'custom' is a dash and gap of the author's own (strokeDashes); the
  // nearest named style stays under it for a shell that predates it
  const style = segmented(['solid', 'dashed', 'dotted', 'custom'],
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
    }, true), { solid: t('Solid'), dashed: t('Dashed'), dotted: t('Dotted'), custom: t('Custom dashes') },
    { solid: ICONS.lineSolid, dashed: ICONS.lineDashed, dotted: ICONS.lineDotted, custom: ICONS.lineCustom })
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
    }, true), alignWords(), ALIGN_GLYPHS)
    align.setAttribute('aria-label', t('Stroke position'))
    row(p, 'Stroke position', align)
  }
  addStroke()
}

const ALIGN_GLYPHS = { inside: ICONS.strokeInside, center: ICONS.strokeCenter, outside: ICONS.strokeOutside }
const alignWords = () => ({ inside: t('Inside'), center: t('Center'), outside: t('Outside') })

/** A line with this tip at one end, drawn from the catalogue's own geometry —
 *  the preview cannot drift from what the renderer draws. */
function tipGlyph(kind: string | undefined, atStart: boolean): string {
  const tip = TIPS.find((x) => x.kind === (kind ?? 'none'))
  const g = tip?.geom
  const fill = tip?.hollow ? 'none' : 'currentColor'
  const shape = !g || !tip?.size ? ''
    : g.tag === 'path' ? `<path d="${g.d}" fill="${fill}"/>`
    : g.tag === 'circle' ? `<circle cx="${g.cx}" cy="${g.cy}" r="${g.r}" fill="${fill}"/>`
    : `<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" fill="${fill}"/>`
  // the tip's 8-unit box sits at the line's end, pointing outward
  const place = atStart ? 'translate(9 16) scale(-1.4 1.4) translate(0 -4)' : 'translate(15 16) scale(1.4) translate(0 -4)'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 32" width="18" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M${atStart ? 9 : 2} 16H${atStart ? 22 : 15}" stroke-width="2"/><g transform="${place}" stroke-width="1">${shape}</g></svg>`
}

function tipPicker(name: string, kind: string | undefined, atStart: boolean, pick: (v: string) => void): HTMLElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'ed-btn ed-tip-btn'
  b.innerHTML = tipGlyph(kind, atStart)
  const current = optLabel(TIPS.find((x) => x.kind === (kind ?? 'none'))?.label ?? 'none')
  b.title = `${name}: ${current}`
  b.setAttribute('aria-label', b.title)
  b.setAttribute('aria-haspopup', 'menu')
  b.addEventListener('click', () => {
    const r = b.getBoundingClientRect()
    openCtxMenu(r.left, r.bottom + 4, TIPS.map((tip) => ({
      label: optLabel(tip.label), icon: tipGlyph(tip.kind, atStart),
      checked: tip.kind === (kind ?? 'none'), run: () => pick(tip.kind),
    })))
  })
  return b
}

/**
 * Fill, Stroke and Shadow for several elements at once — shown when they all
 * have that property in the same form (every one a closed shape with a single
 * fill, every one a text box…), so recolouring three cards is one edit, not
 * three. A value they disagree on reads Mixed; a pick sets them all, one undo
 * step. A paint stack or a gradient is the element's own: such a selection
 * shows no shared Fill rather than one that would flatten it.
 */
export function buildSharedPaint(p: PropsPanel, els: SlideElement[]) {
  const shapes = els.every((e) => e.type === 'shape') ? els as ShapeElement[] : null
  const closed = shapes?.every((s) => s.shape !== 'line' && !(s.shape === 'path' && !/z\s*$/i.test(s.d ?? '')))
  const each = (fn: (e: SlideElement) => void, final: boolean) => p.edit(() => {
    for (const e of els) { const el = p.store.element(e.id); if (el) fn(el) }
  }, final)
  // a colour field for a key every element has: Mixed when they differ
  const shared = (key: string, values: string[], set: (e: SlideElement, v: string) => void) => {
    const mixed = values.some((v) => v !== values[0])
    const f = colorAlpha(p, values[0], (v, fin) => each((e) => set(e, v), fin))
    if (mixed) {
      f.classList.add('ed-color-mixed')
      const hex = f.querySelector<HTMLInputElement>('.ed-color-hex')
      if (hex) { hex.value = ''; hex.placeholder = t('Mixed') }
    }
    f.dataset.shared = key
    field(p, f)
  }
  const texts = els.every((e) => e.type === 'text') ? els as TextElement[] : null
  if (shapes && closed && shapes.every((s) => !s.fills && !s.fillGradient)) {
    section(p, t('Fill'))
    shared('fill', shapes.map((s) => s.fill), (e, v) => { (e as ShapeElement).fill = v; delete e.themeRefs?.fill })
  } else if (texts && texts.every((x) => !x.colorGradient)) {
    section(p, t('Fill'))
    shared('color', texts.map((x) => x.color), (e, v) => { (e as TextElement).color = v; delete e.themeRefs?.color })
  }
  if (shapes && closed && shapes.every((s) => !s.strokes && !s.strokeGradient)) {
    const on = shapes.filter((s) => s.strokeWidth > 0 && parseColor(s.stroke).a > 0)
    section(p, t('Stroke'), on.length
      ? { add: false, hint: t('Remove stroke'), run: () => each((e) => { (e as ShapeElement).strokeWidth = 0 }, true) }
      : { add: true, hint: t('Add stroke'), run: () => each((e) => {
        const s = e as ShapeElement
        s.strokeWidth = 2
        if (parseColor(s.stroke).a === 0) s.stroke = '#1E2A3A'
      }, true) })
    if (on.length) {
      shared('stroke', shapes.map((s) => s.stroke), (e, v) => { (e as ShapeElement).stroke = v; delete e.themeRefs?.stroke })
      const widths = shapes.map((s) => s.strokeWidth)
      const mixed = widths.some((w) => w !== widths[0])
      // Mixed widths: a relative entry (+1, *2, a scrub) works on each one's own width
      const w = mini(t('Width'), mixed ? NaN : widths[0], (v, fin) => {
        const rel = !mixed ? null : fin ? relOf(input) : { op: '+' as const, x: v }
        each((e) => {
          const s = e as ShapeElement
          s.strokeWidth = Math.max(rel ? applyRel(rel, widths[shapes.findIndex((x) => x.id === e.id)]) : v, 0)
        }, fin)
      }, undefined, { min: 0 })
      const input = w.querySelector('input')!
      field(p, w)
    }
  }
  // Shadow: added to every element, removed from every one, a preset for all
  const shadowed = els.filter((e) => e.shadow)
  section(p, t('Shadow'), shadowed.length
    ? { add: false, hint: t('Remove shadow'), run: () => each((e) => { delete e.shadow }, true) }
    : { add: true, hint: t('Add shadow'), run: () => each((e) => { e.shadow = { ...Object.values(SHADOW_PRESETS)[0] } }, true) })
  if (!shadowed.length) return
  const same = els.every((e) => JSON.stringify(e.shadow) === JSON.stringify(els[0].shadow))
  const current = same ? Object.entries(SHADOW_PRESETS).find(([, s]) => JSON.stringify(s) === JSON.stringify(els[0].shadow))?.[0] : undefined
  const tiles = document.createElement('div')
  tiles.className = 'ed-shadow-tiles'
  tiles.setAttribute('role', 'radiogroup')
  tiles.setAttribute('aria-label', t('Shadow'))
  for (const [key, sh] of Object.entries(SHADOW_PRESETS)) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-shadow-tile'
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-checked', String(key === current))
    const swatch = document.createElement('span')
    swatch.className = 'ed-shadow-swatch'
    swatch.style.boxShadow = `${(sh.x ?? 0) / 4}px ${(sh.y ?? 0) / 4}px ${sh.blur / 4}px ${sh.color}`
    const name = document.createElement('span')
    name.textContent = optLabel(key)
    b.append(swatch, name)
    b.addEventListener('click', () => each((e) => { e.shadow = { ...SHADOW_PRESETS[key] } }, true))
    tiles.appendChild(b)
  }
  roving(tiles, 'radio')
  p.host.appendChild(tiles)
}
