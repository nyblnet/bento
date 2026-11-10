// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The bento/id void page (server/directory/src/voidpage.js) in a real browser.
//
//   node scripts/test-directory-void-page.mjs            # Playwright's headless shell
//   node scripts/test-directory-void-page.mjs --chrome   # the installed Google Chrome
//
// https://id.bento.page is the REAL directory worker and Roster object, run in
// this process against an in-memory store and routed into the browser;
// https://attacker.example is a page that frames it. Every other request is
// refused and every WebSocket is closed (the rig fails if one was opened).
// Waiting changes are planted in the store with a known void token, so each
// row starts from the state a mailed link would find.
//
// What it must prove (R10 on the void page, G3, G4c):
//   · opening a link sends nothing but the page's own three GETs, and takes
//     the token out of the address bar;
//   · the buttons follow the link's kind, and the directory refuses a button
//     an edited link shows, without spending the token;
//   · Cancel, Remove and Undo each send one POST and say what happened; a used
//     link says so;
//   · the page's CSP stops injected inline script (positive control: the same
//     injection runs once the CSP is gone), it cannot be framed, Trusted Types
//     are enforced, and an address full of markup is shown as text.
//   · a link whose life ended says how (too late, with when; already used; a
//     reset cancelled it), an unknown link never says "Nothing changed", a
//     link another press holds says wait, and C3's restored removal and
//     re-timed reset are shown.
//
// Each rule has a MUTANT: a copy of the directory with one edit to the page,
// under which a row must go red. A mutant whose edit no longer applies fails.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildRos } from '../kernel/src/roster.ts'
import { sha256b64u } from '../kernel/src/statements.ts'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const CHROME = process.argv.includes('--chrome')
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIR = 'https://id.bento.page', ATTACKER = 'https://attacker.example'

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

// ---- the directory, honest or with one page rule broken -----------------------
// [from, to] edits to server/directory/src/voidpage.js, each occurring exactly once.
const MUTANTS = {
  // R10: inline script allowed by the CSP
  'csp-inline': [[`  "script-src 'self'",`, `  "script-src 'self' 'unsafe-inline'",`]],
  // R10 / G9'.3: framing allowed
  'framed': [[`  "frame-ancestors 'none'",\n`, ''], ["  'x-frame-options': 'DENY',\n", '']],
  // R10: opening the page acts
  'post-on-open': [["  $('cancel').addEventListener('click', () => send('cancel'))\n", "  $('cancel').addEventListener('click', () => send('cancel'))\n  if (kind === 'c' || kind === 'o') send('cancel')\n"]],
  // G3: the token stays in the address bar and the history entry
  'keep-fragment': [["  if (location.hash) history.replaceState(null, '', location.pathname)\n", '']],
  // the address through an HTML sink
  'innerHTML': [["for (const el of document.querySelectorAll('[data-address]')) el.textContent = email", "for (const el of document.querySelectorAll('[data-address]')) el.innerHTML = email"]],
  // Trusted Types not enforced
  'no-tt': [[`  "require-trusted-types-for 'script'",\n`, '']],
  // G4c: Remove shown whatever the link says
  'remove-always': [["    $('remove').hidden = kind !== 'c'\n", "    $('remove').hidden = false\n"]],
  // the page says "cancelled" whatever the directory answered
  'trust-nothing': [["    if (r && r.ok && j.done === 'cancelled') {", "    if (j.done === 'cancelled' || true) {"]],
  // F2: a link that came too late shown as unknown
  'late-as-unknown': [["    if (j.error === 'late' && typeof j.at === 'number') { $('late-text').textContent = late(j); return show('late') }\n", '']],
  // F2: the unknown view says nothing changed
  'unknown-nothing-changed': [['The latest email about your bento/id passkeys lists them as they are now.</p>', 'Nothing changed.</p>']],
  // F1: busy shown as unknown
  'busy-as-unknown': [["    if (j.error === 'busy') return again(", "    if (false) return again("]],
  // C6: the old advice
  'hint-benign': [['your passkey was used for something you did not intend. Choose Cancel: it is always safe.', 'the usual cause is a page that used your own passkey: choose Cancel.']],
  // C3: the restored removal not mentioned
  'no-back': [["      if (typeof j.removesAt === 'number') { $('back-at').textContent = at(j.removesAt); $('back').hidden = false }\n", '']],
}
const tmp = mkdtempSync(join(tmpdir(), 'void-page-'))
async function directory(mutant) {
  let base = ROOT
  if (mutant) {
    base = join(tmp, mutant)
    for (const p of ['kernel/src', 'server/directory/src']) cpSync(join(ROOT, p), join(base, p), { recursive: true })
    const f = join(base, 'server/directory/src/voidpage.js')
    let text = readFileSync(f, 'utf8')
    for (const [from, to] of MUTANTS[mutant]) {
      const n = text.split(from).length - 1
      if (n !== 1) throw new Error(`mutant ${mutant}: its edit occurs ${n} times, not once; update the mutant`)
      text = text.replace(from, () => to)
    }
    writeFileSync(f, text)
  }
  const mod = await import(pathToFileURL(join(base, 'server/directory/src/worker.js')).href)
  return mod
}

// ---- an in-memory Durable Object namespace and the env --------------------------
function namespace(Klass, env) {
  const objs = new Map()
  return {
    objs,
    idFromName: (n) => n,
    get(id) {
      if (!objs.has(id)) {
        const store = new Map()
        const state = { storage: {
          async get(k) { return structuredClone(store.get(k)) },
          async put(k, v) { store.set(k, structuredClone(v)) },
          async delete(k) { for (const x of [].concat(k)) store.delete(x) },
          async list(o = {}) {
            const all = [...store].filter(([k]) => !o.prefix || k.startsWith(o.prefix)).sort(([a], [b]) => (a < b ? -1 : 1))
            return new Map(all.slice(0, o.limit ?? all.length).map(([k, v]) => [k, structuredClone(v)]))
          },
          async setAlarm() {}, async getAlarm() { return null },
        } }
        objs.set(id, { obj: new Klass(state, env), store })
      }
      const { obj } = objs.get(id)
      return { fetch: (u, init) => obj.fetch(u instanceof Request ? u : new Request(u, init)) }
    },
  }
}
const dirKp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const DIR_KEY_JWK = JSON.stringify(await crypto.subtle.exportKey('jwk', dirKp.privateKey))
async function world(mod) {
  const mails = []
  const env = { DIR_KID: 'dir-1', DIR_KEY_JWK, CHALLENGE_KEY: 'k'.repeat(48), MAILER: { send: (m) => { mails.push(m) } } }
  env.ROSTER = namespace(mod.Roster, env)
  env.LEDGER = namespace(mod.Ledger, env)
  return { env, mails, handler: (req) => mod.default.fetch(req, env) }
}

// ---- planting a waiting change with a known void token --------------------------
const b64u = (b) => Buffer.from(b).toString('base64url')
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
const sha256hex = async (t) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))
const pubKey = async () => b64u(await crypto.subtle.exportKey('raw', (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])).publicKey))
const pk = (pub, quarantined = false) => ({ kind: 'pk', pub, quarantined })
let addrN = 0
/** A fresh address with a waiting change whose void link has `kind`; returns { email, token, store }. */
async function plant(w, kind) {
  const email = `void${++addrN}@example.com`
  const token = b64u(crypto.getRandomValues(new Uint8Array(32)))
  const now = Date.now()
  const A = await pubKey(), B = await pubKey(), N = await pubKey()
  const rp = kind === 'rp' // a reset waiting over a removal it set aside (C3); `token` is the reset's, `undo` the removal's
  if (rp) kind = 'r'
  const members = kind === 'o' ? [pk(A)] : kind === 'u' || rp ? [pk(A), pk(B, true)] : [pk(A), pk(B)]
  const ros = buildRos({ address: email, seq: 0, prev: null, members, dirNonce: b64u(crypto.getRandomValues(new Uint8Array(16))), created: now })
  const hash = await sha256b64u(ros)
  const nextMembers = kind === 'r' ? [pk(N)] : kind === 'u' ? [pk(A)] : [...members, pk(N)]
  const next = buildRos({ address: email, seq: 1, prev: hash, members: nextMembers, dirNonce: b64u(crypto.getRandomValues(new Uint8Array(16))), created: now })
  const pend = {
    ros: next, hash: await sha256b64u(next), requestedAt: now, ripensAt: now + 72 * 3_600_000, mailed: true,
    voidTok: await sha256hex(`bento-dir/1/void\n${token}`), voidKind: kind,
    ...(kind === 'r' ? { kind: 'reset', change: { op: 'reset', pub: N }, reg: { credId: 'bmV3', signCount: 0, origin: 'https://signin.id.bento.page' }, how: 'browser' }
      : kind === 'u' ? { kind: 'removal', change: { op: 'remove', pub: B }, cause: hash }
        : { kind: 'member', change: { op: 'add', pub: N }, signer: A, credId: 'QQ', assertion: {}, how: 'browser' }),
  }
  const { addressKey } = await import('../server/directory/src/address.js')
  w.env.ROSTER.get(await addressKey(email))
  const store = w.env.ROSTER.objs.get(await addressKey(email)).store
  store.set('head', { ros, hash, seq: 0, members, ripenedAt: now, createdAt: now })
  for (const m of members) store.set(`pk:${m.pub}`, { credId: b64u(new TextEncoder().encode(m.pub.slice(0, 8))), signCount: 0, addedAt: now, how: 'setup' })
  const undo = b64u(crypto.getRandomValues(new Uint8Array(32)))
  if (rp) {
    const x = buildRos({ address: email, seq: 1, prev: hash, members: [pk(A)], dirNonce: b64u(crypto.getRandomValues(new Uint8Array(16))), created: now })
    pend.parked = { kind: 'removal', ros: x, hash: await sha256b64u(x), change: { op: 'remove', pub: B }, cause: hash, requestedAt: now, ripensAt: now + 72 * 3_600_000, mailed: true, voidTok: await sha256hex(`bento-dir/1/void\n${undo}`), voidKind: 'u' }
  }
  store.set('pend', pend)
  return { email, token, undo, store }
}
/** A link whose life ended `why` (F2): no change waits, the directory remembers the token's hash. */
async function plantEnded(w, why, by) {
  const p = await plant(w, 'c')
  p.store.delete('pend')
  p.store.set('ended', [{ h: await sha256hex(`bento-dir/1/void\n${p.token}`), why, at: Date.parse('2026-11-09T09:00:00Z'), ...(by ? { by } : {}) }])
  return p
}
const linkOf = (p, kind = p.kind ?? 'c') => {
  const f = new URLSearchParams()
  f.set('v', '1'); f.set('e', p.email); f.set('t', p.token); f.set('k', kind)
  return `${DIR}/void#${f}`
}

// ---- the browser --------------------------------------------------------------
const browser = await chromium.launch({ ...(CHROME ? { channel: 'chrome' } : {}), headless: true })
console.log(`${CHROME ? 'Google Chrome' : 'Playwright headless shell'} ${browser.version()}`)
const sockets = []

/** A context whose id.bento.page is `w`, with an optional rewrite of the page's answer. */
async function ctx(w, o = {}) {
  const c = await browser.newContext()
  const seen = []
  await c.routeWebSocket(/.*/, (ws) => { sockets.push(ws.url()); ws.close() })
  await c.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url())
    if (url.origin === ATTACKER) return route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: o.attacker ?? '<!doctype html><p>attacker</p>' })
    if (url.origin !== DIR) return route.abort()
    seen.push({ method: req.method(), path: url.pathname, body: req.postData() ?? '' })
    const r = await w.handler(new Request(req.url(), { method: req.method(), headers: req.headers(), body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer() }))
    let headers = Object.fromEntries(r.headers.entries())
    let body = Buffer.from(await r.arrayBuffer())
    if (url.pathname === '/void') {
      if (o.rewrite) body = Buffer.from(o.rewrite(body.toString()))
      if (o.strip) headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !o.strip.includes(k)))
    }
    return route.fulfill({ status: r.status, headers, body })
  })
  c.setDefaultTimeout(3000)
  const page = await c.newPage()
  return { c, page, seen }
}
/** A fresh page at `url` (a second goto that only changes the fragment would not reload). */
async function fresh(c, url) {
  const page = await c.newPage()
  await page.goto(url)
  await settle(page)
  return page
}
const visible = (page, sel) => page.locator(sel).isVisible()
const settle = (page) => page.waitForFunction(() => document.querySelector('#loading')?.hidden !== false, null, { timeout: 3000 }).catch(() => {})

/** All rows against one directory. Prints each when `loud`; returns the failure count. */
async function rows(mod, loud) {
  const before = failures
  const say = loud ? ok : (c, m) => { checks++; if (!c) failures++; void m }
  const w = await world(mod)
  /** a block that throws (a mutant can hang a click) counts as a red row, never a crash */
  const block = async (name, f) => { try { await f() } catch (e) { say(false, `${name} threw: ${String(e.message).split('\n')[0]}`) } }

  // 1. opening sends nothing but the page's own GETs, and takes the token out of the address bar
  await block('block 1', async () => {
    const p = await plant(w, 'c'); p.kind = 'c'
    const { c, page, seen } = await ctx(w)
    await page.goto(linkOf(p))
    await settle(page)
    await page.waitForTimeout(300)
    const reqs = seen.map((r) => `${r.method} ${r.path}`).sort()
    say(JSON.stringify(reqs) === JSON.stringify(['GET /void', 'GET /void.css', 'GET /void.js']), `opening sends exactly the page's three GETs (${reqs.join(', ')})`)
    say(!page.url().includes('#') && !page.url().includes(p.token), `the token is out of the address bar (${page.url()})`)
    say(p.store.get('pend')?.voidTok !== undefined, 'opening changed nothing')
    say(await visible(page, '#change') && await visible(page, '#remove') && await visible(page, '#hint-c') && !(await visible(page, '#hint-o')), 'a member change link (k=c) shows Cancel and Remove, with the advice on which to pick')
    const hint = await page.locator('#hint-c').textContent()
    say(hint.includes('your passkey was used for something you did not intend. Choose Cancel: it is always safe.') && !hint.includes('usual cause'), 'the advice never calls an unasked change benign (C6)')
    say(await page.locator('[data-address]').first().textContent() === p.email, 'the page names the address')
    // Cancel: one POST, and the page reports what the directory did
    await page.click('#cancel')
    await page.locator('#cancelled').waitFor({ timeout: 3000 }).catch(() => {})
    const posts = seen.filter((r) => r.method === 'POST')
    say(posts.length === 1 && posts[0].path === '/v1/void' && JSON.parse(posts[0].body).choice === 'cancel' && JSON.parse(posts[0].body).token === p.token, 'Cancel sends one POST /v1/void with the token and the choice')
    say(await visible(page, '#cancelled') && /cannot ask for another change until/.test(await page.locator('#cool').textContent()), 'the page says it is cancelled and names the cooldown')
    say(p.store.get('pend') === undefined, 'the change is gone')
    // the same link again: the page says it no longer works
    const again = await c.newPage()
    await again.goto(linkOf(p))
    await settle(again)
    await again.click('#cancel')
    await again.locator('#used').waitFor({ timeout: 3000 }).catch(() => {})
    say(await visible(again, '#used') && (await again.locator('#used-at').textContent()).length > 0 && !/Nothing changed/.test(await again.locator('#used').textContent()),
      'the same link opened again: "already used", with when, and never "Nothing changed"')
    // the history entry no longer holds the token: reloading it finds no link
    const ph = await fresh(c, linkOf(p))
    await ph.reload()
    await settle(ph)
    say(await visible(ph, '#bad') && !ph.url().includes(p.token), 'reloading the page\'s history entry finds no token in it')
    await c.close()
  })

  // 2. the buttons follow the link's kind; an edited link's extra button is refused, the token kept
  await block('block 2', async () => {
    const p = await plant(w, 'o')
    const { c, page } = await ctx(w)
    await page.goto(linkOf(p, 'o'))
    await settle(page)
    say(await visible(page, '#change') && !(await visible(page, '#remove')) && await visible(page, '#hint-o'), 'k=o: Cancel only (the requester is the only live member)')
    const page2 = await fresh(c, linkOf(p, 'c'))
    await page2.click('#remove')
    await page2.waitForFunction(() => document.getElementById('msg').textContent !== '', null, { timeout: 3000 }).catch(() => {})
    say(/not offered/.test(await page2.locator('#msg').textContent()) && p.store.get('pend')?.voidTok !== undefined && !(await page2.locator('#cancel').isDisabled()),
      'an edited link (k=c) shows Remove; the directory refuses it, the page says so, the token still works')
    await page2.click('#cancel')
    await page2.locator('#cancelled').waitFor({ timeout: 3000 }).catch(() => {})
    say(await visible(page2, '#cancelled') && p.store.get('pend') === undefined, 'its Cancel then works')
    for (const [k, id] of [['r', '#reset'], ['u', '#undo']]) {
      const q = await plant(w, k)
      const pk = await fresh(c, linkOf(q, k))
      say(await visible(pk, id) && !(await visible(pk, '#remove')) && !(await visible(pk, '#change')), `k=${k}: only its own button`)
    }
    for (const bad of [`${DIR}/void#v=1&e=a%40b.c&t=${'A'.repeat(43)}`, `${DIR}/void#v=1&e=a%40b.c&t=${'A'.repeat(43)}&k=c&x=1`, `${DIR}/void#v=2&e=a%40b.c&t=${'A'.repeat(43)}&k=c`, `${DIR}/void`]) {
      const pb = await fresh(c, bad)
      say(await visible(pb, '#bad') && !(await visible(pb, '#cancel')), `a malformed link shows "incomplete" and no button (${bad.slice(DIR.length, DIR.length + 40)}...)`)
    }
    await c.close()
  })

  // 3. Remove and Undo
  await block('block 3', async () => {
    const p = await plant(w, 'c')
    const { c, page, seen } = await ctx(w)
    await page.goto(linkOf(p, 'c'))
    await settle(page)
    await page.click('#remove')
    await page.locator('#suspended').waitFor({ timeout: 3000 }).catch(() => {})
    say(await visible(page, '#suspended') && (await page.locator('#removes').textContent()).length > 0, 'Remove: the page says the passkey is suspended and when it goes')
    say(p.store.get('pend')?.kind === 'removal' && p.store.get('head')?.members.some((m) => m.quarantined), 'the directory suspended it and queued its removal')
    const m = w.mails.filter((x) => x.kind === 'void').pop()
    const undo = m?.body.match(/https:\/\/id\.bento\.page\/void#\S+/)?.[0]
    say(!!undo && /k=u/.test(undo), 'the removal mail carries an undo link')
    const pu = await fresh(c, undo ?? `${DIR}/void`)
    await pu.click('#undo-btn')
    await pu.locator('#restored').waitFor({ timeout: 3000 }).catch(() => {})
    say(await visible(pu, '#restored') && p.store.get('pend') === undefined && !p.store.get('head')?.members.some((x) => x.quarantined), 'Undo from that link: the passkey is back')
    say(seen.filter((r) => r.method === 'POST').length === 2, 'two presses, two POSTs')
    await c.close()
  })

  // 4. the CSP stops injected script; positive control without it
  await block('block 4', async () => {
    const p = await plant(w, 'c')
    const inject = (h) => h.replace('</main>', '<script>window.__inj = 1</script><img src="data:," onerror="window.__inj2 = 1"></main>')
    const a = await ctx(w, { rewrite: inject })
    await a.page.goto(linkOf(p, 'c'))
    await settle(a.page)
    await a.page.waitForTimeout(200)
    const blocked = await a.page.evaluate(() => [window.__inj, window.__inj2])
    say(blocked[0] === undefined && blocked[1] === undefined && await visible(a.page, '#change'), 'injected inline script and handler are blocked; the page still works')
    await a.c.close()
    const b = await ctx(w, { rewrite: inject, strip: ['content-security-policy'] })
    await b.page.goto(linkOf(p, 'c'))
    await b.page.waitForTimeout(300)
    const ran = await b.page.evaluate(() => [window.__inj, window.__inj2])
    say(ran[0] === 1 && ran[1] === 1, 'control: the same injection runs once the CSP header is gone')
    await b.c.close()
    // Trusted Types: an HTML sink throws on the real page
    const t = await ctx(w)
    await t.page.goto(linkOf(p, 'c'))
    await settle(t.page)
    const tt = await t.page.evaluate(() => { try { document.body.insertAdjacentHTML('beforeend', '<b>x</b>'); return 'allowed' } catch (e) { return e.name } })
    say(tt === 'TypeError', `Trusted Types refuse an HTML sink (${tt})`)
    await t.c.close()
  })

  // 5. an address full of markup is text
  await block('block 5', async () => {
    const p = await plant(w, 'c')
    const evil = { ...p, email: '"><img src=x onerror="window.__x=1">@example.com' }
    const { c, page } = await ctx(w)
    await page.goto(linkOf(evil, 'c'))
    await settle(page)
    await page.waitForTimeout(200)
    say(await page.locator('[data-address]').first().textContent() === evil.email && await page.locator('main img').count() === 0 && await page.evaluate(() => window.__x) === undefined,
      'an address carrying markup is shown as text, nothing runs')
    await c.close()
  })

  // 6. no framing
  await block('block 6', async () => {
    const p = await plant(w, 'c')
    const { c, page, seen } = await ctx(w, { attacker: `<!doctype html><iframe id=f src="${linkOf(p, 'c')}" width=600 height=400></iframe>` })
    await page.goto(`${ATTACKER}/`)
    await page.waitForTimeout(800)
    const f = page.frames().find((x) => x !== page.mainFrame())
    let shown = false
    try { shown = !!f && await f.locator('#cancel').isVisible({ timeout: 300 }) } catch { shown = false }
    say(!shown && !seen.some((r) => r.path === '/void.js'), 'framed by another origin: the page does not load (no script fetched, no button)')
    await c.close()
  })
  // 7. F2: a link whose life ended says how; a busy link says wait; C3's extra sentences
  await block('block 7', async () => {
    const { c } = await ctx(w)
    const press = async (p, kind, id) => {
      const pg = await fresh(c, linkOf(p, kind))
      await pg.click(id)
      await pg.waitForFunction(() => document.querySelector('[data-view]:not([hidden])')?.id !== 'change' && document.querySelector('[data-view]:not([hidden])')?.id !== 'undo' && document.querySelector('[data-view]:not([hidden])')?.id !== 'reset' || document.getElementById('msg').textContent !== '', null, { timeout: 3000 }).catch(() => {})
      return pg
    }
    const lateC = await plantEnded(w, 'late')
    const pl = await press(lateC, 'c', '#cancel')
    const lt = await pl.locator('#late').textContent()
    say(await visible(pl, '#late') && /took effect at/.test(lt) && lt.includes('Your bento/id passkeys changed') && !/Nothing changed/.test(lt), `Cancel after the change took effect: "Too late", when, and where the passkeys are listed (${lt.trim().slice(0, 80)})`)
    const lateU = await plantEnded(w, 'late', 'reset')
    const pu = await press(lateU, 'u', '#undo-btn')
    const ut = await pu.locator('#late').textContent()
    say(await visible(pu, '#late') && /was reset at/.test(ut) && ut.includes('Your bento/id account was reset'), 'an undo after a reset took effect: "Too late", the account was reset')
    const pre = await plantEnded(w, 'preempted')
    const pp = await press(pre, 'c', '#cancel')
    say(await visible(pp, '#preempted') && (await pp.locator('#preempted-at').textContent()).length > 0, 'a change a reset cancelled: the page says a reset cancelled it')
    const gone = await plant(w, 'c')
    gone.store.delete('pend')
    const pg = await press(gone, 'c', '#cancel')
    say(await visible(pg, '#unknown') && !/Nothing changed/.test(await pg.locator('#unknown').textContent()), 'a link the directory does not know: "no longer works", never "Nothing changed"')
    // busy: another press holds the roster
    const busy = await plant(w, 'c')
    busy.store.set('hold', { id: 'x', what: 'remove', until: Date.now() + 60_000 })
    const pb = await press(busy, 'c', '#cancel')
    say(/another tab or window/.test(await pb.locator('#msg').textContent()) && !(await pb.locator('#cancel').isDisabled()) && busy.store.get('pend')?.voidTok !== undefined,
      'while another press holds the roster: the page says wait and try again, the buttons come back, nothing was spent')
    // C3: stopping a reset puts the removal it set aside back; undoing that removal re-times the reset
    const rp1 = await plant(w, 'rp')
    const pr = await press(rp1, 'r', '#cancel-reset')
    say(await visible(pr, '#cancelled') && await visible(pr, '#back') && (await pr.locator('#back-at').textContent()).length > 0 && rp1.store.get('pend')?.kind === 'removal',
      'stopping a reset that set a removal aside: the page says the removal waits again, and until when')
    const rp2 = await plant(w, 'rp')
    const pv = await press({ ...rp2, token: rp2.undo }, 'u', '#undo-btn')
    say(await visible(pv, '#restored') && await visible(pv, '#reset-again') && rp2.store.get('pend')?.kind === 'reset',
      'the set-aside removal\'s undo while the reset waits: the passkey is back, and the page says when the reset now takes effect')
    await c.close()
  })
  return failures - before
}

// ---- run: the honest directory, then each mutant -------------------------------
console.log('the void page, as built')
await rows(await directory(null), true)
const only = process.argv.find((a, i) => i > 1 && !a.startsWith('--'))
for (const name of Object.keys(MUTANTS).filter((n) => !only || n.includes(only))) {
  const f0 = failures, c0 = checks
  let red
  try { red = await rows(await directory(name), false) } catch (e) { console.log(`  FAIL  mutant ${name} could not run: ${e.message}`); failures++; continue }
  failures = f0; checks = c0
  ok(red > 0, `mutant ${name}: ${red} row(s) red`)
}
ok(sockets.length === 0, `no WebSocket was opened (${sockets.length})`)
await browser.close()
rmSync(tmp, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
