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
// under `doc.revisions`, travelling with every copy.
//
// FOLLOWING bento/type. `type/src/model.ts` settled the shape first:
//
//     interface Revision { id: string; at: string; label: string; body: Block[] }
//
// A doc-level list, in the file, each entry a snapshot with a timestamp and a
// label. This keeps `id`/`at`/`label` verbatim and diverges in exactly two
// places, both forced by differences this app actually has:
//
//   1. `label` is OPTIONAL here, and absent unless a person typed one.
//      type stores a label per revision; a label minted by the app would be a
//      sentence — "3 pages changed" — frozen at save time in whatever language
//      its author's UI happened to be in, and then shown in that language to
//      every reader of a document that opens in eight. The summary this app
//      shows is DERIVED from the patch at render time, so it is language-free
//      data in the file and localized text on the screen. A label the author
//      typed is their words and is kept as typed.
//
//   2. The body is a PATCH, not a whole snapshot. type has one body; a space
//      has a tree of pages, and the reason is arithmetic rather than taste —
//      see THE BUDGET below.
//
// WHOLE SPACE, NOT ONE PAGE. A revision covers the whole space, because a page
// is not a self-contained thing here: it has a `parent`, it can be the `home`,
// links point at it by id, and a "page" that was renamed, moved under a new
// parent and had two children deleted cannot be described, let alone restored,
// without the tree around it. Per-page history would restore a page into a
// tree that no longer matches it and call that a restore. What history covers
// is the space's CONTENT — `title`, `home`, `theme`, `pages` — and everything
// on a page rides inside `pages`: blocks, comments, fields, covers.
//
// WHAT IT DELIBERATELY DOES NOT COVER, and why:
//   * `assets` — the largest thing in the document by orders of magnitude, and
//     content-addressed by key. One embedded photograph is bigger than the
//     whole budget below, so including asset BYTES in every revision would
//     make the budget meaningless. `store.ts` excludes them from undo
//     snapshots for the same reason and this follows it. Consequence, said out
//     loud: a revision references `asset:<key>`, so restoring a page whose
//     asset was later removed from the table renders the missing-image
//     fallback rather than the picture.
//   * `collab` — bearer capabilities and a live room id. Rolling those back
//     would revoke a room that is still connected.
//   * `docId`, `format`, `version`, `policy`, `readonly`, `template` — the
//     file's identity and rules, not its content. A restore must never change
//     which document this is.
//
// THE BUDGET, which is the hard part. The starter space is 37 KB of pages. A
// whole-space snapshot per save is therefore 37 KB per save, and this file gets
// EMAILED — twenty saves would add three quarters of a megabyte to a 258 KB
// shell. So a revision stores only what CHANGED since the one before it, at
// page and block granularity: a paragraph edited in a 37 KB space costs a few
// hundred bytes, not 37 KB. Blocks are stored WHOLE when they change (a block
// is a paragraph; a text diff inside one would buy tens of bytes and cost
// exactness), and page metadata is stored whole when any of it changes (a
// hundred bytes) so the restored object's key ORDER matches what was saved
// byte for byte.
//
// Two ceilings, both enforced by `pruneRevisions`:
//   * HISTORY_BUDGET — serialized bytes of the whole list.
//   * HISTORY_MAX — how many entries, so a tiny space cannot accumulate
//     thousands of 40-byte revisions that no one can read past.
//
// And, following PREVIEW_BUDGET, going over TIERS rather than fails:
//   Tier 1  under both ceilings: every revision kept, full resolution.
//   Tier 2  over one: the OLDEST TWO are folded into one. Resolution is what
//           is dropped, and it is dropped from the distant past first — last
//           week becomes one entry while this afternoon keeps every save. The
//           fold is exact by construction: it re-derives the folded entry from
//           the state those two revisions produce, so every revision that
//           remains still restores exactly what it always did.
//   Tier 3  a space whose content alone exceeds the budget cannot carry even
//           one revision — `revisions` is removed entirely and the dialog says
//           so. History is a promise about a file people send; a file that
//           cannot keep it should say that rather than half-keep it.
//
// THE INVARIANT everything else rests on, and the equivalent of the two
// `type/src/redline.ts` states for its own feature:
//
//     restore(N)  ==  the content that was saved at revision N
//
// exactly, on the SERIALIZED bytes — not "the same text", not "the same
// blocks". If that fails, "restore this version" is a lie. `record` is written
// so it holds: the patch is computed against the state the existing chain
// folds to, so the chain can never drift from what it claims to describe.
//
// ENCRYPTION. `kernel/src/autosave.ts` is never given an encrypted space,
// because a recovery snapshot is plain JSON written to this machine's
// IndexedDB — the disk the password exists to keep it off. Slides' preview
// rule is the same shape: an encrypted deck gets NO preview, because a
// plaintext title slide sitting BESIDE the ciphertext is the leak the password
// exists to prevent.
//
// Neither applies here, and the difference is not a loophole — it is where the
// bytes are. `revisions` is a field of the document, so it is inside the
// `bento/enc` envelope, encrypted by the same AES-GCM pass over the same JSON
// as every page it describes. There is no plaintext artefact and nothing
// beside the ciphertext. An encrypted space therefore DOES keep history, and
// that is a capability it did not have before: today an encrypted space has no
// history at all, because the only mechanism was the one that must refuse it.
//
// WHAT HISTORY DISCLOSES, said plainly because it is easy to miss: a deleted
// page's text is still in the file, in the revision that last held it, until
// the budget folds it away. That is true of every version-history feature ever
// built; what is different about a document you MAIL is that the disclosure
// travels. So "Clear history" is a first-class control in the dialog, the
// dialog says this in words, and `portable.ts` strips `revisions` from a page
// extract outright — an extract of one page has no business carrying the
// deleted history of pages that did not travel with it.
//
// ADDITIVITY (PLATFORM §3). Absent key = the behaviour every build before this
// one had. No revisions = no key at all, never `revisions: []`. An older build
// round-trips the array untouched and renders none of it as content, because
// it renders `doc.pages` and nothing else. A `revisions` that is not an array
// — a shape some future build gave the name — is LEFT ALONE and never written
// over.

import {
  uid, defaultTheme,
  type SpacesDoc, type Page, type Block, type Theme,
} from './model.ts'
import { textOf } from './sanitize.ts'

/**
 * Serialized bytes of `doc.revisions` above which the oldest entries are
 * folded together. 128 KB against a 258 KB shell: history is the feature here,
 * not a courtesy like the preview, so it gets a bigger allowance than
 * PREVIEW_BUDGET's 64 KB — but it is still a ceiling and not a typical cost.
 * A save that edits one paragraph writes a few hundred bytes, so this holds
 * hundreds of ordinary saves before anything is folded at all.
 */
export const HISTORY_BUDGET = 128 * 1024

/** Entries kept, however small they are. A list nobody can read past is not
 *  history either. */
export const HISTORY_MAX = 60

/** The part of a space that history covers. Built in a FIXED key order, so
 *  two runs that produce the same content produce the same bytes. */
export interface SpaceContent {
  title: string
  home?: string
  theme: Theme
  pages: Page[]
}

/** One page's change at one revision. */
export interface RevPage {
  id: string
  /** the page no longer exists as of this revision */
  gone?: true
  /** the whole page WITHOUT its blocks (`blocks` is `[]`, in its original key
   *  slot, so a rebuilt page serializes to the same bytes) — present only
   *  when some page field changed */
  meta?: Page
  /** blocks added or changed, whole */
  put?: Block[]
  /** every block id, in order — present only when the sequence changed, which
   *  is also what records an insert or a delete */
  order?: string[]
}

/**
 * One recorded revision: the change from the revision before it to this one.
 *
 * `id`, `at` and `label` are `type/src/model.ts`'s. The rest is the patch.
 */
export interface Revision {
  id: string
  /** ISO wall clock, display only — ORDER is the array's, never this field */
  at: string
  /** only ever what a person typed */
  label?: string
  /** `title`/`home`/`theme`, whole, when any of them changed */
  doc?: { title: string; home?: string; theme: Theme }
  /** every page id, in order — present only when the sequence changed */
  order?: string[]
  pages?: RevPage[]
}

const j = (v: unknown): string => JSON.stringify(v)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const bytes = (v: unknown): number => new TextEncoder().encode(j(v) ?? '').length

/** `title`/`home`/`theme` in the one key order this module ever writes. */
function docPart(c: { title: string; home?: string; theme: Theme }): { title: string; home?: string; theme: Theme } {
  // Built key by key, in this order, because the ORDER is the point: two runs
  // over the same content must serialize to the same bytes, and an object
  // literal that sometimes carries `home` and sometimes does not would not.
  const d = { title: c.title } as { title: string; home?: string; theme: Theme }
  if (c.home !== undefined) d.home = c.home
  d.theme = c.theme
  return d
}

/** A page with its blocks emptied, key order untouched. */
function metaOf(p: Page): Page {
  const m = { ...p, blocks: [] as Block[] }
  return m as Page
}

/** The content projection of a live document, detached from it. */
export function contentOf(doc: SpacesDoc): SpaceContent {
  const d = docPart({ title: doc.title ?? '', home: doc.home, theme: doc.theme })
  return clone({ ...d, pages: Array.isArray(doc.pages) ? doc.pages : [] }) as SpaceContent
}

/**
 * `doc.revisions`, if it is one.
 *
 * A `revisions` that is not an array of entries is a shape this build does not
 * know. It is returned as nothing and — see `recordRevision` — never written
 * over, because additivity is a promise in both directions.
 */
export function revisionsOf(doc: SpacesDoc): Revision[] {
  const r = (doc as { revisions?: unknown }).revisions
  if (!Array.isArray(r)) return []
  return r.filter((e): e is Revision =>
    !!e && typeof e === 'object' &&
    typeof (e as Revision).id === 'string' && typeof (e as Revision).at === 'string')
}

/** True when `doc.revisions` holds something this build cannot read. */
export function historyIsForeign(doc: SpacesDoc): boolean {
  const r = (doc as { revisions?: unknown }).revisions
  return r !== undefined && !Array.isArray(r)
}

/**
 * The change from `prev` (or from nothing) to `next`.
 *
 * Everything stored is stored WHOLE — the page's metadata, the changed blocks
 * — so applying it rebuilds objects whose key order matches the originals.
 * The saving is in what is left out, which is every page and every block that
 * did not change, and on an ordinary save that is nearly all of them.
 */
export function diffContent(
  prev: SpaceContent | null,
  next: SpaceContent,
): Pick<Revision, 'doc' | 'order' | 'pages'> {
  const out: Pick<Revision, 'doc' | 'order' | 'pages'> = {}
  const nextDoc = docPart(next)
  if (!prev || j(docPart(prev)) !== j(nextDoc)) out.doc = nextDoc

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

    const was = new Map((q?.blocks ?? []).map((b) => [b.id, b]))
    const put = (p.blocks ?? []).filter((b) => {
      const o = was.get(b.id)
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

/** Fold one patch onto a state. */
function applyOne(cur: SpaceContent | null, r: Revision): SpaceContent {
  const d = r.doc ?? docPart(cur ?? { title: '', theme: defaultTheme() })
  const prevPages = new Map((cur?.pages ?? []).map((p) => [p.id, p]))
  const ids = r.order ?? (cur?.pages ?? []).map((p) => p.id)

  const built = new Map<string, Page | null>()
  for (const patch of r.pages ?? []) {
    if (patch.gone) { built.set(patch.id, null); continue }
    const q = prevPages.get(patch.id)
    const base = patch.meta ?? (q ? metaOf(q) : ({ id: patch.id, title: '', blocks: [] } as Page))
    const page = clone(base)
    const by = new Map((q?.blocks ?? []).map((b) => [b.id, b]))
    for (const b of patch.put ?? []) by.set(b.id, b)
    const bIds = patch.order ?? (q?.blocks ?? []).map((b) => b.id)
    page.blocks = bIds.map((i) => by.get(i)).filter((b): b is Block => !!b)
    built.set(patch.id, page)
  }

  const pages: Page[] = []
  for (const id of ids) {
    const b = built.has(id) ? built.get(id) : prevPages.get(id)
    if (b) pages.push(b)
  }
  return clone({ ...d, pages }) as SpaceContent
}

/**
 * The content as of revision `upTo` (an index; default the last).
 *
 * This is `restore`. It folds from the start every time, which is cheap — the
 * chain is at most HISTORY_MAX entries of a few hundred bytes — and it is the
 * reason the invariant holds without a second code path: there is exactly one
 * way to read the chain, and `record` writes against what it returns.
 */
export function applyRevisions(revs: Revision[], upTo = revs.length - 1): SpaceContent | null {
  if (!revs.length || upTo < 0) return null
  let cur: SpaceContent | null = null
  for (let i = 0; i <= upTo && i < revs.length; i++) cur = applyOne(cur, revs[i])
  return cur
}

/**
 * Bring a list back under both ceilings, tiering rather than failing.
 *
 * The fold is a RE-DERIVATION, not a merge of two patch objects: it applies
 * the two oldest entries and diffs the result against nothing, so the replacing
 * entry is by construction a complete description of the state those two
 * produced. A hand-written merge of `meta`/`put`/`order` would have to be
 * correct about resurrection, reordering and deletion interacting, and would
 * be the one place a subtle bug could quietly falsify every restore after it.
 */
export function pruneRevisions(
  revs: Revision[],
  budget = HISTORY_BUDGET,
  max = HISTORY_MAX,
): Revision[] {
  const out = revs.slice()
  while (out.length > 1 && (out.length > max || bytes(out) > budget)) {
    const state = applyRevisions(out, 1)!
    const keep = out[1]
    const folded: Revision = {
      id: keep.id,
      at: keep.at,
      ...(keep.label ? { label: keep.label } : {}),
      ...diffContent(null, state),
    }
    out.splice(0, 2, folded)
  }
  // Tier 3: the space's own content will not fit. Half a history is worse than
  // none, because only one of the two is honest about what it can give back.
  if (out.length === 1 && bytes(out) > budget) return []
  return out
}

/**
 * Record the document's current content as a revision, in place.
 *
 * Returns the entry if one was written. `null` means nothing changed since the
 * last recorded revision (so a save that changed nothing writes no bytes), or
 * that `doc.revisions` holds a shape this build must not overwrite.
 */
export function recordRevision(doc: SpacesDoc, label?: string): Revision | null {
  if (historyIsForeign(doc)) return null
  const revs = revisionsOf(doc)
  const prev = applyRevisions(revs)
  const next = contentOf(doc)
  const body = diffContent(prev, next)
  if (!body.doc && !body.order && !body.pages) return null

  const rev: Revision = {
    id: uid('rev'),
    at: new Date().toISOString(),
    ...(label ? { label } : {}),
    ...body,
  }
  const kept = pruneRevisions([...revs, rev])
  if (kept.length) (doc as { revisions?: Revision[] }).revisions = kept
  else delete (doc as { revisions?: Revision[] }).revisions
  return kept.length ? rev : null
}

/** Remove history from a document. No key, never an empty array. */
export function clearHistory(doc: SpacesDoc): void {
  delete (doc as { revisions?: Revision[] }).revisions
}

/**
 * A document with the content of revision `index` and everything else — id,
 * assets, collaboration, and the history list itself — left as it is.
 *
 * Restoring is an EDIT, not a rewind of the file: the space keeps being the
 * same document, and the revisions that describe how it got here are still the
 * truth about that. `store.replaceDoc` checkpoints undo, so ⌘Z walks it back.
 */
export function restoredDoc(doc: SpacesDoc, index: number): SpacesDoc | null {
  const revs = revisionsOf(doc)
  const state = applyRevisions(revs, index)
  if (!state) return null
  const out = clone(doc)
  out.title = state.title
  if (state.home !== undefined) out.home = state.home
  else delete out.home
  out.theme = state.theme
  out.pages = state.pages
  return out
}

// ---------------------------------------------------------------------------
// The diff view.
//
// GRANULARITY IS WORDS. `type/src/redline.ts` argues it and the argument holds
// verbatim here: line diffs are useless on prose, because a reflowed paragraph
// reads as wholly rewritten; character diffs are technically correct and
// unreadable, marking "30" → "60" as a change of one glyph nobody can see.
// A space is prose in short blocks, which is the case that argument is about.
//
// NOT IMPORTED FROM THERE, deliberately. `redline.ts` is bento/type's runtime,
// in bento/type's zone; importing it would put another app's code in this
// shell and couple two zones' release cycles for forty lines of LCS. The
// REASONING is what is shared, and it is cited rather than copied.
// ---------------------------------------------------------------------------

/** Words and the whitespace between them, so a join is lossless. */
export function words(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? []
}

export interface DiffPart { op: 'eq' | 'del' | 'ins'; text: string }

/**
 * Above this many token PAIRS the LCS table is not built.
 *
 * O(n·m) is fine for a paragraph and not for a pasted transcript. Past the cap
 * the block is reported as replaced whole, which is honest — it is what a
 * reader would conclude anyway — rather than freezing the dialog.
 */
const LCS_CAP = 400_000

/** Word-level diff, returned as runs. */
export function diffWords(a: string, b: string): DiffPart[] {
  const A0 = words(a), B0 = words(b)
  if (!A0.length && !B0.length) return []

  // Trim the common head and tail first: in an edit most of a paragraph is
  // untouched, and this is the difference between instant and quadratic.
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
  /** the page's title AFTER the change, or before it when the page was removed */
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
  titleChanged: boolean
  themeChanged: boolean
}

const blockText = (b: Block): string => {
  if (Array.isArray(b.rows)) return b.rows.map((r) => r.map((c) => textOf(c)).join('\t')).join('\n')
  const t = textOf(b.html)
  return t || String(b.caption ?? b.alt ?? '')
}

/** What changed between two content states, ready to render. */
export function compareContent(
  from: SpaceContent | null,
  to: SpaceContent | null,
): ChangeReport {
  const rep: ChangeReport = {
    pages: [], pagesChanged: 0, blocksChanged: 0, titleChanged: false, themeChanged: false,
  }
  if (!to) return rep
  rep.titleChanged = !!from && from.title !== to.title
  rep.themeChanged = !!from && j(from.theme) !== j(to.theme)

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
    if (!q) {
      rep.pages.push({ id: p.id, title: p.title, kind: 'added', blocks })
    } else if (blocks.length || q.title !== p.title || j(metaOf(q)) !== j(metaOf(p))) {
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
export function changesAt(revs: Revision[], index: number): ChangeReport {
  return compareContent(applyRevisions(revs, index - 1), applyRevisions(revs, index))
}

/** Serialized bytes history currently costs this file. */
export function historyBytes(doc: SpacesDoc): number {
  const r = revisionsOf(doc)
  return r.length ? bytes(r) : 0
}
