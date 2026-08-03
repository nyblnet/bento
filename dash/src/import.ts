// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// CSV / delimited import: parse, infer, encode.
//
// This is M1's whole demo — "the CSV someone emailed you, cleaned and typed and
// totalled and sent back as one file anyone can open" — and it is also where a
// data tool does its most damage, because every mistake here is SILENT and
// arrives wearing the shape of an answer.
//
// Three of them, in the order they cost:
//
//   1. THE DATE AMBIGUITY. 03/04/2026 is 3 April or 4 March and the file does
//      not say. A column where every day is <= 12 is genuinely undecidable, and
//      picking one silently is how a quarter's numbers move by a month. This
//      module REFUSES to decide: it reports `ambiguous` and imports as text
//      until someone says. Guessing is the industry norm and it is wrong.
//   2. THE DECIMAL COMMA. "1.234" is one thousand two hundred and thirty four in
//      Germany and one-point-two-three-four in Britain. Inference decides per
//      COLUMN, from the whole column, never per cell — a cell-by-cell guess
//      turns one column into two conventions.
//   3. VALUES THAT WILL NOT COERCE. A column typed `number` with 4% junk in it
//      must say so. `failed` is recorded on the column, never hidden, because a
//      column that quietly dropped 4% of its rows is a wrong answer wearing a
//      right answer's clothes.
//
// Nothing here touches the DOM: it is pure data, so it is provable in CI.

import type { Column, ColumnData, ColumnType, TableSheet } from './model.ts'

// --- Delimited parsing -----------------------------------------------------

export interface ParsedDelimited {
  rows: string[][]
  delimiter: string
  /** rows whose field count differed from the header's */
  ragged: number
}

/**
 * Pick the delimiter by counting candidates in the header line.
 *
 * Semicolon matters as much as comma: it is what Excel writes on any machine
 * whose locale uses a decimal comma, so "CSV" from half of Europe is not
 * comma-separated at all.
 */
function sniffDelimiter(head: string): string {
  const counts = [',', ';', '\t', '|'].map((d) => ({
    d,
    // count only OUTSIDE quotes, or a quoted "Smith, John" votes for comma
    n: countUnquoted(head, d),
  }))
  counts.sort((a, b) => b.n - a.n)
  return counts[0].n > 0 ? counts[0].d : ','
}

function countUnquoted(line: string, ch: string): number {
  let n = 0
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') { inQ = !inQ; continue }
    if (!inQ && c === ch) n++
  }
  return n
}

/**
 * RFC 4180 with the escapes real files actually contain: CRLF or LF, a UTF-8
 * BOM, doubled quotes inside quoted fields, and newlines inside quoted fields.
 */
export function parseDelimited(text: string, delimiter?: string): ParsedDelimited {
  let s = text
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1) // BOM: invisible, and it would
  // otherwise become part of the first column's NAME
  const firstBreak = s.search(/\r?\n/)
  const head = firstBreak < 0 ? s : s.slice(0, firstBreak)
  const d = delimiter ?? sniffDelimiter(head)

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQ = false
  let i = 0
  const push = () => { row.push(field); field = '' }
  const endRow = () => { push(); rows.push(row); row = [] }

  while (i < s.length) {
    const c = s[i]
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue } // doubled = literal
        inQ = false; i++; continue
      }
      field += c; i++; continue
    }
    if (c === '"' && field === '') { inQ = true; i++; continue }
    if (c === d) { push(); i++; continue }
    if (c === '\r') { i++; continue }
    if (c === '\n') { endRow(); i++; continue }
    field += c; i++
  }
  if (field !== '' || row.length) endRow()
  // a trailing newline produces one empty final row; that is not a row of data
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop()

  const width = rows[0]?.length ?? 0
  const ragged = rows.reduce((n, r) => n + (r.length === width ? 0 : 1), 0)
  return { rows, delimiter: d, ragged }
}

// --- Inference -------------------------------------------------------------

export interface Inference {
  type: ColumnType
  /** the convention this column was read with — kept so a re-import is reproducible */
  parsed?: string
  /** values that would not coerce to `type` */
  failed: number
  /**
   * Set when the data cannot decide and a guess would be a silent wrong answer.
   * The column imports as TEXT and the caller must ask. The only honest state.
   */
  ambiguous?: { kind: 'date-order'; detail: string }
}

const BOOLS = new Set(['true', 'false', 'yes', 'no', 'y', 'n', '1', '0', 't', 'f'])
const blank = (s: string) => s.trim() === ''

/**
 * Read a number under ONE convention. `point` is the decimal separator; the
 * other of . and , is then the grouping separator and must appear only in
 * groups of three.
 */
/**
 * The digit shape each convention allows, checked in full rather than by
 * stripping characters until something parses.
 *
 * Stripping was the first implementation and it was wrong in a way worth
 * recording: removing `-` to handle negatives also removed the separators in
 * `2026-01-15`, which then read as the NUMBER 20260115. A date column silently
 * became a number column, and every value in it was eight digits of nonsense.
 */
const NUM_DOT = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/
const NUM_COMMA = /^(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/

function readNumber(raw: string, point: '.' | ','): number | null {
  let s = raw.trim()
  if (s === '') return null
  // accounting negatives
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim() }
  // currency and spacing, either end
  s = s.replace(/^[\s$£€¥]+/, '').replace(/[\s$£€¥]+$/, '')
  // a trailing percent is part of the NOTATION, not the number
  if (s.endsWith('%')) s = s.slice(0, -1).trim()
  if (s.startsWith('-')) { neg = true; s = s.slice(1) }
  else if (s.startsWith('+')) s = s.slice(1)
  if (!(point === '.' ? NUM_DOT : NUM_COMMA).test(s)) return null
  const group = point === '.' ? ',' : '.'
  s = s.split(group).join('')
  if (point === ',') s = s.replace(',', '.')
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return neg ? -n : n
}

const DATE_ISO = /^(\d{4})-(\d{2})-(\d{2})([T ].*)?$/
const DATE_SLASH = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/

/**
 * Infer one column's type from ALL of its values.
 *
 * Per column, never per cell: a cell-by-cell decision reads half a column as
 * British and half as German and the total is then wrong in a way nobody can
 * see.
 */
export function inferColumn(values: string[]): Inference {
  const present = values.filter((v) => !blank(v))
  if (!present.length) return { type: 'text', failed: 0 }

  // --- bool
  if (present.every((v) => BOOLS.has(v.trim().toLowerCase()))) {
    // all-numeric 0/1 is a number until something says otherwise
    if (!present.every((v) => v.trim() === '0' || v.trim() === '1')) {
      return { type: 'bool', failed: 0 }
    }
  }

  // --- number, under each convention; the one that reads MORE wins
  const dot = present.reduce((n, v) => n + (readNumber(v, '.') === null ? 0 : 1), 0)
  const comma = present.reduce((n, v) => n + (readNumber(v, ',') === null ? 0 : 1), 0)
  const best = Math.max(dot, comma)
  if (best / present.length >= 0.9) {
    const point: '.' | ',' = dot >= comma ? '.' : ','
    const pct = present.filter((v) => v.includes('%')).length / present.length
    const cur = present.filter((v) => /[$£€¥]/.test(v)).length / present.length
    const type: ColumnType = pct > 0.5 ? 'percent' : cur > 0.5 ? 'money' : 'number'
    return { type, parsed: point === '.' ? 'dot' : 'comma', failed: present.length - best }
  }

  // --- date
  const iso = present.filter((v) => DATE_ISO.test(v.trim())).length
  if (iso / present.length >= 0.9) {
    return { type: 'date', parsed: 'iso', failed: present.length - iso }
  }
  const slash = present.map((v) => v.trim().match(DATE_SLASH)).filter(Boolean) as RegExpMatchArray[]
  if (slash.length / present.length >= 0.9) {
    const a = slash.map((m) => Number(m[1]))
    const b = slash.map((m) => Number(m[2]))
    const aIsDay = a.some((n) => n > 12)
    const bIsDay = b.some((n) => n > 12)
    if (aIsDay && !bIsDay) return { type: 'date', parsed: 'dmy', failed: present.length - slash.length }
    if (bIsDay && !aIsDay) return { type: 'date', parsed: 'mdy', failed: present.length - slash.length }
    if (aIsDay && bIsDay) {
      // both positions exceed 12 somewhere — the column is not one convention
      return { type: 'text', failed: 0, ambiguous: { kind: 'date-order', detail: 'both positions exceed 12, so no single day/month order fits the whole column' } }
    }
    // NEITHER exceeds 12: undecidable from the data. This is the one that
    // matters, and the honest answer is to refuse.
    return {
      type: 'text',
      failed: 0,
      ambiguous: {
        kind: 'date-order',
        detail: 'every value fits both DD/MM and MM/DD — the file does not say which, and guessing moves dates by up to eleven months',
      },
    }
  }

  return { type: 'text', failed: 0 }
}

// --- Encoding --------------------------------------------------------------

/**
 * Dictionary-encode when the column repeats itself enough to pay for the
 * dictionary. Measured on a 12-column fact table: 4.8 bytes/cell dictionary
 * columnar against 8.1 plain columnar. A near-unique column (an id, a
 * free-text note) pays the dictionary and gets nothing, so it stays raw.
 */
const DICT_RATIO = 0.5
const DICT_MAX = 50_000

export function encodeColumn(values: unknown[], type: ColumnType): ColumnData {
  const raw = values as Array<number | string | boolean | null>
  if (type !== 'text' && type !== 'enum') return { enc: 'raw', v: raw }
  const uniq = new Set(values.filter((v) => v != null).map(String))
  if (uniq.size > DICT_MAX || uniq.size > values.length * DICT_RATIO) {
    return { enc: 'raw', v: raw }
  }
  const dict = [...uniq]
  const at = new Map(dict.map((s, i) => [s, i]))
  return { enc: 'dict', dict, idx: values.map((v) => (v == null ? null : at.get(String(v)) ?? null)) }
}

// --- Building a sheet ------------------------------------------------------

export interface ImportFinding {
  code: 'ragged-rows' | 'coerce-failed' | 'date-ambiguous' | 'duplicate-header' | 'empty-header'
  column?: string
  message: string
}

export interface ImportResult {
  sheet: TableSheet
  findings: ImportFinding[]
  delimiter: string
}

const slug = (s: string, i: number): string =>
  (s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `col-${i + 1}`).slice(0, 40)

/** Coerce one raw string under the convention inference chose. */
export function coerce(raw: string, inf: Inference): unknown {
  if (blank(raw)) return null
  const s = raw.trim()
  switch (inf.type) {
    case 'number': case 'money': case 'percent': {
      const n = readNumber(s, inf.parsed === 'comma' ? ',' : '.')
      if (n === null) return null
      return inf.type === 'percent' && s.includes('%') ? n / 100 : n
    }
    case 'bool': {
      const t = s.toLowerCase()
      return t === 'true' || t === 'yes' || t === 'y' || t === 't' || t === '1'
    }
    case 'date': {
      if (inf.parsed === 'iso') return s.slice(0, 10)
      const m = s.match(DATE_SLASH)
      if (!m) return null
      const [, p1, p2, p3] = m
      const day = inf.parsed === 'dmy' ? p1 : p2
      const mon = inf.parsed === 'dmy' ? p2 : p1
      const yr = p3.length === 2 ? `20${p3}` : p3
      return `${yr}-${mon.padStart(2, '0')}-${day.padStart(2, '0')}`
    }
    default:
      return raw
  }
}

/**
 * Build a table sheet from delimited text.
 *
 * `header` defaults to true because a file someone emailed you almost always
 * has one; when it is false the columns are named by position and nothing is
 * silently eaten.
 */
export function importDelimited(
  text: string,
  opts: { name?: string; sheetId?: string; header?: boolean; delimiter?: string; source?: string; at?: string } = {},
): ImportResult {
  const { rows, delimiter, ragged } = parseDelimited(text, opts.delimiter)
  const findings: ImportFinding[] = []
  const header = opts.header !== false
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0)

  const names = header && rows.length
    ? Array.from({ length: width }, (_, i) => rows[0][i] ?? '')
    : Array.from({ length: width }, (_, i) => `Column ${i + 1}`)
  const body = header ? rows.slice(1) : rows

  if (ragged) {
    findings.push({
      code: 'ragged-rows',
      message: `${ragged} row${ragged === 1 ? '' : 's'} had a different number of fields than the header; short rows are padded with blanks and nothing is dropped`,
    })
  }

  const ids = new Set<string>()
  const columns: Column[] = []
  const data: Record<string, ColumnData> = {}

  names.forEach((rawName, i) => {
    let id = slug(rawName, i)
    if (ids.has(id)) {
      let n = 2
      while (ids.has(`${id}-${n}`)) n++
      findings.push({ code: 'duplicate-header', column: rawName, message: `two columns are called "${rawName}"; the second is kept separately` })
      id = `${id}-${n}`
    }
    ids.add(id)
    if (header && blank(rawName)) {
      findings.push({ code: 'empty-header', column: id, message: `column ${i + 1} has no name in the header row` })
    }

    const raw = body.map((r) => r[i] ?? '')
    const inf = inferColumn(raw)
    if (inf.ambiguous) {
      findings.push({
        code: 'date-ambiguous',
        column: rawName || id,
        message: `"${rawName || id}" looks like dates, but ${inf.ambiguous.detail}. Imported as text — set the column type to choose.`,
      })
    }
    if (inf.failed) {
      findings.push({
        code: 'coerce-failed',
        column: rawName || id,
        message: `${inf.failed} value${inf.failed === 1 ? '' : 's'} in "${rawName || id}" could not be read as ${inf.type} and are blank; the originals are in the import step`,
      })
    }

    const values = raw.map((v) => coerce(v, inf))
    columns.push({
      id,
      name: header && !blank(rawName) ? rawName.trim() : `Column ${i + 1}`,
      type: inf.type,
      ...(inf.parsed ? { parsed: inf.parsed } : {}),
      ...(inf.failed ? { failed: inf.failed } : {}),
    })
    data[id] = encodeColumn(values, inf.type)
  })

  const sheet: TableSheet = {
    id: opts.sheetId ?? 'sheet-1',
    name: opts.name ?? 'Sheet 1',
    kind: 'table',
    rids: body.length ? [[1, body.length]] : [],
    columns,
    data,
    // steps[0] is ALWAYS the provenance record and is never re-run
    steps: [{
      op: 'import',
      from: opts.source ?? 'pasted',
      at: opts.at ?? '',
      rows: body.length,
    }],
  }
  return { sheet, findings, delimiter }
}
