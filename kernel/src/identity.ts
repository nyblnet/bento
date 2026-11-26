// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/id — the document's side of the identity agent contract.
//
// A document is a file, and a file cannot keep a secret, so it cannot hold a
// person's keys. The agent can: bento/home (the extension, the iOS, Android and
// desktop apps) keeps the account and device keys and acts for the person when
// a document asks. This module is the ONE definition of what a document may ask
// and what it gets back. Each host implements it over its own channel
// (home/bridge.js on the native hosts, the extension's served page), and the
// document only ever talks to the object below.
//
// Three rules shape the contract:
//   - PRIVATE KEYS NEVER CROSS. Every call returns a result: a public identity,
//     a signature, a public binding. The only secret that ever comes back is a
//     document key the person was given (`unwrap`, phase 2).
//   - THE HOST KNOWS WHO IS ASKING. No call takes a docId or a caller name: the
//     host identifies the calling document from what the platform reports (the
//     file path, the opened URL), never from the page, and exposes this object
//     only to a verified, signed Bento shell (gate 1).
//   - PER DOCUMENT MEANS PER FILE THE HOST OPENED. Wherever this contract says
//     "per document" (consent, resolve answers), the host keys it on inputs the
//     document cannot choose: its own install salt, the canonical path of the
//     file it opened, and the docId, together. Never the bare docId, which any
//     copy of a file carries and any file can claim.
//   - NO HOST, NO CHANGE. `identityAgent()` returns null wherever there is no
//     agent — a bare file:// tab, an older host, a doctored file — and every
//     caller then does exactly what it did before identity existed.

import type { DeviceProof } from './devices.ts'
import type { RosterLink } from './roster.ts'

/** The contract version a host's agent object must carry. Members marked
 *  optional are additions within this version; a breaking change bumps it, and
 *  a document then sees no agent rather than one it would misread. */
export const IDENTITY_CONTRACT = 1

/** The global the host defines, before the runtime boots, on a verified shell. */
export const IDENTITY_GLOBAL = '__bentoIdentity'

/**
 * The longest `vouchedBy` a document shows: shells cut the text there.
 *
 * vouchedBy is the VOUCHER ALONE ('id.bento.page', an organisation's domain, a
 * vault id), never a qualifier. Everything that qualifies it travels as its own
 * field of ResolvedIdentity (`tier`, `unconfirmedSince`, `managedBy`, ...), and
 * the document composes the words. One source per fact: an agent that wrote
 * "(passkey sign-in)" into vouchedBy while the document drew its own tag from
 * `tier` would show two tiers that disagree the day a certificate is native,
 * and a lapse found by parsing text can be dropped or forged by the text
 * around it. `isVoucher` is the shape an agent sends and a document accepts.
 */
export const VOUCHED_BY_MAX = 80

const VOUCHER_RE = /^[a-z0-9](?:[a-z0-9.:-]*[a-z0-9])?$/

/** Is `v` a bare voucher: lower-case letters, digits, `.`, `-` and `:`, at most
 *  VOUCHED_BY_MAX characters, no spaces, commas or parentheses (so no
 *  qualifier text can ride in it)? A document shows no ✓ otherwise. */
export function isVoucher(v: unknown): v is string {
  return typeof v === 'string' && v.length <= VOUCHED_BY_MAX && VOUCHER_RE.test(v)
}

/**
 * The public certificates that let a PEER check a device key offline (ID3,
 * security-ruling R1b). A person's agent hands its own proof to the document
 * (PublicIdentity.proof), the document carries it to the room, and another
 * person's agent verifies it under its OWN pinned directory keys: no lookup
 * route, no network, nothing from the proof but signed texts.
 *   device  the device certificate (wdev. or dev2.), the member's proof over
 *           it, and the directory's current watt. (devices.ts)
 *   chain   the roster chain FROM SEQ 0 (roster.ts): the anchor is the hash of
 *           its first head, so a chain that starts at a pin anchors nothing
 * At most PROOF_MAX_BYTES as JSON. Public certificates only: the proof exposes
 * the address and the account's member history (passkey pubs, reset and change
 * times) to everyone it is shown to.
 */
export interface IdentityProof {
  device: DeviceProof
  chain: RosterLink[]
}

/**
 * The largest proof, as UTF-8 JSON, any side carries (R1d). roster-v2 links
 * average about 850 bytes, so this holds about 75 links, well below MAX_CHAIN.
 * Over it: whoami answers WITHOUT the proof and resolve answers null, both
 * counted. Fail closed; a checkpoint design is later work under its own ruling.
 * ONE constant: identityport.ts's proof parser is the only reader.
 */
export const PROOF_MAX_BYTES = 64 * 1024

/**
 * The ACCOUNT ANCHOR (security-ruling ID3, R1a): `'g:' + base64url(sha256(the
 * exact ros. text at seq 0))`, roster.ts accountAnchor. It is what accountPub
 * carries under option G, for every answer marked `fields: 'g1'`.
 *
 * THE ANCHOR IS NOT CONTINUITY OF THE PERSON. It names a roster chain, and a
 * reset CONTINUES the chain, so the anchor is the same across every reset,
 * including one made by someone who took the mailbox. What changes is the
 * chain-derived fields: `resetAt`, `rosterChangedAt`, `accountSince`. No host
 * and no document may read "same accountPub" as "same person, nothing
 * changed"; it reads those fields. A deletion and a fresh setup at the same
 * address give a NEW anchor even with the same passkey (ros.0 carries the
 * directory's nonce and its own time).
 */
export const ACCOUNT_ANCHOR_RE = /^g:[A-Za-z0-9_-]{43}$/

/** The voucher of every answer composeResolved builds. */
export const G_VOUCHER = 'id.bento.page'

/** Who is using this document, as vouched for. Public fields only. */
export interface PublicIdentity {
  /** display name, as the binding states it */
  name: string
  /** the verified address, exactly as bound (lower-case) */
  email: string
  /** who vouched: 'id.bento.page', an organisation's domain, or a vault id */
  vouchedBy: string
  /** the person's account public key: raw P-256 point, base64url */
  accountPub: string
  /** this device's key, the one `sign` uses: raw P-256 point, base64url */
  devicePub: string
  /** OPTIONAL within contract 1: the public certificates for devicePub, for
   *  the document to carry to peers (IdentityProof). Absent when the agent has
   *  none or it is over PROOF_MAX_BYTES. */
  proof?: IdentityProof
}

/**
 * What a signature is for. The agent signs only a payload whose shape matches
 * the purpose, so a prompt shown for one kind of action can never yield a
 * signature on another. The payloads are the existing dot-joined statements
 * (docs/collab-design.md):
 *   frame    — `${i}.${d}`, an op batch or snapshot (routine)
 *   prove    — `prove.${nonce}.${room}`, the per-socket possession proof (routine)
 *   delegate — `dlg.${devicePub}`, an invite key admitting a device (routine)
 *   show     — `live`/`end` and `${kind}.aud.${i}`, presenting controls (routine)
 *   invite   — `inv.${pub}.${role}.${exp}`, an owner granting a role (high authority)
 *   revoke   — `rev.${pub}`, an owner removing a key (high authority)
 * Routine purposes are signed with the DEVICE key and ride the session (§2e).
 * The high-authority ones are signed with the room's OWNER key, which the relay
 * verifies. In phase 1 that key still lives in the document file and the kernel
 * signs with it directly, exactly as today: no agent holds an owner key, so a
 * phase-1 agent refuses `invite`/`revoke` ('unavailable'). The agent holds an
 * owner key only once a document converts to identity mode (phase 2). Then it
 * signs `inv.`/`rev.` after its own consent prompt, and the CONSENT key signs a
 * separate `cns.` (statements.ts) that travels beside it. A cns. needs the
 * verifier's audience and challenge, so phase 2 adds a call that carries them;
 * this contract version has none. The shared payload matcher is statements.ts.
 */
export type SignPurpose = 'frame' | 'prove' | 'delegate' | 'show' | 'invite' | 'revoke'

/** Why a signature was not given. */
export type SignRefusal =
  /** the person said no at the host's prompt */
  | 'declined'
  /** past the idle or overall timeout: refused until the person re-authenticates (§2e B) */
  | 'reauth'
  /** the payload does not match the purpose */
  | 'purpose'
  /** no identity is set up on this device */
  | 'no-identity'
  /** the agent cannot sign right now (locked, busy, no key store) */
  | 'unavailable'

export type SignResult =
  /** `sig` is raw r‖s (64 bytes) base64url, low-S normalised — never DER;
   *  `pub` is the key that signed */
  | { ok: true; sig: string; pub: string }
  | { ok: false; reason: SignRefusal }

/** Look up a person by a key already in the room, or (phase 2) by address.
 *  `proof` (optional within contract 1) is the IdentityProof that key's holder
 *  presented; an agent under option G resolves a pub ONLY through one, and the
 *  proof must certify exactly that pub. */
export type ResolveQuery = { pub: string; proof?: IdentityProof } | { email: string }

/** A public binding the agent found and checked.
 *
 * The fields after `changed` are OPTIONAL ADDITIONS within contract 1, for
 * option G (bento/id). The agent fills them from what it verified (the roster
 * chain, roster.ts; the device certificate and its watt., devices.ts; the
 * directory's status). Times are epoch ms on the directory's clock.
 *
 * Absence is NOT always the weaker claim. `tier` and `accountSince` read
 * weaker when missing (passkey tier, a new account). `revoked` (missing = not
 * revoked, which includes not deleted), `resetAt` and `rosterChangedAt` (missing = no recent change) and
 * `unconfirmedSince` (missing = confirmed) read STRONGER when missing. So:
 *   - an agent sends every one of them that applies, every time;
 *   - EVERY relay between the agent and the document (home/bridge.js, each
 *     native host's bridge, the extension) passes all of them through with
 *     their types checked. A relay that copies only the original six fields
 *     turns a revoked sign-in or a lapsed address into a plain ✓.
 * device-v1.json's per-row `mb` pins how a watt.'s mb is PARSED; that the
 * agent turns it into `unconfirmedSince` is the agent's rule, not yet a row.
 *
 * A document cannot tell "this field does not apply" from "a relay dropped
 * it", so the answer says which it is: `fields` (RESOLVED_FIELDS, below) is
 * set ONLY on an answer that carries every G field that applies. An agent sets
 * it when it has filled them; a relay forwards it ONLY together with all of
 * them, type-checked, and never adds it. A document draws no ✓ for an answer
 * without it (slides' People panel says "couldn't check"). A relay that copies
 * a fixed list of the original six fields drops the marker along with the
 * fields, so every older host fails closed instead of over-claiming. */
export interface ResolvedIdentity {
  name: string
  email: string
  /** the voucher alone (isVoucher): never a tier, a lapse or "managed by" */
  vouchedBy: string
  accountPub: string
  /** when this agent first saw this binding (epoch ms) — trust on first use */
  firstSeen: number
  /** true if the binding differs from the one this agent saw before */
  changed: boolean
  /** G1, devices.ts tierOf: 'native' only for a dev2. a ripe consent key
   *  co-signed; every other certificate is 'passkey' ("passkey sign-in").
   *  The ONLY source of the tier: vouchedBy never carries it. Missing = passkey. */
  tier?: 'passkey' | 'native'
  /** ripenedAt of the roster's setup head (RosterState.createdAt). Missing =
   *  a new account (the document's "new account" window, G5) */
  accountSince?: number
  /** ripenedAt of the latest link that changed the members or their
   *  quarantine marks, a reset excepted */
  rosterChangedAt?: number
  /** ripenedAt of the latest reset (RosterState.lastResetAt) */
  resetAt?: number
  /** this sign-in no longer stands: 'signout' a member signed every browser out
   *  (wout., roster.ts), 'incident' the directory's lever, 'deleted' the account
   *  was deleted (the directory's rdel. record, verified against the pin with
   *  roster.ts verifyDeletion: the document shows "account deleted"). Present
   *  and not false = no ✓ at all. Missing or false = not revoked: a STRONGER
   *  claim, so a relay that drops 'deleted' shows a deleted account as ✓ */
  revoked?: false | 'signout' | 'incident' | 'deleted'
  /** the organisation's domain that manages the account (org identity, later) */
  managedBy?: string
  /** the watt.'s `mb` when it is not 0: since when the address is unconfirmed.
   *  The address part of the ✓ is qualified ("unconfirmed since <date>"); the
   *  account is not. Missing = confirmed (a stronger claim, see above): an
   *  agent that verified a watt. sends it whenever mb ≠ 0. */
  unconfirmedSince?: number
  /** RESOLVED_FIELDS: every field above that applies is present. Missing = the
   *  answer may have lost fields on the way, so no ✓ (see above). Always 'g1':
   *  a later field set adds its own marker, never replaces this value. */
  fields?: 'g1'
}

/** The value of ResolvedIdentity.fields on a complete answer.
 *  'g1' NEVER CHANGES: an answer that carries every g1 field keeps sending
 *  fields: 'g1', for good. Slides shells are frozen inside every saved file and
 *  accept exactly 'g1', so replacing it would turn every row of every file saved
 *  before then into "couldn't check". A later field set announces itself with a
 *  marker of its own, a NEW optional field beside this one, never a new value
 *  here; a relay that knows only g1 forwards 'g1' with the g1 fields and drops
 *  the new marker, so it still cannot vouch for fields it has never seen. */
export const RESOLVED_FIELDS = 'g1'

/** The fields a relay must forward, type-checked, for RESOLVED_FIELDS to
 *  stand: every optional field of ResolvedIdentity before the marker. */
export const RESOLVED_G1_FIELDS = Object.freeze([
  'tier', 'accountSince', 'rosterChangedAt', 'resetAt', 'revoked', 'managedBy', 'unconfirmedSince',
] as const)

// --- composing and checking an answer ---------------------------------------------

/** the latest instant a Date can hold */
const MAX_TIME = 8.64e15
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= MAX_TIME

type G1Field = typeof RESOLVED_G1_FIELDS[number]
/** The type rule for each G field. Keyed by RESOLVED_G1_FIELDS itself, so a
 *  field added to the list without a rule here does not typecheck. */
const G1_RULES: Readonly<Record<G1Field, (v: unknown) => boolean>> = Object.freeze({
  tier: (v: unknown) => v === 'passkey' || v === 'native',
  accountSince: isTime,
  rosterChangedAt: isTime,
  resetAt: isTime,
  revoked: (v: unknown) => v === false || v === 'signout' || v === 'incident' || v === 'deleted',
  managedBy: isVoucher,
  unconfirmedSince: isTime,
})

/** An own data property's value, or undefined (never a getter, never inherited). */
function own(o: object, k: string): unknown {
  const d = Object.getOwnPropertyDescriptor(o, k)
  return d && 'value' in d ? d.value : undefined
}

/**
 * The type-checked relay (security-ruling-962 P1; ID3 A2). Every answer a
 * kernel relay forwards to a document goes through this: the six required
 * fields must hold (else null), each G field in RESOLVED_G1_FIELDS is kept
 * only when it passes its rule, and `fields: 'g1'` is kept only when EVERY G
 * field that is present passed and accountPub has the anchor shape. Anything
 * else (unknown keys, getters, inherited values) is dropped. It never ADDS the
 * marker: composeResolved is the only place that sets it.
 */
export function checkResolved(r: unknown): ResolvedIdentity | null {
  try {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null
    const name = own(r, 'name'), email = own(r, 'email'), vouchedBy = own(r, 'vouchedBy'), accountPub = own(r, 'accountPub')
    const firstSeen = own(r, 'firstSeen'), changed = own(r, 'changed')
    if (typeof name !== 'string' || name === '' || name.length > 320 || typeof email !== 'string' || email.length > 320 ||
      !isVoucher(vouchedBy) || typeof accountPub !== 'string' || accountPub === '' || accountPub.length > 200 ||
      !isTime(firstSeen) || typeof changed !== 'boolean') return null
    const out: ResolvedIdentity = { name, email, vouchedBy, accountPub, firstSeen, changed }
    let whole = true
    for (const f of RESOLVED_G1_FIELDS) {
      const v = own(r, f)
      if (v === undefined) continue
      if (G1_RULES[f](v)) (out as unknown as Record<string, unknown>)[f] = v
      else whole = false
    }
    const marker = own(r, 'fields')
    if (marker === RESOLVED_FIELDS && whole && ACCOUNT_ANCHOR_RE.test(accountPub)) out.fields = marker
    return out
  } catch {
    // a hostile getter, a revoked proxy: no answer, never a throw into the caller
    return null
  }
}

/** What an agent VERIFIED, for composeResolved. Every value comes from the
 *  roster chain, the device certificate and its watt., the incident records,
 *  and the agent's own-account status: nothing from presence or the request. */
export interface VerifiedFacts {
  /** the roster's address, in normal form */
  address: string
  /** accountAnchor of the chain */
  anchor: string
  tier: 'passkey' | 'native'
  /** RosterState.createdAt (the chain starts at seq 0) */
  accountSince: number
  /** the latest member or quarantine change, a reset excepted; null = none */
  rosterChangedAt: number | null
  /** RosterState.lastResetAt */
  resetAt: number | null
  revoked: false | 'signout' | 'incident' | 'deleted'
  /** the watt.'s mb: 0 = confirmed */
  mb: number
  firstSeen: number
  changed: boolean
}

/**
 * Build a ResolvedIdentity from verified facts. THE ONLY SETTER of `fields:
 * 'g1'` (ID3 A2): it fills every G field that applies and marks the answer,
 * then passes it through checkResolved, so a fact that fails its type drops
 * the marker here too. null when the facts cannot make an answer at all.
 *
 * `name` and `email` are both the ADDRESS (A5): under option G no signed
 * statement carries a display name. A device certificate's label is chosen by
 * the page that asked, so it is never a name; a host may show it only as a
 * device description in its own chrome, marked as chosen by the page.
 */
export function composeResolved(f: VerifiedFacts): ResolvedIdentity | null {
  if (!f || typeof f.address !== 'string' || !ACCOUNT_ANCHOR_RE.test(f.anchor)) return null
  const a: ResolvedIdentity = {
    name: f.address,
    email: f.address,
    vouchedBy: G_VOUCHER,
    accountPub: f.anchor,
    firstSeen: f.firstSeen,
    changed: f.changed,
    tier: f.tier,
    accountSince: f.accountSince,
  }
  if (f.rosterChangedAt !== null) a.rosterChangedAt = f.rosterChangedAt
  if (f.resetAt !== null) a.resetAt = f.resetAt
  if (f.revoked !== false) a.revoked = f.revoked
  if (f.mb !== 0) a.unconfirmedSince = f.mb
  a.fields = RESOLVED_FIELDS
  const c = checkResolved(a)
  return c && c.fields === RESOLVED_FIELDS ? c : null
}

/** Roles a person can be given in a document (phase 2). */
export type ShareRole = 'reader' | 'editor' | 'owner'

export interface IdentityAgent {
  readonly contract: number
  /** The person using this document, or null when no identity is set up or
   *  they declined to use it here (consent is per document: per file the
   *  host opened, as above). */
  whoami(): Promise<PublicIdentity | null>
  /** Sign `payload` (the exact UTF-8 text) for `purpose` with this device's key.
   *  A host method that throws reaches the caller as a REJECTED promise: callers
   *  treat a rejection exactly like `{ ok: false, reason: 'unavailable' }` and
   *  never let it escape. Check the payload first with statements.ts
   *  payloadMatchesPurpose; the host refuses a mismatch either way. */
  sign(purpose: SignPurpose, payload: string): Promise<SignResult>
  /** Who a key in the room (or, phase 2, an address) belongs to; null if unknown.
   *  A lookup by `{email}` is consent-gated and rate-limited by the HOST, so a
   *  document cannot use it to probe which addresses have an identity. */
  resolve(query: ResolveQuery): Promise<ResolvedIdentity | null>
  /** PHASE 2: open the document key wrapped to this person (`collab.wraps`).
   *  Returns the raw key, or null when no wrap here is theirs. */
  unwrap?(wrap: { to: string; kw: string }): Promise<Uint8Array | null>
  /** PHASE 2: share this document with a person, after the host's own consent. */
  share?(email: string, role: ShareRole): Promise<{ ok: true } | { ok: false; reason: string }>
}

let held: IdentityAgent | undefined

/**
 * The host's identity agent for this page, or null when there is none — in
 * which case the caller does what it always did.
 *
 * WHAT A HOST MUST DEFINE, or the document sees no agent:
 *   - the global as a DATA property that is non-writable and non-configurable
 *     (`Object.defineProperty(globalThis, '__bentoIdentity', { value, writable:
 *     false, configurable: false })`) — never a getter, which could answer
 *     differently on each read;
 *   - the agent object itself FROZEN;
 *   - its methods as CLOSURES that do not use `this`. They are called with
 *     `this` undefined, so a method that reaches its transport through `this`
 *     (or through anything page code could rewrite later) fails here instead of
 *     being redirectable after capture. Capture the transport at definition time.
 *
 * A valid agent is captured once; later changes cannot redirect a call. An
 * absent or malformed one is not cached, so an agent the host defines a moment
 * late is still found on a later call.
 */
export function identityAgent(): IdentityAgent | null {
  if (held) return held
  const agent = detect(globalThis)
  if (agent) held = agent
  return agent
}

function detect(scope: object): IdentityAgent | null {
  let candidate: unknown
  try {
    const d = Object.getOwnPropertyDescriptor(scope, IDENTITY_GLOBAL)
    // a data property the page can neither overwrite nor redefine; no getters
    if (!d || !('value' in d) || d.writable !== false || d.configurable !== false) return null
    candidate = d.value
  } catch { return null }
  return capture(candidate)
}

/** detect() against a stand-in global, without caching. For the rig only: a
 *  non-configurable property on the real globalThis could never be reset. */
export function detectIdentityAgentForTest(scope: object): IdentityAgent | null {
  return detect(scope)
}

function capture(c: unknown): IdentityAgent | null {
  try {
    if (!c || typeof c !== 'object') return null
    // a frozen host object: no member can be swapped after this check
    if (!Object.isFrozen(c)) return null
    const o = c as Record<string, unknown>
    if (o.contract !== IDENTITY_CONTRACT) return null
    const fn = (k: string) => (typeof o[k] === 'function' ? (o[k] as (...a: unknown[]) => unknown) : null)
    const whoami = fn('whoami'), sign = fn('sign'), resolve = fn('resolve')
    if (!whoami || !sign || !resolve) return null
    // phase-2 members are optional, but if present they must be callable
    for (const k of ['unwrap', 'share']) if (o[k] !== undefined && !fn(k)) return null
    const unwrap = fn('unwrap'), share = fn('share')
    // `this` undefined: a host method gets nothing a page could later rewrite
    const call = <F>(f: (...a: unknown[]) => unknown) =>
      ((...args: unknown[]) => Reflect.apply(f, undefined, args)) as unknown as F
    return Object.freeze({
      contract: IDENTITY_CONTRACT,
      whoami: call<IdentityAgent['whoami']>(whoami),
      sign: call<IdentityAgent['sign']>(sign),
      resolve: call<IdentityAgent['resolve']>(resolve),
      ...(unwrap ? { unwrap: call<NonNullable<IdentityAgent['unwrap']>>(unwrap) } : {}),
      ...(share ? { share: call<NonNullable<IdentityAgent['share']>>(share) } : {}),
    })
  } catch {
    // a hostile getter, a revoked proxy: no agent, never a throw into the caller
    return null
  }
}

/** Forget the captured agent. For rigs that toggle the host between cases. */
export function resetIdentityAgentForTest(): void {
  held = undefined
}
