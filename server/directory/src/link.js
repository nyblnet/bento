// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Device linking (link v1): a short-lived, ciphertext-only mailbox that two of
// one person's devices use to hand the account key from the device that holds
// it (H) to a new one (N). Its own Durable Object class, so a bug here can never
// read an Address, an Account or a Cred.
//
// The directory never sees a key. Every message is encrypted on the devices
// under keys derived from a code the directory never receives; the slot id and
// `tok` are derived from that code too, so only the two devices can address the
// slot. What the directory DOES check is the one step that matters: before it
// releases the sealed account key to N, it runs kernel's verifyLinkRelease over
// H's whole message 3 (H's consent: a `cns.` with purpose `link`, audience `dir`,
// over N's `dev.` text) against the LIVE binding, spending its challenge first,
// and only while the binding is `active`. The light tier's WebAuthn link consent
// is OFF: message 3 has no form for it, and kernel refuses an H with no consent
// key. Every completed link is notified.
//
// Rules (security §39.1):
//  · one slot per code, 10 minutes from open, messages of at most 4 KB;
//  · each message number is written ONCE. A second write of the same number
//    means a second device has the code (a photographed QR): the slot becomes
//    CONTENDED, its messages are dropped, and both sides are told to start again;
//  · the slot completes ONCE: the first completion attempt claims it, and any
//    failure, or a second attempt, deletes it;
//  · an aborted or completed slot can't be reopened while its window lasts.
//
// Message numbers: 0 = the displayer's ephemeral key and role (sent with open),
// 1 = the scanner's ephemeral key, 2 = N's device keys and proofs, 3 = H's
// message 3 (kernel's buildFinal text), written only through /v1/link/complete
// and handed to N whole, which checks it with kernel's openFinal.

import { addressKey, normalize } from './address.js'
import { openChallenge } from './challenge.js'
import { AUDIENCE } from './consent.js'
import { b64uDec, b64uEnc, linkTokHash } from './statements.js'

export const LINK = Object.freeze({
  ttlMs: 10 * 60_000, // a slot lives 10 minutes from open
  burnMs: 10 * 60_000, // an aborted or completed slot stays unusable for the rest of a window
  maxMsg: 4096, // bytes, after base64url decoding
  pollMs: 25_000, // the longest a read waits for a message
})

// id and tok are 32 bytes each: kernel's linkSlot HKDF outputs (link v1). The
// slot stores kernel's linkTokHash(tok), never the token.
const b32 = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s) && b64uDec(s)?.length === 32
const msgOk = (m) => {
  if (typeof m !== 'string' || m.length === 0) return false
  const b = b64uDec(m)
  return !!b && b.length > 0 && b.length <= LINK.maxMsg && b64uEnc(b) === m
}

// msg3 is kernel's lnk3 text: eight lines of at most 4096 printable bytes each
const MSG3_MAX = 8 * (4096 + 1)
const tokHash = (tok) => linkTokHash(tok)
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

const linkStub = (env, id) => env.LINK.get(env.LINK.idFromName(id))
async function linkCall(env, id, op, args) {
  const r = await linkStub(env, id).fetch('https://link/op', { method: 'POST', body: JSON.stringify({ op, ...args }) })
  return { status: r.status, body: await r.json() }
}

/**
 * The /v1/link/* routes. Returns a Response, or null when `p` is not a link route.
 * deps: { json, ledger, addressCall } from the worker.
 */
export async function linkRoute(p, b, env, ip, deps) {
  if (!p.startsWith('/v1/link/')) return null
  const { json, ledger, addressCall } = deps // and notify(scope, kind, fp)
  // OFF unless LINKING=1: N can only check what it receives against a PINNED
  // directory key (§39.2), and the agents' link bytes (K6) don't exist yet.
  if (env.LINKING !== '1') return json(404, { error: 'not-found' })
  if (!b32(b.id) || !b32(b.tok)) return json(400, { error: 'invalid' })
  const op = p.slice('/v1/link/'.length)
  if (!(await ledger(env, ip, op === 'open' ? 'linkOpen' : 'link'))) return json(429, { error: 'rate-limited' })
  const relay = (r) => json(r.status, r.body)

  if (op === 'open') {
    if (!msgOk(b.msg)) return json(400, { error: 'invalid' })
    return relay(await linkCall(env, b.id, 'open', { tok: b.tok, msg: b.msg }))
  }
  if (op === 'put') {
    if (!msgOk(b.msg) || (b.n !== 1 && b.n !== 2)) return json(400, { error: 'invalid' })
    return relay(await linkCall(env, b.id, 'put', { tok: b.tok, n: b.n, msg: b.msg }))
  }
  if (op === 'get') {
    if (![0, 1, 2, 3].includes(b.n)) return json(400, { error: 'invalid' })
    const wait = Number.isSafeInteger(b.wait) && b.wait > 0 ? Math.min(b.wait, LINK.pollMs) : 0
    const r = await linkCall(env, b.id, 'get', { tok: b.tok, n: b.n, wait })
    if (b.n === 3 && r.status === 200) {
      // released only while the binding is still active: a freeze or a
      // rotation that began after H's consent stops the key here
      const st = await addressCall(env.ADDRESS.get(env.ADDRESS.idFromName(r.body.scope)), 'peek', {})
      if (!st.body.live || st.body.state !== 'active' || st.body.accountPub !== r.body.accountPub) {
        await linkCall(env, b.id, 'abort', { tok: b.tok })
        return json(409, { error: 'state' })
      }
      return json(200, { msg: r.body.msg })
    }
    return relay(r)
  }
  if (op === 'abort') return relay(await linkCall(env, b.id, 'abort', { tok: b.tok }))

  if (op === 'complete') {
    const email = normalize(b.email ?? '')
    // ONE text: H's message 3, exactly as kernel's buildFinal makes it. Its
    // grammar, H's and N's certificates and H's consent are all kernel's to check.
    if (!email || typeof b.challenge !== 'string' || typeof b.msg3 !== 'string' || b.msg3.length > MSG3_MAX) return json(400, { error: 'invalid' })
    // claim FIRST: one completion per slot, and any later attempt deletes it
    const c = await linkCall(env, b.id, 'claim', { tok: b.tok })
    if (c.status !== 200) return relay(c)
    const scope = await addressKey(email)
    const ch = await openChallenge(env.CHALLENGE_KEY, AUDIENCE, scope, b.challenge, Date.now())
    const v = ch && await addressCall(env.ADDRESS.get(env.ADDRESS.idFromName(scope)), 'link', {
      nonce: ch.nonce, scope, challenge: b.challenge, msg3: b.msg3,
    })
    if (!v || v.status !== 200) {
      await linkCall(env, b.id, 'abort', { tok: b.tok })
      return json(400, { error: 'invalid', reason: v ? v.body.reason : 'challenge' })
    }
    const d = await linkCall(env, b.id, 'deliver', { tok: b.tok, msg: b.msg3, scope, accountPub: v.body.accountPub })
    if (d.status !== 200) return relay(d)
    await deps.notify(scope, 'link', v.body.fp) // every link notifies (§39.1 condition 6)
    return json(200, { ok: true })
  }
  return json(404, { error: 'not-found' })
}

// --- one Durable Object per link SLOT ----------------------------------------------
// Storage: `slot` { th (hash of tok), until, msgs: {n: b64u}, claimed, scope } or
// `burned` { until } once aborted, contended or completed. Nothing outlives the
// window by more than LINK.burnMs; an alarm deletes it all.

export class Link {
  constructor(state, env) { this.state = state; this.env = env; this.waiters = new Map() }

  wake(n) {
    for (const w of this.waiters.get(n) || []) w()
    this.waiters.delete(n)
  }
  wakeAll() { for (const n of [...this.waiters.keys()]) this.wake(n) }

  async fetch(req) {
    const a = await req.json()
    const now = Date.now()
    const s = this.state.storage
    const out = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const burn = async (until, reason) => {
      await s.delete('slot')
      await s.put('burned', { until, reason })
      this.wakeAll()
    }

    let slot = await s.get('slot')
    if (slot && slot.until <= now) { await s.delete('slot'); slot = null } // expired: as if never opened
    const burned = await s.get('burned')
    const gone = burned && burned.until > now ? burned : null

    if (a.op === 'open') {
      if (gone) return out(409, { error: gone.reason })
      if (slot) {
        // the same code opened twice: someone else has it
        await burn(slot.until + LINK.burnMs, 'contended')
        return out(409, { error: 'contended' })
      }
      const until = now + LINK.ttlMs
      await s.put('slot', { th: await tokHash(a.tok), until, msgs: { 0: a.msg }, claimed: false, scope: null })
      await s.delete('burned')
      await s.setAlarm(until + LINK.burnMs)
      return out(200, { ok: true, expires: until })
    }

    if (gone) return out(409, { error: gone.reason })
    if (!slot) return out(404, { error: 'not-found' })
    if (!same(await tokHash(a.tok), slot.th)) return out(403, { error: 'invalid' })

    if (a.op === 'put') {
      if (slot.claimed) return out(409, { error: 'completed' })
      if (Object.hasOwn(slot.msgs, a.n)) {
        // a second writer of the same message: a second scanner, or a replay
        await burn(slot.until + LINK.burnMs, 'contended')
        return out(409, { error: 'contended' })
      }
      if (!Object.hasOwn(slot.msgs, a.n - 1)) return out(400, { error: 'order' })
      slot.msgs[a.n] = a.msg
      await s.put('slot', slot)
      this.wake(a.n)
      return out(200, { ok: true })
    }

    if (a.op === 'get') {
      const answer = (sl) => out(200, a.n === 3 ? { msg: sl.msgs[3], scope: sl.scope, accountPub: sl.accountPub } : { msg: sl.msgs[a.n] })
      if (Object.hasOwn(slot.msgs, a.n)) return answer(slot)
      if (a.wait > 0) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, Math.min(a.wait, slot.until - now))
          const list = this.waiters.get(a.n) || []
          list.push(() => { clearTimeout(t); resolve() })
          this.waiters.set(a.n, list)
        })
        const b2 = await s.get('burned')
        if (b2 && b2.until > Date.now()) return out(409, { error: b2.reason })
        const sl = await s.get('slot')
        if (sl && Object.hasOwn(sl.msgs, a.n)) return answer(sl)
      }
      return out(202, { pending: true })
    }

    if (a.op === 'claim') {
      if (slot.claimed) {
        await burn(slot.until + LINK.burnMs, 'completed')
        return out(409, { error: 'completed' })
      }
      if (![0, 1, 2].every((n) => Object.hasOwn(slot.msgs, n))) return out(400, { error: 'order' })
      slot.claimed = true
      await s.put('slot', slot)
      return out(200, { ok: true })
    }

    if (a.op === 'deliver') {
      if (!slot.claimed || Object.hasOwn(slot.msgs, 3)) return out(409, { error: 'completed' })
      slot.msgs[3] = a.msg
      slot.scope = a.scope
      slot.accountPub = a.accountPub
      await s.put('slot', slot)
      this.wake(3)
      return out(200, { ok: true })
    }

    if (a.op === 'abort') {
      // the SAS was typed wrong, N finished, or a check failed: one try per code
      await burn(slot.until + LINK.burnMs, 'aborted')
      return out(200, { ok: true })
    }

    return out(400, { error: 'bad-op' })
  }

  async alarm() {
    await this.state.storage.delete(['slot', 'burned'])
    this.wakeAll()
  }
}
