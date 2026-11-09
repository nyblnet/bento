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
//   · the typed-code `bind.` routes are retired: 410 for any request, a valid
//     statement included, with no mail and nothing stored (G13);
//   · lookups are exact-address only, signed, and say nothing about addresses
//     that don't exist (404 for never-existed and expired alike);
//   · delete/start answers 202 whatever happens (no existence or limit oracle);
//   · per-address mail limits stop mail-bombing, and a start that mails
//     nothing spends nothing; per-IP limits are enforced;
//   · deletion (holder-signed, or by mailed code) leaves a SIGNED tombstone;
//   · no raw address or IP is ever written to storage.
//
// Nothing can make a binding through the API any more, so the rig PLANTS them
// in the Address object's storage, in the shape the retired route stored.

import worker, { Address, Ledger, LIMITS, RETIRED } from '../server/directory/src/worker.js'
import { addressKey, normalize } from '../server/directory/src/address.js'
import { b64uEnc, buildBind, buildDel, sha256b64u as hashOf, signStatement, verifyAtt, verifyBind, verifyTomb } from '../kernel/src/statements.ts'
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
  return { email, k, kx: (await kxPub()) as string | null, name } // mode C: every bind. carries the account's recovery kx
}
async function stmtFor(p: Awaited<ReturnType<typeof person>>, seq = 1, prev?: string, life = 13 * MONTH) {
  const text = bindText({ email: p.email, key: p.k.pub, kx: p.kx, name: p.name, seq, prev, created: now, expires: Math.floor(now + life) })
  return { text, sig: await p.k.sign(text) }
}
const storeOf = async (email: string) => {
  const k = await addressKey(email)
  ;(env.ADDRESS as { get(id: string): unknown }).get(k)
  return stores.find((m) => m.has(k))!.get(k)!
}
/** A binding as the retired bind route stored it: the statement must pass the kernel verifier. */
async function bindFor(p: Awaited<ReturnType<typeof person>>, seq = 1, prev?: string, life?: number, o: { rebound?: boolean } = {}) {
  const s = await stmtFor(p, seq, prev, life)
  const v = await verifyBind(s.text, s.sig, { now })
  if (!v.ok) throw new Error(`rig: planted statement does not verify (${v.reason})`)
  const st = await storeOf(p.email)
  const old = st.get('cur') as { h: string } | undefined
  if (old) st.set('chain', [...((st.get('chain') as string[] | undefined) ?? []), old.h])
  st.set('cur', { stmt: s.text, sig: s.sig, h: await hashOf(s.text), b: { key: p.k.pub, seq, expires: v.value.expires }, verifiedAt: now, rebound: !!o.rebound })
  st.delete('tomb')
  return { s }
}
const bind = (p: Awaited<ReturnType<typeof person>>, seq = 1, prev?: string) => bindFor(p, seq, prev)

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
// the retired bind. routes: 410, whatever is sent, and nothing happens
// =====================================================================
{
  ok(JSON.stringify(RETIRED) === JSON.stringify(['/v1/bind/start', '/v1/bind/complete']), 'both typed-code bind routes are listed as retired')
  const p = await person('rita@example.com')
  const s = await stmtFor(p)
  // control: the statement is one the retired route would have accepted and mailed a code for
  ok((await verifyBind(s.text, s.sig, { now })).ok, 'control: the statement sent below passes the kernel verifier')
  const m0 = mailbox.length
  const bodies: [string, unknown][] = [
    ['/v1/bind/start', { stmt: s.text, sig: s.sig }],
    ['/v1/bind/complete', { email: p.email, code: 'ABCDEFGH', sig: await p.k.sign(s.text) }],
  ]
  for (const [path, body] of bodies) {
    for (const method of ['POST', 'GET']) {
      const r = await api(method, path, method === 'POST' ? body : undefined, freshIp())
      ok(r.status === 410 && r.j.error === 'gone', `${method} ${path} → 410 gone (got ${r.status})`)
      ok(r.h.get('content-type') === 'application/json' && r.h.get('x-content-type-options') === 'nosniff' && r.h.get('x-frame-options') === 'DENY' &&
        /default-src 'none'/.test(r.h.get('content-security-policy') ?? '') && /publickey-credentials-get=\(\)/.test(r.h.get('permissions-policy') ?? ''),
      `${method} ${path}: the full header set`)
    }
  }
  ok(mailbox.length === m0, 'the retired routes mailed nothing')
  ok(![...(await storeOf(p.email)).keys()].length, 'and stored nothing for the address')
  ok((await api('GET', '/v1/lookup?e=rita@example.com')).status === 404, 'and nothing is published')
}

// =====================================================================
// lookup
// =====================================================================
const alice = await person('alice@example.com', 'Alice')
{
  const { s } = await bind(alice)
  const verifiedAt = now
  now += HOUR
  const r = await api('GET', '/v1/lookup?e=ALICE@example.com')
  ok(r.status === 200 && r.j.binding === s.text, 'lookup by exact address (case-insensitive) → 200 with the exact statement')
  const att = String(r.j.attestation)
  ok(att === `att.${await hashOf(s.text)}.${verifiedAt}.${now}.dir-1.active`, `the attestation names this exact text, state active (${att.slice(0, 30)}…)`)
  const f = att.split('.')
  ok(f[3] === String(now) && Number(f[2]) === now - HOUR, 'lookup re-issues the attestation: fresh issuedAt, original verifiedAt')
  ok(await verifyDirAtt(att, String(r.j.attestationSig), String(r.j.binding)), 'lookup attestation passes verifyAtt')
  ok(r.h.get('access-control-allow-origin') === '*' && r.h.get('x-robots-tag')?.includes('noindex') && !r.h.get('set-cookie'), 'headers: CORS *, noindex, no cookie')
  ok((await api('GET', '/v1/lookup?e=nobody@example.com')).status === 404, 'unknown address → 404')
  ok((await api('GET', '/v1/lookup?e=alice@')).status === 400, 'malformed address → 400')
  ok((await api('GET', '/v1/lookup?e=alice%40example.co')).status === 404, 'no prefix or fuzzy match')
  ok(r.j.rebound === false && Array.isArray(r.j.chain) && (r.j.chain as string[]).length === 0, 'a first binding: not rebound, empty chain')
  // a planted second binding with a different key: lookup carries rebound and the chain
  const ivan = await person('ivan@example.com')
  const iv1 = await bindFor(ivan, 1, undefined, 10 * MIN)
  now += 11 * MIN
  await bindFor(await person('ivan@example.com'), 2, await hashOf(iv1.s.text), undefined, { rebound: true })
  const il = await api('GET', '/v1/lookup?e=ivan@example.com')
  ok(il.j.rebound === true && (il.j.chain as string[]).length === 1 && (il.j.chain as string[])[0] === await hashOf(iv1.s.text), 'lookup carries rebound and the chain of earlier hashes')
}

// =====================================================================
// removal codes: attempts, expiry
// =====================================================================
/** a binding that has run out (still held, so it can be removed by mailbox) */
async function expired(email: string) {
  const p = await person(email)
  await bindFor(p, 1, undefined, 10 * MIN)
  now += 11 * MIN
  return p
}
{
  const p = await expired('dave@example.com')
  ok((await api('POST', '/v1/delete/start', { email: p.email })).status === 202, 'delete/start on an expired binding → 202')
  const code = codeFor(p.email)!
  ok(!!code && /^[2-9A-HJ-NP-Z]{8}$/.test(code), 'a removal code is mailed')
  for (let i = 0; i < LIMITS.codeAttempts; i++) await api('POST', '/v1/delete/complete', { email: p.email, code: 'ZZZZZZZZ' })
  ok((await api('POST', '/v1/delete/complete', { email: p.email, code })).status === 400, `after ${LIMITS.codeAttempts} wrong tries the right code is dead too`)
  now += 2 * MIN
  await api('POST', '/v1/delete/start', { email: p.email })
  const code2 = codeFor(p.email)!
  ok(code2 !== code, 'a second start mails a fresh code')
  now += LIMITS.codeTtlMs + 1
  ok((await api('POST', '/v1/delete/complete', { email: p.email, code: code2 })).status === 400, 'an expired code fails')
  ok((await api('POST', '/v1/delete/complete', { email: p.email, code: 'bad' })).status === 400, 'a malformed code → 400')
}

// =====================================================================
// per-address mail limits (mail-bombing) — and start still says 202
// =====================================================================
{
  const p = await expired('erin@example.com')
  const before = mailbox.length
  for (let i = 0; i < 6; i++) {
    const r = await api('POST', '/v1/delete/start', { email: p.email }, freshIp())
    ok(r.status === 202, `start #${i + 1} → 202 regardless`)
    now += 10 * 1000 // inside the cooldown for the first few
  }
  ok(mailbox.length - before === 1, `cooldown: only ONE mail inside a minute (${mailbox.length - before})`)
  for (let i = 0; i < 5; i++) { now += 2 * MIN; await api('POST', '/v1/delete/start', { email: p.email }, freshIp()) }
  ok(mailbox.length - before === LIMITS.mailPerDay, `at most ${LIMITS.mailPerDay} mails a day to one address (${mailbox.length - before})`)
  now += DAY + MIN
  await api('POST', '/v1/delete/start', { email: p.email }, freshIp())
  ok(mailbox.length - before === LIMITS.mailPerDay + 1, 'the next day the address can be mailed again')
}

// =====================================================================
// a start that mails nothing costs nothing: anyone can send delete/start for
// any address, so its refusals must not spend the holder's mail budget
// =====================================================================
{
  now += HOUR
  const holder = await person('hana@example.com')
  await bindFor(holder, 1, undefined, 2 * HOUR)
  const spent = async () => (((await storeOf(holder.email)).get('mail') as number[] | undefined) ?? []).length
  const m0 = mailbox.length, b0 = await spent()
  // more refused starts (the binding is LIVE: email never removes it) than the whole daily budget
  for (let i = 0; i < LIMITS.mailPerDay + 2; i++) {
    now += 2 * MIN
    ok((await api('POST', '/v1/delete/start', { email: holder.email }, freshIp())).status === 202, `budget: stranger start #${i + 1} on a live binding → 202`)
  }
  ok(mailbox.length === m0, `budget: the refused starts mailed nothing (${mailbox.length - m0})`)
  ok((await spent()) === b0, `budget: and recorded no mail against the address (${(await spent()) - b0} recorded)`)
  now += 2 * HOUR // the binding runs out
  await api('POST', '/v1/delete/start', { email: holder.email })
  ok(mailbox.length === m0 + 1 && mailbox[mailbox.length - 1].to === holder.email, "budget: the holder's own removal start, once it may be mailed, is still mailed")
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
  ok(jo1.s.text.startsWith('bind.'), 'the expired control had been bound')
  const goLive = async (email: string) => {
    const st = await storeOf(email); const cur = st.get('cur') as { b: { expires: number } }
    cur.b.expires = now + DAY; st.set('cur', cur)
  }
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
  // delete/start past the per-IP limit: still 202 (the limit is not an oracle), but no mail
  const ip = freshIp()
  const ps = []
  for (let i = 0; i <= LIMITS.ip.start; i++) { const p = await person(`ip${i}@example.net`); await bindFor(p, 1, undefined, 10 * MIN); ps.push(p) }
  now += 11 * MIN
  const before = mailbox.length
  const statuses = new Set<number>()
  for (const p of ps) statuses.add((await api('POST', '/v1/delete/start', { email: p.email }, ip)).status)
  ok(statuses.size === 1 && statuses.has(202), `delete/start answers 202 even past the per-IP limit (${[...statuses]})`)
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
  // the bind vectors are the kernel's (its own rig runs them); here only the
  // ones a planted binding relies on: every accept vector verifies as planted
  const saved = now
  now = V.now
  ok(V.kxMode === 'C', `the vectors are mode C (${V.kxMode})`)
  let n = 0
  for (const v of V.statements.filter((x: { type: string; expect: string }) => x.type === 'bind')) {
    n++
    ok((await verifyBind(v.text, v.sig, { now })).ok === (v.expect === 'accept'), `vector ${v.name}`)
  }
  ok(n >= 30, `the bind vectors actually ran (${n})`)
  now = saved
}

console.log(`${passes} passed, ${fails} failed`)
process.exit(fails)
