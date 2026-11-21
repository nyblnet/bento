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

import { readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ciFiles, ciText } from './lib/ci-files.mjs'

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
  console.log('FAIL  .github/workflows/ci.yml does not exist. Nothing runs the required check.')
  process.exit(1)
}
// CI is SEVERAL files now (scripts/lib/ci-files.mjs says which): ci.yml, each
// zone's ci-<zone>.yml, and the validate-<zone> composite actions that ci.yml's
// required `validate` job runs. Splitting it was what stopped every zone
// appending at the same few anchors of one file. The check is unchanged —
// does CI mention the filename — over all of it.
const files = ciFiles(root)
const ci = ciText(root)

console.log('CI is made of')
for (const w of files.workflows) console.log(`  ·     ${w.path}`)
for (const a of files.usedActions) console.log(`  ·     ${a.path}`)
console.log('')
ok(files.workflows.length > 0 && files.usedActions.length > 0,
  'the workflows and the validate actions are found (this check is what stops a vacuous green)')
// An action no workflow runs is a file of steps that never execute: a rig
// "registered" there would pass this check and never run. That is the new hole
// a split opens, so it is closed here rather than trusted.
for (const a of files.unusedActions) ok(false, `${a.path} is run by a workflow (nothing uses ./.github/actions/${a.name})`)
for (const n of files.missingActions) ok(false, `./.github/actions/${n} exists (a workflow uses it)`)
// A workflow file with no pull_request trigger never runs on a PR, so its
// rigs never gate one. Every workflow that runs a rig must be triggered by one.
for (const w of files.workflows) {
  if (!/node scripts\//.test(w.text)) continue
  ok(/^on:\s*$[\s\S]*?^\s{2}pull_request:/m.test(w.text) || /^on:.*pull_request/m.test(w.text),
    `${w.path} runs on pull_request`)
}

// PATH FILTERS. A zone workflow may limit its pull_request trigger to the
// paths that can affect it (none of them is the required check). A filter is
// a way to skip silently, so three things are held:
//   - ci.yml, which holds the required `validate`, has none: it runs on every PR;
//   - a filtered workflow lists ITSELF, so editing it runs it;
//   - every script it runs matches one of its paths, so changing a rig runs
//     the workflow that runs the rig.
{
  const glob = (g: string) => new RegExp('^' + g.split('**').map((part) => part.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + '$')
  const pathsOf = (text: string): string[] | null => {
    const m = /^on:\n  pull_request:\n((?: {4}.*\n)*)/m.exec(text)
    const body = m?.[1] ?? ''
    const start = body.indexOf('    paths:\n')
    if (start < 0) return null
    return [...body.slice(start).matchAll(/^ {6}- '([^']+)'$/gm)].map((x) => x[1])
  }
  let filtered = 0
  for (const w of files.workflows) {
    const paths = pathsOf(w.text)
    if (w.path.endsWith('/ci.yml')) { ok(paths === null && !/^\s+paths(-ignore)?:/m.test(w.text), `${w.path} (the required check) has no path filter`); continue }
    if (!paths) continue
    filtered++
    const res = paths.map(glob)
    ok(paths.includes(w.path), `${w.path} lists itself in its path filter`)
    // what the workflow RUNS: its comment lines name files it does not run
    const live = w.text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    const scripts = [...new Set([...live.matchAll(/\bscripts\/[A-Za-z0-9_./-]+\.(?:mjs|ts|js|py|sh)\b|\bscripts\/ci\/[A-Za-z0-9_-]+/g)].map((x) => x[0]))]
    const missed = scripts.filter((sc) => !res.some((re) => re.test(sc)))
    ok(missed.length === 0, `${w.path}: every script it runs matches its path filter (${scripts.length} scripts${missed.length ? '; not matched: ' + missed.join(', ') : ''})`)
  }
  ok(filtered > 0, `path filters are read (${filtered} filtered workflows; this check is what stops a vacuous green)`)
}

// ZONE GATES. A workflow whose jobs are heavy may run them on a PR only when
// it touches the zone's own files or carries the `full-ci` label
// (.github/actions/zone-gate). The gate skips, so it is held too: every job
// in a gated workflow other than the gate waits on it, and the gate's own
// pattern names the workflow file, so editing the workflow runs its jobs.
{
  let gated = 0
  for (const w of files.workflows) {
    if (!/uses:\s*\.\/\.github\/actions\/zone-gate\s*$/m.test(w.text)) continue
    gated++
    const body = w.text.slice(w.text.indexOf('\njobs:\n'))
    const jobs = [...body.matchAll(/^ {2}([a-z0-9-]+):\n((?: {4}.*\n|\n)*)/gm)].map((m) => ({ id: m[1], text: m[2] }))
    const gate = jobs.find((j) => /zone-gate/.test(j.text))
    ok(!!gate, `${w.path} has a gate job`)
    if (!gate) continue
    const loose = jobs.filter((j) => j !== gate && !(new RegExp(`^ {4}needs: ${gate.id}$`, 'm').test(j.text) && j.text.includes(`if: needs.${gate.id}.outputs.run == 'true'`)))
    ok(jobs.length > 1 && loose.length === 0, `${w.path}: every job waits on ${gate.id} (${jobs.length - 1} jobs${loose.length ? '; not gated: ' + loose.map((j) => j.id).join(', ') : ''})`)
    const own = /own: '([^']+)'/.exec(gate.text)?.[1] ?? ''
    ok(!!own && new RegExp(own).test(w.path) && new RegExp(own).test('.github/actions/zone-gate/action.yml'), `${w.path}: its gate pattern matches the workflow file and the gate action`)
    ok(/^ {4}types: \[opened, synchronize, reopened, labeled\]$/m.test(w.text) && !/^ {4}paths:/m.test(w.text), `${w.path}: a label can start it (types include labeled, and no paths filter stands in the way)`)
  }
  ok(gated > 0, `zone gates are read (${gated} gated workflows; this check is what stops a vacuous green)`)
}

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
A rig that CI does not run is not coverage. Add a step for it at the END of
your zone's slice, .github/actions/validate-<zone>/action.yml (part of the
required check), or as a job in .github/workflows/ci-<zone>.yml — never in
ci.yml. Give it a comment saying what the checks are FOR, the way the ones
around it do, because the next person reading a red build needs to know what
broke and why it mattered enough to guard.`)
  process.exit(1)
}
