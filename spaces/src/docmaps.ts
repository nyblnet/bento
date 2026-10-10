// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Doc-level keys that are MAPS — merged per key by the CRDT, and folded back
// out of a dotted top-level key by the parser.
//
// THIS FILE IS A LEAF: no imports at all. `model.ts parseDoc` calls
// `foldDottedMapKeys` before anything else sees the document, so anything this
// module imported at runtime would be imported by the parser.

/**
 * ONE list, read by `sync/crdt.ts` (which hands it to the kernel's `shape()`)
 * and by `model.ts parseDoc` (which repairs what a peer running an older shape
 * wrote). Two copies of it is precisely how the mitigation and the hazard drift
 * apart.
 *
 * `periods` is here because two people defining or closing different periods
 * in one week must both keep theirs; as one whole-value register, one of them
 * would silently lose a period and every chart that names it.
 *
 * `trail` is NOT here, and must never be: it is the kernel's `history` class
 * (docclass.ts), which the sync shape skips outright — each replica keeps its
 * own record of what it saw, the way each keeps its own `revisions`.
 */
export const DOC_MAPS = ['periods'] as const

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Fold a dotted top-level key back into the map it belongs to, in place.
 *
 * THE MIXED-VERSION HAZARD, and its mitigation. A peer running a build whose
 * `DocShape.maps` does not list `periods` receives `set k="periods.pd-1"`,
 * fails the kernel's `mapKey()` lookup, and writes a literal top-level key
 * named `"periods.pd-1"`. Additivity would then preserve that junk forever.
 * Folding it back here is cheap, deterministic, self-healing, and repairs
 * files that were damaged before the fix existed — no kernel handshake change.
 *
 * NEVER OVERWRITES a key the map already holds — the folded value is the one
 * that build could not place, and the placed one is at least as new.
 */
export function foldDottedMapKeys(raw: Record<string, unknown>): number {
  let folded = 0
  for (const k of Object.keys(raw)) {
    const at = k.indexOf('.')
    if (at <= 0) continue
    const field = k.slice(0, at)
    if (!(DOC_MAPS as readonly string[]).includes(field)) continue
    const entry = k.slice(at + 1)
    if (!entry) continue
    // a `periods` some newer build gave a different shape is left alone, and so
    // is the dotted key beside it: a field this build cannot read is not one it
    // may overwrite
    if (raw[field] !== undefined && !isObj(raw[field])) continue
    const map = isObj(raw[field]) ? (raw[field] as Record<string, unknown>) : {}
    if (!Object.hasOwn(map, entry)) map[entry] = raw[k]
    raw[field] = map
    delete raw[k]
    folded++
  }
  return folded
}
