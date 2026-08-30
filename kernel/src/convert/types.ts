// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The convert engine's shared contract.
//
// STRUCTURAL OUTPUT TYPES, NOT AN IMPORT FROM slides/. The kernel is shared
// code and must not depend on an app; the same inversion the charts engine
// uses (kernel/src/charts.ts declares its own option shape, slides satisfies
// it structurally). These types describe the SUBSET of bento/slides the
// importer emits — slides' parseDoc validates the real thing on load, and the
// e2e rig asserts the emitted JSON loads there. Field names and semantics must
// match slides/src/model.ts exactly; when in doubt, that file wins.

import type { Report } from './report.ts'
import type { XElem } from './xml.ts'

// --- the emitted document (bento/slides subset) ------------------------------

export interface OutShadow { x?: number; y?: number; blur: number; color: string }

export interface OutElementBase {
  id: string
  x: number; y: number; w: number; h: number
  rotation: number
  opacity: number
  link?: string
  groupId?: string
  role?: string
  shadow?: OutShadow | OutShadow[]
}

export interface OutText extends OutElementBase {
  type: 'text'
  html: string
  fontSize: number
  fontFamily: string
  fontWeight: number
  color: string
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'middle' | 'bottom'
  lineHeight: number
  letterSpacing?: number
}

export interface OutGradient { angle: number; stops: Array<{ at: number; color: string }> }

export interface OutShape extends OutElementBase {
  type: 'shape'
  shape: 'rect' | 'ellipse' | 'triangle' | 'arrow' | 'line' | 'path'
  fill: string
  stroke: string
  strokeWidth: number
  radius: number
  strokeStyle?: 'solid' | 'dashed' | 'dotted'
  lineStart?: 'none' | 'arrow' | 'dot' | 'bar'
  lineEnd?: 'none' | 'arrow' | 'dot' | 'bar'
  fillGradient?: OutGradient
  d?: string
  pathBox?: [number, number, number, number]
  from?: { el: string; side: string }
  to?: { el: string; side: string }
}

export interface OutImage extends OutElementBase {
  type: 'image'
  src: string
  fit: 'cover' | 'contain' | 'fill'
  radius?: number
}

export interface OutTableCell { html: string; align?: string; color?: string; bg?: string; bold?: boolean }

export interface OutTable extends OutElementBase {
  type: 'table'
  columns: Array<{ w: number }>
  rows: Array<{ cells: OutTableCell[] }>
  header: boolean
  style?: Record<string, unknown>
}

export interface OutChart extends OutElementBase {
  type: 'chart'
  preset: 'bar' | 'line' | 'pie' | 'scatter'
  option: Record<string, unknown>
}

export type OutElement = OutText | OutShape | OutImage | OutTable | OutChart

export interface OutSlide {
  id: string
  name: string
  background: string
  /** ALWAYS set explicitly — slides' own constructors default to 'fade', and
   *  71 of 79 census slides carry no transition at all */
  transition: 'none' | 'fade' | 'slide' | 'zoom' | 'morph'
  notes: string
  elements: OutElement[]
  hidden?: boolean
}

export interface OutDoc {
  format: 'bento/slides'
  version: '1.0.0'
  title: string
  size: { width: number; height: number }
  theme: { background: string; color: string; accent: string; fontFamily: string }
  assets: Record<string, string>
  fonts: Array<{ family: string; asset: string; weight?: number }> | null
  slides: OutSlide[]
}

// --- resolution context ------------------------------------------------------

/** A parsed theme part (theme1.xml) plus the master's colour map. */
export interface ThemeCtx {
  /** scheme slot → resolved hex, AFTER clrMap application: keys are the
   *  logical names colour references use (bg1, tx1, bg2, tx2, accent1..6,
   *  hlink, folHlink) */
  scheme: Record<string, string>
  /** major (heading) and minor (body) latin typefaces, as named in the file */
  majorFont: string
  minorFont: string
  /** raw fmtScheme lists for fillRef/lnRef resolution (fill styles, line
   *  styles, background fill styles) — resolved lazily with phClr substituted */
  fillStyles: XElem[]
  lineStyles: XElem[]
  bgFillStyles: XElem[]
}

/** One resolved colour. */
export interface ResolvedColor {
  /** css color, '#rrggbb' or rgba(...) when alpha < 1 */
  css: string
  from: 'own' | 'theme'
}

/**
 * The inheritance chain for one slide: everything a shape may need to look up
 * when its own XML is silent. ~513 census shapes carry no geometry and 100+
 * no transform at all — their values live only up this chain.
 */
export interface InheritCtx {
  slide: XElem
  layout?: XElem
  master?: XElem
  theme: ThemeCtx
  report: Report
}

// --- conversion result -------------------------------------------------------

export interface ConvertResult {
  doc: OutDoc
  report: import('./report.ts').FidelityReport
}

/** EMU per pixel at 96dpi — OOXML's unit; 12192000 EMU = 1280px exactly. */
export const EMU_PER_PX = 9525

/**
 * Metric-compatible substitutes: same advance widths, so line breaks land
 * where PowerPoint put them. The engine maps NAMES (byte embedding is a host
 * concern); the emitted stack keeps the original first so a machine that has
 * the real face uses it.
 */
export const METRIC_SUBSTITUTES: Record<string, string> = {
  Calibri: 'Carlito',
  Cambria: 'Caladea',
  Arial: 'Liberation Sans',
  'Times New Roman': 'Liberation Serif',
  'Courier New': 'Liberation Mono',
}
