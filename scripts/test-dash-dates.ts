#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash date and time VALUES rig — entry × arithmetic × display × interop.
//
//   node scripts/test-dash-dates.ts
//
// WHAT THIS PROVES. A spreadsheet date was a string the engine could not
// compute with: `=A4+1`, `=TEXT(A4, "dd mmm yyyy")` and `=DATE(2026,3,4)+1`
// were all #VALUE!, and `=NOW()` printed `2026-11-07T11:57:37.957Z`. A date is
// still its canonical ISO TEXT in the file (datetime.ts says why), and the
// evaluator now reads it as the moment it spells. Every row below failed on the
// code before that change, or guards a refusal that must survive it:
//
//   ENTRY — each way a date or time gets into a cell (typing, a paste through
//   the same reader, a Date/Time-formatted cell) stores the canonical text and
//   stamps the format; `3/4/2026` STAYS TEXT (a pending maintainer decision —
//   this rig holds the current refusal, it does not decide it).
//   ARITHMETIC — through a real sheet recalculation, not a helper beside it.
//   ZONES — NOW()/TODAY() read the frozen instant on the viewer's clock, pinned
//   to zones on both sides of UTC and across a daylight-saving change.
//   DISPLAY — a cell's own date pattern, the viewer's month names.
//   ORDER — the sort comparator orders times and mixed datetime spellings.
//   EXCEL — a dataset's dates and datetimes go out to .xlsx and come back as
//   the same dates, not text and not a shifted day.
//
// Fixture values are chosen so that a wrong answer cannot equal the right one:
// day 4 of month 3 (a swapped order reads 3 April), times past 12:00 (a lost
// PM), a 31st (an overflowing EDATE).

import { registerHooks } from 'node:module'
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const { installDom } = await import('./lib/dash-dom.ts')
installDom()
const GR = await import('../dash/src/grid.ts')
const CP = await import('../dash/src/cellprops.ts')
const { setViewerLocale } = await import('../dash/src/format.ts')
const { recalcCells, canvasCellSource, cellKey } = await import('../dash/src/cellformula.ts')
const { isErr } = await import('../dash/src/formula.ts')
const { compare } = await import('../dash/src/filter.ts')
const { importXlsx, exportXlsx } = await import('../dash/src/xlsx.ts')
const { readCell } = await import('../dash/src/store.ts')
const { parseRef } = await import('../dash/src/a1.ts')
type CanvasCell = import('../dash/src/model.ts').CanvasCell
type DashDoc = import('../dash/src/model.ts').DashDoc
type TableSheet = import('../dash/src/model.ts').TableSheet

setViewerLocale('en-GB')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const show = (v: unknown): string => (isErr(v) ? `${v.code} ${v.why ?? ''}` : JSON.stringify(v))

// ---------------------------------------------------------------- 1. entry
console.log('\n1. what typing (and pasting) stores')
{
  const type = (text: string, prev?: CanvasCell) => GR.canvasCellEdit(prev, text)
  const paste = (text: string, prev?: CanvasCell) => GR.canvasCellPut(prev, text)
  const rows: Array<[string, string, string]> = [
    // typed                 stored v                format stamped
    ['2026-03-04',          '2026-03-04',           'yyyy-mm-dd'],
    ['2026/3/4',            '2026-03-04',           'yyyy-mm-dd'],
    ['Mar 4 2026',          '2026-03-04',           'yyyy-mm-dd'],
    ['4 March 2026',        '2026-03-04',           'yyyy-mm-dd'],
    ['2026-03-04 14:30',    '2026-03-04 14:30',     'yyyy-mm-dd hh:mm'],
    ['2026-03-04T14:30',    '2026-03-04 14:30',     'yyyy-mm-dd hh:mm'],
    ['Mar 4 2026 2:30 pm',  '2026-03-04 14:30',     'yyyy-mm-dd hh:mm'],
    ['2026-03-04 14:30:15', '2026-03-04 14:30:15',  'yyyy-mm-dd hh:mm:ss'],
    ['14:30',               '14:30',                'hh:mm'],
    ['9:05',                '09:05',                'hh:mm'],
    ['2:30 PM',             '14:30',                'hh:mm'],
    ['14:30:15',            '14:30:15',             'hh:mm:ss'],
  ]
  for (const [typed, v, fmt] of rows) {
    const c = type(typed)
    ok(c?.v === v && c?.format === fmt, `typing ${JSON.stringify(typed)} stores ${v} as ${fmt}   (got ${show(c?.v)} ${c?.format})`)
    const p = paste(typed)
    ok(p?.v === c?.v && p?.format === c?.format, `pasting ${JSON.stringify(typed)} stores exactly what typing does`)
  }
  // the refusals — unchanged, and a maintainer decision is pending on the first
  for (const s of ['3/4/2026', '3/4/2026 9:00', '13/2/2026', '1/2', '25:00', '12:61', '2026-02-30', 'Mar 4']) {
    const c = type(s)
    ok(c?.v === s && c?.format === undefined, `${JSON.stringify(s)} stays the TEXT it was, no format stamped   (got ${show(c?.v)} ${c?.format})`)
  }
  // a cell already formatted Time / Date reads its own kind
  ok(type('2:30 pm', { format: 'hh:mm' })?.v === '14:30', 'a Time cell reads 2:30 pm as 14:30')
  ok(type('13/2/2026', { format: 'yyyy-mm-dd' })?.v === '2026-02-13',
    'a Date cell reads a slash date whose order is decidable (rule 8), as before')
  ok(type('3/4/2026', { format: 'yyyy-mm-dd' })?.v === '3/4/2026', 'and still refuses 3/4/2026 there')
  ok(type('2026-03-04 14:30', { format: 'dd mmm yyyy' })?.v === '2026-03-04 14:30',
    'a datetime typed into a Date cell keeps its time')
  ok(type('14:30', { format: '@' })?.v === '14:30' && type('2026-03-04', { format: '@' })?.v === '2026-03-04',
    'the Text format is still absolute (rule 1)')
  ok(type('2026-03-04', { format: '#,##0' })?.v === '2026-03-04' && type('2026-03-04', { format: '#,##0' })?.format === '#,##0',
    'typing never overwrites a format somebody chose (rule 5)')
  // the formula bar shows what would type back to the same value
  for (const c of [type('2026-03-04 14:30'), type('2:30 PM'), type('Mar 4 2026')]) {
    const back = type(CP.enteredForm(c!), c!)
    ok(back?.v === c?.v && back?.format === c?.format, `Enter on ${show(c?.v)} changes nothing (enteredForm round trip)`)
  }
  // Recast: Date and time over existing text
  const r = CP.recastForFormat({ v: '2026-03-04 14:30' }, 'yyyy-mm-dd hh:mm')
  ok(r.cell?.v === '2026-03-04 14:30' && !r.refused, 'applying Date and time to a datetime keeps it')
  ok(CP.recastForFormat({ v: '3/4/2026 9:00' }, 'yyyy-mm-dd hh:mm').refused, 'and refuses the ambiguous one')
  ok(CP.classifyFormat('yyyy-mm-dd hh:mm').kind === 'datetime' && !CP.isCustomPattern('yyyy-mm-dd hh:mm'),
    'yyyy-mm-dd hh:mm is the Date and time preset, not Custom')
  ok(CP.CELL_KINDS.includes('datetime'), 'the cell format dropdown offers Date and time')
}

// ------------------------------------------------------- 2. arithmetic, live
console.log('\n2. arithmetic through a real sheet recalculation')
{
  // A sheet built by TYPING, so the values are exactly what entry stores.
  const typed: Record<string, string> = {
    A1: '2026-03-04', A2: '2026-03-31', A3: '2026-01-31', A4: '2026-03-04 22:30',
    A5: '09:05', A6: '12:30', A7: '2026-02-27', A8: '2026-03-09', A9: '2026-03-06',
    B1: 'Mar 4 2026', B2: '2026-12-25', B3: '2026-03-07',
  }
  const cells: Record<string, CanvasCell> = {}
  const put = (a1: string, cell: CanvasCell | null) => {
    const p = parseRef(a1)!
    if (cell) cells[cellKey(p.row, p.col)] = cell
  }
  for (const [k, s] of Object.entries(typed)) put(k, GR.canvasCellEdit(undefined, s))
  const formulas: Array<[string, unknown]> = [
    ['=A1+1', '2026-03-05'],
    ['=1+A1', '2026-03-05'],
    ['=A1-1', '2026-03-03'],
    ['=A1+30', '2026-04-03'],
    ['=A2-A1', 27],
    ['=A1-A2', -27],
    ['=A4-A1', 22.5 / 24],
    ['=(A4-A1)*24', 22.5],
    ['=A4+0.25', '2026-03-05 04:30'],
    ['=A1+0.5', '2026-03-04 12:00'],
    ['=A1+A6', '2026-03-04 12:30'],
    ['=A6-A5', (3 * 60 + 25) / 1440],
    ['=(A6-A5)*24*60', 205],
    ['=A6+TIME(13,0,0)', '01:30'],
    ['=A5*24', 9 + 5 / 60],
    ['=DATE(2026,3,4)+1', '2026-03-05'],
    ['=DATE(2026,3,4)=A1', true],
    ['=B1=A1', true],
    ['=A1<A2', true],
    ['=A5<A6', true],
    ['=A1<A4', true],
    ['=TEXT(A1,"dd mmm yyyy")', '04 Mar 2026'],
    ['=TEXT(A1,"dddd d mmmm yyyy")', 'Wednesday 4 March 2026'],
    ['=TEXT(A1,"yyyy-mm-dd")', '2026-03-04'],
    ['=TEXT(A1,"mm/dd/yy")', '03/04/26'],
    ['=TEXT(A4,"h:mm AM/PM")', '10:30 PM'],
    ['=TEXT(A4,"hh:mm:ss")', '22:30:00'],
    ['=TEXT(A6-A5,"h:mm")', '3:25'],
    ['=TEXT(A1+1,"d mmm")', '5 Mar'],
    ['=YEAR(A4)', 2026], ['=MONTH(A4)', 3], ['=DAY(A4)', 4],
    ['=HOUR(A4)', 22], ['=MINUTE(A4)', 30], ['=HOUR(A6)', 12], ['=MINUTE(A5)', 5],
    ['=WEEKDAY(A1)', 4], ['=WEEKDAY(A1,2)', 3], ['=WEEKDAY(A1,3)', 2], ['=WEEKDAY(A1,16)', 5],
    ['=EOMONTH(A1,0)', '2026-03-31'], ['=EOMONTH(A1,-1)', '2026-02-28'], ['=EOMONTH(A3,1)', '2026-02-28'],
    ['=EDATE(A3,1)', '2026-02-28'], ['=EDATE(A2,-1)', '2026-02-28'], ['=EDATE(A1,12)', '2027-03-04'],
    ['=DAYS(A2,A1)', 27],
    ['=DATEDIF(A3,B2,"M")', 10], ['=DATEDIF(A3,B2,"D")', 328], ['=DATEDIF(A1,B2,"MD")', 21],
    ['=DATEDIF("2026-01-20","2026-03-05","MD")', 13], ['=DATEDIF("2025-06-15","2026-03-04","YD")', 262],
    ['=DATEDIF(A1,B2,"Y")', 0], ['=DATEDIF("2020-02-29","2026-03-04","Y")', 6],
    ['=DATEDIF("2020-02-29","2026-03-04","YM")', 0],
    ['=NETWORKDAYS(A1,A8)', 4], ['=NETWORKDAYS(A1,A8,A9)', 3], ['=NETWORKDAYS(A8,A1)', -4],
    ['=WORKDAY(A7,1)', '2026-03-02'], ['=WORKDAY(A1,3,A9)', '2026-03-10'],
    ['=MAX(A1:A3)', '2026-03-31'], ['=MIN(A1:A3)', '2026-01-31'],
    ['=TIMEVALUE("2:30 PM")', '14:30'],
    ['=A1&""', '2026-03-04'],
  ]
  const fcells: Record<string, CanvasCell> = { ...cells }
  formulas.forEach(([f], i) => { fcells[cellKey(i, 5)] = { f } })            // column F
  const r = recalcCells(canvasCellSource({ cells: fcells }), '2026-03-04T12:00:00.000Z')
  formulas.forEach(([f, want], i) => {
    const got = r.values.get(cellKey(i, 5))
    const same = typeof want === 'number' && typeof got === 'number'
      ? Math.abs(got - want) < 1e-9
      : got === want
    ok(same, `${f} = ${JSON.stringify(want)}   (got ${show(got)})`)
  })
  // the refusals: nonsense stays an error, never a plausible number
  const refused: string[] = ['=A1+A2', '=1-A1', '=A1*2', '=A1/2', '=-A1', '=TEXT(46085,"dd mmm yyyy")',
    '=EDATE("3/4/2026",1)', '=YEAR("north")', '=WEEKDAY(A1,9)', '=DATEDIF(A2,A1,"D")', '=A6-A1']
  const rc: Record<string, CanvasCell> = { ...cells }
  refused.forEach((f, i) => { rc[cellKey(i, 6)] = { f } })
  const rr = recalcCells(canvasCellSource({ cells: rc }), '2026-03-04T12:00:00.000Z')
  refused.forEach((f, i) => {
    const got = rr.values.get(cellKey(i, 6))
    ok(isErr(got) && typeof got.why === 'string' && got.why.length > 0, `${f} is refused with a reason   (got ${show(got)})`)
  })
}

// ------------------------------------------------------------- 3. zones
console.log('\n3. NOW() and TODAY() — the frozen instant on the viewer’s clock')
{
  const at = (instant: string, f: string) => {
    const r = recalcCells(canvasCellSource({ cells: { [cellKey(0, 0)]: { f } } }), instant)
    return r.values.get(cellKey(0, 0))
  }
  const was = process.env.TZ
  const zones: Array<[string, string, string, string]> = [
    // zone                instant (UTC)              NOW()                    TODAY()
    ['UTC',                '2026-11-07T11:57:37.957Z', '2026-11-07 11:57:37', '2026-11-07'],
    ['Asia/Tokyo',         '2026-11-06T20:00:00.000Z', '2026-11-07 05:00',    '2026-11-07'],
    ['America/New_York',   '2026-11-07T02:30:00.000Z', '2026-11-06 21:30',    '2026-11-06'],
    // the night the clocks go forward: 06:30Z is 01:30 EST, 07:30Z is 03:30 EDT
    ['America/New_York',   '2026-03-08T06:30:00.000Z', '2026-03-08 01:30',    '2026-03-08'],
    ['America/New_York',   '2026-03-08T07:30:00.000Z', '2026-03-08 03:30',    '2026-03-08'],
    // and back: 05:30Z is 01:30 EDT, 06:30Z is 01:30 EST
    ['America/New_York',   '2026-11-01T06:30:00.000Z', '2026-11-01 01:30',    '2026-11-01'],
    ['Pacific/Kiritimati', '2026-11-07T11:00:00.000Z', '2026-11-08 01:00',    '2026-11-08'],
  ]
  for (const [zone, instant, now, today] of zones) {
    process.env.TZ = zone
    const n = at(instant, '=NOW()')
    const d = at(instant, '=TODAY()')
    ok(n === now, `${zone}: NOW() at ${instant} is ${now}   (got ${show(n)})`)
    ok(d === today, `${zone}: TODAY() at ${instant} is ${today}   (got ${show(d)})`)
  }
  process.env.TZ = 'America/New_York'
  const n = at('2026-11-07T11:57:37.957Z', '=NOW()')
  ok(typeof n === 'string' && !/[TZ]/.test(n), 'NOW() is never the raw UTC instant (no T, no Z)')
  ok(at('2026-11-07T11:57:37.957Z', '=NOW()+1') === '2026-11-08 06:57:37', 'and NOW()+1 is the same time tomorrow')
  ok(at('2026-11-07T11:57:37.957Z', '=TEXT(NOW(),"hh:mm")') === '06:57', 'and TEXT prints its local clock')
  // wall-clock arithmetic: an hour after 01:30 on the forward night is 02:30,
  // the hour that did not happen in New York — Excel's model, and zone-free
  ok(at('2026-03-08T12:00:00Z', '="2026-03-08 01:30"+1/24') === '2026-03-08 02:30',
    'datetime arithmetic is wall-clock and does not move with the zone')
  process.env.TZ = was
  if (was === undefined) delete process.env.TZ
}

// ------------------------------------------------------------- 4. display
console.log('\n4. a cell shows its value under its own pattern')
{
  const cases: Array<[CanvasCell, unknown, string]> = [
    [{ format: 'yyyy-mm-dd' }, '2026-03-04', '2026-03-04'],
    [{ format: 'dd mmm yyyy' }, '2026-03-04', '04 Mar 2026'],
    [{ format: 'd mmmm yyyy' }, '2026-03-04 14:30', '4 March 2026'],
    [{ format: 'yyyy-mm-dd hh:mm' }, '2026-03-04 14:30', '2026-03-04 14:30'],
    [{ format: 'h:mm AM/PM' }, '14:30', '2:30 PM'],
    [{ format: 'hh:mm' }, 0.0625, '01:30'],                   // a duration (B1-A1 over times)
    [{ format: 'hh:mm:ss' }, '14:30:15', '14:30:15'],
    [{ format: 'mmm-yy' }, '2026-03-04', 'Mar-26'],
    [{ format: '"Due "dd/mm' }, '2026-03-04', 'Due 04/03'],
    [{}, '2026-03-04 14:30', '2026-03-04 14:30'],
    [{ format: 'dd mmm yyyy' }, 'north', 'north'],             // not a date: shown as it is
    [{ format: '#,##0.00' }, 1234.5, '1,234.50'],              // numbers untouched
  ]
  for (const [cell, v, want] of cases) {
    const got = GR.canvasShown(cell, v)
    ok(got === want, `${show(v)} under ${JSON.stringify(cell.format ?? '')} shows ${want}   (got ${got})`)
  }
  ok(GR.canvasAlign({}, '2026-03-04 14:30') === 'right' && GR.canvasAlign({}, '14:30') === 'right',
    'a date or time sits right, with the numbers, even from a formula with no format')
  ok(GR.canvasAlign({}, 'north') === 'left', 'and text still sits left')
  setViewerLocale('de-DE')
  ok(GR.canvasShown({ format: 'd mmmm yyyy' }, '2026-03-04') === '4 März 2026',
    'month NAMES are the viewer’s (de-DE), the pattern is the author’s')
  setViewerLocale('en-GB')
  const prev = CP.cellPreview(undefined, 'yyyy-mm-dd hh:mm')
  ok(prev.text === '2026-03-05 14:30' && prev.sample, 'the format panel previews Date and time with a sample moment')
}

// ------------------------------------------------------------- 5. order
console.log('\n5. sorting orders moments as moments')
{
  const sorted = (xs: unknown[]) => [...xs].sort(compare)
  ok(JSON.stringify(sorted(['12:30', '09:05', '9:10', '23:59', '00:00'])) ===
    JSON.stringify(['00:00', '09:05', '9:10', '12:30', '23:59']), 'times sort by the clock, 9:10 between 09:05 and 12:30')
  ok(JSON.stringify(sorted(['2026-03-04T09:00:00', '2026-03-04 14:30', '2026-03-04', '2026-03-03 23:00'])) ===
    JSON.stringify(['2026-03-03 23:00', '2026-03-04', '2026-03-04T09:00:00', '2026-03-04 14:30']),
  'datetimes sort by instant whatever their spelling (an xlsx T against a typed space)')
  ok(JSON.stringify(sorted(['2026-12-01', 'north', 5, '2026-02-01'])) === JSON.stringify([5, '2026-02-01', '2026-12-01', 'north']),
    'numbers first, then dates in order, then words — the total order holds')
}

// ------------------------------------------------------------- 6. excel
console.log('\n6. a dataset’s dates go to .xlsx and come back as dates')
{
  const doc: DashDoc = {
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'dates-doc', title: 'Dates',
    sheets: [{
      id: 's1', name: 'Log', kind: 'table', rids: [[1, 4]],
      columns: [
        { id: 'what', name: 'What', type: 'text' },
        { id: 'day', name: 'Day', type: 'date' },
        { id: 'at', name: 'At', type: 'date' },
      ],
      data: {
        what: { enc: 'raw', v: ['a', 'b', 'c', 'd'] },
        day: { enc: 'raw', v: ['2026-03-04', '2026-12-31', '1999-01-01', '2026-02-28'] },
        at: { enc: 'raw', v: ['2026-03-04 14:30', '2026-03-04T09:05:00', '2026-12-31 23:59:59', '2026-03-04'] },
      },
      steps: [],
    } as unknown as TableSheet],
  }
  const out = await exportXlsx(doc, { at: new Date('2026-11-07T00:00:00Z') })
  const back = await importXlsx(out.bytes, { source: 'dates.xlsx', idPrefix: 'r' })
  const sheet = back.sheets.find((s) => s.kind === 'table') as TableSheet | undefined
  const col = (name: string) => sheet?.columns.find((c) => c.name === name)
  const vals = (name: string) => {
    const c = col(name)
    return c && sheet ? [0, 1, 2, 3].map((i) => readCell(sheet.data[c.id], i)) : []
  }
  ok(col('Day')?.type === 'date', `the Day column comes back typed date   (got ${col('Day')?.type})`)
  ok(JSON.stringify(vals('Day')) === JSON.stringify(['2026-03-04', '2026-12-31', '1999-01-01', '2026-02-28']),
    `every date is the same day   (got ${JSON.stringify(vals('Day'))})`)
  ok(col('At')?.type === 'date', `the At column comes back typed date   (got ${col('At')?.type})`)
  const want = ['2026-03-04 14:30', '2026-03-04 09:05', '2026-12-31 23:59:59', '2026-03-04 00:00']
  ok(vals('At').every((v, i) => {
    const a = String(v); const w = want[i]
    // same moment, whatever spelling the importer uses
    const norm = (s: string) => s.replace('T', ' ').replace(/^(\d{4}-\d{2}-\d{2})$/, '$1 00:00').replace(/(\d{2}:\d{2}):00$/, '$1')
    return norm(a) === norm(w)
  }), `every datetime keeps its time of day   (got ${JSON.stringify(vals('At'))})`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) {
  console.log(`${failures} FAILED`)
  process.exit(1)
}
