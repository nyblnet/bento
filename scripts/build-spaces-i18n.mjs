#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Generates spaces/src/i18n/packed.ts from the per-locale catalogs.
//
//   node scripts/build-spaces-i18n.mjs           write the packed table
//   node scripts/build-spaces-i18n.mjs --check   fail if it is out of date (CI)
//
// WHY PACK. English-string-as-key means the source sentence is the key in every
// locale, so N plain catalogs store the same English text N times — and deflate
// cannot dedupe it, because the catalogs span far more than its 32KB window. At
// 116 strings across 8 locales that is tens of KB of duplicated English on a
// shell measured in tens of KB. The packed form stores each key ONCE with an
// array of translations by column, and `0` for "no translation, use English".
//
// The key universe is swept from the SOURCE, not from the catalogs, so a string
// added to the UI and forgotten in the catalogs shows up as missing rather than
// silently shipping English.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'spaces/src')
const i18nDir = join(srcDir, 'i18n')
const OUT = join(i18nDir, 'packed.ts')

/** Locale columns, in order. English is the key, so it is not a column. */
export const LOCALES = ['ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'de', 'it', 'pt']

/**
 * Every `t('…')` in the app source.
 *
 * Deliberately a scan of the SOURCE. build-i18n.mjs in slides carries a warning
 * that a regex once silently missed 54 of 650 entries, so this one anchors on
 * the call, handles both quote styles, and is checked by counting: if the sweep
 * ever returns fewer keys than the catalogs contain, that is reported too.
 */
function sweepKeys() {
  const keys = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { if (entry.name !== 'i18n') walk(full); continue }
      if (!entry.name.endsWith('.ts')) continue
      const src = readFileSync(full, 'utf8')
      const re = /\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g
      let m
      while ((m = re.exec(src))) keys.add(m[2].replace(/\\'/g, "'").replace(/\\"/g, '"'))
    }
  }
  walk(srcDir)

  // …AND THE STRINGS THAT REACH t() THROUGH A VARIABLE.
  //
  // Block specs carry `label` and `hint` in a data table (blocks.ts), and the
  // editor renders them with `t(item.label)` — so the sweep above, which
  // anchors on a literal, never saw them. The consequence was silent and
  // total: the `/` menu, the Insert dropdown and the block results in ⌘K were
  // English in all eight languages, for every block type, since the day the
  // table was written. Adding the strings to the catalogs did not fix it
  // either — the packer builds PACKED from THIS list, so a catalog entry for a
  // key the sweep misses is dropped on the way into the shell. The catalogs
  // read 504/504 complete while the shell shipped none of them.
  //
  // These cannot be wrapped at the definition instead: CLAUDE.md's rule is that
  // t() must never be called in a module-level const, because the catalog is
  // frozen at import and the locale is chosen later.
  //
  // SYNTAX IS NOT LANGUAGE. A hint that is a markdown trigger — `-`, `1.`,
  // `[]`, `>`, `---`, a code fence — is what you literally type, identical in
  // every locale, and demanding eight translations of `-` would be noise in
  // every catalog and a lie in each one.
  const specSrc = readFileSync(join(srcDir, 'blocks.ts'), 'utf8')
  const isSyntax = (v) => /^[#`\-\[\]>0-9.\s]+$/.test(v)
  for (const m of specSrc.matchAll(/\b(?:label|hint):\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
    const v = m[2].replace(/\\'/g, "'").replace(/\\"/g, '"')
    if (v.length > 1 && !isSyntax(v)) keys.add(v)
  }

  return [...keys].sort()
}

/** Read one locale catalog by evaluating its object literal. */
function readCatalog(code) {
  const file = join(i18nDir, `${code}.ts`)
  if (!existsSync(file)) return {}
  const src = readFileSync(file, 'utf8')
  const start = src.indexOf('{', src.indexOf(`export const `))
  const end = src.lastIndexOf('}')
  if (start < 0 || end < 0) return {}
  // the catalogs are generated, so this is a literal object of string pairs
  return Function(`"use strict"; return (${src.slice(start, end + 1)})`)()
}

const keys = sweepKeys()
const catalogs = Object.fromEntries(LOCALES.map((c) => [c, readCatalog(c)]))

const rows = []
const missing = Object.fromEntries(LOCALES.map((c) => [c, 0]))
for (const key of keys) {
  const row = LOCALES.map((c) => {
    const v = catalogs[c][key]
    if (typeof v === 'string' && v.length) return v
    missing[c]++
    return 0
  })
  rows.push([key, row])
}

const body = `// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// GENERATED by scripts/build-spaces-i18n.mjs — do not edit. Run it after
// changing a catalog or adding a t() string; CI fails if this is out of date.
//
// One row per English key: the key is stored ONCE and the translations follow
// by column. \`0\` means "no translation in that locale" and falls back to the
// English key, which is also the source text — so a missing entry degrades to
// a readable string rather than a blank.

export const PACKED_LOCALES = ${JSON.stringify(LOCALES)} as const

export const PACKED: Record<string, ReadonlyArray<string | 0>> = {
${rows.map(([k, r]) => `  ${JSON.stringify(k)}: ${JSON.stringify(r)},`).join('\n')}
}
`

const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null
const report = LOCALES.map((c) => {
  const done = keys.length - missing[c]
  const pct = keys.length ? Math.round((done / keys.length) * 1000) / 10 : 100
  return `  ${c.padEnd(8)} ${String(done).padStart(3)}/${keys.length}  ${pct}%`
}).join('\n')

if (process.argv.includes('--check')) {
  if (current !== body) {
    console.error('spaces packed.ts is out of date.\nRun: node scripts/build-spaces-i18n.mjs')
    process.exit(1)
  }
  // Core catalogs ship INSIDE every saved file and cannot be corrected without
  // a release, so an incomplete one is a build failure, not a warning.
  const short = LOCALES.filter((c) => missing[c] > 0)
  if (short.length) {
    console.error(`incomplete core catalogs: ${short.map((c) => `${c} (${missing[c]} missing)`).join(', ')}`)
    console.error(report)
    process.exit(1)
  }
  console.log(`spaces i18n up to date (${keys.length} strings × ${LOCALES.length} locales, all complete)`)
} else {
  mkdirSync(i18nDir, { recursive: true })
  writeFileSync(OUT, body)
  console.log(`packed ${keys.length} strings × ${LOCALES.length} locales -> ${OUT}`)
  console.log(report)
}
