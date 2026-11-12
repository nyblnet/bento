#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/id directory: BROWSER CERTIFICATES (option G, SD3), server/directory/src/browsers.js.
//
//   node scripts/test-directory-browsers.ts        (Node ≥ 23.6 strips types natively)
//
// Drives the REAL worker and its Roster Durable Object (in memory, with the
// input gate, as test-directory-roster.ts does) through the sign-in host's and
// bento/home's routes, with a software authenticator for the passkeys and real
// WebCrypto device keys. What it must prove:
//   · a browser challenge is sealed for its audience and address, lives 60 s,
//     is spent before any other check (reuse, a failed assertion, the other
//     audience each use it up), and a challenge for another address is refused;
//   · asking for one costs a per-IP lookup (both routes answer 404 for no
//     account) and one of that IP's challenges for that address, never a count
//     another caller shares, and nothing is stored when one is issued;
//   · the head an enrolment names is the latest RIPENED one;
//   · an enrolment needs bento/home as its opener, an unquarantined passkey
//     member, an assertion from the sign-in host with a counter that moves
//     forward, the challenge's own time, and a device key never enrolled before;
//   · the countersign lives 24 h, never past 7 days after the ceremony, carries
//     ob = 1 for bento/home's requests, and the kernel's verifyDevice accepts
//     the certificate with the roster the check-in returns;
//   · a renewal is refused for an unknown key, a revoked one (sign out
//     everywhere, a removed or suspended passkey) and past the 7 days, and
//     carries the published incident records; an unreadable list is a 500;
//   · the event log carries ob on every entry; the status route reports the
//     standing; CORS is per route, and a path that is no route gets none.

import worker, { Roster, Ledger } from '../server/directory/src/worker.js'
import * as workerModule from '../server/directory/src/worker.js'
import { addressKey } from '../server/directory/src/address.js'
import { issueChallenge } from '../server/directory/src/challenge.js'
import { parseResetLink } from '../server/directory/src/links.js'
import { HOME_ORIGIN, SIGNIN_ORIGIN, passkeyOrigins } from '../server/directory/src/passkey.js'
import { parseSetupLink } from '../server/directory/src/links.js'
import { REQUESTERS } from '../server/directory/src/roster.js'
import { BROWSER_LIMITS } from '../server/directory/src/browsers.js'
import { HOME_ROUTES, WEB_ROUTES, STATUS_ROUTE } from '../server/directory/src/seam.js'
import { b64uDec, b64uEnc, sha256b64u, signStatement } from '../kernel/src/statements.ts'
import { buildRos, parseRos, verifyRosterChain, ROSTER_RP_ID, ROSTER_WEB_ORIGINS, ROSTER_WAIT_MS, type Member, type RosterLink } from '../kernel/src/roster.ts'
import { buildDeviceCert, buildWren, parseWatt, verifyDevice, CEREMONY_CAP_MS, WATT_MAX_MS } from '../kernel/src/devices.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
const { LIMITS } = workerModule

let fails = 0, passes = 0
const ok = (c: unknown, n: string) => { if (c) { passes++; if (process.env.ROWS) console.log('ok   ' + n) } else { fails++; console.log('FAIL ' + n) } }

// ---------- clock ----------
let now = Date.parse('2026-11-09T09:00:00Z')
Date.now = () => now
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR

// ---------- in-memory Durable Object namespaces ----------
// A Durable Object's INPUT GATE: one event at a time, and the gate opens only
// while the object waits on outgoing I/O (here, the mailer). Without it, every
// concurrent request would read storage before any of them wrote, which the
// runtime never allows, and races the runtime does allow (a request arriving
// during a slow send) would look the same as ones it prevents.
class Gate {
  busy = false; q: (() => void)[] = []
  async enter() { if (!this.busy) { this.busy = true; return } await new Promise<void>((r) => this.q.push(r)) }
  leave() { const n = this.q.shift(); if (n) n(); else this.busy = false }
}
const inObject = new AsyncLocalStorage<Gate>()
/** Run outgoing I/O with the current object's gate open, as the runtime does. */
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
const allStores: Map<string, unknown>[] = []
function namespace(Klass: new (state: unknown, env: unknown) => Obj) {
  const objs = new Map<string, { obj: Obj; store: Map<string, unknown>; alarm: number | null; gate: Gate }>()
  const ns = {
    objs,
    idFromName: (n: string) => n,
    get(id: string) {
      if (!objs.has(id)) {
        const store = new Map<string, unknown>()
        allStores.push(store)
        const rec = { obj: null as unknown as Obj, store, alarm: null as number | null, gate: new Gate() }
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
          },
        }
        const inner = new Klass(state, env)
        rec.obj = {
          fetch: (r: Request) => gated(rec.gate, () => inner.fetch(r)),
          alarm: inner.alarm ? () => gated(rec.gate, () => inner.alarm!()) : undefined,
        }
        objs.set(id, rec)
      }
      const { obj } = objs.get(id)!
      return { fetch: (u: string | Request, init?: RequestInit) => obj.fetch(u instanceof Request ? u : new Request(u, init)) }
    },
  }
  return ns
}

// ---------- env + mail capture ----------
type Mail = { to: string; subject: string; body: string; kind: string; code?: string }
const mailbox: Mail[] = []
let mailDown = false
/** when set, the next send goes here instead (a hung or late mailer) */
let mailHook: ((m: Mail) => Promise<void> | void) | null = null
// the directory's online countersign key (dir-1), and its public half as a peer would pin it
const dirKp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
const DIR_PUB = b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', dirKp.publicKey)))
const env: Record<string, unknown> = {
  DIR_KID: 'dir-1', CHALLENGE_KEY: 'k'.repeat(48), DIR_KEY_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', dirKp.privateKey)),
  MAILER: { send: (m: Mail) => outgoing(() => { if (mailHook) return mailHook(m); if (mailDown) throw new Error('mailer down'); mailbox.push(m) }) },
}
const ROSTER = namespace(Roster as never)
env.ROSTER = ROSTER
env.LEDGER = namespace(Ledger as never)
/** Did the request reach the hung send? Bounded, so a request that never gets there fails a row instead of hanging the rig. */
async function reached(h: { called: Promise<void> }) {
  let t: ReturnType<typeof setTimeout> | undefined
  const r = await Promise.race([h.called.then(() => true), new Promise<boolean>((res) => { t = setTimeout(() => res(false), 2000) })])
  clearTimeout(t)
  if (!r) mailHook = null
  return r
}
/** The next send hangs until `release(true)` (delivered) or `release(false)` (fails late). */
function hangNext() {
  let release!: (ok: boolean) => void, called!: () => void
  const calledP = new Promise<void>((r) => { called = r })
  const done = new Promise<boolean>((r) => { release = r })
  mailHook = async (m) => { mailHook = null; called(); if (!(await done)) throw new Error('mailer failed late'); mailbox.push(m) }
  return { called: calledP, release }
}

const S = 'https://signin.id.bento.page'
let ipN = 0
const freshIp = () => `10.1.${Math.floor(++ipN / 250)}.${ipN % 250}`
async function api(method: string, path: string, body?: unknown, o: { ip?: string; origin?: string | null } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'cf-connecting-ip': o.ip ?? freshIp() }
  if (o.origin !== null) headers.origin = o.origin ?? S
  const r = await worker.fetch(new Request('https://id.bento.page' + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body), headers,
  }), env as never)
  const text = await r.text()
  let j: Record<string, unknown> = {}
  try { j = JSON.parse(text) } catch { /* empty */ }
  return { status: r.status, j, h: r.headers, text }
}
const responses: { what: string; status: number; h: Headers; text: string }[] = []
async function seen(what: string, p: Promise<Awaited<ReturnType<typeof api>>>) { const r = await p; responses.push({ what, status: r.status, h: r.h, text: r.text }); return r }

async function rosterObj(email: string) {
  const id = await addressKey(email)
  ROSTER.get(id)
  return ROSTER.objs.get(id)!
}
async function doOp(email: string, op: string, args: Record<string, unknown> = {}) {
  const r = await ROSTER.get(await addressKey(email)).fetch('https://roster/op', { method: 'POST', body: JSON.stringify({ op, ...args }) })
  return { status: r.status, j: await r.json() as Record<string, unknown> }
}

// ---------- a software authenticator ----------
const te = new TextEncoder()
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length } return o }
function rawToDer(raw: Uint8Array) {
  const int = (b: Uint8Array) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; let v = b.slice(i); if (v[0] & 0x80) v = cat(new Uint8Array([0]), v); return cat(new Uint8Array([2, v.length]), v) }
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)))
  return cat(new Uint8Array([0x30, body.length]), body)
}
const cdjOf = (o: Record<string, unknown>) => b64uEnc(te.encode(JSON.stringify(o)))

type RegOpts = { origin?: string; rpId?: string; flags?: number; alg?: number; type?: string; cross?: unknown; top?: string; cdj?: string; extraCoseKey?: boolean; trailing?: boolean; noAt?: boolean; dupAlg?: boolean }
type GetOpts = { origin?: string; rpId?: string; flags?: number; count?: number }
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
  async register(challenge: Uint8Array, o: RegOpts = {}) {
    const raw = b64uDec(this.pub)!
    const x = raw.slice(1, 33), y = raw.slice(33)
    const alg = o.alg ?? -7
    const algBytes = alg === -7 ? new Uint8Array([0x26]) : alg === -8 ? new Uint8Array([0x27]) : new Uint8Array([0x39, 0x01, 0x00]) // -257
    // dupAlg: label 3 twice, RS256 first and ES256 last, so a reader that keeps the last value sees a good key
    const cose = cat(new Uint8Array([o.extraCoseKey || o.dupAlg ? 0xa6 : 0xa5, 0x01, 0x02]), o.dupAlg ? new Uint8Array([0x03, 0x39, 0x01, 0x00]) : new Uint8Array(0), new Uint8Array([0x03]), algBytes, new Uint8Array([0x20, 0x01, 0x21, 0x58, 0x20]), x,
      new Uint8Array([0x22, 0x58, 0x20]), y, o.extraCoseKey ? new Uint8Array([0x04, 0x01]) : new Uint8Array(0))
    const flags = o.flags ?? (0x45)
    const cnt = new Uint8Array([0, 0, 0, this.count])
    const att = o.noAt ? new Uint8Array(0) : cat(new Uint8Array(16), new Uint8Array([0, this.credId.length]), this.credId, cose)
    const ad = cat(await sha256(te.encode(o.rpId ?? 'id.bento.page')), new Uint8Array([o.noAt ? flags & ~0x40 : flags]), cnt, att, o.trailing ? new Uint8Array([0]) : new Uint8Array(0))
    const cd: Record<string, unknown> = { type: o.type ?? 'webauthn.create', challenge: b64uEnc(challenge ?? new Uint8Array(16)), origin: o.origin ?? S }
    cd.crossOrigin = o.cross ?? false
    if (o.top) cd.topOrigin = o.top
    return { clientDataJSON: o.cdj ?? cdjOf(cd), authenticatorData: b64uEnc(ad) }
  }
  async assert(text: string, o: GetOpts = {}) {
    if (o.count !== undefined) this.count = o.count
    const c = this.count
    const ad = cat(await sha256(te.encode(o.rpId ?? 'id.bento.page')), new Uint8Array([o.flags ?? 0x05, (c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255, c & 255]))
    const cdj = te.encode(JSON.stringify({ type: 'webauthn.get', challenge: b64uEnc(await sha256(te.encode(text))), origin: o.origin ?? S, crossOrigin: false }))
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.kp.privateKey, cat(ad, await sha256(cdj)) as BufferSource))
    return { authenticatorData: b64uEnc(ad), clientDataJSON: b64uEnc(cdj), signature: b64uEnc(rawToDer(sig)) }
  }
}

// ---------- flows ----------
async function challenge(email: string) {
  const r = await seen('challenge', api('POST', '/v1/roster/challenge', { email }))
  return r.j.challenge as string
}
/** Ask for a setup link through the route and read the token out of the mailed link (null: nothing was mailed). */
async function setupToken(email: string, ip?: string) {
  const n = mailbox.length
  const r = await seen('setup-start', api('POST', '/v1/roster/setup/start', { email }, { ip }))
  if (r.status !== 202) return null
  const m = mailbox.slice(n).find((x) => x.to === email && x.kind === 'setup')
  const urls = m?.body.match(/https?:\/\/\S+/g) ?? []
  const l = urls.length === 1 ? parseSetupLink(urls[0]) : null
  return l && l.address === email ? l.token : null
}
async function setup(email: string, a: Authn, o: { token?: string; reg?: RegOpts; origin?: string | null; ch?: string } = {}) {
  const token = o.token ?? (await setupToken(email))!
  const ch = o.ch ?? await challenge(email)
  const reg = await a.register(b64uDec(ch)!, o.reg)
  return seen('setup', api('POST', '/v1/roster/setup', { email, token, dirNonce: ch, reg }, { origin: o.origin }))
}
async function head(email: string) { return seen('head', api('GET', `/v1/roster?e=${encodeURIComponent(email)}`)) }
async function current(email: string) {
  const h = await head(email)
  const p = await parseRos(h.j.ros as string)
  return { text: h.j.ros as string, head: p.ok ? p.value : null, pending: h.j.pending as Record<string, unknown> | null }
}
type ReqOpts = {
  add?: Authn; remove?: string; members?: Member[]; signer?: Authn; credId?: string; rq?: string; created?: number
  seq?: number; prev?: string; reg?: unknown; regOpts?: RegOpts; get?: GetOpts; origin?: string | null; ch?: string; noAssertion?: boolean; sameNonceAs?: string
  address?: string
}
async function request(email: string, signer: Authn, o: ReqOpts) {
  const c = await current(email)
  if (!c.head) return { status: -1, j: { error: 'no-head' } as Record<string, unknown>, h: new Headers(), text: '', ros: '' }
  const ch = o.ch ?? await challenge(email)
  let members = o.members ?? c.head.members.slice()
  if (!o.members) {
    if (o.add) members = [...members, { kind: 'pk', pub: o.add.pub, quarantined: false }]
    if (o.remove) members = members.filter((m) => m.pub !== o.remove)
  }
  const ros = buildRos({ address: o.address ?? email, seq: o.seq ?? c.head.seq + 1, prev: o.prev ?? await sha256b64u(c.text), members, dirNonce: ch, created: o.created ?? now })
  const assertion = o.noAssertion ? undefined : await signer.assert(ros, o.get)
  const reg = o.reg !== undefined ? o.reg : o.add ? await o.add.register(b64uDec(ch)!, o.regOpts) : undefined
  const r = await seen('request', api('POST', '/v1/roster/request', { email, ros, credId: o.credId ?? signer.cid, assertion, reg, rq: o.rq }, { origin: o.origin }))
  return { ...r, ros }
}
const NOMAIL: Mail = { to: '', subject: '', body: '', kind: '' }
const lastMail = (to: string) => [...mailbox].reverse().find((m) => m.to === to)
const mailsTo = (to: string) => mailbox.filter((m) => m.to === to)
async function plant(email: string, mutate: (store: Map<string, unknown>) => void) { mutate((await rosterObj(email)).store) }
/** Run an object's alarm as the platform does: the alarm is cleared, then the handler may set the next one. */
async function fire(o: { obj: Obj; alarm: number | null }) { o.alarm = null; await o.obj.alarm!() }
const when = (t: number) => new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
const DIR_KEYS = { 'dir-1': DIR_PUB }
/** The stored chain as a peer would get it, through the kernel's verifier. */
async function chainOf(email: string) {
  const store = (await rosterObj(email)).store
  const links = [...store.entries()].filter(([k]) => k.startsWith('link:')).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => {
    const l = v as Record<string, unknown>
    const out: Record<string, unknown> = { ros: l.ros, rip: l.rip, ripSig: l.ripSig }
    if (l.kind === 'member') { out.signer = l.signer; out.assertion = l.assertion }
    if (l.voided) out.voided = l.voided
    return out as unknown as RosterLink
  })
  return verifyRosterChain(links, { directoryKeys: DIR_KEYS, rpId: ROSTER_RP_ID, origins: [...ROSTER_WEB_ORIGINS], now })
}


// ---------- browser flows ----------
const H = HOME_ORIGIN
type R = Awaited<ReturnType<typeof api>>
async function raw(method: string, path: string, body: string | undefined, origin: string | null, ip?: string): Promise<R> {
  const headers: Record<string, string> = { 'content-type': 'text/plain;charset=UTF-8', 'cf-connecting-ip': ip ?? freshIp() }
  if (origin !== null) headers.origin = origin
  let r: Response
  // an exception that escapes the worker is a refused row, never a crashed rig
  try { r = await worker.fetch(new Request('https://id.bento.page' + path, { method, body, headers }), env as never) } catch { return { status: -1, j: {}, h: new Headers(), text: '' } }
  const text = await r.text()
  let j: Record<string, unknown> = {}
  try { j = JSON.parse(text) } catch { /* empty */ }
  responses.push({ what: `${method} ${path}`, status: r.status, h: r.headers, text })
  return { status: r.status, j, h: r.headers, text }
}
const webCh = (address: string, o: { ip?: string; origin?: string | null } = {}) => raw('POST', WEB_ROUTES.challenge, JSON.stringify({ address }), o.origin === undefined ? S : o.origin, o.ip)
const homeCh = (address: string, o: { ip?: string; origin?: string | null } = {}) => raw('POST', HOME_ROUTES.challenge, JSON.stringify({ address }), o.origin === undefined ? H : o.origin, o.ip)

class Browser {
  W!: CryptoKeyPair; pub = ''; kx = ''
  static async make() {
    const b = new Browser()
    b.W = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair
    b.pub = b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', b.W.publicKey)))
    const k = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])) as CryptoKeyPair
    b.kx = b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey)))
    return b
  }
  text(address: string, c: { nonce: string; at: number; rosHash: string }, label: string | null = 'Chrome on Mac') {
    return buildDeviceCert({ kind: 'wdev', devicePub: this.pub, consentPub: null, kx: this.kx, address, rosHash: c.rosHash, label, via: 'passkey', ceremonyAt: c.at, dirNonce: c.nonce })
  }
  async wren(address: string, challenge: string, key = this.W.privateKey) {
    const text = buildWren({ devicePub: this.pub, address, challenge })
    return { wren: text, sig: await signStatement(key, text) }
  }
}
type ChOk = { nonce: string; at: number; rosHash: string }
async function chOf(address: string) { return (await webCh(address)).j as unknown as ChOk }
type EnrolOpts = { ch?: ChOk; text?: string; rq?: unknown; signer?: Authn; signText?: string; get?: GetOpts; origin?: string | null; ip?: string; credId?: string }
async function enrol(address: string, b: Browser, a: Authn, o: EnrolOpts = {}) {
  const ch = o.ch ?? await chOf(address)
  const text = o.text ?? b.text(address, ch)
  const as = await (o.signer ?? a).assert(o.signText ?? text, o.get)
  const body = { text, rq: o.rq === undefined ? H : o.rq, assertion: { id: o.credId ?? (o.signer ?? a).cid, userHandle: null, ...as } }
  const r = await raw('POST', WEB_ROUTES.enrol, JSON.stringify(body), o.origin === undefined ? S : o.origin, o.ip)
  return { ...r, text, ch }
}
async function checkin(address: string, b: Browser, o: { nonce?: string; pin?: string; key?: CryptoKey; origin?: string | null; wrenAddress?: string; ip?: string } = {}) {
  const nonce = o.nonce ?? (await homeCh(address)).j.nonce as string
  const w = await b.wren(o.wrenAddress ?? address, nonce, o.key)
  return { ...(await raw('POST', HOME_ROUTES.checkin, JSON.stringify({ ...w, ...(o.pin !== undefined ? { pin: o.pin } : {}) }), o.origin === undefined ? H : o.origin, o.ip)), nonce }
}
const logOf = async (email: string) => ((await doOp(email, 'logQuery', { from: 0, to: now })).j.entries ?? []) as Record<string, unknown>[]
const storeOf = async (email: string) => (await rosterObj(email)).store
const err = (r: { status: number; j: Record<string, unknown> }) => `${r.status} ${r.j.error ?? ''}`

// =====================================================================
// 0. the origins, and an account to work on
// =====================================================================
ok(HOME_ORIGIN === 'https://home.bento.page' && REQUESTERS.length === 1 && REQUESTERS[0] === HOME_ORIGIN, 'bento/home is the one opener, named once (passkey.js)')
ok(!passkeyOrigins().includes(HOME_ORIGIN), 'bento/home is never a ceremony origin')
ok(BROWSER_LIMITS.challengeTtlMs === 60_000 && WATT_MAX_MS === 24 * HOUR && CEREMONY_CAP_MS === 7 * DAY, 'a browser challenge lives 60 s; a countersign 24 h; the cap is 7 days (X4)')
const ana = 'ana@example.com', A1 = await Authn.make()
ok((await setup(ana, A1)).status === 200, 'ana is set up with one passkey')
const anaHead = async () => ((await storeOf(ana)).get('head') ?? { hash: '', seq: -1, ros: '' }) as { hash: string; seq: number; ros: string }

// =====================================================================
// 1. the challenge routes
// =====================================================================
{
  const c = await webCh(ana)
  const head = await anaHead()
  ok(c.status === 200 && /^[A-Za-z0-9_-]{22,86}$/.test(c.j.nonce as string) && c.j.at === now && c.j.rosHash === head.hash && Object.keys(c.j).length === 3,
    `web challenge → 200 {nonce, at = the directory's now, rosHash = the head} (${err(c)})`)
  ok(c.h.get('access-control-allow-origin') === SIGNIN_ORIGIN && /Origin/.test(c.h.get('vary') ?? ''), 'web challenge: CORS to the sign-in host alone, Vary: Origin')
  const hc = await homeCh(ana)
  ok(hc.status === 200 && typeof hc.j.nonce === 'string' && Object.keys(hc.j).length === 1, `home challenge → 200 {nonce} (${err(hc)})`)
  ok(hc.h.get('access-control-allow-origin') === H && /Origin/.test(hc.h.get('vary') ?? ''), 'home challenge: CORS to bento/home alone, Vary: Origin')
  ok((await webCh('nobody@example.com')).status === 404 && (await homeCh('nobody@example.com')).status === 404, 'both answer 404 for an address with no account')
  ok((await webCh(ana, { origin: H })).j.error === 'origin' && (await webCh(ana, { origin: null })).j.error === 'origin' && (await webCh(ana, { origin: 'https://attacker.example' })).status === 403,
    'web challenge from bento/home, another page or no Origin → 403 origin')
  ok((await homeCh(ana, { origin: S })).j.error === 'origin' && (await homeCh(ana, { origin: null })).status === 403, 'home challenge from the sign-in host or no Origin → 403 origin')
  // the audiences are apart from the roster's: a browser challenge is no roster challenge
  const wn = (await webCh(ana)).j.nonce as string
  const rr = await request(ana, A1, { add: await Authn.make(), ch: wn })
  ok(rr.status === 400 && rr.j.error === 'nonce', `a sign-in host challenge in a roster request → 400 nonce (${err(rr)})`)
  const rc = (await api('POST', '/v1/roster/challenge', { email: ana })).j.challenge as string
  const head0 = await anaHead()
  const rb = await enrol(ana, await Browser.make(), A1, { ch: { nonce: rc, at: Number(new DataView(b64uDec(rc)!.buffer).getBigUint64(0)), rosHash: head0.hash } })
  ok(rb.status === 400 && rb.j.error === 'nonce', `a roster challenge in a wdev. → 400 nonce (${err(rb)})`)
  ok((await raw('POST', WEB_ROUTES.challenge, '{"address":"bad"}', S)).j.error === 'bad-address' && (await raw('POST', WEB_ROUTES.challenge, 'nope', S)).j.error === 'bad-request', 'a bad address or body → 400')
  // nothing is stored when one is issued
  const before = JSON.stringify([...(await storeOf(ana)).entries()])
  for (let i = 0; i < 10; i++) { await webCh(ana); await homeCh(ana) }
  ok(JSON.stringify([...(await storeOf(ana)).entries()]) === before, 'twenty challenges store nothing in the address\'s object (nothing to fill, nothing to evict)')
}
{
  // the 404 routes spend the per-IP lookup budget GET /v1/roster spends
  const ip = freshIp()
  for (let i = 0; i < LIMITS.ip.lookup; i++) await api('GET', `/v1/roster?e=n${i}@example.com`, undefined, { ip })
  const r = await webCh(ana, { ip }), r2 = await homeCh(ana, { ip })
  ok(r.status === 429 && r2.status === 429, `after ${LIMITS.ip.lookup} lookups from one IP, both challenge routes → 429 (${r.status}, ${r2.status})`)
  ok((await webCh(ana)).status === 200, 'control: another IP gets one')
}
{
  const ip = freshIp(), st: number[] = []
  for (let i = 0; i <= LIMITS.ip.challengeAddr; i++) st.push((await webCh(ana, { ip })).status)
  ok(LIMITS.ip.challengeAddr === 20 && st.slice(0, -1).every((x) => x === 200) && st[st.length - 1] === 429, `enrolment challenge #${LIMITS.ip.challengeAddr + 1} for one address from one IP → 429 (last ${st[st.length - 1]})`)
  // renewals are counted apart: many tabs renewing never use up a new sign-in, nor the reverse
  const hs: number[] = []
  for (let i = 0; i <= LIMITS.ip.challengeAddrHome; i++) hs.push((await homeCh(ana, { ip })).status)
  ok(LIMITS.ip.challengeAddrHome === 20 && hs.slice(0, -1).every((x) => x === 200) && hs[hs.length - 1] === 429,
    `with the enrolment count used up, that IP still gets ${LIMITS.ip.challengeAddrHome} renewal challenges, then 429 (last ${hs[hs.length - 1]})`)
  ok((await webCh('nobody@example.com', { ip })).status === 404, 'the same IP may still ask about another address')
  ok((await webCh(ana)).status === 200 && (await homeCh(ana)).status === 200, 'and that IP\'s flood leaves every other caller\'s challenges for the address alone (no shared count)')
}

// =====================================================================
// 2. enrolment
// =====================================================================
const B1 = await Browser.make()
let anaWatt = ''
{
  const e = await enrol(ana, B1, A1)
  ok(e.status === 200 && e.j.ok === true && e.j.wdev === e.text && typeof e.j.watt === 'string' && Object.keys(e.j).length === 3, `enrol → 200 {ok, wdev: the text, watt} (${err(e)})`)
  ok(e.h.get('access-control-allow-origin') === SIGNIN_ORIGIN, 'enrol: CORS to the sign-in host')
  const w = parseWatt(e.j.watt as string)
  ok(w.ok && w.value.certHash === await sha256b64u(e.text) && w.value.ob === 1 && w.value.loggedAt === now && w.value.expires === now + WATT_MAX_MS && w.value.kid === 'dir-1',
    `the countersign: this certificate, ob 1 (bento/home asked), logged now, 24 h, kid dir-1 (${e.j.watt})`)
  anaWatt = e.j.watt as string
  const reuse = await enrol(ana, await Browser.make(), A1, { ch: e.ch })
  ok(reuse.status === 400 && reuse.j.error === 'nonce', `the same challenge again (a new key) → 400 nonce (${err(reuse)})`)
  const log = (await logOf(ana)).filter((x) => x.k === 'wdev')
  ok(log.length === 1 && log[0]?.pub === B1.pub && log[0]?.by === A1.pub && log[0]?.os === S && log[0]?.rq === H && log[0]?.co === S && log[0]?.ob === 1 && log[0]?.at === now,
    'the enrolment is logged: the device key and the passkey in full, the Origin, the opener, the ceremony origin, ob 1, the time')
  const again = await enrol(ana, B1, A1)
  ok(again.status === 409 && again.j.error === 'device-known', `a device key enrols once (a fresh key per ceremony) → 409 device-known (${err(again)})`)
}
{
  // 60 seconds
  const ch = await chOf(ana)
  now += BROWSER_LIMITS.challengeTtlMs + 1
  const late = await enrol(ana, await Browser.make(), A1, { ch })
  ok(late.status === 400 && late.j.error === 'nonce', `a challenge 60 s + 1 ms old → 400 nonce (${err(late)})`)
  const ch2 = await chOf(ana)
  now += BROWSER_LIMITS.challengeTtlMs
  const edge = await enrol(ana, await Browser.make(), A1, { ch: ch2 })
  ok(edge.status === 200, `control: at exactly 60 s it is still good (${err(edge)})`)
  const hn = (await homeCh(ana)).j.nonce as string
  now += BROWSER_LIMITS.challengeTtlMs + 1
  const hl = await checkin(ana, B1, { nonce: hn })
  ok(hl.status === 400 && hl.j.error === 'nonce', `a home challenge 60 s + 1 ms old → 400 nonce (${err(hl)})`)
}
{
  // the audiences: each challenge is spent at the wrong door too
  const hn = (await homeCh(ana)).j.nonce as string
  const head = await anaHead()
  const B = await Browser.make()
  const x = await enrol(ana, B, A1, { ch: { nonce: hn, at: now, rosHash: head.hash } })
  ok(x.status === 400 && x.j.error === 'nonce', `a bento/home challenge in a wdev. → 400 nonce (${err(x)})`)
  const after = await checkin(ana, B1, { nonce: hn })
  ok(after.status === 400 && after.j.error === 'nonce', `and it is used up: the same challenge in a renewal → 400 nonce (${err(after)})`)
  const wn = await chOf(ana)
  const y = await checkin(ana, B1, { nonce: wn.nonce })
  ok(y.status === 400 && y.j.error === 'nonce', `a sign-in host challenge in a wren. → 400 nonce (${err(y)})`)
  const z = await enrol(ana, B, A1, { ch: wn })
  ok(z.status === 400 && z.j.error === 'nonce', `and it is used up: the same challenge in an enrolment → 400 nonce (${err(z)})`)
  const ctl = await enrol(ana, B, A1)
  ok(ctl.status === 200, `control: a fresh challenge enrols the same browser (${err(ctl)})`)
}
{
  // another address's challenge
  const bea = 'bea@example.com', Bp = await Authn.make()
  await setup(bea, Bp)
  const bc = await chOf(bea)
  const head = await anaHead()
  const B = await Browser.make()
  const x = await enrol(ana, B, A1, { ch: { ...bc, rosHash: head.hash } })
  ok(x.status === 400 && x.j.error === 'nonce', `a challenge issued for another address → 400 nonce (${err(x)})`)
  const hb = (await homeCh(bea)).j.nonce as string
  const y = await checkin(ana, B1, { nonce: hb })
  ok(y.status === 400 && y.j.error === 'nonce', `a renewal on another address's challenge → 400 nonce (${err(y)})`)
}
{
  // a failed assertion burns its challenge
  const B = await Browser.make()
  const ch = await chOf(ana)
  const bad = await enrol(ana, B, A1, { ch, signText: 'wdev.something-else' })
  ok(bad.status === 403 && bad.j.error === 'assertion', `an assertion over another text → 403 assertion (${err(bad)})`)
  const good = await enrol(ana, B, A1, { ch })
  ok(good.status === 400 && good.j.error === 'nonce', `then the right assertion on the same challenge → 400 nonce: the failure spent it (${err(good)})`)
  const home = await enrol(ana, B, A1, { get: { origin: H } })
  ok(home.status === 403 && home.j.error === 'assertion', `an assertion made on bento/home's origin → 403 assertion (${err(home)})`)
  const rp = await enrol(ana, B, A1, { get: { rpId: 'bento.page' } })
  ok(rp.status === 403 && rp.j.error === 'assertion', `an assertion for rp bento.page → 403 assertion (${err(rp)})`)
  // the stored counter, on another account (ana's passkey stays at 0)
  const gil = 'gil@example.com', G1 = await Authn.make()
  await setup(gil, G1)
  const c5 = await enrol(gil, await Browser.make(), G1, { get: { count: 5 } })
  ok(c5.status === 200, `an assertion with counter 5 enrols (${err(c5)})`)
  const c3 = await enrol(gil, await Browser.make(), G1, { get: { count: 3 } })
  ok(c3.status === 403 && c3.j.error === 'assertion', `then one with counter 3 → 403 assertion (the stored counter) (${err(c3)})`)
}
{
  // the rest of the order
  const B = await Browser.make()
  const ch = await chOf(ana)
  const t1 = await enrol(ana, B, A1, { ch, text: B.text(ana, { ...ch, at: ch.at + 1 }) })
  ok(t1.status === 400 && t1.j.error === 'ceremony', `a ceremony time that is not the challenge's → 400 ceremony (${err(t1)})`)
  const old = await sha256b64u('ros.not-a-head')
  const t2 = await enrol(ana, B, A1, { text: undefined, ch: { ...(await chOf(ana)), rosHash: old } })
  ok(t2.status === 400 && t2.j.error === 'head', `a rosHash that is not the head → 400 head (${err(t2)})`)
  const rq = await enrol(ana, B, A1, { rq: 'https://attacker.example' })
  ok(rq.status === 400 && rq.j.error === 'rq', `an opener that is not bento/home → 400 rq (${err(rq)})`)
  const stranger = await Authn.make()
  const s1 = await enrol(ana, B, stranger)
  ok(s1.status === 403 && s1.j.error === 'signer', `a passkey that is not on the roster → 403 signer (${err(s1)})`)
  const s2 = await enrol(ana, B, stranger, { credId: A1.cid })
  ok(s2.status === 403 && s2.j.error === 'assertion', `a stranger's assertion under a member's credential id → 403 assertion (${err(s2)})`)
  // a suspended passkey (planted, as the void page's Remove leaves it) certifies nothing
  const hd = ((await storeOf(ana)).get('head') ?? { members: [] }) as { members: Member[] }
  await plant(ana, (st) => { const x = st.get('head') as Record<string, unknown>; st.set('head', { ...x, members: hd.members.map((m) => ({ ...m, quarantined: true })) }) })
  const sq = await enrol(ana, B, A1)
  await plant(ana, (st) => { const x = st.get('head') as Record<string, unknown>; st.set('head', { ...x, members: hd.members }) })
  ok(sq.status === 403 && sq.j.error === 'signer', `a suspended passkey → 403 signer (${err(sq)})`)
  const o = await enrol(ana, B, A1, { origin: null })
  ok(o.status === 403 && o.j.error === 'origin', 'enrol with no Origin → 403 origin')
  const dv2 = buildDeviceCert({ kind: 'dev2', devicePub: B.pub, consentPub: null, kx: B.kx, address: ana, rosHash: ch.rosHash, label: null, via: 'passkey', ceremonyAt: ch.at, dirNonce: ch.nonce })
  const d2 = await raw('POST', WEB_ROUTES.enrol, JSON.stringify({ text: dv2, rq: H, assertion: { id: A1.cid, ...(await A1.assert(dv2)) } }), S)
  ok(d2.status === 400 && d2.j.error === 'text', `a dev2. on the sign-in host's route → 400 text (${err(d2)})`)
  // no key, nothing stored
  const pk0 = JSON.stringify((await storeOf(ana)).get(`pk:${A1.pub}`))
  const nk = await (async () => { const e0 = env.DIR_KEY_JWK; env.DIR_KEY_JWK = undefined; try { return await enrol(ana, B, A1, { get: { count: 9 } }) } finally { env.DIR_KEY_JWK = e0; A1.count = 0 } })()
  ok(nk.status === 500 && !(await storeOf(ana)).has(`wd:${B.pub}`) && JSON.stringify((await storeOf(ana)).get(`pk:${A1.pub}`)) === pk0,
    `DIR_KEY_JWK unset: 500, no certificate stored and the signature counter untouched (${err(nk)})`)
}
{
  // the latest RIPENED head
  const A2 = await Authn.make()
  const q = await request(ana, A1, { add: A2, rq: H })
  ok(q.status === 202, `ana queues an add (${err(q)})`)
  const was = await anaHead()
  const c1 = await chOf(ana)
  ok(c1.rosHash === was.hash, 'while it waits, the challenge names the current head, not the waiting one')
  const queued = await enrol(ana, await Browser.make(), A1, { ch: { ...(await chOf(ana)), rosHash: await sha256b64u(q.ros) } })
  ok(queued.status === 400 && queued.j.error === 'head', `a wdev. naming the waiting change → 400 head (${err(queued)})`)
  now += ROSTER_WAIT_MS
  const c2 = await chOf(ana) // no alarm has run: the route ripens what is due
  ok(c2.rosHash === await sha256b64u(q.ros) && c2.rosHash !== was.hash, 'once it is due, the challenge names the ripened head, with no alarm run first')
  const e = await enrol(ana, await Browser.make(), A2, { ch: c2 })
  ok(e.status === 200, `the added passkey enrols a browser on the new head (${err(e)})`)
  const log = await logOf(ana)
  ok(log.every((x) => x.ob === (x.rq === H ? 1 : 0)) && log.some((x) => x.k === 'request' && x.ob === 1) && log.some((x) => x.k === 'setup' && x.ob === 0),
    'every log entry carries ob: 1 exactly where bento/home was the opener (the add), 0 elsewhere (setup)')
}

// =====================================================================
// 3. check-in (renewal) and the 7 days
// =====================================================================
const cara = 'cara@example.com', C1 = await Authn.make(), C2 = await Authn.make()
await setup(cara, C1)
await request(cara, C1, { add: C2 })
now += ROSTER_WAIT_MS
const CB = await Browser.make()
const ce = await enrol(cara, CB, C2)
const ceremony = ce.ch.at ?? now // never NaN into the clock, whatever a mutant did to the enrolment
ok(ce.status === 200, `cara's second passkey enrols a browser (${err(ce)})`)
{
  now += HOUR
  const r = await checkin(cara, CB)
  ok(r.status === 200 && ['watt', 'wattSig', 'signer', 'assertion', 'roster', 'incidents'].every((k) => k in r.j) && Object.keys(r.j).length === 6, `check-in → 200 {watt, wattSig, signer, assertion, roster, incidents} (${err(r)})`)
  ok(r.h.get('access-control-allow-origin') === H, 'check-in: CORS to bento/home alone')
  const w = parseWatt(r.j.watt as string)
  ok(w.ok && w.value.loggedAt === now && w.value.expires === now + WATT_MAX_MS && w.value.ob === 1 && w.value.certHash === await sha256b64u(ce.text), 'a fresh countersign over the SAME certificate, logged now, 24 h')
  ok(JSON.stringify(r.j.incidents) === '[]', 'no incident records published')
  const ch = await verifyRosterChain(r.j.roster as RosterLink[], { directoryKeys: DIR_KEYS, rpId: ROSTER_RP_ID, origins: [...ROSTER_WEB_ORIGINS], now })
  ok(ch.ok && (r.j.roster as unknown[] | undefined)?.length === 2, `the roster from setup verifies with the kernel (${ch.ok ? 'ok' : ch.reason})`)
  const v = ch.ok ? await verifyDevice({ cert: ce.text, signer: r.j.signer as string, assertion: r.j.assertion as never, watt: r.j.watt as string, wattSig: r.j.wattSig as string },
    { roster: ch.value, directoryKeys: DIR_KEYS, rpId: ROSTER_RP_ID, origins: [...ROSTER_WEB_ORIGINS], now }) : null
  ok(v?.ok && v.value.tier === 'passkey' && r.j.signer === C2.pub, `the kernel's verifyDevice accepts the certificate with what the check-in returned (${v ? (v.ok ? 'ok' : v.reason) : 'no chain'})`)
  const headHash = ((await (await storeOf(cara)).get('head')) as { hash: string } | undefined)?.hash ?? ''
  const pinned = await checkin(cara, CB, { pin: headHash })
  ok(pinned.status === 200 && (pinned.j.roster as RosterLink[] | undefined)?.length === 1 && await sha256b64u((pinned.j.roster as RosterLink[])[0]?.ros ?? '') === headHash, 'pinned at the head: the roster starts at it')
  const other = await checkin(cara, CB, { pin: await sha256b64u('ros.elsewhere') })
  ok(other.status === 200 && (other.j.roster as unknown[] | undefined)?.length === 2, 'a pin that is not a head of this account: the roster from setup')
  const again = await raw('POST', HOME_ROUTES.checkin, JSON.stringify(await CB.wren(cara, r.nonce)), H)
  ok(again.status === 400 && again.j.error === 'nonce', `the same challenge again → 400 nonce (${err(again)})`)
  const hn = (await homeCh(cara)).j.nonce as string
  const forged = await checkin(cara, CB, { nonce: hn, key: (await Browser.make()).W.privateKey })
  ok(forged.status === 400 && forged.j.error === 'wren', `a wren. signed by another key → 400 wren (${err(forged)})`)
  const after = await checkin(cara, CB, { nonce: hn })
  ok(after.status === 200, `the refused signature left the challenge to the browser that asked (${err(after)})`)
  const nobody = await checkin(cara, await Browser.make())
  ok(nobody.status === 403 && nobody.j.error === 'unknown' && Array.isArray(nobody.j.incidents), `a key never enrolled → 403 unknown, with the incidents (${err(nobody)})`)
  ok((await checkin(cara, CB, { origin: S })).j.error === 'origin' && (await checkin(cara, CB, { origin: null })).status === 403, 'check-in from the sign-in host or no Origin → 403 origin')
}
{
  // the 7 days, counted from the ceremony
  now = ceremony + CEREMONY_CAP_MS - 12 * HOUR
  const r = await checkin(cara, CB)
  const w = parseWatt(r.j.watt as string)
  ok(r.status === 200 && w.ok && w.value.expires === ceremony + CEREMONY_CAP_MS, `12 h before the cap: a countersign that ends AT the cap, not 24 h on (${w.ok ? w.value.expires - ceremony : err(r)})`)
  now = ceremony + CEREMONY_CAP_MS - 1
  ok((await checkin(cara, CB)).status === 200, 'a millisecond before the cap: renewed')
  now = ceremony + CEREMONY_CAP_MS
  const cap = await checkin(cara, CB)
  ok(cap.status === 403 && cap.j.error === 'cap' && Array.isArray(cap.j.incidents), `at the cap → 403 cap (${err(cap)})`)
  const st = await api('GET', `${STATUS_ROUTE}?e=${cara}&c=${await sha256b64u(ce.text)}`)
  ok(st.status === 200 && st.j.state === 'cap' && st.h.get('access-control-allow-origin') === '*', `status: cap, CORS * (${st.j.state})`)
  const fresh = await enrol(cara, await Browser.make(), C2)
  ok(fresh.status === 200, 'a new ceremony (a new key) carries on')
  now += BROWSER_LIMITS.keepAfterCapMs + 1
  await enrol(cara, await Browser.make(), C2) // each enrolment sweeps
  ok(!(await storeOf(cara)).has(`wd:${CB.pub}`) && (await logOf(cara)).some((x) => x.k === 'wdev' && x.pub === CB.pub), 'a day past the cap the certificate is deleted; its log entry stays')
  ok((await api('GET', `${STATUS_ROUTE}?e=${cara}&c=${await sha256b64u(ce.text)}`)).j.state === 'unknown', 'status then: unknown')
}

// =====================================================================
// 4. revoked: a passkey removed or suspended, sign out everywhere
// =====================================================================
{
  const dee = 'dee@example.com', D1 = await Authn.make(), D2 = await Authn.make()
  await setup(dee, D1)
  await request(dee, D1, { add: D2 })
  now += ROSTER_WAIT_MS
  const DB = await Browser.make(), DB1 = await Browser.make()
  const e = await enrol(dee, DB, D2)
  await enrol(dee, DB1, D1)
  const hash = await sha256b64u(e.text)
  ok((await api('GET', `${STATUS_ROUTE}?e=${dee}&c=${hash}`)).j.state === 'ok', 'status: ok while it renews')
  ok((await checkin(dee, DB)).status === 200, 'control: it renews')
  const rm = await request(dee, D2, { remove: D2.pub })
  ok(rm.status === 200 && rm.j.inForce === true, 'the passkey that made it removes itself (at once)')
  const r = await checkin(dee, DB)
  ok(r.status === 403 && r.j.error === 'revoked', `a certificate whose passkey was removed → 403 revoked (${err(r)})`)
  ok((await api('GET', `${STATUS_ROUTE}?e=${dee}&c=${hash}`)).j.state === 'revoked', 'status: revoked')
  // suspended (planted, as the void page's Remove leaves it)
  const h = ((await storeOf(dee)).get('head') ?? { members: [] }) as { members: Member[] }
  await plant(dee, (st) => { const x = st.get('head') as Record<string, unknown>; st.set('head', { ...x, members: h.members.map((m) => ({ ...m, quarantined: true })) }) })
  const q = await checkin(dee, DB1)
  ok(q.status === 403 && q.j.error === 'revoked', `a certificate whose passkey is suspended → 403 revoked (${err(q)})`)
  await plant(dee, (st) => { const x = st.get('head') as Record<string, unknown>; st.set('head', { ...x, members: h.members }) })
  ok((await checkin(dee, DB1)).status === 200, 'control: put back, it renews')
  // re-added since the ceremony: the old certificate stays dead
  now += 1
  await plant(dee, (st) => { const x = st.get(`pk:${D1.pub}`) as Record<string, unknown> | undefined; if (x) st.set(`pk:${D1.pub}`, { ...x, addedAt: now }) })
  const re = await checkin(dee, DB1)
  ok(re.status === 403 && re.j.error === 'revoked', `a passkey (re)added after the ceremony → 403 revoked (${err(re)})`)
}
{
  const eve = 'eve@example.com', E1 = await Authn.make()
  await setup(eve, E1)
  const EB = [await Browser.make(), await Browser.make()]
  for (const b of EB) await enrol(eve, b, E1)
  const out = await doOp(eve, 'browserRevokeAll', { by: E1.pub, os: S })
  ok(out.status === 200 && out.j.revoked === 2, `sign out everywhere in browsers: both certificates revoked (${JSON.stringify(out.j)})`)
  const rs = await Promise.all(EB.map((b) => checkin(eve, b)))
  ok(rs.every((r) => r.status === 403 && r.j.error === 'revoked'), `each renewal then → 403 revoked (${rs.map(err).join(', ')})`)
  const log = (await logOf(eve)).find((x) => x.k === 'signout-all')
  ok(log?.n === 2 && log.pub === E1.pub && log.by === E1.pub && log.ob === 0 && log.at === now && log.signedAt === now, 'logged as signout-all: who, how many, signed and applied when, ob 0')
  const st0 = await api('GET', `${STATUS_ROUTE}?e=${eve}&c=${await sha256b64u(buildDeviceCert({ kind: 'wdev', devicePub: EB[0].pub, consentPub: null, kx: EB[0].kx, address: eve, rosHash: '', label: null, via: 'passkey', ceremonyAt: 0, dirNonce: '' }))}`)
  ok(st0.status === 200, 'status answers for an address that signed out')
  const m = lastMail(eve) ?? NOMAIL
  ok(m.kind === 'roster' && m.subject === 'Every browser was signed out of your bento/id account' && m.body.includes(await fingerprintOf(E1.pub)) && /Apps on your devices are not affected/.test(m.body) && /can still be accepted for up to 24 hours/.test(m.body),
    `the address is told, by roster mail, naming the passkey (${m.subject})`)
  // a ceremony whose challenge was issued before the sign-out cannot finish after it
  const early = await chOf(eve)
  await doOp(eve, 'browserRevokeAll', { by: E1.pub, os: S })
  const late = await enrol(eve, await Browser.make(), E1, { ch: early })
  ok(late.status === 403 && late.j.error === 'revoked', `a ceremony begun before a sign-out, finished after it → 403 revoked (${err(late)})`)
  now += 1
  const nb = await Browser.make()
  ok((await enrol(eve, nb, E1)).status === 200 && (await checkin(eve, nb)).status === 200, 'a browser signed in afterwards renews')
  // the cut-off is when the sign-out is ACCEPTED, not the time it was signed (security's D3 on #953)
  const signedAt = now - 1
  now += 30_000
  const between = await chOf(eve) // a ceremony begun after the signing, before the acceptance
  now += 30_000
  const nbHash = (await storeOf(eve)).get(`wd:${nb.pub}`) as { certHash?: string } | undefined
  const late2 = await doOp(eve, 'browserRevokeAll', { by: E1.pub, os: S, signedAt })
  ok(late2.j.revoked === 1 && late2.j.at === now && late2.j.signedAt === signedAt && (await checkin(eve, nb)).j.error === 'revoked',
    `a certificate made between the signing and the acceptance is cut off too (${JSON.stringify(late2.j)})`)
  const lg = (await logOf(eve)).filter((x) => x.k === 'signout-all').pop()
  ok(lg?.signedAt === signedAt && lg?.at === now, 'the log names both: signed at, applied at')
  const btw = await enrol(eve, await Browser.make(), E1, { ch: between })
  ok(btw.status === 403 && btw.j.error === 'revoked', `a ceremony begun between the signing and the acceptance cannot finish after it (${err(btw)})`)
  // W1: the status route says so at once, for peers that check it
  const st1 = await api('GET', `${STATUS_ROUTE}?e=${eve}&c=${nbHash?.certHash ?? 'x'}`)
  ok(st1.j.state === 'revoked', `status: revoked as soon as the sign-out is accepted (${st1.j.state})`)
  now += 1
  const nb2 = await Browser.make()
  ok((await enrol(eve, nb2, E1)).status === 200 && (await checkin(eve, nb2)).status === 200, 'a browser signed in after the cut-off renews')
  ok((await api('GET', `${STATUS_ROUTE}?e=${eve}&c=${await sha256b64u('x')}`)).j.state === 'unknown', 'control: status for a certificate never made is unknown')
}

// =====================================================================
// 4b. the sign-in host's own pages: passkey sign-in, and sign out everywhere
// =====================================================================
/** An assertion over RAW challenge bytes (a sign-in), with a user handle. */
async function assertRaw(a: Authn, bytes: Uint8Array, o: GetOpts & { handle?: Uint8Array | null } = {}) {
  if (o.count !== undefined) a.count = o.count
  const c = a.count
  const ad = cat(await sha256(te.encode(o.rpId ?? 'id.bento.page')), new Uint8Array([o.flags ?? 0x05, (c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255, c & 255]))
  const cdj = te.encode(JSON.stringify({ type: 'webauthn.get', challenge: b64uEnc(bytes), origin: o.origin ?? S, crossOrigin: false }))
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, a.kp.privateKey, cat(ad, await sha256(cdj)) as BufferSource))
  const out: Record<string, unknown> = { id: a.cid, authenticatorData: b64uEnc(ad), clientDataJSON: b64uEnc(cdj), signature: b64uEnc(rawToDer(sig)) }
  if (o.handle !== null) out.userHandle = b64uEnc(o.handle ?? new Uint8Array(48))
  return out
}
const handleFor = async (address: string, len = 48) => { const h = new Uint8Array(len); h.set(b64uDec(b64uEnc(Uint8Array.from((await addressKey(address)).match(/../g)!.map((x) => parseInt(x, 16)))))!.subarray(0, Math.min(32, len))); return h }
async function fingerprintOf(pub: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b64uDec(pub)! as BufferSource))].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 8) }
const signinCh = async (o: { origin?: string | null } = {}) => raw('POST', WEB_ROUTES.signinChallenge, '{}', o.origin === undefined ? S : o.origin)
async function signin(a: Authn, address: string, o: GetOpts & { nonce?: string; handle?: Uint8Array | null; over?: Uint8Array } = {}) {
  const nonce = o.nonce ?? (await signinCh()).j.nonce as string
  const as = await assertRaw(a, o.over ?? b64uDec(nonce ?? '') ?? new Uint8Array(16), { ...o, handle: o.handle === undefined ? await handleFor(address) : o.handle })
  return { ...(await raw('POST', WEB_ROUTES.signin, JSON.stringify({ nonce, assertion: as }), S)), nonce }
}
/** The route answers 501 until the kernel's statement exists, so the rows mint the challenge it would issue. */
const mintSignout = async (address: string) => ({ nonce: await issueChallenge(env.CHALLENGE_KEY as string, 'signout', await addressKey(address), now), at: now })
const woutText = (address: string, at: number, nonce: string) => ['wout', b64uEnc(te.encode(address)), String(at), nonce].join('.')
async function signout(a: Authn, address: string, o: GetOpts & { ch?: { nonce: string; at: number }; text?: string; signText?: string } = {}) {
  const ch = o.ch ?? await mintSignout(address)
  const text = o.text ?? woutText(address, ch.at, ch.nonce)
  const as = { id: a.cid, ...(await a.assert(o.signText ?? text, o)) }
  return { ...(await raw('POST', WEB_ROUTES.signout, JSON.stringify({ text, assertion: as }), S)), ch, text }
}
{
  const hal = 'hal@example.com', H1 = await Authn.make(), H2 = await Authn.make()
  await setup(hal, H1)
  await request(hal, H1, { add: H2 })
  now += ROSTER_WAIT_MS
  await chOf(hal) // ripen
  const HB = await Browser.make()
  ok((await enrol(hal, HB, H1)).status === 200, 'hal has two passkeys and a browser')
  const m0 = mailbox.length, l0 = (await logOf(hal)).length

  // sign-in
  const c = await signinCh()
  ok(c.status === 200 && b64uDec(c.j.nonce as string)?.length === 40 && Object.keys(c.j).length === 1 && c.h.get('access-control-allow-origin') === SIGNIN_ORIGIN, 'sign-in challenge → 200 {nonce}: 40 bytes, CORS to the sign-in host')
  ok((await signinCh({ origin: H })).j.error === 'origin' && (await signinCh({ origin: null })).status === 403, 'sign-in challenge from another page or none → 403 origin')
  const ok1 = await signin(H1, hal, { nonce: c.j.nonce as string, count: 3 })
  ok(ok1.status === 200 && ok1.j.address === hal && Object.keys(ok1.j).length === 1, `sign-in → 200 {address} (${err(ok1)})`)
  ok(((await storeOf(hal)).get(`pk:${H1.pub}`) as { signCount?: number } | undefined)?.signCount === 3, 'the passkey\'s signature counter is stored')
  const again = await signin(H1, hal, { nonce: c.j.nonce as string, count: 4 })
  ok(again.status === 400 && again.j.error === 'nonce', `the same challenge again → 400 nonce (${err(again)})`)
  const back = await signin(H1, hal, { count: 2 })
  ok(back.status === 400 && back.j.error === 'assertion-sign-count', `a counter that goes back → 400 assertion-sign-count (${err(back)})`)
  H1.count = 5
  const c5 = (await signinCh()).j.nonce as string
  now += 5 * MIN + 1
  const late = await signin(H1, hal, { nonce: c5, count: 6 })
  ok(late.status === 400 && late.j.error === 'nonce', `a sign-in challenge 5 min + 1 ms old → 400 nonce (${err(late)})`)
  const c6 = (await signinCh()).j.nonce as string
  now += 5 * MIN
  ok((await signin(H1, hal, { nonce: c6, count: 7 })).status === 200, 'control: at exactly 5 minutes it is still good')
  const wn = (await webCh(hal)).j.nonce as string
  const xa = await signin(H1, hal, { nonce: wn, count: 8 })
  ok(xa.status === 400 && xa.j.error === 'nonce', `a sign-in host enrolment challenge used to sign in → 400 nonce (${err(xa)})`)
  const so = (await mintSignout(hal)).nonce
  const xb = await signin(H1, hal, { nonce: so, count: 8 })
  ok(xb.status === 400 && xb.j.error === 'nonce', `a sign-out challenge used to sign in → 400 nonce (${err(xb)})`)
  const h47 = await signin(H1, hal, { handle: (await handleFor(hal)).subarray(0, 47), count: 8 })
  ok(h47.status === 400 && h47.j.error === 'assertion', `a user handle of 47 bytes → 400 assertion (${err(h47)})`)
  const h0 = await signin(H1, hal, { handle: null, count: 8 })
  ok(h0.status === 400 && h0.j.error === 'assertion', `no user handle → 400 assertion (${err(h0)})`)
  const other = await signin(H1, ana, { count: 8 })
  ok(other.status === 403 && other.j.error === 'not-member', `a handle naming another account → 403 not-member (${err(other)})`)
  const stranger = await signin(await Authn.make(), hal)
  ok(stranger.status === 403 && stranger.j.error === 'not-member', `a passkey that is not a member → 403 not-member (${err(stranger)})`)
  const bn = (await signinCh()).j.nonce as string
  const bad = await signin(H1, hal, { nonce: bn, over: crypto.getRandomValues(new Uint8Array(40)), count: 9 })
  ok(bad.status === 400 && /^assertion-/.test(bad.j.error as string), `an assertion over other bytes → 400 assertion-… (${err(bad)})`)
  const burnt = await signin(H1, hal, { nonce: bn, count: 10 })
  ok(burnt.status === 400 && burnt.j.error === 'nonce', `then the right one on that challenge → 400 nonce: the failure spent it (${err(burnt)})`)
  const ho = await signin(H1, hal, { origin: H, count: 11 })
  ok(ho.status === 400 && ho.j.error === 'assertion-origin', `an assertion made on bento/home → 400 assertion-origin (${err(ho)})`)
  const uv = await signin(H1, hal, { flags: 0x01, count: 12 })
  ok(uv.status === 400 && uv.j.error === 'assertion-uv', `no user verification → 400 assertion-uv (${err(uv)})`)
  ok(mailbox.length === m0 && (await logOf(hal)).length === l0, 'signing in logged and mailed nothing')

  // sign out everywhere: every check runs, then 501 until the kernel defines the statement
  const sc = await raw('POST', WEB_ROUTES.signoutChallenge, JSON.stringify({ address: hal }), S)
  ok(sc.status === 501 && sc.j.error === 'not-implemented', `sign-out challenge → 501 until the kernel defines the statement, before any passkey prompt (${err(sc)})`)
  ok((await raw('POST', WEB_ROUTES.signoutChallenge, JSON.stringify({ address: 'nobody@example.com' }), S)).status === 404, 'sign-out challenge for no account → 404')
  {
    const ip = freshIp()
    for (let i = 0; i < LIMITS.ip.lookup; i++) await api('GET', `/v1/roster?e=n${i}@example.com`, undefined, { ip })
    ok((await raw('POST', WEB_ROUTES.signoutChallenge, JSON.stringify({ address: hal }), S, ip)).status === 429, 'the sign-out challenge spends the per-IP lookup budget')
  }
  H2.count = 1
  const s1 = await signout(H2, hal, { count: 1 })
  ok(s1.status === 501 && s1.j.error === 'not-implemented', `a sign-out that passes every check → 501 until the kernel defines its statement (${err(s1)})`)
  ok((await checkin(hal, HB)).status === 200 && !(await storeOf(hal)).has('signoutAt'), 'and nothing was revoked')
  ok(((await storeOf(hal)).get(`pk:${H2.pub}`) as { signCount?: number } | undefined)?.signCount === 1, 'its passkey\'s counter is stored')
  const r1 = await signout(H2, hal, { ch: s1.ch, count: 2 })
  ok(r1.status === 400 && r1.j.error === 'nonce', `the same challenge again → 400 nonce (${err(r1)})`)
  const ch2 = await mintSignout(hal)
  const r2 = await signout(H2, hal, { ch: { ...ch2, at: ch2.at - 1 }, count: 3 })
  ok(r2.status === 400 && r2.j.error === 'nonce', `a text whose time is not the challenge's → 400 nonce (${err(r2)})`)
  const r3 = await signout(H2, hal, { ch: ch2, count: 4 })
  ok(r3.status === 400 && r3.j.error === 'nonce', `then the right text → 400 nonce: the mismatch spent it (${err(r3)})`)
  const anaCh = await mintSignout(ana)
  const r4 = await signout(H2, hal, { ch: anaCh, count: 5 })
  ok(r4.status === 400 && r4.j.error === 'nonce', `another address's challenge → 400 nonce (${err(r4)})`)
  const sn = (await signinCh()).j.nonce as string
  const r5 = await signout(H2, hal, { ch: { nonce: sn, at: now }, count: 6 })
  ok(r5.status === 400 && r5.j.error === 'nonce', `a sign-in challenge in a sign-out → 400 nonce (${err(r5)})`)
  for (const [what, t] of [['three fields', `wout.${b64uEnc(te.encode(hal))}.${now}`], ['a time with a leading zero', `wout.${b64uEnc(te.encode(hal))}.0${now}.x`],
    ['an address not in normal form', woutText('Hal@Example.com', now, 'x')], ['another prefix', `wdev.${b64uEnc(te.encode(hal))}.${now}.x`]] as const) {
    const r = await raw('POST', WEB_ROUTES.signout, JSON.stringify({ text: t, assertion: {} }), S)
    ok(r.status === 400 && r.j.error === 'text', `a sign-out text with ${what} → 400 text (${err(r)})`)
  }
  const nm = await signout(await Authn.make(), hal)
  ok(nm.status === 403 && nm.j.error === 'not-member', `a sign-out by a passkey that is not a member → 403 not-member (${err(nm)})`)
  const ov = await signout(H2, hal, { signText: 'wout.other', count: 7 })
  ok(ov.status === 400 && /^assertion-/.test(ov.j.error as string), `an assertion over another text → 400 assertion-… (${err(ov)})`)
  const hd = ((await storeOf(hal)).get('head') ?? { members: [] }) as { members: Member[] }
  await plant(hal, (st) => { const x = st.get('head') as Record<string, unknown>; st.set('head', { ...x, members: hd.members.map((m) => (m.pub === H2.pub ? { ...m, quarantined: true } : m)) }) })
  const q1 = await signout(H2, hal, { count: 8 })
  const q2 = await signin(H2, hal, { count: 9 })
  await plant(hal, (st) => { const x = st.get('head') as Record<string, unknown>; st.set('head', { ...x, members: hd.members }) })
  ok(q1.status === 403 && q1.j.error === 'quarantined' && q2.status === 403 && q2.j.error === 'quarantined', `a suspended passkey: sign-out and sign-in → 403 quarantined (${err(q1)}, ${err(q2)})`)
  ok((await signout(H2, hal, { count: 10 })).status === 501, 'control: put back, it reaches the last step again')
  ok((await raw('POST', WEB_ROUTES.signout, JSON.stringify({ text: woutText(hal, now, 'x'), assertion: {} }), H)).j.error === 'origin', 'a sign-out from bento/home → 403 origin')

  // D1: each purpose's challenge is refused at every other door
  const head = ((await storeOf(hal)).get('head') ?? { hash: '' }) as { hash: string }
  const sgn = (await signinCh()).j.nonce as string
  const d1 = await enrol(hal, await Browser.make(), H1, { ch: { nonce: sgn, at: now, rosHash: head.hash }, count: 20 })
  ok(d1.status === 400 && d1.j.error === 'nonce', `a sign-in challenge in a wdev. → 400 nonce (${err(d1)})`)
  const sot = await mintSignout(hal)
  const d2 = await enrol(hal, await Browser.make(), H1, { ch: { ...sot, rosHash: head.hash }, count: 20 })
  ok(d2.status === 400 && d2.j.error === 'nonce', `a sign-out challenge in a wdev. → 400 nonce (${err(d2)})`)
  const d3 = await checkin(hal, HB, { nonce: (await mintSignout(hal)).nonce })
  ok(d3.status === 400 && d3.j.error === 'nonce', `a sign-out challenge in a wren. → 400 nonce (${err(d3)})`)
  const rc = (await api('POST', '/v1/roster/challenge', { email: hal })).j.challenge as string
  const d4 = await signin(H1, hal, { nonce: rc, count: 20 })
  ok(d4.status === 400 && d4.j.error === 'nonce', `a roster challenge used to sign in → 400 nonce (${err(d4)})`)
  const d5 = await signout(H2, hal, { ch: { nonce: rc, at: Number(new DataView(b64uDec(rc)!.buffer).getBigUint64(0)) }, count: 20 })
  ok(d5.status === 400 && d5.j.error === 'nonce', `a roster challenge in a sign-out → 400 nonce (${err(d5)})`)
  const wch = await chOf(hal)
  const d6 = await signout(H2, hal, { ch: { nonce: wch.nonce, at: wch.at }, count: 21 })
  ok(d6.status === 400 && d6.j.error === 'nonce', `a sign-in host enrolment challenge in a sign-out → 400 nonce (${err(d6)})`)
  const d7 = await request(hal, H1, { remove: H2.pub, ch: (await mintSignout(hal)).nonce, get: { count: 21 } })
  ok(d7.status === 400 && d7.j.error === 'nonce', `a sign-out challenge in a roster request → 400 nonce (${err(d7)})`)

  // D2: a handle naming no account writes nothing anywhere
  const ghost = 'ghost@example.com'
  const g = await signin(H1, ghost, { count: 22 })
  const gs = ROSTER.objs.get(await addressKey(ghost))?.store
  ok(g.status === 403 && g.j.error === 'not-member' && (gs?.size ?? 0) === 0, `a user handle naming no account → 403 not-member, and no storage made for it (${err(g)}, ${gs?.size})`)

  // D5: the sign-in challenge is limited per IP
  {
    const ip = freshIp(), st: number[] = []
    for (let i = 0; i <= LIMITS.ip.challenge; i++) st.push((await raw('POST', WEB_ROUTES.signinChallenge, '{}', S, ip)).status)
    ok(st.slice(0, -1).every((x) => x === 200) && st[st.length - 1] === 429, `sign-in challenge #${LIMITS.ip.challenge + 1} from one IP → 429`)
  }

  // D6: the counter is stored only over the one the assertion was checked against
  {
    const sp = crypto.subtle as unknown as { verify: (...x: unknown[]) => Promise<boolean> }
    const orig = sp.verify.bind(crypto.subtle)
    let once = true
    sp.verify = async (...x: unknown[]) => {
      if (once) { once = false; await plant(hal, (st) => { const r = st.get(`pk:${H1.pub}`) as Record<string, unknown> | undefined; if (r) st.set(`pk:${H1.pub}`, { ...r, signCount: 30 }) }) }
      return orig(...x)
    }
    let race
    try { race = await signin(H1, hal, { count: 30 }) } finally { sp.verify = orig }
    ok(race.status === 400 && race.j.error === 'assertion-sign-count', `another assertion with the same counter landing while this one is checked → 400 assertion-sign-count (${err(race)})`)
    ok((await signin(H1, hal, { count: 31 })).status === 200, 'control: the next counter signs in')
  }
}

// D7: a passkey that a waiting reset would add cannot sign in
{
  const ivy = 'ivy@example.com', I1 = await Authn.make(), R1 = await Authn.make()
  await setup(ivy, I1)
  const n0 = mailbox.length
  await api('POST', '/v1/roster/reset/start', { email: ivy })
  const link = mailbox.slice(n0).find((x) => x.to === ivy && x.kind === 'reset')?.body.match(/https?:\/\/\S+/)?.[0] ?? ''
  const tok = parseResetLink(link)?.token ?? ''
  const ch = (await api('POST', '/v1/roster/challenge', { email: ivy })).j.challenge as string
  const rr = await api('POST', '/v1/roster/reset', { email: ivy, token: tok, dirNonce: ch, reg: await R1.register(b64uDec(ch ?? '') ?? new Uint8Array(16)) })
  ok(rr.status === 202, `ivy's reset waits (${rr.status})`)
  const r = await signin(R1, ivy)
  ok(r.status === 403 && r.j.error === 'not-member', `the waiting reset's new passkey cannot sign in → 403 not-member (${err(r)})`)
  ok((await signin(I1, ivy)).status === 200, 'control: the current passkey can')
}

// =====================================================================
// 5. incident records
// =====================================================================
{
  const fay = 'fay@example.com', F1 = await Authn.make(), FB = await Browser.make()
  await setup(fay, F1)
  await enrol(fay, FB, F1)
  const inc = [{ id: 'inc-1', from: now - DAY, to: null }, { id: 'inc-0', from: now - 9 * DAY, to: now - 8 * DAY }]
  env.INCIDENTS = JSON.stringify(inc)
  const r = await checkin(fay, FB)
  ok(r.status === 200 && JSON.stringify(r.j.incidents) === JSON.stringify(inc), `a check-in carries every published record (${JSON.stringify(r.j.incidents)})`)
  const st = await api('GET', `${STATUS_ROUTE}?e=${fay}&c=x`)
  ok(st.status === 400, 'status with no certificate hash → 400')
  const st2 = await api('GET', `${STATUS_ROUTE}?e=nobody@example.com&c=${await sha256b64u('x')}`)
  ok(st2.status === 200 && st2.j.state === 'unknown' && JSON.stringify(st2.j.incidents) === JSON.stringify(inc), 'status for no account: unknown, with the records (no existence oracle)')
  for (const bad of ['nope', '{}', '[{"id":"x","from":1}]', '[{"id":"X!","from":1,"to":null}]', '[{"id":"x","from":5,"to":4}]', '[{"id":"x","from":1,"to":null,"more":1}]', '[{"id":"x","from":"1","to":null}]']) {
    env.INCIDENTS = bad
    const hn = (await homeCh(fay)).j.nonce as string
    const b = await checkin(fay, FB, { nonce: hn })
    env.INCIDENTS = '[]'
    const after = await checkin(fay, FB, { nonce: hn })
    ok(b.status === 500 && !('watt' in b.j) && after.status === 200, `INCIDENTS ${bad}: 500, nothing countersigned, the challenge left (${b.status}, then ${after.status})`)
  }
  env.INCIDENTS = undefined
  ok((await checkin(fay, FB)).j.incidents !== undefined, 'INCIDENTS unset reads as none')
  // C1 (security on #957): enrolment reads the list too, before its challenge is opened
  const FB2 = await Browser.make()
  const ech = await chOf(fay)
  env.INCIDENTS = 'nope'
  const bad = await enrol(fay, FB2, F1, { ch: ech })
  env.INCIDENTS = undefined
  ok(bad.status === 500 && !('watt' in bad.j) && !(await storeOf(fay)).has(`wd:${FB2.pub}`), `INCIDENTS unreadable: enrol 500, nothing countersigned or stored (${err(bad)})`)
  const after = await enrol(fay, FB2, F1, { ch: ech })
  ok(after.status === 200, `and the challenge is left: the same enrolment, the list readable again → 200 (${err(after)})`)
}

// =====================================================================
// 5b. per-IP counts that never starve the owner (security's D3 and N3 on #957)
// =====================================================================
{
  const kai = 'kai@example.com', K1 = await Authn.make(), KB = await Browser.make()
  await setup(kai, K1)
  ok((await enrol(kai, KB, K1)).status === 200, 'kai has a browser')
  // junk check-ins (well formed, signed by the wrong key) from the owner's network count for nothing
  const ip = freshIp(), junk: number[] = []
  for (let i = 0; i <= LIMITS.ip.checkin; i++) junk.push((await checkin(kai, KB, { key: (await Browser.make()).W.privateKey, ip })).status)
  ok(junk.every((x) => x === 400), `${junk.length} check-ins with a bad signature from one IP: each 400 wren`)
  const mine = await checkin(kai, KB, { ip })
  ok(mine.status === 200, `the owner's valid check-in from that IP still → 200 (${err(mine)})`)
  // valid check-ins are counted per IP per address
  const ip2 = freshIp(), good: number[] = []
  for (let i = 0; i < LIMITS.ip.checkin; i++) good.push((await checkin(kai, KB, { ip: ip2 })).status)
  const over = await checkin(kai, KB, { ip: ip2 })
  ok(LIMITS.ip.checkin === 120 && good.every((x) => x === 200) && over.status === 429, `check-in #${LIMITS.ip.checkin + 1} for one address from one IP → 429 (${err(over)})`)
  // N3: the status route spends the per-IP lookup budget
  const ip3 = freshIp()
  for (let i = 0; i < LIMITS.ip.lookup; i++) await api('GET', `/v1/roster?e=n${i}@example.com`, undefined, { ip: ip3 })
  ok((await api('GET', `${STATUS_ROUTE}?e=${kai}&c=${await sha256b64u('x')}`, undefined, { ip: ip3 })).status === 429, 'the status route spends the per-IP lookup budget')
  // N3: the enrolment's counter, too, is stored only over the one its assertion was checked against
  const sp = crypto.subtle as unknown as { verify: (...x: unknown[]) => Promise<boolean> }
  const orig = sp.verify.bind(crypto.subtle)
  let once = true
  sp.verify = async (...x: unknown[]) => {
    if (once) { once = false; await plant(kai, (st) => { const r = st.get(`pk:${K1.pub}`) as Record<string, unknown> | undefined; if (r) st.set(`pk:${K1.pub}`, { ...r, signCount: 40 }) }) }
    return orig(...x)
  }
  const KB2 = await Browser.make()
  let race
  try { race = await enrol(kai, KB2, K1, { get: { count: 40 } }) } finally { sp.verify = orig }
  ok(race.status === 403 && race.j.error === 'assertion' && !(await storeOf(kai)).has(`wd:${KB2.pub}`), `another assertion with the same counter landing while an enrolment is checked → 403 assertion, nothing stored (${err(race)})`)
  ok((await enrol(kai, KB2, K1, { get: { count: 41 } })).status === 200, 'control: the next counter enrols')
}

// =====================================================================
// 6. CORS per route; a path that is no route gets none
// =====================================================================
{
  const pre = (p: string) => raw('OPTIONS', p, undefined, S)
  const pw = await pre(WEB_ROUTES.enrol), ph = await pre(HOME_ROUTES.checkin), pp = await pre('/v1/roster/request'), pn = await pre('/v1/nope')
  ok(pw.status === 204 && pw.h.get('access-control-allow-origin') === SIGNIN_ORIGIN, 'preflight on a web route: the sign-in host')
  ok(ph.status === 204 && ph.h.get('access-control-allow-origin') === H && ph.h.get('access-control-allow-methods') === 'POST, OPTIONS', 'preflight on a home route: bento/home, POST')
  ok(pp.status === 204 && pp.h.get('access-control-allow-origin') === '*', 'control: a public route keeps *')
  ok(pn.status === 404 && pn.h.get('access-control-allow-origin') === null, `preflight on a path that is no route → 404, no CORS (${pn.status} ${pn.h.get('access-control-allow-origin')})`)
  for (const [m, p] of [['POST', '/v1/nope'], ['GET', '/nope'], ['GET', '/.well-known/webauthn'], ['POST', '/v1/roster/nope']] as const) {
    const r = await raw(m, p, m === 'POST' ? '{}' : undefined, S)
    ok(r.status === 404 && r.h.get('access-control-allow-origin') === null, `${m} ${p} → 404 with no CORS`)
  }
  const homes = responses.filter((x) => x.what.includes(HOME_ROUTES.prefix))
  const webs = responses.filter((x) => x.what.includes(WEB_ROUTES.prefix))
  ok(homes.length > 50 && homes.every((x) => x.h.get('access-control-allow-origin') === H), `every bento/home answer (${homes.length}) has CORS for bento/home alone`)
  ok(webs.length > 50 && webs.every((x) => x.h.get('access-control-allow-origin') === SIGNIN_ORIGIN), `every sign-in host answer (${webs.length}) has CORS for the sign-in host alone`)
  const bad = responses.filter((x) => x.h.get('x-content-type-options') !== 'nosniff' || x.h.get('x-frame-options') !== 'DENY' || !/default-src 'none'/.test(x.h.get('content-security-policy') ?? '') ||
    !/publickey-credentials-get=\(\)/.test(x.h.get('permissions-policy') ?? ''))
  ok(bad.length === 0, `every answer carries the directory's headers (${bad.map((x) => x.what).slice(0, 3).join(', ') || 'all'})`)
}

// =====================================================================
// 7. nothing raw at rest
// =====================================================================
{
  const dump = JSON.stringify(allStores.map((s) => [...s.entries()]))
  ok(!dump.includes('ana@example.com') && !dump.includes('cara@example.com'), 'no raw address at rest')
  ok(!/10\.1\.\d+\.\d+/.test(dump), 'no raw IP at rest')
}

console.log(`${passes} passed, ${fails} failed`)
process.exit(fails)
