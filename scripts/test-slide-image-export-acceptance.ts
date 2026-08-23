#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Slide image export — acceptance against THE SHIPPED FILE.
//
//   npm --prefix slides run build:single
//   node scripts/test-slide-image-export-acceptance.ts
//
// WHAT THIS PROVES THAT THE OTHER RIGS CANNOT. The unit rigs drive the export
// modules directly, with a stub where the editor should be. Everything BETWEEN
// the menu and those modules is therefore unproven by them: whether the Save
// dropdown actually carries the item, whether the phone ⋯ list gets it from the
// same builder, whether focus lands on a control the user can see, whether
// Cancel really leaves the document alone, and whether the encryption warning
// appears (and disappears) through the real password UI.
//
// Pending contenteditable ordering — whether the editor commits its in-progress
// text edit BEFORE the export snapshot is taken — remains outside this rig. The
// body records that limitation as an explicit note, not a silent gap.
//
// So this one opens dist-single/Bento_Slides.bento.html — the artifact a user
// downloads — through file://, and clicks the real chrome. Nothing here reads
// source: every claim is a DOM interaction, a captured download, or a CDP
// request log.
//
// Chrome only, deliberately. No other engine has been measured for this
// feature and none is claimed.

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
  if (!fs.existsSync(file)) throw new Error(`not found: ${rel} — run npm --prefix slides run build:single`)
  return file
}

/**
 * Refuse to run against a STALE build.
 *
 * This rig's whole value is that it tests the shipped artifact. A dist older
 * than the sources it was built from tests the previous version of the feature
 * and reports it as this one's — which is worse than not running at all.
 */
function assertFreshBuild(dist: string): void {
  const builtAt = fs.statSync(dist).mtimeMs
  const roots = ['slides/src', 'kernel/src']
  // Individual files whose contents shape the artifact but live outside src/.
  const singles = [
    'slides/vite.config.ts',
    'slides/package.json',
    'slides/package-lock.json',
    'slides/tsconfig.json',
    'slides/index.html',
    'kernel/tsconfig.json',
    'scripts/postbuild-compress.mjs',
  ]
  let newest = 0
  let newestFile = ''
  const check = (full: string) => {
    if (!/\.(ts|mjs|css|json|html)$/.test(path.basename(full))) return
    const at = fs.statSync(full).mtimeMs
    if (at > newest) { newest = at; newestFile = full }
  }
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      check(full)
    }
  }
  for (const root of roots) if (fs.existsSync(root)) walk(path.resolve(root))
  for (const s of singles) { const f = path.resolve(s); if (fs.existsSync(f)) check(f) }
  if (newest > builtAt) {
    throw new Error(
      `dist-single is STALE: ${path.relative(process.cwd(), newestFile)} is newer than the build. ` +
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

// --- the smallest CDP client that answers this question ---------------------

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
  // Always clear the timer: an armed one keeps node's event loop alive long
  // after the last check, which reads as a hung rig.
  const settle = (id: number, err: Error | null, value?: unknown) => {
    const slot = pending.get(id)
    if (!slot) return
    pending.delete(id)
    clearTimeout(slot.timer)
    if (err) slot.reject(err)
    else slot.resolve(value)
  }
  ws.addEventListener('message', (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data))
    if (msg.id !== undefined) {
      if (msg.error) settle(msg.id, new Error(JSON.stringify(msg.error)))
      else settle(msg.id, null, msg.result)
      return
    }
    for (const fn of listeners.get(msg.method) ?? []) fn(msg.params)
  })
  const abandonAll = (why: string) => {
    for (const id of Array.from(pending.keys())) settle(id, new Error(why))
  }
  ws.addEventListener('close', () => abandonAll('cdp socket closed'), { once: true })
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
    close: () => { abandonAll('cdp connection closed'); ws.close() },
  }
}

// ---------------------------------------------------------------------------
// The in-page driver. Written without backticks or "${" so it can live in a
// template literal.
// ---------------------------------------------------------------------------

const DRIVER = `(async () => {
const results = []
const notes = []
const check = (name, pass) => { results.push([name, !!pass]) }
const note = (line) => { notes.push(line) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const frame = (n) => new Promise((r) => {
  let left = n || 2
  const step = () => (--left <= 0 ? r() : requestAnimationFrame(step))
  requestAnimationFrame(step)
})

// --- capture downloads instead of performing them -------------------------
const downloads = []
window.__acceptanceDownloads = downloads
const realCreate = URL.createObjectURL
const realRevoke = URL.revokeObjectURL
let revoked = 0
URL.createObjectURL = function (blob) {
  downloads.push({ blob: blob, at: Date.now() })
  return realCreate.call(URL, blob)
}
URL.revokeObjectURL = function (url) { revoked++; return realRevoke.call(URL, url) }
let clicks = 0
window.__acceptanceAllowRealDownload = false
window.__acceptanceRealDownloadClicks = 0
const realClick = HTMLAnchorElement.prototype.click
HTMLAnchorElement.prototype.click = function () {
  if (this.download) {
    clicks++
    downloads[downloads.length - 1].filename = this.download
    if (window.__acceptanceAllowRealDownload) {
      window.__acceptanceAllowRealDownload = false   // one-shot: only the next download
      window.__acceptanceRealDownloadClicks++
      return realClick.call(this)
    }
    return
  }
  return realClick.call(this)
}

// --- a deterministic deck --------------------------------------------------
const px = (color, w, h) => {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const x = c.getContext('2d')
  x.fillStyle = color
  x.fillRect(0, 0, w, h)
  return c.toDataURL('image/png')
}
const INK = ['#E23D3D', '#2C6BED', '#10B981']
const slide = (id, ink, extra) => Object.assign({
  id: id, background: 'transparent', transition: 'none', notes: '', elements: [
    { id: id + '-r', type: 'shape', x: 40, y: 40, w: 200, h: 200, rotation: 0, opacity: 1,
      shape: 'rect', fill: ink, stroke: 'none', strokeWidth: 0, radius: 0 },
  ],
}, extra || {})

const makeDoc = (over) => Object.assign({
  format: 'bento/slides', version: 1, docId: 'acceptance-doc',
  title: 'Acceptance', size: { width: 280, height: 280 },
  theme: { background: '#FFFFFF', color: '#1E2A3A', accent: '#F7A600', fontFamily: 'system-ui' },
  assets: {}, fonts: [],
  slides: [
    slide('a1', INK[0]),
    slide('a2', INK[1], { stateOf: 'a1' }),
    slide('a3', INK[2], { hidden: true }),
    slide('a4', '#F59E0B'),
  ],
}, over || {})

const load = (doc) => {
  const okLoad = window.bento.loadDoc(JSON.stringify(doc))
  if (!okLoad) throw new Error('bento.loadDoc REFUSED the fixture document — the editor is ' +
    'still showing something else, so nothing below would be testing what it claims')
  return okLoad
}

// --- helpers over the REAL chrome -----------------------------------------
const q = (sel) => document.querySelector(sel)
const dialog = () => document.querySelector('dialog.ed-image-export')
const menuItems = () => Array.from(document.querySelectorAll('.ed-menu .ed-btn'))
const findExportItem = () => menuItems().find((b) => /Export slides as images/i.test(b.textContent || ''))

async function openViaDesktop() {
  const caret = q('.ed-split-caret')
  if (!caret) return null
  caret.focus()
  caret.click()
  await frame(3)
  const item = findExportItem()
  if (!item) return null
  item.click()
  await frame(3)
  return caret
}

const radios = (name) =>
  Array.from(document.querySelectorAll('dialog.ed-image-export input[name="' + name + '"]'))
const checked = (name) => (radios(name).find((r) => r.checked) || {}).value
const choose = (name, value) => {
  const r = radios(name).find((x) => x.value === value)
  if (r) r.click()
  return !!r
}
const press = (sel) => { const b = q('dialog.ed-image-export ' + sel); if (b) b.click(); return !!b }

async function settle(maxMs) {
  const stop = Date.now() + (maxMs || 15000)
  while (Date.now() < stop) {
    await sleep(60)
    if (!dialog()) return 'closed'
    const status = q('.ed-image-export-status')
    if (status && status.classList.contains('is-error')) return 'error'
  }
  return 'timeout'
}

const dims = async (blob) => {
  const bmp = await createImageBitmap(blob)
  const wh = [bmp.width, bmp.height]
  bmp.close()
  return wh
}
const pixelAt = async (blob, x, y) => {
  const bmp = await createImageBitmap(blob)
  const c = document.createElement('canvas')
  c.width = bmp.width; c.height = bmp.height
  const g = c.getContext('2d')
  g.drawImage(bmp, 0, 0)
  bmp.close()
  const d = g.getImageData(x, y, 1, 1).data
  return [d[0], d[1], d[2], d[3]]
}
const near = (a, r, g, b, tol) =>
  Math.abs(a[0] - r) <= tol && Math.abs(a[1] - g) <= tol && Math.abs(a[2] - b) <= tol
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

/** Read a zip's central directory the way a real reader does. */
function zipEntries(z) {
  const u16 = (at) => z[at] | (z[at + 1] << 8)
  const u32 = (at) => (z[at] | (z[at + 1] << 8) | (z[at + 2] << 16) | (z[at + 3] << 24)) >>> 0
  let eocd = -1
  for (let i = z.length - 22; i >= 0; i--) if (u32(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) return []
  const count = u16(eocd + 10)
  let at = u32(eocd + 16)
  const out = []
  for (let i = 0; i < count; i++) {
    if (u32(at) !== 0x02014b50) break
    const nameLen = u16(at + 28)
    const size = u32(at + 24)
    const localAt = u32(at + 42)
    const name = new TextDecoder().decode(z.subarray(at + 46, at + 46 + nameLen))
    const dataAt = localAt + 30 + u16(localAt + 26) + u16(localAt + 28)
    out.push({ name: name, method: u16(localAt + 8), data: z.subarray(dataAt, dataAt + size) })
    at += 46 + nameLen + u16(at + 30) + u16(at + 32)
  }
  return out
}

try {
  // ---- the editor is really up -------------------------------------------
  check('the built file booted an editor with a Save split button', !!q('.ed-split-caret'))
  check('and exposes the tooling API this rig drives it with',
    !!(window.bento && typeof window.bento.loadDoc === 'function'))

  load(makeDoc())
  await frame(3)

  // ---- what the SHIPPED stylesheet actually contains ---------------------
  // Diagnostic, not an assertion: if the export refuses every deck, this says
  // which rule in the real bundle it is refusing over.
  {
    const suspicious = []
    for (const sheet of Array.from(document.styleSheets)) {
      let rules = null
      try { rules = sheet.cssRules } catch (e) { suspicious.push('UNREADABLE SHEET: ' + String(e)); continue }
      if (!rules) continue
      const ownerId = sheet.ownerNode && sheet.ownerNode.id
      for (const rule of Array.from(rules)) {
        const text = rule.cssText || ''
        const found = text.match(/url\\(\\s*['"]?([^'")]{0,90})/gi) || []
        for (const f of found) {
          const target = f.replace(/^url\\(\\s*['"]?/i, '')
          if (target.indexOf('#') === 0) continue
          if (/^data:/i.test(target)) {
            // the MIME is what the export classifies on, so report just that
            suspicious.push((ownerId || 'sheet') + ' :: DATA ' + target.slice(0, 40))
            continue
          }
          suspicious.push((ownerId || 'sheet') + ' :: ' + target.slice(0, 70))
        }
        if (/image-set/i.test(text)) suspicious.push((ownerId || 'sheet') + ' :: image-set ' + text.slice(0, 70))
        if (/@import/i.test(text)) suspicious.push((ownerId || 'sheet') + ' :: @import')
      }
    }
    note('non-embedded css targets in the shipped bundle: ' +
      (suspicious.length ? JSON.stringify(suspicious.slice(0, 6)) : 'none'))
  }

  // ---- desktop reachability + defaults + a11y ----------------------------
  const caret = await openViaDesktop()
  check('the Save dropdown carries "Export slides as images…"', !!caret && !!dialog())
  const dlg = dialog()
  const labelledBy = dlg ? dlg.getAttribute('aria-labelledby') : ''
  const heading = labelledBy ? document.getElementById(labelledBy) : null
  check('the dialog names itself with a real heading',
    !!heading && /^H[1-6]$/.test(heading.tagName) && !!(heading.textContent || '').trim())
  check('all three choices are present and intact',
    radios('scope').length === 2 && radios('format').length === 2 && radios('scale').length === 2)
  check('defaulting to current / PNG / 1x',
    checked('scope') === 'current' && checked('format') === 'png' && checked('scale') === '1')
  check('focus is inside the dialog', !!dlg && dlg.contains(document.activeElement))
  const overflow = dlg
    ? Array.from(dlg.querySelectorAll('*')).filter((e) => e.scrollWidth > e.clientWidth + 1).length
    : -1
  check('nothing overflows horizontally (' + overflow + ' offenders)', overflow === 0)

  // ---- Cancel changes nothing -------------------------------------------
  const beforeDoc = JSON.stringify(window.bento.doc)
  const downloadsBeforeCancel = downloads.length
  press('.ed-image-export-cancel')
  await frame(3)
  check('Cancel closes the dialog', !dialog())
  check('Cancel returns focus to the VISIBLE Save caret, not the hidden menu item',
    document.activeElement === caret)
  check('Cancel downloads nothing', downloads.length === downloadsBeforeCancel)
  check('Cancel leaves the document byte-identical', JSON.stringify(window.bento.doc) === beforeDoc)

  // ---- the pending-edit ordering: NOT claimed here -----------------------
  //
  // The honest position. Proving "confirm commits the active text edit before
  // the snapshot" needs a REAL canvas edit — started through the editor's own
  // double-click path, not by setting contenteditable from outside, which
  // produces a DOM that looks edited while the editor holds no edit state at
  // all. And opening the Save menu moves focus, which can fire the editor's
  // ordinary blur-commit first, so a passing assertion would not distinguish
  // "the handler committed it" from "the blur did".
  //
  // Rather than assert something this rig cannot separate, it records what it
  // CAN see: that an export from a deck with text produces a download, and
  // that the document still holds that text afterwards.
  {
    load(makeDoc({
      slides: [{
        id: 't1', background: '#FFFFFF', transition: 'none', notes: '', elements: [
          { id: 't1-txt', type: 'text', x: 20, y: 20, w: 240, h: 80, rotation: 0, opacity: 1,
            html: 'PRESENT', fontSize: 28, fontWeight: 700, color: '#000000',
            align: 'left', valign: 'top', lineHeight: 1.2, fontFamily: '' },
        ],
      }],
    }))
    await frame(3)
    const before = downloads.length
    await openViaDesktop()
    press('.ed-image-export-run')
    const how = await settle(20000)
    const why = (q('.ed-image-export-status') || {}).textContent || ''
    check('a deck with text exports (' + how + (how === 'error' ? ': ' + why.slice(0, 90) : '') + ')',
      how === 'closed')
    check('and produced exactly one download', downloads.length === before + 1)
    check('with the document text intact afterwards',
      JSON.stringify(window.bento.doc).indexOf('PRESENT') >= 0)
    note('pending-edit ordering is NOT asserted here — see the comment above')
    if (dialog()) { press('.ed-image-export-cancel'); await frame(3) }
  }

  // ---- current PNG at 1x and 2x, and the JPEG matte ---------------------
  {
    load(makeDoc())
    await frame(3)
    const before = downloads.length
    await openViaDesktop()
    press('.ed-image-export-run')
    await settle(20000)
    const one = downloads[downloads.length - 1]
    if (!one) {
      check('current PNG at 1x produced a download', false)
      throw new Error('no download to inspect; the status said: ' +
        (((q('.ed-image-export-status') || {}).textContent) || '(nothing)'))
    }
    const d1 = await dims(one.blob)
    check('current PNG at 1x is 280x280 (got ' + d1.join('x') + ')', d1[0] === 280 && d1[1] === 280)
    check('named for the deck and the slide (' + one.filename + ')',
      /Acceptance-slide-0?1\\.png$/.test(one.filename || ''))
    check('exactly one download for one export', downloads.length === before + 1)

    await openViaDesktop()
    choose('scale', '2')
    press('.ed-image-export-run')
    await settle(20000)
    const d2 = await dims(downloads[downloads.length - 1].blob)
    check('current PNG at 2x is 560x560 (got ' + d2.join('x') + ')', d2[0] === 560 && d2[1] === 560)

    await openViaDesktop()
    choose('format', 'jpeg')
    press('.ed-image-export-run')
    await settle(20000)
    const jpg = downloads[downloads.length - 1]
    const jd = await dims(jpg.blob)
    check('current JPEG at 1x is 280x280 (got ' + jd.join('x') + ')', jd[0] === 280 && jd[1] === 280)
    check('and its filename is .jpg (' + jpg.filename + ')', /\\.jpg$/.test(jpg.filename || ''))
    // The fixture has a transparent background with a centered shape, so the
    // corner (4,4) is the background region. PNG preserves transparency; JPEG
    // replaces it with the #FFFFFF matte the renderer pre-fills (image-export.ts).
    const pngCorner = await pixelAt(one.blob, 4, 4)
    check('PNG corner is transparent (alpha=0) on a transparent-background fixture',
      pngCorner[3] === 0)
    const jpegCorner = await pixelAt(jpg.blob, 4, 4)
    check('JPEG corner is opaque (alpha=255) — the matte replaced transparency',
      jpegCorner[3] === 255)
    check('JPEG corner is white — the matte is #FFFFFF, not black',
      jpegCorner[0] > 240 && jpegCorner[1] > 240 && jpegCorner[2] > 240)
    // --- JPEG at 2x ---------------------------------------------------------
    await openViaDesktop()
    choose('format', 'jpeg')
    choose('scale', '2')
    press('.ed-image-export-run')
    await settle(20000)
    const jpg2 = downloads[downloads.length - 1]
    const jd2 = await dims(jpg2.blob)
    check('current JPEG at 2x is 560x560 (got ' + jd2.join('x') + ')', jd2[0] === 560 && jd2[1] === 560)

    // --- file signatures (magic bytes) and MIME types -----------------------
    const sig = async (blob) => new Uint8Array(await blob.slice(0, 8).arrayBuffer())
    const pngSig = await sig(one.blob)
    const pngMagic = pngSig[0] === 0x89 && pngSig[1] === 0x50 && pngSig[2] === 0x4E && pngSig[3] === 0x47 &&
      pngSig[4] === 0x0D && pngSig[5] === 0x0A && pngSig[6] === 0x1A && pngSig[7] === 0x0A
    check('PNG file has the full 8-byte signature (89 50 4E 47 0D 0A 1A 0A)', pngMagic)
    check('PNG blob.type is image/png', one.blob.type === 'image/png')
    const jpgSig = await sig(jpg.blob)
    const jpgMagic = jpgSig[0] === 0xFF && jpgSig[1] === 0xD8 && jpgSig[2] === 0xFF
    check('JPEG file starts with the FF D8 FF SOI marker', jpgMagic)
    check('JPEG blob.type is image/jpeg', jpg.blob.type === 'image/jpeg')
    // EOI: the last two bytes of a valid JPEG are FF D9
    const jpgTail = new Uint8Array(await jpg.blob.slice(jpg.blob.size - 2).arrayBuffer())
    check('JPEG file ends with the FF D9 EOI marker', jpgTail[0] === 0xFF && jpgTail[1] === 0xD9)

    // --- JPEG 1x and 2x blob.type and signature confirmation ----------------
    check('JPEG 1x blob.type is image/jpeg', jpg.blob.type === 'image/jpeg')
    check('JPEG 2x blob.type is image/jpeg', jpg2.blob.type === 'image/jpeg')
    const jpg2Sig = await sig(jpg2.blob)
    check('JPEG 2x starts with SOI', jpg2Sig[0] === 0xFF && jpg2Sig[1] === 0xD8 && jpg2Sig[2] === 0xFF)
    const jpg2Tail = new Uint8Array(await jpg2.blob.slice(jpg2.blob.size - 2).arrayBuffer())
    check('JPEG 2x ends with EOI', jpg2Tail[0] === 0xFF && jpg2Tail[1] === 0xD9)

    // --- pixel identity between PNG and JPEG of the same slide --------------
    const pngPx = await pixelAt(one.blob, 140, 140)
    const jpgPx = await pixelAt(jpg.blob, 140, 140)
    const redInk = hex(INK[0])
    check('PNG center pixel matches the slide ink (' + INK[0] + ')',
      near(pngPx, redInk[0], redInk[1], redInk[2], 10))
    check('JPEG center pixel agrees with PNG (within JPEG tolerance)',
      near(jpgPx, redInk[0], redInk[1], redInk[2], 15))
  }

  // ---- all main slides: order, hidden and state omitted -----------------
  {
    load(makeDoc())
    await frame(3)
    await openViaDesktop()
    choose('scope', 'all-main')
    press('.ed-image-export-run')
    const how = await settle(30000)
    check('the all-main export finished (' + how + ')', how === 'closed')
    const zipDl = downloads[downloads.length - 1]
    check('it is named as an archive (' + zipDl.filename + ')', /\\.zip$/.test(zipDl.filename || ''))
    const bytes = new Uint8Array(await zipDl.blob.arrayBuffer())

    // ZIP file signature: PK\x03\x04
    check('the archive starts with the PK ZIP signature',
      bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04)

    const entries = zipEntries(bytes)
    check('the archive holds only the two MAIN slides — the state and the hidden ' +
      'slide are left out (' + entries.length + ')', entries.length === 2)
    check('named as contiguous ordinals in document order (' +
      entries.map((e) => e.name).join(',') + ')',
      entries.map((e) => e.name).join(',') === 'slide-01.png,slide-02.png')
    check('stored, not deflated', entries.every((e) => e.method === 0))

    // per-entry PNG signature check (full 8-byte header)
    const entryPngSigs = entries.every((e) =>
      e.data[0] === 0x89 && e.data[1] === 0x50 && e.data[2] === 0x4E && e.data[3] === 0x47 &&
      e.data[4] === 0x0D && e.data[5] === 0x0A && e.data[6] === 0x1A && e.data[7] === 0x0A)
    check('every entry in the archive has the full 8-byte PNG signature', entryPngSigs)

    const first = await pixelAt(new Blob([entries[0].data]), 140, 140)
    const second = await pixelAt(new Blob([entries[1].data]), 140, 140)
    const c1 = hex(INK[0]); const c2 = hex('#F59E0B')
    check('slide-01 holds slide a1 ink (' + INK[0] + ')',
      near(first, c1[0], c1[1], c1[2], 10))
    check('slide-02 holds slide a4 ink (#F59E0B)',
      near(second, c2[0], c2[1], c2[2], 10))

    // negative pixel proof: the state slide (INK[1] = blue) and hidden slide
    // (INK[2] = green) must NOT appear in any exported entry at their known
    // paint position (140,140). This proves the export selected the right
    // slides, not merely two slides.
    const stateInk = hex(INK[1])
    const hiddenInk = hex(INK[2])
    check('slide-01 does NOT contain the state slide ink (blue) — the right slide was chosen',
      !near(first, stateInk[0], stateInk[1], stateInk[2], 15))
    check('slide-02 does NOT contain the hidden slide ink (green)',
      !near(second, hiddenInk[0], hiddenInk[1], hiddenInk[2], 15))
  }

  // ---- the CURRENT slide may be a hidden one ----------------------------
  {
    load(makeDoc())
    await frame(3)
    const hidBefore = downloads.length
    const hidThumb = q('.ed-thumb.ed-thumb-hidden[data-index="2"]')
    if (hidThumb) {
      hidThumb.click()
      await frame(3)
      check('the hidden thumb (index 2) has the active class after click',
        hidThumb.classList.contains('active'))
      await openViaDesktop()
      press('.ed-image-export-run')
      const how = await settle(20000)
      check('a HIDDEN slide exports as the current one (' + how + ')',
        how === 'closed' && downloads.length === hidBefore + 1)
      const dl = downloads[downloads.length - 1]
      const d = await dims(dl.blob)
      check('hidden slide export is 280x280 (got ' + d.join('x') + ')',
        d[0] === 280 && d[1] === 280)
      check('hidden slide filename is slide-03 (' + (dl.filename || '') + ')',
        /slide-0?3\.png$/.test(dl.filename || ''))
      // pixel identity: it exported the green hidden slide, not another
      const hidPx = await pixelAt(dl.blob, 140, 140)
      const greenInk = hex(INK[2])
      check('the hidden slide export contains the hidden slide ink (green)',
        near(hidPx, greenInk[0], greenInk[1], greenInk[2], 10))
    } else {
      check('a HIDDEN slide thumb was found at .ed-thumb.ed-thumb-hidden[data-index="2"]', false)
    }
  }

  // ---- the CURRENT slide may be a STATE slide ----------------------------
  //
  // A state slide is excluded from "all main" but when it IS the current one,
  // a "current" export must still produce it. This section clicks its specific
  // thumb, requires the active class, and then exports — asserting dimensions,
  // signature, blob.type, filename, and that the center pixel is blue
  // (INK[1] = #2C6BED), not the red of slide a1.
  {
    load(makeDoc())
    await frame(3)
    const stBefore = downloads.length
    const stThumb = q('.ed-thumb.ed-thumb-state[data-index="1"]')
    if (stThumb) {
      stThumb.click()
      await frame(3)
      check('the state thumb (index 1) has the active class after click',
        stThumb.classList.contains('active'))
      await openViaDesktop()
      press('.ed-image-export-run')
      const how = await settle(20000)
      const dl = downloads[downloads.length - 1]
      check('a STATE slide exports as the current one (' + how + ')',
        how === 'closed' && downloads.length === stBefore + 1)
      const d = await dims(dl.blob)
      check('state slide export is 280x280 (got ' + d.join('x') + ')',
        d[0] === 280 && d[1] === 280)
      check('state slide filename is slide-02 (' + (dl.filename || '') + ')',
        /slide-0?2\.png$/.test(dl.filename || ''))
      check('state slide blob.type is image/png', dl.blob.type === 'image/png')
      const stateSig = new Uint8Array(await dl.blob.slice(0, 8).arrayBuffer())
      check('state slide has full 8-byte PNG signature',
        stateSig[0] === 0x89 && stateSig[1] === 0x50 && stateSig[2] === 0x4E && stateSig[3] === 0x47 &&
        stateSig[4] === 0x0D && stateSig[5] === 0x0A && stateSig[6] === 0x1A && stateSig[7] === 0x0A)
      const stPx = await pixelAt(dl.blob, 140, 140)
      const blueInk = hex(INK[1])
      check('state slide center pixel is blue (' + INK[1] + ')',
        near(stPx, blueInk[0], blueInk[1], blueInk[2], 10))
    } else {
      check('a STATE slide thumb was found at .ed-thumb.ed-thumb-state[data-index="1"]', false)
    }
  }

  // ---- encrypted deck: real password UI, warning, and immutability --------
  //
  // Proves the encryption warning through the REAL shipped UI rather than a
  // synthetic encrypted field. The flow:
  //   1. Load a clean deck and use Save > "Encrypt with password…" to set a
  //      password through the real dialog (.pw1, .pw2, .ok). This calls
  //      setEncryptionPassword() inside the kernel — isEncryptionActive() is
  //      now true. The subsequent save(true) fires but is harmless on file://.
  //   2. Open the export dialog and assert the exact warning text.
  //   3. Export and assert: exactly one new image download, no .bento.html
  //      download, doc model/docId byte-identical.
  //   4. Use Save > "Remove password" and verify the warning disappears.
  //
  // This does NOT modify production encryption/save/preview code.
  {
    load(makeDoc({ docId: 'enc-acceptance-doc' }))
    await frame(3)

    // --- step 1: set a password via the real "Encrypt with password…" item ---
    const caret1 = q('.ed-split-caret')
    caret1.focus(); caret1.click()
    await frame(3)
    const encItem = menuItems().find((b) => /Encrypt with password/i.test(b.textContent || ''))
    check('the Save dropdown carries "Encrypt with password…"', !!encItem)
    if (encItem) {
      encItem.click()
      await frame(3)
      // the password dialog is a <dialog class="ed-dialog ed-pwdialog">
      const pwDlg = document.querySelector('dialog.ed-pwdialog')
      check('the password dialog opened', !!pwDlg)
      if (pwDlg) {
        const pw1 = pwDlg.querySelector('.pw1')
        const pw2 = pwDlg.querySelector('.pw2')
        const okBtn = pwDlg.querySelector('.ok')
        pw1.value = 'test-acceptance-pw'
        pw2.value = 'test-acceptance-pw'
        // dispatch input events so any validation runs
        pw1.dispatchEvent(new Event('input', { bubbles: true }))
        pw2.dispatchEvent(new Event('input', { bubbles: true }))
        okBtn.click()
        // wait for setEncryptionPassword + save attempt + toast
        await sleep(600)
        await frame(3)
      }
    }

    const beforeJson = JSON.stringify(window.bento.doc)
    const beforeDocId = window.bento.doc.docId
    const beforeDlCount = downloads.length
    // Capture the shipped file's actual #bento-doc block — this is the splice
    // contract, and exporting must never touch it.
    const bentoDocEl = document.getElementById('bento-doc')
    const beforeDocBlock = bentoDocEl ? bentoDocEl.textContent : null

    // --- step 2: open export dialog and assert the exact warning text --------
    await openViaDesktop()
    const dlg = dialog()
    const noteEl = dlg ? dlg.querySelector('.ed-image-export-note') : null
    const noteText = noteEl ? (noteEl.textContent || '').trim() : ''
    check('encrypted deck shows the warning note element', !!noteEl)
    const exactWarning = 'Exported images and ZIP files are not password-protected. ' +
      'The original encrypted .bento.html file is not changed.'
    check('warning text is EXACTLY: "' + exactWarning + '"', noteText === exactWarning)

    // --- step 3: export and assert exactly one new image download -----------
    press('.ed-image-export-run')
    const encHow = await settle(20000)
    check('the encrypted deck export completes (' + encHow + ')', encHow === 'closed')
    const newDls = downloads.slice(beforeDlCount)
    const imageDls = newDls.filter((d) => /\.(png|jpg)$/i.test(d.filename || ''))
    const htmlDls = newDls.filter((d) => /\.bento\.html$/i.test(d.filename || ''))
    check('exactly one image download in the export phase', imageDls.length === 1)
    check('zero .bento.html downloads in the export phase', htmlDls.length === 0)

    const afterJson = JSON.stringify(window.bento.doc)
    const afterDocId = window.bento.doc.docId
    check('docId is unchanged after exporting an encrypted deck',
      afterDocId === beforeDocId && afterDocId === 'enc-acceptance-doc')
    check('the document model is byte-identical after exporting an encrypted deck',
      afterJson === beforeJson)
    // The #bento-doc block in the SHIPPED file must be untouched — it is the
    // splice contract, and modifying it would break updaters already in the field.
    // Re-query the LIVE DOM: if export replaced or duplicated the node, a stale
    // reference would hide that.
    const afterDocNodes = document.querySelectorAll('#bento-doc')
    check('exactly one #bento-doc node exists after export', afterDocNodes.length === 1)
    const afterDocBlock = afterDocNodes.length === 1 ? afterDocNodes[0].textContent : null
    check('the #bento-doc block is byte-identical after exporting an encrypted deck',
      beforeDocBlock !== null && afterDocBlock === beforeDocBlock)

    // --- step 4: Remove password and verify the warning disappears ----------
    const caret2 = q('.ed-split-caret')
    caret2.focus(); caret2.click()
    await frame(3)
    const removeItem = menuItems().find((b) => /Remove password/i.test(b.textContent || ''))
    check('the Save dropdown now shows "Remove password"', !!removeItem)
    if (removeItem) {
      removeItem.click()
      await sleep(400)
      await frame(3)
    }

    // open export dialog again — the warning should be gone
    await openViaDesktop()
    const dlg2 = dialog()
    const noteEl2 = dlg2 ? dlg2.querySelector('.ed-image-export-note') : null
    check('the encryption warning disappears after removing the password', !noteEl2)
    if (dlg2) { press('.ed-image-export-cancel'); await frame(3) }
  }

  // ---- stage the linked-resource fixture WITHOUT rendering it ------------
  //
  // The editor renders whatever it is showing, and a live <img src="http://…">
  // is the deck author's own request, not the exporter's. So the deck is loaded
  // with an EMBEDDED image (which renders and fetches nothing), and only then
  // is the model object the export will snapshot mutated in place — no commit,
  // so no re-render. Whatever the log records after this point is the
  // exporter's, and the assertion is made by the Node side around a real
  // request count.
  {
    load(makeDoc({
      slides: [{
        id: 'r1', background: '#FFFFFF', transition: 'none', notes: '', elements: [
          { id: 'r1-img', type: 'image', x: 20, y: 20, w: 100, h: 100, rotation: 0, opacity: 1,
            src: px('#3355FF', 8, 8), fit: 'fill', radius: 0 },
        ],
      }],
    }))
    await frame(4)
    await sleep(400)
    // in place, no store.commit: the canvas keeps the embedded render it has
    window.bento.doc.slides[0].elements[0].src = 'http://bento-acceptance.invalid/linked.png'
    window.__acceptanceStaged = true
  }

  // ---- the object URL is revoked, eventually ----------------------------
  note('object URLs minted: ' + downloads.length + ', revoked so far: ' + revoked)
  check('every download minted exactly one anchor click (' + clicks + '/' + downloads.length + ')',
    clicks === downloads.length)
  note('the intercepted phases prove the exact blob + filename handed to ' +
    'the anchor; the separate ZIP phase below verifies one real browser disk write')

  return { results: results, notes: notes }
} catch (err) {
  results.push(['the acceptance driver ran to the end (it threw: ' + String(err) + ')', false])
  return { results: results, notes: notes }
}
})()`

// ---------------------------------------------------------------------------

async function run(chrome: string) {
  const file = repoFile('slides/dist-single/Bento_Slides.bento.html')
  assertFreshBuild(file)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-accept-'))
  const profile = path.join(tmp, 'profile')
  const child = spawn(chrome, [
    '--headless=new', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] })

  const requests: string[] = []
  let cdp: Cdp | null = null
  const waitForExit = (timeoutMs: number) => new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return }
    const onExit = () => finish(true)
    const finish = (exited: boolean) => {
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(exited)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })
  try {
    const portFile = path.join(profile, 'DevToolsActivePort')
    const deadline = Date.now() + 30_000
    while (!fs.existsSync(portFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    if (!fs.existsSync(portFile)) throw new Error('chrome never published a devtools port')
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim()
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as
      { webSocketDebuggerUrl: string; Browser: string }
    console.log(`  browser: ${version.Browser}`)
    cdp = await connectCdp(version.webSocketDebuggerUrl)

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    cdp.on('Network.requestWillBeSent', (p) => { if (p?.request?.url) requests.push(p.request.url) })
    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Page.navigate', { url: 'file://' + file }, sessionId)

    // wait for the editor's own chrome, not merely for load
    const stop = Date.now() + 60_000
    let ready = false
    while (Date.now() < stop && !ready) {
      await new Promise((r) => setTimeout(r, 250))
      const res = await cdp.send('Runtime.evaluate', {
        expression: '!!document.querySelector(".ed-split-caret") && !!(window.bento && window.bento.loadDoc)',
        returnByValue: true,
      }, sessionId)
      ready = res?.result?.value === true
    }
    ok(ready, 'the shipped file booted its editor within 60s')
    if (!ready) return

    const desktop = await cdp.send('Runtime.evaluate', {
      expression: DRIVER, awaitPromise: true, returnByValue: true,
    }, sessionId)
    const payload = desktop?.result?.value as { results: Array<[string, boolean]>; notes: string[] } | undefined
    if (!payload) {
      ok(false, `the acceptance driver returned results (it did not: ${JSON.stringify(desktop).slice(0, 300)})`)
    } else {
      for (const line of payload.notes) console.log(`  · ${line}`)
      for (const [name, pass] of payload.results) ok(pass, name)
    }

    // --- the exporter's own network isolation ----------------------------
    //
    // The deck was staged above with an embedded image (rendered, no network)
    // and then mutated IN PLACE to a remote one without a commit, so the canvas
    // never re-rendered it. The count is taken here, immediately before the
    // export, and again immediately after the refusal: the delta is what the
    // EXPORT did, with nothing else in the window.
    const stagedRes = await cdp.send('Runtime.evaluate', {
      expression: 'window.__acceptanceStaged === true', returnByValue: true,
    }, sessionId)
    const staged = stagedRes?.result?.value === true
    ok(staged, 'the linked-resource fixture was staged without rendering it')

    if (staged) {
      const beforeCount = requests.length
      const refusal = await cdp.send('Runtime.evaluate', {
        expression: `(async () => {
          const frame = (n) => new Promise((r) => { let l = n; const s = () => (--l <= 0 ? r() : requestAnimationFrame(s)); requestAnimationFrame(s) })
          const before = window.__acceptanceDownloads.length
          const caret = document.querySelector('.ed-split-caret')
          caret.focus(); caret.click()
          await frame(3)
          const item = Array.from(document.querySelectorAll('.ed-menu .ed-btn'))
            .find((b) => /Export slides as images/i.test(b.textContent || ''))
          if (!item) return { ran: false }
          item.click()
          await frame(3)
          const run = document.querySelector('.ed-image-export-run')
          run.click()
          const stop = Date.now() + 20000
          let status = ''
          while (Date.now() < stop) {
            await new Promise((r) => setTimeout(r, 60))
            const el = document.querySelector('.ed-image-export-status')
            if (el && el.classList.contains('is-error')) { status = el.textContent || ''; break }
            if (!document.querySelector('dialog.ed-image-export')) break
          }
          const stillOpen = !!document.querySelector('dialog.ed-image-export')
          const downloads = window.__acceptanceDownloads.length - before
          const cancel = document.querySelector('.ed-image-export-cancel')
          if (cancel) cancel.click()
          await frame(3)
          return { ran: true, status: status, stillOpen: stillOpen, downloads: downloads }
        })()`,
        awaitPromise: true, returnByValue: true,
      }, sessionId)
      // let any request the export might have made actually reach the log
      await new Promise((r) => setTimeout(r, 1500))
      const afterCount = requests.length
      const during = requests.slice(beforeCount, afterCount)
      const r = refusal?.result?.value as any
      ok(!!r?.ran, 'the export ran against the staged deck')
      ok(/Slide 1/.test(r?.status ?? '') && /embed/i.test(r?.status ?? ''),
        `a LINKED image is refused with a localized sentence naming the slide (${(r?.status ?? '').slice(0, 60)})`)
      ok(r?.stillOpen === true, 'the dialog stays open so the message can be read')
      ok(r?.downloads === 0, 'and nothing was downloaded')
      console.log(`  · requests during the export window: ${during.length ? during.join(', ') : '(none)'}`)
      ok(during.length === 0,
        `the EXPORT made no request at all while refusing (${during.length} in its window)`)
    }

    // --- a positive control, so the log above is falsifiable --------------
    //
    // Without this, "no requests in the window" could equally mean the log
    // stopped working. The page asks for one URL, on purpose, and it has to
    // show up.
    const controlUrl = 'http://bento-acceptance.invalid/positive-control.png'
    await cdp.send('Runtime.evaluate', {
      expression: `new Promise((resolve) => {
        const img = new Image()
        img.onload = img.onerror = () => resolve(true)
        img.src = ${JSON.stringify(controlUrl)}
        setTimeout(() => resolve(true), 3000)
      })`,
      awaitPromise: true, returnByValue: true,
    }, sessionId)
    await new Promise((r) => setTimeout(r, 800))
    ok(requests.includes(controlUrl),
      'the CDP request log can see a request from this page (positive control)')

    // --- the compact chrome, at 320 CSS pixels ---------------------------
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 320, height: 720, deviceScaleFactor: 1, mobile: true,
    }, sessionId)
    await new Promise((r) => setTimeout(r, 1200))
    const phone = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const frame = (n) => new Promise((r) => { let l = n; const s = () => (--l <= 0 ? r() : requestAnimationFrame(s)); requestAnimationFrame(s) })
        // A CLEAN deck first: the previous phase deliberately left a staged
        // deck whose image is remote, and exporting that would (correctly)
        // refuse — which would say nothing about the compact chrome.
        const okLoad = window.bento.loadDoc(JSON.stringify({
          format: 'bento/slides', version: 1, docId: 'acceptance-phone',
          title: 'Compact', size: { width: 200, height: 200 },
          theme: { background: '#FFFFFF', color: '#1E2A3A', accent: '#F7A600', fontFamily: 'system-ui' },
          assets: {}, fonts: [],
          slides: [{ id: 'p1', background: '#FFFFFF', transition: 'none', notes: '', elements: [
            { id: 'p1-r', type: 'shape', x: 20, y: 20, w: 160, h: 160, rotation: 0, opacity: 1,
              shape: 'rect', fill: '#10B981', stroke: 'none', strokeWidth: 0, radius: 0 },
          ] }],
        }))
        if (!okLoad) return { reached: false, why: 'loadDoc refused the compact fixture' }
        await frame(4)
        // The FIRST phone-only dropdown is Insert, not More — picking [0] found
        // Insert's button and then compared focus against the wrong element.
        // Identify More by its own label, and scope the item lookup to ITS menu.
        const drops = Array.from(document.querySelectorAll('.ed-dropdown.ed-phone-only'))
        const moreDrop = drops.find((d) => {
          const b = d.querySelector('button')
          return b && /⋯|More/i.test((b.textContent || '') + ' ' + (b.title || ''))
        })
        if (!moreDrop) return { reached: false, why: 'no phone More dropdown among ' + drops.length }
        const more = moreDrop.querySelector('button')
        more.click()
        await frame(4)
        const item = Array.from(moreDrop.querySelectorAll('.ed-menu .ed-btn'))
          .find((b) => /Export slides as images/i.test(b.textContent || ''))
        if (!item) return { reached: false, why: 'item not in the More list' }
        item.click()
        await frame(4)
        const dlg = document.querySelector('dialog.ed-image-export')
        const rect = dlg ? dlg.getBoundingClientRect() : null
        const over = dlg ? Array.from(dlg.querySelectorAll('*')).filter((e) => e.scrollWidth > e.clientWidth + 1).length : -1
        const radioCount = dlg ? dlg.querySelectorAll('input[type="radio"]').length : -1
        const focusInside = !!(dlg && dlg.contains(document.activeElement))
        // a REAL compact export, not just an open-and-close
        let exported = false
        let filename = ''
        if (dlg) {
          const run = dlg.querySelector('.ed-image-export-run')
          if (run) {
            run.click()
            const stop = Date.now() + 20000
            while (Date.now() < stop && document.querySelector('dialog.ed-image-export')) {
              await new Promise((r) => setTimeout(r, 60))
            }
            exported = !document.querySelector('dialog.ed-image-export')
            const last = window.__acceptanceDownloads[window.__acceptanceDownloads.length - 1]
            filename = (last && last.filename) || ''
          }
        }
        return {
          reached: true, opened: !!dlg, overflow: over, radioCount: radioCount,
          focusInside: focusInside, exported: exported, filename: filename,
          withinViewport: !!rect && rect.left >= -1 && rect.right <= window.innerWidth + 1,
          focused: document.activeElement === more,
          closed: !document.querySelector('dialog.ed-image-export'),
        }
      })()`,
      awaitPromise: true, returnByValue: true,
    }, sessionId)
    const p = phone?.result?.value as any
    ok(!!p?.reached, `the compact ⋯ menu carries the same item (${p?.why ?? 'reached'})`)
    if (p?.reached) {
      ok(p.opened, 'and opens the dialog from the phone chrome')
      ok(p.radioCount === 6, `with all six radio choices intact (${p.radioCount})`)
      ok(p.focusInside, 'and focus inside the dialog')
      ok(p.overflow === 0, `nothing overflowing at 320 CSS pixels (${p.overflow} offenders)`)
      ok(p.withinViewport, 'and the dialog sits inside the 320px viewport')
      ok(p.exported, `a REAL export runs from the compact chrome (${p.filename})`)
      ok(/\.png$/.test(p.filename || ''), `producing a PNG (${p.filename})`)
      ok(p.focused, 'returning focus to the visible ⋯ button, not the hidden menu item')
      ok(p.closed, 'and closing cleanly')
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId)

    // --- ZIP disk verification via CDP download ----------------------------
    //
    // The blob interception above proves the JS payload. This section proves
    // the actual bytes that reach the disk by configuring CDP to download to a
    // temp directory, running a fresh all-main export, and verifying the file
    // with an independent reader (Python zipfile or system unzip).
    //
    // This proves a browser download reaches disk, but does NOT prove native OS
    // save-panel UX or tray/WebExtension writeback.
    //
    // The acceptance rig intercepts HTMLAnchorElement.prototype.click to
    // prevent real downloads. The window-scoped one-shot flag lets
    // the next download-anchor click pass through to the real handler so
    // the browser actually writes the file, then resets automatically.
    {
      const dlDir = path.join(tmp, 'zip-verify')
      fs.mkdirSync(dlDir, { recursive: true })
      try {
        await cdp.send('Browser.setDownloadBehavior', {
          behavior: 'allow', downloadPath: dlDir,
        })
      } catch {
        // Some Chrome builds do not support Browser.setDownloadBehavior on the
        // browser-level target. Fall back to Page-level, which requires session.
        await cdp.send('Page.setDownloadBehavior', {
          behavior: 'allow', downloadPath: dlDir,
        }, sessionId)
      }

      // Load a clean two-slide doc and set the one-shot flag before export
      const evalResult = await cdp.send('Runtime.evaluate', {
        expression: `(async () => {
          window.bento.loadDoc(JSON.stringify({
            format: 'bento/slides', version: 1, docId: 'zip-verify-doc',
            title: 'ZipVerify', size: { width: 200, height: 200 },
            theme: { background: '#FFFFFF', color: '#1E2A3A', accent: '#F7A600', fontFamily: 'system-ui' },
            assets: {}, fonts: [],
            slides: [
              { id: 'z1', background: '#FFFFFF', transition: 'none', notes: '', elements: [
                { id: 'z1-r', type: 'shape', x: 20, y: 20, w: 160, h: 160, rotation: 0, opacity: 1,
                  shape: 'rect', fill: '#E23D3D', stroke: 'none', strokeWidth: 0, radius: 0 } ] },
              { id: 'z2', background: '#FFFFFF', transition: 'none', notes: '', elements: [
                { id: 'z2-r', type: 'shape', x: 20, y: 20, w: 160, h: 160, rotation: 0, opacity: 1,
                  shape: 'rect', fill: '#2C6BED', stroke: 'none', strokeWidth: 0, radius: 0 } ] },
            ],
          }))
          const frame = (n) => new Promise((r) => { let l = n; const s = () => (--l <= 0 ? r() : requestAnimationFrame(s)); requestAnimationFrame(s) })
          await frame(4)
          // open export, choose all-main, export
          const caret = document.querySelector('.ed-split-caret')
          caret.focus(); caret.click()
          await frame(3)
          const item = Array.from(document.querySelectorAll('.ed-menu .ed-btn'))
            .find((b) => /Export slides as images/i.test(b.textContent || ''))
          if (!item) return false
          item.click()
          await frame(3)
          const allMainRadio = document.querySelector('input[name="scope"][value="all-main"]')
          if (allMainRadio) { allMainRadio.checked = true; allMainRadio.dispatchEvent(new Event('change', { bubbles: true })) }
          // Set the one-shot flag so the next download-anchor click passes through.
          // It lives on window because this is a separate Runtime.evaluate call
          // from the driver that installed the click hook.
          window.__acceptanceAllowRealDownload = true
          try {
            const run = document.querySelector('.ed-image-export-run')
            if (!run) return { closed: false, realDownloads: 0 }
            run.click()
            // wait for dialog to close
            const stop = Date.now() + 30000
            while (Date.now() < stop && document.querySelector('dialog.ed-image-export')) {
              await new Promise((r) => setTimeout(r, 60))
            }
            return {
              closed: !document.querySelector('dialog.ed-image-export'),
              realDownloads: window.__acceptanceRealDownloadClicks,
            }
          } finally {
            window.__acceptanceAllowRealDownload = false
          }
        })()`,
        awaitPromise: true, returnByValue: true,
      }, sessionId)

      // Assert Runtime.evaluate returned success
      const evalValue = evalResult?.result?.value as { closed?: boolean; realDownloads?: number } | undefined
      ok(evalValue?.closed === true, 'the ZIP export Runtime.evaluate returned success')
      ok(evalValue?.realDownloads === 1,
        `the shipped UI issued exactly one real download click (got ${evalValue?.realDownloads ?? 0})`)

      // Wait for the download file to appear on disk
      const dlStop = Date.now() + 15_000
      let zipFile = ''
      while (Date.now() < dlStop) {
        const files = fs.readdirSync(dlDir).filter((f: string) =>
          f.endsWith('.zip') && !f.endsWith('.crdownload'))
        if (files.length >= 1) { zipFile = path.join(dlDir, files[0]); break }
        await new Promise((r) => setTimeout(r, 200))
      }
      ok(zipFile !== '', 'exactly one ZIP file was downloaded to the temp directory')

      // After download completes: assert exactly one .zip and no stale files
      if (zipFile) {
        const finalFiles = fs.readdirSync(dlDir)
        const zips = finalFiles.filter((f: string) => f.endsWith('.zip'))
        const stale = finalFiles.filter((f: string) => f.endsWith('.crdownload'))
        ok(finalFiles.length === 1,
          `the temp directory contains exactly one file (got ${finalFiles.length})`)
        ok(zips.length === 1, `the temp directory has exactly one final .zip (got ${zips.length})`)
        ok(stale.length === 0, `no .crdownload stale files remain (got ${stale.length})`)

        // Verify with Python zipfile (available on macOS and CI) — independent reader
        const pyResult = spawnSync('python3', ['-c', [
          'import zipfile, sys, json',
          `zf = zipfile.ZipFile(${JSON.stringify(zipFile)})`,
          'names = sorted(zf.namelist())',
          'ok = zf.testzip() is None',
          'entries = []',
          'for n in names:',
          '    d = zf.read(n)',
          '    entries.append({"name": n, "size": len(d), "png": d[:4] == b"\\x89PNG"})',
          'print(json.dumps({"ok": ok, "entries": entries}))',
        ].join('\n')], { encoding: 'utf8', timeout: 10_000 })

        if (pyResult.status === 0 && pyResult.stdout) {
          try {
            const r = JSON.parse(pyResult.stdout.trim()) as {
              ok: boolean; entries: Array<{ name: string; size: number; png: boolean }>
            }
            ok(r.ok, 'the disk ZIP passes Python zipfile.testzip() — it is a valid archive')
            ok(r.entries.length === 2,
              `the disk ZIP contains exactly 2 entries (got ${r.entries.length})`)
            ok(r.entries.every((e) => e.png),
              'every entry in the disk ZIP has a PNG header')
            ok(r.entries.map((e) => e.name).join(',') === 'slide-01.png,slide-02.png',
              `entries are named in order (${r.entries.map((e) => e.name).join(',')})`)
          } catch {
            ok(false, 'the Python zipfile verification output was valid JSON')
          }
        } else {
          // Fall back to system unzip -t
          const unzipResult = spawnSync('unzip', ['-t', zipFile],
            { encoding: 'utf8', timeout: 10_000 })
          ok(unzipResult.status === 0, 'the disk ZIP passes unzip -t (system verification)')
        }
      }

      // Disable download behavior again
      try {
        await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' })
      } catch {
        await cdp.send('Page.setDownloadBehavior', { behavior: 'deny' }, sessionId)
      }
    }

    // --- the network log -------------------------------------------------
    //
    // The shipped app checks the signed release channel at launch — documented
    // behaviour, nothing to do with export. So the claim here is scoped to what
    // the EXPORT did: it must never reach for a deck's linked resource, and it
    // must add nothing else to the log.
    // An ALLOWLIST of exact URLs, matched by parsed origin and pathname rather
    // than by substring — "contains bento.page/releases" would also accept
    // https://evil.example/?x=bento.page/releases.
    const allowed = new Set([
      'https://bento.page/releases/slides/manifest.json',
      controlUrl,
    ])
    const exact = (u: string): string => {
      try {
        const parsed = new URL(u)
        return parsed.origin + parsed.pathname
      } catch { return u }
    }
    const offDoc = requests.filter((u) => /^https?:/i.test(u))
    const unexpected = offDoc.filter((u) => !allowed.has(exact(u)))
    console.log(`  · off-document requests: ${offDoc.length ? Array.from(new Set(offDoc.map(exact))).join(', ') : '(none)'}`)
    ok(unexpected.length === 0,
      'the ONLY http(s) requests in the whole session are the app\'s signed release check and ' +
      `this rig's own positive control (${Array.from(new Set(unexpected.map(exact))).join(', ') || 'nothing else'})`)
  } finally {
    try { await cdp?.send('Browser.close') } catch { /* already gone */ }
    cdp?.close()
    if (!await waitForExit(2_000)) child.kill('SIGTERM')
    if (!await waitForExit(2_000)) child.kill('SIGKILL')
    await waitForExit(5_000)
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) } catch { /* harmless */ }
  }
}

console.log('\nslide image export — acceptance against the SHIPPED file')
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
