// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/connect — the extension's DIRECTORY CLIENT (W1, identity-design §2e/§9):
// binding this browser's Bento ID to an email address at id.bento.page.
//
//   bindStart    sign `bind.` with the account key, ask the directory to mail a code
//   bindComplete sign `cmp.` over that bind and the code the person typed, and
//                CHECK everything the directory answers before believing it
//   retireRecovery  delete the locally held recovery material once — and only
//                once — the directory has taken it
//
// TWO PROOFS (directory README): the signature by the account key, AND a code
// mailed to the address and entered here. Neither half binds alone, so the
// answer to `start` is a uniform 202 whether or not a code was mailed.
//
// The directory is a witness, not an authority: its answer is believed only if
// the binding it returns is byte-for-byte the one we signed, verifies under
// kernel's verifyBind, and the attestation verifies under kernel's verifyAtt
// against a directory key WE hold (`directoryKeys`, shipped in the signed
// release — this module never trusts a key the directory names).
//
// Pure: fetch, time and the key list come in as deps, so scripts/
// test-webext-directory.ts runs this exact code against the real worker.

import { buildBind, verifyBind, buildCmp, verifyAtt, signStatement, sha256b64u, CERT_MAX_MS, buildDreq, dreqArg, b64uEnc } from './gen/statements.js'
import { normalizeAddress } from './gen/address.js'
import { openPrfBlob } from './gen/recovery.js'

export const DIRECTORY = 'https://id.bento.page'
/** An attestation older than this is not accepted as the answer to a request just made. */
export const ATT_MAX_AGE_MS = 10 * 60_000

export class DirectoryRefused extends Error {
  constructor(reason) { super(reason); this.reason = reason }
  get name() { return 'DirectoryRefused' }
}

const post = async (deps, path, body) => {
  const r = await deps.fetch((deps.base ?? DIRECTORY) + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let j = null
  try { j = await r.json() } catch { /* an empty body is fine */ }
  return { status: r.status, j }
}

/**
 * Step 1. Returns `{ pending }` — the exact statement and signature, to keep
 * until the code is typed. A 202 says nothing about whether mail was sent.
 */
export async function bindStart({ record, email }, deps) {
  const n = normalizeAddress(String(email ?? ''))
  if (!n.ok) throw new DirectoryRefused('bad-address')
  const address = n.address
  if (record?.state !== 'local') throw new DirectoryRefused('already-bound')
  const created = deps.now()
  const text = buildBind({
    address, accountPub: record.accountPub, kx: record.recoveryKxPub, name: null, seq: 1, prev: null,
    created, expires: created + Math.floor(CERT_MAX_MS) - 86_400_000,
  })
  const sig = await signStatement(record.accountKey, text)
  const r = await post(deps, '/v1/bind/start', { stmt: text, sig })
  if (r.status !== 202) throw new DirectoryRefused(r.status === 429 ? 'rate-limited' : `http ${r.status}`)
  return { pending: { address, text, sig, hash: await sha256b64u(text) } }
}

/**
 * Step 2. `code` is what the person typed from the mail. Returns
 * `{ ok: true, bound }` only when the directory's answer checks out.
 */
export async function bindComplete({ record, pending, code }, deps) {
  const typed = String(code ?? '').toUpperCase().replace(/[\s-]/g, '')
  const cmpText = buildCmp(pending.hash, typed)
  const r = await post(deps, '/v1/bind/complete', { email: pending.address, code: typed, sig: await signStatement(record.accountKey, cmpText) })
  if (r.status === 429) return { ok: false, reason: 'rate-limited' }
  if (r.status !== 200 || !r.j) return { ok: false, reason: 'rejected' } // the directory's 400 is uniform on purpose
  const { binding, attestation, attestationSig } = r.j
  // the directory returned exactly what we signed — not a different binding it prefers
  if (binding !== pending.text) return { ok: false, reason: 'wrong-binding' }
  const now = deps.now()
  const b = await verifyBind(pending.text, pending.sig, { now })
  if (!b.ok || b.value.accountPub !== record.accountPub || b.value.address !== pending.address) return { ok: false, reason: 'bad-binding' }
  if (typeof attestation !== 'string' || typeof attestationSig !== 'string') return { ok: false, reason: 'no-attestation' }
  const a = await verifyAtt(attestation, attestationSig, { directoryKeys: deps.directoryKeys, bindText: pending.text, now, maxAgeMs: ATT_MAX_AGE_MS })
  if (!a.ok) return { ok: false, reason: `attestation: ${a.reason}` }
  if (a.value.state !== 'active') return { ok: false, reason: `attestation: ${a.value.state}` }
  return { ok: true, bound: { address: pending.address, text: pending.text, sig: pending.sig, att: { text: attestation, sig: attestationSig, kid: a.value.kid, verifiedAt: a.value.verifiedAt }, at: now } }
}

/**
 * The recovery material the directory is to hold: the code-wrapped inner blob
 * and the verifier (identity-design §9.4). Until it has taken them, they are
 * the only copy outside the person's head, so they stay on this device.
 * `enrol(material) → { ok: true }` is the directory's ACKNOWLEDGEMENT, and the
 * only thing that lets the local copy go. A refusal, a thrown error, a network
 * failure or any answer other than ok === true keeps everything.
 */
export async function retireRecovery(db, enrol, deps) {
  const record = await db.get('self')
  const rc = record?.recovery
  if (!rc || !rc.inner) return { ok: true, already: true }
  let ack
  try { ack = await enrol({ accountPub: record.accountPub, salt: rc.salt, saltV: rc.saltV, iv: rc.iv, inner: rc.inner, verifier: rc.verifier }) } catch { return { ok: false, reason: 'enrol-failed' } }
  if (!ack || ack.ok !== true) return { ok: false, reason: 'not-acknowledged' }
  // re-read: the record may have changed while the request was in flight
  const fresh = await db.get('self')
  if (!fresh?.recovery || fresh.accountPub !== record.accountPub) return { ok: false, reason: 'record-changed' }
  await db.put('self', { ...fresh, recovery: { enrolled: deps.now() } })
  return { ok: true }
}

/**
 * Security's read-back rule: the UI may say the passkey backup is READY only
 * after the blob has been fetched BACK from the directory and unwrapped with the
 * PRF key, to this account's keys. Only a successful unwrap counts; an upload
 * ack, a fetch that returns bytes, or a blob that opens to other keys does not.
 * `fetchBlob(credentialId) → blob` is the seam (the route is D1c's).
 */
export async function passkeyBackupReady({ record, credentialId, prfOutput, fetchBlob }) {
  let blob
  try { blob = await fetchBlob(credentialId) } catch { return { ready: false, reason: 'fetch-failed' } }
  if (!blob) return { ready: false, reason: 'no-blob' }
  let r
  try { r = await openPrfBlob(blob, { prfOutput, credentialId, expected: { accountPub: record.accountPub, kxPub: record.recoveryKxPub } }) } catch { return { ready: false, reason: 'unwrap-failed' } }
  return r && r.ok === true ? { ready: true } : { ready: false, reason: 'unwrap-failed' }
}

// --- the key-store routes (D1c: /v1/challenge, /v1/recovery/enrol, /v1/cred/*) ---------

/** A consent challenge for `email` (audience `dir`): good at that address for 60 s, spent by one use. */
export async function dirChallenge(email, deps) {
  const r = await post(deps, '/v1/challenge', { email })
  if (r.status !== 200 || typeof r.j?.challenge !== 'string') throw new DirectoryRefused(r.status === 429 ? 'rate-limited' : `http ${r.status}`)
  return r.j.challenge
}

/**
 * An account-signed request (`dreq.`) for one op, on a fresh challenge, over the
 * binding that is bound. `subject` carries the op's bytes (Uint8Arrays).
 * `deps.consent({ op, challenge, req }) → consent` supplies the consent the op
 * needs (cred-add, rc-enrol): a native `cns.` or a WebAuthn assertion. This
 * module does not mint consent: the light tier has no consent key (dev.
 * consentPub is null), so it can only be the WebAuthn form, from a credential
 * the directory already holds.
 */
export async function signedRequest({ record, subject }, deps) {
  if (record?.state !== 'bound' || !record.bind?.text) throw new DirectoryRefused('not-bound')
  const email = record.bind.address
  const challenge = await dirChallenge(email, deps)
  const req = buildDreq({ op: subject.op, address: email, bindHash: await sha256b64u(record.bind.text), challenge, arg: await dreqArg(subject) })
  const sig = await signStatement(record.accountKey, req)
  return { email, req, sig, challenge, consent: deps.consent ? await deps.consent({ op: subject.op, challenge, req }) : null }
}

const reasonOf = (r) => (typeof r.j?.reason === 'string' ? r.j.reason : r.status === 429 ? 'rate-limited' : `http ${r.status}`)

/**
 * The real `enrol` seam for retireRecovery: POST /v1/recovery/enrol with a
 * `dreq.rc-enrol` over the exact body. `{ ok: true }` only on the directory's 200.
 */
export const directoryEnrol = ({ record }, deps) => async (m) => {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, saltV: m.saltV, verifier: m.verifier, saltW: m.salt, iv: m.iv, ct: m.inner }))
  const body = b64uEnc(bytes)
  const q = await signedRequest({ record, subject: { op: 'rc-enrol', body: bytes } }, deps)
  const r = await post(deps, '/v1/recovery/enrol', { ...q, body })
  return r.status === 200 ? { ok: true } : { ok: false, reason: reasonOf(r) }
}

/**
 * The real `fetchBlob` seam for passkeyBackupReady: one WebAuthn ceremony on a
 * single-use challenge. `deps.assert(credentialId, challenge) → assertion` is
 * the browser's navigator.credentials.get (or a rig's software key).
 * Returns the stored blob, or null on any refusal.
 */
export const directoryFetchBlob = (deps) => async (credentialId) => {
  const c = await post(deps, '/v1/cred/challenge', {})
  if (c.status !== 200 || typeof c.j?.challenge !== 'string') return null
  const r = await post(deps, '/v1/cred/get', { challenge: c.j.challenge, assertion: await deps.assert(credentialId, c.j.challenge) })
  return r.status === 200 && r.j?.blob ? r.j.blob : null
}
