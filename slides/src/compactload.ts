// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The agent entry point for a document that may be compact (src/compact.ts).
// Kept apart from compact.ts so that module stays node-importable for the rig
// and the measure script: this one needs the untrusted gate (bundled) and the
// DOM (text measurement).
//
// parseDoc (model.ts) stays what it is — the file on disk is always full. A
// COMPACT document is authored by a tool, so it gets the untrusted shape gate
// on the way in (sanitizeSlide, the same rule pasted clips and remote ops
// meet): an unknown key or a malformed value is dropped rather than reaching
// the renderer. A full document is not gated here — that is today's
// behaviour and today's promise (your own file is yours).
//
// Round two adds the LOAD REPORT: what the gate dropped (path + reason), what
// expansion filled, and validate()'s findings on the result — so an agent's
// loop is load → read the report → fix → reload, instead of guessing why a
// field vanished. And fit-to-text: a text element that omitted `h` arrives
// from expandDoc with a provisional one-line height; here it is measured the
// way the panel's "Fit height to text" measures (measureElement, the deck's
// real fonts) and given its true height BEFORE the document reaches the store,
// so undo never sees the provisional frame.

import { parseDoc, type BentoDoc, type Slide, type TextElement } from './model'
import { sanitizeSlide, withDropReport, withPathSegment, type Dropped } from './untrusted'
import { expandDocWithStats, isCompact, type ExpandStats } from './compact'
import { measureElement } from './measure'
import { validateDoc, type ValidateResult } from './validate'

export interface LoadReport {
  ok: true
  /** was the input compact (expanded here) or full (taken as is)? */
  compact: boolean
  /** every key/value the gate discarded, with a JSON-pointer-ish path */
  dropped: Dropped[]
  /** fields expansion filled from the editor's defaults */
  expanded: number
  /** text elements whose h was fitted to their text */
  fitted: number
  /** validate() on the loaded document */
  findings: ValidateResult
  /** the elements still to re-fit once document.fonts settles (heights were
   *  measured against fallback fonts); empty when fonts were ready */
  refit: ExpandStats['autoHeight']
}

/**
 * Parse document JSON that may be compact. Returns null on anything parseDoc
 * refuses. Expansion happens BEFORE parseDoc so the format/slides checks and
 * docId minting see a full document.
 */
export function parseDocInput(json: string): BentoDoc | null {
  return parseDocInputReport(json)?.doc ?? null
}

/** parseDocInput, plus the report. `fit` runs the text measurement (browser
 *  only); it is skipped where there is no DOM. */
export function parseDocInputReport(json: string, fit = typeof document !== 'undefined'): { doc: BentoDoc; report: LoadReport } | null {
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return null }
  if (!isCompact(raw)) {
    const doc = parseDoc(json)
    if (!doc) return null
    return { doc, report: { ok: true, compact: false, dropped: [], expanded: 0, fitted: 0, findings: validateDoc(doc), refit: [] } }
  }
  const { doc: expanded, stats } = expandDocWithStats(raw)
  const ex = expanded as unknown as Record<string, unknown>
  // paths read /slides/3/elements/2/fontSize — the slide index is ours to add
  const { result: slides, dropped } = withDropReport(() =>
    ((ex.slides ?? []) as unknown[])
      .map((s, i) => withPathSegment('slides', () => withPathSegment(String(i), () => sanitizeSlide(s))))
      .filter((s): s is Slide => s !== null))
  ex.slides = slides
  const doc = parseDoc(JSON.stringify(ex))
  if (!doc) return null
  let fitted = 0
  let refit: ExpandStats['autoHeight'] = []
  if (fit && stats.autoHeight.length) {
    fitted = fitAutoHeights(doc, stats)
    if (document.fonts?.status === 'loading') refit = stats.autoHeight
  }
  return { doc, report: { ok: true, compact: true, dropped, expanded: stats.expanded, fitted, findings: validateDoc(doc), refit } }
}

/**
 * Give every provisional text height its measured value. Returns how many
 * were written. Exported so the fonts-ready re-fit (main.ts) and the rig can
 * call it on a loaded document.
 */
export function fitAutoHeights(doc: BentoDoc, stats: Pick<ExpandStats, 'autoHeight'>): number {
  let n = 0
  for (const { slide: sid, id } of stats.autoHeight) {
    const slide = doc.slides.find((s) => s.id === sid)
    const el = slide?.elements.find((e) => e.id === id)
    if (!el || el.type !== 'text') continue
    const tx = el as TextElement
    if (!tx.html?.trim()) continue
    const m = measureElement(tx, doc)
    if (m.height > 0 && m.height !== tx.h) { tx.h = m.height; n++ }
  }
  return n
}
