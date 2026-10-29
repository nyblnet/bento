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
 * WHERE IT LIVES: the side column's Layers view (Slides | Layers), as in
 * Penpot and Figma — navigation on the left, properties on the right. It
 * used to be FIRST in the properties panel, whatever was selected. The
 * #481 measurement (Chrome 1565 px wide, starter deck, panel viewport 740 px:
 * the Slide panel is 1192 px of content, a selected text element's 2219 px)
 * argued for putting it first on the Slide panel and LAST on an element's, so
 * it was reachable in both — but a section that moves is worse than one that
 * is far: every click on the canvas hopped it from the top of the panel to
 * the bottom, and a user who opened it expected it where they left it. Its
 * own column settles both: it never moves, and it no longer pushes anything
 * down, so it runs the full height instead of capping itself at ~12 rows.
 *
 * GROUPS read as Penpot and Figma show them: a row for the group (disclosure
 * arrow, 'Group of N'), its members nested under it. Grouping gathers the
 * members into one block of the stack (panels.ts group), so a group is one
 * run; a file grouped before that can still interleave, and then each run
 * gets its own group row — the list never pretends the stack is other than
 * it is.
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
  /** component membership: ◆ the main, ◇ a copy (components.ts) */
  comp?: 'main' | 'copy'
  /** paint index in slide.elements (0 = bottom) */
  index: number
  type: SlideElement['type']
  /** short, display-ready label (already translated where it is a kind name) */
  label: string
  /** the element belongs to a group (indented one level) */
  grouped: boolean
  groupId?: string
  /** the group's name, when the author gave it one */
  groupName?: string
  /** an auto-layout frame (layout.ts): its direction, for the row's icon */
  frame?: 'row' | 'col' | 'grid'
  /** how many frames deep the element sits (0 = on the slide) */
  depth?: number
  /** Layers' padlock and eye (the element's `locked` / `hidden`) */
  locked?: boolean
  hidden?: boolean
  /** morphs from an element on the slide before (badge ↔) */
  paired?: boolean
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
  if (el.name) return el.name
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
export function layerRows(slide: Pick<Slide, 'elements'>, tr?: (s: string) => string, paired?: ReadonlySet<string>): LayerRow[] {
  const rows: LayerRow[] = slide.elements.map((el, index) => ({
    id: el.id, index, type: el.type, label: labelFor(el, tr), grouped: !!el.groupId, groupId: el.groupId, groupName: el.groupName,
    ...(el.type === 'shape' && el.layout ? { frame: el.layout.dir } : {}),
    ...(el.component ? { comp: el.component.main ? 'main' as const : 'copy' as const } : {}),
    locked: !!el.locked, hidden: !!el.hidden, paired: !!paired?.has(el.id),
  }))
  const top = rows.reverse()
  // A frame's children list under their frame, whatever their paint index,
  // as every design tool's layer tree does. No frames, no change.
  const frames = new Set(rows.filter((r) => r.frame).map((r) => r.id))
  if (!frames.size) return top
  const parentOf = new Map(slide.elements.map((e) => [e.id, e.parentId && frames.has(e.parentId) ? e.parentId : undefined]))
  const out: LayerRow[] = []
  const visit = (r: LayerRow, depth: number) => {
    if (out.includes(r) || depth > 32) return
    out.push(depth ? { ...r, depth } : r)
    if (r.frame) for (const c of top) if (parentOf.get(c.id) === r.id) visit(c, depth + 1)
  }
  for (const r of top) if (!parentOf.get(r.id)) visit(r, 0)
  for (const r of top) if (!out.some((o) => o.id === r.id)) out.push(r) // a parent cycle: list it flat
  return out
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

/** Which element rows read as selected: exactly the selected elements. A
 *  group has its own row now (layers.ts groupRow), lit when the whole group is
 *  selected — so a member reached on its own (⌘-click, or its row) lights
 *  alone, and a group selected by a canvas click lights every row of it. */
export function highlighted(rows: readonly LayerRow[], selection: readonly string[]): Set<string> {
  const sel = new Set(selection)
  return new Set(rows.filter((r) => sel.has(r.id)).map((r) => r.id))
}

/** What the rows depend on, as one comparable string — ids in paint order,
 *  labels, groups and the row's flags (lock, eye, morph badge). Position,
 *  size, colour and every other property are deliberately absent: a drag
 *  frame must not touch the list. */
export function rowSignature(slide: Pick<Slide, 'elements'>, tr?: (s: string) => string, paired?: ReadonlySet<string>): { order: string; labels: string } {
  const rows = layerRows(slide, tr, paired)
  return {
    order: rows.map((r) => `${r.id}\u001f${r.type}\u001f${r.groupId ?? ''}\u001f${r.groupName ?? ''}\u001f${r.frame ?? ''}\u001f${r.depth ?? 0}\u001f${r.comp ?? ''}\u001f${+!!r.locked}${+!!r.hidden}${+!!r.paired}`).join('\u001e'),
    labels: rows.map((r) => r.label).join('\u001e'),
  }
}

/** How much of the list a change touches. */
export function signatureDiff(a: ReturnType<typeof rowSignature> | null, b: ReturnType<typeof rowSignature>): 'same' | 'labels' | 'rows' {
  if (!a) return 'rows'
  if (a.order !== b.order) return 'rows'
  return a.labels === b.labels ? 'same' : 'labels'
}
