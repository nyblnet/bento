#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash date values in an OLDER dash — the format-additivity half of
// test-dash-dates.ts.
//
//   node scripts/test-dash-dates-oldshell.ts
//
// THE QUESTION. A file saved by this build carries date and time values an
// older build has never produced: `2026-03-04 14:30` with `yyyy-mm-dd hh:mm`,
// `14:30:15` with `hh:mm:ss`, a dataset date column holding times of day. A
// file travels and an older copy of dash will open it (PLATFORM §3: there is
// no server to migrate anything). It must not CORRUPT them — not repair them
// at parse, not rewrite them on save, not turn them into something else when
// somebody opens the cell and presses Enter, not crash recalculating them.
//
// THE OLD CODE IS THE REAL OLD CODE, not a reconstruction: `git archive` of
// dash/src and kernel/src at two pinned points, imported by Node directly —
//
//   dash-v0.2.0   the oldest tagged dash milestone
//   OLD_MAIN      main as this change branched from it (dash 0.3.0), the build
//                 every current file was written by
//
// Either ref is fetched (depth 1) when the clone does not have it, which is
// the CI case. A ref that cannot be had is a FAILURE, never a skip: a rig that
// passes because it could not find the old code proves nothing.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const ROOT = resolve(import.meta.dirname, '..')
const OLD_MAIN = '1d063726da1e38753080785bca80edd2eef2b631'
const REFS: Array<{ name: string; ref: string; fetch: string[] }> = [
  { name: 'dash-v0.2.0', ref: 'refs/tags/dash-v0.2.0', fetch: ['tag', 'dash-v0.2.0'] },
  { name: 'main@1d063726 (dash 0.3.0)', ref: OLD_MAIN, fetch: [OLD_MAIN] },
]

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const git = (...args: string[]) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const has = (ref: string): boolean => { try { git('cat-file', '-e', `${ref}^{commit}`); return true } catch { return false } }

/** Extract dash/src + kernel/src at `ref` into a fresh directory. */
function extract(r: typeof REFS[number]): string | null {
  if (!has(r.ref)) {
    try { git('fetch', '--depth=1', 'origin', ...r.fetch) } catch (e) {
      console.log(`  (fetch of ${r.name} failed: ${String((e as Error).message).split('\n')[0]})`)
    }
  }
  if (!has(r.ref)) return null
  const dir = mkdtempSync(join(tmpdir(), 'dash-old-'))
  mkdirSync(dir, { recursive: true })
  execFileSync('sh', ['-c', `git -C "$1" archive "$2" dash/src kernel/src | tar -x -C "$3"`, 'sh', ROOT, r.ref, dir])
  return dir
}

// ------------------------------------------------- the file THIS build writes
const { installDom } = await import('./lib/dash-dom.ts')
installDom()
const NEW_GRID = await import('../dash/src/grid.ts')
const { cellKey } = await import('../dash/src/cellformula.ts')
const { parseRef } = await import('../dash/src/a1.ts')
type CanvasCell = import('../dash/src/model.ts').CanvasCell

const typed: Record<string, string> = {
  A1: '2026-03-04', A2: '2026-03-04 14:30', A3: '2026-03-04 14:30:15', A4: '14:30',
  A5: '14:30:15', A6: '2:30 PM', A7: '3/4/2026', A8: 'Mar 4 2026 9:05',
  B1: '=A1+1', B2: '=A2-A1', B3: '=TEXT(A1,"dd mmm yyyy")', B4: '=NOW()', B5: '=NETWORKDAYS(A1,A1+7)',
}
const cells: Record<string, CanvasCell> = {}
for (const [a1, s] of Object.entries(typed)) {
  const p = parseRef(a1)!
  const c = NEW_GRID.canvasCellEdit(undefined, s)
  if (c) cells[cellKey(p.row, p.col)] = c
}
// a Date-and-time cell with a pattern no older build offers
cells[cellKey(8, 0)] = { v: '2026-12-31 23:59', format: 'd mmm yyyy h:mm AM/PM' }
const doc = {
  format: 'bento/dash', version: 1, policy: 'bento-dash-1',
  docId: 'old-shell-dates', title: 'Dates for an old shell',
  created: '2026-11-07T00:00:00.000Z', modified: '2026-11-07T12:00:00.000Z',
  sheets: [
    { id: 'grid', name: 'Grid', kind: 'canvas', cells },
    {
      id: 'tab', name: 'Log', kind: 'table', rids: [[1, 3]],
      columns: [{ id: 'what', name: 'What', type: 'text' }, { id: 'at', name: 'At', type: 'date' }],
      data: {
        what: { enc: 'raw', v: ['a', 'b', 'c'] },
        at: { enc: 'raw', v: ['2026-03-04 14:30', '2026-03-04T09:05:00', '2026-03-04'] },
      },
      steps: [],
    },
  ],
}
const json = JSON.stringify(doc)
const newValues = (Object.values(cells) as CanvasCell[]).filter((c) => c.v !== undefined)
ok(newValues.some((c) => c.format === 'yyyy-mm-dd hh:mm') && newValues.some((c) => c.format === 'hh:mm:ss'),
  'the fixture carries the NEW values (a datetime and a seconds time), so the rows below test something')

for (const r of REFS) {
  console.log(`\n${r.name}`)
  const dir = extract(r)
  ok(dir !== null, `the old code is here to test against (${r.ref})`)
  if (!dir) continue
  const mod = async (p: string) => import(pathToFileURL(join(dir, 'dash/src', p)).href)
  const M = await mod('model.ts')

  // 1. parse: no repair touches a cell, and every value and format arrives as written
  const parsed = M.parseDoc(json)
  ok(parsed.ok === true, 'the old build opens the file')
  if (!parsed.ok) continue
  const grid = parsed.doc.sheets.find((s: { id: string }) => s.id === 'grid')
  ok(JSON.stringify(grid?.cells) === JSON.stringify(cells), 'every grid cell arrives exactly as written')
  const tab = parsed.doc.sheets.find((s: { id: string }) => s.id === 'tab')
  ok(JSON.stringify(tab?.data?.at) === JSON.stringify(doc.sheets[1].data!.at), 'the dataset’s datetimes arrive exactly as written')
  ok(!(parsed.repairs ?? []).length, `parse reports no repair   (got ${JSON.stringify(parsed.repairs ?? [])})`)

  // 2. save: what it writes back holds the same cells
  const saved = M.parseDoc(JSON.stringify(parsed.doc))
  ok(saved.ok && JSON.stringify(saved.doc.sheets) === JSON.stringify(parsed.doc.sheets), 'and saves them back unchanged')

  // 3. the cell editor, where an old build has one: open each cell and press Enter
  const G = await mod('grid.ts').catch(() => null)
  const CPm = await mod('cellprops.ts').catch(() => null)
  if (G?.canvasCellEdit && CPm?.enteredForm) {
    let same = 0
    let total = 0
    const changed: string[] = []
    for (const [k, c] of Object.entries(cells)) {
      if (c.f !== undefined) continue
      total++
      const back = G.canvasCellEdit(c, CPm.enteredForm(c))
      if (back?.v === c.v && back?.format === c.format && back?.f === undefined) same++
      else changed.push(`${k}: ${JSON.stringify(c)} → ${JSON.stringify(back)}`)
    }
    ok(same === total, `opening each value cell and pressing Enter leaves all ${total} unchanged   ${changed.join('; ')}`)
    // and what it SHOWS is the readable moment, not a number — the reason the
    // value stays ISO text rather than becoming Excel's serial
    if (G.canvasShown) {
      const unreadable = Object.entries(cells)
        .filter(([, c]) => c.f === undefined && typeof c.v === 'string')
        .filter(([, c]) => G.canvasShown(c, c.v) !== c.v)
        .map(([k, c]) => `${k}: ${JSON.stringify(c.v)} shows ${JSON.stringify(G.canvasShown(c, c.v))}`)
      const values = Object.values(cells).filter((c) => c.f === undefined)
      ok(values.every((c) => typeof c.v === 'string') && unreadable.length === 0,
        `every date and time shows as its own readable text there   ${unreadable.join('; ')}`)
    }
    // and the edit actually goes through the old store and out to the file
    const S = await mod('store.ts')
    const store = new S.Store(parsed.doc)
    store.commit({ op: 'setCanvasCells', sheet: 'grid', cells: { [cellKey(20, 0)]: G.canvasCellEdit(undefined, 'note') } })
    const after = store.doc.sheets.find((s: { id: string }) => s.id === 'grid').cells
    const kept = Object.keys(cells).every((k) => JSON.stringify(after[k]) === JSON.stringify(cells[k]))
    ok(kept, 'an edit elsewhere in the old build leaves every date cell byte-identical')
  } else {
    console.log('  (this build has no spreadsheet cell editor — parse and save are what it can do to the file)')
    ok(G !== null && !G.canvasCellEdit, 'and that is because it has none, not because the import failed')
  }

  // 4. recalculation does not throw on the new values (the answers may be #VALUE!
  //    there — it has no date arithmetic — but no answer is ever stored)
  const CF = await mod('cellformula.ts').catch(() => null)
  if (CF?.recalcCells && CF?.canvasCellSource) {
    let threw = ''
    try { CF.recalcCells(CF.canvasCellSource({ cells }), doc.modified) } catch (e) { threw = String(e) }
    ok(threw === '', `the old recalculation runs over the new values without throwing ${threw}`)
    ok(Object.values(cells).every((c) => c.f === undefined || c.v === undefined),
      'and no formula cell carries a stored result an old build could disagree with')
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) {
  console.log(`${failures} FAILED`)
  process.exit(1)
}
