// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/convert e2e fixtures — .pptx packages built IN CODE with writeZip, so
// there is not one binary file in the repo and every fixture is readable as
// source. Shared by the pptx rig (scripts/test-convert/pptx.ts, which asserts
// content + exact report sets) and the loadability gate
// (scripts/test-convert/load.ts, which asserts the emitted JSON survives the
// real slides parseDoc/validateDoc). The underscore prefix keeps the suite
// runner from executing this as a rig of its own.
//
// Every EMU number here is chosen so the expected px value is HAND-COMPUTABLE
// (multiples of 9525·N): 914400 EMU = 96px, 457200 = 48px, and so on. The
// expected values in the rigs are computed from these constants by hand, never
// by running the converter against itself.

import { writeZip, type ZipEntry } from '../../kernel/src/convert/zip.ts'

const enc = new TextEncoder()

const NSP = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const NSA = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NSR = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'

export const XMLNS = `xmlns:p="${NSP}" xmlns:a="${NSA}" xmlns:r="${NSR}"`

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Default Extension="png" ContentType="image/png"/>' +
  '<Default Extension="svg" ContentType="image/svg+xml"/>' +
  '</Types>'

const relsXml = (entries: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}">${entries}</Relationships>`

const ROOT_RELS = relsXml(
  `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/>` +
  `<Relationship Id="rId2" Type="${PKG}/metadata/core-properties" Target="docProps/core.xml"/>`,
)

// --- default chain parts -----------------------------------------------------

/** dk1 #000000 · lt1 #FFFFFF · dk2 #28303A · lt2 #E7E6E6 · accent1 #4472C4;
 *  minor face Calibri (METRIC_SUBSTITUTES maps it to Carlito). */
export const DEFAULT_THEME = `<a:theme ${XMLNS} name="fixture"><a:themeElements>` +
  '<a:clrScheme name="fixture">' +
  '<a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="28303A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="FBAE40"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="808080"/></a:accent3><a:accent4><a:srgbClr val="FF0000"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="70AD47"/></a:accent5><a:accent6><a:srgbClr val="C00000"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
  '</a:clrScheme>' +
  '<a:fontScheme name="fixture">' +
  '<a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/></a:minorFont>' +
  '</a:fontScheme>' +
  '<a:fmtScheme name="fixture">' +
  '<a:fillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '</a:fillStyleLst>' +
  '<a:lnStyleLst>' +
  '<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '</a:lnStyleLst>' +
  '<a:bgFillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '</a:bgFillStyleLst>' +
  '</a:fmtScheme>' +
  '</a:themeElements></a:theme>'

export const STANDARD_CLRMAP =
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2"' +
  ' accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'

/** Title style 44pt — the value fixture 3 asserts through the master hop. */
export const DEFAULT_MASTER = (clrMap: string = STANDARD_CLRMAP): string =>
  `<p:sldMaster ${XMLNS}><p:cSld><p:spTree/></p:cSld>${clrMap}` +
  '<p:txStyles>' +
  '<p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle>' +
  '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle>' +
  '<p:otherStyle/>' +
  '</p:txStyles></p:sldMaster>'

/** Title placeholder frame: off (914400, 457200) ext (1828800, 914400)
 *  → 96, 48, 192, 96 px. The slide-side ph is written BARE (`<p:ph/>`, the
 *  census reality) and pairs by idx-absent-means-0. */
export const DEFAULT_LAYOUT = `<p:sldLayout ${XMLNS}><p:cSld><p:spTree>` +
  '<p:sp><p:nvSpPr><p:cNvPr id="100" name="Title Placeholder"/><p:cNvSpPr/>' +
  '<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
  '<p:spPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="1828800" cy="914400"/></a:xfrm></p:spPr></p:sp>' +
  '<p:sp><p:nvSpPr><p:cNvPr id="101" name="Body Placeholder"/><p:cNvSpPr/>' +
  '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
  '<p:spPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="5486400" cy="2743200"/></a:xfrm></p:spPr></p:sp>' +
  '</p:spTree></p:cSld></p:sldLayout>'

// --- the package builder -----------------------------------------------------

export interface FixtureSlide {
  xml: string
  /** extra Relationship entries appended verbatim to the slide's .rels */
  rels?: string
  /** a notesSlide part, auto-wired via rIdNotes */
  notes?: string
}

export interface FixtureSpec {
  slides: FixtureSlide[]
  /** wire the full slide→layout→master→theme chain (default true) */
  chain?: boolean
  theme?: string
  master?: string
  layout?: string
  /** docProps/core.xml content */
  core?: string
  /** part name → bytes (strings are UTF-8 encoded) */
  media?: Record<string, string | Uint8Array>
  sldSz?: { cx: number; cy: number }
}

export async function buildPptx(spec: FixtureSpec): Promise<Uint8Array> {
  const chain = spec.chain !== false
  const entries: ZipEntry[] = []
  const put = (name: string, content: string | Uint8Array): void => {
    entries.push({ name, data: typeof content === 'string' ? enc.encode(content) : content })
  }

  // [Content_Types].xml first — OPC consumers may stream
  put('[Content_Types].xml', CONTENT_TYPES)
  put('_rels/.rels', ROOT_RELS)

  const { cx, cy } = spec.sldSz ?? { cx: 12192000, cy: 6858000 }
  const sldIds = spec.slides
    .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
    .join('')
  put('ppt/presentation.xml',
    `<p:presentation ${XMLNS}><p:sldIdLst>${sldIds}</p:sldIdLst>` +
    `<p:sldSz cx="${cx}" cy="${cy}"/></p:presentation>`)
  put('ppt/_rels/presentation.xml.rels', relsXml(
    spec.slides
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`)
      .join(''),
  ))

  spec.slides.forEach((s, i) => {
    const name = `slide${i + 1}`
    put(`ppt/slides/${name}.xml`, s.xml)
    let rels = s.rels ?? ''
    if (chain) rels += `<Relationship Id="rIdL" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`
    if (s.notes) {
      rels += `<Relationship Id="rIdN" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/>`
      put(`ppt/notesSlides/notesSlide${i + 1}.xml`, s.notes)
    }
    if (rels) put(`ppt/slides/_rels/${name}.xml.rels`, relsXml(rels))
  })

  if (chain) {
    put('ppt/slideLayouts/slideLayout1.xml', spec.layout ?? DEFAULT_LAYOUT)
    put('ppt/slideLayouts/_rels/slideLayout1.xml.rels', relsXml(
      `<Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>`,
    ))
    put('ppt/slideMasters/slideMaster1.xml', spec.master ?? DEFAULT_MASTER())
    put('ppt/slideMasters/_rels/slideMaster1.xml.rels', relsXml(
      `<Relationship Id="rId1" Type="${REL}/theme" Target="../theme/theme1.xml"/>`,
    ))
    put('ppt/theme/theme1.xml', spec.theme ?? DEFAULT_THEME)
  }

  if (spec.core) put('docProps/core.xml', spec.core)
  for (const [name, content] of Object.entries(spec.media ?? {})) put(name, content)

  return writeZip(entries)
}

// --- shared building blocks --------------------------------------------------

export const sp = (id: number, name: string, body: string): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>${body}</p:sp>`

export const xfrm = (x: number, y: number, w: number, h: number): string =>
  `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`

export const slide = (body: string, attrs = ''): string =>
  `<p:sld ${XMLNS}${attrs ? ` ${attrs}` : ''}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`

// --- the fixtures ------------------------------------------------------------

/** 1 · minimal: one bare text box, no chain at all, title from core.xml.
 *  Expected report: NO entries. */
export function fxMinimal(): Promise<Uint8Array> {
  return buildPptx({
    chain: false,
    core: '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
      ' xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Rig Deck</dc:title></cp:coreProperties>',
    slides: [{
      xml: slide(sp(2, 'Box',
        `<p:spPr>${xfrm(914400, 914400, 2743200, 457200)}` +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>' +
        '<p:txBody><a:bodyPr><a:noAutofit/></a:bodyPr><a:lstStyle/>' +
        '<a:p><a:r><a:rPr lang="en-US" sz="1800"><a:solidFill><a:srgbClr val="28303A"/></a:solidFill>' +
        '<a:latin typeface="Georgia"/></a:rPr><a:t>Hello, Bento</a:t></a:r></a:p></p:txBody>')),
    }],
  })
}

/** 2 · themed: a SWAPPED clrMap (bg1→dk2, tx1→lt1) so a naive default-map
 *  read fails loudly; a linear-light shade; the box-with-text split.
 *  Expected report: NO entries. */
export function fxThemed(): Promise<Uint8Array> {
  const swapped =
    '<p:clrMap bg1="dk2" tx1="lt1" bg2="dk1" tx2="lt2" accent1="accent1" accent2="accent2"' +
    ' accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
  const body =
    sp(2, 'BgRect',
      `<p:spPr>${xfrm(0, 0, 914400, 914400)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      '<a:solidFill><a:schemeClr val="bg1"/></a:solidFill></p:spPr>') +
    sp(3, 'ShadeRect',
      `<p:spPr>${xfrm(914400, 0, 914400, 914400)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      '<a:solidFill><a:srgbClr val="808080"><a:shade val="50000"/></a:srgbClr></a:solidFill></p:spPr>') +
    sp(4, 'LabelBox',
      `<p:spPr>${xfrm(0, 1828800, 1828800, 457200)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr>' +
      '<p:txBody><a:bodyPr><a:noAutofit/></a:bodyPr><a:lstStyle/>' +
      '<a:p><a:r><a:rPr sz="1400"><a:latin typeface="Georgia"/></a:rPr><a:t>Label</a:t></a:r></a:p></p:txBody>')
  const xml =
    `<p:sld ${XMLNS}><p:cSld>` +
    '<p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' +
    `<p:spTree>${body}</p:spTree></p:cSld></p:sld>`
  return buildPptx({ master: DEFAULT_MASTER(swapped), slides: [{ xml }] })
}

/** 3 · placeholder: a slide title written `<p:ph/>` (no type, no xfrm) whose
 *  frame comes from the layout and whose size comes from the master's
 *  titleStyle. No core.xml — the deck is titled by this text.
 *  Expected report: text-needs-refit + font-substituted (Calibri). */
export function fxPlaceholder(): Promise<Uint8Array> {
  const xml = slide(
    '<p:sp><p:nvSpPr><p:cNvPr id="5" name="Title 1"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph/></p:nvPr></p:nvSpPr><p:spPr/>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Quarterly Review</a:t></a:r></a:p></p:txBody></p:sp>')
  return buildPptx({ slides: [{ xml }] })
}

/** 4 · nested group, 4:3 deck. Outer scales ×2 (ext 3657600×1828800 over
 *  chExt 1828800×914400, off x 914400); inner group sits at (457200, 228600)
 *  size 457200×228600 in outer child space → absolute (1828800, 457200,
 *  914400, 457200), which makes the inner map ANOTHER ×2. Leaf at (114300,
 *  57150) size 114300×57150 → absolute EMU (2057400, 571500, 228600, 114300)
 *  = 216, 60, 24, 12 px. The single-scale wrong answer (outer map applied to
 *  the leaf directly) is 914400+114300·2 = 1143000 → 120 px.
 *  Expected report: nested-group-flattened. */
export function fxGroup(): Promise<Uint8Array> {
  const xml = slide(
    '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="Outer"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="914400" y="0"/><a:ext cx="3657600" cy="1828800"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="1828800" cy="914400"/></a:xfrm></p:grpSpPr>' +
    '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="11" name="Inner"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="457200" y="228600"/><a:ext cx="457200" cy="228600"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="457200" cy="228600"/></a:xfrm></p:grpSpPr>' +
    sp(12, 'Leaf',
      `<p:spPr>${xfrm(114300, 57150, 114300, 57150)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr>') +
    '</p:grpSp></p:grpSp>')
  return buildPptx({ chain: false, sldSz: { cx: 9144000, cy: 6858000 }, slides: [{ xml }] })
}

/** 5 · bullets: an lstStyle buChar silenced by one paragraph's buNone, and a
 *  frozen buAutoNum that starts at 3.
 *  Expected report: bullet-flattened + auto-number-frozen. */
export function fxBullets(): Promise<Uint8Array> {
  const xml = slide(
    sp(2, 'Bullets',
      `<p:spPr>${xfrm(914400, 914400, 4572000, 1828800)}</p:spPr>` +
      '<p:txBody><a:bodyPr><a:noAutofit/></a:bodyPr>' +
      '<a:lstStyle><a:lvl1pPr><a:buFont typeface="Arial"/><a:buChar char="•"/>' +
      '<a:defRPr sz="1800"><a:latin typeface="Georgia"/></a:defRPr></a:lvl1pPr></a:lstStyle>' +
      '<a:p><a:r><a:t>One</a:t></a:r></a:p>' +
      '<a:p><a:pPr><a:buNone/></a:pPr><a:r><a:t>Two</a:t></a:r></a:p>' +
      '<a:p><a:r><a:t>Three</a:t></a:r></a:p></p:txBody>') +
    sp(3, 'Numbers',
      `<p:spPr>${xfrm(914400, 3657600, 4572000, 914400)}</p:spPr>` +
      '<p:txBody><a:bodyPr><a:noAutofit/></a:bodyPr>' +
      '<a:lstStyle><a:lvl1pPr><a:defRPr sz="1800"><a:latin typeface="Georgia"/></a:defRPr></a:lvl1pPr></a:lstStyle>' +
      '<a:p><a:pPr><a:buAutoNum type="arabicPeriod" startAt="3"/></a:pPr><a:r><a:t>Alpha</a:t></a:r></a:p>' +
      '<a:p><a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr><a:r><a:t>Beta</a:t></a:r></a:p></p:txBody>'))
  return buildPptx({ chain: false, slides: [{ xml }] })
}

export const SVG_BYTES = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"/></svg>'
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

/** 6 · svg+raster pair (svg must win) plus an unreferenced media part that
 *  must be PRUNED from doc.assets.
 *  Expected report: NO entries. */
export function fxSvg(): Promise<Uint8Array> {
  const xml = slide(
    '<p:pic><p:nvPicPr><p:cNvPr id="7" name="Icon"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="rId2"><a:extLst>' +
    '<a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}">' +
    '<asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId3"/>' +
    '</a:ext></a:extLst></a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    `<p:spPr>${xfrm(914400, 914400, 914400, 914400)}</p:spPr></p:pic>`)
  return buildPptx({
    chain: false,
    slides: [{
      xml,
      rels:
        `<Relationship Id="rId2" Type="${REL}/image" Target="../media/image1.png"/>` +
        `<Relationship Id="rId3" Type="${REL}/image" Target="../media/icon.svg"/>`,
    }],
    media: {
      'ppt/media/image1.png': PNG_BYTES,
      'ppt/media/icon.svg': SVG_BYTES,
      'ppt/media/unused.png': new Uint8Array([9, 9, 9, 9]),
    },
  })
}

/** 7 · connectors: one fully anchored (stCxn 2 → endCxn 3), one with a
 *  DANGLING end (endCxn 99 — nothing on the slide has that id).
 *  Expected report: connector-ref-dangling. */
export function fxConnectors(): Promise<Uint8Array> {
  const cxn = (id: number, st: number, end: number, y: number): string =>
    `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Conn ${id}"/>` +
    `<p:cNvCxnSpPr><a:stCxn id="${st}" idx="3"/><a:endCxn id="${end}" idx="1"/></p:cNvCxnSpPr>` +
    `<p:nvPr/></p:nvCxnSpPr>` +
    `<p:spPr><a:xfrm><a:off x="1828800" y="${y}"/><a:ext cx="914400" cy="0"/></a:xfrm>` +
    '<a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom>' +
    '<a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:tailEnd type="triangle"/></a:ln>' +
    '</p:spPr></p:cxnSp>'
  const xml = slide(
    sp(2, 'A',
      `<p:spPr>${xfrm(457200, 228600, 1371600, 457200)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      '<a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></p:spPr>') +
    sp(3, 'B',
      `<p:spPr>${xfrm(2743200, 228600, 1371600, 457200)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      '<a:solidFill><a:srgbClr val="FBAE40"/></a:solidFill></p:spPr>') +
    cxn(4, 2, 3, 457200) +
    cxn(5, 2, 99, 914400))
  return buildPptx({ chain: false, slides: [{ xml }] })
}

/** 8 · structure: a table and a chart graphicFrame (placeholder + honest
 *  "not yet"), speaker notes (sldImg/sldNum placeholders skipped), a hidden
 *  second slide carrying an mc:AlternateContent whose Fallback must be taken
 *  exactly once, and NO transition anywhere (emitted 'none', never 'fade').
 *  Expected report: table-not-yet + chart-not-yet. */
export function fxStructure(): Promise<Uint8Array> {
  const gframe = (id: number, name: string, y: number, data: string): string =>
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/>` +
    '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
    `<p:xfrm><a:off x="914400" y="${y}"/><a:ext cx="4572000" cy="1828800"/></p:xfrm>` +
    `<a:graphic><a:graphicData ${data}</a:graphicData></a:graphic></p:graphicFrame>`
  const slide1 = slide(
    gframe(6, 'Table 1', 914400,
      'uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl/>') +
    gframe(7, 'Chart 1', 3657600,
      'uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
      '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/>'))
  const notes =
    `<p:notes ${XMLNS}><p:cSld><p:spTree>` +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    '<p:txBody><a:bodyPr/><a:p><a:r><a:t>Remember the demo</a:t></a:r></a:p></p:txBody></p:sp>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="4" name="Num"/><p:cNvSpPr/>' +
    '<p:nvPr><p:ph type="sldNum" idx="10"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    '<p:txBody><a:bodyPr/><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp>' +
    '</p:spTree></p:cSld></p:notes>'
  const rect = (id: number, color: string): string =>
    sp(id, `R${id}`,
      `<p:spPr>${xfrm(0, 0, 914400, 914400)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill></p:spPr>`)
  const slide2 = slide(
    '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
    `<mc:Choice Requires="p14">${rect(20, '00FF00')}</mc:Choice>` +
    `<mc:Fallback>${rect(21, '0000FF')}</mc:Fallback>` +
    '</mc:AlternateContent>',
    'show="0"')
  return buildPptx({ chain: false, slides: [{ xml: slide1, notes }, { xml: slide2 }] })
}

/** Every fixture, for the loadability gate. */
export function allFixtures(): Array<{ name: string; build: () => Promise<Uint8Array> }> {
  return [
    { name: 'minimal', build: fxMinimal },
    { name: 'themed', build: fxThemed },
    { name: 'placeholder', build: fxPlaceholder },
    { name: 'group', build: fxGroup },
    { name: 'bullets', build: fxBullets },
    { name: 'svg', build: fxSvg },
    { name: 'connectors', build: fxConnectors },
    { name: 'structure', build: fxStructure },
  ]
}
