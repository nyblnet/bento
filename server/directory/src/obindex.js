// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// The incident lever's two stores (SD5), one Durable Object class with two
// kinds of instance:
//
// - `ob:<YYYY-MM-DD>` (UTC day): the address keys (addressKey, a hash, never
//   the address) of every account that had an ob = 1 event that day: a
//   browser enrolment, or a roster change asked for, at bento/home's request.
//   Per-address objects cannot be listed, so this is how the lever finds the
//   accounts a window touched. The Roster object writes it BEFORE it stores,
//   logs or countersigns anything for the event, and a failed write fails the
//   request: the index may over-include (a request refused after it was
//   indexed), never under-include. Kept for the life of the account, like the
//   log it points into.
// - `incidents`: the incident records the lever publishes, each kept with the
//   kernel's signed `inc.` text (kernel/src/devices.ts) under the directory's
//   online key, and the lever commands' spent nonces.
//
// Nothing iterates this object but the lever route (lever.js), which only a
// command signed by the maintainer's offline lever key reaches.

import { buildInc } from '../../../kernel/src/devices.ts'
import { signStatement } from '../../../kernel/src/statements.ts'

/** The instance that holds the incident records and the lever's nonces. */
export const INCIDENTS_NAME = 'incidents'
/** A UTC day, YYYY-MM-DD. */
export const dayOf = (t) => new Date(t).toISOString().slice(0, 10)
/** The index shard for the day of `t`. */
export const shardOf = (t) => `ob:${dayOf(t)}`

const KEY = /^[0-9a-f]{64}$/
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/
const NONCE = /^[A-Za-z0-9_-]{16,64}$/
const B64U = /^[A-Za-z0-9_-]{40,200}$/

const stub = (env, name) => {
  if (!env.OBINDEX || typeof env.OBINDEX.idFromName !== 'function') throw new Error('OBINDEX is not bound')
  return env.OBINDEX.get(env.OBINDEX.idFromName(name))
}
async function call(env, name, op, args = {}) {
  const r = await stub(env, name).fetch('https://obindex/op', { method: 'POST', body: JSON.stringify({ ...args, op }) })
  const body = await r.json()
  if (!r.ok) throw new Error(`obindex ${op}: ${r.status}`)
  return body
}

/**
 * Record that the account `key` had an ob = 1 event at `at`. Throws when the
 * index cannot be written: the caller's request then fails before anything
 * else is stored (over-include, never under-include).
 */
export async function indexOb(env, at, key) {
  if (!KEY.test(key)) throw new Error('not an address key')
  await call(env, shardOf(at), 'add', { key })
}

/** One page of a day's shard: up to `limit` keys after `after` (in key order), and whether more may follow. */
export const shardPage = (env, day, after, limit) => call(env, `ob:${day}`, 'page', { after, limit })

/** Spend a lever nonce once; false when it was seen before. */
export const spendLeverNonce = async (env, nonce, until) => (await call(env, INCIDENTS_NAME, 'nonce', { nonce, until })).ok === true

/** Store (or replace) an incident record. */
export const putIncident = (env, rec) => call(env, INCIDENTS_NAME, 'put', { rec })

let signer = null
/** The directory's online key, as everywhere it signs (DIR_KEY_JWK, DIR_KID). Throws when it is not configured. */
async function dirKey(env) {
  if (typeof env.DIR_KEY_JWK !== 'string' || typeof env.DIR_KID !== 'string') throw new Error('DIR_KEY_JWK and DIR_KID are not configured')
  if (!signer || signer.jwk !== env.DIR_KEY_JWK) {
    signer = { jwk: env.DIR_KEY_JWK, key: await crypto.subtle.importKey('jwk', JSON.parse(env.DIR_KEY_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) }
  }
  return signer.key
}

/**
 * A signed incident record: the kernel's inc. text and its signature. `to` is
 * never later than `issuedAt` (security's nit on #949): an open record has no
 * `to`, and closing one issues it again.
 */
export async function signIncident(env, { id, from, to, issuedAt }) {
  if (to !== null && to > issuedAt) throw new Error('an incident record may not end after it is issued')
  const inc = buildInc({ id, from, to, issuedAt, kid: env.DIR_KID })
  return { id, from, to, issuedAt, kid: env.DIR_KID, inc, sig: await signStatement(await dirKey(env), inc) }
}

/** Is `r` a stored record that reads, its text exactly what its fields say? */
function recordReads(r) {
  return !!r && typeof r === 'object' && Object.keys(r).length === 7 && typeof r.id === 'string' && ID.test(r.id) &&
    Number.isSafeInteger(r.from) && r.from > 0 && (r.to === null || (Number.isSafeInteger(r.to) && r.to > r.from)) &&
    Number.isSafeInteger(r.issuedAt) && r.issuedAt >= r.from && (r.to === null || r.to <= r.issuedAt) &&
    typeof r.kid === 'string' && typeof r.sig === 'string' && B64U.test(r.sig) &&
    r.inc === buildInc({ id: r.id, from: r.from, to: r.to, issuedAt: r.issuedAt, kid: r.kid })
}

/** The records the lever published. Throws on anything that does not read, the binding missing included. */
export async function storedIncidents(env) {
  const { records } = await call(env, INCIDENTS_NAME, 'records')
  if (!Array.isArray(records)) throw new Error('incident records do not read')
  for (const r of records) if (!recordReads(r)) throw new Error('an incident record does not read')
  return records
}

export class ObIndex {
  constructor(state, env) { this.state = state; this.env = env }

  async fetch(req) {
    const s = this.state.storage
    const out = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    let a
    try { a = await req.json() } catch { return out(400, { error: 'bad-request' }) }

    if (a.op === 'add') {
      if (typeof a.key !== 'string' || !KEY.test(a.key)) return out(400, { error: 'key' })
      await s.put(`a:${a.key}`, 1)
      return out(200, { ok: true })
    }
    if (a.op === 'page') {
      const limit = Number.isSafeInteger(a.limit) && a.limit > 0 && a.limit <= 128 ? a.limit : 0
      if (!limit || (a.after !== '' && !(typeof a.after === 'string' && KEY.test(a.after)))) return out(400, { error: 'page' })
      const opts = { prefix: 'a:', limit }
      if (a.after) opts.startAfter = `a:${a.after}`
      const keys = [...(await s.list(opts)).keys()].map((k) => k.slice(2))
      return out(200, { keys, more: keys.length === limit })
    }
    if (a.op === 'records') {
      return out(200, { records: [...(await s.list({ prefix: 'inc:' })).values()] })
    }
    if (a.op === 'put') {
      if (!recordReads(a.rec)) return out(400, { error: 'record' })
      await s.put(`inc:${a.rec.id}`, a.rec)
      return out(200, { ok: true })
    }
    if (a.op === 'nonce') {
      if (typeof a.nonce !== 'string' || !NONCE.test(a.nonce) || !Number.isSafeInteger(a.until)) return out(400, { error: 'nonce' })
      if (await s.get(`n:${a.nonce}`)) return out(200, { ok: false })
      await s.put(`n:${a.nonce}`, a.until)
      // only a command whose signature verified gets here, so these are few: sweep the spent ones past their keep
      const now = Date.now()
      const dead = [...(await s.list({ prefix: 'n:' })).entries()].filter(([, until]) => until <= now).map(([k]) => k)
      if (dead.length) await s.delete(dead)
      return out(200, { ok: true })
    }
    return out(400, { error: 'bad-op' })
  }
}
