// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type boots on the shell loader's synchronous path, and the fields
// wiring that used to be lazily imported still works.
//
//   npm run build:single --prefix type && node scripts/test-type-boot-browser.mjs
//
// The loader runs an app's bundle as an inline CLASSIC script first. A bundle
// containing `import.meta` cannot run that way. fields.ts once had two dynamic
// `import()`s (toc.ts for pageOfY, model.ts for spliceText), and in a
// single-file build Vite compiles those to a helper carrying import.meta.url.
// So every type boot failed the inline path and the next one, threw a page
// error, and started from the loader's last resort. The two pieces now live in
// fieldwire.ts, which imports both statically.
//
// WHAT THIS PROVES, in the packaged document:
//   1. the boot takes the loader's inline path, with no page error;
//   2. after pagination a `page` field far down a long document shows the page
//      it is on (not 1), and `pages` shows the page count: the measurement
//      fieldwire.ts hooks up still runs;
//   3. ⋯ → "Turn {{…}} tokens into fields" still binds a {{title}} token.
//
// Mutation (run, judged by exit code): restore the dynamic import of toc.ts
// in place of fieldwire.ts's measurement → 1 goes red.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }
const SHELL = process.env.TYPE_SHELL || new URL('../type/dist-single/Bento_Type.bento.html', import.meta.url).href

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.route(/^https?:/, (r) => r.abort())
  await p.goto(SHELL)
  await p.waitForFunction(() => window.bento?.doc)
  const loader = await p.evaluate(() => window.bento.loader)
  ok(loader?.path === 'inline' && errors.length === 0,
    `the boot takes the loader's inline path with no page error (path ${loader?.path}; tried ${JSON.stringify(loader?.tried)}; errors ${JSON.stringify(errors)})`)

  // 2. a long document: a `page` field near the end, a `pages` field at the top
  await p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    const para = (i, text) => ({ id: `p${i}`, kind: 'para', text })
    const body = [para(0, 'Pages: ')]
    for (let i = 1; i < 90; i++) body.push(para(i, `Paragraph ${i}. ` + 'The quick brown fox jumps over the lazy dog. '.repeat(4)))
    body.push(para(90, 'This is page '))
    body[0].fields = [{ at: 7, name: 'pages' }]
    body[90].fields = [{ at: 13, name: 'page' }]
    d.body = body; d.footnotes = {}
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForFunction(() => (window.bento.pages?.() ?? window.bento.paginate?.()?.pages?.length ?? 0) && document.querySelector('#paper [data-field="page"]'), null, { timeout: 15000 }).catch(() => {})
  await p.waitForTimeout(1200)
  const f = await p.evaluate(() => ({
    page: document.querySelector('#paper [data-field="page"]')?.textContent?.trim(),
    pages: document.querySelector('#paper [data-field="pages"]')?.textContent?.trim(),
  }))
  ok(Number(f.pages) >= 3, `a "pages" field shows the page count (${f.pages})`)
  ok(Number(f.page) >= 3 && Number(f.page) === Number(f.pages), `a "page" field on the last page shows that page, not 1 (${f.page} of ${f.pages})`)

  // 3. tokens into fields, through the menu
  await p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.title = 'Quarterly report'
    d.body = [{ id: 't1', kind: 'para', text: 'Title: {{title}}.' }]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(300)
  await p.click('#more')
  await p.getByRole('button', { name: /Turn \{\{…\}\} tokens into fields/ }).or(p.getByRole('menuitem', { name: /Turn \{\{…\}\} tokens into fields/ })).first().click()
  await p.waitForTimeout(400)
  const b = await p.evaluate(() => { const b = window.bento.doc.body[0]; return { text: b.text, fields: (b.fields || []).map((x) => x.name) } })
  ok(b.fields.join() === 'title' && !b.text.includes('{{'), `"Turn {{…}} tokens into fields" binds the token (text ${JSON.stringify(b.text)}, fields ${b.fields})`)
  await p.close()
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
