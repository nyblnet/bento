#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Run every bento/spaces rig the way CI runs it.
//
//   node scripts/test-spaces.mjs [name…]      # all, or just the ones named
//   node scripts/test-spaces.mjs --manifest   # only check the list is complete
//
// WHY THIS EXISTS. Two of the spaces rigs cannot be handed to node directly:
// store.ts imports './model' without an extension and the kernel transport uses
// parameter properties, neither of which node's strip-only TypeScript loader
// will follow. CI knows that and bundles them through esbuild first. Run one of
// those two by hand and you get ERR_MODULE_NOT_FOUND — a stack trace that looks
// exactly like a broken product and nothing like a missing build step. That has
// already cost one wrong bug report in this repo: a rig that passes in CI was
// written up as a red test.
//
// So the fix is not to bend the app's imports around node. It is to give the
// suite one local entry point that does what CI does, and to make the failure
// legible when it is real.
//
// WHY CI RUNS `--manifest` AND NOT THE WHOLE RUNNER. Every rig below already has
// its own CI step, with its own timezone matrix; running the runner there would
// execute all of them a second time and prove nothing new. What CI cannot get
// anywhere else is the BOOKKEEPING this file does — that a spaces rig on disk is
// listed here, and that it is registered in the workflow. Both failures are
// silent: an unlisted rig never runs locally, an unregistered one never runs in
// CI, and neither shows up as anything but green. `test-spaces.mjs` itself was
// unregistered for weeks, which is the case in point.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const esbuild = join(root, 'slides/node_modules/.bin/esbuild')

// The timezone lists are not decoration. A date test that only runs in one
// timezone has not been run: Kiritimati is UTC+14 and Lord Howe is a half-hour
// DST offset, which is where "add 86,400,000 ms" stops being "add a day".
const TZS_JOURNAL = ['UTC', 'Europe/Berlin', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Australia/Lord_Howe']
const TZS_CALC = ['UTC', 'Europe/Berlin', 'America/Los_Angeles', 'Pacific/Kiritimati']

const RIGS = [
  { name: 'model',   file: 'scripts/test-spaces-model.ts' },
  { name: 'agent',   file: 'scripts/test-spaces-agent.ts' },
  { name: 'journal', file: 'scripts/test-spaces-journal.ts', tzs: TZS_JOURNAL },
  { name: 'calc',    file: 'scripts/test-spaces-calc.ts', tzs: TZS_CALC },
  { name: 'undo',    file: 'scripts/test-spaces-undo.ts', bundle: true },
  { name: 'invite',  file: 'scripts/test-spaces-invite.ts', bundle: true },
  { name: 'roundtrip', file: 'scripts/test-spaces-roundtrip.ts', bundle: true },
  { name: 'size',    file: 'scripts/test-spaces-size.mjs' },
]

// A rig that exists but is not listed here would never run locally, and the
// silence would look exactly like passing. Discovering the files and comparing
// is two lines; noticing the omission by eye, months later, is not.
const onDisk = readdirSync(join(root, 'scripts'))
  .filter((f) => /^test-spaces-.*\.(ts|mjs)$/.test(f))
  .map((f) => f.replace(/^test-spaces-/, '').replace(/\.(ts|mjs)$/, ''))
const missing = onDisk.filter((n) => !RIGS.some((r) => r.name === n))
if (missing.length) {
  console.error(`these spaces rigs exist but this runner does not list them: ${missing.join(', ')}`)
  console.error('Add them to RIGS (with bundle:true if node cannot load them directly).')
  process.exit(2)
}

// --- the manifest check ------------------------------------------------------
// A rig listed here but absent from the workflow runs locally and never in CI —
// the same silence from the other side. The workflow is read as TEXT on purpose:
// the rigs are invoked several different ways (plain, under a TZ loop, bundled
// through esbuild first), and every one of them names the file.
//
// REGISTRATION IS `--manifest`'s ENTIRE JOB AND NO PART OF THE FULL RUNNER'S,
// so it is asked only in that mode. Both halves of that sentence were wrong here
// once, and each wrong half had its own symptom:
//
//   * With no workflow to read, this printed a warning on stderr and then a
//     success line on stdout claiming all eight rigs were "registered in
//     .github/workflows/ci.yml" — naming the file it had just failed to find.
//     A mode that cannot see the workflow has not done half its job; it has done
//     none of it, so it fails.
//   * The check used to run BEFORE the argv parse, so an unregistered rig exited
//     2 in full-runner mode too — before a single rig ran. A bookkeeping gap
//     withheld all eight rigs from someone who asked for the rigs and never
//     mentioned CI, and told them about CI registration instead. Measured: zero
//     rig-output lines. Found by bento-team-home-ios.
const WORKFLOW = '.github/workflows/ci.yml'
const argv = process.argv.slice(2)

if (argv.includes('--manifest')) {
  // The list must be live. If RIGS ever emptied, `unregistered` would be [] and
  // this mode would report a pass over nothing. The on-disk check above already
  // catches that from the other side (every file becomes unlisted), but only
  // while files exist — this makes the floor explicit rather than emergent.
  if (!RIGS.length) {
    console.error('RIGS is empty — this check would pass vacuously. That is the bug, not a pass.')
    process.exit(2)
  }
  if (!existsSync(join(root, WORKFLOW))) {
    console.error(`${WORKFLOW} not found, so registration cannot be checked — and checking it is`)
    console.error('the whole of what --manifest does. Run it from a full checkout.')
    process.exit(2)
  }
  const ci = readFileSync(join(root, WORKFLOW), 'utf8')
  const unregistered = RIGS.filter((r) => !ci.includes(r.file.replace(/^scripts\//, '')))
  if (unregistered.length) {
    console.error(`these spaces rigs are not registered in ${WORKFLOW}: ${unregistered.map((r) => r.name).join(', ')}`)
    console.error('A rig nobody runs is not a rig. Add a step for each, or remove it from RIGS.')
    process.exit(2)
  }
  console.log(`manifest ok — ${RIGS.length} spaces rigs, all listed here and all registered in ${WORKFLOW}`)
  process.exit(0)
}

const only = argv
const picked = only.length ? RIGS.filter((r) => only.includes(r.name)) : RIGS
const unknown = only.filter((n) => !RIGS.some((r) => r.name === n))
if (unknown.length) {
  console.error(`unknown rig(s): ${unknown.join(', ')}`)
  console.error(`known: ${RIGS.map((r) => r.name).join(' ')}`)
  process.exit(2)
}

let tmp = null
function bundled(file) {
  if (!existsSync(esbuild)) {
    console.error(`\nesbuild is missing at ${esbuild}`)
    console.error('This rig has to be bundled before node can load it. Run `npm install` in slides/ first.')
    process.exit(2)
  }
  tmp ??= mkdtempSync(join(tmpdir(), 'bento-spaces-rigs-'))
  const out = join(tmp, `${file.replace(/.*\//, '')}.mjs`)
  const r = spawnSync(esbuild, [file, '--bundle', '--platform=node', '--format=esm', `--outfile=${out}`],
    { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout)
    return null
  }
  return out
}

function run(file, env) {
  const r = spawnSync(process.execPath, [file], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' })
  process.stdout.write(r.stdout ?? '')
  if (r.status !== 0) process.stderr.write(r.stderr ?? '')
  return r.status === 0
}

const failed = []
for (const rig of picked) {
  const target = rig.bundle ? bundled(rig.file) : rig.file
  if (!target) { failed.push(rig.name); console.log(`\n=== spaces/${rig.name} — DID NOT BUILD`); continue }
  for (const tz of rig.tzs ?? [null]) {
    console.log(`\n=== spaces/${rig.name}${tz ? ` — ${tz}` : ''}`)
    if (!run(target, tz ? { TZ: tz } : {})) failed.push(tz ? `${rig.name} (${tz})` : rig.name)
  }
}

if (tmp) rmSync(tmp, { recursive: true, force: true })

console.log('')
if (failed.length) {
  console.log(`FAILED: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`all spaces rigs passed (${picked.map((r) => r.name).join(', ')})`)
