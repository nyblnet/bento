// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The "This file could not be opened" message shows the file's details as TEXT.
//
//   npm run build:single --prefix type && node scripts/test-type-cantopen-browser.mjs
//
// When bento/type cannot read the document a file carries, it says why and
// stops (main.ts). The reason can quote the file itself, such as an unknown
// format's own name or a JSON parser's message about the bytes. That text must
// reach the page as text. It used to be interpolated into innerHTML, so a file
// whose `format` was `<img src=x onerror=…>` put a live element on the page and
// ran its handler.
//
// WHAT THIS PROVES, in the packaged document, for files whose document block
// is (1) a `format` holding markup with an onerror handler, (2) markup that is
// not JSON at all, and (3) a real bento/enc envelope:
//   - the message is shown, with the file's detail as literal text;
//   - no element from the file reaches the page (no img, no b), and the
//     handler's sentinel never fires;
//
//   - no text from the file appears anywhere outside that message; type's
//     boot error is a fixed sentence, since the detail is already on screen;
//   - type publishes window.bento = { format, refused: true } (the shell
//     loader's contract for "painted its own refusal"), so the page shows ONE
//     message: the app does not run again on a later loader path, and no
//     "This file could not start" card is painted over it.
//
// Mutations (run, judged by exit code): set the detail line with innerHTML
// instead of textContent → red; put the detail back into the thrown error
// → red; drop the published refusal → red.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

const shell = readFileSync(new URL('../type/dist-single/Bento_Type.bento.html', import.meta.url), 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'bento-type-cantopen-'))
const withBlock = (name, block) => {
  const out = shell.replace(/(<script[^>]*id="bento-doc"[^>]*>)[\s\S]*?(<\/script>)/, (_m, a, b) => a + '\n' + block + '\n' + b)
  if (out === shell) throw new Error('could not find the #bento-doc block')
  const f = join(dir, name); writeFileSync(f, out); return 'file://' + f
}
const SENTINEL = "window.__fired=1"
const MARKUP = `<img src=x onerror="${SENTINEL}"><b>bold</b>`
const esc = (s) => s.replace(/</g, '\\u003c')   // as save.ts writes a block
const CASES = [
  { name: 'a format holding markup', url: withBlock('fmt.html', esc(JSON.stringify({ format: MARKUP, body: [] }))), literal: '<img src=x onerror=' },
  { name: 'markup that is not JSON', url: withBlock('json.html', esc(MARKUP + ' {')), literal: null },
  { name: 'an encrypted (bento/enc) document', url: withBlock('enc.html', JSON.stringify({ format: 'bento/enc', v: 1, it: 300000, salt: 'AAAA', iv: 'AAAA', data: 'AAAA' })), literal: 'this file is a bento/enc document' },
]

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  for (const c of CASES) {
    const p = await browser.newPage()
    await p.route(/^https?:/, (r) => r.abort())
    await p.goto(c.url)
    await p.waitForFunction(() => document.body.textContent.includes('This file could not be opened'), null, { timeout: 15000 }).catch(() => {})
    await p.waitForTimeout(800)   // long enough for an onerror on a failed image load to have run
    const r = await p.evaluate(() => {
      const h1 = [...document.querySelectorAll('h1')].find((h) => h.textContent === 'This file could not be opened')
      const card = h1?.parentElement
      return {
        shown: !!card,
        detail: card?.querySelectorAll('p')[0]?.textContent ?? '',
        fromFile: document.querySelectorAll('body img, body b').length,
        fired: window.__fired === 1,
        published: JSON.stringify({ format: window.bento?.format, refused: window.bento?.refused, doc: !!window.bento?.doc }),
        messages: [...document.querySelectorAll('h1')].filter((h) => h.textContent === 'This file could not be opened').length,
        startCard: document.body.textContent.includes('This file could not start'),
        // everything on the page outside type's own message
        outside: [...document.body.querySelectorAll('*')].filter((e) => !card?.contains(e) && !e.contains(card) && !e.closest('script, style'))
          .map((e) => e.textContent).join(' '),
      }
    })
    ok(r.shown, `${c.name}: the can't-open message is shown`)
    ok(r.published === '{"format":"bento/type","refused":true,"doc":false}', `${c.name}: the refusal is published for the shell loader (${r.published})`)
    ok(r.messages === 1 && !r.startCard, `${c.name}: exactly one message, and no "could not start" card over it (${r.messages} message(s), start card ${r.startCard})`)
    if (c.literal) ok(r.detail.includes(c.literal), `${c.name}: the detail reads as literal text ("${r.detail.slice(0, 70)}")`)
    ok(!/onerror|__fired|<img|<b>|bold/.test(r.outside),
      `${c.name}: no text from the file appears anywhere outside the message`)
    ok(r.fromFile === 0 && !r.fired, `${c.name}: nothing from the file became an element (${r.fromFile}) and its handler never ran (${r.fired})`)
    await p.close()
  }
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
