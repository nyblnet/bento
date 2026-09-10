// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The `ink` block: freehand drawing — a sketch, a diagram, a circled thing.
//
// ————— THE SHAPE, AND WHY IT IS THIS ONE ——————————————————————————————————
//
// Three shapes were open: an `ink` block of its own, a drawing LAYER on the
// existing `canvas`, or an annotation layer over an `image`. This is the first,
// and the other two are not half-built anywhere in this file.
//
// NOT A LAYER ON `canvas`. A canvas is cards you place by hand; its whole
// payload is the blocks whose `parent` is its id. Ink on it would be a SECOND,
// differently-shaped payload on one block — an array beside a container — and
// every canvas ever written would carry the drawing code to render nothing.
// Worse, it would make "draw" mean "first make a canvas", when the thing people
// actually want is a sketch in the middle of a page of notes. (Ink INSIDE a
// canvas is free anyway and always was: a card is a block, and an `ink` block
// with a `parent` is a card. Nothing here forbids it.)
//
// NOT A LAYER ON `image`. That is the annotation case, and it is the tempting
// one — but as a layer it says you cannot draw without first having a
// photograph, which is backwards. The annotation case is this block plus ONE
// additive field (below), not a second home for strokes.
//
// ————— WHICH PARTS OF THE canvas.ts ARGUMENT TRANSFER ————————————————————
//
// canvas.ts argues at length that a CARD is a BLOCK rather than an entry in an
// array on the canvas, for three reasons. A stroke is not a card, so the three
// have to be re-derived rather than inherited. Two of them invert.
//
//   1. "IT WOULD BE A SECOND PLACE TEXT LIVES." DOES NOT TRANSFER. That
//      argument is about words: a card's text has to be one block's `html` so
//      that ⌘F finds it, `buildIndex` backlinks it, one sanitizer canonicalises
//      it and one markdown pass exports it. A STROKE HAS NO WORDS. There is
//      nothing for ⌘F to match, nothing for buildIndex to read, nothing for
//      the sanitizer to canonicalise and nothing markdown can say about it.
//      The block's `html` still carries the drawing's NAME, and that name is
//      searchable, backlinkable and exportable exactly like a canvas's — which
//      is the whole of what text this block has.
//
//   2. "IT WOULD DEGRADE BADLY." TRANSFERS, AND POINTS THE OTHER WAY. A card
//      as a block degrades beautifully: on a build that has never heard of
//      `canvas` the cards fall out to the top level and read as paragraphs.
//      A STROKE AS A BLOCK WOULD DEGRADE INTO GARBAGE — a forty-stroke sketch
//      would fall out as forty EMPTY paragraphs under the drawing's title, and
//      an empty paragraph is not a degraded stroke, it is litter that the
//      author now has to delete forty times. One `ink` block with the strokes
//      in a field degrades to its name and nothing else, and the strokes ride
//      along untouched (PLATFORM §3). That is the sane fallback, and it is why
//      the shape that is right for a card is wrong for a stroke.
//
//   3. "IT WOULD LOSE EDITS UNDER COLLABORATION." TRANSFERS, AND IS ACCEPTED.
//      `strokes` is ONE array, so it is ONE last-writer-wins register: two
//      people drawing on the SAME ink block at the same moment keep one of the
//      two sets of strokes, silently. `table.rows` has the identical
//      limitation and documents it; this one is documented here rather than
//      pretended away. The fix — a node per stroke — is exactly the shape
//      reason 2 rejects, and it would multiply a 9-byte stroke by the ~45
//      bytes of id/type/parent a block costs. Two people drawing on two
//      DIFFERENT ink blocks converge normally, which is the common case.
//
// ————— COORDINATES ————————————————————————————————————————————————————————
//
// PERCENTAGES, for canvas.ts's reason: the same file is read at 320px and at
// 2560px and printed on A4, and a drawing stored in pixels is a drawing that is
// right at one width.
//
// BUT BOTH AXES ARE A PERCENTAGE OF THE SURFACE'S **WIDTH**, where a canvas
// card's `y` is a percentage of its HEIGHT. That divergence is not an
// oversight and it is not stylistic. A card is placed; a stroke is a SHAPE.
// Percent-of-width across and percent-of-height down is a non-uniform unit
// system, so on a 1.6-wide surface a hand-drawn circle would be stored as an
// ellipse and would re-shear the moment the surface's `ratio` changed. One
// unit for both axes means the svg needs no `preserveAspectRatio="none"`, a
// circle stays a circle, and `stroke-width` — which is in the same units — is
// resolution-independent for free.
//
// So `y` runs 0..100/ratio, and the viewBox is `0 0 100 <100/ratio>`. Changing
// the shape REFRAMES and never rescales, which is slides' page-size rule.
//
// ————— STORAGE ————————————————————————————————————————————————————————————
//
// A pointer emits samples at 120Hz+ and this document gets emailed, so raw
// samples are not a format, they are a leak. Three things are done about it,
// in the order they pay:
//
//   1. RAMER–DOUGLAS–PEUCKER, at `INK_EPSILON` (percent of width). A stroke is
//      reduced to the points that carry its shape. Measured on realistic
//      drawing this removes 80–95% of the samples.
//   2. QUANTISATION to `INK_DP` decimal places, i.e. a 0.01%-of-width grid.
//      On a 900px-wide surface that is 0.09px — finer than any pen nib.
//   3. RELATIVE DELTAS. Post-RDP a stroke's steps are small numbers, so `l`
//      commands cost 3–5 characters where an absolute `L` costs 5–7.
//
// The result is a plain SVG path `d` string: `M12.3 45.6l1.2 .4 2 1.1`. A
// packed binary would be perhaps 20% smaller and would not be a thing anyone
// could read, hand-edit, or hand a renderer. This format's other fields are all
// legible; this one is too.
//
// PRESSURE IS PER STROKE, NOT PER POINT, and that is a size decision made in
// the open. A third coordinate on every point costs more than RDP saves, and
// SVG cannot vary `stroke-width` along a path anyway — honouring per-point
// pressure means emitting a filled outline polygon, which is several times the
// bytes of the centre line it replaces. So a stroke's width is its nominal
// width modulated by the MEAN pressure of the samples that made it, and only
// for `pointerType === 'pen'`: a stylus pressed hard draws a fatter stroke than
// one brushed lightly, a finger and a mouse draw the nominal width. Per-point
// pressure, if it is ever worth its bytes, is an additive `p` array on the
// stroke. It is not built.
//
// ————— WHAT IS DELIBERATELY NOT HERE ——————————————————————————————————————
//
//   · A BACKDROP. `ink.src` — the same three forms an image block's `src`
//     takes — drawn behind the strokes, is the whole of the annotate-a-
//     photograph case, and it is one additive field plus the existing remote-
//     consent gate. It is named here so a follow-up does not invent a second
//     spelling; it is not implemented.
//   · A PIXEL ERASER. The eraser here removes whole STROKES, which is what a
//     vector eraser is and is also the only kind that cannot grow the file:
//     splitting a stroke in half writes two strokes where there was one, so an
//     afternoon of erasing makes the document bigger.
//   · SHAPES, TEXT, FILL, LAYERS. All additive; none built.
//
// ————— TRUST ——————————————————————————————————————————————————————————————
//
// Strokes arrive in a file somebody mailed you. NOTHING in this file builds
// markup from them: paths are created with `createElementNS` and their
// geometry is written with `setAttribute`, so there is no string of document
// data that a parser ever sees as HTML. And the `d` a file carries never
// reaches the DOM verbatim either — it is PARSED into points and RE-EMITTED by
// this file's own writer, so the attribute the browser is handed is one this
// code wrote. A stroke that does not parse is DROPPED, never thrown on; the
// `tableOf` rule, clamped at read time and never repaired in the document.

import type { Block } from './model.ts'
import { sanitizeInline } from './sanitize.ts'
import { t } from './i18n.ts'
import { canvasRatio, RATIOS, ratioName, nextRatio, CANVAS_RATIO } from './canvas.ts'

/**
 * The surface's shape, width ÷ height.
 *
 * The SAME `ratio` field a canvas carries, with the same meaning and the same
 * clamp — one field, one meaning, one reader. An ink block and a canvas block
 * are both bounded surfaces on a page, and giving them two field names for one
 * fact is how a format acquires `ratio` and `aspect` and a bug in whichever
 * one a future build forgets.
 */
export const inkRatio = canvasRatio
export { RATIOS, ratioName, nextRatio, CANVAS_RATIO }

/** RDP tolerance, in percent of the surface width. */
export const INK_EPSILON = 0.15

/** Decimal places kept. 2 = a 0.01%-of-width grid. */
export const INK_DP = 2

/** Nominal pen widths, in percent of the surface width — the four the toolbar
 *  offers, and the middle one is the default. Percent, so a stroke drawn on a
 *  phone is the same weight when the file is opened on a desktop. */
export const INK_WIDTHS = [0.18, 0.36, 0.75, 1.5]
export const INK_WIDTH = INK_WIDTHS[1]

/** What a `w` in a file may say. A width of 0 is an invisible stroke and a
 *  width of 400 is a filled block; both are clamped at read time. */
export const INK_W_MIN = 0.02
export const INK_W_MAX = 8

/**
 * The pen colours.
 *
 * `null` is the FIRST and the default, and it means "the document's ink" —
 * stored as an absent `c`, rendered as `currentColor`. So a drawing made with
 * the default pen is legible in a dark theme, on paper, and in the file
 * manager's still, none of which is true of a hardcoded `#000`.
 */
export const INK_COLORS: Array<string | null> = [
  null, '#E5484D', '#F76B15', '#F5C518', '#30A46C', '#0090FF', '#8E4EC6', '#FFFFFF',
]

/** A colour a file may carry. An ALLOWLIST on the raw string, sanitize.ts's
 *  rule: anything else is not repaired, it is ignored in favour of the
 *  default. A `c` out of a mailed file lands in an svg presentation
 *  attribute, and `url(#…)` in one is a reference this app will not resolve. */
const COLOR_OK = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/**
 * Ceilings, so a malformed or hostile file cannot hang the renderer.
 *
 * Not a validation error and not a repair: strokes past the cap are simply not
 * drawn, and the field round-trips whole. A hand-written document with a
 * million points is a document this build declines to paint all of, which is
 * strictly better than a tab that stops responding.
 */
export const INK_MAX_STROKES = 4000
export const INK_MAX_POINTS = 20000
const MAX_D = 1_000_000

export interface Pt { x: number; y: number }

/** One stroke, validated and ready to draw. `color: null` = the document's ink. */
export interface InkStroke {
  pts: Pt[]
  color: string | null
  width: number
}

/** One stroke as it is STORED. `c` and `w` absent = the defaults. */
export interface StrokeRecord {
  d: string
  c?: string
  w?: number
}

// ————— PATH CODEC ————————————————————————————————————————————————————————

/** Sticky, so a long `d` is scanned once rather than re-sliced per number. */
const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)/y
const SEP = /[\s,]/

/**
 * A stored `d` → its points, or null if it is not one this build will draw.
 *
 * A DELIBERATELY TINY GRAMMAR: `M`/`m` and `L`/`l` with implicit repetition,
 * numbers, and separators. Curves, arcs and `Z` are not in it — this writer
 * never emits them, and accepting syntax nothing produces is accepting a
 * parser bug nobody would notice. A future stroke shape that needs curves adds
 * them to the writer and to this grammar together.
 *
 * NEVER THROWS. Malformed input is `null`, which the caller drops.
 */
export function parsePath(d: unknown): Pt[] | null {
  if (typeof d !== 'string' || d.length === 0 || d.length > MAX_D) return null
  const pts: Pt[] = []
  let i = 0
  let cmd = ''
  let cx = 0
  let cy = 0
  const skip = (): void => { while (i < d.length && SEP.test(d[i])) i++ }
  const num = (): number | null => {
    NUM.lastIndex = i
    const m = NUM.exec(d)
    if (!m) return null
    i = NUM.lastIndex
    const v = Number(m[0])
    return Number.isFinite(v) ? v : null
  }
  skip()
  while (i < d.length) {
    const ch = d[i]
    if (ch === 'M' || ch === 'm' || ch === 'L' || ch === 'l') { cmd = ch; i++; skip() }
    else if (cmd === '') return null
    const ax = num()
    if (ax === null) return null
    skip()
    const ay = num()
    if (ay === null) return null
    // The FIRST pair is absolute whichever letter introduced it: a path that
    // opens `l` has no current point to be relative to, and treating one as
    // relative-to-origin is the same number by a longer road.
    if (pts.length === 0) { cx = ax; cy = ay }
    else if (cmd === 'm' || cmd === 'l') { cx += ax; cy += ay }
    else { cx = ax; cy = ay }
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null
    pts.push({ x: cx, y: cy })
    if (pts.length > INK_MAX_POINTS) return null
    // SVG's own rule: the pairs after a moveto are implicit linetos.
    if (cmd === 'M') cmd = 'L'
    else if (cmd === 'm') cmd = 'l'
    skip()
  }
  return pts.length ? pts : null
}

/** `0.30` → `.3`, `1.00` → `1`, `-0.50` → `-.5`. Every character of this is
 *  paid once per point in a file people mail to each other. */
function trimNum(s: string): string {
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s.replace(/^(-?)0\./, '$1.')
}

const pow = (dp: number): number => Math.pow(10, dp)

/**
 * Points → a `d` this file can parse back byte-for-byte.
 *
 * The deltas are computed against the RECONSTRUCTED running position — what a
 * decoder will have — rather than against the ideal one, so quantisation error
 * cannot accumulate along a stroke and the codec round-trips exactly.
 * Zero-length steps are dropped: after quantisation a 120Hz sampler produces
 * plenty of them and each one is pure cost.
 */
export function emitPath(pts: Pt[], dp = INK_DP): string {
  if (!pts.length) return ''
  const p = pow(dp)
  const q = (n: number): number => Math.round(n * p) / p
  const f = (n: number): string => trimNum(n.toFixed(dp))
  let rx = q(pts[0].x)
  let ry = q(pts[0].y)
  let out = `M${f(rx)} ${f(ry)}`
  const steps: string[] = []
  for (let i = 1; i < pts.length; i++) {
    const dx = q(q(pts[i].x) - rx)
    const dy = q(q(pts[i].y) - ry)
    if (dx === 0 && dy === 0) continue
    rx = q(rx + dx)
    ry = q(ry + dy)
    steps.push(`${f(dx)} ${f(dy)}`)
  }
  if (!steps.length) return out
  // `l` once, then implicit repetition — the pairs after a lineto are more
  // linetos, so the letter is paid once per stroke rather than once per point.
  out += 'l' + steps.join(' ')
  return out
}

// ————— SIMPLIFICATION ————————————————————————————————————————————————————

/** Squared distance from `p` to the segment `a`–`b`. Squared, so the inner
 *  loop of RDP has no square root in it. */
function segDist2(p: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const len2 = vx * vx + vy * vy
  let tx = a.x
  let ty = a.y
  if (len2 > 0) {
    const tt = Math.min(1, Math.max(0, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2))
    tx = a.x + tt * vx
    ty = a.y + tt * vy
  }
  const dx = p.x - tx
  const dy = p.y - ty
  return dx * dx + dy * dy
}

/**
 * Ramer–Douglas–Peucker, iteratively.
 *
 * ITERATIVE, not recursive, on purpose: the recursion depth of RDP is the
 * length of the run it cannot simplify, and a slow deliberate stroke on a
 * 120Hz pen is thousands of samples of exactly that. A stack overflow inside a
 * pointerup handler would lose the stroke the author just drew.
 *
 * The tolerance is in the stored unit (percent of surface width), so it means
 * the same thing on every screen the file is opened on — which is the point of
 * storing percentages in the first place.
 */
export function simplify(pts: Pt[], eps = INK_EPSILON): Pt[] {
  if (pts.length <= 2) return pts.slice()
  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1
  const eps2 = eps * eps
  const stack: Array<[number, number]> = [[0, pts.length - 1]]
  while (stack.length) {
    const [lo, hi] = stack.pop()!
    let worst = 0
    let at = -1
    for (let i = lo + 1; i < hi; i++) {
      const d2 = segDist2(pts[i], pts[lo], pts[hi])
      if (d2 > worst) { worst = d2; at = i }
    }
    if (at >= 0 && worst > eps2) {
      keep[at] = 1
      stack.push([lo, at], [at, hi])
    }
  }
  const out: Pt[] = []
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i])
  return out
}

// ————— READING A BLOCK ——————————————————————————————————————————————————

/** A file's `w` → a width this build will draw. Absent, unreadable or out of
 *  range is the DEFAULT, never an error and never a rewrite of the document. */
function widthOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return INK_WIDTH
  return Math.min(INK_W_MAX, Math.max(INK_W_MIN, v))
}

/** A file's `c` → a colour, or null for the document's own ink. */
function colorOf(v: unknown): string | null {
  return typeof v === 'string' && COLOR_OK.test(v.trim()) ? v.trim() : null
}

/**
 * The strokes of one ink block, validated.
 *
 * `Object.hasOwn`, not `in` and not truthiness: `strokes` arrives from parsed
 * JSON, and a document whose author wrote `{"d": "…"}` under a key called
 * `constructor` must not be answered by `Object.prototype`. That bug has
 * shipped in this app twice.
 */
export function strokesOf(b: Block): InkStroke[] {
  const raw = Object.hasOwn(b, 'strokes') ? (b as { strokes?: unknown }).strokes : undefined
  if (!Array.isArray(raw)) return []
  const out: InkStroke[] = []
  for (const s of raw) {
    if (out.length >= INK_MAX_STROKES) break
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue
    const rec = s as Record<string, unknown>
    const pts = parsePath(Object.hasOwn(rec, 'd') ? rec.d : undefined)
    if (!pts) continue
    out.push({
      pts,
      color: colorOf(Object.hasOwn(rec, 'c') ? rec.c : undefined),
      width: widthOf(Object.hasOwn(rec, 'w') ? rec.w : undefined),
    })
  }
  return out
}

/**
 * Points → the record that goes in the file.
 *
 * The DEFAULTS ARE ABSENT KEYS — the `editView` discipline: a stroke drawn
 * with the default pen must be byte-identical to one written by a build that
 * had no colour picker, and a drawing that never leaves the defaults must not
 * carry a `c` and a `w` on every stroke it has.
 */
export function strokeRecord(pts: Pt[], color: string | null, width: number): StrokeRecord | null {
  const d = emitPath(simplify(pts))
  if (!d) return null
  const rec: StrokeRecord = { d }
  if (color !== null && COLOR_OK.test(color)) rec.c = color
  const w = Math.min(INK_W_MAX, Math.max(INK_W_MIN, Math.round(width * 1000) / 1000))
  if (w !== INK_WIDTH) rec.w = w
  return rec
}

/**
 * The pen width one stroke was drawn at.
 *
 * PRESSURE ONLY FROM A PEN. `PointerEvent.pressure` is 0.5 for a mouse button
 * that is down and 0 for one that is not, and touch digitizers that report no
 * force report 0.5 as well — so reading it from anything but a stylus would
 * make every mouse stroke a "medium pressure" one, which is a modulation of
 * nothing that a reader would nonetheless see as deliberate.
 */
export function pressureWidth(base: number, pointerType: string, pressures: number[]): number {
  if (pointerType !== 'pen' || !pressures.length) return base
  let sum = 0
  let n = 0
  for (const p of pressures) {
    if (typeof p === 'number' && Number.isFinite(p) && p > 0) { sum += p; n++ }
  }
  if (!n) return base
  const mean = Math.min(1, sum / n)
  // 0.55×..1.35× — a firm stroke is visibly fatter than a light one and
  // neither disappears nor blots.
  return base * (0.55 + 0.8 * mean)
}

/** The nearest stored stroke to a point, within `r`, or -1. The eraser's whole
 *  hit test: strokes are polylines, so this is a segment distance and no more. */
export function strokeAt(strokes: InkStroke[], p: Pt, r: number): number {
  // TOP DOWN: strokes are painted in array order, so the one a reader sees
  // under the eraser is the LAST one that covers the point.
  for (let s = strokes.length - 1; s >= 0; s--) {
    const pts = strokes[s].pts
    // half the stroke's own width counts as part of it, so a fat line is as
    // easy to hit as it looks
    const reach = r + strokes[s].width / 2
    const lim = reach * reach
    if (pts.length === 1) {
      if (segDist2(p, pts[0], pts[0]) < lim) return s
      continue
    }
    for (let i = 1; i < pts.length; i++) {
      if (segDist2(p, pts[i - 1], pts[i]) < lim) return s
    }
  }
  return -1
}

// ————— RENDERING ————————————————————————————————————————————————————————

const SVGNS = 'http://www.w3.org/2000/svg'

/**
 * Build the drawing surface for one ink block.
 *
 * INLINE SVG, not `<canvas>`, and the reasons are all about the surfaces this
 * app has to be right on rather than about drawing:
 *
 *   · PRINT. A `<canvas>` is a bitmap at whatever pixel size it happened to be
 *     laid out at; on paper that is a blurred sketch. An svg path is
 *     resolution-independent and prints at the printer's resolution.
 *   · THE STILL RENDER. preview.ts bans `canvas` outright (a still runs no
 *     script, so a canvas element in one is a blank rectangle) and strips
 *     `src`. An svg is neither banned nor stripped, so a drawing appears in
 *     the file-manager thumbnail with no change to preview.ts at all.
 *   · NO SCRIPT. The reading view of a saved space is DOM. Strokes that need
 *     JS to appear are strokes that vanish exactly where this format promises
 *     they will not.
 *
 * The svg carries its sizing as an INLINE STYLE rather than a class, for the
 * still: the runtime stylesheet ships deflated, so in a thumbnailer no `.sp-*`
 * rule exists and a classed svg would collapse to nothing.
 */
export function renderInkSurface(b: Block, editable: boolean): SVGSVGElement {
  const ratio = inkRatio(b)
  const h = Math.round((100 / ratio) * 100) / 100
  const svg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement
  svg.setAttribute('viewBox', `0 0 100 ${h}`)
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  svg.setAttribute('style', 'width:100%;height:auto;display:block;overflow:hidden')
  svg.setAttribute('class', 'sp-ink-surface')
  svg.setAttribute('role', 'img')
  const name = typeof b.html === 'string' ? b.html.replace(/<[^>]*>/g, '').trim() : ''
  svg.setAttribute('aria-label', name || t('Drawing'))
  if (editable) svg.dataset.ink = b.id

  const g = document.createElementNS(SVGNS, 'g')
  g.setAttribute('fill', 'none')
  g.setAttribute('stroke-linecap', 'round')
  g.setAttribute('stroke-linejoin', 'round')
  for (const s of strokesOf(b)) g.appendChild(strokePath(s))
  svg.appendChild(g)
  return svg
}

/** One `<path>`. Built element-first, never from a string of markup, and its
 *  `d` is RE-EMITTED from the parsed points rather than passed through. */
export function strokePath(s: InkStroke): SVGPathElement {
  const path = document.createElementNS(SVGNS, 'path') as SVGPathElement
  path.setAttribute('d', emitPath(s.pts))
  path.setAttribute('stroke', s.color ?? 'currentColor')
  path.setAttribute('stroke-width', String(s.width))
  return path
}

/**
 * The block's chrome: its name, and — only where there is an editor — the pen.
 *
 * The name is the same idiom a canvas's is, and for the same reason: it is
 * what an older build renders in place of the whole drawing, so it must not
 * try to duplicate the content, only to say what the content was.
 */
export function renderInkHead(el: HTMLElement, b: Block, editable: boolean): void {
  const head = document.createElement('div')
  head.className = 'sp-ink-head'

  const title = document.createElement(editable ? 'div' : 'span')
  title.className = 'sp-ink-title'
  title.dir = 'auto'
  if (editable) {
    title.contentEditable = 'true'
    title.dataset.inkTitle = b.id
    title.dataset.ph = t('Name this drawing')
  }
  // The SAME sanitizer every other word in a space goes through — the name is
  // a block's `html`, so it is bold-able, searchable and exportable exactly
  // like a canvas's, and it is canonicalised by the one allowlist.
  title.innerHTML = sanitizeInline(typeof b.html === 'string' ? b.html : '')
  head.appendChild(title)
  el.appendChild(head)
}

// ————— EDITING ——————————————————————————————————————————————————————————

/**
 * The pen, as the PERSON holding it has it set — never the document.
 *
 * Which tool is armed, what colour it is and how thick: all three are facts
 * about the reader's session, exactly like the locale, the pane width and
 * slides' reduced-motion preference. Putting them in the file would mean the
 * author decides which tool the next person opening the document is holding.
 * Colour and width persist in localStorage so a drawing session survives a
 * reload; the armed tool does not, because a space that opens with the eraser
 * live is a space that erases on the first tap.
 */
export type InkTool = 'pen' | 'eraser' | null

const PREF_COLOR = 'bento-sp-ink-color'
const PREF_WIDTH = 'bento-sp-ink-width'

export const pen: { tool: InkTool; on: string | null; color: string | null; width: number } = {
  tool: null,
  /**
   * WHICH ink block the tool is armed on.
   *
   * This exists because every finished stroke COMMITS and repaints, which
   * rebuilds the page's DOM and re-runs `wireInk` — so the armed state cannot
   * live on the element. Measured in a real browser: without this, the first
   * stroke landed and the pen then silently put itself down, so the second
   * stroke scrolled the page instead of drawing.
   *
   * A block ID rather than a bare boolean, so a page with two drawings on it
   * arms the one you picked up the pen on and not both.
   */
  on: null,
  color: null,
  width: INK_WIDTH,
}

/** Read the stored pen. Wrapped, because a locked-down origin throws on the
 *  first property access and a drawing tool is not worth a broken boot. */
export function loadPen(): void {
  try {
    const c = localStorage.getItem(PREF_COLOR)
    pen.color = c && COLOR_OK.test(c) ? c : null
    const w = Number(localStorage.getItem(PREF_WIDTH))
    pen.width = Number.isFinite(w) && w > 0 ? Math.min(INK_W_MAX, Math.max(INK_W_MIN, w)) : INK_WIDTH
  } catch { /* no storage */ }
}

function savePen(): void {
  try {
    if (pen.color) localStorage.setItem(PREF_COLOR, pen.color)
    else localStorage.removeItem(PREF_COLOR)
    localStorage.setItem(PREF_WIDTH, String(pen.width))
  } catch { /* no storage */ }
}

/** What ink.ts needs from the editor — the `CanvasHooks` discipline: a narrow
 *  surface, because render.ts imports this file and the renderer has no
 *  business knowing about undo. */
export interface InkHooks {
  block(id: string): Block | undefined
  commit(fn: () => void, opts?: { structure?: boolean }): void
  repaint(): void
}

/** The stored array, created on demand. Absent until the first stroke, so an
 *  ink block someone inserted and never drew on costs no `"strokes":[]`. */
function strokeArray(b: Block): unknown[] {
  const cur = Object.hasOwn(b, 'strokes') ? (b as { strokes?: unknown }).strokes : undefined
  if (Array.isArray(cur)) return cur
  const fresh: unknown[] = []
  ;(b as { strokes?: unknown }).strokes = fresh
  return fresh
}

export function wireInk(root: HTMLElement, hooks: InkHooks): void {
  for (const host of root.querySelectorAll<HTMLElement>('.sp-b-ink')) {
    const id = host.dataset.blockId
    if (!id) continue
    wireOne(host, id, hooks)
  }
}

function wireOne(host: HTMLElement, id: string, hooks: InkHooks): void {
  const svg = host.querySelector<SVGSVGElement>('svg.sp-ink-surface')
  const bar = host.querySelector<HTMLElement>('.sp-ink-tools')
  if (!svg) return

  // A NAME IS ONE LINE, and it commits when it is done with — canvas.ts's two
  // rules for the same control, arrived at for the same reasons.
  const title = host.querySelector<HTMLElement>('[data-ink-title]')
  title?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    title.blur()
  })
  title?.addEventListener('blur', () => {
    const b = hooks.block(id)
    const next = sanitizeInline(title.innerHTML)
    if (!b || next === (typeof b.html === 'string' ? b.html : '')) return
    hooks.commit(() => { b.html = next }, { structure: false })
  })

  /**
   * TOUCH-ACTION IS THE ARMED STATE, and it is the whole answer to "a finger
   * drawing must not fight page scroll".
   *
   * `touch-action: none` on a surface tells the browser to send this element's
   * touches to script instead of scrolling the page — which is exactly right
   * while a tool is armed and exactly wrong the rest of the time. A drawing
   * that permanently claimed its own touches would be a hole in the middle of
   * every page where a swipe does nothing, on the one device where a swipe is
   * the only way to move. So it is set when a tool is picked and cleared when
   * it is put down, and in the READING VIEW (no toolbar, nothing to arm) it is
   * never set at all.
   */
  /**
   * PAINT ONLY — this block's look, with no opinion about the global pen.
   *
   * The split from `arm` below is not tidiness. `wireInk` runs over EVERY ink
   * block on the page after every repaint, so a page with two drawings on it
   * re-applies this twice; when the two were one function, wiring the drawing
   * you were NOT holding the pen on called `arm(null)` and cleared
   * `pen.tool` — so the tool silently put itself down and the very next stroke
   * did nothing at all. Measured in a real browser, where it showed up as
   * "every second stroke is lost".
   */
  const paintArmed = (tool: InkTool): void => {
    svg.style.touchAction = tool ? 'none' : ''
    svg.style.cursor = tool ? 'crosshair' : ''
    host.classList.toggle('sp-ink-armed', tool !== null)
    if (bar) for (const el of bar.querySelectorAll<HTMLElement>('[data-ink-tool]')) {
      el.setAttribute('aria-pressed', String(el.dataset.inkTool === tool))
    }
  }
  /** Pick a tool up or put it down. The only writer of the global pen state. */
  const arm = (tool: InkTool): void => {
    pen.tool = tool
    pen.on = tool ? id : null
    paintArmed(tool)
  }
  // RE-ARM ACROSS THE REPAINT, rather than starting disarmed. `wireInk` runs
  // again after every committed stroke, and a pen that puts itself down after
  // one line is a pen nobody can draw with.
  paintArmed(pen.on === id ? pen.tool : null)

  if (bar) {
    for (const el of bar.querySelectorAll<HTMLElement>('[data-ink-tool]')) {
      el.addEventListener('click', () => {
        const want = el.dataset.inkTool === 'eraser' ? 'eraser' : 'pen'
        arm(pen.tool === want ? null : want)
      })
    }
    for (const el of bar.querySelectorAll<HTMLElement>('[data-ink-color]')) {
      el.addEventListener('click', () => {
        const v = el.dataset.inkColor ?? ''
        pen.color = COLOR_OK.test(v) ? v : null
        savePen()
        paintBar(bar)
        if (pen.tool !== 'pen') arm('pen')
      })
    }
    for (const el of bar.querySelectorAll<HTMLElement>('[data-ink-width]')) {
      el.addEventListener('click', () => {
        const v = Number(el.dataset.inkWidth)
        if (Number.isFinite(v) && v > 0) pen.width = v
        savePen()
        paintBar(bar)
        if (pen.tool !== 'pen') arm('pen')
      })
    }
    bar.querySelector<HTMLElement>('[data-ink-undo]')?.addEventListener('click', () => {
      const b = hooks.block(id)
      if (!b) return
      const arr = Object.hasOwn(b, 'strokes') ? (b as { strokes?: unknown }).strokes : undefined
      if (!Array.isArray(arr) || !arr.length) return
      // A COMMIT, so the app's own ⌘Z undoes the undo. The button exists for
      // the touch case, where there is no ⌘Z to press.
      hooks.commit(() => { arr.pop() }, { structure: false })
      hooks.repaint()
    })
    bar.querySelector<HTMLElement>('[data-ink-shape]')?.addEventListener('click', () => {
      const b = hooks.block(id)
      if (!b) return
      const next = nextRatio(inkRatio(b))
      // The default is an ABSENT KEY: a drawing cycled back to Wide is
      // byte-identical to one that was never touched.
      hooks.commit(() => {
        if (next === CANVAS_RATIO) delete (b as { ratio?: number }).ratio
        else (b as { ratio?: number }).ratio = next
      })
      hooks.repaint()
    })
    paintBar(bar)
  }

  // ————— THE GESTURE ————————————————————————————————————————————————
  //
  // POINTER EVENTS, where the canvas drag deliberately uses mouse events.
  // That divergence is the point of this block: `pressure` and `pointerType`
  // exist on PointerEvent and nowhere else, and `getCoalescedEvents` is the
  // only way to see the samples a 120Hz digitizer took between two frames —
  // without it a fast stroke is stored as the four points that happened to
  // land on a rAF boundary. Emulated mouse events carry none of the three.

  let live: SVGPathElement | null = null
  let pts: Pt[] = []
  let press: number[] = []
  let ptype = 'mouse'
  let active = -1
  let erased: number[] = []

  const at = (e: PointerEvent): Pt => {
    const r = svg.getBoundingClientRect()
    // BOTH axes divided by the WIDTH — the stored unit. Dividing y by the
    // height instead is the shear this block's coordinate system exists to
    // avoid, and it would look like a working drawing until the shape changed.
    const w = r.width || 1
    return { x: ((e.clientX - r.left) / w) * 100, y: ((e.clientY - r.top) / w) * 100 }
  }

  svg.addEventListener('pointerdown', (e) => {
    if (!pen.tool || active >= 0) return
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.preventDefault()
    active = e.pointerId
    ptype = e.pointerType || 'mouse'
    try { svg.setPointerCapture(e.pointerId) } catch { /* no capture */ }
    if (pen.tool === 'eraser') { erased = []; eraseAt(at(e), svg); return }
    pts = [at(e)]
    press = [e.pressure]
    live = document.createElementNS(SVGNS, 'path') as SVGPathElement
    live.setAttribute('fill', 'none')
    live.setAttribute('stroke-linecap', 'round')
    live.setAttribute('stroke-linejoin', 'round')
    live.setAttribute('stroke', pen.color ?? 'currentColor')
    live.setAttribute('stroke-width', String(pen.width))
    svg.appendChild(live)
  })

  svg.addEventListener('pointermove', (e) => {
    if (active !== e.pointerId) return
    e.preventDefault()
    const batch = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e]
    if (pen.tool === 'eraser') {
      for (const s of batch.length ? batch : [e]) eraseAt(at(s as PointerEvent), svg)
      return
    }
    if (!live) return
    for (const s of batch.length ? batch : [e]) {
      const p = at(s as PointerEvent)
      const last = pts[pts.length - 1]
      // A sample that did not move is a sample that costs a point and says
      // nothing. Dropped here rather than after RDP, because RDP's cost is in
      // the count it is handed.
      if (Math.abs(p.x - last.x) < 0.01 && Math.abs(p.y - last.y) < 0.01) continue
      pts.push(p)
      press.push((s as PointerEvent).pressure)
      if (pts.length > INK_MAX_POINTS) break
    }
    // The LIVE path is drawn unsimplified: what the author sees while drawing
    // is the pen, and RDP is what is written down when they lift it.
    live.setAttribute('d', emitPath(pts, 3))
  })

  const finish = (e: PointerEvent): void => {
    if (active !== e.pointerId) return
    active = -1
    try { svg.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
    if (pen.tool === 'eraser') {
      const gone = erased.slice()
      erased = []
      if (!gone.length) return
      const b = hooks.block(id)
      if (!b) return
      const arr = Object.hasOwn(b, 'strokes') ? (b as { strokes?: unknown }).strokes : undefined
      if (!Array.isArray(arr)) return
      // ONE COMMIT PER GESTURE — the canvas drag's rule. A sweep of the
      // eraser across nine strokes is one undo entry, not nine.
      hooks.commit(() => {
        for (const i of gone.slice().sort((a, z) => z - a)) arr.splice(i, 1)
      }, { structure: false })
      hooks.repaint()
      return
    }
    // BOTH buffers are taken BEFORE either is cleared. An earlier draft reset
    // `press` on the line above the `pressureWidth(…, press)` call and passed
    // the empty array, so every stylus stroke came out at the nominal width and
    // pressure looked implemented while doing nothing. Found by measuring a
    // stored stroke's `w` in a real browser, which is the only place it shows.
    const drawn = pts
    const pressed = press
    pts = []
    press = []
    live?.remove()
    live = null
    if (drawn.length < 2) return
    const rec = strokeRecord(drawn, pen.color, pressureWidth(pen.width, ptype, pressed))
    if (!rec) return
    const b = hooks.block(id)
    if (!b) return
    hooks.commit(() => { strokeArray(b).push(rec) }, { structure: false })
    hooks.repaint()
  }
  svg.addEventListener('pointerup', finish)
  svg.addEventListener('pointercancel', finish)

  /** Mark every stroke under the eraser. Marked, not spliced: the model is
   *  written once, on release. A `const` arrow rather than a declaration: a
   *  hoisted function is callable before the null-guard above, so the compiler
   *  will not carry `svg`'s narrowing into it. */
  function eraseAt(p: Pt, surface: SVGSVGElement): void {
    const b = hooks.block(id)
    if (!b) return
    const all = strokesOf(b)
    const hit = strokeAt(all, p, Math.max(1, pen.width * 1.5))
    if (hit < 0 || erased.includes(hit)) return
    erased.push(hit)
    // The stroke leaves the screen the moment it is erased, so the gesture
    // reads as erasing rather than as a delay.
    const g = surface.firstElementChild
    const node = g?.children[hit]
    if (node instanceof SVGElement) node.style.opacity = '0.12'
  }
}

/** Which swatch and which nib are lit. Cheap, and re-run on every pen change
 *  rather than repainting the page — a colour is not a document edit. */
function paintBar(bar: HTMLElement): void {
  for (const el of bar.querySelectorAll<HTMLElement>('[data-ink-color]')) {
    const v = el.dataset.inkColor ?? ''
    el.setAttribute('aria-pressed', String((COLOR_OK.test(v) ? v : null) === pen.color))
  }
  for (const el of bar.querySelectorAll<HTMLElement>('[data-ink-width]')) {
    el.setAttribute('aria-pressed', String(Number(el.dataset.inkWidth) === pen.width))
  }
}

/**
 * The toolbar. EDITOR ONLY — the reading view, print and a locked space must
 * not paint a pen that cannot draw.
 */
export function renderInkTools(el: HTMLElement, b: Block): void {
  const bar = document.createElement('div')
  bar.className = 'sp-ink-tools'

  const btn = (cls: string, label: string, tip: string): HTMLButtonElement => {
    const x = document.createElement('button')
    x.type = 'button'
    x.className = `sp-btn ${cls}`
    x.textContent = label
    x.title = tip
    x.setAttribute('aria-label', tip)
    return x
  }

  const drawBtn = btn('sp-ink-btn', t('Pen'), t('Draw with the pen'))
  drawBtn.dataset.inkTool = 'pen'
  const eraseBtn = btn('sp-ink-btn', t('Eraser'), t('Rub out a stroke'))
  eraseBtn.dataset.inkTool = 'eraser'
  bar.append(drawBtn, eraseBtn)

  const swatches = document.createElement('div')
  swatches.className = 'sp-ink-swatches'
  // LITERALS, one per swatch, in INK_COLORS order. `t(NAME_OF[c])` would reach
  // no catalog while the packer still reported 100%, because the extraction
  // sweep reads `t('…')` calls out of the SOURCE.
  const HUE = [
    t('Default ink'), t('Red'), t('Orange'), t('Yellow'),
    t('Green'), t('Blue'), t('Purple'), t('White'),
  ]
  INK_COLORS.forEach((c, ci) => {
    const s = document.createElement('button')
    s.type = 'button'
    s.className = 'sp-ink-swatch'
    s.dataset.inkColor = c ?? ''
    // `currentColor` for the default swatch, so the first pen shows as the
    // document's own ink in both themes rather than as a black dot on black.
    s.style.background = c ?? 'currentColor'
    const tip = Object.hasOwn(HUE, String(ci)) ? HUE[ci] : t('Coloured ink')
    s.title = tip
    s.setAttribute('aria-label', tip)
    swatches.appendChild(s)
  })
  bar.appendChild(swatches)

  const nibs = document.createElement('div')
  nibs.className = 'sp-ink-nibs'
  // LITERALS, one per nib. A `t(LABEL[i])` here would reach no catalog while
  // the packer still reported 100% — the extraction sweep reads the source.
  const NIB = [t('Fine'), t('Medium'), t('Thick'), t('Marker')]
  INK_WIDTHS.forEach((w, i) => {
    const n = document.createElement('button')
    n.type = 'button'
    n.className = 'sp-ink-nib'
    n.dataset.inkWidth = String(w)
    const dot = document.createElement('span')
    dot.style.width = `${4 + i * 3}px`
    dot.style.height = `${4 + i * 3}px`
    n.appendChild(dot)
    const tip = Object.hasOwn(NIB, String(i)) ? NIB[i] : ''
    n.title = tip
    n.setAttribute('aria-label', tip)
    nibs.appendChild(n)
  })
  bar.appendChild(nibs)

  const undo = btn('sp-ink-btn', t('Undo stroke'), t('Remove the last stroke'))
  undo.dataset.inkUndo = b.id
  bar.appendChild(undo)

  const shape = ratioName(inkRatio(b))
  // ONE cycling button, the canvas's settled argument: the word on the button
  // is the state and the click is the change.
  const SHAPE_WORD: Record<string, string> = {
    Wide: t('Wide'), Square: t('Square'), Tall: t('Tall'),
  }
  const sh = btn('sp-ink-btn', Object.hasOwn(SHAPE_WORD, shape) ? SHAPE_WORD[shape] : shape,
    t('Change the shape of this drawing'))
  sh.dataset.inkShape = b.id
  bar.appendChild(sh)

  el.appendChild(bar)
}
