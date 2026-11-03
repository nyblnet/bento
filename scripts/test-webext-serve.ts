#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// home/webext — serving a verified document with identity (bento/connect W2).
//
//   node scripts/test-webext-serve.ts
//
// WHAT THIS PROVES (so far: the release histories gate 1 checks against, and
// what may become running script in the sandbox).
//   · A history is held only if it verifies under the release key, names the
//     right app, is well-formed, and kernel's acceptHistory accepts it over
//     what is held (anti-rollback: an older signed history can't hide a release).
//   · It is fetched at most daily, never for someone who hasn't used identity
//     opening, and a failed fetch keeps what is held.
// The corpus's signed history (home/fixtures/gate1/history.json) and its
// throwaway test key stand in for the real ones.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const H = await import('../home/webext/src/serve/history.js')
const G = await import('../home/webext/src/id/gen/gate1.js')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const FIX = join(root, 'home/fixtures/gate1')
const signed = readFileSync(join(FIX, 'history.json'), 'utf8')
const jwk = JSON.parse(readFileSync(join(FIX, 'test-public-key.json'), 'utf8'))
const payload = JSON.parse(JSON.parse(signed).payload)
const APPS = [{ id: 'test', appId: payload.app }]
const DAY = H.DAY
let clock = Date.UTC(2026, 9, 21)
const storage = () => { const m = new Map<string, any>(); return { m, get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: any) => { m.set(k, structuredClone(v)) } } }
const net = (body: string | null, status = 200) => { const calls: string[] = []; return { calls, fetch: async (u: string) => { calls.push(u); if (body === null) throw new TypeError('offline'); return { ok: status === 200, status, text: async () => body } } } }
const deps = (s: any, n: any) => ({ get: s.get, set: s.set, fetch: n.fetch, now: () => clock, jwk })

console.log('\n— holding a verified history')
{
  const s = storage(), n = net(signed)
  const r = await H.refresh(APPS, deps(s, n))
  ok(r[payload.app] === 'updated' && n.calls[0] === `${H.BASE}/test/history.json`, 'a signed, well-formed history for the app is fetched from bento.page and held')
  const held = await H.heldHistories(deps(s, n))
  ok(JSON.stringify(held[payload.app]) === JSON.stringify(payload), 'what is held is exactly the signed payload')
  // and gate 1 can use it: a genuine corpus file is genuine against the held history
  const genuine = readFileSync(join(FIX, 'served/genuine-1.2.0.html'), 'utf8')
  const v = await G.verifyServed(genuine, held[payload.app])
  ok(v.verdict === 'genuine' && v.release.version === '1.2.0', 'gate 1 matches a genuine file against the held history')
  // fresh: no refetch inside a day
  clock += DAY / 2
  const again = await H.refresh(APPS, deps(s, n))
  ok(again[payload.app] === 'fresh' && n.calls.length === 1, 'not fetched again within a day')
  clock += DAY
  await H.refresh(APPS, deps(s, n))
  ok(n.calls.length === 2, 'fetched again after a day')
}

console.log('\n— refusing what must not be held')
{
  const bad = (mut: (o: any) => void) => { const o = JSON.parse(signed); mut(o); return JSON.stringify(o) }
  const cases: [string, string, string][] = [
    ['a payload changed after signing', bad((o) => { o.payload = o.payload.replace('1.2.0', '1.2.9') }), 'signature'],
    ['a missing signature', bad((o) => { delete o.sig }), 'not signed'],
    ['not JSON', 'nope', 'not valid JSON'],
  ]
  for (const [label, body, why] of cases) {
    const s = storage()
    const r = await H.refresh(APPS, deps(s, net(body)))
    ok(String(r[payload.app]).startsWith('refused') && String(r[payload.app]).includes(why) && !(await H.heldHistories(deps(s, net(body))))[payload.app], `${label} is refused and nothing is held`)
  }
  const s = storage()
  const r = await H.refresh([{ id: 'test', appId: 'bento-slides' }], deps(s, net(signed)))
  ok(r['bento-slides'] === 'refused: history for another app', 'a genuine history for ANOTHER app is refused (sibling channels on one origin)')
}

console.log('\n— anti-rollback, and failures keep what is held')
{
  const s = storage()
  await H.refresh(APPS, deps(s, net(signed)))
  // a REPLAYED older history, validly signed: the rig signs with its own key
  // pair, so refresh's own anti-rollback check is what's under test
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
  const sign = async (p: any) => {
    const text = JSON.stringify(p)
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(text)))
    return JSON.stringify({ payload: text, sig: Buffer.from(sig).toString('base64') })
  }
  const own = storage()
  const ownDeps = (n: any) => ({ ...deps(own, n), jwk: pubJwk })
  ok((await H.refresh(APPS, ownDeps(net(await sign(payload)))))[payload.app] === 'updated', 'a history signed by the (rig\'s) release key is held')
  clock += 2 * DAY
  const older = { ...payload, releases: payload.releases.slice(1) }
  const replay = await H.refresh(APPS, ownDeps(net(await sign(older))))
  ok(String(replay[payload.app]).startsWith('refused') && (await H.heldHistories(ownDeps(net(null))))[payload.app].releases.length === payload.releases.length,
    `a REPLAYED older history, validly signed, is refused by refresh and the newer one stays held (${replay[payload.app]})`)
  clock += 2 * DAY
  const r = await H.refresh(APPS, deps(s, net(null)))
  ok(String(r[payload.app]).startsWith('refused') && (await H.heldHistories(deps(s, net(null))))[payload.app]?.releases.length === payload.releases.length, 'offline: the refresh fails and what is held stays')
  const r2 = await H.refresh(APPS, deps(s, net('x', 503)))
  ok(r2[payload.app] === 'http 503' && !!(await H.heldHistories(deps(s, net(null))))[payload.app], 'a server error keeps what is held')
}

console.log('\n— no phone-home for someone who never used it')
{
  const s = storage(), n = net(signed)
  const r = await H.refreshIfUsed(APPS, deps(s, n))
  ok(r.skipped === 'never used' && n.calls.length === 0, 'the browser-start refresh makes NO request until identity opening has been used')
  await s.set(H.USED_KEY, true)
  await H.refreshIfUsed(APPS, deps(s, n))
  ok(n.calls.length === 1, 'after it has been used, the browser-start refresh fetches')
}

console.log('\n— prepare: gate 1 decides, against the held histories (every served corpus row)')
const P = await import('../home/webext/src/serve/prepare.js')
const EXP = JSON.parse(readFileSync(join(FIX, 'expected.json'), 'utf8'))
const histories = { [payload.app]: payload }
{
  let agree = 0
  for (const row of EXP.served) {
    const html = readFileSync(join(FIX, row.case), 'utf8')
    const r = await P.prepare(html, histories)
    const want = row.verdict === 'genuine' ? 'genuine' : 'unknown'
    if (r.verdict === want && (want === 'unknown' || r.release.version === row.release)) agree++
    else console.log(`        ${row.case}: got ${r.verdict}, expected ${want}`)
  }
  ok(agree === EXP.served.length, `prepare reaches the corpus verdict on every served row (${agree}/${EXP.served.length})`)
  const genuine = readFileSync(join(FIX, 'served/genuine-1.2.0.html'), 'utf8')
  ok((await P.prepare(genuine, {})).verdict === 'unknown', 'with NO history held, even a genuine file is UNKNOWN (never a guess)')
  const two = await P.prepare(genuine, { a: payload, b: payload })
  ok(two.verdict === 'unknown' && /^2 held histories match/.test(two.reason), `a file matching two apps is UNKNOWN (${two.reason})`)
}

console.log('\n— splice: only the planned elements become blob: scripts')
{
  for (const name of ['genuine-1.0.0.html', 'genuine-1.2.0.html', 'genuine-1.1.0-shared-runtime.html']) {
    const html = readFileSync(join(FIX, 'served', name), 'utf8')
    const r = await P.prepare(html, histories)
    const urls: string[] = []
    const out = P.splice(html, r.plan, (text: string) => { urls.push(text); return `blob:test/${urls.length}` })
    const scripts = G.scanBlocks(out).filter((b: any) => b.tag === 'script')
    const exec = G.executableScripts(G.scanBlocks(out))
    ok(r.plan.length >= 1 && urls.length === r.plan.length && exec.length === r.plan.length && exec.every((b: any) => b.text === '' && /^blob:test\/\d+$/.test(b.src)), `${name}: each executable element (${r.plan.length}) became an EMPTY script loading a blob:, and nothing else became one`)
    const before = G.scanBlocks(html).filter((b: any) => !G.executableScripts([b]).length).map((b: any) => b.text)
    const after = scripts.filter((b: any) => !b.src).map((b: any) => b.text).concat(G.scanBlocks(out).filter((b: any) => b.tag === 'style').map((b: any) => b.text))
    ok(before.every((t: string) => after.includes(t)), `${name}: data blocks and styles pass through byte for byte`)
    ok(urls.join('\u0000') === r.plan.map((p: any) => p.text).join('\u0000'), `${name}: the blob: contents are exactly the verified texts, in document order`)
  }
  const html = readFileSync(join(FIX, 'served/genuine-1.2.0.html'), 'utf8')
  const r = await P.prepare(html, histories)
  const throws = (f: () => unknown) => { try { f(); return false } catch { return true } }
  ok(throws(() => P.splice(html + ' ', [...r.plan].reverse(), () => 'blob:x')) || r.plan.length < 2, 'a plan out of document order is refused')
  ok(throws(() => P.splice('<p>other</p>' + html, r.plan, () => 'blob:x')), 'a plan that does not line up with the bytes is refused')
}

// --- the REAL release, frozen (kernel real/slides-1.2.10): the extension's own
// refresh with its PINNED release key, then prepare, exactly as on bento.page
{
  const SNAP = join(FIX, 'real/slides-1.2.10')
  const { RELEASE_KEY } = await import('../home/webext/src/release.js')
  const files: Record<string, string> = { 'https://bento.page/releases/slides/history.json': readFileSync(join(SNAP, 'history.json'), 'utf8') }
  const m = new Map()
  const deps = { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: unknown) => { m.set(k, v) }, fetch: async (u: string) => (u in files ? new Response(files[u]) : new Response('', { status: 404 })), now: () => Date.now(), jwk: RELEASE_KEY }
  const rep = await H.refresh([{ id: 'slides', appId: 'bento-slides' }, { id: 'spaces', appId: 'bento-spaces' }, { id: 'dash', appId: 'bento-dash' }], deps)
  ok(rep['bento-slides'] === 'updated', `the real slides history verifies under the extension's PINNED release key (${JSON.stringify(rep)})`)
  const held = await H.heldHistories(deps)
  const shell = readFileSync(join(SNAP, 'Bento_Slides.bento.html'), 'utf8')
  const v = await P.prepare(shell, held)
  ok(v.verdict === 'genuine' && v.appId === 'bento-slides' && v.release.version === '1.2.10', `the real 1.2.10 shell (an EMPTY document block, naming no app) is GENUINE as bento-slides 1.2.10 (${v.verdict} ${v.appId ?? v.reason})`)
  const rt = shell.indexOf('id="bento-rt"'); const at = shell.indexOf('>', rt) + 20
  ok((await P.prepare(shell.slice(0, at) + (shell[at] === 'A' ? 'B' : 'A') + shell.slice(at + 1), held)).verdict === 'unknown', 'CONTROL: the same shell with one runtime byte changed is UNKNOWN')
  const wrong = await H.refresh([{ id: 'slides', appId: 'bento-dash' }], { ...deps, get: async () => null, set: async () => {} })
  ok(wrong['bento-dash'] !== 'updated', `the real slides history is refused when offered as another app's (${JSON.stringify(wrong)})`)
}

// --- the host's port: only the fixed shape is acted on ------------------------
{
  const { parseRequest, answer } = await import('../home/webext/src/serve/host.js')
  const good = [
    { id: 's1', op: 'identity.whoami', args: null },
    { id: 's2', op: 'identity.sign', args: { purpose: 'frame', payload: '0.x' } },
    { id: 's3', op: 'identity.resolve', args: { pub: null, email: 'a@b.c' } },
    { id: 's4', op: 'save.write', args: { text: '<!doctype html>' } },
  ]
  ok(good.every((g) => JSON.stringify(parseRequest(g)) === JSON.stringify(g)), 'each well-formed request parses to exactly itself')
  const bad: [string, unknown][] = [
    ['not an object', 'identity.whoami'],
    ['an array', [1, 2]],
    ['an unknown op', { id: 's1', op: 'identity.export', args: null }],
    ['an extra top-level field', { id: 's1', op: 'identity.whoami', args: null, consent: 'granted' }],
    ['a consent outcome dressed as an op', { id: 's1', op: 'consent.granted', args: null }],
    ['a missing id', { op: 'identity.whoami', args: null }],
    ['an id that is not a short token', { id: 'x'.repeat(40), op: 'identity.whoami', args: null }],
    ['whoami with arguments', { id: 's1', op: 'identity.whoami', args: { who: 1 } }],
    ['sign with an unknown purpose', { id: 's1', op: 'identity.sign', args: { purpose: 'anything', payload: 'x' } }],
    ['sign with an extra field', { id: 's1', op: 'identity.sign', args: { purpose: 'frame', payload: 'x', approved: true } }],
    ['sign with a non-string payload', { id: 's1', op: 'identity.sign', args: { purpose: 'frame', payload: { a: 1 } } }],
    ['sign with an oversized payload', { id: 's1', op: 'identity.sign', args: { purpose: 'frame', payload: 'x'.repeat(5000) } }],
    ['resolve with a missing field', { id: 's1', op: 'identity.resolve', args: { pub: null } }],
    ['save.write naming its own path', { id: 's1', op: 'save.write', args: { text: 'x', path: '/etc/passwd' } }],
    ['save.write with a non-string text', { id: 's1', op: 'save.write', args: { text: 42 } }],
  ]
  for (const [why, m] of bad) ok(parseRequest(m) === null, `refused: ${why}`)
  // a request's object never reaches answer() — only the parsed copy does
  const proto = Object.create({ inherited: 1 })
  ok(parseRequest(Object.assign(proto, { id: 's1', op: 'identity.whoami', args: null }))?.hasOwnProperty('inherited') === false, 'the parsed request is a fresh plain object')
  let wrote = ''
  const deps = { writeFile: async (t: string) => { wrote = t; return { ok: true } } }
  ok((await answer(parseRequest(good[0])!, deps)) === null, 'whoami answers null (no verified Bento ID yet)')
  ok(JSON.stringify(await answer(parseRequest(good[1])!, deps)) === '{"ok":false,"reason":"no-identity"}', 'sign answers no-identity')
  ok(JSON.stringify(await answer(parseRequest(good[3])!, deps)) === '{"ok":true}' && wrote === '<!doctype html>', 'save.write writes exactly the text, to the path the HOST opened (none is accepted from the frame)')
}

// --- "Open with Bento ID" exists only behind BOTH gates ------------------------
{
  const { servedOpenAllowed, SETTING_KEY } = await import('../home/webext/src/serve/gate.js')
  ok(servedOpenAllowed('development', true) === true, 'an unpacked install with the setting turned on: offered')
  ok(servedOpenAllowed('development', undefined) === false && servedOpenAllowed('development', null) === false, 'an unpacked install with the setting ABSENT (the default): not offered')
  ok(servedOpenAllowed('development', false) === false, 'an unpacked install with the setting off: not offered')
  for (const it of ['normal', 'sideload', 'admin', 'other', null, undefined])
    ok(servedOpenAllowed(it, true) === false, `a ${String(it)} install with the setting on: not offered`)
  for (const v of ['true', 1, {}, [true]]) ok(servedOpenAllowed('development', v) === false, `a setting of ${JSON.stringify(v)} is not true: not offered`)
  ok(SETTING_KEY === 'serveWithIdentity', 'the setting has one name')
  const serve = readFileSync(join(root, 'home/webext/src/serve/serve.js'), 'utf8')
  ok(/if \(!\(await servedOpenEnabled\(\)\)\) return asItself/.test(serve) && serve.indexOf('servedOpenEnabled()') < serve.indexOf('await fetch(fileUrl)'), 'the host page checks both gates itself, before it reads the file (it is reachable by URL)')
  const home = readFileSync(join(root, 'home/webext/src/home.js'), 'utf8')
  ok(!/function openDoc[^}]*serve\.html/.test(home), "the library's own Open is untouched: it never routes to the served path")
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
