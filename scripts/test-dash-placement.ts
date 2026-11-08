// Tables placed inside a grid: geometry, hit-testing, and the parse repairs.
//
//   node scripts/test-dash-placement.ts
//
// docs/dash-unified.md. A `TableSheet` may carry `placed = { on, r, c }`: it
// then lives on the canvas sheet `on` with its header row at (r, c). Every
// surface reads placement.ts, so this rig pins what that module answers.
//
// Each repair row has a CONTROL that a well-formed placement survives the
// same parse — otherwise "dropped" could mean "parse drops every placement".

const { parseDoc } = await import('../dash/src/model.ts')
const P = await import('../dash/src/placement.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc
type TableSheet = import('../dash/src/model.ts').TableSheet

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const table = (id: string, rows: number, cols: number, extra: Record<string, unknown> = {}) => ({
  id, name: id.toUpperCase(), kind: 'table', rids: rows ? [[1, rows]] : [], nextRid: rows + 1,
  columns: Array.from({ length: cols }, (_, i) => ({ id: `c${i}`, name: `C${i}`, type: 'number' })),
  data: Object.fromEntries(Array.from({ length: cols }, (_, i) => [`c${i}`, { enc: 'raw', v: Array(rows).fill(i) }])),
  steps: [], ...extra,
})
const grid = (id: string) => ({ id, name: id, kind: 'canvas', cells: {} })
const docOf = (sheets: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 't', sheets, ...extra })
const parsed = (json: string): { doc: DashDoc; repairs: Array<{ what: string; id: string; became: string }> } => {
  const r = parseDoc(json)
  if (!r.ok) throw new Error('fixture did not parse: ' + JSON.stringify(r))
  return r as never
}
const sheet = (doc: DashDoc, id: string) => doc.sheets.find((s) => s.id === id) as TableSheet

console.log('\ngeometry: header, rows, totals')
{
  const t = table('t', 3, 2) as unknown as TableSheet
  const r = P.tableRect(t, { r: 4, c: 1 })
  ok(r.r0 === 4 && r.c0 === 1 && r.r1 === 7 && r.c1 === 2, `3 rows × 2 columns at B5 covers B5:C8 (got ${JSON.stringify(r)})`)
  const withTotals = table('t', 3, 2, { totals: { c0: 'sum' } }) as unknown as TableSheet
  ok(P.tableRect(withTotals, { r: 4, c: 1 }).r1 === 8, 'a totals row adds one row below the data')
  const empty = table('t', 0, 0) as unknown as TableSheet
  const e = P.tableRect(empty, { r: 0, c: 0 })
  ok(e.r1 === 0 && e.c1 === 0, 'an empty table with no columns still occupies its anchor cell, so it can be found')
}

console.log('\nhit-testing: which part of which table a grid cell is')
{
  const { doc } = parsed(docOf([grid('g'), table('t', 2, 3, { placed: { on: 'g', r: 1, c: 1 }, totals: { c0: 'sum' } })]))
  const at = (r: number, c: number) => P.tableAt(doc, 'g', r, c)
  ok(at(0, 1) === null, 'the cell above the header is grid, not table')
  ok(at(1, 0) === null, 'the cell left of the header is grid, not table')
  ok(JSON.stringify(at(1, 2)?.hit) === '{"part":"header","col":1}', 'the header row maps to header, by column')
  ok(JSON.stringify(at(3, 3)?.hit) === '{"part":"row","row":1,"col":2}', 'a data cell maps to its row and column index')
  ok(JSON.stringify(at(4, 1)?.hit) === '{"part":"totals","col":0}', 'the row after the data is the totals row')
  ok(at(5, 1) === null, 'below the totals row is grid again')
  ok(P.tableAt(doc, 'other', 1, 1) === null, 'a table is only on the grid it names')
}

console.log('\ntabs: a placed table is not a tab; an unplaced one is')
{
  const { doc } = parsed(docOf([grid('g'), table('placed', 1, 1, { placed: { on: 'g', r: 0, c: 0 } }), table('own', 1, 1)]))
  const tabs = doc.sheets.filter((s) => P.isTab(doc, s)).map((s) => s.id)
  ok(JSON.stringify(tabs) === '["g","own"]', `tabs are the grid and the unplaced table (got ${JSON.stringify(tabs)})`)
}

console.log('\nparse keeps a well-formed placement (the CONTROL for every repair below)')
{
  const { doc, repairs } = parsed(docOf([grid('g'), table('t', 2, 2, { placed: { on: 'g', r: 3, c: 2 } })]))
  ok(JSON.stringify(sheet(doc, 't').placed) === '{"on":"g","r":3,"c":2}', 'placed survives parse unchanged')
  ok(repairs.length === 0, 'and is not reported as a repair')
}

console.log('\nparse drops a placement it cannot honour, keeps the table, and says why')
for (const [label, sheets, want] of [
  ['negative anchor', [grid('g'), table('t', 1, 1, { placed: { on: 'g', r: -1, c: 0 } })], 'malformed'],
  ['fractional anchor', [grid('g'), table('t', 1, 1, { placed: { on: 'g', r: 1.5, c: 0 } })], 'malformed'],
  ['not an object', [grid('g'), table('t', 1, 1, { placed: 'g' })], 'malformed'],
  ['missing host', [grid('g'), table('t', 1, 1, { placed: { on: 'nope', r: 0, c: 0 } })], 'no-host'],
  ['host is a table', [table('h', 1, 1), table('t', 1, 1, { placed: { on: 'h', r: 0, c: 0 } })], 'host-not-grid'],
] as const) {
  const { doc, repairs } = parsed(docOf(sheets as unknown as unknown[]))
  const t = sheet(doc, 't')
  ok(!!t && !('placed' in t) && t.rids.length === 1, `${label}: placement dropped, table and its rows kept`)
  ok(repairs.some((r) => r.what === 'placement' && r.id === 't' && r.became === want), `${label}: reported as '${want}'`)
}

console.log('\noverlap: the EARLIER table in sheet order keeps its place')
{
  const { doc, repairs } = parsed(docOf([
    grid('g'),
    table('first', 3, 3, { placed: { on: 'g', r: 0, c: 0 } }),
    table('second', 3, 3, { placed: { on: 'g', r: 2, c: 2 } }),
    table('beside', 3, 3, { placed: { on: 'g', r: 0, c: 3 } }),
  ]))
  ok(!!sheet(doc, 'first').placed, 'the first table keeps its placement')
  ok(!sheet(doc, 'second').placed && repairs.some((r) => r.id === 'second' && r.became === 'overlap'), 'the overlapping second is unplaced and reported')
  ok(!!sheet(doc, 'beside').placed, 'CONTROL: a table touching but not overlapping keeps its placement')
}

console.log('\na MERGED state no file held: drawing applies the same rule live, without parse')
{
  // Two replicas each moved a table somewhere valid; the merge overlaps them.
  // Built as an object, NOT parsed — collab state never goes back through parseDoc.
  const doc = {
    format: 'bento/dash', version: 1, docId: 'd', title: 't',
    sheets: [
      grid('g'),
      table('a', 3, 3, { placed: { on: 'g', r: 0, c: 0 } }),
      table('b', 3, 3, { placed: { on: 'g', r: 1, c: 1 } }),
      table('orphan', 1, 1, { placed: { on: 'deleted-grid', r: 0, c: 0 } }),
    ],
  } as unknown as DashDoc
  ok(P.tableAt(doc, 'g', 1, 1)?.table.id === 'a', 'the overlapped cell belongs to the EARLIER table')
  ok(P.tableAt(doc, 'g', 3, 3) === null, 'the later table draws nothing on the grid — not even its own corner')
  const tabs = doc.sheets.filter((s) => P.isTab(doc, s)).map((s) => s.id)
  ok(JSON.stringify(tabs) === '["g","b","orphan"]', `the later table and the orphan show as their own tabs (got ${JSON.stringify(tabs)})`)
  ok(!!(doc.sheets[2] as TableSheet).placed, 'drawing never rewrites the document — the placement is still there to win back')
}

console.log('\na FROZEN file (newer policy) is never repaired, and still shows every table')
{
  const r = parseDoc(docOf([grid('g'), table('t', 1, 1, { placed: { on: 'future-kind-sheet', r: 0, c: 0 } })], { policy: 'bento-dash-99' }))
  ok(r.ok && !!(r as { frozen?: string }).frozen, 'CONTROL: the fixture really is frozen')
  const doc = (r as { doc: DashDoc }).doc
  ok(JSON.stringify(sheet(doc, 't').placed) === '{"on":"future-kind-sheet","r":0,"c":0}', 'the placement a newer build wrote is left exactly as written')
  ok(P.isTab(doc, sheet(doc, 't')), 'and the table it cannot place here still shows, as its own tab')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
