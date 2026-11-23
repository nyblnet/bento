#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/id directory: real mail through Amazon SES, and SES's bounce and
// complaint events through Amazon SNS (server/directory/src/ses.js, sns.js,
// mail.js). No AWS account, credential or network is used: AWS is a FAKE
// reached through the directory's function-typed seam (env.AWS_FETCH), which
//   · re-derives every request's Signature Version 4 with node:crypto (its own
//     code, never ses.js's) and refuses one that does not verify;
//   · serves a TEST signing certificate (a key made for the run, in a real
//     self-signed certificate) at SNS-shaped URLs, and records every fetch.
// The signer is also held to AWS's own published examples
// (fixtures/sigv4-aws-vectors.json), so signer and fake cannot share a mistake.
//
//   node scripts/test-directory-ses.ts        (Node >= 23.6 strips types natively)
//
// What it must prove:
//   R1  the signer reproduces AWS's example signing key and signatures;
//   R2  a send is one POST to email.<region>.amazonaws.com/v2/email/outbound-emails,
//       signed over its body, content-type, host and date, carrying MAIL_FROM,
//       the one recipient, the configuration set, text only;
//   R3  every mail kind, and every real route that mails, goes through SES;
//   R4  accepted means 200 with a MessageId, nothing else;
//   R5  a refusal (400) has no code; a hung request is aborted at the mail
//       timeout and is a 'timeout' (it may still arrive);
//   R6  a 5xx or a broken connection is never a plain refusal ('timeout' class);
//   R7  a 429 is a refusal and is not retried;
//   R8  each setting, ABSENT or malformed, refuses every send before any request;
//   R9  no secret, signature, token or address reaches a log;
//   R10 D1 under SES: a refused or hung notice leaves no change waiting;
//   R11 an SNS event is believed only with a valid SignatureVersion 2 signature;
//   R12 the topic is pinned exactly;
//   R13 the certificate URL is pinned before anything is fetched;
//   R14 a Permanent bounce or a complaint stops the (normalized) address; a
//       Transient bounce and other events stop nobody; garbage writes nothing;
//   R15 a stop is a refusal, never a silent success; setup/start's answer is
//       unchanged and its link withdrawn; 'never' kinds per MAIL_STOP_APPLIES;
//   R16 the stop record holds no address;
//   R17 a SubscriptionConfirmation is confirmed only for our topic and host;
//   R18 the route caps its body, answers 405 to other methods, and carries the
//       directory's headers.

import worker, { Roster, Ledger } from '../server/directory/src/worker.js'
import { addressKey } from '../server/directory/src/address.js'
import { MAIL_KINDS, MAIL_TIMEOUT_MS, MAIL_STOP_APPLIES, MAIL_STOP_KEY, deliver, mailEnv, stopApplies } from '../server/directory/src/mail.js'
import { SES_PATH, sesConfig, signingKey, sigv4 } from '../server/directory/src/ses.js'
import { SNS_BODY_MAX, SNS_CONFIRM, SNS_MAX_AGE_MS, SNS_PATH, spkiOf } from '../server/directory/src/sns.js'
import { parseResetLink, parseSetupLink, parseVoidLink } from '../server/directory/src/links.js'
import { b64uDec, b64uEnc, sha256b64u } from '../kernel/src/statements.ts'
import { buildRos, parseRos } from '../kernel/src/roster.ts'
import { createHash, createHmac, createSign, generateKeyPairSync, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0, passes = 0
// the rig's own lines go straight to stdout: console.* is captured below (R9 scans it)
const say = (s: string) => process.stdout.write(s + '\n')
const ok = (c: unknown, n: string) => { if (c) { passes++; if (process.env.ROWS) say('ok   ' + n) } else { fails++; say('FAIL ' + n) } }

// ---------- clock ----------
let now = Date.parse('2026-11-23T09:00:00Z')
Date.now = () => now
const MIN = 60_000, HOUR = 60 * MIN

// ---------- the mail timer, held by hand ----------
// Only timers of exactly MAIL_TIMEOUT_MS are held (mail.js's race and ses.js's
// abort); every other timer is real.
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout
const held = new Map<number, () => void>()
let heldId = 1e9
globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
  if (ms === MAIL_TIMEOUT_MS) { const id = ++heldId; held.set(id, fn); return id }
  return realSetTimeout(fn, ms, ...rest)
}) as never
globalThis.clearTimeout = ((id: unknown) => { if (typeof id === 'number' && held.has(id)) held.delete(id); else realClearTimeout(id as never) }) as never
/** Fire every held mail timer: the mail timeout passes. */
function timeoutPasses() { const fns = [...held.values()]; held.clear(); for (const f of fns) f(); return fns.length }
const tick = () => new Promise((r) => realSetTimeout(r, 0))

// ---------- logs ----------
const logs: string[] = []
for (const k of ['log', 'warn', 'error', 'info'] as const) {
  const orig = console[k].bind(console)
  console[k] = (...a: unknown[]) => { logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); if (process.env.LOGS) orig(...a) }
}

// ---------- in-memory Durable Objects, with the input gate ----------
class Gate {
  busy = false; q: (() => void)[] = []
  async enter() { if (!this.busy) { this.busy = true; return } await new Promise<void>((r) => this.q.push(r)) }
  leave() { const n = this.q.shift(); if (n) n(); else this.busy = false }
}
const inObject = new AsyncLocalStorage<Gate>()
async function outgoing<T>(f: () => T | Promise<T>): Promise<T> {
  const g = inObject.getStore()
  if (!g) return f()
  g.leave()
  try { return await f() } finally { await g.enter() }
}
async function gated<T>(g: Gate, f: () => Promise<T>): Promise<T> {
  await g.enter()
  try { return await inObject.run(g, f) } finally { g.leave() }
}
type Obj = { fetch(r: Request): Promise<Response>; alarm?(): Promise<void> }
function namespace(Klass: new (state: unknown, env: unknown) => Obj) {
  const objs = new Map<string, { obj: Obj; store: Map<string, unknown>; alarm: number | null }>()
  return {
    objs,
    idFromName: (n: string) => n,
    get(id: string) {
      if (!objs.has(id)) {
        const store = new Map<string, unknown>()
        const rec = { obj: null as unknown as Obj, store, alarm: null as number | null }
        const gate = new Gate()
        const state = {
          storage: {
            async get(k: string) { return structuredClone(store.get(k)) },
            async put(k: string, v: unknown) { store.set(k, structuredClone(v)) },
            async delete(k: string | string[]) { for (const x of [].concat(k as never)) store.delete(x) },
            async list(o?: { prefix?: string; limit?: number }) {
              const all = [...store].filter(([k]) => !o?.prefix || k.startsWith(o.prefix)).sort(([a], [b]) => (a < b ? -1 : 1))
              return new Map(all.slice(0, o?.limit ?? all.length).map(([k, v]) => [k, structuredClone(v)]))
            },
            async setAlarm(t: number) { rec.alarm = t },
            async getAlarm() { return rec.alarm },
            async deleteAlarm() { rec.alarm = null },
          },
        }
        const inner = new Klass(state, env)
        rec.obj = {
          fetch: (r: Request) => gated(gate, () => inner.fetch(r)),
          alarm: inner.alarm ? () => gated(gate, () => inner.alarm!()) : undefined,
        }
        objs.set(id, rec)
      }
      const { obj } = objs.get(id)!
      return { fetch: (u: string | Request, init?: RequestInit) => obj.fetch(u instanceof Request ? u : new Request(u, init)) }
    },
  }
}

// ---------- the fake AWS ----------
const REGION = 'eu-west-1'
const KEY_ID = 'AKIARIGTESTONLY00001'
const SECRET = 'rig/test+secret/NOT-a-real-AWS-key/0123456'
const TOPIC = `arn:aws:sns:${REGION}:123456789012:bento-id-ses-events`
const SES_URL = `https://email.${REGION}.amazonaws.com${SES_PATH}`
type SesReq = { url: string; method: string; headers: Record<string, string>; body: string; sig: string; aborted: boolean; json: Record<string, unknown> | null }
const sesReqs: SesReq[] = []
const otherFetches: { url: string; method: string }[] = []
type Mode = { status: number; type?: string; body?: string } | 'hang' | 'network' | 'ok'
let mode: Mode = 'ok'
let fakeLog: string[] = []

const hmacN = (k: Buffer | string, m: string) => createHmac('sha256', k).update(m).digest()
const shaN = (s: string) => createHash('sha256').update(s).digest('hex')
/** The fake's own SigV4 check: '' when the request verifies, else why not. */
function verifySig(url: string, method: string, headers: Record<string, string>, body: string): string {
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(headers.authorization ?? '')
  if (!m) return 'authorization header shape'
  const [, kid, date, region, service, signed, sig] = m
  if (kid !== KEY_ID) return 'key id'
  if (region !== REGION || service !== 'ses') return 'scope'
  const amz = headers['x-amz-date'] ?? ''
  if (!/^\d{8}T\d{6}Z$/.test(amz) || amz.slice(0, 8) !== date) return 'date'
  const t = Date.parse(`${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`)
  if (Math.abs(t - now) > 5 * MIN) return 'stale date'
  const names = signed.split(';')
  for (const need of ['content-type', 'host', 'x-amz-date']) if (!names.includes(need)) return `${need} not signed`
  const u = new URL(url)
  const hv = (n: string) => (n === 'host' ? u.host : headers[n])
  if (names.some((n) => hv(n) === undefined)) return 'a signed header is missing'
  const cr = [method, u.pathname, u.search.slice(1), ...names.map((n) => `${n}:${hv(n)!.trim()}`), '', signed, shaN(body)].join('\n')
  const sts = ['AWS4-HMAC-SHA256', amz, `${date}/${region}/${service}/aws4_request`, shaN(cr)].join('\n')
  const kSig = hmacN(hmacN(hmacN(hmacN('AWS4' + SECRET, date), region), service), 'aws4_request')
  return hmacN(kSig, sts).toString('hex') === sig ? '' : 'signature'
}

// The SNS signing certificate: a TEST key made fresh for this run, in a real
// self-signed X.509 certificate built here (the repo never holds a key file).
// node's X509Certificate must parse it, so the directory's DER walk is fed a
// genuine certificate shape (version, serial, issuer, validity, extensions).
const { privateKey: CERT_KEY, publicKey: CERT_PUB } = generateKeyPairSync('rsa', { modulusLength: 2048 })
function der(tag: number, ...parts: Buffer[]) {
  const body = Buffer.concat(parts)
  const n = body.length
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255])
  return Buffer.concat([Buffer.from([tag]), len, body])
}
const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'))
const SHA256_RSA = der(0x30, oid('2a864886f70d01010b'), Buffer.from([0x05, 0x00]))
const NAME = der(0x30, der(0x31, der(0x30, oid('550403'), der(0x0c, Buffer.from('bento rig SNS TEST certificate, not AWS')))))
const TBS = der(0x30, der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([0x01, 0x23, 0x45])), SHA256_RSA, NAME,
  der(0x30, der(0x17, Buffer.from('260101000000Z')), der(0x18, Buffer.from('21260101000000Z'))), NAME,
  CERT_PUB.export({ type: 'spki', format: 'der' }) as Buffer,
  der(0xa3, der(0x30, der(0x30, oid('551d13'), der(0x04, der(0x30))))))
const CERT_DER = der(0x30, TBS, SHA256_RSA, der(0x03, Buffer.from([0]), createSign('RSA-SHA256').update(TBS).sign(CERT_KEY)))
const CERT_PEM = `-----BEGIN CERTIFICATE-----\n${CERT_DER.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd()}\n-----END CERTIFICATE-----\n`
const certHits: string[] = []
const subscribeHits: string[] = []

async function fakeAws(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input)
  const method = (init.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v
  const u = new URL(url)
  if (u.hostname === `email.${REGION}.amazonaws.com` || u.hostname.startsWith('email.')) {
    const body = typeof init.body === 'string' ? init.body : ''
    let json: Record<string, unknown> | null = null
    try { json = JSON.parse(body) } catch { /* */ }
    const r: SesReq = { url, method, headers, body, sig: verifySig(url, method, headers, body), aborted: false, json }
    sesReqs.push(r)
    const signal = init.signal as AbortSignal | undefined
    const m = mode
    if (m === 'hang') {
      return new Promise((_, reject) => {
        if (signal?.aborted) { r.aborted = true; reject(new DOMException('aborted', 'AbortError')); return }
        signal?.addEventListener('abort', () => { r.aborted = true; reject(new DOMException('aborted', 'AbortError')) })
      })
    }
    if (m === 'network') throw new TypeError('network connection lost')
    if (r.sig) return new Response(JSON.stringify({ message: `signature: ${r.sig}` }), { status: 403, headers: { 'x-amzn-errortype': 'SignatureDoesNotMatch:http://internal.amazon.com/coral/com.amazon.coral.service/' } })
    if (m === 'ok') return new Response(JSON.stringify({ MessageId: `0102019a-${sesReqs.length}-rig` }), { status: 200 })
    if (m.status === 204) return new Response(null, { status: 204 })
    return new Response(m.body ?? JSON.stringify({ message: `Email address is not verified: ${json && (json.Destination as { ToAddresses: string[] }).ToAddresses[0]}` }),
      { status: m.status, headers: m.type ? { 'x-amzn-errortype': `${m.type}:http://internal.amazon.com/coral/com.amazonaws.sesv2/` } : {} })
  }
  if (u.hostname.startsWith('sns.') && u.pathname.endsWith('.pem')) {
    certHits.push(url)
    return new Response(CERT_PEM, { status: 200 })
  }
  if (u.hostname.startsWith('sns.')) {
    subscribeHits.push(url)
    return new Response('<ConfirmSubscriptionResponse/>', { status: 200 })
  }
  otherFetches.push({ url, method })
  return new Response('no', { status: 404 })
}

// ---------- env ----------
const SES_ENV = {
  MAILER: 'ses', SES_REGION: REGION, SES_ACCESS_KEY_ID: KEY_ID, SES_SECRET_ACCESS_KEY: SECRET,
  MAIL_FROM: 'bento/id <no-reply@mail.example.org>', SES_CONFIGURATION_SET: 'bento-id-rig', SES_EVENTS_TOPIC_ARN: TOPIC,
}
const dirKp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
const env: Record<string, unknown> = {
  DIR_KID: 'dir-1', CHALLENGE_KEY: 'k'.repeat(48), DIR_KEY_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', dirKp.privateKey)),
  ...SES_ENV,
  AWS_FETCH: (i: string, init?: RequestInit) => outgoing(() => fakeAws(i, init)),
}
const ROSTER = namespace(Roster as never)
env.ROSTER = ROSTER
env.LEDGER = namespace(Ledger as never)

let ipN = 0
const freshIp = () => `10.9.${Math.floor(++ipN / 250)}.${ipN % 250}`
const S = 'https://signin.id.bento.page'
async function api(method: string, path: string, body?: unknown, o: { raw?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'cf-connecting-ip': freshIp(), origin: S, ...(o.headers ?? {}) }
  const r = await worker.fetch(new Request('https://id.bento.page' + path, {
    method, body: o.raw ?? (body === undefined ? undefined : JSON.stringify(body)), headers,
  }), env as never)
  const text = await r.text()
  let j: Record<string, unknown> = {}
  try { j = JSON.parse(text) } catch { /* */ }
  return { status: r.status, j, h: r.headers, text }
}
async function storeOf(email: string) {
  const id = await addressKey(email)
  ROSTER.get(id)
  return ROSTER.objs.get(id)!.store
}
/** The mails SES received, as the person would read them. */
const sent = () => sesReqs.filter((r) => !r.sig && r.json).map((r) => {
  const j = r.json as { Destination: { ToAddresses: string[] }; Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } } } }
  return { to: j.Destination.ToAddresses[0], subject: j.Content.Simple.Subject.Data, body: j.Content.Simple.Body.Text.Data }
})
const linksIn = (body: string) => body.match(/https?:\/\/\S+/g) ?? []

// ---------- a software authenticator (as in test-directory-roster.ts) ----------
const te = new TextEncoder()
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length } return o }
function rawToDer(raw: Uint8Array) {
  const int = (b: Uint8Array) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; let v = b.slice(i); if (v[0] & 0x80) v = cat(new Uint8Array([0]), v); return cat(new Uint8Array([2, v.length]), v) }
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)))
  return cat(new Uint8Array([0x30, body.length]), body)
}
class Authn {
  pub = ''; credId = new Uint8Array(32); count = 0; kp!: CryptoKeyPair
  static async make() {
    const a = new Authn()
    a.kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
    a.pub = b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', a.kp.publicKey)))
    crypto.getRandomValues(a.credId)
    return a
  }
  get cid() { return b64uEnc(this.credId) }
  async register(challenge: Uint8Array) {
    const raw = b64uDec(this.pub)!
    const cose = cat(new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), raw.slice(1, 33), new Uint8Array([0x22, 0x58, 0x20]), raw.slice(33))
    const att = cat(new Uint8Array(16), new Uint8Array([0, this.credId.length]), this.credId, cose)
    const ad = cat(await sha256(te.encode('id.bento.page')), new Uint8Array([0x45]), new Uint8Array([0, 0, 0, 0]), att)
    const cd = { type: 'webauthn.create', challenge: b64uEnc(challenge), origin: S, crossOrigin: false }
    return { clientDataJSON: b64uEnc(te.encode(JSON.stringify(cd))), authenticatorData: b64uEnc(ad) }
  }
  async assert(text: string) {
    const c = ++this.count
    const ad = cat(await sha256(te.encode('id.bento.page')), new Uint8Array([0x05, (c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255, c & 255]))
    const cdj = te.encode(JSON.stringify({ type: 'webauthn.get', challenge: b64uEnc(await sha256(te.encode(text))), origin: S, crossOrigin: false }))
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.kp.privateKey, cat(ad, await sha256(cdj)) as BufferSource))
    return { authenticatorData: b64uEnc(ad), clientDataJSON: b64uEnc(cdj), signature: b64uEnc(rawToDer(sig)) }
  }
}
async function challenge(email: string) { return (await api('POST', '/v1/roster/challenge', { email })).j.challenge as string }
/** setup/start through the route, then setup with the mailed token: an account with one passkey. */
async function account(email: string) {
  const n = sesReqs.length
  await api('POST', '/v1/roster/setup/start', { email })
  const m = sent().slice(0).filter((x) => x.to === email && x.subject === 'Set up your bento/id account').pop()
  const l = m ? parseSetupLink(linksIn(m.body)[0]) : null
  const a = await Authn.make()
  const ch = await challenge(email)
  const r = await api('POST', '/v1/roster/setup', { email, token: l?.token, dirNonce: ch, reg: await a.register(b64uDec(ch)!) })
  return { a, ok: r.status === 200 && sesReqs.length > n, r }
}
async function current(email: string) {
  const h = await api('GET', `/v1/roster?e=${encodeURIComponent(email)}`)
  const p = typeof h.j.ros === 'string' ? await parseRos(h.j.ros) : { ok: false as const }
  return { text: h.j.ros as string, head: p.ok ? p.value : null, pending: h.j.pending as Record<string, unknown> | null }
}
/** A member adds a new passkey: the change waits, and its notice must be accepted first. */
async function requestAdd(email: string, signer: Authn) {
  const c = await current(email)
  if (!c.head) return { status: -1, j: { error: 'no-head' } as Record<string, unknown>, h: new Headers(), text: '' } // null-safe: a mutant may leave no account
  const add = await Authn.make()
  const ch = await challenge(email)
  const members = [...c.head.members, { kind: 'pk', pub: add.pub, quarantined: false }]
  const ros = buildRos({ address: email, seq: c.head.seq + 1, prev: await sha256b64u(c.text), members: members as never, dirNonce: ch, created: now })
  const assertion = await signer.assert(ros)
  return api('POST', '/v1/roster/request', { email, ros, credId: signer.cid, assertion, reg: await add.register(b64uDec(ch)!) })
}
async function settle<T>(p: Promise<T>, until: () => boolean): Promise<T> {
  for (let i = 0; i < 400 && !until(); i++) await tick()
  return p
}

// =====================================================================
// R1. the signer against AWS's published examples
// =====================================================================
{
  const V = JSON.parse(readFileSync(join(root, 'server/directory/fixtures/sigv4-aws-vectors.json'), 'utf8'))
  ok(V.keyId === 'AKIDEXAMPLE' && V.requests.length >= 3, 'R1 the AWS example vectors are loaded (public EXAMPLE credentials)')
  for (const k of V.signingKeys) {
    const got = Buffer.from(await signingKey(V.secret, k.date, k.region, k.service)).toString('hex')
    ok(got === k.hex, `R1 signing key: ${k.name} (${got.slice(0, 12)}...)`)
  }
  for (const r of V.requests) {
    const s = await sigv4({ method: r.method, path: r.path, query: r.query, headers: r.headers, body: r.body, amzDate: r.amzDate, region: r.region, service: r.service, keyId: V.keyId, secret: V.secret })
    ok(s.signature === r.signature, `R1 signature: ${r.name}`)
    ok(s.authorization === `AWS4-HMAC-SHA256 Credential=${V.keyId}/${r.amzDate.slice(0, 8)}/${r.region}/${r.service}/aws4_request, SignedHeaders=${Object.keys(r.headers).sort().join(';')}, Signature=${r.signature}`, `R1 Authorization header: ${r.name}`)
    if (r.canonicalRequestSha256) ok(shaN(s.canonicalRequest) === r.canonicalRequestSha256, `R1 canonical request hash: ${r.name}`)
  }
}

// =====================================================================
// R2, R3 (kinds), R4. one signed SendEmail per message, every kind
// =====================================================================
const noStop = new Map<string, unknown>()
const stopStore = { async get(k: string) { return noStop.get(k) } }
const menv = () => mailEnv(env, stopStore)
async function send(msg: Record<string, unknown>, e: Record<string, unknown> = menv()): Promise<{ ok: boolean; e?: Error & { code?: string } }> {
  try { await deliver(e as never, msg as never); return { ok: true } } catch (err) { return { ok: false, e: err as Error & { code?: string } } }
}
{
  const kinds = Object.keys(MAIL_KINDS)
  ok(kinds.length >= 5, `R3 every declared kind is exercised (${kinds.join(', ')})`)
  for (const kind of kinds) {
    const n = sesReqs.length
    const to = `kind-${kind}@example.com`
    const r = await send({ to, subject: `Subject for ${kind}`, body: `Body for ${kind}\nhttps://signin.id.bento.page/setup#t=x`, kind })
    const q = sesReqs.slice(n)
    const j = q[0]?.json as Record<string, any> | null
    ok(r.ok && q.length === 1, `R3 kind '${kind}': one request to SES, accepted (${q.length} requests, ${r.e?.message ?? 'ok'})`)
    ok(q[0]?.url === SES_URL && q[0]?.method === 'POST', `R2 kind '${kind}': POST ${SES_URL}`)
    ok(q[0] && q[0].sig === '', `R2 kind '${kind}': the fake re-derives the SigV4 signature (${q[0]?.sig || 'verified'})`)
    ok(j?.FromEmailAddress === SES_ENV.MAIL_FROM && JSON.stringify(j?.Destination) === JSON.stringify({ ToAddresses: [to] }) && j?.ConfigurationSetName === SES_ENV.SES_CONFIGURATION_SET,
      `R2 kind '${kind}': MAIL_FROM, exactly the one recipient, the configuration set`)
    ok(j?.Content?.Simple?.Subject?.Data === `Subject for ${kind}` && j?.Content?.Simple?.Body?.Text?.Data?.startsWith(`Body for ${kind}`) && j?.Content?.Simple?.Body?.Html === undefined
      && j?.Content?.Raw === undefined && j?.Content?.Simple?.Subject?.Charset === 'UTF-8', `R2 kind '${kind}': text only, UTF-8, simple content (no raw MIME, no HTML)`)
  }
  const hdr = sesReqs[sesReqs.length - 1]?.headers ?? {}
  ok(/SignedHeaders=content-type;host;x-amz-date,/.test(hdr.authorization ?? ''), 'R2 the signed headers are exactly content-type;host;x-amz-date')
  ok(hdr['content-type'] === 'application/json' && hdr.host === undefined, 'R2 the request sends content-type itself and leaves host to the platform')
  // the fake's own check is not vacuous: a body changed after signing fails it
  {
    const last = sesReqs[sesReqs.length - 1]
    ok(verifySig(last.url, last.method, last.headers, last.body) === '' && verifySig(last.url, last.method, last.headers, last.body + ' ') === 'signature',
      'R2 control: the fake verifies the real request and refuses the same request with its body changed')
    ok(verifySig(last.url, last.method, { ...last.headers, 'content-type': 'text/plain' }, last.body) === 'signature', 'R2 control: the fake refuses a changed signed header')
  }
  // R4: accepted only on 200 with a MessageId
  for (const [m, name] of [[{ status: 200, body: '{}' }, '200 without a MessageId'], [{ status: 200, body: '{"MessageId":""}' }, '200 with an empty MessageId'],
    [{ status: 202, body: '{"MessageId":"x"}' }, '202 with a MessageId'], [{ status: 204, body: '' }, '204']] as const) {
    mode = m
    const r = await send({ to: 'r4@example.com', subject: 's', body: 'b', kind: 'roster' })
    ok(!r.ok && r.e?.code === undefined, `R4 ${name}: a refusal (no code), never accepted (${r.ok ? 'accepted' : r.e?.message})`)
  }
  mode = 'ok'
  ok((await send({ to: 'r4@example.com', subject: 's', body: 'b', kind: 'roster' })).ok, 'R4 control: 200 with a MessageId is accepted')
}

// =====================================================================
// R5, R6, R7. what an outcome means
// =====================================================================
{
  for (const [status, type] of [[400, 'MessageRejected'], [400, 'BadRequestException'], [403, 'AccountSuspendedException'], [400, 'SendingPausedException'],
    [400, 'MailFromDomainNotVerifiedException'], [404, 'NotFoundException']] as const) {
    mode = { status, type }
    const n = sesReqs.length
    const r = await send({ to: 'r5@example.com', subject: 's', body: 'b', kind: 'roster' })
    ok(!r.ok && r.e?.code === undefined && sesReqs.length === n + 1 && r.e?.message.includes(type), `R5 ${status} ${type}: a refusal with no code, one request (${r.e?.message})`)
  }
  // a hung request: aborted when the mail timeout passes, and a 'timeout'
  mode = 'hang'
  const n = sesReqs.length
  const p = send({ to: 'r5-hang@example.com', subject: 's', body: 'b', kind: 'roster' })
  await settle(Promise.resolve(), () => sesReqs.length > n)
  ok(sesReqs.length === n + 1 && !sesReqs[n].aborted, 'R5 the hung request reached SES and is still open before the timeout')
  const fired = timeoutPasses()
  const r = await p
  await tick()
  ok(fired >= 1 && !r.ok && r.e?.code === 'timeout', `R5 the hung send is a 'timeout' at MAIL_TIMEOUT_MS (${fired} timers, ${r.e?.message}, code ${r.e?.code})`)
  ok(sesReqs[n].aborted === true, 'R5 the hung request is ABORTED when the timeout passes (the fake saw the abort)')
  // R6: ambiguous outcomes are never a plain refusal
  for (const [m, name] of [[{ status: 500, type: 'InternalFailure' }, '500 InternalFailure'], [{ status: 503, type: 'ServiceUnavailable' }, '503'], ['network', 'a connection that breaks']] as const) {
    mode = m as Mode
    const r = await send({ to: 'r6@example.com', subject: 's', body: 'b', kind: 'roster' })
    ok(!r.ok && r.e?.code === 'timeout', `R6 ${name}: classed with the timeout ('may still arrive'), never as not sent (code ${r.e?.code})`)
  }
  // R7: a throttle is a refusal, and is never retried in the sender
  for (const type of ['TooManyRequestsException', 'LimitExceededException']) {
    mode = { status: 429, type }
    const n = sesReqs.length
    const r = await send({ to: 'r7@example.com', subject: 's', body: 'b', kind: 'roster' })
    ok(!r.ok && r.e?.code === undefined && sesReqs.length === n + 1, `R7 429 ${type}: a refusal, exactly one request (${sesReqs.length - n})`)
  }
  mode = 'ok'
}

// =====================================================================
// R8. every setting fails closed, absent or malformed; the recipient is one address
// =====================================================================
{
  const base = { ...env }
  const field = ['SES_REGION', 'SES_ACCESS_KEY_ID', 'SES_SECRET_ACCESS_KEY', 'MAIL_FROM', 'SES_CONFIGURATION_SET']
  for (const f of field) {
    for (const how of ['absent', 'empty'] as const) {
      const e: Record<string, unknown> = { ...base }
      if (how === 'absent') delete e[f]; else e[f] = ''
      ok(!(f in e) || e[f] === '', `R8 ${f} ${how} (control: the field really is ${how})`)
      const n = sesReqs.length
      const r = await send({ to: 'r8@example.com', subject: 's', body: 'b', kind: 'roster' }, mailEnv(e, stopStore) as never)
      ok(!r.ok && r.e?.code === undefined && sesReqs.length === n && r.e?.message.includes(f), `R8 ${f} ${how}: refused before any request (${r.e?.message})`)
    }
  }
  for (const region of ['eu-west-1.evil.example', 'x', 'EU-WEST-1', 'eu-west-1 ', 'evil.example/eu-west-1', 'eu-west-1\n']) {
    const n = sesReqs.length, m = otherFetches.length
    const r = await send({ to: 'r8@example.com', subject: 's', body: 'b', kind: 'roster' }, mailEnv({ ...base, SES_REGION: region }, stopStore) as never)
    ok(!r.ok && sesReqs.length === n && otherFetches.length === m, `R8 region ${JSON.stringify(region)}: refused, nothing fetched`)
  }
  ok(sesConfig(base).region === REGION, 'R8 control: the full config reads')
  for (const to of ['a@example.com\r\nBcc: b@example.com', 'a@example.com, b@example.com', 'A@Example.com', ' a@example.com', 'Name <a@example.com>', 'a@example.com\n']) {
    const n = sesReqs.length
    const r = await send({ to, subject: 's', body: 'b', kind: 'roster' })
    ok(!r.ok && sesReqs.length === n, `R8 recipient ${JSON.stringify(to)}: refused before any request`)
  }
  {
    const n = sesReqs.length
    const r = await send({ to: 'r8@example.com', subject: 's\r\nBcc: x@example.com', body: 'b', kind: 'roster' })
    ok(!r.ok && sesReqs.length === n, 'R8 a subject with CR/LF: refused before any request')
  }
  // a real send from outside a Roster object cannot read the stop list: it fails closed
  {
    const n = sesReqs.length
    const r = await send({ to: 'r8-raw@example.com', subject: 's', body: 'b', kind: 'setup' }, env)
    ok(!r.ok && sesReqs.length === n, 'R8 a setup mail under ses without the stop list readable: refused, nothing sent')
    const c = await send({ to: 'r8-raw@example.com', subject: 's', body: 'b', kind: 'setup' })
    ok(c.ok, 'R8 control: the same mail with the stop list readable is sent')
  }
}

// =====================================================================
// R3 (routes), R10. the real routes mail through SES; D1 holds under SES
// =====================================================================
const ADDR = 'route-owner@example.com'
{
  mode = 'ok'
  const n0 = sesReqs.length
  const acct = await account(ADDR)
  ok(acct.ok, `R3 setup through the routes under MAILER=ses (${acct.r.status})`)
  const kinds = sent().slice(0).filter((m) => m.to === ADDR).map((m) => m.subject)
  ok(kinds.includes('Set up your bento/id account') && kinds.includes('Your bento/id account was set up'), `R3 setup/start's link and the set-up notice went through SES (${kinds.join(' | ')})`)
  // roster/request: the waiting notice (with its void link)
  const before = sesReqs.length
  const rq = await requestAdd(ADDR, acct.a)
  const waiting = sent().filter((m) => m.to === ADDR).pop()
  ok(rq.status === 202 || rq.status === 200, `R3 roster/request accepted with SES answering (${rq.status} ${JSON.stringify(rq.j)})`)
  ok(sesReqs.length === before + 1 && waiting?.subject === 'A change to your bento/id passkeys is waiting', `R3 the waiting notice went through SES (${waiting?.subject})`)
  ok(!!(await current(ADDR)).pending, 'R3 the change waits once its notice was accepted')
  // /v1/void: Cancel, whose notice is a 'void' kind mail
  const v = parseVoidLink(linksIn(waiting?.body ?? '').find((l) => l.includes('#')) ?? '')
  const vb = sesReqs.length
  const vr = await api('POST', '/v1/void', { email: ADDR, token: v?.token, choice: 'cancel' })
  const cancelled = sent().filter((m) => m.to === ADDR).pop()
  ok(vr.status === 200 && sesReqs.length === vb + 1 && /cancelled/.test(cancelled?.subject ?? ''), `R3 the void Cancel notice went through SES (${vr.status}, ${cancelled?.subject})`)
  // reset/start: the reset link
  const rb = sesReqs.length
  const rs = await api('POST', '/v1/roster/reset/start', { email: ADDR })
  const reset = sent().filter((m) => m.to === ADDR).pop()
  ok(rs.status === 202 && sesReqs.length === rb + 1 && reset?.subject === 'Reset your bento/id account' && !!parseResetLink(linksIn(reset.body)[0] ?? ''), `R3 reset/start's link went through SES (${reset?.subject})`)
  // positive control: every send the routes made is one signed SES request, and nothing else was fetched
  const routeReqs = sesReqs.slice(n0)
  ok(routeReqs.length === 5 && routeReqs.every((r) => r.sig === '' && (r.json?.Destination as { ToAddresses: string[] }).ToAddresses[0] === ADDR) && otherFetches.length === 0,
    `R3 positive control: the 5 route mails (setup link, set up, waiting, cancelled, reset link) are exactly ${routeReqs.length} signed SES requests, no other fetch`)

  // R10: a refused waiting notice leaves nothing waiting, now or at +72 h
  const D1 = 'route-d1@example.com'
  const d = await account(D1)
  mode = { status: 400, type: 'MessageRejected' }
  const r1 = await requestAdd(D1, d.a)
  ok(r1.status === 503 && r1.j.error === 'mail', `R10 SES refuses the waiting notice: 503 mail (${r1.status} ${JSON.stringify(r1.j)})`)
  ok(!(await current(D1)).pending, 'R10 nothing waits after a refused notice')
  mode = 'ok'
  now += 73 * HOUR
  const h72 = await current(D1)
  ok(!h72.pending && h72.head?.members?.length === 1, 'R10 at +72 h the roster is unchanged (one member, nothing waiting)')
  // a hung notice: aborted at the timeout, nothing waits
  mode = 'hang'
  const hn = sesReqs.length
  const p = requestAdd(D1, d.a)
  await settle(Promise.resolve(), () => sesReqs.length > hn)
  timeoutPasses()
  const r2 = await p
  await tick()
  ok(r2.status === 503 && sesReqs[hn]?.aborted === true, `R10 a hung notice: 503 and the request aborted (${r2.status}, aborted ${sesReqs[hn]?.aborted})`)
  ok(!(await current(D1)).pending, 'R10 nothing waits after a hung notice')
  // and while one notice hangs, a second request is refused (D1a: the slot is the first one's)
  const hn2 = sesReqs.length
  const first = requestAdd(D1, d.a)
  await settle(Promise.resolve(), () => sesReqs.length > hn2)
  mode = 'ok'
  const second = await requestAdd(D1, d.a)
  ok(second.status !== 200 && second.status !== 202 && sesReqs.length === hn2 + 1, `R10 D1a: while a notice hangs a second request is refused and mails nothing (${second.status} ${JSON.stringify(second.j)})`)
  timeoutPasses()
  const fr = await first
  await tick()
  ok(fr.status === 503 && !(await current(D1)).pending, 'R10 D1a: the hung first request ends 503 with nothing waiting')
  mode = 'ok'
}

// =====================================================================
// R11-R18. SNS events
// =====================================================================
let certN = 0
const certUrl = () => `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-${(++certN).toString(16).padStart(32, 'a')}.pem`
type Sns = Record<string, string>
function canonicalN(m: Sns) {
  const f = m.Type === 'Notification' ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'] : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type']
  return f.filter((k) => m[k] !== undefined).map((k) => `${k}\n${m[k]}\n`).join('')
}
function signed(m: Sns, o: { v?: '1' | '2'; key?: typeof CERT_KEY } = {}): Sns {
  const v = o.v ?? '2'
  const sig = createSign(v === '2' ? 'RSA-SHA256' : 'RSA-SHA1').update(canonicalN(m)).sign(o.key ?? CERT_KEY, 'base64')
  return { ...m, SignatureVersion: v, Signature: sig }
}
let msgN = 0
function notification(event: unknown, o: { topic?: string; cert?: string; at?: number } = {}): Sns {
  return { Type: 'Notification', MessageId: `rig-${++msgN}`, TopicArn: o.topic ?? TOPIC, Message: typeof event === 'string' ? event : JSON.stringify(event),
    Timestamp: new Date(o.at ?? now).toISOString(), SigningCertURL: o.cert ?? certUrl(), UnsubscribeURL: `https://sns.${REGION}.amazonaws.com/?Action=Unsubscribe` }
}
const bounce = (type: string, ...to: string[]) => ({ eventType: 'Bounce', bounce: { bounceType: type, bounceSubType: type === 'Permanent' ? 'General' : 'MailboxFull', bouncedRecipients: to.map((emailAddress) => ({ emailAddress })) }, mail: { messageId: 'x' } })
const complaint = (...to: string[]) => ({ eventType: 'Complaint', complaint: { complainedRecipients: to.map((emailAddress) => ({ emailAddress })), complaintFeedbackType: 'abuse' }, mail: { messageId: 'x' } })
const post = (m: unknown, raw?: string) => api('POST', SNS_PATH, undefined, { raw: raw ?? JSON.stringify(m), headers: { 'content-type': 'text/plain; charset=UTF-8', 'x-amz-sns-message-type': 'Notification' } })
const stopOf = async (a: string) => (await storeOf(a)).get(MAIL_STOP_KEY) as Record<string, unknown> | undefined

{
  // R11: a signed Permanent bounce on our topic stops the address
  const A = 'sns-bounced@example.com'
  const c0 = certHits.length
  const r = await post(signed(notification(bounce('Permanent', A))))
  const rec = await stopOf(A)
  ok(r.status === 200 && r.j.stopped === 1, `R11 a signed Permanent bounce on our topic: 200 stopped 1 (${r.status} ${JSON.stringify(r.j)})`)
  ok(rec?.reason === 'bounce' && rec?.subtype === 'General' && rec?.at === now, `R11 positive control: the stop record reads back (${JSON.stringify(rec)})`)
  ok(certHits.length === c0 + 1, 'R11 the certificate was fetched once, from the pinned URL')
  // tampered: the Message changed after signing
  const B = 'sns-tampered@example.com'
  const t = signed(notification(bounce('Permanent', 'someone-else@example.com')))
  const rt = await post({ ...t, Message: JSON.stringify(bounce('Permanent', B)) })
  ok(rt.status === 403 && rt.j.error === 'signature' && !(await stopOf(B)), `R11 a tampered Message: 403 signature, nothing written (${rt.status})`)
  // signed with another key (the certificate does not match)
  const { privateKey: other } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const ro = await post(signed(notification(bounce('Permanent', B)), { key: other }))
  ok(ro.status === 403 && !(await stopOf(B)), `R11 signed by a key that is not the certificate's: 403, nothing written (${ro.status})`)
  // SignatureVersion 1 (SHA1), validly signed
  const c1 = certHits.length
  const r1 = await post(signed(notification(bounce('Permanent', B)), { v: '1' }))
  ok(r1.status === 403 && r1.j.error === 'signature' && certHits.length === c1 && !(await stopOf(B)), `R11 SignatureVersion 1, validly signed with SHA1: 403 before any fetch, nothing written (${r1.status})`)
  ok((await post(signed(notification(bounce('Permanent', B))))).status === 200 && !!(await stopOf(B)), 'R11 control: the same event, SignatureVersion 2, stops B')
  // stale and future timestamps
  const C = 'sns-stale@example.com'
  const rs = await post(signed(notification(bounce('Permanent', C), { at: now - SNS_MAX_AGE_MS - MIN })))
  const rf = await post(signed(notification(bounce('Permanent', C), { at: now + 10 * MIN })))
  ok(rs.status === 403 && rs.j.error === 'stale' && rf.status === 403 && !(await stopOf(C)), `R11 a stale or future Timestamp: 403 stale, nothing written (${rs.status}/${rf.status})`)
  ok((await post(signed(notification(bounce('Permanent', C), { at: now - SNS_MAX_AGE_MS + MIN })))).status === 200, 'R11 control: just inside the window is accepted')

  // R12: the topic is pinned exactly
  const D = 'sns-topic@example.com'
  for (const topic of [`arn:aws:sns:${REGION}:999999999999:bento-id-ses-events`, `${TOPIC}-2`, `arn:aws:sns:eu-central-1:123456789012:bento-id-ses-events`, TOPIC.toUpperCase()]) {
    const c = certHits.length
    const rr = await post(signed(notification(bounce('Permanent', D), { topic })))
    ok(rr.status === 403 && rr.j.error === 'topic' && certHits.length === c && !(await stopOf(D)), `R12 a validly signed event on ${topic}: 403 topic, nothing fetched or written`)
  }
  {
    const e = { ...env }; delete e.SES_EVENTS_TOPIC_ARN
    const saved = env.SES_EVENTS_TOPIC_ARN
    delete env.SES_EVENTS_TOPIC_ARN
    const c = certHits.length
    const rr = await post(signed(notification(bounce('Permanent', D))))
    env.SES_EVENTS_TOPIC_ARN = saved
    ok(rr.status === 503 && certHits.length === c && !(await stopOf(D)), `R12 no topic configured (absent): 503, nothing fetched or written (${rr.status})`)
  }

  // R13: the certificate URL is pinned before any fetch
  const E = 'sns-certurl@example.com'
  const hexp = 'SimpleNotificationService-0123456789abcdef0123456789abcdef.pem'
  for (const u of [`http://sns.${REGION}.amazonaws.com/${hexp}`, `https://sns.eu-central-1.amazonaws.com/${hexp}`, `https://sns.${REGION}.amazonaws.com.evil.example/${hexp}`,
    `https://evil.example/sns.${REGION}.amazonaws.com/${hexp}`, `https://user@sns.${REGION}.amazonaws.com/${hexp}`, `https://sns.${REGION}.amazonaws.com:8443/${hexp}`,
    `https://sns.${REGION}.amazonaws.com/${hexp}?x=1`, `https://sns.${REGION}.amazonaws.com/cert.pem`, `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-0123456789abcdef.txt`,
    `https://evilsns.${REGION}.amazonaws.com/${hexp}`, `https://sns.${REGION}.amazonaws.com/a/../${hexp}`]) {
    const c = certHits.length, o = otherFetches.length
    const rr = await post(signed(notification(bounce('Permanent', E), { cert: u })))
    ok(rr.status === 403 && rr.j.error === 'cert-url' && certHits.length === c && otherFetches.length === o && !(await stopOf(E)), `R13 SigningCertURL ${u}: 403 before any fetch (${rr.status} ${rr.j.error})`)
  }
  // the DER walk finds the same key node:crypto reads from the certificate
  {
    const x = new X509Certificate(CERT_PEM)
    ok(x.verify(CERT_PUB) && /SNS TEST/.test(x.subject), 'R13 control: the test certificate is a real, self-signed X.509 certificate')
    const der = new X509Certificate(CERT_PEM).raw
    const mine = Buffer.from(spkiOf(new Uint8Array(der)))
    ok(mine.equals(new X509Certificate(CERT_PEM).publicKey.export({ type: 'spki', format: 'der' }) as Buffer), 'R13 the SPKI walk extracts exactly the certificate\'s public key')
  }

  // R14: event semantics
  const T = 'sns-transient@example.com'
  const r14a = await post(signed(notification(bounce('Transient', T))))
  const r14b = await post(signed(notification(bounce('Undetermined', T))))
  ok(r14a.status === 200 && r14a.j.stopped === 0 && r14b.status === 200 && !(await stopOf(T)), 'R14 Transient and Undetermined bounces stop nobody (200, stopped 0)')
  const Q = 'sns-complaint@example.com'
  const r14c = await post(signed(notification(complaint(Q))))
  ok(r14c.status === 200 && (await stopOf(Q))?.reason === 'complaint', 'R14 a complaint stops the address (reason complaint)')
  for (const ev of [{ eventType: 'Delivery', delivery: { recipients: ['x@example.com'] } }, { eventType: 'Send' }, { eventType: 'Reject' }, { eventType: 'DeliveryDelay' }]) {
    const rr = await post(signed(notification(ev)))
    ok(rr.status === 200 && rr.j.stopped === 0, `R14 a ${ev.eventType} event is ignored (200, stopped 0)`)
  }
  const G = 'sns-garbled@example.com'
  for (const [m, name] of [['not json', 'a Message that is not JSON'], [{ bounce: {} }, 'no eventType'], [{ eventType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [] } }, 'no recipients'],
    [{ eventType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: G }, { emailAddress: 'not an address' }] } }, 'one recipient that is not an address'],
    [{ eventType: 'Complaint', complaint: {} }, 'a complaint with no recipients']] as const) {
    const rr = await post(signed(notification(m)))
    ok(rr.status === 400 && !(await stopOf(G)), `R14 ${name}: 400, nothing written (${rr.status})`)
  }
  const N = 'sns-normalized@example.com'
  const r14n = await post(signed(notification(bounce('Permanent', '  SNS-Normalized@Example.COM '))))
  ok(r14n.status === 200 && !!(await stopOf(N)), 'R14 a case/whitespace variant stops the canonical address')
  ok(!ROSTER.objs.has('  SNS-Normalized@Example.COM ') && !ROSTER.objs.has(await addressKey('sns-normalized@Example.COM')), 'R14 no object was made for the unnormalized form')
  // a replay of the same message changes nothing (the first record stands)
  const first = await stopOf(A)
  now += MIN
  const replay = await post(signed(notification(complaint(A))))
  ok(replay.status === 200 && JSON.stringify(await stopOf(A)) === JSON.stringify(first), 'R14 a later event for a stopped address keeps the first record')

  // R16: the record holds no address; the object is named by the address's hash
  {
    const fresh = 'sns-privacy@example.com'
    await post(signed(notification(bounce('Permanent', fresh))))
    const store = await storeOf(fresh)
    const dump = JSON.stringify([...store])
    ok(ROSTER.objs.has(await addressKey(fresh)) && ![...ROSTER.objs.keys()].some((k) => k.includes('@')), 'R16 objects are named by the address hash, never the address')
    ok(store.size === 1 && store.has(MAIL_STOP_KEY) && !dump.includes(fresh) && !dump.toLowerCase().includes('sns-privacy'), `R16 the stop record holds no address (${dump})`)
    ok(JSON.stringify(Object.keys((store.get(MAIL_STOP_KEY) ?? {}) as object).sort()) === '["at","reason","subtype"]', 'R16 the record is exactly {reason, subtype, at}')
  }

  // R17: SubscriptionConfirmation
  const token = 'a'.repeat(64)
  const sub = (o: { topic?: string; url?: string } = {}) => signed({ Type: 'SubscriptionConfirmation', MessageId: `rig-sub-${++msgN}`, Token: token, TopicArn: o.topic ?? TOPIC,
    Message: 'You have chosen to subscribe to the topic.', SubscribeURL: o.url ?? `https://sns.${REGION}.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(o.topic ?? TOPIC)}&Token=${token}`,
    Timestamp: new Date(now).toISOString(), SigningCertURL: certUrl() })
  {
    const s0 = subscribeHits.length
    const rr = await post(sub())
    ok(SNS_CONFIRM === 'auto' ? rr.status === 200 && rr.j.confirmed === true && subscribeHits.length === s0 + 1 : rr.status === 200 && subscribeHits.length === s0,
      `R17 a valid confirmation for our topic (SNS_CONFIRM ${SNS_CONFIRM}): ${subscribeHits.length - s0} GET of the pinned SubscribeURL`)
    const s1 = subscribeHits.length, c1 = certHits.length
    const ro = await post(sub({ topic: `arn:aws:sns:${REGION}:999999999999:attacker` }))
    ok(ro.status === 403 && subscribeHits.length === s1 && certHits.length === c1, `R17 a confirmation for another topic: 403, zero fetches (${ro.status})`)
    for (const url of [`https://sns.${REGION}.amazonaws.com.evil.example/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC)}&Token=${token}`,
      `https://evil.example/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC)}&Token=${token}`,
      `https://sns.${REGION}.amazonaws.com/?Action=Unsubscribe&TopicArn=${encodeURIComponent(TOPIC)}&Token=${token}`,
      `https://sns.${REGION}.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC + 'x')}&Token=${token}`,
      `http://sns.${REGION}.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC)}&Token=${token}`,
      `https://sns.${REGION}.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC)}&Token=${token}&Next=https://evil.example/`]) {
      const s2 = subscribeHits.length, o2 = otherFetches.length
      const ru = await post(sub({ url }))
      ok(ru.status === 403 && subscribeHits.length === s2 && otherFetches.length === o2, `R17 SubscribeURL ${url.slice(0, 70)}...: 403, zero fetches (${ru.status})`)
    }
  }

  // R18: body cap, method, headers
  {
    const c = certHits.length
    const big = JSON.stringify({ ...signed(notification(bounce('Permanent', 'sns-big@example.com'))), Pad: 'x'.repeat(SNS_BODY_MAX) })
    const rb = await post(null, big)
    ok(rb.status === 413 && certHits.length === c && !(await stopOf('sns-big@example.com')), `R18 a body over ${SNS_BODY_MAX} bytes: 413, nothing parsed, fetched or written (${rb.status})`)
    const nolen = await worker.fetch(new Request('https://id.bento.page' + SNS_PATH, { method: 'POST', body: new ReadableStream({ start(c) { c.enqueue(te.encode(big)); c.close() } }), duplex: 'half' } as RequestInit), env as never)
    ok(nolen.status === 413, `R18 the same body streamed with no content-length: 413 (${nolen.status})`)
    const g = await api('GET', SNS_PATH)
    ok(g.status === 405, `R18 GET ${SNS_PATH}: 405 (${g.status})`)
    const bad = await post(null, '{"Type":"Other"}')
    ok(bad.status === 400, 'R18 a Type other than Notification or SubscriptionConfirmation: 400')
    for (const a of [rb, g, bad]) {
      ok(a.h.get('x-content-type-options') === 'nosniff' && /default-src 'none'/.test(a.h.get('content-security-policy') ?? '') && /publickey-credentials-get=\(\)/.test(a.h.get('permissions-policy') ?? '')
        && a.h.get('access-control-allow-origin') === null && a.h.get('content-type') === 'application/json', `R18 a ${a.status} carries the directory's header set and no CORS`)
    }
  }

  // R15: a stop is a refusal, never a silent success
  {
    // setup/start for a stopped address: identical bytes, nothing sent, link withdrawn
    const X = 'stopped-setup@example.com'
    await post(signed(notification(bounce('Permanent', X))))
    ok(!!(await stopOf(X)), 'R15 setup: the address is stopped (positive control)')
    const n = sesReqs.length
    const rx = await api('POST', '/v1/roster/setup/start', { email: X })
    const ctl = await api('POST', '/v1/roster/setup/start', { email: 'unstopped-setup@example.com' })
    ok(rx.status === ctl.status && rx.text === ctl.text, `R15 setup/start answers the same bytes for a stopped address (${rx.status} ${rx.text})`)
    ok(sesReqs.length === n + 1 && sent().pop()?.to === 'unstopped-setup@example.com', 'R15 the stopped address got NO request; the control did')
    const live = (((await storeOf(X)).get('setupTok') as { exp: number }[] | undefined) ?? []).filter((t) => t.exp > now)
    ok(live.length === 0, 'R15 the refused setup link is withdrawn (no live token held back)')
    ok(logs.some((l) => /setup mail failed: address stopped \(bounce\)/.test(l)), 'R15 the refusal is logged as a stop, by kind and reason only')
    // the per-kind rule, both values of the open ruling
    for (const kind of Object.keys(MAIL_KINDS)) {
      ok(stopApplies(kind, 'all') === true, `R15 under 'all' a stop refuses '${kind}'`)
      ok(stopApplies(kind, 'budget') === (MAIL_KINDS[kind as keyof typeof MAIL_KINDS] === 'budget'), `R15 under 'budget' a stop refuses '${kind}' only if it is a budget kind`)
    }
    // a 'never' kind through a real route, under the constant as it stands
    const Y = 'stopped-owner@example.com'
    const acct = await account(Y)
    await post(signed(notification(complaint(Y))))
    const m = sesReqs.length
    const ry = await requestAdd(Y, acct.a)
    if (MAIL_STOP_APPLIES === 'budget') {
      ok((ry.status === 202 || ry.status === 200) && sesReqs.length === m + 1 && !!(await current(Y)).pending,
        `R15 MAIL_STOP_APPLIES 'budget': a stopped account's waiting notice still goes to SES and the change waits (${ry.status})`)
    } else {
      ok(ry.status === 503 && sesReqs.length === m && !(await current(Y)).pending, `R15 MAIL_STOP_APPLIES 'all': refused 503, nothing sent, nothing waits (${ry.status})`)
    }
    // a stopped send through deliver() itself is a coded refusal, never a success
    const st = new Map<string, unknown>([[MAIL_STOP_KEY, { reason: 'bounce', subtype: 'General', at: now }]])
    const k = sesReqs.length
    const rs = await send({ to: 'deliver-stopped@example.com', subject: 's', body: 'b', kind: 'setup' }, mailEnv(env, { async get(x: string) { return st.get(x) } }) as never)
    ok(!rs.ok && rs.e?.code === 'suppressed' && sesReqs.length === k, `R15 deliver() for a stopped address and a refused kind throws code 'suppressed', nothing sent (${rs.e?.code})`)
  }
}

// =====================================================================
// R9. nothing secret in any log line of the whole run
// =====================================================================
{
  ok(logs.length >= 4 && logs.some((l) => /mail failed: (mailer timed out|ses outcome unknown)/.test(l)) && logs.some((l) => /address stopped/.test(l)),
    `R9 positive control: the run logged its refusals, timeouts and stops (${logs.length} lines), so the scan below is over real failures`)
  ok(logs.some((l) => /mail failed: ses refused: 400 MessageRejected/.test(l)), 'R9 positive control: a refusal was logged by status and AWS error type')
  const all = logs.join('\n')
  const bodies = sesReqs.map((r) => r.body)
  const tokens = new Set(bodies.flatMap((b) => [...b.matchAll(/[#&]t=([A-Za-z0-9_-]{43})/g)].map((m) => m[1])))
  ok(tokens.size >= 3, `R9 control: the scan knows ${tokens.size} mailed tokens`)
  ok(![...tokens].some((t) => all.includes(t)), 'R9 no mailed token appears in any log line')
  ok(!all.includes(SECRET) && !all.includes(KEY_ID), 'R9 neither the secret nor the key id appears in any log line')
  const sigs = sesReqs.map((r) => /Signature=([0-9a-f]{64})/.exec(r.headers.authorization ?? '')?.[1]).filter(Boolean) as string[]
  ok(sigs.length > 0 && !sigs.some((s) => all.includes(s)) && !/AWS4-HMAC-SHA256/.test(all), 'R9 no Authorization value or signature appears in any log line')
  const addrs = new Set(sesReqs.map((r) => (r.json?.Destination as { ToAddresses?: string[] } | undefined)?.ToAddresses?.[0]).filter(Boolean) as string[])
  ok(addrs.size > 5 && ![...addrs].some((a) => all.includes(a)), `R9 none of the ${addrs.size} recipient addresses appears in any log line`)
  ok(!/Email address is not verified/.test(all), "R9 AWS's response body (which can echo the address) is never logged")
}

ok(held.size === 0, `no mail timer left held (${held.size})`)
if (process.env.DUMP) say(logs.join('\n'))
say(`${passes} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
