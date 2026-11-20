#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Pack the per-locale catalogs into ONE key-once table.
//
//   node scripts/build-i18n.mjs [--check]
//
// WHY. The catalogs are gettext-style: the English source string IS the key.
// That is excellent for authoring — the source stays readable and a missing
// translation falls back for free — but it means every English sentence is
// stored SEVEN times, once per locale. Measured on this repo: 135KB of
// duplicated keys against 160KB of actual translations, i.e. 46% of the
// catalog payload was the same English text over and over.
//
// Deflate cannot rescue that: its window is 32KB and the catalogs span 320KB,
// so by the time zh-Hant repeats a key, de's copy is long out of range.
//
// So the SHIPPED shape is one table — key once, translations positional:
//
//     "Delete slide": ["スライドを削除", "删除幻灯片", …]
//
// The per-locale files stay the source of truth. They are what a translator
// reviews and what a contributor submits (see issue #17, Korean); nobody
// should have to edit a positional array. This script is the bridge, and
// --check keeps the generated file honest in CI.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dir = join(root, 'slides/src/i18n')
const outPath = join(dir, 'packed.ts')
/** Pack languages: authored exactly like a core catalog, but never bundled —
 *  nothing imports this directory, so it stays out of the module graph. */
const packDir = join(dir, 'packs')

// Column order. Adding a locale = add its file and append it HERE (appending
// keeps existing columns stable, so a stale packed.ts can never silently
// shift every translation by one).
const LOCALES = ['ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'de', 'it', 'pt']

const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'packed.ts')
const missing = LOCALES.filter((l) => !files.includes(`${l}.ts`))
if (missing.length) {
  console.error(`missing catalog file(s): ${missing.join(', ')}`)
  process.exit(1)
}
const extra = files.filter((f) => !LOCALES.includes(f.replace(/\.ts$/, '')))
if (extra.length) {
  console.error(`catalog file(s) not listed in LOCALES: ${extra.join(', ')} — add them to scripts/build-i18n.mjs`)
  process.exit(1)
}

// Evaluate the modules rather than parsing them: a regex over the source
// silently missed 54 of 650 entries when this was first attempted.
const catalogs = []
for (const loc of LOCALES) {
  const mod = await import(pathToFileURL(join(dir, `${loc}.ts`)).href)
  const cat = Object.values(mod)[0]
  if (!cat || typeof cat !== 'object') {
    console.error(`${loc}.ts does not export a catalog object`)
    process.exit(1)
  }
  catalogs.push(cat)
}

// Union of keys, first-seen order — stable output across runs so the
// generated file only churns when the catalogs actually change.
const keys = []
const seen = new Set()
for (const cat of catalogs) {
  for (const k of Object.keys(cat)) {
    if (!seen.has(k)) { seen.add(k); keys.push(k) }
  }
}

// --- column-major emission ---------------------------------------------------
// The table SHIPS as a handful of long strings, one per column group, not as
// one object literal row per key. Measured on the built shell (the only number
// that counts — the payload is deflated): row-major `"key":["ja","zh",…]`
// interleaves eight languages in three scripts, so deflate's Huffman tables
// and its 32KB window are shared between Japanese, Chinese and Latin text and
// serve none of them well. Column-major puts each language in one run.
//
// THE LAYOUT FOLLOWS THE CODEC, and slides is packed with LZMA (DECISIONS
// 2026-11-20). Every language is its own run and the keys are the English
// strings themselves. Under deflate two other choices won and were shipped
// for a day: interleaving the pairs that share text row by row (es/pt,
// zh-Hans/zh-Hant: -3.3 KB) and a 30-bit hash in place of each English key
// (-12 KB). Both lose under LZMA, whose window is the whole payload: it finds
// a sibling string or a key's `t('…')` call site at any distance, so the
// interleaving only breaks each language's run (+3.1 KB) and a hash is five
// characters it cannot predict (+2.2 KB). Measured on the built shell with
// this layout against that one: see the DECISIONS entry. The run order barely
// matters (160 B across the four tried). If slides ever returns to deflate,
// this table goes back with it: this layout is about 15 KB worse there.
const GROUPS = [['en'], ['es'], ['pt'], ['it'], ['fr'], ['de'], ['zh-Hans'], ['zh-Hant'], ['ja']]
{
  const flat = GROUPS.flat()
  const want = ['en', ...LOCALES]
  if (flat.length !== want.length || want.some((l) => !flat.includes(l))) {
    console.error('GROUPS must list en and every locale in LOCALES exactly once')
    process.exit(1)
  }
}
let holes = 0
const cellOf = (k, loc) => {
  if (loc === 'en') return k
  const c = catalogs[LOCALES.indexOf(loc)]
  if (!Object.prototype.hasOwnProperty.call(c, k) || c[k] === '') { holes++; return '' }
  return c[k]
}
// Two separator characters no key or translation uses. Chosen per build and
// written into the file, so a future string containing one can never split a
// row silently — the generator moves to the next candidate, or fails.
const everything = keys.join('') + catalogs.map((c) => Object.values(c).join('')).join('')
const free = ['|', '^', '~', '¦', '§', '\u0001', '\u0002'].filter((c) => !everything.includes(c))
if (free.length < 2) {
  console.error('no free separator characters left for the packed table — extend the candidate list')
  process.exit(1)
}
const [CELL, ROW] = free
const groupSrc = GROUPS.map((g) => {
  const body = keys.map((k) => g.map((loc) => cellOf(k, loc)).join(CELL)).join(ROW)
  // column index into a decoded row: 0 = the key, n+1 = LOCALES[n]
  const cols = g.map((loc) => (loc === 'en' ? 0 : LOCALES.indexOf(loc) + 1))
  return `  [${JSON.stringify(cols)}, ${JSON.stringify(body)}],`
})

const out = `// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// GENERATED by scripts/build-i18n.mjs — DO NOT EDIT.
// Edit the per-locale catalogs in this directory and re-run:
//
//     node scripts/build-i18n.mjs
//
// Key-once, COLUMN-MAJOR packing: each group below is one long string holding
// one column (or a few interleaved ones) for every key, rows joined by ROW and
// cells by CELL. It is unpacked once, at import, into the same key -> row
// table the runtime has always read. An empty cell means "no translation in
// that locale" and t() falls back to the English key.

/** Column order for every row in PACKED. */
export const PACKED_LOCALES = ${JSON.stringify(LOCALES)} as const

const CELL = ${JSON.stringify(CELL)}
const ROW = ${JSON.stringify(ROW)}
/** [columns held (0 = the English key, n + 1 = PACKED_LOCALES[n]), packed text] */
const GROUPS: ReadonlyArray<readonly [readonly number[], string]> = [
${groupSrc.join('\n')}
]

function unpack(): Record<string, ReadonlyArray<string | 0>> {
  const rows: Array<Array<string | 0>> = []
  for (const [cols, text] of GROUPS) {
    text.split(ROW).forEach((line, n) => {
      const cells = line.split(CELL)
      const row = (rows[n] ??= [])
      cols.forEach((col, j) => { row[col] = cells[j] || 0 })
    })
  }
  const table: Record<string, ReadonlyArray<string | 0>> = {}
  for (const row of rows) table[row[0] as string] = row.slice(1)
  return table
}

/** English source string -> translations, positional by PACKED_LOCALES. */
export const PACKED: Record<string, ReadonlyArray<string | 0>> = unpack()
`

// --- pack emission ----------------------------------------------------------
// A pack is one language for one app at one app version. Per-language maps,
// not the bundled positional shape: a pack is authored and reviewed as a
// single language, and positional arrays would couple every pack to a column
// order it can't see. See docs/i18n-packs.md.
const packsIdx = process.argv.indexOf('--packs')
if (packsIdx >= 0) {
  const outDir = process.argv[packsIdx + 1] || join(root, 'slides/dist-packs')
  if (!existsSync(packDir)) {
    console.log(`no pack catalogs in ${packDir} — nothing to emit`)
    process.exit(0)
  }
  const version = JSON.parse(readFileSync(join(root, 'slides/package.json'), 'utf8')).version
  mkdirSync(outDir, { recursive: true })
  const packFiles = readdirSync(packDir).filter((f) => f.endsWith('.ts'))
  let n = 0
  for (const f of packFiles) {
    const lang = f.replace(/\.ts$/, '')
    if (LOCALES.includes(lang)) {
      console.error(`${lang} is a BUNDLED language — remove it from packs/ or from LOCALES, not both`)
      process.exit(1)
    }
    const mod = await import(pathToFileURL(join(packDir, f)).href)
    const strings = mod.strings ?? Object.values(mod).find((v) => v && typeof v === 'object')
    const label = mod.label
    if (!strings || !label) {
      console.error(`${f} must export both \`strings\` and \`label\``)
      process.exit(1)
    }
    const pack = { app: 'slides', version, lang, label, strings }
    const name = `bento-slides-${version}-${lang}.pack.json`
    writeFileSync(join(outDir, name), JSON.stringify(pack))
    console.log(`  ${name}  ${Object.keys(strings).length} strings`)
    n++
  }
  console.log(`emitted ${n} pack(s) -> ${outDir}`)
  process.exit(0)
}

if (process.argv.includes('--check')) {
  let current = ''
  try { current = readFileSync(outPath, 'utf8') } catch { /* absent */ }
  if (current !== out) {
    console.error('slides/src/i18n/packed.ts is STALE — run: node scripts/build-i18n.mjs')
    process.exit(1)
  }
  console.log(`i18n packed table is current (${keys.length} strings × ${LOCALES.length} locales)`)
} else {
  writeFileSync(outPath, out)
  console.log(`packed ${keys.length} strings × ${LOCALES.length} locales -> slides/src/i18n/packed.ts`)
  if (holes) console.log(`  ${holes} untranslated slot(s) fall back to English`)
}
