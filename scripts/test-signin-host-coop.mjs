// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Which Cross-Origin-Opener-Policy values keep the sign-in host's popup
// protocol alive, measured in each engine.
//
//   node scripts/test-signin-host-coop.mjs              # headless shell + WebKit
//   node scripts/test-signin-host-coop.mjs --chrome     # adds the installed Google Chrome
//
// bento/home opens the sign-in host (the REAL worker and page from
// server/signin/, with only its COOP header varied) and waits for the host's
// 'ready', which it posts to its opener at load; then bento/home sends a
// message the host answers by refusing it (proof the reverse direction
// arrives). A combination "works" when both directions get through and the
// host still has its opener.
//
// The expectations are the rule the hosting check enforces
// (server/signin/check-hosting.mjs): the sign-in host may send no COOP or
// unsafe-none, and bento/home at most same-origin-allow-popups. Every setting
// the rule ALLOWS must work in every engine. Every setting it REFUSES must be
// measured to sever the protocol in at least one engine, which is the reason
// it is refused. Measured (2026-11): Chromium and Chrome sever on
// same-origin-allow-popups ON THE POPUP exactly as on same-origin, so the
// sign-in host's rule is "none or unsafe-none", not merely "not same-origin".
// Playwright's WebKit applies these headers (a COOP+COEP page is
// crossOriginIsolated, checked below) but keeps the opener under every value;
// Safari on a device is still to be checked. No passkey is used, so WebKit
// (which has no virtual authenticator) runs too.
import { siteHandler } from '../server/signin/local.mjs'

const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const HOME = 'https://home.bento.page', S = 'https://signin.id.bento.page'

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

const base = await siteHandler()
// [sign-in host COOP, bento/home COOP, should work]
const MATRIX = [
  [null, null, true],
  ['unsafe-none', null, true],
  [null, 'same-origin-allow-popups', true],
  [null, 'unsafe-none', true],
  ['same-origin-allow-popups', null, false],
  ['same-origin', null, false],
  [null, 'same-origin', false],
  ['same-origin-allow-popups', 'same-origin-allow-popups', false],
]

const engines = [['chromium headless shell', pw.chromium, {}], ['webkit', pw.webkit, {}]]
if (process.argv.includes('--chrome')) engines.push(['google chrome', pw.chromium, { channel: 'chrome' }])

const results = {}
for (const [name, type, opts] of engines) {
  const browser = await type.launch({ headless: true, ...opts })
  console.log(`\n${name} ${browser.version()}`)
  for (const [sCoop, hCoop, should] of MATRIX) {
    const ctx = await browser.newContext()
    const sockets = []
    await ctx.routeWebSocket(/.*/, (ws) => { sockets.push(ws.url()); ws.close() })
    await ctx.route('**/*', (route) => route.abort())
    await ctx.route(`${S}/**`, async (route) => {
      const res = await base(new Request(route.request().url(), { method: route.request().method() }))
      const headers = Object.fromEntries(res.headers)
      if (sCoop) headers['cross-origin-opener-policy'] = sCoop
      return route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) })
    })
    await ctx.route(`${HOME}/**`, (route) => route.fulfill({
      headers: { 'content-type': 'text/html', ...(hCoop ? { 'cross-origin-opener-policy': hCoop } : {}) },
      body: `<!doctype html><meta charset=utf-8><button id=b>open</button><script>
        window.msgs = []; addEventListener('message', (e) => msgs.push([e.origin, e.data && e.data.t]))
        b.onclick = () => { window.w = window.open('${S}/', 'signin', 'popup,width=480,height=600') }</script>`,
    }))
    const page = await ctx.newPage()
    await page.goto(HOME + '/')
    const popupP = ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null)
    await page.click('#b') // a real click: WebKit blocks popups without one
    const pop = await popupP
    let st = ['no popup', ''], ready = 0, opener = false, closed = null, back = false
    if (pop) {
      await pop.waitForLoadState().catch(() => {})
      for (let i = 0; i < 50; i++) {
        st = await pop.evaluate(() => [document.body.dataset.state, document.body.dataset.reason || '']).catch(() => ['?', ''])
        if (st[0] !== 'loading') break
        await page.waitForTimeout(50)
      }
      await page.waitForTimeout(200)
      ready = (await page.evaluate(() => msgs.filter((m) => m[0] === 'https://signin.id.bento.page' && m[1] === 'ready').length))
      opener = await pop.evaluate(() => !!window.opener).catch(() => false)
      closed = await page.evaluate(() => !window.w || window.w.closed)
      // the reverse direction: a message the host must answer by refusing
      await page.evaluate(() => { try { window.w.postMessage({ t: 'probe' }, 'https://signin.id.bento.page') } catch {} })
      for (let i = 0; i < 30 && !back; i++) {
        back = (await pop.evaluate(() => document.body.dataset.reason).catch(() => '')) === 'not-a-request'
        if (!back) await page.waitForTimeout(50)
      }
    }
    const works = ready === 1 && opener && back
    const key = `${sCoop || '(none)'} / ${hCoop || '(none)'}`
    ;(results[key] ||= {})[name] = works
    ok(sockets.length === 0, `sign-in host COOP ${sCoop || '(none)'}, bento/home COOP ${hCoop || '(none)'}: ${works ? 'works' : 'severed'} ` +
      `(state ${st[0]}${st[1] ? ' ' + st[1] : ''}, ready ${ready}, opener ${opener}, home sees popup closed ${closed}, reply path ${back})`)
    await ctx.close()
  }
  // The positive control for the header itself: routed COOP+COEP must make a
  // page cross-origin isolated, or a "works" row above would mean nothing.
  const ctx = await browser.newContext()
  await ctx.route('**/*', (route) => route.fulfill({ headers: { 'content-type': 'text/html', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' }, body: '<p>x' }))
  const p = await ctx.newPage(); await p.goto(HOME + '/isolated')
  ok(await p.evaluate(() => self.crossOriginIsolated), 'the engine applies routed COOP headers (a COOP+COEP page is crossOriginIsolated)')
  await ctx.close()
  await browser.close()
}

console.log('\nthe rule against the measurements')
for (const [sCoop, hCoop, should] of MATRIX) {
  const key = `${sCoop || '(none)'} / ${hCoop || '(none)'}`, by = results[key]
  const list = Object.entries(by).map(([e, w]) => `${e}: ${w ? 'works' : 'severed'}`).join(', ')
  if (should) ok(Object.values(by).every(Boolean), `allowed ${key}: works in every engine (${list})`)
  else ok(Object.values(by).some((w) => !w), `refused ${key}: severs the protocol in at least one engine (${list})`)
}
const chromiumKey = 'chromium headless shell'
ok(results['same-origin-allow-popups / (none)'][chromiumKey] === false,
  'same-origin-allow-popups on the sign-in popup itself severs it in Chromium (so the hosting check refuses it on the sign-in host)')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
