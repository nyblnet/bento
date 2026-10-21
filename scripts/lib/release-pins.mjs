// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// RELEASE PINS (K4, security §18 / §36): what a host needs to know a file's
// runtime is a genuine release's, derived from that release's own bytes.
//
// A host that SERVES a document (iOS, Android, desktop, the hosted runtime)
// checks the CODE blocks, which survive every save byte-identical because they
// are textContent, not markup:
//   bento-rt, bento-rt-css   the deflated runtime and stylesheet (data blocks
//                            the loader imports as blob: code, so the CSP cannot
//                            stop a swapped one, only this hash can)
//   loader                   the one executable inline script in the shell
//   remover                  the preview remover every save writes (constant)
// and serves the page with script-src pinned to the loader and the remover.
// A file matches a release only if ONE release matches EVERY block, with
// exactly one block per id; anything less is UNKNOWN (security §36).
//
// Pure string work, no DOM: this runs at release time on the built shell and a
// real saved file, and in CI on every PR's build.

import { createHash } from 'node:crypto'
// ONE implementation of the scanner, the grammar and the host's check: the
// kernel's gate-1 module, which every JavaScript host runs (K5). This file adds
// only what a RELEASE needs: deriving the pins in the first place.
import { scanBlocks, executableScripts, markupProblems, checkAgainstPins, isDataScript, DATA_TYPES } from '../../kernel/src/gate1.ts'
export { scanBlocks, executableScripts, markupProblems, checkAgainstPins, isDataScript, DATA_TYPES }

const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const cspHash = (s) => `sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}`
const CODE_IDS = ['bento-rt', 'bento-rt-css']

/**
 * The pins for a release, from its BUILT shell and a REAL file that release
 * saved (the remover only exists in saved files). Throws, never guesses: the
 * shell has exactly one executable inline script (the loader); the saved file's
 * executable inline scripts are exactly that loader, byte for byte, plus one
 * preview remover; every code block appears once in each, identical in both.
 */
export function derivePins(shellHtml, savedHtml, { historic = false } = {}) {
  const shell = scanBlocks(shellHtml), saved = scanBlocks(savedHtml)
  const fail = (msg) => { throw new Error(`release-pins: ${msg}`) }
  for (const [what, html] of [['built shell', shellHtml], ['saved file', savedHtml]]) {
    const bad = markupProblems(html)
    if (bad.length) fail(`the ${what} carries markup a genuine file never does: ${bad.join('; ')}`)
  }

  const shellExec = executableScripts(shell)
  if (shellExec.length !== 1) fail(`the built shell has ${shellExec.length} executable inline scripts; exactly one (the loader) expected`)
  const loader = shellExec[0].text

  const savedExec = executableScripts(saved)
  const removers = savedExec.filter((b) => b.preview)
  const loaders = savedExec.filter((b) => !b.preview)
  if (loaders.length !== 1 || loaders[0].text !== loader) fail('the saved file does not carry exactly the shell\'s loader, byte for byte')
  // A release from before the first-page preview (slides < 1.0.18) saves no
  // remover. Only a HISTORIC release may lack one: a new release that saves
  // none has a broken preview, and signing it would pin the breakage.
  if (removers.length > 1 || (removers.length === 0 && !historic)) {
    fail(`the saved file has ${removers.length} preview removers; exactly one expected (save a document that gets a preview)`)
  }
  const remover = removers[0]?.text ?? null

  const blocks = { loader: sha256hex(loader), remover: remover === null ? null : sha256hex(remover) }
  for (const id of CODE_IDS) {
    const inShell = shell.filter((b) => b.id === id), inSaved = saved.filter((b) => b.id === id)
    if (inShell.length !== 1) fail(`the built shell has ${inShell.length} #${id} blocks; exactly one expected`)
    if (inSaved.length !== 1) fail(`the saved file has ${inSaved.length} #${id} blocks; exactly one expected`)
    if (inSaved[0].text !== inShell[0].text) fail(`#${id} changed between the shell and a saved file: code blocks must survive a save byte for byte`)
    blocks[id] = sha256hex(inShell[0].text)
  }
  return { v: 1, blocks, scriptSrc: remover === null ? [cspHash(loader)] : [cspHash(loader), cspHash(remover)] }
}
