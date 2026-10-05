#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento convert — PowerPoint in and out, from a terminal.
//
//   node convert/cli.mjs <deck.pptx> [-o out.bento.html] [--shell path | --offline]
//   node convert/cli.mjs <deck.bento.html> --to pptx [-o out.pptx]
//
// A leading `convert` is accepted and ignored, so a future `bento` dispatcher
// can call this as `bento convert …` unchanged.
//
// IMPORT writes the deck into the CURRENT signed slides shell: the release
// manifest's signature is verified, the shell's bytes are checked against the
// signed pin, and a shell that fails either, or is older than
// MIN_SHELL_VERSION, is refused. The document then passes the same
// untrusted-input gate slides applies to every foreign document, and is
// spliced in per the splice contract. `--shell` uses a local build instead
// (development, air-gapped use; no channel check, and it says so); `--offline`
// refuses the network entirely and requires `--shell`.
//
// EXPORT (--to pptx) reads a saved deck's #bento-doc block and writes a .pptx.
// It needs no network. It refuses an encrypted deck, a raw compact document and
// non-slides files, each with what to do instead. Export is a library and this
// command, never a button in the app: the writer stays out of every shell.
//
// The fidelity report goes to STDERR, so stdout stays clean for scripting.
// Exit codes: 0 converted, 1 refused or failed, 2 usage.
//
// HOW IT RUNS. The engine is TypeScript that imports slides' untrusted-input
// gate, whose own imports are extensionless — so, like scripts/bento-check.mjs,
// this bundles its entry with the repo's esbuild on each run and imports the
// result. No new dependency; slides/node_modules must be installed.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The kernel's storage helper touches `localStorage`, which node 26 exposes
// only behind a flag and warns about on first access. Harmless here (a CLI has
// no preferences to read), but stderr carries the fidelity report, so that one
// warning is filtered and every other warning still prints.
process.removeAllListeners('warning')
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /localStorage/.test(w.message)) return
  process.stderr.write(`${w.name}: ${w.message}\n`)
})

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = `usage:
  bento convert <deck.pptx> [-o out.bento.html] [--shell path | --offline]
  bento convert <deck.bento.html> --to pptx [-o out.pptx]`

function die(msg, code = 1) {
  process.stderr.write(`bento convert: ${msg}\n`)
  process.exit(code)
}

// --- arguments ---------------------------------------------------------------
const argv = process.argv.slice(2)
if (argv[0] === 'convert') argv.shift()
const opts = { out: null, to: null, shell: null, offline: false, input: null }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const val = () => (i + 1 < argv.length ? argv[++i] : die(`${a} needs a value\n${USAGE}`, 2))
  if (a === '-o' || a === '--out') opts.out = val()
  else if (a === '--to') opts.to = val()
  else if (a === '--shell') opts.shell = val()
  else if (a === '--offline') opts.offline = true
  else if (a === '-h' || a === '--help') { process.stdout.write(USAGE + '\n'); process.exit(0) }
  else if (a.startsWith('-')) die(`unknown option ${a}\n${USAGE}`, 2)
  else if (opts.input) die(`one input at a time\n${USAGE}`, 2)
  else opts.input = a
}
if (!opts.input) die(USAGE, 2)
if (opts.to && opts.to !== 'pptx') die(`--to ${opts.to}: only pptx is supported`, 2)
const isPptx = /\.pptx$/i.test(opts.input)
const isBento = /\.html?$/i.test(opts.input)
const exporting = opts.to === 'pptx'
if (exporting ? !isBento : !isPptx)
  die(`${opts.input}: expected ${exporting ? 'a .bento.html to export' : 'a .pptx (or a .bento.html with --to pptx)'}`, 2)
if (!exporting && opts.offline && !opts.shell) die('--offline needs --shell: there is no other shell to use', 2)
if (!fs.existsSync(opts.input)) die(`no such file: ${opts.input}`)

// --- the engine, bundled -----------------------------------------------------
const esbuild = path.join(root, 'slides/node_modules/.bin/esbuild')
if (!fs.existsSync(esbuild)) die('slides/node_modules is missing — run `cd slides && npm install`')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-convert-'))
const bundle = path.join(tmp, 'api.mjs')
const built = spawnSync(esbuild, [
  path.join(root, 'convert/src/index.ts'), '--bundle', '--format=esm', '--platform=node',
  '--log-level=error', `--outfile=${bundle}`,
], { encoding: 'utf8' })
if (built.status !== 0) die(`could not build the engine:\n${built.stderr}`)
const api = await import(pathToFileURL(bundle).href)

// The engine reports only what it could NOT carry as-is, so "0 carried" would
// read as "nothing made it"; the carried tally is shown only when it is counted.
const count = (r) => [r.counts.carried ? `${r.counts.carried} carried` : '',
  `${r.counts.approximated ?? 0} approximated`, `${r.counts.dropped ?? 0} dropped`].filter(Boolean).join(' · ')
function printReport(r) {
  process.stderr.write(`fidelity: ${count(r)}\n`)
  // One line per (verdict, code), dropped first — the engine reports per slide,
  // so a long deck otherwise repeats the same code once per slide and the one
  // line that matters drowns. Same folding as the /import page.
  const folded = new Map()
  for (const e of r.entries) {
    if (e.verdict === 'carried') continue
    const k = `${e.verdict}\u0000${e.code}`
    const f = folded.get(k) ?? { ...e, count: 0 }
    f.count += e.count ?? 1
    folded.set(k, f)
  }
  const rank = { dropped: 0, approximated: 1 }
  for (const e of [...folded.values()].sort((a, b) => (rank[a.verdict] ?? 2) - (rank[b.verdict] ?? 2)))
    process.stderr.write(`  ${e.verdict.padEnd(12)} ${e.code}${e.count > 1 ? ` ×${e.count}` : ''} — ${e.detail}\n`)
}

try {
  if (exporting) {
    const res = await api.bentoToPptx(fs.readFileSync(opts.input, 'utf8'))
    const out = opts.out ?? opts.input.replace(/(\.bento)?\.html?$/i, '') + '.pptx'
    fs.writeFileSync(out, res.bytes)
    printReport(res.report)
    process.stderr.write(`wrote ${out} (${res.bytes.length} bytes)\n`)
  } else {
    let shell
    if (opts.shell) {
      shell = fs.readFileSync(opts.shell, 'utf8')
      process.stderr.write(`shell: ${opts.shell} (local — NOT verified against the release channel)\n`)
    } else {
      const v = await api.fetchVerifiedShell()
      shell = v.html
      process.stderr.write(`shell: bento/slides ${v.version} — signature and pin verified\n`)
    }
    const res = await api.pptxToBento(new Uint8Array(fs.readFileSync(opts.input)), shell)
    const out = opts.out ?? opts.input.replace(/\.pptx$/i, '') + '.bento.html'
    fs.writeFileSync(out, res.html)
    printReport(res.report)
    if (res.gated.length)
      process.stderr.write(`gate: removed ${res.gated.length} value(s) the format does not allow\n`)
    process.stderr.write(`wrote ${out} — "${res.title}", ${res.slides} slide(s)\n`)
  }
} catch (err) {
  die(err instanceof api.LimitError ? `refused: ${err.message}` : err.message)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
