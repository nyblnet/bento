// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// Real mail: one Amazon SES v2 SendEmail call per message, signed with AWS
// Signature Version 4 on WebCrypto alone (a Worker has no AWS SDK). mail.js is
// the only caller; every kind the directory sends comes through here when
// MAILER is 'ses'.
//
// What a send's outcome means, and how the caller sees it:
//   - accepted: HTTP 200 with a MessageId. Nothing else counts as sent
//     (security's D1: a change waits only once its notice was accepted).
//   - refused: any other 4xx (MessageRejected, a throttle, a paused account,
//     an unverified sender...), a 2xx without a MessageId, a config that does
//     not read, an address that is not a normalized one. An Error with no
//     `code`: the mail was not sent.
//   - may still arrive: our own timer aborted the request, the connection
//     failed, or SES answered 5xx. AWS cannot say whether it went, so these
//     carry `code: 'timeout'`, the class the callers already treat as "may
//     still arrive" (security's C8 on #952; final pick the maintainer's).
//
// No retries in here: a retry is the caller's decision, under its own rules.
// Nothing here logs. An Error's message names the status and AWS's error TYPE
// only, never the request or response body (the body carries 256-bit setup,
// reset and void tokens; AWS's messages can echo the address), the
// Authorization header, the secret, or the address.

import { normalize } from './address.js'

/**
 * The region becomes part of a hostname, so it is pinned to the shape of a real
 * AWS region name: nothing a mistyped var can turn into another host.
 */
export const SES_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/
const KEY_ID_RE = /^[A-Z0-9]{16,128}$/
const SECRET_RE = /^[\x21-\x7e]{16,128}$/
const CONFIG_SET_RE = /^[A-Za-z0-9_-]{1,64}$/
const ADDR = '[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}'
/** MAIL_FROM: an address, or `Name <address>` with a plain display name. */
const FROM_RE = new RegExp(`^(?:${ADDR}|[A-Za-z0-9 ./_-]{1,64} <${ADDR}>)$`)
export const SES_PATH = '/v2/email/outbound-emails'

const te = new TextEncoder()
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
const sha256hex = async (s) => hex(await crypto.subtle.digest('SHA-256', typeof s === 'string' ? te.encode(s) : s))
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? te.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, te.encode(msg)))
}

/** kSigning = HMAC(HMAC(HMAC(HMAC("AWS4" + secret, date), region), service), "aws4_request"). */
export async function signingKey(secret, date, region, service) {
  const kDate = await hmac(`AWS4${secret}`, date)
  const kRegion = await hmac(kDate, region)
  const kService = await hmac(kRegion, service)
  return hmac(kService, 'aws4_request')
}

/**
 * AWS Signature Version 4 over one request. `headers` are the ones to sign
 * (host included), name → value; `query` is the canonical query string, already
 * encoded and sorted (SES's call has none). Returns the Authorization header and
 * the pieces a test can compare.
 */
export async function sigv4({ method, path, query = '', headers, body, amzDate, region, service, keyId, secret }) {
  const names = Object.keys(headers).map((n) => n.toLowerCase()).sort()
  const lower = Object.fromEntries(Object.entries(headers).map(([n, v]) => [n.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]))
  const signedHeaders = names.join(';')
  const canonicalRequest = [method, path, query, ...names.map((n) => `${n}:${lower[n]}`), '', signedHeaders, await sha256hex(body)].join('\n')
  const date = amzDate.slice(0, 8)
  const scope = `${date}/${region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256hex(canonicalRequest)].join('\n')
  const signature = hex(await hmac(await signingKey(secret, date, region, service), stringToSign))
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    canonicalRequest, stringToSign, signature, signedHeaders,
  }
}

const refused = (why) => new Error(`ses refused: ${why}`)
const mayArrive = (why) => Object.assign(new Error(`ses outcome unknown: ${why}`), { code: 'timeout' })

/**
 * The SES settings, or a refusal naming the FIELD that does not read (never its
 * value). Every one is required: an absent or empty field refuses every send.
 */
export function sesConfig(env) {
  const v = (k) => (typeof env[k] === 'string' ? env[k] : '')
  if (!SES_REGION_RE.test(v('SES_REGION'))) throw refused('config SES_REGION')
  if (!KEY_ID_RE.test(v('SES_ACCESS_KEY_ID'))) throw refused('config SES_ACCESS_KEY_ID')
  if (!SECRET_RE.test(v('SES_SECRET_ACCESS_KEY'))) throw refused('config SES_SECRET_ACCESS_KEY')
  if (!FROM_RE.test(v('MAIL_FROM'))) throw refused('config MAIL_FROM')
  if (!CONFIG_SET_RE.test(v('SES_CONFIGURATION_SET'))) throw refused('config SES_CONFIGURATION_SET')
  return { region: env.SES_REGION, keyId: env.SES_ACCESS_KEY_ID, secret: env.SES_SECRET_ACCESS_KEY, from: env.MAIL_FROM, configSet: env.SES_CONFIGURATION_SET }
}

/**
 * The fetch to AWS. In production the platform's; a rig passes a FUNCTION as
 * env.AWS_FETCH. A wrangler var or secret is always a string, so no deployed
 * config can point the directory anywhere else.
 */
export const awsFetch = (env) => (typeof env.AWS_FETCH === 'function' ? env.AWS_FETCH : fetch)

/** "20261123T090000Z" */
const amzDateOf = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

/** AWS's error type from x-amzn-ErrorType ("MessageRejected:http://..."), letters only, else 'unknown'. */
function errorType(res) {
  const t = (res.headers.get('x-amzn-errortype') || '').split(':')[0]
  return /^[A-Za-z]{1,64}$/.test(t) ? t : 'unknown'
}

/**
 * Send `msg` ({to, subject, body, kind}) through SES. Resolves once SES
 * accepted it; throws otherwise (see the top of this file for the classes).
 * `timeoutMs`: the request is ABORTED when it passes, so a hung connection is
 * not left open behind mail.js's own timer.
 */
export async function sesSend(env, msg, timeoutMs) {
  const c = sesConfig(env)
  // `to` is the directory's own normalized address; anything else (a CR, LF,
  // comma, a display name) would be a second header or a second recipient
  if (typeof msg.to !== 'string' || normalize(msg.to) !== msg.to || /[\r\n,<>\s]/.test(msg.to)) throw refused('recipient')
  if (typeof msg.subject !== 'string' || typeof msg.body !== 'string' || /[\r\n]/.test(msg.subject)) throw refused('content')
  const host = `email.${c.region}.amazonaws.com`
  const body = JSON.stringify({
    FromEmailAddress: c.from,
    Destination: { ToAddresses: [msg.to] },
    Content: { Simple: { Subject: { Data: msg.subject, Charset: 'UTF-8' }, Body: { Text: { Data: msg.body, Charset: 'UTF-8' } } } },
    ConfigurationSetName: c.configSet,
  })
  const amzDate = amzDateOf(Date.now())
  const headers = { 'content-type': 'application/json', host, 'x-amz-date': amzDate }
  const { authorization } = await sigv4({ method: 'POST', path: SES_PATH, headers, body, amzDate, region: c.region, service: 'ses', keyId: c.keyId, secret: c.secret })
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    let res
    try {
      res = await awsFetch(env)(`https://${host}${SES_PATH}`, {
        method: 'POST', body, signal: ac.signal,
        headers: { 'content-type': 'application/json', 'x-amz-date': amzDate, authorization },
      })
    } catch {
      // aborted by our timer, or the connection failed: either way the request may have reached SES
      throw mayArrive(ac.signal.aborted ? 'timed out' : 'connection')
    }
    if (res.status >= 500) throw mayArrive(`${res.status} ${errorType(res)}`)
    if (res.status !== 200) throw refused(`${res.status} ${errorType(res)}`)
    let id
    try { id = JSON.parse(await res.text()).MessageId } catch { if (ac.signal.aborted) throw mayArrive('timed out'); id = null }
    if (typeof id !== 'string' || !id) throw refused('200 without a MessageId')
  } finally {
    clearTimeout(timer)
  }
}
