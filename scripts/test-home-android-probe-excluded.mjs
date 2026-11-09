#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

/**
 * Does the passkey origin probe (home/android/originprobe) stay out of the
 * release app?
 *
 * The probe is a separate DEBUG-only application with its own package. This
 * checks the two places it could leak into what a store sees:
 *
 *  1. the release runtime classpath of :app (`gradlew :app:dependencies
 *     --configuration releaseRuntimeClasspath`) names neither the probe module
 *     nor Credential Manager (androidx.credentials);
 *  2. the release DEX (R8 output, or the dex inside a release .apk / .aab)
 *     carries none of the probe's marks: its package, its log tag, the
 *     `apk-key-hash` origin prefix, Credential Manager's type strings.
 *
 * Neither check may pass vacuously: the classpath must list a dependency :app
 * is known to have, and the dex must hold a class :app is known to keep. Then
 * it proves it can fail: the PROBE'S OWN debug APK, given as --control, must
 * turn check 2 red on every mark, and a classpath with the probe or
 * Credential Manager added must turn check 1 red.
 *
 *   node scripts/test-home-android-probe-excluded.mjs --deps <deps.txt> \
 *     --dex <dir | .dex | .apk | .aab> [--dex …] --control <originprobe-debug.apk>
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export const MARKS = [
  'page/bento/probe',                              // the probe's package, as a dex type descriptor
  'OriginProbe',                                   // its log tag
  'android:apk-key-hash:',                         // the origin it computes
  'androidx.credentials.TYPE_PUBLIC_KEY_CREDENTIAL', // Credential Manager survives R8 renaming as this string
]
const KNOWN_DEP = 'androidx.webkit:webkit'
const KNOWN_CLASS = 'page/bento/home/DocumentsActivity'

export function checkDeps(text) {
  const problems = []
  if (!text.includes(KNOWN_DEP)) problems.push(`the classpath listing does not name ${KNOWN_DEP}: not a listing of :app's release classpath`)
  if (/project :originprobe\b/.test(text)) problems.push('the release classpath includes project :originprobe')
  if (/androidx\.credentials:/.test(text)) problems.push('the release classpath includes androidx.credentials')
  return problems
}

export function checkDex(buffers, { requireKnownClass = true } = {}) {
  const problems = []
  if (!buffers.length) return ['no dex files found']
  const all = Buffer.concat(buffers)
  if (requireKnownClass && !all.includes(KNOWN_CLASS)) problems.push(`the dex does not contain ${KNOWN_CLASS}: not the release app's dex`)
  for (const m of MARKS) if (all.includes(m)) problems.push(`the dex contains "${m}"`)
  return problems
}

/** Every classes*.dex under a directory, in a .dex file, or inside an .apk / .aab (zip). */
export function readDex(path) {
  const st = statSync(path)
  if (st.isDirectory()) return readdirSync(path, { recursive: true })
    .filter(f => /(^|\/)classes\d*\.dex$/.test(f)).map(f => readFileSync(join(path, f)))
  if (path.endsWith('.dex')) return [readFileSync(path)]
  const names = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).split('\n').filter(n => /(^|\/)classes\d*\.dex$/.test(n))
  return names.map(n => execFileSync('unzip', ['-p', path, n], { maxBuffer: 1 << 30 }))
}

function args(argv) {
  const out = { dex: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--deps') out.deps = argv[++i]
    else if (a === '--dex') out.dex.push(argv[++i])
    else if (a === '--control') out.control = argv[++i]
    else throw new Error(`unknown argument ${a}`)
  }
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = args(process.argv.slice(2))
  if (!a.deps || !a.dex.length || !a.control) {
    console.error('usage: test-home-android-probe-excluded.mjs --deps <deps.txt> --dex <path> [--dex <path>…] --control <originprobe-debug.apk>')
    process.exit(2)
  }
  let bad = 0
  const say = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }

  const deps = readFileSync(a.deps, 'utf8')
  const d = checkDeps(deps)
  say(d.length === 0, `release classpath of :app is free of the probe${d.length ? ' (' + d.join('; ') + ')' : ''}`)
  for (const p of a.dex) {
    const bufs = readDex(p)
    const x = checkDex(bufs)
    say(x.length === 0, `${p}: ${bufs.length} dex file(s), none of the probe's ${MARKS.length} marks${x.length ? ' (' + x.join('; ') + ')' : ''}`)
  }

  // The check can fail. The probe's own APK must show every mark.
  const ctl = readDex(a.control)
  const hits = checkDex(ctl, { requireKnownClass: false })
  say(hits.length === MARKS.length, `control: the probe's own APK shows ${hits.length}/${MARKS.length} marks`)
  const lines = deps.split('\n')
  const i = lines.findIndex(l => l.includes(KNOWN_DEP))
  for (const [what, line] of [['project :originprobe', '+--- project :originprobe'], ['androidx.credentials', '+--- androidx.credentials:credentials:1.5.0']]) {
    const mutated = [...lines.slice(0, i), line, ...lines.slice(i)].join('\n')
    say(checkDeps(mutated).some(p => p.includes(what)), `control: a classpath with ${what} added is refused`)
  }
  say(checkDeps('').length > 0, 'control: an empty classpath listing is refused')
  say(checkDex([Buffer.from('nothing here')]).length > 0, 'control: a dex without the app\'s classes is refused')

  console.log(bad ? `${bad} failed` : 'all passed')
  process.exit(bad ? 1 : 0)
}
