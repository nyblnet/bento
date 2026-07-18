#!/usr/bin/env node
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
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
// satisfy the splice contract they rely on (see postbuild-compress.mjs):
// plaintext #bento-doc, regex-extractable, balanced script tags, and a
// v0.1.0-style text splice must produce a well-formed document.
{
  const shell = readFileSync(join(site, 'releases/slides/Bento_Slides.bento.html'), 'utf8')
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

// The real landing page — assembled from site-src/landing.html with the
// deck's embedded typefaces injected (scripts/build-landing.mjs).
execFileSync('node', [join(root, 'scripts/build-landing.mjs'), join(site, 'index.html')], { stdio: 'inherit' })

// The gallery — four template decks spliced from the same staged shell
// (each carries template:true; opening one mints a fresh, independent deck).
execFileSync('node', [join(root, 'scripts/build-example-decks.mjs'), join(site, 'gallery')], { stdio: 'inherit' })

console.log(`\nSite assembled for v${version}:`)
execFileSync('find', [site, '-type', 'f'], { stdio: 'inherit' })
console.log('\nPublish ./site/ to the gh-pages branch (docs/RELEASING.md).')
