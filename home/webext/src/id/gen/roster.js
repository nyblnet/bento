// GENERATED from kernel/src/roster.ts by scripts/gen-webext-id.mjs — do not edit.
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

import { isNormalAddress } from './address.js'
import { b64uDec, b64uEnc, sha256b64u, isSigningKey, verifyStatementSig, verifyCoSign, SKEW_MS,              } from './statements.js'
import { verifyAssertion, statementChallenge,                } from './webauthn.js'

/** Prefixes this module defines. */
export const ROSTER_PREFIXES                    = Object.freeze(['ros', 'rip', 'vrs'])

/** The wait between a member's request and its ripening, on the directory's clock. */
export const ROSTER_WAIT_MS = 72 * 3_600_000
/** An account is "new" for this long after setup: no member may stop a reset
 *  REQUESTED in that window (G5). */
export const NEW_ACCOUNT_MS = 14 * 24 * 3_600_000
export const MAX_MEMBERS = 16
/** A chain longer than this is refused outright (a peer re-pins as it goes). */
export const MAX_CHAIN = 1024

/** The relying party and web origin passkey assertions are checked against.
 *  Native origins join this list as each is measured; a caller passes the list. */
export const ROSTER_RP_ID = 'id.bento.page'
export const ROSTER_WEB_ORIGINS                    = Object.freeze(['https://signin.id.bento.page'])

const no = (reason        )                                => ({ ok: false, reason })
const te = new TextEncoder()
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

const MAX_STATEMENT = 4096
/** statements.ts's split: printable ASCII, exact prefix and field count, empty fields kept. */
function fields(text         , prefix        , count        )                  {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_STATEMENT) return null
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x21 || c > 0x7e) return null
  }
  const parts = text.split('.')
  return parts.length === count && parts[0] === prefix ? parts : null
}
const INT_RE = /^(0|[1-9][0-9]{0,15})$/
const int = (f        ) => { if (!INT_RE.test(f)) return null; const n = Number(f); return Number.isSafeInteger(n) ? n : null }
const ms = (f        ) => { const n = int(f); return n !== null && n > 0 ? n : null }
const isHash = (f        ) => b64uDec(f)?.length === 32
const isNonce = (f        ) => { const b = b64uDec(f); return !!b && b.length >= 16 && b.length <= 64 }
const KID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
function freeText(f        )                {
  const b = b64uDec(f)
  if (!b) return null
  let t        
  try { t = strictUtf8.decode(b) } catch { return null }
  return b64uEnc(te.encode(t)) === f ? t : null
}
/** Byte order for ASCII text (never locale order). */
const cmp = (a        , b        ) => (a < b ? -1 : a > b ? 1 : 0)

// --- ros. ----------------------------------------------------------------------

                                           
const KINDS                    = ['pk', 'ck', 'rk']

                                                                               

                             
                 
             
                     
                   
                  
                 
 

export const memberToken = (m        ) => `${m.kind}~${m.pub}${m.quarantined ? '~q' : ''}`

/** Builds the one spelling of a head: members sorted. */
export function buildRos(h            )         {
  const members = h.members.map(memberToken).sort(cmp).join(',')
  return ['ros', b64uEnc(te.encode(h.address)), h.seq, h.prev ?? '', members, h.dirNonce, h.created].join('.')
}

/** The grammar of a ros. text (no signatures, no chain). */
export async function parseRos(text        )                               {
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
  const members           = []
  const pubs = new Set        ()
  let rk = 0
  for (let i = 0; i < tokens.length; i++) {
    if (i > 0 && cmp(tokens[i - 1], tokens[i]) >= 0) return no('members')   // strictly ascending
    const t = tokens[i].split('~')
    if (t.length !== 2 && !(t.length === 3 && t[2] === 'q')) return no('members')
    if (!KINDS.includes(t[0])) return no('members')
    if (pubs.has(t[1])) return no('members')
    pubs.add(t[1])
    if (t[0] === 'rk') rk++
    members.push({ kind: t[0]              , pub: t[1], quarantined: t.length === 3 })
  }
  if (rk > 1) return no('members')
  for (const m of members) if (!(await isSigningKey(m.pub))) return no('key')
  return { ok: true, value: { address, seq, prev: prevF || null, members, dirNonce, created } }
}

// --- rip. ----------------------------------------------------------------------

/** The authority a rip. claims: member change, reset, quarantine on a void,
 *  lever revert, removal of a quarantined member, undo. */
                                                         
const AUTHORITIES                    = ['m', 'r', 'q', 'l', 'x', 'u']
/** the words whose cause field is empty; every other word names a hash */
const CAUSELESS                    = ['m', 'r']

                           
                 
                     
                   
                 
                                                              
                      
             
 

export function buildRip(r          )         {
  return ['rip', r.rosHash, r.requestedAt, r.ripenedAt, r.auth, r.cause ?? '', r.kid].join('.')
}

export function parseRip(text        )                    {
  const p = fields(text, 'rip', 7)
  if (!p) return no('rip-grammar')
  const [, rosHash, reqF, ripF, auth, causeF, kid] = p
  if (!isHash(rosHash) || !KID_RE.test(kid) || !AUTHORITIES.includes(auth)) return no('rip-grammar')
  if (CAUSELESS.includes(auth) ? causeF !== '' : !isHash(causeF)) return no('rip-grammar')
  const requestedAt = ms(reqF), ripenedAt = ms(ripF)
  if (requestedAt === null || ripenedAt === null || ripenedAt < requestedAt) return no('rip-grammar')
  return { ok: true, value: { rosHash, requestedAt, ripenedAt, auth: auth             , cause: causeF || null, kid } }
}

/** A rip. countersign over exactly `rosText`, by a pinned directory key, not from the future. */
export async function verifyRip(text        , sig        , opts   
                 
                                                 
             
 )                             {
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
                             
             
             
                                                                      
                
                                                                   
                 
                                                                            
                       
                                                                            
                                   
              
                                                                     
              
                                                                             
                                                       
                                                                           
                                                                                             
                                                                          
                                                                       
 

                                              
                                                                                    
               
 

/** One head of a verified chain, as a device certificate names it (devices.ts). */
                             
                                
              
             
                   
                   
 

                              
                 
             
                                                         
                  
                              
                   
                         
                                                                               
                          
                                                                  
                            
                                                                                
                                                                             
                     
                                                                                
                                                             
                     
 

                            
                                     
                                                 
                                                      
              
                                                                                 
                            
             
                                                                              
                                                                            
                                                                              
                                                                         
                 
                                                                              
                                                                        
                    
 

const hasProof = (l            ) => l.signer !== undefined || l.assertion !== undefined || l.sig !== undefined ||
  l.cns !== undefined || l.cosign !== undefined
const carries = (l            ) => l.voided !== undefined || l.cited !== undefined
const soleLivePk = (list          ) => list.length === 1 && list[0].kind === 'pk' && !list[0].quarantined
const str = (v         )              => typeof v === 'string'

                                                                  
                                                                                 

/** A member's proof over `text`: an assertion for a pk, a raw low-S signature
 *  for an rk, a `roster` co-sign (cns. + its signature) for a ck. `nonce` is the
 *  directory nonce inside `text`; `at` the directory's clock for a ck's cns.
 *  (null: evidence only, no time check). */
export async function memberProof(signer        , p       , text        , nonce        , at               , opts           )                                                        {
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
function diffOf(before          , after          ) {
  const b = new Map(before.map((m) => [m.pub, m]))
  const a = new Set(after.map((m) => m.pub))
  const added = after.filter((m) => !b.has(m.pub))
  const removed = before.filter((m) => !a.has(m.pub))
  let kindChanged = false
  const marked           = [], cleared           = []
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
const onlyMarked = (d                           , pub        ) =>
  d.added.length === 0 && d.removed.length === 0 && d.cleared.length === 0 && d.marked.length === 1 && d.marked[0].pub === pub

/** The member a q or l link marked, read from the evidence it carries; null
 *  when that evidence does not prove it. For a PINNED head. The countersign
 *  covers only the cause hash, and the evidence may have been refetched from
 *  the very party the target rule guards against, so every part of it that
 *  names the target is re-bound here: a q's signer by its proof over the
 *  voided text, an l's previous head by the cited head's prev hash. */
async function pinnedTarget(l            , rip          , head            , opts           )                         {
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
export async function verifyRosterChain(links                       , opts           )                                {
  try { return await chain(links, opts) } catch { return no('grammar') }
}

async function chain(links                       , opts           )                                {
  if (!Array.isArray(links) || links.length === 0 || links.length > MAX_CHAIN) return no('grammar')
  if (typeof opts.rpId !== 'string' || opts.rpId === '' || !Array.isArray(opts.origins) || opts.origins.length === 0 ||
    !Number.isSafeInteger(opts.now)) return no('grammar')

  let prev                                                           = null
  let since = new Map                ()
  let createdAt                = null
  let lastResetAt                = null
  let sinceExact = true
  /** the member the previous link marked, when it was a q or l link (x and u must name it) */
  let target                = null
  const heads               = []

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
      const kept = new Map                ()
      for (const m of head.members) kept.set(m.pub, since.get(m.pub) )
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
    const ripe = (pub        ) => { const t = since.get(pub); return t !== undefined && rip.requestedAt - t >= ROSTER_WAIT_MS }
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

    const next = new Map                ()
    for (const m of head.members) next.set(m.pub, since.get(m.pub) ?? rip.ripenedAt)
    since = next
    prev = { head, hash, rip }; heads.push({ hash, seq: head.seq, ripenedAt: rip.ripenedAt, members: head.members })
  }

  const p = prev 
  return { ok: true, value: {
    address: p.head.address, seq: p.head.seq, headHash: p.hash, ripenedAt: p.rip.ripenedAt,
    members: p.head.members.map((m) => ({ ...m, since: since.get(m.pub)  })),
    createdAt, lastResetAt, sinceExact, heads,
  } }
}

// --- vrs. — a member stops a reset ---------------------------------------------------

                                                                                   

export function buildVrs(v           )         {
  return ['vrs', b64uEnc(te.encode(v.address)), v.resetHash, v.dirNonce].join('.')
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
export async function verifyResetStop(text        , signer        , proof       , opts               )                              {
  try { return await resetStop(text, signer, proof, opts) } catch { return no('grammar') }
}

async function resetStop(text        , signerPub        , proof       , opts               )                              {
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
