// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Which mutants a mutant suite reruns, in the release check.
//
//   const scope = await mutantScope({ suite: 'scripts/test-x-mutants.ts', rigs: ['scripts/test-x.ts'] })
//   for (const m of MUTANTS) {
//     const d = scope.decide(m, ['kernel/src/x.ts'])        // the files the mutant edits
//     if (d.skip) { scope.notRerun(m.name, d.why); continue }
//     ...run it...
//     scope.record(d, killed)
//   }
//   console.log(scope.summary())
//
// OFF unless scripts/check.mjs turns it on (BENTO_MUTANT_CACHE, set by the
// release check and the full check): run by hand, or by the quick check, every
// suite runs every mutant, as before.
//
// A mutant's verdict is a function of the mutation and of every file its rig
// reads (the suite, the rig it runs, and their whole read closure: the same
// reach map the quick check plans with, scripts/lib/check-plan.mjs). So:
//   - a mutant killed before under the same content of all of those is not
//     rerun: "cached red" (BENTO_MUTANT_CACHE/<key>, written only on a kill);
//   - with BENTO_MUTANT_SINCE (the release's base: the app's previous tag), a
//     mutant whose targets AND whose rig's whole read closure are unchanged
//     since that tag is not rerun: "unchanged since <tag>". It was red then:
//     a tag is cut only after its checks passed.
// Neither is a pass. Each prints NOT RERUN with its reason, the summary counts
// them apart from kills, and a change to any file the rig reads reruns them.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const sha = (s) => createHash('sha256').update(s).digest('hex')
const contentOf = (f) => { try { return readFileSync(join(ROOT, f)) } catch { return Buffer.from('<absent>') } }
const specOf = (m) => JSON.stringify(m, (k, v) => (typeof v === 'function' ? String(v) : v instanceof RegExp ? String(v) : v))

export async function mutantScope({ suite, rigs = [] }) {
  const cacheDir = process.env.BENTO_MUTANT_CACHE || ''
  const since = cacheDir ? process.env.BENTO_MUTANT_SINCE || '' : ''
  const label = process.env.BENTO_MUTANT_SINCE_LABEL || since.slice(0, 9)
  const counts = { killed: 0, cached: 0, unchanged: 0, run: 0 }
  if (!cacheDir) {
    return {
      on: false,
      decide: () => ({ skip: false }),
      notRerun: () => {},
      record: (d, killed) => { counts.run++; if (killed) counts.killed++ },
      summary: () => '',
      counts,
    }
  }
  const { buildGraph, reachEach, treeView } = await import('./check-plan.mjs')
  const graph = buildGraph(treeView(ROOT))
  // the check's own tooling is not what a rig reads: this helper imports the
  // planner, whose path patterns would otherwise pull the whole repo into every
  // rig's closure, so that nothing could ever count as unchanged
  for (const f of ['scripts/lib/mutant-scope.mjs', 'scripts/lib/check-plan.mjs', 'scripts/lib/check-cache.mjs', 'scripts/lib/test-tiers.mjs']) graph.edges.set(f, new Set())
  const reads = [...reachEach(graph, [suite, ...rigs]).keys()].sort()
  const base = sha(reads.map((f) => `${f}\0${sha(contentOf(f))}`).join('\n'))
  let changed = null
  if (since) {
    changed = new Set(execFileSync('git', ['-C', ROOT, 'diff', '--name-only', '--no-renames', since, 'HEAD'], { encoding: 'utf8' }).split('\n').filter(Boolean))
    for (const f of execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).split('\n')) if (f.trim()) changed.add(f.slice(3))
  }
  const closureChanged = changed ? reads.some((f) => changed.has(f)) : true
  mkdirSync(cacheDir, { recursive: true })
  return {
    on: true,
    decide(m, targets) {
      const key = sha([base, specOf(m), ...targets.map((f) => `${f}\0${sha(contentOf(f))}`)].join('\n'))
      const hit = join(cacheDir, `${key}.json`)
      if (existsSync(hit)) {
        let at = ''
        try { at = JSON.parse(readFileSync(hit, 'utf8')).at } catch { /* still a record */ }
        return { skip: true, kind: 'cached', why: `cached red: killed on ${at.slice(0, 10)} under the same content of the mutation, its targets and every file its rig reads`, key }
      }
      if (changed && !closureChanged && targets.every((f) => !changed.has(f))) {
        return { skip: true, kind: 'unchanged', why: `unchanged since ${label}: its targets and every file its rig reads are as they were at ${label}, when it was red`, key }
      }
      return { skip: false, key }
    },
    notRerun(name, why) {
      if (/cached red/.test(why)) counts.cached++
      else counts.unchanged++
      console.log(`  NOT RERUN  ${name}: ${why}`)
    },
    record(d, killed) {
      counts.run++
      if (!killed) return
      counts.killed++
      if (!d.key) return
      const f = join(cacheDir, `${d.key}.json`)
      const tmp = `${f}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ suite, at: new Date().toISOString() }) + '\n')
      renameSync(tmp, f)
    },
    summary() {
      const not = counts.cached + counts.unchanged
      return not ? `  NOT RERUN ${not}: ${counts.unchanged} unchanged since ${label || 'the base'}, ${counts.cached} cached red (neither is a pass; ${counts.run} ran)` : ''
    },
    counts,
  }
}
