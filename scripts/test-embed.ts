#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Beta build: the `embed` element.
//
//   slides/node_modules/.bin/esbuild scripts/test-embed.ts --bundle \
//     --platform=node --format=esm --outfile="$TMPDIR/test-embed.mjs" \
//     && node --no-warnings "$TMPDIR/test-embed.mjs"
//
// (Bundled, not run directly: clipboard.ts and render.ts import './model'
// extensionless, the same reason test-clipboard.ts is bundled in CI. Source
// paths are therefore resolved from the REPO ROOT.)
//
// WHAT THIS PROVES. An embed is built to upstream's `bento/embed` shape
// (docs/DECISIONS.md, 2026-08-19): a static `view` that always paints, a
// `doc` source, and a live sandboxed iframe that is opt-in. Beta adds
// `app: 'web'` with a `url`. Four things have to hold or the element is a
// liability rather than a feature:
//
//   1. THE FORMAT KNOWS IT. modelkeys.generated.ts carries the embed keys, so
//      validate() neither flags them as unknown nor goes quiet on a typo.
//   2. THE VIEW IS UNTRUSTED MARKUP. It is painted through the same sanitiser
//      the svg element uses; a <script> inside it never reaches the DOM.
//   3. BOTH KINDS OF OFFLINE SUPPRESS THE FRAME. Bento's offline switch is a
//      privacy promise ("nothing leaves this computer"); conference wifi is
//      network absence. Different states, same answer: the view shows, no
//      iframe is created, and the server sees no request.
//   4. IT ROUND-TRIPS. Paste carries `view` and `url`, mints a new id, and an
//      `asset:` view travels with its bytes.
//
// The decision that gates the frame is a pure function (liveFrameAllowed), so
// the node half stubs `navigator.onLine` and the offline switch and inspects
// it directly. The DOM half runs in a real Chrome against the real
// renderSlide, with the frame's url pointing at a throwaway http server on
// 127.0.0.1, so "did anything leave" is answered by a request log. Where there
// is no Chrome it says so loudly and skips, as test-sanitize.ts does.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setOffline } from '../kernel/src/net.ts'
import type { BentoDoc, SlideElement } from '../slides/src/model.ts'
import { newDoc } from '../slides/src/model.ts'
import { MODEL_KEYS } from '../slides/src/modelkeys.generated.ts'
import { validateDoc } from '../slides/src/validate.ts'
import { sanitizeElement } from '../slides/src/untrusted.ts'
import { insertElements, parseClip, serializeElements } from '../slides/src/editor/clipboard.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const repoFile = (rel: string): string => {
  const file = path.resolve(rel)
  if (!fs.existsSync(file)) throw new Error(`run this rig from the repo root, ${rel} not found`)
  return file
}

// render.ts is loaded dynamically so a build without the helper still reports
// every other check instead of failing at bundle time on a missing export.
const render = await import('../slides/src/render.ts') as Record<string, unknown>
const liveFrameAllowed = render.liveFrameAllowed as ((el: unknown) => boolean) | undefined

const VIEW = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="10" height="10"/></svg>'

const embed = (partial: Record<string, unknown> = {}) => ({
  id: 'em1', type: 'embed', x: 0, y: 0, w: 640, h: 360, rotation: 0, opacity: 1,
  app: 'web', view: VIEW, url: 'https://example.com/live', live: true,
  ...partial,
}) as unknown as SlideElement

const deckWith = (el: SlideElement): BentoDoc => {
  const doc = newDoc()
  doc.slides[0].elements = [el]
  return doc
}

const findings = (doc: BentoDoc, code: string) =>
  validateDoc(doc, { measure: false }).findings.filter((f) => f.code === code)

// ------------------------------------------------------------ 1. the format
console.log('\nthe format knows the element')

const embedKeys = (MODEL_KEYS.element as Record<string, readonly string[] | undefined>).embed
ok(!!embedKeys, 'modelkeys.generated.ts carries an `embed` element')
for (const k of ['app', 'view', 'doc', 'url', 'live', 'id', 'x', 'y', 'w', 'h', 'fx', 'themeRefs']) {
  ok(!!embedKeys?.includes(k), `embed key list includes "${k}"`)
}

ok(findings(deckWith(embed({ doc: { rows: [] } })), 'unknown-key').length === 0,
  'validate() reports no unknown-key for app/view/doc/url/live')
// The discriminating half: an unknown TYPE skips the unknown-key loop
// entirely, so "no unknown-key" alone would pass on a build that has never
// heard of embeds. A bogus key on a known embed must still be reported.
ok(findings(deckWith(embed({ bogus: 1 })), 'unknown-key').some((f) => f.path === 'bogus'),
  'and a bogus key on an embed IS reported: the element is known, not skipped')

ok(findings(deckWith(embed({ view: '' })), 'embed-missing-view').some((f) => f.severity === 'error'),
  'a missing view is an error: the element would paint as a hole offline')
ok(findings(deckWith(embed({ view: 'https://example.com/poster.svg' })), 'embed-remote-view')
  .some((f) => f.severity === 'warning'),
  'a remote view is a warning: it breaks the offline guarantee')
ok(findings(deckWith(embed({ view: 'asset:nope' })), 'missing-asset').some((f) => f.path === 'view'),
  'an asset: view that is not in doc.assets is a missing-asset error')
ok(findings(deckWith(embed()), 'embed-missing-view').length === 0
  && findings(deckWith(embed()), 'embed-remote-view').length === 0,
  'an inline svg view is clean')

// --------------------------------------------------------- 2. the intake
console.log('\nthe paste boundary keeps the shape')

const kept = sanitizeElement(embed({ doc: 'asset:src-1' })) as Record<string, unknown> | null
ok(!!kept && kept.type === 'embed', 'sanitizeElement keeps an embed')
ok(kept?.app === 'web' && kept?.view === VIEW && kept?.url === 'https://example.com/live' && kept?.live === true,
  'and keeps app, view, url and live')
ok(kept?.doc === 'asset:src-1', 'a string doc (asset ref) survives')
ok((sanitizeElement(embed({ doc: { series: [1, 2] } })) as Record<string, unknown> | null)?.doc !== undefined,
  'a plain-JSON doc survives')
ok((sanitizeElement(embed({ url: 'javascript:alert(1)' })) as Record<string, unknown> | null)?.url === undefined,
  'a javascript: url is dropped')
ok((sanitizeElement(embed({ live: 'yes' })) as Record<string, unknown> | null)?.live === undefined,
  'a non-boolean live is dropped')

// -------------------------------------------------------- 3. copy / paste
console.log('\ncopy and paste round-trips')
{
  const source = newDoc()
  source.assets = { 'view-1': VIEW }
  const el = embed({ view: 'asset:view-1' })
  source.slides[0].elements = [el]
  const clip = parseClip(serializeElements([el], source))
  ok(!!clip?.elements?.length, 'a serialized embed parses back as a clip')
  ok(clip?.assets?.['view-1'] === VIEW, 'the asset: view travels with its bytes')

  const target = newDoc()
  target.assets = { 'view-1': '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>' }
  const pasted = clip ? insertElements(clip, target, target.slides[0]) : []
  const p = pasted[0] as unknown as Record<string, unknown> | undefined
  ok(!!p && p.type === 'embed', 'insertElements pastes an embed')
  ok(p?.id !== 'em1' && typeof p?.id === 'string' && p.id.startsWith('e'), 'with a freshly minted id')
  ok(p?.url === 'https://example.com/live' && p?.live === true && p?.app === 'web', 'carrying url, live and app')
  ok(typeof p?.view === 'string' && (p.view as string).startsWith('asset:') && p.view !== 'asset:view-1'
    && target.assets?.[(p?.view as string).slice(6)] === VIEW,
    'and a colliding asset key is remapped so the pasted view keeps ITS picture')
}

// ------------------------------------------------- 4. the frame decision
console.log('\nthe live frame decision')

const nav = (onLine: boolean) =>
  Object.defineProperty(globalThis, 'navigator', { value: { onLine }, configurable: true, writable: true })

ok(typeof liveFrameAllowed === 'function', 'render.ts exports liveFrameAllowed')
if (liveFrameAllowed) {
  setOffline(false)
  nav(true)
  ok(liveFrameAllowed(embed()), 'online, switch off, app web, https url, live: a frame is allowed')
  ok(!liveFrameAllowed(embed({ live: false })), 'live:false: no frame')
  ok(!liveFrameAllowed(embed({ live: undefined })), 'live absent: no frame (opt-in, never the default)')
  ok(!liveFrameAllowed(embed({ app: 'bento/dash' })), 'an app other than web: no frame (only web has a url)')
  ok(!liveFrameAllowed(embed({ url: undefined })), 'no url: no frame')
  ok(!liveFrameAllowed(embed({ url: 'javascript:alert(1)' })), 'a javascript: url, no frame')
  ok(!liveFrameAllowed(embed({ url: 'data:text/html,hi' })), 'a data: url, no frame')
  nav(false)
  ok(!liveFrameAllowed(embed()), 'AE2: navigator.onLine false, no frame, whatever the switch says')
  nav(true)
  setOffline(true)
  ok(!liveFrameAllowed(embed()), 'the offline switch on: no frame, even with a network')
  setOffline(false)
  ok(liveFrameAllowed(embed()), 'switch back off: the frame is allowed again')
  Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true, writable: true })
  ok(liveFrameAllowed(embed()), 'no navigator at all (a headless render) counts as online')
}

// --------------------------------------------------------- 5. in a browser
//
// The DOM half. Written without backticks or a dollar-brace so it can live
// in a template literal; every regex backslash is doubled for the same reason
// (test-sanitize.ts learned both the hard way).

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

const probeSource = (renderPath: string, modelPath: string, netPath: string) => `
import { renderSlide } from ${JSON.stringify(renderPath)}
import { newDoc } from ${JSON.stringify(modelPath)}
import { setOffline } from ${JSON.stringify(netPath)}

const O = location.origin
const results: Array<[string, boolean]> = []
const check = (name: string, pass: boolean) => { results.push([name, pass]) }
const VIEW = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect id="pic" width="10" height="10"/></svg>'

/** The shipping path: model → renderSlide → renderElement. */
function draw(partial: Record<string, unknown>, opts?: Record<string, unknown>): HTMLElement {
  const doc = newDoc()
  const slide = doc.slides[0]
  slide.elements = [{
    id: 'em1', type: 'embed', x: 0, y: 0, w: 320, h: 180, rotation: 0, opacity: 1,
    app: 'web', view: VIEW, live: true, ...partial,
  } as any]
  const surface = renderSlide(slide, doc, opts)
  document.body.appendChild(surface)
  return surface
}
const setOnLine = (v: boolean) =>
  Object.defineProperty(navigator, 'onLine', { get: () => v, configurable: true })

try {
  setOffline(false)
  setOnLine(true)

  // 1. the view is untrusted markup
  const hostile = draw({ live: false,
    view: '<svg viewBox="0 0 20 20"><rect id="pic" width="10" height="10"/><scr' + 'ipt>window.__pwn=1</scr' + 'ipt><rect onload="window.__pwn=2" width="1" height="1"/></svg>' })
  check('a <script> inside view is stripped, and the picture beside it is kept',
    hostile.querySelectorAll('script').length === 0 && !!hostile.querySelector('svg rect#pic')
    && !hostile.querySelector('[onload]') && !(window as any).__pwn)

  // 2. live, online, switch off: a sandboxed frame over the view
  const live = draw({ url: O + '/frame-online.html' }, { liveMedia: true })
  const frame = live.querySelector('iframe')
  check('online with the switch off: an iframe exists', !!frame)
  check('its src is the url', frame?.getAttribute('src') === O + '/frame-online.html')
  const sandbox = frame?.getAttribute('sandbox') ?? null
  check('it carries a sandbox attribute', sandbox !== null)
  check('and the sandbox lacks allow-same-origin', sandbox !== null && !/allow-same-origin/.test(sandbox)
    && !/allow-top-navigation/.test(sandbox))
  check('the view is still present under the frame', !!live.querySelector('svg rect#pic'))

  // 3. the frame fails: the handler removes it and the view shows
  frame?.dispatchEvent(new Event('error'))
  check('after error the frame is gone and the view remains',
    !live.querySelector('iframe') && !!live.querySelector('svg rect#pic'))

  // 4. AE2: no network
  setOnLine(false)
  const noNet = draw({ url: O + '/frame-offline.html' }, { liveMedia: true })
  check('navigator.onLine false: no iframe, view present',
    !noNet.querySelector('iframe') && !!noNet.querySelector('svg rect#pic'))
  setOnLine(true)

  // 5. the privacy switch, with a network
  setOffline(true)
  const switched = draw({ url: O + '/frame-switch.html' }, { liveMedia: true })
  check('offline switch on, network up: no iframe, view present',
    !switched.querySelector('iframe') && !!switched.querySelector('svg rect#pic'))
  setOffline(false)

  // 5b. the editor canvas (no liveMedia) never creates a frame: it re-renders
  // on every edit, and a frame there would re-navigate each time
  const canvas = draw({ url: O + '/frame-canvas.html' })
  check('a plain renderSlide (editor canvas) has no iframe and shows the view',
    !canvas.querySelector('iframe') && !!canvas.querySelector('svg rect#pic'))

  // 6. thumbnails never carry a frame
  const thumb = draw({ url: O + '/frame-thumb.html' }, { svgAsImage: true })
  check('a thumbnail render has no iframe and an inert <img> view',
    !thumb.querySelector('iframe') && !!thumb.querySelector('img'))

  // 7. an unknown app still paints its view: rendered, not rejected
  const foreign = draw({ app: 'bento/whatever', live: false })
  check('an unknown app renders its view', !!foreign.querySelector('svg rect#pic') && !foreign.querySelector('iframe'))

  // 8. no view at all: a placeholder, never an empty box
  const empty = draw({ view: '', live: false })
  check('an empty view shows a placeholder', (empty.textContent ?? '').trim().length > 0)
} catch (err) {
  check('the probe ran to the end (it threw: ' + String(err) + ')', false)
}

setTimeout(() => {
  const pre = document.createElement('pre')
  pre.id = 'bento-results'
  const utf8 = new TextEncoder().encode(JSON.stringify(results))
  pre.textContent = 'BENTO-RESULTS:' + btoa(String.fromCharCode(...utf8)) + ':END'
  document.body.appendChild(pre)
}, 400)
`

async function runBrowserSection(chrome: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-embed-'))
  const entry = path.join(tmp, 'probe.ts')
  fs.writeFileSync(entry, probeSource(
    repoFile('slides/src/render.ts'), repoFile('slides/src/model.ts'), repoFile('kernel/src/net.ts')))
  execFileSync(repoFile('slides/node_modules/.bin/esbuild'), [
    entry, '--bundle', '--format=esm', '--outfile=' + path.join(tmp, 'probe.js'),
  ], { stdio: 'pipe' })
  const bundle = fs.readFileSync(path.join(tmp, 'probe.js'), 'utf8')

  // Written by concatenation: never a literal script-close in a source file
  // (AGENTS.md #1). The trailing <img> is a LOAD GATE: --dump-dom fires at the
  // load event, the server answers /slow.gif late, and the probe's timer lands
  // first.
  const page =
    '<!doctype html><meta charset="utf-8"><title>bento embed probe</title>' +
    '<body>BENTO-PROBE' +
    '<scr' + 'ipt type="module" src="/probe.js"></scr' + 'ipt>' +
    '<img src="/slow.gif" width="1" height="1" alt=""></body>'

  const hits: string[] = []
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]
    hits.push(url)
    if (url === '/probe.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle); return }
    if (url === '/probe.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); return }
    if (url.startsWith('/frame-')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html>frame'); return }
    const gif = () => {
      res.writeHead(200, { 'content-type': 'image/gif' })
      res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'))
    }
    if (url === '/slow.gif') { setTimeout(gif, 1500); return }
    gif()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  // spawn, never spawnSync: the server lives in THIS process.
  const load = (route: string) => new Promise<string>((resolve) => {
    const child = spawn(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--no-default-browser-check', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--disable-default-apps',
      '--user-data-dir=' + path.join(tmp, 'profile'),
      '--virtual-time-budget=4000', '--dump-dom',
      `http://127.0.0.1:${port}${route}`,
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    let dom = ''
    child.stdout.on('data', (b: Buffer) => { dom += b.toString('utf8') })
    const done = setTimeout(() => child.kill('SIGKILL'), 45_000)
    child.on('close', () => { clearTimeout(done); resolve(dom) })
  })

  try {
    const dom = await load('/probe.html')
    const blob = /BENTO-RESULTS:([A-Za-z0-9+/=]+):END/.exec(dom)
    if (!blob) {
      const dumped = path.join(os.tmpdir(), 'bento-embed-dump.html')
      fs.writeFileSync(dumped, dom)
      ok(false, `the browser probe reported results (it did not; dumped DOM in ${dumped})`)
    } else {
      for (const [name, pass] of JSON.parse(Buffer.from(blob[1], 'base64').toString('utf8')) as Array<[string, boolean]>) {
        ok(pass, name)
      }
    }
    // The request log is the proof that matters: not "no iframe in the DOM"
    // but "nothing left the machine".
    ok(hits.includes('/frame-online.html'), 'the allowed frame was actually requested')
    ok(!hits.includes('/frame-offline.html'), 'AE2: nothing was requested with navigator.onLine false')
    ok(!hits.includes('/frame-switch.html'), 'nothing was requested with the offline switch on')
    ok(!hits.includes('/frame-thumb.html'), 'nothing was requested for a thumbnail')
  } finally {
    server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

console.log('\nthe element, in a browser')
if (!CHROME) {
  console.log('  ⚠ SKIPPED, no Chrome found. Set BENTO_CHROME to a binary to run this section;')
  console.log('    it is the only half that can prove the frame is not created.')
} else {
  await runBrowserSection(CHROME)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
