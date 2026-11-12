#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The bento/id pages' build rules (scripts/build-id-pages.mjs): the privacy
// notice and the account-deletion page.
//
//   node scripts/test-id-pages.mjs
//
// A publishing build refuses any page that still carries a __PLACEHOLDER__ (a
// privacy notice reading "__CONTROLLER__" must never go live), escapes every
// fact, refuses unknown facts and a deletion address off bento.page, and
// refuses any page that is more than text: external resources, script,
// forms, inputs, buttons, frames, event handlers. A part marked data-planned
// must open with its visible "Planned" label. The rest are content rows: the
// notice describes option G's records and none of the retired design's.
import { build, checkPage, FACT_KEYS, PAGES } from './build-id-pages.mjs'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0, passes = 0
const ok = (c, n) => { if (c) passes++; else { fails++; console.log('FAIL ' + n) } }
const refusal = (f) => { try { f(); return '' } catch (e) { return String(e.message) } }
const FACTS = Object.fromEntries(FACT_KEYS.map((k) => [k, `fact-${k.toLowerCase()}`]))
FACTS.CONTACT_EMAIL = 'privacy@bento.page'
FACTS.DELETE_URL = 'https://signin.id.bento.page/delete'
const SRC = Object.fromEntries(Object.entries(PAGES).map(([n, p]) => [n, readFileSync(join(root, p.src), 'utf8')]))

// --- placeholders and facts ---
const none = refusal(() => build({ facts: {} }))
ok(/__[A-Z_]+__/.test(none), `a publishing build with no facts is refused (${none.slice(0, 60)})`)
for (const k of FACT_KEYS) {
  const partial = { ...FACTS }; delete partial[k]
  ok(refusal(() => build({ facts: partial })).includes(`__${k}__`), `missing ${k} → refused`)
}
ok(/CONTROLLER/.test(refusal(() => build({ facts: { ...FACTS, CONTROLLER: '__X__' } }))), 'a fact that is itself a placeholder → refused')
ok(/CHILDREN/.test(refusal(() => build({ facts: { ...FACTS, CHILDREN: '   ' } }))), 'a blank fact → refused')
ok(/unknown fact TOMBSTONE_RETENTION/.test(refusal(() => build({ facts: { ...FACTS, TOMBSTONE_RETENTION: 'x' } }))), 'an unknown fact (the retired tombstone one) → refused')
for (const bad of ['javascript:alert(1)', 'http://signin.id.bento.page/delete', 'https://evil.example/delete', 'https://bento.page.evil.example/x', 'https://signin.id.bento.page/de lete']) {
  ok(/DELETE_URL/.test(refusal(() => build({ facts: { ...FACTS, DELETE_URL: bad } }))), `DELETE_URL ${bad} → refused`)
}
const pages = build({ facts: FACTS })
ok(Object.keys(pages).sort().join() === 'delete,privacy', 'control: a complete build gives both pages')
for (const n of Object.keys(PAGES)) ok(!/__[A-Z0-9_]+__/.test(pages[n]), `control: the complete ${n} page has no placeholder`)
ok(pages.privacy.includes('privacy@bento.page') && pages.privacy.includes('fact-controller'), 'facts are substituted into the notice')
ok(pages.delete.includes('href="https://signin.id.bento.page/delete"') && pages.delete.includes('fact-deletion_retention'), 'facts are substituted into the deletion page')
ok(build({ facts: { ...FACTS, CONTROLLER: '<b>x</b>' } }).privacy.includes('&lt;b&gt;x&lt;/b&gt;'), 'facts are HTML-escaped')
const pv = build({ preview: true })
ok(pv.privacy.includes('__CONTROLLER__') && pv.delete.includes('__DELETE_URL__'), 'a preview build keeps placeholders visible')
const used = new Set(Object.values(SRC).flatMap((s) => [...s.matchAll(/__([A-Z0-9_]+)__/g)].map((m) => m[1])))
ok(FACT_KEYS.every((k) => used.has(k)), 'every fact key is used by a page (none is dead)')
ok([...used].every((k) => FACT_KEYS.includes(k)), `every placeholder in the sources is a fact key (${[...used].filter((k) => !FACT_KEYS.includes(k))})`)
for (const k of ['CONTROLLER', 'CONTACT_EMAIL', 'DELETION_RETENTION']) ok(SRC.delete.includes(`__${k}__`), `the deletion page carries __${k}__ too`)

// --- the pages are text ---
const inject = (name, html) => refusal(() => build({ facts: FACTS, sources: { [name]: html } }))
const into = (s, add) => s.replace('</main>', add + '</main>')
for (const [label, add, re] of [
  ['script', '<script>1</script>', /script/], ['form', '<form></form>', /form/], ['input', '<input name=c>', /input/],
  ['textarea', '<textarea></textarea>', /textarea/], ['button', '<button>x</button>', /button/], ['iframe', '<iframe></iframe>', /iframe/],
  ['img src', '<img src="https://x.example/p.png">', /external/], ['onclick', '<p onclick="x()">x</p>', /event-handler/],
]) {
  ok(re.test(inject('privacy', into(SRC.privacy, add))), `notice with ${label} → refused`)
  ok(re.test(inject('delete', into(SRC.delete, add))), `deletion page with ${label} → refused`)
}
ok(inject('privacy', into(SRC.privacy, '<p>Write <b>on</b> paper = fine</p>')) === '', 'control: prose with "on" and "=" is not an event handler')
// planned parts carry their label
ok(/Planned/.test(inject('privacy', into(SRC.privacy, '<p data-planned>Sign out everywhere.</p>'))), 'a data-planned part without its label → refused')
ok(/Planned/.test(inject('privacy', into(SRC.privacy, '<p data-planned><span class="planned">Soon</span> x</p>'))), 'a data-planned part with another label → refused')
ok(inject('privacy', into(SRC.privacy, '<p data-planned><span class="planned">Planned</span> x</p>')) === '', 'control: a labelled planned part builds')
const plannedN = (SRC.privacy.match(/\bdata-planned\b/g) || []).length
ok(plannedN >= 4, `control: the notice's planned parts (${plannedN}) pass the rule`)
let threw = ''
for (const [n, s] of Object.entries(SRC)) { try { checkPage(n, s) } catch (e) { threw += e.message } }
ok(threw === '', `the real sources meet every page rule ${threw}`)

// --- content: option G's records ---
const P = pages.privacy.replace(/\s+/g, ' ')
const D = pages.delete.replace(/\s+/g, ' ')
for (const [what, re] of [
  ['the passkey list', /list of <b>passkeys<\/b>/], ['every version is kept', /every version of the list/], ['the countersignature', /countersignature/],
  ['the list is public', /This list is public/], ['setup by emailed link', /Setting up, by emailed link/], ['no typed codes', /never type or paste a code/],
  ['setup link lives 20 min / 24 h', /20 minutes, or for 24 hours/], ['tokens kept only as a hash', /only a one-way hash/],
  ['the roster in every mail', /Each of these emails lists every passkey/], ['the 72-hour wait', /72 hours after it is asked for/],
  ['the void link\'s hash only while waiting', /keep only its hash, and keep it only while the change is waiting/],
  ['the reset', /If you lose every passkey: the reset/], ['the reset link lives 24 h', /A reset link works for 24 hours/],
  ['the record of changes', /The record of changes/], ['the opener (ob) in the record', /which page asked the sign-in page to act/],
  ['the record kept for the life of the account', /How long:<\/b> for the life of the account/],
  ['24-hour certificates', /valid for <b>24 hours<\/b>/], ['the 7-day cap', /never beyond <b>7 days<\/b>/],
  ['the sign-in host\'s storage', /<code>bento-id-account<\/code>/], ['no cookies on the sign-in host', /sets no cookies/],
  ['the yearly one-click', /once a year we will email you one link/], ['the admin flag', /administrators can ask us to check an address/],
  ['a lapse is only the label', /A lapse changes only the label/], ['"unconfirmed since"', /unconfirmed since/],
  ['IP fingerprints gone a day and a minute after the day, at worst', /at the latest a day and a minute after it ends/], ['deletion is planned', /Planned<\/span> Deleting an account is not running yet/],
  ['the notice links the deletion page', /href="\/id\/delete"/],
]) ok(re.test(P), `notice says: ${what}`)
for (const [what, re] of [
  ['lookups', /[Ll]ookups? match/], ['one-time codes', /one-time code/], ['the 13-month expiry', /13 months/],
  ['the recovery blob', /[Rr]ecovery data/], ['a tombstone', /tombstone/i], ['the `ever` key-hash', /\bever:/],
  ['a retained recovery verifier', /verifier/i], ['an account key', /account key/i], ['a code sent to the address', /code sent to/],
]) ok(!re.test(P), `notice no longer mentions ${what}`)
for (const [what, re] of [
  ['no app needed', /You don't need bento\/home or any other app/], ['no typed code', /never type a code/],
  ['72 hours', /<b>72 hours<\/b>/], ['the stop link', /carries a link that stops it/], ['the notice', /href="\/id\/privacy"/],
]) ok(re.test(D), `deletion page says: ${what}`)
ok(!/\/v1\//.test(D) && !/one-time code/.test(D), 'the deletion page names no directory route and no one-time code')

// --- the command line writes both pages, and never a preview into site/ ---
const tmp = mkdtempSync(join(tmpdir(), 'id-pages-'))
try {
  writeFileSync(join(tmp, 'facts.json'), JSON.stringify(FACTS))
  execFileSync(process.execPath, [join(root, 'scripts/build-id-pages.mjs'), '--facts', join(tmp, 'facts.json'), '--out', join(tmp, 'out')], { stdio: 'pipe' })
  for (const p of Object.values(PAGES)) ok(existsSync(join(tmp, 'out', p.out)), `the build writes ${p.out}`)
  let cli = ''
  try { execFileSync(process.execPath, [join(root, 'scripts/build-id-pages.mjs'), '--out', join(tmp, 'none')], { stdio: 'pipe' }) } catch (e) { cli = String(e.stderr) }
  ok(/refusing/.test(cli) && !existsSync(join(tmp, 'none')), 'the command line refuses a build with placeholders and writes nothing')
  let site = ''
  try { execFileSync(process.execPath, [join(root, 'scripts/build-id-pages.mjs'), '--preview', join(tmp, 'site')], { stdio: 'pipe' }) } catch (e) { site = String(e.stderr) }
  ok(/never writes into site/.test(site), 'a preview never writes into a site/ directory')
} finally { rmSync(tmp, { recursive: true, force: true }) }

console.log(`${passes} passed, ${fails} failed`)
process.exit(fails)
