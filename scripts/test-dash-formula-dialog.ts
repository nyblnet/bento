#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash first-run rig: the formula dialog's checker and function list,
// the names new sheets get, and the locale Intl is handed — with no DOM.
//
//   node scripts/test-dash-formula-dialog.ts
//
// WHAT THIS PROVES.
//
//   1. THE DIALOG CHECKS SYNTAX, not only names. `parse` is lenient on purpose
//      (a column must evaluate on every row and never throw), so `Value * 2 +`
//      parsed, the dialog said nothing, and the column filled with #VALUE!.
//      `formulaSyntax` names each shape of broken formula — and accepts every
//      formula the starter workbook and the function pack actually use, because
//      a checker that refuses a working formula is worse than none.
//   2. EVERY FUNCTION HAS A SIGNATURE, and no signature names a function that
//      does not exist: the list is held against formula.ts's FUNCTIONS both
//      ways, so a new function cannot ship without its line in the dialog.
//   3. THE AUTOCOMPLETE completes the word at the caret — not inside a quoted
//      string or a [bracketed column], prefix matches first.
//   4. A NEW SHEET IS "Sheet3", not "Spreadsheet": numbered from the sheet
//      count, skipping taken names case-insensitively, and still terminating
//      when the translated pattern has lost its {n} (the x-pseudo locale).
//   5. Intl NEVER SEES A BAD TAG. A stored 'bento-lang' of 'x-pseudo' or a
//      malformed tag used to reach `new Intl.NumberFormat` and throw on the
//      first formatted cell, which stopped boot. `intlLocale` validates first.

import { registerHooks } from 'node:module'

registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

// A localStorage for the kernel's lsGet/lsSet, so setLocale behaves as in a page.
const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
}

const { formulaSyntax, FUNCTIONS } = await import('../dash/src/formula.ts')
const { FN_SIGNATURE, matchFunctions, wordAtCaret } = await import('../dash/src/fnsig.ts')
const { newSheetName } = await import('../dash/src/tabs.ts')
const { starterDoc } = await import('../dash/src/starter.ts')
const { intlLocale, isIntlTag, setLocale, locale } = await import('../dash/src/i18n.ts')
const { formatNumber } = await import('../dash/src/format.ts')

let checks = 0
let failures = 0
function ok(cond: unknown, msg: string): void {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

// --- 1. syntax -------------------------------------------------------------
console.log('\nformula syntax\n')
const BAD: Array<[string, string]> = [
  ['Value * 2 +', 'operand'],            // the review's case
  ['Value *', 'operand'],
  ['SUM(Value +)', 'operand'],
  ['* 2', 'operand-before'],
  ['=Value * 2', 'leading-equals'],
  ['SUM(Value', 'open'],
  ['(Value + 1', 'open'],
  ['Value + 1)', 'close'],
  ['"abc', 'string'],
  ['[Unit price * 2', 'bracket'],
  ['Value * 10%', 'char'],
  ['Value ; 2', 'char'],
  ['Value Value', 'unexpected'],
  ['SUM(Value,)', 'arg'],
  ['IF(,1,2)', 'arg'],
  ['()', 'empty-parens'],
  ['SUMM(Value)', 'function'],
  ['Rates!B2 * Value', 'sheet'],
]
for (const [src, kind] of BAD) {
  const got = formulaSyntax(src)
  ok(got?.kind === kind, `${JSON.stringify(src)} → ${kind} (got ${got ? JSON.stringify(got) : 'no problem'})`)
}
const op = formulaSyntax('Value * 2 +')
ok(op?.kind === 'operand' && op.after === '+', 'the missing operand names the operator it follows ("+"), so the message can say which')

const GOOD = [
  'Value * 2', 'Value * Probability', '-Value', '+Value', 'Value ^ 2 ^ 3', '(Value + 1) * 2',
  'IF(Value > 2, "big", "small")', 'ROUND(Value, 2) & " kg"', 'TODAY()', 'SUM()',
  '[Unit price] * Quantity', 'Value / SUM(Value)', '"say ""hi"""', 'TRUE', 'NOT(FALSE)',
  'Value >= 10', 'Value <> 3', 'SUMIFS(Value, Stage, "Won", Region, "North")', '.5 * Value',
  'value * prob',
]
for (const src of GOOD) {
  const got = formulaSyntax(src)
  ok(got === null, `${JSON.stringify(src)} is accepted (got ${got ? JSON.stringify(got) : 'null'})`)
}
ok(formulaSyntax('') === null && formulaSyntax('   ') === null, 'an empty formula is not a syntax problem (empty clears the formula)')

// every formula the starter workbook ships must pass — a checker that refuses
// the product's own example is the worst kind of false positive
const starter = starterDoc()
const starterFormulas = starter.sheets.flatMap((s) => s.kind === 'table' ? s.columns.filter((c) => c.formula).map((c) => c.formula!) : [])
ok(starterFormulas.length > 0, `the starter workbook has formula columns to check (${starterFormulas.length})`)
for (const f of starterFormulas) ok(formulaSyntax(f) === null, `starter formula ${JSON.stringify(f)} is accepted`)
// …and every function, called with a plausible argument, is a known function
const unknownFn = FUNCTIONS.filter((fn) => formulaSyntax(`${fn}(1)`)?.kind === 'function')
ok(unknownFn.length === 0, `every one of the ${FUNCTIONS.length} functions is known to the checker (${unknownFn.join(', ') || 'none refused'})`)

// --- 2. signatures -----------------------------------------------------------
console.log('\nfunction signatures\n')
const missingSig = FUNCTIONS.filter((fn) => !FN_SIGNATURE[fn])
ok(missingSig.length === 0, `every function has a signature (${missingSig.join(', ') || 'all present'})`)
const strayed = Object.keys(FN_SIGNATURE).filter((fn) => !FUNCTIONS.includes(fn))
ok(strayed.length === 0, `no signature names a function that does not exist (${strayed.join(', ') || 'none'})`)
const malformed = Object.entries(FN_SIGNATURE).filter(([fn, sig]) => !sig.startsWith(`${fn}(`) || !sig.endsWith(')'))
ok(malformed.length === 0, `every signature reads NAME(…) (${malformed.map(([f]) => f).join(', ') || 'all do'})`)

// --- 3. autocomplete ---------------------------------------------------------
console.log('\nautocomplete\n')
const su = matchFunctions(FUNCTIONS, 'su')
ok(su[0] === 'SUBSTITUTE' && su.includes('SUM') && su.includes('SUMIFS'), `"su" lists the SU… functions first (${su.slice(0, 4).join(' ')} …)`)
const look = matchFunctions(FUNCTIONS, 'lookup')
ok(look[0] === 'LOOKUP' && look.includes('VLOOKUP') && look.includes('XLOOKUP'), `"lookup": the prefix match first, then the ones that contain it (${look.join(' ')})`)
ok(matchFunctions(FUNCTIONS, '').length === FUNCTIONS.length, 'an empty query lists every function')
ok(matchFunctions(FUNCTIONS, 'zzz').length === 0, 'a query nothing matches lists nothing')
const w1 = wordAtCaret('Value * SU', 10)
ok(w1?.word === 'SU' && w1.from === 8 && w1.to === 10, `the word at the caret is the half-typed name (${JSON.stringify(w1)})`)
ok(wordAtCaret('IF(x, "SU', 9) === null, 'inside a quoted string there is nothing to complete')
ok(wordAtCaret('[Unit pr', 8) === null, 'inside a [bracketed column] there is nothing to complete')
ok(wordAtCaret('Value * ', 8) === null, 'after an operator and a space there is nothing to complete')
ok(wordAtCaret('2.5', 3) === null, 'a number is not a word to complete')

// --- 4. new sheet names ------------------------------------------------------
console.log('\nnew sheet names\n')
const doc = starterDoc()
ok(newSheetName(doc, 'Sheet{n}') === `Sheet${doc.sheets.length + 1}`, `a new sheet on a workbook of ${doc.sheets.length} is "Sheet${doc.sheets.length + 1}" (got ${newSheetName(doc, 'Sheet{n}')})`)
const taken = structuredClone(doc)
taken.sheets[0].name = `sheet${doc.sheets.length + 1}`
ok(newSheetName(taken, 'Sheet{n}') === `Sheet${doc.sheets.length + 2}`, 'a taken name is skipped, compared without case (Sheet3 vs sheet3)')
ok(newSheetName(doc, 'Hoja{n}') === `Hoja${doc.sheets.length + 1}`, 'the pattern is the translated one ("Hoja3")')
ok(!/spreadsheet/i.test(newSheetName(doc, 'Sheet{n}')), 'the kind is not the name — no "Spreadsheet SPREADSHEET" tab')
const lost = structuredClone(doc)
lost.sheets.push({ ...structuredClone(doc.sheets[0]), id: 'x', name: `⟦Šhēēt{ñ}⟧ ${doc.sheets.length + 1}` })
const viaPseudo = newSheetName(lost, '⟦Šhēēt{ñ}⟧')
ok(viaPseudo === `⟦Šhēēt{ñ}⟧ ${lost.sheets.length + 1}`, `a pattern that lost its {n} still counts and terminates (${viaPseudo})`)

// --- 5. the locale Intl is handed -------------------------------------------
console.log('\nthe locale Intl sees\n')
let threw = false
try { new Intl.NumberFormat('x-pseudo') } catch { threw = true }
ok(threw, 'positive control: Intl throws on "x-pseudo" in this runtime — the path that stopped boot')
ok(!isIntlTag('x-pseudo') && !isIntlTag('en_US!!') && !isIntlTag('') && isIntlTag('de-DE') && isIntlTag('ja'), 'isIntlTag tells a usable tag from a pseudo or malformed one')
for (const bad of ['x-pseudo', 'en_US!!', 'not a tag']) {
  store.set('bento-lang', bad)
  setLocale(bad)
  ok(locale() === bad, `the chosen locale really is ${JSON.stringify(bad)} (so the guard is what is tested)`)
  const loc = intlLocale()
  ok(isIntlTag(loc), `with ${JSON.stringify(bad)} chosen, Intl is handed a usable tag (${loc})`)
  let out = ''
  let err = ''
  try { out = formatNumber(1234.5, '#,##0.00') } catch (e) { err = String(e) }
  ok(!err && /1.?234.50|1.?234,50/.test(out), `and a formatted number still prints (${out || err})`)
}
setLocale('de')
ok(intlLocale() === 'de', 'a valid chosen locale is passed through unchanged')
setLocale('en')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
