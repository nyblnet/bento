// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// The one place the directory hands a message to its mailer. Every message is
// fixed wording built by the directory; nothing a caller typed is ever in it.

import { sesSend } from './ses.js'

/**
 * Every kind of mail the directory sends, and whether a per-address budget may
 * hold it back. Anyone can ask the directory to mail an address a setup link,
 * so that budget is STRANGER-FILLABLE. A mail that tells
 * the person something is happening to their account, or is their way to stop
 * it or to recover, must never wait on one: a stranger who could fill the
 * budget could then hide a change or block a recovery (security's S2). That
 * holds for every kind marked 'never' here, including the ones not built yet,
 * and the rig pins this table and checks where budgets are read.
 *
 * - 'budget': may be held back, and only under the rule that the budget holds
 *   a setup mail back only while a link it already mailed is still live (S1).
 * - 'never': never reads or spends any budget.
 */
export const MAIL_KINDS = Object.freeze({
  setup: 'budget', // a setup link (roster.js)
  roster: 'never', // a roster change: set up, waiting, in effect
  reset: 'never', // a reset link, and a reset's own notices (roster.js)
  void: 'never', // what the void page did: cancelled, suspended and queued for removal, put back (roster.js)
  freeze: 'never', // a freeze (not built)
})

/**
 * The longest the directory waits for its mailer. A send that has not answered
 * by then counts as failed. It must stay well under roster.js's unsentDropMs (10
 * minutes): a change whose notice is still in flight holds the slot, and the
 * caller's post-send write checks the slot is still its own (security's D1a).
 */
export const MAIL_TIMEOUT_MS = 30_000

/**
 * Settles like `p`, or rejects once MAIL_TIMEOUT_MS has passed, with an error
 * whose `code` is 'timeout'. A timed-out send is NOT a refused one: the mailer
 * may still accept and deliver it, so a caller that reports the outcome must
 * never say the mail was not sent (security's C8 on #952). Every other failure
 * has no code.
 */
function timed(p) {
  let timer
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('mailer timed out'), { code: 'timeout' })), MAIL_TIMEOUT_MS) })
  return Promise.race([Promise.resolve(p), late]).finally(() => clearTimeout(timer))
}

/** `msg`: { to, subject, body, kind }. Throws when no mailer is configured, for an undeclared kind, or when the mailer fails or times out (a timeout's error has `code: 'timeout'`). */
export async function deliver(env, msg) {
  if (!msg || !Object.hasOwn(MAIL_KINDS, msg.kind)) throw new Error(`undeclared mail kind: ${msg && msg.kind}`)
  await refuseStopped(env, msg) // a stopped address: refused before anything is sent (D1: never a silent success)
  return timed(send(env, msg)) // every mailer, the real one when it is wired included, runs under the timeout
}

async function send(env, msg) {
  if (env.MAILER && typeof env.MAILER.send === 'function') return env.MAILER.send(msg) // the rig's seam
  if (env.MAILER === 'log' && env.DEV === '1') {
    console.log(JSON.stringify({ devmail: { to: msg.to, subject: msg.subject, body: msg.body } })) // local development only
    return
  }
  if (env.MAILER === 'ses') return sesSend(env, msg, MAIL_TIMEOUT_MS) // ses.js: aborts its own request when the timeout passes
  throw new Error('no mailer configured')
}

// --- the stop list: addresses SES told us bounce for good or complained ---------

/**
 * Which kinds a stopped address refuses: 'budget' (setup links only) or 'all'.
 * OPEN for security (G10/S2): a stranger's setup requests could provoke a
 * policy bounce marked Permanent on a real mailbox, and no stranger-fillable
 * thing may hold back a 'never' kind. So until that is ruled, only 'budget'
 * kinds refuse; the 'never' kinds still go to SES. Either value fails closed:
 * a refused kind throws, it never reports a send that did not happen.
 */
export const MAIL_STOP_APPLIES = 'budget'
/** Whether a stop refuses `kind` under `applies` (MAIL_STOP_APPLIES unless a row passes another). */
export const stopApplies = (kind, applies = MAIL_STOP_APPLIES) => applies === 'all' || MAIL_KINDS[kind] === 'budget'
/** The Roster object's storage key for its address's stop record: {reason, subtype, at}. No address in it: the object's name is the address's hash. */
export const MAIL_STOP_KEY = 'mailStop'
const STORE = Symbol('mail stop store')

/**
 * The env a Roster object mails with: its own storage rides along under a
 * symbol (no var or secret can be one), so deliver() reads the address's stop
 * record in ONE place for every kind and every call site.
 */
export function mailEnv(env, storage) {
  return Object.create(env, { [STORE]: { value: storage } })
}

async function refuseStopped(env, msg) {
  if (!stopApplies(msg.kind)) return
  const storage = env[STORE]
  if (!storage) {
    // only a Roster object's env can say; a real send without one fails closed
    if (env.MAILER === 'ses') throw new Error('mail stop list not readable here')
    return
  }
  const rec = await storage.get(MAIL_STOP_KEY)
  if (rec) throw Object.assign(new Error(`address stopped (${rec.reason})`), { code: 'suppressed' })
}

/**
 * Record a stop (sns.js, through the Roster object's `mailStop` op). The first
 * record stands: a replayed or repeated event changes nothing.
 */
export async function putMailStop(storage, a, now) {
  if (a.reason !== 'bounce' && a.reason !== 'complaint') return { status: 400, body: { error: 'invalid' } }
  const subtype = typeof a.subtype === 'string' && /^[A-Za-z]{0,32}$/.test(a.subtype) ? a.subtype : ''
  if (await storage.get(MAIL_STOP_KEY)) return { status: 200, body: { stopped: true, first: false } }
  await storage.put(MAIL_STOP_KEY, { reason: a.reason, subtype, at: now })
  return { status: 200, body: { stopped: true, first: true } }
}
