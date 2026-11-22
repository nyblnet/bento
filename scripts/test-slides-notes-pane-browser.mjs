// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Speaker notes in a pane under the canvas, in the packaged editor, with real input.
//
//   npm run build:single --prefix slides && node scripts/test-slides-notes-pane-browser.mjs
//
// WHAT THIS PROVES:
//   1. the notes are on screen while an element is selected — they used to be
//      reachable only with nothing selected — and they are no longer in the
//      inspector (one home);
//   2. the pane follows the current slide;
//   3. typing writes the slide's notes, and one undo takes the whole burst back;
//   4. a slide switch while the field holds the caret does not carry the text
//      onto the next slide, and the pane catches up once the caret leaves;
//   5. folding the pane holds across a reload;
//   0. with no saved choice the pane starts FOLDED, at every window size, and
//      folded it takes no height at all: the canvas gets it. ONE control shows
//      and hides it and never moves: a round toggle (a real button,
//      aria-expanded, aria-controls) at the head of the bottom-end cluster,
//      on the Slideshow and zoom pills' line and at their height, on top at
//      its own centre, 44px to a finger. A dot on it says the current slide
//      has notes (and so does its description). The row stays one row inside
//      the canvas down to a 320px phone, where Slideshow drops its word and
//      keeps its name. Clicking the toggle opens the pane at the saved
//      height and folds it again; keyboard activation puts the caret in the
//      notes; a press on it leaves the selection alone; the fold animates,
//      except under reduced motion;
//   6. the pane meets both side panels, edge to edge; its text box keeps THE
//      FIELD's look and has no resize corner of its own; the PANE resizes from
//      its top edge (the height holds across a reload, a double-click resets
//      it), and the side panels' chevron, laid on its side, folds it.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.route(/^https?:/, (r) => r.abort())
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale [data-el-id]'))
  await p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    const box = { id: 'box', type: 'shape', shape: 'rect', x: 200, y: 200, w: 300, h: 200, rotation: 0, opacity: 1, fill: '#5E7699' }
    d.slides = [
      { id: 's1', background: '#ffffff', notes: 'First slide notes', elements: [box] },
      { id: 's2', background: '#ffffff', notes: 'Second slide notes', elements: [] },
    ]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(400)
  // 0. Folded by default; the toggle in the bottom-end cluster.
  const geom = (pg) => pg.evaluate(() => {
    const r = (s) => document.querySelector(s)?.getBoundingClientRect()
    const btn = document.querySelector('.ed-notes-btn'), t = r('.ed-notes-btn'), row = document.querySelector('.ed-corner-br')
    const hit = document.elementsFromPoint(t.left + t.width / 2, t.top + t.height / 2)[0]
    const clash = ['.ed-present-pill', '.ed-zoombar'].map((s) => [s, r(s)]).filter(([, q]) => q && t.left < q.right && q.left < t.right && t.top < q.bottom && q.top < t.bottom).map(([s]) => s)
    return { pane: r('.ed-notespane').height, canvas: r('.ed-centre > .ed-canvas-wrap').height, centre: r('.ed-centre'), wrap: r('.ed-canvas-wrap'), row: r('.ed-corner-br'),
      btn: t, pill: r('.ed-present-pill'), zoom: r('.ed-zoombar'), onTop: btn.contains(hit), clash, first: row.firstElementChild === btn,
      shown: getComputedStyle(btn).visibility === 'visible', expanded: btn.getAttribute('aria-expanded'), tag: btn.tagName, name: btn.getAttribute('aria-label'),
      controls: !!btn.getAttribute('aria-controls') && btn.getAttribute('aria-controls') === document.querySelector('.ed-notespane').id,
      // the dot is a pseudo-element: read whether it is DRAWN, and what the description says
      dot: getComputedStyle(btn, '::after').content !== 'none', says: document.getElementById(btn.getAttribute('aria-describedby'))?.textContent, title: btn.title,
      tight: row.classList.contains('ed-corner-tight'), word: r('.ed-pill-main > span').width, showName: document.querySelector('.ed-pill-main').textContent }
  })
  const fresh = async (w, h) => {
    const c = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 700, isMobile: w < 700 })
    await c.route(/^https?:/, (r) => r.abort())
    await c.routeWebSocket(/.*/, (ws) => ws.close())
    const q = await c.newPage()
    q.on('pageerror', (e) => errors.push(e.message))
    await q.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
    await q.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-notespane')); await q.waitForTimeout(500)
    return [c, q]
  }
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const [c, q] = await fresh(w, h)
    const g = await geom(q)
    ok(g.pane === 0, `${w}px: with no saved choice the pane starts folded, at zero height (${g.pane}px)`)
    ok(Math.abs(g.canvas - g.centre.height) < 1, `${w}px: and the canvas takes all of it (${g.canvas} of ${g.centre.height}px)`)
    ok(g.shown && g.onTop && g.tag === 'BUTTON' && g.name === 'Speaker notes' && g.expanded === 'false' && g.controls, `${w}px: a "Speaker notes" toggle button is on top at its own centre, and names the pane it controls (${g.name}, expanded=${g.expanded}, on top ${g.onTop})`)
    ok(g.first && Math.abs(g.btn.top - g.pill.top) < 1 && Math.abs(g.btn.bottom - g.zoom.bottom) < 1 && Math.abs(g.pill.left - g.btn.right - 10) < 1,
      `${w}px: at the head of the bottom-end cluster, on the pills' line, 10px before Slideshow (${Math.round(g.pill.left - g.btn.right)}px; tops ${g.btn.top} / ${g.pill.top})`)
    ok(g.wrap.right - g.row.right < 40 && g.wrap.bottom - g.row.bottom < 40, `${w}px: the cluster is the canvas's bottom-end corner (${Math.round(g.wrap.right - g.row.right)}px in, ${Math.round(g.wrap.bottom - g.row.bottom)}px up)`)
    ok(!g.clash.length && g.row.left >= g.wrap.left && g.row.right <= g.wrap.right, `${w}px: clear of the Slideshow and zoom pills, the whole row inside the canvas (${g.clash.join(', ') || 'clear'}; row ${Math.round(g.row.left)}–${Math.round(g.row.right)} in ${Math.round(g.wrap.left)}–${Math.round(g.wrap.right)})`)
    ok(!g.tight && g.word > 20, `${w}px: with room for the row, Slideshow keeps its word (${g.word.toFixed(1)}px)`)
    const sizes = [g.btn.height, g.pill.height, g.zoom.height]
    ok(sizes.every((x) => Math.abs(x - 32) < 0.5) && Math.abs(g.btn.width - 32) < 0.5, `${w}px: the toggle is a circle as tall as the Slideshow and zoom pills (${g.btn.width}×${sizes.join(' / ')}px)`)
    ok(g.dot && g.says === 'This slide has notes' && g.title === 'Show speaker notes · This slide has notes', `${w}px: its dot says the slide has notes, and so do its description and its tooltip (dot ${g.dot}, "${g.says}", "${g.title}")`)
    if (w < 700) {
      // a 44px tap area round the 32px circle, which takes no tap from the Slideshow pill beside it
      const taps = await q.evaluate(() => {
        const t = document.querySelector('.ed-notes-btn'), r = t.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2
        const pill = document.querySelector('.ed-present-pill'), pr = pill.getBoundingClientRect()
        const top = (x, y) => document.elementsFromPoint(x, y)[0]
        return { above: t.contains(top(x, r.top - 5.5)), below: t.contains(top(x, r.bottom + 5.5)), before: t.contains(top(r.left - 5.5, y)), after: t.contains(top(r.right + 5.5, y)),
          span: Math.round(r.height + 12), beyond: t.contains(top(x, r.top - 7.5)) || t.contains(top(r.left - 7.5, y)),
          // the pill's own start edge at mid-height, and just inside its rounded corners
          pillEdge: pill.contains(top(pr.left + 1, y)) && pill.contains(top(pr.left + 8, pr.top + 3)) && pill.contains(top(pr.left + 8, pr.bottom - 3)) }
      })
      ok(taps.above && taps.below && taps.before && taps.after && !taps.beyond, `${w}px: a ${taps.span}px tap area (5.5px beyond each edge of the circle still hits it, 7.5px does not)`)
      ok(taps.pillEdge, `${w}px: and the Slideshow pill beside it keeps its own edge`)
    }
    await q.locator('.ed-notes-btn').click(); await q.waitForTimeout(400)
    const o = await geom(q)
    const ah = (await q.locator('.ed-notespane-text').boundingBox())?.height
    ok(Math.abs(ah - 84) < 2 && o.pane > 84 && Math.abs(g.canvas - o.canvas - o.pane) < 1, `${w}px: the toggle opens the pane at the saved height (text ${ah}px, pane ${o.pane}px, canvas ${g.canvas} → ${o.canvas})`)
    ok(o.shown && o.onTop && o.expanded === 'true' && Math.abs(o.btn.left - g.btn.left) < 0.5 && Math.abs((o.wrap.bottom - o.btn.bottom) - (g.wrap.bottom - g.btn.bottom)) < 0.5,
      `${w}px: and stays where it was in its corner, now pressed (expanded=${o.expanded}, x ${g.btn.left} → ${o.btn.left})`)
    ok(!o.dot && o.title === 'Hide speaker notes · This slide has notes', `${w}px: open, the notes are on screen and the dot steps aside ("${o.title}")`)
    await q.reload(); await q.waitForFunction(() => document.querySelector('.ed-notespane')); await q.waitForTimeout(300)
    ok((await geom(q)).pane > 84, `${w}px: open holds across a reload`)
    await q.locator('.ed-notes-btn').click(); await q.waitForTimeout(400)
    const f = await geom(q)
    ok(f.pane === 0 && f.expanded === 'false' && f.onTop, `${w}px: the same toggle folds it again (pane ${f.pane}px, expanded=${f.expanded})`)
    await c.close()
  }
  {
    // the narrowest phone: the row is still one row inside the canvas, because
    // Slideshow gives up its word (measured, so it follows the locale)
    const [c, q] = await fresh(320, 568)
    const g = await geom(q)
    ok(g.row.left >= g.wrap.left && g.row.right <= g.wrap.right && !g.clash.length && g.onTop,
      `320px: the whole row fits inside the canvas (row ${Math.round(g.row.left)}–${Math.round(g.row.right)} in ${Math.round(g.wrap.left)}–${Math.round(g.wrap.right)})`)
    ok(g.tight && g.word <= 1 && g.showName === 'Slideshow', `320px: Slideshow drops its visible word and keeps its name (${g.word}px wide, "${g.showName}")`)
    ok(Math.abs(g.btn.top - g.pill.top) < 1 && Math.abs(g.btn.height - g.pill.height) < 0.5, `320px: on one line (tops ${g.btn.top} / ${g.pill.top})`)
    await q.setViewportSize({ width: 390, height: 844 }); await q.waitForTimeout(300)
    const back = await geom(q)
    ok(!back.tight && back.word > 20, `and at 390px the word is back (${back.word.toFixed(1)}px)`)
    await c.close()
  }
  {
    // the fold animates mid-way; reduced motion snaps; the keyboard lands in the notes
    const [c, q] = await fresh(1440, 900)
    const mid = await q.evaluate(() => new Promise((res) => {
      document.querySelector('.ed-notes-btn').click()
      setTimeout(() => res(document.querySelector('.ed-notespane').getBoundingClientRect().height), 80)
    }))
    ok(mid > 2 && mid < 120, `the fold animates (pane ${mid.toFixed(1)}px at 80ms)`)
    await q.waitForTimeout(400)
    await q.locator('.ed-notespane-head').click(); await q.waitForTimeout(400)
    ok(await q.evaluate(() => document.querySelector('.ed-notespane').getBoundingClientRect().height) === 0, 'the header folds it back to nothing')
    await q.emulateMedia({ reducedMotion: 'reduce' })
    const snap = await q.evaluate(() => new Promise((res) => {
      document.querySelector('.ed-notes-btn').click()
      requestAnimationFrame(() => res(document.querySelector('.ed-notespane').getBoundingClientRect().height))
    }))
    ok(snap > 100, `under reduced motion it opens at once (${snap}px on the next frame)`)
    await q.locator('.ed-notes-toggle').click(); await q.waitForTimeout(100)
    // reached by Tab, in the row's own order: the toggle, then Slideshow
    await q.locator('.ed-pill-main').focus(); await q.keyboard.press('Shift+Tab')
    const ring = await q.evaluate(() => { const b = document.querySelector('.ed-notes-btn'), cs = getComputedStyle(b); return { on: document.activeElement === b && b.matches(':focus-visible'), w: cs.outlineWidth, style: cs.outlineStyle } })
    ok(ring.on && ring.style === 'solid' && parseFloat(ring.w) >= 2, `Shift+Tab from Slideshow lands on the toggle, with a focus ring (${ring.w} ${ring.style})`)
    await q.keyboard.press('Enter'); await q.waitForTimeout(100)
    ok(await q.evaluate(() => document.activeElement?.classList.contains('ed-notespane-text')), 'Enter on the toggle opens the notes with the caret in them')
    await q.locator('.ed-pill-main').focus(); await q.keyboard.press('Shift+Tab'); await q.keyboard.press('Enter'); await q.waitForTimeout(100)
    ok(await q.evaluate(() => document.activeElement?.classList.contains('ed-notes-btn') && document.querySelector('.ed-notespane').classList.contains('closed')), 'Enter on it again folds them, and the focus stays on the toggle')
    await c.close()
  }
  await p.locator('.ed-notes-btn').click(); await p.waitForTimeout(400)

  const notes = (i) => p.evaluate((i) => window.bento.doc.slides[i].notes, i)
  const area = p.locator('.ed-notespane-text')
  const thumb = (i) => p.locator('.ed-sidebar .ed-thumb').nth(i)

  // 1. On screen with an element selected; not in the inspector.
  const b = await p.locator('.ed-stage-scale [data-el-id="box"]').boundingBox()
  await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await p.waitForTimeout(250)
  ok(await p.evaluate(() => window.bento.selection.length) === 1, 'an element is selected')
  ok(await area.isVisible() && await area.inputValue() === 'First slide notes', 'its slide\'s notes are on screen')
  await p.keyboard.press('Escape'); await p.waitForTimeout(250)
  ok(await p.locator('.ed-props textarea').count() === 0, 'and the inspector no longer carries a notes field')
  // the toggle floats over the canvas: a press on it is not aimed at the slide
  await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await p.waitForTimeout(250)
  await p.locator('.ed-notes-btn').click(); await p.waitForTimeout(350)
  ok(await p.evaluate(() => window.bento.selection.length) === 1 && !(await area.isVisible()), 'folding from the toggle leaves the selection alone')
  await p.locator('.ed-notes-btn').click(); await p.waitForTimeout(350)
  ok(await p.evaluate(() => window.bento.selection.length) === 1 && await area.isVisible(), 'and so does opening')
  await p.keyboard.press('Escape'); await p.waitForTimeout(250)

  // 2. Follows the slide.
  await thumb(1).click(); await p.waitForTimeout(250)
  ok(await area.inputValue() === 'Second slide notes', 'the pane follows the current slide')

  // 3. Typing, one undo.
  await area.click(); await p.keyboard.press('End'); await p.keyboard.type(' — added')
  await p.locator('.ed-stage').click({ position: { x: 5, y: 5 } }); await p.waitForTimeout(250)
  ok(await notes(1) === 'Second slide notes — added', 'typing writes the slide\'s notes')
  await p.keyboard.press(`${MOD}+z`); await p.waitForTimeout(250)
  ok(await notes(1) === 'Second slide notes', 'one undo takes the whole burst back')
  ok(await area.inputValue() === 'Second slide notes', 'and the pane shows it')

  // 4. Switching slides with the caret in the field.
  await area.click(); await p.keyboard.press('End'); await p.keyboard.type(' X')
  await thumb(0).click(); await p.waitForTimeout(300)
  ok(await notes(1) === 'Second slide notes X', 'the text stays on the slide it was typed into')
  ok(await notes(0) === 'First slide notes', 'and does not land on the next one')
  ok(await area.inputValue() === 'First slide notes', 'once the caret leaves, the pane shows the new slide')

  // 6. Edges, the field, the grip.
  const geo = await p.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect()
    const pane = r('.ed-notespane'), side = r('.ed-sidebar'), props = r('.ed-props'), a = document.querySelector('.ed-notespane-text'), cs = getComputedStyle(a)
    return { left: pane.left - side.right, right: props.left - pane.right, resize: cs.resize, border: cs.borderTopWidth, bg: cs.backgroundColor }
  })
  ok(Math.abs(geo.left) < 1 && Math.abs(geo.right) < 1, `the pane meets both side panels (gaps ${geo.left.toFixed(1)} / ${geo.right.toFixed(1)}px)`)
  ok(geo.resize === 'none' && geo.border === '1px' && geo.bg !== 'rgba(0, 0, 0, 0)', `the text box is a field, with no resize corner (${geo.resize}, ${geo.border}, ${geo.bg})`)
  const h0 = (await area.boundingBox()).height
  const grip = await p.locator('.ed-notes-grip').boundingBox()
  await p.mouse.move(grip.x + 40, grip.y + grip.height / 2); await p.mouse.down()
  await p.mouse.move(grip.x + 40, grip.y - 80, { steps: 8 }); await p.mouse.up(); await p.waitForTimeout(150)
  const h1 = (await area.boundingBox()).height
  ok(h1 > h0 + 60, `dragging the pane's top edge up makes the notes taller (${h0} → ${h1}px)`)
  await p.reload()
  await p.waitForFunction(() => document.querySelector('.ed-notespane-text'))
  const hr = (await p.locator('.ed-notespane-text').boundingBox()).height
  ok(Math.abs(hr - h1) < 2, `the height holds across a reload (${h1} → ${hr})`)
  await p.locator('.ed-notes-grip').dblclick({ position: { x: 20, y: 3 } }); await p.waitForTimeout(150)
  ok(Math.abs((await p.locator('.ed-notespane-text').boundingBox()).height - h0) < 2, 'a double-click on the edge resets it')
  await p.locator('.ed-notes-toggle').click(); await p.waitForTimeout(350) // the fold animates (.18s)
  ok(!(await p.locator('.ed-notespane-text').isVisible()), 'the chevron folds the pane')
  ok(!(await p.locator('.ed-notes-toggle').isVisible()), 'and goes with it, folded (the toggle reopens)')
  // the dot follows the slide in front of you, and the typing (the reload
  // above brought the starter deck back: load three slides of our own)
  await p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = [{ id: 'n1', background: '#ffffff', notes: 'Has notes', elements: [] }, { id: 'n2', background: '#ffffff', notes: '  ', elements: [] }, { id: 'n3', background: '#ffffff', elements: [] }]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await p.waitForTimeout(300)
  const dot = () => p.evaluate(() => { const b = document.querySelector('.ed-notes-btn'); return { drawn: getComputedStyle(b, '::after').content !== 'none', says: document.getElementById(b.getAttribute('aria-describedby')).textContent, title: b.title } })
  const d1 = await dot()
  ok(d1.drawn && d1.says === 'This slide has notes', `folded on a slide with notes, the toggle carries the dot ("${d1.says}")`)
  await thumb(1).click(); await p.waitForTimeout(250)
  const d2 = await dot()
  ok(!d2.drawn && d2.says === '' && d2.title === 'Show speaker notes', `on a slide whose notes are blank there is no dot, and nothing claims one ("${d2.title}")`)
  await thumb(2).click(); await p.waitForTimeout(250)
  ok(!(await dot()).drawn, 'nor on a slide that has no notes field at all')
  await thumb(0).click(); await p.waitForTimeout(250)
  ok((await dot()).drawn, 'back on the first slide the dot is back')
  await thumb(2).click(); await p.waitForTimeout(250)
  await p.locator('.ed-notes-btn').click(); await p.waitForTimeout(350) // the fold animates (.18s)
  ok(await p.locator('.ed-notespane-text').isVisible(), 'and the toggle opens it again')
  await p.locator('.ed-notespane-text').click(); await p.keyboard.type('now it has')
  await p.locator('.ed-notes-btn').click(); await p.waitForTimeout(350)
  const d3 = await dot()
  ok(d3.drawn && d3.says === 'This slide has notes' && await notes(2) === 'now it has', `typing notes into it earns the dot once folded ("${d3.title}")`)
  await p.locator('.ed-notes-btn').click(); await p.waitForTimeout(350)
  await thumb(0).click(); await p.waitForTimeout(250)
  const area2 = p.locator('.ed-notespane-text')

  // 5. Fold, reload.
  await p.locator('.ed-notespane-head').click(); await p.waitForTimeout(350)
  ok(!(await area2.isVisible()), 'the header folds the pane')
  await p.reload()
  await p.waitForFunction(() => document.querySelector('.ed-notespane'))
  ok(!(await p.locator('.ed-notespane-text').isVisible()), 'folded holds across a reload')
  ok(await p.evaluate(() => document.querySelector('.ed-notespane').getBoundingClientRect().height) === 0, 'at zero height')
  ok(await p.locator('.ed-notespane-head').getAttribute('aria-expanded') === 'false', 'and says so to a screen reader')

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
