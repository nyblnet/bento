// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// ⌘S, auto-save write-back and "Update this file", and the one rule that makes
// the unsaved dot honest: the dot goes out only when the write that captured
// THIS revision is acknowledged.
//
// It used to go out when ANY write resolved. Every write awaits (a handle
// reconnect, the serializer, an encrypting serializer, the disk), and an edit
// made in that window landed in the live deck after the bytes were taken —
// then setDirty(false) ran anyway, so the file on disk was missing the edit and
// nothing on screen said so. The kernel's SaveQueue (kernel/src/savequeue.ts)
// serialises the writes against the one file handle, captures a detached
// snapshot immediately before each write, and answers `isCurrent()` at
// acknowledgement time; this module is slides' side of that contract, kept out
// of editor.ts so the rig drives the same code the button does
// (scripts/test-slides-save-revisions.ts). Spaces and dash adopted the same
// queue the same way (spaces/src/saving.ts, dash/src/saving.ts).
//
// Policy that stays here and NOT in the kernel: which store event clears the
// dot, what each caller does before its write starts (close a text edit, stamp
// the CRDT state into the deck), and what counts as failure.

import { SaveQueue } from '../../kernel/src/savequeue.ts'
import type { BentoDoc } from './model'
import type { Store } from './store'

/** What a write answers. saveFile's results, plus 'cancelled' = picker closed. */
export type WriteResult = 'saved' | 'saved-as' | 'downloaded' | 'cancelled'

export type SaveOutcome<R> =
  /** the deck was swapped for another document while this save waited */
  | { kind: 'discarded' }
  | { kind: 'cancelled' }
  /** the write threw — nothing is acknowledged, the dot stays on */
  | { kind: 'failed'; error: unknown }
  /**
   * A file now holds `doc`. `current` says whether that is still the deck on
   * screen — false means an edit landed while the write was in flight, and the
   * dot stays on for it (auto-save picks it up on its next pass).
   */
  | { kind: 'written'; result: R; doc: BentoDoc; current: boolean }

/** One queue per editor: every write that uses or adopts the open file's
 *  handle goes through it — ⌘S, Save a copy, auto-save, Update this file. */
export function createSaveQueue(store: Store): SaveQueue<BentoDoc> {
  return new SaveQueue<BentoDoc>({ getDocument: () => store.doc, getRevision: () => store.revision })
}

/**
 * Write the deck through the queue and acknowledge only its own revision.
 *
 * `prepare` runs when THIS write actually begins (after any write ahead of
 * it), before the snapshot is taken: it is where a caller stamps the live
 * session's CRDT state into the deck, so a save queued behind another carries
 * the state as of its own start, not the click.
 */
export async function saveRevision<R>(
  store: Store,
  queue: SaveQueue<BentoDoc>,
  write: (snapshot: BentoDoc) => Promise<R | 'cancelled'>,
  prepare?: () => void,
): Promise<SaveOutcome<R>> {
  let saved
  try {
    saved = await queue.run(() => prepare?.(), write)
  } catch (error) {
    return { kind: 'failed', error }
  }
  if (!saved) return { kind: 'discarded' }
  const result = saved.value
  if (result === 'cancelled') return { kind: 'cancelled' }
  const current = saved.isCurrent()
  // setDirty, not a bare assignment: it raises 'dirty', which repaints the
  // dot, and clearing never advances the revision.
  if (current) store.setDirty(false)
  return { kind: 'written', result: result as R, doc: saved.doc, current }
}
