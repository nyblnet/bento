#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/home — the scripted half of the pre-release QA pass.
//
//   node scripts/qa-webext-packed.mjs            # CHROME_PATH to pick a build
//
// WHAT THIS IS. Not a CI rig. It checks the thing the store would ship: it runs
// the PACKAGE (scripts/pack-webext.mjs → dist/bento-home-<v>.zip, unzipped
// as-is), not the source tree, in a FRESH profile — so a file the pack step
// left out, a string missing from a catalogue, or a page that throws on first
// load shows up here and not in a reviewer's hands.
//
// WHAT IT CHECKS
//   1. the service worker starts, with no errors
//   2. every extension page opens with no errors and no untranslated text,
//      and is screenshotted for a human to look at
//   3. (file access OFF — the store-install state — is manual; see below)
//   4. with file access on: a document gets the bridge with every op, and the
//      library lists it once opened
//   5. ⌘S with nothing granted opens the one-time offer window
//   6. "Save a copy" inside a click opens the save-as window, and Cancel
//      reaches the page as AbortError; outside a click, no window
//
// WHAT IT CANNOT CHECK (the manual half — see the store-listing draft's QA list):
// the file-access-off onboarding (see "THE FRESH-INSTALL STATE"); any OS file picker (granting a folder, choosing a file), so saving in place,
// the blocked-folder path and lapsed grants; the assistant against real
// providers; a store install's update silence (an unpacked load is
// installType 'development'); Windows.
//
// Branded Google Chrome ignores --load-extension since 137; use Chrome for
// Testing or Chromium (CHROME_PATH), or the newest build in ~/.cache/puppeteer.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const base = join(homedir(), '.cache/puppeteer/chrome')
  if (!existsSync(base)) return undefined
  const builds = readdirSync(base).sort().reverse()
  for (const b of builds) {
    for (const p of [
      `chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
      `chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
      'chrome-linux64/chrome', 'chrome-win64/chrome.exe',
    ]) if (existsSync(join(base, b, p))) return join(base, b, p)
  }
  return undefined
}

let failures = 0
let checks = 0
const ok = (cond, msg) => {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

// ---- the package, as shipped ------------------------------------------------
console.log('\n— the package')
execFileSync('node', [join(root, 'scripts/pack-webext.mjs')], { stdio: 'pipe' })
const zips = readdirSync(join(root, 'dist')).filter((f) => /^bento-home-.*\.zip$/.test(f)).sort()
const zip = join(root, 'dist', zips.at(-1))
const work = mkdtempSync(join(tmpdir(), 'bento-home-qa-'))
const ext = join(work, 'ext')
mkdirSync(ext)
execFileSync('unzip', ['-q', zip, '-d', ext])
ok(existsSync(join(ext, 'manifest.json')), `unzipped ${zips.at(-1)}`)
const shots = join(work, 'screens')
mkdirSync(shots)

// a document to open: the bridge matches *.bento.html; the runtime gate needs ≥1.0.15
const docDir = join(work, 'Decks')
mkdirSync(docDir)
const docPath = join(docDir, 'QA deck.bento.html')
writeFileSync(docPath, `<!doctype html><meta charset="utf-8"><title>QA deck</title>
<script>window.__bentoRuntime = '9.9.9'</script>
<button id="copy">Save a copy</button><button id="doc">Save</button><pre id="out"></pre>
<script>
  const out = (s) => { document.getElementById('out').textContent = s }
  document.getElementById('copy').onclick = () => window.showSaveFilePicker({ id: 'bento-copy', suggestedName: 'QA deck.bento.html' })
    .then((h) => out('handle ' + h.name), (e) => out('error ' + e.name))
  document.getElementById('doc').onclick = () => window.showSaveFilePicker({ id: 'bento-doc', suggestedName: 'QA deck.bento.html' })
    .then((h) => out('handle ' + h.name), (e) => out('error ' + e.name))
</script>`)
const docUrl = 'file://' + docPath.split('/').map(encodeURIComponent).join('/')

// ---- a fresh profile ----------------------------------------------------------
const ctx = await chromium.launchPersistentContext(join(work, 'profile'), {
  executablePath: chromePath(),
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
})
const errors = []
ctx.on('weberror', (e) => errors.push(String(e.error())))

console.log('\n— the service worker')
let [sw] = ctx.serviceWorkers()
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null)
ok(!!sw, 'starts')
const id = sw ? new URL(sw.url()).host : ''
const swErrors = []
sw?.on('console', (m) => { if (m.type() === 'error') swErrors.push(m.text()) })

console.log('\n— every extension page')
const pages = ['src/home.html', 'src/panel.html', 'src/consent.html?doc=x&host=example&model=m&nonce=n',
  'src/filegrant.html?path=/Users/you/Decks/QA%20deck.bento.html&token=t', 'src/saveas.html?token=none']
for (const p of pages) {
  // pages belong to features; a build without one simply does not ship it
  if (!existsSync(join(ext, p.split('?')[0]))) { console.log(`  info  ${p.split('?')[0]} not in this build`); continue }
  const page = await ctx.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  page.on('console', (m) => {
    // the library PROBES file:// paths to find folders (place.js); a miss is
    // the expected answer, which Chrome logs as a failed load
    if (m.type() === 'error' && !(m.location()?.url ?? '').startsWith('file://')) pageErrors.push(`${m.text()} @ ${m.location()?.url ?? ''}`)
  })
  await page.goto(`chrome-extension://${id}/${p}`)
  await page.waitForTimeout(800)
  const text = await page.evaluate(() => document.body.innerText)
  const empty = await page.evaluate(() => [...document.querySelectorAll('[data-i18n]')].filter((e) => !e.textContent.trim() && !e.hidden && !e.closest('[hidden]')).map((e) => e.dataset.i18n))
  const name = p.split('?')[0].split('/').pop()
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true })
  ok(pageErrors.length === 0, `${name}: no errors${pageErrors.length ? ` — ${pageErrors.slice(0, 2).join(' | ')}` : ''}`)
  ok(!/__MSG_|\$\d/.test(text) && empty.length === 0, `${name}: every string translated${empty.length ? ` — empty: ${empty.join(', ')}` : ''}`)
  await page.close()
}

// THE FRESH-INSTALL STATE (file access OFF) is not reachable here: a
// command-line-loaded extension starts with it ON, and switching it through
// chrome://extensions reloads the extension, which Chrome then disables as an
// unsupported developer extension (measured, Chrome for Testing 154). The
// onboarding for it stays on the manual list: a store-style install.

console.log('\n— file access on')
{
  const page = await ctx.newPage()
  await page.goto(docUrl)
  await page.waitForTimeout(800)
  const ops = await page.evaluate(() => window.__bentoHost?.ops ?? null)
  ok(Array.isArray(ops), `a document now gets the bridge (ops: ${ops?.join(', ')})`)
  for (const op of ['claim', 'write', 'backup', 'saveas']) ok(ops?.includes(op), `bridge op ${op}`)
  if (ops) {
    // the build under test decides whether these exist; report, never fail
    for (const op of ['assistant', 'store']) console.log(`  info  bridge op ${op}: ${ops.includes(op) ? 'present' : 'absent in this build'}`)
  }

  console.log('\n— save-as, from inside a click')
  const waitWin = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null)
  await page.click('#copy')
  const win = await waitWin
  await win?.waitForURL(/saveas\.html/, { timeout: 5000 }).catch(() => {})
  ok(!!win && /saveas\.html/.test(win.url()), 'Save a copy opens the extension\'s save-as window')
  if (win) {
    await win.waitForLoadState()
    await win.waitForTimeout(600)
    await win.screenshot({ path: join(shots, 'saveas-window.png') })
    const title = await win.evaluate(() => document.getElementById('title')?.textContent)
    ok(title === 'Save a copy', `titled "${title}"`)
    ok(await win.evaluate(() => document.getElementById('beside').hidden), 'no "Save next to" without a folder grant (the picker is the only way)')
    await win.click('#cancel')
    await page.waitForFunction(() => document.getElementById('out').textContent !== '', null, { timeout: 5000 }).catch(() => {})
    ok((await page.textContent('#out')) === 'error AbortError', 'Cancel reaches the page as AbortError (save.ts: cancelled)')
  }
  // outside a click: no window
  // (the browser's own picker then refuses for want of a gesture; nothing to await)
  let stray = null
  const onPage = (p) => { stray = p }
  ctx.on('page', onPage)
  const probe = await ctx.newPage()
  await probe.goto(docUrl)
  await probe.waitForTimeout(500)
  // Playwright's evaluate runs AS a user gesture, so the call is made from a
  // timer after Chrome's transient activation (5s) has run out
  await probe.evaluate(() => { setTimeout(() => { window.__qaActive = navigator.userActivation.isActive; window.showSaveFilePicker({ id: 'bento-copy', suggestedName: 'x.bento.html' }).catch(() => {}) }, 6000) })
  await new Promise((r) => setTimeout(r, 8000))
  ok(await probe.evaluate(() => window.__qaActive === false), 'the page really had no activation when it asked')
  ctx.off('page', onPage)
  ok(!stray || !/saveas\.html/.test(stray.url()), 'with no click in progress, no extension window opens')
  await probe.close().catch(() => {})

  console.log('\n— ⌘S with nothing granted')
  const waitOffer = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null)
  await page.click('#doc')
  const offer = await waitOffer
  await offer?.waitForURL(/filegrant\.html/, { timeout: 5000 }).catch(() => {})
  ok(!!offer && /filegrant\.html/.test(offer.url()), 'opens the one-time offer window')
  if (offer) {
    await offer.waitForLoadState()
    await offer.waitForTimeout(600)
    await offer.screenshot({ path: join(shots, 'offer-window.png') })
    ok(/QA deck/.test(await offer.evaluate(() => document.body.innerText)), 'naming the document')
    await offer.close()
  }
  await page.close()

  console.log('\n— the library remembers what was opened')
  const lib = await ctx.newPage()
  await lib.goto(`chrome-extension://${id}/src/home.html`)
  await lib.waitForTimeout(1200)
  ok(/QA deck/.test(await lib.evaluate(() => document.body.innerText)), 'the opened document is listed')
  await lib.screenshot({ path: join(shots, 'library.png'), fullPage: true })
  await lib.close()
}

ok(swErrors.length === 0, `the service worker logged no errors${swErrors.length ? ` — ${swErrors.slice(0, 2).join(' | ')}` : ''}`)
ok(errors.length === 0, `no uncaught errors anywhere${errors.length ? ` — ${errors.slice(0, 2).join(' | ')}` : ''}`)
await ctx.close()

console.log(`\nscreenshots: ${shots}`)
console.log(`${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
