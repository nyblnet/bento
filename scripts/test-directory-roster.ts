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
//   · no countersign (`rip.`) is issued yet.

import worker, { Roster } from '../server/directory/src/worker.js'
import { Address, Ledger } from '../server/directory/src/worker.js'
import { addressKey } from '../server/directory/src/address.js'
import { PASSKEY, passkeyOrigins, verifyRegistration, verifyMemberAssertion } from '../server/directory/src/passkey.js'
import { fingerprint, ROSTER_LIMITS } from '../server/directory/src/roster.js'
import { b64uDec, b64uEnc, sha256b64u } from '../kernel/src/statements.ts'
import { buildRos, parseRos, ROSTER_RP_ID, ROSTER_WEB_ORIGINS, ROSTER_WAIT_MS, type Member } from '../kernel/src/roster.ts'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0, passes = 0
const ok = (c: unknown, n: string) => { if (c) passes++; else { fails++; console.log('FAIL ' + n) } }

// ---------- clock ----------
let now = Date.parse('2026-11-09T09:00:00Z')
Date.now = () => now
const MIN = 60_000, HOUR = 60 * MIN

// ---------- in-memory Durable Object namespaces ----------
type Obj = { fetch(r: Request): Promise<Response>; alarm?(): Promise<void> }
const allStores: Map<string, unknown>[] = []
function namespace(Klass: new (state: unknown, env: unknown) => Obj) {
  const objs = new Map<string, { obj: Obj; store: Map<string, unknown>; alarm: number | null }>()
  const ns = {
    objs,
    idFromName: (n: string) => n,
    get(id: string) {
      if (!objs.has(id)) {
        const store = new Map<string, unknown>()
        allStores.push(store)
        const rec = { obj: null as unknown as Obj, store, alarm: null as number | null }
        const state = {
          storage: {
            async get(k: string) { return structuredClone(store.get(k)) },
            async put(k: string, v: unknown) { store.set(k, structuredClone(v)) },
            async delete(k: string | string[]) { for (const x of [].concat(k as never)) store.delete(x) },
            async list(o?: { prefix?: string }) {
              return new Map([...store].filter(([k]) => !o?.prefix || k.startsWith(o.prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, structuredClone(v)]))
            },
            async setAlarm(t: number) { rec.alarm = t },
          },
        }
        rec.obj = new Klass(state, env)
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
const env: Record<string, unknown> = {
  DIR_KID: 'dir-1', CHALLENGE_KEY: 'k'.repeat(48),
  MAILER: { send: (m: Mail) => { mailbox.push(m) } },
}
const ROSTER = namespace(Roster as never)
env.ROSTER = ROSTER
env.ADDRESS = namespace(Address as never)
env.LEDGER = namespace(Ledger as never)

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

type RegOpts = { origin?: string; rpId?: string; flags?: number; alg?: number; type?: string; cross?: unknown; top?: string; cdj?: string; extraCoseKey?: boolean; trailing?: boolean; noAt?: boolean }
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
    const cose = cat(new Uint8Array([o.extraCoseKey ? 0xa6 : 0xa5, 0x01, 0x02, 0x03]), algBytes, new Uint8Array([0x20, 0x01, 0x21, 0x58, 0x20]), x,
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
async function setupToken(email: string) { return (await doOp(email, 'setupStart')).j.token as string | null }
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
  const ros = buildRos({ address: email, seq: o.seq ?? c.head.seq + 1, prev: o.prev ?? await sha256b64u(c.text), members, dirNonce: ch, created: o.created ?? now })
  const assertion = o.noAssertion ? undefined : await signer.assert(ros, o.get)
  const reg = o.reg !== undefined ? o.reg : o.add ? await o.add.register(b64uDec(ch)!, o.regOpts) : undefined
  const r = await seen('request', api('POST', '/v1/roster/request', { email, ros, credId: o.credId ?? signer.cid, assertion, reg, rq: o.rq }, { origin: o.origin }))
  return { ...r, ros }
}
const NOMAIL: Mail = { to: '', subject: '', body: '', kind: '' }
const lastMail = (to: string) => [...mailbox].reverse().find((m) => m.to === to)
const mailsTo = (to: string) => mailbox.filter((m) => m.to === to)
async function plant(email: string, mutate: (store: Map<string, unknown>) => void) { mutate((await rosterObj(email)).store) }

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
  const r = await request(alice, A2, { add: A3 })
  ok(r.status === 202, 'A2 (a member now) asks to add A3')
  const o = await rosterObj(alice)
  ok(o.alarm === now + ROSTER_WAIT_MS, 'an alarm is set for the ripening time')
  now = o.alarm ?? now
  await (o.obj as Obj).alarm!()
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
  ok(mailbox.every((m) => !m.body.includes('<') && m.kind === 'roster'), 'roster mail is plain fixed wording')
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
