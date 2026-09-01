// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Typed fields: the schema, the defaults, and reading a page's values.
//
// AN ISSUE IS A PAGE. Its fields are `prop` BLOCKS on that page; the schema
// they draw on is `doc.fields`. docs/DECISIONS.md (2026-08-05) carries the
// reasoning; the parts that matter when reading this file:
//
//  · VALUES ARE BLOCKS because everything in spaces that matters iterates
//    `page.blocks` — search, find-and-replace, undo, the block registry, the
//    static preview, markdown export. A page-level key is invisible to all of
//    them and renders as nothing on a build that predates it. And under
//    collaboration each block property is its own last-writer-wins register, so
//    two people setting status and assignee at the same moment both win; one
//    object on the page would have been ONE register and would have lost an
//    edit silently.
//
//  · THE SCHEMA IS NOT A VALUE. Putting the status list on every issue would
//    copy it into every page and let two pages disagree about what "Todo"
//    means. It is document-level, and additive: a build that predates it
//    ignores `doc.fields` and still renders each prop block's `html`.
//
//  · EVERY PROP BLOCK CARRIES A READABLE `html`. That is what makes the format
//    degrade instead of vanish — an older build, a thumbnailer, a grep and a
//    markdown export all see "Status: In progress" without knowing what a field
//    is. Keeping it in step with `value` is this file's job.

import type { SpacesDoc, Page, Block } from './model'
// .ts extension: the model rig loads this file under node, whose resolver will
// not follow an extensionless import. Vite is unaffected — the same fix main
// already carries for i18n/packed.
import { t } from './i18n.ts'

/** What a field holds. Deliberately few: every one costs an editor and a
 *  permanent commitment, and a tracker needs exactly these. */
export type FieldType = 'select' | 'person' | 'number' | 'date' | 'text' | 'labels'

/**
 * What each type is called to somebody choosing one. Keys are the model's
 * words and never translated; the labels are English source strings that t()
 * looks up at render time — never here, where they would freeze at import.
 */
/**
 * What each type is called to somebody choosing one.
 *
 * A FUNCTION with literal t() calls, not a map of English read back through
 * `t(MAP[key])`. The extractor sweeps LITERALS, so the map version compiled,
 * ran, and put five of these six words in no catalog at all — measured: Select,
 * Number, Date, Person and Labels were absent from packed.ts while eight locales
 * reported 100%, because the packer counts what it swept. `t()` at call time,
 * never in a module-level const, which would freeze at import.
 */
export function fieldTypeLabel(vt: FieldType): string {
  switch (vt) {
    case 'select': return t('Select')
    case 'number': return t('Number')
    case 'date': return t('Date')
    case 'person': return t('Person')
    case 'labels': return t('Labels')
    default: return t('Text')
  }
}

/** The types a new field can be, in the order the picker offers them. */
export const FIELD_TYPES: FieldType[] = ['text', 'select', 'number', 'date', 'person', 'labels']

export interface FieldOption {
  id: string
  label: string
  color?: string
  /**
   * Which end of the board this sits at.
   *
   * Linear's insight, and the reason a board is useful rather than pretty: a
   * status is not just a name, it belongs to a PHASE. "Done" and "Cancelled"
   * are both finished; "In review" and "In progress" are both started. Grouping
   * by phase is what lets "show me what is open" mean something without anyone
   * configuring a filter.
   */
  group?: 'unstarted' | 'started' | 'done' | 'cancelled'
}

export interface FieldSpec {
  key: string
  label: string
  vt: FieldType
  options?: FieldOption[]
  /** shown on a new issue when nothing is chosen */
  def?: string
}

/**
 * The fields a fresh tracker starts with.
 *
 * Linear-shaped on purpose: Status, Assignee, Priority, Estimate, Labels,
 * Cycle, Project. Opinionated beats configurable here — a tracker you have to
 * design before you can use it is the thing everybody hates about the
 * alternatives, and every one of these is permanent, so the list is short.
 */
export const DEFAULT_FIELDS: FieldSpec[] = [
  {
    key: 'status', label: 'Status', vt: 'select', def: 'todo',
    options: [
      { id: 'backlog', label: 'Backlog', color: '#8B95A5', group: 'unstarted' },
      { id: 'todo', label: 'Todo', color: '#5B8DEF', group: 'unstarted' },
      { id: 'doing', label: 'In progress', color: '#F7A600', group: 'started' },
      { id: 'review', label: 'In review', color: '#A97BE0', group: 'started' },
      { id: 'done', label: 'Done', color: '#2FA37C', group: 'done' },
      { id: 'cancelled', label: 'Cancelled', color: '#98A2B3', group: 'cancelled' },
    ],
  },
  {
    key: 'priority', label: 'Priority', vt: 'select', def: 'none',
    options: [
      { id: 'urgent', label: 'Urgent', color: '#E5484D' },
      { id: 'high', label: 'High', color: '#F7A600' },
      { id: 'medium', label: 'Medium', color: '#5B8DEF' },
      { id: 'low', label: 'Low', color: '#8B95A5' },
      { id: 'none', label: 'No priority', color: '#C4CBD6' },
    ],
  },
  { key: 'assignee', label: 'Assignee', vt: 'person' },
  { key: 'estimate', label: 'Estimate', vt: 'number' },
  { key: 'labels', label: 'Labels', vt: 'labels' },
  { key: 'due', label: 'Due', vt: 'date' },
  { key: 'project', label: 'Project', vt: 'text' },
]

/**
 * The fields a NEW issue starts with.
 *
 * ONE list, because there are now two ways to make an issue — ⌘⇧I in the
 * editor and `bento.newIssue()` from an agent — and a field seeded by one but
 * not the other is a field a human then cannot set: `prop` is unlisted in the
 * / menu (blocks.ts), so the only way a value gets onto a page is that the page
 * was seeded with it. An agent-made issue missing `assignee` would be an issue
 * nobody can assign without hand-editing the JSON.
 *
 * The rest of the schema (labels, due, project) is set on demand and appears
 * when it is set — absent means unset, which is what the format already says.
 */
export const ISSUE_FIELDS = ['status', 'priority', 'assignee', 'estimate']

/** The schema in force: what the document declares, else the defaults. */
export function fieldsOf(doc: SpacesDoc): FieldSpec[] {
  const declared = (doc as { fields?: unknown }).fields
  return Array.isArray(declared) && declared.length ? (declared as FieldSpec[]) : DEFAULT_FIELDS
}

export const fieldByKey = (doc: SpacesDoc, key: string): FieldSpec | undefined =>
  fieldsOf(doc).find((f) => f.key === key)

export const optionOf = (f: FieldSpec | undefined, id: unknown): FieldOption | undefined =>
  f?.options?.find((o) => o.id === String(id))

/**
 * The readable form of a value — what goes in the block's `html`.
 *
 * Not decoration. This is the only thing an older build, a thumbnailer, a grep
 * or a markdown export can see, so it has to say what the field is as well as
 * what it holds.
 */
export function propHtml(f: FieldSpec, value: unknown): string {
  // COERCE, never assume. The schema comes out of a file someone sent you, so
  // `label` can be absent or a number — and this used to throw a TypeError
  // straight out of the public API (setField and newIssue), on exactly the
  // untrusted-file class the rest of the code is hardened against. A malformed
  // schema entry is something validate() reports; it is not something a write
  // verb should crash on. Falling back to the KEY keeps the readable form
  // readable, which is the whole job.
  const esc = (v: unknown) =>
    String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const label = typeof f?.label === 'string' && f.label ? f.label : String(f?.key ?? 'field')
  const shown =
    f.vt === 'select' ? (optionOf(f, value)?.label ?? String(value ?? ''))
      : f.vt === 'labels' ? (Array.isArray(value) ? value.join(', ') : String(value ?? ''))
        : String(value ?? '')
  return `${esc(label)}: ${esc(shown) || '—'}`
}

/** A page's field values, by key. Only `prop` blocks carry them. */
export function valuesOf(page: Page): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const b of page.blocks) {
    if (b.type !== 'prop') continue
    const key = (b as { key?: unknown }).key
    if (typeof key === 'string' && key) out.set(key, (b as { value?: unknown }).value)
  }
  return out
}

/**
 * Is this page an ISSUE?
 *
 * It carries a status. Not a flag on the page and not a separate page type:
 * making "issue" a mode would mean a page could be the wrong kind, and would
 * put a second concept in a format whose whole shape is "a page with blocks".
 * A page with a status is an issue; remove the status and it is a document
 * again, with everything else about it intact.
 */
export const isIssue = (page: Page): boolean =>
  page.blocks.some((b) => b.type === 'prop' && (b as { key?: unknown }).key === 'status')

/** Where a page's prop blocks stop and its body begins. */
export function headerLength(page: Page): number {
  let n = 0
  while (n < page.blocks.length && page.blocks[n].type === 'prop') n++
  return n
}

/**
 * What NARROWS a view. Stored on the `view` block, so it is permanent.
 *
 * ABSENT MEANS EVERYTHING, and so does an absent key inside it. That is not a
 * default, it is the compatibility rule: every view block written before
 * filters existed carries no `filter`, and must keep showing every issue
 * forever. The same rule makes the editor DELETE the key rather than store an
 * empty object, so a view someone filtered and then unfiltered is byte-identical
 * to one that was never filtered.
 *
 * Deliberately two keys. A filter language is a thing that grows without limit
 * and can never shrink — every operator here is in files on other people's
 * disks the moment it ships — so this is the smallest pair that answers the two
 * questions a tracker is actually asked: "show me this label" and "show me what
 * is still open".
 */
export interface ViewFilter {
  /**
   * field key → the values that pass. A value THIS BUILD DOES NOT KNOW is
   * compared literally, so a filter written by a newer build still selects the
   * issues it meant instead of matching nothing.
   */
  is?: Record<string, string[]>
  /** only issues whose phase is neither done nor cancelled */
  open?: boolean
}

/** Filter keys this build can evaluate. */
const FILTER_KEYS = new Set(['is', 'open'])

/**
 * Filter keys from a NEWER build.
 *
 * They round-trip untouched, but this build cannot apply them, so the view
 * shows MORE than it should — and a count that is silently too high is exactly
 * the failure the format's additivity rule trades for. The view says so out
 * loud instead.
 */
export const unknownFilterKeys = (f: unknown): string[] =>
  f && typeof f === 'object' ? Object.keys(f).filter((k) => !FILTER_KEYS.has(k)) : []

/**
 * The field whose options declare PHASES — the one "open" is a question about.
 *
 * DERIVED FROM THE SCHEMA, never hardcoded to `status`: a document that
 * declares its own fields names its own phase field, and one that declares none
 * has no notion of open at all, in which case `open` passes everything rather
 * than emptying the board.
 */
export const phaseField = (doc: SpacesDoc): FieldSpec | undefined =>
  fieldsOf(doc).find((f) => f.options?.some((o) => o.group))

/**
 * Is this value a phase that is still going?
 *
 * An UNKNOWN value counts as open. A newer build's status must never be hidden
 * by "open only" — hiding work because this build cannot read its status is a
 * silent loss, and showing one issue too many is not.
 */
export const isOpenPhase = (f: FieldSpec | undefined, value: unknown): boolean => {
  const g = optionOf(f, value)?.group
  return g !== 'done' && g !== 'cancelled'
}

/** Does one issue pass a view's filter? */
export function passesFilter(doc: SpacesDoc, values: Map<string, unknown>, filter: unknown): boolean {
  if (!filter || typeof filter !== 'object') return true
  const f = filter as ViewFilter
  if (f.open) {
    const pf = phaseField(doc)
    if (!isOpenPhase(pf, values.get(pf?.key ?? ''))) return false
  }
  const is = f.is
  if (is && typeof is === 'object') {
    for (const key of Object.keys(is)) {
      const want = is[key]
      // an empty list is NO CONSTRAINT, not "nothing passes" — a stored empty
      // would empty the board for a reason nobody could see
      if (!Array.isArray(want) || !want.length) continue
      const v = values.get(key)
      const mine = Array.isArray(v) ? v.map(String) : [String(v ?? '')]
      if (!want.some((w) => mine.includes(String(w)))) return false
    }
  }
  return true
}

/** How many things a filter narrows by — what the Filter button counts. */
export const filterCount = (filter: unknown): number => {
  const f = (filter ?? {}) as ViewFilter
  const is = f.is && typeof f.is === 'object' ? f.is : {}
  return (f.open ? 1 : 0) + Object.keys(is).filter((k) => (is[k] ?? []).length).length
}

/**
 * What ORDERS a view. Stored on the `view` block, so it is permanent.
 *
 * ABSENT MEANS MANUAL ORDER — the page order, which is the board's own order
 * and what every view written before this key carries. That is the
 * compatibility rule, not a preference: a stored sort must never appear on a
 * board somebody arranged by hand.
 *
 * AN ARRAY, though the editor only ever writes one entry. The shape was
 * published in the format sketch as a list, and a second key can be added later
 * without touching a file — where widening a scalar to an array afterwards
 * could not be done at all. One entry is what a board is actually asked for;
 * the array is what keeps the other answer available.
 */
export interface ViewSort {
  key: string
  /** absent = ascending, which is the direction a reader assumes */
  dir?: 'asc' | 'desc'
}

/** Sort keys this build can evaluate — a field the schema declares. */
export const unknownSortKeys = (doc: SpacesDoc, sort: unknown): string[] =>
  (Array.isArray(sort) ? sort : [])
    .map((s) => String((s as ViewSort)?.key ?? ''))
    .filter((k) => k && !fieldByKey(doc, k))

/**
 * One value's place in its field's order.
 *
 * A select sorts by its DECLARED position, never alphabetically: "Backlog,
 * Todo, In progress, Done" is a direction, and sorting it into "Backlog, Done,
 * In progress, Todo" throws away the one thing the list was telling you. A
 * number sorts numerically. Everything else compares as text.
 */
interface Rank { empty?: boolean; n?: number; s?: string }

function rank(f: FieldSpec | undefined, v: unknown): Rank {
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return { empty: true }
  if (f?.vt === 'select') {
    const at = f.options?.findIndex((o) => o.id === String(v)) ?? -1
    // a value from a NEWER build has no declared place. It sorts after
    // everything this build knows rather than at the top, because guessing it
    // belongs first is how a status nobody here can read ends up leading the
    // board.
    return { n: at < 0 ? Number.MAX_SAFE_INTEGER : at }
  }
  if (f?.vt === 'number') {
    const n = Number(v)
    return Number.isFinite(n) ? { n } : { s: String(v) }
  }
  return { s: Array.isArray(v) ? v.map(String).join(', ') : String(v) }
}

/**
 * Order rows by a view's `sort`. Returns the SAME array when there is nothing
 * to do, so an unsorted view keeps the page order it already had.
 *
 * AN UNSET VALUE IS ALWAYS LAST, in both directions. It is not the smallest
 * value, it is the absence of one — an issue with no estimate is not the
 * cheapest issue, and reversing the sort must not promote every blank to the
 * top of the board.
 */
export function sortRows(doc: SpacesDoc, rows: IssueRow[], sort: unknown): IssueRow[] {
  const keys: Array<{ f: FieldSpec; dir?: 'asc' | 'desc' }> = []
  for (const s of Array.isArray(sort) ? sort : []) {
    const f = fieldByKey(doc, String((s as ViewSort)?.key ?? ''))
    // a key this build does not know is skipped, never guessed at — the view
    // then shows the order it had, which is the honest fallback
    if (f) keys.push({ f, dir: (s as ViewSort)?.dir })
  }
  if (!keys.length) return rows

  // decorate-sort-undecorate: `rank` is called once per row per key rather than
  // once per comparison, which on a 500-issue board is the difference between
  // 500 lookups and ~4,500
  const decorated = rows.map((r, i) => ({ r, i, ranks: keys.map((k) => rank(k.f, r.values.get(k.f.key))) }))
  decorated.sort((a, bq) => {
    for (let j = 0; j < keys.length; j++) {
      const x = a.ranks[j], y = bq.ranks[j]
      if (x.empty || y.empty) {
        if (x.empty && y.empty) continue
        return x.empty ? 1 : -1
      }
      const d = x.n !== undefined && y.n !== undefined
        ? x.n - y.n
        : String(x.s ?? x.n).localeCompare(String(y.s ?? y.n), undefined, { numeric: true, sensitivity: 'base' })
      if (d) return keys[j].dir === 'desc' ? -d : d
    }
    // STABLE on ties: equal rows keep the page order, so a board sorted by
    // priority still reads in the order someone arranged it within each band.
    return a.i - bq.i
  })
  return decorated.map((d) => d.r)
}

export interface IssueRow {
  page: Page
  values: Map<string, unknown>
}

/** Every issue in the space, in page order, archived pages excluded. */
export function issuesOf(doc: SpacesDoc): IssueRow[] {
  const out: IssueRow[] = []
  for (const page of doc.pages) {
    if (page.archived || !isIssue(page)) continue
    out.push({ page, values: valuesOf(page) })
  }
  return out
}

/**
 * WHICH PAGES A VIEW IS ABOUT.
 *
 * A view used to mean one thing: every page carrying a `status`. That made the
 * tracker work and made everything else impossible — a space could hold a
 * backlog and never a reading list, because there was no way to say "the pages
 * with an Author" or "the pages under Books".
 *
 * ABSENT MEANS ISSUES, and that is the compatibility rule rather than a
 * default: every `view` block written before this existed carries no `source`
 * and must keep showing the backlog forever. The editor DELETES the key rather
 * than storing an empty object, so a view whose source was set and cleared is
 * byte-identical to one that never had it.
 *
 * Two selectors, and deliberately only two. `has` is the one that pairs with a
 * property somebody just invented — the vocabulary is flat and a page carries
 * only the fields it uses, so "has an Author" IS "is a book". `under` is the
 * one people reach for anyway, because nesting is how a space is already
 * organised. A selector language grows without limit and can never shrink:
 * every operator ships permanently into files on other people's disks.
 */
export interface ViewSource {
  /** pages carrying this field */
  has?: string
  /** pages nested anywhere under this page */
  under?: string
}

export const unknownSourceKeys = (src: unknown): string[] =>
  !src || typeof src !== 'object' ? []
    : Object.keys(src as Record<string, unknown>).filter((k) => k !== 'has' && k !== 'under')

/** Is this page anywhere below `root`? Cycle-safe, like the tree walk. */
function isUnder(doc: SpacesDoc, page: Page, root: string): boolean {
  const seen = new Set<string>()
  let cur: string | undefined = page.parent
  while (cur && !seen.has(cur)) {
    if (cur === root) return true
    seen.add(cur)
    cur = doc.pages.find((p) => p.id === cur)?.parent
  }
  return false
}

/**
 * The rows a view holds.
 *
 * Derived every render from the pages themselves — never stored — for the same
 * reason the board's order is `doc.pages`: a database that keeps its own copy
 * of the rows is a database that disagrees with the document.
 */
export function viewRows(doc: SpacesDoc, source?: unknown): IssueRow[] {
  const src = (source && typeof source === 'object' ? source : {}) as ViewSource
  const has = typeof src.has === 'string' ? src.has : ''
  const under = typeof src.under === 'string' ? src.under : ''
  if (!has && !under) return issuesOf(doc)

  const out: IssueRow[] = []
  for (const page of doc.pages) {
    if (page.archived) continue
    if (under && !isUnder(doc, page, under)) continue
    const values = valuesOf(page)
    if (has && !values.has(has)) continue
    out.push({ page, values })
  }
  return out
}

/** Where a dropped card lands: before a card, or after the last one. */
export interface DropAim { before?: string; after?: string }

/**
 * The page order after a card is dropped — or NULL when the drop changes
 * nothing.
 *
 * THE BOARD'S ORDER IS `doc.pages`. There is no per-view order field, and there
 * must not be one invented by a drag handler: a stored order is permanent, it
 * has to answer what happens to an issue no view has ever seen, and it can
 * disagree with the pages themselves. Reordering the pages cannot.
 *
 * Pure, and separate from the editor, because this is the arithmetic that is
 * easy to get wrong: the anchor is a page ID rather than an index precisely
 * because the index moves under the splice that removes the dragged page. The
 * null return is what keeps a drag that went nowhere out of the undo stack.
 */
export function reorderPages(pages: Page[], pageId: string, aim: DropAim): Page[] | null {
  const from = pages.findIndex((p) => p.id === pageId)
  const anchor = aim.before ?? aim.after
  if (from < 0 || !anchor) return null
  // already exactly there
  if (aim.before ? pages[from + 1]?.id === aim.before : pages[from - 1]?.id === aim.after) return null
  const next = pages.slice()
  const [moved] = next.splice(from, 1)
  // The anchor is looked up AFTER the removal, so the index is the one the
  // insert needs. It also covers dropping a card on itself: the anchor is the
  // page just removed, so it is not found and nothing moves.
  const at = next.findIndex((p) => p.id === anchor)
  if (at < 0) return null
  next.splice(aim.before ? at : at + 1, 0, moved)
  return next
}

/** One page's value block for a field, if it has one. */
export const propBlockOf = (page: Page, key: string): Block | undefined =>
  page.blocks.find((b) => b.type === 'prop' && (b as { key?: unknown }).key === key)

/** Build a prop block, with its readable form already in step. */
/**
 * The document's field vocabulary with one more field in it.
 *
 * SEEDS FROM THE DEFAULTS ON FIRST WRITE, and that is the whole reason this is
 * a function rather than a push. `fieldsOf` falls back to DEFAULT_FIELDS only
 * while `doc.fields` is absent or empty — so a document that has never declared
 * a schema and then gains ONE field would, if the field were simply pushed into
 * an empty array, lose Status, Priority, Assignee and Estimate in the same
 * stroke. Every issue in the space would keep its `prop` blocks (they carry
 * their own readable html) but the board grouping them by status would have no
 * status field to group by.
 *
 * So the first custom field writes the defaults down beside itself, which is
 * also the honest thing: once you have edited the schema it stops being
 * implicit.
 */
export function withField(doc: SpacesDoc, spec: FieldSpec): FieldSpec[] {
  const current = fieldsOf(doc)
  if (current.some((f) => f.key === spec.key)) {
    return current.map((f) => (f.key === spec.key ? spec : f))
  }
  return [...current, spec]
}

/**
 * A key for a field somebody just named.
 *
 * Keys are what `prop` blocks store and what views group by, so they outlive
 * every rename of the label and must never collide. Derived from the label,
 * then suffixed until it is free.
 */
export function freeFieldKey(doc: SpacesDoc, label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'field'
  const taken = new Set(fieldsOf(doc).map((f) => f.key))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

export function propBlock(f: FieldSpec, value: unknown, id: string): Block {
  return { id, type: 'prop', key: f.key, value, html: propHtml(f, value) } as Block
}

/**
 * Would this drop change the order the user can actually SEE?
 *
 * `reorderPages` compares adjacency in `doc.pages`, and page order is not
 * column order: a board with two columns interleaves them, so a card dropped
 * back into its own slot is NOT adjacent to itself in the page array. Measured:
 * pages [board,i1,i2,i3,i4,i5] with i1,i3,i5 in one column — dropping i1 where
 * it already sat returned a reordered array, so a gesture that visibly did
 * nothing wrote to the document, took an undo entry, set the dirty flag, and
 * visibly reshuffled the SIDEBAR, because board order is sidebar order.
 *
 * The rig missed it because its fixture had one column, which is the only
 * shape where the two orders coincide.
 *
 * `cards` is the column's card ids in the order they are drawn, INCLUDING the
 * dragged one. The answer is about the column, because the column is the only
 * order the gesture was about.
 */
export function columnMoves(cards: string[], moved: string, aim: DropAim): boolean {
  const at = cards.indexOf(moved)
  if (at < 0) return true                       // it is arriving from elsewhere
  const rest = cards.filter((id) => id !== moved)
  const target = aim.before
    ? rest.indexOf(aim.before)
    : aim.after ? rest.indexOf(aim.after) + 1 : rest.length
  if (target < 0) return true
  const next = [...rest.slice(0, target), moved, ...rest.slice(target)]
  return next.join('\u001f') !== cards.join('\u001f')
}

/**
 * Which direction a view is sorted in BY THIS FIELD, if it is.
 *
 * Reads the same `sort` the format already carries — there is no second place
 * a table header's arrow could come from, and inventing one would let the arrow
 * and the order disagree. `undefined` means this column is not the sort key;
 * an entry with no `dir` is ascending, which is what absence has always meant.
 */
export const sortDirOf = (sort: unknown, key: string): 'asc' | 'desc' | undefined => {
  const cur = (Array.isArray(sort) ? sort : [])[0] as ViewSort | undefined
  if (!cur || String(cur.key ?? '') !== key) return undefined
  return cur.dir === 'desc' ? 'desc' : 'asc'
}

/**
 * The sort a CLICK ON A COLUMN HEADER produces: ascending → descending → none.
 *
 * The third state is the one that matters. A header that only flips between two
 * directions can never give a hand-arranged board its order back, and "manual
 * order" is not a sort called manual — it is the ABSENCE of the key. So this
 * returns `undefined` there, and the caller deletes the key rather than storing
 * an empty array: a view sorted and unsorted is byte-identical to one nobody
 * ever touched.
 */
export function cycleSort(sort: unknown, key: string): ViewSort[] | undefined {
  const dir = sortDirOf(sort, key)
  if (dir === undefined) return [{ key }]
  if (dir === 'asc') return [{ key, dir: 'desc' }]
  return undefined
}

/**
 * THE SHAPES A VIEW CAN TAKE, and the order the one button cycles them in.
 *
 * Written down ONCE. It used to live twice — a `NEXT` map in render.ts for the
 * button's label and a `next` map in editor.ts for what the click stores — and
 * the two drifted the way two copies of one fact always do. When the
 * prototype-lookup bug below was found, the fix was applied to the editor's
 * copy and not the renderer's, and the editor's comment then asserted the whole
 * thing was safe while the label it named was still being rendered from the
 * unguarded copy.
 *
 * `board` is the ABSENT key, never a stored 'board': a view cycled all the way
 * round is byte-identical to one nobody ever touched, which is the rule filter
 * and source already follow. `nextLayout` returns the word; the caller that
 * WRITES is the one that turns 'board' back into a deletion.
 */
export const VIEW_LAYOUTS = ['board', 'list', 'table', 'gallery'] as const
export type ViewLayout = (typeof VIEW_LAYOUTS)[number]

/**
 * The layout a view is ACTUALLY in, whatever its block claims.
 *
 * `Object.hasOwn`, never a truthiness test or a bare `in`: a view block is
 * plain JSON in a file someone sent you, and `LAYOUT['toString']` on an object
 * literal is a native function — truthy, and stringifying to
 * `function toString() { [native code] }`, which is what the layout button
 * rendered as its own label. A key from a NEWER build lands on `board` rather
 * than nowhere, so the control is never a button that does nothing.
 */
export function layoutOf(raw: unknown): ViewLayout {
  const s = String(raw ?? 'board')
  return (VIEW_LAYOUTS as readonly string[]).includes(s) ? (s as ViewLayout) : 'board'
}

/** The next shape in the cycle: board → list → table → gallery → board. */
export function nextLayout(raw: unknown): ViewLayout {
  const here = layoutOf(raw)
  return VIEW_LAYOUTS[(VIEW_LAYOUTS.indexOf(here) + 1) % VIEW_LAYOUTS.length]
}
