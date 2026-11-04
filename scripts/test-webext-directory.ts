#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// home/webext — the directory client (bento/connect W1: bind, two proofs).
//
//   node scripts/test-webext-directory.ts
//
// Runs the extension's own client (id/directory.js, id/keystore.js) against the
// REAL directory worker and its Durable Object classes (server/directory),
// in memory, with kernel's verifiers as the judge. It proves:
//   · a Bento ID binds only with BOTH proofs: bind/start gets a uniform 202,
//     and only the mailed code signed by the same key completes it; a wrong
//     code, a code replayed by another key, and a typed code with another
//     alphabet are all refused;
//   · the client believes the directory's answer only if it is exactly the
//     binding it signed and the attestation verifies against a key the CLIENT
//     holds: a swapped binding, an unknown kid, a tampered state, a stale
//     answer and a signature by another key are each refused;
//   · a record becomes `bound` once, and only for its own key;
//   · the locally held recovery inner blob and verifier are deleted ONLY after
//     the directory acknowledges (ok === true) — a refusal, a throw, a network
//     failure, a non-boolean "truthy" answer and a record replaced while the
//     request was in flight each keep everything;
//   · on the real key-store routes (rows shared with the manual HTTP rig, in
//     scripts/lib/webext-directory-keystore.mjs): the first passkey goes in under
//     the setup allowance, the code after it by that passkey's WebAuthn consent, a
//     code before any passkey is refused locally, and the backup is ready only on
//     a real fetch and unwrap;
//   · a right code told a deletion is still being carried out is `try-later`,
//     not `rejected`, and that same code completes the binding once it lands.

import { argon2 as nodeArgon2 } from 'node:crypto'
import worker, { Account, Address, Cred, Ledger, Link } from '../server/directory/src/worker.js'
import { buildDel } from '../server/directory/src/statements.js'
import { keyStoreRows } from './lib/webext-directory-keystore.mjs'

const agent = await import('../home/webext/src/id/agent.js')
const ks = await import('../home/webext/src/id/keystore.js')
const dc = await import('../home/webext/src/id/directory.js')
const st = await import('../home/webext/src/id/gen/statements.js')

let failures = 0, passes = 0
function ok(cond: boolean, msg: string) { if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else { passes++; console.log(`  ok    ${msg}`) } }

// the mail cooldown between two binds of one address is the only reason this rig moves the clock
const realNow = Date.now
let skew = 0
Date.now = () => realNow() + skew

const argon2id = (password: Uint8Array, salt: Uint8Array) => new Promise<Uint8Array>((res, rej) =>
  nodeArgon2('argon2id', { message: password, nonce: salt, parallelism: 1, tagLength: 32, memory: 65536, passes: 3 }, (e: any, k: any) => (e ? rej(e) : res(new Uint8Array(k)))))
const memdb = () => { const m = new Map<string, any>(); return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: any) => { m.set(k, v) }, del: async (k: string) => { m.delete(k) } } }

// --- the real directory, in memory ------------------------------------------------
// the next `n` calls of this op on this class throw before they arrive
let chaos: { cls: any; op: string; n: number } | null = null
function namespace(Klass: any, env: any) {
  const objs = new Map<string, any>()
  return {
    idFromName: (n: string) => n,
    get(id: string) {
      if (!objs.has(id)) {
        const store = new Map<string, unknown>()
        objs.set(id, new Klass({ storage: {
          async get(k: string) { return structuredClone(store.get(k)) },
          async put(k: string, v: unknown) { store.set(k, structuredClone(v)) },
          async delete(k: string | string[]) { for (const x of ([] as string[]).concat(k)) store.delete(x) },
          async list(o?: { prefix?: string }) { return new Map([...store].filter(([k]) => k.startsWith(o?.prefix ?? ''))) }, async setAlarm() {},
        } }, env))
      }
      const obj = objs.get(id)
      return { fetch: async (u: any, init?: any) => {
        const r = u instanceof Request ? u : new Request(u, init)
        if (chaos && chaos.cls === Klass && chaos.n > 0 && (await r.clone().json().catch(() => ({}))).op === chaos.op) { chaos.n--; throw new Error('rig: this call fails') }
        return obj.fetch(r)
      } }
    },
  }
}
const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const
const dirKp = (await crypto.subtle.generateKey(EC, true, ['sign', 'verify'])) as CryptoKeyPair
const dirPub = st.b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', dirKp.publicKey)))
const otherKp = (await crypto.subtle.generateKey(EC, true, ['sign', 'verify'])) as CryptoKeyPair
const otherPub = st.b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', otherKp.publicKey)))
const mailbox: { to: string; code: string }[] = []
const env: any = { DIR_KID: 'dir-1', DIR_KEY_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', dirKp.privateKey)), DIR_PUBKEYS: '[]', MAILER: { send: (m: any) => { mailbox.push(m) } },
  KEYSTORE: '1', CHALLENGE_KEY: 'rig-challenge-secret-0123456789abcdef', PEPPER_V1: st.b64uEnc(crypto.getRandomValues(new Uint8Array(32))) }
env.ADDRESS = namespace(Address, env); env.LEDGER = namespace(Ledger, env)
env.CRED = namespace(Cred, env); env.ACCOUNT = namespace(Account, env); env.LINK = namespace(Link, env)
let ip = 0
const toWorker = (tamper?: (path: string, body: any) => any) => async (url: string, init: any) => {
  const path = new URL(url).pathname
  const r = await worker.fetch(new Request(url, { ...init, headers: { ...init.headers, 'cf-connecting-ip': `10.1.${Math.floor(++ip / 250)}.${ip % 250}` } }), env)
  if (!tamper) return r
  const body = await r.json()
  return new Response(JSON.stringify(tamper(path, body) ?? body), { status: r.status, headers: { 'content-type': 'application/json' } })
}
const KEYS = { 'dir-1': dirPub }
const deps = (over: any = {}) => ({ fetch: toWorker(), now: () => Date.now(), directoryKeys: KEYS, base: 'https://id.bento.page', ...over })

async function newId(label = 'Chrome') {
  const prf = crypto.getRandomValues(new Uint8Array(32))
  const { record } = await agent.createBentoId({ label }, { subtle: crypto.subtle, rand: (n: number) => crypto.getRandomValues(new Uint8Array(n)), now: () => Date.now(), argon2id,
    passkey: async () => ({ credentialId: crypto.getRandomValues(new Uint8Array(32)), prfOutput: prf.slice() }) })
  return record
}
const codeFor = (to: string) => [...mailbox].reverse().find((m) => m.to === to)?.code as string
const fails = (p: Promise<unknown>) => p.then(() => null, (e) => e)

console.log('\n— binding: two proofs')
const rec = await newId()
const db = memdb()
await ks.saveNewSelf(rec, db as any)
const { pending } = await dc.bindStart({ record: rec, email: 'Alice@Example.com' }, deps())
ok(pending.address === 'alice@example.com', 'the address is normalised before it is signed')
ok(mailbox.length === 1 && mailbox[0].to === 'alice@example.com', 'start → the directory mailed one code to the address')
const bindOk = await st.verifyBind(pending.text, pending.sig, { now: Date.now() })
ok(bindOk.ok && bindOk.value.accountPub === rec.accountPub && bindOk.value.kx === rec.recoveryKxPub && bindOk.value.seq === 1, 'the statement is a kernel-valid bind. naming this account key and the RECOVERY kx (mode C), seq 1')
ok(await dc.bindStart({ record: rec, email: 'not an address' }, deps()).then(() => 'no', (e) => e.reason) === 'bad-address', 'a malformed address is refused before anything is sent')

const bad = await dc.bindComplete({ record: rec, pending, code: 'AAAAAAAA' }, deps())
ok(!bad.ok && bad.reason === 'rejected', 'a wrong code → rejected (the directory\'s 400 is uniform)')
const intruder = await newId('intruder')
const stolen = await dc.bindComplete({ record: intruder, pending, code: codeFor('alice@example.com') }, deps())
ok(!stolen.ok, 'the right code signed by ANOTHER key does not complete the binding: the code alone is half a proof')
for (const [name, tamper, want] of [
  ['a different binding than the one signed', (p: string, b: any) => p === '/v1/bind/complete' && { ...b, binding: b.binding.replace('.1.', '.2.') }, 'wrong-binding'],
  ['an attestation by a directory key the client does not hold', (p: string, b: any) => p === '/v1/bind/complete' && { ...b, attestation: b.attestation.replace('.dir-1.', '.dir-9.') }, 'attestation: unknown-kid'],
  ['an attestation with its state edited', (p: string, b: any) => p === '/v1/bind/complete' && { ...b, attestation: b.attestation.replace('.active', '.frozen') }, 'attestation: signature'],
  ['no attestation', (p: string, b: any) => p === '/v1/bind/complete' && { binding: b.binding }, 'no-attestation'],
] as const) {
  // each probe needs its own fresh code, so start again for a new address
  const r2 = await newId(); const addr = `t${mailbox.length}@example.com`
  const s2 = (await dc.bindStart({ record: r2, email: addr }, deps())).pending
  const res = await dc.bindComplete({ record: r2, pending: s2, code: codeFor(addr) }, deps({ fetch: toWorker(tamper as any) }))
  ok(!res.ok && res.reason === want, `the client refuses ${name} (${res.reason})`)
}
{
  const r3 = await newId(); const addr = 'stale@example.com'
  const s3 = (await dc.bindStart({ record: r3, email: addr }, deps())).pending
  const res = await dc.bindComplete({ record: r3, pending: s3, code: codeFor(addr) }, deps({ now: () => Date.now() + 3_600_000 }))
  ok(!res.ok && /stale|expired/.test(res.reason), `an answer an hour old is refused (${res.reason})`)
  const r4 = await newId(); const addr4 = 'wrongdir@example.com'
  const s4 = (await dc.bindStart({ record: r4, email: addr4 }, deps())).pending
  const res4 = await dc.bindComplete({ record: r4, pending: s4, code: codeFor(addr4) }, deps({ directoryKeys: { 'dir-1': otherPub } }))
  ok(!res4.ok && res4.reason === 'attestation: signature', `an attestation that does not verify under the key the client holds is refused (${res4.reason})`)
}

const done = await dc.bindComplete({ record: rec, pending, code: codeFor('alice@example.com').toLowerCase().replace(/^(....)/, '$1-') }, deps())
ok(done.ok === true && done.bound.address === 'alice@example.com' && done.bound.att.kid === 'dir-1', 'the right code, typed in lower case with a dash, completes the binding; kernel verifyAtt passed')
ok(done.ok && done.bound.text === pending.text, 'and the bound statement is exactly the one that was signed')
const m1 = await ks.markBound(done.bound, db as any)
const after = await ks.loadSelf(db as any)
ok(m1.ok && after.state === 'bound' && ks.publicView(after).address === 'alice@example.com', 'the record becomes `bound`, and the page view names the address')
ok((await ks.markBound(done.bound, db as any)).reason === 'state', 'a bound record is never bound again')
const other = memdb(); await ks.saveNewSelf(intruder, other as any)
ok((await ks.markBound(done.bound, other as any)).reason === 'other key', 'a binding for another account key cannot be written onto this record')
ok(await dc.bindStart({ record: after, email: 'alice2@example.com' }, deps()).then(() => 'no', (e) => e.reason) === 'already-bound', 'a bound record does not start another binding')
{
  const lk = await (await toWorker()('https://id.bento.page/v1/lookup?e=alice@example.com', { method: 'GET', headers: {} })).json()
  ok(lk.binding === pending.text, 'a lookup returns the same binding the client signed')
}

console.log('\n— the local recovery material goes only when the directory has taken it')
const material = (r: any) => !!(r.recovery?.inner && r.recovery?.verifier && r.recovery?.salt && r.recovery?.saltV && r.recovery?.iv)
for (const [name, enrol] of [
  ['a refusal', async () => ({ ok: false, reason: 'no' })],
  ['a thrown error', async () => { throw new Error('offline') }],
  ['no answer', async () => undefined],
  ['a truthy non-ack', async () => ({ ok: 'true' })],
  ['the bare word ok', async () => 'ok'],
] as const) {
  const d = memdb(); const r = await newId(); await ks.saveNewSelf(r, d as any)
  const res = await dc.retireRecovery(d as any, enrol as any, { now: () => 1 })
  const kept = await d.get('self')
  ok(!res.ok && material(kept) && kept.passkeys.length === 1, `${name}: nothing deleted (${res.reason})`)
}
{
  const d = memdb(); const r = await newId(); await ks.saveNewSelf(r, d as any)
  let seen: any = null
  const res = await dc.retireRecovery(d as any, async (m: any) => { seen = m; return { ok: true } }, { now: () => 42 })
  const kept = await d.get('self')
  ok(res.ok && seen.inner === r.recovery.inner && seen.verifier === r.recovery.verifier && seen.accountPub === r.accountPub, 'the material was handed to the directory whole before anything was deleted')
  ok(res.ok && !kept.recovery.inner && !kept.recovery.verifier && !kept.recovery.salt && !kept.recovery.saltV && !kept.recovery.iv, 'on ok === true the inner blob, verifier, salts and iv are gone from the stored record')
  ok(kept.recovery.enrolled === 42 && ks.publicView(kept).recovery === true && kept.passkeys.length === 1 && kept.passkeys[0].blob, 'a record still says it HAS recovery, and the passkey blob is untouched')
  ok((await dc.retireRecovery(d as any, async () => { throw new Error('must not be called') }, { now: () => 1 })).already === true, 'a second run has nothing to send and nothing to do')
}
{
  const d = memdb(); const r = await newId(); await ks.saveNewSelf(r, d as any)
  const res = await dc.retireRecovery(d as any, async () => { await d.del('self'); await d.put('self', { ...r, accountPub: 'someone-else' }); return { ok: true } }, { now: () => 1 })
  ok(!res.ok && res.reason === 'record-changed' && material(await d.get('self')), 'a record replaced while the request was in flight is left alone')
}
console.log('\n— the passkey backup is ready only after a read-back unwraps')
{
  const prf = crypto.getRandomValues(new Uint8Array(32)), cid = crypto.getRandomValues(new Uint8Array(32))
  const r = (await agent.createBentoId({ label: 'rb' }, { subtle: crypto.subtle, rand: (n: number) => crypto.getRandomValues(new Uint8Array(n)), now: () => Date.now(), argon2id,
    passkey: async () => ({ credentialId: cid, prfOutput: prf.slice() }) })).record
  const blob = r.passkeys[0].blob
  const other = (await agent.createBentoId({ label: 'x' }, { subtle: crypto.subtle, rand: (n: number) => crypto.getRandomValues(new Uint8Array(n)), now: () => Date.now(), argon2id,
    passkey: async () => ({ credentialId: cid, prfOutput: prf.slice() }) })).record.passkeys[0].blob
  const flip = (b: any) => { const ct = st.b64uDec(b.ct); ct[3] ^= 1; return { ...b, ct: st.b64uEnc(ct) } }
  const ready = (fetchBlob: any, prfOutput = prf) => dc.passkeyBackupReady({ record: r, credentialId: cid, prfOutput, fetchBlob })
  ok((await ready(async () => blob)).ready === true, 'the blob fetched back unwraps with the PRF key → ready')
  for (const [n, f] of [['a corrupt blob', async () => flip(blob)], ['a swapped blob (another account\'s)', async () => other], ['no blob', async () => null], ['a failed fetch', async () => { throw new Error('x') }]] as const) {
    const res = await ready(f as any)
    ok(res.ready === false, `${n}: NOT ready (${res.reason})`)
  }
  ok((await ready(async () => blob, crypto.getRandomValues(new Uint8Array(32)))).ready === false, 'the wrong PRF output: NOT ready')
}

console.log('\n— the key-store routes, in the only order that does not strand this tier')
await keyStoreRows({ ok, deps: deps(), codeFor, argon2id })

console.log('\n— a right code while a deletion is being carried out: try later, and the code still works')
{
  const r = await newId(); const addr = 'wipe@example.com'
  const s1 = (await dc.bindStart({ record: r, email: addr }, deps())).pending
  ok((await dc.bindComplete({ record: r, pending: s1, code: codeFor(addr) }, deps())).ok === true, 'CONTROL: bound before the delete')
  chaos = { cls: Account, op: 'wipe', n: 1000 } // the Account object stays down
  const ts = Date.now()
  const del = await toWorker()('https://id.bento.page/v1/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: addr, ts, sig: await st.signStatement(r.accountKey, buildDel(addr, ts)) }) })
  ok(del.status === 204 && chaos.n < 1000, `CONTROL: the delete answers ${del.status} and its wipe really failed, so it is still owed`)
  skew += 2 * 60_000 // past the per-address mail cooldown
  const sent = mailbox.length
  const s2 = (await dc.bindStart({ record: r, email: addr }, deps())).pending
  ok(mailbox.length === sent + 1, 'CONTROL: a new code was mailed for the same key')
  const code = codeFor(addr)
  ok((await dc.bindComplete({ record: r, pending: s2, code: 'AAAAAAAA' }, deps())).reason === 'rejected', 'a wrong code while it is owed is still `rejected`: only the right code and key hear otherwise')
  const later = await dc.bindComplete({ record: r, pending: s2, code }, deps())
  ok(!later.ok && later.reason === 'try-later', `the right code while it is owed → try later, not rejected (${later.reason})`)
  ok((await dc.bindComplete({ record: r, pending: s2, code }, deps())).reason === 'try-later', 'and asking again costs nothing')
  chaos = null // the Account object is back
  const landed = await dc.bindComplete({ record: r, pending: s2, code }, deps())
  ok(landed.ok === true, `once the deletion lands, the SAME code completes the binding (${landed.reason ?? 'bound'})`)
}
console.log(failures ? `\n${failures} FAILED, ${passes} ok` : `\nall passed: ${passes} ok`)
process.exit(failures ? 1 : 0)
