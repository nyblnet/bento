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
//
// NOT HERE YET (each a later change): the directory's ripening countersign
// (`rip.`), which waits for the kernel's authority word; the void page and its
// two buttons (quarantine, undo, cooldown); the reset and its link;
// consent-key and recovery-key members; account deletion. This
// object records each ripened link with its directory times so the countersign
// can be issued for every one of them later; until then nothing here is a
// countersign and no route serves one.

import { b64uDec, b64uEnc, sha256b64u } from '../../../kernel/src/statements.ts'
import { buildRos, parseRos, ROSTER_WAIT_MS } from '../../../kernel/src/roster.ts'
import { PASSKEY, verifyMemberAssertion, verifyRegistration } from './passkey.js'
import { deliver } from './mail.js'
import { setupLink } from './links.js'

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
  /** at most this many expired spent challenges are swept by each new spend */
  spentSweep: 32,
  /** a change whose waiting notice was never confirmed sent is dropped after this (the object stopped mid-send) */
  unsentDropMs: 10 * MIN,
}

/** The openers the sign-in host may report (it reads them from the message event). */
export const REQUESTERS = Object.freeze(['https://home.bento.page'])

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
async function notify(env, to, subject, lines) {
  const body = [...lines, '', 'Bento will never ask you to type or paste anything from this email.'].join('\n')
  try { await deliver(env, { to, subject, body, kind: 'roster' }); return true } catch (e) { console.log(`roster mail failed: ${e.message}`); return false }
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
    if (p && p.mailed === true) next.push(p.ripensAt)
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
    await this.apply(p, now, 'ripen')
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

  async log(entry) {
    const s = this.state.storage
    const n = ((await s.get('logN')) || 0) + 1
    await s.put('logN', n)
    await s.put(`log:${String(n).padStart(8, '0')}`, entry)
  }

  /** Make a change the head. `p` is a waiting (or immediate) change. */
  async apply(p, now, k) {
    const s = this.state.storage
    const h = await parseRos(p.ros)
    if (!h.ok) throw new Error('stored change does not parse') // never: it parsed when it was queued
    const head = { ros: p.ros, hash: p.hash, seq: h.value.seq, members: h.value.members, ripenedAt: now }
    await s.put(`link:${String(head.seq).padStart(8, '0')}`, {
      ros: p.ros, kind: 'member', requestedAt: p.requestedAt, ripenedAt: now,
      signer: p.signer, credId: p.credId, assertion: p.assertion,
    })
    if (p.change.op === 'add') {
      await s.put(`pk:${p.change.pub}`, { credId: p.reg.credId, signCount: p.reg.signCount, addedAt: now, how: p.how })
      await s.put(`cid:${p.reg.credId}`, p.change.pub)
    } else {
      const r = await s.get(`pk:${p.change.pub}`)
      await s.delete([`pk:${p.change.pub}`, ...(r ? [`cid:${r.credId}`] : [])])
    }
    await s.put('head', head)
    await s.delete('pend')
    const fp = await fingerprint(p.change.pub)
    await this.log({ k, at: now, seq: head.seq, op: p.change.op, pub: p.change.pub, by: p.signer, os: p.os, rq: p.rq, co: p.co })

    const records = await this.records(head.members)
    const what = p.change.op === 'add' ? `the passkey ${fp} was added` : p.signer === p.change.pub ? `the passkey ${fp} removed itself` : `the passkey ${fp} was removed`
    await notify(this.env, h.value.address, 'Your bento/id passkeys changed', [
      k === 'ripen'
        ? `A change asked for at ${when(p.requestedAt)} ${HOW[p.how]} is now in effect: ${what}.`
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

    if (a.op === 'head') {
      await this.ripen(now)
      const head = await s.get('head')
      if (!head) return out(404, { error: 'not-found' })
      const p = await s.get('pend')
      return out(200, {
        ros: head.ros, seq: head.seq,
        pending: p && p.mailed === true ? { ros: p.ros, requestedAt: p.requestedAt, ripensAt: p.ripensAt } : null,
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
      const spent = await this.spendSetupBudget(now)
      if (!spent && live.some((t) => t.mailed)) return out(202, { mailed: false })
      const token = b64uEnc(crypto.getRandomValues(new Uint8Array(32)))
      const h = await sha256hex(`bento-dir/1/setup\n${token}`)
      const exp = now + (spent ? ROSTER_LIMITS.setupTtlMs : ROSTER_LIMITS.setupBeyondTtlMs)
      // a new token never replaces an older live one: a stranger's start must not kill the owner's link
      await s.put('setupTok', [...live, { h, exp, mailed: false }])
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
      const hash = await sha256b64u(ros)
      const how = 'setup'
      await s.put('head', { ros, hash, seq: 0, members: parsed.value.members, ripenedAt: now })
      await s.put('link:00000000', { ros, kind: 'setup', requestedAt: now, ripenedAt: now })
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
      if (a.rq !== undefined && a.rq !== '' && !REQUESTERS.includes(a.rq)) return out(400, { error: 'rq' })

      // the member who asked
      const signerPub = typeof a.credId === 'string' ? await s.get(`cid:${a.credId}`) : undefined
      const signer = signerPub && cur.members.find((m) => m.pub === signerPub)
      if (!signer) return out(400, { error: 'signer' })
      if (signer.quarantined) return out(403, { error: 'quarantined' })
      if (signer.kind !== 'pk') return out(400, { error: 'signer-kind' })
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

    if (a.op === 'logQuery') {
      // the incident lever's read: every logged enrolment and change in [from, to]
      if (!Number.isSafeInteger(a.from) || !Number.isSafeInteger(a.to)) return out(400, { error: 'invalid' })
      const entries = [...(await s.list({ prefix: 'log:' })).values()].filter((e) => e.at >= a.from && e.at <= a.to)
      return out(200, { entries })
    }

    return out(400, { error: 'bad-op' })
  }
}
