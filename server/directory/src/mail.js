// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// The one place the directory hands a message to its mailer. Every message is
// fixed wording built by the directory; nothing a caller typed is ever in it.

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
  reset: 'never', // the reset (not built)
  void: 'never', // the void page's confirmations (not built)
  freeze: 'never', // a freeze (not built)
})

/**
 * The longest the directory waits for its mailer. A send that has not answered
 * by then counts as failed. It must stay well under roster.js's unsentDropMs (10
 * minutes): a change whose notice is still in flight holds the slot, and the
 * caller's post-send write checks the slot is still its own (security's D1a).
 */
export const MAIL_TIMEOUT_MS = 30_000

/** Settles like `p`, or rejects once MAIL_TIMEOUT_MS has passed. */
function timed(p) {
  let timer
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('mailer timed out')), MAIL_TIMEOUT_MS) })
  return Promise.race([Promise.resolve(p), late]).finally(() => clearTimeout(timer))
}

/** `msg`: { to, subject, body, kind }. Throws when no mailer is configured, for an undeclared kind, or when the mailer fails or times out. */
export async function deliver(env, msg) {
  if (!msg || !Object.hasOwn(MAIL_KINDS, msg.kind)) throw new Error(`undeclared mail kind: ${msg && msg.kind}`)
  return timed(send(env, msg)) // every mailer, the real one when it is wired included, runs under the timeout
}

async function send(env, msg) {
  if (env.MAILER && typeof env.MAILER.send === 'function') return env.MAILER.send(msg) // the rig's seam
  if (env.MAILER === 'log' && env.DEV === '1') {
    console.log(JSON.stringify({ devmail: { to: msg.to, subject: msg.subject, body: msg.body } })) // local development only
    return
  }
  if (env.MAILER === 'ses') throw new Error('SES sending is not wired yet (needs the maintainer\'s SES account, M4)')
  throw new Error('no mailer configured')
}
