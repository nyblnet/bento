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
    await key('Escape', 0, 'Escape')

    // ——— phone ———
    await open(true)
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
