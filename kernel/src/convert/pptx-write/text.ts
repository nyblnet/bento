// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Bento text element → p:sp with a p:txBody.
//
// The mapping decisions here are PR #88's (its exporter drove real PowerPoint
// through PptxGenJS and learned where the bodies are); the emission is
// first-party OOXML through xmlout. Adopted from #88 and credited inline where
// they bite: the b/i/u/br run walker with its trailing-break trim, CODE →
// Courier New, fontWeight ≥ 600 → bold, per-run hyperlinks, zero text-box
// insets, shrink-to-fit, the `bento:<id>` object name, and the
// text-gradient/effects report codes. Where this module DIVERGES from #88 it
// says so and why — a first-party writer is not bound by PptxGenJS's blind
// spots (strike-through, hollow glyphs, real letter-spacing).
//
// No DOM anywhere: the input html is the sanitizer's inline subset
// (render.ts ALLOWED_TAGS: B I U BR SPAN DIV P STRONG EM S CODE — attributes
// already stripped), which a ~40-line tokenizer covers completely. The kernel
// must run under node, and pulling in a DOM shim for eleven known tags would
// be the dependency this rework exists to delete.

import { EMU_PER_PX } from '../types.ts'
import type { Report } from '../report.ts'
import { scrubC0, x, type XChild, type XNode } from '../xmlout.ts'

// --- input --------------------------------------------------------------------
// Structural subset of slides' TextElement (same inversion as types.ts: the
// kernel never imports from an app). The real element is a superset; unknown
// fields are ignored, the effect-shaped ones are read only to REPORT them.

export interface TextElIn {
  id: string
  morphId?: string
  x: number; y: number; w: number; h: number
  /** degrees, clockwise */
  rotation: number
  opacity: number
  /** sanitized inline html (render.ts sanitizeHtml's subset) */
  html: string
  /** px — bento's canvas unit, NOT points */
  fontSize: number
  fontFamily: string
  fontWeight: number
  color: string
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'middle' | 'bottom'
  /** multiplier (1.25 = 125%) */
  lineHeight: number
  /** px tracking for letter-spaced caps labels */
  letterSpacing?: number
  textStroke?: { width: number; color: string; fill?: string }
  placeholder?: string
  colorGradient?: unknown
  shadow?: unknown
  blur?: number
  blend?: string
  backdropFilter?: number
}

/** Values dynamic field tokens resolve against — same shape render.ts's
 *  FieldContext computes per slide; the caller ports fieldContext's arithmetic
 *  (page = 1-based position among non-state slides). */
export interface FieldValues {
  page: number
  pages: number
  title: string
  date: Date
  author: string
  company: string
  subject: string
  event: string
}

export interface TextSpOpts {
  /** p:cNvPr id — the integrator allocates, starting at 2 (the spTree preamble
   *  claims 1) */
  shapeId: number
  /** doc.theme.fontFamily — the fallback when the element has no stack */
  themeFontFamily: string
  /** omit = {{tokens}} stay literal text, mirroring resolveFields without ctx */
  fields?: FieldValues
  /** element `link` mapped upstream: the integrator allocates the rel (slide
   *  jump or external URL) and hands the id down */
  link?: { rId: string; slideJump?: boolean }
  report?: Report
  /** source location for report entries, e.g. 'slide 4' */
  where?: string
}

// --- colour -------------------------------------------------------------------
// Ported from #88's pptxColor, alpha kept 0..1 instead of a transparency
// percentage (raw OOXML wants a:alpha in 1000ths of a percent, so the
// percentage detour would just round twice).

export interface CssColor { hex: string; alpha: number }

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

/** '#abc', '#aabbccdd', rgb()/rgba(), 'transparent' → six-digit hex + alpha.
 *  Unparseable input falls back opaque: a wrong-but-visible colour beats an
 *  invisible run the author cannot diagnose. */
export function cssColor(value?: string, fallback = '000000'): CssColor {
  const raw = (value ?? '').trim()
  if (!raw || raw === 'none' || raw === 'transparent') return { hex: fallback, alpha: 0 }
  const rgb = raw.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)%?)?\s*\)$/i)
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
  return { hex: fallback, alpha: 1 }
}

/** a:solidFill; a:alpha only when translucent — PowerPoint writes opaque
 *  colours bare, and matching the native shape keeps diffs readable. */
function solidFill(hex: string, alpha: number): XNode {
  return x('a:solidFill', undefined, [
    x('a:srgbClr', { val: hex }, alpha < 1 ? [x('a:alpha', { val: Math.round(clamp(alpha, 0, 1) * 100000) })] : undefined),
  ])
}

// --- the inline-html tokenizer ------------------------------------------------

export interface RunStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  /** CODE → Courier New, #88's mapping (OOXML has no semantic code run) */
  code?: boolean
}

export interface InlineRun {
  text: string
  style: RunStyle
  /** a line break follows this run. A FLAG, not a token — #88's breakLine
   *  semantics, kept exactly: consecutive <br><br> collapse into one break. */
  breakAfter: boolean
}

// Entities the sanitizer's innerHTML round-trip can emit: the five XML-ish
// named ones, &nbsp; (contentEditable's favourite), and numeric references.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      // C0 controls (minus tab/lf/cr) are unrepresentable in XML 1.0 — xmlout
      // would throw on the whole part. One corrupt entity must not kill an
      // export, so it decodes to nothing.
      if (!Number.isFinite(code) || code > 0x10ffff) return m
      if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) return ''
      return String.fromCodePoint(code)
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m
  })
}

const sameStyle = (a: RunStyle, b: RunStyle): boolean =>
  !a.bold === !b.bold && !a.italic === !b.italic && !a.underline === !b.underline &&
  !a.strike === !b.strike && !a.code === !b.code

/**
 * Parse the sanitized inline subset into flat styled runs — #88's richRuns
 * walker without the DOM. b/strong, i/em, u, s/strike nest via a style stack;
 * br marks a break; span is transparent; any other tag (the sanitizer should
 * have unwrapped it, but paste boundaries have leaked before) contributes only
 * its children's text. Attributes are skipped unparsed — the sanitizer strips
 * them, and nothing here should trust one that survived.
 *
 * ONE deliberate divergence from #88: div/p mark a break on OPEN as well as on
 * close. contentEditable's most common shape is `line1<div>line2</div>` — the
 * first line bare, each further line wrapped — and close-only breaking glues
 * line1 to line2 (a real #88 bug, visible in its own output). The breakAfter
 * flag is idempotent, so `</div><div>` seams still collapse to one break.
 *
 * The TRAILING-BREAK TRIM is #88's, kept exactly: contentEditable loves to
 * leave a final <br> (or an empty trailing <div>), and without the trim every
 * exported box gains a phantom empty line that PowerPoint then includes in
 * anchor math — a bottom-anchored label visibly floats one line high. The rig
 * demonstrates the phantom by passing trimTrailingBreak=false.
 */
export function parseInlineHtml(html: string, trimTrailingBreak = true): InlineRun[] {
  const runs: InlineRun[] = []
  const stack: RunStyle[] = [{}]

  const pushText = (raw: string) => {
    // The canvas paints this html with white-space:normal, so runs of
    // ordinary whitespace collapse to one space in every Bento surface — the
    // export matches the PAINT, not the markup. &nbsp; (U+00A0) is not in the
    // class and survives, which is exactly how authors spell a hard space.
    // scrubC0: a LITERAL control char (a bad paste, a corrupt import) gets the
    // same treatment the entity decoder gives an encoded one — dropped, so it
    // costs a character instead of throwing away the whole export at serialize.
    let text = scrubC0(decodeEntities(raw)).replace(/[ \t\r\n]+/g, ' ')
    const last = runs[runs.length - 1]
    // browser layout also eats whitespace at a line start / across a seam
    if (!last || last.breakAfter || last.text.endsWith(' ')) text = text.replace(/^ +/, '')
    if (!text) return
    const style = stack[stack.length - 1]
    if (last && !last.breakAfter && sameStyle(last.style, style)) last.text += text
    else runs.push({ text, style: { ...style }, breakAfter: false })
  }

  const markBreak = () => {
    if (runs.length) runs[runs.length - 1].breakAfter = true
    else runs.push({ text: '', style: {}, breakAfter: true })
  }

  const TAG = /<\/?([a-zA-Z][a-zA-Z0-9]*)(?:[\s/][^>]*)?>/g
  let pos = 0
  for (let m = TAG.exec(html); m; m = TAG.exec(html)) {
    if (m.index > pos) pushText(html.slice(pos, m.index))
    pos = m.index + m[0].length
    const closing = m[0][1] === '/'
    const tag = m[1].toUpperCase()
    if (tag === 'BR') { markBreak(); continue }
    if (tag === 'DIV' || tag === 'P') { if (runs.length) markBreak(); continue }
    const next = { ...stack[stack.length - 1] }
    switch (tag) {
      case 'B': case 'STRONG': next.bold = true; break
      case 'I': case 'EM': next.italic = true; break
      case 'U': next.underline = true; break
      case 'S': case 'STRIKE': next.strike = true; break
      case 'CODE': next.code = true; break
      default: continue // span + unknown: transparent, children pass through
    }
    if (closing) { if (stack.length > 1) stack.pop() }
    else stack.push(next)
  }
  if (pos < html.length) pushText(html.slice(pos))

  if (trimTrailingBreak && runs.length) runs[runs.length - 1].breakAfter = false
  return runs
}

// --- dynamic fields -----------------------------------------------------------
// resolveFields' semantics PORTED, not imported (kernel cannot reach slides/):
// same token grammar, same zero-pad rule ({{page:2}} → "06"), same
// empty-string default for missing doc-props. The two tokens PowerPoint can
// keep LIVE become a:fld — {{page}} → type="slidenum" (330 census hits, THE
// footer field) and {{date}} → type="datetime"; every other token freezes to
// the text it resolved to at export time.

const FIELD_RE = /\{\{\s*(page|pages|title|date|time|author|company|subject|event)(?::([^}]*))?\s*\}\}/gi

const pad = (n: number, arg?: string): string => {
  const w = parseInt(arg ?? '', 10)
  return w > 0 ? String(n).padStart(w, '0') : String(n)
}

type Piece =
  | { kind: 'text'; text: string }
  | { kind: 'fld'; type: 'slidenum' | 'datetime'; cached: string; frozenPad: boolean }

function splitFields(text: string, ctx: FieldValues | undefined, onFrozen: (token: string) => void): Piece[] {
  if (!ctx || text.indexOf('{{') < 0) return [{ kind: 'text', text }]
  const pieces: Piece[] = []
  let pos = 0
  FIELD_RE.lastIndex = 0
  for (let m = FIELD_RE.exec(text); m; m = FIELD_RE.exec(text)) {
    if (m.index > pos) pieces.push({ kind: 'text', text: text.slice(pos, m.index) })
    pos = m.index + m[0].length
    const arg = m[2]
    switch (m[1].toLowerCase()) {
      case 'page':
        // the cached a:t honours the pad; the live field re-renders unpadded
        // the moment PowerPoint recomputes — an approximation, reported below
        pieces.push({ kind: 'fld', type: 'slidenum', cached: pad(ctx.page, arg), frozenPad: parseInt(arg ?? '', 10) > 0 })
        break
      case 'date':
        pieces.push({ kind: 'fld', type: 'datetime', cached: ctx.date.toLocaleDateString(), frozenPad: false })
        break
      case 'pages': pieces.push({ kind: 'text', text: pad(ctx.pages, arg) }); onFrozen('pages'); break
      case 'title': pieces.push({ kind: 'text', text: ctx.title }); onFrozen('title'); break
      case 'time':
        pieces.push({ kind: 'text', text: ctx.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
        onFrozen('time')
        break
      case 'author': pieces.push({ kind: 'text', text: ctx.author }); onFrozen('author'); break
      case 'company': pieces.push({ kind: 'text', text: ctx.company }); onFrozen('company'); break
      case 'subject': pieces.push({ kind: 'text', text: ctx.subject }); onFrozen('subject'); break
      case 'event': pieces.push({ kind: 'text', text: ctx.event }); onFrozen('event'); break
    }
  }
  if (pos < text.length) pieces.push({ kind: 'text', text: text.slice(pos) })
  return pieces
}

// --- the shape ----------------------------------------------------------------

const pxEmu = (px: number): number => Math.round(px * EMU_PER_PX)

const ANCHOR: Record<TextElIn['valign'], string> = { top: 't', middle: 'ctr', bottom: 'b' }
const ALGN: Record<TextElIn['align'], string> = { left: 'l', center: 'ctr', right: 'r' }

/** First family of a css stack, quotes stripped — #88's firstFont. */
const firstFont = (stack: string): string =>
  (stack.split(',')[0] ?? 'Arial').trim().replace(/^['"]|['"]$/g, '') || 'Arial'

const stripTags = (html: string): string => html.replace(/<[^>]*>/g, '')

/**
 * One bento text element as a finished p:sp. Returns null for an UNFILLED
 * placeholder (#88's skip: present mode hides those, so exporting the prompt
 * text would show scaffolding the author never sees).
 *
 * Emits its own a:xfrm — the shapes module has the same needs and the
 * integrator dedups the helper when both are in the tree.
 */
export function textSp(el: TextElIn, opts: TextSpOpts): XNode | null {
  if (el.placeholder && !stripTags(el.html).trim()) return null

  const report = opts.report
  const where = opts.where ?? ''
  // #88's report codes, carried over: these visual features have no OOXML
  // text-run equivalent and flatten to the base colour / plain glyphs.
  if (el.colorGradient) report?.add('approximated', 'text-gradient-flattened', where, 'text gradient fill flattened to the solid colour')
  if (el.shadow || el.blur || el.blend || el.backdropFilter) {
    report?.add('approximated', 'text-effects-simplified', where, 'shadow/blur/blend effects on text dropped')
  }

  const face = firstFont(el.fontFamily || opts.themeFontFamily)
  const ink = cssColor(el.color)
  // element opacity composes into every run's alpha — a text sp has no fill
  // of its own to carry it (#88 routed this through combineTransparency)
  const alpha = ink.alpha * clamp(el.opacity, 0, 1)
  const hollow = el.textStroke?.fill === 'none'

  // Character properties shared by every run: OOXML has no element-level run
  // style on a plain text box (lstStyle defaults do not survive user edits
  // well), so the element's typography rides on each a:rPr and per-run
  // overrides merge in. fontWeight ≥ 600 → bold is #88's threshold.
  const runRPr = (style: RunStyle): XNode => {
    // px*75 = px→pt→centipoints; clamped to ST_TextFontSize's legal range
    // (100..400000 = 1pt..4000pt) — a sub-1.34px fontSize would otherwise
    // emit a schema-invalid sz and risk a repair dialog.
    const attrs: Record<string, string | number> = { sz: clamp(Math.round(el.fontSize * 75), 100, 400000) }
    if (el.fontWeight >= 600 || style.bold) attrs.b = 1
    if (style.italic) attrs.i = 1
    if (style.underline) attrs.u = 'sng'
    // first-party win over #88: PptxGenJS had no strike-through API, raw
    // OOXML has an attribute
    if (style.strike) attrs.strike = 'sngStrike'
    // spc is centipoints (3px tracking → 2.25pt → 225). #88 capped this at
    // 0.1pt working around a PptxGenJS/LibreOffice interaction; the raw
    // attribute renders correctly in PowerPoint, so the real value goes out.
    if (el.letterSpacing) attrs.spc = Math.round(el.letterSpacing * 75)
    const kids: XChild[] = []
    // schema order within CT_TextCharacterProperties: ln, fill, latin, hlink
    if (el.textStroke?.width) {
      const sc = cssColor(el.textStroke.color)
      kids.push(x('a:ln', { w: pxEmu(el.textStroke.width) }, [solidFill(sc.hex, sc.alpha)]))
    }
    // hollow glyphs (textStroke fill:'none'): outline above + noFill interior —
    // expressible in raw OOXML, another thing PptxGenJS could not say
    kids.push(hollow ? x('a:noFill') : solidFill(ink.hex, alpha))
    kids.push(x('a:latin', { typeface: style.code ? 'Courier New' : face }))
    if (opts.link) {
      // per-RUN hyperlinks, #88's hard-won fix: shape-level links on rich
      // text produced dangling rel ids; rPr-level is also where PowerPoint
      // itself puts them
      kids.push(x('a:hlinkClick', {
        'r:id': opts.link.rId,
        ...(opts.link.slideJump ? { action: 'ppaction://hlinksldjump' } : {}),
      }))
    }
    return x('a:rPr', attrs, kids)
  }

  // runs → a:r / a:fld / a:br
  let frozenTokens = 0
  let padLost = false
  let fldSeq = 0
  const paraKids: XChild[] = []
  for (const run of parseInlineHtml(el.html)) {
    if (run.text) {
      for (const piece of splitFields(run.text, opts.fields, () => { frozenTokens++ })) {
        if (piece.kind === 'text') {
          if (piece.text) paraKids.push(x('a:r', undefined, [runRPr(run.style), x('a:t', undefined, [piece.text])]))
        } else {
          if (piece.frozenPad) padLost = true
          // the id must be GUID-shaped; deterministic from shapeId + ordinal
          // so identical input bytes give identical output (diffable exports)
          const guid = `{BE27B040-0000-4000-8000-${(opts.shapeId * 4096 + fldSeq++).toString(16).toUpperCase().padStart(12, '0')}}`
          paraKids.push(x('a:fld', { id: guid, type: piece.type }, [runRPr(run.style), x('a:t', undefined, [piece.cached])]))
        }
      }
    }
    if (run.breakAfter) paraKids.push(x('a:br', undefined, [runRPr(run.style)]))
  }
  if (frozenTokens) report?.add('approximated', 'text-field-frozen', where, 'dynamic field resolved to literal text (PowerPoint will not re-compute it)')
  if (padLost) report?.add('approximated', 'text-field-pad-lost', where, 'zero-padded {{page:N}} exported as a live slide-number field; the pad is lost when PowerPoint re-renders it')

  const pPr = x('a:pPr', { algn: ALGN[el.align] },
    el.lineHeight > 0 && Number.isFinite(el.lineHeight)
      ? [x('a:lnSpc', undefined, [x('a:spcPct', { val: Math.round(el.lineHeight * 100000) })])]
      : undefined)

  const rot = ((el.rotation % 360) + 360) % 360

  return x('p:sp', undefined, [
    x('p:nvSpPr', undefined, [
      // `bento:<morph key>` object name (#88): survives a round-trip through
      // PowerPoint's selection pane, so re-import can restore morph pairing
      x('p:cNvPr', { id: opts.shapeId, name: `bento:${el.morphId || el.id}` }),
      x('p:cNvSpPr', { txBox: 1 }),
      x('p:nvPr'),
    ]),
    x('p:spPr', undefined, [
      x('a:xfrm', rot ? { rot: Math.round(rot * 60000) } : undefined, [
        x('a:off', { x: pxEmu(el.x), y: pxEmu(el.y) }),
        x('a:ext', { cx: pxEmu(el.w), cy: pxEmu(el.h) }),
      ]),
      x('a:prstGeom', { prst: 'rect' }, [x('a:avLst')]),
      x('a:noFill'),
    ]),
    x('p:txBody', undefined, [
      // zero insets + shrink-to-fit, both #88's: bento paints text flush to
      // its box and the box is authored FIXED — normAutofit keeps overflow
      // inside it instead of spilling over neighbouring shapes
      x('a:bodyPr', { wrap: 'square', lIns: 0, tIns: 0, rIns: 0, bIns: 0, anchor: ANCHOR[el.valign] }, [
        x('a:normAutofit'),
      ]),
      x('a:lstStyle'),
      // a txBody must contain at least one a:p; an empty element still
      // exports as an (empty) editable box
      x('a:p', undefined, [pPr, ...paraKids]),
    ]),
  ])
}
