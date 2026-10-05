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
import { parseXml, kids, attr, NS } from '../../convert/src/xml.ts'
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

function resolvePath(baseDir: string, target: string): string {
  const segs = baseDir ? baseDir.split('/') : []
  for (const part of target.split('/')) {
    if (part === '..') segs.pop()
    else if (part !== '.' && part !== '') segs.push(part)
  }
  return segs.join('/')
}

/** Every internal rel target in every .rels part must be a zip part. */
export function brokenRels(parts: ZipParts): string[] {
  const broken: string[] = []
  for (const [name, data] of parts) {
    if (!name.endsWith('.rels')) continue
    // ppt/slides/_rels/slide1.xml.rels belongs to ppt/slides/slide1.xml —
    // rels resolve against the OWNER part's directory, not the _rels dir.
    const baseDir = name === '_rels/.rels' ? '' : name.slice(0, name.indexOf('/_rels/'))
    for (const rel of kids(parseXml(dec.decode(data)), NS.rel, 'Relationship')) {
      if (attr(rel, 'TargetMode') === 'External') continue
      const target = resolvePath(baseDir, attr(rel, 'Target') ?? '')
      if (!parts.has(target)) broken.push(`${name} -> ${target}`)
    }
  }
  return broken
}

/** Every r:id/r:embed/r:link in a part must name a rel in ITS rels part. */
export function danglingRefs(xml: string, relsXml: string): string[] {
  const ids = new Set([...relsXml.matchAll(/Id="(rId\d+)"/g)].map((m) => m[1]))
  const missing: string[] = []
  for (const m of xml.matchAll(/r:(?:id|embed|link)="([^"]+)"/g)) {
    if (!ids.has(m[1])) missing.push(m[1])
  }
  return missing
}

/** Parts PowerPoint needs that the schema calls optional (learned the hard
 *  way: without them it offers to repair the file). */
const REQUIRED = ['ppt/presProps.xml', 'ppt/viewProps.xml', 'ppt/tableStyles.xml', 'docProps/core.xml', 'docProps/app.xml']

/** Everything wrong with a package, as readable lines. [] = nothing found. */
export function packageProblems(parts: ZipParts): string[] {
  const out: string[] = []
  if ([...parts.keys()][0] !== '[Content_Types].xml') out.push('[Content_Types].xml is not the first zip entry')
  for (const name of parts.keys()) {
    if (!/\.(xml|rels)$/.test(name)) continue
    try { parseXml(partText(parts, name)) } catch (e) { out.push(`${name} does not parse: ${e}`) }
  }
  for (const b of brokenRels(parts)) out.push(`broken rel ${b}`)
  for (const name of parts.keys()) {
    if (name.endsWith('.rels') || !name.endsWith('.xml')) continue
    const slash = name.lastIndexOf('/')
    const rels = `${name.slice(0, slash)}/_rels/${name.slice(slash + 1)}.rels`
    if (!parts.has(rels)) continue
    for (const id of danglingRefs(partText(parts, name), partText(parts, rels))) out.push(`${name}: ${id} has no rel`)
  }
  // typed: an Override for the part, or a Default for its extension
  let ct
  try { ct = parseXml(partText(parts, '[Content_Types].xml')) } catch { ct = null }
  if (ct) {
    const overrides = new Set(kids(ct, NS.ct, 'Override').map((o) => attr(o, 'PartName')))
    const defaults = new Set(kids(ct, NS.ct, 'Default').map((d) => (attr(d, 'Extension') ?? '').toLowerCase()))
    for (const name of parts.keys()) {
      if (name === '[Content_Types].xml') continue
      const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
      if (!overrides.has(`/${name}`) && !defaults.has(ext)) out.push(`${name} has no content type`)
    }
    for (const o of overrides) if (o && !parts.has(o.slice(1))) out.push(`content type for missing part ${o}`)
  }
  for (const r of REQUIRED) if (!parts.has(r)) out.push(`missing ${r} (PowerPoint requires it)`)
  // a notes master needs notesStyle and a theme part of its own
  const nm = 'ppt/notesMasters/notesMaster1.xml'
  if (parts.has(nm)) {
    if (!/<p:notesStyle>/.test(partText(parts, nm))) out.push('notes master has no p:notesStyle')
    const nmRels = partText(parts, 'ppt/notesMasters/_rels/notesMaster1.xml.rels')
    const smRels = partText(parts, 'ppt/slideMasters/_rels/slideMaster1.xml.rels')
    const themeOf = (rels: string) => /Target="\.\.\/theme\/(theme\d+\.xml)"/.exec(rels)?.[1]
    if (!themeOf(nmRels) || themeOf(nmRels) === themeOf(smRels)) out.push('notes master does not own a theme part')
  }
  return out
}
