// Linked records, lookups and rollups — the relational half of the Airtable layer.
//
// docs/dash-unified.md. A `link` column holds, per row, an ARRAY of rids in
// the table it points `to`, stored in the existing `raw` encoding. Its mirror on
// the target table (`inverseOf`) stores NOTHING: it is derived from the owner on
// every read, because two stored sides can disagree after a merge and one
// cannot. A `lookup` follows a link and reads a column there; a `rollup` folds
// what it reads into one value.
//
// Everything here is pure — no store, no DOM — so the grid, the formula engine,
// the exporters and the rigs all read links through the same answers.

import type { Cell, Vec } from './formula.ts'
import { isErr, recalc } from './formula.ts'
import type { Column, DashDoc, RollupAgg, TableSheet } from './model.ts'
import { readCell, type Patch } from './store.ts'
import { formatValue } from './format.ts'

const tableOf = (doc: DashDoc, id: string | undefined): TableSheet | undefined => {
  const s = id ? doc.sheets.find((x) => x.id === id) : undefined
  return s && s.kind === 'table' ? (s as TableSheet) : undefined
}

const rowsOf = (t: TableSheet): number => t.rids.reduce((n, [, k]) => n + k, 0)

/** The rid at a row position. */
export function ridAt(t: TableSheet, row: number): number {
  let i = row
  for (const [start, count] of t.rids) {
    if (i < count) return start + i
    i -= count
  }
  return -1
}

/** The row position of a rid, or -1. */
export function rowOf(t: TableSheet, rid: number): number {
  let base = 0
  for (const [start, count] of t.rids) {
    if (rid >= start && rid < start + count) return base + (rid - start)
    base += count
  }
  return -1
}

/** A stored link cell as rids — tolerant of a lone number and of junk. */
export function ridsIn(v: unknown): number[] {
  const list = Array.isArray(v) ? v : v == null || v === '' ? [] : [v]
  const out: number[] = []
  for (const x of list) {
    const n = typeof x === 'number' ? x : Number(x)
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n)
  }
  return out
}

/** What a linked row is called: its first column's value, as that column shows it. */
export function rowLabel(t: TableSheet, rid: number): string {
  const row = rowOf(t, rid)
  const col = t.columns[0]
  if (row < 0 || !col) return ''
  return formatValue(readCell(t.data[col.id], row), col)
}

/** Why a column of the Airtable layer cannot be computed — for the validator and the panel. */
export type LinkProblem =
  | { col: string; code: 'no-target' }          // link `to` names no table
  | { col: string; code: 'no-owner' }           // inverseOf names no link column
  | { col: string; code: 'via-not-link' }       // lookup/rollup `via` is not a link here
  | { col: string; code: 'no-field' }           // `field` is not a column of the linked table
  | { col: string; code: 'cycle' }              // lookups that read each other

/** The table a link-shaped column (owner or inverse) points into. */
export function linkTarget(doc: DashDoc, _t: TableSheet, col: Column): TableSheet | undefined {
  if (col.kind !== 'link') return undefined
  if (col.inverseOf) return tableOf(doc, col.inverseOf.table)
  return tableOf(doc, col.to)
}

/**
 * Every row's linked rids for a link column — read from storage for an owner,
 * DERIVED for an inverse: target row r lists every owner row whose cell
 * contains r's rid, in owner row order (deterministic on every replica).
 */
export function linkRids(doc: DashDoc, t: TableSheet, col: Column): number[][] {
  const n = rowsOf(t)
  if (col.kind !== 'link') return Array.from({ length: n }, () => [])
  if (!col.inverseOf) return Array.from({ length: n }, (_, r) => ridsIn(readCell(t.data[col.id], r)))
  const owner = tableOf(doc, col.inverseOf.table)
  const ownerCol = owner?.columns.find((c) => c.id === col.inverseOf!.col)
  const out: number[][] = Array.from({ length: n }, () => [])
  if (!owner || !ownerCol || ownerCol.kind !== 'link' || ownerCol.to !== t.id) return out
  const on = rowsOf(owner)
  for (let r = 0; r < on; r++) {
    const ownerRid = ridAt(owner, r)
    for (const rid of ridsIn(readCell(owner.data[ownerCol.id], r))) {
      const at = rowOf(t, rid)
      if (at >= 0 && !out[at].includes(ownerRid)) out[at].push(ownerRid)
    }
  }
  return out
}

/** Fold linked values the way Airtable's rollup does. */
export function fold(agg: RollupAgg, values: Cell[]): Cell {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  switch (agg) {
    case 'sum': return nums.reduce((a, b) => a + b, 0)
    case 'avg': return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null
    case 'min': return nums.length ? Math.min(...nums) : null
    case 'max': return nums.length ? Math.max(...nums) : null
    case 'count': return nums.length
    case 'counta': return values.filter((v) => v !== null && v !== '').length
    case 'concat': return values.filter((v) => v !== null && v !== '').map(String).join(', ')
    // Empty values are skipped, as Airtable's AND/OR skip them: an order with
    // no rating has not voted "false".
    case 'and': return values.filter((v) => v !== null && v !== '').every(Boolean)
    case 'or': return values.filter((v) => v !== null && v !== '').some(Boolean)
  }
  return null
}

/**
 * Display/compute vectors for every column of `t` this layer owns: links (as
 * their rows' labels), lookups (the linked values, joined) and rollups (folded).
 *
 * A lookup may read a computed column, or another lookup or rollup — so values
 * are resolved through `valuesOf`, which recalculates formula columns and
 * recurses into derived ones with a guard: a chain of lookups that comes back
 * to itself is a cycle, and reads as an error rather than looping.
 */
export function derivedVectors(doc: DashDoc, t: TableSheet): { vectors: Map<string, Vec>; problems: LinkProblem[] } {
  const problems: LinkProblem[] = []
  const vectors = new Map<string, Vec>()
  const formulaMemo = new Map<string, Map<string, Vec>>()
  const derivedMemo = new Map<string, Vec>()
  const visiting = new Set<string>()

  const valuesOf = (table: TableSheet, colId: string): Vec | null => {
    const col = table.columns.find((c) => c.id === colId)
    if (!col) return null
    const n = rowsOf(table)
    if (col.kind === 'link' || col.kind === 'lookup' || col.kind === 'rollup') {
      const k = `${table.id}\u001f${col.id}`
      const hit = derivedMemo.get(k)
      if (hit) return hit
      if (visiting.has(k)) return null
      visiting.add(k)
      const v = derive(table, col)
      visiting.delete(k)
      if (v) derivedMemo.set(k, v)
      return v
    }
    if (col.formula) {
      let m = formulaMemo.get(table.id)
      if (!m) { m = recalc(table, doc.modified).values as Map<string, Vec>; formulaMemo.set(table.id, m) }
      return m.get(col.id) ?? Array(n).fill(null)
    }
    return Array.from({ length: n }, (_, r) => readCell(table.data[col.id], r) as Cell)
  }

  const derive = (table: TableSheet, col: Column): Vec | null => {
    const n = rowsOf(table)
    if (col.kind === 'link') {
      const target = linkTarget(doc, table, col)
      if (!target) return Array(n).fill(null)
      return linkRids(doc, table, col).map((rids) => rids.map((rid) => rowLabel(target, rid)).filter(Boolean).join(', ') || null)
    }
    const via = table.columns.find((c) => c.id === col.via)
    const target = via ? linkTarget(doc, table, via) : undefined
    if (!via || !target) return Array(n).fill(null)
    const fieldCol = target.columns.find((c) => c.id === col.field)
    if (!fieldCol) return Array(n).fill(null)
    const source = valuesOf(target, fieldCol.id)
    if (!source) return null // cycle
    const links = linkRids(doc, table, via)
    return links.map((rids) => {
      const vals = rids.map((rid) => source[rowOf(target, rid)] ?? null).filter((v) => !isErr(v))
      if (col.kind === 'rollup') return fold(col.agg ?? 'sum', vals as Cell[])
      return vals.filter((v) => v !== null && v !== '').map((v) => formatValue(v, fieldCol)).join(', ') || null
    })
  }

  for (const col of t.columns) {
    if (col.kind === 'link') {
      if (!linkTarget(doc, t, col)) problems.push({ col: col.id, code: col.inverseOf ? 'no-owner' : 'no-target' })
    } else if (col.kind === 'lookup' || col.kind === 'rollup') {
      const via = t.columns.find((c) => c.id === col.via)
      const target = via ? linkTarget(doc, t, via) : undefined
      if (!via || via.kind !== 'link' || !target) { problems.push({ col: col.id, code: 'via-not-link' }) }
      else if (!target.columns.some((c) => c.id === col.field)) problems.push({ col: col.id, code: 'no-field' })
    } else continue
    const v = valuesOf(t, col.id)
    if (v) vectors.set(col.id, v)
    else {
      problems.push({ col: col.id, code: 'cycle' })
      vectors.set(col.id, Array(rowsOf(t)).fill(null))
    }
  }
  return { vectors, problems }
}

/**
 * The patches that make row `rid` of `t` link to exactly `next` through `col`.
 *
 * On an OWNER column that is one cell. On an INVERSE column it is the owner
 * rows that gain or lose this rid — the only stored side — so editing either
 * side of a link writes the same thing and the two can never disagree.
 */
export function setLinkPatches(doc: DashDoc, t: TableSheet, col: Column, rid: number, next: number[]): Patch[] {
  const want = ridsIn(next)
  if (col.kind !== 'link') return []
  if (!col.inverseOf) {
    return [{ op: 'setCells', sheet: t.id, col: col.id, rids: [rid], v: [want.length ? want : null] }]
  }
  const owner = tableOf(doc, col.inverseOf.table)
  const ownerCol = owner?.columns.find((c) => c.id === col.inverseOf!.col)
  if (!owner || !ownerCol) return []
  const have = linkRids(doc, t, col)[rowOf(t, rid)] ?? []
  const rids: number[] = []
  const v: unknown[] = []
  for (const ownerRid of new Set([...have, ...want])) {
    const r = rowOf(owner, ownerRid)
    if (r < 0) continue
    const cur = ridsIn(readCell(owner.data[ownerCol.id], r))
    const on = want.includes(ownerRid)
    const nextCell = on ? (cur.includes(rid) ? cur : [...cur, rid]) : cur.filter((x) => x !== rid)
    if (nextCell.length === cur.length && nextCell.every((x, i) => x === cur[i])) continue
    rids.push(ownerRid)
    v.push(nextCell.length ? nextCell : null)
  }
  return rids.length ? [{ op: 'setCells', sheet: owner.id, col: ownerCol.id, rids, v }] : []
}
