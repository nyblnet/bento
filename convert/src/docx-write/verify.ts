// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The Word package self-check, run on every export before the zip is written,
// so a file Word would offer to repair is never handed to anyone.
//
// The OPC wiring (part order, XML that parses, rels, r:ids, content types) is
// the PowerPoint writer's check, shared (pptx-write/verify.ts opcProblems).
// On top of it, what a Word document needs to be internally consistent:
// the parts Word writes for a blank document, every numbering instance a
// paragraph uses is defined and names a defined abstract list, and every
// paragraph and character style used is defined. Anything found is a WRITER
// bug, never the document's fault, so exportDocx refuses rather than reports.
//
// scripts/test-convert/docx-write.ts proves each check with a negative control.

import { parseXml, descendants, attr } from '../xml.ts'
import { opcProblems, type Parts } from '../pptx-write/verify.ts'
import { W_NS } from './parts.ts'

const dec = new TextDecoder()
const text = (parts: Parts, name: string): string => dec.decode(parts.get(name) ?? new Uint8Array())

/** Parts Word writes for every document (the schema calls most optional). */
const REQUIRED = [
  'word/document.xml', 'word/styles.xml', 'word/settings.xml', 'word/webSettings.xml',
  'word/fontTable.xml', 'docProps/core.xml', 'docProps/app.xml',
]

/** Everything wrong with a Word package, as readable lines. [] = nothing found. */
export function docxProblems(parts: Parts): string[] {
  const out = opcProblems(parts)
  for (const r of REQUIRED) if (!parts.has(r)) out.push(`missing ${r} (Word writes it for every document)`)
  let docEl, stylesEl
  try { docEl = parseXml(text(parts, 'word/document.xml')) } catch { return out } // reported by opcProblems
  try { stylesEl = parseXml(text(parts, 'word/styles.xml')) } catch { return out }

  const wval = (el: Parameters<typeof attr>[0]) => attr(el, 'w:val')

  // styles: every one used is defined, with the right type
  const defined = new Map<string, string>()
  for (const s of descendants(stylesEl, W_NS, 'style')) defined.set(attr(s, 'w:styleId') ?? '', attr(s, 'w:type') ?? '')
  for (const s of descendants(stylesEl, W_NS, 'basedOn')) if (!defined.has(wval(s) ?? '')) out.push(`a style is based on undefined style ${wval(s)}`)
  for (const s of descendants(docEl, W_NS, 'pStyle')) {
    const id = wval(s) ?? ''
    if (defined.get(id) !== 'paragraph') out.push(`paragraph style ${id} is used but not defined as a paragraph style`)
  }
  for (const s of descendants(docEl, W_NS, 'rStyle')) {
    const id = wval(s) ?? ''
    if (defined.get(id) !== 'character') out.push(`character style ${id} is used but not defined as a character style`)
  }

  // numbering: every numId used is a w:num, and every w:num an abstractNum
  const used = new Set(descendants(docEl, W_NS, 'numId').map((n) => wval(n) ?? ''))
  if (used.size) {
    if (!parts.has('word/numbering.xml')) out.push('paragraphs are numbered but there is no numbering.xml')
    else {
      let numEl
      try { numEl = parseXml(text(parts, 'word/numbering.xml')) } catch { return out }
      const abstract = new Set(descendants(numEl, W_NS, 'abstractNum').map((a) => attr(a, 'w:abstractNumId')))
      const nums = new Map<string, string | undefined>()
      for (const n of descendants(numEl, W_NS, 'num')) {
        const a = descendants(n, W_NS, 'abstractNumId')[0]
        nums.set(attr(n, 'w:numId') ?? '', a ? wval(a) : undefined)
      }
      for (const id of used) {
        if (!nums.has(id)) out.push(`numId ${id} is used but not defined`)
        else if (!abstract.has(nums.get(id))) out.push(`numId ${id} names an undefined abstract list`)
      }
    }
  }

  // revision ids are unique (Word repairs a document with duplicates)
  const ids = [...descendants(docEl, W_NS, 'ins'), ...descendants(docEl, W_NS, 'del')].map((e) => attr(e, 'w:id'))
  if (new Set(ids).size !== ids.length) out.push('two tracked changes share a revision id')
  return out
}
