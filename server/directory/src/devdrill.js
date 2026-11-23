// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// LOCAL DEVELOPMENT ONLY: the read-back the incident lever's loopback drill
// needs (lever.mjs --drill, which seeds a victim through the public routes and
// then checks what the lever did to it). A local directory logs its mail
// instead of sending it (mail.js, MAILER=log with DEV=1), so the drill could
// neither finish a setup (the link is in the mail) nor see the incident mail.
//
//   POST /v1/dev/mail { cmd, sig } → 200 { mails: [{ kind, body }] }
//
//   cmd  ldm.<b64url(address)>.<issuedAt>.<nonce>   (its own op: never a lever command)
//   sig  the drill key's signature over cmd (LEVER_PUBKEY verifies it)
//
// Each request is SIGNED by the drill key the drill already holds, and the
// address it reads is inside the signed text. That signature is the gate: a
// caller's address is not, because `wrangler dev` takes `cf-connecting-ip`
// from the request (measured on 4.166: a client that sends the header wins
// over the socket), so on a dev directory bound off loopback anyone could
// claim to be 127.0.0.1. The loopback test stays as a second gate only.
//
// The route answers 404 { error: 'not-found' } with the base headers, as an
// unknown route given a JSON body does, unless ALL of these hold: DEV is '1',
// MAILER is 'log' (so nothing is ever really mailed, and the mails it returns
// were only ever logged), LEVER_PUBKEY is set, cf-connecting-ip is a loopback
// address, and cmd reads, its signature verifies under LEVER_PUBKEY, it is
// fresh (5 minutes) and its nonce is unspent. The worker reads the body first
// (worker.js), so a missing or unreadable body gets the unknown route's 400.
// A deployed directory has MAILER 'ses' and no DEV (wrangler.toml), so the
// route does not exist there.

import { b64uDec, b64uEnc, verifyStatementSig } from '../../../kernel/src/statements.ts'
import { normalize } from './address.js'
import { DEV_MAILS } from './mail.js'

export const DEV_ROUTE = '/v1/dev/mail'
const LOOPBACK_IP = new Set(['127.0.0.1', '::1'])
const SKEW_MS = 5 * 60_000
/** spent nonces → when they may be forgotten (longer than a command stays fresh) */
const SPENT = new Map()

const te = new TextEncoder()
const strict = new TextDecoder('utf-8', { fatal: true })

/** The read-back's text: the address it reads, signed. */
export function buildDevMail({ address, issuedAt, nonce }) {
  return ['ldm', b64uEnc(te.encode(address)), issuedAt, nonce].join('.')
}

/** { address, issuedAt, nonce }, or null. */
export function parseDevMail(text) {
  if (typeof text !== 'string' || text.length > 600) return null
  const f = text.split('.')
  if (f.length !== 4 || f[0] !== 'ldm' || !/^(0|[1-9][0-9]{0,15})$/.test(f[2]) || !/^[A-Za-z0-9_-]{16,64}$/.test(f[3])) return null
  const b = b64uDec(f[1])
  if (!b || b.length === 0) return null
  let address
  try { address = strict.decode(b) } catch { return null }
  if (b64uEnc(te.encode(address)) !== f[1]) return null
  return { address, issuedAt: Number(f[2]), nonce: f[3] }
}

/** Is the dev read-back on for this request at all (before its signature)? */
export function devOn(env, req) {
  return env.DEV === '1' && env.MAILER === 'log' && LOOPBACK_IP.has(req.headers.get('cf-connecting-ip') ?? '')
}

/** POST /v1/dev/mail, given the body the worker read. `json(status, body)` answers with the base headers, as an unknown route. */
export async function devRoute(b, req, env, json) {
  const unknown = () => json(404, { error: 'not-found' })
  if (!devOn(env, req)) return unknown()
  const pub = env.LEVER_PUBKEY
  if (typeof pub !== 'string' || pub.length === 0) return unknown()
  if (typeof b.cmd !== 'string' || typeof b.sig !== 'string') return unknown()
  const c = parseDevMail(b.cmd)
  if (!c) return unknown()
  if (!(await verifyStatementSig(pub, b.sig, b.cmd))) return unknown()
  const now = Date.now()
  if (Math.abs(now - c.issuedAt) > SKEW_MS) return unknown()
  for (const [n, until] of SPENT) if (until < now) SPENT.delete(n)
  if (SPENT.has(c.nonce)) return unknown()
  SPENT.set(c.nonce, now + 3 * SKEW_MS)
  const email = normalize(c.address)
  if (!email) return unknown()
  return json(200, { mails: DEV_MAILS.filter((m) => m.to === email).map((m) => ({ kind: m.kind, body: m.body })) })
}
