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
//               `cns`: a native consent key's co-sign, purpose `web-add`
//               (route D: a phone approves this browser)
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
// ripe consent key's co-sign, purpose `roster`, over this text).
//
// A co-sign (via cns or ck) travels as `consent: { cns, sig }` in place of the
// assertion. Its signer is an unquarantined `ck` member under the same head
// rule as a passkey, and RIPE: a member for at least 72 h at ceremonyAt (its
// `since` in the verified chain). The cns. is the statements.ts family's:
// audience `dir`, challenge = this certificate's dirNonce, alive at ceremonyAt
// for at most its 5-minute life (verifyCoSign).
//
// --- watt. ---------------------------------------------------------------------
//
//   watt.<sha256(certificate text)>.<ob>.<mb>.<loggedAt>.<expires>.<kid>
//
// Signed by the directory key `kid` (raw r‖s, low-S). ob is 0 or 1: 1 when
// the directory logged the ceremony (or renewal) as made FOR bento/home, i.e.
// the sign-in host reported bento/home as its opener (`rq`), or a renewal came
// from a key first enrolled that way; 0 for a native host's ceremony. Since
// every web ceremony runs on the sign-in host (web-identity-tier §0a), a
// browser's Origin header no longer tells bento/home apart, so ob mirrors the
// log's `rq`, which is trustworthy only while the sign-in host is honest.
// Informative only: no peer acts on it, and the lever reads the directory's
// log, never this field. mb is the account's MAILBOX state: `0` while the address
// is confirmed, else the time (epoch ms, ≤ loggedAt) it went unconfirmed. A
// lapsed mailbox qualifies only the address part of the ✓ ("unconfirmed since
// <date>"), never the account; it rides inside the countersign every
// certificate already needs, so the person presenting the proof cannot drop it.
// loggedAt and expires are the directory's clock:
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
// --- wret. ---------------------------------------------------------------------
//
//   wret.<oldDevicePub>.<newDevicePub|empty>.<b64u(address)>.<dirNonce>
//
// Old-key retirement. Signed by the OLD key W (raw r‖s, low-S); the directory
// RETIRES W (no further renewals), so a copy of W taken earlier dies when its
// current watt. expires, at most 24 h later (security's R2 bound). Two forms:
//   - at a new ceremony, naming the fresh key W′ and the new ceremony's
//     dirNonce: the directory accepts the new wdev. and retires W. The two
//     keys differ.
//   - WITHOUT a successor (newDevicePub empty), over a single-use directory
//     challenge: the library retires W on its own, with no passkey prompt and
//     no new ceremony. It signs this whenever it stops trusting or stops
//     keeping W: before it deletes the key, when the key turns out
//     extractable, at a local sign-out. Without this form a library that
//     drops W before its next ceremony can never retire it, and a copy lives
//     to the 7-day cap plus 24 h.
// The nonce binds the text to exactly one ceremony or challenge, so a
// retirement cannot be replayed. Anyone holding W can retire it, a thief
// included: that only takes away W's renewals, and the honest browser signs in
// again with a passkey. Peers never verify it.
//
// --- inc. ----------------------------------------------------------------------
//
//   inc.<id>.<from>.<to|empty>.<issuedAt>.<kid>
//
// The directory's incident record (web-identity-tier §3.7, lever step 4),
// signed by `kid` like watt. id is [a-z0-9-]{1,64}; from and to are the
// window (epoch ms, to empty while it is still open, else to > from);
// issuedAt ≥ from, not in the future. Apps use it to flag room statements
// signed inside the window ("signed during a security incident: keep or
// revoke?"). A record never revokes anything by itself: the lever's
// revocations reach peers through watt. expiry.
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
// Native tier is a dev2. via `ck`: a ripe consent key's OWN co-sign over the
// whole certificate text (devicePub included), purpose `roster`. Everything
// else is "(passkey sign-in)": every passkey-made certificate, and every wdev.
// (a browser, even one a phone approved). A passkey-made dev2.'s consentPub is
// a CLAIM written by whatever page ran the prompt (security's F1 on #937), so a
// consent key's age on the roster never promotes a certificate: only its
// signature does. A device whose own consent key ripens makes a NEW dev2. that
// its ck co-signs. Native tier still needs a current watt.: the 24 h countersign
// is what lets disable, remove-a-device and the lever reach a native device.

import { isNormalAddress } from './address.ts'
import { b64uDec, b64uEnc, sha256b64u, isSigningKey, isKxKey, verifyStatementSig, verifyCoSign, displayText, SKEW_MS, type Verdict } from './statements.ts'
import { verifyAssertion, statementChallenge, type Assertion } from './webauthn.ts'
import { ROSTER_WAIT_MS, type RosterState } from './roster.ts'

/** Prefixes this module defines. (statements.ts still lists them as reserved,
 *  so nothing else takes them.) */
export const DEVICE_PREFIXES: readonly string[] = Object.freeze(['wdev', 'dev2', 'watt', 'wren', 'wret', 'inc'])

const HOUR = 3_600_000
/** A watt. lives at most 24 hours. */
export const WATT_MAX_MS = 24 * HOUR
/** No watt. reaches past 7 days after the certificate's original ceremony. */
export const CEREMONY_CAP_MS = 7 * 24 * HOUR
/** A consent key may certify a device (via cns or ck) after 72 hours of membership. */
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
  /** wdev.: passkey | cns; dev2.: passkey | ck */
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
  /** 0 while the mailbox is confirmed, else when it went unconfirmed (≤ loggedAt) */
  mb: number
  loggedAt: number
  expires: number
  kid: string
}

export function buildWatt(w: Watt): string {
  return ['watt', w.certHash, w.ob, w.mb, w.loggedAt, w.expires, w.kid].join('.')
}

export function parseWatt(text: string): Verdict<Watt> {
  const p = fields(text, 'watt', 7)
  if (!p) return no('watt-grammar')
  const [, certHash, obF, mbF, loggedF, expiresF, kid] = p
  if (!isHash(certHash) || (obF !== '0' && obF !== '1') || !KID_RE.test(kid)) return no('watt-grammar')
  const loggedAt = ms(loggedF), expires = ms(expiresF)
  if (loggedAt === null || expires === null) return no('watt-grammar')
  const mb = mbF === '0' ? 0 : ms(mbF)
  if (mb === null || mb > loggedAt) return no('watt-grammar')
  return { ok: true, value: { certHash, ob: obF === '1' ? 1 : 0, mb, loggedAt, expires, kid } }
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
  /** the member that certified it (its pub): a passkey, or a consent key */
  signer: string
  /** via passkey: its WebAuthn assertion over the certificate text */
  assertion?: Assertion
  /** via cns / ck: the consent key's cns. over the certificate text, and its signature */
  consent?: { cns: string; sig: string }
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
  /** the rp a consent key's cns. names (`bento`); needed only via cns / ck */
  consentRp?: string
  now: number
}

export interface VerifiedDevice {
  cert: DeviceCert
  /** passkey: shown "(passkey sign-in)". native: a dev2. a ripe consent key co-signed */
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
  if (!proof || typeof proof !== 'object' || !str(proof.cert) || !str(proof.signer) ||
    !str(proof.watt) || !str(proof.wattSig)) return no('grammar')
  const ro = opts.roster
  if (!ro || !Array.isArray(ro.heads) || !Array.isArray(ro.members) || typeof opts.rpId !== 'string' || opts.rpId === '' ||
    !Array.isArray(opts.origins) || opts.origins.length === 0 || !Number.isSafeInteger(opts.now)) return no('grammar')

  const c = await parseDeviceCert(proof.cert)
  if (!c.ok) return c
  const cert = c.value
  const byKey = cert.via !== 'passkey'   // cns (wdev., web-add) or ck (dev2., roster)
  // exactly one proof, the one via names
  if (byKey ? (proof.assertion !== undefined || !proof.consent || typeof proof.consent !== 'object' ||
      !str(proof.consent.cns) || !str(proof.consent.sig)) : (!proof.assertion || proof.consent !== undefined)) return no('proof')
  if (cert.address !== ro.address) return no('address')

  // the head rule
  const H = ro.heads.find((h) => h.hash === cert.rosHash)
  if (!H) return no('roster-head')
  if (cert.ceremonyAt < H.ripenedAt) return no('ceremony')
  const inH = H.members.find((m) => m.pub === proof.signer)
  if (!inH) return no('signer')
  if (inH.kind !== (byKey ? 'ck' : 'pk')) return no('signer-kind')
  if (inH.quarantined) return no('signer-quarantined')
  const cur = ro.members.find((m) => m.pub === proof.signer)
  if (!cur) return no('signer-removed')
  if (cur.quarantined) return no('signer-quarantined')
  if (cur.since > H.ripenedAt) return no('signer-break')

  if (byKey) {
    // a consent key certifies only once ripe: 72 h a member at the ceremony, on the directory's clock
    if (cert.ceremonyAt - cur.since < CK_RIPE_MS) return no('signer-unripe')
    if (typeof opts.consentRp !== 'string' || opts.consentRp === '') return no('grammar')
    const c = await verifyCoSign(proof.consent!.cns, proof.consent!.sig, { consentPub: proof.signer, rp: opts.consentRp,
      purpose: cert.kind === 'wdev' ? 'web-add' : 'roster', payloadText: proof.cert, challenge: cert.dirNonce, at: cert.ceremonyAt })
    if (!c.ok) return no(`consent-${c.reason}`)
  } else {
    const a = await verifyAssertion(proof.assertion!, { publicKey: proof.signer, challenge: await statementChallenge(proof.cert),
      rpId: opts.rpId, origins: opts.origins })
    if (!a.ok) return no(`assertion-${a.reason}`)
  }

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

  return { ok: true, value: { cert, tier: tierOf(cert), watt, headRipenedAt: H.ripenedAt } }
}

/** G1: native only for a dev2. a ripe consent key co-signed (verifyDevice has
 *  checked the co-sign and the ripeness before this is read). A consentPub that
 *  names a ripe ck proves nothing (security, F1 on #937), so the roster is not
 *  read here: native arrives with a consent key's signature, never its age. */
export function tierOf(cert: DeviceCert): Tier {
  return cert.kind === 'dev2' && cert.via === 'ck' ? 'native' : 'passkey'
}

// --- wret. -----------------------------------------------------------------------------

/** newPub null: a retirement without a successor. */
export interface Retirement { oldPub: string; newPub: string | null; address: string; dirNonce: string }

export function buildWret(r: Retirement): string {
  return ['wret', r.oldPub, r.newPub ?? '', b64uEnc(te.encode(r.address)), r.dirNonce].join('.')
}

/** For the DIRECTORY: the OLD key retires itself. With a newPub (at a new
 *  ceremony) the directory still checks dirNonce is that ceremony's own and
 *  newPub is the new wdev.'s devicePub; with none, dirNonce is a challenge it
 *  issued for a retirement. Either way it checks the nonce is unspent and that
 *  oldPub is a key it logged for this address. */
export async function verifyWret(text: string, sig: string): Promise<Verdict<Retirement>> {
  const p = fields(text, 'wret', 5)
  if (!p) return no('grammar')
  const [, oldPub, newF, addressF, dirNonce] = p
  if (!(await isSigningKey(oldPub))) return no('key')
  const newPub = newF === '' ? null : newF
  if (newPub !== null && (!(await isSigningKey(newPub)) || oldPub === newPub)) return no('key')
  const address = freeText(addressF)
  if (address === null || !isNormalAddress(address)) return no('address')
  if (!isNonce(dirNonce)) return no('grammar')
  if (!str(sig) || !(await verifyStatementSig(oldPub, sig, text))) return no('signature')
  return { ok: true, value: { oldPub, newPub, address, dirNonce } }
}

// --- inc. ------------------------------------------------------------------------------

export interface Incident { id: string; from: number; to: number | null; issuedAt: number; kid: string }

const INC_ID_RE = /^[a-z0-9-]{1,64}$/

export function buildInc(i: Incident): string {
  return ['inc', i.id, i.from, i.to ?? '', i.issuedAt, i.kid].join('.')
}

/** An incident record, by a pinned directory key, not issued in the future. */
export async function verifyInc(text: string, sig: string, opts: { directoryKeys: Readonly<Record<string, string>>; now: number }):
  Promise<Verdict<Incident>> {
  const p = fields(text, 'inc', 6)
  if (!p) return no('grammar')
  const [, id, fromF, toF, issuedF, kid] = p
  if (!INC_ID_RE.test(id) || !KID_RE.test(kid)) return no('grammar')
  const from = ms(fromF), issuedAt = ms(issuedF)
  const to = toF === '' ? null : ms(toF)
  if (from === null || issuedAt === null || (toF !== '' && to === null)) return no('grammar')
  if (to !== null && to <= from) return no('grammar')
  if (issuedAt < from) return no('grammar')
  if (!Number.isSafeInteger(opts.now) || !opts.directoryKeys) return no('grammar')
  if (issuedAt > opts.now + SKEW_MS) return no('not-yet-valid')
  if (!Object.hasOwn(opts.directoryKeys, kid)) return no('unknown-kid')
  if (!str(sig) || !(await verifyStatementSig(opts.directoryKeys[kid], sig, text))) return no('signature')
  return { ok: true, value: { id, from, to, issuedAt, kid } }
}

/** Was something signed at `at` inside the incident's window? from inclusive, to exclusive; an open window has no end. */
export const insideIncident = (at: number, i: Incident): boolean => at >= i.from && (i.to === null || at < i.to)
