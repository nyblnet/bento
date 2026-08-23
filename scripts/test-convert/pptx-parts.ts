#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// pptx-write package-skeleton rig: xmlout + parts.
//
//   node scripts/test-convert/pptx-parts.ts     (Node ≥ 23.6 strips types natively)
//
// The emitter and the part builders are checked against the convert engine's
// own PARSER (kernel/src/convert/xml.ts) — code written for reading other
// people's files, months apart from the writer, with its own strict grammar.
// Not proof PowerPoint accepts the output (only PowerPoint is), but every
// structural claim here — namespaces resolve, escaping round-trips, required
// children present, id floors respected — is one PowerPoint checks before it
// opens a file, and the NEGATIVE controls show each guard actually firing:
// an emitter whose validation never throws is indistinguishable from no
// validation at all.

import { parseXml, kids, kid, attr, textOf, NS, type XElem } from '../../kernel/src/convert/xml.ts'
import { serialize, x } from '../../kernel/src/convert/xmlout.ts'
import {
  CT, REL, SLD_ID_FLOOR, MASTER_ID_BASE,
  contentTypes, relsPart, presentationXml, presentationRels,
  themeXml, slideMasterXml, slideMasterRels, slideLayoutXml, slideLayoutRels,
  notesMasterXml, notesMasterRels, notesSlideXml, notesSlideRels,
  slidePart, slideLayoutRel,
} from '../../kernel/src/convert/pptx-write/parts.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

function throws(fn: () => unknown, msg: string) {
  let threw = false
  try { fn() } catch { threw = true }
  ok(threw, msg)
}

// --- xmlout: the emitter -----------------------------------------------------
console.log('xmlout')

ok(
  serialize(x('root', { a: 1, b: 'two' }, [x('leaf'), 'text'])) ===
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><root a="1" b="two"><leaf/>text</root>',
  'serializes declaration, attributes, self-closing empty, mixed content',
)
ok(serialize(x('r'), false) === '<?xml version="1.0" encoding="UTF-8"?><r/>', 'standalone=false omits the attribute')

{
  // Escaping round-trip THROUGH THE PARSER: what goes in comes back out.
  const nasty = 'Q3 & Q4 <Results> "final" > 100%'
  const doc = serialize(x('t', { title: nasty }, [nasty]))
  const back = parseXml(doc)
  ok(textOf(back) === nasty, 'text escaping round-trips & < > through parseXml')
  ok(back.attrs.get('title') === nasty, 'attribute escaping round-trips & < > " through parseXml')
  ok(doc.includes('&amp;') && doc.includes('&lt;') && doc.includes('&quot;'), 'escapes are actually in the bytes')
}

// Negative controls — each guard observed firing. Removing any throw in
// xmlout.ts turns exactly one of these into a FAIL (verified by building the
// bad output by hand first: parseXml accepts none of them either).
throws(() => serialize(x('two words')), 'NEGATIVE: element name with a space is refused')
throws(() => serialize(x('a:b:c')), 'NEGATIVE: element name with two colons is refused')
throws(() => serialize(x('r', { 'bad name': 1 })), 'NEGATIVE: attribute name with a space is refused')
throws(() => serialize(x('r', undefined, ['ok\x00bad'])), 'NEGATIVE: NUL in text is refused')
throws(() => serialize(x('r', { v: 'a\x07b' })), 'NEGATIVE: BEL in an attribute value is refused')
throws(() => serialize(x('r', { cx: NaN })), 'NEGATIVE: NaN attribute is refused')
ok(serialize(x('r', undefined, ['a\tb\nc'])).includes('a\tb\nc'), 'tab and newline in text pass (legal XML)')

// --- [Content_Types].xml -----------------------------------------------------
console.log('[Content_Types].xml')

{
  const doc = parseXml(contentTypes([{ partName: '/ppt/presentation.xml', contentType: CT.presentation }]))
  ok(doc.ns === NS.ct && doc.local === 'Types', 'root is ct:Types with the content-types namespace')
  const defaults = kids(doc, NS.ct, 'Default')
  const exts = defaults.map((d) => attr(d, 'Extension'))
  for (const e of ['rels', 'xml', 'png', 'jpeg', 'gif', 'svg']) ok(exts.includes(e), `default for .${e} present`)
  const ov = kids(doc, NS.ct, 'Override')
  ok(ov.length === 1 && attr(ov[0], 'ContentType') === CT.presentation, 'presentation override carried')
}

// --- .rels -------------------------------------------------------------------
console.log('.rels')

{
  const doc = parseXml(relsPart([
    { id: 'rId1', type: REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' },
    { id: 'rId2', type: REL.hyperlink, target: 'https://bento.page/?a=1&b=2', external: true },
  ]))
  ok(doc.ns === NS.rel, 'root resolves to the package relationships namespace')
  const rels = kids(doc, NS.rel, 'Relationship')
  ok(attr(rels[0], 'TargetMode') === undefined, 'internal rel carries no TargetMode')
  ok(attr(rels[1], 'TargetMode') === 'External', 'external rel carries TargetMode="External"')
  ok(attr(rels[1], 'Target') === 'https://bento.page/?a=1&b=2', 'URL with & round-trips')
}

// --- presentation.xml --------------------------------------------------------
console.log('presentation.xml')

/** The property PowerPoint enforces: every sldId in [256, 2^31). */
function sldIdsValid(root: XElem): boolean {
  const lst = kid(root, NS.p, 'sldIdLst')
  if (!lst) return false
  const ids = kids(lst, NS.p, 'sldId').map((s) => Number(attr(s, 'id')))
  return ids.length > 0 && ids.every((id) => id >= 256 && id < 2147483648) && new Set(ids).size === ids.length
}

{
  const doc = parseXml(presentationXml(3, { cx: 12192000, cy: 6858000 }, true))
  ok(doc.ns === NS.p && doc.local === 'presentation', 'root is p:presentation in the presentationml namespace')
  ok(sldIdsValid(doc), `every sldId is unique and >= ${SLD_ID_FLOOR}`)
  const masters = kids(kid(doc, NS.p, 'sldMasterIdLst')!, NS.p, 'sldMasterId')
  ok(Number(attr(masters[0], 'id')) >= MASTER_ID_BASE, 'sldMasterId id is in the >= 2^31 range')
  ok(attr(masters[0], 'id') !== attr(kids(kid(doc, NS.p, 'sldIdLst')!, NS.p, 'sldId')[0], 'id'), 'master and slide id ranges are disjoint')
  const slideRIds = kids(kid(doc, NS.p, 'sldIdLst')!, NS.p, 'sldId').map((s) => attr(s, 'id') && attr(s, 'r:id'))
  ok(slideRIds.join(',') === 'rId2,rId3,rId4', 'slide r:ids are rId2..rId4 (rId1 = master)')
  const order = doc.children.filter((c): c is XElem => typeof c !== 'string').map((c) => c.local)
  ok(order.join(',') === 'sldMasterIdLst,notesMasterIdLst,sldIdLst,sldSz,notesSz',
    'children in schema order (notesMasterIdLst between masters and slides)')
  ok(attr(kid(doc, NS.p, 'notesMasterIdLst')!.children[0] as XElem, 'r:id') === 'rId5', 'notesMaster takes the rId after the slides')
  const sz = kid(doc, NS.p, 'sldSz')!
  ok(attr(sz, 'cx') === '12192000' && attr(sz, 'cy') === '6858000', 'sldSz carries the EMU size')

  // The rels partner must honour the same convention.
  const rels = kids(parseXml(presentationRels(3, true)), NS.rel, 'Relationship')
  const byId = new Map(rels.map((r) => [attr(r, 'Id'), r]))
  ok(attr(byId.get('rId1')!, 'Type') === REL.slideMaster, 'presentationRels rId1 is the master')
  ok(attr(byId.get('rId3')!, 'Target') === 'slides/slide2.xml', 'presentationRels rId3 is slide2 (matches the xml side)')
  ok(attr(byId.get('rId5')!, 'Type') === REL.notesMaster, 'presentationRels rId5 is the notes master')
}

{
  // NEGATIVE control for the id floor: the same check run over a presentation
  // built with a floor of 1 (what a hand-writer naively emits, and what
  // PptxGenJS silently protected PR #88 from) must FAIL.
  const bad = serialize(x('p:presentation', { 'xmlns:p': NS.p, 'xmlns:r': NS.r }, [
    x('p:sldIdLst', undefined, [
      x('p:sldId', { id: 1, 'r:id': 'rId2' }),
      x('p:sldId', { id: 2, 'r:id': 'rId3' }),
    ]),
  ]))
  ok(!sldIdsValid(parseXml(bad)), 'NEGATIVE: a sldId floor of 1 is caught by the id check')
  ok(SLD_ID_FLOOR === 256, 'the exported floor constant is 256')
}

// --- theme / master / layout chain -------------------------------------------
console.log('theme + master + layout')

{
  const doc = parseXml(themeXml({
    background: '#FDF6EC', color: 'rgb(30, 42, 58)', accent: '#E8A87C',
    fontFamily: '"Inter", system-ui, sans-serif',
  }))
  ok(doc.ns === NS.a && doc.local === 'theme', 'root is a:theme in the drawingml namespace')
  const scheme = kid(kid(doc, NS.a, 'themeElements')!, NS.a, 'clrScheme')!
  const slots = kids(scheme).map((s) => s.local)
  ok(slots.join(',') === 'dk1,lt1,dk2,lt2,accent1,accent2,accent3,accent4,accent5,accent6,hlink,folHlink',
    'clrScheme carries all 12 slots in schema order')
  const val = (name: string) => attr(kid(kid(scheme, NS.a, name)!, NS.a, 'srgbClr')!, 'val')
  ok(val('lt1') === 'FDF6EC', 'lt1 = doc.theme.background (hex normalized)')
  ok(val('dk1') === '1E2A3A', 'dk1 = doc.theme.color (rgb() normalized to hex)')
  ok(val('accent1') === 'E8A87C', 'accent1 = doc.theme.accent')
  const fonts = kid(kid(doc, NS.a, 'themeElements')!, NS.a, 'fontScheme')!
  const major = attr(kid(kid(fonts, NS.a, 'majorFont')!, NS.a, 'latin')!, 'typeface')
  const minor = attr(kid(kid(fonts, NS.a, 'minorFont')!, NS.a, 'latin')!, 'typeface')
  ok(major === 'Inter' && minor === 'Inter', 'first family, quotes stripped, as both major and minor latin')
  const fmt = kid(kid(doc, NS.a, 'themeElements')!, NS.a, 'fmtScheme')!
  ok(kids(kid(fmt, NS.a, 'fillStyleLst')!).length === 3, 'fmtScheme has 3 fill styles')
  ok(kids(kid(fmt, NS.a, 'lnStyleLst')!).length === 3, 'fmtScheme has 3 line styles')
  ok(kids(kid(fmt, NS.a, 'effectStyleLst')!).length === 3, 'fmtScheme has 3 effect styles')
  ok(kids(kid(fmt, NS.a, 'bgFillStyleLst')!).length === 3, 'fmtScheme has 3 background fills')
}

/** spTree must open nvGrpSpPr(cNvPr id=1) + grpSpPr — the preamble PowerPoint
 *  requires on the root group even when the tree is otherwise empty. */
function preambleOk(cSld: XElem): boolean {
  const tree = kid(cSld, NS.p, 'spTree')
  if (!tree) return false
  const els = kids(tree)
  return els[0]?.local === 'nvGrpSpPr'
    && attr(kid(els[0], NS.p, 'cNvPr')!, 'id') === '1'
    && els[1]?.local === 'grpSpPr'
}

{
  const master = parseXml(slideMasterXml())
  ok(master.ns === NS.p && master.local === 'sldMaster', 'master root is p:sldMaster')
  ok(preambleOk(kid(master, NS.p, 'cSld')!), 'master spTree carries the group preamble (and nothing else)')
  const clrMap = kid(master, NS.p, 'clrMap')!
  ok(['bg1', 'tx1', 'bg2', 'tx2', 'accent1', 'accent6', 'hlink', 'folHlink'].every((a) => attr(clrMap, a) !== undefined),
    'clrMap carries the full 12-attribute mapping')
  const layoutId = kids(kid(master, NS.p, 'sldLayoutIdLst')!, NS.p, 'sldLayoutId')[0]
  ok(Number(attr(layoutId, 'id')) >= MASTER_ID_BASE && attr(layoutId, 'r:id') === 'rId1', 'layout id >= 2^31, wired to rId1')
  const mrels = kids(parseXml(slideMasterRels()), NS.rel, 'Relationship')
  ok(mrels.some((r) => attr(r, 'Type') === REL.slideLayout) && mrels.some((r) => attr(r, 'Type') === REL.theme),
    'master rels reach the layout and the theme')

  const layout = parseXml(slideLayoutXml())
  ok(attr(layout, 'type') === 'blank', 'layout is type="blank"')
  ok(kid(kid(layout, NS.p, 'clrMapOvr')!, NS.a, 'masterClrMapping') !== undefined, 'layout defers colours to the master')
  ok(preambleOk(kid(layout, NS.p, 'cSld')!), 'layout spTree carries the group preamble')
  const lrels = kids(parseXml(slideLayoutRels()), NS.rel, 'Relationship')
  ok(attr(lrels[0], 'Type') === REL.slideMaster, 'layout rels reach the master')

  const nm = parseXml(notesMasterXml())
  ok(nm.local === 'notesMaster' && kid(nm, NS.p, 'clrMap') !== undefined, 'notesMaster carries cSld + clrMap')
  ok(attr(kids(parseXml(notesMasterRels()), NS.rel, 'Relationship')[0], 'Target') === '../theme/theme1.xml',
    'notesMaster shares theme1')
}

// --- notesSlide --------------------------------------------------------------
console.log('notesSlide')

{
  const title = 'Ship it & <win> — margin > cost'
  const doc = parseXml(notesSlideXml([title, '', 'second para']))
  ok(doc.ns === NS.p && doc.local === 'notes', 'root is p:notes')
  const sp = kid(kid(kid(doc, NS.p, 'cSld')!, NS.p, 'spTree')!, NS.p, 'sp')!
  const ph = kid(kid(kid(sp, NS.p, 'nvSpPr')!, NS.p, 'nvPr')!, NS.p, 'ph')!
  ok(attr(ph, 'type') === 'body' && attr(ph, 'idx') === '1', 'notes text lives in the body placeholder (idx 1)')
  const paras = kids(kid(sp, NS.p, 'txBody')!, NS.a, 'p')
  ok(paras.length === 3, 'three paragraphs (empty line preserved as empty a:p)')
  ok(textOf(paras[0]) === title, 'title with & < > round-trips through the notes body')
  ok(paras[1].children.length === 0, 'blank line is an empty a:p')
  const empty = parseXml(notesSlideXml([]))
  ok(kids(kid(kids(kid(kid(empty, NS.p, 'cSld')!, NS.p, 'spTree')!, NS.p, 'sp')[0], NS.p, 'txBody')!, NS.a, 'p').length === 1,
    'zero paragraphs still emits one a:p (txBody may not be empty)')
  const nrels = kids(parseXml(notesSlideRels(4)), NS.rel, 'Relationship')
  ok(attr(nrels[0], 'Type') === REL.notesMaster && attr(nrels[1], 'Target') === '../slides/slide4.xml',
    'notesSlide rels reach the notes master and its slide')
}

// --- slidePart ---------------------------------------------------------------
console.log('slidePart')

{
  const shape = x('p:sp', undefined, [
    x('p:nvSpPr', undefined, [x('p:cNvPr', { id: 2, name: 'Title & <co>' }), x('p:cNvSpPr'), x('p:nvPr')]),
    x('p:spPr'),
  ])
  const bg = x('p:bg', undefined, [x('p:bgPr', undefined, [
    x('a:solidFill', undefined, [x('a:srgbClr', { val: '112233' })]), x('a:effectLst'),
  ])])
  const { xml, rels } = slidePart([shape], [slideLayoutRel('rId1')], { bg, hidden: true })

  const doc = parseXml(xml)
  ok(doc.ns === NS.p && doc.local === 'sld', 'root is p:sld with resolving namespaces')
  ok(attr(doc, 'show') === '0', 'hidden slide carries show="0"')
  const cSld = kid(doc, NS.p, 'cSld')!
  const order = cSld.children.filter((c): c is XElem => typeof c !== 'string').map((c) => c.local)
  ok(order.join(',') === 'bg,spTree', 'p:bg precedes p:spTree under p:cSld')
  ok(preambleOk(cSld), 'spTree opens with the mandatory group preamble')
  const treeKids = kids(kid(cSld, NS.p, 'spTree')!)
  ok(treeKids[2]?.local === 'sp', 'caller children come after the preamble')
  ok(attr(kid(kids(treeKids[2])[0], NS.p, 'cNvPr')!, 'name') === 'Title & <co>', 'shape name attribute escaping round-trips')
  ok(kid(doc, NS.p, 'clrMapOvr') !== undefined, 'slide carries clrMapOvr')
  const srels = kids(parseXml(rels), NS.rel, 'Relationship')
  ok(attr(srels[0], 'Type') === REL.slideLayout && attr(srels[0], 'Target') === '../slideLayouts/slideLayout1.xml',
    'slide rels carry the layout rel from slideLayoutRel()')
}

console.log(`\n${checks} checks, ${failures} failures`)
if (failures > 0) process.exit(1)
