#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Font-file descriptor rig for bento/slides (#850).
//
//   node scripts/test-slides-font-weight.ts
//
// WHAT THIS PROVES. readFontFacts reads what a font file says about its own
// weight and style, in every container the embed picker accepts:
//
//   - a variable TTF and WOFF give their fvar wght range, "100 900"
//   - the WOFF row really goes through the inflate path: its fvar is stored
//     compressed (checked here, not assumed)
//   - a variable WOFF2 reports only `variable` — its tables are one brotli
//     stream; the range is measured in the browser rig
//   - a static TTF gives its OS/2 weight and italic bit, "700" / "italic"
//   - a static WOFF2 gives {} (its OS/2 is inside the brotli stream)
//   - the shell's own Instrument Sans (a real variable WOFF2) is variable
//   - truncated or foreign bytes give {}, never a throw
//
// The fonts are ours (scripts/fixtures/fonts, MIT); make-weight-fonts.py
// rebuilds them.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFontFacts } from '../slides/src/fontmeta.ts'
import { INSTRUMENT_VAR } from '../slides/src/fontdata.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.error('FAIL', msg) }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fonts')
const font = (name: string) => new Uint8Array(readFileSync(join(dir, name)))

const cases: Array<[string, Uint8Array, object]> = [
  ['variable ttf', font('BentoWeightVar.ttf'), { weight: '100 900' }],
  ['variable woff', font('BentoWeightVar.woff'), { weight: '100 900' }],
  ['variable woff2', font('BentoWeightVar.woff2'), { variable: true }],
  ['static bold italic ttf', font('BentoWeightStatic.ttf'), { weight: '700', style: 'italic' }],
  // a static WOFF2's OS/2 is inside the brotli stream: unreadable, so unstated
  ['static woff2', font('BentoWeightStatic.woff2'), {}],
  ['Instrument Sans woff2', Buffer.from(INSTRUMENT_VAR.split(',')[1], 'base64'), { variable: true }],
  ['truncated ttf', font('BentoWeightVar.ttf').subarray(0, 40), {}],
  ['truncated woff', font('BentoWeightVar.woff').subarray(0, 60), {}],
  ['truncated woff2', font('BentoWeightVar.woff2').subarray(0, 50), {}],
  ['not a font', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), {}],
  ['empty', new Uint8Array(0), {}],
]
for (const [name, bytes, want] of cases) {
  let got: unknown
  try { got = await readFontFacts(bytes) } catch (e) { got = `threw ${e}` }
  ok(same(got, want), `${name}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
}

// The WOFF row must exercise inflate: find fvar in its directory, stored smaller than its original.
{
  const woff = font('BentoWeightVar.woff')
  const v = new DataView(woff.buffer, woff.byteOffset, woff.byteLength)
  let compressed = false
  for (let i = 0; i < v.getUint16(12); i++) {
    const at = 44 + i * 20
    const tag = String.fromCharCode(...woff.subarray(at, at + 4))
    if (tag === 'fvar') compressed = v.getUint32(at + 8) < v.getUint32(at + 12)
  }
  ok(compressed, 'woff fixture stores fvar compressed (else the inflate path is untested)')
}

console.log(`${checks - failures}/${checks} font weight checks pass`)
if (failures) process.exit(1)
