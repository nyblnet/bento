#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * scripts/lib/browser-guard.mjs keeps two promises for browser rigs: a browser
 * that dies mid-rig fails the rig and says so, and a call that never returns
 * fails it within its stall budget instead of eating the job. This drives the
 * guard through each case in a child process and reads its exit and output.
 *
 *   PLAYWRIGHT_MODULE=…/playwright/index.mjs node scripts/test-browser-guard.mjs
 *   BENTO_BROWSER=webkit|firefox …   another engine (default chromium)
 *
 * Cases:
 *   died   the rig's own browser process is killed under a pending evaluate
 *   page   the page's target goes away under a pending evaluate while the
 *          browser stays connected: what CI's WebKit actually did when its web
 *          process crashed ("Target page, context or browser has been closed")
 *   stall  an evaluate that never resolves
 *   clean  a normal run that closes its browser (positive control: the guard
 *          neither fires on an expected close nor holds the process open)
 *   error  an ordinary rig error with the browser alive keeps exit 1 and its stack
 */
import { spawnSync, execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { BROWSER_DIED, TIMED_OUT, guardBrowser, apiLogger } = await import(path.join(ROOT, 'scripts/lib/browser-guard.mjs'))

if (process.env.BENTO_GUARD_CASE) {
  // ---- child: one case ----
  const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
  const browser = await pw[process.env.BENTO_BROWSER || 'chromium'].launch({ logger: apiLogger })
  const guard = guardBrowser(browser, { rig: 'guard rig', stallMs: 2000 })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto('data:text/html,<p>guard')
  guard.section('the case') // armed after setup: a slow first page load is not what the 2s budget measures
  guard.progress('page up')
  const which = process.env.BENTO_GUARD_CASE
  if (which === 'died') {
    // the browser this process launched: its own direct child (Playwright spawns it detached,
    // so it leads its own process group). Recorded by parent pid, never matched by name.
    const kids = execFileSync('ps', ['-A', '-o', 'pid=,ppid=']).toString().trim().split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number)).filter(([, ppid]) => ppid === process.pid).map(([pid]) => pid)
    const launched = kids.filter((pid) => { try { process.kill(pid, 0); return true } catch { return false } })
    if (launched.length !== 1) { console.log(`expected one browser child, found ${launched.length}`); process.exit(3) }
    setTimeout(() => process.kill(-launched[0], 'SIGKILL'), 300)
    await page.evaluate(() => new Promise((r) => setTimeout(r, 30000)))
    console.log('UNREACHED: evaluate returned after its browser died')
  } else if (which === 'page') {
    setTimeout(() => { ctx.close().catch(() => {}) }, 300) // out from under the pending call; the browser lives on
    await page.evaluate(() => new Promise((r) => setTimeout(r, 30000)))
    console.log('UNREACHED: evaluate returned after its page went away')
  } else if (which === 'stall') {
    await page.evaluate(() => new Promise(() => {}))
    console.log('UNREACHED: a never-resolving evaluate returned')
  } else if (which === 'error') {
    throw new Error('an ordinary rig error')
  }
  await guard.close()
  console.log('CLEAN END')
  process.exit(0)
}

// ---- parent ----
let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }
const run = (which) => {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, BENTO_GUARD_CASE: which }, encoding: 'utf8', timeout: 60000 })
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), timedOut: r.error?.code === 'ETIMEDOUT' }
}
console.log(`browser guard, in ${process.env.BENTO_BROWSER || 'chromium'}:`)
{
  const r = run('died')
  ok(r.status === BROWSER_DIED && /FAIL {2}guard rig: the browser process went away mid-rig/.test(r.out) && /after the row "page up"/.test(r.out) && !/UNREACHED/.test(r.out),
    `a browser killed under a pending call fails the rig as the BROWSER dying, naming the last row (exit ${r.status})`)
  if (r.status !== BROWSER_DIED) console.log(r.out.split('\n').slice(-8).map((l) => '        ' + l).join('\n'))
}
{
  const r = run('page')
  ok(r.status === BROWSER_DIED && /a page the rig still held went away .*still connected/.test(r.out) && /after the row "page up"/.test(r.out) && !/UNREACHED/.test(r.out),
    `a page that goes away under a pending call, the browser still connected (the CI crash), fails as the browser, not a row (exit ${r.status})`)
  if (r.status !== BROWSER_DIED) console.log(r.out.split('\n').slice(-8).map((l) => '        ' + l).join('\n'))
}
{
  const r = run('stall')
  ok(r.status === TIMED_OUT && /TIMEOUT: nothing reported for 2s in "the case" after the row "page up"/.test(r.out) && /calls still in flight:\s+\S+ => page\.evaluate started/.test(r.out) && !r.timedOut,
    `a call that never returns fails within its stall budget, naming section, row and the call in flight (exit ${r.status})`)
  if (r.status !== TIMED_OUT) console.log(r.out.split('\n').slice(-8).map((l) => '        ' + l).join('\n'))
}
{
  const r = run('clean')
  ok(r.status === 0 && /CLEAN END/.test(r.out) && !/FAIL/.test(r.out), `positive control: a run that closes its browser exits 0 and the guard stays quiet (exit ${r.status})`)
}
{
  const r = run('error')
  ok(r.status === 1 && /an ordinary rig error/.test(r.out) && !/the browser process went away/.test(r.out), `an ordinary error with the browser alive still fails as itself (exit ${r.status})`)
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
