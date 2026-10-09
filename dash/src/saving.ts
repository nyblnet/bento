// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Every write dash makes against the OPEN FILE goes through one queue, and the
// unsaved dot goes out only when the write that captured THIS revision lands.
//
// The race this closes was in every save path dash had. `saveFile` awaits — a
// handle reconnect, the serializer (encryption can take a second), the disk —
// and an edit made inside that window landed in the live workbook after the
// bytes were taken. The resolve then cleared the dot, so the file on disk was
// missing the edit and nothing on screen said so. The kernel's SaveQueue
// (kernel/src/savequeue.ts) serializes the writes, hands each one a DETACHED
// snapshot, and answers `isCurrent()` at acknowledgement time; this module is
// dash's side of that contract, kept out of main.ts so the rig drives the
// same code the button does (scripts/test-dash-save-revisions.ts).
//
// ONE QUEUE PER STORE, because "all writes that use or adopt the same file
// handle must share one queue": ⌘S, the toolbar button, the Save menu, the
// automatic write-back, the in-place self-update, and a dropped file adopting
// a new handle. Two queues over one handle is the race again with extra steps.
//
// Policy that stays HERE, not in the kernel: what clears the dot, which
// results put bytes into the open file, and that an in-place update ends this
// session's writing.

import { SaveQueue } from '../../kernel/src/savequeue.ts'
import type { DashDoc } from './model.ts'
import type { Store } from './store.ts'

export interface Saving {
  queue: SaveQueue<DashDoc>
  /**
   * An in-place update rewrote the open file with a NEWER shell. This page is
   * still the old one, and every write it makes serializes the old shell — so
   * the next automatic save would quietly put the previous version back. Once
   * set, nothing in this session writes the open file again; reload runs the
   * new version.
   */
  superseded: boolean
}

const all = new WeakMap<Store, Saving>()

export function savingFor(store: Store): Saving {
  let s = all.get(store)
  if (!s) {
    s = {
      queue: new SaveQueue<DashDoc>({ getDocument: () => store.doc, getRevision: () => store.revision }),
      superseded: false,
    }
    all.set(store, s)
  }
  return s
}

/** What a write did to the OPEN file — the only thing the dot is about. */
export type Landed =
  /** the open file now holds the snapshot (⌘S, Save a copy, write-back) */
  | 'open-file'
  /**
   * ⌘S on a browser with no in-place save: the snapshot went to Downloads.
   * The dot goes out — that IS saving there, and a dot that can never go out
   * would make every close a false alarm — but nothing is adopted, because
   * the open file is still stale and write-back must not believe otherwise.
   */
  | 'download'
  /** bytes went somewhere else; the open file is as stale as it was */
  | 'elsewhere'
  /** nothing was written */
  | 'nowhere'

export interface Acknowledge {
  /** the open file holds these bytes — write-back must not rewrite them */
  adopt(doc: DashDoc): void
  /** and they are the workbook on screen: the dot goes out */
  clean(): void
}

export type SaveOutcome<T> =
  /** the workbook was swapped for another while this save waited */
  | { kind: 'discarded' }
  /** an in-place update replaced the shell while this write waited */
  | { kind: 'superseded' }
  /** the write threw — nothing acknowledged, the dot stays */
  | { kind: 'failed'; error: unknown }
  | { kind: 'done'; value: T; doc: DashDoc; landed: Landed; current: boolean }

/**
 * Write through the queue and acknowledge only the revision that was written.
 *
 * `adopt` runs INSIDE the queued task, before the next write starts: the next
 * write-back cycle compares against it, and adopting after the queue moved on
 * would let that cycle see a stale baseline.
 */
export async function saveRevision<T>(
  store: Store,
  write: (snapshot: DashDoc) => Promise<T>,
  landed: (value: T) => Landed,
  ack: Acknowledge,
): Promise<SaveOutcome<T>> {
  const saving = savingFor(store)
  const SUPERSEDED = Symbol('superseded')
  let saved
  try {
    saved = await saving.queue.run(() => store.endRun(), async (snapshot) => {
      // Checked HERE, when the write is about to happen — not only when it was
      // asked for. A write queued behind an in-place update passed every
      // earlier check and would otherwise write the old shell straight back.
      if (saving.superseded) return SUPERSEDED
      const value = await write(snapshot)
      if (landed(value) === 'open-file') ack.adopt(snapshot)
      return value
    })
  } catch (error) {
    return { kind: 'failed', error }
  }
  if (!saved) return { kind: 'discarded' }
  if (saved.value === SUPERSEDED) return { kind: 'superseded' }
  const where = landed(saved.value as T)
  const current = saved.isCurrent()
  if ((where === 'open-file' || where === 'download') && current) ack.clean()
  return { kind: 'done', value: saved.value as T, doc: saved.doc, landed: where, current }
}

/**
 * Wait for every write ahead of this point, then run `swap` before the next
 * one can start. For anything that changes WHICH FILE is open — a dropped
 * workbook adopting its handle, "Save as new workbook" switching identity: an
 * automatic write already in flight resolves its handle AFTER its serializer
 * awaits, so swapping the handle under it writes the OLD workbook into the NEW
 * file. Queued writes for the old workbook are discarded by the kernel queue's
 * identity check once the swap has replaced the document.
 */
export async function afterPendingWrites<T>(store: Store, swap: () => T): Promise<T> {
  const { queue } = savingFor(store)
  // An EMPTY task, awaited, then the swap in its continuation — not the swap
  // inside the task. The queue skips a task whose workbook was replaced while
  // it waited, and a swap is exactly the thing that must never be skipped.
  // The continuation runs before the next queued task can start: that task is
  // chained on `task.catch(...)`, which settles a tick after `task` itself.
  await queue.run(() => {}, async () => undefined)
  return swap()
}
