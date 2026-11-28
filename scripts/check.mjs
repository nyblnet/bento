#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The check: CI's steps, run here, from the CI files themselves.
//
//   node scripts/check.mjs --affected        the quick check, about a minute (every change)
//   node scripts/check.mjs                   the full tier: every step this machine can run
//   node scripts/check.mjs --deep            the deep tier too
//   node scripts/check.mjs --release slides  the release check: every tier, for what the
//                                            diff since slides' previous tag reaches
//
// --affected [REF]   only what the diff since REF reaches (default REF: the
//                    merge-base with main; committed REF...HEAD plus staged,
//                    unstaged and untracked files). scripts/lib/check-plan.mjs
//                    makes the plan; then, all at once:
//                    - every fast-tier step (scripts/lib/test-tiers.mjs) the diff
//                      reaches at import distance 0 or 1 (its script or its CI
//                      step changed; it imports a changed file or reads it as
//                      text), and every PINNED step it reaches at any distance:
//                      the released-surface invariants (splice gate, CRDT
//                      convergence, save and preview escapes)
//                    - then steps further out, nearest first, while their times
//                      from earlier runs fit BENTO_QUICK_SECONDS (default 15: wall
//                      seconds over this machine's workers; a step never timed
//                      counts 2 s); none is started after BENTO_QUICK_DEADLINE
//                      (default 45) seconds, and those left are named
//                    - builds: each app whose own source changed, else, when
//                      shared code its build reads changed, the representative
//                      (slides); a step that reads another app's shell is left
//                      to the release check. One headless load per built app.
//                    Each step prints its time; a step over 5 s is named for
//                    the full tier. Everything else is the release check's.
// --release APP      the release check (scripts/sweep.mjs --release runs it in a
//                    worktree of its own): every step, in EVERY tier, that the
//                    diff since APP's previous release tag reaches (tags from
//                    scripts/apps.mjs's tagPrefix: v1.3.0, spaces-v0.2.0), with
//                    every shell they read built once and shared; no budget, no
//                    deadline; longest steps first, at most 8 at once; a step
//                    two jobs both run (same content key) runs once. A step this
//                    machine cannot run is listed NOT RUN; an unreached one does
//                    not run. Release.mjs's own conformance gate always runs.
// --since REF        with --release: the base, instead of the previous tag
//                    In a release run a mutant suite reruns only the mutants
//                    whose targets or rig changed since that base, or that were
//                    never killed under the same content (scripts/lib/mutant-scope.mjs);
//                    the rest print NOT RERUN, never as a pass. --no-cache reruns all.
// --dry-run          with --affected or --release: print the plan, run nothing
// --head REV         with --dry-run: plan REF...REV on REV's tree (no working tree)
// --no-cache         run every step (passes are still remembered)
// --jobs N           steps at once (default: the cores for --affected, half for a full run, at most 8)
// --only A,B         only steps whose id, name or script contains A or B (with a full run)
// --logs DIR         each step's output (default: a new folder under the cache)
// --json FILE        write the run's result as JSON (the sweep reads it)
// --rerun-failed     rerun each failed step once, alone, at the end; one that
//                    passes is reported "flaky (passed alone)" and STILL fails
//                    the run (the sweep uses it, to tell load from a break)
//
// A step runs as CI runs it: its run text under bash -eo pipefail, in its
// working directory, with its env, GITHUB_WORKSPACE (this checkout),
// RUNNER_TEMP (a folder of its own) and scripts/ci on PATH. A rig that reports
// a skip fails under CI, as bento-step makes it (scripts/lib/ci-skips.mjs);
// here it is reported as SKIP and never remembered. Setup steps are providers
// made once: npm ci when an app's node_modules is missing, build:single (kept
// in the cache by the content of what it reads), build:sealtest, jsdom and the
// pinned Playwright (PLAYWRIGHT_MODULE, else installed into BENTO_BROWSER_DIR,
// default <cache>/browser).
//
// A full run takes CI's steps job by job, in order within each job (jobs in
// parallel); a step for another platform (Linux desktop, Windows, Android) is
// reported as "not here" with the workflow to dispatch.

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APPS, defaultRef, planFor, previousTag, unread } from './lib/check-plan.mjs'
import { cacheRoot, cached, commitLabel, keyOf, readTimes, remember, toolchain, workBlobs, writeJson, writeTimes } from './lib/check-cache.mjs'
import { SEQUENTIAL_JOBS, inTier } from './lib/test-tiers.mjs'
import { check as skipCheck } from './lib/ci-skips.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CORES = availableParallelism()
const ON_CI = !!process.env.CI || !!process.env.GITHUB_ACTIONS
const HERE = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'

// ---------------------------------------------------------------- options

const argv = process.argv.slice(2)
const opts = { affected: false, ref: '', dryRun: false, head: '', deep: false, cache: true, jobs: 0, only: '', logs: '', json: '', rerun: false, release: '', since: '' }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--affected') {
    opts.affected = true
    if (argv[i + 1] && !argv[i + 1].startsWith('-')) opts.ref = argv[++i]
  } else if (a === '--dry-run') opts.dryRun = true
  else if (a === '--head') opts.head = argv[++i] ?? usage('--head needs a commit')
  else if (a === '--deep') opts.deep = true
  else if (a === '--no-cache') opts.cache = false
  else if (a === '--jobs') opts.jobs = Number(argv[++i]) || usage('--jobs needs a number')
  else if (a === '--only') opts.only = argv[++i] ?? usage('--only needs text')
  else if (a === '--logs') opts.logs = resolve(argv[++i] ?? usage('--logs needs a folder'))
  else if (a === '--json') opts.json = resolve(argv[++i] ?? usage('--json needs a file'))
  else if (a === '--rerun-failed') opts.rerun = true
  else if (a === '--release') { opts.release = argv[++i] ?? usage('--release needs an app'); opts.affected = true }
  else if (a === '--since') opts.since = argv[++i] ?? usage('--since needs a tag or commit')
  else if (a === '-h' || a === '--help') usage()
  else usage(`unknown option ${a}`)
}
if ((opts.dryRun || opts.head) && !opts.affected) usage('--dry-run and --head go with --affected')
if (opts.head && !opts.dryRun) usage('--head plans a commit\'s tree: it needs --dry-run')

function usage(msg) {
  const head = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(3).filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')
  if (msg) console.error(`check: ${msg}\n`)
  console.error(head)
  process.exit(msg ? 2 : 0)
}

const RUN_TIER = opts.deep || opts.release ? 'deep' : opts.affected ? 'fast' : 'full'
const T0 = Date.now()
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`
const since = () => secs(Date.now() - T0)

// ---------------------------------------------------------------- the plan

let ref
try {
  if (opts.release) {
    if (!APPS.includes(opts.release)) usage(`--release: no app ${opts.release} (${APPS.join(', ')})`)
    opts.ref = opts.since || previousTag(ROOT, opts.release, opts.head || 'HEAD') || usage(`--release ${opts.release}: no earlier release tag of it below HEAD (pass --since <tag>; a shallow clone hides older tags: git fetch --unshallow)`)
  }
  ref = opts.affected ? (opts.ref ? execFileSync('git', ['-C', ROOT, 'rev-parse', '--verify', `${opts.ref}^{commit}`], { encoding: 'utf8' }).trim() : defaultRef(ROOT)) : 'HEAD'
} catch (e) {
  usage(`--affected: no commit ${opts.ref} (${e.message.split('\n')[0]})`)
}
const plan = planFor(ROOT, ref, opts.head || null)
// A Linux job's steps run on macOS too (node is node), unless the job installs
// Linux packages or reads Linux-only places: then all of it is the runner's.
const linuxOnly = new Set(plan.catalog.jobs.filter((j) => j.steps.some((s) => /\bsudo apt-get\b|\bxvfb-run\b|\/proc\/sys\b/.test(s.run))).map((j) => j.id))
const runnableHere = (s) => s.platform === HERE || (s.platform === 'linux' && HERE === 'macos' && !linuxOnly.has(s.job))
const CACHE = cacheRoot()
const times = readTimes(CACHE)
const estimate = (s) => (times[s.signature] ?? 2000) / 1000

/** A step in a run: { step, why, reason (when left out) }. */
const chosen = []
const left = []
let builds = new Set()

if (opts.release) {
  // THE RELEASE CHECK: every step the release's diff reaches, in every tier,
  // with every shell those steps read built; no budget, no deadline. A step
  // this machine cannot run is listed NOT RUN; an unreached one is not run.
  for (const s of plan.rigs) {
    if (s.distance === Infinity) continue
    if (!runnableHere(s)) { left.push({ step: s, reason: `needs a ${s.platform} runner (${s.tier.tier} tier)` }); continue }
    // the deep tier is what this machine lacks the toolchain for: NOT RUN, unless asked
    if (s.tier.tier === 'deep' && !opts.deep) { left.push({ step: s, reason: `deep tier: ${s.tier.why}` }); continue }
    chosen.push({ step: s, why: `distance ${s.distance} (${s.via})`, always: true })
  }
  for (const c of chosen) for (const a of [...c.step.builds, ...c.step.jobProviders.filter((p) => p.startsWith('build:')).map((p) => p.slice(6))]) builds.add(a)
} else if (opts.affected) {
  const reached = plan.rigs.filter((s) => s.distance !== Infinity)
  // the builds this diff wants: an app whose own source changed, else the
  // representative; and the shell a changed step or rig reads
  const wanted = new Set(plan.wantBuilds)
  for (const s of reached) if (s.distance === 0 && s.tier.tier === 'fast') for (const a of s.builds) wanted.add(a)
  builds = wanted
  const candidates = []
  for (const s of reached) {
    if (!inTier(s.tier.tier, RUN_TIER)) { left.push({ step: s, reason: `${s.tier.tier} tier: ${s.tier.why}` }); continue }
    if (!runnableHere(s)) { left.push({ step: s, reason: `needs a ${s.platform} runner` }); continue }
    const missing = s.builds.filter((a) => !builds.has(a))
    if (missing.length) { left.push({ step: s, reason: `reads ${missing.join(', ')}'s shell, which this diff does not rebuild` }); continue }
    const load = s.tier.entries?.some((e) => /headless load/.test(e.why)) && s.builds.length > 0
    if (s.tier.pin) chosen.push({ step: s, why: `pinned (${s.tier.why.split(':')[0]}), distance ${s.distance}`, always: true })
    else if (load) chosen.push({ step: s, why: `headless load of ${s.builds.join(', ')}`, always: true })
    else if (s.distance <= 1) chosen.push({ step: s, why: `distance ${s.distance} (${s.via})`, always: true })
    else candidates.push(s)
  }
  // further out: nearest first, then quickest, while the estimate fits the budget
  const budget = Number(process.env.BENTO_QUICK_SECONDS || 15)
  const workers = opts.jobs || CORES
  let spent = chosen.reduce((n, c) => n + estimate(c.step), 0) / workers
  candidates.sort((a, b) => a.distance - b.distance || estimate(a) - estimate(b))
  for (const s of candidates) {
    const cost = estimate(s) / workers
    if (spent + cost <= budget) { chosen.push({ step: s, why: `distance ${s.distance} (${s.via}), within the budget` }); spent += cost }
    else left.push({ step: s, reason: `distance ${s.distance}: over the ${budget} s budget` })
  }
  // build only what a chosen step reads
  builds = new Set(chosen.flatMap((c) => c.step.builds))
} else {
  for (const s of plan.rigs) {
    // never silently: a step this run does not take is listed as NOT RUN
    if (!inTier(s.tier.tier, RUN_TIER)) { left.push({ step: s, reason: `${s.tier.tier} tier: ${s.tier.why}` }); continue }
    if (opts.only && !opts.only.split(',').some((o) => [s.id, s.name, ...s.scripts].some((x) => x.includes(o)))) continue
    chosen.push({ step: s, why: s.tier.tier })
  }
  for (const c of chosen) for (const a of [...c.step.builds, ...c.step.jobProviders.filter((p) => p.startsWith('build:')).map((p) => p.slice(6))]) builds.add(a)
}

// providers each chosen step needs (a full run also gives it what its CI job set up)
const needsOf = (s) => {
  const n = new Set(s.needs)
  // (a full or release run also gives it what its CI job set up)
  if (!opts.affected || opts.release) for (const p of s.jobProviders) if (!p.startsWith('build:') || builds.has(p.slice(6))) n.add(p)
  for (const a of s.builds) { n.add(`build:${a}`); n.add(`install:${a}`) }
  for (const p of [...n]) if (p.startsWith('build:') || p.startsWith('sealtest:')) n.add(`install:${p.split(':')[1]}`)
  return [...n].filter((p) => !p.startsWith('build:') || builds.has(p.slice(6))).sort()
}

const header = opts.release
  ? `check --release ${opts.release}: ${plan.changed.length} files changed since ${opts.ref} (${ref.slice(0, 10)}); planned in ${since()}`
  : opts.affected
  ? `check --affected: ${plan.changed.length} file${plan.changed.length === 1 ? '' : 's'} changed since ${ref.slice(0, 10)}${opts.head ? ` (to ${opts.head})` : ' (with the working tree)'}; planned in ${since()}`
  : `check (${RUN_TIER} tier): ${chosen.length} steps; planned in ${since()}`
console.log(header)
if (opts.affected) {
  console.log(`  runs ${chosen.length} step${chosen.length === 1 ? '' : 's'}${builds.size ? `, builds ${[...builds].join(', ')}` : ''}; ${opts.release ? `NOT RUN ${left.length} (another platform's toolchain)` : `leaves ${left.length} to the release check`}`)
  const ignored = unread(plan)
  if (ignored.length) console.log(`  read by no step: ${ignored.slice(0, 12).join(', ')}${ignored.length > 12 ? ` (+${ignored.length - 12})` : ''}`)
}

if (opts.dryRun) {
  console.log('\nruns:')
  for (const c of chosen.sort((a, b) => a.step.distance - b.step.distance)) console.log(`  ${c.step.id.padEnd(34)} ${label(c.step).padEnd(46)} ${c.why}`)
  if (left.length) {
    console.log(opts.release ? '\nNOT RUN:' : '\nleft to the release check:')
    const byReason = new Map()
    for (const l of left) byReason.set(l.reason, [...(byReason.get(l.reason) ?? []), l.step])
    for (const [reason, ss] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${ss.length} × ${reason}`)
      for (const s of ss.slice(0, 6)) console.log(`      ${s.id} ${label(s)}`)
      if (ss.length > 6) console.log(`      … ${ss.length - 6} more`)
    }
  }
  process.exit(0)
}

function label(s) {
  return s.scripts.find((p) => /\/test-/.test(p))?.split('/').pop() ?? s.scripts[0]?.split('/').pop() ?? s.name.slice(0, 44)
}

// ---------------------------------------------------------------- keys

// (under the cache, never the repo)
mkdirSync(join(CACHE, 'logs'), { recursive: true })
const LOGS = opts.logs || mkdtempSync(join(CACHE, 'logs', `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}-`))
mkdirSync(LOGS, { recursive: true })
const blobs = workBlobs(ROOT)
const TOOLS = toolchain(blobs)
const LABEL = commitLabel(ROOT)
const browserVersion = /playwright@([\d.]+)/.exec(plan.catalog.steps.map((s) => s.run).join('\n'))?.[1] ?? null
const jsdomVersion = /jsdom@([\d.]+)/.exec(plan.catalog.steps.map((s) => s.run).join('\n'))?.[1] ?? null
const buildKey = (a) => keyOf(plan.builds.get(a).keys(), blobs, { build: a, tools: TOOLS })
/**
 * A step that reads a built shell (and no sealed test shell) is keyed on the
 * shell's BYTES and its own reads, not on every source the build reads: an
 * edit that builds to the same shell (a comment, a type) leaves every rig that
 * only boots the shell cached. Its build is made (or restored) first.
 */
async function shellKeys(s, ns) {
  const apps = ns.filter((p) => p.startsWith('build:')).map((p) => p.slice(6))
  if (!apps.length || ns.some((p) => p.startsWith('sealtest:'))) return null
  const out = []
  for (const a of apps) {
    const r = await provide(`build:${a}`)
    if (!r.ok) return null
    out.push(`${a}:${distHash(a)}`)
  }
  return out
}
function distHash(app) {
  const dir = join(ROOT, app, 'dist-single')
  const h = createHash('sha256')
  const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) { const f = join(d, n.name); if (n.isDirectory()) walk(f); else h.update(`${f.slice(dir.length)}\0`).update(readFileSync(f)) } }
  try { walk(dir) } catch { return 'absent' }
  return h.digest('hex').slice(0, 32)
}
const stepKey = async (s) => {
  const ns = needsOf(s)
  const shells = await shellKeys(s, ns)
  return keyOf((shells ? s.ownReads : s.reads).keys(), blobs, {
    shells,
    sig: s.signature,
    tier: RUN_TIER === 'fast' ? 'fast' : 'full',
    env: RUN_TIER === 'fast' ? {} : s.tier.sweepEnv,
    // (a release run's mutant suites skip by its base: its passes are its own)
    since: opts.release ? ref : null,
    builds: shells ? [] : ns.filter((p) => p.startsWith('build:')).map((p) => buildKey(p.slice(6))),
    tools: { node: TOOLS.node, locks: ns.filter((p) => p.startsWith('install:')).map((p) => TOOLS.locks[p.slice(8)]), browser: ns.includes('browser') ? browserVersion : null, jsdom: ns.includes('jsdom') ? jsdomVersion : null },
  })
}

// ---------------------------------------------------------------- processes

/** Run a command; resolves { code, ms, out } with the output in `log`. */
function run(cmd, args, { cwd = ROOT, env = {}, log, timeout = 0, group = false } = {}) {
  return new Promise((done) => {
    const t = Date.now()
    // a step runs in a process group of its own, so what it leaves running can be stopped after it
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: group })
    const chunks = []
    child.stdout.on('data', (d) => chunks.push(d))
    child.stderr.on('data', (d) => chunks.push(d))
    let timer = null
    if (timeout) timer = setTimeout(() => { chunks.push(Buffer.from(`\n[check] timed out after ${timeout / 1000} s; stopped\n`)); try { group ? process.kill(-child.pid, 'SIGTERM') : child.kill('SIGTERM') } catch { /* gone */ } }, timeout)
    child.on('error', (e) => chunks.push(Buffer.from(`\n[check] ${e.message}\n`)))
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      // Anything of the step's still running (a server, a browser it never
      // closed) is stopped: it would load the machine for every later step.
      // Only this step's own group, by its id: never a process by pattern.
      let leftover = false
      if (group) {
        try { process.kill(-child.pid, 0); leftover = true; process.kill(-child.pid, 'SIGKILL') } catch { /* nothing left */ }
      }
      const out = Buffer.concat(chunks).toString()
      if (log) writeFileSync(log, out)
      done({ code: code ?? 1, ms: Date.now() - t, out, leftover })
    })
  })
}

const tail = (text, n = 40) => text.trimEnd().split('\n').slice(-n).map((l) => `      ${l}`).join('\n')
/** A failed step's output: its failing lines first (a rig prints hundreds of oks), then its last lines. */
function failText(text) {
  const lines = text.trimEnd().split('\n')
  const bad = lines.filter((l) => /\bFAIL\b|✗|\bnot ok\b|\bError\b|\berror:|timed out/.test(l)).slice(0, 30)
  return `${bad.length ? `${bad.map((l) => `      ${l}`).join('\n')}\n      …\n` : ''}${tail(text, 25)}`
}

// ---------------------------------------------------------------- providers

const providers = new Map()
function provide(p) {
  if (!providers.has(p)) providers.set(p, makeProvider(p))
  return providers.get(p)
}

async function makeProvider(p) {
  const [kind, app] = p.split(':')
  const log = join(LOGS, `provider-${p.replace(/:/g, '-')}.log`)
  if (kind === 'install') {
    if (existsSync(join(ROOT, app, 'node_modules'))) return { ok: true, note: 'present' }
    const r = await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: join(ROOT, app), log })
    return { ok: r.code === 0, ms: r.ms, log, out: r.out }
  }
  if (kind === 'build') {
    await provide(`install:${app}`)
    const key = buildKey(app)
    const store = join(CACHE, 'builds', `${app}-${key}`)
    const dist = join(ROOT, app, 'dist-single')
    if (opts.cache && existsSync(join(store, '.complete'))) {
      const unlock = await acquire([], [`dist:${app}`])
      try {
        rmSync(dist, { recursive: true, force: true })
        cpSync(store, dist, { recursive: true, filter: (f) => !f.endsWith('.complete') })
      } finally { unlock() }
      return { ok: true, note: 'restored from the cache', ms: 0 }
    }
    const unlock = await acquire([], [`dist:${app}`])
    const r = await run('npm', ['run', 'build:single'], { cwd: join(ROOT, app), log }).finally(unlock)
    if (r.code === 0) {
      try {
        rmSync(store, { recursive: true, force: true })
        cpSync(dist, store, { recursive: true })
        writeFileSync(join(store, '.complete'), LABEL)
      } catch { /* the cache is an optimisation */ }
    }
    return { ok: r.code === 0, ms: r.ms, log, out: r.out }
  }
  if (kind === 'sealtest') {
    await provide(`install:${app}`)
    const unlock = await acquire([], [`sealtest:${app}`])
    const r = await run('npm', ['run', 'build:sealtest'], { cwd: join(ROOT, app), log }).finally(unlock)
    return { ok: r.code === 0, ms: r.ms, log, out: r.out }
  }
  if (kind === 'jsdom') {
    if (existsSync(join(ROOT, 'node_modules', 'jsdom', 'package.json'))) return { ok: true, note: 'present' }
    const r = await run('npm', ['install', '--prefix', ROOT, '--no-save', '--no-package-lock', '--no-audit', '--no-fund', `jsdom@${jsdomVersion}`], { log })
    return { ok: r.code === 0, ms: r.ms, log, out: r.out }
  }
  if (kind === 'browser') {
    if (process.env.PLAYWRIGHT_MODULE && existsSync(process.env.PLAYWRIGHT_MODULE)) return { ok: true, note: 'PLAYWRIGHT_MODULE', env: { PLAYWRIGHT_MODULE: process.env.PLAYWRIGHT_MODULE } }
    const dir = join(process.env.BENTO_BROWSER_DIR || join(CACHE, 'browser'), `playwright-${browserVersion}`)
    const mod = join(dir, 'node_modules', 'playwright', 'index.mjs')
    let ms = 0
    if (!existsSync(mod)) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), '{"private":true}\n')
      const r = await run('npm', ['install', '--prefix', dir, '--no-package-lock', '--ignore-scripts', '--no-audit', '--no-fund', `playwright@${browserVersion}`], { log })
      ms += r.ms
      if (r.code) return { ok: false, ms, log, out: r.out }
    }
    const r = await run(join(dir, 'node_modules', '.bin', 'playwright'), ['install', 'chromium'], { log: `${log}.install` })
    ms += r.ms
    return { ok: r.code === 0, ms, log: `${log}.install`, out: r.out, env: { PLAYWRIGHT_MODULE: mod } }
  }
  return { ok: false, out: `unknown provider ${p}` }
}

// ---------------------------------------------------------------- steps

const results = []
let failed = 0
const stamp = (s) => s.id.replace(/[^\w#.-]+/g, '_').replace(/#/g, '-')

/** Steps with the same key are the same check (one rig in two jobs): run it once, report both. */
const inFlight = new Map()
async function runStep(c) {
  const key = await stepKey(c.step)
  if (!c.rerun && inFlight.has(key)) {
    const first = await inFlight.get(key)
    return report(c, { status: first.status === 'ok' ? 'cached' : first.status, ms: 0, note: `same step as ${first.id}` })
  }
  const p = runStepOnce(c, key)
  if (!c.rerun) inFlight.set(key, p)
  return p
}

async function runStepOnce(c, key) {
  const s = c.step
  const hit = opts.cache && !c.rerun ? cached(CACHE, key) : null
  if (hit) return report(c, { status: 'cached', ms: 0, note: `cached, ${hit.commit}` })
  if (!runnableHere(s)) {
    return report(c, { status: 'not here', ms: 0, note: `needs a ${s.platform} runner: gh workflow run ${s.file.split('/').pop()}` })
  }
  const env = {}
  for (const p of needsOf(s)) {
    const r = await provide(p)
    if (!r.ok) return report(c, { status: 'FAIL', ms: 0, note: `needs ${p}, which failed`, out: r.out ?? '' })
    Object.assign(env, r.env ?? {})
  }
  if (Date.now() - T0 > deadline() && !c.always) return report(c, { status: 'left', ms: 0, note: `not started: past the ${deadline() / 1000} s deadline` })
  const tmp = mkdtempSync(join(tmpdir(), 'bento-step-'))
  const script = join(tmp, 'step.sh')
  writeFileSync(script, s.run)
  const log = join(LOGS, `${stamp(s)}.log`)
  const stepEnv = {
    ...env, ...s.env, ...(RUN_TIER === 'fast' ? {} : s.tier.sweepEnv),
    // mutant suites rerun only what changed (scripts/lib/mutant-scope.mjs): the
    // kill cache in a release or full run, the since-tag rule in a release run
    ...(opts.affected && !opts.release || !opts.cache ? {} : { BENTO_MUTANT_CACHE: join(CACHE, 'mutants') }),
    ...(opts.release && opts.cache ? { BENTO_MUTANT_SINCE: ref, BENTO_MUTANT_SINCE_LABEL: opts.ref } : {}),
    GITHUB_WORKSPACE: ROOT, RUNNER_TEMP: tmp,
    PATH: `${join(ROOT, 'scripts', 'ci')}:${process.env.PATH}`,
  }
  const reads = needsOf(s).filter((p) => /^(?:build|sealtest):/.test(p)).map((p) => p.replace(/^build:/, 'dist:'))
  const release = await acquire(reads, writesOf(s))
  let r
  try {
    r = await run('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], { cwd: join(ROOT, s.wd), env: stepEnv, log, timeout: RUN_TIER === 'fast' ? 180_000 : 45 * 60_000, group: true })
  } finally { release() }
  if (r.leftover) leftovers.push(label(s))
  rmSync(tmp, { recursive: true, force: true })
  let status = r.code === 0 ? 'ok' : 'FAIL'
  let note = ''
  if (status === 'ok') {
    const skips = skipCheck(s.run, r.out).filter((f) => !f.entry)
    if (skips.length) { status = ON_CI ? 'FAIL' : 'SKIP'; note = `skipped: ${skips[0].line.slice(0, 90)}` }
  }
  if (status === 'ok') {
    try { remember(CACHE, key, { id: s.id, ms: r.ms, commit: LABEL }) } catch { /* cache is best-effort */ }
  }
  timesUpdate[s.signature] = r.ms
  return report(c, { status, ms: r.ms, note, out: r.out, log })
}

const deadline = () => Number(process.env.BENTO_QUICK_DEADLINE || (opts.affected && !opts.release ? 45 : 1e9)) * 1000
const timesUpdate = {}
const leftovers = []

function report(c, r) {
  const s = c.step
  const res = { id: s.id, job: s.job, name: s.name, label: label(s), tier: s.tier.tier, status: r.status, ms: r.ms, note: r.note || '', log: r.log || null, typecheck: /(?:^|\s)(?:\S*\/)?tsc\s/.test(s.run), load: !!s.tier.entries?.some((e) => /headless load/.test(e.why)) }
  results.push(res)
  if (r.status === 'FAIL' && !c.rerun) failed++
  const t = r.status === 'cached' || r.status === 'not here' || r.status === 'left' ? '' : secs(r.ms)
  const mark = { ok: 'ok  ', cached: 'ok  ', FAIL: 'FAIL', SKIP: 'SKIP', 'not here': 'HERE', left: 'LEFT' }[r.status]
  console.log(`${mark} ${t.padStart(6)}  ${label(s).padEnd(44)} ${s.id}${c.rerun ? '  (rerun alone)' : ''}${r.note ? `  (${r.note})` : ''}`)
  if (r.status === 'FAIL' && r.out) {
    if (ON_CI) console.log(`::group::${s.id} output (its failing lines, then its last 25)`)
    console.log(failText(r.out))
    if (ON_CI) console.log('::endgroup::')
  }
  return res
}

// ---------------------------------------------------------------- run

/** Passes and builds unused for two weeks, and logs older than two days, go. */
function prune() {
  const now = Date.now()
  for (const [dir, days] of [['steps', 14], ['builds', 14], ['logs', 2]]) {
    const d = join(CACHE, dir)
    let names = []
    try { names = readdirSync(d) } catch { continue }
    for (const n of names) {
      try {
        if (now - statSync(join(d, n)).mtimeMs > days * 864e5) rmSync(join(d, n), { recursive: true, force: true })
      } catch { /* raced with another run */ }
    }
  }
}

/**
 * Built outputs as read/write locks. A step that builds a shell inline
 * (`npm run build:sealtest`, which starts by deleting dist-sealtest) must not
 * run while a step of another job reads that shell, as they never could on
 * CI, where each job had its own checkout. Writers wait for readers and the
 * reverse; keys are taken in order, so two steps never deadlock.
 */
const locks = new Map()
const lockOf = (k) => { if (!locks.has(k)) locks.set(k, { r: 0, w: false, wake: [] }); return locks.get(k) }
async function acquire(reads, writes) {
  const all = [...new Set([...reads, ...writes])].sort()
  for (const k of all) {
    const l = lockOf(k)
    const write = writes.includes(k)
    while (l.w || (write && l.r)) await new Promise((r) => l.wake.push(r))
    if (write) l.w = true
    else l.r++
  }
  return () => {
    for (const k of all) {
      const l = lockOf(k)
      if (writes.includes(k)) l.w = false
      else l.r--
      for (const f of l.wake.splice(0)) f()
    }
  }
}
/** The built outputs a step writes inline: dist:<app> or sealtest:<app>. */
function writesOf(s) {
  const out = []
  for (const m of s.run.matchAll(/npm run build:(single|sealtest)(?: --prefix (\w+))?/g)) {
    const app = m[2] ?? s.wd.split('/')[0]
    if (APPS.includes(app)) out.push(`${m[1] === 'single' ? 'dist' : 'sealtest'}:${app}`)
  }
  return out
}

async function pool(items, n, fn) {
  const q = [...items]
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, q.length)) }, async () => {
    while (q.length) await fn(q.shift())
  }))
}

if (!chosen.length) {
  console.log(`\nnothing to run${opts.affected ? ': the diff reaches no fast step' : ''} (${since()})`)
} else {
  const workers = opts.jobs || (opts.affected && !opts.release ? CORES : Math.max(2, Math.min(8, Math.floor(CORES / 2))))
  // builds first, in parallel with everything that needs none
  for (const a of builds) provide(`build:${a}`)
  if (opts.release) {
    // longest first (times from earlier runs; a step never timed counts 2 s),
    // so the slowest suites start at once and the short ones fill around them
    // (a job whose steps share a device runs as one item, its steps in order)
    const seq = new Map()
    const items = []
    for (const c of chosen) {
      if (SEQUENTIAL_JOBS.some((j) => j.job.test(c.step.job))) {
        if (!seq.has(c.step.job)) { seq.set(c.step.job, []); items.push({ list: seq.get(c.step.job) }) }
        seq.get(c.step.job).push(c)
      } else items.push({ list: [c] })
    }
    const cost = (it) => it.list.reduce((n, c) => n + estimate(c.step), 0)
    const alone = items.filter((it) => it.list.some((c) => c.step.tier.alone))
    await pool(items.filter((it) => !alone.includes(it)).sort((a, b) => cost(b) - cost(a)), workers, async (it) => { for (const c of it.list) await runStep(c) })
    // then the timing rigs, one at a time, with nothing else running
    await Promise.all(providers.values())
    for (const it of alone) for (const c of it.list) await runStep(c)
  } else if (opts.affected) {
    // pinned and nearest first; the rest in the order the budget chose
    await pool(chosen, workers, runStep)
  } else {
    // job by job, in CI's order within a job
    const byJob = new Map()
    for (const c of chosen) byJob.set(c.step.job, [...(byJob.get(c.step.job) ?? []), c])
    const jobs = [...byJob.values()].sort((a, b) => b.length - a.length)
    await pool(jobs, workers, async (list) => { for (const c of list) if (!c.step.tier.alone) await runStep(c) })
    await Promise.all(providers.values())
    for (const c of chosen) if (c.step.tier.alone) await runStep(c)
  }
  if (opts.rerun) {
    const failedSteps = chosen.filter((c) => results.some((r) => r.id === c.step.id && r.status === 'FAIL'))
    if (failedSteps.length) console.log(`\nrerunning ${failedSteps.length} failed step${failedSteps.length === 1 ? '' : 's'} alone`)
    for (const c of failedSteps) {
      const before = results.find((r) => r.id === c.step.id && r.status === 'FAIL')
      const again = await runStep({ ...c, rerun: true })
      results.splice(results.indexOf(again), 1)
      if (again.status === 'ok') { before.note = `flaky: failed in the run, passed alone${before.note ? `; ${before.note}` : ''}`; before.flaky = true }
    }
  }
  try { writeTimes(CACHE, timesUpdate) } catch { /* best-effort */ }
  prune()
  const pr = [...providers].map(([p, v]) => [p, v])
  const provLines = []
  for (const [p, v] of pr) {
    const r = await v
    if (r.ms) provLines.push(`${p} ${secs(r.ms)}${r.note ? ` (${r.note})` : ''}`)
    else if (r.note && r.note !== 'present') provLines.push(`${p} (${r.note})`)
  }
  const count = (st) => results.filter((r) => r.status === st).length
  const ran = results.filter((r) => r.status === 'ok' || r.status === 'FAIL' || r.status === 'SKIP')
  console.log('')
  if (provLines.length) console.log(`providers: ${provLines.join('; ')}`)
  const slow = ran.filter((r) => r.tier === 'fast' && r.ms > 5000 && opts.affected && !r.typecheck && !r.load)
  if (leftovers.length) console.log(`left processes running when they ended (stopped): ${leftovers.join(', ')}`)
  if (slow.length) console.log(`over 5 s (move to full in scripts/lib/test-tiers.mjs, with a reason): ${slow.map((r) => `${r.label} ${secs(r.ms)}`).join(', ')}`)
  const flaky = results.filter((r) => r.flaky).map((r) => r.label)
  if (flaky.length) console.log(`flaky (failed in the run, passed alone; still failures): ${flaky.join(', ')}`)
  if (!opts.affected || opts.release) {
    const notRun = [...left, ...results.filter((r) => r.status === 'not here').map((r) => ({ step: { id: r.id, scripts: [], name: r.label }, reason: r.note }))]
    if (notRun.length) {
      console.log(`NOT RUN: ${notRun.length} step${notRun.length === 1 ? '' : 's'} this full check did not run (here, or in this tier):`)
      const byReason = new Map()
      for (const l of notRun) byReason.set(l.reason, [...(byReason.get(l.reason) ?? []), l.step.id])
      for (const [why, ids] of byReason) console.log(`  NOT RUN ${ids.length} × ${why}: ${ids.join(', ')}`)
    }
  }
  console.log(`${failed ? 'FAIL' : 'ok'}: ${count('ok')} passed, ${count('cached')} cached, ${count('FAIL')} failed, ${count('SKIP')} skipped, ${count('not here')} not here, ${count('left')} past the deadline${opts.affected && !opts.release ? `, ${left.length} left to the release check` : ''}; ${since()}${ON_CI ? '' : `; logs ${LOGS}`}`)
}

if (opts.json) {
  writeJson(opts.json, {
    ok: failed === 0, tier: RUN_TIER, ref, seconds: Math.round((Date.now() - T0) / 1000), results,
    left: left.map((l) => ({ id: l.step.id, reason: l.reason })), logs: LOGS,
  })
}
process.exit(failed ? 1 : 0)
