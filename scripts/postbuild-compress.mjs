#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
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
import { deflateRawSync } from 'node:zlib'

const path = process.argv[2]
if (!path) {
  console.error('usage: node scripts/postbuild-compress.mjs <shell.html>')
  process.exit(1)
}

const html = readFileSync(path, 'utf8')
if (html.includes('id="bento-rt"')) {
  console.log('already compressed — skipping')
  process.exit(0)
}

// --- extract the runtime pieces --------------------------------------------
const modRe = /<script type="module"[^>]*>([\s\S]*?)<\/script>/
const mod = html.match(modRe)
if (!mod) throw new Error('module script not found')

// the FIRST big <style> is the app css; the splash <style> lives in body
const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/
const headPart = html.slice(0, html.indexOf('</head>'))
const styleM = headPart.match(styleRe)
if (!styleM) throw new Error('app stylesheet not found in head')

const js = mod[1]
const css = styleM[1]

const b64 = (s) => deflateRawSync(Buffer.from(s, 'utf8'), { level: 9 }).toString('base64')
const jsB64 = b64(js)
const cssB64 = b64(css)

// --- other parts ------------------------------------------------------------
const notice = html.match(/<!--\s*NOTICE[\s\S]*?-->/)?.[0] ?? ''
const docBlock = html.match(/<script type="application\/bento\+json" id="bento-doc">[\s\S]*?<\/script>/)?.[0]
if (!docBlock) throw new Error('#bento-doc not found')
const favicon = html.match(/<link rel="icon"[^>]*\/?>/)?.[0] ?? ''
const title = html.match(/<title>[\s\S]*?<\/title>/)?.[0] ?? '<title>Bento Slides</title>'
const splashDiv = html.match(/<div id="bento-splash"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? ''
const splashCss = (() => {
  const bodyPart = html.slice(html.indexOf('<body'))
  const m = bodyPart.match(/<style[^>]*>([\s\S]*?)<\/style>/)
  return m ? m[1] : ''
})()

const TOOLING_COMMENT = `<!--
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
    comments(), updates, i18n }. In the app UI: About → Copy / Replace JSON.

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

// --- loader (plain script, runs at end of body; no "</script>" literal) -----
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
    fail('This file needs a browser from 2023 or later (Chrome 80+, Edge, Firefox 113+, Safari 16.4+).<br>The document itself is intact \\u2014 open this file in a newer browser.')
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
    var st = document.createElement('style')
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
    <meta name="generator" content="bento-slides" />
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
