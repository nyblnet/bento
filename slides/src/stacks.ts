// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Fill and stroke STACKS (Figma's, Penpot's): a shape can carry several fill
// layers and several stroke layers (`fills`, `strokes`, bottom first). The
// renderer draws the layers; the single-paint fields an older shell knows —
// `fill`/`fillGradient`, `stroke`/`strokeWidth`/`strokeAlign`/`strokeDashes`/
// `strokeGradient` (a line's stroke colour is its `fill`) —
// MIRROR the top visible layer, so a shell that predates stacks draws the
// paint that matters most. The mirror is derived, like connector routing:
// every replica computes it from the layers, on every doc change, so a palette
// or token rewrite of `fills.1.color` reaches the fallback too.
//
// A stack only exists with two or more layers: dropping to one folds it back
// into the plain fields, so a one-paint shape stays byte-identical to before.

import type { BentoDoc, PaintLayer, ShapeElement, StrokeLayer } from './model'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

/** Bring a shape's single-paint fields in line with its stacks. True if anything changed. */
export function mirrorStacks(el: ShapeElement): boolean {
  const snap = () => JSON.stringify([el.fill, el.fillGradient, el.stroke, el.strokeWidth, el.strokeAlign, el.strokeDashes, el.strokeGradient])
  const before = snap()
  if (el.fills && el.shape !== 'line') {
    const top = [...el.fills].reverse().find((l) => !l.hidden)
    el.fill = top?.color ?? 'transparent'
    if (top?.gradient?.stops.length) el.fillGradient = clone(top.gradient)
    else delete el.fillGradient
  }
  if (el.strokes) {
    const top = [...el.strokes].reverse().find((l) => !l.hidden)
    if (top) {
      writeStroke(el, top)
    } else el.strokeWidth = 0
  }
  return snap() !== before
}

/** One stroke layer onto the single-paint keys. A line's stroke colour is its `fill`. */
function writeStroke(el: ShapeElement, top: StrokeLayer) {
  if (el.shape === 'line') el.fill = top.color
  else el.stroke = top.color
  el.strokeWidth = top.width
  if (top.gradient?.stops.length) el.strokeGradient = clone(top.gradient)
  else delete el.strokeGradient
  if (top.align) el.strokeAlign = top.align
  else delete el.strokeAlign
  if (top.dashes) el.strokeDashes = [...top.dashes]
  else delete el.strokeDashes
}

/** Every shape in the deck (layouts too); true if any fallback moved. */
export function mirrorAllStacks(doc: BentoDoc): boolean {
  let changed = false
  for (const s of [...doc.slides, ...(doc.layouts ?? [])]) {
    for (const el of s.elements) if (el.type === 'shape' && (el.fills || el.strokes) && mirrorStacks(el)) changed = true
  }
  return changed
}

/** The shape's fills as a list — its stack, or its one fill as a layer. */
export function fillLayers(el: ShapeElement): PaintLayer[] {
  return el.fills ?? [{ color: el.fill, ...(el.fillGradient?.stops.length ? { gradient: el.fillGradient } : {}) }]
}

/** The shape's strokes as a list — its stack, its one stroke, or none. A
 *  line always has its one stroke (drawn in `fill`, at least 2px wide). */
export function strokeLayers(el: ShapeElement): StrokeLayer[] {
  if (el.strokes) return el.strokes
  const line = el.shape === 'line'
  if (!(el.strokeWidth > 0) && !line) return []
  return [{
    color: line ? el.fill : el.stroke, width: line ? Math.max(el.strokeWidth, 2) : el.strokeWidth,
    ...(el.strokeAlign ? { align: el.strokeAlign } : {}),
    ...(el.strokeDashes ? { dashes: el.strokeDashes } : {}),
    ...(el.strokeGradient?.stops.length ? { gradient: el.strokeGradient } : {}),
  }]
}

/**
 * Replace a shape's fill layers. Two or more become a stack; one folds back
 * into `fill`/`fillGradient`. Colour references move with their layer: refs on
 * `fills.N.*` are renumbered by `order` (old index per new slot), and the
 * plain `fill`/`fillGradient.*` refs belong to the single-paint form only.
 */
export function setFillLayers(el: ShapeElement, layers: PaintLayer[], order: number[]): void {
  remapRefs(el, 'fills', 'fill', 'fillGradient', order, layers.length, 'gradient')
  if (layers.length >= 2) {
    el.fills = layers
    mirrorStacks(el)
    return
  }
  delete el.fills
  const only = layers[0]
  el.fill = only && !only.hidden ? only.color : 'transparent'
  if (only?.gradient?.stops.length && !only.hidden) el.fillGradient = only.gradient
  else delete el.fillGradient
}

/** Replace a shape's stroke layers; as setFillLayers. None = no stroke. */
export function setStrokeLayers(el: ShapeElement, layers: StrokeLayer[], order: number[]): void {
  remapRefs(el, 'strokes', el.shape === 'line' ? 'fill' : 'stroke', 'strokeGradient', order, layers.length, 'gradient')
  if (layers.length >= 2) {
    el.strokes = layers
    mirrorStacks(el)
    return
  }
  delete el.strokes
  const only = layers[0]
  if (!only || only.hidden) { el.strokeWidth = 0; delete el.strokeGradient; return }
  writeStroke(el, only)
}

/**
 * Carry `themeRefs` across a re-layering. Before, the layers' refs live under
 * `stackKey.N.colorKey` (a stack) or under the plain keys (one paint, read as
 * layer 0). After, they go under the new index, or onto the plain keys when one
 * layer is left. A ref on a removed layer is dropped with it.
 */
function remapRefs(
  el: ShapeElement, stackKey: string, solidKey: string, gradKey: string | null,
  order: number[], count: number, layerGradKey: string | null,
): void {
  const colorKey = 'color'
  const refs = el.themeRefs
  if (!refs) return
  const wasStack = !!(el as unknown as Record<string, unknown>)[stackKey]
  // the old refs, by old layer index and the sub-path inside the layer
  const byLayer = new Map<number, Array<[string, string]>>()
  for (const [path, ref] of Object.entries(refs)) {
    let idx: number, sub: string
    const m = wasStack ? new RegExp(`^${stackKey}\\.(\\d+)\\.(.+)$`).exec(path) : null
    if (m) { idx = +m[1]; sub = m[2] }
    else if (!wasStack && path === solidKey) { idx = 0; sub = colorKey }
    else if (!wasStack && gradKey && layerGradKey && path.startsWith(`${gradKey}.`)) { idx = 0; sub = `${layerGradKey}.${path.slice(gradKey.length + 1)}` }
    else continue
    delete refs[path]
    if (!byLayer.has(idx)) byLayer.set(idx, [])
    byLayer.get(idx)!.push([sub, ref])
  }
  order.forEach((oldIdx, newIdx) => {
    for (const [sub, ref] of byLayer.get(oldIdx) ?? []) {
      if (count >= 2) refs[`${stackKey}.${newIdx}.${sub}`] = ref
      else if (sub === colorKey) refs[solidKey] = ref
      else if (gradKey && layerGradKey && sub.startsWith(`${layerGradKey}.`)) refs[`${gradKey}.${sub.slice(layerGradKey.length + 1)}`] = ref
    }
  })
  if (!Object.keys(refs).length) delete el.themeRefs
}
