// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// RELATIONS and ROLLUPS: a field whose value is another PAGE, and a field
// derived from one.
//
// This is the single thing that separated these bases from a database. Every
// other field type answers with a word somebody typed; a relation answers with
// a page — the Author field that IS the person's page, the Project field that
// IS the project. Once a field can point at a page, a second kind becomes
// possible and necessary: a ROLLUP, which is the answer to "how many", "how
// much" and "which ones" about the pages on the other end.
//
// ── THE TWO STORAGE RULES, and they are opposite on purpose ────────────────
//
//  · A RELATION IS STORED. It is data somebody entered — the ids of the pages
//    they picked — and it lives in a `prop` block like every other field
//    value, for the reasons fields.ts spells out: blocks are what search,
//    find-and-replace, undo, the preview and the Markdown export iterate, and
//    under collaboration each block property is its own last-writer-wins
//    register.
//
//  · A ROLLUP IS NEVER STORED. It is derived at read time, every paint, from
//    the relation and the linked pages — the same rule calc.ts follows for
//    magic notes and slides follows for dynamic fields, and it buys the same
//    thing: change a linked page's estimate and every rollup of it re-answers,
//    because nothing downstream was frozen. A stored rollup is a cache with no
//    invalidation, in a format with no server to migrate it, in a file that
//    gets mailed around and edited by builds that have never heard of it.
//
//    The consequence is stated rather than hidden: a rollup has NO `prop`
//    block, so a build that predates this renders nothing for it. That is
//    correct. There is nothing in the file to render — the derivation IS the
//    value — and the alternative is writing a number into a file that will be
//    wrong the moment anybody edits anything.
//
// ── DEGRADATION: what an older build sees ──────────────────────────────────
//
// A relation's `html` is the readable form every prop block carries, and here
// it is a real LINK: `Author: <a href="#p/p7">Ada Lovelace</a>`. A build that
// has never heard of `vt: 'relation'` renders that html — so the value is not
// only visible, it is CLICKABLE, it exports as correct Markdown, and it is
// found by grep. The stored `value` (the page ids) round-trips untouched
// beside it under the format's additivity rule.
//
// A title inside that html can drift when the target page is renamed by a
// build that does not resync it. That is NOT an error and validate() does not
// report it as one: the IDS are the value, the titles are a rendering, and the
// renderer draws live titles from the document every paint.
//
// ── UNTRUSTED IDS ──────────────────────────────────────────────────────────
//
// Every id here comes out of a file someone mailed you. Page lookup goes
// through a `Map`, which has no prototype entries to answer with — a plain
// object keyed on document data answers `__proto__`, `toString` and
// `constructor` with something that is not a page, and that exact bug has
// shipped twice in this app (fields.ts layoutOf, graph.ts icon). Where a plain
// object IS the right shape, the lookup is `Object.hasOwn`, never a bare `in`
// and never a truthiness test. A relation naming a page that does not exist is
// REPORTED by validate() and rendered as missing; it never throws.

import type { SpacesDoc, Page } from './model.ts'
// `.ts` extensions ON PURPOSE: node resolves these modules directly for the rig.
import { type FieldSpec, fieldByKey, fieldsOf, optionOf, propHtml, valuesOf } from './fields.ts'
import { esc, escText } from './sanitize.ts'
import { t } from './i18n.ts'

// IMPORT DIRECTION IS ONE-WAY: relations.ts → fields.ts, never back. fields.ts
// could have grown a doc-aware propHtml instead, but that needs the document to
// resolve a title, and a cycle between the two modules would make the order
// they are first imported in load-bearing. `propHtmlOf` below is the one
// wrapper the writers call; fields.ts stays a pure function of a spec and a
// value.

// ---------------------------------------------------------------------------
// relation values
// ---------------------------------------------------------------------------

/**
 * The page ids a relation value names.
 *
 * TOLERANT IN, CANONICAL OUT. The stored shape is an array of ids, but a
 * hand-written file, an older importer or an agent can perfectly reasonably
 * write one bare string — and a relation that silently held nothing because
 * the value was not wrapped in brackets is a value that vanished. Non-strings
 * are dropped, blanks are dropped, duplicates collapse (a page related to the
 * same page twice is related to it once), and ORDER IS KEPT because the order
 * someone picked them in is the order they should read in.
 */
export function relationIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value]
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const id = v.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * What gets STORED for a set of ids.
 *
 * An empty relation is `''`, not `[]`, and that is the format's rule rather
 * than a preference: `''` is what every other field type in this app means by
 * unset, it is what `valuesOf`/`passesFilter`/`sortRows` already treat as
 * empty, and it is what `def ?? ''` seeds a fresh prop block with. Storing
 * `[]` would make "cleared" and "never set" two different bytes for one state.
 */
export const relationValue = (ids: readonly string[]): string[] | '' => {
  const clean = relationIds(ids as unknown[])
  return clean.length ? clean : ''
}

/** Is this field one that points at pages? */
export const isRelation = (f: FieldSpec | undefined): boolean => f?.vt === 'relation'

/** One end of a relation. `page` absent = the id names nothing in this space. */
export interface RelationTarget {
  id: string
  page?: Page
}

/**
 * The pages a relation value points at, dangling ids INCLUDED.
 *
 * Dangling entries are returned rather than filtered out because dropping them
 * here is how a broken reference becomes invisible: the renderer shows it as
 * missing, validate() reports it, and portable.ts turns it into honest text.
 * Silently shortening the list would leave a page that says "two authors" and
 * shows one.
 */
export function resolveRelation(doc: SpacesDoc, value: unknown): RelationTarget[] {
  const ids = relationIds(value)
  if (!ids.length) return []
  const byId = pageMap(doc)
  return ids.map((id) => {
    const page = byId.get(id)
    return page ? { id, page } : { id }
  })
}

/**
 * page id → page, as a `Map`.
 *
 * A Map and not an object literal: `target` is document data, and an object
 * answers `__proto__` and `toString` with something that is not a page. Built
 * per call — these run at paint time over documents of a few hundred pages, and
 * a cached index would be one more thing that goes stale the moment an agent
 * edits #bento-doc (model.ts says the same about SpaceIndex).
 */
const pageMap = (doc: SpacesDoc): Map<string, Page> =>
  new Map((Array.isArray(doc.pages) ? doc.pages : []).map((p) => [p.id, p]))

/** What a page is CALLED in a relation. Never empty — an untitled page still
 *  has to be something you can see and click. */
export const targetTitle = (t0: RelationTarget): string =>
  t0.page ? (t0.page.title || 'Untitled') : t0.id

/**
 * A relation's readable html: real links, escaped.
 *
 * A DANGLING id is NOT written as a link. A link to a page that is not in the
 * file renders and does nothing when clicked, which is the failure portable.ts
 * already refuses for prose links — so it degrades to the same literal
 * `[[name]]` shape that file uses, which is honest, searchable and re-resolves
 * if the two halves are brought back together.
 */
export function relationLinks(targets: readonly RelationTarget[]): string {
  return targets.map((tt) =>
    tt.page
      ? `<a href="#p/${esc(tt.id)}">${escText(targetTitle(tt))}</a>`
      : `[[${escText(tt.id)}]]`).join(', ')
}

/** The same, resolved against a document. Split from `relationLinks` because
 *  portable.ts rebuilds this html for pages that are MOVING and whose new ids
 *  are not in any document yet — it has the targets and no doc to look them
 *  up in. */
export function relationHtml(doc: SpacesDoc, value: unknown): string {
  return relationLinks(resolveRelation(doc, value))
}

/**
 * THE READABLE FORM OF ANY FIELD VALUE, with the document in hand.
 *
 * `fields.ts propHtml` is a pure function of a spec and a value and stays that
 * way; this is the one wrapper the WRITERS call, so `value` and `html` still
 * move together through a single place. Everything that is not a relation is
 * handed straight to propHtml, unchanged.
 */
export function propHtmlOf(doc: SpacesDoc, f: FieldSpec, value: unknown): string {
  if (f?.vt !== 'relation') return propHtml(f, value)
  const label = typeof f?.label === 'string' && f.label ? f.label : String(f?.key ?? 'field')
  return `${escText(label)}: ${relationHtml(doc, value) || '—'}`
}

/**
 * A value as PLAIN TEXT — no markup, no label.
 *
 * What a rollup's `list` joins, what a table cell shows, and what a board chip
 * reads. Mirrors propHtml's choices exactly (an option's label rather than its
 * id, labels joined) so the same value never reads two ways in one document.
 */
export function valueTextOf(doc: SpacesDoc, f: FieldSpec | undefined, value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (f?.vt === 'relation') return resolveRelation(doc, value).map(targetTitle).join(', ')
  if (f?.vt === 'select') return optionOf(f, value)?.label ?? String(value)
  if (f?.vt === 'labels') return Array.isArray(value) ? value.join(', ') : String(value)
  return Array.isArray(value) ? value.map(String).join(', ') : String(value)
}

// ---------------------------------------------------------------------------
// rollups
// ---------------------------------------------------------------------------

/**
 * The answers a rollup can give. Deliberately five, and the list is permanent:
 * every entry here ships into files on other people's disks the moment it
 * exists, and an aggregate that turns out to be wrong can never be withdrawn.
 * These are the five a tracker is actually asked for.
 */
export const ROLLUP_FNS = ['count', 'sum', 'min', 'max', 'list'] as const
export type RollupFn = (typeof ROLLUP_FNS)[number]

/**
 * What each answer is CALLED to somebody choosing one.
 *
 * A FUNCTION with literal `t()` calls, never a map read back through
 * `t(MAP[key])` — fields.ts carries the measurement: the map form compiles,
 * runs, reaches no catalog, and the packer still reports 100% because it counts
 * what it swept. And never at module level, where it would freeze at import.
 */
export function rollupFnLabel(fn: RollupFn): string {
  switch (fn) {
    case 'sum': return t('the total')
    case 'min': return t('the smallest')
    case 'max': return t('the largest')
    case 'list': return t('a list')
    default: return t('a count')
  }
}

/**
 * How deep a rollup chain is followed.
 *
 * A CAP AS WELL AS the cycle check, not instead of it — the same pairing
 * embed.ts settled for transclusion, and for the same reason. The cycle check
 * catches A→B→A exactly; the cap catches the shape it cannot see, a hundred
 * distinct pages each rolling up the next, which is not a cycle and would still
 * walk the whole space to answer one chip.
 */
export const ROLLUP_MAX_DEPTH = 4

/**
 * What a rollup field declares.
 *
 * ON THE SCHEMA, not on the page. A rollup is a definition — "Total estimate is
 * the sum of Estimate over Tasks" — and a definition copied onto every page is
 * a definition two pages can disagree about, which is the argument fields.ts
 * already makes for the schema as a whole.
 */
export interface RollupSpec {
  /** the RELATION field to follow */
  via: string
  /** the field to read on each linked page; absent = the page itself (its title) */
  of?: string
  /** absent = 'count', which is the answer that needs no `of` */
  fn?: RollupFn
}

/** `fn` as a word this build can act on. Anything else is `count` — the one
 *  answer that is always meaningful — never a crash and never nothing. */
export const rollupFn = (raw: unknown): RollupFn => {
  const s = String(raw ?? 'count')
  return (ROLLUP_FNS as readonly string[]).includes(s) ? (s as RollupFn) : 'count'
}

/**
 * A field's rollup declaration, or undefined when it does not have a usable
 * one.
 *
 * `Object.hasOwn`, never a bare `in` and never truthiness: `f.rollup` comes out
 * of a document, so it can be a string, an array, or an object whose `via` is
 * inherited from `Object.prototype`. A malformed declaration is something
 * validate() reports; here it simply is not a rollup.
 */
export function rollupOf(f: FieldSpec | undefined): RollupSpec | undefined {
  if (f?.vt !== 'rollup') return undefined
  const raw = (f as { rollup?: unknown }).rollup
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const via = Object.hasOwn(o, 'via') && typeof o.via === 'string' ? o.via.trim() : ''
  if (!via) return undefined
  const of = Object.hasOwn(o, 'of') && typeof o.of === 'string' ? o.of.trim() : ''
  const fn = rollupFn(Object.hasOwn(o, 'fn') ? o.fn : undefined)
  return { via, ...(of ? { of } : {}), ...(fn === 'count' ? {} : { fn }) }
}

/** Every rollup field the schema declares, in its declared order. */
export const rollupFields = (doc: SpacesDoc): FieldSpec[] =>
  fieldsOf(doc).filter((f) => rollupOf(f) !== undefined)

/** Why a rollup has no answer. Each one is a different thing to say. */
export type RollupProblem = 'no-spec' | 'no-relation' | 'no-values' | 'cycle' | 'depth'

export interface RollupResult {
  ok: boolean
  why?: RollupProblem
  /** what the chip shows. Never empty — an em dash where there is no answer. */
  text: string
  /** the number, when the answer IS one (count/sum/min/max) */
  n?: number
  /** how many linked pages were counted over */
  from: number
  /** ids that named no page in this space */
  dangling: string[]
}

const EMPTY = '—'
/** What a rollup that depends on itself shows. A loop, not a number and not a
 *  blank: a blank reads as "no data", and the one thing this must not do is
 *  look like an answer. */
const LOOP = '↺'

/**
 * At most nine decimals, without float noise.
 *
 * `0.1 + 0.2` is 0.30000000000000004, and a chip that says that about somebody's
 * budget is a chip nobody trusts again. Rounding at the ninth place is well
 * inside double precision for any figure a note carries and well outside
 * anything a reader would notice.
 */
export const rollupNumber = (n: number): string =>
  Number.isFinite(n) ? String(Math.round(n * 1e9) / 1e9) : ''

/**
 * WHAT A ROLLUP ANSWERS, derived from the document every time it is asked.
 *
 * `chain` is the (page, field) pairs currently being computed, and it is the
 * cycle guard and the depth guard at once. A PARAMETER rather than module
 * state, for the reason embed.ts gives about `viewEmbed`: two surfaces render
 * at the same time (the editor canvas and the still preview) and a shared
 * counter between them is a race that only shows up in a saved thumbnail.
 *
 * WHAT A CYCLE RENDERS is `↺`, and that is a decision rather than a fallback.
 * A rollup of A that reaches back to A has no value — not zero, not blank, not
 * the partial sum computed so far. Zero and blank both read as data and would
 * quietly become the number in somebody's total; the loop glyph reads as "this
 * question does not have an answer", which is the truth. validate() reports it
 * with the two field keys so it can be fixed.
 */
export function rollupValue(
  doc: SpacesDoc,
  page: Page,
  f: FieldSpec,
  chain: readonly string[] = [],
): RollupResult {
  const none = (why: RollupProblem, text = EMPTY): RollupResult =>
    ({ ok: false, why, text, from: 0, dangling: [] })

  const spec = rollupOf(f)
  if (!spec) return none('no-spec')

  // U+001F between the two halves, written as an ESCAPE rather than as a
  // literal control character (markdown.ts carries literal invisible chars and
  // they do not survive being retyped). A page id and a field key are both
  // author-supplied strings, so joining them plainly would make ("p1a","b") and
  // ("p1","ab") one chain entry - a false cycle that blanks a working rollup.
  const me = `${page.id}\u001f${f.key}`
  if (chain.includes(me)) return none('cycle', LOOP)
  if (chain.length >= ROLLUP_MAX_DEPTH) return none('depth', LOOP)

  const rel = fieldByKey(doc, spec.via)
  if (!isRelation(rel)) return none('no-relation')

  const targets = resolveRelation(doc, valuesOf(page).get(spec.via))
  const dangling = targets.filter((t0) => !t0.page).map((t0) => t0.id)
  const live = targets.filter((t0): t0 is Required<RelationTarget> => !!t0.page)
  const next = [...chain, me]
  const fn = rollupFn(spec.fn)
  const of = spec.of ? fieldByKey(doc, spec.of) : undefined

  /**
   * One linked page's contribution: its text, its number where it has one, and
   * whether working it out ran into a loop.
   *
   * A LOOP PROPAGATES OUTWARD. This was measured getting it wrong: with the
   * recursion returning only text, an A→B→A pair reported `no-values` at the
   * top — an em dash, indistinguishable from "none of these pages has an
   * estimate". The cycle was caught, correctly, three frames down, and then
   * thrown away by the caller. A total that includes a term nobody can work out
   * is not a total; it is the same unanswerable question one level up, and it
   * has to say so.
   */
  const readOne = (p: Page): { text: string; n?: number; why?: RollupProblem } => {
    // NO `of` MEANS THE PAGE ITSELF. "How many tasks" and "which tasks" are the
    // two questions that need no second field, and making `of` mandatory would
    // force every count to name a field it does not use.
    if (!spec.of) return { text: p.title || 'Untitled' }
    // A ROLLUP OF A ROLLUP is the whole reason `chain` exists. It recurses with
    // this pair already on the chain, so A→B→A stops here rather than in the
    // stack trace.
    if (of?.vt === 'rollup') {
      const r = rollupValue(doc, p, of, next)
      return {
        text: r.text === EMPTY ? '' : r.text,
        ...(r.n !== undefined ? { n: r.n } : {}),
        ...(r.why === 'cycle' || r.why === 'depth' ? { why: r.why } : {}),
      }
    }
    const v = valuesOf(p).get(spec.of)
    const text = valueTextOf(doc, of, v)
    // NUMBERS COME FROM THE VALUE, not from its text. A select's label can read
    // "3 points" and mean the option `p3`; summing what it looks like rather
    // than what it is would invent a total out of a rendering.
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
    return { text, ...(Number.isFinite(n) ? { n } : {}) }
  }

  const parts = live.map((tt) => readOne(tt.page))
  const from = live.length
  const loop = parts.find((p) => p.why)?.why
  if (loop) return { ok: false, why: loop, text: LOOP, from, dangling }
  const nums = parts.map((p) => p.n).filter((n): n is number => n !== undefined)

  if (fn === 'list') {
    const shown = parts.map((p) => p.text).filter((s) => s !== '')
    return shown.length
      ? { ok: true, text: shown.join(', '), from, dangling }
      : { ok: false, why: 'no-values', text: EMPTY, from, dangling }
  }
  if (fn === 'count') {
    // WITH an `of`, count is "how many of them have one" — the question a
    // tracker is actually asked ("how many tasks have an estimate"). Without
    // one it is "how many are there at all".
    const n = spec.of ? parts.filter((p) => p.text !== '').length : from
    return { ok: true, n, text: String(n), from, dangling }
  }
  if (!nums.length) return { ok: false, why: 'no-values', text: EMPTY, from, dangling }
  const n = fn === 'sum' ? nums.reduce((a, b) => a + b, 0)
    : fn === 'min' ? Math.min(...nums)
      : Math.max(...nums)
  return { ok: true, n, text: rollupNumber(n), from, dangling }
}

/**
 * The rollup fields a PAGE actually shows.
 *
 * A rollup belongs to a page when that page carries the relation it follows —
 * the same rule the table already uses for columns, and the reason a space
 * holding a reading list and a backlog at once does not put "Total estimate" on
 * a book. Carrying the relation is enough; an EMPTY relation still shows its
 * rollup, because "0 tasks" is an answer and a chip that disappears when the
 * count reaches zero is a chip you cannot trust.
 */
export function rollupsFor(doc: SpacesDoc, page: Page): FieldSpec[] {
  const values = valuesOf(page)
  return rollupFields(doc).filter((f) => {
    const spec = rollupOf(f)
    return !!spec && values.has(spec.via)
  })
}

// ---------------------------------------------------------------------------
// the index, portability and validation all ask the same question
// ---------------------------------------------------------------------------

/**
 * The page ids one BLOCK references through a relation field.
 *
 * THE ONE PREDICATE, for the reason embed.ts gives about `isPageRef`: the
 * alternative is `b.type === 'prop' && schema says relation && normalize the
 * value` written out in four files, three of which would quietly stop agreeing.
 * The backlink index, the graph, extract, graft and validate all ask here.
 *
 * A prop block whose key names NO declared relation returns nothing — including
 * one written by a newer build. That is deliberate and it is what keeps the
 * backlink index from double-counting: model.ts falls back to scanning the
 * block's `html` for such a block, and the html of a relation is links, so a
 * block scanned both ways would report every reference twice.
 */
export function relationRefs(doc: SpacesDoc, b: { type?: string; key?: unknown; value?: unknown }): string[] {
  if (b?.type !== 'prop') return []
  const key = typeof b.key === 'string' ? b.key : ''
  if (!key) return []
  return isRelation(fieldByKey(doc, key)) ? relationIds(b.value) : []
}

/**
 * Rewrite a relation value's ids, for a page that is MOVING between spaces.
 *
 * `map` answers with the id the reference should carry now, or null to drop it
 * — the same two answers portable.ts's `relink` gives a prose link, because a
 * relation IS a page reference and the two must not disagree about what
 * happens to one that did not travel. Returns null when nothing changed, so an
 * untouched value is left byte-identical rather than rewritten to an equal one.
 */
export function remapRelation(
  value: unknown,
  map: (id: string) => string | null,
): { value: string[] | ''; changed: number; cut: number } | null {
  const ids = relationIds(value)
  if (!ids.length) return null
  const out: string[] = []
  let changed = 0
  let cut = 0
  for (const id of ids) {
    const next = map(id)
    if (next === null) { cut++; continue }
    if (next !== id) changed++
    out.push(next)
  }
  if (!changed && !cut) return null
  return { value: relationValue(out), changed, cut }
}
