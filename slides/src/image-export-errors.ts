// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The one type slide image export and its zip writer both need.
//
// It lives alone because the alternative is a CYCLE: the exporter needs the
// writer to build an archive, and the writer needs an error type to refuse one.
// Bundlers happen to resolve that today, and a cycle is still a load-order
// hazard nobody should have to reason about while reading either file. A module
// with no imports of its own cannot participate in one.
//
// Nothing else belongs here. The moment this file needs an import, the split
// has stopped paying for itself.

/**
 * Why an export stopped. Each code maps to one user-facing sentence, and to one
 * decision about whether retrying could possibly help.
 */
export type SlideImageExportCode =
  | 'no-slides'       // nothing selected: the deck has no linear slides
  | 'missing-current' // the current slide is gone (deleted under a stale dialog)
  | 'size'            // refused by our own product budgets
  | 'resource'        // the deck would have to fetch something to be drawn
  | 'decode'          // an embedded resource is damaged
  | 'canvas'          // the browser would not give us a drawing surface
  | 'encode'          // the image could not be encoded
  | 'archive'         // the archive could not be built
  | 'cancelled'       // the user stopped it

export class SlideImageExportError extends Error {
  constructor(
    readonly code: SlideImageExportCode,
    message: string,
    /** One-based DOCUMENT position, ready for user-facing copy. */
    readonly slideNumber?: number,
  ) {
    super(message)
    this.name = 'SlideImageExportError'
  }
}
