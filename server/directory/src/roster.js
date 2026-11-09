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
//
// NOT HERE YET (each a later change): the directory's ripening countersign
// (`rip.`), which waits for the kernel's authority word; the void page and its
// two buttons (quarantine, undo, cooldown); the reset; setup and reset links
// in mail; consent-key and recovery-key members; account deletion. This
// object records each ripened link with its directory times so the countersign
// can be issued for every one of them later; until then nothing here is a
// countersign and no route serves one.

import { b64uDec, b64uEnc, sha256b64u } from '../../../kernel/src/statements.ts'
import { buildRos, parseRos, ROSTER_WAIT_MS } from '../../../kernel/src/roster.ts'
import { PASSKEY, verifyMemberAssertion, verifyRegistration } from './passkey.js'
import { deliver } from './mail.js'

const MIN = 60_000, DAY = 86_400_000

export const ROSTER_LIMITS = {
  /** a setup token's life */
  setupTtlMs: 20 * MIN,
  /** the per-address budget for setup-token mail, which a stranger can spend */
  mailCooldownMs: 60_000,
  mailPerDay: 3,
  mailPerMonth: 10,
  /** the longest Origin header kept in the log */
  originMax: 200,
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

/** Every roster notice goes out here, whatever any mail budget says (G10). */
async function notify(env, to, subject, lines) {
  const body = [...lines, '', 'Bento will never ask you to type or paste anything from this email.'].join('\n')
  try { await deliver(env, { to, subject, body, kind: 'roster' }) } catch (e) { console.log(`roster mail failed: ${e.message}`) }
}

// --- the object ------------------------------------------------------------------

export class Roster {
  constructor(state, env) { this.state = state; this.env = env }

  async alarm() {
    const s = this.state.storage
    await this.ripen(Date.now())
    const p = await s.get('pend')
    if (p) await s.setAlarm(p.ripensAt)
  }

  /** The waiting change, in force once its 72 hours are up. */
  async ripen(now) {
    const s = this.state.storage
    const p = await s.get('pend')
    if (!p || now < p.ripensAt) return
    await this.apply(p, now, 'ripen')
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
    await this.log({ k, at: now, seq: head.seq, op: p.change.op, fp, by: await fingerprint(p.signer), os: p.os, rq: p.rq, co: p.co })

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

    /** Spend a directory challenge: FIRST, before any other check, so every attempt consumes it. */
    const spend = async () => {
      if (typeof a.nonce !== 'string' || !Number.isSafeInteger(a.issued)) return false
      const list = ((await s.get('spent')) || []).filter((x) => x.exp > now)
      if (list.some((x) => x.n === a.nonce)) { await s.put('spent', list); return false }
      list.push({ n: a.nonce, exp: a.issued + 10 * MIN })
      await s.put('spent', list)
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
        pending: p ? { ros: p.ros, requestedAt: p.requestedAt, ripensAt: p.ripensAt } : null,
      })
    }

    if (a.op === 'setupStart') {
      // Anyone can ask, for any address, so this is the one budget a stranger
      // can fill: it is spent LAST, only when a token is minted, and nothing but
      // setup-token mail ever reads it.
      if (await s.get('head')) return out(202, { token: null }) // taken: a reset is a later change
      const times = ((await s.get('mail')) || []).filter((t) => now - t < 31 * DAY)
      if (times.length && now - times[times.length - 1] < ROSTER_LIMITS.mailCooldownMs) return out(202, { token: null })
      if (times.filter((t) => now - t < DAY).length >= ROSTER_LIMITS.mailPerDay) return out(202, { token: null })
      if (times.length >= ROSTER_LIMITS.mailPerMonth) return out(202, { token: null })
      await s.put('mail', [...times, now])
      const token = b64uEnc(crypto.getRandomValues(new Uint8Array(32)))
      // a new token never replaces an older live one: a stranger's start must not kill the owner's link
      const live = ((await s.get('setupTok')) || []).filter((t) => t.exp > now)
      await s.put('setupTok', [...live, { h: await sha256hex(`bento-dir/1/setup\n${token}`), exp: now + ROSTER_LIMITS.setupTtlMs }])
      return out(202, { token })
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
      const fp = await fingerprint(reg.value.pub)
      await this.log({ k: 'reg', at: now, seq: 0, fp, os: origin, rq: '', co: reg.value.origin })
      await this.log({ k: 'setup', at: now, seq: 0, fp, os: origin, rq: '', co: reg.value.origin })
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
      if (reg) await this.log({ k: 'reg', at: now, seq: next.seq, fp: await fingerprint(change.pub), by, os: origin, rq: p.rq, co: reg.origin })

      // a member removing itself, with another live passkey left: at once
      const selfRemoval = change.op === 'remove' && change.pub === signer.pub &&
        next.members.some((m) => m.kind === 'pk' && !m.quarantined)
      if (selfRemoval) {
        await this.apply({ ...p, requestedAt: now }, now, 'remove-self')
        return out(200, { ros: a.ros, inForce: true })
      }

      await s.put('pend', p)
      await s.setAlarm(p.ripensAt)
      await this.log({ k: 'request', at: now, seq: next.seq, op: change.op, fp: await fingerprint(change.pub), by, os: origin, rq: p.rq, co: p.co })
      const records = await this.records(cur.members)
      const rec2 = records[signer.pub]
      const what = change.op === 'add' ? `add the passkey ${await fingerprint(change.pub)}`
        : change.pub === signer.pub ? `remove the passkey ${by}, which asked for it` : `remove the passkey ${await fingerprint(change.pub)}`
      await notify(this.env, next.address, 'A change to your bento/id passkeys is waiting', [
        `At ${when(now)} a change to this bento/id account was asked for ${HOW[p.how]}: ${what}.`,
        `It was asked for by the passkey ${by}${rec2 ? `, added ${when(rec2.addedAt)} ${HOW[rec2.how] ?? ''}`.trimEnd() : ''}.`,
        `It takes effect at ${when(p.ripensAt)}, 72 hours after it was asked for.`,
        '',
        'The passkeys on this account once it takes effect:',
        ...(await rosterLines(next.members, records, change.op === 'add' ? change.pub : null)),
      ])
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
