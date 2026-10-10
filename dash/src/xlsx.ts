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
// WHAT IS CARRIED BESIDES VALUES, because a file that says something dash can
// hold and is not asked is a loss dash chose: data validation (`DataRule`),
// defined names (`doc.names`), frozen panes (`sheet.frozen`), per-cell bold,
// colour, background and borders (`APPEARANCE_FIELDS`), and an Excel table's
// TOTALS ROW as the column property it already is in Microsoft's schema.
//
// WHAT IS DELIBERATELY NOT HERE, and why, so nobody thinks it was forgotten:
// charts, images, pivot tables, conditional formatting, comments, VBA. All of
// them survive as unread parts on import (we drop them) and are not written on
// export. dash's own chart tiles are derived from columns and would have to be
// REBUILT as DrawingML, which is a larger module than this one for a feature
// whose data is exported anyway. Conditional formatting is the one of those
// dash could hold today (condfmt.ts) and is left for the pass that also gives
// the four unreachable rule kinds a dialog — half of it, imported into a UI
// that cannot show or edit it, is a rule nobody can find.

import {
  readZip, writeZip, ZipError, type ZipEntry,
} from './zip.ts'
import {
  colToLetters, lettersToCol, mapNames, parseRef, shiftRefsForInsert,
} from './a1.ts'
import {
  nameText, translateCellFormula, validateDefinedName, type NameProblem,
} from './cellformula.ts'
import { FUNCTIONS } from './formula.ts'
import { readCell } from './store.ts'
import type {
  CellOverride, Column, ColumnData, ColumnType, DashDoc, DataRule, DefinedName,
  TableSheet,
} from './model.ts'
import { columnRule, describeRule, refBox } from './datavalid.ts'

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
    | 'data-validation' | 'defined-name' | 'header-row' | 'totals-row'
    | 'cell-format'
  sheet?: string
  column?: string
  message: string
}

export interface XlsxImportResult {
  sheets: TableSheet[]
  findings: XlsxFinding[]
  /** The workbook's own title, if `docProps/core.xml` carried one. */
  title?: string
  /**
   * The workbook's `<definedNames>`, as `doc.names`. Present only when the
   * caller asked for them (`XlsxImportOpts.names`) — see the DEFINED NAMES
   * section below for why the default is to leave them out rather than to
   * return a table nobody installs.
   */
  names?: Record<string, DefinedName>
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
  /** cellXfs index → how the cell is DRAWN, or undefined for plain. */
  look: Array<CellLook | undefined>
}

/**
 * The appearance half of a style, in dash's own vocabulary
 * (`APPEARANCE_FIELDS`, model.ts) rather than Excel's.
 *
 * Finding 7 of the bounce test: every fixture bolded its header and its totals
 * row and not one imported cell carried `bold`, even though dash has had
 * per-cell bold, colour, background and borders since cellfmt.ts landed. The
 * file said so and dash threw it away without a word, then made the person do
 * it again by hand.
 *
 * WHAT IS NOT CARRIED, and why each is a drop rather than an approximation:
 *
 *   THEME AND INDEXED COLOURS. `<color theme="4" tint="0.4"/>` means "the
 *   fourth colour of whatever theme this workbook is wearing, lightened" —
 *   resolving it needs theme1.xml, the tint algebra, and the indexed palette,
 *   and getting it approximately right paints someone's brand colour a
 *   slightly different colour with no way to notice. Only an explicit
 *   `rgb="FFRRGGBB"` is read.
 *   PATTERN FILLS. dash's `bg` is one colour; a gray125 crosshatch is not one.
 *   FONT FAMILY AND SIZE. dash has neither per cell.
 *   PER-EDGE border colours and weights. dash carries which edges, one colour
 *   and one style for the box, so a cell with a thick red top and a thin grey
 *   bottom keeps its edges and loses the difference between them.
 */
interface CellLook {
  bold?: true
  italic?: true
  underline?: true
  color?: string
  bg?: string
  border?: string
  borderColor?: string
  borderStyle?: 'dashed' | 'dotted'
}

/** `FFCC0000` → `#cc0000`. ARGB, and the alpha is dropped: dash's colours are
 *  `#rrggbb` and every Excel cell colour anybody writes is opaque. A theme or
 *  indexed colour returns undefined — see the block above. */
function rgbOf(el: { a: Attrs } | undefined): string | undefined {
  if (!el) return undefined
  const raw = attr(el.a, 'rgb')
  if (!raw) return undefined
  const hex = raw.length === 8 ? raw.slice(2) : raw.length === 6 ? raw : ''
  return /^[0-9A-Fa-f]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : undefined
}

/** `<b/>` is on, `<b val="0"/>` is off. The second spelling is what a style
 *  that TURNS OFF an inherited bold looks like, and reading it as on is how a
 *  whole sheet arrives bold. */
const flagOn = (body: string, name: string): boolean => {
  const el = element(body, name)
  if (!el) return false
  const v = attr(el.a, 'val')
  return v !== '0' && v !== 'false' && v !== 'none'
}

const EDGES: Array<[string, 'top' | 'right' | 'bottom' | 'left']> = [
  ['t', 'top'], ['r', 'right'], ['b', 'bottom'], ['l', 'left'],
]

function readStyles(xml: string): Styles {
  const codes = new Map<number, string>()
  for (const nf of elements(xml, 'numFmt')) {
    const id = Number(attr(nf.a, 'numFmtId'))
    const code = attr(nf.a, 'formatCode') ?? ''
    if (Number.isFinite(id)) codes.set(id, code)
  }

  // The three appearance tables, each indexed by the id an `<xf>` carries.
  // Scoped to their own block for the same reason cellXfs is below: `<font>`
  // also appears inside `<dxfs>` (conditional formats), and mixing the two
  // shifts every font id in the workbook.
  const fonts: CellLook[] = []
  const fontBlock = element(xml, 'fonts')
  for (const f of elements(fontBlock ? fontBlock.body : '', 'font')) {
    const look: CellLook = {}
    if (flagOn(f.body, 'b')) look.bold = true
    if (flagOn(f.body, 'i')) look.italic = true
    if (flagOn(f.body, 'u')) look.underline = true
    const color = rgbOf(element(f.body, 'color'))
    if (color) look.color = color
    fonts.push(look)
  }

  const fills: Array<string | undefined> = []
  const fillBlock = element(xml, 'fills')
  for (const f of elements(fillBlock ? fillBlock.body : '', 'fill')) {
    const pf = element(f.body, 'patternFill')
    // Only a SOLID fill is a background dash can hold; a pattern is a texture.
    fills.push(pf && attr(pf.a, 'patternType') === 'solid'
      ? rgbOf(element(pf.body, 'fgColor')) : undefined)
  }

  const borders: CellLook[] = []
  const borderBlock = element(xml, 'borders')
  for (const b of elements(borderBlock ? borderBlock.body : '', 'border')) {
    let edges = ''
    let color: string | undefined
    let style: 'dashed' | 'dotted' | undefined
    for (const [letter, tag] of EDGES) {
      const e = element(b.body, tag)
      const st = e ? attr(e.a, 'style') ?? '' : ''
      if (!e || !st || st === 'none') continue
      edges += letter
      color = color ?? rgbOf(element(e.body, 'color'))
      if (!style && /dash/i.test(st)) style = 'dashed'
      if (!style && /dot|hair/i.test(st)) style = 'dotted'
    }
    const look: CellLook = {}
    if (edges) look.border = edges
    if (edges && color) look.borderColor = color
    if (edges && style) look.borderStyle = style
    borders.push(look)
  }

  // ONLY the cellXfs block. `cellStyleXfs` has an identical `<xf>` shape and
  // comes FIRST in the file, so a scan for every `<xf>` in the document indexes
  // a cell's `s="12"` into the wrong table — the bug produces plausible formats
  // for the first few columns and nonsense after, which reads as random.
  const block = element(xml, 'cellXfs')
  const xf: string[] = []
  const look: Array<CellLook | undefined> = []
  if (block) {
    for (const e of elements(block.body, 'xf')) {
      const id = Number(attr(e.a, 'numFmtId') ?? 0)
      xf.push(codes.get(id) ?? BUILTIN_CODE[id] ?? '')
      const merged: CellLook = {
        ...(fonts[Number(attr(e.a, 'fontId') ?? 0)] ?? {}),
        ...(borders[Number(attr(e.a, 'borderId') ?? 0)] ?? {}),
      }
      const bg = fills[Number(attr(e.a, 'fillId') ?? 0)]
      if (bg) merged.bg = bg
      look.push(Object.keys(merged).length ? merged : undefined)
    }
  }
  return { xf, look }
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
  validations: RawValidation[]; pane: { rows: number; cols: number }
} {
  const cells: RawCell[] = []
  const merges: string[] = []
  const validations: RawValidation[] = []
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
  for (const dv of elements(xml, 'dataValidation')) {
    const sqref = attr(dv.a, 'sqref')
    if (!sqref) continue
    const f = (n: 'formula1' | 'formula2'): string | undefined => {
      const el = element(dv.body, n)
      return el ? unescapeXml(el.body) : undefined
    }
    validations.push({
      sqref,
      type: attr(dv.a, 'type') ?? 'none',
      operator: attr(dv.a, 'operator') ?? 'between',
      allowBlank: attr(dv.a, 'allowBlank') === '1',
      // NOTE THE INVERSION, which is the single most-misread attribute in the
      // whole schema: `showDropDown="1"` HIDES the in-cell dropdown. Excel's
      // own UI checkbox is "In-cell dropdown" and the file stores its
      // NEGATION, so a reader that takes the name at face value ships every
      // list rule with its arrow switched the wrong way round.
      hideDropdown: attr(dv.a, 'showDropDown') === '1',
      errorStyle: attr(dv.a, 'errorStyle') ?? 'stop',
      error: attr(dv.a, 'error'),
      f1: f('formula1'),
      f2: f('formula2'),
    })
  }
  // FROZEN PANES. `state` matters: a SPLIT pane is a scroll position two panes
  // share and dash has no such thing, while a FROZEN one is the header pinned
  // where the reader can see it, which dash does have (`sheet.frozen`). Only
  // the frozen kind is read; a split is a view the reader re-makes in a second.
  let pane = { rows: 0, cols: 0 }
  const pv = element(xml, 'pane')
  if (pv) {
    const st = attr(pv.a, 'state') ?? ''
    if (st === 'frozen' || st === 'frozenSplit') {
      const n = (k: string): number => {
        const v = Number(attr(pv.a, k) ?? 0)
        return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
      }
      pane = { rows: n('ySplit'), cols: n('xSplit') }
    }
  }
  return { cells, merges, maxCol, widths, validations, pane }
}

// --- data validation ----------------------------------------------------------
//
// Excel's `<dataValidation>` is dash's `DataRule` (model.ts, datavalid.ts) with
// three differences that have to be handled rather than assumed away, because
// each one is a silent wrong answer if it is not:
//
//   1. `showDropDown` is INVERTED (see above).
//   2. `errorStyle` defaults to `stop`. dash's `on` defaults to `warn`, and
//      that is not a translation bug — dash's reject is a keyboard-only
//      refusal (datavalid.ts's header explains why a reject that runs on apply
//      is a divergence under collaboration), so `stop` maps to `reject` and
//      means slightly less than it did. It is still the closer of the two.
//   3. A validation covers a RANGE. On a dataset that range has to become a
//      COLUMN, because a dataset's rule lives on its column — so a rule over
//      part of a column is WIDENED to the whole one, and that is reported.
//      Widening is the safe direction here: it marks more cells than Excel
//      circled, and marking never changes a value.
//
// An operator dash cannot express (`notBetween`, `equal`, `notEqual`) is
// DROPPED with a finding rather than approximated. `greaterThan` and
// `lessThan` are kept as inclusive bounds and reported, because off by one at
// the boundary is a small, stated loss and losing the rule entirely is a
// larger one.

interface RawValidation {
  sqref: string
  type: string
  operator: string
  allowBlank: boolean
  hideDropdown: boolean
  errorStyle: string
  error?: string
  f1?: string
  f2?: string
}

/** The inline list Excel writes: `"Open,Won,Lost"` — quoted, comma separated.
 *  A RANGE reference (`$H$1:$H$5`) is a different feature dash has no answer
 *  for; the caller reports it rather than importing an empty list. */
function inlineList(f1: string | undefined): string[] | null {
  if (!f1) return null
  const s = f1.trim()
  if (!(s.startsWith('"') && s.endsWith('"') && s.length >= 2)) return null
  return s.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean)
}

/** A bound, as dash stores one. Dates arrive as serials and go in as ISO, so
 *  the panel shows `2026-03-01` rather than `46082`. */
function dvBound(raw: string | undefined, isDate: boolean, epoch1904: boolean): number | string | undefined {
  if (raw === undefined) return undefined
  const s = raw.trim().replace(/^=/, '')
  if (s === '') return undefined
  const n = Number(s)
  if (!Number.isFinite(n)) return s          // DATE(2026,1,1) and friends: verbatim
  if (!isDate) return n
  return serialToIso(n, epoch1904) ?? n
}

/**
 * One `<dataValidation>` as a dash rule, plus what could not be carried.
 * `null` means nothing worth storing came out of it.
 */
function toDataRule(
  v: RawValidation, epoch1904: boolean,
): { rule: DataRule | null; lost?: string } {
  const on = v.errorStyle === 'stop' ? 'reject' : 'warn'
  const base = {
    ...(v.allowBlank ? {} : { blank: false as const }),
    on: on as 'reject' | 'warn',
    ...(v.error ? { message: v.error } : {}),
  }
  if (v.type === 'list') {
    const list = inlineList(v.f1)
    if (!list?.length) {
      return { rule: null, lost: `its list of values is a reference (${v.f1 ?? '—'}) rather than a written-out list, and dash stores the values themselves` }
    }
    return { rule: { kind: 'list', list, ...(v.hideDropdown ? { noDropdown: true } : {}), ...base } }
  }
  if (v.type === 'custom') {
    return v.f1
      ? { rule: { kind: 'formula', formula: v.f1, ...base } }
      : { rule: null }
  }
  const kind = v.type === 'whole' || v.type === 'decimal' ? 'number'
    : v.type === 'date' ? 'date'
      : v.type === 'textLength' ? 'textLength' : null
  if (!kind) return { rule: null }
  const isDate = kind === 'date'
  const a = dvBound(v.f1, isDate, epoch1904)
  const b = dvBound(v.f2, isDate, epoch1904)
  switch (v.operator) {
    case 'between':
      return { rule: { kind, ...(a !== undefined ? { min: a } : {}), ...(b !== undefined ? { max: b } : {}), ...base } }
    case 'greaterThanOrEqual':
      return { rule: { kind, ...(a !== undefined ? { min: a } : {}), ...base } }
    case 'lessThanOrEqual':
      return { rule: { kind, ...(a !== undefined ? { max: a } : {}), ...base } }
    case 'greaterThan':
      return {
        rule: { kind, ...(a !== undefined ? { min: a } : {}), ...base },
        lost: `its "greater than ${v.f1}" test became "${v.f1} or more" — dash's bounds are inclusive, so the boundary value itself is now allowed`,
      }
    case 'lessThan':
      return {
        rule: { kind, ...(a !== undefined ? { max: a } : {}), ...base },
        lost: `its "less than ${v.f1}" test became "${v.f1} or less" — dash's bounds are inclusive, so the boundary value itself is now allowed`,
      }
    default:
      return { rule: null, lost: `dash has no "${v.operator}" test` }
  }
}

/** Column index → rule, from every `<dataValidation>` on the sheet. */
function validationsByColumn(
  raws: readonly RawValidation[], epoch1904: boolean, sheetName: string,
  lastRow: number, findings: XlsxFinding[],
): Map<number, DataRule> {
  const out = new Map<number, DataRule>()
  for (const v of raws) {
    if (v.type === 'none' || v.type === '') continue
    const { rule, lost } = toDataRule(v, epoch1904)
    // `sqref` is SPACE SEPARATED and may name several ranges.
    const refs = v.sqref.trim().split(/\s+/).filter(Boolean)
    const boxes = refs.map((r) => refBox(r.replace(/\$/g, ''))).filter((b): b is NonNullable<typeof b> => !!b)
    if (!boxes.length) continue
    if (!rule) {
      findings.push({
        code: 'data-validation', sheet: sheetName,
        message: `A data validation rule on ${v.sqref} of "${sheetName}" was not imported: ${lost ?? `dash has no equivalent of its "${v.type}" test`}. The cells keep their values; nothing on them is checked.`,
      })
      continue
    }
    let widened = false
    for (const b of boxes) {
      // Rows 2..lastRow is the whole data body. Anything narrower has to widen
      // to the column, because a dataset's rule belongs to the column.
      if (b.top > 1 || (lastRow > 1 && b.bottom < lastRow - 1)) widened = true
      for (let ci = b.left; ci <= b.right; ci++) out.set(ci, rule)
    }
    if (widened || lost) {
      const parts: string[] = []
      if (widened) parts.push(`it covered ${v.sqref} and now applies to the whole column, because a dash dataset keeps its rules on the column that owns the type`)
      if (lost) parts.push(lost)
      findings.push({
        code: 'data-validation', sheet: sheetName,
        message: `A data validation rule on "${sheetName}" was imported with a change: ${parts.join('; ')}.`,
      })
    }
  }
  return out
}

// --- the Excel table (ListObject) --------------------------------------------
//
// AN xlsx TABLE IS A dash DATASET, and docs/dash-sheet-kinds.md worked the
// mapping out before this code existed: an ordinary worksheet is cell-typed, a
// `ListObject` is COLUMN-typed — named columns, a header row, a calculated
// column, and a totals row driven by a PROPERTY (`totalsRowFunction="sum"`)
// rather than by a formula somebody typed. That is dash's dataset described in
// Microsoft's own schema, so `totals: {value:'sum'}` is a translation and not
// a compromise.
//
// WHY IT IS THE CONSEQUENTIAL ONE. Without this, Excel's totals row imports as
// an ordinary data row: sorting `pipeline.xlsx` by Value descending puts the
// row labelled "Total", holding 869,050, at the TOP of the deals. It is also
// caught by filters and counted by aggregates. A total that sorts into the
// middle of the data is not a cosmetic loss — it is a wrong number in every
// view built on the sheet.
//
// WHAT IS NOT TAKEN FROM THE TABLE. Its autofilter state (dash's filters are
// the reader's, not the document's), its style name, and its calculated
// columns: an Excel calculated column is written into every cell as an
// ordinary formula, so it arrives through the ordinary formula path with the
// ordinary liveness gate, which is where the judgement about what dash can
// evaluate belongs.

interface XlsxTable {
  /** the whole table, header and totals included, 0-based sheet coordinates */
  box: { top: number; left: number; bottom: number; right: number }
  headerRows: number
  totalsRows: number
  /** column index (sheet coordinates) → what its totals cell says */
  totals: Map<number, string>
  /** column index → the label Excel put in the totals row ("Total") */
  labels: Map<number, string>
  name: string
}

/** Excel's totals functions, in dash's words. `countNums` is Excel's COUNT and
 *  `count` is its COUNTA; dash has one count, so both land on it and the
 *  difference (whether text counts) is stated nowhere because dash's count
 *  already answers the question the column's type asks. */
const TOTALS_FN: Record<string, 'sum' | 'avg' | 'count' | 'min' | 'max'> = {
  sum: 'sum', average: 'avg', count: 'count', countNums: 'count', min: 'min', max: 'max',
}

function readTable(xml: string): XlsxTable | null {
  const t = element(xml, 'table')
  if (!t) return null
  const ref = attr(t.a, 'ref')
  const box = ref ? refBox(ref.replace(/\$/g, '')) : null
  if (!box) return null
  const num = (k: string, dflt: number): number => {
    const v = Number(attr(t.a, k) ?? NaN)
    return Number.isFinite(v) ? v : dflt
  }
  const totals = new Map<number, string>()
  const labels = new Map<number, string>()
  const block = element(t.body, 'tableColumns')
  let i = 0
  for (const c of elements(block ? block.body : t.body, 'tableColumn')) {
    const fn = attr(c.a, 'totalsRowFunction')
    const label = attr(c.a, 'totalsRowLabel')
    if (fn && fn !== 'none') totals.set(box.left + i, fn)
    if (label) labels.set(box.left + i, label)
    i++
  }
  return {
    box,
    // `headerRowCount` defaults to 1 and `totalsRowCount` to 0 — the schema's
    // defaults, and taking them the other way round either eats a row of data
    // or leaves the total in it.
    headerRows: num('headerRowCount', 1),
    totalsRows: num('totalsRowCount', 0),
    totals,
    labels,
    name: attr(t.a, 'displayName') ?? attr(t.a, 'name') ?? 'a table',
  }
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

// --- defined names --------------------------------------------------------
//
// `=SUM(RentCells)/B5`, where `RentCells` is a `<definedName>` in workbook.xml.
//
// WHY THIS SECTION EXISTS, AND IT IS NOT "names are nice to have". Before it,
// a bare identifier was the ONE class of formula the liveness gate let through
// by accident, and it is the class that loses data: dash imported
// `SUM(RentCells)/B5` LIVE, the grid painted `#NAME?` in red, and the 0.61
// Excel had computed — the number the cell was FOR — was gone. The gate
// screened for a `!`, a `[` and unknown function names; a bare word is none of
// the three. See `liveFormula` for the check that closes it.
//
// SO WHAT IS A NAME WORTH KEEPING. dash has `doc.names` now, so the answer is
// no longer "nothing". A definition is imported when it is one of the three
// things dash can hold:
//
//   a NUMBER      `0.2`             → `{ v: 0.2 }`
//   a TEXT        `"North"`         → `{ v: 'North' }`
//   a RANGE       `Summary!$B$2:$B$4` → `{ ref: … }`, row-shifted below
//
// and it is DROPPED, with a finding, when it is anything else: a formula
// (`OFFSET(…)`), a multi-area reference, or a spelling dash cannot reach
// (`TAX1` is a cell address, so a name spelled that way would sit in the file
// and never once be consulted — `validateDefinedName` is the refusal).
//
// AN UNQUALIFIED REF IS DROPPED, which looks harsh and is not. dash's names
// are workbook-scoped (model.ts), so `$B$2:$B$4` with no sheet on it means a
// different range on every tab, and there is no sheet to row-shift it against
// either. Excel does not write one; a hand-made file that does gets told.
//
// `_xlnm.*` (Print_Area, Print_Titles, _FilterDatabase) are VIEW state, not
// names anybody writes in a formula, and are skipped in silence.

/**
 * How many cells of one sheet may carry imported appearance.
 *
 * A dash cell override is a sparse overlay entry keyed `<colId>:<rid>`, so it
 * is the right shape for the ragged few per cent of a sheet that differ and
 * the wrong shape for a workbook whose author selected every cell and pressed
 * a colour. 20,000 entries is a few hundred KB of document for paint; past it
 * the values still all arrive and the finding says the styling did not.
 */
const CELL_FORMAT_BUDGET = 20_000

/** What the import decided about the workbook's names. */
interface NameImport {
  names: Record<string, DefinedName>
  /**
   * The spellings, lower-cased, that a live formula may mention: those whose
   * SUBSTITUTION would itself survive the gate. `TaxRate` = 0.2 substitutes to
   * `(0.2)` and dash evaluates it; `RentCells` substitutes to
   * `Summary!$B$2:$B$4`, which is a cross-sheet reference dash's dataset kind
   * cannot resolve — so a formula using it keeps its cached value, exactly as
   * one calling `SUBTOTAL` does.
   */
  live: Set<string>
}

const NAME_REFUSED: Record<NameProblem, string> = {
  empty: 'it has no name',
  shape: 'its spelling is not one a formula can mention (letters, digits, "_" and "." only, starting with a letter)',
  cellshaped: 'it is spelled like a cell address, so a formula would read the cell and never the name',
  taken: 'another name is already spelled that way',
}

/** A single cell or range, sheet-qualified. Deliberately not multi-area:
 *  `Sheet1!$A$1,Sheet1!$C$1` is two ranges and dash's `ref` is one. */
const QUALIFIED_REF =
  /^(?:'(?:[^']|'')+'|[A-Za-z_\\][A-Za-z0-9_.\\ ]*)!\$?[A-Za-z]{1,3}\$?[1-9]\d*(?::\$?[A-Za-z]{1,3}\$?[1-9]\d*)?$/
const BARE_REF = /^\$?[A-Za-z]{1,3}\$?[1-9]\d*(?::\$?[A-Za-z]{1,3}\$?[1-9]\d*)?$/
const NUM_LITERAL = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/
const STR_LITERAL = /^"(?:[^"]|"")*"$/

/** The workbook's `<definedNames>`, as far as dash can carry them. */
function readDefinedNames(wbXml: string, findings: XlsxFinding[]): NameImport {
  const names: Record<string, DefinedName> = {}
  const live = new Set<string>()
  const block = element(wbXml, 'definedNames')
  if (!block) return { names, live }

  for (const d of elements(block.body, 'definedName')) {
    const raw = (attr(d.a, 'name') ?? '').trim()
    if (!raw || raw.toLowerCase().startsWith('_xlnm')) continue
    const body = unescapeXml(d.body).trim().replace(/^=/, '').trim()
    const drop = (why: string): void => {
      findings.push({
        code: 'defined-name',
        message: `The name "${raw}" was not imported: ${why}. Any formula that used it keeps the value Excel last calculated, with the formula text beside it.`,
      })
    }
    const problem = validateDefinedName(raw, names)
    if (problem) { drop(NAME_REFUSED[problem]); continue }
    if (!body) { drop('it defines nothing'); continue }

    let def: DefinedName | undefined
    if (NUM_LITERAL.test(body)) def = { v: Number(body) }
    else if (STR_LITERAL.test(body)) def = { v: body.slice(1, -1).replace(/""/g, '"') }
    else if (QUALIFIED_REF.test(body)) def = { ref: body }
    else if (BARE_REF.test(body)) {
      drop(`it points at ${body} without saying which sheet, and a dash name means one thing across the whole workbook`)
      continue
    } else {
      drop(`it is defined as "${body}", which is not a number, a piece of text, or a single range`)
      continue
    }
    names[raw] = def
    const text = nameText(def)
    if (text !== undefined && liveFormula(text).ok) live.add(raw.toLowerCase())
  }
  return { names, live }
}

/**
 * Move every name's `ref` by the rows its sheet lost on the way in.
 *
 * A dataset's row 1 is the first DATA row: the header, and any blank
 * letterhead rows above it, are not rows dash has. So `Summary!$B$2:$B$4`
 * written against Excel's numbering points one row too low here, and pointing
 * a name at the wrong rows is the same silent wrong number the formula shift
 * exists to prevent — this is that shift, for the other kind of reference.
 */
function shiftNamesForImport(
  names: Record<string, DefinedName>, drops: Map<string, number>,
): void {
  for (const [sheet, drop] of drops) {
    if (drop <= 0) continue
    for (const def of Object.values(names)) {
      if (typeof def.ref !== 'string') continue
      def.ref = shiftRefsForInsert(def.ref, 'row', 0, -drop, { on: sheet })
    }
  }
}

/**
 * Put an import's names into a document — the caller's half of
 * `XlsxImportOpts.names`, in one line, so no caller has to work out the
 * collision rule for itself.
 *
 * A NAME ALREADY IN THE DOCUMENT WINS. Importing a second workbook must not
 * silently repoint `TaxRate` at the new file's rate: every formula in the
 * document that used it would change its answer, all at once, with nothing on
 * screen having been edited. The skipped spellings come back so the caller can
 * say so.
 *
 * Returns the names that were NOT installed because the document already had
 * them; an empty array is the ordinary case.
 */
export function installNames(
  doc: DashDoc, names: Record<string, DefinedName> | undefined,
): string[] {
  if (!names || !Object.keys(names).length) return []
  const have = doc.names ?? {}
  const taken = new Set(Object.keys(have).map((k) => k.toLowerCase()))
  const skipped: string[] = []
  const next: Record<string, DefinedName> = { ...have }
  for (const [k, d] of Object.entries(names)) {
    if (taken.has(k.toLowerCase())) { skipped.push(k); continue }
    next[k] = d
  }
  doc.names = next
  return skipped
}

// --- formulas ------------------------------------------------------------------

const FN_SET = new Set(FUNCTIONS.map((f) => f.toUpperCase()))
const CALL_RE = /([A-Za-z][A-Za-z0-9_.]*)\s*\(/g

/** Words that are values in a formula, not names: nothing defines them and
 *  nothing needs to. */
const LITERAL_WORDS = new Set(['TRUE', 'FALSE'])

/**
 * Can dash make this formula LIVE, or must it stay a number with the source
 * recorded beside it?
 *
 * Four ways it cannot, and the first is the dangerous one:
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
 *   4. A BARE IDENTIFIER THAT RESOLVES TO NOTHING. `=SUM(RentCells)/B5` has no
 *      `!`, no `[` and no unknown function in it, so for a long time it sailed
 *      through all three checks above and landed LIVE — and `RentCells` is a
 *      `<definedName>`, which dash did not import, so the cell that had held
 *      Excel's 0.61 painted `#NAME?` in red. The message this module prints
 *      elsewhere on the same screen promises the opposite in as many words:
 *      *a live formula dash cannot evaluate would replace real numbers with
 *      #NAME?*. That was the hole, and it was the only one that DESTROYED a
 *      value rather than merely declining to compute one.
 *
 *      `known` closes it without the blunt answer of refusing every word.
 *      Names now exist in dash (`doc.names`), so a word the workbook defines
 *      AND the import carried — and whose substitution would itself pass this
 *      gate — is allowed through; every other word fails, keeps the cached
 *      value and takes a `formula-not-live` finding, exactly as `SUBTOTAL`
 *      does. `mapNames` is the lexer rather than a regex of our own because it
 *      already knows the four places a word is not a name: inside a string, in
 *      front of a `(`, after a `!`, and where the word is really a cell
 *      address (`B5`, `TAX1`).
 *
 * In all four cases the cached VALUE is kept (so the sheet still reads
 * correctly) and the formula text is preserved on the override under `xlsxF`,
 * which is an additive field: nothing in dash reads it yet, the format promises
 * it survives (PLATFORM §3), and the export half below writes it back out. That
 * is what makes xlsx → dash → xlsx not lose someone's model.
 */
export function liveFormula(
  src: string, known: ReadonlySet<string> = new Set(),
): { ok: true } | { ok: false; why: string; fn?: string; name?: string } {
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
  // The fourth check. `mapNames` offers exactly the words that are neither a
  // reference, a call, nor part of somebody else's syntax; the walk is only
  // reading, so every word goes back unchanged.
  let unknown: string | undefined
  mapNames(src, (w) => {
    if (unknown === undefined && !LITERAL_WORDS.has(w.toUpperCase()) && !known.has(w.toLowerCase())) {
      unknown = w
    }
    return w
  })
  if (unknown !== undefined) {
    return {
      ok: false,
      why: `it uses the name ${unknown}, which this workbook defines somewhere dash could not follow`,
      name: unknown,
    }
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
  /**
   * WHICH row is the header, 0-based within the sheet's used range — the
   * answer `header` cannot give, because "has one or hasn't" is not the
   * question a report with a spanning title over its header row asks. Beats
   * both `header` and the inference below. Data starts on the row after it.
   */
  headerRow?: number
  /**
   * THE CALLER PROMISES TO INSTALL `result.names` INTO `doc.names`.
   *
   * Names are opt-in rather than always-on because the liveness gate trusts
   * them: with this set, `=B4*TaxRate` is imported LIVE, and if the name table
   * never reaches the document that live formula paints `#NAME?` over the
   * number Excel computed — the precise damage the gate exists to prevent. So
   * the default is off and safe (every name-using formula keeps its cached
   * value and says so), and a caller that wires the table up says so here.
   */
  names?: boolean
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

  // Names are read BEFORE the sheets, because the liveness gate needs to know
  // which words a formula may mention; their refs are row-shifted AFTER, once
  // every sheet has said how many rows it dropped on the way in.
  const nameFindings: XlsxFinding[] = []
  const nameImport = readDefinedNames(wbXml, nameFindings)
  const carryNames = opts.names === true
  if (carryNames) {
    findings.push(...nameFindings)
  } else {
    const listed = Object.keys(nameImport.names)
    const total = listed.length + nameFindings.length
    if (total) {
      findings.push({
        code: 'defined-name',
        message: `This workbook defines ${total} name${total === 1 ? '' : 's'}${listed.length ? ` (${listed.slice(0, 4).join(', ')}${listed.length > 4 ? ', …' : ''})` : ''}, which this import does not carry. A formula that used one shows the value Excel last calculated, with the formula text kept beside it.`,
      })
    }
  }
  const liveNames: ReadonlySet<string> = carryNames ? nameImport.live : new Set<string>()
  /** sheet name → rows that exist in Excel and do not exist in dash. */
  const drops = new Map<string, number>()

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
    // An Excel Table (`ListObject`) is reached through the WORKSHEET's own
    // relationships, never by guessing `xl/tables/table1.xml`: a workbook with
    // several tables numbers the parts in creation order, not sheet order.
    const sheetRels = text(resolvePart(partPath, `_rels/${partPath.split('/').pop()}.rels`))
    const tableXml: string[] = []
    if (sheetRels) {
      for (const rr of relTargets(sheetRels).values()) {
        if (!rr.type.endsWith('/table')) continue
        const tx = text(resolvePart(partPath, rr.target))
        if (tx) tableXml.push(tx)
      }
    }
    sheets.push(readOneSheet(xml, name, id, shared, styles, epoch1904, findings, opts,
      { liveNames, drops, tables: tableXml }))
  }
  if (carryNames) shiftNamesForImport(nameImport.names, drops)

  if (!sheets.length && !findings.some((f) => f.code === 'sheet-skipped')) {
    throw new ZipError('this workbook contains no worksheets')
  }

  const core = text('docProps/core.xml')
  const title = core ? element(core, 'title')?.body : undefined
  return {
    sheets,
    findings: condense(findings),
    title: title ? unescapeXml(title) : undefined,
    ...(carryNames && Object.keys(nameImport.names).length ? { names: nameImport.names } : {}),
  }
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

/** What one sheet needs from the workbook around it, and what it reports back
 *  to it. Bundled rather than added to an already long parameter list. */
interface SheetCtx {
  /** names a formula on this sheet may mention and still go live */
  liveNames: ReadonlySet<string>
  /** filled in: sheet name → rows Excel had that dash does not */
  drops: Map<string, number>
  /** the `xl/tables/*.xml` parts this worksheet relates to */
  tables: string[]
}

function readOneSheet(
  xml: string, name: string, id: string, shared: string[], styles: Styles,
  epoch1904: boolean, findings: XlsxFinding[], opts: XlsxImportOpts,
  ctx: SheetCtx,
): TableSheet {
  const { cells, merges, maxCol, widths, validations, pane } = readSheetCells(xml, shared)
  const table = ctx.tables.length ? readTable(ctx.tables[0]) : null
  if (ctx.tables.length > 1) {
    findings.push({
      code: 'totals-row', sheet: name,
      message: `"${name}" carries ${ctx.tables.length} Excel tables. A dash sheet is ONE dataset, so the first was read as this sheet and the others arrived as ordinary rows beside it — including any totals rows they had.`,
    })
  }

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

  // THE HEADER IS NOT ALWAYS ROW 1 — see `titleRowAbove`. An explicit
  // instruction always wins; otherwise a spanning title over a full header row
  // moves the header down one, and says so.
  const told = opts.header !== undefined || opts.headerRow !== undefined
  const title = told ? null : titleRowAbove(grid, merges, firstRow, styles)
  // A table SAYS where its header is (`headerRowCount`), which beats inferring
  // it — but only for the rows the table actually covers.
  const tableHead = table && !told && !title && table.box.top === firstRow
    ? table.headerRows : null
  const head = opts.headerRow !== undefined
    ? { start: Math.max(0, Math.floor(opts.headerRow)) + 1, sure: true }
    : title
      ? { start: 2, sure: true }
      : tableHead !== null
        ? { start: tableHead, sure: true }
        : decideHeader(grid[0] ?? [], grid, styles, opts.header)
  const bodyStart = head.start
  const headerRow = bodyStart > 0 ? (grid[bodyStart - 1] ?? []) : []
  if (title) {
    const at = firstRow + 2
    findings.push({
      code: 'header-row', sheet: name,
      message: `Row ${firstRow + 1} of "${name}" is a title spanning ${title.merge} — one value across several columns, which is not a header. Its header is row ${at}, and that is the row the columns were named from; the title ("${title.text}") is not one of them and is not in the data either. If that is wrong, re-import saying the header is row ${firstRow + 1}.`,
    })
  }
  if (bodyStart === 0 && opts.header === undefined) {
    findings.push({
      code: 'no-header', sheet: name,
      message: `"${name}" does not appear to start with a header row (its first row holds values, not labels), so the columns are named by position. Rename them, or re-import telling dash there is a header.`,
    })
  } else if (!head.sure && !told) {
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

  // THE TOTALS ROW LEAVES THE DATA. Only when the table's last row IS the
  // sheet's last row: anything below it is somebody else's rows, and trimming
  // then would delete them.
  const totalsRows = table && table.totalsRows > 0 && table.box.bottom === lastRow
    ? Math.min(table.totalsRows, Math.max(0, lastRow - firstRow + 1 - bodyStart))
    : 0

  const dataRows = grid.slice(bodyStart)
  const rowCount = Math.max(0, lastRow - firstRow + 1 - bodyStart - totalsRows)

  // What Excel's row numbering has and dash's does not: the blank letterhead
  // above the table, plus the header. Every reference written against this
  // sheet — in a formula (below) or in a defined name (importXlsx) — moves by
  // exactly this much.
  ctx.drops.set(name, firstRow + bodyStart)

  // Data validation, mapped to COLUMNS before the loop that builds them —
  // `lastRow - firstRow` is the body's extent, which is what decides whether a
  // rule covered the whole column or a slice of it.
  const dvByCol = validationsByColumn(validations, epoch1904, name, lastRow - firstRow + 1, findings)

  const columns: Column[] = []
  const data: Record<string, ColumnData> = {}
  const overrides: Record<string, CellOverride> = {}
  const ids = new Set<string>()
  let leapSeen = false
  let timeSeen = false
  let notLive = 0
  let liveCount = 0
  const missingFns = new Set<string>()
  const missingNames = new Set<string>()
  let formatted = 0
  let formatSkipped = 0

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
      const key = `${colId}:${r + 1}`
      const out = coerceCell(cell, plan, styles, epoch1904)
      if (out.lost) lostHere++
      if (out.leap1900) leapSeen = true
      // A TIME OF DAY, not "any string with a T in it" — which is what this
      // was, and `Financials` set the flag on a sheet with no dates at all.
      if (plan.type === 'date' && typeof out.v === 'string' && out.v.includes('T')) timeSeen = true
      values.push(out.v)

      // APPEARANCE. Written through the same overlay as a hand correction and
      // deliberately WITHOUT a value: every reader of the overlay asks
      // `'v' in over` (grid.ts, preview.ts, steps.ts, the export below), so a
      // bolded cell cannot move a total, a chart, a pivot or an export by one
      // digit. cellfmt.ts's one line, honoured from the import side.
      const look = cell ? styles.look[cell.s] : undefined
      if (look) {
        if (formatted < CELL_FORMAT_BUDGET) {
          overrides[key] = { ...(overrides[key] ?? {}), ...look }
          formatted++
        } else formatSkipped++
      }

      if (cell?.f !== undefined) {
        // LIVENESS IS DECIDED ON THE ORIGINAL TEXT, BEFORE ANY SHIFT, and the
        // order is not cosmetic. Shifting first ran `Sheet2!A1*3` through
        // a1.ts, which leaves `Sheet2` alone and then dutifully moves the `A1`
        // after it — off the top of the sheet, into `Sheet2!#REF!*3`. So the
        // very formula we were refusing to trust got corrupted on its way into
        // the field that exists to preserve it verbatim.
        const live = liveFormula(cell.f, ctx.liveNames)
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
          if ('name' in live && live.name) missingNames.add(live.name)
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
      ...(dvByCol.has(ci) ? { validate: dvByCol.get(ci) } : {}),
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
  if (formatSkipped) {
    findings.push({
      code: 'cell-format', sheet: name,
      message: `${formatted} formatted cells in "${name}" kept their bold, colour, background and borders; ${formatSkipped} more did not. dash's per-cell appearance is a sparse overlay, and a workbook that styles every cell of a long sheet would put an entry in it for every one of them — which costs more in file size than the styling is worth. The values are all there; the paint is not.`,
    })
  }
  if (notLive) {
    const fns = [...missingFns].slice(0, 4).join(', ')
    const nms = [...missingNames].slice(0, 4).join(', ')
    const why = fns ? `dash has no ${fns} yet`
      : nms ? `they use the name${missingNames.size === 1 ? '' : 's'} ${nms}, which dash could not follow`
        : 'they point at other sheets or external data'
    findings.push({
      code: 'formula-not-live', sheet: name,
      message: `${notLive} formula${notLive === 1 ? '' : 's'} in "${name}" could not be made live (${why}). The values Excel last calculated are shown, and the formula text is kept with each cell so nothing is lost — a live formula dash cannot evaluate would replace real numbers with #NAME?.`,
    })
  }

  // THE TOTALS ROW, as the column property it is in Excel's own schema.
  const totals: NonNullable<TableSheet['totals']> = {}
  const lostTotals: string[] = []
  if (table && totalsRows) {
    for (const [ci, fn] of table.totals) {
      const col = columns[ci]
      if (!col) continue
      const dashFn = TOTALS_FN[fn]
      if (dashFn) totals[col.id] = dashFn
      // `custom`, `stdDev` and `var` have no dash total. Inventing the nearest
      // one would print a number under a column that is not the number the
      // author asked for, which is worse than an empty footer.
      else lostTotals.push(`${col.name} (${fn})`)
    }
    const kept = Object.keys(totals).length
    const label = [...table.labels.values()][0]
    const parts = [
      `${table.name}'s totals row left the data and became ${kept ? `${kept} column total${kept === 1 ? '' : 's'}` : 'nothing'}`,
    ]
    if (label) parts.push(`its "${label}" label is not carried — dash labels its own totals row`)
    if (lostTotals.length) parts.push(`and dash has no total for ${lostTotals.join(', ')}, so ${lostTotals.length === 1 ? 'that column has' : 'those columns have'} none`)
    findings.push({
      code: 'totals-row', sheet: name,
      message: `${parts.join('; ')}. A totals row imported as an ordinary row sorts into the middle of the data, is caught by filters and is counted by aggregates, which is why it is a property here instead.`,
    })
  }

  // FROZEN PANES. Excel's `ySplit` counts SHEET rows and its first one is the
  // header; a dash dataset pins its header on its own, and `frozen.rows`
  // counts DATA rows. So the `ySplit="1"` every fixture carried maps to zero
  // frozen rows and loses NOTHING — the reader still sees the header — while
  // `ySplit="2"` over a one-row header is the one data row the author pinned.
  // Clamped to leave a row and a column free, which is `freezeAt`'s rule and
  // is what stops a grid that cannot scroll.
  const dropRows = firstRow + bodyStart
  const frozen = {
    rows: Math.max(0, Math.min(pane.rows - dropRows, Math.max(0, rowCount - 1))),
    cols: Math.max(0, Math.min(pane.cols, Math.max(0, columns.length - 1))),
  }

  return {
    id, name, kind: 'table',
    rids: rowCount ? [[1, rowCount]] : [],
    columns,
    data,
    ...(Object.keys(totals).length ? { totals } : {}),
    ...(frozen.rows || frozen.cols ? { frozen } : {}),
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
 * A spanning TITLE above the real header — and the repair for the worst import
 * outcome in the 2026-08-18 bounce test.
 *
 * WHAT HAPPENED. `budget.xlsx` had "Jan 2026 budget" merged across A1:C1 and
 * its real header ("Category / Budget / Actual") in row 2. Row 1 was taken as
 * the header, so column A was called "Jan 2026 budget", B and C became
 * "Column 2" and "Column 3", the real header became data row 1 — and because
 * every numeric column now held one text value, EVERY COLUMN TYPED AS TEXT. A
 * three-column budget arrived with no numbers in it, and dash said so three
 * times (`merged-cells`, `empty-header`, `mixed-types`) without ever joining
 * the three into the one sentence that would have helped.
 *
 * WHY THIS DETECTS AND ACTS RATHER THAN OFFERING. The evidence below is not a
 * heuristic about what a header usually looks like; it is a PROOF that row 1
 * is not one. A row holding a single value merged across the columns cannot be
 * the header of those columns — there is one label for three of them — and the
 * row under it names every column that has data. Nothing is discarded either
 * way: taking row 1 costs a row of real data (the header becomes a row) and
 * costs every numeric column its type, while taking row 2 costs the title,
 * which is a caption and is named in the finding. So the honest thing is to do
 * it and say it, loudly, with the row number to re-import against. Doing it
 * SILENTLY is the one answer that is wrong — that is how the finding started.
 *
 * THE EVIDENCE, all four required:
 *   1. a merged range on the first used row, spanning at least two columns;
 *   2. that row holds exactly ONE value, and it is text (a title, not data);
 *   3. the row below it has a text value in every column that has data;
 *   4. there is more than one column, and there is a row below the header.
 *
 * (2) is what keeps this from stealing a header: the two-tier `Region | Q1 Q2`
 * idiom merges B1:C1 over a row that is ALSO the header, and that row has
 * three values, not one.
 */
function titleRowAbove(
  grid: Array<Array<RawCell | undefined>>, merges: readonly string[],
  firstRow: number, styles: Styles,
): { merge: string; text: string } | null {
  if (grid.length < 3) return null
  const spanning = merges.find((m) => {
    const box = refBox(m.replace(/\$/g, ''))
    return !!box && box.top === firstRow && box.right > box.left
  })
  if (!spanning) return null

  const top = grid[0] ?? []
  const filled = [...top.entries()].filter(([, c]) => !!c) as Array<[number, RawCell]>
  if (filled.length !== 1) return null
  if (familyOf(kindOf(filled[0][1], styles)) !== 'text') return null

  // Every column with data under the title has to be named by the row below
  // it, or that row is not a header either and nothing here is safe.
  const used = new Set<number>()
  for (let r = 1; r < grid.length; r++) {
    for (const [ci, c] of (grid[r] ?? []).entries()) if (c) used.add(ci)
  }
  if (used.size < 2) return null
  const second = grid[1] ?? []
  for (const ci of used) {
    const c = second[ci]
    if (!c || familyOf(kindOf(c, styles)) !== 'text') return null
  }
  return { merge: spanning, text: cellText(filled[0][1], [], styles, false) }
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

/**
 * The style table, built as we go: one xf per (format code, appearance) pair.
 *
 * IT CARRIES APPEARANCE BECAUSE THE IMPORT DOES. Bold, colour, background and
 * borders now arrive from a workbook (see `CellLook`), and an exporter that
 * dropped them would have turned one silent loss into a round trip that loses
 * them on the way back out — the same finding, one door along. What dash holds
 * per cell is what goes out; what dash does not hold (font family, size,
 * per-edge weights) never came in.
 */
interface Paint {
  bold?: boolean; italic?: boolean; underline?: boolean
  color?: string; bg?: string
  border?: string; borderColor?: string; borderStyle?: string
}

/** `#rrggbb` → Excel's opaque ARGB. Anything else is not a colour we wrote. */
const argb = (c: unknown): string | undefined =>
  (typeof c === 'string' && /^#[0-9A-Fa-f]{6}$/.test(c) ? `FF${c.slice(1).toUpperCase()}` : undefined)

/** The appearance an override asks for, or undefined for a plain cell. */
function paintOf(over: CellOverride | undefined): Paint | undefined {
  if (!over) return undefined
  const p: Paint = {}
  if (over.bold === true) p.bold = true
  if (over.italic === true) p.italic = true
  if (over.underline === true) p.underline = true
  const color = argb(over.color)
  if (color) p.color = color
  const bg = argb(over.bg)
  if (bg) p.bg = bg
  if (typeof over.border === 'string' && over.border) {
    p.border = over.border
    const bc = argb(over.borderColor)
    if (bc) p.borderColor = bc
    if (over.borderStyle === 'dashed' || over.borderStyle === 'dotted') p.borderStyle = over.borderStyle
  }
  return Object.keys(p).length ? p : undefined
}

const EDGE_TAG: Record<string, string> = { t: 'top', r: 'right', b: 'bottom', l: 'left' }

class StyleBook {
  codes: string[] = []
  /** index 0 is the default font; every other entry is one an xf asked for. */
  private fonts: Paint[] = [{}]
  /** index 0 = none and index 1 = gray125 are REQUIRED by Excel; solid fills
   *  start at 2. Getting this wrong is the repair dialog. */
  private fills: Array<string | undefined> = [undefined, undefined]
  private borders: Paint[] = [{}]
  xfs: Array<{ fmt: number; font: number; fill: number; border: number }> =
    [{ fmt: 0, font: 0, fill: 0, border: 0 }]
  private seen = new Map<string, number>()
  private fontAt = new Map<string, number>()
  private fillAt = new Map<string, number>()
  private borderAt = new Map<string, number>()

  constructor() { this.seen.set('|', 0) }

  /** The cellXfs index for a format code (`''` = General) and an appearance. */
  at(code: string, paint?: Paint): number {
    const sig = paint
      ? `${paint.bold ? 'b' : ''}${paint.italic ? 'i' : ''}${paint.underline ? 'u' : ''}` +
        `|${paint.color ?? ''}|${paint.bg ?? ''}|${paint.border ?? ''}|${paint.borderColor ?? ''}|${paint.borderStyle ?? ''}`
      : ''
    const key = `${code}|${sig}`
    const hit = this.seen.get(key)
    if (hit !== undefined) return hit
    let fmt = 0
    if (code) {
      const i = this.codes.indexOf(code)
      fmt = 164 + (i >= 0 ? i : this.codes.push(code) - 1)
    }
    const at = this.xfs.push({
      fmt,
      font: this.font(paint),
      fill: this.fill(paint),
      border: this.border(paint),
    }) - 1
    this.seen.set(key, at)
    return at
  }

  private font(p?: Paint): number {
    if (!p || (!p.bold && !p.italic && !p.underline && !p.color)) return 0
    const key = `${p.bold ? 'b' : ''}${p.italic ? 'i' : ''}${p.underline ? 'u' : ''}|${p.color ?? ''}`
    const hit = this.fontAt.get(key)
    if (hit !== undefined) return hit
    const at = this.fonts.push({
      bold: p.bold, italic: p.italic, underline: p.underline, color: p.color,
    }) - 1
    this.fontAt.set(key, at)
    return at
  }

  private fill(p?: Paint): number {
    if (!p?.bg) return 0
    const hit = this.fillAt.get(p.bg)
    if (hit !== undefined) return hit
    const at = this.fills.push(p.bg) - 1
    this.fillAt.set(p.bg, at)
    return at
  }

  private border(p?: Paint): number {
    if (!p?.border) return 0
    const key = `${p.border}|${p.borderColor ?? ''}|${p.borderStyle ?? ''}`
    const hit = this.borderAt.get(key)
    if (hit !== undefined) return hit
    const at = this.borders.push({
      border: p.border, borderColor: p.borderColor, borderStyle: p.borderStyle,
    }) - 1
    this.borderAt.set(key, at)
    return at
  }

  xml(): string {
    const numFmts = this.codes.length
      ? `<numFmts count="${this.codes.length}">${this.codes.map((c, i) =>
        `<numFmt numFmtId="${164 + i}" formatCode="${escapeXml(c)}"/>`).join('')}</numFmts>`
      : ''
    const fonts = this.fonts.map((f) =>
      `<font>${f.bold ? '<b/>' : ''}${f.italic ? '<i/>' : ''}${f.underline ? '<u/>' : ''}` +
      `${f.color ? `<color rgb="${f.color}"/>` : ''}<sz val="11"/><name val="Calibri"/></font>`).join('')
    const fills = this.fills.map((f, i) =>
      `<fill><patternFill patternType="${i === 1 ? 'gray125' : f ? 'solid' : 'none'}">` +
      `${f ? `<fgColor rgb="${f}"/><bgColor indexed="64"/>` : ''}</patternFill></fill>`).join('')
    const borders = this.borders.map((b) => {
      const style = b.borderStyle === 'dashed' ? 'dashed' : b.borderStyle === 'dotted' ? 'dotted' : 'thin'
      const edge = (letter: string): string => {
        const tag = EDGE_TAG[letter]
        return (b.border ?? '').includes(letter)
          ? `<${tag} style="${style}">${b.borderColor ? `<color rgb="${b.borderColor}"/>` : ''}</${tag}>`
          : `<${tag}/>`
      }
      return `<border>${edge('l')}${edge('r')}${edge('t')}${edge('b')}<diagonal/></border>`
    }).join('')
    // The counts and the two fills are not decoration. Excel requires at least
    // the `none` and `gray125` fills and a `cellStyleXfs` entry; a styles part
    // missing either is the single most common cause of the repair dialog.
    return `${DECL}<styleSheet xmlns="${MAIN_NS}">${numFmts}` +
      `<fonts count="${this.fonts.length}">${fonts}</fonts>` +
      `<fills count="${this.fills.length}">${fills}</fills>` +
      `<borders count="${this.borders.length}">${borders}</borders>` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.xfs.length}">${this.xfs.map((x) =>
        `<xf numFmtId="${x.fmt}" fontId="${x.font}" fillId="${x.fill}" borderId="${x.border}" xfId="0"` +
        `${x.fmt ? ' applyNumberFormat="1"' : ''}${x.font ? ' applyFont="1"' : ''}` +
        `${x.fill ? ' applyFill="1"' : ''}${x.border ? ' applyBorder="1"' : ''}/>`).join('')}</cellXfs>` +
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
  const tableXml: Array<string | undefined> = []
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
    const written = writeSheet(sheet, styles, strings, opts, findings, sheetXml.length)
    sheetXml.push(written.xml)
    tableXml.push(written.table)
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
    tableXml.map((t, i) => (t ? `<Override PartName="/xl/tables/table${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>` : '')).join('') +
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
  // A table is reached through its WORKSHEET's relationships, so the rels part
  // exists only for the sheets that have one.
  tableXml.forEach((t, i) => {
    if (!t) return
    add(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`,
      `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdT" Type="${REL_NS}/table" Target="../tables/table${i + 1}.xml"/></Relationships>`)
    add(`xl/tables/table${i + 1}.xml`, t)
  })
  // styles LAST of the pair, because writing the sheets is what filled it in
  add('xl/styles.xml', styles.xml())
  add('xl/sharedStrings.xml', strings.xml())

  return { bytes: await writeZip(parts, { at: opts.at, store: opts.store }), findings }
}

/**
 * The sheet's frozen panes, read defensively — the same reading `readFrozen`
 * (rowcol.ts) does, spelled again here rather than imported, because this
 * module is the FILE layer and rowcol.ts is the editing layer. An additive
 * field can hold anything an older or hand-edited build put there, and
 * anything unreadable means "not frozen".
 */
function readFrozenPane(sheet: TableSheet): { rows: number; cols: number } {
  const f = sheet.frozen
  if (typeof f !== 'object' || f === null || Array.isArray(f)) return { rows: 0, cols: 0 }
  const o = f as Record<string, unknown>
  const num = (v: unknown): number =>
    (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
  return { rows: num(o.rows), cols: num(o.cols) }
}

/** Rows of one sheet, and the `ListObject` part that goes beside it. */
function writeSheet(
  sheet: TableSheet, styles: StyleBook, strings: Strings,
  opts: XlsxExportOpts, findings: XlsxFinding[], index: number,
): { xml: string; table?: string } {
  const cols = sheet.columns.filter((c) => !c.hidden)
  const rows = sheet.rids.reduce((n, [, c]) => n + c, 0)
  const computed = opts.computed?.[sheet.id]
  const overrides = sheet.cells ?? {}
  const rids: number[] = []
  for (const [start, count] of sheet.rids) for (let i = 0; i < count; i++) rids.push(start + i)

  const headStyle = styles.at('', { bold: true })
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
      // A cell someone painted gets its own xf; every other cell in the column
      // shares the column's one, so a sheet with three bolded cells has three
      // extra styles rather than one per cell.
      const paint = paintOf(over)
      const style = paint ? styles.at(formatFor(col), paint) : colStyle[i]

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
        cells.push(`<c r="${ref}" s="${style}"><f>${escapeXml(body)}</f>${cachedXml}</c>`)
        continue
      }

      const v = over && 'v' in over ? over.v
        : computed?.has(col.id) ? computed.get(col.id)![r]
          : col.formula ? undefined
            : readCell(sheet.data[col.id], r)
      const cell = valueCell(ref, style, v, col.type, strings)
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
      // MIN/MAX BY LOOP, never `Math.min(...nums)`: `nums` holds one entry per
      // ROW, a spread is one argument per entry, and the engine throws
      // `RangeError: Maximum call stack size exceeded` past ~125k of them
      // (condfmt.ts:52). Exporting a large workbook is precisely when this
      // fires, and the throw escapes the whole export rather than spoiling one
      // total. Seeded at ±Infinity so an all-blank column still reduces to the
      // non-finite value the `shown` line below already turns into 0.
      const extreme = (want: 'MIN' | 'MAX'): number => {
        let acc = want === 'MIN' ? Infinity : -Infinity
        for (const n of nums) {
          if (want === 'MIN' ? n < acc : n > acc) acc = n
        }
        return acc
      }
      const value = fn === 'SUM' ? nums.reduce((a, b) => a + b, 0)
        : fn === 'AVERAGE' ? (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0)
          : fn === 'COUNT' ? nums.length
            : fn === 'MIN' ? extreme('MIN') : extreme('MAX')
      const shown = Number.isFinite(value) ? value : 0
      cells.push(`<c r="${ref}" s="${colStyle[i]}"><f>${fn}(${range})</f><v>${shown}</v></c>`)
    })
    if (cells.length) totalsXml = `<row r="${rows + 2}">${cells.join('')}</row>`
  }

  const widths = cols.map((c, i) => typeof c.w === 'number' && c.w > 0
    ? `<col min="${i + 1}" max="${i + 1}" width="${Math.max(2, (c.w - 5) / 7).toFixed(2)}" customWidth="1"/>`
    : '').join('')

  // DATA VALIDATION, out as well as in — which is the whole of what makes a
  // round trip survive. `<dataValidations>` sits AFTER `<sheetData>` in the
  // CT_Worksheet sequence; Excel refuses to open a file that puts it before,
  // with the same "unreadable content" dialog it gives a truncated zip, so the
  // ordering here is a hard requirement rather than tidiness.
  const dv = writeValidations(cols, rows, sheet.name, findings)

  // THE FROZEN PANE. The header is always pinned — that is what a dataset
  // does, and every workbook this ever wrote said `ySplit="1"` — so what goes
  // out is the header PLUS whatever rows the author froze, and `frozen.cols`
  // as the column split. The `topLeftCell` has to agree with both splits or
  // Excel opens the sheet scrolled somewhere nobody asked for.
  const fz = readFrozenPane(sheet)
  const ySplit = 1 + fz.rows
  const pane = `<pane${fz.cols ? ` xSplit="${fz.cols}"` : ''} ySplit="${ySplit}"` +
    ` topLeftCell="${colToLetters(fz.cols)}${ySplit + 1}"` +
    ` activePane="${fz.cols ? 'bottomRight' : 'bottomLeft'}" state="frozen"/>`

  const lastRow = rows + (totalsXml ? 2 : 1)

  // THE TOTALS ROW GOES OUT AS A TABLE PROPERTY, not only as a row of SUM()s.
  // Excel's totals row belongs to a `ListObject` — which is what a dash
  // dataset IS (docs/dash-sheet-kinds.md) — and writing only the formulas
  // means a re-import cannot tell the total from a deal, so the round trip
  // comes home flatter than it left and the total sorts into the data.
  const table = totalsXml ? tablePart(sheet, cols, rows, index, findings) : undefined

  return {
    xml: `${DECL}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
      `<dimension ref="A1:${colToLetters(Math.max(0, cols.length - 1))}${Math.max(1, lastRow)}"/>` +
      `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      (widths ? `<cols>${widths}</cols>` : '') +
      `<sheetData>${out.join('')}${totalsXml}</sheetData>${dv}` +
      (table ? '<tableParts count="1"><tablePart r:id="rIdT"/></tableParts>' : '') +
      '</worksheet>',
    ...(table ? { table } : {}),
  }
}

const TOTALS_XLSX: Record<string, string> = {
  sum: 'sum', avg: 'average', count: 'count', min: 'min', max: 'max',
}

/**
 * The `<table>` part — one `ListObject` over the whole sheet, header and
 * totals row included.
 *
 * EXCEL IS UNFORGIVING HERE and its complaint is the repair dialog, so the two
 * rules that are actually enforced are checked rather than assumed: every
 * `tableColumn name` must match its header cell EXACTLY, and the names must be
 * non-empty and unique. dash column NAMES are display strings and carry no
 * such promise (two columns may legitimately read "Value"), so a sheet that
 * would break the rule gets no table part at all — the totals row still goes
 * out as SUM() formulas, which is what shipped before this, and the finding
 * says the property did not travel.
 */
function tablePart(
  sheet: TableSheet, cols: readonly Column[], rows: number,
  index: number, findings: XlsxFinding[],
): string | undefined {
  const names = cols.map((c) => c.name.trim())
  const unique = new Set(names.map((n) => n.toLowerCase()))
  if (names.some((n) => !n) || unique.size !== names.length) {
    findings.push({
      code: 'totals-row', sheet: sheet.name,
      message: `The totals row of "${sheet.name}" was written as SUM() formulas rather than as an Excel table, because Excel requires a table's column headings to be present and all different and this sheet's are not. The numbers are the same; re-importing the file will read the total as an ordinary row.`,
    })
    return undefined
  }
  const columns = cols.map((c, i) => {
    const spec = sheet.totals?.[c.id]
    const fn = typeof spec === 'string' ? TOTALS_XLSX[spec] : undefined
    return `<tableColumn id="${i + 1}" name="${escapeXml(names[i])}"` +
      (i === 0 && !fn ? ' totalsRowLabel="Total"' : '') +
      (fn ? ` totalsRowFunction="${fn}"` : '') + '/>'
  }).join('')
  const right = colToLetters(Math.max(0, cols.length - 1))
  const id = `T${index + 1}`
  return `${DECL}<table xmlns="${MAIN_NS}" id="${index + 1}" name="${id}" displayName="${id}"` +
    ` ref="A1:${right}${rows + 2}" headerRowCount="1" totalsRowCount="1">` +
    `<autoFilter ref="A1:${right}${rows + 1}"/>` +
    `<tableColumns count="${cols.length}">${columns}</tableColumns>` +
    `<tableStyleInfo name="TableStyleMedium2" showRowStripes="1"/></table>`
}

/**
 * `<dataValidations>` for every column carrying a rule.
 *
 * The sqref is the column's DATA range — row 2 to row n+1, because dash's row
 * 0 is Excel's row 2 — never the header and never the totals row. Putting the
 * header inside the range is what makes Excel circle a heading as invalid data
 * the first time somebody runs the command.
 *
 * `kind:'formula'` goes out as `type="custom"` with the expression this build
 * never evaluated, verbatim: the `xlsxF` bargain, one level up. Whatever Excel
 * meant by it, Excel gets back.
 *
 * The one rule that CANNOT go out is a list too long for Excel's 255-character
 * `formula1`. Truncating it would export a rule that permits a subset of what
 * the author allowed — a stricter rule than anyone wrote, which would start
 * refusing real values on the other side. So it is dropped and named.
 */
function writeValidations(
  cols: readonly Column[], rows: number, sheetName: string, findings: XlsxFinding[],
): string {
  if (!rows) return ''
  const out: string[] = []
  cols.forEach((col, i) => {
    const rule = columnRule(col)
    if (!rule) return
    const sqref = `${colToLetters(i)}2:${colToLetters(i)}${rows + 1}`
    const common = ` allowBlank="${rule.blank === false ? 0 : 1}"` +
      ` errorStyle="${rule.on === 'reject' ? 'stop' : 'warning'}"` +
      ` error="${escapeXml(rule.message ?? describeRule(rule))}"` +
      ` errorTitle="${escapeXml(sheetName)}"`
    if (rule.kind === 'list') {
      const body = (rule.list ?? []).join(',')
      // Excel's own limit, and it counts the quotes.
      if (body.length + 2 > 255) {
        findings.push({
          code: 'data-validation', sheet: sheetName, column: col.name,
          message: `"${col.name}" has a list rule with ${(rule.list ?? []).length} values, which is longer than the 255 characters Excel allows in a written-out list. It was not exported: a truncated list would have refused values the rule allows.`,
        })
        return
      }
      // `showDropDown` is the INVERSION noted on the import side: 1 HIDES it.
      out.push(`<dataValidation type="list" sqref="${sqref}"${rule.noDropdown ? ' showDropDown="1"' : ''}${common}>` +
        `<formula1>"${escapeXml(body)}"</formula1></dataValidation>`)
      return
    }
    if (rule.kind === 'formula') {
      if (!rule.formula) return
      out.push(`<dataValidation type="custom" sqref="${sqref}"${common}>` +
        `<formula1>${escapeXml(rule.formula.replace(/^=/, ''))}</formula1></dataValidation>`)
      return
    }
    const type = rule.kind === 'number' ? 'decimal'
      : rule.kind === 'date' ? 'date'
        : rule.kind === 'textLength' ? 'textLength' : null
    if (!type) return
    const bound = (b: number | string | undefined): string | null => {
      if (b === undefined) return null
      if (rule.kind === 'date') {
        const serial = typeof b === 'number' ? b : isoToSerial(String(b))
        return serial === null ? null : String(serial)
      }
      const n = Number(b)
      return Number.isFinite(n) ? String(n) : null
    }
    const lo = bound(rule.min)
    const hi = bound(rule.max)
    // An UNBOUNDED rule ("must be a number", no min or max) has no Excel
    // spelling at all — every `decimal` validation carries an operator and at
    // least one formula. It is dropped rather than invented, because inventing
    // a bound is inventing a refusal.
    if (lo === null && hi === null) {
      findings.push({
        code: 'data-validation', sheet: sheetName, column: col.name,
        message: `"${col.name}" must be a ${rule.kind === 'date' ? 'date' : rule.kind === 'number' ? 'number' : 'text length'} with no upper or lower limit. Excel's data validation always compares against a value, so this rule has no equivalent there and was not exported.`,
      })
      return
    }
    const op = lo !== null && hi !== null ? 'between'
      : lo !== null ? 'greaterThanOrEqual' : 'lessThanOrEqual'
    const f1 = lo !== null ? lo : hi!
    out.push(`<dataValidation type="${type}" operator="${op}" sqref="${sqref}"${common}>` +
      `<formula1>${f1}</formula1>${op === 'between' ? `<formula2>${hi}</formula2>` : ''}</dataValidation>`)
  })
  return out.length ? `<dataValidations count="${out.length}">${out.join('')}</dataValidations>` : ''
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
