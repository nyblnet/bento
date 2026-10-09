// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// LIVE CELLS — a field whose value is a cell of an embedded sheet.
//
// THE FIXTURE IS DASH'S OWN OUTPUT. The workbook here is built by calling
// dash's `importDelimited` and `starterDoc`, not by hand-writing what a sheet
// is assumed to look like — the same rule test-type-fields.ts follows, and for
// the reason this zone learned the expensive way: an embed rig once passed for
// weeks against a preview fixture no app had ever produced, certifying a
// boundary that was broken the whole time. A fixture nobody's code writes
// proves nothing.

import { register } from 'node:module'
register('./lib/ts-resolve-hooks.mjs', import.meta.url)

const { parseAddress, resolveCell, embeddedSheets, cellResolver } = await import('../type/src/live.ts')
const { fieldContext, resolveField } = await import('../type/src/fields.ts')
const { sourceOfDoc } = await import('../type/src/merge.ts')
const { emptyDoc } = await import('../type/src/model.ts')
const { importDelimited } = await import('../dash/src/import.ts')
const { starterDoc } = await import('../dash/src/starter.ts')

let checks = 0, bad = 0
const ok = (cond: boolean, msg: string) => {
  checks++
  if (!cond) { bad++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const H = (s: string) => console.log(`\n— ${s} —`)

// ── the sheet, as dash writes it ────────────────────────────────────────────
const CSV = ['Quarter,Revenue,Margin,Note',
             'Q1,1000,12%,steady',
             'Q2,1150,13%,up',
             'Q3,1240,14%,best yet'].join('\n')
const mk = (csv: string, name: string, id: string) =>
  (importDelimited(csv, { name, sheetId: id }).sheet as Record<string, unknown>)
const workbook = (...sheets: unknown[]) => ({ ...starterDoc(), title: 'Numbers', sheets })

/** A type document embedding a dash workbook, the way embed.ts stores one. */
const docWith = (...sheets: unknown[]) => ({
  ...emptyDoc(),
  body: [{ id: 'p1', kind: 'para', text: 'Revenue grew to ', fields: [{ at: 16, name: 'Q3!Revenue' }] },
         { id: 'e1', kind: 'embed', text: '',
           embed: { app: 'bento/dash', view: '<svg/>', doc: workbook(...sheets) } }],
} as never)

const sheet = mk(CSV, 'Quarters', 'sh-q')

H('the address parses the way a person reads a table')
{
  ok(JSON.stringify(parseAddress('Q3!Revenue')) === '{"sheet":null,"row":"Q3","column":"Revenue"}',
     'two parts are row and column')
  ok(parseAddress('Budget!Q3!Revenue')?.sheet === 'Budget', 'three parts name the sheet as well')
  ok(parseAddress(' Q3 ! Revenue ')?.row === 'Q3', 'and are trimmed')
  ok(parseAddress('Name') === null, 'a plain name is NOT an address — it must still reach the merge row')
  ok(parseAddress('Q3!') === null, 'an empty part is refused rather than half-matched')
  ok(parseAddress('a!b!c!d') === null, 'and so is a fourth part')
}

H('a cell resolves by row label and column heading')
{
  const sheets = sourceOfDoc(workbook(sheet))!.sheets
  ok(resolveCell(parseAddress('Q3!Revenue')!, sheets).value === '1240', 'the number in the prose IS the number in the table')
  // A PERCENT COLUMN READS AS ITS UNDERLYING NUMBER, and this is the sharp
  // edge of the feature. dash's importer types "12%" as the number 0.12, and
  // merge.ts resolved long ago that this app writes what the cell HOLDS, never
  // dash's display format — carrying that formatter here would be a second
  // implementation of someone else's rules, wrong the first time they change
  // one. So `{{Q1!Margin}}` in prose reads "0.12", not "12%".
  //
  // Pinned rather than fixed, because it is a real limitation an author will
  // meet, and the fix (format it in the sheet, in a text column) belongs where
  // the format lives. If this is ever changed, this check is the argument.
  ok(resolveCell(parseAddress('Q1!Margin')!, sheets).value === '0.12',
     'a percent column resolves to its UNDERLYING value (0.12), not its displayed one')
  ok(resolveCell(parseAddress('q3!revenue')!, sheets).value === '1240', 'matching is case-insensitive, like every other field name')
  ok(resolveCell(parseAddress('Q3!Note')!, sheets).value === 'best yet', 'and a text column reads back whole')
}

H('THE POINT: the address survives the sheet being edited')
{
  const before = sourceOfDoc(workbook(sheet))!.sheets
  const v0 = resolveCell(parseAddress('Q3!Revenue')!, before).value

  // A row inserted ABOVE the one the sentence cites. A cell reference (B4)
  // would now silently point one row off — which is the exact drift this
  // feature exists to prevent, so it is the case that matters most here.
  const inserted = mk(['Quarter,Revenue,Margin,Note',
                       'Q0,900,11%,prior',
                       'Q1,1000,12%,steady',
                       'Q2,1150,13%,up',
                       'Q3,1240,14%,best yet'].join('\n'), 'Quarters', 'sh-q')
  const after = sourceOfDoc(workbook(inserted))!.sheets
  ok(v0 === '1240' && resolveCell(parseAddress('Q3!Revenue')!, after).value === '1240',
     'a row inserted ABOVE it does not move the answer')

  // A column inserted before the cited one, likewise.
  const recol = mk(['Quarter,Headcount,Revenue,Margin,Note',
                    'Q1,10,1000,12%,steady',
                    'Q2,11,1150,13%,up',
                    'Q3,12,1240,14%,best yet'].join('\n'), 'Quarters', 'sh-q')
  ok(resolveCell(parseAddress('Q3!Revenue')!, sourceOfDoc(workbook(recol))!.sheets).value === '1240',
     'nor does a column inserted before it')

  // Reordering rows must not move it either — sorting a sheet is routine.
  const sorted = mk(['Quarter,Revenue,Margin,Note',
                     'Q3,1240,14%,best yet',
                     'Q2,1150,13%,up',
                     'Q1,1000,12%,steady'].join('\n'), 'Quarters', 'sh-q')
  ok(resolveCell(parseAddress('Q3!Revenue')!, sourceOfDoc(workbook(sorted))!.sheets).value === '1240',
     'nor does sorting the sheet')
}

H('a miss is a miss, and says which')
{
  const sheets = sourceOfDoc(workbook(sheet))!.sheets
  ok(resolveCell(parseAddress('Q9!Revenue')!, sheets).why === 'no-row', 'a row that is gone reports no-row')
  ok(resolveCell(parseAddress('Q3!Profit')!, sheets).why === 'no-column', 'a heading that is gone reports no-column')
  ok(resolveCell(parseAddress('Q3!Revenue')!, []).why === 'no-sheet', 'no embedded sheet at all reports no-sheet')
  ok(resolveCell(parseAddress('Q9!Revenue')!, sheets).value === null,
     'and every one of them resolves to NULL, so fields.ts paints the unbound chip')
}

H('two sheets: named wins, unqualified refuses to guess')
{
  const other = mk(['Quarter,Revenue\nQ3,9999'].join('\n'), 'Forecast', 'sh-f')
  const sheets = sourceOfDoc(workbook(sheet, other))!.sheets
  ok(sheets.length === 2, 'both sheets are read')
  ok(resolveCell(parseAddress('Quarters!Q3!Revenue')!, sheets).value === '1240', 'a named sheet resolves to its own cell')
  ok(resolveCell(parseAddress('Forecast!Q3!Revenue')!, sheets).value === '9999', 'and the other to its')
  ok(resolveCell(parseAddress('Q3!Revenue')!, sheets).why === 'ambiguous',
     'an UNQUALIFIED address that both could answer is refused, not silently taken from the first')
  ok(resolveCell(parseAddress('Q1!Revenue')!, sheets).value === '1000',
     'while one only one sheet can answer still resolves')
}

H('it reaches the document through the ordinary field path')
{
  const doc = docWith(sheet)
  ok(embeddedSheets(doc).length === 1, 'the sheet is found inside the embed block')
  ok(cellResolver(doc)('Q3!Revenue') === '1240', 'the resolver answers an address')
  ok(cellResolver(doc)('Name') === null, 'and declines anything that is not one')

  const ctx = fieldContext(doc)
  ok(resolveField({ at: 16, name: 'Q3!Revenue' }, ctx) === '1240',
     'resolveField returns the cell — the registration is live')
  ok(resolveField({ at: 0, name: 'title' }, ctx) === doc.title,
     'and a built-in is untouched by it')
  ok(resolveField({ at: 0, name: 'Nope!Nope' }, ctx) === null, 'an unresolvable address stays null')

  // The merge row must still WIN, since live cells resolve last.
  const withRow = fieldContext(doc, { row: { 'q3!revenue': 'FROM THE ROW' } })
  ok(resolveField({ at: 0, name: 'Q3!Revenue' }, withRow) === 'FROM THE ROW',
     'a bound merge row still beats a live cell — adding this changed no existing precedence')

  ok(fieldContext(emptyDoc()).cell?.('Q3!Revenue') === null ?? true,
     'a document embedding nothing resolves no cells and does not throw')
}

console.log(`\n${checks - bad}/${checks} checks passed`)
if (bad) process.exit(1)
