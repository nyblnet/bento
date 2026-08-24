#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// pptx-write end-to-end rig: exportPptx over a representative deck.
//
//   node scripts/test-convert/pptx-write.ts     (Node ≥ 23.6 strips types natively)
//
// The whole pipeline under one roof: a bento doc built in code (every element
// type, fx, links, notes, a hidden slide, an interactive state) goes through
// exportPptx, the bytes come back through the kernel's OWN zip reader and XML
// parser, and the package's wiring is asserted the way PowerPoint checks it:
// every rel target exists, every r:id resolves in its own rels part, every XML
// part is typed in [Content_Types].xml. The NEGATIVE controls doctor the
// output and watch each checker actually fail — a rel checker that never finds
// a break proves nothing about the packages it passes.

import { readZip, type ZipParts } from '../../kernel/src/convert/zip.ts'
import { parseXml, kids, kid, attr, textOf, descendants, NS, type XElem } from '../../kernel/src/convert/xml.ts'
import { exportPptx, type ExportDoc, type ExportElement } from '../../kernel/src/convert/pptx-write/index.ts'
import type { FidelityReport } from '../../kernel/src/convert/report.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const dec = new TextDecoder()
const partText = (parts: ZipParts, name: string): string => dec.decode(parts.get(name) ?? new Uint8Array())
const partXml = (parts: ZipParts, name: string): XElem => parseXml(partText(parts, name))

// --- wiring checkers (the rig's own, exercised by negative controls below) ---

function resolvePath(baseDir: string, target: string): string {
  const segs = baseDir ? baseDir.split('/') : []
  for (const part of target.split('/')) {
    if (part === '..') segs.pop()
    else if (part !== '.' && part !== '') segs.push(part)
  }
  return segs.join('/')
}

/** Every internal rel target in every .rels part must be a zip part. */
function brokenRels(parts: ZipParts): string[] {
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
function danglingRefs(xml: string, relsXml: string): string[] {
  const ids = new Set([...relsXml.matchAll(/Id="(rId\d+)"/g)].map((m) => m[1]))
  const missing: string[] = []
  for (const m of xml.matchAll(/r:(?:id|embed|link)="([^"]+)"/g)) {
    if (!ids.has(m[1])) missing.push(m[1])
  }
  return missing
}

const codesOf = (report: FidelityReport): Set<string> => new Set(report.entries.map((e) => e.code))

// --- the representative deck -------------------------------------------------

// 1×1 png — real bytes so a thumbnailer opening the result sees a picture.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const frame = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, rotation: 0, opacity: 1 })

const el = (v: unknown): ExportElement => v as ExportElement

function buildDoc(): ExportDoc {
  return {
    title: 'Rig deck',
    size: { width: 1280, height: 720 },
    theme: {
      background: '#FFFFFF', color: '#1E2A3A', accent: '#FF7A59',
      fontFamily: 'Inter, sans-serif', chartPalette: ['#FF9F7A', '#5B7C99'],
    },
    meta: { author: 'Andy', company: 'Nybl', subject: 'Rig coverage', keywords: 'rig,pptx' },
    assets: {},
    slides: [
      {
        id: 's1', background: '#FFFFFF', transition: 'fade',
        notes: 'Welcome to the rig\n\nSecond paragraph',
        elements: [
          el({
            type: 'text', id: 't1', ...frame(96, 80, 800, 90),
            html: 'Q3 <b>Results</b> &amp; <i>outlook</i>', fontSize: 40, fontFamily: 'Inter, sans-serif',
            fontWeight: 400, color: '#1E2A3A', align: 'left', valign: 'top', lineHeight: 1.2,
          }),
          el({
            type: 'text', id: 't2', ...frame(96, 620, 300, 40), link: 's2',
            html: 'p. {{page}}/{{pages}}', fontSize: 18, fontFamily: 'Inter, sans-serif',
            fontWeight: 400, color: '#5B7C99', align: 'left', valign: 'bottom', lineHeight: 1,
          }),
          el({
            type: 'shape', id: 'grad1', ...frame(700, 200, 300, 200), link: 'https://bento.page',
            shape: 'rect', fill: '#FF0000', stroke: 'none', strokeWidth: 0, radius: 12,
            fillGradient: { angle: 90, stops: [{ at: 0, color: '#FF0000' }, { at: 1, color: '#0000FF' }] },
            shadow: { x: 0, y: 6, blur: 18, color: 'rgba(0,0,0,0.35)' },
          }),
          el({
            type: 'shape', id: 'line1', ...frame(96, 200, 400, 40),
            shape: 'line', fill: '#222222', stroke: '#000000', strokeWidth: 3, radius: 0, lineEnd: 'arrow',
          }),
        ],
      },
      {
        id: 's2', background: '#1E2A3A', transition: 'morph', elements: [
          el({
            type: 'chart', id: 'c-bar', ...frame(96, 96, 500, 400), fx: { enter: 'fade-up' },
            option: { xAxis: { data: ['A', 'B', 'C'] }, yAxis: {}, series: [{ type: 'bar', name: 'Rev', data: [3, 5, 2] }] },
          }),
          el({
            type: 'chart', id: 'c-dual', ...frame(650, 96, 500, 400), fx: { countUp: true },
            option: {
              xAxis: { data: ['Q1', 'Q2'] },
              yAxis: [{}, { axisLabel: { formatter: '{value}%' } }],
              series: [
                { type: 'bar', name: 'Amount', data: [10, 20] },
                { type: 'line', name: 'Share', data: [5, 7], yAxisIndex: 1 },
              ],
            },
          }),
          el({
            type: 'chart', id: 'c-stack', ...frame(96, 520, 500, 160),
            option: {
              xAxis: { data: ['A', 'B'] },
              series: [
                { type: 'bar', name: 'S1', stack: 'x', data: [1, 2] },
                { type: 'bar', name: 'S2', stack: 'x', data: [3, 4] },
              ],
            },
          }),
        ],
      },
      {
        id: 's3', background: '#FFFFFF', elements: [
          el({ type: 'image', id: 'img1', ...frame(96, 96, 320, 200), src: PNG, fit: 'cover', radius: 8 }),
          el({
            type: 'svg', id: 'sv1', ...frame(500, 96, 200, 200),
            markup: '<svg viewBox="0 0 10 10"><rect class="x" width="10" height="10"/></svg>',
            css: '.x{fill:red}',
          }),
          el({
            type: 'table', id: 'tb1', ...frame(96, 360, 500, 200),
            columns: [{ w: 1 }, { w: 1 }], header: true,
            rows: [
              { cells: [{ html: 'Region' }, { html: 'Total' }] },
              { cells: [{ html: 'North' }, { html: '42' }] },
            ],
            // radius 0 explicitly: tables.ts merges the deck DEFAULT style,
            // whose rounded corners would (correctly) report table-radius-dropped
            style: { headerBg: '#1E2A3A', headerColor: '#FFFFFF', borderColor: '#DDDDDD', borderWidth: 1, color: '#1E2A3A', radius: 0 },
          }),
          el({ type: 'media', id: 'md1', ...frame(700, 360, 200, 60), kind: 'audio', src: 'data:audio/mp3;base64,AAAA' }),
          el({
            type: 'shape', id: 's3link', ...frame(960, 96, 120, 60), link: 'state1',
            shape: 'rect', fill: '#5B7C99', stroke: 'none', strokeWidth: 0, radius: 0,
          }),
          el({
            type: 'shape', id: 's3bad', ...frame(960, 200, 120, 60), link: 'nope',
            shape: 'rect', fill: '#5B7C99', stroke: 'none', strokeWidth: 0, radius: 0,
          }),
        ],
      },
      {
        id: 's4', background: '#F5F7FA', hidden: true, elements: [
          // byte-identical to img1: must dedup to ONE media part across slides
          el({ type: 'image', id: 'img2', ...frame(96, 96, 200, 120), src: PNG, fit: 'fill' }),
        ],
      },
      {
        id: 'state1', background: '#FFFFFF', stateOf: 's1', elements: [
          el({
            type: 'text', id: 'stx', ...frame(96, 96, 400, 60),
            html: 'state detail', fontSize: 24, fontFamily: 'Inter, sans-serif',
            fontWeight: 400, color: '#1E2A3A', align: 'left', valign: 'top', lineHeight: 1.2,
          }),
        ],
      },
    ],
  }
}

// --- run ---------------------------------------------------------------------

const { bytes, report } = await exportPptx(buildDoc())
const parts = await readZip(bytes)

console.log('package')
ok(bytes.length > 0, `export produced ${bytes.length} bytes`)
ok([...parts.keys()][0] === '[Content_Types].xml', '[Content_Types].xml is the FIRST zip entry')

const required = [
  '_rels/.rels', 'docProps/core.xml', 'docProps/app.xml',
  'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels',
  'ppt/theme/theme1.xml',
  'ppt/slideMasters/slideMaster1.xml', 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
  'ppt/slideLayouts/slideLayout1.xml', 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
  'ppt/notesMasters/notesMaster1.xml', 'ppt/notesMasters/_rels/notesMaster1.xml.rels',
  'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide3.xml', 'ppt/slides/slide4.xml',
  'ppt/slides/_rels/slide1.xml.rels', 'ppt/slides/_rels/slide2.xml.rels',
  'ppt/slides/_rels/slide3.xml.rels', 'ppt/slides/_rels/slide4.xml.rels',
  'ppt/notesSlides/notesSlide1.xml', 'ppt/notesSlides/_rels/notesSlide1.xml.rels',
  'ppt/charts/chart1.xml', 'ppt/charts/chart2.xml',
]
for (const name of required) ok(parts.has(name), `part present: ${name}`)
ok(!parts.has('ppt/slides/slide5.xml'), 'state slide is NOT exported as a slide part')
ok(!parts.has('ppt/charts/chart3.xml'), 'stacked chart produced no chart part (table fallback)')

const mediaNames = [...parts.keys()].filter((n) => n.startsWith('ppt/media/'))
ok(mediaNames.filter((n) => n.endsWith('.png')).length === 1,
  'byte-identical images on two slides dedup to ONE png part')
ok(mediaNames.filter((n) => n.endsWith('.svg')).length === 1, 'svg element embedded as one svg part')

console.log('every XML part parses with the kernel parser')
{
  let parsed = 0
  let threw = ''
  for (const name of parts.keys()) {
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue
    try { partXml(parts, name); parsed++ } catch (e) { threw = `${name}: ${e}` }
  }
  ok(threw === '', threw || `${parsed} XML parts parse clean`)
}

console.log('wiring')
ok(brokenRels(parts).length === 0, 'every internal rel target exists in the zip')
{
  let bad = ''
  for (let i = 1; i <= 4; i++) {
    const missing = danglingRefs(partText(parts, `ppt/slides/slide${i}.xml`), partText(parts, `ppt/slides/_rels/slide${i}.xml.rels`))
    if (missing.length) bad = `slide${i}: ${missing.join(',')}`
  }
  ok(bad === '', bad || 'every r:id/r:embed/r:link in every slide resolves in its rels')
}
{
  const ct = partXml(parts, '[Content_Types].xml')
  const overridden = new Set(kids(ct, NS.ct, 'Override').map((o) => attr(o, 'PartName')))
  for (const name of ['/ppt/presentation.xml', '/ppt/slides/slide1.xml', '/ppt/slides/slide4.xml',
    '/ppt/notesSlides/notesSlide1.xml', '/ppt/notesMasters/notesMaster1.xml',
    '/ppt/charts/chart1.xml', '/ppt/charts/chart2.xml', '/docProps/core.xml', '/docProps/app.xml']) {
    ok(overridden.has(name), `content-type override present: ${name}`)
  }
  let stray = ''
  for (const name of overridden) if (name && !parts.has(name.slice(1))) stray = name
  ok(stray === '', stray ? `override for missing part ${stray}` : 'no override points at a missing part')
}

console.log('presentation.xml')
{
  const pres = partXml(parts, 'ppt/presentation.xml')
  const ids = kids(kid(pres, NS.p, 'sldIdLst')!, NS.p, 'sldId')
  ok(ids.length === 4, 'sldIdLst lists 4 slides (states omitted, hidden kept)')
  ok(ids.every((s) => parseInt(attr(s, 'id') ?? '0', 10) >= 256), 'every sldId is >= 256')
  const sz = kid(pres, NS.p, 'sldSz')!
  ok(attr(sz, 'cx') === String(1280 * 9525) && attr(sz, 'cy') === String(720 * 9525),
    'slide size is doc.size px * 9525 (1280x720 -> 12192000x6858000)')
  ok(!!kid(pres, NS.p, 'notesMasterIdLst'), 'notesMasterIdLst present (deck has notes)')
}

console.log('slide 1 — text, fields, shapes, links')
{
  const s1 = partXml(parts, 'ppt/slides/slide1.xml')
  const bold = descendants(s1, NS.a, 'r').find((r) => textOf(r) === 'Results')
  ok(!!bold && attr(kid(bold!, NS.a, 'rPr')!, 'b') === '1', 'inline <b>Results</b> is a bold run')
  const italic = descendants(s1, NS.a, 'r').find((r) => textOf(r) === 'outlook')
  ok(!!italic && attr(kid(italic!, NS.a, 'rPr')!, 'i') === '1', 'inline <i>outlook</i> is an italic run')
  ok(descendants(s1, NS.a, 'r').some((r) => textOf(r).includes('&')), 'entity &amp; decoded into run text')
  const fld = descendants(s1, NS.a, 'fld')
  ok(fld.length === 1 && attr(fld[0], 'type') === 'slidenum' && textOf(fld[0]) === '1',
    '{{page}} is a LIVE slidenum field cached "1"')
  // splitFields emits one a:r per piece: '…/' between the tokens, then the
  // frozen '{{pages}}' value as its own run.
  ok(descendants(s1, NS.a, 't').some((t) => textOf(t) === '3'),
    '{{pages}} froze to "3" (hidden slide and state do not paginate)')
  ok(descendants(s1, NS.a, 'gradFill').length === 1
    && descendants(s1, NS.a, 'gs').length === 2, 'gradient fill carried with both stops')
  ok(descendants(s1, NS.a, 'outerShdw').length === 1, 'shadow carried as a:outerShdw')
  const cxn = descendants(s1, NS.p, 'cxnSp')
  ok(cxn.length === 1, 'line element exports as p:cxnSp')
  ok(attr(descendants(cxn[0], NS.a, 'tailEnd')[0] ?? cxn[0], 'type') === 'triangle',
    "lineEnd 'arrow' becomes a triangle tailEnd")

  const rels = partXml(parts, 'ppt/slides/_rels/slide1.xml.rels')
  const relById = new Map(kids(rels, NS.rel, 'Relationship').map((r) => [attr(r, 'Id'), r]))
  const links = descendants(s1, NS.a, 'hlinkClick')
  const jump = links.find((l) => attr(l, 'action') === 'ppaction://hlinksldjump')
  ok(!!jump && attr(relById.get(attr(jump!, 'id'))!, 'Target') === '../slides/slide2.xml',
    'internal link is a sldjump action whose rel targets slide2.xml')
  const ext = links.find((l) => attr(l, 'action') === undefined)
  const extRel = ext && relById.get(attr(ext, 'id'))
  ok(!!extRel && attr(extRel!, 'TargetMode') === 'External' && attr(extRel!, 'Target') === 'https://bento.page',
    'external link is an External-mode hyperlink rel (no jump action)')
}

console.log('slide 2 — charts')
{
  const s2 = partXml(parts, 'ppt/slides/slide2.xml')
  ok(descendants(s2, NS.p, 'graphicFrame').length === 3, 'three graphic frames (2 charts + 1 fallback table)')
  ok(descendants(s2, NS.a, 'tbl').length === 1, 'stacked chart downgraded to a data TABLE, not a wrong chart')
  const rels = partXml(parts, 'ppt/slides/_rels/slide2.xml.rels')
  const chartRels = kids(rels, NS.rel, 'Relationship').filter((r) => (attr(r, 'Type') ?? '').endsWith('/chart'))
  ok(chartRels.length === 2, 'exactly two chart rels (the reserved fallback rId stays unused)')

  const c1 = partXml(parts, 'ppt/charts/chart1.xml')
  ok(c1.ns === NS.c && c1.local === 'chartSpace', 'chart1 root is c:chartSpace')
  ok(descendants(c1, NS.c, 'barChart').length === 1, 'chart1 is a bar chart')
  const vals = descendants(c1, NS.c, 'numCache').flatMap((nc) => descendants(nc, NS.c, 'v').map(textOf))
  ok(['3', '5', '2'].every((v) => vals.includes(v)), 'chart1 numCache carries the series values')

  const c2 = partXml(parts, 'ppt/charts/chart2.xml')
  ok(descendants(c2, NS.c, 'valAx').length === 2, 'dual-axis chart carries two value axes')
  ok(descendants(c2, NS.c, 'barChart').length === 1 && descendants(c2, NS.c, 'lineChart').length === 1,
    'dual-axis chart is one bar group + one line group')
}

console.log('slide 3 — image, svg, table, media, link degradation')
{
  const s3 = partXml(parts, 'ppt/slides/slide3.xml')
  ok(descendants(s3, NS.p, 'pic').length === 2, 'image + svg export as p:pic; dropped audio adds none')
  ok(descendants(s3, NS.asvg, 'svgBlip').length === 1, 'svg pic carries asvg:svgBlip')
  const svgName = mediaNames.find((n) => n.endsWith('.svg'))!
  const svgText = partText(parts, svgName)
  ok(svgText.includes('xmlns="http://www.w3.org/2000/svg"'), 'svg part gained the xmlns the inline markup lacked')
  ok(svgText.includes('<style>.x{fill:red}</style>'), 'el.css spliced into the embedded svg markup')
  ok(descendants(s3, NS.a, 'tbl').length === 1
    && descendants(s3, NS.a, 'gridCol').length === 2, 'table exports with its 2-column grid')

  const rels = partXml(parts, 'ppt/slides/_rels/slide3.xml.rels')
  const relById = new Map(kids(rels, NS.rel, 'Relationship').map((r) => [attr(r, 'Id'), r]))
  const jump = descendants(s3, NS.a, 'hlinkClick').find((l) => attr(l, 'action') === 'ppaction://hlinksldjump')
  ok(!!jump && attr(relById.get(attr(jump!, 'id'))!, 'Target') === '../slides/slide1.xml',
    "link into the omitted state retargets to the state's parent slide (#88 degradation)")
}

console.log('slide 4 — hidden')
{
  const s4 = partXml(parts, 'ppt/slides/slide4.xml')
  ok(attr(s4, 'show') === '0', 'hidden slide carries show="0"')
}

console.log('notes')
{
  const notes = partXml(parts, 'ppt/notesSlides/notesSlide1.xml')
  const paras = descendants(notes, NS.a, 'p')
  ok(paras.length === 3, 'notes keep the paragraph rhythm (text, blank, text)')
  ok(textOf(notes).includes('Welcome to the rig') && textOf(notes).includes('Second paragraph'),
    'both notes paragraphs carried')
  const rels = partXml(parts, 'ppt/notesSlides/_rels/notesSlide1.xml.rels')
  const targets = kids(rels, NS.rel, 'Relationship').map((r) => attr(r, 'Target'))
  ok(targets.includes('../notesMasters/notesMaster1.xml') && targets.includes('../slides/slide1.xml'),
    'notesSlide rels reach the notes master and back-link its slide')
}

console.log('docProps')
{
  const core = partXml(parts, 'docProps/core.xml')
  const DC = 'http://purl.org/dc/elements/1.1/'
  ok(textOf(kid(core, DC, 'creator')!) === 'Andy', 'doc.meta.author -> dc:creator')
  ok(textOf(kid(core, DC, 'title')!) === 'Rig deck', 'doc.title -> dc:title')
  const app = partXml(parts, 'docProps/app.xml')
  const EP = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties'
  ok(textOf(kid(app, EP, 'Company')!) === 'Nybl', 'doc.meta.company -> app.xml Company')
}

console.log('fidelity report')
{
  const expected = new Set([
    'state-slides-omitted',
    'presentation-effects-static',
    'morph-not-exported',
    'chart-approximated',
    'image-fit-approximated',
    'svg-no-raster-fallback',
    'media-dropped',
    'missing-link-target',
    'text-field-frozen',
  ])
  const got = codesOf(report)
  const extra = [...got].filter((c) => !expected.has(c))
  const missing = [...expected].filter((c) => !got.has(c))
  ok(extra.length === 0 && missing.length === 0,
    `report codes EXACTLY as expected${extra.length ? ` (extra: ${extra})` : ''}${missing.length ? ` (missing: ${missing})` : ''}`)
  const fx = report.entries.find((e) => e.code === 'presentation-effects-static')
  ok(!!fx && fx!.where === 'slide 2' && fx!.count === 2,
    'fx on two elements folds into ONE entry per slide (count 2) — #88 dedup rule')
  const states = report.entries.find((e) => e.code === 'state-slides-omitted')
  ok(!!states && states!.count === 1 && states!.verdict === 'dropped', 'state omission reported once, as dropped')
}

console.log('determinism')
{
  const again = await exportPptx(buildDoc())
  const same = again.bytes.length === bytes.length && again.bytes.every((b, i) => b === bytes[i])
  ok(same, 'two exports of the same doc are byte-identical (fixed zip timestamp)')
}

console.log('negative controls')
{
  // Each checker observed FAILING on doctored input — otherwise a green run
  // only proves the checkers are inert.
  const doctored = new Map(parts)
  doctored.delete('ppt/slides/slide2.xml')
  ok(brokenRels(doctored).length > 0, 'NEGATIVE: rel checker catches a deleted part')
  ok(danglingRefs('<p:sp r:embed="rId99"/>', partText(parts, 'ppt/slides/_rels/slide1.xml.rels')).length === 1,
    'NEGATIVE: ref checker catches an unknown rId')

  let threw = false
  try {
    await exportPptx({ ...buildDoc(), slides: buildDoc().slides.filter((s) => s.stateOf) })
  } catch { threw = true }
  ok(threw, 'NEGATIVE: a deck with only state slides is refused, not exported empty')

  // A broken/breaking element degrades to a report entry, never a dead export.
  const mini = await exportPptx({
    ...buildDoc(),
    slides: [{
      id: 'm1', background: '#FFFFFF', elements: [
        el({ type: 'image', id: 'bmp1', ...frame(0, 0, 100, 100), src: 'data:image/bmp;base64,AAAA', fit: 'fill' }),
        el({ type: 'wormhole', id: 'w1', ...frame(0, 0, 10, 10) }),
      ],
    }],
  })
  const miniParts = await readZip(mini.bytes)
  const miniCodes = codesOf(mini.report)
  ok(miniCodes.has('missing-image') && miniCodes.has('element-unsupported') && miniCodes.size === 2,
    'NEGATIVE: unsupported image mime + unknown element type each report, nothing else fires')
  ok([...miniParts.keys()].every((n) => !n.startsWith('ppt/media/')), 'NEGATIVE: refused bmp writes no media part')

  // --- the boilerplate PowerPoint actually requires ---------------------------
  // presProps, viewProps, tableStyles and a presentation->theme rel are all
  // schema-OPTIONAL, and the first cut of this writer shipped without them:
  // unzip -t passed, a 192-check OPC validation passed, and real macOS
  // PowerPoint still raised its "found a problem / Repair" dialog on an
  // otherwise-valid file. Every real producer emits them. Their absence is
  // invisible to structural checks, so their PRESENCE is pinned here.
  for (const part of ['ppt/presProps.xml', 'ppt/viewProps.xml', 'ppt/tableStyles.xml']) {
    ok(miniParts.has(part), `${part} present — its absence is a PowerPoint repair prompt`)
  }
  const presRels = new TextDecoder().decode(miniParts.get('ppt/_rels/presentation.xml.rels')!)
  for (const kind of ['theme', 'presProps', 'viewProps', 'tableStyles']) {
    ok(presRels.includes(`relationships/${kind}"`), `presentation.xml.rels carries the ${kind} rel`)
  }
  const ctypes = new TextDecoder().decode(miniParts.get('[Content_Types].xml')!)
  ok(['presProps', 'viewProps', 'tableStyles'].every((k) => ctypes.includes(`${k}+xml`)),
    'the three property parts are declared in [Content_Types].xml')
  ok(descendants(partXml(miniParts, 'ppt/slides/slide1.xml'), NS.p, 'pic').length === 0,
    'NEGATIVE: dropped image leaves no p:pic behind')
}

console.log(`\n${checks} checks, ${failures} failures`)
if (failures > 0) process.exit(1)
