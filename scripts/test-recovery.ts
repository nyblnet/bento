#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/id recovery rig: kernel/src/recovery.ts against kernel/fixtures/recovery-v1.json.
//
//   node scripts/test-recovery.ts
//
// WHAT THIS PROVES. Five hosts must derive the identical keys from the same
// recovery code and the same passkey PRF output, or a person who sets up on one
// device can never recover on another. The vectors are deterministic, so the
// reference must reproduce every byte: the Argon2id primitive against RFC 9106,
// the code's printed form and its forgiving parse (including all five extra
// check symbols), every derivation, every blob re-sealed byte for byte, and
// every refusal: a wrong PRF, a wrong credential, a blob bound to another
// account, a scalar out of range or not matching the signed public half.

import { argon2 as nodeArgon2 } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ARGON2, formatRecoveryCode, parseRecoveryCode, recoveryWrapKey, recoveryVerifier, prfKek,
  sealPrfBlob, openPrfBlob, sealRecoveryInner, openRecoveryInner, unpackScalars, BLOB_LEN,
  pepperKeys, pepperVerifierTag, pepperSeal, pepperOpen, publicKeyOf, PRF_INPUT, prfHmacSecretSalt, type Argon2id,
} from '../kernel/src/recovery.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const F = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel/fixtures/recovery-v1.json'), 'utf8'))
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))

const raw = (o: { message: Uint8Array; nonce: Uint8Array; secret?: Uint8Array; associatedData?: Uint8Array; parallelism: number; tagLength: number; memory: number; passes: number }) =>
  new Promise<Uint8Array>((res, rej) => nodeArgon2('argon2id', o, (e, k) => (e ? rej(e) : res(new Uint8Array(k)))))
const argon2: Argon2id = (password, salt) => raw({
  message: password, nonce: salt, parallelism: ARGON2.parallelism, tagLength: ARGON2.tagLength, memory: ARGON2.memoryKiB, passes: ARGON2.passes,
})

console.log('\nthe Argon2id primitive matches RFC 9106 §5.3')
{
  const v = F.rfc9106
  const tag = await raw({ message: unhex(v.password), nonce: unhex(v.salt), secret: unhex(v.secret), associatedData: unhex(v.ad),
    parallelism: v.parallelism, tagLength: v.tagLength, memory: v.memoryKiB, passes: v.passes })
  ok(hex(tag) === v.tag, 'Argon2id(RFC 9106 §5.3 inputs) = the published tag')
  ok(F.params.argon2.parallelism === 1 && F.params.argon2.memoryKiB === 65536 && F.params.argon2.passes === 3 &&
    F.params.argon2.tagLength === 32 && F.params.argon2.version === 0x13, 'the fixture states the signed parameters (p=1, 64 MiB, t=3, 32-byte tag, v0x13)')
}

console.log('\nthe printed code, including every extra check symbol')
for (const c of F.codes) ok(formatRecoveryCode(unhex(c.bytes)) === c.printed, `${c.printed} (check ${c.check})`)
for (const s of ['*', '~', '$', '=', 'U']) ok(F.codes.some((c: { check: string }) => c.check === s), `a code whose check symbol is ${s}`)

console.log('\nreading what a person typed')
for (const r of F.parse) {
  const got = parseRecoveryCode(r.input)
  const pass = r.bytes ? got.ok && hex(got.code) === r.bytes : !got.ok && got.reason === r.reason
  ok(pass, `${JSON.stringify(r.input)} → ${r.bytes ? 'the code' : `refused: ${r.reason}`} (${r.note})`)
}

console.log('\nderivations')
{
  const d = F.derivations
  const code = unhex(d.code), salt = unhex(d.salt), saltV = unhex(d.saltV)
  ok(hex(await argon2(code, salt)) === d.argon2_A, 'A = Argon2id(code bytes, salt)')
  ok(hex(await recoveryWrapKey(code, salt, argon2)) === d.wrapKey, 'wrap key = HKDF(A, empty, "bento/id/rc-wrap/v1")')
  ok(hex(await recoveryVerifier(code, saltV, argon2)) === d.verifier, 'verifier = Argon2id(code bytes, salt_v)')
  ok(d.verifier !== d.argon2_A, 'the verifier is not the wrap input (independent salts)')
  ok(hex(await prfKek(unhex(d.prf.output), unhex(d.prf.salt))) === d.prfKek, 'PRF KEK = HKDF(PRF output, salt, "bento/id/acct-wrap/v1")')
}

console.log('\nthe PRF input, and the CTAP hmac-secret salt (WebAuthn L3 §10.1.4)')
{
  const v = F.prf
  ok(v.prfInput === PRF_INPUT && v.prfInput === 'bento/id/prf/v1', 'the fixed PRF input is "bento/id/prf/v1" (identity-design §2f)')
  ok(v.inputHex === Buffer.from('bento/id/prf/v1', 'utf8').toString('hex'), 'the input is its UTF-8 bytes')
  const salt = hex(await prfHmacSecretSalt())
  ok(salt === v.hmacSecretSalt, 'hmac-secret salt = SHA-256("WebAuthn PRF" ‖ 0x00 ‖ input)')
  // independent of the reference: the spec's formula, written out with node's own hash
  const { createHash } = await import('node:crypto')
  const byHand = createHash('sha256').update(Buffer.concat([Buffer.from('WebAuthn PRF'), Buffer.from([0]), Buffer.from('bento/id/prf/v1')])).digest('hex')
  ok(byHand === v.hmacSecretSalt, "and node's own SHA-256 of the spec's bytes agrees")
  ok(new Set([v.hmacSecretSalt, v.wrong.noSeparator, v.wrong.rawInputHash, v.wrong.rawInput]).size === 4,
    'each easy mistake (no 0x00, hashing the raw input, the raw input) gives a different salt')
}

console.log('\nwhole blobs, end to end')
{
  const b = F.blobs, k = b.keys, i = b.prf.inputs
  const prfIn = { prfOutput: unhex(i.prfOutput), credentialId: unhex(i.credentialId), salt: unhex(i.salt), iv: unhex(i.iv) }
  ok(F.kxMode === 'C' && F.blobLen === 64 && BLOB_LEN === 64, 'kx placement is mode C: the blob is 64 bytes (account ‖ recovery kx)')
  const keys = { account: unhex(k.accountD), kx: unhex(k.kxD) }
  const exp = { accountPub: k.accountPub, kxPub: k.kxPub }
  const resealed = await sealPrfBlob({ ...prfIn, keys })
  ok(JSON.stringify(resealed) === JSON.stringify(b.prf.blob), 'the PRF blob (account ‖ recovery kx) re-seals byte for byte')
  ok(unhex(Buffer.from(b.prf.blob.ct, 'base64url').toString('hex')).length === 64 + 16, 'its ciphertext is 64 bytes plus the tag')

  const opened = await openPrfBlob(b.prf.blob, { prfOutput: prfIn.prfOutput, credentialId: prfIn.credentialId, expected: exp })
  ok(opened.ok && hex(opened.value.account) === k.accountD && hex(opened.value.kx) === k.kxD, 'it opens to account ‖ kx, each checked against its signed public half')
  const wrongPrf = await openPrfBlob(b.prf.blob, { prfOutput: unhex(i.prfOutput).map((x: number) => x ^ 1), credentialId: prfIn.credentialId, expected: exp })
  ok(!wrongPrf.ok && wrongPrf.reason === 'decrypt', 'a different passkey PRF output cannot open it')
  const wrongCred = await openPrfBlob(b.prf.blob, { prfOutput: prfIn.prfOutput, credentialId: unhex(i.credentialId).map((x: number) => x ^ 1), expected: exp })
  ok(!wrongCred.ok && wrongCred.reason === 'credential', 'a blob for another credential is refused')
  const noKxPub = await openPrfBlob(b.prf.blob, { prfOutput: prfIn.prfOutput, credentialId: prfIn.credentialId, expected: { accountPub: k.accountPub } as typeof exp })
  ok(!noKxPub.ok && noKxPub.reason === 'key-mismatch', 'opened with no recovery kx to match, it is refused (key-mismatch)')
  ok(b.prf.wrongLength.length === 4 && b.prf.wrongLength[0].name.includes('32-byte'), 'the fixture carries the wrong-length PRF rows, the 32-byte pre-C blob first')
  for (const w of b.prf.wrongLength) {
    const v = await openPrfBlob({ ...b.prf.blob, ct: Buffer.from(unhex(w.ct)).toString('base64url') }, { prfOutput: prfIn.prfOutput, credentialId: prfIn.credentialId, expected: exp })
    ok(!v.ok && v.reason === 'length', `PRF: ${w.name} decrypts, then is refused (length)`)
  }
  let packThrew = 0
  for (const bad of [{ account: keys.account }, { account: keys.account, kx: new Uint8Array(0) }, { account: keys.account, kx: new Uint8Array(31) }]) {
    try { await sealPrfBlob({ ...prfIn, keys: bad as typeof keys }) } catch { packThrew++ }
  }
  ok(packThrew === 3, 'sealing refuses a blob without a 32-byte recovery kx (no kx, empty, 31 bytes)')

  const r = b.recovery.inputs
  const wk = await recoveryWrapKey(unhex(r.code), unhex(r.salt), argon2)
  const inner = await sealRecoveryInner({ wrapKey: wk, iv: unhex(r.iv), accountPub: k.accountPub, keys })
  ok(hex(inner) === b.recovery.inner, 'the recovery blob (inner layer) re-seals byte for byte')
  ok(inner.length === 64 + 16, 'its ciphertext is 64 bytes plus the tag')
  const rOpen = await openRecoveryInner(unhex(b.recovery.inner), { wrapKey: wk, iv: unhex(r.iv), expected: exp })
  ok(rOpen.ok && hex(rOpen.value.account) === k.accountD && hex(rOpen.value.kx) === k.kxD, 'the recovery code opens it to account ‖ kx')
  for (const w of b.recovery.wrongLength) {
    const v = await openRecoveryInner(unhex(w.ct), { wrapKey: wk, iv: unhex(r.iv), expected: exp })
    ok(!v.ok && v.reason === 'length', `recovery: ${w.name} decrypts, then is refused (length)`)
  }
  const otherCode = parseRecoveryCode(F.codes[1].printed)
  const wk2 = await recoveryWrapKey(otherCode.ok ? otherCode.code : new Uint8Array(10), unhex(r.salt), argon2)
  const rWrong = await openRecoveryInner(unhex(b.recovery.inner), { wrapKey: wk2, iv: unhex(r.iv), expected: exp })
  ok(!rWrong.ok && rWrong.reason === 'decrypt', 'a different recovery code cannot open it')
  // the aad binds the blob to its account: presented as another account's, it fails
  const rOther = await openRecoveryInner(unhex(b.recovery.inner), { wrapKey: wk, iv: unhex(r.iv), expected: { accountPub: F.blobs.keys.kxPub, kxPub: k.kxPub } })
  ok(!rOther.ok && rOther.reason === 'decrypt', "a recovery blob presented as another account's fails (aad binds the account)")

  const pp = b.pepper
  const pk = await pepperKeys(unhex(pp.secret), k.accountPub)
  ok(hex(pk.verifyKey) === pp.verifyKey && hex(pk.wrapKey) === pp.wrapKey, 'pepper: P → the "verify" and "wrap" subkeys')
  const verifier = await recoveryVerifier(unhex(F.derivations.code), unhex(F.derivations.saltV), argon2)
  ok(hex(await pepperVerifierTag(pk.verifyKey, verifier)) === pp.verifierTag, 'pepper: stored verifier = HMAC(verifyKey, verifier)')
  ok(hex(await pepperSeal(pk.wrapKey, unhex(pp.iv), unhex(b.recovery.inner), k.accountPub)) === pp.outer, 'pepper: the outer layer re-seals byte for byte')
  const back = await pepperOpen(pk.wrapKey, unhex(pp.iv), unhex(pp.outer), k.accountPub)
  ok(!!back && hex(back) === b.recovery.inner, 'pepper: the outer layer opens to the inner blob')
  ok((await pepperOpen(pk.wrapKey, unhex(pp.iv), unhex(pp.outer), k.kxPub)) === null, "pepper: presented as another account's, it fails")
}

console.log('\nscalars on import: in range, and matching the signed public half')
for (const s of F.scalars) {
  const v = await unpackScalars(unhex(s.pt), { accountPub: s.accountPub, kxPub: s.kxPub })
  ok(s.expect === 'accept' ? v.ok : !v.ok && v.reason === s.reason, `${s.name} → ${s.expect === 'accept' ? 'accept' : `refused: ${s.reason}`}`)
}

// The fixture's test keys are deterministic, their public halves computed by
// publicKeyOf itself, so the rows above cannot validate d·G on their own. Check
// it INDEPENDENTLY against keys the platform generated.
console.log('\nd·G agrees with the platform on keys it generated')
for (const alg of ['ECDSA', 'ECDH'] as const) {
  let agree = 0
  for (let i = 0; i < 8; i++) {
    const kp = (await crypto.subtle.generateKey({ name: alg, namedCurve: 'P-256' }, true,
      alg === 'ECDSA' ? ['sign', 'verify'] : ['deriveBits'])) as CryptoKeyPair
    const d = Uint8Array.from(Buffer.from((await crypto.subtle.exportKey('jwk', kp.privateKey)).d!, 'base64url'))
    const pub = Buffer.from(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))).toString('base64url')
    if (publicKeyOf(d) === pub) agree++
  }
  ok(agree === 8, `${alg}: publicKeyOf(d) equals WebCrypto's public key for 8 fresh key pairs`)
}
ok(publicKeyOf(new Uint8Array(32)) === null, 'publicKeyOf refuses scalar 0')

// The sign-and-verify probe is a second line of defence: Chrome and Node already
// refuse a mismatched {d, x, y} on import, so it can't be reached above. Stand in a
// LAX platform that ignores x, y (imports d alone as PKCS#8, no public key) and
// the probe must still catch every mismatch. (security, #770)
console.log('\non a platform that skips the pair check on import, the probe still refuses')
{
  const PKCS8_P256 = '308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420'
  // the real methods, BOUND: SubtleCrypto's methods throw on any other `this`, and
  // scalarMatches reads a throw as a mismatch, so an unbound stand-in refuses
  // everything and these rows would pass vacuously
  const lax = {
    sign: crypto.subtle.sign.bind(crypto.subtle),
    verify: crypto.subtle.verify.bind(crypto.subtle),
    importKey: (format: string, data: JsonWebKey, alg: AlgorithmIdentifier, ext: boolean, uses: KeyUsage[]) =>
      format === 'jwk'
        ? crypto.subtle.importKey('pkcs8', unhex(PKCS8_P256 + Buffer.from(data.d!, 'base64url').toString('hex')), alg, ext, uses)
        : crypto.subtle.importKey(format as 'raw', data as unknown as BufferSource, alg, ext, uses),
  } as unknown as SubtleCrypto
  // positive control: the lax import really does accept a mismatched pair
  const mismatched = F.scalars.find((s: { reason?: string; name: string }) => s.name.startsWith("another key's"))
  const accepted = await lax.importKey('jwk', { kty: 'EC', crv: 'P-256', d: Buffer.from(unhex(mismatched.pt).slice(0, 32)).toString('base64url'),
    x: 'x', y: 'y' }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']).then(() => true, () => false)
  ok(accepted, 'control: the lax platform imports a scalar without checking its public half')
  for (const s of F.scalars) {
    const v = await unpackScalars(unhex(s.pt), { accountPub: s.accountPub, kxPub: s.kxPub }, lax)
    ok(s.expect === 'accept' ? v.ok : !v.ok && v.reason === s.reason, `lax: ${s.name} → ${s.expect === 'accept' ? 'accept' : `refused: ${s.reason}`}`)
  }
}

// SHAPE: the recovered scalar never reaches the variable-time BigInt path. A
// call graph over recovery.ts's top-level declarations: publicOf and its point
// arithmetic must be unreachable from unpackScalars (security, #770).
console.log('\nthe recovered scalar never reaches the variable-time path')
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel/src/recovery.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const starts = [...src.matchAll(/^(?:export )?(?:async )?(?:function|const) ([A-Za-z_]\w*)/gm)].map((m) => ({ name: m[1], at: m.index! }))
  const body = new Map(starts.map((s, i) => [s.name, src.slice(s.at, starts[i + 1]?.at ?? src.length)]))
  const calls = (name: string) => [...body.keys()].filter((n) => n !== name && new RegExp(`\\b${n}\\b`).test(body.get(name)!))
  const reach = (from: string) => {
    const seen = new Set([from]), todo = [from]
    while (todo.length) for (const c of calls(todo.pop()!)) if (!seen.has(c)) { seen.add(c); todo.push(c) }
    return seen
  }
  const r = reach('unpackScalars')
  for (const bad of ['publicOf', 'publicKeyOf', 'add', 'dbl', 'inv', 'toBig']) ok(!r.has(bad), `${bad} is unreachable from unpackScalars`)
  // non-vacuous: the graph sees these edges where they exist
  ok(reach('publicKeyOf').has('dbl') && reach('openPrfBlob').has('scalarMatches'), 'the call graph sees real edges (publicKeyOf → dbl, openPrfBlob → scalarMatches)')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
