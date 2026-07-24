#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// CONFORMANCE GATE — old updaters are frozen code; every shell must satisfy
// the splice contract they rely on (see postbuild-compress.mjs): plaintext
// #bento-doc, regex-extractable, balanced script tags, and a v0.1.0-style
// text splice must produce a well-formed document.
//
// One implementation, two callers: release.mjs runs it before signing, and
// CI runs it on every PR's build (node scripts/shell-gate.mjs <shell.html>).
// CI validating the contract is NOT a release — signing stays local-only
// (docs/RELEASING.md); this file must never touch keys or manifests.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Throws with a GATE: message on the first violated invariant. */
export function gateShell(shellPath) {
  const shell = readFileSync(shellPath, 'utf8')
  const blockRe = /<script type="application\/bento\+json" id="bento-doc">[\s\S]*?<\/script>/
  if (!blockRe.test(shell)) throw new Error('GATE: #bento-doc block not found/extractable')
  const opens = (shell.match(/<script[\s>]/g) ?? []).length
  const closes = shell.split('</scr' + 'ipt>').length - 1
  if (opens !== closes) throw new Error(`GATE: script tag imbalance (${opens}/${closes})`)
  const fakeDoc = JSON.stringify({ format: 'bento/slides', probe: '<tag> & </close>' }).replace(/</g, '\\u003c')
  const spliced = shell.replace(blockRe, `<script type="application/bento+json" id="bento-doc">\n${fakeDoc}\n</scr` + 'ipt>')
  if (!spliced.includes(fakeDoc)) throw new Error('GATE: splice failed')
  const opens2 = (spliced.match(/<script[\s>]/g) ?? []).length
  const closes2 = spliced.split('</scr' + 'ipt>').length - 1
  if (opens2 !== closes2) throw new Error('GATE: spliced document imbalanced')
  console.log('conformance gate: old-updater splice contract OK')
}

// CLI: node scripts/shell-gate.mjs <path-to-shell.html>
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = process.argv[2]
  if (!target) {
    console.error('usage: node scripts/shell-gate.mjs <shell.html>')
    process.exit(2)
  }
  gateShell(target)
}
