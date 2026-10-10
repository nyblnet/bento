#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Every conditional-format rule the ENGINE implements can be REACHED.
//
//   node scripts/test-dash-condfmtui.ts     (Node ≥ 23.6 strips types natively)
//
// WHY THIS EXISTS. `scripts/test-dash-condfmt.ts` proves the engine right, and
// it did: six rule kinds, all correct, all persisted, all painted, all accepted
// by the validator. The application offered TWO of them. A right-click gave
// "Colour scale" and "Data bars" with hardcoded colours, and nothing anywhere
// in `dash/src` constructed a `cellValue`, `topN`, `duplicates` or `formula`
// rule — so "highlight cells greater than 40", the most-used conditional format
// in the world, was missing from a product that had already built it. A rig
// that only tests the engine is exactly how a feature stays invisible while
// every check is green, so this one asserts REACH.
//
// IT DRIVES REAL CONTROLS AND ASSERTS THE RULE OBJECT. The section is built
// with panels.ts's OWN `KIT` — the same `row`, `select`, `text` and `check` the
// panel draws with, not a stand-in — mounted into `scripts/lib/dash-dom.ts`.
// Each check then finds a control by its visible label, changes it, fires the
// event a browser fires, and asserts the rule that reached `write`: the object
// that would be committed into the document. Where the shape of that object
// could still be wrong in a way nobody can see, the rule is handed to the real
// `evaluateRules` and the CELLS it paints are asserted. That is the outcome; a
// count of buttons in a menu is not.
//
// FOUR PROPERTIES:
//
//   1. ALL SIX KINDS ARE REACHABLE, and each one the dropdown builds actually
//      paints something. A dropdown entry that constructs a rule the engine
//      ignores is worse than no entry.
//   2. THE JOB IS DOABLE. "Flag anyone over 40 hours" — end to end, from typing
//      40 into the field to the right rows being coloured. Every row in that
//      sample is also over the rule's DEFAULT operand of 0, so the check is
//      paired with the vacuous pass it would otherwise hide: a section that
//      built the rule and ignored the field colours all five, and that is
//      asserted by name.
//   3. TURNING IT OFF LEAVES THE FILE AS IT WAS. `condfmt` is an additive
//      field: the last rule removed must DROP it, or a rule added and removed
//      leaves a changed workbook that every reader diffs.
//   4. WHAT THIS BUILD CANNOT READ IS OFFERED BACK. A rule kind from a later
//      build keeps its slot and stays selectable, rather than being deleted by
//      a control that could not describe it.
//
// Plus the caller check, which is the one that makes the rest mean anything:
// the cell menu and the panel both have to actually mount this.

import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const { installDom } = await import('./lib/dash-dom.ts')
type El = import('./lib/dash-dom.ts').El
installDom()

const { KIT } = await import('../dash/src/panels.ts')
const {
  CF_KINDS, blankCondFmtRule, buildCondFmtSection, condFmtPatch, readCondFmt, readOperand,
} = await import('../dash/src/condfmtui.ts')
const { evaluateRules } = await import('../dash/src/condfmt.ts')

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/* eslint-disable @typescript-eslint/no-explicit-any */

const doc = (globalThis as any).document

/** Mount the section over a column and hand back the host plus what it wrote. */
function mount(rules: any[], opts: { readOnly?: boolean; columns?: string[] } = {}) {
  const host = doc.createElement('div')
  doc.body.appendChild(host)
  const wrote: any[][] = []
  buildCondFmtSection({
    host: host as any,
    kit: KIT,
    sheetId: 's1',
    colId: 'hours',
    scope: 'Hours',
    columns: opts.columns ?? ['Name', 'Hours', 'Target'],
    rules,
    readOnly: opts.readOnly === true,
    write: (next: any) => wrote.push(next),
    rerender: () => {},
  })
  return { host, wrote, last: () => wrote[wrote.length - 1] }
}

/** The control in the row whose label reads `label` — how a person finds it. */
function control(host: El, label: string): any {
  for (const r of (host as any).querySelectorAll('.dp-row')) {
    if (r.children[0]?.textContent === label) return r.children[1]
  }
  return null
}

const fire = (el: any, type: string): void => el.dispatchEvent({ type })

/** Set a control the way a browser does: value first, then the event. */
function set(el: any, value: string, type = 'change'): void {
  el.value = value
  fire(el, type)
}

console.log('1 · every kind the engine implements is reachable, and paints')
{
  // The sample is chosen so that EVERY kind has something to say about it: a
  // spread for the scale and the bars, a value over 40 for the highlight, a
  // repeat for duplicates, and enough rows for a top-N.
  const sample = [38, 41, 41, 12, 45]
  for (const kind of CF_KINDS) {
    const m = mount([])
    const sel = control(m.host, 'Rule')
    set(sel, kind)
    const rule = m.last()?.[0]
    ok(rule?.kind === kind, `the Rule dropdown builds a ${kind} rule`)
    const painted = evaluateRules([rule], sample).filter(Boolean).length
    ok(painted > 0, `  …and the ${kind} rule it built actually paints cells (${painted} of 5)`)
  }
  // SPELLED OUT, not counted. A check derived from CF_KINDS would shrink with
  // it: deleting four entries would delete four checks and pass. These are the
  // six `condfmt.ts` implements and `validate.ts` accepts, named here so that
  // dropping one is a failure rather than a smaller test run — and read off the
  // DROPDOWN a person sees, not off the constant behind it.
  const offered = control(mount([]).host, 'Rule').children.map((o: any) => o.value)
  ok(['cellValue', 'colorScale', 'dataBar', 'topN', 'duplicates', 'formula']
    .every((k) => offered.includes(k)) && offered.includes('none'),
    'and the dropdown itself offers all six by name, plus "No formatting"')
}

console.log('\n2 · the job: flag anyone over 40 hours')
{
  const m = mount([blankCondFmtRule('cellValue')])
  set(control(m.host, 'Condition'), '>')
  set(control(m.host, 'Value'), '40')
  const rule: any = m.last()[0]
  ok(rule.kind === 'cellValue' && rule.op === '>' && rule.value === 40,
    'typing 40 into the field produces {kind:cellValue, op:">", value:40}')
  ok(typeof rule.value === 'number',
    'and the 40 is stored as a NUMBER, so the document holds a number rather than a numeral')

  const hours = [38, 41, 40, 45, 12]
  const hit = evaluateRules([rule], hours).map((s) => s !== null)
  ok(hit.join() === 'false,true,false,true,false',
    'so the cells over 40 are the ones coloured: 41 and 45, not 40 itself')

  // THE VACUOUS PASS, closed. Every one of those rows is also over the DEFAULT
  // operand of 0, so a section that built the rule and quietly ignored the field
  // would colour all five and the row-count check above would still be reading a
  // rule that works — just not the one that was asked for.
  const untouched = evaluateRules([blankCondFmtRule('cellValue')], hours).map((s) => s !== null)
  ok(untouched.join() === 'true,true,true,true,true',
    'and the 40 is what did it: the untouched default rule colours all five rows')

  ok(readOperand('contains', '40') === '40' && readOperand('>', '40') === 40,
    'a text operator keeps its operand as TEXT, so `contains 40` looks for the characters 4 and 0 ' +
    'rather than storing a number the document would then round-trip as one')
}

console.log('\n3 · duplicates, top-N and formula do the job they were built for')
{
  const dup = blankCondFmtRule('duplicates')
  const names = ['Acme', 'Bolt', ' acme ', 'Cog', '']
  ok(evaluateRules([dup], names).map((s) => s !== null).join() === 'true,false,true,false,false',
    'the duplicates rule the UI builds catches "Acme" and " acme " and leaves the blank alone')

  // TWO EDITS, TWO RENDERS. Each control patches the rule the section was BUILT
  // with, so the second edit has to be made against a section rebuilt from the
  // first write — which is exactly what the panel does on the `doc` event, and
  // asserting it any other way would be asserting a section that never redraws.
  const first = mount([blankCondFmtRule('topN')])
  set(control(first.host, 'How many'), '2')
  ok(first.last()[0].n === 2, 'the count reaches the rule')
  const m = mount(first.last())
  set(control(m.host, 'Which end'), 'bottom')
  const rule: any = m.last()[0]
  ok(rule.kind === 'topN' && rule.n === 2 && rule.bottom === true,
    'and the end does too, without losing the count that was already there')
  ok(evaluateRules([rule], [50, 10, 30, 20]).map((s) => s !== null).join() === 'false,true,false,true',
    'and the bottom 2 of 50, 10, 30, 20 is 10 and 20')

  const f = mount([blankCondFmtRule('formula')])
  set(control(f.host, 'Expression'), 'value > AVERAGE(value)')
  const frule: any = f.last()[0]
  ok(evaluateRules([frule], [1, 2, 30]).map((s) => s !== null).join() === 'false,false,true',
    'and a formula rule colours the row above the column average, in one vectorised pass')
}

console.log('\n4 · turning it off leaves the file as it found it')
{
  const bare: any = { id: 's1', name: 'S', kind: 'table', rids: [], columns: [], data: {}, steps: [] }
  const on = condFmtPatch(bare, 'hours', [blankCondFmtRule('duplicates')])
  ok((on.props as any).condfmt.hours.length === 1, 'adding a rule writes it under the column id')

  const withRule = { ...bare, condfmt: (on.props as any).condfmt }
  const off = condFmtPatch(withRule as any, 'hours', [])
  ok(off.drop?.includes('condfmt') && !('condfmt' in off.props),
    'removing the last rule DROPS condfmt — an additive field meaning "none" has to be absent')
  ok(!/undefined/.test(JSON.stringify(off)),
    'and it is dropped by NAME, not by setting the key undefined, which JSON.stringify erases')

  const two = { ...bare, condfmt: { hours: [blankCondFmtRule('duplicates')], pay: [blankCondFmtRule('dataBar')] } }
  const one = condFmtPatch(two as any, 'hours', [])
  ok(!('hours' in (one.props as any).condfmt) && 'pay' in (one.props as any).condfmt,
    'clearing one column leaves another column’s rules alone')
  ok(readCondFmt(two as any, 'pay').length === 1 && readCondFmt(bare, 'pay').length === 0,
    'and reading a column with no rules is an empty list, not a throw')
}

console.log('\n5 · a rule this build cannot read is offered back, not deleted')
{
  const later: any = { kind: 'iconSet', icons: 'arrows' }
  const m = mount([later])
  const sel = control(m.host, 'Rule')
  const values = sel.children.map((o: any) => o.value)
  ok(values.includes('iconSet'),
    'an unknown kind keeps its own entry in the dropdown, so it can be selected back to')
  ok(sel.children.find((o: any) => o.selected)?.value === 'iconSet' && m.wrote.length === 0,
    'it is the option that is SELECTED, and merely drawing the section rewrites nothing')
  ok((m.host as any).querySelectorAll('.dp-note').some((p: any) => /later build/.test(p.textContent)),
    'the section says where it came from rather than showing empty controls')
}

console.log('\n6 · read-only means read-only')
{
  const m = mount([blankCondFmtRule('cellValue')], { readOnly: true })
  ok(control(m.host, 'Rule').disabled === true && control(m.host, 'Value').disabled === true,
    'every control is disabled on a reader copy')
  const val = control(m.host, 'Value')
  val.value = '99'
  fire(val, 'change')
  ok(m.wrote.length === 0, 'and a value forced into a field anyway writes nothing')
}

console.log('\n7 · the callers mount it')
{
  // The checks above all hold of a section nobody builds. These two are what
  // make the feature exist on screen.
  // gridmenu.ts, not main.ts: the grid's context menus moved out of the boot
  // file so that a rig can drive a real right-click at them
  // (scripts/test-dash-menu.ts). This check stays a source read because what it
  // is about is the RULE-WRITING code, which that rig does not duplicate.
  const main = readFileSync(new URL('../dash/src/gridmenu.ts', import.meta.url), 'utf8')
  const panels = readFileSync(new URL('../dash/src/panels.ts', import.meta.url), 'utf8')
  ok(/buildCondFmtColumnSection\(sheet\)/.test(panels) && /buildCondFmtSection\(\{/.test(panels),
    'the properties panel builds the section for the selected column')
  ok(/data-a="cf-gt"/.test(main) && /data-a="cf-dup"/.test(main) && /data-a="cf-more"/.test(main),
    'the cell menu offers greater-than, duplicates, and the way through to the rest')
  ok(!/kind: 'colorScale', colors:/.test(main) && !/kind: 'dataBar', color:/.test(main),
    'and the menu’s two presets go through blankCondFmtRule rather than a second set of literals')
}

console.log('\na malformed rule loses its rule, not the whole panel')
{
  // Found by the panel-rhythm work while auditing sections, and it is a crash
  // rather than a blemish: `rule.colors[2]` on a colorScale with no `colors`
  // threw out of `buildCondFmtSection`, so the properties panel went blank for
  // the SHEET, not just for the rule.
  //
  // `blankCondFmtRule` always writes the array, so nothing this app creates can
  // reach it — which is exactly why it survived. The format is additive and
  // PLATFORM §7 makes hand-edited and model-generated JSON a first-class way
  // in, so "we always write it" is not "it is always there". And the panel is
  // where somebody would go to REPAIR the rule, which makes losing the panel
  // the worst available answer to a malformed one.
  const bad = [
    ['colorScale with no colors at all', { kind: 'colorScale' }],
    ['colorScale with colors set to null', { kind: 'colorScale', colors: null }],
    ['colorScale with a one-entry array', { kind: 'colorScale', colors: ['#fff'] }],
  ] as Array<[string, unknown]>
  for (const [what, rule] of bad) {
    let threw: string | null = null
    try {
      const host = doc.createElement('div')
      buildCondFmtSection({
        host, kit: KIT, rules: [rule], readOnly: false, scope: 'A1:A9',
        sheetId: 's1', colId: 'c', write: () => {},
      } as never)
    } catch (e) { threw = e instanceof Error ? e.message : String(e) }
    ok(threw === null, `${what} builds a section instead of throwing${threw ? ` (${threw})` : ''}`)
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
