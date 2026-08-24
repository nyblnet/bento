#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash toolbar-action rig — what runs on which kind of sheet, with no DOM.
//
//   node scripts/test-dash-actions.ts     (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES, AND WHY IT IS NOT A CLICK TEST. You can see whether a
// button is greyed out. What you cannot see is whether the greying and the
// crashing agree with each other — and before the table in tabs.ts, they did
// not. Measured on a `kind: 'canvas'` sheet in the built shell: Formula, Chart,
// 3D, Pivot, Story and Export were all lit, and four of them answered a click
// with `Uncaught Error: grid needs a table sheet` — no dialog, no chart, no
// message, nothing on screen at all. `Grid.sheet` is a getter that throws when
// the sheet is not a dataset, and eight scattered call sites each reached for
// it.
//
// So the checks here are about the TABLE, which is the thing that has to stay
// right as actions are added:
//
//   1. EVERY ACTION IN THE BAR HAS A ROW. Read out of main.ts's own markup, so
//      a ninth action added to the toolbar and not to the table fails HERE
//      rather than by throwing at a reader six months later. This is the check
//      that makes "one table" true rather than aspirational.
//   2. EVERY ROW IS REACHABLE. A rule for a `data-act` that no longer exists is
//      a reason nobody will ever read, and it hides the fact that the control
//      it described is gone.
//   3. A REFUSAL ALWAYS SAYS WHY. For every action and every kind it does not
//      run on, there is a non-empty sentence — that string is both the disabled
//      button's tooltip and the banner a stale click reports, so an empty one
//      is a control that is simply dead. The rule TYPE enforces this at compile
//      time (a kind-scoped rule without `why` does not typecheck); this catches
//      the runtime half — a `why` that returns '' for some kind.
//   4. THE REASON IS A SENTENCE, not a code. "chart-canvas" tells a reader
//      nothing; "Charts bind to a dataset's columns — this is a spreadsheet"
//      teaches the difference the two kinds exist to express.
//   5. `actionReason` IS EMPTY EXACTLY WHEN `actionApplies` IS TRUE. main.ts
//      keys `disabled` off the string being non-empty, so a reason that leaks
//      out for a kind the action DOES run on would grey out a working control,
//      and the reverse is the crash this rig exists for.
//   6. THE MATRIX ITSELF. Spelled out per action rather than derived, because a
//      check derived from the table would pass whatever the table said.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { registerHooks } from 'node:module'

// tabs.ts imports its stylesheet, which is Vite's job and not Node's. The same
// stub test-dash-tabs.ts and test-dash-panels.ts use, for the same reason.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const { ACTIONS, ACTION_IDS, actionApplies, actionReason } =
  await import('../dash/src/tabs.ts')
type ActionId = import('../dash/src/tabs.ts').ActionId

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/**
 * The kinds a workbook can put in front of the reader.
 *
 * `''` is in the list on purpose: it is what `shownKind()` returns when the
 * grid points at a sheet that is no longer in the document — a delete, an
 * undo, a remote op — and it is the case a table keyed on known kinds forgets.
 * `timeline` stands for a kind this build has never heard of, which the format
 * explicitly tolerates (model.ts preserves an unrecognised kind verbatim).
 */
const KINDS = ['table', 'canvas', 'pivot', 'timeline', ''] as const

// ================================================= the table covers the bar

console.log('the table and the toolbar agree')
{
  // main.ts's markup is the authority on what the bar contains: every control
  // is `data-act="…"`, including the ones mounted by help.ts.
  const main = readFileSync(
    fileURLToPath(new URL('../dash/src/main.ts', import.meta.url)), 'utf8')
  const help = readFileSync(
    fileURLToPath(new URL('../dash/src/help.ts', import.meta.url)), 'utf8')
  const inBar = new Set<string>()
  for (const src of [main, help]) {
    // THREE SPELLINGS, because the bar has three, and the third is the one that
    // matters. MEASURED, as a negative control on this very check: a ninth
    // action added as `barBtn('forecast', …)` and left out of the table was NOT
    // caught, because `barBtn` emits `data-act="${act}"` — a template, so the
    // literal-markup pattern never sees it. What the pattern was really finding
    // was the `querySelector('[data-act="chart"]')` lines further down, which an
    // action wired by delegation would not have either. A check that passes for
    // the wrong reason is worse than no check: it is a promise this file makes
    // in its own header.
    //   1. literal markup      data-act="save"   (and every querySelector)
    //   2. the helper          barBtn('chart', …)
    //   3. assigned property   dataset.act = 'help'   (help.ts's ? button)
    for (const m of src.matchAll(/data-act=["']([a-z0-9-]+)["']/g)) inBar.add(m[1])
    for (const m of src.matchAll(/\bbarBtn\(\s*['"]([a-z0-9-]+)['"]/g)) inBar.add(m[1])
    for (const m of src.matchAll(/dataset\.act\s*=\s*['"]([a-z0-9-]+)['"]/g)) inBar.add(m[1])
  }
  ok(inBar.size >= 12, `found the bar's actions in the source (${inBar.size})`)

  const missing = [...inBar].filter((a) => !(a in ACTIONS))
  ok(missing.length === 0,
    `every action in the bar has a row in ACTIONS${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`)

  const phantom = ACTION_IDS.filter((a) => !inBar.has(a))
  ok(phantom.length === 0,
    `and every row is a control that exists${phantom.length ? ` — stale: ${phantom.join(', ')}` : ''}`)
}

// ================================================= a refusal always says why

console.log('\nevery action that does not apply says why, in a sentence')
for (const id of ACTION_IDS) {
  const rule = ACTIONS[id]
  if (rule.on === 'workbook') {
    ok(KINDS.every((k) => actionApplies(id, k) && actionReason(id, k) === ''),
      `${id} is about the workbook, so no sheet can take it away`)
    continue
  }
  const gated = KINDS.filter((k) => !actionApplies(id, k))
  ok(gated.length > 0, `${id} is gated on the kind, so something must fail it`)
  const bad = gated.filter((k) => {
    const why = actionReason(id, k)
    return !why || why.length < 20 || !/[.!?]$/.test(why.trim())
  })
  ok(bad.length === 0,
    `${id} gives a real sentence for every kind it refuses${bad.length ? ` — thin: ${bad.map((k) => k || '(none)').join(', ')}` : ''}`)
}

console.log('\nthe reason is empty exactly when the action applies')
for (const id of ACTION_IDS) {
  const wrong = KINDS.filter((k) => actionApplies(id, k) !== (actionReason(id, k) === ''))
  ok(wrong.length === 0,
    `${id}: applies ⇔ no reason${wrong.length ? ` — disagrees on ${wrong.map((k) => k || '(none)').join(', ')}` : ''}`)
}

// A reason that names the wrong kind is worse than a vague one: it tells the
// reader something false about the sheet they are on. The spreadsheet case is
// the one worth teaching, so it must actually say so.
console.log('\na spreadsheet is told it is a spreadsheet')
for (const id of ACTION_IDS) {
  if (ACTIONS[id].on === 'workbook' || actionApplies(id, 'canvas')) continue
  ok(/spreadsheet/i.test(actionReason(id, 'canvas')),
    `${id} names the spreadsheet rather than saying "unavailable"`)
}

// ================================================= the matrix, spelled out

console.log('\nthe matrix')
{
  // WRITTEN OUT, not derived. A check that asked the table what the table says
  // would pass no matter what the table said; these are the answers a reader of
  // docs/dash-sheet-kinds.md would give, independently.
  const dataset: ActionId[] = ['formula', 'chart', 'viz3d', 'pivot', 'story', 'export']
  const workbook: ActionId[] = [
    'dashboard', 'undo', 'redo', 'import', 'import-xlsx', 'export-xlsx',
    // Print is workbook-scoped: the dialog prints EITHER kind, and its default
    // scope is the sheet on screen whatever that sheet is.
    'print',
    'save', 'about', 'settings', 'help',
  ]
  ok(dataset.every((a) => actionApplies(a, 'table')),
    'every dataset action runs on a dataset')
  ok(dataset.every((a) => !actionApplies(a, 'canvas')),
    'and none of them runs on a spreadsheet — they bind to columns a spreadsheet has not got')
  ok(dataset.every((a) => !actionApplies(a, 'pivot') && !actionApplies(a, '')),
    'nor on a pivot sheet, nor when the grid points at nothing')
  ok(workbook.every((a) => KINDS.every((k) => actionApplies(a, k))),
    'every workbook action runs whatever is on screen')
  ok(dataset.length + workbook.length === ACTION_IDS.length,
    `and between them that is the whole table (${dataset.length} + ${workbook.length} = ${ACTION_IDS.length})`)

  // The two that are easy to get backwards, called out by name. `import-xlsx`
  // ADDS sheets and cannot care what is on screen; `export` (CSV) writes the
  // sheet in front of the reader, and a spreadsheet has no columns to head the
  // file with — docs/dash-sheet-kinds.md §CSV.
  ok(actionApplies('import-xlsx', 'canvas'),
    'Import Excel works from a spreadsheet tab — it adds sheets, it does not read one')
  ok(!actionApplies('export', 'canvas'),
    'Export CSV does not: a CSV needs a header row, and a spreadsheet has no columns')
  ok(actionApplies('dashboard', 'canvas'),
    'the Dashboard is doc.views, so it opens from any tab')
}

// ================================================= not a crash surface

console.log('\nasked about nonsense, it answers rather than throwing')
{
  // main.ts calls this from a click handler. Anything that throws here lands
  // back where this whole rig started: an uncaught error and a blank screen.
  let threw = false
  try {
    actionApplies('chart' as ActionId, 'not-a-kind')
    actionReason('chart' as ActionId, 'not-a-kind')
    actionApplies('no-such-action' as ActionId, 'table')
    actionReason('no-such-action' as ActionId, 'table')
  } catch { threw = true }
  ok(!threw, 'an unknown kind and an unknown action are questions, not exceptions')
  ok(actionApplies('no-such-action' as ActionId, 'canvas'),
    'and an action with no row is left ENABLED — never disable what you cannot explain')
}

// ============================================================

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
