// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The shell's runtime payload blocks, read and written in ONE place.
//
// A shell carries its runtime (bento-rt) and stylesheet (bento-rt-css) in two
// data blocks whose type says how: bento/deflate-b64 (before 1.1.1),
// bento/deflate-b86, or bento/lzma-b91. Every script that looks INSIDE a shell
// — the gate, the standalone and sandbox rigs, the converter's boundary test —
// goes through here, because each used to match the block types it knew and
// skip the rest: a new type then made those checks pass on nothing.
//
// Readers accept all three forever (old files do not change). The list is the
// payload half of kernel gate1 DATA_TYPES; scripts/test-apphash.ts holds them
// equal.
import { inflateRawSync, deflateRawSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import * as b86 from './b86.mjs'
import * as b91 from './b91.mjs'
import { unlzma } from './unlzma.js'

export const PAYLOAD_TYPES = ['bento/deflate-b64', 'bento/deflate-b86', 'bento/lzma-b91']
/** `type="…"` of a payload block, as a regex source with no groups. */
export const PAYLOAD_TYPE_RE = 'bento\\/(?:deflate-b(?:64|86)|lzma-b91)'
export const isPayloadType = (type) => PAYLOAD_TYPES.includes(type)

/** The bytes a payload block carries, decompressed. Throws on anything that is not one. */
export function unpack(type, text) {
  const t = text.trim()
  if (type === 'bento/deflate-b64') return inflateRawSync(Buffer.from(t, 'base64'))
  if (type === 'bento/deflate-b86') return inflateRawSync(Buffer.from(b86.decode(t)))
  if (type === 'bento/lzma-b91') return Buffer.from(unlzma(b91.decode(t)))
  throw new Error(`not a payload block type: ${type}`)
}

/** The text of a payload block of `type` for `bytes` — for rigs that plant into a shell. zlib and
 *  lzma1 defaults, not the release packer's settings: what it writes is read back, never shipped. */
export async function pack(type, bytes) {
  if (type === 'bento/deflate-b64') return deflateRawSync(bytes).toString('base64')
  if (type === 'bento/deflate-b86') return b86.encode(deflateRawSync(bytes))
  if (type === 'bento/lzma-b91') {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const { compress } = await import(pathToFileURL(join(root, 'slides/node_modules/lzma1/lib/index.js')).href)
    const alone = compress(bytes, { level: 5, lc: 3, lp: 0, pb: 0, endMarker: false })
    const out = Buffer.alloc(4 + alone.length - 13)
    out.writeUInt32LE(bytes.length, 0); out.set(alone.subarray(13), 4)
    return b91.encode(out)
  }
  throw new Error(`not a payload block type: ${type}`)
}
