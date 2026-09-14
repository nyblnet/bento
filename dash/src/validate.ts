// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Document validation — `window.bento.validate()`.
//
// WHY THIS EXISTS. The DOCUMENT is the interchange unit (PLATFORM §7): a chat
// model hands back edited JSON, `parseDoc` accepts it, `store.replaceDoc` loads
// it, and a workbook that is merely INCONSISTENT then fails somewhere a long way
// from the cause — a total that is off by one row, a chart with no bars, a hand
// correction that never appears. `parseDoc` answers "is this a bento/dash
// document at all"; this answers "does it agree with itself", which is a
// different question and the one nobody can answer by looking.
//
// THE COLUMNAR FAILURE IS THE ONE THAT MATTERS, and it has no symptom. Values
// live in `data[colId]` as a bare array; rows live in `rids` as run lengths;
// nothing joins them but POSITION. A column one entry short does not error, does
// not render blank, and does not look wrong: every value below the missing one
// belongs to the row above it. The invoice total is now on the wrong customer
// and the file is internally plausible. Slides can afford to validate style;
// here the first check has to be arithmetic.
//
// FINDINGS, NOT EXCEPTIONS. Every finding carries a `code`, a `message` that
// names WHERE, and a severity — the same shape `import.ts` produces and the
// xlsx importer deliberately matches, so `showFindings` renders all three
// without a translation layer. Nothing here throws and nothing here MUTATES: a
// validator that repaired what it found would be a second, unreviewed parser,
// and the two would disagree about a file on some Tuesday. It reports; the
// caller decides.
//
// THE SEVERITIES ARE A DECISION, not a mood ring:
//
//   fatal        loading this loses or corrupts data. A column whose length
//                disagrees with the sheet, a dictionary index pointing past its
//                dictionary, a rid minted twice, a watermark that will hand a
//                live row's identity to a future insert.
//   repairable   `parseDoc` already fixes this on the way in (duplicate ids, a
//                missing docId), so it is reported as REPAIRED rather than as an
//                error — except in a FROZEN document, where the repair is
//                deliberately disabled and the damage stands.
//   suspicious   legal, loads fine, almost certainly a mistake: a tile bound to
//                a column that was deleted, a formula naming nothing, an
//                override keyed to a row that no longer exists.
//
// WHAT IS DELIBERATELY NOT CHECKED: anything a future build might legitimately
// write. An unknown sheet kind, an unknown column encoding, an unknown transform
// op and an unknown conditional-format rule are all ADDITIVE (PLATFORM §3) —
// they round-trip untouched by design, and reporting them as damage would teach
// authors to delete the parts of their file this build is too old to read.

import {
  FORMAT, FORMAT_VERSION, CANVAS_CELL_MAX,
  type CanvasSheet, type Column, type ColumnData, type DashDoc,
  type PivotSheet, type Sheet, type TableSheet,
} from './model.ts'
import { FUNCTIONS, dependencies } from './formula.ts'
import { mapRefs, parseRef, type CellRef, type RefUnit } from './a1.ts'

export type Severity = 'fatal' | 'repairable' | 'suspicious'

export interface Finding {
  /** stable machine-readable code, e.g. 'column-length' */
  code: string
  severity: Severity
  /** one line, written to be actionable on its own — it must name WHERE */
  message: string
  /** sheet id, when the finding belongs to a sheet */
  sheet?: string
  /** column id, when it belongs to a column */
  column?: string
  /** row identity, when one row is at fault */
  rid?: number
  /** where else in the document: 'views[0].tiles[2]', 'story.steps[1]' */
  path?: string
}

export interface ValidateResult {
  /** no fatal findings. Repairable and suspicious ones still load. */
  ok: boolean
  counts: Record<Severity, number>
  findings: Finding[]
}

// --- small guards ------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** A quoted name, for a message a person has to read. */
const q = (s: unknown): string => `"${String(s)}"`

/** Aggregates like "3 rows (2, 5, 9)" without ever printing 100,000 of them. */
const some = (xs: Array<string | number>, max = 5): string =>
  xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')}, …`

// --- names formulas can resolve ----------------------------------------------

/** Every function name this build implements, uppercased once. */
const KNOWN_FN = new Set(FUNCTIONS.map((f) => f.toUpperCase()))

/**
 * A call name that is not a function is `#NAME?` for every row — a whole column
 * of visible errors, and the single most common thing an AI-authored formula
 * gets wrong (a plausible Excel function this build does not have).
 *
 * String literals and [bracketed names] are blanked first: `="SUM("` is a label
 * somebody wrote, and a column called `Rate` is not a call whatever follows it.
 */
const CALL_RE = /([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g
function unknownCalls(src: string): string[] {
  const bare = src.replace(/"(?:[^"]|"")*"/g, '""').replace(/\[[^\]]*\]/g, '[]')
  const out: string[] = []
  for (const m of bare.matchAll(CALL_RE)) {
    const name = m[1].toUpperCase()
    if (!KNOWN_FN.has(name) && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

/**
 * The names `recalc` will bind for this sheet: every column's id AND its name,
 * matched case-insensitively (formula.ts `recalc` puts both, and `evalNode`
 * retries lowercased).
 */
function columnKeys(sheet: TableSheet): Set<string> {
  const out = new Set<string>()
  for (const c of arr(sheet.columns) as Column[]) {
    if (!isObj(c)) continue
    if (typeof c.id === 'string') out.add(c.id.toLowerCase())
    if (typeof c.name === 'string') out.add(c.name.toLowerCase())
  }
  return out
}

/**
 * The generated name a bound A1 reference stands in as.
 *
 * `dependencies()` cannot tell `[Q1]` (a column called Q1) from `Q1` (the cell
 * in column Q) — the brackets are gone by the time it sees a `ref` node. So
 * cell formulas are pre-walked with a1.ts's OWN scanner, the same one
 * cellformula.ts binds through, and only what that scanner calls a reference is
 * treated as one. A second definition of "what is a reference" is how the
 * validator ends up disagreeing with the engine.
 */
const A1_BOUND = '_a1_bound'

// --- rid runs ----------------------------------------------------------------

interface RidView {
  runs: Array<[number, number]>
  rows: number
  /** highest rid in use, or 0 for an empty sheet */
  max: number
  has(rid: number): boolean
}

/**
 * Read `rids` without materialising them.
 *
 * A 250k-row sheet is a handful of runs; expanding it to check membership would
 * cost more than every other check in this file put together.
 *
 * NOTE WHAT IS *NOT* AN INVARIANT: runs are NOT globally ascending. Rows are
 * positional and rids are minted monotonically, so inserting a row at the TOP of
 * a sheet produces `[[4,1],[1,3]]` — perfectly healthy, and a check for
 * ascending order would flag it. What must hold is that no rid appears twice:
 * everything that attaches to one (overrides, comments, a peer's CRDT node)
 * assumes it names one row forever.
 */
function ridView(rids: unknown): RidView {
  const runs = arr(rids).filter(
    (r): r is [number, number] => Array.isArray(r) && isInt(r[0]) && isInt(r[1]) && r[1] > 0,
  )
  const sorted = [...runs].sort((a, b) => a[0] - b[0])
  let rows = 0
  let max = 0
  for (const [start, count] of runs) {
    rows += count
    max = Math.max(max, start + count - 1)
  }
  return {
    runs,
    rows,
    max,
    has(rid: number): boolean {
      let lo = 0
      let hi = sorted.length - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const [start, count] = sorted[mid]
        if (rid < start) hi = mid - 1
        else if (rid >= start + count) lo = mid + 1
        else return true
      }
      return false
    },
  }
}

/** How many values a column's encoding claims to hold; null if we cannot say. */
function encodedLength(d: ColumnData): number | null {
  if (d.enc === 'raw') return Array.isArray(d.v) ? d.v.length : null
  if (d.enc === 'dict') return Array.isArray(d.idx) ? d.idx.length : null
  if (d.enc === 'pack') return isInt(d.n) ? d.n : null
  return null
}

// --- the pass ----------------------------------------------------------------

/**
 * Check a workbook against itself.
 *
 * Never throws, never mutates, and returns everything it found rather than the
 * first thing — a document handed back by a model is usually wrong in more than
 * one way, and reporting one at a time turns fixing it into ten round trips.
 */
export function validateDoc(doc: DashDoc): ValidateResult {
  const findings: Finding[] = []
  const add = (f: Finding): void => { findings.push(f) }

  // The whole premise is that this document came from somewhere untrustworthy —
  // a model, a script, a hand edit. `DashDoc` in the signature is a statement
  // about the caller's intent, not a guarantee about the bytes.
  if (!isObj(doc)) {
    add({ code: 'bad-document', severity: 'fatal',
      message: 'The document is not a JSON object, so there is nothing to check.' })
    return result(findings)
  }
  const bag = doc as unknown as Record<string, unknown>

  // ---- document ------------------------------------------------------------
  if (bag.format !== FORMAT) {
    add({ code: 'bad-format', severity: 'fatal',
      message: `The document declares format ${q(bag.format)}, not ${q(FORMAT)} — this is not a workbook dash can open.` })
  }
  const version = bag.version
  if (!isInt(version) || version < 1) {
    add({ code: 'bad-version', severity: 'suspicious', path: 'version',
      message: `version is ${q(version)}, which is not a format version — dash reads it as ${FORMAT_VERSION} and carries on.` })
  } else if (version > FORMAT_VERSION) {
    add({ code: 'future-version', severity: 'suspicious', path: 'version',
      message: `Written by a newer dash (version ${version}; this build knows ${FORMAT_VERSION}). It opens read-only and round-trips byte-exact, so nothing is lost — but this build cannot check rules it does not have.` })
  }
  const policy = bag.policy
  if (policy !== undefined && policy !== 'bento-dash-1') {
    add({ code: 'unknown-policy', severity: 'suspicious', path: 'policy',
      message: `policy ${q(policy)} names rules this build does not have, so the workbook opens read-only with id repair disabled.` })
  }
  // `parseDoc` computes this the same way, and it decides whether the repairs
  // below actually happen.
  const frozen = (isInt(version) && version > FORMAT_VERSION)
    || (policy !== undefined && policy !== 'bento-dash-1')

  if (typeof bag.docId !== 'string' || !bag.docId) {
    add({ code: 'missing-doc-id', severity: 'repairable', path: 'docId',
      message: 'No docId. parseDoc mints one on load, and it persists from the next save — but until then autosave recovery, the version timeline and every future merge share one slot named "undefined" with every other workbook missing it.' })
  }
  if (!Array.isArray(bag.sheets)) {
    add({ code: 'no-sheets', severity: 'fatal', path: 'sheets',
      message: 'There is no sheets array — a bento/dash document is a list of sheets, and without it there is nothing to open.' })
    return result(findings)
  }

  const sheets = bag.sheets as Sheet[]
  const sheetIds = new Set<string>()
  const tables = new Map<string, TableSheet>()
  const kinds = new Map<string, string>()
  sheets.forEach((s, i) => {
    if (!isObj(s)) {
      add({ code: 'bad-sheet', severity: 'fatal', path: `sheets[${i}]`,
        message: `sheets[${i}] is not an object, so it carries no id, no columns and no rows.` })
      return
    }
    const id = typeof s.id === 'string' ? s.id : ''
    if (!id) {
      add({ code: 'missing-sheet-id', severity: frozen ? 'fatal' : 'repairable', path: `sheets[${i}]`,
        message: frozen
          ? `sheets[${i}] has no id, and this workbook is frozen so parseDoc will not mint one — nothing can reference it.`
          : `sheets[${i}] has no id; parseDoc mints a deterministic one on load.` })
    } else if (sheetIds.has(id)) {
      add({ code: 'duplicate-sheet-id', severity: frozen ? 'fatal' : 'repairable', sheet: id, path: `sheets[${i}]`,
        message: frozen
          ? `Two sheets share the id ${q(id)}, and this workbook is frozen so parseDoc will not rename either — every reference to it (a tile, a story step, a derived sheet's "from") reaches the FIRST one, and the second is unreachable.`
          : `Two sheets share the id ${q(id)}; parseDoc renames the second on load, so references written against it now point at the first.` })
    }
    if (id) {
      sheetIds.add(id)
      kinds.set(id, typeof s.kind === 'string' ? s.kind : 'table')
    }
    const kind = typeof s.kind === 'string' ? s.kind : 'table'
    if (kind === 'table') {
      if (id) tables.set(id, s as unknown as TableSheet)
      checkTable(s as unknown as TableSheet, id || `sheets[${i}]`, frozen, add)
    } else if (kind === 'canvas') {
      checkCanvas(s as unknown as CanvasSheet, id, add)
    }
    // Any other kind is a sheet from a later build. It round-trips whole
    // (model.ts refuses to coerce it to a table) and there is nothing here that
    // could check it without inventing rules it does not have.
  })

  // A derived sheet's source. `from` is the seam `explain()` walks, so a
  // dangling one is a provenance chain that stops mid-sentence.
  for (const [id, sheet] of tables) {
    const from = (sheet as unknown as Record<string, unknown>).from
    if (typeof from === 'string' && from && !sheetIds.has(from)) {
      add({ code: 'orphan-derived-from', severity: 'suspicious', sheet: id, path: 'from',
        message: `Sheet ${q(id)} says it was derived from sheet ${q(from)}, which is not in this workbook — its provenance cannot be followed and it cannot be re-derived.` })
    }
  }

  checkPivots(sheets, tables, add)
  checkMeasures(doc, sheetIds, tables, add)
  checkViews(doc, tables, kinds, add)
  checkStory(doc, tables, kinds, add)
  checkOpenChart(doc, tables, kinds, add)

  return result(findings)
}

function result(findings: Finding[]): ValidateResult {
  const counts: Record<Severity, number> = { fatal: 0, repairable: 0, suspicious: 0 }
  for (const f of findings) counts[f.severity]++
  return { ok: counts.fatal === 0, counts, findings }
}

// --- table sheets ------------------------------------------------------------

function checkTable(
  sheet: TableSheet, sid: string, frozen: boolean, add: (f: Finding) => void,
): void {
  const raw = sheet as unknown as Record<string, unknown>

  // ---- rids ----------------------------------------------------------------
  if (!Array.isArray(raw.rids)) {
    add({ code: 'rid-run-shape', severity: 'fatal', sheet: sid, path: 'rids',
      message: `Sheet ${q(sid)} has no rids array, so it has no rows — every column below is orphaned data.` })
  }
  const bad: string[] = []
  arr(raw.rids).forEach((r, i) => {
    if (!Array.isArray(r) || r.length !== 2) { bad.push(`rids[${i}]`); return }
    const [start, count] = r as unknown[]
    if (!isInt(start) || start < 1) bad.push(`rids[${i}] start ${String(start)}`)
    else if (!isInt(count) || count < 1) bad.push(`rids[${i}] count ${String(count)}`)
  })
  if (bad.length) {
    add({ code: 'rid-run-shape', severity: 'fatal', sheet: sid, path: 'rids',
      message: `Sheet ${q(sid)}: ${bad.length} run(s) are not [start, count] with whole numbers and a count of at least one — ${some(bad)}. Rows are counted from these runs, so the sheet's row count is wrong and every column is measured against it.` })
  }

  const rids = ridView(raw.rids)
  // Overlap is the corruption, not order — see ridView.
  const sorted = [...rids.runs].sort((a, b) => a[0] - b[0])
  for (let i = 1; i < sorted.length; i++) {
    const [ps, pc] = sorted[i - 1]
    const [s] = sorted[i]
    if (s < ps + pc) {
      add({ code: 'duplicate-rid', severity: 'fatal', sheet: sid, path: 'rids',
        message: `Sheet ${q(sid)}: the runs starting ${ps} and ${s} overlap, so at least one rid names two rows. Overrides, comments and every collaborator's node key attach to a rid — two rows sharing one merge into one and silently lose the other.` })
      break
    }
  }

  // ---- the watermark -------------------------------------------------------
  // Includes rids only an OVERRIDE mentions, exactly as rowcol.ts's
  // `nextRidFloor` does: a rid a suspended correction still names is in use.
  const cells = isObj(raw.cells) ? raw.cells as Record<string, unknown> : {}
  let usedMax = rids.max
  for (const k of Object.keys(cells)) {
    const i = k.indexOf(':')
    if (i < 0) continue
    const rid = Number(k.slice(i + 1))
    if (Number.isInteger(rid)) usedMax = Math.max(usedMax, rid)
  }
  const nextRid = raw.nextRid
  if (nextRid !== undefined) {
    if (!isInt(nextRid) || nextRid < 1) {
      add({ code: 'rid-watermark', severity: 'fatal', sheet: sid, path: 'nextRid',
        message: `Sheet ${q(sid)}: nextRid is ${q(nextRid)}, which is not a rid this sheet could mint.` })
    } else if (nextRid <= usedMax) {
      add({ code: 'rid-watermark', severity: 'fatal', sheet: sid, path: 'nextRid',
        message: `Sheet ${q(sid)}: nextRid is ${nextRid} but rid ${usedMax} is already in use. The watermark is what stops a rid ever being minted twice — the next insert will reuse a live row's identity, and every override, comment and CRDT node keyed to it lands on the wrong row.` })
    }
  }

  // ---- columns and their data ----------------------------------------------
  const columns = arr(raw.columns) as Column[]
  const data = isObj(raw.data) ? raw.data as Record<string, ColumnData> : {}
  const seen = new Set<string>()
  const colIds = new Set<string>()

  columns.forEach((c, i) => {
    if (!isObj(c)) {
      add({ code: 'bad-column', severity: 'fatal', sheet: sid, path: `columns[${i}]`,
        message: `Sheet ${q(sid)}: columns[${i}] is not an object, so it has no id to hold data under.` })
      return
    }
    const id = typeof c.id === 'string' ? c.id : ''
    if (!id) {
      add({ code: 'missing-column-id', severity: frozen ? 'fatal' : 'repairable', sheet: sid, path: `columns[${i}]`,
        message: frozen
          ? `Sheet ${q(sid)}: columns[${i}] has no id and this workbook is frozen, so parseDoc will not mint one — its data, overrides and totals cannot be keyed.`
          : `Sheet ${q(sid)}: columns[${i}] has no id; parseDoc mints a deterministic one on load and carries its data across with it.` })
      return
    }
    colIds.add(id)
    if (seen.has(id)) {
      add({ code: 'duplicate-column-id', severity: frozen ? 'fatal' : 'repairable', sheet: sid, column: id,
        message: frozen
          ? `Sheet ${q(sid)}: two columns share the id ${q(id)} and this workbook is frozen, so neither is renamed — data, cells and totals are all keyed by that id and both columns claim the same entries.`
          : `Sheet ${q(sid)}: two columns share the id ${q(id)}; parseDoc renames the second on load and moves its data with it.` })
    }
    seen.add(id)

    const d = data[id]
    const isFormula = typeof c.formula === 'string' && c.formula.trim() !== ''
    if (!d) {
      // A formula column HAS no stored data by design (store.ts addColumn) —
      // storing it would let the file carry a number that disagrees with the
      // expression that produced it.
      if (!isFormula) {
        add({ code: 'missing-column-data', severity: 'fatal', sheet: sid, column: id,
          message: `Sheet ${q(sid)}: column ${q(id)} has no entry in data, so every row of it reads blank. This is what a rename that did not carry its data looks like, and nothing at load time says so.` })
      }
      return
    }
    if (isFormula) {
      add({ code: 'formula-column-data', severity: 'suspicious', sheet: sid, column: id,
        message: `Sheet ${q(sid)}: column ${q(id)} has both a formula and stored data. The formula wins at render, so the stored values are a second answer to the same question that nobody will ever see disagree.` })
    }
    if (!isObj(d) || typeof d.enc !== 'string') {
      add({ code: 'bad-column-data', severity: 'fatal', sheet: sid, column: id,
        message: `Sheet ${q(sid)}: data for column ${q(id)} is not an encoded column ({enc:"raw"|"dict"|"pack"}).` })
      return
    }
    if (d.enc !== 'raw' && d.enc !== 'dict' && d.enc !== 'pack') {
      // Additive: an encoding from a later build round-trips. Say so, check no
      // further, and do NOT call it damage.
      add({ code: 'unknown-encoding', severity: 'suspicious', sheet: sid, column: id,
        message: `Sheet ${q(sid)}: column ${q(id)} is encoded ${q((d as { enc: string }).enc)}, which this build cannot read — it round-trips untouched, but the column shows as empty here and its length cannot be checked.` })
      return
    }

    const len = encodedLength(d)
    if (len === null) {
      add({ code: 'bad-column-data', severity: 'fatal', sheet: sid, column: id,
        message: `Sheet ${q(sid)}: column ${q(id)} is encoded ${q(d.enc)} but carries no readable value array.` })
      return
    }
    if (len !== rids.rows) {
      add({ code: 'column-length', severity: 'fatal', sheet: sid, column: id,
        message: `Sheet ${q(sid)}: column ${q(id)} holds ${len} value(s) but the sheet has ${rids.rows} row(s). Values are joined to rows by POSITION only — every value after the discrepancy belongs to a different row than the one showing it, and nothing about the result looks wrong.` })
    }
    if (d.enc === 'dict') {
      if (!Array.isArray(d.dict)) {
        add({ code: 'bad-column-data', severity: 'fatal', sheet: sid, column: id,
          message: `Sheet ${q(sid)}: column ${q(id)} is dictionary-encoded but has no dict array, so every index points at nothing.` })
      } else {
        // O(rows), deliberately not sampled: one bad index is one wrong cell,
        // and finding "most of them are fine" is not an answer.
        const at: number[] = []
        for (let r = 0; r < d.idx.length; r++) {
          const k = d.idx[r]
          if (k === null || k === undefined) continue
          if (!isInt(k) || k < 0 || k >= d.dict.length) at.push(r)
        }
        if (at.length) {
          add({ code: 'dict-index', severity: 'fatal', sheet: sid, column: id,
            message: `Sheet ${q(sid)}: column ${q(id)} has ${at.length} dictionary index(es) outside its ${d.dict.length}-entry dict, at row(s) ${some(at)}. Those cells read as blank, and a blank in a number column reads as a value nobody entered.` })
        }
      }
    }
  })

  for (const key of Object.keys(data)) {
    if (colIds.has(key)) continue
    add({ code: 'orphan-column-data', severity: 'suspicious', sheet: sid, column: key,
      message: `Sheet ${q(sid)}: data holds a column ${q(key)} that is not in columns — bytes in every save for values nothing shows. A column renamed without carrying its data leaves exactly this behind.` })
  }

  checkOverrides(sheet, sid, colIds, rids, add)
  checkFormulas(sheet, sid, rids, add)
  checkTotals(sheet, sid, colIds, add)
  checkCondFmt(sheet, sid, colIds, add)
}

/** `<colId>:<rid>` — the only key shape the sparse overlay has. */
function checkOverrides(
  sheet: TableSheet, sid: string, colIds: Set<string>, rids: RidView,
  add: (f: Finding) => void,
): void {
  const cells = (sheet as unknown as Record<string, unknown>).cells
  if (cells === undefined) return
  if (!isObj(cells)) {
    add({ code: 'bad-override-key', severity: 'suspicious', sheet: sid, path: 'cells',
      message: `Sheet ${q(sid)}: cells is not an object of overrides, so every hand correction in it is inert.` })
    return
  }
  const unparsed: string[] = []
  const noCol: string[] = []
  const noRow: string[] = []
  for (const k of Object.keys(cells)) {
    const i = k.indexOf(':')
    const rid = i < 0 ? NaN : Number(k.slice(i + 1))
    if (i < 0 || !Number.isInteger(rid)) { unparsed.push(k); continue }
    if (!colIds.has(k.slice(0, i))) { noCol.push(k); continue }
    if (!rids.has(rid)) noRow.push(k)
  }
  if (unparsed.length) {
    add({ code: 'bad-override-key', severity: 'suspicious', sheet: sid, path: 'cells',
      message: `Sheet ${q(sid)}: ${unparsed.length} override key(s) are not "<colId>:<rid>" — ${some(unparsed)}. Nothing can find them, so the correction, note or per-cell formula each holds will never appear and cannot be edited away.` })
  }
  if (noCol.length) {
    add({ code: 'orphan-override', severity: 'suspicious', sheet: sid, path: 'cells',
      message: `Sheet ${q(sid)}: ${noCol.length} override(s) name a column this sheet does not have — ${some(noCol)}. They are kept in the file and shown nowhere.` })
  }
  if (noRow.length) {
    add({ code: 'orphan-override', severity: 'suspicious', sheet: sid, path: 'cells',
      message: `Sheet ${q(sid)}: ${noRow.length} override(s) name a row this sheet does not have — ${some(noRow)}. Harmless while rids are never reused; if the watermark is also wrong they will reappear on top of whatever row is minted next.` })
  }
}

/**
 * Column expressions and per-cell formulas.
 *
 * The two resolve names DIFFERENTLY and that is the whole subtlety here. A
 * COLUMN formula is evaluated by `recalc`, whose context holds column ids and
 * names and nothing else — `B4` in one is `#NAME?`, not a cell. A CELL formula
 * goes through cellformula.ts, which binds A1 addresses FIRST, so `B4` is the
 * cell and a column called `B4` is reachable only as `[B4]`. Checking both with
 * one rule would either miss every broken cell reference or invent a broken
 * column reference for every working one.
 */
function checkFormulas(
  sheet: TableSheet, sid: string, rids: RidView, add: (f: Finding) => void,
): void {
  const keys = columnKeys(sheet)
  const columns = (arr((sheet as unknown as Record<string, unknown>).columns) as Column[])
    .filter((c) => isObj(c))

  for (const c of columns) {
    const src = c.formula
    if (typeof src !== 'string') continue
    const id = typeof c.id === 'string' ? c.id : ''
    if (!src.trim()) {
      add({ code: 'empty-formula', severity: 'suspicious', sheet: sid, column: id,
        message: `Sheet ${q(sid)}: column ${q(id)} carries an empty formula. It has no stored data either, so the column is blank for every row — deleting the key is what "no formula" is spelled as.` })
      continue
    }
    for (const fn of unknownCalls(src)) {
      add({ code: 'unknown-function', severity: 'suspicious', sheet: sid, column: id,
        message: `Sheet ${q(sid)}: column ${q(id)} calls ${q(fn)}, which this build does not implement — every row of the column reads #NAME?.` })
    }
    for (const ref of safeDeps(src)) {
      if (keys.has(ref.toLowerCase())) continue
      add({ code: 'unknown-formula-ref', severity: 'suspicious', sheet: sid, column: id,
        message: `Sheet ${q(sid)}: column ${q(id)}'s formula names ${q(ref)}, which is not a column on this sheet — every row reads #NAME?. A column formula resolves column ids and names only; a cell address like B4 means nothing in one.` })
    }
  }

  // A COLUMN WHOSE BYTES DISAGREE WITH ITS DECLARED TYPE.
  //
  // This file's header says the columnar failure is the one that matters
  // because it has no symptom. Here is one that had a symptom and it was a
  // wrong number: a column declared `number` whose stored values are strings
  // reads as a number column everywhere — right-aligned, number-formatted — and
  // totals as ZERO, because `aggregate` (grid.ts) skips anything that is not
  // already `typeof v === 'number'`. Measured before the fix: footer `SUM 0`
  // against a true total of 10,308.85.
  //
  // `store.ts` now converts the storage on a type change and refuses what will
  // not convert, so this state can no longer be CREATED by the app. It is still
  // checked here for the two ways it arrives anyway: a file SAVED by a build
  // that had the bug, and hand-edited or model-generated JSON, which PLATFORM §7
  // makes a first-class way in. Both look completely normal on screen.
  //
  // Only `raw` encodings are walked. A `dict` column is strings by construction
  // and a `pack` is opaque until inflated, so neither can answer this question.
  for (const c of columns) {
    const id = typeof c.id === 'string' ? c.id : ''
    const want = c.type
    if (want !== 'number' && want !== 'money' && want !== 'percent') continue
    if (typeof c.formula === 'string' && c.formula.trim()) continue // computed, not stored
    const data = (sheet.data as Record<string, ColumnData | undefined>)?.[id]
    if (!data || data.enc !== 'raw') continue
    let wrong = 0
    let sample = ''
    for (const v of data.v) {
      if (v == null || typeof v === 'number') continue
      wrong++
      if (!sample) sample = String(v)
    }
    if (!wrong) continue
    add({ code: 'type-storage-mismatch', severity: 'suspicious', sheet: sid, column: id,
      message: `Sheet ${q(sid)}: column ${q(id)} is declared ${q(String(want))} but ${wrong} of its stored values ${wrong === 1 ? 'is' : 'are'} not a number${sample ? ` (for example ${q(sample)})` : ''}. The grid will right-align and format them as numbers, and every total over the column will silently skip them — a column like this reads as SUM 0. Set the type again to convert the storage, or set it back to text.` })
  }

  // Cycles. `recalc` reports these as #CYCLE! per cell rather than a plausible
  // number, so nothing is corrupted — but a column of #CYCLE! in a saved file is
  // a model somebody meant to work, and the graph is cheap to walk without
  // evaluating a single row.
  const formulas = columns.filter((c) => typeof c.formula === 'string' && c.formula.trim())
  if (formulas.length) {
    const byKey = new Map<string, string>()
    for (const c of formulas) {
      if (typeof c.id === 'string') byKey.set(c.id.toLowerCase(), c.id)
      if (typeof c.name === 'string') byKey.set(c.name.toLowerCase(), c.id as string)
    }
    const deps = new Map<string, Set<string>>()
    for (const c of formulas) {
      const d = new Set<string>()
      // INCLUDING itself: `a = a + 1` is a cycle, and formula.ts records why
      // excluding self-edges was wrong (indegree 0, computed against its own
      // stale values, produced a number).
      for (const ref of safeDeps(c.formula as string)) {
        const target = byKey.get(ref.toLowerCase())
        if (target) d.add(target)
      }
      deps.set(c.id as string, d)
    }
    const indeg = new Map([...deps].map(([k, v]) => [k, v.size]))
    const queue = [...indeg].filter(([, n]) => n === 0).map(([k]) => k)
    const done = new Set<string>()
    while (queue.length) {
      const id = queue.shift() as string
      done.add(id)
      for (const [other, d] of deps) {
        if (!d.has(id)) continue
        d.delete(id)
        const left = (indeg.get(other) ?? 1) - 1
        indeg.set(other, left)
        if (left === 0) queue.push(other)
      }
    }
    const cycles = formulas.map((c) => c.id as string).filter((id) => !done.has(id))
    if (cycles.length) {
      add({ code: 'formula-cycle', severity: 'suspicious', sheet: sid,
        message: `Sheet ${q(sid)}: column(s) ${some(cycles)} depend on each other in a circle. Every cell of them reads #CYCLE! — visibly wrong rather than quietly wrong, which is the point, but nothing in the sheet computes.` })
    }
  }

  // Per-cell formulas.
  const cells = (sheet as unknown as Record<string, unknown>).cells
  if (!isObj(cells)) return
  const cols = columns.length
  for (const [k, v] of Object.entries(cells)) {
    if (!isObj(v) || typeof v.f !== 'string' || !v.f.trim()) continue
    const i = k.indexOf(':')
    const rid = i < 0 ? undefined : Number(k.slice(i + 1))
    const where = { sheet: sid, column: i < 0 ? undefined : k.slice(0, i), rid: Number.isInteger(rid) ? rid : undefined }
    const src = v.f.startsWith('=') ? v.f.slice(1) : v.f

    if (src.includes('#REF!')) {
      add({ ...where, code: 'broken-ref', severity: 'suspicious',
        message: `Sheet ${q(sid)}: the formula in ${q(k)} still contains #REF! from an earlier structural edit — it cannot compute, and the cell shows the error rather than a number.` })
    }
    for (const fn of unknownCalls(src)) {
      add({ ...where, code: 'unknown-function', severity: 'suspicious',
        message: `Sheet ${q(sid)}: the formula in ${q(k)} calls ${q(fn)}, which this build does not implement — the cell reads #NAME?.` })
    }
    // a1.ts's own scanner decides what is a reference; see A1_BOUND.
    const refs: RefUnit[] = []
    let rest: string
    try { rest = mapRefs(src, (u) => { refs.push(u); return A1_BOUND }) } catch { continue }
    for (const u of refs) {
      for (const end of [u.from, u.to]) {
        if (!end) continue
        if (outside(end, cols, rids.rows)) {
          add({ ...where, code: 'cell-ref-out-of-range', severity: 'suspicious',
            message: `Sheet ${q(sid)}: the formula in ${q(k)} points at row ${end.row + 1}, column ${end.col + 1} of a sheet that is ${rids.rows} row(s) by ${cols} column(s). A reference off the sheet is not a zero and not a blank — it is an error the cell will display.` })
        }
      }
    }
    for (const ref of safeDeps(rest)) {
      if (ref === A1_BOUND) continue
      if (keys.has(ref.toLowerCase())) continue
      add({ ...where, code: 'unknown-formula-ref', severity: 'suspicious',
        message: `Sheet ${q(sid)}: the formula in ${q(k)} names ${q(ref)}, which is neither a cell address nor a column on this sheet — the cell reads #NAME?.` })
    }
  }
}

const outside = (r: CellRef, cols: number, rows: number): boolean =>
  r.row < 0 || r.col < 0 || r.row >= rows || r.col >= cols

/** `dependencies` parses; a hand-written expression is exactly what may break it. */
function safeDeps(src: string): string[] {
  try { return dependencies(src) } catch { return [] }
}

const TOTAL_FNS = new Set(['sum', 'avg', 'count', 'min', 'max'])

function checkTotals(
  sheet: TableSheet, sid: string, colIds: Set<string>, add: (f: Finding) => void,
): void {
  const totals = (sheet as unknown as Record<string, unknown>).totals
  if (!isObj(totals)) return
  for (const [col, fn] of Object.entries(totals)) {
    if (!colIds.has(col)) {
      add({ code: 'orphan-total', severity: 'suspicious', sheet: sid, column: col,
        message: `Sheet ${q(sid)}: a total is set for column ${q(col)}, which this sheet does not have — the totals row shows nothing where the author put a number.` })
      continue
    }
    if (isObj(fn) && typeof fn.f === 'string') continue
    if (typeof fn !== 'string' || !TOTAL_FNS.has(fn)) {
      add({ code: 'unknown-total', severity: 'suspicious', sheet: sid, column: col,
        message: `Sheet ${q(sid)}: the total on column ${q(col)} is ${q(fn)}, which is not one of ${[...TOTAL_FNS].join('/')} or {f:"…"} — the cell stays empty.` })
    }
  }
}

const CF_KINDS = new Set(['cellValue', 'colorScale', 'dataBar', 'topN', 'duplicates', 'formula'])

function checkCondFmt(
  sheet: TableSheet, sid: string, colIds: Set<string>, add: (f: Finding) => void,
): void {
  const cf = (sheet as unknown as Record<string, unknown>).condfmt
  if (!isObj(cf)) return
  const keys = columnKeys(sheet)
  for (const [col, rules] of Object.entries(cf)) {
    if (!colIds.has(col)) {
      add({ code: 'orphan-condfmt', severity: 'suspicious', sheet: sid, column: col,
        message: `Sheet ${q(sid)}: conditional formatting is defined for column ${q(col)}, which this sheet does not have — the rules never run.` })
      continue
    }
    arr(rules).forEach((r, i) => {
      if (!isObj(r)) return
      const kind = r.kind
      if (typeof kind !== 'string' || !CF_KINDS.has(kind)) {
        // A rule kind from a later build is ignored at render, never guessed at
        // (condfmt.ts's default branch). Reported so it is not a mystery.
        add({ code: 'unknown-condfmt-rule', severity: 'suspicious', sheet: sid, column: col, path: `condfmt.${col}[${i}]`,
          message: `Sheet ${q(sid)}: column ${q(col)} has a ${q(kind)} formatting rule this build does not know — it paints nothing and is kept in the file.` })
        return
      }
      if (kind !== 'formula' || typeof r.expr !== 'string') return
      for (const fn of unknownCalls(r.expr)) {
        add({ code: 'unknown-function', severity: 'suspicious', sheet: sid, column: col, path: `condfmt.${col}[${i}]`,
          message: `Sheet ${q(sid)}: the formatting rule on column ${q(col)} calls ${q(fn)}, which this build does not implement — the rule never matches a row.` })
      }
      for (const ref of safeDeps(r.expr)) {
        // `value` is the column being formatted; the cross-column escape hatch
        // binds the sheet's other columns (condfmt.ts formulaMask).
        if (ref.toLowerCase() === 'value' || keys.has(ref.toLowerCase())) continue
        add({ code: 'unknown-formula-ref', severity: 'suspicious', sheet: sid, column: col, path: `condfmt.${col}[${i}]`,
          message: `Sheet ${q(sid)}: the formatting rule on column ${q(col)} names ${q(ref)}, which is neither "value" nor a column on this sheet — the rule matches no row and the formatting silently never appears.` })
      }
    })
  }
}

// --- canvas sheets -----------------------------------------------------------

function checkCanvas(sheet: CanvasSheet, sid: string, add: (f: Finding) => void): void {
  const cells = (sheet as unknown as Record<string, unknown>).cells
  if (!isObj(cells)) {
    add({ code: 'bad-canvas-cells', severity: 'fatal', sheet: sid, path: 'cells',
      message: `Canvas sheet ${q(sid)} has no cells map — a canvas sheet IS its cells, so there is nothing to show.` })
    return
  }
  const keys = Object.keys(cells)
  const bad = keys.filter((k) => !parseRef(k))
  if (bad.length) {
    add({ code: 'bad-canvas-key', severity: 'suspicious', sheet: sid, path: 'cells',
      message: `Canvas sheet ${q(sid)}: ${bad.length} cell key(s) are not A1 addresses — ${some(bad)}. They occupy no position on the sheet, so they are saved forever and shown nowhere.` })
  }
  if (keys.length > CANVAS_CELL_MAX) {
    add({ code: 'canvas-too-large', severity: 'suspicious', sheet: sid,
      message: `Canvas sheet ${q(sid)} holds ${keys.length} cells, past the ${CANVAS_CELL_MAX} a sparse A1 map is sized for. This should have been a table sheet: one cell here costs about 40 bytes against 4.8 in a dictionary column.` })
  }
  for (const [k, cell] of Object.entries(cells)) {
    if (!isObj(cell) || typeof cell.f !== 'string' || !cell.f.trim()) continue
    const src = cell.f.startsWith('=') ? cell.f.slice(1) : cell.f
    if (src.includes('#REF!')) {
      add({ code: 'broken-ref', severity: 'suspicious', sheet: sid, path: `cells.${k}`,
        message: `Canvas sheet ${q(sid)}: the formula in ${k} still contains #REF! from an earlier structural edit.` })
    }
    for (const fn of unknownCalls(src)) {
      add({ code: 'unknown-function', severity: 'suspicious', sheet: sid, path: `cells.${k}`,
        message: `Canvas sheet ${q(sid)}: the formula in ${k} calls ${q(fn)}, which this build does not implement — the cell reads #NAME?.` })
    }
  }
}

// --- pivots ------------------------------------------------------------------

const AGG_FNS = new Set(['sum', 'avg', 'count', 'min', 'max', 'median', 'countDistinct'])

function checkPivots(
  sheets: Sheet[], tables: Map<string, TableSheet>, add: (f: Finding) => void,
): void {
  sheets.forEach((s, i) => {
    if (!isObj(s) || s.kind !== 'pivot') return
    const sid = typeof s.id === 'string' ? s.id : `sheets[${i}]`
    const spec = (s as unknown as PivotSheet).pivot
    if (!isObj(spec)) {
      add({ code: 'bad-pivot', severity: 'fatal', sheet: sid, path: 'pivot',
        message: `Pivot sheet ${q(sid)} has no pivot spec — a pivot sheet stores a spec and never the numbers it produces, so without one there is nothing to compute.` })
      return
    }
    const from = typeof spec.from === 'string' ? spec.from : ''
    const src = tables.get(from)
    if (!src) {
      add({ code: 'pivot-missing-sheet', severity: 'suspicious', sheet: sid, path: 'pivot.from',
        message: `Pivot sheet ${q(sid)} pivots ${q(from)}, which is not a table sheet in this workbook — it has nothing to aggregate and shows empty.` })
      return
    }
    const cols = new Set((arr(src.columns) as Column[]).filter(isObj).map((c) => c.id as string))
    const named = (field: string, id: unknown): void => {
      if (typeof id !== 'string' || cols.has(id)) return
      add({ code: 'pivot-missing-column', severity: 'suspicious', sheet: sid, column: id, path: `pivot.${field}`,
        message: `Pivot sheet ${q(sid)} groups by column ${q(id)}, which sheet ${q(from)} does not have — that field drops out and the totals are over a different grouping than the author built.` })
    }
    arr(spec.rows).forEach((r) => named('rows', r))
    arr(spec.cols).forEach((c) => named('cols', c))
    arr(spec.filters).forEach((f, j) => { if (isObj(f)) named(`filters[${j}].col`, f.col) })
    arr(spec.values).forEach((v, j) => {
      if (!isObj(v)) return
      named(`values[${j}].col`, v.col)
      if (typeof v.fn !== 'string' || !AGG_FNS.has(v.fn)) {
        add({ code: 'unknown-agg', severity: 'suspicious', sheet: sid, path: `pivot.values[${j}].fn`,
          message: `Pivot sheet ${q(sid)}: value ${j} aggregates with ${q(v.fn)}, which is not one of ${[...AGG_FNS].join('/')} — that column of the pivot cannot be computed.` })
      }
    })
  })
}

// --- measures ----------------------------------------------------------------

function checkMeasures(
  doc: DashDoc, sheetIds: Set<string>, tables: Map<string, TableSheet>,
  add: (f: Finding) => void,
): void {
  const measures = (doc as unknown as Record<string, unknown>).measures
  if (!isObj(measures)) return
  for (const [name, m] of Object.entries(measures)) {
    if (!isObj(m)) continue
    const grain = typeof m.grain === 'string' ? m.grain : ''
    if (!grain || !sheetIds.has(grain)) {
      add({ code: 'measure-missing-grain', severity: 'suspicious', path: `measures.${name}`,
        message: `Measure ${q(name)} declares its grain as sheet ${q(grain)}, which is not in this workbook. Grain is what one row MEANS — without it a grain mismatch or a join fan-out is undetectable, which is the entire reason the field is carried.` })
      continue
    }
    const src = tables.get(grain)
    if (!src || typeof m.expr !== 'string') continue
    const keys = columnKeys(src)
    for (const fn of unknownCalls(m.expr)) {
      add({ code: 'unknown-function', severity: 'suspicious', path: `measures.${name}`,
        message: `Measure ${q(name)} calls ${q(fn)}, which this build does not implement — the measure evaluates to #NAME?.` })
    }
    for (const ref of safeDeps(m.expr)) {
      if (keys.has(ref.toLowerCase())) continue
      add({ code: 'unknown-formula-ref', severity: 'suspicious', path: `measures.${name}`,
        message: `Measure ${q(name)} names ${q(ref)}, which is not a column on its grain sheet ${q(grain)} — the measure evaluates to #NAME?.` })
    }
  }
}

// --- dashboards --------------------------------------------------------------

function checkViews(
  doc: DashDoc, tables: Map<string, TableSheet>, kinds: Map<string, string>,
  add: (f: Finding) => void,
): void {
  const views = (doc as unknown as Record<string, unknown>).views
  if (views === undefined) return
  if (!Array.isArray(views)) {
    add({ code: 'bad-views', severity: 'suspicious', path: 'views',
      message: 'views is not an array, so no dashboard opens. views is a LIST because its order is the tab order and readers must agree on it.' })
    return
  }
  const measures = isObj((doc as unknown as Record<string, unknown>).measures)
    ? Object.keys((doc as unknown as Record<string, Record<string, unknown>>).measures)
    : []
  const seen = new Set<string>()
  views.forEach((v, vi) => {
    if (!isObj(v)) return
    const id = typeof v.id === 'string' ? v.id : ''
    if (id && seen.has(id)) {
      add({ code: 'duplicate-view-id', severity: 'suspicious', path: `views[${vi}]`,
        message: `Two dashboards share the id ${q(id)}. Every write finds a view by id, so edits to the second land on the first and it can never be removed.` })
    }
    seen.add(id)
    arr(v.tiles).forEach((t, ti) => {
      if (!isObj(t)) return
      const path = `views[${vi}].tiles[${ti}]`
      const title = typeof t.title === 'string' && t.title ? q(t.title) : `tile ${ti}`
      if (t.kind === 'gl' && typeof t.fallback !== 'string') {
        add({ code: 'gl-no-fallback', severity: 'suspicious', path,
          message: `${title} draws with WebGL and declares no fallback. Where WebGL is unavailable — a locked-down machine, a remote desktop, an old iPad — the tile has nothing to draw, and a blank tile on a dashboard reads as "no data".` })
      }
      const bind = t.bind
      if (!isObj(bind)) return
      if (typeof bind.measure === 'string' && !measures.includes(bind.measure)) {
        add({ code: 'tile-missing-measure', severity: 'suspicious', path,
          message: `${title} shows the measure ${q(bind.measure)}, which is not defined in this workbook — the tile has no number to show.` })
      }
      const sid = typeof bind.sheet === 'string' ? bind.sheet : ''
      const src = tables.get(sid)
      if (!src) {
        add({ code: 'tile-missing-sheet', severity: 'suspicious', path,
          message: kinds.has(sid)
            ? `${title} is bound to sheet ${q(sid)}, which is a ${kinds.get(sid)} sheet and has no columns to bind — the tile renders empty.`
            : `${title} is bound to sheet ${q(sid)}, which is not in this workbook — the tile renders empty, and an empty chart reads as zero rather than as missing.` })
        return
      }
      const cols = new Set((arr(src.columns) as Column[]).filter(isObj).map((c) => c.id as string))
      const named = (field: string, id2: unknown): void => {
        if (typeof id2 !== 'string' || cols.has(id2)) return
        add({ code: 'tile-missing-column', severity: 'suspicious', path: `${path}.bind.${field}`, column: id2, sheet: sid,
          message: `${title} plots column ${q(id2)}, which sheet ${q(sid)} does not have. A tile NAMES its columns and derives the numbers at render, so a renamed or deleted column leaves a series that is absent rather than wrong — and absent is what a reader takes for zero.` })
      }
      named('x', bind.x)
      named('by', bind.by)
      named('col', bind.col)
      arr(bind.series).forEach((s, i) => named(`series[${i}]`, s))
      arr(bind.cols).forEach((c, i) => named(`cols[${i}]`, c))
    })
  })
}

// --- the open chart panel -----------------------------------------------------
//
// `doc.chart` (model.ts `OpenChart`) is additive, so a workbook can reach this
// build having been through one that never heard of it: the sheet it names can
// have been deleted or turned into a spreadsheet, and its columns can have been
// removed. main.ts already declines to reopen the panel in each of those cases,
// which is the safe behaviour and also a SILENT one — the chart the file was
// saved with simply is not there. Saying so is this function's whole job.

function checkOpenChart(
  doc: DashDoc, tables: Map<string, TableSheet>, kinds: Map<string, string>,
  add: (f: Finding) => void,
): void {
  const chart = (doc as unknown as Record<string, unknown>).chart
  if (!isObj(chart)) return
  const sid = typeof chart.sheet === 'string' ? chart.sheet : ''
  const src = tables.get(sid)
  if (!src) {
    add({ code: 'chart-missing-sheet', severity: 'suspicious', path: 'chart',
      message: kinds.has(sid)
        ? `The saved chart is about sheet ${q(sid)}, which is a ${kinds.get(sid)} sheet and has no columns to chart — the panel does not open.`
        : `The saved chart is about sheet ${q(sid)}, which is not in this workbook — the panel does not open, so a reader sees no chart and nothing saying one was saved.` })
    return
  }
  const bind = isObj(chart.binding) ? chart.binding : null
  if (!bind) {
    add({ code: 'bad-chart', severity: 'suspicious', path: 'chart.binding',
      message: 'The saved chart has no binding, so there is nothing to draw and the panel does not open.' })
    return
  }
  const cols = new Set((arr(src.columns) as Column[]).filter(isObj).map((c) => c.id as string))
  const named = (field: string, id: unknown): void => {
    if (typeof id !== 'string' || cols.has(id)) return
    add({ code: 'chart-missing-column', severity: 'suspicious', path: `chart.binding.${field}`, column: id, sheet: sid,
      message: `The saved chart binds column ${q(id)}, which sheet ${q(sid)} does not have — the panel does not open at all rather than drawing an axis against a column that is gone.` })
  }
  named('x', bind.x)
  arr(bind.series).forEach((c, i) => named(`series[${i}]`, c))
}

// --- the data story ----------------------------------------------------------

function checkStory(
  doc: DashDoc, tables: Map<string, TableSheet>, kinds: Map<string, string>,
  add: (f: Finding) => void,
): void {
  const story = (doc as unknown as Record<string, unknown>).story
  if (!isObj(story)) return
  const seen = new Set<string>()
  arr(story.steps).forEach((step, i) => {
    if (!isObj(step)) return
    const path = `story.steps[${i}]`
    const id = typeof step.id === 'string' ? step.id : ''
    if (id && seen.has(id)) {
      add({ code: 'duplicate-story-step', severity: 'suspicious', path,
        message: `Two story steps share the id ${q(id)} — the presenter finds a step by id, so one of them cannot be reached or edited.` })
    }
    seen.add(id)
    const sid = typeof step.sheet === 'string' ? step.sheet : ''
    const src = tables.get(sid)
    if (!src) {
      add({ code: 'story-missing-sheet', severity: 'suspicious', path,
        message: kinds.has(sid)
          ? `Step ${i + 1} shows sheet ${q(sid)}, which is a ${kinds.get(sid)} sheet and has no columns to chart — the step is skipped.`
          : `Step ${i + 1} shows sheet ${q(sid)}, which is not in this workbook. The step is SKIPPED rather than guessed at, so the story silently gets shorter.` })
      return
    }
    const cols = new Set((arr(src.columns) as Column[]).filter(isObj).map((c) => c.id as string))
    const named = (field: string, id2: unknown): void => {
      if (typeof id2 !== 'string' || cols.has(id2)) return
      add({ code: 'story-missing-column', severity: 'suspicious', path: `${path}.${field}`, column: id2, sheet: sid,
        message: `Step ${i + 1} binds column ${q(id2)}, which sheet ${q(sid)} does not have — that series or filter drops out of the step and the picture it morphs to is not the one that was captured.` })
    }
    if (isObj(step.chart)) {
      named('chart.x', step.chart.x)
      arr(step.chart.series).forEach((s, j) => named(`chart.series[${j}]`, s))
    }
    if (isObj(step.viz)) {
      for (const f of ['x', 'y', 'z', 'color', 'size', 'lat', 'lon'] as const) {
        named(`viz.${f}`, (step.viz as Record<string, unknown>)[f])
      }
    }
    arr(step.filters).forEach((f, j) => { if (isObj(f)) named(`filters[${j}].col`, f.col) })
    arr(step.sorts).forEach((s, j) => { if (isObj(s)) named(`sorts[${j}].col`, s.col) })
  })
}
