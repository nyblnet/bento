// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The starter deck — what a freshly built bento/slides file opens with.
//
// It is the product demo, the launch asset and the feature tour in one: every
// claim it makes is proven by the feature making it. A cast of four "bento
// tiles" (a amber, b blue, c paper, d ink) carries the SAME element ids
// through every slide, so each transition morphs them — position, size,
// color, solid⇄gradient. One deliberate 'fade' beat (the stats slide) exists
// because entrance staggers + count-ups only run on non-morph entries.
//
// Art direction: ink #0F1724 and warm paper #F6F4EF grounds with a dotted
// texture, Fraunces Black for display (embedded, OFL), Instrument Sans for
// everything else (embedded variable, OFL). Editorial furniture on content
// slides — tracked kicker top-left, index numeral top-right, hairline rule —
// plus 300px ghost numerals on paper slides. Cards are 1px-stroked panels.
// Never let system-font defaults show: every text sets a face on purpose.

import {
  newDoc, uid, defaultText, defaultShape, defaultChart, defaultTable, defaultCode,
  type BentoDoc, type Slide, type SlideElement, type TextElement, type ShapeElement,
  type SvgElement, type TableElement, type FrameLayout,
} from './model.ts'
import { derive } from './derive.ts'
import { paletteOf, resolveRef } from './palette.ts'

/** Display face — the shell's own (fonts.ts BUILTIN_FONTS), named by the deck, not embedded. */
const DISPLAY = "'Fraunces', Georgia, serif"
/** Text face — embedded variable sans. */
const BODY = "'Instrument Sans', -apple-system, 'Segoe UI', Helvetica, sans-serif"

const INK = '#0D1B2E'
const PANEL = '#16273E'
const PAPER = '#F2F0EA'
// Midnight & peach: deep navy-ink ground, one luminous peach accent, muted
// steel-blue support. Warm-on-cool, nothing like default chart colors.
const PEACH = '#FF9E8A'
const PEACH_SOFT = '#FFBCA8'
const PEACH_DEEP = '#C25A43'
const STEEL = '#5E7699'
const STEEL_SOFT = '#8FA3BF'
const MIST = '#B6C1D2'
const TILE_PAPER = '#EFECE3'

// gradient-lit tile fills (light falls from above) — kills the flat-vector look
const GRAD_PEACH = { angle: 0, stops: [{ at: 0, color: '#ED8266' }, { at: 1, color: '#FFB29B' }] }
const GRAD_STEEL = { angle: 0, stops: [{ at: 0, color: '#48607F' }, { at: 1, color: '#7089A8' }] }
const GRAD_PAPER = { angle: 0, stops: [{ at: 0, color: '#DDD9CD' }, { at: 1, color: '#F6F3EB' }] }
const GRAD_CARD = { angle: 0, stops: [{ at: 0, color: '#101F33' }, { at: 1, color: '#1D3049' }] }
const INK_SOFT = 'rgba(20, 34, 54, 0.75)'
const CARD_STROKE = '#E7E1D2'
const GLASS = 'rgba(255, 255, 255, 0.09)'

// the morphing cast — same ids on every slide
const T_A = 'sd-tile-a' // amber
const T_B = 'sd-tile-b' // blue
const T_C = 'sd-tile-c' // paper/white
const T_D = 'sd-tile-d' // ink panel / card
/** The formula that rearranges across the morph beat — one id, two slides. */
const EQ = 'sd-eq'
const CODE_ID = 'sd-code'
const TITLE = 'sd-title'
const KICKER = 'sd-kicker'
const GLOW = 'sd-glow'
const CHART_MAIN = 'sd-main-chart'

const S_CHARTS = 'sd-s-charts'
const S_CHARTS_PIE = 'sd-s-charts-pie'
const S_CHARTS_SCATTER = 'sd-s-charts-scatter'
const S_CHOREO = 'sd-s-choreo'
const S_CHOREO_2 = 'sd-s-choreo-2'
const S_CHOREO_3 = 'sd-s-choreo-3'

// --- design tokens ----------------------------------------------------------
// The deck's colours, gaps and radii as named tokens (Tokens tab). An element
// keeps its literal and records the token in themeRefs; derive() at the end of
// starterDoc() writes every bound literal from its token, so the two can never
// disagree in the shipped deck.

const num = (v: number) => ({ type: 'number' as const, values: { default: v } })
const shadow = (y: number, blur: number, color: string) => ({ type: 'shadow' as const, values: { default: { y, blur, color } } })
const TOKENS: NonNullable<BentoDoc['theme']['tokens']>['set'] = {
  // corners: five steps; a pill is the largest radius, which a rect clamps to half its height
  'radius.xs': num(3),
  'radius.sm': num(8),
  'radius.md': num(14),
  'radius.lg': num(20),
  'radius.pill': num(26),
  // borders
  'border.hairline': num(1),
  'border.card': num(1.5),
  'border.line': num(2.5),
  // spacing
  'space.gap': num(16),
  'space.pad': num(24),
  'space.cards': num(40),
  // elevation
  'shadow.card': shadow(14, 34, 'rgba(30,42,58,0.10)'),
  'shadow.panel': shadow(14, 34, 'rgba(30,42,58,0.18)'),
  'shadow.float': shadow(10, 26, 'rgba(0,0,0,0.4)'),
  // type
  'font.display': { type: 'fontFamily', values: { default: DISPLAY } },
  'font.body': { type: 'fontFamily', values: { default: BODY } },
  'font.mono': { type: 'fontFamily', values: { default: defaultCode({}).fontFamily } },
  'size.kicker': { type: 'fontSize', values: { default: 13 } },
}
/**
 * The deck's colours are its THEME (Tokens ▸ Theme), not tokens: seven slots,
 * and every other shade is a slot shifted in lightness (`accent2 -19%`), so
 * re-colouring a slot carries its tints, gradients and glows with it.
 * FAMILY says which slot each authored colour belongs to; the shift that
 * reproduces it best is found at build time: within 8 RGB units, except
 * the glow and one steel (11) and the deepest peach gradient stop (18). White and black are not brand
 * colours and stay literal; fully transparent paints have nothing to theme.
 */
const THEME = { bg1: PAPER, tx1: INK, bg2: PANEL, tx2: MIST, accent1: PEACH, accent2: STEEL, accent3: PEACH_DEEP }
const FAMILY: Record<keyof typeof THEME, string[]> = {
  bg1: [PAPER, '#F6F3EB', '#DDD9CD', '#D8D3C6', TILE_PAPER, CARD_STROKE],
  tx1: [INK, '#0F1724', '#142236'],
  bg2: [PANEL, '#101F33', '#1D3049', '#22344E'],
  // the greyer slates (table text, paper-slide shadows and rules) are mist darkened
  tx2: [MIST, '#B9C4D4', '#DCE3EC', '#E6EDF7', '#1E2A3A', '#26303E'],
  accent1: [PEACH, PEACH_SOFT, '#FFB29B', '#ED8266', '#FFF0DC'],
  accent2: [STEEL, STEEL_SOFT, '#7089A8', '#48607F', '#41597A', '#3E5678'],
  accent3: [PEACH_DEEP],
}

/** Numbers, shadows and fonts that snap onto a token (radii and borders onto their step). */
const STEP: Record<string, Record<number, string>> = {
  radius: { 2: 'radius.xs', 3: 'radius.xs', 6: 'radius.sm', 8: 'radius.sm', 9: 'radius.sm', 12: 'radius.md', 14: 'radius.md', 16: 'radius.md', 18: 'radius.lg', 20: 'radius.lg', 15: 'radius.pill', 22: 'radius.pill', 26: 'radius.pill' },
  strokeWidth: { 1: 'border.hairline', 1.5: 'border.card', 2: 'border.line', 2.5: 'border.line', 3: 'border.line' },
  space: { 16: 'space.gap', 24: 'space.pad', 40: 'space.cards' },
}

/** Bind every colour to the theme and every recurring number, shadow and font to a token. */
function bindTheme(doc: BentoDoc) {
  const rgb = (c: string): { hex: string; a: number } | null => {
    const h = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c)
    if (h) return { hex: `#${h[1].toLowerCase()}`, a: h[2] ? parseInt(h[2], 16) / 255 : 1 }
    const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c)
    if (!m) return null
    return { hex: '#' + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join(''), a: m[4] === undefined ? 1 : +m[4] }
  }
  const far = (a: string, b: string) => { const [x, y] = [rgb(a)!.hex, rgb(b)!.hex].map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) }
  const palette = paletteOf(doc)
  const ref = new Map<string, string>()
  for (const [slot, hexes] of Object.entries(FAMILY)) for (const hex of hexes) {
    let best = { r: slot, d: far(hex, THEME[slot as keyof typeof THEME]) }
    for (let n = 1; n <= 100; n++) for (const sign of ['+', '-']) {
      const r = `${slot} ${sign}${n}%`
      const d = far(hex, resolveRef(r, palette)!)
      if (d < best.d) best = { r, d }
    }
    ref.set(hex.toLowerCase(), best.r)
  }
  const colorRef = (c: unknown) => {
    const p = typeof c === 'string' ? rgb(c) : null
    return p && p.a > 0 ? ref.get(p.hex) : undefined
  }
  const bind = (holder: SlideElement | Slide, path: string, r: string | undefined) => {
    const h = holder as { themeRefs?: Record<string, string> }
    if (r && !h.themeRefs?.[path]) (h.themeRefs ??= {})[path] = r
  }
  const tokenRef = (name: string | undefined) => (name ? `$${name}` : undefined)
  const shadows = Object.entries(TOKENS).filter(([, t]) => t.type === 'shadow')
  const sameShadow = (a: any, b: any) => (a.x ?? 0) === (b.x ?? 0) && a.y === b.y && a.blur === b.blur && a.color === b.color
  for (const s of doc.slides) {
    bind(s, 'background', colorRef(s.background))
    for (const el of s.elements) {
      const e = el as SlideElement & Record<string, any>
      for (const k of ['fill', 'stroke', 'color']) bind(el, k, colorRef(e[k]))
      e.fillGradient?.stops?.forEach((st: { color: string }, i: number) => bind(el, `fillGradient.stops.${i}.color`, colorRef(st.color)))
      if (Array.isArray(e.shadow)) e.shadow.forEach((sh: { color: string }, i: number) => bind(el, `shadow.${i}.color`, colorRef(sh.color)))
      else if (e.shadow) {
        const hit = shadows.find(([, t]) => sameShadow(e.shadow, t.values.default))
        bind(el, hit ? 'shadow' : 'shadow.color', hit ? tokenRef(hit[0]) : colorRef(e.shadow.color))
      }
      if (e.type === 'table') for (const k of ['headerBg', 'headerColor', 'zebra', 'borderColor', 'color']) bind(el, `style.${k}`, colorRef((e.style as unknown as Record<string, unknown> | undefined)?.[k]))
      if (e.strokeWidth) bind(el, 'strokeWidth', tokenRef(STEP.strokeWidth[e.strokeWidth]))
      if (e.radius && e.type === 'shape') bind(el, 'radius', tokenRef(STEP.radius[e.radius]))
      const font = Object.entries(TOKENS).find(([, t]) => t.type === 'fontFamily' && t.values.default === e.fontFamily)
      if (font) bind(el, 'fontFamily', tokenRef(font[0]))
      if (e.layout) {
        bind(el, 'layout.gap', tokenRef(STEP.space[e.layout.gap]))
        e.layout.pad.forEach((n: number, i: number) => bind(el, `layout.pad.${i}`, tokenRef(STEP.space[n])))
      }
    }
  }
}

/** Editor group (⌘G): the members select and move as one, named in Layers. */
function group<T extends SlideElement>(name: string, els: T[]): T[] {
  const groupId = uid('grp')
  for (const el of els) Object.assign(el, { groupId, groupName: name })
  return els
}

/** An auto-layout frame: a rect whose children (parentId) it places. */
const frame = (layout: Partial<FrameLayout>, p: Partial<ShapeElement>): ShapeElement =>
  shape('rect', { fill: 'transparent', radius: 0, ...p, layout: { dir: 'row', gap: 0, pad: [0, 0, 0, 0], ...layout } })

/** Put `kids` inside `f` (they must follow it in the slide's element array). */
const inFrame = <T extends SlideElement>(f: SlideElement, kids: T[], sizing?: SlideElement['sizing']): T[] =>
  kids.map((k) => Object.assign(k, { parentId: f.id }, sizing ? { sizing } : {}))

/**
 * Components: `main` is the master (Tokens tab ▸ Components); a copy is the
 * same elements with its own ids and groupId, re-derived from the main on
 * every change except the keys it overrides. Override by simply writing a
 * different value — the first derive pass reads that as a local edit and
 * records it in `component.over`.
 */
function makeMain<T extends SlideElement>(compId: string, name: string, els: T[]): T[] {
  const groupId = uid('grp')
  els.forEach((el, i) => Object.assign(el, { groupId, groupName: name, component: { id: compId, key: `k${i}`, main: true } }))
  return els
}
function copyOf<T extends SlideElement>(main: T[], dx: number, dy: number, edit: (els: T[]) => void, own?: string[]): T[] {
  const groupId = uid('grp')
  // `own`: fixed ids for the copy's members — the same ids as on a neighbouring
  // slide is what makes a copy morph
  const ids = new Map(main.map((m, i) => [m.id, own?.[i] ?? uid('el')]))
  const els = main.map((m) => {
    const el = JSON.parse(JSON.stringify(m)) as T & { component: NonNullable<SlideElement['component']> }
    el.id = ids.get(m.id)!
    el.groupId = groupId
    if (el.parentId && ids.has(el.parentId)) el.parentId = ids.get(el.parentId)
    else { delete el.parentId; delete el.sizing }
    el.x += dx; el.y += dy
    el.component = { id: el.component.id, key: el.component.key, off: [dx, dy] }
    return el
  })
  edit(els)
  return els
}

// --- builders ---------------------------------------------------------------

const text = (p: Partial<TextElement>): TextElement =>
  ({ ...defaultText({ align: 'left', valign: 'top', fontFamily: BODY }), ...p }) as TextElement

const shape = (kind: Parameters<typeof defaultShape>[0], p: Partial<ShapeElement>): ShapeElement =>
  ({ ...defaultShape(kind), stroke: 'transparent', strokeWidth: 0, ...p }) as ShapeElement

const kicker = (label: string, p: Partial<TextElement> = {}): TextElement =>
  text({
    id: KICKER, name: 'Kicker', role: 'kicker', x: 96, y: 54, w: 700, h: 26, html: label,
    fontSize: 13, fontWeight: 700, color: PEACH, letterSpacing: 4, ...p,
    themeRefs: { fontSize: '$size.kicker' },
  })

const title = (html: string, p: Partial<TextElement> = {}): TextElement =>
  text({
    id: TITLE, name: 'Title', role: 'title', x: 92, y: 112, w: 1000, h: 92, html,
    fontSize: 54, fontWeight: 900, fontFamily: DISPLAY, color: INK, lineHeight: 1.06, ...p,
  })

/** Content-slide furniture: auto page numeral ({{page}}) + hairline rule.
 *  The {{page:2}} field re-numbers itself as slides are inserted/removed. */
const furniture = (dark: boolean): SlideElement[] => group('Slide furniture', [
  text({
    name: 'Page number', x: 1024, y: 54, w: 160, h: 26, html: '{{page:2}}', align: 'right',
    fontSize: 13, fontWeight: 700, letterSpacing: 2,
    color: dark ? 'rgba(185,196,212,0.5)' : 'rgba(30,42,58,0.4)',
  }),
  shape('rect', {
    name: 'Rule', x: 96, y: 86, w: 1088, h: 1.5, radius: 0,
    fill: dark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,36,0.12)',
  }),
])

/** 300px ghost numeral (paper slides) — editorial depth, sits behind content.
 *  Also the auto page number, so it can never drift out of sync. */
const ghost = (): TextElement =>
  text({
    name: 'Ghost numeral', x: 780, y: -30, w: 420, h: 340, html: '{{page:2}}', align: 'right',
    fontSize: 300, fontWeight: 900, fontFamily: DISPLAY, color: 'rgba(13,27,46,0.05)',
  })

const dots = (dark: boolean, fx?: SvgElement['fx']): SvgElement => ({
  id: uid('sv'), name: 'Dot texture', type: 'svg', x: 0, y: 0, w: 1280, h: 720, rotation: 0, opacity: 1,
  asset: dark ? 'dots-ink' : 'dots-paper', ...(fx ? { fx } : {}),
})

/**
 * Seamless closed-loop drift path: a circle of radius r through the element's
 * rest position. `phase` (degrees) rotates the starting point around the loop
 * so a field of drifters de-syncs WITHOUT start delays — everything moves
 * from the first frame (tween delays left particles frozen at entry).
 */
const floatPath = (r: number, phase = 0): string => {
  const h = r * 0.5523
  const a0 = ((phase - 90) * Math.PI) / 180
  const C = { x: -r * Math.cos(a0), y: -r * Math.sin(a0) }
  const P = (a: number) => ({ x: C.x + r * Math.cos(a), y: C.y + r * Math.sin(a) })
  const T = (a: number) => ({ x: -Math.sin(a), y: Math.cos(a) })
  const f = (n: number) => Math.round(n * 10) / 10
  let d = 'M 0 0'
  for (let k = 0; k < 4; k++) {
    const aA = a0 + (k * Math.PI) / 2
    const aB = a0 + ((k + 1) * Math.PI) / 2
    const A = P(aA), B = P(aB), tA = T(aA), tB = T(aB)
    d += ` C ${f(A.x + h * tA.x)} ${f(A.y + h * tA.y)} ${f(B.x - h * tB.x)} ${f(B.y - h * tB.y)} ${f(B.x)} ${f(B.y)}`
  }
  return d
}

/** Soft aurora blob — svg radial-gradient glow (edge-free), breathing on ken drift. */
const aurora = (
  x: number, y: number, size: number, asset: string, dur: number,
  roam = 0, roamDur = 50, delay = 0,
): SvgElement => ({
  id: uid('sv'), name: 'Aurora', type: 'svg', x, y, w: size, h: size, rotation: 0, opacity: 1, asset,
  fx: {
    ambient: 'kenburns', ken: { dir: 'drift', scale: 1.22, duration: dur },
    ...(roam ? { loop: { type: 'motion-path' as const, path: floatPath(roam, (delay / roamDur) * 360), duration: roamDur } } : {}),
  },
})

/** Out-of-focus light speck (blurred svg disc) adrift on a slow closed loop. */
const bokeh = (
  x: number, y: number, s: number, warm: boolean, opacity: number,
  r: number, dur: number, stagger = 0,
): SvgElement => ({
  id: uid('sv'), name: warm ? 'Bokeh · warm' : 'Bokeh · cool', type: 'svg', x, y, w: s, h: s, rotation: 0, opacity,
  asset: warm ? 'bokeh-warm' : 'bokeh-cool',
  fx: { loop: { type: 'motion-path', path: floatPath(r, (stagger / dur) * 360), duration: dur } },
})

/** Film grain for ink grounds (feTurbulence) — texture without a visible grid. */
const grain = (): SvgElement => ({
  id: uid('sv'), name: 'Film grain', type: 'svg', x: 0, y: 0, w: 1280, h: 720, rotation: 0, opacity: 1,
  asset: 'grain',
})

const glow = (angle: number, stops: Array<{ at: number; color: string }>): ShapeElement =>
  shape('rect', {
    id: GLOW, name: 'Glow', x: 0, y: 0, w: 1280, h: 720, radius: 0,
    fill: 'transparent', fillGradient: { angle, stops },
    fx: { ambient: 'kenburns', ken: { dir: 'drift', scale: 1.06, duration: 34 } },
  })

/**
 * The bento logo from the cast, as nested auto layout: the ink panel (T_D) is
 * a row frame; T_B fills its height beside a column frame stacking T_A over
 * T_C, which fills what is left. Resize the panel and the tiles re-derive.
 */
function logo(
  x: number, y: number, size: number, pad: number, radius: number, tileR: number, bw: number, ah: number,
  extra: Partial<Record<'a' | 'b' | 'c' | 'd', Partial<ShapeElement>>> = {},
): SlideElement[] {
  const d = frame({ dir: 'row', gap: 16, pad: [pad, pad, pad, pad], align: 'stretch' }, {
    id: T_D, name: 'Logo', x, y, w: size, h: size, radius, fill: PANEL, fillGradient: GRAD_CARD, ...extra.d,
  })
  const inner = size - 2 * pad
  const b = shape('rect', { id: T_B, name: 'Tile · steel', x: x + pad, y: y + pad, w: bw, h: inner, radius: tileR, fill: STEEL, fillGradient: GRAD_STEEL, ...extra.b })
  const col = frame({ dir: 'col', gap: 16, align: 'stretch' }, {
    id: 'sd-logo-col', name: 'Logo column', x: x + pad + bw + 16, y: y + pad, w: inner - bw - 16, h: inner,
  })
  const a = shape('rect', { id: T_A, name: 'Tile · peach', x: col.x, y: col.y, w: col.w, h: ah, radius: tileR, fill: PEACH, fillGradient: GRAD_PEACH, ...extra.a })
  const c = shape('rect', { id: T_C, name: 'Tile · paper', x: col.x, y: col.y + ah + 16, w: col.w, h: inner - ah - 16, radius: tileR, fill: TILE_PAPER, fillGradient: GRAD_PAPER, ...extra.c })
  return [d, ...inFrame(d, [b, col]), ...inFrame(col, [a]), ...inFrame(col, [c], { h: 'fill' })]
}

/**
 * The symbol-morph pair: two groups, "Maths" and "Code", each a column label
 * over its content. The formula and the code keep their ids (EQ, CODE_ID)
 * across the three slides, which is what makes them morph token by token.
 */
function mathsAndCode(formula: string, code: string): SlideElement[] {
  const label = (x: number, w: number, html: string) => text({
    name: 'Column label', x, y: 186, w, h: 24, html,
    fontSize: 13, fontWeight: 700, letterSpacing: 1.5, color: 'rgba(185,196,212,0.62)', align: 'left', valign: 'middle',
  })
  return [
    ...group('Maths', [
      label(96, 480, 'MATHS \u2014 plain <b>\\$\u2026\\$</b> in a text box'),
      // display mode so fractions and the radical set at full size
      text({ id: EQ, name: 'Formula', x: 96, y: 226, w: 480, h: 280, html: formula, fontSize: 30, color: '#FFFFFF', align: 'center', valign: 'middle' }),
    ]),
    ...group('Code', [
      label(640, 544, 'CODE \u2014 <b>77 languages</b> built in'),
      {
        ...defaultCode({ id: CODE_ID, x: 640, y: 226, w: 544, h: 280 }),
        name: 'Code', content: code, grammarName: 'js', fontSize: 19, lineHeight: 1.62, color: '#DCE3EC',
        align: 'left', valign: 'middle',
      },
    ]),
  ]
}

/**
 * The chart slide's body, shared by the slide and its two hidden states: a
 * white card frame the chart fills (24 padding all round), and an ink side
 * panel frame — accent bar, text that takes the free height, and a "Button"
 * component pinned to the foot. The ids repeat across the three slides, so
 * card, chart, panel and button morph in place while the chart changes form.
 */
function chartPanel(option: Record<string, unknown>, preset: string, html: string, label: string, link: string): SlideElement[] {
  const card = frame({ dir: 'row', pad: [24, 24, 24, 24] }, {
    id: T_C, name: 'Chart card', x: 72, y: 196, w: 828, h: 458, radius: 20, fill: '#FFFFFF',
    stroke: CARD_STROKE, strokeWidth: 1.5, shadow: { y: 14, blur: 34, color: 'rgba(30,42,58,0.10)' },
  })
  const chart = { ...defaultChart(option), id: CHART_MAIN, name: 'Chart', x: 96, y: 220, w: 780, h: 410, preset } as SlideElement
  const panel = frame({ dir: 'col', gap: 20, pad: [24, 24, 24, 24] }, {
    id: T_D, name: 'Side panel', x: 920, y: 196, w: 264, h: 458, fill: PANEL, shadow: { y: 14, blur: 34, color: 'rgba(30,42,58,0.18)' },
  })
  const bar = shape('rect', { id: T_A, name: 'Accent bar', x: 944, y: 220, w: 44, h: 6, radius: 3, fill: PEACH })
  const body = text({
    name: 'Panel text', x: 944, y: 246, w: 216, h: 312, html, fontSize: 16.5, fontWeight: 500, color: MIST, lineHeight: 1.7,
  })
  const button = BUTTON.at(920 + 24, 196 + 458 - 24 - 52, label, link, T_D)
  return [card, ...inFrame(card, [chart], { w: 'fill', h: 'fill' }), panel, ...inFrame(panel, [bar]), ...inFrame(panel, [body], { w: 'fill', h: 'fill' }), ...button]
}

/**
 * The deck's one button, a component: the main is the first one built (the
 * chart slide's); every later call is a copy that overrides only its label —
 * or, through `look`, its paint (the choreography slides' peach variant).
 * The invisible hit rect above it carries the link (hard-won detail #7) and
 * is lined up with the laid-out button after derive (alignHits).
 */
const BUTTON = {
  main: null as SlideElement[] | null,
  reset() { this.main = null },
  at(x: number, y: number, label: string, link: string | null, parent?: string,
    ids: [string, string, string] = [T_B, 'sd-btn-label', 'sd-hit-charts'],
    look?: (pill: ShapeElement, text: TextElement) => void): SlideElement[] {
    const hit = shape('rect', { id: ids[2], name: 'Hit area', x, y, w: 216, h: 52, radius: 26, fill: 'rgba(0,0,0,0)', link: link ?? undefined })
    let els: SlideElement[]
    if (!this.main) {
      const pill = frame({ dir: 'row', justify: 'center', align: 'center' }, {
        id: ids[0], name: 'Button', x, y, w: 216, h: 52, radius: 26, fill: STEEL, fillGradient: GRAD_STEEL,
        stroke: 'rgba(255,255,255,0.18)', strokeWidth: 1,
      })
      const t = text({ id: ids[1], name: 'Label', x, y: y + 14, w: 216, h: 24, html: label, fontSize: 17, fontWeight: 700, color: '#FFFFFF', align: 'center', valign: 'middle' })
      els = this.main = makeMain('sd-cmp-button', 'Button', [pill, ...inFrame(pill, [t], { w: 'fill' })])
    } else {
      const m = this.main
      els = copyOf(m, x - m[0].x, y - m[0].y, ([pill, t]) => {
        (t as TextElement).html = label
        look?.(pill as ShapeElement, t as TextElement)
      }, ids.slice(0, 2))
    }
    if (parent) els[0].parentId = parent
    return link ? [...els, hit] : els
  },
}

/** Each hit rect takes the box of the button it serves, once layout has placed it. */
function alignHits(doc: BentoDoc) {
  for (const s of doc.slides) for (const hit of s.elements) {
    if (hit.name !== 'Hit area') continue
    const i = s.elements.indexOf(hit)
    const btn = s.elements.slice(0, i).reverse().find((e) => e.component?.id === 'sd-cmp-button' && e.component.key === 'k0')
    if (btn) Object.assign(hit, { x: btn.x, y: btn.y, w: btn.w, h: btn.h })
  }
}

/** A milestone on the motion slide's flow: node + label, one named group. */
function milestone(name: string, x: number, y: number, size: number, fill: string, lx: number, ly: number, color: string): SlideElement[] {
  return group(`Milestone · ${name}`, [
    shape('ellipse', { name: 'Node', x, y, w: size, h: size, fill, stroke: INK, strokeWidth: 2.5 }),
    text({ name: 'Label', x: lx, y: ly, w: 160, h: 26, html: name.toUpperCase(), fontSize: 13, fontWeight: 700, letterSpacing: 1.5, color, align: 'center' }),
  ])
}

/**
 * Three feature cards: a row frame (gap = the space.cards token) holding three
 * copies of one "Feature card" component — a column frame of icon, heading
 * and body. Copies override their words, icon colour and hover group only.
 * The icon tiles keep the cast's ids, so the tiles morph into them.
 */
function featureCards(): SlideElement[] {
  const row = frame({ dir: 'row', gap: 40, align: 'stretch' }, { id: 'sd-cards', name: 'Feature cards', x: 96, y: 228, w: 1088, h: 336 })
  const card = (x: number, g: string) => frame({ dir: 'col', gap: 16, pad: [32, 32, 32, 32] }, {
    id: 'sd-card-0', name: 'Feature card', x, y: 228, w: 336, h: 336, fill: PANEL, stroke: GLASS, strokeWidth: 1, group: g,
  })
  const c = card(96, 'g-layout')
  const icon = shape('rect', { id: T_A, name: 'Icon', x: 128, y: 260, w: 52, h: 52, radius: 14, fill: PEACH, group: 'g-layout' })
  const head = text({ id: 'sd-card-head', name: 'Heading', x: 128, y: 328, w: 272, h: 32, html: 'Auto layout', fontSize: 21, fontWeight: 700, color: '#FFFFFF', group: 'g-layout' })
  const body = text({
    id: 'sd-card-body', name: 'Body', x: 128, y: 376, w: 272, h: 156, fontSize: 16, fontWeight: 500, color: MIST, lineHeight: 1.7, group: 'g-layout',
    html: 'This row is a frame. The cards fill it, 40px apart — drag one past another and they reflow.',
  })
  inFrame(row, [c], { w: 'fill' })
  inFrame(c, [icon]); inFrame(c, [head], { w: 'fill' }); inFrame(c, [body], { w: 'fill', h: 'fill' })
  const main = makeMain('sd-cmp-card', 'Feature card', [c, icon, head, body])
  const variant = (i: number, iconId: string, iconFill: string, g: string, h: string, b: string) =>
    copyOf(main, i * 376, 0, (els) => {
      els[0].parentId = row.id
      els[0].sizing = { w: 'fill' }
      for (const el of els) el.group = g
      ;(els[1] as ShapeElement).fill = iconFill; delete els[1].themeRefs
      ;(els[2] as TextElement).html = h
      ;(els[3] as TextElement).html = b
    }, [`sd-card-${i}`, iconId, `sd-card-head-${i}`, `sd-card-body-${i}`])
  return [
    row, ...main,
    ...variant(1, T_B, STEEL, 'g-comp', 'Components',
      'Three copies of one card. Edit the first and the others follow, keeping their own words.'),
    ...variant(2, T_C, TILE_PAPER, 'g-tokens', 'Tokens',
      'Colours, radii and gaps are named tokens. Change one in the Tokens tab and the whole deck follows.'),
  ]
}

/** A markdown-slide card: column frame, small tracked label, then the sample filling the rest. */
function mdCard(id: string, name: string, x: number, w: number, fill: string, label: string, labelColor: string, html: string, color: string, weight: number): SlideElement[] {
  const card = frame({ dir: 'col', gap: 22, pad: [28, 32, 32, 32] }, {
    id, name, x, y: 228, w, h: 372, radius: 18, fill,
    ...(fill === PANEL
      ? { shadow: { y: 12, blur: 30, color: 'rgba(30,42,58,0.16)' } }
      : { stroke: CARD_STROKE, strokeWidth: 1.5, shadow: { y: 12, blur: 30, color: 'rgba(30,42,58,0.10)' } }),
  })
  card
  return [card, ...inFrame(card, [
    text({ name: 'Label', x: x + 32, y: 256, w: w - 64, h: 22, html: label, fontSize: 12, fontWeight: 700, color: labelColor, letterSpacing: 3 }),
  ], { w: 'fill' }), ...inFrame(card, [
    text({ name: 'Sample', x: x + 32, y: 300, w: w - 64, h: 268, html, fontSize: 21, fontWeight: weight, color, lineHeight: 2.15 }),
  ], { w: 'fill', h: 'fill' })]
}

/** Title-slide key hints: a hugging row holding three copies of one component. */
function keyHints(): SlideElement[] {
  const row = frame({ dir: 'row', gap: 24, align: 'center', hug: true }, { id: 'sd-hints', name: 'Key hints', x: 96, y: 630, w: 400, h: 30 })
  const fx = { enter: 'fade' as const, order: 6 }
  const hint = frame({ dir: 'row', gap: 12, align: 'center', hug: true }, { id: 'sd-hint', name: 'Key hint', x: 96, y: 630, w: 138, h: 30 })
  const cap = frame({ dir: 'row', pad: [6, 8, 6, 8], hug: true }, {
    id: 'sd-hint-cap', name: 'Keycap', x: 96, y: 630, w: 36, h: 30, radius: 8, fill: 'rgba(255,255,255,0.055)',
    stroke: 'rgba(255,255,255,0.22)', strokeWidth: 1, fx,
  })
  const key = text({
    id: 'sd-hint-key', name: 'Key', x: 104, y: 636, w: 20, h: 18, html: '→', align: 'center',
    fontSize: 12.5, fontWeight: 600, color: 'rgba(230,237,247,0.85)', fx,
  })
  const label = text({
    id: 'sd-hint-label', name: 'Label', x: 144, y: 637, w: 90, h: 16, html: 'ADVANCE',
    fontSize: 11.5, fontWeight: 600, letterSpacing: 1.8, color: 'rgba(182,193,210,0.55)', fx,
  })
  inFrame(row, [hint]); inFrame(hint, [cap, label]); inFrame(cap, [key])
  const main = makeMain('sd-cmp-keyhint', 'Key hint', [hint, cap, key, label])
  const variant = (dx: number, k: string, kw: number, l: string, lw: number) =>
    copyOf(main, dx, 0, ([h, , kt, lb]) => {
      h.parentId = row.id
      Object.assign(kt, { html: k, w: kw })
      Object.assign(lb, { html: l, w: lw })
    })
  return [row, ...main, ...variant(162, 'ESC', 30, 'EDIT', 50), ...variant(294, 'S', 16, 'SPEAKER VIEW', 140)]
}

// --- chart options (pure JSON, brand-styled, embedded text face) ------------

const barOption = () => ({
  color: [PEACH, STEEL],
  textStyle: { fontFamily: 'Instrument Sans' },
  tooltip: { trigger: 'axis' },
  legend: { bottom: 0, textStyle: { color: '#6B7280' } },
  grid: { left: 48, right: 16, top: 24, bottom: 56 },
  xAxis: {
    type: 'category', data: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    axisLine: { lineStyle: { color: '#D8D2C4' } },
    axisLabel: { color: '#6B7280' },
  },
  yAxis: { type: 'value', axisLabel: { color: '#6B7280' }, splitLine: { lineStyle: { color: '#EAE4D6' } } },
  dataZoom: [{ type: 'inside' }],
  series: [
    { type: 'bar', name: 'Views', itemStyle: { borderRadius: [6, 6, 0, 0] }, data: [42, 68, 54, 86, 73] },
    { type: 'bar', name: 'Edits', itemStyle: { borderRadius: [6, 6, 0, 0] }, data: [28, 35, 42, 51, 64] },
  ],
})

const pieOption = () => ({
  color: [PEACH, PEACH_SOFT, STEEL, STEEL_SOFT, PANEL],
  textStyle: { fontFamily: 'Instrument Sans' },
  tooltip: { trigger: 'item' },
  legend: { bottom: 0, textStyle: { color: '#6B7280' } },
  series: [{
    type: 'pie', radius: ['34%', '62%'],
    label: { formatter: '{b} {d}%', color: '#4A5568' },
    itemStyle: { borderColor: '#FFFFFF', borderWidth: 3 },
    data: [
      { name: 'Mon', value: 42 }, { name: 'Tue', value: 68 }, { name: 'Wed', value: 54 },
      { name: 'Thu', value: 86 }, { name: 'Fri', value: 73 },
    ],
  }],
})

const trendOption = () => ({
  textStyle: { fontFamily: 'Instrument Sans' },
  tooltip: { trigger: 'axis' },
  grid: { left: 52, right: 24, top: 20, bottom: 40 },
  xAxis: {
    type: 'category',
    data: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    axisLine: { lineStyle: { color: 'rgba(185,196,212,0.25)' } },
    axisLabel: { color: 'rgba(185,196,212,0.8)' },
  },
  yAxis: {
    type: 'value',
    axisLabel: { color: 'rgba(185,196,212,0.8)' },
    splitLine: { lineStyle: { color: 'rgba(185,196,212,0.08)' } },
  },
  dataZoom: [{ type: 'inside' }],
  series: [{
    type: 'line', name: 'Momentum', smooth: true, symbol: 'none',
    lineStyle: { color: PEACH, width: 3 },
    areaStyle: {
      color: {
        type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [
          { offset: 0, color: 'rgba(255,158,138,0.35)' },
          { offset: 1, color: 'rgba(255,158,138,0)' },
        ],
      },
    },
    data: [8, 9, 12, 14, 19, 24, 30, 38, 47, 58, 71, 86],
  }],
})

const scatterOption = () => ({
  color: [PEACH, STEEL],
  textStyle: { fontFamily: 'Instrument Sans' },
  tooltip: { trigger: 'item' },
  legend: { bottom: 0, textStyle: { color: '#6B7280' } },
  grid: { left: 52, right: 24, top: 24, bottom: 56 },
  xAxis: {
    type: 'value', name: 'Reach',
    axisLine: { lineStyle: { color: '#D8D2C4' } },
    axisLabel: { color: '#6B7280' }, splitLine: { lineStyle: { color: '#EAE4D6' } },
  },
  yAxis: {
    type: 'value', name: 'Engagement',
    axisLabel: { color: '#6B7280' }, splitLine: { lineStyle: { color: '#EAE4D6' } },
  },
  series: [
    { type: 'scatter', name: 'Owned', symbolSize: 15, data: [[12, 8], [20, 15], [28, 12], [35, 26], [44, 22]] },
    { type: 'scatter', name: 'Paid', symbolSize: 15, data: [[52, 34], [63, 40], [71, 52], [82, 61], [92, 74]] },
  ],
})

// --- the deck ---------------------------------------------------------------

const DOTS_INK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" preserveAspectRatio="none">' +
  '<defs><pattern id="bp-dots-i" width="28" height="28" patternUnits="userSpaceOnUse">' +
  '<circle cx="1.5" cy="1.5" r="1.4" fill="#FFFFFF" opacity="0.07"/></pattern></defs>' +
  '<rect width="1280" height="720" fill="url(#bp-dots-i)"/></svg>'

const GRAIN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" preserveAspectRatio="none">' +
  '<filter id="bp-grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>' +
  '<feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.045 0"/></filter>' +
  '<rect width="1280" height="720" filter="url(#bp-grain)"/></svg>'

const BOKEH_WARM =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">' +
  '<defs><filter id="bp-bk-w" x="-60%" y="-60%" width="220%" height="220%">' +
  '<feGaussianBlur stdDeviation="7"/></filter></defs>' +
  '<circle cx="40" cy="40" r="21" fill="#FFE3BD" filter="url(#bp-bk-w)"/></svg>'

const BOKEH_COOL =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">' +
  '<defs><filter id="bp-bk-c" x="-60%" y="-60%" width="220%" height="220%">' +
  '<feGaussianBlur stdDeviation="7"/></filter></defs>' +
  '<circle cx="40" cy="40" r="21" fill="#DCE6F5" filter="url(#bp-bk-c)"/></svg>'

const AURORA_PEACH =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">' +
  '<defs><radialGradient id="bp-ga-am"><stop offset="0" stop-color="#FFEED6" stop-opacity="0.15"/>' +
  '<stop offset="0.55" stop-color="#FFEED6" stop-opacity="0.05"/>' +
  '<stop offset="1" stop-color="#FFEED6" stop-opacity="0"/></radialGradient></defs>' +
  '<circle cx="300" cy="300" r="300" fill="url(#bp-ga-am)"/></svg>'

const AURORA_STEEL =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">' +
  '<defs><radialGradient id="bp-ga-bl"><stop offset="0" stop-color="#DDE7F5" stop-opacity="0.12"/>' +
  '<stop offset="0.55" stop-color="#DDE7F5" stop-opacity="0.04"/>' +
  '<stop offset="1" stop-color="#DDE7F5" stop-opacity="0"/></radialGradient></defs>' +
  '<circle cx="300" cy="300" r="300" fill="url(#bp-ga-bl)"/></svg>'

const DOTS_PAPER =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" preserveAspectRatio="none">' +
  '<defs><pattern id="bp-dots-p" width="28" height="28" patternUnits="userSpaceOnUse">' +
  '<circle cx="1.5" cy="1.5" r="1.4" fill="#0D1B2E" opacity="0.07"/></pattern></defs>' +
  '<rect width="1280" height="720" fill="url(#bp-dots-p)"/></svg>'

export function starterDoc(): BentoDoc {
  const doc = newDoc()
  // The DECK's title, not the app's — it reads as a document name (window title,
  // suggested filename), so it stays in title case. The lowercase `bento/slides`
  // wordmark is app chrome and is unaffected.
  doc.title = 'Bento Slides Showcase'
  doc.theme.fontFamily = BODY
  // new charts (＋ Chart, table→chart) inherit the deck's midnight-&-peach family
  doc.theme.chartPalette = [PEACH, STEEL, PEACH_SOFT, STEEL_SOFT, MIST, PEACH_DEEP]
  doc.theme.tokens = { set: TOKENS }
  // the theme: Background/Text are paper and ink, Background 2/Text 2 the ink
  // panel and its mist, accents peach, steel and the text-safe deep peach
  doc.theme.background = THEME.bg1
  doc.theme.color = THEME.tx1
  doc.theme.accent = THEME.accent1
  doc.theme.palette = { bg2: THEME.bg2, tx2: THEME.tx2, accent2: THEME.accent2, accent3: THEME.accent3 }
  /**
   * Code Palette:
   * 8 colours, not four hundred scopes — the zero-cost tier. When the
   * signed-extension tier lands, grammarAssetId/themeAssetId select real
   * TextMate rendering and this map becomes the fallback.
   */
  doc.theme.codePalette = {
    c: '#6b7f8f', // comment
    s: '#c98a3e', // string
    n: '#b0688f', // number
    k: '#5b8def', // keyword
    f: '#3fa9a0', // call
    p: '#7c8794', // punctuation
    a: '#3f9142', // diff: added
    d: '#c25a43', // diff: removed
  }
  // The two faces are the shell's own (fonts.ts BUILTIN_FONTS): named, not
  // embedded — 86 KB that every saved deck used to carry twice.
  doc.fonts = [
    { family: 'Fraunces', asset: 'builtin:fraunces-900', weight: '900' },
    { family: 'Instrument Sans', asset: 'builtin:instrument-sans', weight: '400 700' },
  ]
  doc.assets = {
    'dots-ink': DOTS_INK,
    'dots-paper': DOTS_PAPER,
    'aurora-amber': AURORA_PEACH,
    'aurora-blue': AURORA_STEEL,
    'grain': GRAIN,
    'bokeh-warm': BOKEH_WARM,
    'bokeh-cool': BOKEH_COOL,
  }

  BUTTON.reset()
  const slide = (p: Partial<Slide> & { elements: SlideElement[] }): Slide =>
    ({ id: uid('slide'), background: INK, transition: 'morph', notes: '', ...p })

  doc.slides = [
    // ── 1 · TITLE ──────────────────────────────────────────────────────────
    slide({
      transition: 'fade',
      notes:
        'Welcome! This whole deck — data, viewer, editor — lives in one HTML file. ' +
        '→ advances, Esc edits, S opens the speaker view. Watch the tiles: they morph through every slide.',
      elements: [
        // atmosphere: breathing aurora blobs + bento tiles adrift around the logo
        ...group('Atmosphere', [
          grain(),
          glow(135, [
            { at: 0, color: 'rgba(94,118,153,0.22)' },
            { at: 0.55, color: 'rgba(15,23,36,0)' },
            { at: 1, color: 'rgba(255,158,138,0.16)' },
          ]),
          shape('rect', {
            name: 'Colour wash', x: 0, y: 0, w: 1280, h: 720, radius: 0, fill: 'transparent',
            fillGradient: {
              angle: 250,
              stops: [
                { at: 0, color: 'rgba(255,158,138,0.10)' },
                { at: 0.5, color: 'rgba(15,23,36,0)' },
                { at: 1, color: 'rgba(62,86,120,0.10)' },
              ],
            },
          }),
          dots(true, { ambient: 'kenburns', ken: { dir: 'out', scale: 1.35, duration: 3.2 } }),
          aurora(700, -80, 680, 'aurora-amber', 24, 80, 52),
          aurora(880, 220, 560, 'aurora-blue', 32, 70, 44, 10),
        ]),
        ...group('Bokeh field', [
          // near field — large, bright, biggest drift
          bokeh(770, 128, 44, true, 0.5, 39, 17),
          bokeh(1198, 208, 30, false, 0.42, 48, 14, 5),
          bokeh(1174, 468, 36, true, 0.34, 60, 20, 11),
          bokeh(1226, 600, 26, true, 0.3, 45, 16, 7),
          bokeh(716, 560, 28, false, 0.3, 51, 18, 13),
          // mid field
          bokeh(902, 108, 20, false, 0.38, 36, 12, 8),
          bokeh(812, 520, 18, true, 0.3, 39, 14, 15),
          bokeh(1080, 88, 16, true, 0.32, 33, 11, 3),
          bokeh(960, 604, 18, false, 0.28, 42, 12, 9),
          bokeh(656, 78, 14, false, 0.3, 30, 10, 12),
          // far field — small, dim, may pass over the text column
          bokeh(200, 138, 10, false, 0.22, 24, 9, 2),
          bokeh(420, 88, 8, true, 0.2, 21, 10, 6),
          bokeh(300, 566, 10, true, 0.22, 27, 8, 10),
          bokeh(522, 622, 8, false, 0.2, 22, 11, 4),
          bokeh(138, 424, 8, false, 0.18, 21, 10, 14),
          bokeh(624, 296, 7, true, 0.16, 18, 10, 18),
        ]),
        // the bento logo, built from the cast
        ...logo(850, 170, 320, 36, 40, 16, 84, 112, {
          d: { shadow: [{ blur: 56, color: 'rgba(255,240,220,0.18)' }, { y: 28, blur: 60, color: 'rgba(0,0,0,0.5)' }], fx: { enter: 'fade', order: 1 } },
          b: { fx: { enter: 'fade-up', order: 2 } },
          a: { fx: { enter: 'fade-up', order: 3 } },
          c: { fx: { enter: 'fade-up', order: 4 } },
        }),
        kicker('BENTO/SLIDES', { fx: { enter: 'fade-up', order: 0 } }),
        shape('rect', { name: 'Rule', x: 96, y: 86, w: 1088, h: 1.5, radius: 0, fill: 'rgba(255,255,255,0.12)', fx: { enter: 'fade', order: 0 } }),
        title('The file<br>is the<br>software.', {
          x: 88, y: 122, w: 660, h: 372, fontSize: 112, lineHeight: 1.02, color: '#FFFFFF',
          fx: { enter: 'fade-up', order: 1, ambient: 'kenburns', ken: { dir: 'out', scale: 1.05, duration: 2.6 } },
        }),
        text({
          name: 'Subtitle', role: 'subtitle', x: 96, y: 524, w: 520, h: 76,
          html: 'One HTML file — deck, viewer and editor together.<br>Open it anywhere. It saves itself.',
          fontSize: 20, fontWeight: 500, color: MIST, lineHeight: 1.6,
          fx: { enter: 'fade-up', order: 3 },
        }),
        // keycap hints: a hugging row of one "Key hint" component — the first is
        // the main, the other two are copies overriding only their words
        ...keyHints(),
      ],
    }),

    // ── 2 · ONE FILE ───────────────────────────────────────────────────────
    slide({
      background: PAPER,
      notes:
        'The tiles just morphed into the file anatomy. The dashed outline marches — a one-select loop effect. ' +
        'Everything on the right is ordinary rich text.',
      elements: [
        dots(false),
        glow(180, [
          { at: 0, color: 'rgba(255,158,138,0.07)' },
          { at: 1, color: 'rgba(94,118,153,0.05)' },
        ]),
        ghost(),
        kicker('ONE FILE', { color: PEACH_DEEP }),
        ...furniture(false),
        title('Everything ships inside.'),
        shape('rect', {
          name: 'Marching outline', x: 84, y: 208, w: 444, h: 420, radius: 26, fill: 'transparent',
          stroke: PEACH, strokeWidth: 2, strokeStyle: 'dashed',
          fx: { loop: { type: 'dash-march', distance: 18, duration: 1.6 } },
        }),
        // the anatomy card: a column frame (24 padding, 16 gap) of three tile
        // frames, each holding its caption — no hand-placed coordinates inside
        ...(() => {
          const card = frame({ dir: 'col', gap: 16, pad: [24, 24, 24, 24], align: 'stretch' }, {
            id: T_D, name: 'File anatomy', x: 96, y: 220, w: 420, h: 396, radius: 20, fill: '#FFFFFF', stroke: CARD_STROKE, strokeWidth: 1.5,
          })
          const row = (id: string, name: string, h: number, fill: string, html: string, color: string) => {
            const t = frame({ dir: 'row', pad: [16, 24, 16, 24], align: 'stretch' }, { id, name, x: 120, y: 0, w: 372, h, radius: 12, fill })
            const cap = text({ name: 'Caption', x: 144, y: 0, w: 324, h: h - 32, html, fontSize: 18, fontWeight: 500, color, lineHeight: 1.45, valign: 'middle' })
            return [t, ...inFrame(t, [cap], { w: 'fill' })]
          }
          const tiles = [
            row(T_A, 'Layer · your deck', 104, PEACH, '<b>your deck</b> — JSON in a &lt;script&gt; block', INK),
            row(T_B, 'Layer · viewer', 124, STEEL, '<b>viewer + presenter</b> — morphs, charts, speaker view', '#FFFFFF'),
            row(T_C, 'Layer · editor', 88, TILE_PAPER, '<b>the editor itself</b> — press Esc, it’s right there', INK_SOFT),
          ]
          tiles[0][0].y = 244; tiles[1][0].y = 364; tiles[2][0].y = 504
          return [card, ...inFrame(card, tiles.map((t) => t[0])), ...tiles.flatMap((t) => t.slice(1))]
        })(),
        text({
          name: 'Benefits', x: 600, y: 236, w: 584, h: 300,
          html:
            '<b>Self-saving</b> — ⌘S rewrites this very file in place<br>' +
            '<b>No install, no account</b> — a browser is the whole runtime<br>' +
            '<b>Assets embedded</b> — images and fonts ride along as data<br>' +
            '<b>View-source honest</b> — your document is readable JSON',
          fontSize: 20, fontWeight: 500, color: INK, lineHeight: 2.1,
        }),
        text({
          name: 'Footnote', x: 600, y: 556, w: 560, h: 50,
          html: 'Updates? The file checks a signed manifest at launch — <b>you can turn that off</b> — and rewrites itself.',
          fontSize: 15, fontWeight: 500, color: INK_SOFT, lineHeight: 1.55,
        }),
      ],
    }),

    // ── 3 · NO MOVING PARTS (staggers + count-ups, arriving by morph) ─────
    // This was a 'fade' because entrance fx and count-ups once needed a
    // non-morph arrival. Both have worked on morph arrivals since #197 —
    // runMorph gives every unpartnered element its fx.enter, and
    // runMorphArrivalCountUps counts up anything not carried from the previous
    // slide — so the fade only cost the deck its best tile moment: the four
    // scattered tiles collapsing into the row of chips at the top-left.
    slide({
      background: PEACH,
      notes:
        'The four tiles just collapsed into that row of chips — same four shapes, all deck long. ' +
        'The numbers counted up as the slide entered; ' +
        'that’s one checkbox on any text element. The little lines show line endings: arrow, dot, bar.',
      elements: [
        // the cast, collapsed into a hugging row of chips
        ...(() => {
          const chips = frame({ dir: 'row', gap: 10, align: 'center', hug: true }, { id: 'sd-chips', name: 'Cast chips', x: 96, y: 54, w: 166, h: 34 })
          const chip = (id: string, name: string, fill: string, x: number) => shape('rect', { id, name, x, y: 54, w: 34, h: 34, radius: 9, fill })
          return [chips, ...inFrame(chips, [
            chip(T_D, 'Tile · ink', INK, 96),
            chip(T_B, 'Tile · steel', STEEL, 140),
            chip(T_A, 'Tile · peach', PEACH_SOFT, 184),
            chip(T_C, 'Tile · paper', PAPER, 228),
          ])]
        })(),
        ...group('Slide furniture', [
          text({
            name: 'Page number', x: 1024, y: 54, w: 160, h: 26, html: '{{page:2}}', align: 'right',
            fontSize: 13, fontWeight: 700, letterSpacing: 2, color: 'rgba(15,23,36,0.45)',
          }),
          shape('rect', { name: 'Rule', x: 96, y: 108, w: 1088, h: 1.5, radius: 0, fill: 'rgba(15,23,36,0.18)' }),
        ]),
        // No fx on these two: the kicker and title carry the SAME ids as the
        // slide before, so they morph across and are already in motion. An
        // fx.enter here would be silently skipped — the entrance only runs for
        // elements with no partner on the previous slide.
        kicker('NO MOVING PARTS', { y: 132, color: INK }),
        title('Software with nothing<br>to install, break, or expire.', {
          y: 170, w: 1060, h: 150, color: INK, fontSize: 50,
        }),
        // three stats: a row frame of three equal column frames (number, line, label)
        ...(() => {
          const row = frame({ dir: 'row', gap: 16 }, { id: 'sd-stats', name: 'Stats', x: 96, y: 352, w: 1088, h: 242 })
          const stat = (i: number, value: string, size: number, tip: Partial<ShapeElement>, label: string) => {
            const x = 96 + i * 368
            const col = frame({ dir: 'col', gap: 8 }, { id: `sd-stat-${i}`, name: `Stat · ${label.toLowerCase()}`, x, y: 352, w: 352, h: 242 })
            const num = text({
              name: 'Value', x, y: 352, w: 352, h: 188, html: value, fontSize: size, fontWeight: 900, fontFamily: DISPLAY, color: INK,
              fx: { enter: 'fade-up', order: 2 + i, countUp: true },
            })
            const line = shape('line', { name: 'Tip', x, y: 548, w: 150, h: 8, fill: INK, strokeWidth: 3, ...tip, fx: { enter: 'fade', order: 5 } })
            const lab = text({
              name: 'Label', x, y: 564, w: 352, h: 30, html: label, fontSize: 14, fontWeight: 700, letterSpacing: 2, color: INK_SOFT,
              fx: { enter: 'fade', order: 6 },
            })
            return [col, ...inFrame(col, [num, lab], { w: 'fill' }), ...inFrame(col, [line])].sort((a, b) => (a === col ? -1 : b === col ? 1 : 0))
          }
          const cols = [
            stat(0, '1', 150, { lineEnd: 'arrow' }, 'FILE TO SEND'),
            stat(1, '0', 150, { lineStart: 'dot', lineEnd: 'dot' }, 'SERVERS REQUIRED'),
            stat(2, '100%', 130, { lineStart: 'bar', lineEnd: 'bar' }, 'YOURS, FOREVER'),
          ]
          return [row, ...inFrame(row, cols.map((c) => c[0]), { w: 'fill' }), ...cols.flatMap((c) => c.slice(1))]
        })(),
      ],
    }),

    // ── 4 · MORPH MANIFESTO ────────────────────────────────────────────────
    slide({
      notes:
        'The tiles scattered and grew — and picked up GRADIENT fills mid-morph (solid⇄gradient tweening). ' +
        'Press ← and → to replay it. Nothing here is a video; it’s the same four elements.',
      elements: [
        grain(),
        glow(20, [
          { at: 0, color: 'rgba(62,86,120,0.24)' },
          { at: 0.6, color: 'rgba(15,23,36,0)' },
          { at: 1, color: 'rgba(255,158,138,0.18)' },
        ]),
        shape('rect', {
          id: T_A, x: -140, y: -160, w: 520, h: 520, radius: 130, fill: PEACH,
          fillGradient: { angle: 135, stops: [{ at: 0, color: PEACH }, { at: 1, color: PEACH_SOFT }] },
        }),
        shape('rect', {
          id: T_B, x: 980, y: -120, w: 420, h: 420, radius: 110, fill: STEEL,
          fillGradient: { angle: 225, stops: [{ at: 0, color: '#41597A' }, { at: 1, color: STEEL_SOFT }] },
        }),
        shape('rect', {
          id: T_C, x: 1040, y: 520, w: 360, h: 360, radius: 96, fill: TILE_PAPER, opacity: 0.9,
          fillGradient: { angle: 315, stops: [{ at: 0, color: '#FFFFFF' }, { at: 1, color: '#D8D3C6' }] },
        }),
        shape('rect', {
          id: T_D, x: -70, y: 510, w: 290, h: 290, radius: 80, fill: 'transparent',
          stroke: 'rgba(185,196,212,0.4)', strokeWidth: 2, strokeStyle: 'dashed',
        }),
        kicker('THE NATIVE TRANSITION', { x: 340, y: 168, w: 600, h: 26, align: 'center' }),
        title('Morph.', {
          x: 140, y: 200, w: 1000, h: 280, fontSize: 216, color: '#FFFFFF', align: 'center', lineHeight: 1,
        }),
        text({
          name: 'Subtitle', x: 340, y: 504, w: 600, h: 96,
          html: 'Shared ids animate between slides — position, size, color, <b>even gradients</b>.<br>Press ← then → to replay it.',
          fontSize: 19, fontWeight: 500, color: MIST, align: 'center', lineHeight: 1.65,
        }),
      ],
    }),

    // ── 5 · SYMBOL MORPH, SIDE BY SIDE (maths and code, one mechanism) ────
    // The deck's sub-element morph, shown on BOTH content types at once: a
    // quadratic derivation on the left, three eras of JavaScript on the right.
    // Same engine underneath (tokens carry identities across slides and travel
    // to their new positions), two very different surfaces on top — which is
    // the claim this pair of columns is here to make.
    //
    // The maths is the classic three-step derivation, so the beats line up
    // with the code's callbacks -> promises (ES2015) -> async/await (ES2017):
    // a, b and c survive all three on the left while load, render, present and
    // confetti survive all three on the right. Both probed before authoring.
    slide({
      transition: 'morph',
      notes:
        'Two token streams, one mechanism. Both sides of this slide morph symbol by symbol: the maths is plain \u0024\u2026\u0024 in an ordinary text box, the code is a code element with 77 languages built in (about 7KB of rules, no highlighter library). Press \u2192 and watch BOTH at once \u2014 a, b and c travel through the derivation while the callback pyramid flattens into promises.',
      elements: [
        grain(),
        glow(20, [
          { at: 0, color: 'rgba(62,86,120,0.24)' },
          { at: 0.55, color: 'rgba(15,23,36,0)' },
          { at: 1, color: 'rgba(255,158,138,0.16)' },
        ]),
        shape('rect', {
          id: T_A, x: -130, y: 470, w: 300, h: 300, radius: 92, fill: PEACH,
          fillGradient: { angle: 45, stops: [{ at: 0, color: PEACH }, { at: 1, color: PEACH_SOFT }] },
        }),
        shape('rect', {
          id: T_B, x: 1060, y: -150, w: 340, h: 340, radius: 100, fill: STEEL,
          fillGradient: { angle: 200, stops: [{ at: 0, color: '#41597A' }, { at: 1, color: STEEL_SOFT }] },
        }),
        shape('rect', {
          id: T_C, x: 1080, y: 520, w: 260, h: 260, radius: 78, fill: TILE_PAPER, opacity: 0.85,
          fillGradient: { angle: 30, stops: [{ at: 0, color: '#FFFFFF' }, { at: 1, color: '#D8D3C6' }] },
        }),
        shape('rect', {
          id: T_D, x: -80, y: -120, w: 240, h: 240, radius: 68, fill: 'transparent',
          stroke: 'rgba(185,196,212,0.4)', strokeWidth: 2, strokeStyle: 'dashed',
        }),
        kicker('ONE MECHANISM, TWO LANGUAGES', { x: 340, y: 128, w: 600, h: 26, align: 'center' }),
        ...mathsAndCode('$$ax^2 + bx + c = 0$$', "load(deck, (slides) => {\n  render(slides, (frame) => {\n    present(frame)\n  })\n})\nconfetti()"),
        text({
          x: 190, y: 560, w: 900, h: 60,
          html: 'A derivation on the left, two revisions of JavaScript on the right. Press <b>→</b> twice.',
          fontSize: 19, fontWeight: 500, color: MIST, align: 'center', lineHeight: 1.65,
        }),
      ],
    }),

    slide({
      transition: 'morph',
      notes:
        'Left: completing the square \u2014 a, b and c did not crossfade, they moved into their new places. Right: the pyramid flattened and confetti() rose two lines to meet it. Point-free promises really did drop the parameter names, so slides and frame fading out is the diff being honest. One more \u2192.',
      elements: [
        grain(),
        glow(200, [
          { at: 0, color: 'rgba(62,86,120,0.24)' },
          { at: 0.55, color: 'rgba(15,23,36,0)' },
          { at: 1, color: 'rgba(255,158,138,0.16)' },
        ]),
        shape('rect', {
          id: T_A, x: -100, y: 500, w: 270, h: 270, radius: 84, fill: PEACH,
          fillGradient: { angle: 45, stops: [{ at: 0, color: PEACH }, { at: 1, color: PEACH_SOFT }] },
        }),
        shape('rect', {
          id: T_B, x: 1084, y: -128, w: 310, h: 310, radius: 92, fill: STEEL,
          fillGradient: { angle: 200, stops: [{ at: 0, color: '#41597A' }, { at: 1, color: STEEL_SOFT }] },
        }),
        shape('rect', {
          id: T_C, x: 1054, y: 500, w: 286, h: 286, radius: 84, fill: TILE_PAPER, opacity: 0.85,
          fillGradient: { angle: 30, stops: [{ at: 0, color: '#FFFFFF' }, { at: 1, color: '#D8D3C6' }] },
        }),
        shape('rect', {
          id: T_D, x: -90, y: -134, w: 260, h: 260, radius: 74, fill: 'transparent',
          stroke: 'rgba(185,196,212,0.4)', strokeWidth: 2, strokeStyle: 'dashed',
        }),
        kicker('EVERY TERM KEEPS ITS PLACE', { x: 340, y: 128, w: 600, h: 26, align: 'center' }),
        ...mathsAndCode('$$\\left(x + \\frac{b}{2a}\\right)^2 = \\frac{b^2 - 4ac}{4a^2}$$', "load(deck)\n  .then(render)\n  .then(present)\nconfetti()"),
        text({
          x: 190, y: 560, w: 900, h: 60,
          html: 'Completing the square, and the pyramid flattening — <b>both travelling at once</b>.',
          fontSize: 19, fontWeight: 500, color: MIST, align: 'center', lineHeight: 1.65,
        }),
      ],
    }),

    slide({
      transition: 'morph',
      notes:
        'async/await on the right, the quadratic formula on the left \u2014 and every symbol that survived the rewrite kept its identity the whole way. This is what a walkthrough is in Bento: duplicate the slide, edit the content, and the transition explains the change for you. No recording, no screenshots.',
      elements: [
        grain(),
        glow(20, [
          { at: 0, color: 'rgba(62,86,120,0.24)' },
          { at: 0.55, color: 'rgba(15,23,36,0)' },
          { at: 1, color: 'rgba(255,158,138,0.16)' },
        ]),
        shape('rect', {
          id: T_A, x: -70, y: 520, w: 250, h: 250, radius: 78, fill: PEACH,
          fillGradient: { angle: 45, stops: [{ at: 0, color: PEACH }, { at: 1, color: PEACH_SOFT }] },
        }),
        shape('rect', {
          id: T_B, x: 1100, y: -110, w: 290, h: 290, radius: 88, fill: STEEL,
          fillGradient: { angle: 200, stops: [{ at: 0, color: '#41597A' }, { at: 1, color: STEEL_SOFT }] },
        }),
        shape('rect', {
          id: T_C, x: 1030, y: 480, w: 310, h: 310, radius: 92, fill: TILE_PAPER, opacity: 0.85,
          fillGradient: { angle: 30, stops: [{ at: 0, color: '#FFFFFF' }, { at: 1, color: '#D8D3C6' }] },
        }),
        shape('rect', {
          id: T_D, x: -100, y: -150, w: 280, h: 280, radius: 80, fill: 'transparent',
          stroke: 'rgba(185,196,212,0.4)', strokeWidth: 2, strokeStyle: 'dashed',
        }),
        kicker('NOTHING HERE REDREW', { x: 340, y: 128, w: 600, h: 26, align: 'center' }),
        ...mathsAndCode('$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$', "const slides = await load(deck)\nconst frame = await render(slides)\npresent(frame)\nconfetti()"),
        text({
          x: 190, y: 560, w: 900, h: 60,
          html: 'Same <b>a</b>, <b>b</b>, <b>c</b>. Same <b>load</b>, <b>render</b>, <b>present</b>. The diff is the animation.',
          fontSize: 19, fontWeight: 500, color: MIST, align: 'center', lineHeight: 1.65,
        }),
      ],
    }),

    // ── 6 · CHARTS ALIVE (+ hidden pie state) ──────────────────────────────
    slide({
      id: S_CHARTS,
      background: PAPER,
      notes:
        'The chart is a live ECharts instance while presenting: hover for tooltips, scroll to zoom. ' +
        'Click “See the split” — it jumps to a hidden state slide and the bars MORPH into a pie.',
      elements: [
        dots(false),
        kicker('LIVE DATA', { color: PEACH_DEEP }),
        ...furniture(false),
        title('Charts with a pulse.'),
        ...chartPanel(barOption(), 'bar', '<b>Hover the bars</b> — tooltips are live.<br><br>Scroll or pinch inside the chart to zoom the data.', 'See the split →', S_CHARTS_PIE),
      ],
    }),
    slide({
      id: S_CHARTS_PIE,
      stateOf: S_CHARTS,
      background: PAPER,
      name: 'pie split',
      notes:
        'A hidden STATE slide — linear navigation skips it; only the click reaches it. Same chart element id, ' +
        'different option: ECharts’ universal transition morphs bar→pie in place. Click back.',
      elements: [
        dots(false),
        kicker('LIVE DATA', { color: PEACH_DEEP }),
        ...furniture(false),
        title('Same chart. New shape.'),
        ...chartPanel(pieOption(), 'pie', 'This is a <b>hidden state</b> — arrow keys skip it; only the click gets here.<br><br>The data morphed in place.', 'See the spread →', S_CHARTS_SCATTER),
      ],
    }),
    slide({
      id: S_CHARTS_SCATTER,
      stateOf: S_CHARTS,
      background: PAPER,
      name: 'scatter',
      notes:
        'A third hidden state — the same chart element id becomes a SCATTER plot (bar⇄pie⇄scatter all morph in place). ' +
        'Two clusters show a reach↔engagement correlation. Click to cycle back to the bars.',
      elements: [
        dots(false),
        kicker('LIVE DATA', { color: PEACH_DEEP }),
        ...furniture(false),
        title('And a scatter, in place.'),
        ...chartPanel(scatterOption(), 'scatter', 'Same chart element — a <b>third form</b>. Each dot is a campaign: reach across, engagement up.', '↺ Back to bars', S_CHARTS),
      ],
    }),

    // ── 7 · TABLES (real HTML table) ───────────────────────────────────────
    slide({
      background: PAPER,
      notes:
        'Tables are first-class — a real HTML table rendered the same in the editor, here, and in print. ' +
        'Double-click a cell to edit, Tab moves across and Enter down, drag the dividers to resize columns. ' +
        'The little chart on the right is LIVE-LINKED to the table — edit a Signups cell and it updates instantly. ' +
        '(“Make a chart from this table” in the panel builds a linked chart like it in one click.)',
      elements: [
        dots(false),
        kicker('STRUCTURED DATA', { color: PEACH_DEEP }),
        ...furniture(false),
        title('Facts, lined up.'),
        // card frame: the table fills it inside a 44/28 margin
        frame({ dir: 'row', pad: [44, 28, 44, 28] }, {
          id: T_C, name: 'Table card', x: 72, y: 196, w: 828, h: 458, radius: 20, fill: '#FFFFFF',
          stroke: CARD_STROKE, strokeWidth: 1.5, shadow: { y: 14, blur: 34, color: 'rgba(30,42,58,0.10)' },
        }),
        ...inFrame({ id: T_C } as SlideElement, [
          {
            ...defaultTable(),
            id: 'sd-table', name: 'Signups table', x: 100, y: 240, w: 772, h: 370, header: true,
            columns: [{ w: 1.5 }, { w: 1 }, { w: 1 }],
            rows: [
              { cells: [{ html: 'Quarter' }, { html: 'Signups', align: 'right' }, { html: 'Growth', align: 'right' }] },
              { cells: [{ html: 'Q1' }, { html: '1,204', align: 'right' }, { html: '—', align: 'right' }] },
              { cells: [{ html: 'Q2' }, { html: '3,880', align: 'right' }, { html: '+222%', align: 'right' }] },
              { cells: [{ html: 'Q3' }, { html: '9,140', align: 'right' }, { html: '+136%', align: 'right' }] },
              { cells: [{ html: 'Q4' }, { html: '21,500', align: 'right' }, { html: '+135%', align: 'right' }] },
            ],
            style: {
              headerBg: INK, headerColor: '#FFFFFF', zebra: 'rgba(30,42,58,0.05)',
              borderColor: 'rgba(30,42,58,0.10)', borderWidth: 1,
              cellPadX: 18, cellPadY: 12, fontSize: 18, color: '#26303E', radius: 12,
            },
          } as TableElement,
        ], { w: 'fill', h: 'fill' }),
        // side panel: a column frame — bar, label, the linked chart, a caption
        // taking the free height, and a copy of the Button (no link, shorter)
        frame({ dir: 'col', gap: 16, pad: [24, 24, 24, 24] }, {
          id: T_D, name: 'Side panel', x: 920, y: 196, w: 264, h: 458, fill: PANEL,
          shadow: { y: 14, blur: 34, color: 'rgba(30,42,58,0.18)' },
        }),
        ...inFrame({ id: T_D } as SlideElement, [
          shape('rect', { id: T_A, name: 'Accent bar', x: 944, y: 220, w: 44, h: 6, radius: 3, fill: PEACH }),
        ]),
        ...inFrame({ id: T_D } as SlideElement, [
          text({
            name: 'Panel label', x: 944, y: 242, w: 216, h: 20, html: 'SIGNUPS · LIVE',
            fontSize: 11, fontWeight: 700, letterSpacing: 2, color: STEEL_SOFT,
          }),
          // a small DUAL-AXIS chart LINKED to the table (source): Signups bars on
          // the left axis, Growth % as a line on the right axis. Editing a cell
          // updates it (series map to numeric columns by position).
          defaultChart(
            {
              color: [PEACH, STEEL],
              grid: { left: 48, right: 42, top: 16, bottom: 26 },
              xAxis: { type: 'category', data: ['Q1', 'Q2', 'Q3', 'Q4'], axisLabel: { color: MIST } },
              // MIST, not a half-transparent MIST. The engine used to ignore a
              // y-axis's own label colour and reuse the x-axis one, so these read
              // as MIST however they were written; once charts started honouring
              // each axis, the declared 50% alpha became visible and dropped
              // these numbers to 3.17:1 on the #16273E panel — under AA. The deck
              // had been tuned against the old behaviour, so it now says what it
              // always looked like: 8.28:1.
              yAxis: [
                { type: 'value', axisLabel: { color: MIST }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } } },
                { type: 'value', name: 'Growth', axisLabel: { color: MIST, formatter: '{value}%' }, splitLine: { show: false } },
              ],
              series: [
                { type: 'bar', name: 'Signups', yAxisIndex: 0, data: [1204, 3880, 9140, 21500], itemStyle: { borderRadius: [4, 4, 0, 0] } },
                { type: 'line', name: 'Growth', yAxisIndex: 1, data: [0, 222, 136, 135], smooth: true, symbol: 'circle', symbolSize: 5, lineStyle: { width: 2 } },
              ],
              tooltip: { trigger: 'axis' },
            },
            { id: 'sd-tbl-chart', name: 'Linked chart', x: 944, y: 266, w: 216, h: 224, preset: 'bar', source: { tableId: 'sd-table' } },
          ),
        ], { w: 'fill' }),
        ...inFrame({ id: T_D } as SlideElement, [
          text({
            name: 'Panel text', x: 944, y: 506, w: 216, h: 50,
            html: '<b>Edit the table</b> — bars and the growth line track it, live.',
            fontSize: 14, fontWeight: 500, color: MIST, lineHeight: 1.5,
          }),
        ], { w: 'fill', h: 'fill' }),
        ...BUTTON.at(944, 588, 'LIVE-LINKED', null, T_D, [T_B, 'sd-btn-label', ''], (pill, label) => {
          pill.h = 42
          Object.assign(label, { fontSize: 13, letterSpacing: 2 })
        }),
      ],
    }),

    // ── 8 · MOMENTUM (line-chart hero) ─────────────────────────────────────
    slide({
      notes:
        'A chart as scenery: full-width live area chart on ink. Drag horizontally inside it to zoom — ' +
        'dataZoom is on. The +975% is honest: it’s the data’s own range.',
      elements: [
        grain(),
        glow(200, [
          { at: 0, color: 'rgba(255,158,138,0.12)' },
          { at: 0.5, color: 'rgba(15,23,36,0)' },
          { at: 1, color: 'rgba(62,86,120,0.18)' },
        ]),
        kicker('STORY WITH DATA'),
        ...furniture(true),
        title('Momentum you can feel.', { color: '#FFFFFF', w: 700 }),
        text({
          name: 'Headline figure', x: 800, y: 92, w: 384, h: 116, html: '+975%', fontSize: 92, fontWeight: 900,
          fontFamily: DISPLAY, color: PEACH, align: 'right',
        }),
        // the cast as a legend: a hugging row, right edge on the 1184 margin
        frame({ dir: 'row', gap: 8, align: 'center', hug: true }, { id: 'sd-legend', name: 'Cast legend', x: 1096, y: 208, w: 88, h: 20 }),
        ...inFrame({ id: 'sd-legend' } as SlideElement, [
          shape('rect', { id: T_D, x: 1096, y: 208, w: 20, h: 20, radius: 6, fill: PANEL, stroke: 'rgba(185,196,212,0.3)', strokeWidth: 1 }),
          shape('rect', { id: T_B, x: 1124, y: 208, w: 20, h: 20, radius: 6, fill: STEEL }),
          shape('rect', { id: T_A, x: 1152, y: 208, w: 20, h: 20, radius: 6, fill: PEACH }),
          shape('rect', { id: T_C, x: 1180, y: 208, w: 4, h: 20, radius: 2, fill: TILE_PAPER }),
        ]),
        { ...defaultChart(trendOption()), name: 'Momentum chart', x: 64, y: 244, w: 1152, h: 420 },
      ],
    }),

    // ── 9 · MOTION & LINES ─────────────────────────────────────────────────
    slide({
      background: PAPER,
      notes:
        'The dot rides a motion path drawn with the on-canvas path editor; the dashes march underneath it. ' +
        'Paths are stored relative to the element, so you can drag the whole flow around.',
      elements: [
        dots(false),
        ghost(),
        kicker('MOTION', { color: PEACH_DEEP }),
        ...furniture(false),
        title('Lines that lead the eye.'),
        // the flow: a dashed path with a dot riding it, milestones as nodes
        shape('path', {
          name: 'Flow path', x: 140, y: 240, w: 1000, h: 340, fill: 'transparent',
          stroke: 'rgba(30,42,58,0.55)', strokeWidth: 2.5, strokeStyle: 'dashed',
          d: 'M 20 300 C 260 40 520 40 640 190 C 730 305 900 305 980 110',
          pathBox: [0, 0, 1000, 340],
          fx: { loop: { type: 'dash-march', distance: 20, duration: 1.8 } },
        }),
        shape('ellipse', {
          name: 'Rider', x: 150, y: 530, w: 20, h: 20, fill: PEACH,
          fx: { loop: { type: 'motion-path', duration: 8,
            path: 'M 0 0 C 240 -260 500 -260 620 -110 C 710 5 880 5 960 -190' } },
        }),
        // each milestone is a group: its node and its label move together
        ...milestone('Drafted', 505, 321, 20, '#FFFFFF', 435, 280, INK_SOFT),
        ...milestone('Reviewed', 944, 496, 20, '#FFFFFF', 874, 532, INK_SOFT),
        ...milestone('Shipped', 1106, 336, 24, PEACH, 1038, 292, PEACH_DEEP),
        // tiles parked as a hugging pill, right edge on the 1184 margin
        frame({ dir: 'row', gap: 8, pad: [13, 18, 13, 18], align: 'center', hug: true }, {
          id: T_D, name: 'Cast pill', x: 1078, y: 612, w: 106, h: 44, radius: 22, fill: '#FFFFFF', stroke: CARD_STROKE, strokeWidth: 1.5,
        }),
        ...inFrame({ id: T_D } as SlideElement, [
          shape('rect', { id: T_B, x: 1096, y: 625, w: 18, h: 18, radius: 6, fill: STEEL }),
          shape('rect', { id: T_A, x: 1122, y: 625, w: 18, h: 18, radius: 6, fill: PEACH }),
          shape('rect', { id: T_C, x: 1148, y: 625, w: 18, h: 18, radius: 6, fill: TILE_PAPER }),
        ]),
        text({
          name: 'Caption', x: 96, y: 624, w: 800, h: 26,
          html: 'Drawn with the on-canvas path editor — drag the anchors and the loop follows.',
          fontSize: 14, fontWeight: 500, color: INK_SOFT,
        }),
      ],
    }),


    // ── 10 · CHOREOGRAPHY (base + two hidden states) ──────────────────────
    ...(() => {
      type Scene = {
        id: string; step: string; label: string; chip: string; to: string
        blocks: Array<Partial<ShapeElement> & { id: string }>
      }
      const SCENES: Scene[] = [
        {
          id: S_CHOREO, step: '01', label: 'a tidy grid', chip: 'Play scene 2 →', to: S_CHOREO_2,
          blocks: [
            { id: T_D, x: 96, y: 240, w: 200, h: 170, radius: 18, fill: PANEL, fillGradient: GRAD_CARD },
            { id: T_B, x: 316, y: 240, w: 200, h: 170, radius: 18, fill: STEEL, fillGradient: GRAD_STEEL },
            { id: T_A, x: 536, y: 240, w: 200, h: 170, radius: 18, fill: PEACH, fillGradient: GRAD_PEACH },
            { id: T_C, x: 96, y: 430, w: 200, h: 170, radius: 18, fill: TILE_PAPER, fillGradient: GRAD_PAPER },
            { id: 'sd-ch-e', x: 316, y: 430, w: 200, h: 170, radius: 18, fill: PEACH_SOFT },
            { id: 'sd-ch-f', x: 536, y: 430, w: 200, h: 170, radius: 18, fill: STEEL_SOFT },
          ],
        },
        {
          id: S_CHOREO_2, step: '02', label: 'a loose cascade', chip: 'Play scene 3 →', to: S_CHOREO_3,
          blocks: [
            { id: T_D, x: 110, y: 216, w: 110, h: 110, radius: 30, fill: PANEL, fillGradient: GRAD_CARD },
            { id: T_B, x: 252, y: 286, w: 150, h: 150, radius: 38, fill: STEEL, fillGradient: GRAD_STEEL },
            { id: T_A, x: 430, y: 372, w: 210, h: 150, radius: 24, fill: PEACH, fillGradient: GRAD_PEACH, rotation: 7 },
            { id: T_C, x: 188, y: 476, w: 84, h: 84, radius: 24, fill: TILE_PAPER, fillGradient: GRAD_PAPER },
            { id: 'sd-ch-e', x: 620, y: 236, w: 120, h: 190, radius: 34, fill: PEACH_SOFT, rotation: -6 },
            { id: 'sd-ch-f', x: 520, y: 566, w: 240, h: 70, radius: 22, fill: STEEL_SOFT },
          ],
        },
        {
          id: S_CHOREO_3, step: '03', label: 'a data skyline', chip: '↺ Back to scene 1', to: S_CHOREO,
          blocks: [
            { id: T_D, x: 96, y: 420, w: 104, h: 220, radius: 12, fill: '#22344E' },
            { id: T_B, x: 224, y: 330, w: 104, h: 310, radius: 12, fill: STEEL_SOFT },
            { id: T_A, x: 352, y: 240, w: 104, h: 400, radius: 12, fill: PEACH, fillGradient: GRAD_PEACH },
            { id: T_C, x: 480, y: 460, w: 104, h: 180, radius: 12, fill: '#FFFFFF' },
            { id: 'sd-ch-e', x: 608, y: 360, w: 104, h: 280, radius: 12, fill: PEACH_SOFT },
            { id: 'sd-ch-f', x: 736, y: 500, w: 104, h: 140, radius: 12, fill: STEEL },
          ],
        },
      ]
      return SCENES.map((scene, si) =>
        slide({
          id: scene.id,
          ...(si > 0 ? { stateOf: S_CHOREO, name: `scene ${scene.step}` } : {}),
          notes: si === 0
            ? 'Click the button: each scene is a hidden STATE slide — same six elements, a new arrangement, ' +
              'and morph animates the whole choreography. Arrow keys skip the states; only clicks reach them.'
            : `Scene ${scene.step}. Same elements as scene 1 — position, size, color, radius and rotation all morphing at once.`,
          elements: [
            grain(),
            glow(105, [
              { at: 0, color: 'rgba(255,158,138,0.12)' },
              { at: 0.55, color: 'rgba(15,23,36,0)' },
              { at: 1, color: 'rgba(94,118,153,0.16)' },
            ]),
            kicker('INTERACTIVE STATES'),
            ...furniture(true),
            title('One cast. Three scenes.', { color: '#FFFFFF' }),
            ...scene.blocks.map((b) => shape('rect', { shadow: { y: 12, blur: 30, color: 'rgba(0,0,0,0.35)' }, ...b } as Partial<ShapeElement>)),
            text({
              id: 'sd-ch-step', name: 'Scene number', x: 864, y: 212, w: 320, h: 176, html: scene.step, align: 'right',
              fontSize: 140, fontWeight: 900, fontFamily: DISPLAY, color: 'rgba(255,255,255,0.14)',
            }),
            text({
              id: 'sd-ch-cap', x: 864, y: 400, w: 320, h: 30, html: scene.label, align: 'right',
              fontSize: 19, fontWeight: 600, color: MIST,
            }),
            // a copy of the chart slide's Button, overriding its paint: the peach variant
            ...BUTTON.at(964, 452, scene.chip, scene.to, undefined, ['sd-ch-btn', 'sd-ch-btnlabel', 'sd-ch-hit'], (pill, label) => {
              Object.assign(pill, { w: 220, fill: PEACH, fillGradient: GRAD_PEACH, stroke: 'transparent', strokeWidth: 0, shadow: { y: 10, blur: 26, color: 'rgba(0,0,0,0.4)' } })
              Object.assign(label, { color: INK, fontSize: 16 })
            }),
            text({
              x: 96, y: 660, w: 800, h: 26,
              html: 'Every scene is an ordinary slide — arrange elements, link a button, done.',
              fontSize: 14, fontWeight: 500, color: 'rgba(182,193,210,0.6)',
            }),
          ],
        }),
      )
    })(),

    // ── 11 · BUILT LIKE A DESIGN FILE (frames · components · tokens + hover focus)
    // The slide is its own example: the row is an auto-layout frame whose gap
    // is a token, the three cards are one component (the first is the main),
    // and every card paints with tokens. Hover focus still dims the others.
    slide({
      hover: { type: 'focus-group', dim: 0.22 },
      notes:
        'Open Layers (beside Slides): this row is a FRAME — the cards fill it and sit 40px apart, and that 40 is the ' +
        'space.cards token. The three cards are ONE component: edit the first card’s look and the other two follow, ' +
        'keeping their own words. Tokens (third tab) drive the colours, radii and gaps across the whole deck. ' +
        'Hover a card — the rest of the room dims (a per-slide switch plus a group tag).',
      elements: [
        grain(),
        glow(160, [
          { at: 0, color: 'rgba(94,118,153,0.16)' },
          { at: 1, color: 'rgba(255,158,138,0.12)' },
        ]),
        kicker('BUILT LIKE A DESIGN FILE'),
        ...furniture(true),
        title('Frames, components, tokens.', { color: '#FFFFFF' }),
        shape('rect', { id: T_D, name: 'Accent bar', x: 96, y: 186, w: 64, h: 6, radius: 3, fill: PEACH }),
        ...featureCards(),
        text({
          name: 'Caption', x: 96, y: 608, w: 1088, h: 26,
          html: 'Every layer here is named and grouped — open <b>Layers</b> to see the structure. Hover a card to focus it.',
          fontSize: 14, fontWeight: 500, color: 'rgba(185,196,212,0.6)',
        }),
      ],
    }),

    // ── 12 · MARKDOWN ──────────────────────────────────────────────────────
    slide({
      background: PAPER,
      notes:
        'Text editing converts markdown as you type — both panels here are ordinary text elements. ' +
        '⌘B/I/U work too, backslash escapes, and ⌘Z right after a conversion restores your literal characters.',
      elements: [
        dots(false),
        ghost(),
        kicker('WRITING', { color: PEACH_DEEP }),
        ...furniture(false),
        title('Type markdown, get typography.'),
        shape('rect', { id: T_A, name: 'Accent bar', x: 96, y: 186, w: 64, h: 6, radius: 3, fill: PEACH }),
        // two cards, one structure: a column frame (label, then the text filling the rest)
        ...mdCard(T_C, 'You type', 96, 520, '#FFFFFF', 'YOU TYPE', PEACH_DEEP,
          '<code>**instant** *formatting*</code><br><code>- bullets as you type</code><br><code>`code` and ~~strike~~</code>', INK, 400),
        shape('line', { name: 'Arrow', x: 636, y: 410, w: 116, h: 8, fill: 'rgba(30,42,58,0.5)', strokeWidth: 2.5, lineEnd: 'arrow' }),
        ...mdCard(T_D, 'You get', 772, 412, PANEL, 'YOU GET', PEACH,
          '<b>instant</b> <i>formatting</i><br>•&nbsp; bullets as you type<br><code>code</code> and <s>strike</s>', '#FFFFFF', 500),
        // a ⌘B keycap: hugging frame around its label
        frame({ dir: 'row', pad: [5, 12, 5, 12], hug: true, align: 'center' }, { id: T_B, name: 'Shortcut chip', x: 1124, y: 116, w: 60, h: 30, radius: 15, fill: STEEL }),
        ...inFrame({ id: T_B } as SlideElement, [
          text({ name: 'Shortcut', x: 1136, y: 121, w: 36, h: 20, html: '⌘B', fontSize: 13, fontWeight: 700, color: '#FFFFFF', align: 'center' }),
        ]),
      ],
    }),

    // ── 13 · CLOSE ─────────────────────────────────────────────────────────
    slide({
      notes:
        'The cast reassembles into the logo. Press Esc — this deck is already your copy of the app: ' +
        'edit it, save it, send it. bento.page has the latest build and the story.',
      elements: [
        // atmosphere mirrors the title: auroras breathing, tiles adrift
        ...group('Atmosphere', [
          grain(),
          glow(0, [
            { at: 0, color: 'rgba(255,158,138,0.14)' },
            { at: 0.55, color: 'rgba(15,23,36,0)' },
            { at: 1, color: 'rgba(94,118,153,0.16)' },
          ]),
          dots(true, { ambient: 'kenburns', ken: { dir: 'out', scale: 1.35, duration: 3.2 } }),
          aurora(320, -60, 660, 'aurora-amber', 26, 80, 56),
          aurora(600, 80, 560, 'aurora-blue', 34, 70, 48, 12),
        ]),
        ...group('Bokeh field', [
          // near field
          bokeh(404, 140, 44, true, 0.5, 39, 17),
          bokeh(872, 122, 30, false, 0.42, 48, 14, 5),
          bokeh(846, 372, 32, true, 0.34, 60, 20, 11),
          bokeh(160, 180, 26, true, 0.3, 51, 16, 3),
          bokeh(1156, 420, 28, true, 0.3, 54, 18, 9),
          // mid field
          bokeh(508, 82, 18, false, 0.36, 36, 12, 8),
          bokeh(438, 420, 18, true, 0.3, 39, 14, 15),
          bokeh(1090, 148, 24, false, 0.32, 45, 15, 7),
          bokeh(200, 520, 22, false, 0.28, 45, 13, 13),
          bokeh(1058, 600, 20, true, 0.26, 39, 12, 6),
          // far field
          bokeh(320, 300, 12, false, 0.22, 27, 10, 2),
          bokeh(958, 282, 12, true, 0.24, 30, 10, 10),
          bokeh(118, 358, 10, false, 0.2, 24, 9, 12),
          bokeh(1222, 258, 10, true, 0.22, 24, 11, 4),
          bokeh(640, 58, 10, false, 0.24, 27, 10, 16),
          bokeh(900, 478, 8, true, 0.18, 20, 9, 18),
        ]),
        // the logo again: same nested frames, a smaller panel
        ...logo(500, 120, 280, 32, 52, 14, 70, 96, {
          d: { shadow: [{ blur: 56, color: 'rgba(255,240,220,0.18)' }, { y: 28, blur: 60, color: 'rgba(0,0,0,0.5)' }] },
        }),
        kicker('YOUR TURN', { x: 340, y: 452, w: 600, h: 24, align: 'center' }),
        title('Make it yours.', {
          x: 240, y: 484, w: 800, h: 104, fontSize: 88, color: '#FFFFFF', align: 'center',
          fx: { ambient: 'kenburns', ken: { dir: 'out', scale: 1.05, duration: 2.6 } },
        }),
        text({
          name: 'Call to action', x: 290, y: 600, w: 700, h: 28,
          html: 'Press <b>Esc</b> — this deck is already your copy of the editor.',
          fontSize: 17, fontWeight: 500, color: MIST, align: 'center',
        }),
        // the Button once more, peach and small — and a real link (web links open in a new tab)
        ...BUTTON.at(562, 644, 'bento.page', 'https://bento.page', undefined, ['sd-close-btn', 'sd-close-btnlabel', 'sd-close-hit'], (pill, label) => {
          Object.assign(pill, { w: 156, h: 44, radius: 22, fill: PEACH, fillGradient: GRAD_PEACH, stroke: 'transparent', strokeWidth: 0, shadow: { y: 10, blur: 26, color: 'rgba(0,0,0,0.4)' } })
          Object.assign(label, { color: INK, fontSize: 16 })
        }),
      ],
    }),
  ]

  // Name what the builders left unnamed: the cast on the morph slides, and
  // the few one-off shapes. Text needs no name — Layers shows its words.
  const CAST: Record<string, string> = {
    [T_A]: 'Tile · peach', [T_B]: 'Tile · steel', [T_C]: 'Tile · paper', [T_D]: 'Tile · ink',
  }
  for (const s of doc.slides) for (const el of s.elements) {
    if (!el.name && CAST[el.id]) el.name = CAST[el.id]
    if (!el.name && el.type === 'shape' && el.shape === 'line') el.name = 'Line'
  }

  bindTheme(doc)

  // Settle what the deck derives — token literals, component copies, frame
  // children's boxes — so the shipped document is already a fixed point.
  // Empty memory = "the tokens moved": every bound literal is written from its token.
  derive(doc, { palette: '', tokens: '' })
  alignHits(doc)
  return doc
}
