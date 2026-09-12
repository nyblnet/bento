// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Save-time pruning of doc.assets. Pure — no DOM — so the rig runs in node.

import type { BentoDoc, Slide } from './model'

/**
 * Every asset key the document still refers to, in every form the format has.
 *
 * The forms are deliberately enumerated rather than found by a generic walk,
 * because the format uses TWO conventions and a walk that knows only one
 * would treat the other as unreferenced and delete it: `image.src` and
 * `media.src`/`media.poster` say `asset:<key>`; `svg.asset`,
 * `code.grammarAssetId`, `code.themeAssetId` and `fonts[].asset` hold the
 * bare key. A new field that references an asset must be added HERE, or the
 * asset it names is dropped from the file on the next save. That is the cost
 * of this function existing, and the rig pins every form so a regression
 * shows as a failed check rather than a missing image.
 *
 * Layouts are Slide-shaped and can hold assets a normal slide does not, so
 * they are walked too. Interactive states and hover sets are ordinary slides
 * and elements and need nothing special.
 */
export function referencedAssetKeys(doc: BentoDoc): Set<string> {
  const used = new Set<string>()
  const prefixed = (v: string | undefined) => { if (v?.startsWith('asset:')) used.add(v.slice(6)) }
  const bare = (v: string | undefined) => { if (v) used.add(v) }
  const walk = (slide: Slide) => {
    for (const el of slide.elements) {
      switch (el.type) {
        case 'image': prefixed(el.src); break
        case 'media': prefixed(el.src); prefixed(el.poster); break
        case 'svg': bare(el.asset); break
        case 'code': bare(el.grammarAssetId); bare(el.themeAssetId); break
      }
    }
  }
  doc.slides.forEach(walk)
  doc.layouts?.forEach(walk)
  doc.fonts?.forEach((f) => bare(f.asset))
  return used
}

/**
 * A copy of `doc` with every asset nothing refers to removed — what a SAVE
 * should write. The live document is never touched: undo history in memory
 * still holds the deleted element and the asset it pointed at, so ⌘Z after a
 * save brings both back, and the following save keeps the asset because it is
 * referenced again.
 *
 * Why this exists (#442): `doc.assets` was append-only. Add images, delete
 * every slide, save — and the "empty" deck was still 20 MB, because deleting
 * an element removes the reference and nothing ever removed the bytes. A deck
 * could only ever grow.
 *
 * `blobs` (docs/blob-offload.md) is pruned to the same key set: a blob entry
 * for an asset nothing references is a pointer to bytes nobody will fetch.
 *
 * Returns the SAME object when there is nothing to drop, so a caller can tell
 * an untouched document from a copied one, and so the common case costs a
 * walk and no allocation.
 *
 * Under live collaboration the CRDT syncs `assets` per key, so pruning the
 * saved copy cannot lose a peer their asset — their replica keeps it. The one
 * gap: a file that pruned key K, was reopened, and then receives a peer's op
 * re-referencing K (an undo on the peer, say) will show that one image broken
 * on that replica only, until it is re-added. Rare, non-corrupting, and the
 * trade against every deck growing without bound is not close.
 */
export function pruneUnusedAssets(doc: BentoDoc): BentoDoc {
  if (!doc.assets) return doc
  const used = referencedAssetKeys(doc)
  const assets: Record<string, string> = {}
  let dropped = 0
  for (const [key, value] of Object.entries(doc.assets)) {
    if (used.has(key)) assets[key] = value
    else dropped++
  }
  if (!dropped) return doc
  const out: BentoDoc = { ...doc, assets }
  if (Object.keys(assets).length === 0) delete out.assets
  if (doc.blobs) {
    const blobs = Object.fromEntries(Object.entries(doc.blobs).filter(([key]) => used.has(key)))
    if (Object.keys(blobs).length) out.blobs = blobs
    else delete out.blobs
  }
  return out
}
