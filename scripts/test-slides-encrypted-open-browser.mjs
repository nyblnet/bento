// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A password-protected deck opens: one gate, no failure card, and the password unlocks it.
//
//   npm run build:single --prefix slides && node scripts/test-slides-encrypted-open-browser.mjs
//
// WHAT THIS PROVES, in the packaged document. The shell's loader (#495,
// scripts/postbuild-compress.mjs) runs the app through a cascade of paths and
// decides each one worked by reading `window.bento` the moment it returns. An
// encrypted deck's app is then waiting at its password gate and had published
// nothing, so every path read as refused: the app ran once per path (three
// password cards) and the loader painted "every loader path was refused" over
// all of them. Released slides 1.2.4–1.2.8 could not open a password-protected
// deck (measured on 1.2.8, Chromium and WebKit). Now the app publishes
// `{ format, locked: true }` before its gate and the loader counts `locked` as
// mounted. Checked here, on a deck encrypted through the real UI and saved:
//   1. opening it shows exactly ONE gate, no failure card, and window.bento is
//      the locked stub; the loader stopped at its first path;
//   2. a wrong password keeps the one gate and says so; the right one boots the
//      editor with the deck's slides and no gate left;
//   3. the same when only the LAST path (the blob import) can run — the
//      inline and Function paths refused, as a strict policy refuses them;
//   4. what this version writes opens again: ⌘S re-saves encrypted, and the
//      self-update re-splice (updates.build) produces a file with one gate
//      that unlocks.
// Mutation: drop the app's stub (or the loader's `locked`) and 1 goes red.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const PASS = 'correct horse 42'
const shellPath = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url)
const shell = readFileSync(shellPath)
const dir = mkdtempSync(join(tmpdir(), 'bento-encrypted-'))

// the inline and Function paths refused, as a policy without 'unsafe-inline'
// and 'unsafe-eval' refuses them: only the blob import is left
const BLOB_ONLY = () => {
  const append = Element.prototype.appendChild
  Element.prototype.appendChild = function (n) {
    if (n && n.id === 'bento-rt-script') throw new Error('rig: inline script refused')
    return append.call(this, n)
  }
  const F = window.Function
  window.Function = new Proxy(F, { construct() { throw new Error('rig: Function refused') } })
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
async function openFile(file, { blobOnly = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true })
  await ctx.route(/^https?:\/\/(?!rig\.test)/, (r) => r.abort())
  await ctx.route('https://rig.test/shell.html', (r) => r.fulfill({ body: shell, contentType: 'text/html' }))
  await ctx.addInitScript(() => { delete window.showSaveFilePicker; try { localStorage.setItem('bento-slideshow-started', '1') } catch {} })
  if (blobOnly) await ctx.addInitScript(BLOB_ONLY)
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  p.on('dialog', (d) => d.accept())
  await p.goto('file://' + file)
  // the loader is done when it has recorded a path or painted its card
  await p.waitForFunction(() => window.bento?.loader || /every loader path/.test(document.body?.innerText || ''), null, { timeout: 10000 }).catch(() => {})
  await p.waitForTimeout(400)
  return { ctx, p, errors }
}
const state = (p) => p.evaluate(() => ({
  gates: document.querySelectorAll('.ed-pwcard').length,
  card: /every loader path/.test(document.body.innerText),
  locked: window.bento?.locked === true && !window.bento.doc,
  path: window.bento?.loader?.path,
  tried: window.bento?.loader?.tried?.length,
}))
async function unlock(p, pass) {
  // .first(): the broken loader leaves several gates, and the rig must report
  // that rather than die on it
  const input = p.locator('.ed-pwcard input[type=password]').first()
  await input.fill(pass)
  await input.press('Enter')
}
const booted = (p) => p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-topbar .ed-logo'), null, { timeout: 10000 }).then(() => true, () => false)
async function saveDownload(p, act) {
  const dl = p.waitForEvent('download', { timeout: 15000 })
  await act()
  const d = await dl
  const file = join(dir, `${Math.random().toString(36).slice(2)}.bento.html`)
  await d.saveAs(file)
  return file
}

try {
  // --- make an encrypted deck through the UI ---------------------------------
  const plainFile = join(dir, 'plain.bento.html')
  writeFileSync(plainFile, shell)
  const made = await openFile(plainFile)
  await booted(made.p)
  const slides = await made.p.evaluate(() => window.bento.doc.slides.length)
  await made.p.locator('.ed-split-caret').click()
  await made.p.locator('.ed-save-menu').getByText('Save with password…', { exact: true }).click()
  await made.p.locator('dialog.ed-pwdialog .pw1').fill(PASS)
  await made.p.locator('dialog.ed-pwdialog .pw2').fill(PASS)
  const encFile = await saveDownload(made.p, () => made.p.locator('dialog.ed-pwdialog button').last().click())
  await made.ctx.close()
  ok(/bento\/enc/.test(readFileSync(encFile, 'utf8')), `the saved deck carries an encrypted envelope (${slides} slides inside)`)

  for (const [label, opts] of [['every loader path allowed', {}], ['only the blob import allowed', { blobOnly: true }]]) {
    console.log(`\n${label}\n`)
    const { ctx, p, errors } = await openFile(encFile, opts)
    const s = await state(p)
    ok(s.gates === 1 && !s.card, `one password gate, no failure card (${s.gates} gate(s)${s.card ? ', failure card shown' : ''})`)
    ok(s.locked, 'window.bento is the locked stub, with no doc')
    ok(s.path === (opts.blobOnly ? 'blob' : 'inline'), `the loader stopped at the ${opts.blobOnly ? 'blob' : 'first'} path (${s.path}; ${s.tried} tried)`)
    await unlock(p, 'not the password')
    await p.waitForTimeout(800)
    const w = await p.evaluate(() => ({ gates: document.querySelectorAll('.ed-pwcard').length, err: document.querySelector('.ed-pwerr')?.textContent || '' }))
    ok(w.gates === 1 && w.err.length > 0 && !(await p.evaluate(() => !!window.bento.doc)), `a wrong password keeps the one gate and says so ("${w.err}")`)
    await unlock(p, PASS)
    const up = await booted(p)
    const after = await p.evaluate(() => ({ n: window.bento.doc?.slides.length, gates: document.querySelectorAll('.ed-pwcard, .ed-pwgate').length, card: /every loader path/.test(document.body.innerText) }))
    ok(up && after.n === slides && after.gates === 0 && !after.card, `the password boots the editor (${after.n} slides, ${after.gates} gate(s) left)`)
    // blob-only: the rig's own refusals are page errors by design; nothing else may be
    const real = errors.filter((e) => !/^rig: /.test(e))
    ok(real.length === 0, `no page error${real.length ? ' — ' + real[0].slice(0, 100) : ''}`)

    if (!opts.blobOnly) {
      console.log('\nwhat this version writes opens again\n')
      const resaved = await saveDownload(p, () => p.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s'))
      const sha256 = createHash('sha256').update(shell).digest('hex')
      const updated = await p.evaluate((r) => window.bento.updates.build(r), { url: 'https://rig.test/shell.html', sha256, version: '99.0.0' })
      const updFile = join(dir, 'updated.bento.html')
      writeFileSync(updFile, updated)
      for (const [what, file] of [['the ⌘S re-save', resaved], ['the self-update re-splice', updFile]]) {
        ok(/bento\/enc/.test(readFileSync(file, 'utf8')), `${what} is still encrypted`)
        const o = await openFile(file)
        const s2 = await state(o.p)
        await unlock(o.p, PASS)
        const up2 = await booted(o.p)
        ok(s2.gates === 1 && !s2.card && up2 && await o.p.evaluate(() => window.bento.doc.slides.length) === slides,
          `${what} opens: one gate, no card, unlocks to ${slides} slides`)
        await o.ctx.close()
      }
    }
    await ctx.close()
  }
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
