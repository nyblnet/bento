#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Mutation check for gate 1's raw-text rule (kernel/src/gate1.ts).
//
//   node scripts/test-gate1-mutants.ts
//
// <style>, <title> and <textarea> are text in HTML but hold TAGS inside <svg>
// or <math>, so gate 1 refuses any "<" in them that could start markup: one
// before a letter, "!", "/" or "?". Each mutant below loosens or widens that
// rule in a COPY of kernel/src/gate1.ts, and test-gate1.ts (the corpus in
// home/fixtures/gate1) must then fail. The unmutated copy must pass first
// (positive control), and every mutant must apply to exactly one place, so a
// refactor that moves the code makes this rig fail rather than pass vacuously.

import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0, checks = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

const RULE = '/<[a-zA-Z!/?]/.test(html.slice(tag.end, close))'
const WHICH = "if (name !== 'script' && /<"
type Mutant = { name: string; from: string; to: string }
const MUTANTS: Mutant[] = [
  { name: 'only "<script" counts as markup (the rule before foreign content)', from: RULE, to: RULE.replace('/<[a-zA-Z!/?]/', '/<script/i') },
  { name: '"<!" (a comment or CDATA) is let through', from: RULE, to: RULE.replace('[a-zA-Z!/?]', '[a-zA-Z/?]') },
  { name: '"</" (an end tag) is let through', from: RULE, to: RULE.replace('[a-zA-Z!/?]', '[a-zA-Z!?]') },
  { name: '"<?" (a bogus comment) is let through', from: RULE, to: RULE.replace('[a-zA-Z!/?]', '[a-zA-Z!/]') },
  { name: 'an uppercase tag name is let through', from: RULE, to: RULE.replace('[a-zA-Z!/?]', '[a-z!/?]') },
  { name: '<textarea> is not checked', from: WHICH, to: "if (name !== 'script' && name !== 'textarea' && /<" },
  { name: '<title> is not checked', from: WHICH, to: "if (name !== 'script' && name !== 'title' && /<" },
  { name: '<style> is not checked', from: WHICH, to: "if (name !== 'script' && name !== 'style' && /<" },
  // the other direction: a "<" that starts no markup is text everywhere
  { name: 'every "<" is refused, markup or not', from: RULE, to: RULE.replace('/<[a-zA-Z!/?]/', '/</') },
]

function tree(): string {
  const d = mkdtempSync(join(tmpdir(), 'gate1-mutant-'))
  // the whole of kernel/src: test-gate1.ts also reads the release key from update.ts
  cpSync(join(root, 'kernel/src'), join(d, 'kernel/src'), { recursive: true })
  mkdirSync(join(d, 'scripts'))
  cpSync(join(root, 'scripts/test-gate1.ts'), join(d, 'scripts/test-gate1.ts'))
  mkdirSync(join(d, 'home/fixtures'), { recursive: true })
  symlinkSync(join(root, 'home/fixtures/gate1'), join(d, 'home/fixtures/gate1'))
  return d
}
/** Run the corpus rig in a tree: its exit status, FAIL count and count line. */
function run(d: string) {
  const r = spawnSync(process.execPath, [join(d, 'scripts/test-gate1.ts')], { encoding: 'utf8' })
  const fails = (r.stdout.match(/^ {2}FAIL {2}.*$/gm) ?? [])
  const tail = (r.stdout.match(/\d+\/\d+ checks passed/g) ?? []).pop() ?? `(no count; exit ${r.status}${r.stderr ? ': ' + r.stderr.trim().split('\n').pop() : ''})`
  return { status: r.status, fails, tail }
}

console.log('positive control: the unmutated copy passes test-gate1.ts')
{
  const d = tree()
  const r = run(d)
  ok(r.status === 0 && r.fails.length === 0, `unmutated: ${r.tail}`)
  rmSync(d, { recursive: true, force: true })
}

console.log('\neach mutant must turn test-gate1.ts red')
for (const m of MUTANTS) {
  const d = tree()
  try {
    const p = join(d, 'kernel/src/gate1.ts')
    const src = readFileSync(p, 'utf8')
    const n = src.split(m.from).length - 1
    if (n !== 1) { ok(false, `${m.name}: its anchor occurs ${n} times (expected exactly 1)`); continue }
    writeFileSync(p, src.replace(m.from, m.to))
    const r = run(d)
    const first = r.fails[0]?.replace(/^ {2}FAIL {2}/, '') ?? ''
    // red by a FAIL row, never by a crash: a crash proves nothing about the rule
    ok(r.status !== 0 && r.fails.length > 0 && /checks passed/.test(r.tail), `${m.name}: killed by ${r.fails.length} row(s)${first ? ` (first: ${first.slice(0, 90)})` : ` (${r.tail})`}`)
  } finally { rmSync(d, { recursive: true, force: true }) }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
