// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 The Bento authors
//
// POST /v1/mail/events: Amazon SNS delivers SES's bounce and complaint events
// for the directory's configuration set here. A permanent bounce or a
// complaint puts the recipient on the stop list (mail.js), and the kinds the
// stop applies to are then refused, never silently dropped.
//
// Anyone can POST here, so nothing is believed before it is proven, in this
// order, and nothing is written or fetched before the step that allows it:
//   1. the body is at most SNS_BODY_MAX bytes (413 before it is parsed);
//   2. it is JSON, of Type Notification or SubscriptionConfirmation;
//   3. its TopicArn is EXACTLY our topic (SES_EVENTS_TOPIC_ARN). A valid AWS
//      signature proves only that SOME topic sent it: anyone can make a topic
//      in the region and subscribe this URL to it;
//   4. SignatureVersion is '2' (SHA256withRSA; '1' is SHA1);
//   5. SigningCertURL is https://sns.<SES_REGION>.amazonaws.com/
//      SimpleNotificationService-<hex>.pem, exactly (no port, userinfo, query);
//      only then is the certificate fetched (and cached);
//   6. the RSA signature verifies over SNS's canonical string;
//   7. the Timestamp is fresh (SNS_MAX_AGE_MS).
// Then a Notification's SES event is read (configuration-set events only, the
// `eventType` shape), and a SubscriptionConfirmation's SubscribeURL is pinned
// to the same host before it is ever fetched.

import { normalize } from './address.js'
import { SES_REGION_RE, awsFetch } from './ses.js'

export const SNS_PATH = '/v1/mail/events'
export const SNS_BODY_MAX = 64 * 1024
/** How old a message may be (SNS retries for a while; a message older than this is refused, 403 stale). */
export const SNS_MAX_AGE_MS = 60 * 60_000
const SNS_FUTURE_MS = 5 * 60_000
/**
 * What a verified SubscriptionConfirmation does: 'auto' fetches its pinned
 * SubscribeURL; 'log' only logs it for the maintainer to open. OPEN question
 * for the maintainer: either value runs only after every check above.
 */
export const SNS_CONFIRM = 'auto'
const CERT_MAX = 16 * 1024
const CERT_TIMEOUT_MS = 10_000

const te = new TextEncoder()

/** The topic ARN we accept, or null (an absent, empty or malformed one refuses everything). */
function ourTopic(env) {
  const region = typeof env.SES_REGION === 'string' && SES_REGION_RE.test(env.SES_REGION) ? env.SES_REGION : null
  const arn = typeof env.SES_EVENTS_TOPIC_ARN === 'string' ? env.SES_EVENTS_TOPIC_ARN : ''
  if (!region || !new RegExp(`^arn:aws:sns:${region}:\\d{12}:[A-Za-z0-9_-]{1,256}$`).test(arn)) return null
  return { region, arn }
}

/** The pinned certificate URL, or null. */
export function certUrlOk(u, region) {
  if (typeof u !== 'string') return false
  let url
  try { url = new URL(u) } catch { return false }
  const want = `https://sns.${region}.amazonaws.com`
  return url.protocol === 'https:' && url.hostname === `sns.${region}.amazonaws.com` && url.port === '' && url.username === '' && url.password === ''
    && url.search === '' && url.hash === '' && /^\/SimpleNotificationService-[0-9a-f]{16,64}\.pem$/.test(url.pathname) && u === want + url.pathname
}

/** The pinned SubscribeURL: our host, path '/', exactly Action=ConfirmSubscription, our TopicArn and a Token. */
export function subscribeUrlOk(u, region, arn) {
  if (typeof u !== 'string') return false
  let url
  try { url = new URL(u) } catch { return false }
  if (url.protocol !== 'https:' || url.hostname !== `sns.${region}.amazonaws.com` || url.port !== '' || url.username !== '' || url.password !== '' || url.hash !== '' || url.pathname !== '/') return false
  if (!u.startsWith(`https://sns.${region}.amazonaws.com/?`)) return false
  const keys = [...url.searchParams.keys()].sort()
  return JSON.stringify(keys) === '["Action","Token","TopicArn"]' && url.searchParams.get('Action') === 'ConfirmSubscription'
    && url.searchParams.get('TopicArn') === arn && /^[A-Za-z0-9]{1,1024}$/.test(url.searchParams.get('Token'))
}

/** SNS's string to sign: each present field as "Name\nvalue\n", in this order. */
export function canonical(m) {
  const fields = m.Type === 'Notification'
    ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type']
  let out = ''
  for (const f of fields) {
    if (f === 'Subject' && m.Subject === undefined) continue
    out += `${f}\n${m[f]}\n`
  }
  return out
}

// --- the certificate: PEM → DER → the SubjectPublicKeyInfo, by a minimal walk ---

function tlv(d, i) {
  const tag = d[i]
  let len = d[i + 1], hdr = 2
  if (len & 0x80) {
    const n = len & 0x7f
    if (n < 1 || n > 3) throw new Error('der length')
    len = 0
    for (let k = 0; k < n; k++) len = len * 256 + d[i + 2 + k]
    hdr = 2 + n
  }
  if (i + hdr + len > d.length) throw new Error('der overrun')
  return { tag, start: i, body: i + hdr, end: i + hdr + len }
}
/** The SPKI bytes of an X.509 certificate: Certificate → tbsCertificate → [version], serial, sigAlg, issuer, validity, subject, SPKI. */
export function spkiOf(der) {
  const cert = tlv(der, 0)
  if (cert.tag !== 0x30) throw new Error('not a certificate')
  const tbs = tlv(der, cert.body)
  if (tbs.tag !== 0x30) throw new Error('no tbsCertificate')
  let i = tbs.body
  let e = tlv(der, i)
  if (e.tag === 0xa0) { i = e.end; e = tlv(der, i) } // version
  for (const want of [0x02, 0x30, 0x30, 0x30, 0x30]) { // serial, signature, issuer, validity, subject
    if (e.tag !== want) throw new Error('certificate layout')
    i = e.end; e = tlv(der, i)
  }
  if (e.tag !== 0x30) throw new Error('no subjectPublicKeyInfo')
  return der.slice(e.start, e.end)
}
function pemToDer(pem) {
  const m = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/.exec(pem)
  if (!m) throw new Error('not a PEM certificate')
  return Uint8Array.from(atob(m[1].replace(/\s+/g, '')), (c) => c.charCodeAt(0))
}

const certCache = new Map()
async function certKey(env, url) {
  if (certCache.has(url)) return certCache.get(url)
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), CERT_TIMEOUT_MS)
  let pem
  try {
    const r = await awsFetch(env)(url, { method: 'GET', signal: ac.signal })
    if (r.status !== 200) return null
    pem = await r.text()
  } catch { return null } finally { clearTimeout(t) }
  if (pem.length > CERT_MAX) return null
  let key
  try {
    key = await crypto.subtle.importKey('spki', spkiOf(pemToDer(pem)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  } catch { return null }
  if (certCache.size >= 8) certCache.delete(certCache.keys().next().value)
  certCache.set(url, key)
  return key
}

/** The body, or null once it passes `max` bytes (read no further). */
async function capped(req, max) {
  const n = Number(req.headers.get('content-length'))
  if (Number.isFinite(n) && n > max) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const parts = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > max) { try { await reader.cancel() } catch { /* */ } return null }
    parts.push(value)
  }
  const all = new Uint8Array(total)
  let o = 0
  for (const p of parts) { all.set(p, o); o += p.length }
  return new TextDecoder().decode(all)
}

/**
 * The stops an SES event asks for: [] to ignore it, null when it does not read
 * (nothing is written then). A Permanent bounce stops each bounced recipient,
 * a complaint each complaining one; a Transient or Undetermined bounce stops
 * nobody; Send, Delivery, Reject, DeliveryDelay and the rest are ignored.
 */
export function stopsOf(event) {
  if (!event || typeof event !== 'object' || typeof event.eventType !== 'string') return null
  const list = (arr) => {
    if (!Array.isArray(arr) || arr.length < 1 || arr.length > 50) return null
    const out = []
    for (const r of arr) {
      const a = r && typeof r.emailAddress === 'string' ? normalize(r.emailAddress.trim()) : null
      if (!a) return null
      out.push(a)
    }
    return out
  }
  if (event.eventType === 'Bounce') {
    const b = event.bounce
    if (!b || typeof b.bounceType !== 'string') return null
    const who = list(b.bouncedRecipients)
    if (!who) return null
    if (b.bounceType !== 'Permanent') return []
    return who.map((address) => ({ address, reason: 'bounce', subtype: typeof b.bounceSubType === 'string' ? b.bounceSubType : '' }))
  }
  if (event.eventType === 'Complaint') {
    const c = event.complaint
    const who = list(c && c.complainedRecipients)
    if (!who) return null
    return who.map((address) => ({ address, reason: 'complaint', subtype: typeof c.complaintFeedbackType === 'string' ? c.complaintFeedbackType : '' }))
  }
  return []
}

/**
 * The route. `k.json(status, body)` answers with the directory's headers;
 * `k.stop(address, {reason, subtype})` records a stop in that address's object.
 */
export async function snsRoute(req, env, k) {
  if (req.method !== 'POST') return k.json(405, { error: 'method' })
  const text = await capped(req, SNS_BODY_MAX)
  if (text === null) return k.json(413, { error: 'too-large' })
  let m
  try { m = JSON.parse(text) } catch { return k.json(400, { error: 'bad-request' }) }
  if (!m || typeof m !== 'object' || (m.Type !== 'Notification' && m.Type !== 'SubscriptionConfirmation')) return k.json(400, { error: 'bad-request' })
  for (const f of ['Message', 'MessageId', 'Timestamp', 'TopicArn', 'Signature', 'SigningCertURL', 'SignatureVersion']) {
    if (typeof m[f] !== 'string') return k.json(400, { error: 'bad-request' })
  }
  if (m.Subject !== undefined && typeof m.Subject !== 'string') return k.json(400, { error: 'bad-request' })
  if (m.Type === 'SubscriptionConfirmation' && (typeof m.SubscribeURL !== 'string' || typeof m.Token !== 'string')) return k.json(400, { error: 'bad-request' })
  const topic = ourTopic(env)
  if (!topic) return k.json(503, { error: 'config' })
  if (m.TopicArn !== topic.arn) return k.json(403, { error: 'topic' })
  if (m.SignatureVersion !== '2') return k.json(403, { error: 'signature' })
  if (!certUrlOk(m.SigningCertURL, topic.region)) return k.json(403, { error: 'cert-url' })
  const key = await certKey(env, m.SigningCertURL)
  if (!key) return k.json(503, { error: 'cert' })
  let sig
  try { sig = Uint8Array.from(atob(m.Signature), (c) => c.charCodeAt(0)) } catch { return k.json(403, { error: 'signature' }) }
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, te.encode(canonical(m))))) return k.json(403, { error: 'signature' })
  const at = Date.parse(m.Timestamp)
  const now = Date.now()
  if (!Number.isFinite(at) || now - at > SNS_MAX_AGE_MS || at - now > SNS_FUTURE_MS) return k.json(403, { error: 'stale' })

  if (m.Type === 'SubscriptionConfirmation') {
    if (!subscribeUrlOk(m.SubscribeURL, topic.region, topic.arn)) return k.json(403, { error: 'subscribe-url' })
    if (SNS_CONFIRM !== 'auto') {
      console.log(`sns: subscription to our topic waits for confirmation: ${m.SubscribeURL}`)
      return k.json(200, { confirmed: false })
    }
    let r
    try { r = await awsFetch(env)(m.SubscribeURL, { method: 'GET' }) } catch { return k.json(502, { error: 'confirm' }) }
    return r.status === 200 ? k.json(200, { confirmed: true }) : k.json(502, { error: 'confirm' })
  }

  let event
  try { event = JSON.parse(m.Message) } catch { return k.json(400, { error: 'bad-event' }) }
  const stops = stopsOf(event)
  if (stops === null) return k.json(400, { error: 'bad-event' })
  for (const s of stops) await k.stop(s.address, { reason: s.reason, subtype: s.subtype })
  return k.json(200, { stopped: stops.length })
}
