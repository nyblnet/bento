#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// DATA VALIDATION — in-cell dropdowns and typed entry rules, on both kinds of
// sheet, in and out of .xlsx.
//
//   node scripts/test-dash-datavalid.ts     (Node ≥ 23.6 strips types natively)
//
// NOT scripts/test-dash-validate.ts, which is DOCUMENT validation ("does this
// workbook agree with itself"). Two features, two words that are the same word
// in English, and the reason both files say so in their first paragraph.
//
// WHAT THIS PROVES, and why each failure is invisible without it:
//
//   1. A DROPDOWN NOBODY CAN SEE. Every check below could be green with the
//      feature completely absent from the screen, because they would all be
//      testing pure functions that nothing calls. That happened in this repo
//      last round — a rig proved a function returned the right value while the
//      grid never called it. So the dropdown, the invalid mark and the refusal
//      are all asserted on the MARKUP A REAL `Grid` EMITS (scripts/lib/
//      dash-dom.ts mounts one), on BOTH paint loops, because the dataset and
//      the spreadsheet paint through different code.
//
//   2. A REJECT THAT DISCARDED A COLLABORATOR'S EDIT. The decision this
//      feature turns on: `reject` refuses AT THE KEYBOARD and nowhere else. A
//      value arriving from a paste, an import, an undo or a remote CRDT op
//      LANDS and is marked. A refusal on apply is either a divergence (this
//      replica holds different content from every other and is certain it is
//      right) or a silent discard of work somebody already did. Both arms are
//      pinned: the keyboard one refuses, the commit one does not.
//
//   3. A RULE THAT DELETED DATA. Adding a rule to a column of real data must
//      change no value and produce no `setCells`. Excel circles what already
//      breaks a new rule rather than removing it; deleting would be data loss
//      and silently accepting would make the rule a lie. The rig sums the
//      column before and after, and checks the mark appears.
//
//   4. A MARK THAT WENT STALE. The invalid mark is DERIVED at paint, never
//      stored. Stored, it would be wrong the moment either the value or the
//      rule moved, and it would cost bytes in a map whose whole promise is
//      sparseness. Pinned by editing the RULE and repainting with no other
//      change: the marks must move on their own.
//
//   5. A FILE THAT CAME BACK POORER. `<dataValidation>` is what makes an
//      .xlsx round trip survive, in BOTH directions. Also pinned: Excel's
//      `showDropDown` attribute is INVERTED (1 HIDES the dropdown), which is
//      the single most-misread attribute in the schema and reads correctly in
//      code that has it exactly backwards.
//
//   6. A RULE FROM AN UNTRUSTED FILE. A document is untrusted input (kernel
//      #277). A `list: []` would otherwise paint every cell in the column red
//      and refuse every entry; a rule of the wrong shape would throw during a
//      paint. Both must read as NO RULE.
//
//   7. A FILE AN OLDER BUILD DAMAGED. `validate` and `validations` are
//      optional and absent-means-off (PLATFORM §3), and a rule kind this build
//      has never heard of must survive a read untouched.
//
//   8. A NEW PATCH OP NOBODY INVERTED. There is none — a dataset rule is a
//      `setColumn` and a spreadsheet rule a `setSheetProps`, both of which
//      already invert. Checked by applying and undoing through the REAL store
//      and comparing the document byte for byte.

import { registerHooks } from 'node:module'

// The grid and the panel section both pull stylesheets, which is Vite's job
// and not Node's — the stub every DOM-touching dash rig uses.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const { installDom } = await import('./lib/dash-dom.ts')
const dom = installDom()

const {
  RULE_KINDS, boxRef, canvasEntryAt, canvasRuleAt, canvasRulePatch, canvasRules,
  columnRule, columnRulePatch, countViolations, describeRule, hasDropdown,
  listOptions, readRule, refBox, violationOf,
} = await import('../dash/src/datavalid.ts')
const { Grid } = await import('../dash/src/grid.ts')
const { Store, readCell } = await import('../dash/src/store.ts')
const { parseDoc } = await import('../dash/src/model.ts')
const { exportXlsx, importXlsx } = await import('../dash/src/xlsx.ts')
const { writeZip, readZip } = await import('../dash/src/zip.ts')
const { validateDoc } = await import('../dash/src/validate.ts')

import type { DashDoc, DataRule, TableSheet } from '../dash/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string): void {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// --- fixtures ----------------------------------------------------------------

const STATUSES = ['Open', 'Won', 'Lost']

/** A dataset with a Status column, one row of which says something else. */
function dataset(rule?: DataRule): DashDoc {
  const doc: DashDoc = {
    format: 'bento/dash', version: 1, policy: 'bento-dash-1',
    docId: 'd1', title: 'Pipeline',
    sheets: [{
      id: 'sh1', name: 'Deals', kind: 'table',
      rids: [[1, 4]],
      columns: [
        { id: 'status', name: 'Status', type: 'text', ...(rule ? { validate: rule } : {}) },
        { id: 'amount', name: 'Amount', type: 'number' },
      ],
      data: {
        status: { enc: 'raw', v: ['Open', 'Won', 'Pending', 'Lost'] },
        amount: { enc: 'raw', v: [10, 20, 30, 40] },
      },
      steps: [],
    } as TableSheet],
  }
  return JSON.parse(JSON.stringify(doc)) as DashDoc
}

/** A spreadsheet with a rule over B1:B3 and a value outside it. */
function spreadsheet(rule?: DataRule): DashDoc {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1',
    docId: 'd2', title: 'Scratch',
    sheets: [{
      id: 'cv1', name: 'Scratch', kind: 'canvas',
      cells: { A1: { v: 'x' }, B1: { v: 'Open' }, B2: { v: 'Nope' }, C2: { v: 'Nope' } },
      ...(rule ? { validations: [{ ref: 'B1:B3', rule }] } : {}),
    }],
  }))
  if (!r.ok) throw new Error('fixture would not parse')
  return r.doc
}

const listRule = (extra: Partial<DataRule> = {}): DataRule =>
  ({ kind: 'list', list: STATUSES, on: 'warn', ...extra })

/** Mount a real Grid and hand back the markup it paints, plus the live grid. */
function mount(doc: DashDoc, sheetId: string): { html: string; grid: InstanceType<typeof Grid>; store: InstanceType<typeof Store>; host: ReturnType<typeof dom.doc.createElement> } {
  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const store = new Store(doc)
  const grid = new Grid({ el: host as never, store, sheetId })
  const scroll = host.querySelector('.dg-scroll')!
  scroll.clientHeight = 600
  scroll.clientWidth = 900
  grid.paint()
  return { html: host.innerHTML, grid, store, host }
}

const repaint = (g: { paint(): void }, host: { innerHTML: string }): string => {
  g.paint()
  return host.innerHTML
}

/** The first worksheet's XML, out of the exported package. The bytes are a
 *  DEFLATED zip, so a rig that greps them for `<dataValidation` greps a
 *  compressed stream and passes for the wrong reason — it did, before this. */
async function sheet1Xml(bytes: Uint8Array): Promise<string> {
  const parts = await readZip(bytes)
  return new TextDecoder().decode(parts.get('xl/worksheets/sheet1.xml')!)
}

/** The document without its `modified` stamp, which every commit moves and
 *  which is not what "apply then undo leaves no trace" is about. */
const shape = (d: DashDoc): string =>
  JSON.stringify({ ...d, modified: undefined })

const key = (k: string, extra: Record<string, unknown> = {}) => ({
  type: 'keydown', key: k, shiftKey: false,
  preventDefault() {}, stopPropagation() {}, ...extra,
})

// ============================================================ READING A RULE
console.log('\nreading a rule out of an untrusted document')
{
  ok(readRule(null) === null, 'nothing is not a rule')
  ok(readRule('list') === null, 'a string is not a rule')
  ok(readRule({}) === null, 'a rule with no kind is not a rule')
  ok(readRule([1, 2]) === null, 'an array is not a rule')
  // The one that MATTERS: an empty list would refuse every entry and paint the
  // whole column red, from a file anyone can hand you.
  ok(readRule({ kind: 'list', list: [] }) === null,
    'a list rule with no values reads as NO RULE — it would otherwise refuse everything')
  ok(readRule({ kind: 'list', list: 'Open' }) === null,
    'and a list that is not an array of strings reads as no rule rather than throwing in a paint')
  ok(readRule({ kind: 'list', list: ['Open', 7, null] })?.list?.length === 1,
    'non-string entries are dropped from a list rather than reaching a menu label')

  const later = readRule({ kind: 'colour', palette: ['red'], on: 'reject' })
  ok(later?.kind === 'colour' && (later as Record<string, unknown>).palette !== undefined,
    'a kind this build has never heard of is READ and keeps its own fields (PLATFORM §3 additivity)')
  ok(readRule({ kind: 'number' })?.on === 'warn',
    'the default is warn, not reject — the collaboration decision, defaulted the safe way')
  ok(readRule({ kind: 'number', on: 'nonsense' })?.on === 'warn',
    'and an unreadable `on` falls back to warn rather than to the strict arm')
}

// ============================================================ CHECKING A VALUE
console.log('\nwhat breaks a rule')
{
  const r = listRule()
  ok(violationOf(r, 'Won') === null, 'a listed value passes')
  ok(violationOf(r, ' won ') === null, 'a list is matched loosely — a list is typed by hand, not parsed')
  ok(violationOf(r, 'Pending') !== null, 'an unlisted value does not')
  ok(violationOf(r, null) === null, 'blank is allowed by default, as Excel’s ignoreBlank is')
  ok(violationOf(listRule({ blank: false }), '') !== null, 'unless the rule says otherwise')

  const n: DataRule = { kind: 'number', min: 0, max: 100 }
  ok(violationOf(n, 50) === null && violationOf(n, 0) === null && violationOf(n, 100) === null,
    'a number range is inclusive at both ends')
  ok(violationOf(n, -1) !== null && violationOf(n, 101) !== null, 'and excludes outside it')
  ok(violationOf(n, 'banana') !== null,
    'a value the rule cannot READ is a violation, never a pass — a rule that shrugs at what it cannot parse is decoration')
  ok(violationOf({ kind: 'number', min: 0 }, 5) === null,
    'one-sided bounds work: absent max means no upper limit')

  const d: DataRule = { kind: 'date', min: '2026-01-01', max: '2026-12-31' }
  ok(violationOf(d, '2026-06-15') === null, 'a date inside its range passes')
  ok(violationOf(d, '2025-12-31') !== null, 'and one before it does not')
  ok(violationOf(d, '2026-06-15T09:30:00') === null,
    'a date-time is compared by DAY, so a time of day cannot push a value out of range')

  const tl: DataRule = { kind: 'textLength', min: 2, max: 4 }
  ok(violationOf(tl, 'abc') === null && violationOf(tl, 'a') !== null && violationOf(tl, 'abcde') !== null,
    'text length counts characters')

  ok(violationOf({ kind: 'formula', formula: 'A1>0' }, 'anything') === null,
    'a custom formula is CARRIED and never enforced — a rule that is right most of the time is worse than one that says it is not checked')

  ok(violationOf(listRule({ message: 'Pick a stage.' }), 'x') === 'Pick a stage.',
    'the author’s own message is what a reader sees, as Excel’s custom error is')
  ok(!(RULE_KINDS as readonly string[]).includes('formula'),
    'and the panel never OFFERS to make one, because this build could not check it')
}

// ============================================================ THE DATASET GRID
console.log('\nthe dataset grid: the dropdown and the mark are on screen')
{
  // 1. THE FEATURE IS VISIBLE. Every pure check above could pass with the grid
  //    calling none of it.
  const plain = mount(dataset(), 'sh1').html
  ok(!plain.includes('dv-arrow') && !plain.includes('dv-bad'),
    'a dataset with no rule emits neither an arrow nor a mark')

  const m = mount(dataset(listRule()), 'sh1')
  ok(m.html.includes('dv-arrow'),
    'a list rule on a column puts a real dropdown arrow in the emitted cell markup — the GRID calls this, not the rig')
  ok((m.html.match(/dv-arrow/g) ?? []).length === 4,
    'one per row of the column, and not on the other column')
  ok(m.html.includes('dv-bad'),
    'and the row that already says "Pending" is MARKED')
  ok((m.html.match(/dv-bad/g) ?? []).length === 1,
    'exactly the one row that breaks it — three good values are not marked')
  ok(/title="Must be one of: Open, Won, Lost"/.test(m.html),
    'the mark carries the reason, so hovering it says what is wrong')

  // 3. THE RULE CHANGED NOTHING. The whole promise of "existing data is marked".
  const sheet = m.store.doc.sheets[0] as TableSheet
  ok(readCell(sheet.data.status, 2) === 'Pending',
    'the value that breaks the rule is still in the document, unchanged and undeleted')
  ok([0, 1, 2, 3].map((i) => readCell(sheet.data.amount, i)).join() === '10,20,30,40',
    'and nothing else moved either')

  // 4. THE MARK IS DERIVED, NOT STORED. Widen the rule; the marks must follow
  //    with no other edit and nothing to invalidate.
  m.store.commit(columnRulePatch(sheet, 'status', listRule({ list: [...STATUSES, 'Pending'] })))
  ok(!repaint(m.grid, m.host).includes('dv-bad'),
    'widening the rule un-marks the row on the next paint — the mark is derived, so it cannot go stale')

  // The suppressed dropdown, which is a real Excel setting and the attribute
  // everybody gets backwards on the way in and out of a file.
  const noDd = mount(dataset(listRule({ noDropdown: true })), 'sh1').html
  ok(!noDd.includes('dv-arrow') && noDd.includes('dv-bad'),
    'noDropdown suppresses the arrow and keeps the checking')
}

// ============================================================ THE SPREADSHEET GRID
console.log('\nthe spreadsheet grid: the other paint loop')
{
  const plain = mount(spreadsheet(), 'cv1').html
  ok(!plain.includes('dv-arrow') && !plain.includes('dv-bad'),
    'a spreadsheet with no rule emits neither')

  const m = mount(spreadsheet(listRule()), 'cv1')
  ok(m.html.includes('dv-arrow'),
    'a range rule draws the arrow through the SPREADSHEET paint loop too — two loops, one feature')
  ok(m.html.includes('dv-bad'), 'and marks B2, which says "Nope"')
  // THE RANGE IS THE POINT of this kind. C2 holds the same offending text and
  // is outside B1:B3, so a rule that leaked across columns would mark it.
  ok((m.html.match(/dv-bad/g) ?? []).length === 1,
    'C2 holds the same bad text and is NOT marked: a range rule stops at its range')
  ok(canvasRuleAt(canvasRules(m.store.doc.sheets[0] as never), 1, 2) === null,
    'and the same answer from the reader the panel uses')
}

// ============================================================ REJECT vs WARN
console.log('\nreject refuses at the keyboard, and nowhere else')
{
  // THE KEYBOARD ARM. Type a bad value into a `reject` column and press Enter.
  const m = mount(dataset(listRule({ on: 'reject' })), 'sh1')
  m.grid.sel.moveTo(0, 0)
  m.grid.paint()
  ok(m.grid.typeInto('N'), 'typing over a cell opens the editor, rule or no rule')
  const cell = m.host.querySelector('.dg-cell.dg-editing')!
  cell.textContent = 'Nope'
  cell.dispatchEvent(key('Enter'))
  const sheet = m.store.doc.sheets[0] as TableSheet
  ok(readCell(sheet.data.status, 0) === 'Open',
    'a refused entry is NOT committed — the document still holds what it held')
  ok(cell.classList.contains('dv-refused'),
    'and the cell says it was refused')
  ok(cell.contentEditable === 'true',
    'the editor stays OPEN with the typed text still in it, so nothing the author typed is discarded either')

  // Escape is the way out, exactly as it always was.
  cell.dispatchEvent(key('Escape'))
  ok(readCell(sheet.data.status, 0) === 'Open' && m.grid.editActive() !== false,
    'Escape abandons the entry rather than trapping the reader in the cell')
}
{
  // A GOOD VALUE STILL LANDS. A refusal that refused everything would pass
  // every check above.
  const m = mount(dataset(listRule({ on: 'reject' })), 'sh1')
  m.grid.sel.moveTo(0, 0)
  m.grid.paint()
  m.grid.typeInto('W')
  const cell = m.host.querySelector('.dg-cell.dg-editing')!
  cell.textContent = 'Won'
  cell.dispatchEvent(key('Enter'))
  ok(readCell((m.store.doc.sheets[0] as TableSheet).data.status, 0) === 'Won',
    'a value the rule allows commits normally')
}
{
  // THE WARN ARM. Same keystrokes, `on: 'warn'`: the value lands and is marked.
  const m = mount(dataset(listRule({ on: 'warn' })), 'sh1')
  m.grid.sel.moveTo(0, 0)
  m.grid.paint()
  m.grid.typeInto('N')
  const cell = m.host.querySelector('.dg-cell.dg-editing')!
  cell.textContent = 'Nope'
  cell.dispatchEvent(key('Enter'))
  ok(readCell((m.store.doc.sheets[0] as TableSheet).data.status, 0) === 'Nope',
    'warn lets the entry through')
  ok((repaint(m.grid, m.host).match(/dv-bad/g) ?? []).length === 2,
    'and marks it, beside the one that was already wrong')
}
{
  // THE DECISION THIS FEATURE TURNS ON. A `reject` rule must NOT refuse a
  // value that arrives any other way. `store.commit` is exactly the shape a
  // remote CRDT op, an undo and an import all take; `pasteTsv` is the local
  // non-keyboard path. Refusing either would mean this replica holds different
  // content from every other one, or that somebody else's committed work
  // vanished from one screen and not the others.
  const m = mount(dataset(listRule({ on: 'reject' })), 'sh1')
  m.store.commit({ op: 'setCells', sheet: 'sh1', col: 'status', rids: [1], v: ['Nope'] })
  ok(readCell((m.store.doc.sheets[0] as TableSheet).data.status, 0) === 'Nope',
    'a commit — a remote op, an undo, an import — LANDS against a reject rule; refusing it would diverge the replicas')
  ok(repaint(m.grid, m.host).includes('dv-bad'), 'and is marked, which is all a rule may do to it')

  m.grid.sel.moveTo(1, 0)
  m.grid.paint()
  m.grid.pasteTsv('Nonsense')
  ok(readCell((m.store.doc.sheets[0] as TableSheet).data.status, 1) === 'Nonsense',
    'a PASTE lands too: refusing one cell of a block leaves a hole nobody can see')
}
{
  // The spreadsheet kind's editor, which is a second copy of the same decision.
  const m = mount(spreadsheet(listRule({ on: 'reject' })), 'cv1')
  m.grid.sel.moveTo(0, 1)          // B1
  m.grid.paint()
  m.grid.typeInto('N')
  const cell = m.host.querySelector('.dg-cell.dg-editing')!
  cell.textContent = 'Nope'
  cell.dispatchEvent(key('Enter'))
  const cells = (m.store.doc.sheets[0] as unknown as { cells: Record<string, { v?: unknown }> }).cells
  ok(cells.B1?.v === 'Open', 'the spreadsheet editor refuses too, and commits nothing')
  ok(cell.classList.contains('dv-refused'), 'with the same mark on the same open editor')
}

// ============================================================ PATCHES AND UNDO
console.log('\nno new patch op, and both of the old ones invert')
{
  const doc = dataset()
  const before = shape(doc)
  const store = new Store(doc)
  const sheet = doc.sheets[0] as TableSheet
  store.commit(columnRulePatch(sheet, 'status', listRule()))
  ok(columnRule((store.doc.sheets[0] as TableSheet).columns[0])?.kind === 'list',
    'a dataset rule is written with the EXISTING setColumn op — it belongs to the column, which owns the type')
  store.undo()
  ok(shape(store.doc) === before,
    'and one ⌘Z leaves the document byte-identical, container and all')
}
{
  const doc = spreadsheet()
  const before = shape(doc)
  const store = new Store(doc)
  const sheet = doc.sheets[0] as never
  store.commit(canvasRulePatch(sheet, 'B1:B3', listRule()) as never)
  ok(canvasRules(store.doc.sheets[0] as never).length === 1,
    'a spreadsheet rule is written with the EXISTING setSheetProps op — a range, as Excel’s sqref is')
  store.undo()
  ok(shape(store.doc) === before,
    'and undoing it drops the `validations` container rather than leaving `[]` behind')
}
{
  // Replacing rather than stacking: the panel edits a rule field by field, so
  // a patch that appended would grow the list on every keystroke and turn
  // last-match-wins into a hundred dead entries under one live one.
  const doc = spreadsheet(listRule())
  const store = new Store(doc)
  store.commit(canvasRulePatch(doc.sheets[0] as never, 'B1:B3', listRule({ on: 'reject' })) as never)
  const after = canvasRules(store.doc.sheets[0] as never)
  ok(after.length === 1 && after[0].rule.on === 'reject',
    'setting a rule on a range that already has one REPLACES it rather than stacking a second')
}
{
  const rules = [
    { ref: 'A1:D10', rule: { kind: 'number', min: 0 } as DataRule },
    { ref: 'B2:B4', rule: listRule() },
  ]
  ok(canvasRuleAt(rules, 2, 1)?.kind === 'list',
    'where two ranges overlap the LATER rule wins — a newer, narrower correction must not be shadowed by an older, broader rule')
  ok(canvasEntryAt(rules, 2, 1)?.ref === 'B2:B4',
    'and the panel is told which range it is editing, so changing a message cannot silently re-key the rule to the selection')
  ok(boxRef(refBox('B2:B4')!) === 'B2:B4' && boxRef(refBox('B2')!) === 'B2',
    'a range round-trips through the reader and back to the same A1 text')
}

// ============================================================ COUNTING, LABELS
console.log('\nwhat the panel says')
{
  const c = countViolations(listRule(), ['Open', 'Pending', 'Won', ''])
  ok(c.n === 1 && !c.capped, 'the offender count skips blanks a rule allows and counts the rest')
  ok(describeRule(listRule()) === 'One of: Open, Won, Lost', 'a list describes itself')
  ok(describeRule({ kind: 'number', min: 0, max: 10 }).includes('between'), 'and so does a range')
  ok(hasDropdown(listRule()) && !hasDropdown({ kind: 'number' }) && !hasDropdown(null),
    'only a list rule draws an arrow')
  ok(listOptions(listRule()).join() === 'Open,Won,Lost', 'and the menu shows what the list says')
}

// ============================================================ DOCUMENT VALIDATION
console.log('\nthe OTHER validation is untouched')
{
  // The two features share a word and nothing else. A rule must not become a
  // finding, and validate.ts must not start reporting a workbook that carries
  // one as damaged.
  const clean = validateDoc(dataset())
  const withRule = validateDoc(dataset(listRule()))
  ok(withRule.findings.length === clean.findings.length,
    'adding an entry rule produces no new document-validation finding: these are two different questions')
}

// ============================================================ XLSX, BOTH WAYS
console.log('\n.xlsx carries the rule in and out')

const enc = new TextEncoder()
const M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** The smallest package `importXlsx` will read, with one sheet. */
async function pkg(sheetXml: string): Promise<Uint8Array> {
  return writeZip([
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>') },
    { name: '_rels/.rels', data: enc.encode(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: enc.encode(`<?xml version="1.0"?><workbook xmlns="${M}" xmlns:r="${R}"><workbookPr/><sheets><sheet name="Deals" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheetXml) },
  ], {})
}

const rows =
  '<row r="1"><c r="A1" t="inlineStr"><is><t>Status</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row>' +
  '<row r="2"><c r="A2" t="inlineStr"><is><t>Open</t></is></c><c r="B2"><v>10</v></c></row>' +
  '<row r="3"><c r="A3" t="inlineStr"><is><t>Won</t></is></c><c r="B3"><v>20</v></c></row>'

const sheetWith = (dv: string): string =>
  `<?xml version="1.0"?><worksheet xmlns="${M}"><sheetData>${rows}</sheetData>${dv}</worksheet>`

{
  const r = await importXlsx(await pkg(sheetWith(
    '<dataValidations count="1"><dataValidation type="list" allowBlank="1" errorStyle="stop" sqref="A2:A3">' +
    '<formula1>"Open,Won,Lost"</formula1></dataValidation></dataValidations>')), {})
  const rule = columnRule(r.sheets[0].columns[0])
  ok(rule?.kind === 'list' && rule.list?.join() === 'Open,Won,Lost',
    'an imported list validation becomes a column rule with the values written out')
  ok(rule?.on === 'reject', 'errorStyle="stop" is the strict arm')
  ok(rule?.noDropdown !== true,
    'and the dropdown is ON, because showDropDown was absent — the attribute is INVERTED and this is the arm everybody gets wrong')
}
{
  const r = await importXlsx(await pkg(sheetWith(
    '<dataValidations count="1"><dataValidation type="list" showDropDown="1" sqref="A2:A3">' +
    '<formula1>"Open,Won"</formula1></dataValidation></dataValidations>')), {})
  ok(columnRule(r.sheets[0].columns[0])?.noDropdown === true,
    'showDropDown="1" HIDES the dropdown — reading it as "show" ships every imported list with its arrow the wrong way round')
}
{
  const r = await importXlsx(await pkg(sheetWith(
    '<dataValidations count="1"><dataValidation type="decimal" operator="between" allowBlank="0" errorStyle="warning" sqref="B2:B3">' +
    '<formula1>0</formula1><formula2>100</formula2></dataValidation></dataValidations>')), {})
  const rule = columnRule(r.sheets[0].columns[1])
  ok(rule?.kind === 'number' && rule.min === 0 && rule.max === 100, 'a decimal between-rule becomes a number range')
  ok(rule?.blank === false, 'allowBlank="0" carries across')
  ok(rule?.on === 'warn', 'and errorStyle="warning" is the lenient arm')
}
{
  const r = await importXlsx(await pkg(sheetWith(
    '<dataValidations count="1"><dataValidation type="list" sqref="A2:A2">' +
    '<formula1>$H$1:$H$5</formula1></dataValidation></dataValidations>')), {})
  ok(columnRule(r.sheets[0].columns[0]) === null,
    'a list that points at a RANGE of cells is not imported — dash stores the values themselves and inventing an empty list would refuse everything')
  ok(r.findings.some((f) => f.code === 'data-validation'),
    'and it is REPORTED rather than dropped in silence, the way merged ranges already are')
}
{
  const r = await importXlsx(await pkg(sheetWith(
    '<dataValidations count="1"><dataValidation type="custom" sqref="A2:A3">' +
    '<formula1>ISTEXT(A2)</formula1></dataValidation></dataValidations>')), {})
  const rule = columnRule(r.sheets[0].columns[0])
  ok(rule?.kind === 'formula' && rule.formula === 'ISTEXT(A2)',
    'a custom formula is kept VERBATIM, the way CellOverride.xlsxF keeps a formula dash cannot run')
}
{
  // EXPORT, which is the half that makes a round trip a round trip.
  const doc = dataset(listRule({ on: 'reject', message: 'Pick a stage.' }))
  const out = await exportXlsx(doc)
  const xml = await sheet1Xml(out.bytes)
  ok(xml.includes('<dataValidation type="list"'), 'a column rule is exported as a real <dataValidation>')
  ok(xml.includes('sqref="A2:A5"'),
    'over the DATA rows only — a range including the header makes Excel circle a heading as invalid')
  ok(xml.includes('<formula1>"Open,Won,Lost"</formula1>'), 'with the list written out the way Excel spells one')
  ok(xml.includes('errorStyle="stop"') && xml.includes('error="Pick a stage."'),
    'and the strictness and the author’s message travel with it')
  ok(xml.indexOf('<dataValidations') > xml.indexOf('</sheetData>'),
    'AFTER sheetData, which the schema requires — Excel calls the file unreadable otherwise')

  const back = await importXlsx(out.bytes, {})
  const rule = columnRule(back.sheets[0].columns[0])
  ok(rule?.kind === 'list' && rule.list?.join() === 'Open,Won,Lost' && rule.on === 'reject',
    'and it comes home: dash → xlsx → dash returns the rule that left')
}
{
  const doc = dataset(listRule({ noDropdown: true }))
  const xml = await sheet1Xml((await exportXlsx(doc)).bytes)
  ok(xml.includes('showDropDown="1"'),
    'a suppressed dropdown goes out as showDropDown="1" — the same inversion, on the way out')
}
{
  const long = Array.from({ length: 60 }, (_, i) => `Option-number-${i}`)
  const out = await exportXlsx(dataset(listRule({ list: long })))
  const xml = await sheet1Xml(out.bytes)
  ok(!xml.includes('<dataValidation'),
    'a list longer than Excel’s 255-character limit is NOT exported truncated — a shortened list would start refusing values the author allows')
  ok(out.findings.some((f) => f.code === 'data-validation'),
    'and the export says so, in the house style xlsx.ts already uses for what it cannot carry')
}
{
  const out = await exportXlsx(dataset({ kind: 'number', on: 'warn' }))
  ok(out.findings.some((f) => f.code === 'data-validation'),
    'an unbounded "must be a number" has no Excel spelling at all — reported rather than given an invented bound')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
