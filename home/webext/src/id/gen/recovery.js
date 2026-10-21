// GENERATED from kernel/src/recovery.ts by scripts/gen-webext-id.mjs — do not edit.
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/id — the recovery code and the key blobs (identity-design §2f, signed by
// security §28). The reference for every host that wraps or unwraps an account
// key, with conformance vectors in kernel/fixtures/identity-v1.json.
//
// Two ways back into an account on a new device, neither held by Bento:
//   - a PASSKEY with the PRF extension: its 32-byte PRF output derives a key that
//     unwraps the account key from a blob the directory keeps per passkey;
//   - a RECOVERY CODE printed once at setup: Argon2id stretches it into the key
//     for a second blob, which the directory releases only at the end of the
//     tightened recovery (72 h wait, every device notified).
//
// Argon2id is not in WebCrypto, and documents never derive these keys (only an
// agent does), so this module takes the Argon2id function as a parameter: the
// extension passes its vendored WASM, the rigs pass Node's native one, and the
// kernel ships no WASM. Everything else here is WebCrypto (HKDF, AES-GCM, HMAC).

import { b64uEnc, b64uDec, sha256b64u,                            KX_MODE } from './statements.js'

// --- parameters (security §28) -------------------------------------------------

/** Argon2id, version 0x13. p = 1 is safest for WASM and phones. */
export const ARGON2 = Object.freeze({ version: 0x13, parallelism: 1, memoryKiB: 65536, passes: 3, tagLength: 32 })
/** Salt lengths. The wrap salt and the verifier salt are separate and independent. */
export const SALT_LEN = 16
/** Argon2id with ARGON2's parameters, supplied by the host. */
                                                                                      

const no = (reason        )                                => ({ ok: false, reason })
const te = new TextEncoder()

// --- the recovery code: 80 bits, Crockford base32, with a check symbol ----------

/** Crockford base32: digits and letters without I, L, O, U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** Check symbols: the 32 above plus * ~ $ = U for values 32–36 (mod 37). */
const CHECK_ALPHABET = ALPHABET + '*~$=U'
export const CODE_BYTES = 10 // 80 bits = 16 symbols

const toBig = (b            ) => b.reduce((x, v) => (x << 8n) | BigInt(v), 0n)

/** The 80-bit value mod 37, in a fixed 10-step loop (no BigInt on the code). */
const check37 = (code            ) => code.reduce((r, b) => (r * 256 + b) % 37, 0)

/** The printed form: XXXX-XXXX-XXXX-XXXX-C. */
export function formatRecoveryCode(code            )         {
  if (code.length !== CODE_BYTES) throw new Error('a recovery code is 10 bytes')
  let s = ''
  for (let i = 0; i < 16; i++) { // symbol i is bits 5i..5i+4 from the top
    const bit = i * 5, byte = bit >> 3, sh = bit & 7
    const two = (code[byte] << 8) | (code[byte + 1] ?? 0)
    s += ALPHABET[(two >> (11 - sh)) & 31]
  }
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${CHECK_ALPHABET[check37(code)]}`
}

                                                          

/**
 * Read what a person typed. Forgiving where Crockford is: case, spaces and
 * hyphens don't matter, and O reads as 0, I and L as 1. The check symbol must
 * match, so a typo is caught HERE, before it costs one of the directory's five
 * daily attempts. Returns the 10 bytes Argon2id takes — never the string, so no
 * two hosts can disagree about case or separators.
 */
export function parseRecoveryCode(input        )                                                                      {
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (s.length !== 17) return { ok: false, reason: 'length' }
  const code = new Uint8Array(CODE_BYTES)
  for (let i = 0; i < 16; i++) {
    const v = ALPHABET.indexOf(s[i])
    if (v < 0) return { ok: false, reason: 'character' } // includes U: valid only as the check
    const bit = i * 5, byte = bit >> 3, sh = bit & 7
    const two = v << (11 - sh) // the symbol placed in a 16-bit window over bytes byte, byte+1
    code[byte] |= two >> 8
    if (byte + 1 < CODE_BYTES) code[byte + 1] |= two & 0xff
  }
  const check = CHECK_ALPHABET.indexOf(s[16])
  if (check < 0) return { ok: false, reason: 'character' }
  if (check !== check37(code)) return { ok: false, reason: 'check' }
  return { ok: true, code }
}

// --- derivations ------------------------------------------------------------------

async function hkdf(ikm            , salt            , info        )                      {
  const k = await crypto.subtle.importKey('raw', ikm                , 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt                , info: te.encode(info)                 }, k, 256))
}
/** HKDF's salt is EMPTY where a step needs none (equivalent to 32 zero bytes). */
const EMPTY = new Uint8Array(0)

/** The recovery blob's wrap key: HKDF-SHA-256(Argon2id(code, salt), empty, "bento/id/rc-wrap/v1"). */
export async function recoveryWrapKey(code            , salt            , argon2          )                      {
  checkLen(code, CODE_BYTES, 'code'); checkLen(salt, SALT_LEN, 'salt')
  return hkdf(await argon2(code, salt), EMPTY, 'bento/id/rc-wrap/v1')
}

/** What the client sends the directory to prove it knows the code: Argon2id(code, salt_v). */
export async function recoveryVerifier(code            , saltV            , argon2          )                      {
  checkLen(code, CODE_BYTES, 'code'); checkLen(saltV, SALT_LEN, 'salt_v')
  return argon2(code, saltV)
}

/**
 * The PRF extension's FIXED input (identity-design §2f), as UTF-8 bytes: every
 * ceremony evaluates exactly this, so one passkey always yields one PRF output.
 */
export const PRF_INPUT = 'bento/id/prf/v1'

/**
 * What a host that speaks CTAP directly (libfido2 hmac-secret, no WebAuthn PRF
 * API) must send as the hmac-secret salt so the authenticator returns the SAME
 * 32 bytes a browser's PRF extension would. WebAuthn Level 3 §10.1.4:
 * salt = SHA-256(UTF-8("WebAuthn PRF") ‖ 0x00 ‖ input). Forget the 0x00, or
 * send the raw input, and the blob you seal can never be opened by a browser
 * (and vice versa). Browsers do this themselves; never apply it twice.
 */
export async function prfHmacSecretSalt(input             = te.encode(PRF_INPUT))                      {
  const label = te.encode('WebAuthn PRF')
  const msg = new Uint8Array(label.length + 1 + input.length)
  msg.set(label); msg[label.length] = 0; msg.set(input, label.length + 1)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', msg                ))
}

/** The PRF blob's key: HKDF-SHA-256(PRF output, 32-byte salt, "bento/id/acct-wrap/v1"). */
export async function prfKek(prfOutput            , salt            )                      {
  checkLen(prfOutput, 32, 'PRF output'); checkLen(salt, 32, 'salt')
  return hkdf(prfOutput, salt, 'bento/id/acct-wrap/v1')
}

function checkLen(b            , n        , what        ) {
  if (!(b instanceof Uint8Array) || b.length !== n) throw new Error(`${what} must be ${n} bytes`)
}

// --- the blob plaintext: raw private scalars, checked on import ------------------

/** P-256 */
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n
const mod = (a        ) => ((a % P) + P) % P
function inv(a        )         { // Fermat: a^(p-2)
  let r = 1n, b = mod(a), e = P - 2n
  while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n }
  return r
}
                                  // Jacobian; Z = 0 is the point at infinity
function dbl([x, y, z]   )    {
  if (y === 0n || z === 0n) return [0n, 1n, 0n]
  const z2 = mod(z * z), m = mod(3n * (x - z2) * (x + z2)) // a = -3
  const y2 = mod(y * y), s = mod(4n * x * y2)
  const x3 = mod(m * m - 2n * s), y3 = mod(m * (s - x3) - 8n * y2 * y2), z3 = mod(2n * y * z)
  return [x3, y3, z3]
}
function add(p   , q   )    {
  if (p[2] === 0n) return q
  if (q[2] === 0n) return p
  const z1z1 = mod(p[2] * p[2]), z2z2 = mod(q[2] * q[2])
  const u1 = mod(p[0] * z2z2), u2 = mod(q[0] * z1z1)
  const s1 = mod(p[1] * q[2] * z2z2), s2 = mod(q[1] * p[2] * z1z1)
  if (u1 === u2) return s1 === s2 ? dbl(p) : [0n, 1n, 0n]
  const h = mod(u2 - u1), r = mod(s2 - s1), h2 = mod(h * h), h3 = mod(h * h2)
  const x3 = mod(r * r - h3 - 2n * u1 * h2)
  return [x3, mod(r * (u1 * h2 - x3) - s1 * h3), mod(h * p[2] * q[2])]
}
/** The public key (raw uncompressed point, base64url) of a 32-byte private
 *  scalar in 1..n−1. Plain P-256 arithmetic, so it is identical on every host;
 *  null for a scalar out of range. */
export function publicKeyOf(scalar            )                {
  if (!(scalar instanceof Uint8Array) || scalar.length !== 32) return null
  const d = toBig(scalar)
  return d >= 1n && d < N ? publicOf(d) : null
}

/** d·G as a raw uncompressed point (65 bytes), base64url. */
function publicOf(d        )         {
  let acc    = [0n, 1n, 0n], base    = [GX, GY, 1n]
  for (let k = d; k > 0n; k >>= 1n) { if (k & 1n) acc = add(acc, base); base = dbl(base) }
  const zi = inv(acc[2]), zi2 = mod(zi * zi)
  const x = mod(acc[0] * zi2), y = mod(acc[1] * zi2 * zi)
  const out = new Uint8Array(65); out[0] = 4
  for (let i = 0, v = x; i < 32; i++) { out[32 - i] = Number(v & 0xffn); v >>= 8n }
  for (let i = 0, v = y; i < 32; i++) { out[64 - i] = Number(v & 0xffn); v >>= 8n }
  return b64uEnc(out)
}

/** Which scalars a blob carries, by the kx placement (identity-design §6b). */
const BLOB_KX                          = { unruled: false, A: true, B: false, C: true }

                           
                                                                      
                     
                                                                                           
                 
 

/** account d ‖ kx d (when the mode carries one), each 32 bytes big-endian. */
export function packScalars(keys          , mode         = KX_MODE)             {
  checkLen(keys.account, 32, 'account scalar')
  if (!BLOB_KX[mode]) {
    if (keys.kx) throw new Error(`kx mode ${mode} carries no kx in the blob`)
    return keys.account.slice()
  }
  if (!keys.kx) throw new Error(`kx mode ${mode} needs a kx in the blob`)
  checkLen(keys.kx, 32, 'kx scalar')
  const out = new Uint8Array(64); out.set(keys.account); out.set(keys.kx, 32)
  return out
}

/**
 * Read a blob's plaintext and CHECK it before anything uses it: the right length
 * for the mode, every scalar in 1..n−1 (security §28), and each one's public
 * half equal to the public key in the directory-signed binding. A blob swapped by
 * a malicious directory fails closed here.
 *
 * These are RECOVERED PRIVATE SCALARS, so nothing here branches on their bits.
 * The range check is a branch-free byte compare, and the match goes through the
 * platform's crypto, never publicOf (variable-time double-and-add on BigInt,
 * kept for the generator and the rig only). The scalar is imported as a JWK
 * {d, x, y} with x, y from the stated public half (Chrome and Node refuse a
 * mismatched pair), then signs a probe that must verify under that public key,
 * so a platform that skips the pair check on import is caught too (security, #770).
 */
export async function unpackScalars(pt            , expected                                        , mode         = KX_MODE,
  subtle               = crypto.subtle)                             {
  const withKx = BLOB_KX[mode]
  if (pt.length !== (withKx ? 64 : 32)) return no('length')
  const scalars = withKx ? [pt.slice(0, 32), pt.slice(32)] : [pt.slice(0, 32)]
  const pubs = withKx ? [expected.accountPub, expected.kxPub] : [expected.accountPub]
  for (let i = 0; i < scalars.length; i++) {
    if (!scalarInRange(scalars[i])) return no('scalar-range')
    if (pubs[i] === undefined || !(await scalarMatches(scalars[i], pubs[i] , subtle))) return no('key-mismatch')
  }
  return { ok: true, value: withKx ? { account: scalars[0], kx: scalars[1] } : { account: scalars[0] } }
}

const N_BYTES = Uint8Array.from({ length: 32 }, (_, i) => Number((N >> BigInt(8 * (31 - i))) & 0xffn))

/** 1 ≤ d < n for a 32-byte big-endian scalar, without branching on its bytes. */
function scalarInRange(d            )          {
  let nonzero = 0, lt = 0, gt = 0
  for (let i = 0; i < 32; i++) {
    const a = d[i], b = N_BYTES[i], open = 1 ^ (lt | gt)
    lt |= open & (((a - b) >>> 31) & 1)
    gt |= open & (((b - a) >>> 31) & 1)
    nonzero |= a
  }
  return (lt & ((nonzero | -nonzero) >>> 31)) === 1
}

const PROBE = te.encode('bento/id/scalar-probe/v1')
const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' }

/** Does the private scalar d belong to the raw public key pub? Platform crypto only.
 *  `subtle` is injectable so a rig can stand in a platform that skips the pair check on import. */
async function scalarMatches(d            , pub        , subtle              )                   {
  const raw = b64uDec(pub)
  if (!raw || raw.length !== 65 || raw[0] !== 4) return false
  try {
    const priv = await subtle.importKey('jwk', {
      kty: 'EC', crv: 'P-256', d: b64uEnc(d), x: b64uEnc(raw.slice(1, 33)), y: b64uEnc(raw.slice(33)), ext: false,
    }, ECDSA_P256, false, ['sign'])
    const pubKey = await subtle.importKey('raw', raw                , ECDSA_P256, false, ['verify'])
    const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, PROBE                )
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, sig, PROBE                )
  } catch { return false }
}

// --- AES-256-GCM ---------------------------------------------------------------------

async function gcm(op                       , key            , iv            , aad        , data            ) {
  checkLen(key, 32, 'key'); checkLen(iv, 12, 'iv')
  const k = await crypto.subtle.importKey('raw', key                , 'AES-GCM', false, [op])
  const params = { name: 'AES-GCM', iv: iv                , additionalData: te.encode(aad)                , tagLength: 128 }
  return new Uint8Array(op === 'encrypt'
    ? await crypto.subtle.encrypt(params, k, data                )
    : await crypto.subtle.decrypt(params, k, data                ))
}
const accountTag = async (accountPub        ) => sha256b64u(accountPub)

// --- the PRF blob (one per passkey) -----------------------------------------------

                                                                                     

/** cred = b64u(sha256(credentialId)); aad = "bento/id/acct-wrap/v1." ‖ cred; ct = ciphertext ‖ tag. */
export async function sealPrfBlob(a   
                                                                                                                  
 )                   {
  const cred = b64uEnc(new Uint8Array(await crypto.subtle.digest('SHA-256', a.credentialId                )))
  const kek = await prfKek(a.prfOutput, a.salt)
  const ct = await gcm('encrypt', kek, a.iv, `bento/id/acct-wrap/v1.${cred}`, packScalars(a.keys, a.mode))
  return { v: 1, cred, salt: b64uEnc(a.salt), iv: b64uEnc(a.iv), ct: b64uEnc(ct) }
}

export async function openPrfBlob(blob         , a   
                                                                                                                  
 )                             {
  if (blob?.v !== 1) return no('version')
  const cred = b64uEnc(new Uint8Array(await crypto.subtle.digest('SHA-256', a.credentialId                )))
  if (blob.cred !== cred) return no('credential')
  const salt = b64uDec(blob.salt), iv = b64uDec(blob.iv), ct = b64uDec(blob.ct)
  if (!salt || salt.length !== 32 || !iv || iv.length !== 12 || !ct) return no('grammar')
  let pt            
  try { pt = await gcm('decrypt', await prfKek(a.prfOutput, salt), iv, `bento/id/acct-wrap/v1.${cred}`, ct) } catch { return no('decrypt') }
  return unpackScalars(pt, a.expected, a.mode)
}

// --- the recovery-code blob, and the directory's pepper layer ---------------------

/** Inner layer: AES-GCM(rc wrap key, scalars), aad = "bento/id/rc-wrap/v1." ‖ b64u(sha256(accountPub)). */
export async function sealRecoveryInner(a                                                                                            ) 
                      {
  return gcm('encrypt', a.wrapKey, a.iv, `bento/id/rc-wrap/v1.${await accountTag(a.accountPub)}`, packScalars(a.keys, a.mode))
}

export async function openRecoveryInner(ct            , a   
                                                                                                      
 )                             {
  let pt            
  try { pt = await gcm('decrypt', a.wrapKey, a.iv, `bento/id/rc-wrap/v1.${await accountTag(a.expected.accountPub)}`, ct) } catch { return no('decrypt') }
  return unpackScalars(pt, a.expected, a.mode)
}

/**
 * The directory's per-account pepper (server side; share implements it, this is
 * the reference for its vectors). From one versioned Worker secret PEPPER_vN:
 *   P         = HKDF(PEPPER_vN, empty, "bento/id/pepper/v1." ‖ b64u(sha256(accountPub)))
 *   verifyKey = HKDF(P, empty, "bento/id/pepper/v1/verify")
 *               — the stored verifier is HMAC-SHA-256(verifyKey, verifier)
 *   wrapKey   = HKDF(P, empty, "bento/id/pepper/v1/wrap")
 *               — the outer AES-GCM layer over the inner ciphertext,
 *                 aad = "bento/id/rc-pepper/v1." ‖ b64u(sha256(accountPub))
 * The subkey labels are fully domain-separated (security §28a).
 */
export async function pepperKeys(pepper            , accountPub        )                                                          {
  const p = await hkdf(pepper, EMPTY, `bento/id/pepper/v1.${await accountTag(accountPub)}`)
  return { verifyKey: await hkdf(p, EMPTY, 'bento/id/pepper/v1/verify'), wrapKey: await hkdf(p, EMPTY, 'bento/id/pepper/v1/wrap') }
}

export async function pepperVerifierTag(verifyKey            , verifier            )                      {
  const k = await crypto.subtle.importKey('raw', verifyKey                , { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, verifier                ))
}

export async function pepperSeal(wrapKey            , iv            , inner            , accountPub        )                      {
  return gcm('encrypt', wrapKey, iv, `bento/id/rc-pepper/v1.${await accountTag(accountPub)}`, inner)
}

export async function pepperOpen(wrapKey            , iv            , outer            , accountPub        )                             {
  try { return await gcm('decrypt', wrapKey, iv, `bento/id/rc-pepper/v1.${await accountTag(accountPub)}`, outer) } catch { return null }
}
