// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
import { inLinearFlow } from './model'
import { changes, copy, reverse, type Change } from './history'
import type { BentoDoc, Slide, SlideElement } from './model'

export type StoreEvent =
  | 'doc'        // any document mutation
  | 'slides'     // slide list changed (add/remove/reorder) — sidebar rebuild
  | 'current'    // current slide switched
  | 'selection'  // selected element ids changed
  | 'dirty'      // dirty flag changed

type Listener = () => void

export type ViewSnapshot = {
  slideIds: string[]
  currentIndex: number
  currentId?: string
}

type HistoryEntry = {
  delta: Change[]
  view: ViewSnapshot
  replacement?: BentoDoc
  bytes: number
}

export type RecentChange = { id: number; at: number; local: boolean; delta: Change[]; bytes: number }

const MAX_UNDO = 100
const HISTORY_BUDGET = 32 * 1024 * 1024

/** Central state: document, current slide, selection, undo/redo, dirty flag. */
export class Store {
  doc: BentoDoc
  currentIndex = 0
  selection: string[] = []
  dirty = false
  /** editor-only: which showOnHover set the canvas previews (never saved) */
  hoverPreview: string | null = null

  revision = 0
  recentChanges: RecentChange[] = []
  private changeSequence = 0
  private localPending = false
  private baseline: BentoDoc
  private activeEntry: HistoryEntry | null = null

  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private listeners = new Map<StoreEvent, Set<Listener>>()

  /** read-only viewer: block user edits (commit) while remote ops — which
   *  apply via the session's direct state.apply + emit, NOT commit — still
   *  flow, so a live viewer sees updates but can never author them. */
  readOnly = false

  constructor(doc: BentoDoc) {
    this.doc = doc
    this.baseline = copy(doc)
  }

  on(event: StoreEvent, fn: Listener): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(fn)
    return () => this.listeners.get(event)!.delete(fn)
  }

  emit(event: StoreEvent) {
    if (event === 'doc') {
      this.revision++
      if (this.baseline.docId !== this.doc.docId) this.recentChanges = []
      else if (!this.localPending) this.logChange(changes(this.baseline, this.doc), false)
      this.localPending = false
    }
    this.listeners.get(event)?.forEach((fn) => fn())
    if (event === 'doc') this.baseline = copy(this.doc)
  }

  get slide(): Slide {
    return this.doc.slides[this.currentIndex]
  }

  element(id: string): SlideElement | undefined {
    return this.slide.elements.find((e) => e.id === id)
  }

  get selectedElements(): SlideElement[] {
    return this.selection
      .map((id) => this.element(id))
      .filter((e): e is SlideElement => !!e)
  }

  /**
   * Replace the whole document (AI/JSON round-trip import). Undoable —
   * ⌘Z restores the previous document wholesale.
   */
  replaceDoc(next: BentoDoc) {
    if (this.readOnly) return
    this.checkpoint()
    const previous = copy(this.doc)
    this.doc = next
    if (previous.docId !== next.docId) {
      this.activeEntry!.replacement = previous
      this.activeEntry!.bytes = JSON.stringify(previous).length
    }
    this.recordChange()
    this.currentIndex = 0
    this.selection = []
    this.setDirty(true)
    this.emit('slides')
    this.emit('current')
    this.emit('selection')
    this.emit('doc')
  }

  // --- history ------------------------------------------------------------

  /** Start a local gesture. History holds changed fields, never serialized decks. */
  checkpoint() {
    if (this.readOnly) return
    if (this.activeEntry && !this.activeEntry.delta.length && !this.activeEntry.replacement) {
      this.undoStack = this.undoStack.filter(entry => entry !== this.activeEntry)
    }
    this.baseline = copy(this.doc)
    this.activeEntry = { delta: [], view: this.captureView(), bytes: 0 }
    this.undoStack.push(this.activeEntry)
    this.redoStack.length = 0
    this.trimHistory()
  }

  private recordChange() {
    if (!this.activeEntry) {
      this.activeEntry = { delta: [], view: this.captureView(), bytes: 0 }
      this.undoStack.push(this.activeEntry)
      this.redoStack.length = 0
    }
    const delta = changes(this.baseline, this.doc)
    this.localPending = true
    this.logChange(delta, true)
    this.activeEntry.delta.push(...delta)
    this.activeEntry.bytes += JSON.stringify(delta).length
    this.baseline = copy(this.doc)
    this.trimHistory()
  }

  private logChange(delta: Change[], local: boolean) {
    if (!delta.length) return
    this.recentChanges.push({ id: ++this.changeSequence, at: Date.now(), local, delta, bytes: JSON.stringify(delta).length })
    let bytes = this.recentChanges.reduce((n, x) => n + x.bytes, 0)
    while (this.recentChanges.length > 100 || (bytes > HISTORY_BUDGET && this.recentChanges.length > 1)) {
      bytes -= this.recentChanges.shift()!.bytes
    }
  }

  /** An explicit user-selected revert may override later values on its fields. */
  revertChange(id: number) {
    const entry = this.recentChanges.find(x => x.id === id)
    if (!entry || this.readOnly) return
    const next = copy(this.doc)
    reverse(next, entry.delta, true)
    if (!next.slides.length) return
    this.commit(() => { this.doc = next }, 'slides')
  }

  private trimHistory() {
    let size = this.undoStack.reduce((n, e) => n + e.bytes, 0)
    // Keep a single oversized edit reversible; evict older history first.
    while (this.undoStack.length > MAX_UNDO || (size > HISTORY_BUDGET && this.undoStack.length > 1)) {
      size -= this.undoStack.shift()!.bytes
    }
  }

  get historyBytes() { return [...this.undoStack, ...this.redoStack].reduce((n, e) => n + e.bytes, 0) }

  /** checkpoint() + mutate + notify, in one call. */
  commit(mutate: () => void, event: StoreEvent = 'doc') {
    if (this.readOnly) return // live viewer — user edits are inert
    const view = this.captureView()
    this.checkpoint()
    mutate()
    const { currentChanged, selectionChanged } = this.reconcileView(view)
    this.touch(event)
    if (currentChanged) this.emit('current')
    if (selectionChanged) this.emit('selection')
  }

  /**
   * A slide-list mutation and the view that points into it are one state
   * transition. Keep the same slide by id when it survives; otherwise choose
   * the next surviving neighbour (or the previous one at the end). This runs
   * before touch(), so no redraw listener can observe an invalid slide index.
   */
  captureView(): ViewSnapshot {
    return {
      slideIds: this.doc.slides.map((slide) => slide.id),
      currentIndex: this.currentIndex,
      currentId: this.doc.slides[this.currentIndex]?.id,
    }
  }

  reconcileView(
    before: ViewSnapshot,
    preferred: ViewSnapshot = before,
  ): { currentChanged: boolean; selectionChanged: boolean } {
    const slides = this.doc.slides
    const byId = new Map(slides.map((slide, index) => [slide.id, index]))

    let nextIndex = preferred.currentId == null ? undefined : byId.get(preferred.currentId)
    if (nextIndex == null) {
      const neighbourId = preferred.slideIds.slice(preferred.currentIndex + 1).find((id) => byId.has(id))
        ?? preferred.slideIds.slice(0, preferred.currentIndex).reverse().find((id) => byId.has(id))
      nextIndex = neighbourId == null
        ? Math.max(0, Math.min(preferred.currentIndex, slides.length - 1))
        : byId.get(neighbourId)!
    }

    this.currentIndex = nextIndex
    const currentChanged = slides[nextIndex]?.id !== before.currentId
    const selection = currentChanged
      ? []
      : this.selection.filter((id) => slides[nextIndex]?.elements.some((element) => element.id === id))
    const selectionChanged = currentChanged
      || selection.length !== this.selection.length
      || selection.some((id, index) => id !== this.selection[index])
    this.selection = selection
    if (currentChanged) this.hoverPreview = null
    return { currentChanged, selectionChanged }
  }

  /** Mark dirty and notify after an in-place mutation (no checkpoint). */
  touch(event: StoreEvent = 'doc') {
    this.recordChange()
    this.doc.modified = new Date().toISOString()
    this.setDirty(true)
    this.emit('doc')
    if (event !== 'doc') this.emit(event)
  }

  undo() { this.restore(this.undoStack, this.redoStack) }
  redo() { this.restore(this.redoStack, this.undoStack) }

  private restore(from: HistoryEntry[], to: HistoryEntry[]) {
    if (this.readOnly) return
    this.activeEntry = null
    let entry = from.pop()
    while (entry && !entry.replacement && !entry.delta.length) entry = from.pop()
    if (!entry) return
    const before = this.captureView()
    let inverse: HistoryEntry
    if (entry.replacement) {
      inverse = { delta: [], view: before, replacement: copy(this.doc), bytes: JSON.stringify(this.doc).length }
      this.doc = copy(entry.replacement)
    } else {
      const delta = reverse(this.doc, entry.delta)
      inverse = { delta, view: before, bytes: JSON.stringify(delta).length }
    }
    // Undoing an insertion must not leave a presentation with no slide.
    if (!this.doc.slides.length) {
      if (inverse.replacement) this.doc = inverse.replacement
      else reverse(this.doc, inverse.delta)
      return
    }
    if (!inverse.replacement && !inverse.delta.length) return
    to.push(inverse)
    this.localPending = true
    this.logChange(changes(this.baseline, this.doc), true)
    this.reconcileView(before, entry.view)
    this.doc.modified = new Date().toISOString()
    this.setDirty(true)
    this.emit('doc')
    this.emit('slides')
    this.emit('current')
    this.emit('selection')
  }

  setDirty(dirty: boolean) {
    if (this.dirty === dirty) return
    this.dirty = dirty
    this.emit('dirty')
  }

  // --- navigation & selection ----------------------------------------------

  goTo(index: number) {
    const clamped = Math.max(0, Math.min(index, this.doc.slides.length - 1))
    if (clamped === this.currentIndex) return
    this.currentIndex = clamped
    this.selection = []
    this.hoverPreview = null
    this.emit('current')
    this.emit('selection')
  }

  /** Step forward/back one slide, skipping interactive states (stateOf) the way
   *  linear presentation does. dir = +1 next, -1 prev. */
  goToLinear(dir: 1 | -1) {
    const slides = this.doc.slides
    for (let i = this.currentIndex + dir; i >= 0 && i < slides.length; i += dir) {
      if (inLinearFlow(slides[i])) { this.goTo(i); return }
    }
  }

  select(ids: string[]) {
    this.selection = ids
    this.emit('selection')
  }
}
