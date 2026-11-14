// GENERATED from kernel/src/webauthn.ts by scripts/gen-webext-id.mjs — do not edit.
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/id — a WebAuthn ASSERTION as a signature, verified offline.
//
// Under option G the account is a roster of passkeys, so a statement can be
// signed by a passkey: the page asks `navigator.credentials.get` for an
// assertion whose challenge is the SHA-256 of the statement text, and anyone
// holding the passkey's public point checks it with WebCrypto alone. No
// server, no attestation, no library.
//
// This is the reference every port (Swift, Kotlin, Rust, the extension, the
// directory) must match, and kernel/fixtures/webauthn-v1.json is the contract.
// What it checks, in this order, each with its own refusal reason:
//
//   grammar        the three fields are canonical base64url; authenticatorData
//                  is 37 bytes (more only with the ED flag); no AT flag (an
//                  assertion carries no attested credential); BS never without
//                  BE; clientDataJSON is strict UTF-8 JSON (a byte-order mark
//                  stays and fails) whose top level is an object
//   duplicate-key  ANY object in clientDataJSON repeats a key, compared after
//                  unescaping. JSON.parse keeps the last `origin`, other
//                  languages keep the first or throw, so a client that writes
//                  two could mean different things to different verifiers.
//   type           exactly the string "webauthn.get"
//   challenge      canonical base64url decoding to EXACTLY the expected bytes
//   origin         a string equal to one entry of the caller's closed list,
//                  compared as exact text: no subdomain, parent, port or
//                  trailing-slash forgiveness
//   cross-origin   `crossOrigin` absent or the boolean false (never the string
//                  "false"), and no `topOrigin` key at all
//   rp             rpIdHash exactly SHA-256(rpId). A page on a host CAN assert
//                  for its parent domain, so this check carries weight.
//   up, uv         both flags set
//   signature      ES256 over authenticatorData ‖ SHA-256(clientDataJSON).
//                  WebAuthn emits DER: it must be STRICT DER (minimal integers,
//                  r and s in 1..n−1, nothing trailing). High-S is NORMALISED,
//                  not refused: about half of real assertions are high-S and
//                  their signer is the authenticator, not us. That exception is
//                  for this encoding only; bento's own statements stay low-S
//                  only (statements.ts).
//   key            the public point is not a raw uncompressed P-256 point
//   sign-count     only when the caller holds a stored count: if either count
//                  is nonzero, the new one must be greater (WebAuthn L3 §7.2
//                  step 21; this verifier takes the refusing branch). Synced
//                  passkeys report 0 and 0, which passes.
//
// Extra clientDataJSON keys are TOLERATED (Chrome adds
// "other_keys_can_be_added_here"); the three exact fields are checked wherever
// they sit, never by prefix. Registration (`webauthn.create`) is not an
// assertion and is not accepted here.
//
// The rp id and the origin list are parameters: the caller pins them, and the
// fixtures name the values they were generated for.

import { b64uDec,              } from './statements.js'

const EC_SIGN = { name: 'ECDSA', namedCurve: 'P-256' }         
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' }         
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const HALF_N = N >> 1n

const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_BE = 0x08, FLAG_BS = 0x10, FLAG_AT = 0x40, FLAG_ED = 0x80

/** Size limits, generous against every measured assertion (≈ 37 and ≈ 300 bytes). */
export const MAX_AUTH_DATA = 1024
export const MAX_CLIENT_DATA = 4096
const MAX_DEPTH = 16
/** WebAuthn's minimum challenge length; bento's (a SHA-256) is 32. */
export const MIN_CHALLENGE = 16

                            
                              
                           
                                                    
                        
                                                                             
                   
 

                                
                                                                         
                   
                                                                                
                                                                                            
                       
                                                    
              
                                                                          
                            
                                                                          
                                                                             
                                                                            
                                                                         
                                                                                        
                          
 

                                
                   
                                                                      
             
             
                                                           
                
 

const no = (reason        )                                => ({ ok: false, reason })

const te = new TextEncoder()
/** fatal, and a byte-order mark is KEPT (so it reaches the parser and fails) */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

async function sha256(b            )                      {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', b                ))
}
function same(a            , b            )          {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

// --- strict JSON with duplicate-key detection ---------------------------------

/** A parsed JSON value. Objects are Maps so no key (`__proto__` included) is special. */
                                                                                

class Dup extends Error {}

/**
 * RFC 8259 JSON, strictly: no comments, no trailing commas, no leading zeros,
 * no unescaped control characters, no lone surrogates in escapes, whitespace
 * only of the four JSON kinds. Every object's keys are compared AFTER
 * unescaping, so `"origin"` and `"origin"` are the same key.
 * Returns the value, 'duplicate' or null (any other error).
 */
export function parseStrictJson(text        )                            {
  let i = 0
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++ }
  const fail = ()        => { throw new SyntaxError('json') }
  const str = ()         => {
    if (text[i] !== '"') fail()
    i++
    let out = ''
    for (;;) {
      if (i >= text.length) fail()
      const c = text.charCodeAt(i)
      if (c === 0x22) { i++; return out }
      if (c < 0x20) fail()
      if (c !== 0x5c) { out += text[i++]; continue }
      const e = text[i + 1]
      i += 2
      if (e === 'u') {
        const unit = (at        ) => {
          const h = text.slice(at, at + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(h)) fail()
          return parseInt(h, 16)
        }
        const u = unit(i)
        i += 4
        if (u >= 0xd800 && u <= 0xdbff) {
          if (text[i] !== '\\' || text[i + 1] !== 'u') fail()
          const l = unit(i + 2)
          if (l < 0xdc00 || l > 0xdfff) fail()
          i += 6
          out += String.fromCharCode(u, l)
        } else if (u >= 0xdc00 && u <= 0xdfff) fail()
        else out += String.fromCharCode(u)
      } else {
        const m                         = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
        if (e === undefined || !(e in m)) fail()
        out += m[e]
      }
    }
  }
  const value = (depth        )       => {
    if (depth > MAX_DEPTH) fail()
    ws()
    const c = text[i]
    if (c === '{') {
      i++
      const obj = new Map              ()
      ws()
      if (text[i] === '}') { i++; return obj }
      for (;;) {
        ws()
        const k = str()
        if (obj.has(k)) throw new Dup()
        ws()
        if (text[i++] !== ':') fail()
        obj.set(k, value(depth + 1))
        ws()
        const d = text[i++]
        if (d === '}') return obj
        if (d !== ',') fail()
      }
    }
    if (c === '[') {
      i++
      const arr         = []
      ws()
      if (text[i] === ']') { i++; return arr }
      for (;;) {
        arr.push(value(depth + 1))
        ws()
        const d = text[i++]
        if (d === ']') return arr
        if (d !== ',') fail()
      }
    }
    if (c === '"') return str()
    for (const [lit, v] of [['true', true], ['false', false], ['null', null]]         ) {
      if (text.startsWith(lit, i)) { i += lit.length; return v }
    }
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i))
    if (!m) fail()
    i += m [0].length
    return Number(m [0])
  }
  try {
    const v = value(0)
    ws()
    return i === text.length ? v : null
  } catch (e) {
    return e instanceof Dup ? 'duplicate' : null
  }
}

// --- strict DER --------------------------------------------------------------

const toBig = (b            ) => b.reduce((x, v) => (x << 8n) | BigInt(v), 0n)
function to32(x        )             {
  const out = new Uint8Array(32)
  for (let i = 31; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n }
  return out
}

/**
 * DER `SEQUENCE { INTEGER r, INTEGER s }` → raw r‖s, strictly: short-form
 * lengths (an ES256 signature is at most 72 bytes), minimal positive integers,
 * r and s in 1..n−1, nothing trailing. Null otherwise. High-S passes through;
 * see `normaliseS`.
 */
export function derToRaw(der            )                    {
  if (der.length < 8 || der.length > 72 || der[0] !== 0x30 || der[1] !== der.length - 2) return null
  const out = new Uint8Array(64)
  let i = 2
  for (let p = 0; p < 2; p++) {
    if (der[i] !== 0x02) return null
    const len = der[i + 1]
    if (len === undefined || len < 1 || len > 33 || i + 2 + len > der.length) return null
    const v = der.subarray(i + 2, i + 2 + len)
    if (v[0] & 0x80) return null                          // negative
    if (len > 1 && v[0] === 0 && !(v[1] & 0x80)) return null // not minimal
    const x = toBig(v)
    if (x <= 0n || x >= N) return null
    out.set(to32(x), p * 32)
    i += 2 + len
  }
  return i === der.length ? out : null
}

export const isHighS = (raw            ) => toBig(raw.subarray(32)) > HALF_N

/** The low-S twin of a raw signature: (r, s) and (r, n−s) verify alike. */
export function normaliseS(raw            )             {
  if (!isHighS(raw)) return raw
  const out = new Uint8Array(64)
  out.set(raw.subarray(0, 32))
  out.set(to32(N - toBig(raw.subarray(32))), 32)
  return out
}

// --- the verifier ------------------------------------------------------------

/** The challenge a statement is signed under: SHA-256 of its exact UTF-8 text. */
export async function statementChallenge(text        )                      {
  return sha256(te.encode(text))
}

/** Verify a WebAuthn assertion offline. Never throws: every failure is a reason. */
export async function verifyAssertion(a           , opts               )                                  {
  try { return await verify(a, opts) } catch { return no('grammar') }
}

async function verify(a           , opts               )                                  {
  if (!a || typeof a !== 'object') return no('grammar')
  if (typeof opts.rpId !== 'string' || opts.rpId === '' || !Array.isArray(opts.origins) || opts.origins.length === 0 ||
    !(opts.challenge instanceof Uint8Array) || opts.challenge.length < MIN_CHALLENGE) return no('grammar')

  const ad = b64uDec(a.authenticatorData)
  const cdj = b64uDec(a.clientDataJSON)
  const der = b64uDec(a.signature)
  if (!ad || !cdj || !der) return no('grammar')
  if (ad.length < 37 || ad.length > MAX_AUTH_DATA || cdj.length > MAX_CLIENT_DATA) return no('grammar')
  const flags = ad[32]
  if (flags & FLAG_AT) return no('grammar')
  if (!(flags & FLAG_ED) && ad.length !== 37) return no('grammar')
  if ((flags & FLAG_ED) && ad.length === 37) return no('grammar')
  if ((flags & FLAG_BS) && !(flags & FLAG_BE)) return no('grammar')

  let cdText        
  try { cdText = strictUtf8.decode(cdj) } catch { return no('grammar') }
  const cd = parseStrictJson(cdText)
  if (cd === 'duplicate') return no('duplicate-key')
  if (!(cd instanceof Map)) return no('grammar')

  if (cd.get('type') !== 'webauthn.get') return no('type')
  const ch = cd.get('challenge')
  const chBytes = typeof ch === 'string' ? b64uDec(ch) : null
  if (!chBytes || !same(chBytes, opts.challenge)) return no('challenge')
  const origin = cd.get('origin')
  if (typeof origin !== 'string' || !opts.origins.includes(origin)) return no('origin')
  if (cd.has('crossOrigin') && cd.get('crossOrigin') !== false) return no('cross-origin')
  if (cd.has('topOrigin')) return no('cross-origin')

  if (!same(ad.subarray(0, 32), await sha256(te.encode(opts.rpId)))) return no('rp')
  if (!(flags & FLAG_UP)) return no('up')
  if (!(flags & FLAG_UV)) return no('uv')

  const raw0 = derToRaw(der)
  if (!raw0) return no('signature')
  const raw = normaliseS(raw0)
  const pub = b64uDec(opts.publicKey)
  if (!pub || pub.length !== 65 || pub[0] !== 0x04) return no('key')
  let key           
  try { key = await crypto.subtle.importKey('raw', pub                , EC_SIGN, false, ['verify']) } catch { return no('key') }
  const signed = new Uint8Array(ad.length + 32)
  signed.set(ad)
  signed.set(await sha256(cdj), ad.length)
  if (!(await crypto.subtle.verify(SIGN_ALG, key, raw                , signed                ))) return no('signature')

  const signCount = ((ad[33] << 24) >>> 0) + (ad[34] << 16) + (ad[35] << 8) + ad[36]
  const stored = opts.storedSignCount
  if (stored !== undefined) {
    if (!Number.isSafeInteger(stored) || stored < 0) return no('grammar')
    if ((signCount !== 0 || stored !== 0) && signCount <= stored) return no('sign-count')
  }
  return { ok: true, value: { signCount, be: !!(flags & FLAG_BE), bs: !!(flags & FLAG_BS), highS: isHighS(raw0) } }
}
