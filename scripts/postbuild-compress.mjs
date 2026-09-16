#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Self-extracting shell: compress the built runtime so the file on disk is
// ~half the size, with zero feature loss.
//
//   node scripts/postbuild-compress.mjs slides/dist-single/Bento_Slides.bento.html
//
// Takes the vite single-file build, extracts the big inline module script and
// stylesheet, deflates them (raw) into base64 payload blocks, and restructures
// the document into the canonical byte order:
//
//   head chrome → NOTICE → tooling comment → #bento-doc (PLAINTEXT, always)
//   → splash (paints while the payload parses) → payloads + 1KB loader last
//
// The loader inflates via the native DecompressionStream and boots the module
// from a blob URL. Browsers without DecompressionStream (pre-2023 Safari) get
// a plain-HTML message instead of a blank page.
//
// COMPATIBILITY CONTRACT (老 updaters are frozen code — we conform to them):
//   - #bento-doc stays plaintext with the same id.
//   - The whole file survives DOMParser → splice → outerHTML round-trips.
//   - No literal "</script>" anywhere (base64 alphabet can't produce one;
//     the loader is checked below).
// release.mjs runs a frozen v0.1.0-style splice against the output as a gate.

import { readFileSync, writeFileSync } from 'node:fs'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { encode as b86encode, LOADER_DECODER as B86_DECODER, FORBIDDEN, ALPHABET } from './lib/b86.mjs'

/**
 * ZOPFLI, not zlib.
 *
 * Zopfli emits a stream in the SAME deflate format, just packed harder — so
 * the shipped loader is untouched, every already-saved file keeps working, and
 * old updaters splicing into a new shell see exactly what they saw before.
 * Verified rather than assumed: a zopfli payload handed to Chrome 148's native
 * `DecompressionStream('deflate-raw')` inflated to a byte-identical result,
 * SHA-256 matched, in 2.2 ms.
 *
 * Measured on the shipped shells: 172,470 -> 165,398 B for bento/spaces and
 * 690,060 -> 663,760 B for bento/slides. About 4% off every file anyone saves,
 * for a second of build time.
 *
 * RESOLVED FROM THE CALLER, not from this file. This script lives in scripts/
 * and there is no package.json there or at the root, so a bare import would
 * look in the wrong place; every app runs it from its OWN directory, which is
 * where the dependency is declared. That is also why the failure below names
 * the fix rather than falling back silently — a release quietly built 4%
 * larger because someone's node_modules was stale is a regression nobody would
 * ever notice.
 */
const iterations = Number(process.env.ZOPFLI_ITERS || 15)
let zopfli
try {
  zopfli = createRequire(join(process.cwd(), 'package.json'))('@gfx/zopfli')
} catch {
  console.error(
    'postbuild-compress: @gfx/zopfli is missing. Run `npm ci` in this app\'s\n' +
    '  directory (it is a devDependency). Set ZOPFLI=0 to build with zlib\n' +
    '  instead — the output is valid but about 4% larger, so never for a release.')
  if (process.env.ZOPFLI !== '0') process.exit(1)
}

/**
 * deflate-raw, packed by zopfli unless it was explicitly turned off.
 *
 * THE OUTPUT IS INFLATED AND COMPARED BACK, every time, with node's own zlib.
 * This is not paranoia about a bug — zopfli is old and well used — it is about
 * what this script feeds. The bytes it emits ARE the application, and the
 * shell built from them is signed: a packer that emitted a VALID deflate
 * stream carrying different JavaScript would be signed as genuine and would
 * self-update its way onto every install. A round trip through a different
 * implementation makes that undetectable-in-principle failure impossible in
 * practice, and it costs about 2ms per shell.
 *
 * It also covers the duller case a signature never would: a wrong build, a
 * truncated write, a future iteration-count change that trips a corner.
 */
const deflate = async (buf) => {
  const packed = (!zopfli || process.env.ZOPFLI === '0')
    ? deflateRawSync(buf, { level: 9 })
    : await new Promise((res, rej) =>
        zopfli.deflate(buf, { numiterations: iterations }, (e, out) => (e ? rej(e) : res(Buffer.from(out)))))
  if (!inflateRawSync(packed).equals(buf)) {
    console.error('postbuild-compress: the packed payload does not inflate back to what went in.\n' +
      '  Refusing to write a shell whose runtime cannot be recovered. This is a bug in the\n' +
      '  packer or a corrupted install — do not sign anything built from this tree.')
    process.exit(1)
  }
  return packed
}

const path = process.argv[2]
if (!path || path.startsWith('--')) {
  console.error('usage: node scripts/postbuild-compress.mjs <shell.html> [--generator <id>] [--title <fallback>]')
  process.exit(1)
}

// Per-app identity. Defaults reproduce the slides output byte-for-byte, so
// the slides build script needs no flags; other apps pass their own.
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const generator = flag('generator', 'bento-slides')
const titleFallback = flag('title', 'bento/slides')
// How the inflated runtime is started. `cascade` (the default since 1.1.1):
// see below. `blob` (the 1.1.0 loader): a module import from a blob: URL. `inline`: an inline <script type="module"> whose
// textContent is the inflated bundle — no blob: URL at all, so it runs where a
// Content-Security-Policy allows 'unsafe-inline' but not blob: (SharePoint's
// framed HTML viewer, which Teams uses to open attachments, is the case that
// found this: the shipped shell showed its splash and nothing else there).
// The bundle is byte-identical either way; only the 1KB loader differs.
const loaderMode = flag('loader', 'cascade')
if (!['blob', 'inline', 'inline-tt', 'cascade', 'cascade-eval-first', 'cascade-eager-tt'].includes(loaderMode)) throw new Error(`--loader must be blob, inline, inline-tt, cascade, cascade-eval-first or cascade-eager-tt, got ${loaderMode}`)
// NO PROBING. Teams has two panes with two policies: the preview pane allows
// inline script insertion outright and treats ANY reported CSP violation as
// fatal (a refused blob import, a refused createPolicy, a refused eval probe
// — each one blued the preview); the open pane hashes the file's inline
// scripts and allows eval. So `cascade` does the one thing that is refused
// nowhere first — insert the inline module, exactly as the plain inline
// loader — and only on a violation attributed to that attempt falls to
// new Function, then to the blob import. `cascade-eval-first` is the earlier
// order, kept for the record.
// Trusted Types are LAZY in `cascade`: no createPolicy at boot. Only when a
// sink throws the TypeError that names TrustedScript/TrustedHTML are the
// policies (bento + default) installed and that step retried once. An eager
// createPolicy under a names-only allowlist raises CSP violations even when
// caught, and a hosting pane that treats a violation as fatal (SharePoint's
// preview, observed) then shows the splash and nothing else.
// `cascade-eager-tt` keeps the eager install for comparison.
// `cascade`: eval first. `new Function('')` throws AT ONCE under a policy
// without 'unsafe-eval', so the probe is synchronous and costs nothing; where
// it passes, the bundle runs through new Function immediately — an indirect
// eval, which a script-hash policy does not govern. Otherwise (2) an inline
// <script type="module"> (Trusted Types policies installed first where
// trustedTypes exists), abandoned on a synchronous throw or a
// securitypolicyviolation in a short window, then (3) the blob import. The
// path taken is recorded on window.bento.loader. This is the shape
// SharePoint's viewer needs: it hashes the file's own inline scripts and
// allows exactly those, so an inserted script is refused (unhashed) while
// eval is allowed. `cascade-inline-first` is the earlier order (inline,
// function, blob) — a build-time switch only, no runtime cost.
// `inline-tt`: inline, and the source is assigned through a Trusted Types
// policy named "bento" where the page enforces `require-trusted-types-for
// 'script'` (assigning a plain string to script.textContent throws there;
// the parser-inserted loader itself is exempt). `--diag` adds a visible
// on-page diagnostic panel — environment facts before the boot, every error
// after it — for a viewer where no console can be opened. Never on by default:
// the loader ships in every file and diag text is bytes.
const diag = process.argv.includes('--diag')
// The payload carrier alphabet. `b86` (default): scripts/lib/b86.mjs — 86
// printable ASCII symbols chosen so `</script`, `<!--`, `-->`, `]]>` and `${`
// are unproducible by construction, 4 bytes → 5 chars, 6.25% smaller than
// base64 (block type bento/deflate-b86). `b64`: base64, the pre-1.1.1 block
// type bento/deflate-b64, kept for comparison; every reader handles both.
const encoding = flag('encoding', 'b86')
if (!['b64', 'b86'].includes(encoding)) throw new Error(`--encoding must be b64 or b86, got ${encoding}`)
const PAYLOAD_TYPE = encoding === 'b86' ? 'bento/deflate-b86' : 'bento/deflate-b64'
// How the two deflated payloads are CARRIED in the file. `script` (shipped):
// <script type="bento/deflate-b64">. `template`: <template data-bento-payload>
// (its content is inert DOM, not a script, so a viewer that strips non-JS
// scripts leaves it alone). `textplain`: <script type="text/plain">. base64
// cannot contain "</" so no carrier can close itself early. All three keep
// the same ids, and none is transient — a save keeps the runtime.
const carrier = flag('carrier', 'script')
if (!['script', 'template', 'textplain'].includes(carrier)) throw new Error(`--carrier must be script, template or textplain, got ${carrier}`)
// How the payload is inflated. `native` (shipped): DecompressionStream only.
// `auto`: DecompressionStream where present, else a plain-JavaScript RFC 1951
// decoder inlined into the loader (scripts/lib/inflate-raw.js, ~2 KB
// minified). `js`: the JavaScript decoder always — for testing that path
// on a host that has DecompressionStream.
const inflateMode = flag('inflate', 'native')
if (!['native', 'auto', 'js'].includes(inflateMode)) throw new Error(`--inflate must be native, auto or js, got ${inflateMode}`)
const INFLATE_JS = inflateMode === 'native' ? '' : (() => {
  const { execFileSync } = createRequire(import.meta.url)('node:child_process')
  const src = readFileSync(new URL('./lib/inflate-raw.js', import.meta.url), 'utf8').replace(/^export function/m, 'function')
  const esbuild = join(process.cwd(), 'node_modules/.bin/esbuild')
  const min = execFileSync(esbuild, ['--minify', '--format=esm', '--target=es2017'], { input: src + '\nexport { inflateRaw }', encoding: 'utf8' })
  // esbuild renames the function; the export clause says what it became
  const m = /export\s*\{\s*(\w+)(?:\s+as\s+inflateRaw)?\s*\};?\s*$/.exec(min)
  if (!m) throw new Error('inflater: export clause not found after minify')
  return min.slice(0, m.index) + (m[1] === 'inflateRaw' ? '' : `var inflateRaw=${m[1]};`)
})()

const html = readFileSync(path, 'utf8')
if (html.includes('id="bento-rt"')) {
  console.log('already compressed — skipping')
  process.exit(0)
}

// --- extract the runtime pieces --------------------------------------------
const modRe = /<script type="module"[^>]*>([\s\S]*?)<\/script>/
const mod = html.match(modRe)
if (!mod) throw new Error('module script not found')

// The app css. Vite emits it as `<style rel="stylesheet" crossorigin>`, and we
// match THAT rather than "the first <style> in head" — the module script is
// inlined into the head too, so any app whose source builds a `<style>` string
// (dash's thumbnail preview does) had its own string matched first. The whole
// runtime stylesheet was then left uncompressed and unregistered, and the app
// booted with no CSS at all. esbuild constant-folds `\`<${'style'}>\`` straight
// back to a literal, so this cannot be worked around in the app source.
const headPart = html.slice(0, html.indexOf('</head>'))
const linkedRe = /<style[^>]*\brel="stylesheet"[^>]*>([\s\S]*?)<\/style>/
// The fallback requires `>` or whitespace after the tag name, and that detail
// is load-bearing. `<style[^>]*>` also matches `<style"`, and the kernel's
// preview machinery contains exactly that as a STRING CONSTANT — tree-shaken
// away until an app calls registerPreview, which is why this only surfaced
// when bento/type grew a preview. The module script is inlined into <head>
// ABOVE the real stylesheet, so the fallback matched a JS literal at offset
// 2923 instead of the stylesheet at 296275, packed 293KB of JavaScript into
// the #bento-rt-css payload, and left the real CSS uncompressed inside the JS
// — shipping every document 147KB larger with the app still working, so
// nothing looked wrong. A real tag is `<style>` or `<style …>`; a string
// constant is not.
// Searched across the WHOLE document, not just <head>. The linked stylesheet
// carries rel="stylesheet", which is unambiguous wherever it sits — and it
// does not always sit in the head: for bento/type, vite emits it in the BODY
// at offset 384674 while </head> is at 309927, so a head-scoped search never
// saw it. What it found in the head instead was `<style>${…}</style>` from
// print.ts's page template, minified into the module script: an 8-character
// match that packed an empty payload and left the real 34KB sheet shipping as
// plaintext in every saved file.
//
// The head-scoped fallback stays for a build that carries no rel attribute,
// which is the only case it was ever reached for.
const styleM = html.match(linkedRe)
  ?? headPart.match(/<style(?=[\s>])[^>]*>([\s\S]*?)<\/style>/)
if (!styleM) throw new Error('app stylesheet not found')

const js = mod[1]
const css = styleM[1]

const pack = async (s) => {
  const packed = await deflate(Buffer.from(s, 'utf8'))
  const text = encoding === 'b86' ? b86encode(new Uint8Array(packed)) : packed.toString('base64')
  for (const f of FORBIDDEN) if (text.includes(f)) throw new Error(`payload text contains ${JSON.stringify(f)} — the carrier alphabet is not safe`)
  return text
}
const jsB64 = await pack(js)
const cssB64 = await pack(css)

// --- other parts ------------------------------------------------------------
const notice = html.match(/<!--\s*NOTICE[\s\S]*?-->/)?.[0] ?? ''
const docBlock = html.match(/<script type="application\/bento\+json" id="bento-doc">[\s\S]*?<\/script>/)?.[0]
if (!docBlock) throw new Error('#bento-doc not found')
const favicon = html.match(/<link rel="icon"[^>]*\/?>/)?.[0] ?? ''
const title = html.match(/<title>[\s\S]*?<\/title>/)?.[0] ?? `<title>${titleFallback}</title>`
const splashDiv = html.match(/<div id="bento-splash"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? ''
const splashCss = (() => {
  const bodyPart = html.slice(html.indexOf('<body'))
  // The first <style> in the body is USUALLY the splash's own few rules — but
  // it is not always. Vite emits the app stylesheet wherever it likes, and for
  // bento/type it lands in the BODY, so "first style in body" picked up the
  // whole 34KB sheet and inlined it here as plaintext. Combined with the
  // payload extracted above, the app's CSS then shipped TWICE in every saved
  // file.
  //
  // rel="stylesheet" is what marks the app sheet, so skip anything wearing it
  // and take the next block instead.
  for (const m of bodyPart.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)) {
    if (/\brel="stylesheet"/.test(m[1])) continue
    return m[2]
  }
  return ''
})()

const SLIDES_TOOLING = `<!--
  ════════════════════════════════════════════════════════════════════════
  AI AGENTS / TOOLING — READ THIS BEFORE EDITING THIS DECK
  ════════════════════════════════════════════════════════════════════════
  Full authoring guide (schema + copy-paste snippets): https://bento.page/agents.md

  THE MECHANICS
  · The document is the ONE script block of type "application/bento+json",
    id "bento-doc", below — plain readable JSON. Edit THAT block in place;
    never regenerate the whole file. Escape every "<" in the JSON as \\u003c.
  · The base64 blocks near the end are the DEFLATE-compressed app runtime
    (open source, https://bento.page) — no user content, leave them alone.
  · In a running file, window.bento exposes { doc, serialize(), loadDoc(json),
    comments(), updates, i18n }. In the app UI: Save → Copy / Replace JSON.
  · Schema: https://bento.page/schema/slides.json (= window.bento.schema()); agent index: https://bento.page/llms.txt

  MAKE A GREAT DECK, NOT JUST A CORRECT ONE
  Bento's whole point is motion + interactivity. A wall of text slides wastes
  it. When the source material contains ↓, reach for the feature:
  · numbers to compare visually (trend, magnitude, share)  →  a CHART
      element (preset bar|line|pie|scatter). Never list data as bullet text.
  · a comparison / spec / pricing / feature grid  →  a TABLE element
      (columns[] + rows[] of cells + a style object). Not a pile of textboxes.
  · consecutive slides about the SAME thing changing (before/after, process
    steps, a metric across stages)  →  give the shared elements the SAME id
    on both slides and set the later slide's transition to "morph". This is
    Bento's signature move — use it liberally; it is almost always missed.
  · a point to drill into (a definition, "click to see how")  →  a STATE
    slide (stateOf: "<parent-id>" + an element link: "<state-id>").
  · a hero / full-slide image  →  full-bleed image (0,0,1280,720) + a scrim
    rect + text on top, with a slow ken-burns drift
      (fx:{ambient:"kenburns",ken:{dir:"drift",scale:1.08,duration:20}}).
  · a sequence / flow / timeline / connection  →  a line or path with a
    loop (fx:{loop:{type:"dash-march",...}}), or morph a highlight through it.
  · a headline number  →  big, with fx:{countUp:true}.
  · every cover / section divider  →  at least ONE ambient motion so it is
    not dead static.
  · repeated chrome or a logo  →  keep its id stable across slides so it
    morphs in place instead of popping.

  BEFORE YOU FINISH — self-audit:
  [ ] any numbers rendered as text that should be a chart?
  [ ] do consecutive slides on one subject share ids + transition:"morph"?
  [ ] at least one motion moment (ken-burns / loop / count-up), esp. the cover?
  [ ] a drill-down that would work better as a state slide?
  [ ] one accent colour, at most two typefaces, 96px side margins?
  [ ] speaker notes written (they travel in the file)?
  ════════════════════════════════════════════════════════════════════════
-->`

// Every Bento app must point agents at the document block and the scripting
// API (docs/PLATFORM.md §7). Apps beyond slides get this short form until
// they have authoring guidance of their own worth shipping in every file.
const GENERIC_TOOLING = `<!--
  ════════════════════════════════════════════════════════════════════════
  AI AGENTS / TOOLING — READ THIS BEFORE EDITING THIS FILE
  ════════════════════════════════════════════════════════════════════════
  · The document is the ONE script block of type "application/bento+json",
    id "bento-doc", below — plain readable JSON. Edit THAT block in place;
    never regenerate the whole file. Escape every "<" in the JSON as \\u003c.
  · The base64 blocks near the end are the DEFLATE-compressed app runtime
    (open source, https://bento.page) — no user content, leave them alone.
  · In a running file, window.bento exposes { doc, serialize(), loadDoc(json) }.
  ════════════════════════════════════════════════════════════════════════
-->`

const TOOLING_COMMENT = generator === 'bento-slides' ? SLIDES_TOOLING : GENERIC_TOOLING

// --- loader (plain script, runs at end of body; no "</script>" literal) -----
// Keep the loader small: unlike the payloads it ships as PLAINTEXT in every
// file, so its comments are shipped bytes. Anything long goes here instead.
//
// TRANSIENT DOM — the style element it injects belongs to the RUNNING document
// only. A save clones the live DOM (kernel/src/save.ts capturePristine), so
// without the two guards below every save wrote this ~100KB of CSS back as
// plaintext, the next boot inflated the payload and appended another copy, and
// the file grew by 100KB per save without bound:
//   1. `data-bento-transient` — serializeBody() strips marked nodes from the
//      clone, so the CSS lives in the deflated #bento-rt-css payload (27KB)
//      and nowhere else in the file.
//   2. the sweep — a file written before guard 1 existed already carries N
//      plaintext copies of exactly this CSS; dropping them before injecting
//      means such a file is CLEANED by its next save rather than doubled.
const DIAG = `
  var box = null
  var say = function (t) {
    if (!box) {
      box = document.createElement('pre')
      box.id = 'bento-diag'
      box.setAttribute('data-bento-transient', '') // never saved into the file
      box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;max-height:70vh;overflow:auto;margin:0;padding:12px 16px;background:#000;color:#7CFC00;font:15px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all;z-index:2147483647'
      document.body.appendChild(box)
    }
    box.textContent += t + '\\n'
  }
  window.addEventListener('error', function (e) { say('window error: ' + e.message + ' @ ' + (e.filename || '?') + ':' + e.lineno) })
  window.addEventListener('unhandledrejection', function (e) { var r = e.reason; say('unhandled rejection: ' + (r && r.stack ? String(r.stack).split('\\n').slice(0, 4).join(' | ') : String(r))) })
  var probe = function (name, fn) { try { var v = fn(); say(name + ': ' + v) } catch (e) { say(name + ': THROWS ' + (e && e.name) + ' ' + (e && e.message)) } }
  var st0 = document.getElementById('bento-diag-static'); if (st0) st0.remove()
  say('bento loader diag ' + new Date().toISOString() + ' — the loader ran (the static "loader did not run" line was removed by its first statement)')
  var pl = function (id) {
    var el = document.getElementById(id); if (!el) return 'NOT FOUND'
    var t = (el.content ? el.content.textContent : el.textContent) || ''
    var expect = el.getAttribute('data-len')
    var line = 'found <' + el.tagName.toLowerCase() + (el.type ? ' type=' + el.type : '') + '> text length ' + t.length + (expect ? ' (built as ' + expect + (String(t.length) === expect ? ', same' : ', DIFFERS by ' + (t.length - Number(expect))) + ')' : '')
    var raw = t.trim()
    if (raw.length !== t.length) line += '; trimmed ' + (t.length - raw.length) + ' whitespace chars'
    var alpha = (el.type === 'bento/deflate-b86') ? ${JSON.stringify(ALPHABET)} : 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='
    for (var i = 0; i < raw.length; i++) {
      if (alpha.indexOf(raw.charAt(i)) < 0) { line += '; FIRST BAD CHAR at index ' + i + ': code ' + raw.charCodeAt(i) + ' ' + JSON.stringify(raw.charAt(i)) + ' around ' + JSON.stringify(raw.slice(Math.max(0, i - 8), i + 9)); return line }
    }
    return line + '; every char in the alphabet'
  }
  say('payload js (#bento-rt): ' + pl('bento-rt'))
  say('payload css (#bento-rt-css): ' + pl('bento-rt-css'))
  probe('typeof DecompressionStream', function () { return typeof DecompressionStream })
  probe('document.scripts', function () { var t = []; for (var i = 0; i < document.scripts.length; i++) t.push(document.scripts[i].type || '(no type)'); return document.scripts.length + ' [' + t.join(', ') + ']' })
  probe('trustedTypes', function () { return !!window.trustedTypes + (window.trustedTypes ? ' (default policy ' + (window.trustedTypes.defaultPolicy ? 'set' : 'none') + ')' : '') })
  probe('currentScript', function () { return document.currentScript ? 'parser' : 'no currentScript' })
  probe('localStorage.length', function () { return localStorage.length })
  probe('sessionStorage.length', function () { return sessionStorage.length })
  probe('indexedDB', function () { return typeof indexedDB })
  probe('location.origin', function () { return location.origin })
  probe('framed (self !== top)', function () { return self !== top })
  probe('userAgent', function () { return navigator.userAgent.slice(0, 40) })
  probe('meta csp', function () { var m = document.querySelector('meta[http-equiv=Content-Security-Policy]'); return m ? m.content : 'no meta csp (a header CSP is invisible here)' })
  document.addEventListener('securitypolicyviolation', function (e) { say('CSP violation: ' + e.violatedDirective + ' blocked ' + e.blockedURI + (e.sample ? ' sample ' + e.sample : '')) })
`
const loader = `
(async () => {${diag ? DIAG : ''}
  var violations = 0
  document.addEventListener('securitypolicyviolation', function () { violations++ })
  var fail = function (msg) {
    var d = document.createElement('div')
    d.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0D1B2E;color:#F2F0EA;font:16px/1.6 sans-serif;text-align:center;padding:40px;z-index:99999'
    d.innerHTML = msg
    document.body.appendChild(d)
    var s = document.getElementById('bento-splash'); if (s) s.remove()
  }
  if (typeof DecompressionStream === 'undefined'${inflateMode === 'native' ? '' : ' && false /* JS inflater below */'}) {
    // The old text said "2023 or later" and then listed Chrome 80, which is
    // 2020 — a reader checking their version against it learns nothing. It also
    // never said what kind of file this is, and never mentioned that the data
    // is plain readable JSON in this same file, which is the one route out that
    // works with no capable browser at all.
    fail('<b>This is a bento/dash spreadsheet.</b><br>Opening it needs a browser released in 2023 or later \\u2014 Safari 16.4+, Firefox 113+, or a current Chrome or Edge.<br><br>Nothing is lost: your data is stored as plain readable JSON inside this same file. Open it in a newer browser, or open it in a text editor and look for the block marked "bento-doc".')
    return
  }
  ${INFLATE_JS}${encoding === 'b86' ? B86_DECODER : ''}
  var inflate = async function (id) {
    var el = document.getElementById(id)
    var txt = (el.content ? el.content.textContent : el.textContent).trim()
    var bytes
    try { bytes = ${encoding === 'b86' ? 'b86decode(txt)' : "Uint8Array.from(atob(txt), function (c) { return c.charCodeAt(0) })"} }
    catch (e) {${diag ? ` say('DECODE FAILED for #' + id + ': ' + (e && e.name) + ': ' + (e && e.message));` : ''} throw e }
    var text
    if (${inflateMode === 'js' ? 'true' : inflateMode === 'auto' ? "typeof DecompressionStream === 'undefined'" : 'false'}) {
      text = new TextDecoder().decode(inflateRaw(bytes))${diag ? `
      say('inflated #' + id + ' with the JavaScript decoder: ' + text.length + ' chars')` : ''}
    } else {
      var ds = new DecompressionStream('deflate-raw')
      var stream = new Blob([bytes]).stream().pipeThrough(ds)
      text = await new Response(stream).text()${diag ? `
      say('inflated #' + id + ' with DecompressionStream: ' + text.length + ' chars')` : ''}
    }
    return text
  }
  try {
    var css = await inflate('bento-rt-css')
    // drop stale plaintext copies (see TRANSIENT DOM above), then inject ours
    var old = document.querySelectorAll('style')
    for (var i = 0; i < old.length; i++) {
      if (old[i].hasAttribute('data-bento-transient') || old[i].textContent === css) old[i].remove()
    }
    var st = document.createElement('style')
    st.id = 'bento-rt-style'
    st.setAttribute('data-bento-transient', '')
    st.textContent = css
    document.head.appendChild(st)
    var js = await inflate('bento-rt')
    ${['cascade', 'cascade-eval-first', 'cascade-eager-tt'].includes(loaderMode) ? `var tried = [], path = null, tt = 'none'
    var installTT = function () {
      if (tt !== 'none' || !(window.trustedTypes && window.trustedTypes.createPolicy)) return
      tt = 'installed'
      try { window.trustedTypes.createPolicy('bento', { createScript: function (s) { return s } }) } catch (e) { tried.push('tt bento: ' + (e && e.message)) }
      if (!window.trustedTypes.defaultPolicy) {
        try { window.trustedTypes.createPolicy('default', { createHTML: function (s) { return s }, createScript: function (s) { return s }, createScriptURL: function (s) { return s } }) } catch (e) { tried.push('tt default: ' + (e && e.message)) }
      }
    }
    // a sink refused a plain string: install the policies and let the caller retry once
    var needsTT = function (e) { return !!(e && /Trusted(Script|HTML)/.test(String(e.message))) && tt === 'none' }
    ${loaderMode === 'cascade-eager-tt' ? 'installTT()' : ''}
    // one attempt: run fn, then watch for a violation or the app for a short
    // window; a throw or a violation abandons it. Attributed by timing — the
    // window is the attempt's own, and nothing else inserts script here.
    var attempt = async function (name, fn) {
      if (window.bento && window.bento.doc) return true
      var why = null
      // attributed by WHAT was blocked, not only by timing: the eval probe's
      // own violation ('eval') arrives a task later and must not be read as
      // the inline attempt failing
      var onv = function (e) { if (e.blockedURI !== (name === 'blob' ? 'blob' : 'inline')) return; why = e.violatedDirective + ' blocked ' + e.blockedURI + (e.sample ? ' [' + String(e.sample).slice(0, 30) + ']' : '') }
      document.addEventListener('securitypolicyviolation', onv)
      try {
        fn()
        for (var i = 0; i < 12 && !why && !(window.bento && window.bento.doc); i++) await new Promise(function (r) { setTimeout(r, i < 4 ? 0 : 25) })
      } catch (e) { why = (e && e.name) + ': ' + (e && e.message) }
      document.removeEventListener('securitypolicyviolation', onv)
      var okp = !why && !!(window.bento && window.bento.doc)
      tried.push(name + (okp ? ': ok' : why ? ': ' + why : ': no app after the wait'))${diag ? `
      say('loader path ' + name + ' → ' + tried[tried.length - 1] + ' (t=' + Math.round(performance.now()) + ' ms since navigation)')` : ''}
      if (okp) path = name
      return okp
    }
    // synchronous: a throw or a success is known before the call returns
    var runNow = function (name, fn) {
      if (window.bento && window.bento.doc) return true
      try { fn() } catch (e) { tried.push(name + ': ' + (e && e.name) + ': ' + (e && e.message))${diag ? `; say('loader path ' + name + ' → ' + tried[tried.length - 1] + ' (t=' + Math.round(performance.now()) + ' ms since navigation)')` : ''}; return false }
      var okp = !!(window.bento && window.bento.doc)
      tried.push(name + (okp ? ': ok' : ': ran, no app'))${diag ? `
      say('loader path ' + name + ' → ' + tried[tried.length - 1] + ' (t=' + Math.round(performance.now()) + ' ms since navigation)')` : ''}
      if (okp) path = name
      return okp
    }
    var viaInline = function () {
      var sc = document.createElement('script')
      sc.type = 'module'
      sc.id = 'bento-rt-script'
      sc.setAttribute('data-bento-transient', '')
      try { sc.textContent = js } catch (e) {
        if (!needsTT(e)) throw e
        tried.push('inline sink: ' + (e && e.message)); installTT(); sc.textContent = js
      }
      document.body.appendChild(sc)
    }
    var viaFunction = function () {
      // the bundle has no top-level import/export/await, so it is a classic
      // function body; 'use strict' restores module semantics and the
      // sourceURL names it in DevTools (stacks say bento-slides.js, not
      // "anonymous")
      var run = function () { new Function("'use strict';" + js + "\\n//# sourceURL=bento-slides.js")() }
      try { run() } catch (e) { if (!needsTT(e)) throw e; tried.push('function sink: ' + (e && e.message)); installTT(); run() }
    }
    ${loaderMode === 'cascade-eval-first' ? `var evalOk = false
    try { new Function(''); evalOk = true } catch (e) {
      // under Trusted Types, new Function is itself a sink: install and re-probe once
      if (needsTT(e)) { tried.push('eval probe sink: ' + (e && e.message)); installTT(); try { new Function(''); evalOk = true } catch (e2) { e = e2 } }
      if (!evalOk) { tried.push('eval probe: ' + (e && e.name) + ': ' + (e && e.message))${diag ? `; say('loader path eval probe → refused: ' + (e && e.message))` : ''} }
    }
    if (evalOk) runNow('function', viaFunction)
    if (!path) await attempt('inline', viaInline)` : `await attempt('inline', viaInline)
    if (!path) runNow('function', viaFunction)`}
    if (!path) await attempt('blob', function () {
      var url = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }))
      import(url).catch(function (e) { throw e })
    })
    if (!path) throw new Error('every loader path was refused: ' + tried.join('; '))
    if (window.bento) window.bento.loader = { path: path, tried: tried, tt: tt, violations: violations }` : loaderMode !== 'blob' ? `// inline module: allowed under CSP 'unsafe-inline', needs no blob: source.
    // Transient like the style above — a save must never write the inflated
    // bundle back as plaintext (serializeBody strips marked nodes).
    var sc = document.createElement('script')
    sc.type = 'module'
    sc.id = 'bento-rt-script'
    sc.setAttribute('data-bento-transient', '')
    var src = js${loaderMode === 'inline-tt' ? `
    // Trusted Types: where the page requires them for script sinks, a plain
    // string assignment throws; a policy-made TrustedScript does not. A CSP
    // that allowlists policy names refuses any other name — that refusal is
    // itself the diagnosis, so it is reported rather than swallowed.
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
      try {
        var pol = window.trustedTypes.createPolicy('bento', { createScript: function (s) { return s } })
        src = pol.createScript(js)${diag ? `
        say('trustedTypes: policy "bento" created; assigning a TrustedScript')` : ''}
      } catch (e) {${diag ? `
        say('trustedTypes: createPolicy("bento") REFUSED: ' + (e && e.name) + ': ' + (e && e.message))` : ''}
      }
      // The app itself assigns innerHTML (the renderer, the sanitizer) and
      // script.text (the save path writes #bento-doc back) from strings. Under
      // enforced Trusted Types every one of those throws unless a DEFAULT
      // policy exists — the browser routes plain-string sink assignments
      // through it. A CSP that allowlists policy names must include "default"
      // for this to be allowed; where it is refused, the refusal is reported.
      if (!window.trustedTypes.defaultPolicy) {
        try {
          window.trustedTypes.createPolicy('default', { createHTML: function (s) { return s }, createScript: function (s) { return s }, createScriptURL: function (s) { return s } })${diag ? `
          say('trustedTypes: DEFAULT policy created (string sinks pass through)')` : ''}
        } catch (e) {${diag ? `
          say('trustedTypes: createPolicy("default") REFUSED: ' + (e && e.name) + ': ' + (e && e.message))` : ''}
        }
      }
    }` : ''}
    try { sc.textContent = src } catch (e) {${diag ? `
      say('script.textContent assignment threw: ' + (e && e.name) + ': ' + (e && e.message) + ' — trying script.text')` : ''}
      sc.text = src
    }
    document.body.appendChild(sc)${diag ? `
    say('module script appended (' + js.length + ' chars); waiting for the app to mount')` : ''}` : `var url = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }))
    await import(url)`}
  } catch (e) {${diag ? `
    say('BOOT FAILED: ' + (e && e.name) + ': ' + (e && e.message) + (e && e.stack ? ' | ' + String(e.stack).split('\\n').slice(0, 3).join(' | ') : ''))` : ''}
    fail('This file could not start: ' + (e && e.message ? e.message : e))
  }
})()
`
if (loader.includes('</scr' + 'ipt>')) throw new Error('loader contains script-close')

// --- assemble ----------------------------------------------------------------
const out = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="only light" />
    <meta name="generator" content="${generator}" />
    ${favicon}
    ${title}
    ${notice}
    ${TOOLING_COMMENT}
    ${docBlock}
    <style>${splashCss}</style>
  </head>
  <body>
    ${splashDiv}${diag ? `
    <pre id="bento-diag-static" style="position:fixed;left:0;right:0;bottom:0;margin:0;padding:12px 16px;background:#000;color:#ff5555;font:15px/1.45 ui-monospace,Menlo,monospace;z-index:2147483647">loader did not run — this line is static markup; the loader's first statement removes it</pre>` : ''}
    <div id="app"></div>
    ${carrier === 'template' ? `<template id="bento-rt-css" data-bento-payload="css">${cssB64}</template>
    <template id="bento-rt" data-bento-payload="js">${jsB64}</template>` : carrier === 'textplain' ? `<script id="bento-rt-css" type="text/plain" data-bento-payload="css" data-bento-encoding="${encoding}">${cssB64}</script>
    <script id="bento-rt" type="text/plain" data-bento-payload="js">${jsB64}</script>` : `<script id="bento-rt-css" type="${PAYLOAD_TYPE}" data-len="${cssB64.length}">${cssB64}</script>
    <script id="bento-rt" type="${PAYLOAD_TYPE}" data-len="${jsB64.length}">${jsB64}</script>`}
    <script>${loader}</script>
  </body>
</html>
`

// sanity: script-close count must equal script tag count (splice invariant)
const closes = out.split('</scr' + 'ipt>').length - 1
const opens = (out.match(/<script[\s>]/g) ?? []).length
if (closes !== opens) throw new Error(`script tag imbalance: ${opens} opens, ${closes} closes`)

writeFileSync(path, out)
const kb = (n) => `${Math.round(n / 1024)}KB`
console.log(`compressed shell: ${kb(html.length)} → ${kb(out.length)} (js ${kb(js.length)}→${kb(jsB64.length)}, css ${kb(css.length)}→${kb(cssB64.length)}, ${encoding})`)
