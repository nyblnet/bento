#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Generates kernel/fixtures/recovery-v1.json — the bento/id recovery-code and
// key-blob conformance vectors (identity-design §2f, security §28).
//
//   node scripts/gen-recovery-vectors.ts
//
// Unlike the statement vectors, every row here is DETERMINISTIC: fixed codes,
// salts and IVs, so every host (Swift, Kotlin, Rust, the extension's WASM, and the
// directory) must reproduce the exact bytes, end to end. The keys are TEST KEYS.

import { argon2 as nodeArgon2 } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ARGON2, formatRecoveryCode, parseRecoveryCode, recoveryWrapKey, recoveryVerifier, prfKek,
  sealPrfBlob, sealRecoveryInner, pepperKeys, pepperVerifierTag, pepperSeal, publicKeyOf, PRF_INPUT, prfHmacSecretSalt, type Argon2id,
} from '../kernel/src/recovery.ts'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel/fixtures/recovery-v1.json')
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const bytes = (n: number, f: (i: number) => number) => Uint8Array.from({ length: n }, (_, i) => f(i) & 0xff)

const argon2: Argon2id = (password, salt) => new Promise((res, rej) => nodeArgon2('argon2id', {
  message: password, nonce: salt, parallelism: ARGON2.parallelism, tagLength: ARGON2.tagLength,
  memory: ARGON2.memoryKiB, passes: ARGON2.passes,
}, (e, k) => (e ? rej(e) : res(new Uint8Array(k)))))

// RFC 9106 §5.3: hosts check their Argon2id against the standard before trusting it
const rfc9106 = {
  note: 'RFC 9106 §5.3 Argon2id (NOT our parameters): validates the primitive itself',
  password: hex(bytes(32, () => 1)), salt: hex(bytes(16, () => 2)), secret: hex(bytes(8, () => 3)), ad: hex(bytes(12, () => 4)),
  memoryKiB: 32, passes: 3, parallelism: 4, tagLength: 32,
  tag: '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659',
}

// --- codes: one per check symbol, including the five extra ones ----------------------
const codes: Record<string, unknown>[] = []
const want = new Set('0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U'.split(''))
for (let seed = 0; want.size > 0 && seed < 100000; seed++) {
  const code = bytes(10, (i) => (seed * 2654435761 + i * 40503) >>> (i % 3) * 8)
  const printed = formatRecoveryCode(code)
  const check = printed.slice(-1)
  if (!want.has(check)) continue
  // keep every extra symbol, and a handful of ordinary ones
  if ('*~$=U'.includes(check) || codes.length < 8) codes.push({ bytes: hex(code), printed, check })
  want.delete(check)
}
for (const c of ['*', '~', '$', '=', 'U']) if (!codes.some((r) => r.check === c)) throw new Error(`no code with check ${c}`)

const base = codes[0] as { bytes: string; printed: string }
const p = base.printed
const parse: Record<string, unknown>[] = [
  { input: p, bytes: base.bytes, note: 'as printed' },
  { input: p.toLowerCase(), bytes: base.bytes, note: 'lowercase' },
  { input: p.replace(/-/g, ''), bytes: base.bytes, note: 'no separators' },
  { input: ` ${p.replace(/-/g, ' ')} `, bytes: base.bytes, note: 'spaces instead of hyphens, and around it' },
]
// O→0 and I/L→1, when the code has a 0 or a 1 to substitute
const data = p.replace(/-/g, '').slice(0, 16)
if (data.includes('0')) parse.push({ input: p.replace('0', 'O'), bytes: base.bytes, note: 'O typed for 0' })
if (data.includes('1')) parse.push({ input: p.replace('1', 'L'), bytes: base.bytes, note: 'L typed for 1' }, { input: p.replace('1', 'I'), bytes: base.bytes, note: 'I typed for 1' })
for (const c of codes) parse.push({ input: c.printed, bytes: c.bytes, note: `check symbol ${c.check}` })
const wrongCheck = p.slice(0, -1) + (p.endsWith('0') ? '1' : '0')
parse.push(
  { input: wrongCheck, reason: 'check', note: 'a wrong check symbol (a typo) is refused locally' },
  { input: p.slice(0, 4) + p.slice(5, 9) + p.slice(10, 14) + p.slice(15, 18) + p.slice(-1), reason: 'length', note: 'a data symbol missing' },
  { input: p + '0', reason: 'length', note: 'one symbol too many' },
  { input: 'U' + p.slice(1), reason: 'character', note: 'U is valid only as the check symbol' },
  { input: p.slice(0, -1) + '#', reason: 'character', note: 'not a Crockford symbol' },
)
// sanity: the reference agrees with every row it is about to publish
for (const r of parse) {
  const got = parseRecoveryCode(r.input as string)
  const ok = r.bytes ? got.ok && hex(got.code) === r.bytes : !got.ok && got.reason === r.reason
  if (!ok) throw new Error(`parse row disagrees: ${JSON.stringify(r)}`)
}

// --- derivations -----------------------------------------------------------------------
const code = Uint8Array.from(Buffer.from(base.bytes, 'hex'))
const salt = bytes(16, (i) => 0x10 + i), saltV = bytes(16, (i) => 0x40 + i)
const A = await argon2(code, salt)
const derivations = {
  code: base.bytes, salt: hex(salt), saltV: hex(saltV),
  argon2_A: hex(A),
  wrapKey: hex(await recoveryWrapKey(code, salt, argon2)),
  verifier: hex(await recoveryVerifier(code, saltV, argon2)),
  prf: { output: hex(bytes(32, (i) => 0xa0 + i)), salt: hex(bytes(32, (i) => 0x70 + i)) },
  prfKek: '',
}
derivations.prfKek = hex(await prfKek(bytes(32, (i) => 0xa0 + i), bytes(32, (i) => 0x70 + i)))

// --- the PRF input, and the CTAP hmac-secret salt for hosts without a PRF API -------------
// WebAuthn L3 §10.1.4. The two "wrong" values are the easy mistakes, published so
// a host can see it has made one rather than silently sealing unopenable blobs.
const sha256hex = async (b: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource)))
const prfInputBytes = new TextEncoder().encode(PRF_INPUT)
const label = new TextEncoder().encode('WebAuthn PRF')
const prf = {
  note: 'The PRF extension evaluates input = UTF-8(prfInput). A host speaking CTAP hmac-secret directly ' +
    '(no WebAuthn PRF API) sends hmacSecretSalt = SHA-256(UTF-8("WebAuthn PRF") ‖ 0x00 ‖ input) (WebAuthn L3 §10.1.4), ' +
    'so the authenticator returns the same 32 bytes a browser gets. Browsers apply this themselves: never twice.',
  prfInput: PRF_INPUT,
  inputHex: hex(prfInputBytes),
  hmacSecretSalt: hex(await prfHmacSecretSalt()),
  wrong: {
    noSeparator: await sha256hex(Uint8Array.from([...label, ...prfInputBytes])),
    rawInputHash: await sha256hex(prfInputBytes),
    rawInput: hex(prfInputBytes),
  },
}

// --- whole blobs (end to end) --------------------------------------------------------------
// Test keys are DETERMINISTIC (fixed scalars), so regenerating this file changes
// nothing unless a rule changes: porters can build against stable bytes.
async function testKey(name: string) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`bento/id test key ${name}`)))
  const pub = publicKeyOf(d)
  if (!pub) throw new Error(`test scalar for ${name} out of range`)
  return { d, pub }
}
const account = await testKey('account'), kx = await testKey('kx'), other = await testKey('other')
const credentialId = bytes(16, (i) => 0xc0 + i)
const prfOutput = bytes(32, (i) => 0xa0 + i), prfSalt = bytes(32, (i) => 0x70 + i), iv = bytes(12, (i) => 0x20 + i)
const wrapKey = await recoveryWrapKey(code, salt, argon2)
const both = { account: account.d, kx: kx.d }
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length } return o }

// A blob of the WRONG length, sealed correctly under the right key and aad, so a
// host must refuse it on length AFTER a successful decrypt (packScalars itself
// refuses to make one: a 32-byte account-only blob is what every pre-C enrolment
// sealed, and under mode C it is refused, never read as a partial key set).
async function sealRaw(key: Uint8Array, aad: string, pt: Uint8Array): Promise<string> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt'])
  return hex(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: new TextEncoder().encode(aad) as BufferSource, tagLength: 128 }, k, pt as BufferSource)))
}
const cred = Buffer.from(new Uint8Array(await crypto.subtle.digest('SHA-256', credentialId as BufferSource))).toString('base64url')
const rcAad = `bento/id/rc-wrap/v1.${Buffer.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(account.pub)))).toString('base64url')}`
const prfAad = `bento/id/acct-wrap/v1.${cred}`
const kek = await prfKek(prfOutput, prfSalt)
const wrongLength = (seal: (pt: Uint8Array) => Promise<string>) => Promise.all([
  { name: 'a 32-byte account-only blob (every pre-C enrolment)', pt: account.d },
  { name: 'a 63-byte blob (one byte short)', pt: cat(account.d, kx.d).slice(0, 63) },
  { name: 'a 65-byte blob (one byte over)', pt: cat(account.d, kx.d, Uint8Array.of(0)) },
  { name: 'a 96-byte blob (a third scalar)', pt: cat(account.d, kx.d, other.d) },
].map(async (r) => ({ name: r.name, ct: await seal(r.pt), expect: 'reject', reason: 'length' })))

const blobs = {
  keys: { accountD: hex(account.d), accountPub: account.pub, kxD: hex(kx.d), kxPub: kx.pub, otherD: hex(other.d) },
  prf: {
    blob: await sealPrfBlob({ prfOutput, credentialId, salt: prfSalt, iv, keys: both }),
    inputs: { prfOutput: hex(prfOutput), credentialId: hex(credentialId), salt: hex(prfSalt), iv: hex(iv) },
    /** ct (hex) to put in place of blob.ct: each decrypts, then must be refused on length */
    wrongLength: await wrongLength((pt) => sealRaw(kek, prfAad, pt)),
  },
  recovery: {
    inputs: { code: base.bytes, salt: hex(salt), iv: hex(iv) },
    inner: hex(await sealRecoveryInner({ wrapKey, iv, accountPub: account.pub, keys: both })),
    wrongLength: await wrongLength((pt) => sealRaw(wrapKey, rcAad, pt)),
  },
  pepper: { secret: hex(bytes(32, (i) => 0xe0 + i)), iv: hex(bytes(12, (i) => 0x30 + i)), verifyKey: '', wrapKey: '', verifierTag: '', outer: '' },
}
{
  const pk = await pepperKeys(bytes(32, (i) => 0xe0 + i), account.pub)
  blobs.pepper.verifyKey = hex(pk.verifyKey)
  blobs.pepper.wrapKey = hex(pk.wrapKey)
  blobs.pepper.verifierTag = hex(await pepperVerifierTag(pk.verifyKey, await recoveryVerifier(code, saltV, argon2)))
  blobs.pepper.outer = hex(await pepperSeal(pk.wrapKey, bytes(12, (i) => 0x30 + i), Uint8Array.from(Buffer.from(blobs.recovery.inner, 'hex')), account.pub))
}

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const scalarHex = (x: bigint) => x.toString(16).padStart(64, '0')
// Each row is a blob PLAINTEXT `pt` (hex) checked against the binding's
// accountPub and recovery kxPub: unpackScalars, before anything uses a key.
const A_ = hex(account.d), K_ = hex(kx.d)
const scalars = [
  { name: 'account ‖ recovery kx, each matching its signed public half', pt: A_ + K_, accountPub: account.pub, kxPub: kx.pub, expect: 'accept' },
  { name: 'account scalar 0', pt: scalarHex(0n) + K_, accountPub: account.pub, kxPub: kx.pub, expect: 'reject', reason: 'scalar-range' },
  { name: 'kx scalar 0', pt: A_ + scalarHex(0n), accountPub: account.pub, kxPub: kx.pub, expect: 'reject', reason: 'scalar-range' },
  { name: 'account scalar n (the group order)', pt: scalarHex(N) + K_, accountPub: account.pub, kxPub: kx.pub, expect: 'reject', reason: 'scalar-range' },
  { name: 'kx scalar n (the group order)', pt: A_ + scalarHex(N), accountPub: account.pub, kxPub: kx.pub, expect: 'reject', reason: 'scalar-range' },
  { name: 'account scalar n−1 for a mismatched public half', pt: scalarHex(N - 1n) + K_, accountPub: account.pub, kxPub: kx.pub, expect: 'reject', reason: 'key-mismatch' },
  { name: "another key's scalar as the account (a swapped blob)", pt: hex(other.d) + K_, accountPub: account.pub, kxPub: kx.pub, expect: 'reject', reason: 'key-mismatch' },
  { name: "another key's scalar as the kx (a swapped blob)", pt: A_ + hex(other.d), accountPub: account.pub, kxPub: kx.pub, expect: 'reject', reason: 'key-mismatch' },
  { name: 'the two scalars in the wrong order', pt: K_ + A_, accountPub: account.pub, kxPub: kx.pub, expect: 'reject', reason: 'key-mismatch' },
  { name: 'the account scalar twice (kx slot filled with the account key)', pt: A_ + A_, accountPub: account.pub, kxPub: kx.pub, expect: 'reject', reason: 'key-mismatch' },
  { name: 'a 32-byte account-only plaintext (pre-C)', pt: A_, accountPub: account.pub, kxPub: kx.pub, expect: 'reject', reason: 'length' },
  { name: 'a 64-byte plaintext with no kx public half to match (empty kxPub)', pt: A_ + K_, accountPub: account.pub, kxPub: '', expect: 'reject', reason: 'key-mismatch' },
  { name: 'empty plaintext', pt: '', accountPub: account.pub, kxPub: kx.pub, expect: 'reject', reason: 'length' },
]

// sanity: the reference agrees with every refusal row it is about to publish
{
  const { unpackScalars, openPrfBlob, openRecoveryInner } = await import('../kernel/src/recovery.ts')
  for (const r of scalars) {
    const v = await unpackScalars(Uint8Array.from(Buffer.from(r.pt, 'hex')), { accountPub: r.accountPub, kxPub: r.kxPub })
    if (r.expect === 'accept' ? !v.ok : (v.ok || v.reason !== r.reason)) throw new Error(`scalar row disagrees: ${r.name}`)
  }
  const exp = { accountPub: account.pub, kxPub: kx.pub }
  for (const r of blobs.prf.wrongLength) {
    const v = await openPrfBlob({ ...blobs.prf.blob, ct: Buffer.from(r.ct, 'hex').toString('base64url') }, { prfOutput, credentialId, expected: exp })
    if (v.ok || v.reason !== 'length') throw new Error(`prf wrongLength row disagrees: ${r.name}`)
  }
  for (const r of blobs.recovery.wrongLength) {
    const v = await openRecoveryInner(Uint8Array.from(Buffer.from(r.ct, 'hex')), { wrapKey, iv, expected: exp })
    if (v.ok || v.reason !== 'length') throw new Error(`recovery wrongLength row disagrees: ${r.name}`)
  }
}

const fixture = {
  version: 1,
  kxMode: 'C',
  blobLen: 64,
  note: 'bento/id recovery-code and key-blob vectors (identity-design §2f, security §28). TEST KEYS ONLY. ' +
    'Every value is deterministic: reproduce the bytes exactly. Generated by scripts/gen-recovery-vectors.ts, ' +
    'checked by scripts/test-recovery.ts.',
  params: { argon2: ARGON2, saltLen: 16, hkdf: 'HKDF-SHA-256; an empty salt is zero-length (= 32 zero bytes)', aead: 'AES-256-GCM, 12-byte IV, ct = ciphertext ‖ 16-byte tag' },
  rfc9106,
  codes,
  parse,
  derivations,
  prf,
  blobs,
  scalars,
}
writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n')
console.log(`wrote ${OUT}: ${codes.length} codes, ${parse.length} parse rows, ${scalars.length} scalar rows`)
