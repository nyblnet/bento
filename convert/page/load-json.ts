// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Document JSON → a full, gated bento/slides document, for the convert page.
//
// slides' own entry for this (compactload.ts parseDocInputReport) also MEASURES
// text: a compact document may leave a text box's height out, and slides fits
// it with its renderer and the deck's fonts. That cannot work here. The
// renderer writes inline styles, which this page's hashed CSP blocks, and the
// deck's fonts are not loaded on this page. It would also add ~300 KB to the
// page. So this is the same expansion and the same gate, step for step, with
// the measuring left out, and the boxes that needed it are REPORTED: they keep
// a provisional one-line height until "Fit height to text" in the editor.

import { expandDocWithStats, isCompact } from '../../slides/src/compact.ts'
import { sanitizeDoc } from '../../slides/src/restoregate.ts'
import { sanitizeSlide, withDropReport, withPathSegment, type Dropped } from '../../slides/src/untrusted.ts'
import { parseDoc, type BentoDoc, type Slide } from '../../slides/src/model.ts'

export interface Loaded {
  doc: BentoDoc
  dropped: Array<{ path: string; reason: string }>
  /** text boxes left at a provisional height: their slide's id */
  provisional: string[]
}

export function loadDocJson(json: string): Loaded | null {
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return null }
  if (!isCompact(raw)) {
    const base = parseDoc(json)
    if (!base) return null
    const gated = sanitizeDoc(base as unknown as Record<string, unknown>)
    return gated ? { doc: gated.doc, dropped: gated.dropped, provisional: [] } : null
  }
  const { doc: expanded, stats } = expandDocWithStats(raw)
  const ex = expanded as unknown as Record<string, unknown>
  const { result: slides, dropped } = withDropReport(() =>
    ((ex.slides ?? []) as unknown[])
      .map((s, i) => withPathSegment('slides', () => withPathSegment(String(i), () => sanitizeSlide(s))))
      .filter((s): s is Slide => s !== null))
  ex.slides = slides
  const base = parseDoc(JSON.stringify(ex))
  if (!base) return null
  const gated = sanitizeDoc(base as unknown as Record<string, unknown>)
  if (!gated) return null
  const all: Dropped[] = [...dropped, ...gated.dropped, ...stats.notes.map((n) => ({ path: n.path, reason: n.reason } as Dropped))]
  const provisional = stats.autoHeight.map((a) => a.slide)
  return { doc: gated.doc, dropped: all, provisional }
}
