#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/convert loadability gate — the most important check in the suite.
//
//   node scripts/test-convert/load.ts
//
// Every fixture package is converted and the emitted JSON is pushed through
// the REAL slides loader: parseDoc must return a document and validateDoc
// (measure:false) must report ZERO errors. The convert engine's own rigs
// prove the engine agrees with itself; only this gate proves the output loads
// in the actual app — and if it does not, nothing else matters.
//
// Mechanics: slides' validate.ts pulls render.ts, whose imports are
// extensionless and include the temml package, so plain node type-stripping
// cannot run it. Same answer as scripts/test-validate.ts: bundle with esbuild
// first. This rig does that itself — when run directly it bundles ITSELF and
// re-executes the bundle, so the runner (and a bare `node`) need no wrapper.

import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

if (!process.env.BENTO_CONVERT_LOAD_BUNDLED) {
  const self = fileURLToPath(import.meta.url)
  const root = join(dirname(self), '..', '..')
  const esbuild = join(root, 'slides', 'node_modules', '.bin', 'esbuild')
  const out = join(mkdtempSync(join(tmpdir(), 'convert-load-')), 'load.mjs')
  const b = spawnSync(esbuild, [self, '--bundle', '--platform=node', '--format=esm', `--outfile=${out}`],
    { stdio: 'inherit' })
  if (b.status !== 0) {
    console.log('  FAIL  esbuild bundle step failed')
    process.exit(1)
  }
  const r = spawnSync(process.execPath, [out], {
    stdio: 'inherit',
    env: { ...process.env, BENTO_CONVERT_LOAD_BUNDLED: '1' },
  })
  process.exit(r.status ?? 1)
}

const { convertPptx } = await import('../../kernel/src/convert/pptx.ts')
const { allFixtures } = await import('./_fixtures.ts')
const { parseDoc } = await import('../../slides/src/model.ts')
const { validateDoc } = await import('../../slides/src/validate.ts')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

for (const { name, build } of allFixtures()) {
  const result = await convertPptx(await build())
  // through JSON — the emitted document must survive as TEXT, the way it
  // actually travels (Replace from JSON…, window.bento.loadDoc)
  const parsed = parseDoc(JSON.stringify(result.doc))
  ok(parsed !== null, `${name}: parseDoc accepts the emitted document`)
  if (!parsed) continue
  const v = validateDoc(parsed, { measure: false })
  const errors = v.findings.filter((f) => f.severity === 'error')
  ok(errors.length === 0,
    `${name}: validateDoc reports zero errors (got ${errors.length}${errors.length ? `: ${errors.map((f) => f.code).join(', ')}` : ''})`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
