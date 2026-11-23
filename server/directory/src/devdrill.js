// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// LOCAL DEVELOPMENT ONLY: the read-back the incident lever's loopback drill
// needs (lever.mjs --drill, which seeds a victim through the public routes and
// then checks what the lever did to it). A local directory logs its mail
// instead of sending it (mail.js, MAILER=log with DEV=1), so the drill could
// neither finish a setup (the link is in the mail) nor see the incident mail.
//
//   POST /v1/dev/mail { email } → 200 { mails: [{ kind, body }] }
//
// It answers exactly as an unknown route does (404, the base headers) unless
// ALL of these hold: DEV is '1', MAILER is 'log' (so nothing is ever really
// mailed, and the mails it returns were only ever logged), and the caller is
// on this machine (cf-connecting-ip is a loopback address). The request's URL
// cannot be the test: `wrangler dev` rewrites its host to the route's
// (id.bento.page), measured. A deployed directory has MAILER 'ses' and no DEV
// (wrangler.toml), so the route does not exist there.

import { normalize } from './address.js'
import { DEV_MAILS } from './mail.js'

export const DEV_ROUTE = '/v1/dev/mail'
const LOOPBACK_IP = new Set(['127.0.0.1', '::1'])

/** Is the dev read-back on for this request? */
export function devOn(env, req) {
  return env.DEV === '1' && env.MAILER === 'log' && LOOPBACK_IP.has(req.headers.get('cf-connecting-ip') ?? '')
}

/** POST /v1/dev/mail. `json(status, body)` answers with the base headers, as an unknown route. */
export async function devRoute(req, env, json) {
  if (!devOn(env, req)) return json(404, { error: 'not-found' })
  let b = null
  try { b = await req.json() } catch { /* refused below */ }
  const email = normalize((b && typeof b.email === 'string' && b.email) || '')
  if (!email) return json(400, { error: 'bad-address' })
  return json(200, { mails: DEV_MAILS.filter((m) => m.to === email).map((m) => ({ kind: m.kind, body: m.body })) })
}
