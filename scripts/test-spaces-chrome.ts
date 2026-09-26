#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/spaces CHROME — the menus behave like the kernel's menus, because they
// are the kernel's menus.
//
//   node scripts/test-spaces-chrome.ts      (after `npm run build:single` in spaces/)
//
// WHY THIS EXISTS. Spaces grew its own dropdown and nine anchored popovers,
// each with its own dismissal. What they did NOT do was invisible in a
// screenshot and measured on the built shell:
//
//   · no menu had arrow keys;
//   · every popover's `mousedown` away-listener removed itself only when it
//     fired, so one closed by Escape stayed on the document and closed the NEXT
//     overlay on its first press — Escape a block menu, ⌘K, click inside the
//     search card, and the search closed;
//   · the global shortcuts ran BEFORE the "an overlay is open" test, and the
//     modal dialogs never set it: `[` collapsed the page list behind About,
//     `?` stacked a second modal on top of it;
//   · on a phone the ⋯ menu was 950px tall in an 844px screen, and its last
//     three rows — the only ways to save a copy or export there — could not
//     be reached; at 1440×900 the Insert menu's last row was cut off.
//
// Every menu is now `createMenu` (kernel/src/ui/menu.ts) through
// spaces/src/menus.ts. The kernel's own rig proves the primitive; THIS rig
// proves spaces actually uses it — with TRUSTED input (CDP), on the built
// shell, counting the document's listeners with DOMDebugger rather than
// trusting a comment that says they are removed.
//
// The source half always runs. The browser half needs Chrome and the built
// shell; it self-skips outside CI and FAILS inside it.

import { existsSync, readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let checks = 0
let failures = 0
const ok = (cond: unknown, msg: string): void => {
  checks++
  if (cond) console.log(`  ok    ${msg}`)
  else { failures++; console.log(`  FAIL  ${msg}`) }
}

// ————— source half —————————————————————————————————————————————————————————
console.log('\nthe source\n')
const SRC = join(root, 'spaces/src')
const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'))
const read = (f: string) => readFileSync(join(SRC, f), 'utf8')
const editor = read('editor.ts')
const css = readFileSync(join(SRC, 'styles.css'), 'utf8')

const menuImports = files.filter((f) => /from '\.\.\/\.\.\/kernel\/src\/ui\/menu\.ts'/.test(read(f)))
ok(menuImports.length === 1 && menuImports[0] === 'menus.ts',
  `the kernel menu is imported in ONE place, the adapter (found in: ${menuImports.join(', ') || 'none'})`)
ok(/import \{[^}]*\bbarMenu\b[^}]*\banchoredMenu\b[^}]*\} from '\.\/menus\.ts'/.test(editor),
  'the editor builds its menus through the adapter (barMenu, anchoredMenu)')
ok(!/private dropdown\(/.test(editor) && !/private menuItem\(/.test(editor),
  'spaces\' own dropdown() and menuItem() are gone')
ok(!/sp-ddmenu|\.sp-dd\b|sp-dd-end/.test(css + editor),
  'no .sp-dd / .sp-ddmenu machinery survives in the stylesheet or the editor')
const aways = [...editor.matchAll(/addEventListener\('(mousedown|pointerdown)', away/g)]
ok(aways.length === 1, `exactly ONE away-listener is installed in the editor, in float() (found ${aways.length})`)
const floatBody = editor.slice(editor.indexOf('  private float('), editor.indexOf('\n  }\n', editor.indexOf('  private float(')))
ok(/overlayOff\.push\([\s\S]*removeEventListener\('pointerdown', away, true\)/.test(floatBody),
  'float() registers the away-listener\'s REMOVAL with closeOverlay, so it goes however the popover closes')
const handMenus = files.filter((f) => f !== 'menus.ts').filter((f) => /setAttribute\('role', 'menu'\)/.test(read(f)))
ok(handMenus.length === 0, `no file hand-builds a role=menu popup any more (found in: ${handMenus.join(', ') || 'none'})`)
const onKey = editor.slice(editor.indexOf('  private onKey(e: KeyboardEvent): void {'))
const guardAt = onKey.indexOf(`if (document.querySelector('[aria-modal="true"]')) return`)
const firstShortcut = onKey.indexOf("e.key.toLowerCase() === 'k'")
ok(guardAt > 0 && guardAt < firstShortcut,
  'the editor\'s keymap stands down under a modal BEFORE any global shortcut is read')
const handDialogs = files.filter((f) => /'sp-overlay|setAttribute\('aria-modal'/.test(read(f)))
ok(handDialogs.length === 0, `no file hand-builds a modal overlay any more — every one is createDialog (found in: ${handDialogs.join(', ') || 'none'})`)
ok(/createPanel\(/.test(editor) && !/private makeResizer\(/.test(editor) && !/sp-pane-tab/.test(css),
  'both side panels are the kernel panel; spaces\' own resizer and chevron are gone')

// ————— browser half ————————————————————————————————————————————————————————
console.log('\nthe built shell, driven with trusted input\n')
const CHROME = [process.env.BENTO_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .find((p) => p && existsSync(p)) ?? (spawnSync('which', ['google-chrome']).status === 0 ? 'google-chrome' : undefined)
const SHELL = join(root, 'spaces/dist-single/Bento_Spaces.bento.html')

if (!CHROME || !existsSync(SHELL)) {
  if (process.env.CI) ok(false, `the browser half RAN (Chrome: ${CHROME ?? 'none'}, shell: ${existsSync(SHELL)}) — in CI a skip is a failure`)
  else console.log(`  skip  needs Chrome (BENTO_CHROME) and the built shell (${SHELL})`)
} else {
  await browser(CHROME, readFileSync(SHELL, 'utf8'))
}

async function browser(chrome: string, html: string): Promise<void> {
  const server = createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); r.end(html) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const profile = mkdtempSync(join(tmpdir(), 'bento-spaces-chrome-'))
  const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--hide-scrollbars',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  try {
    const portFile = join(profile, 'DevToolsActivePort')
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100)
    const cdp = readFileSync(portFile, 'utf8').split('\n')[0].trim()
    const t = await (await fetch(`http://127.0.0.1:${cdp}/json/new?about:blank`, { method: 'PUT' })).json() as { webSocketDebuggerUrl: string }
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise<void>((res, rej) => { ws.addEventListener('open', () => res()); ws.addEventListener('error', () => rej(new Error('cdp socket'))) })
    let id = 0
    const pending = new Map<number, (m: any) => void>()
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data))
      // a native confirm()/alert() would freeze every later step; dismiss it
      if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: 1e6 + (++id), method: 'Page.handleJavaScriptDialog', params: { accept: false } }))
      if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id) }
    })
    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
      new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    const js = async <T = any>(expression: string): Promise<T> => {
      const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description ?? 'eval failed')
      return m.result?.result?.value as T
    }
    const click = async (x: number, y: number) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      await sleep(250)
    }
    const key = async (k: string, modifiers = 0, code = k, vk = 0) => {
      const text = k.length === 1 && !(modifiers & 6) ? k : undefined
      await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, modifiers, text, windowsVirtualKeyCode: vk })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers })
      await sleep(150)
    }
    const at = async (expr: string): Promise<{ x: number; y: number } | null> =>
      js(`(() => { const e = ${expr}; if (!e) return null; e.scrollIntoView?.({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    const tap = async (expr: string) => { const p = await at(expr); if (!p) throw new Error('not found: ' + expr); await click(p.x, p.y) }
    const docListeners = async (): Promise<Record<string, number>> => {
      const o = await send('Runtime.evaluate', { expression: 'document' })
      const l = await send('DOMDebugger.getEventListeners', { objectId: o.result.result.objectId })
      const c: Record<string, number> = {}
      for (const x of l.result.listeners) c[x.type] = (c[x.type] ?? 0) + 1
      return c
    }
    const open = async (phone: boolean) => {
      await send('Emulation.setDeviceMetricsOverride', phone
        ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
        : { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
      await send('Emulation.setTouchEmulationEnabled', { enabled: phone, maxTouchPoints: phone ? 5 : 1 })
      await send('Page.navigate', { url: `http://127.0.0.1:${port}/s.html` })
      for (let i = 0; i < 100; i++) { await sleep(100); if (await js('!!(window.bento && window.bento.doc && document.querySelector(".sp-bar"))')) break }
      await js('try { localStorage.clear() } catch {}; document.activeElement?.blur?.(); 1')
      await sleep(400)
    }
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })

    const TRIG = (label: string) => `[...document.querySelectorAll('.sp-bar button')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(label)})`
    const OPEN = `[...document.querySelectorAll('.bkm-open > .bkm-menu')].find(m => m.getBoundingClientRect().height > 0)`
    const FOCUSED = `(document.activeElement?.textContent || '').trim().slice(0, 30)`

    // ——— desktop ———
    await open(false)
    const baseline = await docListeners()
    ok(await js(`document.visibilityState === 'visible' && document.querySelector('meta[name=generator]')?.content === 'bento-spaces'`),
      'the page under test is the spaces shell, visible')

    await tap(TRIG('More'))
    const more = await js<any>(`(() => { const m = ${OPEN}; const t = ${TRIG('More')}; if (!m) return null; const r = m.getBoundingClientRect(); return { exp: t.getAttribute('aria-expanded'), role: m.getAttribute('role'), bottom: r.bottom, vh: innerHeight } })()`)
    ok(more && more.exp === 'true' && more.role === 'menu', `⋯ opens as a menu and says so (aria-expanded ${more?.exp}, role ${more?.role})`)
    await key('ArrowDown', 0, 'ArrowDown')
    const first = await js<string>(FOCUSED)
    await key('ArrowDown', 0, 'ArrowDown')
    const second = await js<string>(FOCUSED)
    ok(first.startsWith('New page') && second.startsWith("Today's journal"), `arrow keys walk the ⋯ rows ("${first}" → "${second}")`)
    await key('Escape', 0, 'Escape')
    const afterEsc = await js<any>(`({ open: !!(${OPEN}), exp: (${TRIG('More')}).getAttribute('aria-expanded'), focus: document.activeElement === (${TRIG('More')}) })`)
    ok(!afterEsc.open && afterEsc.exp === 'false' && afterEsc.focus, `Escape closes ⋯, clears aria-expanded and puts focus back on its trigger (${JSON.stringify(afterEsc)})`)

    await tap(TRIG('More'))
    await tap(`[...document.querySelectorAll('.sp-bar button')].find(b => (b.getAttribute('aria-label') || '').startsWith('Insert'))`)
    const exclusive = await js<number>(`document.querySelectorAll('.bkm-open').length`)
    ok(exclusive === 1, `opening Insert shuts ⋯ — one menu open at a time (${exclusive} open)`)
    const ins = await js<any>(`(() => { const r = (${OPEN}).getBoundingClientRect(); return { bottom: Math.round(r.bottom), vh: innerHeight } })()`)
    ok(ins.bottom <= ins.vh, `the Insert menu fits a 1440×900 window (bottom ${ins.bottom} ≤ ${ins.vh}; it ran to 910 before)`)
    await click(900, 700)
    ok(!(await js<boolean>(`!!(${OPEN})`)), 'a press outside closes the menu')

    // the leak, stated as the user met it
    const grip = `(() => { const n = document.querySelectorAll('.sp-main [data-block-id]')[2]; return [...n.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Block options') })()`
    for (let i = 0; i < 5; i++) {
      const g = await at(`document.querySelectorAll('.sp-main [data-block-id]')[2]`)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g!.x - 200, y: g!.y })
      await sleep(120)
      await tap(grip)
      if (i === 0) {
        const bm = await js<any>(`(() => { const m = ${OPEN}; if (!m) return null; const r = m.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, vh: innerHeight, label: m.getAttribute('aria-label') } })()`)
        ok(bm && bm.label === 'Block options' && bm.top >= 0 && bm.bottom <= bm.vh, `the block menu is a kernel menu, placed inside the window (${JSON.stringify(bm)})`)
        await key('ArrowDown', 0, 'ArrowDown')
        ok((await js<string>(FOCUSED)).startsWith('Turn into'), 'ArrowDown lands on the block menu\'s first row')
      }
      await key('Escape', 0, 'Escape')
    }
    const afterMenus = await docListeners()
    const same = JSON.stringify(Object.entries(afterMenus).sort()) === JSON.stringify(Object.entries(baseline).sort())
    ok(same, `five block menus closed by Escape leave the document's listeners exactly as they were (${JSON.stringify(baseline)} → ${JSON.stringify(afterMenus)})`)
    await js(`document.activeElement?.blur?.(); 1`)
    await key('k', 4, 'KeyK', 75)
    const card = await at(`[...document.querySelectorAll('[role=dialog]')].find(d => d.getBoundingClientRect().height > 0)`)
    ok(!!card, '⌘K opens the search dialog')
    if (card) {
      const c = await js<any>(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].find(d => d.getBoundingClientRect().height > 0); const r = d.getBoundingClientRect(); return { x: r.right - 30, y: r.top + 14 } })()`)
      await click(c.x, c.y)
      ok(await js<boolean>(`!![...document.querySelectorAll('[role=dialog]')].find(d => d.getBoundingClientRect().height > 0)`),
        'a click INSIDE the search dialog, after an Escaped menu, leaves it open (it closed it before)')
      await key('Escape', 0, 'Escape')
    }

    // page ⋯ — an anchored menu
    const row = `document.querySelector('.sp-treelink.sp-here')`
    const rp = await at(row)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rp!.x, y: rp!.y })
    await sleep(150)
    await tap(`document.querySelector('.sp-treelink.sp-here .sp-rowmore')`)
    await key('ArrowDown', 0, 'ArrowDown')
    ok((await js<string>(FOCUSED)).startsWith('Rename'), 'the page ⋯ menu takes the arrow keys')
    await key('Escape', 0, 'Escape')
    ok(await js<boolean>(`!(${OPEN}) && document.activeElement === document.querySelector('.sp-treelink.sp-here .sp-rowmore')`),
      'Escape closes the page menu and returns focus to the ⋯ that opened it')

    // a modal owns the keyboard
    await tap(`document.querySelector('.sp-mark')`)
    const side0 = await js<string>(`document.querySelector('.sp-side').className`)
    await js(`document.activeElement?.blur?.(); 1`)
    await key('[', 0, 'BracketLeft', 219)
    await key('?', 8, 'Slash', 191)
    const underModal = await js<any>(`({ side: document.querySelector('.sp-side').className, modals: document.querySelectorAll('[aria-modal="true"]').length })`)
    ok(underModal.side === side0 && underModal.modals === 1,
      `under About, \`[\` and \`?\` do nothing behind it (page list ${underModal.side === side0 ? 'unchanged' : 'TOGGLED'}, ${underModal.modals} modal open)`)
    // focus is on <body> here (blurred above): Escape must still reach the dialog
    await key('Escape', 0, 'Escape')
    const aboutGone = await js<boolean>(`!document.querySelector('[aria-modal="true"]')`)
    ok(aboutGone, 'Escape closes About with the focus nowhere in it')
    if (!aboutGone) throw new Error('About did not close; the steps after this need the page')

    // WCAG contrast of an element's text against its composited ground
    const CONTRAST = `((el) => { const P = (s) => { const m = s.match(/[\\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 } }
      const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 })
      const L = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b) }
      let bg = { r: 255, g: 255, b: 255, a: 1 }; const chain = []; for (let n = el; n && n.nodeType === 1; n = n.parentElement) chain.push(n)
      for (const n of chain.reverse()) { const c = P(getComputedStyle(n).backgroundColor); if (c.a > 0) bg = over(c, bg) }
      const fg = over(P(getComputedStyle(el).color), bg); const [x, y] = [L(fg), L(bg)].sort((a, b) => b - a); return +((x + 0.05) / (y + 0.05)).toFixed(2) })`

    // About: its links read, and its buttons look like buttons
    await tap(`document.querySelector('.sp-mark')`)
    const about = await js<any>(`(() => { const d = [...document.querySelectorAll('[aria-modal="true"]')].pop(); const a = d.querySelector('.sp-ab-promo a'); const b = [...d.querySelectorAll('.sp-btn:not(.sp-primary)')][0]; return { link: ${CONTRAST}(a), frame: getComputedStyle(b).borderTopColor } })()`)
    ok(about.link >= 4.5, `About's links clear 4.5:1 (${about.link}; 3.23 before)`)
    ok(!/rgba\(0, 0, 0, 0\)/.test(about.frame), `a dialog's secondary button has a visible frame (${about.frame})`)
    await key('Escape', 0, 'Escape')

    // D3: a refusal is a notice the reader sees, not a whisper in the bar
    await tap(TRIG('More'))
    await tap(`[...document.querySelectorAll('.bkm-open .bkm-item')].find(b => b.textContent.startsWith('Make this page an issue'))`)
    await tap(TRIG('More'))
    await tap(`[...document.querySelectorAll('.bkm-open .bkm-item')].find(b => b.textContent.startsWith('Make this page an issue'))`)
    const note = await js<any>(`(() => { const n = document.querySelector('.sp-notice.sp-on'); if (!n) return null; const r = n.getBoundingClientRect(); return { text: n.textContent, role: n.getAttribute('role'), cr: ${CONTRAST}(n), z: +getComputedStyle(n).zIndex, onScreen: r.bottom <= innerHeight && r.top > innerHeight / 2 } })()`)
    ok(note && note.role === 'status' && note.cr >= 4.5 && note.z > 1000 && note.onScreen,
      `a refusal ("Already an issue") arrives as a notice: announced, legible, above dialogs, at the foot of the window (${JSON.stringify(note)})`)
    await js(`window.bento.undo(); 1`)

    // ——— dialogs: the kernel's ———
    const MODAL = `[...document.querySelectorAll('[aria-modal="true"]')].find(d => d.getBoundingClientRect().height > 0)`
    await tap(TRIG('More'))
    await tap(`[...document.querySelectorAll('.bkm-open .bkm-item')].find(b => b.textContent.startsWith('Import Markdown'))`)
    const title = await js<any>(`(() => { const d = ${MODAL}; const h = d && d.querySelector('.bkd-title'); if (!h) return null; const c = getComputedStyle(h); return { text: h.textContent, size: c.fontSize, weight: c.fontWeight, labelled: document.getElementById(d.getAttribute('aria-labelledby') || '') === h } })()`)
    ok(title && title.size === '17px' && title.weight === '650' && title.labelled,
      `a dialog opens on a real title, 17px/650, wired to aria-labelledby (D4) (${JSON.stringify(title)})`)
    let outside = 0
    for (let i = 0; i < 20; i++) {
      await key('Tab', 0, 'Tab', 9)
      if (!(await js<boolean>(`(${MODAL})?.contains(document.activeElement) ?? false`))) outside++
    }
    ok(outside === 0, `Tab never leaves an open dialog (${outside} of 20 presses landed outside; 23 of 25 did before)`)
    const blank = await js<any>(`(() => { const r = (${MODAL}).getBoundingClientRect(); return { x: r.right - 12, y: r.bottom - 8 } })()`)
    await click(blank.x, blank.y)
    // …and with focus nowhere at all: the old handler hung off the backdrop, so
    // Escape worked only while focus was inside the card
    await js(`document.activeElement?.blur?.(); 1`)
    await key('Escape', 0, 'Escape')
    ok(!(await js<boolean>(`!!(${MODAL})`)), 'Escape closes a dialog wherever the focus is (it only worked with focus in the card)')

    await js(`document.activeElement?.blur?.(); 1`)
    await key('?', 8, 'Slash', 191)
    const ring = await js<any>(`(() => { const d = ${MODAL}; const c = getComputedStyle(d); return { outline: c.outlineStyle, focusIn: d.contains(document.activeElement) } })()`)
    ok(ring.outline === 'none', `the shortcut sheet does not ring the whole card when it opens (outline ${ring.outline})`)
    await key('Escape', 0, 'Escape')

    await key('k', 4, 'KeyK', 75)
    await send('Input.insertText', { text: 'page' })
    await sleep(250)
    await key('ArrowDown', 0, 'ArrowDown')
    const srch = await js<any>(`({ sel: [...document.querySelectorAll('.sp-result')].findIndex(r => r.getAttribute('aria-selected') === 'true'), focusInInput: document.activeElement?.tagName === 'INPUT' })`)
    ok(srch.sel === 1 && srch.focusInInput, `ArrowDown walks the search results while the query keeps focus (${JSON.stringify(srch)})`)
    await key('Escape', 0, 'Escape')

    // ——— panels: the kernel's ———
    await js(`document.activeElement?.blur?.(); 1`)
    const side = `document.querySelector('.sp-side').closest('.bkp')`
    const w0 = await js<number>(`(${side}).getBoundingClientRect().width`)
    await key('[', 0, 'BracketLeft', 219)
    await sleep(350) // the width animates (.14s); measure where it lands
    const shut = await js<any>(`(() => { const t = (${side}).querySelector('.bkp-toggle').getBoundingClientRect(); return { w: (${side}).getBoundingClientRect().width, chev: Math.round(t.x), exp: (${side}).querySelector('.bkp-toggle').getAttribute('aria-expanded') } })()`)
    ok(w0 > 200 && shut.w === 0 && shut.chev === 0 && shut.exp === 'false',
      `\`[\` collapses the page list to nothing, its chevron docked at the edge (${w0} → ${shut.w}px, chevron at x=${shut.chev})`)
    await key('[', 0, 'BracketLeft', 219)
    await sleep(350)
    const strip = await js<any>(`(() => { const r = (${side}).querySelector('.bkp-resizer').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 150 } })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: strip.x, y: strip.y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: strip.x, y: strip.y, button: 'left', clickCount: 1 })
    for (let i = 1; i <= 6; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: strip.x + i * 10, y: strip.y, button: 'left', buttons: 1 }); await sleep(20) }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: strip.x + 60, y: strip.y, button: 'left', clickCount: 1 })
    await sleep(200)
    const dragged = await js<any>(`({ w: Math.round((${side}).getBoundingClientRect().width), stored: localStorage.getItem('bento-sp-pane') })`)
    ok(Math.abs(dragged.w - (w0 + 60)) <= 2 && dragged.stored === String(dragged.w),
      `dragging the strip widens the page list and remembers it for this reader (${w0} → ${dragged.w}, stored ${dragged.stored})`)

    // ——— phone ———
    await open(true)
    const bar = await js<any>(`(() => { const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' }
      const bs = [...document.querySelectorAll('.sp-bar button')].filter(vis).map(b => { const r = b.getBoundingClientRect(); return { l: (b.getAttribute('aria-label') || b.title || '').slice(0, 14), w: Math.round(r.width), h: Math.round(r.height) } })
      const save = [...document.querySelectorAll('.sp-bar button')].find(b => (b.getAttribute('aria-label') || '').startsWith('Save')).getBoundingClientRect()
      return { small: bs.filter(b => b.w < 44 || b.h < 44), save: { w: Math.round(save.width), h: Math.round(save.height) } } })()`)
    ok(bar.small.length === 0, `every phone bar control is a 44px target (D5) (too small: ${JSON.stringify(bar.small)})`)
    ok(bar.save.w === bar.save.h, `phone Save is a square icon button, not a slab (${bar.save.w}×${bar.save.h}; 66×40 before)`)
    await tap(TRIG('More'))
    const ph = await js<any>(`(() => { const m = ${OPEN}; const r = m.getBoundingClientRect(); const rows = [...m.querySelectorAll('.bkm-item')]; return { bottom: r.bottom, vh: innerHeight, n: rows.length, minH: Math.min(...rows.map(x => x.getBoundingClientRect().height)), scrolls: m.scrollHeight > m.clientHeight } })()`)
    ok(ph.bottom <= ph.vh, `the phone ⋯ menu ends inside the screen (bottom ${Math.round(ph.bottom)} ≤ ${ph.vh}; 1003 before)`)
    ok(ph.minH >= 44, `every phone menu row is a 44px target (smallest ${ph.minH.toFixed(1)}px)`)
    const last = await js<any>(`(() => { const m = ${OPEN}; const rows = [...m.querySelectorAll('.bkm-item')]; const l = rows[rows.length - 1]; l.scrollIntoView({ block: 'nearest' }); const r = l.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { text: l.textContent.trim().slice(0, 24), reach: l.contains(hit) } })()`)
    ok(last.reach, `the last ⋯ row ("${last.text}") can be scrolled to and pressed`)
    await key('Escape', 0, 'Escape')
    const g2 = `(() => { const n = document.querySelectorAll('.sp-main [data-block-id]')[2]; return [...n.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Block options') })()`
    await tap(g2)
    const sheet = await js<any>(`(() => { const m = ${OPEN}; if (!m) return null; const r = m.getBoundingClientRect(); return { bottom: r.bottom, vh: innerHeight, w: r.width, vw: innerWidth, minH: Math.min(...[...m.querySelectorAll('.bkm-item')].map(x => x.getBoundingClientRect().height)) } })()`)
    ok(sheet && sheet.vh - sheet.bottom <= 12 && sheet.w >= sheet.vw - 20 && sheet.minH >= 44,
      `on a phone the block menu is a bottom sheet of 44px rows (${JSON.stringify(sheet)})`)
    await key('Escape', 0, 'Escape')

    // the page list is a DRAWER here: opened from the bar, dimmed behind, shut
    // by following a page — and none of that is the reader's desktop preference
    await tap(`[...document.querySelectorAll('.sp-bar button')].find(b => (b.getAttribute('aria-label') || '').startsWith('Pages'))`)
    const drawer = await js<any>(`(() => { const p = document.querySelector('.sp-side').closest('.bkp'); const r = p.getBoundingClientRect(); const row = document.querySelectorAll('.sp-treelink')[1].getBoundingClientRect(); return { drawer: p.classList.contains('bkp-drawer'), w: r.width, scrim: !!document.querySelector('.sp-scrim'), reach: !!document.elementFromPoint(row.x + 20, row.y + row.height / 2)?.closest('.sp-treelink') } })()`)
    ok(drawer.drawer && drawer.w > 200 && drawer.scrim && drawer.reach,
      `on a phone the page list opens as a drawer over a scrim, its rows reachable (${JSON.stringify(drawer)})`)
    const rows = await js<any>(`(() => { const rs = [...document.querySelectorAll('.sp-treelink')].slice(0, 6); const m = rs[0].querySelector('.sp-rowmore').getBoundingClientRect(); return { minRow: Math.min(...rs.map(r => r.getBoundingClientRect().height)), more: [Math.round(m.width), Math.round(m.height)] } })()`)
    ok(rows.minRow >= 44 && rows.more[1] >= 44, `page rows and their ⋯ are 44px targets on a phone (row ${rows.minRow}, ⋯ ${rows.more.join('×')}; 28 and 20×20 before)`)
    await tap(`document.querySelectorAll('.sp-treelink')[1]`)
    const afterNav = await js<any>(`({ w: document.querySelector('.sp-side').closest('.bkp').getBoundingClientRect().width, scrim: !!document.querySelector('.sp-scrim'), stored: localStorage.getItem('bento-sp-pane-closed') })`)
    ok(afterNav.w === 0 && !afterNav.scrim && afterNav.stored === null,
      `following a page shuts the drawer and its scrim, and writes nothing to the desktop preference (${JSON.stringify(afterNav)})`)
    ws.close()
  } finally {
    try { child.kill('SIGKILL') } catch { /* gone */ }
    server.close()
    // Chrome may still be writing its profile as it dies; a failed cleanup of
    // a temp dir is not a failed check
    await new Promise<void>((r) => { child.once('exit', () => r()); setTimeout(r, 2000) })
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* temp dir */ }
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
