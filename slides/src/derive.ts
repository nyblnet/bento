// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Every value the document DERIVES from its own content, in one pass, in
// dependency order. None of these is an edit: each is a pure function of the
// document (plus a little memory of what it looked like last time), so every
// replica computes the same result without an operation crossing the wire,
// and none is an undo step. Boot, every `doc` event and a document replaced in
// a running editor all go through here, so they cannot disagree.
//
//   palette    → literals bound to a palette slot (palette.ts)
//   tokens     → literals bound to a design token (tokens.ts)
//   components → copies follow their main (components.ts)
//   layout     → frame children's boxes (layout.ts) — after tokens and
//                components, which can write gap, padding or a copy's frame;
//                components and layout settle together
//   connectors → endpoints on the laid-out boxes (connectors.ts)
//   stacks     → the single-paint fallback an older shell draws (stacks.ts)
//
// One pass is a fixed point: running it again changes nothing.

import type { BentoDoc } from './model'
import { paletteSignature, resolveThemeRefs } from './palette'
import { syncTokenRefs, tokenSignature } from './tokens'
import { syncComponents } from './components'
import { layoutAll } from './layout'
import { routeAllConnectors } from './connectors'
import { mirrorAllStacks } from './stacks'

/** What the previous pass saw: a change since then is a move to follow; a
 *  disagreement without one is a hand edit to keep. */
export interface DeriveMemory {
  palette: string
  tokens: string
}

/** The memory of a document as it opened: nothing has moved yet, so a value
 *  edited in an older shell reads as a hand edit and is kept. */
export function deriveMemory(doc: BentoDoc): DeriveMemory {
  return { palette: '', tokens: tokenSignature(doc) }
}

/** One derive pass; returns whether anything was written. */
export function derive(doc: BentoDoc, mem: DeriveMemory): boolean {
  let changed = false
  const ps = paletteSignature(doc)
  if (ps !== mem.palette) { mem.palette = ps; if (resolveThemeRefs(doc)) changed = true }
  const ts = tokenSignature(doc)
  const moved = ts !== mem.tokens
  mem.tokens = ts
  if (syncTokenRefs(doc, moved)) changed = true
  // components and layout feed each other: a copy takes its main's layout
  // inputs, and layout then moves the main's frame children, which is part of
  // the main a copy follows. Settle the pair; two rounds is the most real
  // input needs. ponytail: capped at 4, a deeper cycle would show as a second
  // pass reporting a change (the rig asserts it does not)
  for (let i = 0; i < 4; i++) {
    const c = syncComponents(doc), l = layoutAll(doc)
    if (!c && !l) break
    changed = true
  }
  if (routeAllConnectors(doc)) changed = true
  if (mirrorAllStacks(doc)) changed = true
  return changed
}
