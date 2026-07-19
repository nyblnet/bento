#!/usr/bin/env node
// The gallery decks — four distinct art directions distilled from
// Awwwards Site-of-the-Year style FAMILIES (immersive dark tech,
// editorial typography, premium minimal commerce, playful toy-like).
// All brands and content are FICTIONAL; nothing is copied from any site.
//
//   node scripts/build-example-decks.mjs [outDir]     (default: working/)
//
// Output: <outDir>/<name>.bento.html — each doc carries template:true, so
// every open instantiates a fresh, independent deck (the .dotx semantics).
// release.mjs runs this into site/gallery/ for the landing page's gallery.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const shell = readFileSync(join(root, 'slides/dist-single/Bento_Slides.bento.html'), 'utf8')

// the deck-embedded faces (same technique as the landing build)
const fontSrc = readFileSync(join(root, 'slides/src/fontdata.ts'), 'utf8')
const font = (name) => fontSrc.match(new RegExp(`export const ${name}\\s*=\\s*'(data:[^']+)'`))[1]
const FRAUNCES = font('FRAUNCES_900')
const INSTRUMENT = font('INSTRUMENT_VAR')
const FONTS = {
  assets: { 'font-fraunces': FRAUNCES, 'font-instrument': INSTRUMENT },
  fonts: [
    { family: 'Fraunces', asset: 'font-fraunces', weight: '900' },
    { family: 'Instrument Sans', asset: 'font-instrument', weight: '100 900' },
  ],
}
const FR = "Fraunces, Georgia, serif"
const IN = "'Instrument Sans', 'Helvetica Neue', sans-serif"
// Robust monospace stack. 'SF Mono' alone falls straight through to an ugly
// 'Courier New' in Chrome on macOS (Apple doesn't expose SF Mono to the web),
// so lead with ui-monospace and name the fonts that ARE reachable per platform.
const MONO_STACK = "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace"
const MONO = MONO_STACK

// public-domain photos (see scripts/gallery-photos/SOURCES.md), embedded as
// data-URI assets so the decks stay fully self-contained
const photo = (name) =>
  'data:image/jpeg;base64,' + readFileSync(join(root, 'scripts/gallery-photos', name)).toString('base64')

// embedded webfont files (woff2) — same technique as photo(), so a deck that
// wants a specific typeface stays self-contained instead of leaning on a
// system font that may not exist in the viewer's browser
const fontFile = (name) =>
  'data:font/woff2;base64,' + readFileSync(join(root, 'scripts/gallery-fonts', name)).toString('base64')

// ——— tiny builders ———————————————————————————————————————————————
let uid = 0
const id = (p) => `${p}-${(++uid).toString(36)}`
const text = (o) => ({
  id: o.id ?? id('t'), type: 'text', x: o.x, y: o.y, w: o.w, h: o.h,
  rotation: o.rotation ?? 0, opacity: o.opacity ?? 1,
  html: o.html, fontSize: o.fontSize ?? 24, fontFamily: o.fontFamily ?? IN,
  fontWeight: o.fontWeight ?? 400, color: o.color ?? '#111',
  align: o.align ?? 'left', valign: o.valign ?? 'top',
  lineHeight: o.lineHeight ?? 1.3,
  ...(o.letterSpacing != null ? { letterSpacing: o.letterSpacing } : {}),
  ...(o.fx ? { fx: o.fx } : {}), ...(o.link ? { link: o.link } : {}),
  ...(o.shadow ? { shadow: o.shadow } : {}), ...(o.group ? { group: o.group } : {}),
})
const shape = (kind, o) => ({
  id: o.id ?? id('s'), type: 'shape', shape: kind, x: o.x, y: o.y, w: o.w, h: o.h,
  rotation: o.rotation ?? 0, opacity: o.opacity ?? 1,
  fill: o.fill ?? '#000', stroke: o.stroke ?? 'none', strokeWidth: o.strokeWidth ?? 0,
  radius: o.radius ?? 0,
  ...(o.fillGradient ? { fillGradient: o.fillGradient } : {}),
  ...(o.strokeStyle ? { strokeStyle: o.strokeStyle } : {}),
  ...(o.d ? { d: o.d, pathBox: o.pathBox } : {}),
  ...(o.lineStart ? { lineStart: o.lineStart } : {}), ...(o.lineEnd ? { lineEnd: o.lineEnd } : {}),
  ...(o.fx ? { fx: o.fx } : {}), ...(o.link ? { link: o.link } : {}),
  ...(o.shadow ? { shadow: o.shadow } : {}), ...(o.group ? { group: o.group } : {}),
})
const chart = (o) => ({
  id: o.id ?? id('c'), type: 'chart', x: o.x, y: o.y, w: o.w, h: o.h,
  rotation: 0, opacity: 1, preset: o.preset ?? 'bar', option: o.option,
  ...(o.fx ? { fx: o.fx } : {}),
})
const img = (o) => ({
  id: o.id ?? id('im'), type: 'image', x: o.x, y: o.y, w: o.w, h: o.h,
  rotation: o.rotation ?? 0, opacity: o.opacity ?? 1,
  src: `asset:${o.asset}`, fit: o.fit ?? 'cover', radius: o.radius ?? 0,
  ...(o.fx ? { fx: o.fx } : {}), ...(o.shadow ? { shadow: o.shadow } : {}),
})
// embedded media (audio/video) as a data URI — same self-contained technique
// as photo(). Small clips embed; big ones should pass a URL in `src` instead.
const mediaFile = (name, mime) =>
  `data:${mime};base64,` + readFileSync(join(root, 'scripts/gallery-media', name)).toString('base64')
const media = (o) => ({
  id: o.id ?? id('m'), type: 'media', kind: o.kind, x: o.x, y: o.y, w: o.w, h: o.h,
  rotation: o.rotation ?? 0, opacity: o.opacity ?? 1, src: o.src,
  ...(o.poster ? { poster: o.poster } : {}),
  ...(o.fit ? { fit: o.fit } : {}), ...(o.radius != null ? { radius: o.radius } : {}),
  ...(o.controls != null ? { controls: o.controls } : {}),
  ...(o.autoplay ? { autoplay: o.autoplay } : {}), ...(o.loop ? { loop: o.loop } : {}),
  ...(o.muted ? { muted: o.muted } : {}),
  ...(o.fx ? { fx: o.fx } : {}), ...(o.shadow ? { shadow: o.shadow } : {}),
})
const slide = (o) => ({
  id: o.id ?? id('sl'), background: o.background, transition: o.transition ?? 'fade',
  notes: o.notes ?? '', elements: o.elements,
  ...(o.name ? { name: o.name } : {}), ...(o.stateOf ? { stateOf: o.stateOf } : {}),
  ...(o.hover ? { hover: o.hover } : {}),
})
const grad = (angle, ...stops) => ({
  angle, stops: stops.map(([at, color]) => ({ at, color })),
})
// orbit path relative to rest position (closed loop through rest).
// phase = where on the circle the rest position sits (0 = right, -PI/2 = top);
// squash < 1 flattens vertically for a floaty wobble, 1 = true circle.
const orbit = (r, phase = 0, squash = 0.6) => {
  const pts = []
  for (let i = 0; i <= 24; i++) {
    const a = phase + (i / 24) * Math.PI * 2
    pts.push(`${(Math.cos(a) - Math.cos(phase)) * r},${(Math.sin(a) - Math.sin(phase)) * r * squash}`)
  }
  return `M0,0 L${pts.slice(1).join(' L')} Z`
}

// organic wander (Lissajous): different x/y frequencies trace a smooth figure-8
// instead of a mechanical circle. Path is relative to rest and closed (returns
// to start). fx/fy must be integers so the curve closes cleanly.
const drift = (ax, ay, fx, fy, px = 0, py = 0) => {
  const N = 72, x0 = ax * Math.sin(px), y0 = ay * Math.sin(py), pts = []
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2
    pts.push(`${(ax * Math.sin(fx * t + px) - x0).toFixed(1)},${(ay * Math.sin(fy * t + py) - y0).toFixed(1)}`)
  }
  return `M0,0 L${pts.slice(1).join(' L')} Z`
}

const doc = (o) => ({
  format: 'bento/slides', version: 1, title: o.title,
  size: { width: 1280, height: 720 },
  theme: o.theme, template: true,
  ...(o.withFonts ? { assets: { ...FONTS.assets, ...(o.assets ?? {}) }, fonts: [...FONTS.fonts, ...(o.fonts ?? [])] }
    : (o.assets ? { assets: o.assets, ...(o.fonts ? { fonts: o.fonts } : {}) } : {})),
  ...(o.present ? { present: o.present } : {}),
  slides: o.slides, modified: new Date().toISOString(),
})

// ═══════════════════════════════════════════════════════════════════════
// DECK A · «SIGNAL» — editorial-typographic (Rynzhuk / Locomotive family)
// Bone paper, ink, one violent red. Type IS the layout.
// ═══════════════════════════════════════════════════════════════════════
function deckSignal() {
  const BONE = '#EFEDE4', INK = '#141310', RED = '#E8442E', GREY = 'rgba(20,19,16,0.55)'
  const HAIR = 'rgba(20,19,16,0.22)'
  const kick = (x, y, s, color = RED) => text({ x, y, w: 500, h: 24, html: s, fontSize: 13, fontWeight: 700, letterSpacing: 4, color, fontFamily: IN })
  const rule = (x, y, w) => shape('rect', { x, y, w, h: 2, fill: INK })
  const pageNo = (n) => text({ x: 1150, y: 654, w: 80, h: 24, html: n, fontSize: 13, fontWeight: 600, color: GREY, align: 'right', fontFamily: MONO })

  const s1 = slide({
    id: 'sig-cover', background: INK, transition: 'none',
    notes: 'TEMPLATE — “Signal”, an editorial-typographic deck. The cover is the poster: a full-bleed public-domain photograph under a deep ink scrim (one rect, no filters) with the masthead type reversed to bone. Slide 2 cuts back to paper. The red bar and the title share ids with slide 2 — they MORPH.',
    elements: [
      img({ asset: 'ph-press', x: 0, y: 0, w: 1280, h: 720, fx: { ambient: 'kenburns', ken: { dir: 'drift', scale: 1.07, duration: 24 } } }),
      shape('rect', { x: 0, y: 0, w: 1280, h: 720, fill: 'rgba(20,19,16,0.62)' }),
      kick(96, 84, 'SIGNAL — A FESTIVAL OF GRAPHIC IDEAS', BONE),
      shape('rect', { x: 96, y: 118, w: 1088, h: 2, fill: 'rgba(239,237,228,0.7)' }),
      text({ id: 'sig-title', x: 86, y: 128, w: 1120, h: 330, html: 'Loud<br>letters.', fontSize: 168, fontFamily: FR, fontWeight: 900, color: BONE, lineHeight: 0.92, shadow: { y: 3, blur: 26, color: 'rgba(20,19,16,0.4)' } }),
      shape('rect', { id: 'sig-bar', x: 96, y: 520, w: 320, h: 74, fill: RED }),
      text({ x: 442, y: 524, w: 560, h: 80, html: 'Three days on typography, grids,<br>and the confidence to be simple.', fontSize: 19, color: 'rgba(239,237,228,0.85)', lineHeight: 1.5, fx: { enter: 'fade-up', order: 1 } }),
      text({ x: 96, y: 536, w: 320, h: 40, html: 'OCT 12—14', fontSize: 26, fontWeight: 800, color: BONE, align: 'center', fontFamily: IN, letterSpacing: 3 }),
      text({ x: 96, y: 640, w: 800, h: 24, html: 'HALL 6 · MAKETOWN · TICKETS AT THE DOOR · PHOTO: LIBRARY OF CONGRESS, 1942', fontSize: 12, fontWeight: 600, letterSpacing: 3, color: 'rgba(239,237,228,0.6)' }),
      text({ x: 1150, y: 654, w: 80, h: 24, html: '01', fontSize: 13, fontWeight: 600, color: 'rgba(239,237,228,0.6)', align: 'right', fontFamily: MONO }),
    ],
  })

  const s2 = slide({
    id: 'sig-manifesto', background: BONE, transition: 'morph',
    notes: 'The morph beat: the red bar became a column, the title shrank into a corner. Duplicate-and-rearrange is the entire animation technique.',
    elements: [
      text({ id: 'sig-title', x: 96, y: 84, w: 500, h: 80, html: 'Loud letters.', fontSize: 40, fontFamily: FR, fontWeight: 900, color: GREY, lineHeight: 1 }),
      shape('rect', { id: 'sig-bar', x: 96, y: 170, w: 10, h: 450, fill: RED }),
      text({ x: 150, y: 168, w: 980, h: 380, html: 'We believe a poster can<br>argue, a grid can dance,<br>and <i>restraint</i> is the<br>loudest move of all.', fontSize: 62, fontFamily: FR, fontWeight: 900, color: INK, lineHeight: 1.14, fx: { enter: 'fade-up' } }),
      text({ x: 150, y: 580, w: 700, h: 30, html: '— The programme committee, writing manifestos again', fontSize: 15, color: GREY, fx: { enter: 'fade-up', order: 2 } }),
      pageNo('02'),
    ],
  })

  const speakers = [
    ['A', 'Ada Kessler', 'Grids that misbehave'],
    ['B', 'Bruno Mächler', 'The end of the hero image'],
    ['C', 'Chiyo Tanaka', 'Serifs, sharpened'],
  ]
  const s3 = slide({
    id: 'sig-speakers', background: INK, transition: 'fade',
    notes: 'Inverted spread. The huge index letters are the “image”. Stagger order walks the three rows in.',
    elements: [
      kick(96, 84, 'THE SPEAKERS', RED),
      shape('rect', { x: 96, y: 118, w: 1088, h: 2, fill: 'rgba(239,237,228,0.25)' }),
      ...speakers.flatMap(([ltr, name, topic], i) => [
        text({ x: 80, y: 130 + i * 165, w: 220, h: 180, html: ltr, fontSize: 150, fontFamily: FR, fontWeight: 900, color: 'rgba(239,237,228,0.13)', fx: { enter: 'fade-up', order: i } }),
        text({ x: 270, y: 176 + i * 165, w: 500, h: 60, html: name, fontSize: 40, fontFamily: FR, fontWeight: 900, color: BONE, fx: { enter: 'fade-up', order: i } }),
        text({ x: 800, y: 190 + i * 165, w: 384, h: 40, html: topic.toUpperCase(), fontSize: 14, fontWeight: 600, letterSpacing: 3, color: RED, align: 'right', fx: { enter: 'fade-up', order: i } }),
        shape('rect', { x: 270, y: 268 + i * 165, w: 914, h: 1, fill: 'rgba(239,237,228,0.18)' }),
      ]),
      pageNo('03'),
    ],
  })

  const s3b = slide({
    id: 'sig-floor', background: INK, transition: 'fade',
    notes: 'The photo essay beat. A full-bleed public-domain photograph (Marjory Collins, New York Times pressroom, 1942 — Library of Congress) with a slow ken-burns drift, an ink scrim, and one serif line. A DIFFERENT frame from the cover shot on purpose — the cover sets the type, this beat prints it. Swap the photo, keep the recipe: image → scrim → words.',
    elements: [
      img({ asset: 'ph-press2', x: 0, y: 0, w: 1280, h: 720, fx: { ambient: 'kenburns', ken: { dir: 'drift', scale: 1.09, duration: 22 } } }),
      shape('rect', { x: 0, y: 0, w: 1280, h: 720, fill: 'rgba(15,14,11,0.58)' }),
      shape('rect', { x: 0, y: 430, w: 1280, h: 290, fill: 'rgba(15,14,11,0.4)', fillGradient: grad(180, [0, 'rgba(15,14,11,0)'], [1, 'rgba(15,14,11,0.85)']) }),
      kick(96, 96, 'THE FLOOR'),
      shape('rect', { x: 96, y: 130, w: 220, h: 2, fill: RED }),
      text({ x: 90, y: 420, w: 1000, h: 220, html: 'Set by hand,<br>read by thousands.', fontSize: 76, fontFamily: FR, fontWeight: 900, color: BONE, lineHeight: 1.02, fx: { enter: 'fade-up' } }),
      text({ x: 96, y: 640, w: 900, h: 24, html: 'NEW YORK TIMES PRESSROOM, 1942 · LIBRARY OF CONGRESS — PUBLIC DOMAIN', fontSize: 10, fontWeight: 600, letterSpacing: 3, color: 'rgba(239,237,228,0.55)', fx: { enter: 'fade-up', order: 2 } }),
      text({ x: 1150, y: 654, w: 80, h: 24, html: '04', fontSize: 13, fontWeight: 600, color: 'rgba(239,237,228,0.6)', align: 'right', fontFamily: MONO }),
    ],
  })

  const s4 = slide({
    id: 'sig-schedule', background: BONE, transition: 'fade',
    notes: 'A dead-simple bar chart, art-directed: ink bars, one red. Charts are template JSON — swap the numbers.',
    elements: [
      kick(96, 84, 'ATTENDANCE, FIVE EDITIONS'),
      rule(96, 118, 1088),
      text({ x: 96, y: 148, w: 900, h: 80, html: 'Word travels.', fontSize: 64, fontFamily: FR, fontWeight: 900, color: INK }),
      chart({ x: 96, y: 260, w: 1088, h: 380, preset: 'bar', option: {
        grid: { left: 40, right: 10, top: 20, bottom: 30 },
        xAxis: { type: 'category', data: ['2022', '2023', '2024', '2025', '2026'] },
        yAxis: { type: 'value' },
        series: [{ type: 'bar', data: [420, 780, 1300, 2450, 4100],
          itemStyle: { color: INK }, barWidth: 90 }],
        color: [INK],
        tooltip: { trigger: 'item', formatter: '{b}: {c} people' },
      }, fx: { enter: 'fade-up', order: 1 } }),
      shape('rect', { x: 996, y: 300, w: 90, h: 24, fill: RED, fx: { enter: 'fade', order: 3 } }),
      text({ x: 940, y: 268, w: 200, h: 30, html: '<b>SOLD OUT</b>', fontSize: 13, letterSpacing: 3, color: RED, align: 'center', fx: { enter: 'fade', order: 3 } }),
      pageNo('05'),
    ],
  })

  const s5 = slide({
    id: 'sig-marquee', background: RED, transition: 'zoom',
    notes: 'The shout slide. Dash-march on the two rules makes the page feel like it is sliding. One background change resets the room.',
    elements: [
      shape('line', { x: 0, y: 140, w: 1280, h: 4, fill: BONE, strokeWidth: 3, strokeStyle: 'dashed', fx: { loop: { type: 'dash-march', distance: 60, duration: 2.4 } } }),
      text({ x: 40, y: 210, w: 1200, h: 300, html: 'SAY IT<br>BIGGER.', fontSize: 150, fontFamily: IN, fontWeight: 900, color: BONE, align: 'center', lineHeight: 0.95, letterSpacing: 2 }),
      shape('line', { x: 0, y: 566, w: 1280, h: 4, fill: BONE, strokeWidth: 3, strokeStyle: 'dashed', fx: { loop: { type: 'dash-march', distance: 60, duration: 2.4 } } }),
      text({ x: 40, y: 600, w: 1200, h: 30, html: 'WORKSHOP TRACK · 40 SEATS · BRING SCISSORS', fontSize: 13, fontWeight: 700, letterSpacing: 5, color: 'rgba(239,237,228,0.8)', align: 'center' }),
    ],
  })

  const s6 = slide({
    id: 'sig-end', background: BONE, transition: 'morph',
    notes: 'Close where you opened — the bar and title morph home. End on the practical line.',
    elements: [
      kick(96, 84, 'SIGNAL — OCT 12—14'),
      rule(96, 118, 1088),
      text({ id: 'sig-title', x: 86, y: 150, w: 1120, h: 300, html: 'See you<br>in Hall 6.', fontSize: 132, fontFamily: FR, fontWeight: 900, color: INK, lineHeight: 0.95 }),
      shape('rect', { id: 'sig-bar', x: 96, y: 520, w: 1088, h: 74, fill: RED }),
      text({ x: 96, y: 540, w: 1088, h: 40, html: 'signal-festival.example — a fictional event for a very real template', fontSize: 16, fontWeight: 600, color: BONE, align: 'center', letterSpacing: 1 }),
      pageNo('07'),
    ],
  })

  return doc({
    title: 'Signal — editorial type template', withFonts: true,
    assets: {
      'ph-press': photo('signal-press.jpg'),
      'ph-press2': photo('signal-press2.jpg'),
    },
    theme: { background: BONE, color: INK, accent: RED, fontFamily: IN },
    slides: [s1, s2, s3, s3b, s4, s5, s6],
  })
}

// ═══════════════════════════════════════════════════════════════════════
// DECK B · «TERRA» — premium minimal commerce (Build-in-Amsterdam family)
// Warm white, clay, sand. Whitespace is the luxury.
// ═══════════════════════════════════════════════════════════════════════
function deckTerra() {
  const WHITE = '#F7F5F0', CLAY = '#C96F4A', SAND = '#D9C9B4', CHAR = '#2A2724'
  const SOFT = 'rgba(42,39,36,0.55)'
  const GRAD_CLAY = grad(20, [0, '#D97E58'], [1, '#B85C38'])
  const GRAD_SAND = grad(0, [0, '#E3D5C2'], [1, '#CDBBA1'])
  const GRAD_MOSS = grad(15, [0, '#8D9376'], [1, '#6F755C'])
  const GRAD_MOSS_LIT = grad(20, [0, '#AEB394'], [1, '#7E846A'])
  const kick = (x, y, s) => text({ x, y, w: 600, h: 22, html: s, fontSize: 12, fontWeight: 600, letterSpacing: 5, color: CLAY })

  const s1 = slide({
    id: 'ter-cover', background: WHITE, transition: 'none',
    notes: 'TEMPLATE — “Terra”, premium product-brand deck. The commerce classic: a SPLIT COVER — copy breathes on white, a full-height product photograph owns the right edge (ken-burns drift), and two photo pills straddle the seam. The three “vessels” morph into the collection grid on slide 3.',
    elements: [
      // big, soft celadon glaze orbs — glide right across the panel on slow,
      // gently-curved arcs (wide flat ellipses), sitting BEHIND the type and the
      // product photo so they pass behind everything: layered ambient depth
      shape('ellipse', { x: 278, y: 108, w: 384, h: 384, opacity: 0.13, fill: '#8D9376', fillGradient: GRAD_MOSS, shadow: { blur: 64, color: 'rgba(141,147,118,0.20)' }, fx: { loop: { type: 'motion-path', path: orbit(320, Math.PI / 2, 0.16), duration: 44 } } }),
      shape('ellipse', { id: 'ter-c', x: 535, y: 305, w: 250, h: 250, opacity: 0.16, fill: '#8D9376', fillGradient: GRAD_MOSS_LIT, shadow: { blur: 52, color: 'rgba(141,147,118,0.18)' }, fx: { loop: { type: 'motion-path', path: orbit(300, -Math.PI / 2, 0.20), duration: 38 } } }),
      shape('ellipse', { x: 584, y: 139, w: 192, h: 192, opacity: 0.18, fill: '#8D9376', fillGradient: GRAD_MOSS_LIT, shadow: { blur: 44, color: 'rgba(141,147,118,0.18)' }, fx: { loop: { type: 'motion-path', path: orbit(340, Math.PI / 2, 0.13), duration: 33 } } }),
      img({ asset: 'ph-vase-goat', x: 800, y: 0, w: 480, h: 720, fx: { ambient: 'kenburns', ken: { dir: 'drift', scale: 1.06, duration: 20 } } }),
      shape('rect', { x: 800, y: 0, w: 480, h: 720, fill: 'rgba(42,39,36,0.08)' }),
      kick(96, 96, 'TERRA OBJECTS — COLLECTION Nº4'),
      text({ x: 90, y: 150, w: 700, h: 260, html: 'Quiet things,<br>well made.', fontSize: 92, fontFamily: FR, fontWeight: 900, color: CHAR, lineHeight: 1.02 }),
      text({ x: 96, y: 430, w: 480, h: 80, html: 'Thrown, glazed and fired in one workshop.<br>Forty-one objects. No two alike.', fontSize: 17, color: SOFT, lineHeight: 1.6, fx: { enter: 'fade-up', order: 1 } }),
      // the two vessel pills slide in from the right edge (from behind the
      // product photo), staggered; each pill + its photo share order so they
      // travel together. The photos keep their ken-burns (scale) — the slide
      // uses the x channel, so the two coexist.
      shape('rect', { id: 'ter-a', x: 700, y: 110, w: 190, h: 280, radius: 95, fill: CLAY, fillGradient: GRAD_CLAY, shadow: { y: 24, blur: 50, color: 'rgba(42,39,36,0.28)' }, fx: { enter: 'slide-left', order: 2 } }),
      img({ asset: 'ph-vase-jay', x: 707, y: 117, w: 176, h: 266, radius: 88, fx: { ambient: 'kenburns', ken: { dir: 'drift', scale: 1.03, duration: 12 }, enter: 'slide-left', order: 2 } }),
      shape('rect', { id: 'ter-b', x: 646, y: 440, w: 140, h: 200, radius: 70, fill: SAND, fillGradient: GRAD_SAND, shadow: { y: 18, blur: 40, color: 'rgba(42,39,36,0.22)' }, fx: { enter: 'slide-left', order: 3 } }),
      img({ asset: 'ph-vase-classic', x: 652, y: 446, w: 128, h: 188, radius: 64, fx: { ambient: 'kenburns', ken: { dir: 'drift', scale: 1.035, duration: 15 }, enter: 'slide-left', order: 3 } }),
      text({ x: 96, y: 620, w: 500, h: 22, html: 'SPRING 2026 · EDITION OF 41', fontSize: 11, fontWeight: 600, letterSpacing: 4, color: SOFT }),
      text({ x: 900, y: 668, w: 360, h: 20, html: 'MET MUSEUM OPEN ACCESS · CC0', fontSize: 9, fontWeight: 600, letterSpacing: 3, color: 'rgba(247,245,240,0.75)', align: 'right' }),
    ],
  })

  const s2 = slide({
    id: 'ter-craft', background: CHAR, transition: 'fade',
    notes: 'The dark interlude — one sentence, one photographed object (Met Museum open access, CC0). The pill mask is just the image element’s radius; ken-burns “out” settles it as the slide enters.',
    elements: [
      img({ asset: 'ph-vase-goat', x: 700, y: 90, w: 380, h: 540, radius: 190, shadow: { blur: 90, color: 'rgba(255,238,214,0.16)' }, fx: { ambient: 'kenburns', ken: { dir: 'out', scale: 1.1, duration: 2.2 } } }),
      kick(96, 120, 'THE WORKSHOP'),
      text({ x: 90, y: 180, w: 560, h: 320, html: 'Each piece<br>spends nine<br>days in fire.', fontSize: 72, fontFamily: FR, fontWeight: 900, color: WHITE, lineHeight: 1.06, fx: { enter: 'fade-up' } }),
      text({ x: 96, y: 540, w: 460, h: 60, html: 'Cone 10 reduction. Ash glaze from our own orchard prunings.', fontSize: 16, color: 'rgba(247,245,240,0.6)', lineHeight: 1.6, fx: { enter: 'fade-up', order: 2 } }),
      text({ x: 700, y: 650, w: 380, h: 20, html: 'MET MUSEUM OPEN ACCESS · CC0', fontSize: 9, fontWeight: 600, letterSpacing: 3, color: 'rgba(247,245,240,0.35)', align: 'center' }),
    ],
  })

  const items = [
    ['Vessel 12', '€240', 'ph-vase-jay', GRAD_CLAY],
    ['Bowl 07', '€120', 'ph-vase-goat', GRAD_SAND],
    ['Vase 31', '€310', 'ph-vase-classic', GRAD_MOSS],
  ]
  const s3 = slide({
    id: 'ter-collection', background: WHITE, transition: 'morph',
    notes: 'The commerce grid — real product photography (Met open access, CC0) in the cards, and the three cover vessels MORPH down into the little glaze swatches beside each price. Same ids, new role.',
    elements: [
      kick(96, 96, 'THE COLLECTION'),
      text({ x: 90, y: 140, w: 700, h: 70, html: 'Forty-one objects.', fontSize: 54, fontFamily: FR, fontWeight: 900, color: CHAR }),
      ...items.flatMap(([name, price, ph, g], i) => {
        const x = 96 + i * 376
        const ids = ['ter-a', 'ter-b', 'ter-c'][i]
        const kind = i === 2 ? 'ellipse' : 'rect'
        return [
          shape('rect', { x, y: 250, w: 336, h: 330, radius: 18, fill: '#FFFFFF', shadow: { y: 16, blur: 38, color: 'rgba(42,39,36,0.1)' }, fx: { enter: 'fade-up', order: i } }),
          img({ asset: ph, x: x + 20, y: 270, w: 296, h: 214, radius: 12, fx: { enter: 'fade-up', order: i } }),
          text({ x: x + 24, y: 500, w: 200, h: 30, html: name, fontSize: 20, fontWeight: 600, color: CHAR, fx: { enter: 'fade-up', order: i } }),
          shape(kind, { id: ids, x: x + 190, y: 502, w: 22, h: 22, radius: i === 0 ? 11 : 6, fill: '#ccc', fillGradient: g, shadow: { y: 3, blur: 8, color: 'rgba(42,39,36,0.3)' } }),
          text({ x: x + 216, y: 500, w: 96, h: 30, html: price, fontSize: 18, fontWeight: 600, color: CLAY, align: 'right', fontFamily: MONO, fx: { enter: 'fade-up', order: i } }),
        ]
      }),
      text({ x: 96, y: 632, w: 700, h: 22, html: 'EVERY OBJECT SHIPS WITH ITS FIRING CARD · PHOTOGRAPHY: MET OPEN ACCESS (CC0)', fontSize: 11, fontWeight: 600, letterSpacing: 4, color: SOFT }),
    ],
  })

  const s4 = slide({
    id: 'ter-materials', background: WHITE, transition: 'fade',
    notes: 'Editorially-styled pie: material sourcing. The template shows how to make charts feel branded — palette + a serif headline beat any default theme.',
    elements: [
      kick(96, 96, 'WHAT THINGS ARE MADE OF'),
      text({ x: 90, y: 140, w: 800, h: 70, html: 'Sourced within 40 km.', fontSize: 54, fontFamily: FR, fontWeight: 900, color: CHAR }),
      chart({ x: 90, y: 240, w: 620, h: 420, preset: 'pie', option: {
        color: [CLAY, '#D9C9B4', '#8D9376', '#2A2724'],
        tooltip: { trigger: 'item', formatter: '{b}: {d}%' },
        legend: { bottom: 0 },
        series: [{ type: 'pie', radius: ['45%', '72%'],
          data: [
            { name: 'River clay', value: 46 }, { name: 'Orchard ash', value: 24 },
            { name: 'Field feldspar', value: 18 }, { name: 'Recycled grog', value: 12 },
          ], label: { show: false } }],
      }, fx: { enter: 'fade-up' } }),
      text({ x: 780, y: 300, w: 400, h: 220, html: 'The glaze palette is literally<br>the landscape — clay from the<br>river bend, ash from winter<br>prunings, feldspar from the<br>neighbour’s field.', fontSize: 19, color: SOFT, lineHeight: 1.65, fx: { enter: 'fade-up', order: 2 } }),
    ],
  })

  const s5 = slide({
    id: 'ter-end', background: SAND, transition: 'fade',
    notes: 'Soft close. Swap the address, keep the hush.',
    elements: [
      text({ x: 140, y: 220, w: 1000, h: 200, html: 'Come hold them.', fontSize: 88, fontFamily: FR, fontWeight: 900, color: CHAR, align: 'center', lineHeight: 1 }),
      text({ x: 140, y: 430, w: 1000, h: 30, html: 'SHOWROOM — KILN LANE 4 · SATURDAYS 10—16', fontSize: 13, fontWeight: 600, letterSpacing: 5, color: 'rgba(42,39,36,0.65)', align: 'center' }),
      shape('rect', { x: 604, y: 500, w: 72, h: 6, radius: 3, fill: CLAY }),
    ],
  })

  return doc({
    title: 'Terra — premium product template', withFonts: true,
    assets: {
      'ph-vase-jay': photo('terra-v1.jpg'),
      'ph-vase-goat': photo('terra-v2.jpg'),
      'ph-vase-classic': photo('terra-v3.jpg'),
    },
    theme: { background: WHITE, color: CHAR, accent: CLAY, fontFamily: IN },
    slides: [s1, s2, s3, s4, s5],
  })
}

// ═══════════════════════════════════════════════════════════════════════
// DECK C · «ORBITAL» — immersive dark tech (Lusion / Active Theory family)
// Void black, electric cyan→violet gradients, glow, orbiting particles.
// ═══════════════════════════════════════════════════════════════════════
function deckOrbital() {
  // Orbital embeds Space Mono (OFL) for its HUD-style technical labels — the
  // deck's mono was the one place a system font ('SF Mono') showed through as
  // Courier in Chrome. Embedding keeps the readouts crisp and on-brand
  // everywhere; MONO shadows the module const for this deck only.
  const MONO = "'Space Mono', " + MONO_STACK
  const VOID = '#05060E', DEEP = '#0B0E1E', CYAN = '#38E1FF', VIOLET = '#7A5CFF', MAG = '#FF4FA3'
  const DIM = 'rgba(178,196,224,0.62)'
  const GRAD_CY = grad(30, [0, CYAN], [1, VIOLET])
  const GRAD_MG = grad(30, [0, VIOLET], [1, MAG])
  const glow = (c, blur = 40) => ({ blur, color: c })
  const mono = (x, y, s, color = DIM, size = 12) => text({ x, y, w: 700, h: 22, html: s, fontSize: size, fontWeight: 500, letterSpacing: 3, color, fontFamily: MONO })
  const star = (x, y, size, dur, phase) => shape('ellipse', {
    x, y, w: size, h: size, fill: 'rgba(184,222,255,0.8)',
    shadow: glow('rgba(56,225,255,0.5)', 10),
    fx: { loop: { type: 'motion-path', path: orbit(14 + size * 2, phase), duration: dur } },
  })
  // A satellite in low orbit: a small craft (a glowing dash) that tracks a wide,
  // shallow arc across the sky — the tiny `squash` flattens the orbit ellipse to
  // an edge-on pass, so it sweeps in from one edge, arcs over the limb, and exits
  // the other (then loops round the far side). Slow, phase-offset so the sky is
  // never crowded; rides behind the ring + wordmark. Beats aimless floating dots.
  const satellite = (x, y, rx, squash, dur, phase) => shape('ellipse', {
    x, y, w: 3, h: 3, fill: 'rgba(233,246,255,1)',
    shadow: glow('rgba(120,215,255,0.9)', 6),
    fx: { loop: { type: 'motion-path', path: orbit(rx, phase, squash), duration: dur } },
  })

  const s1 = slide({
    id: 'orb-cover', background: VOID, transition: 'none',
    notes: 'TEMPLATE — “Orbital”, immersive dark-tech deck. Style family: void black, one luminous gradient — over REAL sky: the backdrop is a sunlit Earth from the ISS (NASA, public domain; ISS007-E-10807), the sun flaring at the top behind the orbit dot, dimmed under a scrim (image opacity 0.6) so the type stays lit. Three satellites track wide low-orbit arcs across the sky behind the ring. The ring and wordmark morph through the whole deck.',
    elements: [
      img({ asset: 'ph-stars', x: 0, y: 0, w: 1280, h: 720, opacity: 0.6, fx: { ambient: 'kenburns', ken: { dir: 'drift', scale: 1.09, duration: 28 } } }),
      shape('rect', { x: 0, y: 0, w: 1280, h: 720, fill: 'rgba(5,6,14,0.45)', fillGradient: grad(180, [0, 'rgba(5,6,14,0.6)'], [0.55, 'rgba(5,6,14,0.25)'], [1, 'rgba(5,6,14,0.7)']) }),
      satellite(560, 168, 540, 0.14, 44, Math.PI / 2),
      satellite(1340, 240, 700, 0.15, 54, 0),
      satellite(-60, 300, 860, 0.10, 62, Math.PI),
      shape('ellipse', { id: 'orb-ring', x: 440, y: 120, w: 400, h: 400, fill: 'rgba(0,0,0,0)', stroke: CYAN, strokeWidth: 2, shadow: glow('rgba(56,225,255,0.45)', 60) }),
      shape('ellipse', { x: 610, y: 90, w: 60, h: 60, fill: CYAN, fillGradient: GRAD_CY, shadow: glow('rgba(56,225,255,0.8)', 30), fx: { loop: { type: 'motion-path', path: orbit(200, -Math.PI / 2, 1), duration: 14 } } }),
      text({ id: 'orb-word', x: 140, y: 260, w: 1000, h: 130, html: 'ORBITAL', fontSize: 110, fontWeight: 800, color: '#EAF4FF', align: 'center', letterSpacing: 30, fontFamily: IN, shadow: glow('rgba(56,225,255,0.35)', 40) }),
      text({ x: 140, y: 400, w: 1000, h: 24, html: 'LOW-ORBIT DATA · A FICTIONAL COMPANY FOR A REAL TEMPLATE', fontSize: 12, fontWeight: 500, letterSpacing: 3, color: DIM, align: 'center', fontFamily: MONO }),
      text({ x: 140, y: 616, w: 1000, h: 24, html: '— PRESS → TO ENTER THE SYSTEM —', fontSize: 11, fontWeight: 500, letterSpacing: 3, color: 'rgba(178,196,224,0.4)', align: 'center', fontFamily: MONO }),
    ],
  })

  const s2 = slide({
    id: 'orb-thesis', background: VOID, transition: 'morph',
    notes: 'Ring morphs off-center and shrinks; the wordmark docks top-left. Big statements sit on the darkness — no boxes needed.',
    elements: [
      text({ id: 'orb-word', x: 96, y: 70, w: 300, h: 40, html: 'ORBITAL', fontSize: 22, fontWeight: 800, color: DIM, letterSpacing: 10, fontFamily: IN }),
      shape('ellipse', { id: 'orb-ring', x: 880, y: 180, w: 620, h: 620, fill: 'rgba(0,0,0,0)', stroke: VIOLET, strokeWidth: 2, shadow: glow('rgba(122,92,255,0.4)', 70) }),
      mono(96, 170, '01 · THE THESIS', CYAN),
      text({ x: 96, y: 210, w: 900, h: 300, html: 'Every satellite is<br>a sensor. Nobody<br>reads the sky.', fontSize: 76, fontWeight: 800, color: '#EAF4FF', lineHeight: 1.1, fontFamily: IN, fx: { enter: 'fade-up' } }),
      text({ x: 96, y: 540, w: 620, h: 80, html: 'Twelve thousand spacecraft stream telemetry into archives nobody opens. We turn that exhaust into signal.', fontSize: 17, color: DIM, lineHeight: 1.6, fx: { enter: 'fade-up', order: 2 } }),
      star(1100, 500, 5, 19, 2),
    ],
  })

  const s2b = slide({
    id: 'orb-earth', background: VOID, transition: 'fade',
    notes: 'The live-view beat: a real Earth-from-the-ISS clip (Expedition 65, NASA — public domain) plays full-bleed, muted and looping, and AUTOPLAYS the moment you present. Demonstrates the VIDEO media element embedded self-contained in the file (~290 KB, trimmed + downscaled from the 4K original with ffmpeg). One scrim, one line, a HUD “live” tag. On the editor canvas the clip shows its poster frame (inert); it only plays in present.',
    elements: [
      media({ kind: 'video', src: mediaFile('earth.mp4', 'video/mp4'), poster: mediaFile('earth-poster.jpg', 'image/jpeg'), x: 0, y: 0, w: 1280, h: 720, fit: 'cover', controls: false, muted: true, autoplay: true, loop: true }),
      shape('rect', { x: 0, y: 0, w: 1280, h: 720, fill: 'rgba(5,6,14,0.30)', fillGradient: grad(180, [0, 'rgba(5,6,14,0.32)'], [0.5, 'rgba(5,6,14,0.05)'], [1, 'rgba(5,6,14,0.82)']) }),
      mono(96, 84, '01b · THE VIEW FROM 400 KM', CYAN),
      shape('ellipse', { x: 1004, y: 90, w: 10, h: 10, fill: MAG, shadow: glow('rgba(255,79,163,0.9)', 10) }),
      mono(1024, 84, 'LIVE FEED', MAG, 12),
      text({ x: 96, y: 452, w: 1000, h: 180, html: 'Live from<br>low orbit.', fontSize: 66, fontWeight: 800, color: '#EAF4FF', lineHeight: 1.06, fontFamily: IN, shadow: { y: 2, blur: 30, color: 'rgba(0,0,0,0.6)' }, fx: { enter: 'fade-up' } }),
      mono(96, 648, 'EARTH FROM THE ISS · EXPEDITION 65 (4K) · NASA — PUBLIC DOMAIN', 'rgba(178,196,224,0.5)', 10),
    ],
  })

  const s3 = slide({
    id: 'orb-system', background: DEEP, transition: 'fade',
    notes: 'The “system map” — a clickable data pipeline: INGEST → CORE → MODEL, with dashes marching along the links (telemetry flowing) and a satellite orbiting the core. Nodes stagger in on entry. Click a node → a hidden STATE slide zooms that subsystem (link + stateOf). Extend it by duplicating a state slide.',
    elements: [
      mono(96, 84, '02 · THE CONSTELLATION — CLICK A NODE'),
      // orbit ring + a satellite riding it (keeps the map alive)
      shape('ellipse', { x: 500, y: 220, w: 280, h: 280, fill: 'rgba(0,0,0,0)', stroke: 'rgba(56,225,255,0.30)', strokeWidth: 1.5, strokeStyle: 'dashed', fx: { loop: { type: 'dash-march', distance: 40, duration: 7 } } }),
      shape('ellipse', { x: 636, y: 216, w: 8, h: 8, fill: CYAN, fillGradient: GRAD_CY, shadow: glow('rgba(56,225,255,0.85)', 16), fx: { loop: { type: 'motion-path', path: orbit(140, -Math.PI / 2, 1), duration: 12 } } }),
      // links: dashes march INGEST → CORE → MODEL, tips exactly on the node/core edges
      shape('line', { x: 342, y: 359, w: 238, h: 2, fill: 'rgba(132,186,236,0.9)', strokeWidth: 2, strokeStyle: 'dashed', lineEnd: 'arrow', fx: { loop: { type: 'dash-march', distance: 24, duration: 1.6 } } }),
      shape('line', { x: 700, y: 359, w: 238, h: 2, fill: 'rgba(132,186,236,0.9)', strokeWidth: 2, strokeStyle: 'dashed', lineEnd: 'arrow', fx: { loop: { type: 'dash-march', distance: 24, duration: 1.6 } } }),
      // CORE
      shape('ellipse', { x: 580, y: 300, w: 120, h: 120, fill: VOID, fillGradient: GRAD_CY, stroke: CYAN, strokeWidth: 2, shadow: glow('rgba(56,225,255,0.7)', 55), fx: { enter: 'fade-up', order: 0 } }),
      text({ x: 580, y: 351, w: 120, h: 30, html: '<b>CORE</b>', fontSize: 15, color: '#04141c', align: 'center', fontFamily: MONO, letterSpacing: 2, fx: { enter: 'fade-up', order: 0 } }),
      // INGEST node (left) — outer ring + inner glow dot + label, all click-linked
      shape('ellipse', { id: 'orb-n1', x: 258, y: 318, w: 84, h: 84, fill: DEEP, stroke: VIOLET, strokeWidth: 2, shadow: glow('rgba(122,92,255,0.55)', 34), link: 'orb-state-ingest', fx: { enter: 'fade-up', order: 1 } }),
      shape('ellipse', { x: 286, y: 346, w: 28, h: 28, fill: VIOLET, fillGradient: GRAD_MG, shadow: glow('rgba(122,92,255,0.85)', 14), link: 'orb-state-ingest', fx: { enter: 'fade-up', order: 1 } }),
      text({ x: 233, y: 416, w: 134, h: 24, html: 'INGEST', fontSize: 12, letterSpacing: 3, color: DIM, align: 'center', fontFamily: MONO, link: 'orb-state-ingest', fx: { enter: 'fade-up', order: 1 } }),
      // MODEL node (right)
      shape('ellipse', { id: 'orb-n2', x: 938, y: 318, w: 84, h: 84, fill: DEEP, stroke: MAG, strokeWidth: 2, shadow: glow('rgba(255,79,163,0.5)', 34), link: 'orb-state-model', fx: { enter: 'fade-up', order: 2 } }),
      shape('ellipse', { x: 966, y: 346, w: 28, h: 28, fill: MAG, shadow: glow('rgba(255,79,163,0.85)', 14), link: 'orb-state-model', fx: { enter: 'fade-up', order: 2 } }),
      text({ x: 913, y: 416, w: 134, h: 24, html: 'MODEL', fontSize: 12, letterSpacing: 3, color: DIM, align: 'center', fontFamily: MONO, link: 'orb-state-model', fx: { enter: 'fade-up', order: 2 } }),
      text({ x: 96, y: 566, w: 900, h: 60, html: 'Hidden state slides answer the click — arrow keys skip them,<br>so the linear story stays clean.', fontSize: 15, color: 'rgba(178,196,224,0.45)', lineHeight: 1.5, fx: { enter: 'fade', order: 3 } }),
    ],
  })

  const stateBase = (sid, title, body, accent, ph, credit) => slide({
    id: sid, stateOf: 'orb-system', background: DEEP, transition: 'morph', name: title,
    notes: 'A hidden state — reached only by clicking its node on the system map. Each state gets its own NASA backdrop (public domain) under a deep scrim — the photo switch is what makes the zoom-in feel like a place, not a popup.',
    elements: [
      img({ asset: ph, x: 0, y: 0, w: 1280, h: 720, opacity: 0.55, fx: { ambient: 'kenburns', ken: { dir: 'drift', scale: 1.08, duration: 20 } } }),
      shape('rect', { x: 0, y: 0, w: 1280, h: 720, fill: 'rgba(11,14,30,0.62)' }),
      mono(96, 84, `02a · ${title} — CLICK ANYWHERE DIM TO GO BACK`),
      shape('ellipse', { id: sid + '-halo', x: 460, y: 130, w: 360, h: 360, fill: 'rgba(0,0,0,0)', stroke: accent, strokeWidth: 2, shadow: glow(accent === VIOLET ? 'rgba(122,92,255,0.5)' : 'rgba(255,79,163,0.5)', 70) }),
      text({ x: 340, y: 240, w: 600, h: 80, html: title, fontSize: 56, fontWeight: 800, color: '#EAF4FF', align: 'center', letterSpacing: 8, fontFamily: IN }),
      text({ x: 340, y: 330, w: 600, h: 80, html: body, fontSize: 16, color: DIM, align: 'center', lineHeight: 1.6 }),
      mono(96, 648, credit, 'rgba(178,196,224,0.4)', 9),
      shape('rect', { x: 0, y: 0, w: 1280, h: 720, fill: 'rgba(0,0,0,0)', link: 'orb-system' }),
    ],
  })
  const st1 = stateBase('orb-state-ingest', 'INGEST', '4.2 TB of telemetry per orbit,<br>deduplicated at the edge.', VIOLET, 'ph-cubesats', 'CUBESATS DEPLOYED FROM THE ISS, EXPEDITION 72 · NASA — PUBLIC DOMAIN')
  const st2 = stateBase('orb-state-model', 'MODEL', 'Anomaly scores in 90 seconds —<br>before the next ground pass.', MAG, 'ph-jwst', 'JAMES WEBB PRIMARY MIRROR · NASA/MSFC — PUBLIC DOMAIN')

  const s4 = slide({
    id: 'orb-growth', background: VOID, transition: 'fade',
    notes: 'Neon-styled area chart. Note the restraint: one gradient line on darkness reads as “expensive”; three would read as a dashboard.',
    elements: [
      mono(96, 84, '03 · SIGNAL EXTRACTED, PETABYTES'),
      text({ x: 96, y: 120, w: 900, h: 90, html: 'Up and to the right,<br>literally.', fontSize: 54, fontWeight: 800, color: '#EAF4FF', fontFamily: IN, lineHeight: 1.1 }),
      chart({ x: 96, y: 280, w: 1088, h: 370, preset: 'line', option: {
        grid: { left: 46, right: 16, top: 20, bottom: 30 },
        xAxis: { type: 'category', data: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'] },
        yAxis: { type: 'value' },
        color: [CYAN],
        tooltip: { trigger: 'axis' },
        series: [{ type: 'line', smooth: true, data: [2, 5, 11, 24, 52, 96],
          lineStyle: { width: 3.5, color: CYAN },
          areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [{ offset: 0, color: 'rgba(56,225,255,0.35)' }, { offset: 1, color: 'rgba(56,225,255,0)' }] } },
          symbol: 'circle', symbolSize: 8, itemStyle: { color: CYAN } }],
      }, fx: { enter: 'fade-up' } }),
      star(1130, 150, 5, 21, 1),
    ],
  })

  const s5 = slide({
    id: 'orb-end', background: VOID, transition: 'morph',
    notes: 'The ring comes home to center; the wordmark grows back on pure void black. Loops keep breathing after the morph settles.',
    elements: [
      shape('ellipse', { id: 'orb-ring', x: 340, y: 60, w: 600, h: 600, fill: 'rgba(0,0,0,0)', stroke: MAG, strokeWidth: 2, shadow: glow('rgba(255,79,163,0.4)', 80) }),
      shape('ellipse', { x: 620, y: 40, w: 44, h: 44, fill: MAG, fillGradient: GRAD_MG, shadow: glow('rgba(255,79,163,0.8)', 26), fx: { loop: { type: 'motion-path', path: orbit(300, -Math.PI / 2, 1), duration: 18 } } }),
      text({ id: 'orb-word', x: 140, y: 300, w: 1000, h: 110, html: 'JOIN THE SWEEP', fontSize: 66, fontWeight: 800, color: '#EAF4FF', align: 'center', letterSpacing: 16, fontFamily: IN, shadow: glow('rgba(255,79,163,0.3)', 40) }),
      mono(390, 430, 'ORBITAL.EXAMPLE · GROUND STATION OPEN HOUSE FRIDAYS', 'rgba(178,196,224,0.5)'),
      star(200, 160, 6, 18, 2), star(1040, 520, 7, 22, 4),
    ],
  })

  return doc({
    title: 'Orbital — dark immersive template',
    assets: {
      'ph-stars': photo('orbital-stars.jpg'),
      'ph-cubesats': photo('orbital-cubesats.jpg'), 'ph-jwst': photo('orbital-jwst.jpg'),
      'font-spacemono': fontFile('SpaceMono-400-latin.woff2'),
      'font-spacemono-bold': fontFile('SpaceMono-700-latin.woff2'),
    },
    fonts: [
      { family: 'Space Mono', asset: 'font-spacemono', weight: '400' },
      { family: 'Space Mono', asset: 'font-spacemono-bold', weight: '700' },
    ],
    theme: { background: VOID, color: '#EAF4FF', accent: CYAN, fontFamily: IN },
    present: { progress: true },
    slides: [s1, s2, s2b, s3, st1, st2, s4, s5],
  })
}

// ═══════════════════════════════════════════════════════════════════════
// DECK D · «PICNIC» — playful toy-like (Bruno Simon / Hello Monday family)
// Sunshine, bubblegum, sky. Hard sticker shadows, everything slightly askew.
// ═══════════════════════════════════════════════════════════════════════
function deckPicnic() {
  const SUN = '#FFD43A', GUM = '#FF7BAC', SKY = '#4DC9F0', LIME = '#7BE382', INK = '#201A31', CREAM = '#FFF9EC'
  const sticker = { x: 6, y: 8, blur: 0, color: INK } // hard offset = sticker
  const wobble = (r, dur, phase = 0) => ({ loop: { type: 'motion-path', path: orbit(r, phase), duration: dur } })
  const chunky = (x, y, s, size = 90, color = INK, rot = 0) => text({ x, y, w: 1100, h: size * 1.4, html: s, fontSize: size, fontWeight: 900, color, fontFamily: IN, rotation: rot, lineHeight: 1 })

  const s1 = slide({
    id: 'pic-cover', background: SUN, transition: 'none',
    notes: 'TEMPLATE — “Pixel Picnic”, a playful toy-style deck. The cover is a scrapbook: a full-bleed 1941 carnival Kodachrome (Library of Congress, public domain) washed with the brand yellow, stickers slapped on top. Style family: saturated flats, hard sticker shadows (offset, zero blur), everything 2–4° askew, wobble loops. The blobs morph into the schedule tiles.',
    elements: [
      img({ asset: 'ph-fairwide', x: 0, y: 0, w: 1280, h: 720, fx: { ambient: 'kenburns', ken: { dir: 'drift', scale: 1.06, duration: 22 } } }),
      shape('rect', { x: 0, y: 0, w: 1280, h: 720, fill: 'rgba(255,212,58,0.55)' }),
      shape('ellipse', { id: 'pic-a', x: 950, y: 90, w: 220, h: 220, fill: GUM, stroke: INK, strokeWidth: 5, shadow: sticker, fx: wobble(10, 7) }),
      shape('rect', { id: 'pic-b', x: 560, y: 110, w: 190, h: 190, radius: 40, fill: SKY, stroke: INK, strokeWidth: 5, rotation: -8, shadow: sticker, fx: wobble(8, 9, 2) }),
      shape('triangle', { id: 'pic-c', x: 1010, y: 430, w: 180, h: 160, fill: LIME, stroke: INK, strokeWidth: 5, rotation: 7, shadow: sticker, fx: wobble(9, 8, 4) }),
      chunky(120, 150, 'PIXEL<br>PICNIC', 130, INK, -2),
      text({ x: 130, y: 470, w: 700, h: 60, html: 'a two-day jam for games,<br>toys &amp; gloriously useless websites', fontSize: 24, fontWeight: 700, color: INK, rotation: -2, lineHeight: 1.3 }),
      text({ x: 850, y: 350, w: 340, h: 40, html: 'AUG 22–23 · THE OLD POOL', fontSize: 16, fontWeight: 800, color: INK, rotation: 3, letterSpacing: 1 }),
      shape('rect', { x: 645, y: 405, w: 230, h: 272, radius: 12, fill: '#FFFFFF', stroke: INK, strokeWidth: 4, rotation: -5, shadow: sticker, fx: { enter: 'fade-up', order: 1 } }),
      img({ asset: 'ph-fair', x: 661, y: 421, w: 198, h: 204, radius: 6, rotation: -5, fx: { enter: 'fade-up', order: 1, ambient: 'kenburns', ken: { dir: 'drift', scale: 1.04, duration: 16 } } }),
      text({ x: 661, y: 633, w: 198, h: 30, html: 'last picnic!!', fontSize: 16, fontWeight: 800, color: INK, align: 'center', rotation: -5, fx: { enter: 'fade-up', order: 1 } }),
      // Embedded audio (self-contained) — a short chime synthesised in
      // build-example-decks.mjs, so it's unambiguously public domain. Demos the
      // media element's embed path: the sound travels inside the .bento.html.
      text({ x: 130, y: 556, w: 360, h: 26, html: '▶ press play — the picnic jingle', fontSize: 15, fontWeight: 800, color: INK, rotation: -1 }),
      media({ id: 'pic-jingle', kind: 'audio', src: mediaFile('chime.wav', 'audio/wav'), x: 130, y: 588, w: 300, h: 56, radius: 999, controls: true }),
      text({ x: 130, y: 682, w: 700, h: 20, html: 'PHOTOS: JACK DELANO, 1941 · LIBRARY OF CONGRESS — PUBLIC DOMAIN', fontSize: 9, fontWeight: 700, letterSpacing: 2, color: 'rgba(32,26,49,0.55)' }),
    ],
  })

  const s2 = slide({
    id: 'pic-rules', background: CREAM, transition: 'fade',
    notes: 'House rules as stickers. Count-up on the big number. Duplicate a card, rotate it ±3°, done.',
    elements: [
      chunky(110, 90, 'THREE RULES.', 84, INK, -1),
      ...[
        [SUN, 'MAKE IT<br>WEIRD', -3, 0],
        [GUM, 'SHIP IT<br>SILLY', 2, 1],
        [SKY, 'DEMO OR<br>IT DIDN’T<br>HAPPEN', -2, 2],
      ].map(([c, s, rot, i]) => shape('rect', { x: 120 + i * 370, y: 240, w: 320, h: 300, radius: 28, fill: c, stroke: INK, strokeWidth: 5, rotation: rot, shadow: sticker, fx: { enter: 'fade-up', order: i } })),
      ...['MAKE IT<br>WEIRD', 'SHIP IT<br>SILLY', 'DEMO OR IT<br>DIDN’T HAPPEN'].map((s, i) =>
        text({ x: 150 + i * 370, y: 300, w: 260, h: 200, html: s, fontSize: 38, fontWeight: 900, color: INK, align: 'center', rotation: [-3, 2, -2][i], lineHeight: 1.15, fx: { enter: 'fade-up', order: i } })),
      text({ x: 120, y: 590, w: 500, h: 80, html: '48', fontSize: 84, fontWeight: 900, color: GUM, fontFamily: IN, fx: { countUp: true, enter: 'fade', order: 3 } }),
      text({ x: 250, y: 630, w: 500, h: 40, html: 'hours. that’s the whole budget.', fontSize: 20, fontWeight: 700, color: INK, fx: { enter: 'fade', order: 3 } }),
    ],
  })

  const s3 = slide({
    id: 'pic-schedule', background: SKY, transition: 'morph',
    notes: 'The blobs morphed into schedule tiles — same ids as the cover shapes. A schedule that bounces beats a table that bores.',
    elements: [
      chunky(110, 80, 'THE PLAN-ISH', 84, CREAM, -1),
      shape('ellipse', { id: 'pic-a', x: 120, y: 220, w: 330, h: 150, fill: GUM, stroke: INK, strokeWidth: 5, shadow: sticker }),
      text({ x: 140, y: 262, w: 290, h: 70, html: '<b>SAT 10:00</b> — kickoff &amp; pancakes', fontSize: 20, fontWeight: 800, color: INK, align: 'center', lineHeight: 1.3 }),
      shape('rect', { id: 'pic-b', x: 480, y: 300, w: 330, h: 150, radius: 34, fill: SUN, stroke: INK, strokeWidth: 5, rotation: 2, shadow: sticker }),
      text({ x: 500, y: 342, w: 290, h: 70, html: '<b>SAT 22:00</b> — night build, lights off', fontSize: 20, fontWeight: 800, color: INK, align: 'center', rotation: 2, lineHeight: 1.3 }),
      shape('triangle', { id: 'pic-c', x: 850, y: 210, w: 320, h: 260, fill: LIME, stroke: INK, strokeWidth: 5, rotation: -3, shadow: sticker }),
      text({ x: 890, y: 330, w: 240, h: 70, html: '<b>SUN 16:00</b><br>DEMOS!', fontSize: 22, fontWeight: 900, color: INK, align: 'center', rotation: -3, lineHeight: 1.25 }),
      text({ x: 120, y: 560, w: 1000, h: 60, html: 'everything else is officially improvised', fontSize: 22, fontWeight: 700, color: CREAM, rotation: -1 }),
    ],
  })

  const s3b = slide({
    id: 'pic-photo', background: CREAM, transition: 'fade',
    notes: 'The photo-as-sticker recipe: a white frame rect with the ink outline + hard shadow, a photo with a soft ken-burns drift inside it, a marker caption, and one sticker slapped over the corner. Photo: Jack Delano’s 1941 state-fair Kodachrome (Library of Congress — public domain).',
    elements: [
      chunky(100, 180, 'PROOF<br>IT’S FUN.', 96, INK, -2),
      text({ x: 110, y: 460, w: 480, h: 80, html: 'actual footage of the last picnic.<br>nobody shipped anything. 10/10.', fontSize: 21, fontWeight: 700, color: INK, rotation: -2, lineHeight: 1.4, fx: { enter: 'fade-up', order: 1 } }),
      shape('rect', { x: 690, y: 60, w: 490, h: 590, radius: 18, fill: '#FFFFFF', stroke: INK, strokeWidth: 5, rotation: 3, shadow: sticker, fx: { enter: 'fade-up' } }),
      img({ asset: 'ph-fair', x: 716, y: 86, w: 438, h: 470, radius: 10, rotation: 3, fx: { enter: 'fade-up', ambient: 'kenburns', ken: { dir: 'drift', scale: 1.045, duration: 14 } } }),
      text({ x: 716, y: 572, w: 438, h: 40, html: 'the wheel. august. absolute chaos.', fontSize: 19, fontWeight: 800, color: INK, align: 'center', rotation: 3, fx: { enter: 'fade-up' } }),
      shape('ellipse', { x: 640, y: 40, w: 110, h: 110, fill: GUM, stroke: INK, strokeWidth: 5, shadow: sticker, fx: wobble(9, 8, 3) }),
      text({ x: 645, y: 76, w: 100, h: 40, html: '1941!', fontSize: 22, fontWeight: 900, color: INK, align: 'center', rotation: -8 }),
      text({ x: 690, y: 668, w: 490, h: 20, html: 'JACK DELANO · LIBRARY OF CONGRESS — PUBLIC DOMAIN', fontSize: 9, fontWeight: 700, letterSpacing: 2, color: 'rgba(32,26,49,0.5)', align: 'center' }),
    ],
  })

  const s4 = slide({
    id: 'pic-snacks', background: CREAM, transition: 'fade',
    notes: 'Yes, a snack chart. Charts don’t have to be serious — brand the palette and let the tooltip do a joke.',
    elements: [
      chunky(110, 80, 'SNACK BUDGET,<br>VISUALIZED', 66, INK, -1),
      chart({ x: 110, y: 260, w: 1060, h: 390, preset: 'bar', option: {
        grid: { left: 44, right: 12, top: 24, bottom: 32 },
        xAxis: { type: 'category', data: ['pizza', 'gummy bears', 'coffee', 'fruit??', 'mystery'] },
        yAxis: { type: 'value' },
        color: [GUM],
        tooltip: { trigger: 'item', formatter: '{b}: {c}%' },
        series: [{ type: 'bar', data: [38, 27, 22, 4, 9],
          itemStyle: { color: GUM, borderRadius: 14 }, barWidth: 110 }],
      }, fx: { enter: 'fade-up' } }),
    ],
  })

  const s5 = slide({
    id: 'pic-end', background: GUM, transition: 'zoom',
    notes: 'Confetti exit — every shape on its own wobble loop, phase-offset so nothing is frozen at entry.',
    elements: [
      ...[[SUN, 160, 120, 60, 0], [SKY, 1060, 140, 50, 1], [LIME, 200, 520, 70, 2],
          [CREAM, 990, 500, 44, 3], [SUN, 640, 80, 36, 4], ['#8A6FE8', 1130, 350, 40, 5]]
        .map(([c, x, y, w, i]) => shape(i % 2 ? 'ellipse' : 'rect', { x, y, w, h: w, radius: 12, fill: c, stroke: INK, strokeWidth: 4, rotation: (i * 17) % 30 - 15, shadow: sticker, fx: wobble(12 + i * 2, 6 + i, i) })),
      chunky(140, 250, 'COME PLAY.', 120, INK, -2),
      text({ x: 140, y: 430, w: 1000, h: 40, html: 'pixelpicnic.example — bring a controller and a sleeping bag', fontSize: 22, fontWeight: 800, color: INK, rotation: -2 }),
    ],
  })

  return doc({
    title: 'Pixel Picnic — playful template',
    assets: { 'ph-fair': photo('picnic-fair.jpg'), 'ph-fairwide': photo('picnic-fairwide.jpg') },
    theme: { background: SUN, color: INK, accent: GUM, fontFamily: IN },
    slides: [s1, s2, s3, s3b, s4, s5],
  })
}

// ——— splice + write ————————————————————————————————————————————————
const outDir = process.argv[2] ?? join(root, 'working')
mkdirSync(outDir, { recursive: true })
const blockRe = /<script type="application\/bento\+json" id="bento-doc">[\s\S]*?<\/script>/
for (const [file, build] of [
  ['signal-editorial-type.bento.html', deckSignal],
  ['terra-premium-product.bento.html', deckTerra],
  ['orbital-dark-immersive.bento.html', deckOrbital],
  ['picnic-playful.bento.html', deckPicnic],
]) {
  uid = 0
  const d = build()
  const json = JSON.stringify(d).replace(/</g, '\\u003c')
  const out = shell.replace(blockRe, `<script type="application/bento+json" id="bento-doc">\n${json}\n</scr` + 'ipt>')
  if (!out.includes(json)) throw new Error(`splice failed for ${file}`)
  writeFileSync(join(outDir, file), out)
  console.log(`${file} — ${d.slides.length} slides, ${Math.round(out.length / 1024)} KB`)
}
