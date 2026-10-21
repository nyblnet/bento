#!/usr/bin/env node
// CSV export: quoting, and formula injection.
//
//   node scripts/test-dash-csv-export.ts
//
// A spreadsheet opening a CSV evaluates any field starting = + - @ tab or CR.
// Dash's text cells can hold such text from a paste, a typo, or a stranger's
// form submission, so TEXT that starts that way is exported with a leading
// `'` (read as "text" by Excel and Sheets). Numbers are never touched.

import { csvField } from '../dash/src/csvout.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

console.log('\nformula-leading text is escaped')
for (const [v, want] of [
  ['=HYPERLINK("http://x","click")', `"'=HYPERLINK(""http://x"",""click"")"`],
  ['=IMPORTXML("http://x","//a")', `"'=IMPORTXML(""http://x"",""//a"")"`],
  ['+1+1', "'+1+1"],
  ['-2+3', "'-2+3"],
  ['@SUM(A1)', "'@SUM(A1)"],
  ['\t=1', "'\t=1"],
  ['\r=1', `"'\r=1"`],
] as const) {
  ok(csvField(v) === want, `${JSON.stringify(v)} → ${JSON.stringify(csvField(v))}`)
}

console.log('\nCONTROLS: ordinary values are untouched')
for (const [v, want] of [
  [-5, '-5'],
  [3.25, '3.25'],
  [true, 'true'],
  ['plain', 'plain'],
  ['a=b', 'a=b'],
  ['', ''],
  [null, ''],
  ['has, comma', '"has, comma"'],
  ['say "hi"', '"say ""hi"""'],
  ['two\nlines', '"two\nlines"'],
] as const) {
  ok(csvField(v) === want, `${JSON.stringify(v)} → ${JSON.stringify(csvField(v))}`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
