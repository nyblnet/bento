#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Untrusted-document rig: what a deck may put into the reader's DOM.
//
//   slides/node_modules/.bin/esbuild scripts/test-sanitize.ts --bundle \
//     --platform=node --format=esm --outfile="$TMPDIR/test-sanitize.mjs" \
//     && node "$TMPDIR/test-sanitize.mjs"
//
// (Bundled, not run directly: render.ts imports './model' extensionless, the
// same reason the spaces undo rig is bundled in CI. Source paths below are
// therefore resolved from the REPO ROOT — import.meta.url would point at the
// bundle.)
//
// WHAT THIS PROVES. Every deck is untrusted input: mailed, downloaded, pasted,
// or delivered as a collab op into a file already open. Script running in this
// page is not a defaced slide — it holds `doc.collab.key`, the owner/writer
// private keys, the plaintext IndexedDB autosave store and the File System
// Access handle ⌘S writes through. It is the document AND the file on disk.
//
// Three places used to hand author data straight to the DOM:
//
//   1. AN `svg` ELEMENT'S MARKUP, assigned with innerHTML. Measured in Chrome
//      141 (2026-08-09): a deck whose svg element carried `<svg onload="…">`
//      ran it — from a DETACHED div, before anything was inserted anywhere.
//      The `svgAsImage` sibling path (a data-URI <img>) was inert all along,
//      which is why only the live path changed.
//   2. TABLE CELL COLOURS, PADDINGS AND ALIGNMENTS, interpolated into a `style`
//      attribute unescaped. Same measurement: a cell whose `bg` read
//      `red" onmouseover="steal()` produced a `<td>` with a real `onmouseover`
//      attribute — on the canvas, in present, in print and in every thumbnail.
//   3. `canvas.startTextEdit`, which swaps the RESOLVED text for the model's
//      raw html so the author edits `{{page:2}}` rather than "06". It assigned
//      `model.html` unsanitized, so double-clicking a text box was enough.
//
// WHY THE SVG SECTION LOOKS LIKE THIS. The first fix for (1) was a DENYLIST —
// five tags, `on*`, three url attributes — and this rig pinned it with source
// regexes over the call sites. A verifier then measured script still executing
// through the real renderSlide → renderElement → sanitizeSvg path in six ways,
// and every one of them passed all forty checks, because a source regex knows
// the sanitizer is CALLED and nothing about what it PERMITS. So:
//
//   * the policy is now an allowlist, and the allowlist itself is exercised
//     here in node, where it is pure data (SVG_TAGS, svgAttrAllowed,
//     svgHrefAllowed, svgUrlRefsAllowed, sanitizeSvgCss);
//   * the WALK is exercised in a real browser, against the real renderSlide,
//     with payloads that either run or do not. `--headless=new --dump-dom`
//     over a throwaway http server on 127.0.0.1, so a "did this deck phone
//     home" claim is answered by a request log and not by reading the code.
//
// The browser half needs Chrome. Where there is none it says so loudly and
// skips; the node half still fails on every one of the six bypasses, because
// every one of them is a question about the policy.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  renderTableHtml,
  sanitizeHtml,
  sanitizeSvgCss,
  svgAttrAllowed,
  svgHrefAllowed,
  svgUrlRefsAllowed,
  SVG_TAGS,
} from '../slides/src/render.ts'
import { defaultTable, newDoc } from '../slides/src/model.ts'

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

// --- 1. the svg policy -------------------------------------------------------
//
// Pure data and pure functions, so the decisions can be inspected here while
// the walk that applies them is measured in a browser below. Both directions
// matter equally: a sanitizer that drops `url(#…)` refs renders every
// gradient-filled diagram blank, which is the failure that gets a sanitizer
// deleted again.

console.log('\nsvg tag allowlist')

ok(['svg', 'g', 'path', 'rect', 'circle', 'defs', 'pattern', 'lineargradient', 'radialgradient', 'stop',
  'clippath', 'mask', 'marker', 'filter', 'feturbulence', 'fecolormatrix', 'fegaussianblur',
  'text', 'tspan', 'use', 'image', 'style', 'animate'].every((t) => SVG_TAGS.has(t)),
  'the svg vocabulary the starter deck draws with is permitted')

for (const tag of ['script', 'foreignobject', 'iframe', 'object', 'embed', 'form', 'button', 'input',
  'meta', 'base', 'link', 'template', 'frame', 'frameset', 'audio', 'video', 'math']) {
  ok(!SVG_TAGS.has(tag), `<${tag}> is not permitted`)
}

console.log('\nsvg attribute allowlist')

ok(['id', 'class', 'd', 'viewbox', 'fill', 'stroke-width', 'transform', 'patternunits', 'stddeviation',
  'basefrequency', 'gradienttransform', 'preserveaspectratio', 'stop-color', 'clip-path', 'href',
  'xlink:href', 'attributename'].every(svgAttrAllowed),
  'the attributes real artwork carries are permitted, in the html parser’s casing too')
ok(svgAttrAllowed('viewBox') && svgAttrAllowed('attributeName') && svgAttrAllowed('stdDeviation'),
  'and matching is case-insensitive, which is how the parser’s foreign-content fixups line up')
ok(svgAttrAllowed('aria-label') && svgAttrAllowed('role'), 'aria-* and role are permitted')
ok(svgAttrAllowed('data-part'), 'a diagram’s own data-* CSS hook is permitted')

for (const attr of ['action', 'formaction', 'http-equiv', 'srcdoc', 'onclick', 'onload', 'onerror',
  'onbegin', 'formtarget', 'ping', 'rel', 'src', 'data-el-id', 'data-flip-id']) {
  ok(!svgAttrAllowed(attr), `${attr} is not permitted`)
}
// data-bento is reserved as a PREFIX. The shell's own marks are the full names:
// kernel serializeBody DELETES every [data-bento-transient] node from the clone
// it saves, and save.ts removes [data-bento-preview] unconditionally. Reserving
// the bare string would have left an author element answering either query.
for (const attr of ['data-bento', 'data-bento-transient', 'data-bento-preview', 'data-bento-state']) {
  ok(!svgAttrAllowed(attr), `${attr} is reserved to the shell, not lent to a diagram`)
}

console.log('\nsvg href policy')

ok(svgHrefAllowed('#grad-1'), 'a same-document fragment is kept — gradients and markers paint through url(#…)')
ok(svgHrefAllowed('https://example.com/a.png'), 'https is kept for an <image>')
ok(svgHrefAllowed('HTTP://EXAMPLE.COM/a.png'), 'scheme matching is case-insensitive')
ok(svgHrefAllowed('data:image/png;base64,iVBOR'), 'a data:image is kept — the browser loads it script-disabled')
ok(svgHrefAllowed('https://example.com/x', 'a'), 'and an <a> may point at the web — the reader clicks it')

ok(!svgHrefAllowed('javascript:alert(1)'), 'javascript: is refused')
ok(!svgHrefAllowed('JaVaScRiPt:alert(1)'), 'so is the mixed-case spelling')
ok(!svgHrefAllowed('  javascript:alert(1)'), 'leading whitespace does not smuggle it past')
ok(!svgHrefAllowed('java\tscript:alert(1)'), 'nor does a tab inside the scheme, which browsers ignore')
ok(!svgHrefAllowed('java\u0000script:alert(1)'), 'nor a NUL')
ok(!svgHrefAllowed('data:text/html,<svg onload=alert(1)>'), 'a data: that is not an image is refused')
ok(!svgHrefAllowed('//evil.example/x.svg'), 'protocol-relative is refused — it is a fetch out of a self-contained file')
ok(!svgHrefAllowed('sprites.svg#icon'), 'and so is the plain relative form, for the same reason')
ok(!svgHrefAllowed(''), 'an empty href is not a url')
ok(!svgHrefAllowed('https://evil.example/x.svg#s', 'use'),
  'a <use> may not instance a subtree out of another document, however ordinary the scheme')
ok(!svgHrefAllowed('https://evil.example/x.svg#g', 'lineargradient'),
  'nor may a gradient inherit from one')

console.log('\nurl() targets')

ok(svgUrlRefsAllowed('url(#bp-dots-i)'), 'fill="url(#…)" survives — it is the whole pattern/gradient idiom')
ok(svgUrlRefsAllowed('none') && svgUrlRefsAllowed('#F7A600'), 'a value with no url() at all is untouched')
ok(!svgUrlRefsAllowed('url(https://evil.example/paint.svg#g)'), 'an external paint server is refused')
ok(!svgUrlRefsAllowed("url('//evil.example/x')"), 'quoted and protocol-relative is still refused')
ok(!svgUrlRefsAllowed('url( \u0000https://evil.example/x )'), 'padding and control characters do not hide it')

console.log('\nsvg css')

ok(!/@import/i.test(sanitizeSvgCss('@import url("https://evil.example/t.css");\n.p{fill:red}')),
  '@import is removed — a live fetch out of a self-contained file, and a read receipt for a mailed deck')
ok(sanitizeSvgCss('@import "x.css";\n.p{fill:red}').includes('.p{fill:red}'),
  'the rest of the sheet survives: dropping it would cost the artwork')
ok(sanitizeSvgCss('.p{fill:url(#g)}') === '.p{fill:url(#g)}', 'url(#…) inside the sheet is untouched')
ok(sanitizeSvgCss('.p{background:url(https://evil.example/b.png)}').includes('background:none'),
  'an external url() becomes none — valid everywhere url() is legal, so the sheet still parses')
ok(!sanitizeSvgCss('@font-face{src:url(https://evil.example/f.woff2)}').includes('evil.example'),
  'and a webfont fetch goes the same way')

// The at-rule half is an ALLOWLIST because cutting `@import` by name did not
// work. Measured against the allowlist-tags build on 2026-08-09, Chrome 141:
// `@\69mport "http://…";` inside an svg <style> FETCHED — the probe server
// logged the request — because a CSS at-keyword is an ident and an ident takes
// escapes. The bare-string form has no `url(` in it either, so the url() rewrite
// above never saw it.
const escaped = sanitizeSvgCss('@\\69mport "https://evil.example/t.css";\n.p{fill:red}')
ok(!/@\\?[\\\w]*import/i.test(escaped) && escaped.includes('@bento-refused'),
  'an at-keyword written with a CSS escape is refused — @\\69mport is @import')
ok(escaped.includes('.p{fill:red}'), 'and the sheet around it still parses')
ok(sanitizeSvgCss('@im\\port url(x);').includes('@bento-refused'), 'so is @im\\port')
ok(sanitizeSvgCss('@\\49MPORT "x";').includes('@bento-refused'), 'and @\\49MPORT')
ok(!sanitizeSvgCss('@import "https://evil.example/t.css";').includes('evil.example')
  || sanitizeSvgCss('@import "https://evil.example/t.css";').startsWith('@bento-refused'),
  'the bare-STRING import is refused too — the url() rewrite cannot see that one')
ok(sanitizeSvgCss('@import "https://evil.example/t.css"\n.p{fill:red}').includes('@bento-refused'),
  'and so is the form with no semicolon, which the old regex required')
ok(!sanitizeSvgCss('@document url-prefix();.p{fill:red}').includes('@document'),
  'an at-rule nobody asked for is refused by default, which is the point of a list')

for (const at of ['@media screen{.p{fill:red}}', '@supports (fill:red){.p{fill:red}}',
  '@keyframes spin{to{transform:rotate(1turn)}}', '@-webkit-keyframes spin{to{opacity:0}}',
  '@font-face{font-family:X;src:local("X")}', '@layer base{.p{fill:red}}']) {
  ok(sanitizeSvgCss(at) === at, `${at.slice(0, at.indexOf(' ') > 0 ? at.indexOf(' ') : at.indexOf('{'))} is kept — motion and layout are what a diagram's sheet is for`)
}
ok(sanitizeSvgCss('.p::before{content:"a@b"}') === '.p::before{content:"a@b"}',
  'an @ that does not start a token is not an at-rule')

// --- 2. the table, end to end ------------------------------------------------
//
// renderTableHtml is a string builder with no DOM in it, so the real output can
// be inspected here. Every value below is what a received deck can contain: the
// model's `string` and `number` are types, not promises.

console.log('\ntable style attribute')

const doc = newDoc()
const hostile = defaultTable()
hostile.rows[1].cells[0] = { html: 'ok', bg: 'red" onmouseover="steal()', color: '#0F0' }
hostile.rows[1].cells[1] = { html: 'two', align: 'right;background:url(https://evil.example/p)' as never }
hostile.rows[1].cells[2] = { html: 'three', color: 'expression(alert(1))' }
hostile.style.cellPadY = '0;position:fixed;inset:0' as never
hostile.style.borderColor = 'x" onclick="steal()'
hostile.style.fontFamily = 'Inter;}</sty' + 'le><b>x'
const out = renderTableHtml(hostile, doc)

/** One cell's opening tag — everything a parser reads before the first ">". */
const cellTag = (r: number, c: number) => {
  const at = out.indexOf(`<td data-r="${r}" data-c="${c}"`)
  return at < 0 ? '' : out.slice(at, out.indexOf('>', at) + 1)
}

ok(!/\son[a-z]+\s*=/i.test(out), 'no event-handler attribute is minted anywhere in the table')
ok(!out.includes('onmouseover="steal()') && !out.includes('onclick="steal()'),
  'the two handler payloads are gone, not merely renamed')
ok(!out.includes('evil.example'), 'an alignment carrying a url() cannot reach the stylesheet')
ok(!/expression\(/i.test(out), 'nor can expression()')
ok(!out.includes('position:fixed'), 'a padding that is not a number cannot add declarations')
ok(cellTag(1, 0).includes('background:transparent'), 'the rejected colour falls back rather than being "cleaned"')
ok(cellTag(1, 1).includes('text-align:left'), 'the rejected alignment falls back to the format default')
ok(out.includes('font-family:inherit'), 'and the rejected font stack falls back too')
// The structural version of the same claim, and the one that fails loudly on
// the old output: a `=` cannot occur inside a validated style value, so three
// of them is exactly data-r, data-c and style. The old cell had four.
ok((cellTag(1, 0).match(/=/g) ?? []).length === 3, 'the cell tag still carries three attributes and no fourth')

console.log('\ntable, unremarkable content')

const plain = defaultTable()
plain.rows[1].cells[0] = { html: 'Revenue', align: 'right', color: '#1E2A3A', bg: 'rgba(30,42,58,0.05)', bold: true }
const good = renderTableHtml(plain, doc)
ok(good.includes('text-align:right'), 'a real alignment survives')
ok(good.includes('color:#1E2A3A'), 'a hex colour survives')
ok(good.includes('background:rgba(30,42,58,0.05)'), 'an rgba() colour survives — the zebra stripe is one')
ok(good.includes(`font-family:${doc.theme.fontFamily.replace(/"/g, '&quot;')}`), "the deck's font stack survives")
ok(good.includes('font-size:18px') && good.includes('padding:11px 16px'), 'so do the numeric style fields')
ok(good.includes('>Revenue<'), 'and the cell text is still there')

const cjk = defaultTable()
cjk.style.fontFamily = 'ヒラギノ角ゴ ProN, sans-serif'
ok(renderTableHtml(cjk, doc).includes('ヒラギノ角ゴ'),
  'a non-ASCII font family survives — a character allowlist would have eaten it')

// --- 3. the raw-html swap ----------------------------------------------------
//
// startTextEdit shows the model's raw html so the author edits the TOKEN and
// not the computed value. Sanitizing there is only free if the two things the
// swap exists for are not markup — and they are not, which is the point.

console.log('\ntokens survive the sanitizer')

const RAW = '{{page:2}} of {{pages}} — $E=mc^2$ and $$\\frac{a}{b}$$'
ok(sanitizeHtml(RAW).includes('{{page:2}}'), 'a zero-padded page field round-trips')
ok(sanitizeHtml(RAW).includes('$E=mc^2$'), 'inline TeX source round-trips')
ok(sanitizeHtml(RAW).includes('$$\\frac{a}{b}$$'), 'display TeX source round-trips')

// --- 4. the walk, in a browser ----------------------------------------------
//
// Everything above is a decision. This is the machinery, and the machinery is
// where the bypasses lived: a policy is only as good as the walk that reaches
// every node. So the payloads below go through the REAL renderSlide into a
// REAL document, and the ones that are supposed to run are given every chance
// to — inserted, clicked, submitted — while a local server logs whether the
// page reached for anything.
//
// The `MUST NOT execute` cases each have a number: they are the six the
// verifier measured against the denylist build (2026-08-09, Chrome 141). 1, 2
// and 3 ran or navigated for real there; 4 fetched; 5 and 6 survived the walk
// intact and were refused only by Blink's own restraint, which is not a
// security boundary.

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

/**
 * The page that does the work. Bundled by esbuild against the repo's own
 * render.ts, so this is the shipping code path and not a re-implementation of
 * it. Written without backticks or `${` so it can live in a template literal.
 */
const probeSource = (renderPath: string, modelPath: string) => `
import { renderSlide } from ${JSON.stringify(renderPath)}
import { newDoc } from ${JSON.stringify(modelPath)}

const O = location.origin
const pwned: number[] = []
;(window as any).__pwn = (n: number) => { pwned.push(n) }

const results: Array<[string, boolean]> = []
const check = (name: string, pass: boolean) => { results.push([name, pass]) }

/** The shipping path: model → renderSlide → renderElement → sanitizeSvg. */
function draw(markup: string, css?: string): HTMLElement {
  const doc = newDoc()
  const slide = doc.slides[0]
  slide.elements = [{
    id: 'sv1', type: 'svg', x: 0, y: 0, w: 200, h: 200,
    rotation: 0, opacity: 1, markup, ...(css ? { css } : {}),
  } as any]
  const surface = renderSlide(slide, doc)
  document.body.appendChild(surface)
  return surface
}

if (location.pathname === '/meta.html') {
  // Finding 2, the live half: if the meta survives the walk, Chrome navigates
  // this document to /pwned.html and the dumped DOM is somebody else's page.
  draw('<svg><rect width="10" height="10"/><meta http-equiv="refresh" content="0;url=/pwned.html"></svg>')
  draw('<div>x</div><meta http-equiv="refresh" content="0;url=/pwned.html">')
} else {
  try {
    const baseBefore = document.baseURI

    // Several payloads below open with a throwaway <div>, and it is not padding:
    // a LEADING <link>, <meta>, <base> or <template> is hoisted into <head> by
    // DOMParser, and the walk only ever sees parsed.body. Tested at the front of
    // the string, every one of them passes against a sanitizer that does nothing
    // — measured on the denylist build, which "passed" three of these until the
    // div went in. One line of body content is what puts them in the walk's way.

    // --- 1. form-driven javascript: (action / formaction / input type=image) ---
    const shot = draw(
      '<form action="javascript:window.__pwn(11)"><button type="submit">go</button></form>' +
      '<form><button type="submit" formaction="javascript:window.__pwn(12)">go</button></form>' +
      '<form action="javascript:window.__pwn(13)">' +
      '<input type="image" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></form>'
    )
    check('1 — no <form>, <button> or <input> survives the walk',
      shot.querySelectorAll('form, button, input').length === 0)

    // --- 2. meta refresh (structure here, navigation in the second run) --------
    const metas = draw('<svg><rect width="10" height="10"/><meta http-equiv="refresh" content="0;url=/pwned.html"></svg>' +
      '<div>x</div><meta http-equiv="refresh" content="0;url=/pwned.html">')
    check('2 — no <meta> survives the walk', metas.querySelectorAll('meta').length === 0)

    // --- 3. base href ----------------------------------------------------------
    const based = draw('<div>x</div><base href="' + O + '/evil/"><svg><rect width="10" height="10"/></svg>')
    check('3 — no <base> survives the walk', based.querySelectorAll('base').length === 0)
    check('3 — relative urls still resolve against this document', document.baseURI === baseBefore)

    // --- 4. network out of a self-contained file -------------------------------
    draw('<div>x</div><link rel="stylesheet" href="' + O + '/tracker.css">' +
      '<svg><style>@import url("' + O + '/imported.css");.q{fill:red}</sty' + 'le>' +
      '<rect class="q" width="10" height="10" fill="url(' + O + '/paint.svg#g)"/></svg>')
    draw('<svg><rect width="10" height="10"/></svg>', '@import url("' + O + '/model-css.css");.z{fill:red}')

    // 4, the spellings that beat a regex written around the word "import".
    // Both of these FETCHED against the build that cut @import by name
    // (2026-08-09, Chrome 141): an at-keyword is an ident, and an ident takes
    // escapes; and the string form carries no url( for the url() rewrite to
    // find. This is why CSS at-rules are an allowlist now.
    draw('<svg><style>@\\\\69mport "' + O + '/esc-import.css";.q{fill:red}</sty' + 'le>' +
      '<rect width="10" height="10"/></svg>')
    draw('<svg><style>@import "' + O + '/str-import.css";.q{fill:red}</sty' + 'le>' +
      '<rect width="10" height="10"/></svg>')
    // no semicolon where the parser wants one, and a <style> in HTML context
    // rather than inside the svg — same sheet, same policy, different route in.
    draw('<svg><style>@import "' + O + '/nosemi-import.css"\\n.q{fill:red}</sty' + 'le></svg>')
    draw('<div>x</div><style>@\\\\69mport "' + O + '/html-style.css";</style>')

    // and the sheet a real diagram writes still animates
    const sheet = draw('<svg><style>@keyframes bp-spin{to{transform:rotate(1turn)}}' +
      '@media (min-width:1px){.q{fill:url(#g)}}</sty' + 'le>' +
      '<rect class="q" width="10" height="10"/></svg>')
    check('a diagram keeps @keyframes and @media — the allowlist is not a ban on CSS',
      (sheet.querySelector('style')?.textContent ?? '').includes('@keyframes bp-spin') &&
      (sheet.querySelector('style')?.textContent ?? '').includes('@media (min-width:1px)'))

    // --- 5. SMIL retargeting ---------------------------------------------------
    const smil = draw('<svg><rect id="sm" width="10" height="10">' +
      '<set attributeName="onclick" to="window.__pwn(51)"/>' +
      '<animate attributeName="href" to="javascript:window.__pwn(52)" dur="1s" fill="freeze"/>' +
      '</rect></svg>')
    check('5 — an animation that would write an on* handler is gone',
      smil.querySelectorAll('set, animate').length === 0)
    check('5 — and nothing in the subtree carries an onclick',
      !Array.from(smil.querySelectorAll('*')).some((e) => e.hasAttribute('onclick')))

    // --- 6. template ------------------------------------------------------------
    const tpl = draw('<div>x</div><template><img src="x" onerror="window.__pwn(61)"><svg onload="window.__pwn(62)"></svg></template>')
    check('6 — no <template> survives, so nothing hides in .content',
      tpl.querySelectorAll('template').length === 0 && !tpl.innerHTML.includes('__pwn'))

    // --- 7. the xlink spelling of everything above -----------------------------
    //
    // href and xlink:href are the same attribute to a browser, and a policy
    // that only knows the short name is a policy with a second door in it.
    const xl = draw('<svg xmlns:xlink="http://www.w3.org/1999/xlink">' +
      '<a id="xa" xlink:href="javascript:window.__pwn(81)"><rect width="10" height="10"/></a>' +
      '<image id="xi" xlink:href="' + O + '/xlink-remote.png" width="10" height="10"/>' +
      '<use id="xu" xlink:href="' + O + '/xlink.svg#s"/>' +
      '<rect id="xr" width="10" height="10"><animate attributeName="xlink:href" to="javascript:window.__pwn(82)" dur="1s"/></rect>' +
      '</svg>')
    check('7 — a javascript: xlink:href loses its href just as a plain one does',
      !!xl.querySelector('#xa') && !xl.querySelector('#xa')!.hasAttribute('xlink:href'))
    check('7 — a <use> reaching out of the document by xlink:href is dropped whole',
      !xl.querySelector('#xu'))
    check('7 — an animation retargeting xlink:href is gone',
      xl.querySelectorAll('animate').length === 0)

    // --- 8. the html integration points --------------------------------------
    //
    // <desc>, <title> and <foreignObject> are where the parser LEAVES foreign
    // content and resumes html rules, so a <script> written inside one is a real
    // html script element and not svg text. The walk has to recurse into them.
    const desc = draw('<svg><desc><scr' + 'ipt>window.__pwn(91)</scr' + 'ipt>' +
      '<img src="' + O + '/desc-img.png" onerror="window.__pwn(92)"></desc>' +
      '<title><img src="' + O + '/title-img.png"></title><rect width="10" height="10"/></svg>')
    check('8 — nothing survives inside <desc> or <title>, where html parsing resumes',
      desc.querySelectorAll('script, img').length === 0 && !!desc.querySelector('rect'))

    // --- 9. an svg carried as a data: image ------------------------------------
    //
    // data:image/ is allowed on an <image> href on purpose. An svg loaded THAT
    // way is script-disabled by the browser, and this is the check that says so
    // rather than assuming it.
    draw('<svg><image width="99" height="99" href="data:image/svg+xml,' +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="99" height="99" onload="top.__pwn(101)">' +
        '<rect width="9" height="9" fill="red"/></svg>') + '"/></svg>')

    // --- 0. the case round one did fix, still fixed ----------------------------
    const classic = draw('<svg onload="window.__pwn(1)"><rect id="clicky" width="10" height="10" onclick="window.__pwn(2)"/>' +
      '<scr' + 'ipt>window.__pwn(3)</scr' + 'ipt>' +
      '<foreignObject><img src="x" onerror="window.__pwn(4)"></foreignObject></svg>')
    check('0 — script and foreignObject are gone and no on* handler is left',
      classic.querySelectorAll('script, foreignObject').length === 0 &&
      !Array.from(classic.querySelectorAll('*')).some((e) =>
        Array.from(e.attributes).some((a) => a.name.toLowerCase().startsWith('on'))))

    // --- refs -------------------------------------------------------------------
    const refs = draw('<svg><a id="ok" href="https://example.com/x">t</a>' +
      '<a id="bad" href="javascript:window.__pwn(71)">t</a>' +
      '<image id="img" href="' + O + '/remote.png" width="10" height="10"/>' +
      '<image id="jsimg" href="javascript:window.__pwn(72)" width="10" height="10"/>' +
      '<use id="localuse" href="#ok"/><use id="remoteuse" href="' + O + '/x.svg#s"/></svg>')
    check('an <a> to the web is kept', refs.querySelector('#ok')!.getAttribute('href') === 'https://example.com/x')
    check('a javascript: <a> loses its href but keeps its place in the layout',
      !!refs.querySelector('#bad') && !refs.querySelector('#bad')!.hasAttribute('href'))
    check('an http <image> is kept', !!refs.querySelector('#img'))
    check('a javascript: <image> loses its href', !refs.querySelector('#jsimg')!.hasAttribute('href'))
    check('a same-document <use> is kept', !!refs.querySelector('#localuse'))
    check('a <use> pointing out of this document is dropped whole', !refs.querySelector('#remoteuse'))

    // --- the artwork that has to keep drawing ----------------------------------
    const art = draw('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" preserveAspectRatio="none">' +
      '<defs><pattern id="bp-dots-i" width="28" height="28" patternUnits="userSpaceOnUse">' +
      '<circle cx="1.5" cy="1.5" r="1.4" fill="#FFFFFF" opacity="0.07"/></pattern>' +
      '<radialGradient id="bp-ga-am"><stop offset="0" stop-color="#FFEED6" stop-opacity="0.15"/></radialGradient>' +
      '<filter id="bp-grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>' +
      '<feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.045 0"/></filter></defs>' +
      '<sty' + 'le>.dot{fill:url(#bp-ga-am)}</sty' + 'le>' +
      '<rect width="1280" height="720" fill="url(#bp-dots-i)" filter="url(#bp-grain)"/></svg>')
    check('a pattern keeps its id — url(#…) resolves document-globally',
      !!art.querySelector('pattern#bp-dots-i') && !!art.querySelector('radialGradient#bp-ga-am'))
    check('and the rect still points at it', art.querySelector('rect')!.getAttribute('fill') === 'url(#bp-dots-i)')
    check('feTurbulence keeps baseFrequency and feColorMatrix keeps values',
      art.querySelector('feTurbulence')!.getAttribute('baseFrequency') === '0.9' &&
      !!art.querySelector('feColorMatrix')!.getAttribute('values'))
    check('viewBox and preserveAspectRatio survive the parser round-trip',
      art.querySelector('svg')!.getAttribute('viewBox') === '0 0 1280 720')
    check('the svg <style> is kept — scopeCss is what stops it leaking',
      (art.querySelector('style')?.textContent ?? '').includes('.dot{fill:url(#bp-ga-am)}'))

    const sloppy = draw('<svg viewBox="0 0 20 20"><rect width="10" height="10"><circle cx="5" cy="5" r="2"/></svg>')
    check('an unclosed tag still draws — text/html, not the fatal xml parser',
      !!sloppy.querySelector('svg') && !!sloppy.querySelector('circle'))

    // Give every payload its chance: insertion alone is not the only trigger.
    // Measured on the pre-sanitizer build, where the difference showed: a
    // form-driven javascript: needs the submit button CLICKED, and an
    // onclick on a rect needs a click dispatched at the rect. Only the
    // javascript: anchors are clicked — clicking an ordinary one navigates the
    // probe away and it reports nothing at all.
    for (const el of Array.from(document.querySelectorAll('button, input'))) (el as HTMLElement).click()
    for (const f of Array.from(document.querySelectorAll('form'))) {
      try { (f as HTMLFormElement).requestSubmit() } catch { /* no submitter */ }
    }
    for (const a of Array.from(document.querySelectorAll('a'))) {
      const href = (a.getAttribute('href') ?? a.getAttribute('xlink:href') ?? '').toLowerCase()
      if (href.startsWith('javascript:')) (a as HTMLElement).click()
    }
    // Never inside an <a>: a click that bubbles to the ALLOWED
    // https://example.com anchor navigates, and a probe that navigated reports
    // nothing at all (measured — the dump held the rendered slides and no
    // results block).
    for (const el of Array.from(document.querySelectorAll('#clicky, [onclick], [onmouseover]'))) {
      if (!el.closest('a')) el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }

  } catch (err) {
    // A probe that dies half way through would otherwise report only the
    // checks it reached, all of them passing.
    check('the probe ran to the end (it threw: ' + String(err) + ')', false)
  }

  setTimeout(() => {
    check('nothing executed: ' + (pwned.length ? pwned.join(',') : 'clean'), pwned.length === 0)
    const pre = document.createElement('pre')
    pre.id = 'bento-results'
    // btoa is Latin-1 only and every check name here has an em dash in it:
    // encode to utf-8 bytes first or this throws and the rig reports nothing.
    const utf8 = new TextEncoder().encode(JSON.stringify(results))
    pre.textContent = 'BENTO-RESULTS:' + btoa(String.fromCharCode(...utf8)) + ':END'
    document.body.appendChild(pre)
  }, 400)
}
`

async function runBrowserSection(chrome: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-sanitize-'))
  const entry = path.join(tmp, 'probe.ts')
  fs.writeFileSync(entry, probeSource(repoFile('slides/src/render.ts'), repoFile('slides/src/model.ts')))
  execFileSync(repoFile('slides/node_modules/.bin/esbuild'), [
    entry, '--bundle', '--format=esm', '--outfile=' + path.join(tmp, 'probe.js'),
  ], { stdio: 'pipe' })
  const bundle = fs.readFileSync(path.join(tmp, 'probe.js'), 'utf8')

  // Written by concatenation: never a literal script-close in a source file
  // (AGENTS.md #1). This one is not spliced into a deck, but the habit is the
  // rule.
  // The trailing <img> is a LOAD GATE, and it is load-bearing: the new headless
  // ignores --virtual-time-budget, so `--dump-dom` fires at the load event and
  // a probe that reports from a timer reports nothing at all (measured — the
  // dump held every rendered slide and no results block). The server answers
  // /slow.gif late, load waits for it, and the probe's timer lands first.
  const page = (marker: string) =>
    '<!doctype html><meta charset="utf-8"><title>bento sanitize probe</title>' +
    '<body>' + marker +
    '<scr' + 'ipt type="module" src="/probe.js"></scr' + 'ipt>' +
    '<img src="/slow.gif" width="1" height="1" alt=""></body>'

  const hits: string[] = []
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]
    hits.push(url)
    if (url === '/probe.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle); return }
    if (url === '/probe.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('BENTO-PROBE')); return }
    if (url === '/meta.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('BENTO-STAYED')); return }
    if (url === '/pwned.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html>BENTO-NAVIGATED'); return }
    if (url.endsWith('.css')) { res.writeHead(200, { 'content-type': 'text/css' }); res.end('.tracked{fill:red}'); return }
    const gif = () => {
      res.writeHead(200, { 'content-type': 'image/gif' })
      res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'))
    }
    if (url === '/slow.gif') { setTimeout(gif, 1500); return }
    gif()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  // spawn, never spawnSync: the server above lives in THIS process, so a
  // synchronous child blocks the event loop that has to answer Chrome's
  // request for /probe.js — measured as a hang, not as a failure.
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
      const dumped = path.join(os.tmpdir(), 'bento-sanitize-dump.html')
      fs.writeFileSync(dumped, dom)
      ok(false, `the browser probe reported results (it did not — dumped DOM in ${dumped})`)
    } else {
      for (const [name, pass] of JSON.parse(Buffer.from(blob[1], 'base64').toString('utf8')) as Array<[string, boolean]>) {
        ok(pass, name)
      }
    }

    // Finding 2's live half. A page that navigated is somebody else's page.
    const metaDom = await load('/meta.html')
    ok(!metaDom.includes('BENTO-NAVIGATED') && metaDom.includes('BENTO-STAYED'),
      '2 — a meta refresh in a deck does not navigate the reader off the document')

    ok(!hits.includes('/tracker.css'), '4 — a <link rel=stylesheet> in a deck never fetches')
    ok(!hits.includes('/imported.css'), '4 — nor does @import inside the svg <style>')
    ok(!hits.includes('/model-css.css'), "4 — nor @import in the model's own css field")
    ok(!hits.includes('/paint.svg'), '4 — nor an external paint server in fill="url(…)"')
    ok(!hits.includes('/esc-import.css'), '4 — nor @\\69mport, which fetched until at-rules became an allowlist')
    ok(!hits.includes('/str-import.css'), '4 — nor the bare-string @import, which carries no url() to rewrite')
    ok(!hits.includes('/nosemi-import.css'), '4 — nor the form with no semicolon')
    ok(!hits.includes('/html-style.css'), '4 — nor a <style> that reached the body in html context')
    ok(!hits.includes('/desc-img.png') && !hits.includes('/title-img.png'),
      '8 — nothing inside <desc> or <title> fetches either')
    ok(!hits.includes('/xlink.svg'), '7 — nor an xlink:href <use> pointing out of the document')
    ok(hits.includes('/remote.png'), 'an <image href="http(s)://…"> still loads — that one is allowed on purpose')
    ok(hits.includes('/xlink-remote.png'), 'and so does the xlink:href spelling of it — the policy is not a ban on pictures')
  } finally {
    server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

console.log('\nthe walk, in a browser')
if (!CHROME) {
  console.log('  ⚠ SKIPPED — no Chrome found. Set BENTO_CHROME to a binary to run this section;')
  console.log('    it is the only half that can prove a payload does not RUN.')
} else {
  await runBrowserSection(CHROME)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
