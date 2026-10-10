#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Every rig in scripts/ is actually RUN by CI.
//
//   node scripts/test-ci-registered.ts
//
// WHY THIS EXISTS. A rig nobody runs is worse than no rig, and it fails in the
// most flattering way available: the file is there, the checks inside it are
// good, `git log` shows it being written and maintained, and a reader counting
// coverage counts it. It just never executes. Nothing goes red, so nothing ever
// says so.
//
// This was not hypothetical. Five rigs landed in one afternoon — write-back,
// print, the grid frontier, accessibility, per-cell appearance — each written
// by a different agent that had been told to write one and had no reason to
// know where CI's list lived. All five were on disk and passing. None of them
// were in `.github/workflows/ci.yml`. They were caught by hand, once, by
// someone who happened to think of it; this is that thought, made automatic.
//
// It is deliberately the DUMBEST possible check: does the workflow file mention
// the filename. Not whether the step is well-formed, not whether it is in a job
// that runs — a smarter check here would need a YAML parser and a model of
// GitHub's execution semantics, and the failure it is guarding against is
// "somebody forgot", which a substring catches.
//
// The reverse direction matters too and is cheaper still: a workflow line
// pointing at a script that no longer exists is a step that fails on every push
// for a reason unrelated to the change that triggered it.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workflow = join(root, '.github/workflows/ci.yml')

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

if (!existsSync(workflow)) {
  console.log('FAIL  .github/workflows/ci.yml does not exist. Nothing runs anything.')
  process.exit(1)
}
const ci = readFileSync(workflow, 'utf8')

// A rig is a `scripts/test-*.ts|mjs`. Library code under scripts/lib/ is not a
// rig and is exercised by the rigs that import it.
const rigs = readdirSync(join(root, 'scripts'))
  .filter((f) => /^test-.*\.(ts|mjs)$/.test(f))
  .sort()

console.log(`${rigs.length} rigs in scripts/\n`)

// GUARD IS LIVE. If the glob ever stops matching — a rename, a move, a change
// of extension — every check below passes vacuously and this file becomes the
// thing it exists to prevent.
ok(rigs.length > 20, 'the rig glob still finds rigs (this check is what stops a vacuous green)')

/**
 * Rigs CI deliberately does not run, each with the reason, in full view.
 *
 * This list is a hazard and is meant to look like one. An exemption list is how
 * a guard like this rots: one entry gets added to make a build green, nobody
 * reads it again, and the check now certifies a smaller and smaller set while
 * still reporting success. So it prints on EVERY run, loudly, whether or not
 * anything failed — an exemption you have to look at is one somebody eventually
 * removes.
 *
 * Adding to it should feel worse than fixing the rig.
 */
const NOT_RUN: Record<string, string> = {
  // EMPTY, AND THAT IS THE POINT. It held three entries until 2026-08-29:
  // test-slide-store.ts (unwired since #262), and test-doc-index.mjs and
  // test-spaces.mjs, which this branch had registered itself before learning
  // that scripts/ and .github/ are the ops zone's. PR #399 registered all
  // three properly, so every reason expired at once and all three came out in
  // the same push as the rebase — which is what the check below is for.
  //
  // Leave it empty. An exemption is a hole in the only guarantee this file
  // makes, and the two checks on each entry — the rig still exists, and CI
  // still does not run it — exist so a hole cannot outlive its reason quietly.
}

console.log('\nevery rig is registered')
for (const rig of rigs) {
  if (rig in NOT_RUN) continue
  // The rig names ITSELF here, so a rig cannot satisfy this check by mentioning
  // its own filename in a comment inside the workflow — the workflow has to
  // name it, which only a `run:` line does in practice.
  ok(ci.includes(rig), `${rig} is run by CI`)
}

if (Object.keys(NOT_RUN).length) {
  console.log('\nNOT RUN BY CI, on purpose — read this list, do not grow it')
  for (const [rig, why] of Object.entries(NOT_RUN)) {
    console.log(`  ·     ${rig} — ${why}`)
    // An exemption for a rig that no longer exists is stale bookkeeping
    // pretending to be a decision.
    ok(existsSync(join(root, 'scripts', rig)), `${rig} still exists, so its exemption is still about something`)
    // AND AN EXEMPTION FOR A RIG THAT IS NOW REGISTERED IS WORSE: it is a hole
    // nobody needs, sitting in the list quietly not being noticed. The whole
    // hazard of this mechanism is that entries outlive their reason, so the
    // reason is checked rather than trusted — the moment CI does run the rig,
    // this fails and the entry has to come out.
    ok(!ci.includes(rig),
      `${rig} IS run by CI now — delete its exemption, the reason it was added has expired`)
  }
}

console.log('\nevery CI reference points at something real')
const referenced = [...ci.matchAll(/node (scripts\/[A-Za-z0-9._/-]+)/g)].map((m) => m[1])
ok(referenced.length > 20, 'CI actually references rigs (guard is live in this direction too)')
for (const ref of [...new Set(referenced)].sort()) {
  ok(existsSync(join(root, ref)), `${ref} exists`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) {
  console.log(`
A rig that CI does not run is not coverage. Add a step for it in
.github/workflows/ci.yml — with a comment saying what the checks are FOR, the
way the ones around it do, because the next person reading a red build needs to
know what broke and why it mattered enough to guard.`)
  process.exit(1)
}
