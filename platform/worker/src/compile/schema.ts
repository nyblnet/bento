// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The small outline schema a chat AI is asked to fill in (the platform's
// "step 1" prompt template — not built in this PR, but this is the contract
// it will target). Deliberately narrow: ~8 layout kinds, each mapping to one
// row of docs/agents.md's content-type table (numbers → chart, comparisons →
// table, same-thing-changing → morph, headline number → count-up). A chat
// model constrained to emit exactly this shape produces something compile.ts
// can turn into a GOOD deck — the "correct but static, bullets on slides"
// failure mode agents.md calls out is a schema-design problem as much as a
// prompting one, so the schema itself is where that gets fixed.
//
// No custom page size, no per-slide background override, no kicker on
// `bullets` — each omission is a deliberate v1 scope cut, not an oversight;
// see platform/README.md "Known gaps".

export interface OutlineTheme {
  background?: string
  color?: string
  accent?: string
  fontFamily?: string
}

interface OutlineBase {
  notes?: string
  /**
   * Consecutive outline slides sharing the same morphGroup get their title
   * element paired via `morphId` (docs/agents.md's morph recipe) and the
   * later slide gets `transition:'morph'`. Only slides with a title-ish
   * element participate — a plain `quote` slide with no heading is a no-op
   * if given a morphGroup, not an error.
   */
  morphGroup?: string
}

export interface TitleSlide extends OutlineBase {
  layout: 'title'
  heading: string
  subheading?: string
}

export interface SectionSlide extends OutlineBase {
  layout: 'section'
  heading: string
  kicker?: string
}

export interface BulletsSlide extends OutlineBase {
  layout: 'bullets'
  heading: string
  bullets: string[]
}

export interface StatSlide extends OutlineBase {
  layout: 'stat'
  heading?: string
  value: number
  label: string
}

export interface ChartSeriesInput {
  name: string
  data: number[]
}

export interface ChartSlide extends OutlineBase {
  layout: 'chart'
  heading?: string
  chartType: 'bar' | 'line' | 'pie'
  categories: string[]
  series: ChartSeriesInput[]
}

export interface TableSlide extends OutlineBase {
  layout: 'table'
  heading?: string
  columns: string[]
  rows: string[][]
}

export interface QuoteSlide extends OutlineBase {
  layout: 'quote'
  quote: string
  attribution?: string
}

export interface ImageSlide extends OutlineBase {
  layout: 'image'
  heading?: string
  caption?: string
  /** required even though the image is a placeholder — it's what the
   *  placeholder box displays, and what a later image-generation/search step
   *  would search for. */
  alt: string
  /** groups this placeholder with others meant to share one uploaded image
   *  across slides; omitted = a fresh slot minted per slide. */
  slot?: string
}

export type OutlineSlide =
  | TitleSlide
  | SectionSlide
  | BulletsSlide
  | StatSlide
  | ChartSlide
  | TableSlide
  | QuoteSlide
  | ImageSlide

export interface Outline {
  title: string
  theme?: OutlineTheme
  slides: OutlineSlide[]
}

export interface OutlineError {
  field: string
  message: string
}

export interface OutlineParseResult {
  ok: boolean
  errors: OutlineError[]
  outline?: Outline
}

const LAYOUTS = new Set(['title', 'section', 'bullets', 'stat', 'chart', 'table', 'quote', 'image'])
const CHART_TYPES = new Set(['bar', 'line', 'pie'])
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

/** Max sizes are generous but real — a chat model that runs away with a
 *  1000-row table is a prompt-following failure, not something to silently
 *  truncate (truncating would ship a deck the author never saw). */
const MAX_SLIDES = 60
const MAX_BULLETS = 12
const MAX_TABLE_ROWS = 30
const MAX_CHART_POINTS = 40

function validateTheme(theme: unknown, errors: OutlineError[], field: string): void {
  if (theme === undefined) return
  if (!isObj(theme)) {
    errors.push({ field, message: 'must be an object' })
    return
  }
  for (const key of ['background', 'color', 'accent'] as const) {
    const v = theme[key]
    if (v !== undefined && (typeof v !== 'string' || !HEX_COLOR.test(v))) {
      errors.push({ field: `${field}.${key}`, message: 'must be a #rrggbb hex color' })
    }
  }
  if (theme.fontFamily !== undefined && typeof theme.fontFamily !== 'string') {
    errors.push({ field: `${field}.fontFamily`, message: 'must be a string' })
  }
}

function validateSlide(slide: unknown, i: number, errors: OutlineError[]): void {
  const where = `slides[${i}]`
  if (!isObj(slide)) {
    errors.push({ field: where, message: 'must be an object' })
    return
  }
  if (!LAYOUTS.has(slide.layout as string)) {
    errors.push({ field: `${where}.layout`, message: `must be one of ${[...LAYOUTS].join(', ')}` })
    return
  }
  if (slide.notes !== undefined && typeof slide.notes !== 'string') {
    errors.push({ field: `${where}.notes`, message: 'must be a string' })
  }
  if (slide.morphGroup !== undefined && typeof slide.morphGroup !== 'string') {
    errors.push({ field: `${where}.morphGroup`, message: 'must be a string' })
  }

  switch (slide.layout) {
    case 'title':
      if (!isNonEmptyString(slide.heading)) errors.push({ field: `${where}.heading`, message: 'required, non-empty string' })
      if (slide.subheading !== undefined && typeof slide.subheading !== 'string')
        errors.push({ field: `${where}.subheading`, message: 'must be a string' })
      break
    case 'section':
      if (!isNonEmptyString(slide.heading)) errors.push({ field: `${where}.heading`, message: 'required, non-empty string' })
      if (slide.kicker !== undefined && typeof slide.kicker !== 'string')
        errors.push({ field: `${where}.kicker`, message: 'must be a string' })
      break
    case 'bullets':
      if (!isNonEmptyString(slide.heading)) errors.push({ field: `${where}.heading`, message: 'required, non-empty string' })
      if (!isStringArray(slide.bullets) || slide.bullets.length === 0) {
        errors.push({ field: `${where}.bullets`, message: 'required, non-empty array of strings' })
      } else if (slide.bullets.length > MAX_BULLETS) {
        errors.push({ field: `${where}.bullets`, message: `at most ${MAX_BULLETS} bullets` })
      }
      break
    case 'stat':
      if (!isFiniteNumber(slide.value)) errors.push({ field: `${where}.value`, message: 'required, finite number' })
      if (!isNonEmptyString(slide.label)) errors.push({ field: `${where}.label`, message: 'required, non-empty string' })
      if (slide.heading !== undefined && typeof slide.heading !== 'string')
        errors.push({ field: `${where}.heading`, message: 'must be a string' })
      break
    case 'chart': {
      if (!CHART_TYPES.has(slide.chartType as string))
        errors.push({ field: `${where}.chartType`, message: 'must be bar, line, or pie' })
      const categories = slide.categories
      if (!isStringArray(categories) || categories.length === 0) {
        errors.push({ field: `${where}.categories`, message: 'required, non-empty array of strings' })
      } else if (categories.length > MAX_CHART_POINTS) {
        errors.push({ field: `${where}.categories`, message: `at most ${MAX_CHART_POINTS} categories` })
      }
      if (!Array.isArray(slide.series) || slide.series.length === 0) {
        errors.push({ field: `${where}.series`, message: 'required, non-empty array' })
      } else {
        if (slide.chartType === 'pie' && slide.series.length > 1) {
          errors.push({ field: `${where}.series`, message: 'pie charts take exactly one series' })
        }
        slide.series.forEach((s, si) => {
          const sw = `${where}.series[${si}]`
          if (!isObj(s) || !isNonEmptyString(s.name)) errors.push({ field: `${sw}.name`, message: 'required, non-empty string' })
          if (!isObj(s) || !Array.isArray(s.data) || !s.data.every((n) => isFiniteNumber(n))) {
            errors.push({ field: `${sw}.data`, message: 'required array of finite numbers' })
          } else if (Array.isArray(categories) && s.data.length !== categories.length) {
            errors.push({ field: `${sw}.data`, message: `length must match categories (${categories.length})` })
          }
        })
      }
      break
    }
    case 'table': {
      if (!isStringArray(slide.columns) || slide.columns.length === 0) {
        errors.push({ field: `${where}.columns`, message: 'required, non-empty array of strings' })
      }
      if (!Array.isArray(slide.rows) || slide.rows.length === 0) {
        errors.push({ field: `${where}.rows`, message: 'required, non-empty array' })
      } else if (slide.rows.length > MAX_TABLE_ROWS) {
        errors.push({ field: `${where}.rows`, message: `at most ${MAX_TABLE_ROWS} rows` })
      } else {
        const width = Array.isArray(slide.columns) ? slide.columns.length : -1
        slide.rows.forEach((r, ri) => {
          if (!isStringArray(r)) errors.push({ field: `${where}.rows[${ri}]`, message: 'must be an array of strings' })
          else if (width >= 0 && r.length !== width)
            errors.push({ field: `${where}.rows[${ri}]`, message: `length must match columns (${width})` })
        })
      }
      break
    }
    case 'quote':
      if (!isNonEmptyString(slide.quote)) errors.push({ field: `${where}.quote`, message: 'required, non-empty string' })
      if (slide.attribution !== undefined && typeof slide.attribution !== 'string')
        errors.push({ field: `${where}.attribution`, message: 'must be a string' })
      break
    case 'image':
      if (!isNonEmptyString(slide.alt)) errors.push({ field: `${where}.alt`, message: 'required, non-empty string' })
      if (slide.heading !== undefined && typeof slide.heading !== 'string')
        errors.push({ field: `${where}.heading`, message: 'must be a string' })
      if (slide.caption !== undefined && typeof slide.caption !== 'string')
        errors.push({ field: `${where}.caption`, message: 'must be a string' })
      if (slide.slot !== undefined && typeof slide.slot !== 'string')
        errors.push({ field: `${where}.slot`, message: 'must be a string' })
      break
  }
}

export function parseOutline(input: unknown): OutlineParseResult {
  const errors: OutlineError[] = []
  if (!isObj(input)) return { ok: false, errors: [{ field: 'outline', message: 'must be an object' }] }

  if (!isNonEmptyString(input.title)) errors.push({ field: 'title', message: 'required, non-empty string' })
  validateTheme(input.theme, errors, 'theme')

  if (!Array.isArray(input.slides) || input.slides.length === 0) {
    errors.push({ field: 'slides', message: 'required, non-empty array' })
  } else if (input.slides.length > MAX_SLIDES) {
    errors.push({ field: 'slides', message: `at most ${MAX_SLIDES} slides` })
  } else {
    input.slides.forEach((s, i) => validateSlide(s, i, errors))
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, errors: [], outline: input as unknown as Outline }
}
