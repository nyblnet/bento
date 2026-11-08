// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/id — the signed statements: one definition of every byte, for every host.
//
// Identity is keys, and everything anyone trusts is a SIGNED STATEMENT: "this
// device is mine" (dev.), "this key is alice@example.com" (bind.), "the directory
// checked that binding" (att.), "this person consented to exactly this action"
// (cns.), and the directory's deletion record, delete request and email-code
// completion (tomb., del., cmp.), the account's requests to the directory
// (dreq.) and the old key's vouch for a rotation (rot.). The agents (Swift,
// Kotlin, Rust, and the extension's JS) build and check them, and so do the
// directory and the document. If two of them read the same bytes differently,
// a signature means different things to different verifiers. So this module is
// the reference, and kernel/fixtures/identity-v1.json is the conformance
// contract every host must pass.
//
// THE FAMILY RULES — the same as the shipped collab statements (inv./dlg./rev.):
//   - A statement is dot-joined UTF-8 text, signed over its EXACT bytes. Nobody
//     re-serialises or canonicalises; the text is stored and hashed verbatim.
//     No JSON ever sits inside a signed statement.
//   - Every field is either a token from a CLOSED, dot-free grammar (a purpose
//     word, a kid, an integer) or FREE TEXT encoded as base64url without padding
//     (an email address, a display name). A raw email would break the split: it
//     has dots.
//   - Parsing is strict: split on '.', keep empty fields, require the EXACT field
//     count, check every field against its grammar. A stray field is a rejection,
//     never a re-join. The whole text must be printable ASCII.
//   - An ABSENT value is an EMPTY field, and only where its grammar allows one.
//   - Times are epoch MILLISECONDS, everywhere.
//   - The VERSION is the prefix: `bind.` is version 1; a breaking change is `bind2.`.
//   - Keys are raw uncompressed P-256 points (65 bytes), base64url. Signatures are
//     raw r‖s (64 bytes), base64url, LOW-S — never DER. A host whose platform
//     emits DER converts before anything crosses the bridge; a high-S or DER
//     signature here is a rejection, so a forgotten conversion fails loudly.

import { isNormalAddress } from './address.ts'
import { DISPLAY_FORBIDDEN_FLAT, DISPLAY_FORBIDDEN_UNICODE } from './display-table.ts'
import type { SignPurpose } from './identity.ts'

// --- strict base64url --------------------------------------------------------

const B64U_RE = /^[A-Za-z0-9_-]*$/

export function b64uEnc(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Canonical base64url only: the alphabet, no padding, and it must re-encode to
 *  exactly the same string (so trailing bits are zero). Null otherwise. */
export function b64uDec(s: string): Uint8Array | null {
  if (typeof s !== 'string' || !B64U_RE.test(s) || s.length % 4 === 1) return null
  let bin: string
  try { bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)) } catch { return null }
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return b64uEnc(out) === s ? out : null
}

const te = new TextEncoder()
const utf8 = (s: string) => te.encode(s)
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/** base64url-of-UTF-8 → text, canonical both ways; null if not. */
function freeText(f: string): string | null {
  const b = b64uDec(f)
  if (!b) return null
  let t: string
  try { t = strictUtf8.decode(b) } catch { return null }
  return b64uEnc(utf8(t)) === f ? t : null
}

/**
 * Display text a person sees (a name, a device label): bounded, in NFC, and free
 * of anything invisible or layout-changing that could make "alice ✓" read as
 * something else on screen. Refused:
 *   - controls (Cc), private use (Co), line and paragraph separators (Zl, Zp);
 *   - UNASSIGNED code points (Cn), the 66 noncharacters among them: one assigned
 *     later could be an invisible format character, and NFC is stable across
 *     Unicode versions only for assigned characters (security, #764);
 *   - every format character (Cf): bidi overrides and marks (including U+061C),
 *     zero-width space, word joiner, BOM, soft hyphen, the Mongolian vowel
 *     separator — EXCEPT ZWNJ/ZWJ (U+200C/U+200D), which Persian, Indic scripts
 *     and emoji sequences need, and which are refused only at either end;
 *   - the Hangul fill letters U+115F, U+1160, U+3164, U+FFA0, which render blank.
 * No filter stops homoglyphs, so a name is SELF-ASSERTED and must never be shown
 * without the verified address beside it (docs/DECISIONS.md).
 *
 * The set is FROZEN as explicit code-point ranges, not resolved through `\p{…}`.
 * General categories come from each platform's Unicode tables, so a character
 * newly assigned to Cf would be refused by one host and accepted by another until
 * both updated, and a name would verify on one device and not the next. These
 * ranges are the categories above as of Unicode 17.0, generated into
 * kernel/src/display-table.ts by scripts/gen-display-table.ts (which refuses to
 * run on any other Unicode version); the fixture carries the same table for the
 * native hosts, and the rig recomputes it. Changing it is a deliberate format
 * decision, never a side effect of a platform update.
 */
const MAX_DISPLAY = 64
export { DISPLAY_FORBIDDEN_UNICODE }
/** The frozen table as [first, last] pairs (kernel/src/display-table.ts, generated). */
export const DISPLAY_FORBIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = Object.freeze(
  Array.from({ length: DISPLAY_FORBIDDEN_FLAT.length / 2 },
    (_, i) => Object.freeze([DISPLAY_FORBIDDEN_FLAT[2 * i], DISPLAY_FORBIDDEN_FLAT[2 * i + 1]]) as readonly [number, number])
)
/** Is this code point refused in display text? A binary search over the frozen ranges. */
export function displayForbidden(cp: number): boolean {
  let lo = 0, hi = DISPLAY_FORBIDDEN_RANGES.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [a, b] = DISPLAY_FORBIDDEN_RANGES[mid]
    if (cp < a) hi = mid - 1
    else if (cp > b) lo = mid + 1
    else return true
  }
  return false
}
const ZWNJ = 0x200c, ZWJ = 0x200d
/** A display-text FIELD (base64url of UTF-8) → the text, or null if refused. */
export function displayText(f: string): string | null {
  const t = freeText(f)
  if (t === null || t.length === 0) return null
  const cps = [...t].map((c) => c.codePointAt(0)!)
  if (cps.length > MAX_DISPLAY) return null
  if (t.normalize('NFC') !== t) return null
  if (cps.some(displayForbidden)) return null
  const ends = [cps[0], cps[cps.length - 1]]
  if (ends.some((c) => c === ZWNJ || c === ZWJ)) return null
  return t
}

export async function sha256b64u(text: string): Promise<string> {
  return b64uEnc(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(text) as BufferSource)))
}

// --- keys and signatures -----------------------------------------------------

const EC_SIGN = { name: 'ECDSA', namedCurve: 'P-256' } as const
const EC_KX = { name: 'ECDH', namedCurve: 'P-256' } as const
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const
/** the P-256 group order */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const HALF_N = N >> 1n

const toBig = (b: Uint8Array) => b.reduce((x, v) => (x << 8n) | BigInt(v), 0n)
function to32(x: bigint): Uint8Array {
  const out = new Uint8Array(32)
  for (let i = 31; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n }
  return out
}

/** A raw r‖s signature in range with s in the lower half. */
function sigInRange(sig: Uint8Array): boolean {
  if (sig.length !== 64) return false
  const r = toBig(sig.subarray(0, 32)), s = toBig(sig.subarray(32))
  return r > 0n && r < N && s > 0n && s <= HALF_N
}

/** The low-S form of a raw r‖s signature (what every signer must emit). */
export function lowS(sig: Uint8Array): Uint8Array {
  const s = toBig(sig.subarray(32))
  if (s <= HALF_N) return sig
  const out = new Uint8Array(64)
  out.set(sig.subarray(0, 32))
  out.set(to32(N - s), 32)
  return out
}

/** A raw uncompressed P-256 point that the platform accepts for `alg`. */
async function point(b64: string, alg: typeof EC_SIGN | typeof EC_KX): Promise<CryptoKey | null> {
  const raw = b64uDec(b64)
  if (!raw || raw.length !== 65 || raw[0] !== 0x04) return null
  try {
    return await crypto.subtle.importKey('raw', raw as BufferSource, alg, false,
      alg.name === 'ECDSA' ? ['verify'] : [])
  } catch { return null }
}
export const isSigningKey = async (b64: string) => (await point(b64, EC_SIGN)) !== null
export const isKxKey = async (b64: string) => (await point(b64, EC_KX)) !== null

/** Verify `sigB64` (raw r‖s, low-S) by `pubB64` over the exact UTF-8 of `text`. */
export async function verifyStatementSig(pubB64: string, sigB64: string, text: string): Promise<boolean> {
  const sig = b64uDec(sigB64)
  if (!sig || !sigInRange(sig)) return false
  const key = await point(pubB64, EC_SIGN)
  if (!key) return false
  try { return await crypto.subtle.verify(SIGN_ALG, key, sig as BufferSource, utf8(text) as BufferSource) } catch { return false }
}

/** Sign `text` with `key`, emitting the low-S raw form. For JS agents and the
 *  vector generator; native agents produce the same bytes from their key stores. */
export async function signStatement(key: CryptoKey, text: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign(SIGN_ALG, key, utf8(text) as BufferSource))
  return b64uEnc(lowS(sig))
}

// --- strict parsing ------------------------------------------------------------

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string }
const no = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })

const MAX_STATEMENT = 4096

/** Split a statement: printable ASCII only, exact prefix and field count, empty
 *  fields kept. `count` includes the prefix. */
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
function int(f: string): number | null {
  if (!INT_RE.test(f)) return null
  const n = Number(f)
  return Number.isSafeInteger(n) ? n : null
}
const ms = (f: string) => { const n = int(f); return n !== null && n > 0 ? n : null }
/** a SHA-256 digest, base64url (32 bytes, 43 characters) */
const isHash = (f: string) => b64uDec(f)?.length === 32

const KID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
const RP_RE = /^(bento|vault-[a-z0-9][a-z0-9-]{0,62})$/
const DOCID_RE = /^[A-Za-z0-9_-]{1,128}$/          // security §19i
const ROOM_RE = /^w[A-Za-z0-9_-]{43}$/             // 'w' + b64u(sha256(owner pub))
/** The email code: exactly 8 characters from a 31-character alphabet with no
 *  0/O or 1/I/L, always UPPERCASE (agents uppercase what was typed before
 *  signing). About 39.6 bits, behind 5 attempts and a 20-minute TTL. */
const CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/

/** Clock skew tolerated for "issued in the future". */
export const SKEW_MS = 5 * 60_000
const DAY = 86_400_000
/** A certificate lives at most 13 months, plus a day of slack: 13 × 30.5 days + 1. */
export const CERT_MAX_MS = (13 * 30.5 + 1) * DAY

function lifetime(created: number, expires: number, now: number): string | null {
  if (expires <= created) return 'lifetime'
  if (expires - created > CERT_MAX_MS) return 'lifetime'
  if (created > now + SKEW_MS) return 'not-yet-valid'
  if (now >= expires) return 'expired'
  return null
}

// --- kx placement: mode C (ruled 2026-11-02, identity-design §6b) -------------

/**
 * Where the key-agreement key lives was the maintainer's decision (§6b), ruled C:
 * a PER-DEVICE kx in every dev. AND a RECOVERY kx in every bind. Both slots are
 * REQUIRED. There is no other mode and no lenient path: an empty slot is refused,
 * and so is a kx that is not a valid ECDH P-256 point or that repeats a signing
 * key of the same certificate. The recovery kx's private scalar travels in the
 * account blob (recovery.ts, 64 bytes); a device's own kx never leaves it.
 */
export const KX_MODE = 'C' as const

/** A kx slot: required, a valid ECDH point, never equal to any signing key in
 *  the same certificate. */
async function kxSlot(f: string, others: string[]): Promise<string | false> {
  if (f === '' || !(await isKxKey(f)) || others.includes(f)) return false
  return f
}

// --- dev. — the device certificate (signed by the account key) ---------------

/**
 * `dev.<devicePub>.<consentPub|empty>.<accountPub>.<kx>.<b64u(label)|empty>.<created>.<expires>`
 *
 * Binds this device's ROUTINE key and its hardware CONSENT key to the account.
 * The consent key is a separate, non-exportable key (Secure Enclave
 * `.userPresence`, a BiometricPrompt-bound Keystore key, Windows Hello); a
 * consent statement (cns.) is accepted only from a key certified here. The light
 * tier has no hardware consent key, so consentPub is empty there, and that
 * device can never produce an accepted cns.
 */
export interface DeviceCert {
  devicePub: string
  consentPub: string | null
  accountPub: string
  /** this device's key-agreement key (ECDH P-256); required (§6b mode C) */
  kx: string
  label: string | null
  created: number
  expires: number
}

export function buildDev(c: DeviceCert): string {
  return ['dev', c.devicePub, c.consentPub ?? '', c.accountPub, c.kx,
    c.label ? b64uEnc(utf8(c.label)) : '', c.created, c.expires].join('.')
}

export async function verifyDev(text: string, sig: string, opts: { now: number }):
  Promise<Verdict<DeviceCert>> {
  const p = fields(text, 'dev', 8)
  if (!p) return no('grammar')
  const [, devicePub, consentF, accountPub, kxF, labelF, createdF, expiresF] = p
  if (!(await isSigningKey(devicePub)) || !(await isSigningKey(accountPub))) return no('key')
  if (devicePub === accountPub) return no('key')
  let consentPub: string | null = null
  if (consentF !== '') {
    if (!(await isSigningKey(consentF)) || consentF === devicePub || consentF === accountPub) return no('consent-key')
    consentPub = consentF
  }
  const kx = await kxSlot(kxF, [devicePub, accountPub, consentF])
  if (kx === false) return no('kx')
  let label: string | null = null
  if (labelF !== '') { label = displayText(labelF); if (label === null) return no('label') }
  const created = ms(createdF), expires = ms(expiresF)
  if (created === null || expires === null) return no('grammar')
  const life = lifetime(created, expires, opts.now)
  if (life) return no(life)
  if (!(await verifyStatementSig(accountPub, sig, text))) return no('signature')
  return { ok: true, value: { devicePub, consentPub, accountPub, kx, label, created, expires } }
}

// --- bind. — the person certificate (signed by the account key) --------------

/**
 * `bind.<b64u(address)>.<accountPub>.<kx>.<b64u(name)|empty>.<seq>.<prev|empty>.<created>.<expires>`
 *
 * "This account key is this address", signed by the holder; the directory then
 * attests it (att.). `address` must already be in normal form (address.ts).
 * `seq` starts at 1; `prev` is the hash of the previous bind. text for this
 * address, empty exactly when seq is 1, so a rotation chain cannot be forked
 * silently.
 */
export interface BindCert {
  address: string
  accountPub: string
  /** the account's RECOVERY key-agreement key (ECDH P-256); required (§6b mode C).
   *  Its private scalar rides in the account blob (recovery.ts). */
  kx: string
  name: string | null
  seq: number
  prev: string | null
  created: number
  expires: number
}

export function buildBind(c: BindCert): string {
  return ['bind', b64uEnc(utf8(c.address)), c.accountPub, c.kx,
    c.name ? b64uEnc(utf8(c.name)) : '', c.seq, c.prev ?? '', c.created, c.expires].join('.')
}

/** The grammar of a bind. text, without its lifetime or signature: shared by
 *  verifyBind and verifyRotation (which must read the PINNED binding even after
 *  it has expired). */
export async function parseBind(text: string): Promise<Verdict<BindCert>> {
  const p = fields(text, 'bind', 9)
  if (!p) return no('grammar')
  const [, addressF, accountPub, kxF, nameF, seqF, prevF, createdF, expiresF] = p
  const address = freeText(addressF)
  if (address === null || !isNormalAddress(address)) return no('address')
  if (!(await isSigningKey(accountPub))) return no('key')
  const kx = await kxSlot(kxF, [accountPub])
  if (kx === false) return no('kx')
  let name: string | null = null
  if (nameF !== '') { name = displayText(nameF); if (name === null) return no('name') }
  const seq = int(seqF)
  if (seq === null || seq < 1) return no('seq')
  if ((seq === 1) !== (prevF === '')) return no('prev')
  if (prevF !== '' && !isHash(prevF)) return no('prev')
  const created = ms(createdF), expires = ms(expiresF)
  if (created === null || expires === null) return no('grammar')
  return { ok: true, value: { address, accountPub, kx, name, seq, prev: prevF || null, created, expires } }
}

export async function verifyBind(text: string, sig: string, opts: { now: number }):
  Promise<Verdict<BindCert>> {
  const v = await parseBind(text)
  if (!v.ok) return v
  const life = lifetime(v.value.created, v.value.expires, opts.now)
  if (life) return no(life)
  if (!(await verifyStatementSig(v.value.accountPub, sig, text))) return no('signature')
  return v
}

// --- rot. — the OLD account key vouching for a rotation ------------------------

/**
 * `rot.<sha256(next bind text)>.<sha256(live bind text)>`, signed by the account
 * key of the LIVE (old) binding.
 *
 * A rotation's continuity proof. It is its own statement, never a second
 * signature over the new bind. bytes: a signature's meaning belongs in its own
 * bytes, so nothing an account key signs about its own binding can be replayed
 * as a vouch for a successor. It carries no challenge or time, because a client
 * must be able to check it OFFLINE, against the binding it pinned, whenever the
 * chain reaches it. The directory serves it beside the chain.
 *
 * A rotation resolved by the recovery code has no rot.: the old key was reported
 * lost or contested, so a pinner warns. That is intended, and no directory
 * marker may soften it.
 */
export function buildRot(nextBindHash: string, liveBindHash: string): string {
  return ['rot', nextBindHash, liveBindHash].join('.')
}

export interface Rotation { prev: BindCert; next: BindCert }

/**
 * Is `nextBindText` a genuine successor of `prevBindText` (the binding a client
 * pinned)? All of: next is a valid binding signed by its OWN account key; same
 * address; next.seq = prev.seq + 1; next.prev = sha256(prev text); the rot.
 * names exactly sha256(next) then sha256(prev); and rotSig is by PREV's account
 * key; and next was created within prev's lifetime (± SKEW_MS), else
 * `stale-vouch`. The pinned binding is never checked against `now`, nor is its
 * signature re-checked: the client checked them when it pinned, and a pin may
 * outlive its expiry.
 */
export async function verifyRotation(prevBindText: string, nextBindText: string, nextSig: string,
  rotText: string, rotSig: string, opts: { now: number }): Promise<Verdict<Rotation>> {
  const prev = await parseBind(prevBindText)
  if (!prev.ok) return no('prev')
  const next = await verifyBind(nextBindText, nextSig, { now: opts.now })
  if (!next.ok) return no(`next-${next.reason}`)
  if (next.value.address !== prev.value.address) return no('address')
  if (next.value.seq !== prev.value.seq + 1) return no('seq')
  const prevHash = await sha256b64u(prevBindText), nextHash = await sha256b64u(nextBindText)
  if (next.value.prev !== prevHash) return no('chain')
  // A key may vouch only for a successor minted while its own binding was live:
  // its authority ends when its binding does, or a key leaked after expiry (a
  // retired device) could turn a pinner's "key changed" warning into a silent
  // follow. prev is still never checked against `now`, so a legitimate chain
  // keeps verifying after its old binding expires.
  if (next.value.created > prev.value.expires + SKEW_MS ||
      next.value.created < prev.value.created - SKEW_MS) return no('stale-vouch')
  const r = fields(rotText, 'rot', 3)
  if (!r || !isHash(r[1]) || !isHash(r[2])) return no('rot-grammar')
  if (r[1] !== nextHash || r[2] !== prevHash) return no('rot-mismatch')
  if (!(await verifyStatementSig(prev.value.accountPub, rotSig, rotText))) return no('rot-signature')
  return { ok: true, value: { prev: prev.value, next: next.value } }
}

// --- att. — the directory's attestation (signed by a directory key) ----------

export type AttState = 'active' | 'pending' | 'frozen'

/**
 * `att.<sha256(bind text)>.<verifiedAt>.<issuedAt>.<kid>.<active|pending|frozen>`
 *
 * The directory's signed answer to a lookup. `issuedAt` is fresh on every
 * answer, so a client can refuse a replayed one; `state` is inside the
 * signature, so a directory answer cannot be replayed as "active" during a
 * rotation freeze (security §25). Signed by the directory's ONLINE key named by
 * `kid` — never the release key.
 */
export interface Attestation {
  bindHash: string
  verifiedAt: number
  issuedAt: number
  kid: string
  state: AttState
}

export function buildAtt(a: Attestation): string {
  return ['att', a.bindHash, a.verifiedAt, a.issuedAt, a.kid, a.state].join('.')
}

export async function verifyAtt(text: string, sig: string, opts: {
  directoryKeys: Readonly<Record<string, string>>
  bindText: string
  now: number
  maxAgeMs: number
}): Promise<Verdict<Attestation>> {
  const p = fields(text, 'att', 6)
  if (!p) return no('grammar')
  const [, bindHash, verifiedF, issuedF, kid, state] = p
  if (!isHash(bindHash) || !KID_RE.test(kid)) return no('grammar')
  if (state !== 'active' && state !== 'pending' && state !== 'frozen') return no('grammar')
  const verifiedAt = ms(verifiedF), issuedAt = ms(issuedF)
  if (verifiedAt === null || issuedAt === null || verifiedAt > issuedAt) return no('grammar')
  if (issuedAt > opts.now + SKEW_MS) return no('not-yet-valid')
  if (opts.now - issuedAt > opts.maxAgeMs) return no('stale')
  if (bindHash !== (await sha256b64u(opts.bindText))) return no('bind-mismatch')
  if (!Object.hasOwn(opts.directoryKeys, kid)) return no('unknown-kid')
  if (!(await verifyStatementSig(opts.directoryKeys[kid], sig, text))) return no('signature')
  return { ok: true, value: { bindHash, verifiedAt, issuedAt, kid, state: state as AttState } }
}

// --- tomb. — the directory's deletion record ---------------------------------

export type TombBy = 'holder' | 'mailbox' | 'operator'

/**
 * `tomb.<sha256(last bind text)|empty>.<seq>.<deletedAt>.<holder|mailbox|operator>.<kid>`
 *
 * Lets a client tell "deleted" from "never bound". The hash is empty when the
 * directory holds no previous binding text for the address.
 */
export interface Tombstone {
  lastBindHash: string | null
  seq: number
  deletedAt: number
  by: TombBy
  kid: string
}

export function buildTomb(t: Tombstone): string {
  return ['tomb', t.lastBindHash ?? '', t.seq, t.deletedAt, t.by, t.kid].join('.')
}

export async function verifyTomb(text: string, sig: string, opts: {
  directoryKeys: Readonly<Record<string, string>>
  now: number
}): Promise<Verdict<Tombstone>> {
  const p = fields(text, 'tomb', 6)
  if (!p) return no('grammar')
  const [, hashF, seqF, deletedF, by, kid] = p
  if (hashF !== '' && !isHash(hashF)) return no('grammar')
  const seq = int(seqF), deletedAt = ms(deletedF)
  if (seq === null || seq < 1 || deletedAt === null) return no('grammar')
  if (by !== 'holder' && by !== 'mailbox' && by !== 'operator') return no('grammar')
  if (!KID_RE.test(kid)) return no('grammar')
  if (deletedAt > opts.now + SKEW_MS) return no('not-yet-valid')
  if (!Object.hasOwn(opts.directoryKeys, kid)) return no('unknown-kid')
  if (!(await verifyStatementSig(opts.directoryKeys[kid], sig, text))) return no('signature')
  return { ok: true, value: { lastBindHash: hashF || null, seq, deletedAt, by: by as TombBy, kid } }
}

// --- del. — a holder's delete request (signed by the account key) ------------

/** `del.<b64u(address)>.<ts>`, valid within ±5 minutes of `ts`. */
export const DELETE_WINDOW_MS = 5 * 60_000

export function buildDel(address: string, ts: number): string {
  return ['del', b64uEnc(utf8(address)), ts].join('.')
}

export async function verifyDel(text: string, sig: string, opts: { accountPub: string; now: number }):
  Promise<Verdict<{ address: string; ts: number }>> {
  const p = fields(text, 'del', 3)
  if (!p) return no('grammar')
  const address = freeText(p[1])
  if (address === null || !isNormalAddress(address)) return no('address')
  const ts = ms(p[2])
  if (ts === null) return no('grammar')
  if (Math.abs(opts.now - ts) > DELETE_WINDOW_MS) return no('expired')
  if (!(await verifyStatementSig(opts.accountPub, sig, text))) return no('signature')
  return { ok: true, value: { address, ts } }
}

// --- cmp. — the email-code completion (signed by the binding's account key) --

/** `cmp.<sha256(bind text)>.<code>`: the person typed `code` into their agent,
 *  and the agent signs that it completes THIS binding. */
export function buildCmp(bindHash: string, code: string): string {
  return ['cmp', bindHash, code].join('.')
}

export async function verifyCmp(text: string, sig: string, opts: { accountPub: string; bindText: string }):
  Promise<Verdict<{ bindHash: string; code: string }>> {
  const p = fields(text, 'cmp', 3)
  if (!p) return no('grammar')
  const [, bindHash, code] = p
  if (!isHash(bindHash) || !CODE_RE.test(code)) return no('grammar')
  if (bindHash !== (await sha256b64u(opts.bindText))) return no('bind-mismatch')
  if (!(await verifyStatementSig(opts.accountPub, sig, text))) return no('signature')
  return { ok: true, value: { bindHash, code } }
}

// --- dreq. — an account-signed request to the directory ----------------------

/**
 * `dreq.<op>.<b64u(address)>.<bindHash>.<challenge>.<arg|empty>`
 *
 * Every agent-signed request that only the DIRECTORY verifies, in one layout
 * with a closed op set. It is bound to a single-use challenge the directory
 * issued (spent first, like cns.), so there is no replay window at all, where a
 * timestamp would leave one. Signed by the account key of the binding named by
 * bindHash, which must be the binding the directory currently serves as
 * authoritative: during `pending` that is the OLD one, so a pending key can sign
 * no request.
 *
 * Each op fixes its arg exactly; anything else is a grammar refusal:
 *   contest   sha256(the pending bind. text)       "this wasn't me"
 *   freeze    empty                                the owner's lost-or-stolen report
 *   status    empty                                the signed status read
 *   cred-add  sha256(attestationObject ‖ sha256(clientDataJSON)), the exact
 *             registration bytes; not the credentialId alone, or the key
 *             registered under an id could be swapped in transit. The tail is a
 *             fixed 32 bytes, so the split between the two parts is bound (a
 *             bare concatenation lets a byte move across the boundary under the
 *             same arg); it is WebAuthn's own authenticatorData ‖ clientDataHash shape
 *   cred-del  sha256(credentialId)
 *   rc-enrol  sha256(the exact enrolment body), so the signature covers what is
 *             enrolled
 * State: while `frozen` only `status` is accepted; `contest` only while
 * `pending`; cred-add, cred-del and rc-enrol only while `active`. Those three change who can recover
 * the account, so the directory ALSO requires a cns. for them (purposes
 * cred-add / cred-del / rc-enrol, payload = this dreq. text); `dreqNeedsConsent`
 * names them. freeze, contest and status need only this signature: they remove
 * power or read.
 */
export type DreqOp = 'contest' | 'freeze' | 'status' | 'cred-add' | 'cred-del' | 'rc-enrol'
const DREQ_OPS: readonly DreqOp[] = Object.freeze(['contest', 'freeze', 'status', 'cred-add', 'cred-del', 'rc-enrol'])
const DREQ_EMPTY_ARG = new Set<DreqOp>(['freeze', 'status'])
const DREQ_CONSENT = new Set<DreqOp>(['cred-add', 'cred-del', 'rc-enrol'])
export const dreqNeedsConsent = (op: DreqOp): boolean => DREQ_CONSENT.has(op)
/** frozen: status only. contest: only while pending (there is nothing else to
 *  contest). cred-add / cred-del / rc-enrol: only while active. */
function dreqStateAllows(op: DreqOp, state: AttState): boolean {
  if (state === 'frozen') return op === 'status'
  if (op === 'contest') return state === 'pending'
  if (DREQ_CONSENT.has(op)) return state === 'active'
  return state === 'active' || state === 'pending'
}

/** What the directory holds for the request it is about to apply: the arg is
 *  RECOMPUTED from this, never taken from the request. */
export type DreqSubject =
  | { op: 'contest'; pendingBindText: string }
  | { op: 'freeze' }
  | { op: 'status' }
  | { op: 'cred-add'; attestationObject: Uint8Array; clientDataJSON: Uint8Array }
  | { op: 'cred-del'; credentialId: Uint8Array }
  | { op: 'rc-enrol'; body: Uint8Array }

async function sha256Bytes(b: Uint8Array): Promise<string> {
  return b64uEnc(new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource)))
}

/** The arg field for `subject`: empty for freeze and status, else a SHA-256. */
export async function dreqArg(subject: DreqSubject): Promise<string> {
  switch (subject.op) {
    case 'freeze': case 'status': return ''
    case 'contest': return sha256b64u(subject.pendingBindText)
    case 'cred-add': {
      const a = subject.attestationObject
      const c = new Uint8Array(await crypto.subtle.digest('SHA-256', subject.clientDataJSON as BufferSource))
      const both = new Uint8Array(a.length + c.length)
      both.set(a); both.set(c, a.length)
      return sha256Bytes(both)
    }
    case 'cred-del': return sha256Bytes(subject.credentialId)
    case 'rc-enrol': return sha256Bytes(subject.body)
  }
}

export interface DirRequest {
  op: DreqOp
  address: string
  bindHash: string
  challenge: string
  arg: string
}

export function buildDreq(r: DirRequest): string {
  return ['dreq', r.op, b64uEnc(utf8(r.address)), r.bindHash, r.challenge, r.arg].join('.')
}

/** A challenge: canonical base64url of 16 to 64 bytes (the same rule as the
 *  consent transcript's). */
const isChallenge = (f: string) => { const b = b64uDec(f); return !!b && b.length >= 16 && b.length <= 64 }

/**
 * Verify a directory request. The directory brings what it holds: `bindText`,
 * the binding it currently serves as authoritative for the address (the signer
 * is that binding's account key), its `state`, the `challenge` it issued to this
 * session, and the `subject` of the endpoint the request arrived on. `spend` is
 * called once the text parses, before anything else is checked, and must return
 * false if the challenge was already spent or has expired: every attempt that
 * parses consumes its challenge, as with cns. Every refusal before the spend is
 * `grammar`, so a host can tell from the reason alone whether it was spent.
 */
export async function verifyDreq(text: string, sig: string, opts: {
  bindText: string
  state: AttState
  challenge: string
  subject: DreqSubject
  spend: (challenge: string) => boolean
}): Promise<Verdict<DirRequest>> {
  const p = fields(text, 'dreq', 6)
  if (!p) return no('grammar')
  const [, opF, addressF, bindHash, challenge, arg] = p
  if (!(DREQ_OPS as readonly string[]).includes(opF)) return no('grammar')
  const op = opF as DreqOp
  const address = freeText(addressF)
  if (address === null) return no('grammar')
  if (!isHash(bindHash) || !isChallenge(challenge)) return no('grammar')
  if (DREQ_EMPTY_ARG.has(op) ? arg !== '' : !isHash(arg)) return no('grammar')
  if (!opts.spend(opts.challenge)) return no('replay')
  if (challenge !== opts.challenge) return no('challenge')
  if (op !== opts.subject.op) return no('op')
  if (!dreqStateAllows(op, opts.state)) return no('state')
  const b = fields(opts.bindText, 'bind', 9)
  if (!b || bindHash !== (await sha256b64u(opts.bindText))) return no('bind-mismatch')
  if (!isNormalAddress(address) || freeText(b[1]) !== address) return no('address')
  if (arg !== (await dreqArg(opts.subject))) return no('arg')
  if (!(await verifyStatementSig(b[2], sig, text))) return no('signature')
  return { ok: true, value: { op, address, bindHash, challenge, arg } }
}

// --- cns. — host-stamped consent (signed by a certified consent key) ---------

/**
 * The consent purposes a cns. may carry, a CLOSED set, and the statement family
 * each one authorises. `grant` and `role` are reserved for phase 2 and refused
 * until defined. (Distinct from identity.ts SignPurpose, which is about routine
 * signing with the device key.)
 */
export type ConsentPurpose = 'invite' | 'revoke' | 'link' | 'rotate' | 'unbind' | 'cred-add' | 'cred-del' | 'rc-enrol'
/**
 * The family is a PREFIX check on the payload, so the three directory-request
 * purposes name their OP, never bare `dreq.`: a consent for adding a passkey
 * must not authorise removing one, or enrolling a recovery verifier.
 */
const CONSENT_FAMILY: Record<ConsentPurpose, string> = {
  invite: 'inv.', revoke: 'rev.', link: 'dev.', rotate: 'bind.', unbind: 'del.',
  'cred-add': 'dreq.cred-add.', 'cred-del': 'dreq.cred-del.', 'rc-enrol': 'dreq.rc-enrol.',
}
const RESERVED_PURPOSES = new Set(['grant', 'role'])
/** Purposes about one document carry its docId; account-scoped ones carry none. */
const DOC_SCOPED = new Set<ConsentPurpose>(['invite', 'revoke'])

/** A consent signature is good for at most this long after it is made. */
export const CONSENT_MAX_TTL_MS = 5 * 60_000

const AUDIENCE_RE = new RegExp(`^(dir|room:${ROOM_RE.source.slice(1, -1)})$`)

/**
 * The channel binding (security §24): it ties the consent to WHO verifies it
 * (the audience: `dir`, or `room:<roomName>`), to the single-use CHALLENGE that
 * verifier issued, and to the EXACT statement being authorised. A relayed
 * signature fails the audience, a replayed one the spent challenge, and a swapped
 * payload the hash. Null if a part breaks its grammar.
 *
 *   transcript = b64u( SHA-256( UTF-8( "cnst.v1." ‖ audience ‖ "." ‖ challenge ‖ "." ‖ b64u(SHA-256(payload)) ) ) )
 */
export async function consentTranscript(audience: string, challenge: string, payloadText: string): Promise<string | null> {
  if (!AUDIENCE_RE.test(audience)) return null
  const c = b64uDec(challenge)
  if (!c || c.length < 16 || c.length > 64) return null
  return sha256b64u(`cnst.v1.${audience}.${challenge}.${await sha256b64u(payloadText)}`)
}

export interface Consent {
  rp: string
  purpose: ConsentPurpose
  docId: string | null
  transcript: string
  exp: number
}

/** `cns.<rp>.<purpose>.<docId|empty>.<transcript>.<exp>`, every field host-stamped. */
export function buildConsent(c: Consent): string {
  return ['cns', c.rp, c.purpose, c.docId ?? '', c.transcript, c.exp].join('.')
}

/**
 * Verify a consent signature. The verifier RECOMPUTES the transcript from its
 * OWN audience, the challenge it issued and the payload it is about to apply —
 * it never trusts a transcript from the request. `spend(challenge)` must mark
 * the challenge used and return false if it was already spent or has expired;
 * it is called first, so any attempt consumes the challenge. That is the right
 * default for races (no second try against one challenge), and it relies on
 * challenges being SESSION-BOUND: one issued to one session, so a stranger who
 * spends it can only fail that session's attempt, never take it over.
 *
 * `consentPub` must come from a verified dev. certificate's consentPub field;
 * that is what makes it a consent key and not merely a key.
 */
export async function verifyConsent(text: string, sig: string, opts: {
  consentPub: string
  rp: string
  audience: string
  challenge: string
  payloadText: string
  docId: string | null
  now: number
  spend: (challenge: string) => boolean
}): Promise<Verdict<Consent>> {
  const p = fields(text, 'cns', 6)
  if (!p) return no('grammar')
  if (!opts.spend(opts.challenge)) return no('replay')
  const [, rp, purposeF, docIdF, transcript, expF] = p
  if (!RP_RE.test(rp) || !isHash(transcript)) return no('grammar')
  if (RESERVED_PURPOSES.has(purposeF)) return no('reserved-purpose')
  if (!Object.hasOwn(CONSENT_FAMILY, purposeF)) return no('grammar')
  const purpose = purposeF as ConsentPurpose
  const exp = ms(expF)
  if (exp === null) return no('grammar')
  if (rp !== opts.rp) return no('rp')
  // the payload must be of the family this purpose authorises
  if (!opts.payloadText.startsWith(CONSENT_FAMILY[purpose])) return no('payload-family')
  // document-scoped purposes name the document; account-scoped ones name none
  if (DOC_SCOPED.has(purpose)) {
    if (!DOCID_RE.test(docIdF) || docIdF !== opts.docId) return no('docid')
  } else if (docIdF !== '' || opts.docId !== null) return no('docid')
  const expected = await consentTranscript(opts.audience, opts.challenge, opts.payloadText)
  if (expected === null || transcript !== expected) return no('transcript')
  if (opts.now >= exp) return no('expired')
  if (exp - opts.now > CONSENT_MAX_TTL_MS) return no('lifetime')
  if (!(await verifyStatementSig(opts.consentPub, sig, text))) return no('signature')
  return { ok: true, value: { rp, purpose, docId: docIdF || null, transcript, exp } }
}

/**
 * The light tier has no hardware consent key (its dev. consentPub is empty). In
 * phase 1 its consent is a WebAuthn assertion verified only by the directory
 * (every phase-1 cns. has audience `dir`), and the assertion carries the
 * statement as `clientDataJSON.challenge` = this value: base64url of SHA-256 over
 * the EXACT cns. bytes (security §27).
 */
export const webauthnChallengeFor = (cnsText: string): Promise<string> => sha256b64u(cnsText)

/**
 * Prefixes reserved for statements not defined yet, so nothing else takes them:
 *   pk.   — an account-signed passkey statement (phase 2), for room-audience
 *           verifiers of light-tier consent. Never the dev. consentPub slot.
 *   drev. — an account-signed device revocation. Not needed in phase 1: a device
 *           retired without rotating the account key is one whose hardware-wrapped
 *           keys were destroyed by a confirmed wipe, so its dev. cert names a key
 *           nobody holds. It arrives with per-device kx, when senders wrap to
 *           device keys (security §25b).
 *   wdev. watt. wren. dev2. — bento/id option G's device certificates: a browser
 *           device key certified by a passkey assertion, the directory's logged
 *           countersign and its renewals, the renewal request, and the native
 *           device certificate. Defined in a later kernel change.
 * (ros. and rip., the option G roster and its ripening countersign, are defined
 * in roster.ts: ROSTER_PREFIXES.)
 */
export const RESERVED_PREFIXES: readonly string[] = Object.freeze(['pk', 'drev', 'wdev', 'watt', 'wren', 'dev2'])

/**
 * Prefixes taken by device linking (link.ts, link v1). None is a statement the
 * account key signs, but each is a byte layout every agent must agree on, so no
 * statement family may ever take one: lnk0–lnk3 are the four slot messages,
 * lnkt the transcript, lnkp the proof of possession, lnka the AEAD's AAD.
 */
export const LINK_PREFIXES: readonly string[] = Object.freeze(['lnk0', 'lnk1', 'lnk2', 'lnk3', 'lnkt', 'lnkp', 'lnka'])

// --- routine signing: what payload each SignPurpose (identity.ts) may sign ----

/** A canonical base64url field decoding to at least `min` (exactly `exact`) bytes. */
const b64Len = (f: string, min: number, exact?: number) => {
  const b = b64uDec(f)
  return !!b && (exact === undefined ? b.length >= min : b.length === exact)
}
const isPubField = (f: string) => { const b = b64uDec(f); return !!b && b.length === 65 && b[0] === 0x04 }
const IV = (f: string) => b64Len(f, 0, 12)   // AES-GCM iv
const CT = (f: string) => b64Len(f, 16)      // ciphertext with its 16-byte tag

/**
 * Does `payload` have the exact shape of the statement `purpose` names? The
 * agent signs only a matching payload, so a prompt shown for one kind of action
 * can never yield a signature on another. Shapes are the shipped collab
 * statements (kernel/src/sync/online.ts, verified by the relay).
 */
export function payloadMatchesPurpose(purpose: SignPurpose, payload: string): boolean {
  if (typeof payload !== 'string' || payload.length > MAX_STATEMENT) return false
  const p = payload.split('.')
  switch (purpose) {
    case 'frame': return p.length === 2 && IV(p[0]) && CT(p[1])                       // `${i}.${d}`
    case 'prove': return p.length === 3 && p[0] === 'prove' && b64Len(p[1], 16) && /^[rw][A-Za-z0-9_-]{1,64}$/.test(p[2])
    case 'delegate': return p.length === 2 && p[0] === 'dlg' && isPubField(p[1])
    case 'show':
      return (p.length === 1 && (p[0] === 'live' || p[0] === 'end')) ||
        (p.length === 4 && (p[0] === 'nav' || p[0] === 'black') && p[1] === 'aud' && IV(p[2]) && CT(p[3]))
    case 'invite': return p.length === 4 && p[0] === 'inv' && isPubField(p[1]) &&
      (p[2] === 'writer' || p[2] === 'commenter' || p[2] === 'audience') && INT_RE.test(p[3])
    case 'revoke': return p.length === 2 && p[0] === 'rev' && isPubField(p[1])
    default: return false
  }
}
