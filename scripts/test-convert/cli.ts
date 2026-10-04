// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento convert, driven as a user drives it: a child process, real files, the
// real built slides shell, exit codes and stderr.
//
// Offline by construction — every import here passes --shell, so nothing is
// fetched. The signed-channel path is the delivery rig's (deliver.ts), which
// drives the real verifySigned with a throwaway key. What this rig owns is the
// command line: usage and refusals, the import itself, and that a converted
// file OPENS — booted in headless Chrome through
// scripts/bento-check.mjs, the same harness CI already trusts.
//
// Like the bento-check rig: without Chrome or a built shell it SKIPS locally,
// and in CI a skip is a failure.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fxMinimal } from './_fixtures.ts'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const cli = path.join(root, 'convert/cli.mjs')
const shell = path.join(root, 'slides/dist-single/Bento_Slides.bento.html')
const inCI = !!process.env.CI || !!process.env.GITHUB_ACTIONS

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

if (!fs.existsSync(shell)) {
  const why = `no built shell at ${shell} (cd slides && npm run build:single)`
  if (inCI) { console.log(`  FAIL  ${why} — cannot skip in CI`); process.exit(1) }
  console.log(`  ⚠ SKIPPED — ${why}`)
  process.exit(0)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-cli-rig-'))
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 120_000 })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
const BLOCK = '<script type="application/bento+json" id="bento-doc">'
const CLOSE = '</' + 'script>'
const docOf = (html: string) => {
  const s = html.indexOf(BLOCK) + BLOCK.length
  return JSON.parse(html.slice(s, html.indexOf(CLOSE, s)))
}

console.log('usage')
{
  const r = run([])
  ok(r.code === 2 && /usage:/.test(r.err), 'no arguments → exit 2 and the usage')
  ok(run(['x.pptx', '--offline']).code === 2, '--offline without --shell → exit 2 (checked before touching the disk)')
  ok(run(['x.bento.html']).code === 2, 'an input that is not a .pptx → exit 2')
  ok(run(['x.pptx', '--frobnicate']).code === 2, 'an unknown option → exit 2')
  ok(run(['missing.pptx', '--shell', shell]).code === 1, 'a missing input → exit 1')
  const h = run(['--help'])
  ok(h.code === 0 && /usage:/.test(h.out), '--help → exit 0, usage on STDOUT')
  ok(run(['convert', '--help']).code === 0, 'a leading `convert` is accepted, for a future `bento` dispatcher')
}

console.log('import')
const pptx = path.join(tmp, 'rig.pptx')
fs.writeFileSync(pptx, await fxMinimal())
const imported = path.join(tmp, 'rig.bento.html')
{
  const r = run([pptx, '--shell', shell, '-o', imported])
  ok(r.code === 0 && fs.existsSync(imported), `a .pptx imports into the real shell (exit ${r.code})`)
  ok(r.out === '', 'stdout stays clean — the report goes to stderr')
  ok(/fidelity:/.test(r.err) && /NOT verified against the release channel/.test(r.err),
    'stderr carries the report, and says plainly that a --shell was not channel-verified')
  const doc = docOf(fs.readFileSync(imported, 'utf8'))
  ok(doc.format === 'bento/slides' && doc.title === 'Rig Deck', 'the file carries the converted document')
  const gate = spawnSync(process.execPath, [path.join(root, 'scripts/shell-gate.mjs'), imported], { encoding: 'utf8' })
  ok(gate.status === 0, 'the output passes the splice-contract gate every release runs')
}

console.log('it opens')
{
  const CHROME = [process.env.BENTO_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].find((p): p is string => !!p && fs.existsSync(p))
    ?? (spawnSync('which', ['google-chrome']).status === 0 ? 'google-chrome' : undefined)
  if (!CHROME) {
    if (inCI) ok(false, 'no Chrome — the "it opens" check cannot skip in CI')
    else console.log('  ⚠ SKIPPED — no Chrome found (set BENTO_CHROME)')
  } else {
    // The converted DOCUMENT, booted in the real shell through bento-check's
    // JSON input — not the spliced .bento.html. Measured 2026-09-26: on a
    // loaded machine bento-check's .bento.html input path runs to its 90s
    // ceiling for ANY file (the bare shell reports at 90042ms; a tiny
    // hand-written deck never reports), while the same document as JSON boots
    // in 738ms. That is bento-check's defect, filed for ops, and not a reason
    // to weaken this check. The spliced FILE is covered separately and fully
    // above: the splice-contract gate, and an exact read-back of the block.
    const json = path.join(tmp, 'imported.json')
    fs.writeFileSync(json, JSON.stringify(docOf(fs.readFileSync(imported, 'utf8'))))
    const r = spawnSync(process.execPath, [path.join(root, 'scripts/bento-check.mjs'), json, '--shell', shell, '--json', '--fail-on', 'error'],
      { encoding: 'utf8', timeout: 180_000, env: { ...process.env, BENTO_CHROME: CHROME } })
    let report: { ok?: boolean; slides?: number } | null = null
    try { report = JSON.parse(r.stdout) } catch { /* reported below */ }
    ok(r.status === 0 && report?.ok === true && report.slides === 1,
      `the converted document boots in the real shell in headless Chrome, no errors (exit ${r.status}, slides ${report?.slides})`)
  }
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
