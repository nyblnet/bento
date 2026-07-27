#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The ONE publish step for bento.page.
//
// `site/` is the assembled deploy tree: AUTHORED sources (landing, guestbook
// page, agents.md, config — tracked in this repo) plus GENERATED artifacts
// (the signed shell, the manifest, the gallery decks, the *.bento.html demos —
// gitignored here, rebuilt by release.mjs / build-example-decks.mjs). This
// script mirrors that tree into the public `bento-site` repo and pushes it, so
// nothing is hand-copied file-by-file and the guestbook / gallery imagery can't
// silently drift between sessions.
//
//   node scripts/publish-site.mjs "commit message"   [--gallery] [--dry]
//
//   --gallery   regenerate the gallery decks first (needs a built shell at
//               slides/dist-single/ — run `npm run build:single` or a release).
//   --dry       show what would change; don't commit or push.
//
// Destination repo: $BENTO_SITE_DIR, else ../bento-site beside this repo.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { gatePackIndex } from './sign-packs.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const site = join(root, 'site')
const dest = process.env.BENTO_SITE_DIR
  ? resolve(process.env.BENTO_SITE_DIR)
  : resolve(root, '..', 'bento-site')

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const doGallery = args.includes('--gallery')
const message = args.find((a) => !a.startsWith('--'))

const die = (m) => { console.error(`✗ ${m}`); process.exit(1) }
const run = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { stdio: 'inherit', ...opts })
const capture = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { encoding: 'utf8', ...opts }).trim()

// ---- preflight -------------------------------------------------------------
if (!existsSync(join(site, 'index.html'))) die(`no assembled site at ${site} — run release.mjs first`)
if (!existsSync(join(dest, '.git'))) die(`destination is not a git repo: ${dest} (set BENTO_SITE_DIR?)`)
if (!dry && !message) die('a commit message is required (or pass --dry)')

// ---- optional: regenerate the gallery --------------------------------------
if (doGallery) {
  const shell = join(root, 'slides/dist-single/Bento_Slides.bento.html')
  if (!existsSync(shell)) die('--gallery needs a built shell — run `npm run build:single` first')
  console.log('• regenerating gallery decks → site/gallery/')
  run('node', [join(root, 'scripts/build-example-decks.mjs'), join(site, 'gallery')])
}

// ---- gate: example decks MUST embed the shell being published --------------
// The gallery templates, the 404 deck AND the guestbook EMBED the shell, so
// they have to be rebuilt/re-shelled whenever the shell changes (release.mjs
// does this — the guestbook is re-shelled in place, preserving its room). Hash
// the shell's app payload (the bento/deflate-b64 blocks) and refuse to publish
// if any embedded-shell deck carries a different one — otherwise a stale deck
// would ship on top of a fresh shell.
const shellFile = join(site, 'releases/slides/Bento_Slides.bento.html')
if (existsSync(shellFile)) {
  const appHash = (file) => {
    const blocks = [...readFileSync(file, 'utf8').matchAll(/type="bento\/deflate-b64"[^>]*>([A-Za-z0-9+/=]+)</g)].map((m) => m[1])
    return blocks.length ? createHash('sha256').update(blocks.join('')).digest('hex') : null
  }
  const shellHash = appHash(shellFile)
  const galleryDir = join(site, 'gallery')
  const decks = [
    ...(existsSync(galleryDir) ? readdirSync(galleryDir).filter((f) => f.endsWith('.bento.html')).map((f) => join(galleryDir, f)) : []),
    join(site, '404.bento.html'),
    join(site, 'guestbook.bento.html'),
  ].filter(existsSync)
  const stale = decks.filter((d) => appHash(d) !== shellHash)
  if (stale.length) {
    die(
      'example decks are on a DIFFERENT shell than the release — rebuild them\n' +
      '  with `node scripts/release.mjs` (or `publish-site.mjs … --gallery`) first:\n' +
      stale.map((d) => '    · ' + d.slice(site.length + 1)).join('\n'),
    )
  }
  console.log(`• shell-consistency gate: ${decks.length} example deck(s) embed the released shell ✓`)
}

// ---- gate: the pack index MUST describe the packs being published ----------
// Same principle as the shell: signed bytes are served bytes. The index pins
// each pack's sha256, so a pack rebuilt after signing (or one dropped into the
// directory by hand) would be rejected by every client with an integrity error
// the user cannot act on. Catch it here instead.
const packIndex = join(site, 'releases/slides/packs.json')
const packsDir = join(site, 'releases/slides/packs')
if (existsSync(packIndex)) {
  if (!existsSync(packsDir)) die(`${packIndex.slice(site.length + 1)} exists but there are no packs beside it — re-run release.mjs`)
  try {
    gatePackIndex(packIndex, packsDir)
    console.log('• pack-index gate: every published pack matches its signed hash ✓')
  } catch (e) {
    die(`${e.message}\n  Re-sign with: node scripts/sign-packs.mjs ${packsDir} --out ${packIndex}`)
  }
} else if (existsSync(packsDir) && readdirSync(packsDir).some((f) => f.endsWith('.pack.json'))) {
  // Unsigned packs on the CDN are worse than no packs: nothing would verify
  // them, and a client that fell back to "just fetch it" would be trusting
  // the host. Refuse rather than publish an unverifiable language.
  die(`language packs are staged at ${packsDir.slice(site.length + 1)} but packs.json is MISSING — an unsigned pack must never be published.\n  Fix: node scripts/sign-packs.mjs ${packsDir} --out ${packIndex}`)
}

// ---- mirror site/ → dest (authoritative; never touches dest/.git) ----------
const rsyncFlags = ['-a', '--delete', '--exclude', '.git']
if (dry) rsyncFlags.push('-n', '-v', '--itemize-changes')
console.log(`• ${dry ? 'DRY-RUN ' : ''}mirroring ${site}/ → ${dest}/`)
run('rsync', [...rsyncFlags, `${site}/`, `${dest}/`])
if (dry) { console.log('\n(dry run — the itemized list above is the pending change set; nothing published)'); process.exit(0) }

// ---- commit + push ---------------------------------------------------------
run('git', ['-C', dest, 'add', '-A'])
const status = capture('git', ['-C', dest, 'status', '--porcelain'])
if (!status) { console.log('✓ nothing changed — bento-site already up to date'); process.exit(0) }

run('git', ['-C', dest, 'commit', '-q', '-m', message])
run('git', ['-C', dest, 'push', '-q', 'origin', 'HEAD'])
const head = capture('git', ['-C', dest, 'rev-parse', '--short', 'HEAD'])
const ver = (() => {
  try {
    const m = JSON.parse(readFileSync(join(dest, 'releases/slides/manifest.json'), 'utf8'))
    return JSON.parse(m.payload).version
  } catch { return '?' }
})()
console.log(`\n✓ published to bento-site @ ${head} (app v${ver})`)

// ---- GitHub release --------------------------------------------------------
// Publishing the site makes a version downloadable and self-updatable, but the
// GitHub release is how people who arrive from the repo get the file at all —
// and being a separate manual step in RELEASING.md, it was simply forgotten for
// v1.0.10. Documentation did not prevent that; doing it here does.
//
// Idempotent: an existing release is left alone, and only a missing asset is
// uploaded, so re-running publish is always safe. NOT best-effort — unlike the
// guestbook re-seed below, a failure here is reported loudly and exits non-zero,
// because a silent skip is the exact failure being fixed.
const releaseShell = join(site, 'releases/slides/Bento_Slides.bento.html')
const tag = `v${ver}`

const ghAvailable = (() => {
  try { capture('gh', ['auth', 'status'], { stdio: ['ignore', 'pipe', 'pipe'] }); return true }
  catch { return false }
})()

if (ver === '?') {
  console.warn('⚠ could not read the published version — skipping the GitHub release step')
} else if (!ghAvailable) {
  die(`site is published, but gh is unavailable or unauthenticated — the GitHub release for ${tag} was NOT created.\n  Fix: gh auth login, then:  gh release create ${tag} ${releaseShell} --title ${tag} --notes-file <notes>`)
} else {
  const exists = (() => {
    try { capture('gh', ['release', 'view', tag], { stdio: ['ignore', 'pipe', 'pipe'] }); return true }
    catch { return false }
  })()

  if (!exists) {
    // Notes come from the CHANGELOG section for this version, so the release
    // and the file in the repo can never drift apart.
    //
    // This used to degrade silently to a 'See CHANGELOG.md.' pointer when the
    // section could not be found, which is how v1.0.11 shipped with no notes at
    // all while every earlier release carried its entries. A contentless release
    // is the same class of failure as a missing one, so it dies here for the
    // same reason the gh check above does. Publishing is idempotent: fix the
    // CHANGELOG and re-run.
    const notes = (() => {
      let cl
      try { cl = readFileSync(join(root, 'CHANGELOG.md'), 'utf8') }
      catch (e) { die(`site is published, but CHANGELOG.md could not be read from ${root} — the GitHub release for ${tag} was NOT created.\n  ${e.message}`) }
      const start = cl.indexOf(`## [${ver}]`)
      if (start < 0) {
        die(`site is published, but CHANGELOG.md has no '## [${ver}]' section — the GitHub release for ${tag} was NOT created.\n  Add the section, then re-run: node scripts/publish-site.mjs`)
      }
      const rest = cl.indexOf('\n## [', start + 1)
      const body = cl.slice(cl.indexOf('\n', start) + 1, rest > 0 ? rest : undefined).trim()
      if (!body) {
        die(`site is published, but the '## [${ver}]' CHANGELOG section is empty — the GitHub release for ${tag} was NOT created.`)
      }
      return body
    })()
    const intro = "Download the single file below and open it in any modern browser — it's the document, the viewer and the editor in one. Shipped files self-update through the signed release channel.\n\n"
    const notesFile = join(tmpdir(), `bento-release-${ver}.md`)
    writeFileSync(notesFile, intro + notes)
    run('gh', ['release', 'create', tag, releaseShell, '--title', tag, '--notes-file', notesFile])
    console.log(`✓ GitHub release ${tag} created with the signed shell attached`)
  } else {
    const assets = (() => {
      try { return capture('gh', ['release', 'view', tag, '--json', 'assets', '-q', '.assets[].name']) }
      catch { return '' }
    })()
    if (!assets.includes('Bento_Slides.bento.html')) {
      run('gh', ['release', 'upload', tag, releaseShell, '--clobber'])
      console.log(`✓ attached the signed shell to the existing release ${tag}`)
    } else {
      console.log(`✓ GitHub release ${tag} already published`)
    }
  }

  // Assert rather than assume: "publish succeeded" must mean the release is
  // actually there, with the file on it.
  const check = (() => {
    try { return capture('gh', ['release', 'view', tag, '--json', 'assets', '-q', '.assets[].name']) }
    catch { return '' }
  })()
  if (!check.includes('Bento_Slides.bento.html')) {
    die(`GitHub release ${tag} is missing Bento_Slides.bento.html after publishing — attach it before announcing.`)
  }
}

// ---- keep the LIVE guestbook daemon on the freshly-published shell ---------
// bento.page/guestbook.bento.html is served by the Cloudflare daemon from KV,
// not from this static tree — so a new shell doesn't reach it until the daemon
// is re-seeded. This round-trips the daemon's own current deck onto the fresh
// shell (walls preserved) and is a no-op when it's already current. Best-effort:
// the script exits 0 on any problem (no key / daemon down), so publish never
// fails on it.
try {
  run('node', [join(root, 'scripts/reseed-guestbook.mjs')])
} catch (e) {
  console.warn(`⚠ guestbook daemon re-seed step errored (non-fatal): ${e.message ?? e}`)
}
