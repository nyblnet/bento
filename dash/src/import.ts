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
import { t } from './i18n.ts'
import { TYPE_LABEL } from './format.ts'

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

/**
 * Split ONE value into fields — Text to Columns' delimiter arm.
 *
 * It is `parseDelimited` and not a second parser, deliberately. A cell holding
 * `Smith, John","Acme` has to obey the same quoting rule as the same bytes in a
 * file, and the moment there are two implementations of "where does this field
 * end" they disagree on exactly the values nobody tests: doubled quotes, a
 * quote that is not at the start of a field, an embedded newline. So the value
 * is handed to the file parser as a one-line file and the row comes back.
 *
 * `quoted:false` is the escape hatch for data that CONTAINS quotes as text — a
 * measurement column of `5" pipe` — where treating one as a delimiter boundary
 * would swallow the rest of the row. It splits on the separator and nothing
 * else.
 *
 * The empty value is ONE empty field, not zero: a blank row still occupies its
 * columns, and returning `[]` would leave whatever was there untouched, which
 * is a split the user believes landed.
 */
export function splitField(
  value: string,
  by: string,
  opts: { quoted?: boolean; trim?: boolean } = {},
): string[] {
  if (by === '') return [value]
  let raw: string[]
  if (opts.quoted === false) raw = value.split(by)
  else if (value.includes('\n') || value.includes('\r')) {
    // A newline inside the value ENDS parseDelimited's row, which would drop
    // every field after it. Swapped for a sentinel across the parse and put
    // back afterwards — and only when there IS one, so an ordinary value can
    // never be rewritten by the substitution.
    const NL = '\u0000'
    const flat = value.split('\r\n').join(NL).split('\n').join(NL).split('\r').join(NL)
    raw = (parseDelimited(flat, by).rows[0] ?? ['']).map((f) => f.split(NL).join('\n'))
  } else raw = parseDelimited(value, by).rows[0] ?? ['']
  const fields = raw.length ? raw : ['']
  return opts.trim === false ? fields : fields.map((f) => f.trim())
}

/**
 * Cut one value at fixed character positions. `widths` are cut points measured
 * from the start of the string, so `[3, 7]` produces three fields.
 *
 * A value SHORTER than a cut point yields empty fields rather than dropping
 * them — the column count is a property of the split, not of the longest row.
 */
export function cutField(value: string, widths: number[], opts: { trim?: boolean } = {}): string[] {
  const cuts = widths.filter((n) => Number.isFinite(n) && n > 0).map((n) => Math.floor(n))
    .sort((a, b) => a - b)
  const out: string[] = []
  let at = 0
  for (const c of cuts) { out.push(value.slice(at, c)); at = c }
  out.push(value.slice(at))
  return opts.trim === false ? out : out.map((f) => f.trim())
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
  /** `fits`: 'none' — both positions pass 12 somewhere; 'both' — every value
   *  reads either way. `detail` is the developer's sentence, for the rig. */
  ambiguous?: { kind: 'date-order'; detail: string; fits?: 'none' | 'both' }
}

const BOOLS = new Set(['true', 'false', 'yes', 'no', 'y', 'n', '1', '0', 't', 'f'])
const blank = (s: string) => s.trim() === ''

/**
 * The digit shape each convention allows, checked in full rather than by
 * stripping characters until something parses.
 *
 * Stripping was the first implementation and it was wrong in a way worth
 * recording: removing `-` to handle negatives also removed the separators in
 * `2026-01-15`, which then read as the NUMBER 20260115. A date column silently
 * became a number column, and every value in it was eight digits of nonsense.
 */
const NUM_DOT = /^(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)$/
const NUM_COMMA = /^(?:(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?|,\d+)$/
/** Exponent notation, which only the dot convention spells (`1e3`, `2.5E-4`). */
const NUM_EXP = /^\d+(?:\.\d+)?[eE][-+]?\d+$/

/**
 * The currency marks worth peeling — a symbol a person would type, not every
 * glyph in Unicode — plus the `US$` / `A$` / `C$` spellings. Either end of the
 * field: `$5` and `5 €` are both how somebody writes money.
 */
const SYM_LEAD = /^(?:[$£€¥₹₽₩₪₺]|[A-Z]{1,3}\$)\s?/
const SYM_TRAIL = /\s?(?:[$£€¥₹₽₩₪₺])$/

/** A number field with its NOTATION taken off: sign, currency mark, percent. */
interface Peeled { neg: boolean; symbol: string; pct: boolean; body: string }

function peel(raw: string): Peeled | null {
  let s = raw.trim()
  if (s === '') return null
  let neg = false
  // accounting negatives — `(1,200)` is -1200, and the only bracket form worth it
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim() }
  let symbol = ''
  const lead = s.match(SYM_LEAD)
  if (lead) { symbol = lead[0].trim(); s = s.slice(lead[0].length).trim() }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1).trim() }
  else if (s.startsWith('+')) s = s.slice(1).trim()
  // the symbol may sit after the sign — `-$5` as well as `$-5`
  if (!symbol) {
    const again = s.match(SYM_LEAD)
    if (again) { symbol = again[0].trim(); s = s.slice(again[0].length).trim() }
  }
  // a trailing percent is part of the NOTATION, not the number
  let pct = false
  if (s.endsWith('%')) { pct = true; s = s.slice(0, -1).trim() }
  if (!symbol) {
    const trail = s.match(SYM_TRAIL)
    if (trail) { symbol = trail[0].trim(); s = s.slice(0, -trail[0].length).trim() }
  }
  if (!pct && s.endsWith('%')) { pct = true; s = s.slice(0, -1).trim() }
  if (!/\d/.test(s)) return null
  return { neg, symbol, pct, body: s }
}

/** The digits of a peeled body under ONE convention, or null. */
function digitsUnder(body: string, point: '.' | ','): number | null {
  if (!(point === '.' ? NUM_DOT : NUM_COMMA).test(body)) return null
  const group = point === '.' ? ',' : '.'
  let s = body.split(group).join('')
  if (point === ',') s = s.replace(',', '.')
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * Read a number under ONE convention. `point` is the decimal separator; the
 * other of . and , is then the grouping separator and must appear only in
 * groups of three. This is what `inferColumn` votes with, column by column.
 *
 * The percent is NOT applied here: a column decides that once, in `coerce`.
 */
function readNumber(raw: string, point: '.' | ','): number | null {
  const p = peel(raw)
  if (!p) return null
  const n = digitsUnder(p.body, point)
  if (n === null) return null
  return p.neg ? -n : n
}

/** One typed field, read as a number, with the notation it was written in. */
export interface EntryNumber {
  /** the value — a `%` has ALREADY been applied, so `15%` is 0.15 */
  n: number
  /** the field carried a `%` */
  pct: boolean
  /** the currency mark it carried, verbatim (`$`, `£`, `US$`), or '' */
  symbol: string
  /** decimals actually written, so a stamped format can match what was typed */
  dp: number
  /** the field carried a thousands separator */
  group: boolean
}

/**
 * ONE field, read as a number — the reading every single-value caller shares:
 * typing into a spreadsheet cell (cellprops.ts `coerceInput`), a TSV paste, the
 * formula engine coercing text in arithmetic (formula.ts `num`), and `VALUE()`.
 *
 * The SAME digit shapes `inferColumn` votes with, so a value means the same
 * thing typed, pasted, imported and computed. What a single value cannot do is
 * vote, so the decimal convention is settled the only other way there is:
 *
 *   • when the field reads under exactly ONE convention, that one — `3,50` is
 *     3.5 to everybody, because `,50` cannot be a thousands group;
 *   • when it reads under BOTH (`1,234`, `1.234`), `prefer` decides. A typist's
 *     entry passes the VIEWER's decimal separator, which is what that person
 *     meant by what they typed; the formula engine passes '.', import's own
 *     tie-break, because a formula result is DOCUMENT data and must come out
 *     the same for every reader of the file.
 *
 * `strict` is cellprops.ts rule 3: a leading zero (`007`) disqualifies the
 * field, because in an unformatted cell the zeros are the information.
 */
export function readEntryNumber(
  raw: string, opts: { prefer?: '.' | ','; strict?: boolean } = {},
): EntryNumber | null {
  const p = peel(raw)
  if (!p) return null
  const prefer = opts.prefer ?? '.'
  let n: number | null = null
  let point: '.' | ',' = '.'
  if (NUM_EXP.test(p.body)) {
    n = Number(p.body)
  } else {
    const dot = digitsUnder(p.body, '.')
    const comma = digitsUnder(p.body, ',')
    if (dot !== null && comma !== null) { point = prefer; n = prefer === '.' ? dot : comma }
    else if (dot !== null) { point = '.'; n = dot }
    else if (comma !== null) { point = ','; n = comma }
  }
  if (n === null || !Number.isFinite(n)) return null
  if (opts.strict && /^0\d/.test(p.body)) return null
  const group = point === '.' ? ',' : '.'
  const eAt = p.body.search(/[eE]/)
  const mant = eAt < 0 ? p.body : p.body.slice(0, eAt)
  const at = mant.indexOf(point)
  let v = p.neg ? -n : n
  if (p.pct) v /= 100
  return {
    n: v,
    pct: p.pct,
    symbol: p.symbol,
    dp: at < 0 ? 0 : mant.length - at - 1,
    group: mant.includes(group),
  }
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
      return { type: 'text', failed: 0, ambiguous: { kind: 'date-order', fits: 'none', detail: 'both positions exceed 12, so no single day/month order fits the whole column' } }
    }
    // NEITHER exceeds 12: undecidable from the data. This is the one that
    // matters, and the honest answer is to refuse.
    return {
      type: 'text',
      failed: 0,
      ambiguous: {
        kind: 'date-order',
        fits: 'both',
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
      message: ragged === 1
        ? t('1 row had a different number of fields than the header; short rows were padded with blanks and nothing was dropped.')
        : t('{n} rows had a different number of fields than the header; short rows were padded with blanks and nothing was dropped.', { n: ragged }),
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
      findings.push({ code: 'duplicate-header', column: rawName, message: t('Two columns are called “{column}”; the second is kept as a separate column.', { column: rawName }) })
      id = `${id}-${n}`
    }
    ids.add(id)
    if (header && blank(rawName)) {
      findings.push({ code: 'empty-header', column: id, message: t('Column {n} has no name in the header row.', { n: i + 1 }) })
    }

    const raw = body.map((r) => r[i] ?? '')
    const inf = inferColumn(raw)
    if (inf.ambiguous) {
      findings.push({
        code: 'date-ambiguous',
        column: rawName || id,
        message: inf.ambiguous.fits === 'both'
          ? t('“{column}” looks like dates, but every value reads as either DD/MM or MM/DD and the file doesn’t say which. It came in as text — set the column type to choose.', { column: rawName || id })
          : t('“{column}” looks like dates, but no single day/month order fits every value. It came in as text — set the column type to choose.', { column: rawName || id }),
      })
    }
    if (inf.failed) {
      findings.push({
        code: 'coerce-failed',
        column: rawName || id,
        message: inf.failed === 1
          ? t('1 value in “{column}” couldn’t be read as {type} and was left blank; the original is kept in the import step.', { column: rawName || id, type: t(TYPE_LABEL[inf.type]) })
          : t('{n} values in “{column}” couldn’t be read as {type} and were left blank; the originals are kept in the import step.', { n: inf.failed, column: rawName || id, type: t(TYPE_LABEL[inf.type]) }),
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
