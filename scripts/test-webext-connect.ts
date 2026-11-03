#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// home/webext — creating a Bento ID (bento/connect W1b).
//
//   node scripts/test-webext-connect.ts
//
// WHAT THIS PROVES, on the extension's own code (id/agent.js, id/keystore.js,
// id/passkey.js) with kernel's verifiers as the judge:
//   · the device certificate verifies under kernel's verifyDev, consent slot empty,
//     its kx slot carrying this device's own kx (mode C, identity-design §6b);
//   · both blobs are 64 bytes: the account scalar ‖ the recovery kx scalar, each
//     matched to its public half; a v1 (pre-C) record is DISCARDED on load;
//   · the passkey blob opens with that passkey's PRF output to the account key,
//     and the recovery blob opens with the code shown (kernel's open functions);
//   · the recovery code appears NOWHERE in the stored record, nor does the raw
//     account scalar; both keys are stored NON-extractable;
//   · no PRF → no passkey blob (never a weaker wrap); no Argon2id → no code;
//     neither → setup refuses; a cancelled ceremony creates nothing;
//   · a second setup never replaces the first;
//   · the ceremony requests bento.page every time and tells a lost-focus
//     refusal from a permission refusal.

import { argon2 as nodeArgon2 } from 'node:crypto'

const agent = await import('../home/webext/src/id/agent.js')
const ks = await import('../home/webext/src/id/keystore.js')
const pk = await import('../home/webext/src/id/passkey.js')
const st = await import('../home/webext/src/id/gen/statements.js')
const rc = await import('../home/webext/src/id/gen/recovery.js')
const wrap = await import('../home/webext/src/id/argon2.js')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// Node's native Argon2id with the signed parameters (the vendored one is proven
// equal to it in test-webext-id.ts; native keeps this rig fast)
const argon2id = (password: Uint8Array, salt: Uint8Array) => new Promise<Uint8Array>((res, rej) =>
  nodeArgon2('argon2id', { message: password, nonce: salt, parallelism: 1, tagLength: 32, memory: 65536, passes: 3 }, (e: any, k: any) => (e ? rej(e) : res(new Uint8Array(k)))))
const NOW = Date.UTC(2026, 9, 21)
const memdb = () => { const m = new Map<string, any>(); return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: any) => { m.set(k, v) }, del: async (k: string) => { m.delete(k) } } }
const fakePasskey = (prf: Uint8Array | null, credentialId = crypto.getRandomValues(new Uint8Array(32))) => {
  const calls: any[] = []
  const fn = async (a: any) => { calls.push(a); return { credentialId, prfOutput: prf ? prf.slice() : null } }
  return { fn, calls, credentialId }
}
const deps = (over: any = {}) => ({ subtle: crypto.subtle, rand: (n: number) => crypto.getRandomValues(new Uint8Array(n)), now: () => NOW, argon2id, ...over })
const fails = (p: Promise<unknown>) => p.then(() => null, (e) => e)

/** Every byte string reachable from a record, for "does X appear anywhere?" */
function bytesIn(v: any, out: string[] = [], seen = new Set()): string[] {
  if (v === null || v === undefined || seen.has(v)) return out
  if (typeof v === 'string') { out.push(v); return out }
  if (v instanceof Uint8Array) { out.push(Buffer.from(v).toString('hex')); return out }
  if (typeof v === 'object') { seen.add(v); for (const k of Object.keys(v)) bytesIn(v[k], out, seen) }
  return out
}

console.log('\n— a Bento ID, created with a PRF passkey and a recovery code')
{
  const prf = crypto.getRandomValues(new Uint8Array(32))
  const p = fakePasskey(prf)
  const { record, recoveryCode } = await agent.createBentoId({ label: 'Chrome on my laptop' }, deps({ passkey: p.fn }))
  ok(p.calls.length === 1 && new TextDecoder().decode(p.calls[0].prfEval) === 'bento/id/prf/v1', 'the passkey ceremony evaluates the fixed PRF input "bento/id/prf/v1"')
  const dev = await st.verifyDev(record.dev.text, record.dev.sig, { now: NOW })
  ok(dev.ok && dev.value.devicePub === record.devicePub && dev.value.accountPub === record.accountPub && dev.value.consentPub === null && dev.value.label === 'Chrome on my laptop', 'the device certificate verifies under kernel\'s verifyDev, with the consent slot EMPTY (light tier)')
  ok(dev.ok && dev.value.kx === record.kxPub && record.kxPub !== record.recoveryKxPub, 'its kx slot carries THIS device\'s kx, distinct from the recovery kx (mode C)')
  ok(record.v === 2 && agent.RECORD_V === 2, 'the record is v2 (mode C)')
  ok(record.accountKey.extractable === false && record.deviceKey.extractable === false && record.kxKey.extractable === false && record.recoveryKxKey.extractable === false, 'all four keys are stored NON-extractable')
  ok(record.accountKey.usages.join() === 'sign' && record.deviceKey.usages.join() === 'sign', 'the signing keys are sign-only')
  ok(record.kxKey.usages.join() === 'deriveBits' && record.recoveryKxKey.usages.join() === 'deriveBits' && record.kxKey.algorithm.name === 'ECDH', 'the kx keys are ECDH, deriveBits only')
  const kxProbe = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as CryptoKeyPair
  const pubOf = async (k: CryptoKey) => st.b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', k)))
  const dh = async (priv: CryptoKey, pub: string) => Buffer.from(await crypto.subtle.deriveBits({ name: 'ECDH', public: await crypto.subtle.importKey('raw', st.b64uDec(pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []) }, priv, 256)).toString('hex')
  ok(await dh(record.recoveryKxKey, await pubOf(kxProbe.publicKey)) === await dh(kxProbe.privateKey, record.recoveryKxPub), 'the stored recovery kx key is the one recoveryKxPub names (an ECDH agreement matches)')
  // the account key in the record IS the account key the certificate names
  const probe = new TextEncoder().encode('probe')
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, record.accountKey, probe)
  const pubKey = await crypto.subtle.importKey('raw', st.b64uDec(record.accountPub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, sig, probe), 'the stored (non-extractable) account key is the one the certificate names')
  // the passkey blob opens with that passkey, to that account key
  const expected = { accountPub: record.accountPub, kxPub: record.recoveryKxPub }
  const opened = await rc.openPrfBlob(record.passkeys[0].blob, { prfOutput: prf, credentialId: p.credentialId, expected })
  ok(opened.ok === true, `the passkey blob opens with that passkey's PRF output, to account ‖ recovery kx (kernel openPrfBlob: ${opened.ok ? 'ok' : opened.reason})`)
  ok(st.b64uDec(record.passkeys[0].blob.ct).length === 64 + 16, 'the passkey blob is 64 bytes plus the tag')
  const noKx = await rc.openPrfBlob(record.passkeys[0].blob, { prfOutput: prf, credentialId: p.credentialId, expected: { accountPub: record.accountPub, kxPub: record.kxPub } })
  ok(noKx.ok === false && noKx.reason === 'key-mismatch', 'checked against the DEVICE kx instead, it is refused: the blob carries the recovery kx')
  ok((await rc.openPrfBlob(record.passkeys[0].blob, { prfOutput: crypto.getRandomValues(new Uint8Array(32)), credentialId: p.credentialId, expected })).ok === false, 'and not with another passkey\'s')
  // the recovery code
  const parsed = rc.parseRecoveryCode(recoveryCode)
  ok(parsed.ok === true && /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}-[0-9A-Z*~$=]$/.test(recoveryCode), `the recovery code is shown in the printed form (${recoveryCode.replace(/[0-9A-Z]/g, 'X')})`)
  if (parsed.ok) {
    const r = record.recovery
    const wrapKey = await rc.recoveryWrapKey(parsed.code, st.b64uDec(r.salt), argon2id)
    const inner = await rc.openRecoveryInner(st.b64uDec(r.inner), { wrapKey, iv: st.b64uDec(r.iv), expected })
    ok(inner.ok === true, 'the recovery blob opens with the code shown, to account ‖ recovery kx (kernel openRecoveryInner)')
    ok(st.b64uEnc(await rc.recoveryVerifier(parsed.code, st.b64uDec(r.saltV), argon2id)) === r.verifier, 'the stored verifier is Argon2id(code, salt_v), with its own salt')
    const all = bytesIn(record).join('|')
    const codeHex = Buffer.from(parsed.code).toString('hex')
    ok(!all.includes(codeHex) && !all.includes(st.b64uEnc(parsed.code)) && !all.includes(recoveryCode) && !all.includes(recoveryCode.replace(/-/g, '')), 'the recovery code appears NOWHERE in the stored record')
    if (inner.ok) {
      const d = inner.value.account, k = inner.value.kx
      ok(!all.includes(Buffer.from(d).toString('hex')) && !all.includes(st.b64uEnc(d)), 'nor does the raw account scalar')
      ok(!all.includes(Buffer.from(k).toString('hex')) && !all.includes(st.b64uEnc(k)), 'nor does the raw recovery kx scalar')
    }
  }
  ok(record.state === 'local', 'the new Bento ID is "local": not yet bound to an address (the directory comes next)')
}

console.log('\n— the ways back, and refusing to create one with none')
{
  const noPrf = fakePasskey(null)
  const a: any = await agent.createBentoId({}, deps({ passkey: noPrf.fn })).catch((e: any) => ({ threw: e }))
  ok(!a.threw && a.record.passkeys.length === 0 && !!a.record.recovery && !!a.recoveryCode, `a passkey without PRF gets NO blob (never a weaker wrap); the recovery code is the way back${a.threw ? ` — threw ${a.threw.name}: ${a.threw.message}` : ''}`)
  const noArgon = async () => { throw new wrap.RecoveryUnavailable() }
  const b = await agent.createBentoId({}, deps({ passkey: fakePasskey(crypto.getRandomValues(new Uint8Array(32))).fn, argon2id: noArgon }))
  ok(b.record.recovery === null && b.recoveryCode === null && b.record.passkeys.length === 1, 'a device that cannot run Argon2id at 64 MiB gets no recovery code; the passkey is the way back')
  const e = await fails(agent.createBentoId({}, deps({ passkey: noPrf.fn, argon2id: noArgon })))
  ok(e?.name === 'SetupRefused', 'neither a PRF passkey nor a recovery code: setup REFUSES (a Bento ID with no way back is lost at uninstall)')
  const other = await fails(agent.createBentoId({}, deps({ passkey: fakePasskey(null).fn, argon2id: async () => { throw new TypeError('boom') } })))
  ok(other?.name === 'TypeError', 'any other Argon2id failure stops setup (only RecoveryUnavailable means "no code on this device")')
  const cancelled = await fails(agent.createBentoId({}, deps({ passkey: async () => { throw new pk.PasskeyError('cancelled', 'x') } })))
  ok(cancelled?.code === 'cancelled', 'a cancelled passkey ceremony stops setup and returns nothing to store')
}

console.log('\n— the keystore')
{
  const db = memdb()
  const { record } = await agent.createBentoId({}, deps({ passkey: fakePasskey(crypto.getRandomValues(new Uint8Array(32))).fn }))
  ok((await ks.saveNewSelf(record, db)).ok === true && (await ks.loadSelf(db)) === record, 'a new Bento ID is stored')
  const second = await agent.createBentoId({}, deps({ passkey: fakePasskey(crypto.getRandomValues(new Uint8Array(32))).fn }))
  ok((await ks.saveNewSelf(second.record, db)).reason === 'exists' && (await ks.loadSelf(db)).accountPub === record.accountPub, 'a second setup never replaces the first')
  const extractable = { ...record, accountKey: { extractable: true } }
  ok((await ks.saveNewSelf(extractable, memdb())).reason === 'extractable key', 'a record carrying an extractable key is refused')
  for (const k of ['kxKey', 'recoveryKxKey']) ok((await ks.saveNewSelf({ ...record, [k]: { extractable: true } }, memdb())).reason === 'extractable key', `an extractable ${k} is refused`)
  ok((await ks.saveNewSelf({ ...record, v: 1 }, memdb())).reason === 'version', 'a v1 record is never stored')
  // test enrolments from before mode C are DISCARDED on load, never migrated
  const old = memdb()
  old.m.set('self', { v: 1, state: 'local', accountPub: 'x', devicePub: 'y', passkeys: [], recovery: null, dev: { text: 'dev.x', sig: 'z' } })
  ok((await ks.loadSelf(old)) === null && !old.m.has('self'), 'a stored v1 (pre-C) record reads as none, and is DELETED')
  ok((await ks.saveNewSelf(record, old)).ok === true && (await ks.loadSelf(old)) === record, 'setup then stores a fresh v2 record in its place')
  const unversioned = memdb(); unversioned.m.set('self', { state: 'local' })
  ok((await ks.loadSelf(unversioned)) === null && !unversioned.m.has('self'), 'so is a record with no version')
  const view = ks.publicView(record)
  ok(view && !('accountKey' in view) && !('deviceKey' in view) && !('recovery' in view && typeof view.recovery !== 'boolean'), 'the public view carries no key and no blob')
}

console.log('\n— the passkey ceremony (Chrome stand-ins)')
{
  const events: string[] = []
  const permissions = { request: async (o: any) => { events.push('request ' + o.origins.join()); return true } }
  const prf = crypto.getRandomValues(new Uint8Array(32))
  const credentials = {
    create: async (o: any) => { events.push(`create rp=${o.publicKey.rp.id} uv=${o.publicKey.authenticatorSelection.userVerification} rk=${o.publicKey.authenticatorSelection.residentKey} att=${o.publicKey.attestation}`); return { rawId: new Uint8Array([1, 2, 3]).buffer } },
    get: async (o: any) => { events.push(`get rp=${o.publicKey.rpId} prf=${new TextDecoder().decode(o.publicKey.extensions.prf.eval.first)} allow=${o.publicKey.allowCredentials.length}`); return { getClientExtensionResults: () => ({ prf: { results: { first: prf.buffer } } }) } },
  }
  const r = await pk.runPasskeyCeremony({ prfEval: agent.PRF_EVAL }, { permissions, credentials })
  ok(events[0] === 'request https://bento.page/*', 'it REQUESTS bento.page first, every time (never inferred from a broad grant)')
  ok(events[1] === 'create rp=bento.page uv=required rk=required att=none', 'create: rp bento.page, user verification and a discoverable credential required, no attestation')
  ok(events[2] === 'get rp=bento.page prf=bento/id/prf/v1 allow=1', 'get: the same credential, PRF over "bento/id/prf/v1"')
  ok(r.prfOutput && Buffer.from(r.prfOutput).equals(Buffer.from(prf)) && r.credentialId.length === 3, 'returns the credential id and the 32-byte PRF output')
  const noPrf = await pk.runPasskeyCeremony({ prfEval: agent.PRF_EVAL }, { permissions, credentials: { ...credentials, get: async () => ({ getClientExtensionResults: () => ({}) }) } })
  ok(noPrf.prfOutput === null, 'an authenticator without PRF → prfOutput null')
  const denied = await fails(pk.runPasskeyCeremony({ prfEval: agent.PRF_EVAL }, { permissions: { request: async () => false }, credentials }))
  ok(denied?.code === 'permission', 'bento.page access refused → a permission error, and no ceremony')
  const err = (name: string) => async () => { const e = new Error(name); e.name = name; throw e }
  ok((await fails(pk.runPasskeyCeremony({ prfEval: agent.PRF_EVAL }, { permissions, credentials: { ...credentials, create: err('NotAllowedError') } })))?.code === 'cancelled', 'NotAllowedError (cancelled, or the page lost focus) → "cancelled"')
  ok((await fails(pk.runPasskeyCeremony({ prfEval: agent.PRF_EVAL }, { permissions, credentials: { ...credentials, create: err('SecurityError') } })))?.code === 'permission', 'SecurityError → "permission", told apart from a lost focus')
}

console.log('\n— the setup page derives off its main thread')
{
  const { readFileSync } = await import('node:fs')
  const src = (f: string) => readFileSync(new URL(`../home/webext/src/${f}`, import.meta.url), 'utf8')
  const setup = src('setup.js')
  ok(/argon2idInWorker\(pw, salt\)/.test(setup) && !/from '\.\/id\/argon2\.js'/.test(setup), 'setup.js runs Argon2id through the worker, never on the page thread (measured: an in-page derivation froze the page for its whole length)')
  ok(/new Worker\(new URL\('\.\/argon2-worker\.js', import\.meta\.url\), \{ type: 'module' \}\)/.test(src('id/argon2-page.js')) && /name === 'RecoveryUnavailable'\) reject\(new RecoveryUnavailable\(\)\)/.test(src('id/argon2-page.js')), 'the worker\'s RecoveryUnavailable comes back as RecoveryUnavailable')
  ok(/password\.fill\(0\)/.test(src('id/argon2-worker.js')) && /postMessage\(\{ ok: true, key \}, \[key\.buffer\]\)/.test(src('id/argon2-worker.js')), 'the worker zeroes its copy of the code and transfers the key back')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
