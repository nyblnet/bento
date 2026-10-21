// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// An encrypted or unopenable dash file tells the shell's loader the app is UP.
//
//   npm run build:single --prefix dash && node scripts/test-dash-gate-browser.mjs
//
// The shell's loader decides the app mounted by reading `window.bento`. Dash set
// it only in boot(), which a password gate and a refusal page never reach, so
// the loader ran the whole app again through its next path and threw "every
// loader path was refused" over the gate — encrypted workbooks did not open.
// Dash now sets `window.bento = { format, locked: true }` before either screen.
// This drives the packaged shell with an encrypted and a corrupt document and
// asserts the loader's predicate (doc OR locked) the moment the screen is up,
// then that unlocking replaces it with the real workbook.
import { readFileSync } from 'node:fs'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

const shellPath = new URL('../dash/dist-single/Bento_Dash.bento.html', import.meta.url)
const shell = readFileSync(shellPath, 'utf8')
const BLOCK = /(<script type="application\/bento\+json" id="bento-doc">)([\s\S]*?)(<\/script>)/
if (!BLOCK.test(shell)) throw new Error('#bento-doc not found in the built shell')
const withBlock = (text) => shell.replace(BLOCK, (_, a, _b, c) => a + text.replace(/</g, '\\u003c') + c)
// a file saved by an older shell can carry its real title in <title>; the gate
// must not show it (neutral title while sealed, matching the saved file's title)
const REAL_TITLE = 'Q3 board pack — bento/dash'
const withTitle = (html) => html.replace(/<title>[^<]*<\/title>/, `<title>${REAL_TITLE}</title>`)

// The kernel's envelope (kernel/src/save.ts encryptBody): PBKDF2-SHA-256 then
// AES-GCM-256, standard base64. A low iteration count keeps the rig fast;
// decryptEnvelope honours the envelope's own `it`.
const b64 = (u) => Buffer.from(u).toString('base64')
async function envelope(json, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12))
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000 }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(json))
  return JSON.stringify({ format: 'bento/enc', v: 1, it: 1000, salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(ct)) })
}
const WORKBOOK = JSON.stringify({
  format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'gate-rig', title: 'Locked workbook',
  sheets: [{ id: 'sh', kind: 'table', name: 'Data', rids: [[1, 1]], nextRid: 2, columns: [{ id: 'v', name: 'Value', type: 'number' }], data: { v: { enc: 'raw', v: [42] } }, steps: [] }],
})
const tmp = new URL('./.gate-rig.html', shellPath)
const { writeFileSync, rmSync } = await import('node:fs')

// the loader's own predicate, after slides' shared fix
const predicate = () => !!(window.bento && (window.bento.doc || window.bento.locked))

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  const ctx = await browser.newContext()
  await ctx.route(/^https?:/, (r) => r.abort())

  console.log('an encrypted workbook')
  writeFileSync(tmp, withTitle(withBlock(await envelope(WORKBOOK, 'hunter2'))))
  {
    const p = await ctx.newPage(); const errors = []
    p.on('pageerror', (e) => errors.push(e.message))
    await p.goto(tmp.href)
    await p.waitForSelector('.dx-gate input[type="password"]', { timeout: 10000 })
    const b = await p.evaluate(() => ({ format: window.bento?.format, locked: window.bento?.locked, doc: !!window.bento?.doc }))
    ok(b.format === 'bento/dash' && b.locked === true && !b.doc, `at the gate, window.bento is { format: 'bento/dash', locked: true } with no doc — ${JSON.stringify(b)}`)
    ok(await p.evaluate(predicate), 'so the loader\'s mounted check (doc OR locked) is TRUE while the gate is up')
    ok(await p.evaluate(() => document.title) === 'bento/dash', `at the gate the tab says only "bento/dash", not the file's own <title> — got "${await p.evaluate(() => document.title)}"`)
    await p.fill('.dx-gate input[type="password"]', 'wrong')
    await p.click('.dx-unlock')
    await p.waitForFunction(() => /Wrong password/.test(document.querySelector('.dx-err')?.textContent ?? ''))
    ok(await p.evaluate(() => window.bento?.locked === true && !window.bento?.doc), 'a wrong password keeps it locked')
    await p.fill('.dx-gate input[type="password"]', 'hunter2')
    await p.click('.dx-unlock')
    await p.waitForFunction(() => window.bento?.doc, null, { timeout: 15000 })
    const after = await p.evaluate(() => ({ title: window.bento.doc.title, locked: window.bento.locked }))
    ok(after.title === 'Locked workbook' && after.locked === undefined, `the right password opens the workbook and replaces the locked marker — ${JSON.stringify(after)}`)
    ok(await p.evaluate(() => document.title) === 'bento/dash', `unlocked, the password still seals it: the tab still says only "bento/dash" — got "${await p.evaluate(() => document.title)}"`)
    ok(!errors.some((e) => /loader path/.test(e)), `no "every loader path was refused" error${errors.length ? ' — ' + errors.join('; ') : ''}`)
    await p.close()
  }

  console.log('\nan unopenable file')
  writeFileSync(tmp, withBlock('{"format":"bento/dash","version":99,"sheets":"nope"}'))
  {
    const p = await ctx.newPage()
    await p.goto(tmp.href)
    await p.waitForSelector('.dx-gate #dx-copy', { timeout: 10000 })
    const b = await p.evaluate(() => ({ format: window.bento?.format, locked: window.bento?.locked, refused: window.bento?.refused, doc: !!window.bento?.doc }))
    ok(b.format === 'bento/dash' && b.locked === true && b.refused === true && !b.doc, `the refusal page marks the app up and says why there is no doc — ${JSON.stringify(b)}`)
    ok(await p.evaluate(predicate), 'and the loader\'s mounted check is TRUE there too')
    await p.close()
  }

  console.log('\nan ordinary workbook is unchanged')
  writeFileSync(tmp, withBlock(WORKBOOK))
  {
    const p = await ctx.newPage()
    await p.goto(tmp.href)
    await p.waitForFunction(() => window.bento?.doc, null, { timeout: 10000 })
    ok(await p.evaluate(() => window.bento.locked === undefined && window.bento.doc.title === 'Locked workbook'), 'a plain file boots straight to its doc, never locked')
    ok(await p.evaluate(() => document.title) === 'Locked workbook — bento/dash', `CONTROL: a plain file's tab shows its title — "${await p.evaluate(() => document.title)}"`)
    await p.close()
  }
} finally {
  await browser.close()
  rmSync(tmp, { force: true })
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
