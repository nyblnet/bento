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

// Placeholder landing page — replaced by the real one before public launch.
writeFileSync(
  join(site, 'index.html'),
  `<!DOCTYPE html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bento — the office suite that fits in a file</title>
<style>
  body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         max-width: 640px; margin: 12vh auto; padding: 0 24px; color: #1e2a3a; }
  h1 { font-size: 28px; } a { color: #b87400; }
  .apps { margin-top: 2em; } .soon { color: #8a94a3; }
</style>
<h1>🍱 Bento</h1>
<p>An office suite where every document is a single, self-contained HTML file —
data, viewer and editor together. Open it anywhere, edit it, and it saves itself.
No install, no account, no cloud.</p>
<div class="apps">
  <p><b>Slides</b> — <a href="/slides/">try it in your browser</a> or
  <a href="/releases/slides/Bento_Slides.bento.html" download="Bento_Slides.bento.html">download
  the app</a> (one HTML file — that's all of it).</p>
  <p class="soon"><b>Docs</b> — in development · <b>Sheets</b> — planned</p>
</div>
`,
)

console.log(`\nSite assembled for v${version}:`)
execFileSync('find', [site, '-type', 'f'], { stdio: 'inherit' })
console.log('\nPublish ./site/ to the gh-pages branch (docs/RELEASING.md).')
