// The starter deck — what a freshly built Bento Slides file opens with.
//
// It is the product demo, the launch asset and the feature tour in one: every
// claim it makes is proven by the feature making it. A cast of four "bento
// tiles" (a amber, b blue, c paper, d ink) carries the SAME element ids
// through every slide, so each transition morphs them — position, size,
// color, solid⇄gradient. One deliberate 'fade' beat (the stats slide) exists
// because entrance staggers + count-ups only run on non-morph entries.
//
// Design system: ink #0F1724 grounds, warm paper #F6F4EF, amber #F7A600 as
// the single loud accent, blue #5B8DEF supporting. Uppercase tracked kickers,
// 800-weight heroes, quiet 15px captions.

import {
  newDoc, uid, defaultText, defaultShape, defaultChart,
  type BentoDoc, type Slide, type SlideElement, type TextElement, type ShapeElement,
} from './model'

const INK = '#0F1724'
const PANEL = '#1E2A3A'
const PAPER = '#F6F4EF'
const CARD_STROKE = '#E4DFD2'
const AMBER = '#F7A600'
const AMBER_SOFT = '#FFC23E'
const AMBER_DEEP = '#B87400'
const BLUE = '#5B8DEF'
const BLUE_SOFT = '#8FB0F2'
const MIST = '#B9C4D4'
const INK_SOFT = 'rgba(30, 42, 58, 0.72)'

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

// --- tiny builders ----------------------------------------------------------

const text = (p: Partial<TextElement>): TextElement =>
  ({ ...defaultText({ align: 'left', valign: 'top' }), ...p }) as TextElement

const shape = (kind: Parameters<typeof defaultShape>[0], p: Partial<ShapeElement>): ShapeElement =>
  ({ ...defaultShape(kind), stroke: 'transparent', strokeWidth: 0, ...p }) as ShapeElement

const kicker = (label: string, p: Partial<TextElement> = {}): TextElement =>
  text({
    id: KICKER, x: 96, y: 56, w: 700, h: 30, html: label,
    fontSize: 15, fontWeight: 700, color: AMBER, letterSpacing: 3.5, ...p,
  })

const title = (html: string, p: Partial<TextElement> = {}): TextElement =>
  text({
    id: TITLE, x: 92, y: 92, w: 900, h: 80, html,
    fontSize: 46, fontWeight: 800, color: INK, lineHeight: 1.08, ...p,
  })

const glow = (angle: number, stops: Array<{ at: number; color: string }>): ShapeElement =>
  shape('rect', {
    id: GLOW, x: 0, y: 0, w: 1280, h: 720, radius: 0,
    fill: 'transparent', fillGradient: { angle, stops },
    fx: { ambient: 'kenburns', ken: { dir: 'drift', scale: 1.06, duration: 34 } },
  })

// --- chart options (pure JSON, brand-styled) --------------------------------

const AXIS_PAPER = {
  axisLine: { lineStyle: { color: '#D8D2C4' } },
  axisTick: { show: false },
  axisLabel: { color: '#6B7280' },
}

const barOption = () => ({
  color: [AMBER, BLUE],
  tooltip: { trigger: 'axis' },
  legend: { bottom: 0, textStyle: { color: '#6B7280' } },
  grid: { left: 48, right: 16, top: 24, bottom: 56 },
  xAxis: { type: 'category', data: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], ...AXIS_PAPER },
  yAxis: { type: 'value', axisLabel: { color: '#6B7280' }, splitLine: { lineStyle: { color: '#EAE4D6' } } },
  dataZoom: [{ type: 'inside' }],
  series: [
    { type: 'bar', name: 'Views', itemStyle: { borderRadius: [6, 6, 0, 0] }, data: [42, 68, 54, 86, 73] },
    { type: 'bar', name: 'Edits', itemStyle: { borderRadius: [6, 6, 0, 0] }, data: [28, 35, 42, 51, 64] },
  ],
})

const pieOption = () => ({
  color: [AMBER, AMBER_SOFT, BLUE, BLUE_SOFT, PANEL],
  tooltip: { trigger: 'item' },
  legend: { bottom: 0, textStyle: { color: '#6B7280' } },
  series: [{
    type: 'pie', radius: ['34%', '62%'],
    label: { formatter: '{b} {d}%', color: '#4A5568' },
    itemStyle: { borderColor: PAPER, borderWidth: 3 },
    data: [
      { name: 'Mon', value: 42 }, { name: 'Tue', value: 68 }, { name: 'Wed', value: 54 },
      { name: 'Thu', value: 86 }, { name: 'Fri', value: 73 },
    ],
  }],
})

const trendOption = () => ({
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

export function starterDoc(): BentoDoc {
  const doc = newDoc()
  doc.title = 'Bento Slides Showcase'

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
        glow(135, [
          { at: 0, color: 'rgba(91,141,239,0.20)' },
          { at: 0.55, color: 'rgba(15,23,36,0)' },
          { at: 1, color: 'rgba(247,166,0,0.14)' },
        ]),
        // dashed orbit ring + travelling dot around the logo
        shape('ellipse', {
          x: 790, y: 110, w: 440, h: 440, fill: 'transparent',
          stroke: 'rgba(185,196,212,0.30)', strokeWidth: 1.5, strokeStyle: 'dashed',
          fx: { loop: { type: 'dash-march', distance: 16, duration: 5 } },
        }),
        shape('ellipse', {
          x: 999, y: 99, w: 22, h: 22, fill: AMBER,
          fx: { loop: { type: 'motion-path', duration: 22,
            path: 'M 0 0 C 121 0 220 99 220 220 C 220 341 121 440 0 440 C -121 440 -220 341 -220 220 C -220 99 -121 0 0 0' } },
        }),
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
        title('The file is<br>the software.', {
          x: 90, y: 96, w: 680, h: 220, fontSize: 84, color: '#FFFFFF',
          fx: { enter: 'fade-up', order: 1 },
        }),
        text({
          x: 96, y: 330, w: 560, h: 100,
          html: 'One HTML file — deck, viewer and editor together.<br>Open it anywhere. It saves itself.',
          fontSize: 22, color: MIST, lineHeight: 1.55,
          fx: { enter: 'fade-up', order: 3 },
        }),
        text({
          x: 96, y: 600, w: 600, h: 30,
          html: '→ to advance &nbsp;·&nbsp; Esc to edit &nbsp;·&nbsp; S for speaker view',
          fontSize: 15, color: 'rgba(185,196,212,0.65)',
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
        glow(180, [
          { at: 0, color: 'rgba(247,166,0,0.08)' },
          { at: 1, color: 'rgba(91,141,239,0.05)' },
        ]),
        kicker('ONE FILE', { color: AMBER_DEEP }),
        title('Everything ships inside.'),
        // marching outline around the anatomy card
        shape('rect', {
          x: 84, y: 198, w: 444, h: 424, radius: 28, fill: 'transparent',
          stroke: AMBER, strokeWidth: 2, strokeStyle: 'dashed',
          fx: { loop: { type: 'dash-march', distance: 18, duration: 1.6 } },
        }),
        shape('rect', { id: T_D, x: 96, y: 210, w: 420, h: 400, radius: 24, fill: '#FFFFFF', stroke: CARD_STROKE, strokeWidth: 1.5 }),
        shape('rect', { id: T_A, x: 120, y: 234, w: 372, h: 100, radius: 14, fill: AMBER }),
        shape('rect', { id: T_B, x: 120, y: 350, w: 372, h: 128, radius: 14, fill: BLUE }),
        shape('rect', { id: T_C, x: 120, y: 494, w: 372, h: 92, radius: 14, fill: '#EDE8DC' }),
        text({ x: 144, y: 258, w: 330, h: 60, html: '<b>your deck</b> — JSON in a &lt;script&gt; block', fontSize: 19, color: INK }),
        text({ x: 144, y: 380, w: 330, h: 70, html: '<b>viewer + presenter</b> — morphs, charts, speaker view', fontSize: 19, color: '#FFFFFF' }),
        text({ x: 144, y: 516, w: 330, h: 50, html: '<b>the editor itself</b> — press Esc, it’s right there', fontSize: 19, color: INK_SOFT }),
        text({
          x: 600, y: 226, w: 580, h: 300,
          html:
            '<b>Self-saving</b> — ⌘S rewrites this very file in place<br>' +
            '<b>No install, no account</b> — a browser is the whole runtime<br>' +
            '<b>Assets embedded</b> — images and fonts ride along as data<br>' +
            '<b>View-source honest</b> — your document is readable JSON',
          fontSize: 22, color: INK, lineHeight: 2.0,
        }),
        text({
          x: 600, y: 540, w: 560, h: 40,
          html: 'Updates? The file checks a signed manifest — <b>only when you ask</b> — and rewrites itself.',
          fontSize: 17, color: INK_SOFT, lineHeight: 1.5,
        }),
      ],
    }),

    // ── 3 · MORPH MANIFESTO ────────────────────────────────────────────────
    slide({
      notes:
        'The tiles scattered and grew — and picked up GRADIENT fills mid-morph (solid⇄gradient tweening). ' +
        'Press ← and → to replay it. Nothing here is a video; it’s the same four elements.',
      elements: [
        glow(20, [
          { at: 0, color: 'rgba(61,111,224,0.22)' },
          { at: 0.6, color: 'rgba(15,23,36,0)' },
          { at: 1, color: 'rgba(247,166,0,0.16)' },
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
        kicker('PRESENT', { x: 340, y: 216, w: 600, h: 30, align: 'center' }),
        title('Morph is the<br>native transition.', {
          x: 240, y: 254, w: 800, h: 200, fontSize: 72, color: '#FFFFFF', align: 'center',
        }),
        text({
          x: 340, y: 476, w: 600, h: 70,
          html: 'Shared ids animate between slides — position, size, color, <b>even gradients</b>.',
          fontSize: 21, color: MIST, align: 'center', lineHeight: 1.5,
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
        shape('rect', { id: T_D, x: 96, y: 84, w: 40, h: 40, radius: 10, fill: INK }),
        shape('rect', { id: T_B, x: 148, y: 84, w: 40, h: 40, radius: 10, fill: BLUE }),
        shape('rect', { id: T_A, x: 200, y: 84, w: 40, h: 40, radius: 10, fill: AMBER_SOFT }),
        shape('rect', { id: T_C, x: 252, y: 84, w: 40, h: 40, radius: 10, fill: PAPER }),
        kicker('NO MOVING PARTS', { y: 160, color: INK, fx: { enter: 'fade-up', order: 0 } }),
        title('Software with nothing<br>to install, break, or expire.', {
          y: 196, w: 1000, h: 130, color: INK, fontSize: 44,
          fx: { enter: 'fade-up', order: 1 },
        }),
        text({ x: 96, y: 370, w: 300, h: 130, html: '1', fontSize: 116, fontWeight: 800, color: INK, fx: { enter: 'fade-up', order: 2, countUp: true } }),
        text({ x: 512, y: 370, w: 300, h: 130, html: '0', fontSize: 116, fontWeight: 800, color: INK, fx: { enter: 'fade-up', order: 3, countUp: true } }),
        text({ x: 928, y: 370, w: 300, h: 130, html: '100%', fontSize: 116, fontWeight: 800, color: INK, fx: { enter: 'fade-up', order: 4, countUp: true } }),
        shape('line', { x: 100, y: 508, w: 130, h: 8, fill: INK, strokeWidth: 3, lineEnd: 'arrow', fx: { enter: 'fade', order: 5 } }),
        shape('line', { x: 516, y: 508, w: 130, h: 8, fill: INK, strokeWidth: 3, lineStart: 'dot', lineEnd: 'dot', fx: { enter: 'fade', order: 5 } }),
        shape('line', { x: 932, y: 508, w: 130, h: 8, fill: INK, strokeWidth: 3, lineStart: 'bar', lineEnd: 'bar', fx: { enter: 'fade', order: 5 } }),
        text({ x: 96, y: 530, w: 300, h: 40, html: 'file to send', fontSize: 21, fontWeight: 600, color: INK_SOFT, fx: { enter: 'fade', order: 6 } }),
        text({ x: 512, y: 530, w: 300, h: 40, html: 'servers required', fontSize: 21, fontWeight: 600, color: INK_SOFT, fx: { enter: 'fade', order: 6 } }),
        text({ x: 928, y: 530, w: 300, h: 40, html: 'yours, forever', fontSize: 21, fontWeight: 600, color: INK_SOFT, fx: { enter: 'fade', order: 6 } }),
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
        kicker('LIVE DATA', { color: AMBER_DEEP }),
        title('Charts with a pulse.'),
        shape('rect', { id: T_C, x: 72, y: 166, w: 828, h: 488, radius: 24, fill: '#FFFFFF', stroke: CARD_STROKE, strokeWidth: 1.5 }),
        { ...defaultChart(barOption()), id: CHART_MAIN, x: 96, y: 190, w: 780, h: 440, preset: 'bar' },
        shape('rect', { id: T_D, x: 920, y: 166, w: 264, h: 488, radius: 20, fill: PANEL }),
        shape('rect', { id: T_A, x: 944, y: 190, w: 44, h: 8, radius: 4, fill: AMBER }),
        text({
          x: 944, y: 220, w: 216, h: 220,
          html: '<b>Hover the bars</b> — tooltips are live.<br><br>Scroll or pinch inside the chart to zoom the data.',
          fontSize: 18, color: MIST, lineHeight: 1.6,
        }),
        shape('rect', {
          id: T_B, x: 944, y: 540, w: 216, h: 56, radius: 28, fill: BLUE,
          link: S_CHARTS_PIE,
        }),
        text({
          x: 944, y: 554, w: 216, h: 32, html: 'See the split →', fontSize: 18, fontWeight: 700,
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
        kicker('LIVE DATA', { color: AMBER_DEEP }),
        title('Same chart. New shape.'),
        shape('rect', { id: T_C, x: 72, y: 166, w: 828, h: 488, radius: 24, fill: '#FFFFFF', stroke: CARD_STROKE, strokeWidth: 1.5 }),
        { ...defaultChart(pieOption()), id: CHART_MAIN, x: 96, y: 190, w: 780, h: 440, preset: 'pie' },
        shape('rect', { id: T_D, x: 920, y: 166, w: 264, h: 488, radius: 20, fill: PANEL }),
        shape('rect', { id: T_A, x: 944, y: 190, w: 44, h: 8, radius: 4, fill: AMBER }),
        text({
          x: 944, y: 220, w: 216, h: 220,
          html: 'This slide is a <b>hidden state</b> — arrow keys skip it; only the click gets here.<br><br>The data morphed in place.',
          fontSize: 18, color: MIST, lineHeight: 1.6,
        }),
        shape('rect', {
          id: T_B, x: 944, y: 540, w: 216, h: 56, radius: 28, fill: BLUE,
          link: S_CHARTS,
        }),
        text({
          x: 944, y: 554, w: 216, h: 32, html: '← Back to bars', fontSize: 18, fontWeight: 700,
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
        glow(200, [
          { at: 0, color: 'rgba(247,166,0,0.10)' },
          { at: 0.5, color: 'rgba(15,23,36,0)' },
          { at: 1, color: 'rgba(61,111,224,0.16)' },
        ]),
        shape('rect', { id: T_D, x: 1132, y: 84, w: 52, h: 52, radius: 14, fill: PANEL, stroke: 'rgba(185,196,212,0.25)', strokeWidth: 1 }),
        shape('rect', { id: T_B, x: 1144, y: 96, w: 12, h: 28, radius: 4, fill: BLUE }),
        shape('rect', { id: T_A, x: 1160, y: 96, w: 14, h: 12, radius: 4, fill: AMBER }),
        shape('rect', { id: T_C, x: 1160, y: 112, w: 14, h: 12, radius: 4, fill: '#E9EDF3' }),
        kicker('STORY WITH DATA'),
        title('Momentum you can feel.', { color: '#FFFFFF' }),
        text({
          x: 900, y: 92, w: 220, h: 70, html: '+975%', fontSize: 54, fontWeight: 800, color: AMBER, align: 'right',
        }),
        { ...defaultChart(trendOption()), x: 64, y: 210, w: 1152, h: 440 },
      ],
    }),

    // ── 7 · MOTION & LINES ─────────────────────────────────────────────────
    slide({
      background: PAPER,
      notes:
        'The dots ride a motion path drawn with the on-canvas path editor; the dashes march underneath them. ' +
        'Paths are stored relative to the element, so you can drag the whole flow around.',
      elements: [
        kicker('MOTION', { color: AMBER_DEEP }),
        title('Lines that lead the eye.'),
        shape('rect', { id: T_D, x: 1080, y: 64, w: 104, h: 34, radius: 17, fill: '#FFFFFF', stroke: CARD_STROKE, strokeWidth: 1.5 }),
        shape('rect', { id: T_B, x: 1092, y: 72, w: 18, h: 18, radius: 6, fill: BLUE }),
        shape('rect', { id: T_A, x: 1116, y: 72, w: 18, h: 18, radius: 6, fill: AMBER }),
        shape('rect', { id: T_C, x: 1140, y: 72, w: 18, h: 18, radius: 6, fill: '#EDE8DC' }),
        // the flow: a dashed path with two dots riding it
        shape('path', {
          x: 140, y: 220, w: 1000, h: 340, fill: 'transparent',
          stroke: 'rgba(30,42,58,0.55)', strokeWidth: 2.5, strokeStyle: 'dashed',
          d: 'M 20 300 C 260 40 520 40 640 190 C 730 305 900 305 980 110',
          pathBox: [0, 0, 1000, 340],
          fx: { loop: { type: 'dash-march', distance: 20, duration: 1.8 } },
        }),
        shape('ellipse', {
          x: 150, y: 510, w: 20, h: 20, fill: AMBER,
          fx: { loop: { type: 'motion-path', duration: 8,
            path: 'M 0 0 C 240 -260 500 -260 620 -110 C 710 5 880 5 960 -190' } },
        }),
        text({ x: 330, y: 208, w: 220, h: 30, html: 'drafted', fontSize: 17, fontWeight: 700, color: INK_SOFT }),
        text({ x: 660, y: 436, w: 220, h: 30, html: 'reviewed', fontSize: 17, fontWeight: 700, color: INK_SOFT }),
        text({ x: 1044, y: 284, w: 200, h: 30, html: 'shipped', fontSize: 17, fontWeight: 700, color: AMBER_DEEP }),
        text({
          x: 96, y: 620, w: 900, h: 30,
          html: 'Two clicks in the editor: draw the path on canvas, set the loop time.',
          fontSize: 15, color: INK_SOFT,
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
        glow(160, [
          { at: 0, color: 'rgba(91,141,239,0.14)' },
          { at: 1, color: 'rgba(247,166,0,0.10)' },
        ]),
        kicker('FOCUS'),
        title('Point, and the room dims.', { color: '#FFFFFF' }),
        // card 1 — one file
        shape('rect', { x: 96, y: 230, w: 336, h: 330, radius: 20, fill: PANEL, stroke: 'rgba(185,196,212,0.18)', strokeWidth: 1.5, group: 'g-file' }),
        shape('rect', { id: T_A, x: 128, y: 262, w: 56, h: 56, radius: 16, fill: AMBER, group: 'g-file' }),
        text({ x: 128, y: 344, w: 272, h: 34, html: 'One file', fontSize: 22, fontWeight: 800, color: '#FFFFFF', group: 'g-file' }),
        text({
          x: 128, y: 388, w: 272, h: 130,
          html: 'Send it, archive it, open it in ten years. The runtime is pinned inside, so it never rots.',
          fontSize: 17, color: MIST, lineHeight: 1.6, group: 'g-file',
        }),
        // card 2 — morph
        shape('rect', { x: 472, y: 230, w: 336, h: 330, radius: 20, fill: PANEL, stroke: 'rgba(185,196,212,0.18)', strokeWidth: 1.5, group: 'g-morph' }),
        shape('rect', { id: T_B, x: 504, y: 262, w: 56, h: 56, radius: 16, fill: BLUE, group: 'g-morph' }),
        text({ x: 504, y: 344, w: 272, h: 34, html: 'Morph everything', fontSize: 22, fontWeight: 800, color: '#FFFFFF', group: 'g-morph' }),
        text({
          x: 504, y: 388, w: 272, h: 130,
          html: 'Slides share elements by id; transitions animate the difference. States and links make it interactive.',
          fontSize: 17, color: MIST, lineHeight: 1.6, group: 'g-morph',
        }),
        // card 3 — data
        shape('rect', { x: 848, y: 230, w: 336, h: 330, radius: 20, fill: PANEL, stroke: 'rgba(185,196,212,0.18)', strokeWidth: 1.5, group: 'g-data' }),
        shape('rect', { id: T_C, x: 880, y: 262, w: 56, h: 56, radius: 16, fill: '#E9EDF3', group: 'g-data' }),
        text({ x: 880, y: 344, w: 272, h: 34, html: 'Live data', fontSize: 22, fontWeight: 800, color: '#FFFFFF', group: 'g-data' }),
        text({
          x: 880, y: 388, w: 272, h: 130,
          html: 'Charts present as real instances — tooltips, zoom, and data that morphs between states.',
          fontSize: 17, color: MIST, lineHeight: 1.6, group: 'g-data',
        }),
        shape('rect', { id: T_D, x: 96, y: 176, w: 64, h: 8, radius: 4, fill: AMBER }),
        text({
          x: 96, y: 600, w: 700, h: 30, html: 'Hover the cards (works right now, while presenting).',
          fontSize: 15, color: 'rgba(185,196,212,0.65)',
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
        kicker('WRITING', { color: AMBER_DEEP }),
        title('Type markdown,<br>get typography.', { h: 130 }),
        shape('rect', { id: T_A, x: 96, y: 236, w: 64, h: 8, radius: 4, fill: AMBER }),
        shape('rect', { id: T_C, x: 96, y: 280, w: 520, h: 340, radius: 20, fill: '#FFFFFF', stroke: CARD_STROKE, strokeWidth: 1.5 }),
        text({ x: 128, y: 308, w: 300, h: 24, html: 'YOU TYPE', fontSize: 13, fontWeight: 700, color: AMBER_DEEP, letterSpacing: 2.5 }),
        text({
          x: 128, y: 348, w: 460, h: 240,
          html: '<code>**instant** *formatting*</code><br><code>- bullets as you type</code><br><code>`code` and ~~strike~~</code>',
          fontSize: 22, color: INK, lineHeight: 2.1,
        }),
        shape('line', { x: 636, y: 436, w: 116, h: 8, fill: 'rgba(30,42,58,0.5)', strokeWidth: 2.5, lineEnd: 'arrow' }),
        shape('rect', { id: T_D, x: 772, y: 280, w: 412, h: 340, radius: 20, fill: PANEL }),
        text({ x: 804, y: 308, w: 300, h: 24, html: 'YOU GET', fontSize: 13, fontWeight: 700, color: AMBER, letterSpacing: 2.5 }),
        text({
          x: 804, y: 348, w: 350, h: 240,
          html: '<b>instant</b> <i>formatting</i><br>•&nbsp; bullets as you type<br><code>code</code> and <s>strike</s>',
          fontSize: 22, color: '#FFFFFF', lineHeight: 2.1,
        }),
        shape('rect', { id: T_B, x: 1120, y: 64, w: 64, h: 34, radius: 17, fill: BLUE }),
        text({ x: 1120, y: 71, w: 64, h: 22, html: '⌘B', fontSize: 15, fontWeight: 700, color: '#FFFFFF', align: 'center' }),
      ],
    }),

    // ── 10 · CLOSE ─────────────────────────────────────────────────────────
    slide({
      notes:
        'The cast reassembles into the logo. Press Esc — this deck is already your copy of the app: ' +
        'edit it, save it, send it. bento.page has the latest build and the story.',
      elements: [
        glow(0, [
          { at: 0, color: 'rgba(247,166,0,0.12)' },
          { at: 0.55, color: 'rgba(15,23,36,0)' },
          { at: 1, color: 'rgba(91,141,239,0.14)' },
        ]),
        shape('ellipse', {
          x: 420, y: 60, w: 440, h: 440, fill: 'transparent',
          stroke: 'rgba(185,196,212,0.30)', strokeWidth: 1.5, strokeStyle: 'dashed',
          fx: { loop: { type: 'dash-march', distance: 16, duration: 5 } },
        }),
        shape('ellipse', {
          x: 629, y: 49, w: 22, h: 22, fill: AMBER,
          fx: { loop: { type: 'motion-path', duration: 22,
            path: 'M 0 0 C 121 0 220 99 220 220 C 220 341 121 440 0 440 C -121 440 -220 341 -220 220 C -220 99 -121 0 0 0' } },
        }),
        shape('rect', {
          id: T_D, x: 490, y: 130, w: 300, h: 300, radius: 64, fill: PANEL,
          stroke: 'rgba(185,196,212,0.28)', strokeWidth: 1.5,
        }),
        shape('rect', { id: T_B, x: 524, y: 164, w: 76, h: 232, radius: 16, fill: BLUE }),
        shape('rect', { id: T_A, x: 616, y: 164, w: 140, h: 104, radius: 16, fill: AMBER }),
        shape('rect', { id: T_C, x: 616, y: 280, w: 140, h: 116, radius: 16, fill: '#E9EDF3' }),
        kicker('YOUR TURN', { x: 340, y: 470, w: 600, h: 30, align: 'center' }),
        title('Make it yours.', { x: 340, y: 504, w: 600, h: 70, fontSize: 56, color: '#FFFFFF', align: 'center' }),
        text({
          x: 290, y: 590, w: 700, h: 40,
          html: 'Press <b>Esc</b> — this deck is already your copy of the editor.',
          fontSize: 19, color: MIST, align: 'center',
        }),
        text({
          x: 490, y: 636, w: 300, h: 30, html: 'bento.page', fontSize: 17, fontWeight: 700,
          color: AMBER, align: 'center', letterSpacing: 1,
        }),
      ],
    }),
  ]

  return doc
}
