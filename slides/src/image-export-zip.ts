// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A STORE-only ZIP writer, sized for exactly one job: handing the user ONE
// download instead of twenty.
//
// Verified by scripts/test-slide-image-export.ts, which checks the bytes with
// `unzip -t` and python's `zipfile` rather than with a reader of our own —
// a writer agreeing with its own parser proves nothing about Finder.
//
// WHY STORE AND NOTHING ELSE. A PNG is already DEFLATE-compressed; running it
// through DEFLATE again spends CPU to make the archive marginally bigger. So
// there is no compressor here, and therefore no CompressionStream dependency,
// no ZIP64, no reader, no directory entries and no generic archive
// abstraction — every one of those would be shell bytes shipped inside every
// document to serve a case this feature does not have.
//
// WHY NOT dash/src/zip.ts. App zones do not depend on one another
// (docs/PARALLEL-WORK.md §1): slides importing from dash would couple two
// independently-released apps through a file neither of them owns. That module
// was read as an algorithm reference and left where it is.
//
// SCOPE LIMIT, stated rather than discovered later: everything here is 32-bit.
// An archive that would need ZIP64 is REFUSED, never silently truncated into a
// file that unzips as garbage.

// The error type only — importing it from image-export.ts would make the two
// modules a cycle (see image-export-errors.ts).
import { SlideImageExportError } from './image-export-errors'

export interface StoreZipEntry {
  name: string
  data: Uint8Array
}

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

/** ZIP version 2.0: the floor for the UTF-8 name flag. */
const VERSION = 20
/** General purpose bit 11 — names and comments are UTF-8. */
const FLAG_UTF8 = 0x0800
const METHOD_STORE = 0

const LOCAL_HEADER = 30
const CENTRAL_HEADER = 46
const EOCD_SIZE = 22

const MAX_U32 = 0xFFFFFFFF
/** The EOCD counts entries in 16 bits, and we do not write ZIP64. */
const MAX_ENTRIES = 0xFFFF

const CONTROL = new RegExp('[\\u0000-\\u001F\\u007F]')

// --- crc-32 -----------------------------------------------------------------

/** Lazily built so a document that never exports pays nothing for the table. */
let TABLE: Uint32Array | null = null

function table(): Uint32Array {
  if (TABLE) return TABLE
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  TABLE = t
  return t
}

/** CRC-32/ISO-HDLC, the one ZIP uses. Check value: "123456789" → 0xCBF43926. */
export function crc32(data: Uint8Array): number {
  const t = table()
  let c = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

// --- names ------------------------------------------------------------------

/**
 * An entry name becomes a path inside somebody's filesystem the moment they
 * double-click the archive, so the ingredients of a "zip slip" are refused
 * outright. Our own names are `slide-01.png`; this guard is here for the day
 * someone makes them configurable.
 */
function assertSafeName(name: string) {
  const bad = (why: string): never => {
    throw new SlideImageExportError('archive', `Cannot put ${JSON.stringify(name)} in the archive: ${why}.`)
  }
  if (typeof name !== 'string' || !name) bad('an entry needs a name')
  if (name.length > 200) bad('the name is too long')
  if (CONTROL.test(name)) bad('the name contains a control character')
  if (name.startsWith('/')) bad('an absolute path would escape the folder it is unzipped into')
  if (name.includes('\\')) bad('a backslash is a path separator on Windows')
  if (/^[A-Za-z]:/.test(name)) bad('a drive letter is not a relative name')
  if (name.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    bad('a relative path segment would escape the folder it is unzipped into')
  }
}

// --- writing ----------------------------------------------------------------

/**
 * DOS date/time, in UTC.
 *
 * ZIP conventionally stores LOCAL time with no zone, which would make the same
 * export produce different bytes in Berlin and in Tokyo. Determinism is worth
 * more here than matching a convention that is ambiguous by construction, so
 * this is UTC and says so.
 */
function dosStamp(at: Date): { time: number; date: number } {
  const y = at.getUTCFullYear()
  if (!Number.isFinite(y) || y < 1980) return { time: 0, date: (1 << 5) | 1 } // the DOS epoch floor
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((y - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  }
}

/** A cursor over one exactly-sized buffer: the size was computed up front, so
 *  a short or long write is a bug that must surface here, not in Finder. */
class Writer {
  private buf: Uint8Array
  private at = 0
  constructor(size: number) { this.buf = new Uint8Array(size) }
  u16(v: number) { this.buf[this.at++] = v & 0xFF; this.buf[this.at++] = (v >>> 8) & 0xFF }
  u32(v: number) { this.u16(v & 0xFFFF); this.u16((v >>> 16) & 0xFFFF) }
  bytes(b: Uint8Array) { this.buf.set(b, this.at); this.at += b.length }
  get offset() { return this.at }
  done(): Uint8Array {
    if (this.at !== this.buf.length) {
      throw new SlideImageExportError('archive',
        `The archive came out ${this.buf.length - this.at} bytes away from its own plan.`)
    }
    return this.buf
  }
}

/**
 * Build one STORE archive.
 *
 * `at` defaults to the DOS epoch rather than to `new Date()`: an export that is
 * deterministic only when the caller remembers to pass a timestamp is not
 * deterministic.
 */
export function writeStoreZip(
  entries: readonly StoreZipEntry[],
  at: Date = new Date(Date.UTC(1980, 0, 1)),
): Uint8Array {
  if (entries.length > MAX_ENTRIES) {
    throw new SlideImageExportError('archive',
      `${entries.length} entries is more than one archive can hold (limit ${MAX_ENTRIES}).`)
  }

  const stamp = dosStamp(at)
  const seen = new Set<string>()
  const encoder = new TextEncoder()

  // PLAN FIRST, WRITE SECOND. Every bound is checked here, against LENGTHS,
  // before a byte is allocated or a 32-bit field is truncated.
  const planned = entries.map((entry) => {
    assertSafeName(entry.name)
    if (seen.has(entry.name)) {
      throw new SlideImageExportError('archive', `Two entries are both called ${JSON.stringify(entry.name)}.`)
    }
    seen.add(entry.name)
    const name = encoder.encode(entry.name)
    const size = entry.data?.length
    if (typeof size !== 'number' || !Number.isFinite(size) || !Number.isInteger(size) || size < 0) {
      throw new SlideImageExportError('archive', `Entry ${JSON.stringify(entry.name)} has no usable data.`)
    }
    if (size > MAX_U32) {
      throw new SlideImageExportError('archive',
        `Entry ${JSON.stringify(entry.name)} is too large for a plain zip (ZIP64 is not supported).`)
    }
    return { entry, name, size, crc: 0 }
  })

  let localBytes = 0
  let centralBytes = 0
  for (const p of planned) {
    localBytes += LOCAL_HEADER + p.name.length + p.size
    centralBytes += CENTRAL_HEADER + p.name.length
    // Offsets are 32-bit fields. The moment the running total stops being
    // representable the archive is unwritable — say so rather than wrap.
    if (localBytes > MAX_U32 || localBytes + centralBytes + EOCD_SIZE > MAX_U32) {
      throw new SlideImageExportError('archive',
        'These images are too large to fit in one archive (ZIP64 is not supported).')
    }
  }

  const w = new Writer(localBytes + centralBytes + EOCD_SIZE)
  const offsets: number[] = []

  for (const p of planned) {
    offsets.push(w.offset)
    p.crc = crc32(p.entry.data)
    w.u32(LOCAL_SIG)
    w.u16(VERSION)
    w.u16(FLAG_UTF8)
    w.u16(METHOD_STORE)
    w.u16(stamp.time)
    w.u16(stamp.date)
    w.u32(p.crc)
    w.u32(p.size)   // compressed
    w.u32(p.size)   // uncompressed — STORE, so they are one number
    w.u16(p.name.length)
    w.u16(0)        // no extra field
    w.bytes(p.name)
    w.bytes(p.entry.data)
  }

  const centralAt = w.offset
  planned.forEach((p, i) => {
    w.u32(CENTRAL_SIG)
    w.u16(VERSION)  // version made by
    w.u16(VERSION)  // version needed to extract
    w.u16(FLAG_UTF8)
    w.u16(METHOD_STORE)
    w.u16(stamp.time)
    w.u16(stamp.date)
    w.u32(p.crc)
    w.u32(p.size)
    w.u32(p.size)
    w.u16(p.name.length)
    w.u16(0)        // extra
    w.u16(0)        // comment
    w.u16(0)        // disk number where this entry starts
    w.u16(0)        // internal attributes
    w.u32(0)        // external attributes
    w.u32(offsets[i])
    w.bytes(p.name)
  })

  const centralSize = w.offset - centralAt
  w.u32(EOCD_SIG)
  w.u16(0)                  // this disk
  w.u16(0)                  // disk holding the central directory
  w.u16(planned.length)     // entries on this disk
  w.u16(planned.length)     // entries in total
  w.u32(centralSize)
  w.u32(centralAt)
  w.u16(0)                  // no archive comment

  return w.done()
}
