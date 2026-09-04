#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash properties-panel RHYTHM rig — the panel's geometry, as a contract.
//
//   node scripts/test-dash-panelrhythm.ts   (Node ≥ 23.6 strips types natively)
//
// WHY THIS FILE EXISTS AT ALL. The panel's spacing has been reported broken
// three times and reported FIXED twice, and both of those reports were made by
// looking at it. Looking is how a 2px checkbox nudge and a 4px button survive a
// review: nobody can see four pixels in one row, everybody can see them down a
// column of thirty. So the numbers are written down here, once, and a change
// that moves one of them has to come and change it here too — which is the only
// mechanism that makes "it drifted again" a build failure rather than a fourth
// screenshot.
//
// WHAT THIS RIG CAN AND CANNOT SEE. Node has no layout engine: nothing here
// measures a pixel, and a rig that claimed to would be lying (scripts/lib/
// dash-dom.ts says the same about itself in its own header). Real geometry was
// measured in headless Chrome against the built shell while this change was
// made — 26px rows, one label column, one 8px gutter, one 110px control floor,
// across every rule kind of every section, at panel widths 200/240/300/360/440
// and on both sheet kinds. What a rig CAN hold is the two things that produced
// every drift so far:
//
//   1. A SECOND SPELLING OF A MEASUREMENT. Every one of the panel's numbers is
//      a custom property on `.dp-panel`. The drift has never been someone
//      choosing a new rhythm; it has been someone writing `6px` in a new rule
//      because they did not know a token existed. So §2 refuses a px literal
//      wherever a token is the answer, in all four panel stylesheets. This is
//      the check that would have caught all three reports: the checkbox's
//      `margin-bottom: 2px`, the button's `padding: 5px 10px` + `7px` radius,
//      and `.dc-preview`'s `var(--radius, 7px)` were each a local number where
//      a shared one belonged.
//   2. A SECTION THAT BUILDS ITS OWN ROWS. `panels.ts`'s KIT is what makes one
//      change move every section at once, and a section that hand-rolls a
//      `<div>` opts out of it silently and permanently. §3 mounts EVERY section
//      — both sheet kinds, every validation kind, every conditional-formatting
//      kind — and asserts the emitted markup is nothing but KIT parts, and that
//      every row is exactly a label and a control.
//
// And §4 keeps the panel from re-growing the ~90 dead lines it just shed: a
// class this panel styles must be a class some module actually emits.

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHooks } from 'node:module'

// The section modules import their stylesheets, which is Vite's job and not
// Node's — the same stub test-dash-panels.ts uses, for the same reason.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'dash/src')

let checks = 0
let failures = 0
function ok(cond: unknown, what: string) {
  checks++
  if (cond) return
  failures++
  console.log(`  FAIL  ${what}`)
}

/** CSS with every comment removed — a rule and a paragraph ABOUT a rule are not
 *  the same thing, and the dead-class sweep below reads the difference. */
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** The four stylesheets that draw the properties panel. */
const PANEL_CSS = ['panels.css', 'cellprops.css', 'condfmt.css', 'datavalid.css']
const css = Object.fromEntries(
  PANEL_CSS.map((f) => [f, strip(readFileSync(join(srcDir, f), 'utf8'))]),
)

/** `selector { body }` pairs, flat. Good enough: these files nest only in
 *  `@media` / `@container`, whose braces this walker steps over by depth. */
function rules(text: string): Array<{ sel: string; body: string }> {
  const out: Array<{ sel: string; body: string }> = []
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('{', i)
    if (open < 0) break
    const sel = text.slice(i, open).trim().split(/\n\s*\n/).pop()!.trim()
    let depth = 1
    let j = open + 1
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++
      else if (text[j] === '}') depth--
      j++
    }
    const body = text.slice(open + 1, j - 1)
    if (/^@(media|container|supports)/.test(sel)) {
      // step INTO the at-rule; its inner rules are the ones that matter
      out.push(...rules(body))
    } else if (sel && !sel.startsWith('@')) {
      out.push({ sel, body })
    }
    i = j
  }
  return out
}

const allRules = PANEL_CSS.flatMap((f) => rules(css[f]).map((r) => ({ ...r, file: f })))

// ============================================================ 1 · the numbers

console.log('the panel declares its rhythm ONCE, and these are the numbers')

/** The contract. Changing a number here is allowed; changing it ONLY in the
 *  stylesheet is what this rig exists to refuse. */
const TOKENS: Record<string, string> = {
  '--dp-row': '26px',     // the height every single-line control shares
  '--dp-pitch': '8px',    // under every row, note, button and list — slides' .ed-row
  '--dp-gap': '8px',      // label column to control column — slides' .ed-row gap
  '--dp-radius': '6px',   // every control corner and every button's — slides' .ed-row
}

{
  const decls = new Map<string, string[]>()
  for (const { body } of allRules) {
    for (const m of body.matchAll(/(--dp-[a-z-]+)\s*:\s*([^;]+);/g)) {
      decls.set(m[1], [...(decls.get(m[1]) ?? []), m[2].trim()])
    }
  }
  for (const [name, value] of Object.entries(TOKENS)) {
    const got = decls.get(name) ?? []
    ok(got.length === 1, `${name} is declared exactly once (found ${got.length})`)
    ok(got[0] === value, `${name} is ${value}${got[0] && got[0] !== value ? ` — found ${got[0]}` : ''}`)
  }
}

{
  // The section header and the panel padding are slides' numbers too. They are
  // not custom properties (nothing else reads them), so they are pinned here.
  const section = allRules.find((r) => r.sel === '.dp-section')
  ok(/margin:\s*18px 0 8px/.test(section?.body ?? ''),
    'a section header keeps 18px above and 8px below — slides\' .ed-section exactly')
  const panel = allRules.find((r) => r.sel === '.dp-panel')
  ok(/padding:\s*14px/.test(allRules.find((r) => r.sel === '.dp-right')?.body ?? ''),
    'the panel pads at 14px — slides\' .ed-props exactly')
  ok(/min-width:\s*0/.test(panel?.body ?? ''),
    'and floors at 0, so a dragged width is the width it takes '
    + '(MEASURED before this: a 200px drag laid out at 277.4px, a 320px drag at 303.8px)')
}

{
  // The row is a GRID, and that is the one place dash deliberately departs from
  // slides — whose `.ed-row` is a space-between flex that MEASURED 22/25/26/27px
  // rows with the checkbox 91px right of every other control.
  const row = allRules.find((r) => r.sel === '.dp-row')
  ok(/display:\s*grid/.test(row?.body ?? ''), 'a row is a grid, not a space-between flex')
  ok(/min-height:\s*var\(--dp-row\)/.test(row?.body ?? ''), 'every row is at least --dp-row tall')
  ok(/column-gap:\s*var\(--dp-gap\)/.test(row?.body ?? ''), 'and gutters at --dp-gap')
  ok(/margin-bottom:\s*var\(--dp-pitch\)/.test(row?.body ?? ''), 'and leaves --dp-pitch under itself')
}

// ============================================================ 2 · nothing restates them

console.log('\nno rule in the panel spells a shared measurement a second time')

/**
 * Rules that may carry a raw length, PER PROPERTY, with the reason.
 *
 * Per property and not per selector, and that distinction is the whole value of
 * the list: the first version of it exempted `.dp-cf-list` because of its 4px
 * inter-button `gap`, which silently exempted its `margin-bottom` as well — and
 * a negative control proved it, by re-spelling the pitch as 6px in that exact
 * rule and watching this rig pass. An allowlist that forgives more than it was
 * asked to is indistinguishable from no allowlist at all.
 */
const RAW_OK: Array<{ re: RegExp; props: readonly string[] | '*'; why: string }> = [
  { re: /^\.dp-toggle/, props: ['height', 'border-radius'],
    why: 'the resizer chevron is a 16×44 drawer pull, not a row control' },
  { re: /^\.dp-sec-toggle::before/, props: '*',
    why: 'the disclosure triangle is drawn out of borders' },
  { re: /^\.dp-row input\[type='checkbox'\][^ ]*::(before|after)/, props: ['height', 'border-radius'],
    why: 'the 14px tick box inside the field, and the tick knocked out of it' },
  { re: /^\.dp-centre/, props: ['height'], why: 'the centre column is layout, not a control' },
  { re: /^\.dv-|^\.dg-cell/, props: '*',
    why: 'the in-cell dropdown, its menu and its marks are grid furniture, not panel rows' },
  { re: /^\.dp-section$/, props: ['margin-bottom'],
    why: 'the 18/8 section is pinned exactly, by name, in §1' },
]

/**
 * The BOTTOM margin a rule sets, however it spells it.
 *
 * `margin-bottom` and `margin: 0 0 6px` are the same declaration to a browser
 * and were not the same declaration to this rig — a negative control re-spelled
 * the shared pitch as a shorthand in condfmt.css and the check sailed past it.
 * CSS has two ways to say most things and a text rig has to know both.
 */
function bottomMargins(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(/(?:^|[;{\s])margin-bottom\s*:\s*([^;}]+)[;}]?/g)) out.push(m[1].trim())
  for (const m of body.matchAll(/(?:^|[;{\s])margin\s*:\s*([^;}]+)[;}]?/g)) {
    const parts = m[1].trim().split(/\s+(?![^(]*\))/)
    out.push(parts.length >= 3 ? parts[2] : parts[0])
  }
  return out
}
const rawAllowed = (sel: string, prop: string): boolean =>
  RAW_OK.some((x) => x.re.test(sel) && (x.props === '*' || x.props.includes(prop)))

{
  // A control's HEIGHT is --dp-row. Anything else is a second row rhythm.
  const offenders: string[] = []
  for (const { sel, body, file } of allRules) {
    for (const m of body.matchAll(/(?:^|[;\s])(min-height|height)\s*:\s*([^;]+);/g)) {
      if (rawAllowed(sel, 'height')) continue
      const v = m[2].trim()
      if (/^\d/.test(v) && v !== '100%' && v !== 'auto') offenders.push(`${file} ${sel} → ${m[1]}: ${v}`)
    }
  }
  ok(offenders.length === 0,
    `every control height reads --dp-row${offenders.length ? ' — found ' + offenders.join(', ') : ''}`)
}

{
  // The gap UNDER a thing in a section is --dp-pitch, whatever the thing is.
  // MEASURED before this rule existed: rows left 6px, the cf-list 6px, notes
  // 6px and buttons 6px, while the section above them promised 16.
  const offenders: string[] = []
  for (const { sel, body, file } of allRules) {
    if (rawAllowed(sel, 'margin-bottom')) continue
    for (const v of bottomMargins(body)) {
      if (/^\d/.test(v) && v !== '0' && v !== '0px') offenders.push(`${file} ${sel} → ${v}`)
    }
  }
  ok(offenders.length === 0,
    `every gap under a row, note, list or button reads --dp-pitch${offenders.length ? ' — found ' + offenders.join(', ') : ''}`)
}

{
  // One corner for every control in the panel. dash's app-wide --radius is 7px
  // and slides' panel control is 6px; a panel that used both drew a preview at
  // 7 directly under a field at 6.
  const offenders: string[] = []
  for (const { sel, body, file } of allRules) {
    for (const m of body.matchAll(/(?:^|[;\s])border-radius\s*:\s*([^;]+);/g)) {
      if (rawAllowed(sel, 'border-radius')) continue
      const v = m[1].trim()
      if (v !== 'var(--dp-radius)' && v !== '0') offenders.push(`${file} ${sel} → ${v}`)
    }
  }
  ok(offenders.length === 0,
    `every control corner reads --dp-radius${offenders.length ? ' — found ' + offenders.join(', ') : ''}`)
}

// ============================================================ 3 · every section is KIT-built

console.log('\nevery section emits KIT parts and nothing else')

const { installDom } = await import('./lib/dash-dom.ts')
type El = import('./lib/dash-dom.ts').El
const dom = installDom()

const { KIT } = await import('../dash/src/panels.ts')
const { buildAppearanceSection } = await import('../dash/src/cellfmt.ts')
const { buildValidationSection } = await import('../dash/src/datavalid.ts')
const { buildCondFmtSection, blankCondFmtRule, CF_KINDS } = await import('../dash/src/condfmtui.ts')
const { RULE_KINDS } = await import('../dash/src/datavalid.ts')
const { buildCellProps } = await import('../dash/src/cellprops.ts')
const { parseDoc } = await import('../dash/src/model.ts')

const host = (): El => dom.doc.createElement('div') as unknown as El

/**
 * The parts `panels.ts` and its accordion know how to lay out. A section that
 * emits anything else has stepped outside the grid, and no change to the KIT
 * will ever reach it.
 */
const KIT_PARTS = ['dp-section', 'dp-row', 'dp-note', 'dp-btn', 'dp-cf-list', 'dp-empty']

function auditSection(name: string, build: (h: El) => void): void {
  const h = host()
  build(h)
  const strays: string[] = []
  const wideRows: string[] = []
  const inline: string[] = []
  for (const node of h.children) {
    const cls = node.className.split(/\s+/).filter(Boolean)
    if (!cls.some((c) => KIT_PARTS.includes(c))) {
      strays.push(`<${node.tagName.toLowerCase()} class="${node.className}">`)
    }
    if (cls.includes('dp-row')) {
      // A row is exactly a label and a control. A third child is a row that has
      // grown its own layout, and the two-column grid stops describing it.
      if (node.children.length !== 2) {
        wideRows.push(`"${node.children[0]?.textContent ?? '?'}" has ${node.children.length} children`)
      }
    }
    // Geometry in an inline style is geometry the stylesheet cannot retune.
    // READ FROM `node.style`, not from `getAttribute('style')`: dash-dom's El
    // keeps `style` as a plain object and never reflects it into the attribute,
    // so the attribute spelling of this check was inert — a negative control
    // set `.style.marginTop` on a section header and this rig passed.
    const st = Object.entries((node as unknown as { style: Record<string, string> }).style)
      .filter(([k, v]) => typeof v === 'string' && /width|height|margin|padding|gap|top|left/i.test(k))
    if (st.length) inline.push(`${node.className} → ${st.map(([k, v]) => `${k}: ${v}`).join('; ')}`)
    const attr = node.getAttribute('style') ?? ''
    if (/width|height|margin|padding|gap/.test(attr)) inline.push(`${node.className} → ${attr}`)
  }
  ok(strays.length === 0, `${name}: emits only KIT parts${strays.length ? ' — found ' + strays.join(', ') : ''}`)
  ok(wideRows.length === 0, `${name}: every row is a label and one control${wideRows.length ? ' — ' + wideRows.join('; ') : ''}`)
  ok(inline.length === 0, `${name}: sets no geometry inline${inline.length ? ' — ' + inline.join('; ') : ''}`)
}

// --- Appearance, drawn into BOTH panels, so it is audited once for both.
auditSection('Appearance', (h) =>
  buildAppearanceSection({ host: h as never, kit: KIT, cell: undefined, readOnly: false, write: () => {} }))
auditSection('Appearance (all set)', (h) =>
  buildAppearanceSection({
    host: h as never, kit: KIT,
    cell: { bold: true, italic: true, underline: true, wrap: true, align: 'center',
      color: '#112233', bg: '#ffeecc', border: 'trbl', borderColor: '#334455', borderStyle: 'dashed' } as never,
    readOnly: false, write: () => {},
  }))

// --- Validation: EVERY rule kind, on both the dataset and the spreadsheet
//     shape. The kinds differ in which rows they add, and a hand-rolled row
//     would only appear under the one kind that grew it.
// `formula` is not in RULE_KINDS — this build cannot author one — but a file
// can carry one, and the section has an arm that draws it.
for (const kind of [...RULE_KINDS, 'formula'] as const) {
  for (const on of ['warn', 'reject'] as const) {
    auditSection(`Validation ${kind}/${on}`, (h) =>
      buildValidationSection({
        host: h as never, kit: KIT, scope: 'Amount',
        rule: { kind, on, list: ['Open', 'Won'], min: 1, max: 9, formula: 'A1>0', message: 'no' } as never,
        readOnly: false, offenders: { n: 3, capped: false },
        write: () => {},
      }))
  }
}
auditSection('Validation none', (h) =>
  buildValidationSection({ host: h as never, kit: KIT, scope: 'Amount', rule: null, readOnly: false, write: () => {} }))

// --- Conditional formatting: every kind, and the multi-rule state, which is
//     the one that draws the `.dp-cf-list` navigator.
// From condfmtui's OWN factory, so the day a seventh kind lands it is audited
// without anyone editing this file — and so the fixtures are the shape the app
// actually writes rather than the shape a rig author guessed.
const CF_RULES = CF_KINDS.map((k) => blankCondFmtRule(k))
for (const rule of CF_RULES) {
  auditSection(`Conditional formatting ${(rule as { kind: string }).kind}`, (h) =>
    buildCondFmtSection({
      host: h as never, kit: KIT, sheetId: 'sh1', colId: 'amount', scope: 'Amount',
      columns: ['Region', 'Amount'], rules: [rule] as never, readOnly: false,
      write: () => {}, rerender: () => {},
    }))
}
auditSection('Conditional formatting (several rules)', (h) =>
  buildCondFmtSection({
    host: h as never, kit: KIT, sheetId: 'sh1', colId: 'amount', scope: 'Amount',
    columns: ['Region', 'Amount'], rules: CF_RULES as never, readOnly: false,
    write: () => {}, rerender: () => {},
  }))

// --- Cell, on a SPREADSHEET. The dataset's Cell section is built inline in
//     panels.ts's closure and cannot be reached without mounting the whole
//     panel; this is the half that lives in a module of its own.
{
  const { doc } = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 'test',
    sheets: [{ id: 'cv1', name: 'Scratch', kind: 'canvas', cells: { A1: { v: 1234.5 } } }],
  }))
  const sheet = doc.sheets[0]
  for (const [what, fmt] of [['plain', undefined], ['money', '£#,##0.00'], ['percent', '0.0%'], ['text', '@']] as const) {
    auditSection(`Cell (${what})`, (h) => {
      const s = fmt ? { ...sheet, cells: { A1: { v: 1234.5, format: fmt } } } : sheet
      buildCellProps({
        host: h as never, kit: KIT, sheet: s as never,
        ranges: [{ anchor: { row: 0, col: 0 }, head: { row: 0, col: 0 } }] as never,
        cursor: { row: 0, col: 0 }, readOnly: false, locale: 'en-US',
        commit: () => {}, message: '', say: () => {},
      })
    })
  }
  // and with a message, which is the arm that appends a note last
  auditSection('Cell (with a refusal note)', (h) =>
    buildCellProps({
      host: h as never, kit: KIT, sheet: sheet as never,
      ranges: [{ anchor: { row: 0, col: 0 }, head: { row: 0, col: 0 } }] as never,
      cursor: { row: 0, col: 0 }, readOnly: false, locale: 'en-US',
      commit: () => {}, message: '3 values could not be read', say: () => {},
    }))
}

// --- and the KIT's own row, which every one of the above is made of.
{
  const h = host()
  KIT.row(h as never, 'Label', dom.doc.createElement('select') as never)
  KIT.readonlyRow(h as never, 'Label', '42')
  const rows = h.children
  ok(rows.every((r) => r.className.includes('dp-row')), 'kit.row and kit.readonlyRow both build a .dp-row')
  ok(rows.every((r) => r.children.length === 2), 'and both build exactly a label and a control')
  ok(rows[0].tagName === 'LABEL',
    'an editable row is a <label>, so the whole 110×26 field is the hit target and not just the control')
  ok(rows[1].className.includes('dp-row-ro'), 'and a read-only row says so, rather than pretending to be clickable')
  ok(rows[1].children[1].className.includes('dp-value'),
    'a printed figure occupies the control column rather than shrinking to its own digits')
}

// ============================================================ 4 · no dead rules

console.log('\nthe panel styles nothing it does not draw')

{
  // The sheet list left for the tab strip and ~90 lines describing sheet cards,
  // a left panel and a left-hand chevron outlived it — styling markup nothing
  // emits, in the file everyone opens to fix the spacing. Comments are stripped
  // above, so a class NAMED in a paragraph does not count as a class in use.
  const ts = readdirSync(srcDir).filter((f) => f.endsWith('.ts'))
  const code = ts.map((f) => readFileSync(join(srcDir, f), 'utf8')).join('\n')
  const dead: string[] = []
  for (const file of PANEL_CSS) {
    for (const m of new Set(css[file].match(/\.(?:dp|dc)-[a-z0-9-]+/g) ?? [])) {
      const cls = m.slice(1)
      if (!code.includes(cls)) dead.push(`${file} → .${cls}`)
    }
  }
  ok(dead.length === 0, `every .dp-/.dc- class the panel styles is one a module emits${dead.length ? ' — dead: ' + dead.join(', ') : ''}`)
}

{
  // The left panel is gone, so a selector matching "a panel BEFORE a resizer"
  // matches nothing — MEASURED in the built shell, `.dp-panel + .dp-resizer`
  // returned 0 elements while `.dp-resizer:has(+ .dp-panel)` returned 1.
  const wrongWay = allRules.filter((r) => /\.dp-panel[^,{]*\+\s*\.dp-resizer/.test(r.sel))
  ok(wrongWay.length === 0,
    `no rule targets a panel to the LEFT of its resizer${wrongWay.length ? ' — found ' + wrongWay.map((r) => r.sel).join(', ') : ''}`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
