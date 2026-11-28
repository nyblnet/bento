// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The quick check's plan: which CI steps a diff reaches, and what each needs.
// Read by scripts/check.mjs (which runs the plan) and scripts/sweep.mjs.
//
// THE CATALOG IS CI ITSELF. Every step of every job in .github/workflows/ and
// of every validate-<zone> action is a step here, run with the same text, env
// and working directory CI gives it. A new rig is still registered the one way
// it always was: a step at the end of its zone's validate action, or a job in
// its ci-<zone>.yml. Nothing here has to be told about it.
//
// Setup steps (npm ci, build:single, build:sealtest, the pinned Playwright and
// jsdom installs, PATH lines, `uses:` actions, apt/brew) are not run as
// written: they become PROVIDERS, made once per run and shared, so twenty jobs
// that each build slides build it once.
//
// WHAT A STEP READS. The scripts its run text names, and from each of them,
// transitively: static imports, dynamic imports with a literal specifier, and
// string literals that name a file or folder in the repo (a rig reading
// kernel/src/save.ts as text reads it). A step that reads a built shell
// (<app>/dist-single, dist-sealtest) reads everything that build reads: the
// app's folder and everything it imports. A step's own YAML counts too: a step
// whose definition changed is at distance 0.
//
// The distance of a step from a diff is the fewest edges from its scripts to a
// changed file (0: the script or the step changed; a built shell adds 2).
// When the graph cannot see what a rig reads, the tiers file says so and the
// rig goes to `full` (scripts/lib/test-tiers.mjs), never the other way round.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, posix } from 'node:path'
import { matchTier } from './test-tiers.mjs'

export const APPS = ['slides', 'spaces', 'dash', 'type']
/** The app built when shared code changed and no app's own source did. */
export const REPRESENTATIVE = 'slides'
const CODE = /\.(?:ts|mts|cts|mjs|js|cjs|tsx)$/
const CI_FILE = /^\.github\/(?:workflows\/[^/]+\.ya?ml|actions\/[^/]+\/action\.ya?ml)$/

// ---------------------------------------------------------------- the tree

const git = (root, args, input) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, input, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] })

/**
 * A view of the repo at `head` (a commit) or, with no head, the working tree
 * (tracked plus untracked, ignored files left out): { files, read(f) }.
 */
export function treeView(root, head = null) {
  if (head) {
    const files = git(root, ['ls-tree', '-r', '--name-only', head]).split('\n').filter(Boolean)
    const cache = new Map()
    return {
      files,
      read(f) {
        if (!cache.has(f)) {
          try { cache.set(f, git(root, ['show', `${head}:${f}`])) } catch { cache.set(f, null) }
        }
        return cache.get(f)
      },
    }
  }
  const files = git(root, ['ls-files', '-co', '--exclude-standard']).split('\n').filter(Boolean)
    .filter((f) => { try { return statSync(join(root, f)).isFile() } catch { return false } })
  return { files, read: (f) => { try { return readFileSync(join(root, f), 'utf8') } catch { return null } } }
}

/** The merge-base of HEAD with main (origin/main when there is no local main). */
export function defaultRef(root) {
  for (const b of ['origin/main', 'main']) {
    try { return git(root, ['merge-base', 'HEAD', b]).trim() } catch { /* next */ }
  }
  throw new Error('no merge-base with main (fetch origin main, or pass a ref)')
}

/** Files changed since `ref`: committed ref...HEAD (or ref...head), plus, with no head, the working tree. */
export function changedFiles(root, ref, head = null) {
  const out = new Set(git(root, ['diff', '--name-only', '--no-renames', ref, head ?? 'HEAD']).split('\n').filter(Boolean))
  if (!head) {
    for (const f of git(root, ['diff', '--name-only', '--no-renames', 'HEAD']).split('\n').filter(Boolean)) out.add(f)
    for (const f of git(root, ['ls-files', '-o', '--exclude-standard']).split('\n').filter(Boolean)) out.add(f)
  }
  return [...out].sort()
}

// ---------------------------------------------------------------- the import graph

const IMPORT_RES = [
  /(?:^|[^\w$.])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"\n]+)['"]/g,
  /(?:^|[^\w$.])import\s*['"]([^'"\n]+)['"]/g,
  /\bimport\(\s*['"`]([^'"`$\n]+)['"`]\s*[,)]/g,
  /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
]
const LITERAL = /'([^'\n\\]{2,240})'|"([^"\n\\]{2,240})"|`([^`$\n\\]{2,240})`/g
const JOINED = /\b(?:join|resolve)\(([^()\n]{0,400})\)/g

/** The graph of what each code file reads: { edges: Map<file, Set<file|dir/>>, bare: Map<file, Set<pkg>>, has(f), dirFiles(prefix) }. */
export function buildGraph(view) {
  const fileSet = new Set(view.files)
  const dirs = new Set()
  for (const f of view.files) {
    let d = posix.dirname(f)
    while (d !== '.' && !dirs.has(d)) { dirs.add(d); d = posix.dirname(d) }
  }
  const resolveFile = (p) => {
    if (fileSet.has(p)) return p
    for (const ext of ['.ts', '.mts', '.mjs', '.js', '.tsx', '.json', '/index.ts', '/index.mjs', '/index.js']) if (fileSet.has(p + ext)) return p + ext
    const js = /\.(m?)js$/.exec(p)
    if (js && fileSet.has(p.slice(0, -js[0].length) + (js[1] ? '.mts' : '.ts'))) return p.slice(0, -js[0].length) + (js[1] ? '.mts' : '.ts')
    return null
  }
  const clean = (p) => {
    const n = posix.normalize(p)
    return n.startsWith('../') || n === '..' ? null : n.replace(/^\.\//, '').replace(/\/$/, '')
  }
  const edges = new Map()
  const imports = new Map()
  const bare = new Map()
  for (const f of view.files) {
    if (!CODE.test(f)) continue
    const text = view.read(f)
    if (text == null) continue
    const out = new Set()
    const imp = new Set()
    const pk = new Set()
    const here = posix.dirname(f)
    const addSpec = (spec) => {
      if (/^(?:node:|https?:|data:)/.test(spec)) return
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const p = clean(spec.startsWith('/') ? spec.slice(1) : posix.join(here, spec))
        const r = p && resolveFile(p)
        if (r) { out.add(r); imp.add(r) }
      } else {
        pk.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
        // a deep import into an app's node_modules is a literal path below
      }
    }
    for (const re of IMPORT_RES) for (const m of text.matchAll(re)) addSpec(m[1])
    // literals naming a repo path: relative to the file, then to the repo root
    const addPath = (s, dirsToo) => {
      if (s.length < 3 || /\s/.test(s) || /[*?<>|{}]/.test(s)) return
      for (const p of [clean(posix.join(here, s)), clean(s.replace(/^\/+/, ''))]) {
        if (!p) continue
        const r = resolveFile(p)
        if (r && r !== f) { out.add(r); return }
        if (dirsToo && dirs.has(p) && !/(?:^|\/)(?:node_modules|dist[\w-]*)$/.test(p)) { out.add(p + '/'); return }
      }
    }
    for (const m of text.matchAll(LITERAL)) {
      const s = m[1] ?? m[2] ?? m[3]
      if (s.includes('/') || /\.\w{1,5}$/.test(s)) addPath(s, s.includes('/'))
    }
    for (const m of text.matchAll(JOINED)) {
      const parts = []
      for (const a of m[1].split(',')) {
        const lit = /^\s*['"]([^'"]+)['"]\s*$/.exec(a)
        if (lit) parts.push(lit[1])
        else if (parts.length) { if (parts.length > 1) addPath(parts.join('/'), true); parts.length = 0 }
      }
      if (parts.length > 1) addPath(parts.join('/'), true)
    }
    edges.set(f, out)
    imports.set(f, imp)
    bare.set(f, pk)
  }
  const dirMemo = new Map()
  const reachMemo = new Map()
  return {
    files: view.files,
    edges,
    imports,
    bare,
    reachMemo,
    has: (f) => fileSet.has(f),
    dirFiles: (prefix) => {
      if (!dirMemo.has(prefix)) dirMemo.set(prefix, view.files.filter((x) => x.startsWith(prefix)))
      return dirMemo.get(prefix)
    },
    read: view.read,
  }
}

/** reach() from each root alone, memoized, merged into `into` at `base`. */
export function reachEach(graph, roots, base = 0, into = new Map()) {
  for (const r of roots) {
    if (!graph.reachMemo.has(r)) graph.reachMemo.set(r, reach(graph, [r], 0))
    for (const [f, d] of graph.reachMemo.get(r)) if (!(into.get(f) <= d + base)) into.set(f, d + base)
  }
  return into
}

/** The files `roots` IMPORT, transitively (no text reads), inside `prefix`. */
export function importClosure(graph, roots, prefix = '') {
  const seen = new Set()
  const q = roots.filter((r) => graph.has(r))
  while (q.length) {
    const f = q.pop()
    if (seen.has(f)) continue
    seen.add(f)
    for (const e of graph.imports.get(f) ?? []) if (e.startsWith(prefix)) q.push(e)
  }
  return seen
}

/** Distance from `roots` to every file they read (BFS over the graph): Map<file, distance>. */
export function reach(graph, roots, base = 0, into = new Map()) {
  const q = []
  for (const r of roots) if (graph.has(r) && !(into.get(r) <= base)) { into.set(r, base); q.push(r) }
  while (q.length) {
    const f = q.shift()
    const d = into.get(f)
    for (const e of graph.edges.get(f) ?? []) {
      const targets = e.endsWith('/') ? graph.dirFiles(e) : [e]
      for (const t of targets) {
        if (into.has(t) && into.get(t) <= d + 1) continue
        into.set(t, d + 1)
        q.push(t)
      }
    }
  }
  return into
}

// ---------------------------------------------------------------- the CI catalog

/** YAML → JSON, through Ruby's YAML (on macOS and on GitHub's runners), for many texts at once. */
export function parseYaml(texts) {
  const out = execFileSync('ruby', ['-ryaml', '-rjson', '-e',
    'puts JSON.generate(JSON.parse(STDIN.read).map { |t| YAML.load(t) })'], { input: JSON.stringify(texts), encoding: 'utf8', maxBuffer: 1 << 28 })
  return JSON.parse(out)
}

const SETUP_LINES = [
  // [pattern, providers(match, wd)]
  [/^npm ci(?: --prefix (\S+))?(?: --no-audit| --no-fund)*$/, (m, wd) => [`install:${m[1] ?? wd}`]],
  [/^npm run build:single(?: --prefix (\S+))?$/, (m, wd) => [`build:${m[1] ?? wd}`]],
  [/^npm run build:sealtest(?: --prefix (\S+))?$/, (m, wd) => [`sealtest:${m[1] ?? wd}`]],
  [/^npm install --prefix "\$RUNNER_TEMP\/bento-browser" .*playwright@[\d.]+$/, () => ['browser']],
  [/^"\$RUNNER_TEMP\/bento-browser\/node_modules\/\.bin\/playwright" install\b.*$/, () => ['browser']],
  [/^echo "PLAYWRIGHT_MODULE=.*>> "\$GITHUB_ENV"$/, () => ['browser']],
  [/^npm install --prefix "\$GITHUB_WORKSPACE" .*jsdom@[\d.]+$/, () => ['jsdom']],
  [/^echo "\$GITHUB_WORKSPACE\/scripts\/ci" >> "\$GITHUB_PATH"$/, () => []],
  [/^sudo dmesg\b.*$/, () => []],
  // the zone gates decided whether a PR ran a zone's jobs; the plan decides now
  [/^scripts\/ci\/zone-gate '.*'$/, () => []],
]

/** CI files that hold no rig: the quick check itself, and the build-size report. */
const NOT_A_CATALOG = new Set(['.github/workflows/ci.yml', '.github/workflows/pr-build-size.yml', '.github/workflows/pr-build-size-comment.yml'])

/** The providers a step's run text consists of, or null when it is not purely setup. */
export function setupOf(run, wd = '.') {
  const lines = run.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  if (!lines.length) return []
  const out = []
  for (const l of lines) {
    const hit = SETUP_LINES.find(([re]) => re.test(l))
    if (!hit) return null
    out.push(...hit[1](hit[0].exec(l), wd))
  }
  return out
}

/** The runner label a job needs, reduced to a platform: linux, macos, windows. */
const platformOf = (runsOn) => /windows/.test(String(runsOn)) ? 'windows' : /macos/.test(String(runsOn)) ? 'macos' : 'linux'

/**
 * Every CI step, in CI's order, from the workflows and the actions they use.
 * A step: { id, file, job, name, run, env, wd, platform, setup (providers), scripts, uses }.
 * A job: { id, file, platform, providers (from its setup steps), steps }.
 */
export function loadCatalog(view, { all = false } = {}) {
  const ciPaths = view.files.filter((f) => CI_FILE.test(f)).sort()
  const texts = ciPaths.map((f) => view.read(f) ?? '')
  const docs = parseYaml(texts)
  const byPath = new Map(ciPaths.map((p, i) => [p, { text: texts[i], doc: docs[i] ?? {} }]))
  const actionSteps = (name) => byPath.get(`.github/actions/${name}/action.yml`)?.doc?.runs?.steps ?? null
  const jobs = []
  const steps = []
  const usedActions = new Set()
  const add = (job, s, file, idx, extraEnv = {}, matrix = {}) => {
    const sub = (v) => String(v ?? '').replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, k) => String(matrix[k] ?? ''))
    const run = sub(s.run)
    const wd = s['working-directory'] ? posix.normalize(sub(s['working-directory'])) : '.'
    const env = { ...extraEnv }
    for (const [k, v] of Object.entries(s.env ?? {})) env[k] = sub(v)
    const step = {
      id: `${job.id}#${idx}`,
      file,
      job: job.id,
      name: sub(s.name) || (s.uses ? `uses ${s.uses}` : run.split('\n')[0].slice(0, 80)),
      run,
      env,
      wd,
      shell: s.shell ?? null,
      uses: s.uses ?? null,
      platform: job.platform,
      setup: s.uses ? [] : setupOf(run, wd),
      scripts: [],
    }
    // the scripts the step runs: `node [flags] <path>`, and scripts/ci helpers
    for (const m of run.matchAll(/\bnode\s+(?:--[\w-]+(?:=\S+)?\s+)*((?:\.\.\/)*[\w./-]+\.(?:ts|mjs|js|cjs))\b/g)) {
      const p = posix.normalize(posix.join(wd, m[1]))
      if (!p.startsWith('..')) step.scripts.push(p)
    }
    for (const m of run.matchAll(/(?:^|\s)((?:\.\.\/)*scripts\/ci\/[\w-]+)/g)) step.scripts.push(posix.normalize(posix.join(wd, m[1])))
    for (const m of run.matchAll(/(?:^|\s|\()\.\/([\w./-]+\.sh)\b/g)) step.scripts.push(posix.normalize(posix.join(wd, m[1])))
    // any other script path the text names: a rig bundled first (esbuild scripts/test-x.ts …), a fixture runner
    for (const m of run.matchAll(/(?:^|[\s="'(])((?:\.\.\/)*(?:[\w-]+\/)+[\w.-]+\.(?:ts|mts|mjs|js|cjs))(?=$|[\s"';)])/gm)) {
      const p = posix.normalize(posix.join(wd, m[1]))
      if (!p.startsWith('..') && !/node_modules|RUNNER_TEMP/.test(p)) step.scripts.push(p)
    }
    step.scripts = [...new Set(step.scripts)]
    step.signature = hash(JSON.stringify([step.name, step.run, step.env, step.wd, step.uses, s.with ?? null]))
    job.steps.push(step)
    steps.push(step)
    return step
  }
  for (const [file, { doc }] of byPath) {
    if (!file.startsWith('.github/workflows/') || (!all && NOT_A_CATALOG.has(file))) continue
    for (const [jid, j] of Object.entries(doc.jobs ?? {})) {
      const matrices = expandMatrix(j.strategy?.matrix)
      for (const matrix of matrices) {
        const show = (v) => (v && typeof v === 'object' ? Object.values(v).join(' ') : String(v))
        const suffix = Object.keys(matrix).length ? ` (${Object.values(matrix).map(show).join(', ')})` : ''
        const job = { id: `${jid}${suffix}`, file, platform: platformOf(j['runs-on']), steps: [], needs: [].concat(j.needs ?? []), env: j.env ?? {} }
        jobs.push(job)
        let i = 0
        for (const s of j.steps ?? []) {
          const m = /^\.\/\.github\/actions\/([\w.-]+)$/.exec(s.uses ?? '')
          if (m) {
            usedActions.add(m[1])
            const inner = actionSteps(m[1]) ?? []
            for (const a of inner) add(job, a, `.github/actions/${m[1]}/action.yml`, i++, job.env, matrix)
          } else add(job, s, file, i++, job.env, matrix)
        }
        let providers = []
        for (const st of job.steps) {
          if (st.setup) providers.push(...st.setup)
          st.jobProviders = [...new Set(providers)]
        }
        job.providers = [...new Set(providers)]
      }
    }
  }
  return { jobs, steps, ciPaths, usedActions }
}

function expandMatrix(m) {
  if (!m || typeof m !== 'object') return [{}]
  let out = [{}]
  for (const [k, vs] of Object.entries(m)) {
    if (!Array.isArray(vs)) continue
    out = out.flatMap((o) => vs.map((v) => ({ ...o, [k]: v })))
  }
  return out
}

export const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 20)

// ---------------------------------------------------------------- what a step needs and reads

/**
 * What the text scan gets wrong, by rig, each with why: the built shells it
 * reads (`builds`) and providers it does not need (`drop`). The scan reads
 * `<app>/dist-single/` and Playwright in a rig and in the scripts/ code it
 * imports; these say otherwise. When unsure, a rig goes to `full`
 * (test-tiers.mjs), not here.
 */
export const ARTIFACTS = [
  { rig: 'test-ci-skips.mjs', builds: () => [], why: 'names spaces/dist-single only inside skip-line fixtures it matches; reads no shell' },
  { rig: 'test-release-channel.mjs', builds: (s) => [/--app[= ](\w+)/.exec(s.run)?.[1] ?? 'slides'], why: 'rehearses release.mjs for the one app its --app names' },
  { rig: 'test-shell-standalone.mjs', builds: () => APPS, why: 'checks every app\'s built shell (the list comes from apps.mjs, not a path the scan can read)' },
  { rig: 'test-ci-registered.ts', builds: () => [], drop: ['browser', 'jsdom'], why: 'imports this planner, whose patterns name shells and Playwright as data' },
  { rig: 'test-check.mjs', builds: () => [], drop: ['browser', 'jsdom'], why: 'its scratch repository names a shell and Playwright as fixture text' },
]

/** Every app's build inputs: the app's folder (not its outputs) and everything its code imports. */
export function buildInputs(graph, app) {
  const own = graph.files.filter((f) => f.startsWith(`${app}/`))
  const d = reachEach(graph, own.filter((f) => CODE.test(f)), 0)
  for (const f of own) d.set(f, 0)
  reachEach(graph, ['scripts/postbuild-compress.mjs'], 0, d)
  return d
}

/**
 * Fill in each rig step's needs and reads:
 *   step.reads: Map<file, distance>   step.needs: providers   step.builds: apps whose shell it reads
 */
export function annotate(catalog, graph) {
  const builds = new Map(APPS.map((a) => [a, buildInputs(graph, a)]))
  for (const step of catalog.steps) {
    if (step.setup || step.uses) continue
    step.scripts = step.scripts.filter((f) => graph.has(f))
    const reads = reachEach(graph, step.scripts, 0)
    // tsc and other app-local tools: the project they check is what they read
    const tsc = /(?:^|\s)(?:\S*\/)?tsc\s+(-b|-p\s+(\S+))/.exec(step.run)
    if (tsc) {
      const proj = posix.normalize(posix.join(step.wd, tsc[2] ?? '.'))
      const own = graph.files.filter((f) => f.startsWith(`${proj}/`) && !/\/(?:dist[\w-]*|node_modules)\//.test(f))
      for (const f of own) if (!reads.has(f)) reads.set(f, 1)
      reachEach(graph, own.filter((f) => CODE.test(f)), 1, reads)
    }
    // files outside scripts/ that the run text names directly (fixtures, manifests)
    for (const m of step.run.matchAll(/(?:^|\s|=)((?:\.\.\/)*[\w-]+\/[\w./-]+)/g)) {
      const p = posix.normalize(posix.join(step.wd, m[1]))
      if (graph.has(p) && !reads.has(p)) reachEach(graph, [p], 0, reads)
    }
    // a non-node step (a shell script, gradle, cargo, xcodebuild, swift) reads its working directory
    if (!step.scripts.some((s) => CODE.test(s)) && !tsc && step.wd !== '.') {
      for (const f of graph.dirFiles(`${step.wd}/`)) if (!reads.has(f)) reads.set(f, 1)
    }
    // what the scripts/ half of its closure says it needs
    // (what it IMPORTS inside scripts/, not every file it reads as text: a rig
    // naming another script in a comment does not need that script's browser)
    const text = [step.run, ...[...importClosure(graph, step.scripts, 'scripts/')].map((f) => graph.read(f) ?? '')].join('\n')
    const needs = new Set(['install:slides'])
    const shellApps = new Set()
    const own = [step.run, ...step.scripts.map((f) => graph.read(f) ?? '')].join('\n')
    for (const a of APPS) {
      if (new RegExp(`\\b${a}/dist-single/|['"]${a}['"],\\s*['"]dist-single['"]`).test(text)) shellApps.add(a)
      if (new RegExp(`\\b${a}/dist-sealtest\\b`).test(text)) { needs.add(`sealtest:${a}`); needs.add(`install:${a}`) }
      if (new RegExp(`\\b${a}/node_modules\\b`).test(text) || step.wd === a || step.wd.startsWith(`${a}/`)) needs.add(`install:${a}`)
    }
    // a shell path built from a variable (`${app}/dist-single/Bento_${name}`):
    // the apps the step's own script names, else every app
    if (!shellApps.size && /\$\{[\w.]+\}\/dist-single\/|dist-single\/Bento_\$\{|['"]dist-single['"],\s*`?[^,)]*Bento_/.test(text)) {
      const named = APPS.filter((a) => new RegExp(`['"]${a}['"]|--app[= ]${a}\\b`).test(own))
      for (const a of named.length ? named : APPS) shellApps.add(a)
    }
    const mapped = ARTIFACTS.find((x) => step.scripts.some((p) => p.endsWith(`/${x.rig}`)))
    if (mapped?.builds) { shellApps.clear(); for (const a of mapped.builds(step)) shellApps.add(a) }
    for (const a of shellApps) { needs.add(`build:${a}`); needs.add(`install:${a}`) }
    const bares = new Set([...importClosure(graph, step.scripts)].flatMap((f) => [...(graph.bare.get(f) ?? [])]))
    if (/PLAYWRIGHT_MODULE|\bplaywright\b|CHROME_PATH/.test(text) || bares.has('playwright')) needs.add('browser')
    if (bares.has('jsdom') || /\bjsdom\b/.test(text)) needs.add('jsdom')
    for (const d of mapped?.drop ?? []) needs.delete(d)
    // a built shell is two edges away: from the rig to the shell, from the shell to its sources
    for (const a of shellApps) for (const [f, d] of builds.get(a)) if (!reads.has(f) || reads.get(f) > d + 2) reads.set(f, d + 2)
    step.reads = reads
    step.needs = [...needs].sort()
    step.builds = [...shellApps].sort()
    step.tier = matchTier(step)
  }
  return { builds }
}

// ---------------------------------------------------------------- the plan

/**
 * The plan for a diff: every rig step with its tier, distance and whether the
 * diff reaches it. `ref` is the base commit; `head` a commit, or null for the
 * working tree.
 */
export function planFor(root, ref, head = null) {
  const view = treeView(root, head)
  const graph = buildGraph(view)
  const catalog = loadCatalog(view)
  const { builds } = annotate(catalog, graph)
  const changed = changedFiles(root, ref, head)
  // steps whose own definition changed: not in the base's catalog
  let baseSigs = new Set()
  if (changed.some((f) => CI_FILE.test(f))) {
    try { baseSigs = new Set(loadCatalog(treeView(root, ref), { all: true }).steps.map((s) => s.signature)) } catch { /* base unreadable: every step counts as changed */ }
  }
  const ciChanged = changed.some((f) => CI_FILE.test(f))
  const rigs = catalog.steps.filter((s) => !s.setup && !s.uses)
  for (const s of rigs) {
    let d = Infinity
    let via = null
    for (const f of changed) {
      const x = s.reads.get(f)
      if (x != null && x < d) { d = x; via = f }
    }
    if (ciChanged && !baseSigs.has(s.signature)) { d = 0; via = s.file }
    s.distance = d
    s.via = via
  }
  // the apps whose OWN source changed: their builds are wanted; shared code wants the representative's
  const ownApps = APPS.filter((a) => changed.some((f) => f.startsWith(`${a}/`) && builds.get(a).has(f)))
  const sharedHit = APPS.some((a) => changed.some((f) => !f.startsWith(`${a}/`) && builds.get(a).has(f)))
  const wantBuilds = new Set(ownApps)
  if (!ownApps.length && sharedHit) wantBuilds.add(REPRESENTATIVE)
  return { root, ref, head, changed, graph, catalog, rigs, builds, wantBuilds: [...wantBuilds] }
}

/** Short reasons, one per changed file nobody reads (docs, assets): ignored by the plan. */
export function unread(plan) {
  const read = new Set()
  for (const s of plan.rigs) for (const f of plan.changed) if (s.reads.has(f)) read.add(f)
  return plan.changed.filter((f) => !read.has(f) && !CI_FILE.test(f))
}

export { CI_FILE, CODE, normalize, dirname, existsSync }
