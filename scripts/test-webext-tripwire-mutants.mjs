#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Mutants for the bento/home tripwire: each turns ONE rule off in a copy of
 * the extension and runs the browser rig's row that guards it. Every mutant
 * must turn that row red; a mutant that leaves it green means the row does not
 * test the rule it claims to.
 *
 *   PLAYWRIGHT_MODULE=…/playwright/index.mjs node scripts/test-webext-tripwire-mutants.mjs
 *
 * The rows run unmutated first (the control): a mutant run means nothing if
 * its row is already red.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RIG = path.join(ROOT, 'scripts/test-webext-tripwire-browser.mjs')
const J = 'src/tripwire-judge.js', W = 'src/tripwire.js', O = 'src/tripwire-observe.js'

const MUTANTS = [
  { name: 'bytes rule off', row: 'library-byte', file: J, from: 'if (obs.bytes && obs.bytes.sha256 !== e.sha256)', to: 'if (false)' },
  { name: 'size rule off', row: 'sw-size', file: J, from: 'if (obs.size > 0 && obs.size !== e.bytes)', to: 'if (false)' },
  { name: 'scripts rule off', row: 'sw-navigation-only', file: J, from: 'if (!scriptsMatch(obs.scripts, e.scripts, site.files))', to: 'if (false)' },
  { name: 'scripts rule off (frame)', row: 'frame-byte', file: J, from: 'if (!scriptsMatch(obs.scripts, e.scripts, site.files))', to: 'if (false)' },
  { name: 'csp rule off', row: 'library-csp', file: J, from: "if (obs.csp != null && join(obs.csp) !== (e.csp ?? ''))", to: 'if (false)' },
  { name: 'navigation headers ignored (webRequest)', row: 'frame-csp', file: W, from: 'const fresh = h && h.url === url', to: 'const fresh = false && h.url === url' },
  { name: 'markup rule off', row: 'sw-markup', file: J, from: "return (obs.flags ?? []).length ? [{ rule: 'markup', got: obs.flags }] : []", to: 'return []' },
  { name: 'self-rewriting script not flagged', row: 'script-rewrite', file: O, from: "if (!text.startsWith(e.text)) flags.add('script-rewritten')", to: '' },
  { name: 'worker URL rule off', row: 'sw-custom-path', file: J, from: 'if (!listed.length) {', to: 'if (listed.length < 0) {' },
  { name: 'worker bytes rule off', row: 'sw-script-bytes', file: J, from: 'if (w.sha256 != null && !listed.some(', to: 'if (false && !listed.some(' },
  { name: 'cache rule off', row: 'sw-cache-extra', file: J, from: 'if (!ok) out.push(', to: 'if (false) out.push(' },
  { name: 'signature not checked', row: 'bad-signature', file: J, from: "const p = await verifySigned(raw, 'bento/home release list', jwk)", to: 'const p = JSON.parse(JSON.parse(raw).payload)' },
  { name: 'type not checked', row: 'wrong-type', file: J, from: "if (p.type !== SERVED_TYPE) return `type is not ${SERVED_TYPE}`", to: '' },
  { name: 'rollback accepted', row: 'rollback', file: J, from: "if (payload.serial < held.serial) return { status: 'rollback', serial: payload.serial }", to: '' },
  { name: 'serial reuse accepted', row: 'conflict', file: J, from: "return held.payload === env.payload ? { status: 'same' } : { status: 'conflict', serial: payload.serial }", to: "return { status: 'same' }" },
  { name: 'no refresh before warning', row: 'stale-held', file: W, from: "if (current && v.verdict !== 'ok' && !refresh) {", to: 'if (false) {' },
  { name: 'only the newest release counts', row: 'rollback', file: J, from: 'const index = perRelease.findIndex((f) => f.length === 0)', to: 'const index = perRelease[0].length === 0 ? 0 : -1' },
  { name: 'older release announced at once', row: 'rollback', file: J, from: 'notify: now - newest > GRACE_MS', to: 'notify: true' },
  { name: 'older release never announced', row: 'outdated-late', file: J, from: 'notify: now - newest > GRACE_MS', to: 'notify: false' },
  { name: 'a mismatch is not announced', row: 'library-byte', file: W, from: "if (v?.verdict === 'mismatch') event.warned.push(...await warn(event, tab, 'mismatch'))", to: '' },
  { name: 'a bad list is not announced', row: 'bad-signature', file: W, from: "if (refresh?.status === 'invalid' || refresh?.status === 'conflict') event.warned.push(", to: 'if (false) event.warned.push(' },
  { name: 'the tripwire "fixes" the page (reloads it)', row: 'sw-cache-poisoned', file: W, from: "      warned.push('badge')", to: "      warned.push('badge'); await chrome.tabs.reload(tab.id)" },
]

const run = (env) => spawnSync(process.execPath, [RIG], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 600000 })
const rows = [...new Set(MUTANTS.map((m) => m.row))]
console.log(`control: rows ${rows.join(', ')} unmutated`)
const control = run({ TW_ROWS: rows.join(',') })
if (control.status !== 0) {
  console.log(control.stdout.split('\n').filter((l) => /FAIL|checks passed/.test(l)).join('\n'))
  console.error('FAIL: the rows are red without a mutant, so no mutant result means anything')
  process.exit(1)
}
console.log(`  ok    ${control.stdout.trim().split('\n').at(-1)}`)
let failures = 0
for (const m of MUTANTS) {
  const r = run({ TW_ROWS: m.row, TW_MUTANT: JSON.stringify({ file: m.file, from: m.from, to: m.to }) })
  const applied = /mutant applied to/.test(r.stdout)
  const red = r.status === 1 && /FAIL/.test(r.stdout)
  const okay = applied && red
  if (!okay) failures++
  const fail = r.stdout.split('\n').find((l) => /FAIL/.test(l))?.trim() ?? ''
  console.log(`  ${okay ? 'ok  ' : 'FAIL'}  ${m.name} → row ${m.row} ${!applied ? 'NOT APPLIED' : red ? 'red' : 'GREEN'}${fail ? `: ${fail.slice(5, 120)}` : ''}${r.status === 2 ? ` (${r.stderr.trim().split('\n').at(-1)})` : ''}`)
}
console.log(`\n${MUTANTS.length - failures}/${MUTANTS.length} mutants red on their row`)
process.exit(failures ? 1 : 0)
