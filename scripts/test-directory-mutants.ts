#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Mutation check for the directory's mail-budget rule (server/directory/src):
// a start that mails nothing costs nothing.
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
const RIGS = ['test-directory.ts']
const TREE = ['kernel/src', 'kernel/fixtures', 'server/directory/src']
let failures = 0, checks = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

type Edit = { from: string; to: string }
/** `also`: further edits in the same file, for a rule held at two doors */
type Mutant = Edit & { name: string; file: 'worker.js'; also?: Edit[] }
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
