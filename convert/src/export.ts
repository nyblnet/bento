// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The export, composed once: a saved bento/slides file → .pptx bytes plus the
// fidelity report. The CLI calls this; a script or a future host can too.
//
// Kept apart from api.ts on purpose. bento.page/import bundles api.ts, and the
// page has no use for a PowerPoint writer, so the writer never reaches it
// (scripts/test-convert/boundary.ts checks the page bundle).

import { exportPptx, type ExportDoc } from './pptx-write/index.ts'
import { extractDoc } from './deliver.ts'
import type { FidelityReport } from './report.ts'
import { parseDoc, deriveChartPalette } from '../../slides/src/model.ts'
import { resolveMathHtml } from '../../slides/src/maths/delimiters.ts'

export interface ExportResult {
  bytes: Uint8Array
  title: string
  report: FidelityReport
  stats: { slides: number; editable: number; pictures: number }
}

/**
 * A saved .bento.html, or the document JSON itself (what "Copy document JSON"
 * gives), → .pptx. Refuses, with what to do instead: an encrypted deck (this
 * takes no passwords), a raw compact document (an authoring shape the app
 * expands on load), and anything that is not bento/slides.
 */
export async function bentoToPptx(input: string): Promise<ExportResult> {
  const raw = readInput(input)
  if (raw?.format === 'bento/enc')
    throw new Error('this deck is password-protected — open it in Bento and use Save ▾ Save a copy without a password first')
  if (raw?.compact === true)
    throw new Error('this is a compact authoring document — open it in Bento once and save it, then export the saved file')
  if (raw?.format !== 'bento/slides')
    throw new Error(`this is a ${String(raw?.format ?? 'non-Bento')} file; only bento/slides decks export to PowerPoint`)
  return docToPptx(JSON.stringify(raw))
}

/**
 * A bento/slides document (JSON text) → .pptx. The document goes through
 * slides' own parseDoc first, so the writer only ever sees a document the app
 * itself would open.
 */
export async function docToPptx(json: string): Promise<ExportResult> {
  const doc = parseDoc(json)
  if (!doc) throw new Error('the deck did not pass the format check')
  // The deck's chart palette: what the app would give a new chart. The writer
  // cannot derive it (it never imports an app), so it is passed in here.
  // doc.theme.chartPalette still wins inside the writer when the deck has one.
  const { bytes, report, stats } = await exportPptx(doc as unknown as ExportDoc, {
    chartPalette: deriveChartPalette(doc.theme.accent),
    formulasIn: countFormulas,
  })
  return { bytes, title: doc.title, report, stats }
}

/** The document in a .bento.html, or document JSON as given. JSON is
 *  recognised by its first character; a file is never guessed from its name. */
function readInput(input: string): Record<string, unknown> {
  const t = input.replace(/^\uFEFF/, '').trimStart()
  if (t.startsWith('{')) {
    try { return JSON.parse(t) as Record<string, unknown> } catch {
      throw new Error('this looks like document JSON but does not parse')
    }
  }
  return extractDoc(input) as Record<string, unknown>
}

/** How many formulas slides would typeset in this html: the app's own
 *  scanner, asked to render nothing, counting what it was offered. */
function countFormulas(html: string): number {
  let n = 0
  resolveMathHtml(html, () => { n++; return null })
  return n
}
