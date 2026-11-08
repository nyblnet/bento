// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The saved document's layout through the real slides app (kernel docText).
//
//   npm run build:single --prefix slides && node scripts/test-slides-doc-layout-browser.mjs
//
// 1. A deck with a picture saves (window.bento.serialize — the same path as ⌘S)
//    as the document on one line and the picture data on the LAST line,
//    starting "assets":; it parses back to the same document; once the picture
//    is gone the save is a single line again (the asset is pruned). An asset
//    VALUE holding a literal </script> and <!-- is still escaped on that line
//    (serializeBody <-escapes the whole body after the layout): the block ends
//    where it should, the value reads back exactly, and the conformance gate
//    passes. Mutant: drop that escape in kernel/src/save.ts and four rows fail.
// 2. Reopening never shows a phantom Restore banner. Moving `assets` last
//    changes the document's key order between the copy recovery keeps (the
//    deck as it was in memory) and the file a save writes. A deck written the
//    OLD way (one line, assets mid-document) is opened from disk, edited and
//    saved (a download, as on every browser without in-place writes); the
//    recovery store then holds the saved deck with its keys in the old order,
//    and the saved file has them in the new one. Opening the saved file must
//    not offer to restore. Control: an edit that was NOT saved still brings
//    the banner up on the next open, so the absence above is a real answer.
// 3. The release conformance gate (scripts/shell-gate.mjs, what release.mjs
//    runs before signing) passes on that saved deck, picture line included.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gateShell } from './shell-gate.mjs'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg, detail) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`) } else console.log(`  ok    ${msg}`)
}
const SHELL = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
// `type` before `id`: the order the restore gate (slides/src/restoregate.ts)
// rebuilds an element in. slides' recovery key compares nested objects in key
// order, so an element stored `id` first already raises a Restore banner on
// reopen without this change — a separate issue, kept out of this rig so that
// what it measures is where `assets` sits and nothing else.
const DOC = {
  format: 'bento/slides', version: 1, title: 'layout rig', size: { width: 1280, height: 720 },
  theme: { background: '#ffffff', color: '#111111', accent: '#ff9e8a', fontFamily: 'system-ui, sans-serif' },
  assets: { pic: PNG },
  slides: [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: [
    { type: 'image', id: 'img', x: 100, y: 100, w: 200, h: 200, rotation: 0, opacity: 1, src: 'asset:pic', fit: 'cover', radius: 0 },
  ] }],
}
const block = (html) => html.match(/<script type="application\/bento\+json" id="bento-doc">([\s\S]*?)<\/script>/)[1].trim()

const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(SHELL)
await page.waitForFunction(() => !!window.bento?.loadDoc)
await page.evaluate((j) => window.bento.loadDoc(j), JSON.stringify(DOC))

const withPic = block(await page.evaluate(() => window.bento.serialize()))
const lines = withPic.split('\n')
ok(lines.length === 2 && lines[1].startsWith('"assets":') && lines[1].includes(PNG.slice(30)), `a deck with a picture: the picture data is its own LAST line (${lines.map((l) => l.length).join(' + ')} chars)`)
ok(!lines[0].includes(PNG.slice(30)) && lines[0].includes('"slides"'), 'line 1 is the document, with no picture data in it')
const parsed = JSON.parse(withPic)
ok(parsed.assets?.pic === PNG && parsed.slides?.[0]?.elements?.[0]?.src === 'asset:pic' && Object.keys(parsed).pop() === 'assets', 'it parses back to the document, assets last')

await page.evaluate(() => { window.bento.doc.slides[0].elements = [] })
const without = block(await page.evaluate(() => window.bento.serialize()))
ok(without.split('\n').length === 1 && !('assets' in JSON.parse(without)), 'with the picture gone, the save is one line again')

// An asset VALUE that spells out the end of the block. docText puts it on the
// second line; the save must still escape it (serializeBody <-escapes the whole
// body after the layout), or the browser's parser would end #bento-doc at it.
const SCRIPT_END = '</scr' + 'ipt>'
const HOSTILE = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"><script>1' + SCRIPT_END + '<!--<script></svg>'
await page.evaluate((h) => {
  window.bento.doc.assets = { ...(window.bento.doc.assets ?? {}), evil: h }
  window.bento.doc.slides[0].elements = [{ type: 'image', id: 'evil', x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1, src: 'asset:evil', fit: 'cover', radius: 0 }]
}, HOSTILE)
const hostileFile = await page.evaluate(() => window.bento.serialize())
const hostileBlock = block(hostileFile)
let hostileDoc = null
try { hostileDoc = JSON.parse(hostileBlock) } catch {}
// the same deck with a harmless value in that slot: the script-close count to match
await page.evaluate((png) => { window.bento.doc.assets.evil = png }, PNG)
const shellEnds = (await page.evaluate(() => window.bento.serialize())).split(SCRIPT_END).length
await page.evaluate((h) => { window.bento.doc.assets.evil = h }, HOSTILE)
ok(hostileDoc?.assets?.evil === HOSTILE && hostileBlock.split('\n').at(-1).startsWith('"assets":') && !hostileBlock.includes('<'),
  'an asset value containing a literal </script> and <!-- is escaped on its line: the block ends where it should and parses back to the exact value')
ok(hostileFile.split(SCRIPT_END).length === shellEnds, `the saved file has exactly as many script-close tags as the same deck with a plain picture (${hostileFile.split(SCRIPT_END).length - 1})`)
const reparsed = await page.evaluate((html) => new DOMParser().parseFromString(html, 'text/html').getElementById('bento-doc')?.textContent ?? '', hostileFile)
let reparsedDoc = null
try { reparsedDoc = JSON.parse(reparsed) } catch {}
ok(reparsedDoc?.assets?.evil === HOSTILE, 'a browser parsing the saved file reads the same asset value back')
let hostileGate = null
const hostilePath = join(mkdtempSync(join(tmpdir(), 'bento-doc-layout-')), 'hostile.bento.html')
writeFileSync(hostilePath, hostileFile)
try { gateShell(hostilePath) } catch (e) { hostileGate = e.message }
ok(hostileGate === null, 'the release conformance gate passes on it', hostileGate)

ok(errors.length === 0, 'no page errors', errors)
await page.close()

console.log('\nreopening a saved deck with a picture\n')
const SCRIPT_CLOSE = '</scr' + 'ipt>'
const DOC_OPEN = '<script type="application/bento+json" id="bento-doc">'
const DOC_RE = /<script type="application\/bento\+json" id="bento-doc">[\s\S]*?<\/script>/
const shell = readFileSync(fileURLToPath(SHELL), 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'bento-doc-layout-'))
const SAVE = process.platform === 'darwin' ? 'Meta+s' : 'Control+s'
// the OLD layout: one line, `assets` wherever its key falls (here, before the slides)
const docId = crypto.randomUUID()
const { slides, ...head } = DOC
const oldFile = join(dir, 'old-layout.bento.html')
writeFileSync(oldFile, shell.replace(DOC_RE, () => `${DOC_OPEN}\n${JSON.stringify({ ...head, docId, slides }).replace(/</g, '\\u003c')}\n${SCRIPT_CLOSE}`))
ok(block(readFileSync(oldFile, 'utf8')).split('\n').length === 1 && Object.keys(JSON.parse(block(readFileSync(oldFile, 'utf8')))).indexOf('assets') < Object.keys(DOC).length - 1,
  'the deck on disk is in the old layout: one line, assets mid-document')

const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true })
await ctx.route(/^https?:/, (r) => r.abort())
// no save picker (so ⌘S downloads), and the one-time "can't rewrite in place" notice
// already seen: it shares the Restore banner's .ed-recover strip
await ctx.addInitScript(() => { delete window.showSaveFilePicker; try { localStorage.setItem('bento-slideshow-started', '1'); localStorage.setItem('bento-save-notice', 'seen') } catch {} })
const pageErrors = []
async function openFile(file) {
  const p = await ctx.newPage()
  p.on('pageerror', (e) => pageErrors.push(String(e)))
  p.on('dialog', (d) => d.dismiss())
  await p.goto('file://' + file)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-topbar .ed-title'))
  await p.waitForTimeout(400)
  return p
}
const retitle = async (p, title) => {
  await p.locator('.ed-topbar .ed-title').fill(title)
  await p.locator('.ed-topbar .ed-title').press('Enter')
  await p.waitForFunction((t) => window.bento.doc.title === t, title)
}
// the recovery copy kept for this deck (IndexedDB, keyed by docId)
const recovered = (p) => p.evaluate(async (id) => {
  for (const { name } of await indexedDB.databases()) {
    const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const found = Array.from(db.objectStoreNames).includes('recovery')
      ? await new Promise((res) => { const r = db.transaction('recovery').objectStore('recovery').getAll(); r.onsuccess = () => res(r.result.find((s) => s.docId === id) ?? null); r.onerror = () => res(null) })
      : null
    db.close()
    if (found) return found.json
  }
  return null
}, docId)
// the Restore banner (its Restore button), given boot's recovery check time to run (the control shows it does, inside this wait)
const bannerShown = async (p) => {
  await p.waitForTimeout(2500)
  return p.evaluate(() => [...document.querySelectorAll('.ed-recover button')].some((b) => /^Restore/.test(b.textContent ?? '')))
}

const MARK = 'layout rig, edited ' + Date.now()
const first = await openFile(oldFile)
await retitle(first, MARK)
await first.waitForTimeout(3500) // past the 2.5 s auto-save debounce
const dl = first.waitForEvent('download', { timeout: 15000 }).catch(() => null)
await first.keyboard.press(SAVE)
const download = await dl
const savedFile = join(dir, 'saved.bento.html')
if (download) await download.saveAs(savedFile)
ok(!!download, 'the edit was saved (a download: no in-place write in this browser)')
await first.waitForTimeout(1200) // the save's recovery baseline is written when idle
await first.close()

const saved = download ? block(readFileSync(savedFile, 'utf8')) : ''
const fileKeys = saved ? Object.keys(JSON.parse(saved)) : []
ok(saved.split('\n').length === 2 && fileKeys.at(-1) === 'assets' && JSON.parse(saved).title === MARK, 'the saved file is in the new layout, assets last, with the edit')
const second = await openFile(savedFile)
const snap = await recovered(second)
const snapKeys = snap ? Object.keys(JSON.parse(snap)) : []
ok(!!snap && JSON.parse(snap).title === MARK, 'opening it, the recovery store holds this deck with the same edit')
ok(snapKeys.join() !== fileKeys.join() && snapKeys.at(-1) !== 'assets',
  `and with its keys in a different order from the file's — the case under test (recovery: …${snapKeys.slice(-3).join(', ')}; file: …${fileKeys.slice(-3).join(', ')})`)
ok(!(await bannerShown(second)), 'no Restore banner: the reopened deck is not mistaken for a changed one')

const UNSAVED = 'layout rig, not saved ' + Date.now()
await retitle(second, UNSAVED)
await second.waitForTimeout(3500)
await second.close()
const third = await openFile(savedFile)
ok(await bannerShown(third), 'control: an edit that was not saved does bring the banner up on the next open')
await third.close()
ok(pageErrors.length === 0, 'no page errors', pageErrors)
await ctx.close()

console.log('\nthe release conformance gate on the saved deck\n')
let gateError = null
try { if (download) gateShell(savedFile); else gateError = 'no saved deck' } catch (e) { gateError = e.message }
ok(gateError === null, 'scripts/shell-gate.mjs passes on a deck saved with its picture data on its own line', gateError)

await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
