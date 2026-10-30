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
//   · no raw address or IP is ever written to storage.

import worker, { Address, Ledger, LIMITS } from '../server/directory/src/worker.js'
import { addressKey, normalize } from '../server/directory/src/address.js'
import { b64uEnc, buildBind, buildCmp, buildDel, sha256b64u as hashOf, signStatement, verifyAtt, verifyTomb } from '../kernel/src/statements.ts'
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
// nothing identifying at rest
// =====================================================================
{
  const dump = JSON.stringify(stores.map((m) => [...m.entries()].map(([k, v]) => [k, [...(v as Map<string, unknown>).entries()]])))
  // The address necessarily lives inside the signed statement the directory serves
  // (base64url, which is an encoding, not protection). What must hold: storage is
  // KEYED by a hash, so nothing lists addresses, and no OTHER copy exists.
  ok(!/@example\.com/.test(dump), 'no plaintext address anywhere in storage, beyond the signed statement it serves')
  ok(stores.every((m) => [...m.keys()].every((k) => k === 'ledger' || /^[0-9a-f]{64}$/.test(k))), 'every address object is named by a hash, never the address')
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
