// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// .xlsx — SpreadsheetML in, SpreadsheetML out.
//
// THE REASON THIS EXISTS. Nobody adopts a spreadsheet they cannot get their
// existing files into, or get their work out of. CSV is the interchange format
// people already have and import.ts handles it; .xlsx is the format their work
// is actually IN, and a tool that can only read a flattened, untyped, formula-
// less copy of it is a tool people try once. This module is the other half of
// the door, and the export half matters more than it looks: an importer with no
// exporter is a roach motel, and people can tell.
//
// NO DEPENDENCY, ON PURPOSE. SheetJS is larger than this entire product and
// JSZip roughly doubles it, so either one is paid for by every user who opens
// any workbook, forever, to serve a format many of them never touch. What .xlsx
// needs is a ZIP (zip.ts) and the fraction of SpreadsheetML that carries values,
// types, number formats and formulas. That fraction is this file.
//
// THE THREE SILENT DISASTERS, in the order they cost, because every one of them
// produces a file that OPENS, fills the grid, computes its totals, and is wrong:
//
//   1. THE DATE EPOCH. A workbook is on the 1900 serial system or the 1904 one,
//      and the difference is 1,462 days — four years and a day. Nothing on
//      screen says which; it is one attribute in workbook.xml, and a reader
//      that assumes 1900 shifts every date in every Mac-authored file by four
//      years without a word. Worse, the 1900 system has a deliberate BUG: it
//      believes 1900 was a leap year (Lotus did, and compatibility outlived the
//      reason), so serials 1–59 and 61+ need different epochs and serial 60 is
//      a day that never existed. All three cases are handled below and all
//      three are in the rig.
//   2. PERCENT IS ALREADY A FRACTION. Excel stores 15% as 0.15 and dash stores
//      percent as a fraction too, so the value passes through UNCHANGED. The
//      instinct to multiply by 100 on the way in — because the cell *said* 15 —
//      is how a margin column becomes 1500%.
//   3. THE CACHED VALUE IS THE TRUTH, THE FORMULA IS THE PROVENANCE. A formula
//      cell carries both. Importing only the formula means every cell dash
//      cannot evaluate reads `#NAME?` where a number used to be; importing only
//      the value throws away what the workbook was FOR. So both are taken, and
//      the formula is only made LIVE when dash can actually evaluate it — see
//      `liveFormula` for the three ways that can fail, one of which (a
//      cross-sheet reference) would otherwise resolve silently against the
//      wrong sheet.
//
// AND THE import.ts PRINCIPLE, which is the house style: where the file is
// genuinely AMBIGUOUS, refuse and report rather than pick. `XlsxFinding` is
// deliberately the same shape as `ImportFinding` so one banner renders both.
//
// WHAT IS DELIBERATELY NOT HERE, and why, so nobody thinks it was forgotten:
// charts, images, pivot tables, conditional formatting, data validation,
// comments, defined names, VBA. All of them survive as unread parts on import
// (we drop them) and are not written on export. dash's own chart tiles are
// derived from columns and would have to be REBUILT as DrawingML, which is a
// larger module than this one for a feature whose data is exported anyway.

import {
  readZip, writeZip, ZipError, type ZipEntry,
} from './zip.ts'
import {
  colToLetters, lettersToCol, parseRef, shiftRefsForInsert,
} from './a1.ts'
import { translateCellFormula } from './cellformula.ts'
import { FUNCTIONS } from './formula.ts'
import { readCell } from './store.ts'
import type {
  CellOverride, Column, ColumnData, ColumnType, DashDoc, TableSheet,
} from './model.ts'

// --- findings ---------------------------------------------------------------

/**
 * One thing the import or export decided on your behalf, in the same shape as
 * `import.ts`'s `ImportFinding` — deliberately, so `showFindings` renders both
 * without knowing which produced it. The `code` is for tests and future UI; the
 * `message` is what a person reads.
 */
export interface XlsxFinding {
  code:
    | 'date-system' | 'date-1900-bug' | 'merged-cells' | 'mixed-types'
    | 'coerce-failed' | 'no-header' | 'duplicate-header' | 'empty-header'
    | 'formula-not-live' | 'hidden-sheet' | 'sheet-skipped' | 'time-of-day'
    | 'leading-blanks' | 'formula-column' | 'chart-dropped' | 'renamed-sheet'
  sheet?: string
  column?: string
  message: string
}

export interface XlsxImportResult {
  sheets: TableSheet[]
  findings: XlsxFinding[]
  /** The workbook's own title, if `docProps/core.xml` carried one. */
  title?: string
}

// --- a very small XML reader --------------------------------------------------
//
// DOMParser would be free in the browser and is the obvious choice — and it is
// the wrong one twice over. It does not exist in node, so the rig could not
// test a single line of the import path, which for a format this full of silent
// failures is not a trade worth making; and it builds a full DOM for a
// worksheet that can be a hundred megabytes of XML, when all we do is stream
// through it once.
//
// SCANNING WITH REGEX IS SAFE HERE, and only here, for a reason worth writing
// down: XML forbids a raw `<` in element content and in attribute values, so
// `</c>` cannot appear inside a `<c>` element — a non-greedy match to the next
// close tag cannot overshoot. That guarantee does NOT hold for HTML, and it
// stops holding the moment an element can nest inside itself. None of the
// elements read here can (`row` never contains `row`, `c` never contains `c`).

type Attrs = Map<string, string>

const ATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"/g

/** Attributes of one start tag. A Map, not an object: attribute names come out
 *  of the file, and `__proto__="…"` is legal XML. */
function attrs(s: string): Attrs {
  const out: Attrs = new Map()
  ATTR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR_RE.exec(s))) out.set(m[1], unescapeXml(m[2]))
  return out
}

/** `r:id`, `id`, `x:id` — producers differ on prefixes and we do not care. */
function attr(a: Attrs, name: string): string | undefined {
  const v = a.get(name)
  if (v !== undefined) return v
  for (const [k, val] of a) if (k === name || k.endsWith(`:${name}`)) return val
  return undefined
}

const NS = '(?:[A-Za-z0-9_.-]+:)?'

/** Every `<name …>…</name>` (and `<name …/>`) at any depth, in document order. */
function* elements(xml: string, name: string): Generator<{ a: Attrs; body: string }> {
  const re = new RegExp(`<${NS}${name}(\\s[^>]*?)?\\s*(/>|>([\\s\\S]*?)</${NS}${name}\\s*>)`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) yield { a: attrs(m[1] ?? ''), body: m[3] ?? '' }
}

/** The first such element, or undefined. */
function element(xml: string, name: string): { a: Attrs; body: string } | undefined {
  for (const e of elements(xml, name)) return e
  return undefined
}

const NUM_ENT = /&#(x?)([0-9A-Fa-f]+);/g
const NAMED_ENT: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
}

/**
 * XML text back to a string.
 *
 * `_xHHHH_` is Excel's own escape for characters XML cannot carry, and it is
 * decoded ONLY for control characters (< 0x20). The escape is ambiguous with
 * ordinary text — a product code literally called `_x0041_` exists — and Excel
 * resolves that by escaping the underscore too (`_x005F_x0041_`), which we
 * would have to unwind in the right order to get right. Limiting the decode to
 * control characters keeps the case that actually occurs (`_x000D_`, a carriage
 * return inside a shared string) and cannot corrupt a product code.
 */
export function unescapeXml(s: string): string {
  if (!s) return s
  let out = s
  if (out.includes('&')) {
    out = out.replace(NUM_ENT, (_, hex, digits) =>
      String.fromCodePoint(parseInt(digits, hex ? 16 : 10)))
      .replace(/&(amp|lt|gt|quot|apos);/g, (_, n: string) => NAMED_ENT[n])
  }
  if (out.includes('_x00')) {
    out = out.replace(/_x00([01][0-9A-Fa-f])_/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  }
  return out
}

/**
 * A string into XML text.
 *
 * Control characters are STRIPPED rather than escaped. XML 1.0 simply cannot
 * carry most of them at any encoding, and Excel treats a file containing one as
 * corrupt — the "we found a problem with some content" dialog, which is the
 * exact outcome this whole exporter is judged on. Tab, newline and carriage
 * return are legal and stay.
 */
export function escapeXml(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) continue
    if (c === 0xfffe || c === 0xffff) continue
    out += ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;'
      : ch === '"' ? '&quot;' : ch
  }
  return out
}

// --- dates --------------------------------------------------------------------

/** ms per day, spelled out because a bare 86400000 in date maths is unreadable. */
const DAY = 86_400_000

/**
 * A serial number to an ISO date (or date-time).
 *
 * THE 1900 LEAP BUG, in full, because getting it approximately right is worse
 * than getting it wrong loudly. Excel's 1900 system believes 1900 was a leap
 * year, so its day numbering runs:
 *
 *     1  → 1900-01-01        (epoch 1899-12-31)
 *     59 → 1900-02-28
 *     60 → "1900-02-29"      a day that does not exist
 *     61 → 1900-03-01        (epoch 1899-12-30, and from here on)
 *
 * A single epoch therefore cannot be right for the whole range. Almost every
 * implementation uses 1899-12-30 throughout, which is correct for every date
 * after February 1900 and off by one for every date before it — invisible,
 * unless your data is a century old, in which case it is invisible AND wrong.
 *
 * The 1904 system (Mac Excel's default until 2011, and still what a converted
 * file carries) has no such bug: serial 0 is 1904-01-01.
 */
export function serialToIso(serial: number, epoch1904: boolean, wantTime = false): string | null {
  if (!Number.isFinite(serial)) return null
  const whole = Math.floor(serial)
  const frac = serial - whole
  let ms: number
  if (epoch1904) {
    ms = Date.UTC(1904, 0, 1) + whole * DAY
  } else {
    if (whole === 60) {
      // The impossible day. Reported as a finding by the caller; rendered as
      // Excel renders it, because pretending it is 1900-02-28 or 1900-03-01
      // silently moves someone's data by a day.
      return wantTime ? `1900-02-29T${clock(frac)}` : '1900-02-29'
    }
    ms = (whole < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30)) + whole * DAY
  }
  const d = new Date(ms)
  if (!Number.isFinite(d.getTime())) return null
  const iso = `${String(d.getUTCFullYear()).padStart(4, '0')}-${
    String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  return wantTime ? `${iso}T${clock(frac)}` : iso
}

/** The fraction of a day as `HH:MM:SS`. */
function clock(frac: number): string {
  // Round to the nearest second FIRST: 0.5 of a day held as a float is
  // 11:59:59.999… often enough to matter, and truncating gives 11:59:59.
  let secs = Math.round(frac * 86400)
  if (secs >= 86400) secs = 86399
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/

/**
 * An ISO date string to a 1900-system serial — the inverse of the above, and it
 * has to carry the same leap bug or a round trip moves early-1900 dates by a
 * day. Exports always use the 1900 system, so there is no epoch to choose.
 */
export function isoToSerial(iso: string): number | null {
  const m = ISO_RE.exec(iso.trim())
  if (!m) return null
  const days = (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / DAY
  if (!Number.isFinite(days)) return null
  const time = (Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0)) / 86400
  // Below serial 61 Excel's numbering is one AHEAD of a sane epoch, because of
  // the phantom 29 February.
  return (days < 61 ? days - 1 : days) + time
}

// --- number formats ------------------------------------------------------------

/**
 * The built-in format ids every consumer is required to know. Only the ones
 * that CHANGE A TYPE are listed: 14–22 are dates and times, 9/10 are percent,
 * 5–8 and 37–44 are currency/accounting. Everything else is a number, and 49
 * (`@`) is text.
 *
 * The CJK block (27–36, 50–58) is date formats in the Japanese, Chinese and
 * Korean locales. They are omitted deliberately: they are locale-dependent, a
 * file carrying them will normally also carry an explicit custom format, and
 * claiming a range we have not tested is how a number column becomes a column
 * of 1970s dates.
 */
const BUILTIN: Record<number, 'date' | 'time' | 'percent' | 'money' | 'text'> = {
  5: 'money', 6: 'money', 7: 'money', 8: 'money',
  9: 'percent', 10: 'percent',
  14: 'date', 15: 'date', 16: 'date', 17: 'date', 18: 'time', 19: 'time',
  20: 'time', 21: 'time', 22: 'date',
  37: 'money', 38: 'money', 39: 'money', 40: 'money',
  41: 'money', 42: 'money', 43: 'money', 44: 'money',
  45: 'time', 46: 'time', 47: 'time',
  49: 'text',
}

const CURRENCY = /[$£€¥₹₩]|\[\$|"[A-Z]{3}"/

/**
 * What a custom format code MEANS, for the purpose of choosing a column type.
 *
 * The parsing that matters is what to IGNORE. A format code is full of
 * characters that look like date tokens and are not:
 *
 *   "GBP"     a quoted literal — `m` inside "Amount" is not a month
 *   \-  \(    an escaped character — the `\d` in `#,##0\d` is a literal d
 *   _0        a width-skip whose argument is the NEXT character
 *   [Red]     a colour or a condition — but `[h]` is elapsed hours, a TIME
 *   ;         section separator (positive;negative;zero;text)
 *
 * Stripping those first is the whole job; what remains can be tested for date
 * letters. Not stripping them was the first implementation, and `#,##0;\(#,##0\)`
 * — an ordinary accounting number — came out as a DATE, because of the `\(`.
 */
export function classifyFormat(code: string): 'date' | 'time' | 'percent' | 'money' | 'text' | 'number' {
  if (!code || code === 'General') return 'number'
  const money = CURRENCY.test(code)
  let s = ''
  let elapsed = false
  for (let i = 0; i < code.length; i++) {
    const c = code[i]
    if (c === '"') { const j = code.indexOf('"', i + 1); i = j < 0 ? code.length : j; continue }
    if (c === '\\' || c === '_' || c === '*') { i++; continue }
    if (c === '[') {
      const j = code.indexOf(']', i)
      const inner = code.slice(i + 1, j < 0 ? code.length : j)
      // [h] [hh] [m] [mm] [s] are ELAPSED time, not a colour or a condition.
      if (/^\[?[hms]+\]?$/i.test(inner)) elapsed = true
      i = j < 0 ? code.length : j
      continue
    }
    s += c
  }
  // `@` is the text placeholder, and it beats everything: a column formatted
  // `@` holds text even when every value in it looks like a number, which is
  // exactly what a column of ZIP codes or part numbers with leading zeros is.
  if (s.includes('@')) return 'text'
  if (s.includes('%')) return 'percent'
  const hasDate = /[yd]/i.test(s) || /\bmmm/i.test(s)
  const hasClock = elapsed || /h/i.test(s) || /s/i.test(s)
  // `m` alone is genuinely ambiguous — month or minute — and is resolved by
  // what it sits next to, exactly as Excel resolves it: after `h` or before
  // `s` it is minutes, otherwise it is a month.
  const bareM = /m/i.test(s) && !hasDate && !hasClock
  if (hasDate || bareM) return hasClock ? 'date' : 'date'
  if (hasClock) return 'time'
  if (money) return 'money'
  return 'number'
}

/** Does a date format also carry a time? Used to decide whether to keep one. */
const formatHasTime = (code: string): boolean => /h|\[h\]/i.test(code.replace(/"[^"]*"/g, ''))

// --- reading a workbook --------------------------------------------------------

interface Styles {
  /** cellXfs index → format code ('' = General). */
  xf: string[]
}

function readStyles(xml: string): Styles {
  const codes = new Map<number, string>()
  for (const nf of elements(xml, 'numFmt')) {
    const id = Number(attr(nf.a, 'numFmtId'))
    const code = attr(nf.a, 'formatCode') ?? ''
    if (Number.isFinite(id)) codes.set(id, code)
  }
  // ONLY the cellXfs block. `cellStyleXfs` has an identical `<xf>` shape and
  // comes FIRST in the file, so a scan for every `<xf>` in the document indexes
  // a cell's `s="12"` into the wrong table — the bug produces plausible formats
  // for the first few columns and nonsense after, which reads as random.
  const block = element(xml, 'cellXfs')
  const xf: string[] = []
  if (block) {
    for (const e of elements(block.body, 'xf')) {
      const id = Number(attr(e.a, 'numFmtId') ?? 0)
      xf.push(codes.get(id) ?? BUILTIN_CODE[id] ?? '')
    }
  }
  return { xf }
}

/** A stand-in code for the built-ins we classify by id. Only the letters
 *  matter — `classifyFormat` reads these, nothing displays them. */
const BUILTIN_CODE: Record<number, string> = (() => {
  const out: Record<number, string> = {}
  for (const [id, kind] of Object.entries(BUILTIN)) {
    out[Number(id)] = kind === 'date' ? 'yyyy-mm-dd' : kind === 'time' ? 'hh:mm:ss'
      : kind === 'percent' ? '0%' : kind === 'money' ? '$#,##0.00' : '@'
  }
  return out
})()

function readSharedStrings(xml: string): string[] {
  const out: string[] = []
  for (const si of elements(xml, 'si')) {
    // A rich-text string is a run of `<r><t>…</t></r>`; a plain one is a single
    // `<t>`. Concatenating every `<t>` handles both, and drops the formatting,
    // which dash has nowhere to put.
    let s = ''
    for (const t of elements(si.body, 't')) s += unescapeXml(t.body)
    out.push(s)
  }
  return out
}

/** Resolve a relationship id against a `.rels` part. */
function relTargets(xml: string): Map<string, { target: string; type: string }> {
  const out = new Map<string, { target: string; type: string }>()
  for (const r of elements(xml, 'Relationship')) {
    const id = attr(r.a, 'Id')
    const target = attr(r.a, 'Target')
    if (id && target) out.set(id, { target, type: attr(r.a, 'Type') ?? '' })
  }
  return out
}

/** Join an OPC part path with a relationship target (which may be relative). */
function resolvePart(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : ''
  const parts = (dir + target).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '.' || p === '') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return out.join('/')
}

// --- one worksheet's cells -------------------------------------------------------

interface RawCell {
  /** 0-based */
  row: number
  col: number
  /** the raw `t` attribute: s | str | b | e | inlineStr | d | (absent = number) */
  t: string
  /** style index into cellXfs */
  s: number
  /** the `<v>` text, already unescaped */
  v: string
  /** inline or shared string text, when the value is a string */
  text?: string
  /** formula source WITHOUT a leading `=` */
  f?: string
}

/**
 * Pull every cell out of a worksheet part.
 *
 * SHARED FORMULAS are expanded here, and they are why `translateCellFormula` is
 * imported rather than reimplemented. Excel writes a group of identical
 * formulas once — `<f t="shared" si="0" ref="B2:B99">A2*2</f>` on the master
 * and `<f t="shared" si="0"/>` on the other 97 — and a reader that ignores the
 * followers imports one formula and 97 bare numbers. The translation from the
 * master to each follower is exactly a fill-down, which cellformula.ts already
 * does correctly (including leaving `$`-pinned references alone).
 */
function readSheetCells(xml: string, shared: string[]): {
  cells: RawCell[]; merges: string[]; maxCol: number; widths: Map<number, number>
} {
  const cells: RawCell[] = []
  const merges: string[] = []
  const widths = new Map<number, number>()
  let maxCol = -1

  const masters = new Map<string, { f: string; row: number; col: number }>()

  const data = element(xml, 'sheetData')
  for (const row of elements(data ? data.body : xml, 'row')) {
    const rAttr = Number(attr(row.a, 'r') ?? NaN)
    let cursor = -1
    for (const c of elements(row.body, 'c')) {
      const ref = attr(c.a, 'r')
      const pos = ref ? parseRef(ref) : null
      // A `<c>` may legally omit `r`, in which case it is the next column along.
      const col = pos ? pos.col : cursor + 1
      const rowIdx = pos ? pos.row : (Number.isFinite(rAttr) ? rAttr - 1 : 0)
      cursor = col
      if (col > maxCol) maxCol = col

      const t = attr(c.a, 't') ?? ''
      const s = Number(attr(c.a, 's') ?? 0) || 0
      const vEl = element(c.body, 'v')
      let v = vEl ? unescapeXml(vEl.body) : ''
      let text: string | undefined

      if (t === 's') {
        const i = Number(v)
        text = shared[i] ?? ''
        v = ''
      } else if (t === 'inlineStr') {
        let str = ''
        const is = element(c.body, 'is')
        for (const tEl of elements(is ? is.body : c.body, 't')) str += unescapeXml(tEl.body)
        text = str
      } else if (t === 'str' || t === 'e') {
        text = v
      }

      let f: string | undefined
      const fEl = element(c.body, 'f')
      if (fEl) {
        const kind = attr(fEl.a, 't') ?? ''
        const si = attr(fEl.a, 'si')
        const body = unescapeXml(fEl.body)
        if (kind === 'shared' && si !== undefined) {
          if (body) {
            masters.set(si, { f: body, row: rowIdx, col })
            f = body
          } else {
            const m = masters.get(si)
            // A follower whose master we have not seen is unrecoverable — the
            // file is out of order or damaged. Dropping the formula (and
            // keeping the cached value) loses less than inventing one.
            if (m) f = translateCellFormula(`=${m.f}`, rowIdx - m.row, col - m.col).slice(1)
          }
        } else if (kind !== 'dataTable' && body) {
          f = body
        }
      }

      // A cell with neither a value nor a formula is styling only.
      if (v === '' && text === undefined && f === undefined) continue
      cells.push({ row: rowIdx, col, t, s, v, text, f })
    }
  }

  for (const m of elements(xml, 'mergeCell')) {
    const ref = attr(m.a, 'ref')
    if (ref) merges.push(ref)
  }
  for (const c of elements(xml, 'col')) {
    const min = Number(attr(c.a, 'min') ?? NaN)
    const max = Number(attr(c.a, 'max') ?? NaN)
    const w = Number(attr(c.a, 'width') ?? NaN)
    if (!Number.isFinite(min) || !Number.isFinite(w)) continue
    // Excel's width is in "characters of the default font"; dash's is pixels.
    // 7px per character + 5px of padding is the conversion Excel documents.
    const px = Math.round(w * 7 + 5)
    for (let i = min; i <= (Number.isFinite(max) ? max : min); i++) widths.set(i - 1, px)
  }
  return { cells, merges, maxCol, widths }
}

// --- typing a column ---------------------------------------------------------

type Kind = 'blank' | 'text' | 'number' | 'money' | 'percent' | 'date' | 'time' | 'bool' | 'error'

/** What ONE cell is, given the workbook's styles. The only place a cell's type
 *  is decided; everything downstream aggregates these. */
function kindOf(c: RawCell, styles: Styles): Kind {
  if (c.t === 'e') return 'error'
  if (c.t === 'b') return 'bool'
  if (c.t === 's' || c.t === 'str' || c.t === 'inlineStr') return c.text ? 'text' : 'blank'
  if (c.t === 'd') return 'date' // ISO-in-the-file, an ECMA-376 2nd-edition thing
  if (c.v === '') return 'blank'
  const code = styles.xf[c.s] ?? ''
  const f = classifyFormat(code)
  return f === 'text' ? 'text' : f === 'number' ? 'number' : f
}

/** The four families that are genuinely different KINDS OF DATA, as opposed to
 *  different ways of displaying a number. money/percent/number differ only in
 *  presentation; date and text differ in what the value IS. */
const familyOf = (k: Kind): 'numeric' | 'date' | 'bool' | 'text' | 'blank' =>
  k === 'blank' ? 'blank'
    : k === 'date' ? 'date'
      : k === 'bool' ? 'bool'
        : k === 'number' || k === 'money' || k === 'percent' ? 'numeric'
          : 'text'

/** import.ts's threshold, and the same reasoning: a column that is 90% one
 *  thing has 10% mess in it, which is reported; a column that is 60% one thing
 *  is not one thing. */
const CONSENSUS = 0.9

interface ColumnPlan {
  type: ColumnType
  /** cells that will not survive the chosen type, and become blank */
  failed: number
  /** no family reached consensus: imported as text, and SAID SO */
  ambiguous?: string
  /** the format code the majority of cells carried, kept as `Column.format` */
  format?: string
  /** date cells carried a time of day */
  hasTime?: boolean
}

function planColumn(cells: Array<RawCell | undefined>, styles: Styles): ColumnPlan {
  const present = cells.filter((c): c is RawCell => !!c && kindOf(c, styles) !== 'blank')
  if (!present.length) return { type: 'text', failed: 0 }

  const kinds = present.map((c) => kindOf(c, styles))
  const fam = new Map<string, number>()
  for (const k of kinds) fam.set(familyOf(k), (fam.get(familyOf(k)) ?? 0) + 1)

  let bestFam = 'text'
  let bestN = 0
  for (const [f, n] of fam) if (n > bestN) { bestFam = f; bestN = n }

  if (bestN / present.length < CONSENSUS) {
    return {
      type: 'text',
      failed: 0,
      ambiguous: `${[...fam].map(([f, n]) => `${n} ${f}`).join(', ')} — no single type covers the column`,
    }
  }

  // The format code the winning family mostly carries, so `Column.format` keeps
  // the author's chosen presentation instead of dash inventing one.
  const codes = new Map<string, number>()
  present.forEach((c, i) => {
    if (familyOf(kinds[i]) !== bestFam) return
    const code = styles.xf[c.s] ?? ''
    if (code && code !== 'General') codes.set(code, (codes.get(code) ?? 0) + 1)
  })
  let format: string | undefined
  let topN = 0
  for (const [code, n] of codes) if (n > topN) { topN = n; format = code }

  const failed = present.length - bestN
  if (bestFam === 'date') {
    return { type: 'date', failed, format, hasTime: !!format && formatHasTime(format) }
  }
  if (bestFam === 'bool') return { type: 'bool', failed }
  if (bestFam === 'text') return { type: 'text', failed: 0 }

  // numeric: money vs percent vs number is a DISPLAY choice over the same
  // stored value, so the majority wins and nothing can be lost by getting it
  // wrong beyond a currency sign.
  const sub = new Map<Kind, number>()
  present.forEach((_, i) => {
    if (familyOf(kinds[i]) !== 'numeric') return
    sub.set(kinds[i], (sub.get(kinds[i]) ?? 0) + 1)
  })
  let type: ColumnType = 'number'
  let n = 0
  for (const [k, count] of sub) if (count > n) { n = count; type = k as ColumnType }
  return { type, failed, format }
}

/** Coerce one cell into the column's chosen type. `null` means it would not go. */
function coerceCell(
  c: RawCell | undefined, plan: ColumnPlan, styles: Styles, epoch1904: boolean,
): { v: unknown; lost: boolean; leap1900: boolean } {
  if (!c) return { v: null, lost: false, leap1900: false }
  const k = kindOf(c, styles)
  if (k === 'blank') return { v: null, lost: false, leap1900: false }
  const num = () => (c.v === '' ? NaN : Number(c.v))

  switch (plan.type) {
    case 'date': {
      if (k === 'date' && c.t === 'd') return { v: c.text ?? c.v, lost: false, leap1900: false }
      if (k !== 'date') return { v: null, lost: true, leap1900: false }
      const n = num()
      const iso = serialToIso(n, epoch1904, !!plan.hasTime && n % 1 !== 0)
      return { v: iso, lost: iso === null, leap1900: !epoch1904 && Math.floor(n) === 60 }
    }
    case 'bool': {
      if (k === 'bool') return { v: c.v === '1' || c.v.toLowerCase() === 'true', lost: false, leap1900: false }
      const n = num()
      if (n === 0 || n === 1) return { v: n === 1, lost: false, leap1900: false }
      return { v: null, lost: true, leap1900: false }
    }
    case 'text':
      // Everything has a string form, so nothing is ever lost to a text column.
      // An error cell keeps its code (`#DIV/0!`) — that IS what the cell says.
      if (k === 'text' || k === 'error') return { v: c.text ?? c.v, lost: false, leap1900: false }
      if (k === 'bool') return { v: c.v === '1' ? 'TRUE' : 'FALSE', lost: false, leap1900: false }
      if (k === 'date') {
        const iso = serialToIso(num(), epoch1904)
        return { v: iso ?? c.v, lost: false, leap1900: false }
      }
      if (k === 'time') return { v: clock(num() % 1), lost: false, leap1900: false }
      return { v: c.v, lost: false, leap1900: false }
    default: {
      // number / money / percent — all stored as the plain number Excel holds.
      // PERCENT IS NOT MULTIPLIED: Excel stores 15% as 0.15 and so does dash.
      if (familyOf(k) !== 'numeric') return { v: null, lost: true, leap1900: false }
      const n = num()
      return { v: Number.isFinite(n) ? n : null, lost: !Number.isFinite(n), leap1900: false }
    }
  }
}

// --- formulas ------------------------------------------------------------------

const FN_SET = new Set(FUNCTIONS.map((f) => f.toUpperCase()))
const CALL_RE = /([A-Za-z][A-Za-z0-9_.]*)\s*\(/g

/**
 * Can dash make this formula LIVE, or must it stay a number with the source
 * recorded beside it?
 *
 * Three ways it cannot, and the first is the dangerous one:
 *
 *   1. A SHEET QUALIFIER (`Sheet2!A1`, `'Q1 data'!B7`). a1.ts deliberately
 *      leaves the name before `!` alone — but the `A1` AFTER it is then read as
 *      a reference on THIS sheet, so `Sheet2!A1` would silently resolve against
 *      the wrong sheet's column A. That is a wrong number wearing a right
 *      number's clothes, which is the one outcome this codebase refuses.
 *   2. AN EXTERNAL OR STRUCTURED REFERENCE (`[1]Sheet!A1`, `Table1[Amount]`).
 *      The data it names is not in the file.
 *   3. A FUNCTION dash does not implement. VLOOKUP, INDEX/MATCH, XLOOKUP and
 *      the rest would evaluate to `#NAME?` — visible, not silent, but a grid
 *      full of `#NAME?` where numbers used to be is not an import, it is a
 *      demolition.
 *
 * In all three cases the cached VALUE is kept (so the sheet still reads
 * correctly) and the formula text is preserved on the override under `xlsxF`,
 * which is an additive field: nothing in dash reads it yet, the format promises
 * it survives (PLATFORM §3), and the export half below writes it back out. That
 * is what makes xlsx → dash → xlsx not lose someone's model.
 */
export function liveFormula(src: string): { ok: true } | { ok: false; why: string; fn?: string } {
  // A quoted literal can contain anything; strip it before looking for `!`.
  const bare = src.replace(/"[^"]*"/g, '""')
  if (/'[^']*'\s*!/.test(bare) || /[A-Za-z0-9_.$]\s*!/.test(bare.replace(/#REF!/g, ''))) {
    return { ok: false, why: 'it points at another sheet' }
  }
  if (/\[/.test(bare)) return { ok: false, why: 'it uses an external or table reference' }
  CALL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CALL_RE.exec(bare))) {
    const fn = m[1].toUpperCase()
    if (!FN_SET.has(fn)) return { ok: false, why: `dash has no ${fn}() yet`, fn }
  }
  return { ok: true }
}

// --- import --------------------------------------------------------------------

export interface XlsxImportOpts {
  /** Provenance, written into `steps[0]`. */
  source?: string
  at?: string
  /** Sheet id prefix; ids are `${prefix}-1`, `${prefix}-2`, … */
  idPrefix?: string
  /** Override the header-row decision instead of letting it be inferred. */
  header?: boolean
}

const blank = (s: string): boolean => s.trim() === ''

const slug = (s: string, i: number): string =>
  (s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `col-${i + 1}`).slice(0, 40)

/**
 * Read a .xlsx into dash sheets.
 *
 * Throws only for a container we cannot open at all (`ZipError`, or a package
 * with no workbook part). Everything else is a FINDING: a workbook that is
 * partly readable should open, with the parts we could not read named, rather
 * than refusing wholesale — the person has the file and needs what is in it.
 */
export async function importXlsx(
  bytes: Uint8Array, opts: XlsxImportOpts = {},
): Promise<XlsxImportResult> {
  const parts = await readZip(bytes)
  const dec = new TextDecoder()
  const text = (name: string): string | undefined => {
    const b = parts.get(name)
    return b ? dec.decode(b) : undefined
  }

  // The workbook part is found through the package relationships, never
  // assumed to be `xl/workbook.xml`. It usually is; Numbers and a few
  // generators put it elsewhere, and the cost of doing this properly is four
  // lines.
  const rootRels = text('_rels/.rels')
  let wbPath = 'xl/workbook.xml'
  if (rootRels) {
    for (const r of relTargets(rootRels).values()) {
      if (r.type.endsWith('/officeDocument')) { wbPath = resolvePart('', r.target); break }
    }
  }
  const wbXml = text(wbPath)
  if (!wbXml) throw new ZipError('this .xlsx has no workbook part — it is not a spreadsheet package')

  const wbRels = text(resolvePart(wbPath, `_rels/${wbPath.split('/').pop()}.rels`))
  const rels = wbRels ? relTargets(wbRels) : new Map()

  let sharedPath = ''
  let stylesPath = ''
  for (const r of rels.values()) {
    if (r.type.endsWith('/sharedStrings')) sharedPath = resolvePart(wbPath, r.target)
    else if (r.type.endsWith('/styles')) stylesPath = resolvePart(wbPath, r.target)
  }
  const shared = readSharedStrings(text(sharedPath) ?? '')
  const styles = readStyles(text(stylesPath) ?? '')

  // THE FOUR-YEAR BUG. `date1904` is one attribute and there is no other clue
  // in the file; assuming 1900 shifts every date in a Mac-authored workbook by
  // 1,462 days, silently, and the numbers still look like dates.
  const pr = element(wbXml, 'workbookPr')
  const d1904 = pr ? (attr(pr.a, 'date1904') ?? '') : ''
  const epoch1904 = d1904 === '1' || d1904.toLowerCase() === 'true'

  const findings: XlsxFinding[] = []
  if (epoch1904) {
    findings.push({
      code: 'date-system',
      message: 'This workbook uses the 1904 date system (Mac Excel). Dates were converted from that epoch — read on the 1900 system they would all be four years and a day early.',
    })
  }

  const sheets: TableSheet[] = []
  const prefix = opts.idPrefix ?? `xl-${Math.floor(Date.now() % 1e8).toString(36)}`
  const usedIds = new Set<string>()
  let n = 0

  for (const s of elements(wbXml, 'sheet')) {
    const name = attr(s.a, 'name') ?? `Sheet ${n + 1}`
    const rid = attr(s.a, 'id') ?? ''
    const state = attr(s.a, 'state') ?? ''
    const rel = rels.get(rid)
    if (!rel) {
      findings.push({ code: 'sheet-skipped', sheet: name, message: `"${name}" could not be located in the package and was not imported.` })
      continue
    }
    const partPath = resolvePart(wbPath, rel.target)
    const xml = text(partPath)
    if (xml === undefined) {
      findings.push({ code: 'sheet-skipped', sheet: name, message: `"${name}" is listed in the workbook but its data is missing from the file.` })
      continue
    }
    // A chartsheet has no `sheetData` at all.
    if (rel.type.endsWith('/chartsheet') || !/<(?:[A-Za-z0-9_.-]+:)?sheetData[\s>]/.test(xml)) {
      findings.push({ code: 'chart-dropped', sheet: name, message: `"${name}" is a chart sheet, which has no data of its own; it was not imported.` })
      continue
    }
    if (state === 'hidden' || state === 'veryHidden') {
      findings.push({
        code: 'hidden-sheet', sheet: name,
        message: `"${name}" was hidden in Excel. It was imported anyway — hiding a sheet is not deleting it, and dropping data silently is the worse mistake.`,
      })
    }
    n++
    const id = `${prefix}-${n}`
    usedIds.add(id)
    sheets.push(readOneSheet(xml, name, id, shared, styles, epoch1904, findings, opts))
  }

  if (!sheets.length && !findings.some((f) => f.code === 'sheet-skipped')) {
    throw new ZipError('this workbook contains no worksheets')
  }

  const core = text('docProps/core.xml')
  const title = core ? element(core, 'title')?.body : undefined
  return { sheets, findings: condense(findings), title: title ? unescapeXml(title) : undefined }
}

/** How many of one KIND of finding, on one sheet, are worth listing before the
 *  rest become a count. */
const FINDING_RUN = 3

/**
 * Collapse repetition, without dropping the fact that it happened.
 *
 * A real financial model — measured on a 4-sheet cost model with 34 columns of
 * mixed-type data — produces over EIGHTY findings, one per column, and the
 * banner that was supposed to say "here is what opening this file decided on
 * your behalf" becomes a wall nobody reads. That is a worse outcome than a
 * shorter list: an unread warning and an absent warning are the same warning.
 *
 * So the first few of each (code, sheet) pair are listed in full and the rest
 * become one line with the count. Nothing is hidden — the number is there, and
 * the columns are still flagged on the columns themselves via `failed`.
 */
function condense(findings: XlsxFinding[]): XlsxFinding[] {
  const seen = new Map<string, number>()
  const out: XlsxFinding[] = []
  const extra = new Map<string, { n: number; f: XlsxFinding }>()
  for (const f of findings) {
    const key = `${f.code}${f.sheet ?? ''}`
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    if (n <= FINDING_RUN) out.push(f)
    else extra.set(key, { n: n - FINDING_RUN, f })
  }
  for (const [, { n, f }] of extra) {
    out.push({
      code: f.code, sheet: f.sheet,
      message: `…and ${n} more column${n === 1 ? '' : 's'}${f.sheet ? ` in "${f.sheet}"` : ''} with the same finding.`,
    })
  }
  return out
}

function readOneSheet(
  xml: string, name: string, id: string, shared: string[], styles: Styles,
  epoch1904: boolean, findings: XlsxFinding[], opts: XlsxImportOpts,
): TableSheet {
  const { cells, merges, maxCol, widths } = readSheetCells(xml, shared)

  if (merges.length) {
    findings.push({
      code: 'merged-cells', sheet: name,
      message: `"${name}" has ${merges.length} merged range${merges.length === 1 ? '' : 's'} (${merges.slice(0, 3).join(', ')}${merges.length > 3 ? ', …' : ''}). A merged range holds ONE value, in its top-left cell, and that is where it stayed — filling every cell of the range would turn one spanning heading into a row of repeated values and one total into several.`,
    })
  }

  // The used range. Rows are taken from the first row that has anything in it:
  // a report with four blank rows of letterhead above the table is common, and
  // importing them as empty rows makes every column read as ambiguous.
  const rowsUsed = [...new Set(cells.map((c) => c.row))].sort((a, b) => a - b)
  const firstRow = rowsUsed.length ? rowsUsed[0] : 0
  const lastRow = rowsUsed.length ? rowsUsed[rowsUsed.length - 1] : -1
  const width = maxCol + 1

  // COLUMNS KEEP THEIR POSITION, always from column A. A table starting at C2
  // could have its two empty leading columns trimmed — and then every A1
  // formula in the sheet would point two columns off. Position is what a
  // formula means; an empty column is cosmetic. So the empties stay, and are
  // reported so nobody thinks dash invented them.
  const grid: Array<Array<RawCell | undefined>> = []
  for (const c of cells) {
    const r = c.row - firstRow
    ;(grid[r] ??= [])[c.col] = c
  }

  const headerRow = grid[0] ?? []
  const head = decideHeader(headerRow, grid, styles, opts.header)
  const bodyStart = head.start
  if (bodyStart === 0 && opts.header === undefined) {
    findings.push({
      code: 'no-header', sheet: name,
      message: `"${name}" does not appear to start with a header row (its first row holds values, not labels), so the columns are named by position. Rename them, or re-import telling dash there is a header.`,
    })
  } else if (!head.sure && opts.header === undefined) {
    // The undecidable case, and it costs a ROW OF DATA if we are wrong. Every
    // column of an all-text sheet looks exactly like its own heading, so there
    // is no evidence in the file and the honest thing is to say which way it
    // was resolved rather than to resolve it quietly.
    findings.push({
      code: 'no-header', sheet: name,
      message: `Every column in "${name}" is text, so its first row is indistinguishable from its data. It was taken as a header (which is what it usually is) — if those were values, re-import without one, because a wrong guess here costs a row.`,
    })
  }

  let leadingBlank = 0
  while (leadingBlank < width && !cells.some((c) => c.col === leadingBlank)) leadingBlank++
  if (leadingBlank > 0 && leadingBlank < width) {
    findings.push({
      code: 'leading-blanks', sheet: name,
      message: `"${name}" starts at column ${colToLetters(leadingBlank)}. The ${leadingBlank} empty column${leadingBlank === 1 ? '' : 's'} before it ${leadingBlank === 1 ? 'was' : 'were'} kept, because every A1 formula in the sheet is written against those positions.`,
    })
  }

  const dataRows = grid.slice(bodyStart)
  const rowCount = Math.max(0, lastRow - firstRow + 1 - bodyStart)

  const columns: Column[] = []
  const data: Record<string, ColumnData> = {}
  const overrides: Record<string, CellOverride> = {}
  const ids = new Set<string>()
  let leapSeen = false
  let timeSeen = false
  let notLive = 0
  let liveCount = 0
  const missingFns = new Set<string>()

  for (let ci = 0; ci < width; ci++) {
    const rawName = bodyStart > 0 ? cellText(headerRow[ci], shared, styles, epoch1904) : ''
    let colId = slug(rawName, ci)
    if (ids.has(colId)) {
      let k = 2
      while (ids.has(`${colId}-${k}`)) k++
      findings.push({
        code: 'duplicate-header', sheet: name, column: rawName,
        message: `"${name}" has two columns called "${rawName}"; the second is kept separately.`,
      })
      colId = `${colId}-${k}`
    }
    ids.add(colId)
    if (bodyStart > 0 && blank(rawName)) {
      findings.push({
        code: 'empty-header', sheet: name, column: colId,
        message: `Column ${colToLetters(ci)} of "${name}" has no name in the header row.`,
      })
    }

    const column = Array.from({ length: rowCount }, (_, r) => dataRows[r]?.[ci])
    const plan = planColumn(column, styles)
    if (plan.ambiguous) {
      findings.push({
        code: 'mixed-types', sheet: name, column: rawName || colId,
        message: `"${rawName || colId}" mixes kinds of value (${plan.ambiguous}). Imported as text so nothing is lost — set the column type once you have decided what it is.`,
      })
    }

    const values: unknown[] = []
    let lostHere = 0
    for (let r = 0; r < rowCount; r++) {
      const cell = column[r]
      const out = coerceCell(cell, plan, styles, epoch1904)
      if (out.lost) lostHere++
      if (out.leap1900) leapSeen = true
      // A TIME OF DAY, not "any string with a T in it" — which is what this
      // was, and `Financials` set the flag on a sheet with no dates at all.
      if (plan.type === 'date' && typeof out.v === 'string' && out.v.includes('T')) timeSeen = true
      values.push(out.v)

      if (cell?.f !== undefined) {
        // LIVENESS IS DECIDED ON THE ORIGINAL TEXT, BEFORE ANY SHIFT, and the
        // order is not cosmetic. Shifting first ran `Sheet2!A1*3` through
        // a1.ts, which leaves `Sheet2` alone and then dutifully moves the `A1`
        // after it — off the top of the sheet, into `Sheet2!#REF!*3`. So the
        // very formula we were refusing to trust got corrupted on its way into
        // the field that exists to preserve it verbatim.
        const rid = r + 1
        const key = `${colId}:${rid}`
        const live = liveFormula(cell.f)
        if (live.ok) {
          // Row references shift by exactly the rows we did not import: the
          // blank rows above the table plus the header.
          // `shiftRefsForInsert(..., 0, -k)` is the same call the grid makes
          // when someone deletes k rows at the top, which is precisely what
          // happened to this formula's world.
          const drop = firstRow + bodyStart
          const moved = drop > 0 ? shiftRefsForInsert(cell.f, 'row', 0, -drop) : cell.f
          overrides[key] = { ...(overrides[key] ?? {}), f: `=${moved}` }
          liveCount++
        } else {
          // The value stays (it is in `values` already); the source is kept
          // beside it, EXACTLY as the workbook wrote it, so nothing the author
          // wrote is lost and a re-export puts it back where it came from.
          overrides[key] = { ...(overrides[key] ?? {}), xlsxF: `=${cell.f}` }
          notLive++
          if ('fn' in live && live.fn) missingFns.add(live.fn)
        }
      }
    }

    if (lostHere) {
      findings.push({
        code: 'coerce-failed', sheet: name, column: rawName || colId,
        message: `${lostHere} value${lostHere === 1 ? '' : 's'} in "${rawName || colId}" could not be read as ${plan.type} and ${lostHere === 1 ? 'is' : 'are'} blank.`,
      })
    }

    columns.push({
      id: colId,
      name: bodyStart > 0 && !blank(rawName) ? rawName.trim() : `Column ${ci + 1}`,
      type: plan.type,
      ...(plan.format ? { format: plan.format } : {}),
      ...(plan.failed || lostHere ? { failed: lostHere } : {}),
      ...(widths.has(ci) ? { w: widths.get(ci) } : {}),
    })
    data[colId] = { enc: 'raw', v: values as Array<number | string | boolean | null> }
  }

  if (leapSeen) {
    findings.push({
      code: 'date-1900-bug', sheet: name,
      message: `"${name}" contains serial 60, which Excel displays as 29 February 1900 — a date that does not exist (the 1900 system inherited Lotus 1-2-3's leap-year bug). It was kept as written rather than quietly moved a day.`,
    })
  }
  if (timeSeen) {
    findings.push({
      code: 'time-of-day', sheet: name,
      message: `"${name}" has dates carrying a time of day; they were kept as full ISO date-times so the time is not thrown away.`,
    })
  }
  if (notLive) {
    const fns = [...missingFns].slice(0, 4).join(', ')
    findings.push({
      code: 'formula-not-live', sheet: name,
      message: `${notLive} formula${notLive === 1 ? '' : 's'} in "${name}" could not be made live${fns ? ` (dash has no ${fns} yet)` : ' (they point at other sheets or external data)'}. The values Excel last calculated are shown, and the formula text is kept with each cell so nothing is lost — a live formula dash cannot evaluate would replace real numbers with #NAME?.`,
    })
  }

  return {
    id, name, kind: 'table',
    rids: rowCount ? [[1, rowCount]] : [],
    columns,
    data,
    ...(Object.keys(overrides).length ? { cells: overrides } : {}),
    steps: [{
      op: 'import',
      from: opts.source ?? `${name}.xlsx`,
      at: opts.at ?? '',
      rows: rowCount,
      note: liveCount ? `${liveCount} cell formula(s) imported live` : undefined,
    }],
  } as TableSheet
}

/** The displayed text of a cell, for header names. */
function cellText(
  c: RawCell | undefined, _shared: string[], styles: Styles, epoch1904: boolean,
): string {
  if (!c) return ''
  if (c.text !== undefined) return c.text
  const k = kindOf(c, styles)
  if (k === 'date') return serialToIso(Number(c.v), epoch1904) ?? c.v
  return c.v
}

/**
 * Is the first row a header? Returns where the DATA starts (1 = yes, 0 = no).
 *
 * The test is not "row 1 is all strings" — a column of country names is all
 * strings too. It is that row 1 is all strings AND the rows below it are not,
 * i.e. row 1 looks different from its column. A sheet that is entirely text has
 * no evidence either way, and there the header assumption is right far more
 * often than not (it is what someone typed at the top), so it wins — but the
 * caller reports the no-header decision when it goes the other way, which is
 * the case where the reader loses a row of data to a header if we guess wrong.
 */
function decideHeader(
  head: Array<RawCell | undefined>, grid: Array<Array<RawCell | undefined>>,
  styles: Styles, forced?: boolean,
): { start: number; sure: boolean } {
  if (forced !== undefined) return { start: forced ? 1 : 0, sure: true }
  const filled = head.filter(Boolean) as RawCell[]
  if (!filled.length || grid.length < 2) return { start: filled.length ? 1 : 0, sure: true }
  const allText = filled.every((c) => familyOf(kindOf(c, styles)) === 'text')
  if (!allText) return { start: 0, sure: true }
  // Any non-text below means row 1 is describing rather than being data, and
  // that IS evidence.
  for (let r = 1; r < Math.min(grid.length, 25); r++) {
    for (const c of grid[r] ?? []) {
      const f = c ? familyOf(kindOf(c, styles)) : 'blank'
      if (f !== 'text' && f !== 'blank') return { start: 1, sure: true }
    }
  }
  // Text above text. No evidence at all, and the caller says so.
  return { start: 1, sure: false }
}

// --- export ---------------------------------------------------------------------

export interface XlsxExportOpts {
  /** Timestamp for the ZIP entries. Fixed by default so exports are diffable. */
  at?: Date
  /**
   * sheetId → (columnId → computed values, in canonical row order).
   *
   * A FORMULA COLUMN HAS NO STORED VALUES — that is the point of it (model.ts:
   * storing them would let a file carry a number that disagrees with the
   * expression that produced it) — so an export that does not receive them
   * writes blanks and says so. The editor hands `grid.computed` in, exactly as
   * it does for charts.
   */
  computed?: Record<string, Map<string, unknown[]>>
  /** Skip DEFLATE (rig only). */
  store?: boolean
}

export interface XlsxExportResult {
  bytes: Uint8Array
  findings: XlsxFinding[]
}

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

/**
 * A sheet name Excel will accept.
 *
 * Excel does not warn about a bad sheet name — it refuses to open the file, or
 * "repairs" it, which is the same thing with an extra dialog. The rules are:
 * 1–31 characters, none of `[]:*?/\`, not starting or ending with an
 * apostrophe, and unique within the workbook.
 */
function safeSheetName(name: string, taken: Set<string>): string {
  let s = (name || 'Sheet').replace(/[[\]:*?/\\]/g, '-').replace(/^'+|'+$/g, '').trim()
  if (!s) s = 'Sheet'
  s = s.slice(0, 31)
  if (taken.has(s.toLowerCase())) {
    let k = 2
    let t = `${s.slice(0, 28)} ${k}`
    while (taken.has(t.toLowerCase())) { k++; t = `${s.slice(0, 28)} ${k}` }
    s = t
  }
  taken.add(s.toLowerCase())
  return s
}

/** The style table, built as we go: one xf per (format code, bold) pair. */
class StyleBook {
  codes: string[] = []
  xfs: Array<{ fmt: number; bold: boolean }> = [{ fmt: 0, bold: false }]
  private seen = new Map<string, number>()

  constructor() { this.seen.set('|false', 0) }

  /** The cellXfs index for a format code (`''` = General) and weight. */
  at(code: string, bold = false): number {
    const key = `${code}|${bold}`
    const hit = this.seen.get(key)
    if (hit !== undefined) return hit
    let fmt = 0
    if (code) {
      const i = this.codes.indexOf(code)
      fmt = 164 + (i >= 0 ? i : this.codes.push(code) - 1)
    }
    const at = this.xfs.push({ fmt, bold }) - 1
    this.seen.set(key, at)
    return at
  }

  xml(): string {
    const numFmts = this.codes.length
      ? `<numFmts count="${this.codes.length}">${this.codes.map((c, i) =>
        `<numFmt numFmtId="${164 + i}" formatCode="${escapeXml(c)}"/>`).join('')}</numFmts>`
      : ''
    // The counts and the two fills are not decoration. Excel requires at least
    // the `none` and `gray125` fills and a `cellStyleXfs` entry; a styles part
    // missing either is the single most common cause of the repair dialog.
    return `${DECL}<styleSheet xmlns="${MAIN_NS}">${numFmts}` +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.xfs.length}">${this.xfs.map((x) =>
        `<xf numFmtId="${x.fmt}" fontId="${x.bold ? 1 : 0}" fillId="0" borderId="0" xfId="0"` +
        `${x.fmt ? ' applyNumberFormat="1"' : ''}${x.bold ? ' applyFont="1"' : ''}/>`).join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '<dxfs count="0"/></styleSheet>'
  }
}

/** The number format a column should carry in Excel. The author's own
 *  `Column.format` wins — model.ts says it is an Excel-style pattern and it is
 *  DOCUMENT data, so passing it through is both correct and free. */
function formatFor(col: Column): string {
  if (typeof col.format === 'string' && col.format) return col.format
  switch (col.type) {
    // ISO, deliberately: `mm/dd/yyyy` renders as 4 March in half the world and
    // 3 April in the other half, and the export is what someone else opens.
    case 'date': return 'yyyy-mm-dd'
    case 'percent': return '0.0%'
    case 'money': return moneyFormat(col.unit)
    default: return ''
  }
}

const SYMBOL: Record<string, string> = { USD: '$', GBP: '£', EUR: '€', JPY: '¥', INR: '₹' }

const moneyFormat = (unit: unknown): string => {
  const u = typeof unit === 'string' ? unit.toUpperCase() : ''
  const sym = SYMBOL[u]
  if (sym) return `"${sym}"#,##0.00`
  return u ? `#,##0.00" ${u}"` : '#,##0.00'
}

/** Shared-string table, built while the sheets are written. */
class Strings {
  list: string[] = []
  private at = new Map<string, number>()
  total = 0

  id(s: string): number {
    this.total++
    const hit = this.at.get(s)
    if (hit !== undefined) return hit
    const i = this.list.push(s) - 1
    this.at.set(s, i)
    return i
  }

  xml(): string {
    return `${DECL}<sst xmlns="${MAIN_NS}" count="${this.total}" uniqueCount="${this.list.length}">` +
      this.list.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join('') +
      '</sst>'
  }
}

const AGG_FN: Record<string, string> = {
  sum: 'SUM', avg: 'AVERAGE', count: 'COUNT', min: 'MIN', max: 'MAX',
}

/**
 * Write a dash workbook as .xlsx.
 *
 * WHAT IS EXPORTED AS A FORMULA AND WHAT IS EXPORTED AS A NUMBER, which is the
 * one judgement call in here:
 *
 *   PER-CELL formulas (`CellOverride.f`) go out as formulas. They are already
 *   A1 expressions in Excel's own syntax; the only change they need is a
 *   one-row shift, because dash's row 0 is the first DATA row and Excel's row 1
 *   is the header.
 *
 *   COLUMN formulas go out as VALUES. A dash column expression names columns by
 *   IDENTITY and evaluates over vectors — `Value / SUM(Value)` is one
 *   expression over a whole column — and Excel has no such thing. Translating
 *   it per row is possible for simple arithmetic and stops being possible the
 *   moment the expression uses anything whose Excel counterpart differs even
 *   slightly. A translation that is right 95% of the time produces a workbook
 *   that is wrong 5% of the time and says nothing, which is the failure mode
 *   this whole codebase is organised against. So the numbers go out, and a
 *   finding says the expression did not.
 */
export async function exportXlsx(
  doc: DashDoc, opts: XlsxExportOpts = {},
): Promise<XlsxExportResult> {
  const findings: XlsxFinding[] = []
  const styles = new StyleBook()
  const strings = new Strings()
  const taken = new Set<string>()

  const tables = doc.sheets.filter((s): s is TableSheet => s.kind === 'table')
  if (!tables.length) {
    findings.push({ code: 'sheet-skipped', message: 'This workbook has no table sheets to export.' })
  }

  const sheetXml: string[] = []
  const names: string[] = []

  for (const sheet of tables) {
    const name = safeSheetName(sheet.name, taken)
    if (name !== sheet.name) {
      findings.push({
        code: 'renamed-sheet', sheet: sheet.name,
        message: `"${sheet.name}" was renamed to "${name}": Excel rejects a sheet name over 31 characters or containing []:*?/\\, and refuses to open the file rather than warning.`,
      })
    }
    names.push(name)
    sheetXml.push(writeSheet(sheet, styles, strings, opts, findings))
  }

  const parts: ZipEntry[] = []
  const enc = new TextEncoder()
  const add = (n: string, s: string) => parts.push({ name: n, data: enc.encode(s) })

  // [Content_Types].xml FIRST — a consumer streaming the package cannot type
  // any part until it has read this one, and it is the one ordering rule OPC
  // actually states.
  add('[Content_Types].xml', `${DECL}<Types xmlns="${CT}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheetXml.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>')

  add('_rels/.rels', `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>` +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '</Relationships>')

  add('docProps/core.xml',
    `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"` +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"' +
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(doc.title ?? '')}</dc:title>` +
    `<dc:creator>${escapeXml(String(doc.meta?.author ?? 'bento/dash'))}</dc:creator>` +
    '</cp:coreProperties>')

  // `fullCalcOnLoad` is why no formula cell needs a cached `<v>`: every
  // consumer recalculates on open. A cached value we did not compute would be
  // a number that disagrees with the formula beside it — the exact thing
  // model.ts refuses to store for formula columns.
  add('xl/workbook.xml', `${DECL}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    `<sheets>${names.map((nm, i) =>
      `<sheet name="${escapeXml(nm)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
    '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>')

  add('xl/_rels/workbook.xml.rels',
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${names.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId${names.length + 2}" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/>` +
    '</Relationships>')

  sheetXml.forEach((x, i) => add(`xl/worksheets/sheet${i + 1}.xml`, x))
  // styles LAST of the pair, because writing the sheets is what filled it in
  add('xl/styles.xml', styles.xml())
  add('xl/sharedStrings.xml', strings.xml())

  return { bytes: await writeZip(parts, { at: opts.at, store: opts.store }), findings }
}

/** Rows of one sheet. */
function writeSheet(
  sheet: TableSheet, styles: StyleBook, strings: Strings,
  opts: XlsxExportOpts, findings: XlsxFinding[],
): string {
  const cols = sheet.columns.filter((c) => !c.hidden)
  const rows = sheet.rids.reduce((n, [, c]) => n + c, 0)
  const computed = opts.computed?.[sheet.id]
  const overrides = sheet.cells ?? {}
  const rids: number[] = []
  for (const [start, count] of sheet.rids) for (let i = 0; i < count; i++) rids.push(start + i)

  const headStyle = styles.at('', true)
  const colStyle = cols.map((c) => styles.at(formatFor(c)))

  const out: string[] = []
  out.push(`<row r="1">${cols.map((c, i) =>
    `<c r="${colToLetters(i)}1" s="${headStyle}" t="s"><v>${strings.id(c.name)}</v></c>`).join('')}</row>`)

  for (let r = 0; r < rows; r++) {
    const cells: string[] = []
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i]
      const rid = rids[r]
      const over = overrides[`${col.id}:${rid}`]
      const ref = `${colToLetters(i)}${r + 2}`

      // A per-cell formula: dash's `f`, or the source an import could not make
      // live (`xlsxF`) — writing the latter back out is what closes the
      // xlsx → dash → xlsx loop without losing someone's model.
      const live = typeof over?.f === 'string' ? over.f : undefined
      const src = live ?? (typeof over?.xlsxF === 'string' ? over.xlsxF : undefined)
      if (src) {
        // Down one row — but ONLY for a live formula. `f` is written in dash
        // coordinates, where row 0 is the first DATA row, so it moves to
        // Excel's row 2. `xlsxF` is the source text an import could not make
        // live, kept verbatim in the ORIGINAL workbook's coordinates; shifting
        // it would run a cross-sheet reference through a1.ts, which cannot see
        // past the `!` and would silently renumber the other sheet's row.
        const body = live
          ? shiftRefsForInsert(src.replace(/^=/, ''), 'row', 0, 1)
          : src.replace(/^=/, '')
        // A cached value if dash happens to hold one. It is NOT authoritative —
        // dash computes a formula cell live and never writes the result back,
        // so what is stored underneath may be stale — but `fullCalcOnLoad`
        // means the first thing every consumer does is replace it. Emitting it
        // is what lets an xlsx → dash round trip keep a formula column's TYPE
        // instead of reading a column of empty cells as text.
        const cached = over && 'v' in over ? over.v : readCell(sheet.data[col.id], r)
        const cachedXml = cached === null || cached === undefined || cached === ''
          ? '' : cachedValue(cached, col.type)
        cells.push(`<c r="${ref}" s="${colStyle[i]}"><f>${escapeXml(body)}</f>${cachedXml}</c>`)
        continue
      }

      const v = over && 'v' in over ? over.v
        : computed?.has(col.id) ? computed.get(col.id)![r]
          : col.formula ? undefined
            : readCell(sheet.data[col.id], r)
      const cell = valueCell(ref, colStyle[i], v, col.type, strings)
      if (cell) cells.push(cell)
    }
    if (cells.length) out.push(`<row r="${r + 2}">${cells.join('')}</row>`)
  }

  for (const col of cols) {
    if (col.formula && !computed?.has(col.id)) {
      findings.push({
        code: 'formula-column', sheet: sheet.name, column: col.name,
        message: `"${col.name}" is a computed column (${col.formula}) and its values were not available to the export, so it is empty. Excel has no equivalent of a whole-column expression, so the numbers are what travels — export from the editor, where they have been calculated.`,
      })
    } else if (col.formula) {
      findings.push({
        code: 'formula-column', sheet: sheet.name, column: col.name,
        message: `"${col.name}" is a computed column (${col.formula}). Excel has no whole-column expression, so its VALUES were exported rather than a per-row translation — a translation that is right most of the time is worse than numbers that are right all of it.`,
      })
    }
  }

  // The totals row. Written as real SUM/AVERAGE formulas over the data range
  // AND with the value we computed, so it reads correctly before a recalc.
  let totalsXml = ''
  if (sheet.totals && Object.keys(sheet.totals).length && rows) {
    const cells: string[] = []
    cols.forEach((col, i) => {
      const spec = sheet.totals![col.id]
      if (!spec) return
      const ref = `${colToLetters(i)}${rows + 2}`
      const range = `${colToLetters(i)}2:${colToLetters(i)}${rows + 1}`
      if (typeof spec === 'object' && typeof spec.f === 'string') {
        cells.push(`<c r="${ref}" s="${colStyle[i]}"><f>${escapeXml(spec.f.replace(/^=/, ''))}</f></c>`)
        return
      }
      const fn = AGG_FN[spec as string]
      if (!fn) return
      const nums: number[] = []
      for (let r = 0; r < rows; r++) {
        const raw = computed?.has(col.id) ? computed.get(col.id)![r] : readCell(sheet.data[col.id], r)
        const n = typeof raw === 'number' ? raw : Number(raw)
        if (Number.isFinite(n) && raw !== null && raw !== '') nums.push(n)
      }
      const value = fn === 'SUM' ? nums.reduce((a, b) => a + b, 0)
        : fn === 'AVERAGE' ? (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0)
          : fn === 'COUNT' ? nums.length
            : fn === 'MIN' ? Math.min(...nums) : Math.max(...nums)
      const shown = Number.isFinite(value) ? value : 0
      cells.push(`<c r="${ref}" s="${colStyle[i]}"><f>${fn}(${range})</f><v>${shown}</v></c>`)
    })
    if (cells.length) totalsXml = `<row r="${rows + 2}">${cells.join('')}</row>`
  }

  const widths = cols.map((c, i) => typeof c.w === 'number' && c.w > 0
    ? `<col min="${i + 1}" max="${i + 1}" width="${Math.max(2, (c.w - 5) / 7).toFixed(2)}" customWidth="1"/>`
    : '').join('')

  const lastRow = rows + (totalsXml ? 2 : 1)
  return `${DECL}<worksheet xmlns="${MAIN_NS}">` +
    `<dimension ref="A1:${colToLetters(Math.max(0, cols.length - 1))}${Math.max(1, lastRow)}"/>` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (widths ? `<cols>${widths}</cols>` : '') +
    `<sheetData>${out.join('')}${totalsXml}</sheetData></worksheet>`
}

/**
 * The `<v>` to sit beside an `<f>`, for NUMERIC results only.
 *
 * A text or boolean result would need its own `t` attribute on the enclosing
 * `<c>`, which is written before we know the value; and a formula whose result
 * is text is rare enough that carrying no cached value (and letting
 * `fullCalcOnLoad` fill it in) costs nothing. Numbers are the case that matters,
 * because they are what a re-import types the column from.
 */
function cachedValue(v: unknown, type: ColumnType): string {
  if (type === 'date') {
    const s = typeof v === 'number' ? v : isoToSerial(String(v))
    return s === null ? '' : `<v>${s}</v>`
  }
  const n = typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? `<v>${n}</v>` : ''
}

/** One value cell, or '' for a blank (a blank cell is simply absent in xlsx —
 *  writing `<c r="B7"/>` for every empty cell doubles a sparse sheet). */
function valueCell(
  ref: string, style: number, v: unknown, type: ColumnType, strings: Strings,
): string {
  if (v === null || v === undefined || v === '') return ''
  if (typeof v === 'boolean') return `<c r="${ref}" s="${style}" t="b"><v>${v ? 1 : 0}</v></c>`
  if (type === 'date') {
    const serial = typeof v === 'number' ? v : isoToSerial(String(v))
    // A date column with something in it that is not a date keeps the text
    // rather than becoming a wrong day.
    if (serial === null) return `<c r="${ref}" s="${style}" t="s"><v>${strings.id(String(v))}</v></c>`
    return `<c r="${ref}" s="${style}"><v>${serial}</v></c>`
  }
  if (typeof v === 'number') {
    // NaN and Infinity have no XSD double spelling; Excel calls the file
    // corrupt rather than showing an error, so they go out as error cells.
    if (!Number.isFinite(v)) return `<c r="${ref}" s="${style}" t="e"><v>#NUM!</v></c>`
    return `<c r="${ref}" s="${style}"><v>${v}</v></c>`
  }
  const s = String(v)
  // A dash cell can hold a formula ERROR value; it round-trips as an error cell
  // rather than as the literal text "#DIV/0!".
  if (/^#(DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|NULL!|CYCLE!)$/.test(s)) {
    return `<c r="${ref}" s="${style}" t="e"><v>${escapeXml(s === '#CYCLE!' ? '#REF!' : s)}</v></c>`
  }
  return `<c r="${ref}" s="${style}" t="s"><v>${strings.id(s)}</v></c>`
}

/** A filename for the download. `.xlsx`, never `.xls` — the extension is what
 *  every consumer sniffs first. */
export const xlsxFileName = (title: string): string =>
  `${(title || 'Workbook').replace(/[/\\:*?"<>|]/g, '-').slice(0, 80)}.xlsx`

export const _internals = {
  attrs, attr, elements, element, planColumn, decideHeader, readStyles,
  readSharedStrings, readSheetCells, resolvePart, safeSheetName, valueCell,
  clock, lettersToCol,
}
