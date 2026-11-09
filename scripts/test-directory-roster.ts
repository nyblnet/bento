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
//   · no countersign (`rip.`) is issued yet;
//   · a setup link mailed beyond the budget lives a day, so a stranger who
//     keeps asking costs the owner at most the day's budget plus one link a
//     day, with never a moment without a live link (S1′); the link lives are
//     pinned; setup/start answers the same bytes in every state;
//   · what happens after a waiting notice's send touches the stored change
//     only if it is still that request's (D1a), and the mailer has a timeout;
//   · spent challenges are swept by the alarm once nobody spends.

import worker, { Roster } from '../server/directory/src/worker.js'
import { Ledger } from '../server/directory/src/worker.js'
import { addressKey } from '../server/directory/src/address.js'
import { PASSKEY, SIGNIN_ORIGIN, passkeyOrigins, readCbor, verifyRegistration, verifyMemberAssertion } from '../server/directory/src/passkey.js'
import { parseSetupLink, setupLink, SIGNIN_PATHS } from '../server/directory/src/links.js'
import { MAIL_KINDS, MAIL_TIMEOUT_MS, deliver } from '../server/directory/src/mail.js'
import * as workerModule from '../server/directory/src/worker.js'
import { WEB_ROUTES } from '../server/directory/src/seam.js'
const { LIMITS } = workerModule
import { openChallenge } from '../server/directory/src/challenge.js'
import { existsSync } from 'node:fs'
import { fingerprint, ROSTER_LIMITS } from '../server/directory/src/roster.js'
import { b64uDec, b64uEnc, sha256b64u } from '../kernel/src/statements.ts'
import { buildRos, parseRos, ROSTER_RP_ID, ROSTER_WEB_ORIGINS, ROSTER_WAIT_MS, type Member } from '../kernel/src/roster.ts'
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
const env: Record<string, unknown> = {
  DIR_KID: 'dir-1', CHALLENGE_KEY: 'k'.repeat(48),
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
  // the stored link carries the directory's times, and no countersign exists yet
  const store = (await rosterObj(alice)).store
  const link = store.get('link:00000001') as Record<string, unknown>
  ok(link && link.requestedAt === addAt && link.ripenedAt === addAt + ROSTER_WAIT_MS && link.ros === r.ros, 'link 1 stored with requestedAt and ripenedAt on the directory clock')
  ok(![...store.keys()].some((k) => /rip/.test(k)) && ![...store.values()].some((v) => JSON.stringify(v).includes('"rip.')), 'no rip. countersign is stored')
  ok(!responses.some((x) => x.text.includes('rip.')), 'no answer carries a rip. countersign')
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
  const html = readdirSync(dir).filter((f) => /text\/html|<script|<html/i.test(readFileSync(join(dir, f), 'utf8')))
  ok(html.length === 0, `no directory source serves HTML yet (found in: ${html.join(', ') || 'none'})`)
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
