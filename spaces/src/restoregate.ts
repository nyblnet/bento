// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The gate a document kept in THIS BROWSER passes before it replaces the space
// that is open: the "Unsaved changes from a previous session" snapshot and
// every entry in History. Like slides' restoregate.ts, for the same reason.
//
// WHY IT IS A GATE AT ALL. Those snapshots are not the file. They live in
// IndexedDB under the space's docId, and on file:// every local .bento.html
// shares one origin — so the store is shared too, readable and writable by any
// other local document. A snapshot is therefore foreign input that arrives
// behind the most trusting prompt in the app ("restore YOUR changes"), and it
// used to go straight from JSON.parse into store.replaceDoc.
//
// So it is held to what an arriving file is held to, and to a little more:
//   · bounded and prototype-safe before it is parsed at all;
//   · it must name THIS space — a snapshot whose docId is not the open
//     space's is refused, whatever key it was filed under;
//   · `parseDoc` is the format, version and shape check a file open runs, and
//     a snapshot this build would open frozen (newer version, unknown policy)
//     is refused: a restore cannot open read-only, so it must not happen;
//   · every block's html goes through `sanitizeInline`, the gate importSpace
//     and the Markdown import put on arriving blocks — render sanitizes the
//     same html again, so what a reader SEES is what a file open shows;
//   · identity and capability (store.ts FROM_LIVE: docId, collab, readonly,
//     template) are the OPEN space's, never the snapshot's. replaceDoc applies
//     that too; it is applied here as well so the gate's output is already the
//     document that will be installed, and the recovery check compares that.
//
// What it deliberately does NOT do that slides' gate does: drop unknown keys.
// The spaces format is additive — a file open keeps every field it does not
// understand and writes it back untouched — and a restore that silently lost
// them would be the one path that broke that promise.
//
// Deliberately free of the editor, so the rig runs it in node.

import { parseDoc, docContentKey, type SpacesDoc } from './model.ts'
import { sanitizeInline } from './sanitize.ts'
import { FROM_LIVE, type Store } from './store.ts'

/**
 * The largest snapshot the gate will parse, in UTF-16 code units of JSON.
 * Far above any space a person writes (a 200-page handbook is ~2.5 MB) and
 * above a space carrying a dozen embedded clips, but bounded: a foreign entry
 * must not be able to make opening a space parse a gigabyte.
 */
export const MAX_RESTORE_CHARS = 128 * 1024 * 1024

export type GateRefusal = 'size' | 'json' | 'proto' | 'format' | 'frozen' | 'docId'

/**
 * Gate a snapshot's JSON against the open space. Returns the document to
 * install — content from the snapshot, identity from `live` — or why it was
 * refused. A refusal is never applied and never deletes the entry.
 */
export function gateRestored(json: unknown, live: SpacesDoc):
  { ok: true; doc: SpacesDoc } | { ok: false; why: GateRefusal } {
  if (typeof json !== 'string' || json.length > MAX_RESTORE_CHARS) return { ok: false, why: 'size' }

  // PROTOTYPE-SAFE: a `__proto__` key anywhere refuses the whole entry. No
  // legitimate snapshot has one (every key is a format field or a minted id),
  // and refusing beats having to prove that no later spread, assign or merge
  // of this object ever treats it as the setter.
  let raw: unknown
  let proto = false
  try {
    raw = JSON.parse(json, function (k, v) { if (k === '__proto__') proto = true; return v })
  } catch { return { ok: false, why: 'json' } }
  if (proto) return { ok: false, why: 'proto' }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, why: 'json' }

  // THIS space's snapshot, or nothing. Checked on the RAW docId: parseDoc
  // mints one when it is missing, and a minted id is not this space either.
  if ((raw as { docId?: unknown }).docId !== live.docId) return { ok: false, why: 'docId' }

  const res = parseDoc(json)
  if (!res.ok) return { ok: false, why: 'format' }
  if (res.frozen) return { ok: false, why: 'frozen' }

  const doc = res.doc
  for (const page of doc.pages) {
    for (const b of page.blocks) if (typeof b.html === 'string' && b.html) b.html = sanitizeInline(b.html)
  }

  const from = live as Record<string, unknown>
  const to = doc as Record<string, unknown>
  for (const k of FROM_LIVE) {
    if (from[k] !== undefined) to[k] = from[k]
    else delete to[k]
  }
  return { ok: true, doc }
}

/**
 * Should the recovery banner be shown at all? Only for a snapshot that passes
 * the gate AND, compared as it would be restored, differs from what is open.
 * A forged or junk entry therefore never raises a banner — it cannot be used
 * to keep one on screen, any more than to restore through it.
 */
export function recoveryOffered(json: unknown, live: SpacesDoc): boolean {
  const g = gateRestored(json, live)
  return g.ok && docContentKey(g.doc) !== docContentKey(live)
}

/**
 * THE restore: the recovery banner's Restore and every History entry come
 * through here. Gated against the space as it is NOW — a live session may have
 * been joined, or the space duplicated under a new docId, since the entry was
 * listed — and a refusal applies nothing and deletes nothing. A read-only
 * store (a reading copy, a view-only follower, a frozen file) is never
 * rewritten from this browser's storage.
 */
export function restoreInto(store: Store, json: unknown): boolean {
  if (store.readOnly) return false
  const g = gateRestored(json, store.doc)
  if (!g.ok) return false
  store.replaceDoc(g.doc)
  return true
}
