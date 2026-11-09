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
// milliseconds, the version in the prefix. kernel/fixtures/roster-v2.json is
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
//   rip.<sha256(ros text)>.<requestedAt>.<ripenedAt>.<auth>.<cause|empty>.<kid>
//
// Signed by the directory key `kid` (raw r‖s, low-S, as every directory
// statement), issued ONLY when the change ripens. requestedAt and ripenedAt are
// the directory's clock. A link without a rip. is not in force, so a change
// that was voided can never be shown to an offline peer as if it ripened.
//
// `auth` is the authority the directory claims for the link, one word, so a
// diff that does not match the claimed act is refused rather than reinterpreted:
//   m  a member's change (and the setup head). cause empty.
//   r  a reset. cause empty.
//   q  a void that QUARANTINES the member that asked (G4). cause = sha256 of the
//      voided request's ros. text, which the link carries.
//   l  the incident lever's revert: quarantines the member a ripened change
//      ADDED. cause = sha256 of that change's ros. text, which the link carries.
//   x  removal of a quarantined member, queued by the q or l link just before.
//      cause = sha256 of the previous head.
//   u  undo of the q or l link just before ("I removed the wrong passkey").
//      cause = sha256 of the previous head.
// There is no directory word that ADDS a member: a member is added only by a
// member's signed change, by setup, or by a reset.
//
// --- who authorises a link ---------------------------------------------------
//
//   setup (seq 0)    the directory's rip. alone (auth m). Exactly one member, an
//                    unquarantined pk. The creating passkey's registration is
//                    checked by the directory; peers do not parse registrations.
//   reset (r)        the directory's rip. alone, after the 72 h wait. Exactly one
//                    member, an unquarantined pk. Peers report it as a reset.
//   member change (m) a signature over the exact ros. text by an UNQUARANTINED
//                    member of the PREVIOUS head: a WebAuthn assertion for a pk
//                    (challenge = SHA-256 of the text), a raw low-S signature for
//                    an rk. One change per link: one member added, or one
//                    removed, or the rk replaced. Quarantine marks of continuing
//                    members never change, and a new member is never
//                    quarantined. The wait is ripenedAt − requestedAt ≥ 72 h,
//                    except a member removing ITSELF while another unquarantined
//                    member remains.
//   quarantine (q)   immediate. The link carries the VOIDED request (its ros.
//                    text, signer and proof). That request is for this address,
//                    one seq on from the previous head, names this link's
//                    previous head as its own previous, its signer is an
//                    unquarantined member of that head, and its proof verifies;
//                    the only change is that signer gaining ~q, and another
//                    unquarantined member remains. So the directory can only
//                    quarantine a member that really asked for something.
//   revert (l)       immediate. The link carries the CITED change (previous
//                    ros., ros., rip. and its signature): countersigned by a
//                    pinned kid under the word m, for this address, chained
//                    (sha256 of the previous text is the cited head's prevHash),
//                    and exactly one member added, nothing else (no kind
//                    change). The only change here is that member gaining ~q.
//                    Self-contained, so it verifies from any pin.
//   removal (x)      after the 72 h wait, requested at the moment the previous
//                    q or l link ripened: exactly one member removed, nothing
//                    else, and it is THE member that link marked (its TARGET).
//   undo (u)         immediate, right after a q or l link: exactly one ~q mark
//                    cleared, nothing else, and it is that link's target. The
//                    member keeps its `since`.
// q, l, x and u carry no member proof of their own.
//
// The TARGET of a q link is voided.signer; of an l link, the one member the
// cited change added. Each is bound to the link by its cause hash, so x and u
// need no field of their own. When the q or l link is the PINNED head, its
// target is read from the evidence it carries, after the cause check (its rip.
// is re-verified at the pin, so the evidence cannot be swapped); a pinned q or l
// link stored without its evidence refuses a following x or u (`evidence`):
// hosts store a pinned link WHOLE, voided or cited included. A stale mark (one
// set by an earlier q or l) is never lifted or removed by the directory's word;
// only a member's own 72 h change removes it.
//
// NOT HERE YET, and refused until defined (fail closed):
//   - a consent-key (ck) signature or co-sign (the `roster` consent purpose,
//     the next kernel change). Until then a ck-signed link is refused, and so is
//     any member link that ripened in under 72 h other than a self-removal.

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

/** The authority a rip. claims: member change, reset, quarantine on a void,
 *  lever revert, removal of a quarantined member, undo. */
export type Authority = 'm' | 'r' | 'q' | 'l' | 'x' | 'u'
const AUTHORITIES: readonly string[] = ['m', 'r', 'q', 'l', 'x', 'u']
/** the words whose cause field is empty; every other word names a hash */
const CAUSELESS: readonly string[] = ['m', 'r']

export interface Ripening {
  rosHash: string
  requestedAt: number
  ripenedAt: number
  auth: Authority
  /** the hash the act cites (q, l, x, u); null for m and r */
  cause: string | null
  kid: string
}

export function buildRip(r: Ripening): string {
  return ['rip', r.rosHash, r.requestedAt, r.ripenedAt, r.auth, r.cause ?? '', r.kid].join('.')
}

export function parseRip(text: string): Verdict<Ripening> {
  const p = fields(text, 'rip', 7)
  if (!p) return no('rip-grammar')
  const [, rosHash, reqF, ripF, auth, causeF, kid] = p
  if (!isHash(rosHash) || !KID_RE.test(kid) || !AUTHORITIES.includes(auth)) return no('rip-grammar')
  if (CAUSELESS.includes(auth) ? causeF !== '' : !isHash(causeF)) return no('rip-grammar')
  const requestedAt = ms(reqF), ripenedAt = ms(ripF)
  if (requestedAt === null || ripenedAt === null || ripenedAt < requestedAt) return no('rip-grammar')
  return { ok: true, value: { rosHash, requestedAt, ripenedAt, auth: auth as Authority, cause: causeF || null, kid } }
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
  /** auth q only: the request the void cancelled, with its member proof */
  voided?: { ros: string; signer: string; assertion?: Assertion; sig?: string }
  /** auth l only: the ripened change whose added member is quarantined */
  cited?: { prevRos: string; ros: string; rip: string; ripSig: string }
}

export interface RosterMember extends Member {
  /** ripenedAt of the link from which this key has been a member without a break */
  since: number
}

/** One head of a verified chain, as a device certificate names it (devices.ts). */
export interface PlacedHead {
  /** sha256 of the ros. text */
  hash: string
  seq: number
  ripenedAt: number
  members: Member[]
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
  /** every head of the links given, in chain order (the first is the pin or the
   *  setup head): the heads a device certificate may name */
  heads: PlacedHead[]
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
const carries = (l: RosterLink) => l.voided !== undefined || l.cited !== undefined
const soleLivePk = (list: Member[]) => list.length === 1 && list[0].kind === 'pk' && !list[0].quarantined
const str = (v: unknown): v is string => typeof v === 'string'

/** A member's proof over `text`: an assertion for a pk, a raw low-S signature for an rk. */
async function memberProof(signer: Member, p: { assertion?: Assertion; sig?: string }, text: string, opts: ChainOpts): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (signer.kind === 'pk') {
    if (p.assertion === undefined || p.sig !== undefined) return no('proof')
    const a = await verifyAssertion(p.assertion, { publicKey: signer.pub, challenge: await statementChallenge(text),
      rpId: opts.rpId, origins: opts.origins })
    if (!a.ok) return no(`assertion-${a.reason}`)
  } else if (signer.kind === 'rk') {
    if (!str(p.sig) || p.assertion !== undefined) return no('proof')
    if (!(await verifyStatementSig(signer.pub, p.sig, text))) return no('signature')
  } else return no('signer-kind')   // ck: the `roster` consent purpose is not defined yet
  return { ok: true }
}

/** What a link changed: members added and removed, and quarantine marks set and cleared. */
function diffOf(before: Member[], after: Member[]) {
  const b = new Map(before.map((m) => [m.pub, m]))
  const a = new Set(after.map((m) => m.pub))
  const added = after.filter((m) => !b.has(m.pub))
  const removed = before.filter((m) => !a.has(m.pub))
  let kindChanged = false
  const marked: Member[] = [], cleared: Member[] = []
  for (const m of after) {
    const was = b.get(m.pub)
    if (!was) continue
    if (was.kind !== m.kind) kindChanged = true
    if (!was.quarantined && m.quarantined) marked.push(m)
    if (was.quarantined && !m.quarantined) cleared.push(m)
  }
  return { added, removed, marked, cleared, kindChanged }
}
/** exactly one mark set (q, l) */
const onlyMarked = (d: ReturnType<typeof diffOf>, pub: string) =>
  d.added.length === 0 && d.removed.length === 0 && d.cleared.length === 0 && d.marked.length === 1 && d.marked[0].pub === pub

/** The member a q or l link marked, read from the evidence it carries, when
 *  that evidence matches the link's cause; null otherwise. For a PINNED head,
 *  whose own checks ran when it was pinned. */
async function pinnedTarget(l: RosterLink, rip: Ripening): Promise<string | null> {
  if (rip.auth === 'q') {
    const v = l.voided
    if (!v || typeof v !== 'object' || !str(v.ros) || !str(v.signer)) return null
    return rip.cause === (await sha256b64u(v.ros)) ? v.signer : null
  }
  if (rip.auth === 'l') {
    const c = l.cited
    if (!c || typeof c !== 'object' || !str(c.prevRos) || !str(c.ros)) return null
    if (rip.cause !== (await sha256b64u(c.ros))) return null
    const ch = await parseRos(c.ros), cp = await parseRos(c.prevRos)
    if (!ch.ok || !cp.ok) return null
    const cd = diffOf(cp.value.members, ch.value.members)
    return cd.added.length === 1 ? cd.added[0].pub : null
  }
  return null
}

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
  /** the member the previous link marked, when it was a q or l link (x and u must name it) */
  let target: string | null = null
  const heads: PlacedHead[] = []

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
        if (rip.auth === 'r') lastResetAt = rip.ripenedAt
        since = new Map(head.members.map((m) => [m.pub, rip.ripenedAt]))
        target = await pinnedTarget(l, rip)
      } else {
        if (head.seq !== 0) return no('anchor')
        if (rip.auth !== 'm') return no('auth')
        if (hasProof(l) || carries(l)) return no('proof')
        if (!soleLivePk(head.members)) return no('setup-members')
        createdAt = rip.ripenedAt
        since = new Map(head.members.map((m) => [m.pub, rip.ripenedAt]))
      }
      prev = { head, hash, rip }; heads.push({ hash, seq: head.seq, ripenedAt: rip.ripenedAt, members: head.members })
      continue
    }

    if (head.address !== prev.head.address) return no('address')
    if (head.seq !== prev.head.seq + 1) return no('seq')
    if (head.prev !== prev.hash) return no('chain')
    // one change at a time: nothing is requested before the previous change is in force
    if (rip.requestedAt < prev.rip.ripenedAt) return no('order')
    const waited = rip.ripenedAt - rip.requestedAt
    const marked = target
    target = null

    if (rip.auth === 'r') {
      if (hasProof(l) || carries(l)) return no('proof')
      if (!soleLivePk(head.members)) return no('reset-members')
      if (waited < ROSTER_WAIT_MS) return no('unripe')
      lastResetAt = rip.ripenedAt
      since = new Map(head.members.map((m) => [m.pub, rip.ripenedAt]))
      prev = { head, hash, rip }; heads.push({ hash, seq: head.seq, ripenedAt: rip.ripenedAt, members: head.members })
      continue
    }

    if (rip.auth !== 'm') {
      // the directory's acts on the mailbox's authority: no member proof of their own
      if (hasProof(l)) return no('proof')
      const d = diffOf(prev.head.members, head.members)
      if (d.kindChanged) return no('members')
      if (rip.auth === 'q') {
        if (l.cited !== undefined) return no('proof')
        const v = l.voided
        if (!v || typeof v !== 'object' || !str(v.ros) || !str(v.signer)) return no('voided')
        if (rip.cause !== (await sha256b64u(v.ros))) return no('cause')
        const vh = await parseRos(v.ros)
        if (!vh.ok) return no('voided')
        if (vh.value.address !== head.address) return no('voided-address')
        if (vh.value.seq !== prev.head.seq + 1) return no('voided-seq')
        if (vh.value.prev !== prev.hash) return no('voided-prev')   // asked against this link's previous head
        const asker = prev.head.members.find((m) => m.pub === v.signer)
        if (!asker) return no('voided-signer')
        if (asker.quarantined) return no('voided-quarantined')
        const pr = await memberProof(asker, v, v.ros, opts)
        if (!pr.ok) return no(`voided-${pr.reason}`)
        if (!onlyMarked(d, asker.pub)) return no('target')
        if (!head.members.some((m) => !m.quarantined)) return no('last-live')
        target = asker.pub
      } else if (rip.auth === 'l') {
        if (l.voided !== undefined) return no('proof')
        const c = l.cited
        if (!c || typeof c !== 'object' || !str(c.prevRos) || !str(c.ros) || !str(c.rip) || !str(c.ripSig)) return no('cited')
        if (rip.cause !== (await sha256b64u(c.ros))) return no('cause')
        const cr = await verifyRip(c.rip, c.ripSig, { rosText: c.ros, directoryKeys: opts.directoryKeys, now: opts.now })
        if (!cr.ok) return no(`cited-${cr.reason}`)
        if (cr.value.auth !== 'm') return no('cited-auth')   // a member's change, never a directory act
        const ch = await parseRos(c.ros), cp = await parseRos(c.prevRos)
        if (!ch.ok || !cp.ok) return no('cited')
        if (ch.value.address !== head.address) return no('cited-address')
        if (ch.value.prev !== (await sha256b64u(c.prevRos))) return no('cited-chain')
        const cd = diffOf(cp.value.members, ch.value.members)
        if (cd.added.length !== 1 || cd.removed.length + cd.marked.length + cd.cleared.length !== 0) return no('cited-change')
        if (cd.kindChanged) return no('cited-change')
        if (!onlyMarked(d, cd.added[0].pub)) return no('target')
        target = cd.added[0].pub
      } else {
        // x and u answer the q or l link just before, and cite it
        if (carries(l)) return no('proof')
        if (prev.rip.auth !== 'q' && prev.rip.auth !== 'l') return no('auth')
        if (rip.cause !== prev.hash) return no('cause')
        // the member that link marked: from its diff, or from a pinned link's evidence
        if (marked === null) return no('evidence')
        if (rip.auth === 'x') {
          if (rip.requestedAt !== prev.rip.ripenedAt) return no('order')   // queued in the same step
          if (d.added.length + d.marked.length + d.cleared.length !== 0 || d.removed.length !== 1 || !d.removed[0].quarantined) return no('target')
          if (d.removed[0].pub !== marked) return no('target')
          if (waited < ROSTER_WAIT_MS) return no('unripe')
        } else {
          if (d.added.length + d.removed.length + d.marked.length !== 0 || d.cleared.length !== 1) return no('target')
          if (d.cleared[0].pub !== marked) return no('target')
        }
      }
      const kept = new Map<string, number>()
      for (const m of head.members) kept.set(m.pub, since.get(m.pub)!)
      since = kept
      prev = { head, hash, rip }; heads.push({ hash, seq: head.seq, ripenedAt: rip.ripenedAt, members: head.members })
      continue
    }

    // a member's change
    if (carries(l)) return no('proof')
    if (typeof l.signer !== 'string') return no('proof')
    const signer = prev.head.members.find((m) => m.pub === l.signer)
    if (!signer) return no('signer')
    if (signer.quarantined) return no('quarantined')
    const pr = await memberProof(signer, l, l.ros, opts)
    if (!pr.ok) return pr

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
    prev = { head, hash, rip }; heads.push({ hash, seq: head.seq, ripenedAt: rip.ripenedAt, members: head.members })
  }

  const p = prev!
  return { ok: true, value: {
    address: p.head.address, seq: p.head.seq, headHash: p.hash, ripenedAt: p.rip.ripenedAt,
    members: p.head.members.map((m) => ({ ...m, since: since.get(m.pub)! })),
    createdAt, lastResetAt, sinceExact, heads,
  } }
}
