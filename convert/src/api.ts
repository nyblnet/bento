// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The import, composed once — the CLI and the public import page both call
// exactly this, so they cannot disagree about limits, gating or splicing.

import { convertPptx } from './pptx.ts'
import { gateDoc, spliceIntoShell } from './deliver.ts'
import { preflight } from './limits.ts'
import type { FidelityReport } from './report.ts'
import type { Dropped } from '../../slides/src/untrusted.ts'

export { fetchVerifiedShell, SLIDES_MANIFEST, MIN_SHELL_VERSION } from './deliver.ts'
export { LIMITS, LimitError } from './limits.ts'

export interface ImportResult {
  html: string
  title: string
  slides: number
  /** what the conversion carried, approximated and dropped */
  report: FidelityReport
  /** what the untrusted-input gate removed on top — expected to be empty for
   *  anything this importer produced from a well-formed deck */
  gated: Dropped[]
}

/** .pptx bytes + a verified shell → a .bento.html. */
export async function pptxToBento(pptx: Uint8Array, shellHtml: string): Promise<ImportResult> {
  preflight(pptx)
  const { doc, report } = await convertPptx(pptx)
  const { doc: safe, dropped } = gateDoc(doc)
  return {
    html: spliceIntoShell(shellHtml, safe),
    title: safe.title,
    slides: safe.slides.length,
    report,
    gated: dropped,
  }
}
