// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The sign-in host's protocol rows that need no passkey, in every engine:
// Playwright's headless shell, WebKit (the engine of every iOS browser) and,
// with --chrome, the installed Google Chrome.
//
//   node scripts/test-signin-host-engines.mjs [--chrome]
//
// The real worker and page (server/signin/local.mjs) at
// https://signin.id.bento.page, opener pages at https://home.bento.page and
// https://attacker.example, everything else refused, every WebSocket closed.
// The page's state is read from data-state / data-reason, so no authenticator
// is needed and WebKit runs every row. The passkey rows (the ceremony, the
// directory, the Signal API, framing, COOP) are in
// scripts/test-signin-host-browser.mjs, in the Chromium engines.
//
// Rows, each with a mutant (a copy of server/signin/ with one edit) that
// must turn it red:
//   - two requests posted back to back end REFUSED. WebKit delivers the
//     second while the first is still inside an await; without the `voided`
//     checks the first then shows its consent screen anyway.
//   - a second request after the consent screen voids it;
//   - a foreign opener, noopener, a non-enrol shape and a request in the URL
//     are refused;
//   - labels: every control, format, private-use, unassigned, separator and
//     default-ignorable character is refused (15 cases), and real names in
//     any script are shown exactly (8 cases);
//   - the consent screen keeps its "cannot check which device" disclaimer and
//     never claims the key belongs to this browser or device (4 mutants).
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { siteHandler } from '../server/signin/local.mjs'

const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const ROOT = fileURLToPath(new URL('../server/signin/', import.meta.url))
const HOME = 'https://home.bento.page', S = 'https://signin.id.bento.page', ATTACKER = 'https://attacker.example'
const cp = (...xs) => String.fromCodePoint(...xs)
const RSQ = cp(0x2019) // the typographic apostrophe

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

const DISCLAIMER = 'This page cannot check which device holds the key bento/home sent.'
const MUTANTS = {
  // C1: the checks after each await dropped.
  'no-voided': [
    ['public/signin.js', '  const r = await checkRequest(e.data)\n  if (voided) return\n', '  const r = await checkRequest(e.data)\n'],
    ['public/signin.js', '  const fp = await fingerprint(r.W)\n  if (voided) return\n', '  const fp = await fingerprint(r.W)\n'],
  ],
  // A second request replaces the first instead of voiding it.
  'second-wins': [['public/signin.js', "    if (!busy) { voided = true; request = null; show('refused', 'one-request-per-window') }\n    return\n  }\n  taken = true\n",
    '  }\n  taken = true\n']],
  'foreign-opener': [['public/signin.js', "  if (e.origin !== HOME) return show('refused', 'wrong-origin')\n", '']],
  'noopener': [['public/signin.js', "  if (!window.opener) return show('refused', 'no-opener')\n", '']],
  'any-shape': [['public/signin.js', "  if (Object.keys(m).sort().join(',') !== 'W,kx,label,t') return 'not-a-request'\n  if (m.t !== 'enrol') return 'not-a-request'\n", '']],
  'url-params': [['public/signin.js', "  if (!window.opener) return show('refused', 'no-opener')\n",
    "  const q = new URLSearchParams(location.search || location.hash.slice(1))\n" +
    "  if (q.get('t') === 'enrol') { taken = true; request = { W: q.get('W'), kx: q.get('kx'), label: q.get('label'), rq: HOME }; $('label').textContent = request.label; show('consent'); return }\n" +
    "  if (!window.opener) return show('refused', 'no-opener')\n"]],
  // C2: the label rule narrowed to control characters only.
  'narrow-labels': [['public/signin.js', /^const BAD_LABEL = .*$/m, 'const BAD_LABEL = /[\\p{Cc}]/u']],
  // C3: four ways a screen could claim the key is this browser's.
  'claims-browser': [['public/index.html', DISCLAIMER, 'This key belongs to this browser.']],
  'claim-stays': [['public/index.html', DISCLAIMER, 'This key stays on this device.']],
  'claim-curly': [['public/index.html', DISCLAIMER, `This is this browser${RSQ}s key, verified by bento/id.`]],
  'claim-dt': [['public/index.html', '<dt>Key fingerprint</dt>', `<dt>This device${RSQ}s key</dt>`]],
}
const tmp = mkdtempSync(join(tmpdir(), 'signin-engines-'))
let tagN = 0
async function site(mutant) {
  if (!mutant) return siteHandler(ROOT)
  const dir = join(tmp, mutant + ++tagN)
  cpSync(ROOT, dir, { recursive: true })
  for (const [file, from, to] of MUTANTS[mutant]) {
    const f = join(dir, file), text = readFileSync(f, 'utf8')
    const n = from instanceof RegExp ? (text.match(new RegExp(from.source, from.flags + 'g')) || []).length : text.split(from).length - 1
    if (n !== 1) throw new Error(`mutant ${mutant}: its edit occurs ${n} times in ${file}, not once; update the mutant`)
    writeFileSync(f, text.replace(from, () => to))
  }
  return siteHandler(dir, 'e' + tagN)
}

// The consent screen's claims: the disclaimer must be there, and outside the two
// sentences that are allowed to mention a device, nothing may tie the key to
// this (or your) browser or device, with either apostrophe.
const claimsDevice = (t) => {
  const rest = t.replace('Approve only if you just asked bento/home to sign in.', '').replace(DISCLAIMER, '')
  return /\b(this|your)\s+(browser|device)/i.test(rest) || new RegExp(`(browser|device)['${RSQ}]s`, 'i').test(rest) || /stays on|belongs to/i.test(rest)
}
const consentHonest = (t) => t.includes(DISCLAIMER) && !claimsDevice(t)

const GOOD = ['Chrome on MacBook', `Alice${RSQ}s MacBook ${cp(0x2014)} verified by Bento`, cp(0x65e5, 0x672c, 0x8a9e, 0x306e, 0x30e9, 0x30d9, 0x30eb),
  `Caf${cp(0xe9)} cr${cp(0xe8)}me`, `Pixel 9 ${cp(0xb7)} ${cp(0xc4)}ndroid`, `${cp(0xdc)}n${cp(0xef)}c${cp(0xf8)}d${cp(0xe9)} ${cp(0xd1)}ame`,
  `${cp(0xd55c, 0xad6d, 0xc5b4)} ${cp(0xb178, 0xd2b8, 0xbd81)}`, `Chrome${cp(0x1f600)}`]
const BAD = [
  ['right-to-left override', `MacBook${cp(0x202e)}gnp.exe`], ['newline', `line${cp(10)}break`], ['tab', `tab${cp(9)}here`],
  ['zero-width space', `zero${cp(0x200b)}width`], ['bidi isolates', `a${cp(0x2066)}b${cp(0x2069)}`], ['tag characters', `Chrome${cp(0xe0041, 0xe0042)}`],
  ['combining grapheme joiner', `Chr${cp(0x34f)}ome`], ['braille blank', `Chrome${cp(0x2800, 0x2800)}`], ['variation selector supplement', `Chrome${cp(0xe0100)}`],
  ['Mongolian free variation selector', `x${cp(0x180b)}x`], ['Khmer inherent vowel', `x${cp(0x17b4)}x`], ['musical format character', `x${cp(0x1d173)}x`],
  ['interlinear annotation', `x${cp(0xfff9)}x`], ['private use', `x${cp(0xf0000)}`], ['unassigned', `x${cp(0x378)}`],
]

const engines = [['headless shell', pw.chromium, {}], ['webkit', pw.webkit, {}]]
if (process.argv.includes('--chrome')) engines.push(['google chrome', pw.chromium, { channel: 'chrome' }])

const b64u = (b) => Buffer.from(b).toString('base64url')
const keys = async () => ({
  W: b64u(await crypto.subtle.exportKey('raw', (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])).publicKey)),
  kx: b64u(await crypto.subtle.exportKey('raw', (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])).publicKey)),
})
const enrol = (k, label = 'Chrome on MacBook') => ({ t: 'enrol', W: k.W, kx: k.kx, label })

try {
  for (const [name, type, opts] of engines) {
    const browser = await type.launch({ headless: true, ...opts })
    console.log(`\n=== ${name} ${browser.version()}`)
    const webkit = type === pw.webkit
    let handler = null
    const sockets = [], stray = []
    const ctx = await browser.newContext()
    await ctx.routeWebSocket(/.*/, (ws) => { sockets.push(ws.url()); ws.close() })
    await ctx.route('**/*', (route) => { stray.push(route.request().url()); return route.abort() })
    await ctx.route(`${S}/**`, async (route) => {
      const res = await handler(new Request(route.request().url(), { method: route.request().method() }))
      return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) })
    })
    const opener = `<!doctype html><meta charset=utf-8><script>
      window.HM = { msgs: [], w: null, open(u, f) { this.w = window.open(u || '${S}/', 'signin' + Math.random(), f || 'popup,width=480,height=600'); return !!this.w },
        send(m) { this.w.postMessage(m, '${S}') }, pair(a, b) { this.w.postMessage(a, '${S}'); this.w.postMessage(b, '${S}') } }
      addEventListener('message', (e) => HM.msgs.push([e.origin, e.data && e.data.t]))</script>`
    for (const o of [HOME, ATTACKER]) await ctx.route(`${o}/**`, (route) => route.fulfill({ contentType: 'text/html', body: opener }))
    // the account the sign-in host keeps in its own storage (its own pages write it)
    handler = await site(null)
    { const a = await ctx.newPage(); await a.goto(S + '/'); await a.evaluate(() => localStorage.setItem('bento-id-account', 'alice@example.com')); await a.close() }
    const page = await ctx.newPage()
    const sleep = (ms) => page.waitForTimeout(ms)
    const state = (p) => p.evaluate(() => [document.body.dataset.state, document.body.dataset.reason || '']).catch(() => ['closed', ''])
    const settle = async (p, not) => { for (let i = 0; i < 80; i++) { const s = await state(p); if (!not.includes(s[0])) return s; await sleep(40) } return state(p) }
    const open = async (mutant, from = HOME, url, feat) => {
      handler = await site(mutant)
      for (const x of ctx.pages()) if (x !== page) await x.close().catch(() => {})
      await page.goto(from + '/?r=' + Math.random())
      const [p] = await Promise.all([ctx.waitForEvent('page'), page.evaluate(([u, f]) => HM.open(u, f), [url, feat])])
      await p.waitForLoadState().catch(() => {})
      await settle(p, ['loading'])
      return p
    }
    const sendAndSettle = async (p, m) => { await page.evaluate((x) => HM.send(x), m); return settle(p, ['loading', 'waiting']) }

    console.log('positive control')
    let p = await open(null)
    ok((await state(p))[0] === 'waiting' && (await page.evaluate(() => HM.msgs)).some((m) => m[0] === S && m[1] === 'ready'), 'bento/home opens the host and receives its ready')
    let s = await sendAndSettle(p, enrol(await keys()))
    ok(s[0] === 'consent', `a valid request shows the consent screen (${s})`)
    ok(consentHonest(await p.locator('[data-for=consent]').innerText()), 'it carries the disclaimer and claims nothing about this browser or device')

    console.log('C1  two requests back to back')
    const pair = async (mutant, runs = 8) => {
      const tally = {}
      for (let i = 0; i < runs; i++) {
        const p = await open(mutant)
        const a = await keys(), b = await keys()
        await page.evaluate(([x, y]) => HM.pair(x, y), [enrol(a, 'one'), enrol(b, 'two')])
        await sleep(300)
        const s = await settle(p, ['loading', 'waiting'])
        const k = s[0] === 'consent' ? `consent ${await p.locator('#label').innerText()}` : s.join(' ')
        tally[k] = (tally[k] || 0) + 1
      }
      return tally
    }
    let t = await pair(null)
    ok(Object.keys(t).length === 1 && t['refused one-request-per-window'] === 8, `8 back-to-back pairs all end refused (${JSON.stringify(t)})`)
    t = await pair('no-voided')
    if (webkit) ok(Object.keys(t).some((k) => k.startsWith('consent')), `MUTANT no-voided: WebKit shows the first request's consent anyway (${JSON.stringify(t)})`)
    else console.log(`  info  MUTANT no-voided in ${name}: ${JSON.stringify(t)} (this engine delivers the second message after the checks; the WebKit row is the control)`)

    console.log('a second request after the consent screen')
    const second = async (mutant) => {
      const p = await open(mutant)
      await sendAndSettle(p, enrol(await keys(), 'one'))
      await page.evaluate((x) => HM.send(x), enrol(await keys(), 'two'))
      return settle(p, ['loading', 'waiting', 'consent'])
    }
    s = await second(null)
    ok(s[0] === 'refused' && s[1] === 'one-request-per-window', `it voids the window (${s})`)
    s = await second('second-wins')
    ok(s[0] !== 'refused', `MUTANT second-wins: the window stays open to a request (${s})`)

    console.log('refusals')
    const foreign = async (mutant) => { const p = await open(mutant, ATTACKER); const n = (await page.evaluate(() => HM.msgs)).length; return [n, await sendAndSettle(p, enrol(await keys()))] }
    let [n, fs] = await foreign(null)
    ok(n === 0 && fs[0] === 'refused' && fs[1] === 'wrong-origin', `a foreign opener gets no message and its request is refused (${n}, ${fs})`)
    ;[n, fs] = await foreign('foreign-opener')
    ok(fs[0] === 'consent', `MUTANT foreign-opener: consent for attacker.example (${fs})`)
    const noop = async (mutant) => { handler = await site(mutant); await page.goto(HOME + '/?n=' + Math.random()); const [p] = await Promise.all([ctx.waitForEvent('page'), page.evaluate(() => { window.open(`${'https://signin.id.bento.page'}/`, 'n' + Math.random(), 'noopener') })]); await p.waitForLoadState().catch(() => {}); return settle(p, ['loading']) }
    s = await noop(null)
    ok(s[0] === 'refused' && s[1] === 'no-opener', `noopener: refused (${s})`)
    s = await noop('noopener')
    ok(!(s[0] === 'refused' && s[1] === 'no-opener'), `MUTANT noopener: the page carries on (${s})`)
    const shape = async (mutant) => { const k = await keys(); const p = await open(mutant); return sendAndSettle(p, { t: 'roster-add', W: k.W, kx: k.kx, label: 'backup key', cred: 'ATTACKER' }) }
    s = await shape(null)
    ok(s[0] === 'refused' && s[1] === 'not-a-request', `an opener-requested roster change: refused (${s})`)
    s = await shape('any-shape')
    ok(s[0] === 'consent', `MUTANT any-shape: consent for it (${s})`)
    for (const m of [{ t: 'delete-account' }, { t: 'signal', userId: 'x' }, 'enrol', ['enrol'], null]) {
      const p = await open(null); s = await sendAndSettle(p, m)
      ok(s[0] === 'refused', `${JSON.stringify(m)}: refused (${s})`)
    }
    const viaUrl = async (mutant) => {
      const k = await keys(), q = `t=enrol&W=${k.W}&kx=${k.kx}&label=evil`, out = []
      for (const u of [`${S}/?${q}`, `${S}/#${q}`]) out.push((await state(await open(mutant, HOME, u)))[0])
      return out
    }
    let u = await viaUrl(null)
    ok(u.every((x) => x === 'waiting'), `a request in the query or the fragment does nothing (${u})`)
    u = await viaUrl('url-params')
    ok(u.includes('consent'), `MUTANT url-params: consent from the URL (${u})`)

    console.log('C2  labels')
    for (const label of GOOD) {
      const p = await open(null); s = await sendAndSettle(p, enrol(await keys(), label))
      ok(s[0] === 'consent' && (await p.locator('#label').innerText()) === label, `shown exactly: ${JSON.stringify(label)}`)
    }
    for (const [what, label] of [...BAD, ['empty', ''], ['41 characters', 'x'.repeat(41)]]) {
      const p = await open(null); s = await sendAndSettle(p, enrol(await keys(), label))
      ok(s[0] === 'refused' && s[1] === 'bad-label', `refused: ${what} (${s})`)
    }
    let shown = 0
    for (const [, label] of BAD) { const p = await open('narrow-labels'); if ((await sendAndSettle(p, enrol(await keys(), label)))[0] === 'consent') shown++ }
    ok(shown > 0, `MUTANT narrow-labels (control characters only): ${shown}/${BAD.length} invisible labels reach the consent screen`)

    console.log('C3  what the consent screen claims')
    for (const mutant of ['claims-browser', 'claim-stays', 'claim-curly', 'claim-dt']) {
      const p = await open(mutant); await sendAndSettle(p, enrol(await keys()))
      ok(!consentHonest(await p.locator('[data-for=consent]').innerText()), `MUTANT ${mutant}: the row sees it`)
    }

    ok(sockets.length === 0, `no WebSocket opened (${sockets.length})`)
    const s2 = stray.filter((x) => !x.endsWith('/favicon.ico'))
    ok(s2.length === 0, `nothing fetched outside the routed origins (${JSON.stringify(s2.slice(0, 3))})`)
    await browser.close()
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
