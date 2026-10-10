// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento table → p:graphicFrame holding a DrawingML a:tbl.
//
// The mapping is a rework of PR #88's tables.ts (which drove PptxGenJS's
// addTable): per-cell resolved fills (headerBg / zebra / cell override),
// element opacity folded into every colour, header row → bold + firstRow,
// borders from the table-wide borderColor/Width, cell padding as margins.
// What PptxGenJS hid — and this module now owns — is the raw OOXML shape:
//
//   - a:tblGrid's gridCol widths are EMU integers and PowerPoint lays the
//     table out from THEM, not from the frame. Bento columns are fractional
//     weights, so the split must round without drift: widths are computed as
//     differences of rounded cumulative edges, which sums exactly to the
//     frame width by construction (three equal thirds of 100 come out
//     33+34+33, never 33+33+33 = a table narrower than its frame).
//   - every a:tr carries an h; the same drift-free split divides the frame
//     height (PowerPoint treats row heights as minimums and grows rows to
//     fit wrapped text, so equal rows is the right default — the browser's
//     table-layout:fixed did the same balancing on the bento side).
//   - a:tcPr's children are ORDERED: lnL/lnR/lnT/lnB must precede the fill,
//     or the part is schema-invalid (a repair dialog, not a rendering bug).
//
// Cell content: bento cells hold the same sanitized inline-HTML subset as
// text elements. Until the text mapper's rich tokenizer is shared, cells go
// through a plain-text strip (tags removed, entities decoded, <br> = new
// paragraph) — the INTEGRATOR should reroute htmlParagraphs through the text
// module's run tokenizer when it lands, so bold/italic spans inside cells
// stop flattening. Cell-level bold/color/align survive regardless (they are
// model fields, not markup).
//
// Not carried, reported instead: rotation (PowerPoint cannot rotate a table
// frame — it silently ignores rot on p:graphicFrame) and the outer corner
// radius (a:tbl has no rounded-outline concept). Both were #88 warnings;
// same verdicts here through the fidelity report.

import { scrubC0, x, type XChild, type XNode } from '../xmlout.ts'
import { typefaceOf } from './fonts.ts'
import { EMU_PER_PX, type OutTable, type OutTableCell } from '../types.ts'
import type { Report } from '../report.ts'

/** The a:graphicData uri that marks a graphicFrame as a table. */
export const TABLE_GRAPHIC_URI = 'http://schemas.openxmlformats.org/drawingml/2006/table'

// --- colour ------------------------------------------------------------------
// css solid → OOXML hex + separate alpha. Shape adopted from PR #88's
// pptxColor/combineTransparency pair (colour and transparency travel apart in
// DrawingML: a:srgbClr@val is opaque, a:alpha is a child). Shared with
// charts.ts (its fallback table and series fills); the integrator may hoist
// this beside the shape mapper's colour code when consolidating.

export interface CssSolid {
  /** 'RRGGBB' uppercase */
  hex: string
  /** 0..1; 0 = fully transparent (emit no fill at all) */
  alpha: number
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

export function cssSolid(value: string | undefined, fallback: string): CssSolid {
  const raw = (value ?? '').trim()
  if (!raw || raw === 'none' || raw === 'transparent') return { hex: fallback, alpha: 0 }
  const rgb = raw.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)%?\s*)?\)$/i)
  if (rgb) {
    const a = rgb[4] === undefined ? 1 : Number(rgb[4]) > 1 ? Number(rgb[4]) / 100 : Number(rgb[4])
    return {
      hex: [rgb[1], rgb[2], rgb[3]]
        .map((n) => clamp(Math.round(Number(n)), 0, 255).toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase(),
      alpha: clamp(a, 0, 1),
    }
  }
  let hex = raw.replace(/^#/, '')
  if (/^[0-9a-f]{3,4}$/i.test(hex)) hex = [...hex].map((c) => c + c).join('')
  if (/^[0-9a-f]{6,8}$/i.test(hex)) {
    return { hex: hex.slice(0, 6).toUpperCase(), alpha: hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1 }
  }
  // Unparseable (a gradient string, a css keyword): a safe colour beats a
  // refused file — same posture as the theme builder in parts.ts.
  return { hex: fallback, alpha: 1 }
}

/** a:solidFill for a css colour with the element's opacity folded in, or null
 *  when the result is fully transparent (the correct emission is NO fill —
 *  alpha val="0" renders the same but bloats every cell). */
export function solidFill(css: string | undefined, fallback: string, opacity = 1): XNode | null {
  const c = cssSolid(css, fallback)
  const a = c.alpha * clamp(opacity, 0, 1)
  if (a <= 0) return null
  return x('a:solidFill', undefined, [
    x('a:srgbClr', { val: c.hex }, a < 1 ? [x('a:alpha', { val: Math.round(a * 100000) })] : undefined),
  ])
}

// --- inline html → plain paragraphs ------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

/**
 * Sanitized inline HTML → plain-text paragraphs. <br> and closed block tags
 * split; every other tag is stripped; the five named entities bento's
 * sanitizer can emit (plus numeric refs) decode. Trailing empty paragraphs
 * drop but interior blanks survive — an author's deliberate empty line in a
 * cell keeps its height. See the header: the integrator swaps this for the
 * text module's tokenizer to keep intra-cell bold/italic.
 */
export function htmlParagraphs(html: string): string[] {
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, body: string) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
        // Refuse surrogate-range and out-of-range refs the same way the
        // parser does; a lone surrogate would poison the emitted part.
        if (!Number.isFinite(code) || code < 0x20 && code !== 9 && code !== 10 && code !== 13 || code > 0x10ffff) return ''
        return String.fromCodePoint(code)
      }
      return NAMED_ENTITIES[body] ?? m
    })
  // Literal C0 controls get the same treatment as encoded ones above: dropped
  // at ingestion (one bad pasted byte costs a character, not the export).
  const paras = scrubC0(text).split('\n')
  while (paras.length > 1 && paras[paras.length - 1].trim() === '') paras.pop()
  return paras
}

// --- drift-free EMU split ----------------------------------------------------

/**
 * Split `totalEmu` across fractional weights so the parts are integers AND
 * sum exactly to the total: each part is the difference of two rounded
 * cumulative edges. Independent per-part rounding drifts by up to
 * weights.length/2 EMU — invisible on screen, but the rig (and a strict
 * diff against PowerPoint's own output) sees a table that no longer fills
 * its frame. Non-positive weights collapse to zero-width columns rather
 * than throwing: a zero-weight column exists in the model, so it must
 * exist in the grid (cell counts have to match gridCol counts).
 */
export function splitEmu(weights: number[], totalEmu: number): number[] {
  const ws = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0))
  const total = ws.reduce((a, b) => a + b, 0) || 1
  let acc = 0
  let prevEdge = 0
  return ws.map((w) => {
    acc += w
    const edge = Math.round((totalEmu * acc) / total)
    const part = edge - prevEdge
    prevEdge = edge
    return part
  })
}

// --- style defaults ----------------------------------------------------------
// Mirrors slides' DEFAULT_TABLE_STYLE (model.ts) so an OutTable whose style
// object is sparse — importer output, hand-written JSON — exports the same
// look the bento renderer would have given it.

interface TableStyleIn {
  headerBg: string
  headerColor: string
  zebra?: string
  borderColor: string
  borderWidth: number
  cellPadX: number
  cellPadY: number
  fontSize: number
  fontFamily?: string
  color: string
  radius: number
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

function readStyle(style: Record<string, unknown> | undefined): TableStyleIn {
  const s = style ?? {}
  return {
    headerBg: str(s.headerBg) ?? '#1E2A3A',
    headerColor: str(s.headerColor) ?? '#FFFFFF',
    zebra: str(s.zebra),
    borderColor: str(s.borderColor) ?? 'rgba(30,42,58,0.14)',
    borderWidth: num(s.borderWidth, 1),
    cellPadX: num(s.cellPadX, 16),
    cellPadY: num(s.cellPadY, 11),
    fontSize: num(s.fontSize, 18),
    fontFamily: str(s.fontFamily),
    color: str(s.color) ?? '#1E2A3A',
    radius: num(s.radius, 10),
  }
}

/** First family of a css stack, quotes stripped — the run-level a:latin wants
 *  one typeface name. Absent = omit; the theme's minor font (the deck font,
 *  per parts.ts) then applies. */
const firstFamily = (stack: string | undefined): string | undefined =>
  stack?.trim() ? typefaceOf(stack) : undefined

// --- the mapper --------------------------------------------------------------

const ALIGN_MAP: Record<string, string> = { center: 'ctr', right: 'r', justify: 'just' }

/**
 * One bento table element → a finished p:graphicFrame node for slidePart's
 * spTreeChildren. `shapeId` is the cNvPr id (the integrator numbers from 2 —
 * the spTree preamble owns 1); `where` is the report locus ('slide 3').
 */
export function tableFrame(el: OutTable, shapeId: number, report: Report, where: string): XNode {
  const st = readStyle(el.style)
  const cx = Math.round(el.w * EMU_PER_PX)
  const cy = Math.round(el.h * EMU_PER_PX)
  const colW = splitEmu(el.columns.map((c) => c.w), cx)
  const rowH = splitEmu(el.rows.map(() => 1), cy)
  const opacity = clamp(num(el.opacity, 1), 0, 1)
  const borderW = Math.round(Math.max(st.borderWidth, 0) * EMU_PER_PX)

  // One border description shared by all four sides of every cell — bento
  // draws a uniform grid (border on every cell in renderTableHtml), so the
  // doubled inner edges PowerPoint collapses are what the browser collapsed
  // too. Fresh nodes per cell: xmlout trees are plain data, but sharing one
  // node across thousands of cells makes any later in-place edit a
  // spooky-action bug.
  const borderSides = (): XChild[] => {
    if (borderW <= 0) return []
    return ['a:lnL', 'a:lnR', 'a:lnT', 'a:lnB'].map((side) =>
      x(side, { w: borderW, cap: 'flat' }, [
        solidFill(st.borderColor, '000000', opacity) ?? x('a:noFill'),
        x('a:prstDash', { val: 'solid' }),
      ]),
    )
  }

  const face = firstFamily(st.fontFamily)
  // bento px → pt → centipoints, clamped to ST_TextFontSize's 100..400000
  const szCentiPt = clamp(Math.round(st.fontSize * 0.75 * 100), 100, 400000)

  const cellNode = (cell: OutTableCell | undefined, ri: number): XNode => {
    const isHeader = el.header && ri === 0
    // Zebra parity follows render.ts (the on-screen truth): body rows count
    // from 0 below the header and stripe the ODD ones. PR #88 striped
    // ri % 2 === 0 of the RAW index, which matches only when a header row is
    // present — the header-less case was off by one there.
    const bodyIndex = el.header ? ri - 1 : ri
    const stripe = !isHeader && st.zebra && bodyIndex % 2 === 1 ? st.zebra : undefined
    const bg = cell?.bg || (isHeader ? st.headerBg : stripe)
    const fg = cell?.color || (isHeader ? st.headerColor : st.color)
    const bold = (cell?.bold ?? false) || isHeader
    const algn = ALIGN_MAP[cell?.align ?? '']

    const paras = htmlParagraphs(cell?.html ?? '')
    // Fresh rPr nodes per paragraph (not one shared subtree) — plain data,
    // but sharing invites spooky-action edits later.
    const runProps = (): XNode => {
      const kids: XChild[] = []
      const fill = solidFill(fg, '000000', opacity)
      if (fill) kids.push(fill)
      if (face) kids.push(x('a:latin', { typeface: face }))
      return x('a:rPr', { sz: szCentiPt, ...(bold ? { b: 1 } : {}) }, kids.length ? kids : undefined)
    }
    const pNodes: XChild[] = (paras.length ? paras : ['']).map((text) => {
      const pKids: XChild[] = []
      if (algn) pKids.push(x('a:pPr', { algn }))
      if (text) {
        pKids.push(x('a:r', undefined, [runProps(), x('a:t', undefined, [text])]))
      } else {
        // An empty paragraph still declares its size so empty rows keep the
        // same height PowerPoint would give a populated one.
        pKids.push(x('a:endParaRPr', { sz: szCentiPt }))
      }
      return x('a:p', undefined, pKids)
    })

    // tcPr child order is fixed by the schema: borders, THEN fill.
    const tcPrKids: XChild[] = [...borderSides()]
    const bgFill = solidFill(bg, 'FFFFFF', opacity)
    if (bgFill) tcPrKids.push(bgFill)
    return x('a:tc', undefined, [
      x('a:txBody', undefined, [x('a:bodyPr'), x('a:lstStyle'), ...pNodes]),
      x('a:tcPr', {
        marL: Math.round(st.cellPadX * EMU_PER_PX),
        marR: Math.round(st.cellPadX * EMU_PER_PX),
        marT: Math.round(st.cellPadY * EMU_PER_PX),
        marB: Math.round(st.cellPadY * EMU_PER_PX),
        // Browsers vertically centre td content by default and bento renders
        // cells with vertical-align:middle explicitly — anchor ctr matches.
        anchor: 'ctr',
      }, tcPrKids.length ? tcPrKids : undefined),
    ])
  }

  const rows: XChild[] = el.rows.map((row, ri) =>
    x('a:tr', { h: rowH[ri] },
      // Cell count MUST equal gridCol count in every row — a ragged model row
      // (mid-edit collab state) pads with empty cells rather than emitting an
      // invalid tr.
      el.columns.map((_, ci) => cellNode(row.cells[ci], ri)),
    ),
  )

  // firstRow/bandRow are style FLAGS, not styling: with no a:tableStyleId we
  // paint every cell explicitly (nothing for a style to contribute), but the
  // flags mean a user who applies a PowerPoint table style later gets the
  // header/banding treatment in the right places. #88's firstRow mapping.
  const tbl = x('a:tbl', undefined, [
    x('a:tblPr', { ...(el.header ? { firstRow: 1 } : {}), ...(st.zebra ? { bandRow: 1 } : {}) }),
    x('a:tblGrid', undefined, colW.map((w) => x('a:gridCol', { w }))),
    ...rows,
  ])

  if (el.rotation) {
    report.add('dropped', 'table-rotation-dropped', where,
      'PowerPoint cannot rotate tables; the table exports axis-aligned (same limitation PR #88 hit)')
  }
  if (st.radius > 0) {
    report.add('dropped', 'table-radius-dropped', where,
      'a:tbl has no outer corner radius; corners export square')
  }

  const morphId = (el as OutTable & { morphId?: string }).morphId
  return x('p:graphicFrame', undefined, [
    x('p:nvGraphicFramePr', undefined, [
      // name carries the bento identity (morph key) so a round-trip can
      // re-pair elements — #88's objectName convention.
      x('p:cNvPr', { id: shapeId, name: `bento:${morphId || el.id}` }),
      x('p:cNvGraphicFramePr', undefined, [x('a:graphicFrameLocks', { noGrp: 1 })]),
      x('p:nvPr'),
    ]),
    x('p:xfrm', undefined, [
      x('a:off', { x: Math.round(el.x * EMU_PER_PX), y: Math.round(el.y * EMU_PER_PX) }),
      x('a:ext', { cx, cy }),
    ]),
    x('a:graphic', undefined, [x('a:graphicData', { uri: TABLE_GRAPHIC_URI }, [tbl])]),
  ])
}
