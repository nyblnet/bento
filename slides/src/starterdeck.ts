// The starter deck — what a freshly built Bento Slides file opens with.
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
  newDoc, uid, defaultText, defaultShape, defaultChart,
  type BentoDoc, type Slide, type SlideElement, type TextElement, type ShapeElement,
  type SvgElement,
} from './model'
import { FRAUNCES_900, INSTRUMENT_VAR } from './fontdata'

/** Display face — embedded in the file (see fontdata.ts). */
const DISPLAY = "'Fraunces', Georgia, serif"
/** Text face — embedded variable sans. */
const BODY = "'Instrument Sans', -apple-system, 'Segoe UI', Helvetica, sans-serif"

const INK = '#0F1724'
const PANEL = '#1E2A3A'
const PAPER = '#F6F4EF'
const AMBER = '#F7A600'
const AMBER_SOFT = '#FFC23E'
const AMBER_DEEP = '#B87400'
const BLUE = '#5B8DEF'
const BLUE_SOFT = '#8FB0F2'
const MIST = '#B9C4D4'
const INK_SOFT = 'rgba(30, 42, 58, 0.72)'
const CARD_STROKE = '#E7E1D2'
const GLASS = 'rgba(255, 255, 255, 0.09)'

// the morphing cast — same ids on every slide
const T_A = 'sd-tile-a' // amber
const T_B = 'sd-tile-b' // blue
const T_C = 'sd-tile-c' // paper/white
const T_D = 'sd-tile-d' // ink panel / card
const TITLE = 'sd-title'
const KICKER = 'sd-kicker'
const GLOW = 'sd-glow'
const CHART_MAIN = 'sd-main-chart'

const S_CHARTS = 'sd-s-charts'
const S_CHARTS_PIE = 'sd-s-charts-pie'

// --- builders ---------------------------------------------------------------

const text = (p: Partial<TextElement>): TextElement =>
  ({ ...defaultText({ align: 'left', valign: 'top', fontFamily: BODY }), ...p }) as TextElement

const shape = (kind: Parameters<typeof defaultShape>[0], p: Partial<ShapeElement>): ShapeElement =>
  ({ ...defaultShape(kind), stroke: 'transparent', strokeWidth: 0, ...p }) as ShapeElement

const kicker = (label: string, p: Partial<TextElement> = {}): TextElement =>
  text({
    id: KICKER, x: 96, y: 54, w: 700, h: 26, html: label,
    fontSize: 13, fontWeight: 700, color: AMBER, letterSpacing: 4, ...p,
  })

const title = (html: string, p: Partial<TextElement> = {}): TextElement =>
  text({
    id: TITLE, x: 92, y: 112, w: 1000, h: 92, html,
    fontSize: 54, fontWeight: 900, fontFamily: DISPLAY, color: INK, lineHeight: 1.06, ...p,
  })

/** Content-slide furniture: index numeral + hairline rule. */
const furniture = (index: string, dark: boolean): SlideElement[] => [
  text({
    x: 1024, y: 54, w: 160, h: 26, html: index, align: 'right',
    fontSize: 13, fontWeight: 700, letterSpacing: 2,
    color: dark ? 'rgba(185,196,212,0.5)' : 'rgba(30,42,58,0.4)',
  }),
  shape('rect', {
    x: 96, y: 86, w: 1088, h: 1.5, radius: 0,
    fill: dark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,36,0.12)',
  }),
]

/** 300px ghost numeral (paper slides) — editorial depth, sits behind content. */
const ghost = (n: string): TextElement =>
  text({
    x: 780, y: -30, w: 420, h: 340, html: n, align: 'right',
    fontSize: 300, fontWeight: 900, fontFamily: DISPLAY, color: 'rgba(15,23,36,0.05)',
  })

const dots = (dark: boolean, fx?: SvgElement['fx']): SvgElement => ({
  id: uid('sv'), type: 'svg', x: 0, y: 0, w: 1280, h: 720, rotation: 0, opacity: 1,
  asset: dark ? 'dots-ink' : 'dots-paper', ...(fx ? { fx } : {}),
})

/** Seamless closed-loop drift path (tiny circle, radius r) for floating tiles. */
const floatPath = (r: number): string => {
  const k = Math.round(r * 0.5523 * 10) / 10
  return `M 0 0 C ${k} 0 ${r} ${r - k} ${r} ${r} C ${r} ${r + k} ${k} ${2 * r} 0 ${2 * r} ` +
    `C ${-k} ${2 * r} ${-r} ${r + k} ${-r} ${r} C ${-r} ${r - k} ${-k} 0 0 0`
}

/** Soft aurora blob — svg radial-gradient glow (edge-free), breathing on ken drift. */
const aurora = (
  x: number, y: number, size: number, asset: string, dur: number,
  roam = 0, roamDur = 50, delay = 0,
): SvgElement => ({
  id: uid('sv'), type: 'svg', x, y, w: size, h: size, rotation: 0, opacity: 1, asset,
  fx: {
    ambient: 'kenburns', ken: { dir: 'drift', scale: 1.22, duration: dur },
    ...(roam ? { loop: { type: 'motion-path' as const, path: floatPath(roam), duration: roamDur, delay } } : {}),
  },
})

/** Out-of-focus light speck (blurred svg disc) adrift on a slow closed loop. */
const bokeh = (
  x: number, y: number, s: number, warm: boolean, opacity: number,
  r: number, dur: number, delay = 0,
): SvgElement => ({
  id: uid('sv'), type: 'svg', x, y, w: s, h: s, rotation: 0, opacity,
  asset: warm ? 'bokeh-warm' : 'bokeh-cool',
  fx: { loop: { type: 'motion-path', path: floatPath(r), duration: dur, delay } },
})

/** Film grain for ink grounds (feTurbulence) — texture without a visible grid. */
const grain = (): SvgElement => ({
  id: uid('sv'), type: 'svg', x: 0, y: 0, w: 1280, h: 720, rotation: 0, opacity: 1,
  asset: 'grain',
})

const glow = (angle: number, stops: Array<{ at: number; color: string }>): ShapeElement =>
  shape('rect', {
    id: GLOW, x: 0, y: 0, w: 1280, h: 720, radius: 0,
    fill: 'transparent', fillGradient: { angle, stops },
    fx: { ambient: 'kenburns', ken: { dir: 'drift', scale: 1.06, duration: 34 } },
  })

// --- chart options (pure JSON, brand-styled, embedded text face) ------------

const barOption = () => ({
  color: [AMBER, BLUE],
  textStyle: { fontFamily: 'Instrument Sans' },
  tooltip: { trigger: 'axis' },
  legend: { bottom: 0, textStyle: { color: '#6B7280' } },
  grid: { left: 48, right: 16, top: 24, bottom: 56 },
  xAxis: {
    type: 'category', data: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    axisLine: { lineStyle: { color: '#D8D2C4' } }, axisTick: { show: false },
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
  color: [AMBER, AMBER_SOFT, BLUE, BLUE_SOFT, PANEL],
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
    axisTick: { show: false },
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
    lineStyle: { color: AMBER, width: 3 },
    areaStyle: {
      color: {
        type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [
          { offset: 0, color: 'rgba(247,166,0,0.35)' },
          { offset: 1, color: 'rgba(247,166,0,0)' },
        ],
      },
    },
    data: [8, 9, 12, 14, 19, 24, 30, 38, 47, 58, 71, 86],
  }],
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
  '<circle cx="40" cy="40" r="21" fill="#F7A600" filter="url(#bp-bk-w)"/></svg>'

const BOKEH_COOL =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">' +
  '<defs><filter id="bp-bk-c" x="-60%" y="-60%" width="220%" height="220%">' +
  '<feGaussianBlur stdDeviation="7"/></filter></defs>' +
  '<circle cx="40" cy="40" r="21" fill="#DCE6F5" filter="url(#bp-bk-c)"/></svg>'

const AURORA_AMBER =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">' +
  '<defs><radialGradient id="bp-ga-am"><stop offset="0" stop-color="#F7A600" stop-opacity="0.20"/>' +
  '<stop offset="0.55" stop-color="#F7A600" stop-opacity="0.07"/>' +
  '<stop offset="1" stop-color="#F7A600" stop-opacity="0"/></radialGradient></defs>' +
  '<circle cx="300" cy="300" r="300" fill="url(#bp-ga-am)"/></svg>'

const AURORA_BLUE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">' +
  '<defs><radialGradient id="bp-ga-bl"><stop offset="0" stop-color="#5B8DEF" stop-opacity="0.18"/>' +
  '<stop offset="0.55" stop-color="#5B8DEF" stop-opacity="0.06"/>' +
  '<stop offset="1" stop-color="#5B8DEF" stop-opacity="0"/></radialGradient></defs>' +
  '<circle cx="300" cy="300" r="300" fill="url(#bp-ga-bl)"/></svg>'

const DOTS_PAPER =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" preserveAspectRatio="none">' +
  '<defs><pattern id="bp-dots-p" width="28" height="28" patternUnits="userSpaceOnUse">' +
  '<circle cx="1.5" cy="1.5" r="1.4" fill="#0F1724" opacity="0.07"/></pattern></defs>' +
  '<rect width="1280" height="720" fill="url(#bp-dots-p)"/></svg>'

export function starterDoc(): BentoDoc {
  const doc = newDoc()
  doc.title = 'Bento Slides Showcase'
  doc.theme.fontFamily = BODY
  doc.fonts = [
    { family: 'Fraunces', asset: 'font-fraunces-900', weight: '900' },
    { family: 'Instrument Sans', asset: 'font-instrument', weight: '400 700' },
  ]
  doc.assets = {
    'font-fraunces-900': FRAUNCES_900,
    'font-instrument': INSTRUMENT_VAR,
    'dots-ink': DOTS_INK,
    'dots-paper': DOTS_PAPER,
    'aurora-amber': AURORA_AMBER,
    'aurora-blue': AURORA_BLUE,
    'grain': GRAIN,
    'bokeh-warm': BOKEH_WARM,
    'bokeh-cool': BOKEH_COOL,
  }

  const slide = (p: Partial<Slide> & { elements: SlideElement[] }): Slide => ({
    id: uid('slide'), background: INK, transition: 'morph', notes: '', ...p,
  })

  doc.slides = [
    // ── 1 · TITLE ──────────────────────────────────────────────────────────
    slide({
      transition: 'fade',
      notes:
        'Welcome! This whole deck — data, viewer, editor — lives in one HTML file. ' +
        '→ advances, Esc edits, S opens the speaker view. Watch the tiles: they morph through every slide.',
      elements: [
        grain(),
        glow(135, [
          { at: 0, color: 'rgba(91,141,239,0.22)' },
          { at: 0.55, color: 'rgba(15,23,36,0)' },
          { at: 1, color: 'rgba(247,166,0,0.16)' },
        ]),
        shape('rect', {
          x: 0, y: 0, w: 1280, h: 720, radius: 0, fill: 'transparent',
          fillGradient: {
            angle: 250,
            stops: [
              { at: 0, color: 'rgba(247,166,0,0.10)' },
              { at: 0.5, color: 'rgba(15,23,36,0)' },
              { at: 1, color: 'rgba(61,111,224,0.10)' },
            ],
          },
        }),
        // atmosphere: breathing aurora blobs + bento tiles adrift around the logo
        dots(true, { ambient: 'kenburns', ken: { dir: 'out', scale: 1.35, duration: 3.2 } }),
        aurora(700, -80, 680, 'aurora-amber', 24, 80, 52),
        aurora(880, 220, 560, 'aurora-blue', 32, 70, 44, 10),
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
        // the bento logo, built from the cast
        shape('rect', {
          id: T_D, x: 850, y: 170, w: 320, h: 320, radius: 36, fill: PANEL,
          stroke: 'rgba(185,196,212,0.28)', strokeWidth: 1.5,
          fx: { enter: 'fade', order: 1 },
        }),
        shape('rect', { id: T_B, x: 886, y: 206, w: 84, h: 248, radius: 18, fill: BLUE, fx: { enter: 'fade-up', order: 2 } }),
        shape('rect', { id: T_A, x: 986, y: 206, w: 148, h: 112, radius: 18, fill: AMBER, fx: { enter: 'fade-up', order: 3 } }),
        shape('rect', { id: T_C, x: 986, y: 330, w: 148, h: 124, radius: 18, fill: '#E9EDF3', fx: { enter: 'fade-up', order: 4 } }),
        kicker('BENTO SLIDES', { fx: { enter: 'fade-up', order: 0 } }),
        shape('rect', { x: 96, y: 86, w: 1088, h: 1.5, radius: 0, fill: 'rgba(255,255,255,0.12)', fx: { enter: 'fade', order: 0 } }),
        title('The file<br>is the<br>software.', {
          x: 88, y: 122, w: 660, h: 372, fontSize: 112, lineHeight: 1.02, color: '#FFFFFF',
          fx: { enter: 'fade-up', order: 1, ambient: 'kenburns', ken: { dir: 'out', scale: 1.05, duration: 2.6 } },
        }),
        text({
          x: 96, y: 524, w: 520, h: 76,
          html: 'One HTML file — deck, viewer and editor together.<br>Open it anywhere. It saves itself.',
          fontSize: 20, fontWeight: 500, color: MIST, lineHeight: 1.6,
          fx: { enter: 'fade-up', order: 3 },
        }),
        text({
          x: 96, y: 640, w: 700, h: 24,
          html: '→ ADVANCE &nbsp;·&nbsp; ESC EDIT &nbsp;·&nbsp; S SPEAKER VIEW',
          fontSize: 12, fontWeight: 600, letterSpacing: 2, color: 'rgba(185,196,212,0.55)',
          fx: { enter: 'fade', order: 6 },
        }),
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
          { at: 0, color: 'rgba(247,166,0,0.07)' },
          { at: 1, color: 'rgba(91,141,239,0.05)' },
        ]),
        ghost('02'),
        kicker('ONE FILE', { color: AMBER_DEEP }),
        ...furniture('02', false),
        title('Everything ships inside.'),
        shape('rect', {
          x: 84, y: 208, w: 444, h: 420, radius: 26, fill: 'transparent',
          stroke: AMBER, strokeWidth: 2, strokeStyle: 'dashed',
          fx: { loop: { type: 'dash-march', distance: 18, duration: 1.6 } },
        }),
        shape('rect', { id: T_D, x: 96, y: 220, w: 420, h: 396, radius: 20, fill: '#FFFFFF', stroke: CARD_STROKE, strokeWidth: 1.5 }),
        shape('rect', { id: T_A, x: 120, y: 244, w: 372, h: 104, radius: 12, fill: AMBER }),
        shape('rect', { id: T_B, x: 120, y: 364, w: 372, h: 124, radius: 12, fill: BLUE }),
        shape('rect', { id: T_C, x: 120, y: 504, w: 372, h: 88, radius: 12, fill: '#EFEAE0' }),
        text({ x: 144, y: 270, w: 330, h: 58, html: '<b>your deck</b> — JSON in a &lt;script&gt; block', fontSize: 18, fontWeight: 500, color: INK, lineHeight: 1.45 }),
        text({ x: 144, y: 394, w: 330, h: 70, html: '<b>viewer + presenter</b> — morphs, charts, speaker view', fontSize: 18, fontWeight: 500, color: '#FFFFFF', lineHeight: 1.45 }),
        text({ x: 144, y: 524, w: 330, h: 50, html: '<b>the editor itself</b> — press Esc, it’s right there', fontSize: 18, fontWeight: 500, color: INK_SOFT, lineHeight: 1.45 }),
        text({
          x: 600, y: 236, w: 584, h: 300,
          html:
            '<b>Self-saving</b> — ⌘S rewrites this very file in place<br>' +
            '<b>No install, no account</b> — a browser is the whole runtime<br>' +
            '<b>Assets embedded</b> — images and fonts ride along as data<br>' +
            '<b>View-source honest</b> — your document is readable JSON',
          fontSize: 20, fontWeight: 500, color: INK, lineHeight: 2.1,
        }),
        text({
          x: 600, y: 556, w: 560, h: 50,
          html: 'Updates? The file checks a signed manifest — <b>only when you ask</b> — and rewrites itself.',
          fontSize: 15, fontWeight: 500, color: INK_SOFT, lineHeight: 1.55,
        }),
      ],
    }),

    // ── 3 · MORPH MANIFESTO ────────────────────────────────────────────────
    slide({
      notes:
        'The tiles scattered and grew — and picked up GRADIENT fills mid-morph (solid⇄gradient tweening). ' +
        'Press ← and → to replay it. Nothing here is a video; it’s the same four elements.',
      elements: [
        grain(),
        glow(20, [
          { at: 0, color: 'rgba(61,111,224,0.24)' },
          { at: 0.6, color: 'rgba(15,23,36,0)' },
          { at: 1, color: 'rgba(247,166,0,0.18)' },
        ]),
        shape('rect', {
          id: T_A, x: -140, y: -160, w: 520, h: 520, radius: 130, fill: AMBER,
          fillGradient: { angle: 135, stops: [{ at: 0, color: AMBER }, { at: 1, color: AMBER_SOFT }] },
        }),
        shape('rect', {
          id: T_B, x: 980, y: -120, w: 420, h: 420, radius: 110, fill: BLUE,
          fillGradient: { angle: 225, stops: [{ at: 0, color: '#3D6FE0' }, { at: 1, color: BLUE_SOFT }] },
        }),
        shape('rect', {
          id: T_C, x: 1040, y: 520, w: 360, h: 360, radius: 96, fill: '#E9EDF3', opacity: 0.9,
          fillGradient: { angle: 315, stops: [{ at: 0, color: '#FFFFFF' }, { at: 1, color: '#CBD5E1' }] },
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
          x: 340, y: 512, w: 600, h: 80,
          html: 'Shared ids animate between slides — position, size, color, <b>even gradients</b>.<br>Press ← then → to replay it.',
          fontSize: 19, fontWeight: 500, color: MIST, align: 'center', lineHeight: 1.65,
        }),
      ],
    }),

    // ── 4 · STATS BEAT (fade → staggers + count-ups) ───────────────────────
    slide({
      background: AMBER,
      transition: 'fade',
      notes:
        'A hard cut on purpose — rhythm. The numbers counted up as the slide entered; ' +
        'that’s one checkbox on any text element. The little lines show line endings: arrow, dot, bar.',
      elements: [
        shape('rect', { id: T_D, x: 96, y: 54, w: 34, h: 34, radius: 9, fill: INK }),
        shape('rect', { id: T_B, x: 140, y: 54, w: 34, h: 34, radius: 9, fill: BLUE }),
        shape('rect', { id: T_A, x: 184, y: 54, w: 34, h: 34, radius: 9, fill: AMBER_SOFT }),
        shape('rect', { id: T_C, x: 228, y: 54, w: 34, h: 34, radius: 9, fill: PAPER }),
        text({
          x: 1024, y: 54, w: 160, h: 26, html: '04', align: 'right',
          fontSize: 13, fontWeight: 700, letterSpacing: 2, color: 'rgba(15,23,36,0.45)',
        }),
        shape('rect', { x: 96, y: 108, w: 1088, h: 1.5, radius: 0, fill: 'rgba(15,23,36,0.18)' }),
        kicker('NO MOVING PARTS', { y: 132, color: INK, fx: { enter: 'fade-up', order: 0 } }),
        title('Software with nothing<br>to install, break, or expire.', {
          y: 170, w: 1060, h: 150, color: INK, fontSize: 50,
          fx: { enter: 'fade-up', order: 1 },
        }),
        text({ x: 96, y: 356, w: 352, h: 180, html: '1', fontSize: 150, fontWeight: 900, fontFamily: DISPLAY, color: INK, fx: { enter: 'fade-up', order: 2, countUp: true } }),
        text({ x: 464, y: 356, w: 352, h: 180, html: '0', fontSize: 150, fontWeight: 900, fontFamily: DISPLAY, color: INK, fx: { enter: 'fade-up', order: 3, countUp: true } }),
        text({ x: 832, y: 356, w: 352, h: 180, html: '100%', fontSize: 130, fontWeight: 900, fontFamily: DISPLAY, color: INK, fx: { enter: 'fade-up', order: 4, countUp: true } }),
        shape('line', { x: 100, y: 542, w: 150, h: 8, fill: INK, strokeWidth: 3, lineEnd: 'arrow', fx: { enter: 'fade', order: 5 } }),
        shape('line', { x: 468, y: 542, w: 150, h: 8, fill: INK, strokeWidth: 3, lineStart: 'dot', lineEnd: 'dot', fx: { enter: 'fade', order: 5 } }),
        shape('line', { x: 836, y: 542, w: 150, h: 8, fill: INK, strokeWidth: 3, lineStart: 'bar', lineEnd: 'bar', fx: { enter: 'fade', order: 5 } }),
        text({ x: 96, y: 570, w: 352, h: 30, html: 'FILE TO SEND', fontSize: 14, fontWeight: 700, letterSpacing: 2, color: INK_SOFT, fx: { enter: 'fade', order: 6 } }),
        text({ x: 464, y: 570, w: 352, h: 30, html: 'SERVERS REQUIRED', fontSize: 14, fontWeight: 700, letterSpacing: 2, color: INK_SOFT, fx: { enter: 'fade', order: 6 } }),
        text({ x: 832, y: 570, w: 352, h: 30, html: 'YOURS, FOREVER', fontSize: 14, fontWeight: 700, letterSpacing: 2, color: INK_SOFT, fx: { enter: 'fade', order: 6 } }),
      ],
    }),

    // ── 5 · CHARTS ALIVE (+ hidden pie state) ──────────────────────────────
    slide({
      id: S_CHARTS,
      background: PAPER,
      notes:
        'The chart is a live ECharts instance while presenting: hover for tooltips, scroll to zoom. ' +
        'Click “See the split” — it jumps to a hidden state slide and the bars MORPH into a pie.',
      elements: [
        dots(false),
        kicker('LIVE DATA', { color: AMBER_DEEP }),
        ...furniture('05', false),
        title('Charts with a pulse.'),
        shape('rect', { id: T_C, x: 72, y: 196, w: 828, h: 458, radius: 20, fill: '#FFFFFF', stroke: CARD_STROKE, strokeWidth: 1.5 }),
        { ...defaultChart(barOption()), id: CHART_MAIN, x: 96, y: 220, w: 780, h: 410, preset: 'bar' },
        shape('rect', { id: T_D, x: 920, y: 196, w: 264, h: 458, radius: 18, fill: PANEL, stroke: GLASS, strokeWidth: 1 }),
        shape('rect', { id: T_A, x: 944, y: 222, w: 44, h: 6, radius: 3, fill: AMBER }),
        text({
          x: 944, y: 248, w: 216, h: 210,
          html: '<b>Hover the bars</b> — tooltips are live.<br><br>Scroll or pinch inside the chart to zoom the data.',
          fontSize: 16.5, fontWeight: 500, color: MIST, lineHeight: 1.7,
        }),
        shape('rect', {
          id: T_B, x: 944, y: 560, w: 216, h: 52, radius: 26, fill: BLUE,
          link: S_CHARTS_PIE,
        }),
        text({
          x: 944, y: 574, w: 216, h: 28, html: 'See the split →', fontSize: 17, fontWeight: 700,
          color: '#FFFFFF', align: 'center', link: S_CHARTS_PIE,
        }),
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
        kicker('LIVE DATA', { color: AMBER_DEEP }),
        ...furniture('05', false),
        title('Same chart. New shape.'),
        shape('rect', { id: T_C, x: 72, y: 196, w: 828, h: 458, radius: 20, fill: '#FFFFFF', stroke: CARD_STROKE, strokeWidth: 1.5 }),
        { ...defaultChart(pieOption()), id: CHART_MAIN, x: 96, y: 220, w: 780, h: 410, preset: 'pie' },
        shape('rect', { id: T_D, x: 920, y: 196, w: 264, h: 458, radius: 18, fill: PANEL, stroke: GLASS, strokeWidth: 1 }),
        shape('rect', { id: T_A, x: 944, y: 222, w: 44, h: 6, radius: 3, fill: AMBER }),
        text({
          x: 944, y: 248, w: 216, h: 210,
          html: 'This is a <b>hidden state</b> — arrow keys skip it; only the click gets here.<br><br>The data morphed in place.',
          fontSize: 16.5, fontWeight: 500, color: MIST, lineHeight: 1.7,
        }),
        shape('rect', {
          id: T_B, x: 944, y: 560, w: 216, h: 52, radius: 26, fill: BLUE,
          link: S_CHARTS,
        }),
        text({
          x: 944, y: 574, w: 216, h: 28, html: '← Back to bars', fontSize: 17, fontWeight: 700,
          color: '#FFFFFF', align: 'center', link: S_CHARTS,
        }),
      ],
    }),

    // ── 6 · MOMENTUM (line-chart hero) ─────────────────────────────────────
    slide({
      notes:
        'A chart as scenery: full-width live area chart on ink. Drag horizontally inside it to zoom — ' +
        'dataZoom is on. The +975% is honest: it’s the data’s own range.',
      elements: [
        grain(),
        glow(200, [
          { at: 0, color: 'rgba(247,166,0,0.12)' },
          { at: 0.5, color: 'rgba(15,23,36,0)' },
          { at: 1, color: 'rgba(61,111,224,0.18)' },
        ]),
        kicker('STORY WITH DATA'),
        ...furniture('06', true),
        title('Momentum you can feel.', { color: '#FFFFFF', w: 700 }),
        text({
          x: 800, y: 96, w: 384, h: 110, html: '+975%', fontSize: 92, fontWeight: 900,
          fontFamily: DISPLAY, color: AMBER, align: 'right',
        }),
        shape('rect', { id: T_D, x: 1096, y: 208, w: 20, h: 20, radius: 6, fill: PANEL, stroke: 'rgba(185,196,212,0.3)', strokeWidth: 1 }),
        shape('rect', { id: T_B, x: 1124, y: 208, w: 20, h: 20, radius: 6, fill: BLUE }),
        shape('rect', { id: T_A, x: 1152, y: 208, w: 20, h: 20, radius: 6, fill: AMBER }),
        shape('rect', { id: T_C, x: 1180, y: 208, w: 4, h: 20, radius: 2, fill: '#E9EDF3' }),
        { ...defaultChart(trendOption()), x: 64, y: 244, w: 1152, h: 420 },
      ],
    }),

    // ── 7 · MOTION & LINES ─────────────────────────────────────────────────
    slide({
      background: PAPER,
      notes:
        'The dot rides a motion path drawn with the on-canvas path editor; the dashes march underneath it. ' +
        'Paths are stored relative to the element, so you can drag the whole flow around.',
      elements: [
        dots(false),
        ghost('07'),
        kicker('MOTION', { color: AMBER_DEEP }),
        ...furniture('07', false),
        title('Lines that lead the eye.'),
        // the flow: a dashed path with a dot riding it, milestones as nodes
        shape('path', {
          x: 140, y: 240, w: 1000, h: 340, fill: 'transparent',
          stroke: 'rgba(30,42,58,0.55)', strokeWidth: 2.5, strokeStyle: 'dashed',
          d: 'M 20 300 C 260 40 520 40 640 190 C 730 305 900 305 980 110',
          pathBox: [0, 0, 1000, 340],
          fx: { loop: { type: 'dash-march', distance: 20, duration: 1.8 } },
        }),
        shape('ellipse', {
          x: 150, y: 530, w: 20, h: 20, fill: AMBER,
          fx: { loop: { type: 'motion-path', duration: 8,
            path: 'M 0 0 C 240 -260 500 -260 620 -110 C 710 5 880 5 960 -190' } },
        }),
        shape('ellipse', { x: 505, y: 321, w: 20, h: 20, fill: '#FFFFFF', stroke: INK, strokeWidth: 2.5 }),
        shape('ellipse', { x: 944, y: 496, w: 20, h: 20, fill: '#FFFFFF', stroke: INK, strokeWidth: 2.5 }),
        shape('ellipse', { x: 1106, y: 336, w: 24, h: 24, fill: AMBER, stroke: INK, strokeWidth: 2.5 }),
        text({ x: 435, y: 280, w: 160, h: 26, html: 'DRAFTED', fontSize: 13, fontWeight: 700, letterSpacing: 1.5, color: INK_SOFT, align: 'center' }),
        text({ x: 874, y: 532, w: 160, h: 26, html: 'REVIEWED', fontSize: 13, fontWeight: 700, letterSpacing: 1.5, color: INK_SOFT, align: 'center' }),
        text({ x: 1038, y: 292, w: 160, h: 26, html: 'SHIPPED', fontSize: 13, fontWeight: 700, letterSpacing: 1.5, color: AMBER_DEEP, align: 'center' }),
        // tiles parked as a pill, bottom-right
        shape('rect', { id: T_D, x: 1044, y: 612, w: 140, h: 44, radius: 22, fill: '#FFFFFF', stroke: CARD_STROKE, strokeWidth: 1.5 }),
        shape('rect', { id: T_B, x: 1062, y: 626, w: 18, h: 18, radius: 6, fill: BLUE }),
        shape('rect', { id: T_A, x: 1088, y: 626, w: 18, h: 18, radius: 6, fill: AMBER }),
        shape('rect', { id: T_C, x: 1114, y: 626, w: 18, h: 18, radius: 6, fill: '#EFEAE0' }),
        text({
          x: 96, y: 624, w: 800, h: 26,
          html: 'Drawn with the on-canvas path editor — drag the anchors and the loop follows.',
          fontSize: 14, fontWeight: 500, color: INK_SOFT,
        }),
      ],
    }),

    // ── 8 · HOVER FOCUS ────────────────────────────────────────────────────
    slide({
      hover: { type: 'focus-group', dim: 0.22 },
      notes:
        'Hover any card — everything else dims. That’s a per-slide switch plus a group tag on the elements. ' +
        'Use it for dense diagrams where pointing should focus the room.',
      elements: [
        grain(),
        glow(160, [
          { at: 0, color: 'rgba(91,141,239,0.16)' },
          { at: 1, color: 'rgba(247,166,0,0.12)' },
        ]),
        kicker('FOCUS'),
        ...furniture('08', true),
        title('Point, and the room dims.', { color: '#FFFFFF' }),
        shape('rect', { id: T_D, x: 96, y: 186, w: 64, h: 6, radius: 3, fill: AMBER }),
        // card 1 — one file
        shape('rect', { x: 96, y: 228, w: 336, h: 336, radius: 18, fill: PANEL, stroke: GLASS, strokeWidth: 1, group: 'g-file' }),
        shape('rect', { id: T_A, x: 128, y: 260, w: 52, h: 52, radius: 14, fill: AMBER, group: 'g-file' }),
        text({ x: 128, y: 342, w: 272, h: 32, html: 'One file', fontSize: 21, fontWeight: 700, color: '#FFFFFF', group: 'g-file' }),
        text({
          x: 128, y: 384, w: 272, h: 140,
          html: 'Send it, archive it, open it in ten years. The runtime is pinned inside, so it never rots.',
          fontSize: 16, fontWeight: 500, color: MIST, lineHeight: 1.7, group: 'g-file',
        }),
        // card 2 — morph
        shape('rect', { x: 472, y: 228, w: 336, h: 336, radius: 18, fill: PANEL, stroke: GLASS, strokeWidth: 1, group: 'g-morph' }),
        shape('rect', { id: T_B, x: 504, y: 260, w: 52, h: 52, radius: 14, fill: BLUE, group: 'g-morph' }),
        text({ x: 504, y: 342, w: 272, h: 32, html: 'Morph everything', fontSize: 21, fontWeight: 700, color: '#FFFFFF', group: 'g-morph' }),
        text({
          x: 504, y: 384, w: 272, h: 140,
          html: 'Slides share elements by id; transitions animate the difference. States and links make it interactive.',
          fontSize: 16, fontWeight: 500, color: MIST, lineHeight: 1.7, group: 'g-morph',
        }),
        // card 3 — data
        shape('rect', { x: 848, y: 228, w: 336, h: 336, radius: 18, fill: PANEL, stroke: GLASS, strokeWidth: 1, group: 'g-data' }),
        shape('rect', { id: T_C, x: 880, y: 260, w: 52, h: 52, radius: 14, fill: '#E9EDF3', group: 'g-data' }),
        text({ x: 880, y: 342, w: 272, h: 32, html: 'Live data', fontSize: 21, fontWeight: 700, color: '#FFFFFF', group: 'g-data' }),
        text({
          x: 880, y: 384, w: 272, h: 140,
          html: 'Charts present as real instances — tooltips, zoom, and data that morphs between states.',
          fontSize: 16, fontWeight: 500, color: MIST, lineHeight: 1.7, group: 'g-data',
        }),
        text({
          x: 96, y: 608, w: 700, h: 26, html: 'Hover the cards — it works right now, while presenting.',
          fontSize: 14, fontWeight: 500, color: 'rgba(185,196,212,0.6)',
        }),
      ],
    }),

    // ── 9 · MARKDOWN ───────────────────────────────────────────────────────
    slide({
      background: PAPER,
      notes:
        'Text editing converts markdown as you type — both panels here are ordinary text elements. ' +
        '⌘B/I/U work too, backslash escapes, and ⌘Z right after a conversion restores your literal characters.',
      elements: [
        dots(false),
        ghost('09'),
        kicker('WRITING', { color: AMBER_DEEP }),
        ...furniture('09', false),
        title('Type markdown, get typography.'),
        shape('rect', { id: T_A, x: 96, y: 186, w: 64, h: 6, radius: 3, fill: AMBER }),
        shape('rect', { id: T_C, x: 96, y: 228, w: 520, h: 372, radius: 18, fill: '#FFFFFF', stroke: CARD_STROKE, strokeWidth: 1.5 }),
        text({ x: 128, y: 256, w: 300, h: 22, html: 'YOU TYPE', fontSize: 12, fontWeight: 700, color: AMBER_DEEP, letterSpacing: 3 }),
        text({
          x: 128, y: 300, w: 460, h: 260,
          html: '<code>**instant** *formatting*</code><br><code>- bullets as you type</code><br><code>`code` and ~~strike~~</code>',
          fontSize: 21, color: INK, lineHeight: 2.15,
        }),
        shape('line', { x: 636, y: 400, w: 116, h: 8, fill: 'rgba(30,42,58,0.5)', strokeWidth: 2.5, lineEnd: 'arrow' }),
        shape('rect', { id: T_D, x: 772, y: 228, w: 412, h: 372, radius: 18, fill: PANEL, stroke: GLASS, strokeWidth: 1 }),
        text({ x: 804, y: 256, w: 300, h: 22, html: 'YOU GET', fontSize: 12, fontWeight: 700, color: AMBER, letterSpacing: 3 }),
        text({
          x: 804, y: 300, w: 350, h: 260,
          html: '<b>instant</b> <i>formatting</i><br>•&nbsp; bullets as you type<br><code>code</code> and <s>strike</s>',
          fontSize: 21, fontWeight: 500, color: '#FFFFFF', lineHeight: 2.15,
        }),
        shape('rect', { id: T_B, x: 1130, y: 116, w: 54, h: 30, radius: 15, fill: BLUE }),
        text({ x: 1130, y: 122, w: 54, h: 20, html: '⌘B', fontSize: 13, fontWeight: 700, color: '#FFFFFF', align: 'center' }),
      ],
    }),

    // ── 10 · CLOSE ─────────────────────────────────────────────────────────
    slide({
      notes:
        'The cast reassembles into the logo. Press Esc — this deck is already your copy of the app: ' +
        'edit it, save it, send it. bento.page has the latest build and the story.',
      elements: [
        grain(),
        glow(0, [
          { at: 0, color: 'rgba(247,166,0,0.14)' },
          { at: 0.55, color: 'rgba(15,23,36,0)' },
          { at: 1, color: 'rgba(91,141,239,0.16)' },
        ]),
        // atmosphere mirrors the title: auroras breathing, tiles adrift
        dots(true, { ambient: 'kenburns', ken: { dir: 'out', scale: 1.35, duration: 3.2 } }),
        aurora(320, -60, 660, 'aurora-amber', 26, 80, 56),
        aurora(600, 80, 560, 'aurora-blue', 34, 70, 48, 12),
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
        shape('rect', {
          id: T_D, x: 500, y: 120, w: 280, h: 280, radius: 56, fill: PANEL,
          stroke: 'rgba(185,196,212,0.28)', strokeWidth: 1.5,
        }),
        shape('rect', { id: T_B, x: 532, y: 152, w: 70, h: 216, radius: 14, fill: BLUE }),
        shape('rect', { id: T_A, x: 618, y: 152, w: 130, h: 96, radius: 14, fill: AMBER }),
        shape('rect', { id: T_C, x: 618, y: 260, w: 130, h: 108, radius: 14, fill: '#E9EDF3' }),
        kicker('YOUR TURN', { x: 340, y: 452, w: 600, h: 24, align: 'center' }),
        title('Make it yours.', {
          x: 240, y: 484, w: 800, h: 104, fontSize: 88, color: '#FFFFFF', align: 'center',
          fx: { ambient: 'kenburns', ken: { dir: 'out', scale: 1.05, duration: 2.6 } },
        }),
        text({
          x: 290, y: 600, w: 700, h: 28,
          html: 'Press <b>Esc</b> — this deck is already your copy of the editor.',
          fontSize: 17, fontWeight: 500, color: MIST, align: 'center',
        }),
        shape('rect', { x: 562, y: 644, w: 156, h: 44, radius: 22, fill: AMBER }),
        text({
          x: 562, y: 655, w: 156, h: 24, html: 'bento.page', fontSize: 16, fontWeight: 700,
          color: INK, align: 'center',
        }),
      ],
    }),
  ]

  return doc
}
