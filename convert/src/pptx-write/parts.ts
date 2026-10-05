// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The .pptx package skeleton — every part that is CONTAINER, not content.
//
// A .pptx is an OPC package: a ZIP whose parts are typed by [Content_Types].xml
// and wired together by .rels documents. PowerPoint validates the wiring before
// it looks at a single shape, and it validates strictly: a slide whose rels do
// not reach a layout, a layout that does not reach a master, or a master
// without a theme is a "repair" dialog, not a degraded render. So this module
// owns the whole chain and the export pipeline only ever fills in spTrees.
//
// OUR EXPORT IS FLAT BY DESIGN. A bento/slides deck was either authored flat
// or resolved flat at import (the importer collapses the layout/master cascade
// into each slide — that resolution is its whole job). There is nothing left
// for a master to contribute, so the ONE master, ONE blank layout and ONE theme
// emitted here exist to satisfy the reader, not to carry style. The census
// makes the contrast concrete: real decks carry 82–90 layouts and 2–4 masters,
// and round-tripping through Bento deliberately loses that scaffolding. The
// theme is not entirely decorative though — doc.theme's colours and first font
// family go into clrScheme/fontScheme (a mapping adopted from PR #88's
// exporter, which fed the same two slots through PptxGenJS.theme), so a user
// who inserts a NEW shape in PowerPoint gets deck-coloured defaults instead of
// Office blue.
//
// The classic hand-writer traps, encoded here so no caller can re-trip them:
//   - p:sldId ids must be >= 256 (and < 2147483648). PptxGenJS hid this from
//     PR #88; a floor of 1 is refused by PowerPoint. SLD_ID_FLOOR below.
//   - p:sldMasterId/p:sldLayoutId ids live in a DIFFERENT range: >= 2147483648.
//   - every p:spTree must open with the nvGrpSpPr/grpSpPr preamble, even an
//     empty one — the schema requires the group-shape header on the root group.
//   - a slideLayout/notesSlide must carry p:clrMapOvr, a master p:clrMap.
//
// Part builders return SERIALIZED STRINGS, not trees: a part is finished the
// moment it is built, and the only consumer is writeZip (via TextEncoder).

import { serialize, x, type XChild, type XNode } from '../xmlout.ts'

// --- namespaces, relationship types, content types ---------------------------
// Mirrors of xml.ts's NS table, plus the write-side vocabularies. Declared as
// consts so the integrator and every element mapper spell them identically.

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** The xmlns trio every PresentationML part root declares. */
export const PML_XMLNS: Record<string, string> = {
  'xmlns:a': NS_A,
  'xmlns:p': NS_P,
  'xmlns:r': NS_R,
}

/** Relationship TYPE URIs (the values of //Relationship/@Type). */
export const REL = {
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  slideMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  slideLayout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  notesMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster',
  notesSlide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  chart: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart',
  hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
  video: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/video',
  audio: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio',
  media: 'http://schemas.microsoft.com/office/2007/relationships/media',
  presProps: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps',
  viewProps: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps',
  tableStyles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles',
} as const

/** Content types for the per-part overrides in [Content_Types].xml. */
export const CT = {
  presentation: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  slideMaster: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  slideLayout: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  notesSlide: 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
  notesMaster: 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  chart: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
  coreProps: 'application/vnd.openxmlformats-package.core-properties+xml',
  appProps: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  presProps: 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml',
  viewProps: 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml',
  tableStyles: 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml',
} as const

// --- [Content_Types].xml -----------------------------------------------------

export interface ContentTypeOverride {
  /** absolute part name, leading slash included: '/ppt/slides/slide1.xml' */
  partName: string
  contentType: string
}

/**
 * The package's type map. Extension DEFAULTS cover rels/xml and every image
 * format the export can embed; each XML part whose type is more specific than
 * "application/xml" needs an OVERRIDE row (presentation, every slide, every
 * notesSlide, master, layout, theme, every chart) — a slide typed as plain xml
 * is invisible to PowerPoint even though its rels resolve.
 *
 * jpg and jpeg both map to image/jpeg: which extension an embedded image gets
 * depends on the data-URI's mime spelling upstream, and a missing default for
 * the one that occurs is a repair dialog.
 */
export function contentTypes(overrides: ContentTypeOverride[]): string {
  const defaults: Array<[string, string]> = [
    ['rels', 'application/vnd.openxmlformats-package.relationships+xml'],
    ['xml', 'application/xml'],
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['jpg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['svg', 'image/svg+xml'],
  ]
  return serialize(
    x('Types', { xmlns: 'http://schemas.openxmlformats.org/package/2006/content-types' }, [
      ...defaults.map(([ext, ct]) => x('Default', { Extension: ext, ContentType: ct })),
      ...overrides.map((o) => x('Override', { PartName: o.partName, ContentType: o.contentType })),
    ]),
  )
}

// --- .rels documents ---------------------------------------------------------

export interface RelEntry {
  /** 'rId1'… — unique within ONE rels part only */
  id: string
  /** a REL.* URI */
  type: string
  /** part-relative target ('../slideLayouts/slideLayout1.xml') or, for
   *  external, the raw URL */
  target: string
  /** hyperlinks and linked media leave the package; everything else is
   *  internal and must NOT carry TargetMode (PowerPoint reads its absence as
   *  Internal) */
  external?: boolean
}

/** One .rels document. Order is irrelevant to consumers; we keep caller order
 *  so output is deterministic and diffable. */
export function relsPart(rels: RelEntry[]): string {
  return serialize(
    x('Relationships', { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' },
      rels.map((r) =>
        x('Relationship', {
          Id: r.id,
          Type: r.type,
          Target: r.target,
          ...(r.external ? { TargetMode: 'External' } : {}),
        }),
      ),
    ),
  )
}

// --- presentation.xml --------------------------------------------------------

/** PowerPoint refuses p:sldId values below 256 (ECMA-376 constrains the id to
 *  256 <= id < 2147483648). The classic hand-writer trap: nothing else in the
 *  file hints at it, the whole deck is just "unreadable". */
export const SLD_ID_FLOOR = 256

/** p:sldMasterId / p:sldLayoutId live ABOVE the slide-id range: >= 2^31. */
export const MASTER_ID_BASE = 2147483648

/**
 * The presentation part. The r:id convention is FIXED here and mirrored by
 * `presentationRels` — the two must be used together:
 *
 *   rId1                     -> slideMasters/slideMaster1.xml
 *   rId2 … rId(1+slideCount) -> slides/slide<i>.xml   (slide i, 1-based)
 *   rId(2+slideCount)        -> notesMasters/notesMaster1.xml  (when notes exist)
 *
 * `hasNotes` must be true iff any notesSlide part is emitted: a notesSlide
 * without a notesMaster in the chain is a repair dialog, and a dangling
 * notesMaster rel (no part) is one too.
 *
 * p:notesSz is required in practice (PowerPoint writes it always; some readers
 * NPE without it) — portrait letter, the native default.
 */
export function presentationXml(slideCount: number, sizeEMU: { cx: number; cy: number }, hasNotes = false): string {
  const sldIds: XChild[] = []
  for (let i = 0; i < slideCount; i++) {
    sldIds.push(x('p:sldId', { id: SLD_ID_FLOOR + i, 'r:id': `rId${2 + i}` }))
  }
  return serialize(
    x('p:presentation', PML_XMLNS, [
      x('p:sldMasterIdLst', undefined, [x('p:sldMasterId', { id: MASTER_ID_BASE, 'r:id': 'rId1' })]),
      // schema order: notesMasterIdLst sits BETWEEN sldMasterIdLst and sldIdLst
      ...(hasNotes
        ? [x('p:notesMasterIdLst', undefined, [x('p:notesMasterId', { 'r:id': `rId${2 + slideCount}` })])]
        : []),
      x('p:sldIdLst', undefined, sldIds),
      // EMU are integers by definition; a fractional px * 9525 upstream must
      // not leak a decimal point into cx/cy.
      x('p:sldSz', { cx: Math.round(sizeEMU.cx), cy: Math.round(sizeEMU.cy) }),
      x('p:notesSz', { cx: 6858000, cy: 9144000 }),
    ]),
  )
}

/** The rels partner of `presentationXml` — same convention, generated so the
 *  two can never drift apart. */
export function presentationRels(slideCount: number, hasNotes = false): string {
  const rels: RelEntry[] = [
    { id: 'rId1', type: REL.slideMaster, target: 'slideMasters/slideMaster1.xml' },
  ]
  for (let i = 0; i < slideCount; i++) {
    rels.push({ id: `rId${2 + i}`, type: REL.slide, target: `slides/slide${i + 1}.xml` })
  }
  if (hasNotes) {
    rels.push({ id: `rId${2 + slideCount}`, type: REL.notesMaster, target: 'notesMasters/notesMaster1.xml' })
  }
  // The theme rel plus the three property parts every real producer ships.
  // All four are schema-OPTIONAL, and their absence is exactly what macOS
  // PowerPoint's repair dialog objects to: the sample from the first cut of
  // this writer carried none of them, unzip -t and an OPC validator both
  // passed, and PowerPoint still offered to "repair" it. python-pptx,
  // PptxGenJS and PowerPoint itself all emit them; a hand writer that skips
  // "optional" boilerplate is betting against every reader's expectations.
  let next = 2 + slideCount + (hasNotes ? 1 : 0)
  rels.push({ id: `rId${next++}`, type: REL.theme, target: 'theme/theme1.xml' })
  rels.push({ id: `rId${next++}`, type: REL.presProps, target: 'presProps.xml' })
  rels.push({ id: `rId${next++}`, type: REL.viewProps, target: 'viewProps.xml' })
  rels.push({ id: `rId${next++}`, type: REL.tableStyles, target: 'tableStyles.xml' })
  return relsPart(rels)
}

/** Minimal presentation/view properties and table-style parts — content-free,
 *  but their PRESENCE is load-bearing (see presentationRels). The tblStyleLst
 *  def GUID is the well-known "no style" default every producer uses. */
export function presPropsXml(): string {
  return serialize(x('p:presentationPr', { 'xmlns:a': NS_A, 'xmlns:r': NS_R, 'xmlns:p': NS_P }))
}
export function viewPropsXml(): string {
  return serialize(x('p:viewPr', { 'xmlns:a': NS_A, 'xmlns:r': NS_R, 'xmlns:p': NS_P }))
}
export function tableStylesXml(): string {
  return serialize(x('a:tblStyleLst', { 'xmlns:a': NS_A, def: '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}' }))
}

// --- theme / master / layout chain -------------------------------------------

/** '#abc', '#aabbcc', '#aabbccdd', rgb()/rgba() → 'AABBCC'. Alpha is DROPPED —
 *  clrScheme slots are opaque by definition; translucency lives on shapes.
 *  Anything unparseable (a gradient string, a css keyword) falls back — the
 *  theme is defaults-for-new-shapes, not rendering, so a safe colour beats a
 *  refused file. Normalization shape adopted from PR #88's pptxColor. */
function hex6(css: string, fallback: string): string {
  const raw = (css ?? '').trim()
  const rgb = raw.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i)
  if (rgb) {
    return [rgb[1], rgb[2], rgb[3]]
      .map((n) => Math.min(255, Math.max(0, Math.round(Number(n)))).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  }
  let hex = raw.replace(/^#/, '')
  if (/^[0-9a-f]{3,4}$/i.test(hex)) hex = [...hex].map((c) => c + c).join('')
  if (/^[0-9a-f]{6,8}$/i.test(hex)) return hex.slice(0, 6).toUpperCase()
  return fallback
}

/** First family of a css font stack, quotes stripped — 'Inter, sans-serif' →
 *  'Inter'. (The same reduction PR #88 fed to PptxGenJS's theme.) */
function firstFamily(fontFamily: string): string {
  return (fontFamily.split(',')[0] ?? 'Arial').replace(/['"]/g, '').trim() || 'Arial'
}

const srgb = (val: string): XNode => x('a:srgbClr', { val })
const schemeSlot = (name: string, val: string): XNode => x(`a:${name}`, undefined, [srgb(val)])

/**
 * theme1.xml. clrScheme carries the deck: dk1 = doc.theme.color (the ink),
 * lt1 = doc.theme.background, accent1 = doc.theme.accent; the remaining slots
 * are the stock Office values — Bento's theme has exactly three colours, and
 * inventing five more accents here would put made-up colours one click away in
 * PowerPoint's colour picker. fontScheme carries doc.theme.fontFamily's first
 * family as BOTH major and minor latin (Bento has one deck font, not a
 * heading/body pair).
 *
 * fmtScheme is boilerplate but NOT optional: the schema demands exactly 3 fill
 * styles, 3 line styles, 3 effect styles and 3 background fills, and PowerPoint
 * repairs a theme without them. All reference phClr so they stay neutral.
 */
export function themeXml(theme: { background: string; color: string; accent: string; fontFamily: string }): string {
  const dk1 = hex6(theme.color, '000000')
  const lt1 = hex6(theme.background, 'FFFFFF')
  const accent1 = hex6(theme.accent, '4472C4')
  const face = firstFamily(theme.fontFamily)

  const clrScheme = x('a:clrScheme', { name: 'Bento' }, [
    schemeSlot('dk1', dk1),
    schemeSlot('lt1', lt1),
    schemeSlot('dk2', dk1),
    schemeSlot('lt2', lt1),
    schemeSlot('accent1', accent1),
    schemeSlot('accent2', 'ED7D31'),
    schemeSlot('accent3', 'A5A5A5'),
    schemeSlot('accent4', 'FFC000'),
    schemeSlot('accent5', '5B9BD5'),
    schemeSlot('accent6', '70AD47'),
    schemeSlot('hlink', '0563C1'),
    schemeSlot('folHlink', '954F72'),
  ])

  const fontSet = (tag: string): XNode =>
    x(tag, undefined, [
      x('a:latin', { typeface: face }),
      x('a:ea', { typeface: '' }),
      x('a:cs', { typeface: '' }),
    ])
  const fontScheme = x('a:fontScheme', { name: 'Bento' }, [fontSet('a:majorFont'), fontSet('a:minorFont')])

  const phFill = x('a:solidFill', undefined, [x('a:schemeClr', { val: 'phClr' })])
  const phGrad = (): XNode =>
    x('a:gradFill', { rotWithShape: 1 }, [
      x('a:gsLst', undefined, [
        x('a:gs', { pos: 0 }, [x('a:schemeClr', { val: 'phClr' }, [x('a:lumMod', { val: 110000 })])]),
        x('a:gs', { pos: 100000 }, [x('a:schemeClr', { val: 'phClr' }, [x('a:lumMod', { val: 90000 })])]),
      ]),
      x('a:lin', { ang: 5400000, scaled: 0 }),
    ])
  const phLn = (w: number): XNode =>
    x('a:ln', { w, cap: 'flat', cmpd: 'sng', algn: 'ctr' }, [phFill, x('a:prstDash', { val: 'solid' })])
  const fmtScheme = x('a:fmtScheme', { name: 'Office' }, [
    x('a:fillStyleLst', undefined, [phFill, phGrad(), phGrad()]),
    x('a:lnStyleLst', undefined, [phLn(6350), phLn(12700), phLn(19050)]),
    x('a:effectStyleLst', undefined, [
      x('a:effectStyle', undefined, [x('a:effectLst')]),
      x('a:effectStyle', undefined, [x('a:effectLst')]),
      x('a:effectStyle', undefined, [x('a:effectLst')]),
    ]),
    x('a:bgFillStyleLst', undefined, [phFill, phFill, phGrad()]),
  ])

  return serialize(
    x('a:theme', { 'xmlns:a': NS_A, name: 'Bento' }, [
      x('a:themeElements', undefined, [clrScheme, fontScheme, fmtScheme]),
    ]),
  )
}

/** The root group header every p:spTree must open with — id 1 is the group
 *  itself, so real shape ids start at 2. */
function spTreePreamble(): XChild[] {
  return [
    x('p:nvGrpSpPr', undefined, [
      x('p:cNvPr', { id: 1, name: '' }),
      x('p:cNvGrpSpPr'),
      x('p:nvPr'),
    ]),
    x('p:grpSpPr', undefined, [
      x('a:xfrm', undefined, [
        x('a:off', { x: 0, y: 0 }),
        x('a:ext', { cx: 0, cy: 0 }),
        x('a:chOff', { x: 0, y: 0 }),
        x('a:chExt', { cx: 0, cy: 0 }),
      ]),
    ]),
  ]
}

const spTree = (children: XChild[]): XNode => x('p:spTree', undefined, [...spTreePreamble(), ...children])

// The identity colour map: Bento slides arrive with resolved colours, so the
// master's map exists only because p:clrMap is a required element with twelve
// required attributes.
const CLR_MAP_ATTRS = {
  bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2',
  accent1: 'accent1', accent2: 'accent2', accent3: 'accent3', accent4: 'accent4',
  accent5: 'accent5', accent6: 'accent6', hlink: 'hlink', folHlink: 'folHlink',
} as const

/** slideMaster1.xml: white bg, empty spTree — pure scaffolding (see header).
 *  Its rels (`slideMasterRels`) reach the one layout and the theme; the layout
 *  id here must match that rels' rId1. */
export function slideMasterXml(): string {
  return serialize(
    x('p:sldMaster', PML_XMLNS, [
      x('p:cSld', undefined, [
        x('p:bg', undefined, [
          x('p:bgPr', undefined, [
            x('a:solidFill', undefined, [srgb('FFFFFF')]),
            x('a:effectLst'),
          ]),
        ]),
        spTree([]),
      ]),
      x('p:clrMap', CLR_MAP_ATTRS),
      x('p:sldLayoutIdLst', undefined, [
        x('p:sldLayoutId', { id: MASTER_ID_BASE + 1, 'r:id': 'rId1' }),
      ]),
    ]),
  )
}

export function slideMasterRels(): string {
  return relsPart([
    { id: 'rId1', type: REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' },
    { id: 'rId2', type: REL.theme, target: '../theme/theme1.xml' },
  ])
}

/** slideLayout1.xml: type="blank", empty spTree, colours mapped straight
 *  through to the master. Every exported slide points here. */
export function slideLayoutXml(): string {
  return serialize(
    x('p:sldLayout', { ...PML_XMLNS, type: 'blank' }, [
      x('p:cSld', { name: 'Blank' }, [spTree([])]),
      x('p:clrMapOvr', undefined, [x('a:masterClrMapping')]),
    ]),
  )
}

export function slideLayoutRels(): string {
  return relsPart([{ id: 'rId1', type: REL.slideMaster, target: '../slideMasters/slideMaster1.xml' }])
}

/** notesMaster1.xml — required the moment any notesSlide exists (the reader
 *  walks notesSlide → notesMaster → theme and repairs on a broken link). It
 *  shares theme1.xml rather than duplicating it as a theme2: OPC allows many
 *  rels to one part, and the notes surface has no styling of its own to lose. */
export function notesMasterXml(): string {
  return serialize(
    x('p:notesMaster', PML_XMLNS, [
      x('p:cSld', undefined, [spTree([])]),
      x('p:clrMap', CLR_MAP_ATTRS),
      // notesStyle is OPTIONAL in the schema and its absence is a PowerPoint
      // repair prompt — found by bisection: a one-slide deck whose only extra
      // feature was a speaker note repaired, and every real notesMaster
      // carries this element. One level is enough; readers inherit the rest.
      x('p:notesStyle', undefined, [
        x('a:lvl1pPr', undefined, [x('a:defRPr', { sz: 1200 })]),
      ]),
    ]),
  )
}

export function notesMasterRels(): string {
  // The notes master gets its OWN theme part, never a share of the slide
  // master's. Same bisection: every real producer pairs each master with its
  // own theme (slideMaster->theme1, notesMaster->theme2), and PowerPoint's
  // repair dialog is the price of assuming the association can be many-to-one.
  return relsPart([{ id: 'rId1', type: REL.theme, target: '../theme/theme2.xml' }])
}

// --- notesSlide --------------------------------------------------------------

/**
 * notesSlideN.xml: the speaker notes as plain paragraphs in the body
 * placeholder (ph type="body" idx="1" is where PowerPoint's notes pane reads
 * and edits). Bento notes are a single plain-text string; the caller splits on
 * newlines — an empty line becomes an empty a:p, preserving the author's
 * paragraph rhythm. A txBody must contain at least one a:p, so zero paragraphs
 * still emits one empty.
 *
 * Pair with `notesSlideRels(n)` for the slide it annotates.
 */
export function notesSlideXml(paragraphs: string[]): string {
  const paras: XChild[] = (paragraphs.length ? paragraphs : ['']).map((text) =>
    text ? x('a:p', undefined, [x('a:r', undefined, [x('a:t', undefined, [text])])]) : x('a:p'),
  )
  return serialize(
    x('p:notes', PML_XMLNS, [
      x('p:cSld', undefined, [
        spTree([
          x('p:sp', undefined, [
            x('p:nvSpPr', undefined, [
              x('p:cNvPr', { id: 2, name: 'Notes Placeholder 1' }),
              x('p:cNvSpPr', undefined, [x('a:spLocks', { noGrp: 1 })]),
              x('p:nvPr', undefined, [x('p:ph', { type: 'body', idx: 1 })]),
            ]),
            x('p:spPr'),
            x('p:txBody', undefined, [x('a:bodyPr'), x('a:lstStyle'), ...paras]),
          ]),
        ]),
      ]),
      x('p:clrMapOvr', undefined, [x('a:masterClrMapping')]),
    ]),
  )
}

/** Rels for notesSlideN.xml: the notes master plus the slide it belongs to
 *  (PowerPoint writes both, and the back-link is how the notes pane binds). */
export function notesSlideRels(slideNumber: number): string {
  return relsPart([
    { id: 'rId1', type: REL.notesMaster, target: '../notesMasters/notesMaster1.xml' },
    { id: 'rId2', type: REL.slide, target: `../slides/slide${slideNumber}.xml` },
  ])
}

// --- slides ------------------------------------------------------------------

/** The rel every slide's rels MUST contain — include it in `relEntries` (the
 *  integrator allocates ids; this helper just fixes type and target). A slide
 *  that cannot reach a layout is refused outright. */
export function slideLayoutRel(id: string): RelEntry {
  return { id, type: REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' }
}

export interface SlidePartOpts {
  /** a ready p:bg node (background is per-slide in bento); emitted before the
   *  spTree — p:bg is a sibling of p:spTree under p:cSld, not a shape */
  bg?: XNode
  /** hidden interactive-state slides exported for link targets */
  hidden?: boolean
}

/**
 * slideN.xml plus its rels. `spTreeChildren` are the finished sp/pic/graphicFrame
 * nodes from the element mappers; `relEntries` is everything those mappers
 * allocated (images, charts, hyperlinks, its notesSlide) AND the layout rel —
 * pass `slideLayoutRel(...)` with an id from the same allocation so ids stay
 * unique within the part.
 */
export function slidePart(
  spTreeChildren: XChild[],
  relEntries: RelEntry[],
  opts: SlidePartOpts = {},
): { xml: string; rels: string } {
  const xml = serialize(
    x('p:sld', { ...PML_XMLNS, ...(opts.hidden ? { show: 0 } : {}) }, [
      x('p:cSld', undefined, [
        ...(opts.bg ? [opts.bg] : []),
        spTree(spTreeChildren),
      ]),
      x('p:clrMapOvr', undefined, [x('a:masterClrMapping')]),
    ]),
  )
  return { xml, rels: relsPart(relEntries) }
}
