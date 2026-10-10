// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// IN-FILE VERSION HISTORY for bento/spaces.
//
// WHY THIS EXISTS AT ALL. `kernel/src/autosave.ts` already keeps a timeline —
// in IndexedDB, in ONE browser. Mail the file and the history is gone; open it
// on a phone and it never existed. A hosted notes app can only do history on
// its server, and a file you send someone simply cannot have it. So this puts
// the timeline where the rest of the document already is: inside the file,
// under `doc.revisions`.
//
// THE ENVELOPE IS THE KERNEL'S. Every entry is `Revision<SpacesPatch>` from
// kernel/src/docfields.ts — `{ id, at, label?, body }` — the one shape every
// app's history shares (type's body is a whole snapshot; this one is a patch).
// `label` is OPTIONAL and absent unless a person typed one: a label minted by
// the app would be a sentence frozen in its author's UI language and shown to
// every reader of a file that opens in eight. The summary on screen is DERIVED
// from the body at render time (`changesAt`), so the file holds language-free
// data. Every entry read from a file passes `validateRevision` and then this
// module's own body check (`readable`); one that fails makes the WHOLE list
// foreign, and a foreign list is never written over.
//
// WHAT IT COVERS IS READ FROM THE FIELD MAP, not listed here. A revision covers
// every top-level field `SPACES_FIELDS` (docclass.ts) classes as `content`,
// except three kinds that are not the space's writing:
//   * `assets` — the bytes. The largest thing in the document by orders of
//     magnitude and content-addressed by key, so one photograph would be
//     bigger than the whole budget below. A revision references `asset:<key>`;
//     restoring a page whose asset was later removed from the pool renders the
//     missing-image fallback rather than the picture. (`store.ts` keeps assets
//     out of undo snapshots for the same reason.)
//   * not-an-edit fields (`SPACES_NOT_EDIT`: `modified`) — bookkeeping.
//   * encoding tags (`format`, `version`) — which format the file is in, not
//     what it says. A restore never changes them.
// So title, home, theme, footnotes, fonts, templates, journalTemplate, design,
// designs, policy and pages are covered TODAY, and a content field added to the
// map tomorrow joins history with no change here. Identity, mode, capability
// and history fields (docId, readonly, template, collab, revisions, trail) are
// other classes and can never be rolled back by a restore. Everything on a page
// rides inside `pages`: blocks, comments, fields, covers.
//
// WHOLE SPACE, NOT ONE PAGE. A page has a `parent`, can be the `home`, and is
// linked to by id, so a page restored on its own lands in a tree that no
// longer matches it. A revision is the whole space's content.
//
// THE BUDGET. The starter space is ~37 KB of pages, and this file gets EMAILED,
// so a whole snapshot per save is out of the question. A revision stores only
// what CHANGED since the one before it: a top-level field whole when it
// changed, a page's metadata whole when any of it changed, a block whole when
// it changed, and the id ORDER only when the sequence changed. A paragraph
// edited in a 37 KB space costs a few hundred bytes.
//
// Two ceilings (`pruneRevisions`), and going over them TIERS rather than fails:
//   Tier 1  under both: every revision kept.
//   Tier 2  over one: the OLDEST TWO fold into one — resolution is dropped from
//           the distant past first. The fold RE-DERIVES the replacement from
//           the state those two produce, so every surviving revision still
//           restores exactly what it did.
//   Tier 3  a space whose content alone exceeds the budget keeps none; the
//           dialog says so.
// The constants and the fold are this module's FOR NOW. The kernel's shared
// fold module lands after DocStore; HISTORY_MAX / HISTORY_BUDGET are named and
// valued as the kernel's defaults, and `pruneRevisions` is the one function to
// swap for it — the call sites do not change.
//
// THE INVARIANT:   restore(N) == the content that was saved at revision N,
// on the SERIALIZED bytes. `record` diffs against the state the existing chain
// folds to, so the chain can never drift from what it claims to describe.
//
// WHERE RECORDING HAPPENS: inside the save queue's PREPARE step (main.ts,
// beside stampSync), after any write ahead of it and immediately before the
// snapshot is copied — so the revision describes exactly the bytes written,
// and the bytes written contain it. Recording writes `doc.revisions` directly
// (never `store.commit`), so it neither advances the store's revision (the
// write is not stale) nor raises the unsaved dot. `revisions` is also out of
// the recovery key (docclass.ts SPACES_NOT_EDIT): it changes only at a save,
// inside the bytes that save writes, so it is never the unsaved work a
// recovery snapshot exists to keep.
//
// ENCRYPTION. `revisions` is a field of the document, so it is inside the
// `bento/enc` envelope, encrypted by the same pass as the pages it describes.
// Nothing here touches IndexedDB. An encrypted space therefore HAS history —
// which it never did, because the only mechanism was the browser-local one
// that must refuse it.
//
// WHAT HISTORY DISCLOSES: a deleted page's text is still in the file, in the
// revision that last held it, until the budget folds it away. The kernel's copy
// table keeps history in the file, a duplicate and an invite, and DROPS it from
// every copy handed to a reader (reading copy, view-only copy, package, link,
// template, Copy document JSON); a page extract drops it too (portable.ts).
// "Clear history" is in the dialog, and the dialog says this in words.
//
// ADDITIVITY (PLATFORM §3). No revisions = no key at all, never `[]`. Unknown
// fields on an entry or its body survive a later save untouched.

import { validateRevision, type Revision, type FieldsOfClass } from '../../kernel/src/docfields.ts'
import { SPACES_FIELDS, SPACES_NOT_EDIT } from './docclass.ts'
import { uid, type SpacesDoc, type Page, type Block } from './model.ts'
import { textOf } from './sanitize.ts'

/** Serialized bytes of `doc.revisions` above which the oldest entries fold —
 *  the kernel fold module's default. */
export const HISTORY_BUDGET = 128 * 1024

/** Entries kept, however small they are — the kernel fold module's default. */
export const HISTORY_MAX = 60

/** How many of the oldest entries one fold step merges. */
export const HISTORY_FOLD = 2

/** Content-class fields that are NOT the space's writing: the asset pool
 *  (bytes, never duplicated) and the format's own encoding tags. */
const NOT_COVERED = new Set<string>(['assets', 'format', 'version'])

/** The content-class field names, as a type — so a field classed otherwise
 *  can never be named here. */
type ContentField = FieldsOfClass<typeof SPACES_FIELDS, 'content'>

/**
 * The top-level fields a revision covers, in the map's declaration order —
 * which is also the key order `contentOf` writes, so two runs over the same
 * content produce the same bytes. DERIVED: a new content field joins history
 * without an edit here.
 */
export const HISTORY_FIELDS: readonly ContentField[] = (Object.keys(SPACES_FIELDS) as Array<keyof typeof SPACES_FIELDS>)
  .filter((k): k is ContentField =>
    SPACES_FIELDS[k] === 'content' && !NOT_COVERED.has(k) && !SPACES_NOT_EDIT.has(k))

/** The covered fields other than `pages`, which the patch carries per page. */
const DOC_FIELDS: readonly string[] = HISTORY_FIELDS.filter((k) => k !== 'pages')

/** The part of a space that history covers: the covered top-level fields that
 *  are present, plus `pages`. */
export type SpaceContent = { pages: Page[] } & Record<string, unknown>

/** One page's change at one revision. */
export interface RevPage {
  id: string
  /** the page no longer exists as of this revision */
  gone?: true
  /** the whole page WITHOUT its blocks (`blocks: []`, in its original key
   *  slot, so a rebuilt page serializes to the same bytes) — present only
   *  when some page field changed */
  meta?: Page
  /** blocks added or changed, whole */
  put?: Block[]
  /** every block id, in order — present only when the sequence changed */
  order?: string[]
}

/** The body of a spaces revision: the change from the revision before it. */
export interface SpacesPatch {
  /** covered top-level fields (not `pages`) that changed, each whole */
  doc?: Record<string, unknown>
  /** covered top-level fields that became absent */
  unset?: string[]
  /** every page id, in order — present only when the sequence changed */
  order?: string[]
  pages?: RevPage[]
}

/** One recorded revision — the kernel's envelope around this app's patch. */
export type SpacesRevision = Revision<SpacesPatch>

const j = (v: unknown): string => JSON.stringify(v)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const bytes = (v: unknown): number => new TextEncoder().encode(j(v) ?? '').length
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')

/** A content state in the one key order this module writes: the covered
 *  fields that are present, in HISTORY_FIELDS order, `pages` in its slot. */
function canon(fields: Record<string, unknown>, pages: Page[]): SpaceContent {
  const out: Record<string, unknown> = {}
  for (const k of HISTORY_FIELDS) {
    if (k === 'pages') out.pages = pages
    else if (fields[k] !== undefined) out[k] = fields[k]
  }
  return out as SpaceContent
}

/** A page with its blocks emptied, key order untouched. */
function metaOf(p: Page): Page {
  return { ...p, blocks: [] as Block[] } as Page
}

/** The content projection of a live document, detached from it. */
export function contentOf(doc: SpacesDoc): SpaceContent {
  const d = doc as unknown as Record<string, unknown>
  return clone(canon(d, Array.isArray(doc.pages) ? doc.pages : []))
}

/** The non-page part of a content state, keyed. */
function fieldsOf(c: SpaceContent | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!c) return out
  for (const k of DOC_FIELDS) if (c[k] !== undefined) out[k] = c[k]
  return out
}

// ---- reading what a file carries ----------------------------------------

/** A page patch this build can apply. */
function readablePage(p: unknown): boolean {
  if (!isObj(p) || typeof p.id !== 'string') return false
  if (p.gone !== undefined && p.gone !== true) return false
  if (p.meta !== undefined && !(isObj(p.meta) && p.meta.id === p.id)) return false
  if (p.put !== undefined && !(Array.isArray(p.put) && p.put.every((b) => isObj(b) && typeof b.id === 'string'))) return false
  if (p.order !== undefined && !isStrs(p.order)) return false
  return true
}

/**
 * The kernel's envelope check, then this app's body check. Every entry read
 * from a file passes this before anything folds it — a malformed entry must
 * not crash a reader, and must not be "repaired" by being written over.
 */
export function readable(e: unknown): e is SpacesRevision {
  if (!validateRevision(e)) return false
  const b = (e as { body: unknown }).body
  if (!isObj(b)) return false
  if (b.doc !== undefined && !isObj(b.doc)) return false
  if (b.unset !== undefined && !isStrs(b.unset)) return false
  if (b.order !== undefined && !isStrs(b.order)) return false
  if (b.pages !== undefined && !(Array.isArray(b.pages) && b.pages.every(readablePage))) return false
  return true
}

/**
 * True when `doc.revisions` holds something this build cannot read: not an
 * array, or any entry that fails `readable`. Such a list is LEFT ALONE —
 * never recorded onto, never pruned, never cleared by a save — because a
 * patch chain cannot be extended past a link it cannot read.
 */
export function historyIsForeign(doc: SpacesDoc): boolean {
  const r = (doc as { revisions?: unknown }).revisions
  if (r === undefined) return false
  return !Array.isArray(r) || !r.every(readable)
}

/** `doc.revisions`, when this build can read every entry of it; else none. */
export function revisionsOf(doc: SpacesDoc): SpacesRevision[] {
  const r = (doc as { revisions?: unknown }).revisions
  if (!Array.isArray(r) || !r.every(readable)) return []
  return r as SpacesRevision[]
}

// ---- the chain -----------------------------------------------------------

/**
 * The change from `prev` (or from nothing) to `next`.
 *
 * Everything stored is stored WHOLE, so applying it rebuilds objects whose key
 * order matches the originals; the saving is in what is left out.
 */
export function diffContent(prev: SpaceContent | null, next: SpaceContent): SpacesPatch {
  const out: SpacesPatch = {}
  const was = fieldsOf(prev), now = fieldsOf(next)
  const set: Record<string, unknown> = {}
  const unset: string[] = []
  for (const k of DOC_FIELDS) {
    if (now[k] === undefined) { if (was[k] !== undefined) unset.push(k); continue }
    if (j(now[k]) !== j(was[k])) set[k] = now[k]
  }
  if (Object.keys(set).length) out.doc = set
  if (unset.length) out.unset = unset

  const prevPages = new Map((prev?.pages ?? []).map((p) => [p.id, p]))
  const nextIds = next.pages.map((p) => p.id)
  const prevIds = (prev?.pages ?? []).map((p) => p.id)
  if (j(nextIds) !== j(prevIds)) out.order = nextIds

  const patches: RevPage[] = []
  for (const p of next.pages) {
    const q = prevPages.get(p.id)
    const patch: RevPage = { id: p.id }
    const meta = metaOf(p)
    if (!q || j(metaOf(q)) !== j(meta)) patch.meta = meta
    const before = new Map((q?.blocks ?? []).map((b) => [b.id, b]))
    const put = (p.blocks ?? []).filter((b) => {
      const o = before.get(b.id)
      return !o || j(o) !== j(b)
    })
    if (put.length) patch.put = put
    const bIds = (p.blocks ?? []).map((b) => b.id)
    if (j(bIds) !== j((q?.blocks ?? []).map((b) => b.id))) patch.order = bIds
    if (patch.meta || patch.put || patch.order) patches.push(patch)
  }
  const nextSet = new Set(nextIds)
  for (const id of prevPages.keys()) if (!nextSet.has(id)) patches.push({ id, gone: true })
  if (patches.length) out.pages = patches
  return out
}

const isEmpty = (b: SpacesPatch): boolean => !b.doc && !b.unset && !b.order && !b.pages

/** Fold one patch onto a state. Only the fields this build knows are read. */
function applyOne(cur: SpaceContent | null, b: SpacesPatch): SpaceContent {
  const fields = fieldsOf(cur)
  for (const [k, v] of Object.entries(b.doc ?? {})) if (DOC_FIELDS.includes(k)) fields[k] = v
  for (const k of b.unset ?? []) delete fields[k]

  const prevPages = new Map((cur?.pages ?? []).map((p) => [p.id, p]))
  const ids = b.order ?? (cur?.pages ?? []).map((p) => p.id)
  const built = new Map<string, Page | null>()
  for (const patch of b.pages ?? []) {
    if (patch.gone) { built.set(patch.id, null); continue }
    const q = prevPages.get(patch.id)
    const base = patch.meta ?? (q ? metaOf(q) : ({ id: patch.id, title: '', blocks: [] } as Page))
    const page = clone(base)
    const by = new Map((q?.blocks ?? []).map((x) => [x.id, x]))
    for (const x of patch.put ?? []) by.set(x.id, x)
    const bIds = patch.order ?? (q?.blocks ?? []).map((x) => x.id)
    page.blocks = bIds.map((i) => by.get(i)).filter((x): x is Block => !!x)
    built.set(patch.id, page)
  }
  const pages: Page[] = []
  for (const id of ids) {
    const p = built.has(id) ? built.get(id) : prevPages.get(id)
    if (p) pages.push(p)
  }
  return clone(canon(fields, pages))
}

/**
 * The content as of revision `upTo` (an index; default the last). This is
 * `restore`: one way to read the chain, and `record` writes against it.
 */
export function applyRevisions(revs: readonly SpacesRevision[], upTo = revs.length - 1): SpaceContent | null {
  if (!revs.length || upTo < 0) return null
  let cur: SpaceContent | null = null
  for (let i = 0; i <= upTo && i < revs.length; i++) cur = applyOne(cur, revs[i].body)
  return cur
}

/**
 * Bring a list back under both ceilings, tiering rather than failing. The
 * fold RE-DERIVES the replacing entry from the state the oldest two produce,
 * so it is a complete description of that state by construction.
 *
 * THE SEAM for the kernel's fold module (after DocStore): same inputs, same
 * defaults, same contract — swap this body, not its callers.
 */
export function pruneRevisions(
  revs: readonly SpacesRevision[],
  budget = HISTORY_BUDGET,
  max = HISTORY_MAX,
): SpacesRevision[] {
  const out = revs.slice()
  while (out.length > 1 && (out.length > max || bytes(out) > budget)) {
    const n = Math.min(HISTORY_FOLD, out.length)
    const state = applyRevisions(out, n - 1)!
    const keep = out[n - 1]
    const folded: SpacesRevision = {
      id: keep.id,
      at: keep.at,
      ...(keep.label !== undefined ? { label: keep.label } : {}),
      body: diffContent(null, state),
    }
    out.splice(0, n, folded)
  }
  // Tier 3: the space's own content will not fit. Half a history is worse
  // than none, because only one of the two is honest about what it can give.
  if (out.length === 1 && bytes(out) > budget) return []
  return out
}

/**
 * Record the document's current content as a revision, in place.
 *
 * Returns the entry if one was written. `null` means nothing changed since the
 * last revision (a save that changed nothing writes no bytes), that
 * `doc.revisions` is foreign and must not be overwritten, or that the space is
 * too large to keep any (tier 3 — the key is then removed).
 */
export function recordRevision(doc: SpacesDoc, label?: string): SpacesRevision | null {
  if (historyIsForeign(doc)) return null
  const revs = revisionsOf(doc)
  const body = diffContent(applyRevisions(revs), contentOf(doc))
  if (isEmpty(body)) return null
  const rev: SpacesRevision = {
    id: uid('rev'),
    at: new Date().toISOString(),
    ...(label ? { label } : {}),
    body,
  }
  const kept = pruneRevisions([...revs, rev])
  if (kept.length) doc.revisions = kept
  else delete doc.revisions
  return kept.length ? rev : null
}

/**
 * What a save calls, in the save queue's prepare: record unless the store is
 * read-only. A frozen file round-trips byte-exact, and a reading copy or a
 * view-only follower does not author history.
 */
export function recordOnSave(store: { readonly readOnly: boolean; readonly doc: SpacesDoc }): SpacesRevision | null {
  if (store.readOnly) return null
  return recordRevision(store.doc)
}

/** Remove history from a document. No key, never an empty array. A foreign
 *  list is not ours to remove either. */
export function clearHistory(doc: SpacesDoc): boolean {
  if (historyIsForeign(doc)) return false
  delete doc.revisions
  return true
}

/**
 * The document with the content of revision `index` and everything else —
 * identity, assets, collaboration, modes, the history itself and any field
 * this build does not know — left as it is. A covered field absent at `index`
 * is removed. The caller installs it through the restore gate
 * (restoregate.ts restoreInto), which sanitizes it and keeps live identity.
 */
export function restoredDoc(doc: SpacesDoc, index: number): SpacesDoc | null {
  const state = applyRevisions(revisionsOf(doc), index)
  if (!state) return null
  const out = clone(doc) as unknown as Record<string, unknown>
  for (const k of HISTORY_FIELDS) {
    if (state[k] !== undefined) out[k] = state[k]
    else delete out[k]
  }
  return out as unknown as SpacesDoc
}

/** Serialized bytes history currently costs this file. */
export function historyBytes(doc: SpacesDoc): number {
  const r = (doc as { revisions?: unknown }).revisions
  return r === undefined ? 0 : bytes(r)
}

/** Would this space's content alone overflow the budget (tier 3)? */
export function tooLargeForHistory(doc: SpacesDoc): boolean {
  return bytes([{ id: 'rev', at: new Date(0).toISOString(), body: diffContent(null, contentOf(doc)) }]) > HISTORY_BUDGET
}

// ---------------------------------------------------------------------------
// The diff view.
//
// GRANULARITY IS WORDS, for the reason type/src/redline.ts gives: a line diff
// calls a reflowed paragraph wholly rewritten, and a character diff marks
// "30" → "60" as one glyph nobody can see. NOT IMPORTED from there — that is
// bento/type's runtime; the reasoning is cited, not the code.
// ---------------------------------------------------------------------------

/** Words and the whitespace between them, so a join is lossless. */
export function words(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? []
}

export interface DiffPart { op: 'eq' | 'del' | 'ins'; text: string }

/** Above this many token PAIRS the LCS table is not built; the block is
 *  reported as replaced whole rather than freezing the dialog. */
const LCS_CAP = 400_000

/** Word-level diff, returned as runs. */
export function diffWords(a: string, b: string): DiffPart[] {
  const A0 = words(a), B0 = words(b)
  if (!A0.length && !B0.length) return []
  let s = 0
  while (s < A0.length && s < B0.length && A0[s] === B0[s]) s++
  let e = 0
  while (e < A0.length - s && e < B0.length - s && A0[A0.length - 1 - e] === B0[B0.length - 1 - e]) e++
  const A = A0.slice(s, A0.length - e)
  const B = B0.slice(s, B0.length - e)
  const parts: DiffPart[] = []
  const push = (op: DiffPart['op'], text: string) => {
    if (!text) return
    const last = parts[parts.length - 1]
    if (last && last.op === op) last.text += text
    else parts.push({ op, text })
  }
  push('eq', A0.slice(0, s).join(''))
  if (A.length * B.length > LCS_CAP) {
    push('del', A.join(''))
    push('ins', B.join(''))
  } else {
    const N = A.length, M = B.length
    const lcs: Uint32Array[] = []
    for (let i = 0; i <= N; i++) lcs.push(new Uint32Array(M + 1))
    for (let i = N - 1; i >= 0; i--)
      for (let k = M - 1; k >= 0; k--)
        lcs[i][k] = A[i] === B[k] ? lcs[i + 1][k + 1] + 1 : Math.max(lcs[i + 1][k], lcs[i][k + 1])
    let i = 0, k = 0
    while (i < N && k < M) {
      if (A[i] === B[k]) { push('eq', A[i]); i++; k++ }
      else if (lcs[i + 1][k] >= lcs[i][k + 1]) { push('del', A[i]); i++ }
      else { push('ins', B[k]); k++ }
    }
    push('del', A.slice(i).join(''))
    push('ins', B.slice(k).join(''))
  }
  push('eq', A0.slice(A0.length - e).join(''))
  return parts
}

export interface BlockChange {
  id: string
  kind: 'added' | 'removed' | 'changed'
  /** the block's type, for a label when there is no text to show */
  type: string
  parts: DiffPart[]
}

export interface PageChange {
  id: string
  /** the title AFTER the change, or before it when the page was removed */
  title: string
  kind: 'added' | 'removed' | 'changed'
  /** set when the title itself changed */
  wasTitled?: string
  blocks: BlockChange[]
}

export interface ChangeReport {
  pages: PageChange[]
  /** counts, for the one-line summary the list shows */
  pagesChanged: number
  blocksChanged: number
  /** covered top-level fields (not pages) that changed — names, never text */
  fieldsChanged: string[]
  /** the first revision: there is nothing before it to compare with */
  first: boolean
}

const blockText = (b: Block): string => {
  if (Array.isArray(b.rows)) return b.rows.map((r) => r.map((c) => textOf(c)).join('\t')).join('\n')
  const t = textOf(b.html)
  return t || String(b.caption ?? b.alt ?? '')
}

/** What changed between two content states, ready to render. */
export function compareContent(from: SpaceContent | null, to: SpaceContent | null): ChangeReport {
  const rep: ChangeReport = { pages: [], pagesChanged: 0, blocksChanged: 0, fieldsChanged: [], first: !from }
  if (!to) return rep
  if (from) {
    const a = fieldsOf(from), b = fieldsOf(to)
    rep.fieldsChanged = DOC_FIELDS.filter((k) => j(a[k]) !== j(b[k]))
  }
  const was = new Map((from?.pages ?? []).map((p) => [p.id, p]))
  for (const p of to.pages) {
    const q = was.get(p.id)
    const blocks: BlockChange[] = []
    const wasBlocks = new Map((q?.blocks ?? []).map((b) => [b.id, b]))
    for (const b of p.blocks ?? []) {
      const o = wasBlocks.get(b.id)
      if (!o) { blocks.push({ id: b.id, kind: 'added', type: b.type, parts: diffWords('', blockText(b)) }); continue }
      if (j(o) === j(b)) continue
      blocks.push({ id: b.id, kind: 'changed', type: b.type, parts: diffWords(blockText(o), blockText(b)) })
    }
    const live = new Set((p.blocks ?? []).map((b) => b.id))
    for (const o of q?.blocks ?? []) {
      if (!live.has(o.id)) blocks.push({ id: o.id, kind: 'removed', type: o.type, parts: diffWords(blockText(o), '') })
    }
    if (!q) rep.pages.push({ id: p.id, title: p.title, kind: 'added', blocks })
    else if (blocks.length || j(metaOf(q)) !== j(metaOf(p))) {
      rep.pages.push({
        id: p.id, title: p.title, kind: 'changed',
        ...(q.title !== p.title ? { wasTitled: q.title } : {}),
        blocks,
      })
    }
  }
  const live = new Set(to.pages.map((p) => p.id))
  for (const q of from?.pages ?? []) {
    if (live.has(q.id)) continue
    rep.pages.push({
      id: q.id, title: q.title, kind: 'removed',
      blocks: (q.blocks ?? []).map((b) => ({
        id: b.id, kind: 'removed' as const, type: b.type, parts: diffWords(blockText(b), ''),
      })),
    })
  }
  rep.pagesChanged = rep.pages.length
  rep.blocksChanged = rep.pages.reduce((n, p) => n + p.blocks.length, 0)
  return rep
}

/** What one revision changed, against the one before it. */
export function changesAt(revs: readonly SpacesRevision[], index: number): ChangeReport {
  return compareContent(applyRevisions(revs, index - 1), applyRevisions(revs, index))
}
