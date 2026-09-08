#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Cut a release for ONE app: build its shell, sign its manifest, and assemble
// the complete static site for bento.page into ./site/.
//
//   node scripts/release.mjs [--app slides|spaces|dash] [--no-build] [--key path] [--out dir]
//
// ONE RELEASE BUILDS ONE APP, and `site/` is mirrored authoritatively — so the
// site is SEEDED from the published tree first and this build overwrites only
// what it produces. That is what keeps a spaces release from deleting slides'
// signed shell, manifest and 22 language packs, which shipped files fetch by
// frozen URL and could never recover. Without a published tree to restore
// from, a release REFUSES (--allow-missing-published for the very first one).
//
// Output (publish ./site/ to GitHub Pages — see docs/RELEASING.md):
//   site/
//     CNAME                                  bento.page
//     index.html                             placeholder landing page
//     <app>/index.html                       live demo (the shell itself)
//     <app>/agents.md                        that app's AI-agent guide
//     releases/<app>/Bento_<App>.bento.html  the download
//     releases/<app>/manifest.json           signed update manifest
//     releases/slides/packs/*.pack.json      language packs (slides only today)
//     releases/slides/packs.json             signed pack index (pins each
//                                            pack's sha256)
//   …plus the shared site — landing, gallery, agent guide, skills, /help, /q,
//   404, guestbook — which is slides-derived and rebuilt only by a slides
//   release; every other app leaves the published copies untouched.
//
// The bytes that get SIGNED are the bytes that get SERVED — everything is
// staged from one local build, so the manifest sha256 always matches the
// shell at releases/. (This is why releases are cut locally, not in CI:
// the signing key never leaves this machine, and there is no risk of a CI
// rebuild producing different bytes than what was signed.)

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spliceDoc } from './guestbook-deck.mjs'
import { gateShell } from './shell-gate.mjs'
import { APPS, RELEASE_MARKER, tagFor } from './apps.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const appKey = opt('app', 'slides')
const app = APPS[appKey]
if (!app) {
  console.error(`✗ unknown --app "${appKey}". Known: ${Object.keys(APPS).join(', ')}`)
  process.exit(1)
}

const version = JSON.parse(readFileSync(join(root, `${app.dir}/package.json`), 'utf8')).version
const shellSrc = join(root, `${app.dir}/dist-single/${app.shell}`)
// Where the site is assembled. `site/` for a real release — publish-site.mjs
// mirrors exactly that path — and `--out` for a rehearsal, so
// scripts/test-release-channel.mjs can drive the REAL pipeline with a
// throwaway key without wiping whatever a maintainer has staged. (The whole
// point of the rig is that it exercises this script rather than a second copy
// of its steps, and the first thing this script does is rmSync the tree.)
const site = opt('out', join(root, 'site'))

/** The live tree, resolved exactly as publish-site.mjs resolves it. */
const published = process.env.BENTO_SITE_DIR
  ? resolve(process.env.BENTO_SITE_DIR)
  : resolve(root, '..', 'bento-site')

// `--print-notes` shows exactly what this release would sign into the manifest,
// then exits. Nothing is built, staged, wiped or signed.
//
// The notes are the one released artifact with no way back: they are inside the
// signed envelope, every shipped file fetches it at launch, and re-signing the
// same version is refused by the monotonicity check. Reading them once, before
// the key is touched, costs a second. (The function declarations below hoist.)
if (args.includes('--print-notes')) {
  const sections = changelogSections()
  console.log(`${app.appId} v${version} — from ${changelogPath()}\n`)
  console.log(releaseNotesString(sections) ?? '(no notes — the changelog has no section for this version)')
  process.exit(0)
}

if (!args.includes('--no-build')) {
  console.log(`Building ${app.appId} v${version}…`)
  execFileSync('npm', ['run', 'build:single'], { cwd: join(root, app.dir), stdio: 'inherit' })
}

rmSync(site, { recursive: true, force: true })
mkdirSync(site, { recursive: true })

// ---- seed from what is ALREADY PUBLISHED -----------------------------------
//
// `site/` is mirrored authoritatively with `rsync --delete`, so anything this
// build does not stage is DELETED from bento.page. One release builds one app;
// every other app's signed shell, manifest and packs are therefore missing —
// and shipped files fetch those by frozen URL, so removing them takes their
// update and pack channels offline permanently, with no client-side repair.
//
// Measured before this existed: a spaces-shaped `site/` removed 47 live files
// with every gate green (docs/DECISIONS.md, 2026-08-02).
//
// So a release STARTS from the live tree and overwrites what it built. That
// makes "restore every untouched app byte-identically" the default rather than
// a step someone has to remember, and it composes with the publish-time
// deletion gate: this fills the gap, that one refuses if a gap remains.
if (existsSync(published)) {
  cpSync(published, site, { recursive: true, filter: (src) => !src.split('/').includes('.git') })
  const seeded = execFileSync('find', [site, '-type', 'f'], { encoding: 'utf8' }).trim().split('\n').length
  console.log(`• seeded site/ from the published tree (${seeded} files) — this build overwrites what it produces`)
} else if (args.includes('--allow-missing-published')) {
  console.log(`⚠ no published tree at ${published} — building a site with ONLY this app's artifacts`)
} else {
  // Fail CLOSED. Continuing would stage a partial site whose publish deletes
  // every other app; the deletion gate would catch it, but failing here says
  // what to do about it.
  console.error(
    `✗ no published tree at ${published}, so this release cannot restore the apps it is not building.\n` +
    `  Publishing a partial site/ deletes every other app's signed shell, manifest and packs\n` +
    `  from bento.page, and shipped files fetch those by frozen URL.\n\n` +
    `  Clone it beside this repo, or set BENTO_SITE_DIR.\n` +
    `  First release ever, with nothing published yet: --allow-missing-published.`,
  )
  process.exit(1)
}

mkdirSync(join(site, `releases/${app.dir}`), { recursive: true })
mkdirSync(join(site, app.dir), { recursive: true })

cpSync(shellSrc, join(site, `releases/${app.dir}/${app.shell}`))
// The live demo IS the shell — opening it boots the editor with the starter doc.
cpSync(shellSrc, join(site, `${app.dir}/index.html`))

// The agent guide, at the URL the guides themselves advertise:
// `bento.page/<app>/agents.md`. Stamped with this shell's version so the guide
// declares which feature set it matches (an agent can compare it against a
// document written by a newer shell).
//
// Slides ALSO publishes to the site root — see the ownsSiteContent block below.
// `/agents.md` is referenced by the README and by the harness SKILL.md, which
// people upload to claude.ai as a zip, so it is effectively frozen; this is the
// same compat shape as skills/bento-deck. Both copies come from one source.
if (app.agents && existsSync(join(root, app.agents))) {
  writeFileSync(
    join(site, `${app.dir}/agents.md`),
    readFileSync(join(root, app.agents), 'utf8').replace(/__APP_VERSION__/g, version),
  )
}

// CONFORMANCE GATE — old updaters are frozen code; every release must
// satisfy the splice contract they rely on. The gate itself lives in
// scripts/shell-gate.mjs (shared with CI, which runs it on every PR build).
gateShell(join(site, `releases/${app.dir}/${app.shell}`))

const key = opt('key', null)

/**
 * Release notes for the manifest, lifted from this version's CHANGELOG entry.
 *
 * The About dialog renders `release.notes` INLINE when an update is found, so
 * this is what people read while deciding whether to rewrite their file. It
 * used to be empty, which left a bare version number and a link off to GitHub
 * — a context switch, mid-decision, to a developer-facing page, and useless to
 * a deck opened offline from disk.
 *
 * Because it rides in the signed envelope, the notes are as tamper-proof as
 * the shell itself.
 *
 * Kept SHORT on purpose: every shipped file fetches this manifest at launch,
 * so the whole changelog section would be a needless payload. Bold lead-ins
 * only — the headline of each entry — with the full text a link away.
 */
/**
 * Where THIS app's release notes come from.
 *
 * The root CHANGELOG.md is slides' — it says so in its own first line — and its
 * versions are 1.0.x, so a second app releasing 0.1.0 matched nothing and
 * shipped a manifest with no notes at all. Worse, once two apps' version
 * numbers overlap, the fallback stops being empty and starts being WRONG: an
 * app would describe another product's changes to its own users, inside a
 * signed envelope that cannot be re-signed for the same version.
 *
 * So: the registry states it, the `<dir>/CHANGELOG.md` convention covers an app
 * that has not, and the root is the last resort. ONE resolver, used by both the
 * signing path and `--print-notes`, so what a release reports and what it reads
 * cannot drift. `scripts/test-release-apps.mjs` asserts every app resolves to
 * its own file, which is what keeps the last resort unreachable.
 */
function changelogPath() {
  if (app.changelog) return app.changelog
  const byConvention = `${app.dir}/CHANGELOG.md`
  return existsSync(join(root, byConvention)) ? byConvention : 'CHANGELOG.md'
}

function changelogSections() {
  // Every released section, newest first: [{ version, heads }]
  const cl = readFileSync(join(root, changelogPath()), 'utf8')
  const out = []
  const re = /^## \[(\d+\.\d+\.\d+)\][^\n]*$/gm
  const marks = [...cl.matchAll(re)]
  marks.forEach((m, i) => {
    const body = cl.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : undefined)
    const heads = [...body.matchAll(/^- \*\*(.+?)\*\*/gms)].map((h) => h[1].replace(/\s+/g, ' ').trim())
    if (heads.length) out.push({ version: m[1], heads })
  })
  return out
}

// A declaration, not a const arrow: `--print-notes` runs before this point in
// the file and relies on hoisting to reach it (a const would be in the TDZ).
function cmpVer(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

/**
 * Release notes for the manifest, in two forms — because shipped files are
 * FROZEN CODE and can only read what they were written to read.
 *
 * `notes` (string) is what every existing file reads: `notes?: string`,
 * rendered with textContent. It cannot be made reader-aware after the fact, so
 * it SPANS the last few releases rather than only this one. Releases land days
 * apart; someone on 1.0.11 who updates to 1.0.13 would otherwise never see
 * what 1.0.12 contained, because the manifest only ever described the newest
 * version. A reader who is merely one version behind sees a little they have
 * seen before — the cheaper of the two errors.
 *
 * `notesFrom` (object, version → lead-ins) is for clients new enough to filter
 * it against their own APP_VERSION and show exactly the versions they skipped.
 * Purely additive: an older file ignores the field entirely.
 */
function releaseNotesString(sections) {
  const SPAN = 3   // this release plus the two before it
  const recent = sections.filter((s) => cmpVer(s.version, version) <= 0).slice(0, SPAN)
  if (!recent.length) return null
  const lines = []
  let total = 0
  const MAX = 6
  for (const sec of recent) {
    for (const h of sec.heads) {
      if (total >= MAX) break
      lines.push(`• ${h}${sec.version === version ? '' : `  (${sec.version})`}`)
      total++
    }
    if (total >= MAX) break
  }
  const all = recent.reduce((n, s) => n + s.heads.length, 0)
  if (all > total) lines.push(`…and ${all - total} more`)
  return lines.join('\n')
}

function releaseNotesByVersion(sections) {
  const SPAN = 6
  const out = {}
  for (const sec of sections.filter((s) => cmpVer(s.version, version) <= 0).slice(0, SPAN)) {
    out[sec.version] = sec.heads.slice(0, 8)
  }
  return Object.keys(out).length ? out : null
}

let sections = []
try { sections = changelogSections() } catch { /* notes are a nicety; never fail a release over them */ }
const notes = sections.length ? releaseNotesString(sections) : null
const notesFrom = sections.length ? releaseNotesByVersion(sections) : null
if (notes) console.log(`  notes   ${notes.split('\n').length} line(s), spanning ${Object.keys(notesFrom ?? {}).slice(0, 3).join(', ')}`)
else console.log('  notes   none — no CHANGELOG entry for this version')
const signArgs = [
  join(root, 'scripts/sign-release.mjs'),
  join(site, `releases/${app.dir}/${app.shell}`),
  '--app', app.appId,
  '--version', version,
  '--url', `https://bento.page/releases/${app.dir}/${app.shell}`,
  '--out', join(site, `releases/${app.dir}/manifest.json`),
]
if (notes) signArgs.push('--notes', notes)
if (notesFrom) signArgs.push('--notes-from', JSON.stringify(notesFrom))
if (key) signArgs.push('--key', key)
execFileSync('node', signArgs, { stdio: 'inherit' })

// Language packs, for the apps that have a signed channel. build-i18n.mjs and
// sign-packs.mjs are slides-hardcoded end to end (docs/i18n-packs.md), so an
// app without a catalog stages none rather than staging UNSIGNED ones —
// publish-site.mjs refuses those outright, and it is right to.
if (app.packs) {
  // Language packs: every non-core language, emitted from its catalog, staged
  // beside the shell and listed in packs.json — a SIGNED index (same envelope,
  // same offline key as the manifest) that pins each pack's sha256. The index is
  // what "Add language…" reads; nothing is trusted without it.
  // Both steps are no-ops until a pack catalog exists (docs/i18n-packs.md).
  const packsOut = join(site, 'releases/slides/packs')
  // Seeding restored the PREVIOUS release's packs, and this build is about to
  // write its own beside them — leaving two files claiming the same language,
  // which sign-packs refuses outright ("two packs claim \"ar\""). Their whole
  // job is to be superseded, so clear this app's older ones first. Nothing
  // else in the seeded tree is touched: the point of seeding is to preserve
  // what THIS release does not build, and a stale pack of our own is not that.
  if (existsSync(packsOut)) {
    let dropped = 0
    for (const f of readdirSync(packsOut)) {
      const m = /^bento-slides-(\d+\.\d+\.\d+)-.+\.pack\.json$/.exec(f)
      if (m && m[1] !== version) { rmSync(join(packsOut, f)); dropped++ }
    }
    if (dropped) console.log(`• cleared ${dropped} superseded language pack(s) from the seeded tree`)
  }
  execFileSync('node', [join(root, 'scripts/build-i18n.mjs'), '--packs', packsOut], { stdio: 'inherit' })
  const packArgs = [
    join(root, 'scripts/sign-packs.mjs'), packsOut,
    '--out', join(site, 'releases/slides/packs.json'),
    '--version', version,
  ]
  if (key) packArgs.push('--key', key)
  execFileSync('node', packArgs, { stdio: 'inherit' })
} else {
  console.log(`packs: ${app.appId} has no signed pack channel yet — skipped`)
}

writeFileSync(join(site, 'CNAME'), 'bento.page\n')
// The site is fully pre-built static — disable Jekyll so every file is served
// verbatim. Without this, GitHub Pages' Jekyll processes .md files that carry
// YAML front matter (e.g. skills/*/SKILL.md) into .html, 404-ing the .md URL.
writeFileSync(join(site, '.nojekyll'), '')

// ---- the bento.page site itself -------------------------------------------
// Landing, gallery, agent guide, skills, /help, /q, 404 and the guestbook are
// all SLIDES-derived today — the gallery decks and the 404 deck literally
// embed the slides shell. A spaces release must not regenerate them from a
// shell it did not build, so it leaves the seeded copies in place untouched.
// When spaces gets its own landing slot, it gets its own entry here.
if (app.ownsSiteContent) {
  // The real landing page — assembled from site-src/landing.html with the
  // deck's embedded typefaces injected (scripts/build-landing.mjs).
  execFileSync('node', [join(root, 'scripts/build-landing.mjs'), join(site, 'index.html')], { stdio: 'inherit' })

  // The gallery — four template decks spliced from the same staged shell
  // (each carries template:true; opening one mints a fresh, independent deck).
  execFileSync('node', [join(root, 'scripts/build-example-decks.mjs'), join(site, 'gallery')], { stdio: 'inherit' })

  // The agent guide at the SITE ROOT — the compat URL. The per-app copy at
  // /slides/agents.md is written above, from the same source; this one exists
  // because the README and the harness SKILL.md point at /agents.md, and that
  // SKILL.md ships inside a zip people upload to claude.ai.
  cpSync(join(site, `${app.dir}/agents.md`), join(site, 'agents.md'))
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

  // The guestbook LANDING page is an authored source (site-src/guestbook.html),
  // tracked in this repo, so it ships on every release. It used to be written
  // only inside the `existsSync(guestbook)` branch below, which depends on a
  // GITIGNORED epoch file — so a release built from a clean checkout of the tag
  // (which is what RELEASING.md now tells you to do) produced a site/ with no
  // guestbook/index.html, and publish-site.mjs mirrors with `rsync --delete`.
  // That deleted the live landing page during the v1.0.12 publish. The deck below
  // genuinely needs the epoch; this page never did.
  mkdirSync(join(site, 'guestbook'), { recursive: true })
  cpSync(join(root, 'site-src/guestbook.html'), join(site, 'guestbook/index.html'))

  // The Guestbook DECK (U2) — ships only once an epoch has been minted into
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
    console.log(`guestbook: re-shelled current epoch onto the fresh shell (room ${gbDoc.collab?.room?.split('/').pop() ?? '?'})`)
  } else {
    console.log('guestbook: not armed (working/guestbook-live/ empty) — skipped')
  }
} else {
  console.log(`site content: owned by slides — left as published (${app.appId} release)`)
}

// Which app assembled this tree. publish-site.mjs reads it to name the tag,
// the GitHub release and the shell it attaches — all per app, and all silently
// wrong (or silently skipped) if it guesses slides. See apps.mjs RELEASE_MARKER.
writeFileSync(
  join(site, RELEASE_MARKER),
  JSON.stringify({ app: appKey, appId: app.appId, version, at: new Date().toISOString() }, null, 2) + '\n',
)

console.log(`\nSite assembled for ${app.appId} v${version}:`)
execFileSync('find', [site, '-type', 'f'], { stdio: 'inherit' })
console.log(
  `\nNext (docs/RELEASING.md):\n` +
  `  git push origin ${tagFor(app, version)}      # the GitHub release is created FOR the tag\n` +
  `  node scripts/publish-site.mjs "release ${tagFor(app, version)}"`,
)
