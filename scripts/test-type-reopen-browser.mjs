// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A saved bento/type file reopens cleanly: no page error, the Share button is
// there, and the live session it was saved from reconnects.
//
//   npm run build:single --prefix type && node scripts/test-type-reopen-browser.mjs
//
// Every saved file carries its collab credentials, so it arrives
// share-eligible and initCollab() joins the relay at boot. That join used to
// run before the Share button was created: wireOnlineStatus() touched the
// button in its temporal dead zone, the ReferenceError aborted initCollab, and
// the file opened with no Share button, no presence strip, no
// `window.bento.sync` and no stamp-on-save. A fresh (never-saved) document
// never joins at boot, so only a reopened file ever showed it.
//
// The relay is mocked in-page (Playwright routeWebSocket on the default sync
// host): the rig measures that the client opens a socket to the SAME room the
// document was live in before it was saved, and that the app reports it open.
// Nothing reaches the network.
//
// WHAT THIS PROVES, in the packaged document:
//   1. a document goes live and saves through the real save path (download);
//   2. the saved file reopens with no page error;
//   3. it shows the Share button, and window.bento.sync exists;
//   4. it reconnects to the same relay room, the transport reports 'open',
//      and the Share button shows the live state;
//   5. a document that never went live also reopens clean, with Share.
//
// Mutation (run, judged by exit code): move `tryJoin(); store.on(() =>
// tryJoin());` in type/src/collab.ts back above the Share button's
// declaration → 2–5 go red (6 of 8 checks).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }
const SHELL = process.env.TYPE_SHELL || new URL('../type/dist-single/Bento_Type.bento.html', import.meta.url).href
const RELAY = /^wss?:\/\/sync\.bento\.page\//
const roomOf = (u) => new URL(u).pathname

const dir = mkdtempSync(join(tmpdir(), 'bento-type-reopen-'))
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })

/** A fresh context whose relay sockets are answered in-page and recorded. */
async function context() {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } })
  const sockets = []
  await ctx.route(/^https?:/, (r) => r.abort())
  await ctx.routeWebSocket(RELAY, (ws) => { sockets.push(ws.url()) /* never connectToServer: a mock that stays open */ })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  return { ctx, p, sockets, errors }
}

try {
  // 1. go live, then save through the app's own save path
  const a = await context()
  await a.p.goto(SHELL)
  await a.p.waitForFunction(() => window.bento?.doc && window.bento?.sync)
  await a.p.evaluate(() => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.title = 'Reopen check'
    d.body = [{ id: 'p1', kind: 'para', text: 'Saved, then opened again.' }]
    window.bento.loadDoc(JSON.stringify(d))
  })
  await a.p.evaluate(() => window.bento.sync.share())
  await a.p.waitForFunction(() => window.bento.sync.online() === 'open', null, { timeout: 10000 }).catch(() => {})
  const firstOnline = await a.p.evaluate(() => window.bento.sync.online())
  ok(firstOnline === 'open' && a.sockets.length > 0 && a.errors.length === 0,
    `the document goes live before saving (online ${firstOnline}; sockets ${a.sockets.length}; errors ${JSON.stringify(a.errors)})`)
  const room = a.sockets.length ? roomOf(a.sockets[0]) : null
  await a.p.evaluate(() => { delete window.showSaveFilePicker })
  const [dl] = await Promise.all([a.p.waitForEvent('download'), a.p.evaluate(() => window.bento.save(false))])
  const file = join(dir, 'reopen.bento.html')
  await dl.saveAs(file)
  await a.ctx.close()

  // 2–4. reopen the saved file in a new browser profile
  const b = await context()
  await b.p.goto(pathToFileURL(file).href)
  await b.p.waitForFunction(() => window.bento?.doc, null, { timeout: 15000 })
  await b.p.waitForTimeout(800)
  const title = await b.p.evaluate(() => window.bento.doc.title)
  ok(title === 'Reopen check', `the saved file reopens with its own content (title ${JSON.stringify(title)})`)
  ok(b.errors.length === 0, `no page error on reopen (${JSON.stringify(b.errors)})`)
  const share = await b.p.evaluate(() => {
    const s = document.querySelector('.t-bar .tc-share-btn')
    return { present: !!s, visible: !!s && s.getBoundingClientRect().width > 0, sync: typeof window.bento.sync?.online }
  })
  ok(share.present && share.visible, `the Share button is mounted and visible (${JSON.stringify(share)})`)
  ok(share.sync === 'function', `window.bento.sync is wired (${share.sync})`)
  await b.p.waitForFunction(() => window.bento.sync?.online?.() === 'open', null, { timeout: 10000 }).catch(() => {})
  const st = await b.p.evaluate(() => ({
    online: window.bento.sync?.online?.() ?? 'no sync',
    live: !!document.querySelector('.tc-share-btn.live'),
  }))
  const rooms = b.sockets.map(roomOf)
  ok(rooms.length > 0 && rooms.every((r) => r === room),
    `the reopened file reconnects to the room it was live in (${room} → ${JSON.stringify(rooms)})`)
  ok(st.online === 'open' && st.live, `the live session reports open and the Share button shows it (${JSON.stringify(st)})`)
  await b.ctx.close()

  // 5. the common case: a document that never went live, saved and reopened
  const c = await context()
  await c.p.goto(SHELL)
  await c.p.waitForFunction(() => window.bento?.doc && window.bento?.sync)
  await c.p.evaluate(() => { delete window.showSaveFilePicker })
  const [dl2] = await Promise.all([c.p.waitForEvent('download'), c.p.evaluate(() => window.bento.save(false))])
  const plain = join(dir, 'plain.bento.html')
  await dl2.saveAs(plain)
  await c.ctx.close()
  const d = await context()
  await d.p.goto(pathToFileURL(plain).href)
  await d.p.waitForFunction(() => window.bento?.doc, null, { timeout: 15000 })
  await d.p.waitForTimeout(800)
  const plainShare = await d.p.evaluate(() => !!document.querySelector('.t-bar .tc-share-btn') && typeof window.bento.sync?.online === 'function')
  ok(d.errors.length === 0 && plainShare,
    `a never-shared document, saved and reopened: no page error, Share button and bento.sync present (errors ${JSON.stringify(d.errors)}; share ${plainShare})`)
  await d.ctx.close()
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
