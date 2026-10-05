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

export interface ExportResult {
  bytes: Uint8Array
  title: string
  report: FidelityReport
}

/**
 * A saved .bento.html → .pptx. Refuses, with what to do instead: an encrypted
 * deck (this takes no passwords), a raw compact document (an authoring shape
 * the app expands on load), and anything that is not bento/slides.
 */
export async function bentoToPptx(html: string): Promise<ExportResult> {
  const raw = extractDoc(html) as Record<string, unknown>
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
  const { bytes, report } = await exportPptx(doc as unknown as ExportDoc, {
    chartPalette: deriveChartPalette(doc.theme.accent),
  })
  return { bytes, title: doc.title, report }
}
