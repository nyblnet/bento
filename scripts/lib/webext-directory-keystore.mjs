// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// home/webext — the directory client on the key-store routes (D1c): ONE set of rows, run by
// scripts/test-webext-directory.ts against the worker in memory (CI) and by
// scripts/qa-webext-directory-dev.mjs over real HTTP (manual). Only the transport differs: `deps.fetch`.
//
// The extension is the LIGHT tier: dev. has no consent key. Setup goes PASSKEY FIRST, under the directory's
// setup allowance (absent consent, 15 min after the two-proof bind, empty account, once); the code then goes
// in by the new passkey's ordinary WebAuthn consent.

const agent = await import('../../home/webext/src/id/agent.js')
const dc = await import('../../home/webext/src/id/directory.js')
const st = await import('../../home/webext/src/id/gen/statements.js')

const enc = (t) => new TextEncoder().encode(t)
const sha = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b))
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n))
const EC = { name: 'ECDSA', namedCurve: 'P-256' }
const ORIGIN = 'https://bento.page'

const cborEnc = (v) => {
  const head = (major, n) => n < 24 ? [major << 5 | n] : n < 256 ? [major << 5 | 24, n] : [major << 5 | 25, n >> 8, n & 255]
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (typeof v === 'string') { const b = enc(v); return [...head(3, b.length), ...b] }
  if (v instanceof Uint8Array) return [...head(2, v.length), ...v]
  if (v instanceof Map) return [...head(5, v.size), ...[...v.entries()].flatMap(([k, x]) => [...cborEnc(k), ...cborEnc(x)])]
  throw new Error('cbor')
}
const toDer = (raw) => {
  const int = (v) => { let i = 0; while (i < 31 && v[i] === 0) i++; v = v.slice(i); return v[0] & 0x80 ? Uint8Array.of(0, ...v) : v }
  const r = int(raw.slice(0, 32)), s = int(raw.slice(32))
  return Uint8Array.of(0x30, r.length + s.length + 4, 0x02, r.length, ...r, 0x02, s.length, ...s)
}
// a software authenticator standing in for the browser's passkey (the page-side ceremony is not what is measured here)
const assertionFor = async (key, credId, challenge) => {
  const ad = new Uint8Array(37); ad.set(await sha(enc('bento.page'))); ad[32] = 0x05
  const cdj = enc(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN }))
  const signed = new Uint8Array(ad.length + 32); signed.set(ad); signed.set(await sha(cdj), ad.length)
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signed))
  return { credentialId: st.b64uEnc(credId), authenticatorData: st.b64uEnc(ad), clientDataJSON: st.b64uEnc(cdj), signature: st.b64uEnc(toDer(raw)) }
}
const registrationFor = async (pubRaw, credId, challenge) => {
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, pubRaw.slice(1, 33)], [-3, pubRaw.slice(33)]])
  const ad = Uint8Array.from([...(await sha(enc('bento.page'))), 0x4d, 0, 0, 0, 0, ...new Uint8Array(16), 0, credId.length, ...credId, ...cborEnc(cose)])
  return { att: Uint8Array.from(cborEnc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]))), cdj: enc(JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN })) }
}
// A clock that never reads the same twice, so reading it twice can never pass by luck: a consent that hashes
// one `exp` and sends another is red on every run, not one run in many.
const tickingClock = () => { let t = 0; return () => (t = Math.max(t + 1, Date.now())) }

/**
 * @param o.ok      (cond, message) the calling rig's row
 * @param o.deps    { fetch, now, directoryKeys, base } reaching the directory under test
 * @param o.codeFor (address) → the mailed code, or a promise of it
 * @param o.argon2id the calling rig's argon2id
 */
export async function keyStoreRows({ ok, deps, codeFor, argon2id }) {
  const newRecord = (label, credentialId, prfOutput) => agent.createBentoId({ label }, { subtle: crypto.subtle, rand: rnd, now: () => Date.now(), argon2id, passkey: async () => ({ credentialId, prfOutput }) })
  const soft = await crypto.subtle.generateKey(EC, true, ['sign', 'verify'])
  const softRaw = new Uint8Array(await crypto.subtle.exportKey('raw', soft.publicKey))
  const other = await crypto.subtle.generateKey(EC, true, ['sign', 'verify'])

  // a fresh, BOUND account whose passkey (credential id + PRF output) the rig knows
  const credId = rnd(32), prfOutput = rnd(32)
  const fresh = await newRecord('qa2', credId, prfOutput.slice()) // a copy: createBentoId wipes what it is given
  const p2 = await dc.bindStart({ record: fresh.record, email: 'qa2@example.com' }, deps)
  const d2 = await dc.bindComplete({ record: fresh.record, pending: p2.pending, code: await codeFor('qa2@example.com') }, deps)
  ok(d2.ok === true, 'a second account is bound')
  const me = { ...fresh.record, state: 'bound', bind: d2.bound }
  const dbm = new Map([['self', me]])
  const db = { get: async (k) => dbm.get(k), put: async (k, v) => { dbm.set(k, v) } }
  const hadRc = !!me.recovery?.inner

  ok(typeof await dc.dirChallenge('qa2@example.com', deps) === 'string', '/v1/challenge issues a dir challenge')

  // the REAL deps.consent, with a software authenticator behind its assert seam
  const consentBy = (key) => dc.webauthnConsent({ credentialId: credId }, { now: tickingClock(), assert: (id, c) => assertionFor(key, id, c) })
  const lightConsent = consentBy(soft.privateKey)
  let enrolPosts = 0
  const counting = { ...deps, fetch: (u, i) => { if (String(u).endsWith('/v1/recovery/enrol')) enrolPosts++; return deps.fetch(u, i) } }
  const register = (rid, blob) => async (challenge) => { const r = await registrationFor(softRaw, rid, challenge); return { attestationObject: r.att, clientDataJSON: r.cdj, blob, attachment: 'platform' } }

  // (1) CODE FIRST is refused on this tier, before anything is sent
  enrolPosts = 0
  const r1 = await dc.retireRecovery(db, dc.directoryEnrol({ record: me }, { ...counting, consent: null }), { now: () => Date.now() })
  ok(hadRc && r1.ok === false && enrolPosts === 0 && !!(await db.get('self')).recovery?.inner, `a code before any passkey is refused locally, nothing sent, material KEPT (${r1.reason})`)

  // (2) a passkey that does not land: nothing else is attempted, material kept (a third account, whose allowance this uses up)
  {
    const f = await newRecord('qa3', rnd(32), rnd(32))
    const p3 = await dc.bindStart({ record: f.record, email: 'qa3@example.com' }, deps)
    const d3 = await dc.bindComplete({ record: f.record, pending: p3.pending, code: await codeFor('qa3@example.com') }, deps)
    const rec3 = { ...f.record, state: 'bound', bind: d3.bound }
    const m3 = new Map([['self', rec3]])
    const db3 = { get: async (k) => m3.get(k), put: async (k, v) => { m3.set(k, v) } }
    const wrongCeremony = async () => { const r = await registrationFor(softRaw, credId, 'AAAA'); return { attestationObject: r.att, clientDataJSON: r.cdj, blob: rec3.passkeys[0].blob, attachment: 'platform' } }
    enrolPosts = 0
    const fc = await dc.firstCredentials({ db: db3 }, { ...counting, register: wrongCeremony, consent: lightConsent })
    ok(d3.ok === true && fc.ok === false && fc.step === 'passkey' && enrolPosts === 0 && !!m3.get('self').recovery?.inner, `a registration the directory rejects → step 'passkey' (${fc.reason}); NO code was attempted and the local material is KEPT`)
  }

  // (3) the real order: passkey with ABSENT consent, then a code by that passkey. A bad consent on the code is refused and the material (present beforehand) is kept.
  enrolPosts = 0
  const fcBad = await dc.firstCredentials({ db }, { ...counting, register: register(credId, me.passkeys[0].blob), consent: consentBy(other.privateKey) })
  ok(fcBad.passkey === true && fcBad.step === 'code' && enrolPosts === 1 && !!(await db.get('self')).recovery?.inner, `passkey lands with no consent; a code carrying another key's assertion is refused (${fcBad.reason}) and the material is KEPT (it was present: ${hadRc})`)
  // the exp the assertion hashed and the exp sent must be one number: the directory rebuilds the cns. from the one sent
  const rc = (await db.get('self')).recovery
  const drifted = await dc.directoryEnrol({ record: me }, { ...deps, consent: async (a) => { const c = await lightConsent(a); return { ...c, exp: c.exp + 1 } } })({ salt: rc.salt, saltV: rc.saltV, iv: rc.iv, inner: rc.inner, verifier: rc.verifier })
  ok(drifted.ok === false && /webauthn:challenge/.test(drifted.reason), `CONTROL: an exp one millisecond off the hashed one is refused (${drifted.reason}), so the row below is what proves one exp`)
  const r3 = await dc.retireRecovery(db, dc.directoryEnrol({ record: me }, { ...deps, consent: lightConsent }), { now: () => Date.now() })
  ok(hadRc && r3.ok === true && !(await db.get('self')).recovery?.inner, `the code by the new passkey's WebAuthn consent → 200; the local material goes ONLY now (${r3.reason ?? 'ok'})`)

  // (4) the allowance was for ONE passkey: a second cred-add with no consent is refused
  const again = await dc.directoryCredAdd({ record: me }, { ...deps, register: register(rnd(32), me.passkeys[0].blob) })()
  ok(again.ok === false, `a second passkey with no consent is refused (${again.reason})`)

  // (5) the real fetch + the read-back
  const fetchBlob = dc.directoryFetchBlob({ ...deps, assert: (id, c) => assertionFor(soft.privateKey, id, c) })
  const good = await dc.passkeyBackupReady({ record: me, credentialId: credId, prfOutput, fetchBlob })
  ok(good.ready === true, 'POSITIVE CONTROL: passkeyBackupReady → ready after a real /v1/cred/challenge + /v1/cred/get and an unwrap with the PRF key')
  const wrong = await dc.passkeyBackupReady({ record: me, credentialId: credId, prfOutput: rnd(32), fetchBlob })
  ok(wrong.ready === false && wrong.reason === 'unwrap-failed', 'wrong PRF output → not ready (the blob was fetched, and did not open)')
  const bad = await dc.passkeyBackupReady({ record: me, credentialId: credId, prfOutput, fetchBlob: dc.directoryFetchBlob({ ...deps, assert: (id, c) => assertionFor(other.privateKey, id, c) }) })
  ok(bad.ready === false && bad.reason === 'no-blob', 'an assertion by another key → the directory refuses the fetch → not ready')
  const gone = await dc.passkeyBackupReady({ record: me, credentialId: credId, prfOutput, fetchBlob: dc.directoryFetchBlob({ ...deps, fetch: async () => { throw new TypeError('fetch failed') }, assert: (id, c) => assertionFor(soft.privateKey, id, c) }) })
  ok(gone.ready === false, `an unreachable directory → not ready (${gone.reason})`)
}
