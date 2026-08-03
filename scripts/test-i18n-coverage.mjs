// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Language coverage gate.
//
//     node scripts/test-i18n-coverage.mjs [--packs-min N] [--quiet]
//
// TWO different rules, because the two kinds of catalog have different costs
// when they are behind:
//
//   CORE catalogs (slides/src/i18n/*.ts) are COMPILED INTO EVERY SAVED FILE.
//   A missing key there ships as English inside an otherwise translated
//   interface, in every deck anyone saves, and cannot be corrected without
//   cutting a new release. So core must be 100% — this FAILS the build.
//
//   PACKS (slides/src/i18n/packs/*.ts) are downloaded on demand and can be
//   re-published WITHOUT an app release (docs/i18n-packs.md). A release that
//   adds UI strings necessarily leaves every pack behind for a while, so a
//   hard 100% gate here would block every feature release. Packs get a FLOOR
//   (default 90%) plus a printed report, so drift is visible and a collapse
//   is caught.
//
// Reads the generated packed.ts for the key universe — the same source
// build-i18n.mjs uses, so this gate and that generator can never disagree.
// Do NOT regex the catalogs: build-i18n.mjs learned that the hard way
// ("a regex over the source silently missed 54 of 650 entries").

import { readdirSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const coreDir = join(root, 'slides/src/i18n')
const packDir = join(coreDir, 'packs')

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const PACKS_MIN = Number(arg('packs-min', '90'))
const quiet = process.argv.includes('--quiet')

// --- the key universe -------------------------------------------------------
const packedSrc = readFileSync(join(coreDir, 'packed.ts'), 'utf8')
const KEYS = [...packedSrc.matchAll(/^ {2}("(?:[^"\\]|\\.)*"):/gm)].map((m) => JSON.parse(m[1]))
if (!KEYS.length) {
  console.error('test-i18n-coverage: no keys found in packed.ts — has build-i18n.mjs run?')
  process.exit(1)
}
const LOCALES = JSON.parse(packedSrc.match(/PACKED_LOCALES[^=]*=\s*(\[[^\]]*\])/)[1].replace(/'/g, '"'))

const pct = (n) => ((n / KEYS.length) * 100).toFixed(1)
const bar = (n) => '█'.repeat(Math.round((n / KEYS.length) * 20)).padEnd(20, '·')

let failed = false

// --- core: must be complete -------------------------------------------------
// Read the packed table rather than the catalogs: a 0 (or a short row) is
// exactly what the runtime treats as "no translation, fall back to English",
// so this measures what a reader actually gets.
const rows = [...packedSrc.matchAll(/^ {2}("(?:[^"\\]|\\.)*"):\s*(\[[\s\S]*?\]),$/gm)]
const coreMissing = Object.fromEntries(LOCALES.map((l) => [l, []]))
for (const [, k, arr] of rows) {
  let vals
  try { vals = JSON.parse(arr) } catch { continue }
  LOCALES.forEach((l, i) => { if (vals.length <= i || vals[i] === 0) coreMissing[l].push(JSON.parse(k)) })
}

if (!quiet) console.log(`\ncore catalogs — shipped in every saved file (${KEYS.length} strings)`)
for (const l of LOCALES) {
  const miss = coreMissing[l]
  const have = KEYS.length - miss.length
  if (!quiet) console.log(`  ${l.padEnd(9)} ${bar(have)} ${String(have).padStart(4)}/${KEYS.length}  ${pct(have)}%`)
  if (miss.length) {
    failed = true
    console.error(`\n  FAIL ${l} is missing ${miss.length} string(s) — core catalogs must be complete:`)
    for (const k of miss.slice(0, 12)) console.error(`    ${JSON.stringify(k)}`)
    if (miss.length > 12) console.error(`    …and ${miss.length - 12} more`)
    console.error(`  Add them to slides/src/i18n/${l}.ts, then: node scripts/build-i18n.mjs\n`)
  }
}

// --- packs: floor + report --------------------------------------------------
const packs = []
for (const f of readdirSync(packDir).filter((f) => f.endsWith('.ts'))) {
  const mod = await import(pathToFileURL(join(packDir, f)).href)
  // Pack modules export BOTH `label` and `strings`. Taking Object.values()[0]
  // grabs the label and silently counts its characters.
  if (!mod.strings || typeof mod.strings !== 'object') {
    console.error(`test-i18n-coverage: ${f} does not export a \`strings\` object`)
    process.exit(1)
  }
  const missing = KEYS.filter((k) => !Object.prototype.hasOwnProperty.call(mod.strings, k))
  packs.push({ lang: f.replace(/\.ts$/, ''), have: KEYS.length - missing.length, missing })
}
packs.sort((a, b) => a.have - b.have || a.lang.localeCompare(b.lang))

if (!quiet) console.log(`\nlanguage packs — downloaded on demand, re-publishable without a release`)
for (const p of packs) {
  const under = Number(pct(p.have)) < PACKS_MIN
  if (!quiet) console.log(`  ${p.lang.padEnd(9)} ${bar(p.have)} ${String(p.have).padStart(4)}/${KEYS.length}  ${pct(p.have)}%${under ? '  ← below floor' : ''}`)
  if (under) {
    failed = true
    console.error(`\n  FAIL pack ${p.lang} at ${pct(p.have)}% is below the ${PACKS_MIN}% floor (missing ${p.missing.length}).`)
    for (const k of p.missing.slice(0, 8)) console.error(`    ${JSON.stringify(k)}`)
    if (p.missing.length > 8) console.error(`    …and ${p.missing.length - 8} more`)
    console.error(`  Add them to slides/src/i18n/packs/${p.lang}.ts. Packs can also be`)
    console.error(`  corrected and re-published without cutting a release — see docs/i18n-packs.md\n`)
  }
}

const worst = packs.length ? packs[0] : null
if (!quiet) {
  console.log(`\n  core: ${LOCALES.length} locales, all complete required`)
  console.log(`  packs: ${packs.length}, floor ${PACKS_MIN}%${worst ? `, lowest ${worst.lang} at ${pct(worst.have)}%` : ''}`)
}

if (failed) { console.error('language coverage: FAILED\n'); process.exit(1) }
console.log('\nlanguage coverage: OK\n')
