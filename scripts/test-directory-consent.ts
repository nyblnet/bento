#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/id directory: the consent route (SD4a), server/directory/src/consent.js
// and the Roster request op's consent-key paths.
//
//   node scripts/test-directory-consent.ts        (Node >= 23.6 strips types natively)
//   ROWS=1 node scripts/test-directory-consent.ts  (print every row)
//
// Drives the REAL worker and its Roster Durable Object (the same in-memory
// namespace, input gate and hand-moved clock as test-directory-roster.ts) with
// software passkeys and software consent keys. What it must prove:
//   · a consent key (ck) asks for a change by its cns. (purpose roster, audience
//     dir, challenge = the ros.'s dirNonce, over the exact ros. text); a ck that
//     has been a member for 72 h at the request (exactly 72 h included) puts it
//     in force at once under `m`, one a second short waits 72 h like a passkey;
//   · ripeness comes from the stored chain through the kernel's verifier,
//     measured at the request, never at ripening and never from `created`;
//   · a co-sign counts only from another unquarantined, ripe ck of the current
//     head, alive at the request; anything else (the requester itself, a
//     passkey, a quarantined ck, a ck only in the new head, an expired or
//     malformed co-sign, a null one) is a refusal and nothing queues;
//   · the purpose is the directory's: a web-add cns. is refused on a ros., and
//     a transcript over another text, another audience, or a spent challenge is
//     refused;
//   · G4b's cooldown, quarantine, one change at a time and the hold apply to a
//     ck exactly as to a passkey;
//   · an immediate change mails first and acts only once the mailer accepted
//     the notice (mailer down: nothing changes); that mail lists the whole
//     roster, the co-signer and the host class;
//   · X5: on an account with a ripe ck, a passkey added from a browser waits 7
//     days unless that ck co-signs; on an account with no ck at all, 72 h;
//   · a ck joins only with its own cns. over the ros. that adds it;
//   · the stored chain, as a peer receives it (consent.js linkOut, which the
//     browser routes serve), verifies through the kernel and reproduces every
//     skipped wait; the log names the asker's kind, the co-signer and the wait.

import worker, { Roster, Ledger } from '../server/directory/src/worker.js'
import { addressKey } from '../server/directory/src/address.js'
import { parseSetupLink, parseVoidLink } from '../server/directory/src/links.js'
import { CONSENT_RP, X5_WAIT_MS, linkOut } from '../server/directory/src/consent.js'
import { fingerprint } from '../server/directory/src/roster.js'
import { issueChallenge } from '../server/directory/src/challenge.js'
import { b64uDec, b64uEnc, buildConsent, consentTranscript, sha256b64u, signStatement } from '../kernel/src/statements.ts'
import { buildRos, parseRos, verifyRosterChain, ROSTER_RP_ID, ROSTER_WEB_ORIGINS, ROSTER_WAIT_MS, type Member, type RosterLink } from '../kernel/src/roster.ts'
import { AsyncLocalStorage } from 'node:async_hooks'

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


// ---------- consent keys ----------
type CnsOpts = { purpose?: string; audience?: string; challenge?: string; over?: string; exp?: number; rp?: string }
class CK {
  pub = ''; kp!: CryptoKeyPair
  static async make() {
    const k = new CK()
    k.kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
    k.pub = b64uEnc(new Uint8Array(await crypto.subtle.exportKey('raw', k.kp.publicKey)))
    return k
  }
  /** This key's cns. over `text`: purpose roster, audience dir, challenge `nonce`, alive two minutes from now. */
  async cns(text: string, nonce: string, o: CnsOpts = {}) { return cnsBy(this.kp.privateKey, text, nonce, o) }
}
async function cnsBy(key: CryptoKey, text: string, nonce: string, o: CnsOpts = {}) {
  const transcript = await consentTranscript(o.audience ?? 'dir', o.challenge ?? nonce, o.over ?? text)
  const cns = buildConsent({ rp: o.rp ?? CONSENT_RP, purpose: (o.purpose ?? 'roster') as never, docId: null, transcript: transcript!, exp: o.exp ?? now + 2 * MIN })
  return { cns, sig: await signStatement(key, cns) }
}

// ---------- flows ----------
async function challenge(email: string) {
  return (await api('POST', '/v1/roster/challenge', { email })).j.challenge as string
}
async function setupToken(email: string) {
  const n = mailbox.length
  const r = await api('POST', '/v1/roster/setup/start', { email })
  if (r.status !== 202) return null
  const m = mailbox.slice(n).find((x) => x.to === email && x.kind === 'setup')
  const urls = m?.body.match(/https?:\/\/\S+/g) ?? []
  const l = urls.length === 1 ? parseSetupLink(urls[0]) : null
  return l && l.address === email ? l.token : null
}
async function setup(email: string, a: Authn) {
  const token = await setupToken(email)
  const ch = await challenge(email)
  return api('POST', '/v1/roster/setup', { email, token, dirNonce: ch, reg: await a.register(b64uDec(ch)!) })
}
async function current(email: string) {
  const h = await api('GET', `/v1/roster?e=${encodeURIComponent(email)}`)
  const p = typeof h.j.ros === 'string' ? await parseRos(h.j.ros) : null
  return { text: h.j.ros as string, head: p?.ok ? p.value : null, pending: (h.j.pending ?? null) as Record<string, unknown> | null }
}
type Ask = {
  by: Authn | CK; add?: Authn | CK; remove?: string; members?: Member[]; created?: number; ch?: string
  cnsOpts?: CnsOpts; coBy?: CK; coOpts?: CnsOpts; cosign?: unknown; newKey?: unknown; noNewKey?: boolean; extra?: Record<string, unknown>
}
/** A request through the route: a passkey's assertion or a consent key's cns., and whatever else the row adds. */
async function ask(email: string, o: Ask) {
  const c = await current(email)
  if (!c.head) return { status: -1, j: { error: 'no-head' } as Record<string, unknown>, ros: '', ch: '' }
  const ch = o.ch ?? await challenge(email)
  let members = o.members ?? c.head.members.slice()
  if (!o.members) {
    if (o.add) members = [...members, { kind: o.add instanceof CK ? 'ck' : 'pk', pub: o.add.pub, quarantined: false }]
    if (o.remove) members = members.filter((m) => m.pub !== o.remove)
  }
  const ros = buildRos({ address: email, seq: c.head.seq + 1, prev: await sha256b64u(c.text), members, dirNonce: ch, created: o.created ?? now })
  const body: Record<string, unknown> = { email, ros }
  if (o.by instanceof CK) { const p = await o.by.cns(ros, ch, o.cnsOpts); Object.assign(body, { signer: o.by.pub, cns: p.cns, sig: p.sig }) }
  else Object.assign(body, { credId: o.by.cid, assertion: await o.by.assert(ros) })
  if (o.add instanceof Authn) body.reg = await o.add.register(b64uDec(ch)!)
  if (o.add instanceof CK && !o.noNewKey && o.newKey === undefined) body.newKey = await o.add.cns(ros, ch)
  if (o.newKey !== undefined) body.newKey = o.newKey
  if (o.coBy) body.cosign = { signer: o.coBy.pub, ...(await o.coBy.cns(ros, ch, o.coOpts)) }
  if ('cosign' in o) body.cosign = o.cosign
  Object.assign(body, o.extra ?? {})
  const r = await api('POST', '/v1/roster/request', body)
  return { ...r, ros, ch, body }
}
const store = async (email: string) => (await rosterObj(email)).store
const pendOf = async (email: string) => (await store(email)).get('pend') as Record<string, unknown> | undefined
const headOf = async (email: string) => (await store(email)).get('head') as { seq: number; hash: string; members: Member[] } | undefined
const linkAt = async (email: string, seq: number) => (await store(email)).get(`link:${String(seq).padStart(8, '0')}`) as Record<string, unknown> | undefined
const logOf = async (email: string) => [...(await store(email)).entries()].filter(([k]) => k.startsWith('log:')).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v as Record<string, unknown>)
const lastMail = (to: string) => [...mailbox].reverse().find((m) => m.to === to)
const DIR_KEYS = { 'dir-1': DIR_PUB }
const CHAIN = () => ({ directoryKeys: DIR_KEYS, rpId: ROSTER_RP_ID, origins: [...ROSTER_WEB_ORIGINS], now, consentRp: CONSENT_RP })
/** The stored links as the directory serves them (consent.js linkOut), through the kernel's verifier. */
async function chainOf(email: string) {
  const links = [...(await store(email)).entries()].filter(([k]) => k.startsWith('link:')).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => linkOut(v) as RosterLink)
  return verifyRosterChain(links, CHAIN())
}
/** The same links mapped by this rig, field by field, so a linkOut that drops a field cannot hide behind itself. */
async function rawChainOf(email: string) {
  const links = [...(await store(email)).entries()].filter(([k]) => k.startsWith('link:')).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => {
    const l = v as Record<string, unknown>
    const out: Record<string, unknown> = { ros: l.ros, rip: l.rip, ripSig: l.ripSig }
    if (l.kind === 'member') for (const f of ['signer', 'assertion', 'sig', 'cns', 'cosign']) if (l[f] !== undefined) out[f] = l[f]
    if (l.voided) out.voided = l.voided
    return out as unknown as RosterLink
  })
  return verifyRosterChain(links, CHAIN())
}
const sinceIn = async (email: string, pub: string) => { const c = await chainOf(email); return c.ok ? c.value.members.find((m) => m.pub === pub)?.since : undefined }
const ripOf = (l: Record<string, unknown> | undefined) => String(l?.rip ?? '').split('.')
function voidIn(m: Mail | undefined) {
  const urls = m?.body.match(/https?:\/\/\S+/g) ?? []
  const all = urls.map((u) => parseVoidLink(u)).filter(Boolean)
  return all.length === 1 ? all[0]! : null
}

let acctN = 0
/**
 * A fresh account: one passkey A set up from the browser, then `cks` consent
 * keys added one after the other, each by A with the key's own proof, each
 * waiting its 72 h. The clock ends at the moment the last one took effect, so
 * the last key's `since` is `now`.
 */
async function account(cks = 0) {
  const email = `sd4-${++acctN}@example.com`
  const A = await Authn.make()
  const s = await setup(email, A)
  ok(s.status === 200, `setup ${email}: 200 (${s.status})`)
  const C: CK[] = []
  for (let i = 0; i < cks; i++) {
    const k = await CK.make()
    const r = await ask(email, { by: A, add: k })
    ok(r.status === 202, `${email}: a passkey asks to add a consent key with the key's own proof: queued 72 h (${r.status} ${r.j.error ?? ''})`)
    now += ROSTER_WAIT_MS
    await current(email) // the head read ripens it
    C.push(k)
  }
  return { email, A, C }
}
const HOUR_MS = 3_600_000

// =====================================================================
// 1. a consent key asks: ripe (exactly 72 h at the request) or not
// =====================================================================
{
  const { email, A, C: [C0] } = await account(1)
  const since = await sinceIn(email, C0.pub)
  ok(since === now, 'the consent key\'s since is the moment its addition took effect, read from the verified chain')
  const before = await headOf(email)
  now = (since ?? now) + ROSTER_WAIT_MS
  const X = await Authn.make()
  const r = await ask(email, { by: C0, add: X })
  ok(r.status === 200 && r.j.inForce === true, `consent/ck-requests-ripe: a consent key a member for exactly 72 h asks; in force at once (${r.status} ${r.j.error ?? ''})`)
  const h = await headOf(email)
  ok(h?.seq === (before?.seq ?? -9) + 1 && h?.members.some((m) => m.pub === X.pub), 'the new head names the added passkey')
  const l = await linkAt(email, h?.seq ?? -1)
  const rip = ripOf(l)
  ok(rip[4] === 'm' && rip[2] === String(now) && rip[3] === String(now), 'its rip. is issued at once under m, requestedAt = ripenedAt = the request')
  ok(l?.signer === C0.pub && typeof l?.cns === 'string' && typeof l?.sig === 'string' && l?.assertion === undefined, 'the link carries the consent key\'s cns. and signature, no assertion')
  const ch = await chainOf(email)
  ok(ch.ok && ch.value.seq === h?.seq, `the served chain verifies through the kernel, the skipped wait included (${ch.ok ? '' : ch.reason})`)
  const raw = await rawChainOf(email)
  ok(raw.ok && raw.value.headHash === (ch.ok ? ch.value.headHash : 'x'), 'and so does the rig\'s own mapping of the stored links (linkOut drops nothing)')
  const lg = (await logOf(email)).at(-1)
  ok(lg?.k === 'consent' && lg?.sk === 'ck' && lg?.cs === '' && lg?.wt === 'none' && lg?.how === 'app' && lg?.by === C0.pub, `the log names the asker's kind, no co-signer, no wait, from an app (${JSON.stringify(lg)})`)
  const m = lastMail(email)
  ok(!!m && m.subject === 'Your bento/id passkeys changed' && m.body.includes('the app key that asked has been on this account for 72 hours or more') && m.body.includes(`app key ${await fingerprint(C0.pub)}`),
    'the in-effect mail says it took effect at once because a ripe app key asked, and names it')
  const replay = await api('POST', '/v1/roster/request', { ...r.body })
  ok(replay.status === 400 && replay.j.error === 'nonce', `consent/replay: the same cns. and challenge again: 400 nonce (${replay.status} ${replay.j.error})`)
  void A
}
{
  const { email, C: [C0] } = await account(1)
  const since = (await sinceIn(email, C0.pub)) ?? now
  now = since + ROSTER_WAIT_MS - 1000
  const X = await Authn.make()
  const r = await ask(email, { by: C0, add: X })
  ok(r.status === 202 && r.j.ripensAt === now + ROSTER_WAIT_MS, `consent/ck-requests-unripe-one-second-short: queued 72 h like a passkey (${r.status} ${r.j.error ?? ''} ${Number(r.j.ripensAt) - now})`)
  const p = await pendOf(email)
  ok(p?.sk === 'ck' && p?.cns !== undefined && p?.assertion === undefined, 'the waiting change keeps the consent key\'s proof')
  const lg = (await logOf(email)).at(-1)
  ok(lg?.k === 'request' && lg?.sk === 'ck' && lg?.wt === '72h', `the request is logged with the asker's kind and its wait (${JSON.stringify(lg)})`)
  now += ROSTER_WAIT_MS
  await current(email)
  const h = await headOf(email)
  ok(!!h?.members.some((m) => m.pub === X.pub), 'after 72 h it takes effect')
  const ch = await chainOf(email)
  ok(ch.ok, `a queued consent-key change verifies through the kernel once it ripened (${ch.ok ? '' : ch.reason})`)
}
{
  // created is the requester's clock and never read: ten days early changes nothing
  const { email, C: [C0] } = await account(1)
  const since = (await sinceIn(email, C0.pub)) ?? now
  now = since + 71 * HOUR_MS
  const r = await ask(email, { by: C0, add: await Authn.make(), created: now - 10 * 24 * HOUR_MS })
  ok(r.status === 202 && r.j.ripensAt === now + ROSTER_WAIT_MS, `consent/since-from-chain-not-created: a ros. created ten days early leaves a 71-hour key unripe (${r.status} ${r.j.error ?? ''})`)
}

// =====================================================================
// 2. co-signs
// =====================================================================
{
  const { email, A, C: [C0] } = await account(1)
  const since = (await sinceIn(email, C0.pub)) ?? now
  now = since + 71 * HOUR_MS
  const X = await Authn.make()
  const early = await ask(email, { by: A, add: X, coBy: C0 })
  ok(early.status === 400 && early.j.error === 'cosign-unripe', `consent/ripeness-at-requestedAt-not-ripenedAt: a co-signer 71 h old at the request is refused, though it would be ripe by any ripening (${early.status} ${early.j.error})`)
  ok(!(await pendOf(email)), 'and nothing queued')
  now = since + ROSTER_WAIT_MS
  const before = await headOf(email)
  const n0 = mailbox.length
  const r = await ask(email, { by: A, add: X, coBy: C0 })
  ok(r.status === 200 && r.j.inForce === true, `consent/cosign-counts: a passkey's add co-signed by a ripe consent key is in force at once (${r.status} ${r.j.error ?? ''})`)
  const h = await headOf(email)
  const l = await linkAt(email, h?.seq ?? -1)
  ok(h?.seq === (before?.seq ?? -9) + 1 && ripOf(l)[4] === 'm', 'under m, no new authority word')
  const cs = l?.cosign as Record<string, unknown> | undefined
  ok(cs?.signer === C0.pub && typeof cs?.cns === 'string' && typeof cs?.sig === 'string' && l?.signer === A.pub && l?.assertion !== undefined, 'the stored link carries the co-sign beside the passkey\'s assertion')
  const ch = await chainOf(email)
  ok(ch.ok && ch.value.seq === h?.seq, `the kernel reproduces the waived wait from the served chain (${ch.ok ? '' : ch.reason})`)
  const raw = await rawChainOf(email)
  ok(raw.ok, `and from the rig's own mapping (${raw.ok ? '' : raw.reason})`)
  const mails = mailbox.slice(n0).filter((m) => m.to === email)
  const m = mails.at(-1)
  const lines = m?.body.split('\n').filter((x) => /^ {2}- (passkey|app key) [0-9a-f]{8}, /.test(x)) ?? []
  ok(mails.length === 1 && lines.length === (h?.members.length ?? -1) && (h?.members.length ?? 0) === 3,
    `consent/mail-states-cosign: one mail, listing the whole roster (${lines.length} lines for ${h?.members.length} members)`)
  ok(!!m && !!m.body.split('\n').find((x) => x.includes('approved it too'))?.includes(`app key ${await fingerprint(C0.pub)}`) && m.body.includes('from a browser') && m.body.includes(`the passkey ${await fingerprint(X.pub)} was added`),
    'and it names the co-signer, the change in words and the host class')
  const lg = (await logOf(email)).filter((e) => e.k === 'consent').at(-1)
  ok(lg?.sk === 'pk' && lg?.cs === C0.pub && lg?.wt === 'none' && lg?.how === 'browser', `the log names the passkey asker, the co-signer, no wait, from a browser (${JSON.stringify(lg)})`)
  ok((await logOf(email)).some((e) => e.k === 'reg' && e.pub === X.pub), 'the added passkey\'s registration is logged')
}
{
  const { email, A, C: [C0] } = await account(1)
  now += ROSTER_WAIT_MS
  const X = await Authn.make()
  const self = await ask(email, { by: C0, add: X, coBy: C0 })
  ok(self.status === 400 && self.j.error === 'cosign', `consent/cosign-is-requester: refused (${self.status} ${self.j.error})`)
  const pkKey = A.kp.privateKey
  // a passkey member's key signing a cns. as the co-signer: a browser never co-signs
  const c = await current(email)
  const ch = await challenge(email)
  const ros = buildRos({ address: email, seq: (c.head?.seq ?? 0) + 1, prev: await sha256b64u(c.text), members: [...(c.head?.members ?? []), { kind: 'pk', pub: X.pub, quarantined: false }], dirNonce: ch, created: now })
  const mine = await C0.cns(ros, ch)
  const pkCo = await cnsBy(pkKey, ros, ch)
  const r = await api('POST', '/v1/roster/request', { email, ros, signer: C0.pub, ...mine, reg: await X.register(b64uDec(ch)!), cosign: { signer: A.pub, ...pkCo } })
  ok(r.status === 400 && r.j.error === 'cosign-kind', `consent/cosign-by-pk: a passkey's key as the co-signer is refused (${r.status} ${r.j.error})`)
}
{
  // a key only in the NEW head cannot co-sign the change that adds it
  const { email, A } = await account(0)
  const K = await CK.make()
  const r = await ask(email, { by: A, add: K, coBy: K })
  ok(r.status === 400 && r.j.error === 'cosign-signer', `consent/cosign-not-in-current-head: refused (${r.status} ${r.j.error})`)
}
{
  const { email, A, C: [C0] } = await account(1)
  now += ROSTER_WAIT_MS
  const X = await Authn.make()
  for (const [label, cs] of [['{}', {}], ['null', null], ['a string', 'x'], ['an extra field', 'extra'], ['an array', []]] as const) {
    const v: unknown = cs
    const r = cs === 'extra'
      ? await (async () => { const c = await current(email); const ch = await challenge(email)
        const ros = buildRos({ address: email, seq: (c.head?.seq ?? 0) + 1, prev: await sha256b64u(c.text), members: [...(c.head?.members ?? []), { kind: 'pk', pub: X.pub, quarantined: false }], dirNonce: ch, created: now })
        return api('POST', '/v1/roster/request', { email, ros, credId: A.cid, assertion: await A.assert(ros), reg: await X.register(b64uDec(ch)!), cosign: { signer: C0.pub, ...(await C0.cns(ros, ch)), also: 1 } }) })()
      : await ask(email, { by: A, add: X, cosign: v })
    ok(r.status === 400 && r.j.error === 'cosign', `consent/cosign-bad-is-refusal-not-ignored: a co-sign that is ${label} answers 400 cosign (${r.status} ${r.j.error})`)
  }
  ok(!(await pendOf(email)), 'and nothing queued: a bad co-sign never falls back to the 72-hour wait')
  const expired = await ask(email, { by: A, add: X, coBy: C0, coOpts: { exp: now - 1 } })
  ok(expired.status === 400 && expired.j.error === 'cosign-consent-expired', `consent/cosign-expired-at-request: refused (${expired.status} ${expired.j.error})`)
  const long = await ask(email, { by: A, add: X, coBy: C0, coOpts: { exp: now + 6 * MIN } })
  ok(long.status === 400 && long.j.error === 'cosign-consent-lifetime', `a co-sign living past five minutes: refused (${long.status} ${long.j.error})`)
  const wa = await ask(email, { by: A, add: X, coBy: C0, coOpts: { purpose: 'web-add' } })
  ok(wa.status === 400 && wa.j.error === 'cosign-consent-payload-family', `consent/web-add-cns-on-ros: a web-add co-sign over a ros. is refused (${wa.status} ${wa.j.error})`)
  ok(!(await pendOf(email)), 'still nothing queued')
  // the absent field: no cosign key at all is a passkey's plain request, which X5 then holds 7 days (a ripe ck is on the account)
  const plain = await ask(email, { by: A, add: X })
  ok(plain.status === 202, `absent-fields: no cosign key at all is a plain request (${plain.status} ${plain.j.error ?? ''})`)
}

// =====================================================================
// 3. the directory's purpose and transcript
// =====================================================================
{
  const { email, C: [C0] } = await account(1)
  now += ROSTER_WAIT_MS
  const X = await Authn.make()
  const wa = await ask(email, { by: C0, add: X, cnsOpts: { purpose: 'web-add' } })
  ok(wa.status === 400 && wa.j.error === 'consent-payload-family', `a consent key's web-add cns. as its roster request: refused (${wa.status} ${wa.j.error})`)
  const other = await ask(email, { by: C0, add: X, cnsOpts: { over: 'ros.someone-elses-text' } })
  ok(other.status === 400 && other.j.error === 'consent-transcript', `consent/transcript-recomputed: a cns. over another ros. text is refused (${other.status} ${other.j.error})`)
  const room = await ask(email, { by: C0, add: X, cnsOpts: { audience: 'room:w' + 'a'.repeat(43) } })
  ok(room.status === 400 && room.j.error === 'consent-transcript', `consent/audience: a cns. for a room's audience, not the directory's, is refused (${room.status} ${room.j.error})`)
  const rp = await ask(email, { by: C0, add: X, cnsOpts: { rp: 'vault-acme' } })
  ok(rp.status === 400 && rp.j.error === 'consent-rp', `a cns. naming another rp: refused (${rp.status} ${rp.j.error})`)
  const wch = await issueChallenge(env.CHALLENGE_KEY as string, 'web', await addressKey(email), now)
  const cross = await ask(email, { by: C0, add: X, ch: wch })
  ok(cross.status === 400 && cross.j.error === 'nonce', `consent/audience-cross: a challenge sealed for the browser routes is refused on the roster route (${cross.status} ${cross.j.error})`)
  // a cns. made for ANOTHER account's head, over its own challenge
  const B = await account(1)
  const ch = await challenge(email)
  const c = await current(email)
  const ros = buildRos({ address: email, seq: (c.head?.seq ?? 0) + 1, prev: await sha256b64u(c.text), members: [...(c.head?.members ?? []), { kind: 'pk', pub: X.pub, quarantined: false }], dirNonce: ch, created: now })
  const bCh = await challenge(B.email)
  const foreign = await C0.cns(ros, bCh)
  const fr = await api('POST', '/v1/roster/request', { email, ros, signer: C0.pub, ...foreign, reg: await X.register(b64uDec(ch)!) })
  ok(fr.status === 400 && fr.j.error === 'consent-transcript', `a cns. bound to another account's challenge: refused (${fr.status} ${fr.j.error})`)
  // both kinds of proof at once
  const both = await ask(email, { by: C0, add: X, extra: { assertion: { authenticatorData: '', clientDataJSON: '', signature: '' } } })
  ok(both.status === 400 && both.j.error === 'proof', `a consent key's request carrying an assertion too: refused (${both.status} ${both.j.error})`)
  const pkCns = await ask(email, { by: (await account(0)).A, add: X, extra: { cns: 'cns.x', sig: 'x' } })
  ok(pkCns.status === 400 && pkCns.j.error === 'proof', `a passkey's request carrying a cns.: refused (${pkCns.status} ${pkCns.j.error})`)
  const notCk = await ask(email, { by: C0, add: X, extra: { signer: (await headOf(email))?.members.find((m) => m.kind === 'pk')?.pub } })
  ok(notCk.status === 400 && notCk.j.error === 'signer-kind', `a cns. request naming a passkey member as its signer: refused (${notCk.status} ${notCk.j.error})`)
  ok(!(await pendOf(email)), 'nothing queued by any of them')
}

// =====================================================================
// 4. quarantine, cooldown, one change at a time (the same rules as a passkey)
// =====================================================================
{
  const { email, A, C: [C0] } = await account(1)
  const X = await Authn.make()
  // an unripe key asks (queued); Remove from the void page suspends it
  const r = await ask(email, { by: C0, add: X })
  ok(r.status === 202, `an unripe consent key's request waits (${r.status})`)
  const v = voidIn(lastMail(email))
  ok(v?.kind === 'c', 'its waiting notice carries a void link that offers Remove')
  now += 71 * HOUR_MS
  const rm = await api('POST', '/v1/void', { email, token: v?.token, choice: 'remove' })
  ok(rm.status === 200 && rm.j.done === 'suspended', `Remove suspends the consent key (${rm.status} ${rm.j.error ?? ''})`)
  const ch = await chainOf(email)
  ok(ch.ok && ch.value.members.find((m) => m.pub === C0.pub)?.quarantined === true, `the suspension (a q link whose evidence is the consent key's cns.) verifies through the kernel (${ch.ok ? '' : ch.reason})`)
  // a suspended member always has its removal waiting; take that away so the quarantine rule itself answers
  ;(await store(email)).delete('pend')
  now += 2 * HOUR_MS // the key is now past 72 h on the chain: only the mark refuses it
  const qa = await ask(email, { by: C0, add: X })
  ok(qa.status === 403 && qa.j.error === 'quarantined', `consent/ck-quarantined-requester: refused 403 (${qa.status} ${qa.j.error})`)
  const qc = await ask(email, { by: A, add: X, coBy: C0 })
  ok(qc.status === 400 && qc.j.error === 'cosign-quarantined', `consent/cosign-quarantined: refused (${qc.status} ${qc.j.error})`)
}
{
  const { email, A, C: [C0] } = await account(1)
  const r = await ask(email, { by: C0, add: await Authn.make() })
  const v = voidIn(lastMail(email))
  const cancel = await api('POST', '/v1/void', { email, token: v?.token, choice: 'cancel' })
  ok(r.status === 202 && cancel.status === 200, 'an unripe consent key\'s request, cancelled from the void page')
  now += ROSTER_WAIT_MS - 60_000 // ripe on the chain, still inside G4b's 72 hours
  const again = await ask(email, { by: C0, add: await Authn.make() })
  ok(again.status === 403 && again.j.error === 'cooldown', `consent/ck-cooldown: G4b bars the consent key that asked for 72 hours (${again.status} ${again.j.error})`)
  now += 2 * 60_000
  const after = await ask(email, { by: C0, add: await Authn.make() })
  ok(after.status === 200, `and after them it asks again, ripe, in force at once (${after.status} ${after.j.error ?? ''})`)
  void A
}

// =====================================================================
// 5. X5 and one change at a time
// =====================================================================
{
  const { email, A, C: [C0] } = await account(1)
  now += ROSTER_WAIT_MS
  const X = await Authn.make()
  const r = await ask(email, { by: A, add: X })
  ok(r.status === 202 && r.j.ripensAt === now + X5_WAIT_MS, `x5/browser-add-with-ripe-ck-waits-7d (${r.status} ${(Number(r.j.ripensAt) - now) / HOUR_MS} h)`)
  ok(!!lastMail(email)?.body.includes('7 days after it was asked for'), 'its waiting notice says 7 days and why')
  const lg = (await logOf(email)).at(-1)
  ok(lg?.k === 'request' && lg?.wt === 'x5' && lg?.sk === 'pk', `the log marks the X5 wait (${JSON.stringify(lg)})`)
  const Y = await Authn.make()
  const co = await ask(email, { by: A, add: Y, coBy: C0 })
  ok(co.status === 409 && co.j.error === 'pending', `consent/pending-blocks-cosigned: a co-signed request while a change waits: 409 (${co.status} ${co.j.error})`)
  now += ROSTER_WAIT_MS + 60_000
  await current(email)
  ok(!(await headOf(email))?.members.some((m) => m.pub === X.pub), 'X5: 72 hours are not enough')
  now += X5_WAIT_MS - ROSTER_WAIT_MS
  await current(email)
  ok(!!(await headOf(email))?.members.some((m) => m.pub === X.pub), 'X5: 7 days are')
  const ch = await chainOf(email)
  ok(ch.ok, `and the 7-day link verifies through the kernel (${ch.ok ? '' : ch.reason})`)
}
{
  const { email, A } = await account(0)
  const r = await ask(email, { by: A, add: await Authn.make() })
  ok(r.status === 202 && r.j.ripensAt === now + ROSTER_WAIT_MS, `x5/no-ck-72h: an account with no consent key at all waits 72 h (${r.status} ${(Number(r.j.ripensAt) - now) / HOUR_MS} h)`)
  const lg = (await logOf(email)).at(-1)
  ok(lg?.k === 'request' && lg?.sk === undefined && lg?.cs === undefined, 'and logs exactly as a passkey request always did')
}
{
  const { email, A } = await account(1) // the key is not ripe yet
  const r = await ask(email, { by: A, add: await Authn.make() })
  ok(r.status === 202 && r.j.ripensAt === now + ROSTER_WAIT_MS, `x5/unripe-ck-72h: a consent key not yet ripe does not stretch the wait (${r.status} ${(Number(r.j.ripensAt) - now) / HOUR_MS} h)`)
}
{
  const { email, A, C: [C0] } = await account(1)
  now += ROSTER_WAIT_MS
  const r = await ask(email, { by: A, add: await Authn.make(), coBy: C0 })
  ok(r.status === 200 && r.j.inForce === true, `x5/cosign-ends-wait: the ripe key's co-sign puts a browser's add in force at once (${r.status})`)
}

// =====================================================================
// 6. notice before act; the hold
// =====================================================================
{
  const { email, C: [C0] } = await account(1)
  now += ROSTER_WAIT_MS
  const before = await headOf(email)
  const links0 = [...(await store(email)).keys()].filter((k) => k.startsWith('link:')).length
  mailDown = true
  const r = await ask(email, { by: C0, add: await Authn.make() })
  mailDown = false
  const after = await headOf(email)
  const links1 = [...(await store(email)).keys()].filter((k) => k.startsWith('link:')).length
  ok(r.status === 503 && r.j.error === 'mail' && after?.hash === before?.hash && links1 === links0 && !(await pendOf(email)),
    `consent/notice-before-act: mailer down, an immediate change does not happen (${r.status} ${r.j.error}, head ${after?.hash === before?.hash ? 'unchanged' : 'MOVED'})`)
  const r2 = await ask(email, { by: C0, add: await Authn.make() })
  ok(r2.status === 200 && (await headOf(email))?.seq === (before?.seq ?? -9) + 1, `positive control: mailer up, the same request is in force (${r2.status} ${r2.j.error ?? ''})`)
}
{
  const { email, A, C: [C0] } = await account(1)
  now += ROSTER_WAIT_MS
  const h = hangNext()
  const first = ask(email, { by: C0, add: await Authn.make() })
  const got = await reached(h)
  ok(got, 'the immediate change\'s notice is out (the send hangs)')
  const second = got ? await ask(email, { by: A, add: await Authn.make() }) : { status: -1, j: {} as Record<string, unknown> }
  ok(second.status === 409 && second.j.error === 'pending', `while it is out the roster is held: another request is refused before mailing (${second.status} ${second.j.error})`)
  h.release(true)
  const r = await first
  ok(r.status === 200, `the change lands once its notice was accepted (${r.status} ${r.j.error ?? ''})`)
  ok(!(await store(email)).get('hold'), 'and the hold is released')
}

// =====================================================================
// 7. adding a consent key: it proves it holds its key
// =====================================================================
{
  const { email, A, C: [C0] } = await account(1)
  const K = await CK.make()
  const none = await ask(email, { by: A, add: K, noNewKey: true })
  ok(none.status === 400 && none.j.error === 'new-key-proof', `ck-add/needs-proof: adding a consent key without its own cns.: refused (${none.status} ${none.j.error})`)
  // another key's signature presented as the new key's
  const c = await current(email)
  const ch = await challenge(email)
  const ros = buildRos({ address: email, seq: (c.head?.seq ?? 0) + 1, prev: await sha256b64u(c.text), members: [...(c.head?.members ?? []), { kind: 'ck', pub: K.pub, quarantined: false }], dirNonce: ch, created: now })
  const forged = await api('POST', '/v1/roster/request', { email, ros, credId: A.cid, assertion: await A.assert(ros), newKey: await C0.cns(ros, ch) })
  ok(forged.status === 400 && forged.j.error === 'new-key-consent-signature', `ck-add/not-its-key: a cns. by another key: refused (${forged.status} ${forged.j.error})`)
  const wa = await ask(email, { by: A, add: K, newKey: await K.cns('ros.x', b64uEnc(new Uint8Array(16))) })
  ok(wa.status === 400 && wa.j.error === 'new-key-consent-transcript', `ck-add: a cns. over another text: refused (${wa.status} ${wa.j.error})`)
  const onPk = await ask(email, { by: A, add: await Authn.make(), newKey: await K.cns('ros.x', 'y'.repeat(22)) })
  ok(onPk.status === 400 && onPk.j.error === 'new-key', `a newKey proof on a passkey's addition: refused (${onPk.status} ${onPk.j.error})`)
  ok(!(await pendOf(email)), 'nothing queued')
  const good = await ask(email, { by: A, add: K })
  ok(good.status === 202, `with its proof: queued (${good.status} ${good.j.error ?? ''})`)
  ok(!!lastMail(email)?.body.includes(`add the app key ${await fingerprint(K.pub)}`), 'its notice names an app key, not a passkey')
}

// =====================================================================
// 8. two keys: a ripe key co-signs another key's (unripe) request
// =====================================================================
{
  const { email, C: [C0, C1] } = await account(2)
  // C1 just joined (unripe), C0 is 72 h older (ripe)
  const r = await ask(email, { by: C1, add: await Authn.make(), coBy: C0 })
  ok(r.status === 200, `an unripe consent key's request co-signed by a ripe one: in force at once (${r.status} ${r.j.error ?? ''})`)
  const back = await ask(email, { by: C0, add: await Authn.make(), coBy: C1 })
  ok(back.status === 400 && back.j.error === 'cosign-unripe', `the other way round the co-sign does not count, and is refused (${back.status} ${back.j.error})`)
  const ch = await chainOf(email)
  ok(ch.ok, `the chain verifies (${ch.ok ? '' : ch.reason})`)
}

console.log(`${passes} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
