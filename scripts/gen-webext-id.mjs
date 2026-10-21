#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The extension's copy of kernel's bento/connect code (statements, recovery), GENERATED from the
// kernel reference by stripping TypeScript types — never hand-edited.
//
//   node scripts/gen-webext-id.mjs          # write home/webext/src/id/gen/*.js
//   node scripts/gen-webext-id.mjs --check  # exit 1 if they are stale
//
// WHY GENERATED. kernel/src/statements.ts is the one definition of every byte
// a host signs or checks; kernel/fixtures/identity-v1.json is the contract.
// The extension ships plain JavaScript (no bundler), so it cannot import the
// TypeScript. A hand port would pass the vectors today and drift tomorrow; a
// type-strip keeps the extension on the reference's exact logic, and --check
// (run by scripts/test-webext-id.ts) fails the build the moment they differ.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, 'home/webext/src/id/gen')
// The entry points; every module they import from kernel/src comes with them.
const ENTRY = ['statements.ts', 'address.ts', 'recovery.ts']
const VALUE_IMPORT = /^import (?!type )[^;]*?from '\.\/([a-z0-9-]+)\.ts'/gm

export function generate() {
  const out = {}
  const todo = [...ENTRY]
  const seen = new Set()
  while (todo.length) {
    const f = todo.shift()
    if (seen.has(f)) continue
    seen.add(f)
    const src = readFileSync(join(root, 'kernel/src', f), 'utf8')
    for (const m of src.matchAll(VALUE_IMPORT)) todo.push(`${m[1]}.ts`)
    let js = stripTypeScriptTypes(src, { mode: 'strip' })
    // a type-only import vanishes; value imports point at the generated siblings
    js = js.replace(/^import type .*$/gm, '').replace(/from '\.\/([a-z0-9-]+)\.ts'/g, "from './$1.js'")
    if (/from '[^']*\.ts'/.test(js)) throw new Error(`${f}: an import still points at a .ts file`)
    out[f.replace(/\.ts$/, '.js')] = `// GENERATED from kernel/src/${f} by scripts/gen-webext-id.mjs — do not edit.\n` + js
  }
  return out
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = generate()
  if (process.argv.includes('--check')) {
    let stale = 0
    for (const [name, js] of Object.entries(files)) {
      let have = ''
      try { have = readFileSync(join(OUT, name), 'utf8') } catch { /* missing */ }
      if (have !== js) { stale++; console.log(`stale: home/webext/src/id/gen/${name}`) }
    }
    if (stale) { console.log('run: node scripts/gen-webext-id.mjs'); process.exit(1) }
    console.log('home/webext/src/id/gen is current')
  } else {
    mkdirSync(OUT, { recursive: true })
    for (const [name, js] of Object.entries(files)) writeFileSync(join(OUT, name), js)
    console.log(`wrote ${Object.keys(files).join(', ')}`)
  }
}
