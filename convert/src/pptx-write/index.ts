// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// exportPptx — bento/slides → .pptx, the whole package.
//
// This is the integrator over the element writers (text/shapes/media/tables/
// charts) and the package skeleton (parts.ts): it walks the document, allocates
// every id the writers need (cNvPr shape ids, rel ids, part numbers), and
// assembles the OPC package with writeZip. The ORCHESTRATION decisions are
// PR #88's, adopted from its index.ts and credited where they bite:
//
//   - interactive STATE slides are omitted (a state is a click-reached variant,
//     not a linear slide) and links INTO a state degrade to its visible parent
//     slide, preserving a meaningful navigation target. #88 offered an
//     includeStates option; the simple honest default is the only mode here.
//   - hyperlinks: #88's hyperlink() logic — https?:/mailto:/tel: is an external
//     rel, anything else is a slide id resolved to an internal jump
//     (ppaction://hlinksldjump); a target that resolves to nothing is reported,
//     never emitted dangling.
//   - fx/showOnHover render at their final frame and say so ONCE per slide —
//     #88's dedup rule, which the Report's (code, where) folding provides.
//   - hidden slides export as PowerPoint hidden slides (show="0") — the same
//     "in the deck, out of the show" semantics, so nothing is dropped.
//   - doc.meta → docProps/core.xml (author/subject/keywords, #88's
//     author-or-'bento/slides' default) and app.xml (company).
//
// WHAT THE WRITER DOES NOT DO, BY DESIGN: derive the deck's chart palette
// (deriveChartPalette is app code in slides/src/model.ts) — the caller
// (src/export.ts) passes it via opts.chartPalette; doc.theme.chartPalette wins when the
// deck declares one. And no filenames or downloads: this returns BYTES plus the
// fidelity report; naming and saving are the host's concern (#88's safeName
// stays app-side).
//
// ZIP ENTRY ORDER: [Content_Types].xml is written FIRST. PowerPoint tolerates
// any order, but a streaming consumer is entitled to refuse to type parts it
// has already passed — third-party readers have (see zip.ts writeZip).

import { writeZip, type ZipEntry } from '../../../kernel/src/convert/zip.ts'
import { Report, type FidelityReport } from '../report.ts'
import { scrubC0, serialize, x, type XChild, type XNode } from '../xmlout.ts'
import {
  CT, REL, contentTypes, relsPart, presentationXml, presentationRels,
  presPropsXml, viewPropsXml, tableStylesXml,
  themeXml, slideMasterXml, slideMasterRels, slideLayoutXml, slideLayoutRels,
  notesMasterXml, notesMasterRels, notesSlideXml, notesSlideRels,
  slidePart, slideLayoutRel, type ContentTypeOverride, type RelEntry,
} from './parts.ts'
import { textSp, type FieldValues, type TextElIn } from './text.ts'
import { emu, parseColor, shapeNode, type ShapeIn } from './shapes.ts'
import {
  MediaStore, imagePic, svgPic, mediaPoster,
  type ImageIn, type MediaCtx, type MediaIn, type SvgIn,
} from './media.ts'
import { tableFrame } from './tables.ts'
import { chartExport } from './charts.ts'
import type { WriteCtx } from './contract.ts'
import { writeCode, type CodeElIn } from './code.ts'
import { writeEmbed, type EmbedElIn } from './embed.ts'
import type { OutChart, OutTable } from '../types.ts'

// --- input --------------------------------------------------------------------
// Structural mirror of the REAL bento/slides document (slides/src/model.ts is
// the ground truth) — same inversion as every other module here: the writer
// never imports from an app, and the real BentoDoc is a superset whose unknown
// fields are simply never read. Element inputs reuse the writers' own In types
// so one definition cannot drift from what its writer actually reads.

/** Fields every element may carry that the INTEGRATOR reads (the writers do
 *  not): presentation effects and the hover-reveal marker (reported static),
 *  and `link` (resolved to a rel here, handed down as an id). */
interface ElCommon {
  link?: string
  fx?: Record<string, unknown>
  showOnHover?: string
}

export type ExportElement =
  | ({ type: 'text' } & TextElIn & ElCommon)
  | ({ type: 'shape' } & ShapeIn & ElCommon)
  | (ImageIn & ElCommon) // OutImage already carries type: 'image'
  | ({ type: 'svg' } & SvgIn & ElCommon)
  | ({ type: 'chart' } & ChartElIn & ElCommon)
  | (OutTable & { morphId?: string } & ElCommon) // type: 'table'
  | ({ type: 'media' } & MediaIn & ElCommon)
  | (CodeElIn & ElCommon)
  | (EmbedElIn & ElCommon)

/** OutChart with `preset` loosened to the model's optional free string —
 *  chartExport never consults it (the option's series types decide). */
export interface ChartElIn {
  id: string
  morphId?: string
  x: number; y: number; w: number; h: number
  rotation: number
  opacity: number
  option: Record<string, unknown>
  preset?: string
}

export interface ExportSlide {
  id: string
  name?: string
  background: string
  transition?: string
  notes?: string
  stateOf?: string
  hidden?: boolean
  /** hover behaviour object; presence alone is reported (rendered static) */
  hover?: unknown
  elements: ExportElement[]
}

export interface ExportDoc {
  title: string
  /** slide coordinate space, px — the package is sized from it (px * 9525) */
  size: { width: number; height: number }
  theme: { background: string; color: string; accent: string; fontFamily: string; chartPalette?: string[] }
  meta?: { author?: string; company?: string; subject?: string; event?: string; keywords?: string }
  present?: { numberHidden?: boolean }
  assets?: Record<string, string>
  slides: ExportSlide[]
}

export interface ExportOpts {
  /** Deck chart palette for charts without an explicit option.color —
   *  doc.theme.chartPalette wins over this; slides-side callers pass
   *  deriveChartPalette(doc.theme.accent) (app code the writer does not import).
   *  Both absent = the ECharts stock colours. */
  chartPalette?: string[]
  /** Zip timestamp. Omitted = the fixed 1980 epoch, so two exports of one
   *  deck are byte-identical (dates INSIDE the deck — {{date}} text — still
   *  freeze to export day; that is content, not metadata). */
  at?: Date
}

export interface PptxExport {
  bytes: Uint8Array
  report: FidelityReport
}

// --- helpers ------------------------------------------------------------------

/** #88's hyperlink() test: these schemes leave the package; every other link
 *  value is a slide id. (The task brief says https?; mailto:/tel: are kept
 *  from #88 — both are ordinary external hyperlink rels in OOXML.) */
const EXTERNAL_LINK_RE = /^(https?:|mailto:|tel:)/i

/** #88's hasUnsupportedFx: the effects that run in present mode and have no
 *  OOXML mapping here — the element itself exports at its final frame. */
const hasStaticFx = (el: ElCommon): boolean =>
  !!(el.fx && (el.fx['enter'] || el.fx['countUp'] || el.fx['ambient'] || el.fx['loop'])) || !!el.showOnHover

/** Depth-first hunt for the p:cNvPr of a finished writer node. The trees are
 *  plain data (xmlout XNodes), so the integrator can wire a hyperlink into a
 *  writer that deliberately left links out of scope (media.ts note 4) — or
 *  attach the EXTERNAL variant to shapeNode, whose linkRelId opt is
 *  slide-jump-only. hlinkClick is cNvPr's FIRST optional child in the schema,
 *  and every writer emits cNvPr with attribute-only content, so appending is
 *  safe; shapes' own slide-jump path stays untouched. */
function attachHlink(node: XNode, rId: string, slideJump: boolean): void {
  const cNvPr = findNamed(node, 'p:cNvPr')
  if (!cNvPr) return
  cNvPr.kids = [
    ...(cNvPr.kids ?? []),
    x('a:hlinkClick', { 'r:id': rId, ...(slideJump ? { action: 'ppaction://hlinksldjump' } : {}) }),
  ]
}

function findNamed(node: XNode, name: string): XNode | null {
  if (node.name === name) return node
  for (const kid of node.kids ?? []) {
    if (typeof kid !== 'string') {
      const hit = findNamed(kid, name)
      if (hit) return hit
    }
  }
  return null
}

/**
 * The per-slide p:bg. Bento backgrounds are css — overwhelmingly a solid
 * colour; anything else (a gradient string, an image url) flattens to the
 * theme background and is reported, #88's 'slide-background-simplified'.
 * p:bg is a sibling of p:spTree under p:cSld, which is why slidePart takes it
 * as an option rather than a shape (parts.ts).
 */
function bgNode(css: string, themeBg: string, report: Report, where: string): XNode {
  let c = parseColor(css)
  if (!c) {
    report.add('approximated', 'slide-background-simplified', where,
      `background '${css}' is not a solid colour; flattened to the theme background`)
    c = parseColor(themeBg) ?? { hex: 'FFFFFF', alpha: 1 }
  }
  const fill = c.alpha <= 0
    ? x('a:noFill')
    : x('a:solidFill', undefined, [
        x('a:srgbClr', { val: c.hex }, c.alpha < 1 ? [x('a:alpha', { val: Math.round(c.alpha * 100000) })] : undefined),
      ])
  return x('p:bg', undefined, [x('p:bgPr', undefined, [fill, x('a:effectLst')])])
}

// Package-level relationship types (docProps wiring). Not in parts.ts REL —
// those are the ppt-internal vocabulary; these two live only in _rels/.rels.
const REL_CORE_PROPS = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties'
const REL_APP_PROPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties'

/** docProps/core.xml — doc.meta carried as document properties (#88 fed the
 *  same fields through PptxGenJS's author/subject/title setters). The
 *  'bento/slides' creator default is #88's too: an empty dc:creator makes
 *  some DMS ingest pipelines file the deck under "unknown". */
function corePropsXml(doc: ExportDoc): string {
  const m = doc.meta ?? {}
  // scrubC0 on every author-typed property: a control char pasted into the
  // About dialog must cost a character, not the export (see xmlout.scrubC0).
  const kids: XChild[] = [
    x('dc:title', undefined, doc.title ? [scrubC0(doc.title)] : undefined),
    x('dc:creator', undefined, [scrubC0(m.author || 'bento/slides')]),
  ]
  if (m.subject) kids.push(x('dc:subject', undefined, [scrubC0(m.subject)]))
  if (m.keywords) kids.push(x('cp:keywords', undefined, [scrubC0(m.keywords)]))
  return serialize(
    x('cp:coreProperties', {
      'xmlns:cp': 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
      'xmlns:dc': 'http://purl.org/dc/elements/1.1/',
    }, kids),
  )
}

function appPropsXml(doc: ExportDoc): string {
  const kids: XChild[] = [x('Application', undefined, ['Bento Slides'])]
  if (doc.meta?.company) kids.push(x('Company', undefined, [scrubC0(doc.meta.company)]))
  return serialize(
    x('Properties', { xmlns: 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties' }, kids),
  )
}

// --- the export ---------------------------------------------------------------

/**
 * Export one bento/slides document as a complete .pptx package.
 *
 * Walks doc.slides in order, skipping interactive states; element dispatch is
 * document order, which IS z-order in both models (bento paints elements in
 * array order; OOXML paints spTree children in document order — no sorting).
 * Returns the package bytes and the fidelity report; throws for a deck with
 * no linear slides at all (PowerPoint refuses an empty sldIdLst, and an
 * all-states deck has nothing honest to export) — and, via xmlout's guards,
 * for machine-level corruption (a non-finite frame coordinate, a control
 * character in an element id): those are upstream bugs, not documents.
 * Author-typed TEXT never throws: C0 controls are scrubbed at ingestion
 * (xmlout.scrubC0) at every point where pasted content reaches a part.
 */
export async function exportPptx(doc: ExportDoc, opts: ExportOpts = {}): Promise<PptxExport> {
  const report = new Report()

  const exported = doc.slides.filter((s) => !s.stateOf)
  if (exported.length === 0) {
    throw new Error('exportPptx: the deck has no linear slides (only interactive states) — nothing to export')
  }
  const omitted = doc.slides.length - exported.length
  if (omitted > 0) {
    report.add('dropped', 'state-slides-omitted', 'document',
      `${omitted} interactive state slide(s) omitted — a state is a click-reached variant, not a linear slide`)
  }

  // Slide id → exported slide number, with #88's degradation: a link into an
  // omitted state retargets to the state's visible parent.
  const slideNumbers = new Map<string, number>()
  exported.forEach((s, i) => slideNumbers.set(s.id, i + 1))
  for (const s of doc.slides) {
    if (s.stateOf) {
      const parent = slideNumbers.get(s.stateOf)
      if (parent) slideNumbers.set(s.id, parent)
    }
  }

  // Field context, ported from slides' render.fieldContext/model.paginates:
  // states never paginate; hidden slides paginate only when the deck opts into
  // office-suite numbering (present.numberHidden). One Date for the whole
  // export so {{date}}/{{time}} agree across slides.
  const paginates = (s: ExportSlide): boolean => !s.stateOf && (!s.hidden || !!doc.present?.numberHidden)
  const pages = doc.slides.filter(paginates).length
  const meta = doc.meta ?? {}
  const now = new Date()

  const palette = doc.theme.chartPalette?.length ? doc.theme.chartPalette : opts.chartPalette
  const assets = doc.assets ?? {}
  const store = new MediaStore() // ONE per export: byte-dedup is cross-slide
  const enc = new TextEncoder()

  const slideXml: string[] = []
  const slideRels: string[] = []
  const notesParts: Array<{ name: string; xml: string; rels: string }> = []
  const chartParts: Array<{ name: string; xml: string }> = []
  const extraOverrides: ContentTypeOverride[] = []
  let chartCount = 0
  let pageCounter = 0

  for (let si = 0; si < exported.length; si++) {
    const slide = exported[si]
    const num = si + 1
    const where = `slide ${num}`
    if (paginates(slide)) pageCounter++

    // Field values are author-typed strings that land verbatim in a:t —
    // scrubbed like every other author-text ingestion point.
    const fields: FieldValues = {
      page: pageCounter, pages,
      title: scrubC0(doc.title), date: now,
      author: scrubC0(meta.author ?? ''), company: scrubC0(meta.company ?? ''),
      subject: scrubC0(meta.subject ?? ''), event: scrubC0(meta.event ?? ''),
    }

    // One rel-id sequence per slide part: layout, hyperlinks, media, charts
    // and the notesSlide all draw from it (ids are unique per RELS PART).
    let relSeq = 0
    const rels: RelEntry[] = []
    const nextRelId = (): string => `rId${++relSeq}`
    rels.push(slideLayoutRel(nextRelId()))
    const mediaCtx: MediaCtx = { assets, store, rels, nextRelId, report }

    /** el.link → an allocated rel. Reported and null when the target does not
     *  resolve (#88's missing-link-target) — a dangling r:id is a repair
     *  dialog, a dropped link is a report entry. */
    const resolveLink = (link: string | undefined): { rId: string; external: boolean } | null => {
      if (!link) return null
      if (EXTERNAL_LINK_RE.test(link)) {
        const rId = nextRelId()
        rels.push({ id: rId, type: REL.hyperlink, target: link, external: true })
        return { rId, external: true }
      }
      const target = slideNumbers.get(link)
      if (!target) {
        report.add('dropped', 'missing-link-target', where,
          `link target '${link}' is not an exported slide; the link is dropped`)
        return null
      }
      const rId = nextRelId()
      rels.push({ id: rId, type: REL.slide, target: `../slides/slide${target}.xml` })
      return { rId, external: false }
    }

    /** Post-attach a link to a writer that does not take one (pic, table,
     *  chart frames — and the external case on shapes). Resolved only when a
     *  node actually landed, so a dropped image never allocates a rel. */
    const wireLink = (node: XNode | null, link: string | undefined): void => {
      if (!node || !link) return
      const l = resolveLink(link)
      if (l) attachHlink(node, l.rId, !l.external)
    }

    const children: XChild[] = []
    let shapeId = 2 // the spTree preamble owns id 1 (parts.ts)
    const emit = (node: XNode | null): void => {
      if (node) { children.push(node); shapeId++ }
    }

    for (const el of slide.elements) {
      if (hasStaticFx(el)) {
        // once per slide via the Report's (code, where) folding — #88's rule
        report.add('approximated', 'presentation-effects-static', where,
          'entrance/count-up/ambient/hover effects render at their final frame')
      }
      switch (el.type) {
        case 'text': {
          const link = resolveLink(el.link)
          emit(textSp(el, {
            shapeId,
            themeFontFamily: doc.theme.fontFamily,
            fields,
            ...(link ? { link: { rId: link.rId, ...(link.external ? {} : { slideJump: true }) } } : {}),
            report, where,
          }))
          break
        }
        case 'shape': {
          const link = resolveLink(el.link)
          // slide jumps ride shapeNode's own opt; external links are attached
          // after the fact (linkRelId always emits the sldjump action)
          const node = shapeNode(el, shapeId, report, where,
            link && !link.external ? { linkRelId: link.rId } : {})
          if (link?.external) attachHlink(node, link.rId, false)
          emit(node)
          break
        }
        case 'image': {
          const node = imagePic(el, shapeId, where, mediaCtx)
          wireLink(node, el.link)
          emit(node)
          break
        }
        case 'svg': {
          const node = svgPic(el, shapeId, where, mediaCtx)
          wireLink(node, el.link)
          emit(node)
          break
        }
        case 'chart': {
          // Rel discipline (charts.ts ChartExport contract): the id is
          // RESERVED up front; on the table fallback it goes unused — a gap
          // in the rId sequence, which is legal (ids are names, not indices)
          // — and no part/rel/override is emitted.
          const relId = nextRelId()
          // chartExport reads frame fields + option (and rotation, to report
          // it); `preset` is never consulted, so the loosened input is safe.
          const res = chartExport(el as unknown as OutChart, shapeId, relId, palette, report, where)
          if (res.chartXml) {
            const name = `ppt/charts/chart${++chartCount}.xml`
            chartParts.push({ name, xml: res.chartXml })
            rels.push({ id: relId, type: REL.chart, target: `../charts/chart${chartCount}.xml` })
            extraOverrides.push({ partName: `/${name}`, contentType: CT.chart })
          }
          wireLink(res.frame, el.link)
          emit(res.frame)
          break
        }
        case 'table': {
          const node = tableFrame(el, shapeId, report, where)
          wireLink(node, el.link)
          emit(node)
          break
        }
        case 'media': {
          const node = mediaPoster(el, shapeId, where, mediaCtx)
          wireLink(node, el.link)
          emit(node)
          break
        }
        // Writers on the contract.ts interface. Both are stubs that report the
        // element dropped until someone writes them (see their files).
        case 'code':
        case 'embed': {
          const ctx: WriteCtx = { shapeId, report, where, media: mediaCtx, theme: doc.theme }
          const node = el.type === 'code' ? writeCode(el, ctx) : writeEmbed(el, ctx)
          wireLink(node, el.link)
          emit(node)
          break
        }
        default:
          // A future element type must degrade to a report entry, not a
          // refused export ("unknown option keys are ignored gracefully" is
          // the house posture for format growth).
          report.add('dropped', 'element-unsupported', where,
            `element type '${(el as { type?: string }).type}' has no pptx mapping`)
      }
    }

    // Slide-level features with no mapping, #88's codes: Morph is a PowerPoint
    // EXTENSION (mc:AlternateContent + p14) this writer does not emit, and
    // hover focus/reveal has no OOXML equivalent at all.
    if (slide.transition === 'morph') {
      report.add('dropped', 'morph-not-exported', where,
        'morph transition dropped (PowerPoint Morph is an extension this writer does not emit); slides cut instead')
    }
    if (slide.hover) {
      report.add('approximated', 'hover-static', where,
        'hover focus/reveal behaviour is static in PowerPoint; every element renders visible')
    }

    if ((slide.notes ?? '').trim()) {
      const m = notesParts.length + 1
      const name = `ppt/notesSlides/notesSlide${m}.xml`
      notesParts.push({
        name,
        xml: notesSlideXml(scrubC0(slide.notes ?? '').split(/\r?\n/)),
        rels: notesSlideRels(num),
      })
      rels.push({ id: nextRelId(), type: REL.notesSlide, target: `../notesSlides/notesSlide${m}.xml` })
      extraOverrides.push({ partName: `/${name}`, contentType: CT.notesSlide })
    }

    const part = slidePart(children, rels, {
      bg: bgNode(slide.background, doc.theme.background, report, where),
      ...(slide.hidden ? { hidden: true } : {}),
    })
    slideXml.push(part.xml)
    slideRels.push(part.rels)
  }

  // --- assembly ---------------------------------------------------------------

  const hasNotes = notesParts.length > 0
  const n = exported.length

  const overrides: ContentTypeOverride[] = [
    { partName: '/ppt/presentation.xml', contentType: CT.presentation },
    { partName: '/ppt/theme/theme1.xml', contentType: CT.theme },
    { partName: '/ppt/slideMasters/slideMaster1.xml', contentType: CT.slideMaster },
    { partName: '/ppt/slideLayouts/slideLayout1.xml', contentType: CT.slideLayout },
    { partName: '/ppt/presProps.xml', contentType: CT.presProps },
    { partName: '/ppt/viewProps.xml', contentType: CT.viewProps },
    { partName: '/ppt/tableStyles.xml', contentType: CT.tableStyles },
    ...(hasNotes ? [
      { partName: '/ppt/notesMasters/notesMaster1.xml', contentType: CT.notesMaster },
      { partName: '/ppt/theme/theme2.xml', contentType: CT.theme },
    ] : []),
    ...slideXml.map((_, i) => ({ partName: `/ppt/slides/slide${i + 1}.xml`, contentType: CT.slide })),
    ...extraOverrides, // charts + notesSlides, gathered in the walk
    { partName: '/docProps/core.xml', contentType: CT.coreProps },
    { partName: '/docProps/app.xml', contentType: CT.appProps },
  ]

  const entries: ZipEntry[] = [
    // [Content_Types].xml MUST be the first entry (see header + zip.ts).
    { name: '[Content_Types].xml', data: enc.encode(contentTypes(overrides)) },
    { name: '_rels/.rels', data: enc.encode(relsPart([
      { id: 'rId1', type: REL.officeDocument, target: 'ppt/presentation.xml' },
      { id: 'rId2', type: REL_CORE_PROPS, target: 'docProps/core.xml' },
      { id: 'rId3', type: REL_APP_PROPS, target: 'docProps/app.xml' },
    ])) },
    { name: 'docProps/core.xml', data: enc.encode(corePropsXml(doc)) },
    { name: 'docProps/app.xml', data: enc.encode(appPropsXml(doc)) },
    // The slide is sized exactly like every element frame: px * 9525 (emu()),
    // no per-deck scale object — see shapes.ts xfrmNode.
    { name: 'ppt/presentation.xml', data: enc.encode(
      presentationXml(n, { cx: emu(doc.size.width), cy: emu(doc.size.height) }, hasNotes)) },
    { name: 'ppt/_rels/presentation.xml.rels', data: enc.encode(presentationRels(n, hasNotes)) },
    { name: 'ppt/theme/theme1.xml', data: enc.encode(themeXml(doc.theme)) },
    { name: 'ppt/presProps.xml', data: enc.encode(presPropsXml()) },
    { name: 'ppt/viewProps.xml', data: enc.encode(viewPropsXml()) },
    { name: 'ppt/tableStyles.xml', data: enc.encode(tableStylesXml()) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: enc.encode(slideMasterXml()) },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: enc.encode(slideMasterRels()) },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: enc.encode(slideLayoutXml()) },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: enc.encode(slideLayoutRels()) },
    ...(hasNotes ? [
      { name: 'ppt/notesMasters/notesMaster1.xml', data: enc.encode(notesMasterXml()) },
      { name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels', data: enc.encode(notesMasterRels()) },
      // the notes master's own theme part (see notesMasterRels)
      { name: 'ppt/theme/theme2.xml', data: enc.encode(themeXml(doc.theme)) },
    ] : []),
    ...slideXml.flatMap((xml, i) => [
      { name: `ppt/slides/slide${i + 1}.xml`, data: enc.encode(xml) },
      { name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: enc.encode(slideRels[i]) },
    ]),
    ...notesParts.flatMap((p, i) => [
      { name: p.name, data: enc.encode(p.xml) },
      { name: `ppt/notesSlides/_rels/notesSlide${i + 1}.xml.rels`, data: enc.encode(p.rels) },
    ]),
    ...chartParts.map((p) => ({ name: p.name, data: enc.encode(p.xml) })),
    // Media bytes go in verbatim — already-compressed formats mostly, and
    // writeZip stores anything DEFLATE would grow.
    ...store.files().map((f) => ({ name: f.name, data: f.bytes })),
  ]

  const bytes = await writeZip(entries, opts.at ? { at: opts.at } : {})
  return { bytes, report: report.build() }
}
