#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/connect W2 LAUNCH GATE — a real cross-origin https: embed inside a
// GENUINE served document (manual; security 2026-10-24 / identity-threat-model §39).
//
//   node scripts/qa-webext-embed-gate.mjs [path/to/genuine.bento.html]
//
// Not a CI rig (CI's headless shell cannot load an extension; same as
// qa-webext-serve.mjs). It loads the unpacked extension into Chrome for
// Testing, serves the frozen real 1.2.10 deck through serve.html (gate 1
// against the history that ships in home/fixtures/gate1/real — no network),
// and then, as the document's own script, frames a page served over TLS from a
// LOCAL origin (scripts/fixtures/webext-embed/embed.html — never a CDN). That
// page posts every identity and save request there is, a forged handshake and
// a forged ready, to `parent` and to `top`, twice, and tries to read the
// agent across the origin boundary.
//
// PASS needs all of:
//   · the fixture really was served over https: from the local origin (the
//     server's request log, the frame's URL, location.origin, isSecureContext),
//     and its script ran — otherwise the rig FAILS, never passes vacuously;
//   · CONTROL: those messages ARE delivered — the sandbox window and the host
//     page both receive them from the embed's origin;
//   · CONTROL: the genuine document's own call (whoami) DOES arrive on the host's port;
//   · the embed received NOTHING back from anyone, and could not read the agent;
//   · the host's port saw 0 messages from the embed (QA-only counter, as in
//     qa-webext-serve.mjs);
// and each MUTANT must make the same checks go red:
//   · sandbox relays window messages onto the port;
//   · host answers window messages as if they were the port's.

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
import https from 'node:https'
import { readdirSync, mkdtempSync, existsSync, cpSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureDir = join(root, 'scripts/fixtures/webext-embed')
let failures = 0
{ // header: what this run was measured on (Playwright and the browser binary)
  const { createRequire } = await import('node:module')
  let pw = '?'
  try { const m = process.env.PLAYWRIGHT_MODULE; pw = createRequire(m ? (m.startsWith('/') ? m : join(process.cwd(), m)) : join(process.cwd(), 'x.js'))('playwright/package.json').version } catch {}
  if (pw === '?') { try { let d = dirname(process.env.PLAYWRIGHT_MODULE || ''); for (let i = 0; i < 4 && pw === '?'; i++, d = dirname(d)) if (existsSync(join(d, 'package.json'))) { const j = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')); if (j.name === 'playwright' || j.name === 'playwright-core') pw = j.version } } catch {}}
  let br = '?'; try { br = execFileSync(chromePath(), ['--version'], { encoding: 'utf8' }).trim() } catch {}
  console.log(`playwright ${pw} | ${br} | node ${process.version}`)
}
const ok = (c, m) => { if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const base = join(homedir(), '.cache/puppeteer/chrome')
  for (const b of existsSync(base) ? readdirSync(base).sort().reverse() : []) {
    for (const p of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-linux64/chrome'])
      if (existsSync(join(base, b, p))) return join(base, b, p)
  }
}
if (!chromePath()) { console.error('no Chrome for Testing found (set CHROME_PATH)'); process.exit(2) }

if (!existsSync(join(fixtureDir, 'embed.html'))) { console.error('FAIL: the embed fixture is missing: ' + join(fixtureDir, 'embed.html')); process.exit(2) }
const work = mkdtempSync(join(tmpdir(), 'embed-gate-'))

// --- the local https origin -------------------------------------------------
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
  '-keyout', join(work, 'k.pem'), '-out', join(work, 'c.pem'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'pipe' })
const served = []
const server = https.createServer({ key: readFileSync(join(work, 'k.pem')), cert: readFileSync(join(work, 'c.pem')) }, (req, res) => {
  served.push(req.url)
  if (req.url === '/embed.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(readFileSync(join(fixtureDir, 'embed.html')))
  } else { res.writeHead(404); res.end() }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const embedUrl = `https://localhost:${server.address().port}/embed.html`
const embedOrigin = `https://localhost:${server.address().port}`

// --- the genuine document and the history that proves it ----------------------
const docPath = process.argv[2] ?? join(root, 'home/fixtures/gate1/real/slides-1.2.10/Bento_Slides.bento.html')
if (!existsSync(docPath)) { console.error('no genuine document at ' + docPath); process.exit(2) }
const serveDoc = join(mkdtempSync(join(tmpdir(), 'embed-gate-doc-')), 'Real deck.bento.html')
writeFileSync(serveDoc, readFileSync(docPath))
const history = JSON.parse(JSON.parse(readFileSync(join(root, 'home/fixtures/gate1/real/slides-1.2.10/history.json'), 'utf8')).payload)

function mutate(file, from, to, why) {
  const src = readFileSync(file, 'utf8')
  const out = src.replace(from, to)
  if (out === src) throw new Error(`${why}: the line moved; update the replace`)
  writeFileSync(file, out)
}

async function scenario(label, mutant) {
  const ext = join(work, 'ext-' + label); cpSync(join(root, 'home/webext'), ext, { recursive: true })
  // host-side counter: every message that reaches the port handler (QA copy only)
  mutate(join(ext, 'src/serve/serve.js'), '      const req = parseRequest(e.data)', '      ;(window.__qaPort ??= []).push(e.data?.op ?? null)\n      const req = parseRequest(e.data)', 'host counter')
  if (mutant === 'sandbox-relay') mutate(join(ext, 'src/serve/sandbox.js'), '    docClose(doc)\n', '    docClose(doc)\n    listen(win, \'message\', (ev) => { portPost(port, evData(ev)) }) // document.open() erases window listeners, so it goes in AFTER\n', 'sandbox mutant')
  if (mutant === 'host-window') mutate(join(ext, 'src/serve/serve.js'), "    frame.contentWindow.postMessage({ kind: 'bento-serve', html,", "    addEventListener('message', port1.onmessage)\n    frame.contentWindow.postMessage({ kind: 'bento-serve', html,", 'host mutant')

  const ctx = await chromium.launchPersistentContext(join(work, 'profile-' + label), {
    executablePath: chromePath(), headless: true, ignoreHTTPSErrors: true, // the fixture's own self-signed cert
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  })
  try {
    let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker')
    const id = new URL(sw.url()).host
    // the worker can be reported before its global scope has `chrome`: retry, bounded
    for (let i = 0; ; i++) {
      if (await sw.evaluate(() => typeof chrome === 'object').catch(() => false)) break
      if (i >= 50) throw new Error("service worker never exposed `chrome` (5s)")
      await new Promise((r) => setTimeout(r, 100))
    }
    await sw.evaluate((h) => chrome.storage.local.set({ serveWithIdentity: true, gate1Used: true, gate1History: { 'bento-slides': { history: h, fetchedAt: Date.now() } } }), history)
    const page = await ctx.newPage()
    await page.goto(`chrome-extension://${id}/src/serve/serve.html?path=${encodeURIComponent(serveDoc)}`)
    const frame = await (async () => { for (let i = 0; i < 100; i++) { const f = page.frames().find((fr) => fr.url().includes('sandbox.html')); if (f) return f; await page.waitForTimeout(100) } })()
    if (!frame) return { error: 'the genuine document never reached the sandbox' }
    await frame.waitForFunction(() => window.bento && typeof window.bento.serialize === 'function', null, { timeout: 30000 }).catch(() => {})
    const booted = await frame.evaluate(() => !!(window.bento && window.bento.doc))

    // evidence listeners: who is actually delivered what
    await page.evaluate(() => { window.__qaTop = []; addEventListener('message', (e) => window.__qaTop.push(e.origin + '|' + ((e.data && (e.data.op || e.data.kind)) || ''))) })
    await frame.evaluate(() => { window.__qaPar = []; addEventListener('message', (e) => window.__qaPar.push(e.origin + '|' + ((e.data && (e.data.op || e.data.kind)) || ''))) })
    // CONTROL: the genuine document's own call reaches the port
    await frame.evaluate(() => window.__bentoIdentity.whoami())
    const portBefore = await page.evaluate(() => [...(window.__qaPort ?? [])])

    // the document's own script frames a real https: page from the local origin
    await frame.evaluate((src) => { const f = document.createElement('iframe'); f.src = src; document.body.appendChild(f) }, embedUrl)
    let embed
    for (let i = 0; i < 100 && !embed; i++) { embed = page.frames().find((fr) => fr.url().startsWith(embedOrigin)); if (!embed) await page.waitForTimeout(100) }
    if (!embed) return { error: 'the embed frame never appeared', served }
    await embed.waitForFunction(() => window.__embed, null, { timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(1600) // both attack rounds, and anything slow to answer
    const rep = await embed.evaluate(() => window.__embed && { got: window.__embed.got, tried: window.__embed.tried, origin: window.__embed.origin, secure: window.__embed.secure, hasAgent: window.__embed.hasAgent }).catch(() => null)
    const portAfter = await page.evaluate(() => [...(window.__qaPort ?? [])])
    const top = await page.evaluate(() => [...window.__qaTop]), par = await frame.evaluate(() => [...window.__qaPar])
    return { booted, embedFrameUrl: embed.url(), rep, portBefore, portNew: portAfter.slice(portBefore.length), top, par }
  } finally { await ctx.close() }
}

// what a clean run looks like; returns [[ok, message], ...]
function checks(r) {
  // the embed inherits the sandbox's opaque origin (CSP sandbox flags reach child frames), so its messages carry origin "null"
  const fromEmbed = (xs) => xs.filter((o) => /^null\|(identity\.|save\.write|serve\.failed)/.test(o)).length
  return [
    [!r.error && r.booted, 'the genuine deck boots in the sandbox (served, gate 1 passed)'],
    [!r.error && served.includes('/embed.html') && r.embedFrameUrl.startsWith('https://localhost:') && r.rep && r.rep.origin === embedOrigin && r.rep.secure === true,
      `FIXTURE SERVED: a real https: cross-origin page, from the local origin ${embedOrigin}, ran its script (isSecureContext, location.origin)`],
    [!r.error && fromEmbed(r.par) >= 10 && fromEmbed(r.top) >= 10,
      `CONTROL: the embed's messages ARE delivered — the sandbox window got ${fromEmbed(r.par ?? [])} and the host page ${fromEmbed(r.top ?? [])} (five requests, twice; origin "null": an https: page framed by the sandbox has an opaque origin of its own)`],
    [!r.error && r.portBefore.includes('identity.whoami'), `CONTROL: the genuine document's own call reaches the host's port (${r.portBefore?.join(', ')})`],
    [!r.error && r.rep && r.rep.got.length === 0, `the embed received NOTHING back from anyone (${r.rep?.got.length} messages)`],
    [!r.error && r.rep && !r.rep.hasAgent && r.rep.tried.filter((t) => /__bentoIdentity|\.document/.test(t)).every((t) => /SecurityError/.test(t)) && r.rep.tried.filter((t) => /__bentoIdentity|\.document/.test(t)).length === 6,
      `it could not read the agent or either document across the origin boundary (${r.rep?.tried.filter((t) => /__bentoIdentity|\.document/.test(t)).join('; ')})`],
    [!r.error && r.portNew.length === 0, `0 messages from the embed on the host's port (${r.portNew?.length} new${r.portNew?.length ? ': ' + r.portNew.join(', ') : ''})`],
  ]
}

console.log('real extension:')
const real = await scenario('real', null)
if (real.error) console.log('  error:', real.error)
for (const [c, m] of checks(real)) ok(c, m)
ok(served.length > 0 && served.every((u) => u === '/embed.html' || u === '/favicon.ico'), `the local server saw only the fixture (${[...new Set(served)].join(', ')})`)

for (const m of ['sandbox-relay', 'host-window']) {
  console.log(`MUTANT ${m}:`)
  const r = await scenario(m, m)
  if (r.error) { ok(false, `the mutant scenario did not run: ${r.error}`); continue }
  const cs = checks(r)
  const [, , , control] = cs
  ok(control[0], 'the controls still hold under the mutant (so the red below is the mutant, not a broken rig)')
  const red = cs.slice(4).filter(([c]) => !c)
  ok(red.length > 0 && r.portNew.length > 0, `the gate goes RED: ${r.portNew.length} embed messages reached the port (${[...new Set(r.portNew)].join(', ')}); ${red.length} of the embed rows fail`)
}
server.close()
await new Promise((r) => setTimeout(r, 50))
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
