#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A file another program changed: the banner, "Load the version on disk" and
// "Keep mine", in the packaged document with REAL file handles.
//
//   npm run build:single --prefix slides && node scripts/test-slides-disk-change-browser.mjs
//
// The kernel refuses every write through the held handle once another program
// changed the file since we last read or wrote it (scripts/test-disk-change*
// prove that half). This proves what slides does with the refusal:
//   1. auto-save writes through the handle (positive control: the handle is held);
//   2. an outside edit, then an edit here: the banner appears, the file keeps the
//      other program's text, and further auto-saves neither write nor flash
//      "Backed up in this browser";
//   3. ⌘S with the banner up says "Not saved" and writes nothing;
//   4. Load: the deck becomes the disk version, not dirty, the edits are in
//      Version history, the file is not rewritten, and ⌘Z brings the edits back
//      (and, writing resumed, the next auto-save writes them);
//   5. Keep mine: one deliberate overwrite, then tracking resumes — the next
//      outside edit brings the banner back and is not overwritten;
//   6. a version on disk that another program put a password on goes through
//      the password: a wrong one is refused, the right one loads it, and later
//      saves stay encrypted with it.
//
// The handle comes in through `launchQueue`, the seam a native host and an
// installed app use (kernel consumeLaunchQueue); the file is in the
// origin-private file system, the same FileSystemFileHandle type a picker
// returns, and a second handle to it plays the other program. Every request
// off the test origin is refused and every socket closed.

const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
import { readFileSync } from 'node:fs'

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

const SHELL = readFileSync(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url), 'utf8')
const ORIGIN = 'https://disk-change.test'
const FILE = 'deck.bento.html'
let deckHtml = SHELL

const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH })
try {
  const context = await browser.newContext()
  await context.routeWebSocket(/.*/, (ws) => ws.close())
  await context.route('**/*', (r) => {
    const u = new URL(r.request().url())
    if (u.origin !== ORIGIN) return r.abort()
    return r.fulfill({ contentType: 'text/html', body: u.pathname === `/${FILE}` ? deckHtml : SHELL })
  })
  // The host's launchQueue, handing the page the OPFS file it was opened from.
  await context.addInitScript((name) => {
    if (!location.pathname.endsWith('/' + name)) return
    Object.defineProperty(window, 'launchQueue', {
      configurable: true,
      value: {
        setConsumer(fn) {
          navigator.storage.getDirectory()
            .then((root) => root.getFileHandle(name))
            .then((h) => fn({ files: [h] }))
        },
      },
    })
  }, FILE)

  // A saved deck to open: the shell with a document in it.
  const maker = await context.newPage()
  await maker.goto(`${ORIGIN}/new.bento.html`)
  await maker.waitForFunction(() => window.bento?.doc && window.bento.loadDoc)
  deckHtml = await maker.evaluate(async (name) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.title = 'Opened title'
    window.bento.loadDoc(JSON.stringify(d))
    const html = window.bento.serialize()
    const root = await navigator.storage.getDirectory()
    const h = await root.getFileHandle(name, { create: true })
    const w = await h.createWritable(); await w.write(html); await w.close()
    return html
  }, FILE)
  await maker.close()

  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const dialogs = []
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss() })
  await page.goto(`${ORIGIN}/${FILE}`)
  await page.waitForFunction(() => window.bento?.doc?.title === 'Opened title' && document.querySelector('.ed-topbar'))
  await page.waitForTimeout(300) // the launch consumer reads the file

  // In-page helpers: the file as it is, the other program's write, an edit.
  await page.evaluate((name) => {
    const fh = async () => (await navigator.storage.getDirectory()).getFileHandle(name)
    // every flash beside the title, as it is shown (one sample could miss it)
    window.__flashes = []
    new MutationObserver(() => {
      const f = document.querySelector('.ed-autosaved.show')
      if (f && window.__flashes.at(-1) !== f.textContent) window.__flashes.push(f.textContent)
      if (!f) window.__flashes.push('')
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'], characterData: true })
    window.__rig = {
      async disk() { const f = await (await fh()).getFile(); return { text: await f.text(), at: f.lastModified } },
      async outside(text) { const w = await (await fh()).createWritable(); await w.write(text); await w.close() },
      title(text) {
        const m = text.match(/<script[^>]*id="bento-doc"[^>]*>([\s\S]*?)<\/script>/)
        if (!m) return null
        try { return JSON.parse(m[1]).title ?? JSON.parse(m[1]).format ?? null } catch { return null }
      },
      edit(title) { const d = JSON.parse(JSON.stringify(window.bento.doc)); d.title = title; window.bento.loadDoc(JSON.stringify(d)) },
    }
  }, FILE)
  const disk = () => page.evaluate(async () => { const d = await window.__rig.disk(); return { ...d, title: window.__rig.title(d.text) } })
  const edit = (title) => page.evaluate((t) => window.__rig.edit(t), title)
  const waitDiskTitle = async (title, ms = 7000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { if ((await disk()).title === title) return true; await page.waitForTimeout(150) }
    return false
  }
  const banner = () => page.evaluate(() => {
    const b = document.querySelector('.ed-disk-changed')
    return b ? { text: b.textContent, load: !!b.querySelector('.ed-disk-load'), keep: !!b.querySelector('.ed-disk-keep') } : null
  })
  const waitBanner = (on, ms = 7000) => page.waitForFunction((want) => !!document.querySelector('.ed-disk-changed') === want, on, { timeout: ms }).then(() => true, () => false)
  // a missing button is a failed check, not a 30 s timeout that ends the run
  const press = async (sel, what) => {
    const there = await page.waitForSelector(sel, { timeout: 3000 }).then(() => true, () => false)
    ok(there, `${what} is there to press`)
    if (there) await page.click(sel)
  }
  const flashes = () => page.evaluate(() => window.__flashes.slice())
  const toastText = () => page.evaluate(() => document.querySelector('.ed-toast')?.textContent ?? '')
  const dirty = () => page.evaluate(() => !!document.querySelector('.ed-dirty.on'))
  const swapTitle = (from, to) => `(t) => t.split(${JSON.stringify(JSON.stringify(from))}).join(${JSON.stringify(JSON.stringify(to))})`

  console.log('1. auto-save writes through the launched handle')
  await edit('Mine one')
  ok(await waitDiskTitle('Mine one'), 'an edit reaches the file by auto-save (the handle is held)')
  await page.waitForTimeout(200)
  ok((await flashes()).includes('Saved'), 'and flashes Saved (the flash recorder works)')

  console.log('2. an outside edit stops writing and shows the banner')
  await page.waitForTimeout(100)
  await page.evaluate(async (src) => { const d = await window.__rig.disk(); await window.__rig.outside((0, eval)(src)(d.text)) }, swapTitle('Mine one', 'Outside one'))
  ok((await disk()).title === 'Outside one', 'the other program wrote the file')
  await page.waitForFunction(() => !document.querySelector('.ed-autosaved.show')) // step 1's has faded
  await page.evaluate(() => { window.__flashes = [] })
  await edit('Mine two')
  ok(await waitBanner(true), 'the banner appears on the next save')
  const b = await banner()
  ok(b && /deck\.bento\.html was changed by another program/.test(b.text) && b.load && b.keep, `it names the file and offers both choices (${b?.text})`)
  ok((await disk()).title === 'Outside one', 'the other program’s edit is still on disk')
  await edit('Mine three')
  await page.waitForTimeout(3600)
  ok((await disk()).title === 'Outside one', 'a later auto-save writes nothing')
  const fl = (await flashes()).filter(Boolean)
  ok(fl.length === 0, `no "Saved" or "Backed up in this browser" flash beside the banner (${JSON.stringify(fl)})`)

  ok(await dirty(), 'the deck shows unsaved changes')

  console.log('3. ⌘S with the banner up')
  await page.keyboard.press('Control+s')
  await page.waitForTimeout(500)
  const st = await toastText()
  ok(/^Not saved — deck\.bento\.html was changed by another program/.test(st), `⌘S says why it did not save (${JSON.stringify(st)})`)
  ok(!!(await banner()), 'the banner is still up')
  ok((await disk()).title === 'Outside one', 'and nothing was written')

  console.log('4. Load the version on disk')
  const before = await disk()
  await press('.ed-disk-load', 'Load the version on disk')
  ok(await waitBanner(false), 'the banner goes')
  ok(await page.evaluate(() => window.bento.doc.title) === 'Outside one', 'the deck is the version on disk')
  const lt = await toastText()
  ok(lt === 'Loaded the version on disk — your edits are in Version history', `the toast says where the edits went (${JSON.stringify(lt)})`)
  ok(!(await dirty()), 'the deck is not dirty')
  await page.waitForTimeout(3600)
  const after = await disk()
  ok(after.at === before.at && after.text === before.text, 'the file is not rewritten after loading it')
  await page.evaluate(() => window.bento.undo())
  ok(await page.evaluate(() => window.bento.doc.title) === 'Mine three', '⌘Z brings the edits back')
  ok(await waitDiskTitle('Mine three'), 'writing resumed: the undone-to edits reach the file')

  console.log('5. Keep mine')
  await page.waitForTimeout(100)
  await page.evaluate(async (src) => { const d = await window.__rig.disk(); await window.__rig.outside((0, eval)(src)(d.text)) }, swapTitle('Mine three', 'Outside two'))
  await edit('Mine four')
  ok(await waitBanner(true), 'a second outside edit brings the banner back')
  ok((await disk()).title === 'Outside two', 'not overwritten')
  await press('.ed-disk-keep', 'Keep mine')
  ok(await waitDiskTitle('Mine four', 4000), 'Keep mine writes this deck over the file')
  ok(!(await banner()), 'the banner goes')
  ok(await toastText() === 'Saved', `and says Saved (${JSON.stringify(await toastText())})`)
  await page.waitForTimeout(100)
  await page.evaluate(async (src) => { const d = await window.__rig.disk(); await window.__rig.outside((0, eval)(src)(d.text)) }, swapTitle('Mine four', 'Outside three'))
  await edit('Mine five')
  ok(await waitBanner(true), 'tracking resumed: the next outside edit is caught')
  ok((await disk()).title === 'Outside three', 'and is not overwritten — Keep mine wrote once')

  console.log('6. a version on disk with a password')
  // the other program loads the file and sets a password on it
  await page.evaluate(async () => {
    const d = await window.__rig.disk()
    const m = d.text.match(/(<script[^>]*id="bento-doc"[^>]*>)([\s\S]*?)(<\/script>)/)
    const doc = JSON.parse(m[2]); doc.title = 'Locked outside'
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12))
    const mat = await crypto.subtle.importKey('raw', new TextEncoder().encode('right horse'), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000 }, mat, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(doc))))
    const b64 = (u) => { let s = ''; for (const c of u) s += String.fromCharCode(c); return btoa(s) }
    const env = JSON.stringify({ format: 'bento/enc', v: 1, it: 1000, salt: b64(salt), iv: b64(iv), data: b64(ct) })
    await window.__rig.outside(d.text.replace(m[0], () => m[1] + env + m[3]))
  })
  ok((await disk()).title === 'bento/enc', 'the file on disk is now password-protected')
  await press('.ed-disk-load', 'Load the version on disk')
  const asked = await page.waitForSelector('dialog.ed-disk-pw[open]', { timeout: 3000 }).then(() => true, () => false)
  ok(asked, 'Load asks for the file’s password')
  if (asked) {
    await page.fill('dialog.ed-disk-pw input', 'wrong horse')
    await page.click('dialog.ed-disk-pw .ok')
    await page.waitForFunction(() => document.querySelector('dialog.ed-disk-pw .ed-pwerr')?.textContent, null, { timeout: 5000 }).catch(() => {})
    ok(/Wrong password/.test(await page.evaluate(() => document.querySelector('dialog.ed-disk-pw .ed-pwerr')?.textContent ?? '')), 'a wrong password is refused')
    ok(await page.evaluate(() => window.bento.doc.title) === 'Mine five', 'and loads nothing')
    await page.fill('dialog.ed-disk-pw input', 'right horse')
    await page.click('dialog.ed-disk-pw .ok')
    ok(await waitBanner(false), 'the right one loads it')
    ok(await page.evaluate(() => window.bento.doc.title) === 'Locked outside', 'the deck is the decrypted version on disk')
    await edit('Mine six')
    const end = Date.now() + 7000
    let saved = null
    while (Date.now() < end) {
      const d = await disk()
      if (d.at !== null && d.title === 'bento/enc') {
        saved = await page.evaluate(async () => {
          const d = await window.__rig.disk()
          const env = JSON.parse(d.text.match(/<script[^>]*id="bento-doc"[^>]*>([\s\S]*?)<\/script>/)[1])
          const u = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
          const mat = await crypto.subtle.importKey('raw', new TextEncoder().encode('right horse'), 'PBKDF2', false, ['deriveKey'])
          const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: u(env.salt), iterations: env.it }, mat, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
          try { return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u(env.iv) }, key, u(env.data)))).title } catch { return null }
        })
        if (saved === 'Mine six') break
      }
      await page.waitForTimeout(200)
    }
    ok(saved === 'Mine six', `the next save is encrypted with that password (${saved})`)
  }

  ok(dialogs.length === 0, `no alert or confirm along the way (${dialogs.join(' | ')})`)
  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`)
} finally {
  await browser.close()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
