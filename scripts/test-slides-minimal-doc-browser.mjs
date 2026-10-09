// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// An under-specified document boots instead of hanging on the splash.
//
//   npm run build:single --prefix slides && node scripts/test-slides-minimal-doc-browser.mjs
//
// WHAT THIS PROVES, in the packaged document. parseDoc checked `format` and a
// non-empty `slides` and nothing else, so a hand- or agent-written document
// that omitted a REQUIRED field got through and crashed the shell during boot —
// no `theme` died on `undefined.palette`, no `size` on `width`, a bare
// `{type:'text'}` on `indexOf`, a `null` element on `themeRefs` — and the
// reader was left on the splash screen for good (measured on 1.2.5; found by
// bento/share's opener work). parseDoc now fills each required field from the
// editor's own defaults ONLY where it is absent or the wrong type, and drops an
// element that cannot render (the paste gate's REQUIRED_ELEMENT_KEYS, now one
// table in model.ts). Checked here:
//   1. every under-specified shape found boots into the editor, no page error;
//   2. what was given is kept (title, accent, a slide's own background);
//   3. format additivity: keys this version does not know — on the document,
//      a slide, the theme — and an element of an unknown TYPE survive boot;
//   4. control: the starter deck boots unchanged.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const shellPath = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url)
const shell = readFileSync(shellPath, 'utf8')
const open = '<script type="application/bento+json" id="bento-doc">'
const close = '</' + 'script>'
const at = shell.indexOf(open) + open.length
const dir = mkdtempSync(join(tmpdir(), 'bento-minimal-'))
const slide = (elements) => ({ format: 'bento/slides', slides: [{ id: 's1', elements }] })
const CASES = {
  'no theme, no size (the report)': { format: 'bento/slides', title: 'plain', slides: [{ id: 's1', elements: [] }] },
  'no title, slide with only an id': { format: 'bento/slides', slides: [{ id: 's1' }] },
  'partial theme, no size': { format: 'bento/slides', title: 'p', theme: { accent: '#ff0000' }, slides: [{ id: 's1', background: '#123456', elements: [] }] },
  'null element': slide([null]),
  'number element': slide([3]),
  'element with no type': slide([{}]),
  'text with no html': slide([{ type: 'text', id: 't', x: 0, y: 0, w: 100, h: 40 }]),
  'shape with no kind': slide([{ type: 'shape' }]),
  'image with no src': slide([{ type: 'image' }]),
  'table with no rows': slide([{ type: 'table' }]),
  'media with no src': slide([{ type: 'media' }]),
  'junk slides': { format: 'bento/slides', slides: [7, null, { id: 's2', elements: [null, 3, {}] }] },
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
async function boot(doc) {
  const file = join(dir, `d${Math.random().toString(36).slice(2)}.bento.html`)
  writeFileSync(file, shell.slice(0, at) + (doc ? JSON.stringify(doc).replace(/</g, '\\u003c') : '') + shell.slice(shell.indexOf(close, at)))
  const p = await browser.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.route(/^https?:/, (r) => r.abort())
  await p.goto('file://' + file)
  const booted = await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-topbar') && !document.getElementById('bento-splash'), null, { timeout: 8000 }).then(() => true, () => false)
  const doc2 = booted ? await p.evaluate(() => JSON.parse(JSON.stringify(window.bento.doc))) : null
  await p.close()
  return { booted, errors, doc: doc2 }
}

try {
  console.log('under-specified documents boot\n')
  for (const [name, doc] of Object.entries(CASES)) {
    const r = await boot(doc)
    ok(r.booted && r.errors.length === 0, `${name}${r.errors.length ? ' — ' + r.errors[0].slice(0, 80) : ''}`)
  }

  console.log('\nwhat was given is kept\n')
  {
    const r = await boot(CASES['partial theme, no size'])
    ok(r.doc?.title === 'p' && r.doc?.theme?.accent === '#ff0000', `title and the given accent survive (${r.doc?.title}, ${r.doc?.theme?.accent})`)
    ok(r.doc?.slides?.[0]?.background === '#123456', 'the slide\'s own background survives')
    ok(typeof r.doc?.theme?.fontFamily === 'string' && r.doc?.size?.width > 0, 'the missing theme keys and size are filled')
  }

  console.log('\nformat additivity: what this version does not know survives\n')
  {
    const future = {
      format: 'bento/slides', title: 'from a newer Bento', futureDocKey: { a: 1 },
      theme: { background: '#fff', color: '#111', accent: '#f60', fontFamily: 'serif', futureThemeKey: 'x' },
      size: { width: 1280, height: 720 },
      slides: [{ id: 's1', background: '#fff', transition: 'fade', notes: '', futureSlideKey: 'y',
        elements: [{ type: 'hologram', id: 'h', x: 0, y: 0, w: 50, h: 50, beam: 3 }, { type: 'text', id: 't', x: 0, y: 0, w: 100, h: 40, html: 'hi', futureProp: true }] }],
    }
    const r = await boot(future)
    ok(r.booted && r.errors.length === 0, 'a document from a newer version boots')
    ok(r.doc?.futureDocKey?.a === 1 && r.doc?.theme?.futureThemeKey === 'x' && r.doc?.slides?.[0]?.futureSlideKey === 'y', 'unknown document, theme and slide keys are kept')
    const els = r.doc?.slides?.[0]?.elements ?? []
    ok(els.some((e) => e.type === 'hologram' && e.beam === 3), 'an element of an unknown type is kept, whole')
    ok(els.some((e) => e.type === 'text' && e.futureProp === true), 'an unknown property on a known element is kept')
  }

  console.log('\ncontrol\n')
  {
    const r = await boot(null) // the empty block boots the starter deck
    ok(r.booted && r.errors.length === 0 && r.doc?.slides?.length > 10, `the starter deck boots (${r.doc?.slides?.length} slides)`)
  }
} finally { await browser.close() }

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
