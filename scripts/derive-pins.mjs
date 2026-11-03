#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Derive a release's PINS from its own bytes (K4, security §18 / §36), and
// prove the release works under them.
//
//   node scripts/derive-pins.mjs <shell.html> [--out pins.json] [--historic]
//
// 1. Boot the built shell in Chromium and SAVE through the app's real ⌘S
//    download fallback (the File System Access picker is removed first). That
//    is the only honest source for the preview remover, which exists only in
//    saved files, and it doesn't depend on any app's scripting API (type's
//    window.bento.serialize returns JSON, not a file).
// 2. Derive the pins (scripts/lib/release-pins.mjs): the code-block hashes and
//    the CSP script hashes. The saved file must match them.
// 3. Boot the shell UNDER those pins and drive its UI (scripts/lib/csp-boot.mjs):
//    any refusal other than the loader's two designed fallbacks fails it.
//
// --historic is for the backfill of releases signed before pins existed: a
// release from before the first-page preview may save no remover, and a boot
// refusal is reported, not fatal. A new release gets neither allowance.
//
// Needs Playwright (PLAYWRIGHT_MODULE) and Chromium (CHROME_PATH), as the
// browser rigs do. Exits non-zero on any mismatch: release.mjs relies on that.

import { readFileSync, writeFileSync } from 'node:fs'
import { derivePins, checkAgainstPins } from './lib/release-pins.mjs'
import { savedBy } from './lib/saved-by.mjs'
import { bootUnderPins, clickEverything } from './lib/csp-boot.mjs'

const args = process.argv.slice(2)
const shellPath = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out')
if (!shellPath) { console.error('usage: node scripts/derive-pins.mjs <shell.html> [--out pins.json] [--historic]'); process.exit(2) }
const historic = args.includes('--historic')
const outAt = args.indexOf('--out')
const out = outAt >= 0 ? args[outAt + 1] : null

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
let failed = false
try {
  const shell = readFileSync(shellPath, 'utf8')
  const saved = await savedBy(browser, shellPath)
  const pins = derivePins(shell, saved, { historic })
  const self = await checkAgainstPins(saved, pins)
  if (self.length) throw new Error(`derive-pins: the saved file does not match its own pins: ${self.join('; ')}`)
  console.log(`pins  loader ${pins.blocks.loader.slice(0, 12)}…  remover ${pins.blocks.remover?.slice(0, 12) ?? '(none: before previews)'}  rt ${pins.blocks['bento-rt'].slice(0, 12)}…`)

  const boot = await bootUnderPins(browser, shellPath, pins, async (p) => {
    await p.waitForTimeout(1500)
    await clickEverything(p)
  })
  console.log(`boot  under the pinned policy: ${boot.expected.length} expected loader refusal(s), ${boot.unexpected.length} unexpected, ${boot.errors.length} page error(s)`)
  for (const v of boot.unexpected.slice(0, 5)) console.log(`      unexpected: ${v.directive} ${v.blockedURI} from ${v.sourceFile}`)
  if (boot.unexpected.length || boot.errors.length) {
    if (historic) console.log('      (historic release: reported, not fatal)')
    else failed = true
  }
  if (out) writeFileSync(out, JSON.stringify(pins, null, 2) + '\n')
  else console.log(JSON.stringify(pins))
} catch (e) {
  console.error(e.message)
  failed = true
} finally {
  await browser.close()
}
process.exit(failed ? 1 : 0)
