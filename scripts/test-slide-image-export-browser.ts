#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Slide image export — the BROWSER half.
//
//   node scripts/test-slide-image-export-browser.ts
//   node scripts/test-slide-image-export-browser.ts --emit-fixture /tmp/probe.html
//   node scripts/test-slide-image-export-browser.ts --characterize   (manual only)
//
// (Run directly: this parent imports only node builtins. The PROBE is bundled
// by esbuild against the repo's real image-export.ts, which is why the parent
// must not import it — it uses extensionless './model' specifiers that node's
// native type stripping will not resolve.)
//
// WHAT THIS PROVES. The probe drives the PRODUCTION exporter — it imports
// rasterizeSlideImage and exportSlideImages, not a parallel renderer of its
// own, so a green run here is evidence about shipped code and not about a
// lookalike. Every assumption the design rests on is answered with pixels or
// with a request log:
//
//   1. a data-URI outer SVG, drawn from a file:// page, rasterizes WITHOUT
//      tainting the canvas — the reason the design forbids blob: URLs, which
//      DO taint on file:// (issue #261's reporter hit exactly this);
//   2. rich text, MathML, a chart, a table, an embedded image, an author SVG's
//      markup-local <style> AND the model's separate SvgElement.css field all
//      survive the foreignObject boundary and actually paint;
//   3. an embedded @font-face reaches the raster, rather than silently
//      substituting a fallback face (font-display:swap pixels are a lie);
//   4. a stylesheet carrying a REAL CDATA terminator survives the foreignObject
//      path and still applies, and every `cursor` declaration is stripped;
//   5. an author SVG's SMIL animation resolves to the DEFINED initial frame and
//      two captures of static content are byte-identical;
//   6. blanking media src/poster BEFORE the first render stops a remote video
//      from being requested at all — detached <video> assignment fetches;
//   7. the CSS URL/@import spellings the sanitizer handles make ZERO requests,
//      and an unaudited render's remote author-SVG <image> is REJECTED before
//      the staging mount rather than fetched;
//   8. 2x is genuine supersampling, not a 1x bitmap scaled up;
//   9. JPEG paints a white matte where PNG is transparent;
//  10. malformed embedded resources fail as TYPED errors and are never
//      swallowed into a blank slide;
//  11. a batch is atomic: a later failure yields no artifact, and cancellation
//      stops it.
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
// CDP also solves completion: --dump-dom fires at the load event, which lands
// mid-rasterization (measured — the dump held a half-built staging surface).
// The parent polls the page for a finished result object instead.

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
const CHARACTERIZE = argv.includes('--characterize')

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
  exportPath: string, zipPath: string, modelPath: string, fontPath: string,
  dialogPath: string, renderPath: string, origin: string,
) => `
import { promptSlideImageExport } from ${JSON.stringify(dialogPath)}
import { renderSlide } from ${JSON.stringify(renderPath)}
import {
  DOWNLOAD_REVOKE_MS,
  EXPORT_BUDGETS,
  EXPORT_LIMITS,
  SlideImageExportError,
  assertAppCssSelfContained,
  assertNoExternalRenderedResources,
  buildExportCss,
  cssUrlTargets,
  buildSlideImageExportPlan,
  collectExportCss,
  downloadExportArtifact,
  exportSlideImages,
  rasterizeSlideImage,
} from ${JSON.stringify(exportPath)}
import { crc32 } from ${JSON.stringify(zipPath)}
import { newDoc } from ${JSON.stringify(modelPath)}
import { FRAUNCES_900 } from ${JSON.stringify(fontPath)}

const ORIGIN = ${JSON.stringify(origin)}
const CHARACTERIZE = ${CHARACTERIZE ? 'true' : 'false'}

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

/** Likewise for jpeg and webp: the browser is the encoder, so the bytes are
 *  genuinely what a real file of that type looks like. */
function makeTyped(mime: string, color: string): string {
  const c = document.createElement('canvas')
  c.width = 8; c.height = 8
  const x = c.getContext('2d')!
  x.fillStyle = color
  x.fillRect(0, 0, 8, 8)
  return c.toDataURL(mime)
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

// The 1x1 transparent GIF this repo already uses in scripts/test-sanitize.ts.
const GIF_STATIC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
// The same one-frame GIF with a non-loop application extension. 0xFF means
// application metadata, not animation by itself; only the named loop
// extensions (or a second image descriptor) make a GIF animated.
const GIF_STATIC_WITH_APP_METADATA = (() => {
  const gif = dataUriBytes(GIF_STATIC)
  const afterGlobalColourTable = 19
  const id = Array.from('XMP DataXMP', (c) => c.charCodeAt(0))
  const extension = new Uint8Array([
    0x21, 0xFF, 0x0B, ...id,
    0x03, 0x01, 0x02, 0x03, 0x00,
  ])
  const out = new Uint8Array(gif.length + extension.length)
  out.set(gif.slice(0, afterGlobalColourTable), 0)
  out.set(extension, afterGlobalColourTable)
  out.set(gif.slice(afterGlobalColourTable), afterGlobalColourTable + extension.length)
  return asDataUri('image/gif', out)
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

const sameBytes = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
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

/** The synchronous twin, for the audit functions that throw straight away. */
function failureSync(fn: () => unknown): { code: string; message: string; slideNumber?: number } {
  try {
    fn()
    return { code: '(it succeeded)', message: '' }
  } catch (err) {
    if (err instanceof SlideImageExportError) {
      return { code: err.code, message: err.message, slideNumber: err.slideNumber }
    }
    return { code: '(untyped: ' + String(err) + ')', message: String(err) }
  }
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
    // author svg: markup-local <style> paints .p, the model's css field paints .q,
    // and the <animate> would move .p off its defined initial frame.
    { id: 'p-svg', type: 'svg', x: 680, y: 170, w: 360, h: 200, rotation: 0, opacity: 1,
      markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 200">' +
        '<sty' + 'le>.p{fill:#FF5C5C}</sty' + 'le>' +
        '<rect class="p" x="0" y="0" width="180" height="200">' +
        '<animate attributeName="x" from="0" to="160" dur="0.4s" fill="freeze"/></rect>' +
        '<rect class="q" x="180" y="0" width="180" height="200"/>' +
        '</svg>',
      css: '.q{fill:#5CA8FF}' },
    // Every CSS spelling of "fetch" the sanitizer is supposed to defuse. Kept
    // on its own 1px element so a mangled sheet can never move a colour
    // assertion — the only question here is the request log.
    //
    // These are the spellings the RENDERER's own sanitizer already neutralizes
    // (it rewrites an external url() to none and refuses every @import), so
    // they reach the audit already defused and the deck still exports. The
    // escaped-url() spellings the sanitizer does NOT catch are exercised as
    // dedicated REJECTION fixtures in resourceSection — a deck carrying one is
    // supposed to be refused, so it cannot live in a fixture that must succeed.
    { id: 'p-css-hazard', type: 'svg', x: 0, y: 0, w: 1, h: 1, rotation: 0, opacity: 1,
      markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
        '<sty' + 'le>@import url("' + ORIGIN + '/svg-import.css");' +
        '@\\\\69mport "' + ORIGIN + '/svg-esc.css";' +
        '@import "' + ORIGIN + '/svg-str.css";' +
        '.r{fill:red;background:url(' + ORIGIN + '/svg-bg.png)}</sty' + 'le>' +
        '<rect class="r" width="1" height="1"/></svg>',
      css: '@import url("' + ORIGIN + '/model-import.css");.r{fill:red}' },
    // A VALID embedded cursor. It must be STRIPPED (a still image has no
    // pointer), not treated as a forbidden resource — refusing a deck over a
    // cursor would be a bug, and silently fetching one would be a worse bug.
    { id: 'p-cursor-ok', type: 'svg', x: 1, y: 0, w: 1, h: 1, rotation: 0, opacity: 1,
      markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
        '<sty' + 'le>.v{cursor:url("' + PNG_RED + '") 4 4, pointer;fill:red}</sty' + 'le>' +
        '<rect class="v" width="1" height="1"/></svg>',
      css: '.v{cursor:u\\\\72l(' + ORIGIN + '/cursor-escaped.png), crosshair}' },
    // Hostile HTML sinks smuggled inside author SVG. Everything here is either
    // dropped by the sanitizer or refused by the audit; none of it may reach
    // the network on the way to being refused.
    { id: 'p-html-sinks', type: 'svg', x: 2, y: 0, w: 1, h: 1, rotation: 0, opacity: 1,
      markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
        '<foreignObject width="1" height="1">' +
        '<img src="' + ORIGIN + '/fo-img.png"/>' +
        '<input type="image" src="' + ORIGIN + '/fo-input.png"/>' +
        '<object data="' + ORIGIN + '/fo-object.bin"></object>' +
        '<embed src="' + ORIGIN + '/fo-embed.bin"/>' +
        '<iframe src="' + ORIGIN + '/fo-iframe.html"></iframe>' +
        '<video poster="' + ORIGIN + '/fo-poster.png" src="' + ORIGIN + '/fo-video.mp4"></video>' +
        '<div style="background:u\\\\72l(' + ORIGIN + '/fo-style.png)"></div>' +
        '</foreignObject><rect width="1" height="1" fill="#333"/></svg>' },
    { id: 'p-media', type: 'media', x: 680, y: 390, w: 360, h: 200, rotation: 0, opacity: 1,
      kind: 'video', src: ORIGIN + '/remote-video.mp4', poster: 'asset:poster', fit: 'fill' },
    { id: 'p-shape', type: 'shape', x: 680, y: 610, w: 360, h: 120, rotation: 0, opacity: 1,
      shape: 'rect', fill: '#000000', stroke: '#FFFFFF', strokeWidth: 2, radius: 8,
      fillGradient: { angle: 90, stops: [{ at: 0, color: '#8B5CF6' }, { at: 1, color: '#EC4899' }] },
      shadow: { x: 0, y: 6, blur: 12, color: 'rgba(0,0,0,0.6)' } },
    { id: 'p-hover-a', type: 'shape', x: 680, y: 760, w: 160, h: 120, rotation: 0, opacity: 1,
      shape: 'rect', fill: '#10B981', stroke: 'none', strokeWidth: 0, radius: 0, showOnHover: 'set-a' },
    { id: 'p-hover-b', type: 'shape', x: 880, y: 760, w: 160, h: 120, rotation: 0, opacity: 1,
      shape: 'rect', fill: '#F43F5E', stroke: 'none', strokeWidth: 0, radius: 0, showOnHover: 'set-b' },
    // The fixture's stylesheet paints THIS box through a rule whose value
    // contains a literal CDATA terminator. If the terminator were emitted raw
    // the outer SVG would not parse at all; if it were dropped the box would
    // stay dark. Green means the whole sheet crossed the boundary intact.
    { id: 'p-cdata', type: 'text', x: 680, y: 900, w: 360, h: 60, rotation: 0, opacity: 1,
      html: 'edge ]]' + '> case', fontSize: 20, fontWeight: 400, color: '#001100',
      align: 'left', valign: 'top', lineHeight: 1.2, fontFamily: '' },
    { id: 'p-placeholder', type: 'text', x: 680, y: 960, w: 360, h: 60, rotation: 0, opacity: 1,
      html: '', placeholder: 'PLACEHOLDER MUST NOT PRINT', fontSize: 28, fontWeight: 400,
      color: '#FFFFFF', align: 'left', valign: 'top', lineHeight: 1.2, fontFamily: '' },
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
    check('4 — the fixture really carries a runtime #bento-fonts sheet to be skipped',
      !!document.getElementById('bento-fonts'))
  }

  const canvas = document.createElement('canvas')
  const capturedAt = new Date(Date.UTC(2026, 7, 15, 12, 0, 0))
  const BG = [16, 24, 32]

  // --- css hazards, before anything renders ---------------------------------
  const exportCss = collectExportCss()
  check('4 — every cursor declaration is stripped, including a cursor: url(data:image/svg+xml,...)',
    !/cursor\\s*:/i.test(exportCss) && exportCss.indexOf('svg+xml') < 0)
  check('4 — the rest of the sheet survives the strip', exportCss.indexOf('.bento-el') >= 0)
  check('4 — and the sheet really did carry a CDATA terminator to deal with',
    exportCss.indexOf(']]' + '>') >= 0)

  const { doc, slide } = fixtureDoc({ withFont: true })

  // --- 1x -------------------------------------------------------------------
  const one = await shoot(doc, slide.id, { scale: 1, format: 'png', capturedAt, canvas })
  note('serialized svg bytes @1x: ' + one.svgBytes + ' — data-uri chars: ' + one.uriBytes)
  check('1 — a file:// data-URI outer SVG rasterizes and its pixels can be read back (canvas untainted)',
    one.pixels.width === 1080)
  check('the png carries a png signature',
    one.bytes[0] === 0x89 && one.bytes[1] === 0x50 && one.bytes[2] === 0x4E && one.bytes[3] === 0x47)
  check('1080x1080 at 1x decodes to 1080x1080', one.pixels.width === 1080 && one.pixels.height === 1080)

  // --- what actually painted ------------------------------------------------
  check('2 — rich text painted', inkCount(one.pixels, 45, 40, 600, 110, BG) > 200)
  check('2 — MathML painted', inkCount(one.pixels, 45, 305, 400, 410, BG) > 100)
  check('2 — the table painted', inkCount(one.pixels, 45, 445, 630, 615, BG) > 500)
  check('2 — the chart painted', inkCount(one.pixels, 45, 655, 630, 1020, BG) > 500)
  check('2 — the embedded image painted its own red', near(at(one.pixels, 740, 90), 226, 61, 61, 10))
  check('2 — the author SVG markup-local <style> painted .p', near(at(one.pixels, 760, 270), 255, 92, 92, 12))
  check("2 — the model's separate SvgElement.css painted .q", near(at(one.pixels, 950, 270), 92, 168, 255, 12))
  check('2 — a gradient shape painted', inkCount(one.pixels, 690, 620, 1030, 720, BG) > 5000)
  check('5 — media rendered its embedded poster, not a live control',
    near(at(one.pixels, 860, 490), 34, 197, 94, 12))
  check('the default hover-reveal set is visible', near(at(one.pixels, 760, 820), 16, 185, 129, 12))
  check('a non-default hover set does not paint', near(at(one.pixels, 960, 820), BG[0], BG[1], BG[2], 12))
  check('an empty placeholder does not print', inkCount(one.pixels, 690, 965, 1030, 1020, BG) < 40)

  // --- 4: a real CDATA terminator, all the way through the raster -----------
  check('4 — a stylesheet rule whose VALUE contains "]]" + ">" crossed the foreignObject boundary and applied',
    near(at(one.pixels, 860, 930), 0, 255, 102, 12))

  // --- 5: the defined initial frame, twice ----------------------------------
  const again = await shoot(doc, slide.id, { scale: 1, format: 'png', capturedAt, canvas })
  check('5 — two captures of static content are byte-identical', sameBytes(one.bytes, again.bytes))
  check('5 — the SMIL animation resolved to its defined initial frame (x=0, not 160)',
    near(at(one.pixels, 700, 270), 255, 92, 92, 12) && !near(at(one.pixels, 1030, 270), 255, 92, 92, 12))

  // --- 3: the embedded font -------------------------------------------------
  const fallback = fixtureDoc({ withFont: false })
  const noFont = await shoot(fallback.doc, fallback.slide.id, { scale: 1, format: 'png', capturedAt, canvas })
  const inkWith = inkCount(one.pixels, 40, 130, 660, 285, BG)
  const inkWithout = inkCount(noFont.pixels, 40, 130, 660, 285, BG)
  note('font ink: embedded=' + inkWith + ' fallback=' + inkWithout)
  check('3 — the embedded face reached the raster (its glyph geometry differs from the fallback)',
    inkWith > 0 && inkWithout > 0 && Math.abs(inkWith - inkWithout) / Math.max(inkWith, inkWithout) > 0.06)

  // --- 8: 2x is real supersampling ------------------------------------------
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
  note('8 — hairline band: ' + differing + '/' + total + ' pixels differ from a nearest-upscaled 1x')
  check('8 — 2x carries additional samples rather than a scaled-up 1x bitmap',
    total > 0 && differing / total > 0.01)
  check('the one-device-pixel diagonal actually painted at 1x',
    inkCount(one.pixels, 41, 1036, 1039, 1074, BG) > 400)

  // --- 9: jpeg, and its white matte -----------------------------------------
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
    check('9 — a transparent slide background really is transparent in PNG (alpha 0)',
      cornerPng[3] === 0)
    check('9 — and the SAME pixel is WHITE in JPEG: the matte is painted, not left as black',
      near(cornerJpg, 255, 255, 255, 3) && cornerJpg[3] === 255)
    check('9 — while opaque content is unchanged by the matte',
      near(at(tPng.pixels, 100, 100), 226, 61, 61, 6) && near(at(tJpg.pixels, 100, 100), 226, 61, 61, 8))
  }

  note('canvas proven: 1080x1080 @1x and 2160x2160 @2x, both drawn, read back and encoded')
  note('limits in force: maxDimension=' + EXPORT_LIMITS.maxDimension + ' maxPixels=' + EXPORT_LIMITS.maxPixels)

  await resourceSection(canvas, capturedAt)
  await batchSection(canvas, capturedAt)
  await dialogSection()
  if (CHARACTERIZE) await characterize(canvas, capturedAt)

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

  // --- accepted: every whitelisted static format ---------------------------
  const accepted: Array<[string, string]> = [
    ['an embedded png', PNG_RED],
    ['an embedded jpeg', makeTyped('image/jpeg', '#3355FF')],
    ['a static gif', GIF_STATIC],
    ['a static gif with non-loop application metadata', GIF_STATIC_WITH_APP_METADATA],
  ]
  const webp = makeTyped('image/webp', '#33FF55')
  if (webp.startsWith('data:image/webp')) accepted.push(['a static webp', webp])
  else note('this browser did not encode webp; that acceptance case did not run')

  for (const [label, uri] of accepted) {
    const f = oneElementDoc(image(uri))
    const res = await failure(() => shootIt(f))
    check('resource — ' + label + ' is accepted', res.code === '(it succeeded)')
  }
  {
    const f = oneElementDoc(image('asset:pic'), { assets: { pic: PNG_RED } })
    const res = await failure(() => shootIt(f))
    check('resource — an asset: reference resolving to a whitelisted image is accepted',
      res.code === '(it succeeded)')
  }

  // --- rejected: schemes ----------------------------------------------------
  const badSrc: Array<[string, string]> = [
    ['http', ORIGIN + '/pic.png'],
    ['https', 'https://example.invalid/pic.png'],
    ['a relative path', 'pic.png'],
    ['file:', 'file:///etc/pic.png'],
    ['blob:', 'blob:null/0000-0000'],
    ['a missing asset', 'asset:nope'],
    ['data:image/svg+xml', 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['an empty src', ''],
  ]
  for (const [label, src] of badSrc) {
    const f = oneElementDoc(image(src))
    const res = await failure(() => shootIt(f))
    check('resource — ' + label + ' is rejected as a typed resource error', res.code === 'resource')
    if (label === 'a missing asset') {
      check('resource — and the error names the ONE-BASED source slide position', res.slideNumber === 1)
    }
  }

  // --- rejected: animated and unsupported containers ------------------------
  for (const [label, uri] of animatedAndExotic()) {
    const f = oneElementDoc(image(uri))
    const res = await failure(() => shootIt(f))
    check('resource — ' + label + ' is rejected before render', res.code === 'resource')
  }

  // --- rejected: mime that disagrees with the bytes -------------------------
  {
    const jpegBytes = dataUriBytes(makeTyped('image/jpeg', '#112233'))
    const f = oneElementDoc(image(asDataUri('image/png', jpegBytes)))
    const res = await failure(() => shootIt(f))
    check('resource — a data URI declaring png while carrying jpeg bytes is rejected', res.code === 'resource')
  }

  // --- posters follow the same rule ----------------------------------------
  {
    const media = (poster: string) =>
      ({ id: 'r-media', type: 'media', x: 20, y: 20, w: 160, h: 160, rotation: 0, opacity: 1,
        kind: 'video', src: ORIGIN + '/clip.mp4', poster, fit: 'fill' })
    const good = await failure(() => shootIt(oneElementDoc(media(PNG_POSTER))))
    check('resource — an embedded poster is accepted', good.code === '(it succeeded)')
    const bad = await failure(() => shootIt(oneElementDoc(media(ORIGIN + '/poster.png'))))
    check('resource — a remote poster is rejected', bad.code === 'resource')
    // and the case that must NOT fail: a remote clip with no poster at all
    const chip = await failure(() => shootIt(oneElementDoc(
      { id: 'r-media', type: 'media', x: 20, y: 20, w: 160, h: 160, rotation: 0, opacity: 1,
        kind: 'video', src: ORIGIN + '/no-poster.mp4', fit: 'fill' })))
    check('resource — a remote clip with NO poster exports as the static chip, making no request',
      chip.code === '(it succeeded)')
  }

  // --- rendered MODEL sinks that actually survive the renderer --------------
  //
  // Each of these is a place the renderer copies a model string straight into
  // something the browser will fetch from: renderSlide assigns
  // surface.style.background from slide.background, and shapeSvg calls
  // setAttribute for fill and stroke from el.fill with no filtering at all.
  // So each fixture is a real sink, not a hypothetical one.
  // (No backticks anywhere in here: this comment lives inside the probe's own
  // template literal, and one would end it.)
  //
  // image-set("…") is the P0: it fetches with no url() anywhere in the value,
  // so a scanner that looks for url( waves it straight through.
  {
    const bg = (background: string) => {
      const f = oneElementDoc({ id: 'r-box', type: 'shape', x: 10, y: 10, w: 50, h: 50,
        rotation: 0, opacity: 1, shape: 'rect', fill: '#333', stroke: 'none', strokeWidth: 0, radius: 0 })
      f.slide.background = background
      return f
    }
    const paint = (fill: string) =>
      oneElementDoc({ id: 'r-paint', type: 'shape', x: 10, y: 10, w: 50, h: 50, rotation: 0,
        opacity: 1, shape: 'rect', fill, stroke: 'none', strokeWidth: 0, radius: 0 })

    const sinks: Array<[string, { doc: any; slide: any }]> = [
      ['a slide background using url()', bg('url(' + ORIGIN + '/bg-url.png)')],
      ['a slide background using image-set("…")',
        bg('image-set("' + ORIGIN + '/bg-imageset.png" 1x)')],
      ['a slide background using -webkit-image-set("…")',
        bg('-webkit-image-set("' + ORIGIN + '/bg-webkit.png" 1x)')],
      ['a shape fill naming an external paint server',
        paint('url(' + ORIGIN + '/paint.svg#g)')],
      ['a line stroke naming one (lines take their colour from fill)',
        oneElementDoc({ id: 'r-line', type: 'shape', x: 10, y: 10, w: 50, h: 2, rotation: 0,
          opacity: 1, shape: 'line', fill: 'url(' + ORIGIN + '/stroke.svg#g)', stroke: 'none',
          strokeWidth: 2, radius: 0 })],
      ['SvgElement.css using image-set("…")',
        oneElementDoc({ id: 'r-svgcss', type: 'svg', x: 10, y: 10, w: 50, h: 50, rotation: 0,
          opacity: 1,
          markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
            '<rect class="z" width="1" height="1"/></svg>',
          css: '.z{background:image-set("' + ORIGIN + '/svgcss-imageset.png" 1x)}' })],
      ['an author SVG style block using image-set("…")',
        oneElementDoc({ id: 'r-svgmarkup', type: 'svg', x: 10, y: 10, w: 50, h: 50, rotation: 0,
          opacity: 1,
          markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
            '<sty' + 'le>.z{background:image-set("' + ORIGIN + '/svgmarkup-imageset.png" 1x)}</sty' + 'le>' +
            '<rect class="z" width="1" height="1"/></svg>' })],
    ]
    for (const [label, f] of sinks) {
      const res = await failure(() => shootIt(f))
      check('1 — ' + label + ' is refused before mount [got: ' + res.code + ']',
        res.code === 'resource')
    }
  }

  // --- author svg references ------------------------------------------------
  const svgEl = (markup: string, css?: string) =>
    ({ id: 'r-svg', type: 'svg', x: 20, y: 20, w: 160, h: 160, rotation: 0, opacity: 1, markup, ...(css ? { css } : {}) })

  // --- the escaped url() spellings, which the renderer's sanitizer does NOT
  // catch (its rewrite matches the literal "url(") and the export audit must.
  {
    // NB: every backslash below is doubled twice over — once for this template
    // literal, once for the JS string it becomes in the probe. A single pair
    // would leave "\\72" in the probe's source, which is a LEGACY OCTAL escape
    // and a hard syntax error in a module.
    const cases: Array<[string, string, string?]> = [
      ['u\\\\72l() in an author SVG style block',
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
        '<sty' + 'le>.s{background:u\\\\72l(' + ORIGIN + '/escaped-url.png)}</sty' + 'le>' +
        '<rect class="s" width="1" height="1"/></svg>'],
      ['\\\\75rl(), escaped on the first character',
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
        '<sty' + 'le>.t{background:\\\\75rl(' + ORIGIN + '/escaped-first.png)}</sty' + 'le>' +
        '<rect class="t" width="1" height="1"/></svg>'],
      ['u\\\\72l() in the model own SvgElement.css field',
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
        '<rect class="u" width="1" height="1"/></svg>',
        '.u{background:u\\\\72l(' + ORIGIN + '/model-escaped-url.png)}'],
    ]
    for (const [label, markup, css] of cases) {
      const res = await failure(() => shootIt(oneElementDoc(svgEl(markup, css))))
      check('1 — ' + label + ' is refused as a typed resource error [got: ' + res.code + ']',
        res.code === 'resource')
    }
  }

  {
    const remoteImage = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<image href="' + ORIGIN + '/svg-image.png" width="10" height="10"/></svg>'
    const res = await failure(() => shootIt(oneElementDoc(svgEl(remoteImage))))
    check("7 — an author SVG's remote <image> is REJECTED before the staging mount", res.code === 'resource')

    const xlink = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">' +
      '<image xlink:href="' + ORIGIN + '/svg-xlink.png" width="10" height="10"/></svg>'
    check("7 — and so is the xlink:href spelling of it",
      (await failure(() => shootIt(oneElementDoc(svgEl(xlink))))).code === 'resource')

    const feImage = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<filter id="f"><feImage href="' + ORIGIN + '/fe-image.png"/></filter>' +
      '<rect width="10" height="10" filter="url(#f)"/></svg>'
    check('7 — a remote <feImage> is rejected too',
      (await failure(() => shootIt(oneElementDoc(svgEl(feImage))))).code === 'resource')

    const nestedSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<image href="data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg"/>') +
      '" width="10" height="10"/></svg>'
    check('7 — a NESTED data:image/svg+xml inside author SVG is rejected, not recursively trusted',
      (await failure(() => shootIt(oneElementDoc(svgEl(nestedSvg))))).code === 'resource')

    const localOnly = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>' +
      '<a href="https://example.com/x"><rect width="10" height="10" fill="url(#g)"/></a></svg>'
    check('7 — url(#…) paint and an ordinary hyperlink are NOT pixel resources and are allowed',
      (await failure(() => shootIt(oneElementDoc(svgEl(localOnly))))).code === '(it succeeded)')

    const embedded = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<image href="' + PNG_RED + '" width="10" height="10"/></svg>'
    check('7 — an embedded, signature-checked <image> inside author SVG is allowed',
      (await failure(() => shootIt(oneElementDoc(svgEl(embedded))))).code === '(it succeeded)')

    // BOTH attributes, examined INDEPENDENTLY.
    //
    // Reading href with a ?? fallback to xlink:href reads only ONE of them: an
    // href that is PRESENT but empty is the string "", not null, so the ??
    // never falls through and the xlink:href beside it is never looked at. The
    // renderer, meanwhile, falls back to xlink:href precisely because the href
    // is invalid — so the one attribute nobody checked is the one that fetches.
    // (No backticks in this comment: it lives inside the probe template.)
    const bothCases: Array<[string, string, string]> = [
      ['an empty href beside a remote xlink:href',
        '<image href="" xlink:href="' + ORIGIN + '/both-empty.png" width="10" height="10"/>',
        '/both-empty.png'],
      ['a whitespace href beside a remote xlink:href',
        '<image href="   " xlink:href="' + ORIGIN + '/both-space.png" width="10" height="10"/>',
        '/both-space.png'],
      ['a local-fragment href beside a remote xlink:href',
        '<image href="#nope" xlink:href="' + ORIGIN + '/both-frag.png" width="10" height="10"/>',
        '/both-frag.png'],
      ['an embedded href beside a remote xlink:href',
        '<image href="' + PNG_RED + '" xlink:href="' + ORIGIN + '/both-data.png" width="10" height="10"/>',
        '/both-data.png'],
      ['a remote href beside an embedded xlink:href',
        '<image href="' + ORIGIN + '/both-first.png" xlink:href="' + PNG_RED + '" width="10" height="10"/>',
        '/both-first.png'],
      ['both attributes on a feImage',
        '<filter id="fb"><feImage href="" xlink:href="' + ORIGIN + '/both-fe.png"/></filter>' +
        '<rect width="10" height="10" filter="url(#fb)"/>',
        '/both-fe.png'],
    ]
    for (const [label, inner, _asked] of bothCases) {
      const markup = '<svg xmlns="http://www.w3.org/2000/svg" ' +
        'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">' + inner + '</svg>'
      const res = await failure(() => shootIt(oneElementDoc(svgEl(markup))))
      check('1 — ' + label + ' is refused before mount [got: ' + res.code + ']',
        res.code === 'resource')
    }
    // The control: both attributes embedded and valid must still export, or
    // "refused" above would only mean "has two attributes".
    const bothGood = '<svg xmlns="http://www.w3.org/2000/svg" ' +
      'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">' +
      '<image href="' + PNG_RED + '" xlink:href="' + PNG_POSTER + '" width="10" height="10"/></svg>'
    check('1 — while two EMBEDDED references on one element still export [got: ' +
      (await failure(() => shootIt(oneElementDoc(svgEl(bothGood))))).code + ']',
      (await failure(() => shootIt(oneElementDoc(svgEl(bothGood))))).code === '(it succeeded)')

    // A referenced drawing asset that disappeared must not become a plausible
    // blank export. Prove the refusal happens before every render/download
    // boundary, and keep an inline empty drawing distinct from an absent key.
    const missingDrawing = oneElementDoc({
      ...svgEl('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      asset: 'missing-drawing',
      markup: undefined,
    })
    const missingOut = await withOpSpy(async (spy) => {
      const res = await exportThenDownload(missingDrawing.doc, missingDrawing.slide.id,
        { scope: 'current', format: 'png', scale: 1 }, { now: () => capturedAt })
      return { res, ops: { ...spy } }
    })
    check('1 — a missing SvgElement.asset is a typed resource refusal',
      missingOut.res.code === 'resource')
    check('1 — the missing drawing names its one-based slide',
      missingOut.res.slideNumber === 1)
    check('1 — the missing drawing is refused before parse, mount, decode, encode or download',
      missingOut.ops.domParse === 0 && missingOut.ops.mounts === 0 &&
      missingOut.ops.decode === 0 && missingOut.ops.toBlob === 0 &&
      missingOut.ops.urls === 0 && missingOut.ops.clicks === 0)
  }

  // --- fonts ----------------------------------------------------------------
  {
    const withFonts = (fonts: any[], assets: any) =>
      oneElementDoc(image(PNG_RED), { fonts, assets: { pic: PNG_RED, ...assets } })

    check('resource — a declared font whose asset is missing is rejected',
      (await failure(() => shootIt(withFonts([{ family: 'X', asset: 'gone' }], {})))).code === 'resource')
    check('resource — a declared font whose asset is not a font is rejected',
      (await failure(() => shootIt(withFonts([{ family: 'X', asset: 'notafont' }], { notafont: PNG_RED })))).code === 'resource')
    check('resource — a declared font pointing at a remote URL is rejected',
      (await failure(() => shootIt(withFonts([{ family: 'X', asset: 'remote' }], { remote: ORIGIN + '/f.woff2' })))).code === 'resource')
    // the conservative all-declared contract: this face is never used by any
    // element, and it is still rejected
    check('resource — an UNUSED but invalid declared font is rejected too (all-declared contract)',
      (await failure(() => shootIt(withFonts([{ family: 'NeverUsed', asset: 'gone' }], {})))).code === 'resource')
    check('resource — a real embedded woff2 is accepted',
      (await failure(() => shootIt(withFonts([{ family: 'ProbeFraunces', asset: 'f' }], { f: FRAUNCES_900 })))).code === '(it succeeded)')

    // --- malicious font descriptor regression tests -------------------------
    // font.weight and font.style are document-controlled. Invalid present
    // values now throw a typed 'resource' error (fail closed) instead of
    // silently falling back to 'normal'. undefined/null still default to
    // 'normal' (the CSS initial value).
    const descCss = (fonts: any[]) => {
      const d = withFonts(fonts, { f: FRAUNCES_900 })
      return buildExportCss(d.doc)
    }
    const descFails = (fonts: any[]) => {
      try { descCss(fonts); return false } catch (e: any) { return e?.code === 'resource' }
    }
    // injection via weight — must throw, not fall back
    check('font — a CSS-injection weight throws resource (fail closed)',
      descFails([{ family: 'ProbeFraunces', asset: 'f', weight: '400}*{color:red}@font-face{font-family:x;src:url(http://evil.invalid/f);font-weight:' }]))
    // injection via style — must throw, not fall back
    check('font — a CSS-injection style throws resource (fail closed)',
      descFails([{ family: 'ProbeFraunces', asset: 'f', style: 'italic;font-display:swap}*{background:url(http://evil.invalid/x)' }]))
    // absurd length — must throw
    check('font — a 100-char weight throws resource',
      descFails([{ family: 'ProbeFraunces', asset: 'f', weight: 'A'.repeat(100) }]))
    // valid values pass through
    const validCss = descCss([{ family: 'ProbeFraunces', asset: 'f', weight: '900', style: 'italic' }])
    check('font — weight 900 passes validation', validCss.includes('font-weight:900'))
    check('font — style italic passes validation', validCss.includes('font-style:italic'))
    // VALID RANGES: the starter deck and build scripts use '100 900' and '400 700'
    const range900 = descCss([{ family: 'ProbeFraunces', asset: 'f', weight: '100 900' }])
    check('font — weight range "100 900" passes validation (variable font)',
      range900.includes('font-weight:100 900'))
    const range700 = descCss([{ family: 'ProbeFraunces', asset: 'f', weight: '400 700' }])
    check('font — weight range "400 700" passes validation (variable font)',
      range700.includes('font-weight:400 700'))
    // numeric boundary: 0 is out, 1000 is in, 1001 is out — all throw
    check('font — weight 0 throws resource', descFails([{ family: 'ProbeFraunces', asset: 'f', weight: '0' }]))
    const thousand = descCss([{ family: 'ProbeFraunces', asset: 'f', weight: '1000' }])
    check('font — weight 1000 is accepted', thousand.includes('font-weight:1000'))
    check('font — weight 1001 throws resource', descFails([{ family: 'ProbeFraunces', asset: 'f', weight: '1001' }]))
    // range order: reversed is invalid
    check('font — weight range "900 100" (reversed) throws resource',
      descFails([{ family: 'ProbeFraunces', asset: 'f', weight: '900 100' }]))
    // bolder/lighter are invalid @font-face descriptors
    check('font — bolder throws resource (not valid in @font-face)',
      descFails([{ family: 'ProbeFraunces', asset: 'f', weight: 'bolder' }]))
    check('font — lighter throws resource (not valid in @font-face)',
      descFails([{ family: 'ProbeFraunces', asset: 'f', weight: 'lighter' }]))
    // three space-separated values are invalid
    check('font — three-value weight "100 400 700" throws resource',
      descFails([{ family: 'ProbeFraunces', asset: 'f', weight: '100 400 700' }]))
    // undefined defaults to normal (not an error)
    const defaultCss = descCss([{ family: 'ProbeFraunces', asset: 'f' }])
    check('font — undefined weight defaults to normal', defaultCss.includes('font-weight:normal'))
    check('font — undefined style defaults to normal', defaultCss.includes('font-style:normal'))
    // invalid style also throws
    check('font — style "oblique;injection" throws resource',
      descFails([{ family: 'ProbeFraunces', asset: 'f', style: 'oblique;injection' }]))

    const guardedFont = withFonts([{
      family: 'ProbeFraunces', asset: 'f', weight: '400;src:url(http://evil.invalid/font)',
    }], { f: FRAUNCES_900 })
    const guardedOut = await withOpSpy(async (spy) => {
      const res = await exportThenDownload(guardedFont.doc, guardedFont.slide.id,
        { scope: 'current', format: 'png', scale: 1 }, { now: () => capturedAt })
      return { res, ops: { ...spy } }
    })
    check('font — an invalid descriptor fails through the public export path as resource',
      guardedOut.res.code === 'resource')
    check('font — descriptor injection is refused before mount, encode or download',
      guardedOut.ops.mounts === 0 && guardedOut.ops.toBlob === 0 &&
      guardedOut.ops.urls === 0 && guardedOut.ops.clicks === 0)
  }

  // --- 10: malformed bytes fail as DECODE, and are never swallowed ----------
  {
    const res = await failure(() => shootIt(oneElementDoc(image(HEADLESS_PNG))))
    check('10 — an embedded png with a valid header and NO image data fails as a typed decode ' +
      'error, not silently [got: ' + res.code + ']', res.code === 'decode')
    check('10 — and the decode error names the source slide', res.slideNumber === 1)

    const garbage = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4, 5, 6])
    const res2 = await failure(() => shootIt(oneElementDoc(image(asDataUri('image/png', garbage)))))
    check('10 — png-signed garbage fails as a typed error rather than a blank export [got: ' +
      res2.code + ']', res2.code === 'decode' || res2.code === 'resource')
  }

  // --- intrinsic image size, refused from the HEADER -----------------------
  //
  // Each fixture is a few dozen bytes that CLAIM enormous dimensions. Handing
  // one to the DOM is a multi-gigabyte decode request; refusing it costs
  // nothing, and proving that costs nothing either.
  {
    const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
    const hugePng = new Uint8Array([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
      ...be32(60000), ...be32(60000), 8, 6, 0, 0, 0, 0, 0, 0, 0,
    ])
    const hugeGif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0,
    ])
    for (const [label, mime, bytes] of [
      ['png', 'image/png', hugePng],
      ['gif', 'image/gif', hugeGif],
    ] as const) {
      const res = await failure(() => shootIt(oneElementDoc(image(asDataUri(mime, bytes as Uint8Array)))))
      check('2 — a ' + (bytes as Uint8Array).length + '-byte ' + label + ' header declaring a ' +
        'gigapixel image is refused before any DOM image exists [got: ' + res.code + ']',
        res.code === 'size' || res.code === 'resource')
    }
    // THE LONG-THIN BOMB: 1 x 16,000,000 is only 16 megapixels, so a pixel-count
    // guard alone lets it through — and then something allocates a sixteen-
    // million-row bitmap. Still a 33-byte file.
    const thinPng = new Uint8Array([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
      ...be32(1), ...be32(16000000), 8, 6, 0, 0, 0, 0, 0, 0, 0,
    ])
    const thinRes = await failure(() => shootIt(oneElementDoc(image(asDataUri('image/png', thinPng)))))
    check('2 — a 1 x 16,000,000 png is refused even though its PIXEL COUNT is under budget ' +
      '[got: ' + thinRes.code + ']', thinRes.code === 'size' || thinRes.code === 'resource')

    // parity: a poster is an image and gets the identical treatment
    const posterRes = await failure(() => shootIt(oneElementDoc(
      { id: 'r-media', type: 'media', x: 20, y: 20, w: 160, h: 160, rotation: 0, opacity: 1,
        kind: 'video', src: ORIGIN + '/clip.mp4', poster: asDataUri('image/png', hugePng), fit: 'fill' })))
    check('2 — and a video POSTER declaring the same gigapixel size is refused identically [got: ' +
      posterRes.code + ']', posterRes.code === 'size' || posterRes.code === 'resource')
    const thinPoster = await failure(() => shootIt(oneElementDoc(
      { id: 'r-media', type: 'media', x: 20, y: 20, w: 160, h: 160, rotation: 0, opacity: 1,
        kind: 'video', src: ORIGIN + '/clip.mp4', poster: asDataUri('image/png', thinPng), fit: 'fill' })))
    check('2 — poster parity holds for the long-thin case too [got: ' + thinPoster.code + ']',
      thinPoster.code === 'size' || thinPoster.code === 'resource')
  }

  // --- 3. signature-valid but CORRUPT must fail loudly ---------------------
  //
  // These all pass every policy check — right magic, right MIME, a sane
  // declared size, not animated — and none of them can produce pixels. The
  // failure mode being guarded against is the quiet one: an export that hands
  // back a slide with a hole where the picture was, or text in a substituted
  // face, and says nothing. A refusal the user can read is the only honest
  // outcome, because they cannot see what they did not get.
  {
    const corruptFont = (() => {
      // wOF2 magic, then garbage. Passes isFontBytes; no parser will load it.
      const bytes = new Uint8Array(64)
      bytes.set([0x77, 0x4F, 0x46, 0x32], 0)
      for (let i = 4; i < bytes.length; i++) bytes[i] = (i * 37) & 0xFF
      return asDataUri('font/woff2', bytes)
    })()

    const cases: Array<[string, () => { doc: any; slide: any }]> = [
      ['a corrupt image inside an author SVG', () => oneElementDoc(
        { id: 'c-svg', type: 'svg', x: 10, y: 10, w: 50, h: 50, rotation: 0, opacity: 1,
          markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
            '<image href="' + HEADLESS_PNG + '" width="10" height="10"/></svg>' })],
      ['a corrupt image behind a feImage', () => oneElementDoc(
        { id: 'c-fe', type: 'svg', x: 10, y: 10, w: 50, h: 50, rotation: 0, opacity: 1,
          markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
            '<filter id="cf"><feImage href="' + HEADLESS_PNG + '"/></filter>' +
            '<rect width="10" height="10" filter="url(#cf)"/></svg>' })],
      ['a corrupt image in SvgElement.css', () => oneElementDoc(
        { id: 'c-css', type: 'svg', x: 10, y: 10, w: 50, h: 50, rotation: 0, opacity: 1,
          markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
            '<rect class="z" width="10" height="10"/></svg>',
          css: '.z{background:url(' + HEADLESS_PNG + ')}' })],
      ['a corrupt declared font', () => oneElementDoc(image(PNG_RED),
        { fonts: [{ family: 'CorruptFace', asset: 'bad' }], assets: { pic: PNG_RED, bad: corruptFont } })],
    ]
    for (const [label, make] of cases) {
      const res = await failure(() => shootIt(make()))
      check('3 — ' + label + ' fails as a typed decode error rather than rendering ' +
        'blank or substituting [got: ' + res.code + ']', res.code === 'decode')
    }

    // A corrupt POSTER, and a MIXED element where one reference is sound and
    // the other is not — the case a first-match check would call fine.
    {
      const poster = await failure(() => shootIt(oneElementDoc(
        { id: 'c-poster', type: 'media', x: 10, y: 10, w: 50, h: 50, rotation: 0, opacity: 1,
          kind: 'video', src: ORIGIN + '/clip.mp4', poster: HEADLESS_PNG, fit: 'fill' })))
      check('3 — a corrupt video poster fails as a typed decode error [got: ' + poster.code + ']',
        poster.code === 'decode')

      const mixed = await failure(() => shootIt(oneElementDoc(
        { id: 'c-mix', type: 'svg', x: 10, y: 10, w: 50, h: 50, rotation: 0, opacity: 1,
          markup: '<svg xmlns="http://www.w3.org/2000/svg" ' +
            'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">' +
            '<image href="' + PNG_RED + '" xlink:href="' + HEADLESS_PNG + '" ' +
            'width="10" height="10"/></svg>' })))
      check('3 — a sound href beside a CORRUPT xlink:href still fails [got: ' + mixed.code + ']',
        mixed.code === 'decode')

      const mixedOther = await failure(() => shootIt(oneElementDoc(
        { id: 'c-mix2', type: 'svg', x: 10, y: 10, w: 50, h: 50, rotation: 0, opacity: 1,
          markup: '<svg xmlns="http://www.w3.org/2000/svg" ' +
            'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">' +
            '<image href="' + HEADLESS_PNG + '" xlink:href="' + PNG_RED + '" ' +
            'width="10" height="10"/></svg>' })))
      check('3 — and so does a corrupt href beside a sound xlink:href [got: ' +
        mixedOther.code + ']', mixedOther.code === 'decode')
    }

    // The controls. Sound versions of the same three shapes must still export,
    // or "decode" above would only mean "this shape is refused".
    const sound: Array<[string, () => { doc: any; slide: any }]> = [
      ['a sound image inside an author SVG', () => oneElementDoc(
        { id: 's-svg', type: 'svg', x: 10, y: 10, w: 50, h: 50, rotation: 0, opacity: 1,
          markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
            '<image href="' + PNG_RED + '" width="10" height="10"/></svg>' })],
      ['a sound image in SvgElement.css', () => oneElementDoc(
        { id: 's-css', type: 'svg', x: 10, y: 10, w: 50, h: 50, rotation: 0, opacity: 1,
          markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
            '<rect class="z" width="10" height="10"/></svg>',
          css: '.z{background:url(' + PNG_RED + ')}' })],
      ['a sound declared font', () => oneElementDoc(image(PNG_RED),
        { fonts: [{ family: 'ProbeFraunces', asset: 'good' }], assets: { pic: PNG_RED, good: FRAUNCES_900 } })],
    ]
    for (const [label, make] of sound) {
      const res = await failure(() => shootIt(make()))
      check('3 — while ' + label + ' still exports [got: ' + res.code + ']',
        res.code === '(it succeeded)')
    }
  }

  // --- 2/3. an early refusal must refuse EARLY ------------------------------
  //
  // The counters are the point. A size error that arrives after the markup was
  // parsed, the payloads decoded and a canvas encoded is a size error that did
  // not save anyone anything — and it looks identical from the outside.
  {
    const pics = ['#E23D3D', '#2C6BED', '#10B981', '#F59E0B', '#8B5CF6'].map((c) => makePng(c, 8, 8))

    // FIVE DISTINCT 8x8 images, reached through author-SVG inline and paint
    // surfaces rather than image elements: 5 x 64 = 320 pixels against a budget
    // of 200. It must be refused for its SIZE, before anything decodes.
    const fiveDoc = () => {
      const f = oneElementDoc({
        id: 'five', type: 'svg', x: 10, y: 10, w: 100, h: 100, rotation: 0, opacity: 1,
        markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
          '<image href="' + pics[0] + '" width="2" height="2"/>' +
          '<rect width="2" height="2" style="background:url(' + pics[1] + ')"/>' +
          '<rect width="2" height="2" fill="url(' + pics[2] + ')"/>' +
          '<sty' + 'le>.p{background:url(' + pics[3] + ')}</sty' + 'le>' +
          '<rect class="p" width="2" height="2"/></svg>',
        css: '.q{background:url(' + pics[4] + ')}',
      })
      return f
    }
    const five = await withOpSpy(async (spy) => {
      const res = await failure(() => shoot(fiveDoc().doc, 'r-slide',
        { scale: 1, format: 'png', capturedAt, canvas,
          budgets: { ...EXPORT_BUDGETS, maxSlideImagePixels: 200 } }))
      return { res, spy: { ...spy } }
    })
    check('3 — five DISTINCT 8x8 images reached through author-SVG inline, paint and ' +
      'stylesheet surfaces are pooled per slide and refused for SIZE [got: ' + five.res.code + ']',
      five.res.code === 'size')
    check('3 — and nothing was encoded to discover that (toBlob ' + five.spy.toBlob + ')',
      five.spy.toBlob === 0)

    // AGGREGATE URI LENGTH is answered before any decode at all.
    const aggregate = await withOpSpy(async (spy) => {
      const res = await failure(() => shoot(fiveDoc().doc, 'r-slide',
        { scale: 1, format: 'png', capturedAt, canvas,
          budgets: { ...EXPORT_BUDGETS, maxTotalResourceUriChars: 64 } }))
      return { res, spy: { ...spy } }
    })
    check('2 — the aggregate URI budget refuses before a single payload is decoded [got: ' +
      aggregate.res.code + ', decodes ' + aggregate.spy.decode + ']',
      aggregate.res.code === 'size' && aggregate.spy.decode === 0)
    check('2 — and before anything is encoded (toBlob ' + aggregate.spy.toBlob + ')',
      aggregate.spy.toBlob === 0)

    // RAW LENGTH is answered before the markup is even parsed. A first pure
    // pass over the strings, then parsing in a second pass — so a pathological
    // drawing never reaches DOMParser at all.
    const rawLength = await withOpSpy(async (spy) => {
      const res = await failure(() => shoot(fiveDoc().doc, 'r-slide',
        { scale: 1, format: 'png', capturedAt, canvas,
          budgets: { ...EXPORT_BUDGETS, maxAuthorMarkupChars: 32 } }))
      return { res, spy: { ...spy } }
    })
    check('2 — an over-long drawing is refused for size [got: ' + rawLength.res.code + ']',
      rawLength.res.code === 'size')
    check('2 — WITHOUT being handed to DOMParser (parses ' + rawLength.spy.domParse + ')',
      rawLength.spy.domParse === 0)

    // The control: the same deck under real budgets exports, and does decode.
    const control = await withOpSpy(async (spy) => {
      const res = await failure(() => shoot(fiveDoc().doc, 'r-slide',
        { scale: 1, format: 'png', capturedAt, canvas }))
      return { res, spy: { ...spy } }
    })
    check('2 — while the same deck under real budgets exports [got: ' + control.res.code + ']',
      control.res.code === '(it succeeded)')
    check('2 — having parsed and decoded and encoded (parses ' + control.spy.domParse +
      ', decodes ' + control.spy.decode + ', toBlob ' + control.spy.toBlob + ') — so the ' +
      'zero-counts above are real', control.spy.domParse > 0 && control.spy.toBlob > 0)
  }

  // --- 1. the marker SHORTHAND is a url() sink too --------------------------
  //
  // marker="url(...)" is a real presentation attribute that sets marker-start,
  // -mid and -end at once. Checking only the three long forms left it
  // unguarded — and it is a paint reference, so it fetches.
  // (No backticks: this comment lives inside the probe's template literal.)
  {
    const markerCases: Array<[string, string]> = [
      ['a remote marker shorthand',
        '<path d="M0 0 L10 10" marker="url(' + ORIGIN + '/marker-plain.svg#m)"/>'],
      ['an ESCAPED remote marker shorthand',
        '<path d="M0 0 L10 10" marker="u\\\\72l(' + ORIGIN + '/marker-escaped.svg#m)"/>'],
      ['a nested-SVG data marker shorthand',
        '<path d="M0 0 L10 10" marker="url(data:image/svg+xml;base64,' +
        btoa('<svg xmlns="http://www.w3.org/2000/svg"/>') + ')"/>'],
    ]
    for (const [label, inner] of markerCases) {
      const res = await failure(() => shootIt(oneElementDoc(
        { id: 'mk', type: 'svg', x: 10, y: 10, w: 50, h: 50, rotation: 0, opacity: 1,
          markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
            inner + '</svg>' })))
      if (label.indexOf('a remote marker') === 0) {
        // The renderer's own sanitizer already strips a PLAIN external url()
        // from a paint attribute, so the export legitimately succeeds — with
        // the marker gone. What matters is the request log, asserted below:
        // whichever layer removes it, nothing may be fetched.
        check('1 — ' + label + ' either is refused or is stripped before render [got: ' +
          res.code + ']', res.code === 'resource' || res.code === '(it succeeded)')
        continue
      }
      check('1 — ' + label + ' is refused before mount [got: ' + res.code + ']',
        res.code === 'resource')
    }
    // control: a LOCAL marker shorthand is the ordinary idiom and must pass
    const local = await failure(() => shootIt(oneElementDoc(
      { id: 'mk-ok', type: 'svg', x: 10, y: 10, w: 50, h: 50, rotation: 0, opacity: 1,
        markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
          '<defs><marker id="m"><circle r="1"/></marker></defs>' +
          '<path d="M0 0 L10 10" stroke="#000" marker="url(#m)"/></svg>' })))
    check('1 — while a same-document marker="url(#m)" still exports [got: ' + local.code + ']',
      local.code === '(it succeeded)')
  }

  // --- 2. the APP stylesheet is a different trust question -----------------
  //
  // It is compiled into the shell and no deck author can write to it, so it is
  // audited for SELF-CONTAINMENT only: no @import, no URL that is not a
  // fragment or already inline. Its own bundled data URLs are allowed as they
  // are — not whitelisted against the deck's image rules, not charged to the
  // document's budgets, not decoded. Measured: the shipped runtime stylesheet
  // carries data:image/svg+xml decorations, and holding them to the deck rule
  // refused EVERY export in the built file.
  {
    const appCss = collectExportCss()
    const inlined = cssUrlTargets(appCss).filter((u) => u.indexOf('data:') === 0)
    check('2 — the fixture app stylesheet really carries a bundled data URL (' +
      inlined.length + ')', inlined.length >= 1)

    // It must NOT consume the document's image budget, and must not decode.
    const shapeOnly = () => oneElementDoc(
      { id: 'app-css', type: 'shape', x: 10, y: 10, w: 50, h: 50, rotation: 0, opacity: 1,
        shape: 'rect', fill: '#334455', stroke: 'none', strokeWidth: 0, radius: 0 })
    // exportSlideImages, NOT the shoot() helper: shoot decodes the result to
    // read its pixels, and that harness decode would be counted here as if the
    // exporter had done it.
    const untouched = await withOpSpy(async (spy) => {
      const f = shapeOnly()
      const res = await failure(() => exportSlideImages(f.doc, f.slide.id,
        { scope: 'current', format: 'png', scale: 1 },
        { now: () => capturedAt,
          budgets: { ...EXPORT_BUDGETS, maxTotalResourceUriChars: 1, maxSlideImagePixels: 1 } }))
      return { res, ops: { ...spy } }
    })
    check('2 — a deck with NO resources of its own exports even with the document ' +
      'budgets set to one, because the app stylesheet is not charged to them [got: ' +
      untouched.res.code + ']', untouched.res.code === '(it succeeded)')
    check('2 — and nothing in the app stylesheet was decoded (decodes ' +
      untouched.ops.decode + ')', untouched.ops.decode === 0)

    // But it is still held to self-containment.
    for (const [label, css] of [
      ['an external url()', '.x{background:url(' + ORIGIN + '/app-external.png)}'],
      ['a relative url()', '.x{background:url(app-relative.png)}'],
      ['a file: url()', '.x{background:url(file:///etc/app.png)}'],
      ['a blob: url()', '.x{background:url(blob:null/0000)}'],
      ['an @import', '@import url("' + ORIGIN + '/app-import.css");'],
      ['an escaped @import', '@\\\\69mport "' + ORIGIN + '/app-esc-import.css";'],
    ] as const) {
      const res = failureSync(() => assertAppCssSelfContained(css, 1))
      check('2 — ' + label + ' in the app stylesheet is refused [got: ' + res.code + ']',
        res.code === 'resource')
    }
    check('2 — while its bundled data URLs pass untouched',
      failureSync(() => assertAppCssSelfContained(appCss, 1)).code === '(it succeeded)')
  }

  // The current editor slide is live even when "all" deliberately excludes
  // it (hidden/state slides are exportable only through "current"). Its SVG
  // <style> therefore appears in document.styleSheets, but remains AUTHOR
  // content: it must not be mistaken for the trusted app sheet and carried
  // into the selected main slides.
  {
    const f = oneElementDoc(
      { id: 'main-shape', type: 'shape', x: 20, y: 20, w: 160, h: 160,
        rotation: 0, opacity: 1, shape: 'rect', fill: '#334455',
        stroke: 'none', strokeWidth: 0, radius: 0 })
    const hidden: any = {
      ...structuredClone(f.slide),
      id: 'live-hidden-author-slide',
      hidden: true,
      elements: [{
        id: 'live-hidden-author-svg', type: 'svg', x: 0, y: 0, w: 100, h: 100,
        rotation: 0, opacity: 1,
        markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
          '<style>.bento-hidden-author-leak{' +
          'background:url("data:image/bento-unsupported;base64,AA==")}</style>' +
          '<rect width="10" height="10" fill="#fff"/></svg>',
      }],
    }
    f.doc.slides.push(hidden)
    const live = renderSlide(hidden, f.doc)
    document.body.appendChild(live)
    try {
      const authorSheetIsLive = Array.from(document.styleSheets).some((sheet) => {
        const owner = sheet.ownerNode as Node | null
        return !!owner && live.contains(owner)
      })
      check('2 — the excluded hidden slide really registered an author stylesheet in the live document',
        authorSheetIsLive)
      const plan = buildSlideImageExportPlan(
        f.doc, hidden.id, { scope: 'all-main', format: 'png', scale: 1 }, capturedAt)
      check('2 — all-main excludes that live hidden slide',
        plan.slides.length === 1 && plan.slides[0].slide.id === f.slide.id)
      check('2 — collectExportCss carries only app-owned CSS, never the excluded slide author sheet',
        !collectExportCss().includes('bento-hidden-author-leak'))
    } finally {
      live.remove()
    }
  }

  // --- 3. an image whose SIZE cannot be established is refused -------------
  //
  // Valid magic, an accepted MIME, and no determinable dimensions: the header
  // stops before the field that carries them. That used to be treated as "no
  // opinion" and charged ZERO pixels, which made the one payload nobody could
  // measure also the one the per-slide pool could not see. It must be refused,
  // and refused before anything decodes it.
  {
    // GIF magic is six bytes; the logical screen descriptor needs four more.
    const headless = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10])
    const res = await withOpSpy(async (spy) => {
      const f = oneElementDoc(image(asDataUri('image/gif', headless)))
      const out = await exportThenDownload(f.doc, f.slide.id,
        { scope: 'current', format: 'png', scale: 1 }, { now: () => capturedAt })
      return { out, ops: { ...spy } }
    })
    check('3 — an image with a valid signature but no determinable size is refused [got: ' +
      res.out.code + ']', res.out.code === 'resource')
    check('3 — with NO staging host ever mounted (mounts ' + res.ops.mounts + ')',
      res.ops.mounts === 0)
    check('3 — before createImageBitmap is ever called (decodes ' + res.ops.decode + ')',
      res.ops.decode === 0)
    check('3 — and before anything is encoded (toBlob ' + res.ops.toBlob + ')',
      res.ops.toBlob === 0)
    check('3 — and nothing was downloaded (urls ' + res.ops.urls + ', clicks ' +
      res.ops.clicks + ')', res.ops.urls === 0 && res.ops.clicks === 0)

    // The control that makes those zeros mean something: the SAME helper on a
    // sound deck mounts, encodes and downloads.
    const sound = await withOpSpy(async (spy) => {
      const f = oneElementDoc(image(PNG_RED))
      const out = await exportThenDownload(f.doc, f.slide.id,
        { scope: 'current', format: 'png', scale: 1 }, { now: () => capturedAt })
      return { out, ops: { ...spy } }
    })
    check('3 — while a sound deck through the same helper mounts, encodes and downloads ' +
      '(mounts ' + sound.ops.mounts + ', toBlob ' + sound.ops.toBlob + ', urls ' +
      sound.ops.urls + ', clicks ' + sound.ops.clicks + ')',
      sound.out.code === '(it succeeded)' && sound.ops.mounts === 1 &&
      sound.ops.toBlob === 1 && sound.ops.urls === 1 && sound.ops.clicks === 1)
  }

  // --- 3. REDISTRIBUTION past the per-slide pool ---------------------------
  //
  // Every image here is individually approved, and the original per-slide
  // aggregate saw them spread across two slides. Moving them onto ONE slide
  // after preflight is a redistribution no membership check can notice — the
  // keys are all still known. Only recomputing the pool against what the slide
  // holds NOW catches it.
  {
    const a = makePng('#E23D3D', 8, 8)
    const b = makePng('#2C6BED', 8, 8)
    const mk = (id: string, src: string) => ({
      id, background: '#FFFFFF', transition: 'none', notes: '', elements: [
        { id: id + '-i', type: 'image', x: 5, y: 5, w: 40, h: 40, rotation: 0, opacity: 1,
          src, fit: 'fill', radius: 0 },
      ],
    })
    const doc: any = newDoc()
    doc.title = 'redistribute'
    doc.size = { width: 60, height: 60 }
    doc.assets = {}
    doc.fonts = []
    doc.slides = [mk('d1', a), mk('d2', b)]

    // 64 pixels each; a pool of 100 fits either slide alone and not both.
    const budgets = { ...EXPORT_BUDGETS, maxSlideImagePixels: 100 }
    const clean = await failure(() => exportSlideImages(doc, 'd1',
      { scope: 'all-main', format: 'png', scale: 1 }, { now: () => capturedAt, budgets }))
    check('3 — one 8x8 image on each of two slides exports under a 100-pixel pool [got: ' +
      clean.code + ']', clean.code === '(it succeeded)')

    const moved: any = JSON.parse(JSON.stringify(doc))
    let mutated = false
    const res = await withOpSpy(async (spy) => {
      const out = await exportThenDownload(moved, 'd1',
        { scope: 'all-main', format: 'png', scale: 1 },
        {
          now: () => capturedAt,
          budgets,
          onProgress: () => {
            if (mutated) return
            mutated = true
            // both approved images, now on slide 2
            moved.slides[1].elements.push({
              id: 'moved-i', type: 'image', x: 5, y: 5, w: 40, h: 40, rotation: 0, opacity: 1,
              src: a, fit: 'fill', radius: 0,
            })
          },
        })
      return { out, ops: { ...spy } }
    })
    check('3 — redistributing already-approved images onto one slide is refused [got: ' +
      res.out.code + ']', res.out.code === 'size')
    check('3 — naming the slide that overflowed', res.out.slideNumber === 2)
    check('3 — the redistribution really happened', mutated)
    check('3 — exactly ONE staging host was mounted — slide 1, before the swap (mounts ' +
      res.ops.mounts + ')', res.ops.mounts === 1)
    check('3 — and exactly one encode, so slide 2 never rendered (toBlob ' +
      res.ops.toBlob + ')', res.ops.toBlob === 1)
    check('3 — the failed atomic batch downloaded NOTHING (urls ' + res.ops.urls +
      ', clicks ' + res.ops.clicks + ')', res.ops.urls === 0 && res.ops.clicks === 0)
  }

  // --- 2b. document resources still go through the inventory ----------------
  //
  // The app stylesheet is exempt (above). Everything the DOCUMENT owns is not,
  // and the fail-closed membership rule is what the audit runs on.
  {
    // A four-slide SHAPE-ONLY batch owns no resources at all, so the only
    // decodes possible would be the app stylesheet's — and there must be none.
    const once = await withOpSpy(async (spy) => {
      await exportSlideImages(fourSlideDoc(), 'q1',
        { scope: 'all-main', format: 'png', scale: 1 }, { now: () => capturedAt })
      return { ...spy }
    })
    note('four shape-only slides: ' + once.decode + ' resource decodes, ' + once.toBlob + ' encodes')
    check('2 — a shape-only batch decodes NOTHING: the app stylesheet is not the ' +
      "document's to decode (decodes " + once.decode + ')', once.decode === 0)
    check('2 — while still encoding every slide (toBlob ' + once.toBlob + ')', once.toBlob === 4)

    // FAIL CLOSED: the audit accepts a data URI only because the inventory says
    // so. Given an empty inventory, a perfectly valid embedded image is still
    // refused — and the audit reaches that answer without parsing it.
    const host = document.createElement('div')
    const img = document.createElement('img')
    img.setAttribute('src', PNG_RED)
    host.appendChild(img)
    const closed = await withOpSpy(async (spy) => {
      const res = failureSync(() =>
        assertNoExternalRenderedResources(host, '', 4, EXPORT_BUDGETS, new Set()))
      return { res, ops: { ...spy } }
    })
    check('2 — a data URI the inventory does not know is refused, not re-validated [got: ' +
      closed.res.code + ']', closed.res.code === 'resource')
    check('2 — and the audit decoded nothing to decide that (decodes ' + closed.ops.decode + ')',
      closed.ops.decode === 0)
  }

  // --- size guards, before allocation --------------------------------------
  {
    const f = oneElementDoc(image(PNG_RED))
    f.doc.size = { width: EXPORT_LIMITS.maxDimension + 1, height: 100 }
    check('limits — a deck one pixel over the accepted boundary is refused BEFORE allocation',
      (await failure(() => shootIt(f))).code === 'size')

    const g = oneElementDoc(image(PNG_RED))
    g.doc.size = { width: 100.5, height: 100 }
    check('limits — a fractional deck size is refused', (await failure(() => shootIt(g))).code === 'size')

    // The deck size is refused before the images are even looked at: a deck
    // that cannot be allocated should not spend time decoding its pictures.
    const h = oneElementDoc(image(asDataUri('image/png', new Uint8Array([1, 2, 3]))))
    h.doc.size = { width: EXPORT_LIMITS.maxDimension + 1, height: 100 }
    const order = await failure(() => shootIt(h))
    check('limits — deck size is checked BEFORE resource decoding, so an oversized deck ' +
      'reports its size and not its images [got: ' + order.code + ']', order.code === 'size')
  }

  // --- the boundary the product promises, exercised for real ---------------
  //
  // 4000x4000 @1x is the stretch case the plan names and it really has to work:
  // 16.0 of the 16.7 megapixels the budget allows. The refusal case has to be
  // genuinely OVER that budget — 4000x4001 is still inside it — so the one-over
  // fixture is 4096x4097, which is 4096 pixels past the cap.
  {
    // The success is checked through the returned BLOB, not by reading back 16
    // megapixels of ImageData: createImageBitmap gives the decoded dimensions
    // for a few bytes of bookkeeping, and pulling 64 MB into a typed array to
    // learn the same thing would be the allocation this whole section is about.
    const f = oneElementDoc(image(PNG_RED))
    f.doc.size = { width: 4000, height: 4000 }
    const big = buildSlideImageExportPlan(f.doc, f.slide.id,
      { scope: 'current', format: 'png', scale: 1 }, capturedAt)
    let blob: Blob | null = null
    const res = await failure(async () => {
      blob = await rasterizeSlideImage({
        doc: f.doc, plannedSlide: big.slides[0], format: 'png', scale: 1,
        capturedAt, cssText: buildExportCss(f.doc), canvas,
      })
    })
    check('limits — 4000x4000 at 1x, the boundary this app promises, really exports [got: ' +
      res.code + ']', res.code === '(it succeeded)')
    if (blob) {
      const bmp = await createImageBitmap(blob)
      const dims = [bmp.width, bmp.height]
      bmp.close()
      note('4000x4000 @1x decoded back as ' + dims[0] + 'x' + dims[1])
      check('limits — and it decodes back at the full 4000x4000',
        dims[0] === 4000 && dims[1] === 4000)
    } else {
      check('limits — and it decodes back at the full 4000x4000 (no blob was produced)', false)
    }

    // Genuinely over: 4096x4097 is 4096 pixels past the 4096-squared cap.
    // 4000x4001 would NOT be — it is still inside the budget.
    const over = oneElementDoc(image(PNG_RED))
    over.doc.size = { width: 4096, height: 4097 }
    const overRes = await failure(() => shootIt(over))
    check('limits — a deck genuinely over the pixel budget is refused [got: ' + overRes.code + ']',
      overRes.code === 'size')
    check('limits — and the refusal names the size rather than the browser',
      overRes.message.indexOf('4096') >= 0 && overRes.message.indexOf('browser') < 0)
  }

  // --- the budgets a caller can inject, hitting real production guards -----
  //
  // Each of these drives the SHIPPED code path with a budget set to a few
  // bytes, so the guard fires without anything large ever existing.
  {
    const tiny = (over: any) => ({ ...EXPORT_BUDGETS, ...over })
    const cases: Array<[string, any]> = [
      ['per-resource URI characters', { maxResourceUriChars: 32 }],
      ['total URI characters', { maxTotalResourceUriChars: 32 }],
      ['decoded resource bytes', { maxDecodedResourceBytes: 8 }],
      ['per-slide intrinsic pixels', { maxSlideImagePixels: 4 }],
      ['serialized SVG bytes', { maxSerializedBytes: 64 }],
      ['encoded data-URI characters', { maxDataUriChars: 64 }],
    ]
    for (const [label, over] of cases) {
      const f = oneElementDoc(image(PNG_RED))
      const res = await failure(() => shoot(f.doc, f.slide.id,
        { scale: 1, format: 'png', capturedAt, canvas, budgets: tiny(over) }))
      check('4 — the ' + label + ' guard fires from an injected budget [got: ' + res.code + ']',
        res.code === 'size')
    }
    // raw author input, bounded before anything parses it
    for (const [label, el, over] of [
      ['author markup characters',
        { id: 'r-m', type: 'svg', x: 10, y: 10, w: 50, h: 50, rotation: 0, opacity: 1,
          markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>' },
        { maxAuthorMarkupChars: 16 }],
      ['author css characters',
        { id: 'r-c', type: 'svg', x: 10, y: 10, w: 50, h: 50, rotation: 0, opacity: 1,
          markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect class="z" width="1" height="1"/></svg>',
          css: '.z{fill:red;stroke:blue;stroke-width:2}' },
        { maxAuthorCssChars: 8 }],
    ] as const) {
      const f = oneElementDoc(el as any)
      const res = await failure(() => shoot(f.doc, f.slide.id,
        { scale: 1, format: 'png', capturedAt, canvas, budgets: tiny(over) }))
      check('4 — the ' + label + ' guard fires before the parser runs [got: ' + res.code + ']',
        res.code === 'size')
    }
  }

  // --- ORDER: length is answered before anything is decoded ----------------
  //
  // The payload below is deliberately BOTH over the URI-character budget and
  // malformed base64. If the size guard runs first there is nothing to decode
  // and the answer is "size"; if decoding runs first the answer is "resource"
  // or a thrown DOMException, and the guard that was supposed to prevent the
  // allocation ran after it.
  {
    const junk = 'data:image/png;base64,' + '!'.repeat(400)
    const f = oneElementDoc(image(junk))
    const res = await failure(() => shoot(f.doc, f.slide.id,
      { scale: 1, format: 'png', capturedAt, canvas,
        budgets: { ...EXPORT_BUDGETS, maxResourceUriChars: 64 } }))
    check('2 — an over-budget resource that is ALSO malformed base64 reports size, ' +
      'proving length is checked before any decode [got: ' + res.code + ']', res.code === 'size')

    // …and the control: the same malformed payload UNDER the budget must reach
    // the decoder and be refused on its merits, or the check above would pass
    // for a build that simply refused everything.
    const small = oneElementDoc(image('data:image/png;base64,' + '!'.repeat(8)))
    const smallRes = await failure(() => shootIt(small))
    check('2 — while the same malformed payload under budget is refused as a resource [got: ' +
      smallRes.code + ']', smallRes.code === 'resource')
  }

  // --- several DISTINCT images on one slide --------------------------------
  //
  // Individually legal, collectively a decode request nothing else measures.
  {
    const inks = ['#E23D3D', '#2C6BED', '#10B981', '#F59E0B', '#8B5CF6']
    const pics = inks.map((c) => makePng(c, 8, 8))
    const doc: any = newDoc()
    doc.title = 'many'
    doc.size = { width: 200, height: 200 }
    doc.assets = {}
    doc.fonts = []
    const slide: any = doc.slides[0]
    slide.id = 'many-slide'
    slide.background = '#FFFFFF'
    slide.elements = pics.map((src, i) => ({
      id: 'mi' + i, type: 'image', x: 10 + i * 30, y: 10, w: 25, h: 25, rotation: 0,
      opacity: 1, src, fit: 'fill', radius: 0,
    }))
    const okRes = await failure(() => shoot(doc, slide.id,
      { scale: 1, format: 'png', capturedAt, canvas }))
    check('3 — five DISTINCT small images on one slide export normally [got: ' + okRes.code + ']',
      okRes.code === '(it succeeded)')

    // 5 x 64 pixels = 320; a budget of 200 refuses the slide, and a budget of
    // 64 would refuse even one, so this is specifically the AGGREGATE.
    const aggregate = await failure(() => shoot(doc, slide.id,
      { scale: 1, format: 'png', capturedAt, canvas,
        budgets: { ...EXPORT_BUDGETS, maxSlideImagePixels: 200 } }))
    check('3 — but their pixels are pooled per slide, so a small budget refuses them [got: ' +
      aggregate.code + ']', aggregate.code === 'size')

    // The same image five times is ONE decode, so it must still pass.
    const repeated: any = JSON.parse(JSON.stringify(doc))
    for (const el of repeated.slides[0].elements) el.src = pics[0]
    const dedup = await failure(() => shoot(repeated, repeated.slides[0].id,
      { scale: 1, format: 'png', capturedAt, canvas,
        budgets: { ...EXPORT_BUDGETS, maxSlideImagePixels: 200 } }))
    check('3 — while the SAME image five times is one decode and still passes [got: ' +
      dedup.code + ']', dedup.code === '(it succeeded)')
  }

  // --- a mixed-case data: scheme is still a data: scheme --------------------
  {
    const mixed = 'DaTa:image/png;base64,' + PNG_RED.slice(PNG_RED.indexOf(',') + 1)
    const res = await failure(() => shootIt(oneElementDoc(image(mixed))))
    check('2 — a DaTa: scheme is recognised and accepted like any other [got: ' + res.code + ']',
      res.code === '(it succeeded)')
    const mixedRemote = oneElementDoc({ id: 'r-svgcase', type: 'svg', x: 10, y: 10, w: 50, h: 50,
      rotation: 0, opacity: 1,
      markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
        '<image href="HTTP://BENTO-PROBE.INVALID/upper.png" width="1" height="1"/></svg>' })
    const upperRes = await failure(() => shootIt(mixedRemote))
    check('2 — and an upper-case HTTP:// reference is still refused [got: ' + upperRes.code + ']',
      upperRes.code === 'resource')
  }

  // --- srcset is a LIST, and the audit is what has to know that ------------
  //
  // Driven against the production audit with a hand-built detached surface:
  // nothing the renderer emits carries srcset today, so an end-to-end fixture
  // would test the renderer's restraint rather than the audit's rule.
  {
    const surfaceWith = (attr: string, value: string) => {
      const host = document.createElement('div')
      const img = document.createElement('img')
      img.setAttribute(attr, value)
      host.appendChild(img)
      return host
    }
    const audit = (attr: string, value: string) =>
      failureSync(() => assertNoExternalRenderedResources(surfaceWith(attr, value), '', 7))

    // THE EXPLOIT SHAPE: a harmless local first candidate in front of a remote
    // second one. A check that reads the value as a single reference sees only
    // the fragment, approves it, and the browser is free to pick the other.
    const exploit = audit('srcset', '#local 1x, ' + ORIGIN + '/srcset-second.png 2x')
    check('1 — a srcset of "#local 1x, <remote> 2x" is refused [got: ' + exploit.code + ']',
      exploit.code === 'resource')
    check('1 — and the refusal carries the slide it came from', exploit.slideNumber === 7)
    const three = audit('srcset', '#local 1x, ' + PNG_RED + ' 2x, ' + ORIGIN + '/third.png 3x')
    check('1 — a three-candidate srcset with the remote one LAST is refused too [got: ' +
      three.code + ']', three.code === 'resource')

    // The control that makes the three above non-vacuous: a srcset with NO
    // remote candidate must pass, or "refused" would just mean "srcset".
    const localOnly = audit('srcset', '#local 1x, #other 2x')
    check('1 — while a srcset of local fragments only is allowed [got: ' + localOnly.code + ']',
      localOnly.code === '(it succeeded)')
    const embeddedOnly = audit('srcset', PNG_RED + ' 1x, ' + PNG_POSTER + ' 2x')
    check('1 — and so is one of embedded, signature-checked images [got: ' + embeddedOnly.code + ']',
      embeddedOnly.code === '(it succeeded)')

    // A data: URI contains the comma that separates candidates, so the split
    // has to understand candidates rather than commas. Kept as its own case:
    // it is a parsing question, not a policy one.
    const dataComma = audit('srcset', PNG_RED + ' 1x')
    check('1 — a single data: URI candidate survives the comma inside it [got: ' +
      dataComma.code + ']', dataComma.code === '(it succeeded)')
  }

  // --- input that breaks the ENCODERS, not the policy ----------------------
  //
  // encodeURIComponent throws URIError on a lone surrogate, and a lone
  // surrogate is one paste away in any text box. It must surface as a typed
  // error naming the slide, never as an uncaught URIError.
  {
    const f = oneElementDoc({ id: 'r-txt', type: 'text', x: 10, y: 10, w: 100, h: 40,
      rotation: 0, opacity: 1, html: 'lone \uD800 surrogate', fontSize: 16, fontWeight: 400,
      color: '#000000', align: 'left', valign: 'top', lineHeight: 1.2, fontFamily: '' })
    const res = await failure(() => shootIt(f))
    check('4 — a lone surrogate in slide text is a TYPED failure or a clean export, ' +
      'never an uncaught URIError [got: ' + res.code + ']',
      res.code === '(it succeeded)' || res.code === 'encode' || res.code === 'decode')
    if (res.code !== '(it succeeded)') {
      check('4 — and it names the slide it came from', res.slideNumber === 1)
    } else {
      check('4 — (it exported cleanly, so there was nothing to name)', true)
    }
  }

  // --- the export CSS carries no duplicate font faces ----------------------
  {
    const f = oneElementDoc(image(PNG_RED), { fonts: [{ family: 'ProbeFraunces', asset: 'f' }], assets: { f: FRAUNCES_900, pic: PNG_RED } })
    const css = buildExportCss(f.doc)
    const faces = (css.match(/@font-face/g) ?? []).length
    check('4 — one declared font yields exactly ONE @font-face in the export CSS ' +
      "(the runtime's #bento-fonts sheet is not carried in as well) [got: " + faces + ']',
      faces === 1)
    check('4 — and it blocks rather than swapping, so the fallback cannot be what gets painted',
      /font-display:\s*block/.test(css) && !/font-display:\s*swap/.test(css))
  }
}

/**
 * Animated and unsupported containers, built from KNOWN-GOOD bytes.
 *
 * The animated GIF is this repo's own static 1x1 GIF with its image-descriptor
 * block duplicated; the APNG is a real canvas PNG with a correctly-CRC'd acTL
 * chunk spliced in before IDAT. Building them from working files is the point:
 * a hand-typed "animated file" that no decoder accepts would prove nothing.
 */
function animatedAndExotic(): Array<[string, string]> {
  const out: Array<[string, string]> = []

  // --- animated gif: duplicate the single image block -----------------------
  {
    const g = dataUriBytes(GIF_STATIC)
    // header(6) + logical screen descriptor(7) + global colour table(2*3 = 6)
    const afterHeader = 13 + 6
    const trailer = g.length - 1                       // 0x3B
    const block = g.slice(afterHeader, trailer)        // the one image block
    const twoFrames = new Uint8Array(afterHeader + block.length * 2 + 1)
    twoFrames.set(g.slice(0, afterHeader), 0)
    twoFrames.set(block, afterHeader)
    twoFrames.set(block, afterHeader + block.length)
    twoFrames[twoFrames.length - 1] = 0x3B
    out.push(['an animated gif (two image descriptors)', asDataUri('image/gif', twoFrames)])
  }

  // --- apng: splice a real acTL chunk in front of IDAT ----------------------
  {
    const p = dataUriBytes(PNG_RED)
    let idat = -1
    for (let i = 8; i + 8 <= p.length; i++) {
      if (p[i] === 0x49 && p[i + 1] === 0x44 && p[i + 2] === 0x41 && p[i + 3] === 0x54) { idat = i - 4; break }
    }
    if (idat > 0) {
      const payload = new Uint8Array([0x61, 0x63, 0x54, 0x4C, 0, 0, 0, 2, 0, 0, 0, 0]) // "acTL", frames=2, plays=0
      const sum = crc32(payload)
      const chunk = new Uint8Array(4 + payload.length + 4)
      chunk[0] = 0; chunk[1] = 0; chunk[2] = 0; chunk[3] = 8 // payload length (without the type)
      chunk.set(payload, 4)
      chunk[16] = (sum >>> 24) & 0xFF; chunk[17] = (sum >>> 16) & 0xFF
      chunk[18] = (sum >>> 8) & 0xFF; chunk[19] = sum & 0xFF
      const apng = new Uint8Array(p.length + chunk.length)
      apng.set(p.slice(0, idat), 0)
      apng.set(chunk, idat)
      apng.set(p.slice(idat), idat + chunk.length)
      out.push(['an APNG (acTL before IDAT)', asDataUri('image/png', apng)])
    }
  }

  // --- animated webp: a RIFF whose VP8X carries the ANIM flag ---------------
  {
    const ascii = (s: string) => Array.from(s).map((c) => c.charCodeAt(0))
    const body = [
      ...ascii('WEBP'),
      ...ascii('VP8X'), 10, 0, 0, 0,
      0x02, 0, 0, 0,          // flags: bit 1 = ANIMATION
      0, 0, 0, 0, 0, 0,       // canvas size
      ...ascii('ANIM'), 6, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]
    const riff = new Uint8Array(8 + body.length)
    riff.set(ascii('RIFF'), 0)
    const size = body.length
    riff[4] = size & 0xFF; riff[5] = (size >>> 8) & 0xFF
    riff[6] = (size >>> 16) & 0xFF; riff[7] = (size >>> 24) & 0xFF
    riff.set(body, 8)
    out.push(['an animated webp (VP8X ANIM flag)', asDataUri('image/webp', riff)])
  }

  // --- containers we simply do not accept ----------------------------------
  const sig = (mime: string, bytes: number[]) => asDataUri(mime, new Uint8Array(bytes))
  out.push(['an avif', sig('image/avif', [0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])])
  out.push(['an ico', sig('image/x-icon', [0, 0, 1, 0, 1, 0, 16, 16, 0, 0])])
  out.push(['a bmp', sig('image/bmp', [0x42, 0x4D, 0, 0, 0, 0, 0, 0, 0, 0])])
  out.push(['an unknown image mime', sig('image/whatever', [1, 2, 3, 4, 5, 6, 7, 8])])
  return out
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

/** Four visually distinct slides — enough that an order bug cannot hide. */
function fourSlideDoc() {
  const doc: any = newDoc()
  doc.title = 'four'
  doc.size = { width: 120, height: 120 }
  doc.assets = {}
  doc.fonts = []
  doc.slides = SLIDE_INK.map((ink, i) => ({
    id: 'q' + (i + 1), background: '#FFFFFF', transition: 'none', notes: '', elements: [
      { id: 'q' + (i + 1) + '-ink', type: 'shape', x: 20, y: 20, w: 80, h: 80, rotation: 0,
        opacity: 1, shape: 'rect', fill: ink, stroke: 'none', strokeWidth: 0, radius: 0 },
    ],
  }))
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

  {
    const doc = twoSlideDoc('ok')
    const progress: any[] = []
    const artifact = await exportSlideImages(doc, 'b1', { scope: 'all-main', format: 'png', scale: 1 },
      { now, onProgress: (p: any) => progress.push(p) })
    check('11 — an all-main export returns ONE artifact', !!artifact.blob && artifact.filename.endsWith('.zip'))
    check('11 — named for the deck', artifact.filename === 'batch-slides.zip')
    check('11 — progress is reported once per encoded image, in order',
      progress.length === 2 && progress[0].completed === 1 && progress[1].completed === 2 &&
      progress[0].total === 2 && progress[0].slideNumber === 1 && progress[1].slideNumber === 2)
    const zipBytes = new Uint8Array(await artifact.blob.arrayBuffer())
    check('11 — and the artifact really is a zip',
      zipBytes[0] === 0x50 && zipBytes[1] === 0x4B && zipBytes[2] === 0x03 && zipBytes[3] === 0x04)

    // PK bytes only prove something zip-shaped came out. What the user actually
    // gets is the NAMES, the ORDER and the CONTENT, so read the archive the way
    // a reader does: from the central directory backwards.
    const read = readZipEntries(zipBytes)
    check('11 — the archive holds one entry per exported slide',
      read.length === 2)
    check('11 — named as contiguous ordinals, in document order',
      read.map((e) => e.name).join(',') === 'slide-01.png,slide-02.png')
    check('11 — every entry is stored (method 0), because a png is already compressed',
      read.every((e) => e.method === 0))
    check('11 — and every entry really contains a PNG',
      read.every((e) => e.data[0] === 0x89 && e.data[1] === 0x50 &&
        e.data[2] === 0x4E && e.data[3] === 0x47))
  }

  // EVERY entry, checked name against PIXELS, on slides that are visually
  // different. Four distinct colours mean a reversed or duplicated archive
  // cannot pass — which the previous single-entry check could not tell.
  {
    const doc = fourSlideDoc()
    const artifact = await exportSlideImages(doc, 'q1', { scope: 'all-main', format: 'png', scale: 1 }, { now })
    const read = readZipEntries(new Uint8Array(await artifact.blob.arrayBuffer()))
    check('11 — four slides yield four entries, named in order',
      read.map((e) => e.name).join(',') === 'slide-01.png,slide-02.png,slide-03.png,slide-04.png')
    let matched = 0
    for (let i = 0; i < read.length; i++) {
      const px = await pixelsOf(new Blob([read[i].data]))
      const [r, g, b] = hexToRgb(SLIDE_INK[i])
      if (px.width === 120 && px.height === 120 && near(at(px, 60, 60), r, g, b, 10)) matched++
    }
    check('11 — and EACH entry holds the pixels of the slide its name claims (' +
      matched + '/' + read.length + ' matched)', matched === read.length && read.length === 4)
  }

  // The timestamp is what makes an archive deterministic and what every
  // {{date}} on every slide resolves against. Once per batch, not once per
  // slide, and not once per field.
  {
    const doc = fourSlideDoc()
    let calls = 0
    await exportSlideImages(doc, 'q1', { scope: 'all-main', format: 'png', scale: 1 },
      { now: () => { calls++; return capturedAt } })
    check('11 — hooks.now is called exactly ONCE for a four-slide batch (got ' + calls + ')',
      calls === 1)
  }

  // Canvas encoders are browser APIs, so their return value is untrusted too:
  // a non-null Blob is not enough to justify a .png or .jpg filename. Drive
  // malformed MIME/signature combinations through the public export path.
  {
    const encodedFailure = async (format: 'png' | 'jpeg', blob: Blob) => {
      const real = HTMLCanvasElement.prototype.toBlob
      try {
        HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) {
          callback(blob)
        } as any
        return await failure(() => exportSlideImages(fourSlideDoc(), 'q1',
          { scope: 'current', format, scale: 1 }, { now }))
      } finally {
        HTMLCanvasElement.prototype.toBlob = real
      }
    }

    const pngSignature = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    const wrongMime = await encodedFailure('png',
      new Blob([pngSignature], { type: 'image/jpeg' }))
    check('encode — a PNG request refuses a blob with the wrong MIME [got: ' +
      wrongMime.code + ']', wrongMime.code === 'encode')

    const partialPng = await encodedFailure('png', new Blob([
      new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0]),
    ], { type: 'image/png' }))
    check('encode — a four-byte PNG prefix is not the full signature [got: ' +
      partialPng.code + ']', partialPng.code === 'encode')

    const noEoi = await encodedFailure('jpeg', new Blob([
      new Uint8Array([0xFF, 0xD8, 0xFF, 0x11, 0x22, 0x33]),
    ], { type: 'image/jpeg' }))
    check('encode — a JPEG without its EOI marker is refused [got: ' +
      noEoi.code + ']', noEoi.code === 'encode')
    check('encode — malformed encoder output keeps the source slide number',
      wrongMime.slideNumber === 1 && partialPng.slideNumber === 1 && noEoi.slideNumber === 1)
  }

  // A slide that can be refused from the MODEL is refused before anything is
  // rendered: making the user watch four slides render and then telling them
  // the fifth was never going to work is the worst of both.
  {
    const doc = twoSlideDoc('remote')
    let progressed = 0
    const res = await failure(() => exportSlideImages(doc, 'b1', { scope: 'all-main', format: 'png', scale: 1 },
      { now, onProgress: () => { progressed++ } }))
    check('11 — a batch whose SECOND slide is refusable yields no artifact', res.code === 'resource')
    check('11 — and the failure names the second slide', res.slideNumber === 2)
    check('11 — preflight refuses it before ANY slide is rendered', progressed === 0)
  }

  // A policy-legal but UNDECODABLE image on slide 2.
  //
  // This used to be discovered mid-batch, after slide 1 had rendered. It is
  // not any more, and that is an improvement rather than a regression: the
  // batch now proves every distinct payload can become pixels BEFORE it starts
  // rendering, so the deck is refused without the user watching slides go by
  // first. The genuine mid-batch case is the encoded-budget one, further down.
  {
    const doc = twoSlideDoc('undecodable')
    let progressed = 0
    const res = await failure(() => exportSlideImages(doc, 'b1', { scope: 'all-main', format: 'png', scale: 1 },
      { now, onProgress: () => { progressed++ } }))
    check('11 — a deck whose slide 2 cannot decode yields no artifact [got: ' + res.code + ']',
      res.code === 'decode')
    check('11 — it names the second slide', res.slideNumber === 2)
    check('11 — and it is caught in preflight, before ANY slide renders (progress ' +
      progressed + ')', progressed === 0)
  }

  {
    const doc = twoSlideDoc('ok')
    const ac = new AbortController()
    ac.abort()
    const res = await failure(() => exportSlideImages(doc, 'b1', { scope: 'all-main', format: 'png', scale: 1 },
      { now, signal: ac.signal }))
    check('11 — cancelling BEFORE the first slide is a typed cancellation', res.code === 'cancelled')
  }
  {
    const doc = twoSlideDoc('ok')
    const ac = new AbortController()
    const res = await failure(() => exportSlideImages(doc, 'b1', { scope: 'all-main', format: 'png', scale: 1 },
      { now, signal: ac.signal, onProgress: () => ac.abort() }))
    check('11 — cancelling BETWEEN slides stops the batch with no artifact', res.code === 'cancelled')
  }

  {
    const doc = twoSlideDoc('ok')
    doc.slides = [doc.slides[0]]
    doc.slides[0].hidden = true
    const res = await failure(() => exportSlideImages(doc, 'b1', { scope: 'all-main', format: 'png', scale: 1 }, { now }))
    check('11 — all-main with no eligible slides is a typed no-slides failure', res.code === 'no-slides')
  }

  // --- the document is read, never written ---------------------------------
  {
    const doc = twoSlideDoc('ok')
    const before = JSON.stringify(doc)
    await exportSlideImages(doc, 'b1', { scope: 'current', format: 'png', scale: 1 }, { now })
    check('11 — exporting leaves the document snapshot byte-identical', JSON.stringify(doc) === before)
  }

  // --- nothing private reaches the pixels -----------------------------------
  {
    const plain = twoSlideDoc('ok')
    const secret = twoSlideDoc('ok')
    secret.slides[0].notes = 'CONFIDENTIAL board discussion, do not share'
    secret.slides[0].comments = [{ id: 'c1', author: 'Ana', text: 'fix the number', at: '2026-08-15T00:00:00Z' }]
    secret.collab = {
      on: true, room: 'wss://relay.invalid/w-secret', key: 'SECRETROOMKEY',
      writerPub: 'PUB', writerPriv: 'PRIVATE-WRITER-KEY', ownerPriv: 'PRIVATE-OWNER-KEY',
    }
    secret.meta = { keywords: 'password hunter2' }
    const a = await exportSlideImages(plain, 'b1', { scope: 'current', format: 'png', scale: 1 }, { now })
    const b = await exportSlideImages(secret, 'b1', { scope: 'current', format: 'png', scale: 1 }, { now })
    const ab = new Uint8Array(await a.blob.arrayBuffer())
    const bb = new Uint8Array(await b.blob.arrayBuffer())
    check('11 — two decks differing only in notes/comments/collab keys export IDENTICAL pixels',
      sameBytes(ab, bb))
  }

  // --- the download seam, counted rather than assumed -----------------------
  //
  // "No partial archive" is a claim about what leaves the tab. Counting the
  // object URLs and the anchor clicks is the only way to check it; asserting
  // that a function exists is not.
  await withDownloadSpy(async (spy) => {
    check('downloadExportArtifact is a separate step, not something export does itself',
      typeof downloadExportArtifact === 'function' && spy.urls === 0 && spy.clicks === 0)

    // a success DOES download, exactly once — the control for the rest
    const good = await exportSlideImages(twoSlideDoc('ok'), 'b1',
      { scope: 'all-main', format: 'png', scale: 1 }, { now })
    check('11 — exporting on its own mints no object URL (' + spy.urls + ')', spy.urls === 0)
    downloadExportArtifact(good)
    check('11 — downloading mints exactly ONE object URL (' + spy.urls + ')', spy.urls === 1)
    check('11 — and issues exactly ONE anchor click (' + spy.clicks + ')', spy.clicks === 1)

    // A GENUINE mid-batch failure, with the budget MEASURED rather than
    // guessed: export slide 1 on its own, take that PNG's exact size, and give
    // the batch precisely that many bytes. Slide 1 then lands on the boundary
    // and passes; slide 2 has nowhere to go. A hard-coded number here would
    // stop meaning that the moment the encoder output changed by a byte.
    const urlsBefore = spy.urls
    const clicksBefore = spy.clicks

    // A GENUINE mid-batch failure, with the budget MEASURED rather than
    // guessed: export slide 1 on its own, take that PNG's exact size, and give
    // the batch precisely that many bytes. Slide 1 then lands on the boundary
    // and passes; slide 2 has nowhere to go. A hard-coded number here would
    // stop meaning that the moment the encoder's output changed by a byte.
    const one = await exportSlideImages(fourSlideDoc(), 'q1',
      { scope: 'current', format: 'png', scale: 1 }, { now })
    const oneSlideBytes = one.blob.size
    note('one exported slide is ' + oneSlideBytes + ' bytes; batch budget set to exactly that')

    let progressed = 0
    const mid = await failure(() => exportSlideImages(fourSlideDoc(), 'q1',
      { scope: 'all-main', format: 'png', scale: 1 },
      { now, onProgress: () => { progressed++ },
        budgets: { ...EXPORT_BUDGETS, maxEncodedBatchBytes: oneSlideBytes } }))
    check('11 — the encoded-batch budget fails MID-batch [got: ' + mid.code + ']',
      mid.code === 'archive')
    check('11 — exactly one slide fit inside the budget before it overflowed (progress ' +
      progressed + ')', progressed === 1)
    check('11 — and nothing was downloaded despite that progress',
      spy.urls === urlsBefore && spy.clicks === clicksBefore)

    // A policy-legal image that will not decode. Where this lands is MEASURED,
    // not claimed: the progress count is reported in the check name so the
    // answer is visible either way. What is asserted is the invariant that
    // holds wherever it lands — a typed error and no download.
    let decodeProgress = 0
    const bad = await failure(() => exportSlideImages(twoSlideDoc('undecodable'), 'b1',
      { scope: 'all-main', format: 'png', scale: 1 },
      { now, onProgress: () => { decodeProgress++ } }))
    note('undecodable slide 2: failed with "' + bad.code + '" after ' + decodeProgress +
      ' slide(s) reported progress')
    check('11 — an undecodable image is a typed decode failure [got: ' + bad.code +
      ', progress ' + decodeProgress + ']', bad.code === 'decode')
    check('11 — and it downloads nothing, wherever in the batch it is discovered',
      spy.urls === urlsBefore && spy.clicks === clicksBefore)

    const ac = new AbortController()
    await failure(() => exportSlideImages(twoSlideDoc('ok'), 'b1',
      { scope: 'all-main', format: 'png', scale: 1 },
      { now, signal: ac.signal, onProgress: () => ac.abort() }))
    check('11 — and a cancellation downloads nothing either',
      spy.urls === urlsBefore && spy.clicks === clicksBefore)

    // Cancellation must be honoured around the DECODE phase too, which is now
    // async and sits before any rendering. A signal already aborted when the
    // export starts has to stop it there, not after every payload has decoded.
    const preAborted = new AbortController()
    preAborted.abort()
    const early = await withOpSpy(async (opSpy) => {
      const res = await failure(() => exportSlideImages(fourSlideDoc(), 'q1',
        { scope: 'all-main', format: 'png', scale: 1 },
        { now, signal: preAborted.signal }))
      return { res, ops: { ...opSpy } }
    })
    check('11 — a signal aborted before the export starts stops it as cancelled [got: ' +
      early.res.code + ']', early.res.code === 'cancelled')
    check('11 — without decoding or encoding anything (decodes ' + early.ops.decode +
      ', toBlob ' + early.ops.toBlob + ')',
      early.ops.decode === 0 && early.ops.toBlob === 0)
    check('11 — and downloading nothing', spy.urls === urlsBefore && spy.clicks === clicksBefore)
  })

  // --- cancellation is PROMPT at every async boundary ----------------------
  //
  // "Cancel worked" is easy to claim and hard to mean. The weak version waits
  // for the long operation to finish and only then notices the flag — which on
  // a 60-slide deck is exactly the wait the user pressed Cancel to avoid.
  //
  // So each boundary is held OPEN here: the native call is patched to return a
  // promise that never settles, the abort is fired while it is pending, and the
  // export must reject anyway. If the code merely checked the flag afterwards,
  // it would hang and these would time out instead of passing.
  {
    // 1) img.decode() — the rendered-asset wait
    {
      const ac = new AbortController()
      const real = HTMLImageElement.prototype.decode
      HTMLImageElement.prototype.decode = function () {
        setTimeout(() => ac.abort(), 0)
        return new Promise(() => { /* pending forever */ })
      }
      const started = performance.now()
      const res = await Promise.race([
        failure(() => exportSlideImages(fourSlideDoc(), 'q1',
          { scope: 'all-main', format: 'png', scale: 1 },
          { now: () => capturedAt, signal: ac.signal })),
        new Promise<any>((resolve) => setTimeout(() => resolve({ code: '(hung)' }), 6000)),
      ])
      HTMLImageElement.prototype.decode = real
      check('4 — aborting while an img.decode() is pending rejects promptly [got: ' +
        res.code + ' in ' + Math.round(performance.now() - started) + 'ms]',
        res.code === 'cancelled')
    }

    // 2) canvas.toBlob() — the encode
    {
      const ac = new AbortController()
      const real = HTMLCanvasElement.prototype.toBlob
      HTMLCanvasElement.prototype.toBlob = function () {
        setTimeout(() => ac.abort(), 0)
        // the callback is never invoked
      } as any
      const started = performance.now()
      const res = await Promise.race([
        failure(() => exportSlideImages(fourSlideDoc(), 'q1',
          { scope: 'all-main', format: 'png', scale: 1 },
          { now: () => capturedAt, signal: ac.signal })),
        new Promise<any>((resolve) => setTimeout(() => resolve({ code: '(hung)' }), 6000)),
      ])
      HTMLCanvasElement.prototype.toBlob = real
      check('4 — aborting while canvas.toBlob() is pending rejects promptly [got: ' +
        res.code + ' in ' + Math.round(performance.now() - started) + 'ms]',
        res.code === 'cancelled')
    }

    // 3) Blob.arrayBuffer() — reading an encoded image back for the archive.
    //    Signature validation reads only tiny slices, so hold open LARGE blobs
    //    here to isolate the archive boundary.
    {
      const ac = new AbortController()
      const real = Blob.prototype.arrayBuffer
      Blob.prototype.arrayBuffer = function (this: Blob) {
        if (this.size > 100) {
          setTimeout(() => ac.abort(), 0)
          return new Promise(() => { /* pending forever */ })
        }
        return real.call(this)
      } as any
      const started = performance.now()
      const res = await Promise.race([
        failure(() => exportSlideImages(fourSlideDoc(), 'q1',
          { scope: 'all-main', format: 'png', scale: 1 },
          { now: () => capturedAt, signal: ac.signal })),
        new Promise<any>((resolve) => setTimeout(() => resolve({ code: '(hung)' }), 6000)),
      ])
      Blob.prototype.arrayBuffer = real
      check('4 — aborting while Blob.arrayBuffer() is pending rejects promptly [got: ' +
        res.code + ' in ' + Math.round(performance.now() - started) + 'ms]',
        res.code === 'cancelled')
    }

    // 4) Blob.arrayBuffer() — the PNG signature read itself. This is a distinct
    //    async boundary from the archive read above and must be raced too.
    {
      const ac = new AbortController()
      const real = Blob.prototype.arrayBuffer
      Blob.prototype.arrayBuffer = function (this: Blob) {
        if (this.size === 8) {
          setTimeout(() => ac.abort(), 0)
          return new Promise(() => { /* pending forever */ })
        }
        return real.call(this)
      } as any
      const started = performance.now()
      const res = await Promise.race([
        failure(() => exportSlideImages(fourSlideDoc(), 'q1',
          { scope: 'current', format: 'png', scale: 1 },
          { now: () => capturedAt, signal: ac.signal })),
        new Promise<any>((resolve) => setTimeout(() => resolve({ code: '(hung)' }), 6000)),
      ])
      Blob.prototype.arrayBuffer = real
      check('4 — aborting during the PNG signature read rejects promptly [got: ' +
        res.code + ' in ' + Math.round(performance.now() - started) + 'ms]',
        res.code === 'cancelled')
    }

    // 5) createImageBitmap — the preflight image decode
    //    Must use a doc with an embedded image to hit the preflight decode path.
    //    fourSlideDoc() uses shapes only, so createImageBitmap is never called.
    {
      const ac = new AbortController()
      const real = (globalThis as any).createImageBitmap
      ;(globalThis as any).createImageBitmap = function () {
        setTimeout(() => ac.abort(), 0)
        return new Promise(() => { /* pending forever */ })
      }
      const started = performance.now()
      // A doc with an embedded image triggers createImageBitmap in preflight
      const imgDoc = oneElementDoc(image(PNG_RED))
      const res = await Promise.race([
        failure(() => exportSlideImages(imgDoc.doc, imgDoc.slide.id,
          { scope: 'all-main', format: 'png', scale: 1 },
          { now: () => capturedAt, signal: ac.signal })),
        new Promise<any>((resolve) => setTimeout(() => resolve({ code: '(hung)' }), 6000)),
      ])
      ;(globalThis as any).createImageBitmap = real
      check('4 — aborting while createImageBitmap is pending rejects promptly [got: ' +
        res.code + ' in ' + Math.round(performance.now() - started) + 'ms]',
        res.code === 'cancelled')
    }

    // 6) FontFace.load() — the preflight font decode
    {
      const ac = new AbortController()
      const real = FontFace.prototype.load
      FontFace.prototype.load = function () {
        setTimeout(() => ac.abort(), 0)
        return new Promise(() => { /* pending forever */ })
      }
      const started = performance.now()
      // Need a doc with a font to hit the FontFace.load path
      const fontDoc = fourSlideDoc()
      fontDoc.fonts = [{ family: 'TestFont', asset: 'testfont' }]
      fontDoc.assets.testfont = FRAUNCES_900
      const res = await Promise.race([
        failure(() => exportSlideImages(fontDoc, 'q1',
          { scope: 'all-main', format: 'png', scale: 1 },
          { now: () => capturedAt, signal: ac.signal })),
        new Promise<any>((resolve) => setTimeout(() => resolve({ code: '(hung)' }), 6000)),
      ])
      FontFace.prototype.load = real
      check('4 — aborting while FontFace.load() is pending rejects promptly [got: ' +
        res.code + ' in ' + Math.round(performance.now() - started) + 'ms]',
        res.code === 'cancelled')
    }

    // Nothing was left mounted by any of the six held operations.
    const staging = Array.from(document.querySelectorAll<HTMLElement>('[aria-hidden="true"]'))
      .filter((el) => (el.getAttribute('style') ?? '').indexOf('-99999px') >= 0)
    check('4 — no staging host is left mounted after six mid-operation aborts (' +
      staging.length + ')', staging.length === 0)
    check('4 — and no download anchor is left behind (' +
      document.querySelectorAll('a[download]').length + ')',
      document.querySelectorAll('a[download]').length === 0)

    // 5) a typed NON-abort failure still reports itself, not "cancelled"
    {
      const res = await failure(() => exportSlideImages(twoSlideDoc('undecodable'), 'b1',
        { scope: 'all-main', format: 'png', scale: 1 }, { now: () => capturedAt }))
      check('4 — an ordinary typed failure is unaffected by the abort plumbing [got: ' +
        res.code + ']', res.code === 'decode')
    }
  }

  // --- the download's own cleanup ------------------------------------------
  //
  // Handing the file over is three steps — mint a URL, click an anchor, revoke
  // — and the last two have to happen even when the middle one throws. A
  // browser policy, an extension, or a refused synthetic activation all make
  // click() throw, and an anchor left in the document with a live object URL
  // behind it holds the whole blob for the life of the tab.
  //
  // The revoke is DELAYED on purpose (revoking immediately races the download),
  // so the timer is captured rather than waited for: waiting a real minute per
  // case would make this untestable, and leaving a real timer armed would leak
  // into every check after it.
  {
    const withCleanupSpy = async (
      clickBehaviour: 'normal' | 'throws',
      run: (spy: {
        created: string[]; revoked: string[]; clicks: number
        timers: Array<{ fn: () => void; ms: number }>
      }) => Promise<void>,
    ) => {
      const realCreate = URL.createObjectURL
      const realRevoke = URL.revokeObjectURL
      const realClick = HTMLAnchorElement.prototype.click
      const realSetTimeout = window.setTimeout
      const spy = {
        created: [] as string[],
        revoked: [] as string[],
        clicks: 0,
        timers: [] as Array<{ fn: () => void; ms: number }>,
      }
      URL.createObjectURL = function (blob: any) {
        const url = realCreate.call(URL, blob)
        spy.created.push(url)
        return url
      }
      URL.revokeObjectURL = function (url: string) {
        spy.revoked.push(url)
        return realRevoke.call(URL, url)
      }
      HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
        if (!this.download) return realClick.call(this)
        spy.clicks++
        if (clickBehaviour === 'throws') throw new Error('click refused by policy')
      }
      // Intercept ONLY the export's own contract delay, so nothing else in the
      // page has its timers stolen.
      ;(window as any).setTimeout = function (fn: any, ms?: number, ...rest: any[]) {
        if (ms === DOWNLOAD_REVOKE_MS) { spy.timers.push({ fn, ms }); return 0 }
        return (realSetTimeout as any).call(window, fn, ms, ...rest)
      }
      try {
        await run(spy)
      } finally {
        URL.createObjectURL = realCreate
        URL.revokeObjectURL = realRevoke
        HTMLAnchorElement.prototype.click = realClick
        ;(window as any).setTimeout = realSetTimeout
      }
    }

    const artifact = { blob: new Blob(['x'], { type: 'image/png' }), filename: 'cleanup-test.png' }

    // --- the success path ---------------------------------------------------
    await withCleanupSpy('normal', async (spy) => {
      downloadExportArtifact(artifact)
      check('download — mints exactly one object URL (' + spy.created.length + ')',
        spy.created.length === 1)
      check('download — issues exactly one click (' + spy.clicks + ')', spy.clicks === 1)
      check('download — removes the anchor SYNCHRONOUSLY (' +
        document.querySelectorAll('a[download]').length + ' left)',
        document.querySelectorAll('a[download]').length === 0)
      check('download — schedules exactly one delayed revoke (' + spy.timers.length + ')',
        spy.timers.length === 1)
      check('download — at the contract delay of ' + DOWNLOAD_REVOKE_MS + 'ms (got ' +
        (spy.timers[0]?.ms ?? -1) + ')', spy.timers[0]?.ms === DOWNLOAD_REVOKE_MS)
      check('download — and revokes NOTHING before that timer runs (' + spy.revoked.length + ')',
        spy.revoked.length === 0)
      spy.timers[0]?.fn()
      check('download — running the timer revokes exactly once (' + spy.revoked.length + ')',
        spy.revoked.length === 1)
      check('download — and revokes the URL it minted',
        spy.revoked[0] === spy.created[0])
    })

    // --- when click() throws ------------------------------------------------
    await withCleanupSpy('throws', async (spy) => {
      let thrown: unknown = null
      try {
        downloadExportArtifact(artifact)
      } catch (err) {
        thrown = err
      }
      check('download — a click that throws propagates its error rather than being swallowed',
        thrown instanceof Error && /click refused/.test(String((thrown as Error).message)))
      check('download — it still minted exactly one object URL (' + spy.created.length + ')',
        spy.created.length === 1)
      check('download — and attempted exactly one click (' + spy.clicks + ')', spy.clicks === 1)
      check('download — the anchor is STILL removed (' +
        document.querySelectorAll('a[download]').length + ' left)',
        document.querySelectorAll('a[download]').length === 0)
      check('download — and a delayed revoke is STILL scheduled, exactly once (' +
        spy.timers.length + ')', spy.timers.length === 1)
      check('download — at the same contract delay (got ' + (spy.timers[0]?.ms ?? -1) + ')',
        spy.timers[0]?.ms === DOWNLOAD_REVOKE_MS)
      check('download — with nothing revoked yet (' + spy.revoked.length + ')',
        spy.revoked.length === 0)
      spy.timers[0]?.fn()
      check('download — running it revokes the exact URL exactly once',
        spy.revoked.length === 1 && spy.revoked[0] === spy.created[0])
    })
  }

  // --- the document can change UNDER the export ----------------------------
  //
  // Preflight validates a snapshot; rendering happens later, slide by slide. If
  // anything can edit the document in between — a collab op, a stray handler,
  // or, as here, the progress callback itself — then what preflight approved is
  // not necessarily what gets rendered. So each page is recollected immediately
  // before it renders and every use must already be in the inventory.
  {
    const doc = twoSlideDoc('ok')
    let mutated = false
    const out = await withOpSpy(async (spy) => {
      const res = await exportThenDownload(doc, 'b1',
        { scope: 'all-main', format: 'png', scale: 1 },
        {
          now: () => capturedAt,
          onProgress: () => {
            if (mutated) return
            mutated = true
            // slide 2's image becomes a REMOTE one, after preflight approved it
            doc.slides[1].elements[0].src = 'https://bento-probe.invalid/toctou.png'
          },
        })
      return { res, ops: { ...spy } }
    })
    check('11 — a slide edited AFTER preflight is caught before it renders [got: ' +
      out.res.code + ']', out.res.code === 'resource')
    check('11 — naming the slide that changed', out.res.slideNumber === 2)
    check('11 — and the export really did get far enough to matter', mutated)
    check('11 — exactly one staging host was mounted — slide 1, before the edit (mounts ' +
      out.ops.mounts + ')', out.ops.mounts === 1)
    check('11 — slide 2 was never rendered or encoded (toBlob ' + out.ops.toBlob + ')',
      out.ops.toBlob === 1)
    check('11 — and the failed batch downloaded nothing (urls ' + out.ops.urls +
      ', clicks ' + out.ops.clicks + ')', out.ops.urls === 0 && out.ops.clicks === 0)
  }
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

/** Choose one radio/option by its value, whatever control shape is used. */
function choose(name: string, value: string): boolean {
  const dlg = dlgOf()
  if (!dlg) return false
  // Attribute values QUOTED: [value=2] is not a valid selector — an unquoted
  // attribute value has to be an identifier, and "2" is not one.
  const radio = dlg.querySelector(
    'input[type="radio"][name="' + name + '"][value="' + value + '"]') as HTMLInputElement | null
  if (radio) { radio.click(); return true }
  const select = dlg.querySelector('select[name="' + name + '"]') as HTMLSelectElement | null
  if (select) {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  return false
}

const clickIn = (sel: string) => {
  const el = pick<HTMLElement>(sel)
  if (el) el.click()
  return !!el
}

async function dialogSection() {
  // A real opener, focused, then hidden the way the Save menu hides itself.
  const opener = document.createElement('button')
  opener.textContent = 'Save'
  document.body.appendChild(opener)

  const openIt = (
    ctx: { mainSlideCount: number; encrypted: boolean },
    run: (o: any, c: any, s: AbortSignal) => Promise<void>,
  ) => {
    opener.focus()
    promptSlideImageExport({ ...ctx, returnFocusTo: opener }, run)
    // the menu closes itself the instant the item is chosen
    opener.blur()
  }

  // --- opens, is labelled, and defaults the way the contract says ----------
  {
    let ran = 0
    openIt({ mainSlideCount: 7, encrypted: false }, async () => { ran++ })
    await tick()
    const dlg = dlgOf()
    check('ui — choosing the action opens a native modal dialog',
      !!dlg && dlg.open && dlg.tagName === 'DIALOG')
    const labelledBy = dlg?.getAttribute('aria-labelledby') ?? ''
    const heading = labelledBy ? document.getElementById(labelledBy) : null
    check('ui — with a real heading, associated by aria-labelledby',
      !!heading && /h[1-6]/i.test(heading.tagName) && !!heading.textContent?.trim())
    check('ui — the deck-wide count is visible, so "all" means something',
      (dlg?.textContent ?? '').indexOf('7') >= 0)
    const checkedValue = (name: string) => {
      const r = dlg?.querySelector(
        'input[type="radio"][name="' + name + '"]:checked') as HTMLInputElement | null
      if (r) return r.value
      const s = dlg?.querySelector('select[name="' + name + '"]') as HTMLSelectElement | null
      return s ? s.value : ''
    }
    check('ui — scope defaults to the current slide', checkedValue('scope') === 'current')
    check('ui — format defaults to PNG', checkedValue('format') === 'png')
    check('ui — scale defaults to 1x', checkedValue('scale') === '1')
    check('ui — and nothing has been exported just by opening it', ran === 0)

    // focus moved INTO the dialog
    check('ui — keyboard focus enters the dialog',
      !!dlg && dlg.contains(document.activeElement))

    clickIn('.ed-image-export-cancel')
    await tick()
    check('ui — Cancel closes it', !dlgOf())
    check('ui — without exporting', ran === 0)
    check('ui — and focus returns to the control that opened it, even though ' +
      'the menu that held it is gone', document.activeElement === opener)
  }

  // --- Escape is the same door -------------------------------------------
  {
    let ran = 0
    openIt({ mainSlideCount: 3, encrypted: false }, async () => { ran++ })
    await tick()
    dlgOf()?.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true }))
    await tick()
    check('ui — Escape closes it too', !dlgOf())
    check('ui — still without exporting', ran === 0)
    check('ui — and still restores focus', document.activeElement === opener)
  }

  // --- the choices reach the caller --------------------------------------
  {
    let seen: any = null
    openIt({ mainSlideCount: 4, encrypted: false }, async (options, controller) => {
      seen = options
      controller.close()
    })
    await tick()
    check('ui — every choice is offered',
      choose('scope', 'all-main') && choose('format', 'jpeg') && choose('scale', '2'))
    clickIn('.ed-image-export-run')
    await tick(4)
    check('ui — and the chosen options are what the caller receives',
      !!seen && seen.scope === 'all-main' && seen.format === 'jpeg' && seen.scale === 2)
    check('ui — a successful export closes the dialog', !dlgOf())
  }

  // --- running: disabled, announced, cancellable exactly once -------------
  {
    let aborts = 0
    let release: (() => void) | null = null
    let controllerRef: any = null
    openIt({ mainSlideCount: 5, encrypted: false }, async (_options, controller, signal) => {
      controllerRef = controller
      signal.addEventListener('abort', () => { aborts++ })
      await new Promise<void>((resolve) => { release = resolve })
    })
    await tick()
    clickIn('.ed-image-export-run')
    await tick(3)

    const disabled = Array.from(dlgOf()?.querySelectorAll('input, select') ?? [])
      .every((el) => (el as HTMLInputElement).disabled)
    check('ui — while running, every choice is disabled', disabled)

    const status = pick<HTMLElement>('.ed-image-export-status')
    check('ui — there is a polite live region for progress',
      !!status && status.getAttribute('aria-live') === 'polite')

    controllerRef?.setProgress({ completed: 2, total: 5, slideNumber: 3 })
    await tick()
    const text = pick<HTMLElement>('.ed-image-export-status')?.textContent ?? ''
    check('ui — progress reports n of m (' + JSON.stringify(text.slice(0, 40)) + ')',
      text.indexOf('2') >= 0 && text.indexOf('5') >= 0)

    // Cancel WHILE RUNNING, twice, plus Escape: still exactly one abort.
    clickIn('.ed-image-export-cancel')
    clickIn('.ed-image-export-cancel')
    dlgOf()?.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true }))
    await tick()
    check('ui — cancelling while it runs aborts EXACTLY once, however many ' +
      'times the user asks (' + aborts + ')', aborts === 1)
    check('ui — and the dialog stays up while it winds down, rather than ' +
      'vanishing mid-work', !!dlgOf())
    release?.()
    await tick(3)
    controllerRef?.close()
    await tick()
    check('ui — then it closes', !dlgOf())
  }

  // --- an error stays visible --------------------------------------------
  {
    openIt({ mainSlideCount: 2, encrypted: false }, async (_options, controller) => {
      controller.showError('Slide 2 would fetch something.')
    })
    await tick()
    clickIn('.ed-image-export-run')
    await tick(4)
    check('ui — an error leaves the dialog OPEN, where the user can read it', !!dlgOf())
    const shown = pick<HTMLElement>('.ed-image-export-status')?.textContent ?? ''
    check('ui — showing the message it was given', shown.indexOf('Slide 2') >= 0)
    const usable = Array.from(dlgOf()?.querySelectorAll('input, select') ?? [])
      .every((el) => !(el as HTMLInputElement).disabled)
    check('ui — with the choices usable again, so a retry is possible', usable)
    clickIn('.ed-image-export-cancel')
    await tick()
  }

  // --- cancellation race: Cancel re-enabled after showError ---------------
  //
  // The race: user presses Cancel while running → state is 'cancelling',
  // Cancel button is disabled. The work throws an error (not a cancellation)
  // → showError is called. Cancel must be re-enabled, or the user is stuck.
  {
    let release: (() => void) | null = null
    let controllerRef: any = null
    openIt({ mainSlideCount: 2, encrypted: false }, async (_options, controller, signal) => {
      controllerRef = controller
      signal.addEventListener('abort', () => {
        // Simulate a race: the abort fires, but the work throws a non-cancel
        // error instead of a cancellation.
        setTimeout(() => controller.showError('Something went wrong during cancel.'), 0)
      })
      await new Promise<void>((resolve) => { release = resolve })
    })
    await tick()
    clickIn('.ed-image-export-run')
    await tick(3)
    // Press Cancel while running — this disables the Cancel button
    clickIn('.ed-image-export-cancel')
    await tick(3)
    // showError was called by the abort handler — check Cancel is re-enabled
    const cancelBtn = pick<HTMLButtonElement>('.ed-image-export-cancel')
    check('ui — Cancel is re-enabled after a cancellation race lands as showError',
      !!cancelBtn && !cancelBtn.disabled)
    const cancelText = cancelBtn?.textContent ?? ''
    check('ui — Cancel text is restored to "Cancel" (not "Cancelling…")',
      /cancel/i.test(cancelText))
    // Clean up
    release?.()
    await tick()
    clickIn('.ed-image-export-cancel')
    await tick()
  }

  // --- dark theme uses the chrome tokens with readable contrast -----------
  {
    const root = document.documentElement
    const previousTheme = root.getAttribute('data-theme')
    const previousScheme = root.style.colorScheme
    root.dataset.theme = 'dark'
    root.style.colorScheme = 'dark'
    try {
      openIt({ mainSlideCount: 2, encrypted: true }, async (_options, controller) => {
        controller.showError('A readable export error.')
      })
      await tick()
      clickIn('.ed-image-export-run')
      await tick(4)

      const dlg = dlgOf()
      const legend = dlg?.querySelector<HTMLElement>('legend') ?? null
      const noteEl = dlg?.querySelector<HTMLElement>('.ed-image-export-note') ?? null
      const errorEl = dlg?.querySelector<HTMLElement>('.ed-image-export-status.is-error') ?? null
      const tokenColor = (name: string) => {
        const probe = document.createElement('span')
        probe.style.color = 'var(' + name + ')'
        dlg?.appendChild(probe)
        const color = getComputedStyle(probe).color
        probe.remove()
        return color
      }
      const ink = tokenColor('--ink')
      const muted = tokenColor('--muted')
      check('ui — dark-theme legend uses the ink token',
        !!legend && getComputedStyle(legend).color === ink)
      check('ui — dark-theme encryption note uses the muted token',
        !!noteEl && getComputedStyle(noteEl).color === muted)
      check('ui — dark-theme error uses a readable ink token, not a light-only red',
        !!errorEl && getComputedStyle(errorEl).color === ink)

      const rgb = (value: string): number[] =>
        (value.match(/[\\d.]+/g) ?? []).slice(0, 3).map(Number)
      const luminance = (value: string) => {
        const raw = rgb(value)
        // Chrome may serialize computed colours as either rgb(0..255) or
        // color(srgb 0..1). Normalize exactly once for either spelling.
        const divisor = raw.length === 3 && raw.every((n) => n <= 1) ? 1 : 255
        const parts = raw.map((n) => {
          const c = n / divisor
          return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
        })
        return parts.length === 3
          ? 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]
          : 0
      }
      const contrast = (a: string, b: string) => {
        const x = luminance(a)
        const y = luminance(b)
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
      }
      const surface = dlg ? getComputedStyle(dlg).backgroundColor : ''
      const foregrounds = [legend, noteEl, errorEl].map((el) =>
        el ? getComputedStyle(el).color : '')
      const ratios = foregrounds.map((color) => color ? contrast(color, surface) : 0)
      check('ui — dark-theme legend, note and error each meet 4.5:1 contrast (' +
        ratios.map((n) => n.toFixed(2)).join(', ') + '; foregrounds: ' +
        foregrounds.join(' | ') + '; surface: ' + surface + ')',
        ratios.every((n) => n >= 4.5))

      clickIn('.ed-image-export-cancel')
      await tick()
    } finally {
      if (previousTheme === null) root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', previousTheme)
      root.style.colorScheme = previousScheme
    }
  }

  // --- the encrypted note -------------------------------------------------
  {
    openIt({ mainSlideCount: 2, encrypted: true }, async () => { /* not run */ })
    await tick()
    const note = pick<HTMLElement>('.ed-image-export-note')
    check('ui — an unlocked encrypted deck warns that the image is not encrypted',
      !!note && (note.textContent ?? '').length > 10)
    clickIn('.ed-image-export-cancel')
    await tick()

    openIt({ mainSlideCount: 2, encrypted: false }, async () => { /* not run */ })
    await tick()
    check('ui — and an ordinary deck is not nagged with it', !pick('.ed-image-export-note'))
  }

  // --- 320 CSS pixels, and copy three times as long -----------------------
  {
    const dlg = dlgOf()
    if (dlg) {
      dlg.style.width = '320px'
      dlg.style.maxWidth = '320px'
      await tick()
      const overflow = Array.from(dlg.querySelectorAll<HTMLElement>('*'))
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
      check('ui — nothing overflows horizontally at 320 CSS pixels (' +
        overflow.length + ' offenders)', overflow.length === 0)

      // long-copy safety: German and Japanese labels run far longer than English
      for (const el of Array.from(dlg.querySelectorAll<HTMLElement>('label, button, h2'))) {
        el.textContent = (el.textContent ?? '') + ' Präsentationsexportgrößenauswahl'
      }
      await tick()
      const longOverflow = Array.from(dlg.querySelectorAll<HTMLElement>('*'))
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
      check('ui — and nothing overflows with labels three times as long (' +
        longOverflow.length + ' offenders)', longOverflow.length === 0)
    } else {
      check('ui — nothing overflows horizontally at 320 CSS pixels (no dialog)', false)
      check('ui — and nothing overflows with long labels (no dialog)', false)
    }
    clickIn('.ed-image-export-cancel')
    await tick()
  }

  // --- the module's own boundary -----------------------------------------
  check('ui — the dialog leaves no stray node behind', !dlgOf())
  opener.remove()
}

// --- characterization (manual only) -----------------------------------------

/**
 * Measure where this browser stops, WITHOUT ever asking it for a canvas that
 * could take the machine down with it.
 *
 * The two limits are measured SEPARATELY and deliberately, because a naive
 * "keep making the square bigger" ladder conflates them and gets expensive
 * fast: 16384x16384 is 268 megapixels — a gigabyte of backing store before any
 * intermediate — and finding the cliff that way means allocating right up to
 * it. So:
 *
 *   · MAX DIMENSION is probed with THIN rectangles (height 32). A 22000x32
 *     canvas is 704k pixels, under 3 MB, and answers the per-side question
 *     exactly as well as a square would.
 *   · MAX AREA is probed with squares that STOP at 8192x8192 (67 MP, ~268 MB).
 *     That is the ceiling of the scan, not a value to exceed: the production
 *     constant is chosen well below whatever succeeds here.
 *
 * Every attempt is bounded by a wall-clock budget, and the canvas gives its
 * backing store back after each one.
 */
async function characterize(canvas: HTMLCanvasElement, capturedAt: Date) {
  note('--- characterization (manual only; never run in CI) ---')
  // The scan must not be capped by the constants it exists to choose.
  const UNCAPPED = { maxDimension: 1e6, maxPixels: 1e12 }
  /** Hard ceiling on the AREA scan. Never raise this to "see what happens". */
  const AREA_CAP = 8192
  const BUDGET_MS = 120_000
  const startedAll = performance.now()
  const outOfTime = () => performance.now() - startedAll > BUDGET_MS

  const attempt = async (label: string, w: number, h: number, scale: 1 | 2) => {
    if (outOfTime()) { note('  ' + label + ': SKIPPED (characterization budget spent)'); return false }
    const t = transparentFixture()
    t.doc.size = { width: w, height: h }
    const started = performance.now()
    const res = await failure(() => shoot(t.doc, t.slide.id,
      { scale, format: 'png', capturedAt, canvas, limits: UNCAPPED }))
    // rasterizeSlideImage already zeroes the canvas in its finally; do it again
    // here so an attempt that threw before reaching it still gives memory back.
    canvas.width = 0
    canvas.height = 0
    note('  ' + label + ': ' + res.code + ' in ' + Math.round(performance.now() - started) + 'ms')
    return res.code === '(it succeeded)'
  }

  note('  max DIMENSION (thin rectangles, height 32 — a few MB each):')
  for (const w of [4096, 8192, 10000, 16384, 22000, 32768]) {
    const okAt = await attempt('    ' + w + 'x32 @1x', w, 32, 1)
    if (!okAt) break   // stop at the first refusal; do not escalate past it
  }

  note('  max AREA (squares, capped at ' + AREA_CAP + 'x' + AREA_CAP + ' = ' +
    Math.round(AREA_CAP * AREA_CAP / 1e6) + ' MP):')
  for (const w of [2048, 4096, 6144, AREA_CAP]) {
    const okAt = await attempt('    ' + w + 'x' + w + ' @1x (' + Math.round(w * w / 1e6) + ' MP)', w, w, 1)
    if (!okAt) break
  }
  // the shapes the product actually ships, at both scales
  await attempt('    1080x1080 @2x (the carousel case)', 1080, 1080, 2)
  await attempt('    1280x720 @2x (16:9 at 2x)', 1280, 720, 2)
  await attempt('    4000x4000 @1x (the plan\\'s stretch case)', 4000, 4000, 1)

  // A near-limit embedded PAYLOAD on a SMALL canvas, so string/data-URI
  // pressure cannot hide behind a comfortable canvas area.
  if (!outOfTime()) {
    const big = makePng('#123456', 1400, 1400)
    const f = oneElementDoc(image(big))
    const started = performance.now()
    const res = await failure(() => shoot(f.doc, f.slide.id,
      { scale: 1, format: 'png', capturedAt, canvas, limits: UNCAPPED }))
    canvas.width = 0
    canvas.height = 0
    note('    200x200 canvas carrying a ' + big.length + '-char embedded image: ' + res.code +
      ' in ' + Math.round(performance.now() - started) + 'ms')
  }
  canvas.width = 0
  canvas.height = 0
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

/**
 * Two hazards the shipped sheet does not (yet) carry, both real:
 *
 *  - a cursor whose value is an SVG data URL. Issue #261's reporter broke XML
 *    parsing on exactly this, so the strip is proven against a payload rather
 *    than against today's luck.
 *  - a declaration whose VALUE contains a literal CDATA terminator. It paints
 *    the p-cdata box green, so the probe can assert with a pixel that the whole
 *    stylesheet crossed the foreignObject boundary intact.
 */
const HAZARD_CSS =
  '.ed-probe-crosshair{cursor:url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=") 8 8, crosshair}\n' +
  '.ed-probe-plain{cursor:pointer;color:#123456}\n' +
  '[data-el-id="p-cdata"]{background:#00FF66}\n' +
  '[data-el-id="p-cdata"] .bento-text-inner::after{content:"]]' + '> ok"}\n' +
  // A data-URI image in the EXPORT stylesheet itself. The 1x1 transparent GIF
  // this repo already uses elsewhere — a real, static, whitelisted image, so
  // the only question it asks is whether app CSS payloads reach the inventory
  // and the budgets like every other payload.
  '.ed-probe-cssimg{background:url("data:image/gif;base64,' +
  'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==")}\n'

function buildFixture(tmp: string, origin: string): string {
  const entry = path.join(tmp, 'probe.ts')
  fs.writeFileSync(entry, probeSource(
    repoFile('slides/src/image-export.ts'),
    repoFile('slides/src/image-export-zip.ts'),
    repoFile('slides/src/model.ts'),
    repoFile('slides/src/fontdata.ts'),
    repoFile('slides/src/editor/image-export-dialog.ts'),
    repoFile('slides/src/render.ts'),
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
    '<sty' + 'le data-bento-app-style>' + styles + '\n' + HAZARD_CSS + '</sty' + 'le>' +
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
      ok(!asked('/remote-video.mp4') && !asked('/clip.mp4') && !asked('/no-poster.mp4'),
        '6 — blanking media src BEFORE the first render means no remote clip is ever requested')
      ok(!asked('/svg-import.css') && !asked('/svg-esc.css') && !asked('/svg-str.css') &&
        !asked('/svg-bg.png') && !asked('/model-import.css'),
        '7 — every sanitizer-handled CSS url()/@import spelling makes zero requests')
      ok(!asked('/escaped-url.png') && !asked('/escaped-first.png') &&
        !asked('/model-escaped-url.png') && !asked('/cursor-escaped.png'),
        '1 — u\\72l(…) and \\75rl(…), which no literal "url(" match sees, make zero requests')
      ok(!asked('/fo-img.png') && !asked('/fo-input.png') && !asked('/fo-object.bin') &&
        !asked('/fo-embed.bin') && !asked('/fo-iframe.html') && !asked('/fo-poster.png') &&
        !asked('/fo-video.mp4') && !asked('/fo-style.png'),
        '1 — no hostile HTML sink smuggled into a foreignObject reaches the network, ' +
        'including while being parsed for the audit')
      ok(!asked('/bg-url.png') && !asked('/bg-imageset.png') && !asked('/bg-webkit.png') &&
        !asked('/paint.svg') && !asked('/stroke.svg') && !asked('/svgcss-imageset.png') &&
        !asked('/svgmarkup-imageset.png'),
        '1 — every RENDERED model sink (slide background, shape fill, line stroke, ' +
        'SvgElement.css, author style) is refused without fetching, url() and image-set() alike')
      ok(!asked('/svg-image.png') && !asked('/svg-xlink.png') && !asked('/fe-image.png'),
        "7 — an author SVG's remote <image>/<feImage> is rejected BEFORE mount, so it never fetches")
      ok(!asked('/both-empty.png') && !asked('/both-space.png') && !asked('/both-frag.png') &&
        !asked('/both-data.png') && !asked('/both-first.png') && !asked('/both-fe.png'),
        '1 — when href AND xlink:href are both present, NEITHER fetches: both are ' +
        'examined independently rather than one shadowing the other')
      ok(!asked('/toctou.png'),
        '11 — a slide swapped to a remote image after preflight is refused without fetching it')
      ok(!asked('/pic.png') && !asked('/poster.png') && !asked('/late.png') && !asked('/f.woff2'),
        'no rejected image, poster, batch slide or font is fetched while being refused')
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

// Both refusals happen HERE, before a browser is launched or a fixture is
// built: a run that is going to be rejected should cost nothing, and a
// characterization scan must never begin on a machine nobody is watching.
if (process.env.CI && CHARACTERIZE) {
  console.error('  ✗ --characterize is an allocation scan for a human at a machine they can watch.')
  console.error('    CI runs the stable no-flag mode. Refusing before launching a browser.')
  process.exit(1)
}
if (process.env.CI && !CHROME) {
  console.error('  ✗ CI must not skip the browser section, and no Chrome was found.')
  console.error('    This is the only half that can answer "does this fetch" with a request log.')
  process.exit(1)
}

if (CHARACTERIZE) console.log('  (characterization mode — manual only, never run in CI)')
if (!CHROME) {
  console.log('  ⚠ SKIPPED — no Chrome found. Set BENTO_CHROME to a binary to run this section;')
  console.log('    it is the only half that can answer "does this rasterize" with pixels.')
  console.log('    A SKIP IS NOT A PASS.')
} else {
  await runBrowserSection(CHROME)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
