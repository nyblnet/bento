// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Images: content-addressed storage, and downscaling that says so.
//
// Images are the only thing that makes a space large — prose is essentially
// free — so this is where the file-size story is won or lost. Two decisions do
// the work: identical bytes are stored once, and a photo off a phone is
// downscaled before it travels, visibly and reversibly.

import { pageAssetKeys, type SpacesDoc } from './model.ts'

/** Longest edge kept when downscaling. Above this, detail is invisible in a
 *  text column and costs megabytes. */
export const MAX_EDGE = 1600
/** Above this, ask before embedding rather than silently making a 30MB file. */
export const IMAGE_EMBED_BUDGET = 4 * 1024 * 1024
/**
 * The same question for a video or an audio clip, at twice the threshold.
 *
 * Higher than the image budget ON PURPOSE, and the reason is that nothing here
 * can be made smaller. A photo off a phone is downscaled before it travels
 * (prepareImage), so 4MB is a number an author almost never meets; a clip is
 * embedded byte for byte, because re-encoding video in a browser tab means
 * shipping an encoder and taking minutes over it. So the budget is the point
 * at which the question is worth asking rather than a size we can rescue, and
 * it matches slides' MEDIA_EMBED_BUDGET so the two apps ask at the same place.
 */
export const MEDIA_EMBED_BUDGET = 8 * 1024 * 1024
/** Where a space stops being comfortable to mail. Warn, never block. */
export const SPACE_WEIGHT_WARN = 25 * 1024 * 1024

/**
 * A content-addressed key.
 *
 * `s` = sha256 via crypto.subtle. `f` = a synchronous FNV-1a fallback, which
 * exists ONLY so a missing crypto.subtle degrades to "the image still inserts"
 * rather than throwing — not as support for insecure origins, where signed
 * update and bento/enc are dead too.
 *
 * The alg tag is IN the key so two builds never mint one key from two different
 * hashes. FNV-1a has little real entropy, and a collision in content-addressed
 * storage does not error — it DEDUPES, silently replacing image B with image A
 * in a file the author then mails. So interning always BYTE-COMPARES on a key
 * hit and mints a `~n` variant on mismatch, for both algorithms.
 */
async function contentKey(bytes: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    const buf = new TextEncoder().encode(bytes)
    const digest = await subtle.digest('SHA-256', buf)
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return `s${b64.slice(0, 22)}`
  }
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `f${h.toString(36)}`
}

/**
 * Put a data: URI in the asset table and return its `asset:` reference.
 *
 * ASYNC ON PURPOSE, and this is the important part: `crypto.subtle.digest`
 * cannot be awaited inside a synchronous commit callback. So the digest and
 * the byte-compare happen FIRST, and the caller then makes ONE synchronous
 * commit that writes the bytes and the reference together — which is what
 * makes an image insert a single undo step rather than two.
 */
export async function internAsset(doc: SpacesDoc, dataUri: string): Promise<string> {
  if (!dataUri.startsWith('data:')) return dataUri
  const assets = (doc.assets ??= {})
  const base = await contentKey(dataUri)
  let key = base
  for (let n = 1; ; n++) {
    const held = assets[key]
    if (held === undefined) break        // free
    if (held === dataUri) return `asset:${key}`  // genuinely the same image
    key = `${base}~${n}`                 // a collision, not a duplicate
  }
  assets[key] = dataUri
  return `asset:${key}`
}

/** Assets no block references any more. */
export function orphanAssets(doc: SpacesDoc): string[] {
  const used = new Set<string>()
  for (const p of doc.pages) {
    // a page's COVER is a reference outside its blocks, and the only one. Miss
    // it and every cover reads as an orphan the readout offers to delete.
    for (const k of pageAssetKeys(p)) used.add(k)
    for (const b of p.blocks) {
      for (const v of [b.src, (b as Record<string, unknown>).poster]) {
        if (typeof v === 'string' && v.startsWith('asset:')) used.add(v.slice(6))
      }
    }
  }
  for (const f of doc.fonts ?? []) used.add(f.asset)
  return Object.keys(doc.assets ?? {}).filter((k) => !used.has(k))
}

/** Roughly what this document weighs, for the readout. */
export function docWeight(doc: SpacesDoc): number {
  let n = 0
  for (const v of Object.values(doc.assets ?? {})) n += v.length
  for (const p of doc.pages) for (const b of p.blocks) n += (b.html ?? '').length + 80
  return n
}

export interface PreparedImage {
  /** data: URI ready to intern */
  dataUri: string
  /** intrinsic size AFTER any downscale — holds the aspect box while decoding */
  w: number
  h: number
  /** false when the bytes were re-encoded, so the UI can say so and offer the original */
  original: boolean
  /** bytes before, for the badge */
  wasBytes: number
}

/**
 * Read a picked file and, if it is large, re-encode it smaller.
 *
 * A phone photo is 3–8 MB and 4000px wide; in a 720px text column that detail
 * is invisible and the megabytes travel with the file forever. Downscaling is
 * the difference between a space you can mail and one you cannot.
 *
 * It is REVERSIBLE and it says so: the block records `original: false`, the
 * editor badges it, and "Use the original" re-inserts the untouched bytes. A
 * silent quality change to someone's photograph would not be acceptable.
 */
export async function prepareImage(file: File | Blob): Promise<PreparedImage> {
  const raw = await blobToDataUri(file)
  const wasBytes = raw.length

  let bmp: ImageBitmap | null = null
  try { bmp = await createImageBitmap(file) } catch { /* not a decodable image */ }
  if (!bmp) return { dataUri: raw, w: 0, h: 0, original: true, wasBytes }

  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height))
  // small enough already, or an image whose bytes are already tiny: keep them.
  // Re-encoding a 40KB PNG as WebP can make it BIGGER and always loses fidelity.
  if (scale === 1 && raw.length < 600 * 1024) {
    const out = { dataUri: raw, w: bmp.width, h: bmp.height, original: true, wasBytes }
    bmp.close()
    return out
  }

  const w = Math.round(bmp.width * scale)
  const h = Math.round(bmp.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) { bmp.close(); return { dataUri: raw, w: bmp.width, h: bmp.height, original: true, wasBytes } }
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()

  const encoded = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', 0.82))
  if (!encoded) return { dataUri: raw, w, h, original: true, wasBytes }
  const smaller = await blobToDataUri(encoded)
  // never let "optimising" make it bigger
  if (smaller.length >= raw.length) return { dataUri: raw, w, h, original: true, wasBytes }
  return { dataUri: smaller, w, h, original: false, wasBytes }
}

export function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result))
    r.onerror = () => rej(r.error)
    r.readAsDataURL(blob)
  })
}

export const humanBytes = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : n >= 1024 ? `${Math.round(n / 1024)} KB`
      : `${n} B`
