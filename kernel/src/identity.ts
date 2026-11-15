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
 *  qualifier text can ride in it)? A document shows "not verified" otherwise. */
export function isVoucher(v: unknown): v is string {
  return typeof v === 'string' && v.length <= VOUCHED_BY_MAX && VOUCHER_RE.test(v)
}

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

/** Look up a person by a key already in the room, or (phase 2) by address. */
export type ResolveQuery = { pub: string } | { email: string }

/** A public binding the agent found and checked.
 *
 * The fields after `changed` are OPTIONAL ADDITIONS within contract 1, for
 * option G (bento/id). The agent fills them from what it verified (the roster
 * chain, roster.ts; the device certificate and its watt., devices.ts; the
 * directory's status). Times are epoch ms on the directory's clock.
 *
 * Absence is NOT always the weaker claim. `tier` and `accountSince` read
 * weaker when missing (passkey tier, a new account). `revoked` (missing = not
 * revoked), `resetAt` and `rosterChangedAt` (missing = no recent change) and
 * `unconfirmedSince` (missing = confirmed) read STRONGER when missing. So:
 *   - an agent sends every one of them that applies, every time;
 *   - EVERY relay between the agent and the document (home/bridge.js, each
 *     native host's bridge, the extension) passes all of them through with
 *     their types checked. A relay that copies only the original six fields
 *     turns a revoked sign-in or a lapsed address into a plain ✓.
 * device-v1.json's per-row `mb` pins how a watt.'s mb is PARSED; that the
 * agent turns it into `unconfirmedSince` is the agent's rule, not yet a row. */
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
   *  (wout., roster.ts), 'incident' the directory's lever. Present and not false
   *  = no ✓ at all. Missing or false = not revoked */
  revoked?: false | 'signout' | 'incident'
  /** the organisation's domain that manages the account (org identity, later) */
  managedBy?: string
  /** the watt.'s `mb` when it is not 0: since when the address is unconfirmed.
   *  The address part of the ✓ is qualified ("unconfirmed since <date>"); the
   *  account is not. Missing = confirmed (a stronger claim, see above): an
   *  agent that verified a watt. sends it whenever mb ≠ 0. */
  unconfirmedSince?: number
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
