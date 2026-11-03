#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// home/webext — the directory client against a LOCAL directory over real HTTP (manual).
//
//   WRANGLER=/path/to/wrangler [DIRECTORY_DIR=<server/directory with the key-store routes>] node scripts/qa-webext-directory-dev.mjs
//
// Part 2 (key store) needs a directory that has /v1/challenge, /v1/recovery/enrol and /v1/cred/* (D1c).
//
// scripts/test-webext-directory.ts drives the same client against the worker in
// memory (that one runs in CI). This one starts `wrangler dev` on server/directory
// with a throwaway signing key, a log mailer and an empty state directory, then
// runs the extension's own bindStart/bindComplete across the network: the mailed
// code is read from the worker's dev log, exactly as a person would read an inbox.
// Needs wrangler (`npm i wrangler` in a scratch dir; no wrangler is a dependency here).

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { argon2 as nodeArgon2 } from 'node:crypto'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const agent = await import(join(root, 'home/webext/src/id/agent.js'))
const dc = await import(join(root, 'home/webext/src/id/directory.js'))
const ks = await import(join(root, 'home/webext/src/id/keystore.js'))
const st = await import(join(root, 'home/webext/src/id/gen/statements.js'))

let failures = 0
const ok = (c, m) => { if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }
const argon2id = (p, s) => new Promise((res, rej) => nodeArgon2('argon2id', { message: p, nonce: s, parallelism: 1, tagLength: 32, memory: 65536, passes: 3 }, (e, k) => (e ? rej(e) : res(new Uint8Array(k)))))

const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey)
const dirPub = st.b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)))
const port = 8700 + Math.floor(Math.random() * 200)
const wr = process.env.WRANGLER ?? 'wrangler'
const child = spawn(wr, ['dev', '--port', String(port), '--persist-to', mkdtempSync(join(tmpdir(), 'dir-state-')), '--var', 'DEV:1', '--var', 'MAILER:log', '--var', 'DIR_KID:dev-1', '--var', 'KEYSTORE:1', '--var', `PEPPER_V1:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`, '--var', 'CHALLENGE_KEY:qa-challenge-secret-0123456789abcdef', '--var', `DIR_KEY_JWK:${JSON.stringify(jwk)}`], { cwd: process.env.DIRECTORY_DIR ?? join(root, 'server/directory'), stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { log += d })
const stop = () => { child.kill('SIGTERM') }
process.on('exit', stop)
const t0 = Date.now()
while (!/Ready on/.test(log)) {
  if (Date.now() - t0 > 60000 || child.exitCode !== null) { console.error('FAIL: wrangler dev did not start:\n' + log.slice(-800)); process.exit(2) }
  await new Promise((r) => setTimeout(r, 200))
}
const codeFor = async (to) => {
  for (let i = 0; i < 50; i++) {
    const hits = [...log.matchAll(/\{"devmail":(\{.*?\})\}/g)].map((m) => JSON.parse(m[1])).filter((m) => m.to === to)
    const last = hits.at(-1)
    if (last) return /\b([2-9A-HJKMNP-Z]{8})\b/.exec(last.body.split('\n').find((l) => /[2-9A-HJKMNP-Z]{8}/.test(l)) ?? '')?.[1]
    await new Promise((r) => setTimeout(r, 100))
  }
}
const base = `http://localhost:${port}`
const deps = { fetch: (u, i) => fetch(u, i), now: () => Date.now(), directoryKeys: { 'dev-1': dirPub }, base }

const { record } = await agent.createBentoId({ label: 'qa' }, { subtle: crypto.subtle, rand: (n) => crypto.getRandomValues(new Uint8Array(n)), now: () => Date.now(), argon2id,
  passkey: async () => ({ credentialId: crypto.getRandomValues(new Uint8Array(32)), prfOutput: crypto.getRandomValues(new Uint8Array(32)) }) })
const { pending } = await dc.bindStart({ record, email: 'qa@example.com' }, deps)
const code = await codeFor('qa@example.com')
ok(!!code, `the worker mailed a code (read from its dev log): ${code ? code.slice(0, 2) + '******' : 'none'}`)
ok((await dc.bindComplete({ record, pending, code: 'AAAAAAAA' }, deps)).reason === 'rejected', 'a wrong code is refused over HTTP')
const done = await dc.bindComplete({ record, pending, code }, deps)
ok(done.ok === true, `the right code completes it; kernel verifyBind + verifyAtt passed against the dev key (${done.reason ?? done.bound.att.kid})`)
const lk = await (await fetch(`${base}/v1/lookup?e=qa@example.com`)).json()
ok(lk.binding === pending.text, 'a lookup over HTTP returns the binding we signed')
const nothing = await fetch(`${base}/v1/lookup?e=nobody@example.com`)
ok(nothing.status === 404, 'an unknown address is 404')

// ---------------------------------------------------------------------------------
// part 2: the key-store routes (D1c), the REAL ones, over HTTP
// ---------------------------------------------------------------------------------
const enc = (t) => new TextEncoder().encode(t)
const sha = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b))
const ORIGIN = 'https://bento.page'
const cborEnc = (v) => {
  const head = (major, n) => n < 24 ? [major << 5 | n] : n < 256 ? [major << 5 | 24, n] : [major << 5 | 25, n >> 8, n & 255]
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (typeof v === 'string') { const b = enc(v); return [...head(3, b.length), ...b] }
  if (v instanceof Uint8Array) return [...head(2, v.length), ...v]
  if (v instanceof Map) return [...head(5, v.size), ...[...v.entries()].flatMap(([k, x]) => [...cborEnc(k), ...cborEnc(x)])]
  throw new Error('cbor')
}
// a software authenticator standing in for the browser's passkey (the page-side ceremony is not what is measured here)
const soft = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const softRaw = new Uint8Array(await crypto.subtle.exportKey('raw', soft.publicKey))
const toDer = (raw) => {
  const int = (v) => { let i = 0; while (i < 31 && v[i] === 0) i++; v = v.slice(i); return v[0] & 0x80 ? Uint8Array.of(0, ...v) : v }
  const r = int(raw.slice(0, 32)), s2 = int(raw.slice(32))
  return Uint8Array.of(0x30, r.length + s2.length + 4, 0x02, r.length, ...r, 0x02, s2.length, ...s2)
}
const assertionFor = async (key, credId, challenge) => {
  const ad = new Uint8Array(37); ad.set(await sha(enc('bento.page'))); ad[32] = 0x05
  const cdj = enc(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN }))
  const signed = new Uint8Array(ad.length + 32); signed.set(ad); signed.set(await sha(cdj), ad.length)
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signed))
  return { credentialId: st.b64uEnc(credId), authenticatorData: st.b64uEnc(ad), clientDataJSON: st.b64uEnc(cdj), signature: st.b64uEnc(toDer(raw)) }
}
const registrationFor = async (credId, challenge) => {
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, softRaw.slice(1, 33)], [-3, softRaw.slice(33)]])
  const ad = Uint8Array.from([...(await sha(enc('bento.page'))), 0x4d, 0, 0, 0, 0, ...new Uint8Array(16), 0, credId.length, ...credId, ...cborEnc(cose)])
  return { att: Uint8Array.from(cborEnc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]))), cdj: enc(JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN })) }
}

// a fresh, BOUND account whose passkey (credential id + PRF output) the rig knows
const credId = crypto.getRandomValues(new Uint8Array(32)), prfOutput = crypto.getRandomValues(new Uint8Array(32))
const fresh = await agent.createBentoId({ label: 'qa2' }, { subtle: crypto.subtle, rand: (n) => crypto.getRandomValues(new Uint8Array(n)), now: () => Date.now(), argon2id, passkey: async () => ({ credentialId: credId, prfOutput: prfOutput.slice() }) }) // a copy: createBentoId wipes what it is given
const p2 = await dc.bindStart({ record: fresh.record, email: 'qa2@example.com' }, deps)
const c2 = await codeFor('qa2@example.com')
const d2 = await dc.bindComplete({ record: fresh.record, pending: p2.pending, code: c2 }, deps)
ok(d2.ok === true, 'a second account is bound over HTTP')
const me = { ...fresh.record, state: 'bound', bind: d2.bound }
const dbm = new Map([['self', me]])
const db = { get: async (k) => dbm.get(k), put: async (k, v) => { dbm.set(k, v) } }
const hadRc = !!me.recovery?.inner

ok(typeof await dc.dirChallenge('qa2@example.com', deps) === 'string', '/v1/challenge issues a dir challenge')

// (1) the extension is the LIGHT tier: dev. has no consent key. With no passkey registered at the directory it has NO consent to give.
{
  const r = await dc.retireRecovery(db, dc.directoryEnrol({ record: me }, { ...deps, consent: null }), { now: () => Date.now() })
  ok(r.ok === false && !!(await db.get('self')).recovery?.inner, `first recovery enrol with no consent → refused by the real route, local material KEPT (${r.reason})`)
  const lightConsent = async ({ challenge, req }) => {
    const transcript = await st.consentTranscript('dir', challenge, req)
    const cns = st.buildConsent({ rp: 'bento', purpose: 'rc-enrol', docId: null, transcript, exp: Date.now() + 2 * 60_000 })
    return { webauthn: await assertionFor(soft.privateKey, credId, await st.webauthnChallengeFor(cns)), exp: Date.now() + 2 * 60_000 }
  }
  const r2 = await dc.retireRecovery(db, dc.directoryEnrol({ record: me }, { ...deps, consent: lightConsent }), { now: () => Date.now() })
  ok(r2.ok === false && !!(await db.get('self')).recovery?.inner, `…and a WebAuthn consent from a passkey the directory does not hold yet is refused too, material KEPT (${r2.reason}) — the bootstrap gap`)

  // (2) BOOTSTRAP, rig-only: a device with a consent key (what a native host has and the extension does not) registers the passkey
  const devKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const cnsKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const rawOf = async (k) => st.b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', k)))
  const devText = st.buildDev({ devicePub: await rawOf(devKey.publicKey), consentPub: await rawOf(cnsKey.publicKey), accountPub: me.accountPub, kx: me.kxPub, label: null, created: Date.now(), expires: Date.now() + 86_400_000 })
  const devSig = await st.signStatement(me.accountKey, devText)
  const nativeConsent = (purpose) => async ({ challenge, req }) => {
    const cns = st.buildConsent({ rp: 'bento', purpose, docId: null, transcript: await st.consentTranscript('dir', challenge, req), exp: Date.now() + 2 * 60_000 })
    return { dev: devText, devSig, cns, cnsSig: await st.signStatement(cnsKey.privateKey, cns) }
  }
  // cred-add: the registration ceremony's challenge IS the dir challenge the request spends
  const ch = await dc.dirChallenge('qa2@example.com', deps)
  const r0 = await registrationFor(credId, ch)
  const req = st.buildDreq({ op: 'cred-add', address: 'qa2@example.com', bindHash: await st.sha256b64u(me.bind.text), challenge: ch, arg: await st.dreqArg({ op: 'cred-add', attestationObject: r0.att, clientDataJSON: r0.cdj }) })
  const sig = await st.signStatement(me.accountKey, req)
  const add = await fetch(`${base}/v1/cred/add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'qa2@example.com', req, sig, challenge: ch, consent: await nativeConsent('cred-add')({ challenge: ch, req }), attestationObject: st.b64uEnc(r0.att), clientDataJSON: st.b64uEnc(r0.cdj), blob: me.passkeys[0].blob, attachment: 'platform', devicePub: me.devicePub }) })
  const addBody = add.status === 200 ? '' : await add.text()
  ok(add.status === 200, `(rig bootstrap, native consent) /v1/cred/add registers the passkey and its PRF blob (${add.status} ${addBody})`)

  // (3) the real fetch + the read-back
  const fetchBlob = dc.directoryFetchBlob({ ...deps, assert: (id, c) => assertionFor(soft.privateKey, credId, c) })
  const good = await dc.passkeyBackupReady({ record: me, credentialId: credId, prfOutput, fetchBlob })
  ok(good.ready === true, 'POSITIVE CONTROL: passkeyBackupReady → ready after a real /v1/cred/challenge + /v1/cred/get and an unwrap with the PRF key')
  const wrong = await dc.passkeyBackupReady({ record: me, credentialId: credId, prfOutput: crypto.getRandomValues(new Uint8Array(32)), fetchBlob })
  ok(wrong.ready === false && wrong.reason === 'unwrap-failed', 'wrong PRF output → not ready (the blob was fetched, and did not open)')
  const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const bad = await dc.passkeyBackupReady({ record: me, credentialId: credId, prfOutput, fetchBlob: dc.directoryFetchBlob({ ...deps, assert: (id, c) => assertionFor(other.privateKey, credId, c) }) })
  ok(bad.ready === false && bad.reason === 'no-blob', 'an assertion by another key → the directory refuses the fetch → not ready')
  const gone = await dc.passkeyBackupReady({ record: me, credentialId: credId, prfOutput, fetchBlob: dc.directoryFetchBlob({ ...deps, base: 'http://localhost:1', assert: (id, c) => assertionFor(soft.privateKey, credId, c) }) })
  ok(gone.ready === false, `an unreachable directory → not ready (${gone.reason})`)

  // (4) the light tier's steady state: with a passkey held, WebAuthn consent now enrols the recovery code
  const r3 = await dc.retireRecovery(db, dc.directoryEnrol({ record: me }, { ...deps, consent: lightConsent }), { now: () => Date.now() })
  ok(hadRc && r3.ok === true && !(await db.get('self')).recovery?.inner, 'recovery enrol with WebAuthn consent from the held passkey → 200; the local material goes ONLY now')
}

stop()
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
