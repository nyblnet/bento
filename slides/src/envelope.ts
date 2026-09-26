// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * A document's ENVELOPE is what makes it a document rather than content: its
 * collaboration block (`collab` — room, read key, private halves, the saved
 * sync state) and its identity (`docId`). An embed's `doc` is another deck's
 * JSON, and that deck's envelope must never ride inside this one — not on the
 * way in (the shape gate, untrusted.ts) and not on the way out (every export
 * that keeps the room, editor.ts stripCollabSecrets). One rule, both
 * boundaries, so they cannot drift; the export-secrets rig runs both.
 *
 * Node-importable on purpose (type-only imports): the rig drives it directly,
 * where the shape gate's module graph needs a bundler.
 */
import type { BentoDoc } from './model'

/** The keys that make a JSON object a document's envelope. */
export const EMBED_ENVELOPE = ['collab', 'docId'] as const

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The same object without its envelope — a copy when there is something to
 *  drop, the input itself when there is not (callers may compare by identity). */
export function stripEnvelope<T>(v: T): T {
  if (!isObj(v) || !EMBED_ENVELOPE.some((k) => k in v)) return v
  const copy = { ...v }
  for (const k of EMBED_ENVELOPE) delete copy[k]
  return copy as T
}

/**
 * Walk a deck's elements and strip the envelope from every embedded document
 * (`elements[].doc` when it is an object). Mutates `doc` — it is called on
 * export CLONES, beside the top-level strip. Returns how many were stripped.
 */
export function stripEmbeddedEnvelopes(doc: BentoDoc): number {
  let n = 0
  const walk = (slides: BentoDoc['slides'] | undefined) => {
    for (const s of slides ?? []) {
      for (const el of s.elements ?? []) {
        const src = (el as { doc?: unknown }).doc
        if (!isObj(src)) continue
        const out = stripEnvelope(src)
        if (out !== src) { (el as { doc?: unknown }).doc = out; n++ }
      }
    }
  }
  walk(doc.slides)
  walk(doc.layouts)
  return n
}
