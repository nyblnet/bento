// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Page templates: a page you keep so that new pages can start as a copy of it.
//
// WHERE THEY LIVE, AND WHY NOT AS PAGES. The obvious design is a page carrying
// a `template: true` flag, hidden from the sidebar — it costs no new format
// shape and a template is then editable with the page editor for free. It was
// measured and rejected. `doc.pages` is enumerated in forty-odd places across
// this app: search, the graph, backlinks (`buildIndex`), `issuesOf` and every
// board/table view in fields.ts, the Markdown export in portable.ts, the About
// counts, the agent API's `pages`/`stats`/`outline`, the archive list, the
// print sheet, and the file-manager preview. Every one of them would need a
// gate, and — this is the part that decides it — every surface added AFTERWARDS
// would need to remember. This zone has already shipped that class of bug twice
// (an allow-list applied before an indirection; a source-grep assertion that
// passed through a live regression). A separate collection cannot be forgotten
// by a surface that does not know it exists.
//
// So: `doc.templates` is an array of template records, and `doc.journalTemplate`
// names the one new daily notes start from. Both are ADDITIVE (PLATFORM §3):
// absent on every file written before this, an older build round-trips them
// untouched, and clearing a setting DELETES the key rather than storing a
// default.
//
// WHAT THAT COSTS, stated rather than hidden. A template is not a page, so it
// is not searched, not in the graph, not back-linked, not printed, and not in
// the Markdown export — `extractSpace` walks pages. Grafting a subtree from
// another space (portable.ts) brings its pages and brings no templates. That is
// the honest trade: `doc.templates` is document data that travels with the FILE
// and not with a subtree. A page-flag design would have grafted, and would have
// leaked into all thirteen surfaces above.
//
// TOKENS EXPAND ONCE, AT INSTANTIATION. bento/slides resolves `{{date}}` at
// RENDER time because a slide's footer must re-number when slides move. A
// template has no such need: the moment you make the page is the moment the
// date is decided, and a live field would mean a page whose text changed under
// the author tomorrow. So this is a one-time string substitution and the model
// stores the RESULT — no field system, no render-time cost, and the new page is
// an ordinary page that an older build reads exactly as this one does.

import { type Block, type Page, type SpacesDoc, uid } from './model.ts'
import { sanitizeInline } from './sanitize.ts'
import { isISO, journalLabel, journalShort, stepDay, todayISO } from './journal.ts'

/**
 * A saved page shape.
 *
 * DELIBERATELY NOT A `Page`. A template has no `parent` (where a new page goes
 * is the caller's decision), no `journal` (the date is the entry's, never the
 * template's), no `archived`/`journalHome`, and above all no `comments` — a
 * review thread is about one page at one moment and copying it into every page
 * made from the template afterwards would be a small horror.
 *
 * `title` may carry tokens, which is the whole reason it is separate from
 * `name`: the name is what you pick it by in the menu, the title is what the
 * new page is called.
 */
export interface PageTemplate {
  id: string
  /** what it is called in the picker — never token-expanded */
  name: string
  /** the new page's title; may carry tokens. Absent ⇒ the name */
  title?: string
  icon?: string
  cover?: string
  width?: 'wide' | 'full'
  blocks: Block[]
  created?: string
  /** additivity: a field a later build adds survives a round trip */
  [extra: string]: unknown
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * The templates in a document, tolerant of anything.
 *
 * `doc.templates` comes out of a file somebody mailed you: it may be absent, a
 * number, an array of nulls, or an array of records missing an id. Every one of
 * those must yield an empty list or a shorter one, never a throw at boot and
 * never an entry the rest of the app then has to defend against.
 */
export function templatesOf(doc: SpacesDoc): PageTemplate[] {
  const raw = (doc as { templates?: unknown }).templates
  if (!Array.isArray(raw)) return []
  const out: PageTemplate[] = []
  for (const t of raw) {
    if (!isObj(t)) continue
    if (typeof t.id !== 'string' || !t.id) continue
    out.push({
      ...t,
      id: t.id,
      name: typeof t.name === 'string' && t.name ? t.name : t.id,
      blocks: Array.isArray(t.blocks) ? (t.blocks.filter(isObj) as Block[]) : [],
    } as PageTemplate)
  }
  return out
}

/**
 * One template by id.
 *
 * A LIST SCAN, not a map lookup, and that is on purpose: the id comes out of
 * the document (`doc.journalTemplate`, or a menu built from a mailed file), and
 * an object keyed by document-supplied strings is how `constructor` and
 * `__proto__` become "yes, that template exists". This app has shipped that bug
 * twice. Where a record IS the right shape — the token formats below — the
 * lookup is guarded with `Object.hasOwn`.
 */
export function templateById(doc: SpacesDoc, id: string | undefined): PageTemplate | undefined {
  if (typeof id !== 'string' || !id) return undefined
  return templatesOf(doc).find((t) => t.id === id)
}

/** The template new daily notes start from, if the document names a real one. */
export function journalTemplate(doc: SpacesDoc): PageTemplate | undefined {
  return templateById(doc, (doc as { journalTemplate?: unknown }).journalTemplate as string | undefined)
}

/**
 * Capture a page as a template.
 *
 * Deep-copied through JSON so that editing the page afterwards cannot reach
 * back into the saved shape — a template that drifts with the page it came from
 * is not a template. Block ids are kept as they are and re-minted at
 * instantiation instead; a stored graph with consistent `parent` links is
 * easier to reason about than one with holes in it.
 */
export function makeTemplate(page: Page, name: string): PageTemplate {
  const blocks: Block[] = JSON.parse(JSON.stringify(page.blocks ?? [])) as Block[]
  return {
    id: uid('tpl'),
    name: name || page.title || 'Template',
    // The page's own title becomes the new page's title. Somebody who wants a
    // date in it edits the field; the common case is that the title IS the name.
    ...(page.title ? { title: page.title } : {}),
    ...(page.icon ? { icon: page.icon } : {}),
    ...(page.cover ? { cover: page.cover } : {}),
    ...(page.width === 'wide' || page.width === 'full' ? { width: page.width } : {}),
    blocks,
    created: new Date().toISOString(),
  }
}

// ---- tokens ----------------------------------------------------------------

export interface TokenCtx {
  /** the date the new page is FOR — a journal entry's own day, else today */
  date?: string
  /** the wall clock at instantiation */
  now?: Date
  /** the reader's locale, for the rendered forms */
  locale?: string
  /** what `{{title}}` resolves to */
  title?: string
}

/**
 * The named date shapes.
 *
 * A RECORD, so the `fmt` a mailed template names is looked up with
 * `Object.hasOwn` and never with `in`, truthiness or a bare index. `{{date:iso}}`
 * is a format; `{{date:constructor}}` is a string that stays literal. Without
 * that guard the second one resolves to `Object`'s constructor and stringifies
 * a function into the reader's page — the exact indirection bug this zone has
 * written down twice.
 */
const DATE_FMT: Record<string, (iso: string, locale?: string) => string> = {
  iso: (iso) => iso,
  long: (iso, locale) => journalLabel(iso, locale),
  short: (iso, locale) => journalShort(iso, locale),
}

/** `{{date}}`, `{{date:iso}}`, `{{date+1:short}}`, `{{time}}`, `{{title}}`. */
const TOKEN = /\{\{\s*(date|time|title)\s*([+-]\d{1,4})?\s*(?::\s*([A-Za-z]+)\s*)?\}\}/g

function clockLabel(now: Date, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(now)
  } catch {
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  }
}

/**
 * Substitute the tokens in one string.
 *
 * `encode` is what makes this safe in both places it is used: a block's `html`
 * needs the value escaped (a template could be instantiated with a locale whose
 * date format contains nothing dangerous today, but the rule must not depend on
 * that), and a page title is plain text and must not be. An unrecognised token
 * never matches and is therefore left exactly as it was typed, which is the
 * behaviour a `{{mustache}}` in someone's prose needs.
 */
export function expandTokens(text: string, ctx: TokenCtx = {}, encode: (s: string) => string = (s) => s): string {
  if (!text || text.indexOf('{{') < 0) return text
  const now = ctx.now ?? new Date()
  const base = ctx.date && isISO(ctx.date) ? ctx.date : todayISO(now)
  return text.replace(TOKEN, (whole, name: string, offset: string | undefined, fmt: string | undefined) => {
    if (name === 'title') return offset || fmt ? whole : encode(ctx.title ?? '')
    if (name === 'time') return offset || fmt ? whole : encode(clockLabel(now, ctx.locale))
    const iso = offset ? stepDay(base, Number(offset)) : base
    const key = fmt ?? 'long'
    if (!Object.hasOwn(DATE_FMT, key)) return whole
    return encode(DATE_FMT[key](iso, ctx.locale))
  })
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// ---- instantiation ---------------------------------------------------------

/**
 * The blocks a template produces: fresh ids, `parent` links remapped to match,
 * tokens expanded, and every `html` put back through the sanitizer.
 *
 * SANITIZED HERE even though render.ts sanitizes what it paints, for the reason
 * portable.ts sanitizes a graft: this writes into `doc.blocks`, which is what
 * the Markdown export, the agent API and the next save all read. Cleaning at
 * the door means the document never HOLDS the thing, rather than every reader
 * of it having to remember.
 *
 * FRESH IDS ARE NOT COSMETIC. Ids are what links, backlinks and the CRDT node
 * key are built on; two pages made from one template sharing block ids would
 * make `buildIndex` disagree with itself and give two collaborators one node
 * for two blocks.
 */
export function instantiateBlocks(tpl: PageTemplate, ctx: TokenCtx = {}): Block[] {
  const src = Array.isArray(tpl.blocks) ? tpl.blocks : []
  const idMap = new Map<string, string>()
  for (const b of src) if (typeof b?.id === 'string' && b.id) idMap.set(b.id, uid('b'))
  const out: Block[] = []
  for (const b of src) {
    if (!isObj(b)) continue
    const copy = JSON.parse(JSON.stringify(b)) as Block
    copy.id = (typeof b.id === 'string' && idMap.get(b.id)) || uid('b')
    // A parent naming a block that is not in this template is DROPPED, exactly
    // as parseDoc drops one: a block whose owner is absent never renders.
    if (typeof copy.parent === 'string') {
      const to = idMap.get(copy.parent)
      if (to) copy.parent = to
      else delete copy.parent
    }
    if (typeof copy.html === 'string') copy.html = sanitizeInline(expandTokens(copy.html, ctx, escapeHtml))
    if (typeof copy.caption === 'string') copy.caption = expandTokens(copy.caption, ctx, escapeHtml)
    if (Array.isArray(copy.rows)) {
      copy.rows = copy.rows.map((row) =>
        Array.isArray(row) ? row.map((c) => (typeof c === 'string' ? sanitizeInline(expandTokens(c, ctx, escapeHtml)) : c)) : row)
    }
    out.push(copy)
  }
  // A page with no blocks has nowhere to put the caret.
  if (!out.length) out.push({ id: uid('b'), type: 'p', html: '' })
  return out
}

/**
 * Apply a template to a page IN PLACE, replacing its blocks.
 *
 * In place, and mutating, because every caller is already inside a
 * `store.commit` — making the whole thing one undo step is the point. Passing a
 * page back would tempt a caller into a second commit and "new page from
 * template" would take two ⌘Z.
 *
 * `keepTitle` is what the journal needs: a daily entry's title is its ISO date
 * and the template must not overwrite it, while an ordinary new page takes the
 * template's title. Same code, one flag, rather than two near-identical paths.
 */
export function applyTemplate(page: Page, tpl: PageTemplate, ctx: TokenCtx = {}, keepTitle = false): void {
  const withTitle: TokenCtx = { ...ctx, title: ctx.title ?? page.title }
  if (!keepTitle && typeof tpl.title === 'string' && tpl.title) {
    page.title = expandTokens(tpl.title, withTitle, (s) => s)
  }
  if (typeof tpl.icon === 'string' && tpl.icon) page.icon = tpl.icon
  if (typeof tpl.cover === 'string' && tpl.cover) page.cover = tpl.cover
  if (tpl.width === 'wide' || tpl.width === 'full') page.width = tpl.width
  page.blocks = instantiateBlocks(tpl, { ...withTitle, title: page.title })
}

// ---- the collection --------------------------------------------------------
// All three mutate `doc` and none of them commits. The caller is the editor,
// inside one `store.commit`, so that saving or deleting a template is one undo
// step — and so this module needs no store and stays runnable in node.

/** Add a template, or replace the one with the same id. */
export function putTemplate(doc: SpacesDoc, tpl: PageTemplate): void {
  const list = templatesOf(doc)
  const at = list.findIndex((t) => t.id === tpl.id)
  if (at >= 0) list[at] = tpl
  else list.push(tpl)
  doc.templates = list
}

/**
 * Remove a template.
 *
 * If it was the journal's, the SETTING GOES TOO — deleting the key rather than
 * leaving it pointing at nothing. A dangling id is not dangerous (`templateById`
 * returns undefined and the journal falls back to a blank page), but a document
 * that carries a setting naming something that does not exist is a document
 * whose next reader has to work out whether it means anything.
 */
export function removeTemplate(doc: SpacesDoc, id: string): void {
  doc.templates = templatesOf(doc).filter((t) => t.id !== id)
  if (!doc.templates.length) delete doc.templates
  if ((doc as { journalTemplate?: unknown }).journalTemplate === id) delete doc.journalTemplate
}

/**
 * Point new daily notes at a template, or at nothing.
 *
 * DEFAULT IS AN ABSENT KEY. A document where the setting was turned on and off
 * again is byte-identical to one where it never was, and a file written before
 * this feature stays that way (PLATFORM §3).
 */
export function setJournalTemplate(doc: SpacesDoc, id: string | undefined): void {
  if (id && templateById(doc, id)) doc.journalTemplate = id
  else delete doc.journalTemplate
}
