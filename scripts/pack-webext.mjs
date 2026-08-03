#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Builds the store-uploadable package for tray/webext.
//
//   node scripts/pack-webext.mjs            → dist/bento-tray-<version>.zip
//   node scripts/pack-webext.mjs --check    → validate only, write nothing (CI)
//
// WHY THIS EXISTS RATHER THAN `zip -r`.
//
// **It refuses to ship the wrong files.** `tray/webext/` contains things that
// must NOT reach a listing: `probe/` is four capability probes that open local
// files and talk across origins — harmless to us, alarming to a reviewer, and
// nothing to do with the product — and `README.md` is 200 lines of internal
// reasoning. A recursive zip takes the lot. Here the payload is an explicit
// allow-list and anything unexpected in the tree is an error, not a silent
// inclusion.
//
// **It checks the manifest against the tree.** Every file the manifest names —
// service worker, both content scripts, options page, popup, every icon — must
// exist, and every icon must be the size it claims. A listing rejected for a
// missing 128px icon costs a review round trip measured in days.
//
// **It is byte-reproducible.** Entries are sorted, timestamps fixed, no
// filesystem metadata. The same tree always produces the same zip, so "is the
// uploaded package the reviewed package?" is answerable by hashing it. This
// repo already holds that line for the document shell (docs/RELEASING.md:
// signed locally, the signed bytes are the served bytes); an extension going to
// a store cannot be signed by us, so reproducibility is what is left.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync, crc32 } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'tray/webext')
const OUT = join(root, 'dist')

/** What ships. Anything in the tree and not matched here is an error. */
const INCLUDE = [/^manifest\.json$/, /^icons\/[^/]+\.png$/, /^src\/[^/]+\.(js|html)$/]
/** Present on purpose, deliberately NOT shipped. */
const EXCLUDE = [/^probe\//, /^README\.md$/, /^STORE\.md$/]

const problems = []
const fail = (m) => problems.push(m)

// ---- walk the tree ---------------------------------------------------------
function walk(dir, base = '') {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name)
    const rel = base ? `${base}/${name}` : name
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel))
    else out.push(rel)
  }
  return out
}

const all = walk(SRC)
const payload = []
for (const rel of all) {
  if (EXCLUDE.some((r) => r.test(rel))) continue
  if (INCLUDE.some((r) => r.test(rel))) { payload.push(rel); continue }
  fail(`unexpected file in tray/webext — add it to INCLUDE or EXCLUDE deliberately: ${rel}`)
}

// ---- the manifest must match the tree --------------------------------------
let manifest = null
try {
  manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'))
} catch (e) {
  fail(`manifest.json does not parse: ${e.message}`)
}

if (manifest) {
  if (manifest.manifest_version !== 3) fail('manifest_version must be 3')
  for (const k of ['name', 'version', 'description']) {
    if (!manifest[k]) fail(`manifest is missing "${k}" — the store requires it`)
  }
  if (manifest.version === '0.0.1') fail('manifest version is still the scaffold placeholder 0.0.1')
  if ((manifest.description ?? '').length > 132) {
    fail(`description is ${manifest.description.length} chars; the store truncates at 132`)
  }

  const named = new Set()
  const claim = (p) => { if (p) named.add(p.replace(/^\//, '')) }
  claim(manifest.background?.service_worker)
  claim(manifest.options_page)
  claim(manifest.action?.default_popup)
  for (const cs of manifest.content_scripts ?? []) (cs.js ?? []).forEach(claim)
  for (const size of ['16', '32', '48', '128']) {
    const p = manifest.icons?.[size]
    if (!p) fail(`manifest.icons is missing the ${size}px entry — the store requires 128 and uses the rest`)
    else claim(p)
  }
  for (const p of named) {
    if (!payload.includes(p)) fail(`manifest names "${p}" but it is not in the package`)
  }

  // Icons must actually BE the size they claim. A store rejection for this is
  // days of review latency for a one-line mistake.
  for (const [size, p] of Object.entries(manifest.icons ?? {})) {
    try {
      const b = readFileSync(join(SRC, p))
      // PNG: width/height are big-endian u32 at byte 16 and 20 of the IHDR.
      const w = b.readUInt32BE(16)
      const h = b.readUInt32BE(20)
      if (w !== Number(size) || h !== Number(size)) {
        fail(`${p} is ${w}x${h} but is declared as the ${size}px icon`)
      }
    } catch (e) {
      fail(`cannot read icon ${p}: ${e.message}`)
    }
  }

  // A permission that is declared and unused is a question a reviewer asks and
  // the listing cannot answer.
  const srcText = payload.filter((p) => p.endsWith('.js'))
    .map((p) => readFileSync(join(SRC, p), 'utf8')).join('\n')
  for (const perm of manifest.permissions ?? []) {
    if (!new RegExp(`chrome\\.${perm}\\b`).test(srcText) && perm !== 'storage') {
      fail(`permission "${perm}" is declared but never used in the shipped code`)
    }
  }
}

// ---- a minimal, deterministic zip ------------------------------------------
// Written by hand rather than shelled out to `zip` so the output is fixed by
// construction: sorted entries, one timestamp, no filesystem metadata.
const DOS_TIME = 0x0000 // 00:00:00
const DOS_DATE = 0x2821 // 2020-01-01 — a constant, so the bytes never drift

function zip(files) {
  const locals = []
  const central = []
  let offset = 0
  for (const { name, data } of files) {
    const body = deflateRawSync(data, { level: 9 })
    const nameBuf = Buffer.from(name, 'utf8')
    const sum = crc32(data)

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6)
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12)
    lh.writeUInt32LE(sum, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28)
    locals.push(lh, nameBuf, body)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10); cd.writeUInt16LE(DOS_TIME, 12)
    cd.writeUInt16LE(DOS_DATE, 14); cd.writeUInt32LE(sum, 16)
    cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)

    offset += lh.length + nameBuf.length + body.length
  }
  const cdBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, cdBuf, end])
}

// ---- report ----------------------------------------------------------------
console.log(`tray/webext → ${payload.length} files`)
for (const p of payload) console.log(`  ${p}`)

if (problems.length) {
  console.error(`\n${problems.length} problem${problems.length > 1 ? 's' : ''}:`)
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}

if (process.argv.includes('--check')) {
  console.log('\npackage is valid (nothing written)')
  process.exit(0)
}

const bytes = zip(payload.map((name) => ({ name, data: readFileSync(join(SRC, name)) })))
mkdirSync(OUT, { recursive: true })
const out = join(OUT, `bento-tray-${manifest.version}.zip`)
writeFileSync(out, bytes)
console.log(`\nwrote ${relative(root, out)} — ${(bytes.length / 1024).toFixed(1)}KB`)
console.log('deterministic: the same tree always produces these bytes')
