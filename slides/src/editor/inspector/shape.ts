// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Shapes: fill and stroke.
import { tokenBind } from './tokenbind'
import type { PropsPanel } from '../panels'
import type { ShapeElement, LineEnding } from '../../model'
import { TIPS } from '../../tips'
import { optLabel, parseColor, combineColor } from './controls'
import { row, labeledSelect, toggle, section, field, mini } from './fields'
import { t } from '../../i18n'
import { fillKind, colorAlpha, gradientRows } from './color'

/** What only some shapes have: line tips, a second arrow head. */
export function buildShapeProps(p: PropsPanel, el: ShapeElement) {
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
  const grad = el.fillGradient
  field(p, fillKind(grad ? 'gradient' : 'solid', (v) =>
    p.mutate(el.id, (e) => {
      const s = e as ShapeElement
      if (v === 'gradient') {
        const base = parseColor(s.fill)
        s.fillGradient ??= {
          angle: 180,
          stops: [
            { at: 0, color: combineColor(base.hex, Math.max(base.a, 0.85)) },
            { at: 1, color: combineColor(base.hex, 0) },
          ],
        }
      } else {
        delete s.fillGradient
      }
    }, true)))
  if (!grad) {
    field(p, colorAlpha(p, el.fill, (v, fin) =>
      p.mutate(el.id, (e) => { (e as ShapeElement).fill = v }, fin),
      { id: el.id, path: 'fill' }))
  } else {
    gradientRows(p, grad, (fn, fin) => p.mutate(el.id, (e) => {
      const g = (e as ShapeElement).fillGradient
      if (g) fn(g)
    }, fin))
  }
}

/** Stroke — an optional layer for a closed shape; a line IS its stroke, so
 *  a line's cannot be removed. An arrow is a closed polygon (kernel/src/
 *  shape.ts), so its stroke is optional like a rect's. A `line` is drawn in
 *  its `fill` colour, so its Stroke colour field edits `fill` and the panel
 *  shows no Fill section for it; an open path is stroked with `stroke`. */
export function buildShapeStroke(p: PropsPanel, el: ShapeElement) {
  const isLine = el.shape === 'line' || (el.shape === 'path' && !/z\s*$/i.test(el.d ?? ''))
  const on = el.strokeWidth > 0 && parseColor(el.stroke).a > 0
  section(p, t('Stroke'), isLine ? undefined : on
    ? { add: false, hint: t('Remove stroke'), run: () => p.mutate(el.id, (e) => { (e as ShapeElement).strokeWidth = 0 }, true) }
    : { add: true, hint: t('Add stroke'), run: () => p.mutate(el.id, (e) => {
      const s = e as ShapeElement
      s.strokeWidth = 2
      if (parseColor(s.stroke).a === 0) s.stroke = '#1E2A3A'
    }, true) })
  if (!on && !isLine) return
  if (el.shape === 'line') {
    field(p, colorAlpha(p, el.fill, (v, fin) =>
      p.mutate(el.id, (e) => { (e as ShapeElement).fill = v }, fin),
      { id: el.id, path: 'fill' }))
  } else {
    field(p, colorAlpha(p, el.stroke === 'transparent' ? 'rgba(30, 42, 58, 0)' : el.stroke, (v, fin) =>
      p.mutate(el.id, (e) => { (e as ShapeElement).stroke = v }, fin)))
  }
  const style = labeledSelect(
    [['solid', t('Solid')], ['dashed', t('Dashed')], ['dotted', t('Dotted')]],
    el.strokeStyle ?? (el.strokeDash ? 'dashed' : 'solid'),
    (v) => p.mutate(el.id, (e) => {
      const s = e as ShapeElement
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
}
