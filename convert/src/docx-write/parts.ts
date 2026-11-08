// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The Word package skeleton: every part a .docx needs that is not the body.
//
// WHAT WORD WANTS, NOT WHAT THE SCHEMA ALLOWS. The PowerPoint writer learned
// that a package every XSD accepts can still raise the repair dialog: the
// reader wants boilerplate the schema calls optional (see the zone's notes on
// presProps and the notes master). So this writes the parts Word itself writes
// for a blank document: styles, settings (with a compat mode, or Word opens the
// file in "Compatibility Mode"), fontTable, webSettings, and both docProps.
// Numbering is written only when a list exists, as Word does.
//
// ELEMENT ORDER IS PART OF THE FORMAT. WordprocessingML properties are
// xsd:sequence, not xsd:all: `<w:b/>` after `<w:sz/>` is invalid, and Word's
// reaction to an out-of-order child ranges from ignoring it to repairing the
// file. Every builder below emits children in schema order, and the order is
// written out where it is not obvious.
//
// Units: type stores CSS px at 96 dpi. Twips = px × 15 (exact). Font sizes are
// half-points = px × 1.5, rounded (w:sz is an integer).

import { scrubC0, serialize, x, type XChild, type XNode } from '../xmlout.ts'

export const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
export const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export const REL = {
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  coreProps: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  appProps: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
  styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  settings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings',
  webSettings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/webSettings',
  fontTable: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable',
  numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
  hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
} as const

export const CT = {
  document: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  styles: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
  settings: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
  webSettings: 'application/vnd.openxmlformats-officedocument.wordprocessingml.webSettings+xml',
  fontTable: 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml',
  numbering: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
  coreProps: 'application/vnd.openxmlformats-package.core-properties+xml',
  appProps: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
} as const

/** The MIME type of the package itself, for whoever saves it. */
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export const twips = (px: number): number => Math.round(px * 15)
export const halfPoints = (px: number): number => Math.max(1, Math.round(px * 1.5))
/** w:spacing/@w:line for lineRule="auto": 240 = single. */
export const lineAuto = (multiple: number): number => Math.round(240 * multiple)

// --- run and paragraph properties ----------------------------------------------

export interface RunProps {
  rStyle?: string
  font?: string
  bold?: boolean
  italic?: boolean
  strike?: boolean
  /** 6-digit hex without '#' */
  color?: string
  /** half-points */
  sz?: number
  underline?: boolean
}

/** w:rPr in CT_RPr order: rStyle, rFonts, b, i, strike, color, sz, szCs, u. */
export function rPr(p: RunProps): XNode | null {
  const k: XChild[] = []
  if (p.rStyle) k.push(x('w:rStyle', { 'w:val': p.rStyle }))
  if (p.font) k.push(x('w:rFonts', { 'w:ascii': p.font, 'w:hAnsi': p.font, 'w:cs': p.font, 'w:eastAsia': p.font }))
  if (p.bold) k.push(x('w:b'), x('w:bCs'))
  if (p.italic) k.push(x('w:i'), x('w:iCs'))
  if (p.strike) k.push(x('w:strike'))
  if (p.color) k.push(x('w:color', { 'w:val': p.color }))
  if (p.sz) k.push(x('w:sz', { 'w:val': p.sz }), x('w:szCs', { 'w:val': p.sz }))
  if (p.underline) k.push(x('w:u', { 'w:val': 'single' }))
  return k.length ? x('w:rPr', undefined, k) : null
}

export interface ParaProps {
  pStyle?: string
  keepNext?: boolean
  keepLines?: boolean
  pageBreakBefore?: boolean
  numId?: number
  ilvl?: number
  /** twips */
  before?: number
  after?: number
  /** lineRule=auto value (240 = single) */
  line?: number
  /** twips */
  left?: number
  hanging?: number
  firstLine?: number
  jc?: 'left' | 'center' | 'right' | 'both'
}

/** The pPr children in CT_PPr order: pStyle, keepNext, keepLines,
 *  pageBreakBefore, numPr, spacing, ind, jc. Null when there are none. */
export function pPrKids(p: ParaProps): XChild[] {
  const k: XChild[] = []
  if (p.pStyle) k.push(x('w:pStyle', { 'w:val': p.pStyle }))
  if (p.keepNext) k.push(x('w:keepNext'))
  if (p.keepLines) k.push(x('w:keepLines'))
  if (p.pageBreakBefore) k.push(x('w:pageBreakBefore'))
  if (p.numId !== undefined) k.push(x('w:numPr', undefined, [x('w:ilvl', { 'w:val': p.ilvl ?? 0 }), x('w:numId', { 'w:val': p.numId })]))
  const sp: Record<string, string | number> = {}
  if (p.before !== undefined) sp['w:before'] = p.before
  if (p.after !== undefined) sp['w:after'] = p.after
  if (p.line !== undefined) { sp['w:line'] = p.line; sp['w:lineRule'] = 'auto' }
  if (Object.keys(sp).length) k.push(x('w:spacing', sp))
  const ind: Record<string, string | number> = {}
  if (p.left !== undefined) ind['w:left'] = p.left
  if (p.hanging !== undefined) ind['w:hanging'] = p.hanging
  else if (p.firstLine !== undefined) ind['w:firstLine'] = p.firstLine
  if (Object.keys(ind).length) k.push(x('w:ind', ind))
  if (p.jc) k.push(x('w:jc', { 'w:val': p.jc }))
  return k
}

// --- styles.xml ----------------------------------------------------------------

export interface StyleDef {
  id: string
  name: string
  type: 'paragraph' | 'character'
  basedOn?: string
  next?: string
  /** Normal and Default Paragraph Font */
  isDefault?: boolean
  /** 0-based outline level, for headings */
  outline?: number
  ppr?: ParaProps
  rpr?: RunProps
}

/** One w:style, children in CT_Style order: name, basedOn, next, uiPriority,
 *  qFormat, pPr, rPr. */
function styleNode(s: StyleDef): XNode {
  const k: XChild[] = [x('w:name', { 'w:val': scrubC0(s.name) })]
  if (s.basedOn) k.push(x('w:basedOn', { 'w:val': s.basedOn }))
  if (s.next) k.push(x('w:next', { 'w:val': s.next }))
  k.push(x('w:qFormat'))
  const pk = s.ppr ? pPrKids(s.ppr) : []
  // outlineLvl sits after jc in CT_PPr
  if (s.outline !== undefined) pk.push(x('w:outlineLvl', { 'w:val': s.outline }))
  if (s.type === 'paragraph' && pk.length) k.push(x('w:pPr', undefined, pk))
  const r = s.rpr ? rPr(s.rpr) : null
  if (r) k.push(r)
  return x('w:style', { 'w:type': s.type, ...(s.isDefault ? { 'w:default': 1 } : {}), 'w:styleId': s.id }, k)
}

export function stylesXml(defaults: { font: string; sz: number; line: number }, styles: StyleDef[]): string {
  return serialize(x('w:styles', { 'xmlns:w': W_NS }, [
    x('w:docDefaults', undefined, [
      x('w:rPrDefault', undefined, [rPr({ font: defaults.font, sz: defaults.sz })!]),
      x('w:pPrDefault', undefined, [x('w:pPr', undefined, pPrKids({ after: 0, line: defaults.line }))]),
    ]),
    // Word's own blank document defines these two; a reader that looks for
    // the default character style by id finds it.
    x('w:style', { 'w:type': 'character', 'w:default': 1, 'w:styleId': 'DefaultParagraphFont' }, [
      x('w:name', { 'w:val': 'Default Paragraph Font' }), x('w:uiPriority', { 'w:val': 1 }),
      x('w:semiHidden'), x('w:unhideWhenUsed'),
    ]),
    ...styles.map(styleNode),
  ]))
}

// --- numbering.xml --------------------------------------------------------------

/** abstractNum ids: the bullet list and the numbered list. */
export const ABSTRACT_BULLET = 0
export const ABSTRACT_DECIMAL = 1

// type's stylesheet: ul disc / circle / square, ol decimal / lower-alpha /
// lower-roman, repeating below that.
const BULLETS = ['•', '◦', '▪']
const NUM_FMTS = ['decimal', 'lowerLetter', 'lowerRoman']

function abstractNum(id: number, bullet: boolean, indentTw: number): XNode {
  const lvls: XNode[] = []
  for (let l = 0; l < 9; l++) {
    lvls.push(x('w:lvl', { 'w:ilvl': l }, [
      x('w:start', { 'w:val': 1 }),
      x('w:numFmt', { 'w:val': bullet ? 'bullet' : NUM_FMTS[l % 3] }),
      x('w:lvlText', { 'w:val': bullet ? BULLETS[l % 3] : `%${l + 1}.` }),
      x('w:lvlJc', { 'w:val': 'left' }),
      x('w:pPr', undefined, [x('w:ind', { 'w:left': indentTw * (l + 1), 'w:hanging': indentTw })]),
    ]))
  }
  return x('w:abstractNum', { 'w:abstractNumId': id }, [
    x('w:multiLevelType', { 'w:val': 'hybridMultilevel' }),
    ...lvls,
  ])
}

/**
 * numbering.xml. `nums` is one entry per w:num, in numId order from 1: which
 * abstract list it instantiates. Every instance overrides the start of every
 * level, which is what makes a NEW list restart at 1 — two w:num over the same
 * abstractNum otherwise continue one count, and type's lists restart wherever
 * the HTML <ol> does.
 */
export function numberingXml(nums: number[], indentTw: number): string {
  return serialize(x('w:numbering', { 'xmlns:w': W_NS }, [
    abstractNum(ABSTRACT_BULLET, true, indentTw),
    abstractNum(ABSTRACT_DECIMAL, false, indentTw),
    ...nums.map((abs, i) => x('w:num', { 'w:numId': i + 1 }, [
      x('w:abstractNumId', { 'w:val': abs }),
      ...Array.from({ length: 9 }, (_, l) => x('w:lvlOverride', { 'w:ilvl': l }, [x('w:startOverride', { 'w:val': 1 })])),
    ])),
  ]))
}

// --- settings, fonts, web settings ----------------------------------------------

/** settings.xml, children in CT_Settings order. compatibilityMode 15 is what
 *  keeps Word out of Compatibility Mode. */
export function settingsXml(track: boolean): string {
  return serialize(x('w:settings', { 'xmlns:w': W_NS }, [
    x('w:zoom', { 'w:percent': 100 }),
    ...(track ? [x('w:trackRevisions')] : []),
    x('w:defaultTabStop', { 'w:val': 720 }),
    x('w:characterSpacingControl', { 'w:val': 'doNotCompress' }),
    x('w:compat', undefined, [
      x('w:compatSetting', {
        'w:name': 'compatibilityMode', 'w:uri': 'http://schemas.microsoft.com/office/word', 'w:val': 15,
      }),
    ]),
  ]))
}

export function fontTableXml(fonts: string[]): string {
  return serialize(x('w:fonts', { 'xmlns:w': W_NS }, fonts.map((f) => x('w:font', { 'w:name': f }))))
}

export function webSettingsXml(): string {
  return serialize(x('w:webSettings', { 'xmlns:w': W_NS }, [x('w:optimizeForBrowser')]))
}

// --- docProps --------------------------------------------------------------------

export interface DocProps {
  title?: string
  subtitle?: string
  author?: string
  subject?: string
  keywords?: string
  company?: string
}

export function corePropsXml(p: DocProps): string {
  // scrubC0 on every author-typed property: a control character pasted into a
  // dialog must cost a character, not the export (see xmlout.scrubC0).
  const kids: XChild[] = [
    x('dc:title', undefined, p.title ? [scrubC0(p.title)] : undefined),
    x('dc:creator', undefined, [scrubC0(p.author || 'bento/type')]),
  ]
  if (p.subject) kids.push(x('dc:subject', undefined, [scrubC0(p.subject)]))
  if (p.subtitle) kids.push(x('dc:description', undefined, [scrubC0(p.subtitle)]))
  if (p.keywords) kids.push(x('cp:keywords', undefined, [scrubC0(p.keywords)]))
  return serialize(x('cp:coreProperties', {
    'xmlns:cp': 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
    'xmlns:dc': 'http://purl.org/dc/elements/1.1/',
  }, kids))
}

export function appPropsXml(p: DocProps): string {
  const kids: XChild[] = [x('Application', undefined, ['bento/convert'])]
  if (p.company) kids.push(x('Company', undefined, [scrubC0(p.company)]))
  return serialize(x('Properties', { xmlns: 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties' }, kids))
}

// --- the body's section ----------------------------------------------------------

export interface PageIn {
  width: number
  height: number
  marginX: number
  marginTop: number
  marginBottom: number
  marginLeft?: number
  marginRight?: number
}

/** The document's one section: page size and margins, in twips. */
export function sectPr(page: PageIn): XNode {
  const w = twips(page.width)
  const h = twips(page.height)
  return x('w:sectPr', undefined, [
    x('w:pgSz', { 'w:w': w, 'w:h': h, ...(w > h ? { 'w:orient': 'landscape' } : {}) }),
    x('w:pgMar', {
      'w:top': twips(page.marginTop),
      'w:right': twips(page.marginRight ?? page.marginX),
      'w:bottom': twips(page.marginBottom),
      'w:left': twips(page.marginLeft ?? page.marginX),
      'w:header': 720, 'w:footer': 720, 'w:gutter': 0,
    }),
  ])
}

export function documentXml(body: XChild[]): string {
  return serialize(x('w:document', { 'xmlns:w': W_NS, 'xmlns:r': R_NS }, [x('w:body', undefined, body)]))
}
