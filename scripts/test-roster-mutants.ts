#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Mutation check for the roster chain verifier (kernel/src/roster.ts).
//
//   node scripts/test-roster-mutants.ts
//
// Each mutant below removes or loosens ONE rule in a COPY of kernel/src, and
// scripts/test-roster.ts must then fail. The unmutated copy must pass first
// (positive control), and every mutant must apply to exactly one place in the
// source, so a refactor that moves the code makes this rig fail rather than
// pass vacuously.

import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0, checks = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

type Mutant = { name: string; from: string; to: string }
const del = (name: string, from: string): Mutant => ({ name, from, to: '' })
const MUTANTS: Mutant[] = [
  // the chain
  del('the prevHash link is not checked (chain break)', "    if (head.prev !== prev.hash) return no('chain')\n"),
  del('seq is not checked', "    if (head.seq !== prev.head.seq + 1) return no('seq')\n"),
  del('the address may change along the chain', "    if (head.address !== prev.head.address) return no('address')\n"),
  del('a change may be requested before the previous one ripened', "    if (rip.requestedAt < prev.rip.ripenedAt) return no('order')\n"),
  del('a chain need not start at setup', "        if (head.seq !== 0) return no('anchor')\n"),
  del('the pin is not compared', "        if (hash !== opts.pinned) return no('pin')\n"),
  { name: "the pinned head's countersign is not re-verified", from: '    const r = await verifyRip(l.rip, l.ripSig, { rosText: l.ros, directoryKeys: opts.directoryKeys, now: opts.now })\n',
    to: '    const r = i === 0 && opts.pinned !== undefined ? parseRip(l.rip) : await verifyRip(l.rip, l.ripSig, { rosText: l.ros, directoryKeys: opts.directoryKeys, now: opts.now })\n' },
  // the wait (G2: directory time, ripened only)
  { name: "the wait is measured from the REQUESTER's created", from: '    const waited = rip.ripenedAt - rip.requestedAt\n', to: '    const waited = rip.ripenedAt - head.created\n' },
  del('an unripened member change is accepted', "    if (!selfRemoval && waited < ROSTER_WAIT_MS) return no('unripe')\n"),
  { name: 'exactly 72 h is not enough (off by one)', from: "    if (!selfRemoval && waited < ROSTER_WAIT_MS) return no('unripe')\n", to: "    if (!selfRemoval && waited <= ROSTER_WAIT_MS) return no('unripe')\n" },
  { name: 'the wait is 71 hours', from: 'export const ROSTER_WAIT_MS = 72 * 3_600_000\n', to: 'export const ROSTER_WAIT_MS = 71 * 3_600_000\n' },
  del('a reset need not wait', "      if (waited < ROSTER_WAIT_MS) return no('unripe')\n"),
  { name: 'any single removal is immediate (not only of oneself)', from: '    const selfRemoval = added.length === 0 && removed[0].pub === signer.pub && ', to: '    const selfRemoval = added.length === 0 && ' },
  { name: 'the last unquarantined member may leave at once', from: ' && head.members.some((m) => !m.quarantined)\n', to: '\n' },
  // the countersign
  del('the countersign may name another head', "  if (r.value.rosHash !== (await sha256b64u(opts.rosText))) return no('rip-mismatch')\n"),
  del('the countersign signature is not verified', "  if (!(await verifyStatementSig(opts.directoryKeys[r.value.kid], sig, text))) return no('rip-signature')\n"),
  del('a countersign from the future is accepted', "  if (r.value.ripenedAt > opts.now + SKEW_MS) return no('not-yet-valid')\n"),
  { name: 'ripenedAt may precede requestedAt', from: ' || ripenedAt < requestedAt) return no', to: ') return no' },
  { name: 'reset may be any digit', from: "(resetF !== '0' && resetF !== '1')", to: "!/^[0-9]$/.test(resetF)" },
  // setup and reset
  del('setup may be countersigned as a reset', "        if (rip.reset) return no('reset')\n"),
  del('setup may carry a member proof', "        if (hasProof(l)) return no('proof')\n"),
  del('setup may have any members', "        if (!soleLivePk(head.members)) return no('setup-members')\n"),
  { name: 'a reset may carry a member proof', from: "      if (hasProof(l)) return no('proof')\n      if (!soleLivePk(head.members)) return no('reset-members')\n",
    to: "      if (!soleLivePk(head.members)) return no('reset-members')\n" },
  del('a reset may install any members', "      if (!soleLivePk(head.members)) return no('reset-members')\n"),
  { name: 'a sole member may be any kind', from: "list.length === 1 && list[0].kind === 'pk' && !list[0].quarantined", to: "list.length === 1 && !list[0].quarantined" },
  // the signer and its proof
  { name: 'the signer is looked up in the NEW head', from: '    const signer = prev.head.members.find((m) => m.pub === l.signer)\n', to: '    const signer = head.members.find((m) => m.pub === l.signer)\n' },
  del('a quarantined member may sign', "    if (signer.quarantined) return no('quarantined')\n"),
  del('a member change may lack a signer', "    if (typeof l.signer !== 'string') return no('proof')\n"),
  del('the passkey assertion is not verified', "      if (!a.ok) return no(`assertion-${a.reason}`)\n"),
  { name: 'the assertion covers the countersign, not the head', from: 'challenge: await statementChallenge(l.ros),', to: 'challenge: await statementChallenge(l.rip),' },
  { name: 'a passkey may carry two proofs', from: "      if (l.assertion === undefined || l.sig !== undefined) return no('proof')\n", to: "      if (l.assertion === undefined) return no('proof')\n" },
  del('the recovery-key signature is not verified', "      if (!(await verifyStatementSig(signer.pub, l.sig, l.ros))) return no('signature')\n"),
  { name: 'a recovery key may sign by assertion', from: "      if (l.sig === undefined || l.assertion !== undefined) return no('proof')\n", to: "      if (l.sig === undefined) return no('proof')\n" },
  { name: 'a consent key may sign alone', from: "    } else return no('signer-kind')", to: "    } else if (!(await verifyStatementSig(signer.pub, l.sig ?? '', l.ros))) return no('signature')" },
  // one change per link
  del('a member may change kind', "      if (was && was.kind !== m.kind) return no('members')\n"),
  del('quarantine marks may change', "      if (was ? was.quarantined !== m.quarantined : m.quarantined) return no('quarantine')\n"),
  { name: 'a member link may LIFT a quarantine', from: '      if (was ? was.quarantined !== m.quarantined : m.quarantined)', to: '      if (was ? (!was.quarantined && m.quarantined) : m.quarantined)' },
  del('a link may change nothing', "    if (added.length + removed.length === 0) return no('no-change')\n"),
  del('a link may make several changes', "    if (added.length > 1 || removed.length > 1) return no('multi-change')\n"),
  del('any key may be swapped in one link', "    if (added.length === 1 && removed.length === 1 && !(added[0].kind === 'rk' && removed[0].kind === 'rk')) return no('multi-change')\n"),
  // the ros. grammar
  del('members need not be sorted', "    if (i > 0 && cmp(tokens[i - 1], tokens[i]) >= 0) return no('members')   // strictly ascending\n"),
  del('a key may appear twice', "    if (pubs.has(t[1])) return no('members')\n"),
  del('several recovery keys', "  if (rk > 1) return no('members')\n"),
  { name: '17 members', from: 'export const MAX_MEMBERS = 16\n', to: 'export const MAX_MEMBERS = 17\n' },
  del('member keys are not checked', "  for (const m of members) if (!(await isSigningKey(m.pub))) return no('key')\n"),
  del('any kind word', "    if (!KINDS.includes(t[0])) return no('members')\n"),
  { name: 'any third field is a quarantine mark', from: "!(t.length === 3 && t[2] === 'q')", to: '!(t.length === 3)' },
  del('the directory nonce is not checked', "  if (!isNonce(dirNonce)) return no('grammar')\n"),
  del('seq 0 may carry a prevHash', "  if ((seq === 0) !== (prevF === '')) return no('prev')\n"),
  { name: 'the address need not be normal', from: '  if (address === null || !isNormalAddress(address)) return no(\'address\')\n', to: "  if (address === null) return no('address')\n" },
  // the outcome
  { name: "a continuing member's age restarts at every link", from: '    for (const m of head.members) next.set(m.pub, since.get(m.pub) ?? rip.ripenedAt)\n', to: '    for (const m of head.members) next.set(m.pub, rip.ripenedAt)\n' },
  { name: 'a reset keeps the old ages', from: '      lastResetAt = rip.ripenedAt\n      since = new Map(head.members.map((m) => [m.pub, rip.ripenedAt]))\n', to: '      lastResetAt = rip.ripenedAt\n' },
  del('a reset is not reported', '      lastResetAt = rip.ripenedAt\n'),
  del('a pin past setup still claims exact ages', '        else sinceExact = false\n'),
]

function tree(): string {
  const d = mkdtempSync(join(tmpdir(), 'roster-mutant-'))
  cpSync(join(root, 'kernel/src'), join(d, 'kernel/src'), { recursive: true })
  cpSync(join(root, 'kernel/fixtures'), join(d, 'kernel/fixtures'), { recursive: true })
  mkdirSync(join(d, 'scripts'))
  cpSync(join(root, 'scripts/test-roster.ts'), join(d, 'scripts/test-roster.ts'))
  return d
}
function run(d: string) {
  const r = spawnSync(process.execPath, [join(d, 'scripts/test-roster.ts')], { encoding: 'utf8' })
  const tail = (r.stdout.match(/\d+\/\d+ checks passed/g) ?? []).pop() ?? `(no count; exit ${r.status})`
  return { status: r.status, tail, fails: (r.stdout.match(/^ {2}FAIL/gm) ?? []).length }
}

console.log('positive control: the unmutated copy passes the rig')
{
  const d = tree()
  const r = run(d)
  ok(r.status === 0 && r.fails === 0, `test-roster.ts: ${r.tail}`)
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${MUTANTS.length} mutants, each one loosened rule: every one must turn the rig red`)
for (const m of MUTANTS) {
  const d = tree()
  const p = join(d, 'kernel/src/roster.ts')
  const src = readFileSync(p, 'utf8')
  const n = src.split(m.from).length - 1
  ok(n === 1, `applies exactly once: ${m.name} (found ${n})`)
  if (n === 1) {
    writeFileSync(p, src.replace(m.from, () => m.to))
    const r = run(d)
    ok(r.status !== 0 && r.fails > 0, `killed: ${m.name} — ${r.status === 0 ? 'green' : `${r.fails} FAIL`}`)
  }
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
