#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
//
// «The Light Clock» — the example deck for Bento's math elements.
//
//   node scripts/build-lightclock-deck.mjs [outDir]     (default: working/)
//
// Physics chosen for one reason: special relativity's time dilation falls out
// of ONE right triangle in eight algebraic steps, and those eight steps are the
// best possible showcase for per-symbol math morphing. Each step lives on its
// own morph-linked slide carrying the same morph key, so Bento tweens every
// glyph from where it was to where it lands — a term crossing the equals sign
// visibly travels there, a squared factor is carried along, a whole radical
// collapses into a single γ. The formulas are BAKED (scripts/bake-math.mjs), so
// presenting this deck needs no engine and no network.
//
// The LaTeX lives in lightclock-deck.tex.mjs; the baked SVG in
// lightclock-deck.math.mjs. Editing a formula means editing the .tex.mjs and
// re-running the baker — never hand-editing the baked markup.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MATH } from './lightclock-deck.tex.mjs'
import { BAKED } from './lightclock-deck.math.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const shell = readFileSync(join(root, 'slides/dist-single/Bento_Slides.bento.html'), 'utf8')

const SOURCE = Object.fromEntries(MATH.map((m) => [m.key, m]))
for (const k of Object.keys(SOURCE)) {
  if (!BAKED[k]) throw new Error(`"${k}" is not baked — run: node scripts/bake-math.mjs scripts/lightclock-deck.tex.mjs`)
}

// ——— fonts ——————————————————————————————————————————————————————————
const fontSrc = readFileSync(join(root, 'slides/src/fontdata.ts'), 'utf8')
const fontConst = (name) => fontSrc.match(new RegExp(`export const ${name}\\s*=\\s*'(data:[^']+)'`))[1]
const fontFile = (name) =>
  'data:font/woff2;base64,' + readFileSync(join(root, 'scripts/gallery-fonts', name)).toString('base64')

const DISPLAY = 'Fraunces, Georgia, serif'
const BODY = "'Instrument Sans', 'Helvetica Neue', sans-serif"
const MONO = "'Space Mono', ui-monospace, Menlo, Consolas, monospace"

// ——— palette ————————————————————————————————————————————————————————
const VOID = '#05091A'   // covers and section breaks
const DEEP = '#0A1226'   // the derivation's own background — constant across
const CARD = '#141E3D'   // the equation slab
const LINE = '#26345A'   // hairlines and grid
const INK = '#EDF2FF'
const SOFT = '#9AACCE'
const MIST = '#63789F'
const CYAN = '#5FE3DA'   // light, the photon, the accent
const AMBER = '#FFB454'  // the moving frame
const VIOLET = '#9D8CFF'
const PAPER = '#F3F6FC'
const PAPER_INK = '#0A1226'

// ——— builders ———————————————————————————————————————————————————————
let seq = 0
const id = (p) => `${p}-${(++seq).toString(36)}`

const text = (o) => ({
  id: o.id ?? id('t'), type: 'text', x: o.x, y: o.y, w: o.w, h: o.h,
  rotation: o.rotation ?? 0, opacity: o.opacity ?? 1,
  html: o.html, fontSize: o.fontSize ?? 20, fontFamily: o.fontFamily ?? BODY,
  fontWeight: o.fontWeight ?? 400, color: o.color ?? INK,
  align: o.align ?? 'left', valign: o.valign ?? 'top', lineHeight: o.lineHeight ?? 1.45,
  ...(o.letterSpacing != null ? { letterSpacing: o.letterSpacing } : {}),
  ...(o.fx ? { fx: o.fx } : {}), ...(o.link ? { link: o.link } : {}),
  ...(o.shadow ? { shadow: o.shadow } : {}), ...(o.group ? { group: o.group } : {}),
})

const shape = (kind, o) => ({
  id: o.id ?? id('s'), type: 'shape', shape: kind, x: o.x, y: o.y, w: o.w, h: o.h,
  rotation: o.rotation ?? 0, opacity: o.opacity ?? 1,
  fill: o.fill ?? 'none', stroke: o.stroke ?? 'none', strokeWidth: o.strokeWidth ?? 0,
  radius: o.radius ?? 0,
  ...(o.fillGradient ? { fillGradient: o.fillGradient } : {}),
  ...(o.strokeStyle ? { strokeStyle: o.strokeStyle } : {}),
  ...(o.lineStart ? { lineStart: o.lineStart } : {}), ...(o.lineEnd ? { lineEnd: o.lineEnd } : {}),
  ...(o.fx ? { fx: o.fx } : {}), ...(o.shadow ? { shadow: o.shadow } : {}),
  ...(o.group ? { group: o.group } : {}),
})

/**
 * A line between two slide points.
 *
 * The renderer draws a `line` shape horizontally across its own box, so an
 * arbitrary segment is a box centred on the midpoint, as wide as the segment is
 * long, rotated. Line shapes take their colour from `fill`, NOT `stroke` — the
 * stroke attribute is what a morph tweens.
 */
const lineBetween = (x1, y1, x2, y2, o = {}) => {
  const len = Math.hypot(x2 - x1, y2 - y1)
  const h = o.h ?? 24
  return shape('line', {
    ...o,
    x: Math.round((x1 + x2) / 2 - len / 2), y: Math.round((y1 + y2) / 2 - h / 2),
    w: Math.round(len), h,
    rotation: Math.round((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI * 100) / 100,
    fill: o.fill ?? CYAN, strokeWidth: o.strokeWidth ?? 3,
  })
}

/**
 * A baked equation, sized from its INTRINSIC dimensions at a fixed px-per-ex.
 *
 * Sizing this way rather than fitting each formula to a fixed box is what keeps
 * the derivation legible: every step renders at the same type size, so across a
 * morph the symbols travel without also scaling. (The svg fills its box
 * preserving aspect, so a box of the wrong aspect would letterbox and shrink.)
 */
const equation = (key, o) => {
  const b = BAKED[key]
  const px = o.px ?? 30
  const w = Math.round(b.wEx * px)
  const h = Math.round(b.hEx * px)
  return {
    id: o.id ?? id('eq'), type: 'math', mode: 'equation',
    x: Math.round((o.cx ?? 640) - w / 2), y: Math.round((o.cy ?? 360) - h / 2), w, h,
    rotation: 0, opacity: o.opacity ?? 1,
    source: SOURCE[key].source, baked: b.baked,
    display: true, align: 'center', color: o.color ?? INK,
    ...(SOURCE[key].tags ? { morphTags: SOURCE[key].tags } : {}),
    ...(o.morphId ? { morphId: o.morphId } : {}),
    ...(o.fx ? { fx: o.fx } : {}),
  }
}

/** A baked prose+math note. Size and line height ride in the MODEL — nothing
 *  sets a font-size on the slide, so an inherited one would resolve against the
 *  viewer's browser default. The inline formulas are sized in `ex`, so they
 *  follow the prose automatically. */
const note = (key, o) => ({
  id: o.id ?? id('note'), type: 'math', mode: 'note',
  x: o.x, y: o.y, w: o.w, h: o.h, rotation: 0, opacity: o.opacity ?? 1,
  source: SOURCE[key].source, baked: BAKED[key].baked,
  display: false, align: o.align ?? 'left',
  fontFamily: o.fontFamily ?? BODY, fontSize: o.fontSize ?? 19, lineHeight: o.lineHeight ?? 1.62,
  color: o.color ?? SOFT,
  ...(o.fx ? { fx: o.fx } : {}),
})

const chart = (o) => ({
  id: o.id ?? id('c'), type: 'chart', x: o.x, y: o.y, w: o.w, h: o.h,
  rotation: 0, opacity: 1, preset: o.preset ?? 'line', option: o.option,
  ...(o.fx ? { fx: o.fx } : {}),
})

const table = (o) => ({
  id: o.id ?? id('tb'), type: 'table', x: o.x, y: o.y, w: o.w, h: o.h,
  rotation: 0, opacity: 1,
  columns: o.columns, header: true, rows: o.rows, style: o.style,
  ...(o.fx ? { fx: o.fx } : {}),
})

const slide = (o) => ({
  id: o.id ?? id('sl'), background: o.background ?? DEEP,
  transition: o.transition ?? 'morph', notes: o.notes ?? '', elements: o.elements,
})

// ——— shared furniture (stable ids ⇒ it morphs instead of popping) ————————
const K_KICKER = 'lc-kicker'
const K_RULE = 'lc-rule'
const K_PAGE = 'lc-page'

const kicker = (label, color = CYAN) =>
  text({ id: K_KICKER, x: 96, y: 52, w: 800, h: 24, html: label,
    fontSize: 12, fontWeight: 700, color, letterSpacing: 3.6, fontFamily: BODY })

const rule = (color = LINE) => shape('rect', { id: K_RULE, x: 96, y: 84, w: 1088, h: 1, fill: color })

/** Auto page numeral — `{{page:2}}` re-numbers itself if slides move. */
const pageNo = (color = MIST) =>
  text({ id: K_PAGE, x: 1024, y: 650, w: 160, h: 24, html: '{{page:2}}',
    fontSize: 12, fontWeight: 700, color, align: 'right', fontFamily: MONO, letterSpacing: 1 })

const furniture = (label, { color = CYAN, ruleColor = LINE, numColor = MIST } = {}) =>
  [kicker(label, color), rule(ruleColor), pageNo(numColor)]

const title = (html, o = {}) =>
  text({ id: o.id ?? 'lc-title', x: 92, y: o.y ?? 116, w: o.w ?? 1000, h: o.h ?? 96, html,
    fontSize: o.fontSize ?? 46, fontWeight: 900, fontFamily: DISPLAY,
    color: o.color ?? INK, lineHeight: 1.08, ...o })

// ═══════════════════════════════════════════════════════════════════════
// The derivation rail — eight steps, one morph key.
// ═══════════════════════════════════════════════════════════════════════
const EQ = 'lc-eq'            // the morph key every step's equation carries
const STEPS = ['pyth', 'expand', 'gather', 'factor', 'isolate', 'root', 'gammaeq']

/** Progress rail: one tick per step, plus a marker that TRAVELS between
 *  slides because it keeps its id while its x changes. */
const railAt = (i) => {
  const x0 = 96, gap = 1088 / STEPS.length
  const out = STEPS.map((_, n) =>
    shape('rect', {
      id: `lc-rail-${n}`, x: Math.round(x0 + n * gap), y: 640, w: Math.round(gap - 14), h: 3,
      radius: 2, fill: n <= i ? 'rgba(95,227,218,0.5)' : LINE,
    }))
  out.push(shape('rect', {
    id: 'lc-rail-mark', x: Math.round(x0 + i * gap), y: 638, w: Math.round(gap - 14), h: 7,
    radius: 4, fill: CYAN, shadow: { y: 0, blur: 16, color: 'rgba(95,227,218,0.65)' },
  }))
  return out
}

/**
 * One step of the derivation. Everything except the equation and the caption is
 * identical from slide to slide and keeps its id, so the only things that
 * visibly change are the symbols — which is the entire demonstration.
 */
const step = (i, key, caption, notes, opts = {}) => slide({
  id: `lc-step-${key}`, background: DEEP, notes,
  elements: [
    ...furniture('THE DERIVATION'),
    text({ id: 'lc-step-n', x: 1024, y: 44, w: 160, h: 28,
      html: `STEP ${i + 1} / ${STEPS.length}`, fontSize: 12, fontWeight: 700,
      color: MIST, align: 'right', fontFamily: MONO, letterSpacing: 1.5 }),
    title(opts.title ?? 'One triangle, eight steps.', { y: 116, w: 900, fontSize: 40 }),
    shape('rect', {
      id: 'lc-eq-card', x: 96, y: 216, w: 1088, h: 252, radius: 20, fill: CARD,
      stroke: LINE, strokeWidth: 1.5,
      shadow: { y: 18, blur: 44, color: 'rgba(0,0,0,0.45)' },
    }),
    shape('rect', { id: 'lc-eq-tab', x: 96, y: 216, w: 6, h: 252, radius: 3, fill: opts.tab ?? CYAN }),
    equation(key, { id: i === 0 ? EQ : `lc-eq-${key}`, ...(i === 0 ? {} : { morphId: EQ }), cx: 640, cy: 342, px: opts.px ?? 30 }),
    text({ id: 'lc-step-cap', x: 96, y: 502, w: 1000, h: 96, html: caption,
      fontSize: 19, color: SOFT, lineHeight: 1.6 }),
    ...railAt(i),
  ],
})

// ═══════════════════════════════════════════════════════════════════════
// THE DECK
// ═══════════════════════════════════════════════════════════════════════
function buildDeck() {
  const slides = []

  // ── 1 · cover ──────────────────────────────────────────────────────────
  // The photon bounces on a motion-path loop — the deck's subject, moving,
  // before a single word about it.
  slides.push(slide({
    id: 'lc-cover', background: VOID, transition: 'fade',
    notes:
      'Welcome. This deck derives time dilation from one right triangle — and it uses Bento’s math ' +
      'elements to do it, so watch the equations rather than the bullet points: from slide 7 onward ' +
      'every step MORPHS into the next, symbol by symbol. Nothing here is a picture of an equation; ' +
      'the LaTeX is in the file and the SVG is baked in, so presenting needs no engine and no network. ' +
      '→ advances, Esc returns to the editor, S opens the speaker view.',
    elements: [
      shape('ellipse', { x: 806, y: 30, w: 660, h: 660, fill: 'rgba(95,227,218,0.07)' }),
      shape('ellipse', { x: 906, y: 130, w: 460, h: 460, fill: 'rgba(157,140,255,0.07)' }),
      kicker('SPECIAL RELATIVITY · A DERIVATION IN EIGHT STEPS'),
      rule('rgba(95,227,218,0.35)'),
      text({ x: 92, y: 200, w: 760, h: 240, html: 'The<br>Light Clock.', fontSize: 104,
        fontWeight: 900, fontFamily: DISPLAY, color: INK, lineHeight: 0.94,
        fx: { enter: 'fade-up', order: 0 } }),
      text({ x: 96, y: 470, w: 620, h: 96,
        html: 'How the strangest fact in physics falls out of a triangle you learned at fourteen.',
        fontSize: 22, color: SOFT, lineHeight: 1.5, fx: { enter: 'fade-up', order: 1 } }),
      text({ x: 96, y: 596, w: 620, h: 30, html: 'Built in Bento · math elements, morphing symbol by symbol',
        fontSize: 13, fontWeight: 700, color: MIST, fontFamily: MONO, letterSpacing: 1,
        fx: { enter: 'fade', order: 2 } }),

      // the clock itself: two mirrors and a photon on a bouncing loop
      shape('rect', { id: 'lc-m-top', x: 986, y: 210, w: 240, h: 9, radius: 5, fill: CYAN,
        shadow: { y: 0, blur: 20, color: 'rgba(95,227,218,0.55)' }, fx: { enter: 'fade', order: 1 } }),
      shape('rect', { id: 'lc-m-bot', x: 986, y: 500, w: 240, h: 9, radius: 5, fill: CYAN,
        shadow: { y: 0, blur: 20, color: 'rgba(95,227,218,0.55)' }, fx: { enter: 'fade', order: 1 } }),
      shape('rect', { id: 'lc-gap', x: 1104, y: 219, w: 2, h: 281, fill: 'rgba(95,227,218,0.22)',
        strokeStyle: 'dashed', fx: { enter: 'fade', order: 2 } }),
      shape('ellipse', {
        id: 'lc-photon', x: 1094, y: 232, w: 22, h: 22, fill: AMBER,
        shadow: { y: 0, blur: 22, color: 'rgba(255,180,84,0.9)' },
        // relative to rest: straight down to the far mirror and back
        fx: { loop: { type: 'motion-path', path: 'M0,0 L0,246 L0,0', duration: 2.4 } },
      }),
    ],
  }))

  // ── 2 · the one assumption ─────────────────────────────────────────────
  slides.push(slide({
    id: 'lc-assume', background: VOID, transition: 'fade',
    notes:
      'Everything in this deck rests on one experimental fact, and no maths can talk you out of it: ' +
      'light’s speed does not care how fast you are moving. Run toward a beam and you do not measure ' +
      'c plus your speed — you measure c. Michelson and Morley found it in 1887 and nobody has broken ' +
      'it since. Einstein’s move in 1905 was simply to take it seriously.',
    elements: [
      ...furniture('THE ONE ASSUMPTION'),
      title('Light does not care<br>how fast you are going.', { y: 150, fontSize: 62, w: 1050 }),
      shape('rect', { x: 96, y: 386, w: 96, h: 4, radius: 2, fill: CYAN }),
      text({ x: 96, y: 420, w: 560, h: 150,
        html: 'Chase a light beam at half its speed and it still retreats from you at <b>the full</b> ' +
          'speed of light. Not c minus your speed. Not c plus it. <b>c</b>, for everyone, always.',
        fontSize: 20, color: SOFT, lineHeight: 1.6, fx: { enter: 'fade-up', order: 1 } }),
      shape('rect', { x: 716, y: 400, w: 468, h: 168, radius: 18, fill: CARD, stroke: LINE, strokeWidth: 1.5 }),
      text({ x: 744, y: 428, w: 412, h: 28, html: 'MEASURED SPEED OF LIGHT',
        fontSize: 11, fontWeight: 700, color: MIST, fontFamily: MONO, letterSpacing: 2 }),
      text({ id: 'lc-cnum', x: 744, y: 460, w: 412, h: 60, html: '299 792 458',
        fontSize: 46, fontWeight: 700, color: CYAN, fontFamily: MONO,
        fx: { enter: 'fade', countUp: true, order: 2 } }),
      text({ x: 744, y: 520, w: 412, h: 28, html: 'metres per second — in every laboratory, on every heading',
        fontSize: 13, color: MIST }),
      text({ x: 96, y: 610, w: 900, h: 30,
        html: 'Michelson &amp; Morley, 1887 · taken seriously by Einstein, 1905',
        fontSize: 13, fontWeight: 700, color: MIST, fontFamily: MONO, letterSpacing: 1 }),
    ],
  }))

  // ── 3 · build the clock ────────────────────────────────────────────────
  slides.push(slide({
    id: 'lc-clock', background: DEEP,
    notes:
      'So build the simplest clock that uses only that fact. Two mirrors, a pulse of light bouncing ' +
      'between them. One tick = one round trip. There is nothing special about it — any clock will do, ' +
      'and that will matter at the end. The prose here is a math NOTE element: ordinary text in the ' +
      'deck’s own font with $L$ and $c$ set as real mathematics inline.',
    elements: [
      ...furniture('THE APPARATUS'),
      title('A clock made of light.', { y: 116, fontSize: 44 }),
      note('note_setup', { x: 96, y: 214, w: 470, h: 190, fontSize: 20 }),
      text({ x: 96, y: 430, w: 470, h: 30, html: 'ONE TICK = ONE ROUND TRIP',
        fontSize: 12, fontWeight: 700, color: CYAN, fontFamily: MONO, letterSpacing: 2 }),

      shape('rect', { id: 'lc-stage', x: 632, y: 176, w: 552, h: 420, radius: 20,
        fill: 'rgba(20,30,61,0.55)', stroke: LINE, strokeWidth: 1.5 }),
      shape('rect', { id: 'lc-m-top', x: 788, y: 226, w: 240, h: 9, radius: 5, fill: CYAN,
        shadow: { y: 0, blur: 20, color: 'rgba(95,227,218,0.55)' } }),
      shape('rect', { id: 'lc-m-bot', x: 788, y: 516, w: 240, h: 9, radius: 5, fill: CYAN,
        shadow: { y: 0, blur: 20, color: 'rgba(95,227,218,0.55)' } }),
      shape('rect', { id: 'lc-gap', x: 906, y: 235, w: 2, h: 281, fill: 'rgba(95,227,218,0.22)', strokeStyle: 'dashed' }),
      text({ id: 'lc-lab-L', x: 924, y: 356, w: 60, h: 40, html: '<i>L</i>',
        fontSize: 30, fontWeight: 700, color: CYAN, fontFamily: DISPLAY }),
      shape('ellipse', {
        id: 'lc-photon', x: 896, y: 248, w: 22, h: 22, fill: AMBER,
        shadow: { y: 0, blur: 22, color: 'rgba(255,180,84,0.9)' },
        fx: { loop: { type: 'motion-path', path: 'M0,0 L0,246 L0,0', duration: 2.4 } },
      }),
      text({ id: 'lc-stage-cap', x: 660, y: 546, w: 496, h: 30, html: 'AT REST — THE PULSE GOES STRAIGHT UP AND DOWN',
        fontSize: 11, fontWeight: 700, color: MIST, fontFamily: MONO, letterSpacing: 1.6, align: 'center' }),
    ],
  }))

  // ── 4 · the tick at rest ───────────────────────────────────────────────
  slides.push(slide({
    id: 'lc-rest', background: DEEP,
    notes:
      'At rest the answer is immediate: the pulse covers 2L at speed c, so a tick takes 2L over c. ' +
      'Call it delta-t-primed — the time between ticks measured by someone sitting still beside the ' +
      'clock. That is the number the rest of the deck compares against.',
    elements: [
      ...furniture('THE APPARATUS'),
      title('At rest, the tick is easy.', { y: 116, fontSize: 44 }),
      shape('rect', { id: 'lc-eq-card', x: 96, y: 216, w: 1088, h: 252, radius: 20, fill: CARD,
        stroke: LINE, strokeWidth: 1.5, shadow: { y: 18, blur: 44, color: 'rgba(0,0,0,0.45)' } }),
      shape('rect', { id: 'lc-eq-tab', x: 96, y: 216, w: 6, h: 252, radius: 3, fill: CYAN }),
      equation('rest', { id: 'lc-eq-rest', cx: 640, cy: 342, px: 34 }),
      text({ id: 'lc-step-cap', x: 96, y: 502, w: 1020, h: 96,
        html: 'Distance <b>2L</b> at speed <b>c</b>. The prime marks it as the time measured by someone ' +
          'sitting still next to the clock — the <b>proper time</b> between two ticks.',
        fontSize: 19, color: SOFT, lineHeight: 1.6 }),
    ],
  }))

  // ── 5 · set it moving ──────────────────────────────────────────────────
  // Same mirror/photon ids as slide 3, so the whole apparatus slides across
  // and the photon's path bends — the diagram morphs rather than cutting.
  slides.push(slide({
    id: 'lc-moving', background: DEEP,
    notes:
      'Now watch the same clock go past you at speed v. Nothing about the clock changes — but its ' +
      'pulse no longer travels straight up. By the time the light reaches the top mirror, the mirror ' +
      'has moved. In YOUR frame the pulse goes diagonally. Notice the apparatus morphed across from ' +
      'the previous slide instead of cutting: same element ids, so Bento tweens it.',
    elements: [
      ...furniture('THE APPARATUS'),
      title('Now let it fly past you.', { y: 116, fontSize: 44 }),
      note('note_moving', { x: 96, y: 214, w: 470, h: 210, fontSize: 20 }),
      shape('rect', { x: 96, y: 452, w: 300, h: 44, radius: 22, fill: 'rgba(255,180,84,0.14)' }),
      text({ x: 120, y: 464, w: 260, h: 28, html: 'SPEED <b>v</b> →  TO THE RIGHT',
        fontSize: 12, fontWeight: 700, color: AMBER, fontFamily: MONO, letterSpacing: 1.6 }),

      shape('rect', { id: 'lc-stage', x: 632, y: 176, w: 552, h: 420, radius: 20,
        fill: 'rgba(20,30,61,0.55)', stroke: LINE, strokeWidth: 1.5 }),
      // ghost of where the clock started
      shape('rect', { x: 690, y: 226, w: 180, h: 7, radius: 4, fill: 'rgba(95,227,218,0.18)' }),
      shape('rect', { x: 690, y: 516, w: 180, h: 7, radius: 4, fill: 'rgba(95,227,218,0.18)' }),
      // the diagonal the pulse actually takes
      lineBetween(780, 520, 950, 230, { id: 'lc-diag-up', fill: AMBER, strokeWidth: 3 }),
      lineBetween(950, 230, 1120, 520, { id: 'lc-diag-dn', fill: AMBER, strokeWidth: 3 }),
      lineBetween(780, 520, 1120, 520, { id: 'lc-base', fill: 'rgba(255,180,84,0.45)', strokeWidth: 2, strokeStyle: 'dashed' }),
      shape('rect', { id: 'lc-m-top', x: 890, y: 226, w: 240, h: 9, radius: 5, fill: CYAN,
        shadow: { y: 0, blur: 20, color: 'rgba(95,227,218,0.55)' } }),
      shape('rect', { id: 'lc-m-bot', x: 890, y: 516, w: 240, h: 9, radius: 5, fill: CYAN,
        shadow: { y: 0, blur: 20, color: 'rgba(95,227,218,0.55)' } }),
      shape('rect', { id: 'lc-gap', x: 1008, y: 235, w: 2, h: 281, fill: 'rgba(95,227,218,0.22)', strokeStyle: 'dashed' }),
      shape('ellipse', {
        id: 'lc-photon', x: 769, y: 509, w: 22, h: 22, fill: AMBER,
        shadow: { y: 0, blur: 22, color: 'rgba(255,180,84,0.9)' },
        // the V the pulse traces in your frame, relative to its rest corner
        fx: { loop: { type: 'motion-path', path: 'M0,0 L170,-290 L340,0', duration: 2.4 } },
      }),
      text({ id: 'lc-lab-L', x: 1024, y: 356, w: 60, h: 40, html: '<i>L</i>',
        fontSize: 30, fontWeight: 700, color: CYAN, fontFamily: DISPLAY }),
      text({ id: 'lc-stage-cap', x: 660, y: 546, w: 496, h: 30, html: 'MOVING — THE PULSE TAKES THE LONG WAY',
        fontSize: 11, fontWeight: 700, color: MIST, fontFamily: MONO, letterSpacing: 1.6, align: 'center' }),
    ],
  }))

  // ── 6 · the triangle ───────────────────────────────────────────────────
  slides.push(slide({
    id: 'lc-triangle', background: DEEP,
    notes:
      'Half a tick is a right triangle. The hypotenuse is how far the LIGHT went: c times half the tick. ' +
      'The base is how far the CLOCK went: v times half the tick. The upright is the mirror gap L, which ' +
      'is unchanged — it is perpendicular to the motion. Three sides, one Pythagoras, and the physics is ' +
      'over. Everything after this slide is algebra.',
    elements: [
      ...furniture('THE GEOMETRY'),
      title('Half a tick is a right triangle.', { y: 116, fontSize: 44 }),
      note('note_trap', { x: 96, y: 218, w: 430, h: 220, fontSize: 20 }),
      text({ x: 96, y: 470, w: 430, h: 120,
        html: 'The upright is untouched: <b>L</b> is perpendicular to the motion, so both observers ' +
          'agree on it. That is the hinge of the whole argument.',
        fontSize: 17, color: MIST, lineHeight: 1.6 }),

      // The triangle, oriented to match slide 5: the pulse starts at the
      // bottom-LEFT and climbs to the right, so the hypotenuse rises left→right,
      // the upright L sits at the right (where the top mirror has got to), and
      // the base is the ground the clock covered. Mirroring it would contradict
      // the diagram the audience just watched.
      lineBetween(660, 560, 1060, 560, { fill: 'rgba(255,180,84,0.85)', strokeWidth: 3 }),
      lineBetween(1060, 560, 1060, 250, { fill: CYAN, strokeWidth: 3 }),
      lineBetween(660, 560, 1060, 250, { fill: VIOLET, strokeWidth: 3 }),
      // right-angle mark, in the corner that actually holds the right angle
      shape('rect', { x: 1032, y: 532, w: 28, h: 28, fill: 'none', stroke: 'rgba(154,172,206,0.55)', strokeWidth: 2 }),
      text({ x: 740, y: 574, w: 240, h: 40, html: 'v &middot; Δt / 2',
        fontSize: 22, fontWeight: 700, color: AMBER, fontFamily: DISPLAY, align: 'center' }),
      text({ x: 1078, y: 386, w: 90, h: 40, html: 'L',
        fontSize: 26, fontWeight: 700, color: CYAN, fontFamily: DISPLAY }),
      text({ x: 690, y: 374, w: 250, h: 40, html: 'c &middot; Δt / 2',
        fontSize: 22, fontWeight: 700, color: VIOLET, fontFamily: DISPLAY, align: 'center' }),
      text({ x: 660, y: 200, w: 400, h: 30, html: 'WHAT THE LIGHT TRAVELS · WHAT THE CLOCK TRAVELS',
        fontSize: 11, fontWeight: 700, color: MIST, fontFamily: MONO, letterSpacing: 1.4 }),
    ],
  }))

  // ── 7–13 · the derivation ──────────────────────────────────────────────
  slides.push(step(0, 'pyth',
    'Pythagoras on that triangle. <b>Δt</b> is the tick you measure while the clock flies past; ' +
    'everything else is a length you can read off the picture.',
    'Here is the triangle as algebra — and here is where the deck starts showing off. From this slide ' +
    'to the end of the derivation every step MORPHS into the next: Bento matches the glyphs between ' +
    'consecutive formulas and tweens each one to its new home. Nothing is choreographed by hand; the ' +
    'equations simply share a morph key. Watch a symbol at a time rather than the whole line.',
    { title: 'Pythagoras, on the triangle.', px: 27 }))

  slides.push(step(1, 'expand',
    'Square the brackets. The halves become a quarter; the squares land on <b>c</b>, <b>v</b> and <b>Δt</b>.',
    'Squaring out the brackets. The parentheses fade, the fraction bars fade in, and every letter that ' +
    'survives travels to its new position instead of blinking out and back. Fourteen of the twenty ' +
    'glyphs are matched here.',
    { title: 'Square both brackets.' }))

  slides.push(step(2, 'gather',
    'Move the <b>v</b> term across the equals sign. This is the step to watch — the whole term ' +
    'physically travels to the left-hand side.',
    'THE slide. The v-squared term crosses the equals sign, and because Bento pairs glyphs by shape ' +
    'rather than by position, it does not fade out on the right and fade in on the left — it MOVES, ' +
    'the minus sign appearing as it lands. Seventeen of eighteen glyphs are matched. This is what the ' +
    'math element buys you that an exported image cannot.',
    { title: 'Bring the v-term across.', tab: AMBER }))

  slides.push(step(3, 'factor',
    'Both terms carry <b>Δt²/4</b>, so pull it out front. What is left in the bracket is pure geometry ' +
    'of speeds.',
    'Factoring. The shared factor gathers itself at the front while c-squared and v-squared slide into ' +
    'the bracket. A morph makes an algebraic rearrangement legible in a way a bullet list never does — ' +
    'the audience can follow which symbol went where.',
    { title: 'Factor out the common Δt².' }))

  slides.push(step(4, 'isolate',
    'Isolate <b>Δt²</b>. The bracket goes underneath; the 4 climbs into the numerator.',
    'Isolating delta-t squared. Notice the four and the bracket trade places across the fraction bar — ' +
    'they travel through each other, which is exactly the motion a lecturer draws with their hands.',
    { title: 'Isolate the tick.' }))

  slides.push(step(5, 'root',
    'Take the square root and factor <b>c</b> out of the denominator. The left-hand factor is exactly ' +
    'the resting tick from slide 4.',
    'Square-rooting, then pulling c out of the denominator so the first factor becomes 2L over c — ' +
    'which IS the resting tick we computed at the start. That is the punchline arriving.',
    { title: 'Take the root.', px: 27 }))

  slides.push(step(6, 'gammaeq',
    'And that is time dilation: the moving tick is the resting tick multiplied by a number that ' +
    'depends only on speed.',
    'The collapse. Two morph HINTS do the work here that no automatic glyph match could: 2L-over-c and ' +
    'delta-t-primed share no symbols at all, and neither do a whole radical and a single gamma — so the ' +
    'deck tags each pair by hand in the panel’s Morph hints, and nineteen glyphs fold down into seven. ' +
    'The physics: a moving clock ticks slower, by a factor that is never less than one.',
    { title: 'Time dilation.', tab: VIOLET, px: 40 }))

  // ── 14 · the Lorentz factor ────────────────────────────────────────────
  slides.push(slide({
    id: 'lc-gamma', background: DEEP,
    notes:
      'The factor has a name — gamma, the Lorentz factor — and it is the only thing you need to ' +
      'remember. It is 1 when you are still, it grows slowly, and it runs away to infinity as v ' +
      'approaches c. Since it is never below 1, a moving clock is never fast, only slow.',
    elements: [
      ...furniture('THE RESULT'),
      title('One number does all of it.', { y: 116, fontSize: 44 }),
      shape('rect', { id: 'lc-eq-card', x: 96, y: 216, w: 520, h: 252, radius: 20, fill: CARD,
        stroke: LINE, strokeWidth: 1.5, shadow: { y: 18, blur: 44, color: 'rgba(0,0,0,0.45)' } }),
      shape('rect', { id: 'lc-eq-tab', x: 96, y: 216, w: 6, h: 252, radius: 3, fill: VIOLET }),
      equation('gammadef', { id: 'lc-eq-gammadef', cx: 356, cy: 342, px: 26 }),
      note('note_gamma', { x: 664, y: 224, w: 520, h: 240, fontSize: 19 }),
      text({ x: 96, y: 502, w: 1020, h: 100,
        html: 'γ is never less than 1 — so a moving clock is never fast, only slow. ' +
          'And nothing about the argument mentioned mirrors: any clock, including the decay of a ' +
          'particle or the ageing of a person, must agree with the light clock or you could tell ' +
          'the two apart and detect your own motion.',
        fontSize: 18, color: SOFT, lineHeight: 1.6 }),
    ],
  }))

  // ── 15 · why nobody noticed ────────────────────────────────────────────
  slides.push(slide({
    id: 'lc-lowspeed', background: DEEP,
    notes:
      'Why did nobody notice for two centuries? Expand gamma for small v: the correction is half of ' +
      'v-over-c squared. At motorway speed that is about one part in ten to the thirteen — far below ' +
      'anything Newton could have measured. Relativity does not contradict Newton; it contains him.',
    elements: [
      ...furniture('THE RESULT'),
      title('Why nobody noticed for 200 years.', { y: 116, fontSize: 44 }),
      shape('rect', { id: 'lc-eq-card', x: 96, y: 216, w: 520, h: 252, radius: 20, fill: CARD,
        stroke: LINE, strokeWidth: 1.5, shadow: { y: 18, blur: 44, color: 'rgba(0,0,0,0.45)' } }),
      shape('rect', { id: 'lc-eq-tab', x: 96, y: 216, w: 6, h: 252, radius: 3, fill: CYAN }),
      // morph-linked to the previous slide's γ definition: the exact formula
      // relaxes into its low-speed approximation, symbols carrying over
      equation('lowspeed', { id: 'lc-eq-lowspeed', morphId: 'lc-eq-gammadef', cx: 356, cy: 342, px: 26 }),
      text({ x: 664, y: 230, w: 520, h: 240,
        html: 'For small <b>v</b> the correction is <b>½(v/c)²</b> — quadratic, so it vanishes fast. ' +
          'At motorway speed it is about <b>1 part in 10¹³</b>: your dashboard clock loses a ' +
          'nanosecond every few years of driving.<br><br>Relativity does not overturn Newton. ' +
          'It contains him, as the limit v ≪ c.',
        fontSize: 19, color: SOFT, lineHeight: 1.62 }),
      text({ x: 96, y: 512, w: 1020, h: 60,
        html: 'The effect was always there. It was just smaller than anyone could measure until clocks got very, very good.',
        fontSize: 18, color: MIST, lineHeight: 1.6 }),
    ],
  }))

  // ── 16 · the curve ─────────────────────────────────────────────────────
  slides.push(slide({
    id: 'lc-curve', background: DEEP,
    notes:
      'Here is gamma plotted against speed. It is flat and boring for most of the range — which is ' +
      'why everyday life feels Newtonian — and then it goes vertical. The wall at c is not a ' +
      'technological limit; it is this curve. The chart is Bento’s own engine, and it stays live in ' +
      'present mode: hover a point for its value.',
    elements: [
      ...furniture('THE RESULT'),
      title('Flat, flat, flat — then a wall.', { y: 116, fontSize: 44 }),
      chart({
        id: 'lc-chart', x: 96, y: 200, w: 700, h: 400, preset: 'line',
        option: {
          grid: { left: 52, right: 20, top: 26, bottom: 44 },
          // EVEN 0.05 steps. A category axis spaces its entries equally, so
          // sampling 0.9, 0.95, 0.99 would draw the last stretch of the curve
          // three times too wide and misrepresent the very shape the slide is
          // about. Every other label is blanked instead of thinning the data.
          xAxis: { type: 'category', name: 'v / c',
            data: ['0', '', '0.1', '', '0.2', '', '0.3', '', '0.4', '', '0.5', '',
              '0.6', '', '0.7', '', '0.8', '', '0.9', ''] },
          yAxis: { type: 'value', name: 'γ', min: 0, max: 3.5 },
          tooltip: { trigger: 'item', formatter: 'γ = {c}' },
          series: [{
            name: 'γ', type: 'line', smooth: true,
            data: [1, 1.001, 1.005, 1.011, 1.021, 1.033, 1.048, 1.068, 1.091, 1.12,
              1.155, 1.197, 1.25, 1.316, 1.4, 1.512, 1.667, 1.898, 2.294, 3.203],
          }],
        },
      }),
      shape('rect', { x: 836, y: 216, w: 348, h: 168, radius: 18, fill: CARD, stroke: LINE, strokeWidth: 1.5 }),
      text({ x: 864, y: 240, w: 292, h: 120,
        html: '<b>Half the speed of light</b> buys you a factor of only <b>1.15</b>. ' +
          'The last few per cent of the axis is where everything happens.',
        fontSize: 17, color: SOFT, lineHeight: 1.55 }),
      shape('rect', { x: 836, y: 408, w: 348, h: 192, radius: 18, fill: CARD, stroke: LINE, strokeWidth: 1.5 }),
      text({ x: 864, y: 432, w: 292, h: 30, html: 'AT 0.99c',
        fontSize: 11, fontWeight: 700, color: MIST, fontFamily: MONO, letterSpacing: 2 }),
      text({ x: 864, y: 460, w: 292, h: 60, html: '7.09',
        fontSize: 52, fontWeight: 700, color: CYAN, fontFamily: MONO, fx: { enter: 'fade', countUp: true, order: 2 } }),
      text({ x: 864, y: 528, w: 292, h: 56, html: 'One year aboard, seven years at home.',
        fontSize: 16, color: SOFT, lineHeight: 1.5 }),
    ],
  }))

  // ── 17 · the numbers ───────────────────────────────────────────────────
  slides.push(slide({
    id: 'lc-numbers', background: PAPER, transition: 'fade',
    notes:
      'And it is measured, constantly, by things people rely on. The GPS row is the one to dwell on: ' +
      'special relativity slows the satellite clock by about 7 microseconds a day, general relativity ' +
      'speeds it up by about 46, and the receivers correct for the net 38. Get it wrong and your ' +
      'position drifts by kilometres within a day.',
    elements: [
      kicker('THE EVIDENCE', '#1C6E67'),
      shape('rect', { id: K_RULE, x: 96, y: 84, w: 1088, h: 1, fill: 'rgba(10,18,38,0.14)' }),
      pageNo('rgba(10,18,38,0.45)'),
      title('This is not a thought experiment.', { y: 112, fontSize: 42, color: PAPER_INK }),
      table({
        x: 96, y: 200, w: 1088, h: 300,
        columns: [{ w: 1.5 }, { w: 1 }, { w: 1 }, { w: 1.7 }],
        rows: [
          { cells: [{ html: 'Moving thing' }, { html: 'v / c' }, { html: 'γ' }, { html: 'What it costs' }] },
          { cells: [{ html: 'You, on a motorway' }, { html: '0.00000009' }, { html: '1 + 4×10⁻¹⁸' }, { html: 'a nanosecond per lifetime' }] },
          { cells: [{ html: 'GPS satellite' }, { html: '0.0000129' }, { html: '1 + 8.3×10⁻¹¹' }, { html: '7 µs slow per day' }] },
          { cells: [{ html: 'The ISS' }, { html: '0.0000256' }, { html: '1 + 3.3×10⁻¹⁰' }, { html: '0.01 s per year' }] },
          { cells: [{ html: 'Cosmic-ray muon' }, { html: '0.998' }, { html: '15.8', bold: true }, { html: 'lives 15.8× longer' }] },
          { cells: [{ html: 'LHC proton' }, { html: '0.999999991' }, { html: '6 930', bold: true }, { html: 'a second becomes two hours' }] },
        ],
        style: {
          headerBg: '#0A1226', headerColor: '#EDF2FF', zebra: true,
          borderColor: 'rgba(10,18,38,0.14)', borderWidth: 1,
          cellPadX: 20, cellPadY: 14, fontSize: 17, fontFamily: MONO, color: PAPER_INK, radius: 14,
        },
      }),
      shape('rect', { x: 96, y: 528, w: 6, h: 96, radius: 3, fill: '#1C6E67' }),
      text({ x: 124, y: 528, w: 1000, h: 100,
        html: 'GPS is the one that pays rent. Motion slows each satellite clock ~7 µs/day; ' +
          'weaker gravity up there speeds it ~46 µs/day. The receivers correct the net ~38 µs — ' +
          'skip it and your position drifts by <b>kilometres within a day</b>.',
        fontSize: 18, color: 'rgba(10,18,38,0.72)', lineHeight: 1.6 }),
    ],
  }))

  // ── 18 · the muon ──────────────────────────────────────────────────────
  slides.push(slide({
    id: 'lc-muon', background: DEEP, transition: 'fade',
    notes:
      'The cleanest demonstration is falling on you right now. Muons are made about 15 km up, and ' +
      'they live 2.2 microseconds. Even at 0.998c that is 660 metres — they should all be gone long ' +
      'before sea level. They arrive in numbers, because their internal clock runs slow by a factor ' +
      'of 15.8, which turns 660 metres into about 10 kilometres.',
    elements: [
      ...furniture('THE EVIDENCE'),
      title('Something is raining through you.', { y: 116, fontSize: 44 }),
      note('note_muon', { x: 96, y: 200, w: 1088, h: 116, fontSize: 19 }),
      // Two boxes, side by side, sized so the two formulas render at the SAME
      // type height — the longer one simply gets the wider box. Fitting both
      // into equal boxes would shrink the long one until it was unreadable.
      shape('rect', { x: 96, y: 336, w: 420, h: 130, radius: 18,
        fill: 'rgba(20,30,61,0.55)', stroke: LINE, strokeWidth: 1.5 }),
      text({ x: 120, y: 356, w: 372, h: 26, html: 'WITHOUT TIME DILATION',
        fontSize: 11, fontWeight: 700, color: MIST, fontFamily: MONO, letterSpacing: 2 }),
      equation('muonflat', { id: 'lc-eq-muonflat', cx: 306, cy: 418, px: 20, color: SOFT }),
      shape('rect', { x: 544, y: 336, w: 640, h: 130, radius: 18, fill: CARD,
        stroke: 'rgba(95,227,218,0.4)', strokeWidth: 1.5 }),
      text({ x: 568, y: 356, w: 592, h: 26, html: 'WITH IT',
        fontSize: 11, fontWeight: 700, color: CYAN, fontFamily: MONO, letterSpacing: 2 }),
      equation('muon', { id: 'lc-eq-muon', cx: 864, cy: 418, px: 18, color: CYAN }),
      shape('rect', { x: 96, y: 500, w: 1088, h: 104, radius: 18, fill: 'rgba(95,227,218,0.08)' }),
      text({ x: 124, y: 522, w: 1032, h: 70,
        html: 'They should die 14 km overhead. They reach the ground — and they reach it because ' +
          'their clock, like the light clock, runs slow. Same triangle, no mirrors involved.',
        fontSize: 19, color: SOFT, lineHeight: 1.6 }),
    ],
  }))

  // ── 19 · close ─────────────────────────────────────────────────────────
  slides.push(slide({
    id: 'lc-close', background: VOID, transition: 'fade',
    notes:
      'To recap: one experimental fact, one triangle, eight lines of algebra. No advanced mathematics ' +
      'appears anywhere — the hardest step is squaring a bracket. That is what makes it the best ' +
      'possible first derivation in physics, and a good test of a slide tool: if your deck can show ' +
      'the algebra MOVING, the audience follows it. Press Esc to open the editor and take the ' +
      'equations apart — the LaTeX is right there in the panel.',
    elements: [
      shape('ellipse', { x: 806, y: 30, w: 660, h: 660, fill: 'rgba(157,140,255,0.07)' }),
      ...furniture('ONE TRIANGLE'),
      title('That is the whole thing.', { y: 178, fontSize: 76, w: 900 }),
      shape('rect', { x: 96, y: 322, w: 96, h: 4, radius: 2, fill: CYAN }),
      text({ x: 96, y: 366, w: 500, h: 200,
        html: '<b>One fact:</b> light’s speed is the same for everyone.<br>' +
          '<b>One picture:</b> a right triangle.<br>' +
          '<b>Eight lines:</b> nothing harder than squaring a bracket.<br><br>' +
          'Everything else — twins, mass–energy, the speed limit — is downstream of this slide.',
        fontSize: 19, color: SOFT, lineHeight: 1.7 }),
      shape('rect', { x: 664, y: 366, w: 520, h: 200, radius: 18, fill: CARD, stroke: LINE, strokeWidth: 1.5 }),
      text({ x: 692, y: 390, w: 464, h: 30, html: 'ABOUT THIS DECK',
        fontSize: 11, fontWeight: 700, color: CYAN, fontFamily: MONO, letterSpacing: 2 }),
      text({ x: 692, y: 420, w: 464, h: 130,
        html: 'Every formula is a Bento <b>math element</b> — real LaTeX in the file, baked to SVG so ' +
          'presenting needs no engine and no network. The derivation morphs <b>symbol by symbol</b>. ' +
          'Press <b>Esc</b> and edit any equation in the panel.',
        fontSize: 17, color: SOFT, lineHeight: 1.6 }),
      shape('ellipse', {
        id: 'lc-photon', x: 1140, y: 150, w: 22, h: 22, fill: AMBER,
        shadow: { y: 0, blur: 22, color: 'rgba(255,180,84,0.9)' },
        fx: { loop: { type: 'motion-path', path: 'M0,0 L0,120 L0,0', duration: 2.4 } },
      }),
    ],
  }))

  return {
    format: 'bento/slides', version: 1,
    title: 'The Light Clock — special relativity in eight steps',
    size: { width: 1280, height: 720 },
    meta: {
      author: 'Built with Bento',
      subject: 'Special relativity — time dilation derived from the light clock',
      keywords: 'physics, special relativity, time dilation, Lorentz factor, math morph',
    },
    theme: {
      background: DEEP, color: INK, accent: CYAN, fontFamily: BODY,
      chartPalette: [CYAN, AMBER, VIOLET],
    },
    assets: {
      'font-fraunces': fontConst('FRAUNCES_900'),
      'font-instrument': fontConst('INSTRUMENT_VAR'),
      'font-mono': fontFile('SpaceMono-400-latin.woff2'),
      'font-mono-bold': fontFile('SpaceMono-700-latin.woff2'),
    },
    fonts: [
      { family: 'Fraunces', asset: 'font-fraunces', weight: '900' },
      { family: 'Instrument Sans', asset: 'font-instrument', weight: '100 900' },
      { family: 'Space Mono', asset: 'font-mono', weight: '400' },
      { family: 'Space Mono', asset: 'font-mono-bold', weight: '700' },
    ],
    slides,
    modified: new Date().toISOString(),
  }
}

// ——— splice + write ————————————————————————————————————————————————
const outDir = process.argv[2] ?? join(root, 'working')
mkdirSync(outDir, { recursive: true })
const deck = buildDeck()
const json = JSON.stringify(deck).replace(/</g, '\\u003c')
const blockRe = /<script type="application\/bento\+json" id="bento-doc">[\s\S]*?<\/script>/
const out = shell.replace(blockRe, `<script type="application/bento+json" id="bento-doc">\n${json}\n</scr` + 'ipt>')
if (!out.includes(json)) throw new Error('splice failed')
const file = join(outDir, 'The_Light_Clock.bento.html')
writeFileSync(file, out)
console.log(`${file} — ${deck.slides.length} slides, ${Math.round(out.length / 1024)} KB`)
