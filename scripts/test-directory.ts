#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/id directory rig (server/directory, id.bento.page).
//
//   node scripts/test-directory.ts        (Node ≥ 23.6 strips types natively)
//
// Drives the REAL worker and its Durable Object classes against an in-memory
// namespace and a hand-moved clock, so the assertions are about the service's
// actual control flow. What it must prove:
//   · a binding needs BOTH proofs — the mailed code AND a signature by the
//     binding's own key over it — so an attacker who starts a binding of THEIR
//     key to a victim's address can't finish it, and neither can the victim;
//   · lookups are exact-address only, signed, and say nothing about addresses
//     that don't exist (404 for never-existed and expired alike);
//   · bind/start answers 202 whatever happens (no existence or limit oracle);
//   · per-address mail limits stop mail-bombing; per-IP limits are enforced;
//   · deletion (holder-signed, or by mailed code) leaves a SIGNED tombstone;
//   · no raw address or IP is ever written to storage;
//   · rotation: old-key vouching + consent + the mailed code → 72 h pending
//     (pins don't move) → active with the old key's signature; refusals for
//     replay, relay, payload swap and expiry (native cns. AND WebAuthn), each
//     beside a working control; the WebAuthn origin, type, flag, sign-count,
//     cross-origin and lockout rows;
//   · freeze: only a POSTed single-use token freezes, a freeze ends a pending
//     rotation, and a frozen binding honours neither key.

import worker, { Address, Cred, Ledger, LIMITS } from '../server/directory/src/worker.js'
import { addressKey, normalize } from '../server/directory/src/address.js'
import {
  b64uDec, b64uEnc, buildBind, buildCmp, buildConsent, buildDel, buildDev, consentTranscript, sha256b64u as hashOf, signStatement,
  verifyAtt, verifyStatementSig, verifyTomb, webauthnChallengeFor,
} from '../kernel/src/statements.ts'
import { readFileSync } from 'node:fs'

let fails = 0, passes = 0
const ok = (c: unknown, n: string) => { if (c) passes++; else { fails++; console.log('FAIL ' + n) } }

// ---------- clock ----------
let now = Date.parse('2026-10-18T09:00:00Z')
Date.now = () => now
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, MONTH = 30.44 * DAY

// ---------- in-memory Durable Object namespaces ----------
const stores: Map<string, Map<string, unknown>>[] = []
function namespace(Klass: new (state: unknown, env: unknown) => { fetch(r: Request): Promise<Response> }) {
  const objs = new Map<string, { fetch(r: Request): Promise<Response> }>()
  const ns = {
    idFromName: (n: string) => n,
    get(id: string) {
      if (!objs.has(id)) {
        const store = new Map<string, unknown>()
        stores.push(new Map([[id, store]]))
        const state = {
          storage: {
            async get(k: string) { return structuredClone(store.get(k)) },
            async put(k: string, v: unknown) { store.set(k, structuredClone(v)) },
            async delete(k: string | string[]) { for (const x of [].concat(k as never)) store.delete(x) },
            async list() { return new Map(store) },
            async setAlarm() { /* not under test */ },
          },
        }
        objs.set(id, new Klass(state, env))
      }
      const obj = objs.get(id)!
      // a real DO stub turns fetch(url, init) into a Request; so does this one
      return { fetch: (u: string | Request, init?: RequestInit) => obj.fetch(u instanceof Request ? u : new Request(u, init)) }
    },
  }
  return ns
}

// ---------- keys ----------
const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIG = { name: 'ECDSA', hash: 'SHA-256' } as const
async function signer() {
  const kp = (await crypto.subtle.generateKey(EC, true, ['sign', 'verify'])) as CryptoKeyPair
  const pub = b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)))
  return { pub, sign: (t: string) => signStatement(kp.privateKey, t), kp }
}
async function kxPub() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  return b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)))
}
// the old field names, onto the kernel's builders
const bindText = (b: { email: string; key: string; kx?: string | null; name?: string; seq: number; prev?: string; created: number; expires: number }) =>
  buildBind({ address: b.email, accountPub: b.key, kx: b.kx ?? null, name: b.name ?? null, seq: b.seq, prev: b.prev ?? null, created: b.created, expires: b.expires })
const completionText = buildCmp
const deleteText = buildDel
const dir = await signer()
const dirJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', dir.kp.privateKey))
// the directory's answers, checked with the kernel's CLIENT verifiers, exactly as an agent will
const DIR_KEYS = { 'dir-1': dir.pub }
const verifyDirAtt = async (text: string, sig: string, bindText: string) =>
  (await verifyAtt(text, sig, { directoryKeys: DIR_KEYS, bindText, now, maxAgeMs: 10 * MIN })).ok
const verifyDirTomb = async (text: string, sig: string) => (await verifyTomb(text, sig, { directoryKeys: DIR_KEYS, now })).ok

// ---------- env + mail capture ----------
const mailbox: { to: string; body: string; code: string }[] = []
const env: Record<string, unknown> = {
  DIR_KID: 'dir-1', DIR_KEY_JWK: dirJwk, DIR_PUBKEYS: JSON.stringify([{ kid: 'dir-1', pub: dir.pub }]),
  MAILER: { send: (m: { to: string; body: string; code: string }) => { mailbox.push(m) } },
}
env.ADDRESS = namespace(Address as never)
env.LEDGER = namespace(Ledger as never)
env.CRED = namespace(Cred as never)
env.CHALLENGE_KEY = 'rig-challenge-secret-0123456789abcdef'
env.ROTATION = '1'
const codeFor = (to: string) => [...mailbox].reverse().find((m) => m.to === to)?.code

let ipN = 0
const freshIp = () => `10.0.${Math.floor(++ipN / 250)}.${ipN % 250}`
let IP = freshIp()
async function api(method: string, path: string, body?: unknown, ip = IP) {
  const r = await worker.fetch(new Request('https://id.bento.page' + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
  }), env as never)
  let j: Record<string, unknown> = {}
  try { j = await r.json() } catch { /* empty */ }
  return { status: r.status, j, h: r.headers }
}

async function person(email: string, name?: string) {
  const k = await signer()
  return { email, k, kx: null as string | null, name } // the kx slot stays EMPTY until §6b is ruled
}
async function stmtFor(p: Awaited<ReturnType<typeof person>>, seq = 1, prev?: string, life = 13 * MONTH) {
  const text = bindText({ email: p.email, key: p.k.pub, kx: p.kx, name: p.name, seq, prev, created: now, expires: Math.floor(now + life) })
  return { text, sig: await p.k.sign(text) }
}
async function bind(p: Awaited<ReturnType<typeof person>>, seq = 1, prev?: string) {
  return bindFor(p, seq, prev)
}
async function bindFor(p: Awaited<ReturnType<typeof person>>, seq = 1, prev?: string, life?: number) {
  const s = await stmtFor(p, seq, prev, life)
  const st = await api('POST', '/v1/bind/start', { stmt: s.text, sig: s.sig })
  const code = codeFor(p.email)!
  const c = await api('POST', '/v1/bind/complete', { email: p.email, code, sig: await p.k.sign(completionText(await hashOf(s.text), code)) })
  return { st, c, s }
}

// =====================================================================
// address normalisation (provisional; kernel owns the reference + vectors)
// =====================================================================
const N: [string, string | null][] = [
  ['Alice@Example.COM', 'alice@example.com'], ['a.b+tag@gmail.com', 'a.b+tag@gmail.com'],
  ['  bob@x.org  ', 'bob@x.org'], ['x@xn--bcher-kva.example', 'x@xn--bcher-kva.example'],
  ['ü@x.de', null], ['a@bü.de', null], ['"q"@x.com', null], ['a(c)@x.com', null], ['a@[1.2.3.4]', null],
  ['a@1.2.3.4', null], ['a..b@x.com', null], ['.a@x.com', null], ['a@x', null], ['a@-x.com', null],
  ['a@x-.com', null], ['a b@x.com', null], ['a@b@x.com', null], ['x'.repeat(65) + '@x.com', null],
  ['a@' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(63) + '.' + 'e'.repeat(60) + '.com', null],
]
// the storage name is a domain-separated hash, pinned (a change orphans every stored address)
ok(await addressKey('alice@example.com') === '123c19c9631499522f93afd25daf131a98d5e7483bdba996c9db3fc973468494', 'addressKey: known answer for sha256("bento-dir/1/addr\\n" + address)')
for (const [i, want] of N) ok(normalize(i) === want, `normalize(${JSON.stringify(i).slice(0, 40)}) → ${want}`)

// =====================================================================
// the happy path
// =====================================================================
const alice = await person('alice@example.com', 'Alice')
{
  const { st, c, s } = await bind(alice)
  ok(st.status === 202, 'bind/start → 202')
  ok(mailbox.length === 1 && mailbox[0].to === 'alice@example.com', 'one code mailed to the address')
  ok(!mailbox[0].body.includes('Alice'), 'the mail carries no user-supplied text (not the display name)')
  ok(c.status === 200 && c.j.binding === s.text, `bind/complete → 200 with the exact statement (${c.status})`)
  const att = String(c.j.attestation)
  ok(await verifyDirAtt(att, String(c.j.attestationSig), s.text), 'attestation passes the kernel client verifier (verifyAtt)')
  ok(att === `att.${await hashOf(s.text)}.${now}.${now}.dir-1.active`, `attestation names this exact text, state active (${att.slice(0, 30)}…)`)
}
{
  now += HOUR
  const r = await api('GET', '/v1/lookup?e=ALICE@example.com')
  ok(r.status === 200, 'lookup by exact address (case-insensitive) → 200')
  const f = String(r.j.attestation).split('.')
  ok(f[3] === String(now) && Number(f[2]) === now - HOUR, 'lookup re-issues the attestation: fresh issuedAt, original verifiedAt')
  ok(await verifyDirAtt(String(r.j.attestation), String(r.j.attestationSig), String(r.j.binding)), 'lookup attestation passes verifyAtt')
  ok(r.h.get('access-control-allow-origin') === '*' && r.h.get('x-robots-tag')?.includes('noindex') && !r.h.get('set-cookie'), 'headers: CORS *, noindex, no cookie')
  ok((await api('GET', '/v1/lookup?e=nobody@example.com')).status === 404, 'unknown address → 404')
  ok((await api('GET', '/v1/lookup?e=alice@')).status === 400, 'malformed address → 400')
  ok((await api('GET', '/v1/lookup?e=alice%40example.co')).status === 404, 'no prefix or fuzzy match')
}

// =====================================================================
// TWO PROOFS: the attack a link would allow
// =====================================================================
{
  const victim = await person('victim@example.com')
  const attacker = await person('victim@example.com') // the attacker's key, the victim's address
  const s = await stmtFor(attacker)
  ok((await api('POST', '/v1/bind/start', { stmt: s.text, sig: s.sig })).status === 202, 'attacker can START a binding of their key to the victim')
  const code = codeFor('victim@example.com')!
  const h = await hashOf(s.text)
  // the victim has the code but not the attacker's key: signing with their own key fails
  ok((await api('POST', '/v1/bind/complete', { email: victim.email, code, sig: await victim.k.sign(completionText(h, code)) })).status === 400, 'victim (code, wrong key) cannot complete it')
  // the attacker has the key but not the code
  ok((await api('POST', '/v1/bind/complete', { email: attacker.email, code: 'ABCDEFGH', sig: await attacker.k.sign(completionText(h, 'ABCDEFGH')) })).status === 400, 'attacker (key, no code) cannot complete it')
  ok((await api('GET', '/v1/lookup?e=victim@example.com')).status === 404, 'nothing was published')
}

// =====================================================================
// refusals at start
// =====================================================================
{
  const p = await person('carol@example.com')
  const sameKx = bindText({ email: p.email, key: p.k.pub, kx: p.k.pub, seq: 1, created: now, expires: now + MONTH })
  ok((await api('POST', '/v1/bind/start', { stmt: sameKx, sig: await p.k.sign(sameKx) })).status === 400, 'kx == signing key → refused')
  const kxFilled = bindText({ email: p.email, key: p.k.pub, kx: await kxPub(), seq: 1, created: now, expires: now + MONTH })
  ok((await api('POST', '/v1/bind/start', { stmt: kxFilled, sig: await p.k.sign(kxFilled) })).status === 400, 'a filled kx slot → refused while the placement is unruled (§6b)')
  const g0 = await stmtFor(p)
  const raw = new Uint8Array(await crypto.subtle.sign(SIG, p.k.kp.privateKey, new TextEncoder().encode(g0.text)))
  const N_ = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
  const sv = raw.subarray(32).reduce((x, v) => (x << 8n) | BigInt(v), 0n)
  const hi = sv > N_ >> 1n ? sv : N_ - sv // force the high-S twin of the same signature
  const hiSig = new Uint8Array(64); hiSig.set(raw.subarray(0, 32))
  for (let i = 31, x = hi; i >= 0; i--, x >>= 8n) hiSig[32 + i] = Number(x & 0xffn)
  ok((await api('POST', '/v1/bind/start', { stmt: g0.text, sig: b64uEnc(hiSig) })).status === 400, 'a high-S signature (the malleable twin) → refused')
  const long = await stmtFor(p, 1, undefined, 14 * MONTH)
  ok((await api('POST', '/v1/bind/start', { stmt: long.text, sig: long.sig })).status === 400, 'lifetime over 13 months → refused')
  const good = await stmtFor(p)
  ok((await api('POST', '/v1/bind/start', { stmt: good.text, sig: (await (await signer()).sign(good.text)) })).status === 400, 'statement signed by another key → refused')
  const upper = bindText({ email: 'Carol@Example.com', key: p.k.pub, kx: p.kx, seq: 1, created: now, expires: now + MONTH })
  ok((await api('POST', '/v1/bind/start', { stmt: upper, sig: await p.k.sign(upper) })).status === 400, 'a statement must carry the NORMALISED address')
  ok(!mailbox.some((m) => m.to.startsWith('carol')), 'no mail for any refused statement')
}

// =====================================================================
// codes: attempts, expiry
// =====================================================================
{
  const p = await person('dave@example.com')
  const s = await stmtFor(p)
  await api('POST', '/v1/bind/start', { stmt: s.text, sig: s.sig })
  const code = codeFor(p.email)!
  const h = await hashOf(s.text)
  for (let i = 0; i < LIMITS.codeAttempts; i++) await api('POST', '/v1/bind/complete', { email: p.email, code: 'ZZZZZZZZ', sig: await p.k.sign(completionText(h, 'ZZZZZZZZ')) })
  ok((await api('POST', '/v1/bind/complete', { email: p.email, code, sig: await p.k.sign(completionText(h, code)) })).status === 400, `after ${LIMITS.codeAttempts} wrong tries the right code is dead too`)
  now += 2 * MIN
  await api('POST', '/v1/bind/start', { stmt: s.text, sig: s.sig })
  const code2 = codeFor(p.email)!
  now += LIMITS.codeTtlMs + 1
  ok((await api('POST', '/v1/bind/complete', { email: p.email, code: code2, sig: await p.k.sign(completionText(h, code2)) })).status === 400, 'an expired code fails')
}

// =====================================================================
// per-address mail limits (mail-bombing) — and start still says 202
// =====================================================================
{
  const p = await person('erin@example.com')
  const s = await stmtFor(p)
  const before = mailbox.length
  for (let i = 0; i < 6; i++) {
    const r = await api('POST', '/v1/bind/start', { stmt: s.text, sig: s.sig }, freshIp())
    ok(r.status === 202, `start #${i + 1} → 202 regardless`)
    now += 10 * 1000 // inside the cooldown for the first few
  }
  ok(mailbox.length - before === 1, `cooldown: only ONE mail inside a minute (${mailbox.length - before})`)
  for (let i = 0; i < 5; i++) { now += 2 * MIN; await api('POST', '/v1/bind/start', { stmt: s.text, sig: s.sig }, freshIp()) }
  ok(mailbox.length - before === LIMITS.mailPerDay, `at most ${LIMITS.mailPerDay} mails a day to one address (${mailbox.length - before})`)
  now += DAY + MIN
  await api('POST', '/v1/bind/start', { stmt: s.text, sig: s.sig }, freshIp())
  ok(mailbox.length - before === LIMITS.mailPerDay + 1, 'the next day the address can be mailed again')
}

// =====================================================================
// sequence: renewal, rebound, replay
// =====================================================================
{
  now += 2 * MIN
  const first = await api('GET', '/v1/lookup?e=alice@example.com')
  const h1 = await hashOf(String(first.j.binding))
  // a stale seq-1 statement can't overwrite the live binding
  const replay = await stmtFor(alice)
  await api('POST', '/v1/bind/start', { stmt: replay.text, sig: replay.sig }); now += 2 * MIN
  const rc = codeFor(alice.email)!
  ok((await api('POST', '/v1/bind/complete', { email: alice.email, code: rc, sig: await alice.k.sign(completionText(await hashOf(replay.text), rc)) })).status === 400, 'seq 1 while a binding is live → refused')
  // renewal: same key, seq 2, prev = hash of the live text
  now += 2 * MIN
  const ren = await bind(alice, 2, h1)
  ok(ren.c.status === 200 && ren.c.j.rebound === false, 'renewal (same key, seq+1, prev) → accepted, not rebound')
  // a NEW key over the LIVE binding, proven by email alone: refused (security §25:
  // a live binding moves only through the 72-hour contestable rotation)
  now += 2 * MIN
  const alice2 = await person('alice@example.com')
  const rbs = await stmtFor(alice2, 3, await hashOf(ren.s.text))
  const m0 = mailbox.length
  ok((await api('POST', '/v1/bind/start', { stmt: rbs.text, sig: rbs.sig })).status === 202 && mailbox.length === m0, 'a new key over a LIVE binding: start → 202 and NO mail')
  ok((await api('POST', '/v1/bind/complete', { email: alice.email, code: 'ABCDEFGH', sig: await alice2.k.sign(completionText(await hashOf(rbs.text), 'ABCDEFGH')) })).status === 400, '…and nothing to complete')
  const still = await api('GET', '/v1/lookup?e=alice@example.com')
  ok(still.status === 200 && String(still.j.binding) === ren.s.text && still.j.rebound === false, 'the live binding keeps its key, not rebound')

  // control: a new key over an EXPIRED binding, by email → accepted, flagged rebound
  const ivan = await person('ivan@example.com')
  const iv1 = await bindFor(ivan, 1, undefined, 10 * MIN)
  ok(iv1.c.status === 200, 'a short-lived binding')
  now += 11 * MIN
  const ivan2 = await person('ivan@example.com')
  const iv2 = await bindFor(ivan2, 2, await hashOf(iv1.s.text))
  ok(iv2.c.status === 200 && iv2.c.j.rebound === true, 'a new key over an EXPIRED binding, by email → accepted and flagged rebound (pinners warn)')
  const il = await api('GET', '/v1/lookup?e=ivan@example.com')
  ok(il.j.rebound === true && (il.j.chain as string[]).length === 1, 'lookup carries rebound and the chain of earlier hashes')
}

// =====================================================================
// deletion → signed tombstones
// =====================================================================
{
  now += HOUR
  const p = await person('fran@example.com'); await bind(p)
  ok((await api('POST', '/v1/delete', { email: p.email, ts: now - 10 * MIN, sig: await p.k.sign(deleteText(p.email, now - 10 * MIN)) })).status === 400, 'a stale delete (10 min old) → refused')
  ok((await api('POST', '/v1/delete', { email: p.email, ts: now, sig: await (await signer()).sign(deleteText(p.email, now)) })).status === 400, 'a delete by another key → refused')
  ok((await api('POST', '/v1/delete', { email: p.email, ts: now, sig: await p.k.sign(deleteText(p.email, now)) })).status === 204, 'holder-signed delete → 204')
  const l = await api('GET', '/v1/lookup?e=fran@example.com')
  const t = (l.j.tombstone ?? {}) as { text: string; sig: string }
  ok(l.status === 410 && t.text?.startsWith('tomb.') && t.text.split('.')[4] === 'holder', 'lookup → 410 with a holder tombstone')
  ok(await verifyDirTomb(t.text, t.sig), 'the tombstone passes the kernel client verifier (verifyTomb)')

  now += 2 * MIN
  const g = await person('gina@example.com'); await bind(g)
  now += 2 * MIN
  const m1 = mailbox.length
  ok((await api('POST', '/v1/delete/start', { email: g.email })).status === 202 && mailbox.length === m1, 'a LIVE binding: delete by mailbox → 202 and NO mail (email never decides alone)')
  ok((await api('POST', '/v1/delete/complete', { email: g.email, code: 'ABCDEFGH' })).status === 400, '…and no code completes it')
  ok((await api('GET', '/v1/lookup?e=gina@example.com')).status === 200, 'the live binding is untouched')

  // control: an EXPIRED binding (still held) can be removed by mailbox
  const jo = await person('jo@example.com')
  const jo1 = await bindFor(jo, 1, undefined, 10 * MIN)
  now += 11 * MIN
  ok((await api('POST', '/v1/delete/start', { email: jo.email })).status === 202, 'an EXPIRED binding: delete by mailbox, start → 202')
  const code = codeFor(jo.email)!
  ok(!!code && mailbox[mailbox.length - 1].to === jo.email && /remove this address/.test(mailbox[mailbox.length - 1].body), 'the removal mail is sent, and says what it is for')
  ok((await api('POST', '/v1/delete/complete', { email: jo.email, code })).status === 204, 'delete by mailbox: the code → 204')
  ok(String(((await api('GET', '/v1/lookup?e=jo@example.com')).j.tombstone as { text: string }).text).split('.')[4] === 'mailbox', 'tombstone says by mailbox')
  ok(jo1.c.status === 200, 'the expired control had been bound')
  // a tombstoned address binds again by email (a fresh seq 1)
  now += 2 * MIN
  const jo2 = await person('jo@example.com')
  ok((await bind(jo2)).c.status === 200, 'a TOMBSTONED address binds again by email (seq 1)')
  // the complete-time re-checks guard a race the API can't produce today (one
  // pending slot per address), so drive it in storage: the binding goes LIVE
  // between the mail and the code
  const storeOf = async (email: string) => { const k = await addressKey(email); return stores.find((m) => m.has(k))!.get(k)! }
  const goLive = async (email: string) => {
    const st = await storeOf(email); const cur = st.get('cur') as { b: { expires: number } }
    cur.b.expires = now + DAY; st.set('cur', cur)
  }
  const kim = await person('kim@example.com')
  const k1 = await bindFor(kim, 1, undefined, 10 * MIN)
  now += 11 * MIN
  const kim2 = await person('kim@example.com')
  const ks = await stmtFor(kim2, 2, await hashOf(k1.s.text)) // chained correctly: only the key check stands in the way
  await api('POST', '/v1/bind/start', { stmt: ks.text, sig: ks.sig })
  const kc = codeFor(kim.email)!
  await goLive(kim.email)
  ok((await api('POST', '/v1/bind/complete', { email: kim.email, code: kc, sig: await kim2.k.sign(completionText(await hashOf(ks.text), kc)) })).status === 400, 'race: the binding went live after the mail → the email-only new key is refused at complete')
  ok(((await storeOf(kim.email)).get('cur') as { b: { key: string } }).b.key === kim.k.pub, '…and the live key is unchanged')
  const lee = await person('lee@example.com')
  await bindFor(lee, 1, undefined, 10 * MIN)
  now += 11 * MIN
  await api('POST', '/v1/delete/start', { email: lee.email })
  const lc = codeFor(lee.email)!
  await goLive(lee.email)
  ok((await api('POST', '/v1/delete/complete', { email: lee.email, code: lc })).status === 400 && (await storeOf(lee.email)).has('cur'), 'race: renewed after the removal mail → the mailed code no longer deletes it')

  const before = mailbox.length
  ok((await api('POST', '/v1/delete/start', { email: 'never@example.com' })).status === 202 && mailbox.length === before, 'delete/start for an unbound address: 202 and NO mail')
}

// =====================================================================
// expiry
// =====================================================================
{
  const p = await person('hal@example.com'); await bind(p)
  now += 13 * MONTH + DAY
  ok((await api('GET', '/v1/lookup?e=hal@example.com')).status === 404, 'an expired binding answers 404, exactly like never-existed')
  // its statement is still held, so the holder can still remove it (re-read as of
  // when it was accepted: integrity, not freshness)
  ok((await api('POST', '/v1/delete', { email: p.email, ts: now, sig: await p.k.sign(deleteText(p.email, now)) })).status === 204, 'the holder can still delete an EXPIRED binding')
  ok((await api('GET', '/v1/lookup?e=hal@example.com')).status === 410, '…and it then answers 410 with a tombstone')
}

// =====================================================================
// per-IP limits
// =====================================================================
{
  const ip = freshIp()
  let last = 0
  for (let i = 0; i <= LIMITS.ip.lookup; i++) last = (await api('GET', '/v1/lookup?e=x@example.com', undefined, ip)).status
  ok(last === 429, `lookup #${LIMITS.ip.lookup + 1} from one IP in an hour → 429`)
}

{
  // bind/start past the per-IP limit: still 202 (the limit is not an oracle), but no mail
  const ip = freshIp()
  const before = mailbox.length
  let statuses = new Set<number>()
  for (let i = 0; i <= LIMITS.ip.start; i++) {
    const p = await person(`ip${i}@example.net`)
    const s = await stmtFor(p)
    statuses.add((await api('POST', '/v1/bind/start', { stmt: s.text, sig: s.sig }, ip)).status)
  }
  ok(statuses.size === 1 && statuses.has(202), `bind/start answers 202 even past the per-IP limit (${[...statuses]})`)
  ok(mailbox.length - before === LIMITS.ip.start, `but only ${LIMITS.ip.start} mails went out from one IP (${mailbox.length - before})`)
}

// =====================================================================
// D1b: consent challenges (audience `dir`), rotation, freeze (security §24, §25, §27)
// =====================================================================
{
  mailbox.length = 0
  const sha = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b))
  const enc = (t: string) => new TextEncoder().encode(t)
  const challengeFor = async (email: string) => String((await api('POST', '/v1/challenge', { email }, freshIp())).j.challenge)

  // --- challenges ---
  const alice = await person('rot-alice@example.com', 'Alice')
  await bind(alice)
  const c1 = await api('POST', '/v1/challenge', { email: alice.email }, freshIp())
  ok(c1.status === 200 && typeof c1.j.challenge === 'string' && b64uDec(String(c1.j.challenge))!.length === 40 && c1.j.audience === 'dir', 'a dir challenge is issued: 40 sealed bytes, audience dir')
  ok((await api('POST', '/v1/challenge', { email: 'not an address' }, freshIp())).status === 400, 'no challenge for a malformed address')

  // a native host's consent: a dev. cert from the CURRENT account key certifying a hardware consent key
  type P = Awaited<ReturnType<typeof person>>
  async function device(owner: P, consent = true) {
    const dev = await signer(), cns = await signer()
    const text = buildDev({ devicePub: dev.pub, consentPub: consent ? cns.pub : null, accountPub: owner.k.pub, kx: null, label: null, created: now, expires: now + 30 * DAY })
    return { dev: text, devSig: await owner.k.sign(text), cnsKey: cns }
  }
  async function nativeConsent(d: Awaited<ReturnType<typeof device>>, challenge: string, payload: string, o: { audience?: string; purpose?: string; exp?: number } = {}) {
    const transcript = (await consentTranscript(o.audience ?? 'dir', challenge, payload))!
    const cns = buildConsent({ rp: 'bento', purpose: (o.purpose ?? 'rotate') as never, docId: null, transcript, exp: o.exp ?? now + 2 * MIN })
    return { dev: d.dev, devSig: d.devSig, cns, cnsSig: await d.cnsKey.sign(cns) }
  }
  async function rotation(owner: P, next: P) {
    now += 2 * MIN // past the per-address mail cooldown left by the previous mail
    const cur = await api('GET', '/v1/lookup?e=' + encodeURIComponent(owner.email), undefined, freshIp())
    const was = String(cur.j.binding)
    const seq = Number(was.split('.')[5]) + 1
    const s = await stmtFor(next, seq, await hashOf(was))
    return { stmt: s.text, sig: s.sig, oldSig: await owner.k.sign(s.text), was }
  }
  const rotStart = (body: Record<string, unknown>) => api("POST", "/v1/rotate/start", body, freshIp())
  async function rotComplete(next: P, stmt: string) {
    const code = codeFor(next.email)!
    return api('POST', '/v1/rotate/complete', { email: next.email, code, sig: await next.k.sign(buildCmp(await hashOf(stmt), code)) }, freshIp())
  }
  const look = async (email: string) => api('GET', '/v1/lookup?e=' + encodeURIComponent(email), undefined, freshIp())
  const attState = async (r: Awaited<ReturnType<typeof look>>) => {
    const v = await verifyAtt(String(r.j.attestation), String(r.j.attestationSig), { directoryKeys: DIR_KEYS, bindText: String(r.j.binding), now, maxAgeMs: 10 * MIN })
    return v.ok ? v.value.state : `bad:${v.reason}`
  }

  // --- rotation is OFF unless ROTATION=1 ---
  {
    const d = await device(alice), alice2 = { ...(await person(alice.email, 'Alice')) }
    const r = await rotation(alice, alice2), ch = await challengeFor(alice.email)
    delete env.ROTATION
    ok((await rotStart({ ...r, challenge: ch, consent: await nativeConsent(d, ch, r.stmt) })).status === 404, 'rotation routes answer 404 unless ROTATION=1 (no old-key contest yet)')
    env.ROTATION = '1'
  }

  // --- the happy path: native consent → pending (72 h, pins do not move) → active ---
  const alice2 = await person(alice.email, 'Alice')
  {
    const d = await device(alice)
    const r = await rotation(alice, alice2), ch = await challengeFor(alice.email)
    const st = await rotStart({ ...r, challenge: ch, consent: await nativeConsent(d, ch, r.stmt) })
    ok(st.status === 202, `rotation start with old-key vouching + native cns. → 202 (got ${st.status} ${JSON.stringify(st.j)})`)
    const m = mailbox[mailbox.length - 1]
    ok(m && m.to === alice.email && (m as { kind?: string }).kind === 'rotate' && /^[2-9A-Z]{8}$/.test(m.code), 'the rotation code is mailed to the address')
    ok(m && /#e=[A-Za-z0-9_-]+&t=[A-Za-z0-9_-]{43}$/m.test(m.body) && !m.body.includes('Alice'), 'the mail carries a freeze link (token in the fragment) and no user text')
    const bad = await api('POST', '/v1/rotate/complete', { email: alice.email, code: m.code, sig: await alice.k.sign(buildCmp(await hashOf(r.stmt), m.code)) }, freshIp())
    ok(bad.status === 400, 'rotation complete signed by the OLD key is refused (the new key proves the code)')
    const done = await rotComplete(alice2, r.stmt)
    ok(done.status === 200 && done.j.state === 'pending', 'rotation complete → pending')
    let l = await look(alice.email)
    ok(l.status === 200 && l.j.binding === r.was && l.j.state === 'pending' && (await attState(l)) === 'pending', 'while pending, lookups serve the OLD binding with a signed att.…pending (pins do not move)')
    now += 72 * HOUR - MIN
    l = await look(alice.email)
    ok(l.j.binding === r.was && (await attState(l)) === 'pending', 'one minute before 72 h: still pending')
    now += MIN
    l = await look(alice.email)
    ok(l.j.binding === r.stmt && l.j.state === 'active' && (await attState(l)) === 'active', 'at 72 h uncontested: the new binding is active')
    ok(typeof l.j.rotSig === 'string' && (await verifyStatementSig(alice.k.pub, String(l.j.rotSig), r.stmt)), 'the lookup carries the OLD key\'s signature over the new binding (pinners follow silently)')
    ok((l.j.chain as string[]).includes(await hashOf(r.was)) && l.j.rebound === false, 'the old binding is in the chain; not flagged rebound')
  }

  // --- refusals, each beside a working control above; every one consumes its challenge ---
  {
    const d = await device(alice2)
    const next = await person(alice.email, 'Alice')
    const r = await rotation(alice2, next)
    const reason = (x: Awaited<ReturnType<typeof rotStart>>) => String(x.j.reason)
    let ch = await challengeFor(alice.email)
    // spend-first: a failing attempt consumes the challenge, so the good one after it is a replay
    const first = await rotStart({ ...r, challenge: ch, consent: await nativeConsent(d, ch, r.stmt, { audience: 'room:w' + 'A'.repeat(43) }) })
    ok(first.status === 400 && reason(first) === 'consent:cns:transcript', `RELAY: a cns. made for another audience is refused (${reason(first)})`)
    const again = await rotStart({ ...r, challenge: ch, consent: await nativeConsent(d, ch, r.stmt) })
    ok(again.status === 400 && reason(again) === 'replay', 'REPLAY: the challenge was spent by the failed attempt, so even a good consent is refused')
    ch = await challengeFor(alice.email)
    const other = await stmtFor(next, 3, await hashOf(r.was), 6 * MONTH)
    let x = await rotStart({ ...r, challenge: ch, consent: await nativeConsent(d, ch, other.text) })
    ok(reason(x) === 'consent:cns:transcript', 'PAYLOAD SWAP: a cns. over a different bind. is refused')
    ch = await challengeFor(alice.email)
    x = await rotStart({ ...r, challenge: ch, consent: await nativeConsent(d, ch, r.stmt, { exp: now - 1 }) })
    ok(reason(x) === 'consent:cns:expired', 'EXPIRED: a cns. past its exp is refused')
    ch = await challengeFor(alice.email)
    x = await rotStart({ ...r, challenge: ch, consent: await nativeConsent(d, ch, r.stmt, { purpose: 'link' }) })
    ok(reason(x) === 'consent:cns:payload-family', 'a cns. for another purpose (link) does not authorise a rotation')
    ch = await challengeFor('someone-else@example.com')
    x = await rotStart({ ...r, challenge: ch, consent: await nativeConsent(d, ch, r.stmt) })
    ok(x.status === 400 && reason(x) === 'challenge', 'a challenge issued for another address is refused (scope sealed in)')
    ch = await challengeFor(alice.email)
    const forged = b64uDec(ch)!; forged[30] ^= 1
    x = await rotStart({ ...r, challenge: b64uEnc(forged), consent: await nativeConsent(d, b64uEnc(forged), r.stmt) })
    ok(reason(x) === 'challenge', 'a challenge with a broken seal is refused')
    ch = await challengeFor(alice.email)
    now += 61_000
    x = await rotStart({ ...r, challenge: ch, consent: await nativeConsent(d, ch, r.stmt) })
    ok(reason(x) === 'challenge', 'a challenge older than 60 s is refused')
    const r2 = await rotation(alice2, next) // re-made at the new time
    ch = await challengeFor(alice.email)
    x = await rotStart({ ...r2, oldSig: await next.k.sign(r2.stmt), challenge: ch, consent: await nativeConsent(d, ch, r2.stmt) })
    ok(reason(x) === 'old-key', 'without the OLD key\'s signature over the exact statement: refused')
    ch = await challengeFor(alice.email)
    x = await rotStart({ ...r2, challenge: ch, consent: await nativeConsent(await device(alice), ch, r2.stmt) })
    ok(reason(x) === 'consent:dev:account', 'a consent key certified by a RETIRED account key is refused')
    ch = await challengeFor(alice.email)
    x = await rotStart({ ...r2, challenge: ch, consent: await nativeConsent(await device(alice2, false), ch, r2.stmt) })
    ok(reason(x) === 'consent:dev:no-consent-key', 'a dev. with no consent key (the light tier) cannot sign a cns.')
    ch = await challengeFor(alice.email)
    const same = await stmtFor(alice2, Number(r2.was.split('.')[5]) + 1, await hashOf(r2.was))
    x = await rotStart({ stmt: same.text, sig: same.sig, oldSig: same.sig, challenge: ch, consent: await nativeConsent(d, ch, same.text) })
    ok(reason(x) === 'same-key', 'the same key is a renewal, not a rotation')
    ch = await challengeFor(alice.email)
    const skip = await stmtFor(next, Number(r2.was.split('.')[5]) + 2, await hashOf(r2.was))
    x = await rotStart({ stmt: skip.text, sig: skip.sig, oldSig: await alice2.k.sign(skip.text), challenge: ch, consent: await nativeConsent(d, ch, skip.text) })
    ok(reason(x) === 'sequence', 'a skipped seq is refused')
    // the control for all of the above: the same request, correctly consented, works
    ch = await challengeFor(alice.email)
    x = await rotStart({ ...r2, challenge: ch, consent: await nativeConsent(d, ch, r2.stmt) })
    ok(x.status === 202, 'CONTROL: the same rotation, correctly consented, is accepted')
    ok((await rotComplete(next, r2.stmt)).status === 200, 'CONTROL: and completes to pending')
    const third = await person(alice.email)
    const r3 = await rotation(alice2, third)
    ch = await challengeFor(alice.email)
    x = await rotStart({ ...r3, challenge: ch, consent: await nativeConsent(d, ch, r3.stmt) })
    ok(reason(x) === 'state', 'one rotation at a time: a second one while pending is refused')
    {
      now += 2 * MIN // past the per-address mail cooldown, so "nothing mailed" is the state rule and not the limit
      const n0 = mailbox.length
      const ren = await stmtFor(alice2, Number(r2.was.split('.')[5]) + 1, await hashOf(r2.was))
      ok((await api('POST', '/v1/bind/start', { stmt: ren.text, sig: ren.sig }, freshIp())).status === 202 && mailbox.length === n0, 'while pending, a renewal by the old key answers 202 and mails nothing')
    }

    // --- CONTEST by the emailed freeze link: the pending rotation is discarded ---
    const rm = [...mailbox].reverse().find((m) => m.to === alice.email && (m as { kind?: string }).kind === 'rotate')!
    const token = String((rm as { freezeToken?: string }).freezeToken)
    ok((await api('GET', '/freeze', undefined, freshIp())).status === 200, 'the freeze page is served')
    let l = await look(alice.email)
    ok(l.j.state === 'pending', 'opening the freeze page changes nothing (no action on a GET)')
    ok((await api('POST', '/v1/freeze/complete', { email: alice.email, token: 'A'.repeat(43) }, freshIp())).status === 400, 'a wrong freeze token is refused')
    const fz = await api('POST', '/v1/freeze/complete', { email: alice.email, token }, freshIp())
    ok(fz.status === 200 && fz.j.state === 'frozen', 'the rotation mail\'s freeze link, POSTed, freezes')
    ok((await api('POST', '/v1/freeze/complete', { email: alice.email, token }, freshIp())).status === 400, 'the freeze token is single-use')
    l = await look(alice.email)
    ok(l.j.binding === r2.was && l.j.state === 'frozen' && (await attState(l)) === 'frozen', 'frozen: the last binding is served with a signed att.…frozen')
    now += 73 * HOUR
    l = await look(alice.email)
    ok(l.j.binding === r2.was && (await attState(l)) === 'frozen', 'a contested rotation never becomes active, even after 72 h')
    // neither key is honoured while frozen
    const r4 = await rotation(alice2, third)
    ch = await challengeFor(alice.email)
    x = await rotStart({ ...r4, challenge: ch, consent: await nativeConsent(d, ch, r4.stmt) })
    ok(reason(x) === 'state', 'frozen: no rotation out of it (only the recovery code resolves a freeze)')
    const ts = now
    const del = await api('POST', '/v1/delete', { email: alice.email, ts, sig: await alice2.k.sign(buildDel(alice.email, ts)) }, freshIp())
    ok(del.status === 400, 'frozen: a holder delete is refused (it would reopen the address to an email-only re-bind)')
    const n0 = mailbox.length
    const ren = await stmtFor(alice2, Number(r2.was.split('.')[5]) + 1, await hashOf(r2.was))
    ok((await api('POST', '/v1/bind/start', { stmt: ren.text, sig: ren.sig }, freshIp())).status === 202 && mailbox.length === n0, 'frozen: a renewal by the old key mails nothing')
  }

  // --- the email-only freeze from cold, and expiry clears it ---
  {
    const bob = await person('rot-bob@example.com')
    const n0 = mailbox.length
    ok((await api('POST', '/v1/freeze/start', { email: bob.email }, freshIp())).status === 202 && mailbox.length === n0, 'freeze/start for an unbound address: 202, nothing mailed')
    const { s } = await bindFor(bob, 1, undefined, 2 * MONTH)
    now += 2 * MIN
    ok((await api('POST', '/v1/freeze/start', { email: bob.email }, freshIp())).status === 202, 'freeze/start for a live binding: 202')
    const fm = mailbox[mailbox.length - 1] as { to: string; kind?: string; freezeToken?: string; body: string }
    ok(fm.to === bob.email && fm.kind === 'freeze' && fm.body.includes(fm.freezeToken!), 'the freeze mail carries a single-use link')
    ok((await api('POST', '/v1/freeze/complete', { email: bob.email, token: fm.freezeToken }, freshIp())).j.state === 'frozen', 'POSTing it freezes')
    ok((await attState(await look(bob.email))) === 'frozen', 'the binding is frozen')
    ok((await api('POST', '/v1/freeze/start', { email: bob.email }, freshIp())).status === 202 && mailbox[mailbox.length - 1] === (fm as never), 'an already-frozen binding mails nothing more')
    now += 2 * MONTH + DAY
    ok((await look(bob.email)).status === 404, 'a frozen binding still expires')
    const bob2 = await person(bob.email)
    const re = await bindFor(bob2, 1)
    ok(re.c.status === 200 && (await attState(await look(bob.email))) === 'active' && re.c.j.rebound === true, 'after expiry the address can be bound again by email (flagged rebound), and the freeze is gone')
    void s
  }
  {
    const tokens = mailbox.map((m) => (m as { freezeToken?: string }).freezeToken).filter((t): t is string => !!t)
    const dump = JSON.stringify(stores.map((m) => [...m.entries()].map(([k, v]) => [k, [...(v as Map<string, unknown>).entries()]])))
    ok(tokens.length >= 3 && tokens.every((t) => !dump.includes(t)), `freeze tokens are stored only as hashes (${tokens.length} checked)`)
  }

  // --- light-tier consent: a WebAuthn assertion verified by the directory (§9.6c) ---
  {
    const carol = await person('rot-carol@example.com')
    await bind(carol)
    const pk = await signer()
    const credId = b64uEnc(crypto.getRandomValues(new Uint8Array(32)))
    const cKey = b64uEnc(await sha(b64uDec(credId)!))
    const scope = await addressKey(carol.email)
    ;(env.CRED as { get(id: string): unknown }).get(cKey) // materialise, then seed its storage (registration arrives with the key-blob store)
    const credStore = stores.find((m) => m.has(cKey))!.get(cKey)!
    // one credential, re-pointed at each person below; its failure counter starts clean each time
    const seed = (rec: Record<string, unknown>) => { credStore.set('cred', rec); credStore.delete('fails'); credStore.delete('lockedUntil') }
    seed({ scope, pub: pk.pub, signCount: 0, be: true, attachment: 'platform', devicePub: null, created: now })

    const toDer = (raw: Uint8Array) => {
      const int = (v: Uint8Array) => { let i = 0; while (i < 31 && v[i] === 0) i++; v = v.slice(i); return v[0] & 0x80 ? Uint8Array.of(0, ...v) : v }
      const r = int(raw.slice(0, 32)), s = int(raw.slice(32))
      return Uint8Array.of(0x30, r.length + s.length + 4, 0x02, r.length, ...r, 0x02, s.length, ...s)
    }
    async function assertion(challengeB64: string, o: { origin?: string; type?: string; flags?: number; count?: number; extra?: Record<string, unknown>; key?: CryptoKey; id?: string } = {}) {
      const rp = await sha(enc('bento.page'))
      const ad = new Uint8Array(37); ad.set(rp, 0); ad[32] = o.flags ?? 0x05
      new DataView(ad.buffer).setUint32(33, o.count ?? 0)
      const cdj = enc(JSON.stringify({ type: o.type ?? 'webauthn.get', challenge: challengeB64, origin: o.origin ?? 'https://bento.page', ...(o.extra ?? {}) }))
      const signed = new Uint8Array(ad.length + 32); signed.set(ad); signed.set(await sha(cdj), ad.length)
      const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, o.key ?? pk.kp.privateKey, signed))
      return { credentialId: o.id ?? credId, authenticatorData: b64uEnc(ad), clientDataJSON: b64uEnc(cdj), signature: b64uEnc(toDer(raw)) }
    }
    async function wa(ch: string, payload: string, o: Parameters<typeof assertion>[1] & { audience?: string; exp?: number } = {}) {
      const exp = o.exp ?? now + 2 * MIN
      const transcript = (await consentTranscript(o.audience ?? 'dir', ch, payload))!
      const cns = buildConsent({ rp: 'bento', purpose: 'rotate', docId: null, transcript, exp })
      return { webauthn: await assertion(await webauthnChallengeFor(cns), o), exp }
    }
    const carol2 = await person(carol.email)
    const r = await rotation(carol, carol2)
    const reason = (x: Awaited<ReturnType<typeof rotStart>>) => String(x.j.reason)
    const tryWa = async (o: Parameters<typeof wa>[2] = {}, payload = r.stmt) => {
      const ch = await challengeFor(carol.email)
      return rotStart({ ...r, challenge: ch, consent: await wa(ch, payload, o) })
    }
    // the refusals first (each spends its own challenge); fewer than 5 in a row, so no lock yet
    ok(reason(await tryWa({ audience: 'room:w' + 'A'.repeat(43) })) === 'consent:webauthn:challenge', 'WebAuthn RELAY: a cns. for another audience is refused')
    ok(reason(await tryWa({}, (await stmtFor(carol2, 2, await hashOf(r.was), 5 * MONTH)).text)) === 'consent:webauthn:challenge', 'WebAuthn PAYLOAD SWAP is refused')
    ok(reason(await tryWa({ exp: now - 1 })) === 'consent:expired', 'WebAuthn EXPIRED consent is refused')
    ok(reason(await tryWa({ exp: now + 6 * MIN })) === 'consent:lifetime', 'WebAuthn consent living longer than 5 minutes is refused')
    {
      const ch = await challengeFor(carol.email)
      const c = await wa(ch, r.stmt)
      const a1 = await rotStart({ ...r, challenge: ch, consent: { ...c, webauthn: { ...c.webauthn, signature: c.webauthn.signature.slice(0, -4) + 'AAAA' } } })
      ok(reason(a1) === 'consent:webauthn:signature', 'a bad assertion signature is refused')
      ok(reason(await rotStart({ ...r, challenge: ch, consent: c })) === 'replay', 'WebAuthn REPLAY: the spent challenge refuses even a good assertion')
    }
    // control → accepted (resets the failure counter)
    let x = await tryWa({ count: 5 })
    ok(x.status === 202, `CONTROL: WebAuthn consent from https://bento.page is accepted (${JSON.stringify(x.j)})`)
    mailbox.length = 0
    // origin allow-list: exact strings; desktop native origins are self-asserted, never consent evidence.
    // Carol now has a rotation in flight, so these rows run against a new person.
    const dave = await person('rot-dave@example.com'); await bind(dave)
    seed({ scope: await addressKey(dave.email), pub: pk.pub, signCount: 5, be: true, attachment: 'platform', devicePub: null, created: now })
    const dave2 = await person(dave.email)
    const rd = await rotation(dave, dave2)
    const tryD = async (o: Parameters<typeof wa>[2] = {}) => {
      const ch = await challengeFor(dave.email)
      return rotStart({ ...rd, challenge: ch, consent: await wa(ch, rd.stmt, o) })
    }
    ok(reason(await tryD({ count: 6, origin: 'https://bento.page/' })) === 'consent:webauthn:origin', 'origin near-miss https://bento.page/ is refused')
    ok(reason(await tryD({ count: 6, origin: 'https://bento.page.evil' })) === 'consent:webauthn:origin', 'origin near-miss https://bento.page.evil is refused')
    ok(reason(await tryD({ count: 6, origin: 'bento-desktop:linux' })) === 'consent:webauthn:origin', 'a self-asserted desktop origin is never consent evidence')
    credStore.delete('fails') // three failures so far; keep the next rows clear of the five-failure lock
    env.DEV = '1'; env.DEV_ORIGINS = JSON.stringify(['chrome-extension://devid'])
    ok(reason(await tryD({ count: 6, origin: 'chrome-extension://devid2' })) === 'consent:webauthn:origin', 'DEV: a one-character near-miss of the dev extension id is refused')
    ok(reason(await tryD({ count: 6, origin: 'BENTO-DESKTOP:linux' })) === 'consent:webauthn:origin', 'origin match is case-exact')
    x = await tryD({ count: 6, origin: 'chrome-extension://devid' })
    ok(x.status === 202, 'DEV=1 with DEV_ORIGINS: the development extension id is accepted (CONTROL for the origin rows)')
    delete env.DEV; delete env.DEV_ORIGINS
    {
      const ch = await challengeFor(dave.email) // dave is pending now; the refusal must come from the origin, so use a fresh person
      void ch
      const gina = await person('rot-gina@example.com'); await bind(gina)
      seed({ scope: await addressKey(gina.email), pub: pk.pub, signCount: 0, be: true, attachment: 'platform', devicePub: null, created: now })
      const gina2 = await person(gina.email)
      const rg = await rotation(gina, gina2)
      const ch2 = await challengeFor(gina.email)
      ok(reason(await rotStart({ ...rg, challenge: ch2, consent: await wa(ch2, rg.stmt, { origin: 'chrome-extension://devid' }) })) === 'consent:webauthn:origin', 'the production config (no DEV) refuses the development extension id')
    }
    // the remaining WebAuthn field checks, against a third person
    const erin = await person('rot-erin@example.com'); await bind(erin)
    seed({ scope: await addressKey(erin.email), pub: pk.pub, signCount: 10, be: true, attachment: 'platform', devicePub: null, created: now })
    const erin2 = await person(erin.email)
    const re = await rotation(erin, erin2)
    const tryE = async (o: Parameters<typeof wa>[2] = {}) => {
      const ch = await challengeFor(erin.email)
      return rotStart({ ...re, challenge: ch, consent: await wa(ch, re.stmt, o) })
    }
    ok(reason(await tryE({ count: 11, type: 'webauthn.create' })) === 'consent:webauthn:type', 'a webauthn.create clientData is refused')
    ok(reason(await tryE({ count: 11, flags: 0x01 })) === 'consent:webauthn:flags', 'an assertion without UV is refused')
    ok(reason(await tryE({ count: 11, extra: { crossOrigin: true } })) === 'consent:webauthn:cross-origin', 'crossOrigin: true is refused')
    ok(reason(await tryE({ count: 11, extra: { topOrigin: 'https://evil.example' } })) === 'consent:webauthn:cross-origin', 'a topOrigin is refused')
    // five consecutive failures lock the credential for 15 minutes
    ok(reason(await tryE({ count: 9 })) === 'consent:webauthn:sign-count', 'a sign-count regression is refused (the fifth failure in a row)')
    ok(reason(await tryE({ count: 12 })) === 'consent:webauthn:locked', 'five consecutive failures lock the credential: even a good assertion is refused')
    now += 15 * MIN + 1
    const re2 = await rotation(erin, erin2)
    {
      const ch = await challengeFor(erin.email)
      x = await rotStart({ ...re2, challenge: ch, consent: await wa(ch, re2.stmt, { count: 0 }) })
      ok(x.status === 202, 'after the lock: a signCount of 0 (synced passkey) is accepted')
    }
    // a credential bound to ANOTHER address is unknown here
    const frank = await person('rot-frank@example.com'); await bind(frank)
    const frank2 = await person(frank.email)
    const rf = await rotation(frank, frank2)
    {
      const ch = await challengeFor(frank.email)
      ok(reason(await rotStart({ ...rf, challenge: ch, consent: await wa(ch, rf.stmt, { count: 20 }) })) === 'consent:webauthn:unknown', 'a credential registered to another address is refused')
    }
  }
  mailbox.length = 0
}

// =====================================================================
// nothing identifying at rest
// =====================================================================
{
  const dump = JSON.stringify(stores.map((m) => [...m.entries()].map(([k, v]) => [k, [...(v as Map<string, unknown>).entries()]])))
  // The address necessarily lives inside the signed statement the directory serves
  // (base64url, which is an encoding, not protection). What must hold: storage is
  // KEYED by a hash, so nothing lists addresses, and no OTHER copy exists.
  ok(!/@example\.com/.test(dump), 'no plaintext address anywhere in storage, beyond the signed statement it serves')
  ok(stores.every((m) => [...m.keys()].every((k) => k === 'ledger' || /^[0-9a-f]{64}$/.test(k) || /^[A-Za-z0-9_-]{43}$/.test(k))), 'every object is named by a hash (address or credential), never the address')
  ok(!/10\.0\.\d+\.\d+/.test(dump), 'no raw IP in storage')
}

// =====================================================================
// the kernel's conformance vectors, end to end through the Worker
// =====================================================================
const V = JSON.parse(readFileSync(new URL('../kernel/fixtures/identity-v1.json', import.meta.url), 'utf8'))
for (const r of V.addresses) {
  const want = r.address ?? null
  ok(normalize(r.input) === want, `vector address ${JSON.stringify(r.input).slice(0, 40)} → ${want ?? r.reason}`)
}
{
  const saved = now
  let n = 0
  now = V.now
  for (const v of V.statements.filter((x: { type: string; kxMode?: string }) => x.type === 'bind' && (x.kxMode ?? V.kxModeDefault) === V.kxModeDefault)) {
    n++
    const r = await api('POST', '/v1/bind/start', { stmt: v.text, sig: v.sig }, freshIp())
    ok(r.status === (v.expect === 'accept' ? 202 : 400), `vector ${v.name} → ${r.status}`)
  }
  ok(n >= 8, `the bind vectors actually ran (${n})`)
  now = saved
  mailbox.length = 0
}

console.log(`${passes} passed, ${fails} failed`)
process.exit(fails)
