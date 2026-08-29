#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type localization rig.
//
//   node scripts/test-type-i18n.ts
//
// WHAT ROTS. English-string-as-key catalogs decay in four silent ways:
//
//   · a source string changes by a full stop or an ellipsis and the catalogs
//     keep translating the OLD key — the lookup misses and the reader gets
//     English, forever, with nothing failing;
//   · a translator's file drifts from the others — one language quietly loses
//     a key nobody re-added;
//   · a translation drops a `{placeholder}` — the reader gets a sentence with
//     a variable missing, or the interpolation throws;
//   · a key is removed from the source but survives in a catalog — dead
//     weight that looks like coverage but corresponds to nothing.
//
// The key universe is swept from type/src/**, not read off any one catalog —
// same char-by-char walk as scripts/build-type-i18n.mjs (a regex over just the
// opening quote silently truncates the concatenated strings in about.ts).

import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'type/src')
const i18nDir = join(srcDir, 'i18n')
const LOCALES = ['ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'de', 'it', 'pt']

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
}

// --- sweep every t('…') in the source, concatenated fragments included ------
function collectFromFile(file: string, keys: Set<string>) {
  const src = readFileSync(file, 'utf8')
  const callRe = /\bt\(/g
  let m: RegExpExecArray | null
  while ((m = callRe.exec(src))) {
    let i = m.index + 2
    const skipWs = () => { while (i < src.length && /\s/.test(src[i])) i++ }
    skipWs()
    if (src[i] !== "'" && src[i] !== '"' && src[i] !== '`') continue
    let full = ''
    let ok2 = true
    let hadTemplate = false
    for (;;) {
      skipWs()
      const q = src[i]
      if (q === "'" || q === '"' || q === '`') {
        let j = i + 1
        let raw = ''
        while (j < src.length) {
          if (src[j] === '\\') { raw += src[j] + src[j + 1]; j += 2; continue }
          if (src[j] === q) { j++; break }
          raw += src[j]; j++
        }
        if (q === '`') hadTemplate = true
        else if (q === "'") full += raw.replace(/\\'/g, "'").replace(/\\\\/g, '\\')
        else { try { full += JSON.parse('"' + raw + '"') } catch { full += raw } }
        i = j
      } else { ok2 = false; break }
      skipWs()
      if (src[i] === '+') { i++; continue }
      break
    }
    if (!ok2 || hadTemplate) continue
    keys.add(full)
  }
}

function sweepKeys(): Set<string> {
  const keys = new Set<string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { if (entry.name !== 'i18n') walk(full); continue }
      if (!entry.name.endsWith('.ts')) continue
      collectFromFile(full, keys)
    }
  }
  walk(srcDir)
  return keys
}

/** Evaluate a generated catalog module (a plain object literal) without ts-node. */
function readCatalog(code: string): Record<string, string> {
  const file = join(i18nDir, `${code}.ts`)
  const src = readFileSync(file, 'utf8')
  const start = src.indexOf('{', src.indexOf('export const '))
  const end = src.lastIndexOf('}')
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${src.slice(start, end + 1)})`)()
}

console.log('bento/type i18n coverage\n')

const sourceKeys = sweepKeys()
ok(sourceKeys.size > 0, `source sweep found ${sourceKeys.size} t() keys`)

const catalogs = Object.fromEntries(LOCALES.map((l) => [l, readCatalog(l)]))
const placeholderRe = /\{[a-zA-Z]+\}/g

// --- 1. every catalog has the same key set (no drift between locales) -------
for (const loc of LOCALES) {
  const catKeys = new Set(Object.keys(catalogs[loc]))
  for (const other of LOCALES) {
    if (other === loc) continue
    const otherKeys = new Set(Object.keys(catalogs[other]))
    const missingHere = [...otherKeys].filter((k) => !catKeys.has(k))
    ok(missingHere.length === 0,
      `${loc}.ts has every key ${other}.ts has` + (missingHere.length ? ` (missing ${missingHere.length}, e.g. ${JSON.stringify(missingHere[0])})` : ''))
  }
}

// --- 2. no key is missing from a catalog that English (the source) has -----
for (const loc of LOCALES) {
  const catKeys = new Set(Object.keys(catalogs[loc]))
  const missing = [...sourceKeys].filter((k) => !catKeys.has(k))
  ok(missing.length === 0,
    `${loc}.ts covers every source string` + (missing.length ? ` (missing ${missing.length}, e.g. ${JSON.stringify(missing[0])})` : ''))
}

// --- 3. every {placeholder} in an English string survives translation ------
let placeholderFailures = 0
for (const key of sourceKeys) {
  const wanted = new Set(key.match(placeholderRe) ?? [])
  if (wanted.size === 0) continue
  for (const loc of LOCALES) {
    const val = catalogs[loc][key]
    if (val === undefined) continue // already reported by check 2
    const got = new Set(val.match(placeholderRe) ?? [])
    const lost = [...wanted].filter((p) => !got.has(p))
    const added = [...got].filter((p) => !wanted.has(p))
    if (lost.length || added.length) {
      placeholderFailures++
      console.log(`  FAIL  ${loc}: placeholder mismatch in ${JSON.stringify(key)}` +
        (lost.length ? ` — missing ${lost.join(', ')}` : '') +
        (added.length ? ` — unexpected ${added.join(', ')}` : ''))
    }
  }
}
checks++
if (placeholderFailures) failures++
else console.log(`  ok    every {placeholder} survives translation, all locales`)

// --- 4. no catalog carries a key that no longer exists in the source -------
for (const loc of LOCALES) {
  const stale = Object.keys(catalogs[loc]).filter((k) => !sourceKeys.has(k))
  ok(stale.length === 0,
    `${loc}.ts has no stale keys` + (stale.length ? ` (${stale.length} stale, e.g. ${JSON.stringify(stale[0])})` : ''))
}

// --- 5. the packed table (what actually ships) matches the catalogs --------
// A stale packed.ts would pass every check above and still ship English —
// build-type-i18n.mjs is the only writer of packed.ts, so this just proves
// nobody forgot to re-run it after editing a catalog.
{
  const packedSrc = readFileSync(join(i18nDir, 'packed.ts'), 'utf8')
  const packedLocales = JSON.parse(packedSrc.match(/PACKED_LOCALES\s*=\s*(\[[^\]]*\])/)![1].replace(/'/g, '"'))
  ok(JSON.stringify(packedLocales) === JSON.stringify(LOCALES), 'packed.ts locale columns match LOCALES')
  const rows = [...packedSrc.matchAll(/^ {2}("(?:[^"\\]|\\.)*"):\s*(\[[\s\S]*?\]),$/gm)]
  const packedKeys = new Set<string>()
  let packedMismatch = 0
  for (const [, kRaw, arrRaw] of rows) {
    const k = JSON.parse(kRaw)
    packedKeys.add(k)
    let vals: (string | number)[]
    try { vals = JSON.parse(arrRaw) } catch { continue }
    LOCALES.forEach((loc, i) => {
      const expected = catalogs[loc][k]
      const got = vals.length > i ? vals[i] : 0
      const gotStr = got === 0 ? undefined : got
      if (gotStr !== expected) packedMismatch++
    })
  }
  ok(packedMismatch === 0, `packed.ts translations match the per-locale catalogs` + (packedMismatch ? ` (${packedMismatch} mismatched cell(s) — run: node scripts/build-type-i18n.mjs)` : ''))
  const missingFromPacked = [...sourceKeys].filter((k) => !packedKeys.has(k))
  const staleInPacked = [...packedKeys].filter((k) => !sourceKeys.has(k))
  ok(missingFromPacked.length === 0 && staleInPacked.length === 0,
    'packed.ts key set matches the source sweep exactly' +
    (missingFromPacked.length ? ` (packed.ts missing ${missingFromPacked.length})` : '') +
    (staleInPacked.length ? ` (packed.ts has ${staleInPacked.length} stale)` : ''))
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
