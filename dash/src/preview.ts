// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The static first-sheet preview: what a bento/dash workbook looks like to
// something that renders its HTML but never runs its JavaScript.
//
// WHY THIS EXISTS. Thumbnailers — iOS Files, macOS QuickLook/Finder, the Bento
// Tray app — render HTML with scripting OFF. Until the runtime boots, every
// workbook is the same bytes plus the same splash, so a folder of dash files
// thumbnails as a wall of identical white boxes with `bento/dash` in the
// middle. A spreadsheet is the document type where recognition matters most:
// people find last quarter's model by remembering what its first screen looked
// like, not by reading a filename.
//
// The kernel (kernel/src/save.ts) owns the placement, the replace-never-append
// rule, the encryption veto and the output-safety check. What lives here is the
// drawing, and the three dash-specific decisions the kernel cannot make:
//
//   1. NEVER SHOW A NUMBER WE DID NOT COMPUTE, AND NEVER SHOW ZERO FOR ONE WE
//      COULD NOT. A formula column has no stored values — the file holds the
//      EXPRESSION (store.ts) — so a preview that printed `0` where it could not
//      recalculate would be publishing a wrong number in the one artefact
//      nobody proofreads. Small sheets are recalculated properly; big ones show
//      the `fx` chip and an empty cell, which reads as "computed elsewhere".
//      model.ts states the rule for unresolved steps in the same words: an
//      empty bar chart reads as ZERO, which is a number, which is a lie.
//   2. A PARTIAL TOTAL IS WORSE THAN NO TOTAL. The totals row is dash's answer
//      to `=SUM(B2:B41)` falling out of range, so summing only the rows the
//      preview happens to draw would put exactly the failure it refuses into
//      the thumbnail. Past TOTALS_SCAN_ROWS the row is omitted entirely.
//   3. THEME COLOURS ARE AUTHOR DATA AND REACH A <style> BLOCK. Escaping `<`
//      is enough for markup and is NOT enough inside a stylesheet: a theme
//      accent of `#fff}body{display:none` closes the rule and writes new ones.
//      Every colour that reaches CSS goes through `cssColor()` first.
//
// HOW IT SCALES. `transform: scale(calc(100vw / <table width>px))` with a
// `transform: none` declaration in front of it. CSS Values 4 length-over-length
// division yields the plain <number> scale() needs; a renderer that rejects it
// drops the second declaration and keeps the first, showing the table at 1:1
// (cropped, but the workbook) instead of nothing. This is slides' measured
// recipe (slides/src/preview.ts) — verified there in the real macOS
// thumbnailer, `qlmanage -t` — with the fixed 1280×720 page swapped for the
// table's own width, because a grid has no aspect ratio of its own.
//
// WHY MARKUP AS A STRING, not DOM built and serialized. Two reasons, both
// practical: the byte budget is then measured on the exact bytes that reach the
// file rather than on a re-serialization of them, and every decision in here
// stays testable in node with no DOM at all — which is what
// `scripts/test-dash-preview.ts` exercises. The DOM appears once, in
// `buildSheetPreview`, which is the only function the kernel calls.

import { isEncryptionActive } from '../../kernel/src/save.ts'
import { formatValue, alignFor, TYPE_LABEL } from './format.ts'
import { readCell } from './store.ts'
import { hiddenSet } from './rowcol.ts'
import { colToLetters } from './a1.ts'
import { recalc, isErr, type Vec } from './formula.ts'
import { FORMAT } from './model.ts'
import type {
  CanvasSheet, Column, ColumnType, DashDoc, Sheet, TableSheet,
} from './model.ts'

/**
 * What the preview may cost, in bytes of markup.
 *
 * It is paid in EVERY saved file and it cannot be compressed: the shell's
 * deflate trick is unavailable to an audience that never runs the loader. It
 * lives here rather than beside the budgets in model.ts because those all bound
 * the DOCUMENT — the thing the format promises to carry — and this bounds shell
 * furniture that no reader of the format ever sees.
 *
 * 40KB buys roughly 16 rows × 8 columns of real data with room to spare; the
 * tiers below spend it down rather than overrun it.
 */
export const PREVIEW_BUDGET = 40 * 1024

/**
 * How much of the sheet to draw, cheapest acceptable tier first. Each is tried
 * whole and measured; the first that fits wins, and the title card below cannot
 * exceed the budget, so this always terminates with something.
 */
const TIERS: Array<{ rows: number; cols: number }> = [
  { rows: 16, cols: 8 },
  { rows: 10, cols: 6 },
  { rows: 6, cols: 4 },
]

/**
 * Recalculate formula columns only up to here.
 *
 * `recalc` (formula.ts) materializes EVERY column as a full Vec and computes
 * every formula column over every row — the right thing for a grid that is
 * about to paint, and absurd for the fourteen rows a thumbnail shows. A save
 * must never stall on its own decoration, so past this the formula columns draw
 * empty with an `fx` chip instead. 5,000 rows is ~2ms and covers the workbooks
 * people actually eyeball in a file manager.
 */
const RECALC_ROWS = 5_000

/** Totals are computed over the WHOLE column or not at all — see (2) above. */
const TOTALS_SCAN_ROWS = 100_000

/** Longest cell text kept. CSS clips the overflow anyway; this is about bytes.
 *  Column names get their own, larger cap for the same reason: nothing in the
 *  format bounds a name, and eight of them are drawn at every tier. */
const CELL_CHARS = 40
const NAME_CHARS = 60

const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The design width the whole preview is scaled from, clamped either side so a
 *  two-column sheet is not blown up to billboard size nor a wide one shrunk to
 *  a grey texture. */
const MIN_W = 720
const MAX_W = 1600

const GUTTER_W = 44
const ROW_H = 34
/** The collapsed table border that lives outside the column widths. */
const EDGE = 2

/**
 * Fallbacks matching styles.css. A document's `theme` is optional (model.ts),
 * and a workbook that never set one must still thumbnail like the app.
 */
const INK = '#1e2a3a'
const MUTED = '#64748b'
const LINE = '#e3e8ef'
const PANEL = '#f8fafc'
const ACCENT = '#f7a600'
const PAPER = '#ffffff'

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/**
 * A colour string safe to paste into a stylesheet, or the fallback.
 *
 * ESCAPING HTML DOES NOT COVER THIS. `esc()` protects markup; a value landing
 * inside a `<style>` block or a `style=""` attribute is in CSS, where `}` and
 * `;` are the dangerous characters and `<` is not. `theme.accent` is ordinary
 * author data — an agent writes it through `window.bento`, an import could
 * carry it — so `#fff}body{display:none` is a preview that blanks the page it
 * is embedded in, and `url(https://…)` is a preview that phones home from a
 * file the reader believed was self-contained (PLATFORM §1).
 *
 * So: an allowlist of the characters colour notations actually use, with no
 * `url(`, and a length cap. Anything else falls back rather than being
 * "cleaned" — a colour we do not recognise is not worth guessing at.
 */
export function cssColor(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback
  const s = v.trim()
  if (!s || s.length > 32) return fallback
  if (!/^[#a-zA-Z0-9(),.%\s/-]+$/.test(s)) return fallback
  if (/url|expression|@|\\/i.test(s)) return fallback
  return s
}

// --- reading the sheet -------------------------------------------------------

const rowsOf = (sheet: TableSheet): number =>
  sheet.rids.reduce((n, [, c]) => n + c, 0)

/**
 * A column width safe to put in a stylesheet.
 *
 * `Column.w` is `number` in the type and ANY value in a file — the format is
 * additive and hand-edited (model.ts), and `[extra: string]: unknown` means
 * nothing validates it. A NaN reaches the frame's `scale(calc(100vw / NaNpx))`
 * and takes the whole preview down with it, silently, in every saved file.
 */
const colW = (c: Column): number =>
  typeof c.w === 'number' && Number.isFinite(c.w) ? Math.min(600, Math.max(40, Math.round(c.w))) : 130

/**
 * The first `n` rids in canonical order.
 *
 * CANONICAL, never the grid's order vector: sorting and filtering are VIEW
 * state that never enters the document (store.ts `view()`), so the file cannot
 * know about them and a second reader of the same file would thumbnail
 * differently. Stops as soon as it has enough — a 250k-row sheet must not be
 * expanded to draw sixteen rows.
 */
function firstRids(sheet: TableSheet, n: number): number[] {
  const out: number[] = []
  for (const [start, count] of sheet.rids) {
    for (let i = 0; i < count && out.length < n; i++) out.push(start + i)
    if (out.length >= n) break
  }
  return out
}

/** Formula columns, computed, when that is cheap enough to be free. Never
 *  throws: a preview is a nicety and a broken expression is not its business. */
function computeFormulas(sheet: TableSheet): Map<string, Vec> | null {
  if (!sheet.columns.some((c) => c.formula)) return null
  if (rowsOf(sheet) > RECALC_ROWS) return null
  try {
    return recalc(sheet).values
  } catch {
    return null
  }
}

/**
 * One cell, in the grid's own precedence order (grid.ts `valueAt`): a computed
 * column beats a hand override, which beats the stored value. Per-cell formulas
 * (`cells["<col>:<rid>"].f`) are deliberately NOT evaluated — they need the
 * whole cell-formula graph, and an unevaluated one draws blank, which is the
 * honest answer under rule (1).
 */
function cellValue(
  sheet: TableSheet, col: Column, rid: number, row: number, computed: Map<string, Vec> | null,
): unknown {
  const comp = computed?.get(col.id)
  if (comp) return comp[row] ?? null
  const over = sheet.cells?.[`${col.id}:${rid}`]
  if (over && 'v' in over) return over.v
  return readCell(sheet.data[col.id], row)
}

/** Display text for a value, bounded in length. */
function text(v: unknown, col: Pick<Column, 'type' | 'format'>): string {
  if (v == null || v === '') return ''
  if (isErr(v)) return v.code
  return cap(formatValue(v, col), CELL_CHARS)
}

const AGG_LABEL: Record<string, string> = {
  sum: 'SUM', avg: 'AVG', count: 'COUNT', min: 'MIN', max: 'MAX',
}

/**
 * The totals row, or null.
 *
 * Scans the WHOLE column — see rule (2). A custom `{f}` total is a formula we
 * are not evaluating here, so it shows its label and no number rather than a
 * number that might be wrong.
 */
function totalsRow(
  sheet: TableSheet, columns: Column[], computed: Map<string, Vec> | null,
): Array<{ label: string; value: string }> | null {
  const totals = sheet.totals
  if (!totals) return null
  const n = rowsOf(sheet)
  if (n > TOTALS_SCAN_ROWS) return null

  return columns.map((col) => {
    const spec = totals[col.id]
    if (!spec) return { label: '', value: '' }
    if (typeof spec !== 'string') return { label: 'ƒ', value: '' }
    const comp = computed?.get(col.id)
    const data = sheet.data[col.id]
    let sum = 0, count = 0, min = Infinity, max = -Infinity
    for (let r = 0; r < n; r++) {
      const raw = comp ? comp[r] : readCell(data, r)
      if (raw == null || raw === '' || isErr(raw)) continue
      const num = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(num)) { count++; continue }
      sum += num; count++
      if (num < min) min = num
      if (num > max) max = num
    }
    const value = spec === 'count' ? String(count)
      : count === 0 ? ''
        : spec === 'sum' ? formatValue(sum, col)
          : spec === 'avg' ? formatValue(sum / count, col)
            : spec === 'min' ? formatValue(min, col)
              : spec === 'max' ? formatValue(max, col)
                : ''
    return { label: AGG_LABEL[spec] ?? spec.toUpperCase(), value }
  })
}

// --- drawing -----------------------------------------------------------------

interface Palette {
  ink: string; muted: string; line: string; panel: string; accent: string; paper: string
}

const paletteOf = (doc: DashDoc): Palette => ({
  ink: cssColor(doc.theme?.color, INK),
  muted: MUTED,
  line: LINE,
  panel: PANEL,
  accent: cssColor(doc.theme?.accent, ACCENT),
  paper: cssColor(doc.theme?.background, PAPER),
})

/**
 * The one stylesheet, scoped to `.dxp`.
 *
 * A `<style>` inside the preview is document-global for the audience that sees
 * it — a thumbnailer runs no script, so nothing removes it — which is the same
 * leak render.ts's `scopeCss` exists for on svg elements. Every selector is
 * therefore prefixed, and every class name carries the `dxp-` prefix so it can
 * collide with nothing the app or another Bento app paints.
 */
const sheetCss = (p: Palette): string =>
  // The app's `* { box-sizing: border-box }` (styles.css) is in the compressed
  // payload, which this audience never inflates — so the preview restates it
  // for its own subtree. Not cosmetic: `table-layout:fixed` honours the
  // colgroup widths, and without border-box each cell's 16px of padding and 1px
  // of border are added OUTSIDE them, so the table renders wider than the width
  // the frame was scaled from and the right-hand column is sliced off. Measured
  // in Chrome at 914px: the last column lost its type chip.
  `.dxp *{box-sizing:border-box}` +
  `.dxp{position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483000;` +
  `overflow:hidden;background:${p.paper};` +
  `font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;` +
  `color:${p.ink};-webkit-font-smoothing:antialiased}` +
  `.dxp-bar{display:flex;align-items:baseline;gap:10px;padding:14px 16px 12px;` +
  `border-bottom:1px solid ${p.line};background:${p.panel}}` +
  `.dxp-rule{width:34px;height:5px;border-radius:3px;background:${p.accent}}` +
  `.dxp-title{font-weight:700;font-size:19px;white-space:nowrap;overflow:hidden}` +
  `.dxp-sheet{color:${p.muted};font-size:13px;white-space:nowrap;overflow:hidden}` +
  `.dxp-count{margin-left:auto;color:${p.muted};font-size:12px;white-space:nowrap}` +
  `.dxp-t{border-collapse:collapse;table-layout:fixed;width:100%;` +
  `font-variant-numeric:tabular-nums}` +
  `.dxp-t td,.dxp-t th{height:${ROW_H}px;padding:0 8px;border-right:1px solid ${p.line};` +
  `border-bottom:1px solid ${p.line};overflow:hidden;white-space:nowrap;text-align:left;` +
  `font-weight:400}` +
  `.dxp-t th{background:${p.panel};font-weight:600;border-bottom:1px solid ${p.line}}` +
  `.dxp-g{width:${GUTTER_W}px;background:${p.panel};color:${p.muted};text-align:center;` +
  `font-size:12px}` +
  `.dxp-t tr:nth-child(even) td{background:#fcfdfe}` +
  `.dxp-t tr:nth-child(even) td.dxp-g{background:${p.panel}}` +
  `.dxp-r{text-align:right}` +
  `.dxp-type{font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:${p.muted};` +
  `border:1px solid ${p.line};border-radius:5px;padding:0 4px;margin-left:6px;background:${p.paper}}` +
  `.dxp-fx{font-size:9px;font-weight:600;color:${p.accent};border:1px solid ${p.accent};` +
  `border-radius:4px;padding:0 3px;margin-left:6px}` +
  `.dxp-tot td{background:${p.panel};font-weight:600;border-top:1px solid ${p.line}}` +
  `.dxp-agg{color:${p.muted};font-weight:400;font-size:11px;margin-right:6px}` +
  `.dxp-card{padding:64px 16px;text-align:center;color:${p.muted}}` +
  `.dxp-card b{display:block;font-size:34px;color:${p.ink};margin:14px 0 6px}`

/**
 * The fixed overlay + the width-fitting wrapper. `w` is the table's own width,
 * so the grid always fills the thumbnail regardless of the viewport it is
 * rendered into.
 */
function frame(inner: string, p: Palette, w: number): string {
  // BUILT BY CONCATENATION, never as a literal `<style>` in the source. The
  // same rule save.ts follows for `</script>`, and for the same reason: this
  // string ends up inside the JS bundle, and postbuild-compress.mjs finds the
  // app stylesheet by scanning the built HTML for the first big `<style>`. A
  // literal one here is matched FIRST — the whole runtime CSS was then left
  // uncompressed and unregistered, and the app booted completely unstyled.
  const OPEN = `<${'style'}>`
  const CLOSE = `</${'style'}>`
  return `<div class="dxp">${OPEN}${sheetCss(p)}${CLOSE}` +
    // Two `transform` declarations on purpose: a renderer that rejects CSS
    // Values 4 length division keeps the first and shows the table at 1:1.
    `<div style="width:${w}px;transform-origin:0 0;transform:none;` +
    `transform:scale(calc(100vw / ${w}px))">${inner}</div></div>`
}

const headline = (doc: DashDoc, sheet: Sheet, note: string): string =>
  `<div class="dxp-bar"><span class="dxp-rule"></span>` +
  `<span class="dxp-title">${esc(doc.title || 'Untitled workbook')}</span>` +
  `<span class="dxp-sheet">${esc(sheet.name || '')}</span>` +
  `<span class="dxp-count">${esc(note)}</span></div>`

const nf = (n: number): string => n.toLocaleString('en-US')

/** A table sheet, at one tier. */
function tableMarkup(
  doc: DashDoc, sheet: TableSheet, tier: { rows: number; cols: number }, p: Palette,
): string {
  const hidden = hiddenSet(sheet)
  const all = sheet.columns.filter((c) => !hidden.has(c.id))
  const columns = all.slice(0, tier.cols)
  const total = rowsOf(sheet)
  const rids = firstRids(sheet, tier.rows)
  const computed = computeFormulas(sheet)

  // +EDGE for the collapsed outer border: measured at 914px the table's own
  // scrollWidth was 915, so the scale was computed from a width one pixel
  // narrower than the thing being scaled and the last column lost a hairline.
  const width = Math.min(MAX_W, Math.max(MIN_W,
    GUTTER_W + EDGE + columns.reduce((n, c) => n + colW(c), 0)))

  const cols = `<colgroup><col style="width:${GUTTER_W}px">` +
    columns.map((c) => `<col style="width:${colW(c)}px">`).join('') +
    '</colgroup>'

  const head = `<tr><th class="dxp-g"></th>` + columns.map((c) =>
    `<th>${esc(cap(c.name || c.id, NAME_CHARS))}` +
    `<span class="dxp-type">${esc(TYPE_LABEL[c.type as ColumnType] ?? String(c.type))}</span>` +
    // The fx chip is not decoration: it is what makes an empty computed cell
    // read as "derived", not as "blank" (rule 1).
    (c.formula ? `<span class="dxp-fx">fx</span>` : '') +
    `</th>`).join('') + '</tr>'

  const body = rids.map((rid, i) =>
    `<tr><td class="dxp-g">${i + 1}</td>` + columns.map((c) => {
      const v = cellValue(sheet, c, rid, i, computed)
      const cls = alignFor(c.type) === 'right' ? ' class="dxp-r"' : ''
      return `<td${cls}>${esc(text(v, c))}</td>`
    }).join('') + '</tr>').join('')

  const totals = totalsRow(sheet, columns, computed)
  const foot = totals && totals.some((t) => t.label || t.value)
    ? `<tr class="dxp-tot"><td class="dxp-g"></td>` + totals.map((t, i) => {
      const cls = alignFor(columns[i].type) === 'right' ? ' class="dxp-r"' : ''
      return `<td${cls}>${t.label ? `<span class="dxp-agg">${esc(t.label)}</span>` : ''}` +
        `${esc(t.value)}</td>`
    }).join('') + '</tr>'
    : ''

  const more = all.length > columns.length ? ` · +${all.length - columns.length} more` : ''
  const note = `${nf(total)} row${total === 1 ? '' : 's'} × ${nf(all.length)} column${all.length === 1 ? '' : 's'}${more}`

  return frame(
    headline(doc, sheet, note) + `<table class="dxp-t">${cols}${head}${body}${foot}</table>`,
    p, width,
  )
}

/**
 * A canvas sheet — the sparse A1 map. Drawn with letter and number headers,
 * because that IS what a canvas sheet looks like and it is how a reader tells
 * one apart from a table sheet at thumbnail size.
 */
function canvasMarkup(
  doc: DashDoc, sheet: CanvasSheet, tier: { rows: number; cols: number }, p: Palette,
): string {
  const keys = Object.keys(sheet.cells ?? {})
  // The used range, from the keys themselves: a canvas sheet has no row count
  // to read, and parsing is cheaper than being wrong about where it starts.
  let maxRow = 1, maxCol = 1
  for (const k of keys) {
    const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(k)
    if (!m) continue
    let c = 0
    for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64)
    maxCol = Math.max(maxCol, c)
    maxRow = Math.max(maxRow, Number(m[2]))
  }
  const nc = Math.min(tier.cols, Math.max(1, maxCol))
  const nr = Math.min(tier.rows, Math.max(1, maxRow))
  const width = Math.min(MAX_W, Math.max(MIN_W, GUTTER_W + EDGE + nc * 130))

  const head = `<tr><th class="dxp-g"></th>` +
    Array.from({ length: nc }, (_, c) => `<th class="dxp-g">${colToLetters(c)}</th>`).join('') + '</tr>'

  const body = Array.from({ length: nr }, (_, r) =>
    `<tr><td class="dxp-g">${r + 1}</td>` + Array.from({ length: nc }, (_, c) => {
      const cell = sheet.cells?.[`${colToLetters(c)}${r + 1}`]
      // `f` with no `v` is a formula whose value lives nowhere in the file:
      // blank, never a guess (rule 1).
      const v = cell && 'v' in cell ? cell.v : null
      const numeric = typeof v === 'number'
      return `<td${numeric ? ' class="dxp-r"' : ''}>` +
        esc(text(v, { type: numeric ? 'number' : 'text', format: cell?.format })) + '</td>'
    }).join('') + '</tr>').join('')

  const note = `${nf(keys.length)} cell${keys.length === 1 ? '' : 's'}`
  return frame(
    headline(doc, sheet, note) +
    `<table class="dxp-t"><colgroup><col style="width:${GUTTER_W}px">` +
    Array.from({ length: nc }, () => '<col style="width:130px">').join('') +
    `</colgroup>${head}${body}</table>`,
    p, width,
  )
}

/** Last resort: the workbook's identity in its own colours, a few hundred bytes.
 *  Bounded by construction — the title is capped — so this can never overrun. */
function cardMarkup(doc: DashDoc, p: Palette): string {
  const sheets = doc.sheets?.length ?? 0
  const rows = (doc.sheets ?? []).reduce(
    (n, s) => n + (s.kind === 'table' ? rowsOf(s) : 0), 0)
  const title = (doc.title || 'Untitled workbook').slice(0, 80)
  return frame(
    `<div class="dxp-card"><span class="dxp-rule" style="margin:0 auto"></span>` +
    `<b>${esc(title)}</b>` +
    `${esc(`${nf(sheets)} sheet${sheets === 1 ? '' : 's'} · ${nf(rows)} row${rows === 1 ? '' : 's'}`)}` +
    `</div>`, p, MIN_W)
}

// --- the provider ------------------------------------------------------------

/**
 * The preview markup for this workbook, or null for "no preview".
 *
 * Pure: no DOM, no side effects, bytes measured on exactly what reaches the
 * file. `scripts/test-dash-preview.ts` drives this directly.
 *
 * THE ENCRYPTION CHECK HERE IS BELT AND BRACES, not the gate. The kernel's
 * `previewAllowed` is the real one and it has two signals — the in-memory
 * password flag AND the re-parsed `bento/enc` body — of which a provider can
 * only ever see the first, because it is handed a document and never the block
 * that will be written. It is repeated anyway because the cost is one function
 * call and the failure is publishing the first sheet of every password-
 * protected workbook: rows of real numbers, in plaintext, beside the ciphertext
 * that exists to hide them. A missing thumbnail is the correct price of a
 * password.
 */
export function previewMarkup(doc: DashDoc): string | null {
  if (isEncryptionActive()) return null
  const sheet = doc.sheets?.[0]
  if (!sheet) return null
  const p = paletteOf(doc)

  for (const tier of TIERS) {
    const html = sheet.kind === 'canvas'
      ? canvasMarkup(doc, sheet, tier, p)
      : tableMarkup(doc, sheet as TableSheet, tier, p)
    if (byteLength(html) <= PREVIEW_BUDGET) return html
  }
  return cardMarkup(doc, p)
}

export const byteLength = (s: string): number => new TextEncoder().encode(s).length

/**
 * Build the static preview of the workbook's first sheet. Registered with the
 * kernel from main.ts (`registerPreview`).
 *
 * The kernel imports this node into the shell clone, checks it with
 * `previewIsSafe` and writes it followed IMMEDIATELY by a parser-blocking
 * remover script — so a reader with scripting never paints a frame containing
 * it, and a thumbnailer, which runs no script, keeps it. Nothing here enters
 * `#bento-doc`: the preview is shell furniture, and a file saved by a build
 * without one opens identically.
 */
const isDashDoc = (d: unknown): d is DashDoc =>
  typeof d === 'object' && d !== null
  && (d as { format?: unknown }).format === FORMAT
  && Array.isArray((d as { sheets?: unknown }).sheets)

export function buildSheetPreview(doc: unknown): HTMLElement | null {
  // The kernel types this as `KernelDoc` and can hand over anything a future
  // build embeds. DECLINE rather than cast: this runs inside serialization, so
  // a throw here does not fail the thumbnail, it fails the SAVE.
  if (!isDashDoc(doc)) return null
  const html = previewMarkup(doc)
  if (!html) return null
  const host = document.createElement('div')
  // innerHTML on a detached div, so the string above is what the file carries.
  // The kernel re-checks the result with previewIsSafe; this is not the gate.
  host.innerHTML = html
  return (host.firstElementChild as HTMLElement | null) ?? null
}
