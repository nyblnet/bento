// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Real mouse/keyboard input against the packaged speaker popup. Resizing and
// hiding chrome must give notes usable space without changing the deck/show.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
let failures = 0
function ok(cond, msg) {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`)
  if (!cond) failures++
}
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
const errors = []
try {
  for (const [width, height] of [[1280, 720], [1200, 900]]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const p = await ctx.newPage()
    p.on('pageerror', (e) => errors.push(e.message))
    await ctx.route(/^https?:/, (route) => route.abort())
    await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
    await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale'))
    await p.evaluate(({ width, height }) => {
      const doc = JSON.parse(JSON.stringify(window.bento.doc))
      doc.size = { width, height }
      doc.slides = [0, 1, 2].map((n) => ({
        id: `slide-${n}`, background: '#fff', elements: [
          { id: `title-${n}`, type: 'text', x: 80, y: 80, w: 500, h: 80, rotation: 0, opacity: 1,
            html: `Slide ${n + 1}`, fontSize: 40, color: '#1e2a3a', align: 'left' },
        ],
        notes: Array.from({ length: 12 }, (_, i) => `Point ${i + 1}: leave enough room for the speaker to read these notes at a glance.`).join(' '),
      }))
      window.bento.loadDoc(JSON.stringify(doc))
    }, { width, height })
    const original = await p.evaluate(() => JSON.stringify(window.bento.doc))
    const popup = ctx.waitForEvent('page')
    await p.locator('.ed-present-pill .ed-pill-caret').click()
    await p.getByText('Open speaker view', { exact: true }).click()
    const sp = await popup
    sp.on('pageerror', (e) => errors.push(e.message))
    const start = async () => {
      await p.locator('.ed-present-pill .ed-pill-caret').click()
      await p.getByText('Present in this tab', { exact: true }).click()
      await sp.waitForSelector('.sv-view summary')
    }
    await start()
    await sp.setViewportSize({ width: 1200, height: 800 })
    await sp.waitForFunction(() => document.querySelector('.sv-nextbox .sv-frame')?.getBoundingClientRect().height > 0)
    const box = (selector) => sp.locator(selector).boundingBox()
    const metrics = () => sp.locator('.sv-notes').evaluate((el) => ({
      w: el.clientWidth, h: el.clientHeight, scroll: el.scrollHeight,
    }))
    const drag = async (selector, dx, dy) => {
      const b = await box(selector)
      await sp.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
      await sp.mouse.down()
      await sp.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 8 })
      await sp.mouse.up()
    }
    const toggle = async (name, on) => {
      if (!await sp.locator('.sv-view').evaluate((el) => el.open)) await sp.locator('.sv-view summary').click()
      await sp.locator(`.sv-view input[value="${name}"]`).setChecked(on)
    }
    const initial = await metrics()
    ok(initial.scroll > initial.h, `${width}:${height}: the fixture starts with overflowing notes`)
    const count = await sp.locator('.sv-count').textContent()
    ok((await box('.sv-nextbox .sv-frame')).height > 100, 'Next preview is visible before any layout interaction')
    await drag('.sv-splitter-columns', -250, 0)
    await drag('.sv-splitter-rows', 0, -100)
    const resized = await metrics()
    ok(resized.w > initial.w + 200 && resized.h > initial.h + 80, 'both mouse drags increase the notes area')
    await sp.locator('.sv-splitter-columns').focus()
    await sp.keyboard.press('ArrowLeft')
    ok((await metrics()).w > resized.w + 10, 'keyboard splitter resizing changes rendered geometry')
    await sp.locator('.sv-splitter-rows').focus()
    await sp.keyboard.press('ArrowUp')
    ok(await sp.locator('.sv-count').textContent() === count, 'splitter keys do not advance the presentation')
    await sp.keyboard.press('b')
    ok(await sp.locator('.sv-btn[data-nav="black"]').evaluate((el) => el.classList.contains('active')), 'presenter shortcuts still work with a focused splitter')
    await sp.keyboard.press('b')
    const split = await metrics()
    await toggle('next', false)
    ok(await sp.locator('.sv-splitter-rows').isHidden() && (await metrics()).h > split.h + 40, 'hiding Next reclaims its space and hides its splitter')
    await toggle('current', false)
    await toggle('rail', false)
    const notesOnly = await metrics()
    ok(notesOnly.w > 1100 && notesOnly.h > 650 && notesOnly.scroll <= notesOnly.h, 'notes-only view shows the full fixture without scrolling')
    if (process.env.SPEAKER_SCREENSHOTS) await sp.screenshot({ path: `${process.env.SPEAKER_SCREENSHOTS}/notes-only-${width}.png` })
    // Native checkbox keyboard interaction belongs to View, not the show.
    await sp.locator('.sv-view input[value="rail"]').focus()
    await sp.keyboard.press('Space')
    ok(await sp.locator('.sv-rail').isVisible() && await sp.locator('.sv-count').textContent() === count, 'Space toggles a View checkbox without navigating')
    await toggle('current', true)
    await toggle('next', true)
    const restored = await metrics()
    ok(Math.abs(restored.w - split.w) < 2 && Math.abs(restored.h - split.h) < 2, 'restoring panes preserves the chosen proportions')
    await sp.keyboard.press('Escape')
    ok(!await sp.locator('.sv-view').evaluate((el) => el.open), 'Escape closes View')
    if (process.env.SPEAKER_SCREENSHOTS) await sp.screenshot({ path: `${process.env.SPEAKER_SCREENSHOTS}/resized-${width}.png` })

    const nextBefore = await box('.sv-nextbox .sv-frame')
    await toggle('notes', false)
    ok(await sp.locator('.sv-notes-wrap').isHidden() && await sp.locator('.sv-splitter-rows').isHidden()
      && (await box('.sv-nextbox .sv-frame')).height > nextBefore.height + 40,
    'hiding notes gives the next preview more space and hides its divider')
    if (process.env.SPEAKER_SCREENSHOTS) await sp.screenshot({ path: `${process.env.SPEAKER_SCREENSHOTS}/without-notes-${width}.png` })
    await toggle('next', false)
    ok(await sp.locator('.sv-side').isHidden() && await sp.locator('.sv-splitter-columns').isHidden()
      && (await box('.sv-current')).width > 1100, 'hiding notes and Next gives the current preview the full width')
    await toggle('current', false)
    ok(await sp.locator('.sv-view summary').isVisible(), 'View stays available with all content panes hidden')
    await toggle('next', true)
    ok((await box('.sv-next-wrap')).width > 1100, 'the next preview can fill the content area on its own')
    await toggle('current', true)
    await toggle('notes', true)
    const withNotes = await metrics()
    ok(Math.abs(withNotes.w - split.w) < 2 && Math.abs(withNotes.h - split.h) < 2,
      'restoring notes and previews recovers the chosen proportions')
    await sp.keyboard.press('Escape')

    for (const [vw, vh] of [[1600, 900], [400, 700], [900, 400], [700, 600]]) {
      await sp.setViewportSize({ width: vw, height: vh })
      await sp.waitForFunction(() => {
        const notes = document.querySelector('.sv-notes')
        const pane = document.querySelector('.sv-notes-wrap')
        const side = document.querySelector('.sv-side')
        return notes.clientWidth >= 120 && pane.clientHeight >= Math.min(80, side.clientHeight * 0.3)
      })
      for (const selector of ['.sv-splitter-columns', '.sv-splitter-rows']) {
        await sp.locator(selector).focus()
        await sp.keyboard.press('Home')
        await sp.keyboard.press('End')
      }
      const bounds = await sp.evaluate((docWidth) => {
        const rect = (s) => document.querySelector(s).getBoundingClientRect()
        const notes = rect('.sv-notes'), rail = rect('.sv-rail')
        return notes.width > 0 && notes.height > 0 && notes.right <= innerWidth + 1 && notes.bottom <= rail.top + 1
          && ['.sv-current .sv-frame', '.sv-nextbox .sv-frame'].every((s) => {
            const b = rect(s), pane = rect(s.startsWith('.sv-current') ? '.sv-current' : '.sv-nextbox')
            const text = document.querySelector(`${s} [data-el-id]`).getBoundingClientRect()
            return b.width > 0 && b.bottom <= pane.bottom + 1 && b.right <= pane.right + 1
              && Math.abs(text.width - 500 * b.width / docWidth) < 1
          })
      }, width)
      ok(bounds, `previews fit and notes stay usable at ${vw}×${vh}, even at splitter limits`)
    }
    await sp.locator('.sv-btn[data-nav="next"]').click()
    ok((await sp.locator('.sv-count').textContent()).startsWith('2 /'), 'normal slide navigation still works')
    ok(await p.evaluate(() => JSON.stringify(window.bento.doc)) === original, 'layout choices leave the document byte-identical')

    await toggle('next', false)
    await toggle('notes', false)
    await p.keyboard.press('Escape')
    await sp.waitForSelector('.sv-idle')
    await start()
    ok(await sp.locator('.sv-next-wrap').isHidden() && await sp.locator('.sv-notes-wrap').isHidden()
      && await sp.locator('.sv-side').isHidden(), 'visibility choices, including hidden notes, survive restarting a show')
    await toggle('next', true)
    await toggle('notes', true)
    await ctx.close()
  }
  ok(errors.length === 0, `no page errors: ${errors.join('; ')}`)
} finally { await browser.close() }
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
