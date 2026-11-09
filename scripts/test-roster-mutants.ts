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

type Mutant = { name: string; from: string; to: string; and?: Array<[string, string]> }
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
  { name: 'a reset need not wait', from: "      if (!soleLivePk(head.members)) return no('reset-members')\n      if (waited < ROSTER_WAIT_MS) return no('unripe')\n",
    to: "      if (!soleLivePk(head.members)) return no('reset-members')\n" },
  { name: 'any single removal is immediate (not only of oneself)', from: '    const selfRemoval = added.length === 0 && removed[0].pub === signer.pub && ', to: '    const selfRemoval = added.length === 0 && ' },
  { name: 'the last unquarantined member may leave at once', from: ' && head.members.some((m) => !m.quarantined)\n', to: '\n' },
  // the countersign
  del('the countersign may name another head', "  if (r.value.rosHash !== (await sha256b64u(opts.rosText))) return no('rip-mismatch')\n"),
  del('the countersign signature is not verified', "  if (!(await verifyStatementSig(opts.directoryKeys[r.value.kid], sig, text))) return no('rip-signature')\n"),
  del('a countersign from the future is accepted', "  if (r.value.ripenedAt > opts.now + SKEW_MS) return no('not-yet-valid')\n"),
  { name: 'ripenedAt may precede requestedAt', from: ' || ripenedAt < requestedAt) return no', to: ') return no' },
  { name: 'any authority word', from: ' || !AUTHORITIES.includes(auth)) return no', to: ') return no' },
  del('the cause field is not checked against the word', "  if (CAUSELESS.includes(auth) ? causeF !== '' : !isHash(causeF)) return no('rip-grammar')\n"),
  // setup and reset
  del('setup may be countersigned under any word', "        if (rip.auth !== 'm') return no('auth')\n"),
  del('setup may carry a member proof', "        if (hasProof(l) || carries(l)) return no('proof')\n"),
  del('setup may have any members', "        if (!soleLivePk(head.members)) return no('setup-members')\n"),
  { name: 'a reset may carry a member proof', from: "      if (hasProof(l) || carries(l)) return no('proof')\n      if (!soleLivePk(head.members)) return no('reset-members')\n",
    to: "      if (!soleLivePk(head.members)) return no('reset-members')\n" },
  del('a reset may install any members', "      if (!soleLivePk(head.members)) return no('reset-members')\n"),
  { name: 'a sole member may be any kind', from: "list.length === 1 && list[0].kind === 'pk' && !list[0].quarantined", to: "list.length === 1 && !list[0].quarantined" },
  // the signer and its proof
  { name: 'the signer is looked up in the NEW head', from: '    const signer = prev.head.members.find((m) => m.pub === l.signer)\n', to: '    const signer = head.members.find((m) => m.pub === l.signer)\n' },
  del('a quarantined member may sign', "    if (signer.quarantined) return no('quarantined')\n"),
  del('a member change may lack a signer', "    if (typeof l.signer !== 'string') return no('proof')\n"),
  del('the passkey assertion is not verified', "    if (!a.ok) return no(`assertion-${a.reason}`)\n"),
  { name: 'the member proof covers the countersign, not the head', from: '    const pr = await memberProof(signer, l, l.ros, opts)\n', to: '    const pr = await memberProof(signer, l, l.rip, opts)\n' },
  { name: 'a passkey may carry two proofs', from: "    if (p.assertion === undefined || p.sig !== undefined) return no('proof')\n", to: "    if (p.assertion === undefined) return no('proof')\n" },
  del('the recovery-key signature is not verified', "    if (!(await verifyStatementSig(signer.pub, p.sig, text))) return no('signature')\n"),
  { name: 'a recovery key may sign by assertion', from: "    if (!str(p.sig) || p.assertion !== undefined) return no('proof')\n", to: "    if (!str(p.sig)) return no('proof')\n" },
  { name: 'a consent key may sign alone', from: "  } else return no('signer-kind')", to: "  } else if (!(await verifyStatementSig(signer.pub, p.sig ?? '', text))) return no('signature')" },
  // security's mutants from the review of the first roster change (C1)
  { name: 'X5 the countersign kid is ignored: any pinned key verifies',
    from: "  if (!Object.hasOwn(opts.directoryKeys, r.value.kid)) return no('unknown-kid')\n  if (!(await verifyStatementSig(opts.directoryKeys[r.value.kid], sig, text))) return no('rip-signature')\n",
    to: "  let any = false\n  for (const k of Object.values(opts.directoryKeys)) if (await verifyStatementSig(k, sig, text)) any = true\n  if (!any) return no('rip-signature')\n" },
  { name: 'X7 a re-added member keeps its OLD since', from: '    const next = new Map<string, number>()\n', to: '    const next = new Map<string, number>(since)\n' },
  { name: 'X8 a change requested exactly when the previous one ripened is refused', from: 'if (rip.requestedAt < prev.rip.ripenedAt)', to: 'if (rip.requestedAt <= prev.rip.ripenedAt)' },
  { name: "X15 a reset's prevHash is not checked", from: "    if (head.prev !== prev.hash) return no('chain')\n", to: "    if (head.prev !== prev.hash && rip.auth !== 'r') return no('chain')\n" },
  { name: 'X16b sign counts tracked per signer along the chain',
    from: '    const a = await verifyAssertion(p.assertion, { publicKey: signer.pub,',
    to: '    const a = await verifyAssertion(p.assertion, { storedSignCount: (globalThis as any).__c.get(signer.pub), publicKey: signer.pub,',
    and: [["    if (!a.ok) return no(`assertion-${a.reason}`)\n", "    if (!a.ok) return no(`assertion-${a.reason}`)\n    ;(globalThis as any).__c.set(signer.pub, a.value.signCount)\n"],
      ['  let sinceExact = true\n', '  let sinceExact = true\n  ;(globalThis as any).__c = new Map()\n']] },
  // the directory's acts: q l x u (C2)
  { name: 'a directory word is read as a member change', from: "    if (rip.auth !== 'm') {\n", to: '    if (false) {\n' },
  { name: 'a directory act may carry a member proof', from: "      if (hasProof(l)) return no('proof')\n      const d = diffOf", to: '      const d = diffOf' },
  del('a directory act may change a kind', "      if (d.kindChanged) return no('members')\n"),
  del('a quarantine may carry a citation', "        if (l.cited !== undefined) return no('proof')\n"),
  del('a quarantine need not cite the voided request', "        if (rip.cause !== (await sha256b64u(v.ros))) return no('cause')\n"),
  del('the voided request may name any previous head', "        if (vh.value.prev !== prev.hash) return no('voided-prev')   // asked against this link's previous head\n"),
  { name: 'the voided signer is looked up in the NEW head', from: 'const asker = prev.head.members.find((m) => m.pub === v.signer)', to: 'const asker = head.members.find((m) => m.pub === v.signer)' },
  del('a quarantined member may have asked', "        if (asker.quarantined) return no('voided-quarantined')\n"),
  del("the voided request's proof is not verified", "        if (!pr.ok) return no(`voided-${pr.reason}`)\n"),
  del('a quarantine may mark any member', "        if (!onlyMarked(d, asker.pub)) return no('target')\n"),
  del('a quarantine may leave no unquarantined member', "        if (!head.members.some((m) => !m.quarantined)) return no('last-live')\n"),
  { name: 'a quarantine may add or remove besides the mark', from: '  d.added.length === 0 && d.removed.length === 0 && d.cleared.length === 0 && d.marked.length === 1', to: '  d.marked.length === 1' },
  del('a revert may carry a voided request', "        if (l.voided !== undefined) return no('proof')\n"),
  del('a revert need not cite the change it reverts', "        if (rip.cause !== (await sha256b64u(c.ros))) return no('cause')\n"),
  { name: "the cited change's countersign is not verified", from: '        const cr = await verifyRip(c.rip, c.ripSig, { rosText: c.ros, directoryKeys: opts.directoryKeys, now: opts.now })\n', to: '        const cr = parseRip(c.rip)\n' },
  del('the cited change may be on another account', "        if (ch.value.address !== head.address) return no('cited-address')\n"),
  del('the cited change need not chain to its previous head', "        if (ch.value.prev !== (await sha256b64u(c.prevRos))) return no('cited-chain')\n"),
  del('the cited change may be any change', "        if (cd.added.length !== 1 || cd.removed.length + cd.marked.length + cd.cleared.length !== 0) return no('cited-change')\n"),
  del('a revert may mark any member', "        if (!onlyMarked(d, cd.added[0].pub)) return no('target')\n"),
  del('a removal or undo may carry a voided request or citation', "        if (carries(l)) return no('proof')\n"),
  del('a removal or undo may follow any link', "        if (prev.rip.auth !== 'q' && prev.rip.auth !== 'l') return no('auth')\n"),
  del('a removal or undo need not cite the previous head', "        if (rip.cause !== prev.hash) return no('cause')\n"),
  del('a removal need not be queued with the quarantine', "          if (rip.requestedAt !== prev.rip.ripenedAt) return no('order')   // queued in the same step\n"),
  { name: 'a removal may take an unquarantined member', from: ' || !d.removed[0].quarantined) return no', to: ') return no' },
  { name: 'a removal may also add', from: "          if (d.added.length + d.marked.length + d.cleared.length !== 0 || d.removed.length !== 1", to: "          if (d.marked.length + d.cleared.length !== 0 || d.removed.length !== 1" },
  del('a removal need not wait', "          if (waited < ROSTER_WAIT_MS) return no('unripe')\n"),
  { name: 'an undo may also add or remove', from: "          if (d.added.length + d.removed.length + d.marked.length !== 0 || d.cleared.length !== 1) return no('target')\n", to: "          if (d.cleared.length !== 1) return no('target')\n" },
  { name: "a directory act restarts the members' ages", from: '      for (const m of head.members) kept.set(m.pub, since.get(m.pub)!)\n', to: '      for (const m of head.members) kept.set(m.pub, rip.ripenedAt)\n' },
  del('a member change may carry a voided request', "    // a member's change\n    if (carries(l)) return no('proof')\n"),
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
    let out = src.replace(m.from, () => m.to)
    for (const [f, t] of m.and ?? []) {
      const k = out.split(f).length - 1
      ok(k === 1, `  extra edit applies exactly once: ${m.name} (found ${k})`)
      out = out.replace(f, () => t)
    }
    writeFileSync(p, out)
    const r = run(d)
    ok(r.status !== 0 && r.fails > 0, `killed: ${m.name} — ${r.status === 0 ? 'green' : `${r.fails} FAIL`}`)
  }
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
