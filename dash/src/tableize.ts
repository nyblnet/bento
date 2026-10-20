// Format as table / Convert to range — the bridge, done in place.
//
// docs/dash-unified.md. The two-kinds design's bridge was a COPY in each
// direction (promote.ts says why: other formulas point into the range by
// position, and nothing could keep them pointing at the right cell). Placement
// removes that reason. A table placed exactly over its old range is read at the
// same addresses (placedsource.ts), so formatting a range as a table can
// CONSUME the range, and converting it back can put every cell where it was.
//
// Both return store PATCHES, so each is one undo step and travels to every
// replica through the ops the sync engine already has (setSheet,
// setCanvasCells, setOverrides). Neither mutates the document it is given.

import { colToLetters, formatRef, mapNames, mapRefs, quoteSheet, sameSheet, type RefUnit } from './a1.ts'
import { recalcWorkbook, workbookSources } from './cellformula.ts'
import type { CanvasCell, CanvasSheet, DashDoc, TableSheet } from './model.ts'
import { judgePlacements, overlaps, placedOn, tableRect, hasTotals, tableRows, type Judged } from './placement.ts'
import { flattenToSpreadsheet, promoteRange, type CellBox, type PromoteFinding } from './promote.ts'
import { recalc } from './formula.ts'
import type { Patch } from './store.ts'
import { mapStructured } from './a1.ts'
import { resolveStructured, tableIndex } from './structured.ts'

const key = (row: number, col: number): string => formatRef({ row, col, absRow: false, absCol: false })

export type TableizeResult =
  | { ok: true; patches: Patch[]; findings: PromoteFinding[]; placed: { on: string; r: number; c: number } }
  | { ok: false; message: string; findings: PromoteFinding[] }

/**
 * Make `box` on grid `gridId` a table, in place.
 *
 * The header comes from the range when it has one; when it does not, the table
 * needs the row ABOVE for its header, and that row must be empty across the
 * table's columns — Excel inserts a row there, which would move cells other
 * formulas point at, so this asks for room instead of making it.
 */
export function formatAsTable(
  doc: DashDoc, gridId: string, box: CellBox,
  opts: { sheetId: string; name: string; header?: boolean | 'auto'; at?: string },
): TableizeResult {
  const grid = doc.sheets.find((s) => s.id === gridId)
  if (!grid || grid.kind !== 'canvas') return { ok: false, findings: [], message: 'Only a range on a sheet can become a table.' }
  const g = grid as CanvasSheet
  const computed = recalcWorkbook(workbookSources(doc)).get(gridId)?.values
  const res = promoteRange({ cells: g.cells, computed }, box, {
    sheetId: opts.sheetId, name: opts.name, header: opts.header ?? 'auto', from: g.name, at: opts.at,
  })
  if (!res.ok) return res
  const { used } = res
  let r = used.top
  if (!res.header) {
    r = used.top - 1
    const free = r >= 0 && Array.from({ length: used.right - used.left + 1 }, (_, i) => used.left + i)
      .every((c) => isBlank(g.cells[key(r, c)]))
    if (!free) {
      return {
        ok: false, findings: res.findings,
        message: 'This range has no header row, and the row above it is not empty. Add a row of column names, or make room above the range.',
      }
    }
  }
  const placed = { on: gridId, r, c: used.left }
  // The table is the range now, not a copy of it: drop the copy's provenance.
  const sheet: TableSheet = { ...res.sheet, steps: [], placed }
  const rect = tableRect(sheet, placed)
  const clash = placedOn(doc, gridId).find((p) => overlaps(p.rect, rect))
  if (clash) {
    return { ok: false, findings: res.findings, message: `That range overlaps the table "${clash.table.name}".` }
  }
  const cleared: Record<string, null> = {}
  for (let row = used.top; row <= used.bottom; row++) {
    for (let col = used.left; col <= used.right; col++) if (g.cells[key(row, col)] !== undefined) cleared[key(row, col)] = null
  }
  const at = doc.sheets.findIndex((s) => s.id === gridId) + 1
  return {
    ok: true,
    findings: res.findings,
    placed,
    patches: [
      { op: 'setSheet', id: sheet.id, sheet, at },
      ...(Object.keys(cleared).length ? [{ op: 'setCanvasCells', sheet: gridId, cells: cleared } as Patch] : []),
    ],
  }
}

const isBlank = (c: CanvasCell | undefined): boolean =>
  !c || ((c.v === undefined || c.v === null || c.v === '') && !c.f)

export type ConvertResult =
  | { ok: true; patches: Patch[]; findings: PromoteFinding[] }
  | { ok: false; message: string }

/**
 * Turn table `tableId` back into plain cells, where it stands — Excel's
 * "Convert to Range".
 *
 * A PLACED table's cells land on its grid at the same addresses, so every
 * `A1` reference into it keeps reading the same cell. An UNPLACED table's own
 * sheet becomes a grid in place (same id, same tab), header in row 1.
 *
 * Every formula elsewhere that named the table is rewritten first, exactly as
 * Excel does: `Sales[Amount]` becomes the cells it meant, and `Sales!B2` — a
 * dataset address, whose row 1 is the first DATA row — becomes the grid
 * address of the same cell. Nothing is left pointing at a table that is gone.
 */
export function convertToRange(doc: DashDoc, tableId: string): ConvertResult {
  const t = doc.sheets.find((s) => s.id === tableId)
  if (!t || t.kind !== 'table') return { ok: false, message: 'That is not a table.' }
  const table = t as TableSheet
  const { honoured } = judgePlacements(doc)
  const placedJ = honoured.get(table.id)
  // Where the cells will land, and what the table looks like from there.
  const hostId = placedJ ? placedJ.at.on : table.id
  const hostName = placedJ ? doc.sheets.find((s) => s.id === placedJ.at.on)!.name : table.name
  const anchor = placedJ ? { r: placedJ.at.r, c: placedJ.at.c } : { r: 0, c: 0 }
  const asPlaced: Judged = placedJ ?? { table, at: { on: table.id, r: 0, c: 0 }, rect: tableRect(table, { r: 0, c: 0 }) }
  const n = tableRows(table)

  // The structured index as it will be: this table placed where its cells land.
  const idx = tableIndex(doc, new Map([...honoured, [table.id, asPlaced]]))
  if (!placedJ) idx.byName.set(table.name.toLowerCase(), { table, placed: asPlaced, host: hostName })

  /** Rewrite one formula on sheet `sheetId` at `row` so nothing names this table. */
  const rewrite = (src: string, sheetId: string, row: number): string => {
    // ORDER MATTERS. `Sales!B2` is a DATASET address (row 1 = first data row);
    // on the grid the same cell is one row below the header, offset by the
    // anchor. This pass runs FIRST, because the structured pass below writes
    // grid addresses — and when the table's own sheet becomes the grid it keeps
    // the table's name, so running this second would shift those again.
    let out = mapRefs(src, (u: RefUnit) => {
      if (!u.sheet || !sameSheet(u.sheet, table.name)) return u.text
      const move = (ref: RefUnit['from']) => formatRef({ ...ref, row: ref.row + anchor.r + 1, col: ref.col + anchor.c })
      const text = u.to ? `${move(u.from)}:${move(u.to)}` : move(u.from)
      return `${quoteSheet(hostName)}!${text}`
    })
    out = mapStructured(out, (tw, spec, text) =>
      tw.toLowerCase() === table.name.toLowerCase()
        ? resolveStructured(idx, tw, spec, { sheetId: sheetId === table.id ? hostId : sheetId, row }) ?? text
        : text)
    return out
  }

  const patches: Patch[] = []
  const findings: PromoteFinding[] = []

  // 1. Every OTHER sheet's formulas.
  for (const s of doc.sheets) {
    if (s.id === table.id) continue
    if (s.kind === 'canvas') {
      const changed: Record<string, CanvasCell> = {}
      for (const [k, cell] of Object.entries((s as CanvasSheet).cells)) {
        if (typeof cell?.f !== 'string') continue
        const row = rowOfKey(k)
        const next = rewrite(cell.f, s.id, row)
        if (next !== cell.f) changed[k] = { ...cell, f: next }
      }
      if (Object.keys(changed).length) patches.push({ op: 'setCanvasCells', sheet: s.id, cells: changed })
    } else if (s.kind === 'table') {
      const ts = s as TableSheet
      const keys: string[] = []
      const v: unknown[] = []
      for (const [k, over] of Object.entries(ts.cells ?? {})) {
        if (typeof over?.f !== 'string') continue
        const next = rewrite(over.f, ts.id, -1)
        if (next !== over.f) { keys.push(k); v.push({ ...over, f: next }) }
      }
      if (keys.length) patches.push({ op: 'setOverrides', sheet: ts.id, keys, v } as unknown as Patch)
    }
  }

  // 2. The table's own cells, flattened, then moved to the anchor.
  const computed = table.columns.some((c) => c.formula) ? recalc(table, doc.modified).values : undefined
  const flat = flattenToSpreadsheet(table, { sheetId: hostId, name: hostName, computed, header: true })
  const cells: Record<string, CanvasCell> = {}
  for (const [k, cell] of Object.entries(flat.sheet.cells)) {
    const pos = posOfKey(k)
    const at = { row: pos.row + anchor.r, col: pos.col + anchor.c }
    const out: CanvasCell = { ...cell }
    if (typeof out.f === 'string') out.f = shiftFormula(rewrite(out.f, table.id, pos.row - 1), anchor.r, anchor.c)
    cells[key(at.row, at.col)] = out
  }
  // A calculated column becomes a formula in every row, as Excel's does — when
  // every name in it is a column of this table. Otherwise its values stand,
  // which flatten already wrote, and its finding says so.
  table.columns.forEach((col, ci) => {
    if (typeof col.formula !== 'string' || !col.formula.trim()) return
    const perRow = columnFormulaToA1(table, col.formula, anchor)
    if (!perRow) return
    for (let r = 0; r < n; r++) {
      const at = key(anchor.r + 1 + r, anchor.c + ci)
      cells[at] = { ...(cells[at] ?? {}), f: perRow(anchor.r + 1 + r) }
      delete cells[at].v
    }
    const h = key(anchor.r, anchor.c + ci)
    if (cells[h]) delete cells[h].note
  })
  // The totals row becomes formulas over the cells above it.
  if (hasTotals(table) && n) {
    const AGG: Record<string, string> = { sum: 'SUM', avg: 'AVERAGE', count: 'COUNT', min: 'MIN', max: 'MAX' }
    table.columns.forEach((col, ci) => {
      const spec = table.totals?.[col.id]
      if (typeof spec !== 'string' || !AGG[spec]) return
      const L = colToLetters(anchor.c + ci)
      cells[key(anchor.r + n + 1, anchor.c + ci)] = { f: `=${AGG[spec]}(${L}${anchor.r + 2}:${L}${anchor.r + n + 1})`, bold: true }
    })
  }
  for (const f of flat.findings) if (f.code !== 'copy-not-move' && f.code !== 'column-formula-flattened') findings.push(f)

  if (placedJ) {
    const host = doc.sheets.find((s) => s.id === hostId) as CanvasSheet
    const hidden = Object.keys(cells).filter((k) => !isBlank(host.cells[k]))
    if (hidden.length) {
      findings.push({
        severity: 'suspicious', code: 'hidden-cells-replaced',
        message: `${hidden.length} cell${hidden.length === 1 ? '' : 's'} hidden under the table ${hidden.length === 1 ? 'was' : 'were'} replaced by the table's own.`,
      })
    }
    patches.push({ op: 'setCanvasCells', sheet: hostId, cells })
    patches.push({ op: 'setSheet', id: table.id })
  } else {
    const at = doc.sheets.findIndex((s) => s.id === table.id)
    const grid: CanvasSheet = { id: table.id, name: table.name, kind: 'canvas', cells, ...(flat.sheet.cols ? { cols: flat.sheet.cols } : {}) }
    patches.push({ op: 'setSheet', id: table.id, sheet: grid, at })
  }
  return { ok: true, patches, findings }
}

/** 0-based row of a grid cell key (A1 spelling). */
function rowOfKey(k: string): number { return posOfKey(k).row }
function posOfKey(k: string): { row: number; col: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(k)
  if (!m) return { row: -1, col: -1 }
  let col = 0
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { row: Number(m[2]) - 1, col: col - 1 }
}

/** Shift every relative reference in a grid formula by (dRow, dCol). */
function shiftFormula(src: string, dRow: number, dCol: number): string {
  if (!dRow && !dCol) return src
  return mapRefs(src, (u) => {
    if (u.sheet) return u.text
    const mv = (r: RefUnit['from']) => formatRef({ ...r, row: r.absRow ? r.row : r.row + dRow, col: r.absCol ? r.col : r.col + dCol })
    return u.to ? `${mv(u.from)}:${mv(u.to)}` : mv(u.from)
  })
}

/**
 * A calculated column's expression (`Amount * Qty`) as an A1 formula for one
 * grid row (`=B3*C3`) — or null when it names anything that is not a column of
 * this table, in which case it cannot stand on a grid by itself.
 */
function columnFormulaToA1(t: TableSheet, expr: string, anchor: { r: number; c: number }): ((row: number) => string) | null {
  const colAt = (name: string): number =>
    t.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase() || c.id === name)
  let unknown = false
  const words = new Set<string>()
  mapNames(expr, (w) => { words.add(w); return w })
  // [Bracketed column] names are copied verbatim by the scanner; find them here.
  for (const m of expr.matchAll(/\[([^\]]+)\]/g)) words.add(`[${m[1]}]`)
  for (const w of words) {
    const name = w.startsWith('[') ? w.slice(1, -1) : w
    if (/^(TRUE|FALSE)$/i.test(name)) continue
    if (colAt(name) < 0) unknown = true
  }
  if (unknown) return null
  return (row: number) => {
    const cell = (name: string) => `${colToLetters(anchor.c + colAt(name))}${row + 1}`
    let out = expr.replace(/\[([^\]]+)\]/g, (_, name: string) => cell(name))
    out = mapNames(out, (w) => (/^(TRUE|FALSE)$/i.test(w) ? w : cell(w)))
    return `=${out}`
  }
}
