// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// No document value becomes script in bento/type's editor: an embed's picture
// is kept by ALLOWLIST, and a footnote id cannot leave its attribute.
//
//   npm run build:single --prefix type && node scripts/test-type-sinks-browser.mjs
//
// Two paths a document's own values took into live markup, both measured
// running in the editor before the fix:
//   - an embed's SVG passed a handler check that wanted whitespace before
//     "on…=" — the HTML tokenizer also starts an attribute after `/`, so
//     `<circle/onmouseover=…>` rendered and ran;
//   - a footnote id was written unescaped into data-note="…".
// The embed view is now walked by svgsafe.ts (allowlist of tag and attribute
// NAMES, modelled on slides' sanitizeSvg) and imported as nodes; the note id is
// escaped at render (the layer a synced op meets — pinned in
// scripts/test-type-embed.ts) and limited to a safe charset by parseDoc.
//
// WHAT THIS PROVES, in the packaged editor: every hostile picture renders with
// no on* attribute, no javascript:/remote href, no script/foreignObject, and
// hovering and clicking every element of it runs NOTHING (a page-global counter
// is the oracle); the same holds for what print emits. Positive control: a
// benign diagram — gradient, url(#…) fill, <use href="#…">, text — still
// renders with all of those intact, so the sanitizer is not passing by
// deleting everything. And a hostile footnote id in a file runs nothing.
//
// Mutations (run, judged by exit code): the editor sink back on the old
// whitespace-only check (innerHTML of safeView) → red; on* names allowed in
// svgsafe.ts → red.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }
const SHELL = new URL('../type/dist-single/Bento_Type.bento.html', import.meta.url).href
const RUN = 'window.__pwned=(window.__pwned||0)+1'

const HOSTILE = {
  'slash before on*': `<svg width="120" height="120"><circle/onmouseover="${RUN}" cx="60" cy="60" r="50"/></svg>`,
  'quote before on*': `<svg width="120" height="120"><rect x="1"onclick="${RUN}" width="100" height="100"/></svg>`,
  'on* on the root': `<svg onload="${RUN}" width="50" height="50"><rect width="40" height="40"/></svg>`,
  'script inside': `<svg width="50" height="50"><script>${RUN}</script><rect width="40" height="40"/></svg>`,
  'foreignObject + img onerror': `<svg width="50" height="50"><foreignObject width="50" height="50"><img src="x:" onerror="${RUN}"></foreignObject></svg>`,
  'animate href to javascript:': `<svg width="80" height="80"><a><rect width="70" height="70"/><animate attributeName="href" values="javascript:${RUN}" begin="0s"/></a></svg>`,
  'set attributeName on*': `<svg width="80" height="80"><rect width="70" height="70"><set attributeName="onmouseover" to="${RUN}"/></rect></svg>`,
  'use with javascript: href': `<svg width="80" height="80"><use href="javascript:${RUN}"/><rect width="70" height="70"/></svg>`,
  'image with javascript: href': `<svg width="80" height="80"><image href="javascript:${RUN}" width="70" height="70"/></svg>`,
  'remote url() fill': `<svg width="80" height="80"><rect width="70" height="70" fill="url(http://rc.test/x)"/></svg>`,
  'css-escaped url() fill': `<svg width="80" height="80"><rect width="70" height="70" fill="\\75 rl(http://rc.test/y)"/></svg>`,
  'style element @import': `<svg width="80" height="80"><style>@import url(http://rc.test/z);</style><rect width="70" height="70"/></svg>`,
  // values no scheme check refuses (no javascript:, no url()) — only the rule
  // that judges an animation by the attribute it WRITES stops these
  'use animated to a remote href': `<svg width="80" height="80"><defs><rect id="a" width="60" height="60"/></defs><use href="#a"><animate attributeName="href" to="https://rc.test/x.svg#a" begin="0s" fill="freeze"/></use></svg>`,
  'a animated to a scheme-relative href': `<svg width="80" height="80"><a href="#x"><rect width="70" height="70"/><animate attributeName="href" to="//rc.test/p" begin="0s" fill="freeze"/></a></svg>`,
}
const BENIGN = `<svg width="200" height="120" viewBox="0 0 200 120"><defs><linearGradient id="g"><stop offset="0" stop-color="#f7a600"/><stop offset="1" stop-color="#5b8def"/></linearGradient><circle id="c" r="10"/></defs><rect width="200" height="120" fill="url(#g)"/><use href="#c" x="30" y="30"/><text x="10" y="110">Q3</text></svg>`

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
const requests = []
const open = async () => {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await p.route(/^https?:/, (r) => { requests.push(r.request().url()); r.abort() })
  await p.goto(SHELL)
  await p.waitForFunction(() => window.bento?.doc)
  return p
}
const docWith = (view) => JSON.stringify({ format: 'bento/type', docId: 'd-' + Math.random().toString(36).slice(2), title: 't',
  body: [{ id: 'e1', kind: 'embed', text: '', embed: { app: 'bento/dash', view, doc: {} } }, { id: 'p1', kind: 'para', text: 'After.' }] })

try {
  console.log('\n1. a benign diagram still renders (positive control)\n')
  {
    const p = await open()
    await p.evaluate((j) => window.bento.loadDoc(j), docWith(BENIGN))
    await p.waitForTimeout(400)
    const r = await p.evaluate(() => {
      const svg = document.querySelector('#paper .t-embed-view svg')
      return svg ? { grad: !!svg.querySelector('linearGradient stop'), fill: svg.querySelector('rect')?.getAttribute('fill'),
        use: svg.querySelector('use')?.getAttribute('href'), text: svg.querySelector('text')?.textContent } : null
    })
    ok(!!r && r.grad && r.fill === 'url(#g)' && r.use === '#c' && r.text === 'Q3',
      `the benign diagram keeps its gradient, url(#g) fill, <use href="#c"> and text (${JSON.stringify(r)})`)
    await p.close()
  }

  console.log('\n2. hostile pictures render inert in the editor and in print\n')
  for (const [name, view] of Object.entries(HOSTILE)) {
    const p = await open()
    const before = requests.length
    await p.evaluate((j) => window.bento.loadDoc(j), docWith(view))
    await p.waitForTimeout(500)
    const scan = await p.evaluate(() => {
      const els = [...document.querySelectorAll('#paper .t-embed, #paper .t-embed *')]
      return {
        on: els.filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).length,
        js: els.filter((e) => [...e.attributes].some((a) => /^(href|xlink:href|values|to|from)$/i.test(a.name) && /javascript:|https?:/i.test(a.value))).length,
        bad: document.querySelectorAll('#paper .t-embed script, #paper .t-embed foreignObject, #paper .t-embed style').length,
        boxes: els.length,
        svg: !!document.querySelector('#paper .t-embed-view svg'),
      }
    })
    // hover and click every element of the picture (or its placeholder)
    const targets = await p.$$('#paper .t-embed, #paper .t-embed *')
    for (const t of targets) { await t.hover({ force: true }).catch(() => {}); await t.click({ force: true, timeout: 500 }).catch(() => {}) }
    await p.waitForTimeout(300)
    await p.waitForTimeout(300)                     // let a frozen animation land before reading
    const ran = await p.evaluate(() => window.__pwned || 0)
    const stayed = p.url() === SHELL
    const printed = await p.evaluate(() => {
      const d = new DOMParser().parseFromString(window.bento.printHtml(), 'text/html')
      const all = [...d.querySelectorAll('.t-embed, .t-embed *')]
      return { on: all.filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).length,
               bad: d.querySelectorAll('.t-embed script, .t-embed foreignObject, .t-embed style').length,
               js: all.filter((e) => [...e.attributes].some((a) => /javascript:/i.test(a.value))).length }
    })
    const fetched = requests.slice(before).filter((u) => u.includes('rc.test')).length
    ok(scan.svg && scan.on === 0 && scan.js === 0 && scan.bad === 0 && ran === 0 && fetched === 0 && stayed
       && printed.on === 0 && printed.bad === 0 && printed.js === 0,
      `${name}: the picture still RENDERS (${scan.svg}), no navigation on click (${stayed}), inert in the editor (on* ${scan.on}, js/remote ${scan.js}, script/foreign/style ${scan.bad}, ran ${ran}, fetched ${fetched}) and in print (on* ${printed.on}, ${printed.bad}, js ${printed.js})`)
    await p.close()
  }

  console.log('\n3. a hostile footnote id in a FILE runs nothing\n')
  {
    const p = await open()
    const NID = `n1" onmouseover="${RUN}" data-x="`
    await p.evaluate((j) => window.bento.loadDoc(j), JSON.stringify({ format: 'bento/type', docId: 'd-n', title: 't',
      footnotes: { [NID]: 'evil', ok1: 'fine' }, body: [{ id: 'b1', kind: 'para', text: 'Hello world', notes: [{ id: NID, at: 2 }, { id: 'ok1', at: 5 }] }] }))
    await p.waitForTimeout(400)
    for (const t of await p.$$('#paper [data-note]')) await t.hover({ force: true }).catch(() => {})
    await p.waitForTimeout(200)
    const r = await p.evaluate(() => ({ markers: document.querySelectorAll('#paper [data-note]').length,
      on: [...document.querySelectorAll('#paper *')].filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).length, ran: window.__pwned || 0 }))
    ok(r.markers >= 1 && r.on === 0 && r.ran === 0, `no handler and nothing runs; the ordinary note still renders (markers ${r.markers}, on* ${r.on}, ran ${r.ran})`)
    await p.close()
  }
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
