#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The quick check's own rig: the plan (scripts/lib/check-plan.mjs), the tiers
// (scripts/lib/test-tiers.mjs), the result cache (scripts/lib/check-cache.mjs),
// the sweep's bookkeeping (scripts/sweep.mjs) and release.mjs's sweep gate.
//
//   node scripts/test-check.mjs
//
// WHY. The quick check decides what runs on every pull request. If its plan
// stops seeing an import, a text read, a built shell or a changed CI step, the
// rigs behind it stop running per change and nothing goes red: the quick check
// passes MORE easily, the failure this repo's gates are built against. So each
// way a step can be reached is held here against a small repository built in a
// temporary folder, with a control beside it that must NOT be reached.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planFor, setupOf } from './lib/check-plan.mjs'
import { keyOf, workBlobs } from './lib/check-cache.mjs'
import { matchTier, entryMatches, ENTRIES } from './lib/test-tiers.mjs'
import { bisect, sinceGreen, isGreen, summaryLine } from './sweep.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const tmp = mkdtempSync(join(tmpdir(), 'bento-test-check-'))
const git = (...a) => execFileSync('git', ['-C', tmp, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const put = (f, text) => { mkdirSync(dirname(join(tmp, f)), { recursive: true }); writeFileSync(join(tmp, f), text) }
const commit = (msg) => { git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg); return git('rev-parse', 'HEAD') }

try {
  // ---- a small repository shaped like this one
  put('kernel/src/a.ts', "export const a = 1\n")
  put('kernel/src/b.ts', "export const b = 2\n")
  put('kernel/src/c.ts', "import { a } from './a.ts'\nexport const c = a\n")
  put('slides/src/main.ts', "import { c } from '../../kernel/src/c.ts'\nconsole.log(c)\n")
  put('slides/package-lock.json', '{}\n')
  put('docs/notes.md', 'notes\n')
  put('scripts/test-imports.ts', "import { a } from '../kernel/src/a.ts'\nconsole.log(a)\n")
  put('scripts/test-far.ts', "import { c } from '../kernel/src/c.ts'\nconsole.log(c)\n")
  put('scripts/test-reads.mjs', "import { readFileSync } from 'node:fs'\nreadFileSync(new URL('../kernel/src/b.ts', import.meta.url))\n")
  put('scripts/test-joined.mjs', "import { join } from 'node:path'\nconst f = join(root, 'kernel', 'src', 'b.ts')\n")
  put('scripts/test-shell.mjs', "const shell = '../slides/dist-single/Bento_Slides.bento.html'\n")
  put('scripts/test-bundled.ts', "import { b } from '../kernel/src/b.ts'\n")
  put('scripts/test-lonely.ts', "console.log('reads nothing')\n")
  put('scripts/test-thing-mutants.ts', "import './test-imports.ts'\n")
  put('scripts/test-ui-browser.mjs', "const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')\nconst s = '../slides/dist-single/Bento_Slides.bento.html'\n")
  put('scripts/shell-gate.mjs', "export const gate = 1\n")
  put('.github/actions/validate-x/action.yml', `name: validate-x
runs:
  using: composite
  steps:
    - name: Install
      working-directory: slides
      shell: bento-step {0}
      run: npm ci
    - name: Build
      working-directory: slides
      shell: bento-step {0}
      run: npm run build:single
    - name: imports
      shell: bento-step {0}
      run: node scripts/test-imports.ts
    - name: far
      shell: bento-step {0}
      run: node scripts/test-far.ts
    - name: reads
      shell: bento-step {0}
      run: node scripts/test-reads.mjs
    - name: joined
      shell: bento-step {0}
      run: node scripts/test-joined.mjs
    - name: shell
      shell: bento-step {0}
      run: node scripts/test-shell.mjs
    - name: bundled
      shell: bento-step {0}
      run: |
        slides/node_modules/.bin/esbuild scripts/test-bundled.ts --bundle --outfile="$RUNNER_TEMP/b.mjs"
        node "$RUNNER_TEMP/b.mjs"
    - name: lonely
      shell: bento-step {0}
      run: node scripts/test-lonely.ts
    - name: mutants
      shell: bento-step {0}
      run: node scripts/test-thing-mutants.ts
    - name: gate
      shell: bento-step {0}
      run: node scripts/shell-gate.mjs slides/dist-single/Bento_Slides.bento.html
`)
  put('.github/workflows/ci-full.yml', `name: CI (full)
on:
  workflow_dispatch:
jobs:
  validate-builds:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/validate-x
  x-browser:
    runs-on: ubuntu-latest
    steps:
      - name: browser
        run: |
          npm install --prefix "$RUNNER_TEMP/bento-browser" --no-package-lock --ignore-scripts playwright@1.0.0
          "$RUNNER_TEMP/bento-browser/node_modules/.bin/playwright" install --with-deps chromium
          echo "PLAYWRIGHT_MODULE=$RUNNER_TEMP/bento-browser/node_modules/playwright/index.mjs" >> "$GITHUB_ENV"
      - run: node scripts/test-ui-browser.mjs
`)
  git('init', '-q', '-b', 'main')
  const base = commit('base')

  const planOf = (edit) => {
    git('checkout', '-q', '--detach', base)
    edit()
    const head = commit('change')
    const p = planFor(tmp, base, head)
    git('checkout', '-q', '--detach', base)
    return { p, by: (name) => p.rigs.find((s) => s.name === name) }
  }

  console.log('setup steps are providers, not steps')
  ok(JSON.stringify(setupOf('npm ci', 'dash')) === '["install:dash"]', 'npm ci in a working directory installs that app')
  ok(JSON.stringify(setupOf('npm ci --prefix type\nnpm run build:single --prefix type')) === '["install:type","build:type"]', 'npm ci and build:single with --prefix')
  ok(setupOf('npm run build:sealtest\nnode ../scripts/test-seal-gate.mjs', 'slides') === null, 'a step that builds AND runs a rig is a rig step, run as written')

  console.log('\nwhat a change reaches')
  {
    const { p, by } = planOf(() => put('kernel/src/a.ts', 'export const a = 3\n'))
    ok(by('imports').distance === 1, `a rig importing the changed file is at distance 1 (got ${by('imports').distance})`)
    ok(by('far').distance === 2, `a rig importing it through another file is at distance 2 (got ${by('far').distance})`)
    ok(by('lonely').distance === Infinity, 'control: a rig that reads nothing of it is not reached')
    ok(by('reads').distance === Infinity, 'control: a rig reading kernel/src/b.ts is not reached by a.ts')
    ok(by('shell').distance >= 2 && by('shell').distance !== Infinity, `a rig reading slides' built shell is reached through the build (distance ${by('shell').distance})`)
    ok(by('shell').needs.includes('build:slides'), 'and needs the slides build')
    ok(JSON.stringify(p.wantBuilds) === '["slides"]', `shared code the build reads wants the representative build (${p.wantBuilds})`)
  }
  {
    const { by } = planOf(() => put('kernel/src/b.ts', 'export const b = 9\n'))
    ok(by('reads').distance === 1, `a rig reading the file as text (new URL literal) is at distance 1 (got ${by('reads').distance})`)
    ok(by('joined').distance === 1, `a rig naming it as join(root, 'kernel', 'src', 'b.ts') is at distance 1 (got ${by('joined').distance})`)
    ok(by('bundled').distance === 1, `a rig bundled by esbuild before it runs is read from the bundled file (got ${by('bundled').distance})`)
    ok(by('bundled').scripts.includes('scripts/test-bundled.ts'), 'and the bundled rig counts as the step\'s script (its tier and its needs come from it)')
    ok(by('shell').distance === Infinity, 'control: slides\' build does not read b.ts, so the shell rig is not reached')
  }
  {
    const { p, by } = planOf(() => put('docs/notes.md', 'more notes\n'))
    ok(p.rigs.every((s) => s.distance === Infinity), 'a docs-only change reaches no step')
    ok(by('imports').distance === Infinity && !p.wantBuilds.length, 'and builds nothing')
  }
  {
    const { by } = planOf(() => put('scripts/test-lonely.ts', "console.log('changed')\n"))
    ok(by('lonely').distance === 0, 'a changed rig is at distance 0')
  }
  {
    const { by } = planOf(() => {
      const f = join(tmp, '.github/actions/validate-x/action.yml')
      writeFileSync(f, readFileSync(f, 'utf8').replace('run: node scripts/test-lonely.ts', 'run: node --no-warnings scripts/test-lonely.ts'))
    })
    ok(by('lonely').distance === 0, 'a step whose CI definition changed is at distance 0')
    ok(by('imports').distance === Infinity, 'control: an unchanged step beside it is not reached')
  }

  console.log('\ntiers')
  {
    const { by } = planOf(() => put('kernel/src/a.ts', 'export const a = 4\n'))
    ok(by('imports').tier.tier === 'fast', 'a plain rig is fast')
    ok(by('mutants').tier.tier === 'full', 'a mutant suite is full')
    const step = by('node scripts/test-ui-browser.mjs')
    ok(!!step && step.needs.includes('browser') && step.tier.tier === 'full', 'a rig driving a browser is full unless it is a headless load')
    ok(by('gate').tier.pin === true, 'the splice gate is pinned: run whenever reached, whatever the budget')
  }
  ok(ENTRIES.every((e) => e.why && e.tier), 'every tier entry has a tier and a reason')
  ok(matchTier({ scripts: ['scripts/test-x.ts'], run: 'node scripts/test-x.ts', job: 'home-android-unit', needs: [] }).tier === 'deep', 'a step that needs an Android SDK is deep')
  ok(entryMatches({ rig: '*-mutants.{ts,mjs}' }, { scripts: ['scripts/test-a-mutants.mjs'], run: '', job: '' }) && !entryMatches({ rig: '*-mutants.{ts,mjs}' }, { scripts: ['scripts/test-mutantsx.ts'], run: '', job: '' }), 'tier globs match whole names')

  console.log('\nthe result cache keys on content')
  {
    git('checkout', '-q', '--detach', base)
    const b1 = workBlobs(tmp)
    const k1 = keyOf(['kernel/src/a.ts'], b1, { sig: 's' })
    put('docs/notes.md', 'unrelated edit\n')
    const k2 = keyOf(['kernel/src/a.ts'], workBlobs(tmp), { sig: 's' })
    put('kernel/src/a.ts', 'export const a = 5\n')
    const k3 = keyOf(['kernel/src/a.ts'], workBlobs(tmp), { sig: 's' })
    ok(k1 === k2, 'an edit to a file the step does not read keeps its key')
    ok(k1 !== k3, 'an uncommitted edit to a file it reads changes its key')
    ok(keyOf(['kernel/src/a.ts'], b1, { sig: 't' }) !== k1, 'a changed step definition changes its key')
    git('checkout', '-q', '--', '.')
  }

  console.log('\nthe sweep')
  {
    const dir = mkdtempSync(join(tmpdir(), 'bento-sweeps-'))
    const commits = ['c1', 'c2', 'c3', 'c4', 'c5']
    writeFileSync(join(dir, 'c2.json'), JSON.stringify({ sha: 'c2', ok: true }))
    const s = sinceGreen('c5', { dir, revList: () => [...commits].reverse().join('\n') })
    ok(s.green === 'c2' && s.commits.join() === 'c3,c4,c5', `commits since the last green sweep (${s.commits})`)
    const found = await bisect(['c3', 'c4', 'c5'], async (c) => c >= 'c4')
    ok(found.sha === 'c4', `bisect names the first bad commit (${found.sha})`)
    ok(isGreen('c2', dir) && !isGreen('c5', dir), 'only a commit with a green result is green')
    writeFileSync(join(dir, 'c5.json'), JSON.stringify({ sha: 'c5', ok: false, failures: [{ label: 'test-x.ts' }], counts: {} }))
    ok(!isGreen('c5', dir) && /RED: test-x\.ts/.test(summaryLine(JSON.parse(readFileSync(join(dir, 'c5.json'), 'utf8')))), 'a red sweep names what failed')
    rmSync(dir, { recursive: true, force: true })
  }

  console.log('\nrelease.mjs waits for a green sweep')
  {
    const rel = readFileSync(join(root, 'scripts/release.mjs'), 'utf8')
    const gate = rel.indexOf('// SWEEP GATE')
    ok(gate > 0 && /isGreen\(head\)/.test(rel.slice(gate)) && /process\.exit\(1\)/.test(rel.slice(gate, gate + 2000)), 'release.mjs refuses a commit without a green sweep')
    ok(gate > 0 && gate < rel.indexOf("execFileSync('npm', ['run', 'build:single']"), 'and refuses before it builds or signs anything')
    ok(/if \(!args\.includes\('--out'\)\)/.test(rel.slice(gate, gate + 1500)), 'a rehearsal (--out: a throwaway key, nothing published) is not held')
    ok(/--untracked-files=no/.test(rel.slice(gate, gate + 1500)), 'and a tree that differs from the swept commit is refused')
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
