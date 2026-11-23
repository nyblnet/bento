#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/id directory: THE INCIDENT LEVER (SD5), server/directory/src/lever.js,
// obindex.js and the maintainer's script server/directory/lever.mjs.
//
//   node scripts/test-directory-lever.ts        (Node >= 23.6 strips types natively)
//
// Drives the REAL worker, its Roster objects and the ObIndex object (in memory,
// with the input gate and a hand clock, as test-directory-browsers.ts does),
// with a software authenticator and real WebCrypto device keys. It seeds
// accounts with browser enrolments and roster changes inside and around an
// incident window, pulls the lever through POST /v1/lever with a throwaway
// lever key, and checks every outcome:
//   L1  window revoke: [t0, t1] inclusive, nothing outside it
//   L2  only ob === 1 (ob 0 and an ABSENT ob survive)
//   L3  the mark is sticky: a new head never brings a certificate back
//   L4  a waiting ob=1 change is voided as a Cancel: nobody suspended, no
//       cooldown; a change asked for elsewhere is left alone
//   L5  "Revert this change" suspends the passkey the change ADDED (an `l`
//       link the kernel's chain verifier accepts), never the one that asked;
//       its removal ripens after 72 h, and its undo works in between
//   L6  the revert link: no attempt counter, single use, "gone" writes nothing
//   L7  a hold (F1) is respected, and a later run finishes the account
//   L8  the day index is written before anything is stored; a failed write
//       fails the enrolment or the request
//   L9  cross-address paging through the cursor; a re-run mails nobody twice
//   L10 the route's authority (signature, key, freshness, nonce), no CORS, and
//       no public route reaches the Roster's lever op
//   L11 the signed incident record (kernel verifyInc), to <= issuedAt
//   L12 a store that does not read answers 500 (security's C1 on #957, kept)
//   D1  INCIDENT_ENROL, both values: this tree's, and a copy with it flipped
//   S1  the status reason (by: incident | signout; none while ok)
//   M1  one incident mail per account, never held back by a budget
//   DR1 the drill refuses any non-loopback directory before any request, and
//       passes in process; DR2 a dry run changes nothing and prints no address
//   L13 (security on #984, M1) a later or wider run acts on what is new: a change
//       asked for after an open-incident run is voided, a missed certificate revoked
//   L14 (M2) a certificate signed out before the lever becomes the incident's
//   L15 (M3) a junk check-in never reads the global incident records
//   L16 (M4) the revert's guards (last-live, hold, pending, 30 days), the void's
//       F2 end, an id in both stores, a future t0, an early run, signIncident's
//       to <= issuedAt; N4 a void owed to a failed mail; N5 the script's exit

import worker, { Roster, Ledger, ObIndex } from '../server/directory/src/worker.js'
import * as workerModule from '../server/directory/src/worker.js'
import { addressKey } from '../server/directory/src/address.js'
import { parseSetupLink, parseVoidLink } from '../server/directory/src/links.js'
import { HOME_ORIGIN, SIGNIN_ORIGIN } from '../server/directory/src/passkey.js'
import { INCIDENT_ENROL } from '../server/directory/src/browsers.js'
import { signIncident } from '../server/directory/src/obindex.js'
import { LEVER_ROUTE, buildLever } from '../server/directory/src/lever.js'
import { HOME_ROUTES, WEB_ROUTES, STATUS_ROUTE } from '../server/directory/src/seam.js'
import { main as leverMain } from '../server/directory/lever.mjs'
import { b64uDec, b64uEnc, sha256b64u, signStatement } from '../kernel/src/statements.ts'
import { buildRos, parseRos, verifyRosterChain, ROSTER_RP_ID, ROSTER_WEB_ORIGINS, ROSTER_WAIT_MS, type Member, type RosterLink } from '../kernel/src/roster.ts'
import { buildDeviceCert, buildWren, verifyInc } from '../kernel/src/devices.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
// home/web's covers() as shipped: its source is lifted out of home/web/src/identity.ts (the module as a whole
// needs a TypeScript build) and run unchanged, so a record shape it cannot read turns these rows red
const covers = await (async () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../home/web/src/identity.ts'), 'utf8')
  const isObj = /^const isObj = .*$/m.exec(src)?.[0] ?? ''
  const a = src.indexOf('export function covers('), z = src.indexOf('\n}\n', a)
  if (!isObj || a < 0 || z < 0) throw new Error('covers() not found in home/web/src/identity.ts')
  const js = stripTypeScriptTypes(`${isObj}\n${src.slice(a, z + 3)}`)
  return (await import(`data:text/javascript,${encodeURIComponent(js)}`)).covers as (i: unknown, at: number) => boolean
})()
void workerModule; void SIGNIN_ORIGIN; void HOME_ROUTES

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
function namespace(Klass: new (state: unknown, env: unknown) => Obj, nsEnv: Record<string, unknown> = env) {
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
            async list(o?: { prefix?: string; limit?: number; startAfter?: string }) {
              const all = [...store].filter(([k]) => (!o?.prefix || k.startsWith(o.prefix)) && (!o?.startAfter || k > o.startAfter)).sort(([a], [b]) => (a < b ? -1 : 1))
              return new Map(all.slice(0, o?.limit ?? all.length).map(([k, v]) => [k, structuredClone(v)]))
            },
            async setAlarm(t: number) { rec.alarm = t },
            async getAlarm() { return rec.alarm },
          },
        }
        const inner = new Klass(state, nsEnv)
        rec.obj = {
          fetch: (r: Request) => gated(rec.gate, () => inner.fetch(r)),
          alarm: inner.alarm ? () => gated(rec.gate, () => inner.alarm!()) : undefined,
        }
        objs.set(id, rec)
      }
      const { obj } = objs.get(id)!
      // a call from inside another object is outgoing I/O: that object's gate opens meanwhile, as on the platform
      return { fetch: (u: string | Request, init?: RequestInit) => outgoing(() => obj.fetch(u instanceof Request ? u : new Request(u, init))) }
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
/** L8: when set, every index write answers 500 (the store is unreachable) */
let obFail = false
/** M3 (security on #984): how many times the incident records were read */
let incReads = 0
class FlakyObIndex extends (ObIndex as unknown as new (s: unknown, e: unknown) => Obj) {
  async fetch(r: Request) {
    const op = (await r.clone().json()).op
    if (op === 'records') incReads++
    if (obFail && op === 'add') return new Response('{"error":"down"}', { status: 500 })
    return super.fetch(r)
  }
}
const OBX = namespace(FlakyObIndex as never)
env.OBINDEX = OBX
// the maintainer's offline lever key (a throwaway one here), and the directory holding its public half
const leverKp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
const LEVER_PUB = b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', leverKp.publicKey)))
env.LEVER_PUBKEY = LEVER_PUB
let W = worker as { fetch(r: Request, e: unknown): Promise<Response> }, E = env
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
  let r: Response
  // an exception that escapes the worker is a refused row, never a crashed rig
  try {
    r = await W.fetch(new Request('https://id.bento.page' + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body), headers,
    }), E as never)
  } catch { return { status: -1, j: {} as Record<string, unknown>, h: new Headers(), text: '' } }
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
    if (l.cited) out.cited = l.cited
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
  try { r = await W.fetch(new Request('https://id.bento.page' + path, { method, body, headers }), E as never) } catch { return { status: -1, j: {}, h: new Headers(), text: '' } }
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

// ---------- lever helpers ----------
const D0 = Date.parse('2026-11-09T00:00:00Z')
const T0 = D0 + 22 * HOUR, T1 = D0 + 26 * HOUR // the window spans two UTC days (11-09 and 11-10)
const NO_CORS = (r: R) => r.h.get('access-control-allow-origin') === null
type Cmd = { op: string; id: string; t0: number; t1?: number | null; cursor?: string; n?: number; issuedAt?: number; nonce?: string }
const freshNonce = () => b64uEnc(crypto.getRandomValues(new Uint8Array(18)))
async function lever(c: Cmd, o: { key?: CryptoKey; sig?: string | null } = {}) {
  const cmd = buildLever({ op: c.op, id: c.id, t0: c.t0, t1: c.t1 ?? null, cursor: c.cursor ?? '', n: c.n ?? 50, issuedAt: c.issuedAt ?? now, nonce: c.nonce ?? freshNonce() })
  const sig = o.sig === undefined ? await signStatement(o.key ?? leverKp.privateKey, cmd) : o.sig
  return raw('POST', LEVER_ROUTE, JSON.stringify(sig === null ? { cmd } : { cmd, sig }), null)
}
const KEYS = ['visited', 'accounts', 'certificates', 'voids', 'reverts', 'words', 'mails', 'held', 'already', 'skipped', 'mailFailed'] as const
type Totals = Record<(typeof KEYS)[number], number>
/** run (or plan) to the end through the cursor, `n` accounts per call; bounded, so a cursor that never moves is a failed row, not a hung rig */
async function sweep(id: string, t0: number, t1: number, n: number, op = 'run') {
  const totals = Object.fromEntries(KEYS.map((k) => [k, 0])) as Totals
  let cursor = '', calls = 0, done = false, bad = 0
  for (; calls < 60; calls++) {
    const r = await lever({ op, id, t0, t1, cursor, n })
    if (r.status !== 200) { bad = r.status; break }
    for (const k of KEYS) totals[k] += Number((r.j.counts as Record<string, number>)?.[k]) || 0
    if (r.j.next === null) { done = true; calls++; break }
    cursor = r.j.next as string
  }
  return { totals, calls, done, bad }
}
const statusOf = async (email: string, text: string) => api('GET', `${STATUS_ROUTE}?e=${encodeURIComponent(email)}&c=${await sha256b64u(text)}`)
const incStore = () => { OBX.get('incidents'); return OBX.objs.get('incidents')!.store }
const shard = (day: string) => { OBX.get(`ob:${day}`); return OBX.objs.get(`ob:${day}`)!.store }
const voidLinksIn = (m: Mail | undefined) => (m?.body.match(/https?:\/\/\S+/g) ?? []).map((u) => parseVoidLink(u)).filter(Boolean) as { address: string; token: string; kind: string }[]
const press = (email: string, token: string, choice: string, ip?: string) => api('POST', '/v1/void', { email, token, choice }, { ip })
const linkCount = async (email: string) => [...(await storeOf(email)).keys()].filter((k) => k.startsWith('link:')).length
const snapshot = () => JSON.stringify(allStores.map((s) => [...s.entries()].sort(([a], [b]) => (a < b ? -1 : 1))))
const fp64 = async (pub: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b64uDec(pub)! as BufferSource))].map((x) => x.toString(16).padStart(2, '0')).join('')
const rows: Record<string, number> = {}
const row = (tag: string, c: unknown, n: string) => { rows[tag] = (rows[tag] ?? 0) + 1; ok(c, `${tag} ${n}`) }

// =====================================================================
// A. before the window: accounts, and an ob=1 enrolment on a window day but outside the window
// =====================================================================
now = D0 + 9 * HOUR
const lena = 'lena@example.com', L1a = await Authn.make()
const paul = 'paul@example.com', P1 = await Authn.make(), PX = await Authn.make()
const ula = 'ula@example.com', U1 = await Authn.make(), UZ = await Authn.make()
const quin = 'quin@example.com', Q1 = await Authn.make(), QY = await Authn.make()
const vera = 'vera@example.com', V1 = await Authn.make()
const hana = 'hana@example.com', HA1 = await Authn.make()
const rhea = 'rhea@example.com', R1 = await Authn.make()
const owen = 'owen@example.com', O1 = await Authn.make()
for (const [e, a] of [[lena, L1a], [paul, P1], [ula, U1], [quin, Q1], [vera, V1], [hana, HA1], [rhea, R1], [owen, O1]] as const) ok((await setup(e, a)).status === 200, `${e} is set up`)
now = D0 + 10 * HOUR
const OB = await Browser.make()
const oe = await enrol(owen, OB, O1)
ok(oe.status === 200, `positive control (D1): enrolment with no incident open → 200 (${err(oe)})`)
ok(shard('2026-11-09').has(`a:${await addressKey(owen)}`), 'L8 an ob=1 enrolment writes the day index (positive control)')

// =====================================================================
// B. the window [T0, T1]
// =====================================================================
const LB0 = await Browser.make(), LB1 = await Browser.make(), LB2 = await Browser.make(), LB3 = await Browser.make()
now = T0 - 1; const e0 = await enrol(lena, LB0, L1a)
now = T0; const e1 = await enrol(lena, LB1, L1a)
now = T0 + 30 * MIN
const pr = await request(paul, P1, { add: PX, rq: H })
const ur = await request(ula, U1, { add: UZ, rq: H })
const qr = await request(quin, Q1, { add: QY, rq: H })
ok(pr.status === 202 && ur.status === 202 && qr.status === 202, `three ob=1 adds asked for in the window wait (${pr.status} ${ur.status} ${qr.status})`)
ok(shard('2026-11-09').has(`a:${await addressKey(paul)}`), 'L8 an ob=1 roster request writes the day index')
const RB = await Browser.make()
ok((await enrol(rhea, RB, R1)).status === 200, 'rhea has a browser from the window')
now = T1 - MIN
const V2 = await Authn.make(), HA2 = await Authn.make(), R2 = await Authn.make()
const vr = await request(vera, V1, { add: V2, rq: H })
const hr = await request(hana, HA1, { add: HA2, rq: H })
const rr = await request(rhea, R1, { add: R2 }) // asked for elsewhere: rq ''
ok(vr.status === 202 && hr.status === 202 && rr.status === 202, `vera's and hana's ob=1 changes and rhea's ordinary one wait (${vr.status} ${hr.status} ${rr.status})`)
ok(shard('2026-11-10').has(`a:${await addressKey(vera)}`) && !shard('2026-11-10').has(`a:${await addressKey(rhea)}`) || shard('2026-11-09').has(`a:${await addressKey(rhea)}`),
  'the index is per UTC day: vera on 11-10; rhea only by her enrolment (her rq is not bento/home)')
now = T1; const e2 = await enrol(lena, LB2, L1a)
now = T1 + 1; const e3 = await enrol(lena, LB3, L1a)
ok([e0, e1, e2, e3].every((e) => e.status === 200), `lena enrolled at t0-1ms, t0, t1, t1+1ms (${[e0, e1, e2, e3].map((e) => e.status)})`)
// L2: two certificates inside the window that are NOT ob=1: ob 0, and no ob field at all
const fakes = { zero: b64uEnc(crypto.getRandomValues(new Uint8Array(65))), none: b64uEnc(crypto.getRandomValues(new Uint8Array(65))) }
const fakeHash = { zero: b64uEnc(crypto.getRandomValues(new Uint8Array(32))), none: b64uEnc(crypto.getRandomValues(new Uint8Array(32))) }
await plant(lena, (st) => {
  const r = st.get(`wd:${LB1.pub}`) as Record<string, unknown>
  st.set(`wd:${fakes.zero}`, { ...r, certHash: fakeHash.zero, ob: 0, rq: '', loggedAt: T0 + HOUR })
  const { ob: _o, ...noOb } = { ...r, certHash: fakeHash.none, loggedAt: T0 + HOUR }
  st.set(`wd:${fakes.none}`, noOb)
  st.set(`wh:${fakeHash.zero}`, fakes.zero); st.set(`wh:${fakeHash.none}`, fakes.none)
})
const fakeStatus = async (k: 'zero' | 'none') => api('GET', `${STATUS_ROUTE}?e=${lena}&c=${fakeHash[k]}`)
ok((await fakeStatus('zero')).j.state === 'ok' && (await fakeStatus('none')).j.state === 'ok', 'control: the planted ob-0 and no-ob certificates read ok before the lever')

// =====================================================================
// C. the incident: ripen what is due, open, plan (dry run), run
// =====================================================================
now = D0 + 97 * HOUR
for (const e of [paul, ula, quin, vera, hana, rhea]) await head(e)
const ripenedAdd = async (e: string, a: Authn) => (await current(e)).head?.members.some((m) => m.pub === a.pub && !m.quarantined)
ok(await ripenedAdd(paul, PX) && await ripenedAdd(ula, UZ) && await ripenedAdd(quin, QY), 'paul\'s, ula\'s and quin\'s adds took effect (72 h)')
ok(!!(await current(vera)).pending && !!(await current(hana)).pending && !!(await current(rhea)).pending, 'vera\'s, hana\'s and rhea\'s changes still wait')
// M1: lena's setup-mail budget is full (a stranger can fill it); the incident mail must not care
await plant(lena, (st) => st.set('mail', Array.from({ length: 10 }, (_, i) => now - (i + 1) * 1000)))
// L7: a Remove's mail is going out on hana's roster (F1)
await plant(hana, (st) => st.set('hold', { id: 'held-by-rig', what: 'remove', until: now + 30_000 }))
const lenaCh = await chOf(lena) // D1: a challenge taken before the incident opens

// L11: open
const op1 = await lever({ op: 'open', id: 'inc-main', t0: T0 })
row('L11', op1.status === 200 && (op1.j.record as Record<string, unknown>)?.to === null && NO_CORS(op1), `open → 200, the record open, no CORS (${err(op1)})`)
{
  const st = await statusOf(lena, e0.text)
  const rec = ((st.j.incidents ?? []) as Record<string, unknown>[]).find((x) => x.id === 'inc-main') as Record<string, string | number | null> | undefined
  const v = rec ? await verifyInc(rec.inc as string, rec.sig as string, { directoryKeys: DIR_KEYS, now }) : null
  row('L11', !!rec && Object.keys(rec).sort().join() === 'from,id,inc,sig,to' && rec.from === T0 && rec.to === null && v?.ok && v.value.from === T0 && v.value.to === null,
    `the open record is served {id, from, to: null, inc, sig} and its inc. verifies under dir-1 (${v?.ok ? 'ok' : v?.reason})`)
  row('L11', covers(rec, T0 + 1) === true && covers({ id: 'x', from: T0, to: T0 + 5 }, T0 + 9) === false, 'home/web covers() reads the served record unchanged (open covers a key; a closed window before the key does not)')
}

// DR2: a dry run (no --apply) through the maintainer's script changes nothing and prints no address
const keyDir = mkdtempSync(join(tmpdir(), 'lever-key-'))
const keyPath = join(keyDir, 'lever.jwk')
writeFileSync(keyPath, JSON.stringify(await crypto.subtle.exportKey('jwk', leverKp.privateKey)))
const routed = (fetched: string[]) => async (url: string, init?: RequestInit) => {
  fetched.push(url)
  const u = new URL(url)
  try {
    return await W.fetch(new Request('https://id.bento.page' + u.pathname + u.search, { ...init, headers: { ...(init?.headers as Record<string, string> ?? {}), 'cf-connecting-ip': freshIp() } }), E as never)
  } catch { return new Response('{"error":"escaped"}', { status: 599 }) }
}
{
  const out: string[] = [], fetched: string[] = []
  const before = snapshot()
  const r = await leverMain(['--directory', 'http://127.0.0.1:8787', '--key', keyPath, '--id', 'inc-main', 'run', '--t0', String(T0), '--t1', String(T1), '--page', '2'], { fetch: routed(fetched), log: (s: string) => out.push(s) })
  const text = out.join('\n')
  row('DR2', r.code === 0 && fetched.length > 0 && snapshot() === before, `a dry run (no --apply) sends ${fetched.length} plan requests and the storage is byte for byte the same`)
  row('DR2', !text.includes('@') && !/[0-9a-f]{64}/.test(text) && /dry run: nothing was changed/.test(text), `it prints counts only, no address or key (${JSON.stringify(out.slice(0, 2))})`)
  // a dry run marks nothing, so lena (events on both window days) is counted on each day: 2 + 2 + rhea's 1
  row('DR2', r.totals?.visited === 9 && r.totals?.certificates === 5 && r.totals?.voids === 1 && r.totals?.held === 1 && r.totals?.reverts === 3, `and counts what a run would do (${JSON.stringify(r.totals)})`)
}

// D1 (this tree's value) on the challenge taken before the incident opened
{
  const B = await Browser.make()
  const r = await enrol(lena, B, L1a, { ch: lenaCh })
  const c = await webCh(lena)
  if (INCIDENT_ENROL === 'refuse') {
    row('D1', r.status === 503 && r.j.error === 'incident' && !('watt' in r.j) && !(await storeOf(lena)).has(`wd:${B.pub}`), `refuse: an enrolment while inc-main is open → 503 incident, nothing stored, no watt (${err(r)})`)
    row('D1', c.status === 503 && c.j.error === 'incident', `refuse: and its challenge → 503 incident, so no passkey is asked for (${err(c)})`)
  } else {
    row('D1', r.status === 200 && typeof r.j.watt === 'string', `allow: an enrolment while inc-main is open → 200 with a watt (${err(r)})`)
  }
}

// L9: one account per call, through the cursor
const run1 = await sweep('inc-main', T0, T1, 1)
// 8 accounts in the two day shards, lena in both: 9 visits, the second of lena's already done
row('L9', run1.done && run1.bad === 0 && run1.totals.visited === 9 && run1.totals.already === 1 && run1.calls >= 9, `page size 1: the run visits every index entry of the window's two days through the cursor (${run1.calls} calls, ${JSON.stringify(run1.totals)})`)
row('L9', run1.totals.accounts === 7 && run1.totals.mails === 6 && run1.totals.held === 1 && run1.totals.certificates === 3, `7 accounts acted on (owen's enrolment is on a window day but outside the window), 6 mailed, hana held`)

// L1 / S1
{
  const s = await Promise.all([e0, e1, e2, e3].map((e) => statusOf(lena, e.text)))
  row('L1', s[1].j.state === 'revoked' && s[2].j.state === 'revoked', `t0 and t1 (inclusive): revoked (${s[1].j.state}, ${s[2].j.state})`)
  row('L1', s[0].j.state === 'ok' && s[3].j.state === 'ok', `t0-1ms and t1+1ms: ok (${s[0].j.state}, ${s[3].j.state})`)
  row('S1', s[1].j.by === 'incident' && s[1].j.incident === 'inc-main' && s[2].j.by === 'incident', `a lever revocation reports by: 'incident' and the incident id (${JSON.stringify(s[1].j)})`)
  row('S1', !('by' in s[0].j) && !('incident' in s[0].j), 'an ok certificate reports no reason')
  const c1 = await checkin(lena, LB1), c0 = await checkin(lena, LB0)
  row('L1', c1.status === 403 && c1.j.error === 'revoked' && c1.j.by === 'incident' && c1.j.incident === 'inc-main', `check-in for a revoked one → 403 revoked, by incident (${err(c1)} ${c1.j.by})`)
  row('L1', c0.status === 200, `check-in for t0-1ms → 200 (${err(c0)})`)
  row('L1', (await statusOf(owen, oe.text)).j.state === 'ok', 'owen (an ob=1 enrolment on a window day, outside the window): ok')
}
row('L2', (await fakeStatus('zero')).j.state === 'ok', 'a certificate with ob 0 inside the window: ok')
row('L2', (await fakeStatus('none')).j.state === 'ok', 'a certificate with NO ob field inside the window: ok')

// M1
{
  const ms = mailsTo(lena).filter((m) => m.kind === 'incident')
  const m = ms[0] ?? NOMAIL
  row('M1', ms.length === 1, `lena gets exactly one incident mail, her setup-mail budget full (${ms.length})`)
  row('M1', m.body.includes(await fp64(LB1.pub)) && m.body.includes(await fp64(LB2.pub)) && !m.body.includes(await fp64(LB0.pub)) && !m.body.includes(await fp64(LB3.pub)),
    'it names the two revoked browser keys by FULL fingerprint, and not the two outside the window')
  row('M1', /The passkeys on this account now:/.test(m.body) && m.body.includes(when(T0)) && m.body.includes(when(T1)) && m.body.includes('inc-main'), 'it states the window to the second, the incident and the whole roster')
  const pm = mailsTo(paul).filter((x) => x.kind === 'incident')
  row('M1', pm.length === 1 && voidLinksIn(pm[0]).length === 1 && voidLinksIn(pm[0])[0].kind === 'v', `paul's mail carries one revert link, kind v (${pm.length})`)
  row('M1', mailsTo(hana).filter((x) => x.kind === 'incident').length === 0 && mailsTo(owen).filter((x) => x.kind === 'incident').length === 0, 'hana (held) and owen (untouched) get no incident mail yet')
}

// L4
{
  row('L4', !(await current(vera)).pending, 'vera\'s ob=1 change in the window was voided')
  const vm = mailsTo(vera).filter((m) => m.kind === 'incident')
  row('L4', vm.length === 1 && /We stopped a change that was waiting/.test(vm[0].body) && /not suspended and can ask for the change again at once/.test(vm[0].body), 'and the mail says so')
  const vh = (await current(vera)).head
  row('L4', vh?.members.every((m) => !m.quarantined) && !(await storeOf(vera)).has(`cool:${V1.pub}`), 'the passkey that asked is not suspended and has no cooldown')
  const again = await request(vera, V1, { add: await Authn.make(), rq: H })
  row('L4', again.status === 202, `it can ask again at once (${err(again)})`)
  row('L4', !!(await current(rhea)).pending, 'rhea\'s change in the window, asked for elsewhere (rq \'\'), is untouched')
  const vlog = (await logOf(vera)).find((x) => x.k === 'void')
  row('L4', vlog?.choice === 'incident', 'the void is logged as the incident\'s')
}

// L7
row('L7', !!(await current(hana)).pending, 'hana\'s change is untouched while the hold is on')

// L5 / L6 on paul
{
  const link = voidLinksIn(mailsTo(paul).find((m) => m.kind === 'incident'))[0]
  const links0 = await linkCount(paul)
  // L6: five wrong guesses from five IPs spend nothing
  const wrong: number[] = []
  for (let i = 0; i < 5; i++) wrong.push((await press(paul, b64uEnc(crypto.getRandomValues(new Uint8Array(32))), 'revert', freshIp())).status)
  row('L6', wrong.every((s) => s === 400) && await linkCount(paul) === links0, `five wrong guesses from five IPs → 400 each, nothing written (${wrong})`)
  const r = await press(paul, link?.token ?? '', 'revert')
  row('L6', r.status === 200 && r.j.done === 'reverted', `then the real token still works (${err(r)})`)
  const h = (await current(paul)).head
  row('L5', h?.members.find((m) => m.pub === PX.pub)?.quarantined === true, 'the passkey the change ADDED is suspended')
  row('L5', h?.members.find((m) => m.pub === P1.pub)?.quarantined === false, 'the passkey that asked is NOT suspended')
  const st = await storeOf(paul)
  const lk = st.get(`link:${String(h?.seq ?? 0).padStart(8, '0')}`) as Record<string, unknown> | undefined
  const ch = await chainOf(paul)
  row('L5', ch.ok && typeof lk?.rip === 'string' && (lk.rip as string).split('.')[4] === 'l' && !!lk.cited, `an l link that carries the cited change, which the kernel's verifyRosterChain accepts (${ch.ok ? 'ok' : ch.reason})`)
  const r2 = await press(paul, link?.token ?? '', 'revert')
  row('L6', r2.status === 409 && r2.j.error === 'used', `a second press → 409 used (${err(r2)})`)
  const pend = (await current(paul)).pending
  row('L5', pend?.kind === 'removal' && pend.ripensAt === now + ROSTER_WAIT_MS, 'its removal is queued for 72 hours later')
}
// L5 undo on ula
{
  const link = voidLinksIn(mailsTo(ula).find((m) => m.kind === 'incident'))[0]
  const r = await press(ula, link?.token ?? '', 'revert')
  const undo = voidLinksIn(lastMail(ula)).find((x) => x.kind === 'u')
  const u = await press(ula, undo?.token ?? '', 'undo')
  const h = (await current(ula)).head
  const ch = await chainOf(ula)
  row('L5', r.status === 200 && u.status === 200 && h?.members.every((m) => !m.quarantined) && !(await current(ula)).pending && ch.ok,
    `ula reverts, then the undo link puts the passkey back (u after l), and the chain verifies (${err(r)}, ${err(u)}, ${ch.ok ? 'ok' : ch.reason})`)
}
// L6 gone on quin: the added passkey removed itself after the mail went
{
  const link = voidLinksIn(mailsTo(quin).find((m) => m.kind === 'incident'))[0]
  const gone = await request(quin, QY, { remove: QY.pub })
  const before = await linkCount(quin)
  const r = await press(quin, link?.token ?? '', 'revert')
  row('L6', gone.status === 200 && r.status === 409 && r.j.error === 'gone' && await linkCount(quin) === before && !(await current(quin)).pending,
    `a revert after the added passkey is gone → 409 gone, nothing written (${err(gone)}, ${err(r)})`)
}

// L7 + L9: the hold released, a re-run finishes hana and mails nobody else again
await plant(hana, (st) => st.delete('hold'))
const mailsBefore = mailbox.filter((m) => m.kind === 'incident').length
const run2 = await sweep('inc-main', T0, T1, 3)
row('L7', !(await current(hana)).pending && mailsTo(hana).filter((m) => m.kind === 'incident').length === 1, 'after the hold, a re-run voids hana\'s change and mails her')
row('L9', run2.done && run2.totals.mails === 1 && mailbox.filter((m) => m.kind === 'incident').length === mailsBefore + 1 && run2.totals.already === 8,
  `the re-run mails only hana; the 8 other visits find their account done (${JSON.stringify(run2.totals)})`)
const run3 = await sweep('inc-main', T0, T1, 50)
row('L9', run3.done && run3.totals.mails === 0 && run3.totals.certificates === 0, `a third run changes nothing (${JSON.stringify(run3.totals)})`)

// L11: close
{
  const c = await lever({ op: 'close', id: 'inc-main', t0: T0, t1: T1 })
  const st = await statusOf(lena, e0.text)
  const rec = ((st.j.incidents ?? []) as Record<string, unknown>[]).find((x) => x.id === 'inc-main') as Record<string, string | number | null> | undefined
  const v = rec ? await verifyInc(rec.inc as string, rec.sig as string, { directoryKeys: DIR_KEYS, now }) : null
  row('L11', c.status === 200 && rec?.to === T1 && v?.ok && v.value.from === T0 && v.value.to === T1 && v.value.to <= v.value.issuedAt,
    `close → the record reissued with to = t1 <= issuedAt, and it reverifies (${err(c)}, ${v?.ok ? 'ok' : v?.reason})`)
  row('L11', covers(rec, T0) === true && covers(rec, T1 + HOUR) === false, 'covers() reads the closed record unchanged')
  // D1: the challenge taken before the incident opened is still usable after it closed (refuse left it)
  const B = await Browser.make()
  const r = await enrol(lena, B, L1a, { ch: lenaCh })
  if (INCIDENT_ENROL === 'refuse') row('D1', r.status === 200 && typeof r.j.watt === 'string', `refuse: once closed, the same challenge enrols → 200 (${err(r)})`)
  const r2 = await enrol(lena, await Browser.make(), L1a)
  row('D1', r2.status === 200, `with only a closed incident, enrolment → 200 (${err(r2)})`)
}

// x ripens after 72 h; L3 sticky
{
  const L2b = await Authn.make()
  const nr = await request(lena, L1a, { add: L2b })
  now += ROSTER_WAIT_MS + MIN
  await head(paul); await head(lena)
  const ph = (await current(paul)).head
  const ch = await chainOf(paul)
  row('L5', !ph?.members.some((m) => m.pub === PX.pub) && ph?.members.some((m) => m.pub === P1.pub && !m.quarantined) && ch.ok,
    `72 h later the x removal took effect: the added passkey is gone, the asker stays, and the chain verifies (${ch.ok ? 'ok' : ch.reason})`)
  const lh = (await current(lena)).head
  const s1 = await statusOf(lena, e1.text), c1 = await checkin(lena, LB1)
  row('L3', nr.status === 202 && lh?.members.some((m) => m.pub === L2b.pub) && s1.j.state === 'revoked' && s1.j.by === 'incident' && c1.status === 403,
    `a new head ripened over lena's roster: the lever-revoked certificate stays revoked (${s1.j.state}, check-in ${c1.status})`)
  row('L3', (await statusOf(lena, e0.text)).j.state === 'ok', 'control: the one outside the window is still ok')
}

// S1: sign out everywhere
{
  const sam = 'sam@example.com', S1a = await Authn.make(), SB = await Browser.make()
  await setup(sam, S1a)
  const e = await enrol(sam, SB, S1a)
  await doOp(sam, 'browserRevokeAll', { by: S1a.pub })
  const st = await statusOf(sam, e.text), c = await checkin(sam, SB)
  row('S1', st.j.state === 'revoked' && st.j.by === 'signout' && !('incident' in st.j) && c.j.by === 'signout', `sign out everywhere reports by: 'signout' (${JSON.stringify(st.j.by)}, ${c.j.by})`)
}

// =====================================================================
// E. security round 1 on #984: the rows the first rig left open
// =====================================================================

// L13 (M1): a run while the incident is open, then a later run over a wider window. The done
// marker is kept by item, so the second run acts on (and mails) exactly what is new.
{
  const bob = 'sd5-bob@example.com', B1 = await Authn.make()
  const dan = 'sd5-dan@example.com', DN = await Authn.make()
  ok((await setup(bob, B1)).status === 200 && (await setup(dan, DN)).status === 200, 'sd5-bob and sd5-dan are set up')
  const t0 = now
  now += 10 * MIN
  const BB = await Browser.make(), DB1 = await Browser.make(), DB2 = await Browser.make()
  const be = await enrol(bob, BB, B1), d1 = await enrol(dan, DB1, DN)
  now += 50 * MIN
  const d2 = await enrol(dan, DB2, DN)
  ok(be.status === 200 && d1.status === 200 && d2.status === 200, 'bob enrols one browser, dan two an hour apart')
  now += 10 * MIN
  ok((await lever({ op: 'open', id: 'inc-wide', t0 })).status === 200, 'open inc-wide')
  now += MIN
  const n1 = await sweep('inc-wide', t0, t0 + 30 * MIN, 50) // the maintainer's first estimate of the window
  row('L13', n1.done && (await statusOf(dan, d1.text)).j.state === 'revoked' && (await statusOf(dan, d2.text)).j.state === 'ok',
    `control: a first run over the first half hour revokes dan's first certificate only (${JSON.stringify(n1.totals)})`)
  // the hostile page, still served while the incident is open, asks for an add after that run (accepted: N1, the maintainer's D1 question)
  now += 10 * MIN
  const EVIL = await Authn.make()
  const hb = await request(bob, B1, { add: EVIL, rq: H })
  ok(hb.status === 202, `an ob=1 request while the incident is open waits (${err(hb)})`)
  now += MIN
  const t1 = now
  const n2 = await sweep('inc-wide', t0, t1, 50) // the window widened once the logs are read
  row('L13', n2.done && !(await current(bob)).pending, `a later run over a wider window voids the change bob's page asked for after the first run (${JSON.stringify(n2.totals)})`)
  const s2 = await statusOf(dan, d2.text)
  row('L13', s2.j.state === 'revoked' && s2.j.by === 'incident' && s2.j.incident === 'inc-wide', `and revokes dan's second certificate (${JSON.stringify([s2.j.state, s2.j.by])})`)
  const dm = mailsTo(dan).filter((m) => m.kind === 'incident'), bm = mailsTo(bob).filter((m) => m.kind === 'incident')
  row('L13', dm.length === 2 && dm[1].body.includes(await fp64(DB2.pub)) && !dm[1].body.includes(await fp64(DB1.pub)), `dan's second mail names only the new certificate (${dm.length} mails)`)
  row('L13', bm.length === 2 && /We stopped a change that was waiting/.test(bm[1].body) && !/We stopped a change/.test(bm[0].body), `bob's second mail says the change was stopped (${bm.length} mails)`)
  const n3 = await sweep('inc-wide', t0, t1, 50)
  row('L13', n3.done && n3.totals.mails === 0 && n3.totals.certificates === 0 && n3.totals.already === n3.totals.visited, `a third run over the same window mails nobody (${JSON.stringify(n3.totals)})`)
  if (INCIDENT_ENROL === 'refuse') row('L13', /paused until this incident is over/.test(dm[0]?.body ?? '') && !/^To sign in again/m.test(dm[0]?.body ?? ''), 'N3: a mail sent while the incident is open says browser sign-in is paused, not "sign in again"')
  ok((await lever({ op: 'close', id: 'inc-wide', t0, t1 })).status === 200, 'close inc-wide')
  now = t1 + ROSTER_WAIT_MS + HOUR
  await head(bob)
  row('L13', !(await current(bob)).head?.members.some((m) => m.pub === EVIL.pub), 'the hostile passkey asked for inside the window never joins bob\'s roster')
}

// L14 (M2): a certificate revoked before the lever (sign out everywhere, or a mark with no revokedBy) is the incident's after it
{
  const cat = 'sd5-cat@example.com', C1 = await Authn.make()
  ok((await setup(cat, C1)).status === 200, 'sd5-cat is set up')
  const t0 = now
  now += 10 * MIN
  const CB = await Browser.make(), CB2 = await Browser.make()
  const ce = await enrol(cat, CB, C1), ce2 = await enrol(cat, CB2, C1)
  ok(ce.status === 200 && ce2.status === 200, 'sd5-cat enrols two browsers in the window')
  now += 10 * MIN
  await doOp(cat, 'browserRevokeAll', { by: C1.pub })
  const out1 = (await storeOf(cat)).get(`wd:${CB.pub}`) as Record<string, unknown> | undefined
  await plant(cat, (st) => { const r = st.get(`wd:${CB2.pub}`) as Record<string, unknown> | undefined; if (!r) return; const { revokedBy: _b, ...old } = r; st.set(`wd:${CB2.pub}`, old) })
  const b1 = await statusOf(cat, ce.text), b2 = await statusOf(cat, ce2.text)
  ok(b1.j.by === 'signout' && b2.j.by === 'signout' && !('revokedBy' in (((await storeOf(cat)).get(`wd:${CB2.pub}`) ?? { revokedBy: 'absent' }) as object)), `control: signed out → by signout, and the planted mark has no revokedBy (${b1.j.by}, ${b2.j.by})`)
  now += 10 * MIN
  ok((await lever({ op: 'open', id: 'inc-out', t0 })).status === 200, 'open inc-out')
  now += MIN
  const t1 = now
  ok((await lever({ op: 'close', id: 'inc-out', t0, t1 })).status === 200, 'close inc-out (the run comes after)')
  now += MIN
  const r = await sweep('inc-out', t0, t1, 50)
  const a1 = await statusOf(cat, ce.text), a2 = await statusOf(cat, ce2.text)
  row('L14', r.done && a1.j.state === 'revoked' && a1.j.by === 'incident' && a1.j.incident === 'inc-out', `a certificate signed out before the lever reports by: 'incident' after it (${JSON.stringify([a1.j.by, a1.j.incident])})`)
  row('L14', a2.j.state === 'revoked' && a2.j.by === 'incident' && a2.j.incident === 'inc-out', `so does one marked revoked with no revokedBy (${JSON.stringify([a2.j.by, a2.j.incident])})`)
  row('L14', ((await storeOf(cat)).get(`wd:${CB.pub}`) as Record<string, unknown>)?.revokedAt === out1?.revokedAt, 'its revocation keeps its earlier time')
  const cm = mailsTo(cat).filter((m) => m.kind === 'incident')
  row('L14', cm.length === 1 && cm[0].body.includes(await fp64(CB.pub)) && cm[0].body.includes(await fp64(CB2.pub)) && /had already been signed out/.test(cm[0].body),
    `the incident mail names both, and says they had already been signed out (${cm.length} mails)`)
  row('L14', /^To sign in again, use bento\/home or your app/m.test(cm[0]?.body ?? '') && !/paused/.test(cm[0]?.body ?? ''), 'N3: a mail sent after the incident closed says "sign in again", not paused')
}

// L15 (M3): a junk check-in never reaches the incident records (one global object); a real one reads them once
{
  const eve = 'sd5-eve@example.com', E1 = await Authn.make(), EB = await Browser.make()
  ok((await setup(eve, E1)).status === 200 && (await enrol(eve, EB, E1)).status === 200, 'sd5-eve has a browser')
  const before = incReads, ip = '10.9.9.9', st = new Set<number>()
  for (let i = 0; i < 40; i++) st.add((await raw('POST', HOME_ROUTES.checkin, JSON.stringify({ wren: 'x', sig: 'y' }), H, ip)).status)
  const junkNonce = await checkin(eve, EB, { nonce: b64uEnc(crypto.getRandomValues(new Uint8Array(32))), ip })
  row('L15', incReads === before && [...st].join() === '400' && junkNonce.status === 400, `40 junk check-ins and one with a nonce the directory never issued, from one IP → ${incReads - before} reads of the incident records (${[...st]}, ${junkNonce.status})`)
  const b2 = incReads
  const real = await checkin(eve, EB)
  row('L15', real.status === 200 && incReads - b2 === 1 && Array.isArray(real.j.incidents), `positive control: a real check-in reads them once and carries them (${err(real)}, ${incReads - b2} reads)`)
}

// L16 (M4): the revert link's guards, the lever void's F2 end, and a void owed to a mail that failed
{
  const acc = (n: string) => `sd5-${n}@example.com`
  const names = ['last', 'exp', 'hold', 'pend'] as const
  const A: Record<string, Authn> = {}, X: Record<string, Authn> = {}
  for (const n of names) { A[n] = await Authn.make(); X[n] = await Authn.make(); ok((await setup(acc(n), A[n])).status === 200, `${acc(n)} is set up`) }
  const vo = acc('vo'), VO1 = await Authn.make()
  ok((await setup(vo, VO1)).status === 200, `${vo} is set up`)
  now += HOUR
  const t0 = now
  now += 10 * MIN
  for (const n of names) ok((await request(acc(n), A[n], { add: X[n], rq: H })).status === 202, `${acc(n)}: an ob=1 add in the window`)
  now += ROSTER_WAIT_MS + MIN
  for (const n of names) await head(acc(n))
  ok((await Promise.all(names.map(async (n) => (await current(acc(n))).head?.members.some((m) => m.pub === X[n].pub)))).every(Boolean), 'the four adds took effect')
  const vr = await request(vo, VO1, { add: await Authn.make(), rq: H })
  const voLink = voidLinksIn(lastMail(vo))[0]
  ok(vr.status === 202 && !!voLink, `${vo}: an ob=1 change waits, its notice carries a void link (${err(vr)})`)
  const t1 = now
  now += MIN
  ok((await lever({ op: 'open', id: 'inc-rv', t0 })).status === 200, 'open inc-rv')
  // S9 / S8: a future t0, and a run starting before the record's from
  const fut = await lever({ op: 'open', id: 'inc-future', t0: now + MIN })
  row('L16', fut.status === 400 && fut.j.error === 'future' && !incStore().has('inc:inc-future'), `open with a t0 in the future → 400 future, nothing stored (${err(fut)})`)
  const early = await lever({ op: 'run', id: 'inc-rv', t0: t0 - 1, t1, cursor: '', n: 50 })
  row('L16', early.status === 400 && early.j.error === 'window' && !!(await current(vo)).pending, `a run whose t0 is before the record's from → 400 window, nothing done (${err(early)})`)
  // N4 + N5: the mailer is down for the first run, through the maintainer's script with --apply
  mailDown = true
  const out: string[] = []
  const lr = await leverMain(['--directory', 'http://127.0.0.1:8787', '--key', keyPath, '--id', 'inc-rv', 'run', '--t0', String(t0), '--t1', String(t1), '--apply'], { fetch: routed([]), log: (x: string) => out.push(x) })
  mailDown = false
  row('L16', lr.code !== 0 && (lr.totals?.mailFailed ?? 0) >= 5 && /run the same command again/.test(out.join('\n')) && !(await current(vo)).pending,
    `N5: a run whose mail failed exits non-zero and says to run again (exit ${lr.code}, ${JSON.stringify(lr.totals)}); N4: the void happened`)
  const again = await sweep('inc-rv', t0, t1, 50)
  const vm = mailsTo(vo).filter((m) => m.kind === 'incident')
  row('L16', again.done && vm.length === 1 && /We stopped a change that was waiting/.test(vm[0].body), `N4: the re-run's mail still says the change was stopped (${vm.length} mails, ${JSON.stringify(again.totals)})`)
  // S7: the waiting change's own link now answers how it ended
  const vp = await press(vo, voLink?.token ?? '', 'cancel')
  row('L16', vp.status === 409 && vp.j.error === 'incident' && typeof vp.j.at === 'number', `the voided change's link answers 409 incident (F2) (${err(vp)})`)
  const tok = async (n: string) => voidLinksIn(mailsTo(acc(n)).find((m) => m.kind === 'incident')).find((l) => l.kind === 'v')?.token ?? ''
  const quiet = async (n: string) => ({ links: await linkCount(acc(n)), q: (await current(acc(n))).head?.members.find((m) => m.pub === X[n].pub)?.quarantined })
  // S1: the passkey that asked removed itself after the mail: the added one is the last usable passkey
  {
    const n = 'last', gone = await request(acc(n), A[n], { remove: A[n].pub })
    const b = await quiet(n)
    const r = await press(acc(n), await tok(n), 'revert')
    const a = await quiet(n)
    row('L16', gone.status === 200 && r.status === 409 && r.j.error === 'last-live' && a.links === b.links && a.q === false, `G4c: a revert that would leave no usable passkey → 409 last-live, nothing written (${err(gone)}, ${err(r)})`)
  }
  // S3: another press's hold (F1); the link still works once it is gone
  {
    const n = 'hold', b = await quiet(n), t = await tok(n)
    await plant(acc(n), (st) => st.set('hold', { id: 'held-by-rig', what: 'remove', until: now + 30_000 }))
    const r = await press(acc(n), t, 'revert')
    const a = await quiet(n)
    await plant(acc(n), (st) => st.delete('hold'))
    const r2 = await press(acc(n), t, 'revert')
    row('L16', r.status === 409 && r.j.error === 'busy' && a.links === b.links && a.q === false && r2.status === 200, `F1: a revert while another press's mail goes → 409 busy, nothing written; afterwards it works (${err(r)}, ${err(r2)})`)
  }
  // S2: another change waiting
  {
    const n = 'pend'
    const w = await request(acc(n), A[n], { add: await Authn.make() })
    const b = await quiet(n)
    const r = await press(acc(n), await tok(n), 'revert')
    const a = await quiet(n)
    row('L16', w.status === 202 && r.status === 409 && r.j.error === 'pending' && a.links === b.links && a.q === false, `a revert while another change waits → 409 pending, nothing written (${err(w)}, ${err(r)})`)
  }
  ok((await lever({ op: 'close', id: 'inc-rv', t0, t1 })).status === 200, 'close inc-rv')
  // S6: an id published both by the lever and in INCIDENTS
  {
    env.INCIDENTS = JSON.stringify([{ id: 'var-only', from: t0, to: t1 }])
    const v1 = await statusOf(acc('exp'), 'x')
    env.INCIDENTS = JSON.stringify([{ id: 'inc-rv', from: t0, to: t1 }])
    const v2 = await statusOf(acc('exp'), 'x')
    delete env.INCIDENTS
    row('L16', v1.status === 200 && ((v1.j.incidents ?? []) as { id: string }[]).some((x) => x.id === 'var-only') && v2.status === 500,
      `control: an INCIDENTS record beside the stored ones is served (${v1.status}); an id in both → 500 (${v2.status})`)
  }
  // S17: the directory never signs a record whose end follows its issue
  {
    const late = await signIncident(env, { id: 'x-late', from: 1000, to: 3000, issuedAt: 2999 }).then(() => 'signed', (e: Error) => e.message)
    const fine = await signIncident(env, { id: 'x-fine', from: 1000, to: 3000, issuedAt: 3000 }).then((r) => r.inc, () => 'threw')
    row('L16', late !== 'signed' && /^inc\.x-fine\./.test(fine), `signIncident refuses to > issuedAt (${late}), and signs to = issuedAt (positive control)`)
  }
  // S4: the 30-day life (last: it moves the clock)
  {
    const n = 'exp', t = await tok(n), b = await quiet(n)
    now += 30 * DAY + MIN
    const r = await press(acc(n), t, 'revert')
    const a = await quiet(n)
    row('L16', r.status === 409 && r.j.error === 'late' && a.links === b.links && a.q === false, `a revert link past its 30 days → 409 late, nothing written (${err(r)})`)
  }
}

// L12: a stored record that does not read
{
  const kim = 'kim@example.com', K1 = await Authn.make(), KB = await Browser.make()
  await setup(kim, K1)
  ok((await enrol(kim, KB, K1)).status === 200, 'kim has a browser')
  const ch = await chOf(kim), KB2 = await Browser.make()
  const good = incStore().get('inc:inc-main') as Record<string, unknown>
  incStore().set('inc:broken', { ...good, id: 'broken' }) // its inc. text names another id
  const e = await enrol(kim, KB2, K1, { ch })
  const c = await checkin(kim, KB)
  const s = await api('GET', `${STATUS_ROUTE}?e=${kim}&c=${await sha256b64u('x')}`)
  incStore().delete('inc:broken')
  row('L12', e.status === 500 && !('watt' in e.j) && !(await storeOf(kim)).has(`wd:${KB2.pub}`), `a stored record that does not read: enrol → 500, nothing stored (${err(e)})`)
  row('L12', c.status === 500 && !('watt' in c.j) && s.status === 500, `check-in and status → 500 (${c.status}, ${s.status})`)
  const after = await enrol(kim, KB2, K1, { ch })
  row('L12', after.status === 200, `and the enrolment's challenge was left: the store readable again → 200 (${err(after)})`)
}

// L8: the index write fails
{
  const iris = 'iris@example.com', I1 = await Authn.make(), IB = await Browser.make()
  await setup(iris, I1)
  obFail = true
  const e = await enrol(iris, IB, I1)
  const r = await request(iris, I1, { add: await Authn.make(), rq: H })
  obFail = false
  const st = await storeOf(iris)
  row('L8', e.status === 500 && !('watt' in e.j) && !st.has(`wd:${IB.pub}`) && !st.get('pend'), `index unreachable: enrolment → 500, no watt, nothing stored (${err(e)})`)
  row('L8', r.status === 500 && !st.get('pend') && !mailsTo(iris).some((m) => /waiting/.test(m.subject)), `and an ob=1 request → 500, nothing queued or mailed (${err(r)})`)
  const ok2 = await enrol(iris, IB, I1)
  row('L8', ok2.status === 200, `control: index back → 200 (${err(ok2)})`)
}

// L10: the route's authority
{
  const jon = 'jon@example.com', J1 = await Authn.make(), JB = await Browser.make()
  await setup(jon, J1)
  const je = await enrol(jon, JB, J1)
  const t0 = now - HOUR
  const incBefore = JSON.stringify([...incStore().entries()])
  const other = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const base = { op: 'open', id: 'inc-auth', t0 }
  const noSig = await lever(base, { sig: null })
  const badSig = await lever(base, { key: other.privateKey })
  const stale = await lever({ ...base, issuedAt: now - 6 * MIN })
  env.LEVER_PUBKEY = ''
  const off = await lever(base)
  env.LEVER_PUBKEY = LEVER_PUB
  row('L10', noSig.status === 400 && badSig.status === 401 && stale.status === 401 && off.status === 403 && off.j.error === 'lever-off',
    `no signature 400, another key 401, issued 6 min ago 401, LEVER_PUBKEY empty 403 lever-off (${[noSig, badSig, stale, off].map(err)})`)
  row('L10', JSON.stringify([...incStore().entries()]) === incBefore, 'and none of them changed anything')
  const n = freshNonce()
  const first = await lever({ ...base, id: 'inc-auth', nonce: n, op: 'run', t1: now - 1, t0: T0 })
  const replay = await lever({ ...base, id: 'inc-auth', nonce: n, op: 'run', t1: now - 1, t0: T0 })
  row('L10', first.status === 404 && replay.status === 403 && replay.j.error === 'replay', `a replayed nonce → 403 replay (${err(first)}, then ${err(replay)})`)
  row('L10', [noSig, badSig, stale, off, first, replay].every(NO_CORS), 'no lever answer carries CORS')
  const pre = await raw('OPTIONS', LEVER_ROUTE, undefined, 'https://attacker.example')
  row('L10', pre.status === 404 && NO_CORS(pre), `a preflight on the lever route → 404, no CORS (${pre.status})`)
  // no public route reaches the Roster's lever op
  const inj = { op: 'lever', id: 'inj', t0: 0, t1: now, email: jon, address: jon, token: 'x'.repeat(43), choice: 'revert', ros: 'x', dirNonce: 'x' }
  for (const p of ['/v1/roster/challenge', '/v1/roster/setup/start', '/v1/roster/setup', '/v1/roster/request', '/v1/void', '/v1/roster/reset/start', '/v1/roster/reset', '/v1/roster/reset/void',
    WEB_ROUTES.challenge, WEB_ROUTES.enrol, WEB_ROUTES.signin, WEB_ROUTES.signout, HOME_ROUTES.challenge, HOME_ROUTES.checkin]) {
    await raw('POST', p, JSON.stringify(inj), p.startsWith('/v1/home/') ? H : S)
  }
  const direct = await ROSTER.get(await addressKey(jon)).fetch('https://address/op', { method: 'POST', body: JSON.stringify({ op: 'lever', id: 'inj', t0: 0, t1: now }) }).catch(() => new Response('{}', { status: 599 }))
  row('L10', direct.status === 400 && (await statusOf(jon, je.text)).j.state === 'ok' && !(await storeOf(jon)).has('lever:inj'),
    `the Roster takes op 'lever' only on its /lever path: every public route and a direct generic call leave jon's certificate ok (${direct.status})`)
}

// D1, the other value: a copy of the tree with INCIDENT_ENROL flipped
async function d1World(value: string) {
  const ran0 = rows.D1 ?? 0
  const sam = `d1-${value}@example.com`, A = await Authn.make()
  await setup(sam, A)
  const pc = await enrol(sam, await Browser.make(), A)
  row('D1', pc.status === 200, `[${value}] positive control: enrol with no open incident → 200 (${err(pc)})`)
  const ch = await chOf(sam)
  const o = await lever({ op: 'open', id: `d1-${value}`, t0: now })
  const B = await Browser.make()
  const r = await enrol(sam, B, A, { ch })
  const c = await webCh(sam)
  if (value === 'refuse') {
    row('D1', o.status === 200 && r.status === 503 && r.j.error === 'incident' && !('watt' in r.j), `[refuse] an open incident: enrol → 503 incident, no watt (${err(r)})`)
    row('D1', c.status === 503 && c.j.error === 'incident', `[refuse] and its challenge → 503 incident (${err(c)})`)
  } else {
    row('D1', o.status === 200 && r.status === 200 && typeof r.j.watt === 'string', `[allow] an open incident: enrol → 200 with a watt, as before the lever (${err(r)})`)
    row('D1', c.status === 200, `[allow] and its challenge → 200 (${err(c)})`)
  }
  now += 1000
  const cl = await lever({ op: 'close', id: `d1-${value}`, t0: now - 1000, t1: now })
  const after = await enrol(sam, await Browser.make(), A)
  row('D1', cl.status === 200 && after.status === 200, `[${value}] once closed, enrol → 200 (${err(cl)}, ${err(after)})`)
  console.log(`D1 INCIDENT_ENROL=${value}: ${(rows.D1 ?? 0) - ran0} rows ran`)
}
console.log(`D1 INCIDENT_ENROL=${INCIDENT_ENROL} (this tree)`)
await d1World(INCIDENT_ENROL)
{
  const OTHER = INCIDENT_ENROL === 'refuse' ? 'allow' : 'refuse'
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const copy = mkdtempSync(join(tmpdir(), 'lever-d1-'))
  for (const p of ['kernel/src', 'server/directory/src']) cpSync(join(root, p), join(copy, p), { recursive: true })
  const f = join(copy, 'server/directory/src/browsers.js'), src = readFileSync(f, 'utf8')
  const from = `export const INCIDENT_ENROL = '${INCIDENT_ENROL}'`
  ok(src.split(from).length === 2, `the copy flips INCIDENT_ENROL exactly once (${from})`)
  writeFileSync(f, src.replace(from, `export const INCIDENT_ENROL = '${OTHER}'`))
  const mod = await import(pathToFileURL(join(copy, 'server/directory/src/worker.js')).href)
  const env2: Record<string, unknown> = { ...env }
  env2.ROSTER = namespace(mod.Roster, env2); env2.LEDGER = namespace(mod.Ledger, env2); env2.OBINDEX = namespace(mod.ObIndex, env2)
  const was = [W, E] as const
  W = mod.default; E = env2
  try { await d1World(OTHER) } finally { [W, E] = was; rmSync(copy, { recursive: true, force: true }) }
}

// DR1: the drill
{
  for (const bad of ['https://id.bento.page', 'http://10.0.0.5:8787', 'http://localhost.evil.example:8787', 'http://127.0.0.1.nip.io:8787', 'http://user@127.0.0.1:8787']) {
    const fetched: string[] = [], out: string[] = []
    const r = await leverMain(['--drill', '--directory', bad, '--key', keyPath], { fetch: routed(fetched), log: (s: string) => out.push(s) })
    row('DR1', r.code !== 0 && fetched.length === 0, `--drill against ${bad}: refused before any request (exit ${r.code}, ${fetched.length} fetches)`)
  }
  // seed the drill's window: an ob=1 enrolment and an ob=1 change half an hour before
  const dora = 'dora@example.com', D1a = await Authn.make()
  await setup(dora, D1a)
  ok((await enrol(dora, await Browser.make(), D1a)).status === 200, 'dora has a browser for the drill')
  now += 30 * MIN
  env.DIR_PUBKEYS = JSON.stringify([{ kid: 'dir-1', pub: DIR_PUB }])
  const fetched: string[] = [], out: string[] = []
  const r = await leverMain(['--drill', '--directory', 'http://127.0.0.1:8787', '--key', keyPath], { fetch: routed(fetched), log: (s: string) => out.push(s) })
  row('DR1', r.code === 0 && /drill passed/.test(out.join('\n')) && !out.some((l) => l.startsWith('FAIL')), `the drill on the in-process directory: open, plan, run, run again, close, record read back (${out.filter((l) => /FAIL|passed|note/.test(l)).join(' | ')})`)
  row('DR1', (r.totals?.accounts ?? 0) >= 1 && (r.totals?.certificates ?? 0) >= 1 && (r.totals?.mails ?? 0) >= 1, `positive control: the drill acted (${JSON.stringify(r.totals)})`)
  row('DR1', !out.join('\n').includes('@'), 'the drill prints no address')
}
rmSync(keyDir, { recursive: true, force: true })

// nothing raw at rest in the lever's stores
{
  const dump = JSON.stringify([...OBX.objs.values()].map((o) => [...o.store.entries()]))
  ok(!dump.includes('@example.com'), 'the day index and incident store hold no address')
}

console.log(`rows: ${Object.entries(rows).map(([k, v]) => `${k} ${v}`).join(', ')}`)
console.log(`${passes} passed, ${fails} failed`)
process.exit(fails)
