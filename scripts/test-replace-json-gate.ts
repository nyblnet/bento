// The gate that document JSON passes when it replaces the open deck:
// window.bento.loadDoc and "Replace from JSON…", both through
// parseDocInputReport (compactload.ts) → sanitizeDoc (restoregate.ts).
//
// Two halves, the same shape as scripts/test-sanitize.ts:
//   * node — the gate's output is pure data: identity comes from the OPEN deck,
//     unknown keys/props are dropped, slide.background loses its url() and a font
//     descriptor cannot carry an src-breakout;
//   * a browser — the gated document is rendered and its fonts injected while a
//     local server logs every request. Positive controls (raw, un-gated) MUST
//     fetch, so the zeros that follow are a boundary and not an artefact.
//
// EMBARGOED companion to working/team/handoffs/security-finding-replace-from-json.md.
// Move to scripts/ and register in CI when the fix publishes. Needs Chrome for
// the browser half; it self-skips (loudly) where there is none.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { parseDocInputReport } from '../slides/src/compactload.ts'
import { newDoc } from '../slides/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.error(`  ✗ ${msg}`) } else { console.log(`  ✓ ${msg}`) }
}
const repoFile = (rel: string): string => {
  const file = path.resolve(rel)
  if (!fs.existsSync(file)) throw new Error(`run from the repo root — ${rel} not found`)
  return file
}

// --- 1. the gate's output, in node ------------------------------------------
console.log('\nthe document gate, as data\n')

const live = newDoc() as any
live.docId = 'LIVE-DOCID-123'
live.collab = { on: true, room: 'wLIVEROOM', key: 'LIVEKEY' }
live.readonly = false

const foreign = () => {
  const d = newDoc() as any
  d.docId = 'FOREIGN-DOCID-999'
  d.collab = { on: true, room: 'wFOREIGN', key: 'FOREIGNKEY' }
  d.readonly = true
  d.evilUnknownDocKey = 'drop-me'
  d.assets = { srcasset: 'https://evil.example/x.woff2', okfont: 'data:font/woff2;base64,d09GMgABAAAAAAAA' }
  d.fonts = [
    { family: 'FamSrc', asset: 'srcasset', weight: 'normal', style: 'normal' },
    { family: 'FamStyle', asset: 'okfont', weight: 'normal', style: 'normal;src:url("https://evil.example/s.woff2")' },
  ]
  d.slides[0].background = 'url(https://evil.example/bg.png)'
  d.slides[0].elements = [{
    id: 't1', type: 'text', x: 10, y: 10, w: 300, h: 60, rotation: 0, opacity: 1,
    html: 'hi', fontFamily: 'FamSrc', fontSize: 28, fontWeight: 400, color: '#000', align: 'left',
    evilUnknownProp: 'drop-me',
  }]
  return d
}

const gated = parseDocInputReport(JSON.stringify(foreign()), { live, fit: false })
ok(!!gated, 'the gate accepts a valid full document')
if (gated) {
  const g: any = gated.doc
  ok(g.docId === 'LIVE-DOCID-123', 'identity — docId is the open deck’s, not the pasted one')
  ok(!!g.collab && g.collab.room === 'wLIVEROOM', 'identity — collab is the open deck’s room')
  ok(g.readonly === false, 'identity — readonly is the open deck’s')
  ok(!('evilUnknownDocKey' in g), 'an unknown document key is dropped')
  ok(!(g.slides[0].elements[0] ?? {}).evilUnknownProp, 'an unknown element prop is dropped')
  ok(gated.report.dropped.some((d: any) => /evilUnknownDocKey/.test(d.path)), 'the drop is reported to the caller')
  ok(!String(g.slides[0].background ?? '').includes('evil.example'), 'slide.background loses its external url()')
  ok(!/src\s*:/i.test((g.fonts ?? []).map((f: any) => String(f.style ?? '')).join('|')),
    'a font style descriptor cannot carry an src breakout')
}
// a compact document is gated the same way
const compact = parseDocInputReport(JSON.stringify({ compact: true, slides: [{ elements: [[{ type: 'text', html: 'x' }]] }], evilUnknownDocKey: 'drop-me' }), { live, fit: false })
ok(!!compact && !('evilUnknownDocKey' in (compact.doc as any)), 'a compact document passes the same gate (unknown key dropped)')
ok(!!compact && (compact.doc as any).docId === 'LIVE-DOCID-123', 'a compact document keeps the open deck’s identity too')

// --- 2. the render + font walk, in a browser --------------------------------
const CHROME = [
  process.env.BENTO_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p): p is string => !!p && fs.existsSync(p))
  ?? (spawnSync('which', ['google-chrome']).status === 0 ? 'google-chrome' : undefined)

const probeSource = (compactloadPath: string, renderPath: string, fontsPath: string, modelPath: string) => `
import { parseDocInputReport } from ${JSON.stringify(compactloadPath)}
import { renderSlide } from ${JSON.stringify(renderPath)}
import { injectFonts } from ${JSON.stringify(fontsPath)}
import { newDoc } from ${JSON.stringify(modelPath)}
const O = location.origin
const txt = (id, y, fam, extra) => ({ id, type: 'text', x: 10, y, w: 300, h: 60, rotation: 0, opacity: 1,
  html: 'The quick brown fox', fontFamily: fam, fontSize: 28, fontWeight: 400, color: '#000', align: 'left', ...(extra || {}) })
function craft(tag){
  const d = newDoc()
  d.docId = 'FOREIGN'; d.collab = { on: true, room: 'wF', key: 'K' }; d.readonly = true
  d.assets = { srcasset: O + '/font-src-' + tag, okfont: 'data:font/woff2;base64,d09GMgABAAAAAAAA' }
  d.fonts = [ { family: 'FamSrc', asset: 'srcasset', weight: 'normal', style: 'normal' },
    { family: 'FamStyle', asset: 'okfont', weight: 'normal', style: 'normal;src:url("' + O + '/font-style-' + tag + '")' } ]
  d.slides[0].background = 'url(' + O + '/bg-' + tag + ')'
  d.slides[0].elements = [ txt('t1', 10, 'FamSrc'), txt('t2', 90, 'FamStyle') ]
  return d
}
function drawAndMount(doc){
  const s = renderSlide(doc.slides[0], doc); s.style.width='400px'; s.style.height='225px'
  document.body.appendChild(s); void s.offsetHeight; s.getBoundingClientRect()
  injectFonts(doc); void (document.getElementById('bento-fonts')||{}).offsetHeight
}
;(async () => {
  // POSITIVE controls prove the BROWSER fetches these, independent of the code
  // under test. slide.background goes through renderSlide (not the guard —
  // renderSlide applies whatever it is given). The font faces are written by
  // hand, NOT through injectFonts, because injectFonts is now itself the guard;
  // a used family with an external src, and the last-wins src of a style
  // breakout, must both reach the server here.
  const rawDoc = craft('raw'); const rs = renderSlide(rawDoc.slides[0], rawDoc)
  rs.style.width = '400px'; rs.style.height = '225px'; document.body.appendChild(rs); void rs.offsetHeight
  const face = document.createElement('style')
  face.textContent =
    '@font-face{font-family:RawSrc;src:url("' + O + '/font-src-raw");font-display:swap}' +
    '@font-face{font-family:RawStyle;src:url("data:font/woff2;base64,d09GMgABAAAAAAAA");font-style:normal;src:url("' + O + '/font-style-raw");font-display:swap}'
  document.head.appendChild(face)
  for (const fam of ['RawSrc', 'RawStyle']) {
    const dv = document.createElement('div'); dv.style.fontFamily = fam; dv.style.fontSize = '28px'
    dv.textContent = 'The quick brown fox'; document.body.appendChild(dv); void dv.offsetHeight
  }
  // the same input, gated with the open deck live — must reach zero times. This
  // is the real path: parseDocInputReport → renderSlide → injectFonts.
  const live = newDoc(); live.docId = 'LIVE'; live.collab = { on: true, room: 'wLIVE', key: 'K' }; live.readonly = false
  const parsed = parseDocInputReport(JSON.stringify(craft('gated')), { live, fit: false })
  if (parsed) drawAndMount(parsed.doc)
  setTimeout(async () => {
    try { await fetch(O + '/fence', { cache: 'no-store' }) } catch {}
    const pre = document.createElement('pre'); pre.id = 'bento-results'; pre.textContent = 'DONE'
    document.body.appendChild(pre)
  }, 500)
})()
`

async function runBrowserSection(chrome: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-rjgate-'))
  const entry = path.join(tmp, 'probe.ts')
  fs.writeFileSync(entry, probeSource(
    repoFile('slides/src/compactload.ts'), repoFile('slides/src/render.ts'),
    repoFile('slides/src/fonts.ts'), repoFile('slides/src/model.ts')))
  execFileSync(repoFile('slides/node_modules/.bin/esbuild'),
    [entry, '--bundle', '--format=esm', '--outfile=' + path.join(tmp, 'probe.js')], { stdio: 'pipe' })
  const bundle = fs.readFileSync(path.join(tmp, 'probe.js'), 'utf8')
  const page = '<!doctype html><meta charset="utf-8"><body>'
    + '<scr' + 'ipt type="module" src="/probe.js"></scr' + 'ipt>'
    + '<img src="/slow.gif" width="1" height="1" alt=""></body>'
  const hits: string[] = []
  const gif = (res: http.ServerResponse) => { res.writeHead(200, { 'content-type': 'image/gif' }); res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')) }
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]; hits.push(url)
    if (url === '/probe.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle); return }
    if (url === '/probe.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); return }
    if (url === '/slow.gif') { setTimeout(() => gif(res), 1500); return }
    gif(res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const dom: string = await new Promise((resolve) => {
    const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
      '--disable-sync', '--disable-default-apps', '--user-data-dir=' + path.join(tmp, 'profile'),
      '--virtual-time-budget=4000', '--dump-dom', `http://127.0.0.1:${port}/probe.html`], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''; child.stdout.on('data', (b: Buffer) => { out += b.toString('utf8') })
    const kill = setTimeout(() => child.kill('SIGKILL'), 45_000)
    child.on('close', () => { clearTimeout(kill); resolve(out) })
  })
  try {
    ok(dom.includes('DONE'), 'the probe ran to the end')
    ok(hits.includes('/fence'), 'the fence arrived — the hit list is complete')
    ok(hits.includes('/bg-raw'), 'positive — a raw slide.background url() fetches')
    ok(hits.includes('/font-src-raw'), 'positive — a raw font whose asset value is a url fetches')
    ok(hits.includes('/font-style-raw'), 'positive — a raw font style src-breakout fetches')
    ok(!hits.includes('/bg-gated'), 'gated — slide.background does not fetch')
    ok(!hits.includes('/font-style-gated'), 'gated — a font style src-breakout does not fetch')
    ok(!hits.includes('/font-src-gated'), 'gated — a font whose asset value is a url does not fetch')
  } finally {
    server.close(); fs.rmSync(tmp, { recursive: true, force: true })
  }
}

console.log('\nthe render and font walk, in a browser')
if (!CHROME) {
  console.log('  ⚠ SKIPPED — no Chrome. Set BENTO_CHROME; this is the half that proves the render does not phone home.')
} else {
  await runBrowserSection(CHROME)
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
