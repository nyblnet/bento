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
// WHAT RUNS PER CHANGE (2026-11-28). One workflow runs on pull requests and
// pushes: ci.yml, whose `validate` job (the required check) runs the quick
// check, scripts/check.mjs --affected, over the steps every other file here
// defines. Every other workflow is dispatch-only: its steps run in the quick
// check when a diff reaches them and their tier allows, in the sweep
// (scripts/sweep.mjs), and on GitHub by hand. So a workflow that grows a
// pull_request trigger again is a second per-change bill nobody chose, and a
// rig-running workflow that cannot be dispatched cannot be run on GitHub at all.
{
  const triggers = (text: string): string[] => {
    const m = /^on:\s*\n((?:(?:\s{2}.*)?\n)*)/m.exec(text) ?? /^on:\s*(.+)$/m.exec(text)
    if (!m) return []
    if (!m[1].includes('\n')) return m[1].replace(/[[\]]/g, '').split(',').map((x) => x.trim()).filter(Boolean)
    return [...m[1].matchAll(/^ {2}([a-z_]+):/gm)].map((x) => x[1])
  }
  const main = files.workflows.find((w) => w.path.endsWith('/ci.yml'))
  ok(!!main && triggers(main.text).includes('pull_request') && triggers(main.text).includes('push'), '.github/workflows/ci.yml runs on pull_request and on push')
  ok(!!main && !/^\s+paths(-ignore)?:/m.test(main.text), '.github/workflows/ci.yml (the required check) has no path filter')
  ok(!!main && /^ {2}validate:\n/m.test(main.text) && /run: node scripts\/check\.mjs --affected\b/.test(main.text), 'the required `validate` job runs the quick check (node scripts/check.mjs --affected)')
  for (const w of files.workflows) {
    if (w === main) continue
    const t = triggers(w.text)
    ok(!t.includes('pull_request') && !t.includes('pull_request_target') && !t.includes('push'), `${w.path} does not run per change (triggers: ${t.join(', ') || 'none'}); the quick check does`)
    if (/node scripts\//.test(w.text) && !t.includes('workflow_run')) ok(t.includes('workflow_dispatch'), `${w.path} can be dispatched by hand`)
  }
}

// ZONE GATES. A workflow whose jobs are heavy runs them only when its gate
// job says so (scripts/ci/zone-gate: always, on a dispatch). The gate skips,
// so it is held: every job in a gated workflow other than the gate waits on
// it, and the gate's own pattern names the workflow file.
{
  let gated = 0
  for (const w of files.workflows) {
    if (!/^\s+run: scripts\/ci\/zone-gate '/m.test(w.text)) continue
    gated++
    const body = w.text.slice(w.text.indexOf('\njobs:\n'))
    const jobs = [...body.matchAll(/^ {2}([a-z0-9-]+):\n((?: {4}.*\n|\n)*)/gm)].map((m) => ({ id: m[1], text: m[2] }))
    const gate = jobs.find((j) => /run: scripts\/ci\/zone-gate '/.test(j.text))
    ok(!!gate, `${w.path} has a gate job`)
    if (!gate) continue
    const loose = jobs.filter((j) => j !== gate && !(new RegExp(`^ {4}needs: ${gate.id}$`, 'm').test(j.text) && j.text.includes(`if: needs.${gate.id}.outputs.run == 'true'`)))
    ok(jobs.length > 1 && loose.length === 0, `${w.path}: every job waits on ${gate.id} (${jobs.length - 1} jobs${loose.length ? '; not gated: ' + loose.map((j) => j.id).join(', ') : ''})`)
    const own = /run: scripts\/ci\/zone-gate '([^']+)'/.exec(gate.text)?.[1] ?? ''
    ok(!!own && new RegExp(own).test(w.path) && new RegExp(own).test('scripts/ci/zone-gate'), `${w.path}: its gate pattern matches the workflow file and the gate script`)
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

// EVERY RIG IS IN EXACTLY ONE TIER. The quick check and the sweep read CI's
// own steps (scripts/lib/check-plan.mjs) and give each step one tier from
// scripts/lib/test-tiers.mjs: fast (the quick check), full (the sweep), deep
// (--deep). A rig whose steps differ (an engine or mutant variant) is in the
// tier of its fastest step, where it runs per change; every variant still
// runs in some tier. Re-tiering is how a slow rig leaves the quick check;
// deleting it is not, and an entry that names no step is a decision about
// nothing, so it fails here.
{
  const plan = await import('./lib/check-plan.mjs')
  const tiersLib = await import('./lib/test-tiers.mjs')
  const view = plan.treeView(root)
  const graph = plan.buildGraph(view)
  const catalog = plan.loadCatalog(view)
  plan.annotate(catalog, graph)
  const steps = catalog.steps.filter((x: any) => !x.setup && !x.uses)
  ok(steps.length > 100, `the check's catalog reads CI's steps (${steps.length}; this check is what stops a vacuous green)`)
  const byRig = new Map<string, Set<string>>()
  for (const st of steps) {
    ok(tiersLib.TIERS.includes(st.tier.tier), `${st.id} has one tier (${st.tier.tier})`)
    for (const sc of st.scripts) {
      const b = sc.split('/').pop()!
      if (!/^test-.*\.(ts|mjs)$/.test(b) || !sc.startsWith('scripts/')) continue
      if (!byRig.has(b)) byRig.set(b, new Set())
      byRig.get(b)!.add(st.tier.tier)
    }
  }
  const counts: Record<string, number> = { fast: 0, full: 0, deep: 0 }
  for (const rig of rigs) {
    const t = byRig.get(rig)
    ok(!!t && t.size > 0, `${rig} is in a tier (a step the check reads runs it)`)
    if (t) counts[tiersLib.TIERS.find((x: string) => t.has(x))!]++
  }
  for (const e of tiersLib.ENTRIES) {
    const what = e.rig ?? e.args?.source ?? e.job?.source
    ok(!!e.why && e.why.length > 8, `tier entry ${what} says why`)
    ok(steps.some((st: any) => tiersLib.entryMatches(e, st)), `tier entry ${what} names a step (an entry for nothing is stale)`)
  }
  const stepCounts: Record<string, number> = { fast: 0, full: 0, deep: 0 }
  for (const st of steps) stepCounts[st.tier.tier]++
  console.log(`\ntiers: rigs ${counts.fast} fast, ${counts.full} full, ${counts.deep} deep; steps ${stepCounts.fast} fast, ${stepCounts.full} full, ${stepCounts.deep} deep`)
  ok(counts.fast + counts.full + counts.deep === rigs.length, `every rig is counted in exactly one tier (${counts.fast} + ${counts.full} + ${counts.deep} = ${rigs.length})`)
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
