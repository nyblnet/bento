#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Mutation check for rk, the recovery key under option G (kernel/src/recovery.ts):
// the per-account salt (security's R9) and the rejection sampling whose counter
// rule every host must reproduce.
//
//   node scripts/test-rk-mutants.ts
//
// Each mutant changes ONE rule in a COPY of kernel/src, and scripts/test-recovery.ts
// must then fail. The unmutated copy must pass first (positive control), and every
// mutant must apply to exactly one place in the source.

import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0, checks = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

type Mutant = { name: string; from: string; to: string }
const MUTANTS: Mutant[] = [
  { name: 'R9: the salt is not per account (one salt for every address)',
    from: '  const msg = new Uint8Array(label.length + 1 + a.length)\n  msg.set(label); msg[label.length] = 0; msg.set(a, label.length + 1)\n',
    to: '  const msg = new Uint8Array(label.length + 1)\n  msg.set(label); msg[label.length] = 0\n' },
  { name: 'the salt has no 0x00 between the label and the address',
    from: '  const msg = new Uint8Array(label.length + 1 + a.length)\n  msg.set(label); msg[label.length] = 0; msg.set(a, label.length + 1)\n',
    to: '  const msg = new Uint8Array(label.length + a.length)\n  msg.set(label); msg.set(a, label.length)\n' },
  { name: 'the salt is the whole 32-byte digest', from: "  return new Uint8Array(await crypto.subtle.digest('SHA-256', msg as BufferSource)).slice(0, SALT_LEN)\n",
    to: "  return new Uint8Array(await crypto.subtle.digest('SHA-256', msg as BufferSource))\n" },
  { name: 'the address need not be in normal form', from: "  if (typeof address !== 'string' || !isNormalAddress(address)) throw new Error('rk salt: the address must be in normal form')\n", to: '' },
  { name: 'the counter is a digit, not a byte', from: '  info.set(label); info[label.length] = c\n', to: '  info.set(label); info[label.length] = 0x30 + c\n' },
  { name: 'the counter starts at 1', from: '  for (let c = 0; c < RK_MAX_TRIES; c++) {\n    const cand = await rkCandidate(ikm, c)\n', to: '  for (let c = 1; c < RK_MAX_TRIES; c++) {\n    const cand = await rkCandidate(ikm, c)\n' },
  { name: 'reduce mod n instead of refusing (the biased form)', from: '    if (d >= 1n && d < N) return i\n', to: '    if (d % N !== 0n) return i\n' },
  { name: 'n itself is accepted', from: '    if (d >= 1n && d < N) return i\n', to: '    if (d >= 1n && d <= N) return i\n' },
  { name: 'zero is accepted', from: '    if (d >= 1n && d < N) return i\n', to: '    if (d >= 0n && d < N) return i\n' },
  { name: 'the HKDF label is the recovery wrap label', from: "  const label = te.encode('bento/id/rk/v1')\n", to: "  const label = te.encode('bento/id/rc-wrap/v1')\n" },
]

function tree() {
  const d = mkdtempSync(join(tmpdir(), 'rk-mut-'))
  cpSync(join(root, 'kernel/src'), join(d, 'kernel/src'), { recursive: true })
  cpSync(join(root, 'kernel/fixtures'), join(d, 'kernel/fixtures'), { recursive: true })
  mkdirSync(join(d, 'scripts'))
  cpSync(join(root, 'scripts/test-recovery.ts'), join(d, 'scripts/test-recovery.ts'))
  return d
}
function run(d: string) {
  const r = spawnSync(process.execPath, [join(d, 'scripts/test-recovery.ts')], { encoding: 'utf8' })
  const tail = (r.stdout.match(/\d+\/\d+ checks passed/g) ?? []).pop() ?? `(no count; exit ${r.status})`
  return { status: r.status, tail, fails: (r.stdout.match(/^ {2}FAIL/gm) ?? []).length }
}

console.log('positive control: the unmutated copy passes the rig')
{
  const d = tree()
  const r = run(d)
  ok(r.status === 0 && r.fails === 0, `test-recovery.ts: ${r.tail}`)
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${MUTANTS.length} mutants, each one changed rule: every one must turn the rig red`)
for (const m of MUTANTS) {
  const d = tree()
  const p = join(d, 'kernel/src/recovery.ts')
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
