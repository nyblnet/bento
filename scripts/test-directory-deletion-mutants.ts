#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Mutation check for account deletion in the directory (server/directory/src
// deletion.js and its hooks in roster.js and worker.js), against
// scripts/test-directory-deletion.ts.
//
//   node scripts/test-directory-deletion-mutants.ts [name filter]
//
// Each mutant reopens one rule in a COPY of the tree; the deletion rig must then
// report a failed row. The unmutated copy passes first (positive control), every
// mutant applies to exactly one place, and a rig that crashes prints no count,
// which is not a kill. Its own file and CI step: the shared directory mutant job
// is near its time limit.

import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RIG = 'test-directory-deletion.ts'
const TREE = ['kernel/src', 'kernel/fixtures', 'server/directory/src', 'server/directory/fixtures', 'server/signin/public']
let failures = 0, checks = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

type Edit = { from: string; to: string }
type File = 'deletion.js' | 'roster.js' | 'worker.js' | '../../signin/public/account-client.js'
type Mutant = Edit & { name: string; file: File; also?: Array<Edit & { file?: File }> }
const MUTANTS: Mutant[] = [
  // the wait and the execution
  { name: 'no wait: the deletion ripens at once', file: 'deletion.js', from: 'requestedAt: now, ripensAt: now + DELETE_WAIT_MS,', to: 'requestedAt: now, ripensAt: now,',
    also: [{ from: ' || now < p.ripensAt || now - p.requestedAt < DELETE_WAIT_MS) return false', to: ') return false' }] },
  { name: 'executed without storing the record', file: 'deletion.js', from: "  await s.put('rdel', { ...rec, deletedAt: now })\n", to: '' },
  { name: 'executed without purging the account', file: 'deletion.js', from: "    const keys = [...(await s.list({ limit: 128 })).keys()].filter((k) => !keep.has(k))\n", to: '    const keys = []\n' },
  { name: 'the head is not re-checked at execution', file: 'deletion.js', from: '  if (!cur || cur.hash !== p.headHash) {', to: '  if (!cur) {' },
  { name: 'a deletion with no time is executed (Number(undefined) clock)', file: 'deletion.js',
    from: '  if (!Number.isSafeInteger(p.ripensAt) || !Number.isSafeInteger(p.requestedAt) || now < p.ripensAt || now - p.requestedAt < DELETE_WAIT_MS) return false\n', to: '' },
  { name: 'the deletion record is signed AFTER the purge (nothing is kept when the key is missing)', file: 'deletion.js',
    from: '  const rec = await signRecord(obj.env, {', to: "  for (const k of [...(await s.list({ limit: 128 })).keys()].filter((k) => k !== 'rdel')) await s.delete(k)\n  const rec = await signRecord(obj.env, {" },
  // D-A1
  { name: "D-A1: Cancel's cooldown for member changes only (main's rule)", file: 'roster.js',
    from: "        const until = kind === 'member' || kind === 'deletion' ? now + ROSTER_LIMITS.voidCooldownMs : null", to: "        const until = kind === 'member' ? now + ROSTER_LIMITS.voidCooldownMs : null" },
  { name: 'D-A1: the cooldown is not checked on a deletion request', file: 'deletion.js', from: "    if (coolUntil && coolUntil > now) return out(403, { error: 'cooldown', until: coolUntil })\n", to: '' },
  { name: 'D-A1: Remove offered to the only live member (link kind)', file: 'deletion.js',
    from: '    const vk = others ? DELETION_VOID_KINDS.remove : DELETION_VOID_KINDS.cancelOnly', to: '    const vk = DELETION_VOID_KINDS.remove' },
  { name: 'D-A1: Remove accepted for a cancel-only deletion link', file: 'roster.js',
    from: "p.voidKind === 'c' || p.voidKind === DELETION_VOID_KINDS.remove ? ['cancel', 'remove'] : ['cancel']", to: "p.voidKind === 'c' || p.voidKind === DELETION_VOID_KINDS.remove || p.voidKind === DELETION_VOID_KINDS.cancelOnly ? ['cancel', 'remove'] : ['cancel']",
    also: [{ from: "      if (!cur.members.some((m) => !m.quarantined && m.pub !== target)) return out(400, { error: 'choice' }) // never lock the person out (G4c)\n", to: '' }] },
  { name: 'D-A1: the q link stored without the voided adel.', file: 'roster.js',
    from: '        extra: { voided: { ros: p.ros, signer: target, ...(p.proof ?? { assertion: p.assertion }) } } })', to: '        extra: {} })' },
  // D-A2
  { name: 'D-A2: a reset sets a waiting deletion aside (a stopped reset revives it)', file: 'roster.js',
    from: "      const setAside = waiting && waiting.kind === 'removal' ? waiting : null", to: "      const setAside = waiting && (waiting.kind === 'removal' || waiting.kind === 'deletion') ? waiting : null" },
  // D-A3 and the request
  { name: 'D-A3: a deletion may be filed while a change (an undo window) waits', file: 'deletion.js', from: "    if (await s.get('pend')) return out(409, { error: 'pending' })\n", to: '' },
  { name: 'the challenge is spent before the grammar is read', file: 'deletion.js',
    from: "    if (typeof a.text !== 'string' || !parseAdel(a.text)) return out(400, { error: 'grammar' })\n    if (!(await spend())) return out(400, { error: 'nonce' })",
    to: "    if (!(await spend())) return out(400, { error: 'nonce' })\n    if (typeof a.text !== 'string' || !parseAdel(a.text)) return out(400, { error: 'grammar' })" },
  { name: 'an opener may cause a deletion (rq accepted)', file: 'deletion.js', from: "    if (a.rq !== undefined && a.rq !== '') return out(400, { error: 'rq' }) // an opener never causes a deletion\n", to: '' },
  { name: 'the counter is not checked', file: 'deletion.js', from: "      if ((count !== 0 || rec.signCount !== 0) && count <= rec.signCount) return out(400, { error: 'assertion-sign-count' })\n", to: '' },
  { name: 'the deletion challenge shares the roster audience', file: 'worker.js', from: "const DELETE_AUDIENCE = 'adel'", to: "const DELETE_AUDIENCE = 'roster'" },
  // the notice
  { name: 'queued before the notice was accepted (mailer down still queues)', file: 'deletion.js', from: "    await s.put('pend', { ...p, mailed: false })", to: "    await s.put('pend', { ...p, mailed: true })" },
  { name: 'G10: the notice spends the setup-mail budget', file: 'deletion.js',
    from: "    const sent = await h.notify(address, 'Your bento/id account is about to be DELETED', [", to: "    if (!(await obj.spendSetupBudget(now))) { await s.delete('pend'); return out(503, { error: 'mail' }) }\n    const sent = await h.notify(address, 'Your bento/id account is about to be DELETED', [" },
  // D-A4: what peers read after
  { name: 'D-A4: GET /v1/roster answers a bare 404 after a deletion', file: 'roster.js',
    from: "      if (!head) return deleted ? out(410, { error: 'deleted', deleted }) : out(404, { error: 'not-found' })", to: "      if (!head) return out(404, { error: 'not-found' })" },
  { name: "D-A4: a certificate's status after a deletion falls through to unknown", file: 'deletion.js',
    from: "    return pub ? null : h.out(200, { state: 'deleted', deleted: rec })", to: '    return null' },
  { name: 'D-A4: a check-in after a deletion falls through to unknown', file: 'deletion.js',
    from: "    return h.out(403, { error: 'deleted', deleted: rec })\n  }", to: '    return null\n  }',
    also: [{ from: "    if (!(await h.spend())) return h.out(400, { error: 'nonce' }) // spent first, as every check-in\n", to: '' }] },
  { name: "the sign-in host's adel. text drifts from the kernel's (address not base64url)", file: '../../signin/public/account-client.js',
    from: "  return ['adel', b64u(new TextEncoder().encode(address)), headHash, nonce].join('.')", to: "  return ['adel', address, headHash, nonce].join('.')" },
  { name: "F2: the deletion's void link answers unknown afterwards", file: 'deletion.js', from: "  await s.put('ended', [{ h: p.voidTok, why: 'deleted', at: now }])\n", to: '' },
  // security's round 1 on the route (M1, M2, N1-N4)
  { name: 'M1: the record is stored AFTER the purge', file: 'deletion.js',
    from: "  await s.put('rdel', { ...rec, deletedAt: now })\n  await obj.schedule(", to: '  await obj.schedule(',
    also: [{ from: "  await s.delete(['pend', 'head'])\n", to: "  await s.delete(['pend', 'head'])\n  await s.put('rdel', { ...rec, deletedAt: now })\n" }] },
  { name: 'M1: the waiting change and the head go in the first batch (a failed purge is never retried)', file: 'deletion.js',
    from: "  const keep = new Set(['rdel', 'pend', 'head'])", to: "  const keep = new Set(['rdel'])" },
  { name: 'M1: no alarm to retry a purge that failed part way', file: 'deletion.js', from: '  await obj.schedule(now + 60_000)', to: '  void 0' },
  { name: 'M2: a deletion may be asked under a hold', file: 'deletion.js', from: "    if (await obj.held(now)) return out(409, { error: 'pending' })\n", to: '' },
  { name: 'N2: an unsent waiting change does not block a deletion', file: 'deletion.js',
    from: "    if (await s.get('pend')) return out(409, { error: 'pending' })\n", to: "    if ((await s.get('pend'))?.mailed === true) return out(409, { error: 'pending' })\n" },
  { name: 'N3: an equal passkey counter is accepted', file: 'deletion.js', from: '&& count <= rec.signCount) return', to: '&& count < rec.signCount) return' },
  { name: 'N3: a check-in for a deleted account does not spend its nonce', file: 'deletion.js',
    from: "    if (!(await h.spend())) return h.out(400, { error: 'nonce' }) // spent first, as every check-in\n", to: '' },
  { name: "N1: Remove for a recovery-key asker stores main's assertion-only evidence", file: 'roster.js',
    from: 'signer: target, ...(p.proof ?? { assertion: p.assertion }) } } })', to: 'signer: target, assertion: p.assertion } } })' },
  { name: 'N4: the suspension notice calls every asker a passkey', file: 'roster.js',
    from: "        `That ${kind === 'deletion' && p.signerKind && p.signerKind !== 'pk' ? 'key' : 'passkey'} can no longer be used.", to: '        `That passkey can no longer be used.' },
]

function tree(): string {
  const d = mkdtempSync(join(tmpdir(), 'dir-deletion-mutant-'))
  for (const t of TREE) cpSync(join(root, t), join(d, t), { recursive: true })
  mkdirSync(join(d, 'scripts'))
  cpSync(join(root, 'scripts', RIG), join(d, 'scripts', RIG))
  return d
}
function run(d: string): Promise<{ passed: number | null; failed: number | null }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [join(d, 'scripts', RIG)])
    let out = ''
    c.stdout.on('data', (x) => { out += x })
    c.stderr.on('data', () => { /* a crash shows as no count */ })
    const t = setTimeout(() => c.kill('SIGKILL'), 120_000)
    c.on('close', () => {
      clearTimeout(t)
      const m = /^(\d+) passed, (\d+) failed$/m.exec(out)
      resolve({ passed: m ? Number(m[1]) : null, failed: m ? Number(m[2]) : null })
    })
  })
}

console.log('positive control: the unmutated copy passes the rig')
{
  const d = tree()
  const r = await run(d)
  ok(r.failed === 0 && (r.passed ?? 0) > 0, `${RIG}: ${r.passed} passed, ${r.failed} failed`)
  rmSync(d, { recursive: true, force: true })
}

const only = process.argv[2]
const chosen = only ? MUTANTS.filter((m) => m.name.includes(only)) : MUTANTS
console.log(`\n${chosen.length} mutants: every one must fail a row`)
for (const m of chosen) {
  const d = tree()
  const edits = [{ ...m }, ...(m.also ?? []).map((e) => ({ ...e, file: e.file ?? m.file }))]
  const srcs = new Map<string, string>()
  for (const e of edits) { const p = join(d, 'server/directory/src', e.file); if (!srcs.has(p)) srcs.set(p, readFileSync(p, 'utf8')) }
  const counts = edits.map((e) => srcs.get(join(d, 'server/directory/src', e.file))!.split(e.from).length - 1)
  ok(counts.every((n) => n === 1), `applies exactly once: ${m.name} (found ${counts.join(', ')})`)
  if (counts.every((n) => n === 1)) {
    for (const e of edits) { const p = join(d, 'server/directory/src', e.file); srcs.set(p, srcs.get(p)!.replace(e.from, () => e.to)) }
    for (const [p, t] of srcs) writeFileSync(p, t)
    const r = await run(d)
    ok(r.failed !== null && r.failed > 0, `killed: ${m.name} (${r.failed === null ? 'CRASHED' : `${r.failed} failed`})`)
  }
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
