#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/connect W2 — the extension's gate 1 against the LIVE release (manual).
//
//   node scripts/qa-webext-live-gate1.mjs            # against bento.page, live
//   node scripts/qa-webext-live-gate1.mjs --offline  # against kernel's frozen
//                                                    # real/slides-1.2.10 snapshot
//   (CHROME_PATH picks a browser build)
//
// Not a CI rig: it needs a browser (and, live, bento.page). The fixtures can't catch
// what the real channel does (home-ios found two such bugs: the history names
// the app "bento-slides", and a fresh shell's empty document block names no
// app, so every held history must be tried). This runs the extension's OWN
// code — serve/history.js with the pinned release key, serve/prepare.js — on:
//   · the live signed histories for every app;
//   · the current fresh shell, exactly as New writes it  → GENUINE;
//   · a real deck saved by that release (edited via window.bento) → GENUINE;
//   · that deck with ONE runtime byte changed → UNKNOWN (the control);
//   · that deck with one DOCUMENT byte changed → GENUINE (content is free).
// Exit status is the verdict.

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
import { readdirSync, mkdtempSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const H = await import('../home/webext/src/serve/history.js')
const P = await import('../home/webext/src/serve/prepare.js')
const { RELEASE_KEY } = await import('../home/webext/src/release.js')
const { APPS } = await import('../home/webext/src/library.js')

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const base = join(homedir(), '.cache/puppeteer/chrome')
  for (const b of existsSync(base) ? readdirSync(base).sort().reverse() : []) {
    for (const p of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-linux64/chrome'])
      if (existsSync(join(base, b, p))) return join(base, b, p)
  }
  return undefined
}

let failures = 0
const ok = (cond, msg) => { if (!cond) failures++; console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`) }
const OFFLINE = process.argv.includes('--offline')
const SNAP = join(dirname(fileURLToPath(import.meta.url)), '../home/fixtures/gate1/real/slides-1.2.10')
let get = (u) => fetch(u)
if (OFFLINE) {
  // the frozen snapshot, served as bento.page would: the slides history and
  // shell; every other app 404s, as they do live today
  const snapKey = JSON.parse(readFileSync(join(SNAP, 'release-public-key.json'), 'utf8'))
  ok(snapKey.x === RELEASE_KEY.x && snapKey.y === RELEASE_KEY.y, "the snapshot's release key IS the extension's pinned key (so the pinned key, not a test key, verifies it)")
  const files = {
    'https://bento.page/releases/slides/history.json': readFileSync(join(SNAP, 'history.json'), 'utf8'),
    'https://bento.page/releases/slides/Bento_Slides.bento.html': readFileSync(join(SNAP, 'Bento_Slides.bento.html'), 'utf8'),
  }
  get = async (u) => (u in files ? new Response(files[u]) : new Response('', { status: 404 }))
}
console.log(OFFLINE ? 'source: frozen snapshot real/slides-1.2.10' : 'source: bento.page, live')
const m = new Map()
const deps = { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v) }, fetch: (u, o) => get(u, o), now: () => Date.now(), jwk: RELEASE_KEY }
const report = await H.refresh(APPS.map(({ id, appId }) => ({ id, appId })), deps)
console.log('histories:', JSON.stringify(report))
const held = await H.heldHistories(deps)
ok(Object.keys(held).length > 0, `at least one history verifies under the pinned release key (${Object.keys(held).join(', ')})`)

for (const app of APPS) {
  if (!held[app.appId]) continue
  // live: the signed manifest names the current shell; offline: the
  // snapshot's newest release, at the same address
  const man = OFFLINE
    ? { version: held[app.appId].releases[0].version, url: `https://bento.page/releases/${app.id}/Bento_Slides.bento.html` }
    : JSON.parse(JSON.parse(await (await fetch(app.manifest)).text()).payload)
  const fresh = await (await get(man.url)).text()
  const v = await P.prepare(fresh, held)
  ok(v.verdict === 'genuine' && v.appId === app.appId && v.release.version === man.version, `${app.id} ${man.version}: the fresh shell (as New writes it) is GENUINE`)
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'live-')), { executablePath: chromePath(), headless: true })
  const page = await ctx.newPage()
  await page.setContent('<p>loading</p>')
  const dir = mkdtempSync(join(tmpdir(), 'shell-'))
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(dir, 'fresh.bento.html'), fresh)
  await page.goto('file://' + join(dir, 'fresh.bento.html'))
  await page.waitForFunction(() => window.bento && typeof window.bento.serialize === 'function', null, { timeout: 30000 })
  const saved = await page.evaluate(async () => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.title = 'A real saved deck'
    if (window.bento.loadDoc) await window.bento.loadDoc(JSON.stringify(d))
    return await window.bento.serialize()
  })
  await ctx.close()
  ok((await P.prepare(saved, held)).verdict === 'genuine', `${app.id}: a real deck saved by that release is GENUINE`)
  const rt = saved.indexOf('id="bento-rt"')
  const at = saved.indexOf('>', rt) + 20
  ok((await P.prepare(saved.slice(0, at) + (saved[at] === 'A' ? 'B' : 'A') + saved.slice(at + 1), held)).verdict === 'unknown', `${app.id}: CONTROL — one runtime byte changed is UNKNOWN`)
  const d1 = saved.indexOf('A real saved deck', saved.indexOf('id="bento-doc"'))
  ok((await P.prepare(saved.slice(0, d1) + 'B' + saved.slice(d1 + 1), held)).verdict === 'genuine', `${app.id}: one document byte changed is still GENUINE (content is free)`)
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
