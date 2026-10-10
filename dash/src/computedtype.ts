// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// What TYPE is a formula column?
//
// A computed column used to be born `number`, hardcoded, whatever the
// expression returned. Measured: `TRIM(LEFT(Name, FIND(",", Name) - 1))` over a
// "Lastname, Firstname" column produced a column of surnames with a NUMBER
// badge on its header, right-aligned, offering numeric filter operators, sorted
// as numbers, exported as numbers, and totalling to nothing. Everything
// downstream of a column's type was wrong at once, and none of it said so.
//
// THE JS TYPE OF THE VALUE DECIDES THE CLASS, NOT ITS APPEARANCE. This is the
// one rule here and it is not a style preference — it is finding 1 of the
// bounce test refusing to come back. `aggregate` (grid.ts) skips anything that
// is not `typeof v === 'number'`, so a column DECLARED number whose values are
// the strings "1,240.00" reads as a number column everywhere and totals to
// `SUM 0`. An inference that looked at how the values PRINT would manufacture
// exactly that state, from the one place in the app that creates columns
// nobody typed. So: numbers make a number column, booleans make a bool column,
// and strings do not become numbers here no matter how numeric they look.
//
// WITHIN THE STRING CLASS THE QUESTION IS import.ts's. `inferColumn(values)`
// already asks "what is this text really?" of parsed CSV, and computed strings
// are the same question about different input — so it is reused rather than
// re-answered, INCLUDING its documented "cannot decide" state (`ambiguous`,
// the DD/MM vs MM/DD refusal), which lands here as text exactly as it lands on
// an import. Its answer is then CLAMPED to the types a string can actually be
// stored as: `date`, and only when the strings are already ISO, because that is
// the one date shape whose stored form is the string itself (import.ts
// `coerce`). A number/money/percent verdict over strings is refused — see
// above; that verdict is the SUM 0 bug with a nicer origin story.
//
// ERRORS AND BLANKS ARE NOT EVIDENCE. Three `#N/A` rows in a thousand-row
// numeric column do not make it a text column, so they are skipped when
// judging. When they are ALL there is, there is nothing to judge.
//
// AND WHEN IT CANNOT DECIDE, THE ANSWER IS TEXT. Mixed numbers and strings have
// no single right answer, and text is the only type that makes no claim: it
// does not right-align, applies no number pattern, promises no total, and loses
// nothing — the author can set the type by hand and the values are all still
// there. A wrong number is worse than an unopinionated column.
//
// A COMPUTED COLUMN HAS NO STORED BYTES, so `validate.ts`'s
// `type-storage-mismatch` check skips it whatever this returns (it skips any
// column with a formula, by design). Nothing here can make a document that
// trips it, and `scripts/test-dash-computedtype.ts` asserts that rather than
// assuming it.

import { isErr, recalc } from './formula.ts'
import { inferColumn } from './import.ts'
import type { Column, ColumnType, TableSheet } from './model.ts'

/** Why a type was chosen — for the rig, and for anything that wants to say so. */
export type ComputedWhy = 'number' | 'bool' | 'text' | 'mixed' | 'nothing'

export interface ComputedType {
  type: ColumnType
  why: ComputedWhy
  /** values that were real evidence: not blank, not an error */
  judged: number
}

const blankish = (v: unknown): boolean =>
  v == null || (typeof v === 'string' && v.trim() === '')

/**
 * The type for a column holding exactly these computed values.
 *
 * Pure, and separated from the evaluation above it so the rig can hand it the
 * awkward shapes directly instead of contriving an expression that produces
 * them.
 */
export function judgeComputed(values: readonly unknown[]): ComputedType {
  const seen: unknown[] = []
  for (const v of values) {
    if (blankish(v) || isErr(v)) continue
    seen.push(v)
  }
  if (!seen.length) return { type: 'text', why: 'nothing', judged: 0 }

  if (seen.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return { type: 'number', why: 'number', judged: seen.length }
  }
  if (seen.every((v) => typeof v === 'boolean')) {
    return { type: 'bool', why: 'bool', judged: seen.length }
  }
  if (!seen.every((v) => typeof v === 'string')) {
    return { type: 'text', why: 'mixed', judged: seen.length }
  }

  // All strings: import.ts's question, and its answer, clamped to the types a
  // string is actually stored as.
  const inf = inferColumn(seen as string[])
  const type: ColumnType = inf.ambiguous ? 'text'
    : inf.type === 'date' && inf.parsed === 'iso' ? 'date'
      : 'text'
  return { type, why: 'text', judged: seen.length }
}

const PROBE_ID = '__dash_type_probe__'

/**
 * Run `expr` against `sheet` and judge what it produced.
 *
 * `replacing` is the column the expression belongs to when one already exists —
 * substituted in place rather than appended, so a self-reference is still the
 * cycle `recalc` reports rather than a second column with the same name
 * shadowing the first.
 */
export function inferComputedType(
  sheet: TableSheet, expr: string, replacing?: string,
): ComputedType {
  if (!expr.trim()) return { type: 'text', why: 'nothing', judged: 0 }
  const probe: Column = { id: PROBE_ID, name: PROBE_ID, type: 'text', formula: expr }
  const columns = replacing && sheet.columns.some((c) => c.id === replacing)
    ? sheet.columns.map((c) => (c.id === replacing ? { ...c, formula: expr } : c))
    : [...sheet.columns, probe]
  const id = replacing && columns.some((c) => c.id === replacing) ? replacing : PROBE_ID
  let values: unknown[] = []
  try {
    values = (recalc({ ...sheet, columns }).values.get(id) ?? []) as unknown[]
  } catch {
    // An expression the engine cannot even attempt is not evidence of a type.
    // The dialog's own `check` is what reports a bad formula; this must not
    // throw over one, or the Add-column button dies mid-click.
    return { type: 'text', why: 'nothing', judged: 0 }
  }
  return judgeComputed(values)
}
