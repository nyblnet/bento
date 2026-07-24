#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// Cut a Bento Slides release: build the shell, sign the manifest, and
// assemble the complete static site for bento.page into ./site/.
//
//   node scripts/release.mjs [--no-build] [--key path]
//
// Output (publish ./site/ to GitHub Pages — see docs/RELEASING.md):
//   site/
//     CNAME                                  bento.page
//     index.html                             placeholder landing page
//     slides/index.html                      live demo (the shell itself)
//     releases/slides/Bento_Slides.bento.html   the download
//     releases/slides/manifest.json          signed update manifest
//
// The bytes that get SIGNED are the bytes that get SERVED — everything is
// staged from one local build, so the manifest sha256 always matches the
// shell at releases/. (This is why releases are cut locally, not in CI:
// the signing key never leaves this machine, and there is no risk of a CI
// rebuild producing different bytes than what was signed.)

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spliceDoc } from './guestbook-deck.mjs'
import { gateShell } from './shell-gate.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const version = JSON.parse(readFileSync(join(root, 'slides/package.json'), 'utf8')).version
const shellSrc = join(root, 'slides/dist-single/Bento_Slides.bento.html')
const site = join(root, 'site')

if (!args.includes('--no-build')) {
  console.log(`Building v${version}…`)
  execFileSync('npm', ['run', 'build:single'], { cwd: join(root, 'slides'), stdio: 'inherit' })
}

rmSync(site, { recursive: true, force: true })
mkdirSync(join(site, 'releases/slides'), { recursive: true })
mkdirSync(join(site, 'slides'), { recursive: true })

cpSync(shellSrc, join(site, 'releases/slides/Bento_Slides.bento.html'))
// The live demo IS the shell — opening it boots the editor with the starter deck.
cpSync(shellSrc, join(site, 'slides/index.html'))

// CONFORMANCE GATE — old updaters are frozen code; every release must
// satisfy the splice contract they rely on. The gate itself lives in
// scripts/shell-gate.mjs (shared with CI, which runs it on every PR build).
gateShell(join(site, 'releases/slides/Bento_Slides.bento.html'))

// Sign the manifest against the staged bytes.
const signArgs = [
  join(root, 'scripts/sign-release.mjs'),
  join(site, 'releases/slides/Bento_Slides.bento.html'),
  '--out', join(site, 'releases/slides/manifest.json'),
]
const key = opt('key', null)
if (key) signArgs.push('--key', key)
execFileSync('node', signArgs, { stdio: 'inherit' })

writeFileSync(join(site, 'CNAME'), 'bento.page\n')
// The site is fully pre-built static — disable Jekyll so every file is served
// verbatim. Without this, GitHub Pages' Jekyll processes .md files that carry
// YAML front matter (e.g. skills/*/SKILL.md) into .html, 404-ing the .md URL.
writeFileSync(join(site, '.nojekyll'), '')

// The real landing page — assembled from site-src/landing.html with the
// deck's embedded typefaces injected (scripts/build-landing.mjs).
execFileSync('node', [join(root, 'scripts/build-landing.mjs'), join(site, 'index.html')], { stdio: 'inherit' })

// The gallery — four template decks spliced from the same staged shell
// (each carries template:true; opening one mints a fresh, independent deck).
execFileSync('node', [join(root, 'scripts/build-example-decks.mjs'), join(site, 'gallery')], { stdio: 'inherit' })

// The agent guide — the runnable version of the "designed for AI" claim.
// Stamp the current shell version so the guide declares which feature set it
// matches (agents can compare it to a deck written by a newer shell).
writeFileSync(
  join(site, 'agents.md'),
  readFileSync(join(root, 'docs/agents.md'), 'utf8').replace(/__APP_VERSION__/g, version),
)
// The harness skill (canonical home: the Claude Code plugin at
// plugins/bento-slides). Published three ways: the raw SKILL.md (curl
// one-liner), a claude.ai-uploadable zip (must contain bento-slides/SKILL.md,
// folder-inside-zip), and a compat copy at the old bento-deck URL.
const skillSrc = join(root, 'plugins/bento-slides/skills/bento-slides/SKILL.md')
mkdirSync(join(site, 'skills/bento-slides'), { recursive: true })
cpSync(skillSrc, join(site, 'skills/bento-slides/SKILL.md'))
mkdirSync(join(site, 'skills/bento-deck'), { recursive: true })
cpSync(skillSrc, join(site, 'skills/bento-deck/SKILL.md'))
execFileSync('zip', ['-q', '-X', '-o', 'bento-slides.zip', 'bento-slides/SKILL.md'], { cwd: join(site, 'skills') })

// MIT license — travels to the public site repo so the published tree carries it.
cpSync(join(root, 'LICENSE'), join(site, 'LICENSE'))

// /help — the user-facing guide (linked from the editor's ? overlay).
mkdirSync(join(site, 'help'), { recursive: true })
cpSync(join(root, 'site-src/help.html'), join(site, 'help/index.html'))

// 404 — of course it's a deck (see build-404-deck.mjs + site-src/404.html).
execFileSync('node', [join(root, 'scripts/build-404-deck.mjs'), join(site, '404.bento.html')], { stdio: 'inherit' })
cpSync(join(root, 'site-src/404.html'), join(site, '404.html'))

// /q — "this QR code is a presentation" (deck lives in the URL fragment).
execFileSync('node', [join(root, 'scripts/build-qr-page.mjs'), join(site, 'q/index.html')], { stdio: 'inherit' })

// /hello.bento.html — the launch announcement, itself a Bento deck (U1). This
// is the Show HN link target: opening it boots the editor with the pitch
// loaded as a live, editable template deck.
execFileSync('node', [join(root, 'scripts/build-announcement-deck.mjs'), join(site, 'hello.bento.html')], { stdio: 'inherit' })

// The Guestbook (U2) — ships only once an epoch has been minted into
// working/guestbook-live/ (scripts/build-guestbook.mjs). Kill switch:
// delete that file and re-release.
const guestbook = join(root, 'working/guestbook-live/guestbook.bento.html')
if (existsSync(guestbook)) {
  // RE-SHELL the current epoch onto the freshly-built shell (don't just copy a
  // deck that may embed an old shell). The document — room creds, docId, wall
  // seed — is shell-independent, so re-splicing it into the new shell keeps the
  // SAME live room and walls while updating the runtime. This is why the
  // guestbook never lags a release. (An epoch ROLL, with fresh creds, is a
  // separate deliberate act: scripts/build-guestbook.mjs / the daemon.)
  const freshShell = readFileSync(join(site, 'releases/slides/Bento_Slides.bento.html'), 'utf8')
  const gbHtml = readFileSync(guestbook, 'utf8')
  const m = gbHtml.match(/<script type="application\/bento\+json" id="bento-doc">\s*([\s\S]*?)\s*<\/script>/)
  if (!m) throw new Error('guestbook: no #bento-doc block in working/guestbook-live/')
  const gbDoc = JSON.parse(m[1].replace(/\\u003c/g, '<'))
  const reshelled = spliceDoc(freshShell, gbDoc)
  writeFileSync(guestbook, reshelled) // keep the working epoch file on the fresh shell too
  cpSync(guestbook, join(site, 'guestbook.bento.html'))
  mkdirSync(join(site, 'guestbook'), { recursive: true })
  cpSync(join(root, 'site-src/guestbook.html'), join(site, 'guestbook/index.html'))
  console.log(`guestbook: re-shelled current epoch onto the fresh shell (room ${gbDoc.collab?.room?.split('/').pop() ?? '?'})`)
} else {
  console.log('guestbook: not armed (working/guestbook-live/ empty) — skipped')
}

console.log(`\nSite assembled for v${version}:`)
execFileSync('find', [site, '-type', 'f'], { stdio: 'inherit' })
console.log('\nPublish ./site/ to the gh-pages branch (docs/RELEASING.md).')
