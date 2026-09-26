// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * WHAT YOU CAN ADD TO A PAGE, declared once: the families the top bar's insert
 * group shows, and the order the `/` menu lists.
 *
 * Slides' insert group is one button per KIND of thing (Text, Shape, Image,
 * Media, Table, Chart, Code, then Comment). A kind with variants opens a small
 * menu of them, and a kind with one member inserts it directly. Spaces takes
 * that shape: Text ▾, Image ▾, Table, Chart, View ▾, Code, Embed, then Comment.
 * The bar group and `/` both read this table, so the two can never offer
 * different families, orders or names.
 *
 * A family whose block type this build does not have is left out, and so is
 * any member whose type is missing. A family left with ONE member becomes a
 * plain button. So when Chart or Embed exists on a build, it appears in its
 * place, and when maths joins Code, Code grows a menu, without any change
 * here. The diagram block will be ONE more entry, between View and Code.
 *
 * Labels are ENGLISH, the catalog keys: callers t() them at render time, never
 * here (a module-level t() freezes the string before the locale is known).
 */
import type { Block } from './model'
import type { IconName } from './icons'
import { SPEC, MENU_SPECS } from './blocks.ts'
import { VIEW_LAYOUTS } from './fields.ts'

export interface InsertItem {
  /** unique within the table: the type, or `type:variant` */
  key: string
  type: string
  label: string
  hint: string
  icon: IconName
  /** after the type's own init: the variant (a view's layout, a clip's kind) */
  init?: (b: Block) => void
  /** a rule before this member in the family's menu */
  rule?: boolean
}

export interface InsertFamily {
  id: string
  /** the button's label (English) */
  label: string
  icon: IconName
  /** the button's tooltip and accessible name (English) */
  tip: string
  items: InsertItem[]
}

type Entry = string | (Partial<InsertItem> & { type: string; when?: () => boolean })

/**
 * A saved view of the issues, in one layout. `board` is the absent key.
 * Written `label:`/`hint:` so build-spaces-i18n.mjs sweeps them for the catalogs.
 */
const view = ({ layout, label, hint }: { layout: string; label: string; hint: string }): Entry => ({
  type: 'view', key: `view:${layout}`, label, hint,
  init: (b) => {
    if (layout === 'board') delete (b as { layout?: unknown }).layout
    else (b as { layout?: unknown }).layout = layout
  },
  when: () => (VIEW_LAYOUTS as readonly string[]).includes(layout),
})

const TABLE: Array<Omit<InsertFamily, 'items'> & { items: Entry[] }> = [
  {
    id: 'text', label: 'Text', icon: 'text',
    tip: 'Add text — a heading, a list, a quote, a callout or a divider',
    items: ['p', 'h1', 'h2', 'h3', 'quote', 'callout', 'toggle', 'bullet', 'number', 'todo', 'divider'],
  },
  {
    id: 'image', label: 'Image', icon: 'image',
    tip: 'Add an image, a video, audio or a card',
    items: [
      'image',
      { type: 'media', key: 'media:video', label: 'Video', hint: 'Plays in the page', init: (b) => { b.kind = 'video' } },
      { type: 'media', key: 'media:audio', label: 'Audio', hint: 'Plays in the page', init: (b) => { b.kind = 'audio' } },
      // what the dialog that fills it is called, and what it is
      { type: 'link', label: 'Link card', rule: true },
      'pagelink',
    ],
  },
  {
    id: 'table', label: 'Table', icon: 'table',
    tip: 'Add a table — edit the cells in place',
    items: ['table'],
  },
  {
    id: 'chart', label: 'Chart', icon: 'graph',
    tip: 'Add a chart of the issues in this space',
    items: ['chart'],
  },
  {
    id: 'view', label: 'View', icon: 'board',
    tip: 'Add a view of the issues in this space — a board, a list, a table or a gallery',
    items: [
      view({ layout: 'board', label: 'Board', hint: 'Issues in columns' }),
      view({ layout: 'list', label: 'List', hint: 'Issues, one to a line' }),
      view({ layout: 'table', label: 'Table view', hint: 'Issues in rows and columns' }),
      view({ layout: 'gallery', label: 'Gallery', hint: 'Issues as cards' }),
      view({ layout: 'calendar', label: 'Calendar', hint: 'Issues on their dates' }),
      view({ layout: 'gantt', label: 'Timeline', hint: 'Issues across time' }),
      view({ layout: 'workload', label: 'Workload', hint: 'Issues by person' }),
      // not a view of the issues but a surface you arrange by hand — the
      // diagram family will be its home when it exists
      { type: 'canvas', rule: true },
    ],
  },
  // THE DIAGRAM BLOCK goes here, as one entry — a family with id 'diagram',
  // its label, icon and tip, and items: ['diagram'].
  {
    id: 'code', label: 'Code', icon: 'code',
    tip: 'Add a code block',
    items: ['code', 'math'],
  },
  {
    id: 'embed', label: 'Embed', icon: 'page',
    tip: 'Add another page’s content, kept in step with it',
    items: ['embed'],
  },
]

/** The families this build can offer, each with the members it has. */
export function insertFamilies(): InsertFamily[] {
  const out: InsertFamily[] = []
  for (const f of TABLE) {
    const items: InsertItem[] = []
    for (const e of f.items) {
      const x = typeof e === 'string' ? { type: e } : e
      const spec = SPEC.get(x.type)
      if (!spec || spec.unlisted) continue
      if ('when' in x && x.when && !x.when()) continue
      items.push({
        key: x.key ?? x.type, type: x.type,
        label: x.label ?? spec.label, hint: x.hint ?? spec.hint, icon: x.icon ?? spec.icon,
        init: x.init, rule: x.rule && items.length > 0,
      })
    }
    if (items.length) out.push({ id: f.id, label: f.label, icon: f.icon, tip: f.tip, items })
  }
  return out
}

/** Every member in family order — the `/` menu's list. */
export function insertItems(): InsertItem[] {
  return insertFamilies().flatMap((f) => f.items)
}

/**
 * How a LIST of the families is sectioned (the `/` menu, the folded ⋯): a
 * family with variants under its own caption, and a run of one-member families
 * set apart by a rule — a caption reading "Table" over a row reading "Table"
 * says nothing twice.
 */
export interface InsertSection { caption?: string; rule?: boolean; items: InsertItem[] }
export function insertSections(): InsertSection[] {
  const out: InsertSection[] = []
  let run: InsertSection | null = null
  for (const f of insertFamilies()) {
    if (f.items.length > 1) {
      run = null
      out.push({ caption: f.label, items: f.items })
    } else {
      if (!run) { run = { rule: out.length > 0, items: [] }; out.push(run) }
      run.items.push(...f.items)
    }
  }
  return out
}

/** Listed block types no family places: the rig holds this to empty. */
export function unplacedTypes(): string[] {
  const placed = new Set(insertItems().map((i) => i.type))
  return MENU_SPECS.map((s) => s.type).filter((t) => !placed.has(t))
}
