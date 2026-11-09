// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// The one place the directory hands a message to its mailer. Every message is
// fixed wording built by the directory; nothing a caller typed is ever in it.

/**
 * Every kind of mail the directory sends, and whether a per-address budget may
 * hold it back. Anyone can ask the directory to mail an address (a setup link,
 * a removal code), so those budgets are STRANGER-FILLABLE. A mail that tells
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
  delete: 'budget', // a removal code for an expired binding (worker.js)
  roster: 'never', // a roster change: set up, waiting, in effect
  reset: 'never', // the reset (not built)
  void: 'never', // the void page's confirmations (not built)
  freeze: 'never', // a freeze (not built)
})

/** `msg`: { to, subject, body, kind, code? }. Throws when no mailer is configured, or for an undeclared kind. */
export async function deliver(env, msg) {
  if (!msg || !Object.hasOwn(MAIL_KINDS, msg.kind)) throw new Error(`undeclared mail kind: ${msg && msg.kind}`)
  if (env.MAILER && typeof env.MAILER.send === 'function') return env.MAILER.send(msg) // the rig's seam
  if (env.MAILER === 'log' && env.DEV === '1') {
    console.log(JSON.stringify({ devmail: { to: msg.to, subject: msg.subject, body: msg.body } })) // local development only
    return
  }
  if (env.MAILER === 'ses') throw new Error('SES sending is not wired yet (needs the maintainer\'s SES account, M4)')
  throw new Error('no mailer configured')
}
