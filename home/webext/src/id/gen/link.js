// GENERATED from kernel/src/link.ts by scripts/gen-webext-id.mjs — do not edit.
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/id — device linking, link v1: one protocol for every pair of hosts.
//
// Linking hands a NEW device (N) the account key, from a device that HOLDS it
// (H). Never the recovery kx: N gets its history from H re-wrapping to N's own
// kx (security §26c.4). It is the most sensitive transfer after recovery,
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
//      N's dev. + sig, and SEALED = the 32-byte ACCOUNT SCALAR ‖ the ADDRESS in
//      normal form, under h2n, message number 3 (buildFinal). Never the recovery
//      blob: the recovery kx stays out of linking (§26c.4). The address is never
//      in the QR or the code. The directory releases msg3 to N only if
//      verifyLinkRelease accepts it, once per slot.
//   8. N checks the dev. it was issued names exactly the keys it offered, opens
//      SEALED, looks the ADDRESS up, and matches the account scalar to the
//      binding found for that address under a PINNED directory key (openFinal).
//      Then the host asks the person to confirm the address before it stores
//      anything; declining aborts and deletes the slot.
//
// On the slot, each message travels in its WIRE form (encodeSlotMsg /
// decodeSlotMsg): msg0 and msg1 as canonical unpadded base64url of their UTF-8
// text, msg2 as its sealed wire unchanged, msg3 as its text unchanged.
//
// What this module does NOT do: the slot transport, the single-scanner rule, the
// one-completion-per-slot rule and the notifications are the directory's; the
// rule that an id.bento.page/l# link never starts the H side is each host's UI.
//
// UNDER OPTION G (bento/id, KG3) step 7 and msg3 change; steps 1-6, the slot,
// the transcript, the keys and the SAS do not. There is no account scalar to
// hand over: H's ripe consent key CO-SIGNS a dev2. for N instead (cns. purpose
// `roster`, which makes N native at once), and msg3 is the G FINAL, a new label
// (`lnkg`, sealed with AAD `lnkgs.v1.<t>`), so a v1 SEALED payload and a G final
// can never be read as each other. v1's SEALED bytes below are untouched and no
// G host emits them. See "the final under option G" at the end of this file.
//
// Every AES-GCM message carries AAD = `lnka.v1.<t>.<n>`: the transcript and the
// message number. Each key seals exactly one message number in one direction
// (n2h seals 2, h2n seals 3), chosen here from the number, never by the caller.

import {
  b64uEnc, b64uDec, sha256b64u, isSigningKey, isKxKey, verifyStatementSig, verifyDev, verifyConsent, verifyCoSign,
  displayText, parseBind, verifyBind, verifyAtt, SKEW_MS,                                                             
} from './statements.js'
import { parseDeviceCert, CK_RIPE_MS,                             } from './devices.js'
                                              
import { isNormalAddress } from './address.js'
import { formatRecoveryCode, parseRecoveryCode, unpackAccountScalar, CODE_BYTES } from './recovery.js'

const no = (reason        )                                => ({ ok: false, reason })
const te = new TextEncoder()
// ignoreBOM keeps a leading U+FEFF in the text, so the parsers refuse it. Without
// it the decoder swallows the mark, and two byte strings read as one message.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

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

                            
                                                                       
                               
                                                                                           
                             
                                                                       
                               
                                                                                  
                
 

/** SEALED opens to the account scalar, 32 bytes big-endian, then the address. */
export const LINK_SCALAR_LEN = 32
/** The longest address SEALED carries: address.ts allows 254 characters, all ASCII. */
export const LINK_ADDRESS_MAX = 254
/**
 * SEALED on the wire: iv ‖ the account scalar ‖ the address ‖ tag, so its length
 * is a bounded range. A length outside it is `grammar`. Deliberately NOT derived
 * from recovery.ts BLOB_LEN: the recovery blob is account ‖ recovery kx, and
 * linking must never hand N the recovery kx (security §26c.4: link-time history
 * comes from H re-wrapping to N's kx). The directory sees only this length, so
 * the old 64-byte payload now passes its check; N refuses it, as `address`.
 */
export const SEALED_MIN_LEN = 12 + LINK_SCALAR_LEN + 1 + 16
export const SEALED_MAX_LEN = 12 + LINK_SCALAR_LEN + LINK_ADDRESS_MAX + 16

/** The oldest directory answer N will act on (an att.'s issuedAt, as the vectors use). */
export const LINK_ATT_MAX_MS = 10 * 60_000

/** H's SEALED plaintext. Throws rather than seal what no N would open. */
export function linkSealedPlaintext(account            , address        )             {
  if (account.length !== LINK_SCALAR_LEN) throw new Error('an account scalar is 32 bytes')
  if (!isNormalAddress(address)) throw new Error('the address is not in normal form')
  const a = te.encode(address), out = new Uint8Array(LINK_SCALAR_LEN + a.length)
  out.set(account); out.set(a, LINK_SCALAR_LEN)
  return out
}

/** msg3: "lnk3" and the seven fields, one per line, joined by "\n" (no line may be empty). */
export function buildFinal(f           )         {
  return ['lnk3', f.hDev, f.hDevSig, f.cns, f.cnsSig, f.nDev, f.nDevSig, f.sealed].join('\n')
}

function parseFinal(text         )                   {
  if (typeof text !== 'string' || text.length > 8 * (MAX_LINE + 1)) return null
  const l = text.split('\n')
  if (l.length !== 8 || l[0] !== 'lnk3' || !l.every(printable)) return null
  const [, hDev, hDevSig, cns, cnsSig, nDev, nDevSig, sealed] = l
  const sealedLen = b64uDec(sealed)?.length ?? 0
  if (!isSig(hDevSig) || !isSig(cnsSig) || !isSig(nDevSig) || sealedLen < SEALED_MIN_LEN || sealedLen > SEALED_MAX_LEN) return null
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
 * verify, name the same account key, and name a devicePub other than H's.
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
  // the new device must be a NEW key: a dev. for N naming H's own devicePub re-issues H
  if (n.value.devicePub === h.value.devicePub) return no('n-device-is-h')
  return { ok: true, value: { sealed: f.sealed, device: n.value } }
}

/** The directory's answer to a lookup of one address: the binding and its att. */
                             
                                   
                                 
 

/** The address SEALED carries, or null: strict UTF-8, already in normal form. */
function sealedAddress(pt            )                {
  let address        
  try { address = strictUtf8.decode(pt.subarray(LINK_SCALAR_LEN)) } catch { return null }
  return isNormalAddress(address) ? address : null
}

/** The binding for exactly this address, attested `active` under a pinned directory key. */
async function bindingFor(address        , opts   
                                                         
                                                 
             
 )                             {
  let a                   
  try { a = await opts.lookup(address) } catch { return no('lookup') }
  if (!a) return no('lookup')
  const b = await verifyBind(a.bindText, a.bindSig, { now: opts.now })
  if (!b.ok) return no(`bind-${b.reason}`)
  if (b.value.address !== address) return no('address-mismatch')
  const att = await verifyAtt(a.attText, a.attSig, { directoryKeys: opts.directoryKeys, bindText: a.bindText, now: opts.now, maxAgeMs: LINK_ATT_MAX_MS })
  if (!att.ok) return no(`att-${att.reason}`)
  if (att.value.state !== 'active') return no('state')
  return b
}

/**
 * N's check of msg3 before it stores anything (security §39.1 cond. 4). `offer`
 * is exactly what N sent in msg2. N's dev. must verify and name N's own
 * devicePub, consentPub and kx; SEALED must open under h2n as message 3 and
 * carry an address in normal form. Only then does N look that address up:
 * `lookup` returns the directory's answer for it (null if it has none), and
 * `directoryKeys` are the keys N pinned. The binding must verify, be for exactly
 * this address, and be attested `active` under a pinned key. The scalar must be
 * in range and the private half of that binding's accountPub (recovery.ts
 * unpackAccountScalar), and N's dev. must name the same key. The binding's
 * recovery kx plays no part: N never receives it.
 *
 * Any refusal: abort and delete the slot. On success nothing is stored yet: the
 * host shows the returned address and name for the person to confirm first.
 */
export async function openFinal(text        , opts   
                
           
                  
                                                         
                                                 
             
 )                                                                                                                                   {
  const f = parseFinal(text)
  if (!f) return no('grammar')
  const n = await verifyDev(f.nDev, f.nDevSig, { now: opts.now })
  if (!n.ok) return no(`dev-${n.reason}`)
  if (n.value.devicePub !== opts.offer.devicePub) return no('device-mismatch')
  if (n.value.consentPub !== opts.offer.consentPub) return no('consent-mismatch')
  if (n.value.kx !== opts.offer.kx) return no('kx-mismatch')
  const pt = await openLinkMsg(opts.keys, 3, opts.t, f.sealed)
  if (!pt) return no('decrypt')
  const address = sealedAddress(pt)
  if (address === null) return no('address')
  const b = await bindingFor(address, opts)
  if (!b.ok) return b
  const u = await unpackAccountScalar(pt.subarray(0, LINK_SCALAR_LEN), b.value.accountPub)
  if (!u.ok) return u
  if (n.value.accountPub !== b.value.accountPub) return no('account')
  return { ok: true, value: { account: u.value, address, name: b.value.name, device: n.value, dev: f.nDev, devSig: f.nDevSig } }
}

// --- the slot wire ---------------------------------------------------------------------

                                     
/** No slot message is longer than this once decoded: 4 KiB. */
export const MAX_SLOT_MSG = 4096

/**
 * A message as it is written to the slot. msg0 and msg1: canonical unpadded
 * base64url of the UTF-8 text. msg2: the sealed wire (already base64url),
 * unchanged. msg3: the text, unchanged. Throws on a message no peer would
 * decode (the wrong prefix, or over MAX_SLOT_MSG), so an agent never writes one.
 */
export function encodeSlotMsg(n           , msg        )         {
  if (!decodable(n, msg)) throw new Error(`not a link v1 message ${n}`)
  return n === 0 || n === 1 ? b64uEnc(te.encode(msg)) : msg
}

/**
 * The slot wire back to the message, or `grammar`. msg0/msg1: canonical
 * base64url only (no padding, zero trailing bits; a raw `lnk0.` text is
 * refused), strict UTF-8, and the decoded text must carry its own prefix.
 * msg2: canonical base64url of at least an iv and a tag. msg3: text starting
 * `lnk3` (or option G's `lnkg`) and a line feed. Every message is at most MAX_SLOT_MSG bytes once
 * decoded, which for msg2 means the sealed bytes, not their text. The parsers (parseMsg0,
 * parseMsg1, openOffer, verifyLinkRelease, openFinal) still check what this
 * returns; this only fixes how the bytes travel.
 */
export function decodeSlotMsg(n           , wire        )                  {
  if (typeof wire !== 'string' || wire.length === 0) return no('grammar')
  let text        
  if (n === 0 || n === 1) {
    const b = b64uDec(wire)
    if (!b || b.length > MAX_SLOT_MSG) return no('grammar')
    try { text = strictUtf8.decode(b) } catch { return no('grammar') } // a byte-order mark stays, and fails the prefix
  } else text = wire
  return decodable(n, text) ? { ok: true, value: text } : no('grammar')
}

/** What every slot message satisfies once decoded: its prefix and its size. The
 *  size is always of the DECODED message, which for msg2 is the sealed bytes, not
 *  their base64url text: canonical, at least an iv and a tag, at most 4096 bytes. */
function decodable(n           , text        )          {
  if (typeof text !== 'string' || text.length === 0) return false
  if (n === 2) { const b = b64uDec(text); return !!b && b.length >= 12 + 16 && b.length <= MAX_SLOT_MSG }
  if (te.encode(text).length > MAX_SLOT_MSG) return false
  if (n === 0) return text.startsWith('lnk0.')
  if (n === 1) return text.startsWith('lnk1.')
  if (n === 3) return text.startsWith('lnk3\n') || text.startsWith('lnkg\n')   // v1's final, or option G's
  return false
}

// --- the final under option G (msg3, H → N): a co-sign, not a scalar ----------------------
//
//   lnkg
//   <dev2. text>   N's certificate: N's devicePub, consentPub and kx as offered in
//                  msg2, via `ck`, the head H's consent key is a member of, and the
//                  directory's ceremonyAt and dirNonce (H asked for the challenge)
//   <ck>           H's consent key (raw point, base64url): the co-signer
//   <cns.>         H's ck's cns., purpose `roster`, audience `dir`, challenge = the
//                  dev2.'s dirNonce, over the exact dev2. text
//   <cns sig>      its raw low-S signature
//   <seal>         b64u( iv (12) ‖ AES-256-GCM under h2n, AAD UTF-8("lnkgs.v1." ‖ t),
//                  of SHA-256(UTF-8 of the five lines above joined by "\n") ‖ tag (16) ),
//                  exactly 60 bytes
//
// Nothing here is secret (the directory sees all of it, and countersigns the
// dev2. with a watt.). The seal is what the SAS buys: N knows these exact lines
// came from the H whose code it scanned, so the directory cannot swap in a
// certificate for another key or another account. N then confirms the address
// (it is in the dev2.) with the person, and checks the whole certificate with
// verifyDevice once the directory's watt. and roster chain arrive. Adding N's
// own consent key to the roster is a separate roster change, which H's ripe ck
// may sign or co-sign (roster.ts).

/** The AAD the G final's seal carries. */
export const linkGAad = (t        )         => `lnkgs.v1.${t}`
/** The seal is always this long: iv, a SHA-256 digest, the tag. */
export const LINK_G_SEAL_LEN = 12 + 32 + 16

                                                                                                   

const finalGBody = (f                          ) => ['lnkg', f.dev2, f.ck, f.cns, f.cnsSig].join('\n')

/** H builds the G final: the four lines, then the seal over them under h2n. The
 *  iv is fresh random bytes in an agent. */
export async function buildFinalG(f                          , keys          , t        , iv            )                  {
  if (iv.length !== 12) throw new Error('the iv is 12 bytes')
  const body = finalGBody(f)
  if (!parseFinalG(`${body}\n${b64uEnc(new Uint8Array(LINK_G_SEAL_LEN))}`)) throw new Error('not a G final')
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(body)                ))
  const k = await crypto.subtle.importKey('raw', keys.h2n                , 'AES-GCM', false, ['encrypt'])
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv                , additionalData: te.encode(linkGAad(t))                , tagLength: 128 }, k, digest                ))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv); out.set(ct, 12)
  return `${body}\n${b64uEnc(out)}`
}

/** The G final's lines, or null: six lines, `lnkg` first, printable ASCII, the
 *  ck a key-sized field, the signature 64 bytes and the seal exactly 60. */
export function parseFinalG(text         )                    {
  if (typeof text !== 'string' || text.length > MAX_SLOT_MSG) return null
  const l = text.split('\n')
  if (l.length !== 6 || l[0] !== 'lnkg' || !l.every(printable)) return null
  const [, dev2, ck, cns, cnsSig, seal] = l
  if (b64uDec(ck)?.length !== 65 || !isSig(cnsSig) || b64uDec(seal)?.length !== LINK_G_SEAL_LEN) return null
  return { dev2, ck, cns, cnsSig, seal }
}

/**
 * N's check of the G final before it shows anything (the G form of openFinal).
 * `offer` is exactly what N sent in msg2. The seal must open under h2n with
 * the G AAD and equal the hash of the five lines; the dev2. must parse, be via
 * `ck`, and name exactly N's devicePub, consentPub and kx; H's ck must not be
 * one of N's own keys; and its cns. must verify (purpose roster, over the dev2.,
 * bound to its dirNonce, alive at its ceremonyAt). Whether H's ck is a RIPE
 * member is the roster's to say: verifyDevice, with the watt. and the chain,
 * before N stores anything. Any refusal: abort and delete the slot.
 */
export async function openFinalG(text        , opts                                                                    ) 
                                                                                  {
  const f = parseFinalG(text)
  if (!f) return no('grammar')
  const b = b64uDec(f.seal) 
  let digest            
  try {
    const k = await crypto.subtle.importKey('raw', opts.keys.h2n                , 'AES-GCM', false, ['decrypt'])
    digest = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b.subarray(0, 12)                , additionalData: te.encode(linkGAad(opts.t))                , tagLength: 128 },
      k, b.subarray(12)                ))
  } catch { return no('decrypt') }
  const want = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(finalGBody(f))                ))
  if (digest.length !== 32 || !digest.every((x, i) => x === want[i])) return no('seal')
  const c = await parseDeviceCert(f.dev2)
  if (!c.ok) return no(`dev-${c.reason}`)
  const cert = c.value
  if (cert.kind !== 'dev2') return no('dev-kind')
  if (cert.via !== 'ck') return no('via')
  if (cert.devicePub !== opts.offer.devicePub) return no('device-mismatch')
  if (cert.consentPub !== opts.offer.consentPub) return no('consent-mismatch')
  if (cert.kx !== opts.offer.kx) return no('kx-mismatch')
  if (f.ck === cert.devicePub || f.ck === cert.consentPub) return no('ck-is-n')
  const v = await verifyCoSign(f.cns, f.cnsSig, { consentPub: f.ck, rp: opts.consentRp, purpose: 'roster', payloadText: f.dev2,
    challenge: cert.dirNonce, at: cert.ceremonyAt })
  if (!v.ok) return no(`cns-${v.reason}`)
  return { ok: true, value: { cert, dev2: f.dev2, ck: f.ck, address: cert.address } }
}

/**
 * The DIRECTORY's check before it releases a G final to N and countersigns the
 * dev2. with a watt. It brings the account's verified roster, the challenge it
 * issued to H's session (which must be the dev2.'s dirNonce and its ceremonyAt
 * its own challenge time), and `spend` (called once the final parses; every
 * refusal before it is `grammar`). H's ck must be an unquarantined ck member of
 * the CURRENT head, ripe (72 h a member at ceremonyAt), and its cns. must
 * verify live (verifyConsent: audience `dir`, this challenge, purpose roster).
 * The seal is N's to check: the directory does not hold h2n.
 */
export async function verifyLinkReleaseG(text        , opts   
                     
                   
                   
             
                                       
 )                                                                 {
  const f = parseFinalG(text)
  if (!f || !fields(f.cns, 'cns', 6)) return no('grammar')
  const ro = opts.roster
  if (!ro || !Array.isArray(ro.members) || !Number.isSafeInteger(opts.now)) return no('grammar')
  if (!opts.spend(opts.challenge)) return no('replay')
  const c = await parseDeviceCert(f.dev2)
  if (!c.ok) return no(`dev-${c.reason}`)
  const cert = c.value
  if (cert.kind !== 'dev2' || cert.via !== 'ck') return no('via')
  if (cert.dirNonce !== opts.challenge) return no('challenge')
  if (cert.address !== ro.address) return no('address')
  if (cert.rosHash !== ro.headHash) return no('roster-head')
  if (cert.ceremonyAt > opts.now + SKEW_MS) return no('not-yet-valid')
  const m = ro.members.find((x) => x.pub === f.ck)
  if (!m) return no('signer')
  if (m.kind !== 'ck') return no('signer-kind')
  if (m.quarantined) return no('signer-quarantined')
  if (cert.ceremonyAt - m.since < CK_RIPE_MS) return no('signer-unripe')
  if (f.ck === cert.devicePub || f.ck === cert.consentPub) return no('ck-is-n')
  const v = await verifyConsent(f.cns, f.cnsSig, { consentPub: f.ck, rp: opts.consentRp, audience: 'dir', challenge: opts.challenge,
    payloadText: f.dev2, docId: null, now: opts.now, spend: () => true })   // spent above
  if (!v.ok) return no(`cns-${v.reason}`)
  if (v.value.purpose !== 'roster') return no('cns-purpose')
  return { ok: true, value: { cert, dev2: f.dev2, ck: f.ck } }
}
