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

const b64 = async (s) => (await deflate(Buffer.from(s, 'utf8'))).toString('base64')
const jsB64 = await b64(js)
const cssB64 = await b64(css)

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
const loader = `
(async () => {
  var fail = function (msg) {
    var d = document.createElement('div')
    d.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0D1B2E;color:#F2F0EA;font:16px/1.6 sans-serif;text-align:center;padding:40px;z-index:99999'
    d.innerHTML = msg
    document.body.appendChild(d)
    var s = document.getElementById('bento-splash'); if (s) s.remove()
  }
  if (typeof DecompressionStream === 'undefined') {
    // The old text said "2023 or later" and then listed Chrome 80, which is
    // 2020 — a reader checking their version against it learns nothing. It also
    // never said what kind of file this is, and never mentioned that the data
    // is plain readable JSON in this same file, which is the one route out that
    // works with no capable browser at all.
    fail('<b>This is a bento/dash spreadsheet.</b><br>Opening it needs a browser released in 2023 or later \\u2014 Safari 16.4+, Firefox 113+, or a current Chrome or Edge.<br><br>Nothing is lost: your data is stored as plain readable JSON inside this same file. Open it in a newer browser, or open it in a text editor and look for the block marked "bento-doc".')
    return
  }
  var inflate = async function (id) {
    var b64 = document.getElementById(id).textContent.trim()
    var bytes = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0) })
    var ds = new DecompressionStream('deflate-raw')
    var stream = new Blob([bytes]).stream().pipeThrough(ds)
    return await new Response(stream).text()
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
    var url = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }))
    await import(url)
  } catch (e) {
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
    ${splashDiv}
    <div id="app"></div>
    <script id="bento-rt-css" type="bento/deflate-b64">${cssB64}</script>
    <script id="bento-rt" type="bento/deflate-b64">${jsB64}</script>
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
console.log(`compressed shell: ${kb(html.length)} → ${kb(out.length)} (js ${kb(js.length)}→${kb(jsB64.length)}, css ${kb(css.length)}→${kb(cssB64.length)})`)
