#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Mutation check for the directory (server/directory/src): the retired routes
// of the first design, the top-level error answer, and the passkey roster store (the rp and origin
// constant, registration checks, the 72-hour queue, one change at a time,
// self-removal, the signature counter, setup tokens, the waiting notice that
// gates a change, spent challenges, the log, roster mail, and the headers
// id.bento.page sends).
//
//   node scripts/test-directory-mutants.ts [name filter]
//
// Each mutant below reopens one path into a COPY of the tree, and the directory
// rig must then report a failed row. The unmutated copy must pass first
// (positive control), every mutant must apply to exactly one place, so a refactor
// that moves the code turns this rig red rather than letting it pass vacuously, and
// a rig that crashes prints no count, which is not a kill.

import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RIGS = ['test-directory.ts', 'test-directory-roster.ts']
const TREE = ['kernel/src', 'kernel/fixtures', 'server/directory/src', 'server/directory/fixtures', 'server/directory/wrangler.toml']
let failures = 0, checks = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

type Edit = { from: string; to: string }
/** `also`: further edits in the same file, for a rule held at two doors */
type Mutant = Edit & { name: string; file: 'worker.js' | 'roster.js' | 'passkey.js' | 'links.js' | 'mail.js'; also?: Edit[] }
const MUTANTS: Mutant[] = [
  // --- the first design's routes, retired ---
  { name: 'retired routes served again (fall through)', file: 'worker.js',
    from: "  if (RETIRED.includes(p)) return json(410, { error: 'gone' })\n", to: '' },
  { name: 'retired: /v1/lookup left out of the list', file: 'worker.js', from: "'/v1/bind/complete', '/v1/lookup', ", to: "'/v1/bind/complete', " },
  { name: 'retired: /v1/delete/start left out of the list', file: 'worker.js', from: "'/v1/delete', '/v1/delete/start', ", to: "'/v1/delete', " },
  { name: 'D3: no top-level catch', file: 'worker.js',
    from: "    try {\n      return await route(req, env)\n    } catch (e) {\n      console.log(`directory error: ${e && e.message}`)\n      let path = ''\n      try { path = new URL(req.url).pathname } catch { /* the base headers */ }\n      return json(500, { error: 'internal' }, headersFor(path))\n    }",
    to: '    return await route(req, env)' },

  // --- the passkey roster ---
  ...['https://bento.page', 'https://home.bento.page', 'https://id.bento.page'].map((o): Mutant => ({
    name: `origins: ${o} accepted`, file: 'passkey.js',
    from: "    [SIGNIN_ORIGIN]: 'browser',\n", to: `    [SIGNIN_ORIGIN]: 'browser',\n    '${o}': 'browser',\n` })),
  { name: 'rp id: the parent bento.page', file: 'passkey.js', from: "  rpId: 'id.bento.page',", to: "  rpId: 'bento.page'," },
  { name: 'registration: any algorithm', file: 'passkey.js', from: "  if (key.get(3) !== ES256) return no('alg')\n", to: '' },
  { name: 'registration: UV not required', file: 'passkey.js', from: "  if (!(flags & FLAG_UV)) return no('uv')\n  if (!(flags & FLAG_AT))", to: "  if (!(flags & FLAG_AT))" },
  { name: 'registration: cross-origin accepted', file: 'passkey.js',
    from: "  if (cd.has('crossOrigin') && cd.get('crossOrigin') !== false) return no('cross-origin')\n  if (cd.has('topOrigin')) return no('cross-origin')\n\n  if (!same(ad.subarray(0, 32)",
    to: "\n  if (!same(ad.subarray(0, 32)" },
  { name: 'registration: JSON.parse (duplicate keys pass)', file: 'passkey.js',
    from: "  const cd = parseStrictJson(text)\n  if (cd === 'duplicate') return no('duplicate-key')\n  if (!(cd instanceof Map)) return no('grammar')\n  if (cd.get('type') !== 'webauthn.create')",
    to: "  const cd = new Map(Object.entries(JSON.parse(text)))\n  if (cd.get('type') !== 'webauthn.create')" },
  { name: 'registration: challenge not compared', file: 'passkey.js',
    from: "  if (!chBytes || !same(chBytes, challenge)) return no('challenge')\n  const origin = cd.get('origin')\n  if (typeof origin !== 'string' || !Object.hasOwn(PASSKEY.origins",
    to: "  if (!chBytes) return no('challenge')\n  const origin = cd.get('origin')\n  if (typeof origin !== 'string' || !Object.hasOwn(PASSKEY.origins" },
  { name: 'request: no stored signature counter', file: 'roster.js', from: 'storedSignCount: rec.signCount', to: 'storedSignCount: undefined' },
  { name: 'request: a second change while one waits', file: 'roster.js', from: "      if (await s.get('pend')) return out(409, { error: 'pending' })\n", to: '' },
  { name: 'request: wait from the requester\'s created', file: 'roster.js', from: 'ripensAt: now + ROSTER_WAIT_MS', to: 'ripensAt: next.created + ROSTER_WAIT_MS' },
  { name: 'request: self-removal immediate while any member stays', file: 'roster.js',
    from: "next.members.some((m) => m.kind === 'pk' && !m.quarantined)", to: 'next.members.length > 0' },
  { name: 'request: a quarantined member may ask', file: 'roster.js', from: "      if (signer.quarantined) return out(403, { error: 'quarantined' })\n", to: '' },
  { name: 'request: the requester may set quarantine marks', file: 'roster.js',
    from: "        if (w ? w.quarantined !== m.quarantined : m.quarantined) return out(400, { error: 'quarantine' })\n", to: '' },
  { name: 'request: an add and a removal in one', file: 'roster.js', from: 'if (added.length + removed.length !== 1)', to: 'if (added.length + removed.length === 0)' },
  { name: 'request: any opener accepted', file: 'roster.js', from: "      if (a.rq !== undefined && a.rq !== '' && !REQUESTERS.includes(a.rq)) return out(400, { error: 'rq' })\n", to: '' },
  { name: 'challenge: never recorded as spent', file: 'roster.js', from: '      await s.put(key, 1)\n', to: '' },
  { name: 'D2: spent challenges never swept by a spend', file: 'roster.js', from: '      if (dead.length) await s.delete(dead)\n      await this.schedule', to: '      await this.schedule' },
  { name: 'D2: spent challenges kept in one growing value', file: 'roster.js',
    from: "      const key = `spent:${String(a.issued).padStart(16, '0')}:${a.nonce}`\n      if (await s.get(key)) return false\n      await s.put(key, 1)\n      const oldest = await s.list({ prefix: 'spent:', limit: ROSTER_LIMITS.spentSweep })\n      const dead = [...oldest.keys()].filter((k) => spentUntil(k) <= now)\n      if (dead.length) await s.delete(dead)\n      await this.schedule(spentUntil(key)) // and the alarm sweeps whatever later spends leave behind\n",
    to: "      const list = ((await s.get('spent')) || []).filter((x) => x.exp > now)\n      if (list.some((x) => x.n === a.nonce)) return false\n      list.push({ n: a.nonce, exp: a.issued + ROSTER_LIMITS.spentKeepMs })\n      await s.put('spent', list)\n" },
  { name: 'D1: the waiting mail\'s failure ignored (202 anyway)', file: 'roster.js',
    from: "      if (!sent) {\n        if (await ours()) await s.delete('pend')\n        return out(503, { error: 'mail' })\n      }\n", to: '' },
  // D1a: what follows a send touches the stored change only if it is still this request's
  { name: 'D1a: the success write is unconditional', file: 'roster.js', from: "      if (!(await ours())) return out(409, { error: 'superseded' })\n", to: '' },
  { name: 'D1a: the failure clean-up is unconditional', file: 'roster.js', from: "        if (await ours()) await s.delete('pend')", to: "        await s.delete('pend')" },
  { name: 'D1a: any stored change counts as ours', file: 'roster.js',
    from: "        return !!q && q.mailed === false && q.ros === p.ros && q.requestedAt === p.requestedAt", to: '        return !!q' },
  { name: 'D1a: no mailer timeout', file: 'mail.js', from: '  return timed(send(env, msg))', to: '  return send(env, msg)' },
  { name: 'D1a: a 10-minute mailer timeout', file: 'mail.js', from: 'export const MAIL_TIMEOUT_MS = 30_000', to: 'export const MAIL_TIMEOUT_MS = 10 * 60_000' },
  // the alarm sweeps spent challenges
  { name: 'sweep: a spend arms no alarm', file: 'roster.js', from: '      await this.schedule(spentUntil(key)) // and the alarm', to: '      // and the alarm' },
  { name: 'sweep: the alarm sweeps nothing', file: 'roster.js', from: '    await this.ripen(now)\n    await this.sweepSpent(now)\n', to: '    await this.ripen(now)\n' },
  { name: 'sweep: one batch only', file: 'roster.js', from: '      if (dead.length < keys.length || keys.length < 128) return', to: '      return' },
  { name: 'alarm: a later time pushes an earlier alarm back', file: 'roster.js', from: '    if (at === null || at === undefined || at > t) await s.setAlarm(t)', to: '    await s.setAlarm(t)' },
  { name: 'D1: an unnotified change ripens', file: 'roster.js',
    from: "    if (p.mailed !== true) {\n      if (now - p.requestedAt >= ROSTER_LIMITS.unsentDropMs) await s.delete('pend')\n      return\n    }\n", to: '' },
  { name: 'D1: an unnotified change never frees its slot', file: 'roster.js',
    from: "      if (now - p.requestedAt >= ROSTER_LIMITS.unsentDropMs) await s.delete('pend')\n", to: '' },
  { name: 'log: the 8-hex fingerprint instead of the full key', file: 'roster.js',
    from: "      await this.log({ k: 'request', at: now, seq: next.seq, op: change.op, pub: change.pub, by: signer.pub,",
    to: "      await this.log({ k: 'request', at: now, seq: next.seq, op: change.op, fp: await fingerprint(change.pub), pub: undefined, by: signer.pub," },
  // setup links (G13), S1, S2
  { name: 'X35 setup start: mails a link while a roster exists', file: 'roster.js',
    from: "      if (await s.get('head')) return out(202, { mailed: false }) // taken", to: '      // taken' },
  { name: 'S1: a full budget holds the mail back with no live link', file: 'roster.js',
    from: "      if (!spent && live.some((t) => t.mailed)) return out(202, { mailed: false })", to: "      if (!spent) return out(202, { mailed: false })" },
  { name: 'S1: an unsent link counts as live', file: 'roster.js',
    from: "      if (!spent && live.some((t) => t.mailed)) return out(202, { mailed: false })", to: "      if (!spent && live.length) return out(202, { mailed: false })" },
  { name: 'S1: an unsent link is not withdrawn', file: 'roster.js', from: ' : after.filter((t) => t.h !== h))', to: ' : after)' },
  // S1′ and the pinned link lives (Y35)
  { name: 'S1′: a link beyond the budget lives 20 minutes', file: 'roster.js',
    from: '      const exp = now + (spent ? ROSTER_LIMITS.setupTtlMs : ROSTER_LIMITS.setupBeyondTtlMs)', to: '      const exp = now + ROSTER_LIMITS.setupTtlMs' },
  { name: 'S1′: every link lives a day', file: 'roster.js',
    from: '      const exp = now + (spent ? ROSTER_LIMITS.setupTtlMs : ROSTER_LIMITS.setupBeyondTtlMs)', to: '      const exp = now + ROSTER_LIMITS.setupBeyondTtlMs' },
  { name: 'Y35: the setup link lives 31 days', file: 'roster.js', from: '  setupTtlMs: 20 * MIN,', to: '  setupTtlMs: 31 * DAY,' },
  { name: 'Y35: the beyond-budget link lives 31 days', file: 'roster.js', from: '  setupBeyondTtlMs: DAY,', to: '  setupBeyondTtlMs: 31 * DAY,' },
  { name: 'S1′: the mail states another expiry', file: 'roster.js', from: '    `The link works once, until ${when(exp)}.`,', to: '    `The link works once, until ${when(now + ROSTER_LIMITS.setupTtlMs)}.`,' },
  // Y16: setup/start's answer says nothing
  { name: 'Y16: setup start passes on the object\'s answer', file: 'worker.js',
    from: "    await call(await rosterStub(env, email), 'setupStart', { address: email })\n    return json(202, SETUP_STARTED)",
    to: "    const r = await call(await rosterStub(env, email), 'setupStart', { address: email })\n    return json(202, { ...SETUP_STARTED, ...r.body })" },
  { name: 'Y16: the per-IP limit answers differently', file: 'worker.js',
    from: "    if (!(await ledger(env, ip, 'setup'))) return json(202, SETUP_STARTED)", to: "    if (!(await ledger(env, ip, 'setup'))) return json(202, { ok: true, limited: true })" },
  { name: 'setup start: no per-IP limit', file: 'worker.js', from: "    if (!(await ledger(env, ip, 'setup'))) return json(202, SETUP_STARTED)\n", to: '' },
  { name: 'link: the token in the query', file: 'links.js',
    from: "  return `${SIGNIN_ORIGIN}${SIGNIN_PATHS.setup}#${f.toString()}`", to: "  return `${SIGNIN_ORIGIN}${SIGNIN_PATHS.setup}?${f.toString()}`" },
  { name: 'link: pointed at the directory', file: 'links.js',
    from: "  return `${SIGNIN_ORIGIN}${SIGNIN_PATHS.setup}#${f.toString()}`", to: "  return `https://id.bento.page${SIGNIN_PATHS.setup}#${f.toString()}`" },
  { name: 'link: parse accepts an extra key', file: 'links.js', from: 'if (keys.length !== 3 || ', to: 'if (' },
  { name: 'S2: the queued-change mail reads the setup budget', file: 'roster.js',
    from: "      const sent = await notify(this.env, next.address, 'A change to your bento/id passkeys is waiting', [",
    to: "      const sent = (await this.spendSetupBudget(now), true) && await notify(this.env, next.address, 'A change to your bento/id passkeys is waiting', [" },
  { name: 'S2: reset mail classed as budgeted', file: 'mail.js', from: "  reset: 'never',", to: "  reset: 'budget'," },
  { name: 'S2: an undeclared mail kind delivered', file: 'mail.js',
    from: "  if (!msg || !Object.hasOwn(MAIL_KINDS, msg.kind)) throw new Error(`undeclared mail kind: ${msg && msg.kind}`)\n", to: '' },
  // the sign-in host's routes
  { name: 'worker.js exports a string (the runtime refuses to start)', file: 'worker.js',
    from: 'export const RETIRED = Object.freeze([\n', to: "export const WEB_PREFIX = '/v1/web/'\nexport const RETIRED = Object.freeze([\n" },
  { name: 'Y26: a web-route 500 answers *', file: 'worker.js',
    from: "      return json(500, { error: 'internal' }, headersFor(path))", to: "      return json(500, { error: 'internal' })" },
  { name: 'Y31: enrol not limited per IP', file: 'worker.js', from: "    if (!(await ledger(env, ip, 'enrol'))) return json(429, { error: 'rate-limited' }, H)\n", to: '' },
  { name: 'web: CORS * on the web routes', file: 'worker.js',
    from: "const WEB = { ...BASE, 'access-control-allow-origin': SIGNIN_ORIGIN, vary: 'Origin' }", to: 'const WEB = BASE' },
  { name: 'web: any opener accepted', file: 'worker.js', from: "  if (!REQUESTERS.includes(b.rq)) return json(400, { error: 'rq' }, H)\n", to: '' },
  { name: 'web: any text accepted', file: 'worker.js', from: "typeof b.text !== 'string' || !b.text.startsWith('wdev.') || b.text.length > TEXT_MAX", to: "typeof b.text !== 'string'" },
  { name: 'web: assertion fields not checked', file: 'worker.js',
    from: "!['id', 'authenticatorData', 'clientDataJSON', 'signature'].every((k) => field(as[k]))", to: 'false' },
  { name: 'web: the challenge shares the roster audience and scope', file: 'worker.js',
    from: "const WEB_AUDIENCE = 'web'", to: "const WEB_AUDIENCE = 'roster'" },
  // security's C1 (#926 X1, X13, X22, X31)
  { name: 'X1 CBOR: a repeated map key allowed', file: 'passkey.js', from: "        if (out.has(key)) throw new Bad()\n", to: '' },
  { name: 'X13 registration: origin matched by prefix', file: 'passkey.js',
    from: "!Object.hasOwn(PASSKEY.origins, origin)", to: "!Object.keys(PASSKEY.origins).some((o) => origin.startsWith(o))" },
  { name: 'X22 request: the address not checked', file: 'roster.js',
    from: "      if (next.address !== before.value.address) return out(400, { error: 'address' })\n", to: '' },
  { name: 'X31 setup: expired tokens accepted', file: 'roster.js',
    from: "      const live = ((await s.get('setupTok')) || []).filter((t) => t.exp > now)\n      // no attempt",
    to: "      const live = ((await s.get('setupTok')) || [])\n      // no attempt" },
  { name: 'setup: wrong tokens counted and the tokens burned at 5', file: 'roster.js',
    from: "      if (!live.some((t) => same(t.h, h))) return out(400, { error: 'token' })",
    to: "      if (!live.some((t) => same(t.h, h))) { const n = ((await s.get('tokFail')) || 0) + 1; await s.put('tokFail', n); if (n >= 5) await s.delete('setupTok'); return out(400, { error: 'token' }) }" },
  { name: 'setup start: a new token replaces the live ones', file: 'roster.js', from: "await s.put('setupTok', [...live, {", to: "await s.put('setupTok', [{" },
  { name: 'mail: the setup notice spends the stranger budget', file: 'roster.js',
    from: "      await notify(this.env, a.address, 'Your bento/id account was set up', [",
    to: "      await s.put('mail', [...((await s.get('mail')) || []), now])\n      await notify(this.env, a.address, 'Your bento/id account was set up', [" },
  { name: 'mail: a full stranger budget holds back the queued-change mail', file: 'roster.js',
    from: "      const sent = await notify(this.env, next.address, 'A change to your bento/id passkeys is waiting', [",
    to: "      const sent = ((await s.get('mail')) || []).length >= ROSTER_LIMITS.mailPerDay || await notify(this.env, next.address, 'A change to your bento/id passkeys is waiting', [" },
  { name: 'mail: the roster is left out', file: 'roster.js', from: '  const out = []\n  for (const m of members) {', to: '  const out = []\n  for (const m of []) {' },
  { name: 'headers: no Permissions-Policy', file: 'worker.js', from: "  'permissions-policy': 'publickey-credentials-get=(), publickey-credentials-create=()',\n", to: '' },
  { name: 'headers: no CSP', file: 'worker.js', from: "  'content-security-policy': \"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\",\n", to: '' },
  { name: 'headers: /.well-known/webauthn served', file: 'worker.js',
    from: "  if (req.method !== 'POST') return json(404, { error: 'not-found' }, headersFor(p))",
    to: "  if (p === '/.well-known/webauthn') return json(200, { origins: ['https://home.bento.page'] })\n  if (req.method !== 'POST') return json(404, { error: 'not-found' }, headersFor(p))" },
]

function tree(): string {
  const d = mkdtempSync(join(tmpdir(), 'directory-mutant-'))
  for (const p of TREE) cpSync(join(root, p), join(d, p), { recursive: true })
  mkdirSync(join(d, 'scripts'))
  for (const f of RIGS) cpSync(join(root, 'scripts', f), join(d, 'scripts', f))
  return d
}
/** Run the rigs in a tree; a rig with no count line crashed, and proves nothing. */
function run(d: string) {
  return RIGS.map((f) => {
    const r = spawnSync(process.execPath, [join(d, 'scripts', f)], { encoding: 'utf8', timeout: 120_000 })
    const m = /^(\d+) passed, (\d+) failed$/m.exec(r.stdout)
    // a crash proves nothing, so say where it happened
    if (!m) console.log(`        ${f} crashed: ${(r.stderr || '').split('\n').filter((l) => /Error|at file:/.test(l)).slice(0, 2).join(' | ').slice(0, 300)}`)
    return { f, passed: m ? Number(m[1]) : null, failed: m ? Number(m[2]) : null }
  })
}

console.log('positive control: the unmutated copy passes the rig')
{
  const d = tree()
  for (const r of run(d)) ok(r.failed === 0 && (r.passed ?? 0) > 0, `${r.f}: ${r.passed} passed, ${r.failed} failed`)
  rmSync(d, { recursive: true, force: true })
}

const only = process.argv[2]
const chosen = only ? MUTANTS.filter((m) => m.name.includes(only)) : MUTANTS
console.log(`\n${chosen.length} mutants: every one must fail a row`)
for (const m of chosen) {
  const d = tree()
  const p = join(d, 'server/directory/src', m.file)
  const src = readFileSync(p, 'utf8')
  const edits: Edit[] = [m, ...(m.also ?? [])]
  const ns = edits.map((e) => src.split(e.from).length - 1)
  const n = ns.every((x) => x === 1) ? 1 : 0
  ok(n === 1, `applies exactly once: ${m.name} (found ${ns.join(', ')})`)
  if (n === 1) {
    writeFileSync(p, edits.reduce((t, e) => t.replace(e.from, () => e.to), src))
    const rs = run(d)
    ok(rs.every((r) => r.failed !== null) && rs.some((r) => r.failed! > 0), `killed: ${m.name} (${rs.map((r) => `${r.f} ${r.failed === null ? 'CRASHED' : `${r.failed} failed`}`).join(', ')})`)
  }
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
