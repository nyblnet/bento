#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Freeze Temml's WHOLE vocabulary into scripts/fixtures/maths-coverage.json —
// run with Temml installed, only when widening the set.
//
//   cd slides && npm i --no-save temml@0.13.3 && cd .. && node scripts/maths-freeze-coverage.ts
//
// Why this exists (#540, #551). The 1.2.0 gate held maths-lite to Temml on 91
// hand-picked formulas and passed at 95%; 57 everyday commands it never listed
// fell back to raw text and nothing went red. A fixed sample cannot see what
// is not in it. So this takes EVERY command name out of Temml's source, finds
// the first minimal form Temml renders (`\cmd`, `\cmd{x}`, `a \cmd b`, …), and
// records that form with Temml's normalised tree. scripts/test-maths-coverage.ts
// then measures maths-lite against the lot, offline: how many render, how many
// are tree-identical, and — the part that stops the next #540 — a FLOOR that
// only goes up and a list of covered commands that may never fall back.
//
// The floor and the covered list are written by the rig itself
// (`node scripts/test-maths-coverage.ts --update`), which needs no Temml.
// Re-running this script keeps them.

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { treeKey } from './lib/mathml-tree.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'slides/package.json'))
const tm = require('temml')
const temml = (tm.default ?? tm) as { version: string; renderToString(s: string, o: object): string }
const src = readFileSync(join(root, 'slides/node_modules/temml/dist/temml.cjs'), 'utf8')

const render = (s: string, display: boolean): string | null => {
  try { return treeKey(temml.renderToString(s, { displayMode: display, throwOnError: true, trust: false })) } catch { return null }
}

// every control word Temml names in its source
const names = new Set<string>()
for (const m of src.matchAll(/["']\\\\([A-Za-z]+\*?)["']/g)) names.add(m[1])
// the minimal forms, most natural first: a symbol alone, then one argument, …
const forms = (c: string) => [`\\${c}`, `\\${c}{x}`, `a \\${c} b`, `\\${c}{x}{y}`, `\\${c}{x}{y}{z}`, `\\${c}[1]{x}`, `\\${c}{1}{x}`,
  `\\${c}{red}{x}`, `\\${c}{1em}`, `{\\${c} x}`, `\\${c} x`, `\\${c}_x f`, `\\left( x \\${c}| y \\right)`]

const out: Array<{ cmd: string; src: string; display: boolean; tree: string }> = []
for (const c of [...names].sort()) {
  for (const f of forms(c)) {
    const tree = render(f, true)
    if (tree) { out.push({ cmd: '\\' + c, src: f, display: true, tree }); break }
  }
}
// environments, by the names Temml registers
const envs = new Set<string>()
for (const m of src.matchAll(/names:\s*\[([^\]]*)\]/g)) for (const n of m[1].matchAll(/["']([a-zA-Z]+\*?)["']/g)) envs.add(n[1])
for (const e of [...envs].sort()) {
  const fs = [`\\begin{${e}} a & b \\\\ c & d \\end{${e}}`, `\\begin{${e}}{cc} a & b \\\\ c & d \\end{${e}}`, `\\begin{${e}}{2} a & b \\\\ c & d \\end{${e}}`, `\\begin{${e}} a \\end{${e}}`]
  for (const f of fs) {
    const tree = render(f, true)
    if (tree) { out.push({ cmd: `{${e}}`, src: f, display: true, tree }); break }
  }
}

const path = join(root, 'scripts/fixtures/maths-coverage.json')
const prev = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
writeFileSync(path, JSON.stringify({ temml: temml.version, frozen: new Date().toISOString().slice(0, 10), floor: prev.floor ?? { renders: 0, identical: 0 }, covered: prev.covered ?? [], forms: out }, null, 1) + '\n')
console.log(`froze ${out.length} commands and environments from Temml ${temml.version}`)
