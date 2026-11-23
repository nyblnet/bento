#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/id directory: ACCOUNT DELETION (server/directory/src/deletion.js and
// its hooks in roster.js), against the REAL worker and Roster object with an
// in-memory namespace and a hand-moved clock (the harness is the roster rig's,
// copied so this rig stands alone).
//
//   node scripts/test-directory-deletion.ts      (ROWS=1 prints every row)
//
// What it must prove (security's D-A1 to D-A4 on the kernel's adel. layout):
//   · a member's adel. over the current head is queued 72 hours, only once its
//     waiting notice (DELETE in words, the second, the asker by name and age,
//     the whole roster, the void link) was accepted by the mailer;
//   · Cancel bars the asker 72 hours WHATEVER its kind; the owner's change
//     removing it is accepted in that window;
//   · Remove suspends the asker with a q link that carries the adel., and the
//     kernel verifies that chain; Remove is never offered to the only live member;
//   · a reset request DROPS a waiting deletion (logged preempted, never set
//     aside), and stopping the reset does not bring it back;
//   · at the end of the wait it is carried out only if the head is unchanged;
//     the record (rdel.) is signed and stored first, everything else goes, and
//     every place peers read answers "deleted" with the record; a new setup
//     works and reads as a new account;
//   · no deletion while anything else waits (an undo window included); absent
//     fields refuse; a malformed text never spends its challenge; a pend with
//     no time never executes; no budget holds the notice back; the routes are
//     new paths with their own challenge audience.

import worker, { Roster, Ledger } from '../server/directory/src/worker.js'
import { addressKey } from '../server/directory/src/address.js'
import { parseResetLink, parseSetupLink, parseVoidLink } from '../server/directory/src/links.js'
import { ROSTER_LIMITS } from '../server/directory/src/roster.js'
import { b64uDec, b64uEnc, sha256b64u, signStatement } from '../kernel/src/statements.ts'
import { buildAdel, buildRos, parseRos, verifyDeletion, readAfterDeletion, parseRdel, verifyRosterChain, accountNameOf, ROSTER_RP_ID, ROSTER_WEB_ORIGINS, ROSTER_WAIT_MS, DELETE_WAIT_MS, type Member, type RosterLink } from '../kernel/src/roster.ts'
import { AsyncLocalStorage } from 'node:async_hooks'

let fails = 0, passes = 0
/** when set, the delFail-th storage delete from now throws (a storage error part way through a purge) */
let delFail = 0
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
            async delete(k: string | string[]) { if (delFail && --delFail === 0) throw new Error('storage overloaded'); for (const x of [].concat(k as never)) store.delete(x) },
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
// helpers for deletion
// =====================================================================
function voidIn(m: Mail | undefined) {
  const urls = m?.body.match(/https?:\/\/\S+/g) ?? []
  const all = urls.map((u) => parseVoidLink(u)).filter(Boolean)
  return all.length === 1 ? all[0]! : null
}
const voidPost = (email: string, token: string, choice: string) => seen('void', api('POST', '/v1/void', { email, token, choice }))
const pendOf = async (email: string) => (await rosterObj(email)).store.get('pend') as Record<string, unknown> | undefined
const storeOf = async (email: string) => (await rosterObj(email)).store
async function twoKeys(email: string) {
  const a = await Authn.make(), b = await Authn.make()
  const su = await setup(email, a)
  const rq = await request(email, a, { add: b })
  if (su.status !== 200 || rq.status !== 202) console.log(`twoKeys(${email}): setup ${su.status} ${JSON.stringify(su.j)}, add ${rq.status} ${JSON.stringify(rq.j)}`)
  now += ROSTER_WAIT_MS
  await current(email)
  return [a, b] as const
}
async function delChallenge(email: string) {
  const r = await seen('del-challenge', api('POST', '/v1/roster/delete/challenge', { email }))
  return r.j.challenge as string
}
async function adelOf(email: string, ch: string) {
  const c = await current(email)
  return buildAdel({ address: email, headHash: await sha256b64u(c.text), dirNonce: ch })
}
type DelOpts = { ch?: string; text?: string; credId?: string | null; assertion?: unknown; rq?: string; drop?: string[]; extra?: Record<string, unknown> }
async function askDelete(email: string, signer: Authn | null, o: DelOpts = {}) {
  const ch = o.ch ?? await delChallenge(email)
  const text = o.text ?? await adelOf(email, ch)
  const body: Record<string, unknown> = { email, text, credId: o.credId === null ? undefined : o.credId ?? signer?.cid, assertion: o.assertion ?? (signer ? await signer.assert(text) : undefined), ...(o.rq !== undefined ? { rq: o.rq } : {}), ...o.extra }
  for (const k of o.drop ?? []) delete body[k]
  const r = await seen('delete', api('POST', '/v1/roster/delete', body))
  return { ...r, text, ch }
}
async function resetToken(email: string) {
  const n = mailbox.length
  await seen('reset-start', api('POST', '/v1/roster/reset/start', { email }))
  const m = mailbox.slice(n).find((x) => x.to === email && x.kind === 'reset')
  const urls = m?.body.match(/https?:\/\/\S+/g) ?? []
  const l = urls.length === 1 ? parseResetLink(urls[0]) : null
  return l && l.address === email ? l.token : null
}
async function reset(email: string, a: Authn, token: string) {
  const ch = await challenge(email)
  const reg = await a.register(b64uDec(ch)!)
  return seen('reset', api('POST', '/v1/roster/reset', { email, token, dirNonce: ch, reg }))
}
const stored = async (email: string) => {
  const store = await storeOf(email)
  return [...store.entries()].filter(([k]) => k.startsWith('link:')).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => {
    const l = v as Record<string, unknown>
    const out: Record<string, unknown> = { ros: l.ros, rip: l.rip, ripSig: l.ripSig }
    if (l.kind === 'member') { out.signer = l.signer; out.assertion = l.assertion }
    if (l.voided) out.voided = l.voided
    return out as unknown as RosterLink
  })
}

// =====================================================================
// 1. the routes: new paths, their own audience, CORS; the retired ones stay 410
// =====================================================================
{
  for (const p of ['/v1/delete', '/v1/delete/start', '/v1/delete/complete']) {
    const r = await api('POST', p, { email: 'x@example.com' })
    ok(r.status === 410, `retired ${p} still answers 410 (got ${r.status})`)
  }
  const pre = await worker.fetch(new Request('https://id.bento.page/v1/roster/delete', { method: 'OPTIONS', headers: { origin: S } }), env as never)
  ok(pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*', 'OPTIONS /v1/roster/delete: 204, CORS * like every roster route')
  const c = await api('POST', '/v1/roster/delete/challenge', { email: 'route@example.com' })
  ok(c.status === 200 && typeof c.j.challenge === 'string' && c.h.get('access-control-allow-origin') === '*', 'POST /v1/roster/delete/challenge issues a challenge (CORS *)')
  ok((await api('POST', '/v1/roster/delete/challenge', {})).status === 400, 'a challenge with no address: 400')
}

// =====================================================================
// 2. positive control: a member's deletion, queued 72 h, then carried out
// =====================================================================
const ann = 'del-ann@example.com'
const [A1, A2] = await twoKeys(ann)
{
  const pinnedLinks = await stored(ann)
  const before = await verifyRosterChain(pinnedLinks, { directoryKeys: DIR_KEYS, rpId: ROSTER_RP_ID, origins: [...ROSTER_WEB_ORIGINS], now })
  ok(before.ok, 'positive control: the account\'s chain verifies before the deletion')
  mailbox.length = 0
  const t0 = now
  const r = await askDelete(ann, A1)
  ok(r.status === 202 && r.j.ripensAt === t0 + DELETE_WAIT_MS, `A1 asks to delete the account: 202, takes effect 72 h later (got ${r.status} ${JSON.stringify(r.j)})`)
  const p = await pendOf(ann)
  ok(p?.kind === 'deletion' && p?.mailed === true && p?.ros === r.text && p?.headHash === (before.ok ? before.value.headHash : ''), 'queued as the waiting change, kind deletion, over the current head')
  const m = lastMail(ann) ?? NOMAIL
  const fp1 = (await (await import('../server/directory/src/roster.js')).fingerprint(A1.pub))
  const fp2 = (await (await import('../server/directory/src/roster.js')).fingerprint(A2.pub))
  ok(/DELETE this bento\/id account/.test(m.body) && /DELETED/.test(m.subject), 'the waiting notice says DELETE in words (subject and body)')
  ok(m.body.includes(when(t0)) && /\d\d:\d\d:\d\d UTC/.test(m.body), 'it gives the time to the second')
  ok(m.body.includes('from a browser'), 'it names the host class')
  ok(m.body.includes(`It was asked for by the passkey ${fp1}, added `), 'it names the asker by its short name and age (G4c)')
  ok(m.body.includes(`passkey ${fp1}`) && m.body.includes(`passkey ${fp2}`), 'it lists the whole roster')
  ok(voidIn(m)?.kind === 'd', 'it carries a void link that offers Remove (another live member stays)')
  ok((await current(ann)).pending?.kind === 'deletion', 'GET /v1/roster shows the waiting deletion')

  // not before 72 h
  now = t0 + DELETE_WAIT_MS - 1000
  await fire(await rosterObj(ann))
  ok((await head(ann)).status === 200, 'one second before the 72 hours: the account still stands')
  now = t0 + DELETE_WAIT_MS
  mailbox.length = 0
  await fire(await rosterObj(ann))
  const h = await head(ann)
  const rec = h.j.deleted as { text: string; sig: string } | undefined
  ok(h.status === 410 && h.j.error === 'deleted' && !!rec, `at 72 h it is deleted: GET /v1/roster answers 410 deleted with the record, never a bare 404 (got ${h.status})`)
  const v = rec ? await verifyDeletion(rec.text, rec.sig, { directoryKeys: DIR_KEYS, address: ann, pinnedLink: pinnedLinks[pinnedLinks.length - 1], now }) : null
  ok(v?.ok && v.value.atPin && v.value.by === 'm' && v.value.deletedAt === now && v.value.requestedAt === t0, `the record verifies against a peer's pin of the last head (kernel verifyDeletion: ${v?.ok ? 'ok' : v?.reason})`)
  ok(v?.ok && v.value.accountName === b64uEnc((await accountNameOf(ann))!) && !rec!.text.includes(b64uEnc(te.encode(ann))), 'the record names the storage name, never the address')
  const st = await storeOf(ann)
  ok(JSON.stringify([...st.keys()].sort()) === JSON.stringify(['ended', 'rdel']), `nothing else is kept: ${[...st.keys()].sort().join(', ')}`)
  ok((await rosterObj(ann)).alarm === null, 'the alarm is cleared')
  ok(/was deleted/.test(lastMail(ann)?.subject ?? ''), 'the address is told it was deleted')
  // every place a peer reads says deleted
  const ds = await api('GET', `/v1/device/status?e=${encodeURIComponent(ann)}&c=${b64uEnc(new Uint8Array(32).fill(7))}`)
  ok(ds.status === 200 && ds.j.state === 'deleted' && (ds.j.deleted as { text: string })?.text === rec?.text, `a certificate's status after the deletion: deleted, with the record (got ${ds.status} ${ds.j.state})`)
  const bh = await doOp(ann, 'browserHead', {})
  ok(bh.status === 410 && bh.j.error === 'deleted', `the browser head: deleted, not 404 (got ${bh.status})`)
  const ci = await doOp(ann, 'browserCheckin', { devicePub: A1.pub, nonce: 'n' + now, issued: now, aud: 'home' })
  ok(ci.status === 403 && ci.j.error === 'deleted', `a browser check-in: deleted (got ${ci.status} ${ci.j.error})`)
  const si = await doOp(ann, 'browserSignin', { assertion: { id: A1.cid }, challenge: 'x', nonce: 'm' + now, issued: now })
  ok(si.status === 403, `an old passkey's sign-in is refused (got ${si.status} ${si.j.error})`)
  const again = await askDelete(ann, A1)
  ok(again.status === 410, `asking again: 410 deleted (got ${again.status})`)
  const vt = voidIn(m)
  if (vt) {
    const late = await voidPost(ann, vt.token, 'cancel')
    ok(late.status === 409 && late.j.error === 'deleted' && late.j.at === now, `the void link after the deletion answers "deleted" (F2), not unknown (got ${late.status} ${late.j.error})`)
  } else ok(false, 'the void link was found')

  // a new setup at the address works, and reads as a NEW account that changed
  now += HOUR
  const A3 = await Authn.make()
  const su = await setup(ann, A3)
  ok(su.status === 200, `a new setup at the address works (got ${su.status} ${JSON.stringify(su.j)})`)
  const nh = await head(ann)
  ok(nh.status === 200 && (nh.j.deleted as { text: string })?.text === rec?.text, 'the new account\'s head carries the earlier deletion record')
  const fresh = await verifyRosterChain(await stored(ann), { directoryKeys: DIR_KEYS, rpId: ROSTER_RP_ID, origins: [...ROSTER_WEB_ORIGINS], now })
  const pr = rec ? parseRdel(rec.text) : null
  const after = pr?.ok && fresh.ok ? readAfterDeletion(pr.value, fresh.value) : null
  ok(after?.ok && after.value.state === 'new-account' && after.value.changed === true, 'a peer with the old pin reads the new chain as a NEW account that changed (kernel readAfterDeletion)')
}

// =====================================================================
// 3. D-A1: Cancel bars the asker 72 h whatever its kind; the owner's change goes through
// =====================================================================
{
  now += DAY
  const bo = 'del-bo@example.com'
  const [B1, B2] = await twoKeys(bo)
  mailbox.length = 0
  const r = await askDelete(bo, B2)
  ok(r.status === 202, `B2 asks to delete (got ${r.status} ${JSON.stringify(r.j)})`)
  const vl = voidIn(lastMail(bo))
  const c = vl ? await voidPost(bo, vl.token, 'cancel') : null
  ok(c?.status === 200 && c.j.done === 'cancelled' && c.j.until === now + ROSTER_LIMITS.voidCooldownMs, `Cancel: cancelled, the asker barred until ${when(now + ROSTER_LIMITS.voidCooldownMs)} (got ${c?.status} ${JSON.stringify(c?.j)})`)
  ok(/cancelled the DELETION/.test(lastMail(bo)?.body ?? ''), 'the cancel notice says the deletion was cancelled')
  ok((await storeOf(bo)).get(`cool:${B2.pub}`) === now + ROSTER_LIMITS.voidCooldownMs, 'cool:<asker> is set')
  const re = await askDelete(bo, B2)
  ok(re.status === 403 && re.j.error === 'cooldown', `the asker re-files at once: 403 cooldown (got ${re.status} ${re.j.error})`)
  const rq = await request(bo, B2, { remove: B1.pub })
  ok(rq.status === 403 && rq.j.error === 'cooldown', `nor can it ask for any other change (got ${rq.status} ${rq.j.error})`)
  const own = await request(bo, B1, { remove: B2.pub })
  ok(own.status === 202, `the owner's change removing that key is accepted in the window (got ${own.status} ${JSON.stringify(own.j)})`)
}
{
  // a recovery key (planted: the request route has no rk path yet) is barred the same way
  now += DAY
  const cy = 'del-cy@example.com'
  const [C1] = await twoKeys(cy)
  const rk = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const rkPub = b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', rk.publicKey)))
  await plant(cy, (st) => { const h = st.get('head') as { members: Member[] }; st.set('head', { ...h, members: [...h.members, { kind: 'rk', pub: rkPub, quarantined: false }] }) })
  const ch = await delChallenge(cy)
  const text = await adelOf(cy, ch)
  mailbox.length = 0
  const r = await askDelete(cy, null, { ch, text, credId: null, extra: { signer: rkPub, sig: await signStatement(rk.privateKey, text) } })
  ok(r.status === 202 && (await pendOf(cy))?.signerKind === 'rk', `the recovery key asks (a raw signature): 202 (got ${r.status} ${JSON.stringify(r.j)})`)
  ok(/recovery key/.test(lastMail(cy)?.body ?? ''), 'the notice names it as the recovery key')
  const vl = voidIn(lastMail(cy))
  const c = vl ? await voidPost(cy, vl.token, 'cancel') : null
  ok(c?.status === 200 && (await storeOf(cy)).get(`cool:${rkPub}`) === now + ROSTER_LIMITS.voidCooldownMs, 'Cancel bars the recovery key too (whatever its kind)')
  const ch2 = await delChallenge(cy)
  const t2 = await adelOf(cy, ch2)
  const re = await askDelete(cy, null, { ch: ch2, text: t2, credId: null, extra: { signer: rkPub, sig: await signStatement(rk.privateKey, t2) } })
  ok(re.status === 403 && re.j.error === 'cooldown', `the recovery key re-files at once: 403 cooldown (got ${re.status} ${re.j.error})`)
  const own = await askDelete(cy, C1)
  ok(own.status === 202, `another member may still ask (got ${own.status})`)
}

// =====================================================================
// 4. D-A1: Remove suspends the asker with a q link carrying the adel.; never for the only live member
// =====================================================================
{
  now += DAY
  const di = 'del-di@example.com'
  const [D1, D2] = await twoKeys(di)
  mailbox.length = 0
  const r = await askDelete(di, D2)
  const vl = voidIn(lastMail(di))
  ok(r.status === 202 && vl?.kind === 'd', 'D2 asks; its void link offers Remove')
  const rm = vl ? await voidPost(di, vl.token, 'remove') : null
  ok(rm?.status === 200 && rm.j.done === 'suspended', `Remove: the asker is suspended (got ${rm?.status} ${JSON.stringify(rm?.j)})`)
  const c = await current(di)
  ok(c.head?.members.some((m) => m.pub === D2.pub && m.quarantined) && c.pending?.kind === 'removal', 'the asker carries ~q and its removal waits')
  const links = await stored(di)
  const q = links[links.length - 1] as unknown as { voided?: { ros: string; signer: string } }
  ok(q?.voided?.ros === r.text && q?.voided?.signer === D2.pub, 'the q link carries the adel. text and its signer')
  const chain = await verifyRosterChain(links, { directoryKeys: DIR_KEYS, rpId: ROSTER_RP_ID, origins: [...ROSTER_WEB_ORIGINS], now })
  ok(chain.ok, `the kernel verifies the chain with the q link that voided a deletion (got ${chain.ok ? 'ok' : chain.reason})`)
  ok(/cancelled the DELETION/.test(lastMail(di)?.body ?? ''), 'the suspension notice says it was the deletion that was cancelled')
  const ul = voidIn(lastMail(di))
  const un = ul ? await voidPost(di, ul.token, 'undo') : null
  ok(un?.status === 200 && un.j.done === 'restored' && (await current(di)).head?.members.every((m) => !m.quarantined), 'its undo puts the key back')
  ok((await verifyRosterChain(await stored(di), { directoryKeys: DIR_KEYS, rpId: ROSTER_RP_ID, origins: [...ROSTER_WEB_ORIGINS], now })).ok, 'and the chain still verifies')
  void D1
}
{
  now += DAY
  const ed = 'del-ed@example.com'
  const E1 = await Authn.make()
  await setup(ed, E1)
  mailbox.length = 0
  const r = await askDelete(ed, E1)
  const vl = voidIn(lastMail(ed))
  ok(r.status === 202 && vl?.kind === 'e', 'the only member asks; its void link offers Cancel only (kind e)')
  ok(/one choice, Cancel/.test(lastMail(ed)?.body ?? ''), 'the notice says Cancel is the only choice')
  const rm = vl ? await voidPost(ed, vl.token, 'remove') : null
  ok(rm?.status === 400 && rm.j.error === 'choice' && (await pendOf(ed))?.kind === 'deletion', `Remove for the only live member: refused, the token unspent (got ${rm?.status} ${rm?.j.error})`)
  const c = vl ? await voidPost(ed, vl.token, 'cancel') : null
  ok(c?.status === 200 && !(await pendOf(ed)), 'Cancel still works with the same link')
}

// =====================================================================
// 5. D-A2: a reset request DROPS a waiting deletion; stopping the reset does not bring it back
// =====================================================================
{
  now += DAY
  const fi = 'del-fi@example.com'
  const [F1] = await twoKeys(fi)
  now += 15 * DAY
  mailbox.length = 0
  const d = await askDelete(fi, F1)
  const dv = voidIn(lastMail(fi))
  ok(d.status === 202, 'F1 asks to delete')
  const tok = await resetToken(fi)
  const R = await Authn.make()
  const rs = tok ? await reset(fi, R, tok) : null
  ok(rs?.status === 202 && (await pendOf(fi))?.kind === 'reset', `a reset completes while the deletion waits: 202, the reset is the waiting change (got ${rs?.status} ${JSON.stringify(rs?.j)})`)
  const rm = lastMail(fi)
  ok(/The deletion of this account that was waiting is cancelled by this reset\. Stopping the reset does not bring it back\./.test(rm?.body ?? ''), 'the reset notice names the dropped deletion')
  const log = [...(await storeOf(fi)).entries()].filter(([k]) => k.startsWith('log:')).map(([, v]) => v as Record<string, unknown>)
  ok(log.some((e) => e.k === 'preempted' && e.op === 'delete') && !log.some((e) => e.k === 'set-aside'), 'logged preempted, never set aside')
  ok(!((await pendOf(fi)) as Record<string, unknown>)?.parked, 'nothing is parked under the reset')
  const dl = dv ? await voidPost(fi, dv.token, 'cancel') : null
  ok(dl?.status === 409 && dl.j.error === 'preempted', `the deletion's void link answers preempted (got ${dl?.status} ${dl?.j.error})`)
  const rv = voidIn(rm)
  const stop = rv ? await voidPost(fi, rv.token, 'cancel') : null
  ok(stop?.status === 200 && !(await pendOf(fi)), `the reset is stopped: nothing waits (got ${stop?.status}; pend ${JSON.stringify((await pendOf(fi))?.kind)})`)
  now += DELETE_WAIT_MS + DAY
  await fire(await rosterObj(fi))
  ok((await head(fi)).status === 200 && !(await storeOf(fi)).get('rdel'), 'and the account still stands after the deletion\'s 72 hours')
}

// =====================================================================
// 6. at the end of the wait: carried out only on the head it named
// =====================================================================
{
  now += DAY
  const gi = 'del-gi@example.com'
  const [G1] = await twoKeys(gi)
  const r = await askDelete(gi, G1)
  ok(r.status === 202, 'G1 asks to delete')
  // the head changes under it (a revert or any immediate link): forced here
  await plant(gi, (st) => { const h = st.get('head') as Record<string, unknown>; st.set('head', { ...h, hash: 'Z'.repeat(43) }) })
  now += DELETE_WAIT_MS
  mailbox.length = 0
  await fire(await rosterObj(gi))
  const st = await storeOf(gi)
  ok(!st.get('rdel') && st.get('head') && !st.get('pend'), 'the head changed while it waited: not carried out, and dropped')
  ok(/NOT deleted/.test(lastMail(gi)?.subject ?? ''), 'the address is told it was not carried out, and why')
}
{
  // a pend with no time never executes (no NaN clock)
  now += DAY
  const hu = 'del-hu@example.com'
  const [H1] = await twoKeys(hu)
  await askDelete(hu, H1)
  await plant(hu, (st) => { const p = st.get('pend') as Record<string, unknown> | undefined; if (p) { delete p.ripensAt; st.set('pend', p) } })
  now += DELETE_WAIT_MS + DAY
  await fire(await rosterObj(hu))
  ok(!(await storeOf(hu)).get('rdel') && (await head(hu)).status === 200, 'a waiting deletion missing ripensAt is never carried out')
  await plant(hu, (st) => { const p = st.get('pend') as Record<string, unknown> | undefined; if (p) { p.ripensAt = now - 1; p.requestedAt = now - 1000; st.set('pend', p) } })
  await fire(await rosterObj(hu))
  ok(!(await storeOf(hu)).get('rdel') && (await pendOf(hu))?.kind === 'deletion', 'nor one that claims to be due less than 72 hours after it was asked for (it stays, cancellable)')
}
{
  // no key, nothing deleted
  now += DAY
  const iv = 'del-iv@example.com'
  const [I1] = await twoKeys(iv)
  await askDelete(iv, I1)
  now += DELETE_WAIT_MS
  const jwk = env.DIR_KEY_JWK
  delete env.DIR_KEY_JWK
  let threw = false
  try { await fire(await rosterObj(iv)) } catch { threw = true }
  env.DIR_KEY_JWK = jwk
  const st = await storeOf(iv)
  ok(threw && st.get('head') && st.get('pend') && !st.get('rdel'), 'without the directory key the record cannot be signed, and nothing is removed')
  await fire(await rosterObj(iv))
  ok((await storeOf(iv)).get('rdel') && !(await storeOf(iv)).get('head'), 'with the key back, the next alarm carries it out')
}

// =====================================================================
// 7. D-A3: nothing while anything else waits (an undo window included)
// =====================================================================
{
  now += DAY
  const jo = 'del-jo@example.com'
  const [J1, J2] = await twoKeys(jo)
  mailbox.length = 0
  const rq = await request(jo, J2, { remove: J1.pub })
  const vl = voidIn(lastMail(jo))
  const rm = vl ? await voidPost(jo, vl.token, 'remove') : null
  ok(rq.status === 202 && rm?.status === 200 && (await pendOf(jo))?.kind === 'removal', 'a Remove leaves a removal waiting, with its undo window open')
  const d = await askDelete(jo, J1)
  ok(d.status === 409 && d.j.error === 'pending', `a deletion while the undo window is open: 409 pending (got ${d.status} ${d.j.error})`)
  now += ROSTER_WAIT_MS
  await fire(await rosterObj(jo))
  const d2 = await askDelete(jo, J1)
  ok(d2.status === 202, `once nothing waits, it is accepted (got ${d2.status} ${JSON.stringify(d2.j)})`)
  const d3 = await askDelete(jo, J1)
  ok(d3.status === 409 && d3.j.error === 'pending', 'and a second one waits behind nothing: 409 pending')
}

// =====================================================================
// 8. absent fields, the grammar rule, the opener rule, the audience
// =====================================================================
{
  now += DAY
  const ky = 'del-ky@example.com'
  const [K1] = await twoKeys(ky)
  const miss = async (drop: string[], want: number, err: string, what: string) => {
    const r = await askDelete(ky, K1, { drop })
    ok(r.status === want && r.j.error === err, `${what}: ${want} ${err} (got ${r.status} ${r.j.error})`)
  }
  await miss(['text'], 400, 'invalid', 'no text')
  await miss(['credId'], 400, 'signer', 'no credId')
  await miss(['assertion'], 400, 'proof', 'no assertion')
  await miss(['email'], 400, 'invalid', 'no address')
  ok(!(await pendOf(ky)), 'none of them queued anything')
  // a text that is not an adel. never spends its challenge
  const ch = await delChallenge(ky)
  const good = await adelOf(ky, ch)
  const bad = await askDelete(ky, K1, { ch, text: good + '.x' })
  ok(bad.status === 400 && bad.j.error === 'grammar', `an adel. with an extra field: 400 grammar (got ${bad.status} ${bad.j.error})`)
  const after = await askDelete(ky, K1, { ch, text: good })
  ok(after.status === 202, `the same challenge then carries a good request: it was not spent (got ${after.status} ${JSON.stringify(after.j)})`)
  await plant(ky, (st) => st.delete('pend'))
  const reuse = await askDelete(ky, K1, { ch, text: good })
  ok(reuse.status === 400 && reuse.j.error === 'nonce', 'and once used it is spent')
  // an opener can never cause a deletion
  const op = await askDelete(ky, K1, { rq: 'https://home.bento.page' })
  ok(op.status === 400 && op.j.error === 'rq' && !(await pendOf(ky)), `a request naming an opener: 400 rq (got ${op.status} ${op.j.error})`)
  // the roster challenge is not a deletion challenge
  const rc = await challenge(ky)
  const wrong = await askDelete(ky, K1, { ch: rc })
  ok(wrong.status === 400 && wrong.j.error === 'nonce', `a challenge from /v1/roster/challenge: 400 nonce (got ${wrong.status} ${wrong.j.error})`)
  // an old head
  const ch2 = await delChallenge(ky)
  const old = buildAdel({ address: ky, headHash: await sha256b64u('an older head'), dirNonce: ch2 })
  const oh = await askDelete(ky, K1, { ch: ch2, text: old })
  ok(oh.status === 409 && oh.j.error === 'roster-head', `an adel. over another head: 409 roster-head (got ${oh.status} ${oh.j.error})`)
  // an assertion over another text
  const ch3 = await delChallenge(ky)
  const t3 = await adelOf(ky, ch3)
  const oa = await askDelete(ky, K1, { ch: ch3, text: t3, assertion: await K1.assert('adel.another') })
  ok(oa.status === 400 && /^assertion-/.test(String(oa.j.error)), `an assertion over another text: refused (got ${oa.status} ${oa.j.error})`)
  // the counter goes forward only
  const ch4 = await delChallenge(ky)
  const t4 = await adelOf(ky, ch4)
  await plant(ky, (st) => { const r = st.get(`pk:${K1.pub}`) as Record<string, unknown>; st.set(`pk:${K1.pub}`, { ...r, signCount: 10 }) })
  const back = await askDelete(ky, K1, { ch: ch4, text: t4, assertion: await K1.assert(t4, { count: 3 }) })
  ok(back.status === 400 && back.j.error === 'assertion-sign-count', `a counter that did not go forward: refused (got ${back.status} ${back.j.error})`)
  const ch5 = await delChallenge(ky)
  const t5 = await adelOf(ky, ch5)
  const fwd = await askDelete(ky, K1, { ch: ch5, text: t5, assertion: await K1.assert(t5, { count: 11 }) })
  ok(fwd.status === 202 && (await storeOf(ky)).get(`pk:${K1.pub}`)?.signCount === 11, `control: a counter that went forward is accepted and stored (got ${fwd.status})`)
}

// =====================================================================
// 9. the notice: mailer down → nothing queued; no budget holds it back (G10)
// =====================================================================
{
  now += DAY
  const lu = 'del-lu@example.com'
  const [L1] = await twoKeys(lu)
  mailDown = true
  const r = await askDelete(lu, L1)
  mailDown = false
  ok(r.status === 503 && !(await pendOf(lu)), `mailer down: 503 and nothing queued (got ${r.status})`)
  await plant(lu, (st) => st.set('mail', Array.from({ length: 10 }, (_, i) => now - i * 1000)))
  mailbox.length = 0
  const r2 = await askDelete(lu, L1)
  ok(r2.status === 202 && /DELETE/.test(lastMail(lu)?.body ?? ''), 'with the setup-mail budget spent, the deletion notice still goes')
}

// =====================================================================
// 10. the sign-in host writes the kernel's adel. (its page cannot import the kernel)
// =====================================================================
{
  const { adelText } = await import('../server/signin/public/account-client.js')
  const cases = [
    { address: 'alice@example.com', headHash: b64uEnc(new Uint8Array(32).fill(3)), nonce: b64uEnc(new Uint8Array(40).fill(9)) },
    { address: 'bob+tag@example.org', headHash: b64uEnc(new Uint8Array(32).fill(250)), nonce: b64uEnc(new Uint8Array(40).fill(1)) },
  ]
  for (const c of cases) {
    const k = buildAdel({ address: c.address, headHash: c.headHash, dirNonce: c.nonce })
    ok(adelText(c) === k, `the sign-in host's adelText writes exactly the kernel's buildAdel (${c.address})`)
  }
}

// =====================================================================
// 11. security's round 1 on the route (M1, M2, N1-N3)
// =====================================================================
{
  // M1: the purge fails part way (a storage error on its 2nd delete batch). The
  // record is stored BEFORE anything goes, and the waiting change and the head go
  // LAST, so the address never answers a bare 404 and the next alarm finishes it.
  now += DAY
  const pu = 'del-pu@example.com'
  const [P1] = await twoKeys(pu)
  await plant(pu, (st) => { for (let i = 0; i < 200; i++) st.set(`zfill:${String(i).padStart(4, '0')}`, 1) })
  const r = await askDelete(pu, P1)
  ok(r.status === 202, `M1 positive control: the deletion is queued (got ${r.status})`)
  now += DELETE_WAIT_MS
  delFail = 2
  let threw = false
  try { await fire(await rosterObj(pu)) } catch { threw = true }
  delFail = 0
  const st = await storeOf(pu)
  ok(threw && st.size > 3 && st.size < 200, `M1 positive control: the purge failed part way (threw ${threw}, ${st.size} keys left)`)
  ok(!!st.get('rdel'), 'M1 the deletion record is already stored when the purge fails part way')
  ok(!!st.get('head') && (st.get('pend') as { kind?: string } | undefined)?.kind === 'deletion', 'M1 the head and the waiting deletion are still there, so it is retried')
  const o = await rosterObj(pu)
  ok(o.alarm !== null && o.alarm <= now + 60_000, `M1 an alarm is set to retry (at ${o.alarm === null ? 'none' : `+${(o.alarm - now) / 1000} s`})`)
  now += 60_000
  await fire(o)
  const keys = [...(await storeOf(pu)).keys()].sort()
  ok(JSON.stringify(keys) === JSON.stringify(['ended', 'rdel']), `M1 the next alarm finishes the purge, and nothing else is kept: ${keys.join(', ')}`)
  const done = await head(pu)
  ok(done.status === 410 && done.j.error === 'deleted' && !!done.j.deleted, `M1 the address answers 410 deleted with the record, never a bare 404 (got ${done.status})`)
}
{
  // M2: a deletion asked under a hold is refused (a planted hold)
  now += DAY
  const ho = 'del-ho@example.com'
  const [H1] = await twoKeys(ho)
  await plant(ho, (st) => st.set('hold', { id: 'x', what: 'reset', until: now + 60_000 }))
  const r = await askDelete(ho, H1)
  ok(r.status === 409 && !(await pendOf(ho)), `M2 a deletion asked while the roster is held: 409, nothing queued (got ${r.status} ${JSON.stringify(r.j)})`)
  await plant(ho, (st) => st.delete('hold'))
  const r2 = await askDelete(ho, H1)
  ok(r2.status === 202, `M2 positive control: once the hold is off it is accepted (got ${r2.status})`)
}
{
  // M2 (D-A2): the owner completes a reset with nothing waiting; while its notice
  // is going out, a stolen key asks for a deletion. The deletion is refused and the
  // reset stands (without the hold check the deletion would be queued and the
  // reset, whose mail already said it waits, would end 409 superseded)
  now += DAY
  const ra = 'del-ra@example.com'
  const [R1] = await twoKeys(ra)
  const tok = await resetToken(ra)
  const N = await Authn.make()
  const hg = hangNext()
  const rp = reset(ra, N, tok!)
  const got = await reached(hg)
  const d = await askDelete(ra, R1)
  hg.release(true)
  const rr = await rp
  const pk = (await pendOf(ra))?.kind
  ok(got, 'M2 positive control: the reset reached its notice')
  ok(d.status === 409 && rr.status === 202 && pk === 'reset', `M2 a deletion asked while the reset notice is out: 409; the reset stands (deletion ${d.status}, reset ${rr.status} ${JSON.stringify(rr.j)}, waiting ${pk})`)
}
{
  // N2: a second deletion while the first one's notice is still going out (unsent pend): 409
  now += DAY
  const tw = 'del-tw@example.com'
  const [T1, T2] = await twoKeys(tw)
  const hg = hangNext()
  const first = askDelete(tw, T1)
  const got = await reached(hg)
  const second = await askDelete(tw, T2)
  hg.release(true)
  const f = await first
  const p = await pendOf(tw)
  ok(got && f.status === 202, `N2 positive control: the first deletion went through once its notice was accepted (got ${f.status})`)
  ok(second.status === 409 && p?.signer === T1.pub, `N2 a second deletion while the first notice is out: 409, the first stands (got ${second.status} ${second.j.error})`)
}
{
  // N1: a recovery-key asker pressed Remove: the q link carries its raw signature
  // (not a passkey assertion), and the notice calls it a key
  now += DAY
  const rk1 = 'del-rk@example.com'
  await twoKeys(rk1)
  const rk = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const rkPub = b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', rk.publicKey)))
  await plant(rk1, (st) => { const h = st.get('head') as { members: Member[] }; st.set('head', { ...h, members: [...h.members, { kind: 'rk', pub: rkPub, quarantined: false }] }) })
  const ch = await delChallenge(rk1)
  const text = await adelOf(rk1, ch)
  const sig = await signStatement(rk.privateKey, text)
  mailbox.length = 0
  const r = await askDelete(rk1, null, { ch, text, credId: null, extra: { signer: rkPub, sig } })
  const vl = voidIn(lastMail(rk1))
  ok(r.status === 202 && vl?.kind === 'd', `N1 positive control: the recovery key asks, its link offers Remove (got ${r.status})`)
  const rm = vl ? await voidPost(rk1, vl.token, 'remove') : null
  const q = [...(await storeOf(rk1)).entries()].filter(([k]) => k.startsWith('link:')).map(([, v]) => v as { voided?: Record<string, unknown> }).find((l) => l.voided)
  ok(rm?.status === 200 && q?.voided?.signer === rkPub && q?.voided?.sig === sig && q?.voided?.assertion === undefined && q?.voided?.ros === text,
    `N1 Remove for a recovery-key asker: the q link carries its raw signature as the evidence (got ${rm?.status}, ${q ? Object.keys(q.voided!).join(',') : 'no q link'})`)
  const body = lastMail(rk1)?.body ?? ''
  ok(/That key can no longer be used/.test(body) && !/That passkey can no longer be used/.test(body), 'N1 the suspension notice calls the recovery key a key, not a passkey')
}
{
  // N3: an equal passkey counter is refused; a check-in for a deleted account spends its nonce
  now += DAY
  const eq = 'del-eq@example.com'
  const [Q1] = await twoKeys(eq)
  await plant(eq, (st) => { const r = st.get(`pk:${Q1.pub}`) as Record<string, unknown>; st.set(`pk:${Q1.pub}`, { ...r, signCount: 10 }) })
  const ch = await delChallenge(eq)
  const t = await adelOf(eq, ch)
  const same = await askDelete(eq, Q1, { ch, text: t, assertion: await Q1.assert(t, { count: 10 }) })
  ok(same.status === 400 && same.j.error === 'assertion-sign-count' && !(await pendOf(eq)), `N3 a counter equal to the stored one: refused (got ${same.status} ${same.j.error})`)
  const fwd = await askDelete(eq, Q1, { assertion: undefined, ...(await (async () => { const c2 = await delChallenge(eq); const t2 = await adelOf(eq, c2); return { ch: c2, text: t2, assertion: await Q1.assert(t2, { count: 11 }) } })()) })
  ok(fwd.status === 202, `N3 positive control: one more is accepted (got ${fwd.status})`)
  now += DELETE_WAIT_MS
  await fire(await rosterObj(eq))
  const args = { devicePub: Q1.pub, nonce: 'n' + now, issued: now, aud: 'home' }
  const c1 = await doOp(eq, 'browserCheckin', args)
  const c2 = await doOp(eq, 'browserCheckin', args)
  ok(c1.status === 403 && c1.j.error === 'deleted', `N3 positive control: a check-in after the deletion answers deleted (got ${c1.status} ${c1.j.error})`)
  ok(c2.status === 400 && c2.j.error === 'nonce', `N3 the same check-in again: its nonce was spent (got ${c2.status} ${c2.j.error})`)
}

console.log(`\n${passes} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
