#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// home/webext localisation rig.
//
//   node scripts/test-webext-i18n.ts
//
// WHAT THIS PROVES. Every failure mode of a message catalogue is silent.
//
//   · A key used in code but absent from English renders as the key name —
//     `helpAboutTitle` sitting where a heading should be.
//   · A key in a catalogue that no longer exists in code is dead weight nobody
//     will ever notice, and translators keep paying to maintain it.
//   · A locale missing a key falls back to English, so a German user gets a
//     German page with English sentences in it and nothing reports a fault.
//   · A `$1` that survives translation but loses its substitution shows the
//     user a literal dollar-one.
//
// None of these break anything. All of them are visible only to someone who
// reads that language, which is precisely the person we do not have.

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'home/webext')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const read = (p: string) => readFileSync(join(SRC, p), 'utf8')
const cat = (loc: string) => JSON.parse(read(`_locales/${loc}/messages.json`)) as
  Record<string, { message: string; description?: string }>

const locales = readdirSync(join(SRC, '_locales')).sort()
const en = cat('en')
const enKeys = new Set(Object.keys(en))

// ---- 1. what the code actually asks for -------------------------------------
const sources = readdirSync(join(SRC, 'src')).filter((f) => /\.(js|html)$/.test(f))
const used = new Set<string>()
// i18n.js is skipped rather than comment-stripped. It documents the attributes
// with EXAMPLE keys (`data-i18n="helpTitle"`) that no page ever renders, and it
// renders nothing itself — so excluding the file is exact, where stripping
// comments was not: a `*/` inside a regex or string swallowed real code after
// it and reported live keys as dead.
for (const f of sources) {
  if (f === 'i18n.js') continue
  const text = read(`src/${f}`).replace(/<!--[\s\S]*?-->/g, '')
  for (const m of text.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) used.add(m[1])
  for (const m of text.matchAll(/data-i18n(?:-html|-placeholder|-title)?="([A-Za-z0-9_]+)"/g)) used.add(m[1])
}
// Keys reached through a variable rather than a literal. Listed explicitly
// because a rig that cannot see them would call them dead and delete them.
for (const dynamic of ['agoHour', 'agoHours', 'agoDay', 'agoDays',
  'statusOneFolder', 'statusFolders', 'foundFolder', 'foundFolders']) used.add(dynamic)

ok(used.size > 100, `the code references ${used.size} message keys`)

const missing = [...used].filter((k) => !enKeys.has(k))
ok(missing.length === 0,
  `every key the code uses exists in English${missing.length ? `: missing ${missing.join(', ')}` : ''}`)

const manifestMsgs = [...read('manifest.json').matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map((m) => m[1])
const dead = [...enKeys].filter((k) => !used.has(k) && !manifestMsgs.includes(k))
ok(dead.length === 0,
  `no dead keys in English${dead.length ? `: ${dead.join(', ')}` : ''}`)

// ---- 2. every locale is complete --------------------------------------------
// Chrome falls back per key, so an incomplete catalogue is not broken — it is a
// page in two languages, which is worse than either and reports nothing.
for (const loc of locales) {
  if (loc === 'en') continue
  const c = cat(loc)
  // `appName` is a product name and deliberately declared only in English.
  const want = [...enKeys].filter((k) => k !== 'appName')
  const gaps = want.filter((k) => !c[k])
  ok(gaps.length === 0,
    `${loc} is complete${gaps.length ? ` — ${gaps.length} missing: ${gaps.slice(0, 5).join(', ')}${gaps.length > 5 ? '…' : ''}` : ''}`)
  const orphans = Object.keys(c).filter((k) => !enKeys.has(k))
  ok(orphans.length === 0,
    `${loc} carries no keys English lacks${orphans.length ? `: ${orphans.join(', ')}` : ''}`)
}

// ---- 3. substitutions survive translation -----------------------------------
// `$1` is not a word. A translator who drops it leaves a sentence with a hole,
// and one who adds a `$2` that the call site never passes shows a literal.
for (const loc of locales) {
  const c = cat(loc)
  const wrong: string[] = []
  for (const [k, v] of Object.entries(c)) {
    if (!en[k]) continue
    const want = new Set([...en[k].message.matchAll(/\$(\d)/g)].map((m) => m[1]))
    const got = new Set([...v.message.matchAll(/\$(\d)/g)].map((m) => m[1]))
    if (want.size !== got.size || [...want].some((n) => !got.has(n))) wrong.push(k)
  }
  ok(wrong.length === 0,
    `${loc} keeps every substitution${wrong.length ? `: ${wrong.join(', ')}` : ''}`)
}

// ---- 4. the strings that must not be guessed at -----------------------------
// A third of the catalogue explains a browser permission, where a mistranslation
// costs somebody their folder grants rather than merely reading oddly. The
// REVIEW note is how a translator knows which ones those are; losing it loses
// the only signal they get.
const flagged = Object.entries(en).filter(([, v]) => /REVIEW/.test(v.description ?? ''))
ok(flagged.length > 20, `${flagged.length} English keys carry a REVIEW note for translators`)

// And the one design decision that makes the rest safe: the prime block points
// at Chrome's dialog by POSITION, never by reproducing its button labels, which
// cannot be verified per language.
for (const gone of ['primeAllowOnce', 'primeAllowAlways', 'primeDeny']) {
  ok(!enKeys.has(gone),
    `${gone} is gone — Chrome's own button wording is never reproduced`)
}

// ---- 5. the direction the layout is drawn in --------------------------------
// Four of the shipped locales are right-to-left. Setting `dir` is half of it;
// the CSS must also stop naming sides, or Arabic renders in a left-to-right
// skeleton with the text mirrored inside it.
const i18nSrc = read('src/i18n.js')
ok(/applyDirection/.test(i18nSrc) && /getUILanguage/.test(i18nSrc),
  'the direction follows the browser language the catalogue was resolved from')
for (const f of ['src/ui.css', 'src/home.html', 'src/panel.html']) {
  const css = read(f)
  const physical = [...css.matchAll(/^\s*[^/*\n]*?(text-align:\s*(left|right)|padding-left|padding-right|margin-left:\s*auto|border-right:|(?<![-\w])left:\s*\d)/gm)]
  ok(physical.length === 0,
    `${f} names no sides${physical.length ? ` (${physical.length} physical properties)` : ''}`)
}
if (existsSync(join(SRC, '_locales/ar'))) {
  ok(/'ar'/.test(i18nSrc), 'Arabic ships, and the RTL set knows about it')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
