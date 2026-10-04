// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The gate a document kept in THIS BROWSER passes before it replaces the one
// that is open: the "Restore your unsaved changes?" snapshot and every entry
// in Version history.
//
// WHY IT IS A GATE AT ALL. Those snapshots are not the file. They live in
// IndexedDB under the deck's docId, and on file:// every local .bento.html
// shares one origin — so the store is shared too, readable and writable by
// any other local document. A snapshot is therefore foreign input that arrives
// behind the most trusting prompt in the app ("restore YOUR changes"), and it
// used to go straight into store.replaceDoc as raw JSON.
//
// So it is held to what a pasted clip is held to (untrusted.ts rebuilds every
// slide, layout, asset and font key by key; anything unknown or malformed is
// DROPPED, never repaired), and it never brings its own identity or
// capability: the docId, the live-session credentials (`collab`) and the file
// mode (`readonly`) are the OPEN FILE's, whatever the snapshot says. Content
// is restored; who the deck is, which room it syncs with and whether it can be
// edited are not. A snapshot whose content survives the gate but differs from
// the file is still offered — the point is that what it can do is bounded.
//
// Deliberately DOM-free, so the rig runs it in node.

import { MODEL_KEYS } from './modelkeys.generated'
import { parseDoc, type BentoDoc, type Slide } from './model'
import { LIMITS, sanitizeAssets, sanitizeFonts, sanitizeSlide, withDropReport, withPathSegment, type Dropped } from './untrusted'

const DOC_KEYS = new Set<string>(MODEL_KEYS.doc)
/** identity and capability: always the open file's, never the snapshot's */
const FROM_LIVE = ['docId', 'collab', 'readonly'] as const

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A plain value a settings object may hold: a bounded string, a finite
 *  number, a boolean, or a short list of those. Anything else is dropped. */
function plain(v: unknown): boolean {
  if (typeof v === 'string') return v.length <= LIMITS.scalar * 5
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v === 'boolean') return true
  if (Array.isArray(v)) return v.length <= 64 && v.every((x) => typeof x !== 'object' && plain(x))
  return false
}

/** Settings objects (theme, meta, present, size) keep plain values, and one
 *  nested level of them (theme.codePalette is a map of colours) — the deepest
 *  any of them goes. Anything deeper or stranger is dropped. */
function plainObject(v: unknown, path: string, dropped: Dropped[], depth = 0): Record<string, unknown> | undefined {
  if (!isObj(v)) { dropped.push({ path, reason: 'not an object — dropped' }); return undefined }
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) {
    if (k === '__proto__') continue
    if (plain(x)) out[k] = x
    else if (depth === 0 && isObj(x)) { const o = plainObject(x, `${path}/${k}`, dropped, 1); if (o) out[k] = o }
    else dropped.push({ path: `${path}/${k}`, reason: 'not a plain value — dropped' })
  }
  return out
}

/** Relay blob references: { key, mime, size } and nothing else. */
function blobs(v: unknown, dropped: Dropped[]): BentoDoc['blobs'] {
  if (!isObj(v)) return undefined
  const out: NonNullable<BentoDoc['blobs']> = {}
  for (const [k, b] of Object.entries(v)) {
    if (k === '__proto__' || k.length > LIMITS.scalar) continue
    if (isObj(b) && typeof b.key === 'string' && b.key.length <= LIMITS.scalar && typeof b.mime === 'string' && b.mime.length <= 100 && typeof b.size === 'number' && Number.isFinite(b.size)) {
      out[k] = { key: b.key, mime: b.mime, size: b.size }
    } else dropped.push({ path: `/blobs/${k}`, reason: 'malformed blob reference — dropped' })
  }
  return out
}

/**
 * Gate a snapshot's JSON against the open document. Returns the document to
 * restore (with the live file's identity) and what was dropped, or null when
 * it is not a document at all / has no slide left — then it is never offered.
 */
export function gateRestored(json: string, live: BentoDoc): { doc: BentoDoc; dropped: Dropped[] } | null {
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return null }
  if (!isObj(raw)) return null
  // A snapshot slide with no id is junk, never a slide autosave wrote. parseDoc
  // now MINTS a missing id (so a hand-written FILE still opens), which would
  // turn that junk into a blank slide worth offering — so it is dropped here,
  // first, exactly as sanitizeSlide below always dropped it.
  if (Array.isArray(raw.slides)) raw.slides = raw.slides.filter((s) => isObj(s) && typeof s.id === 'string' && s.id !== '')
  // parseDoc is the format check. A `template` flag makes it mint a new
  // identity and drop collab — harmless here, because identity is replaced
  // with the open file's below either way
  const base = parseDoc(JSON.stringify(raw)) as unknown as Record<string, unknown> | null
  if (!base) return null

  const liveRec = live as unknown as Record<string, unknown>
  const { result, dropped } = withDropReport(() => {
    const extra: Dropped[] = []
    const out: Record<string, unknown> = {}
    const gated = (list: unknown, where: string) => ((Array.isArray(list) ? list : []) as unknown[])
      .map((x, i) => withPathSegment(where, () => withPathSegment(String(i), () => sanitizeSlide(x))))
      .filter((x): x is Slide => x !== null)
    // walked in the SNAPSHOT's key order, so an honest snapshot comes back
    // byte-identical to what was saved
    for (const key of Object.keys(base)) {
      if (!DOC_KEYS.has(key)) { extra.push({ path: `/${key}`, reason: 'unknown document key — dropped' }); continue }
      if ((FROM_LIVE as readonly string[]).includes(key)) { if (liveRec[key] !== undefined) out[key] = liveRec[key]; continue }
      const v = base[key]
      switch (key) {
        case 'format': out.format = live.format; break
        case 'template': break
        case 'slides': out.slides = gated(v, 'slides'); break
        case 'layouts': out.layouts = gated(v, 'layouts'); break
        case 'assets': out.assets = sanitizeAssets(v); break
        case 'fonts': out.fonts = sanitizeFonts(v); break
        case 'blobs': { const b = blobs(v, extra); if (b) out.blobs = b; break }
        case 'title': if (typeof v === 'string' && v.length <= LIMITS.scalar * 5) out.title = v; break
        case 'version': case 'modified': if (typeof v === 'number' || typeof v === 'string') out[key] = v; break
        default: { const o = plainObject(v, `/${key}`, extra); if (o) out[key] = o }
      }
    }
    // identity the snapshot left out is still the open file's
    for (const k of FROM_LIVE) if (!(k in out) && liveRec[k] !== undefined) out[k] = liveRec[k]
    return { out, extra }
  })
  const doc = result.out as unknown as BentoDoc
  if (!doc.slides.length) return null
  if (!doc.size || typeof doc.size.width !== 'number' || typeof doc.size.height !== 'number') doc.size = live.size
  if (!isObj(doc.theme)) doc.theme = live.theme
  return { doc, dropped: [...dropped, ...result.extra] }
}
