// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The conversion table: what a dropped file is, and every output the engine
// can make from it. bento.page/convert is a view over this table and nothing
// else, so a new format is a new ROW here, never a new page. A converter that
// produces Markdown from a bento/spaces file, say, is one more entry in
// CONVERSIONS with its own `accepts` and `run`.
//
// DOM-free, like the rest of convert/src. What only a browser can do (measure
// text while expanding a compact document) comes in through `Env`, from the
// page that hosts it.

import { pptxToBento, LimitError } from './api.ts'
import { bentoToPptx } from './export.ts'
import { extractDoc, spliceIntoShell } from './deliver.ts'
import type { FidelityReport } from './report.ts'
import type { BentoDoc } from '../../slides/src/model.ts'

// --- what was dropped --------------------------------------------------------

/** A Bento document, from a .bento.html or as document JSON. */
export interface BentoInput {
  kind: 'bento'
  name: string
  /** where the document came from: a saved file, or JSON as given */
  source: 'html' | 'json'
  /** doc.format: 'bento/slides', 'bento/spaces', 'bento/dash', 'bento/type', 'bento/enc' */
  format: string
  /** the input text, as read */
  text: string
  /** the parsed document (untrusted: only read for detection and summary) */
  doc: Record<string, unknown>
  compact: boolean
}

export interface PptxInput {
  kind: 'pptx'
  name: string
  bytes: Uint8Array
}

export interface UnknownInput {
  kind: 'unknown'
  name: string
  /** why it was not recognised, in words for the person */
  reason: string
}

export type Detected = BentoInput | PptxInput | UnknownInput

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]
const isZip = (b: Uint8Array) => ZIP_MAGIC.every((v, i) => b[i] === v)

/** What a file is. Recognised by content, with the name only as a hint. */
export function detect(name: string, bytes: Uint8Array): Detected {
  if (isZip(bytes)) {
    if (/\.pptx$/i.test(name)) return { kind: 'pptx', name, bytes }
    return { kind: 'unknown', name, reason: /\.(xlsx|docx)$/i.test(name)
      ? 'Excel and Word files are not converted yet. PowerPoint (.pptx) files are.'
      : 'This is a zip archive, but not a PowerPoint (.pptx) file.' }
  }
  const text = new TextDecoder().decode(bytes)
  const trimmed = text.replace(/^﻿/, '').trimStart()
  let doc: unknown
  let source: 'html' | 'json'
  if (trimmed.startsWith('{')) {
    source = 'json'
    try { doc = JSON.parse(trimmed) } catch {
      return { kind: 'unknown', name, reason: 'This looks like JSON but does not parse.' }
    }
  } else {
    source = 'html'
    try { doc = extractDoc(text) } catch (e) {
      return { kind: 'unknown', name, reason: /no #bento-doc/.test(String((e as Error).message))
        ? 'This is not a Bento file. Drop a .bento.html, a Bento document’s JSON, or a PowerPoint (.pptx).'
        : `This Bento file could not be read: ${(e as Error).message}.` }
    }
  }
  const d = doc as Record<string, unknown>
  if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.format !== 'string' || !d.format.startsWith('bento/'))
    return { kind: 'unknown', name, reason: 'This JSON is not a Bento document (it has no bento/… format).' }
  return { kind: 'bento', name, source, format: d.format, text, doc: d, compact: d.compact === true }
}

/** A one-line description of a recognised input, for the "your file" card. */
export function describe(d: Detected): { title: string; meta: string } {
  if (d.kind === 'pptx') return { title: d.name, meta: `PowerPoint presentation · ${size(d.bytes.length)}` }
  if (d.kind === 'unknown') return { title: d.name, meta: d.reason }
  const app = APP_NAMES[d.format] ?? d.format
  if (d.format === 'bento/enc') return { title: d.name, meta: 'A password-protected Bento file' }
  const title = typeof d.doc.title === 'string' && d.doc.title ? d.doc.title : d.name
  const slides = Array.isArray(d.doc.slides) ? d.doc.slides.filter((s) => !(s as { stateOf?: unknown })?.stateOf).length : 0
  const sz = d.doc.size as { width?: unknown; height?: unknown } | undefined
  const dims = sz && Number.isFinite(sz.width) && Number.isFinite(sz.height) ? ` · ${sz.width} × ${sz.height} px` : ''
  const what = d.format === 'bento/slides' && slides ? `${slides} slide${slides === 1 ? '' : 's'}${dims}` : app
  const from = d.source === 'json' ? (d.compact ? ' · compact document JSON' : ' · document JSON') : ''
  return { title, meta: `${what}${from}` }
}

const APP_NAMES: Record<string, string> = {
  'bento/slides': 'A bento/slides deck',
  'bento/spaces': 'A bento/spaces file',
  'bento/dash': 'A bento/dash workbook',
  'bento/type': 'A bento/type document',
}

const size = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

// --- what it can become -------------------------------------------------------

export interface Env {
  /** the current signed bento/slides shell (deliver.ts fetchVerifiedShell) */
  shell(): Promise<{ version: string; html: string }>
  /** document JSON → a full, gated slides document, expanding a compact one.
   *  The page passes its own loader (convert/page/load-json.ts: slides'
   *  expansion and gate). `provisional` lists the slide id of each text box
   *  left at a provisional height (nothing measured it). Null when the format
   *  check refuses it. */
  /** a picture PowerPoint cannot take → PNG data: URI (needs a canvas) */
  rasterise?(dataUri: string): Promise<string | null>
  loadDocJson?(json: string): { doc: BentoDoc; dropped: Array<{ path: string; reason: string }>; provisional?: string[] } | null
}

export interface Converted {
  bytes: Uint8Array
  fileName: string
  mime: string
  report: FidelityReport
  /** shown as the result's stat tiles, in order */
  stats: Array<{ label: string; value: number }>
  /** one line under the file name, e.g. which shell it was built on */
  meta?: string
}

export interface Conversion {
  id: string
  /** what the output is, for the person choosing ("PowerPoint (.pptx)") */
  label: string
  /** one line on what to expect */
  hint: string
  /** true, or why this input cannot take this path (shown, not hidden) */
  accepts(d: Detected): boolean | string
  /** does it fetch the signed shell? (the only network the page ever uses) */
  network: boolean
  /** yes/no choices this conversion takes, shown only where they apply */
  flags?: Array<{ id: string; label: string; applies(d: Detected): boolean; /** ticked unless the person unticks it */ default: boolean }>
  run(d: Detected, env: Env, flags?: Record<string, boolean>): Promise<Converted>
}

const base = (name: string) => name.replace(/(\.bento)?\.(html?|json|pptx)$/i, '')
const emptyReport = (): FidelityReport => ({ entries: [], counts: { carried: 0, approximated: 0, dropped: 0 }, provenance: {} })
const enc = new TextEncoder()

export const CONVERSIONS: Conversion[] = [
  {
    id: 'pptx-to-slides',
    label: 'bento/slides deck (.bento.html)',
    hint: 'Built on the latest bento/slides release, after its signature is checked.',
    network: true,
    accepts: (d) => d.kind === 'pptx',
    async run(d, env) {
      if (d.kind !== 'pptx') throw new Error('not a PowerPoint file')
      const s = await env.shell()
      const r = await pptxToBento(d.bytes, s.html)
      const placeholders = r.report.entries.filter((e) => /-not-yet$/.test(e.code)).reduce((n, e) => n + e.count, 0)
      return {
        bytes: enc.encode(r.html), fileName: `${base(d.name)}.bento.html`, mime: 'text/html', report: r.report,
        stats: [{ label: 'slides', value: r.slides }, { label: 'placeholders', value: placeholders }, { label: 'values removed', value: r.gated.length }],
        meta: `Built on bento/slides ${s.version}, signature verified`,
      }
    },
  },
  {
    id: 'slides-to-pptx',
    label: 'PowerPoint (.pptx)',
    hint: 'Text, shapes, pictures, tables, charts, links and speaker notes stay editable.',
    network: false,
    accepts: (d) => {
      if (d.kind !== 'bento' || d.format !== 'bento/slides') return false
      if (d.compact) return 'This is compact document JSON. Make it a deck first, then convert the deck.'
      return true
    },
    flags: [{
      id: 'states',
      label: 'Include interactive states, as hidden slides that links lead to',
      applies: (d) => d.kind === 'bento' && Array.isArray(d.doc.slides) && d.doc.slides.some((s) => !!(s as { stateOf?: unknown })?.stateOf),
      default: true,
    }],
    async run(d, env, flags = {}) {
      if (d.kind !== 'bento') throw new Error('not a Bento document')
      const r = await bentoToPptx(d.text, {
        ...(env.rasterise ? { rasterise: (u: string) => env.rasterise!(u) } : {}),
        includeStates: flags.states ?? true,
      })
      return {
        bytes: r.bytes, fileName: `${base(d.name)}.pptx`,
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        report: r.report,
        stats: [{ label: 'slides', value: r.stats.slides }, { label: 'editable objects', value: r.stats.editable }, { label: 'pictures', value: r.stats.pictures }],
      }
    },
  },
  {
    id: 'json-to-slides',
    label: 'bento/slides deck (.bento.html)',
    hint: 'Turns document JSON (from an AI tool or “Copy document JSON”) into a deck you can open, built on the latest signed release.',
    network: true,
    accepts: (d) => d.kind === 'bento' && d.source === 'json' && d.format === 'bento/slides',
    async run(d, env) {
      if (d.kind !== 'bento') throw new Error('not a Bento document')
      if (!env.loadDocJson) throw new Error('this host cannot expand document JSON')
      const loaded = env.loadDocJson(d.text)
      if (!loaded) throw new Error('the document did not pass the bento/slides format check')
      const s = await env.shell()
      const report = emptyReport()
      for (const x of loaded.dropped) {
        report.entries.push({ code: 'value-removed', verdict: 'dropped', where: x.path, detail: `a value the format does not allow was removed (${x.reason})`, count: 1 })
        report.counts.dropped++
      }
      // slide numbers as the person sees them: states are not numbered
      const linear = loaded.doc.slides.filter((sl) => !sl.stateOf)
      const numberOf = new Map(linear.map((sl, i) => [sl.id, i + 1]))
      for (const id of loaded.provisional ?? []) {
        const n = numberOf.get(id)
        const where = n ? `slide ${n}` : 'document'
        const key = report.entries.find((e) => e.code === 'text-height-provisional' && e.where === where)
        if (key) key.count++
        else report.entries.push({ code: 'text-height-provisional', verdict: 'approximated', where, detail: 'text boxes without a height get a one-line height; select one in bento/slides and use Fit height to text', count: 1 })
        report.counts.approximated++
      }
      const slides = linear.length
      return {
        bytes: enc.encode(spliceIntoShell(s.html, loaded.doc)), fileName: `${base(d.name)}.bento.html`, mime: 'text/html', report,
        stats: [{ label: 'slides', value: slides }, { label: 'values removed', value: loaded.dropped.length }],
        meta: `Built on bento/slides ${s.version}, signature verified`,
      }
    },
  },
]

/** Every conversion that applies to this input: available ones, and ones that
 *  apply but cannot run, with why. Empty = nothing converts this input yet. */
export function optionsFor(d: Detected): Array<{ conversion: Conversion; ok: true } | { conversion: Conversion; ok: false; why: string }> {
  const out: Array<{ conversion: Conversion; ok: true } | { conversion: Conversion; ok: false; why: string }> = []
  for (const c of CONVERSIONS) {
    const a = c.accepts(d)
    if (a === true) out.push({ conversion: c, ok: true })
    else if (typeof a === 'string') out.push({ conversion: c, ok: false, why: a })
  }
  return out
}

/** Why nothing is offered for a recognised input, in words for the person. */
export function nothingFor(d: Detected): string {
  if (d.kind === 'unknown') return d.reason
  if (d.kind === 'bento' && d.format === 'bento/enc')
    return 'This file is password-protected. Open it in Bento, save a copy without a password, and convert that copy.'
  if (d.kind === 'bento') return `There is no conversion for ${d.format} files yet.`
  return 'There is no conversion for this file yet.'
}

export { LimitError }
