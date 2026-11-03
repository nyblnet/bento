// GENERATED from kernel/src/link.ts by scripts/gen-webext-id.mjs — do not edit.
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/id — device linking, link v1: one protocol for every pair of hosts.
//
// Linking hands a NEW device (N) the account key and the recovery kx, from a
// device that HOLDS them (H). It is the most sensitive transfer after recovery,
// so every agent must derive the same bytes: this module is the reference, and
// the `link` section of kernel/fixtures/identity-v1.json is the contract.
//
// The DISPLAYER (D) is whichever side cannot scan (a desktop, the extension);
// the SCANNER (S) is a phone, or a person typing the code. Either H or N may
// display; the steps are the same both ways.
//
//   1. D mints an 80-bit LINK CODE in the recovery-code format (recovery.ts:
//      XXXX-XXXX-XXXX-XXXX-C) and an ephemeral ECDH P-256 key e_D. From the
//      code, by HKDF: the slot `id`, its `tok`, and a `salt` (linkSlot).
//   2. D writes msg0 = `lnk0.<E_D>.<H|N>` to the slot and shows the code.
//   3. S parses the code, derives the same slot, reads msg0, checks D's claimed
//      role against its own state (scannerMayProceed), mints e_S and writes
//      msg1 = `lnk1.<E_S>`.
//   4. Both compute the transcript t = linkTranscript(id, E_D, E_S, roleD) and,
//      from Z = ECDH(e, E_other) with the CODE-derived salt, the keys:
//      h2n (H → N), n2h (N → H) and the SAS (linkKeys). The directory holds both
//      ephemerals but never the code, so it can derive none of them, and an
//      ephemeral it substitutes changes the SAS.
//   5. N SHOWS the 6-digit SAS; the person TYPES it into H. One attempt: a
//      mismatch ends the slot.
//   6. N → H, msg2 (sealed under n2h, message number 2): the OFFER — N's
//      devicePub, consentPub (empty on the light tier), its own kx (mode C),
//      label and platform, with a proof of possession over `lnkp.v1.<t>` by
//      devicePub and by consentPub (buildOffer / openOffer).
//   7. H draws its consent, gets a single-use `dir` challenge, issues N's dev.
//      certificate and signs a cns. (purpose `link`, audience `dir`) over that
//      dev. text. msg3 = `lnk3` and seven lines: H's dev. + sig, the cns. + sig,
//      N's dev. + sig, and SEALED = the account blob plaintext (recovery.ts
//      packScalars: account scalar ‖ recovery kx scalar, 64 bytes) under h2n,
//      message number 3 (buildFinal). The directory releases msg3 to N only if
//      verifyLinkRelease accepts it, once per slot.
//   8. N checks the dev. it was issued names exactly the keys it offered, opens
//      SEALED and matches both scalars to the binding the directory served under
//      a PINNED directory key (openFinal).
//
// What this module does NOT do: the slot transport, the single-scanner rule, the
// one-completion-per-slot rule and the notifications are the directory's; the
// rule that an id.bento.page/l# link never starts the H side is each host's UI.
//
// Every AES-GCM message carries AAD = `lnka.v1.<t>.<n>`: the transcript and the
// message number. Each key seals exactly one message number in one direction
// (n2h seals 2, h2n seals 3), chosen here from the number, never by the caller.

import {
  b64uEnc, b64uDec, sha256b64u, isSigningKey, isKxKey, verifyStatementSig, verifyDev, verifyConsent,
  displayText, parseBind,                                              
} from './statements.js'
import { formatRecoveryCode, parseRecoveryCode, unpackScalars, CODE_BYTES, BLOB_LEN,                              } from './recovery.js'

const no = (reason        )                                => ({ ok: false, reason })
const te = new TextEncoder()
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

// --- the link code and the slot -------------------------------------------------------

/** The link code is a recovery code in every byte: 10 bytes, printed XXXX-XXXX-XXXX-XXXX-C. */
export const LINK_CODE_BYTES = CODE_BYTES
export const formatLinkCode = formatRecoveryCode
export const parseLinkCode = parseRecoveryCode

async function hkdf(ikm            , salt            , info        )                      {
  const k = await crypto.subtle.importKey('raw', ikm                , 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt                , info: te.encode(info)                 }, k, 256))
}
const EMPTY = new Uint8Array(0)

                           
                                                           
            
                                                                                                             
             
                                                                             
                  
 

/** id, tok, salt = HKDF-SHA-256(code bytes, empty salt, "bento/id/link/v1/{id,tok,salt}"). */
export async function linkSlot(code            )                    {
  if (!(code instanceof Uint8Array) || code.length !== CODE_BYTES) throw new Error('a link code is 10 bytes')
  return {
    id: b64uEnc(await hkdf(code, EMPTY, 'bento/id/link/v1/id')),
    tok: b64uEnc(await hkdf(code, EMPTY, 'bento/id/link/v1/tok')),
    salt: await hkdf(code, EMPTY, 'bento/id/link/v1/salt'),
  }
}

/** What the directory stores for a slot's token: b64u(SHA-256(the token's 32 bytes)). */
export async function linkTokHash(tok        )                         {
  const b = b64uDec(tok)
  if (!b || b.length !== 32) return null
  return b64uEnc(new Uint8Array(await crypto.subtle.digest('SHA-256', b                )))
}

// --- strict text ---------------------------------------------------------------------

const MAX_LINE = 4096
function printable(text        )          {
  if (text.length === 0 || text.length > MAX_LINE) return false
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x21 || c > 0x7e) return false
  }
  return true
}
/** Split on '.', keeping empty fields: exact prefix and count, printable ASCII only. */
function fields(text         , prefix        , count        )                  {
  if (typeof text !== 'string' || !printable(text)) return null
  const p = text.split('.')
  return p.length === count && p[0] === prefix ? p : null
}
const isSig = (f        ) => b64uDec(f)?.length === 64

// --- msg0, msg1: the ephemerals (in clear on the slot) -------------------------------

                                

export const buildMsg0 = (eD        , roleD          )         => `lnk0.${eD}.${roleD}`
export const buildMsg1 = (eS        )         => `lnk1.${eS}`

export async function parseMsg0(text        )                                                    {
  const p = fields(text, 'lnk0', 3)
  if (!p || (p[2] !== 'H' && p[2] !== 'N')) return no('grammar')
  if (!(await isKxKey(p[1]))) return no('key')
  return { ok: true, value: { eD: p[1], roleD: p[2] } }
}

export async function parseMsg1(text        )                                   {
  const p = fields(text, 'lnk1', 2)
  if (!p) return no('grammar')
  if (!(await isKxKey(p[1]))) return no('key')
  return { ok: true, value: { eS: p[1] } }
}

/**
 * The scanner's check of the role the displayer claims (security §39.1 cond. 2):
 * exactly one side holds the account. D claims H → S must hold none (S is N);
 * D claims N → S must hold one (S is H). Anything else aborts.
 *
 * A host must ALSO never start the H side from an id.bento.page/l# link or a
 * camera intent: on a device that holds an account, H-role linking starts only
 * from the in-app "Link a new device" action (cond. 1). That is UI, not bytes.
 */
export function scannerMayProceed(roleD          , scannerHoldsAccount         )          {
  return roleD === 'H' ? !scannerHoldsAccount : roleD === 'N' && scannerHoldsAccount
}

// --- the transcript, the keys and the SAS --------------------------------------------

/**
 * t = b64u(SHA-256(UTF-8("lnkt.v1." ‖ id ‖ "." ‖ E_D ‖ "." ‖ E_S ‖ "." ‖ roleD))),
 * every part in its wire form. Null if the two ephemerals are the same point (a
 * reflected msg0).
 */
export async function linkTranscript(id        , eD        , eS        , roleD          )                         {
  if (eD === eS || (roleD !== 'H' && roleD !== 'N')) return null
  return sha256b64u(`lnkt.v1.${id}.${eD}.${eS}.${roleD}`)
}

                           
                           
                 
                           
                 
                                                                
                    
                                                         
             
 

/**
 * From the ECDH shared secret Z (the x-coordinate, 32 bytes), the code-derived
 * salt and the transcript t:
 *   h2n    = HKDF-SHA-256(Z, salt, "bento/id/link/v1/h2n." ‖ t)
 *   n2h    = HKDF-SHA-256(Z, salt, "bento/id/link/v1/n2h." ‖ t)
 *   sasKey = HKDF-SHA-256(Z, salt, "bento/id/link/v1/sas." ‖ t)
 */
export async function linkKeysFromShared(z            , salt            , t        )                    {
  if (z.length !== 32 || salt.length !== 32) throw new Error('Z and the salt are 32 bytes')
  const sasKey = await hkdf(z, salt, `bento/id/link/v1/sas.${t}`)
  return {
    h2n: await hkdf(z, salt, `bento/id/link/v1/h2n.${t}`),
    n2h: await hkdf(z, salt, `bento/id/link/v1/n2h.${t}`),
    sasKey,
    sas: sasDigits(sasKey),
  }
}

/** Z = ECDH(own ephemeral private key, the other side's public point), then linkKeysFromShared. */
export async function linkKeys(own           , otherPub        , salt            , t        )                           {
  const raw = b64uDec(otherPub)
  if (!raw || raw.length !== 65 || raw[0] !== 4) return null
  let z            
  try {
    const other = await crypto.subtle.importKey('raw', raw                , { name: 'ECDH', namedCurve: 'P-256' }, false, [])
    z = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: other }, own, 256))
  } catch { return null }
  return linkKeysFromShared(z, salt, t)
}

/**
 * The SAS: the first 4 bytes of sasKey as a big-endian unsigned integer, mod
 * 1,000,000, zero-padded to 6 digits. (2^32 mod 10^6 = 967,296, so the lower
 * values are more likely by one part in 4,295: no help to a guesser with one try.)
 */
export function sasDigits(sasKey            )         {
  const v = ((sasKey[0] << 24) | (sasKey[1] << 16) | (sasKey[2] << 8) | sasKey[3]) >>> 0
  return String(v % 1_000_000).padStart(6, '0')
}

/** Does what the person typed into H equal the SAS? Spaces and hyphens are ignored; nothing else is. */
export function sasMatches(typed        , sas        )          {
  const s = typed.replace(/[\s-]/g, '')
  return /^[0-9]{6}$/.test(s) && /^[0-9]{6}$/.test(sas) && s === sas
}

// --- AES-GCM: AAD = the transcript and the message number ----------------------------

                             
/** The AAD for message n: UTF-8 of "lnka.v1." ‖ t ‖ "." ‖ n. */
export const linkAad = (t        , n           )         => `lnka.v1.${t}.${n}`
const keyFor = (keys          , n           ) => (n === 2 ? keys.n2h : keys.h2n)

/** Seal message n: wire = b64u(iv (12 bytes) ‖ ciphertext ‖ tag (16 bytes)). The iv
 *  is fresh random bytes in an agent; each key seals one message in its life. */
export async function sealLinkMsg(keys          , n           , t        , iv            , plaintext            )                  {
  if (n !== 2 && n !== 3) throw new Error('link v1 seals messages 2 and 3 only')
  if (iv.length !== 12) throw new Error('the iv is 12 bytes')
  const k = await crypto.subtle.importKey('raw', keyFor(keys, n)                , 'AES-GCM', false, ['encrypt'])
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv                , additionalData: te.encode(linkAad(t, n))                , tagLength: 128 }, k, plaintext                ))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv); out.set(ct, 12)
  return b64uEnc(out)
}

export async function openLinkMsg(keys          , n           , t        , wire        )                             {
  if (n !== 2 && n !== 3) return null
  const b = b64uDec(wire)
  if (!b || b.length < 12 + 16) return null
  try {
    const k = await crypto.subtle.importKey('raw', keyFor(keys, n)                , 'AES-GCM', false, ['decrypt'])
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b.subarray(0, 12)                , additionalData: te.encode(linkAad(t, n))                , tagLength: 128 },
      k, b.subarray(12)                ))
  } catch { return null }
}

// --- msg2: N's offer -------------------------------------------------------------------

                            
                   
                                                                   
                           
                                                                          
            
                      
                                                                         
                  
 

const PLATFORM_RE = /^[a-z][a-z0-9-]{0,31}$/

/** What N's devicePub and consentPub each sign to prove it holds them: `lnkp.v1.<t>`. */
export const linkPopText = (t        )         => `lnkp.v1.${t}`

/** `lnk2.<devicePub>.<consentPub|empty>.<kx>.<b64u(label)|empty>.<platform>.<popDevice>.<popConsent|empty>` */
export function buildOffer(o           , popDevice        , popConsent               )         {
  return ['lnk2', o.devicePub, o.consentPub ?? '', o.kx, o.label ? b64uEnc(te.encode(o.label)) : '',
    o.platform, popDevice, popConsent ?? ''].join('.')
}

/**
 * H's check of the offer plaintext: the grammar, every key a valid point (the
 * consent key distinct from the device key, the kx distinct from both), a
 * display-safe label, and each proof of possession over THIS transcript. A
 * consent PoP is present exactly when a consentPub is.
 */
export async function verifyOffer(text        , t        )                              {
  const p = fields(text, 'lnk2', 8)
  if (!p) return no('grammar')
  const [, devicePub, consentF, kxF, labelF, platform, popDevice, popConsentF] = p
  if (!PLATFORM_RE.test(platform) || !isSig(popDevice) || (popConsentF !== '' && !isSig(popConsentF))) return no('grammar')
  if (!(await isSigningKey(devicePub))) return no('key')
  let consentPub                = null
  if (consentF !== '') {
    if (consentF === devicePub || !(await isSigningKey(consentF))) return no('consent-key')
    consentPub = consentF
  }
  if (kxF === '' || kxF === devicePub || kxF === consentF || !(await isKxKey(kxF))) return no('kx')
  let label                = null
  if (labelF !== '') { label = displayText(labelF); if (label === null) return no('label') }
  if ((consentPub === null) !== (popConsentF === '')) return no('pop-consent')
  const pop = linkPopText(t)
  if (!(await verifyStatementSig(devicePub, popDevice, pop))) return no('pop-device')
  if (consentPub !== null && !(await verifyStatementSig(consentPub, popConsentF, pop))) return no('pop-consent')
  return { ok: true, value: { devicePub, consentPub, kx: kxF, label, platform } }
}

/** H opens msg2 (n2h, message 2) and checks the offer. */
export async function openOffer(keys          , t        , wire        )                              {
  const pt = await openLinkMsg(keys, 2, t, wire)
  if (!pt) return no('decrypt')
  let text        
  try { text = strictUtf8.decode(pt) } catch { return no('grammar') }
  return verifyOffer(text, t)
}

// --- msg3: H's completion, checked by the directory and then by N --------------------

                            
                                                                       
                               
                                                                                           
                             
                                                                       
                               
                                                                       
                
 

/** The sealed payload on the wire: iv ‖ the 64-byte blob plaintext ‖ tag. */
const SEALED_LEN = 12 + BLOB_LEN + 16

/** msg3: "lnk3" and the seven fields, one per line, joined by "\n" (no line may be empty). */
export function buildFinal(f           )         {
  return ['lnk3', f.hDev, f.hDevSig, f.cns, f.cnsSig, f.nDev, f.nDevSig, f.sealed].join('\n')
}

function parseFinal(text         )                   {
  if (typeof text !== 'string' || text.length > 8 * (MAX_LINE + 1)) return null
  const l = text.split('\n')
  if (l.length !== 8 || l[0] !== 'lnk3' || !l.every(printable)) return null
  const [, hDev, hDevSig, cns, cnsSig, nDev, nDevSig, sealed] = l
  if (!isSig(hDevSig) || !isSig(cnsSig) || !isSig(nDevSig) || b64uDec(sealed)?.length !== SEALED_LEN) return null
  return { hDev, hDevSig, cns, cnsSig, nDev, nDevSig, sealed }
}

/**
 * The DIRECTORY's check before it releases msg3 to N (security §39.1). It
 * brings the binding it serves as authoritative for the account (bindText) and
 * its state, the `dir` challenge it issued to H's session, and `spend`, which
 * must mark that challenge used and return false if it was already spent or has
 * expired. spend is called once msg3 and its cns. parse, before anything else,
 * so every attempt consumes its challenge; every refusal before the spend is
 * `grammar`. Then: the binding must be `active` (pending or frozen: nothing is
 * released); H's dev. must verify and name the binding's account key, and carry
 * a consent key; the cns. must verify under that consent key with audience
 * `dir`, this challenge and N's dev. text as its payload; and N's dev. must
 * verify and name the same account key.
 *
 * The directory accepts ONE msg3 per slot and deletes the slot on a second
 * attempt (cond. 5); that is its state, not these bytes. A light-tier H (no
 * consent key) consents by WebAuthn (§9.6c), which is not this message: it is
 * refused here with `h-no-consent`.
 */
export async function verifyLinkRelease(text        , opts   
                  
                 
                   
             
                                       
 )                                                           {
  const f = parseFinal(text)
  if (!f || !fields(f.cns, 'cns', 6)) return no('grammar')
  if (!opts.spend(opts.challenge)) return no('replay')
  if (opts.state !== 'active') return no('state')
  const bind = await parseBind(opts.bindText)
  if (!bind.ok) return no('bind')
  const h = await verifyDev(f.hDev, f.hDevSig, { now: opts.now })
  if (!h.ok) return no(`h-dev-${h.reason}`)
  if (h.value.accountPub !== bind.value.accountPub) return no('h-account')
  if (h.value.consentPub === null) return no('h-no-consent')
  const c = await verifyConsent(f.cns, f.cnsSig, {
    consentPub: h.value.consentPub, rp: 'bento', audience: 'dir', challenge: opts.challenge,
    payloadText: f.nDev, docId: null, now: opts.now, spend: () => true, // spent above
  })
  if (!c.ok) return no(`cns-${c.reason}`)
  if (c.value.purpose !== 'link') return no('cns-purpose')
  const n = await verifyDev(f.nDev, f.nDevSig, { now: opts.now })
  if (!n.ok) return no(`n-dev-${n.reason}`)
  if (n.value.accountPub !== bind.value.accountPub) return no('n-account')
  return { ok: true, value: { sealed: f.sealed, device: n.value } }
}

/**
 * N's check of msg3 before it stores anything (security §39.1 cond. 4). `offer`
 * is exactly what N sent in msg2; `binding` is the account key and recovery kx
 * of the binding the directory served under a PINNED directory key. N's dev.
 * must verify, name that account key, and name N's own devicePub, consentPub
 * and kx; SEALED must open under h2n as message 3; and both scalars must be in
 * range and match the binding (recovery.ts unpackScalars). Any refusal: abort
 * and delete the slot.
 */
export async function openFinal(text        , opts   
                
           
                  
                   
             
 )                                                                                        {
  const f = parseFinal(text)
  if (!f) return no('grammar')
  const n = await verifyDev(f.nDev, f.nDevSig, { now: opts.now })
  if (!n.ok) return no(`dev-${n.reason}`)
  if (n.value.accountPub !== opts.binding.accountPub) return no('account')
  if (n.value.devicePub !== opts.offer.devicePub) return no('device-mismatch')
  if (n.value.consentPub !== opts.offer.consentPub) return no('consent-mismatch')
  if (n.value.kx !== opts.offer.kx) return no('kx-mismatch')
  const pt = await openLinkMsg(opts.keys, 3, opts.t, f.sealed)
  if (!pt) return no('decrypt')
  const u = await unpackScalars(pt, opts.binding)
  if (!u.ok) return u
  return { ok: true, value: { keys: u.value, device: n.value, dev: f.nDev, devSig: f.nDevSig } }
}
