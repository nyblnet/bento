// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A minimal ZIP reader and writer — the container .xlsx is made of.
//
// WHY THIS EXISTS RATHER THAN A DEPENDENCY. The shell ships as one
// self-contained HTML file and the whole app is ~98 KB compressed. JSZip is
// ~100 KB and SheetJS is larger than the entire product, so either one doubles
// the file every user downloads in order to open a format most of them will
// never touch. What .xlsx actually needs from ZIP is a fraction of the spec: a
// few dozen small parts, DEFLATE or stored, no encryption, no spanning, no
// streaming producer. That fraction is this file, and the browser already
// carries the expensive half — `DecompressionStream`/`CompressionStream`
// ('deflate-raw') are the same primitives the compressed-shell loader boots on,
// so the baseline is established and costs us nothing.
//
// THE READER TRUSTS THE CENTRAL DIRECTORY, NOT THE LOCAL HEADERS, and that is
// the single decision that makes a hand-written reader survive real files.
// A writer that does not know a part's size in advance (every streaming
// producer — which is most server-side xlsx generators) sets general-purpose
// bit 3, writes zeroes for crc/sizes in the local header, and appends a data
// DESCRIPTOR after the compressed bytes. Reading sizes from the local header
// then yields zero, and the naive fix — scanning forward for the next signature
// — collides with compressed data that happens to contain those four bytes.
// The central directory always has the true sizes. The local header is read for
// exactly one thing: its name and extra-field lengths, which give the offset
// where the data begins, and which may legitimately DIFFER from the central
// copy's (Excel itself writes a Zip64 extra field in one and not the other).
//
// WHAT IS DELIBERATELY NOT HERE: encryption (an encrypted xlsx must be refused,
// loudly, not half-read), multi-disk archives (a floppy-era feature), ZIP64
// WRITING (we would have to be emitting >4 GB from a browser tab, which the
// document budget rules out long before), and CP437 filename decoding — every
// part name inside an OPC package is ASCII by specification, so UTF-8 decodes
// it correctly whether or not the flag bit is set.

/** Thrown for a container that is not a ZIP, or is one we refuse to guess at. */
export class ZipError extends Error {
  constructor(message: string) { super(message); this.name = 'ZipError' }
}

const SIG_LOCAL = 0x04034b50
const SIG_CD = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOC = 0x07064b50

const enc = new TextEncoder()
const dec = new TextDecoder()

// --- CRC-32 -----------------------------------------------------------------
// Built once, on first use. A ZIP whose CRCs are wrong is a ZIP that `unzip -t`
// rejects and Excel calls corrupt, and there is no way to notice by eye — which
// is exactly why the reader verifies them too (see `readZip`).

let CRC_TABLE: Uint32Array | null = null

function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  CRC_TABLE = t
  return t
}

/** The ZIP/PNG CRC-32 of a byte range. Exported because the rig checks it
 *  against a known vector — a self-consistent wrong CRC would be invisible. */
export function crc32(b: Uint8Array): number {
  const t = crcTable()
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// --- DEFLATE, through the platform -------------------------------------------

const hasCompression = (): boolean => typeof CompressionStream !== 'undefined'

async function through(b: Uint8Array, s: ReadableWritablePair<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  // A Blob is the shortest route from bytes to a ReadableStream that works
  // identically in a browser and in node's rigs; `Response.arrayBuffer` is the
  // shortest route back. Neither allocates more than one extra copy.
  const out = new Blob([b as BlobPart]).stream().pipeThrough(s as ReadableWritablePair<BufferSource, BufferSource>)
  return new Uint8Array(await new Response(out as BodyInit).arrayBuffer())
}

const inflateRaw = (b: Uint8Array): Promise<Uint8Array> =>
  through(b, new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)

const deflateRaw = (b: Uint8Array): Promise<Uint8Array> =>
  through(b, new CompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)

// --- Reading -----------------------------------------------------------------

export interface ZipEntry {
  name: string
  data: Uint8Array
}

/**
 * Every part of a ZIP archive, by name.
 *
 * A Map rather than an object because part names are attacker-adjacent data:
 * `__proto__` is a perfectly legal ZIP entry name, and an object keyed by it is
 * a prototype-pollution hole in a file format people will open from email.
 */
export type ZipParts = Map<string, Uint8Array>

const u16 = (v: DataView, at: number): number => v.getUint16(at, true)
const u32 = (v: DataView, at: number): number => v.getUint32(at, true)
/** 64-bit little-endian as a JS number. Exact below 2^53, which every real
 *  archive is; beyond it we would already have failed on allocation. */
const u64 = (v: DataView, at: number): number =>
  v.getUint32(at, true) + v.getUint32(at + 4, true) * 0x100000000

/** Locate the end-of-central-directory record, searching back over the
 *  (almost always empty) archive comment. */
function findEocd(v: DataView, len: number): number {
  const min = Math.max(0, len - 22 - 0xffff)
  for (let i = len - 22; i >= min; i--) if (u32(v, i) === SIG_EOCD) return i
  throw new ZipError('this file does not end in a ZIP central directory — it is not an .xlsx')
}

/**
 * Read an archive into its parts.
 *
 * CRCs ARE VERIFIED. It costs one extra pass over data we have just inflated
 * anyway, and it converts the entire class of "the file was truncated by a mail
 * gateway / a partial download / a bad USB stick" from *silently short data*
 * into a refusal. Silently short data in a spreadsheet importer means a column
 * that stops early and a total that is wrong by exactly the missing rows, and
 * nothing on screen says so.
 */
export async function readZip(bytes: Uint8Array): Promise<ZipParts> {
  if (bytes.length < 22) throw new ZipError('this file is too small to be a ZIP archive')
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEocd(v, bytes.length)

  let count = u16(v, eocd + 10)
  let cdOffset = u32(v, eocd + 16)

  // ZIP64 — reading only. Both markers must be honoured: an archive with more
  // than 65535 parts saturates the count, one over 4 GB saturates the offset,
  // and Excel writes ZIP64 for either. Missing this reads the central directory
  // from offset 0xFFFFFFFF, i.e. off the end, and the file "is not a ZIP".
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20
    if (loc < 0 || u32(v, loc) !== SIG_EOCD64_LOC) {
      throw new ZipError('this archive claims ZIP64 sizes but carries no ZIP64 locator')
    }
    const at = u64(v, loc + 8)
    if (u32(v, at) !== SIG_EOCD64) throw new ZipError('the ZIP64 central directory record is missing')
    count = u64(v, at + 32)
    cdOffset = u64(v, at + 48)
  }

  const parts: ZipParts = new Map()
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (u32(v, p) !== SIG_CD) throw new ZipError('the ZIP central directory is damaged')
    const flags = u16(v, p + 8)
    const method = u16(v, p + 10)
    const crc = u32(v, p + 16)
    let csize = u32(v, p + 20)
    let usize = u32(v, p + 24)
    const nameLen = u16(v, p + 28)
    const extraLen = u16(v, p + 30)
    const commentLen = u16(v, p + 32)
    let local = u32(v, p + 42)
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen))

    // Bit 0 is the 1989 password scheme; bit 6 is AES. Either way the bytes are
    // not the bytes, and half-reading them would produce garbage that looks
    // like a parse failure rather than a locked file.
    if (flags & 1) throw new ZipError(`"${name}" is encrypted — dash cannot open a password-protected workbook`)

    // The ZIP64 extra field replaces exactly the fields that saturated, in a
    // fixed order, and ONLY those. Reading it positionally without checking
    // which ones saturated is the classic way to shift every value by 8 bytes.
    if (usize === 0xffffffff || csize === 0xffffffff || local === 0xffffffff) {
      let e = p + 46 + nameLen
      const end = e + extraLen
      while (e + 4 <= end) {
        const id = u16(v, e)
        const size = u16(v, e + 2)
        if (id === 0x0001) {
          let q = e + 4
          if (usize === 0xffffffff) { usize = u64(v, q); q += 8 }
          if (csize === 0xffffffff) { csize = u64(v, q); q += 8 }
          if (local === 0xffffffff) { local = u64(v, q) }
          break
        }
        e += 4 + size
      }
    }

    if (u32(v, local) !== SIG_LOCAL) throw new ZipError(`"${name}" does not start with a ZIP local header`)
    // The LOCAL header's own name/extra lengths, never the central copy's:
    // Excel writes a ZIP64 extra field into one and not the other, and using
    // the wrong pair starts the data a few bytes early. The symptom is an
    // inflate error on a file every other tool opens.
    const dataAt = local + 30 + u16(v, local + 26) + u16(v, local + 28)
    const raw = bytes.subarray(dataAt, dataAt + csize)

    let data: Uint8Array
    if (method === 0) data = raw
    else if (method === 8) {
      // DecompressionStream rejects with a bare TypeError whose message is
      // often EMPTY, which is how a damaged file first showed up here: the
      // caller saw an unnamed exception from somewhere inside a stream and had
      // nothing to tell the user. Every failure this file can produce has to
      // arrive as a ZipError naming the part, or the refusal is not a refusal.
      try {
        data = await inflateRaw(raw)
      } catch {
        throw new ZipError(`"${name}" could not be decompressed — the file is damaged or truncated`)
      }
    } else throw new ZipError(`"${name}" uses compression method ${method}, which dash does not implement`)

    if (data.length !== usize) {
      throw new ZipError(`"${name}" unpacked to ${data.length} bytes but the directory says ${usize} — the file is truncated or damaged`)
    }
    if (crc32(data) !== crc) {
      throw new ZipError(`"${name}" failed its checksum — the file is damaged, and reading it anyway would give you data that is wrong without looking wrong`)
    }
    parts.set(name, data)
    p += 46 + nameLen + extraLen + commentLen
  }
  return parts
}

// --- Writing ------------------------------------------------------------------

export interface WriteOpts {
  /** Timestamp stamped into every entry. Fixed by default, so two exports of
   *  one workbook are byte-identical and a diff means a real change. */
  at?: Date
  /** Skip DEFLATE. Only for the rig and for a browser without CompressionStream. */
  store?: boolean
}

/** DOS date/time. 1980-01-01 is the epoch of the field and the safe default —
 *  an all-zero date is out of range and makes some tools print a warning. */
function dosStamp(d: Date | undefined): { time: number; date: number } {
  if (!d) return { time: 0, date: 33 } // 1980-01-01 00:00
  const y = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/**
 * Build a ZIP archive.
 *
 * Entries are written in the order given, which for OPC matters more than it
 * looks: `[Content_Types].xml` must be the FIRST part, because a consumer is
 * entitled to stream the package and it cannot type any part until it has read
 * it. Excel tolerates it elsewhere; other readers have not always.
 *
 * DEFLATE is skipped when it does not pay (tiny parts, and anything that grew),
 * and the whole archive falls back to STORED where `CompressionStream` is
 * missing. A stored ZIP is a completely valid ZIP — just bigger — so an old
 * browser exports a working file instead of an error.
 */
export async function writeZip(entries: ZipEntry[], opts: WriteOpts = {}): Promise<Uint8Array> {
  const { time, date } = dosStamp(opts.at)
  const store = opts.store || !hasCompression()
  const locals: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  let cdSize = 0

  for (const e of entries) {
    const name = enc.encode(e.name)
    const usize = e.data.length
    const crc = crc32(e.data)
    let method = 0
    let body = e.data
    if (!store && usize > 64) {
      const z = await deflateRaw(e.data)
      // A part that got BIGGER (already-compressed media, tiny XML) is stored.
      if (z.length < usize) { method = 8; body = z }
    }

    const lh = new Uint8Array(30 + name.length)
    const lv = new DataView(lh.buffer)
    lv.setUint32(0, SIG_LOCAL, true)
    lv.setUint16(4, 20, true)      // version needed: 2.0 = DEFLATE
    lv.setUint16(6, 0x800, true)   // bit 11: the name is UTF-8
    lv.setUint16(8, method, true)
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, usize, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)
    lh.set(name, 30)

    const ch = new Uint8Array(46 + name.length)
    const cv = new DataView(ch.buffer)
    cv.setUint32(0, SIG_CD, true)
    cv.setUint16(4, 20, true)      // version made by
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x800, true)
    cv.setUint16(10, method, true)
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, usize, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    ch.set(name, 46)

    locals.push(lh, body)
    central.push(ch)
    offset += lh.length + body.length
    cdSize += ch.length
  }

  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, SIG_EOCD, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)

  return concat([...locals, ...central, eocd])
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  let n = 0
  for (const c of chunks) n += c.length
  const out = new Uint8Array(n)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out
}

export const _internals = { findEocd, dosStamp, inflateRaw, deflateRaw }
