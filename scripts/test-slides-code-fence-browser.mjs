#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Code in a text box, driven through the packaged document (Chromium):
//
//   npm run build:single --prefix slides && node scripts/test-slides-code-fence-browser.mjs
//
// WHAT THIS PROVES (slides/src/editor/codefence.ts). Multi-line text could not
// become code: the backtick shortcut only converted `x` on one line, and
// nothing turned text into a Code element. Now, typed with a real keyboard
// into a real text box:
//   1. a box that is only a ``` fence becomes a Code element IN PLACE — same id
//      (morph pairing survives), the language from the info string, the code
//      exactly as typed (a `template` literal keeps its backticks: autoformat
//      stays out of an open fence);
//   2. a box with text around the fence splits into text / code / text,
//      stacked top to bottom inside where the box was;
//   3. an unclosed fence stays text;
//   4. typing ``` right after entering a box REPLACES its text (the automatic
//      select-all is not a request to wrap);
//   5. selecting lines and pressing ` wraps each line in <code>; pressing it
//      again unwraps;
//   6. a fence pasted into a box being edited, and one pasted onto the canvas,
//      both become Code elements.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0, failures = 0
const ok = (cond, msg) => { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }
const SHELL = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })

/** A fresh page on a one-slide deck holding one text box 'tx'. */
async function fresh(html = 'Old text') {
  const p = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.route(/^https?:/, (r) => r.abort())
  await p.goto(SHELL)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale'))
  await p.evaluate((html) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    const s = d.slides[0]
    d.slides = [{ ...s, id: 'fence-slide', stateOf: undefined, elements: [{
      id: 'tx', type: 'text', x: 200, y: 150, w: 880, h: 300, rotation: 0, opacity: 1,
      html, fontSize: 32, fontFamily: 'Inter, sans-serif', fontWeight: 400, color: '#1E2A3A',
      align: 'left', valign: 'top', lineHeight: 1.2, morphId: 'keep-me' }] }]
    window.bento.loadDoc(JSON.stringify(d))
  }, html)
  await p.waitForTimeout(300)
  return { p, errors }
}
const edit = async (p) => {
  await p.locator('.ed-stage-scale [data-el-id="tx"]').dblclick()
  await p.waitForFunction(() => document.querySelector('.ed-stage-scale .bento-editing'))
}
const typeLines = async (p, lines) => {
  for (let i = 0; i < lines.length; i++) {
    if (i) await p.keyboard.press('Enter')
    await p.keyboard.type(lines[i], { delay: 5 })
  }
}
const commit = async (p) => { await p.keyboard.press('Escape'); await p.waitForTimeout(300) }
const els = (p) => p.evaluate(() => window.bento.doc.slides[0].elements.map((e) => ({
  id: e.id, type: e.type, y: e.y, h: e.h, x: e.x, w: e.w, morphId: e.morphId,
  content: e.content, grammarName: e.grammarName, html: e.html })))

try {
  console.log('\n1 · a box that is only a fence → a Code element in place\n')
  {
    const { p, errors } = await fresh()
    await edit(p)
    await typeLines(p, ['```js', 'const a = `hi`', 'const b = 2', '```'])
    await commit(p)
    const e = await els(p)
    ok(e.length === 1 && e[0].type === 'code', `one element, now code (${e.map((x) => x.type).join(', ')})`)
    ok(e[0]?.id === 'tx' && e[0]?.morphId === 'keep-me', 'same id and morph key — it still pairs across slides')
    ok(e[0]?.grammarName === 'js', `language from the info string (${e[0]?.grammarName})`)
    ok(e[0]?.content === 'const a = `hi`\nconst b = 2', `the code exactly as typed, backticks kept (${JSON.stringify(e[0]?.content)})`)
    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`)
    await p.close()
  }

  console.log('\n2 · text around the fence → text / code / text, stacked\n')
  {
    const { p } = await fresh()
    await edit(p)
    await typeLines(p, ['Intro line', '```python', 'print(1)', '```', 'After line'])
    await commit(p)
    const e = await els(p)
    ok(e.map((x) => x.type).join(',') === 'text,code,text', `three parts in order (${e.map((x) => x.type).join(',')})`)
    ok(e[0]?.id === 'tx' && /Intro line/.test(e[0]?.html ?? '') && !/```/.test(e[0]?.html ?? ''), 'the first part keeps the box (id) and holds the text before')
    ok(e[1]?.content === 'print(1)' && e[1]?.grammarName === 'py' && e[1]?.id !== 'tx', `the code part: content, language python→py (${e[1]?.grammarName})`)
    ok(/After line/.test(e[2]?.html ?? ''), 'the last part holds the text after')
    ok(e[1]?.morphId === undefined && e[2]?.morphId === undefined, 'new parts do not copy the morph key (unique per slide)')
    ok(e.length === 3 && e[0].y < e[1].y && e[1].y < e[2].y && e.every((x) => x.x === 200 && x.w === 880), `stacked top to bottom in the box's column (y ${e.map((x) => x.y).join(' < ')})`)
    ok(e.length === 3 && e[0].y === 150 && e[1].y >= e[0].y + e[0].h - 2 && e[2].y >= e[1].y + e[1].h - 2, 'starting at the box top, without overlapping')
    await p.close()
  }

  console.log('\n3 · an unclosed fence stays text\n')
  {
    const { p } = await fresh()
    await edit(p)
    await typeLines(p, ['```', 'not closed'])
    await commit(p)
    const e = await els(p)
    ok(e.length === 1 && e[0].type === 'text' && /not closed/.test(e[0].html), 'still one text box')
    await p.close()
  }

  console.log('\n4 · typing ``` on entering a box replaces, it does not wrap\n')
  {
    const { p } = await fresh('Old text')
    await edit(p) // the whole box is selected on entry
    await p.keyboard.type('`x`', { delay: 5 })
    await commit(p)
    const e = await els(p)
    ok(!/Old text/.test(e[0]?.html ?? '') && !/<code>Old text/.test(e[0]?.html ?? ''), `the old text was replaced, not wrapped (${e[0]?.html})`)
    await p.close()
  }

  console.log('\n5 · select lines, press ` → each line wrapped in <code>; again → unwrapped\n')
  {
    const { p } = await fresh()
    await edit(p)
    await typeLines(p, ['alpha one', 'beta two'])
    await p.keyboard.press('Meta+a')
    await p.keyboard.press('`')
    await commit(p)
    let e = await els(p)
    const codes = (e[0]?.html.match(/<code>/g) ?? []).length
    ok(e[0]?.type === 'text' && codes === 2, `two lines, two <code> runs (${e[0]?.html})`)
    ok(/<code>alpha one<\/code>/.test(e[0]?.html) && /<code>beta two<\/code>/.test(e[0]?.html), 'each line wrapped whole, text unchanged')
    await edit(p)
    await p.keyboard.press('Meta+a')
    await p.keyboard.press('`')
    await commit(p)
    e = await els(p)
    ok(!/<code>/.test(e[0]?.html) && /alpha one/.test(e[0]?.html) && /beta two/.test(e[0]?.html), `pressed again on code: unwrapped (${e[0]?.html})`)
    await p.close()
  }

  console.log('\n6 · pasted fences\n')
  {
    const { p } = await fresh()
    await edit(p)
    await p.evaluate(() => {
      const dt = new DataTransfer()
      dt.setData('text/plain', '```ts\nlet n: number = `x`.length\n```')
      document.querySelector('.ed-stage-scale .bento-editing .bento-text-inner').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    await commit(p)
    let e = await els(p)
    ok(e.length === 1 && e[0].type === 'code' && e[0].grammarName === 'ts' && e[0].content === 'let n: number = `x`.length',
      `pasted into a box being edited → code on commit (${JSON.stringify(e[0]?.content)})`)
    await p.locator('.ed-scroll').click({ position: { x: 8, y: 8 } })
    await p.evaluate(() => {
      const dt = new DataTransfer()
      dt.setData('text/plain', 'Steps\n```bash\nnpm ci\nnpm test\n```')
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    await p.waitForTimeout(300)
    e = await els(p)
    const added = e.slice(1)
    ok(added.map((x) => x.type).join(',') === 'text,code' && added[1]?.grammarName === 'sh' && added[1]?.content === 'npm ci\nnpm test',
      `pasted onto the canvas → a text box and a Code element (${added.map((x) => x.type).join(',')}, ${added[1]?.grammarName})`)
    await p.close()
  }
} finally { await browser.close() }

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
