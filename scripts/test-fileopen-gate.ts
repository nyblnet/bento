// Security regression rig for the FILE-OPEN / BOOT document path.
//
// On 1.2.5 main, opening a foreign .bento.html (editor.ts openFile :2772) and
// booting a directly-opened file (main.ts :82) both run `parseDoc(json)` →
// replaceDoc → renderSlide + injectFonts, with NO structural gate. That exposes
// the document-level egress surfaces the element sanitiser never sees:
//   * slide.background: url(https://…)  — fetched at render
//   * doc.fonts[] weight/style interpolated raw into the boot @font-face — a
//     src-breakout fetch when the family is used
//   * a font whose asset VALUE is an external url — src:url("http…")
// Option A (security-decision-fileopen-additivity.md) adds VALUE-LEVEL guards to
// this path: neutralise those three by value, keep the FILE's own identity, and
// PRESERVE unknown keys/props (format additivity — the A-vs-B discriminator).
//
// Assertions encode the POST-FIX expectation. Against the baseline (no patch)
// the egress rows are RED (they fetch) while the additivity + identity rows are
// GREEN — the expected "still vulnerable" picture. When Option A lands, swap the
// one-line transform seam below and every row goes green.
//
// EMBARGOED companion to security-decision-fileopen-additivity.md. Move to
// scripts/ + CI when the fix publishes. Browser half needs Chrome; self-skips.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { parseDoc, newDoc } from '../slides/src/model.ts'
import { guardOpenedDoc } from '../slides/src/restoregate.ts'

let failures = 0, checks = 0
const ok = (cond: boolean, msg: string) => { checks++; if (!cond) { failures++; console.error(`  ✗ ${msg}`) } else console.log(`  ✓ ${msg}`) }
const repoFile = (rel: string): string => { const f = path.resolve(rel); if (!fs.existsSync(f)) throw new Error(`run from repo root — ${rel} missing`); return f }

// ─── THE FILE-OPEN TRANSFORM SEAM ───────────────────────────────────────────
// Baseline (3a26dba7) = parseDoc alone, the ungated path editor.ts:2772 /
// main.ts:82 use today. When slides' Option A patch lands, replace this ONE line
// with the patched transform (confirm the exported name — e.g.
//   import { gateOpenedDoc } from '../slides/src/<file>.ts'
//   return gateOpenedDoc(parseDoc(json))
// ) and re-run: the egress rows flip green, the additivity rows stay green.
// Wired to the patched transform: parseDoc, then the value-level guard every
// file-open path runs (restoregate.ts guardOpenedDoc — main.ts boot and unlock,
// editor.ts open-a-file), which neutralises in place.
const fileOpenTransform = (json: string): any => { const d = parseDoc(json); if (d) guardOpenedDoc(d); return d }
// ─────────────────────────────────────────────────────────────────────────────

const FILE_DOCID = 'FILE-OWN-DOCID-777'
const foreignJson = () => JSON.stringify((() => {
  const d = newDoc() as any
  d.docId = FILE_DOCID                                  // the file's OWN identity — file-open keeps it
  d.collab = { on: true, room: 'wFILEROOM', key: 'FILEKEY' }
  d.futureUnknownDocKey = 'survives (a newer deck)'     // additivity: must be preserved
  d.assets = { srcasset: 'https://evil.example/x.woff2', okfont: 'data:font/woff2;base64,d09GMgABAAAAAAAA' }
  d.fonts = [
    { family: 'FamSrc', asset: 'srcasset', weight: 'normal', style: 'normal' },
    { family: 'FamStyle', asset: 'okfont', weight: 'normal', style: 'normal;src:url("https://evil.example/s.woff2")' },
  ]
  d.slides[0].background = 'url(https://evil.example/bg.png)'
  d.slides[0].elements = [{
    id: 't1', type: 'text', x: 10, y: 10, w: 300, h: 60, rotation: 0, opacity: 1,
    html: 'hi', fontFamily: 'FamSrc', fontSize: 28, fontWeight: 400, color: '#000', align: 'left',
    futureUnknownProp: 'survives (a newer element field)',
  }]
  return d
})())

// ── 1. the transform's output, in node ──────────────────────────────────────
console.log('\nthe file-open transform, as data\n')
const g: any = fileOpenTransform(foreignJson())
ok(!!g, 'the transform accepts a valid full document')
if (g) {
  // identity — file-open keeps the FILE's own (it does NOT force a live deck, unlike loadDoc/Replace)
  ok(g.docId === FILE_DOCID, 'identity — the opened file keeps its OWN docId (a shared file still finds its recovery / joins its room)')
  // additivity — the A-vs-B discriminator: unknowns must SURVIVE (A), not be dropped (B)
  ok('futureUnknownDocKey' in g, 'additivity — an unknown top-level key from a NEWER deck survives the open')
  ok(!!(g.slides?.[0]?.elements?.[0] ?? {}).futureUnknownProp, 'additivity — an unknown element field from a NEWER deck survives the open')
  // structural egress neutralisation — POST-FIX expectation (RED on baseline)
  ok(!String(g.slides?.[0]?.background ?? '').includes('evil.example'), 'slide.background loses its external url()')
  ok(!/src\s*:/i.test((g.fonts ?? []).map((f: any) => String(f.style ?? '')).join('|')), 'a font style descriptor cannot carry an src breakout')
}

// ── 2. render + font walk, in a browser ──────────────────────────────────────
const CHROME = [process.env.BENTO_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .find((p): p is string => !!p && fs.existsSync(p)) ?? (spawnSync('which', ['google-chrome']).status === 0 ? 'google-chrome' : undefined)

const probeSource = (modelPath: string, renderPath: string, fontsPath: string, gatePath: string) => `
import { parseDoc, newDoc } from ${JSON.stringify(modelPath)}
import { guardOpenedDoc } from ${JSON.stringify(gatePath)}
import { renderSlide } from ${JSON.stringify(renderPath)}
import { injectFonts } from ${JSON.stringify(fontsPath)}
const O = location.origin
// SEAM mirror — keep identical to the node seam above.
const fileOpenTransform = (json) => { const d = parseDoc(json); if (d) guardOpenedDoc(d); return d }
const txt = (id, y, fam, extra) => ({ id, type: 'text', x: 10, y, w: 300, h: 60, rotation: 0, opacity: 1,
  html: 'The quick brown fox', fontFamily: fam, fontSize: 28, fontWeight: 400, color: '#000', align: 'left', ...(extra || {}) })
function craft(tag){
  const d = newDoc(); d.docId = 'FILE'; d.collab = { on: true, room: 'wF', key: 'K' }
  d.assets = { srcasset: O + '/font-src-' + tag, okfont: 'data:font/woff2;base64,d09GMgABAAAAAAAA' }
  d.fonts = [ { family: 'FamSrc', asset: 'srcasset', weight: 'normal', style: 'normal' },
    { family: 'FamStyle', asset: 'okfont', weight: 'normal', style: 'normal;src:url("' + O + '/font-style-' + tag + '")' } ]
  d.slides[0].background = 'url(' + O + '/bg-' + tag + ')'
  d.slides[0].elements = [ txt('t1', 10, 'FamSrc'), txt('t2', 90, 'FamStyle') ]
  return JSON.stringify(d)
}
function drawAndMount(doc){
  const s = renderSlide(doc.slides[0], doc); s.style.width='400px'; s.style.height='225px'
  document.body.appendChild(s); void s.offsetHeight; s.getBoundingClientRect()
  injectFonts(doc); void (document.getElementById('bento-fonts')||{}).offsetHeight
}
;(async () => {
  // POSITIVE controls — prove the BROWSER fetches these, independent of the code
  // under test. slide.background via renderSlide (not a guard). The @font-face
  // faces are written by hand (NOT injectFonts, which Option A may make a guard).
  const raw = parseDoc(craft('raw')); const rs = renderSlide(raw.slides[0], raw)
  rs.style.width='400px'; rs.style.height='225px'; document.body.appendChild(rs); void rs.offsetHeight
  const face = document.createElement('style')
  face.textContent =
    '@font-face{font-family:RawSrc;src:url("' + O + '/font-src-raw");font-display:swap}' +
    '@font-face{font-family:RawStyle;src:url("data:font/woff2;base64,d09GMgABAAAAAAAA");font-style:normal;src:url("' + O + '/font-style-raw");font-display:swap}'
  document.head.appendChild(face)
  for (const fam of ['RawSrc','RawStyle']){ const dv=document.createElement('div'); dv.style.fontFamily=fam; dv.style.fontSize='28px'; dv.textContent='The quick brown fox'; document.body.appendChild(dv); void dv.offsetHeight }
  // the REAL path: fileOpenTransform → renderSlide + injectFonts. Must reach zero
  // once Option A lands; on the baseline these FETCH (vulnerable).
  drawAndMount(fileOpenTransform(craft('gated')))
  setTimeout(async () => {
    try { await fetch(O + '/fence', { cache: 'no-store' }) } catch {}
    const pre = document.createElement('pre'); pre.id='bento-results'; pre.textContent='DONE'; document.body.appendChild(pre)
  }, 500)
})()
`

async function runBrowser(chrome: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-fo-'))
  const entry = path.join(tmp, 'probe.ts')
  fs.writeFileSync(entry, probeSource(repoFile('slides/src/model.ts'), repoFile('slides/src/render.ts'), repoFile('slides/src/fonts.ts'), repoFile('slides/src/restoregate.ts')))
  execFileSync(repoFile('slides/node_modules/.bin/esbuild'), [entry, '--bundle', '--format=esm', '--outfile=' + path.join(tmp, 'probe.js')], { stdio: 'pipe' })
  const bundle = fs.readFileSync(path.join(tmp, 'probe.js'), 'utf8')
  const page = '<!doctype html><meta charset="utf-8"><body>' + '<scr' + 'ipt type="module" src="/probe.js"></scr' + 'ipt>' + '<img src="/slow.gif" width="1" height="1"></body>'
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
    const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
      '--user-data-dir=' + path.join(tmp, 'profile'), '--virtual-time-budget=4000', '--dump-dom', `http://127.0.0.1:${port}/probe.html`], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''; child.stdout.on('data', (b: Buffer) => { out += b.toString('utf8') })
    const k = setTimeout(() => child.kill('SIGKILL'), 45_000); child.on('close', () => { clearTimeout(k); resolve(out) })
  })
  try {
    ok(dom.includes('DONE'), 'the probe ran to the end')
    ok(hits.includes('/fence'), 'the fence arrived — the hit list is complete')
    ok(hits.includes('/bg-raw'), 'positive — a raw slide.background url() fetches')
    ok(hits.includes('/font-src-raw'), 'positive — a raw external @font-face src fetches')
    ok(hits.includes('/font-style-raw'), 'positive — a raw style src-breakout fetches')
    ok(!hits.includes('/bg-gated'), 'file-open — slide.background does NOT fetch')
    ok(!hits.includes('/font-src-gated'), 'file-open — a font whose asset value is a url does NOT fetch')
    ok(!hits.includes('/font-style-gated'), 'file-open — a font style src-breakout does NOT fetch')
    console.log('requests:', JSON.stringify(hits.filter((h) => !['/probe.html', '/probe.js', '/slow.gif'].includes(h))))
  } finally { server.close(); fs.rmSync(tmp, { recursive: true, force: true }) }
}

console.log('\nthe render and font walk, in a browser')
if (!CHROME) console.log('  ⚠ SKIPPED — no Chrome. Set BENTO_CHROME; this is the half that proves the open does not phone home.')
else await runBrowser(CHROME)
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
