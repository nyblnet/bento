// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * A document's ENVELOPE is what makes it a document rather than content: its
 * collaboration block (`collab` — room, read key, private halves, the saved
 * sync state) and its identity (`docId`). An embed's `doc` is another deck's
 * JSON, and that deck's envelope must never ride inside this one — not on the
 * way in (the shape gate, untrusted.ts) and not on the way out (every export
 * that keeps the room, stripCollabSecrets below). One rule, both
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

/**
 * How many documents deep an embedded document may nest (the embed's own
 * document is depth 1). A document nested deeper is DROPPED, never kept: past
 * the bound nothing is inspected, so nothing past it may travel.
 */
export const ENVELOPE_MAX_DEPTH = 16

/** Is this object a document of ANY Bento app? (`bento/slides`, `bento/type`, …) */
const isBentoDoc = (v: Record<string, unknown>): boolean =>
  typeof v.format === 'string' && v.format.startsWith('bento/')

const DROP: unique symbol = Symbol('drop')

/**
 * `v` at document depth `depth`; `isDoc` when the caller knows it is a
 * document (the embed's own `doc`, or any object under a `doc` key) whether or
 * not it declares a format. Copy-on-write: returns `v` itself when nothing
 * beneath it changed, a copy along the changed path otherwise, or DROP.
 */
function walk(v: unknown, depth: number, isDoc: boolean): unknown {
  if (Array.isArray(v)) {
    let out: unknown[] | null = null
    for (let i = 0; i < v.length; i++) {
      const w = walk(v[i], depth, false)
      if (w !== v[i] && !out) out = v.slice(0, i)
      if (out && w !== DROP) out.push(w)
    }
    return out ?? v
  }
  if (!isObj(v)) return v
  const doc = isDoc || isBentoDoc(v)
  const here = doc ? depth + 1 : depth
  if (here > ENVELOPE_MAX_DEPTH) return DROP
  let out: Record<string, unknown> | null = null
  if (doc && EMBED_ENVELOPE.some((k) => k in v)) {
    out = { ...v }
    for (const k of EMBED_ENVELOPE) delete out[k]
  }
  for (const k of Object.keys(v)) {
    if (doc && (EMBED_ENVELOPE as readonly string[]).includes(k)) continue
    const w = walk(v[k], here, k === 'doc')
    if (w === v[k]) continue
    out ??= { ...v }
    if (w === DROP) delete out[k]
    else out[k] = w
  }
  return out ?? v
}

/**
 * The embedded document without its envelope — and without the envelope of
 * every document nested inside it, at any depth, of any Bento app: an object is
 * a document when it declares a `bento/…` format or sits under a `doc` key (the
 * embed convention). Documents nested more than ENVELOPE_MAX_DEPTH deep are
 * dropped. Returns the input ITSELF when nothing was removed — callers
 * (audience.ts) detect a change by identity — and a copy along the changed path
 * otherwise; the input is never modified.
 */
export function stripEnvelope<T>(v: T): T {
  const out = walk(v, 0, true)
  return (out === DROP ? undefined : out) as T
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

/**
 * Take the live session out of a copy that is about to leave this machine.
 * Every copy that leaves without its session goes through THIS function: the
 * editor's exports (Copy document JSON, packages, templates) and the agent
 * reads on window.bento (read(), compact()) alike.
 * ONE list, in one place: every field under `collab` is a bearer capability,
 * so a hand-out that forgets one of them grants the recipient write access to
 * the room, the power to revoke its members, or the ability to decrypt every
 * frame and blob the relay has ever stored — and the file looks completely
 * ordinary afterwards. Divergent per-export copies of this list are how one
 * export path ends up leaking what the other three strip.
 *
 * The default is to drop the block outright (sealed packages, templates, the
 * JSON on the clipboard: none of them may join anything). `keepRoom` is for
 * the copies that are MEANT to follow the session — they keep the room, the
 * symmetric read key and the public keys, and lose only the private halves.
 */
export function stripCollabSecrets(doc: BentoDoc, opts: { keepRoom?: boolean } = {}) {
  // Embedded documents first, whether or not this copy keeps a session of
  // its own: an embed's `doc` is another deck's JSON and carries that deck's
  // envelope (collab + docId) if the file was authored with it in place. The
  // shape gate strips it on the way IN for pasted content; this strips it on
  // the way OUT for every copy — the same rule (envelope.ts).
  stripEmbeddedEnvelopes(doc)
  if (!doc.collab) return
  if (!opts.keepRoom) {
    delete doc.collab
    return
  }
  delete doc.collab.writerPriv // the muzzle — no write capability travels
  delete doc.collab.ownerPriv // v2: neither the owner key…
  delete doc.collab.invite //    …nor any invite (delegation) material
  // …nor the audience ticket store: presenter-only. It holds the show key
  // (worthless to a reader, who sees everything anyway) AND the audience
  // invite's private half, which would let a reader mint audience tickets the
  // presenter never issued. Stripped like the other private halves.
  delete doc.collab.audience
}

/**
 * A detached copy of the document for an agent or a tool to read: the session
 * left out by stripCollabSecrets (the same function, so the same rule), the
 * content and identity kept. Agent reads never need the session — loadDoc
 * and "Replace from JSON…" keep the open deck's own.
 */
export function agentCopy(doc: BentoDoc): BentoDoc {
  const copy = JSON.parse(JSON.stringify(doc)) as BentoDoc
  stripCollabSecrets(copy)
  return copy
}
