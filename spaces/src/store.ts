// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Document state, undo history, and the TYPING RUN.
//
// Slides sidesteps commit granularity because canvas text commits on blur. A
// notes app may never blur, so this one policy sets undo granularity, autosave
// churn, the dirty flag, and later the collaboration op rate.
//
// A TYPING RUN is consecutive input in ONE block with no structural op between.
// It takes ONE checkpoint, at its first input; later inputs mutate in place. It
// closes on idle, on the caret leaving the block, on any structural change, on
// save, and on replaceDoc. One run = one undo entry = later, one text batch.

type Scope = 'doc' | 'page'

import { type SpacesDoc, type Page, type Block, buildIndex, type SpaceIndex, homePage } from './model'
import { buildTagIndex, type TagIndex } from './tags.ts'
import { FROM_LIVE, keepLiveIdentity as keepLive } from '../../kernel/src/docfields.ts'
import { SPACES_FIELDS } from './docclass.ts'

type Listener = () => void
type Event = 'doc' | 'page' | 'tree' | 'selection' | 'dirty'

/** Idle that closes a run. Autosave debounces longer, so no snapshot lands mid-run. */
const RUN_IDLE_MS = 600
/** Undo is bounded by BYTES, not entries: at 200 pages, 100 whole-document
 *  snapshots retain tens of MB. Assets are excluded from snapshots entirely. */
const UNDO_BUDGET = 24 * 1024 * 1024

/**
 * Top-level keys a whole-document restore ALWAYS takes from the LIVE document,
 * never from what it restores: undo, redo, and every replaceDoc (version
 * history, the recovery banner, Replace from JSON, bento.loadDoc).
 *
 * These are who the space IS and what this copy may do, not what it says:
 *   · `docId`    — identity (PLATFORM §3). A snapshot taken before "Duplicate as
 *                  a new space" or pasted from another file must not make this
 *                  space claim somebody else's id, its versions and its room.
 *   · `collab`   — the live-session capability and its on/off switch. A
 *                  snapshot from before Stop sharing would silently rejoin the
 *                  room; one from before Rotate keys would resurrect a revoked key.
 *   · `readonly` — the file's sealed-reading-copy mode. Undo must not unfreeze it.
 *   · `template` — a file mode that RE-MINTS `docId` on every open (model.ts),
 *                  so it governs identity: pasted or restored, it would make
 *                  this space a new document each time it is opened.
 *
 * NOT on the list, deliberately: `theme` (and any design setting) is content
 * and undoes like content; `format`/`version`/`policy` describe how the content
 * is encoded and travel with it; `assets` is kept by undo/redo for a different
 * reason — snapshots omit it for size — and a replaceDoc brings its own.
 *
 * The shared list now lives in the kernel (kernel/src/docfields.ts) and is
 * re-exported here, so restoregate.ts keeps importing it from `./store.ts`.
 */
export { FROM_LIVE }

/** Overwrite `next`'s FROM_LIVE keys with `live`'s — including deleting one the
 *  live document does not have. Mutates and returns `next`. The kernel's
 *  keepLiveIdentity does the work, so this app and the kernel cannot disagree
 *  about what "kept live" means. */
function keepLiveIdentity(live: SpacesDoc, next: SpacesDoc): SpacesDoc {
  keepLive(next as Record<string, unknown>, live as Record<string, unknown>)
  keepLiveHistory(live, next)
  return next
}

/**
 * The fields the kernel's map classes 'history' (docclass.ts: `revisions`,
 * `trail`). They are a LOG of the space, not its content, so — like identity —
 * every whole-document restore keeps the LIVE value, and undo snapshots omit
 * them (they would be up to 128 KB per entry, identical in nearly every one).
 *
 * Without this, three ordinary actions silently rewrote the file's history:
 * ⌘Z after a save un-recorded the revision that save wrote; "Replace from
 * JSON" with the output of Copy document JSON (which drops history by the
 * copy table) deleted it outright; and restoring a version or a recovery
 * snapshot rolled the list back to whatever it was when that copy was taken.
 * Read from the map, so a history field added later is kept the same way.
 */
const HISTORY_KEYS: readonly string[] = Object.entries(SPACES_FIELDS)
  .filter(([, cls]) => cls === 'history').map(([k]) => k)

function keepLiveHistory(live: SpacesDoc, next: SpacesDoc): void {
  const n = next as Record<string, unknown>, l = live as Record<string, unknown>
  for (const k of HISTORY_KEYS) {
    if (Object.hasOwn(l, k) && l[k] !== undefined) n[k] = l[k]
    else delete n[k]
  }
}

/**
 * One undoable step.
 *
 * A `page` entry holds ONE page's JSON; a `doc` entry holds the whole document
 * minus its assets. The distinction is the difference between an undo history
 * that survives a real document and one that does not: measured on a 200-page,
 * 2.5 MB handbook, whole-document entries gave a depth of NINE — fifty edits,
 * and you can take back the last nine — because every checkpoint stringified
 * 2.5 MB against a 24 MB budget. The same budget holds hundreds of page
 * entries, and a page entry costs ~12 KB rather than 2.5 MB to take.
 *
 * DOC IS THE DEFAULT, and page scope is opted into. A page entry restores one
 * page by id and leaves the rest of the document alone, so it is only correct
 * when the mutation touched nothing else — the caller knows that and the store
 * cannot cheaply check it. Defaulting the other way would corrupt undo for any
 * caller that forgot.
 */
type Entry =
  | { kind: 'doc'; json: string; viewId: string }
  | { kind: 'page'; pageId: string; json: string; viewId: string }

export class Store {
  doc: SpacesDoc
  index: SpaceIndex
  /**
   * Every `#tag` in the prose, derived and LAZY.
   *
   * Lazy because `touch()` reindexes on every keystroke of a typing run, and a
   * tag index is a second full scan of every block in the document. Nothing
   * reads it per-keystroke — the chips a render draws come from the text in
   * front of them, not from here — so it is built when something asks (a view
   * sourced on a tag, ⌘K, the graph, the tag sheet) and dropped whenever the
   * document changes. Same derived-never-stored rule as `index`, one less full
   * pass per keystroke.
   */
  get tags(): TagIndex { return (this.tagIx ??= buildTagIndex(this.doc)) }
  private tagIx: TagIndex | null = null
  /** the page being viewed */
  pageId: string
  /** blocks currently selected at block level (Esc from text editing) */
  selection: string[] = []
  readOnly = false
  /**
   * Unsaved changes.
   *
   * The header comment above has claimed since 0.1.0 that this policy sets
   * "the dirty flag", and there was no dirty flag — so the Save button could
   * not say whether it needed pressing, which in a format whose whole promise
   * is "the file IS the document" is the one thing it should say.
   */
  dirty = false
  /** Every mutation, even within a typing run or while already dirty. */
  revision = 0

  private undoStack: Entry[] = []
  private redoStack: Entry[] = []
  private listeners = new Map<Event, Set<Listener>>()
  private runBlock: string | null = null
  private runTimer: ReturnType<typeof setTimeout> | undefined

  constructor(doc: SpacesDoc) {
    this.doc = doc
    this.index = buildIndex(doc)
    this.pageId = homePage(doc)?.id ?? ''
  }

  // ---- events -------------------------------------------------------------
  on(ev: Event, fn: Listener): () => void {
    const set = this.listeners.get(ev) ?? new Set()
    set.add(fn)
    this.listeners.set(ev, set)
    return () => set.delete(fn)
  }

  emit(ev: Event): void {
    if (ev === 'doc') this.revision++
    for (const fn of this.listeners.get(ev) ?? []) fn()
  }

  // ---- reads --------------------------------------------------------------
  get page(): Page | undefined {
    return this.index.page.get(this.pageId)
  }

  block(id: string): Block | undefined {
    return this.index.block.get(id)?.block
  }

  /** Pages in sidebar order: a depth-first walk of the page tree. */
  /**
   * The page tree, for the sidebar and the Markdown export.
   *
   * `seen` is not defensive tidiness. `buildIndex` bins pages by `parent` with
   * no position test, and two people concurrently dragging pages onto each
   * other converge on A.parent=B, B.parent=A — legal for each of them, a cycle
   * together. Neither page is then reachable from the root, so BOTH VANISH from
   * the sidebar and from the Markdown export while still sitting in the file,
   * and nothing says so. Worse, a subtree call from inside the cycle recurses
   * until the stack gives out.
   *
   * A cyclic group is surfaced at the ROOT rather than hidden: pages you can
   * see and re-home beat pages that quietly stopped existing.
   */
  tree(parent = '', depth = 0, seen: Set<string> = new Set()): Array<{ page: Page; depth: number }> {
    const out: Array<{ page: Page; depth: number }> = []
    for (const p of this.index.children.get(parent) ?? []) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      out.push({ page: p, depth })
      out.push(...this.tree(p.id, depth + 1, seen))
    }
    // Anything a cycle kept off the root walk, listed rather than lost.
    if (parent === '' && depth === 0) {
      for (const p of this.doc.pages) {
        if (p.archived || seen.has(p.id)) continue
        seen.add(p.id)
        out.push({ page: p, depth: 0 })
      }
    }
    return out
  }

  // ---- writes -------------------------------------------------------------
  /**
   * A structural change: one undoable step. Closes any open typing run first,
   * so the run's text and the structural edit never merge into one entry.
   */
  commit(mutate: () => void, opts: { structure?: boolean; scope?: Scope } = {}): void {
    if (this.readOnly) return
    this.endRun()
    this.checkpoint(opts.scope ?? 'doc')
    mutate()
    this.dirty = true
    this.reindex()
    this.emit('doc')
    if (opts.structure !== false) this.emit('tree')
  }

  /**
   * An input inside a typing run. The FIRST input in a block checkpoints;
   * every later one mutates in place.
   */
  runEdit(blockId: string, mutate: () => void): void {
    if (this.readOnly) return
    if (this.runBlock !== blockId) {
      this.endRun()
      // A typing run is one block in the page in view, by definition — the
      // cheapest and by far the most common checkpoint there is.
      this.checkpoint('page')
      this.runBlock = blockId
    }
    mutate()
    this.touch()
    clearTimeout(this.runTimer)
    this.runTimer = setTimeout(() => this.endRun(), RUN_IDLE_MS)
  }

  /** Close the current run, if any. Idempotent. */
  endRun(): void {
    clearTimeout(this.runTimer)
    if (!this.runBlock) return
    const id = this.runBlock
    this.runBlock = null
    this.emit('doc')
    void id
  }

  /** Model changed without a new undo entry (mid-run). */
  touch(): void {
    this.revision++
    // A typing run deliberately does NOT emit 'doc' per keystroke — that is the
    // whole point of the run. But the FIRST keystroke changes something the
    // reader can see: the file now differs from the disk. Announce that once,
    // on the transition only, or the unsaved dot does not appear until the run
    // closes 600ms later and the button lies for as long as you keep typing.
    const wasClean = !this.dirty
    this.dirty = true
    this.doc.modified = new Date().toISOString()
    this.reindex()
    if (wasClean) this.emit('doc')
  }

  /**
   * Set the unsaved flag from outside a commit.
   *
   * The kernel session calls this after applying a REMOTE change: the document
   * on screen now differs from the file on disk, which is true however the
   * change arrived. It is deliberately separate from the `doc` event — this
   * app reads `doc` as "you edited something" and paints "Edited" from it, so
   * a colleague's keystroke must move the dot without claiming to be yours.
   */
  setDirty(v: boolean): void {
    // Remote apply calls this even when the dirty flag is already set.
    if (v) this.revision++
    if (this.dirty === v) return
    this.dirty = v
    // NOT 'doc'. The editor reads 'doc' as "you edited something" and paints
    // "Edited" from it; a colleague's keystroke must move the unsaved dot
    // without claiming to be yours. 'dirty' carries the dot and nothing else.
    this.emit('dirty')
  }

  /**
   * Rebuild the id index, and fall back to the home page if the page being
   * viewed no longer exists.
   *
   * PUBLIC because a remote collaborator's edit lands on `doc` directly —
   * bypassing commit, deliberately, so it never joins this person's undo
   * stack — and every `block(id)` / `page` read after that would otherwise
   * answer from a stale index. sync/session.ts calls it. It was private while
   * the only writer was the store itself.
   */
  reindex(): void {
    this.index = buildIndex(this.doc)
    this.tagIx = null
    if (!this.index.page.has(this.pageId)) this.pageId = homePage(this.doc)?.id ?? ''
  }

  // ---- history ------------------------------------------------------------
  private snapshot(): string {
    // assets are excluded: they are the largest thing in the document and never
    // change during an ordinary edit, so snapshotting them 100 times is waste.
    // History fields are excluded too, and restored from live (keepLiveHistory).
    // That includes `trail`: a row is an OBSERVATION written outside any
    // commit, so an undo that restored it could put a stale row over a newer
    // one. `periods` is content, NOT excluded: starting a period is something a
    // person did, inside a commit, and ⌘Z takes it back like any other edit.
    const { assets: _assets, ...rest } = this.doc as Record<string, unknown>
    for (const k of HISTORY_KEYS) delete rest[k]
    return JSON.stringify(rest)
  }

  /** An entry for the state as it is NOW, at the requested scope. */
  private entry(scope: Scope): Entry {
    if (scope === 'page') {
      const page = this.index.page.get(this.pageId)
      // no page in view is not a page-scoped edit — fall back rather than
      // record an entry that restores nothing
      if (page) return { kind: 'page', pageId: page.id, json: JSON.stringify(page), viewId: this.pageId }
    }
    return { kind: 'doc', json: this.snapshot(), viewId: this.pageId }
  }

  checkpoint(scope: Scope = 'doc'): void {
    if (this.readOnly) return
    this.undoStack.push(this.entry(scope))
    this.redoStack.length = 0
    let bytes = 0
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      bytes += this.undoStack[i].json.length
      if (bytes > UNDO_BUDGET) { this.undoStack.splice(0, i + 1); break }
    }
  }

  private restore(entry: Entry): void {
    this.dirty = true
    if (entry.kind === 'page') {
      const at = this.doc.pages.findIndex((p) => p.id === entry.pageId)
      // The page can be gone if a later doc-level step removed it. Undo runs in
      // order, so the step that removed it is undone FIRST and the page is back
      // by the time this entry is reached — but a hand-built history could
      // reach here, and dropping the entry is better than throwing.
      if (at >= 0) this.doc.pages[at] = JSON.parse(entry.json) as Page
    } else {
      // CONTENT moves, identity does not: the snapshot's docId/collab/readonly
      // are whatever they were when it was taken, and Stop sharing, a key
      // rotation or a mode change since then must survive ⌘Z and ⌘⇧Z alike.
      const live = this.doc
      const assets = live.assets
      this.doc = keepLiveIdentity(live, { ...(JSON.parse(entry.json) as SpacesDoc), ...(assets ? { assets } : {}) })
    }
    this.pageId = entry.viewId
    this.reindex()
    this.emit('doc')
    this.emit('tree')
    this.emit('page')
  }

  undo(): void {
    if (this.readOnly) return
    this.endRun()
    const entry = this.undoStack.pop()
    if (!entry) return
    // the inverse entry is taken at the SAME scope, or redo would restore a
    // whole document over a one-page change
    this.redoStack.push(this.entry(entry.kind))
    this.restore(entry)
  }

  redo(): void {
    if (this.readOnly) return
    this.endRun()
    const entry = this.redoStack.pop()
    if (!entry) return
    this.undoStack.push(this.entry(entry.kind))
    this.restore(entry)
  }

  get canUndo(): boolean { return this.undoStack.length > 0 }
  get canRedo(): boolean { return this.redoStack.length > 0 }

  // ---- navigation ---------------------------------------------------------
  goToPage(id: string, opts: { push?: boolean } = {}): void {
    if (!this.index.page.has(id) || id === this.pageId) return
    this.pageId = id
    this.selection = []
    this.endRun()
    if (opts.push !== false && typeof history !== 'undefined') {
      // pushState with a FRAGMENT is legal from an opaque origin; pushState
      // with a PATH throws SecurityError there. Measured — this is why links
      // are fragments (docs/DECISIONS.md, 2026-08-03).
      try { history.pushState(null, '', `#p/${id}`) } catch { /* opaque origin edge */ }
    }
    this.emit('page')
    this.emit('tree')
  }

  select(ids: string[]): void {
    this.selection = ids
    this.emit('selection')
  }

  /**
   * Replace the whole document — the AI round-trip, version restore and
   * recovery path. Content is replaced; identity is not (FROM_LIVE): a version
   * from before Stop sharing or Rotate keys, or JSON pasted from another space,
   * never brings its own docId, room credentials or file mode with it.
   */
  replaceDoc(next: SpacesDoc): void {
    this.dirty = true
    this.endRun()
    this.checkpoint()
    this.doc = keepLiveIdentity(this.doc, next)
    this.reindex()
    this.pageId = homePage(next)?.id ?? ''
    this.emit('doc')
    this.emit('tree')
    this.emit('page')
  }
}
