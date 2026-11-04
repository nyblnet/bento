#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/id directory rig, part 2: device linking (link v1) and the key-blob
// store (passkeys, the recovery code, the access ledger, the signed status read).
//
//   node scripts/test-directory-keys.ts
//
// Drives the REAL worker and its Durable Object classes against an in-memory
// namespace and a hand-moved clock, like scripts/test-directory.ts. What it must
// prove, each refusal beside a control that succeeds:
//   · link: a slot completes once; a second scanner CONTENDS it and both sides
//     are told; the sealed key is released only after H's consent (purpose link,
//     audience dir, over N's dev.) verifies against the LIVE binding, with the
//     challenge spent first, only while active, and every link notifies;
//   · passkeys: registration needs an account-signed dreq. over the exact
//     registration bytes AND consent; a fetch is one WebAuthn ceremony on a
//     single-use challenge, refused while frozen, and notified;
//   · recovery: the verifier is stored only peppered; a right one starts a 72 h
//     wait; the blob is released once and the code is then spent; attempts are
//     capped, failures lock, everything notifies; pepper versions upgrade on use
//     and an unknown version is never picked;
//   · the ledger keeps only bucket sizes and the current key's blob;
//   · nothing secret (tok, verifier, inner blob) is stored in the clear;
//   · notices: mail capped per address, unsigned kinds coalesced and budgeted
//     apart, so they can neither evict nor starve the signed ones;
//   · D1b: contest (old key, only while pending) and owner freeze by dreq.;
//     resolution by the recovery code + a self-signed new binding (no vouch);
//     the holder-delete window (§39.6): a new key over a holder tomb waits out
//     72 h, the tombstoned key may contest, the verifier is kept, then dropped.
//   · resolving an EMAIL-ONLY freeze waits 72 h, and the frozen key may freeze or
//     contest it meanwhile (then nothing settles); a key-holder freeze resolves
//     at once; a code from before a rotation never resolves the later key's freeze;
//   · the code is spent only when a resolution COMMITS (at once or at settle): a
//     voided one leaves it live, and the freeze is then CONTESTED, so every later
//     resolution of it waits 72 h (the owner-wins sequence), and the frozen key
//     signs nothing but freeze/contest while one waits;
//   · contested shows in the SIGNED status read only (never the public lookup),
//     with an uncontested freeze as the control;
//   · link completion is ONE text (kernel's msg3) through ONE verifier
//     (kernel's verifyLinkRelease): n≠h, active-only, h-no-consent, grammar,
//     and the slot stores kernel's linkTokHash;
//   · the bind re-check answers only for the exact bound statement, with its state;
//   · the setup allowance: a two-proof bind may stand in for ABSENT consent on the
//     first passkey and code, once each, for 15 minutes, only for a key that has
//     never had either, only into empty slots, and anything else ends it;
//   · a rebound takes the old key's passkeys and code; a same-key renewal and a
//     vouched rotation do not;
//   · a passkey consents for its own key only. After a settled vouched rotation the
//     previous key's may consent to cred-add, and nothing else, until the new key's
//     first credential or 30 days; then they are deleted, with a notice, and its blob
//     is stale from the settle on. A rebound and a recovery get no grace;
//   · a recovery code enrolled under 72 h before the freeze resolves as an email-only
//     freeze does, on any account: it waits, and the frozen key can void it. Time spent
//     frozen does not age it. enrol() below ages every code past that, as the rows mean
//     a long-held one; `young: true` keeps it fresh;
//   · a key's `ever:` flag ends only after a deletion, at the deleted binding's own
//     expiry, and a re-bind before then cancels that;
//   · a rekey that fails is recorded and retried (next authorize, or the alarm), so
//     old passkeys can't strand the new key's first one.

import worker, { Account, Address, Cred, Ledger, Link } from '../server/directory/src/worker.js'
import { addressKey } from '../server/directory/src/address.js'
import { bucket, KEYS } from '../server/directory/src/account.js'
import {
  b64uDec, b64uEnc, buildBind, buildCmp, buildConsent, buildDev, buildDreq, consentTranscript, dreqArg,
  sha256b64u as hashOf, signStatement, webauthnChallengeFor,
} from '../kernel/src/statements.ts'
import { buildFinal, linkTokHash } from '../kernel/src/link.ts'

let fails = 0, passes = 0
const ok = (c: unknown, n: string) => { if (c) passes++; else { fails++; console.log('FAIL ' + n) } }

// ---------- clock ----------
let now = Date.parse('2026-11-03T09:00:00Z')
Date.now = () => now
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, MONTH = 30.44 * DAY

// ---------- in-memory Durable Object namespaces ----------
const stores = new Map<string, Map<string, unknown>>() // `${class}:${id}` → storage
const instances = new Map<string, unknown>() // `${class}:${id}` → the object, for alarms
const accountAlarm = async (id: string) => (instances.get(`Account:${id}`) as { alarm(): Promise<void> }).alarm()
const addressAlarm = async (id: string) => (instances.get(`Address:${id}`) as { alarm(): Promise<void> }).alarm()
const alarms = new Map<string, number>() // `${class}:${id}` → when its alarm is set for
// a DO call that fails: the next `n` calls of this op on this class throw before they arrive
let chaos: { cls: string; op: string; n: number } | null = null
const failing = (cls: string, op: string, n: number) => { chaos = { cls, op, n } }
function namespace(name: string, Klass: new (state: unknown, env: unknown) => { fetch(r: Request): Promise<Response> }) {
  const objs = new Map<string, { fetch(r: Request): Promise<Response> }>()
  return {
    idFromName: (n: string) => n,
    get(id: string) {
      if (!objs.has(id)) {
        const store = new Map<string, unknown>()
        stores.set(`${name}:${id}`, store)
        const state = {
          storage: {
            async get(k: string) { return structuredClone(store.get(k)) },
            async put(k: string, v: unknown) { store.set(k, structuredClone(v)) },
            async delete(k: string | string[]) { for (const x of [].concat(k as never)) store.delete(x) },
            async list(o?: { prefix?: string }) { return new Map([...store].filter(([k]) => k.startsWith(o?.prefix ?? ''))) },
            async setAlarm(t: number) { alarms.set(`${name}:${id}`, t) },
          },
        }
        objs.set(id, new Klass(state, env))
        instances.set(`${name}:${id}`, objs.get(id))
      }
      const obj = objs.get(id)!
      return {
        fetch: async (u: string | Request, init?: RequestInit) => {
          const r = u instanceof Request ? u : new Request(u, init)
          if (chaos && chaos.cls === name && chaos.n > 0 && (await r.clone().json().catch(() => ({}))).op === chaos.op) { chaos.n--; throw new Error('rig: this call fails') }
          return obj.fetch(r)
        },
      }
    },
  }
}
const store = (cls: string, id: string) => stores.get(`${cls}:${id}`)
const dump = () => JSON.stringify([...stores.entries()].map(([k, v]) => [k, [...v.entries()]]))

// ---------- keys ----------
const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const
async function signer() {
  const kp = (await crypto.subtle.generateKey(EC, true, ['sign', 'verify'])) as CryptoKeyPair
  const pub = b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)))
  return { pub, sign: (t: string) => signStatement(kp.privateKey, t), kp }
}
async function kxPub() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  return b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)))
}
const rnd = (n: number) => (n <= 65536 ? crypto.getRandomValues(new Uint8Array(n)) : new Uint8Array(n).fill(7))
const r64 = (n: number) => b64uEnc(rnd(n))
const sha = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b))
const enc = (t: string) => new TextEncoder().encode(t)
const dir = await signer()

// ---------- env + mail capture ----------
type Mail = { to: string; subject: string; body: string; code: string; kind: string }
const mailbox: Mail[] = []
const env: Record<string, unknown> = {
  DIR_KID: 'dir-1', DIR_KEY_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', dir.kp.privateKey)),
  MAILER: { send: (m: Mail) => { mailbox.push(m) } },
  CHALLENGE_KEY: 'rig-challenge-secret-0123456789abcdef',
  PEPPER_V1: r64(32),
  LINKING: '1', KEYSTORE: '1',
}
env.ADDRESS = namespace('Address', Address as never)
env.LEDGER = namespace('Ledger', Ledger as never)
env.CRED = namespace('Cred', Cred as never)
env.ACCOUNT = namespace('Account', Account as never)
env.LINK = namespace('Link', Link as never)
const codeFor = (to: string) => [...mailbox].reverse().find((m) => m.to === to && m.code)?.code
const noticesTo = (to: string, kind: string) => mailbox.filter((m) => m.to === to && m.kind === kind).length

let ipN = 0
const freshIp = () => `10.1.${Math.floor(++ipN / 250)}.${ipN % 250}`
async function api(path: string, body?: unknown, method = 'POST') {
  const r = await worker.fetch(new Request('https://id.bento.page' + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': freshIp() },
  }), env as never)
  let j: Record<string, unknown> = {}
  try { j = await r.json() } catch { /* empty */ }
  return { status: r.status, j }
}
const reason = (r: { j: Record<string, unknown> }) => String(r.j.reason ?? r.j.error)

// ---------- people, bindings, devices, consent ----------
type P = { email: string; k: Awaited<ReturnType<typeof signer>>; kx: string }
async function person(email: string): Promise<P> { return { email, k: await signer(), kx: await kxPub() } }
async function bind(p: P, o: { setup?: boolean } = {}) {
  now += 2 * MIN // past the per-address mail cooldown
  const text = buildBind({ address: p.email, accountPub: p.k.pub, kx: p.kx, name: null, seq: 1, prev: null, created: now, expires: Math.floor(now + 13 * MONTH) })
  await api('/v1/bind/start', { stmt: text, sig: await p.k.sign(text) })
  const code = codeFor(p.email)!
  const c = await api('/v1/bind/complete', { email: p.email, code, sig: await p.k.sign(buildCmp(await hashOf(text), code)) })
  if (c.status !== 200) throw new Error('bind failed for ' + p.email)
  if (!o.setup) now += 16 * MIN // past the setup allowance: only its own rows run inside it
  return text
}
const lookup = async (email: string) => api('/v1/lookup?e=' + encodeURIComponent(email), undefined, 'GET')
const challengeFor = async (email: string) => String((await api('/v1/challenge', { email })).j.challenge)

async function device(owner: P, o: { consent?: boolean; account?: P } = {}) {
  const dev = await signer(), cns = await signer()
  const acct = o.account ?? owner
  const text = buildDev({ devicePub: dev.pub, consentPub: o.consent === false ? null : cns.pub, accountPub: acct.k.pub, kx: await kxPub(), label: null, created: now, expires: now + 30 * DAY })
  return { dev: text, devSig: await acct.k.sign(text), cnsKey: cns, devicePub: dev.pub }
}
type D = Awaited<ReturnType<typeof device>>
async function nativeConsent(d: D, challenge: string, payload: string, o: { audience?: string; purpose?: string; exp?: number } = {}) {
  const transcript = (await consentTranscript(o.audience ?? 'dir', challenge, payload))!
  const cns = buildConsent({ rp: 'bento', purpose: (o.purpose ?? 'link') as never, docId: null, transcript, exp: o.exp ?? now + 2 * MIN })
  return { dev: d.dev, devSig: d.devSig, cns, cnsSig: await d.cnsKey.sign(cns) }
}
async function freezeByEmail(p: P) {
  now += 2 * MIN
  await api('/v1/freeze/start', { email: p.email })
  const t = [...mailbox].reverse().find((m) => m.to === p.email && (m as unknown as { freezeToken?: string }).freezeToken) as unknown as { freezeToken: string }
  return api('/v1/freeze/complete', { email: p.email, token: t.freezeToken })
}

// =====================================================================
// device linking (link v1, security §39.1)
// =====================================================================
{
  const sentToks = new Set<string>() // every tok the rig sent: none may be stored
  const link = (op: string, body: Record<string, unknown>) => { if (typeof body.tok === 'string') sentToks.add(body.tok); return api('/v1/link/' + op, body) }
  const msg = () => r64(120)
  async function slot(o: { fill?: number } = {}) {
    const id = r64(32), tok = r64(32), m = [msg(), msg(), msg()]
    const opened = await link('open', { id, tok, msg: m[0] })
    if ((o.fill ?? 2) >= 1) await link('put', { id, tok, n: 1, msg: m[1] })
    if ((o.fill ?? 2) >= 2) await link('put', { id, tok, n: 2, msg: m[2] })
    return { id, tok, m, opened }
  }

  const H = await person('link-h@example.com')
  await bind(H)
  const hd = await device(H)
  // H builds N's dev. (account-signed) from what N sent in msg2
  const nDevFor = async (owner: P, o: { account?: P } = {}) => { const n = await device(owner, o); return { nDev: n.dev, nDevSig: n.devSig, n } }
  // the sealed payload is iv ‖ account scalar ‖ address ‖ tag, 61 to 314 bytes (opaque to the directory)
  const sealed92 = () => r64(92)
  // H's message 3, ONE text, built with kernel's buildFinal: the directory gets nothing else
  async function msg3For(p: P, h: D, o: { ch: string; nd?: Awaited<ReturnType<typeof nDevFor>>; consent?: { cns: string; cnsSig: string }; hDev?: string; hDevSig?: string; sealed?: string }) {
    const nd = o.nd ?? await nDevFor(p)
    const c = o.consent ?? await nativeConsent(h, o.ch, nd.nDev)
    return buildFinal({ hDev: o.hDev ?? h.dev, hDevSig: o.hDevSig ?? h.devSig, cns: c.cns, cnsSig: c.cnsSig, nDev: nd.nDev, nDevSig: nd.nDevSig, sealed: o.sealed ?? sealed92() })
  }
  async function complete(s: { id: string; tok: string }, p: P, h: D, o: { ch?: string; nd?: Awaited<ReturnType<typeof nDevFor>>; consent?: { cns: string; cnsSig: string }; hDev?: string; hDevSig?: string; sealed?: string; msg3?: string; extra?: Record<string, unknown> } = {}) {
    const ch = o.ch ?? await challengeFor(p.email)
    const msg3 = o.msg3 ?? await msg3For(p, h, { ...o, ch })
    return link('complete', { id: s.id, tok: s.tok, email: p.email, challenge: ch, msg3, ...(o.extra ?? {}) })
  }

  // OFF unless LINKING=1
  delete env.LINKING
  ok((await link('open', { id: r64(32), tok: r64(32), msg: msg() })).status === 404, 'link routes answer 404 unless LINKING=1 (no pinned directory key or K6 bytes yet)')
  env.LINKING = '1'

  // the honest link (the control for every refusal below)
  {
    const s = await slot({ fill: 0 })
    ok(s.opened.status === 200, 'D opens a slot with msg0')
    ok((await link('get', { id: s.id, tok: s.tok, n: 0 })).j.msg === s.m[0], 'S reads msg0')
    ok((await link('get', { id: s.id, tok: s.tok, n: 1 })).status === 202, 'msg1 not written yet → 202 pending')
    ok((await link('put', { id: s.id, tok: s.tok, n: 1, msg: s.m[1] })).status === 200, 'S writes msg1')
    ok((await link('put', { id: s.id, tok: s.tok, n: 2, msg: s.m[2] })).status === 200, 'N writes msg2')
    ok((await link('get', { id: s.id, tok: s.tok, n: 2 })).j.msg === s.m[2], 'H reads msg2')
    const before = noticesTo(H.email, 'link')
    const sealed = sealed92()
    const ch = await challengeFor(H.email)
    const m3 = await msg3For(H, hd, { ch, sealed })
    const c = await complete(s, H, hd, { ch, msg3: m3 })
    ok(c.status === 200, `CONTROL: H completes with its consent over N's dev. (${c.status} ${reason(c)})`)
    ok(noticesTo(H.email, 'link') === before + 1, 'the link is notified to the verified address')
    const notice = mailbox[mailbox.length - 1]
    ok(!notice.body.includes(sealed.slice(0, 20)) && notice.code === '', 'the notice carries no code and nothing from the slot')
    const g = await link('get', { id: s.id, tok: s.tok, n: 3 })
    ok(g.status === 200 && g.j.msg === m3 && Object.keys(g.j).length === 1, "N receives H's message 3 exactly as written (for kernel's openFinal), and nothing else")
    ok((await link('abort', { id: s.id, tok: s.tok })).status === 200, 'N deletes the slot when done')
    ok((await link('get', { id: s.id, tok: s.tok, n: 3 })).status === 409, 'a deleted slot answers nothing more')
    ok((await link('open', { id: s.id, tok: s.tok, msg: msg() })).status === 409, 'and cannot be reopened in its window')
  }

  // tok, sizes, order
  {
    const s = await slot({ fill: 0 })
    ok((await link('get', { id: s.id, tok: r64(32), n: 0 })).status === 403, 'a wrong tok is refused')
    ok((await link('put', { id: s.id, tok: r64(32), n: 1, msg: msg() })).status === 403, 'a wrong tok cannot write (and cannot contend the slot)')
    ok((await link('put', { id: s.id, tok: s.tok, n: 2, msg: msg() })).status === 400, 'msg2 before msg1 → refused (order)')
    ok((await link('put', { id: s.id, tok: s.tok, n: 1, msg: b64uEnc(rnd(4097)) })).status === 400, 'a 4097-byte message → refused')
    ok((await link('put', { id: s.id, tok: s.tok, n: 1, msg: b64uEnc(rnd(4096)) })).status === 200, 'CONTROL: a 4096-byte message is accepted')
    ok((await link('put', { id: s.id, tok: s.tok, n: 3, msg: msg() })).status === 400, 'msg3 cannot be written by put')
    ok((await link('open', { id: 'short', tok: s.tok, msg: msg() })).status === 400, 'a malformed slot id is refused')
    now += 10 * MIN + 1
    ok((await link('get', { id: s.id, tok: s.tok, n: 0 })).status === 404, 'a slot is gone 10 minutes after it opened')
  }

  // (b) a second scanner: CONTENDED, both sides told
  {
    const s = await slot({ fill: 1 })
    const second = await link('put', { id: s.id, tok: s.tok, n: 1, msg: msg() })
    ok(second.status === 409 && second.j.error === 'contended', 'a second scanner writing msg1 → CONTENDED')
    ok((await link('get', { id: s.id, tok: s.tok, n: 0 })).j.error === 'contended', 'the displayer is told: contended')
    ok((await link('get', { id: s.id, tok: s.tok, n: 1 })).j.error === 'contended', 'the first scanner is told: contended')
    ok(!JSON.stringify([...store('Link', s.id)!.entries()]).includes(s.m[1]), 'a contended slot drops its messages')
    const s2 = await slot({ fill: 2 })
    ok((await link('put', { id: s2.id, tok: s2.tok, n: 2, msg: msg() })).j.error === 'contended', 'a second msg2 also contends')
    const s3 = await slot({ fill: 0 })
    ok((await link('open', { id: s3.id, tok: s3.tok, msg: msg() })).j.error === 'contended', 'the same code opened twice → contended')
    ok((await complete(s2, H, hd)).status === 409, 'a contended slot cannot complete')
  }

  // the directory completes a slot ONCE (condition 5)
  {
    const s = await slot()
    const first = await complete(s, H, hd)
    ok(first.status === 200, 'CONTROL: the first completion succeeds')
    const second = await complete(s, H, hd)
    ok(second.status === 409 && second.j.error === 'completed', 'a second completion is refused')
    ok((await link('get', { id: s.id, tok: s.tok, n: 3 })).status === 409, 'and the slot is deleted')
  }
  {
    const s = await slot({ fill: 1 })
    ok((await complete(s, H, hd)).status === 400, 'completion before msg2 → refused')
  }

  // (c) the production consent verifier: relay, replay, payload swap, expiry, purpose
  {
    const nd = await nDevFor(H)
    const tries: [string, (ch: string) => Promise<unknown>, string][] = [
      ['RELAY: a cns. for another audience', async (ch) => nativeConsent(hd, ch, nd.nDev, { audience: 'room:w' + 'A'.repeat(43) }), 'cns-'],
      ['PAYLOAD SWAP: a cns. over another dev.', async (ch) => nativeConsent(hd, ch, (await nDevFor(H)).nDev), 'cns-'],
      ['EXPIRED: a cns. past its exp', async (ch) => nativeConsent(hd, ch, nd.nDev, { exp: now - 1 }), 'cns-'],
      ['a cns. with purpose rotate', async (ch) => nativeConsent(hd, ch, nd.nDev, { purpose: 'rotate' }), 'cns-'],
      ['a cns. from a device certified by ANOTHER account', async (ch) => nativeConsent(await device(await person('x@example.com')), ch, nd.nDev), 'cns-'],
    ]
    for (const [name, make, want] of tries) {
      const s = await slot()
      const ch = await challengeFor(H.email)
      const before = noticesTo(H.email, 'link')
      const r = await complete(s, H, hd, { ch, nd, consent: await make(ch) as { cns: string; cnsSig: string } })
      ok(r.status === 400 && reason(r).startsWith(want), `${name} → refused (${reason(r)})`)
      ok((await link('get', { id: s.id, tok: s.tok, n: 3 })).status === 409 && noticesTo(H.email, 'link') === before, `  …releases nothing, notifies nothing, and deletes the slot`)
    }
    // REPLAY: a challenge already spent at this address
    const s1 = await slot(), ch = await challengeFor(H.email)
    ok((await complete(s1, H, hd, { ch, nd })).status === 200, 'CONTROL: a fresh challenge completes')
    const s2 = await slot()
    const rp = await complete(s2, H, hd, { ch, nd })
    ok(rp.status === 400 && reason(rp) === 'replay', 'REPLAY: the same challenge again → refused (spent first)')
    // a challenge issued for another address
    const other = await person('link-other@example.com'); await bind(other)
    const s3 = await slot()
    const och = await challengeFor(other.email)
    ok(reason(await complete(s3, H, hd, { ch: och, nd })) === 'challenge', 'a challenge scoped to another address → refused')
    // light tier: a dev. with no consent key signs no cns.
    const light = await device(H, { consent: false })
    const s4 = await slot(), ch4 = await challengeFor(H.email)
    const c4 = await nativeConsent({ ...light }, ch4, nd.nDev)
    ok(reason(await complete(s4, H, light, { ch: ch4, nd, consent: c4 })) === 'h-no-consent', 'a light-tier H (dev. with no consent key) is refused: no WebAuthn link consent until kernel has its msg3 variant')
    // the WebAuthn consent form: msg3 has no place for it, and a request carrying
    // one beside a light-tier H's msg3 is still refused (the field is never read)
    const s5 = await slot(), ch5 = await challengeFor(H.email)
    const wa = { webauthn: { credentialId: r64(32), authenticatorData: r64(37), clientDataJSON: r64(80), signature: r64(70) }, exp: now + 2 * MIN }
    ok(reason(await complete(s5, H, light, { ch: ch5, nd, consent: await nativeConsent(light, ch5, nd.nDev), extra: { consent: wa, webauthn: wa.webauthn } })) === 'h-no-consent', 'a light-tier H with a WebAuthn assertion riding along → refused (link WebAuthn consent is OFF)')
    // grammar: msg3 is one text in kernel's exact shape; anything else burns the challenge
    const s6 = await slot(), ch6 = await challengeFor(H.email)
    const good6 = await msg3For(H, hd, { ch: ch6, nd })
    ok(reason(await complete(s6, H, hd, { ch: ch6, msg3: good6.replace(/\n[^\n]*$/, '\n' + r64(315)) })) === 'grammar', 'a msg3 whose sealed line is the wrong size → refused (grammar)')
    const s6b = await slot()
    ok(reason(await complete(s6b, H, hd, { ch: ch6, msg3: good6 })) === 'replay', '  …and that malformed attempt spent its challenge (spend first)')
    // the cap is kernel's slot wire: 4096 bytes DECODED, refused before anything is claimed or spent
    const s6c = await slot(), ch6c = await challengeFor(H.email)
    const over = 'lnk3\n' + 'x'.repeat(4097 - 5), wide = 'lnk3\n' + 'é'.repeat(2046)
    ok(enc(over).length === 4097 && enc(wide).length === 4097 && wide.length < 4096, '  (the over-cap texts are 4097 bytes; the wide one is under 4096 characters)')
    const atRoute = (r: { status: number; j: Record<string, unknown> }) => r.status === 400 && r.j.error === 'invalid' && !('reason' in r.j)
    ok(atRoute(await complete(s6c, H, hd, { ch: ch6c, msg3: over })), 'a msg3 of 4097 bytes → refused at the route')
    ok(atRoute(await complete(s6c, H, hd, { ch: ch6c, msg3: wide })), 'a msg3 of 4097 bytes in fewer characters → refused: the cap counts bytes')
    ok(atRoute(await complete(s6c, H, hd, { ch: ch6c, msg3: 'x'.repeat(4096) })), "a msg3 without kernel's lnk3 prefix → refused at the route")
    ok(atRoute(await complete(s6c, H, hd, { ch: ch6c, msg3: '' })), 'an empty msg3 → refused at the route')
    const biggest = await complete(s6c, H, hd, { ch: ch6c, nd, sealed: r64(314) })
    ok(biggest.status === 200, `  …none of those claimed the slot or spent the challenge: both still complete, with the longest SEALED (${reason(biggest)})`)
    const s6d = await slot(), ch6d = await challengeFor(H.email), edge = 'lnk3\n' + 'x'.repeat(4096 - 5)
    ok(enc(edge).length === 4096 && reason(await complete(s6d, H, hd, { ch: ch6d, msg3: edge })) === 'grammar', "a msg3 of exactly 4096 bytes passes the cap and reaches kernel's verifier (grammar)")
    const s6e = await slot()
    ok(reason(await complete(s6e, H, hd, { ch: ch6d })) === 'replay', '  …and that attempt did spend its challenge')
    const s7 = await slot()
    ok((await complete(s7, H, hd, { nd: await nDevFor(H) })).status === 200, 'CONTROL: the native consent from the same H still completes')
  }

  // the certificates: H's by the LIVE key; N's names the same account and a different device
  {
    const intruder = await person('link-h@example.com') // same address, another key: not the live binding
    const fakeH = await device(intruder)
    const s = await slot()
    ok(reason(await complete(s, H, fakeH, { hDev: fakeH.dev, hDevSig: fakeH.devSig })) === 'h-account', "H's dev. by a key that is not the live binding → refused")
    const s2 = await slot()
    ok(reason(await complete(s2, H, hd, { nd: await nDevFor(H, { account: intruder }) })) === 'n-account', "N's dev. naming another account → refused")
    const s3 = await slot()
    ok(reason(await complete(s3, H, hd, { nd: { nDev: hd.dev, nDevSig: hd.devSig, n: hd } })) === 'n-device-is-h', "N's dev. naming H's own device → refused (n≠h, kernel's check)")
    const s3c = await slot()
    ok((await complete(s3c, H, hd, { nd: await nDevFor(H) })).status === 200, "CONTROL: N's dev. naming a NEW device of the same account completes")
    const other = await device(H) // a second device of H's, whose consent is not the one H presents
    const s4 = await slot(), ch = await challengeFor(H.email), nd = await nDevFor(H)
    ok(reason(await complete(s4, H, hd, { ch, nd, consent: await nativeConsent(other, ch, nd.nDev) })).startsWith('cns-'), "a cns. from a device other than the H named → refused")
  }

  // (d) frozen or pending → refused; and a freeze AFTER completion stops the release
  {
    const F = await person('link-frozen@example.com'); await bind(F)
    const fd = await device(F)
    const s = await slot()
    ok((await complete(s, F, fd)).status === 200, 'CONTROL: F links while active')
    ok((await freezeByEmail(F)).status === 200, 'F is frozen by email after H completed')
    const g = await link('get', { id: s.id, tok: s.tok, n: 3 })
    ok(g.status === 409 && g.j.error === 'state', 'N is refused the sealed key once the binding is frozen')
    ok((await link('get', { id: s.id, tok: s.tok, n: 3 })).status === 409, '  …and the slot is gone')
    const s2 = await slot()
    ok(reason(await complete(s2, F, fd)) === 'state', 'a frozen binding cannot link')
  }

  // long-poll: a read waits for the write
  {
    const s = await slot({ fill: 0 })
    const waiting = link('get', { id: s.id, tok: s.tok, n: 1, wait: 5000 })
    await new Promise((r) => setTimeout(r, 20))
    await link('put', { id: s.id, tok: s.tok, n: 1, msg: s.m[1] })
    const got = await waiting
    ok(got.status === 200 && got.j.msg === s.m[1], 'a waiting read returns the message as soon as it is written')
    const t0 = performance.now()
    const idle = await link('get', { id: s.id, tok: s.tok, n: 2, wait: 60 })
    ok(idle.status === 202 && performance.now() - t0 >= 50, 'a waiting read with nothing written ends pending')
  }

  {
    // the tok VALUES (random base64 can spell "tok", so a name regex alone is no check), and no address
    const slots = [...stores.keys()].filter((k) => k.startsWith('Link:')).map((k) => JSON.stringify([...stores.get(k)!.entries()]))
    {
      const s = await slot({ fill: 0 })
      const th = (store('Link', s.id)!.get('slot') as { th: string }).th
      ok(th === await linkTokHash(s.tok), "a slot stores kernel's linkTokHash(tok), nothing of the directory's own")
    }
    ok(sentToks.size > 3 && !slots.some((j) => [...sentToks].some((t) => j.includes(t)) || /"tok"|"email"|@/.test(j)), 'link slots store no tok and no address')
  }
}

// =====================================================================
// the key-blob store: status, passkeys, recovery, ledger (D1c)
// =====================================================================
const K = await person('keys-k@example.com')
await bind(K)
const kd = await device(K)
const kScope = await addressKey(K.email)
async function current(p: P) { return String((await lookup(p.email)).j.binding) }
/** an account-signed request for `subject`, with consent when `purpose` is given */
async function dreq(p: P, d: D | null, subject: Record<string, unknown>, o: { purpose?: string; signer?: P; ch?: string; bindText?: string } = {}) {
  const ch = o.ch ?? await challengeFor(p.email)
  const toBytes = (v: unknown) => (typeof v === 'string' ? b64uDec(v)! : v)
  const kernelSubject = Object.fromEntries(Object.entries(subject).map(([k, v]) => [k, k === 'op' ? v : toBytes(v)]))
  const req = buildDreq({ op: subject.op as never, address: p.email, bindHash: await hashOf(o.bindText ?? await current(p)), challenge: ch, arg: await dreqArg(kernelSubject as never) })
  const sig = await (o.signer ?? p).k.sign(req)
  const consent = d && o.purpose ? await nativeConsent(d, ch, req, { purpose: o.purpose }) : null
  return { email: p.email, req, sig, challenge: ch, consent }
}

// --- status ---
{
  const r = await api('/v1/status', await dreq(K, null, { op: 'status' }))
  ok(r.status === 200 && r.j.state === 'active' && Array.isArray(r.j.events), 'CONTROL: a signed status read returns the state and the event list')
  const st = await api('/v1/status', await dreq(K, null, { op: 'status' }, { signer: await person(K.email) }))
  ok(st.status === 400 && reason(st) === 'dreq:signature', 'a status read signed by another key → refused')
  const ch = await challengeFor(K.email)
  await api('/v1/status', await dreq(K, null, { op: 'status' }, { ch }))
  ok(reason(await api('/v1/status', await dreq(K, null, { op: 'status' }, { ch }))) === 'replay', 'a status read on a spent challenge → refused')
  delete env.KEYSTORE
  ok((await api('/v1/status', await dreq(K, null, { op: 'status' }))).status === 404, 'key-store routes answer 404 unless KEYSTORE=1')
  env.KEYSTORE = '1'
}

// --- passkeys ---
function cborEnc(v: unknown): number[] {
  const head = (major: number, n: number) => n < 24 ? [major << 5 | n] : n < 256 ? [major << 5 | 24, n] : [major << 5 | 25, n >> 8, n & 255]
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (typeof v === 'string') { const b = enc(v); return [...head(3, b.length), ...b] }
  if (v instanceof Uint8Array) return [...head(2, v.length), ...v]
  if (v instanceof Map) return [...head(5, v.size), ...[...v.entries()].flatMap(([k, x]) => [...cborEnc(k), ...cborEnc(x)])]
  throw new Error('cbor')
}
type RegOpts = { flags?: number; alg?: number; fmt?: string; attStmt?: Map<unknown, unknown>; origin?: string; type?: string; challenge?: string; key?: Awaited<ReturnType<typeof signer>>; credId?: Uint8Array }
async function registration(ch: string, o: RegOpts = {}) {
  const key = o.key ?? await signer()
  const raw = b64uDec(key.pub)!
  const credId = o.credId ?? rnd(32)
  const cose = new Map<unknown, unknown>([[1, 2], [3, o.alg ?? -7], [-1, 1], [-2, raw.slice(1, 33)], [-3, raw.slice(33)]])
  const ad = Uint8Array.from([...(await sha(enc('bento.page'))), o.flags ?? 0x4d, 0, 0, 0, 0, ...new Uint8Array(16), 0, credId.length, ...credId, ...cborEnc(cose)])
  const att = Uint8Array.from(cborEnc(new Map<unknown, unknown>([['fmt', o.fmt ?? 'none'], ['attStmt', o.attStmt ?? new Map()], ['authData', ad]])))
  const cdj = enc(JSON.stringify({ type: o.type ?? 'webauthn.create', challenge: o.challenge ?? ch, origin: o.origin ?? 'https://bento.page' }))
  return { key, credId, attestationObject: b64uEnc(att), clientDataJSON: b64uEnc(cdj) }
}
const blobFor = async (credId: Uint8Array) => ({ v: 1, cred: b64uEnc(await sha(credId)), salt: r64(32), iv: r64(12), ct: r64(80) })
/** light-tier consent: `pk`'s WebAuthn assertion over the cns. the directory will build */
type Pk = { key: Awaited<ReturnType<typeof signer>>; credId: Uint8Array }
async function waConsent(pk: Pk, ch: string, payload: string, purpose: string) {
  const exp = now + 2 * MIN
  const cns = buildConsent({ rp: 'bento', purpose: purpose as never, docId: null, transcript: (await consentTranscript('dir', ch, payload))!, exp })
  return { webauthn: await assertion(pk.key, pk.credId, await webauthnChallengeFor(cns)), exp }
}
async function addCred(p: P, d: D, o: RegOpts & { blob?: unknown; purpose?: string | null; tamper?: boolean; consent?: unknown; passkey?: Pk } = {}) {
  const ch = await challengeFor(p.email)
  const reg = await registration(ch, o)
  const signedReg = o.tamper ? await registration(ch, o) : reg // the dreq. covers different bytes than are sent
  const q = await dreq(p, d, { op: 'cred-add', attestationObject: signedReg.attestationObject, clientDataJSON: signedReg.clientDataJSON }, { ch, purpose: o.purpose === null ? undefined : (o.purpose ?? 'cred-add') })
  const blob = o.blob ?? await blobFor(reg.credId)
  if (o.passkey) q.consent = await waConsent(o.passkey, ch, q.req, 'cred-add') as never
  const r = await api('/v1/cred/add', { ...q, ...(o.consent !== undefined ? { consent: o.consent } : {}), attestationObject: reg.attestationObject, clientDataJSON: reg.clientDataJSON, blob, attachment: 'platform', devicePub: d.devicePub })
  return { r, reg, blob }
}
const toDer = (raw: Uint8Array) => {
  const int = (v: Uint8Array) => { let i = 0; while (i < 31 && v[i] === 0) i++; v = v.slice(i); return v[0] & 0x80 ? Uint8Array.of(0, ...v) : v }
  const r = int(raw.slice(0, 32)), s = int(raw.slice(32))
  return Uint8Array.of(0x30, r.length + s.length + 4, 0x02, r.length, ...r, 0x02, s.length, ...s)
}
async function assertion(key: Awaited<ReturnType<typeof signer>>, credId: Uint8Array, challenge: string, o: { origin?: string; count?: number } = {}) {
  const ad = new Uint8Array(37); ad.set(await sha(enc('bento.page'))); ad[32] = 0x05
  new DataView(ad.buffer).setUint32(33, o.count ?? 0)
  const cdj = enc(JSON.stringify({ type: 'webauthn.get', challenge, origin: o.origin ?? 'https://bento.page' }))
  const signed = new Uint8Array(ad.length + 32); signed.set(ad); signed.set(await sha(cdj), ad.length)
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.kp.privateKey, signed))
  return { credentialId: b64uEnc(credId), authenticatorData: b64uEnc(ad), clientDataJSON: b64uEnc(cdj), signature: b64uEnc(toDer(raw)) }
}
const credChallenge = async () => String((await api('/v1/cred/challenge', {})).j.challenge)
async function fetchBlob(key: Awaited<ReturnType<typeof signer>>, credId: Uint8Array, o: { ch?: string; origin?: string; count?: number } = {}) {
  const ch = o.ch ?? await credChallenge()
  return api('/v1/cred/get', { challenge: ch, assertion: await assertion(key, credId, ch, o) })
}

let kCred: Awaited<ReturnType<typeof addCred>>
{
  const before = noticesTo(K.email, 'cred-add')
  kCred = await addCred(K, kd)
  ok(kCred.r.status === 200, `CONTROL: a passkey is registered with a dreq. over its exact bytes plus consent (${reason(kCred.r)})`)
  ok(noticesTo(K.email, 'cred-add') === before + 1, 'adding a passkey notifies')
  const rec = store('Cred', b64uEnc(await sha(kCred.reg.credId)))!.get('cred') as Record<string, unknown>
  ok(rec.be === true && rec.accountPub === K.k.pub && rec.scope === kScope && rec.pub === kCred.reg.key.pub, 'the Cred stores BE, the account key it wraps, the address scope and the COSE key')

  ok(reason((await addCred(K, kd, { tamper: true })).r) === 'dreq:arg', 'registration bytes swapped after signing → refused (dreq:arg)')
  ok(reason((await addCred(K, kd, { purpose: null })).r) === 'consent:consent', 'cred-add without consent → refused')
  ok(reason((await addCred(K, kd, { purpose: 'cred-del' })).r).startsWith('consent:cns:'), 'cred-add with a cred-del consent → refused')
  ok(reason((await addCred(K, kd, { challenge: r64(40) })).r) === 'registration:challenge', "the ceremony's challenge must be the spent dir challenge")
  ok(reason((await addCred(K, kd, { fmt: 'packed' })).r) === 'registration:attestation', 'attestation other than none → refused')
  ok(reason((await addCred(K, kd, { attStmt: new Map([['x', 1]]) })).r) === 'registration:attestation', 'a non-empty attStmt → refused')
  ok(reason((await addCred(K, kd, { flags: 0x41 })).r) === 'registration:flags', 'a registration without UV → refused')
  ok(reason((await addCred(K, kd, { flags: 0x05 })).r) === 'registration:flags', 'a registration without attested credential data → refused')
  ok(reason((await addCred(K, kd, { alg: -35 })).r) === 'registration:key', 'a non-ES256 key → refused')
  ok(reason((await addCred(K, kd, { origin: 'https://bento.page.evil' })).r) === 'registration:origin', 'an origin near-miss → refused')
  ok(reason((await addCred(K, kd, { type: 'webauthn.get' })).r) === 'registration:type', 'a webauthn.get clientData → refused')
  ok(reason((await addCred(K, kd, { blob: { ...kCred.blob } })).r) === 'blob', "a PRF blob for another credential → refused")
  ok(reason((await addCred(K, kd, { blob: { v: 1, cred: 'x', salt: '', iv: '', ct: '' } })).r) === 'blob', 'a malformed PRF blob → refused')
}
{
  // fetch: one ceremony, notified
  const before = noticesTo(K.email, 'cred-fetch')
  const ch = await credChallenge()
  const f = await fetchBlob(kCred.reg.key, kCred.reg.credId, { ch })
  ok(f.status === 200 && JSON.stringify(f.j.blob) === JSON.stringify(kCred.blob), 'CONTROL: a passkey assertion fetches its blob')
  ok(noticesTo(K.email, 'cred-fetch') === before + 1, 'every fetch notifies')
  ok(reason(await fetchBlob(kCred.reg.key, kCred.reg.credId, { ch })) === 'replay', 'a fetch on a spent challenge → refused')
  ok(reason(await fetchBlob(await signer(), kCred.reg.credId)) === 'signature', 'an assertion by another key → refused')
  ok(reason(await fetchBlob(kCred.reg.key, kCred.reg.credId, { origin: 'https://bento.page/' })) === 'origin', 'an origin near-miss → refused')
  ok((await fetchBlob(kCred.reg.key, kCred.reg.credId, { origin: 'bento-desktop:linux' })).status === 200, 'a self-reported desktop origin may fetch (advisory, §9.3) — the control for the origin rows')
  const cKey = b64uEnc(await sha(kCred.reg.credId))
  const credRec = store('Cred', cKey)!.get('cred') as Record<string, unknown>
  store('Cred', cKey)!.set('cred', { ...credRec, accountPub: (await signer()).pub }) // as if the binding rotated since it was registered
  ok(reason(await fetchBlob(kCred.reg.key, kCred.reg.credId)) === 'stale', 'a blob wrapping a key that is no longer the binding is never released')
  store('Cred', cKey)!.set('cred', { ...(store('Cred', cKey)!.get('cred') as object), accountPub: K.k.pub })
  const credDo = (env.CRED as { get(id: string): { fetch(u: string, i: RequestInit): Promise<Response> } }).get(cKey)
  ok((await credDo.fetch('https://do/op', { method: 'POST', body: JSON.stringify({ op: 'delete', scope: await addressKey('someone-else@example.com') }) })).status === 400, 'a Cred refuses deletion asked for another address (second line behind the index)')
  ok(store('Cred', cKey)!.has('cred'), '  …and keeps the credential')
  const dirCh = await challengeFor(K.email)
  ok((await api('/v1/cred/get', { challenge: dirCh, assertion: await assertion(kCred.reg.key, kCred.reg.credId, dirCh) })).status === 400, 'a dir challenge is not a passkey-fetch challenge (audience)')
}
{
  // 10 per account, duplicates refused
  const M = await person('keys-many@example.com'); await bind(M)
  const md = await device(M)
  let n = 0
  for (let i = 0; i < KEYS.maxCreds; i++) if ((await addCred(M, md)).r.status === 200) n++
  ok(n === KEYS.maxCreds, `CONTROL: ${KEYS.maxCreds} passkeys register`)
  ok(reason((await addCred(M, md)).r) === 'limit', `an ${KEYS.maxCreds + 1}th passkey → refused`)
}
{
  // delete: needs consent; then the credential fetches nothing
  const extra = await addCred(K, kd)
  const delQ = async (purpose: string | null, id = extra.reg.credId) => {
    const q = await dreq(K, kd, { op: 'cred-del', credentialId: b64uEnc(id) }, { purpose: purpose ?? undefined })
    return api('/v1/cred/del', { ...q, credentialId: b64uEnc(id) })
  }
  ok(reason(await delQ(null)) === 'consent:consent', 'cred-del without consent → refused')
  ok(reason(await delQ('cred-add')).startsWith('consent:cns:'), 'cred-del with a cred-add consent → refused')
  const before = noticesTo(K.email, 'cred-del')
  ok((await delQ('cred-del')).status === 200 && noticesTo(K.email, 'cred-del') === before + 1, 'CONTROL: cred-del with its own consent removes it, notified')
  ok(reason(await fetchBlob(extra.reg.key, extra.reg.credId)) === 'unknown', 'a removed passkey fetches nothing')
  ok(reason(await delQ('cred-del', rnd(32))) === 'unknown', 'removing an unknown credential → refused')
}
{
  // another account's passkey cannot be removed through this address
  const O = await person('keys-o@example.com'); await bind(O)
  const oc = await addCred(O, await device(O))
  const q = await dreq(K, kd, { op: 'cred-del', credentialId: b64uEnc(oc.reg.credId) }, { purpose: 'cred-del' })
  ok(reason(await api('/v1/cred/del', { ...q, credentialId: b64uEnc(oc.reg.credId) })) === 'unknown', "another address's passkey is never removed")
  ok((await fetchBlob(oc.reg.key, oc.reg.credId)).status === 200, '  …it still works for its owner')
}

// --- the recovery code ---
const enrolment = () => ({ v: 1, saltV: r64(16), verifier: r64(32), saltW: r64(16), iv: r64(12), ct: r64(80) })
const bodyOf = (e: unknown) => b64uEnc(enc(JSON.stringify(e)))
async function enrol(p: P, d: D, e = enrolment(), o: { purpose?: string | null; signedBody?: string; passkey?: Pk; young?: boolean } = {}) {
  const body = bodyOf(e)
  const q = await dreq(p, d, { op: 'rc-enrol', body: o.signedBody ?? body }, { purpose: o.purpose === null ? undefined : (o.purpose ?? 'rc-enrol') })
  if (o.passkey) q.consent = await waConsent(o.passkey, q.challenge, q.req, 'rc-enrol') as never
  const r = await api('/v1/recovery/enrol', { ...q, body })
  if (r.status === 200 && !o.young) {
    const s = store('Account', await addressKey(p.email))!
    s.set('rc', { ...(s.get('rc') as { at: number }), at: now - 72 * HOUR })
  }
  return { r, e }
}
const start = (p: P, verifier: string) => api('/v1/recovery/start', { email: p.email, verifier })
const release = (p: P, verifier: string, ticket: string) => api('/v1/recovery/release', { email: p.email, verifier, ticket })
const innerOf = (e: ReturnType<typeof enrolment>) => b64uEnc(Uint8Array.from([...b64uDec(e.saltW)!, ...b64uDec(e.iv)!, ...b64uDec(e.ct)!]))
{
  const R = await person('keys-r@example.com'); await bind(R)
  const rd = await device(R)
  ok(reason((await enrol(R, rd, enrolment(), { purpose: null })).r) === 'consent:consent', 'rc-enrol without consent → refused')
  ok(reason((await enrol(R, rd, enrolment(), { purpose: 'cred-add' })).r).startsWith('consent:cns:'), 'rc-enrol with another op\'s consent → refused')
  ok(reason((await enrol(R, rd, enrolment(), { signedBody: bodyOf(enrolment()) })).r) === 'dreq:arg', 'an enrolment body swapped after signing → refused')
  ok((await enrol(R, rd, { ...enrolment(), extra: 1 } as never)).r.status === 400, 'an enrolment body with an extra field → refused')
  ok((await enrol(R, rd, { ...enrolment(), ct: r64(79) })).r.status === 400, 'an enrolment body with a short ct → refused')
  { const e0 = enrolment(); delete (e0 as Record<string, unknown>).saltW; ok((await enrol(R, rd, e0)).r.status === 400, 'an enrolment body missing a field → refused') }
  const before = noticesTo(R.email, 'rc-enrol')
  const { r, e } = await enrol(R, rd)
  ok(r.status === 200 && noticesTo(R.email, 'rc-enrol') === before + 1, 'CONTROL: rc-enrol with consent stores the verifier, notified')
  const rec = store('Account', await addressKey(R.email))!.get('rc') as Record<string, unknown>
  ok(rec.v === 1 && rec.saltV === e.saltV && rec.accountPub === R.k.pub, 'the record names its pepper version, the salt and the account key')
  ok(!dump().includes(e.verifier) && !dump().includes(e.ct) && !dump().includes(e.iv), 'neither the verifier nor the code-wrapped blob is stored in the clear')

  ok((await api('/v1/recovery/salt', { email: R.email })).j.saltV === e.saltV, 'the salt read returns the enrolled verifier salt')
  const s1 = (await api('/v1/recovery/salt', { email: 'nobody@example.com' })).j.saltV
  const s2 = (await api('/v1/recovery/salt', { email: 'nobody@example.com' })).j.saltV
  const s3 = (await api('/v1/recovery/salt', { email: 'nobody2@example.com' })).j.saltV
  ok(typeof s1 === 'string' && b64uDec(s1)!.length === 16 && s1 === s2 && s1 !== s3, 'an address with no recovery gets a stable, per-address fake salt (no enrolment oracle)')

  const a0 = noticesTo(R.email, 'rc-attempt')
  ok(reason(await start(R, r64(32))) === 'invalid', 'a wrong verifier → refused')
  ok(noticesTo(R.email, 'rc-attempt') === a0 + 1, '  …and notified')
  {
    const m = [...mailbox].reverse().find((x) => x.to === R.email && x.kind === 'rc-attempt')!
    ok(/set a new recovery code/.test(m.body) && /That cancels it/.test(m.body) && !/and freeze your keys\./.test(m.body), 'the recovery-attempt notice says to set a new recovery code (the cancel), never to freeze')
    const ev = (store('Address', await addressKey(R.email))!.get('uevents') as Record<string, { act?: string }> | undefined)?.['rc-attempt']
    ok(ev?.act === 'rc-enrol', '  …and its event-list entry leads to that action (act: rc-enrol)')
    const fm = [...mailbox].reverse().find((x) => x.to === K.email && x.kind === 'cred-add')!
    ok(/and freeze your keys\./.test(fm.body), 'CONTROL: a passkey notice still advises freezing')
  }
  now += HOUR // one rc-attempt notice per hour per address
  const go = await start(R, e.verifier)
  ok(go.status === 200 && typeof go.j.ticket === 'string' && go.j.releaseAt === now + 72 * HOUR, 'CONTROL: the right verifier starts the 72-hour wait')
  ok(noticesTo(R.email, 'rc-attempt') === a0 + 2, '  …notified too')
  const ticket = String(go.j.ticket)
  now += 72 * HOUR - MIN
  ok(reason(await release(R, e.verifier, ticket)) === 'early', 'a release before 72 hours → refused')
  const go2 = await start(R, e.verifier)
  ok(go2.j.releaseAt === go.j.releaseAt, 'a second start never restarts or shortens the wait')
  now += 2 * MIN
  ok(reason(await release(R, e.verifier, ticket)) === 'ticket', 'a ticket replaced by a later start no longer works')
  now += DAY // five verifier checks so far today: the rows below need a fresh day's budget
  ok(reason(await release(R, e.verifier, r64(32))) === 'ticket', 'a made-up ticket → refused')
  ok(reason(await release(R, r64(32), String(go2.j.ticket))) === 'invalid', 'the right ticket with a wrong verifier → refused')
  now += HOUR // the refused releases above were notified within the hour
  const rel0 = noticesTo(R.email, 'rc-release')
  const out = await release(R, e.verifier, String(go2.j.ticket))
  ok(out.status === 200 && out.j.inner === innerOf(e), 'CONTROL: after 72 hours the right ticket and verifier release the code-wrapped blob, pepper layer removed')
  ok(noticesTo(R.email, 'rc-release') === rel0 + 1, '  …notified')
  {
    const m = [...mailbox].reverse().find((x) => x.to === R.email && x.kind === 'rc-release')!
    ok(/set a new recovery code/.test(m.body) && !/and freeze your keys\./.test(m.body), 'the release notice says to set a new recovery code, never to freeze')
  }
  ok(reason(await start(R, e.verifier)) === 'invalid', 'a used recovery code is SPENT')
  ok((await api('/v1/recovery/salt', { email: R.email })).j.saltV !== e.saltV, '  …and its salt is gone')
}
// --- notice mail is capped per address; the event list records everything (F1) ---
{
  // unauthenticated attempts can't evict a signed event from the list (G1)
  const V = await person('keys-ev@example.com'); await bind(V)
  const vd = await device(V)
  await enrol(V, vd)
  const listed = async () => ((await api('/v1/status', await dreq(V, null, { op: 'status' }))).j.events as { k: string; n?: number }[])
  ok((await listed()).some((x) => x.k === 'rc-enrol'), 'CONTROL: a recovery-code change is listed')
  for (let i = 0; i < 30; i++) await start(V, r64(32)) // 30 attempts, 30 IPs, no signature
  const after = await listed()
  ok(after.some((x) => x.k === 'rc-enrol'), `…and still listed after 30 unsigned recovery attempts (${after.map((x) => x.k).join(',')})`)
  ok(after.filter((x) => x.k === 'rc-attempt').length === 1 && after.find((x) => x.k === 'rc-attempt')?.n === 30, '  …which show as ONE entry counting 30')
  const W = await person('keys-ev2@example.com'); await bind(W)
  const wd = await device(W)
  for (let i = 0; i < 21; i++) await enrol(W, wd)
  ok(((await api('/v1/status', await dreq(W, null, { op: 'status' }))).j.events as { k: string }[]).filter((x) => x.k === 'rc-enrol').length === 20, 'signed events keep the list\'s length of 20 (it is short by design)')
}
{
  for (const enrolled of [true, false]) {
    const T = await person(`keys-cap-${enrolled ? 'e' : 'u'}@example.com`); await bind(T)
    const te = enrolled ? (await enrol(T, await device(T))).e : null
    const m0 = noticesTo(T.email, 'rc-attempt')
    await start(T, r64(32))
    ok(noticesTo(T.email, 'rc-attempt') === m0 + 1, `CONTROL (${enrolled ? 'enrolled' : 'nothing enrolled'}): the first wrong attempt mails a notice`)
    for (let i = 0; i < 39; i++) await start(T, r64(32)) // 40 attempts, each from its own IP
    ok(noticesTo(T.email, 'rc-attempt') === m0 + 1, `40 wrong recovery attempts from 40 IPs → 1 mail, not 40 (${noticesTo(T.email, 'rc-attempt') - m0})`)
    const ue = (store('Address', await addressKey(T.email))!.get('uevents') as Record<string, { n: number }> | undefined)?.['rc-attempt']
    ok(ue?.n === 40, `  …while the event list records them, as ONE entry with a count (${ue?.n})`)
    now += 2 * HOUR
    const m1 = noticesTo(T.email, 'rc-attempt')
    ok(reason(await start(T, r64(32))) === 'locked' && noticesTo(T.email, 'rc-attempt') === m1, `a refusal while locked is listed but never mailed, even an hour later (${enrolled ? 'enrolled' : 'nothing enrolled'})`)
    if (te) {
      now += DAY // the lock is over; four wrong checks and one right one fill the day's count without locking
      for (let i = 0; i < 4; i++) await start(T, r64(32))
      ok((await start(T, te.verifier)).status === 200, '  (the fifth check of the day, right, starts a wait)')
      now += 2 * HOUR
      const m2 = noticesTo(T.email, 'rc-attempt')
      ok(reason(await start(T, r64(32))) === 'limit' && noticesTo(T.email, 'rc-attempt') === m2, 'a refusal past the daily count is listed but never mailed')
    }
  }
  // the daily ceiling across kinds, at the event op the worker's notify() mails through
  const C = await person('keys-cap-c@example.com'); await bind(C)
  const cScope = await addressKey(C.email)
  const addr = (env.ADDRESS as { get(id: string): { fetch(u: string, i: RequestInit): Promise<Response> } }).get(cScope)
  const ev = async (kind: string) => (await (await addr.fetch('https://a/op', { method: 'POST', body: JSON.stringify({ op: 'event', kind, fp: '', mail: true }) })).json()).to
  ok((await ev('link')) === C.email, 'CONTROL: a first notice of a kind is mailed')
  ok((await ev('link')) === null, 'a second of the same kind within the hour is listed, not mailed')
  // the kinds anyone can trigger have their own daily ceiling…
  let attack = 0
  for (let i = 0; i < 10; i++) { now += HOUR + MIN; if (await ev(i % 2 ? 'rc-release' : 'rc-attempt')) attack++ }
  ok(attack === 4, `recovery-attempt notices: at most 4 mails a day, one an hour (${attack} of 10 hours)`)
  // …so they can't spend the signed kinds' mail
  let signed = 0
  for (const k of ['cred-add', 'cred-del', 'cred-fetch', 'rc-enrol']) if (await ev(k)) signed++
  ok(signed === 4, `after those, 4 signed notices (passkey, recovery-code change) are all mailed (${signed})`)
  now += DAY + MIN
  ok((await ev('rc-attempt')) === C.email, 'CONTROL: the next day recovery notices mail again')
}
{
  // a new enrolment ends a release in flight for the old code
  const N2 = await person('keys-n2@example.com'); await bind(N2)
  const n2d = await device(N2)
  const { e } = await enrol(N2, n2d)
  const t = String((await start(N2, e.verifier)).j.ticket)
  const { e: e2 } = await enrol(N2, n2d)
  now += 72 * HOUR + MIN
  ok(reason(await release(N2, e2.verifier, t)) === 'ticket', 'a release started under the old code dies with a re-enrolment')
  const t2 = String((await start(N2, e2.verifier)).j.ticket)
  now += 72 * HOUR + MIN
  ok((await release(N2, e2.verifier, t2)).j.inner === innerOf(e2), 'CONTROL: the new code releases after its own wait')
}
{
  // attempts: 5 per 24 h; 5 failures lock for 24 h
  const L = await person('keys-l@example.com'); await bind(L)
  const { e } = await enrol(L, await device(L))
  for (let i = 0; i < 4; i++) await start(L, r64(32))
  ok(reason(await start(L, r64(32))) === 'invalid', 'the fifth wrong verifier is still checked')
  ok(reason(await start(L, e.verifier)) === 'locked', 'five failures lock recovery: even the right verifier is refused')
  now += 24 * HOUR + MIN
  ok((await start(L, e.verifier)).status === 200, 'CONTROL: after 24 hours the right verifier works again')
  for (let i = 0; i < 4; i++) await start(L, e.verifier)
  ok(reason(await start(L, e.verifier)) === 'limit', 'more than five checks in 24 hours → refused, right or wrong')
}
{
  // a rotation orphans the material: a record for another key is gone
  const Q = await person('keys-q@example.com'); await bind(Q)
  const { e } = await enrol(Q, await device(Q))
  const qScope = await addressKey(Q.email)
  const acct = (env.ACCOUNT as { get(id: string): { fetch(u: string, i: RequestInit): Promise<Response> } }).get(qScope)
  const r = await (await acct.fetch('https://do/op', { method: 'POST', body: JSON.stringify({ op: 'rcStart', accountPub: (await signer()).pub, verifier: e.verifier }) })).json()
  ok(r.reason === 'invalid' && !store('Account', qScope)!.has('rc'), 'a verifier record for a key that is no longer the binding is deleted, never matched')
}
{
  // pepper versions: upgrade on use; a version the Worker doesn't hold is never picked
  const V = await person('keys-v@example.com'); await bind(V)
  const vd = await device(V)
  const { e } = await enrol(V, vd)
  const vScope = await addressKey(V.email)
  env.PEPPER_V2 = r64(32)
  const go = await start(V, e.verifier)
  ok(go.status === 200 && (store('Account', vScope)!.get('rc') as { v: number }).v === 2, 'a successful check moves the record to the newest pepper version')
  const v1 = env.PEPPER_V1
  delete env.PEPPER_V1
  now += 72 * HOUR + MIN
  ok((await release(V, e.verifier, String(go.j.ticket))).j.inner === innerOf(e), 'the upgraded record opens without the old version (re-sealed, not just re-tagged)')
  const W = await person('keys-w@example.com'); await bind(W)
  const { e: ew } = await enrol(W, await device(W))
  ok((store('Account', await addressKey(W.email))!.get('rc') as { v: number }).v === 2, 'enrolment uses the newest version')
  delete env.PEPPER_V2
  env.PEPPER_V1 = v1
  ok(reason(await start(W, ew.verifier)) === 'pepper', 'a record under a version this Worker does not hold → refused, never another version tried')
}

// --- a frozen address: status only, no fetch, no enrolment ---
{
  const Z = await person('keys-z@example.com'); await bind(Z)
  const zd = await device(Z)
  const zc = await addCred(Z, zd)
  ok(zc.r.status === 200, 'CONTROL: Z registers a passkey while active')
  ok((await freezeByEmail(Z)).status === 200, 'Z is frozen')
  ok((await fetchBlob(zc.reg.key, zc.reg.credId)).status === 409, 'a frozen address releases no passkey blob')
  ok(reason((await enrol(Z, zd)).r) === 'dreq:state', 'a frozen address enrols no recovery verifier')
  ok(reason((await addCred(Z, zd)).r) === 'dreq:state', 'a frozen address registers no passkey')
  const s = await api('/v1/status', await dreq(Z, null, { op: 'status' }))
  ok(s.status === 200 && s.j.state === 'frozen', 'a frozen address still answers a signed status read')
}

// --- the event list (§9.7) ---
{
  const s = await api('/v1/status', await dreq(K, null, { op: 'status' }))
  const kinds = (s.j.events as { k: string }[]).map((x) => x.k)
  ok(kinds.includes('cred-add') && kinds.includes('cred-fetch') && kinds.includes('cred-del'), `the status read lists the notified events (${kinds.join(',')})`)
  ok((s.j.events as unknown[]).length <= 20, 'the event list is short')
}

// --- the access ledger ---
{
  ok(bucket(1) === 4096 && bucket(4097) === 4608 && bucket(4608) === 4608 && bucket(4609) === 5184, 'buckets: integer 12.5% steps from 4 KiB')
  ok((await api('/v1/ledger/put', { email: K.email })).status === 501, 'the ledger routes answer 501 until kernel has a ledger dreq. op')
  const acct = (env.ACCOUNT as { get(id: string): { fetch(u: string, i: RequestInit): Promise<Response> } }).get(kScope)
  const op = async (body: Record<string, unknown>) => { const r = await acct.fetch('https://do/op', { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, j: await r.json() } }
  ok((await op({ op: 'ledgerPut', accountPub: K.k.pub, blob: b64uEnc(rnd(4097)) })).status === 400, 'a ledger blob that is not a bucket size → refused')
  let big = 4096; while (bucket(big + 1) <= KEYS.ledgerMax) big = bucket(big + 1)
  ok((await op({ op: 'ledgerPut', accountPub: K.k.pub, blob: b64uEnc(rnd(bucket(big + 1))) })).status === 400, 'a ledger blob over 1 MiB → refused')
  const blob = b64uEnc(rnd(4608))
  ok((await op({ op: 'ledgerPut', accountPub: K.k.pub, blob })).status === 200, 'CONTROL: a bucket-sized blob is stored')
  ok((await op({ op: 'ledgerGet', accountPub: K.k.pub })).j.blob === blob, '  …and read back by the same key')
  ok((await op({ op: 'ledgerGet', accountPub: (await signer()).pub })).status === 404 && !store('Account', kScope)!.has('led'), 'a ledger for a previous key is dropped (replaced on rotation)')
}

// --- deletion takes the account material with it ---
{
  const X = await person('keys-x@example.com'); const xb = await bind(X)
  const xd = await device(X)
  const xc = await addCred(X, xd)
  await enrol(X, xd)
  const xScope = await addressKey(X.email)
  const ts = now
  const { buildDel } = await import('../kernel/src/statements.ts')
  const del = await api('/v1/delete', { email: X.email, ts, sig: await X.k.sign(buildDel(X.email, ts)) })
  ok(del.status === 204, 'X deletes its own binding')
  ok(!store('Cred', b64uEnc(await sha(xc.reg.credId)))!.has('cred') && !store('Account', xScope)!.has('creds'), 'a holder deletion removes every passkey and the index')
  ok(store('Account', xScope)!.has('rc'), '  …and keeps the recovery verifier for the deleted binding\'s window (§39.6)')
  void xb
}

// =====================================================================
// D1b: the rot. vouch, contest and owner freeze (dreq.), resolution by the
// recovery code, and the holder-delete window (security §39.3, §39.6)
// =====================================================================
{
  env.ROTATION = '1'
  const { buildDel, buildRot, verifyAtt, verifyRotation } = await import('../kernel/src/statements.ts')
  const DK = { 'dir-1': dir.pub }
  const attOf = async (l: { j: Record<string, unknown> }) => {
    const v = await verifyAtt(String(l.j.attestation), String(l.j.attestationSig), { directoryKeys: DK, bindText: String(l.j.binding), now, maxAgeMs: 10 * MIN })
    return v.ok ? v.value.state : `bad:${v.reason}`
  }
  const nextOf = async (p: P): Promise<P> => ({ email: p.email, k: await signer(), kx: await kxPub() })
  const bindNext = async (next: P, prevText: string | null, o: { seq?: number; life?: number; prevHash?: string | null } = {}) => {
    const seq = o.seq ?? (prevText ? Number(prevText.split('.')[5]) + 1 : 1)
    const text = buildBind({ address: next.email, accountPub: next.k.pub, kx: next.kx, name: null, seq, prev: o.prevHash !== undefined ? o.prevHash : prevText ? await hashOf(prevText) : null, created: now, expires: Math.floor(now + (o.life ?? 13 * MONTH)) })
    return { text, sig: await next.k.sign(text) }
  }
  /** a full rotation of p to next: vouch, consent, mailed code → pending */
  async function rotate(p: P, next: P, o: { passkey?: Pk; life?: number } = {}) {
    now += 2 * MIN
    const was = await current(p)
    const n = await bindNext(next, was, { life: o.life })
    const rot = buildRot(await hashOf(n.text), await hashOf(was))
    const ch = await challengeFor(p.email)
    const d = await device(p)
    const st = await api('/v1/rotate/start', { stmt: n.text, sig: n.sig, rot, rotSig: await p.k.sign(rot), challenge: ch, consent: o.passkey ? await waConsent(o.passkey, ch, n.text, 'rotate') : await nativeConsent(d, ch, n.text, { purpose: 'rotate' }) })
    const code = codeFor(p.email)!
    const c = await api('/v1/rotate/complete', { email: p.email, code, sig: await next.k.sign(buildCmp(await hashOf(n.text), code)) })
    return { ...n, was, rot, st, c }
  }
  async function contest(p: P, by: P, pendingText: string, o: { ch?: string; bindText?: string; bind?: string } = {}) {
    const ch = o.ch ?? await challengeFor(p.email)
    const req = buildDreq({ op: 'contest', address: p.email, bindHash: await hashOf(o.bindText ?? await current(p)), challenge: ch, arg: await hashOf(pendingText) })
    return api('/v1/contest', { email: p.email, req, sig: await by.k.sign(req), challenge: ch, bind: o.bind })
  }
  const freezeBy = async (p: P, by: P, o: { bindText?: string } = {}) => api('/v1/freeze', await dreq(p, null, { op: 'freeze' }, { signer: by, bindText: o.bindText }))
  const resolve = (b: { text: string; sig: string }, verifier: string) => api('/v1/resolve', { stmt: b.text, sig: b.sig, verifier })
  const del = async (p: P) => { const ts = now; return api('/v1/delete', { email: p.email, ts, sig: await p.k.sign(buildDel(p.email, ts)) }) }
  const status = async (p: P) => api('/v1/status', await dreq(p, null, { op: 'status' }))
  const rcOf = async (p: P) => store('Account', await addressKey(p.email))?.get('rc') as Record<string, unknown> | undefined

  // --- ROTATION stays off until the contest exists: the gate itself ---
  {
    const G = await person('d1b-gate@example.com'); await bind(G)
    delete env.ROTATION
    ok((await rotate(G, await nextOf(G))).st.status === 404, 'rotation answers 404 unless ROTATION=1')
    env.ROTATION = '1'
  }

  // --- the pending window, contest by the old key → frozen ---
  const A = await person('d1b-a@example.com'); await bind(A)
  const ad = await device(A)
  const { e: aRc } = await enrol(A, ad)
  const A2 = await nextOf(A)
  const ra = await rotate(A, A2)
  ok(ra.st.status === 202 && ra.c.status === 200 && ra.c.j.state === 'pending', `CONTROL: a vouched, consented rotation goes pending (${ra.st.status}/${ra.c.status})`)
  {
    const st = await status(A)
    const pend = st.j.pending as { binding: string; sig: string; rot: string; rotSig: string; activeAt: number }
    ok(st.status === 200 && st.j.state === 'pending' && pend?.binding === ra.text, 'the old key\'s signed status read names the pending binding')
    ok(!!pend && (await verifyRotation(ra.was, pend.binding, pend.sig, pend.rot, pend.rotSig, { now })).ok, '  …with its rot. vouch, so the device can show what it is contesting')
    ok(reason(await api('/v1/status', await dreq(A, null, { op: 'status' }, { signer: A2, bindText: ra.text }))) === 'dreq:bind-mismatch', 'a PENDING key signs no request (status naming the pending binding → refused)')
  }
  ok(reason(await contest(A, A2, ra.text)) === 'dreq:signature', 'a contest signed by the pending (new) key → refused')
  ok(reason(await contest(A, A2, ra.text, { bindText: ra.text })) === 'dreq:bind-mismatch', 'a contest naming the pending binding → refused')
  ok(reason(await contest(A, A, ra.was)) === 'dreq:arg', 'a contest whose arg is not the pending binding → refused')
  ok(reason(await contest(A, await person(A.email), ra.text)) === 'dreq:signature', 'a contest signed by an unrelated key → refused')
  {
    const ch = await challengeFor(A.email)
    const c0 = noticesTo(A.email, 'contest')
    const c = await contest(A, A, ra.text, { ch })
    ok(c.status === 200 && c.j.state === 'frozen', `CONTROL: the old key contests "this wasn't me" → frozen (${c.status} ${reason(c)})`)
    ok(noticesTo(A.email, 'contest') === c0 + 1, '  …notified')
    ok(reason(await contest(A, A, ra.text, { ch })) === 'replay', 'the same contest again → refused (its challenge was spent)')
  }
  {
    const l = await lookup(A.email)
    ok(l.j.binding === ra.was && (await attOf(l)) === 'frozen', 'contested: lookups serve the OLD binding with att.…frozen')
    now += 73 * HOUR
    ok((await lookup(A.email)).j.binding === ra.was, 'a contested rotation never becomes active')
    ok(reason(await contest(A, A, ra.text)) === 'dreq:state', 'frozen: a second contest → refused (only status is accepted)')
    ok(reason(await freezeBy(A, A)) === 'dreq:state', 'frozen: a freeze → refused')
    ok((await status(A)).j.state === 'frozen', 'frozen: the status read still works')
    ok((await del(A)).status === 400, 'frozen: a holder delete → refused')
  }
  {
    const B = await person('d1b-b@example.com'); await bind(B)
    ok(reason(await contest(B, B, await current(B))) === 'dreq:state', 'nothing pending: a contest → refused')
  }

  // --- resolution by the recovery code ---
  {
    const A3 = await nextOf(A)
    const head = await current(A) // the frozen binding: the new one chains to it
    const nb = await bindNext(A3, head)
    ok(reason(await resolve(nb, r64(32))) === 'invalid' && (await lookup(A.email)).j.binding === head, 'a wrong verifier → refused, still frozen')
    ok(reason(await resolve(await bindNext(A, head), aRc.verifier)) === 'same-key', 'resolving to the frozen (lost) key → refused')
    ok(reason(await resolve(await bindNext(A3, head, { seq: Number(head.split('.')[5]) + 2 }), aRc.verifier)) === 'sequence', 'a skipped seq → refused')
    ok(reason(await resolve(await bindNext(A3, head, { prevHash: await hashOf(ra.text) }), aRc.verifier)) === 'sequence', 'chained to the DISCARDED pending binding → refused')
    ok((await resolve({ text: nb.text, sig: await A.k.sign(nb.text) }, aRc.verifier)).status === 400, 'a new binding not signed by its own key → refused')
    ok(!!(await rcOf(A)), '  (no refusal above spent the code)')
    const r = await resolve(nb, aRc.verifier)
    ok(r.status === 200 && r.j.rebound === true, `CONTROL: the recovery verifier + a self-signed new binding resolve the freeze (${r.status} ${reason(r)})`)
    const l = await lookup(A.email)
    ok(l.j.binding === nb.text && (await attOf(l)) === 'active' && l.j.rebound === true && !('rot' in l.j), '  …active under the new key, rebound, NO vouch (pinners warn, as intended)')
    ok((l.j.chain as string[]).includes(await hashOf(head)) && !(l.j.chain as string[]).includes(await hashOf(ra.text)), '  …the frozen binding is in the chain; the contested one never was')
    ok(!(await rcOf(A)), '  …and the recovery code is spent')
    ok(noticesTo(A.email, 'resolve') === 1, '  …notified')
    ok(reason(await resolve(await bindNext(await nextOf(A), nb.text), aRc.verifier)) === 'state', 'an address that is not frozen cannot be "resolved"')
  }

  // --- the owner's lost-or-stolen freeze, signed by the served key ---
  {
    const F = await person('d1b-f@example.com'); await bind(F)
    ok(reason(await freezeBy(F, await person(F.email))) === 'dreq:signature', 'a freeze signed by another key → refused')
    ok(reason(await api('/v1/freeze', await dreq(F, null, { op: 'status' }))) === 'dreq:op', 'a signed STATUS request sent to the freeze route → refused (dreq:op)')
    { const ch = await challengeFor(F.email); const req = buildDreq({ op: 'freeze', address: F.email, bindHash: await hashOf(await current(F)), challenge: ch, arg: await hashOf('x') }); ok(reason(await api('/v1/freeze', { email: F.email, req, sig: await F.k.sign(req), challenge: ch })) === 'dreq:grammar', 'a freeze with a non-empty arg → refused') }
    const f = await freezeBy(F, F)
    ok(f.status === 200 && f.j.state === 'frozen' && (await attOf(await lookup(F.email))) === 'frozen', 'CONTROL: active → the owner\'s signed freeze → frozen')
    const P2 = await person('d1b-p@example.com'); await bind(P2)
    const P3 = await nextOf(P2)
    const rp = await rotate(P2, P3)
    ok(reason(await freezeBy(P2, P3, { bindText: rp.text })) === 'dreq:bind-mismatch', 'pending: a freeze by the pending key → refused')
    ok((await del(P2)).status === 400, 'pending: a holder delete → refused (it would race the contest window)')
    const fp = await freezeBy(P2, P2)
    ok(fp.status === 200 && fp.j.state === 'frozen', 'pending: the old key\'s signed freeze → frozen')
    now += 73 * HOUR
    ok((await lookup(P2.email)).j.binding === rp.was, '  …and the rotation in flight is gone')
  }

  // --- §39.6: a holder delete does not shorten the protection the binding had ---
  {
    const T = await person('d1b-t@example.com'); const tText = await bind(T)
    const td = await device(T)
    const { e: tRc } = await enrol(T, td)
    ok((await del(T)).status === 204, 'T deletes its binding with its key')
    ok((await rcOf(T))?.keepUntil === Number(tText.split('.')[8]), 'the recovery verifier is kept until the deleted binding\'s own expiry')
    // the thief, holding T's key and mailbox, re-binds a NEW key by email
    const X = await nextOf(T)
    now += 2 * MIN
    const xb = await bindNext(X, null)
    await api('/v1/bind/start', { stmt: xb.text, sig: xb.sig })
    const code = codeFor(T.email)!
    const c = await api('/v1/bind/complete', { email: T.email, code, sig: await X.k.sign(buildCmp(await hashOf(xb.text), code)) })
    ok(c.status === 200 && c.j.state === 'pending' && c.j.rebound === true, `a new key over the holder tomb → PENDING, not active (${c.status} ${JSON.stringify(c.j).slice(0, 60)})`)
    let l = await lookup(T.email)
    ok(l.status === 410 && l.j.state === 'pending' && l.j.pending === await hashOf(xb.text), 'lookups keep answering the tomb (410, no ✓), naming what is pending')
    {
      now += 2 * MIN
      const n0 = mailbox.length
      const yb = await bindNext(await nextOf(T), null)
      await api('/v1/bind/start', { stmt: yb.text, sig: yb.sig })
      ok(mailbox.length === n0, 'a second re-bind while one is pending over the tomb mails nothing')
    }
    {
      const q = await dreq(T, null, { op: 'freeze' }, { bindText: tText })
      ok(reason(await api('/v1/freeze', { ...q, bind: tText })) === 'state', 'in the window the tombstoned key may CONTEST only: its freeze, even bringing the deleted text, → refused')
    }
    ok(reason(await contest(T, T, xb.text, { bindText: tText })) === 'state', 'a contest by the tombstoned key WITHOUT the deleted binding\'s text → refused')
    ok(reason(await contest(T, T, xb.text, { bindText: tText, bind: tText + 'x' })) === 'state', 'a contest bringing a text that is not the tombstoned binding → refused')
    ok(reason(await contest(T, X, xb.text, { bindText: tText, bind: tText })) === 'dreq:signature', 'a "contest" signed by the new key → refused')
    const ct = await contest(T, T, xb.text, { bindText: tText, bind: tText })
    ok(ct.status === 200 && ct.j.state === 'frozen', `CONTROL: the tombstoned key contests with dreq.contest → frozen (${reason(ct)})`)
    now += 73 * HOUR
    l = await lookup(T.email)
    ok(l.status === 410 && l.j.state === 'frozen', 'the re-bind never becomes active; the tomb answers, frozen')
    ok(!!(await rcOf(T)), 'the deleted binding\'s recovery verifier is still held')
    const T2 = await nextOf(T)
    const tb = await bindNext(T2, tText)
    const r = await resolve(tb, tRc.verifier)
    ok(r.status === 200 && r.j.rebound === true, `CONTROL: the recovery code resolves the tomb freeze to the owner's new key (${reason(r)})`)
    l = await lookup(T.email)
    ok(l.status === 200 && l.j.binding === tb.text && (l.j.chain as string[]).includes(await hashOf(tText)), '  …active, with the tombstoned hash in the chain')
  }
  {
    // uncontested: the full window, then active, flagged rebound, the old verifier dropped
    const U = await person('d1b-u@example.com'); const uText = await bind(U)
    await enrol(U, await device(U))
    await del(U)
    const X = await nextOf(U)
    now += 2 * MIN
    const xb = await bindNext(X, null)
    await api('/v1/bind/start', { stmt: xb.text, sig: xb.sig })
    const code = codeFor(U.email)!
    await api('/v1/bind/complete', { email: U.email, code, sig: await X.k.sign(buildCmp(await hashOf(xb.text), code)) })
    now += 72 * HOUR - MIN
    ok((await lookup(U.email)).status === 410, 'one minute before 72 h: still the tomb')
    now += MIN
    const l = await lookup(U.email)
    ok(l.status === 200 && l.j.binding === xb.text && l.j.rebound === true && (l.j.chain as string[]).includes(await hashOf(uText)), 'uncontested for 72 h: active, rebound, the tombstoned hash in the chain (an explained discontinuity)')
    ok(!(await rcOf(U)), '  …and the deleted binding\'s recovery verifier is dropped when the window closes')
  }
  {
    // CONTROL: the same key re-binding over its own tomb is immediate
    const S = await person('d1b-s@example.com'); await bind(S)
    await del(S)
    now += 2 * MIN
    const sb = await bindNext(S, null)
    await api('/v1/bind/start', { stmt: sb.text, sig: sb.sig })
    const code = codeFor(S.email)!
    const c = await api('/v1/bind/complete', { email: S.email, code, sig: await S.k.sign(buildCmp(await hashOf(sb.text), code)) })
    ok(c.status === 200 && c.j.rebound === false && (await lookup(S.email)).status === 200, 'CONTROL: the same key over its own holder tomb → active at once, not rebound')
  }
  {
    // the same key back inside the window: its recovery code is current again, past the old expiry
    const S2 = await person('d1b-s2@example.com')
    now += 2 * MIN
    const b1 = await bindNext(S2, null, { life: 2 * HOUR })
    await api('/v1/bind/start', { stmt: b1.text, sig: b1.sig })
    let code = codeFor(S2.email)!
    await api('/v1/bind/complete', { email: S2.email, code, sig: await S2.k.sign(buildCmp(await hashOf(b1.text), code)) })
    const { e } = await enrol(S2, await device(S2))
    await del(S2)
    now += 2 * MIN
    const b2 = await bindNext(S2, null)
    await api('/v1/bind/start', { stmt: b2.text, sig: b2.sig })
    code = codeFor(S2.email)!
    await api('/v1/bind/complete', { email: S2.email, code, sig: await S2.k.sign(buildCmp(await hashOf(b2.text), code)) })
    ok(!('keepUntil' in ((await rcOf(S2)) ?? {})), 'the same key re-bound inside the window: the verifier is no longer on a deletion clock')
    now += 3 * HOUR
    await accountAlarm(await addressKey(S2.email))
    ok((await start(S2, e.verifier)).status === 200, '  …so its code still works after the deleted binding\'s expiry')
  }
  {
    // past the window with the alarm missed: the verifier is gone at the next check anyway
    const S3 = await person('d1b-s3@example.com')
    now += 2 * MIN
    const b1 = await bindNext(S3, null, { life: HOUR })
    await api('/v1/bind/start', { stmt: b1.text, sig: b1.sig })
    let code = codeFor(S3.email)!
    await api('/v1/bind/complete', { email: S3.email, code, sig: await S3.k.sign(buildCmp(await hashOf(b1.text), code)) })
    const { e } = await enrol(S3, await device(S3))
    await del(S3)
    now += 2 * HOUR
    const b2 = await bindNext(S3, null)
    await api('/v1/bind/start', { stmt: b2.text, sig: b2.sig })
    code = codeFor(S3.email)!
    await api('/v1/bind/complete', { email: S3.email, code, sig: await S3.k.sign(buildCmp(await hashOf(b2.text), code)) })
    ok(reason(await start(S3, e.verifier)) === 'invalid', 'the same key back AFTER the window, alarm missed: the old verifier is not honoured (deleted on use)')
  }
  {
    // a freeze whose binding has since expired is not "resolved": email alone re-binds it
    const H2 = await person('d1b-h2@example.com')
    now += 2 * MIN
    const b1 = await bindNext(H2, null, { life: 10 * MIN })
    await api('/v1/bind/start', { stmt: b1.text, sig: b1.sig })
    const code = codeFor(H2.email)!
    await api('/v1/bind/complete', { email: H2.email, code, sig: await H2.k.sign(buildCmp(await hashOf(b1.text), code)) })
    const { e } = await enrol(H2, await device(H2))
    ok((await freezeBy(H2, H2)).j.state === 'frozen', 'H2 is frozen')
    now += 11 * MIN
    ok(reason(await resolve(await bindNext(await nextOf(H2), b1.text), e.verifier)) === 'state', 'a freeze whose binding expired cannot be resolved (the expired re-bind applies)')
  }
  {
    // CONTROL: after the deleted binding's own expiry, a new key re-binds by email (pinners warn)
    const E = await person('d1b-e@example.com')
    now += 2 * MIN
    const eb = await bindNext(E, null, { life: 10 * MIN })
    await api('/v1/bind/start', { stmt: eb.text, sig: eb.sig })
    let code = codeFor(E.email)!
    await api('/v1/bind/complete', { email: E.email, code, sig: await E.k.sign(buildCmp(await hashOf(eb.text), code)) })
    await enrol(E, await device(E))
    ok((await del(E)).status === 204, 'E deletes a binding that has 10 minutes left')
    now += 11 * MIN
    const E2 = await nextOf(E)
    const nb = await bindNext(E2, null)
    await api('/v1/bind/start', { stmt: nb.text, sig: nb.sig })
    code = codeFor(E.email)!
    const c = await api('/v1/bind/complete', { email: E.email, code, sig: await E2.k.sign(buildCmp(await hashOf(nb.text), code)) })
    ok(c.status === 200 && c.j.rebound === true && (await lookup(E.email)).status === 200, 'CONTROL: a new key after the deleted binding\'s expiry → active + rebound')
    ok(!(await rcOf(E)), '  …and the old verifier is dropped')
  }
  {
    // the retention backstop: nothing happens after a delete, and the alarm removes the verifier at expiry
    const R2 = await person('d1b-r@example.com'); await bind(R2)
    await enrol(R2, await device(R2))
    await del(R2)
    const keep = Number((await rcOf(R2))!.keepUntil)
    const alarm = async () => accountAlarm(await addressKey(R2.email))
    await alarm()
    ok(!!(await rcOf(R2)), 'the alarm before the expiry keeps the verifier')
    now = keep + 1
    await alarm()
    ok(!(await rcOf(R2)), 'the alarm at the deleted binding\'s expiry removes it')
  }
  // =====================================================================
  // security's D1b run (85527e8a): three rows for surviving mutants, and
  // ruling (b): an EMAIL-ONLY freeze's resolution waits 72 h, and the frozen key
  // may stop it; a key-holder freeze resolves at once
  // =====================================================================
  const addrOp = async (p: P, op: string, args: Record<string, unknown>) => {
    const r = await env.ADDRESS.get(await addressKey(p.email)).fetch('https://address/op', { method: 'POST', body: JSON.stringify({ op, ...args }) })
    return { status: r.status, j: await r.json() as Record<string, unknown> }
  }
  // [a] the Address object's own resolve op, called with a key that is not the frozen binding's
  {
    const Q = await person('d1b-qa@example.com'); const qText = await bind(Q)
    ok((await freezeBy(Q, Q)).j.state === 'frozen', 'Q is frozen by its owner')
    const nb = await bindNext(await nextOf(Q), qText)
    const other = await signer()
    const r = await addrOp(Q, 'resolve', { stmt: nb.text, sig: nb.sig, key: other.pub })
    ok(r.status === 400 && reason(r) === 'state' && (await lookup(Q.email)).j.binding === qText, '[a] Address resolve with a key ≠ the frozen binding\'s → refused, still frozen')
    const c = await addrOp(Q, 'resolve', { stmt: nb.text, sig: nb.sig, key: Q.k.pub, enrolledAt: 0 })
    ok(c.status === 200 && (await lookup(Q.email)).j.binding === nb.text, '  CONTROL: the same call naming the frozen key commits (so the key check is what refused)')
  }
  // [b] a code enrolled under K1 never resolves a freeze of K2, the key it rotated to
  {
    for (const how of ['owner', 'email'] as const) {
      const K1 = await person(`d1b-qb-${how}@example.com`); await bind(K1)
      const { e: k1Rc } = await enrol(K1, await device(K1))
      const K2 = await nextOf(K1)
      const rr = await rotate(K1, K2)
      now += 73 * HOUR
      ok((await lookup(K1.email)).j.binding === rr.text, `[b/${how}] the rotation to K2 settled`)
      const k2 = { ...K1, k: K2.k, kx: K2.kx }
      ok((how === 'owner' ? (await freezeBy(k2, k2)).j.state : (await freezeByEmail(k2)).j.state) === 'frozen', `[b/${how}] K2 is frozen (${how})`)
      const r = await resolve(await bindNext(await nextOf(K1), rr.text), k1Rc.verifier)
      ok(r.status === 400 && reason(r) === 'invalid' && (await lookup(K1.email)).j.binding === rr.text && (await attOf(await lookup(K1.email))) === 'frozen', `[b/${how}] K1's recovery code resolving K2's freeze → refused, still frozen (${r.status} ${reason(r)})`)
      ok((await rcOf(K1))?.accountPub === K1.k.pub, `[b/${how}] …and a resolve deletes no orphan: it names the frozen key, not the code's`)
    }
  }
  // [c] + ruling (b): the email-only freeze, its waiting resolution, and the frozen key stopping it
  {
    const V = await person('d1b-v@example.com'); const vText = await bind(V)
    const { e: vRc } = await enrol(V, await device(V))
    ok((await freezeByEmail(V)).j.state === 'frozen', 'V is frozen by email only')
    const V2 = await nextOf(V)
    const nb = await bindNext(V2, vText)
    const n0 = noticesTo(V.email, 'resolve-pending')
    const r = await resolve(nb, vRc.verifier)
    ok(r.status === 202 && r.j.resolving === true && r.j.activeAt === now + 72 * HOUR, `(b) resolving an EMAIL-ONLY freeze → 202, waits 72 h (${r.status} ${reason(r)})`)
    ok(noticesTo(V.email, 'resolve-pending') === n0 + 1 && noticesTo(V.email, 'resolve') === 0, '  …notified as pending, not as done')
    let l = await lookup(V.email)
    ok(l.j.binding === vText && (await attOf(l)) === 'frozen' && l.j.pending === await hashOf(nb.text), '  …still frozen, the old binding served, the lookup naming the pending one')
    const st = await status(V)
    ok((st.j.pending as Record<string, unknown>)?.binding === nb.text && (st.j.pending as Record<string, unknown>)?.resolve === true, '  …the frozen key\'s status read names it')
    ok(reason(await resolve(await bindNext(await nextOf(V), vText), vRc.verifier)) === 'resolving', '(b) a second resolution while one waits → refused')
    ok(reason((await enrol(V, await device(V))).r) === 'dreq:state', '(b) while it waits, the frozen key may NOT enrol a code (only freeze or contest)')
    ok(reason(await contest(V, V2, nb.text)) === 'dreq:signature', '(b) a contest signed by the RESOLVING key → refused')
    ok(reason(await contest(V, V, vText)) === 'dreq:arg', '(b) a contest naming something other than the pending resolution → refused')
    const ct = await contest(V, V, nb.text)
    ok(ct.status === 200 && ct.j.state === 'frozen', `(b) CONTROL: the frozen key contests the waiting resolution → frozen (${reason(ct)})`)
    ok(store('Address', await addressKey(V.email))?.get('frz')?.by === 'contest', '  …now a key-holder freeze')
    l = await lookup(V.email)
    const st2 = await status(V)
    ok(!('pending' in l.j) && !('pending' in st2.j), '[c] after the contest, neither lookup nor status shows a pending binding')
    now += 73 * HOUR
    l = await lookup(V.email)
    ok(l.j.binding === vText && (await attOf(l)) === 'frozen' && !('pending' in l.j), '[c] …and 73 h later nothing settled: the old binding, frozen')
    // the code-spend rule: a resolution that WAITS leaves the code live; only a commit spends it
    ok(!!(await rcOf(V)), '(spend) a VOIDED resolution leaves the recovery code usable')
    ok(store('Address', await addressKey(V.email))?.get('frz')?.contested === true, '(contested) the freeze that voided it is marked contested')
    {
      // security's ruling: contested is SHOWN in the signed status read, NOT in the public lookup
      const st = await status(V), lk = await lookup(V.email)
      ok(st.status === 200 && st.j.state === 'frozen' && st.j.contested === true, '(contested) the signed status read says contested: true')
      ok(lk.status === 200 && !('contested' in lk.j) && !JSON.stringify(lk.j).includes('contested'), '(contested) …and the public lookup says nothing of it')
    }
    const V3 = await nextOf(V)
    const nb3 = await bindNext(V3, vText)
    const r3 = await resolve(nb3, vRc.verifier)
    ok(r3.status === 202 && r3.j.resolving === true && (await lookup(V.email)).j.binding === vText, `(contested) after a void, resolving the KEY-HOLDER freeze still waits 72 h, the code still good (${r3.status} ${reason(r3)})`)
    ok(!!(await rcOf(V)), '  …and waiting did not spend it')
    now += 73 * HOUR
    l = await lookup(V.email)
    ok(l.j.binding === nb3.text && (await attOf(l)) === 'active' && l.j.rebound === true && (l.j.chain as string[]).includes(await hashOf(vText)), '(contested) a 73 h settle in a contested freeze → active under the new key')
    ok(!(await rcOf(V)), '  …and the settle spent the code')
  }
  {
    // the same with a FREEZE by the frozen key
    const W = await person('d1b-w@example.com'); const wText = await bind(W)
    const { e: wRc } = await enrol(W, await device(W))
    await freezeByEmail(W)
    const nb = await bindNext(await nextOf(W), wText)
    ok((await resolve(nb, wRc.verifier)).status === 202, 'W: an email-only freeze\'s resolution is waiting')
    const f = await freezeBy(W, W)
    ok(f.status === 200 && f.j.state === 'frozen' && store('Address', await addressKey(W.email))?.get('frz')?.by === 'owner', '(b) the frozen key\'s signed FREEZE while it waits → an owner (key-holder) freeze')
    ok(!('pending' in (await lookup(W.email)).j) && !('pending' in (await status(W)).j), '[c] after the freeze, neither lookup nor status shows a pending binding')
    now += 73 * HOUR
    ok((await lookup(W.email)).j.binding === wText, '[c] …and 73 h later nothing settled')
    ok(reason(await freezeBy(W, W)) === 'dreq:state', '  …and with nothing waiting, "frozen: status only" holds again')
    ok(!!(await rcOf(W)) && store('Address', await addressKey(W.email))?.get('frz')?.contested === true, '(spend) voided by a freeze: the code stays usable, the freeze contested')
    ok((await status(W)).j.contested === true && !JSON.stringify((await lookup(W.email)).j).includes('contested'), '(contested) W: status says contested, lookup does not')
  }
  {
    // CONTROL for the spend rule: a resolution that COMMITS at once spends the code
    const Z = await person('d1b-z@example.com'); const zText = await bind(Z)
    const { e: zRc } = await enrol(Z, await device(Z))
    await freezeBy(Z, Z)
    ok(store('Address', await addressKey(Z.email))?.get('frz')?.contested !== true, 'Z: a plain owner freeze is not contested')
    {
      const st = await status(Z)
      ok(st.status === 200 && st.j.state === 'frozen' && !('contested' in st.j), 'CONTROL: an uncontested freeze\'s signed status carries no contested field')
      ok(!JSON.stringify((await lookup(Z.email)).j).includes('contested'), 'CONTROL: …nor its lookup')
    }
    ok((await resolve(await bindNext(await nextOf(Z), zText), zRc.verifier)).status === 200, 'CONTROL: an uncontested key-holder freeze resolves at once')
    ok(!(await rcOf(Z)), '  …and that commit spent the code')
  }
  {
    // the owner-wins sequence. The owner holds the device (the frozen key) and the
    // code; the thief holds the code and the mailbox, never the key.
    const O = await person('d1b-own@example.com'); const oText = await bind(O)
    const od = await device(O)
    const { e: oRc } = await enrol(O, od)
    const cred = await addCred(O, od)
    ok(cred.r.status === 200, 'owner: a passkey on file (CONTROL for cred-del below)')
    const thief = await nextOf(O), owner2 = await nextOf(O)
    ok((await freezeByEmail(O)).j.state === 'frozen', 'owner-wins: the thief freezes by email (the mailbox)')
    const tb = await bindNext(thief, oText)
    const tr = await resolve(tb, oRc.verifier)
    ok(tr.status === 202 && (await lookup(O.email)).j.binding === oText, 'owner-wins: the thief\'s resolution (code + mailbox) waits')
    ok((st => st.j.state === 'frozen' && (st.j.pending as Record<string, unknown>)?.binding === tb.text)(await status(O)), '  …and the owner\'s device sees it in its status read, the address still frozen')
    ok((await freezeBy(O, O)).j.state === 'frozen' && !('pending' in (await lookup(O.email)).j), 'owner-wins: the owner voids it with the frozen key')
    ok(!!(await rcOf(O)), '  …the code is still live')
    const ob = await bindNext(owner2, oText)
    const or = await resolve(ob, oRc.verifier)
    ok(or.status === 202 && (await lookup(O.email)).j.binding === oText, `owner-wins: the owner resolves; the freeze is contested, so it WAITS 72 h (${or.status} ${reason(or)})`)
    ok(reason(await freezeBy(O, thief)) === 'dreq:signature' && reason(await contest(O, thief, ob.text)) === 'dreq:signature', 'owner-wins: the thief cannot void it (no frozen key: freeze and contest → refused)')
    ok(reason(await resolve(await bindNext(thief, oText, { life: 12 * MONTH }), oRc.verifier)) === 'resolving', 'owner-wins: nor replace it with a resolution of its own')
    const m0 = mailbox.filter((m) => m.to === O.email && (m as unknown as { freezeToken?: string }).freezeToken).length
    now += 2 * MIN; await api('/v1/freeze/start', { email: O.email })
    ok(mailbox.filter((m) => m.to === O.email && (m as unknown as { freezeToken?: string }).freezeToken).length === m0, '  …nor email-freeze it again (frozen: no freeze mail)')
    // pin: while a resolution waits, the frozen key signs freeze/contest and nothing else
    const rc0 = JSON.stringify(await rcOf(O))
    ok(reason((await enrol(O, od)).r) === 'dreq:state', '(pin) while it waits, the frozen key\'s rc-enrol → refused')
    ok(reason((await addCred(O, od)).r) === 'dreq:state', '(pin) …its cred-add → refused')
    { const q = await dreq(O, od, { op: 'cred-del', credentialId: b64uEnc(cred.reg.credId) }, { purpose: 'cred-del' })
      ok(reason(await api('/v1/cred/del', { ...q, credentialId: b64uEnc(cred.reg.credId) })) === 'dreq:state', '(pin) …its cred-del → refused') }
    ok(JSON.stringify(await rcOf(O)) === rc0 && (await lookup(O.email)).j.pending === await hashOf(ob.text), '  …the code and the waiting resolution untouched')
    now += 73 * HOUR
    const l = await lookup(O.email)
    ok(l.j.binding === ob.text && (await attOf(l)) === 'active' && !(await rcOf(O)), 'owner-wins: 73 h later the OWNER\'s key is the binding, and the code is spent')
  }
  {
    // CONTROL: uncontested, the resolution lands at 72 h, not before
    const Y = await person('d1b-y@example.com'); const yText = await bind(Y)
    const { e: yRc } = await enrol(Y, await device(Y))
    await freezeByEmail(Y)
    const Y2 = await nextOf(Y)
    const nb = await bindNext(Y2, yText)
    ok((await resolve(nb, yRc.verifier)).status === 202, 'Y: waiting')
    now += 72 * HOUR - MIN
    ok((await lookup(Y.email)).j.binding === yText, 'one minute before 72 h: still the frozen binding')
    now += MIN
    const l = await lookup(Y.email)
    ok(l.j.binding === nb.text && (await attOf(l)) === 'active' && l.j.rebound === true && !('rot' in l.j) && !('pending' in l.j) && (l.j.chain as string[]).includes(await hashOf(yText)), 'CONTROL: uncontested for 72 h → active under the new key, rebound, no vouch, the frozen hash in the chain')
    const y2 = { ...Y, k: Y2.k, kx: Y2.kx }
    ok(((await status(y2)).j.events as { k: string }[]).some((e) => e.k === 'resolve'), '  …and the event list records the move')
  }
  {
    // a resolution waiting on a binding that expires in the meantime moves nothing
    const X = await person('d1b-x@example.com')
    now += 2 * MIN
    const b1 = await bindNext(X, null, { life: HOUR })
    await api('/v1/bind/start', { stmt: b1.text, sig: b1.sig })
    const code = codeFor(X.email)!
    await api('/v1/bind/complete', { email: X.email, code, sig: await X.k.sign(buildCmp(await hashOf(b1.text), code)) })
    const { e } = await enrol(X, await device(X))
    await freezeByEmail(X)
    ok((await resolve(await bindNext(await nextOf(X), b1.text), e.verifier)).status === 202, 'X: waiting on a binding with an hour left')
    now += 73 * HOUR
    ok((await lookup(X.email)).status === 404, 'the frozen binding expired while it waited: nothing moves (an expired binding re-binds by email, as ever)')
  }

  // --- the bind re-check (setup resumes after a failed check of the bind answer) ---
  {
    const RB = await person('d1b-rb@example.com'); const t = await bind(RB)
    const check = async (stmt: string, sig: string) => api('/v1/bind/check', { stmt, sig })
    const r = await check(t, await RB.k.sign(t)) // a fresh signature: any valid one over the bound text
    ok(r.status === 200 && r.j.binding === t && (await attOf(r)) === 'active', `re-check: the bound statement → the bind answer again, attested active (${r.status})`)
    const other = await bindNext(RB, null, { life: 12 * MONTH }) // differs from the bound text only in its expiry
    { const o = await check(other.text, other.sig); ok(o.status === 404, `re-check: the same key, a statement that is not the bound one → 404 (${o.status} ${reason(o)})`) }
    ok((await check(t, await (await signer()).sign(t))).status === 400, 're-check: a signature by another key → 400')
    await freezeBy(RB, RB)
    ok((await attOf(await check(t, await RB.k.sign(t)))) === 'frozen', 're-check: on a frozen address the attestation says frozen')
    // over a holder tomb: the pending answer bind/complete gave
    const TB = await person('d1b-tb@example.com'); await bind(TB)
    await del(TB)
    now += 2 * MIN
    const XT = await nextOf(TB)
    const xb = await bindNext(XT, null)
    await api('/v1/bind/start', { stmt: xb.text, sig: xb.sig })
    const code = codeFor(TB.email)!
    await api('/v1/bind/complete', { email: TB.email, code, sig: await XT.k.sign(buildCmp(await hashOf(xb.text), code)) })
    const xo = await bindNext(XT, null, { life: 12 * MONTH })
    ok((await check(xo.text, xo.sig)).status === 404, 're-check: over a holder tomb, a statement that is not the pending one → 404')
    const c = await check(xb.text, xb.sig)
    ok(c.status === 200 && c.j.state === 'pending' && c.j.rebound === true, 're-check: a re-bind over a holder tomb → the same pending answer bind/complete gave')
  }

  // --- the first-credential setup allowance (security's ruling, §39.3) ---
  {
    const addrStore = async (p: P) => store('Address', await addressKey(p.email))!
    const acctStore = async (p: P) => store('Account', await addressKey(p.email))!
    const armed = async (p: P) => (await addrStore(p)).has('setup')
    const nCreds = async (p: P) => (((await acctStore(p))?.get('creds') as string[] | undefined) ?? []).length
    /** a same-key renewal: a new emailed code, both proofs again */
    async function renew(p: P) {
      now += 2 * MIN
      const n = await bindNext(p, await current(p))
      await api('/v1/bind/start', { stmt: n.text, sig: n.sig })
      const code = codeFor(p.email)!
      const c = await api('/v1/bind/complete', { email: p.email, code, sig: await p.k.sign(buildCmp(await hashOf(n.text), code)) })
      ok(c.status === 200 && c.j.rebound === false, `  (a same-key renewal for ${p.email} lands: ${reason(c)})`)
    }
    const delCred = async (p: P, d: D | null, id: Uint8Array, purpose?: string, passkey?: Pk) => {
      const credentialId = b64uEnc(id)
      const q = await dreq(p, d, { op: 'cred-del', credentialId }, { purpose })
      if (passkey) q.consent = await waConsent(passkey, q.challenge, q.req, 'cred-del') as never
      return api('/v1/cred/del', { ...q, credentialId })
    }
    const free = { purpose: null } as const // the request carries no consent at all

    // row 1, the control; row 2, once each
    {
      const S = await person('setup-1@example.com'); await bind(S, { setup: true })
      const d = await device(S, { consent: false }) // the light tier: it has nothing to consent with yet
      ok(await armed(S), 'CONTROL: a fresh two-proof bind arms the setup allowance')
      const c = await addCred(S, d, free)
      ok(c.r.status === 200, `row 1: with no consent, the first passkey is accepted inside the window (${reason(c.r)})`)
      ok(reason((await addCred(S, d, free)).r) === 'consent:consent', 'row 2: a second cred-add in the window → refused')
      ok(await nCreds(S) === 1, '  …and nothing was added')
      ok(reason(await delCred(S, null, c.reg.credId)) === 'consent:consent', 'cred-del is not an allowance op: no consent → refused, inside the window')
      const e = await enrol(S, d, enrolment(), free)
      ok(e.r.status === 200, `row 1: with no consent, the first recovery code is accepted inside the window (${reason(e.r)})`)
      const rc = JSON.stringify(await rcOf(S))
      ok(reason((await enrol(S, d, enrolment(), free)).r) === 'consent:consent' && JSON.stringify(await rcOf(S)) === rc, 'row 2: a second rc-enrol in the window → refused, the code unchanged')
      ok(!(await armed(S)), '  …both ops used: the allowance is gone')
      ok((await fetchBlob(c.reg.key, c.reg.credId)).status === 200, 'a passkey added at setup fetches its blob like any other')
      const evs = (await status(S)).j.events as { k: string; setup?: boolean }[]
      ok(evs.some((x) => x.k === 'cred-add' && x.setup === true) && evs.some((x) => x.k === 'rc-enrol' && x.setup === true), 'rule 7: both events say they were at setup')
      ok(noticesTo(S.email, 'cred-add-setup') === 1 && noticesTo(S.email, 'rc-enrol-setup') === 1, '  …and both ops mail a notice that says so')
      const ke = store('Address', kScope)!.get('events') as { k: string; setup?: boolean }[]
      ok(ke.some((x) => x.k === 'cred-add') && !ke.some((x) => 'setup' in x), 'CONTROL: an ordinary passkey add carries no setup mark')
      const flags = [...((await acctStore(S))?.keys() ?? [])].filter((k) => k.startsWith('ever:'))
      ok(flags.length === 1 && !flags[0].includes(S.k.pub), 'the "ever" flag is stored by hash, not by the account key')
    }
    // row 3: the proposal's bypass. Row 5: a renewal does not arm
    {
      const S = await person('setup-3@example.com'); await bind(S)
      const d = await device(S)
      ok((await enrol(S, d)).r.status === 200 && await nCreds(S) === 0, '  (S has a code and no passkey: zero credentials, not a new account)')
      ok(reason((await addCred(S, d, free)).r) === 'consent:consent', "row 3: an account with a code and no passkey, key-signed cred-add, no consent → refused")
      await renew(S)
      ok(!(await armed(S)), 'row 5: a same-key renewal of an account that has had a code does not arm')
      ok(reason((await addCred(S, d, free)).r) === 'consent:consent', '  …so a thief who also renews gets no passkey by it')
      ok((await addCred(S, d)).r.status === 200, 'CONTROL: the same add WITH consent is accepted')
    }
    // row 4: a count of current credentials is not "never"
    {
      const S = await person('setup-4@example.com'); await bind(S)
      const d = await device(S)
      const c = await addCred(S, d)
      ok((await delCred(S, d, c.reg.credId, 'cred-del')).status === 200 && await nCreds(S) === 0, '  (the last credential is deleted: back to zero)')
      await renew(S)
      ok(!(await armed(S)), 'row 4: renewing after the last credential was deleted does not arm')
      ok(reason((await addCred(S, d, free)).r) === 'consent:consent', '  …and a cred-add with no consent → refused')
      ok(reason((await enrol(S, d, enrolment(), free)).r) === 'consent:consent', '  …so is an rc-enrol')
    }
    // a holder deletion clears the slots, not the flag
    {
      const S = await person('setup-del@example.com'); await bind(S, { setup: true })
      const d = await device(S, { consent: false })
      ok((await addCred(S, d, free)).r.status === 200, '  (a passkey at setup)')
      ok((await del(S)).status === 204 && !(await armed(S)), 'a holder deletion ends the window')
      now += DAY
      await bind(S)
      ok(!(await armed(S)) && await nCreds(S) === 0, 'the same key re-bound after its own deletion has zero passkeys and is NOT armed: wipe never clears the flag')
    }
    // row 6: the window's edge, and re-arming by email
    {
      const S = await person('setup-6@example.com'); await bind(S, { setup: true })
      const d = await device(S, { consent: false })
      now += 15 * MIN
      ok(reason((await addCred(S, d, free)).r) === 'consent:consent', 'row 6: at exactly 15 minutes the window is over → refused')
      ok(reason((await enrol(S, d, enrolment(), free)).r) === 'consent:consent', '  …for rc-enrol too')
      await renew(S)
      ok(await armed(S), 'row 6: a new email code on a never-enrolled account re-arms')
      now += 15 * MIN - 1 // the last millisecond of the new window
      ok((await addCred(S, d, free)).r.status === 200, 'row 6: inside the new window the first passkey is accepted')
    }
    // row 7: absent, never rescued
    {
      const S = await person('setup-7@example.com'); await bind(S, { setup: true })
      const d = await device(S)
      ok(reason((await addCred(S, d, { purpose: 'cred-del' })).r).startsWith('consent:cns:'), 'row 7: a bad consent inside the window → refused, no fall-through')
      ok(reason((await addCred(S, d, { consent: '' })).r) === 'consent:consent', '  …an empty one is presented too, and refused')
      ok(reason((await addCred(S, d, { consent: 0 })).r) === 'consent:consent', '  …so is a zero')
      ok(reason((await enrol(S, d, enrolment(), { purpose: 'cred-add' })).r).startsWith('consent:cns:'), '  …and on rc-enrol')
      ok(await nCreds(S) === 0 && !(await rcOf(S)), '  …and nothing landed')
      ok((await addCred(S, d, free)).r.status === 200, 'CONTROL: the same window with consent ABSENT is accepted')
    }
    // row 8: it only fills empty slots
    {
      const S = await person('setup-8@example.com'); await bind(S, { setup: true })
      const d = await device(S)
      const held = await enrol(S, d) // a consented code, inside the window
      ok(held.r.status === 200, '  (a code enrolled with consent inside the window)')
      const rc = JSON.stringify(await rcOf(S))
      const e = await enrol(S, d, enrolment(), free)
      ok(reason(e.r) === 'filled', `row 8: rc-enrol under the allowance where a code exists → refused (${reason(e.r)})`)
      ok(JSON.stringify(await rcOf(S)) === rc && (await api('/v1/recovery/salt', { email: S.email })).j.saltV === held.e.saltV, '  …the code unchanged')
      const added = await addCred(S, d) // and the same for a passkey
      ok(added.r.status === 200, '  (a passkey added with consent inside the window)')
      ok(reason((await addCred(S, d, free)).r) === 'filled' && await nCreds(S) === 1, 'rule 5: cred-add under the allowance where a passkey exists → refused')
    }
    // row 9: frozen. Rule 6: it dies early
    {
      const S = await person('setup-9@example.com'); await bind(S, { setup: true })
      const d = await device(S, { consent: false })
      const e = await enrol(S, d, enrolment(), free)
      ok(e.r.status === 200 && await armed(S), '  (armed, the cred-add still unused)')
      ok((await freezeBy(S, S)).status === 200 && !(await armed(S)), 'rule 6: a freeze clears the allowance')
      ok(reason((await addCred(S, d, free)).r) === 'dreq:state', 'row 9: armed, then frozen → refused')
      const S2 = await nextOf(S)
      const nb = await bindNext(S2, await current(S))
      ok((await resolve(nb, e.e.verifier)).status === 200, '  (the freeze is resolved to a new key)')
      ok(!(await armed(S)), 'row 9: a resolution arms nothing')
      ok(reason((await addCred(S2, d, free)).r) === 'consent:consent', 'row 9: still refused after the freeze resolves')
    }
    for (const [how, end] of [
      ['an email freeze', async (p: P) => freezeByEmail(p)],
      ['a rotation start', async (p: P) => (await rotate(p, await nextOf(p))).st],
    ] as const) {
      const S = await person(`setup-end-${how.length}@example.com`); await bind(S, { setup: true })
      const before = await armed(S)
      const r = await end(S)
      ok(before && r.status < 300 && !(await armed(S)), `rule 6: ${how} clears the allowance`)
    }
    {
      const S = await person('setup-new@example.com'); await bind(S, { setup: true })
      const d = await device(S, { consent: false })
      ok((await addCred(S, d, free)).r.status === 200, '  (the passkey half of the allowance is used)')
      await renew(S)
      ok(!(await armed(S)) && reason((await enrol(S, d, enrolment(), free)).r) === 'consent:consent', 'rule 6: a new bind ends the window; the unused op is gone with it')
    }
    {
      // it names the bind that armed it
      const S = await person('setup-names@example.com'); await bind(S, { setup: true })
      const d = await device(S, { consent: false })
      const su = (await addrStore(S)).get('setup') as { h: string }
      ;(await addrStore(S)).set('setup', { ...su, h: await hashOf('another binding') })
      ok(reason((await addCred(S, d, free)).r) === 'consent:consent', 'an allowance naming another binding → refused')
    }
    // row 10: a bind that ends pending never arms
    {
      const T = await person('setup-10@example.com'); await bind(T)
      ok((await del(T)).status === 204, '  (a holder deletion: the tomb protects the address)')
      const T2 = await nextOf(T)
      now += 2 * MIN
      const b = await bindNext(T2, null)
      await api('/v1/bind/start', { stmt: b.text, sig: b.sig })
      const code = codeFor(T.email)!
      const c = await api('/v1/bind/complete', { email: T.email, code, sig: await T2.k.sign(buildCmp(await hashOf(b.text), code)) })
      ok(c.status === 200 && c.j.state === 'pending', '  (a new key over the tomb ended pending)')
      ok(!(await armed(T)), 'row 10: a bind that ended pending is not armed')
      now += 73 * HOUR
      ok((await lookup(T.email)).j.binding === b.text && !(await armed(T)), 'row 10: nor does it arm when it settles to active')
      ok(!(await addrStore(T)).has('grace'), '  …and with no vouch it opens no rotation grace')
      ok(reason((await addCred(T2, await device(T2, { consent: false }), free)).r) === 'consent:consent', '  …so a cred-add with no consent → refused')
    }

    // --- a rebound takes the old key's passkeys, as it takes its code ---
    {
      const E = await person('rebound-exp@example.com'); await bind(E, { setup: true })
      const d = await device(E, { consent: false })
      const c = await addCred(E, d, free)
      const e = await enrol(E, d, enrolment(), free)
      ok(c.r.status === 200 && e.r.status === 200, '  (the old key has a passkey and a code)')
      const ck = b64uEnc(await sha(c.reg.credId))
      const keep = await person('rebound-keep@example.com'); await bind(keep)
      const kc = await addCred(keep, await device(keep))
      await renew(keep)
      ok(await nCreds(keep) === 1 && (await fetchBlob(kc.reg.key, kc.reg.credId)).status === 200, 'CONTROL: a same-key renewal keeps the passkey')
      now += 14 * MONTH // E's binding expires
      const E2 = await nextOf(E)
      const b = await bindNext(E2, null)
      await api('/v1/bind/start', { stmt: b.text, sig: b.sig })
      const code = codeFor(E.email)!
      const r = await api('/v1/bind/complete', { email: E.email, code, sig: await E2.k.sign(buildCmp(await hashOf(b.text), code)) })
      ok(r.status === 200 && r.j.rebound === true, `  (a new key over the expired binding: rebound, ${reason(r)})`)
      ok(await nCreds(E) === 0 && !store('Cred', ck)?.has('cred'), "a rebound over an expired binding drops the old key's passkeys: the index and the Cred")
      ok(!(await rcOf(E)), "  …and its recovery record (before this it lingered until the next attempt)")
      ok(reason(await fetchBlob(c.reg.key, c.reg.credId)) === 'unknown', '  …so the old passkey fetches nothing')
      ok(await armed(E), '  …and the new key, which never had anything, is armed')
      const d2 = await device(E2, { consent: false })
      const c2 = await addCred(E2, d2, free)
      ok(c2.r.status === 200, `the new key's first passkey fills the emptied slot: the new owner is not stuck (${reason(c2.r)})`)
      ok((await enrol(E2, d2, enrolment(), free)).r.status === 200, "  …and its first code")
    }
    {
      // a resolved freeze is a rebound too: the frozen key's passkey must not consent for the new key
      const A = await person('rebound-res@example.com'); await bind(A)
      const d = await device(A)
      const c = await addCred(A, d)
      const e = await enrol(A, d)
      const ck = b64uEnc(await sha(c.reg.credId))
      ok((await freezeBy(A, A)).status === 200, '  (frozen by its key)')
      const A2 = await nextOf(A)
      ok((await resolve(await bindNext(A2, await current(A)), e.e.verifier)).status === 200, '  (resolved to a new key)')
      ok(await nCreds(A) === 0 && !store('Cred', ck)!.has('cred') && !(await rcOf(A)), "a resolved freeze drops the frozen key's passkeys and spends its code")
    }
    {
      // a VOUCHED rotation is not a rebound: the index stays (§9.4 re-enrols in the same flow)
      const A = await person('rotate-keeps@example.com'); await bind(A)
      await addCred(A, await device(A))
      const A2 = await nextOf(A)
      await rotate(A, A2)
      now += 73 * HOUR
      ok((await lookup(A.email)).j.binding !== undefined && await nCreds(A) === 1, "CONTROL: a settled rotation leaves the passkey index alone")
    }

    // --- a vouched rotation bounds the old key's passkeys ---
    const hasGrace = async (p: P) => (await addrStore(p)).has('grace')
    const ckOf = async (c: { reg: { credId: Uint8Array } }) => b64uEnc(await sha(c.reg.credId))
    const credGone = async (c: { reg: { credId: Uint8Array } }) => !store('Cred', await ckOf(c))?.has('cred')
    const gone = (p: P) => noticesTo(p.email, 'cred-old-del')
    /** a key with a passkey (and a code), rotated to a new key, settled */
    async function rotated(email: string, o: { code?: boolean; nocred?: boolean; life?: number } = {}) {
      const A = await person(email); await bind(A)
      const d = await device(A)
      const c = o.nocred ? null as never : await addCred(A, d)
      const e = o.code ? await enrol(A, d) : null
      const A2 = await nextOf(A)
      const r = await rotate(A, A2, { life: o.life })
      if (r.st.status !== 202 || r.c.status !== 200) throw new Error('rotation failed for ' + email)
      const graceEnd = now + 72 * HOUR + 30 * DAY
      now += 73 * HOUR
      await lookup(email)
      return { A, A2, c, e, d2: await device(A2, { consent: false }), graceEnd }
    }
    {
      // the control for every WebAuthn refusal below: a key's own passkey consents to all of it
      const B = await person('grace-own@example.com'); await bind(B)
      const d = await device(B)
      const c1 = await addCred(B, d), c2 = await addCred(B, d)
      ok((await addCred(B, d, { passkey: c1.reg })).r.status === 200, 'CONTROL: a passkey consents to cred-add for its own key')
      ok((await enrol(B, d, enrolment(), { passkey: c1.reg })).r.status === 200, 'CONTROL: …and to rc-enrol')
      ok((await delCred(B, null, c2.reg.credId, undefined, c1.reg)).status === 200, 'CONTROL: …and to cred-del')
      ok((await rotate(B, await nextOf(B), { passkey: c1.reg })).st.status === 202, 'CONTROL: …and to a rotation')
    }
    {
      // old blob: served while the key is current, never after the settle
      const A = await person('grace-blob@example.com'); await bind(A)
      const c = await addCred(A, await device(A))
      await rotate(A, await nextOf(A))
      ok((await fetchBlob(c.reg.key, c.reg.credId)).status === 200, 'CONTROL: while a rotation is pending the old blob is still the current one')
      now += 73 * HOUR
      ok(reason(await fetchBlob(c.reg.key, c.reg.credId)) === 'stale', 'grace: an old-key blob is not served after the settle: stale')
      ok(await hasGrace(A) && !(await credGone(c)), '  …though the grace is open and the passkey is still there')
    }
    {
      // in the grace: cred-add, and nothing else
      const { A, A2, c, d2 } = await rotated('grace-ops@example.com')
      const e = await enrol(A2, d2, enrolment(), { passkey: c.reg })
      ok(reason(e.r) === 'consent:webauthn:unknown' && !(await rcOf(A2)), `grace: an old passkey refused for rc-enrol: passkey first, enforced (${reason(e.r)})`)
      ok(await hasGrace(A) && !(await credGone(c)), '  …which does not end the grace: only a credential does')
      const A3 = await nextOf(A2)
      ok(reason((await rotate(A2, A3, { passkey: c.reg })).st) === 'consent:webauthn:unknown', 'grace: an old passkey refused for rotate')
      ok(reason(await delCred(A2, null, c.reg.credId, undefined, c.reg)) === 'consent:webauthn:unknown' && !(await credGone(c)), 'grace: an old passkey refused for cred-del')
      const n = await addCred(A2, d2, { passkey: c.reg })
      ok(n.r.status === 200, `grace: CONTROL an old passkey consents to cred-add for the new key (${reason(n.r)})`)
      ok(!(await hasGrace(A)) && await credGone(c) && await nCreds(A) === 1 && !(await credGone(n)), "grace: the first new-key credential ends it: the old passkey goes, the new one stays")
      ok(gone(A) === 1, '  …with a notice')
      ok(reason((await addCred(A2, d2, { passkey: c.reg })).r) === 'consent:webauthn:unknown', 'grace: an old passkey refused after the first new credential')
    }
    {
      // the 30 days, to the millisecond
      const { A, A2, c, e, d2, graceEnd } = await rotated('grace-30@example.com', { code: true })
      ok(reason((await addCred(A2, d2, { purpose: null })).r) === 'consent:consent', '  (no allowance is armed by a settle)')
      now = graceEnd
      ok(reason((await addCred(A2, d2, { passkey: c.reg })).r) === 'consent:webauthn:unknown', 'grace: an old passkey refused at 30 days')
      ok(await credGone(c) && await nCreds(A) === 0 && gone(A) === 1, '  …the old passkeys are deleted, with a notice')
      ok(((await status(A2)).j.events as { k: string }[]).some((x) => x.k === 'cred-old-del'), '  …and the event list says so')
      // the way back: both proofs, and it still fills empty slots only
      const code = JSON.stringify(await rcOf(A2))
      await renew(A2)
      ok(await armed(A), 'grace: after it, a fresh email proof re-arms the allowance: the new key has never had a credential')
      ok((await addCred(A2, d2, free)).r.status === 200, '  …and the light tier is back in, with no passkey in hand')
      ok(reason((await enrol(A2, d2, enrolment(), free)).r) === 'filled' && JSON.stringify(await rcOf(A2)) === code, '  …and the allowance fills empty slots only: refused, the dead old-key code unchanged')
      void e
    }
    {
      // the last moment of the grace, and the one order that strands nobody
      const { A2, c, d2, graceEnd } = await rotated('grace-edge@example.com')
      now = graceEnd - 1
      const n = await addCred(A2, d2, { passkey: c.reg })
      ok(n.r.status === 200, 'grace: still open a millisecond before 30 days')
      ok((await enrol(A2, d2, enrolment(), { passkey: n.reg })).r.status === 200, "  …and the code then lands by the new passkey's ordinary consent")
    }
    {
      // a planted old passkey can't overwrite a code the new key already has
      const { A, A2, c, d2 } = await rotated('grace-plant@example.com')
      await renew(A2)
      ok((await enrol(A2, d2, enrolment(), free)).r.status === 200, "  (the new key's own code, by the allowance)")
      const code = JSON.stringify(await rcOf(A2))
      ok(await hasGrace(A), '  (a code is not a credential: the grace is still open)')
      ok(reason((await enrol(A2, d2, enrolment(), { passkey: c.reg })).r) === 'consent:webauthn:unknown' && JSON.stringify(await rcOf(A2)) === code, "grace: an old passkey can't replace the new key's code")
    }
    {
      // the old key's code slot is left alone too, when the grace ends with it unclaimed
      const { A, A2, e, graceEnd } = await rotated('grace-rc@example.com', { code: true })
      now = graceEnd
      await lookup(A.email)
      ok((await rcOf(A))?.accountPub === A.k.pub && !!e, "grace: its end leaves the code slot as it was (a rebound's rekey would empty it)")
      void A2
    }
    {
      // nobody calls: the alarm does it
      const { A, c, graceEnd } = await rotated('grace-alarm@example.com')
      const scope = await addressKey(A.email)
      ok(alarms.get(`Address:${scope}`) === graceEnd, 'grace: the settle sets the alarm for its end')
      now = graceEnd - 1
      await addressAlarm(scope)
      ok(await hasGrace(A) && !(await credGone(c)) && alarms.get(`Address:${scope}`) === graceEnd, '  …an early alarm changes nothing and keeps the appointment')
      now = graceEnd
      await addressAlarm(scope)
      ok(await credGone(c) && gone(A) === 1, 'grace: with no request at all, the alarm deletes the old passkeys, with a notice')
    }
    {
      const { A, graceEnd } = await rotated('grace-empty@example.com', { nocred: true })
      now = graceEnd
      await lookup(A.email)
      ok(!(await hasGrace(A)) && gone(A) === 0, 'grace: a rotation that left no passkey behind ends with no notice')
    }
    {
      // late to the settle: the grace counts from when it settled, not from who noticed
      const A = await person('grace-late@example.com'); await bind(A)
      const c = await addCred(A, await device(A))
      await rotate(A, await nextOf(A))
      now += 72 * HOUR + 30 * DAY
      await lookup(A.email)
      ok(await credGone(c) && !(await hasGrace(A)) && gone(A) === 1, 'grace: first request 33 days on: it settled and lapsed in the one pass')
    }
    {
      // the allowance only fills an empty slot, and old passkeys are not one
      const { A, A2, d2 } = await rotated('grace-filled@example.com')
      await renew(A2)
      ok(await armed(A), '  (a key with nothing is armed, as rule 1 says)')
      ok(reason((await addCred(A2, d2, free)).r) === 'filled', 'grace: the allowance does not add beside old passkeys in the grace')
    }
    {
      // the first credential is decided where the list lives, if the Address never hears of it
      const { A, A2, c, d2 } = await rotated('grace-lost@example.com')
      failing('Address', 'credLanded', 1)
      const n = await addCred(A2, d2, { passkey: c.reg })
      ok(n.r.status === 200 && await hasGrace(A) && !(await credGone(c)), '  (the Address object missed the landing)')
      ok(reason((await addCred(A2, d2, { passkey: c.reg })).r) === 'grace-over', 'grace: a lost landing still ends it: cred-add refused by the Account')
      ok(reason((await enrol(A2, d2, enrolment(), { passkey: c.reg })).r) === 'consent:webauthn:unknown', '  …and rc-enrol was never in it')
      ok((await addCred(A2, d2, { passkey: n.reg })).r.status === 200, "CONTROL: the new passkey's own consent is not grace")
      // the grace is still open when the next rotation settles, and this time the previous key HAS a passkey
      await rotate(A2, await nextOf(A2))
      now += 73 * HOUR
      await lookup(A.email)
      ok(await credGone(c) && !(await credGone(n)), "grace: the settle's clean-up takes the key before last and keeps the previous key's passkeys")
    }
    {
      // a registration the Cred refuses is rolled back whole: it was no first credential
      const O = await person('grace-other@example.com'); await bind(O)
      const taken = await addCred(O, await device(O))
      const { A, A2, c, d2 } = await rotated('grace-rollback@example.com')
      ok(reason((await addCred(A2, d2, { passkey: c.reg, credId: taken.reg.credId })).r) === 'exists', "  (a credential id another account holds: refused at the Cred)")
      ok(await hasGrace(A) && await nCreds(A) === 1, 'grace: a rolled-back registration does not end it')
      ok((await addCred(A2, d2, { passkey: c.reg })).r.status === 200, '  …and the old passkey can still consent to the real one')
    }
    {
      // a deletion takes the grace and the record of who owned what
      const { A, A2, c } = await rotated('grace-del@example.com')
      ok((await del(A2)).status === 204, '  (the holder deletes the binding)')
      ok(!(await hasGrace(A)) && await credGone(c) && !(await acctStore(A)).has('owners'), 'grace: a deletion ends it, and leaves no account key in the passkey owners')
    }
    {
      // the binding runs out inside the grace: a new key is a rebound, with no grace left to inherit
      const { A, A2, c, d2 } = await rotated('grace-expiry@example.com', { life: 10 * DAY })
      void d2
      now += 8 * DAY
      ok(!!(await hasGrace(A)) && (await lookup(A.email)).status === 404, '  (the binding expired, the grace not yet)')
      const A3 = await nextOf(A2)
      const b = await bindNext(A3, null)
      await api('/v1/bind/start', { stmt: b.text, sig: b.sig })
      const code = codeFor(A.email)!
      const r = await api('/v1/bind/complete', { email: A.email, code, sig: await A3.k.sign(buildCmp(await hashOf(b.text), code)) })
      ok(r.j.rebound === true && !(await hasGrace(A)) && await credGone(c), `grace: a rebound inside it ends it, with no notice owed (${reason(r)})`)
    }
    {
      // only the IMMEDIATELY previous key
      const { A, A2, c } = await rotated('grace-two@example.com')
      const A3 = await nextOf(A2)
      await rotate(A2, A3)
      now += 73 * HOUR
      await lookup(A.email)
      ok(await credGone(c) && gone(A) === 1, 'grace: a second rotation settling takes the key before last')
      ok((await addrStore(A)).get('grace') !== undefined && ((await addrStore(A)).get('grace') as { key: string }).key === A2.k.pub, '  …and the grace now names the previous key')
    }
    {
      // a retry's alarm replaces the grace's: the tick puts the appointment back
      const { A, A2, c } = await rotated('grace-tick@example.com')
      await rotate(A2, await nextOf(A2))
      const end = now + 72 * HOUR + 30 * DAY
      now += 73 * HOUR
      failing('Account', 'rekey', 1)
      await lookup(A.email)
      const scope = await addressKey(A.email)
      ok(alarms.get(`Address:${scope}`) === now + 3_600_000 && !(await credGone(c)), '  (the clean-up failed: the alarm is the retry)')
      await addressAlarm(scope)
      ok(await credGone(c) && alarms.get(`Address:${scope}`) === end, 'grace: after the retry the alarm is back on the grace\'s end')
    }
    {
      const { A, A2, c, d2 } = await rotated('grace-keep@example.com')
      const n = await addCred(A2, await device(A2))
      ok(await credGone(c) && gone(A) === 1, '  (a native key added the first credential: the same end, by consent of its own)')
      const A3 = await nextOf(A2)
      await rotate(A2, A3)
      now += 73 * HOUR
      await lookup(A.email)
      ok(!(await credGone(n)) && await nCreds(A) === 1 && gone(A) === 1, "CONTROL: the previous key's passkey survives the next rotation")
      ok((await addCred(A3, d2, { passkey: n.reg })).r.status === 200, '  …and has its own grace')
    }
    {
      // no grace where there was no vouch
      const { A, A2, c } = await rotated('grace-freeze@example.com')
      ok((await freezeBy(A2, A2)).status === 200, '  (frozen by the new key)')
      ok(!(await hasGrace(A)) && await credGone(c) && gone(A) === 1, 'grace: a freeze ends it: a key reported lost keeps nothing for a renewal to pick up')
    }
    {
      const { A, A2, d2 } = await rotated('grace-res@example.com')
      await renew(A2)
      const e = await enrol(A2, d2, enrolment(), free)
      ok((await freezeBy(A2, A2)).status === 200, '  (frozen)')
      const A3 = await nextOf(A2)
      ok((await resolve(await bindNext(A3, await current(A2)), e.e.verifier)).status === 200 && !(await hasGrace(A)), 'grace: recovery gets none')
    }

    // --- a young code: resolving with one waits, on any account ---
    // Key + passkey could enrol a code, freeze and resolve to a third key at once:
    // a rotation by another door, with no 72 h contest. A waiting resolution is what
    // gives the owner their answer.
    const rcAt = async (p: P) => (await rcOf(p))!.at as number
    const stuck = async (p: P, text: string, label: string) => {
      const l = await lookup(p.email)
      ok(l.j.binding === text && (await attOf(l)) === 'frozen', label)
    }
    /** the frozen key voids the waiting resolution, and nothing settles after it */
    async function voided(p: P, by: P, text: string, label: string) {
      ok((await freezeBy(p, by)).status === 200 && (await addrStore(p)).get('frz')?.contested === true && !(await addrStore(p)).has('rsv'), `${label}: the frozen key voids it, and the freeze is contested`)
      now += 73 * HOUR
      await stuck(p, text, `${label}: 73 h later nothing moved`)
      ok(!!(await rcOf(p)), `${label}: and the voided resolution spent no code`)
    }
    {
      // CONTROL: the front door, the same two factors: a rotation waits and can be contested
      const B = await person('young-rotate@example.com'); const text = await bind(B)
      const c = await addCred(B, await device(B))
      const r = await rotate(B, await nextOf(B), { passkey: c.reg })
      ok(r.st.status === 202 && (await lookup(B.email)).j.binding === text, 'young: CONTROL key + passkey rotating waits, the old binding served')
    }
    {
      const A = await person('young-chain@example.com'); const text = await bind(A)
      const d = await device(A)
      const c = await addCred(A, d)
      const own = await enrol(A, d, enrolment(), { passkey: c.reg })
      const t = await enrol(A, d, enrolment(), { passkey: c.reg, young: true })
      ok(t.r.status === 200, '  (key + passkey replace the code)')
      ok((await freezeBy(A, A)).status === 200, '  (the same key freezes: no consent, §39.3)')
      const nb = await bindNext(await nextOf(A), text)
      const pend = noticesTo(A.email, 'resolve-pending'), done = noticesTo(A.email, 'resolve')
      const r = await resolve(nb, t.e.verifier)
      ok(r.status === 202 && r.j.resolving === true && r.j.activeAt === now + 72 * HOUR, `young: the code just enrolled resolves a KEY-HOLDER freeze → 202, waits 72 h (${r.status} ${reason(r)})`)
      await stuck(A, text, '  …the old binding not moved, still frozen')
      ok((await lookup(A.email)).j.pending === await hashOf(nb.text), '  …and the lookup names the waiting binding')
      ok(!!(await rcOf(A)) && await nCreds(A) === 1, '  …the code not spent, the passkey not dropped')
      ok(noticesTo(A.email, 'resolve-pending') === pend + 1 && noticesTo(A.email, 'resolve') === done, '  …and the notice is the waiting one')
      ok(reason(await resolve(nb, own.e.verifier)) === 'resolving', '  …one resolution at a time')
      await voided(A, A, text, 'young')
      // the code is 73 h old now, but this freeze has had a resolution voided
      const again = await resolve(nb, t.e.verifier)
      ok(again.status === 202, `young: after a void the same code, aged, still waits: the freeze is contested (${again.status} ${reason(again)})`)
    }
    {
      // nobody voids it: it lands at 72 h, as an email-only freeze's does
      const A = await person('young-settle@example.com'); const text = await bind(A)
      const d = await device(A)
      const c = await addCred(A, d)
      const t = await enrol(A, d, enrolment(), { passkey: c.reg, young: true })
      await freezeBy(A, A)
      const nb = await bindNext(await nextOf(A), text)
      ok((await resolve(nb, t.e.verifier)).status === 202, '  (a young code waits)')
      now += 72 * HOUR - MIN
      await stuck(A, text, 'young: one minute before 72 h, still the frozen binding')
      now += MIN
      const l = await lookup(A.email)
      ok(l.j.binding === nb.text && l.j.rebound === true, 'young: uncontested for 72 h, the new binding, rebound')
      ok(!(await rcOf(A)) && await nCreds(A) === 0, '  …the code spent at the commit, the frozen key\'s passkey gone')
    }
    for (const [edge, want] of [[72 * HOUR - 1, 202], [72 * HOUR, 200]] as const) {
      // to the millisecond, from the record's own `at` to the freeze's
      const A = await person(`young-edge-${want}@example.com`); const text = await bind(A)
      const d = await device(A)
      const c = await addCred(A, d)
      const t = await enrol(A, d, enrolment(), { passkey: c.reg, young: true })
      const at = (await rcAt(A)) ?? now
      ok(at === now, '  (the record carries the time it was enrolled)')
      now = at + edge
      await freezeBy(A, A)
      ok((await addrStore(A)).get('frz')?.at === at + edge, '  (the freeze lands at that moment)')
      const nb = await bindNext(await nextOf(A), text)
      const r = await resolve(nb, t.e.verifier)
      ok(r.status === want && (await lookup(A.email)).j.binding === (want === 200 ? nb.text : text), `young: a code enrolled ${want === 200 ? 'exactly 72 h before the freeze resolves at once' : '72 h minus 1 ms before the freeze waits'} (${r.status} ${reason(r)})`)
    }
    // the code ages only while the owner could answer: a frozen address with no `rsv` is
    // status-only, so sitting out the freeze must buy nothing
    for (const [how, wait] of [['72 h', 72 * HOUR], ['30 days', 30 * DAY]] as const) {
      const A = await person(`young-sit-${wait}@example.com`); const text = await bind(A)
      const d = await device(A)
      const c = await addCred(A, d)
      await enrol(A, d, enrolment(), { passkey: c.reg })
      const t = await enrol(A, d, enrolment(), { passkey: c.reg, young: true })
      await freezeBy(A, A)
      now += wait
      const r = await resolve(await bindNext(await nextOf(A), text), t.e.verifier)
      ok(r.status === 202 && r.j.resolving === true, `young: replace the code, freeze, sit out ${how}: the same code still waits (${r.status} ${reason(r)})`)
      await stuck(A, text, '  …the old binding not moved')
      await voided(A, A, text, `young/sit ${how}`)
    }
    {
      // the thief's own rotation and self-contest: the same sit-out by another freeze
      const A = await person('young-sit-rot@example.com'); const text = await bind(A)
      const d = await device(A)
      const c = await addCred(A, d)
      const t = await enrol(A, d, enrolment(), { passkey: c.reg, young: true })
      const p = await rotate(A, await nextOf(A), { passkey: c.reg })
      ok((await contest(A, A, p.text)).status === 200, '  (the key contests its own rotation: frozen)')
      now += 72 * HOUR
      const r = await resolve(await bindNext(await nextOf(A), text), t.e.verifier)
      ok(r.status === 202 && (await lookup(A.email)).j.binding === text, `young: rotate, self-contest, sit out 72 h: the code still waits (${r.status} ${reason(r)})`)
      await voided(A, A, text, 'young/self-contest')
    }
    {
      // CONTROL: 72 h with the address NOT frozen is the owner's time to answer
      const A = await person('young-idle@example.com'); const text = await bind(A)
      const d = await device(A)
      const c = await addCred(A, d)
      const t = await enrol(A, d, enrolment(), { passkey: c.reg, young: true })
      now += 72 * HOUR
      await freezeBy(A, A)
      const nb = await bindNext(await nextOf(A), text)
      const r = await resolve(nb, t.e.verifier)
      ok(r.status === 200 && (await lookup(A.email)).j.binding === nb.text, `young: CONTROL 72 h unfrozen, then the freeze: at once (${r.status} ${reason(r)})`)
    }
    {
      // a missing age waits: the Address object's own op with none, and a record with no `at`
      const A = await person('young-noage@example.com'); const text = await bind(A)
      await freezeBy(A, A)
      const nb = await bindNext(await nextOf(A), text)
      const r = await env.ADDRESS.get(await addressKey(A.email)).fetch('https://address/op', { method: 'POST', body: JSON.stringify({ op: 'resolve', stmt: nb.text, sig: nb.sig, key: A.k.pub }) })
      ok(r.status === 202, `young: a resolve that carries no age waits (${r.status})`)
      const B = await person('young-noat@example.com'); const bText = await bind(B)
      const d = await device(B)
      const c = await addCred(B, d)
      const t = await enrol(B, d, enrolment(), { passkey: c.reg })
      ;(await acctStore(B)).set('rc', { ...(await rcOf(B)), at: undefined })
      await freezeBy(B, B)
      const q = await resolve(await bindNext(await nextOf(B), bText), t.e.verifier)
      ok(q.status === 202, `young: a record with no \`at\` waits (${q.status} ${reason(q)})`)
    }
    {
      // the age is the enrolment's: a pepper upgrade moves the record and keeps `at`
      for (const [how, young, want] of [['an aged', false, 200], ['a young', true, 202]] as const) {
        const A = await person(`young-pepper-${want}@example.com`); const text = await bind(A)
        const d = await device(A)
        const c = await addCred(A, d)
        const t = await enrol(A, d, enrolment(), { passkey: c.reg, young })
        env.PEPPER_V2 = r64(32)
        const at = await rcAt(A)
        ok((await start(A, t.e.verifier)).status === 200 && (await rcOf(A))!.v === 2 && (await rcAt(A)) === at, `young: a pepper upgrade of ${how} code keeps its \`at\``)
        await freezeBy(A, A)
        const r = await resolve(await bindNext(await nextOf(A), text), t.e.verifier)
        ok(r.status === want, `  …and it then resolves ${want === 200 ? 'at once' : 'by waiting'} (${r.status} ${reason(r)})`)
        delete env.PEPPER_V2
      }
    }
    {
      // rotated, a dead old-key code in the slot: anyone can empty it, and that is fine
      const { A, A2, d2, graceEnd } = await rotated('young-orphan@example.com', { code: true })
      now = graceEnd
      await lookup(A.email)
      ok((await rcOf(A))?.accountPub === A.k.pub, '  (the old key\'s code is still in the slot)')
      ok(reason((await enrol(A2, d2, enrolment(), { ...free, young: true })).r) === 'consent:consent', 'young: the key alone can\'t fill it')
      await start(A, r64(32))
      ok(!(await rcOf(A)), '  (an anonymous attempt deletes the orphan)')
      ok(reason((await enrol(A2, d2, enrolment(), { ...free, young: true })).r) === 'consent:consent', '  …and the key alone still can\'t')
      await renew(A2)
      const t = await enrol(A2, d2, enrolment(), { ...free, young: true })
      ok(t.r.status === 200, '  (key + mailbox fill it: the accepted residual)')
      const text = await current(A2)
      await freezeBy(A2, A2)
      const r = await resolve(await bindNext(await nextOf(A2), text), t.e.verifier)
      ok(r.status === 202, `young: anonymous start, the fill, then a freeze: the move still waits its 72 h (${r.status} ${reason(r)})`)
      await stuck(A, text, '  …the old binding not moved')
      await voided(A, A2, text, 'young/orphan')
    }
    {
      // the orphan is not the cause: a slot that was never filled runs the same chain
      const { A, A2, d2, graceEnd } = await rotated('young-empty@example.com')
      now = graceEnd
      await lookup(A.email)
      await renew(A2)
      const t = await enrol(A2, d2, enrolment(), { ...free, young: true })
      const text = await current(A2)
      await freezeBy(A2, A2)
      const r = await resolve(await bindNext(await nextOf(A2), text), t.e.verifier)
      ok(t.r.status === 200 && r.status === 202, `young: a rotated account's never-filled slot waits the same (${r.status} ${reason(r)})`)
      await stuck(A, text, '  …the old binding not moved')
    }
    {
      // and restricting the allowance to passkeys would not help: a passkey consents to a code
      const { A, A2, d2, graceEnd } = await rotated('young-passkey@example.com')
      now = graceEnd
      await lookup(A.email)
      await renew(A2)
      const n = await addCred(A2, d2, free)
      const t = await enrol(A2, d2, enrolment(), { passkey: n.reg, young: true })
      const text = await current(A2)
      await freezeBy(A2, A2)
      const r = await resolve(await bindNext(await nextOf(A2), text), t.e.verifier)
      ok(n.r.status === 200 && t.r.status === 200 && r.status === 202, `young: passkey by the allowance, code by that passkey: it waits too (${r.status} ${reason(r)})`)
      await stuck(A, text, '  …the old binding not moved')
    }
    for (const [how, young, want] of [['long held', false, 200], ['young', true, 202]] as const) {
      // a code and no passkey, past the window: email can't re-arm, so the way out is
      // freeze, resolve, a fresh email proof on the new key, its passkey, then its code
      const S = await person(`way-out-${want}@example.com`); await bind(S, { setup: true })
      const d = await device(S, { consent: false })
      const t = await enrol(S, d, enrolment(), { ...free, young })
      now += 16 * MIN
      await renew(S)
      ok(!(await armed(S)) && reason((await addCred(S, d, free)).r) === 'consent:consent', `way out (${how}): code first, window lapsed: email does not arm`)
      const text = await current(S)
      await freezeBy(S, S)
      const T = await nextOf(S)
      const nb = await bindNext(T, text)
      const r = await resolve(nb, t.e.verifier)
      ok(r.status === want, `way out (${how}): the resolve ${want === 200 ? 'lands at once' : 'waits 72 h'} (${r.status} ${reason(r)})`)
      if (want === 202) { now += 72 * HOUR; await lookup(S.email) }
      ok((await lookup(S.email)).j.binding === nb.text && !(await armed(S)), `way out (${how}): rebound, and a resolution alone arms nothing`)
      await renew(T)
      ok(await armed(S), `way out (${how}): a fresh email proof on the new key arms`)
      const dT = await device(T, { consent: false })
      const n = await addCred(T, dT, free)
      ok(n.r.status === 200 && (await enrol(T, dT, enrolment(), { passkey: n.reg })).r.status === 200, `way out (${how}): the passkey lands, and the code by that passkey`)
    }

    // --- a rekey that fails is recorded and retried ---
    async function expired(email: string) {
      const E = await person(email); await bind(E, { setup: true })
      const d = await device(E, { consent: false })
      const c = await addCred(E, d, free)
      await enrol(E, d, enrolment(), free)
      now += 14 * MONTH
      ok(reason(await fetchBlob(c.reg.key, c.reg.credId)) === 'orphaned', '  (no live binding: orphaned, not stale)')
      const E2 = await nextOf(E)
      const b = await bindNext(E2, null)
      await api('/v1/bind/start', { stmt: b.text, sig: b.sig })
      const code = codeFor(E.email)!
      const r = await api('/v1/bind/complete', { email: E.email, code, sig: await E2.k.sign(buildCmp(await hashOf(b.text), code)) })
      if (r.status !== 200 || r.j.rebound !== true) throw new Error('rebound failed for ' + email)
      return { E, E2, c, d2: await device(E2, { consent: false }) }
    }
    {
      failing('Account', 'rekey', 1)
      const { E, E2, c, d2 } = await expired('rekey-once@example.com')
      ok((await addrStore(E)).has('rekey') && await nCreds(E) === 1 && await armed(E), 'rekey: a failure is recorded, the old passkey still there, the new key armed')
      const scope = await addressKey(E.email)
      ok(alarms.get(`Address:${scope}`) === now + 3_600_000, '  …and the alarm is set to retry')
      const n = await addCred(E2, d2, free)
      ok(n.r.status === 200, `rekey: fails once, then succeeds: the new key's first passkey lands, not stranded (${reason(n.r)})`)
      ok(!(await addrStore(E)).has('rekey') && await credGone(c) && await nCreds(E) === 1 && !(await rcOf(E)), '  …the old passkey and code gone, the new one kept')
    }
    {
      failing('Account', 'rekey', 2)
      const { E, E2, c, d2 } = await expired('rekey-twice@example.com')
      ok(reason((await addCred(E2, d2, free)).r) === 'rekey', 'rekey: still failing: refused as try-again, not as `filled`')
      ok(((await addrStore(E)).get('setup') as { ops: string[] }).ops.length === 2, '  …with nothing of the allowance used up')
      await addressAlarm(await addressKey(E.email))
      ok(!(await addrStore(E)).has('rekey') && await credGone(c), 'rekey: the alarm retries it')
      ok((await addCred(E2, d2, free)).r.status === 200, '  …and the first passkey lands')
    }
    {
      failing('Cred', 'delete', 1)
      const { E, c } = await expired('rekey-cred@example.com')
      ok(await nCreds(E) === 0 && !(await credGone(c)) && ((await addrStore(E)).get('rekey') as { creds: string[] }).creds.length === 1, "rekey: the Account's list went but a Cred did not: the record still owes it")
      await addressAlarm(await addressKey(E.email))
      ok(await credGone(c) && !(await addrStore(E)).has('rekey'), '  …and the retry deletes it')
    }
    {
      // the compare stands alone: rebound's old passkey is refused even with no rekey behind it
      failing('Account', 'rekey', 1)
      const { E, E2, c, d2 } = await expired('rekey-lost@example.com')
      ;(await addrStore(E)).delete('rekey') // the record lost as well: the worst case
      ok(!(await credGone(c)) && await nCreds(E) === 1, '  (the old passkey is still here)')
      ok(reason((await addCred(E2, d2, { passkey: c.reg })).r) === 'consent:webauthn:unknown', "rekey: a rebound's old passkey is refused for the new key even if dropOld failed")
      ok(!(await hasGrace(E)), '  …a rebound has no grace')
    }
    {
      // a grace's end that fails: one notice, when the deletion is really done
      const { A, A2, c, d2 } = await rotated('rekey-grace@example.com')
      failing('Account', 'rekey', 1)
      const n = await addCred(A2, d2, { passkey: c.reg })
      ok(n.r.status === 200 && !(await hasGrace(A)) && (await addrStore(A)).has('rekey') && gone(A) === 0, 'rekey: a grace end that failed: over, recorded, no notice yet')
      ok(reason((await addCred(A2, d2, { passkey: c.reg })).r) === 'consent:webauthn:unknown', '  …the grace does not come back (the retry ran first, and took the passkey)')
      ok(await credGone(c) && gone(A) === 1 && !(await credGone(n)), '  …one notice, and the new passkey kept')
    }
    {
      // a task queued over an unfinished one owes everything the first owed
      const { A, A2, c, d2 } = await rotated('rekey-owed@example.com')
      failing('Cred', 'delete', 1)
      const n = await addCred(A2, await device(A2))
      ok(n.r.status === 200 && (await addrStore(A)).has('rekey') && gone(A) === 0, '  (the grace ended, its Cred not deleted: still owed, no notice yet)')
      await rotate(A2, await nextOf(A2)) // rotate/start is no authorize: nothing retries it
      now += 73 * HOUR
      await lookup(A.email)
      ok(await credGone(c) && !(await addrStore(A)).has('rekey'), 'rekey: a settle over an unfinished rekey finishes it, the owed Cred included')
      ok(gone(A) === 1, '  …and the notice it owed is sent')
      ok(!(await credGone(n)), "  …and the previous key's passkey is not taken by the older task's `keep`")
      void d2
    }
    {
      failing('Account', 'rekey', 1)
      const { E, E2 } = await expired('rekey-rc@example.com')
      ok(!!(await rcOf(E)), "  (the rebound's rekey failed: the old code is still here)")
      await rotate(E2, await nextOf(E2))
      now += 73 * HOUR
      await lookup(E.email)
      ok(!(await rcOf(E)) && await nCreds(E) === 0, "rekey: a task queued over a rebound's still drops the old code")
    }

    // --- the end of `ever`: only after a deletion, at the deleted binding's own expiry ---
    // Inside the window the flag is what stops a key with its old code from arming, so
    // a re-bind cancels the end. A deletion's rows then go; a plain expiry's never do.
    const everRows = async (p: P) => [...(await acctStore(p)).keys()].filter((k) => k.startsWith('ever:')).length
    const appt = async (p: P) => (await addrStore(p)).get('everEnd') as { at: number; scope: string } | undefined
    const tick = async (p: P) => addressAlarm(await addressKey(p.email))
    /** an account with a passkey and a code, deleted by its holder */
    async function deleted(email: string) {
      const S = await person(email); const text = await bind(S, { setup: true })
      const d = await device(S, { consent: false })
      const c = await addCred(S, d, free)
      const e = await enrol(S, d, enrolment(), free)
      const expires = ((await addrStore(S)).get('cur') as { b: { expires: number } }).b.expires
      ok((await del(S)).status === 204 && await everRows(S) === 1, `  (${email} is deleted, its flag still here)`)
      return { S, text, d, c, e, expires }
    }
    /** a different key re-binds over the tomb: pending for 72 h */
    async function overTomb(S: P) {
      now += 2 * MIN
      const X = await nextOf(S), xb = await bindNext(X, null)
      await api('/v1/bind/start', { stmt: xb.text, sig: xb.sig })
      const code = codeFor(S.email)!
      const r = await api('/v1/bind/complete', { email: S.email, code, sig: await X.k.sign(buildCmp(await hashOf(xb.text), code)) })
      ok(r.j.state === 'pending', '  (a new key over the tomb: pending)')
      return { X, xb }
    }
    {
      const { S, expires } = await deleted('ever-end@example.com')
      const scope = await addressKey(S.email)
      ok((await appt(S))?.at === expires && alarms.get(`Address:${scope}`) === expires, 'ever: a deletion sets the end for the deleted binding\'s own expiry, with an alarm')
      now = expires - 1
      await lookup(S.email)
      await tick(S)
      ok(await everRows(S) === 1 && !!(await appt(S)) && !!(await rcOf(S)) && alarms.get(`Address:${scope}`) === expires, 'ever: one ms before the expiry nothing ends, and the alarm keeps its time')
      now = expires
      await tick(S)
      ok(await everRows(S) === 0 && !(await appt(S)) && !(await rcOf(S)), 'ever: at the expiry the alarm ends it, the kept code with it, ahead of the Account alarm')
      await bind(S, { setup: true })
      ok(await armed(S) && (await addCred(S, await device(S, { consent: false }), free)).r.status === 200, 'ever: after it, the key + its mailbox get what a brand-new key gets')
      ok(await everRows(S) === 1, '  …and a credential sets the flag again')
    }
    {
      // CONTROL for the row above: a brand-new key with a mailbox, nothing deleted
      const S = await person('ever-new@example.com'); await bind(S, { setup: true })
      ok(await armed(S), 'ever: CONTROL a brand-new key arms the same way')
    }
    {
      // nobody calls and no alarm has run: the next request ends it, before a bind reads it
      const { S, expires } = await deleted('ever-lazy@example.com')
      now = expires + DAY
      await bind(S, { setup: true })
      ok(await armed(S) && await everRows(S) === 0, 'ever: a bind after the expiry finds it ended, whether or not the alarm ran')
    }
    {
      // inside the window: re-binding cancels, or "credential, delete it, flag gone" is back
      const { S, d, expires } = await deleted('ever-rebind@example.com')
      now += DAY
      await bind(S, { setup: true })
      ok(!(await armed(S)) && !(await appt(S)), 'ever: a same-key re-bind inside the window does not arm, and cancels the end')
      ok(reason((await addCred(S, d, free)).r) === 'consent:consent', '  …and the key + mailbox get no passkey by it')
      now = expires + 1
      await lookup(S.email); await tick(S)
      ok(await everRows(S) === 1, 'ever: past the old expiry the flag stays')
      await renew(S)
      ok(!(await armed(S)) && reason((await addCred(S, d, free)).r) === 'consent:consent', 'ever: row 4 holds: a renewal after it does not arm')
    }
    {
      // a new key still waiting at the expiry holds the end; when it lands, that cancels it
      const { S, expires } = await deleted('ever-pending@example.com')
      now = expires - HOUR
      await overTomb(S)
      const until = ((await addrStore(S)).get('rot') as { until: number }).until
      now = expires
      await tick(S)
      ok(await everRows(S) === 1 && !!(await appt(S)) && alarms.get(`Address:${await addressKey(S.email)}`) === until, 'ever: a re-bind pending at the expiry holds it, and the alarm moves to its end')
      now = until
      await tick(S)
      ok((await lookup(S.email)).status === 200 && !(await appt(S)) && await everRows(S) === 1, 'ever: it lands: cancelled, the flag stays')
    }
    {
      // contested after the expiry: nothing landed, so the end goes ahead
      const { S, text, expires } = await deleted('ever-contest@example.com')
      now = expires - HOUR
      const { xb } = await overTomb(S)
      now = expires + 1
            ok(await everRows(S) === 1, '  (it is held while pending)')
      ok((await contest(S, S, xb.text, { bindText: text, bind: text })).status === 200, '  (the tombstoned key contests it past the expiry)')
      await lookup(S.email)
      ok(await everRows(S) === 0 && !(await appt(S)) && (await lookup(S.email)).status === 410, 'ever: the contested re-bind landed nothing: it ends at the next request')
    }
    {
      // a resolution is a re-bind too
      const { S, text, e, expires } = await deleted('ever-resolve@example.com')
      const { xb } = await overTomb(S)
      await contest(S, S, xb.text, { bindText: text, bind: text })
      const r = await resolve(await bindNext(await nextOf(S), text), e.e.verifier)
      ok(r.status === 200 && !(await appt(S)), 'ever: a resolution of the tomb freeze cancels the end')
      now = expires + 1
      await lookup(S.email)
      ok(await everRows(S) === 1, '  …and the old key\'s flag stays past its expiry')
    }
    {
      // a mailbox deletion: the binding had expired, and the wipe follows the answer
      const S = await person('ever-mailbox@example.com'); await bind(S, { setup: true })
      await addCred(S, await device(S, { consent: false }), free)
      now += 14 * MONTH
      await lookup(S.email); await tick(S)
      ok(await everRows(S) === 1 && !(await appt(S)), 'ever: CONTROL a plain expiry ends nothing, material may remain')
      await api('/v1/delete/start', { email: S.email })
      ok((await api('/v1/delete/complete', { email: S.email, code: codeFor(S.email) })).status === 204, '  (deleted by mailbox)')
      ok((await appt(S))?.at === now + HOUR, 'ever: a mailbox deletion ends it an hour on, past the wipe')
      await lookup(S.email)
      ok(await everRows(S) === 1, '  …not before')
      now += HOUR
      await tick(S)
      ok(await everRows(S) === 0, 'ever: then it ends')
    }
    {
      // every key's row at this address, not one key's
      const { S, expires } = await deleted('ever-all@example.com')
      ;(await acctStore(S)).set('ever:another-key', true)
      now = expires
      await tick(S)
      ok(await everRows(S) === 0, "ever: it ends every key's flag at the address")
    }
    for (const [what, row, val] of [['a passkey', 'creds', ['left-behind']], ['a code with no end of its own', 'rc', { at: 0 }]] as const) {
      // the wipe failed, or a key is back: material here means the flag still has work to do
      const { S, expires } = await deleted(`ever-held-${row}@example.com`)
      ;(await acctStore(S)).set(row, val)
      now = expires
      await tick(S)
      ok(await everRows(S) === 1 && !(await appt(S)), `ever: ${what} still at the Account: the flag stays`)
    }
    {
      // the call fails: the record stays, and the alarm comes back
      const { S, expires } = await deleted('ever-retry@example.com')
      now = expires
      failing('Account', 'everEnd', 1)
      await tick(S)
      ok(await everRows(S) === 1 && !!(await appt(S)) && alarms.get(`Address:${await addressKey(S.email)}`) === now + HOUR, 'ever: a failed call keeps the record, and the alarm is set to retry')
      now += HOUR
      await tick(S)
      ok(await everRows(S) === 0 && !(await appt(S)), '  …and the retry ends it')
    }
    {
      // a rekey's retry owns the alarm: the deletion must not take it, and tick puts it back
      const S = await person('ever-rekey@example.com'); await bind(S)
      const scope = await addressKey(S.email)
      await addCred(S, await device(S))
      ;(await addrStore(S)).set('rekey', { scope, keep: [S.k.pub], creds: [] })
      alarms.set(`Address:${scope}`, now + HOUR)
      const retry = now + HOUR
      await del(S)
      const end = (await appt(S))!.at
      ok(alarms.get(`Address:${scope}`) === retry && end > retry, "ever: a deletion leaves a rekey retry's alarm alone")
      now = retry
      await tick(S)
      ok(alarms.get(`Address:${scope}`) === end, '  …and the tick puts the end back')
    }
  }
}

console.log(`${passes} passed, ${fails} failed`)
process.exit(fails)
