#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento check — the closing half of an agent's loop: write a deck, LOOK at it.
//
//   node scripts/bento-check.mjs <deck.bento.html | doc.json>
//        [--shell path] [--png outdir] [--json] [--fail-on error|warning]
//
// Loads the deck in headless Chrome — the real shell, the real renderer, the
// deck's own fonts — and reports what the runtime would otherwise swallow:
// `window.bento.validate()` findings (unknown keys, text that overflows its
// box, elements off the canvas, entrances that can never run, broken links and
// asset refs), the load report when the input was JSON (what the gate dropped,
// what compact expansion filled — fields a shell without #484 does not carry,
// tolerated), and with --png one PNG per slide in show order through the same
// render→canvas path Save ▾ Export slides as images uses (#480), plus a
// contact sheet so an agent can look at the whole deck in one image.
//
// HOW IT DRIVES CHROME. The harness the sanitize and embed rigs use, reused:
// a local http server hands Chrome the deck with a probe module appended and
// a load gate (an <img> the server answers only once the probe has POSTed its
// report), Chrome runs `--headless=new --dump-dom` and exits at load. No
// puppeteer, no CDP client, no new dependency — system Chrome via the same
// BENTO_CHROME lookup the rigs share. The probe is bundled by esbuild against
// the repo's own sources, so the pixels are the shipping code path.
//
// INPUT. A .bento.html is used as-is (it IS shell + document). A .json is a
// document — full, or compact once the shell accepts `"compact": true` — and
// is handed to `window.bento.loadDoc()` inside a shell: --shell, else
// slides/dist-single/Bento_Slides.bento.html (build it with
// `cd slides && npm run build:single`).

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2)
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const flag = (name) => argv.includes(name)
const input = argv.find((a, i) => !a.startsWith('--') && !['--shell', '--png', '--fail-on'].includes(argv[i - 1]))
const asJson = flag('--json')
const pngDir = opt('--png')
const failOn = opt('--fail-on') ?? 'error'
const shellPath = opt('--shell') ?? path.join(root, 'slides/dist-single/Bento_Slides.bento.html')

const die = (msg, code = 2) => { console.error(`bento check: ${msg}`); process.exit(code) }
if (!input) die('usage: node scripts/bento-check.mjs <deck.bento.html | doc.json> [--shell path] [--png outdir] [--json] [--fail-on error|warning]')
if (!['error', 'warning'].includes(failOn)) die(`--fail-on takes error or warning, not "${failOn}"`)
if (!fs.existsSync(input)) die(`no such file: ${input}`)

// ---- Chrome — the rigs' lookup ------------------------------------------------
const findChrome = () => [
  process.env.BENTO_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p) => !!p && fs.existsSync(p))
  ?? (spawnSync('which', ['google-chrome']).status === 0 ? 'google-chrome' : undefined)
const chrome = findChrome()
if (!chrome) die('no Chrome found — install Google Chrome or set BENTO_CHROME to a binary')

// ---- input → the html Chrome will load + the JSON the probe will load --------
const isHtml = /\.html?$/i.test(input)
let deckHtml
let docJson = null
if (isHtml) {
  deckHtml = fs.readFileSync(input, 'utf8')
} else {
  if (!fs.existsSync(shellPath)) die(`no shell at ${shellPath} — run \`cd slides && npm run build:single\`, or pass --shell`)
  deckHtml = fs.readFileSync(shellPath, 'utf8')
  docJson = fs.readFileSync(input, 'utf8')
  try { JSON.parse(docJson) } catch (e) { die(`${input} is not JSON: ${e.message}`) }
}
if (!deckHtml.includes('id="bento-doc"')) die(`${isHtml ? input : shellPath} carries no #bento-doc block — not a Bento file`)

// ---- the probe, bundled against the repo's own sources ----------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-check-'))
const esbuild = path.join(root, 'slides/node_modules/.bin/esbuild')
if (!fs.existsSync(esbuild)) die('slides/node_modules is missing — run `cd slides && npm install`')
const exportImagesPath = path.join(root, 'slides/src/editor/exportimages.ts')
const exportDecisionsPath = path.join(root, 'slides/src/exportimages.ts')

// Written by concatenation: never a literal script-close in a source file.
const probeSrc = `
import { rasterizeSlide } from ${JSON.stringify(exportImagesPath)}
import { exportableSlides, pixelSize } from ${JSON.stringify(exportDecisionsPath)}

const WANT_PNG = ${JSON.stringify(!!pngDir)}
const DOC_JSON = ${JSON.stringify(docJson)}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const post = (body) => fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function main() {
  const t0 = performance.now()
  let bento
  for (let i = 0; i < 600 && !(bento = window.bento?.doc && window.bento); i++) await sleep(50)
  if (!bento) return post({ fatal: 'the shell did not boot (window.bento never appeared)' })
  if (document.fonts?.ready) await document.fonts.ready

  let load = null
  if (DOC_JSON !== null) {
    // A compact document on a shell that predates compact input (#484) is not
    // refused by the gate — it is accepted and then the editor throws on the
    // first missing field. Say so before that happens.
    let parsed = null
    try { parsed = JSON.parse(DOC_JSON) } catch {}
    if (parsed && parsed.compact === true && typeof bento.compact !== 'function') {
      return post({ fatal: 'this shell does not accept compact documents ("compact": true needs a shell built with #484 — window.bento.compact is absent); pass a full document, or --shell a newer build' })
    }
    let r
    try { r = bento.loadDoc(DOC_JSON) } catch (e) { return post({ fatal: 'the shell threw while loading the document: ' + String(e && e.message || e) }) }
    if (r === false) return post({ fatal: 'the shell refused the document: loadDoc() returned false (not valid bento/slides JSON, or a compact document on a shell without #484)' })
    load = r && typeof r === 'object' ? r : { ok: true }
    await sleep(50)
  }
  const doc = bento.doc
  const v = bento.validate()
  const pages = []
  let contact = null
  const shown = exportableSlides(doc)
  if (WANT_PNG) {
    const thumbs = []
    for (const slide of shown) {
      const blob = await rasterizeSlide(doc, slide, 'png', 1)
      const url = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob) })
      pages.push(url)
      thumbs.push(url)
    }
    // contact sheet: up to 4 across, 320 px wide each, the deck's aspect
    const { width: w, height: h } = doc.size
    const tw = 320, th = Math.round(320 * h / w), gap = 12, cols = Math.min(4, Math.max(1, thumbs.length))
    const rows = Math.ceil(thumbs.length / cols)
    const c = document.createElement('canvas')
    c.width = cols * tw + (cols + 1) * gap
    c.height = rows * (th + 22) + (rows + 1) * gap
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#e9ecef'; ctx.fillRect(0, 0, c.width, c.height)
    ctx.fillStyle = '#334'; ctx.font = '12px system-ui, sans-serif'
    for (let i = 0; i < thumbs.length; i++) {
      const img = new Image(); img.src = thumbs[i]; await img.decode()
      const x = gap + (i % cols) * (tw + gap), y = gap + Math.floor(i / cols) * (th + 22 + gap)
      ctx.drawImage(img, x, y, tw, th)
      ctx.fillText(String(i + 1).padStart(2, '0'), x, y + th + 15)
    }
    contact = c.toDataURL('image/png')
  }
  return post({
    ok: v.ok,
    title: doc.title,
    size: doc.size,
    slides: doc.slides.length,
    shown: shown.length,
    pixel: pixelSize(doc, 1),
    counts: v.counts,
    measured: v.measured,
    findings: v.findings,
    load,
    pages,
    contact,
    ms: Math.round(performance.now() - t0),
  })
}
main().catch((e) => post({ fatal: String(e && e.stack || e) }))
`
fs.writeFileSync(path.join(tmp, 'probe-entry.js'), probeSrc)
const built = spawnSync(esbuild, [
  path.join(tmp, 'probe-entry.js'), '--bundle', '--format=esm', '--log-level=error',
  '--outfile=' + path.join(tmp, 'probe.js'),
], { stdio: ['ignore', 'pipe', 'pipe'] })
if (built.status !== 0) die(`could not bundle the probe:\n${built.stderr}`)
const probe = fs.readFileSync(path.join(tmp, 'probe.js'), 'utf8')

// The deck, with the probe appended and the load gate after it. The gate is
// load-bearing (see test-sanitize): the new headless fires --dump-dom at the
// load event, so the page must not finish loading until the report is in.
const page = deckHtml +
  '\n<scr' + 'ipt type="module" src="/probe.js"></scr' + 'ipt>' +
  '<img src="/gate.gif" width="1" height="1" alt="">'

// ---- serve, run, collect -------------------------------------------------------
const started = Date.now()
let report = null
let releaseGate = null
let child = null
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')
const dbg = (...a) => { if (process.env.BENTO_CHECK_DEBUG) console.error(`[${Date.now() - started} ms]`, ...a) }
const server = http.createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  dbg(req.method, url)
  if (url === '/deck.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); return }
  if (url === '/probe.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(probe); return }
  if (url === '/report' && req.method === 'POST') {
    let body = ''
    req.on('data', (b) => { body += b })
    req.on('end', () => {
      try { report = JSON.parse(body) } catch { report = { fatal: 'the probe posted something that was not JSON' } }
      res.writeHead(204); res.end()
      dbg('report received', releaseGate ? '(gate waiting → released)' : '(gate not yet requested)')
      releaseGate?.()
      // The report is the deliverable, not the dump: the shell keeps the page
      // busy past load (measured: Chrome sat 88 s after the gate opened), so
      // Chrome is closed the moment the report is in.
      setTimeout(() => child?.kill('SIGTERM'), 100)
    })
    return
  }
  if (url === '/gate.gif') {
    const send = () => { res.writeHead(200, { 'content-type': 'image/gif' }); res.end(gif) }
    if (report) send(); else releaseGate = send
    return
  }
  res.writeHead(404); res.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

// spawn, never spawnSync: the server lives in this process.
child = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--disable-sync', '--disable-default-apps',
  '--hide-scrollbars', '--window-size=1600,1000',
  '--user-data-dir=' + path.join(tmp, 'profile'),
  '--dump-dom', `http://127.0.0.1:${port}/deck.html`,
], { stdio: ['ignore', 'ignore', 'ignore'] })
const TIMEOUT = 90_000
await new Promise((resolve) => {
  const timer = setTimeout(() => { report ??= { fatal: `no report within ${TIMEOUT / 1000}s — the shell did not boot, or Chrome hung` }; child.kill('SIGKILL') }, TIMEOUT)
  child.on('close', (code) => { dbg('chrome exited', code); clearTimeout(timer); resolve() })
})
server.close()
fs.rmSync(tmp, { recursive: true, force: true })
const wall = Date.now() - started

if (!report) report = { fatal: 'Chrome exited before the probe reported' }
if (report.fatal) {
  if (asJson) console.log(JSON.stringify({ ok: false, fatal: report.fatal, ms: wall }, null, 2))
  else console.error(`bento check: ${report.fatal}`)
  process.exit(2)
}

// ---- files ------------------------------------------------------------------------
const written = []
if (pngDir) {
  fs.mkdirSync(pngDir, { recursive: true })
  const toFile = (dataUrl, name) => {
    const p = path.join(pngDir, name)
    fs.writeFileSync(p, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
    written.push(p)
  }
  report.pages.forEach((u, i) => toFile(u, `page-${String(i + 1).padStart(2, '0')}.png`))
  if (report.contact) toFile(report.contact, 'contact.png')
}

// ---- the report ----------------------------------------------------------------------
const findings = report.findings ?? []
const overflow = findings.filter((f) => f.code === 'text-overflow')
const dropped = report.load?.dropped ?? []
const errors = findings.filter((f) => f.severity === 'error').length
const warnings = findings.filter((f) => f.severity === 'warning').length
const failed = failOn === 'error' ? errors > 0 : errors + warnings > 0
const out = {
  ok: !failed,
  file: input,
  title: report.title,
  slides: report.slides,
  shown: report.shown,
  counts: report.counts,
  measured: report.measured,
  findings,
  overflow,
  dropped,
  expanded: report.load?.expanded ?? null,
  pages: written.filter((p) => !p.endsWith('contact.png')),
  contact: written.find((p) => p.endsWith('contact.png')) ?? null,
  ms: wall,
}

if (asJson) {
  console.log(JSON.stringify(out, null, 2))
} else {
  console.log(`bento check — ${report.title ?? input}`)
  console.log(`  ${report.slides} slides (${report.shown} shown), ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}${report.measured === false ? ' (text not measured: no layout)' : ''}, ${wall} ms`)
  if (dropped.length) {
    console.log(`\n  dropped on load (${dropped.length}):`)
    for (const d of dropped) console.log(`    ${d.path}  ${d.reason}`)
  }
  if (out.expanded) console.log(`  compact expansion filled ${out.expanded} field${out.expanded === 1 ? '' : 's'}`)
  const bySlide = new Map()
  for (const f of findings) {
    const k = f.slide ?? '(document)'
    if (!bySlide.has(k)) bySlide.set(k, [])
    bySlide.get(k).push(f)
  }
  for (const [slide, list] of bySlide) {
    console.log(`\n  ${slide}`)
    for (const f of list) {
      const where = f.element ? ` [${f.element}]` : ''
      const at = f.path ? `  (${f.path})` : ''
      console.log(`    ${f.severity.padEnd(7)} ${f.code}${where}: ${f.message}${at}`)
    }
  }
  if (written.length) {
    console.log(`\n  images: ${out.pages.length} page${out.pages.length === 1 ? '' : 's'} in ${pngDir}${out.contact ? ' + contact.png' : ''}`)
  }
  console.log(`\n${out.ok ? 'OK' : 'FAILED'} (--fail-on ${failOn})`)
}
process.exit(out.ok ? 0 : 1)
