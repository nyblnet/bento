#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// kernel/src/convert/zip.ts — the decompression-bomb output cap.
//
//   node scripts/test-zip-bomb.ts
//
// WHAT THIS PROVES. readZip used to inflate a deflated entry FULLY into memory
// and only THEN check its size against the central directory — so an archive
// whose header UNDER-declares the uncompressed size (deflate expands ~1032:1)
// exhausted memory before any guard ran. The fix caps output INSIDE the inflate,
// at min(declared size, a hard per-entry ceiling), aborting the stream the
// instant cumulative output passes the cap. These checks pin that:
//   1. an entry that expands past its DECLARED usize throws at the cap, not OOM;
//   2. an entry that expands past the HARD CEILING throws at the cap;
//   3. a legitimate entry at/under the ceiling still opens, bytes intact;
//   4. a STORED entry that lies about its size is refused, not crashed.
// All fixtures are tiny (≤256 KB) — the point is that the cap fires early, so the
// bomb never needs to be big to be caught, and the rig never allocates a bomb.

import { writeZip, readZip, ZipError, ZipBombError, MAX_ENTRY_BYTES, _internals } from '../kernel/src/convert/zip.ts'

let failures = 0, checks = 0
function ok(what: string, cond: unknown): void {
  checks++
  if (cond) return
  failures++
  console.error(`  FAIL  ${what}`)
}
async function throwsBomb(what: string, fn: () => Promise<unknown>): Promise<void> {
  checks++
  try { await fn(); failures++; console.error(`  FAIL  ${what} — it did NOT throw`) }
  catch (e) {
    // Match the CAP refusal specifically ("possible decompression bomb"), not the
    // "truncated or damaged" size-mismatch throw — and not the entry NAME, which
    // is why the fixtures below are named neutrally. Under a neutered cap the
    // size check fires with a different message and this correctly fails.
    const msg = e instanceof Error ? e.message : String(e)
    if (e instanceof ZipError && /decompression bomb/i.test(msg)) return
    failures++
    console.error(`  FAIL  ${what} — threw the wrong thing: ${e instanceof Error ? e.name : ''} ${msg}`)
  }
}

const zeros = (n: number): Uint8Array => new Uint8Array(n) // deflates ~1000:1

/** Overwrite the central-directory `usize` (uncompressed size) of the first
 *  entry with a lie — the crafted-header case, built from a real archive so
 *  everything else (csize, offsets, CRC) stays honest. */
function lieAboutSize(zip: Uint8Array, declared: number): Uint8Array {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const eocd = _internals.findEocd(v, zip.length)
  const cdOffset = v.getUint32(eocd + 16, true)
  // central-directory record: usize is a u32 at offset +24 (see readZip).
  v.setUint32(cdOffset + 24, declared, true)
  return zip
}

// ————— 1. under-declared usize: expands past what the directory promises —————
{
  const honest = await writeZip([{ name: 'a.bin', data: zeros(256 * 1024) }])
  const lying = lieAboutSize(honest.slice(), 10) // says 10 bytes; expands to 256 KB
  await throwsBomb('an entry that expands past its declared usize is refused', () => readZip(lying))
}

// ————— 2. past the HARD CEILING (declared size honest, ceiling injected tiny) —————
{
  const honest = await writeZip([{ name: 'big.bin', data: zeros(200 * 1024) }])
  await throwsBomb('an entry past the hard ceiling is refused', () => readZip(honest, { maxEntryBytes: 1000 }))
}

// ————— 3. a legitimate entry at/under the ceiling opens, bytes intact —————
{
  const payload = new TextEncoder().encode('the quick brown fox '.repeat(20)) // ~400 B
  const honest = await writeZip([{ name: 'ok.txt', data: payload }])
  const parts = await readZip(honest, { maxEntryBytes: 64 * 1024 }) // well above the entry
  const got = parts.get('ok.txt')
  ok('a legitimate entry under the ceiling still opens', !!got)
  ok('…and its bytes are intact', !!got && got.length === payload.length && got.every((b, i) => b === payload[i]))
}

// ————— 4. a STORED (uncompressed) entry that lies is refused, not crashed —————
{
  // Force store: a payload of ≤64 bytes is stored, not deflated (writeZip rule).
  const honest = await writeZip([{ name: 's.bin', data: new Uint8Array([1, 2, 3, 4]) }])
  const lying = lieAboutSize(honest.slice(), 9999)
  checks++
  try { await readZip(lying); failures++; console.error('  FAIL  a stored entry that lies about its size is refused — it did NOT throw') }
  catch (e) { if (!(e instanceof ZipError)) { failures++; console.error(`  FAIL  stored-lie threw a non-ZipError: ${String(e)}`) } }
}

// ————— sanity: the exported ceiling is a real, sane number —————
ok('MAX_ENTRY_BYTES is a positive byte ceiling', typeof MAX_ENTRY_BYTES === 'number' && MAX_ENTRY_BYTES > 0)
ok('ZipBombError is a ZipError subclass', new ZipBombError('x') instanceof ZipError)

console.log(failures ? `\ntest-zip-bomb: ${failures} FAILED of ${checks}` : `test-zip-bomb: ${checks} checks OK`)
process.exit(failures ? 1 : 0)
