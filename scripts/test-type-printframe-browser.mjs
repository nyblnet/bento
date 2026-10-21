// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type's print frame is inert, and runs under the identity CSP.
//
//   npm run build:single --prefix type && node scripts/test-type-printframe-browser.mjs
//   node scripts/test-type-printframe-browser.mjs --emit <dir>   # write the engine harness only
//
// THE ONE EXCEPTION to "no frame a document can create is same-origin with
// scripts" (bento/connect gate-1 invariant 3) is type's print frame
// (print.ts printDocument): an UN-sandboxed, same-origin iframe filled with
// document.open/write/close, because the parent post-processes it (optical
// margin alignment). It is defended twice, and each defence covers the other's
// failure, so this rig asserts BOTH:
//
//   1. INERT BUILDER. buildPrintDocument emits only inert markup. A document
//      whose every printable field carries injection attempts is opened the way
//      a file is (bento.loadDoc → parseDoc) and printed through the real
//      builder (bento.printHtml). Parsed by the browser, the output holds no
//      <script>, no on* attribute, no javascript:/vbscript:/data:text/html URL,
//      no srcdoc, no frame/object/embed/base/meta-refresh/form, and one <style>
//      only (no breakout). Then the output is RUN the way print runs it — an
//      un-sandboxed same-origin frame, document.write, NO CSP — and nothing in
//      it reaches the parent. Positive control: the hostile strings are in the
//      printed text, so the builder rendered them rather than dropping them.
//
//   2. CSP INHERITANCE (per engine). A self-contained harness reproduces
//      print's exact mechanism under the identity CSP (hash-only script-src,
//      design §"CSP draft"): the frame's inline <script> and <img onerror> are
//      REFUSED, while the parent still reads and rewrites the frame's DOM (the
//      post-processing print needs). Control: the same harness with no CSP —
//      both fire. These are plain HTML files (--emit) so the SAME files are
//      loaded in every engine: Chromium here; WebKit measured in security §19a;
//      WebView2 and WebKitGTK by home-desktop (security §19c). Each writes its
//      verdict to document.title as JSON.
//
//   3. THE REAL PATH under the identity CSP. The packaged type shell, served
//      with a hash-only CSP built from its own inline scripts (as a host does
//      per document), boots, and the real printDocument builds its frame; the
//      frame inherits the policy (an inline script put into it is refused) and
//      the parent still reaches the frame's DOM.
//
// Mutations (run, judged by exit code): parseDoc keeping page/type values
// unchecked → the per-field rows still pass on print's CSS escape alone, and
// removing BOTH is red; print's CSS escape removed with parseDoc intact → green
// (parseDoc is the first defence) — the two are checked separately below; the
// harness CSP dropped → 2's CSP rows red (the control rows prove the probes fire).
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sha = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`

// ───────────────────────────────────────────── the per-engine harness (part 2)
// A whole page whose ONE script is hashed into its own CSP. It mirrors
// print.ts printDocument: an un-sandboxed iframe, document.open/write/close of
// print HTML, then parent-side DOM post-processing. The probe HTML adds the two
// vectors §19a measured: an inline <script> and an <img onerror>.
function harnessHtml(printHtml, { csp, ownMeta = false }) {
  // print writes its OWN meta CSP (script-src 'none') into the frame — a third
  // layer. To measure INHERITANCE, the harness strips it, so the parent's policy
  // is the only one the frame could have; ownMeta keeps it (the third layer).
  const base = ownMeta ? printHtml : printHtml.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, '')
  const probe = base.replace('</body>',
    '<script>top.__probe.script = 1</script><img src="x:" onerror="top.__probe.onerror = 1"></body>')
  const script = `
window.__probe = { script: 0, onerror: 0 };
var frame = document.createElement('iframe');
frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0';
document.body.appendChild(frame);
var win = frame.contentWindow;
win.document.open(); win.document.write(${JSON.stringify(probe).replace(/<\//g, '<\\/')}); win.document.close();
setTimeout(function () {
  var dom = false;
  try {
    var bodies = win.document.querySelectorAll('.t-body');
    if (bodies.length) { bodies[0].style.position = 'relative'; for (var i = 1; i < bodies.length; i++) bodies[i].innerHTML = bodies[0].innerHTML; }
    dom = bodies.length > 0 && win.document.querySelector('.t-body').style.position === 'relative';
  } catch (e) { dom = false }
  var r = { csp: ${JSON.stringify(csp ? 'hash-only' : 'none')}, ownMeta: ${ownMeta}, script: window.__probe.script, onerror: window.__probe.onerror, postProcessing: dom };
  window.__result = r; document.title = JSON.stringify(r);
}, 600);`
  const policy = csp
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${sha(script)}; style-src 'unsafe-inline'; img-src data: blob: https:; font-src data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'">`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8">${policy}<title>pending</title></head><body><script>${script}</script></body></html>`
}

const args = process.argv.slice(2)
const emitAt = args.indexOf('--emit')

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const SHELL = new URL('../type/dist-single/Bento_Type.bento.html', import.meta.url)
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
const dir = mkdtempSync(join(tmpdir(), 'bento-printframe-'))
const open = async (url) => {
  const p = await browser.newPage()
  await p.route(/^https?:/, (r) => r.abort())
  await p.goto(url)
  return p
}

// the values that print and the preview interpolate, each carrying a breakout
const BREAK = `x;}</style><script>top.__pwned=(top.__pwned||0)+1</script><style>`
// …and one that ends an ATTRIBUTE: some page values are written into a
// style="…" attribute (the footnote block), where only a quote breaks out
const QBREAK = `0" onmouseover="top.__pwned=1" data-x="`
const FIELDS = {
  'type.family': (d) => { d.type = { ...(d.type || {}), family: BREAK } },
  'type.size': (d) => { d.type = { ...(d.type || {}), size: BREAK } },
  'page.width': (d) => { d.page.width = BREAK }, 'page.height': (d) => { d.page.height = BREAK },
  'page.marginTop': (d) => { d.page.marginTop = BREAK }, 'page.marginX': (d) => { d.page.marginX = BREAK },
  'page.marginBottom': (d) => { d.page.marginBottom = BREAK }, 'page.marginLeft': (d) => { d.page.marginLeft = BREAK },
  'page.marginRight': (d) => { d.page.marginRight = BREAK },
}

try {
  // ───────────────────────── 0. the PREVIEW written into every saved file (first: the worst case)
  // A saved file carries a static first-page preview; a <style> inside it is
  // serialized raw, so a breakout there would plant a script that runs whenever
  // the saved file is opened — before the preview remover, with no CSP on
  // file://. Each value is put straight into the LIVE document, the way a
  // synced op lands (no parseDoc), then the file is saved and opened.
  console.log('\n0. the preview in a saved file stays inert, whatever a synced value carries\n')
  for (const [name, set] of Object.entries(FIELDS)) {
    const ctx = await browser.newContext({ acceptDownloads: true })
    await ctx.addInitScript(() => { delete window.showSaveFilePicker })   // → the download path
    await ctx.route(/^https?:/, (r) => r.abort())
    const p = await ctx.newPage()
    await p.goto(SHELL.href)
    await p.waitForFunction(() => window.bento?.doc)
    await p.evaluate(`const BREAK = ${JSON.stringify(BREAK)}; (${set.toString()})(window.bento.doc)`)
    const dl = p.waitForEvent('download', { timeout: 15000 })
    await p.evaluate(() => window.bento.save())
    const saved = readFileSync(await (await dl).path(), 'utf8')
    const at = saved.indexOf('data-bento-preview')
    const end = saved.indexOf('<script data-bento-preview', at)
    const frag = at >= 0 && end > at ? saved.slice(saved.lastIndexOf('<', at), end) : ''
    const scan = await p.evaluate((f) => {
      const t = document.createElement('template'); t.innerHTML = f
      return { scripts: t.content.querySelectorAll('script').length, styles: t.content.querySelectorAll('style').length }
    }, frag)
    const file = join(dir, `saved-${name}.bento.html`); writeFileSync(file, saved)
    const o = await ctx.newPage()
    await o.goto('file://' + file)
    await o.waitForFunction(() => window.bento?.doc, null, { timeout: 15000 }).catch(() => {})
    const ran = await o.evaluate(() => window.__pwned ?? 0)
    ok(frag.length > 0 && scan.scripts === 0 && scan.styles <= 1 && ran === 0,
      `${name}: the saved file's preview holds no script (${scan.scripts}) and no breakout (${scan.styles} style), and opening it runs nothing (${ran})${frag ? '' : ' — NO PREVIEW FOUND'}`)
    await ctx.close()
  }

  // ───── 0b. CSS-only payloads (NO `<`): only the use-site normalisation stops these
  // A value like `serif;}*{background:url(http://rc.test/…)}` carries no `<`,
  // so the `<` escape cannot see it: it is a rule injected into the print CSS
  // and into the preview saved in every file — a read receipt from any
  // thumbnailer. Set by a SYNCED op (no parseDoc). Two oracles: the payload
  // text appears nowhere in the print output or the saved preview, and no
  // request reaches rc.test while printing or opening the saved file.
  console.log('\n0b. CSS-only payloads (no `<`) from a synced op reach neither print nor the saved preview\n')
  const CSSP = (tag) => ({
    'type.family': (d) => { d.type = { ...(d.type || {}), family: `serif;}*{background:url(http://rc.test/${tag}-family)}` } },
    'type.size': (d) => { d.type = { ...(d.type || {}), size: `17px;}*{background:url(http://rc.test/${tag}-size)}` } },
    'page.width': (d) => { d.page.width = `100px;background:url(http://rc.test/${tag}-width)` },
    'page.height': (d) => { d.page.height = `100px;background:url(http://rc.test/${tag}-height)` },
    'page.marginTop': (d) => { d.page.marginTop = `10px;background:url(http://rc.test/${tag}-mt)` },
    'page.marginX': (d) => { d.page.marginX = `10px;background:url(http://rc.test/${tag}-mx)` },
    'page.marginBottom': (d) => { d.page.marginBottom = `10px;background:url(http://rc.test/${tag}-mb)` },
  })
  for (const name of Object.keys(CSSP('x'))) {
    const hits = []
    const ctx = await browser.newContext({ acceptDownloads: true })
    await ctx.addInitScript(() => { delete window.showSaveFilePicker })
    await ctx.route(/^https?:/, (r) => { if (r.request().url().includes('rc.test')) hits.push(r.request().url()); r.abort() })
    const p = await ctx.newPage()
    await p.goto(SHELL.href)
    await p.waitForFunction(() => window.bento?.doc)
    // a footnote, so the footnote block's style attribute is printed too
    await p.evaluate((j) => window.bento.loadDoc(j), JSON.stringify({ format: 'bento/type', docId: 'doc-css', title: 't',
      footnotes: { n1: 'note' }, body: [{ id: 'b1', kind: 'para', text: 'Hello', notes: [{ id: 'n1', at: 1 }] }] }))
    await p.evaluate(`const tag = 'p'; (${CSSP('p')[name].toString()})(window.bento.doc)`)
    const printed = await p.evaluate(async () => {
      const src = window.bento.printHtml()
      const f = document.createElement('iframe'); document.body.appendChild(f)
      f.contentWindow.document.open(); f.contentWindow.document.write(src); f.contentWindow.document.close()
      await new Promise((r) => setTimeout(r, 600)); f.remove()
      return src
    })
    const dl = p.waitForEvent('download', { timeout: 15000 })
    await p.evaluate(() => window.bento.save())
    const saved = readFileSync(await (await dl).path(), 'utf8')
    const at = saved.indexOf('data-bento-preview'), end = saved.indexOf('<script data-bento-preview', at)
    const preview = at >= 0 && end > at ? saved.slice(at, end) : ''
    const file = join(dir, `css-${name}.bento.html`); writeFileSync(file, saved)
    const o = await ctx.newPage(); await o.goto('file://' + file)
    await o.waitForFunction(() => window.bento?.doc, null, { timeout: 15000 }).catch(() => {})
    await o.waitForTimeout(400)
    ok(preview.length > 0 && !printed.includes('rc.test') && !preview.includes('rc.test') && hits.length === 0,
      `${name}: a CSS-only payload is in neither the print output (${printed.includes('rc.test')}) nor the saved preview (${preview.includes('rc.test')}), and nothing was requested (${hits.length})${preview ? '' : ' — NO PREVIEW FOUND'}`)
    await ctx.close()
  }

  // ─────────────────────────────────────────── 1. the builder emits inert markup
  const H = `"'><img src=x onerror="top.__pwned=(top.__pwned||0)+1"><script>top.__pwned=(top.__pwned||0)+1</script></style><style></style><script>top.__pwned=(top.__pwned||0)+1</script><svg onload="top.__pwned=(top.__pwned||0)+1"></svg><iframe srcdoc="x"></iframe><base href="javascript:1"><meta http-equiv="refresh" content="0;url=javascript:1">`
  const JS = 'javascript:top.__pwned=(top.__pwned||0)+1'
  const hostile = {
    format: 'bento/type', docId: 'doc-hostile', title: H, subtitle: H,
    meta: { author: H, company: H, subject: H },
    type: { family: `x;}</style><script>top.__pwned=(top.__pwned||0)+1</script><style>` },
    styles: { s1: { id: 's1', name: H, kind: 'para', family: H, color: `red;}</style><script>top.__pwned=1</script>` } },
    fonts: [{ family: H, asset: 'a1' }],
    footnotes: { n1: H },
    body: [
      { id: 'b1', kind: 'h1', text: 'H1 ' + H },
      { id: 'b2', kind: 'para', text: 'Para ' + H, styleId: 's1',
        marks: [{ t: 'link', from: 0, to: 4, href: JS }, { t: 'link', from: 5, to: 9, href: H }, { t: 'font', from: 0, to: 4, family: H }],
        notes: [{ id: 'n1', at: 4 }], fields: [{ at: 0, name: H }] },
      { id: 'b3', kind: 'quote', text: 'Quote ' + H },
      { id: 'b4', kind: 'ul', text: 'Item ' + H },
      { id: 'b5', kind: 'ol', text: 'Step ' + H },
      { id: 'b6', kind: 'cell', text: 'Head ' + H, cell: { table: 't1', cols: 1, head: true } },
      { id: 'b7', kind: 'cell', text: 'Cell ' + H, cell: { table: 't1', cols: 1 } },
      { id: 'b8', kind: 'caption', text: 'Caption ' + H },
      { id: 'b9', kind: 'image', text: '', image: { src: JS, alt: H } },
      { id: 'b10', kind: 'image', text: '', image: { src: `x" onerror="top.__pwned=1`, alt: 'a' } },
      { id: 'b11', kind: 'image', text: '', image: { src: 'data:text/html,<script>top.__pwned=1</script>', alt: 'a' } },
      { id: 'b12', kind: 'math', text: '\\text{' + H + '}' },
      { id: 'b13', kind: 'embed', text: '', embed: { app: 'bento/dash', view: `<svg onload="top.__pwned=1"><script>top.__pwned=1</script><foreignObject><img src=x onerror="top.__pwned=1"></foreignObject></svg>`, doc: {} } },
      { id: 'b14', kind: 'para', text: 'Tail ' + H },
    ],
  }
  console.log('\n1. the print builder emits inert markup\n')
  const p1 = await open(SHELL.href)
  await p1.waitForFunction(() => window.bento?.doc)
  const loaded = await p1.evaluate((j) => { try { return !!window.bento.loadDoc(j) } catch (e) { return String(e) } }, JSON.stringify(hostile))
  ok(loaded === true, `the hostile document opens through parseDoc (${loaded})`)
  const html = await p1.evaluate(() => window.bento.printHtml())
  const scan = await p1.evaluate((src) => {
    const d = new DOMParser().parseFromString(src, 'text/html')
    const all = [...d.querySelectorAll('*')]
    const onAttrs = all.flatMap((e) => [...e.attributes].filter((a) => /^on/i.test(a.name)).map((a) => `${e.tagName}[${a.name}]`))
    const badUrl = all.flatMap((e) => [...e.attributes]
      .filter((a) => /^(href|src|xlink:href|action|formaction|data|poster|background)$/i.test(a.name) && /^\s*(javascript|vbscript|data:text\/html)/i.test(a.value))
      .map((a) => `${e.tagName}[${a.name}=${a.value.slice(0, 30)}]`))
    return {
      scripts: d.querySelectorAll('script').length,
      onAttrs, badUrl,
      srcdoc: d.querySelectorAll('[srcdoc]').length,
      danger: d.querySelectorAll('iframe, frame, object, embed, base, form, link[rel=import]').length,
      metas: [...d.querySelectorAll('meta[http-equiv]')].map((m) => `${m.getAttribute('http-equiv')}: ${m.getAttribute('content')}`),
      styles: d.querySelectorAll('style').length,
      text: d.body.textContent,
      pages: d.querySelectorAll('.t-page').length,
    }
  }, html)
  ok(scan.pages >= 1 && (scan.text.match(/top\.__pwned/g) || []).length >= 8,
    `control: the hostile strings ARE in the printed text (${(scan.text.match(/top\.__pwned/g) || []).length} times, ${scan.pages} page(s)) — rendered, not dropped`)
  ok(scan.scripts === 0, `no <script> element (${scan.scripts})`)
  ok(scan.onAttrs.length === 0, `no on* attribute${scan.onAttrs.length ? ' — ' + scan.onAttrs.slice(0, 4).join(', ') : ''}`)
  ok(scan.badUrl.length === 0, `no javascript:/vbscript:/data:text/html URL${scan.badUrl.length ? ' — ' + scan.badUrl.slice(0, 4).join(', ') : ''}`)
  ok(scan.srcdoc === 0 && scan.danger === 0, `no srcdoc, frame, object, embed, base or form (${scan.srcdoc}, ${scan.danger})`)
  ok(scan.metas.length === 1 && /^Content-Security-Policy: script-src 'none'/i.test(scan.metas[0]),
    `the ONLY meta http-equiv is print's own CSP, script-src 'none' — no refresh, no other (${JSON.stringify(scan.metas)})`)
  ok(scan.styles === 1, `exactly one <style> — no breakout from the document's CSS (${scan.styles})`)
  // and RUN it the way print does, with no CSP: nothing reaches the parent
  const fired = await p1.evaluate(async (src) => {
    window.__pwned = 0
    const frame = document.createElement('iframe')
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0'
    document.body.appendChild(frame)
    const w = frame.contentWindow
    w.document.open(); w.document.write(src); w.document.close()
    await new Promise((r) => setTimeout(r, 800))
    const n = window.__pwned; frame.remove(); return n
  }, html)
  ok(fired === 0, `run the way print runs it (same-origin frame, document.write, NO CSP): nothing reaches the parent (${fired})`)

  // the same values reaching print WITHOUT parseDoc (a synced op): print's own
  // defences (readPage, safeFontFamily, cssNum, the CSS escape) must hold alone
  for (const [payloadName, payload] of [['</style>', BREAK], ['attribute quote', QBREAK]]) for (const [name, set] of Object.entries(FIELDS)) {
    // a footnote, so the footnote block (whose position is a style ATTRIBUTE
    // built from page.marginBottom) is printed too
    await p1.evaluate((j) => window.bento.loadDoc(j), JSON.stringify({ format: 'bento/type', docId: 'doc-sync', title: 't',
      footnotes: { n1: 'note' }, body: [{ id: 'b1', kind: 'para', text: 'p', notes: [{ id: 'n1', at: 1 }] }] }))
    await p1.evaluate(`const BREAK = ${JSON.stringify(payload)}; (${set.toString()})(window.bento.doc)`)
    const r = await p1.evaluate(() => {
      const d = new DOMParser().parseFromString(window.bento.printHtml(), 'text/html')
      return { scripts: d.querySelectorAll('script').length, styles: d.querySelectorAll('style').length, on: [...d.querySelectorAll('*')].some((e) => [...e.attributes].some((a) => /^on/i.test(a.name))), fn: !!d.querySelector('.t-fn') }
    })
    ok(r.scripts === 0 && r.styles === 1 && !r.on && (name !== 'page.marginBottom' || r.fn), `${name} set by a SYNCED op (no parseDoc) to a ${payloadName} breakout still prints inert (scripts ${r.scripts}, styles ${r.styles}, on* ${r.on}, footnote block ${r.fn})`)
  }

  // every document value print interpolates into its CSS, ONE AT A TIME, so a
  // regression names its field (each of these broke out of <style> before)
  const X = `x;}</style><script>top.__pwned=(top.__pwned||0)+1</script><style>`
  const base = { format: 'bento/type', docId: 'doc-field', title: 't', body: [{ id: 'b1', kind: 'para', text: 'p' }] }
  const fields = {
    'type.family': { type: { family: X } }, 'type.size': { type: { size: X } },
    'page.width': { page: { width: X } }, 'page.height': { page: { height: X } },
    'page.marginTop': { page: { marginTop: X } }, 'page.marginX': { page: { marginX: X } },
    'page.marginBottom': { page: { marginBottom: X } }, 'page.marginLeft': { page: { marginLeft: X } },
    'page.marginRight': { page: { marginRight: X } },
  }
  for (const [name, over] of Object.entries(fields)) {
    await p1.evaluate((j) => window.bento.loadDoc(j), JSON.stringify({ ...base, ...over }))
    const r = await p1.evaluate(async () => {
      const src = window.bento.printHtml()
      const d = new DOMParser().parseFromString(src, 'text/html')
      window.__pwned = 0
      const f = document.createElement('iframe'); document.body.appendChild(f)
      f.contentWindow.document.open(); f.contentWindow.document.write(src); f.contentWindow.document.close()
      await new Promise((res) => setTimeout(res, 200))
      const n = window.__pwned; f.remove()
      return { scripts: d.querySelectorAll('script').length, styles: d.querySelectorAll('style').length, fired: n }
    })
    ok(r.scripts === 0 && r.styles === 1 && r.fired === 0,
      `${name} carrying a </style> breakout stays inside the CSS (scripts ${r.scripts}, styles ${r.styles}, ran ${r.fired})`)
  }
  await p1.close()

  // ─────────────────────────────────────── 2. the frame inherits the identity CSP
  console.log('\n2. the print frame inherits the identity CSP (Chromium; the same files run on every engine)\n')
  const p2 = await open(SHELL.href)
  await p2.waitForFunction(() => window.bento?.doc)
  const realPrint = await p2.evaluate(() => window.bento.printHtml())
  await p2.close()
  const out = emitAt >= 0 ? args[emitAt + 1] : dir
  if (emitAt >= 0) mkdirSync(out, { recursive: true })
  for (const csp of [false, true]) writeFileSync(join(out, `printframe-${csp ? 'csp' : 'nocsp'}.html`), harnessHtml(realPrint, { csp }))
  writeFileSync(join(out, 'printframe-ownmeta.html'), harnessHtml(realPrint, { csp: false, ownMeta: true }))
  if (emitAt >= 0) {
    console.log(`  wrote printframe-nocsp.html, printframe-csp.html and printframe-ownmeta.html to ${out} — load each in the engine; its title is the verdict JSON`)
    process.exit(0)
  }
  const verdict = async (f) => {
    const p = await open('file://' + join(out, f))
    await p.waitForFunction(() => document.title !== 'pending', null, { timeout: 10000 })
    const r = JSON.parse(await p.title()); await p.close(); return r
  }
  const none = await verdict('printframe-nocsp.html')
  ok(none.script === 1 && none.onerror === 1 && none.postProcessing,
    `control, NO CSP: the frame's inline script AND onerror both run (${JSON.stringify(none)}) — the probes can fire`)
  const withCsp = await verdict('printframe-csp.html')
  ok(withCsp.script === 0 && withCsp.onerror === 0, `under the hash-only CSP the frame's inline script and onerror are REFUSED (${JSON.stringify(withCsp)})`)
  ok(withCsp.postProcessing === true, 'while the parent still reads and rewrites the frame\'s DOM — print\'s post-processing works')
  const own = await verdict('printframe-ownmeta.html')
  ok(own.script === 0 && own.onerror === 0 && own.postProcessing,
    `third layer: with NO parent CSP, print's own meta CSP (script-src 'none') still refuses both (${JSON.stringify(own)})`)

  // ────────────────────────────── 3. the real shell and real printDocument, under CSP
  console.log('\n3. the real shell and printDocument under the identity CSP\n')
  const shell = readFileSync(SHELL, 'utf8')
  // the hashes of the shell's EXECUTABLE inline scripts, as a host builds per document
  const execs = [...shell.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .filter((m) => !/\btype\s*=\s*["']?(?!text\/javascript|module)[^"'\s>]+/i.test(m[1] || ''))
    .map((m) => m[2])
  const policy = `default-src 'none'; script-src ${execs.map(sha).join(' ')} blob:; style-src 'unsafe-inline'; img-src data: blob: https:; media-src data: blob: https:; font-src data: blob:; frame-src https:; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'`
  const served = shell.replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="${policy}">`)
  ok(served !== shell && execs.length >= 1, `the shell is served with a hash-only CSP over its ${execs.length} executable inline script(s)`)
  const f3 = join(dir, 'served.bento.html'); writeFileSync(f3, served)
  const p3 = await open('file://' + f3)
  const violations = []
  p3.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text().slice(0, 120)) })
  const booted = await p3.waitForFunction(() => window.bento?.doc, null, { timeout: 15000 }).then(() => true, () => false)
  ok(booted, 'the type shell boots under it')
  if (booted) {
    const real = await p3.evaluate(async () => {
      const before = document.querySelectorAll('iframe').length
      window.bento.print()                           // the REAL printDocument
      await new Promise((r) => setTimeout(r, 300))
      const frame = [...document.querySelectorAll('iframe')].pop()
      const fd = frame?.contentDocument
      if (!fd) return { frame: false, before }
      const pages = fd.querySelectorAll('.t-page').length
      // does the frame carry the policy? put an inline script in it from the parent
      fd.defaultView.__ran = 0
      const s = fd.createElement('script'); s.textContent = 'window.__ran = 1'; fd.body.appendChild(s)
      await new Promise((r) => setTimeout(r, 100))
      return { frame: true, before, pages, ran: fd.defaultView.__ran }
    })
    ok(real.frame && real.pages >= 1, `the real printDocument builds its frame and the parent reads its DOM (${real.pages} page(s))`)
    ok(real.ran === 0, `that frame INHERITS the policy: an inline script put into it is refused (ran=${real.ran})`)
  }
  await p3.close()
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
