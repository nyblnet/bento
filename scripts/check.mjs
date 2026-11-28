#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The check: CI's steps, run here, from the CI files themselves.
//
//   node scripts/check.mjs --affected        the quick check, about a minute (every change)
//   node scripts/check.mjs                   the full tier: every step this machine can run
//   node scripts/check.mjs --deep            the deep tier too
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
//                      from earlier runs fit BENTO_QUICK_SECONDS (default 25: wall
//                      seconds over this machine's workers; a step never timed
//                      counts 2 s); none is started after BENTO_QUICK_DEADLINE
//                      (default 45) seconds, and those left are named
//                    - builds: each app whose own source changed, else, when
//                      shared code its build reads changed, the representative
//                      (slides); a step that reads another app's shell is left
//                      to the sweep. One headless load per built app.
//                    Steps whose tier says `serial` (they time things) run
//                    first, alone, as soon as their build is ready. Each step prints its time; a step over 5 s
//                    is named for the full tier. Everything else is the sweep's.
// --dry-run          with --affected: print the plan, run nothing
// --head REV         with --dry-run: plan REF...REV on REV's tree (no working tree)
// --no-cache         run every step (passes are still remembered)
// --jobs N           steps at once (default: the cores for --affected, half for a full run, at most 8)
// --only A,B         only steps whose id, name or script contains A or B (with a full run)
// --logs DIR         each step's output (default: a new folder under the cache)
// --json FILE        write the run's result as JSON (the sweep reads it)
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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APPS, defaultRef, planFor, unread } from './lib/check-plan.mjs'
import { cacheRoot, cached, commitLabel, keyOf, readTimes, remember, toolchain, workBlobs, writeJson, writeTimes } from './lib/check-cache.mjs'
import { inTier } from './lib/test-tiers.mjs'
import { check as skipCheck } from './lib/ci-skips.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CORES = availableParallelism()
const ON_CI = !!process.env.CI || !!process.env.GITHUB_ACTIONS
const HERE = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'

// ---------------------------------------------------------------- options

const argv = process.argv.slice(2)
const opts = { affected: false, ref: '', dryRun: false, head: '', deep: false, cache: true, jobs: 0, only: '', logs: '', json: '' }
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

const RUN_TIER = opts.deep ? 'deep' : opts.affected ? 'fast' : 'full'
const T0 = Date.now()
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`
const since = () => secs(Date.now() - T0)

// ---------------------------------------------------------------- the plan

let ref
try {
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

if (opts.affected) {
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
  const budget = Number(process.env.BENTO_QUICK_SECONDS || 25)
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
    if (!inTier(s.tier.tier, RUN_TIER)) continue
    if (opts.only && !opts.only.split(',').some((o) => [s.id, s.name, ...s.scripts].some((x) => x.includes(o)))) continue
    chosen.push({ step: s, why: s.tier.tier })
  }
  for (const c of chosen) for (const a of [...c.step.builds, ...c.step.jobProviders.filter((p) => p.startsWith('build:')).map((p) => p.slice(6))]) builds.add(a)
}

// providers each chosen step needs (a full run also gives it what its CI job set up)
const needsOf = (s) => {
  const n = new Set(s.needs)
  if (!opts.affected) for (const p of s.jobProviders) if (!p.startsWith('build:') || builds.has(p.slice(6))) n.add(p)
  for (const a of s.builds) { n.add(`build:${a}`); n.add(`install:${a}`) }
  for (const p of [...n]) if (p.startsWith('build:') || p.startsWith('sealtest:')) n.add(`install:${p.split(':')[1]}`)
  return [...n].filter((p) => !p.startsWith('build:') || builds.has(p.slice(6))).sort()
}

const header = opts.affected
  ? `check --affected: ${plan.changed.length} file${plan.changed.length === 1 ? '' : 's'} changed since ${ref.slice(0, 10)}${opts.head ? ` (to ${opts.head})` : ' (with the working tree)'}; planned in ${since()}`
  : `check (${RUN_TIER} tier): ${chosen.length} steps; planned in ${since()}`
console.log(header)
if (opts.affected) {
  console.log(`  runs ${chosen.length} step${chosen.length === 1 ? '' : 's'}${builds.size ? `, builds ${[...builds].join(', ')}` : ''}; leaves ${left.length} to the sweep`)
  const ignored = unread(plan)
  if (ignored.length) console.log(`  read by no step: ${ignored.slice(0, 12).join(', ')}${ignored.length > 12 ? ` (+${ignored.length - 12})` : ''}`)
}

if (opts.dryRun) {
  console.log('\nruns:')
  for (const c of chosen.sort((a, b) => a.step.distance - b.step.distance)) console.log(`  ${c.step.id.padEnd(34)} ${label(c.step).padEnd(46)} ${c.why}`)
  if (left.length) {
    console.log('\nleft to the sweep:')
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
const stepKey = (s) => {
  const ns = needsOf(s)
  return keyOf(s.reads.keys(), blobs, {
    sig: s.signature,
    tier: RUN_TIER === 'fast' ? 'fast' : 'full',
    env: RUN_TIER === 'fast' ? {} : s.tier.sweepEnv,
    builds: ns.filter((p) => p.startsWith('build:')).map((p) => buildKey(p.slice(6))),
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
      rmSync(dist, { recursive: true, force: true })
      cpSync(store, dist, { recursive: true, filter: (f) => !f.endsWith('.complete') })
      return { ok: true, note: 'restored from the cache', ms: 0 }
    }
    const r = await run('npm', ['run', 'build:single'], { cwd: join(ROOT, app), log })
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
    const r = await run('npm', ['run', 'build:sealtest'], { cwd: join(ROOT, app), log })
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

async function runStep(c) {
  const s = c.step
  const key = stepKey(s)
  const hit = opts.cache ? cached(CACHE, key) : null
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
    GITHUB_WORKSPACE: ROOT, RUNNER_TEMP: tmp,
    PATH: `${join(ROOT, 'scripts', 'ci')}:${process.env.PATH}`,
  }
  const serial = !!s.tier.serial
  await (serial ? exclusive() : shared())
  if (serial) await Promise.all(providers.values())
  if (s.tier.warmChrome) await warmChrome()
  let r
  try {
    r = await run('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], { cwd: join(ROOT, s.wd), env: stepEnv, log, timeout: RUN_TIER === 'fast' ? 180_000 : 45 * 60_000, group: true })
    if (r.leftover) leftovers.push(label(s))
  } finally { release(serial) }
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

/**
 * Launch the system Chrome once (the same one the rigs find) on a page with
 * text, so a timing rig never meets a cold first launch or a cold font cache.
 */
let warmed = null
function warmChrome() {
  if (!warmed) {
    const chrome = [process.env.BENTO_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p))
    const profile = mkdtempSync(join(tmpdir(), 'bento-warm-'))
    warmed = chrome
      ? run(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', `--user-data-dir=${profile}`, '--dump-dom', `data:text/html,${encodeURIComponent('<!doctype html><meta charset=utf-8><body style="font-family:system-ui,sans-serif">Warm <b>up</b> <i>text</i> <code>code</code> 日本語 한국어 العربية</body>')}`], { timeout: 60_000 }).then(() => rmSync(profile, { recursive: true, force: true, maxRetries: 10 }))
      : Promise.resolve()
  }
  return warmed
}

const deadline = () => Number(process.env.BENTO_QUICK_DEADLINE || (opts.affected ? 45 : 1e9)) * 1000
const timesUpdate = {}
const leftovers = []

function report(c, r) {
  const s = c.step
  const res = { id: s.id, job: s.job, name: s.name, label: label(s), tier: s.tier.tier, status: r.status, ms: r.ms, note: r.note || '', log: r.log || null, typecheck: /(?:^|\s)(?:\S*\/)?tsc\s/.test(s.run) }
  results.push(res)
  if (r.status === 'FAIL') failed++
  const t = r.status === 'cached' || r.status === 'not here' || r.status === 'left' ? '' : secs(r.ms)
  const mark = { ok: 'ok  ', cached: 'ok  ', FAIL: 'FAIL', SKIP: 'SKIP', 'not here': 'HERE', left: 'LEFT' }[r.status]
  console.log(`${mark} ${t.padStart(6)}  ${label(s).padEnd(44)} ${s.id}${r.note ? `  (${r.note})` : ''}`)
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
 * Steps whose rig measures time (a splash within 50 ms of a mount) fail when
 * the machine is busy, so a step whose tier says `serial` runs with nothing
 * else running: it waits for the steps in flight, and holds new ones back.
 */
const gate = { running: 0, exclusive: false, waiting: 0, wake: [] }
const settle = () => { const w = gate.wake.splice(0); for (const f of w) f() }
async function shared() {
  while (gate.exclusive || gate.waiting) await new Promise((r) => gate.wake.push(r))
  gate.running++
}
async function exclusive() {
  gate.waiting++
  while (gate.exclusive || gate.running) await new Promise((r) => gate.wake.push(r))
  gate.waiting--
  gate.exclusive = true
}
function release(serial) {
  if (serial) gate.exclusive = false
  else gate.running--
  settle()
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
  const workers = opts.jobs || (opts.affected ? CORES : Math.max(2, Math.min(8, Math.floor(CORES / 2))))
  // builds first, in parallel with everything that needs none
  for (const a of builds) provide(`build:${a}`)
  if (opts.affected) {
    // Serial steps first: each takes its turn as soon as its build is ready
    // (steps in flight finish, new ones wait, it runs alone), because a timing
    // rig measured on a runner that has been busy for half a minute fails
    // (test-shell-loader: 400 ms to mount first, 950 ms after the pool).
    // Then the rest: pinned and nearest first, in the order the budget chose.
    await pool([...chosen.filter((c) => c.step.tier.serial), ...chosen.filter((c) => !c.step.tier.serial)], workers, runStep)
  } else {
    // job by job, in CI's order within a job
    const byJob = new Map()
    for (const c of chosen) byJob.set(c.step.job, [...(byJob.get(c.step.job) ?? []), c])
    const jobs = [...byJob.values()].sort((a, b) => b.length - a.length)
    await pool(jobs, workers, async (list) => { for (const c of list) await runStep(c) })
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
  const slow = ran.filter((r) => r.tier === 'fast' && r.ms > 5000 && opts.affected && !r.typecheck)
  if (leftovers.length) console.log(`left processes running when they ended (stopped): ${leftovers.join(', ')}`)
  if (slow.length) console.log(`over 5 s (move to full in scripts/lib/test-tiers.mjs, with a reason): ${slow.map((r) => `${r.label} ${secs(r.ms)}`).join(', ')}`)
  console.log(`${failed ? 'FAIL' : 'ok'}: ${count('ok')} passed, ${count('cached')} cached, ${count('FAIL')} failed, ${count('SKIP')} skipped, ${count('not here')} not here, ${count('left')} past the deadline${opts.affected ? `, ${left.length} left to the sweep` : ''}; ${since()}${ON_CI ? '' : `; logs ${LOGS}`}`)
}

if (opts.json) {
  writeJson(opts.json, {
    ok: failed === 0, tier: RUN_TIER, ref, seconds: Math.round((Date.now() - T0) / 1000), results,
    left: left.map((l) => ({ id: l.step.id, reason: l.reason })), logs: LOGS,
  })
}
process.exit(failed ? 1 : 0)
