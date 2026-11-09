#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The bento/id privacy notice's build rules (scripts/build-id-pages.mjs).
//
//   node scripts/test-id-pages.mjs
//
// A publishing build refuses any page that still carries a __PLACEHOLDER__ (a
// privacy notice reading "__CONTROLLER__" must never go live), escapes every
// fact, and loads nothing external. The web deletion page that used to be
// built and tested here is retired with the typed-code routes it called.
import { build, FACT_KEYS } from './build-id-pages.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0, passes = 0
const ok = (c, n) => { if (c) passes++; else { fails++; console.log('FAIL ' + n) } }
const FACTS = Object.fromEntries(FACT_KEYS.map((k) => [k, `fact-${k.toLowerCase()}`]))
FACTS.CONTACT_EMAIL = 'privacy@bento.page'

let refused = ''
try { build({ facts: {} }) } catch (e) { refused = e.message }
ok(/__[A-Z_]+__/.test(refused), `a publishing build with no facts is refused (${refused.slice(0, 60)})`)
for (const k of FACT_KEYS) {
  const partial = { ...FACTS }; delete partial[k]
  let r = ''
  try { build({ facts: partial }) } catch (e) { r = e.message }
  ok(r.includes(`__${k}__`), `missing ${k} → refused`)
}
let bad = ''
try { build({ facts: { ...FACTS, CONTROLLER: '__X__' } }) } catch (e) { bad = e.message }
ok(/CONTROLLER/.test(bad), 'a fact that is itself a placeholder → refused')
const pages = build({ facts: FACTS })
ok(!/__[A-Z0-9_]+__/.test(pages.privacy), 'control: a complete build leaves no placeholder')
ok(pages.privacy.includes('privacy@bento.page') && pages.privacy.includes('fact-controller'), 'facts are substituted into the notice')
ok(build({ facts: { ...FACTS, CONTROLLER: '<b>x</b>' } }).privacy.includes('&lt;b&gt;x&lt;/b&gt;'), 'facts are HTML-escaped')
ok(build({ preview: true }).privacy.includes('__CONTROLLER__'), 'a preview build keeps placeholders visible')
for (const must of ['What the directory stores', 'What it never stores', 'Amazon SES', '13 months']) ok(pages.privacy.includes(must), `notice says: ${must}`)
// the deletion page is retired: nothing builds it, links to it, or asks for a typed code
ok(!('delete' in pages) && !existsSync(join(root, 'site-src/id-delete.html')), 'no deletion page is built, and its source is gone')
ok(!/\/id\/delete/.test(pages.privacy) && !/code sent to/.test(pages.privacy), 'the notice neither links to it nor mentions a mailed code')
ok(!/id-delete|\/id\/delete/.test(readFileSync(join(root, 'scripts/build-id-pages.mjs'), 'utf8').replace(/^\/\/.*$/gm, '')), 'the build script names it nowhere but its comments')

console.log(`${passes} passed, ${fails} failed`)
process.exit(fails)
