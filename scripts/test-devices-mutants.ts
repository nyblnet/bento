#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Mutation check for the device certificates (kernel/src/devices.ts, and the
// heads roster.ts hands it).
//
//   node scripts/test-devices-mutants.ts
//
// Each mutant below removes or loosens ONE rule in a COPY of kernel/src, and
// scripts/test-devices.ts must then fail. The unmutated copy must pass first
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

type Mutant = { name: string; from: string; to: string; file?: string }
const del = (name: string, from: string, file?: string): Mutant => ({ name, from, to: '', file })
const MUTANTS: Mutant[] = [
  // the head rule (security's ruling on #925, item 5)
  del('the named head need not be in the verified chain', "  if (!H) return no('roster-head')\n"),
  { name: 'any head the signer was ever in (H looked up by hash among ALL heads ever seen, here: the current head stands in)',
    from: '  const H = ro.heads.find((h) => h.hash === cert.rosHash)\n', to: '  const H = ro.heads.find((h) => h.hash === cert.rosHash) ?? ro.heads[ro.heads.length - 1]\n' },
  del('the ceremony may predate the head it names', "  if (cert.ceremonyAt < H.ripenedAt) return no('ceremony')\n"),
  del('the signer need not be in the named head', "  if (!inH) return no('signer')\n"),
  del('the signer may be any kind', "  if (inH.kind !== 'pk') return no('signer-kind')\n"),
  del('the signer may be quarantined in the named head', "  if (inH.quarantined) return no('signer-quarantined')\n"),
  { name: 'the signer need not be in the current head', from: "  if (!cur) return no('signer-removed')\n  if (cur.quarantined) return no('signer-quarantined')\n  if (cur.since > H.ripenedAt) return no('signer-break')\n",
    to: "  if (cur && cur.quarantined) return no('signer-quarantined')\n  if (cur && cur.since > H.ripenedAt) return no('signer-break')\n" },
  del('the signer may be quarantined now', "  if (cur.quarantined) return no('signer-quarantined')\n"),
  del('a break since the named head is ignored', "  if (cur.since > H.ripenedAt) return no('signer-break')\n"),
  { name: 'a break is measured against the CURRENT head', from: "  if (cur.since > H.ripenedAt) return no('signer-break')\n", to: "  if (cur.since > ro.ripenedAt) return no('signer-break')\n" },
  del('the certificate may name another address', "  if (cert.address !== ro.address) return no('address')\n"),
  del('any via is accepted', "  if (cert.via !== 'passkey') return no('via')   // cns (web-add) and ck (roster) are the next kernel change\n"),
  // the assertion
  del('the assertion is not verified', "  if (!a.ok) return no(`assertion-${a.reason}`)\n"),
  { name: 'the assertion covers the watt., not the certificate', from: 'challenge: await statementChallenge(proof.cert),', to: 'challenge: await statementChallenge(proof.watt),' },
  // the watt.
  del('the watt. may name another certificate', "  if (watt.certHash !== (await sha256b64u(proof.cert))) return no('watt-mismatch')\n"),
  { name: 'the watt. kid is ignored: any pinned key verifies',
    from: "  if (!Object.hasOwn(opts.directoryKeys, watt.kid)) return no('watt-unknown-kid')\n  if (!(await verifyStatementSig(opts.directoryKeys[watt.kid], proof.wattSig, proof.watt))) return no('watt-signature')\n",
    to: "  let any = false\n  for (const k of Object.values(opts.directoryKeys)) if (await verifyStatementSig(k, proof.wattSig, proof.watt)) any = true\n  if (!any) return no('watt-signature')\n" },
  del('the watt. signature is not verified', "  if (!(await verifyStatementSig(opts.directoryKeys[watt.kid], proof.wattSig, proof.watt))) return no('watt-signature')\n"),
  del('a watt. may be logged before its ceremony', "  if (watt.loggedAt < cert.ceremonyAt) return no('watt-order')\n"),
  { name: 'a watt. may live longer than 24 h', from: ' || watt.expires - watt.loggedAt > WATT_MAX_MS) return no', to: ') return no' },
  { name: 'a watt. may have an empty life', from: '  if (watt.expires <= watt.loggedAt || ', to: '  if (' },
  { name: 'the watt. lives 25 hours', from: 'export const WATT_MAX_MS = 24 * HOUR\n', to: 'export const WATT_MAX_MS = 25 * HOUR\n' },
  del('no 7-day cap', "  if (watt.expires > cert.ceremonyAt + CEREMONY_CAP_MS) return no('watt-cap')\n"),
  { name: 'the cap counts from the watt., not the original ceremony (a renewal resets it)', from: '  if (watt.expires > cert.ceremonyAt + CEREMONY_CAP_MS)', to: '  if (watt.expires > watt.loggedAt + CEREMONY_CAP_MS)' },
  { name: 'exactly at the cap is refused (off by one)', from: '  if (watt.expires > cert.ceremonyAt + CEREMONY_CAP_MS)', to: '  if (watt.expires >= cert.ceremonyAt + CEREMONY_CAP_MS)' },
  del('a watt. logged in the future is accepted', "  if (watt.loggedAt > opts.now + SKEW_MS) return no('not-yet-valid')\n"),
  del('an expired watt. is accepted', "  if (opts.now >= watt.expires) return no('expired')\n"),
  { name: 'ob may be any digit', from: "(obF !== '0' && obF !== '1')", to: '!/^[0-9]$/.test(obF)' },
  // the grammar
  del('the kx may repeat the device key', '|| kxF === devicePub ', undefined),
  { name: 'the kx may repeat the consent key', from: ' || kxF === consentF) return no', to: ') return no' },
  { name: 'the consent key may repeat the device key', from: ' || consentF === devicePub) return no', to: ') return no' },
  { name: 'labels may run to 64 characters', from: 'export const MAX_LABEL = 40\n', to: 'export const MAX_LABEL = 64\n' },
  { name: 'any via word', from: "  if (!VIA[kind].includes(via)) return no('grammar')\n", to: '' },
  { name: 'the address need not be normal', from: "  const address = freeText(addressF)\n  if (address === null || !isNormalAddress(address)) return no('address')\n  if (!isHash(rosHash))",
    to: "  const address = freeText(addressF)\n  if (address === null) return no('address')\n  if (!isHash(rosHash))" },
  { name: 'the directory nonce is not checked', from: '  if (ceremonyAt === null || !isNonce(dirNonce)) return no', to: '  if (ceremonyAt === null) return no' },
  // the tier (G1)
  { name: 'a wdev. may be native', from: "  if (cert.kind !== 'dev2' || cert.consentPub === null) return 'passkey'\n", to: "  if (cert.consentPub === null && cert.kind === 'dev2') return 'passkey'\n" },
  { name: 'a quarantined consent key counts', from: "  if (!ck || ck.kind !== 'ck' || ck.quarantined) return 'passkey'\n", to: "  if (!ck || ck.kind !== 'ck') return 'passkey'\n" },
  { name: 'any member kind counts as a consent key', from: "  if (!ck || ck.kind !== 'ck' || ck.quarantined) return 'passkey'\n", to: "  if (!ck || ck.quarantined) return 'passkey'\n" },
  { name: 'exactly 72 h is not enough (off by one)', from: "  return now - ck.since >= CK_RIPE_MS ? 'native' : 'passkey'\n", to: "  return now - ck.since > CK_RIPE_MS ? 'native' : 'passkey'\n" },
  { name: 'the consent key ripens at 71 h', from: 'export const CK_RIPE_MS = ROSTER_WAIT_MS\n', to: 'export const CK_RIPE_MS = ROSTER_WAIT_MS - 3_600_000\n' },
  { name: 'any consent key on the roster makes a dev2. native (not the one it names)', from: '  const ck = roster.members.find((m) => m.pub === cert.consentPub)\n', to: "  const ck = roster.members.find((m) => m.kind === 'ck')\n" },
  // wren.
  del('the renewal signature is not verified', "  if (!str(sig) || !(await verifyStatementSig(devicePub, sig, text))) return no('signature')\n"),
  { name: 'the renewal challenge is not checked', from: "  if (!isNonce(challenge)) return no('grammar')\n", to: '' },
  // the heads roster.ts gives (a pin is a placeable head; every link is one)
  { name: 'roster.ts gives only the head, not every head', file: 'roster.ts', from: '    createdAt, lastResetAt, sinceExact, heads,\n', to: '    createdAt, lastResetAt, sinceExact, heads: heads.slice(-1),\n' },
  { name: 'roster.ts omits the pinned head from the heads', file: 'roster.ts',
    from: "      prev = { head, hash, rip }; heads.push({ hash, seq: head.seq, ripenedAt: rip.ripenedAt, members: head.members })\n      continue\n    }\n\n    if (head.address",
    to: "      prev = { head, hash, rip }; if (opts.pinned === undefined) heads.push({ hash, seq: head.seq, ripenedAt: rip.ripenedAt, members: head.members })\n      continue\n    }\n\n    if (head.address" },
]

function tree() {
  const d = mkdtempSync(join(tmpdir(), 'devices-mut-'))
  cpSync(join(root, 'kernel/src'), join(d, 'kernel/src'), { recursive: true })
  cpSync(join(root, 'kernel/fixtures'), join(d, 'kernel/fixtures'), { recursive: true })
  mkdirSync(join(d, 'scripts'))
  cpSync(join(root, 'scripts/test-devices.ts'), join(d, 'scripts/test-devices.ts'))
  return d
}
function run(d: string) {
  const r = spawnSync(process.execPath, [join(d, 'scripts/test-devices.ts')], { encoding: 'utf8' })
  const tail = (r.stdout.match(/\d+\/\d+ checks passed/g) ?? []).pop() ?? `(no count; exit ${r.status})`
  return { status: r.status, tail, fails: (r.stdout.match(/^ {2}FAIL/gm) ?? []).length }
}

console.log('positive control: the unmutated copy passes the rig')
{
  const d = tree()
  const r = run(d)
  ok(r.status === 0 && r.fails === 0, `test-devices.ts: ${r.tail}`)
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${MUTANTS.length} mutants, each one loosened rule: every one must turn the rig red`)
for (const m of MUTANTS) {
  const d = tree()
  const p = join(d, 'kernel/src', m.file ?? 'devices.ts')
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
