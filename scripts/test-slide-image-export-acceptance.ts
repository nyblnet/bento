#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Focused acceptance checks against the shipped single-file build.
// The broader format, scale, raster, and safety matrices live in the pure and
// browser rigs; this file proves that the built product wires those contracts
// to its real desktop, compact, and password UI.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) {
    failures++
    console.error(`  ✗ ${msg}`)
  } else {
    console.log(`  ✓ ${msg}`)
  }
}

const repoFile = (rel: string): string => {
  const file = path.resolve(rel)
  if (!fs.existsSync(file)) {
    throw new Error(`not found: ${rel} — run npm --prefix slides run build:single`)
  }
  return file
}

function assertFreshBuild(dist: string): void {
  const builtAt = fs.statSync(dist).mtimeMs
  const roots = ['slides/src', 'kernel/src']
  const singles = [
    'slides/vite.config.ts', 'slides/package.json', 'slides/package-lock.json',
    'slides/tsconfig.json', 'slides/index.html', 'kernel/tsconfig.json',
    'scripts/postbuild-compress.mjs',
  ]
  let newest = { at: 0, file: '' }
  const inspect = (file: string) => {
    if (!/\.(ts|mjs|css|json|html)$/.test(file)) return
    const at = fs.statSync(file).mtimeMs
    if (at > newest.at) newest = { at, file }
  }
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else inspect(file)
    }
  }
  for (const root of roots) if (fs.existsSync(root)) walk(path.resolve(root))
  for (const file of singles) if (fs.existsSync(file)) inspect(path.resolve(file))
  if (newest.at > builtAt) {
    throw new Error(
      `dist-single is STALE: ${path.relative(process.cwd(), newest.file)} is newer. ` +
      'Run: npm --prefix slides run build:single')
  }
}

const CHROME = [
  process.env.BENTO_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p): p is string => !!p && fs.existsSync(p))
  ?? (spawnSync('which', ['google-chrome']).status === 0 ? 'google-chrome' : undefined)

type Cdp = {
  send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>
  on: (method: string, fn: (params: any) => void) => void
  close: () => void
}

async function connectCdp(url: string): Promise<Cdp> {
  const ws = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('cdp socket failed')), { once: true })
  })
  let seq = 0
  type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  const pending = new Map<number, Pending>()
  const listeners = new Map<string, Array<(p: any) => void>>()
  const settle = (id: number, err: Error | null, value?: unknown) => {
    const slot = pending.get(id)
    if (!slot) return
    pending.delete(id)
    clearTimeout(slot.timer)
    if (err) slot.reject(err)
    else slot.resolve(value)
  }
  ws.addEventListener('message', (event: MessageEvent) => {
    const msg = JSON.parse(String(event.data))
    if (msg.id !== undefined) {
      settle(msg.id, msg.error ? new Error(JSON.stringify(msg.error)) : null, msg.result)
      return
    }
    for (const fn of listeners.get(msg.method) ?? []) fn(msg.params)
  })
  const abandon = (why: string) => {
    for (const id of Array.from(pending.keys())) settle(id, new Error(why))
  }
  ws.addEventListener('close', () => abandon('cdp socket closed'), { once: true })
  return {
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++seq
      const timer = setTimeout(() => settle(id, new Error('cdp timeout: ' + method)), 120_000)
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
    }),
    on: (method, fn) => {
      const list = listeners.get(method) ?? []
      list.push(fn)
      listeners.set(method, list)
    },
    close: () => { abandon('cdp connection closed'); ws.close() },
  }
}

// This expression is evaluated inside the built file. Keep it free of nested
// template literals so it remains inert until Runtime.evaluate executes it.
const DRIVER = `(async () => {
const results = []
const check = (name, pass) => { results.push([name, !!pass]) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const frame = (count) => new Promise((resolve) => {
  let left = count || 2
  const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step))
  requestAnimationFrame(step)
})

const downloads = []
window.__acceptanceDownloads = downloads
const realCreate = URL.createObjectURL
const realClick = HTMLAnchorElement.prototype.click
URL.createObjectURL = function (blob) {
  downloads.push({ blob: blob })
  return realCreate.call(URL, blob)
}
HTMLAnchorElement.prototype.click = function () {
  if (this.download) {
    const last = downloads[downloads.length - 1]
    if (last) last.filename = this.download
    return
  }
  return realClick.call(this)
}

const px = (color) => {
  const canvas = document.createElement('canvas')
  canvas.width = 8; canvas.height = 8
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 8, 8)
  return canvas.toDataURL('image/png')
}
const slide = (id, color, extra) => Object.assign({
  id: id, background: 'transparent', transition: 'none', notes: '', elements: [
    { id: id + '-shape', type: 'shape', x: 40, y: 40, w: 200, h: 200,
      rotation: 0, opacity: 1, shape: 'rect', fill: color,
      stroke: 'none', strokeWidth: 0, radius: 0 },
  ],
}, extra || {})
const makeDoc = (over) => Object.assign({
  format: 'bento/slides', version: 1, docId: 'acceptance-doc',
  title: 'Acceptance', size: { width: 280, height: 280 },
  theme: { background: '#FFFFFF', color: '#1E2A3A', accent: '#F7A600', fontFamily: 'system-ui' },
  assets: {}, fonts: [],
  slides: [
    slide('a1', '#E23D3D'),
    slide('a2', '#2C6BED', { stateOf: 'a1' }),
    slide('a3', '#10B981', { hidden: true }),
    slide('a4', '#F59E0B'),
  ],
}, over || {})
const load = (doc) => {
  if (!window.bento.loadDoc(JSON.stringify(doc))) throw new Error('fixture document was refused')
}

const q = (selector) => document.querySelector(selector)
const dialog = () => q('dialog.ed-image-export')
const menuItems = (root) => Array.from((root || document).querySelectorAll('.ed-menu .ed-btn'))
const exportItem = (root) => menuItems(root).find((button) =>
  /Export slides as images/i.test(button.textContent || ''))
async function openViaDesktop() {
  const caret = q('.ed-split-caret')
  if (!caret) return false
  caret.focus(); caret.click()
  await frame(3)
  const item = exportItem()
  if (!item) return false
  item.click()
  await frame(3)
  return !!dialog()
}
const radios = (name) => Array.from(document.querySelectorAll(
  'dialog.ed-image-export input[name="' + name + '"]'))
const checked = (name) => (radios(name).find((radio) => radio.checked) || {}).value
const choose = (name, value) => {
  const radio = radios(name).find((candidate) => candidate.value === value)
  if (radio) radio.click()
  return !!radio
}
const press = (selector) => {
  const button = q('dialog.ed-image-export ' + selector)
  if (button) button.click()
  return !!button
}
async function waitForDialog(maxMs) {
  const stop = Date.now() + (maxMs || 20000)
  while (Date.now() < stop) {
    await sleep(60)
    if (!dialog()) return 'closed'
    const status = q('.ed-image-export-status')
    if (status && status.classList.contains('is-error')) return 'error'
  }
  return 'timeout'
}
const dimensions = async (blob) => {
  const bitmap = await createImageBitmap(blob)
  const value = [bitmap.width, bitmap.height]
  bitmap.close()
  return value
}
function zipNames(bytes) {
  const u16 = (at) => bytes[at] | (bytes[at + 1] << 8)
  const u32 = (at) => (bytes[at] | (bytes[at + 1] << 8) |
    (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
  let eocd = -1
  for (let at = bytes.length - 22; at >= 0; at--) {
    if (u32(at) === 0x06054b50) { eocd = at; break }
  }
  if (eocd < 0) return []
  const count = u16(eocd + 10)
  let at = u32(eocd + 16)
  const names = []
  for (let index = 0; index < count; index++) {
    if (u32(at) !== 0x02014b50) break
    const nameLength = u16(at + 28)
    names.push(new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)))
    at += 46 + nameLength + u16(at + 30) + u16(at + 32)
  }
  return names
}

try {
  check('the built file exposes the editor and document API',
    !!q('.ed-split-caret') && !!(window.bento && window.bento.loadDoc))

  load(makeDoc())
  await frame(3)
  const opened = await openViaDesktop()
  check('the desktop Save menu opens image export', opened)
  check('the shipped dialog defaults to current PNG at 1x',
    checked('scope') === 'current' && checked('format') === 'png' && checked('scale') === '1')

  const pngBefore = downloads.length
  press('.ed-image-export-run')
  const pngState = await waitForDialog(20000)
  const png = downloads[downloads.length - 1]
  check('a current-slide PNG export completes once',
    pngState === 'closed' && downloads.length === pngBefore + 1 && !!png)
  if (png) {
    const size = await dimensions(png.blob)
    check('the current PNG has the expected filename and dimensions',
      png.filename === 'Acceptance-slide-01.png' && size[0] === 280 && size[1] === 280)
  }

  load(makeDoc())
  await frame(3)
  await openViaDesktop()
  choose('scope', 'all-main')
  const zipBefore = downloads.length
  press('.ed-image-export-run')
  const zipState = await waitForDialog(30000)
  const archive = downloads[downloads.length - 1]
  check('an all-main ZIP export completes once',
    zipState === 'closed' && downloads.length === zipBefore + 1 && !!archive)
  if (archive) {
    check('the ZIP is named for the deck', archive.filename === 'Acceptance-slides.zip')
    const names = zipNames(new Uint8Array(await archive.blob.arrayBuffer()))
    check('the ZIP contains two main-slide entries in document order',
      names.length === 2 && names.join(',') === 'slide-01.png,slide-02.png')
  }

  load(makeDoc({ docId: 'enc-acceptance-doc' }))
  await frame(3)
  const save = q('.ed-split-caret')
  if (save) { save.focus(); save.click(); await frame(3) }
  const encryptItem = menuItems().find((button) =>
    /Encrypt with password/i.test(button.textContent || ''))
  check('the real Save menu offers password protection', !!encryptItem)
  if (encryptItem) { encryptItem.click(); await frame(3) }
  const passwordDialog = q('dialog.ed-pwdialog')
  check('the real password dialog opens', !!passwordDialog)
  if (passwordDialog) {
    const fields = passwordDialog.querySelectorAll('input[type="password"]')
    const first = fields[0]
    const second = fields[1]
    const confirm = passwordDialog.querySelector('.ok')
    if (first && second && confirm) {
      const fixtureValue = ['acceptance', 'fixture'].join('-')
      first.value = fixtureValue
      second.value = fixtureValue
      first.dispatchEvent(new Event('input', { bubbles: true }))
      second.dispatchEvent(new Event('input', { bubbles: true }))
      confirm.click()
      await sleep(600)
      await frame(3)
    }
  }

  const beforeJson = JSON.stringify(window.bento.doc)
  const beforeDocId = window.bento.doc.docId
  const docBlock = document.getElementById('bento-doc')
  const beforeDocBlock = docBlock ? docBlock.textContent : null
  const encryptedBefore = downloads.length
  await openViaDesktop()
  const warning = q('dialog.ed-image-export .ed-image-export-note')
  const warningText = warning ? warning.textContent || '' : ''
  check('encrypted export warns that its output is plaintext and leaves the source unchanged',
    !!warning && /not password-protected/i.test(warningText) && /not changed/i.test(warningText))
  press('.ed-image-export-run')
  const encryptedState = await waitForDialog(20000)
  const encryptedArtifact = downloads[downloads.length - 1]
  check('the encrypted deck still exports one image',
    encryptedState === 'closed' && downloads.length === encryptedBefore + 1 &&
    encryptedArtifact?.filename === 'Acceptance-slide-01.png' &&
    encryptedArtifact?.blob.type === 'image/png')
  check('export preserves the encrypted deck identity and document model',
    window.bento.doc.docId === beforeDocId && beforeDocId === 'enc-acceptance-doc' &&
    JSON.stringify(window.bento.doc) === beforeJson)
  const afterDocBlocks = document.querySelectorAll('#bento-doc')
  check('export preserves the single plaintext #bento-doc block',
    beforeDocBlock !== null && afterDocBlocks.length === 1 &&
    afterDocBlocks[0].textContent === beforeDocBlock)

  const saveAgain = q('.ed-split-caret')
  if (saveAgain) { saveAgain.click(); await frame(3) }
  const removePassword = menuItems().find((button) =>
    /Remove password/i.test(button.textContent || ''))
  if (removePassword) { removePassword.click(); await sleep(400); await frame(3) }

  load(makeDoc({
    slides: [{
      id: 'r1', background: '#FFFFFF', transition: 'none', notes: '', elements: [
        { id: 'r1-image', type: 'image', x: 20, y: 20, w: 100, h: 100,
          rotation: 0, opacity: 1, src: px('#3355FF'), fit: 'fill', radius: 0 },
      ],
    }],
  }))
  await frame(4)
  await sleep(400)
  window.bento.doc.slides[0].elements[0].src = 'http://bento-acceptance.invalid/linked.png'
  window.__acceptanceStaged = true

  return { results: results }
} catch (err) {
  results.push(['the acceptance driver ran to the end: ' + String(err), false])
  return { results: results }
}
})()`

async function run(chrome: string) {
  const file = repoFile('slides/dist-single/Bento_Slides.bento.html')
  assertFreshBuild(file)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-accept-'))
  const profile = path.join(tmp, 'profile')
  const child = spawn(chrome, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--disable-default-apps', '--user-data-dir=' + profile,
    '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] })

  const requests: string[] = []
  let cdp: Cdp | null = null
  const waitForExit = (timeoutMs: number) => new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return }
    const finish = (exited: boolean) => {
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })

  try {
    const portFile = path.join(profile, 'DevToolsActivePort')
    const deadline = Date.now() + 30_000
    while (!fs.existsSync(portFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!fs.existsSync(portFile)) throw new Error('chrome never published a devtools port')
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim()
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as
      { webSocketDebuggerUrl: string; Browser: string }
    console.log(`  browser: ${version.Browser}`)
    cdp = await connectCdp(version.webSocketDebuggerUrl)

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    cdp.on('Network.requestWillBeSent', (params) => {
      if (params?.request?.url) requests.push(params.request.url)
    })
    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Page.navigate', { url: 'file://' + file }, sessionId)

    const readyBy = Date.now() + 60_000
    let ready = false
    while (Date.now() < readyBy && !ready) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const response = await cdp.send('Runtime.evaluate', {
        expression: '!!document.querySelector(".ed-split-caret") && !!(window.bento && window.bento.loadDoc)',
        returnByValue: true,
      }, sessionId)
      ready = response?.result?.value === true
    }
    ok(ready, 'the shipped file booted its editor within 60s')
    if (!ready) return

    const evaluated = await cdp.send('Runtime.evaluate', {
      expression: DRIVER, awaitPromise: true, returnByValue: true,
    }, sessionId)
    const payload = evaluated?.result?.value as
      { results: Array<[string, boolean]> } | undefined
    if (!payload) {
      ok(false, `the acceptance driver returned results: ${JSON.stringify(evaluated).slice(0, 200)}`)
    } else {
      for (const [name, pass] of payload.results) ok(pass, name)
    }

    const stagedResponse = await cdp.send('Runtime.evaluate', {
      expression: 'window.__acceptanceStaged === true', returnByValue: true,
    }, sessionId)
    const staged = stagedResponse?.result?.value === true
    ok(staged, 'the linked-resource fixture was staged without rendering it')
    if (staged) {
      const beforeRequests = requests.length
      const refusal = await cdp.send('Runtime.evaluate', {
        expression: `(async () => {
          const frame = (count) => new Promise((resolve) => {
            let left = count
            const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step))
            requestAnimationFrame(step)
          })
          const beforeDownloads = window.__acceptanceDownloads.length
          const caret = document.querySelector('.ed-split-caret')
          if (!caret) return { ran: false, why: 'no Save caret' }
          caret.click(); await frame(3)
          const item = Array.from(document.querySelectorAll('.ed-menu .ed-btn'))
            .find((button) => /Export slides as images/i.test(button.textContent || ''))
          if (!item) return { ran: false, why: 'no export item' }
          item.click(); await frame(3)
          const run = document.querySelector('.ed-image-export-run')
          if (!run) return { ran: false, why: 'no run button' }
          run.click()
          const stop = Date.now() + 20000
          let status = ''
          while (Date.now() < stop) {
            await new Promise((resolve) => setTimeout(resolve, 60))
            const node = document.querySelector('.ed-image-export-status')
            if (node && node.classList.contains('is-error')) {
              status = node.textContent || ''
              break
            }
            if (!document.querySelector('dialog.ed-image-export')) break
          }
          const stillOpen = !!document.querySelector('dialog.ed-image-export')
          const downloads = window.__acceptanceDownloads.length - beforeDownloads
          const cancel = document.querySelector('.ed-image-export-cancel')
          if (cancel) cancel.click()
          await frame(3)
          return { ran: true, status: status, stillOpen: stillOpen, downloads: downloads }
        })()`,
        awaitPromise: true, returnByValue: true,
      }, sessionId)
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const duringExport = requests.slice(beforeRequests)
      const value = refusal?.result?.value as any
      ok(!!value?.ran, `the linked-resource export ran (${value?.why ?? 'ran'})`)
      ok(/Slide 1/.test(value?.status ?? '') && /embed/i.test(value?.status ?? ''),
        'a linked image is refused with an actionable message')
      ok(value?.stillOpen === true && value?.downloads === 0,
        'the refusal remains visible and downloads nothing')
      ok(duringExport.length === 0,
        `the export made no linked-resource request (${duringExport.length} requests)`)
    }

    const controlUrl = 'http://bento-acceptance.invalid/positive-control.png'
    await cdp.send('Runtime.evaluate', {
      expression: `new Promise((resolve) => {
        const image = new Image()
        image.onload = image.onerror = () => resolve(true)
        image.src = ${JSON.stringify(controlUrl)}
        setTimeout(() => resolve(true), 3000)
      })`,
      awaitPromise: true, returnByValue: true,
    }, sessionId)
    await new Promise((resolve) => setTimeout(resolve, 800))
    ok(requests.includes(controlUrl), 'the request log sees its positive control')

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 320, height: 720, deviceScaleFactor: 1, mobile: true,
    }, sessionId)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const compact = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const frame = (count) => new Promise((resolve) => {
          let left = count
          const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step))
          requestAnimationFrame(step)
        })
        const loaded = window.bento.loadDoc(JSON.stringify({
          format: 'bento/slides', version: 1, docId: 'acceptance-phone',
          title: 'Compact', size: { width: 200, height: 200 },
          theme: { background: '#FFFFFF', color: '#1E2A3A', accent: '#F7A600', fontFamily: 'system-ui' },
          assets: {}, fonts: [], slides: [{
            id: 'phone-1', background: '#FFFFFF', transition: 'none', notes: '', elements: [],
          }],
        }))
        if (!loaded) return { reached: false, why: 'fixture refused' }
        await frame(4)
        const drops = Array.from(document.querySelectorAll('.ed-dropdown.ed-phone-only'))
        const moreDrop = drops.find((drop) => {
          const button = drop.querySelector('button')
          return button && /⋯|More/i.test((button.textContent || '') + ' ' + (button.title || ''))
        })
        if (!moreDrop) return { reached: false, why: 'no compact More menu' }
        const more = moreDrop.querySelector('button')
        more.click(); await frame(4)
        const item = Array.from(moreDrop.querySelectorAll('.ed-menu .ed-btn'))
          .find((button) => /Export slides as images/i.test(button.textContent || ''))
        if (!item) return { reached: false, why: 'no export item' }
        item.click(); await frame(4)
        const opened = !!document.querySelector('dialog.ed-image-export')
        const cancel = document.querySelector('.ed-image-export-cancel')
        if (cancel) cancel.click()
        await frame(3)
        return { reached: true, opened: opened }
      })()`,
      awaitPromise: true, returnByValue: true,
    }, sessionId)
    const phone = compact?.result?.value as any
    ok(!!phone?.reached, `the compact More menu carries image export (${phone?.why ?? 'reached'})`)
    ok(phone?.opened === true, 'the compact menu opens the shipped export dialog')
    await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId)
  } finally {
    try { await cdp?.send('Browser.close') } catch { /* already closed */ }
    cdp?.close()
    if (!await waitForExit(2_000)) child.kill('SIGTERM')
    if (!await waitForExit(2_000)) child.kill('SIGKILL')
    await waitForExit(5_000)
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    } catch { /* temporary cleanup is best-effort */ }
  }
}

console.log('\nslide image export — acceptance against the shipped file')
if (process.env.CI && !CHROME) {
  console.error('  ✗ CI must not skip this: no Chrome found.')
  process.exit(1)
}
if (!CHROME) {
  console.log('  ⚠ SKIPPED — no Chrome. A SKIP IS NOT A PASS.')
} else {
  await run(CHROME)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
