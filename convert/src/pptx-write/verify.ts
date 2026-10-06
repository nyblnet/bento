// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The package self-check: run on every export before the zip is written, so
// a package PowerPoint would offer to repair is never handed to anyone.
//
// It checks what has bitten this writer before. Every rel target exists,
// every r:id in a part resolves in that part's own rels, every part has a
// content type (and no content type names a missing part), every XML part
// parses, [Content_Types].xml comes first, and the parts the schema calls
// optional but PowerPoint requires are present. A notes master must also
// carry notesStyle and own its theme. Anything found is a WRITER bug, never
// the deck's fault, so exportPptx refuses rather than reporting.
//
// The test harness (scripts/test-convert/_export-harness.ts) re-exports these;
// pptx-write.ts proves each check with a negative control.

import { parseXml, kids, attr, NS } from '../xml.ts'

/** Parts in package order, by name. */
export type Parts = Map<string, Uint8Array>

const dec = new TextDecoder()
const text = (parts: Parts, name: string): string => dec.decode(parts.get(name) ?? new Uint8Array())

function resolvePath(baseDir: string, target: string): string {
  const segs = baseDir ? baseDir.split('/') : []
  for (const part of target.split('/')) {
    if (part === '..') segs.pop()
    else if (part !== '.' && part !== '') segs.push(part)
  }
  return segs.join('/')
}

/** Every internal rel target in every .rels part must be a part. */
export function brokenRels(parts: Parts): string[] {
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

/** Parts PowerPoint needs that the schema calls optional (without them it
 *  offers to repair the file). */
const REQUIRED = ['ppt/presProps.xml', 'ppt/viewProps.xml', 'ppt/tableStyles.xml', 'docProps/core.xml', 'docProps/app.xml']

/** Everything wrong with a package, as readable lines. [] = nothing found. */
export function packageProblems(parts: Parts): string[] {
  const out: string[] = []
  if ([...parts.keys()][0] !== '[Content_Types].xml') out.push('[Content_Types].xml is not the first part')
  for (const name of parts.keys()) {
    if (!/\.(xml|rels)$/.test(name)) continue
    try { parseXml(text(parts, name)) } catch (e) { out.push(`${name} does not parse: ${e}`) }
  }
  try { for (const b of brokenRels(parts)) out.push(`broken rel ${b}`) } catch { /* reported as a parse failure above */ }
  for (const name of parts.keys()) {
    if (name.endsWith('.rels') || !name.endsWith('.xml')) continue
    const slash = name.lastIndexOf('/')
    const rels = `${name.slice(0, slash)}/_rels/${name.slice(slash + 1)}.rels`
    if (!parts.has(rels)) continue
    for (const id of danglingRefs(text(parts, name), text(parts, rels))) out.push(`${name}: ${id} has no rel`)
  }
  let ct = null
  try { ct = parseXml(text(parts, '[Content_Types].xml')) } catch { /* reported above */ }
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
  const nm = 'ppt/notesMasters/notesMaster1.xml'
  if (parts.has(nm)) {
    if (!/<p:notesStyle>/.test(text(parts, nm))) out.push('notes master has no p:notesStyle')
    const themeOf = (rels: string) => /Target="\.\.\/theme\/(theme\d+\.xml)"/.exec(rels)?.[1]
    const own = themeOf(text(parts, 'ppt/notesMasters/_rels/notesMaster1.xml.rels'))
    if (!own || own === themeOf(text(parts, 'ppt/slideMasters/_rels/slideMaster1.xml.rels')))
      out.push('notes master does not own a theme part')
  }
  return out
}
