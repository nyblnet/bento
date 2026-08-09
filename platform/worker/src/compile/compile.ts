// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Outline (schema.ts) → a real bento/slides BentoDoc. Built on top of
// slides/src/model.ts's own element/layout constructors — NOT a
// reimplementation of them — so compiled decks share their geometry and
// defaults with whatever the real editor would produce, and so a change to
// those constructors (a new required ElementBase field, say) is a compile
// error here rather than a silently-diverging second copy. This is a
// one-directional dependency (platform reads slides' model, never the
// reverse) and is safe specifically because model.ts has zero imports and no
// DOM/browser globals — confirmed before wiring this up, see
// docs/DECISIONS.md.
//
// Layout choices per outline kind:
//   - title / section / bullets reuse slides/src/model.ts's builtinLayouts()
//     geometry (instantiateLayout + fill by `role`), then get their colors
//     RE-THEMED to the outline's theme (the builtins ship their own fixed
//     light/dark look, which is right for a blank new slide but wrong for a
//     compiler whose whole point is theme-consistent output).
//   - stat / chart / table / quote / image have no matching builtin layout
//     (there's no "big number" or "chart" built-in) and are constructed
//     directly from defaultText/defaultChart/defaultTable/defaultImage/
//     defaultShape, themed from the start.
//
// Morph: docs/agents.md's recipe is "same element id on both slides +
// transition:'morph' on the later one" — but title/section/bullets slides
// come from DIFFERENT builtin layouts with different baked-in ids ('lt-title'
// vs 'ltc-title'), so pairing across layouts needs the `morphId` override
// (ElementBase.morphId) rather than touching `id` itself. Every compiled
// slide's heading-ish element carries `role:'title'` for exactly this reason
// — it's the uniform hook morph-pairing and re-theming both key off.
import {
  FONT_STACK,
  applyChartPalette,
  builtinLayouts,
  defaultChart,
  defaultImage,
  defaultShape,
  defaultTable,
  defaultText,
  emptySlide,
  instantiateLayout,
  isLightBg,
  newDoc,
  readableInk,
  uid,
} from '../../../../slides/src/model.ts'
import type {
  BentoDoc,
  ImageElement,
  Slide,
  SlideElement,
  TableCell,
  TableRow,
  TableStyle,
  TextElement,
} from '../../../../slides/src/model.ts'
import type {
  BulletsSlide,
  ChartSlide,
  ImageSlide,
  Outline,
  OutlineSlide,
  QuoteSlide,
  SectionSlide,
  StatSlide,
  TableSlide,
  TitleSlide,
} from './schema.ts'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

const CANVAS = { w: 1280, h: 720 }
const MARGIN = 96
const CONTENT_W = CANVAS.w - MARGIN * 2 // 1088, matches CLAUDE.md's "x ≤ 1184" margin convention

function findByRole(slide: Slide, role: string): TextElement | undefined {
  return slide.elements.find((e) => e.type === 'text' && e.role === role) as TextElement | undefined
}

/** Re-theme a builtin-layout-derived slide: the layouts ship their own fixed
 *  light/dark palette, which is right for a blank inserted slide but wrong
 *  here — a compiled deck should read as ONE theme throughout. */
function retheme(slide: Slide, theme: BentoDoc['theme']): Slide {
  slide.background = theme.background
  const ink = readableInk(theme.background)
  for (const el of slide.elements) {
    if (el.type === 'text') el.color = el.role === 'kicker' ? theme.accent : ink
    else if (el.type === 'shape') el.fill = theme.accent
  }
  return slide
}

function baseSlide(os: OutlineSlide, transition: Slide['transition'] = 'none'): Partial<Slide> {
  return { transition, notes: os.notes ?? '' }
}

function compileTitle(os: TitleSlide, layout: Slide, theme: BentoDoc['theme']): Slide {
  const slide = instantiateLayout(layout)
  findByRole(slide, 'title')!.html = escapeHtml(os.heading)
  if (os.subheading) findByRole(slide, 'subtitle')!.html = escapeHtml(os.subheading)
  return retheme({ ...slide, ...baseSlide(os) }, theme)
}

function compileSection(os: SectionSlide, layout: Slide, theme: BentoDoc['theme']): Slide {
  const slide = instantiateLayout(layout)
  findByRole(slide, 'title')!.html = escapeHtml(os.heading)
  if (os.kicker) findByRole(slide, 'kicker')!.html = escapeHtml(os.kicker)
  return retheme({ ...slide, ...baseSlide(os) }, theme)
}

function compileBullets(os: BulletsSlide, layout: Slide, theme: BentoDoc['theme']): Slide {
  const slide = instantiateLayout(layout)
  findByRole(slide, 'title')!.html = escapeHtml(os.heading)
  findByRole(slide, 'body')!.html = os.bullets.map((b) => `• ${escapeHtml(b)}`).join('<br>')
  return retheme({ ...slide, ...baseSlide(os) }, theme)
}

function compileStat(os: StatSlide, theme: BentoDoc['theme']): Slide {
  const ink = readableInk(theme.background)
  const elements: SlideElement[] = []
  if (os.heading) {
    elements.push(
      defaultText({
        role: 'title',
        x: MARGIN, y: 96, w: CONTENT_W, h: 60,
        html: escapeHtml(os.heading), fontSize: 28, fontWeight: 700, fontFamily: FONT_STACK,
        color: theme.accent, align: 'left', valign: 'top', lineHeight: 1.2,
      }),
    )
  }
  elements.push(
    defaultText({
      x: MARGIN, y: 200, w: CONTENT_W, h: 280,
      html: formatNumber(os.value), fontSize: 176, fontWeight: 900, fontFamily: FONT_STACK,
      color: ink, align: 'left', valign: 'top', lineHeight: 1,
      fx: { countUp: true },
    }),
  )
  elements.push(
    defaultText({
      x: MARGIN, y: 500, w: CONTENT_W, h: 70,
      html: escapeHtml(os.label), fontSize: 32, fontWeight: 500, fontFamily: FONT_STACK,
      color: ink, align: 'left', valign: 'top', lineHeight: 1.3,
    }),
  )
  return { ...emptySlide({ background: theme.background }), elements, ...baseSlide(os) }
}

function buildChartOption(os: ChartSlide, theme: BentoDoc['theme']): Record<string, unknown> {
  if (os.chartType === 'pie') {
    const series0 = os.series[0]
    const data = os.categories.map((name, i) => ({ name, value: series0?.data[i] ?? 0 }))
    return applyChartPalette(
      {
        series: [{ type: 'pie', radius: '65%', data, label: { formatter: '{b}: {d}%' } }],
        tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
        legend: { bottom: 0 },
      },
      theme,
    )
  }
  return applyChartPalette(
    {
      xAxis: { type: 'category', data: os.categories },
      yAxis: { type: 'value' },
      // plain-number series only (CLAUDE.md: bar/line data must be numbers, not {value} objects)
      series: os.series.map((s) => ({ type: os.chartType, name: s.name, data: s.data })),
      tooltip: { trigger: 'axis' },
      ...(os.series.length > 1 ? { legend: { bottom: 0 } } : {}),
    },
    theme,
  )
}

function compileChart(os: ChartSlide, theme: BentoDoc['theme']): Slide {
  const ink = readableInk(theme.background)
  const elements: SlideElement[] = []
  let top = 96
  if (os.heading) {
    elements.push(
      defaultText({
        role: 'title',
        x: MARGIN, y: 64, w: CONTENT_W, h: 70,
        html: escapeHtml(os.heading), fontSize: 40, fontWeight: 800, fontFamily: FONT_STACK,
        color: ink, align: 'left', valign: 'top', lineHeight: 1.2,
      }),
    )
    top = 168
  }
  elements.push(
    defaultChart(buildChartOption(os, theme), {
      preset: os.chartType,
      x: MARGIN, y: top, w: CONTENT_W, h: CANVAS.h - top - MARGIN,
      fx: { enter: 'fade-up' },
    }),
  )
  return { ...emptySlide({ background: theme.background }), elements, ...baseSlide(os) }
}

function compileTable(os: TableSlide, theme: BentoDoc['theme']): Slide {
  const ink = readableInk(theme.background)
  const light = isLightBg(theme.background)
  const elements: SlideElement[] = []
  let top = 96
  if (os.heading) {
    elements.push(
      defaultText({
        role: 'title',
        x: MARGIN, y: 64, w: CONTENT_W, h: 70,
        html: escapeHtml(os.heading), fontSize: 40, fontWeight: 800, fontFamily: FONT_STACK,
        color: ink, align: 'left', valign: 'top', lineHeight: 1.2,
      }),
    )
    top = 168
  }
  const cell = (text: string): TableCell => ({ html: escapeHtml(text) })
  const rows: TableRow[] = [{ cells: os.columns.map(cell) }, ...os.rows.map((r) => ({ cells: r.map(cell) }))]
  // Table style is built from theme rather than tableStyleFor()'s fixed
  // default — that default is dark-header-on-light-body, invisible on a
  // dark-themed deck unless re-derived here.
  const style: TableStyle = {
    headerBg: theme.accent,
    headerColor: readableInk(theme.accent),
    zebra: light ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.06)',
    borderColor: light ? 'rgba(0,0,0,0.14)' : 'rgba(255,255,255,0.2)',
    borderWidth: 1,
    cellPadX: 16,
    cellPadY: 11,
    fontSize: 18,
    fontFamily: FONT_STACK,
    color: ink,
    radius: 10,
  }
  elements.push(
    defaultTable(
      { x: MARGIN, y: top, w: CONTENT_W, h: CANVAS.h - top - MARGIN, header: true, columns: os.columns.map(() => ({ w: 1 })), rows, style },
      theme,
    ),
  )
  return { ...emptySlide({ background: theme.background }), elements, ...baseSlide(os) }
}

function compileQuote(os: QuoteSlide, theme: BentoDoc['theme']): Slide {
  const ink = readableInk(theme.background)
  const elements: SlideElement[] = [
    defaultText({
      x: 160, y: 220, w: 960, h: 280,
      html: `<i>${escapeHtml(os.quote)}</i>`, fontSize: 52, fontWeight: 600, fontFamily: FONT_STACK,
      color: ink, align: 'left', valign: 'top', lineHeight: 1.3,
    }),
  ]
  if (os.attribution) {
    elements.push(
      defaultText({
        x: 160, y: 520, w: 960, h: 60,
        html: `— ${escapeHtml(os.attribution)}`, fontSize: 26, fontWeight: 700, fontFamily: FONT_STACK,
        color: theme.accent, align: 'left', valign: 'top', lineHeight: 1.2,
      }),
    )
  }
  return { ...emptySlide({ background: theme.background }), elements, ...baseSlide(os) }
}

/**
 * A tiny SVG data URI standing in for an unfilled image. Safe to embed
 * directly (not through render.ts's sanitizeHtml) because it is entirely
 * SERVER-GENERATED — the only author-controlled part is `alt`, HTML-escaped
 * below — and because a `data:image/svg+xml` reached through an `<img src>`
 * is decoded as raster image data by the browser, not as live DOM: embedded
 * script in an SVG loaded that way does not execute. That guarantee is about
 * the `<img>` loading path specifically, which is why raw `svg` DOCUMENT
 * ELEMENTS (author-supplied, loaded inline) are still rejected in
 * validate.ts — this placeholder never becomes one of those.
 */
function placeholderImageSrc(alt: string): string {
  const label = escapeHtml(alt).slice(0, 120)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.w}" height="${CANVAS.h}">` +
    `<rect width="${CANVAS.w}" height="${CANVAS.h}" fill="#2A2F3A"/>` +
    `<text x="${CANVAS.w / 2}" y="${CANVAS.h / 2}" font-family="sans-serif" font-size="28" fill="#8A93A6" text-anchor="middle">` +
    `Image needed: ${label}</text></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/** ImageElement plus the platform's own placeholder-tracking field. Additive
 *  per docs/PLATFORM.md §3 (format additivity) — the real bento/slides model
 *  has no opinion on it; the future upload UI (platform/README.md "Known
 *  gaps") finds unfilled slots by scanning for this. */
export type PlaceholderImage = ImageElement & { phSlot: string }

// Deliberately theme-independent: a full-bleed photo + scrim reads best with
// its own fixed dark treatment regardless of the deck's light/dark palette —
// a common presentation convention, not an oversight.
function compileImage(os: ImageSlide): Slide {
  const slot = os.slot ?? uid('ph')
  const img = defaultImage(placeholderImageSrc(os.alt), {
    x: 0, y: 0, w: CANVAS.w, h: CANVAS.h, rotation: 0, opacity: 1, fit: 'cover', radius: 0,
  }) as PlaceholderImage
  img.phSlot = slot

  const elements: SlideElement[] = [
    img,
    defaultShape('rect', {
      x: 0, y: 520, w: CANVAS.w, h: 200, fill: 'rgba(0,0,0,0.55)', stroke: 'transparent', strokeWidth: 0, radius: 0,
    }),
  ]
  if (os.heading) {
    elements.push(
      defaultText({
        role: 'title',
        x: MARGIN, y: 560, w: CONTENT_W, h: 80,
        html: escapeHtml(os.heading), fontSize: 44, fontWeight: 800, fontFamily: FONT_STACK,
        color: '#FFFFFF', align: 'left', valign: 'top', lineHeight: 1.2,
      }),
    )
  }
  if (os.caption) {
    elements.push(
      defaultText({
        x: MARGIN, y: os.heading ? 636 : 560, w: CONTENT_W, h: 60,
        html: escapeHtml(os.caption), fontSize: 22, fontWeight: 400, fontFamily: FONT_STACK,
        color: 'rgba(255,255,255,0.85)', align: 'left', valign: 'top', lineHeight: 1.3,
      }),
    )
  }
  return { ...emptySlide({ background: '#11151C' }), elements, ...baseSlide(os) }
}

export function compileOutline(outline: Outline): BentoDoc {
  const doc = newDoc()
  doc.title = outline.title
  doc.size = { width: CANVAS.w, height: CANVAS.h }
  doc.theme = {
    background: outline.theme?.background ?? '#0D1B2E',
    color: outline.theme?.color ?? '#F5F7FA',
    accent: outline.theme?.accent ?? '#E8442E',
    fontFamily: outline.theme?.fontFamily ?? FONT_STACK,
  }

  const layouts = builtinLayouts(doc.size)
  const titleLayout = layouts.find((l) => l.id === 'layout-title')!
  const sectionLayout = layouts.find((l) => l.id === 'layout-section')!
  const bodyLayout = layouts.find((l) => l.id === 'layout-title-content')!

  const slides: Slide[] = outline.slides.map((os) => {
    switch (os.layout) {
      case 'title':
        return compileTitle(os, titleLayout, doc.theme)
      case 'section':
        return compileSection(os, sectionLayout, doc.theme)
      case 'bullets':
        return compileBullets(os, bodyLayout, doc.theme)
      case 'stat':
        return compileStat(os, doc.theme)
      case 'chart':
        return compileChart(os, doc.theme)
      case 'table':
        return compileTable(os, doc.theme)
      case 'quote':
        return compileQuote(os, doc.theme)
      case 'image':
        return compileImage(os)
    }
  })

  // Morph pairing: adjacent outline slides sharing morphGroup get their
  // title-role elements linked via morphId, and the later slide morphs in.
  for (let i = 1; i < outline.slides.length; i++) {
    const prevGroup = outline.slides[i - 1]?.morphGroup
    const curGroup = outline.slides[i]?.morphGroup
    if (!curGroup || curGroup !== prevGroup) continue
    const prevTitle = findByRole(slides[i - 1]!, 'title')
    const curTitle = findByRole(slides[i]!, 'title')
    if (!prevTitle || !curTitle) continue // no title-ish element on one side — no-op, not an error
    const key = `mg-${curGroup.replace(/[^a-zA-Z0-9_-]/g, '')}-title`
    prevTitle.morphId = key
    curTitle.morphId = key
    slides[i]!.transition = 'morph'
  }

  doc.slides = slides
  return doc
}
