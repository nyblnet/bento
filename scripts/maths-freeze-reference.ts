#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Freeze Temml's rendering of the maths reference set into
// scripts/fixtures/maths-reference.json — run ONCE, with Temml installed.
//
//   cd slides && npm i --no-save temml@0.13.3 && cd .. && node scripts/maths-freeze-reference.ts
//
// Temml left the shell on 2026-09-15 (maths-lite replaced it), so the rig
// cannot ask it live. This file holds what it said: the 91 formulas the spike
// measured against — 11 from our own decks and rigs, 80 from the categories
// of Temml's supported-functions page — as NORMALISED trees (scripts/lib/
// mathml-tree.ts). scripts/test-maths-lite.ts compares maths-lite's trees to
// these and requires ≥95% identical, with the known residuals allowlisted.
// Pixels were measured in the spike (97.8% identical, Chrome) and stay out of
// CI: there is no Temml to draw the other side.
//
// Re-run only to widen the set; the fixture records the Temml version.

import { writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { treeKey } from './lib/mathml-tree.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'slides/package.json'))
const temml = require('temml') as { version: string; renderToString(s: string, o: object): string }

const set = JSON.parse(readFileSync(join(root, 'scripts/fixtures/maths-set.json'), 'utf8')) as Array<{ src: string; display: boolean; from: string }>
const out = set.map((f) => {
  let tree: string | null = null
  try { tree = treeKey(temml.renderToString(f.src, { displayMode: f.display, throwOnError: true, trust: false })) } catch { tree = null }
  return { ...f, tree }
})
writeFileSync(join(root, 'scripts/fixtures/maths-reference.json'), JSON.stringify({ temml: temml.version, frozen: new Date().toISOString().slice(0, 10), formulas: out }, null, 1) + '\n')
console.log(`froze ${out.length} formulas from Temml ${temml.version}; ${out.filter((o) => o.tree).length} rendered`)
