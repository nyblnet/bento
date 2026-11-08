// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The Word export, composed once: a saved bento/type file (or its document
// JSON) → .docx bytes plus the fidelity report. The CLI and bento.page/convert
// will call exactly this, so they cannot disagree about what a document is.
//
// Kept apart from export.ts on purpose, as export.ts is kept apart from api.ts:
// a host that converts only one way bundles only that way. And this file
// reaches type's model, which a slides-only host has no use for.
//
// NOT YET WIRED INTO THE PAGE. type/src/model.ts reaches its renderer and UI
// (xref → render, fields → features), about 318 KB minified, against 192 KB
// for the whole convert page today. The page row waits for a light parse entry
// from the type lane; the library, the rigs and (later) the CLI can use the
// model as it is.

import { exportDocx, type ExportDoc, type StyleIn } from './docx-write/index.ts'
import { extractDoc } from './deliver.ts'
import type { FidelityReport } from './report.ts'
import { parseDoc, withoutEmbeddedCaps } from '../../type/src/model.ts'
import { withoutCaps } from '../../kernel/src/docfields.ts'
import { BUILT_IN_STYLES, DEFAULT_STYLE_ID } from '../../type/src/docstyles.ts'
import { DOC_DEFAULTS } from '../../type/src/layout.ts'

export interface DocxExportResult {
  bytes: Uint8Array
  title: string
  report: FidelityReport
  stats: { paragraphs: number; lists: number; links: number }
}

/** type's own default face (styles.css `.t-paper` font fallback) and size. */
const TYPE_FAMILY = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif'
const TYPE_SIZE = 17

/**
 * A saved .bento.html, or the document JSON itself, → .docx. Refuses, with
 * what to do instead: an encrypted document (this takes no passwords) and
 * anything that is not bento/type.
 */
export async function typeToDocx(input: string, options: { at?: Date } = {}): Promise<DocxExportResult> {
  const raw = readInput(input)
  if (raw?.format === 'bento/enc')
    throw new Error('this document is password-protected — open it in Bento and save a copy without a password first')
  if (raw?.format !== 'bento/type')
    throw new Error(`this is a ${String(raw?.format ?? 'non-Bento')} file; only bento/type documents export to Word`)
  const parsed = parseDoc(JSON.stringify(raw))
  if (!parsed.ok) throw new Error(`the document did not pass the format check (${'detail' in parsed ? parsed.detail : parsed.err})`)
  // Never let sharing keys near an output file, even ones the writer ignores.
  // The capability strip itself, NOT docForExport: that is the "copy the
  // document JSON" projection, which also drops comments and saved versions,
  // and a Word file carries the comments (and reports the versions it drops).
  const doc = withoutEmbeddedCaps(withoutCaps(parsed.doc))
  const { bytes, report, stats } = await exportDocx(doc as unknown as ExportDoc, {
    builtInStyles: BUILT_IN_STYLES as unknown as Record<string, StyleIn>,
    kindStyles: DEFAULT_STYLE_ID as Record<string, string>,
    layoutDefaults: DOC_DEFAULTS,
    defaultFamily: TYPE_FAMILY,
    defaultSize: TYPE_SIZE,
    ...(options.at ? { at: options.at } : {}),
  })
  return { bytes, title: doc.title, report, stats }
}

/** The document in a .bento.html, or document JSON as given. JSON is
 *  recognised by its first character; a file is never guessed from its name. */
function readInput(input: string): Record<string, unknown> {
  const t = input.replace(/^﻿/, '').trimStart()
  if (t.startsWith('{')) {
    try { return JSON.parse(t) as Record<string, unknown> } catch {
      throw new Error('this looks like document JSON but does not parse')
    }
  }
  return extractDoc(input) as Record<string, unknown>
}
