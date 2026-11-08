#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Generates kernel/fixtures/webauthn-v1.json: the conformance rows for the
// offline WebAuthn assertion verifier (kernel/src/webauthn.ts).
//
//   node scripts/gen-webauthn-vectors.mjs [--rp <rpId>] [--import <dir>] [--chrome]
//
//   --rp       the relying party id (default id.bento.page).
//   --origin   the ONE origin the ceremonies run on and the fixture accepts
//              (default https://signin.<rpId>). It must be the rp host or a
//              host under it. The rp host itself, other hosts under it, its
//              parent and the parent's other hosts are refused-origin rows.
//   --import   a directory of earlier capture files (wa-<browser>.json, the
//              shape written by capture runs in other browsers) to carry in as
//              `imported` rows. Without it, imported rows already in the
//              fixture are KEPT when the rp id is unchanged, and dropped when it
//              changes (they were signed for the old rp).
//   --chrome   capture with the installed Chrome instead of Playwright's Chromium.
//   --out      write somewhere else (to try another rp id without touching the contract).
//
// Three kinds of rows:
//   real/      assertions produced HERE by a browser's own WebAuthn code under a
//              CDP virtual authenticator, every origin routed in-process (no
//              network). High-S and low-S both occur naturally; Chromium adds
//              its "other_keys_can_be_added_here" key to some.
//   imported/  real assertions from earlier capture runs (other browser builds).
//   sw/        a software authenticator in this process, for the inputs a
//              browser will not produce but a self-asserting client can:
//              duplicate keys, a string crossOrigin, odd flags, odd DER.
// Every row names the key, the expected challenge, the stored signature count
// when one applies, and the verdict with its reason. Signatures are random, so
// regenerating changes bytes, never verdicts.

import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webcrypto as wc } from 'node:crypto'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined }
const OUT = arg('--out') || join(root, 'kernel/fixtures/webauthn-v1.json')
const RP = arg('--rp') || 'id.bento.page'
if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(RP)) throw new Error('rp id: a lowercase host name')
const PARENT = RP.split('.').slice(1).join('.')
if (!PARENT.includes('.')) throw new Error('rp id must have a parent domain below the public suffix (for the parent-rp rows)')
const ORIGIN = arg('--origin') || `https://signin.${RP}`
const OHOST = new URL(ORIGIN).hostname
if (ORIGIN !== `https://${OHOST}` || (OHOST !== RP && !OHOST.endsWith('.' + RP))) throw new Error('origin: https://<the rp host or a host under it>')
const ORIGINS = [ORIGIN]
const RP_HOST = `https://${RP}`

const te = new TextEncoder()
const b64u = (b) => Buffer.from(b).toString('base64url')
const unb = (s) => new Uint8Array(Buffer.from(s, 'base64url'))
const sha = async (b) => new Uint8Array(await wc.subtle.digest('SHA-256', typeof b === 'string' ? te.encode(b) : b))
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const big = (u) => BigInt('0x' + (Buffer.from(u).toString('hex') || '0'))
const be32 = (x) => Uint8Array.from(Buffer.from(x.toString(16).padStart(64, '0'), 'hex'))
const minInt = (v) => { let i = 0; while (i < v.length - 1 && v[i] === 0) i++; v = v.slice(i); return v[0] & 0x80 ? Uint8Array.from([0, ...v]) : v }
const derOf = (r, s) => {
  const body = [0x02, r.length, ...r, 0x02, s.length, ...s]
  return Uint8Array.from([0x30, body.length, ...body])
}
const rawToDer = (raw) => derOf(minInt(raw.slice(0, 32)), minInt(raw.slice(32)))
function derToRawLoose(der) {
  let i = 2; const out = new Uint8Array(64)
  for (let p = 0; p < 2; p++) { const len = der[i + 1]; let v = der.slice(i + 2, i + 2 + len); while (v.length > 32) v = v.slice(1); out.set(v, p * 32 + 32 - v.length); i += 2 + len }
  return out
}
const isHighS = (raw) => big(raw.slice(32)) > N / 2n
const flipS = (raw) => Uint8Array.from([...raw.slice(0, 32), ...be32(N - big(raw.slice(32)))])
const cdOf = (a) => Buffer.from(unb(a.clientDataJSON)).toString('utf8')
const countOf = (a) => Buffer.from(unb(a.authenticatorData)).readUInt32BE(33)

const rows = []
const keys = {}
const row = async (name, source, key, text, assertion, expect, reason, extra = {}) => {
  const r = { name, source, key, challenge: b64u(await sha(text)), text, assertion: {
    authenticatorData: assertion.authenticatorData, clientDataJSON: assertion.clientDataJSON, signature: assertion.signature }, ...extra, expect }
  if (reason) r.reason = reason
  rows.push(r)
}

// --- real/: capture in a browser ---------------------------------------------

const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await pw.chromium.launch(process.argv.includes('--chrome') ? { channel: 'chrome' } : {})
const ctx = await browser.newContext()
await ctx.routeWebSocket(/.*/, (ws) => ws.close())
const LIB = `
const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')
const H = async (t) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))
const err = (e) => ({ error: e.name })
window.T = {
  async create(rpId, text) {
    try {
      const c = await navigator.credentials.create({ publicKey: {
        rp: { id: rpId, name: 'Bento' }, user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'alice@example.com', displayName: 'alice' },
        challenge: await H(text), pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, attestation: 'none' } })
      const k = await crypto.subtle.importKey('spki', c.response.getPublicKey(), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
      return { pub: b64u(await crypto.subtle.exportKey('raw', k)), alg: c.response.getPublicKeyAlgorithm(),
        authenticatorData: b64u(c.response.getAuthenticatorData()), clientDataJSON: b64u(c.response.clientDataJSON) }
    } catch (e) { return err(e) }
  },
  async get(rpId, text, uv = 'required') {
    try {
      const a = await navigator.credentials.get({ publicKey: { rpId, challenge: await H(text), userVerification: uv } })
      return { authenticatorData: b64u(a.response.authenticatorData), clientDataJSON: b64u(a.response.clientDataJSON), signature: b64u(a.response.signature) }
    } catch (e) { return err(e) }
  },
}`
const PAGE = (extra = '') => `<!doctype html><meta charset=utf-8><title>w</title><script>${LIB}</script>${extra}`
for (const h of new Set([OHOST, RP, `x.${OHOST}`, `x.${RP}`, PARENT])) {
  await ctx.route(`https://${h}/**`, (route) => {
    const u = new URL(route.request().url())
    if (u.pathname === '/.well-known/webauthn') return route.fulfill({ status: 404, body: '' })
    if (u.pathname === '/embed') return route.fulfill({ contentType: 'text/html',
      body: PAGE(`<iframe allow="publickey-credentials-get *" src="${ORIGIN}/inner"></iframe>`) })
    return route.fulfill({ contentType: 'text/html', body: PAGE() })
  })
}
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)
await cdp.send('WebAuthn.enable')
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
  protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
  isUserVerified: true, automaticPresenceSimulation: true } })
const ev = (fn, ...a) => page.evaluate(([fn, a]) => window.T[fn](...a), [fn, a])
const must = (x, what) => { if (!x || x.error) throw new Error(`${what}: ${x && x.error}`); return x }
const SOURCE = `${process.argv.includes('--chrome') ? 'chrome' : 'chromium'}-${browser.version()}`

await page.goto(ORIGIN + '/')
const created = must(await ev('create', RP, 'ros.setup'), 'create')
if (created.alg !== -7) throw new Error('not ES256')
keys.real = created.pub
const stmt = (i) => `wdev.real.${i}`
const gets = []
// at least 24, and keep going (to 64) until both S halves and the extra key have shown up
for (let i = 0; i < 64; i++) {
  const g = must(await ev('get', RP, stmt(i)), 'get'); gets.push(g)
  const raws = gets.map((x) => derToRawLoose(unb(x.signature)))
  if (i >= 23 && raws.some(isHighS) && raws.some((r) => !isHighS(r)) && gets.some((x) => cdOf(x).includes('other_keys'))) break
}
for (const [i, g] of gets.entries()) {
  const raw = derToRawLoose(unb(g.signature))
  await row(`real/get-${String(i).padStart(2, '0')}`, SOURCE, 'real', stmt(i), g, 'accept', undefined,
    { highS: isHighS(raw), extraKeys: cdOf(g).includes('other_keys') })
}
const hi = gets.find((g) => isHighS(derToRawLoose(unb(g.signature))))
const lo = gets.find((g) => !isHighS(derToRawLoose(unb(g.signature))))
const hiI = gets.indexOf(hi), loI = gets.indexOf(lo)
await row('real/high-s-made-low', SOURCE, 'real', stmt(hiI), { ...hi, signature: b64u(rawToDer(flipS(derToRawLoose(unb(hi.signature))))) }, 'accept', undefined, { highS: false })
await row('real/low-s-made-high', SOURCE, 'real', stmt(loI), { ...lo, signature: b64u(rawToDer(flipS(derToRawLoose(unb(lo.signature))))) }, 'accept', undefined, { highS: true })
await row('real/other-statement', SOURCE, 'real', stmt(1), gets[0], 'reject', 'challenge')
await row('real/registration-client-data', SOURCE, 'real', 'ros.setup',
  { authenticatorData: gets[0].authenticatorData, clientDataJSON: created.clientDataJSON, signature: gets[0].signature }, 'reject', 'type')
{
  const ad = unb(gets[0].authenticatorData); ad[36] ^= 1
  await row('real/authenticator-data-tampered', SOURCE, 'real', stmt(0), { ...gets[0], authenticatorData: b64u(ad) }, 'reject', 'signature')
}
const last = gets[gets.length - 1], lastC = countOf(last)
await row('real/sign-count-advances', SOURCE, 'real', stmt(gets.length - 1), last, 'accept', undefined, { storedSignCount: lastC - 1 })
await row('real/sign-count-replayed', SOURCE, 'real', stmt(gets.length - 1), last, 'reject', 'sign-count', { storedSignCount: lastC })

await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false })
{
  // Chromium's virtual authenticator refuses the ceremony outright when it cannot verify the
  // user (NotAllowedError, even with 'preferred'), so UV clear comes only from sw/uv-clear.
  const g = await ev('get', RP, 'uv-clear', 'preferred')
  if (!g.error) await row('real/uv-clear', SOURCE, 'real', 'uv-clear', g, 'reject', 'uv')
}
await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true })

// a page on the origin host can create and assert for the PARENT domain: the rpIdHash check is what refuses it
const parentKey = must(await ev('create', PARENT, 'parent-setup'), 'parent create')
keys.realParent = parentKey.pub
await row('real/parent-rp-id', SOURCE, 'realParent', 'parent', must(await ev('get', PARENT, 'parent'), 'parent get'), 'reject', 'rp')
if (OHOST !== RP) {
  // ...and for its OWN host as an rp id, a child of the real one
  const childKey = must(await ev('create', OHOST, 'child-setup'), 'child create')
  keys.realChild = childKey.pub
  await row('real/child-rp-id', SOURCE, 'realChild', 'child', must(await ev('get', OHOST, 'child'), 'child get'), 'reject', 'rp')
}

// other hosts under the rp can assert for it; only the origin list refuses them
await page.goto(`https://x.${OHOST}/`)
await row('real/subdomain-origin', SOURCE, 'real', 'sub', must(await ev('get', RP, 'sub'), 'sub get'), 'reject', 'origin')
if (OHOST !== RP) {
  await page.goto(`${RP_HOST}/`)
  await row('real/rp-host-origin', SOURCE, 'real', 'rp-host', must(await ev('get', RP, 'rp-host'), 'rp host get'), 'reject', 'origin')
  await page.goto(`https://x.${RP}/`)
  await row('real/sibling-under-rp-origin', SOURCE, 'real', 'sibling', must(await ev('get', RP, 'sibling'), 'sibling get'), 'reject', 'origin')
}

await page.goto(`https://${PARENT}/embed`)
const frame = page.frames().find((f) => f.url().startsWith(ORIGIN))
await frame.waitForFunction(() => !!window.T)
const framed = must(await frame.evaluate((rp) => window.T.get(rp, 'framed'), RP), 'framed get')
if (!cdOf(framed).includes('"crossOrigin":true')) throw new Error('framed assertion is not crossOrigin')
await row('real/framed-by-parent', SOURCE, 'real', 'framed', framed, 'reject', 'cross-origin')
await browser.close()

// --- imported/ ---------------------------------------------------------------

const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null
const importDir = arg('--import')
if (importDir) {
  for (const f of readdirSync(importDir).filter((x) => /^wa-[a-z]+\.json$/.test(x)).sort()) {
    const R = JSON.parse(readFileSync(join(importDir, f), 'utf8'))
    const rpOk = Buffer.compare(Buffer.from(unb(R.gets[0].authenticatorData).slice(0, 32)), Buffer.from(await sha(RP))) === 0
    if (!rpOk) { console.log(`skip ${f}: signed for another rp id`); continue }
    const src = `${R.channel === 'chrome' ? 'chrome' : 'chromium'}-${R.browser}`, k = `imported-${R.channel}`
    keys[k] = R.create.pub
    for (const [i, g] of R.gets.entries()) {
      const raw = derToRawLoose(unb(g.signature))
      await row(`imported/${R.channel}/get-${String(i).padStart(2, '0')}`, src, k, g.text, g, 'accept', undefined,
        { highS: isHighS(raw), extraKeys: cdOf(g).includes('other_keys') })
    }
    if (R.subGet && !R.subGet.error) await row(`imported/${R.channel}/subdomain-origin`, src, k, R.subGet.text, R.subGet, 'reject', 'origin')
    if (R.iframeAllowed && !R.iframeAllowed.error) await row(`imported/${R.channel}/framed-by-parent`, src, k, R.iframeAllowed.text, R.iframeAllowed, 'reject', 'cross-origin')
    if (R.homeGetApexRp && !R.homeGetApexRp.error) {
      keys[`${k}-parent`] = R.homeCreateApexRp.pub
      await row(`imported/${R.channel}/parent-rp-id`, src, `${k}-parent`, R.homeGetApexRp.text, R.homeGetApexRp, 'reject', 'rp')
    }
  }
} else if (prev && prev.rpId === RP) {
  for (const r of prev.rows.filter((x) => x.name.startsWith('imported/'))) { rows.push(r); keys[r.key] = prev.keys[r.key] }
}

// --- sw/: a software authenticator -------------------------------------------

const kp = await wc.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
keys.sw = b64u(await wc.subtle.exportKey('raw', kp.publicKey))
const other = await wc.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
keys.other = b64u(await wc.subtle.exportKey('raw', other.publicKey))
{ const p = unb(keys.sw); p[64] ^= 1; keys.offCurve = b64u(p) }
keys.compressed = b64u(Uint8Array.from([2 + (unb(keys.sw)[64] & 1), ...unb(keys.sw).slice(1, 33)]))

const T = 'ros.sw'
const CH = b64u(await sha(T))
const cdStd = (o = {}) => JSON.stringify({ type: 'webauthn.get', challenge: CH, origin: ORIGIN, crossOrigin: false, ...o })
async function sign(cd, { rp = RP, flags = 0x05, count = 0, ext = [], key = kp.privateKey } = {}) {
  const ad = Uint8Array.from([...(await sha(rp)), flags, ...be32(BigInt(count)).slice(28), ...ext])
  const cdB = typeof cd === 'string' ? te.encode(cd) : cd
  const raw = new Uint8Array(await wc.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, Uint8Array.from([...ad, ...(await sha(cdB))])))
  return { authenticatorData: b64u(ad), clientDataJSON: b64u(cdB), signature: b64u(rawToDer(raw)), raw }
}
const sw = (name, a, expect, reason, extra) => row(`sw/${name}`, 'software', 'sw', T, a, expect, reason, extra)

await sw('control', await sign(cdStd()), 'accept')
await sw('extra-keys', await sign(cdStd({ other_keys_can_be_added_here: 'do not compare clientDataJSON against a template.', zz: [1, { a: null }] })), 'accept')
await sw('fields-in-another-order', await sign(JSON.stringify({ origin: ORIGIN, crossOrigin: false, challenge: CH, type: 'webauthn.get' })), 'accept')
await sw('cross-origin-absent', await sign(JSON.stringify({ type: 'webauthn.get', challenge: CH, origin: ORIGIN })), 'accept')
await sw('escaped-field-values', await sign(`{"type":"webauthn\\u002eget","challenge":"${CH}","origin":${JSON.stringify(ORIGIN).replace('/', '\\/')}}`), 'accept')
await sw('backup-flags', await sign(cdStd(), { flags: 0x1d }), 'accept', { be: true, bs: true })
await sw('extension-data', await sign(cdStd(), { flags: 0x85, ext: [0xa0] }), 'accept')
// both halves of S, from one signature
{
  const a = await sign(cdStd()), r2 = flipS(a.raw)
  const [h, l] = isHighS(a.raw) ? [a.raw, r2] : [r2, a.raw]
  await sw('high-s', { ...a, signature: b64u(rawToDer(h)) }, 'accept', { highS: true })
  await sw('low-s', { ...a, signature: b64u(rawToDer(l)) }, 'accept', { highS: false })
}
// the duplicate-key family: JSON.parse keeps the last, other parsers the first
const dupOrigin = `{"type":"webauthn.get","challenge":"${CH}","origin":"https://attacker.example","crossOrigin":false,"origin":"${ORIGIN}"}`
await sw('duplicate-origin-last-wins', await sign(dupOrigin), 'reject', 'duplicate-key')
await sw('duplicate-origin-first-wins', await sign(`{"type":"webauthn.get","challenge":"${CH}","origin":"${ORIGIN}","crossOrigin":false,"origin":"https://attacker.example"}`), 'reject', 'duplicate-key')
await sw('duplicate-origin-escaped', await sign(`{"type":"webauthn.get","challenge":"${CH}","origin":"https://attacker.example","crossOrigin":false,"or\\u0069gin":"${ORIGIN}"}`), 'reject', 'duplicate-key')
await sw('duplicate-cross-origin', await sign(`{"type":"webauthn.get","challenge":"${CH}","origin":"${ORIGIN}","crossOrigin":true,"crossOrigin":false}`), 'reject', 'duplicate-key')
await sw('duplicate-nested', await sign(`{"type":"webauthn.get","challenge":"${CH}","origin":"${ORIGIN}","crossOrigin":false,"x":{"a":1,"a":2}}`), 'reject', 'duplicate-key')
// type
await sw('type-create', await sign(cdStd({ type: 'webauthn.create' })), 'reject', 'type')
await sw('type-missing', await sign(JSON.stringify({ challenge: CH, origin: ORIGIN, crossOrigin: false })), 'reject', 'type')
// challenge
await sw('challenge-other', await sign(cdStd({ challenge: b64u(await sha('ros.other')) })), 'reject', 'challenge')
await sw('challenge-padded', await sign(cdStd({ challenge: CH + '=' })), 'reject', 'challenge')
await sw('challenge-truncated', await sign(cdStd({ challenge: b64u(unb(CH).slice(0, 31)) })), 'reject', 'challenge')
await sw('challenge-text-not-hash', await sign(cdStd({ challenge: b64u(te.encode(T)) })), 'reject', 'challenge')
{
  // the same 32 bytes with nonzero trailing bits: decodes alike in a lenient decoder
  const last = CH[CH.length - 1], alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const bumped = CH.slice(0, -1) + alpha[alpha.indexOf(last) ^ 1]
  await sw('challenge-noncanonical', await sign(cdStd({ challenge: bumped })), 'reject', 'challenge')
}
// the caller's challenge: WebAuthn's minimum is 16 bytes; shorter is a caller error even when clientData agrees
await sw('challenge-empty', await sign(cdStd({ challenge: '' })), 'reject', 'grammar', { challenge: '', text: null })
{
  const c15 = (await sha('fifteen')).slice(0, 15), c16 = (await sha('sixteen')).slice(0, 16)
  await sw('challenge-15-bytes', await sign(cdStd({ challenge: b64u(c15) })), 'reject', 'grammar', { challenge: b64u(c15), text: null })
  await sw('challenge-16-bytes', await sign(cdStd({ challenge: b64u(c16) })), 'accept', undefined, { challenge: b64u(c16), text: null })
}
await sw('challenge-missing', await sign(JSON.stringify({ type: 'webauthn.get', origin: ORIGIN, crossOrigin: false })), 'reject', 'challenge')
// origin
for (const [n, o] of [...(OHOST !== RP ? [['rp-host', RP_HOST], ['sibling-under-rp', `https://x.${RP}`]] : []),
  ['parent', `https://${PARENT}`], ['sibling-host', `https://home.${PARENT}`], ['subdomain', `https://x.${OHOST}`],
  ['foreign', 'https://attacker.example'], ['http', `http://${OHOST}`], ['trailing-slash', `${ORIGIN}/`], ['explicit-port', `${ORIGIN}:443`],
  ['uppercase', `https://${OHOST.toUpperCase()}`], ['suffix-lookalike', `https://${OHOST}.attacker.example`], ['null', 'null']]) {
  await sw(`origin-${n}`, await sign(cdStd({ origin: o })), 'reject', 'origin')
}
await sw('origin-not-a-string', await sign(cdStd({ origin: [ORIGIN] })), 'reject', 'origin')
await sw('origin-missing', await sign(JSON.stringify({ type: 'webauthn.get', challenge: CH, crossOrigin: false })), 'reject', 'origin')
// cross-origin
await sw('cross-origin-true', await sign(cdStd({ crossOrigin: true })), 'reject', 'cross-origin')
await sw('cross-origin-string-false', await sign(cdStd({ crossOrigin: 'false' })), 'reject', 'cross-origin')
await sw('cross-origin-null', await sign(cdStd({ crossOrigin: null })), 'reject', 'cross-origin')
await sw('cross-origin-zero', await sign(cdStd({ crossOrigin: 0 })), 'reject', 'cross-origin')
await sw('top-origin-present', await sign(cdStd({ topOrigin: ORIGIN })), 'reject', 'cross-origin')
// rp
await sw('rp-parent', await sign(cdStd(), { rp: PARENT }), 'reject', 'rp')
await sw('rp-subdomain', await sign(cdStd(), { rp: `x.${RP}` }), 'reject', 'rp')
await sw('rp-origin-string', await sign(cdStd(), { rp: ORIGIN }), 'reject', 'rp')
// flags
await sw('up-clear', await sign(cdStd(), { flags: 0x04 }), 'reject', 'up')
await sw('uv-clear', await sign(cdStd(), { flags: 0x01 }), 'reject', 'uv')
await sw('attested-data-flag', await sign(cdStd(), { flags: 0x45 }), 'reject', 'grammar')
await sw('trailing-bytes-without-ed', await sign(cdStd(), { ext: [0xa0] }), 'reject', 'grammar')
await sw('ed-without-extension-bytes', await sign(cdStd(), { flags: 0x85 }), 'reject', 'grammar')
await sw('backed-up-not-eligible', await sign(cdStd(), { flags: 0x15 }), 'reject', 'grammar')
// clientDataJSON grammar
await sw('byte-order-mark', await sign(Uint8Array.from([0xef, 0xbb, 0xbf, ...te.encode(cdStd())])), 'reject', 'grammar')
{
  // a lone 0xff INSIDE a string value: a lenient decoder makes it U+FFFD and the JSON still parses
  const [pre, post] = cdStd({ x: 'PLACEHOLDER' }).split('PLACEHOLDER')
  await sw('invalid-utf8', await sign(Uint8Array.from([...te.encode(pre), 0xff, ...te.encode(post)])), 'reject', 'grammar')
}
await sw('top-level-array', await sign(`[${cdStd()}]`), 'reject', 'grammar')
await sw('trailing-comma', await sign(cdStd().slice(0, -1) + ',}'), 'reject', 'grammar')
await sw('lone-surrogate', await sign(cdStd({ x: 'PLACEHOLDER' }).replace('PLACEHOLDER', '\\ud800')), 'reject', 'grammar')
await sw('trailing-garbage', await sign(cdStd() + 'x'), 'reject', 'grammar')
await sw('control-character', await sign(cdStd({ x: 'PLACEHOLDER' }).replace('PLACEHOLDER', '\u0001')), 'reject', 'grammar')
{
  const a = await sign(cdStd())
  await sw('field-padded-base64', { ...a, authenticatorData: Buffer.from(unb(a.authenticatorData)).toString('base64') }, 'reject', 'grammar')
  await sw('authenticator-data-short', { ...a, authenticatorData: b64u(unb(a.authenticatorData).slice(0, 36)) }, 'reject', 'grammar')
}
// signature encoding
{
  const a = await sign(cdStd())
  const r = a.raw.slice(0, 32), s = a.raw.slice(32)
  {
    // a leading zero the encoding does not need (r's top bit clear, so DER forbids it)
    let b = a
    while (b.raw[0] & 0x80 || b.raw[0] === 0) b = await sign(cdStd())
    await sw('der-non-minimal', { ...b, signature: b64u(derOf(Uint8Array.from([0, ...minInt(b.raw.slice(0, 32))]), minInt(b.raw.slice(32)))) }, 'reject', 'signature')
  }
  {
    // a byte after the two integers, with the SEQUENCE length counting it (only the end check sees it)
    const d = unb(a.signature)
    await sw('der-trailing-byte', { ...a, signature: b64u(Uint8Array.from([0x30, d[1] + 1, ...d.slice(2), 0])) }, 'reject', 'signature')
    // a SEQUENCE length that disagrees with the bytes, nothing trailing (only the length check sees it)
    await sw('der-sequence-length', { ...a, signature: b64u(Uint8Array.from([0x30, d[1] + 1, ...d.slice(2)])) }, 'reject', 'signature')
  }
  await sw('raw-not-der', { ...a, signature: b64u(a.raw) }, 'reject', 'signature')
  await sw('der-s-zero', { ...a, signature: b64u(derOf(minInt(r), Uint8Array.from([0]))) }, 'reject', 'signature')
  await sw('der-r-is-n', { ...a, signature: b64u(derOf(minInt(be32(N)), minInt(s))) }, 'reject', 'signature')
  {
    // a VALID signature whose r has its top bit set, written without the 0x00 pad DER needs:
    // the same (r, s), so only the negative-integer check refuses it (a second encoding of one signature)
    let b = a
    while (!(b.raw[0] & 0x80)) b = await sign(cdStd())
    await sw('der-negative', { ...b, signature: b64u(derOf(b.raw.slice(0, 32), minInt(b.raw.slice(32)))) }, 'reject', 'signature')
  }
  // r = s = 0: the "psychic signature" shape (CVE-2022-21449), which some ECDSA verifiers accepted for any message
  await sw('der-r-s-zero', { ...a, signature: b64u(Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x00, 0x02, 0x01, 0x00])) }, 'reject', 'signature')
  await sw('client-data-tampered', { ...a, clientDataJSON: b64u(te.encode(cdStd({ extra: 1 }))) }, 'reject', 'signature')
  await row('sw/another-key', 'software', 'other', T, a, 'reject', 'signature')
  await row('sw/key-off-curve', 'software', 'offCurve', T, a, 'reject', 'key')
  await row('sw/key-compressed', 'software', 'compressed', T, a, 'reject', 'key')
}
// the signature counter
for (const [count, stored, expect] of [[0, undefined, 'accept'], [0, 0, 'accept'], [7, 0, 'accept'], [5, 4, 'accept'],
  [5, 5, 'reject'], [5, 6, 'reject'], [0, 3, 'reject']]) {
  const name = `sign-count-${count}-stored-${stored === undefined ? 'none' : stored}`
  await sw(name, await sign(cdStd(), { count }), expect, expect === 'reject' ? 'sign-count' : undefined, stored === undefined ? {} : { storedSignCount: stored })
}

const out = {
  version: 1,
  about: 'Conformance rows for verifying a WebAuthn assertion offline (kernel/src/webauthn.ts). Every row is verified with ' +
    'publicKey = keys[row.key], challenge = base64url-decode(row.challenge) (= SHA-256 of row.text), rpId and origins as below, ' +
    'and storedSignCount when the row has one. Match the verdict; match the reason where you can. TEST KEYS ONLY.',
  rpId: RP,
  origins: ORIGINS,
  keys,
  rows,
}
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
const real = rows.filter((r) => r.name.startsWith('real/get-') || /^imported\/[a-z]+\/get-/.test(r.name))
console.log(`${OUT}: ${rows.length} rows (${real.length} real accepts: ${real.filter((r) => r.highS).length} high-S, ${real.filter((r) => r.extraKeys).length} with extra keys)`)
