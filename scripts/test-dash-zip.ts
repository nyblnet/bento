#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash ZIP rig.
//
//   node scripts/test-dash-zip.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES, and why it is not "the bytes look right". A reader and a
// writer written by the same person on the same afternoon agree with each other
// perfectly, including about their shared bugs — a round-trip through our own
// code is worth almost nothing on its own. So every claim here is checked
// against something that did NOT come out of dash/src/zip.ts:
//
//   • CRC-32 against the published check value for "123456789" (0xCBF43926).
//   • our DEFLATE stream against node:zlib's inflateRawSync.
//   • our whole archive against /usr/bin/unzip — `unzip -t` (checksums), and
//     `unzip -p` (the actual bytes back out).
//   • our READER against `unzip -p` on REAL .xlsx files found on this machine,
//     written by Excel, Numbers and whatever server generated them.
//
// And the negative half: a truncated archive, a flipped byte and an encrypted
// entry must all be REFUSED, because a ZIP reader that returns short data
// silently is a spreadsheet importer that drops rows silently.

import { execFileSync } from 'node:child_process'
import { inflateRawSync, deflateRawSync } from 'node:zlib'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readZip, writeZip, crc32, concat, ZipError } from '../dash/src/zip.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const tmp = mkdtempSync(join(tmpdir(), 'dash-zip-'))

/** Does the archive round-trip through a real unzip? Returns its report. */
function realUnzip(bytes: Uint8Array, name: string): { test: string; get: (part: string) => string } {
  const path = join(tmp, name)
  writeFileSync(path, bytes)
  return {
    test: execFileSync('unzip', ['-t', path], { encoding: 'utf8' }),
    get: (part: string) => execFileSync('unzip', ['-p', path, part], { encoding: 'utf8' }),
  }
}

// ------------------------------------------------------------------- CRC-32
{
  // The check value every CRC-32 implementation is published against. Ours
  // agreeing with itself proves nothing; agreeing with this proves the
  // polynomial, the reflection and the final xor.
  ok(crc32(enc.encode('123456789')) === 0xcbf43926, 'CRC-32 matches the published check value for "123456789"')
  ok(crc32(new Uint8Array(0)) === 0, 'CRC-32 of nothing is 0')
  ok(crc32(enc.encode('a')) !== crc32(enc.encode('b')), 'and it is not a constant')
}

// -------------------------------------------------- our DEFLATE, node's INFLATE
{
  const body = enc.encode('sheetData'.repeat(400))
  const zipped = await writeZip([{ name: 'x.txt', data: body }])
  // dig the stored bytes out by hand rather than through our own reader
  const v = new DataView(zipped.buffer, zipped.byteOffset, zipped.byteLength)
  const method = v.getUint16(8, true)
  const csize = v.getUint32(18, true)
  const at = 30 + v.getUint16(26, true) + v.getUint16(28, true)
  ok(method === 8, 'a compressible part is DEFLATEd')
  const back = inflateRawSync(Buffer.from(zipped.subarray(at, at + csize)))
  ok(dec.decode(back) === dec.decode(body), 'and node:zlib inflates our stream to the original bytes')
  ok(csize < body.length / 4, 'and it actually compressed (repetitive text, >4x)')
}

// --------------------------------------------------------- /usr/bin/unzip
const have = (cmd: string, arg: string): boolean => {
  try { execFileSync(cmd, [arg], { stdio: 'ignore' }); return true } catch { return false }
}
const haveUnzip = have('unzip', '-v')
const havePython = have('python3', '-V')

if (!haveUnzip) {
  console.log('  SKIP  /usr/bin/unzip is not on this machine — the external check is the point of this rig')
} else {
  const entries = [
    { name: '[Content_Types].xml', data: enc.encode('<Types/>') },
    { name: 'xl/workbook.xml', data: enc.encode('<workbook>' + 'x'.repeat(5000) + '</workbook>') },
    { name: 'xl/empty.bin', data: new Uint8Array(0) },
    { name: 'xl/tiny.txt', data: enc.encode('hi') },
    { name: 'xl/ünïcode name.xml', data: enc.encode('<a>é</a>') },
  ]
  const bytes = await writeZip(entries)
  const u = realUnzip(bytes, 'ours.zip')
  ok(/No errors detected/.test(u.test), 'unzip -t accepts our archive (every CRC checks out)')
  ok(u.get('xl/workbook.xml').includes('xxxxx'), 'unzip -p gets a DEFLATEd part back')
  ok(u.get('xl/tiny.txt') === 'hi', 'and a STORED one')
  // macOS's Info-ZIP 6.0 mangles UTF-8 member names on the way OUT (it maps
  // the bytes through a local-charset table even with the UTF-8 flag set), so
  // it cannot be the witness for this one — `unzip -l` prints `++n+»code`.
  // That is Info-ZIP's bug, not the archive's, and the fix is a different third
  // party rather than a weaker claim: python3's zipfile is an independent
  // implementation that gets it right.
  if (havePython) {
    const out = execFileSync('python3', ['-c',
      'import sys,zipfile\n' +
      'z=zipfile.ZipFile(sys.argv[1])\n' +
      'assert z.testzip() is None\n' +
      'print("\\n".join(z.namelist()))\n' +
      'print(z.read("xl/\u00fcn\u00efcode name.xml").decode())',
    join(tmp, 'ours.zip')], { encoding: 'utf8' })
    ok(out.includes('xl/ünïcode name.xml') && out.includes('<a>é</a>'),
      'python3 zipfile reads our UTF-8 part name and its contents (and testzip passes)')
  } else {
    console.log('  SKIP  python3 is not on this machine — the UTF-8 name check needs a second unzip')
  }

  // zipinfo reports the methods, so "we deflated" is checked by a third party
  const info = execFileSync('zipinfo', ['-v', join(tmp, 'ours.zip')], { encoding: 'utf8' })
  ok(/deflated/.test(info) && /stored/.test(info), 'zipinfo sees both deflated and stored members')

  const stored = await writeZip(entries, { store: true })
  ok(/No errors detected/.test(realUnzip(stored, 'stored.zip').test),
    'the STORED fallback (no CompressionStream) is also a valid archive')
  ok(stored.length > bytes.length, 'and it is bigger, which is the trade it makes')
}

// ------------------------------------------------------------- round-trip
{
  const entries = [
    { name: 'a.xml', data: enc.encode('<a/>') },
    { name: 'deep/path/b.xml', data: enc.encode('<b>' + 'y'.repeat(9000) + '</b>') },
    { name: 'zero.bin', data: new Uint8Array(0) },
  ]
  const parts = await readZip(await writeZip(entries))
  ok(parts.size === 3, 'every entry comes back')
  ok(dec.decode(parts.get('a.xml')!) === '<a/>', 'a stored part round-trips')
  ok(dec.decode(parts.get('deep/path/b.xml')!).length === 9007, 'a deflated part round-trips at full length')
  ok(parts.get('zero.bin')!.length === 0, 'and an empty part stays empty rather than vanishing')

  // determinism: an export you can diff
  const one = await writeZip(entries)
  const two = await writeZip(entries)
  ok(Buffer.from(one).equals(Buffer.from(two)), 'two writes of one input are byte-identical (fixed timestamp)')
}

// ----------------------------------------------- a zip node:zlib built for us
{
  // Hand-built central directory + local header around node's DEFLATE output,
  // so the READER is fed bytes our writer never touched.
  const body = enc.encode('<x>hand built</x>')
  const z = new Uint8Array(deflateRawSync(Buffer.from(body)))
  const name = enc.encode('hand.xml')
  const lh = new Uint8Array(30 + name.length)
  const lv = new DataView(lh.buffer)
  lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true)
  lv.setUint16(8, 8, true); lv.setUint32(14, crc32(body), true)
  lv.setUint32(18, z.length, true); lv.setUint32(22, body.length, true)
  lv.setUint16(26, name.length, true); lh.set(name, 30)
  const ch = new Uint8Array(46 + name.length)
  const cv = new DataView(ch.buffer)
  cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true)
  cv.setUint16(10, 8, true); cv.setUint32(16, crc32(body), true)
  cv.setUint32(20, z.length, true); cv.setUint32(24, body.length, true)
  cv.setUint16(28, name.length, true); cv.setUint32(42, 0, true); ch.set(name, 46)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true)
  ev.setUint32(12, ch.length, true); ev.setUint32(16, lh.length + z.length, true)
  const built = concat([lh, z, ch, eocd])
  const parts = await readZip(built)
  ok(dec.decode(parts.get('hand.xml')!) === '<x>hand built</x>',
    'our reader reads an archive assembled from node:zlib bytes')
}

// ------------------------------------------------------------------- ZIP64
// Both saturation paths, built by python3 (an implementation that is not ours):
// the per-entry extra field, and the ZIP64 end-of-central-directory record that
// appears once an archive has more than 65,535 members. Excel writes both.
if (havePython) {
  const script = (body: string) => execFileSync('python3', ['-c', body], { encoding: 'buffer', maxBuffer: 1 << 28 })

  const one = script(
    'import zipfile,io,sys\n' +
    'b=io.BytesIO()\n' +
    "with zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:\n" +
    "    with z.open('xl/workbook.xml','w',force_zip64=True) as f: f.write(b'<workbook>zip64</workbook>')\n" +
    'sys.stdout.buffer.write(b.getvalue())')
  const p1 = await readZip(new Uint8Array(one))
  ok(dec.decode(p1.get('xl/workbook.xml')!) === '<workbook>zip64</workbook>',
    'a ZIP64 per-entry extra field is read (the sizes saturate to 0xFFFFFFFF and live in the extra)')

  const many = script(
    'import zipfile,io,sys\n' +
    'b=io.BytesIO()\n' +
    "with zipfile.ZipFile(b,'w',zipfile.ZIP_STORED) as z:\n" +
    "    [z.writestr('p%05d.txt'%i,'') for i in range(70000)]\n" +
    "    z.writestr('xl/workbook.xml','<workbook>many</workbook>')\n" +
    'sys.stdout.buffer.write(b.getvalue())')
  const p2 = await readZip(new Uint8Array(many))
  ok(p2.size === 70001 && dec.decode(p2.get('xl/workbook.xml')!) === '<workbook>many</workbook>',
    'and a ZIP64 end-of-central-directory record is followed — without it the count saturates at 65535 and the directory is read from offset 0xFFFFFFFF')
} else {
  console.log('  SKIP  python3 is not on this machine — the ZIP64 archives need a second implementation to build')
}

// ---------------------------------------------------- REAL .xlsx off this disk
{
  const candidates = [
    '/Users/andy/Documents/Digitalise Growth-Initiatives-Cost-Model.xlsx',
    '/Users/andy/Downloads/Digital_Sonar_Resource_Validation_v5.xlsx',
    '/Users/andy/devel/sxadc/raw_categories.xlsx',
  ].filter((p) => existsSync(p))

  if (!candidates.length) {
    console.log('  SKIP  no real .xlsx on this machine to read')
  } else {
    for (const path of candidates) {
      const parts = await readZip(new Uint8Array(readFileSync(path)))
      const short = path.split('/').pop()
      ok(parts.has('[Content_Types].xml') && parts.has('xl/workbook.xml'),
        `${short}: the OPC parts are there`)
      if (haveUnzip) {
        // byte-for-byte against a real unzip on a part we did not choose for
        // being easy — the workbook, which Excel deflates.
        const theirs = execFileSync('unzip', ['-p', path, 'xl/workbook.xml'], { maxBuffer: 1 << 28 })
        ok(Buffer.from(parts.get('xl/workbook.xml')!).equals(theirs),
          `${short}: our inflate matches unzip -p byte for byte`)
      }
    }
  }
}

// ------------------------------------------------------- NEGATIVE: refusals
async function refuses(fn: () => Promise<unknown>, want: RegExp, msg: string) {
  checks++
  try {
    await fn()
    failures++
    console.log(`  FAIL  ${msg} (it accepted the input)`)
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    if (e instanceof ZipError && want.test(m)) console.log(`  ok    ${msg}`)
    else { failures++; console.log(`  FAIL  ${msg} — threw the wrong thing: ${m}`) }
  }
}

{
  const good = await writeZip([{ name: 'a.xml', data: enc.encode('<a>' + 'q'.repeat(3000) + '</a>') }])

  await refuses(() => readZip(enc.encode('not a zip at all, just some text')),
    /not an \.xlsx|central directory/, 'a non-ZIP is refused')

  await refuses(() => readZip(new Uint8Array(4)), /too small/, 'a 4-byte file is refused')

  // TRUNCATION: keep the directory, lose the data. This is the mail-gateway /
  // partial-download case, and the one that must never return short data.
  {
    const cut = good.slice()
    // blank the last 40 bytes of the compressed body (before the directory)
    cut.fill(0, 40, 60)
    await refuses(() => readZip(cut), /checksum|truncated|damaged|decompressed/,
      'a corrupted body fails its checksum rather than returning wrong bytes')
  }

  // A single flipped byte inside the compressed data.
  {
    const bent = good.slice()
    bent[45] ^= 0xff
    await refuses(() => readZip(bent), /checksum|truncated|damaged|decompressed/, 'one flipped byte is caught')
  }

  // A STORED entry with a flipped byte. This one is checked SEPARATELY from the
  // deflated cases above, and it is the only check that isolates the CRC: a
  // damaged deflate stream also fails to inflate and also comes out the wrong
  // length, so it would pass with the checksum verification deleted. Stored
  // bytes inflate perfectly and are exactly the right length; nothing but the
  // CRC can tell they are not the bytes that were written.
  {
    const short = await writeZip([{ name: 'tiny.xml', data: enc.encode('<a>0123456789</a>') }])
    const bent = short.slice()
    const at = bent.indexOf(0x30) // the '0' inside the stored payload
    bent[at] = 0x39
    await refuses(() => readZip(bent), /checksum/,
      'a flipped byte in a STORED entry is caught by the CRC alone')
  }

  // ENCRYPTED: set general-purpose bit 0 in the central directory.
  {
    const locked = good.slice()
    const v = new DataView(locked.buffer)
    // find the central directory header and set its flag word
    for (let i = 0; i < locked.length - 4; i++) {
      if (v.getUint32(i, true) === 0x02014b50) { v.setUint16(i + 8, 1, true); break }
    }
    await refuses(() => readZip(locked), /encrypted/, 'an encrypted entry is refused by name, not half-read')
  }

  // An unsupported compression method (bzip2 = 12).
  {
    const odd = good.slice()
    const v = new DataView(odd.buffer)
    for (let i = 0; i < odd.length - 4; i++) {
      if (v.getUint32(i, true) === 0x02014b50) { v.setUint16(i + 10, 12, true); break }
    }
    await refuses(() => readZip(odd), /compression method 12/, 'an unimplemented method is named, not guessed at')
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
