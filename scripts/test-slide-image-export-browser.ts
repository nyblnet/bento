#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Slide image export — the BROWSER half.
//
//   node scripts/test-slide-image-export-browser.ts
//   node scripts/test-slide-image-export-browser.ts --emit-fixture /tmp/probe.html
//
// (Run directly: this parent imports only node builtins. The PROBE is bundled
// by esbuild against the repo's real image-export.ts, which is why the parent
// must not import it — it uses extensionless './model' specifiers that node's
// native type stripping will not resolve.)
//
// The probe drives the production rasterizer from a file:// page. It keeps the
// checks that need a real browser: representative rich-slide pixels, embedded
// resources, scale and matte behaviour, network isolation, atomic batches,
// cancellation/TOCTOU, and the dialog's asynchronous state transitions.
//
//   1. a data-URI outer SVG, drawn from a file:// page, rasterizes WITHOUT
//      tainting the canvas — the reason the design forbids blob: URLs, which
//      DO taint on file:// (issue #261's reporter hit exactly this);
//   2. rich text, MathML, a chart, a table, an embedded image, an author SVG's
//      markup-local <style> AND the model's separate SvgElement.css field all
//      survive the foreignObject boundary and actually paint;
//   3. an embedded @font-face reaches the raster;
//   4. blanking media src/poster BEFORE the first render stops a remote video
//      from being requested at all — detached <video> assignment fetches;
//   5. representative href, xlink:href, CSS and foreignObject threats make no
//      request, with a CDP positive control proving the request log works;
//   6. 2x is genuine supersampling, not a 1x bitmap scaled up;
//   7. JPEG paints a white matte where PNG is transparent;
//   8. malformed or oversized embedded resources fail as typed errors;
//   9. a batch is atomic, honours cancellation, and re-checks after preflight.
//
// The request log comes from CDP (Network.requestWillBeSent) rather than from a
// local http server: Chrome 151 refuses a file:// page's subresource request to
// http://127.0.0.1 outright (measured — the server logged nothing while the
// <img> sat in the DOM), so a server-based log on file:// would report "no
// requests" for a page that never had the chance to make one. CDP sees the
// ATTEMPT. A POSITIVE CONTROL request to an unresolvable public host proves the
// log is capable, so a clean log is evidence rather than an artifact of a
// blocked scheme.
//
// CDP also lets the parent wait for asynchronous rasterization to finish.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) {
    failures++
    console.error(`  ✗ ${msg}`)
  } else {
    console.log(`  ✓ ${msg}`)
  }
}

const repoFile = (rel: string): string => {
  const file = path.resolve(rel)
  if (!fs.existsSync(file)) throw new Error(`run this rig from the repo root — ${rel} not found`)
  return file
}

const argv = process.argv.slice(2)
const emitAt = (() => {
  const i = argv.indexOf('--emit-fixture')
  if (i < 0) return null
  const target = argv[i + 1]
  if (!target || target.startsWith('--')) throw new Error('--emit-fixture needs a path')
  return path.resolve(target)
})()
const CHROME = [
  process.env.BENTO_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p): p is string => !!p && fs.existsSync(p))
  ?? (spawnSync('which', ['google-chrome']).status === 0 ? 'google-chrome' : undefined)

// ---------------------------------------------------------------------------
// The probe. Written without backticks or "${" so it can live in a template
// literal (same constraint as scripts/test-sanitize.ts).
// ---------------------------------------------------------------------------

const probeSource = (
  exportPath: string, modelPath: string, fontPath: string,
  dialogPath: string, origin: string,
) => `
import { promptSlideImageExport } from ${JSON.stringify(dialogPath)}
import {
  EXPORT_BUDGETS,
  EXPORT_LIMITS,
  SlideImageExportError,
  buildExportCss,
  buildSlideImageExportPlan,
  collectExportCss,
  downloadExportArtifact,
  exportSlideImages,
  rasterizeSlideImage,
} from ${JSON.stringify(exportPath)}
import { newDoc } from ${JSON.stringify(modelPath)}
import { FRAUNCES_900 } from ${JSON.stringify(fontPath)}

const ORIGIN = ${JSON.stringify(origin)}

type Res = [string, boolean]
const results: Res[] = []
const notes: string[] = []
const check = (name: string, pass: boolean) => { results.push([name, !!pass]) }
const note = (line: string) => { notes.push(line) }

// --- fixture material -------------------------------------------------------

/** A REAL png, produced by this browser — no hand-written bytes in the rig. */
function makePng(color: string, w: number, h: number): string {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const x = c.getContext('2d')!
  x.fillStyle = color
  x.fillRect(0, 0, w, h)
  return c.toDataURL('image/png')
}


const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
const bytesToB64 = (bytes: Uint8Array): string => {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}
const dataUriBytes = (uri: string): Uint8Array => b64ToBytes(uri.slice(uri.indexOf(',') + 1))
const asDataUri = (mime: string, bytes: Uint8Array) => 'data:' + mime + ';base64,' + bytesToB64(bytes)

const PNG_RED = makePng('#E23D3D', 8, 8)
const PNG_POSTER = makePng('#22C55E', 16, 16)

/**
 * A real PNG with its signature and IHDR intact and every scanline removed.
 *
 * It is a POLICY-legal png (right magic, right type, not animated) that no
 * decoder can turn into pixels — which is the case the preflight/decode split
 * exists for. A merely truncated file is not enough: Chrome happily decodes a
 * PNG whose IDAT stream stops early, and paints the rows it got.
 */
const HEADLESS_PNG = (() => {
  const p = dataUriBytes(PNG_RED)
  for (let i = 8; i + 8 <= p.length; i++) {
    if (p[i] === 0x49 && p[i + 1] === 0x44 && p[i + 2] === 0x41 && p[i + 3] === 0x54) {
      return asDataUri('image/png', p.slice(0, i - 4))
    }
  }
  return asDataUri('image/png', p.slice(0, 33))
})()


// --- pixel utilities --------------------------------------------------------

async function pixelsOf(blob: Blob): Promise<ImageData> {
  const bmp = await createImageBitmap(blob)
  const c = document.createElement('canvas')
  c.width = bmp.width; c.height = bmp.height
  const x = c.getContext('2d')!
  x.drawImage(bmp, 0, 0)
  bmp.close()
  return x.getImageData(0, 0, c.width, c.height)
}

function at(px: ImageData, x: number, y: number): [number, number, number, number] {
  const i = (y * px.width + x) * 4
  return [px.data[i], px.data[i + 1], px.data[i + 2], px.data[i + 3]]
}
const near = (a: number[], r: number, g: number, b: number, tol: number) =>
  Math.abs(a[0] - r) <= tol && Math.abs(a[1] - g) <= tol && Math.abs(a[2] - b) <= tol

/** Count pixels differing from the slide background inside a box. */
function inkCount(px: ImageData, x0: number, y0: number, x1: number, y1: number, bg: number[]): number {
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = at(px, x, y)
      if (!near(p, bg[0], bg[1], bg[2], 12)) n++
    }
  }
  return n
}

/**
 * A minimal zip READER — test-only, on purpose.
 *
 * Production writes archives and never opens one, so a reader has no business
 * shipping in the document. But a test that checks only for "PK" has checked
 * that something zip-shaped exists, not that the user gets their slides in
 * order. This walks the central directory the way a real reader does.
 */
function readZipEntries(z: Uint8Array): Array<{ name: string; method: number; data: Uint8Array }> {
  const u16 = (at: number) => z[at] | (z[at + 1] << 8)
  const u32 = (at: number) => (z[at] | (z[at + 1] << 8) | (z[at + 2] << 16) | (z[at + 3] << 24)) >>> 0
  let eocd = -1
  for (let i = z.length - 22; i >= 0; i--) if (u32(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) return []
  const count = u16(eocd + 10)
  let at = u32(eocd + 16)
  const out: Array<{ name: string; method: number; data: Uint8Array }> = []
  for (let i = 0; i < count; i++) {
    if (u32(at) !== 0x02014b50) break
    const nameLen = u16(at + 28)
    const extraLen = u16(at + 30)
    const commentLen = u16(at + 32)
    const size = u32(at + 24)
    const localAt = u32(at + 42)
    const name = new TextDecoder().decode(z.subarray(at + 46, at + 46 + nameLen))
    const method = u16(localAt + 8)
    const dataAt = localAt + 30 + u16(localAt + 26) + u16(localAt + 28)
    out.push({ name, method, data: z.subarray(dataAt, dataAt + size) })
    at += 46 + nameLen + extraLen + commentLen
  }
  return out
}


// --- driving the PRODUCTION rasterizer -------------------------------------

type Shot = { blob: Blob; bytes: Uint8Array; pixels: ImageData; svgBytes: number; uriBytes: number }

async function shoot(
  doc: any, slideId: string,
  opts: { scale: 1 | 2; format: 'png' | 'jpeg'; capturedAt: Date; canvas: HTMLCanvasElement;
    cssText?: string; limits?: any; budgets?: any },
): Promise<Shot> {
  const plan = buildSlideImageExportPlan(
    doc, slideId, { scope: 'current', format: opts.format, scale: opts.scale }, opts.capturedAt)
  let diag: any = { svgBytes: 0, uriBytes: 0 }
  const blob = await rasterizeSlideImage({
    doc,
    plannedSlide: plan.slides[0],
    format: opts.format,
    scale: opts.scale,
    capturedAt: opts.capturedAt,
    cssText: opts.cssText ?? buildExportCss(doc, opts.budgets),
    canvas: opts.canvas,
    limits: opts.limits,
    budgets: opts.budgets,
    onDiagnostics: (d: any) => { diag = d },
  })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return { blob, bytes, pixels: await pixelsOf(blob), svgBytes: diag.svgBytes, uriBytes: diag.uriBytes }
}


/** Run something that must FAIL, and report the typed code it failed with. */
async function failure(fn: () => Promise<unknown>): Promise<{ code: string; message: string; slideNumber?: number }> {
  try {
    await fn()
    return { code: '(it succeeded)', message: '' }
  } catch (err) {
    if (err instanceof SlideImageExportError) {
      return { code: err.code, message: err.message, slideNumber: err.slideNumber }
    }
    return { code: '(untyped: ' + String(err) + ')', message: String(err) }
  }
}

// --- the main fixture -------------------------------------------------------

function fixtureDoc(opts: { withFont: boolean }) {
  const doc: any = newDoc()
  doc.title = 'probe deck'
  doc.size = { width: 1080, height: 1080 }
  doc.assets = { fraunces: FRAUNCES_900, shot: PNG_RED, poster: PNG_POSTER }
  doc.fonts = opts.withFont ? [{ family: 'ProbeFraunces', asset: 'fraunces', weight: '900' }] : []

  const slide: any = doc.slides[0]
  slide.id = 'p-slide'
  slide.background = '#101820'
  slide.hover = { type: 'reveal', default: 'set-a' }
  slide.notes = 'speaker notes that must never reach a pixel'
  slide.elements = [
    { id: 'p-text', type: 'text', x: 40, y: 30, w: 600, h: 90, rotation: 0, opacity: 1,
      html: '<b>Bento</b> {{page:2}}/{{pages}} — {{date}} {{time}}', fontSize: 40, fontWeight: 700,
      color: '#FFFFFF', align: 'left', valign: 'top', lineHeight: 1.2, fontFamily: '' },
    { id: 'p-font', type: 'text', x: 40, y: 130, w: 600, h: 150, rotation: 0, opacity: 1,
      html: 'Hamburgefonstiv', fontSize: 84, fontWeight: 900, color: '#FFD166',
      align: 'left', valign: 'top', lineHeight: 1.05,
      fontFamily: opts.withFont ? "'ProbeFraunces'" : "'NoSuchFamilyAtAll'" },
    { id: 'p-math', type: 'text', x: 40, y: 300, w: 600, h: 120, rotation: 0, opacity: 1,
      html: '$$\\\\frac{a}{b}$$', fontSize: 56, fontWeight: 400, color: '#7FE1D0',
      align: 'left', valign: 'top', lineHeight: 1.2, fontFamily: '' },
    { id: 'p-table', type: 'table', x: 40, y: 440, w: 600, h: 180, rotation: 0, opacity: 1,
      columns: [{ w: 1 }, { w: 1 }], header: true,
      rows: [
        { cells: [{ html: 'Region' }, { html: 'Revenue' }] },
        { cells: [{ html: 'North' }, { html: '1200' }] },
      ],
      style: { headerBg: '#2C6BED', headerColor: '#FFFFFF', borderColor: '#4A5568', borderWidth: 1,
        cellPadX: 12, cellPadY: 8, fontSize: 20, color: '#E8EEF7', radius: 6 } },
    { id: 'p-chart', type: 'chart', x: 40, y: 650, w: 600, h: 380, rotation: 0, opacity: 1,
      option: { color: ['#F59E0B'], xAxis: { type: 'category', data: ['a', 'b', 'c'] },
        yAxis: { type: 'value' }, series: [{ type: 'bar', data: [3, 7, 5] }] } },
    { id: 'p-image', type: 'image', x: 680, y: 30, w: 120, h: 120, rotation: 0, opacity: 1,
      src: 'asset:shot', fit: 'fill', radius: 0 },
    // Author SVG exercises both markup-local styles and the model css field.
    // Its CSS and SMIL both move .p immediately unless export freezes them.
    { id: 'p-svg', type: 'svg', x: 680, y: 170, w: 360, h: 200, rotation: 0, opacity: 1,
      markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 200">' +
        '<sty' + 'le>@keyframes probe-shift{from{transform:translateX(160px)}' +
        'to{transform:translateX(160px)}}.p.motion{fill:#FF5C5C;' +
        'animation:probe-shift 60s linear infinite!important}</sty' + 'le>' +
        '<rect class="p motion" style="animation:probe-shift 60s linear infinite!important" ' +
        'x="0" y="0" width="180" height="200">' +
        '<animate attributeName="x" from="160" to="160" dur="60s" repeatCount="indefinite"/>' +
        '</rect>' +
        '<rect class="q" x="180" y="0" width="180" height="200"/>' +
        '</svg>',
      css: '.q{fill:#5CA8FF}' },
    // A sanitizer-handled CSS URL must not turn the export itself into a fetch.
    { id: 'p-css-hazard', type: 'svg', x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1,
      markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
        '<sty' + 'le>.r{fill:red;background:url(' + ORIGIN + '/sanitized-css.png)}</sty' + 'le>' +
        '<rect class="r" width="1" height="1"/></svg>' },
    // A representative foreignObject sink; sanitizing it must not fetch.
    { id: 'p-html-sink', type: 'svg', x: 1, y: 0, w: 1, h: 1, rotation: 0, opacity: 1,
      markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
        '<foreignObject width="1" height="1">' +
        '<img src="' + ORIGIN + '/foreign-object.png"/>' +
        '</foreignObject><rect width="1" height="1" fill="#333"/></svg>' },
    { id: 'p-media', type: 'media', x: 680, y: 390, w: 360, h: 200, rotation: 0, opacity: 1,
      kind: 'video', src: ORIGIN + '/remote-video.mp4', poster: 'asset:poster', fit: 'fill' },
    { id: 'p-shape', type: 'shape', x: 680, y: 610, w: 360, h: 120, rotation: 0, opacity: 1,
      shape: 'rect', fill: '#000000', stroke: '#FFFFFF', strokeWidth: 2, radius: 8,
      fillGradient: { angle: 90, stops: [{ at: 0, color: '#8B5CF6' }, { at: 1, color: '#EC4899' }] },
      shadow: { x: 0, y: 6, blur: 12, color: 'rgba(0,0,0,0.6)' } },
    // A ONE-DEVICE-PIXEL diagonal. On a nearest-neighbour upscale of the 1x
    // raster this edge is 2x2 blocks of one value; a true 2x render resolves it
    // with its own anti-aliasing, which is what "additional samples" means.
    { id: 'p-hairline', type: 'svg', x: 40, y: 1035, w: 1000, h: 40, rotation: 0, opacity: 1,
      markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 40">' +
        '<path d="M0 39 L1000 1" stroke="#FFFFFF" stroke-width="1" fill="none"/></svg>' },
  ]
  return { doc, slide }
}

/** A tiny deck with a TRANSPARENT background, for the jpeg matte question. */
function transparentFixture() {
  const doc: any = newDoc()
  doc.title = 'matte'
  doc.size = { width: 200, height: 200 }
  doc.assets = {}
  doc.fonts = []
  const slide: any = doc.slides[0]
  slide.id = 'matte-slide'
  slide.background = 'rgba(0,0,0,0)'
  slide.elements = [
    { id: 'm-box', type: 'shape', x: 60, y: 60, w: 80, h: 80, rotation: 0, opacity: 1,
      shape: 'rect', fill: '#E23D3D', stroke: 'none', strokeWidth: 0, radius: 0 },
  ]
  return { doc, slide }
}

// --- run --------------------------------------------------------------------

async function main() {
  note('browser: ' + navigator.userAgent)

  // The runtime injects this sheet at boot (slides/src/fonts.ts injectFonts).
  // Reproduce it here, or the "no duplicate @font-face" check below would pass
  // for the wrong reason — there would be nothing to duplicate.
  {
    const runtimeFonts = document.createElement('style')
    runtimeFonts.id = 'bento-fonts'
    runtimeFonts.textContent =
      '@font-face{font-family:"ProbeFraunces";src:url(' + JSON.stringify(FRAUNCES_900) +
      ');font-weight:900;font-style:normal;font-display:swap}'
    document.head.appendChild(runtimeFonts)
    check('the fixture really carries a runtime #bento-fonts sheet to be skipped',
      !!document.getElementById('bento-fonts'))
  }

  const canvas = document.createElement('canvas')
  const capturedAt = new Date(Date.UTC(2026, 7, 15, 12, 0, 0))
  const BG = [16, 24, 32]

  const exportCss = collectExportCss()
  check('the app stylesheet is collected for the foreignObject render',
    exportCss.indexOf('.bento-el') >= 0)

  const { doc, slide } = fixtureDoc({ withFont: true })

  const one = await shoot(doc, slide.id, { scale: 1, format: 'png', capturedAt, canvas })
  note('serialized svg bytes @1x: ' + one.svgBytes + ' — data-uri chars: ' + one.uriBytes)
  check('a file:// data-URI outer SVG rasterizes and its pixels can be read back (canvas untainted)',
    one.pixels.width === 1080)
  check('the png carries a png signature',
    one.bytes[0] === 0x89 && one.bytes[1] === 0x50 && one.bytes[2] === 0x4E && one.bytes[3] === 0x47)
  check('1080x1080 at 1x decodes to 1080x1080', one.pixels.width === 1080 && one.pixels.height === 1080)

  check('rich text painted', inkCount(one.pixels, 45, 40, 600, 110, BG) > 200)
  check('MathML painted', inkCount(one.pixels, 45, 305, 400, 410, BG) > 100)
  check('the table painted', inkCount(one.pixels, 45, 445, 630, 615, BG) > 500)
  check('the chart painted', inkCount(one.pixels, 45, 655, 630, 1020, BG) > 500)
  check('the embedded image painted its own red', near(at(one.pixels, 740, 90), 226, 61, 61, 10))
  check('the author SVG markup-local <style> painted .p', near(at(one.pixels, 760, 270), 255, 92, 92, 12))
  check('author SVG CSS and SMIL motion are frozen at the base frame',
    near(at(one.pixels, 700, 270), 255, 92, 92, 12))
  check("the model's separate SvgElement.css painted .q", near(at(one.pixels, 950, 270), 92, 168, 255, 12))
  check('a gradient shape painted', inkCount(one.pixels, 690, 620, 1030, 720, BG) > 5000)
  check('media rendered its embedded poster, not a live control',
    near(at(one.pixels, 860, 490), 34, 197, 94, 12))

  const fallback = fixtureDoc({ withFont: false })
  const noFont = await shoot(fallback.doc, fallback.slide.id, { scale: 1, format: 'png', capturedAt, canvas })
  const inkWith = inkCount(one.pixels, 40, 130, 660, 285, BG)
  const inkWithout = inkCount(noFont.pixels, 40, 130, 660, 285, BG)
  note('font ink: embedded=' + inkWith + ' fallback=' + inkWithout)
  check('the embedded face reached the raster (its glyph geometry differs from the fallback)',
    inkWith > 0 && inkWithout > 0 && Math.abs(inkWith - inkWithout) / Math.max(inkWith, inkWithout) > 0.06)

  const two = await shoot(doc, slide.id, { scale: 2, format: 'png', capturedAt, canvas })
  check('1080x1080 at 2x decodes to 2160x2160', two.pixels.width === 2160 && two.pixels.height === 2160)
  note('serialized svg bytes @2x: ' + two.svgBytes + ' — data-uri chars: ' + two.uriBytes)

  const up = document.createElement('canvas')
  up.width = 2160; up.height = 2160
  const uctx = up.getContext('2d')!
  uctx.imageSmoothingEnabled = false
  const oneBmp = await createImageBitmap(one.blob)
  uctx.drawImage(oneBmp, 0, 0, 2160, 2160)
  oneBmp.close()
  const bandY = 2070, bandH = 80
  const upPx = uctx.getImageData(0, bandY, 2160, bandH)
  let differing = 0, total = 0
  for (let y = 0; y < bandH; y++) {
    for (let x = 0; x < 2160; x++) {
      const i = (y * 2160 + x) * 4
      const j = ((y + bandY) * 2160 + x) * 4
      total++
      if (Math.abs(upPx.data[i] - two.pixels.data[j]) > 8) differing++
    }
  }
  note('hairline band: ' + differing + '/' + total + ' pixels differ from a nearest-upscaled 1x')
  check('2x carries additional samples rather than a scaled-up 1x bitmap',
    total > 0 && differing / total > 0.01)
  check('the one-device-pixel diagonal actually painted at 1x',
    inkCount(one.pixels, 41, 1036, 1039, 1074, BG) > 400)

  const jpg = await shoot(doc, slide.id, { scale: 1, format: 'jpeg', capturedAt, canvas })
  check('jpeg carries SOI/EOI markers',
    jpg.bytes[0] === 0xFF && jpg.bytes[1] === 0xD8 &&
    jpg.bytes[jpg.bytes.length - 2] === 0xFF && jpg.bytes[jpg.bytes.length - 1] === 0xD9)
  check('jpeg decodes at the same dimensions', jpg.pixels.width === 1080 && jpg.pixels.height === 1080)

  {
    const t = transparentFixture()
    const tPng = await shoot(t.doc, t.slide.id, { scale: 1, format: 'png', capturedAt, canvas })
    const tJpg = await shoot(t.doc, t.slide.id, { scale: 1, format: 'jpeg', capturedAt, canvas })
    const cornerPng = at(tPng.pixels, 5, 5)
    const cornerJpg = at(tJpg.pixels, 5, 5)
    check('a transparent slide background really is transparent in PNG (alpha 0)',
      cornerPng[3] === 0)
    check('the same pixel is white in JPEG: the matte is painted, not left as black',
      near(cornerJpg, 255, 255, 255, 3) && cornerJpg[3] === 255)
    check('opaque content is unchanged by the matte',
      near(at(tPng.pixels, 100, 100), 226, 61, 61, 6) && near(at(tJpg.pixels, 100, 100), 226, 61, 61, 8))
  }

  note('canvas proven: 1080x1080 @1x and 2160x2160 @2x, both drawn, read back and encoded')
  note('limits in force: maxDimension=' + EXPORT_LIMITS.maxDimension + ' maxPixels=' + EXPORT_LIMITS.maxPixels)

  await resourceSection(canvas, capturedAt)
  await batchSection(canvas, capturedAt)
  await dialogSection()

  // --- the positive control -------------------------------------------------
  // Loaded OUTSIDE the export path, on purpose: if this does not appear in the
  // parent's request log then the log cannot see requests from a file:// page
  // and every "zero requests" claim is worthless.
  await new Promise<void>((resolve) => {
    const probe = new Image()
    probe.onload = () => resolve()
    probe.onerror = () => resolve()
    probe.src = ORIGIN + '/positive-control.png'
    setTimeout(resolve, 3000)
  })
}

// --- the resource matrix ----------------------------------------------------

function oneElementDoc(el: any, extra: any = {}) {
  const doc: any = newDoc()
  doc.title = 'resource'
  doc.size = { width: 200, height: 200 }
  doc.assets = extra.assets ?? {}
  doc.fonts = extra.fonts ?? []
  const slide: any = doc.slides[0]
  slide.id = 'r-slide'
  slide.background = '#FFFFFF'
  slide.elements = [el]
  return { doc, slide }
}

const image = (src: string) =>
  ({ id: 'r-img', type: 'image', x: 20, y: 20, w: 160, h: 160, rotation: 0, opacity: 1,
    src, fit: 'fill', radius: 0 })

async function resourceSection(canvas: HTMLCanvasElement, capturedAt: Date) {
  const shootIt = (f: { doc: any; slide: any }) =>
    shoot(f.doc, f.slide.id, { scale: 1, format: 'png', capturedAt, canvas })

  // The browser must decode both direct data URIs and document assets.
  for (const [label, f] of [
    ['an embedded PNG', oneElementDoc(image(PNG_RED))],
    ['an asset: image', oneElementDoc(image('asset:pic'), { assets: { pic: PNG_RED } })],
  ] as const) {
    const res = await failure(() => shootIt(f))
    check('resource — ' + label + ' rasterizes [got: ' + res.code + ']',
      res.code === '(it succeeded)')
  }

  const svgEl = (markup: string) =>
    ({ id: 'r-svg', type: 'svg', x: 20, y: 20, w: 160, h: 160,
      rotation: 0, opacity: 1, markup })

  // One representative for each external-reference spelling that has caused
  // audit gaps: model href, legacy xlink:href, and escaped CSS url().
  const threats: Array<[string, { doc: any; slide: any }]> = [
    ['a remote image model source',
      oneElementDoc(image(ORIGIN + '/remote-image.png'))],
    ['an author-SVG href',
      oneElementDoc(svgEl(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
        '<image href="' + ORIGIN + '/svg-href.png" width="10" height="10"/></svg>'))],
    ['an author-SVG xlink:href',
      oneElementDoc(svgEl(
        '<svg xmlns="http://www.w3.org/2000/svg" ' +
        'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">' +
        '<image xlink:href="' + ORIGIN + '/svg-xlink.png" width="10" height="10"/></svg>'))],
    ['an author-SVG whose embedded href shadows a remote xlink:href',
      oneElementDoc(svgEl(
        '<svg xmlns="http://www.w3.org/2000/svg" ' +
        'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">' +
        '<image href="' + PNG_RED + '" xlink:href="' + ORIGIN +
        '/shadowed-xlink.png" width="10" height="10"/></svg>'))],
    ['an author-SVG whose embedded xlink:href shadows a remote href',
      oneElementDoc(svgEl(
        '<svg xmlns="http://www.w3.org/2000/svg" ' +
        'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">' +
        '<image href="' + ORIGIN + '/shadowed-href.png" xlink:href="' + PNG_RED +
        '" width="10" height="10"/></svg>'))],
    ['an escaped CSS url()',
      oneElementDoc(svgEl(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
        '<sty' + 'le>.s{background:u\\\\72l(' + ORIGIN + '/escaped-css.png)}</sty' + 'le>' +
        '<rect class="s" width="10" height="10"/></svg>'))],
  ]
  for (const [label, f] of threats) {
    const res = await failure(() => shootIt(f))
    check('resource — ' + label + ' is refused [got: ' + res.code + ']',
      res.code === 'resource')
  }

  const embeddedSvgImage = oneElementDoc(svgEl(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
    '<image href="' + PNG_RED + '" width="10" height="10"/></svg>'))
  check('resource — an embedded image inside author SVG still rasterizes',
    (await failure(() => shootIt(embeddedSvgImage))).code === '(it succeeded)')

  // These document-controlled descriptors are interpolated into @font-face.
  // One fail-closed case for each field guards the public export seam without
  // restoring the old exhaustive descriptor grammar matrix.
  for (const [field, value] of [
    ['weight', '400;src:url(' + ORIGIN + '/font-weight.png)'],
    ['style', 'italic;src:url(' + ORIGIN + '/font-style.png)'],
  ] as const) {
    const hostile = oneElementDoc(image(PNG_RED), {
      assets: { face: FRAUNCES_900 },
      fonts: [{ family: 'ProbeFraunces', asset: 'face', [field]: value }],
    })
    const guarded = await withOpSpy(async (spy) => ({
      res: await exportThenDownload(hostile.doc, hostile.slide.id,
        { scope: 'current', format: 'png', scale: 1 }, { now: () => capturedAt }),
      ops: { ...spy },
    }))
    check('font — an injected ' + field + ' fails closed before render or download',
      guarded.res.code === 'resource' && guarded.ops.mounts === 0 &&
      guarded.ops.toBlob === 0 && guarded.ops.urls === 0 && guarded.ops.clicks === 0)
  }

  // The bytes pass policy inspection but cannot decode into pixels.
  const broken = await failure(() => shootIt(oneElementDoc(image(HEADLESS_PNG))))
  check('resource — a corrupt embedded PNG fails as decode [got: ' + broken.code + ']',
    broken.code === 'decode')
  check('resource — the decode failure names its one-based slide',
    broken.slideNumber === 1)

  // A tiny file that claims a gigapixel bitmap must be rejected from its
  // header, before the browser is asked to allocate it.
  const be32 = (n: number) =>
    [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  const hugePng = new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    ...be32(60000), ...be32(60000), 8, 6, 0, 0, 0, 0, 0, 0, 0,
  ])
  const huge = await failure(() =>
    shootIt(oneElementDoc(image(asDataUri('image/png', hugePng)))))
  check('resource — an embedded image declaring gigapixel dimensions is refused [got: ' +
    huge.code + ']', huge.code === 'size' || huge.code === 'resource')

  const over = oneElementDoc(image(PNG_RED))
  over.doc.size = { width: EXPORT_LIMITS.maxDimension + 1, height: 100 }
  check('limits — a deck over the browser allocation boundary is refused',
    (await failure(() => shootIt(over))).code === 'size')
}

// --- batches, cancellation, isolation ---------------------------------------

/**
 * Two slides that are VISUALLY DIFFERENT.
 *
 * The colours are the point: an archive whose entries are all the same picture
 * cannot tell "slide-01.png holds slide 1" from "slide-01.png holds whatever
 * was rendered last", and a name→content check over identical images passes
 * either way.
 */
const SLIDE_INK = ['#E23D3D', '#2C6BED', '#10B981', '#F59E0B'] as const

function twoSlideDoc(second: 'ok' | 'remote' | 'undecodable') {
  const doc: any = newDoc()
  doc.title = 'batch'
  doc.size = { width: 120, height: 120 }
  doc.assets = { pic: PNG_RED }
  doc.fonts = []
  const mk = (id: string, src: string | null, ink: string) => ({
    id, background: '#FFFFFF', transition: 'none', notes: '', elements: [
      ...(src ? [{ id: id + '-img', type: 'image', x: 0, y: 0, w: 10, h: 10, rotation: 0,
        opacity: 1, src, fit: 'fill', radius: 0 }] : []),
      { id: id + '-ink', type: 'shape', x: 20, y: 20, w: 80, h: 80, rotation: 0, opacity: 1,
        shape: 'rect', fill: ink, stroke: 'none', strokeWidth: 0, radius: 0 },
    ],
  })
  const secondSrc = second === 'remote' ? ORIGIN + '/late.png'
    : second === 'undecodable' ? HEADLESS_PNG
      : 'asset:pic'
  doc.slides = [mk('b1', 'asset:pic', SLIDE_INK[0]), mk('b2', secondSrc, SLIDE_INK[1])]
  return doc
}


const hexToRgb = (hex: string): [number, number, number] =>
  [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]

/**
 * Watch what actually leaves the tab.
 *
 * "No partial archive" is a claim about DOWNLOADS, and the only way to check it
 * is to count them. Patching the two calls downloadExportArtifact makes turns
 * that into a number.
 */
/**
 * Count the four expensive operations, from the OUTSIDE.
 *
 * "It returned a size error" does not prove nothing was allocated: the error
 * could have arrived after a parse, a decode and an encode. Wrapping the native
 * entry points is the only way to assert an EARLY refusal without putting test
 * hooks into product code — and every wrapper is restored in a finally block,
 * because leaving DOMParser patched would quietly poison every later check.
 * (No backticks: this lives inside the probe's template literal.)
 */
async function withOpSpy<T>(
  run: (spy: {
    domParse: number; decode: number; toBlob: number
    mounts: number; urls: number; clicks: number
  }) => Promise<T>,
): Promise<T> {
  const spy = { domParse: 0, decode: 0, toBlob: 0, mounts: 0, urls: 0, clicks: 0 }
  const realParse = DOMParser.prototype.parseFromString
  const realBitmap = (globalThis as any).createImageBitmap
  const realToBlob = HTMLCanvasElement.prototype.toBlob
  const realAppend = document.body.appendChild
  const realCreateUrl = URL.createObjectURL
  const realAnchorClick = HTMLAnchorElement.prototype.click

  // The offscreen export host, counted where it is actually MOUNTED. "No
  // encode" is weaker evidence than "no mount": a refusal that still built and
  // attached a render has already done the expensive, fetch-capable part.
  ;(document.body as any).appendChild = function (node: any) {
    if (node && node.nodeType === 1 && node.getAttribute &&
      node.getAttribute('aria-hidden') === 'true' &&
      (node.getAttribute('style') || '').indexOf('-99999px') >= 0) {
      spy.mounts++
    }
    return realAppend.call(document.body, node)
  }
  URL.createObjectURL = function (blob: any) { spy.urls++; return realCreateUrl.call(URL, blob) }
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (this.download) { spy.clicks++; return }
    return realAnchorClick.call(this)
  }

  DOMParser.prototype.parseFromString = function (this: DOMParser, ...args: any[]) {
    spy.domParse++
    return (realParse as any).apply(this, args)
  } as any
  ;(globalThis as any).createImageBitmap = function (...args: any[]) {
    spy.decode++
    return (realBitmap as any).apply(globalThis, args)
  }
  HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, ...args: any[]) {
    spy.toBlob++
    return (realToBlob as any).apply(this, args)
  } as any

  try {
    return await run(spy)
  } finally {
    DOMParser.prototype.parseFromString = realParse
    ;(globalThis as any).createImageBitmap = realBitmap
    HTMLCanvasElement.prototype.toBlob = realToBlob
    // deleting the OWN property restores the prototype method underneath
    delete (document.body as any).appendChild
    URL.createObjectURL = realCreateUrl
    HTMLAnchorElement.prototype.click = realAnchorClick
  }
}

/**
 * Export, and download only if it SUCCEEDED.
 *
 * Without this, "zero downloads" would be true of any code path that simply
 * never calls downloadExportArtifact — including a passing export. Routing the
 * success case through a real download makes the zero meaningful.
 */
async function exportThenDownload(
  doc: any, currentId: string, options: any, hooks: any,
): Promise<{ code: string; message: string; slideNumber?: number }> {
  const res = await failure(async () => {
    const artifact = await exportSlideImages(doc, currentId, options, hooks)
    downloadExportArtifact(artifact)
  })
  return res
}

function withDownloadSpy<T>(run: (spy: { urls: number; clicks: number }) => Promise<T>): Promise<T> {
  const realCreate = URL.createObjectURL
  const realClick = HTMLAnchorElement.prototype.click
  const spy = { urls: 0, clicks: 0 }
  // BOTH halves are counted, and asserted separately. A download is an object
  // URL AND a click; counting only one of them would pass a change that minted
  // a URL for every slide, or one that clicked an anchor with no blob behind it.
  URL.createObjectURL = function (blob: any) { spy.urls++; return realCreate.call(URL, blob) }
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    // Only OUR download anchors are intercepted; anything else clicks normally.
    if (this.download) { spy.clicks++; return }
    return realClick.call(this)
  }
  const restore = () => {
    URL.createObjectURL = realCreate
    HTMLAnchorElement.prototype.click = realClick
  }
  return run(spy).finally(restore)
}

async function batchSection(_canvas: HTMLCanvasElement, capturedAt: Date) {
  const now = () => capturedAt

  // A real two-slide archive, decoded independently back to pixels.
  const doc = twoSlideDoc('ok')
  const artifact = await exportSlideImages(doc, 'b1',
    { scope: 'all-main', format: 'png', scale: 1 }, { now })
  const entries = readZipEntries(new Uint8Array(await artifact.blob.arrayBuffer()))
  check('batch — all-main returns one ZIP artifact',
    artifact.filename === 'batch-slides.zip' && artifact.blob.type === 'application/zip')
  check('batch — entries are named in document order',
    entries.map((entry) => entry.name).join(',') === 'slide-01.png,slide-02.png')
  let matched = 0
  for (let i = 0; i < entries.length; i++) {
    const px = await pixelsOf(new Blob([entries[i].data]))
    const [r, g, b] = hexToRgb(SLIDE_INK[i])
    if (px.width === 120 && px.height === 120 &&
      near(at(px, 60, 60), r, g, b, 10)) matched++
  }
  check('batch — each ZIP entry contains the pixels its name claims',
    matched === 2 && entries.length === 2)

  await withDownloadSpy(async (spy) => {
    downloadExportArtifact(artifact)
    check('batch — a successful archive is downloaded exactly once',
      spy.urls === 1 && spy.clicks === 1)
    const urlsBefore = spy.urls
    const clicksBefore = spy.clicks

    // Force a genuine mid-batch failure after slide 1 has encoded. No partial
    // archive may cross the download seam.
    const first = await exportSlideImages(twoSlideDoc('ok'), 'b1',
      { scope: 'current', format: 'png', scale: 1 }, { now })
    let progressed = 0
    const atomic = await failure(() => exportSlideImages(twoSlideDoc('ok'), 'b1',
      { scope: 'all-main', format: 'png', scale: 1 },
      {
        now,
        onProgress: () => { progressed++ },
        budgets: { ...EXPORT_BUDGETS, maxEncodedBatchBytes: first.blob.size },
      }))
    check('batch — a later archive-budget failure is typed and occurs after one slide',
      atomic.code === 'archive' && progressed === 1)
    check('batch — a failed batch downloads no partial artifact',
      spy.urls === urlsBefore && spy.clicks === clicksBefore)

    // One cancellation case is enough here: abort after the first progress
    // callback and prove it never becomes a downloadable partial ZIP.
    const ac = new AbortController()
    const cancelled = await failure(() => exportSlideImages(twoSlideDoc('ok'), 'b1',
      { scope: 'all-main', format: 'png', scale: 1 },
      { now, signal: ac.signal, onProgress: () => ac.abort() }))
    check('batch — cancellation between slides is typed',
      cancelled.code === 'cancelled')
    check('batch — cancellation downloads nothing',
      spy.urls === urlsBefore && spy.clicks === clicksBefore)
  })

  // Re-check the selected slide immediately before mounting it. A collab edit
  // after preflight must be caught without rendering or downloading slide 2.
  const changing = twoSlideDoc('ok')
  let mutated = false
  const toctou = await withOpSpy(async (spy) => {
    const res = await exportThenDownload(changing, 'b1',
      { scope: 'all-main', format: 'png', scale: 1 },
      {
        now,
        onProgress: () => {
          if (mutated) return
          mutated = true
          changing.slides[1].elements[0].src = ORIGIN + '/toctou.png'
        },
      })
    return { res, ops: { ...spy } }
  })
  check('batch — a slide changed after preflight is refused and names slide 2',
    mutated && toctou.res.code === 'resource' && toctou.res.slideNumber === 2)
  check('batch — TOCTOU refusal happens before slide 2 renders',
    toctou.ops.mounts === 1 && toctou.ops.toBlob === 1)
  check('batch — TOCTOU refusal downloads nothing',
    toctou.ops.urls === 0 && toctou.ops.clicks === 0)
}

// --- the export dialog ------------------------------------------------------
//
// The dialog is DOM and accessibility and nothing else — it does not read the
// store, render a slide, build an archive or download anything. So it is
// driven here directly, with a stub for the work, which is the only way to
// exercise its state machine without a whole editor around it.

const tick = (n = 2) => new Promise<void>((resolve) => {
  let left = n
  const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step))
  requestAnimationFrame(step)
})

const dlgOf = () => document.querySelector('dialog.ed-image-export') as HTMLDialogElement | null
const pick = <T extends HTMLElement>(sel: string) =>
  dlgOf()?.querySelector(sel) as T | null

const clickIn = (sel: string) => {
  const el = pick<HTMLElement>(sel)
  if (el) el.click()
  return !!el
}

async function dialogSection() {
  const opener = document.createElement('button')
  opener.textContent = 'Save'
  document.body.appendChild(opener)

  const openIt = (
    run: (options: any, controller: any, signal: AbortSignal) => Promise<void>,
  ) => {
    promptSlideImageExport({
      mainSlideCount: 3,
      encrypted: false,
      returnFocusTo: opener,
    }, run)
  }

  // Running state: controls lock, progress is announced, and cancellation
  // aborts once while the dialog remains until work winds down.
  {
    let aborts = 0
    let release: (() => void) | null = null
    let controllerRef: any = null
    openIt(async (_options, controller, signal) => {
      controllerRef = controller
      signal.addEventListener('abort', () => { aborts++ })
      await new Promise<void>((resolve) => { release = resolve })
    })
    await tick()
    clickIn('.ed-image-export-run')
    await tick(3)

    const controlsDisabled = Array.from(
      dlgOf()?.querySelectorAll('input, select') ?? [],
    ).every((el) => (el as HTMLInputElement).disabled)
    const status = pick<HTMLElement>('.ed-image-export-status')
    check('dialog — running disables choices and exposes a polite live region',
      controlsDisabled && status?.getAttribute('aria-live') === 'polite')

    controllerRef?.setProgress({ completed: 1, total: 3, slideNumber: 2 })
    await tick()
    check('dialog — progress reaches the live region',
      (status?.textContent ?? '').includes('1') &&
      (status?.textContent ?? '').includes('3'))

    clickIn('.ed-image-export-cancel')
    clickIn('.ed-image-export-cancel')
    await tick()
    check('dialog — repeated Cancel while running aborts exactly once',
      aborts === 1)
    check('dialog — cancelling keeps the dialog visible until work settles',
      !!dlgOf())

    release?.()
    await tick(3)
    controllerRef?.close()
    await tick()
    check('dialog — settled cancelled work can close the dialog',
      !dlgOf())
  }

  // Error state: the message remains readable and controls become usable for
  // a retry.
  {
    openIt(async (_options, controller) => {
      controller.showError('Slide 2 would fetch something.')
    })
    await tick()
    clickIn('.ed-image-export-run')
    await tick(4)

    const status = pick<HTMLElement>('.ed-image-export-status')
    const controlsEnabled = Array.from(
      dlgOf()?.querySelectorAll('input, select') ?? [],
    ).every((el) => !(el as HTMLInputElement).disabled)
    check('dialog — an error stays open with its message',
      !!dlgOf() && (status?.textContent ?? '').includes('Slide 2'))
    check('dialog — an error re-enables choices for retry',
      controlsEnabled)
    clickIn('.ed-image-export-cancel')
    await tick()
  }

  // Cancellation race: an ordinary error may win after the abort event. The
  // Cancel button must recover from its transient "Cancelling…" state.
  {
    let release: (() => void) | null = null
    openIt(async (_options, controller, signal) => {
      signal.addEventListener('abort', () => {
        setTimeout(() => controller.showError('Cancel raced with an error.'), 0)
      })
      await new Promise<void>((resolve) => { release = resolve })
    })
    await tick()
    clickIn('.ed-image-export-run')
    await tick(3)
    clickIn('.ed-image-export-cancel')
    await tick(3)

    const cancel = pick<HTMLButtonElement>('.ed-image-export-cancel')
    check('dialog — a cancel/error race re-enables Cancel',
      !!cancel && !cancel.disabled)
    check('dialog — a cancel/error race restores the button label',
      /cancel/i.test(cancel?.textContent ?? ''))

    release?.()
    await tick()
    clickIn('.ed-image-export-cancel')
    await tick()
  }

  check('dialog — no modal node is left behind',
    !dlgOf())
  opener.remove()
}

main().then(() => {
  check('the probe ran to the end', true)
}).catch((err) => {
  check('the probe ran to the end (it threw: ' + String(err) + ')', false)
}).then(() => {
  // a visible table, so the emitted fixture is readable by a human
  const table = document.createElement('table')
  table.setAttribute('style', 'font:13px ui-monospace,Menlo,monospace;border-collapse:collapse;margin:16px 0')
  for (const r of results) {
    const tr = document.createElement('tr')
    const a = document.createElement('td')
    a.textContent = r[1] ? 'PASS' : 'FAIL'
    a.setAttribute('style', 'padding:2px 10px;color:' + (r[1] ? '#0a7d33' : '#c0271d') + ';font-weight:700')
    const b = document.createElement('td')
    b.textContent = r[0]
    b.setAttribute('style', 'padding:2px 10px')
    tr.appendChild(a); tr.appendChild(b); table.appendChild(tr)
  }
  const head = document.createElement('h1')
  head.setAttribute('style', 'font:600 18px system-ui;margin:0 0 4px')
  const bad = results.filter((r) => !r[1]).length
  head.textContent = 'bento slide image export probe — ' + (results.length - bad) + '/' + results.length + ' passed'
  const meta = document.createElement('pre')
  meta.setAttribute('style', 'font:12px ui-monospace,Menlo,monospace;white-space:pre-wrap;color:#334')
  meta.textContent = notes.join('\\n')
  const host = document.createElement('div')
  host.setAttribute('style', 'position:relative;z-index:2;background:#fff;color:#111;padding:20px;font:14px system-ui')
  host.appendChild(head); host.appendChild(meta); host.appendChild(table)

  const json = document.createElement('textarea')
  json.setAttribute('style', 'width:100%;height:120px;font:11px ui-monospace,monospace')
  json.value = JSON.stringify({ ua: navigator.userAgent, results, notes }, null, 1)
  host.appendChild(json)
  document.body.appendChild(host)

  // The parent polls for this: the load event fires long before the raster
  // work finishes, so there is nothing useful to read at load time.
  ;(window as any).__bentoResults = { results, notes }
})
`

// ---------------------------------------------------------------------------
// The fixture and the runner
// ---------------------------------------------------------------------------

function buildFixture(tmp: string, origin: string): string {
  const entry = path.join(tmp, 'probe.ts')
  fs.writeFileSync(entry, probeSource(
    repoFile('slides/src/image-export.ts'),
    repoFile('slides/src/model.ts'),
    repoFile('slides/src/fontdata.ts'),
    repoFile('slides/src/editor/image-export-dialog.ts'),
    origin,
  ))
  execFileSync(repoFile('slides/node_modules/.bin/esbuild'), [
    entry, '--bundle', '--format=esm', '--target=es2022', '--outfile=' + path.join(tmp, 'probe.js'),
  ], { stdio: 'pipe' })
  const bundle = fs.readFileSync(path.join(tmp, 'probe.js'), 'utf8')
  const styles = fs.readFileSync(repoFile('slides/src/styles.css'), 'utf8')

  // Never a literal script-close in a source file (AGENTS.md #1) — built by
  // concatenation, the same habit the shell builders keep.
  return '<!doctype html><meta charset="utf-8">' +
    '<title>bento slide image export probe</title>' +
    '<sty' + 'le data-bento-app-style>' + styles + '</sty' + 'le>' +
    '<body style="margin:0;background:#f6f7f9">' +
    '<scr' + 'ipt type="module">' + bundle + '</scr' + 'ipt>' +
    '</body>'
}

/** Every remote reference in the fixture. Unresolvable on purpose: nothing may
 *  be answered, and the question is only ever whether it was ASKED. */
const PROBE_ORIGIN = 'http://bento-probe.invalid'

// --- the smallest CDP client that answers this question ---------------------

type Cdp = {
  send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>
  on: (method: string, fn: (params: any) => void) => void
  close: () => void
}

async function connectCdp(url: string): Promise<Cdp> {
  const ws = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('cdp socket failed: ' + url)), { once: true })
  })
  let seq = 0
  type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  const pending = new Map<number, Pending>()
  const listeners = new Map<string, Array<(p: any) => void>>()

  /**
   * Settle a request exactly once, and ALWAYS clear its timeout.
   *
   * An uncleared timer is not a leak of memory, it is a leak of LIVENESS: node
   * keeps the event loop alive while one is armed, so the rig printed its final
   * "checks passed" line and then sat there for the remainder of the longest
   * outstanding timeout. Every exit path from a request goes through here.
   */
  const settle = (id: number, err: Error | null, value?: unknown) => {
    const slot = pending.get(id)
    if (!slot) return
    pending.delete(id)
    clearTimeout(slot.timer)
    if (err) slot.reject(err)
    else slot.resolve(value)
  }

  ws.addEventListener('message', (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data))
    if (msg.id !== undefined) {
      if (msg.error) settle(msg.id, new Error(String(msg.method) + ': ' + JSON.stringify(msg.error)))
      else settle(msg.id, null, msg.result)
      return
    }
    for (const fn of listeners.get(msg.method) ?? []) fn(msg.params)
  })

  const abandonAll = (why: string) => {
    for (const id of Array.from(pending.keys())) settle(id, new Error(why))
  }
  // A socket that dies must not leave an awaited request hanging on a timer.
  ws.addEventListener('close', () => abandonAll('cdp socket closed'), { once: true })

  return {
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++seq
      const timer = setTimeout(() => settle(id, new Error('cdp timeout: ' + method)), 60_000)
      pending.set(id, { resolve, reject, timer })
      try {
        ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
      } catch (err) {
        settle(id, err instanceof Error ? err : new Error(String(err)))
      }
    }),
    on: (method, fn) => {
      const list = listeners.get(method) ?? []
      list.push(fn)
      listeners.set(method, list)
    },
    close: () => {
      // Timers first: closing the socket is asynchronous, and anything still
      // armed would hold the process open past the last check.
      abandonAll('cdp connection closed')
      ws.close()
    },
  }
}

async function runBrowserSection(chrome: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-imgexport-'))
  const profile = path.join(tmp, 'profile')
  const fixture = buildFixture(tmp, PROBE_ORIGIN)
  const file = emitAt ?? path.join(tmp, 'probe.html')
  fs.writeFileSync(file, fixture)
  if (emitAt) console.log(`  ↳ fixture written to ${emitAt} (open it directly through file:// in another browser)`)

  const child = spawn(chrome, [
    '--headless=new', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] })

  const requests: string[] = []
  let cdp: Cdp | null = null
  const waitForExit = (timeoutMs: number) => new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return }
    const onExit = () => finish(true)
    const finish = (exited: boolean) => {
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(exited)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })
  try {
    // DevToolsActivePort is written once the browser is listening.
    const portFile = path.join(profile, 'DevToolsActivePort')
    const deadline = Date.now() + 30_000
    while (!fs.existsSync(portFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    if (!fs.existsSync(portFile)) throw new Error('chrome never published a devtools port')
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim()

    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as
      { webSocketDebuggerUrl: string; Browser: string }
    console.log(`  browser: ${version.Browser}`)
    cdp = await connectCdp(version.webSocketDebuggerUrl)

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })

    cdp.on('Network.requestWillBeSent', (p) => { if (p?.request?.url) requests.push(p.request.url) })
    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Page.navigate', { url: 'file://' + file }, sessionId)

    // The load event fires long before the raster work ends, so poll for the
    // finished object rather than trusting a lifecycle event.
    let parsed: { results: Array<[string, boolean]>; notes: string[] } | null = null
    const stop = Date.now() + 240_000
    while (Date.now() < stop) {
      await new Promise((r) => setTimeout(r, 250))
      const res = await cdp.send('Runtime.evaluate', {
        expression: 'window.__bentoResults ? JSON.stringify(window.__bentoResults) : null',
        returnByValue: true,
      }, sessionId)
      const value = res?.result?.value
      if (typeof value === 'string') { parsed = JSON.parse(value); break }
    }

    if (!parsed) {
      const dumped = path.join(os.tmpdir(), 'bento-imgexport-dump.html')
      const dom = await cdp.send('Runtime.evaluate', {
        expression: 'document.documentElement.outerHTML', returnByValue: true,
      }, sessionId).catch(() => null)
      fs.writeFileSync(dumped, String(dom?.result?.value ?? '(no dom)'))
      ok(false, `the browser probe reported results (it did not — dumped DOM in ${dumped})`)
    } else {
      for (const line of parsed.notes) console.log(`  · ${line}`)
      for (const [name, pass] of parsed.results) ok(pass, name)
    }

    // data: URLs surface as requests too, and the serialized outer SVG quotes
    // every remote href inside itself — matching on the raw string would report
    // the export's own payload as a fetch.
    const offDoc = requests.filter((u) => u.startsWith(PROBE_ORIGIN))
    const distinct = Array.from(new Set(offDoc.map((u) => u.slice(PROBE_ORIGIN.length)))).sort()
    console.log(`  · off-document requests observed: ${distinct.join(', ') || '(none)'}`)
    const asked = (suffix: string) => requests.some((u) => u.endsWith(suffix))
    // The control first: without it, every claim below is unfalsifiable.
    const control = asked('/positive-control.png')
    ok(control, 'the request log can see a subresource request from a file:// page (positive control)')
    if (control) {
      const representativeThreats = [
        '/remote-video.mp4',
        '/sanitized-css.png',
        '/foreign-object.png',
        '/remote-image.png',
        '/svg-href.png',
        '/svg-xlink.png',
        '/shadowed-xlink.png',
        '/shadowed-href.png',
        '/escaped-css.png',
        '/font-weight.png',
        '/font-style.png',
        '/toctou.png',
      ]
      ok(representativeThreats.every((suffix) => !asked(suffix)),
        'media, href, xlink:href, CSS, foreignObject and TOCTOU threats make zero requests')
      ok(distinct.length === 1 && distinct[0] === '/positive-control.png',
        `the export path asked for NOTHING off this document (distinct: ${distinct.join(', ') || 'none'})`)
    } else {
      ok(false, 'zero-request assertions are VOID — the positive control never reached the log')
    }

    // --- THE FINAL GATE: every http(s) request, compared as a FULL URL ------
    //
    // The checks above are sink-specific, and useful for saying WHICH fixture
    // leaked. This one is the security gate, and it is deliberately NOT scoped
    // to the probe origin — a request to any other host would simply never have
    // been looked at. Exactly one URL is allowed: the positive control that
    // proves the log works at all.
    const controlUrl = `${PROBE_ORIGIN}/positive-control.png`
    const httpRequests = requests.filter((u) => /^https?:/i.test(u))
    const controlHits = httpRequests.filter((u) => u === controlUrl)
    const others = httpRequests.filter((u) => u !== controlUrl)
    console.log(`  · every http(s) request this page made (${httpRequests.length}):`)
    for (const u of httpRequests) console.log(`      ${u}`)
    ok(controlHits.length === 1,
      `the positive control was requested exactly once (${controlHits.length})`)
    ok(others.length === 0,
      `and NOTHING else reached the network, at any host (${others.length ? others.join(', ') : 'nothing else'})`)
  } finally {
    // A normal CDP shutdown lets Chrome flush its temporary profile and avoids
    // macOS treating every successful test run as an application crash.
    try { await cdp?.send('Browser.close') } catch { /* already gone */ }
    cdp?.close()
    if (!await waitForExit(2_000)) child.kill('SIGTERM')
    if (!await waitForExit(2_000)) child.kill('SIGKILL')
    await waitForExit(5_000)
    const sweep = { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }
    try { fs.rmSync(emitAt ? profile : tmp, sweep) } catch (err) {
      console.log(`  ⚠ could not remove the scratch directory (harmless): ${String(err)}`)
    }
  }
}

console.log('\nslide image export — the raster path, in a browser')

if (process.env.CI && !CHROME) {
  console.error('  ✗ CI must not skip the browser section, and no Chrome was found.')
  console.error('    This is the only half that can answer "does this fetch" with a request log.')
  process.exit(1)
}

if (!CHROME) {
  console.log('  ⚠ SKIPPED — no Chrome found. Set BENTO_CHROME to a binary to run this section;')
  console.log('    it is the only half that can answer "does this rasterize" with pixels.')
  console.log('    A SKIP IS NOT A PASS.')
} else {
  await runBrowserSection(CHROME)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
