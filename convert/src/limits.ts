// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Refuse a .pptx that would hurt the machine reading it — BEFORE inflating it.
//
// A .pptx is a ZIP from a program we do not control, and the public import page
// accepts one from anyone. `readZip` (kernel/src/convert/zip.ts) inflates each
// entry in full and only then compares it with the size the central directory
// declared, so a decompression bomb detonates before any check runs. This reads
// the central directory ONLY — a few hundred bytes of structure, no inflation —
// and refuses on what the archive itself declares.
//
// WHAT THIS DOES NOT COVER, stated rather than implied. An archive that LIES in
// its central directory (declares a small size, inflates to a huge one) passes
// this and is caught by readZip's size check only after inflating. Closing that
// needs a byte cap inside the kernel's inflateRaw — it is shared with dash's
// .xlsx import, which has the same exposure — so it belongs to the kernel zone
// under the lock. Reported there privately rather than duplicated here: a second
// ZIP reader in this directory would be a second thing to keep correct.

export const LIMITS = {
  /** the .pptx itself. The census's largest real deck is 275MB of photos, and a
   *  file that size cannot become a usable self-contained HTML document anyway. */
  inputBytes: 100 * 1024 * 1024,
  /** sum of every entry's DECLARED uncompressed size */
  totalUncompressed: 300 * 1024 * 1024,
  /** parts in the archive. The census template, all 82 layouts and 386 icons
   *  included, has well under 2,000. */
  entries: 5_000,
  /** a large part compressing better than this is not a document part. Text
   *  XML runs ~5–20:1; deflate's theoretical ceiling is ~1032:1. */
  ratio: 200,
  /** ...but only judged above this size, where a bomb would matter at all */
  ratioFloor: 1024 * 1024,
} as const

export class LimitError extends Error {}

const SIG_EOCD = 0x06054b50
const SIG_CD = 0x02014b50

/**
 * Throw a LimitError naming the limit, or return the declared totals.
 * Structural damage is left to readZip, which reports it better.
 */
export function preflight(bytes: Uint8Array): { entries: number; uncompressed: number } {
  const mb = (n: number) => `${Math.round(n / 1024 / 1024)}MB`
  if (bytes.length > LIMITS.inputBytes)
    throw new LimitError(`this file is ${mb(bytes.length)}; the limit is ${mb(LIMITS.inputBytes)}`)
  if (bytes.length < 22) return { entries: 0, uncompressed: 0 }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22, min = Math.max(0, bytes.length - 22 - 0xffff); i >= min; i--) {
    if (v.getUint32(i, true) === SIG_EOCD) { eocd = i; break }
  }
  if (eocd < 0) return { entries: 0, uncompressed: 0 } // not a zip: readZip says so
  const count = v.getUint16(eocd + 10, true)
  const cdOffset = v.getUint32(eocd + 16, true)
  // A real .pptx is nowhere near 4GB or 65,535 parts. The ZIP64 escape values
  // here mean an archive built to be large, which this page has no reason to
  // take on.
  if (count === 0xffff || cdOffset === 0xffffffff)
    throw new LimitError('this archive uses ZIP64 sizes; a presentation never needs them')
  if (count > LIMITS.entries)
    throw new LimitError(`this archive has ${count} parts; the limit is ${LIMITS.entries}`)

  let total = 0
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== SIG_CD) break // damage: readZip's to report
    const csize = v.getUint32(p + 20, true)
    const usize = v.getUint32(p + 24, true)
    if (usize === 0xffffffff || csize === 0xffffffff)
      throw new LimitError('this archive uses ZIP64 sizes; a presentation never needs them')
    total += usize
    if (total > LIMITS.totalUncompressed)
      throw new LimitError(`this file unpacks to more than ${mb(LIMITS.totalUncompressed)}`)
    if (usize > LIMITS.ratioFloor && usize > LIMITS.ratio * Math.max(csize, 1))
      throw new LimitError(`one part compresses ${Math.round(usize / Math.max(csize, 1))}:1 — that is not a document part`)
    p += 46 + v.getUint16(p + 28, true) + v.getUint16(p + 30, true) + v.getUint16(p + 32, true)
  }
  return { entries: count, uncompressed: total }
}
