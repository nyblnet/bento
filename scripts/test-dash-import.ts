#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash import rig.
//
//   node scripts/test-dash-import.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. Import is where a data tool does its damage, because every
// mistake here is SILENT: the file opens, the grid fills, the totals compute,
// and the numbers are wrong. Three failures matter more than the rest, and each
// is checked from both sides — the right answer, AND that the plausible wrong
// answer is refused.
//
//   1. DATE ORDER. 03/04/2026 is 3 April or 4 March. A column where every day
//      is <= 12 cannot be decided from the data, and the industry norm is to
//      guess by locale. Guessing moves dates by up to eleven months, silently.
//      This rig asserts the import REFUSES rather than guesses.
//   2. DECIMAL COMMA. "1.234" is 1234 in Germany and 1.234 in Britain. The
//      decision must be per COLUMN and from the whole column.
//   3. NOTHING IS DROPPED. Ragged rows pad, they do not truncate; values that
//      will not coerce are counted on the column, not hidden.

import { parseDelimited, inferColumn, encodeColumn, coerce, importDelimited } from '../dash/src/import.ts'
import { parseDoc } from '../dash/src/model.ts'
import { readCell } from '../dash/src/store.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// ------------------------------------------------------------------ parsing
{
  const p = parseDelimited('a,b\n1,2\n')
  ok(p.rows.length === 2 && p.rows[1][1] === '2', 'a plain CSV parses')
  ok(parseDelimited('a,b\r\n1,2\r\n').rows.length === 2, 'CRLF parses the same')
  ok(parseDelimited('﻿a,b\n1,2').rows[0][0] === 'a',
    'a UTF-8 BOM is stripped — otherwise it becomes part of the first column NAME')
  ok(parseDelimited('a,b\n"x,y",2').rows[1][0] === 'x,y', 'a quoted delimiter stays in the field')
  ok(parseDelimited('a\n"say ""hi"""').rows[1][0] === 'say "hi"', 'doubled quotes are one literal quote')
  ok(parseDelimited('a,b\n"two\nlines",2').rows.length === 2,
    'a newline inside quotes does not end the row')
  ok(parseDelimited('a,b\n1,2\n\n').rows.length === 2, 'a trailing newline is not a row of data')
}

// --------------------------------------------------------------- delimiters
ok(parseDelimited('a;b;c\n1;2;3').delimiter === ';',
  'semicolon is detected — it is what Excel writes on a decimal-comma machine')
ok(parseDelimited('a\tb\n1\t2').delimiter === '\t', 'tab is detected')
ok(parseDelimited('name,note\n"Smith, John",x').delimiter === ',',
  'a comma inside quotes does not get a vote')
ok(parseDelimited('"a;b",c\n1,2').delimiter === ',',
  'nor does a semicolon inside quotes')

// ------------------------------------------------------------ THE BIG ONE
{
  // every day <= 12: genuinely undecidable
  const inf = inferColumn(['01/02/2026', '03/04/2026', '05/06/2026'])
  ok(inf.ambiguous?.kind === 'date-order',
    'a date column where every value fits BOTH DD/MM and MM/DD is reported ambiguous')
  ok(inf.type === 'text',
    'and it imports as TEXT — refusing to guess, because guessing moves dates by months')

  // one value settles it
  ok(inferColumn(['13/02/2026', '03/04/2026']).parsed === 'dmy',
    'a day > 12 in the FIRST position settles the column as DD/MM')
  ok(inferColumn(['02/13/2026', '04/03/2026']).parsed === 'mdy',
    'a day > 12 in the SECOND position settles it as MM/DD')
  ok(inferColumn(['2026-02-13', '2026-04-03']).parsed === 'iso', 'ISO dates are unambiguous')

  // and the whole-file path reports it where a user will see it
  const r = importDelimited('when,what\n01/02/2026,a\n03/04/2026,b')
  ok(r.findings.some((f) => f.code === 'date-ambiguous'),
    'the ambiguity reaches the caller as a finding, not just a type')
  ok(r.sheet.columns[0].type === 'text', 'and the column really is text')
}

// ------------------------------------------------------------ decimal comma
{
  ok(inferColumn(['1.234', '5.678']).parsed === 'dot', 'dot-decimal is read as dot')
  const de = inferColumn(['1.234,56', '2.000,00'])
  ok(de.type === 'number' && de.parsed === 'comma', 'German grouping+decimal is read as comma')
  ok(coerce('1.234,56', de) === 1234.56, 'and coerces to the right number')
  ok(coerce('1,234.56', inferColumn(['1,234.56'])) === 1234.56, 'as does the British convention')
  // The decision is per column, from the whole column. The discriminating case
  // is a value that is VALID UNDER BOTH conventions and means different things:
  // "1.234" is 1234 in a German column and 1.234 in a British one. A per-cell
  // implementation reads it under whichever convention it tries first, so one
  // column ends up holding both — and the total is then wrong by a factor of a
  // thousand, in a way nothing on screen reveals.
  const german = inferColumn(['1.234,56', '2.345,67', '9.876,54', '1.234'])
  ok(german.parsed === 'comma', 'a German column is identified from the whole column')
  ok(coerce('1.234', german) === 1234,
    'and an ambiguous value inside it reads as GERMAN (1234), not as 1.234')
  const british = inferColumn(['1,234.56', '2,345.67', '1,234'])
  ok(british.parsed === 'dot' && coerce('1,234', british) === 1234,
    'the same string in a British column also reads as 1234, by the other route')
}

// ------------------------------------------------------------------- types
ok(inferColumn(['true', 'false', 'yes']).type === 'bool', 'booleans are detected')
ok(inferColumn(['0', '1', '1']).type === 'number',
  'a 0/1 column stays a number — it is far more often a count than a flag')
ok(inferColumn(['$1,200', '$3,400']).type === 'money', 'currency is money')
ok(inferColumn(['12%', '4%']).type === 'percent', 'percentages are percent')
ok(coerce('12%', inferColumn(['12%', '4%'])) === 0.12, 'and a percent coerces to its fraction')
ok(inferColumn(['(1,200)', '(3,400)']).type === 'number', 'accounting parentheses are numbers')
ok(coerce('(1,200)', inferColumn(['(1,200)'])) === -1200, 'and they are NEGATIVE')
ok(inferColumn(['North', 'South']).type === 'text', 'words are text')
ok(inferColumn(['', '  ']).type === 'text', 'an entirely blank column is text, not a crash')

// ---------------------------------------------------------- nothing dropped
{
  const r = importDelimited('a,b,c\n1,2,3\n4,5\n6,7,8,9')
  ok(r.findings.some((f) => f.code === 'ragged-rows'), 'ragged rows are reported')
  ok(r.sheet.rids[0][1] === 3, 'and all three rows are kept — short rows pad, they do not vanish')
}
{
  const r = importDelimited('n\n1\n2\nnot-a-number\n4\n5\n6\n7\n8\n9\n10')
  const col = r.sheet.columns[0]
  ok(col.type === 'number' && col.failed === 1,
    'one junk value in a number column is COUNTED on the column, not hidden')
  ok(r.findings.some((f) => f.code === 'coerce-failed'), 'and reported to the caller')
}
{
  const r = importDelimited('a,a\n1,2')
  ok(r.findings.some((f) => f.code === 'duplicate-header'), 'a duplicate header is reported')
  ok(r.sheet.columns[0].id !== r.sheet.columns[1].id, 'and the two columns stay separate')
}
{
  const r = importDelimited('a,,c\n1,2,3')
  ok(r.findings.some((f) => f.code === 'empty-header'), 'an unnamed column is reported')
  ok(r.sheet.columns.length === 3, 'and kept')
}

// ---------------------------------------------------------------- encoding
{
  const repetitive = Array.from({ length: 1000 }, (_, i) => (i % 3 ? 'North' : 'South'))
  const enc = encodeColumn(repetitive, 'text')
  ok(enc.enc === 'dict' && enc.dict.length === 2,
    'a repetitive text column is dictionary-encoded — the 4.8 bytes/cell that makes the format fit')
  const unique = Array.from({ length: 1000 }, (_, i) => `id-${i}`)
  ok(encodeColumn(unique, 'text').enc === 'raw',
    'a near-unique column stays raw — a dictionary would cost and buy nothing')
  ok(encodeColumn([1, 2, 3], 'number').enc === 'raw', 'numbers are never dictionary-encoded')
  // the encoding must survive a read
  ok(readCell(enc, 0) === 'South' && readCell(enc, 1) === 'North',
    'and the dictionary round-trips through readCell')
}

// ------------------------------------------------------- the whole pipeline
{
  const csv = 'Region,Amount,When\nNorth,"1,200",2026-01-15\nSouth,"3,400",2026-02-20\nNorth,"900",2026-03-05'
  const r = importDelimited(csv, { name: 'Q1', sheetId: 'sh1', source: 'q1.csv', at: '2026-08-03T00:00:00Z' })
  ok(r.sheet.columns.map((c) => c.type).join() === 'text,number,date',
    'a realistic file types as text/number/date')
  ok(r.findings.length === 0, 'and produces no findings — a clean file imports quietly')
  ok(readCell(r.sheet.data.amount, 1) === 3400, 'quoted thousands parse')
  ok(r.sheet.steps[0].op === 'import' && (r.sheet.steps[0] as any).from === 'q1.csv',
    'steps[0] is the provenance record')
  ok((r.sheet.steps[0] as any).rows === 3, 'and it records how many rows arrived')

  // the imported sheet must be a legal document
  const doc = {
    format: 'bento/dash', version: 1, policy: 'bento-dash-1',
    docId: 'd', title: 'Q1', sheets: [r.sheet],
  }
  const parsed = parseDoc(JSON.stringify(doc))
  ok(parsed.ok === true && parsed.repairs.length === 0,
    'and the result parses as a bento/dash document with nothing to repair')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
