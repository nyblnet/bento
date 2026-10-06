// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The export test harness: export a deck (or one element), get the package
// back as parts, and ask what is wrong with it.
//
//   const r = await exportOne({ type: 'code', ...frame(80, 80, 400, 200), content: 'x = 1', … })
//   r.problems   // [] when the package is wired the way PowerPoint checks it
//   r.slideXml   // the slide part, to assert on what the writer emitted
//   r.codes      // the fidelity report's codes
//
// packageProblems() is the same wiring check pptx-write.ts proves with
// negative controls: every rel target exists, every r:id resolves in its own
// rels part, every part is typed, every XML part parses, [Content_Types].xml
// comes first, and the boilerplate PowerPoint requires (but the schema calls
// optional) is present. A package can be schema-valid and still make
// PowerPoint offer to repair it; that is why these checks exist, and why the
// last step for any writer change is opening a real deck in real PowerPoint.
//
// Files whose names start with `_` are helpers, not rigs: the runner
// (scripts/test-convert.ts) skips them.

import { readZip, type ZipParts } from '../../kernel/src/convert/zip.ts'
import { packageProblems } from '../../convert/src/pptx-write/verify.ts'
import { exportPptx, type ExportDoc, type ExportElement, type ExportOpts } from '../../convert/src/pptx-write/index.ts'
import type { FidelityReport } from '../../convert/src/report.ts'

const dec = new TextDecoder()
export const partText = (parts: ZipParts, name: string): string => dec.decode(parts.get(name) ?? new Uint8Array())

/** An element frame, as every bento/slides element carries one. */
export const frame = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, rotation: 0, opacity: 1 })

/** A one-slide deck around the given elements. */
export function deck(elements: unknown[], over: Partial<ExportDoc> = {}): ExportDoc {
  return {
    title: 'Harness deck',
    size: { width: 1280, height: 720 },
    theme: { background: '#ffffff', color: '#1e2a3a', accent: '#ff7a59', fontFamily: 'Inter, sans-serif' },
    slides: [{ id: 's1', background: '#ffffff', elements: elements as ExportElement[] }],
    ...over,
  }
}

export interface Exported {
  parts: ZipParts
  report: FidelityReport
  /** the report's codes, for `codes.has('…')` */
  codes: Set<string>
  /** ppt/slides/slide1.xml */
  slideXml: string
  /** what is wrong with the package; [] when nothing is */
  problems: string[]
}

export async function exportDeck(doc: ExportDoc, opts: ExportOpts = {}): Promise<Exported> {
  const { bytes, report } = await exportPptx(doc, opts)
  const parts = await readZip(bytes)
  return {
    parts,
    report,
    codes: new Set(report.entries.map((e) => e.code)),
    slideXml: partText(parts, 'ppt/slides/slide1.xml'),
    problems: packageProblems(parts),
  }
}

/** Export a one-slide deck holding just this element. */
export const exportOne = (element: unknown, opts: ExportOpts = {}): Promise<Exported> =>
  exportDeck(deck([{ id: 'el1', ...frame(80, 80, 400, 200), ...(element as object) }]), opts)

// --- the wiring checks -------------------------------------------------------
// They live in the library now (convert/src/pptx-write/verify.ts): every
// export runs them before writing the zip. Re-exported here for the rigs.
export { brokenRels, danglingRefs, packageProblems } from '../../convert/src/pptx-write/verify.ts'
