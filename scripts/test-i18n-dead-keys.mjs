// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Dead catalog key gate.
//
//     node scripts/test-i18n-dead-keys.mjs [--list]
//
// Every key in the slides core catalogs ships in every saved file, eight
// translations each. A key no source can produce any more is pure weight, and
// nothing else notices it: test-i18n-coverage checks that every key IS
// translated, not that anyone still asks for it. This fails when a catalog key
// is not a string literal anywhere in the code bundled into the slides shell.
//
// "Produced by source" is decided on PARSED literals (the TypeScript scanner,
// cooked values), not on a text search: a key written with … or \' in the
// source still matches, and a key that survives only in a comment does not.
//
// A key assembled at run time (concatenation, a template with a hole) can not
// be seen this way. Such keys go in DYNAMIC below, each with the place that
// builds it. Keep that list short: a literal t('…') is what lets this gate,
// and a translator's grep, find the string.

import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, dirname, relative } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const coreDir = join(root, 'slides/src/i18n')

/** Keys built at run time: key -> where. */
const DYNAMIC = {
}

let ts
try {
  ts = createRequire(join(root, 'slides/package.json'))('typescript')
} catch {
  console.error('test-i18n-dead-keys: needs slides/node_modules (cd slides && npm ci)')
  process.exit(1)
}

// What the slides shell bundles: its own source and the kernel. The catalogs
// themselves are excluded — a key is not alive because it is translated.
const ROOTS = ['slides/src', 'kernel/src']
const literals = new Set()
const scan = (file) => {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false)
  const visit = (n) => {
    if (ts.isStringLiteralLike(n)) literals.add(n.text)
    // `{ Width: … }` then t(key) over Object.keys(): an unquoted property name
    // is a key source too
    else if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && ts.isIdentifier(n.name)) literals.add(n.name.text)
    ts.forEachChild(n, visit)
  }
  visit(sf)
}
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || p === coreDir) continue
      walk(p)
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(e.name)) scan(p)
  }
}
for (const r of ROOTS) walk(join(root, r))

// The shipped table is keyed by a hash of the English string, so the key
// universe is the authored catalogs; the table must agree with them key for key.
const { PACKED, PACKED_LOCALES, packedKey } = await import(pathToFileURL(join(coreDir, 'packed.ts')).href)
const KEYS = []
{
  const seen = new Set()
  for (const l of PACKED_LOCALES) {
    const mod = await import(pathToFileURL(join(coreDir, `${l}.ts`)).href)
    for (const k of Object.keys(Object.values(mod)[0])) if (!seen.has(k)) { seen.add(k); KEYS.push(k) }
  }
}
if (!KEYS.length || Object.keys(PACKED).length !== KEYS.length || KEYS.some((k) => !PACKED[packedKey(k)])) {
  console.error('test-i18n-dead-keys: packed.ts does not match the catalogs — has build-i18n.mjs run?')
  process.exit(1)
}

const dead = KEYS.filter((k) => !literals.has(k) && !Object.prototype.hasOwnProperty.call(DYNAMIC, k))
const staleAllow = Object.keys(DYNAMIC).filter((k) => !KEYS.includes(k) || literals.has(k))

if (process.argv.includes('--list')) {
  console.log(JSON.stringify(dead, null, 1))
  process.exit(dead.length ? 1 : 0)
}

let failed = false
if (dead.length) {
  failed = true
  console.error(`\n${dead.length} catalog key(s) no bundled source produces (${ROOTS.join(', ')}):`)
  for (const k of dead) console.error('  ' + JSON.stringify(k))
  console.error(
    '\nDelete them from slides/src/i18n/*.ts and packs/*.ts, then run node scripts/build-i18n.mjs.\n' +
    'If a key is built at run time, add it to DYNAMIC in ' + relative(root, fileURLToPath(import.meta.url)) + ' with the place that builds it.',
  )
}
if (staleAllow.length) {
  failed = true
  console.error(`\n${staleAllow.length} DYNAMIC entr${staleAllow.length === 1 ? 'y is' : 'ies are'} stale (no longer a catalog key, or now a plain literal):`)
  for (const k of staleAllow) console.error('  ' + JSON.stringify(k))
}
if (failed) process.exit(1)
console.log(`i18n dead keys: OK (${KEYS.length} catalog keys, ${Object.keys(DYNAMIC).length} built at run time)`)
