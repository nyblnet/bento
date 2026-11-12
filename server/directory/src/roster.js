// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// The passkey ROSTER store: one Durable Object per address.
//
// Under option G the account is a roster of passkeys (kernel/src/roster.ts).
// This object holds an address's roster and the one change that may be waiting
// on it, and enforces the directory's half of the rules:
//
// - SETUP makes the first head (seq 0, one passkey) from a single-use setup
//   token (256 bits, no attempt counter: a stranger's wrong guesses never spend
//   the real one) and a registration over a fresh directory challenge.
// - A CHANGE is asked for by an unquarantined passkey member of the current
//   head, by a WebAuthn assertion over the exact new `ros.` text, which names
//   the directory challenge it was bound to. One member added or one removed;
//   an added passkey brings its own registration over that same challenge.
// - It waits 72 hours from `requestedAt`, which is the DIRECTORY's clock. The
//   requester's `created` is informative and never read for the wait.
// - One change at a time: while one is waiting, every other request is
//   refused, a self-removal included.
// - A member removing ITSELF takes effect at once only while another
//   unquarantined PASSKEY stays on the roster (security's recommendation on
//   the roster chain: a staged prompt must not leave a web-only person with
//   no passkey). Otherwise it waits like any other change.
// - Every enrolment and every change is logged with the request's Origin
//   header, the origin the ceremony ran on, the opener the sign-in host
//   reports, and the time (the incident lever's query).
// - Every roster mail lists the WHOLE roster, states the change in words with
//   the second and the host class, and is never held back by a budget that a
//   stranger can fill (only setup-token mail spends that budget).
// - A change waits only once its "waiting" notice was accepted by the mailer:
//   that notice is how the person stops it. Mailer down, nothing is queued.
// - Every link that enters the chain is countersigned (`rip.`) with the
//   directory's online key when it takes effect, never before (G2), under the
//   authority word for the act (kernel/src/roster.ts): `m` a member's change
//   and the setup head, `r` a reset, `q` a void that suspends the passkey that
//   asked, `x` that passkey's removal 72 hours later, `u` its undo.
//
// THE VOID (G3, G4 with G4a-G4c). Every waiting change's notice carries a void
// link: a 256-bit token in the fragment of a link to the void page
// (voidpage.js), single use, with NO attempt counter (a stranger's wrong
// guesses are refused and spend nothing; per-IP limits are the only brake).
// A member's change offers two choices:
//   - cancel: the change is dropped, and the passkey that asked may not ask
//     for another change for 72 hours (G4b). It still signs in.
//   - remove: the change is dropped, the passkey that asked is SUSPENDED at
//     once (a `q` link: `~q` in the roster, so it can ask for nothing) and its
//     removal is queued in the same step (an `x` link, 72 hours). That removal's
//     own notice carries an undo link (G4a), which puts the passkey back (a `u`
//     link). Offered only while another live member would remain (G4c).
// A reset offers cancel only; a queued removal offers undo only.
//
// THE HOLD (F1). A Remove and a reset send their notice before they act,
// because it carries the way back, so they hold the roster first: while the
// hold is on, the waiting change cannot take effect and every other void,
// reset or member request is refused before its own mail goes. Every mail then
// states an act that happens. A void link whose life ended answers how
// (`late`, `used`, `preempted`), never just "unknown" (F2). A reset sets a
// waiting removal ASIDE rather than cancelling it: its undo keeps working, and
// a stopped reset puts it back (G4a survives a reset).
//
// THE RESET (G5). Anyone can ask for a reset link to be mailed to an address
// that has an account; it completes on the sign-in host by making a NEW
// passkey there, and then waits 72 hours like any change, with its own void
// link. It preempts whatever change is waiting. In the account's first 14 days
// no member may stop it (so whoever set the account up without the mailbox
// cannot keep the address); after that a member may. When it takes effect the
// roster is that one new passkey, under the word `r`.
//
// NOT HERE YET (each a later change): a member stopping a reset with a
// passkey (the route and its rules are here and refuse at the last step:
// what the passkey signs is a kernel layout, not defined yet); consent-key and
// recovery-key members; account deletion; the chain route peers read.

import { b64uDec, b64uEnc, sha256b64u, signStatement } from '../../../kernel/src/statements.ts'
import { buildRip, buildRos, parseRos, ROSTER_WAIT_MS } from '../../../kernel/src/roster.ts'
import { HOME_ORIGIN, PASSKEY, verifyMemberAssertion, verifyRegistration } from './passkey.js'
import { BROWSER_OPS, browserOp } from './browsers.js'
import { deliver, MAIL_TIMEOUT_MS } from './mail.js'
import { resetLink, setupLink, voidLink } from './links.js'

const MIN = 60_000, DAY = 86_400_000

export const ROSTER_LIMITS = {
  /** a setup token's life, for a link the budget allowed */
  setupTtlMs: 20 * MIN,
  /**
   * the life of a link mailed BEYOND the budget (S1′). Such a link goes only
   * when the budget is full and no mailed link is live, so its life is what
   * caps that mail: one a day, about four a day to an address in all, however
   * often a stranger asks
   */
  setupBeyondTtlMs: DAY,
  /** the per-address budget for setup-link mail, which a stranger can spend (spendSetupBudget) */
  mailCooldownMs: 60_000,
  mailPerDay: 3,
  mailPerMonth: 10,
  /** the longest Origin header kept in the log */
  originMax: 200,
  /** how long a spent directory challenge is remembered (its life is CHALLENGE_TTL_MS, 5 minutes) */
  spentKeepMs: 10 * MIN,
  /**
   * a link whose mail is still in flight: younger than the mailer's timeout,
   * plus a margin. While one is, it holds the next link back as a mailed one
   * would (S1″); once older, it can only be a send that never confirmed
   */
  setupInFlightMs: MAIL_TIMEOUT_MS + 5_000,
  /** at most this many expired spent challenges are swept by each new spend */
  spentSweep: 32,
  /** a change whose waiting notice was never confirmed sent is dropped after this (the object stopped mid-send) */
  unsentDropMs: 10 * MIN,
  /** G4b: after "Cancel this change", the passkey that asked may not ask for another change for this long */
  voidCooldownMs: 72 * 60 * MIN,
  /** G5: an account this young cannot have a reset stopped by a member, and peers show it as new */
  newAccountMs: 14 * DAY,
  /**
   * a reset link's life. No budget holds a reset mail back (S2): only a reset
   * link already mailed and still live does (S1's rule), so this life is what
   * caps how often a stranger can have one sent, at one a day
   */
  resetTtlMs: DAY,
  /**
   * F1: the HOLD a void's Remove or a reset puts on the roster BEFORE its mail
   * goes, so the mail can never state an act that then fails to happen. While
   * it is on, the waiting change cannot take effect, and a second void, a
   * reset or a member's request is refused before any mail of its own goes.
   * It outlives the mailer's timeout, so a send always ends inside it; it
   * lapses by itself only when the object stopped mid-send
   */
  holdMs: MAIL_TIMEOUT_MS + 5_000,
  /** F2: how many ended void links the directory remembers, to answer "too late" or "already used" for them */
  endedKeep: 16,
}

/** The openers the sign-in host may report (it reads them from the message event). */
export const REQUESTERS = Object.freeze([HOME_ORIGIN])

const te = new TextEncoder()
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const sha256hex = async (text) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(text))))

/** A passkey's short name in mail and the log: 8 hex of SHA-256 over its raw point. */
export async function fingerprint(pub) {
  const raw = b64uDec(pub)
  return raw ? hex(new Uint8Array(await crypto.subtle.digest('SHA-256', raw))).slice(0, 8) : '????????'
}

function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

/** A fresh 256-bit token (base64url) and the hash that is stored instead of it. */
async function mintToken(label) {
  const token = b64uEnc(crypto.getRandomValues(new Uint8Array(32)))
  return { token, h: await sha256hex(`bento-dir/1/${label}\n${token}`) }
}
const tokenHash = (label, token) => sha256hex(`bento-dir/1/${label}\n${token}`)
/** A dirNonce for a link the directory makes on its own authority (no request challenge exists). */
const ownNonce = () => b64uEnc(crypto.getRandomValues(new Uint8Array(16)))

let signer = null
/**
 * The directory's countersign over a rip. text, with its online key
 * (DIR_KEY_JWK, a private P-256 JWK; DIR_KID names it). Throws when the key is
 * not configured, BEFORE anything is stored: no link enters the chain
 * without its countersign.
 */
async function countersign(env, r) {
  if (typeof env.DIR_KEY_JWK !== 'string' || typeof env.DIR_KID !== 'string') throw new Error('DIR_KEY_JWK and DIR_KID are not configured')
  if (!signer || signer.jwk !== env.DIR_KEY_JWK) {
    const key = await crypto.subtle.importKey('jwk', JSON.parse(env.DIR_KEY_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    signer = { jwk: env.DIR_KEY_JWK, key }
  }
  const rip = buildRip({ ...r, kid: env.DIR_KID })
  return { rip, ripSig: await signStatement(signer.key, rip) }
}

/** When a `spent:<issued16>:<nonce>` key may go. */
const spentUntil = (k) => Number(k.slice(6, 22)) + ROSTER_LIMITS.spentKeepMs

const when = (t) => new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
const HOW = { setup: 'at setup', browser: 'from a browser', app: 'from an app' }
const hostClass = (origin) => PASSKEY.origins[origin] ?? 'browser'

// --- mail ------------------------------------------------------------------------

/** The roster as a list of lines: every member, its fingerprint, when and how it came. */
async function rosterLines(members, records, pendingAdd) {
  const out = []
  for (const m of members) {
    const fp = await fingerprint(m.pub)
    const r = records[m.pub]
    const how = m.pub === pendingAdd ? 'being added by this change' : r ? `added ${when(r.addedAt)} ${HOW[r.how] ?? ''}`.trim() : 'added earlier'
    out.push(`  - passkey ${fp}, ${how}${m.quarantined ? ', suspended' : ''}`)
  }
  return out
}

/**
 * Every roster notice goes out here, whatever any mail budget says (G10).
 * True when the mailer accepted it. Only the waiting notice acts on a false:
 * it is the person's way to stop the change, so a change whose notice was not
 * sent never waits to take effect (security's D1).
 */
async function notify(env, to, subject, lines, kind = 'roster') {
  const body = [...lines, '', 'Bento will never ask you to type or paste anything from this email.'].join('\n')
  try { await deliver(env, { to, subject, body, kind }); return true } catch (e) { console.log(`${kind} mail failed: ${e.message}`); return false }
}

/** "the passkey 1a2b3c4d, added 2026-11-03 09:00:00 UTC at setup": a member by its short name and age (G4c). */
async function named(pub, rec) {
  const fp = await fingerprint(pub)
  return rec ? `the passkey ${fp}, added ${when(rec.addedAt)} ${HOW[rec.how] ?? ''}`.trimEnd() : `the passkey ${fp}`
}

/**
 * The void link's lines in a waiting notice. `kind` is the link's (links.js
 * VOID_KINDS); the wording says which choice to pick (G4c).
 */
function voidLines(to, token, kind, exp, rNote) {
  const link = voidLink(to, token, kind)
  if (kind === 'u') {
    return ['If you removed the wrong passkey, open this link to put it back:', '', link, '',
      `It works once, until ${when(exp)}.`]
  }
  if (kind === 'r') {
    return ['If you did not ask for this reset, open this link to stop it:', '', link, '',
      `It works once, until ${when(exp)}.`, ...(rNote ?? [])]
  }
  return ['If you did not ask for this, open this link to stop it:', '', link, '',
    ...(kind === 'c'
      ? ['The page offers two choices. If you did not ask for this, your passkey was used for something you did not intend. Choose Cancel: it is always safe. Choose Remove only if you do not recognise the passkey that asked (named above).']
      : ['The page offers one choice, Cancel: the passkey that asked is the only one on this account that can still be used, so removing it would leave the account with no usable passkey (only a reset gets back in).']),
    `It works once, until ${when(exp)}.`]
}

/**
 * The setup link (links.js). Fixed wording; the only variable parts are the
 * time and the link, whose fragment carries the address it was mailed to and
 * the token. True when the mailer accepted it.
 */
async function mailSetupLink(env, to, token, now, exp) {
  const body = [
    `At ${when(now)} someone asked to set up a bento/id account for this address.`,
    '',
    'To set it up, open this link in the browser where you want your first passkey:',
    '',
    setupLink(to, token),
    '',
    `The link works once, until ${when(exp)}.`,
    'Opening it changes nothing by itself: the account is set up only when you make a passkey on the page it opens.',
    'If you did not ask for this, ignore this email.',
    'Bento will never ask you to type or paste anything from this email.',
  ].join('\n')
  try { await deliver(env, { to, subject: 'Set up your bento/id account', body, kind: 'setup' }); return true } catch (e) { console.log(`setup mail failed: ${e.message}`); return false }
}

/**
 * A reset link (links.js resetLink): completes on the sign-in host by making a
 * new passkey there. Fixed wording. True when the mailer accepted it. Never
 * held back by a budget (S2): only a reset link already mailed and still live
 * holds the next one back (resetStart).
 */
async function mailResetLink(env, to, token, now, until) {
  const body = [
    `At ${when(now)} someone asked to reset the bento/id account for this address.`,
    '',
    'A reset is for when every passkey on the account is lost. It replaces all of them with one new passkey, made in the browser that opens this link:',
    '',
    resetLink(to, token),
    '',
    `The link works once, until ${when(until)}.`,
    'Opening it changes nothing by itself. Once you make the new passkey, the reset waits 72 hours before it takes effect, and this address is sent a link that can stop it.',
    'If you did not ask for this, ignore this email: nothing changes.',
    'Bento will never ask you to type or paste anything from this email.',
  ].join('\n')
  try { await deliver(env, { to, subject: 'Reset your bento/id account', body, kind: 'reset' }); return true } catch (e) { console.log(`reset mail failed: ${e.message}`); return false }
}

// --- the object ------------------------------------------------------------------

export class Roster {
  constructor(state, env) { this.state = state; this.env = env }

  /**
   * One alarm, two users: a waiting change's ripening, and sweeping spent
   * challenges once nobody is spending (a stranger's spends on an address that
   * then goes quiet would otherwise stay stored for good). Each run does what is
   * due and sets the alarm for the earliest thing still to come.
   */
  async alarm() {
    const s = this.state.storage
    const now = Date.now()
    await this.ripen(now)
    await this.sweepSpent(now)
    const next = []
    const p = await s.get('pend')
    // a held change comes due again once the hold is off (released early, a later run of ripen does it)
    const h = await this.held(now)
    if (p && p.mailed === true) next.push(Math.max(p.ripensAt, h ? h.until : 0))
    for (const k of (await s.list({ prefix: 'spent:', limit: 1 })).keys()) next.push(spentUntil(k))
    if (next.length) await s.setAlarm(Math.max(Math.min(...next), now + 1000)) // never a past time: it would fire in a loop
  }

  /** Bring the alarm forward to `t` if it is set later or not at all; never push it back. */
  async schedule(t) {
    const s = this.state.storage
    const at = await s.getAlarm()
    if (at === null || at === undefined || at > t) await s.setAlarm(t)
  }

  /** Delete every spent challenge past its keep, oldest first (the keys sort by issue time). */
  async sweepSpent(now) {
    const s = this.state.storage
    for (;;) {
      const keys = [...(await s.list({ prefix: 'spent:', limit: 128 })).keys()]
      const dead = keys.filter((k) => spentUntil(k) <= now)
      if (dead.length) await s.delete(dead)
      if (dead.length < keys.length || keys.length < 128) return
    }
  }

  /**
   * The waiting change, in force once its 72 hours are up, and ONLY if its
   * waiting notice was confirmed sent. A change still marked unsent is one
   * whose object stopped between holding the slot and hearing from the
   * mailer: it never takes effect, and after a while it is dropped so the
   * slot frees (the person may have had the notice; a change that then never
   * happens is the safe side).
   */
  async ripen(now) {
    const s = this.state.storage
    const p = await s.get('pend')
    if (!p) return
    if (p.mailed !== true) {
      if (now - p.requestedAt >= ROSTER_LIMITS.unsentDropMs) await s.delete('pend')
      return
    }
    if (now < p.ripensAt) return
    // F1: a Remove or a reset pressed before the deadline holds the change while
    // its mail goes; the change must not take effect under it
    if (await this.held(now)) return
    await this.apply(p, now, 'ripen')
  }

  // --- the hold (F1) ---------------------------------------------------------------

  /** The hold, while it is on. */
  async held(now) {
    const h = await this.state.storage.get('hold')
    return h && h.until > now ? h : null
  }
  /** Put the hold on; returns its id, which only its taker may release. */
  async takeHold(now, what) {
    const id = ownNonce()
    await this.state.storage.put('hold', { id, what, until: now + ROSTER_LIMITS.holdMs })
    return id
  }
  /** Take the hold off, if it is still the one `id` took. */
  async dropHold(id) {
    const h = await this.state.storage.get('hold')
    if (h && h.id === id) await this.state.storage.delete('hold')
  }

  // --- ended void links (F2) -------------------------------------------------------

  /**
   * Remember how a void link's life ended, by its token's hash: `late` (what it
   * was for took effect; `by` 'reset' when a reset did), `used` (a press of it
   * acted) or `preempted` (a reset cancelled its change). The token is 256 bits,
   * so answering with this tells nobody but its holder anything. The last
   * endedKeep are kept.
   */
  async ended(h, why, at, by = null) {
    if (typeof h !== 'string') return
    const s = this.state.storage
    const list = ((await s.get('ended')) || []).filter((e) => e.h !== h)
    list.push({ h, why, at, ...(by ? { by } : {}) })
    await s.put('ended', list.slice(-ROSTER_LIMITS.endedKeep))
  }
  /** The answer for a token whose link has ended, or null when the directory does not know it. */
  async endedAnswer(th) {
    const e = ((await this.state.storage.get('ended')) || []).find((x) => same(x.h, th))
    return e ? { error: e.why, at: e.at, ...(e.by ? { by: e.by } : {}) } : null
  }

  /**
   * The per-address budget for setup-link mail: one a minute, 3 a day, 10 in
   * 31 days. Anyone can spend it, so it is the ONLY place in this object that
   * reads the stored send times, and only setupStart calls it (the rig checks
   * both). Records a send and answers true when one is allowed.
   */
  async spendSetupBudget(now) {
    const s = this.state.storage
    const times = ((await s.get('mail')) || []).filter((t) => now - t < 31 * DAY)
    if (times.length && now - times[times.length - 1] < ROSTER_LIMITS.mailCooldownMs) return false
    if (times.filter((t) => now - t < DAY).length >= ROSTER_LIMITS.mailPerDay) return false
    if (times.length >= ROSTER_LIMITS.mailPerMonth) return false
    await s.put('mail', [...times, now])
    return true
  }

  async records(members) {
    const out = {}
    for (const m of members) { const r = await this.state.storage.get(`pk:${m.pub}`); if (r) out[m.pub] = r }
    return out
  }

  /** When the account was set up: the setup head's time, which a reset does not change (G5). */
  async createdAt(cur) {
    return cur.createdAt ?? (await this.state.storage.get('link:00000000'))?.ripenedAt ?? cur.ripenedAt
  }

  /**
   * The event log, kept for the life of the account. Every entry carries `ob`:
   * 1 when the act was asked for at bento/home's request (`rq`, the opener the
   * sign-in host reported, is bento/home), else 0. It is the incident lever's
   * filter; nothing decides on it.
   */
  async log(entry) {
    const s = this.state.storage
    const n = ((await s.get('logN')) || 0) + 1
    await s.put('logN', n)
    await s.put(`log:${String(n).padStart(8, '0')}`, { ...entry, ob: entry.rq === HOME_ORIGIN ? 1 : 0 })
  }

  /** Make a change the head. `p` is a waiting (or immediate) change. */
  /**
   * Put `ros` at the head of the chain, countersigned under `auth` (and
   * `cause`), with the link's extra fields. The countersign is made FIRST, so
   * a missing key stores nothing. Returns the new head.
   */
  async link(ros, { auth, cause = null, requestedAt, now, kind, extra = {} }) {
    const s = this.state.storage
    const h = await parseRos(ros)
    if (!h.ok) throw new Error('a link that does not parse') // never: each was built or parsed before
    const hash = await sha256b64u(ros)
    const { rip, ripSig } = await countersign(this.env, { rosHash: hash, requestedAt, ripenedAt: now, auth, cause })
    const prev = await s.get('head')
    const head = { ros, hash, seq: h.value.seq, members: h.value.members, ripenedAt: now, createdAt: prev?.createdAt ?? now }
    await s.put(`link:${String(head.seq).padStart(8, '0')}`, { ros, rip, ripSig, kind, requestedAt, ripenedAt: now, ...extra })
    await s.put('head', head)
    return head
  }

  /** The waiting change `p` takes effect (or a member's self-removal, at once). */
  async apply(p, now, k) {
    const s = this.state.storage
    const kind = p.kind ?? 'member'
    const address = (await parseRos(p.ros)).value.address
    const was = await s.get('head')
    let head
    if (kind === 'reset') {
      head = await this.link(p.ros, { auth: 'r', requestedAt: p.requestedAt, now, kind: 'reset' })
      // every member before the reset is gone, and with them their cooldowns
      for (const m of was.members) {
        const r = await s.get(`pk:${m.pub}`)
        await s.delete([`pk:${m.pub}`, `cool:${m.pub}`, ...(r ? [`cid:${r.credId}`] : [])])
      }
      await s.put(`pk:${p.change.pub}`, { credId: p.reg.credId, signCount: p.reg.signCount, addedAt: now, how: p.how })
      await s.put(`cid:${p.reg.credId}`, p.change.pub)
    } else if (kind === 'removal') {
      head = await this.link(p.ros, { auth: 'x', cause: p.cause, requestedAt: p.requestedAt, now, kind: 'removal' })
      const r = await s.get(`pk:${p.change.pub}`)
      await s.delete([`pk:${p.change.pub}`, `cool:${p.change.pub}`, ...(r ? [`cid:${r.credId}`] : [])])
    } else {
      head = await this.link(p.ros, { auth: 'm', requestedAt: p.requestedAt, now, kind: 'member',
        extra: { signer: p.signer, credId: p.credId, assertion: p.assertion } })
      if (p.change.op === 'add') {
        await s.put(`pk:${p.change.pub}`, { credId: p.reg.credId, signCount: p.reg.signCount, addedAt: now, how: p.how })
        await s.put(`cid:${p.reg.credId}`, p.change.pub)
      } else {
        const r = await s.get(`pk:${p.change.pub}`)
        await s.delete([`pk:${p.change.pub}`, `cool:${p.change.pub}`, ...(r ? [`cid:${r.credId}`] : [])])
      }
    }
    await s.delete('pend')
    // F2: a void link pressed from now on answers "too late", not "unknown"
    if (k === 'ripen') {
      await this.ended(p.voidTok, 'late', now)
      if (p.parked) await this.ended(p.parked.voidTok, 'late', now, 'reset')
    }
    const fp = await fingerprint(p.change.pub)
    await this.log({ k, at: now, seq: head.seq, op: kind === 'reset' ? 'reset' : p.change.op, pub: p.change.pub, by: p.signer ?? '', os: p.os ?? '', rq: p.rq ?? '', co: p.co ?? '' })

    const records = await this.records(head.members)
    const what = kind === 'reset' ? `this account was reset: its only passkey is now ${fp}, made at the reset`
      : kind === 'removal' ? `the suspended passkey ${fp} was removed`
        : p.change.op === 'add' ? `the passkey ${fp} was added` : p.signer === p.change.pub ? `the passkey ${fp} removed itself` : `the passkey ${fp} was removed`
    await notify(this.env, address, kind === 'reset' ? 'Your bento/id account was reset' : 'Your bento/id passkeys changed', [
      k === 'ripen'
        ? `A change asked for at ${when(p.requestedAt)} ${kind === 'removal' ? 'from the link in an email' : HOW[p.how]} is now in effect: ${what}.`
        : `At ${when(now)} ${what} on this bento/id account, ${HOW[p.how]}.`,
      '',
      'The passkeys on this account now:',
      ...(await rosterLines(head.members, records, null)),
    ])
  }

  async fetch(req) {
    const a = await req.json()
    const now = Date.now()
    const s = this.state.storage
    const out = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

    /**
     * Spend a directory challenge: FIRST, before any other check, so every
     * attempt consumes it. Spending needs no account, so anyone can do it as
     * often as the per-IP limits allow: each spent challenge is its OWN key,
     * `spent:<issued>:<nonce>` (never one growing value, which a stranger could
     * fill to the storage limit and so break every request on the address,
     * security's D2), and each spend sweeps a few of the oldest that are past
     * their keep. The keys sort by issue time, so the oldest come first. Each
     * spend also makes sure the alarm will come for its key, so an address
     * nobody touches again still ends up holding none.
     */
    const spend = async () => {
      if (typeof a.nonce !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(a.nonce) || !Number.isSafeInteger(a.issued) || a.issued < 0) return false
      const key = `spent:${String(a.issued).padStart(16, '0')}:${a.nonce}`
      if (await s.get(key)) return false
      await s.put(key, 1)
      const oldest = await s.list({ prefix: 'spent:', limit: ROSTER_LIMITS.spentSweep })
      const dead = [...oldest.keys()].filter((k) => spentUntil(k) <= now)
      if (dead.length) await s.delete(dead)
      await this.schedule(spentUntil(key)) // and the alarm sweeps whatever later spends leave behind
      return true
    }
    const origin = typeof a.os === 'string' ? a.os.slice(0, ROSTER_LIMITS.originMax) : ''
    // the browser certificates (browsers.js): the same object, its own ops
    if (BROWSER_OPS.includes(a.op)) return browserOp(this, a, now, { spend, out, origin, fingerprint, notify: (to, subject, lines) => notify(this.env, to, subject, lines) })

    if (a.op === 'head') {
      await this.ripen(now)
      const head = await s.get('head')
      if (!head) return out(404, { error: 'not-found' })
      const p = await s.get('pend')
      const createdAt = await this.createdAt(head)
      return out(200, {
        ros: head.ros, seq: head.seq, createdAt, newAccount: now - createdAt < ROSTER_LIMITS.newAccountMs,
        pending: p && p.mailed === true ? { kind: p.kind ?? 'member', ros: p.ros, requestedAt: p.requestedAt, ripensAt: p.ripensAt } : null,
      })
    }

    if (a.op === 'setupStart') {
      // Anyone can ask, for any address. A link goes to the address itself, so
      // a stranger's start mails the owner a REAL link and gains nothing; the
      // budget only limits how often.
      if (typeof a.address !== 'string' || !a.address) return out(400, { error: 'invalid' })
      if (await s.get('head')) return out(202, { mailed: false }) // taken: a reset is a later change
      const live = ((await s.get('setupTok')) || []).filter((t) => t.exp > now)
      // S1: the budget may hold a setup mail back ONLY while a link it already
      // mailed is still live. Otherwise strangers who fill it would leave the
      // address refused for weeks with no working link in its inbox. With the
      // budget full and no live link, one mail goes anyway, and its token is
      // then the live link that holds the next ones back. Such a link lives a
      // day, not 20 minutes (S1′): it is the only thing that limits how often
      // a link goes beyond the budget, so a stranger who keeps asking gets the
      // owner one extra mail a day, never one every 20 minutes.
      // S1″: a link whose mail is still going out counts too. On a Durable
      // Object other requests run while the mail is sent, and a token is marked
      // mailed only once the mailer answers, so without this every start in
      // that window mailed its own day-long link. One that never confirmed
      // stops counting once it is older than the mailer could take, so a send
      // that died can never hold a link back for good.
      const spent = await this.spendSetupBudget(now)
      const holds = (t) => t.mailed || now - (t.at ?? 0) < ROSTER_LIMITS.setupInFlightMs
      if (!spent && live.some(holds)) return out(202, { mailed: false })
      const token = b64uEnc(crypto.getRandomValues(new Uint8Array(32)))
      const h = await sha256hex(`bento-dir/1/setup\n${token}`)
      const exp = now + (spent ? ROSTER_LIMITS.setupTtlMs : ROSTER_LIMITS.setupBeyondTtlMs)
      // a new token never replaces an older live one: a stranger's start must not kill the owner's link
      await s.put('setupTok', [...live, { h, exp, at: now, mailed: false }])
      const sent = await mailSetupLink(this.env, a.address, token, now, exp)
      const after = ((await s.get('setupTok')) || []).filter((t) => t.exp > now)
      // a link that never went out is withdrawn, so it can never hold a later mail back
      await s.put('setupTok', sent ? after.map((t) => (t.h === h ? { ...t, mailed: true } : t)) : after.filter((t) => t.h !== h))
      return out(202, { mailed: sent })
    }

    if (a.op === 'setup') {
      if (!(await spend())) return out(400, { error: 'nonce' })
      if (await s.get('head')) return out(409, { error: 'exists' })
      if (typeof a.token !== 'string' || typeof a.address !== 'string') return out(400, { error: 'token' })
      const h = await sha256hex(`bento-dir/1/setup\n${a.token}`)
      const live = ((await s.get('setupTok')) || []).filter((t) => t.exp > now)
      // no attempt counter: a 256-bit token cannot be guessed, and a counter would let strangers spend it
      if (!live.some((t) => same(t.h, h))) return out(400, { error: 'token' })
      const challenge = b64uDec(a.dirNonce ?? '')
      const reg = await verifyRegistration(a.reg, challenge ?? new Uint8Array(0))
      if (!reg.ok) return out(400, { error: reg.reason }) // the token stays good: only a completed setup spends it
      const ros = buildRos({ address: a.address, seq: 0, prev: null, members: [{ kind: 'pk', pub: reg.value.pub, quarantined: false }], dirNonce: a.dirNonce, created: now })
      const parsed = await parseRos(ros)
      if (!parsed.ok || parsed.value.address !== a.address) return out(400, { error: parsed.ok ? 'address' : parsed.reason })
      const how = 'setup'
      // the setup head's countersign is issued at once (auth m): there is nothing yet to protect
      await this.link(ros, { auth: 'm', requestedAt: now, now, kind: 'setup' })
      await s.put(`pk:${reg.value.pub}`, { credId: reg.value.credId, signCount: reg.value.signCount, addedAt: now, how })
      await s.put(`cid:${reg.value.credId}`, reg.value.pub)
      await s.delete('setupTok')
      await this.log({ k: 'reg', at: now, seq: 0, pub: reg.value.pub, os: origin, rq: '', co: reg.value.origin })
      await this.log({ k: 'setup', at: now, seq: 0, pub: reg.value.pub, os: origin, rq: '', co: reg.value.origin })
      // the setup notice never spends the address's mail budget, and nothing can hold it back
      await notify(this.env, a.address, 'Your bento/id account was set up', [
        `At ${when(now)} a bento/id account was set up for this address ${HOW[hostClass(reg.value.origin)]}.`,
        '',
        'The passkeys on this account now:',
        ...(await rosterLines(parsed.value.members, await this.records(parsed.value.members), null)),
      ])
      return out(200, { ros })
    }

    if (a.op === 'request') {
      if (!(await spend())) return out(400, { error: 'nonce' })
      await this.ripen(now)
      const cur = await s.get('head')
      if (!cur) return out(404, { error: 'not-found' })
      const h = await parseRos(a.ros)
      if (!h.ok) return out(400, { error: h.reason })
      const next = h.value
      const before = await parseRos(cur.ros)
      if (next.address !== before.value.address) return out(400, { error: 'address' })
      if (next.seq !== cur.seq + 1 || next.prev !== cur.hash) return out(409, { error: 'stale' })
      if (await s.get('pend')) return out(409, { error: 'pending' })
      // a reset's notice is going out (F1): nothing may be queued under it
      if (await this.held(now)) return out(409, { error: 'pending' })
      if (a.rq !== undefined && a.rq !== '' && !REQUESTERS.includes(a.rq)) return out(400, { error: 'rq' })

      // the member who asked
      const signerPub = typeof a.credId === 'string' ? await s.get(`cid:${a.credId}`) : undefined
      const signer = signerPub && cur.members.find((m) => m.pub === signerPub)
      if (!signer) return out(400, { error: 'signer' })
      if (signer.quarantined) return out(403, { error: 'quarantined' })
      if (signer.kind !== 'pk') return out(400, { error: 'signer-kind' })
      // G4b: a passkey whose last change was cancelled from the void page may not ask again for 72 hours
      const coolUntil = await s.get(`cool:${signer.pub}`)
      if (coolUntil && coolUntil > now) return out(403, { error: 'cooldown', until: coolUntil })
      const rec = await s.get(`pk:${signer.pub}`)
      const v = await verifyMemberAssertion(a.assertion, { publicKey: signer.pub, text: a.ros, storedSignCount: rec.signCount })
      if (!v.ok) return out(400, { error: `assertion-${v.reason}` })
      await s.put(`pk:${signer.pub}`, { ...rec, signCount: v.value.signCount }) // in order, per credential

      // exactly one change; quarantine marks are the directory's, never the requester's
      const was = new Map(cur.members.map((m) => [m.pub, m]))
      const now_ = new Map(next.members.map((m) => [m.pub, m]))
      const added = next.members.filter((m) => !was.has(m.pub))
      const removed = cur.members.filter((m) => !now_.has(m.pub))
      for (const m of next.members) {
        const w = was.get(m.pub)
        if (w && w.kind !== m.kind) return out(400, { error: 'members' })
        if (w ? w.quarantined !== m.quarantined : m.quarantined) return out(400, { error: 'quarantine' })
      }
      if (added.length + removed.length !== 1) return out(400, { error: added.length + removed.length === 0 ? 'no-change' : 'multi-change' })
      let change, reg = null
      if (added.length === 1) {
        if (added[0].kind !== 'pk') return out(400, { error: 'kind' }) // consent and recovery keys come with their own rules
        const r = await verifyRegistration(a.reg, b64uDec(next.dirNonce))
        if (!r.ok) return out(400, { error: `registration-${r.reason}` })
        if (r.value.pub !== added[0].pub) return out(400, { error: 'registration-key' })
        if (await s.get(`cid:${r.value.credId}`)) return out(400, { error: 'registration-credential' })
        reg = { credId: r.value.credId, signCount: r.value.signCount, origin: r.value.origin }
        change = { op: 'add', pub: added[0].pub }
      } else {
        if (a.reg !== undefined) return out(400, { error: 'registration' })
        change = { op: 'remove', pub: removed[0].pub }
      }

      const p = {
        ros: a.ros, hash: await sha256b64u(a.ros), change, signer: signer.pub, credId: a.credId, assertion: a.assertion,
        reg, requestedAt: now, ripensAt: now + ROSTER_WAIT_MS, os: origin, rq: a.rq || '', co: v.value.origin,
        how: hostClass(v.value.origin),
      }
      const by = await fingerprint(signer.pub)

      // a member removing itself, with another live passkey left: at once
      const selfRemoval = change.op === 'remove' && change.pub === signer.pub &&
        next.members.some((m) => m.kind === 'pk' && !m.quarantined)
      if (selfRemoval) {
        await this.apply({ ...p, requestedAt: now }, now, 'remove-self')
        return out(200, { ros: a.ros, inForce: true })
      }

      // The void link the notice carries. "Remove" is offered only while another
      // member would still be live once the one that asked is suspended (G4c).
      const vt = await mintToken('void')
      const vk = cur.members.some((m) => !m.quarantined && m.pub !== signer.pub) ? 'c' : 'o'
      Object.assign(p, { kind: 'member', voidTok: vt.h, voidKind: vk })

      // The waiting notice is the person's way to stop this change, so the change
      // holds the slot first (marked unsent: it can neither ripen nor be joined
      // by another change), then the notice goes out, and only a notice the
      // mailer accepted lets the change wait to take effect. If the mailer
      // refuses, nothing is queued and the request fails (security's D1).
      await s.put('pend', { ...p, mailed: false })
      // The notice can take a while (up to the mailer's timeout), and the slot
      // is not held against the rest of the world meanwhile: a send that outlives
      // unsentDropMs lets a later request drop this change and queue its own,
      // and a void will be able to land mid-send. So what happens after the send
      // touches the stored change ONLY if it is still this one, unsent (D1a).
      const ours = async () => {
        const q = await s.get('pend')
        return !!q && q.mailed === false && q.ros === p.ros && q.requestedAt === p.requestedAt
      }
      const records = await this.records(cur.members)
      const rec2 = records[signer.pub]
      const what = change.op === 'add' ? `add the passkey ${await fingerprint(change.pub)}`
        : change.pub === signer.pub ? `remove the passkey ${by}, which asked for it` : `remove the passkey ${await fingerprint(change.pub)}`
      const sent = await notify(this.env, next.address, 'A change to your bento/id passkeys is waiting', [
        `At ${when(now)} a change to this bento/id account was asked for ${HOW[p.how]}: ${what}.`,
        `It was asked for by the passkey ${by}${rec2 ? `, added ${when(rec2.addedAt)} ${HOW[rec2.how] ?? ''}`.trimEnd() : ''}.`,
        `It takes effect at ${when(p.ripensAt)}, 72 hours after it was asked for.`,
        '',
        'The passkeys on this account once it takes effect:',
        ...(await rosterLines(next.members, records, change.op === 'add' ? change.pub : null)),
        '',
        ...voidLines(next.address, vt.token, vk, p.ripensAt),
      ])
      if (!sent) {
        if (await ours()) await s.delete('pend')
        return out(503, { error: 'mail' })
      }
      // replaced or dropped while the notice was out: it is not queued (the
      // person got a notice for a change that will not happen: the safe side)
      if (!(await ours())) return out(409, { error: 'superseded' })
      await s.put('pend', { ...p, mailed: true })
      await this.schedule(p.ripensAt)
      if (reg) await this.log({ k: 'reg', at: now, seq: next.seq, pub: change.pub, by: signer.pub, os: origin, rq: p.rq, co: reg.origin })
      await this.log({ k: 'request', at: now, seq: next.seq, op: change.op, pub: change.pub, by: signer.pub, os: origin, rq: p.rq, co: p.co })
      return out(202, { ros: a.ros, requestedAt: now, ripensAt: p.ripensAt })
    }

    if (a.op === 'void') {
      // The void page's POST (G3, G4). The token is the whole authority: no
      // account, no passkey. A wrong one is refused and spends nothing, and no
      // count of wrong ones is kept anywhere (a stranger who knows the address
      // must never be able to burn the owner's link).
      if (typeof a.token !== 'string' || !['cancel', 'remove', 'undo'].includes(a.choice)) return out(400, { error: 'invalid' })
      await this.ripen(now) // a change already in effect can no longer be stopped
      const p = await s.get('pend')
      const th = await tokenHash('void', a.token)
      // C3: while a reset waits, the removal it set aside keeps its undo link
      const parked = p && p.kind === 'reset' && p.parked && typeof p.parked.voidTok === 'string' && same(p.parked.voidTok, th) ? p.parked : null
      if (!parked && (!p || typeof p.voidTok !== 'string' || !same(p.voidTok, th))) {
        // F2: a link whose life has ended says how (too late, already used, or
        // cancelled by a reset), so the page never has to guess
        const e = await this.endedAnswer(th)
        return e ? out(409, e) : out(400, { error: 'invalid' })
      }
      const kind = parked ? 'removal' : p.kind ?? 'member'
      const choices = kind === 'reset' ? ['cancel'] : kind === 'removal' ? ['undo'] : p.voidKind === 'c' ? ['cancel', 'remove'] : ['cancel']
      // a choice the link does not offer is refused WITHOUT spending the token
      if (!choices.includes(a.choice)) return out(400, { error: 'choice' })
      // F1: another press's mail is going out, and what it says must stay true
      if (await this.held(now)) return out(409, { error: 'busy' })
      const cur = await s.get('head')
      const address = (await parseRos(cur.ros)).value.address
      const records = await this.records(cur.members)

      if (a.choice === 'cancel') {
        // the change is dropped at once; the mail that says so is best effort,
        // so a mailer outage never stands between the person and a cancel
        await s.delete('pend')
        // C3: a stopped reset puts back the removal it set aside, with its own time and undo link
        const back = kind === 'reset' && p.parked ? p.parked : null
        if (back) {
          await s.put('pend', back)
          await this.schedule(back.ripensAt)
        }
        await this.ended(p.voidTok, 'used', now)
        const until = kind === 'member' ? now + ROSTER_LIMITS.voidCooldownMs : null
        if (until) await s.put(`cool:${p.signer}`, until)
        await this.log({ k: 'void', at: now, seq: cur.seq + 1, op: kind === 'reset' ? 'reset' : p.change.op, pub: p.change.pub, by: p.signer ?? '', choice: 'cancel', os: origin })
        await notify(this.env, address, kind === 'reset' ? 'The reset of your bento/id account was stopped' : 'A change to your bento/id passkeys was cancelled', [
          kind === 'reset'
            ? `At ${when(now)} the link in an email stopped the reset asked for at ${when(p.requestedAt)}. Nothing changed.`
            : `At ${when(now)} the link in an email cancelled the change asked for at ${when(p.requestedAt)} by ${await named(p.signer, records[p.signer])}. Nothing changed.`,
          ...(until ? [`That passkey can still be used to sign in, but it cannot ask for another change to this account until ${when(until)}.`] : []),
          ...(kind === 'reset' && p.preempted ? [`The change that was waiting when the reset was asked for, asked for at ${when(p.preempted.requestedAt)}, stays cancelled. Ask for it again if you still want it.`] : []),
          ...(back ? [`The removal of the suspended ${await named(back.change.pub, records[back.change.pub])}, which the reset had set aside, is waiting again: it takes effect at ${when(Math.max(back.ripensAt, now))}. The link in the email that said it was suspended can still put it back until then.`] : []),
          '',
          'The passkeys on this account:',
          ...(await rosterLines(cur.members, records, null)),
        ], 'void')
        return out(200, { done: 'cancelled', until, ...(back ? { removesAt: Math.max(back.ripensAt, now) } : {}) })
      }

      if (a.choice === 'undo') {
        // G4a: the suspended passkey is put back (a u link right after the q
        // link), and its queued removal is dropped
        const r = parked ?? p
        const target = r.change.pub
        const back = cur.members.map((m) => (m.pub === target ? { ...m, quarantined: false } : m))
        const uRos = buildRos({ address, seq: cur.seq + 1, prev: cur.hash, members: back, dirNonce: ownNonce(), created: now })
        const head = await this.link(uRos, { auth: 'u', cause: cur.hash, requestedAt: now, now, kind: 'undo' })
        await this.ended(r.voidTok, 'used', now)
        let resetAt = null
        if (parked) {
          // C3: the reset waiting over this removal carries on, re-asked on the
          // new head. The kernel takes no link asked for before the one before it
          // took effect, so its 72 hours start again now; its own link still stops it.
          const was = (await parseRos(p.ros)).value
          const ros = buildRos({ address, seq: head.seq + 1, prev: head.hash, members: was.members, dirNonce: was.dirNonce, created: now })
          resetAt = now + ROSTER_WAIT_MS
          const { parked: _set, ...reset } = p
          await s.put('pend', { ...reset, ros, hash: await sha256b64u(ros), requestedAt: now, ripensAt: resetAt })
          await this.schedule(resetAt)
        } else {
          await s.delete('pend')
        }
        await this.log({ k: 'undo', at: now, seq: head.seq, pub: target, os: origin })
        await notify(this.env, address, 'A passkey on your bento/id account was put back', [
          `At ${when(now)} the link in an email put back ${await named(target, records[target])}. It is no longer suspended and will not be removed.`,
          ...(resetAt ? [`The reset of this account that is waiting now takes effect at ${when(resetAt)}: putting the passkey back starts its 72 hours again. The link in the email about the reset still stops it.`] : []),
          '',
          'The passkeys on this account now:',
          ...(await rosterLines(head.members, records, null)),
        ], 'void')
        return out(200, { done: 'restored', ...(resetAt ? { resetAt } : {}) })
      }

      // "Cancel, and remove the passkey that asked for it" (G4): the change is
      // dropped, the passkey that asked is suspended at once (q), and its removal
      // is queued in the same step (x, 72 hours). The removal's own notice
      // carries the undo link (G4a), so it must go out BEFORE anything changes:
      // if the mailer refuses, nothing changes and the page says to try again.
      // F1: the roster is HELD while that notice goes, so what it says stays
      // true: the change cannot take effect, and no other void or reset can act.
      const target = p.signer
      if (!cur.members.some((m) => !m.quarantined && m.pub !== target)) return out(400, { error: 'choice' }) // never lock the person out (G4c)
      const marked = cur.members.map((m) => (m.pub === target ? { ...m, quarantined: true } : m))
      const qRos = buildRos({ address, seq: cur.seq + 1, prev: cur.hash, members: marked, dirNonce: ownNonce(), created: now })
      const qHash = await sha256b64u(qRos)
      const left = marked.filter((m) => m.pub !== target)
      const xRos = buildRos({ address, seq: cur.seq + 2, prev: qHash, members: left, dirNonce: ownNonce(), created: now })
      const removesAt = now + ROSTER_WAIT_MS
      const ut = await mintToken('void')
      const hold = await this.takeHold(now, 'remove')
      const sent = await notify(this.env, address, 'A passkey on your bento/id account was suspended', [
        `At ${when(now)} the link in an email cancelled the change asked for at ${when(p.requestedAt)}, and suspended ${await named(target, records[target])}, which asked for it.`,
        `That passkey can no longer be used. It will be removed from this account at ${when(removesAt)}.`,
        '',
        'The passkeys on this account once it is removed:',
        ...(await rosterLines(left, records, null)),
        '',
        ...voidLines(address, ut.token, 'u', removesAt),
      ], 'void')
      if (!sent) {
        await this.dropHold(hold)
        return out(503, { error: 'mail' })
      }
      // the hold covers a send the mailer's timeout ends; past it (the object
      // stalled), act only if the change the page stopped is still the one
      // waiting, on the same head, and no other press holds the roster now
      const still = await s.get('pend')
      const atHead = await s.get('head')
      const mine = (await s.get('hold'))?.id === hold
      if (!still || still.voidTok !== p.voidTok || atHead.hash !== cur.hash) { await this.dropHold(hold); return out(409, (await this.endedAnswer(th)) ?? { error: 'superseded' }) }
      if (!mine) return out(409, { error: 'busy' })
      await this.link(qRos, { auth: 'q', cause: p.hash, requestedAt: now, now, kind: 'quarantine',
        extra: { voided: { ros: p.ros, signer: target, assertion: p.assertion } } })
      // the removal is requested at the moment the suspension takes effect (the kernel's x rule)
      await s.put('pend', {
        kind: 'removal', ros: xRos, hash: await sha256b64u(xRos), change: { op: 'remove', pub: target }, cause: qHash,
        requestedAt: now, ripensAt: removesAt, mailed: true, voidTok: ut.h, voidKind: 'u',
      })
      await this.ended(p.voidTok, 'used', now)
      await this.dropHold(hold)
      await this.schedule(removesAt)
      await this.log({ k: 'void', at: now, seq: cur.seq + 1, op: p.change.op, pub: p.change.pub, by: target, choice: 'remove', os: origin })
      await this.log({ k: 'quarantine', at: now, seq: cur.seq + 1, pub: target, os: origin })
      return out(200, { done: 'suspended', removesAt })
    }

    if (a.op === 'resetStart') {
      // Mails a reset link to an address that has an account. Anyone can ask:
      // the link goes to the address itself. No budget holds it back (S2: a
      // stranger must never be able to keep the recovery from its owner); only
      // a reset link already mailed and still live does, or one still being
      // mailed (S1, S1″), so the link's life caps how often one goes.
      if (typeof a.address !== 'string' || !a.address) return out(400, { error: 'invalid' })
      if (!(await s.get('head'))) return out(202, { mailed: false }) // nothing to reset
      if ((await s.get('pend'))?.kind === 'reset') return out(202, { mailed: false }) // one is under way; its own link stops it
      const rlive = ((await s.get('resetTok')) || []).filter((t) => t.exp > now)
      const resetHolds = (t) => t.mailed || now - (t.at ?? 0) < ROSTER_LIMITS.setupInFlightMs
      if (rlive.some(resetHolds)) return out(202, { mailed: false })
      const rt = await mintToken('reset')
      const rexp = now + ROSTER_LIMITS.resetTtlMs
      await s.put('resetTok', [...rlive, { h: rt.h, exp: rexp, at: now, mailed: false }])
      const sent = await mailResetLink(this.env, a.address, rt.token, now, rexp)
      const rafter = ((await s.get('resetTok')) || []).filter((t) => t.exp > now)
      await s.put('resetTok', sent ? rafter.map((t) => (t.h === rt.h ? { ...t, mailed: true } : t)) : rafter.filter((t) => t.h !== rt.h))
      return out(202, { mailed: sent })
    }

    if (a.op === 'reset') {
      // A reset link completed on the sign-in host with a new passkey (G5). It
      // waits 72 hours like any change, and preempts whatever change is waiting.
      if (!(await spend())) return out(400, { error: 'nonce' })
      await this.ripen(now)
      const cur = await s.get('head')
      if (!cur) return out(404, { error: 'not-found' })
      if (typeof a.token !== 'string' || typeof a.address !== 'string') return out(400, { error: 'token' })
      const rh = await tokenHash('reset', a.token)
      const rlive = ((await s.get('resetTok')) || []).filter((t) => t.exp > now)
      // no attempt counter here either
      if (!rlive.some((t) => same(t.h, rh))) return out(400, { error: 'token' })
      const waiting = await s.get('pend')
      if (waiting && waiting.kind === 'reset') return out(409, { error: 'pending' }) // one reset at a time; its own link stops it
      // F1: another reset's or a Remove's mail is going out; this one's must not contradict it
      if (await this.held(now)) return out(409, { error: 'busy' })
      const reg = await verifyRegistration(a.reg, b64uDec(a.dirNonce ?? '') ?? new Uint8Array(0))
      if (!reg.ok) return out(400, { error: reg.reason }) // the token stays good
      if (await s.get(`cid:${reg.value.credId}`)) return out(400, { error: 'registration-credential' })
      const before = await parseRos(cur.ros)
      if (before.value.address !== a.address) return out(400, { error: 'address' })
      const fresh = [{ kind: 'pk', pub: reg.value.pub, quarantined: false }]
      const ros = buildRos({ address: a.address, seq: cur.seq + 1, prev: cur.hash, members: fresh, dirNonce: a.dirNonce, created: now })
      const parsed = await parseRos(ros)
      if (!parsed.ok) return out(400, { error: parsed.reason })
      const resetAt = now + ROSTER_WAIT_MS
      const createdAt = await this.createdAt(cur)
      const young = now - createdAt < ROSTER_LIMITS.newAccountMs
      const vt = await mintToken('void')
      const records = await this.records(cur.members)
      const how = hostClass(reg.value.origin)
      // C3: a waiting REMOVAL is set aside, not cancelled: its undo link keeps
      // working, and if the reset is stopped the removal waits again. Any other
      // waiting change is cancelled for good (a stopped reset never applies one).
      const setAside = waiting && waiting.kind === 'removal' ? waiting : null
      // F1: the roster is held while the notice goes, so what it says stays true
      const hold = await this.takeHold(now, 'reset')
      const sent = await notify(this.env, a.address, 'A reset of your bento/id account is waiting', [
        `At ${when(now)} a reset of this bento/id account was asked for ${HOW[how]}, with a link mailed to this address.`,
        `It takes effect at ${when(resetAt)}, 72 hours after it was asked for. Then every passkey on this account is removed, and its only passkey is the new one, ${await fingerprint(reg.value.pub)}, made at the reset.`,
        ...(setAside
          ? [`The removal of the suspended ${await named(setAside.change.pub, records[setAside.change.pub])}, which was waiting, is set aside while this reset waits. The link that puts that passkey back still works, and if this reset is stopped, the removal waits again.`]
          : waiting ? ['A change that was waiting is cancelled by this reset. Stopping the reset does not bring it back.'] : []),
        ...(young ? [`This account was set up less than 14 days ago, at ${when(createdAt)}, so its passkeys cannot stop this reset: only the link below can.`] : []),
        '',
        'The passkeys on this account now, which the reset removes:',
        ...(await rosterLines(cur.members, records, null)),
        '',
        ...voidLines(a.address, vt.token, 'r', resetAt, waiting ? [] : ['Stopping it changes nothing else: your passkeys stay as they are.']),
      ], 'reset')
      if (!sent) {
        await this.dropHold(hold)
        return out(503, { error: 'mail' }) // no notice, no reset: the notice is how it is stopped (D1)
      }
      // the hold covers a send the mailer's timeout ends; past it (the object
      // stalled), queue only over the same waiting change, on the same head,
      // while no other press holds the roster
      const there = await s.get('pend')
      const atHead = await s.get('head')
      if ((there?.voidTok ?? null) !== (waiting?.voidTok ?? null) || atHead.hash !== cur.hash) { await this.dropHold(hold); return out(409, { error: 'superseded' }) }
      if ((await s.get('hold'))?.id !== hold) return out(409, { error: 'busy' })
      if (there && !setAside) {
        await this.log({ k: 'preempted', at: now, seq: cur.seq + 1, op: there.change.op, pub: there.change.pub, by: there.signer ?? '', os: origin })
        await this.ended(there.voidTok, 'preempted', now)
      }
      if (setAside) await this.log({ k: 'set-aside', at: now, seq: cur.seq + 1, op: 'remove', pub: setAside.change.pub, os: origin })
      await s.put('pend', {
        kind: 'reset', ros, hash: await sha256b64u(ros), change: { op: 'reset', pub: reg.value.pub },
        reg: { credId: reg.value.credId, signCount: reg.value.signCount, origin: reg.value.origin },
        requestedAt: now, ripensAt: resetAt, mailed: true, voidTok: vt.h, voidKind: 'r', os: origin, rq: '', co: reg.value.origin, how,
        ...(setAside ? { parked: setAside } : there ? { preempted: { requestedAt: there.requestedAt } } : {}),
      })
      await s.delete('resetTok') // a reset under way ends every reset link: each is single use
      await this.dropHold(hold)
      await this.schedule(resetAt)
      await this.log({ k: 'reg', at: now, seq: cur.seq + 1, pub: reg.value.pub, os: origin, rq: '', co: reg.value.origin })
      await this.log({ k: 'reset-request', at: now, seq: cur.seq + 1, pub: reg.value.pub, os: origin, rq: '', co: reg.value.origin })
      return out(202, { ros, requestedAt: now, ripensAt: resetAt })
    }

    if (a.op === 'resetVoid') {
      // G5: a member stopping a reset with its passkey, allowed only once the
      // account is 14 days old (before that, whoever set it up without the
      // mailbox could keep the address). The rules are checked in order; the
      // last step, the passkey's signature, waits for the kernel to define the
      // statement it signs, so for now every request that reaches it is refused.
      if (!(await spend())) return out(400, { error: 'nonce' })
      await this.ripen(now)
      const p = await s.get('pend')
      if (!p || p.kind !== 'reset') return out(409, { error: 'no-reset' })
      const cur = await s.get('head')
      if (now - (await this.createdAt(cur)) < ROSTER_LIMITS.newAccountMs) return out(403, { error: 'new-account' })
      const pub = typeof a.credId === 'string' ? await s.get(`cid:${a.credId}`) : undefined
      const who = pub ? cur.members.find((m) => m.pub === pub) : undefined
      if (!who) return out(400, { error: 'signer' })
      if (who.quarantined) return out(403, { error: 'quarantined' })
      return out(501, { error: 'not-implemented', reason: 'the kernel statement a passkey signs to stop a reset is not defined yet' })
    }

    if (a.op === 'logQuery') {
      // the incident lever's read: every logged enrolment and change in [from, to]
      if (!Number.isSafeInteger(a.from) || !Number.isSafeInteger(a.to)) return out(400, { error: 'invalid' })
      const entries = [...(await s.list({ prefix: 'log:' })).values()].filter((e) => e.at >= a.from && e.at <= a.to)
      return out(200, { entries })
    }

    return out(400, { error: 'bad-op' })
  }
}
