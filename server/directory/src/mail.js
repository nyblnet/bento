// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// The one place the directory hands a message to its mailer. Every message is
// fixed wording built by the directory; nothing a caller typed is ever in it.

/** `msg`: { to, subject, body, kind, code? }. Throws when no mailer is configured. */
export async function deliver(env, msg) {
  if (env.MAILER && typeof env.MAILER.send === 'function') return env.MAILER.send(msg) // the rig's seam
  if (env.MAILER === 'log' && env.DEV === '1') {
    console.log(JSON.stringify({ devmail: { to: msg.to, subject: msg.subject, body: msg.body } })) // local development only
    return
  }
  if (env.MAILER === 'ses') throw new Error('SES sending is not wired yet (needs the maintainer\'s SES account, M4)')
  throw new Error('no mailer configured')
}
