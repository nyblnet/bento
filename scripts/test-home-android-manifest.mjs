#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

/**
 * Does the MERGED RELEASE manifest keep the Bento ID setup screen closed?
 *
 * SetupActivity is exported, and reads a directory URL and test key from its
 * launching intent, only in builds a test drives (manifest placeholders
 * setupExported / setupDev). A slip in those placeholders would ship an
 * exported activity that takes its directory from any app on the phone. The
 * check reads the manifest AGAIN after the manifest merger, because that is
 * what the store sees. It then proves it can fail: each mutation below must turn
 * the check red.
 *
 *   node scripts/test-home-android-manifest.mjs <merged release AndroidManifest.xml>
 */
import { readFileSync } from 'node:fs'

export function check(xml) {
  const problems = []
  const m = xml.match(/<activity\b[^>]*android:name="[^"]*\.SetupActivity"[^>]*?(?:\/>|>[\s\S]*?<\/activity>)/)
  if (!m) return ['SetupActivity is not in the manifest']
  const el = m[0]
  if (!/android:exported="false"/.test(el)) problems.push('SetupActivity is not exported="false"')
  if (/<intent-filter/.test(el)) problems.push('SetupActivity has an intent-filter')
  const dev = el.match(/<meta-data\b[^>]*android:name="bento\.setup\.dev"[^>]*>/)
  if (!dev) problems.push('bento.setup.dev is missing')
  else if (!/android:value="false"/.test(dev[0])) problems.push('bento.setup.dev is not "false"')
  return problems
}

const path = process.argv[2]
if (!path) { console.error('usage: test-home-android-manifest.mjs <AndroidManifest.xml>'); process.exit(2) }
const xml = readFileSync(path, 'utf8')
let bad = 0
const say = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }

const real = check(xml)
say(real.length === 0, `merged release manifest keeps SetupActivity closed${real.length ? ' (' + real.join('; ') + ')' : ''}`)

// positive controls: the check must go red on each way to open it
const mutants = {
  'exported="true"': x => x.replace(/(\.SetupActivity"[\s\S]*?android:exported=")false"/, '$1true"'),
  'bento.setup.dev true': x => x.replace(/(android:name="bento\.setup\.dev"[\s\S]*?android:value=")false"/, '$1true"'),
  'an intent-filter': x => x.replace(/(\.SetupActivity"[\s\S]*?android:theme="[^"]*"\s*>)/, '$1<intent-filter><action android:name="android.intent.action.VIEW"/></intent-filter>'),
  'bento.setup.dev removed': x => x.replace(/<meta-data\b[^>]*bento\.setup\.dev[^>]*>/, ''),
}
for (const [name, mutate] of Object.entries(mutants)) {
  const mx = mutate(xml)
  const changed = mx !== xml
  const caught = changed && check(mx).length > 0
  say(caught, `mutant ${name}: ${changed ? (caught ? 'caught' : 'NOT caught') : 'mutation did not apply'}`)
}
process.exit(bad ? 1 : 0)
