// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/id, option G: DEVICE CERTIFICATES made by a passkey, and the
// directory's logged countersign that keeps one in force.
//
// Under option G no account key exists, so a device key is certified by a
// roster member (roster.ts). This module defines what a passkey can certify:
//
//   wdev.  a BROWSER device key: a fresh, non-extractable key made for each
//          ceremony (bento/home asks the sign-in host for it)
//   dev2.  a NATIVE device key with its hardware consent key (replaces K2's
//          dev.). Certified by a passkey alone it is shown exactly like a
//          browser (G1, below)
//   watt.  the directory's countersign: "I logged this enrolment (or its
//          renewal); good until expires". A certificate is in force only
//          beside a current watt.
//   wren.  the device key's request for a fresh watt. Checked by the
//          directory only; a peer never sees one.
//
// The family rules are statements.ts's and roster.ts's: dot-joined printable
// ASCII, signed over the exact bytes, strict field counts, empty fields only
// where allowed, epoch milliseconds. kernel/fixtures/device-v1.json is the
// conformance contract.
//
// --- wdev. ---------------------------------------------------------------------
//
//   wdev.<devicePub>.<kx>.<b64u(address)>.<rosHash>.<b64u(label)|empty>.<via>.<ceremonyAt>.<dirNonce>
//
//   devicePub   the browser's signing key (ECDSA P-256, raw point)
//   kx          the browser's key-agreement key (ECDH P-256), never equal to
//               devicePub
//   address     in normal form, the roster's address
//   rosHash     sha256 of a roster head (ros. text): the head H the signer was
//               a member of when it signed (the head rule, below)
//   label       display text (statements.ts rules), at most 40 characters,
//               chosen by the page that asked; optional
//   via         `passkey`: an assertion by a roster passkey over this text.
//               `cns`: a native consent co-signature (route D). Its purpose
//               (`web-add`) is not defined yet, so it is REFUSED (fail closed)
//   ceremonyAt  the directory's challenge time for this ceremony. The 7-day
//               cap counts from it, so the directory refuses a wdev. whose
//               ceremonyAt is not its own challenge time
//   dirNonce    the directory challenge the ceremony was bound to
//
// --- dev2. ---------------------------------------------------------------------
//
//   dev2.<devicePub>.<consentPub|empty>.<kx>.<b64u(address)>.<rosHash>.<b64u(label)|empty>.<via>.<ceremonyAt>.<dirNonce>
//
// wdev.'s fields plus the device's hardware consent key (empty where the
// device has none). via is `passkey` (an assertion over this text) or `ck` (a
// ripe consent key's signature): the `roster` consent purpose that defines a
// ck's signature is the next kernel change, so `ck` is REFUSED until then.
//
// --- watt. ---------------------------------------------------------------------
//
//   watt.<sha256(certificate text)>.<ob>.<loggedAt>.<expires>.<kid>
//
// Signed by the directory key `kid` (raw r‖s, low-S). ob is 0 or 1: the
// request's Origin was bento/home's (informative; the lever reads its log,
// never this field). loggedAt and expires are the directory's clock:
//   - 0 < expires − loggedAt ≤ 24 h
//   - expires ≤ ceremonyAt + 7 days, counted from the certificate's ORIGINAL
//     ceremony: a renewal is a NEW watt. over the SAME certificate text, so a
//     peer always sees the original assertion and caps from it
//   - loggedAt ≥ ceremonyAt (nothing is logged before its ceremony)
//
// --- wren. ---------------------------------------------------------------------
//
//   wren.<devicePub>.<b64u(address)>.<challenge>
//
// Signed by the device key itself (raw r‖s, low-S) over a single-use directory
// challenge. The directory answers it with a fresh watt. while the 7-day cap
// allows. Peers never verify it.
//
// --- the head rule (security's ruling on #925, item 5) ----------------------------
//
// With H = the head named by rosHash, and the signer the passkey that asserted:
//   1. H is a head of the chain the verifier accepted (verifyRosterChain's
//      `heads`). A verifier may verify an earlier segment (from setup or an
//      older pin) to place H: the pin is a trust floor, not a knowledge limit.
//      H not placeable (a fork head, older than anything verified) is refused:
//      the device makes a new ceremony.
//   2. The signer is an UNQUARANTINED `pk` member of H AND of the current head.
//      Removed or quarantined since: the certificate dies at every peer holding
//      the new head. A `u` undo revives it, consistent with "undo".
//   3. No break since H: the signer's `since` in the current state ≤
//      H.ripenedAt. `since` restarts on re-add and on reset, so a passkey removed
//      and added again, or any key across a reset, cannot carry an old
//      certificate. From a pin `since` is the pin's ripenedAt, ≥ the truth, so
//      the check only refuses more.
//   4. ceremonyAt ≥ H.ripenedAt (a certificate cannot predate the roster it
//      names), and the watt.'s loggedAt ≥ ceremonyAt.
// A peer a head behind is bounded by watt.'s 24 hours.
//
// --- the tier (G1) ----------------------------------------------------------------
//
// Anything authorised by a passkey alone is shown as "(passkey sign-in)":
// every wdev., and a passkey-made dev2. UNTIL its consent key has been an
// unquarantined `ck` member of the current roster for at least 72 hours (read
// from RosterState.members[].since: exact from setup, and from a pin a lower
// bound on the age, so a pinned verifier can only say passkey more often).
// Then a dev2. is shown at native tier. One label for every passkey-only
// device on every host: a page can mint a passkey-only dev2. as well, so a
// peer must not be shown a difference that does not exist.

import { isNormalAddress } from './address.ts'
import { b64uDec, b64uEnc, sha256b64u, isSigningKey, isKxKey, verifyStatementSig, displayText, SKEW_MS, type Verdict } from './statements.ts'
import { verifyAssertion, statementChallenge, type Assertion } from './webauthn.ts'
import { ROSTER_WAIT_MS, type RosterState } from './roster.ts'

/** Prefixes this module defines. (statements.ts still lists them as reserved,
 *  so nothing else takes them.) */
export const DEVICE_PREFIXES: readonly string[] = Object.freeze(['wdev', 'dev2', 'watt', 'wren'])

const HOUR = 3_600_000
/** A watt. lives at most 24 hours. */
export const WATT_MAX_MS = 24 * HOUR
/** No watt. reaches past 7 days after the certificate's original ceremony. */
export const CEREMONY_CAP_MS = 7 * 24 * HOUR
/** A consent key ripens, for the tier, after 72 hours of membership. */
export const CK_RIPE_MS = ROSTER_WAIT_MS
/** The longest label a device certificate carries (the sign-in host's limit). */
export const MAX_LABEL = 40

export type Tier = 'passkey' | 'native'

const no = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })
const te = new TextEncoder()
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

const MAX_STATEMENT = 4096
function fields(text: unknown, prefix: string, count: number): string[] | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_STATEMENT) return null
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x21 || c > 0x7e) return null
  }
  const parts = text.split('.')
  return parts.length === count && parts[0] === prefix ? parts : null
}
const INT_RE = /^(0|[1-9][0-9]{0,15})$/
const int = (f: string) => { if (!INT_RE.test(f)) return null; const n = Number(f); return Number.isSafeInteger(n) ? n : null }
const ms = (f: string) => { const n = int(f); return n !== null && n > 0 ? n : null }
const isHash = (f: string) => b64uDec(f)?.length === 32
const isNonce = (f: string) => { const b = b64uDec(f); return !!b && b.length >= 16 && b.length <= 64 }
const KID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
function freeText(f: string): string | null {
  const b = b64uDec(f)
  if (!b) return null
  let t: string
  try { t = strictUtf8.decode(b) } catch { return null }
  return b64uEnc(te.encode(t)) === f ? t : null
}
const str = (v: unknown): v is string => typeof v === 'string'

// --- wdev. and dev2. ---------------------------------------------------------------

export type CertKind = 'wdev' | 'dev2'

export interface DeviceCert {
  kind: CertKind
  devicePub: string
  /** dev2. only; null where the device has no hardware consent key (and always for wdev.) */
  consentPub: string | null
  kx: string
  address: string
  rosHash: string
  label: string | null
  /** wdev.: passkey | cns; dev2.: passkey | ck. Only `passkey` is defined. */
  via: string
  ceremonyAt: number
  dirNonce: string
}

const VIA: Record<CertKind, readonly string[]> = { wdev: ['passkey', 'cns'], dev2: ['passkey', 'ck'] }

export function buildDeviceCert(c: DeviceCert): string {
  const label = c.label ? b64uEnc(te.encode(c.label)) : ''
  const addr = b64uEnc(te.encode(c.address))
  return c.kind === 'wdev'
    ? ['wdev', c.devicePub, c.kx, addr, c.rosHash, label, c.via, c.ceremonyAt, c.dirNonce].join('.')
    : ['dev2', c.devicePub, c.consentPub ?? '', c.kx, addr, c.rosHash, label, c.via, c.ceremonyAt, c.dirNonce].join('.')
}

/** The grammar of a wdev. or dev2. text (no signatures, no roster). */
export async function parseDeviceCert(text: string): Promise<Verdict<DeviceCert>> {
  const kind: CertKind | null = typeof text === 'string' && text.startsWith('wdev.') ? 'wdev' : typeof text === 'string' && text.startsWith('dev2.') ? 'dev2' : null
  if (kind === null) return no('grammar')
  const p = fields(text, kind, kind === 'wdev' ? 9 : 10)
  if (!p) return no('grammar')
  const [devicePub, consentF, kxF, addressF, rosHash, labelF, via, ceremonyF, dirNonce] =
    kind === 'wdev' ? [p[1], '', ...p.slice(2)] : p.slice(1)
  if (!(await isSigningKey(devicePub))) return no('key')
  let consentPub: string | null = null
  if (consentF !== '') {
    if (!(await isSigningKey(consentF)) || consentF === devicePub) return no('consent-key')
    consentPub = consentF
  }
  if (!(await isKxKey(kxF)) || kxF === devicePub || kxF === consentF) return no('kx')
  const address = freeText(addressF)
  if (address === null || !isNormalAddress(address)) return no('address')
  if (!isHash(rosHash)) return no('grammar')
  let label: string | null = null
  if (labelF !== '') {
    label = displayText(labelF)
    if (label === null || [...label].length > MAX_LABEL) return no('label')
  }
  if (!VIA[kind].includes(via)) return no('grammar')
  const ceremonyAt = ms(ceremonyF)
  if (ceremonyAt === null || !isNonce(dirNonce)) return no('grammar')
  return { ok: true, value: { kind, devicePub, consentPub, kx: kxF, address, rosHash, label, via, ceremonyAt, dirNonce } }
}

// --- watt. -------------------------------------------------------------------------

export interface Watt {
  certHash: string
  ob: 0 | 1
  loggedAt: number
  expires: number
  kid: string
}

export function buildWatt(w: Watt): string {
  return ['watt', w.certHash, w.ob, w.loggedAt, w.expires, w.kid].join('.')
}

export function parseWatt(text: string): Verdict<Watt> {
  const p = fields(text, 'watt', 6)
  if (!p) return no('watt-grammar')
  const [, certHash, obF, loggedF, expiresF, kid] = p
  if (!isHash(certHash) || (obF !== '0' && obF !== '1') || !KID_RE.test(kid)) return no('watt-grammar')
  const loggedAt = ms(loggedF), expires = ms(expiresF)
  if (loggedAt === null || expires === null) return no('watt-grammar')
  return { ok: true, value: { certHash, ob: obF === '1' ? 1 : 0, loggedAt, expires, kid } }
}

// --- wren. ---------------------------------------------------------------------------

export interface Renewal { devicePub: string; address: string; challenge: string }

export function buildWren(r: Renewal): string {
  return ['wren', r.devicePub, b64uEnc(te.encode(r.address)), r.challenge].join('.')
}

/** For the DIRECTORY: a renewal request signed by the device key it names. The
 *  directory still checks the challenge is its own, unspent, and that the
 *  device's certificate is logged, unrevoked and inside its 7-day cap. */
export async function verifyWren(text: string, sig: string): Promise<Verdict<Renewal>> {
  const p = fields(text, 'wren', 4)
  if (!p) return no('grammar')
  const [, devicePub, addressF, challenge] = p
  if (!(await isSigningKey(devicePub))) return no('key')
  const address = freeText(addressF)
  if (address === null || !isNormalAddress(address)) return no('address')
  if (!isNonce(challenge)) return no('grammar')
  if (!str(sig) || !(await verifyStatementSig(devicePub, sig, text))) return no('signature')
  return { ok: true, value: { devicePub, address, challenge } }
}

// --- a certificate as it travels -------------------------------------------------------

export interface DeviceProof {
  /** the wdev. or dev2. text */
  cert: string
  /** the passkey that asserted (its pub) */
  signer: string
  /** its WebAuthn assertion over the certificate text */
  assertion: Assertion
  /** the directory's current countersign, and its signature */
  watt: string
  wattSig: string
}

export interface DeviceOpts {
  /** the roster, as verifyRosterChain returned it */
  roster: RosterState
  /** pinned directory keys by kid */
  directoryKeys: Readonly<Record<string, string>>
  rpId: string
  origins: readonly string[]
  now: number
}

export interface VerifiedDevice {
  cert: DeviceCert
  /** passkey: shown "(passkey sign-in)"; native: a dev2. whose consent key is ripe */
  tier: Tier
  watt: Watt
  /** ripenedAt of the head the certificate names */
  headRipenedAt: number
}

/**
 * Verify a device certificate offline against a verified roster. Never throws.
 * The first failing check decides the reason.
 */
export async function verifyDevice(proof: DeviceProof, opts: DeviceOpts): Promise<Verdict<VerifiedDevice>> {
  try { return await device(proof, opts) } catch { return no('grammar') }
}

async function device(proof: DeviceProof, opts: DeviceOpts): Promise<Verdict<VerifiedDevice>> {
  if (!proof || typeof proof !== 'object' || !str(proof.cert) || !str(proof.signer) || !proof.assertion ||
    !str(proof.watt) || !str(proof.wattSig)) return no('grammar')
  const ro = opts.roster
  if (!ro || !Array.isArray(ro.heads) || !Array.isArray(ro.members) || typeof opts.rpId !== 'string' || opts.rpId === '' ||
    !Array.isArray(opts.origins) || opts.origins.length === 0 || !Number.isSafeInteger(opts.now)) return no('grammar')

  const c = await parseDeviceCert(proof.cert)
  if (!c.ok) return c
  const cert = c.value
  if (cert.via !== 'passkey') return no('via')   // cns (web-add) and ck (roster) are the next kernel change
  if (cert.address !== ro.address) return no('address')

  // the head rule
  const H = ro.heads.find((h) => h.hash === cert.rosHash)
  if (!H) return no('roster-head')
  if (cert.ceremonyAt < H.ripenedAt) return no('ceremony')
  const inH = H.members.find((m) => m.pub === proof.signer)
  if (!inH) return no('signer')
  if (inH.kind !== 'pk') return no('signer-kind')
  if (inH.quarantined) return no('signer-quarantined')
  const cur = ro.members.find((m) => m.pub === proof.signer)
  if (!cur) return no('signer-removed')
  if (cur.quarantined) return no('signer-quarantined')
  if (cur.since > H.ripenedAt) return no('signer-break')

  const a = await verifyAssertion(proof.assertion, { publicKey: proof.signer, challenge: await statementChallenge(proof.cert),
    rpId: opts.rpId, origins: opts.origins })
  if (!a.ok) return no(`assertion-${a.reason}`)

  // the directory's logged countersign
  const w = parseWatt(proof.watt)
  if (!w.ok) return w
  const watt = w.value
  if (watt.certHash !== (await sha256b64u(proof.cert))) return no('watt-mismatch')
  if (!Object.hasOwn(opts.directoryKeys, watt.kid)) return no('watt-unknown-kid')
  if (!(await verifyStatementSig(opts.directoryKeys[watt.kid], proof.wattSig, proof.watt))) return no('watt-signature')
  if (watt.loggedAt < cert.ceremonyAt) return no('watt-order')
  if (watt.expires <= watt.loggedAt || watt.expires - watt.loggedAt > WATT_MAX_MS) return no('watt-lifetime')
  if (watt.expires > cert.ceremonyAt + CEREMONY_CAP_MS) return no('watt-cap')
  // with loggedAt ≥ ceremonyAt above, this also refuses a ceremony from the future
  if (watt.loggedAt > opts.now + SKEW_MS) return no('not-yet-valid')
  if (opts.now >= watt.expires) return no('expired')

  return { ok: true, value: { cert, tier: tierOf(cert, ro, opts.now), watt, headRipenedAt: H.ripenedAt } }
}

/** G1: native only for a dev2. whose consent key has been an unquarantined ck
 *  member of the current roster for 72 hours; every other passkey-made
 *  certificate is "(passkey sign-in)". */
export function tierOf(cert: DeviceCert, roster: RosterState, now: number): Tier {
  if (cert.kind !== 'dev2' || cert.consentPub === null) return 'passkey'
  const ck = roster.members.find((m) => m.pub === cert.consentPub)
  if (!ck || ck.kind !== 'ck' || ck.quarantined) return 'passkey'
  return now - ck.since >= CK_RIPE_MS ? 'native' : 'passkey'
}
