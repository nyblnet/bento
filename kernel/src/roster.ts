// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/id, option G: the account ROSTER and the directory's RIPENING countersign.
//
// Under option G no account private key exists on any host. An account is a
// chain of roster heads (`ros.`), each naming every key that may change the
// account: passkeys (`pk`), native hardware consent keys (`ck`) and at most one
// recovery key (`rk`). A change is asked for by a member of the previous head,
// is queued by the directory for 72 hours, and enters the chain only when the
// directory countersigns it at RIPENING (`rip.`). A peer verifies the chain
// offline: every link's member signature (a WebAuthn assertion for a passkey,
// webauthn.ts), the directory's countersign, and the wait, measured on the
// DIRECTORY's clock, never on the requester's.
//
// The family rules are statements.ts's: dot-joined printable ASCII, signed over
// the exact bytes, strict field counts, empty fields only where allowed, epoch
// milliseconds, the version in the prefix. kernel/fixtures/roster-v1.json is
// the conformance contract.
//
// --- ros. --------------------------------------------------------------------
//
//   ros.<b64u(address)>.<seq>.<prevHash|empty>.<members>.<dirNonce>.<created>
//
//   seq       0 for the setup head, then +1 per link
//   prevHash  sha256(previous ros. text), base64url; empty exactly when seq is 0
//   members   comma-joined member tokens `kind~pub` or `kind~pub~q`, in strictly
//             ascending byte order (so one roster has one spelling); kind is
//             pk | ck | rk; pub a raw uncompressed P-256 point, base64url;
//             `~q` marks a QUARANTINED member (it may not sign). 1 to 16
//             members, every pub distinct, at most one rk.
//   dirNonce  the directory challenge the request was bound to (16 to 64
//             bytes, base64url), in the text so a peer can see the binding
//   created   the requester's clock. Informative ONLY: no wait is ever
//             measured from it.
//
// --- rip. --------------------------------------------------------------------
//
//   rip.<sha256(ros text)>.<requestedAt>.<ripenedAt>.<reset 0|1>.<kid>
//
// Signed by the directory key `kid` (raw r‖s, low-S, as every directory
// statement), issued ONLY when the change ripens. requestedAt and ripenedAt are
// the directory's clock. A link without a rip. is not in force, so a change
// that was voided can never be shown to an offline peer as if it ripened.
//
// --- who authorises a link ---------------------------------------------------
//
//   setup (seq 0)    the directory's rip. alone (reset 0). Exactly one member, an
//                    unquarantined pk. The creating passkey's registration is
//                    checked by the directory; peers do not parse registrations.
//   reset (reset 1)  the directory's rip. alone, after the 72 h wait. Exactly one
//                    member, an unquarantined pk. Peers report it as a reset.
//   member change    a signature over the exact ros. text by an UNQUARANTINED
//                    member of the PREVIOUS head: a WebAuthn assertion for a pk
//                    (challenge = SHA-256 of the text), a raw low-S signature for
//                    an rk. One change per link: one member added, or one
//                    removed, or the rk replaced. Quarantine marks of continuing
//                    members never change, and a new member is never
//                    quarantined. The wait is ripenedAt − requestedAt ≥ 72 h,
//                    except a member removing ITSELF while another unquarantined
//                    member remains.
//
// NOT HERE YET, and refused until defined (fail closed):
//   - a consent-key (ck) signature or co-sign (the `roster` consent purpose,
//     the next kernel change). Until then a ck-signed link is refused, and so is
//     any member link that ripened in under 72 h other than a self-removal.
//   - links the directory makes on the MAILBOX's authority: a void's
//     quarantine, the removal it queues, its undo, the incident "revert". The
//     design gives these no authority marking yet; they are refused.

import { isNormalAddress } from './address.ts'
import { b64uDec, b64uEnc, sha256b64u, isSigningKey, verifyStatementSig, SKEW_MS, type Verdict } from './statements.ts'
import { verifyAssertion, statementChallenge, type Assertion } from './webauthn.ts'

/** Prefixes this module defines. */
export const ROSTER_PREFIXES: readonly string[] = Object.freeze(['ros', 'rip'])

/** The wait between a member's request and its ripening, on the directory's clock. */
export const ROSTER_WAIT_MS = 72 * 3_600_000
export const MAX_MEMBERS = 16
/** A chain longer than this is refused outright (a peer re-pins as it goes). */
export const MAX_CHAIN = 1024

/** The relying party and web origin passkey assertions are checked against.
 *  Native origins join this list as each is measured; a caller passes the list. */
export const ROSTER_RP_ID = 'id.bento.page'
export const ROSTER_WEB_ORIGINS: readonly string[] = Object.freeze(['https://signin.id.bento.page'])

const no = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })
const te = new TextEncoder()
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

const MAX_STATEMENT = 4096
/** statements.ts's split: printable ASCII, exact prefix and field count, empty fields kept. */
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
/** Byte order for ASCII text (never locale order). */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// --- ros. ----------------------------------------------------------------------

export type MemberKind = 'pk' | 'ck' | 'rk'
const KINDS: readonly string[] = ['pk', 'ck', 'rk']

export interface Member { kind: MemberKind; pub: string; quarantined: boolean }

export interface RosterHead {
  address: string
  seq: number
  prev: string | null
  members: Member[]
  dirNonce: string
  created: number
}

export const memberToken = (m: Member) => `${m.kind}~${m.pub}${m.quarantined ? '~q' : ''}`

/** Builds the one spelling of a head: members sorted. */
export function buildRos(h: RosterHead): string {
  const members = h.members.map(memberToken).sort(cmp).join(',')
  return ['ros', b64uEnc(te.encode(h.address)), h.seq, h.prev ?? '', members, h.dirNonce, h.created].join('.')
}

/** The grammar of a ros. text (no signatures, no chain). */
export async function parseRos(text: string): Promise<Verdict<RosterHead>> {
  const p = fields(text, 'ros', 7)
  if (!p) return no('grammar')
  const [, addressF, seqF, prevF, membersF, dirNonce, createdF] = p
  const address = freeText(addressF)
  if (address === null || !isNormalAddress(address)) return no('address')
  const seq = int(seqF)
  if (seq === null) return no('seq')
  if ((seq === 0) !== (prevF === '')) return no('prev')
  if (prevF !== '' && !isHash(prevF)) return no('prev')
  if (!isNonce(dirNonce)) return no('grammar')
  const created = ms(createdF)
  if (created === null) return no('grammar')

  const tokens = membersF.split(',')
  if (tokens.length < 1 || tokens.length > MAX_MEMBERS) return no('members')
  const members: Member[] = []
  const pubs = new Set<string>()
  let rk = 0
  for (let i = 0; i < tokens.length; i++) {
    if (i > 0 && cmp(tokens[i - 1], tokens[i]) >= 0) return no('members')   // strictly ascending
    const t = tokens[i].split('~')
    if (t.length !== 2 && !(t.length === 3 && t[2] === 'q')) return no('members')
    if (!KINDS.includes(t[0])) return no('members')
    if (pubs.has(t[1])) return no('members')
    pubs.add(t[1])
    if (t[0] === 'rk') rk++
    members.push({ kind: t[0] as MemberKind, pub: t[1], quarantined: t.length === 3 })
  }
  if (rk > 1) return no('members')
  for (const m of members) if (!(await isSigningKey(m.pub))) return no('key')
  return { ok: true, value: { address, seq, prev: prevF || null, members, dirNonce, created } }
}

// --- rip. ----------------------------------------------------------------------

export interface Ripening {
  rosHash: string
  requestedAt: number
  ripenedAt: number
  reset: boolean
  kid: string
}

export function buildRip(r: Ripening): string {
  return ['rip', r.rosHash, r.requestedAt, r.ripenedAt, r.reset ? 1 : 0, r.kid].join('.')
}

export function parseRip(text: string): Verdict<Ripening> {
  const p = fields(text, 'rip', 6)
  if (!p) return no('rip-grammar')
  const [, rosHash, reqF, ripF, resetF, kid] = p
  if (!isHash(rosHash) || !KID_RE.test(kid) || (resetF !== '0' && resetF !== '1')) return no('rip-grammar')
  const requestedAt = ms(reqF), ripenedAt = ms(ripF)
  if (requestedAt === null || ripenedAt === null || ripenedAt < requestedAt) return no('rip-grammar')
  return { ok: true, value: { rosHash, requestedAt, ripenedAt, reset: resetF === '1', kid } }
}

/** A rip. countersign over exactly `rosText`, by a pinned directory key, not from the future. */
export async function verifyRip(text: string, sig: string, opts: {
  rosText: string
  directoryKeys: Readonly<Record<string, string>>
  now: number
}): Promise<Verdict<Ripening>> {
  const r = parseRip(text)
  if (!r.ok) return r
  if (r.value.rosHash !== (await sha256b64u(opts.rosText))) return no('rip-mismatch')
  if (r.value.ripenedAt > opts.now + SKEW_MS) return no('not-yet-valid')
  if (!Object.hasOwn(opts.directoryKeys, r.value.kid)) return no('unknown-kid')
  if (!(await verifyStatementSig(opts.directoryKeys[r.value.kid], sig, text))) return no('rip-signature')
  return r
}

// --- the chain -------------------------------------------------------------------

/** One link as it travels: the texts, the countersign, and the member's proof. */
export interface RosterLink {
  ros: string
  rip: string
  /** the directory's signature over the rip. text (raw r‖s, low-S) */
  ripSig: string
  /** the member who asked (its pub); absent for setup and reset */
  signer?: string
  /** the signer's WebAuthn assertion over the ros. text, when it is a pk */
  assertion?: Assertion
  /** the signer's raw low-S signature over the ros. text, when it is an rk */
  sig?: string
}

export interface RosterMember extends Member {
  /** ripenedAt of the link from which this key has been a member without a break */
  since: number
}

export interface RosterState {
  address: string
  seq: number
  /** sha256 of the head's ros. text: what a peer pins */
  headHash: string
  /** ripenedAt of the head */
  ripenedAt: number
  members: RosterMember[]
  /** ripenedAt of seq 0, when the chain given starts there; null from a pin */
  createdAt: number | null
  /** ripenedAt of the latest reset in the links given, or null */
  lastResetAt: number | null
  /** false when the chain started from a pin past seq 0: members present at the
   *  pin carry the pin's ripenedAt as `since`, a LOWER bound on their age */
  sinceExact: boolean
}

export interface ChainOpts {
  /** pinned directory keys by kid */
  directoryKeys: Readonly<Record<string, string>>
  /** the passkeys' relying party id (ROSTER_RP_ID) */
  rpId: string
  /** the closed origin list (ROSTER_WEB_ORIGINS plus measured native origins) */
  origins: readonly string[]
  now: number
  /** sha256 of a ros. text this peer already verified and pinned. When given,
   *  links[0] must be that head; its countersign is re-checked (it sets the
   *  times) but its member proof and wait are not, and its own predecessor is
   *  not needed. Without it, links[0] must be the setup head (seq 0). */
  pinned?: string
}

const hasProof = (l: RosterLink) => l.signer !== undefined || l.assertion !== undefined || l.sig !== undefined
const soleLivePk = (list: Member[]) => list.length === 1 && list[0].kind === 'pk' && !list[0].quarantined

/**
 * Verify a roster chain offline. Never throws. The first failing link decides
 * the reason. A passkey assertion is checked WITHOUT a stored sign count: a peer
 * sees links out of the order they were signed (security's ruling on #914).
 */
export async function verifyRosterChain(links: readonly RosterLink[], opts: ChainOpts): Promise<Verdict<RosterState>> {
  try { return await chain(links, opts) } catch { return no('grammar') }
}

async function chain(links: readonly RosterLink[], opts: ChainOpts): Promise<Verdict<RosterState>> {
  if (!Array.isArray(links) || links.length === 0 || links.length > MAX_CHAIN) return no('grammar')
  if (typeof opts.rpId !== 'string' || opts.rpId === '' || !Array.isArray(opts.origins) || opts.origins.length === 0 ||
    !Number.isSafeInteger(opts.now)) return no('grammar')

  let prev: { head: RosterHead; hash: string; rip: Ripening } | null = null
  let since = new Map<string, number>()
  let createdAt: number | null = null
  let lastResetAt: number | null = null
  let sinceExact = true

  for (let i = 0; i < links.length; i++) {
    const l = links[i]
    if (!l || typeof l !== 'object' || typeof l.ros !== 'string' || typeof l.rip !== 'string' || typeof l.ripSig !== 'string') return no('grammar')
    const h = await parseRos(l.ros)
    if (!h.ok) return h
    const head = h.value
    const hash = await sha256b64u(l.ros)
    const r = await verifyRip(l.rip, l.ripSig, { rosText: l.ros, directoryKeys: opts.directoryKeys, now: opts.now })
    if (!r.ok) return r
    const rip = r.value

    if (prev === null) {
      if (opts.pinned !== undefined) {
        // the pinned head: checked when it was pinned; only its countersign is re-read
        if (hash !== opts.pinned) return no('pin')
        if (head.seq === 0) createdAt = rip.ripenedAt
        else sinceExact = false
        if (rip.reset) lastResetAt = rip.ripenedAt
        since = new Map(head.members.map((m) => [m.pub, rip.ripenedAt]))
      } else {
        if (head.seq !== 0) return no('anchor')
        if (rip.reset) return no('reset')
        if (hasProof(l)) return no('proof')
        if (!soleLivePk(head.members)) return no('setup-members')
        createdAt = rip.ripenedAt
        since = new Map(head.members.map((m) => [m.pub, rip.ripenedAt]))
      }
      prev = { head, hash, rip }
      continue
    }

    if (head.address !== prev.head.address) return no('address')
    if (head.seq !== prev.head.seq + 1) return no('seq')
    if (head.prev !== prev.hash) return no('chain')
    // one change at a time: nothing is requested before the previous change is in force
    if (rip.requestedAt < prev.rip.ripenedAt) return no('order')
    const waited = rip.ripenedAt - rip.requestedAt

    if (rip.reset) {
      if (hasProof(l)) return no('proof')
      if (!soleLivePk(head.members)) return no('reset-members')
      if (waited < ROSTER_WAIT_MS) return no('unripe')
      lastResetAt = rip.ripenedAt
      since = new Map(head.members.map((m) => [m.pub, rip.ripenedAt]))
      prev = { head, hash, rip }
      continue
    }

    // a member's change
    if (typeof l.signer !== 'string') return no('proof')
    const signer = prev.head.members.find((m) => m.pub === l.signer)
    if (!signer) return no('signer')
    if (signer.quarantined) return no('quarantined')
    if (signer.kind === 'pk') {
      if (l.assertion === undefined || l.sig !== undefined) return no('proof')
      const a = await verifyAssertion(l.assertion, { publicKey: signer.pub, challenge: await statementChallenge(l.ros),
        rpId: opts.rpId, origins: opts.origins })
      if (!a.ok) return no(`assertion-${a.reason}`)
    } else if (signer.kind === 'rk') {
      if (l.sig === undefined || l.assertion !== undefined) return no('proof')
      if (!(await verifyStatementSig(signer.pub, l.sig, l.ros))) return no('signature')
    } else return no('signer-kind')   // ck: the `roster` consent purpose is not defined yet

    const before = new Map(prev.head.members.map((m) => [m.pub, m]))
    const after = new Map(head.members.map((m) => [m.pub, m]))
    const added = head.members.filter((m) => !before.has(m.pub))
    const removed = prev.head.members.filter((m) => !after.has(m.pub))
    for (const m of head.members) {
      const was = before.get(m.pub)
      if (was && was.kind !== m.kind) return no('members')
      if (was ? was.quarantined !== m.quarantined : m.quarantined) return no('quarantine')
    }
    if (added.length + removed.length === 0) return no('no-change')
    if (added.length > 1 || removed.length > 1) return no('multi-change')
    if (added.length === 1 && removed.length === 1 && !(added[0].kind === 'rk' && removed[0].kind === 'rk')) return no('multi-change')
    const selfRemoval = added.length === 0 && removed[0].pub === signer.pub && head.members.some((m) => !m.quarantined)
    if (!selfRemoval && waited < ROSTER_WAIT_MS) return no('unripe')

    const next = new Map<string, number>()
    for (const m of head.members) next.set(m.pub, since.get(m.pub) ?? rip.ripenedAt)
    since = next
    prev = { head, hash, rip }
  }

  const p = prev!
  return { ok: true, value: {
    address: p.head.address, seq: p.head.seq, headHash: p.hash, ripenedAt: p.rip.ripenedAt,
    members: p.head.members.map((m) => ({ ...m, since: since.get(m.pub)! })),
    createdAt, lastResetAt, sinceExact,
  } }
}
