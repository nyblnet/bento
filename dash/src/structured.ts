// Structured references — Excel's table syntax, resolved to addresses.
//
// docs/dash-unified.md: one formula language for the grid and its tables.
// `Sales[Amount]` is the whole column, `Sales[@Amount]` this row's value,
// `Sales[#Totals]` the totals row, `Sales[[#Headers],[Amount]]` a header cell,
// `Sales[[Amount]:[Qty]]` a run of columns. The SAME syntax Excel writes, so a
// table's formulas round-trip through .xlsx without translation.
//
// HOW: a structured reference is DESUGARED to an ordinary A1 reference just
// before a formula is bound — the document keeps what the author wrote, and the
// engine only ever sees addresses it already understands. That is what makes a
// table move, grow or rename safe: the desugaring is recomputed from the
// current placement every recalculation, so nothing stored ever goes stale.
//
//   placed table   → the host grid's cells:  Sales[Amount] → 'Grid'!B3:B5
//   unplaced table → its own dataset sheet:  Sales[Amount] → Sales!A1:A3
//                    (a dataset's A1 is its first DATA row; cellformula.ts)
//
// What has no address becomes the honest error rather than a guess: `[@Col]`
// from a row the table does not have is #VALUE! (Excel's implicit-intersection
// miss), a part of a table that does not exist is #REF!.

import { colToLetters, mapStructured, quoteSheet } from './a1.ts'
import type { DashDoc, TableSheet } from './model.ts'
import { hasTotals, tableRows, type Judged } from './placement.ts'

type Item = 'data' | 'headers' | 'totals' | 'all' | 'thisrow'
interface Spec { item: Item; from?: string; to?: string }

const ITEMS: Record<string, Item> = {
  '#data': 'data', '#headers': 'headers', '#totals': 'totals', '#all': 'all', '#this row': 'thisrow',
}

/** `[Amount]` → `Amount`; `Amount` → `Amount`. Excel escapes `]` as `']`. */
const unbracket = (s: string): string => {
  const t = s.trim()
  const inner = t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t
  return inner.replace(/'(.)/g, '$1').trim()
}

/** Split on commas at bracket depth zero. */
function topLevel(spec: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < spec.length; i++) {
    if (spec[i] === '[') depth++
    else if (spec[i] === ']') depth--
    else if (spec[i] === ',' && depth === 0) { out.push(spec.slice(start, i)); start = i + 1 }
  }
  out.push(spec.slice(start))
  return out.map((p) => p.trim()).filter(Boolean)
}

/** The parsed meaning of the text inside a structured reference's brackets. */
export function parseSpec(raw: string): Spec | null {
  const spec = raw.trim()
  if (spec === '') return { item: 'data' }
  // `@Amount` / `@[Amount col]` — this row
  if (spec.startsWith('@')) {
    const col = unbracket(spec.slice(1))
    return col ? { item: 'thisrow', from: col, to: col } : { item: 'thisrow' }
  }
  if (spec.startsWith('#')) {
    const item = ITEMS[spec.toLowerCase()]
    return item ? { item } : null
  }
  if (!spec.startsWith('[')) return { item: 'data', from: spec, to: spec }
  let item: Item = 'data'
  let from: string | undefined
  let to: string | undefined
  for (const part of topLevel(spec)) {
    const inner = unbracket(part.includes(']:[') ? part.slice(0, part.indexOf(']:[') + 1) : part)
    if (inner.startsWith('#')) {
      const it = ITEMS[inner.toLowerCase()]
      if (!it) return null
      item = it
      continue
    }
    if (inner.startsWith('@')) { item = 'thisrow'; from = to = unbracket(inner.slice(1)); continue }
    if (part.includes(']:[')) {
      const at = part.indexOf(']:[')
      from = unbracket(part.slice(0, at + 1))
      to = unbracket(part.slice(at + 2))
    } else {
      from = to = inner
    }
  }
  return { item, from, to }
}

/** Where every table lives, for one recalculation. */
export interface TableIndex {
  byName: Map<string, { table: TableSheet; placed?: Judged; host?: string }>
}

export function tableIndex(doc: DashDoc, honoured: Map<string, Judged>): TableIndex {
  const names = new Map(doc.sheets.map((s) => [s.id, s.name] as const))
  const byName = new Map<string, { table: TableSheet; placed?: Judged; host?: string }>()
  for (const s of doc.sheets) {
    if (s.kind !== 'table') continue
    const placed = honoured.get(s.id)
    byName.set(s.name.toLowerCase(), {
      table: s as TableSheet, placed, host: placed ? names.get(placed.at.on) : undefined,
    })
  }
  return { byName }
}

const AGG: Record<string, string> = { sum: 'SUM', avg: 'AVERAGE', count: 'COUNT', min: 'MIN', max: 'MAX' }

/** Where the formula being resolved sits: its sheet and its 0-based row. */
export interface Site { sheetId: string; row: number }

/** One structured reference → an A1 reference (or an error literal), or null if it is not a table's. */
export function resolveStructured(idx: TableIndex, table: string, rawSpec: string, site: Site): string | null {
  const hit = idx.byName.get(table.toLowerCase())
  if (!hit) return null
  const t = hit.table
  const spec = parseSpec(rawSpec)
  if (!spec) return '#REF!'
  const colIndex = (name: string | undefined): number =>
    name === undefined ? -1 : t.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase() || c.id === name)
  let c0 = 0
  let c1 = t.columns.length - 1
  if (spec.from !== undefined) {
    c0 = colIndex(spec.from)
    c1 = colIndex(spec.to)
    if (c0 < 0 || c1 < 0) return '#REF!'
    if (c1 < c0) [c0, c1] = [c1, c0]
  }
  if (c1 < 0) return '#REF!'
  const n = tableRows(t)

  if (hit.placed && hit.host !== undefined) {
    const { rect, at } = hit.placed
    const sheet = quoteSheet(hit.host)
    const cell = (r: number, c: number) => `${colToLetters(rect.c0 + c)}${r + 1}`
    const range = (r0: number, r1: number) =>
      r0 === r1 && c0 === c1 ? `${sheet}!${cell(r0, c0)}` : `${sheet}!${cell(r0, c0)}:${cell(r1, c1)}`
    switch (spec.item) {
      case 'data': return n ? range(rect.r0 + 1, rect.r0 + n) : '#REF!'
      case 'headers': return range(rect.r0, rect.r0)
      case 'totals': return hasTotals(t) ? range(rect.r0 + n + 1, rect.r0 + n + 1) : '#REF!'
      case 'all': return range(rect.r0, rect.r1)
      case 'thisrow': {
        const inside = site.sheetId === at.on && site.row > rect.r0 && site.row <= rect.r0 + n
        return inside ? range(site.row, site.row) : '#VALUE!'
      }
    }
  }

  // Unplaced: the table's own dataset sheet, whose A1 is its first DATA row.
  const sheet = quoteSheet(t.name)
  const cell = (r: number, c: number) => `${colToLetters(c)}${r + 1}`
  const range = (r0: number, r1: number) =>
    r0 === r1 && c0 === c1 ? `${sheet}!${cell(r0, c0)}` : `${sheet}!${cell(r0, c0)}:${cell(r1, c1)}`
  switch (spec.item) {
    case 'data': return n ? range(0, n - 1) : '#REF!'
    case 'headers':
      // A dataset's header is not a row, so it has no address; one header is
      // still a value — its name — and that is what Excel's cell would hold.
      return c0 === c1 ? JSON.stringify(t.columns[c0].name) : '#REF!'
    case 'totals': {
      // No totals ROW to point at either; one column's total is still its
      // aggregate over the data, computed the way the totals row computes it.
      const op = c0 === c1 ? t.totals?.[t.columns[c0].id] : undefined
      return typeof op === 'string' && AGG[op] && n ? `${AGG[op]}(${range(0, n - 1)})` : '#REF!'
    }
    case 'all': return '#REF!'
    case 'thisrow':
      return site.sheetId === t.id && site.row >= 0 && site.row < n ? range(site.row, site.row) : '#VALUE!'
  }
}

/** Desugar every structured reference in `src`; non-table brackets are left as written. */
export function desugar(idx: TableIndex, src: string, site: Site): string {
  if (!src.includes('[')) return src
  return mapStructured(src, (table, spec, text) => resolveStructured(idx, table, spec, site) ?? text)
}
