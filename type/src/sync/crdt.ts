// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento-sync for bento/type — the kernel engine, bound to this app's shape.
//
// A FACADE, as slides/src/sync/crdt.ts and spaces/src/sync/crdt.ts are. The
// engine lives in kernel/src/sync/crdt.ts and takes its document shape as
// property names, so one algebra serves three apps without any app's
// vocabulary living in the kernel.
//
// type is the first FLAT binding, and the first whose text is not on a child.
// Both of those were kernel changes (docs/DECISIONS.md, 2026-08-15) rather
// than anything this file works around.

export * from '../../../kernel/src/sync/crdt.ts';

import { SyncEngine, shape } from '../../../kernel/src/sync/crdt.ts';
import type { DocShape } from '../../../kernel/src/sync/crdt.ts';

/**
 * bento/type: the document holds `body`, a block holds its own `text`, and
 * there is nothing beneath a block.
 *
 * Frozen from the first shared file, exactly as the other two bindings are:
 * these strings are minted into every persisted SyncStateJSON and every relay
 * frame, so changing one would fork a document from its own copies.
 *
 * WHY FLAT. A word processor's document is a stream of prose poured into
 * pages; the structure lives in the block kinds and the pagination, not in the
 * container (model.ts says the same). There is no honest key to point
 * `children` at, so the shape says `null` rather than making every block carry
 * an empty array to satisfy the engine.
 *
 * WHY `text` IS NAMED. It is the property that gets the token RGA instead of a
 * last-writer-wins register — the difference between two people typing in one
 * paragraph and one of them silently losing their work. Both other apps put
 * their text on a child under the key `html`; type's is on the block itself
 * and is plain text, so it has to say so.
 *
 * WHAT IS NOT SOLVED BY THE SHAPE, and is documented rather than hidden:
 * `marks` and `notes` are offsets INTO that text, and they merge as ordinary
 * whole-value registers while the text merges token by token. Those are two
 * independent merge domains describing one paragraph, so concurrent edits can
 * converge on offsets that no longer describe the text they index — the same
 * class of problem `parent`-vs-position is for bento/spaces.
 * scripts/test-sync-type.ts measures it rather than assuming either way.
 *
 * WHY `footnotes` IS DECLARED A MAP. A footnote's BODY lives in a doc-level
 * map keyed by note id, so it can outlive a re-flow of the paragraph that
 * references it (model.ts says so). As one whole-value register, two authors
 * adding a footnote each would keep both REFERENCES — those live on different
 * blocks and merge independently — while one of the two bodies was overwritten,
 * leaving a marker in the text pointing at nothing. Measured before it was
 * declared: 34 of 120 fuzz seeds converged on a document with a dangling note.
 * Per-key, as `assets` and `blobs` have always been, both survive.
 */
export const TYPE_SHAPE: DocShape = shape('body', null, 'text', ['footnotes']);

/** The engine bound to bento/type. */
export class SyncState extends SyncEngine {
  constructor(actor: string) {
    super(actor, TYPE_SHAPE);
  }
}
