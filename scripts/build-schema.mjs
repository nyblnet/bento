#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Prints the bento/slides JSON Schema (slides/src/schema.ts buildSchema) to
// schema/slides.json and a version-pinned twin schema/slides-<version>.json.
//
//   node scripts/build-schema.mjs           write the files
//   node scripts/build-schema.mjs --check   fail if slides.json is out of date (CI)
//
// WHY A FILE AND A FUNCTION. The function is the truth — it reads the gate's
// own tables, so it cannot describe a format the runtime does not accept. The
// file is what an agent fetches (https://bento.page/schema/slides.json) and
// what release.mjs publishes; committing it means a reviewer sees a schema
// change as a diff, and `--check` means it can never be stale. The same shape
// as build-modelkeys.mjs, for the same reason.
//
// schema.ts pulls in model.ts and the gate, which are not node-importable
// unbundled (kernel imports with extensions, DOM types) — so it is bundled
// with esbuild into a temp file first, the way test-validate is in CI.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(join(root, 'slides/package.json'), 'utf8')).version
const outDir = join(root, 'schema')
const OUT = join(outDir, 'slides.json')
const PINNED = join(outDir, `slides-${version}.json`)

/** Bundle schema.ts and return buildSchema. */
export async function loadBuildSchema() {
  const tmp = mkdtempSync(join(tmpdir(), 'bento-schema-'))
  const entry = join(tmp, 'entry.mjs')
  execFileSync(join(root, 'slides/node_modules/.bin/esbuild'), [
    join(root, 'slides/src/schema.ts'), '--bundle', '--platform=node', '--format=esm',
    `--outfile=${entry}`, '--log-level=error',
  ])
  const mod = await import(pathToFileURL(entry).href)
  rmSync(tmp, { recursive: true, force: true })
  return mod.buildSchema
}

/** The canonical text of the schema file for this version. */
export function schemaText(buildSchema) {
  return JSON.stringify(buildSchema(version), null, 2) + '\n'
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const buildSchema = await loadBuildSchema()
  const body = schemaText(buildSchema)
  if (process.argv.includes('--check')) {
    let current = null
    try { current = readFileSync(OUT, 'utf8') } catch { /* missing = stale */ }
    if (current !== body) {
      console.error('schema/slides.json is out of date with slides/src/schema.ts (or the gate / model keys).\nRun: node scripts/build-schema.mjs')
      process.exit(1)
    }
    const parsed = JSON.parse(body)
    console.log(`schema up to date (${Object.keys(parsed.$defs).length} definitions, bento/slides ${version})`)
  } else {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(OUT, body)
    writeFileSync(PINNED, body)
    console.log(`wrote ${OUT} and ${PINNED} (${body.length} B)`)
  }
}
