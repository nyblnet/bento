// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The agent entry point for a document that may be compact (src/compact.ts).
// Kept apart from compact.ts so that module stays node-importable for the rig
// and the measure script: this one needs the untrusted gate (bundled) and the
// DOM (text measurement).
//
// parseDoc (model.ts) stays what it is — the file on disk is always full. The
// document text that arrives HERE ("Replace from JSON…", window.bento.loadDoc)
// comes from a chat, a tool, a clipboard — anywhere — so compact OR full, it
// gets the untrusted structural gate on the way in (restoregate.ts
// sanitizeDoc: sanitizeSlide, sanitizeAssets, sanitizeFonts, blob refs,
// unknown keys dropped — the same rule pasted clips, remote ops and restored
// snapshots meet), and with `live` it never brings its own identity: docId,
// collab and readonly stay the open deck's. A full document used to pass on
// parseDoc alone, which checks the format and nothing else.
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
import { expandDocWithStats, isCompact, STACK_GAP, type ExpandStats } from './compact'
import { measureElement } from './measure'
import { validateDoc, type ValidateResult } from './validate'
import { sanitizeDoc } from './restoregate'

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
  /** slides placed by layout + role (compact.ts round three) */
  laidOut: number
  /** bodies stacked into one slot — restacked again after a fonts-ready re-fit */
  stacks: ExpandStats['stacks']
}

/**
 * Parse document JSON that may be compact. Returns null on anything parseDoc
 * refuses. Expansion happens BEFORE parseDoc so the format/slides checks and
 * docId minting see a full document.
 */
export function parseDocInput(json: string): BentoDoc | null {
  return parseDocInputReport(json)?.doc ?? null
}

export interface InputOptions {
  /** run the text measurement (browser only); default: when there is a DOM */
  fit?: boolean
  /** the open document: its docId, collab and readonly are kept, never the input's */
  live?: BentoDoc
}

/** parseDocInput, plus the report. A bare boolean is the old `fit` argument. */
export function parseDocInputReport(json: string, opts: boolean | InputOptions = {}): { doc: BentoDoc; report: LoadReport } | null {
  const o: InputOptions = typeof opts === 'boolean' ? { fit: opts } : opts
  const fit = o.fit ?? typeof document !== 'undefined'
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return null }
  if (!isCompact(raw)) {
    const base = parseDoc(json)
    if (!base) return null
    const gated = sanitizeDoc(base as unknown as Record<string, unknown>, o.live)
    if (!gated) return null
    const doc = gated.doc
    return { doc, report: { ok: true, compact: false, dropped: gated.dropped, expanded: 0, fitted: 0, findings: validateDoc(doc), refit: [], laidOut: 0, stacks: [] } }
  }
  const { doc: expanded, stats } = expandDocWithStats(raw)
  const ex = expanded as unknown as Record<string, unknown>
  // paths read /slides/3/elements/2/fontSize — the slide index is ours to add
  const { result: slides, dropped } = withDropReport(() =>
    ((ex.slides ?? []) as unknown[])
      .map((s, i) => withPathSegment('slides', () => withPathSegment(String(i), () => sanitizeSlide(s))))
      .filter((s): s is Slide => s !== null))
  ex.slides = slides
  const base = parseDoc(JSON.stringify(ex))
  if (!base) return null
  // the rest of the document — assets, fonts, blobs, settings, identity — goes
  // through the same gate as a full one (slides pass again, idempotently)
  const gated = sanitizeDoc(base as unknown as Record<string, unknown>, o.live)
  if (!gated) return null
  const doc = gated.doc
  dropped.push(...gated.dropped)
  let fitted = 0
  let refit: ExpandStats['autoHeight'] = []
  if (fit && stats.autoHeight.length) {
    fitted = fitAutoHeights(doc, stats)
    restack(doc, stats)
    if (document.fonts?.status === 'loading') refit = stats.autoHeight
  }
  // a role the layout had no slot for is reported beside the gate's drops:
  // same shape, same loop for the agent (path → reason)
  const all = [...dropped, ...stats.notes.map((n) => ({ path: n.path, reason: n.reason } as Dropped))]
  return { doc, report: { ok: true, compact: true, dropped: all, expanded: stats.expanded, fitted, findings: validateDoc(doc), refit, laidOut: stats.laidOut, stacks: stats.stacks } }
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

/**
 * Bodies stacked into one layout slot got an equal share of its height in
 * compact.ts; now that each has its measured height, lay them top-to-bottom
 * with STACK_GAP between. If they do not fit the slot they still stack (the
 * validator's overflow finding says so) — never scaled or clipped here.
 * Exported for the fonts-ready re-fit.
 */
export function restack(doc: BentoDoc, stats: Pick<ExpandStats, 'stacks'>): void {
  for (const st of stats.stacks) {
    const slide = doc.slides.find((s) => s.id === st.slide)
    if (!slide) continue
    let y = st.slot.y
    for (const id of st.ids) {
      const el = slide.elements.find((e) => e.id === id)
      if (!el) continue
      el.y = y
      y += el.h + STACK_GAP
    }
  }
}

