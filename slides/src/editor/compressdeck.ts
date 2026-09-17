// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * "Compress pictures in this deck…" — the deliberate, one-click pass over
 * every picture ALREADY in a deck, the follow-up to shrink-at-insert
 * (editor/shrink.ts). A deck made before 1.2.0 carries its photos at full
 * size; this runs each through the same rules (2560 px cap, photos lossy,
 * graphics lossless, keep the original unless ≥20% smaller) and replaces the
 * bytes IN PLACE — same asset key, same element — so references, morph ids
 * and undo all keep working. The FORMAT is untouched.
 *
 * Two halves: `planCompress` (pure, node-testable) decides WHAT is a
 * candidate; `dryRun`/`apply` (browser) decode and re-encode, show the sum,
 * and write the result in one store commit. The dry run comes first so the
 * confirmation can say the real numbers, and so a deck where nothing would
 * shrink gets a toast instead of a dialog.
 *
 * Under live collaboration a changed asset value over 64 KB never rides an
 * op (crdt.ts skips it — it travels as a blob); the session re-uploads only
 * when there is no `blobs.<key>` entry yet. So a replaced asset also DROPS its
 * blob reference: the deletion syncs as an ordinary op, and the next flush
 * publishes the new bytes under a fresh blob key. Without that, peers would
 * keep fetching the old, larger picture.
 */

import type { BentoDoc, SlideElement } from '../model.ts'
import { shrinkImageFile, untouchable, type ShrinkResult } from './shrink.ts'
import { dataUriToBytes } from '../../../kernel/src/sync/blobs.ts'

/** One picture that might shrink: an asset-table entry, or an inline data URI on an image element. */
export type Candidate =
  | { kind: 'asset'; key: string; dataUrl: string; mime: string }
  | { kind: 'inline'; slideId: string; elId: string; dataUrl: string; mime: string }

const mimeOf = (dataUrl: string): string => /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? ''

/** Bytes a data URI's payload decodes to (base64 → ¾). */
export const dataUrlBytes = (u: string): number => {
  const i = u.indexOf(',')
  return i < 0 ? 0 : Math.floor(((u.length - i - 1) * 3) / 4)
}

/**
 * Which pictures are worth trying. Image elements only — media (poster and
 * clip), fonts, svg elements and code themes are not pictures the classifier
 * knows. An `asset:` reference names its table entry once, however many
 * elements share it; an inline data URI is its own candidate. SVG and GIF are
 * left alone here, before any decoding, by mime.
 */
export function planCompress(doc: BentoDoc): Candidate[] {
  const out: Candidate[] = []
  const seenAssets = new Set<string>()
  const consider = (slideId: string, el: SlideElement) => {
    if (el.type !== 'image') return
    const src = el.src ?? ''
    if (src.startsWith('asset:')) {
      const key = src.slice(6)
      if (seenAssets.has(key)) return
      seenAssets.add(key)
      const v = doc.assets?.[key]
      if (typeof v !== 'string' || !v.startsWith('data:')) return
      const mime = mimeOf(v)
      if (!mime.startsWith('image/') || untouchable(mime)) return
      out.push({ kind: 'asset', key, dataUrl: v, mime })
    } else if (src.startsWith('data:')) {
      const mime = mimeOf(src)
      if (!mime.startsWith('image/') || untouchable(mime)) return
      out.push({ kind: 'inline', slideId, elId: el.id, dataUrl: src, mime })
    }
  }
  for (const s of doc.slides) for (const el of s.elements) consider(s.id, el)
  for (const l of doc.layouts ?? []) for (const el of l.elements) consider(l.id, el)
  return out
}

export interface Shrunk { candidate: Candidate; result: ShrinkResult }
export interface DryRun {
  /** the ones that would actually get smaller */
  shrunk: Shrunk[]
  /** bytes across the candidates that shrink */
  before: number
  after: number
  /** every candidate looked at */
  examined: number
}

/** Decode and re-encode every candidate, sequentially (the page stays live
 *  between awaits), reporting progress. Nothing is written. */
export async function dryRun(doc: BentoDoc, onProgress?: (done: number, total: number) => void): Promise<DryRun> {
  const plan = planCompress(doc)
  const shrunk: Shrunk[] = []
  let before = 0, after = 0
  for (let i = 0; i < plan.length; i++) {
    const c = plan[i]
    onProgress?.(i, plan.length)
    // Decoded by hand, never fetch(): a data: URL never reaches the network,
    // but the rule that only kernel/src/net.ts touches a network primitive is
    // by construction and the offline rig holds every file to it.
    const parsed = dataUriToBytes(c.dataUrl)
    if (!parsed) continue
    const blob = new Blob([parsed.bytes as BlobPart], { type: parsed.mime })
    const result = await shrinkImageFile(blob, { force: true, skipLossyAtCap: true })
    if (result.reason === 'shrunk') {
      shrunk.push({ candidate: c, result })
      before += result.before
      after += result.after
    }
  }
  onProgress?.(plan.length, plan.length)
  return { shrunk, before, after, examined: plan.length }
}

/** Write the dry run's results into the document — the caller wraps this in
 *  ONE store commit. Same keys, same elements; a replaced asset drops its blob
 *  reference so a live session re-uploads the new bytes. */
export function applyCompress(doc: BentoDoc, run: DryRun): number {
  let n = 0
  for (const { candidate: c, result } of run.shrunk) {
    if (c.kind === 'asset') {
      if (!doc.assets || typeof doc.assets[c.key] !== 'string') continue
      doc.assets[c.key] = result.dataUrl
      if (doc.blobs?.[c.key]) delete doc.blobs[c.key]
      n++
    } else {
      const slide = doc.slides.find((s) => s.id === c.slideId) ?? doc.layouts?.find((l) => l.id === c.slideId)
      const el = slide?.elements.find((e) => e.id === c.elId)
      if (!el || el.type !== 'image') continue
      el.src = result.dataUrl
      n++
    }
  }
  return n
}
