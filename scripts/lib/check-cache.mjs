// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The quick check's result cache: a step that passed is not run again until
// something it reads changes. Read by scripts/check.mjs and scripts/sweep.mjs.
//
// THE KEY of a step is a hash of: its CI definition (name, run text, env,
// working directory), the tier it ran at (the sweep's deeper env changes it),
// the content of every file it reads (git blob ids: from the index for clean
// files, `git hash-object` for modified and untracked ones), the keys of the
// builds it reads, and the toolchain (node's version, the lockfiles of the
// installs it uses, the pinned browser). Nothing else: not the commit, not the
// branch, so the same tree checked from two worktrees shares its passes.
//
// Only passes are remembered, never failures or skips. A cached step prints
// "ok (cached, <commit>)". The store is a folder OUTSIDE the repo,
// ~/personal/bento-check-cache (BENTO_CHECK_CACHE), safe for several runs at
// once (every write is a rename). On GitHub, ci.yml keeps it with actions/cache.
//
//   steps/<key>.json     a remembered pass: { id, ms, commit, at }
//   builds/<key>/        a built shell (dist-single), restored instead of rebuilt
//   times.json           the last duration of each step, by its definition
//   sweeps/<sha>.json    the sweep's results (scripts/sweep.mjs)

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const cacheRoot = () => process.env.BENTO_CHECK_CACHE || join(homedir(), 'personal', 'bento-check-cache')

const sha = (s) => createHash('sha256').update(s).digest('hex')

/** Every file's blob id in the working tree: Map<path, blob>. */
export function workBlobs(root) {
  const git = (args, input) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, input })
  const blobs = new Map()
  for (const line of git(['ls-files', '-s']).split('\n')) {
    const m = /^\d+ ([0-9a-f]+) \d\t(.+)$/.exec(line)
    if (m) blobs.set(m[2], m[1])
  }
  const dirty = new Set([
    ...git(['diff', '--name-only', '--no-renames']).split('\n'),
    ...git(['ls-files', '-o', '--exclude-standard']).split('\n'),
  ].filter(Boolean))
  const present = [...dirty].filter((f) => existsSync(join(root, f)))
  if (present.length) {
    const ids = git(['hash-object', '--stdin-paths'], present.join('\n') + '\n').trim().split('\n')
    present.forEach((f, i) => blobs.set(f, ids[i]))
  }
  for (const f of dirty) if (!present.includes(f)) blobs.delete(f)
  return blobs
}

/** The same map for a commit (no working tree). */
export function commitBlobs(root, rev) {
  const out = execFileSync('git', ['-C', root, 'ls-tree', '-r', rev], { encoding: 'utf8', maxBuffer: 1 << 30 })
  const blobs = new Map()
  for (const line of out.split('\n')) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line)
    if (m) blobs.set(m[2], m[1])
  }
  return blobs
}

/** The toolchain versions keys include: node, and each lockfile's blob. */
export function toolchain(blobs) {
  const locks = {}
  for (const a of ['slides', 'spaces', 'dash', 'type']) locks[a] = blobs.get(`${a}/package-lock.json`) ?? null
  return { node: process.version, locks }
}

/** The key of anything that reads `files` (an iterable of paths) under `extra` (any JSON). */
export function keyOf(files, blobs, extra) {
  const h = createHash('sha256')
  h.update(JSON.stringify(extra))
  for (const f of [...files].sort()) h.update(`\n${f}\0${blobs.get(f) ?? '-'}`)
  return h.digest('hex').slice(0, 32)
}

function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 1) + '\n')
  renameSync(tmp, file)
}

export function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** A remembered pass of the step with this key, or null. */
export const cached = (root, key) => readJson(join(root, 'steps', `${key}.json`))
export const remember = (root, key, entry) => writeJson(join(root, 'steps', `${key}.json`), { ...entry, at: new Date().toISOString() })

/** Last durations, by step definition (signature): { [sig]: ms }. */
export function readTimes(root) { return readJson(join(root, 'times.json')) ?? {} }
export function writeTimes(root, updates) {
  if (!Object.keys(updates).length) return
  const t = { ...readTimes(root), ...updates }
  writeJson(join(root, 'times.json'), t)
}

/** A short label for the commit a pass was earned on: <sha> or <sha>+dirty. */
export function commitLabel(root) {
  try {
    const head = execFileSync('git', ['-C', root, 'rev-parse', '--short=9', 'HEAD'], { encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()
    return dirty ? `${head}+dirty` : head
  } catch { return 'unknown' }
}

export { sha, writeJson }
