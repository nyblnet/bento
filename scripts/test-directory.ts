#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/id directory rig (server/directory, id.bento.page): the address normal
// form and the first design's retired routes. The passkey roster has its own
// rig (test-directory-roster.ts).
//
//   node scripts/test-directory.ts        (Node ≥ 23.6 strips types natively)
//
// Drives the REAL worker against in-memory Durable Object namespaces and a
// hand-moved clock. What it must prove:
//   · the address normal form is the kernel's, and storage names are a
//     domain-separated hash of it;
//   · every route of the first design (typed-code `bind.`, the signed and
//     typed-code deletions, the lookup) answers 410 for any method (a
//     preflight included) and body,
//     with the full header set, mailing nothing and storing nothing (G13);
//   · the object that held those bindings and its removal-code mail are gone;
//   · per-IP limits hold on the roster read; nothing raw is stored.

import worker, * as workerModule from '../server/directory/src/worker.js'
import { Ledger, LIMITS, RETIRED, Roster } from '../server/directory/src/worker.js'
import { addressKey, normalize } from '../server/directory/src/address.js'
import { MAIL_KINDS } from '../server/directory/src/mail.js'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0, passes = 0
const ok = (c: unknown, n: string) => { if (c) passes++; else { fails++; console.log('FAIL ' + n) } }

// ---------- clock ----------
let now = Date.parse('2026-10-18T09:00:00Z')
Date.now = () => now

// ---------- in-memory Durable Object namespaces ----------
const stores: Map<string, Map<string, unknown>>[] = []
function namespace(Klass: new (state: unknown, env: unknown) => { fetch(r: Request): Promise<Response> }) {
  const objs = new Map<string, { fetch(r: Request): Promise<Response> }>()
  const ns = {
    idFromName: (n: string) => n,
    get(id: string) {
      if (!objs.has(id)) {
        const store = new Map<string, unknown>()
        stores.push(new Map([[id, store]]))
        let alarm: number | null = null
        const state = {
          storage: {
            async get(k: string) { return structuredClone(store.get(k)) },
            async put(k: string, v: unknown) { store.set(k, structuredClone(v)) },
            async delete(k: string | string[]) { for (const x of [].concat(k as never)) store.delete(x) },
            async list(o?: { prefix?: string; limit?: number }) {
              const all = [...store].filter(([k]) => !o?.prefix || k.startsWith(o.prefix)).sort(([a], [b]) => (a < b ? -1 : 1))
              return new Map(all.slice(0, o?.limit ?? all.length))
            },
            async setAlarm(t: number) { alarm = t },
            async getAlarm() { return alarm },
          },
        }
        objs.set(id, new Klass(state, env))
      }
      const obj = objs.get(id)!
      // a real DO stub turns fetch(url, init) into a Request; so does this one
      return { fetch: (u: string | Request, init?: RequestInit) => obj.fetch(u instanceof Request ? u : new Request(u, init)) }
    },
  }
  return ns
}

// ---------- env + mail capture ----------
const mailbox: { to: string; body: string; kind: string }[] = []
const env: Record<string, unknown> = {
  DIR_KID: 'dir-1', DIR_PUBKEYS: '[]', CHALLENGE_KEY: 'k'.repeat(48),
  MAILER: { send: (m: { to: string; body: string; kind: string }) => { mailbox.push(m) } },
}
env.ROSTER = namespace(Roster as never)
env.LEDGER = namespace(Ledger as never)

let ipN = 0
const freshIp = () => `10.0.${Math.floor(++ipN / 250)}.${ipN % 250}`
async function api(method: string, path: string, body?: unknown, ip = freshIp()) {
  const r = await worker.fetch(new Request('https://id.bento.page' + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
  }), env as never)
  let j: Record<string, unknown> = {}
  try { j = await r.json() } catch { /* empty */ }
  return { status: r.status, j, h: r.headers }
}
const keysAtRest = () => stores.reduce((n, m) => n + [...m.values()].reduce((k, st) => k + st.size, 0), 0)

// =====================================================================
// address normalisation (provisional; kernel owns the reference + vectors)
// =====================================================================
const N: [string, string | null][] = [
  ['Alice@Example.COM', 'alice@example.com'], ['a.b+tag@gmail.com', 'a.b+tag@gmail.com'],
  ['  bob@x.org  ', 'bob@x.org'], ['x@xn--bcher-kva.example', 'x@xn--bcher-kva.example'],
  ['ü@x.de', null], ['a@bü.de', null], ['"q"@x.com', null], ['a(c)@x.com', null], ['a@[1.2.3.4]', null],
  ['a@1.2.3.4', null], ['a..b@x.com', null], ['.a@x.com', null], ['a@x', null], ['a@-x.com', null],
  ['a@x-.com', null], ['a b@x.com', null], ['a@b@x.com', null], ['x'.repeat(65) + '@x.com', null],
  ['a@' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(63) + '.' + 'e'.repeat(60) + '.com', null],
]
// the storage name is a domain-separated hash, pinned (a change orphans every stored address)
ok(await addressKey('alice@example.com') === '123c19c9631499522f93afd25daf131a98d5e7483bdba996c9db3fc973468494', 'addressKey: known answer for sha256("bento-dir/1/addr\\n" + address)')
for (const [i, want] of N) ok(normalize(i) === want, `normalize(${JSON.stringify(i).slice(0, 40)}) → ${want}`)

// =====================================================================
// the first design's routes: 410, whatever is sent, and nothing happens
// =====================================================================
{
  const WANT = ['/v1/bind/start', '/v1/bind/complete', '/v1/lookup', '/v1/delete', '/v1/delete/start', '/v1/delete/complete']
  ok(JSON.stringify(RETIRED) === JSON.stringify(WANT), `exactly the first design's six routes are retired (${RETIRED.join(', ')})`)
  // bodies in the shape each retired route accepted
  const e = 'rita@example.com'
  const bodies: Record<string, unknown> = {
    '/v1/bind/start': { stmt: 'bind.x', sig: 'AAAA' },
    '/v1/bind/complete': { email: e, code: 'ABCDEFGH', sig: 'AAAA' },
    '/v1/lookup': undefined,
    '/v1/delete': { email: e, ts: now, sig: 'AAAA' },
    '/v1/delete/start': { email: e },
    '/v1/delete/complete': { email: e, code: 'ABCDEFGH' },
  }
  const m0 = mailbox.length, k0 = keysAtRest()
  for (const path of WANT) {
    for (const method of ['GET', 'POST', 'PUT', 'OPTIONS']) {
      const q = path === '/v1/lookup' ? `${path}?e=${e}` : path
      const r = await api(method, q, method === 'GET' || method === 'OPTIONS' ? undefined : bodies[path] ?? {})
      ok(r.status === 410 && r.j.error === 'gone', `${method} ${q} → 410 gone (got ${r.status})`)
      ok(r.h.get('content-type') === 'application/json' && r.h.get('x-content-type-options') === 'nosniff' && r.h.get('x-frame-options') === 'DENY' &&
        /default-src 'none'/.test(r.h.get('content-security-policy') ?? '') && /publickey-credentials-get=\(\)/.test(r.h.get('permissions-policy') ?? '') &&
        r.h.get('access-control-allow-origin') === '*', `${method} ${q}: the full header set`)
    }
  }
  ok(mailbox.length === m0, 'the retired routes mailed nothing')
  ok(keysAtRest() === k0, `and stored nothing anywhere, not even a per-IP count (${keysAtRest() - k0} keys)`)
  // control: the same harness serves a live route, so the 410s above are the routes' own
  const c = await api('POST', '/v1/roster/challenge', { email: e })
  ok(c.status === 200 && typeof c.j.challenge === 'string', 'control: a live route answers 200 in the same harness')
  ok((await api('OPTIONS', '/v1/roster/request')).status === 204, 'control: a preflight on a live route still answers 204')
  ok((await api('GET', '/v1/lookupx')).status === 404 && (await api('POST', '/v1/delete/startx', {})).status === 404, 'control: a near miss of a retired path is an ordinary 404')

  // the object that held bindings, and its mail, are gone
  ok(!('Address' in workerModule), 'worker.js exports no Address object')
  const toml = readFileSync(join(root, 'server/directory/wrangler.toml'), 'utf8')
  ok(!/\bAddress\b|"ADDRESS"/.test(toml.replace(/^#.*$/gm, '')), 'wrangler.toml binds no Address object and no migration creates one')
  ok(/new_sqlite_classes = \["Ledger"\]/.test(toml) && /new_sqlite_classes = \["Roster"\]/.test(toml), 'control: the Ledger and Roster migrations are still there')
  ok(!Object.hasOwn(MAIL_KINDS, 'delete'), 'the removal-code mail kind is gone')
  const src = readdirSync(join(root, 'server/directory/src')).map((f) => readFileSync(join(root, 'server/directory/src', f), 'utf8')).join('\n')
  ok(!/deleteStart|deleteComplete|sendCode|mintCode|Your code/.test(src), 'no directory source mints, mails or checks a typed code')
}

// =====================================================================
// per-IP limits
// =====================================================================
{
  const ip = freshIp()
  let last = 0
  for (let i = 0; i <= LIMITS.ip.lookup; i++) last = (await api('GET', '/v1/roster?e=x@example.com', undefined, ip)).status
  ok(last === 429, `roster read #${LIMITS.ip.lookup + 1} from one IP in an hour → 429`)
  ok((await api('GET', '/v1/roster?e=x@example.com')).status === 404, 'control: from another IP it answers (404: no roster)')
}

// =====================================================================
// nothing identifying at rest
// =====================================================================
{
  const dump = JSON.stringify(stores.map((m) => [...m.entries()].map(([k, v]) => [k, [...(v as Map<string, unknown>).entries()]])))
  ok(!/@example\.com/.test(dump), 'no plaintext address anywhere in storage')
  ok(stores.every((m) => [...m.keys()].every((k) => k === 'ledger' || /^[0-9a-f]{64}$/.test(k))), 'every address object is named by a hash, never the address')
  ok(!/10\.0\.\d+\.\d+/.test(dump), 'no raw IP in storage')
}

// =====================================================================
// the kernel's address vectors, through the directory's normal form
// =====================================================================
const V = JSON.parse(readFileSync(new URL('../kernel/fixtures/identity-v1.json', import.meta.url), 'utf8'))
let nv = 0
for (const r of V.addresses) {
  const want = r.address ?? null
  ok(normalize(r.input) === want, `vector address ${JSON.stringify(r.input).slice(0, 40)} → ${want ?? r.reason}`)
  nv++
}
ok(nv >= 10, `the address vectors actually ran (${nv})`)

console.log(`${passes} passed, ${fails} failed`)
process.exit(fails)
