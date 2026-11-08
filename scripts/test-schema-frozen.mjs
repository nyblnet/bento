#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A released schema snapshot is a frozen URL. build-schema.mjs must never
// rewrite schema/slides-<v>.json once tag v<v> exists (#864 rewrote 1.2.10).
// Runs the real script in a scratch git repo laid out like this one, so the
// OLD behaviour (always write the pinned file) fails here.
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// CI has slides/node_modules in the checkout; a fresh worktree borrows the main one.
const NM = [join(root, 'slides/node_modules'), '/Users/andy/personal/bento/slides/node_modules']
  .find(p => existsSync(join(p, '.bin/esbuild')))
if (!NM) { console.error('FAIL no slides/node_modules with esbuild'); process.exit(1) }
// realpath: build-schema's "am I main" guard compares argv[1] with the module URL, and /var is a symlink on macOS
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'schema-frozen-')))
let fail = 0
const ok = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fail++ }
const git = (...a) => execFileSync('git', ['-C', tmp, ...a], { stdio: 'pipe' })

try {
  mkdirSync(join(tmp, 'slides'), { recursive: true })
  cpSync(join(root, 'scripts'), join(tmp, 'scripts'), { recursive: true })
  cpSync(join(root, 'slides/src'), join(tmp, 'slides/src'), { recursive: true })
  cpSync(join(root, 'kernel'), join(tmp, 'kernel'), { recursive: true, filter: s => !s.includes('node_modules') })
  symlinkSync(NM,join(tmp, 'slides/node_modules'))
  const ver = JSON.parse(readFileSync(join(root, 'slides/package.json'), 'utf8')).version
  writeFileSync(join(tmp, 'slides/package.json'), JSON.stringify({ version: ver }))
  mkdirSync(join(tmp, 'schema'))
  const pinned = join(tmp, 'schema', `slides-${ver}.json`)
  const run = () => execFileSync('node', [join(tmp, 'scripts/build-schema.mjs')], { cwd: tmp, stdio: ['ignore', 'pipe', 'inherit'] })
  git('init', '-q'); git('config', 'user.email', 'x@x'); git('config', 'user.name', 'x')

  // 1. untagged version: the snapshot is written freely
  writeFileSync(pinned, 'stale\n')
  run()
  ok(readFileSync(pinned, 'utf8') !== 'stale\n', 'untagged version: pinned snapshot is written')

  // 2. tagged version: a differing snapshot is left byte-for-byte alone
  const published = '{"published":true}\n'
  writeFileSync(pinned, published)
  git('add', '-A'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'release'); git('tag', `v${ver}`)
  run()
  ok(readFileSync(pinned, 'utf8') === published, `tagged v${ver}: pinned snapshot is NOT overwritten`)
  ok(readFileSync(join(tmp, 'schema/slides.json'), 'utf8').includes('"$defs"'), 'slides.json is still written')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
process.exit(fail ? 1 : 0)
