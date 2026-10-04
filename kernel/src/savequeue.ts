// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A revision-acknowledged SAVE QUEUE — the fix for a race every app had: it
// cleared the dirty flag after an ASYNC file write, so an edit made WHILE the
// write was in flight was marked saved and then lost (slides' setDirty(false)
// after writeUpdatedFile; spaces and dash the same shape). The queue serializes
// every write against one file handle and captures a DETACHED snapshot of the
// document the instant before each write, then hands back an `isCurrent()` the
// caller checks AT ACKNOWLEDGEMENT time — so the dirty flag is only cleared when
// nothing has changed since the bytes that were actually written.
//
// Split out of the Codex document-state work in #535. Deliberately minimal: NO
// UI, dirty flag, encryption, undo or app-model policy lives here — those stay
// the app's. It knows only about a monotonic revision and the document identity.

import type { KernelDoc } from './doc.ts'
import { copy } from './documentvalue.ts'

/** Apps supply a monotonic revision that advances on EVERY mutation, including
 * typing within an undo group and remote edits. Selection changes need not count.
 * All writes that use/adopt the same file handle must share one queue. */
export interface SaveHost<D extends KernelDoc> {
  getDocument(): D
  getRevision(): number
}
export interface SavedRevision<D, T> {
  value: T
  doc: D
  /** Check at acknowledgement time, not just when the write resolves. */
  isCurrent(): boolean
}

/** Serialize manual/automatic writes and capture a detached revision immediately
 * before each write. No UI, dirty flag, encryption, undo or app-model policy here.
 * A rejected write never poisons the queue; a queued request for another document
 * is discarded. The writer must await completion of its actual file write. */
export class SaveQueue<D extends KernelDoc> {
  private tail: Promise<unknown> = Promise.resolve()
  private host: SaveHost<D>
  constructor(host: SaveHost<D>) { this.host = host }

  run<T>(prepare: () => void, write: (doc: D) => Promise<T>): Promise<SavedRevision<D, T> | undefined> {
    const identity = this.host.getDocument().docId
    const task = this.tail.then(async () => {
      if (this.host.getDocument().docId !== identity) return undefined
      prepare()
      // Preparation may stamp collaboration state, but must not switch documents.
      if (this.host.getDocument().docId !== identity) return undefined
      const live = this.host.getDocument(), revision = this.host.getRevision(), doc = copy(live)
      const value = await write(doc)
      return { value, doc, isCurrent: () => this.host.getDocument() === live && this.host.getRevision() === revision }
    })
    this.tail = task.catch(() => {})
    return task
  }
}
