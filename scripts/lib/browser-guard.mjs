// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Two promises a browser rig makes, kept in one place.
 *
 * 1. A browser that dies mid-rig FAILS, and says so. Playwright reports a dead
 *    browser as whatever call happened to be waiting on it ("page.evaluate:
 *    Target page, context or browser has been closed"), which reads like a bug
 *    in that row. The guard names it instead, exits with BROWSER_DIED, and
 *    points at the browser's own last words: run the rig with
 *    DEBUG=pw:browser and its stderr and exit signal are in the log above.
 *    The browser process need NOT die for this: on CI's WebKit a crash in the
 *    page's web process left the browser connected and closed only the page,
 *    ~30s later, with that same message. So the guard goes by the message
 *    (a target the rig still held went away) as well as by the disconnect.
 *
 * 2. A rig never hangs the job. `page.evaluate` has no timeout, so a wedged
 *    page holds the rig forever (a Firefox run once sat 28 minutes until the
 *    job was cancelled). The rig reports progress (each row, each section)
 *    and the guard fails it when none comes for `stallMs`, naming the section
 *    and the last row, with TIMED_OUT. A deadline between rows rather than per
 *    section: a mutant run that waits out its polling loops still reaches the
 *    row it must turn red, while a call that never returns is caught.
 *
 *   const guard = guardBrowser(browser, { rig: 'home/web (webkit)', stallMs: 90000 })
 *   guard.section('[T4] …')   // the section in progress (re-arms the deadline)
 *   guard.progress('row …')   // a row was reported (re-arms the deadline)
 *   await guard.close()       // the only expected disconnect
 *
 * Neither path can read as a pass: both exit non-zero before any summary line.
 */
export const BROWSER_DIED = 75
export const TIMED_OUT = 124
const TARGET_GONE = /Target page, context or browser has been closed|Target crashed/

export function guardBrowser(browser, { rig, stallMs = 90000, print = (m) => console.log(m) } = {}) {
  let closing = false
  let current = '(before the first section)'
  let last = '(none yet)'
  let timer = null
  const t0 = Date.now()
  const died = (why) => {
    print(`\n  FAIL  ${rig}: ${why}, in "${current}" after the row "${last}", at ${((Date.now() - t0) / 1000).toFixed(1)}s.`)
    print('        This is the BROWSER failing, not a row. Its stderr and exit signal are above when run with DEBUG=pw:browser.')
    process.exit(BROWSER_DIED)
  }
  browser.on('disconnected', () => { if (!closing) died('the browser process went away mid-rig (crashed or was killed)') })
  // The call that was waiting on the dead browser rejects too; whichever comes first wins.
  const onError = (e) => {
    const first = String(e?.message ?? e).split('\n')[0]
    if (!closing && !browser.isConnected()) died(`the browser process went away mid-rig (${first})`)
    if (!closing && TARGET_GONE.test(first)) died(`a page the rig still held went away (its web process crashed or was killed; the browser is ${browser.isConnected() ? 'still connected' : 'gone'}): ${first}`)
    // anything else fails exactly as it would have without the guard
    console.error(e?.stack ?? e)
    process.exit(1)
  }
  process.on('uncaughtException', onError)
  process.on('unhandledRejection', onError)
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      print(`\n  FAIL  ${rig}: TIMEOUT: nothing reported for ${stallMs / 1000}s in "${current}" after the row "${last}" (a call into the browser never returned).`)
      process.exit(TIMED_OUT)
    }, stallMs)
  }
  return {
    section(name) { current = name; last = '(none yet)'; arm() },
    progress(row) { last = String(row).slice(0, 100); arm() },
    async close() { closing = true; clearTimeout(timer); await browser.close() },
  }
}
