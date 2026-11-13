#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/id directory: the passkey ROSTER store (option G), server/directory.
//
//   node scripts/test-directory-roster.ts        (Node ≥ 23.6 strips types natively)
//
// Drives the REAL worker and its Roster Durable Object against an in-memory
// namespace and a hand-moved clock, with real browser registrations and
// assertions (kernel/fixtures/webauthn-v1.json, server/directory/fixtures/
// registrations-v1.json) and a software authenticator for everything a browser
// will not produce. What it must prove:
//   · the passkeys' relying party is id.bento.page and the ONLY web origin is
//     https://signin.id.bento.page, in one constant that matches the kernel's;
//     bento.page, home.bento.page and id.bento.page are refused, for
//     registrations and for assertions;
//   · registration is ES256 only, UP+UV, never cross-origin, rp hash exact;
//   · setup needs a 256-bit token that a stranger's wrong guesses never spend;
//   · a change is asked for by an unquarantined passkey member, waits 72 hours
//     on the DIRECTORY's clock, one at a time, and the per-credential signature
//     counter refuses an assertion that goes backwards;
//   · a member removing itself is immediate only while another unquarantined
//     passkey stays;
//   · every enrolment and change is logged with its origins and time;
//   · every roster mail lists the whole roster and the change in words, and
//     nothing a stranger can fill holds one back;
//   · every answer from id.bento.page is JSON with nosniff, blocks WebAuthn by
//     Permissions-Policy, carries a CSP, and /.well-known/webauthn is not served;
//   · every link in the chain carries the directory's countersign (`rip.`),
//     issued when it takes effect, never at request, under the authority word
//     for the act (m, q, x, u, r), and the kernel's verifier accepts the chain;
//   · the void (G3, G4, G4a-c): every waiting notice carries a void link, a
//     256-bit token in the fragment that no count of wrong guesses can burn;
//     Cancel drops the change and stops its requester asking for 72 hours;
//     Remove suspends the requester and queues its removal, whose own notice
//     can undo it; Remove is never offered to the only live member; a reset
//     offers Cancel only; the void page is the one HTML answer, under its own
//     headers;
//   · the reset (G5): a mailed link no budget holds back, a new passkey, 72
//     hours, preempting whatever waits; no member may stop it in the account's
//     first 14 days; "new account" for 14 days;
//   · a setup link mailed beyond the budget lives a day, so a stranger who
//     keeps asking costs the owner at most the day's budget plus one link a
//     day, with never a moment without a live link (S1′); the link lives are
//     pinned; setup/start answers the same bytes in every state;
//   · what happens after a waiting notice's send touches the stored change
//     only if it is still that request's (D1a), and the mailer has a timeout;
//   · spent challenges are swept by the alarm once nobody spends.
//   · F1: a Remove or a reset holds the roster before its mail goes, so the
//     mail is always true: the change cannot ripen under it and every other
//     void, reset or request is refused before mailing (security's P1-P8 as
//     rows); a send that outlives its hold acts only if nothing moved and the
//     hold is still its own; the reset link is single use;
//   · F2: an ended void link answers late / used / preempted, from a bounded
//     list of hashes;
//   · C3: a reset sets a waiting removal aside; its undo works while the reset
//     waits (the reset is asked again, so the chain verifies), and a stopped
//     reset puts the removal back at its own time.

import worker, { Roster } from '../server/directory/src/worker.js'
import { Ledger } from '../server/directory/src/worker.js'
import { addressKey } from '../server/directory/src/address.js'
import { DIRECTORY_ORIGIN, PASSKEY, SIGNIN_ORIGIN, passkeyOrigins, readCbor, verifyRegistration, verifyMemberAssertion } from '../server/directory/src/passkey.js'
import { parseResetLink, parseSetupLink, parseVoidLink, setupLink, SIGNIN_PATHS, VOID_PATH } from '../server/directory/src/links.js'
import { evaluate } from './check-id-hosting.mjs'
import { VOID_PATH as HOSTING_VOID_PATH } from './lib/id-hosting-rules.mjs'
import { MAIL_KINDS, MAIL_TIMEOUT_MS, deliver } from '../server/directory/src/mail.js'
import * as workerModule from '../server/directory/src/worker.js'
import { WEB_ROUTES } from '../server/directory/src/seam.js'
const { LIMITS } = workerModule
import { openChallenge } from '../server/directory/src/challenge.js'
import { existsSync } from 'node:fs'
import { fingerprint, ROSTER_LIMITS } from '../server/directory/src/roster.js'
import { b64uDec, b64uEnc, sha256b64u } from '../kernel/src/statements.ts'
import { buildRos, parseRos, verifyRip, verifyRosterChain, ROSTER_RP_ID, ROSTER_WEB_ORIGINS, ROSTER_WAIT_MS, type Member, type RosterLink } from '../kernel/src/roster.ts'
import { readFileSync, readdirSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
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
    const cd: Record<string, unknown> = { type: o.type ?? 'webauthn.create', challenge: b64uEnc(challenge), origin: o.origin ?? S }
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

// =====================================================================
// 1. THE constant: rp id.bento.page; S the only web origin; matches the kernel
// =====================================================================
ok(PASSKEY.rpId === 'id.bento.page' && PASSKEY.rpId === ROSTER_RP_ID, 'rp id is id.bento.page, as the kernel says')
ok(JSON.stringify(Object.entries(PASSKEY.origins).filter(([, c]) => c === 'browser').map(([o]) => o).sort()) === JSON.stringify([...ROSTER_WEB_ORIGINS].sort()),
  'the browser origins are exactly the kernel\'s ROSTER_WEB_ORIGINS')
ok(JSON.stringify(passkeyOrigins()) === JSON.stringify(['https://signin.id.bento.page']), 'the origin list is exactly https://signin.id.bento.page (no native origin is measured yet)')
for (const o of ['https://bento.page', 'https://home.bento.page', 'https://id.bento.page', 'https://x.id.bento.page', 'https://x.signin.id.bento.page'])
  ok(!passkeyOrigins().includes(o), `${o} is not an accepted origin`)
ok(Object.isFrozen(PASSKEY) && Object.isFrozen(PASSKEY.origins), 'the constant is frozen')
{
  // ONE constant: no other directory source names the rp or an origin literal
  const dir = join(root, 'server/directory/src')
  const hits = readdirSync(dir).filter((f) => f !== 'passkey.js').filter((f) => /'id\.bento\.page'|signin\.id\.bento\.page/.test(readFileSync(join(dir, f), 'utf8')))
  ok(hits.length === 0, `rp id and origins live only in passkey.js (also in: ${hits.join(', ') || 'none'})`)
}

// =====================================================================
// 2. registration, over real browser captures and a software authenticator
// =====================================================================
{
  const F = JSON.parse(readFileSync(join(root, 'server/directory/fixtures/registrations-v1.json'), 'utf8'))
  ok(F.rows.length >= 6, 'registration fixture loaded')
  for (const row of F.rows) {
    const cdj = JSON.parse(new TextDecoder().decode(b64uDec(row.reg.clientDataJSON)!))
    const ch = row.text !== undefined ? await sha256(te.encode(row.text)) : b64uDec(cdj.challenge)!
    const v = await verifyRegistration(row.reg, ch)
    if (row.expect === 'accept') ok(v.ok && v.value.pub === row.pub && v.value.credId === row.credId, `real registration ${row.name} accepted with its own key`)
    else ok(!v.ok && v.reason === row.reason, `real registration ${row.name} refused: ${row.reason} (got ${v.ok ? 'ok' : v.reason})`)
  }
  // a registration carries no signature the directory relies on, so its client data can be rewritten:
  // the real capture, moved to each refused origin, is refused by the origin check alone
  const real = F.rows.find((r: { name: string }) => r.name === 'real/bundled/setup')
  const cd = JSON.parse(new TextDecoder().decode(b64uDec(real.reg.clientDataJSON)!))
  const ch = await sha256(te.encode(real.text))
  for (const o of ['https://bento.page', 'https://home.bento.page', 'https://id.bento.page', 'https://x.id.bento.page']) {
    const v = await verifyRegistration({ ...real.reg, clientDataJSON: cdjOf({ ...cd, origin: o }) }, ch)
    ok(!v.ok && v.reason === 'origin', `real registration re-pointed at ${o}: refused by origin (got ${v.ok ? 'ok' : v.reason})`)
  }
  const ctl = await verifyRegistration({ ...real.reg, clientDataJSON: cdjOf(cd) }, ch)
  ok(ctl.ok, 'control: the same capture, re-serialised unchanged, is accepted (so the origin rows can see the difference)')
  ok(!(await verifyRegistration(real.reg, await sha256(te.encode('other')))).ok, 'real registration over another challenge refused')
}
{
  const a = await Authn.make()
  const ch = crypto.getRandomValues(new Uint8Array(32))
  const reg = async (o: RegOpts) => verifyRegistration(await a.register(ch, o), ch)
  const want = async (o: RegOpts, reason: string, name: string) => { const v = await reg(o); ok(!v.ok && v.reason === reason, `sw registration ${name}: ${reason} (got ${v.ok ? 'ok' : v.reason})`) }
  const ctl = await reg({})
  ok(ctl.ok && ctl.value.pub === a.pub && ctl.value.credId === a.cid, 'sw registration control accepted')
  await want({ alg: -257 }, 'alg', 'RS256')
  await want({ alg: -8 }, 'alg', 'EdDSA')
  await want({ flags: 0x41 }, 'uv', 'UV clear')
  await want({ flags: 0x44 }, 'up', 'UP clear')
  await want({ type: 'webauthn.get' }, 'type', 'an assertion\'s type')
  await want({ cross: true }, 'cross-origin', 'crossOrigin true')
  await want({ cross: 'false' }, 'cross-origin', 'crossOrigin "false" string')
  await want({ top: 'https://home.bento.page' }, 'cross-origin', 'topOrigin present')
  await want({ rpId: 'bento.page' }, 'rp', 'parent rp bento.page')
  await want({ rpId: 'home.bento.page' }, 'rp', 'rp home.bento.page')
  await want({ extraCoseKey: true }, 'key', 'COSE key with an extra label')
  await want({ trailing: true }, 'grammar', 'trailing byte after the key')
  await want({ noAt: true }, 'grammar', 'no attested credential')
  await want({ flags: 0x55 }, 'grammar', 'BS without BE')
  // X1: a COSE key naming its algorithm twice (RS256, then ES256): refused, never read as the last value
  await want({ dupAlg: true }, 'grammar', 'COSE key with the alg label twice')
  {
    let threw = false
    try { readCbor(new Uint8Array([0xa2, 0x01, 0x01, 0x01, 0x02]), 0) } catch { threw = true }
    ok(threw, 'the CBOR reader refuses a map with a repeated key')
    ok((readCbor(new Uint8Array([0xa2, 0x01, 0x01, 0x02, 0x02]), 0)[0] as Map<number, number>).get(2) === 2, 'control: the same map with distinct keys reads')
  }
  // X13: the origin is matched exactly, never by prefix
  for (const o of [`${S}:8443`, `${S}.attacker.example`, `${S}/`, `${S}x`])
    await want({ origin: o }, 'origin', `origin ${o} (a prefix of it is the sign-in host)`)
  const dup = `{"type":"webauthn.create","challenge":"${b64uEnc(ch)}","origin":"https://home.bento.page","crossOrigin":false,"origin":"${S}"}`
  await want({ cdj: b64uEnc(te.encode(dup)) }, 'duplicate-key', 'duplicate origin (JSON.parse would keep the S one)')
  ok(!(await verifyRegistration(await a.register(ch), new Uint8Array(8))).ok, 'a challenge shorter than 16 bytes is refused')
  ok(!(await verifyRegistration(null, ch)).ok && !(await verifyRegistration({ clientDataJSON: 1, authenticatorData: [] }, ch)).ok, 'junk registrations refused, never thrown')
}

// =====================================================================
// 3. assertions: the kernel's real rows, through the directory's wrapper
// =====================================================================
{
  const F = JSON.parse(readFileSync(join(root, 'kernel/fixtures/webauthn-v1.json'), 'utf8'))
  ok(F.rpId === PASSKEY.rpId && JSON.stringify(F.origins) === JSON.stringify(passkeyOrigins()), 'the kernel fixture was made for this rp and origin list')
  let n = 0
  for (const row of F.rows.filter((r: { name: string; text?: string }) => r.name.startsWith('real/') && typeof r.text === 'string')) {
    // the wrapper derives the challenge from the text, as the directory does: only rows whose challenge IS sha256(text)
    if (b64uEnc(await sha256(te.encode(row.text))) !== row.challenge) continue
    const v = await verifyMemberAssertion(row.assertion, { publicKey: F.keys[row.key], text: row.text, storedSignCount: row.storedSignCount })
    if (row.expect === 'accept') ok(v.ok && v.value.origin === S, `real assertion ${row.name} accepted (origin ${S})`)
    else ok(!v.ok && (row.reason === undefined || v.reason === row.reason), `real assertion ${row.name} refused (${row.reason}; got ${v.ok ? 'ok' : v.reason})`)
    n++
  }
  ok(n >= 30, `${n} real kernel rows ran through the directory`)
  const named = (name: string) => F.rows.find((r: { name: string }) => r.name === name)
  for (const name of ['real/rp-host-origin', 'real/sibling-under-rp-origin', 'real/subdomain-origin', 'real/parent-rp-id', 'real/framed-by-parent'])
    ok(named(name), `kernel row ${name} exists (the refused-origin rows above include it)`)
}

// =====================================================================
// 4. setup: token + registration over a fresh challenge
// =====================================================================
const alice = 'alice@example.com'
const A1 = await Authn.make()
{
  mailbox.length = 0
  ok((await head(alice)).status === 404, 'no roster before setup: 404')
  const t1 = await setupToken(alice)
  ok(typeof t1 === 'string' && b64uDec(t1!)!.length === 32, 'a setup token is 256 bits')
  now += 2 * MIN
  const t2 = await setupToken(alice) // a second start (a stranger's) adds a token, never replaces the first
  ok(typeof t2 === 'string' && t2 !== t1, 'a second setup start mints another token')
  // R10b/R1-burn, on the setup token: wrong guesses from many addresses never spend the real one
  for (let i = 0; i < 12; i++) {
    const r = await setup(alice, await Authn.make(), { token: b64uEnc(crypto.getRandomValues(new Uint8Array(32))) })
    ok(r.status === 400 && r.j.error === 'token', `stranger guess ${i + 1}: refused (token)`)
  }
  // a registration from a refused origin, with the REAL token: refused, and the token survives
  const bad = await setup(alice, A1, { token: t1!, reg: { origin: 'https://home.bento.page' } })
  ok(bad.status === 400 && bad.j.error === 'origin', 'setup with a home.bento.page registration refused (origin)')
  const bad2 = await setup(alice, A1, { token: t1!, reg: { alg: -257 } })
  ok(bad2.status === 400 && bad2.j.error === 'alg', 'setup with an RS256 registration refused (alg)')
  ok((await head(alice)).status === 404, 'nothing was stored by the refused setups')
  // the owner's FIRST token still works after twelve wrong guesses and the second start
  const good = await setup(alice, A1, { token: t1! })
  ok(good.status === 200, `setup with the first token after 12 wrong guesses: 200 (got ${good.status} ${JSON.stringify(good.j)})`)
  const c = await current(alice)
  ok(c.head && c.head.seq === 0 && c.head.prev === null && c.head.members.length === 1 && c.head.members[0].pub === A1.pub && !c.head.members[0].quarantined,
    'ros.0 names exactly the registered passkey')
  ok(c.text === good.j.ros, 'the head served is the one setup returned')
  const replay = await setup(alice, await Authn.make(), { token: t2! })
  ok(replay.status === 409 && replay.j.error === 'exists', 'a second setup on a set-up address refused (exists); setup tokens are gone')
  ok((await setupToken(alice)) === null, 'setup start on a set-up address mints nothing (a reset comes later)')
  const m = lastMail(alice) ?? NOMAIL
  ok(m && m.kind === 'roster' && /set up/.test(m.subject) && m.body.includes(await fingerprint(A1.pub)) && /from a browser/.test(m.body),
    'setup notice mailed with the roster and the host class')
  ok(!/https?:\/\//.test(m.body), 'the setup notice carries no link')
}
{
  // the challenge is single use and bound to its address
  const bob = 'bob@example.com'
  const t = (await setupToken(bob))!
  const ch = await challenge(alice)
  const cross = await setup(bob, await Authn.make(), { token: t, ch })
  ok(cross.status === 400 && cross.j.error === 'nonce', 'a challenge issued for alice is refused at bob')
  const ch2 = await challenge(bob)
  now += 6 * MIN
  const late = await setup(bob, await Authn.make(), { token: t, ch: ch2 })
  ok(late.status === 400 && late.j.error === 'nonce', 'an expired challenge is refused')
  const ch3 = await challenge(bob)
  const B1 = await Authn.make()
  ok((await setup(bob, B1, { token: t, ch: ch3 })).status === 200, 'bob sets up with a fresh challenge')
  const again = await setup(bob, await Authn.make(), { token: t, ch: ch3 })
  ok(again.status === 400 && again.j.error === 'nonce', 'the same challenge again is refused (spent before anything else)')
}
{
  // X31: a setup token is good for its life and no longer
  const tess = 'tess@example.com'
  const old = (await setupToken(tess))!
  now += ROSTER_LIMITS.setupTtlMs + 1
  const late = await setup(tess, await Authn.make(), { token: old })
  ok(late.status === 400 && late.j.error === 'token', 'a setup token past its life is refused (token)')
  ok((await head(tess)).status === 404, 'nothing was stored by it')
  const fresh = (await setupToken(tess))!
  now += ROSTER_LIMITS.setupTtlMs - MIN
  ok((await setup(tess, await Authn.make(), { token: fresh })).status === 200, 'control: a token a minute short of its life sets up')
}

// =====================================================================
// 5. changes: request, 72 h on the directory's clock, one at a time
// =====================================================================
const A2 = await Authn.make(), A3 = await Authn.make()
let addAt = 0
{
  mailbox.length = 0
  now += HOUR
  const before = await current(alice)
  // the requester's `created` says 100 hours ago: it must not shorten the wait
  const r = await request(alice, A1, { add: A2, created: now - 100 * HOUR, rq: 'https://home.bento.page' })
  addAt = now
  ok(r.status === 202 && r.j.requestedAt === now && r.j.ripensAt === now + ROSTER_WAIT_MS, `add A2 queued 72 h from the DIRECTORY's clock (got ${r.status} ${JSON.stringify(r.j)})`)
  const c = await current(alice)
  ok(c.text === before.text && c.pending && c.pending.ros === r.ros, 'the head is unchanged and the change shows as pending')
  // the queued mail: the change in words, the second, the host class, and the WHOLE roster as it would be
  const m = (lastMail(alice) ?? NOMAIL)
  const t = new Date(addAt).toISOString().slice(11, 19)
  ok(m && /waiting/.test(m.subject) && m.body.includes(`add the passkey ${await fingerprint(A2.pub)}`) && m.body.includes(t) && /from a browser/.test(m.body),
    'queued mail states the change in words, to the second, with the host class')
  ok(m.body.includes(await fingerprint(A1.pub)) && m.body.includes(await fingerprint(A2.pub)), 'queued mail lists the whole roster as it would be')
  ok(m.body.includes(`asked for by the passkey ${await fingerprint(A1.pub)}`), 'queued mail names the passkey that asked')
  // R8: a second change while one waits is refused; so is a self-removal
  const second = await request(alice, A1, { add: A3 })
  ok(second.status === 409 && second.j.error === 'pending', 'a second change while one waits: refused (pending)')
  now += 71 * HOUR
  ok((await current(alice)).head?.seq === 0, 'at +71 h the change is not in force')
  now = addAt + ROSTER_WAIT_MS
  mailbox.length = 0
  const c2 = await current(alice)
  ok(c2.head?.seq === 1 && c2.head?.members.some((m) => m.pub === A2.pub) && c2.pending === null, 'at +72 h the change is in force (ripened lazily on read)')
  const m2 = (lastMail(alice) ?? NOMAIL)
  ok(m2 && /changed/.test(m2.subject) && /now in effect/.test(m2.body) && m2.body.includes(await fingerprint(A1.pub)) && m2.body.includes(await fingerprint(A2.pub)),
    'ripening mail lists the whole roster')
  // the stored link carries the directory's times and its countersign, issued at ripening (G2)
  const store = (await rosterObj(alice)).store
  const link = store.get('link:00000001') as Record<string, unknown>
  ok(link && link.requestedAt === addAt && link.ripenedAt === addAt + ROSTER_WAIT_MS && link.ros === r.ros, 'link 1 stored with requestedAt and ripenedAt on the directory clock')
  const rip1 = await verifyRip(String(link?.rip), String(link?.ripSig), { rosText: r.ros, directoryKeys: DIR_KEYS, now })
  ok(rip1.ok && rip1.value.auth === 'm' && rip1.value.cause === null && rip1.value.requestedAt === addAt && rip1.value.ripenedAt === addAt + ROSTER_WAIT_MS && rip1.value.kid === 'dir-1',
    `link 1's rip. is the directory's, word m, with the directory's two times (got ${rip1.ok ? `${rip1.value.auth} ${rip1.value.requestedAt - addAt}` : rip1.reason})`)
  const rip0 = store.get('link:00000000') as Record<string, unknown>
  const v0 = await verifyRip(String(rip0?.rip), String(rip0?.ripSig), { rosText: String(rip0?.ros), directoryKeys: DIR_KEYS, now })
  ok(v0.ok && v0.value.auth === 'm' && v0.value.requestedAt === v0.value.ripenedAt, 'the setup head is countersigned at once, word m')
  const ch = await chainOf(alice)
  ok(ch.ok && ch.value.seq === 1 && ch.value.members.some((m) => m.pub === A2.pub), `the kernel's chain verifier accepts the directory's chain (${ch.ok ? 'ok' : ch.reason})`)
  // G2: nothing a request answers, and no waiting change, carries a countersign
  ok(!responses.some((x) => x.what === 'request' && x.text.includes('rip.')), 'no request answer carries a rip. countersign')
}
{
  // the alarm path ripens too
  now += HOUR
  const o = await rosterObj(alice)
  // the platform has run every alarm that came due before now (this harness runs them by hand)
  for (let i = 0; i < 10 && o.alarm !== null && o.alarm <= now; i++) await fire(o)
  ok(o.alarm === null, 'nothing is left to come before the request')
  const r = await request(alice, A2, { add: A3 })
  ok(r.status === 202, 'A2 (a member now) asks to add A3')
  const asked = now
  // one alarm, two users: the request's spent challenge is swept first, and the 72 hours never push that back
  ok(o.alarm !== null && o.alarm > asked && o.alarm <= asked + ROSTER_LIMITS.spentKeepMs, `the first alarm is the spent challenge's sweep, not pushed back by the 72-hour wait (${o.alarm === null ? 'none' : (o.alarm - asked) / MIN + ' min'})`)
  // the platform runs each alarm when it is due; earlier ones may still be set from older spends
  for (let i = 0; i < 10 && o.alarm !== null && o.alarm < asked + ROSTER_WAIT_MS; i++) { now = Math.max(now, o.alarm); await fire(o) }
  ok(![...o.store.keys()].some((k) => k.startsWith('spent:')) && (o.store.get('head') as { seq: number } | undefined)?.seq === 1, 'that alarm sweeps the spent challenges and ripens nothing early')
  ok(o.alarm === asked + ROSTER_WAIT_MS, 'and sets the next alarm for the ripening time')
  now = o.alarm ?? now
  await fire(o)
  ok((o.store.get('head') as { seq: number } | undefined)?.seq === 2, 'the alarm makes the change the head')
}

// =====================================================================
// 6. who may ask, and what one request may change
// =====================================================================
{
  now += HOUR
  const X = await Authn.make()
  const nm = await request(alice, X, { remove: A3.pub })
  ok(nm.status === 400 && nm.j.error === 'signer', 'a passkey that is not a member: refused (signer)')
  const nm2 = await request(alice, X, { remove: A3.pub, credId: A1.cid })
  ok(nm2.status === 400 && nm2.j.error === 'assertion-signature', 'a stranger\'s assertion under a member\'s credential id: refused (signature)')
  const R5 = await request(alice, A1, { remove: A3.pub, noAssertion: true, origin: 'https://signin.id.bento.page' })
  ok(R5.status === 400 && /^assertion-/.test(R5.j.error as string), 'no assertion, whatever Origin the caller sends: refused (R5)')
  const fromHome = await request(alice, A1, { remove: A3.pub, get: { origin: 'https://home.bento.page' } })
  ok(fromHome.status === 400 && fromHome.j.error === 'assertion-origin', 'an assertion made on home.bento.page: refused (origin)')
  const fromId = await request(alice, A1, { remove: A3.pub, get: { origin: 'https://id.bento.page' } })
  ok(fromId.status === 400 && fromId.j.error === 'assertion-origin', 'an assertion made on id.bento.page: refused (origin)')
  const fromApex = await request(alice, A1, { remove: A3.pub, get: { origin: 'https://bento.page' } })
  ok(fromApex.status === 400 && fromApex.j.error === 'assertion-origin', 'an assertion made on bento.page: refused (origin)')
  const parentRp = await request(alice, A1, { remove: A3.pub, get: { rpId: 'bento.page' } })
  ok(parentRp.status === 400 && parentRp.j.error === 'assertion-rp', 'an assertion for the parent rp bento.page: refused (rp)')
  const noUv = await request(alice, A1, { remove: A3.pub, get: { flags: 0x01 } })
  ok(noUv.status === 400 && noUv.j.error === 'assertion-uv', 'an assertion without UV: refused')
  const two = await request(alice, A1, { add: X, remove: A3.pub })
  ok(two.status === 400 && two.j.error === 'multi-change', 'add one and remove another in one request: refused')
  const Y = await Authn.make()
  const c = await current(alice)
  const twoAdds = await request(alice, A1, { members: [...(c.head?.members ?? []), { kind: 'pk', pub: X.pub, quarantined: false }, { kind: 'pk', pub: Y.pub, quarantined: false }], reg: await X.register(new Uint8Array(32)) })
  ok(twoAdds.status === 400 && twoAdds.j.error === 'multi-change', 'two added in one request: refused')
  const none = await request(alice, A1, { members: c.head?.members ?? [] })
  ok(none.status === 400 && none.j.error === 'no-change', 'a request that changes nothing: refused')
  const markQ = await request(alice, A1, { members: (c.head?.members ?? []).map((m) => (m.pub === A3.pub ? { ...m, quarantined: true } : m)) })
  ok(markQ.status === 400 && markQ.j.error === 'quarantine', 'a requester cannot set a quarantine mark')
  const newQ = await request(alice, A1, { members: [...(c.head?.members ?? []), { kind: 'pk', pub: X.pub, quarantined: true }], reg: undefined })
  ok(newQ.status === 400 && newQ.j.error === 'quarantine', 'a new member cannot arrive quarantined')
  const ck = await request(alice, A1, { members: [...(c.head?.members ?? []), { kind: 'ck', pub: X.pub, quarantined: false }] })
  ok(ck.status === 400 && ck.j.error === 'kind', 'adding a consent key: refused until its rules exist')
  const noReg = await request(alice, A1, { add: X, reg: null })
  ok(noReg.status === 400 && /^registration-/.test(noReg.j.error as string), 'an add without the new passkey\'s registration: refused')
  const wrongKey = await request(alice, A1, { add: X, reg: await Y.register(new Uint8Array(32)) })
  ok(wrongKey.status === 400 && wrongKey.j.error === 'registration-challenge', 'a registration over another challenge: refused')
  const ch = await challenge(alice)
  const wrongKey2 = await request(alice, A1, { add: X, ch, reg: await Y.register(b64uDec(ch)!) })
  ok(wrongKey2.status === 400 && wrongKey2.j.error === 'registration-key', 'a registration of a different key than the one added: refused')
  const regHome = await request(alice, A1, { add: X, regOpts: { origin: 'https://home.bento.page' } })
  ok(regHome.status === 400 && regHome.j.error === 'registration-origin', 'the added passkey registered on home.bento.page: refused')
  const regRs = await request(alice, A1, { add: X, regOpts: { alg: -257 } })
  ok(regRs.status === 400 && regRs.j.error === 'registration-alg', 'the added passkey RS256: refused (ES256 only)')
  // a new passkey whose credential id is already on the roster
  const Z = await Authn.make(); Z.credId = A1.credId
  const dupCred = await request(alice, A1, { add: Z })
  ok(dupCred.status === 400 && dupCred.j.error === 'registration-credential', 'an added passkey reusing a member\'s credential id: refused')
  const stale = await request(alice, A1, { remove: A3.pub, seq: c.head?.seq + 2 })
  ok(stale.status === 409 && stale.j.error === 'stale', 'a request on the wrong seq: refused (stale)')
  const stale2 = await request(alice, A1, { remove: A3.pub, prev: await sha256b64u('nope') })
  ok(stale2.status === 409 && stale2.j.error === 'stale', 'a request on the wrong prev: refused (stale)')
  // X22: a ros. naming another address, chained on this head and signed by a member: refused
  const elsewhere = await request(alice, A1, { remove: A3.pub, address: 'bob@example.com' })
  ok(elsewhere.status === 400 && elsewhere.j.error === 'address', 'a request whose ros. names another address: refused (address)')
  const otherAddr = await request(alice, A1, { remove: A3.pub })
  ok(otherAddr.status === 202, 'control: A1 removing A3 (not itself) is queued, not immediate')
  ok((await current(alice)).head?.members.some((m) => m.pub === A3.pub), 'A3 is still a member while its removal waits')
  now += ROSTER_WAIT_MS
  ok(!(await current(alice)).head?.members.some((m) => m.pub === A3.pub), 'A3 removed after 72 h')
  const gone = await request(alice, A3, { remove: A2.pub })
  ok(gone.status === 400 && gone.j.error === 'signer', 'a removed passkey can no longer ask (its credential is forgotten)')
  const badRq = await request(alice, A1, { remove: A2.pub, rq: 'https://attacker.example' })
  ok(badRq.status === 400 && badRq.j.error === 'rq', 'an opener other than home.bento.page is refused')
}

// =====================================================================
// 7. the signature counter, per credential, in order
// =====================================================================
{
  now += HOUR
  const carol = 'carol@example.com'
  const C1 = await Authn.make(), C2 = await Authn.make()
  C1.count = 5
  ok((await setup(carol, C1)).status === 200, 'carol sets up with a counter of 5')
  const r = await request(carol, C1, { add: C2, get: { count: 7 } })
  ok(r.status === 202, 'an assertion with counter 7 after 5: accepted')
  const store = (await rosterObj(carol)).store
  ok((store.get(`pk:${C1.pub}`) as { signCount: number } | undefined)?.signCount === 7, 'the stored counter advanced to 7')
  now += ROSTER_WAIT_MS
  await current(carol)
  const back = await request(carol, C1, { remove: C2.pub, get: { count: 6 } })
  ok(back.status === 400 && back.j.error === 'assertion-sign-count', 'an assertion with counter 6 after 7: refused (sign-count)')
  const same = await request(carol, C1, { remove: C2.pub, get: { count: 7 } })
  ok(same.status === 400 && same.j.error === 'assertion-sign-count', 'the same counter again: refused')
  // a synced passkey (0 and 0) passes
  const dave = 'dave@example.com', D1 = await Authn.make(), D2 = await Authn.make()
  await setup(dave, D1)
  const z = await request(dave, D1, { add: D2, get: { count: 0 } })
  ok(z.status === 202, 'a synced passkey (counter 0 and 0) passes')
}

// =====================================================================
// 8. self-removal: immediate only while another unquarantined passkey stays
// =====================================================================
{
  now += HOUR
  const erin = 'erin@example.com', E1 = await Authn.make(), E2 = await Authn.make()
  await setup(erin, E1)
  await request(erin, E1, { add: E2 })
  now += ROSTER_WAIT_MS
  ok((await current(erin)).head?.members.length === 2, 'erin has two passkeys')
  // self-removal while another change waits: refused (security's spec gap: refused, not immediate)
  const E3 = await Authn.make()
  ok((await request(erin, E1, { add: E3 })).status === 202, 'E1 asks to add E3')
  const wait = await request(erin, E2, { remove: E2.pub })
  ok(wait.status === 409 && wait.j.error === 'pending', 'self-removal while a change waits: refused (pending)')
  now += ROSTER_WAIT_MS
  await current(erin)
  // E3 back off by E3 itself (immediate: E1 and E2 stay), so the rows below start from two
  ok((await request(erin, E3, { remove: E3.pub })).status === 200, 'E3 removes itself at once')
  mailbox.length = 0
  const r = await request(erin, E2, { remove: E2.pub })
  ok(r.status === 200 && r.j.inForce === true, 'E2 removes itself while E1 stays: in force at once')
  ok((await current(erin)).head?.members.length === 1 && (await current(erin)).pending === null, 'the head drops E2 at once')
  const m = (lastMail(erin) ?? NOMAIL)
  ok(m && m.body.includes(`${await fingerprint(E2.pub)} removed itself`) && m.body.includes(await fingerprint(E1.pub)), 'self-removal mailed with the roster that remains')
  const last = await request(erin, E1, { remove: E1.pub })
  ok(last.status === 400 && last.j.error === 'members', 'the only passkey cannot remove itself (a roster is never empty)')

  // with the other member QUARANTINED, a self-removal waits 72 h
  const fay = 'fay@example.com', F1 = await Authn.make(), F2 = await Authn.make()
  await setup(fay, F1)
  await request(fay, F1, { add: F2 })
  now += ROSTER_WAIT_MS
  const c = await current(fay)
  // plant a quarantine mark on F1 (the void page sets these; it is a later change)
  const qMembers = (c.head?.members ?? []).map((x) => (x.pub === F1.pub ? { ...x, quarantined: true } : x))
  const qRos = c.head ? buildRos({ ...c.head, members: qMembers }) : ''
  const qHash = await sha256b64u(qRos)
  await plant(fay, (st) => { const h = st.get('head') as Record<string, unknown>; st.set('head', { ...h, ros: qRos, hash: qHash, members: qMembers }) })
  const qr = await request(fay, F1, { remove: F2.pub })
  ok(qr.status === 403 && qr.j.error === 'quarantined', 'a quarantined member cannot ask (quarantined)')
  const sr = await request(fay, F2, { remove: F2.pub })
  ok(sr.status === 202 && sr.j.ripensAt === now + ROSTER_WAIT_MS, 'self-removal with only a QUARANTINED passkey left: waits 72 h')
}

// =====================================================================
// 9. the log: every enrolment and change, with origins and time
// =====================================================================
{
  const all = (await doOp(alice, 'logQuery', { from: 0, to: now })).j.entries as Record<string, unknown>[]
  const kinds = all.map((e) => e.k)
  ok(kinds.filter((k) => k === 'setup').length === 1 && kinds.filter((k) => k === 'reg').length === 3, 'alice\'s log: one setup and three passkey enrolments')
  ok(kinds.filter((k) => k === 'request').length === 3 && kinds.filter((k) => k === 'ripen').length === 3, 'alice\'s log: three requests, three ripenings')
  ok(all.every((e) => typeof e.at === 'number' && typeof e.os === 'string' && typeof e.co === 'string'), 'every entry has a time, the request Origin and the ceremony origin')
  ok(all.filter((e) => e.k === 'request' || e.k === 'setup').every((e) => e.os === S && e.co === S), 'requests from the sign-in host are logged with os and co = the sign-in host')
  ok(all.some((e) => e.k === 'request' && e.rq === 'https://home.bento.page' && e.at === addAt), 'the opener the sign-in host reported is logged (rq)')
  // the lever acts on the exact key: every entry names it in full (65-byte point), never a fingerprint
  ok(all.every((e) => typeof e.pub === 'string' && b64uDec(e.pub as string)?.length === 65 && !('fp' in e)), 'every entry logs the full public key it is about')
  const reqAt = all.find((e) => e.k === 'request' && e.at === addAt)
  ok(reqAt?.pub === A2.pub && reqAt?.by === A1.pub, 'the queued add logs the added key and the asking key in full')
  ok(all.find((e) => e.k === 'setup')?.pub === A1.pub && all.filter((e) => e.k === 'ripen').every((e) => b64uDec(e.by as string)?.length === 65), 'setup and ripening entries carry full keys')
  const win = (await doOp(alice, 'logQuery', { from: addAt, to: addAt })).j.entries as Record<string, unknown>[]
  ok(win.length === 2 && win.every((e) => e.at === addAt), 'a window query returns exactly the entries inside it')
  // an off-page caller's Origin is logged as sent (it over-includes, never under-includes)
  const gus = 'gus@example.com', G1 = await Authn.make()
  await setup(gus, G1, { origin: 'https://attacker.example' })
  const g = (await doOp(gus, 'logQuery', { from: 0, to: now })).j.entries as Record<string, unknown>[]
  ok(g.some((e) => e.k === 'setup' && e.os === 'https://attacker.example' && e.co === S), 'a setup sent with another Origin header is logged with that header')
  const hugeOrigin = 'https://' + 'x'.repeat(5000)
  const hal = 'hal@example.com'
  await setup(hal, await Authn.make(), { origin: hugeOrigin })
  const h = (await doOp(hal, 'logQuery', { from: 0, to: now })).j.entries as Record<string, unknown>[]
  ok(h.every((e) => (e.os as string).length <= ROSTER_LIMITS.originMax), 'a long Origin header is cut to the limit')
}

// =====================================================================
// 10. G10 / C2: no stranger-fillable budget holds back a roster mail
// =====================================================================
{
  now += HOUR
  const ivy = 'ivy@example.com'
  mailbox.length = 0
  // a stranger spends ivy's whole setup-mail budget for the day
  const toks: string[] = []
  for (let i = 0; i < 10; i++) { const t = await setupToken(ivy); if (t) toks.push(t); now += 2 * MIN }
  ok(toks.length === ROSTER_LIMITS.mailPerDay, `the stranger-fillable setup budget caps at ${ROSTER_LIMITS.mailPerDay} a day`)
  ok((await setupToken(ivy)) === null, 'the budget is full')
  const budget = ((await rosterObj(ivy)).store.get('mail') as number[] | undefined)?.length
  const I1 = await Authn.make(), I2 = await Authn.make()
  ok((await setup(ivy, I1, { token: toks[toks.length - 1] })).status === 200, 'ivy sets up with a live token')
  ok(mailsTo(ivy).some((m) => /set up/.test(m.subject)), 'the setup notice is mailed though the budget is full (C2)')
  ok(((await rosterObj(ivy)).store.get('mail') as number[] | undefined)?.length === budget, 'the setup notice spent nothing from the budget')
  await request(ivy, I1, { add: I2 })
  ok(mailsTo(ivy).some((m) => /waiting/.test(m.subject)), 'the queued-change mail goes out though the budget is full')
  now += ROSTER_WAIT_MS
  await current(ivy)
  ok(mailsTo(ivy).some((m) => /changed/.test(m.subject)), 'the ripening mail goes out though the budget is full')
  await request(ivy, I2, { remove: I2.pub })
  ok(mailsTo(ivy).filter((m) => /changed/.test(m.subject)).length === 2, 'the self-removal mail goes out though the budget is full')
  ok(((await rosterObj(ivy)).store.get('mail') as number[] | undefined)?.length === budget, 'no roster mail spent the budget')
  // every roster mail lists every member of the roster it describes
  const fps = [await fingerprint(I1.pub), await fingerprint(I2.pub)]
  const roster = mailsTo(ivy).filter((m) => m.kind === 'roster')
  ok(roster.length === 4 && roster.every((m) => m.body.includes('The passkeys on this account') && m.body.includes(fps[0])), 'every roster mail carries the roster section')
  ok(roster.filter((m) => /waiting|now in effect/.test(m.body)).every((m) => fps.every((f) => m.body.includes(f))), 'the queued and ripening mails list both passkeys')
  ok(mailbox.every((m) => !m.body.includes('<') && (m.kind === 'roster' || m.kind === 'setup')), 'roster and setup mail is plain fixed wording')
}

// =====================================================================
// 10b. D1: a change waits only once its waiting notice was sent
// =====================================================================
{
  now += HOUR
  const mel = 'mel@example.com', M1 = await Authn.make(), M2 = await Authn.make(), M3 = await Authn.make()
  ok((await setup(mel, M1)).status === 200, 'mel sets up')
  const n0 = mailsTo(mel).length
  mailDown = true
  const r = await request(mel, M1, { add: M2 })
  mailDown = false
  ok(r.status === 503 && r.j.error === 'mail', `mailer down: the request fails (503 mail), never a 202 (got ${r.status} ${JSON.stringify(r.j)})`)
  const c = await current(mel)
  ok(c.head?.seq === 0 && c.pending === null, 'nothing is queued')
  ok(!(await rosterObj(mel)).store.has('pend'), 'no waiting change is stored')
  ok(!((await doOp(mel, 'logQuery', { from: 0, to: now })).j.entries as Record<string, unknown>[]).some((e) => e.k === 'request'), 'no request is logged')
  now += ROSTER_WAIT_MS + MIN
  const o = await rosterObj(mel)
  await fire(o)
  ok((await current(mel)).head?.seq === 0 && !(await current(mel)).head?.members.some((m) => m.pub === M2.pub), 'at +72 h the change is not in force: it was never queued')
  ok(mailsTo(mel).length === n0, 'and no "now in effect" mail went out')
  // control: with the mailer back, the same change queues and its notice goes out
  const r2 = await request(mel, M1, { add: M2 })
  ok(r2.status === 202 && mailsTo(mel).some((m) => /waiting/.test(m.subject)), 'control: mailer up, the change queues (202) and its waiting mail is sent')
  ok(((await rosterObj(mel)).store.get('pend') as { mailed?: boolean } | undefined)?.mailed === true, 'the queued change is marked as notified')
  now += ROSTER_WAIT_MS
  ok((await current(mel)).head?.members.some((m) => m.pub === M2.pub), 'control: and it takes effect at +72 h')

  // a change whose object stopped between holding the slot and hearing from the mailer
  now += HOUR
  ok((await request(mel, M1, { add: M3 })).status === 202, 'M1 asks to add M3')
  const asked = now
  await plant(mel, (st) => { const p = st.get('pend') as Record<string, unknown>; st.set('pend', { ...p, mailed: false }) })
  ok((await current(mel)).pending === null, 'an unconfirmed change is not shown as waiting')
  ok((await request(mel, M2, { remove: M1.pub })).status === 409, 'it still holds the slot while it may be mid-send (pending)')
  now = asked + ROSTER_WAIT_MS + MIN
  const o2 = await rosterObj(mel)
  await fire(o2)
  ok(!(await current(mel)).head?.members.some((m) => m.pub === M3.pub), 'an unconfirmed change never takes effect, by alarm or by read')
  ok(!(await rosterObj(mel)).store.has('pend'), 'and it is dropped once it is stale, freeing the slot')
  ok((await request(mel, M1, { add: M3 })).status === 202, 'control: a new request then queues')
}

// =====================================================================
// 10b′. D1a: after a send, the stored change is touched only if it is still
//       this request's; the mailer has a timeout
// =====================================================================
{
  now += HOUR
  type Pend = { ros: string; mailed: boolean } | undefined
  const pend = async (e: string) => (await rosterObj(e)).store.get('pend') as Pend
  // control: a send that hangs and then delivers, with nothing in between, queues as usual
  const ned = 'ned@example.com', N1 = await Authn.make(), N2 = await Authn.make(), N3 = await Authn.make()
  ok((await setup(ned, N1)).status === 200, 'ned sets up')
  {
    const h = hangNext()
    const pA = request(ned, N1, { add: N2 })
    if (!(await reached(h))) { ok(false, 'the request reached its waiting notice'); h.release(false) } else {
    ok((await current(ned)).pending === null && (await pend(ned))?.mailed === false, 'mid-send: the change holds the slot, unsent, and is not shown as waiting')
    h.release(true)
    const rA = await pA
    ok(rA.status === 202 && (await pend(ned))?.ros === rA.ros && (await pend(ned))?.mailed === true, `control: a late but successful send, nothing in between: queued (${rA.status})`)
    await plant(ned, (st) => st.delete('pend'))
    }
  }
  // a send that outlives unsentDropMs: a later request drops the stale change and queues its own
  {
    now += HOUR
    const h = hangNext()
    const pA = request(ned, N1, { add: N2 })
    if (!(await reached(h))) { ok(false, 'the request reached its waiting notice'); h.release(false) } else {
    now += ROSTER_LIMITS.unsentDropMs + MIN
    const rB = await request(ned, N1, { add: N3 })
    ok(rB.status === 202, `11 minutes into a hung send, another request queues (${rB.status} ${JSON.stringify(rB.j)})`)
    h.release(true)
    const rA = await pA
    const p = await pend(ned)
    ok(p?.ros === rB.ros && p?.mailed === true, 'the hung send, once delivered, does not overwrite the later change')
    ok(rA.status === 409 && rA.j.error === 'superseded', `and its request answers 409 superseded, not 202 (${rA.status} ${rA.j.error})`)
    now += ROSTER_WAIT_MS + MIN
    const c = await current(ned)
    ok(c.head?.members.some((m) => m.pub === N3.pub) && !c.head?.members.some((m) => m.pub === N2.pub), 'at +72 h the later change is in force, the superseded one is not')
    }
  }
  // the same, but the hung send then FAILS: its clean-up must not delete the later change
  {
    now += HOUR
    const ola = 'ola@example.com', O1 = await Authn.make(), O2 = await Authn.make(), O3 = await Authn.make()
    await setup(ola, O1)
    const h = hangNext()
    const pA = request(ola, O1, { add: O2 })
    if (!(await reached(h))) { ok(false, 'the request reached its waiting notice'); h.release(false) } else {
    now += ROSTER_LIMITS.unsentDropMs + MIN
    const rB = await request(ola, O1, { add: O3 })
    h.release(false)
    const rA = await pA
    const p = await pend(ola)
    ok(rA.status === 503 && rB.status === 202 && p?.ros === rB.ros && p?.mailed === true, `a hung send that then fails leaves the later change queued (A ${rA.status}, B ${rB.status}, pend ${p ? (p.ros === rB.ros ? 'B' : 'other') : 'none'})`)
    }
  }
  // the change removed mid-send (as a void will): delivered afterwards, it must not come back
  {
    now += HOUR
    const pia = 'pia@example.com', P1 = await Authn.make(), P2 = await Authn.make()
    await setup(pia, P1)
    const h = hangNext()
    const pA = request(pia, P1, { add: P2 })
    if (!(await reached(h))) { ok(false, 'the request reached its waiting notice'); h.release(false) } else {
    await plant(pia, (st) => st.delete('pend'))
    h.release(true)
    const rA = await pA
    ok(!(await pend(pia)) && rA.status === 409, `a change removed mid-send stays removed once the send succeeds (${rA.status}, pend ${(await pend(pia)) ? 'back' : 'gone'})`)
    now += ROSTER_WAIT_MS + MIN
    ok(!(await current(pia)).head?.members.some((m) => m.pub === P2.pub), 'and never takes effect')
    }
  }
  // the mailer's timeout: a send that never answers counts as failed after 30 seconds
  {
    now += HOUR
    ok(MAIL_TIMEOUT_MS === 30_000 && MAIL_TIMEOUT_MS * 10 <= ROSTER_LIMITS.unsentDropMs, `the mailer timeout is 30 s, well under the 10-minute unsent drop (${MAIL_TIMEOUT_MS} ms)`)
    const qin = 'qin@example.com', Q1 = await Authn.make(), Q2 = await Authn.make()
    await setup(qin, Q1)
    const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout
    const timers: { fn: () => void; ms: number }[] = []
    globalThis.setTimeout = ((fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length }) as never
    globalThis.clearTimeout = (() => {}) as never
    let called = false
    mailHook = () => { mailHook = null; called = true; return new Promise<void>(() => {}) } // never answers
    let settled: Awaited<ReturnType<typeof request>> | null = null
    const pR = request(qin, Q1, { add: Q2 }).then((r) => { settled = r })
    const tick = () => new Promise((r) => realSet(r, 0))
    for (let i = 0; i < 200 && !(called && timers.some((t) => t.ms === MAIL_TIMEOUT_MS)); i++) await tick()
    const timer = timers.find((t) => t.ms === MAIL_TIMEOUT_MS)
    ok(called && !!timer, `the never-answering send is under a ${MAIL_TIMEOUT_MS} ms timer (${timers.map((t) => t.ms).join(', ') || 'no timer'})`)
    if (timer) { timer.fn(); for (let i = 0; i < 200 && !settled; i++) await tick() }
    globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear
    mailHook = null
    const r = settled as Awaited<ReturnType<typeof request>> | null
    ok(r?.status === 503 && r?.j.error === 'mail' && !(await pend(qin)), `once it fires, the request fails (503 mail) and nothing is queued (${r ? r.status : 'still hung'})`)
    void pR
    ok((await request(qin, Q1, { add: Q2 })).status === 202, 'control: with the mailer answering, the same change queues')
  }
}

// =====================================================================
// 10c. D2: spent challenges are one key each, and stay bounded
// =====================================================================
{
  const nina = 'nina@example.com' // never set up: spending needs no account
  const store = (await rosterObj(nina)).store
  const spentKeys = () => [...store.keys()].filter((k) => k.startsWith('spent:')).length
  const stranger = async () => {
    const c = await challenge(nina)
    const r = await api('POST', '/v1/roster/request', { email: nina, ros: `ros.x.1.y.z.${c}.0` })
    return { c, r }
  }
  // positive control: with the clock still, every spend is recorded, each under its own key
  for (let i = 0; i < 200; i++) await stranger()
  ok(spentKeys() === 200, `200 stranger spends at one instant leave 200 spent keys (${spentKeys()})`)
  ok(!store.has('spent'), 'no single growing spent value exists')
  const { c: early } = await stranger()
  // a sustained stranger load, one spend a second for an hour
  let maxKeys = 0, steadyMax = 0, maxValue = 0
  for (let i = 0; i < 3600; i++) {
    now += 1000
    const { r } = await stranger()
    if (i === 290) {
      // the earliest challenge, swept or not, can never be spent twice in its life
      const again = await api('POST', '/v1/roster/request', { email: nina, ros: `ros.x.1.y.z.${early}.0` })
      ok(again.status === 400 && again.j.error === 'nonce', 'a challenge spent 4m50s ago is still refused as spent')
    }
    if (i === 0) ok(r.status === 404, 'a stranger\'s spend on an address with no roster answers 404 (after spending)')
    maxKeys = Math.max(maxKeys, spentKeys())
    if (i >= 700) steadyMax = Math.max(steadyMax, spentKeys()) // the burst above has drained by then
    for (const v of store.values()) maxValue = Math.max(maxValue, JSON.stringify(v).length)
  }
  // what may be held: the spends of the last 10 minutes (one a second), plus a backlog that drains
  const window = ROSTER_LIMITS.spentKeepMs / 1000 + 1
  ok(steadyMax <= window, `3600 spends over an hour: once steady, never more than the last 10 minutes' ${window} (most: ${steadyMax})`)
  ok(maxKeys <= window + 201, `and at the worst, the 201-spend burst on top of that window (most: ${maxKeys})`)
  ok(spentKeys() <= ROSTER_LIMITS.spentKeepMs / 1000 + 1, `and at the end only the last ${ROSTER_LIMITS.spentKeepMs / MIN} minutes' are held (${spentKeys()})`)
  ok(maxValue < 64, `no stored value grows with the load (largest ${maxValue} bytes of JSON)`)
}
{
  // the alarm sweeps what nobody's later spend will: an address that goes quiet keeps no spent keys
  now += HOUR
  const opal = 'opal@example.com' // never set up
  const o = await rosterObj(opal)
  const keys = () => [...o.store.keys()].filter((k) => k.startsWith('spent:')).length
  const spendOnce = async () => { const c = await challenge(opal); await api('POST', '/v1/roster/request', { email: opal, ros: `ros.x.1.y.z.${c}.0` }) }
  const t0 = now
  for (let i = 0; i < 300; i++) await spendOnce() // more than one sweep batch
  ok(keys() === 300 && o.alarm !== null && o.alarm > t0 && o.alarm <= t0 + ROSTER_LIMITS.spentKeepMs, `300 spends, then quiet: an alarm is armed for when they may go (${o.alarm === null ? 'none' : (o.alarm - t0) / MIN + ' min'})`)
  // control: an alarm run before their keep is up deletes none and comes back later
  await fire(o)
  ok(keys() === 300 && o.alarm !== null && o.alarm >= now + 1000, `control: run early, it deletes none (${keys()} left) and is set again`)
  now = t0 + ROSTER_LIMITS.spentKeepMs
  await fire(o)
  ok(keys() === 0, `run when due, it sweeps every one of them (${keys()} left)`)
  ok(o.alarm === null, 'and with nothing left to come, sets no further alarm')
}
{
  // Z13: a spend due sooner brings an alarm set for a 72-hour ripening forward
  now += HOUR
  const kit = 'kit@example.com', K1 = await Authn.make(), K2 = await Authn.make()
  await setup(kit, K1)
  const o = await rosterObj(kit)
  ok((await request(kit, K1, { add: K2 })).status === 202, 'kit queues a change')
  const ripens = now + ROSTER_WAIT_MS
  for (let i = 0; i < 10 && o.alarm !== null && o.alarm < ripens; i++) { now = Math.max(now, o.alarm); await fire(o) }
  ok(o.alarm === ripens, 'once its spent keys are swept, the alarm sits at the ripening, 72 hours out')
  now += HOUR
  const c = await challenge(kit)
  await api('POST', '/v1/roster/request', { email: kit, ros: `ros.x.1.y.z.${c}.0` }) // a stranger's spend
  ok(o.alarm !== null && o.alarm > now && o.alarm <= now + ROSTER_LIMITS.spentKeepMs, `a stranger's spend then brings it forward to its own sweep (${o.alarm === null ? 'none' : (o.alarm - now) / MIN + ' min'})`)
  now = o.alarm ?? now
  await fire(o)
  ok(![...o.store.keys()].some((k) => k.startsWith('spent:')) && o.alarm === ripens && (await current(kit)).head?.seq === 0, 'which sweeps it and puts the ripening back, nothing ripened early')
}

// =====================================================================
// 10d. D3: an unexpected failure still answers JSON with the full header set
// =====================================================================
{
  const call = async (e: Record<string, unknown>, method: string, path: string, body?: unknown) => {
    try {
      const r = await worker.fetch(new Request('https://id.bento.page' + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'cf-connecting-ip': freshIp(), origin: S } }), e as never)
      const text = await r.text()
      responses.push({ what: `D3 ${path}`, status: r.status, h: r.headers, text })
      return { status: r.status, text }
    } catch (x) { return { status: -1, text: String(x) } }
  }
  const noKey = await call({ ...env, CHALLENGE_KEY: undefined }, 'POST', '/v1/roster/challenge', { email: 'x@example.com' })
  ok(noKey.status === 500 && JSON.parse(noKey.text || '{}').error === 'internal', `CHALLENGE_KEY unset: 500 JSON, not an escaped exception (got ${noKey.status} ${noKey.text.slice(0, 60)})`)
  ok(!noKey.text.includes('CHALLENGE_KEY'), 'the error answer names no internals')
  const broken = { idFromName: (n: string) => n, get: () => ({ fetch: async () => { throw new Error('storage unavailable') } }) }
  const st = await call({ ...env, ROSTER: broken }, 'GET', '/v1/roster?e=x@example.com')
  ok(st.status === 500, `a storage failure: 500 JSON (got ${st.status})`)
  const ctl = await call(env, 'POST', '/v1/roster/challenge', { email: 'x@example.com' })
  ok(ctl.status === 200, 'control: the same challenge call with the key set answers 200')
  // Y26: a failure on a web route keeps the sign-in host's CORS, never `*`
  let web500: Response | null = null
  try { web500 = await worker.fetch(new Request('https://id.bento.page/v1/web/challenge', { method: 'POST', body: '{}', headers: { 'cf-connecting-ip': freshIp(), origin: S } }), { ...env, CHALLENGE_KEY: undefined } as never) } catch { /* an escaped exception: the row fails */ }
  ok(web500?.status === 500 && web500.headers.get('access-control-allow-origin') === SIGNIN_ORIGIN && /Origin/.test(web500.headers.get('vary') ?? ''),
    `a 500 on a web route answers CORS for the sign-in host only (${web500?.status}, ${web500?.headers.get('access-control-allow-origin')})`)
  ok(noKey.status === 500 && responses.find((x) => x.what === 'D3 /v1/roster/challenge' && x.status === 500)?.h.get('access-control-allow-origin') === '*', 'control: a 500 on any other route keeps *')
}

// =====================================================================
// 10e. setup links (G13): mailed, fragment-only, completed only by a passkey
// =====================================================================
{
  now += HOUR
  const uma = 'uma@example.com'
  const n0 = mailbox.length
  const r = await seen('setup-start', api('POST', '/v1/roster/setup/start', { email: 'Uma@Example.com' }))
  ok(r.status === 202 && r.j.ok === true, 'setup start → 202')
  const m = mailbox.slice(n0).find((x) => x.to === uma) ?? NOMAIL
  ok(m.kind === 'setup' && /Set up your bento\/id account/.test(m.subject), 'a setup link is mailed to the normalised address')
  const urls = m.body.match(/https?:\/\/\S+/g) ?? []
  ok(urls.length === 1, `the mail carries exactly one link (${urls.length})`)
  const link = urls[0] ?? ''
  const u = (() => { try { return new URL(link) } catch { return null } })()
  ok(u?.origin === SIGNIN_ORIGIN && u?.pathname === SIGNIN_PATHS.setup && u?.search === '', 'the link opens /setup on the sign-in host, with no query')
  const l = parseSetupLink(link)
  ok(!!l && l.address === uma && b64uDec(l.token)?.length === 32, 'its fragment carries v=1, the address and a 256-bit token')
  ok(!!l && !link.split('#')[0].includes(l.token) && new URLSearchParams(u?.hash.slice(1)).get('v') === '1', 'the token is only in the fragment, which no browser sends to a server')
  ok(!/Your code|enter (it|the code)/i.test(m.body) && /Bento will never ask you to type or paste anything/.test(m.body), 'the mail has no code to type')
  ok(/changes nothing by itself/.test(m.body) && /make a passkey/.test(m.body), 'the mail says opening the link alone does nothing')
  ok(!urls.some((x) => { try { return new URL(x).origin === 'https://id.bento.page' } catch { return false } }), 'no link points at id.bento.page')
  // a link scanner, or anyone, fetching anything with the token: nothing completes
  const tok = l?.token ?? ''
  for (const path of ['/setup', `/setup?t=${tok}`, `/v1/roster/setup?email=${uma}&token=${tok}`, `/v1/roster/setup/start?email=${uma}`]) {
    const g = await seen(`GET ${path}`, api('GET', path))
    ok(g.status === 404, `GET ${path.replace(tok, '<token>')} on the directory → 404`)
  }
  ok((await head(uma)).status === 404, 'nothing was set up by fetching')
  const U1 = await Authn.make()
  ok((await setup(uma, U1, { token: tok })).status === 200, 'control: the mailed token, with a passkey made on the sign-in host, sets up')
  // X35: an address that is set up gets no setup link (the reset is its own change)
  const n1 = mailbox.length
  const again = await seen('setup-start', api('POST', '/v1/roster/setup/start', { email: uma }))
  ok(again.status === 202 && again.j.ok === true && !mailbox.slice(n1).some((x) => x.kind === 'setup'), 'setup start on a set-up address: 202 and no link')
  ok((await api('POST', '/v1/roster/setup/start', { email: 'not an address' })).status === 400, 'a malformed address → 400')

  // the link format both sides read (links.js is the contract with the sign-in host)
  const good = setupLink(uma, tok)
  ok(JSON.stringify(parseSetupLink(good)) === JSON.stringify({ address: uma, token: tok }), 'control: setupLink and parseSetupLink round-trip')
  const bad: [string, string][] = [
    ['another origin', good.replace(SIGNIN_ORIGIN, 'https://id.bento.page')],
    ['another path', good.replace('/setup#', '/setupx#')],
    ['a query', good.replace('#', '?x=1#')],
    ['the token in the query', `${SIGNIN_ORIGIN}/setup?t=${tok}#v=1&e=${encodeURIComponent(uma)}`],
    ['an extra key', good + '&x=1'],
    ['a repeated key', good + '&t=' + tok],
    ['version 2', good.replace('v=1', 'v=2')],
    ['a short token', good.replace(tok, tok.slice(1))],
    ['no address', good.replace(/e=[^&]*&/, '')],
  ]
  for (const [what, x] of bad) ok(parseSetupLink(x) === null, `a link with ${what} is refused`)
  const awkward = 'a.b+tag@example.com'
  ok(parseSetupLink(setupLink(awkward, tok))?.address === awkward, 'an address with + and . survives the fragment')
}

// =====================================================================
// 10f. S1: the budget never leaves an address refused with no live link,
//      and S1′: a stranger who keeps asking costs the owner at most ~4 a day
// =====================================================================
{
  /** A stranger asks for a setup link every `every` ms for `days`: when each link was mailed, and the moments with no live one. */
  const stranger = async (to: string, every: number, days: number) => {
    const sent: number[] = []
    let gaps = 0
    for (let i = 0; i < days * DAY / every; i++) {
      now += every
      const n = mailbox.length
      await api('POST', '/v1/roster/setup/start', { email: to })
      if (mailbox.slice(n).some((x) => x.to === to && x.kind === 'setup')) sent.push(now)
      const live = (((await rosterObj(to)).store.get('setupTok') as { exp: number; mailed: boolean }[] | undefined) ?? []).filter((t) => t.exp > now && t.mailed)
      if (!live.length) gaps++
    }
    // the most links mailed in any 24 hours
    const worst = Math.max(0, ...sent.map((t) => sent.filter((u) => u >= t && u < t + DAY).length))
    return { sent, gaps, worst }
  }
  const CAP = ROSTER_LIMITS.mailPerDay + 1 // the day's budget, plus one link beyond it
  now += HOUR
  const vic = 'vic@example.com'
  const v = await stranger(vic, 10 * MIN, 31)
  ok(v.gaps === 0, `31 days of stranger starts every 10 minutes: never a moment without a live mailed link (${v.gaps} gaps)`)
  ok(v.worst <= CAP, `S1′: at most ${CAP} setup mails in any 24 hours (most: ${v.worst})`)
  ok(v.sent.length <= 31 + ROSTER_LIMITS.mailPerMonth + 1 && v.sent.length >= 31, `S1′: over 31 days, the month's budget plus one link a day beyond it (${v.sent.length} mails)`)
  // the owner's latest link works at the end of it
  const vt = (() => {
    const last = [...mailbox].reverse().find((x) => x.to === vic && x.kind === 'setup')
    return parseSetupLink(last?.body.match(/https?:\/\/\S+/)?.[0] ?? '')?.token ?? null
  })()
  ok(!!vt && (await setup(vic, await Authn.make(), { token: vt })).status === 200, 'control: the latest mailed link still sets up')
  // a stranger once a MINUTE (the cooldown) for 3 days: the same cap, still no gap
  now += HOUR
  const fay = await stranger('flo@example.com', MIN, 3)
  ok(fay.gaps === 0 && fay.worst <= CAP, `a stranger once a minute for 3 days: ${fay.gaps} gaps, at most ${fay.worst} mails in any 24 hours (cap ${CAP})`)
  ok(fay.sent.length >= 3 && fay.sent.length <= 3 * CAP, `and ${fay.sent.length} mails in 3 days`)

  // the link lives, pinned (Y35): 20 minutes inside the budget, 24 hours beyond it
  ok(ROSTER_LIMITS.setupTtlMs === 20 * MIN && ROSTER_LIMITS.setupBeyondTtlMs === 24 * HOUR, `link lives: ${ROSTER_LIMITS.setupTtlMs / MIN} minutes inside the budget, ${ROSTER_LIMITS.setupBeyondTtlMs / HOUR} hours beyond it`)
  const mailedLink = async (to: string) => {
    const n = mailbox.length
    const t = await setupToken(to)
    return { t, m: mailbox.slice(n).find((x) => x.to === to && x.kind === 'setup') ?? NOMAIL }
  }
  {
    now += HOUR
    const a1 = await mailedLink('yan@example.com')
    ok(!!a1.t && a1.m.body.includes(`until ${when(now + 20 * MIN)}.`), 'a link inside the budget says it works for 20 minutes')
    now += 20 * MIN
    const r = await setup('yan@example.com', await Authn.make(), { token: a1.t! })
    ok(r.status === 400 && r.j.error === 'token', `and is refused at 20 minutes (${r.status} ${r.j.error})`)
    const a2 = await mailedLink('yan@example.com')
    now += 20 * MIN - 1000
    ok((await setup('yan@example.com', await Authn.make(), { token: a2.t! })).status === 200, 'control: a second link, a second short of its 20 minutes, sets up')
  }
  /** fill the day's budget with links, let them run out, then ask once more: that link goes beyond the budget */
  const beyond = async (to: string) => {
    for (let i = 0; i < ROSTER_LIMITS.mailPerDay; i++) { await setupToken(to); now += 2 * MIN }
    now += ROSTER_LIMITS.setupTtlMs
    return mailedLink(to)
  }
  {
    now += HOUR
    const b1 = await beyond('zed@example.com')
    ok(!!b1.t && b1.m.body.includes(`until ${when(now + 24 * HOUR)}.`), 'a link beyond the budget says it works for 24 hours')
    now += HOUR
    ok(!(await setupToken('zed@example.com')), 'while it is live, the budget holds the next one back')
    now += 23 * HOUR - 1000
    ok((await setup('zed@example.com', await Authn.make(), { token: b1.t! })).status === 200, 'it still sets up a second short of 24 hours')
    now += HOUR
    const b2 = await beyond('zoe@example.com')
    now += 24 * HOUR
    const r = await setup('zoe@example.com', await Authn.make(), { token: b2.t! })
    ok(r.status === 400 && r.j.error === 'token', `and a link beyond the budget is refused at 24 hours (${r.status} ${r.j.error})`)
  }

  // Y16: setup/start answers the same bytes, whatever happened
  {
    now += HOUR
    const ans: [string, { status: number; text: string; h: Headers }][] = []
    const start = async (what: string, email: string, ip?: string) => {
      const r = await api('POST', '/v1/roster/setup/start', { email }, { ip })
      ans.push([what, r])
    }
    await start('mailed', 'ana@example.com')
    await start('held back by the cooldown', 'ana@example.com')
    for (let i = 0; i < ROSTER_LIMITS.mailPerDay; i++) { now += 2 * MIN; await start('inside the budget', 'ben@example.com') }
    await start('held back by a full budget', 'ben@example.com')
    now += ROSTER_LIMITS.setupTtlMs
    await start('mailed beyond the budget', 'ben@example.com')
    await start('for a set-up address', alice)
    mailDown = true
    await start('with the mailer down', 'cal@example.com')
    mailDown = false
    const ip = freshIp()
    for (let i = 0; i < LIMITS.ip.setup; i++) await api('POST', '/v1/roster/setup/start', { email: `y16-${i}@example.com` }, { ip })
    await start('past the per-IP limit', 'dee@example.com', ip)
    const sig = (r: { status: number; text: string; h: Headers }) => `${r.status} ${r.text} ${[...r.h.entries()].map(([k, x]) => `${k}=${x}`).sort().join('|')}`
    const first = sig(ans[0][1])
    const odd = ans.filter(([, r]) => sig(r) !== first).map(([w]) => w)
    ok(ans.length === 10 && ans[0][1].status === 202 && odd.length === 0, `setup/start: status, body and headers byte-identical across ${ans.length} states (differs: ${odd.join(', ') || 'none'})`)
    ok(ans[0][1].text === '{"ok":true}', `and the body is exactly {"ok":true} (${ans[0][1].text})`)
  }

  // a link that never went out never holds the next one back
  const wil = 'wil@example.com'
  mailDown = true
  const n2 = mailbox.length
  await api('POST', '/v1/roster/setup/start', { email: wil })
  mailDown = false
  ok(mailbox.length === n2 && !((((await rosterObj(wil)).store.get('setupTok') as unknown[] | undefined) ?? []).length), 'mailer down: no link mailed, and its token withdrawn')
  ok(!!(await setupToken(wil)), 'a start straight after (inside the cooldown) is mailed: the unsent link holds nothing back')

  // a link whose object stopped mid-send (never confirmed mailed) holds nothing back either
  const xan = 'xan@example.com'
  for (let i = 0; i < ROSTER_LIMITS.mailPerDay; i++) { await setupToken(xan); now += 2 * MIN }
  now += ROSTER_LIMITS.setupTtlMs // every mailed link has run out; the day's budget is still full
  // S1″: a young unconfirmed link may still be on its way, so it holds the next one back; once older than the mailer could take, it holds nothing
  ok(ROSTER_LIMITS.setupInFlightMs === MAIL_TIMEOUT_MS + 5000, `a link counts as in flight for the mailer's timeout plus 5 s (${ROSTER_LIMITS.setupInFlightMs} ms)`)
  await plant(xan, (st) => st.set('setupTok', [{ h: 'unsent', exp: now + ROSTER_LIMITS.setupTtlMs, at: now - ROSTER_LIMITS.setupInFlightMs + 1000, mailed: false }]))
  ok(!(await setupToken(xan)), 'budget full, an unconfirmed link a second inside its flight window: held back (it may still arrive)')
  await plant(xan, (st) => st.set('setupTok', [{ h: 'unsent', exp: now + ROSTER_LIMITS.setupTtlMs, at: now - ROSTER_LIMITS.setupInFlightMs, mailed: false }]))
  ok(!!(await setupToken(xan)), 'budget full, only an unconfirmed link past its flight window live: a link is still mailed')
  ok(!(await setupToken(xan)), 'control: straight after, with that mailed link live, the budget holds the next one back')

  // the per-IP limit on the route
  const ip = freshIp()
  const n3 = mailbox.length
  const st = new Set<number>()
  for (let i = 0; i <= LIMITS.ip.setup; i++) st.add((await api('POST', '/v1/roster/setup/start', { email: `ip${i}@example.org` }, { ip })).status)
  ok(st.size === 1 && st.has(202), `setup start answers 202 even past the per-IP limit (${[...st]})`)
  ok(mailbox.length - n3 === LIMITS.ip.setup, `but only ${LIMITS.ip.setup} links go out from one IP in an hour (${mailbox.length - n3})`)
}

// =====================================================================
// 10f′. S1″: starts that arrive while a link's mail is still going out
// =====================================================================
{
  // a slow mailer: every send waits until the burst is released, as on a real
  // object where other requests run while the mail goes out
  let gate!: () => void
  const slow = () => { const g = new Promise<void>((r) => { gate = r }); mailHook = async (m) => { await g; mailbox.push(m) }; return () => { mailHook = null; gate() } }
  const burst = async (to: string, n: number, ip?: () => string) => {
    const before = mailbox.length
    const release = slow()
    const all = Array.from({ length: n }, () => api('POST', '/v1/roster/setup/start', { email: to }, { ip: ip?.() }))
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)) // let every start reach the object
    release()
    const rs = await Promise.all(all)
    return { mails: mailbox.slice(before).filter((x) => x.to === to && x.kind === 'setup').length, rs }
  }
  now += HOUR
  const b1 = await burst('bea@example.com', 10)
  ok(b1.mails === 1 && b1.rs.every((r) => r.status === 202 && r.text === '{"ok":true}'), `10 starts at once, budget open, slow mailer: 1 mail (${b1.mails}), all answered 202 alike`)
  // budget full and the links run out: the burst lands on the beyond-budget path, which mails a day-long link
  const cyd = 'cyd@example.com'
  for (let i = 0; i < ROSTER_LIMITS.mailPerDay; i++) { await setupToken(cyd); now += 2 * MIN }
  now += ROSTER_LIMITS.setupTtlMs
  const b2 = await burst(cyd, 10)
  ok(b2.mails === 1, `10 starts at once beyond the budget: 1 day-long link, not 10 (${b2.mails})`)
  const live = (((await rosterObj(cyd)).store.get('setupTok') as { mailed: boolean; exp: number }[] | undefined) ?? []).filter((t) => t.exp > now)
  ok(live.length === 1 && live[0].mailed && live[0].exp === now + ROSTER_LIMITS.setupBeyondTtlMs, `and exactly one live token, mailed, for 24 hours (${live.length})`)
  now += MIN
  const b3 = await burst(cyd, 30)
  ok(b3.mails === 0, `a second burst while that link is live: no mail (${b3.mails})`)
  const dax = 'dax@example.com'
  for (let i = 0; i < ROSTER_LIMITS.mailPerDay; i++) { await setupToken(dax); now += 2 * MIN }
  now += ROSTER_LIMITS.setupTtlMs
  const b4 = await burst(dax, 30, () => freshIp())
  ok(b4.mails === 1, `30 starts at once from 30 IPs beyond the budget: 1 mail (${b4.mails})`)
  // control: a burst whose one send fails leaves nothing that holds, so the next start is mailed
  const eli = 'eli@example.com'
  mailDown = true
  const before = mailbox.length
  const failing = Array.from({ length: 10 }, () => api('POST', '/v1/roster/setup/start', { email: eli }))
  await Promise.all(failing)
  mailDown = false
  ok(mailbox.length === before && !((((await rosterObj(eli)).store.get('setupTok') as unknown[] | undefined) ?? []).length), 'a burst whose send fails: nothing mailed and no token left')
  ok(!!(await setupToken(eli)), 'control: the next start is mailed')
}

// =====================================================================
// 10g. S2: reset, void, freeze and roster mail never read a stranger-fillable budget
// =====================================================================
{
  ok(JSON.stringify(MAIL_KINDS) === JSON.stringify({ setup: 'budget', roster: 'never', reset: 'never', void: 'never', freeze: 'never' }),
    'the mail kinds and their budget classes are exactly as ruled (setup alone budgeted; the removal code is gone)')
  let threw = false
  try { await deliver(env, { to: 'x@example.com', subject: 's', body: 'b', kind: 'notice' }) } catch { threw = true }
  ok(threw, 'an undeclared mail kind is refused: every new kind must be classed here first')
  let sent = false
  try { await deliver(env, { to: 'x@example.com', subject: 's', body: 'b', kind: 'reset' }); sent = true } catch { /* */ }
  ok(sent, 'control: a declared kind is delivered')
  mailbox.pop()
  // where budgets are read: one function per object, called from one place each
  const src = (f: string) => readFileSync(join(root, 'server/directory/src', f), 'utf8')
  const io = /\b(?:get|put|delete)\(\s*\[?\s*'mail'/g
  const only = (file: string, fn: string, op: string, nextOp: string) => {
    const t = src(file)
    const indent = fn.match(/^ */)![0]
    const a = t.indexOf(fn), z = a < 0 ? -1 : t.indexOf(`\n${indent}}\n`, a)
    const hits = [...t.matchAll(io)].map((x) => x.index ?? 0)
    ok(a >= 0 && hits.length > 0 && hits.every((i) => i > a && i < z), `${file}: the budget is read and written only inside ${fn.trim().split('(')[0]} (${hits.length} places)`)
    const name = fn.trim().replace(/^async /, '').replace(/^const /, '').split(/[ (=]/)[0]
    const calls = [...t.matchAll(new RegExp(`\\b${name}\\(`, 'g'))].map((x) => x.index ?? 0).filter((i) => i < a || i > z)
    const o = t.indexOf(op), e = t.indexOf(nextOp, o + 1)
    ok(calls.length === 1 && calls[0] > o && calls[0] < e, `${file}: ${name} is called once, from ${op.trim()} (${calls.length} calls)`)
  }
  only('roster.js', '  async spendSetupBudget(now) {', "if (a.op === 'setupStart')", "if (a.op === 'setup')")
  for (const f of readdirSync(join(root, 'server/directory/src')).filter((x) => x !== 'roster.js'))
    ok(![...src(f).matchAll(io)].length, `${f}: reads no mail budget`)
  // every kind the sources send is declared
  const kinds = new Set(readdirSync(join(root, 'server/directory/src')).flatMap((f) => [...src(f).matchAll(/deliver\([^)]*kind: '([a-z]+)'/g)].map((x) => x[1])))
  ok([...kinds].length >= 2 && [...kinds].every((k) => Object.hasOwn(MAIL_KINDS, k)), `every mail kind the sources send is declared (${[...kinds].join(', ')})`)
}

// =====================================================================
// 10h. the sign-in host's routes (/v1/web/*): CORS to it alone, real validation
// =====================================================================
{
  const W = async (method: string, path: string, raw?: string, o: { origin?: string | null; ip?: string } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'text/plain;charset=UTF-8', 'cf-connecting-ip': o.ip ?? freshIp() }
    if (o.origin !== null) headers.origin = o.origin ?? S
    const r = await worker.fetch(new Request('https://id.bento.page' + path, { method, body: raw, headers }), env as never)
    const text = await r.text()
    responses.push({ what: `web ${method} ${path}`, status: r.status, h: r.headers, text })
    let j: Record<string, unknown> = {}
    try { j = JSON.parse(text) } catch { /* */ }
    return { status: r.status, j, h: r.headers }
  }
  ok(WEB_ROUTES.prefix === '/v1/web/' && WEB_ROUTES.challenge.startsWith(WEB_ROUTES.prefix) && WEB_ROUTES.enrol.startsWith(WEB_ROUTES.prefix), 'the web routes live under /v1/web/')
  // the Workers runtime refuses to start a main module with any other kind of export (measured on wrangler dev)
  const badExports = Object.entries(workerModule).filter(([, v]) => v === null || (typeof v !== 'function' && typeof v !== 'object'))
  ok(badExports.length === 0, `every export of worker.js is a class, a handler or an object (not: ${badExports.map(([k]) => k).join(', ') || 'none'})`)
  const pre = await W('OPTIONS', '/v1/web/enrol')
  ok(pre.status === 204 && pre.h.get('access-control-allow-origin') === SIGNIN_ORIGIN && pre.h.get('access-control-allow-methods') === 'POST, OPTIONS', 'preflight: CORS to the sign-in host only, POST')
  const ch = await W('POST', '/v1/web/challenge', '{}')
  const nonce = ch.j.nonce as string
  ok(ch.status === 200 && typeof nonce === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(nonce), `challenge → 200 { nonce } in the shape the sign-in host checks (${ch.status})`)
  ok(ch.h.get('access-control-allow-origin') === SIGNIN_ORIGIN && /Origin/.test(ch.h.get('vary') ?? ''), 'challenge: CORS to the sign-in host, Vary: Origin')
  ok((await W('POST', '/v1/web/challenge')).status === 200, 'challenge with no body → 200 (the body is not read)')
  ok(!!(await openChallenge(env.CHALLENGE_KEY as string, 'web', 'web', nonce, now)), 'the nonce is a sealed web challenge')
  ok(!(await openChallenge(env.CHALLENGE_KEY as string, 'roster', await addressKey('x@example.com'), nonce, now)), 'and is no roster challenge')
  const xs = await setup('xia@example.com', await Authn.make(), { ch: nonce })
  ok(xs.status === 400 && xs.j.error === 'nonce', 'a web nonce is refused by roster setup (nonce)')
  const A = { id: 'AAAA', userHandle: null, authenticatorData: 'AAAA', clientDataJSON: 'AAAA', signature: 'AAAA' }
  const enrol = (b: unknown, o?: { origin?: string | null }) => W('POST', '/v1/web/enrol', JSON.stringify(b), o)
  const okBody = { text: `wdev.W.kx.bA.${nonce}`, rq: 'https://home.bento.page', assertion: A }
  const e0 = await enrol(okBody)
  ok(e0.status === 501 && e0.j.error === 'not-implemented', `a well-formed enrol → 501 until the kernel defines wdev. (got ${e0.status} ${JSON.stringify(e0.j)})`)
  ok(e0.h.get('access-control-allow-origin') === SIGNIN_ORIGIN, 'enrol: CORS to the sign-in host')
  const cases: [string, unknown, string][] = [
    ['no text', { ...okBody, text: undefined }, 'text'],
    ['a text that is not wdev.', { ...okBody, text: 'ros.x' }, 'text'],
    ['an over-long text', { ...okBody, text: 'wdev.' + 'x'.repeat(3000) }, 'text'],
    ['no rq', { ...okBody, rq: undefined }, 'rq'],
    ['an empty rq', { ...okBody, rq: '' }, 'rq'],
    ['another opener', { ...okBody, rq: 'https://attacker.example' }, 'rq'],
    ['the sign-in host as its own opener', { ...okBody, rq: SIGNIN_ORIGIN }, 'rq'],
    ['no assertion', { ...okBody, assertion: undefined }, 'assertion'],
    ['an array assertion', { ...okBody, assertion: [A] }, 'assertion'],
    ['no signature', { ...okBody, assertion: { ...A, signature: undefined } }, 'assertion'],
    ['a non-base64url field', { ...okBody, assertion: { ...A, clientDataJSON: 'a+b/c=' } }, 'assertion'],
    ['an over-long field', { ...okBody, assertion: { ...A, authenticatorData: 'A'.repeat(5000) } }, 'assertion'],
    ['a numeric userHandle', { ...okBody, assertion: { ...A, userHandle: 7 } }, 'assertion'],
  ]
  for (const [what, b, err] of cases) {
    const r = await enrol(b)
    ok(r.status === 400 && r.j.error === err, `enrol with ${what} → 400 ${err} (got ${r.status} ${r.j.error})`)
  }
  ok((await W('POST', '/v1/web/enrol', 'not json')).j.error === 'bad-request', 'enrol with a body that is not JSON → 400')
  ok((await enrol({ ...okBody, assertion: { ...A, userHandle: 'AAAA' } })).status === 501, 'control: a userHandle string is accepted')
  ok((await W('POST', '/v1/web/nope', '{}')).status === 404 && (await W('GET', '/v1/web/challenge')).status === 404, 'other web paths and GET → 404')
  const ip = freshIp()
  let last = 0
  for (let i = 0; i <= LIMITS.ip.challenge; i++) last = (await W('POST', '/v1/web/challenge', '{}', { ip })).status
  ok(last === 429, `web challenge #${LIMITS.ip.challenge + 1} from one IP in an hour → 429`)
  // Y31: enrol is limited per IP too (well-formed enrols count; a malformed one is refused before the count)
  const eip = freshIp()
  const es: number[] = []
  for (let i = 0; i <= LIMITS.ip.enrol; i++) es.push((await W('POST', '/v1/web/enrol', JSON.stringify(okBody), { ip: eip })).status)
  ok(LIMITS.ip.enrol === 60 && es.slice(0, -1).every((x) => x === 501) && es[es.length - 1] === 429, `enrol #${LIMITS.ip.enrol + 1} from one IP in an hour → 429, the ${LIMITS.ip.enrol} before it 501 (last ${es[es.length - 1]})`)
  ok((await enrol(okBody)).status === 501, 'control: from another IP the same enrol answers 501')
  const webs = responses.filter((x) => x.what.startsWith('web '))
  ok(webs.length > 20 && webs.every((x) => x.h.get('access-control-allow-origin') === SIGNIN_ORIGIN), `every web answer (${webs.length}) has CORS for the sign-in host only, never *`)
  ok(responses.filter((x) => !x.what.startsWith('web ') && !x.what.includes('/v1/web/')).every((x) => x.h.get('access-control-allow-origin') === '*'), 'every other answer keeps CORS *')
  // the sign-in host's copy of the seam, when it is in this tree
  const seam = join(root, 'server/signin/public/directory-client.js')
  if (existsSync(seam)) {
    const t = readFileSync(seam, 'utf8')
    ok(t.includes("challenge: '/v1/web/challenge'") && t.includes("enrol: '/v1/web/enrol'"), 'the sign-in host\'s seam names the same two routes')
  } else console.log('note: server/signin is not in this tree; the seam cross-check runs once it is')
}

// =====================================================================
// 10b. SD2: the void (G3, G4, G4a-c) and the reset (G5)
// =====================================================================
/** The one void link in a mail, or null. */
function voidIn(m: Mail | undefined) {
  const urls = m?.body.match(/https?:\/\/\S+/g) ?? []
  const all = urls.map((u) => parseVoidLink(u)).filter(Boolean)
  return all.length === 1 && urls.filter((u) => u.includes('/void')).length === 1 ? all[0]! : null
}
async function voidPost(email: string, token: string, choice: string, o: { ip?: string } = {}) {
  return seen('void', api('POST', '/v1/void', { email, token, choice }, o))
}
const linkAt = async (email: string, seq: number) => (await rosterObj(email)).store.get(`link:${String(seq).padStart(8, '0')}`) as Record<string, unknown> | undefined
const pendOf = async (email: string) => (await rosterObj(email)).store.get('pend') as Record<string, unknown> | undefined
const ripOf = async (l: Record<string, unknown> | undefined) => verifyRip(String(l?.rip), String(l?.ripSig), { rosText: String(l?.ros), directoryKeys: DIR_KEYS, now })
/** A fresh account with two passkeys (the second ripened), ready for a staged change. */
async function twoKeys(email: string) {
  const a = await Authn.make(), b = await Authn.make()
  const su = await setup(email, a)
  const rq = await request(email, a, { add: b })
  if (su.status !== 200 || rq.status !== 202) console.log(`twoKeys(${email}): setup ${su.status} ${JSON.stringify(su.j)}, add ${rq.status} ${JSON.stringify(rq.j)}`)
  now += ROSTER_WAIT_MS
  await current(email)
  return [a, b] as const
}
async function resetToken(email: string, ip?: string) {
  const n = mailbox.length
  const r = await seen('reset-start', api('POST', '/v1/roster/reset/start', { email }, { ip }))
  const m = mailbox.slice(n).find((x) => x.to === email && x.kind === 'reset')
  const urls = m?.body.match(/https?:\/\/\S+/g) ?? []
  const l = urls.length === 1 ? parseResetLink(urls[0]) : null
  return { r, token: l && l.address === email ? l.token : null, mail: m }
}
async function reset(email: string, a: Authn, token: string, o: { ch?: string; reg?: RegOpts } = {}) {
  const ch = o.ch ?? await challenge(email)
  const reg = await a.register(b64uDec(ch) ?? new Uint8Array(32), o.reg)
  return seen('reset', api('POST', '/v1/roster/reset', { email, token, dirNonce: ch, reg }))
}
{
  // --- the void link in every waiting notice (G3) ---
  now += DAY
  const gus = 'sd2-gus@example.com'
  const [G1, G2] = await twoKeys(gus)
  const G3 = await Authn.make()
  mailbox.length = 0
  const q1 = await request(gus, G1, { add: G3 })
  ok(q1.status === 202, `gus: G1 asks to add G3 (got ${q1.status} ${JSON.stringify(q1.j)})`)
  const wm = lastMail(gus)
  const vl = voidIn(wm)
  ok(vl !== null && vl.address === gus && b64uDec(vl.token)?.length === 32 && vl.kind === 'c',
    `the waiting notice carries one void link on the directory, a 256-bit token in the fragment, both buttons (got ${vl ? vl.kind : 'none'})`)
  ok(!!wm && wm.body.includes(`${DIRECTORY_ORIGIN}/void#`) && !/\/void\?/.test(wm.body), 'the void link is on id.bento.page/void and carries its token in the fragment only')
  ok(!!wm && wm.body.includes('your passkey was used for something you did not intend. Choose Cancel: it is always safe.') && wm.body.includes('Choose Remove only if you do not recognise the passkey that asked (named above)') && !wm.body.includes('usual cause'),
    'the waiting notice says which button to pick, and never calls an unasked change benign (G4c, C6)')
  ok(!!wm && wm.body.includes(`asked for by the passkey ${await fingerprint(G1.pub)}, added`), 'the waiting notice names the passkey that asked, with its age')
  ok(!JSON.stringify([...(await rosterObj(gus)).store.values()]).includes(vl?.token ?? 'x'), 'the void token itself is never stored (only its hash)')
  // R1-burn: wrong guesses from twelve addresses, malformed ones too, spend nothing
  for (let i = 0; i < 12; i++) {
    const r = await voidPost(gus, b64uEnc(crypto.getRandomValues(new Uint8Array(32))), 'cancel')
    ok(r.status === 400 && r.j.error === 'invalid', `stranger void guess ${i + 1}: refused (invalid)`)
  }
  ok((await voidPost(gus, 'short', 'cancel')).status === 400 && (await voidPost(gus, (vl?.token ?? ''), 'burn')).status === 400, 'a malformed token or choice: refused')
  ok((await pendOf(gus))?.voidTok !== undefined, 'after twelve wrong guesses the change and its token still wait')
  // a choice the link does not offer is refused WITHOUT spending the token
  const undoOnChange = await voidPost(gus, (vl?.token ?? ''), 'undo')
  ok(undoOnChange.status === 400 && undoOnChange.j.error === 'choice', 'undo on a change\'s link: refused (choice)')
  // per-IP limit: the 61st void from one address is refused; the real token still works from another
  const vip = freshIp()
  const vs: number[] = []
  for (let i = 0; i <= LIMITS.ip.void; i++) vs.push((await voidPost(gus, b64uEnc(crypto.getRandomValues(new Uint8Array(32))), 'cancel', { ip: vip })).status)
  ok(LIMITS.ip.void === 60 && vs.slice(0, -1).every((x) => x === 400) && vs[vs.length - 1] === 429, `void #${LIMITS.ip.void + 1} from one IP in an hour → 429 (last ${vs[vs.length - 1]})`)

  // --- Cancel (G4b) ---
  mailDown = true // a cancel never waits on the mailer
  const c = await voidPost(gus, (vl?.token ?? ''), 'cancel')
  mailDown = false
  ok(c.status === 200 && c.j.done === 'cancelled' && c.j.until === now + 72 * HOUR, `Cancel with the real token after 12 wrong guesses and the mailer down: 200, cooldown until +72 h (got ${c.status} ${JSON.stringify(c.j)})`)
  const after = await current(gus)
  ok(after.pending === null && after.head?.seq === 1 && !after.head?.members.some((m) => m.pub === G3.pub), 'the change is gone and the head is unchanged')
  const usedAgain = await voidPost(gus, (vl?.token ?? ''), 'cancel')
  ok(usedAgain.status === 409 && usedAgain.j.error === 'used' && usedAgain.j.at === now, `the same link again: refused, and it says it was used, when (F2) (got ${usedAgain.status} ${JSON.stringify(usedAgain.j)})`)
  const G4 = await Authn.make()
  const cool = await request(gus, G1, { add: G4 })
  ok(cool.status === 403 && cool.j.error === 'cooldown', `the passkey that asked cannot ask again (cooldown) (got ${cool.status} ${cool.j.error})`)
  ok((await request(gus, G1, { remove: G1.pub })).j.error === 'cooldown', 'not even to remove itself')
  now += 71 * HOUR
  ok((await request(gus, G1, { add: G4 })).j.error === 'cooldown', 'still refused at +71 h')
  now += HOUR
  const free = await request(gus, G1, { add: G4 })
  ok(free.status === 202, `at +72 h it may ask again (got ${free.status} ${free.j.error})`)
  const cm = mailsTo(gus).find((m) => m.kind === 'void')
  ok(!cm, 'with the mailer down the cancel notice was lost, and the cancel stood anyway')
  // another member is not held back by G1's cooldown
  const fv = voidIn(lastMail(gus))
  ok((await voidPost(gus, (fv?.token ?? ''), 'cancel')).status === 200, 'cancel that one too')
  const g2asks = await request(gus, G2, { add: G4 })
  ok(g2asks.status === 202, 'another member may ask while the first is cooling down')
  const cm2 = mailsTo(gus).filter((m) => m.kind === 'void').pop()
  ok(!!cm2 && /cancelled/.test(cm2.subject) && cm2.body.includes(await fingerprint(G1.pub)) && cm2.body.includes(await fingerprint(G2.pub)) && cm2.body.includes('cannot ask for another change to this account until'),
    'the cancel notice names the passkey that asked, its cooldown, and the whole roster')
  // a void after the change took effect: refused
  const late = voidIn(lastMail(gus))
  now += ROSTER_WAIT_MS
  const lv = await voidPost(gus, (late?.token ?? ''), 'cancel')
  ok(lv.status === 409 && lv.j.error === 'late' && lv.j.at === now && (await current(gus)).head?.members.some((m) => m.pub === G4.pub), `a void after the change took effect: refused as too late, with when; the change stands (F2) (got ${lv.status} ${JSON.stringify(lv.j)})`)
}
{
  // --- Remove: suspend (q) at once, removal (x) queued, undo (u) from its own mail (G4, G4a) ---
  now += DAY
  const hal = 'sd2-hal@example.com'
  const [H1, H2] = await twoKeys(hal)
  const HA = await Authn.make()
  mailbox.length = 0
  const asked = await request(hal, H2, { add: HA })
  const vl = voidIn(lastMail(hal))
  ok(asked.status === 202 && vl?.kind === 'c', 'hal: H2 asks to add HA; its link offers Remove')
  const before = await current(hal)
  // the removal's notice carries the way back, so with no mailer nothing changes
  mailDown = true
  const down = await voidPost(hal, (vl?.token ?? ''), 'remove')
  mailDown = false
  const still = await current(hal)
  ok(down.status === 503 && still.head?.seq === before.head?.seq && (await pendOf(hal))?.kind === 'member', 'Remove with the mailer down: 503, nothing changed, the change still waits')
  const t0 = now
  const rm = await voidPost(hal, (vl?.token ?? ''), 'remove')
  ok(rm.status === 200 && rm.j.done === 'suspended' && rm.j.removesAt === t0 + ROSTER_WAIT_MS, `Remove, retried: 200, removal at +72 h (got ${rm.status} ${JSON.stringify(rm.j)})`)
  const qh = await current(hal)
  const h2 = qh.head?.members.find((m) => m.pub === H2.pub)
  ok(qh.head?.seq === (before.head?.seq ?? 0) + 1 && h2?.quarantined === true && !qh.head?.members.some((m) => m.pub === HA.pub) && qh.head?.members.find((m) => m.pub === H1.pub)?.quarantined === false,
    'at once: the head marks H2 ~q, HA was never added, H1 is untouched')
  const ql = await linkAt(hal, (qh.head?.seq ?? -9))
  const qr = await ripOf(ql)
  ok(qr.ok && qr.value.auth === 'q' && qr.value.cause === await sha256b64u(asked.ros) && qr.value.requestedAt === t0 && qr.value.ripenedAt === t0,
    `the suspension's rip. is word q, cause = the voided request's hash, immediate (got ${qr.ok ? `${qr.value.auth}` : qr.reason})`)
  const vd = ql?.voided as Record<string, unknown> | undefined
  ok(vd?.ros === asked.ros && vd?.signer === H2.pub && !!vd?.assertion, 'the q link carries the voided request with its signer and assertion')
  const chq = await chainOf(hal)
  ok(chq.ok && chq.value.members.find((m) => m.pub === H2.pub)?.quarantined === true, `the kernel accepts the chain with the q link (${chq.ok ? 'ok' : chq.reason})`)
  const xp = await pendOf(hal)
  ok(xp?.kind === 'removal' && xp?.ripensAt === t0 + ROSTER_WAIT_MS && xp?.requestedAt === t0 && (await current(hal)).pending?.kind === 'removal', 'the removal of H2 is queued in the same step, requested at the suspension\'s time')
  // the suspended passkey can ask for nothing; nobody can ask while the removal waits
  const qa = await request(hal, H2, { remove: H1.pub })
  ok(qa.status === 409 && qa.j.error === 'pending', 'the suspended passkey cannot ask while its removal waits (pending; section 8 shows a ~q member refused as quarantined)')
  ok((await request(hal, H1, { add: await Authn.make() })).j.error === 'pending', 'while the removal waits, another change is refused (pending)')
  ok((await voidPost(hal, (vl?.token ?? ''), 'cancel')).j.error === 'used', 'the change\'s link is spent (used): its suspended requester holds no way to stop its own removal')
  const sm = mailsTo(hal).filter((m) => m.kind === 'void').pop()
  const ul = voidIn(sm)
  ok(!!sm && /suspended/.test(sm.subject) && ul?.kind === 'u' && sm.body.includes(await fingerprint(H2.pub)) && sm.body.includes(`removed from this account at ${when(t0 + ROSTER_WAIT_MS)}`),
    'the removal\'s own notice names the passkey, when it goes, and carries an undo link (G4a)')
  ok(!!sm && !sm.body.includes(await fingerprint(HA.pub)), 'and lists the roster once it is removed (no HA)')
  // the undo link offers undo only
  ok((await voidPost(hal, (ul?.token ?? ''), 'cancel')).j.error === 'choice' && (await voidPost(hal, (ul?.token ?? ''), 'remove')).j.error === 'choice', 'the undo link refuses cancel and remove (choice)')
  // G4a: undo
  now += 5 * HOUR
  const t1 = now
  const un = await voidPost(hal, (ul?.token ?? ''), 'undo')
  ok(un.status === 200 && un.j.done === 'restored', 'undo: 200')
  const uh = await current(hal)
  ok(uh.pending === null && uh.head?.members.find((m) => m.pub === H2.pub)?.quarantined === false && uh.head?.seq === (qh.head?.seq ?? -9) + 1, 'H2 is back, unmarked, and its removal is gone')
  const urip = await ripOf(await linkAt(hal, (uh.head?.seq ?? -9)))
  ok(urip.ok && urip.value.auth === 'u' && urip.value.cause === await sha256b64u(qh.text) && urip.value.ripenedAt === t1, `the undo's rip. is word u, cause = the q head's hash (got ${urip.ok ? urip.value.auth : urip.reason})`)
  const chu = await chainOf(hal)
  ok(chu.ok && chu.value.members.every((m) => !m.quarantined), `the kernel accepts the chain through q and u (${chu.ok ? 'ok' : chu.reason})`)
  ok((await voidPost(hal, (ul?.token ?? ''), 'undo')).j.error === 'used', 'the undo link works once (used)')
  ok((await request(hal, H2, { add: HA })).status === 202, 'H2 may ask again at once (Remove sets no cooldown; undo restores it fully)')
  ok((lastMail(hal)?.subject ?? '') !== '' && mailsTo(hal).some((m) => m.kind === 'void' && /put back/.test(m.subject)), 'the undo is mailed')

  // the removal ripens if nobody undoes it (x)
  const yl = voidIn(lastMail(hal))
  const t2 = now
  ok((await voidPost(hal, (yl?.token ?? ''), 'remove')).status === 200, 'H2 asks again; Remove this time')
  const q2 = await current(hal)
  now = t2 + ROSTER_WAIT_MS - 1000
  ok((await current(hal)).head?.members.some((m) => m.pub === H2.pub), 'a second before 72 h, H2 is still on the roster (suspended)')
  now = t2 + ROSTER_WAIT_MS
  await fire(await rosterObj(hal))
  const xh = await current(hal)
  ok(!xh.head?.members.some((m) => m.pub === H2.pub) && xh.pending === null && xh.head?.seq === (q2.head?.seq ?? -9) + 1, 'at 72 h the alarm removes H2')
  const xr = await ripOf(await linkAt(hal, (xh.head?.seq ?? -9)))
  ok(xr.ok && xr.value.auth === 'x' && xr.value.cause === await sha256b64u(q2.text) && xr.value.requestedAt === t2 && xr.value.ripenedAt === t2 + ROSTER_WAIT_MS,
    `the removal's rip. is word x, cause = the q head, requested at the suspension (got ${xr.ok ? `${xr.value.auth} ${xr.value.requestedAt - t2}` : xr.reason})`)
  const chx = await chainOf(hal)
  ok(chx.ok && chx.value.members.length === 1 && chx.value.members[0]?.pub === H1.pub, `the kernel accepts the chain through q and x (${chx.ok ? 'ok' : chx.reason})`)
  ok(!(await rosterObj(hal)).store.has(`pk:${H2.pub}`), 'H2\'s credential record is gone')
}
{
  // --- Remove hidden when the requester is the only live member (G4c) ---
  now += DAY
  const ida = 'sd2-ida@example.com', I1 = await Authn.make(), I2 = await Authn.make()
  await setup(ida, I1)
  mailbox.length = 0
  await request(ida, I1, { add: I2 })
  const wm = lastMail(ida)
  const vl = voidIn(wm)
  ok(vl?.kind === 'o' && !!wm && wm.body.includes('one choice, Cancel') && !wm.body.includes('Choose Remove'), `with one passkey, the link offers Cancel only (got ${vl?.kind})`)
  ok(!!wm && wm.body.includes('would leave the account with no usable passkey (only a reset gets back in)') && !wm.body.includes('lock you out'), 'and says what removing it would do in words true for whoever holds it (C6)')
  // an edited link (k=c) shows the button; the directory refuses it, and the token survives
  const forced = await voidPost(ida, (vl?.token ?? ''), 'remove')
  ok(forced.status === 400 && forced.j.error === 'choice' && (await current(ida)).head?.members[0]?.quarantined === false, 'Remove on that token: refused (choice); nothing suspended')
  ok((await voidPost(ida, (vl?.token ?? ''), 'cancel')).status === 200, 'its Cancel still works')
}
{
  // --- the reset: start (S1, S2) ---
  now += DAY
  const jo = 'sd2-jo@example.com', J1 = await Authn.make(), J2 = await Authn.make()
  const nobody = 'nobody-reset@example.com'
  mailbox.length = 0
  const n0 = await resetToken(nobody)
  ok(n0.r.status === 202 && n0.token === null && mailsTo(nobody).length === 0, 'reset/start for an address with no account: 202, nothing mailed')
  await setup(jo, J1)
  const setAt = now
  // S2: the stranger-fillable setup budget is full; the reset mail goes anyway
  await plant(jo, (st) => st.set('mail', Array.from({ length: ROSTER_LIMITS.mailPerMonth }, (_, i) => now - i * 1000)))
  const r1 = await resetToken(jo)
  ok(r1.r.status === 202 && r1.r.text === n0.r.text, 'reset/start answers the same bytes for an account as for none')
  ok(r1.token !== null && b64uDec(r1.token ?? '')?.length === 32 && r1.mail?.kind === 'reset', 'with the setup budget full, the reset link still goes, a 256-bit token, mail kind reset (S2)')
  ok(!!r1.mail && r1.mail.body.includes(`${SIGNIN_ORIGIN}${SIGNIN_PATHS.reset}#`) && r1.mail.body.includes(`until ${when(now + ROSTER_LIMITS.resetTtlMs)}`), 'the link opens on the sign-in host\'s /reset, with its expiry')
  // S1: while that link is live, a stranger's starts mail nothing more
  for (let i = 0; i < 5; i++) await resetToken(jo)
  ok(mailsTo(jo).filter((m) => m.kind === 'reset').length === 1, 'five more starts while the link lives: no more mail')
  // S1″: a link still being mailed holds the next back too
  const kim = 'sd2-kim@example.com'
  await setup(kim, await Authn.make())
  const h = hangNext()
  const p1 = api('POST', '/v1/roster/reset/start', { email: kim })
  ok(await reached(h), 'the first reset start is in its send')
  await api('POST', '/v1/roster/reset/start', { email: kim })
  h.release(true)
  await p1
  ok(mailsTo(kim).filter((m) => m.kind === 'reset').length === 1, 'a start during that send mails nothing (one link per burst)')
  now += ROSTER_LIMITS.resetTtlMs + 1000
  const r2 = await resetToken(jo)
  ok(r2.token !== null, 'once the link has expired, a start mails a new one')
  ok((await reset(jo, J2, (r1.token ?? ''))).j.error === 'token', 'the expired link no longer completes')

  // --- the reset: complete, preempt, notices ---
  const J3 = await Authn.make()
  const preAt = now
  await request(jo, J1, { add: J3 })
  const prev = voidIn(lastMail(jo))
  ok((await current(jo)).pending?.kind === 'member', 'a member change waits on jo')
  for (let i = 0; i < 6; i++) ok((await reset(jo, J2, b64uEnc(crypto.getRandomValues(new Uint8Array(32))))).j.error === 'token', `stranger reset guess ${i + 1}: refused (token)`)
  ok((await reset(jo, J2, (r2.token ?? ''), { reg: { origin: 'https://home.bento.page' } })).j.error === 'origin', 'a reset registration from home.bento.page: refused (origin)')
  mailDown = true
  const rdown = await reset(jo, J2, (r2.token ?? ''))
  mailDown = false
  ok(rdown.status === 503 && (await current(jo)).pending?.kind === 'member', 'reset with the mailer down: 503, nothing queued, the member change still waits (D1)')
  const ra = now
  mailbox.length = 0
  const rs = await reset(jo, J2, (r2.token ?? ''))
  ok(rs.status === 202 && rs.j.ripensAt === ra + ROSTER_WAIT_MS, `reset with the real token after six guesses: 202, in force at +72 h (got ${rs.status} ${JSON.stringify(rs.j)})`)
  const rp = await current(jo)
  ok(rp.pending?.kind === 'reset' && rp.head?.seq === 0 && rp.head?.members[0]?.pub === J1.pub, 'the reset waits; the head is unchanged')
  const pre = await voidPost(jo, (prev?.token ?? ''), 'cancel')
  ok(pre.status === 409 && pre.j.error === 'preempted' && pre.j.at === ra, `the reset preempted the member change: its link is dead, and says a reset cancelled it (G5, F2) (got ${pre.status} ${JSON.stringify(pre.j)})`)
  const rm = lastMail(jo)
  const rvl = voidIn(rm)
  ok(!!rm && rm.kind === 'reset' && /reset/.test(rm.subject) && rvl?.kind === 'r', 'the reset notice carries a void link offering Cancel only')
  ok(!!rm && rm.body.includes(when(ra)) && rm.body.includes('from a browser') && rm.body.includes(await fingerprint(J2.pub)) && rm.body.includes(await fingerprint(J1.pub)) && rm.body.includes('A change that was waiting is cancelled by this reset.'),
    'it states the reset in words, to the second, with the host class, the new passkey and the whole roster it removes')
  ok(!!rm && rm.body.includes('less than 14 days ago') && rm.body.includes(when(setAt)), 'it says a member cannot stop it (the account is new)')
  ok((await request(jo, J1, { add: J3 })).j.error === 'pending', 'while the reset waits, a member change is refused (pending)')
  const r3 = await resetToken(jo)
  ok(r3.token === null, 'a reset under way ends every reset link')
  // the reset's void link: Cancel only, and Cancel sets no cooldown
  ok((await voidPost(jo, (rvl?.token ?? ''), 'remove')).j.error === 'choice' && (await voidPost(jo, (rvl?.token ?? ''), 'undo')).j.error === 'choice', 'the reset\'s link refuses remove and undo (choice)')
  const rc = await voidPost(jo, (rvl?.token ?? ''), 'cancel')
  ok(rc.status === 200 && rc.j.until === null && (await current(jo)).pending === null && (await current(jo)).head?.members[0]?.pub === J1.pub, 'Cancel stops the reset; nothing changed')
  const stopM = mailsTo(jo).find((m) => m.kind === 'void' && /reset/.test(m.subject) && /stopped/.test(m.subject))
  ok(!!stopM, 'the stop is mailed')
  ok(!!stopM && stopM.body.includes(`The change that was waiting when the reset was asked for, asked for at ${when(preAt)}, stays cancelled. Ask for it again if you still want it.`),
    'the stop mail says the change the reset cancelled stays cancelled (ruling 1)')
  ok(!!rm && rm.body.includes('Stopping the reset does not bring it back.') && !rm.body.includes('your passkeys stay as they are'), 'the reset notice says stopping it does not bring the cancelled change back')

  // --- the reset ripens (r) ---
  now += ROSTER_LIMITS.resetTtlMs + 1000
  const r4 = await resetToken(jo)
  const J4 = await Authn.make()
  const rb = now
  ok((await reset(jo, J4, (r4.token ?? ''))).status === 202, 'a second reset')
  ok(lastMail(jo)?.body.includes('Stopping it changes nothing else: your passkeys stay as they are.') === true, 'with nothing waiting, the reset notice says stopping it changes nothing else')
  const second = await resetToken(jo)
  ok(second.token === null, 'no reset link goes while one waits')
  now = rb + ROSTER_WAIT_MS - 1000
  ok((await current(jo)).head?.seq === 0, 'a second before 72 h the reset is not in force')
  now = rb + ROSTER_WAIT_MS
  await fire(await rosterObj(jo))
  const rh = await current(jo)
  ok(rh.head?.seq === 1 && rh.head.members.length === 1 && rh.head.members[0]?.pub === J4.pub && rh.pending === null, 'at 72 h the alarm makes the new passkey the only member')
  const rr = await ripOf(await linkAt(jo, 1))
  ok(rr.ok && rr.value.auth === 'r' && rr.value.cause === null && rr.value.requestedAt === rb && rr.value.ripenedAt === rb + ROSTER_WAIT_MS, `the reset's rip. is word r with the directory's times (got ${rr.ok ? rr.value.auth : rr.reason})`)
  const chr = await chainOf(jo)
  ok(chr.ok && chr.value.lastResetAt === rb + ROSTER_WAIT_MS && chr.value.createdAt === setAt, `the kernel accepts the chain and sees the reset (${chr.ok ? 'ok' : chr.reason})`)
  ok(!(await rosterObj(jo)).store.has(`pk:${J1.pub}`) && (await request(jo, J1, { add: J3 })).j.error === 'signer', 'the old passkey is gone and cannot ask')
  const after = await request(jo, J4, { add: J3 })
  ok(after.status === 202, 'the new passkey can')
  const done = mailsTo(jo).find((m) => /was reset/.test(m.subject))
  ok(!!done && done.body.includes(await fingerprint(J4.pub)) && !done.body.includes(`passkey ${await fingerprint(J1.pub)},`), 'the reset is mailed with the roster it leaves')
  const hd = await head(jo)
  ok(hd.j.createdAt === setAt, 'the account\'s age still counts from its setup')
}
{
  // --- G5: who may stop a reset, and "new account" ---
  now += DAY
  const kai = 'sd2-kai@example.com'
  const [K1, K2] = await twoKeys(kai)
  const setAt = Number((await head(kai)).j.createdAt ?? now) // never NaN into the clock
  ok((await head(kai)).j.newAccount === true, 'a 3-day-old account is a new account')
  const rvoid = async (who: Authn, credId?: string) => {
    const ch = await challenge(kai)
    return seen('reset-void', api('POST', '/v1/roster/reset/void', { email: kai, credId: credId ?? who.cid, assertion: {}, dirNonce: ch }))
  }
  ok((await rvoid(K1)).j.error === 'no-reset', 'no reset waiting: refused (no-reset)')
  const t = await resetToken(kai)
  const KR = await Authn.make()
  ok((await reset(kai, KR, (t.token ?? ''))).status === 202, 'a reset of a young account waits')
  const young = await rvoid(K1)
  ok(young.status === 403 && young.j.error === 'new-account', `a member cannot stop it in the first 14 days (got ${young.status} ${young.j.error})`)
  // the account turns 14 days old while the reset waits: from then a member may (the passkey's signature is the kernel's next layout)
  const rv = voidIn(lastMail(kai))
  await voidPost(kai, (rv?.token ?? ''), 'cancel')
  now = setAt + ROSTER_LIMITS.newAccountMs - 1000
  ok((await head(kai)).j.newAccount === true, 'a second short of 14 days it is still new')
  const t2 = await resetToken(kai)
  ok((await reset(kai, await Authn.make(), (t2.token ?? ''))).status === 202, 'another reset')
  ok((await rvoid(K1)).j.error === 'new-account', 'still refused a second short of 14 days')
  now = setAt + ROSTER_LIMITS.newAccountMs
  ok((await head(kai)).j.newAccount === false, 'at 14 days the account is no longer new')
  const older = await rvoid(K1)
  ok(older.status === 501 && older.j.error === 'not-implemented', `at 14 days a member gets past the age rule to the signature step (got ${older.status} ${older.j.error})`)
  ok((await rvoid(K1, 'bm90LWEtbWVtYmVy')).j.error === 'signer', 'a credential that is not a member: refused (signer)')
  await plant(kai, (st) => {
    const hd = st.get('head') as { members: Member[] } | undefined
    if (hd) st.set('head', { ...hd, members: hd.members.map((m) => (m.pub === K2.pub ? { ...m, quarantined: true } : m)) })
  })
  ok((await rvoid(K2)).j.error === 'quarantined', 'a suspended member: refused (quarantined)')
  ok((await pendOf(kai))?.kind === 'reset', 'none of those touched the waiting reset')
  ok(ROSTER_LIMITS.newAccountMs === 14 * DAY && ROSTER_LIMITS.voidCooldownMs === 72 * HOUR && ROSTER_LIMITS.resetTtlMs === DAY, 'pinned: new account 14 days, cooldown 72 h, reset link a day')
}
// ---------------------------------------------------------------------
// F1: the HOLD. A Remove or a reset holds the roster BEFORE its mail goes, so
// the mail never states an act that then fails to happen (security's P1-P8).
// ---------------------------------------------------------------------
/** Every send hangs until its own release, in arrival order, until `stop()`. */
function hangEach() {
  const calls: { m: Mail; release: (ok: boolean) => void }[] = []
  mailHook = (m) => new Promise<void>((res, rej) => {
    calls.push({ m, release: (good) => { if (good) { mailbox.push(m); res() } else rej(new Error('mailer failed late')) } })
  })
  const has = async (n: number) => { for (let i = 0; i < 200 && calls.length < n; i++) await new Promise((r) => setTimeout(r, 10)); return calls.length >= n }
  return { calls, has, stop: () => { mailHook = null } }
}
/** The waiting change's time, never NaN (a mutant that stops every change must fail rows, not poison the clock). */
const ripensOf = async (e: string) => Number((await pendOf(e))?.ripensAt ?? now + ROSTER_WAIT_MS)
const quarantinedIn = (c: Awaited<ReturnType<typeof current>>, pub: string) => c.head?.members.find((m) => m.pub === pub)?.quarantined
{
  // P1: Remove pressed 5 s before the change ripens; its mail outlasts the deadline; the alarm fires meanwhile
  now += DAY
  const e = 'sd2c-p1@example.com'
  const [, A2] = await twoKeys(e)
  const X = await Authn.make()
  await request(e, A2, { add: X })
  const v = voidIn(lastMail(e))
  const rp = await ripensOf(e)
  now = rp - 5000
  const n0 = mailbox.length
  const h = hangNext()
  const pr = voidPost(e, v?.token ?? '', 'remove')
  ok(await reached(h), 'P1: the Remove is in its send, 5 s before the change ripens')
  const hold = (await rosterObj(e)).store.get('hold') as { until: number } | undefined
  ok(!!hold && hold.until === now + ROSTER_LIMITS.holdMs && ROSTER_LIMITS.holdMs === MAIL_TIMEOUT_MS + 5000, 'P1: the roster is held before the mail goes, for the mailer\'s timeout and a margin')
  now = rp
  const o = await rosterObj(e)
  await fire(o)
  ok((await pendOf(e))?.kind === 'member' && o.alarm === hold?.until, `P1: at the deadline the alarm leaves the held change waiting, and comes back when the hold ends (got ${o.alarm === null ? 'no alarm' : `${o.alarm - now} ms on`})`)
  h.release(true)
  const r = await pr
  const c = await current(e)
  const sent = mailbox.slice(n0)
  ok(r.status === 200 && r.j.done === 'suspended', `P1: the Remove pressed before the deadline acts (got ${r.status} ${JSON.stringify(r.j)})`)
  ok(!c.head?.members.some((m) => m.pub === X.pub) && quarantinedIn(c, A2.pub) === true && c.pending?.kind === 'removal', 'P1: X was never added; A2 is suspended and its removal waits')
  ok(sent.length === 1 && /suspended/.test(sent[0]?.subject ?? ''), `P1: one mail, and what it says happened (${sent.map((m) => m.subject).join(' | ')})`)
  ok((await rosterObj(e)).store.get('hold') === undefined, 'P1: the hold is off once the Remove is done')
  ok((await voidPost(e, voidIn(sent[0])?.token ?? '', 'undo')).j.done === 'restored', 'P1: the undo link in that mail works')
  const ch = await chainOf(e)
  ok(ch.ok, `P1: the kernel accepts the chain (${ch.ok ? 'ok' : ch.reason})`)
}
{
  // P2: two Remove presses on one token (two tabs, a retry)
  now += DAY
  const e = 'sd2c-p2@example.com'
  const [, B2] = await twoKeys(e)
  await request(e, B2, { add: await Authn.make() })
  const v = voidIn(lastMail(e))
  const n0 = mailbox.length
  const h = hangNext()
  const p1 = voidPost(e, v?.token ?? '', 'remove')
  await reached(h)
  const r2 = await voidPost(e, v?.token ?? '', 'remove')
  const mid = mailbox.length
  h.release(true)
  const r1 = await p1
  const sm = mailbox.slice(n0).filter((m) => /suspended/.test(m.subject))
  ok(r2.status === 409 && r2.j.error === 'busy' && mid === n0, `P2: a second Remove while the first one's mail goes: refused (busy) before any mail (got ${r2.status} ${JSON.stringify(r2.j)})`)
  ok(r1.status === 200 && sm.length === 1, `P2: the first acts, and one 'suspended' mail goes (${sm.length})`)
  ok((await voidPost(e, voidIn(sm[0])?.token ?? '', 'undo')).j.done === 'restored', 'P2: that mail\'s undo link is the one that works')
}
{
  // P3: Cancel while a Remove's mail goes (two buttons, two tabs)
  now += DAY
  const e = 'sd2c-p3@example.com'
  const [, C2] = await twoKeys(e)
  await request(e, C2, { add: await Authn.make() })
  const v = voidIn(lastMail(e))
  const n0 = mailbox.length
  const h = hangNext()
  const p1 = voidPost(e, v?.token ?? '', 'remove')
  await reached(h)
  const rc = await voidPost(e, v?.token ?? '', 'cancel')
  h.release(true)
  const r1 = await p1
  const c = await current(e)
  const subj = mailbox.slice(n0).map((m) => m.subject)
  ok(rc.status === 409 && rc.j.error === 'busy', `P3: Cancel while the Remove's mail goes: refused (busy) (got ${rc.status} ${JSON.stringify(rc.j)})`)
  ok(r1.status === 200 && quarantinedIn(c, C2.pub) === true && subj.length === 1 && /suspended/.test(subj[0] ?? ''), `P3: the Remove stands, and its mail is the only one (${subj.join(' | ')})`)
  ok((await voidPost(e, v?.token ?? '', 'cancel')).j.error === 'used', 'P3: Cancel pressed again: the link says it was used')
}
{
  // a member's request while a reset's mail goes, with nothing else waiting
  now += DAY
  const e = 'sd2c-mq@example.com'
  const [M1] = await twoKeys(e)
  const t = await resetToken(e)
  const h = hangNext()
  const pr = reset(e, await Authn.make(), t.token ?? '')
  ok(await reached(h), 'a reset is in its send, with nothing else waiting')
  const n0 = mailbox.length
  const q = await request(e, M1, { add: await Authn.make() })
  ok(q.status === 409 && q.j.error === 'pending' && mailbox.length === n0, `a member asks meanwhile: refused (pending), no mail (got ${q.status} ${JSON.stringify(q.j)})`)
  h.release(true)
  ok((await pr).status === 202 && (await pendOf(e))?.kind === 'reset', 'the reset is queued')
}
{
  // P7: a reset completed 5 s before a member change ripens; the change would ripen during the reset's notice
  now += DAY
  const e = 'sd2c-p7@example.com'
  const [F1] = await twoKeys(e)
  const X = await Authn.make()
  await request(e, F1, { add: X })
  const mv = voidIn(lastMail(e))
  const rp = await ripensOf(e)
  now = rp - 5000
  const t = await resetToken(e)
  const n0 = mailbox.length
  const h = hangNext()
  const pr = reset(e, await Authn.make(), t.token ?? '')
  ok(await reached(h), 'P7: the reset is in its send, 5 s before the member change ripens')
  now = rp
  await fire(await rosterObj(e))
  ok((await pendOf(e))?.kind === 'member', 'P7: at the deadline the held change does not take effect')
  h.release(true)
  const r = await pr
  const c = await current(e)
  const sent = mailbox.slice(n0)
  ok(r.status === 202 && c.pending?.kind === 'reset' && !c.head?.members.some((m) => m.pub === X.pub), `P7: the reset is queued, and the change it cancelled never took effect (got ${r.status} ${JSON.stringify(r.j).slice(0, 60)})`)
  ok(sent.length === 1 && /reset/.test(sent[0]?.subject ?? '') && (sent[0]?.body ?? '').includes('A change that was waiting is cancelled by this reset.'), `P7: one mail, and it is true (${sent.map((m) => m.subject).join(' | ')})`)
  const pv = await voidPost(e, mv?.token ?? '', 'cancel')
  ok(pv.status === 409 && pv.j.error === 'preempted', `P7: the cancelled change's link says a reset cancelled it (got ${pv.status} ${JSON.stringify(pv.j)})`)
  ok((await chainOf(e)).ok, 'P7: the kernel accepts the chain')
}
{
  // P8: two reset completions with one link at once (two browsers)
  now += DAY
  const e = 'sd2c-p8@example.com'
  await twoKeys(e)
  const t = await resetToken(e)
  const n0 = mailbox.length
  const h = hangNext()
  const K1 = await Authn.make(), K2 = await Authn.make()
  const p1 = reset(e, K1, t.token ?? '')
  await reached(h)
  const r2 = await reset(e, K2, t.token ?? '')
  h.release(true)
  const r1 = await p1
  const waiting = mailbox.slice(n0).filter((m) => /waiting/.test(m.subject))
  ok(r2.status === 409 && r2.j.error === 'busy', `P8: a second completion while the first one's mail goes: refused (busy) (got ${r2.status} ${JSON.stringify(r2.j).slice(0, 60)})`)
  ok(r1.status === 202 && (await pendOf(e) as { change?: { pub?: string } } | undefined)?.change?.pub === K1.pub && waiting.length === 1, `P8: the first is queued, and one 'reset waiting' mail goes (${waiting.length})`)
}
{
  // F1b, line 820: the reset link is single use, even once its reset was stopped
  now += DAY
  const e = 'sd2c-once@example.com'
  await twoKeys(e)
  const t = await resetToken(e)
  ok((await reset(e, await Authn.make(), t.token ?? '')).status === 202, 'a reset is queued from its link')
  ok((await voidPost(e, voidIn(lastMail(e))?.token ?? '', 'cancel')).j.done === 'cancelled', 'and stopped from its own void link')
  const again = await reset(e, await Authn.make(), t.token ?? '')
  ok(again.status === 400 && again.j.error === 'token', `the same reset link cannot complete a second reset (got ${again.status} ${JSON.stringify(again.j).slice(0, 60)})`)
}
{
  // F1b, line 734: a Remove whose send outlived its hold (the object stalled), the change in effect meanwhile
  now += DAY
  const e = 'sd2c-r734@example.com'
  const [, A2] = await twoKeys(e)
  const X = await Authn.make()
  await request(e, A2, { add: X })
  const v = voidIn(lastMail(e))
  const rp = await ripensOf(e)
  now = rp - 5000
  const before = await current(e)
  const h = hangNext()
  const pr = voidPost(e, v?.token ?? '', 'remove')
  await reached(h)
  now = rp - 5000 + ROSTER_LIMITS.holdMs // the hold has lapsed and the deadline is past
  await fire(await rosterObj(e))
  h.release(true)
  const r = await pr
  const c = await current(e)
  ok(r.status === 409 && r.j.error === 'late' && r.j.at === now, `the stalled Remove, after the change took effect: refused as too late (got ${r.status} ${JSON.stringify(r.j)})`)
  ok(c.head?.seq === (before.head?.seq ?? -9) + 1 && c.head?.members.some((m) => m.pub === X.pub) && quarantinedIn(c, A2.pub) === false && c.pending === null,
    'nothing was suspended over the change that took effect')
  const ch = await chainOf(e)
  ok(ch.ok, `the kernel accepts the chain (${ch.ok ? 'ok' : ch.reason})`)
}
{
  // F1b, line 813: a reset whose send outlived its hold, a member change in effect meanwhile
  now += DAY
  const e = 'sd2c-r813@example.com'
  const [F1] = await twoKeys(e)
  const X = await Authn.make()
  await request(e, F1, { add: X })
  const rp = await ripensOf(e)
  now = rp - 5000
  const t = await resetToken(e)
  const h = hangNext()
  const pr = reset(e, await Authn.make(), t.token ?? '')
  await reached(h)
  now = rp - 5000 + ROSTER_LIMITS.holdMs
  await fire(await rosterObj(e))
  h.release(true)
  const r = await pr
  const c = await current(e)
  ok(r.status === 409 && r.j.error === 'superseded' && c.pending === null && c.head?.members.some((m) => m.pub === X.pub), `the stalled reset, over a head that moved: nothing queued (got ${r.status} ${JSON.stringify(r.j).slice(0, 60)})`)
  ok((await chainOf(e)).ok, 'the kernel accepts the chain')
  ok((await reset(e, await Authn.make(), t.token ?? '')).status === 202, 'the reset that did not happen did not spend its link')
}
{
  // whose hold: a Remove stalls past its hold; a reset takes the roster and is in its send when the Remove's ends
  now += DAY
  const e = 'sd2c-own1@example.com'
  const [, A2] = await twoKeys(e)
  await request(e, A2, { add: await Authn.make() })
  const v = voidIn(lastMail(e))
  const t = await resetToken(e)
  const hq = hangEach()
  const prm = voidPost(e, v?.token ?? '', 'remove')
  ok(await hq.has(1), 'a Remove is in its send')
  now += ROSTER_LIMITS.holdMs
  const prr = reset(e, await Authn.make(), t.token ?? '')
  ok(await hq.has(2), 'its hold lapses; a reset takes the roster and is in its own send')
  hq.calls[0]?.release(true)
  const rm = await prm
  ok(rm.status === 409 && rm.j.error === 'busy' && (await current(e)).head?.members.every((m) => !m.quarantined), `the stalled Remove finds the hold is another's: refused (busy), nothing suspended (got ${rm.status} ${JSON.stringify(rm.j)})`)
  hq.calls[1]?.release(true)
  hq.stop()
  const rr = await prr
  ok(rr.status === 202 && (await pendOf(e))?.kind === 'reset', `the reset that holds the roster is queued (got ${rr.status})`)
  ok((await chainOf(e)).ok, 'the kernel accepts the chain')
}
{
  // whose hold, the other way: a reset stalls past its hold; a Remove takes the roster
  now += DAY
  const e = 'sd2c-own2@example.com'
  const [, A2] = await twoKeys(e)
  await request(e, A2, { add: await Authn.make() })
  const v = voidIn(lastMail(e))
  const t = await resetToken(e)
  const hq = hangEach()
  const prr = reset(e, await Authn.make(), t.token ?? '')
  ok(await hq.has(1), 'a reset is in its send')
  now += ROSTER_LIMITS.holdMs
  const prm = voidPost(e, v?.token ?? '', 'remove')
  ok(await hq.has(2), 'its hold lapses; a Remove takes the roster and is in its own send')
  hq.calls[0]?.release(true)
  const rr = await prr
  ok(rr.status === 409 && rr.j.error === 'busy' && (await pendOf(e))?.kind === 'member', `the stalled reset finds the hold is another's: refused (busy), nothing queued (got ${rr.status} ${JSON.stringify(rr.j).slice(0, 60)})`)
  hq.calls[1]?.release(true)
  hq.stop()
  const rm = await prm
  ok(rm.status === 200 && quarantinedIn(await current(e), A2.pub) === true, `the Remove that holds the roster acts (got ${rm.status})`)
  ok((await chainOf(e)).ok, 'the kernel accepts the chain')
}
{
  // whose hold, once more: a stalled Remove whose change took effect leaves alone the hold a reset now has
  now += DAY
  const e = 'sd2c-own3@example.com'
  const [, A2] = await twoKeys(e)
  await request(e, A2, { add: await Authn.make() })
  const v = voidIn(lastMail(e))
  const rp = await ripensOf(e)
  now = rp - 5000
  const t = await resetToken(e)
  const hq = hangEach()
  const prm = voidPost(e, v?.token ?? '', 'remove')
  ok(await hq.has(1), 'a Remove is in its send, 5 s before the change ripens')
  now = rp - 5000 + ROSTER_LIMITS.holdMs
  const fired = fire(await rosterObj(e))
  ok(await hq.has(2), 'its hold lapses, and the change takes effect')
  hq.calls[1]?.release(true) // the change's own "in effect" mail
  await fired
  const prr = reset(e, await Authn.make(), t.token ?? '')
  ok(await hq.has(3), 'a reset takes the roster and is in its send')
  hq.calls[0]?.release(true)
  const rm = await prm
  ok(rm.status === 409 && rm.j.error === 'late', `the stalled Remove: too late (got ${rm.status} ${JSON.stringify(rm.j)})`)
  hq.calls[2]?.release(true)
  hq.stop()
  const rr = await prr
  ok(rr.status === 202 && (await pendOf(e))?.kind === 'reset', `the reset, whose hold the Remove left alone, is queued (got ${rr.status} ${JSON.stringify(rr.j).slice(0, 60)})`)
}

// ---------------------------------------------------------------------
// F2: a link whose life ended says how: too late, used, or cancelled by a reset
// ---------------------------------------------------------------------
for (const d of [-1, 0]) {
  // P5: Cancel a millisecond before the deadline, and at it, before the alarm has run
  now += DAY
  const e = `sd2c-p5${d}@example.com`
  const [D1] = await twoKeys(e)
  const X = await Authn.make()
  await request(e, D1, { add: X })
  const v = voidIn(lastMail(e))
  const rp = await ripensOf(e)
  now = rp + d
  const r = await voidPost(e, v?.token ?? '', 'cancel')
  const inForce = (await current(e)).head?.members.some((m) => m.pub === X.pub)
  if (d < 0) ok(r.j.done === 'cancelled' && !inForce, 'P5: Cancel a millisecond before the deadline: cancelled')
  else ok(r.status === 409 && r.j.error === 'late' && r.j.at === rp && inForce === true, `P5: Cancel at the deadline: too late, with the time it took effect (got ${r.status} ${JSON.stringify(r.j)})`)
}
{
  // P10: undo after the removal took effect
  now += DAY
  const e = 'sd2c-p10@example.com'
  const [, H2] = await twoKeys(e)
  await request(e, H2, { add: await Authn.make() })
  await voidPost(e, voidIn(lastMail(e))?.token ?? '', 'remove')
  const u = voidIn(mailsTo(e).filter((m) => /suspended/.test(m.subject)).pop())
  const ra = now + ROSTER_WAIT_MS
  now = ra
  const r = await voidPost(e, u?.token ?? '', 'undo')
  ok(r.status === 409 && r.j.error === 'late' && r.j.at === ra && r.j.by === undefined, `P10: undo at +72 h: too late, with the time the removal took effect (got ${r.status} ${JSON.stringify(r.j)})`)
}
{
  // the directory remembers a bounded number of ended links, by hash only
  now += DAY
  const e = 'sd2c-keep@example.com'
  const [K1] = await twoKeys(e)
  await plant(e, (st) => st.set('ended', Array.from({ length: ROSTER_LIMITS.endedKeep }, (_, i) => ({ h: `old${i}`, why: 'used', at: i }))))
  await request(e, K1, { add: await Authn.make() })
  const v = voidIn(lastMail(e))
  await voidPost(e, v?.token ?? '', 'cancel')
  const list = ((await rosterObj(e)).store.get('ended') ?? []) as { h: string }[]
  ok(ROSTER_LIMITS.endedKeep === 16 && list.length === 16 && list[0]?.h === 'old1' && (await voidPost(e, v?.token ?? '', 'cancel')).j.error === 'used',
    `the directory remembers the last 16 ended links and no more (${list.length})`)
  ok(!JSON.stringify(list).includes(v?.token ?? 'x'), 'an ended link is remembered by its hash, never its token')
}

// ---------------------------------------------------------------------
// C3: G4a survives a reset. The removal's undo link keeps working while a
// reset waits, and a stopped reset puts the removal back with its undo link.
// ---------------------------------------------------------------------
/** P4's start: the person's own P1, an attacker's A already a member, 15 days on; a wrong Remove suspends P1. */
async function p4start(e: string) {
  const P1 = await Authn.make(), A = await Authn.make()
  await setup(e, P1)
  await request(e, P1, { add: A })
  now += ROSTER_WAIT_MS
  await current(e)
  now += 15 * DAY
  await request(e, P1, { add: await Authn.make() }) // a hostile page stages "add B" with the person's own passkey
  const rm = await voidPost(e, voidIn(lastMail(e))?.token ?? '', 'remove')
  const undo = voidIn(mailsTo(e).filter((m) => /suspended/.test(m.subject)).pop())
  return { P1, A, rm, undo, removesAt: Number(rm.j.removesAt ?? now + ROSTER_WAIT_MS) }
}
async function p4reset(e: string) {
  const t = await resetToken(e)
  const RK = await Authn.make()
  const r = await reset(e, RK, t.token ?? '')
  return { RK, r, mail: lastMail(e) }
}
{
  // P4 as security wrote it: the undo after the reset, then the reset cancelled
  now += DAY
  const e = 'sd2c-p4@example.com'
  const { P1, A, rm, undo } = await p4start(e)
  ok(rm.j.done === 'suspended', 'P4: the wrong Remove suspends the person\'s own P1 (the attacker\'s A is a member)')
  const { r, mail } = await p4reset(e)
  ok(r.status === 202 && typeof ((await pendOf(e))?.parked as { voidTok?: string } | undefined)?.voidTok === 'string', 'P4: a reset while the removal waits sets the removal aside')
  ok(!!mail && mail.body.includes('which was waiting, is set aside while this reset waits. The link that puts that passkey back still works') && !mail.body.includes('is cancelled by this reset'),
    'P4: the reset notice says so, and that the undo link still works')
  now += HOUR
  const tu = now
  const un = await voidPost(e, undo?.token ?? '', 'undo')
  const c1 = await current(e)
  ok(un.status === 200 && un.j.done === 'restored' && un.j.resetAt === tu + ROSTER_WAIT_MS, `P4: the undo link works while the reset waits (got ${un.status} ${JSON.stringify(un.j)})`)
  ok(quarantinedIn(c1, P1.pub) === false && c1.pending?.kind === 'reset' && c1.pending.requestedAt === tu && c1.pending.ripensAt === tu + ROSTER_WAIT_MS,
    'P4: P1 is back at once; the reset carries on, asked again on the new head, so its 72 hours start again')
  const um = mailsTo(e).filter((m) => /put back/.test(m.subject)).pop()
  ok(!!um && um.body.includes(`The reset of this account that is waiting now takes effect at ${when(tu + ROSTER_WAIT_MS)}`), 'P4: the undo mail says when the reset now takes effect')
  const rc = await voidPost(e, voidIn(mail)?.token ?? '', 'cancel')
  const c2 = await current(e)
  ok(rc.j.done === 'cancelled' && c2.pending === null && quarantinedIn(c2, P1.pub) === false && c2.head?.members.some((m) => m.pub === A.pub), 'P4: the reset is cancelled from its link: P1 stays restored')
  ok((await request(e, P1, { remove: A.pub })).status === 202, 'P4: and P1 can ask for A\'s removal')
  const ch = await chainOf(e)
  ok(ch.ok, `P4: the kernel accepts the chain through q and u (${ch.ok ? 'ok' : ch.reason})`)
}
{
  // P4, the reset taking effect after the undo: the chain runs q, u, r
  now += DAY
  const e = 'sd2c-p4r@example.com'
  const { undo } = await p4start(e)
  const { RK } = await p4reset(e)
  now += HOUR
  await voidPost(e, undo?.token ?? '', 'undo')
  now = await ripensOf(e)
  await fire(await rosterObj(e))
  const c = await current(e)
  ok(c.head?.members.length === 1 && c.head.members[0]?.pub === RK.pub && c.pending === null, 'P4r: the reset, asked again at the undo, takes effect at its new time')
  const ch = await chainOf(e)
  ok(ch.ok, `P4r: the kernel accepts the chain through q, u and r (${ch.ok ? 'ok' : ch.reason})`)
}
{
  // P4b: the reset is stopped first: the removal waits again, at its own time, with its own undo link
  now += DAY
  const e = 'sd2c-p4b@example.com'
  const { P1, undo, removesAt } = await p4start(e)
  const { mail } = await p4reset(e)
  now += HOUR
  const rc = await voidPost(e, voidIn(mail)?.token ?? '', 'cancel')
  const p = await pendOf(e)
  ok(rc.j.done === 'cancelled' && rc.j.removesAt === removesAt && p?.kind === 'removal' && p?.ripensAt === removesAt,
    `P4b: stopping the reset puts the removal back, at its own time (got ${JSON.stringify(rc.j)}, ${String(p?.kind)})`)
  const sm = mailsTo(e).filter((m) => /stopped/.test(m.subject)).pop()
  ok(!!sm && sm.body.includes('which the reset had set aside, is waiting again: it takes effect at ' + when(removesAt)), 'P4b: the stop mail says the removal waits again, and until when its link puts the passkey back')
  const un = await voidPost(e, undo?.token ?? '', 'undo')
  const c = await current(e)
  ok(un.j.done === 'restored' && quarantinedIn(c, P1.pub) === false && c.pending === null, `P4b: the original undo link puts P1 back (got ${JSON.stringify(un.j)})`)
  const ch = await chainOf(e)
  ok(ch.ok, `P4b: the kernel accepts the chain (${ch.ok ? 'ok' : ch.reason})`)
}
{
  // P4c: the reset is stopped after the removal's own time: the removal takes effect at once
  now += DAY
  const e = 'sd2c-p4c@example.com'
  const { P1, removesAt } = await p4start(e)
  now += 2 * HOUR // the reset waits past the removal's own time
  const { mail } = await p4reset(e)
  now = removesAt + HOUR
  const rc = await voidPost(e, voidIn(mail)?.token ?? '', 'cancel')
  ok(rc.j.done === 'cancelled' && rc.j.removesAt === now, `P4c: stopped after the removal's time: the removal is due at once (got ${JSON.stringify(rc.j)})`)
  await fire(await rosterObj(e))
  const c = await current(e)
  ok(!c.head?.members.some((m) => m.pub === P1.pub) && c.pending === null, 'P4c: the alarm removes P1')
  const ch = await chainOf(e)
  ok(ch.ok, `P4c: the kernel accepts the chain through q and x (${ch.ok ? 'ok' : ch.reason})`)
}
{
  // the reset takes effect while a removal is set aside: the undo link says too late, by the reset
  now += DAY
  const e = 'sd2c-p4l@example.com'
  const { undo } = await p4start(e)
  await p4reset(e)
  const ra = await ripensOf(e)
  now = ra
  await fire(await rosterObj(e))
  const r = await voidPost(e, undo?.token ?? '', 'undo')
  ok(r.status === 409 && r.j.error === 'late' && r.j.by === 'reset' && r.j.at === ra, `the set-aside removal's undo after the reset took effect: too late, by the reset (got ${r.status} ${JSON.stringify(r.j)})`)
  ok((await chainOf(e)).ok, 'the kernel accepts the chain through q and r')
}
{
  // --- the void page: the one HTML answer, under its own headers ---
  const pages = ['/void', '/void.js', '/void.css']
  const snap = JSON.stringify(allStores.map((st) => [...st.entries()]))
  const got = await Promise.all(pages.map((p) => api('GET', p)))
  const types = ['text/html; charset=utf-8', 'text/javascript; charset=utf-8', 'text/css; charset=utf-8']
  got.forEach((r, i) => ok(r.status === 200 && r.h.get('content-type') === types[i], `GET ${pages[i]}: 200 ${types[i]}`))
  for (const [i, r] of got.entries()) {
    const csp = r.h.get('content-security-policy') ?? ''
    const d = (n: string) => csp.split(';').map((x) => x.trim()).find((x) => x.startsWith(n + ' '))
    ok(d('default-src') === "default-src 'none'" && d('script-src') === "script-src 'self'" && d('style-src') === "style-src 'self'" && d('connect-src') === "connect-src 'self'" &&
      d('frame-ancestors') === "frame-ancestors 'none'" && d('base-uri') === "base-uri 'none'" && d('form-action') === "form-action 'none'" && !/unsafe/.test(csp) &&
      d('require-trusted-types-for') === "require-trusted-types-for 'script'",
    `${pages[i]}: CSP self-only script and style, nothing inline, no framing, Trusted Types (${csp})`)
    ok(r.h.get('x-frame-options') === 'DENY' && r.h.get('x-content-type-options') === 'nosniff' && r.h.get('referrer-policy') === 'no-referrer' && r.h.get('cache-control') === 'no-store' &&
      /publickey-credentials-get=\(\)/.test(r.h.get('permissions-policy') ?? '') && /publickey-credentials-create=\(\)/.test(r.h.get('permissions-policy') ?? '') && r.h.get('access-control-allow-origin') === null,
    `${pages[i]}: DENY, nosniff, no referrer, no cache, WebAuthn off, no CORS`)
  }
  const q = await api('GET', '/void?e=x&t=y#z')
  ok(q.text === got[0].text, 'a query changes nothing in the page')
  ok(JSON.stringify(allStores.map((st) => [...st.entries()])) === snap, 'fetching the page stores nothing (a mail scanner\'s GET changes nothing)')
  ok((await api('POST', '/void', {})).h.get('content-type') === 'application/json' && (await api('GET', '/void/')).status === 404 && (await api('GET', '/void.html')).status === 404, 'nothing else under /void is a page')
  const js = got[1].text, html = got[0].text
  ok(!/navigator\.credentials|PublicKeyCredential|innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|Function\(|localStorage|indexedDB/.test(js + html), 'the page calls no WebAuthn, Signal API, HTML sink, eval or storage')
  ok(!/<script>|<style>|\son[a-z]+=|style="/i.test(html) && (html.match(/<script /g) ?? []).length === 1, 'the HTML has no inline script, style or handler; one script, from this origin')
  // the hosting check's own rules, over these answers
  const obs = got.map((r, i) => ({ role: 'rp', path: pages[i], url: `${DIRECTORY_ORIGIN}${pages[i]}`, status: r.status, headers: Object.fromEntries(r.h.entries()), body: r.text }))
  ok(HOSTING_VOID_PATH === VOID_PATH, `the hosting check's void page is the directory's (${HOSTING_VOID_PATH} = ${VOID_PATH})`)
  const ev = evaluate(obs as never, { voidPath: VOID_PATH } as never) as { id: string; fails: string[] }[]
  const rows = ev.filter((x) => ['rp-html-csp', 'no-framing', 'rp-permissions', 'rp-nosniff'].includes(x.id))
  ok(rows.length === 4 && rows.every((x) => x.fails.length === 0), `check-id-hosting's rp rows pass on the void page (${rows.map((x) => `${x.id}:${x.fails.length}`).join(' ')})`)
}

// =====================================================================
// 11. G9′.6a: what id.bento.page answers
// =====================================================================
{
  responses.push({ what: 'well-known', ...(await (async () => { const r = await api('GET', '/.well-known/webauthn'); return { status: r.status, h: r.h, text: r.text } })()) })
  const wk = responses[responses.length - 1]
  ok(wk.status === 404 && !wk.text.includes('origins'), '/.well-known/webauthn is not served (404)')
  for (const [m, p] of [['GET', '/'], ['GET', '/v1/keys'], ['OPTIONS', '/v1/roster/request'], ['POST', '/v1/nope'], ['GET', '/v1/roster?e=nobody@example.com'], ['GET', '/v1/roster?e=bad']] as const) {
    const r = await api(m, p, m === 'POST' ? {} : undefined)
    responses.push({ what: `${m} ${p}`, status: r.status, h: r.h, text: r.text })
  }
  const bad: string[] = []
  for (const r of responses) {
    const ct = r.h.get('content-type') ?? ''
    const emptyOk = r.text === '' && (r.status === 204)
    if (!(ct === 'application/json' || emptyOk)) bad.push(`${r.what}: content-type ${ct}`)
    if (r.h.get('x-content-type-options') !== 'nosniff') bad.push(`${r.what}: nosniff`)
    const pp = r.h.get('permissions-policy') ?? ''
    if (!/publickey-credentials-get=\(\)/.test(pp) || !/publickey-credentials-create=\(\)/.test(pp)) bad.push(`${r.what}: permissions-policy`)
    const csp = r.h.get('content-security-policy') ?? ''
    if (!/default-src 'none'/.test(csp) || !/frame-ancestors 'none'/.test(csp) || /script-src/.test(csp)) bad.push(`${r.what}: csp`)
    if (r.h.get('x-frame-options') !== 'DENY') bad.push(`${r.what}: x-frame-options`)
  }
  ok(responses.length > 100 && bad.length === 0, `every one of ${responses.length} answers: JSON, nosniff, WebAuthn blocked, CSP without script, DENY${bad.length ? ' — ' + bad.slice(0, 5).join('; ') : ''}`)
  const dir = join(root, 'server/directory/src')
  // the void page is the one HTML the directory has: its markup lives in voidpage.js alone, and worker.js serves it at /void only
  const html = readdirSync(dir).filter((f) => /<script|<html/i.test(readFileSync(join(dir, f), 'utf8')))
  const types = readdirSync(dir).filter((f) => /text\/html/i.test(readFileSync(join(dir, f), 'utf8')))
  ok(html.join() === 'voidpage.js' && types.every((f) => f === 'worker.js' || f === 'voidpage.js'),
    `the only HTML in the directory's sources is the void page (markup in: ${html.join(', ') || 'none'}; text/html in: ${types.join(', ')})`)
}

// =====================================================================
// 12. nothing raw at rest
// =====================================================================
{
  const dump = JSON.stringify(allStores.map((s) => [...s.entries()]))
  ok(!dump.includes('alice@example.com') && !dump.includes('ivy@example.com'), 'no raw address at rest (only inside the base64url ros. text)')
  ok(!/10\.1\.\d+\.\d+/.test(dump), 'no raw IP at rest')
  ok(!dump.includes(b64uEnc(te.encode('nope'))), 'sanity')
}

console.log(`${passes} passed, ${fails} failed`)
process.exit(fails)
