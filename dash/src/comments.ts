// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Comments — the half of a workbook that is an argument rather than data.
//
// A spreadsheet a team uses is a spreadsheet a team disagrees about. "Is this
// the right basis?", "this row is double-counted", "agreed with finance, leave
// it" — none of that is a number, none of it belongs in a cell, and all of it
// has to travel in the file, because the file is the product (PLATFORM §1).
//
// WHERE THEY LIVE. `Sheet.comments`, an ADDITIVE array (PLATFORM §3): a build
// that has never heard of comments round-trips them untouched, which is the
// only reason this can ship before every surface understands it.
//
// They are emphatically NOT in `sheet.cells`. That map is read by the formula
// engine, the cell-formula evaluator, the chart bindings, the totals row and
// the static preview — every one of them through `'v' in over`. A comment
// stored there would be a remark that can change a number, and the whole point
// of a comment is that it cannot. `CellOverride.note` already exists and is
// deliberately NOT reused: it is one string per cell with no author, no time,
// no thread and no resolve, and `deleteRowsAt`/`deleteColumn` take it with the
// row or column it sat on. That is the correct policy for a correction and
// exactly the wrong one for somebody's unanswered objection.
//
// WHAT A COMMENT ANCHORS TO, and why these three:
//
//   cell    `{col, rid}` — never a row POSITION and never an A1 reference.
//           Sorting and filtering are VIEW state (store.ts `view()`), so a
//           positional anchor would point at a different number the moment
//           somebody clicked a column header, with the re-sorted grid hiding
//           the evidence — the same failure `Grid.canonicalRow` exists to
//           prevent, where £22,750 was selected and £12,400 destroyed. A rid is
//           row identity and a colId is column identity; that is what they are
//           for. The marker therefore survives a sort, a filter, an insert
//           above, a delete elsewhere, a column move and a column RENAME with
//           nothing rewritten and no migration step.
//   column  `{col}` — "this column is the wrong basis" is a remark about the
//           column, not about any one of its cells.
//   sheet   `{}` — the catch-all, and where a thread about the whole sheet
//           goes. It is also what the interface offers when a cell cannot be
//           named, which is what keeps the entry point single.
//
// NO RANGE ANCHOR, and that is a refusal rather than an omission. A range has
// two honest spellings here and both drift:
//
//   * CORNERS (`{col,rid}` × 2). After a sort the two corners name rows that
//     are no longer adjacent, so "rows 4-9" silently becomes an arbitrary set
//     of rows — and it changes again on the next sort. A highlight that means
//     something different to each reader is worse than no highlight.
//   * A MEMBERSHIP LIST (every rid). Survives sorting honestly, and then fails
//     on structure: a row inserted in the middle of the span is not in the
//     list, so the range quietly stops covering what it visibly covers. The
//     comment narrows and nobody is told.
//
// So a remark about several cells is a column comment, a sheet comment, or
// several cell comments — each of which means exactly one thing forever. When
// dash grows a stable range identity (a named range is the obvious candidate,
// because it is a document object with an id) a fourth anchor kind can be
// added additively; `CommentAnchor` is an OPEN union so a file written by that
// build already parses here.
//
// WHEN THE ROW OR THE COLUMN GOES AWAY. Nothing is rewritten and nothing is
// deleted. An anchor is RESOLVED at read time, never migrated, so a comment
// whose rid or colId no longer exists becomes an ORPHAN: kept in the file,
// listed with a badge naming what it used to point at, and never drawn on any
// cell. This is the policy `CellOverride.againstHash` already states for a
// suspended override — "kept, not applied, flagged" — and it is chosen over
// the two alternatives for reasons that are not aesthetic:
//
//   * DELETING with the row would destroy a human utterance as a side effect
//     of a structural edit. `deleteRowsAt` may take a correction with it; it
//     may not take somebody's unanswered question.
//   * RE-TARGETING to the sheet on delete would need a patch minted in the
//     SAME commit as the delete, and its inverse would have to re-target back.
//     Rows are also deleted by paths this module cannot decorate —
//     `window.bento.commit`, a remote op, an older build — so the retarget
//     would sometimes not run, and the file would carry two conventions. Doing
//     nothing is the only rule every writer already obeys.
//
// The reward is that UNDO IS FREE: undoing the delete brings the row back and
// the comment re-attaches byte-identically, because it never moved.
//
// THE ONE RESIDUAL HAZARD, stated plainly. Rids are never reused (the
// `nextRid` watermark, store.ts), so a cell comment cannot land on a different
// row — EXCEPT that `nextRidFloor` (rowcol.ts) derives its floor from live
// rows, `cells` keys and the watermark, and does not read comments. A file
// whose rows were deleted by a build that had no watermark can therefore mint
// a rid a comment still names. Column ids are worse and by design: import
// slugs them from the header (import.ts), so re-importing the same CSV
// re-creates a deleted column's id and an orphaned comment ATTACHES AGAIN.
// That is tolerable here and is not tolerable for an override, and the
// asymmetry is the whole argument: an override silently rewrites a number,
// while a comment is a sentence a person reads and evaluates. A remark
// reappearing on a re-imported column of the same name is usually right and is
// always visible. `was` (below) records what the anchor named at the time so
// the reader can check rather than guess.
//
// NEVER IN THE PREVIEW, NEVER IN A STORY. preview.ts draws columns and cell
// VALUES and cannot reach this field; story.ts renders bindings. Nothing in
// this module is imported by either, and the rig proves the preview markup of
// a commented workbook contains none of its text. Comments are for the people
// editing — a thumbnail is seen by everyone with the folder open.

import './comments.css'
import { t } from './i18n.ts'
import { lsGet, lsSet } from '../../kernel/src/storage.ts'
import { colToLetters } from './a1.ts'
import { formatValue } from './format.ts'
import { hiddenSet } from './rowcol.ts'
import { readCell, type Patch, type Store } from './store.ts'
import type { Column, DashDoc, Sheet, TableSheet, Comment, CommentAnchor, CommentReply } from './model.ts'
import type { Grid } from './grid.ts'

// --- the model ---------------------------------------------------------------
//
// Declared here so it can be reviewed in one place; it belongs in model.ts
// beside `CellOverride`, which is where the report asks for it to be moved.


/** `was.value` is a caption, not a payload. Long text is a paste, not a number. */
const WAS_CHARS = 48

// --- reading -----------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The comments on a sheet, read DEFENSIVELY.
 *
 * This is an additive field, so an older build, a hand edit, an agent or a
 * newer build can put anything here and every surface still has to draw.
 * Anything unreadable is skipped rather than repaired: repairing would write to
 * the document on OPEN, and a file that changes because somebody looked at it
 * is a file whose dirty flag lies.
 */
export function sheetComments(sheet: Sheet | null | undefined): Comment[] {
  const raw = (sheet as { comments?: unknown } | null | undefined)?.comments
  if (!Array.isArray(raw)) return []
  return raw.filter((c): c is Comment =>
    isObj(c) && typeof c.id === 'string' && typeof c.text === 'string' && isObj(c.anchor)
      && typeof (c.anchor as { kind?: unknown }).kind === 'string')
}

export const unresolvedCount = (sheet: Sheet | null | undefined): number =>
  sheetComments(sheet).reduce((n, c) => n + (c.resolved ? 0 : 1), 0)

/** Canonical row index → rid. Walks the run-length runs; -1 past the end. */
export function ridOfRow(sheet: TableSheet, row: number): number {
  let i = 0
  for (const [start, count] of sheet.rids) {
    if (row < i + count) return start + (row - i)
    i += count
  }
  return -1
}

/** rid → canonical row index, or -1 when the row is gone. */
export function rowOfRid(sheet: TableSheet, rid: number): number {
  let i = 0
  for (const [start, count] of sheet.rids) {
    if (rid >= start && rid < start + count) return i + (rid - start)
    i += count
  }
  return -1
}

export interface ResolvedAnchor {
  /** `orphan` = the row or column it names is gone; `unknown` = a newer build's kind */
  state: 'live' | 'orphan' | 'unknown'
  kind: string
  col?: Column
  rid?: number
  /** CANONICAL data row, 0-based — never a visible one */
  row?: number
  /** live, but the author has hidden the column it sits on */
  hidden?: boolean
  /** what went missing, for the badge */
  why?: 'row' | 'column'
}

/**
 * Where a comment points RIGHT NOW.
 *
 * Called on every paint and every list build, so it walks the rid runs rather
 * than expanding them. Nothing here writes: resolution is a read, which is the
 * entire orphan policy in one sentence.
 */
export function resolveAnchor(sheet: TableSheet, a: CommentAnchor): ResolvedAnchor {
  const kind = a.kind
  if (kind === 'sheet') return { state: 'live', kind }

  if (kind === 'column' || kind === 'cell') {
    const colId = (a as { col?: unknown }).col
    const col = typeof colId === 'string'
      ? sheet.columns.find((c) => c.id === colId)
      : undefined
    // The column goes first: when both halves are gone, the column is the
    // bigger loss and is the one the badge should name.
    if (!col) return { state: 'orphan', kind, why: 'column' }
    const hidden = hiddenSet(sheet).has(col.id)
    if (kind === 'column') return { state: 'live', kind, col, hidden }

    const rid = (a as { rid?: unknown }).rid
    if (typeof rid !== 'number' || !Number.isFinite(rid)) {
      return { state: 'orphan', kind, col, why: 'row' }
    }
    const row = rowOfRid(sheet, rid)
    return row < 0
      ? { state: 'orphan', kind, col, rid, why: 'row' }
      : { state: 'live', kind, col, rid, row, hidden }
  }

  return { state: 'unknown', kind }
}

/**
 * The A1-style handle for a live anchor.
 *
 * A1 counts `sheet.columns` — every column, hidden included — and the sheet's
 * OWN row order, exactly as cellformula.ts does. Two people looking at one file
 * through different sorts have to be able to say "C13" and mean the same cell.
 */
export function anchorRef(sheet: TableSheet, r: ResolvedAnchor): string {
  if (!r.col) return ''
  const ci = sheet.columns.findIndex((c) => c.id === r.col!.id)
  if (ci < 0) return ''
  const letter = colToLetters(ci)
  if (r.kind === 'column') return `${letter}:${letter}`
  return typeof r.row === 'number' ? `${letter}${r.row + 1}` : ''
}

/** The cell a comment names, as the grid would show it. Blank for anything else. */
export function anchorValue(
  sheet: TableSheet, r: ResolvedAnchor, computed?: Map<string, unknown[]>,
): string {
  if (r.state !== 'live' || r.kind !== 'cell' || !r.col || typeof r.row !== 'number') return ''
  const over = sheet.cells?.[`${r.col.id}:${r.rid}`]
  const comp = computed?.get(r.col.id)
  // The same precedence the grid paints with, minus the per-cell formula —
  // which needs the whole evaluator, and a caption is not worth recalculating a
  // sheet for. A commented formula cell shows its stored value or nothing,
  // never a number this module invented.
  const v = comp ? comp[r.row]
    : over && 'v' in over ? over.v
      : readCell(sheet.data[r.col.id], r.row)
  return v == null ? '' : formatValue(v, r.col)
}

/** One line naming what a thread is about, for the popover head and the list. */
export function anchorLabel(sheet: TableSheet, r: ResolvedAnchor, was?: Comment['was']): string {
  if (r.state === 'unknown') return t('an anchor this build does not know ({kind})').replace('{kind}', r.kind)
  if (r.state === 'orphan') {
    const name = was?.col ?? (r.col?.name ?? '')
    return r.why === 'column'
      ? name
        ? t('a deleted column ({name})').replace('{name}', name)
        : t('a deleted column')
      : name
        ? t('a deleted row of {name}').replace('{name}', name)
        : t('a deleted row')
  }
  if (r.kind === 'sheet') return sheet.name || t('this sheet')
  if (r.kind === 'column') return `${r.col?.name ?? ''} · ${anchorRef(sheet, r)}`
  return `${r.col?.name ?? ''} · ${t('row {n}').replace('{n}', String((r.row ?? 0) + 1))} · ${anchorRef(sheet, r)}`
}

// --- the flat list: window.bento.comments() ----------------------------------

/**
 * One comment, flattened for an agent.
 *
 * The point of this shape is that a model can act on it WITHOUT opening the
 * document: `sheet` + `ref` locate the cell in words a spreadsheet user uses,
 * `value` says what it currently reads, and `live` says whether the thing being
 * argued about still exists. Slides' `window.bento.comments()` is the same
 * idea; this one carries dash's identities as well as its coordinates, because
 * `ref` moves when a column is inserted and `anchor` does not.
 */
export interface FlatComment {
  id: string
  sheet: string
  sheetName: string
  anchor: CommentAnchor
  /** 'cell' | 'column' | 'sheet' | whatever a newer build wrote */
  kind: string
  /** false when the row or the column it names has been deleted */
  live: boolean
  /** "C13", "C:C", or '' for a sheet-level or orphaned thread */
  ref: string
  column?: string
  /** 1-based, in the sheet's own order — never the reader's sorted view */
  row?: number
  /** what the cell reads now, formatted as the grid shows it */
  value?: string
  /** what the anchor named when the comment was written */
  was?: Comment['was']
  author: string
  at: string
  text: string
  resolved: boolean
  replies: Array<{ author: string; at: string; text: string }>
}

/**
 * Every comment in the workbook, resolved. THE entry point for an agent
 * processing flagged issues — the same role slides gives its own.
 *
 * Sheets that are not table sheets are walked too: a pivot or a canvas sheet
 * can carry the field even though this build's writer cannot yet put one there
 * (see the report), and a reader that skipped them would make those threads
 * invisible rather than merely uneditable.
 */
export function flatComments(doc: DashDoc): FlatComment[] {
  const out: FlatComment[] = []
  for (const sheet of doc.sheets) {
    for (const c of sheetComments(sheet)) {
      const table = sheet.kind === 'table' ? sheet as TableSheet : null
      const r = table ? resolveAnchor(table, c.anchor) : null
      out.push({
        id: c.id,
        sheet: sheet.id,
        sheetName: sheet.name,
        anchor: c.anchor,
        kind: c.anchor.kind,
        live: r ? r.state === 'live' : true,
        ref: table && r ? anchorRef(table, r) : '',
        ...(r?.col ? { column: r.col.name } : {}),
        ...(typeof r?.row === 'number' ? { row: r.row + 1 } : {}),
        ...(table && r ? { value: anchorValue(table, r) } : {}),
        ...(c.was ? { was: c.was } : {}),
        author: c.author,
        at: c.at,
        text: c.text,
        resolved: c.resolved === true,
        replies: (c.replies ?? []).map((x) => ({ author: x.author, at: x.at, text: x.text })),
      })
    }
  }
  return out
}

// --- writing: patch factories ------------------------------------------------
//
// EVERY WRITE IS A PATCH AND NOTHING HERE MUTATES — rowcol.ts's rule, for
// rowcol.ts's reason: the same Patch objects are the undo entries, the CRDT ops
// and the agent API, so a comment written by assignment would be an edit with
// no inverse and no op.
//
// They all ride on `setSheetProps`, which writes the WHOLE array as one value.
// That has a real cost and it is stated rather than hidden: the inverse carries
// the previous array (so a workbook of 500 threads makes ~75KB undo entries,
// against a 24MB cap), and under collaboration the array is ONE last-writer-
// wins register — two people adding a thread at the same instant keep one. That
// is the same documented compromise slides' table `rows` makes. The fix is a
// per-comment op keyed by id, exactly as `setView` is keyed by view id; it is
// named in the report and is a drop-in replacement for `writeComments` below.

/**
 * THE FACTORIES BELOW REWRITE THE WHOLE ARRAY, so they must start from the RAW
 * one and not from `sheetComments`.
 *
 * `sheetComments` skips anything it cannot read — an entry from a newer build
 * with a shape this one does not recognise, or a hand edit. Mapping the READ
 * list back over the field would then delete every one of those as a side
 * effect of somebody clicking Reply: silent loss of another build's data, which
 * is precisely the additivity invariant (PLATFORM §3), failing in the one place
 * nobody would look for it. So entries are matched by id and passed through
 * untouched otherwise.
 */
const rawComments = (sheet: TableSheet): unknown[] => {
  const raw = (sheet as { comments?: unknown }).comments
  return Array.isArray(raw) ? raw : []
}

const idOf = (c: unknown): string | undefined =>
  isObj(c) && typeof c.id === 'string' ? c.id : undefined

/** Set the array, or DROP the key when it empties — an additive field that
 *  means "no comments" must be ABSENT, or adding and deleting one leaves the
 *  workbook changed and every reader diffs it. `freezeAt` states the same rule. */
function writeComments(sheet: TableSheet, next: unknown[]): Patch {
  return next.length
    ? { op: 'setSheetProps', sheet: sheet.id, props: { comments: next } }
    : { op: 'setSheetProps', sheet: sheet.id, props: {}, drop: ['comments'] }
}

/** A fresh id. Random, never derived: two replicas must not mint the same one. */
export function commentId(): string {
  const rnd = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10)
  return `cmt-${rnd}`
}

/** Mint a comment, capturing what its anchor named at the time. */
export function newComment(
  sheet: TableSheet, anchor: CommentAnchor, author: string, text: string,
  computed?: Map<string, unknown[]>,
): Comment {
  const r = resolveAnchor(sheet, anchor)
  const was: NonNullable<Comment['was']> = {}
  if (r.col) was.col = r.col.name
  if (typeof r.row === 'number') was.row = r.row + 1
  const v = anchorValue(sheet, r, computed)
  if (v) was.value = v.length > WAS_CHARS ? `${v.slice(0, WAS_CHARS - 1)}…` : v
  return {
    id: commentId(), anchor, author, text,
    at: new Date().toISOString(),
    ...(Object.keys(was).length ? { was } : {}),
  }
}

export function addCommentPatch(sheet: TableSheet, c: Comment): Patch {
  return writeComments(sheet, [...rawComments(sheet), c])
}

/** Nothing to reply to returns NOTHING — `commit([])` still pushes an undo
 *  entry, and a ⌘Z that visibly does nothing is a bug report (rowcol.ts). */
export function replyPatch(
  sheet: TableSheet, id: string, author: string, text: string,
): Patch | null {
  if (!sheetComments(sheet).some((c) => c.id === id)) return null
  const reply: CommentReply = { id: commentId(), author, text, at: new Date().toISOString() }
  return writeComments(sheet, rawComments(sheet).map((c) => {
    if (idOf(c) !== id) return c
    const t2 = c as Comment
    return { ...t2, replies: [...(t2.replies ?? []), reply] }
  }))
}

/**
 * Resolve or reopen.
 *
 * Reopening DELETES the key rather than writing `false`. In memory the two are
 * the same; in the FILE they are not, and `resolved: false` would accumulate on
 * every thread anybody ever ticked, in every saved copy, forever — the argument
 * `setHidden` makes for `hidden`, with the wire hazard reversed: this key never
 * has to travel as a delete, because the whole array is rewritten anyway.
 */
export function setResolvedPatch(sheet: TableSheet, id: string, resolved: boolean): Patch | null {
  const cur = sheetComments(sheet).find((c) => c.id === id)
  if (!cur || (cur.resolved === true) === resolved) return null
  return writeComments(sheet, rawComments(sheet).map((c) => {
    if (idOf(c) !== id) return c
    if (resolved) return { ...(c as Comment), resolved: true }
    const { resolved: _drop, ...rest } = c as Comment
    return rest as Comment
  }))
}

export function deleteCommentPatch(sheet: TableSheet, id: string): Patch | null {
  if (!sheetComments(sheet).some((c) => c.id === id)) return null
  return writeComments(sheet, rawComments(sheet).filter((c) => idOf(c) !== id))
}

// --- who is commenting -------------------------------------------------------

const LS_AUTHOR = 'bento-author'

/**
 * The commenter's name, remembered per browser and never sent anywhere.
 *
 * The SAME key slides uses, deliberately: it is one person at one browser, and
 * being asked your name again because you switched Bento app would read as the
 * suite forgetting who you are. It is not in the document (a name is not
 * document data until it is attached to something somebody wrote) and it is not
 * synced.
 */
export const commentAuthor = (): string => lsGet(LS_AUTHOR)?.trim() ?? ''

export function setCommentAuthor(name: string): string {
  const n = name.trim()
  if (n) lsSet(LS_AUTHOR, n)
  return n
}

/** "just now" / "4m ago" / a date. Formatted for the VIEWER; the file has ISO. */
export function relTime(iso: string, now = Date.now()): string {
  const s = (now - new Date(iso).getTime()) / 1000
  if (!Number.isFinite(s) || s < 45) return t('just now')
  if (s < 3600) return t('{n}m ago').replace('{n}', String(Math.round(s / 60)))
  if (s < 86400) return t('{n}h ago').replace('{n}', String(Math.round(s / 3600)))
  if (s < 86400 * 30) return t('{n}d ago').replace('{n}', String(Math.round(s / 86400)))
  return new Date(iso).toLocaleDateString()
}

// --- the interface -----------------------------------------------------------
//
// Everything below touches the DOM. The half above does not, which is what lets
// `scripts/test-dash-comments.ts` hold the anchor rules to a sort, a filter, an
// insert, a delete and a JSON round trip with no browser in the room.

export interface CommentsHost {
  store: Store
  grid: Grid
  /** the grid's host element — main.ts's `.dx-grid`. Markers and the pill live in it. */
  el: HTMLElement
}

/** Grid geometry this module has to agree with, read from the grid rather than
 *  copied: `Grid` writes `--row-h` onto its host from its own ROW_H constant
 *  precisely so a second reader cannot drift from it. */
const rowHeight = (el: HTMLElement): number => {
  const v = parseFloat(getComputedStyle(el).getPropertyValue('--row-h'))
  return Number.isFinite(v) && v > 0 ? v : 20
}

export class CommentsUI {
  private store: Store
  private grid: Grid
  private el: HTMLElement
  private pill: HTMLElement
  private obs: MutationObserver | null = null
  private offs: Array<() => void> = []
  /** the thread just created, so its marker can announce itself once */
  private fresh: string | null = null

  constructor(host: CommentsHost) {
    this.store = host.store
    this.grid = host.grid
    this.el = host.el

    this.pill = document.createElement('button')
    this.pill.className = 'dxc-pill'
    this.pill.addEventListener('click', (e) => {
      e.stopPropagation()
      const r = this.pill.getBoundingClientRect()
      this.openList(r.left, r.top)
    })
    this.el.appendChild(this.pill)

    // THE MARKERS ARE RE-INJECTED AFTER EVERY PAINT, and this observer is how
    // this module learns a paint happened without editing grid.ts. `paint()`
    // replaces `.dg-sizer` and `.dg-head-row` wholesale — on a document change,
    // a view change, a scroll, a selection move and a resize — so a childList
    // observer on exactly those two nodes sees every one of them.
    //
    // NOT `subtree: true`, and that is the load-bearing half: markers are
    // injected into `.dg-row > .dg-cell` and into `.dg-h`, which are children
    // of children, so a non-subtree observer cannot see this module's own
    // writes and cannot feed itself. A one-line `onPaint` hook in Grid would
    // replace all of this; until there is one, this costs one microtask per
    // paint and reads no layout.
    const sizer = this.el.querySelector('.dg-sizer')
    const head = this.el.querySelector('.dg-head-row')
    if (sizer && head) {
      this.obs = new MutationObserver(() => this.paintMarkers())
      this.obs.observe(sizer, { childList: true })
      this.obs.observe(head, { childList: true })
    }

    this.offs.push(this.store.on('doc', () => this.refresh()))
    this.offs.push(this.store.on('view', () => this.refresh()))

    // SWITCHING SHEETS emits no store event — `Grid.setSheet` repaints and
    // nothing else — so the markers would follow (the observer sees the paint)
    // while the PILL kept the previous sheet's count. CHAIN the callback, never
    // replace it: panels.ts is already on it, and main.ts states the rule for
    // `onSelectionChange` in the same words. Mount this AFTER mountPanels or
    // the chain is built the wrong way round.
    const wasSheetChange = this.grid.onSheetChange
    this.grid.onSheetChange = (id: string): void => {
      wasSheetChange?.(id)
      this.refresh()
    }

    // ⌘⌥M / Ctrl+Alt+M — Sheets' shortcut for the same act. It cannot collide
    // with the grid's typing path, which main.ts gates on no modifier at all.
    this.onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || !e.altKey) return
      if (e.key.toLowerCase() !== 'm') return
      e.preventDefault()
      this.commentOnSelection()
    }
    document.addEventListener('keydown', this.onKey)

    this.refresh()
  }

  private onKey: (e: KeyboardEvent) => void

  /** The sheet the grid is showing, or null mid-replaceDoc / on a pivot sheet. */
  private sheet(): TableSheet | null {
    try {
      return this.grid.sheet
    } catch {
      return null
    }
  }

  refresh(): void {
    this.paintMarkers()
    this.updatePill()
  }

  destroy(): void {
    this.obs?.disconnect()
    document.removeEventListener('keydown', this.onKey)
    for (const off of this.offs) off()
    this.pill.remove()
    for (const el of this.el.querySelectorAll('.dxc-mark, .dxc-hmark')) el.remove()
  }

  private updatePill(): void {
    const sheet = this.sheet()
    const open = unresolvedCount(sheet)
    const all = sheetComments(sheet).length
    this.pill.classList.toggle('dxc-pill-on', open > 0)
    this.pill.textContent = open ? `💬 ${open}` : '💬'
    this.pill.title = all
      ? t('{open} open of {all} comment(s) — click to list them, ⌘⌥M to add one')
        .replace('{open}', String(open)).replace('{all}', String(all))
      : t('No comments yet — click to add one, or press ⌘⌥M')
  }

  // --- markers ---------------------------------------------------------------

  /**
   * Draw a marker on every commented cell and column that is CURRENTLY PAINTED.
   *
   * The grid is windowed, so a comment 40,000 rows down has no cell to sit on
   * and simply has no marker — the pill and the list are what make it findable.
   * The lookup is by `data-rid`, which is the identity the grid already stamps
   * on each row: that is why a marker follows a sort and a filter without this
   * module knowing either exists.
   */
  private paintMarkers(): void {
    for (const el of this.el.querySelectorAll('.dxc-mark, .dxc-hmark')) el.remove()
    const sheet = this.sheet()
    if (!sheet) return
    const list = sheetComments(sheet)
    if (!list.length) return
    // Keyed `colId SEP rid`. The separator is U+001F and it is written as an
    // ESCAPE, never as a literal — an invisible control character in source
    // does not survive being retyped (the lesson slides records in
    // markdown.ts). It is the CRDT's composite-key separator, chosen for the
    // same reason: a column id is author-derived — import slugs it from the
    // header — so it can hold any byte a header can, including the colon that
    // `cells` keys already use.
    const cells = new Map<string, Comment[]>()
    const columns = new Map<string, Comment[]>()
    for (const c of list) {
      const r = resolveAnchor(sheet, c.anchor)
      if (r.state !== 'live' || r.hidden || !r.col) continue
      const map = r.kind === 'cell' ? cells : r.kind === 'column' ? columns : null
      if (!map) continue
      const key = r.kind === 'cell' ? `${r.col.id}\u001F${r.rid}` : r.col.id
      const at = map.get(key) ?? []
      at.push(c)
      map.set(key, at)
    }

    for (const [key, threads] of cells) {
      const sep = key.indexOf('\u001F')
      const colId = key.slice(0, sep)
      const rid = Number(key.slice(sep + 1))
      // `data-rid` is a number this module produced from the sheet's own runs,
      // so it is safe to interpolate; the COLUMN id is author-derived (import
      // slugs the header) and is compared as a value rather than spliced into a
      // selector, where a quote would be a broken query or worse.
      const row = this.el.querySelector<HTMLElement>(`.dg-row[data-rid="${rid}"]`)
      if (!row) continue
      for (const cell of row.querySelectorAll<HTMLElement>('.dg-cell[data-col]')) {
        if (cell.dataset.col !== colId) continue
        cell.appendChild(this.marker(threads, 'dxc-mark'))
        break
      }
    }

    for (const [colId, threads] of columns) {
      for (const h of this.el.querySelectorAll<HTMLElement>('.dg-head-row .dg-h[data-col]')) {
        if (h.dataset.col !== colId) continue
        // Into the header's own flow row, before the filter caret, rather than
        // absolutely positioned over it: the header is two tight lines already
        // and the resize grip owns the right edge.
        const main = h.querySelector('.dg-hmain')
        const mark = this.marker(threads, 'dxc-hmark')
        if (main) main.insertBefore(mark, main.querySelector('.dg-filter'))
        else h.appendChild(mark)
        break
      }
    }
  }

  /** The corner triangle. Excel's placement, and it covers no digit at 7px. */
  private marker(threads: Comment[], cls: string): HTMLElement {
    const b = document.createElement('button')
    const open = threads.filter((c) => !c.resolved)
    const show = open[0] ?? threads[0]
    b.className = `${cls}${open.length ? '' : ' dxc-done'}`
    if (threads.some((c) => c.id === this.fresh)) {
      b.classList.add('dxc-fresh')
      setTimeout(() => { this.fresh = null }, 1400)
    }
    b.title = `${show.author}: ${show.text.slice(0, 120)}` +
      (threads.length > 1 ? `  (+${threads.length - 1})` : '')
    b.setAttribute('aria-label', t('Comment'))
    // A marker is a CLICK TARGET INSIDE A CELL, so it must not reach the cell's
    // own mousedown — which starts a selection drag. Selection is unchanged by
    // reading a comment, exactly as hovering a note in Excel does not move the
    // cursor.
    b.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault() })
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      const r = b.getBoundingClientRect()
      if (threads.length === 1) this.openThread(show.id, r.right, r.bottom)
      else this.openList(r.right, r.bottom, threads.map((c) => c.id))
    })
    return b
  }

  // --- composing -------------------------------------------------------------

  /**
   * Comment on what is selected. THE entry point, and it always has an answer:
   * a cell under the cursor anchors to the cell, and anything else — no
   * columns, a filtered-away row, a sheet with no rows — anchors to the SHEET
   * rather than refusing. Slides makes the same call for a click on the grey
   * surround.
   */
  commentOnSelection(): void {
    const sheet = this.sheet()
    if (!sheet || this.store.readOnly) return
    const anchor = this.selectionAnchor(sheet)
    const cell = this.el.querySelector<HTMLElement>('.dg-cell.dg-cursor')
    const r = cell?.getBoundingClientRect()
    const p = this.pill.getBoundingClientRect()
    this.openCompose(anchor, r ? r.right : p.left, r ? r.bottom : p.top)
  }

  /** Cell under the cursor → a cell anchor; nothing addressable → the sheet. */
  private selectionAnchor(sheet: TableSheet): CommentAnchor {
    const hidden = hiddenSet(sheet)
    const visible = sheet.columns.filter((c) => !hidden.has(c.id))
    const col = visible[this.grid.sel.cursor.col]
    if (!col) return { kind: 'sheet' }
    // The cursor counts VISIBLE rows; a comment names a rid. Going through
    // `canonicalRow` is what makes the anchor mean the same cell to a reader
    // whose sort is different — the conversion `Grid.canonicalRow` exists for.
    const row = this.grid.canonicalRow(this.grid.sel.cursor.row)
    if (row < 0) return { kind: 'sheet' }
    const rid = ridOfRow(sheet, row)
    return rid < 0 ? { kind: 'sheet' } : { kind: 'cell', col: col.id, rid }
  }

  private openCompose(anchor: CommentAnchor, x: number, y: number): void {
    const sheet = this.sheet()
    if (!sheet) return
    const r = resolveAnchor(sheet, anchor)
    const pop = this.pop(x, y)

    this.head(pop, t('Comment on {what}').replace('{what}', anchorLabel(sheet, r)))
    const v = anchorValue(sheet, r, this.computed())
    if (v) this.note(pop, t('reads {value}').replace('{value}', v))

    const who = this.authorRow(pop)
    const ta = document.createElement('textarea')
    ta.className = 'dxc-text'
    ta.rows = 3
    ta.placeholder = t('What is wrong with this number?')
    pop.appendChild(ta)

    const foot = document.createElement('div')
    foot.className = 'dxc-foot'
    const add = this.btn(t('Comment'), () => {
      const text = ta.value.trim()
      const author = setCommentAuthor(who.value) || t('Anonymous')
      if (!text) { ta.focus(); return }
      const live = this.sheet()
      if (!live) return
      const c = newComment(live, anchor, author, text, this.computed())
      this.fresh = c.id
      this.store.commit(addCommentPatch(live, c))
      pop.remove()
      this.refresh()
    }, 'dxc-primary')
    foot.append(add, this.btn(t('Cancel'), () => pop.remove()))
    pop.appendChild(foot)

    // ⌘Enter commits, because a textarea owns Enter and a comment is a
    // sentence, not a cell value.
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); add.click() }
    })
    ;(who.value ? ta : who).focus()
  }

  // --- one thread ------------------------------------------------------------

  private openThread(id: string, x: number, y: number): void {
    const sheet = this.sheet()
    if (!sheet) return
    const c = sheetComments(sheet).find((x2) => x2.id === id)
    if (!c) return
    const r = resolveAnchor(sheet, c.anchor)
    const pop = this.pop(x, y)

    this.head(pop, anchorLabel(sheet, r, c.was), r.state !== 'live'
      ? r.state === 'orphan' ? t('orphaned') : t('unknown anchor') : undefined)

    if (r.state === 'orphan') {
      // WHY THE THREAD IS STILL HERE, said in the interface and not only in a
      // comment in the source. A reader who cannot find the row must be told
      // that the row went, not left to conclude the comment is broken.
      this.note(pop, c.was?.value
        ? t('The {what} this comment was on has been deleted. It read {value}.')
          .replace('{what}', r.why === 'column' ? t('column') : t('row'))
          .replace('{value}', c.was.value)
        : t('The {what} this comment was on has been deleted. The comment is kept.')
          .replace('{what}', r.why === 'column' ? t('column') : t('row')))
    } else if (r.state === 'live' && r.kind === 'cell') {
      const now = anchorValue(sheet, r, this.computed())
      const then = c.was?.value
      this.note(pop, then && then !== now
        ? t('now {now} — was {then} when this was written')
          .replace('{now}', now || '—').replace('{then}', then)
        : t('reads {value}').replace('{value}', now || '—'))
    }

    const entries = document.createElement('div')
    entries.className = 'dxc-entries'
    const entry = (author: string, at: string, text: string): void => {
      const e = document.createElement('div')
      e.className = 'dxc-entry'
      const b = document.createElement('b')
      b.textContent = author
      const when = document.createElement('span')
      when.className = 'dxc-when'
      when.textContent = relTime(at)
      when.title = at
      const p = document.createElement('p')
      // textContent, never innerHTML: a comment is user text and the popover is
      // in the editor's own document.
      p.textContent = text
      e.append(b, when, p)
      entries.appendChild(e)
    }
    entry(c.author, c.at, c.text)
    for (const rep of c.replies ?? []) entry(rep.author, rep.at, rep.text)
    pop.appendChild(entries)

    const who = this.authorRow(pop)
    const ta = document.createElement('textarea')
    ta.className = 'dxc-text'
    ta.rows = 2
    ta.placeholder = t('Reply…')
    pop.appendChild(ta)

    const foot = document.createElement('div')
    foot.className = 'dxc-foot'
    const commit = (p: Patch | null): void => {
      if (p) this.store.commit(p)
      pop.remove()
      this.refresh()
    }
    const reply = this.btn(t('Reply'), () => {
      const text = ta.value.trim()
      const author = setCommentAuthor(who.value) || t('Anonymous')
      const live = this.sheet()
      if (!text || !live) { ta.focus(); return }
      commit(replyPatch(live, id, author, text))
    }, 'dxc-primary')
    foot.append(
      reply,
      this.btn(c.resolved ? t('Reopen') : t('Resolve'), () => {
        const live = this.sheet()
        if (live) commit(setResolvedPatch(live, id, !c.resolved))
      }),
      this.btn(t('Delete'), () => {
        const live = this.sheet()
        if (live) commit(deleteCommentPatch(live, id))
      }, 'dxc-danger'),
    )
    if (r.state === 'live' && r.kind !== 'sheet') {
      foot.append(this.btn(t('Go to'), () => { pop.remove(); this.goTo(r) }))
    }
    pop.appendChild(foot)
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); reply.click() }
    })
    ta.focus()
  }

  // --- the list --------------------------------------------------------------

  /** Every thread on this sheet: open first, then orphans, then resolved. */
  private openList(x: number, y: number, only?: string[]): void {
    const sheet = this.sheet()
    const pop = this.pop(x, y, 'dxc-list')
    if (!sheet) {
      this.note(pop, t('No table sheet is open.'))
      return
    }
    const pick = only ? new Set(only) : null
    const all = sheetComments(sheet).filter((c) => !pick || pick.has(c.id))
    const rank = (c: Comment): number => {
      if (c.resolved) return 2
      return resolveAnchor(sheet, c.anchor).state === 'live' ? 0 : 1
    }
    const sorted = [...all].sort((a, b) => rank(a) - rank(b) || (a.at < b.at ? -1 : 1))

    this.head(pop, t('Comments on {sheet}').replace('{sheet}', sheet.name))
    if (!sorted.length) this.note(pop, t('Nothing has been flagged on this sheet yet.'))

    let group = -1
    for (const c of sorted) {
      const g = rank(c)
      if (g !== group) {
        group = g
        const h = document.createElement('div')
        h.className = 'dxc-group'
        h.textContent = g === 0 ? t('Open') : g === 1 ? t('Orphaned') : t('Resolved')
        pop.appendChild(h)
      }
      const r = resolveAnchor(sheet, c.anchor)
      const item = document.createElement('button')
      item.className = `dxc-item${c.resolved ? ' dxc-done' : ''}`
      const where = document.createElement('span')
      where.className = 'dxc-where'
      where.textContent = anchorLabel(sheet, r, c.was)
      const line = document.createElement('span')
      line.className = 'dxc-line'
      line.textContent = `${c.author}: ${c.text}`
      item.append(where, line)
      item.addEventListener('click', (e) => {
        e.stopPropagation()
        pop.remove()
        const rect = item.getBoundingClientRect()
        this.openThread(c.id, rect.right, rect.top)
      })
      pop.appendChild(item)
    }

    if (!this.store.readOnly) {
      const foot = document.createElement('div')
      foot.className = 'dxc-foot'
      foot.append(this.btn(t('＋ Comment on the selected cell'), () => {
        pop.remove()
        this.commentOnSelection()
      }, 'dxc-primary'))
      pop.appendChild(foot)
    }
  }

  /**
   * Scroll a live anchor into view and put the cursor on it.
   *
   * The row may be filtered AWAY, which is not an error and must not be
   * silently ignored — the reader asked to go somewhere and has to be told why
   * they did not arrive.
   *
   * KNOWN WART: the formula bar and the status bar are driven by the grid's own
   * private `announce()`, so they keep showing the previous cell until the next
   * click or keystroke. One word (`private announce` → `announce`) fixes it;
   * see the report.
   */
  private goTo(r: ResolvedAnchor): void {
    const sheet = this.sheet()
    if (!sheet || !r.col) return
    const hidden = hiddenSet(sheet)
    const vcol = sheet.columns.filter((c) => !hidden.has(c.id)).findIndex((c) => c.id === r.col!.id)
    if (vcol < 0) return
    if (r.kind === 'column' || typeof r.row !== 'number') {
      this.grid.sel.selectCol(vcol)
      this.grid.paint()
      return
    }
    const order = this.store.order[sheet.id]
    const vrow = order ? order.indexOf(r.row) : r.row
    if (vrow < 0) {
      window.alert(t('That row is hidden by the current filter.'))
      return
    }
    const scroll = this.el.querySelector<HTMLElement>('.dg-scroll')
    if (scroll) {
      const h = rowHeight(this.el)
      scroll.scrollTop = Math.max(0, vrow * h - scroll.clientHeight / 2)
    }
    this.grid.sel.moveTo(vrow, vcol)
    this.grid.paint()
  }

  // --- popover furniture -------------------------------------------------------
  //
  // `.dx-pop` IS REUSED RATHER THAN RE-STYLED. The filter menu, the retype
  // menu, the cell menu and the save menu are all one floating surface; a
  // comment popover that looked like a fifth thing would read as a different
  // application. comments.css only adds what a THREAD needs and nothing the
  // surface already provides.

  private pop(x: number, y: number, extra = ''): HTMLElement {
    document.querySelector('.dx-pop')?.remove()
    const el = document.createElement('div')
    el.className = `dx-pop dxc-pop ${extra}`.trim()
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 320))}px`
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 260))}px`
    document.body.appendChild(el)
    // Keystrokes inside the popover are the popover's. Without this, typing a
    // comment reaches main.ts's document handler, which hands any bare
    // printable key to `grid.typeInto` — every letter would also start editing
    // the selected cell.
    el.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') el.remove()
    })
    setTimeout(() => {
      const off = (e: MouseEvent): void => {
        if (!el.contains(e.target as Node)) {
          el.remove()
          document.removeEventListener('mousedown', off)
        }
      }
      document.addEventListener('mousedown', off)
    }, 0)
    return el
  }

  private head(pop: HTMLElement, label: string, badge?: string): void {
    const h = document.createElement('div')
    h.className = 'dxc-head'
    const s = document.createElement('span')
    s.textContent = label
    h.appendChild(s)
    if (badge) {
      const b = document.createElement('span')
      b.className = 'dxc-badge'
      b.textContent = badge
      h.appendChild(b)
    }
    pop.appendChild(h)
  }

  private note(pop: HTMLElement, text: string): void {
    const p = document.createElement('p')
    p.className = 'dxc-note'
    p.textContent = text
    pop.appendChild(p)
  }

  /** The name new entries will carry — editable in place, never a native prompt.
   *  dash already refused `window.prompt` for the type picker, for the same
   *  reason: a dialog that asks you to type an answer is not a control. */
  private authorRow(pop: HTMLElement): HTMLInputElement {
    const row = document.createElement('label')
    row.className = 'dxc-who'
    const span = document.createElement('span')
    span.textContent = t('as')
    const input = document.createElement('input')
    input.className = 'dx-pop-in'
    input.type = 'text'
    input.spellcheck = false
    input.value = commentAuthor()
    input.placeholder = t('your name')
    row.append(span, input)
    pop.appendChild(row)
    return input
  }

  private btn(label: string, onClick: () => void, cls = ''): HTMLElement {
    const b = document.createElement('button')
    b.className = `dxc-btn ${cls}`.trim()
    b.textContent = label
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick() })
    return b
  }

  /** The grid's freshly computed formula columns, so a caption shows the number
   *  on screen rather than the empty column underneath it. */
  private computed(): Map<string, unknown[]> {
    return this.grid.computed as unknown as Map<string, unknown[]>
  }
}

export function mountComments(host: CommentsHost): CommentsUI {
  return new CommentsUI(host)
}
