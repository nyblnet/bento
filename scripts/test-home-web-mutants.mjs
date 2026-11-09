#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Mutants for scripts/test-home-web.mjs: each one breaks a single rule of
 * bento/home in your browser, and the rig must go red ON THE ROW THAT GUARDS
 * IT. A mutant whose text is not found exactly once fails the run (the build
 * refuses it), so a mutant can never quietly stop being applied.
 *
 *   PLAYWRIGHT_MODULE=…/playwright/index.mjs node scripts/test-home-web-mutants.mjs [name…]
 *
 * `src` mutates home/web/src before the build; `dist` mutates the built files
 * (headers) after it. Runs the rig in Chromium.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const MUTANTS = [
  {
    name: 'run-unverified', why: '[T4] skip the check: anything runs as the newest held release',
    src: { file: 'verify.ts', from: "  if (v.verdict !== 'genuine') return { verdict: 'unknown', reason: v.reason }\n",
      to: "  if (v.verdict !== 'genuine') return { verdict: 'genuine', appId: held[0].app, release: held[0].releases[0], plan: executableScripts(scanBlocks(html)).map((b) => ({ tagStart: b.tagStart, start: b.start, end: b.end, text: b.text, module: false })) }\n" },
    expect: 'one byte flipped in its compressed runtime: never runs',
  },
  {
    name: 'newest-only', why: '[T4] verify against the newest release only, not the history',
    src: { file: 'verify.ts', from: 'list(): History[] { return [...this.held.values()] }', to: 'list(): History[] { return [...this.held.values()].map((h) => ({ ...h, releases: h.releases.slice(0, 1) })) }' },
    expect: 'an older file still runs in its OWN release',
  },
  {
    name: 'key-from-envelope', why: '[T4] take the verification key from what the channel sent',
    src: { file: 'verify.ts', from: "verifySigned(raw, 'release history', this.key)", to: "verifySigned(raw, 'release history', JSON.parse(raw).key ?? this.key)" },
    expect: 'a newer history signed with another key does not make the newer file run',
  },
  {
    name: 'refresh-every-open', why: '[T2] call the channel on every open',
    src: { file: 'verify.ts', from: "  if (first.verdict === 'genuine') return first\n", to: '' },
    expect: 'a file from a bundled release costs no request to the release channel',
  },
  {
    name: 'post-the-file', why: '[T2] send the file somewhere the CSP still allows',
    src: { file: 'library.ts', from: "  await bundled\n", to: "  await bundled\n  void fetch(RELEASE_BASE + 'log', { method: 'POST', body: html.slice(0, 20000) }).catch(() => {})\n" },
    expect: 'every request the browser made is on the allow-list',
  },
  {
    name: 'frame-trusts-any-origin', why: '[B2] the frame script boots without checking it is opaque',
    src: { file: 'frame.ts', from: "  if (win.origin !== 'null') { refuse('(not sandboxed)'); return }\n", to: '' },
    expect: 'served framed but without its header',
  },
  {
    name: 'frame-no-ancestors', why: '[B2] the frame header loses frame-ancestors',
    dist: [{ file: 'frame/_headers', from: '; frame-ancestors ', to: '; x-frame-ancestors ' }],
    expect: 'a foreign page cannot frame it',
  },
  {
    name: 'frame-no-header-sandbox', why: '[B2] the frame header loses its sandbox directive',
    dist: [{ file: 'frame/_headers', from: 'sandbox allow-scripts allow-popups allow-modals; ', to: '' }],
    expect: 'navigated to directly, the frame page is still an opaque origin',
  },
  {
    name: 'frame-may-download', why: '[B3] the frame gets allow-downloads (attribute and header)',
    src: { file: 'library.ts', from: "'allow-scripts allow-popups allow-modals'", to: "'allow-scripts allow-popups allow-modals allow-downloads'" },
    dist: [{ file: 'frame/_headers', from: 'sandbox allow-scripts allow-popups allow-modals;', to: 'sandbox allow-scripts allow-popups allow-modals allow-downloads;' }],
    expect: '[B3] a download started inside the frame produces no file',
  },
  {
    name: 'frame-may-navigate', why: '[B4] a frame that navigates away is kept',
    src: { file: 'library.ts', from: 'if (session === s && s.pong < n) fail(', to: 'if (false && s.pong < n) fail(' },
    expect: '[B4] a document that navigates its frame away is closed',
  },
  {
    name: 'download-unverified', why: '[T4] Download offered for a file shown read-only',
    src: { file: 'library.ts', from: 'dl.hidden = !opts.download', to: 'dl.hidden = false' },
    expect: 'read-only: no Download is offered',
  },
]

const only = process.argv.slice(2)
let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }
for (const m of MUTANTS.filter((x) => !only.length || only.includes(x.name))) {
  const env = { ...process.env, BENTO_BROWSER: 'chromium', NODE_NO_WARNINGS: '1' }
  delete env.BENTO_HOME_WEB_MUTANT; delete env.BENTO_HOME_WEB_DIST_MUTANT
  if (m.src) env.BENTO_HOME_WEB_MUTANT = JSON.stringify(m.src)
  if (m.dist) env.BENTO_HOME_WEB_DIST_MUTANT = JSON.stringify(m.dist)
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/test-home-web.mjs')], { env, encoding: 'utf8', timeout: 600_000 })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const applied = (m.src ? /mutant applied to a source/.test(out) && /mutant applied to b source/.test(out) : true) &&
    (m.dist ? m.dist.every((d) => out.includes(`mutant applied to a/${d.file}`) && out.includes(`mutant applied to b/${d.file}`)) : true)
  const caught = out.split('\n').some((l) => l.includes('FAIL') && l.includes(m.expect))
  ok(applied && r.status !== 0 && caught, `${m.name}: ${m.why} — ${!applied ? 'NOT APPLIED' : caught ? 'red on its row' : r.status === 0 ? 'SURVIVED' : 'red, but not on its row'}`)
  if (!(applied && caught)) console.log(out.split('\n').filter((l) => /FAIL|Error|mutant/.test(l)).slice(0, 8).map((l) => '        ' + l).join('\n'))
}
console.log(`\n${checks - failures}/${checks} mutants killed`)
process.exit(failures ? 1 : 0)
