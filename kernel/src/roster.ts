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
// cited change added. The cause hash names the evidence; a q's signer is bound
// by its proof over the voided text, an l's addition by the cited chain. So x
// and u need no field of their own. When the q or l link is the PINNED head, its
// target is read from the evidence it carries, after the cause check (its rip.
// covers only the cause, so the pinned link's evidence is re-checked: a q's
// voided proof, address and seq, an l's cited chain and its one addition); a
// pinned q or l link stored without such evidence refuses a following x or u (`evidence`):
// hosts store a pinned link WHOLE, voided or cited included. A stale mark (one
// set by an earlier q or l) is never lifted or removed by the directory's word;
// only a member's own 72 h change removes it.
//
// --- consent keys (ck): the `roster` consent purpose -------------------------
//
// A native host's hardware consent key signs a `cns.` (statements.ts) with
// purpose `roster`, audience `dir`, challenge = the head's dirNonce, over the
// exact ros. text: the link carries it as `cns` with its signature `sig`.
// Checked offline by verifyCoSign, against the directory's clock: the co-sign
// was alive at the link's requestedAt, for at most its 5-minute life.
//
//   as the requester   a ck that is an unquarantined member of the previous
//                      head may ask for a member change, like a pk or an rk.
//   as the co-signer   a link asked for by any member may also carry `cosign`:
//                      another ck's cns. over the same ros. text. The co-signer
//                      is an unquarantined ck of the PREVIOUS head, never the
//                      requester itself, and must be RIPE.
//   ripe               a member for at least 72 h at the link's requestedAt,
//                      measured from its `since` in THIS verified chain (a pin
//                      gives a later since, so it only refuses more), never
//                      from any requester's clock.
// A change signed or co-signed by a ripe ck needs no 72 h wait: that is the
// whole point of a native device. A browser can never co-sign (a pk is not a
// ck), and a co-sign that does not count is a refusal, never ignored.
//
// --- vrs. — a member stops a reset (the directory checks it; peers never see one)
//
//   vrs.<b64u(address)>.<sha256(reset ros. text)>.<dirNonce>
//
// Signed by an unquarantined member of the head the reset would replace (an
// assertion for a pk, a raw signature for an rk, a `roster` co-sign for a ck),
// over a single-use directory challenge. Accepted only when the account was at
// least 14 days old when the reset was REQUESTED (G5, judged at request time so
// a reset begun in an account's first 14 days cannot be stopped by a passkey a
// hostile setup planted; security's C4 on #944).
//
// --- wout. — a member signs every browser out (the directory checks it)
//
//   wout.<b64u(address)>.<at>.<dirNonce>
//
// Signed by an unquarantined member of the current head (as for vrs.: an
// assertion for a pk, a raw signature for an rk, a `roster` co-sign for a ck)
// over a single-use directory challenge; `at` is the time the directory issued
// that challenge, so the text says when the person asked. No wait: it only
// takes power away. The directory then refuses every browser certificate
// (wdev.) of the account whose ceremony is at or before the moment it ACCEPTS
// the sign-out (renewals and check-ins answer revoked), and every enrolment
// whose challenge was issued before then; it logs both times (signed `at`,
// applied) and answers the applied one. Native certificates (dev2.) are not
// touched. A browser key's last watt. stays valid for up to 24 h at peers.
//
// --- adel. — a member asks to delete the account (the directory checks it)
//
//   adel.<b64u(address)>.<headHash>.<dirNonce>
//
// Signed by an unquarantined member of the head `headHash` names, which must be
// the current head, over a single-use directory challenge. The directory QUEUES
// it like any change (requestedAt on its clock; a second change is refused
// while it waits), mails the address a link that voids it, and carries it out
// DELETE_WAIT_MS (72 h) later, and only if it was not voided and the account's
// head is still `headHash`. The way without a passkey is the directory's
// emailed link alone, which no statement carries. OPEN for the directory's
// deletion route, not settled here (security's review of this layout, D-A1 to
// D-A3): what a void does to the signer (a stolen member key must not be able
// to re-file the moment its request is voided, which would hold the queue and
// block the owner's removal of that key), and how a reset interacts with a
// waiting deletion (only a reset that RIPENS first changes the head; a reset
// request must drop the deletion, never set it aside to be revived).
//
// --- the passkey user handle (sign-in host and native hosts alike)
//
//   user.id = SHA-256("bento-dir/1/addr\n" ‖ address in normal form) ‖ 16 random bytes
//
// 48 bytes. The first 32 are the account's storage name at the directory: a
// discoverable sign-in returns the handle, and that is how the directory finds
// the account. The random tail makes every passkey's handle distinct, so a new
// passkey (a reset) never overwrites an older one on the same authenticator.
// The handle only ROUTES: it is not covered by the assertion's signature, so
// membership is decided by the credential the account stores, never by it.
// Every host that makes a passkey for ROSTER_RP_ID uses this layout.

import { isNormalAddress } from './address.ts'
import { b64uDec, b64uEnc, sha256b64u, isSigningKey, verifyStatementSig, verifyCoSign, SKEW_MS, type Verdict } from './statements.ts'
import { verifyAssertion, statementChallenge, type Assertion } from './webauthn.ts'

/** Prefixes this module defines. */
export const ROSTER_PREFIXES: readonly string[] = Object.freeze(['ros', 'rip', 'vrs', 'wout', 'adel'])

/** The wait between a member's request and its ripening, on the directory's clock. */
export const ROSTER_WAIT_MS = 72 * 3_600_000
/** An account is "new" for this long after setup: no member may stop a reset
 *  REQUESTED in that window (G5). */
export const NEW_ACCOUNT_MS = 14 * 24 * 3_600_000
/** A queued account deletion is carried out this long after the request. */
export const DELETE_WAIT_MS = ROSTER_WAIT_MS
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
  /** the signer's raw low-S signature: over the ros. text when it is an rk,
   *  over `cns` when it is a ck */
  sig?: string
  /** a ck signer's cns. text (purpose roster, over the ros. text) */
  cns?: string
  /** a ripe consent key's co-sign of a member change: skips the 72 h wait */
  cosign?: { signer: string; cns: string; sig: string }
  /** auth q only: the request the void cancelled, with its member proof */
  voided?: { ros: string; signer: string; assertion?: Assertion; sig?: string; cns?: string }
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
  /** the rp a consent key's cns. names (`bento`). Needed only for a link a ck
   *  signs or co-signs; without it such a link is refused (grammar). */
  consentRp?: string
}

const hasProof = (l: RosterLink) => l.signer !== undefined || l.assertion !== undefined || l.sig !== undefined ||
  l.cns !== undefined || l.cosign !== undefined
const carries = (l: RosterLink) => l.voided !== undefined || l.cited !== undefined
const soleLivePk = (list: Member[]) => list.length === 1 && list[0].kind === 'pk' && !list[0].quarantined
const str = (v: unknown): v is string => typeof v === 'string'

type Proof = { assertion?: Assertion; sig?: string; cns?: string }
type ProofOpts = { rpId: string; origins: readonly string[]; consentRp?: string }

/** A member's proof over `text`: an assertion for a pk, a raw low-S signature
 *  for an rk, a `roster` co-sign (cns. + its signature) for a ck. `nonce` is the
 *  directory nonce inside `text`; `at` the directory's clock for a ck's cns.
 *  (null: evidence only, no time check). */
export async function memberProof(signer: Member, p: Proof, text: string, nonce: string, at: number | null, opts: ProofOpts): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (signer.kind === 'pk') {
    if (p.assertion === undefined || p.sig !== undefined || p.cns !== undefined) return no('proof')
    const a = await verifyAssertion(p.assertion, { publicKey: signer.pub, challenge: await statementChallenge(text),
      rpId: opts.rpId, origins: opts.origins })
    if (!a.ok) return no(`assertion-${a.reason}`)
  } else if (signer.kind === 'rk') {
    if (!str(p.sig) || p.assertion !== undefined || p.cns !== undefined) return no('proof')
    if (!(await verifyStatementSig(signer.pub, p.sig, text))) return no('signature')
  } else if (signer.kind === 'ck') {
    if (!str(p.cns) || !str(p.sig) || p.assertion !== undefined) return no('proof')
    if (typeof opts.consentRp !== 'string' || opts.consentRp === '') return no('grammar')
    const c = await verifyCoSign(p.cns, p.sig, { consentPub: signer.pub, rp: opts.consentRp, purpose: 'roster', payloadText: text, challenge: nonce, at })
    if (!c.ok) return no(`consent-${c.reason}`)
  } else return no('signer-kind')
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

/** The member a q or l link marked, read from the evidence it carries; null
 *  when that evidence does not prove it. For a PINNED head. The countersign
 *  covers only the cause hash, and the evidence may have been refetched from
 *  the very party the target rule guards against, so every part of it that
 *  names the target is re-bound here: a q's signer by its proof over the
 *  voided text, an l's previous head by the cited head's prev hash. */
async function pinnedTarget(l: RosterLink, rip: Ripening, head: RosterHead, opts: ChainOpts): Promise<string | null> {
  if (rip.auth === 'q') {
    const v = l.voided
    if (!v || typeof v !== 'object' || !str(v.ros) || !str(v.signer)) return null
    if (rip.cause !== (await sha256b64u(v.ros))) return null
    const vh = await parseRos(v.ros)
    if (!vh.ok || vh.value.address !== head.address || vh.value.seq !== head.seq) return null
    // the signer is not covered by the cause: bind it by its proof over the voided text
    const asker = head.members.find((m) => m.pub === v.signer)
    if (!asker || !(await memberProof(asker, v, v.ros, vh.value.dirNonce, null, opts)).ok) return null
    return asker.pub
  }
  if (rip.auth === 'l') {
    const c = l.cited
    if (!c || typeof c !== 'object' || !str(c.prevRos) || !str(c.ros)) return null
    if (rip.cause !== (await sha256b64u(c.ros))) return null
    const ch = await parseRos(c.ros), cp = await parseRos(c.prevRos)
    if (!ch.ok || !cp.ok) return null
    // prevRos is not covered by the cause: bind it through the cited head's prev hash
    if (ch.value.prev !== (await sha256b64u(c.prevRos))) return null
    const cd = diffOf(cp.value.members, ch.value.members)
    if (cd.added.length !== 1 || cd.removed.length + cd.marked.length + cd.cleared.length !== 0 || cd.kindChanged) return null
    return cd.added[0].pub
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
        target = await pinnedTarget(l, rip, head, opts)
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
        const pr = await memberProof(asker, v, v.ros, vh.value.dirNonce, null, opts)
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
    const pr = await memberProof(signer, l, l.ros, head.dirNonce, rip.requestedAt, opts)
    if (!pr.ok) return pr
    // a consent key is ripe once it has been a member 72 h at the request, on this chain's since
    const ripe = (pub: string) => { const t = since.get(pub); return t !== undefined && rip.requestedAt - t >= ROSTER_WAIT_MS }
    let coSigned = false
    if (l.cosign !== undefined) {
      const c = l.cosign
      if (!c || typeof c !== 'object' || !str(c.signer) || !str(c.cns) || !str(c.sig)) return no('cosign')
      if (c.signer === signer.pub) return no('cosign')
      const co = prev.head.members.find((m) => m.pub === c.signer)
      if (!co) return no('cosign-signer')
      if (co.kind !== 'ck') return no('cosign-kind')
      if (co.quarantined) return no('cosign-quarantined')
      if (!ripe(co.pub)) return no('cosign-unripe')
      const cp = await memberProof(co, { cns: c.cns, sig: c.sig }, l.ros, head.dirNonce, rip.requestedAt, opts)
      if (!cp.ok) return no(cp.reason === 'grammar' ? 'grammar' : `cosign-${cp.reason}`)   // grammar: no consentRp from the caller
      coSigned = true
    }
    const waived = coSigned || (signer.kind === 'ck' && ripe(signer.pub))

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
    if (!selfRemoval && !waived && waited < ROSTER_WAIT_MS) return no('unripe')

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

// --- vrs. — a member stops a reset ---------------------------------------------------

export interface ResetStop { address: string; resetHash: string; dirNonce: string }

export function buildVrs(v: ResetStop): string {
  return ['vrs', b64uEnc(te.encode(v.address)), v.resetHash, v.dirNonce].join('.')
}

export interface ResetStopOpts {
  /** the verified roster: its head is the head the reset would replace */
  roster: RosterState
  /** the reset request's ros. text, as the directory holds it */
  resetRos: string
  /** when the directory took the reset request (its clock) */
  resetRequestedAt: number
  /** the challenge the directory issued to this session */
  challenge: string
  /** spends the challenge; false if it was spent or has expired. Called once the
   *  text parses, before anything else: every refusal before it is `grammar` */
  spend: (challenge: string) => boolean
  rpId: string
  origins: readonly string[]
  /** the rp a consent key's cns. names; needed only when a ck stops the reset */
  consentRp?: string
  /** the directory's clock now (a ck's co-sign must be alive) */
  now: number
}

/**
 * For the DIRECTORY: may this member stop this reset? The proof is the member's,
 * over the exact vrs. text: `assertion` for a pk, `sig` for an rk, `cns` + `sig`
 * for a ck. The account's age is judged at the reset's REQUEST time; an account
 * created less than 14 days before the request cannot have it stopped by a member
 * (only by the mailbox's own void link). A chain read from a pin has no creation
 * time, so its age is unknown and the stop is refused: the directory holds the
 * whole chain. Never throws.
 */
export async function verifyResetStop(text: string, signer: string, proof: Proof, opts: ResetStopOpts): Promise<Verdict<ResetStop>> {
  try { return await resetStop(text, signer, proof, opts) } catch { return no('grammar') }
}

async function resetStop(text: string, signerPub: string, proof: Proof, opts: ResetStopOpts): Promise<Verdict<ResetStop>> {
  const p = fields(text, 'vrs', 4)
  if (!p) return no('grammar')
  const [, addressF, resetHash, dirNonce] = p
  const address = freeText(addressF)
  if (address === null || !isNormalAddress(address)) return no('grammar')
  if (!isHash(resetHash) || !isNonce(dirNonce)) return no('grammar')
  const ro = opts.roster
  if (!ro || !Array.isArray(ro.members) || !str(signerPub) || !proof || typeof proof !== 'object' || !str(opts.resetRos) ||
    !Number.isSafeInteger(opts.resetRequestedAt) || !Number.isSafeInteger(opts.now) || !str(opts.challenge) || typeof opts.spend !== 'function') return no('grammar')
  if (!opts.spend(opts.challenge)) return no('replay')
  if (dirNonce !== opts.challenge) return no('challenge')
  if (address !== ro.address) return no('address')
  if (resetHash !== (await sha256b64u(opts.resetRos))) return no('reset-mismatch')
  // the reset names this roster's head as its previous, and installs one passkey
  const rh = await parseRos(opts.resetRos)
  if (!rh.ok || rh.value.address !== ro.address || rh.value.seq !== ro.seq + 1 || rh.value.prev !== ro.headHash ||
    !soleLivePk(rh.value.members)) return no('reset')
  if (opts.resetRequestedAt < ro.ripenedAt) return no('order')
  // G5, judged when the reset was REQUESTED
  if (ro.createdAt === null) return no('age-unknown')
  if (opts.resetRequestedAt - ro.createdAt < NEW_ACCOUNT_MS) return no('new-account')
  const m = ro.members.find((x) => x.pub === signerPub)
  if (!m) return no('signer')
  if (m.quarantined) return no('quarantined')
  const pr = await memberProof(m, proof, text, dirNonce, opts.now, opts)
  if (!pr.ok) return pr
  return { ok: true, value: { address, resetHash, dirNonce } }
}

// --- wout. — a member signs every browser out ------------------------------------------

export interface SignOut { address: string; at: number; dirNonce: string }

export function buildWout(w: SignOut): string {
  return ['wout', b64uEnc(te.encode(w.address)), w.at, w.dirNonce].join('.')
}

export interface SignOutOpts {
  /** the verified roster: its head is the account's latest ripened head */
  roster: RosterState
  /** the challenge the directory issued for this sign-out, and when it issued it */
  challenge: string
  challengeAt: number
  /** spends the challenge; false if it was spent or has expired. Called once the
   *  text parses, before anything else: every refusal before it is `grammar` */
  spend: (challenge: string) => boolean
  rpId: string
  origins: readonly string[]
  /** the rp a consent key's cns. names; needed only when a ck signs */
  consentRp?: string
  /** the directory's clock now (a ck's co-sign must be alive) */
  now: number
}

/**
 * For the DIRECTORY: may this member sign every browser of the account out? The
 * proof is the member's over the exact wout. text (memberProof). The address
 * must be in normal form, the one the account's storage name hashes. Never throws.
 */
export async function verifyWout(text: string, signer: string, proof: Proof, opts: SignOutOpts): Promise<Verdict<SignOut>> {
  try { return await signOut(text, signer, proof, opts) } catch { return no('grammar') }
}

async function signOut(text: string, signerPub: string, proof: Proof, opts: SignOutOpts): Promise<Verdict<SignOut>> {
  const p = fields(text, 'wout', 4)
  if (!p) return no('grammar')
  const [, addressF, atF, dirNonce] = p
  const address = freeText(addressF)
  if (address === null || !isNormalAddress(address)) return no('grammar')
  const at = ms(atF)
  if (at === null || !isNonce(dirNonce)) return no('grammar')
  const ro = opts.roster
  if (!ro || !Array.isArray(ro.members) || !str(signerPub) || !proof || typeof proof !== 'object' || !str(opts.challenge) ||
    !Number.isSafeInteger(opts.challengeAt) || !Number.isSafeInteger(opts.now) || typeof opts.spend !== 'function') return no('grammar')
  if (!opts.spend(opts.challenge)) return no('replay')
  if (dirNonce !== opts.challenge) return no('challenge')
  if (at !== opts.challengeAt) return no('at')
  if (address !== ro.address) return no('address')
  const m = ro.members.find((x) => x.pub === signerPub)
  if (!m) return no('signer')
  if (m.quarantined) return no('quarantined')
  const pr = await memberProof(m, proof, text, dirNonce, opts.now, opts)
  if (!pr.ok) return pr
  return { ok: true, value: { address, at, dirNonce } }
}

// --- adel. — a member asks to delete the account ---------------------------------------

export interface DeletionRequest { address: string; headHash: string; dirNonce: string }

export function buildAdel(d: DeletionRequest): string {
  return ['adel', b64uEnc(te.encode(d.address)), d.headHash, d.dirNonce].join('.')
}

export interface DeletionOpts {
  /** the verified roster: its head is the account's latest ripened head */
  roster: RosterState
  /** the challenge the directory issued for this request */
  challenge: string
  /** spends the challenge (as SignOutOpts) */
  spend: (challenge: string) => boolean
  rpId: string
  origins: readonly string[]
  consentRp?: string
  now: number
}

/**
 * For the DIRECTORY: may this member ask for the account's deletion? Accepting
 * it QUEUES the deletion (DELETE_WAIT_MS, a void link to the address); the
 * directory carries it out only if the head is then still `headHash`. Never throws.
 */
export async function verifyAdel(text: string, signer: string, proof: Proof, opts: DeletionOpts): Promise<Verdict<DeletionRequest>> {
  try { return await deletion(text, signer, proof, opts) } catch { return no('grammar') }
}

async function deletion(text: string, signerPub: string, proof: Proof, opts: DeletionOpts): Promise<Verdict<DeletionRequest>> {
  const p = fields(text, 'adel', 4)
  if (!p) return no('grammar')
  const [, addressF, headHash, dirNonce] = p
  const address = freeText(addressF)
  if (address === null || !isNormalAddress(address)) return no('grammar')
  if (!isHash(headHash) || !isNonce(dirNonce)) return no('grammar')
  const ro = opts.roster
  if (!ro || !Array.isArray(ro.members) || !str(signerPub) || !proof || typeof proof !== 'object' || !str(opts.challenge) ||
    !Number.isSafeInteger(opts.now) || typeof opts.spend !== 'function') return no('grammar')
  if (!opts.spend(opts.challenge)) return no('replay')
  if (dirNonce !== opts.challenge) return no('challenge')
  if (address !== ro.address) return no('address')
  if (headHash !== ro.headHash) return no('roster-head')
  const m = ro.members.find((x) => x.pub === signerPub)
  if (!m) return no('signer')
  if (m.quarantined) return no('quarantined')
  const pr = await memberProof(m, proof, text, dirNonce, opts.now, opts)
  if (!pr.ok) return pr
  return { ok: true, value: { address, headHash, dirNonce } }
}

// --- the passkey user handle -------------------------------------------------------------

/** What the account's storage name hashes, before the address. */
export const USER_HANDLE_LABEL = 'bento-dir/1/addr\n'
/** user.id: the 32-byte account name, then 16 random bytes. */
export const USER_HANDLE_BYTES = 48
const USER_HANDLE_TAIL = 16

/** SHA-256(USER_HANDLE_LABEL ‖ address): the account's storage name, the first
 *  32 bytes of every passkey's user handle. Null unless the address is in normal form. */
export async function accountNameOf(address: string): Promise<Uint8Array | null> {
  if (typeof address !== 'string' || !isNormalAddress(address)) return null
  return new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(USER_HANDLE_LABEL + address) as BufferSource))
}

/** The user handle a host gives a new passkey: the account name ‖ `tail`, which
 *  the host draws fresh (16 random bytes) for each passkey. Null on a bad input. */
export async function buildUserHandle(address: string, tail: Uint8Array): Promise<Uint8Array | null> {
  if (!(tail instanceof Uint8Array) || tail.length !== USER_HANDLE_TAIL) return null
  const name = await accountNameOf(address)
  if (!name) return null
  const out = new Uint8Array(USER_HANDLE_BYTES)
  out.set(name, 0)
  out.set(tail, name.length)
  return out
}

/** The account name a returned user handle routes to: its first 32 bytes, or
 *  null unless it is exactly 48 bytes. It only routes; it proves nothing. */
export function userHandleAccount(handle: Uint8Array): Uint8Array | null {
  if (!(handle instanceof Uint8Array) || handle.length !== USER_HANDLE_BYTES) return null
  return handle.slice(0, USER_HANDLE_BYTES - USER_HANDLE_TAIL)
}
