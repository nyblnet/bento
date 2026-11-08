// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// exportDocx — bento/type → .docx, the whole package.
//
// The integrator: it walks the document's blocks, resolves each one's named
// style, allocates the ids Word needs (numbering instances, hyperlink rels,
// revision ids), and assembles the OPC package with writeZip. The pieces it
// assembles are parts.ts (the skeleton) and text.ts (runs).
//
// SAME INVERSION AS THE POWERPOINT WRITER: this never imports an app. It reads
// a structural mirror of type's document (type/src/model.ts is the ground
// truth; the real TypeDoc is a superset whose other fields are never read),
// and what only the app knows — its built-in styles and paragraph defaults —
// arrives in `opts` from the composer (src/export-docx.ts), which also runs
// type's own parseDoc first. So the writer only ever sees a document type
// itself would open, and cannot drift from type's numbers by copying them.
//
// WHAT IS NOT WRITTEN YET, AND SAYS SO. This is the first stage of the plan:
// paragraphs, headings, quotes, captions, lists, inline formatting, links,
// tracked changes, named styles, fonts, paragraph layout and page setup.
// Tables, pictures, footnotes, comments, fields, cross-references, citations,
// contents and equations come in later stages; until then each one is in the
// fidelity report with a `-not-yet` code (as the importer's placeholders
// are), never silently lost. A table's cells, for instance, still arrive as
// paragraphs, so no words are lost.

import { writeZip, type ZipEntry } from '../../../kernel/src/convert/zip.ts'
import { Report, type FidelityReport } from '../report.ts'
import { scrubC0, x, type XChild, type XNode } from '../xmlout.ts'
import { contentTypes, relsPart, type ContentTypeOverride, type RelEntry } from '../pptx-write/parts.ts'
import {
  CT, REL, ABSTRACT_BULLET, ABSTRACT_DECIMAL,
  appPropsXml, corePropsXml, documentXml, fontTableXml, numberingXml, pPrKids, sectPr, settingsXml,
  stylesXml, webSettingsXml, halfPoints, lineAuto, twips,
  type PageIn, type ParaProps, type RunProps, type StyleDef,
} from './parts.ts'
import { runs, type MarkIn, type RunCtx } from './text.ts'
import { docxProblems } from './verify.ts'

// --- input ----------------------------------------------------------------------

type Align = 'left' | 'center' | 'right' | 'justify'

/** A named style, as type/src/model.ts DocStyle. */
export interface StyleIn {
  id: string
  name: string
  kind: string
  family?: string
  size?: number
  weight?: number
  italic?: boolean
  color?: string
  align?: Align
  sb?: number
  sa?: number
  lh?: number
  ind?: number
}

/** A block, as type/src/model.ts Block (the fields this stage reads). */
export interface BlockIn {
  id: string
  kind: string
  text: string
  marks?: MarkIn[]
  level?: number
  styleId?: string
  align?: Align
  sb?: number
  sa?: number
  lh?: number
  ind?: number
  keepNext?: boolean
  keepTogether?: boolean
  breakBefore?: boolean
  notes?: unknown[]
  refs?: unknown[]
  cites?: unknown[]
  fields?: unknown[]
  image?: { alt?: string }
}

export interface ExportDoc {
  title: string
  subtitle?: string
  meta?: { author?: string; company?: string; subject?: string; keywords?: string }
  page: PageIn
  body: BlockIn[]
  layout?: { align?: Align; sb?: number; sa?: number; lh?: number; ind?: number }
  styles?: Record<string, StyleIn>
  type?: { family?: string; size?: number }
  fonts?: unknown[]
  track?: boolean
  comments?: Record<string, unknown>
  revisions?: unknown[]
  signatures?: unknown
}

export interface ExportOpts {
  /** type's built-in named styles (type/src/docstyles.ts BUILT_IN_STYLES) */
  builtInStyles: Record<string, StyleIn>
  /** block kind → its built-in style id (docstyles.ts DEFAULT_STYLE_ID) */
  kindStyles: Record<string, string>
  /** the document paragraph defaults (type/src/layout.ts DOC_DEFAULTS) */
  layoutDefaults: { align: Align; sb: number; sa: number; lh: number; ind: number }
  /** the face and size type sets when the document names none */
  defaultFamily: string
  defaultSize: number
  /** zip entry timestamp; fixed by default so two exports are byte-identical */
  at?: Date
}

export interface ExportResult {
  bytes: Uint8Array
  report: FidelityReport
  stats: { paragraphs: number; lists: number; links: number }
}

// --- constants from type's stylesheet --------------------------------------------
// These are the parts of a block's look that live in type's CSS rather than in
// a DocStyle (type/src/styles.css, .t-paper rules). A DocStyle field, when set,
// wins over each of them.

/** .t-paper's line-height, which headings and quotes inherit */
const PAPER_LH = 1.62
/** --paper-ink and --paper-ink-2 */
const INK = '1A1A1A'
/** blockquote: margin-inline-start 24px + padding 14px */
const QUOTE_INDENT_PX = 38
/** ul/ol padding-inline-start: 1.6em */
const LIST_INDENT_EM = 1.6
/** figcaption: 14.5px / 1.5, ink-2, 14px below */
const CAPTION: StyleIn = { id: 'Caption', name: 'Caption', kind: 'caption', size: 14.5, lh: 1.5, color: '#3a3d44', sa: 14, align: 'left' }

/** type's built-in style ids → Word's built-in style ids, so Word's
 *  navigation pane, outline and contents see headings as headings. */
const WORD_ID: Record<string, string> = {
  'default-body': 'Normal', 'default-h1': 'Heading1', 'default-h2': 'Heading2', 'default-h3': 'Heading3',
  'default-quote': 'Quote', 'default-ul': 'ListBullet', 'default-ol': 'ListNumber',
}
const WORD_NAME: Record<string, string> = {
  Normal: 'Normal', Heading1: 'heading 1', Heading2: 'heading 2', Heading3: 'heading 3',
  Quote: 'Quote', ListBullet: 'List Bullet', ListNumber: 'List Number', Caption: 'caption',
}

// --- fonts ----------------------------------------------------------------------

/** Faces Word can be expected to have, or to substitute sensibly. */
const KNOWN_FONTS = new Set([
  'Palatino Linotype', 'Book Antiqua', 'Georgia', 'Times New Roman', 'Cambria', 'Garamond',
  'Segoe UI', 'Calibri', 'Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS',
  'Consolas', 'Courier New', 'Cambria Math',
])
const GENERIC: Record<string, string> = {
  serif: 'Times New Roman', 'sans-serif': 'Arial', 'system-ui': 'Segoe UI', monospace: 'Consolas', 'ui-monospace': 'Consolas',
}

/** The names in a CSS font stack, unquoted. */
function stackNames(stack: string): string[] {
  return stack.split(',').map((s) => s.trim().replace(/^(["'])(.*)\1$/, '$2').trim()).filter(Boolean)
}

/**
 * A CSS font stack → one Word font name: the first name in the stack Word can
 * be expected to have, else the first generic family's usual face, else the
 * first name as written (Word substitutes on its own). `substituted` is true
 * when that is not the stack's first name — a document set in Iowan Old Style
 * on a Mac opens in Palatino Linotype, and the report says so.
 */
export function wordFont(stack: string): { name: string; substituted: boolean } {
  const names = stackNames(scrubC0(stack))
  if (!names.length) return { name: 'Times New Roman', substituted: true }
  const known = names.findIndex((n) => KNOWN_FONTS.has(n))
  const generic = names.findIndex((n) => GENERIC[n.toLowerCase()] !== undefined)
  if (known >= 0 && (generic < 0 || known < generic)) return { name: names[known], substituted: known > 0 }
  if (generic >= 0) return { name: GENERIC[names[generic].toLowerCase()], substituted: true }
  const first = names.find((n) => !/^-/.test(n)) ?? names[0]
  return { name: first, substituted: first !== names[0] }
}

// --- colours ---------------------------------------------------------------------

/** A CSS colour type accepts in a style → 6-digit hex for w:color, or null. */
export function hexColor(c: string | undefined): string | null {
  if (!c) return null
  const s = c.trim()
  let m = /^#([0-9a-f]{3})$/i.exec(s)
  if (m) return m[1].split('').map((d) => d + d).join('').toUpperCase()
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s)
  if (m) return m[1].toUpperCase()
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/i.exec(s)
  if (m) return m.slice(1, 4).map((v) => Math.min(255, Number(v)).toString(16).padStart(2, '0')).join('').toUpperCase()
  const named: Record<string, string> = { black: '000000', white: 'FFFFFF', red: 'FF0000', blue: '0000FF', green: '008000', gray: '808080', grey: '808080' }
  return named[s.toLowerCase()] ?? null
}

// --- the export --------------------------------------------------------------------

const JC: Record<Align, ParaProps['jc']> = { left: 'left', center: 'center', right: 'right', justify: 'both' }
const SAFE_HREF = /^(https?:\/\/|mailto:)/i

export async function exportDocx(doc: ExportDoc, opts: ExportOpts): Promise<ExportResult> {
  const report = new Report()
  const whole = 'the whole document'
  const fontsUsed = new Set<string>()
  const font = (stack: string, where: string): string => {
    const f = wordFont(stack)
    if (f.substituted) report.add('approximated', 'font-substituted', where,
      `the typeface ${stackNames(stack)[0] ?? stack} is written as ${f.name}, which Word can be expected to have`)
    fontsUsed.add(f.name)
    return f.name
  }

  const baseSizePx = typeof doc.type?.size === 'number' && doc.type.size > 0 ? doc.type.size : opts.defaultSize
  const baseFont = font(doc.type?.family || opts.defaultFamily, whole)
  const layout = { ...opts.layoutDefaults, ...definedOnly(doc.layout ?? {}) }

  // ---- styles: the built-ins (as this document has them), then its own -------
  const userStyles = doc.styles ?? {}
  const effective = (id: string): StyleIn | undefined => userStyles[id] ?? opts.builtInStyles[id]
  const styleDefs: StyleDef[] = []
  const wordIdOf = new Map<string, string>()
  const usedNames = new Set<string>()

  const styleProps = (s: StyleIn | undefined, where: string): { ppr: ParaProps; rpr: RunProps } => {
    const ppr: ParaProps = {}
    const rpr: RunProps = {}
    if (!s) return { ppr, rpr }
    if (s.family) rpr.font = font(s.family, where)
    if (typeof s.size === 'number' && s.size > 0) rpr.sz = halfPoints(s.size)
    if (typeof s.weight === 'number') {
      if (s.weight >= 600) rpr.bold = true
      if (s.weight === 500 || s.weight > 700) report.add('approximated', 'font-weight-rounded', where,
        'font weights other than regular and bold are written as the nearer of the two')
    }
    if (s.italic) rpr.italic = true
    if (s.color) {
      const hex = hexColor(s.color)
      if (hex) rpr.color = hex
      else report.add('dropped', 'style-color-dropped', where, `the colour ${s.color} has no Word equivalent and is left out`)
    }
    if (s.align) ppr.jc = JC[s.align]
    if (typeof s.sb === 'number') ppr.before = twips(s.sb)
    if (typeof s.sa === 'number') ppr.after = twips(s.sa)
    if (typeof s.lh === 'number') ppr.line = lineAuto(s.lh)
    return { ppr, rpr }
  }

  const addStyle = (def: StyleDef) => { styleDefs.push(def); usedNames.add(def.name.toLowerCase()) }

  {
    // Normal: body text. The document's own defaults, then the Body style.
    const body = styleProps(effective('default-body'), whole)
    addStyle({
      id: 'Normal', name: 'Normal', type: 'paragraph', isDefault: true,
      ppr: { jc: JC[layout.align], after: twips(layout.sa), ...(layout.sb ? { before: twips(layout.sb) } : {}), line: lineAuto(layout.lh), ...body.ppr },
      rpr: { color: INK, ...body.rpr },
    })
    for (const [lvl, id] of ['default-h1', 'default-h2', 'default-h3'].entries()) {
      const h = styleProps(effective(id), whole)
      addStyle({
        id: WORD_ID[id], name: WORD_NAME[WORD_ID[id]], type: 'paragraph', basedOn: 'Normal', next: 'Normal', outline: lvl,
        // headings are not justified and carry their own margins (styles.css)
        ppr: { keepNext: true, jc: 'left', before: 0, after: 0, line: lineAuto(PAPER_LH), ...h.ppr },
        rpr: h.rpr,
      })
    }
    const q = styleProps(effective('default-quote'), whole)
    addStyle({
      id: 'Quote', name: 'Quote', type: 'paragraph', basedOn: 'Normal', next: 'Normal',
      ppr: { jc: 'left', before: 0, after: 0, line: lineAuto(PAPER_LH), left: twips(QUOTE_INDENT_PX), ...q.ppr }, rpr: q.rpr,
    })
    for (const id of ['default-ul', 'default-ol']) {
      const l = styleProps(effective(id), whole)
      addStyle({ id: WORD_ID[id], name: WORD_NAME[WORD_ID[id]], type: 'paragraph', basedOn: 'Normal', ppr: { before: 0, ...l.ppr }, rpr: l.rpr })
    }
    const c = styleProps(CAPTION, whole)
    addStyle({ id: 'Caption', name: 'caption', type: 'paragraph', basedOn: 'Normal', next: 'Normal', ppr: { before: 0, ...c.ppr }, rpr: c.rpr })
    addStyle({ id: 'Code', name: 'Code', type: 'character', rpr: { font: font('ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', whole), sz: halfPoints(baseSizePx * 0.88) } })
    addStyle({ id: 'Hyperlink', name: 'Hyperlink', type: 'character', rpr: { color: '0563C1', underline: true } })
    for (const [tid, wid] of Object.entries(WORD_ID)) wordIdOf.set(tid, wid)
  }
  // The document's own styles (any id that is not a built-in override).
  let n = 0
  for (const s of Object.values(userStyles)) {
    if (!s || typeof s.id !== 'string' || WORD_ID[s.id]) continue
    const wid = `Bento${++n}`
    let name = scrubC0(typeof s.name === 'string' && s.name ? s.name : s.id)
    while (usedNames.has(name.toLowerCase())) name += ' (bento)'
    const parent = wordIdOf.get(opts.kindStyles[s.kind] ?? '') ?? (s.kind === 'caption' ? 'Caption' : 'Normal')
    const p = styleProps(s, `style ${name}`)
    addStyle({ id: wid, name, type: 'paragraph', basedOn: parent, next: parent, ppr: p.ppr, rpr: p.rpr })
    wordIdOf.set(s.id, wid)
  }

  // ---- body -----------------------------------------------------------------------
  const rels: RelEntry[] = [
    { id: 'rId1', type: REL.styles, target: 'styles.xml' },
    { id: 'rId2', type: REL.settings, target: 'settings.xml' },
    { id: 'rId3', type: REL.webSettings, target: 'webSettings.xml' },
    { id: 'rId4', type: REL.fontTable, target: 'fontTable.xml' },
  ]
  const linkRel = new Map<string, string>()
  const nums: number[] = []
  const listIndentTw = twips(LIST_INDENT_EM * baseSizePx)
  let revisionId = 0
  let links = 0
  let listItems = 0

  // list state: the current run's numbering instance per kind
  let listRun: Map<string, number> | null = null
  let lastTopKind: string | null = null

  const body: XChild[] = []
  let prevKind: string | null = null
  doc.body.forEach((b, i) => {
    const where = `paragraph ${i + 1}`
    const ctx: RunCtx = {
      font: (stack) => font(stack, where),
      link: (href) => {
        const h = scrubC0(href).trim()
        if (!SAFE_HREF.test(h)) return null
        let rid = linkRel.get(h)
        if (!rid) {
          rid = `rId${rels.length + 2}` // rId5 is kept for numbering
          rels.push({ id: rid, type: REL.hyperlink, target: h, external: true })
          linkRel.set(h, rid)
        }
        links++
        return rid
      },
      note: (code, verdict, detail) => report.add(verdict, code, where, detail),
      revisionId: () => ++revisionId,
    }

    // what is not written yet, said once per place
    if (b.notes?.length) report.add('dropped', 'footnote-not-yet', where, 'footnotes are not written to Word yet')
    if (b.refs?.length) report.add('dropped', 'xref-not-yet', where, 'cross-references are not written to Word yet')
    if (b.cites?.length) report.add('dropped', 'citation-not-yet', where, 'citations are not written to Word yet')
    if (b.fields?.length) report.add('dropped', 'field-not-yet', where, 'fields (page numbers, dates, document properties) are not written to Word yet')

    const isList = b.kind === 'ul' || b.kind === 'ol'
    if (!isList) { listRun = null; lastTopKind = null }

    let pStyle = 'Normal'
    let ppr: ParaProps = {}
    let base: RunProps = {}
    switch (b.kind) {
      case 'image':
        report.add('dropped', 'image-not-yet', where, 'pictures are not written to Word yet; the alt text is kept')
        if (b.image?.alt) body.push(paragraph({ pStyle: 'Caption' }, runs(b.image.alt, [], ctx)))
        prevKind = b.kind
        return
      case 'toc':
        report.add('dropped', 'toc-not-yet', where, 'the table of contents is not written to Word yet')
        prevKind = b.kind
        return
      case 'embed':
        report.add('dropped', 'embed-not-yet', where, 'embedded Bento documents are not written to Word yet')
        prevKind = b.kind
        return
      case 'cell':
        report.add('approximated', 'table-not-yet', where, 'tables are written as one paragraph per cell until Word tables are written')
        break
      case 'math':
        report.add('approximated', 'math-as-source', where, 'equations are written as their LaTeX source, not as Word equations')
        ppr.jc = 'center'
        base = { font: 'Cambria Math' }
        fontsUsed.add('Cambria Math')
        break
      case 'caption':
        pStyle = 'Caption'
        break
    }

    // the named style: the block's own, if it resolves, else its kind's
    const own = typeof b.styleId === 'string' && effective(b.styleId) ? b.styleId : undefined
    const tid = own ?? opts.kindStyles[b.kind]
    if (tid && wordIdOf.has(tid)) pStyle = wordIdOf.get(tid)!

    if (isList) {
      const level = Math.max(0, Math.min(8, Math.floor(b.level ?? 0)))
      if (!listRun || (level === 0 && lastTopKind !== null && lastTopKind !== b.kind)) listRun = new Map()
      if (level === 0) lastTopKind = b.kind
      let numId = listRun.get(b.kind)
      if (numId === undefined) {
        nums.push(b.kind === 'ul' ? ABSTRACT_BULLET : ABSTRACT_DECIMAL)
        numId = nums.length
        listRun.set(b.kind, numId)
      }
      ppr.numId = numId
      ppr.ilvl = level
      listItems++
    }

    // direct formatting: what this block says about itself
    if (b.align) ppr.jc = JC[b.align]
    if (typeof b.sb === 'number') ppr.before = twips(b.sb)
    if (typeof b.sa === 'number') ppr.after = twips(b.sa)
    if (typeof b.lh === 'number') ppr.line = lineAuto(b.lh)
    // type indents the first line of a paragraph that follows a paragraph
    // (styles.css `p + p`), and of any block that sets its own indent
    const styleInd = (own ? effective(own) : effective('default-body'))?.ind
    if (typeof b.ind === 'number') ppr.firstLine = twips(b.ind)
    else if (b.kind === 'para' && prevKind === 'para') {
      const ind = styleInd ?? layout.ind
      if (ind > 0) ppr.firstLine = twips(ind)
    }
    if (b.keepNext) ppr.keepNext = true
    if (b.keepTogether) ppr.keepLines = true
    if (b.breakBefore) ppr.pageBreakBefore = true

    body.push(paragraph({ ...ppr, pStyle: pStyle === 'Normal' ? undefined : pStyle }, runs(b.text ?? '', b.marks, ctx, base)))
    prevKind = b.kind
  })
  body.push(sectPr(doc.page))

  // ---- what the document has that Word will not get ------------------------------
  if (doc.comments && Object.keys(doc.comments).length)
    report.add('dropped', 'comments-not-yet', whole, 'review comments are not written to Word yet')
  if (Array.isArray(doc.revisions) && doc.revisions.length)
    report.add('dropped', 'revisions-dropped', whole, 'saved versions (snapshots) are not a Word feature and are left out')
  if (doc.signatures && typeof doc.signatures === 'object' && Object.keys(doc.signatures).length)
    report.add('dropped', 'signatures-dropped', whole, 'signatures are left out: a Word copy of a signed document is not signed')
  if (Array.isArray(doc.fonts) && doc.fonts.length)
    report.add('dropped', 'font-embed-dropped', whole, 'fonts embedded in the document are not embedded in the Word file')
  report.add('approximated', 'layout-not-identical', whole,
    'Word lays out its own lines and pages, so line and page breaks can differ from bento/type')

  // ---- assembly ---------------------------------------------------------------------
  const hasNumbering = nums.length > 0
  if (hasNumbering) rels.splice(4, 0, { id: 'rId5', type: REL.numbering, target: 'numbering.xml' })
  const enc = new TextEncoder()
  const props = {
    title: doc.title, subtitle: doc.subtitle, author: doc.meta?.author, subject: doc.meta?.subject,
    keywords: doc.meta?.keywords, company: doc.meta?.company,
  }
  const overrides: ContentTypeOverride[] = [
    { partName: '/word/document.xml', contentType: CT.document },
    { partName: '/word/styles.xml', contentType: CT.styles },
    { partName: '/word/settings.xml', contentType: CT.settings },
    { partName: '/word/webSettings.xml', contentType: CT.webSettings },
    { partName: '/word/fontTable.xml', contentType: CT.fontTable },
    ...(hasNumbering ? [{ partName: '/word/numbering.xml', contentType: CT.numbering }] : []),
    { partName: '/docProps/core.xml', contentType: CT.coreProps },
    { partName: '/docProps/app.xml', contentType: CT.appProps },
  ]
  const entries: ZipEntry[] = [
    // [Content_Types].xml MUST be the first entry (zip.ts writeZip explains).
    { name: '[Content_Types].xml', data: enc.encode(contentTypes(overrides)) },
    { name: '_rels/.rels', data: enc.encode(relsPart([
      { id: 'rId1', type: REL.officeDocument, target: 'word/document.xml' },
      { id: 'rId2', type: REL.coreProps, target: 'docProps/core.xml' },
      { id: 'rId3', type: REL.appProps, target: 'docProps/app.xml' },
    ])) },
    { name: 'docProps/core.xml', data: enc.encode(corePropsXml(props)) },
    { name: 'docProps/app.xml', data: enc.encode(appPropsXml(props)) },
    { name: 'word/document.xml', data: enc.encode(documentXml(body)) },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(relsPart(rels)) },
    { name: 'word/styles.xml', data: enc.encode(stylesXml({ font: baseFont, sz: halfPoints(baseSizePx), line: lineAuto(PAPER_LH) }, styleDefs)) },
    { name: 'word/settings.xml', data: enc.encode(settingsXml(doc.track === true)) },
    { name: 'word/webSettings.xml', data: enc.encode(webSettingsXml()) },
    { name: 'word/fontTable.xml', data: enc.encode(fontTableXml([...fontsUsed])) },
    ...(hasNumbering ? [{ name: 'word/numbering.xml', data: enc.encode(numberingXml(nums, listIndentTw)) }] : []),
  ]

  // The self-check (verify.ts): a package with a broken wire is a writer bug,
  // refused here rather than handed to Word to repair.
  const problems = docxProblems(new Map(entries.map((e) => [e.name, e.data])))
  if (problems.length) throw new Error(`the Word package failed its self-check (a bug in the writer): ${problems.join('; ')}`)
  const bytes = await writeZip(entries, opts.at ? { at: opts.at } : {})
  return { bytes, report: report.build(), stats: { paragraphs: body.length - 1, lists: listItems, links } }
}

function paragraph(ppr: ParaProps, content: XChild[]): XNode {
  const k = pPrKids(ppr)
  return x('w:p', undefined, [...(k.length ? [x('w:pPr', undefined, k)] : []), ...content])
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}
