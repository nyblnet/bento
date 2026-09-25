// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
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
