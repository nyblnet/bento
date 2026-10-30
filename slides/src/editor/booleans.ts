// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The boolean verbs: combine a selection, change a boolean's operation, flatten
// it to a plain path, or release its operands. Each is one store.commit — one
// undo step. The geometry is vector-bool.ts; this file only moves elements.
import type { Store } from '../store'
import { uid, type ShapeElement, type SlideElement } from '../model'
import { canBool, computeBool, type BoolOp } from '../vector-bool'
import { ICONS } from '../icons'
import { isMacOS } from '../screens'
import { t } from '../i18n'

export const BOOL_OPS: BoolOp[] = ['union', 'subtract', 'intersect', 'exclude']

/** The selection as boolean operands, bottom first — or null if it is not one. */
export function boolOperands(store: Store, els: SlideElement[]): ShapeElement[] | null {
  if (els.length < 2 || !els.every(canBool)) return null
  const order = store.slide.elements
  return [...els].sort((a, b) => order.indexOf(a) - order.indexOf(b)) as ShapeElement[]
}

/** Two or more shapes where some cannot take part (a line, an arrow, an open
 *  path has no inside): the reason, for the bar to show instead of acting. */
export function boolBlocked(els: SlideElement[]): string | null {
  if (els.length < 2 || !els.every((e) => e.type === 'shape') || els.every(canBool)) return null
  return t('Lines, arrows and open paths can’t be combined — they have no inside. Deselect them to combine the rest.')
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

/** The paint, effects and presentation the result inherits: the bottom shape's (Figma's rule). */
function inherit(from: ShapeElement): Partial<ShapeElement> {
  const { fill, fillGradient, stroke, strokeWidth, strokeDash, strokeStyle, opacity, shadow, blur, blend, backdropFilter, themeRefs, fx, link, group, groupId, groupName, showOnHover, role } = clone(from)
  const out: Partial<ShapeElement> = { fill, fillGradient, stroke, strokeWidth, strokeDash, strokeStyle, opacity, shadow, blur, blend, backdropFilter, themeRefs, fx, link, group, groupId, groupName, showOnHover, role }
  for (const k of Object.keys(out) as Array<keyof ShapeElement>) if (out[k] === undefined) delete out[k]
  return out
}

/** Write a computed outline into the element, as a plain path in its own box. */
function apply(el: ShapeElement, res: NonNullable<ReturnType<typeof computeBool>>, op: BoolOp, shapes: ShapeElement[]) {
  Object.assign(el, { shape: 'path', x: res.x, y: res.y, w: res.w, h: res.h, rotation: 0, radius: 0, d: res.d, pathBox: [0, 0, res.w, res.h] })
  for (const k of ['from', 'to', 'lineStart', 'lineEnd', 'heads'] as const) delete el[k]
  el.bool = { op, shapes }
}

/** Combine the selection; returns the new element's id, or null when it cannot. */
export function combine(store: Store, els: SlideElement[], op: BoolOp): string | null {
  const shapes = boolOperands(store, els)
  if (!shapes) return null
  const res = computeBool(shapes, op)
  if (!res) return null // nothing left (two shapes that never meet, intersected)
  const bottom = shapes[0]
  const el = { ...inherit(bottom), type: 'shape', id: uid('bool') } as ShapeElement
  apply(el, res, op, shapes.map(clone))
  const ids = new Set(shapes.map((s) => s.id))
  store.commit(() => {
    const all = store.slide.elements
    const at = all.indexOf(bottom)
    // the result takes the bottom operand's slot in the stack
    store.slide.elements = [...all.slice(0, at).filter((e) => !ids.has(e.id)), el, ...all.slice(at).filter((e) => !ids.has(e.id))]
  })
  store.select([el.id])
  return el.id
}

/**
 * The operands where the boolean now stands. They were stored as they stood
 * when combined; since then the result may have been moved, resized or turned,
 * so map the frame the result had then onto the one it has now.
 * ponytail: a non-uniform resize of a ROTATED operand only scales its box, so
 * it comes back un-skewed — the same approximation a group resize makes.
 */
export function placeOperands(el: ShapeElement): ShapeElement[] {
  const bool = el.bool!
  const was = computeBool(bool.shapes, bool.op) ?? { x: el.x, y: el.y, w: el.w, h: el.h }
  const sx = el.w / (was.w || 1), sy = el.h / (was.h || 1)
  const a = ((el.rotation || 0) * Math.PI) / 180
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2
  return bool.shapes.map((s0) => {
    const s = clone(s0)
    s.x = el.x + (s.x - was.x) * sx
    s.y = el.y + (s.y - was.y) * sy
    s.w *= sx
    s.h *= sy
    if (a) {
      const ox = s.x + s.w / 2 - cx, oy = s.y + s.h / 2 - cy
      s.x = cx + ox * Math.cos(a) - oy * Math.sin(a) - s.w / 2
      s.y = cy + ox * Math.sin(a) + oy * Math.cos(a) - s.h / 2
      s.rotation = (s.rotation || 0) + el.rotation
    }
    return s
  })
}

/** Recompute a boolean under another operation (false when nothing would be left). */
export function setOp(store: Store, el: ShapeElement, op: BoolOp): boolean {
  if (!el.bool || el.bool.op === op) return false
  const shapes = placeOperands(el)
  const res = computeBool(shapes, op)
  if (!res) return false
  store.commit(() => {
    const live = store.slide.elements.find((e) => e.id === el.id) as ShapeElement | undefined
    if (live) apply(live, res, op, shapes)
  })
  return true
}

/** Keep the outline, forget the operands: a plain path from here on. */
export function flatten(store: Store, el: ShapeElement) {
  if (!el.bool) return
  store.commit(() => {
    const live = store.slide.elements.find((e) => e.id === el.id) as ShapeElement | undefined
    if (live) delete live.bool
  })
}

/** Give the operands back, where the boolean stands, in its slot of the stack. */
export function release(store: Store, el: ShapeElement) {
  if (!el.bool) return
  const shapes = placeOperands(el)
  const taken = new Set(store.slide.elements.map((e) => e.id))
  // a duplicated boolean carries the same operand ids as its original
  for (const s of shapes) if (taken.has(s.id)) s.id = `${s.id}-${uid()}`
  store.commit(() => {
    const all = store.slide.elements
    const at = all.findIndex((e) => e.id === el.id)
    if (at >= 0) all.splice(at, 1, ...shapes)
  })
  store.select(shapes.map((s) => s.id))
}

/** Name, icon and shortcut of each operation, for every place that offers it. */
export function boolUi(op: BoolOp): { label: string; icon: string; key: string; code: string } {
  const alt = isMacOS() ? '⌥⇧' : 'Alt+Shift+'
  const k = { union: 'U', subtract: 'S', intersect: 'I', exclude: 'E' }[op]
  const label = { union: t('Union'), subtract: t('Subtract'), intersect: t('Intersect'), exclude: t('Exclude') }[op]
  const icon = { union: ICONS.boolUnion, subtract: ICONS.boolSubtract, intersect: ICONS.boolIntersect, exclude: ICONS.boolExclude }[op]
  return { label, icon, key: `${alt}${k}`, code: `Key${k}` }
}
