// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Layers — a list of the current slide's elements in stacking order
 * (discussion #371). Not a new concept in the model: `slide.elements` IS the
 * paint order (last = topmost), and the four Order buttons in the Arrange kit
 * have moved elements through it since 1.0. This is the view onto that order:
 * one row per element, top of the stack first, click to select, drag or
 * ⌘↑/⌘↓ to move. No z-index, no numbers, no new field — a row dropped
 * somewhere ends up exactly where the Order buttons would have put it
 * (moveInPaintOrder below is the same splice as repeated steps).
 *
 * WHERE IT LIVES: FIRST in the properties panel, whatever is selected. The
 * #481 measurement (Chrome 1565 px wide, starter deck, panel viewport 740 px:
 * the Slide panel is 1192 px of content, a selected text element's 2219 px)
 * argued for putting it first on the Slide panel and LAST on an element's, so
 * it was reachable in both — but a section that moves is worse than one that
 * is far: every click on the canvas hopped it from the top of the panel to
 * the bottom, and a user who opened it expected it where they left it. One
 * home now: structure first, then the properties of the selection; closed by
 * default, open state shared under one title. The list caps itself at ~12
 * rows and scrolls inside (the showcase title slide has 39 elements: uncapped
 * it pushed the Slide controls ~975 px down).
 *
 * WHAT REBUILDS IT: only a change in what the rows SAY. A drag emits a doc
 * event per frame, and none of them changes a row (position and size are not
 * in the list), so the list compares a signature of (ids in paint order,
 * labels, groups) and does nothing when it is unchanged, patches label text
 * when only labels changed, and rebuilds rows only on an order or membership
 * change. Selection toggles highlight classes in place.
 *
 * This file is the DOM-free half (rows, labels, the move), imported plain by
 * scripts/test-slides-layers.ts; layers.ts is the DOM.
 */

import type { Slide, SlideElement } from '../model.ts'

export type LayerRow = {
  id: string
  /** paint index in slide.elements (0 = bottom) */
  index: number
  type: SlideElement['type']
  /** short, display-ready label (already translated where it is a kind name) */
  label: string
  /** the element belongs to a group (indented one level) */
  grouped: boolean
  groupId?: string
}

const LABEL_MAX = 24

/** Text with the markup taken out, entities decoded enough to read, collapsed. */
export function excerpt(html: string, max = LABEL_MAX): string {
  const text = html
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[​]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text
}

/** What a row says about its element. Kind names go through t() at build
 *  time (never at module level). */
export function labelFor(el: SlideElement, tr: (s: string) => string = (s) => s): string {
  switch (el.type) {
    case 'text': return excerpt(el.html) || tr('Text')
    case 'shape': return tr({ rect: 'Rectangle', ellipse: 'Ellipse', triangle: 'Triangle', arrow: 'Arrow', line: 'Line', path: 'Curve' }[el.shape] ?? 'Shape')
    case 'image': return tr('Image')
    case 'svg': return tr('Diagram')
    case 'chart': return tr('Chart')
    case 'table': return tr('Table')
    case 'code': return tr('Code')
    case 'media': return tr(el.kind === 'audio' ? 'Audio' : 'Video')
    case 'embed': return tr('Embed')
    default: return tr('Element')
  }
}

/** Rows top-first. */
export function layerRows(slide: Pick<Slide, 'elements'>, tr?: (s: string) => string): LayerRow[] {
  const rows: LayerRow[] = slide.elements.map((el, index) => ({
    id: el.id, index, type: el.type, label: labelFor(el, tr), grouped: !!el.groupId, groupId: el.groupId,
  }))
  return rows.reverse()
}

/**
 * The paint order after moving `id` to paint index `to` — the same result as
 * pressing the Order buttons: `to` = length-1 is Bring to front, 0 is Send to
 * back, ±1 from where it is is one step. A grouped element moves with its
 * whole group (the canvas moves groups as one; a layer list that could split
 * one would be the only place in the editor that can). `to` is clamped;
 * moving to where it already is returns the SAME array (no undo step).
 */
export function moveInPaintOrder<E extends { id: string; groupId?: string }>(elements: readonly E[], id: string, to: number): E[] {
  const el = elements.find((e) => e.id === id)
  if (!el) return elements as E[]
  const unit = el.groupId ? elements.filter((e) => e.groupId === el.groupId) : [el]
  const unitIds = new Set(unit.map((e) => e.id))
  const rest = elements.filter((e) => !unitIds.has(e.id))
  const first = elements.findIndex((e) => unitIds.has(e.id))
  const target = Math.max(0, Math.min(rest.length, to - (to > first ? unit.length - 1 : 0)))
  const next = [...rest.slice(0, target), ...unit, ...rest.slice(target)]
  return next.every((e, i) => e === elements[i]) ? (elements as E[]) : next
}

/** Which rows read as selected — a grouped element's row lights when any
 *  member is selected, the way the canvas selects the group. */
export function highlighted(rows: readonly LayerRow[], selection: readonly string[]): Set<string> {
  const sel = new Set(selection)
  const groups = new Set(rows.filter((r) => sel.has(r.id) && r.groupId).map((r) => r.groupId))
  return new Set(rows.filter((r) => sel.has(r.id) || (r.groupId && groups.has(r.groupId))).map((r) => r.id))
}

/** What the rows depend on, as one comparable string — ids in paint order,
 *  labels and groups. Position, size, colour and every other property are
 *  deliberately absent: a drag frame must not touch the list. */
export function rowSignature(slide: Pick<Slide, 'elements'>, tr?: (s: string) => string): { order: string; labels: string } {
  const rows = layerRows(slide, tr)
  return {
    order: rows.map((r) => `${r.id}\u001f${r.type}\u001f${r.groupId ?? ''}`).join('\u001e'),
    labels: rows.map((r) => r.label).join('\u001e'),
  }
}

/** How much of the list a change touches. */
export function signatureDiff(a: ReturnType<typeof rowSignature> | null, b: ReturnType<typeof rowSignature>): 'same' | 'labels' | 'rows' {
  if (!a) return 'rows'
  if (a.order !== b.order) return 'rows'
  return a.labels === b.labels ? 'same' : 'labels'
}
