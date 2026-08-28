#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Run every bento/spaces rig the way CI runs it.
//
//   node scripts/test-spaces.mjs [name…]      # all, or just the ones named
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
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
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

const only = process.argv.slice(2)
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
