// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Untranslated literal gate.
//
//     node scripts/test-slides-i18n-literals.mjs [--list]
//
// The other two i18n gates look from the catalogs outwards:
// test-i18n-coverage checks that every catalog key is translated in all eight
// core catalogs, and test-i18n-dead-keys that every catalog key is still used.
// Neither notices a string the code asks for that NO catalog has: t() falls
// back to English, so the interface ships an English word in every language
// and every gate stays green. This one looks the other way: every
// `t('literal')` call in slides/src must be a key in all eight core catalogs.
//
// Only literal first arguments are checked. A label passed through a variable
// or built at run time is out of reach here; setLocale('x-pseudo') in a
// running editor is the audit for those.

import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'slides/src')
const coreDir = join(src, 'i18n')

let ts
try {
  ts = createRequire(join(root, 'slides/package.json'))('typescript')
} catch {
  console.error('test-slides-i18n-literals: needs slides/node_modules (cd slides && npm ci)')
  process.exit(1)
}

// the core locales are the ones build-i18n.mjs packs: read them from there
const LOCALES = JSON.parse(/const LOCALES = (\[[^\]]*\])/.exec(readFileSync(join(root, 'scripts/build-i18n.mjs'), 'utf8'))[1].replace(/'/g, '"'))

const calls = new Map() // key -> first file:line asking for it
const scan = (file) => {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const c = n.expression
      const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : ''
      const a = n.arguments[0]
      if (name === 't' && a && ts.isStringLiteralLike(a) && !calls.has(a.text)) {
        calls.set(a.text, `${relative(root, file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (p !== coreDir) walk(p) }
    else if (/\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) scan(p)
  }
}
walk(src)

const keysOf = (locale) => {
  const file = join(coreDir, `${locale}.ts`)
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const keys = new Set()
  const visit = (n) => {
    if (ts.isPropertyAssignment(n) && ts.isObjectLiteralExpression(n.parent)) {
      keys.add(ts.isStringLiteralLike(n.name) || ts.isIdentifier(n.name) ? n.name.text : n.name.getText(sf))
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return keys
}
const catalogs = Object.fromEntries(LOCALES.map((l) => [l, keysOf(l)]))

let failures = 0
let checks = 0
const ok = (cond, msg) => {
  checks++
  if (!cond) failures++
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`)
}

// the scan itself has to work, or every row below passes on nothing
ok(LOCALES.length === 8, `eight core locales read from build-i18n.mjs (${LOCALES.join(', ')})`)
ok(calls.size > 500, `the scan finds the editor's t() calls (${calls.size} literal keys)`)
ok(calls.has('Bring to front') && calls.has('Stacking order'), 'the scan reaches the inspector (two known keys)')
ok(LOCALES.every((l) => catalogs[l].size > 500), 'every core catalog parses to its keys')

const missing = []
for (const [key, where] of calls) {
  const lacking = LOCALES.filter((l) => !catalogs[l].has(key))
  if (lacking.length) missing.push(`${JSON.stringify(key)} (${where}) — missing in ${lacking.length === LOCALES.length ? 'every catalog' : lacking.join(', ')}`)
}
ok(missing.length === 0, `every literal t() key is in all ${LOCALES.length} core catalogs`)
for (const m of missing) console.log(`        ${m}`)
if (process.argv.includes('--list')) for (const [k, w] of calls) console.log(`  ${w}  ${JSON.stringify(k)}`)

console.log(`${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
