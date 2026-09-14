// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// TEXT TO COLUMNS — one column of "Smith, John" into two columns of Smith and
// John, on either kind of sheet.
//
// Nothing here touches the DOM. main.ts asks the questions and writes the
// patches; this decides what the answer IS, so every rule below is provable in
// node.
//
// ═══ WHY THIS IS A STEP ON A DATASET AND A MUTATION ON A SPREADSHEET ═══════
//
// dash has a real relational pipeline (steps.ts) and a split is a declaration:
// "this column is these columns, cut here". Expressed as a step it is undoable,
// collaborative, re-runnable and — the part that matters — LEGIBLE a year later
// to a reader who wants to know where a column came from. A spreadsheet has no
// pipeline and no column identity, so there the same command is what Excel's
// wizard is: a one-off write of cells.
//
// ═══ WHY `derive` DOES NOT ALREADY EXPRESS IT ═════════════════════════════
//
// It was the first thing tried, and for FIXED WIDTH it wins outright: field k
// of a fixed-width column is `MID(col, start, len)`, which is one derive per
// column and no new vocabulary at all. `deriveStepsForWidths` emits exactly
// that, and the split op is not used on that path when the caller asks for it.
//
// For a DELIMITER it does not work, for four separate reasons:
//
//   1. formula.ts has no SPLIT. The Excel workaround is
//      `TRIM(MID(SUBSTITUTE(c, ",", REPT(" ", 200)), (k-1)*200+1, 200))`, which
//      collapses every run of spaces INSIDE a field (dash's TRIM is
//      `.trim().replace(/\s+/g,' ')`) and truncates any field longer than the
//      pad. Both are silent.
//   2. The delimiter would appear N times, once per derive. Changing it means
//      changing N steps, and N steps that can disagree is a state the model
//      should not be able to represent.
//   3. Quoting. `"Smith, John",Acme` is two fields, and no arrangement of
//      MID/FIND knows that.
//   4. TYPE INFERENCE. The house rule on import is to decide per COLUMN from
//      the whole column and REFUSE where the data cannot decide (import.ts:
//      the date-order ambiguity). `derive` types a column by looking at the
//      values it computed (`inferType`: number if every value is a number),
//      which guesses. A split's outputs must go through `inferColumn`, and
//      that is a decision about all N columns at once, not one expression.
//
// So: a `split` step, declared in model.ts beside the others, executed in
// steps.ts, and reduced to derives on the one arm where derives are honest.

import { coerce, cutField, encodeColumn, inferColumn, splitField, type Inference } from './import.ts'
import type { CanvasCell, CanvasSheet, Column, ColumnType, Step, TableSheet } from './model.ts'
import { readCell, type Patch } from './store.ts'
import { PROVENANCE_OPS } from './steps.ts'

/** How a value is cut. Exactly one of `by` and `widths` is meaningful. */
export interface SplitSpec {
  /** the separator, VERBATIM — never a regexp, so a `.` is a full stop */
  by?: string
  /** fixed-width cut points, in characters from the start */
  widths?: number[]
  /** honour RFC-4180 quoting (delimiter mode only). Default true. */
  quoted?: boolean
  /** trim each field's outer whitespace. Default true. */
  trim?: boolean
}

/** One value into its fields. The single entry point; both arms live here. */
export function splitOne(value: unknown, spec: SplitSpec): string[] {
  const s = value == null ? '' : String(value)
  if (spec.widths && spec.widths.length) return cutField(s, spec.widths, { trim: spec.trim })
  return splitField(s, spec.by ?? '', { quoted: spec.quoted, trim: spec.trim })
}

/**
 * How many columns the split produces.
 *
 * THE WIDEST ROW WINS, and the alternative is worse than it sounds. Taking the
 * first row's field count (Excel's wizard preview does this) drops the tail of
 * every longer row — a middle name, a fourth address line — with nothing on
 * screen to say so. Taking the widest means some rows have blanks in the last
 * columns, which is visible and true.
 *
 * Fixed width is not measured: the cut points ARE the answer.
 */
export function splitWidth(values: readonly unknown[], spec: SplitSpec): number {
  if (spec.widths && spec.widths.length) {
    return spec.widths.filter((n) => Number.isFinite(n) && n > 0).length + 1
  }
  let w = 1
  for (const v of values) w = Math.max(w, splitOne(v, spec).length)
  return w
}

// --- naming ------------------------------------------------------------------

const slug = (s: string, i: number): string =>
  (s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `col-${i + 1}`).slice(0, 40)

/**
 * The columns a split of `source` would produce, named from it.
 *
 * `Name` splits into `Name 1`, `Name 2`, … — numbered rather than guessed at
 * ("First"/"Last" is right for a name column and wrong for everything else,
 * and a wrong name is believed).
 */
export function proposedColumns(
  sourceName: string, sourceId: string, n: number,
): Array<{ id: string; name: string }> {
  return Array.from({ length: n }, (_, i) => ({
    id: `${slug(sourceId, i)}-${i + 1}`,
    name: `${sourceName} ${i + 1}`,
  }))
}

/**
 * Which of the proposed columns ALREADY EXIST, and would therefore be
 * overwritten.
 *
 * Excel says "There's already data here. Do you want to replace it?" and it is
 * right to: a split is the one command whose output size the user cannot see
 * before they run it, so it is the one most likely to land on a neighbour. The
 * caller must not proceed on a non-empty answer without asking.
 *
 * The SOURCE column is never a collision with itself — the split keeps it, and
 * it is not a target.
 */
export function splitCollisions(
  into: ReadonlyArray<{ id: string; name: string }>,
  existing: ReadonlyArray<{ id: string; name: string }>,
  sourceId: string,
): string[] {
  const byId = new Map(existing.map((c) => [c.id, c]))
  const out: string[] = []
  for (const t of into) {
    if (t.id === sourceId) continue
    const hit = byId.get(t.id)
    if (hit) out.push(hit.name)
  }
  return out
}

// --- the plan ------------------------------------------------------------------

export interface SplitFinding {
  code: 'split-empty' | 'split-ambiguous' | 'split-coerce-failed' | 'split-ragged'
  column?: string
  message: string
}

export interface SplitPlan {
  /** one row of raw string fields per input row, padded to `width` */
  fields: string[][]
  width: number
  /** the columns to create, typed by import.ts's inference */
  columns: Column[]
  /** coerced values, per output column, in row order */
  values: unknown[][]
  findings: SplitFinding[]
}

/**
 * Plan a split: cut every value, infer a type per OUTPUT column, coerce.
 *
 * TYPE INFERENCE IS IMPORT'S, not a second one. `inferColumn` reads the whole
 * column, decides one convention for all of it, and REFUSES where the data
 * cannot settle the question — a column of `03/04/2026` comes out as TEXT with
 * a finding rather than as a date that is eleven months wrong. That refusal is
 * the reason `xlsxF` exists and it is the reason this calls into import.ts
 * instead of asking "do these all parse as numbers".
 */
export function planSplit(
  values: readonly unknown[],
  spec: SplitSpec,
  into: ReadonlyArray<{ id: string; name: string }>,
): SplitPlan {
  const width = into.length
  const fields = values.map((v) => {
    const f = splitOne(v, spec)
    return Array.from({ length: width }, (_, i) => f[i] ?? '')
  })
  // a row that produced MORE fields than there are columns loses the tail, and
  // that has to be said out loud rather than trimmed away
  let over = 0
  for (const v of values) if (splitOne(v, spec).length > width) over++

  const findings: SplitFinding[] = []
  if (over) {
    findings.push({
      code: 'split-ragged',
      message: `${over} value${over === 1 ? '' : 's'} split into more than ${width} field${width === 1 ? '' : 's'}; the extra fields are NOT in the result. Add columns, or the tail is dropped.`,
    })
  }

  const columns: Column[] = []
  const out: unknown[][] = []
  into.forEach((t, i) => {
    const raw = fields.map((r) => r[i])
    const inf: Inference = inferColumn(raw)
    if (inf.ambiguous) {
      findings.push({
        code: 'split-ambiguous', column: t.name,
        message: `"${t.name}" looks like dates, but ${inf.ambiguous.detail}. Kept as text — set the column type to choose.`,
      })
    }
    if (inf.failed) {
      findings.push({
        code: 'split-coerce-failed', column: t.name,
        message: `${inf.failed} value${inf.failed === 1 ? '' : 's'} in "${t.name}" could not be read as ${inf.type} and are blank.`,
      })
    }
    if (raw.every((s) => s.trim() === '')) {
      findings.push({
        code: 'split-empty', column: t.name,
        message: `"${t.name}" is empty on every row — the split produced fewer fields than columns.`,
      })
    }
    columns.push({
      id: t.id, name: t.name, type: inf.type as ColumnType,
      ...(inf.parsed ? { parsed: inf.parsed } : {}),
      ...(inf.failed ? { failed: inf.failed } : {}),
    } as Column)
    out.push(raw.map((s) => coerce(s, inf)))
  })
  return { fields, width, columns, values: out, findings }
}

// --- the step ------------------------------------------------------------------

/** The lineage record for a split, in the shape model.ts declares. */
export function splitStep(
  sourceId: string, spec: SplitSpec, into: ReadonlyArray<{ id: string; name: string }>,
): Step {
  return {
    op: 'split',
    col: sourceId,
    ...(spec.widths && spec.widths.length ? { widths: spec.widths.slice() } : { by: spec.by ?? '' }),
    into: into.map((t) => ({ id: t.id, name: t.name })),
    ...(spec.quoted === false ? { quoted: false } : {}),
    ...(spec.trim === false ? { trim: false } : {}),
  } as Step
}

/**
 * The FIXED-WIDTH arm written as ordinary `derive` steps — the answer to "can
 * the pipeline already do this", kept because the answer is interesting and
 * NOT because the command uses it.
 *
 * The CUT it expresses exactly: field k runs from cut point k−1 to cut point k,
 * which is `MID(col, start, len)` and nothing else. What it cannot express is
 * the TYPE. `MID` returns text, so a pipeline of derives makes every output a
 * text column, while the command's own bytes are typed by `inferColumn` —
 * measured: a date column cut at 4 and 7 gave the NUMBER 2026 in the sheet and
 * the STRING "2026" on a re-run. A step list that disagrees with the sheet
 * about a column's type is worse than a new op, and the only way to close it
 * inside `derive` would be to teach `MID` to coerce, which changes what MID
 * means in every other formula in the app.
 *
 * So `planTableSplit` emits a `split` for both arms. This stays exported and
 * checked so the trade-off is on the record rather than in a commit message.
 */
export function deriveStepsForWidths(
  sourceName: string, spec: SplitSpec,
  into: ReadonlyArray<{ id: string; name: string; type?: ColumnType }>,
): Step[] {
  const cuts = (spec.widths ?? []).filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.floor(n)).sort((a, b) => a - b)
  const ref = `[${sourceName}]`
  const steps: Step[] = []
  let at = 0
  into.forEach((t, i) => {
    const end = i < cuts.length ? cuts[i] : Number.POSITIVE_INFINITY
    const len = Number.isFinite(end) ? end - at : 0
    const expr = Number.isFinite(end)
      ? `MID(${ref}, ${at + 1}, ${len})`
      // the last field runs to the end of the value, however long that is
      : `MID(${ref}, ${at + 1}, LEN(${ref}))`
    // THE TYPE COMES FROM THE PLAN, never from a hardcoded 'text' and never
    // from `derive`'s own guess. The step and the bytes the command writes are
    // both typed by import.ts's whole-column inference; if the step declared
    // something else, re-running the pipeline would change a column's type
    // with nobody having edited it. MEASURED while writing the rig: the step
    // said 'text' where the committed column was `number`, so a re-run turned
    // 2026 back into "2026".
    steps.push({
      op: 'derive', col: t.id, name: t.name, expr,
      ...(t.type ? { type: t.type } : {}),
    } as Step)
    if (Number.isFinite(end)) at = end
  })
  return steps
}

// --- the whole command, as patches -----------------------------------------
//
// The two functions below are what the app actually calls. They take the
// document and return the patches, so the RIG can assert the OUTCOME — apply
// them to a Store and read the sheet back — rather than assert that a pure
// helper is correct while nothing on screen changed. That failure has happened
// in this project before and it is the reason these are shaped this way.

/** Every rid of a sheet, in canonical row order. */
function ridList(sheet: TableSheet): number[] {
  const out: number[] = []
  for (const [start, count] of sheet.rids) for (let i = 0; i < count; i++) out.push(start + i)
  return out
}

/** A column's stored values in canonical order, hand corrections included. */
function columnValues(sheet: TableSheet, colId: string, rids: readonly number[]): unknown[] {
  return rids.map((rid, r) => {
    const over = sheet.cells?.[`${colId}:${rid}`]
    if (over && 'v' in over) return over.v
    return readCell(sheet.data[colId], r)
  })
}

export interface TableSplitOutcome {
  patches: Patch[]
  findings: SplitFinding[]
  /** existing columns this split would OVERWRITE — ask before committing */
  collisions: string[]
  /** the columns it will produce, for the confirmation wording */
  into: Array<{ id: string; name: string }>
  /** the lineage the pipeline gains */
  steps: Step[]
  /** set when the command cannot run at all; `patches` is then empty */
  refusal?: string
}

/**
 * Text to Columns on a DATASET.
 *
 * The result is columns written into the sheet's own bytes AND a step recording
 * how they got there. Both, deliberately: nothing in this build runs a base
 * sheet's pipeline (`runSteps` serves derived sheets and SQL), so a step alone
 * would be a command that changes nothing on screen — and bytes alone would be
 * columns with no answer to "where did these come from". They cannot disagree,
 * because both come from `planSplit`, and re-running the step is a no-op: the
 * source column is kept and the outputs are addressed by id.
 *
 * FIXED WIDTH IS RECORDED AS `derive` STEPS, not as a split. `MID(col, s, n)`
 * says exactly what a fixed-width cut is, in vocabulary the pipeline already
 * has and a reader can edit by hand. The delimiter arm cannot be written that
 * way (tocolumns.ts header, four reasons) and gets the `split` op.
 */
export function planTableSplit(
  sheet: TableSheet, colId: string, spec: SplitSpec,
  opts: { into?: ReadonlyArray<{ id: string; name: string }> } = {},
): TableSplitOutcome {
  const col = sheet.columns.find((c) => c.id === colId)
  if (!col) {
    return { patches: [], findings: [], collisions: [], into: [], steps: [], refusal: 'no-column' }
  }
  if (col.formula) {
    return { patches: [], findings: [], collisions: [], into: [], steps: [], refusal: 'computed-column' }
  }
  if (!(spec.widths && spec.widths.length) && !spec.by) {
    return { patches: [], findings: [], collisions: [], into: [], steps: [], refusal: 'no-delimiter' }
  }
  const rids = ridList(sheet)
  const raw = columnValues(sheet, colId, rids)
  const into = opts.into
    ? opts.into.map((t) => ({ id: t.id, name: t.name }))
    : proposedColumns(col.name, col.id, splitWidth(raw, spec))
  const collisions = splitCollisions(into, sheet.columns, colId)
  const plan = planSplit(raw, spec, into)

  const have = new Map(sheet.columns.map((c) => [c.id, c]))
  const patches: Patch[] = []
  // Straight after the source column, in order, which is where a reader looks
  // for them — Excel spills right and so does this.
  let at = sheet.columns.findIndex((c) => c.id === colId) + 1
  plan.columns.forEach((c, i) => {
    const data = encodeColumn(plan.values[i], c.type)
    if (have.has(c.id)) {
      // An EXISTING column is retyped and rewritten in place rather than
      // removed and re-added: removing it would take its position, its width,
      // its conditional formats and every comment anchored to it with it.
      patches.push({
        op: 'setColumn', sheet: sheet.id, col: c.id,
        patch: { name: c.name, type: c.type, parsed: c.parsed, failed: c.failed },
      })
      patches.push({ op: 'setCells', sheet: sheet.id, col: c.id, rids: rids.slice(), v: plan.values[i] })
    } else {
      patches.push({ op: 'addColumn', sheet: sheet.id, column: c, at: at++, data })
    }
  })

  const tail = sheet.steps.filter((s) => !PROVENANCE_OPS.has((s as { op?: string }).op ?? ''))
  // ONE OP FOR BOTH ARMS, and the fixed-width arm's `derive` alternative is
  // kept below rather than used. The reason is a MEASUREMENT, not a
  // preference: `MID()` returns text, so a pipeline of derives types every
  // output column `text`, while the command's own bytes are typed by
  // import.ts's inference — `2026` was a number in the sheet and the string
  // "2026" in the re-run. The bytes and the pipeline disagreeing about a
  // column's TYPE is the failure this whole design is arranged to prevent, and
  // `derive` cannot be made to agree without teaching MID to coerce, which
  // would change what MID means everywhere. So the split op carries both arms
  // and does its own inference in `stepSplit`; `deriveStepsForWidths` stays
  // exported, and its header records what it costs.
  const steps = [splitStep(colId, spec, into)]
  if (patches.length) {
    patches.push({ op: 'applySteps', sheet: sheet.id, steps: [...tail, ...steps] })
  }
  return { patches, findings: plan.findings, collisions, into, steps }
}

export interface CanvasSplitOutcome {
  patches: Patch[]
  findings: SplitFinding[]
  /** cells that already hold something and would be overwritten */
  overwrites: number
  width: number
  refusal?: string
}

/**
 * Text to Columns on a SPREADSHEET — a one-off write of cells, because there is
 * no pipeline to declare it to and no column identity to declare it about.
 *
 * EXCEL'S PLACEMENT, and here it is the right one: field one replaces the
 * source cell and the rest spill right. On a dataset the source column is kept
 * (a step that consumed its input cannot be re-run, and comments and overrides
 * are anchored to that column id); on a spreadsheet a cell is a POSITION,
 * nothing is anchored to it, there is nothing to re-run, and twenty years of
 * muscle memory says the split lands where the data was. The difference is the
 * difference between the kinds, not an inconsistency — but the cells to the
 * right are somebody's data, so `overwrites` counts them and the caller asks.
 *
 * A FORMULA CELL IS NOT SPLIT. Splitting what a formula printed would replace
 * the formula with slices of its own output — the fill bug's shape exactly. It
 * is left alone and counted as a finding.
 */
export function planCanvasSplit(
  sheet: CanvasSheet,
  box: { top: number; bottom: number; col: number },
  spec: SplitSpec,
  key: (row: number, col: number) => string,
): CanvasSplitOutcome {
  if (!(spec.widths && spec.widths.length) && !spec.by) {
    return { patches: [], findings: [], overwrites: 0, width: 0, refusal: 'no-delimiter' }
  }
  const findings: SplitFinding[] = []
  const rows: number[] = []
  const raw: string[] = []
  let skipped = 0
  for (let r = box.top; r <= box.bottom; r++) {
    const cell = sheet.cells[key(r, box.col)]
    if (cell && typeof cell.f === 'string' && cell.f !== '') { skipped++; continue }
    rows.push(r)
    raw.push(cell && cell.v != null ? String(cell.v) : '')
  }
  if (skipped) {
    findings.push({
      code: 'split-empty',
      message: `${skipped} cell${skipped === 1 ? '' : 's'} in the selection hold a formula and were left alone — splitting what a formula printed would replace the formula with pieces of its own output.`,
    })
  }
  const width = splitWidth(raw, spec)
  const cells: Record<string, CanvasCell | null> = {}
  let overwrites = 0
  rows.forEach((r, i) => {
    const fields = splitOne(raw[i], spec)
    for (let k = 0; k < width; k++) {
      const c = box.col + k
      const at = key(r, c)
      const had = sheet.cells[at]
      // k === 0 is the source cell itself, which is being consumed, not overwritten
      if (k > 0 && had && (had.v != null || (typeof had.f === 'string' && had.f !== ''))) overwrites++
      const text = fields[k] ?? ''
      // Appearance, notes and number formats stay: a split moves CONTENT.
      const { v: _v, f: _f, ...rest } = (had ?? {}) as Record<string, unknown>
      const next = text === '' ? rest : { ...rest, v: text }
      cells[at] = Object.keys(next).length ? (next as CanvasCell) : null
      if (cells[at] === null && had === undefined) delete cells[at]
    }
  })
  // The type inference runs for its FINDINGS even though a spreadsheet stores
  // per cell: an ambiguous date column is worth saying out loud on either kind,
  // and it is the same refusal import.ts makes.
  const into = Array.from({ length: width }, (_, i) => ({ id: `f${i}`, name: `Field ${i + 1}` }))
  findings.push(...planSplit(raw, spec, into).findings)
  const patches: Patch[] = Object.keys(cells).length
    ? [{ op: 'setCanvasCells', sheet: sheet.id, cells }]
    : []
  return { patches, findings, overwrites, width }
}
