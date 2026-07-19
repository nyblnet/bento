#!/usr/bin/env node
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
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
