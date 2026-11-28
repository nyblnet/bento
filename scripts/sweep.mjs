#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The full check (the sweep): every check step of the full tier this machine
// can run (scripts/check.mjs with no --affected) on one commit, in a worktree
// of its own, with the result kept per commit.
//
//   node scripts/sweep.mjs <commit>     default: origin/main's head
//
// It runs at release, on the machine that deploys, and nowhere else: GitHub
// runs only the quick check (check.mjs --affected), per change.
// scripts/release.mjs refuses to build or sign unless the commit it releases
// has a green result here, because a shipped Bento file cannot be recalled: it
// carries its shell, and every copy anyone saved keeps it. Merges do not wait
// on it. Every step it does not run (the deep tier: a toolchain this machine
// lacks; a step for another platform) is listed as NOT RUN in its output and
// its result, never passed over.
//
// - Where: a detached worktree, BENTO_SWEEP_WORKTREES/<name> (default
//   ~/.cache/bento-check/wt/main), reused from sweep to sweep and cleaned
//   (git clean -fdx, node_modules kept) before each; one sweep at a time per
//   worktree. node_modules: its own, npm ci'd, kept while the lockfile holds.
// - Results: <BENTO_CHECK_CACHE, default ~/.cache/bento-check>/sweeps/<sha>.json
//     { sha, ok, finished, subject, seconds, counts, failures: [{ id, label, note }],
//       skipped, notHere, logs, firstBad }
//   Passes are remembered by content (scripts/lib/check-cache.mjs), so a
//   second sweep reruns only what changed.
// - A failed step is rerun once alone; one that passes is marked flaky and the
//   sweep is STILL red (load is not a pass; the rig or the machine needs a look).
// - On a failure: bisects the first-parent commits since the last green sweep,
//   rerunning only the failed steps (by script), and names the first bad commit.
//
// usage: node scripts/sweep.mjs [commit] [options]
//   --name NAME     the worktree to use (default main)
//   --no-bisect     report a failure without looking for its first bad commit
//   --summary       print only the last line; the full output goes to the logs
//   --status        print the commit's sweep line and exit (0 green, 1 red, 3 none)
//   --jobs N        steps at once (passed to check.mjs)
//   --release APP   the release check: only the steps the diff since APP's previous
//                   release tag reaches, in every tier (check.mjs --release); its
//                   result is <sha>.release-<APP>.json, and release.mjs accepts it
//   --since TAG     with --release: the base, when it is not the previous tag

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cacheRoot, readJson, writeJson } from './lib/check-cache.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = cacheRoot()
export const SWEEPS = join(CACHE, 'sweeps')
const WT_ROOT = process.env.BENTO_SWEEP_WORKTREES || join(CACHE, 'wt')
const APPS = ['slides', 'spaces', 'dash', 'type']

const git = (args, cwd = ROOT) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A result's file: <sha>.json for the whole full tier, <sha>.release-<app>.json for a release's scope. */
export const resultFile = (sha, dir = SWEEPS, scope = 'all') => join(dir, scope === 'all' ? `${sha}.json` : `${sha}.${scope}.json`)
export const readResult = (sha, dir = SWEEPS, scope = 'all') => readJson(resultFile(sha, dir, scope))

/** One line for a result. */
export function summaryLine(r) {
  if (!r) return 'sweep: none'
  const head = `${r.scope && r.scope !== 'all' ? `release check (${r.scope.slice(8)} since ${r.base})` : 'sweep'} ${r.sha.slice(0, 9)}`
  const took = r.seconds != null ? `, ${Math.round(r.seconds / 60)} min` : ''
  const c = r.counts ?? {}
  const counts = ` (${c.ok ?? 0} passed, ${c.cached ?? 0} cached${c.SKIP ? `, ${c.SKIP} skipped` : ''}${c['not here'] ? `, ${c['not here']} not here` : ''}${r.notRun?.length ? `; NOT RUN ${r.notRun.length} deep-tier steps (another runner's toolchain)` : ''})`
  if (r.ok) return `${head}: green${counts}${took}`
  const fails = r.failures.map((f) => `${f.label}${f.flaky ? ' (flaky: passed alone)' : ''}`).join('; ')
  const bad = r.firstBad?.sha ? `; first bad ${r.firstBad.sha.slice(0, 9)} "${r.firstBad.subject}"` : r.firstBad?.why ? `; ${r.firstBad.why}` : ''
  return `${head}: RED: ${fails || 'see the log'}${bad}${counts}${took}${r.logs ? `; logs ${r.logs}` : ''}`
}

/** Is the full check of `sha` green for a release of `app`: its release scope, or the whole full tier? (release.mjs asks.) */
export function isGreen(sha, dir = SWEEPS, app = null) {
  const ok = (r) => !!r && r.ok === true && r.sha === sha
  return ok(readResult(sha, dir)) || (!!app && ok(readResult(sha, dir, `release-${app}`)))
}

/** First-parent commits after the last green sweep up to `sha` (oldest first), and that green one. */
export function sinceGreen(sha, { limit = 200, dir = SWEEPS, revList = (a) => git(a) } = {}) {
  const line = revList(['rev-list', '--first-parent', `--max-count=${limit}`, sha]).split('\n').filter(Boolean)
  const after = []
  for (const c of line) {
    const r = readResult(c, dir)
    if (r?.ok && c !== sha) return { commits: after.reverse(), green: c }
    after.push(c)
  }
  return { commits: after.reverse(), green: null }
}

/** The first bad commit among `commits` (oldest first; the last is known bad), by binary search. */
export async function bisect(commits, isBad) {
  let lo = 0
  let hi = commits.length - 1
  const checked = []
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const bad = await isBad(commits[mid])
    checked.push({ sha: commits[mid], bad })
    if (bad) hi = mid
    else lo = mid + 1
  }
  return { sha: commits[hi], checked }
}

// ---------------------------------------------------------------- the worktree

/** The sweep's worktree at `sha`, cleaned, with node_modules for every app. */
function worktreeAt(name, sha) {
  const dir = join(WT_ROOT, name)
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(WT_ROOT, { recursive: true })
    git(['worktree', 'add', '--detach', dir, sha])
  } else {
    // (the sweep's own checkout: nothing in it to keep; caches live outside it)
    git(['checkout', '--detach', '--force', sha], dir)
    git(['clean', '-fdxq', '-e', 'node_modules'], dir)
  }
  // Its own installs, never another checkout's: a matching lockfile does not
  // mean that checkout's node_modules was installed from it (a stale one
  // lacked @gfx/zopfli). Kept between sweeps while the lockfile is the same.
  for (const a of APPS) {
    const to = join(dir, a, 'node_modules')
    const lockFile = join(dir, a, 'package-lock.json')
    if (!existsSync(lockFile)) continue
    const lock = readFileSync(lockFile, 'utf8')
    const marker = join(to, '.bento-sweep-lock')
    let isLink = false
    try { isLink = lstatSync(to).isSymbolicLink() } catch { /* missing */ }
    if (isLink) rmSync(to, { force: true })
    else if (existsSync(to) && (!existsSync(marker) || readFileSync(marker, 'utf8') !== lock)) rmSync(to, { recursive: true, force: true })
    if (!existsSync(to)) {
      execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: join(dir, a), stdio: 'ignore' })
      writeFileSync(marker, lock)
    }
  }
  return dir
}

/** One sweep at a time per worktree: a lock folder holding the owner's pid; a dead owner's lock is taken over. */
function lock(name) {
  const dir = join(WT_ROOT, `${name}.lock`)
  mkdirSync(WT_ROOT, { recursive: true })
  for (let i = 0; i < 2; i++) {
    try {
      mkdirSync(dir)
      writeFileSync(join(dir, 'pid'), String(process.pid))
      const release = () => rmSync(dir, { recursive: true, force: true })
      process.on('exit', release)
      return release
    } catch {
      let pid = 0
      try { pid = Number(readFileSync(join(dir, 'pid'), 'utf8')) } catch { /* being written */ }
      let alive = false
      try { if (pid) { process.kill(pid, 0); alive = true } } catch { /* gone */ }
      if (alive) throw new Error(`sweep: the ${name} worktree is busy (pid ${pid}); wait for it, or use --name`)
      rmSync(dir, { recursive: true, force: true })
    }
  }
  throw new Error(`sweep: could not lock ${dir}`)
}

// ---------------------------------------------------------------- running the check

let quiet = false

/** check.mjs in `dir` (the commit's own copy); resolves the JSON it writes. */
function check(dir, args, logs) {
  mkdirSync(logs, { recursive: true })
  const json = join(logs, 'check.json')
  rmSync(json, { force: true })
  return new Promise((done) => {
    const out = []
    const child = spawn('nice', ['-n', '10', process.execPath, join(dir, 'scripts/check.mjs'), ...args, '--logs', logs, '--json', json], { cwd: dir, env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d) => { out.push(d); if (!quiet) process.stdout.write(d) })
    child.stderr.on('data', (d) => { out.push(d); if (!quiet) process.stderr.write(d) })
    const stop = () => child.kill('SIGTERM')
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    child.on('close', (code) => {
      writeFileSync(join(logs, 'sweep.log'), Buffer.concat(out))
      done({ code: code ?? 1, result: readJson(json) })
    })
  })
}

const countOf = (results) => {
  const c = {}
  for (const r of results ?? []) c[r.status] = (c[r.status] ?? 0) + 1
  return c
}

async function main(argv) {
  const opts = { commit: '', name: 'main', bisect: true, summary: false, status: false, jobs: '', release: '', since: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--name') opts.name = argv[++i]
    else if (a === '--no-bisect') opts.bisect = false
    else if (a === '--summary') opts.summary = true
    else if (a === '--status') opts.status = true
    else if (a === '--jobs') opts.jobs = argv[++i]
    else if (a === '--release') opts.release = argv[++i]
    else if (a === '--since') opts.since = argv[++i]
    else if (a === '-h' || a === '--help') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(3).filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))
      return 0
    } else if (a.startsWith('-')) { console.error(`sweep: unknown option ${a}`); return 2 }
    else opts.commit = a
  }
  quiet = opts.summary
  const sha = git(['rev-parse', '--verify', `${opts.commit || 'origin/main'}^{commit}`])
  const subject = git(['log', '-1', '--pretty=%s', sha]).slice(0, 120)
  const scope = opts.release ? `release-${opts.release}` : 'all'
  let base = null
  if (opts.release) {
    const { previousTag } = await import('./lib/check-plan.mjs')
    base = opts.since || previousTag(ROOT, opts.release, sha)
    if (!base) { console.error(`sweep: no earlier ${opts.release} release tag below ${sha.slice(0, 9)}; pass --since <tag> (a shallow clone hides older tags: git fetch --unshallow)`); return 2 }
  }
  if (opts.status) {
    const r = readResult(sha, SWEEPS, scope)
    console.log(r ? summaryLine(r) : `sweep ${sha.slice(0, 9)}: none yet`)
    return r ? (r.ok ? 0 : 1) : 3
  }
  try { git(['cat-file', '-e', `${sha}:scripts/check.mjs`]) } catch {
    console.error(`sweep: ${sha.slice(0, 9)} has no scripts/check.mjs (it predates the sweep); nothing to run`)
    return 2
  }

  // a release's scope bisects across the release's own commits
  const since = opts.release
    ? { commits: git(['rev-list', '--first-parent', '--reverse', `${base}..${sha}`]).split('\n').filter(Boolean), green: base }
    : sinceGreen(sha)
  const cover = opts.release ? `the ${opts.release} release diff since ${base} (${since.commits.length} commits)` : since.green ? `${since.commits.length} commit${since.commits.length === 1 ? '' : 's'} since the last green sweep (${since.green.slice(0, 9)})` : `${since.commits.length}${since.commits.length >= 200 ? '+' : ''} commits: no green sweep before it`
  console.log(`sweep ${sha.slice(0, 9)} "${subject}": covers ${cover}`)

  const release = lock(opts.name)
  const t0 = Date.now()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const logs = join(CACHE, 'sweep-logs', `${sha.slice(0, 12)}-${stamp}`)
  const dir = worktreeAt(opts.name, sha)
  const jobs = opts.jobs ? ['--jobs', opts.jobs] : []
  if (!quiet) console.log(`in ${dir}; logs ${logs}`)
  const scopeArgs = opts.release ? ['--release', opts.release, '--since', base] : []
  const r = await check(dir, [...scopeArgs, '--rerun-failed', ...jobs], logs)
  const results = r.result?.results ?? []
  const failures = results.filter((x) => x.status === 'FAIL').map((x) => ({ id: x.id, label: x.label, note: x.note, log: x.log, flaky: !!x.flaky }))
  if (r.code !== 0 && !failures.length) failures.push({ id: 'check', label: `check.mjs exit ${r.code}`, note: 'see sweep.log' })
  const skipped = results.filter((x) => x.status === 'SKIP').map((x) => ({ id: x.id, label: x.label, note: x.note }))
  const notHere = results.filter((x) => x.status === 'not here').map((x) => ({ id: x.id, label: x.label, note: x.note }))
  // the deep tier (another runner's toolchain): NOT RUN, listed in every result and line
  const notRun = (r.result?.left ?? []).map((x) => ({ id: x.id, note: x.reason }))
  // green: nothing failed, nothing skipped, nothing of the full tier left for another machine
  const result = {
    sha, scope, base, ok: r.code === 0 && !failures.length && !skipped.length && !notHere.length, finished: new Date().toISOString(), subject,
    seconds: Math.round((Date.now() - t0) / 1000), counts: countOf(results), failures, skipped, notHere, notRun, logs, firstBad: null,
  }
  writeJson(resultFile(sha, SWEEPS, scope), result)

  if (!result.ok && failures.length && opts.bisect) {
    const { commits, green } = since
    if (!green) result.firstBad = { why: 'no green sweep before it to bisect from' }
    else if (commits.length === 1) result.firstBad = { sha, subject, failing: failures.map((f) => f.label) }
    else {
      const labels = [...new Set(failures.map((f) => f.label))]
      if (!quiet) console.log(`\nbisecting ${commits.length - 1} commits since the green ${green.slice(0, 9)}, rerunning: ${labels.join(', ')}`)
      const found = await bisect(commits, async (c) => {
        try { git(['cat-file', '-e', `${c}:scripts/check.mjs`]) } catch { return false }
        worktreeAt(opts.name, c)
        const rr = await check(dir, ['--only', labels.join(','), ...jobs], join(logs, `bisect-${c.slice(0, 9)}`))
        const bad = (rr.result?.results ?? []).some((x) => x.status === 'FAIL') || (rr.code !== 0 && !rr.result)
        if (!quiet) console.log(`  ${c.slice(0, 9)} ${bad ? 'bad' : 'good'}`)
        return bad
      })
      result.firstBad = { sha: found.sha, subject: git(['log', '-1', '--pretty=%s', found.sha]).slice(0, 120), checked: found.checked }
      worktreeAt(opts.name, sha)
    }
    writeJson(resultFile(sha, SWEEPS, scope), result)
  }
  release()
  console.log(opts.summary ? summaryLine(result) : `\n${summaryLine(result)}`)
  for (const s of skipped) console.log(`  skipped: ${s.label} ${s.id} (${s.note})`)
  for (const s of notHere) console.log(`  not here: ${s.label} ${s.id} (${s.note})`)
  for (const s of result.notRun) console.log(`  NOT RUN: ${s.id} (${s.note})`)
  return result.ok ? 0 : 1
}

// (realpath both sides: through a symlinked path the plain comparison is false and main never runs)
const isMain = process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(2) })
