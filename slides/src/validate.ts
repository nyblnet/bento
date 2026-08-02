// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Document validation — `window.bento.validate()`.
//
// WHY THIS EXISTS. Almost everything that goes wrong in a generated deck fails
// SILENTLY. A typo'd property is ignored, so the styling just does not apply. A
// dash-march loop on a solid stroke animates nothing. An entrance on a morph
// arrival never runs. Text overflows its box and the JSON looks perfect. An
// agent authoring a deck has no way to see any of it without rendering the
// result and looking at every slide — which is exactly what nobody does.
//
// So this reports, in one structured pass, the things the runtime would
// otherwise swallow. It only READS: it never mutates the document, and a
// finding is advice, not a refusal. `parseDoc` remains the thing that decides
// whether a document is loadable at all.
//
// Text overflow needs real layout, so it goes through measure.ts — the same
// path `window.bento.measure()` uses, which renders off-screen with the SAME
// renderer the editor and present mode use. One path means the validator and
// the measuring tool cannot disagree about whether a box fits its text. Without
// a DOM (node tooling) the measured checks are skipped and `measured` reports
// false, rather than guessing.

import type { BentoDoc, Slide, SlideElement, TextElement } from './model.ts'
import { MODEL_KEYS } from './modelkeys.generated.ts'
import { measureElements } from './measure.ts'

export type Severity = 'error' | 'warning' | 'info'

export interface Finding {
  /** stable machine-readable code, e.g. 'text-overflow' */
  code: string
  severity: Severity
  /** one line, written to be actionable on its own */
  message: string
  /** slide id, when the finding belongs to a slide */
  slide?: string
  /** element id, when it belongs to an element */
  element?: string
  /** property path within the element/document, e.g. 'option.series[0].label' */
  path?: string
}

export interface ValidateResult {
  ok: boolean
  /** false when there was no DOM, so overflow was not checked */
  measured: boolean
  counts: Record<Severity, number>
  findings: Finding[]
}

export interface ValidateOpts {
  /** measure text overflow (needs a DOM). Default true when one exists. */
  measure?: boolean
  /** side margin in px on a 1280-wide canvas; scaled to the deck. 0 disables. */
  margin?: number
}

/**
 * Chart option keys charts-lite implements (kernel/src/charts.ts). Anything
 * else in an `option` is ignored at render time with no warning — the engine
 * reads the ECharts option SHAPE, it is not ECharts.
 *
 * Kept deliberately close to the renderer: `label` is listed for pie only,
 * because `renderPie` is the sole reader of it and a `label` on a bar or line
 * series genuinely does nothing.
 */
const CHART_KEYS = {
  top: ['color', 'series', 'xAxis', 'yAxis', 'legend', 'grid', 'tooltip', 'textStyle', 'dataZoom'],
  series: ['type', 'name', 'data', 'yAxisIndex', 'itemStyle'],
  seriesByType: {
    bar: ['barWidth'],
    line: ['smooth', 'symbol', 'symbolSize', 'lineStyle', 'areaStyle'],
    scatter: ['symbol', 'symbolSize'],
    pie: ['radius', 'label'],
  } as Record<string, string[]>,
  axis: ['type', 'data', 'min', 'max', 'axisLabel', 'axisLine', 'splitLine', 'name'],
  legend: ['show', 'top', 'bottom', 'textStyle', 'itemWidth', 'itemHeight', 'itemGap', 'data'],
}

/**
 * Families a viewer's machine can be expected to resolve without the document
 * carrying the bytes — generics, the CSS system keywords, and the faces that
 * ship with mainstream desktop operating systems.
 *
 * Anything else named FIRST in a stack, and not in `doc.fonts`, is a face the
 * document is asking for and does not have. On the author's machine that
 * usually looks fine, because the author is exactly the person who has the
 * typeface installed; everyone else silently gets the next entry in the stack.
 * Two gallery templates shipped that way for months.
 */
const SYSTEM_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
  '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'roboto', 'helvetica',
  'helvetica neue', 'arial', 'arial black', 'verdana', 'tahoma', 'trebuchet ms',
  'georgia', 'times', 'times new roman', 'palatino', 'garamond', 'book antiqua',
  'courier', 'courier new', 'menlo', 'monaco', 'consolas', 'sf mono',
  'liberation mono', 'lucida console', 'impact', 'comic sans ms', 'cambria',
  'calibri', 'candara', 'optima', 'futura', 'gill sans', 'avenir', 'avenir next',
  'noto sans', 'noto serif', 'dejavu sans', 'pt sans', 'pt serif', 'emoji',
])

/** The first family in a CSS font stack, unquoted and lowercased. */
function firstFamily(stack: string): string {
  const first = stack.split(',')[0]?.trim() ?? ''
  return first.replace(/^['"]|['"]$/g, '').trim().toLowerCase()
}

const morphKey = (el: SlideElement) => el.morphId || el.id

/**
 * Small chrome — page numerals, running heads, corner labels. These live in
 * the margin ON PURPOSE, so flagging them for it is pure noise; the margin
 * guideline is about the body content that has to look aligned.
 */
const isFurniture = (el: SlideElement, doc: BentoDoc) =>
  el.w * el.h < doc.size.width * doc.size.height * 0.03

/** Slides reached by a morph transition, forward or backward out of one. */
function morphArrivals(doc: BentoDoc): Map<string, Slide | undefined> {
  const out = new Map<string, Slide | undefined>()
  doc.slides.forEach((s, i) => {
    if (s.transition === 'morph' && i > 0) out.set(s.id, doc.slides[i - 1])
  })
  return out
}

export function validateDoc(doc: BentoDoc, opts: ValidateOpts = {}): ValidateResult {
  const findings: Finding[] = []
  const add = (f: Finding) => findings.push(f)

  const hasDom = typeof document !== 'undefined'
  const measure = (opts.measure ?? true) && hasDom
  const marginBase = opts.margin ?? 96
  const margin = marginBase * (doc.size.width / 1280)
  const slideIds = new Set(doc.slides.map((s) => s.id))
  const assets = doc.assets ?? {}
  const arrivals = morphArrivals(doc)

  // ---- document level ------------------------------------------------------
  for (const k of Object.keys(doc)) {
    if (!(MODEL_KEYS.doc as readonly string[]).includes(k)) {
      add({ code: 'unknown-key', severity: 'warning', path: k,
        message: `Document key "${k}" is not part of the bento/slides format — it is ignored at render time.` })
    }
  }
  for (const f of doc.fonts ?? []) {
    if (f.asset && !assets[f.asset]) {
      add({ code: 'missing-asset', severity: 'error', path: `fonts.${f.family}`,
        message: `Font "${f.family}" points at asset "${f.asset}", which is not in doc.assets — the face will not load and text falls back silently.` })
    }
  }
  const embedded = new Set((doc.fonts ?? []).map((f) => f.family.trim().toLowerCase()))
  const seenFallback = new Set<string>()
  const checkFamily = (stack: string | undefined, where: Omit<Finding, 'code' | 'severity' | 'message'>) => {
    if (!stack) return
    const fam = firstFamily(stack)
    if (!fam || embedded.has(fam) || SYSTEM_FAMILIES.has(fam)) return
    // one finding per family — a deck sets the same stack on 40 elements
    if (seenFallback.has(fam)) return
    seenFallback.add(fam)
    add({ ...where, code: 'font-not-embedded', severity: 'info',
      message: `"${stack.split(',')[0].trim()}" is not in doc.fonts, so it renders only for viewers who happen to have it installed — everyone else silently gets the next family in the stack. Embed the woff2 in doc.assets and declare it in doc.fonts.` })
  }
  checkFamily(doc.theme?.fontFamily, { path: 'theme.fontFamily' })

  for (const slide of doc.slides) {
    const sid = slide.id
    const prev = arrivals.get(sid)
    const isMorphArrival = arrivals.has(sid)
    const partners = new Set((prev?.elements ?? []).map(morphKey))
    const seenIds = new Set<string>()
    const seenMorph = new Map<string, string>()
    const elsOnSlide = new Set(slide.elements.map((e) => e.id))

    for (const k of Object.keys(slide)) {
      if (!(MODEL_KEYS.slide as readonly string[]).includes(k)) {
        add({ code: 'unknown-key', severity: 'warning', slide: sid, path: k,
          message: `Slide key "${k}" is not part of the format — it is ignored.` })
      }
    }
    if (slide.stateOf && !slideIds.has(slide.stateOf)) {
      add({ code: 'broken-state-parent', severity: 'error', slide: sid, path: 'stateOf',
        message: `stateOf points at "${slide.stateOf}", which is not a slide in this deck — the state is unreachable.` })
    }

    for (const el of slide.elements) {
      const at = { slide: sid, element: el.id }

      // identity ---------------------------------------------------------
      if (seenIds.has(el.id)) {
        add({ ...at, code: 'duplicate-id', severity: 'error',
          message: `Two elements on this slide share the id "${el.id}" — selection, morph and comment anchors all key off it.` })
      }
      seenIds.add(el.id)
      const mk = morphKey(el)
      const clash = seenMorph.get(mk)
      if (clash && clash !== el.id) {
        add({ ...at, code: 'morph-key-collision', severity: 'error', path: 'morphId',
          message: `Morph key "${mk}" is used by both "${clash}" and "${el.id}" on this slide — morph pairs by that key, so one of them will not tween.` })
      }
      seenMorph.set(mk, el.id)

      // unknown keys -------------------------------------------------------
      const known = (MODEL_KEYS.element as Record<string, readonly string[]>)[el.type]
      if (known) {
        for (const k of Object.keys(el)) {
          if (!known.includes(k)) {
            add({ ...at, code: 'unknown-key', severity: 'warning', path: k,
              message: `"${k}" is not a property of a ${el.type} element — it is ignored, so whatever it was meant to do will not happen.` })
          }
        }
      }
      if (el.fx) {
        for (const k of Object.keys(el.fx)) {
          if (!(MODEL_KEYS.fx as readonly string[]).includes(k)) {
            add({ ...at, code: 'unknown-key', severity: 'warning', path: `fx.${k}`,
              message: `"fx.${k}" is not a known effect property — it is ignored.` })
          }
        }
      }

      // geometry -----------------------------------------------------------
      // Bleeding a shape or photo off the canvas is a deliberate idiom, and a
      // full-bleed backdrop is SUPPOSED to ignore the margin — so geometry is
      // only a warning for the element types that carry words, where going
      // past an edge means the reader loses some. For everything else it is
      // recorded at 'info' and stays out of the way.
      const carriesText = el.type === 'text' || el.type === 'table'
      const right = el.x + el.w
      const bottom = el.y + el.h
      const fullBleed = el.w >= doc.size.width * 0.9 || el.h >= doc.size.height * 0.9
      if (right > doc.size.width || bottom > doc.size.height || el.x < 0 || el.y < 0) {
        add({ ...at, code: 'out-of-canvas', severity: carriesText ? 'warning' : 'info',
          message: carriesText
            ? `Extends outside the ${doc.size.width}x${doc.size.height} canvas (x ${el.x}-${right}, y ${el.y}-${bottom}) — the text past the edge is cropped when presenting.`
            : `Extends outside the ${doc.size.width}x${doc.size.height} canvas (x ${el.x}-${right}, y ${el.y}-${bottom}) — fine as a deliberate bleed, cropped either way.` })
      // A few px inside the margin is an optical adjustment, not crowding —
      // large type is routinely nudged left to hang its side bearing. Only
      // flag content that misses the margin by an amount a reader would see.
      } else if (carriesText && !fullBleed && margin > 0 && !isFurniture(el, doc)
        && (el.x < margin * 0.9 || right > doc.size.width - margin * 0.9)) {
        add({ ...at, code: 'past-margin', severity: 'info',
          message: `Reaches past the ${Math.round(margin)}px side margin (x ${el.x}-${right}) — the deck's other content stops short of it.` })
      }

      // effects that will not run -------------------------------------------
      // Only a MORPHING element loses its entrance: it is already travelling
      // from its previous-slide frame, and an entrance tween would fight that.
      // An element with no partner on the previous slide runs its fx.enter
      // normally, so there is nothing to report.
      if (el.fx?.enter && isMorphArrival && partners.has(mk)) {
        add({ ...at, code: 'overridden-enter-fx', severity: 'warning', path: 'fx.enter',
          message: `This element morphs in from the previous slide, so it is already in motion and fx.enter is skipped. Give it a morph key that is new to this slide if you want it to enter instead.` })
      }
      if (el.fx?.enter && el.fx?.loop?.type === 'motion-path') {
        add({ ...at, code: 'entrance-on-motion-path', severity: 'warning', path: 'fx.enter',
          message: `An entrance tween and a motion-path loop fight over the same transform — the element can freeze off its path. Use one or the other.` })
      }
      if (el.fx?.countUp && isMorphArrival && partners.has(mk)) {
        add({ ...at, code: 'inert-countup', severity: 'info', path: 'fx.countUp',
          message: `This element morphs in from the previous slide already showing its number, so the count-up is skipped by design. Give it a morph key that is new to this slide if you want it to count.` })
      }
      if (el.fx?.loop?.type === 'dash-march') {
        const dashed = el.type === 'shape' && (el.strokeStyle === 'dashed' || el.strokeStyle === 'dotted')
        const stroked = el.type === 'shape' && !!el.stroke && el.stroke !== 'transparent' && (el.strokeWidth ?? 0) > 0
        if (!dashed || !stroked) {
          add({ ...at, code: 'dash-march-no-dash', severity: 'warning', path: 'fx.loop',
            message: `A dash-march loop animates strokeDashoffset, so it needs a visible stroke AND strokeStyle "dashed" or "dotted". As set, the tween runs and nothing moves.` })
        }
      }

      // references -----------------------------------------------------------
      if (el.link && !slideIds.has(el.link)) {
        add({ ...at, code: 'broken-link', severity: 'error', path: 'link',
          message: `Links to slide "${el.link}", which does not exist — clicking it does nothing.` })
      }
      for (const [side, end] of [['from', (el as any).from], ['to', (el as any).to]] as const) {
        if (end?.el && !elsOnSlide.has(end.el)) {
          add({ ...at, code: 'dangling-connector', severity: 'warning', path: side,
            message: `Connector ${side} references element "${end.el}", which is not on this slide — that end is dropped and stops following.` })
        }
      }
      for (const key of ['src', 'asset', 'poster'] as const) {
        const ref = (el as any)[key]
        if (typeof ref === 'string' && ref.startsWith('asset:') && !assets[ref.slice(6)]) {
          add({ ...at, code: 'missing-asset', severity: 'error', path: key,
            message: `${key} references asset "${ref.slice(6)}", which is not in doc.assets — nothing renders.` })
        }
      }

      if (el.type === 'text') checkFamily((el as TextElement).fontFamily, at)

      // charts ---------------------------------------------------------------
      if (el.type === 'chart' && el.option) validateChart(el.option as any, at, add)
    }
  }

  // ---- measured checks -----------------------------------------------------
  if (measure) measureOverflow(doc, add)

  const counts = { error: 0, warning: 0, info: 0 }
  for (const f of findings) counts[f.severity]++
  return { ok: counts.error === 0, measured: measure, counts, findings }
}

/** Report option keys charts-lite does not implement. */
function validateChart(
  option: Record<string, any>,
  at: { slide: string; element: string },
  add: (f: Finding) => void,
) {
  const note = (path: string, what: string) =>
    add({ ...at, code: 'chart-key-ignored', severity: 'warning', path,
      message: `charts-lite does not implement ${what} — it is ignored, with no warning at render time.` })

  for (const k of Object.keys(option)) {
    if (!CHART_KEYS.top.includes(k)) note(`option.${k}`, `the top-level chart option "${k}"`)
  }
  const series = Array.isArray(option.series) ? option.series : option.series ? [option.series] : []
  series.forEach((s: any, i: number) => {
    if (!s || typeof s !== 'object') return
    const allowed = [...CHART_KEYS.series, ...(CHART_KEYS.seriesByType[s.type] ?? [])]
    for (const k of Object.keys(s)) {
      if (allowed.includes(k)) continue
      // the one people reach for most, and the one that reads as a bug
      if (k === 'label') {
        note(`option.series[${i}].label`,
          'value labels on a bar, line or scatter series (label is read for pie only)')
      } else {
        note(`option.series[${i}].${k}`, `"${k}" on a ${s.type ?? 'series'} series`)
      }
    }
  })
  for (const axis of ['xAxis', 'yAxis'] as const) {
    const list = Array.isArray(option[axis]) ? option[axis] : option[axis] ? [option[axis]] : []
    list.forEach((a: any, i: number) => {
      if (!a || typeof a !== 'object') return
      for (const k of Object.keys(a)) {
        if (!CHART_KEYS.axis.includes(k)) note(`option.${axis}[${i}].${k}`, `"${k}" on an axis`)
      }
    })
  }
  if (option.legend && typeof option.legend === 'object') {
    for (const k of Object.keys(option.legend)) {
      if (!CHART_KEYS.legend.includes(k)) note(`option.legend.${k}`, `"${k}" on the legend`)
    }
  }
}

/**
 * Measure every text element and report the ones that do not fit.
 *
 * Goes through measure.ts, the same path `window.bento.measure()` uses, so the
 * validator and the measuring tool can never disagree about whether a given
 * box fits its text — which they would within a release if each had its own
 * copy of the arithmetic.
 */
function measureOverflow(doc: BentoDoc, add: (f: Finding) => void) {
  // a placeholder with no content measures as one empty line — not overflow
  const targets: Array<{ slide: string; el: TextElement }> = []
  for (const slide of doc.slides) {
    for (const el of slide.elements) {
      if (el.type === 'text' && el.html?.trim()) targets.push({ slide: slide.id, el })
    }
  }
  const measured = measureElements(targets.map((t) => t.el), doc)
  measured.forEach((m, i) => {
    const { slide, el } = targets[i]
    if (m.fits !== false || m.overflow! <= 1) return
    add({
      slide, element: el.id, code: 'text-overflow', severity: 'warning', path: 'h',
      message: `Text needs ${m.height}px but the box is ${el.h}px tall — it overflows by ${m.overflow}px (${m.lines} lines) and will collide with whatever is below it.`,
    })
  })
}
