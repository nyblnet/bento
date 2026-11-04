#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Mutation check for kx placement mode C (identity-design §6b).
//
//   node scripts/test-kx-mode-mutants.ts
//
// Under mode C both kx slots are REQUIRED and the account blob is exactly 64
// bytes. Each mutant below reintroduces one lenient path (an empty slot read as
// "no kx", a 32-byte blob read as account-only, a kx never matched...) into a
// COPY of kernel/src, and test-statements.ts plus test-recovery.ts must then
// fail. The unmutated copy must pass first (positive control), and every mutant
// must apply to exactly one place in the source, so a refactor that moves the
// code makes this rig fail rather than pass vacuously.

import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0, checks = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

type Mutant = { name: string; file: 'statements.ts' | 'recovery.ts'; from: string; to: string }
const MUTANTS: Mutant[] = [
  { name: 'an empty kx slot is read as "no kx"', file: 'statements.ts',
    from: "  if (f === '' || !(await isKxKey(f)) || others.includes(f)) return false",
    to: "  if (f === '') return null as unknown as string\n  if (!(await isKxKey(f)) || others.includes(f)) return false" },
  { name: 'a kx is never checked to be an ECDH point', file: 'statements.ts',
    from: "  if (f === '' || !(await isKxKey(f)) || others.includes(f)) return false",
    to: "  if (f === '' || others.includes(f)) return false" },
  { name: 'a kx may repeat a signing key of its certificate', file: 'statements.ts',
    from: "  if (f === '' || !(await isKxKey(f)) || others.includes(f)) return false",
    to: "  if (f === '' || !(await isKxKey(f))) return false" },
  { name: 'dev. ignores its kx slot', file: 'statements.ts',
    from: "  const kx = await kxSlot(kxF, [devicePub, accountPub, consentF])\n  if (kx === false) return no('kx')",
    to: "  const kx = (await kxSlot(kxF, [devicePub, accountPub, consentF])) || kxF" },
  { name: 'bind. ignores its kx slot', file: 'statements.ts',
    from: "  const kx = await kxSlot(kxF, [accountPub])\n  if (kx === false) return no('kx')",
    to: "  const kx = (await kxSlot(kxF, [accountPub])) || kxF" },
  { name: 'a 32-byte blob is accepted beside a 64-byte one', file: 'recovery.ts',
    from: "  if (pt.length !== BLOB_LEN) return no('length')\n  const scalars = [pt.slice(0, 32), pt.slice(32)]\n  const pubs = [expected.accountPub, expected.kxPub]\n  for (let i = 0; i < 2; i++) {",
    to: "  if (pt.length !== BLOB_LEN && pt.length !== 32) return no('length')\n  const scalars = [pt.slice(0, 32), pt.slice(32)]\n  const pubs = [expected.accountPub, expected.kxPub]\n  for (let i = 0; i < (pt.length === 32 ? 1 : 2); i++) {" },
  { name: 'any length of at least 64 bytes is accepted', file: 'recovery.ts',
    from: "  if (pt.length !== BLOB_LEN) return no('length')",
    to: "  if (pt.length < BLOB_LEN) return no('length')\n  pt = pt.slice(0, BLOB_LEN)" },
  { name: 'the kx scalar is never matched to the binding', file: 'recovery.ts',
    from: "  for (let i = 0; i < 2; i++) {",
    to: "  for (let i = 0; i < 1; i++) {" },
  { name: 'a missing kxPub skips the kx match', file: 'recovery.ts',
    from: "    if (typeof pubs[i] !== 'string' || !(await scalarMatches(scalars[i], pubs[i], subtle))) return no('key-mismatch')",
    to: "    if (!pubs[i]) continue\n    if (!(await scalarMatches(scalars[i], pubs[i], subtle))) return no('key-mismatch')" },
  { name: 'sealing without a kx writes a 32-byte blob', file: 'recovery.ts',
    from: "  if (!keys.kx) throw new Error('the blob needs the recovery kx scalar (mode C)')",
    to: "  if (!keys.kx) return keys.account.slice()" },
]

function tree(): string {
  const d = mkdtempSync(join(tmpdir(), 'kx-mutant-'))
  cpSync(join(root, 'kernel/src'), join(d, 'kernel/src'), { recursive: true })
  cpSync(join(root, 'kernel/fixtures'), join(d, 'kernel/fixtures'), { recursive: true })
  mkdirSync(join(d, 'scripts'))
  for (const f of ['test-statements.ts', 'test-recovery.ts']) cpSync(join(root, 'scripts', f), join(d, 'scripts', f))
  return d
}
/** Run both rigs in a tree; returns each one's exit status and its printed count line. */
function run(d: string) {
  return ['test-statements.ts', 'test-recovery.ts'].map((f) => {
    const r = spawnSync(process.execPath, [join(d, 'scripts', f)], { encoding: 'utf8' })
    const tail = (r.stdout.match(/\d+\/\d+ checks passed|\d+ of \d+ checks FAILED|\d+\/\d+[^\n]*/g) ?? []).pop() ?? `(no count; exit ${r.status})`
    return { f, status: r.status, tail, fails: (r.stdout.match(/^ {2}FAIL/gm) ?? []).length }
  })
}

console.log('positive control: the unmutated copy passes both rigs')
{
  const d = tree()
  for (const r of run(d)) ok(r.status === 0 && r.fails === 0, `${r.f}: ${r.tail}`)
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${MUTANTS.length} mutants, each a lenient path mode C forbids: every one must turn a rig red`)
for (const m of MUTANTS) {
  const d = tree()
  const p = join(d, 'kernel/src', m.file)
  const src = readFileSync(p, 'utf8')
  const n = src.split(m.from).length - 1
  ok(n === 1, `applies exactly once: ${m.name} (found ${n})`)
  if (n === 1) {
    writeFileSync(p, src.replace(m.from, () => m.to))
    const rs = run(d)
    const killedBy = rs.filter((r) => r.status !== 0 && r.fails > 0)
    ok(killedBy.length > 0, `killed: ${m.name} — ${rs.map((r) => `${r.f} ${r.status === 0 ? 'green' : `${r.fails} FAIL`}`).join(', ')}`)
  }
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
