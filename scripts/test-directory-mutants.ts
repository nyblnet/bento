#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Mutation check for the directory (server/directory/src): the mail-budget
// rule (a start that mails nothing costs nothing), and the passkey roster store
// (the rp and origin constant, registration checks, the 72-hour queue, one
// change at a time, self-removal, the signature counter, setup tokens, roster
// mail, and the headers id.bento.page sends).
//
//   node scripts/test-directory-mutants.ts
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
const TREE = ['kernel/src', 'kernel/fixtures', 'server/directory/src', 'server/directory/fixtures']
let failures = 0, checks = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

type Edit = { from: string; to: string }
/** `also`: further edits in the same file, for a rule held at two doors */
type Mutant = Edit & { name: string; file: 'worker.js' | 'roster.js' | 'passkey.js'; also?: Edit[] }
/** the budget's one place in `start`: last, just before the code is minted */
const MAY_MAIL_LAST = "      if (!(await mayMail())) return out(202, { mail: null })\n      const code = mintCode()\n      await s.put('pend', { kind: 'bind',"
const MAIL_REMOVED = "      const code = mintCode()\n      await s.put('pend', { kind: 'bind',"
const MUTANTS: Mutant[] = [
  { name: 'start: budget spent first (before any refusal)', file: 'worker.js',
    from: MAY_MAIL_LAST, to: MAIL_REMOVED,
    also: [{ from: "    if (a.op === 'start') {\n", to: "    if (a.op === 'start') {\n      if (!(await mayMail())) return out(202, { mail: null })\n" }] },
  { name: 'start: budget spent before the live-key refusal', file: 'worker.js',
    from: MAY_MAIL_LAST, to: MAIL_REMOVED,
    also: [{ from: "      const live = await s.get('cur')\n      if (live && live.b.expires > now && live.b.key !== b.accountPub)",
      to: "      if (!(await mayMail())) return out(202, { mail: null })\n      const live = await s.get('cur')\n      if (live && live.b.expires > now && live.b.key !== b.accountPub)" }] },
  { name: 'start: budget never spent', file: 'worker.js',
    from: MAY_MAIL_LAST, to: MAIL_REMOVED },

  // --- the passkey roster ---
  ...['https://bento.page', 'https://home.bento.page', 'https://id.bento.page'].map((o): Mutant => ({
    name: `origins: ${o} accepted`, file: 'passkey.js',
    from: "    'https://signin.id.bento.page': 'browser',\n", to: `    'https://signin.id.bento.page': 'browser',\n    '${o}': 'browser',\n` })),
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
  { name: 'challenge: never recorded as spent', file: 'roster.js', from: '      list.push({ n: a.nonce, exp: a.issued + 10 * MIN })\n', to: '' },
  { name: 'setup: wrong tokens counted and the tokens burned at 5', file: 'roster.js',
    from: "      if (!live.some((t) => same(t.h, h))) return out(400, { error: 'token' })",
    to: "      if (!live.some((t) => same(t.h, h))) { const n = ((await s.get('tokFail')) || 0) + 1; await s.put('tokFail', n); if (n >= 5) await s.delete('setupTok'); return out(400, { error: 'token' }) }" },
  { name: 'setup start: a new token replaces the live ones', file: 'roster.js', from: "await s.put('setupTok', [...live, {", to: "await s.put('setupTok', [{" },
  { name: 'mail: the setup notice spends the stranger budget', file: 'roster.js',
    from: "      await notify(this.env, a.address, 'Your bento/id account was set up', [",
    to: "      await s.put('mail', [...((await s.get('mail')) || []), now])\n      await notify(this.env, a.address, 'Your bento/id account was set up', [" },
  { name: 'mail: a full stranger budget holds back the queued-change mail', file: 'roster.js',
    from: "      await notify(this.env, next.address, 'A change to your bento/id passkeys is waiting', [",
    to: "      if (((await s.get('mail')) || []).length < ROSTER_LIMITS.mailPerDay) await notify(this.env, next.address, 'A change to your bento/id passkeys is waiting', [" },
  { name: 'mail: the roster is left out', file: 'roster.js', from: '  const out = []\n  for (const m of members) {', to: '  const out = []\n  for (const m of []) {' },
  { name: 'headers: no Permissions-Policy', file: 'worker.js', from: "  'permissions-policy': 'publickey-credentials-get=(), publickey-credentials-create=()',\n", to: '' },
  { name: 'headers: no CSP', file: 'worker.js', from: "  'content-security-policy': \"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\",\n", to: '' },
  { name: 'headers: /.well-known/webauthn served', file: 'worker.js',
    from: "    if (req.method !== 'POST') return json(404, { error: 'not-found' })",
    to: "    if (p === '/.well-known/webauthn') return json(200, { origins: ['https://home.bento.page'] })\n    if (req.method !== 'POST') return json(404, { error: 'not-found' })" },
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
    return { f, passed: m ? Number(m[1]) : null, failed: m ? Number(m[2]) : null }
  })
}

console.log('positive control: the unmutated copy passes the rig')
{
  const d = tree()
  for (const r of run(d)) ok(r.failed === 0 && (r.passed ?? 0) > 0, `${r.f}: ${r.passed} passed, ${r.failed} failed`)
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${MUTANTS.length} mutants: every one must fail a row`)
for (const m of MUTANTS) {
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
