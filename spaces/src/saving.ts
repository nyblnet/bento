// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// ⌘S, and the one rule that makes the unsaved dot honest: the dot goes out only
// when the write that captured THIS revision is acknowledged.
//
// It used to go out when ANY write resolved. `saveFile` awaits (a handle
// reconnect, the serializer, the disk), and an edit made in that window landed
// in the live document after the bytes were taken — then the resolve cleared
// the dot, so the file on disk was missing the edit and nothing on screen said
// so. The kernel's SaveQueue (kernel/src/savequeue.ts) captures a detached
// snapshot before each write and answers `isCurrent()` at acknowledgement time;
// this module is the app's side of that contract, kept out of main.ts so the
// rig drives the same code the button does (scripts/test-spaces-save-revisions.ts).
//
// Policy that stays here and NOT in the kernel: which store event clears the
// dot, that a typing run closes before the snapshot, and what counts as failure.

import type { SaveQueue } from '../../kernel/src/savequeue.ts'
import type { SpacesDoc } from './model'
import type { Store } from './store'

/** What `saveFile` answers; 'cancelled' is the picker closed. */
export type WriteResult = 'saved' | 'saved-as' | 'downloaded' | 'cancelled'

export type SaveOutcome =
  /** the space was swapped for another document while this save waited */
  | { kind: 'discarded' }
  | { kind: 'cancelled' }
  /** the write threw — nothing is acknowledged, the dot stays on */
  | { kind: 'failed'; error: unknown }
  /**
   * A file now holds `doc`. `current` says whether that is still the document
   * on screen — false means an edit landed while the write was in flight, and
   * the dot stays on for it.
   */
  | { kind: 'written'; result: Exclude<WriteResult, 'cancelled'>; doc: SpacesDoc; current: boolean }

/**
 * Write the space through the queue and acknowledge only its own revision.
 *
 * `started` runs when THIS write actually begins (after any write ahead of it),
 * after the typing run has closed — closing the run raises 'doc', which paints
 * "Edited", so a status set before it would be overwritten at once.
 */
export async function saveRevision(
  store: Store,
  queue: SaveQueue<SpacesDoc>,
  write: (snapshot: SpacesDoc) => Promise<WriteResult>,
  started?: () => void,
): Promise<SaveOutcome> {
  let saved
  try {
    saved = await queue.run(() => { store.endRun(); started?.() }, write)
  } catch (error) {
    return { kind: 'failed', error }
  }
  if (!saved) return { kind: 'discarded' }
  const result = saved.value
  if (result === 'cancelled') return { kind: 'cancelled' }
  const current = saved.isCurrent()
  // setDirty, not a bare assignment: it raises 'dirty', which is what repaints
  // the dot, and it never advances the revision when clearing.
  if (current) store.setDirty(false)
  return { kind: 'written', result, doc: saved.doc, current }
}
