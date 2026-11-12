// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// What a release hands to the bento/home web build (home/web/build.mjs), as a
// module of its own so scripts/test-home-web-build.mjs can check the choices
// without cutting a release.
//
// release.mjs builds home/web only when asked (--home-web). Nothing deploys
// it: the frame site does not exist yet, and deploying is the maintainer's.
// Without --home-web a release does exactly what it did before.

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Read release.mjs's home/web options. Returns null when --home-web is absent.
 * Throws (with the message to print) on a refusal. Reads and writes nothing.
 *
 *   --home-web               build home/web from this release's histories
 *   --frame-origin <url>     REQUIRED with --home-web; there is no default,
 *                            because the frame domain is the maintainer's to
 *                            choose and does not exist yet
 *   --home-web-out <dir>     default <site>.home-web; never inside the site,
 *                            which is mirrored to bento.page, and never a
 *                            folder that contains the site (prepareHomeWebOut)
 *   --home-web-dev           a development build (rehearsals with a throwaway
 *                            key); without it, a signing key other than the
 *                            release key is refused (homeWebKey)
 */
export function homeWebOptions({ args, opt, site }) {
  const asked = args.includes('--home-web')
  const frameOrigin = opt('frame-origin', null)
  const dev = args.includes('--home-web-dev')
  const outArg = opt('home-web-out', null)
  if (!asked) {
    if (frameOrigin || dev || outArg) throw new Error('--frame-origin, --home-web-dev and --home-web-out only mean something with --home-web')
    return null
  }
  if (!frameOrigin || frameOrigin.startsWith('--')) {
    throw new Error('--home-web needs --frame-origin <url>: the frame site is a separate domain, and it is the maintainer\'s to choose (there is no default)')
  }
  if (outArg !== null && outArg.startsWith('--')) throw new Error('--home-web-out needs a folder')
  return { frameOrigin, out: resolve(outArg ?? `${site}.home-web`), dev, devKey: null }
}

/** A folder's identity on disk: device and inode, whatever path text reaches it. */
const id = (p) => { const st = statSync(p); return `${st.dev}:${st.ino}` }

/**
 * Is `p` the folder `dir` or anywhere under it? Decided by identity, not path
 * text: from `p` (or its nearest existing ancestor) up to the root, each
 * folder's device and inode is compared with `dir`'s. So no spelling reaches
 * into `dir` unseen: not a symlink, a case variant on a case-insensitive disk,
 * a macOS firmlink (/System/Volumes/Data/…), nor a child named `..hw`. A
 * symlink to nothing on the way is refused outright (throws): where it points
 * may only be created later. False when `dir` does not exist.
 */
export function within(p, dir) {
  if (!existsSync(dir)) return false
  const target = id(dir)
  let cur = resolve(p)
  while (!existsSync(cur)) {
    // missing to existsSync but found by lstat: a symlink to nothing, which a
    // later step could create anywhere (inside the site, say), so refuse it
    try { lstatSync(cur) } catch { cur = dirname(cur); continue }
    throw new Error(`${p} runs through a symlink to nothing (${cur}): it could later reach anywhere, so it is refused`)
  }
  for (;;) {
    if (id(cur) === target) return true
    const here = realpathSync.native(cur)
    const up = dirname(here)
    if (up === here) return false
    cur = up
  }
}

/** Does `dir` hold an earlier home/web build? Its build.json must parse and carry the build's own keys. */
export function holdsEarlierBuild(dir) {
  try {
    const j = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8'))
    return !!j && typeof j === 'object' && ['frameOrigin', 'libraryOrigin', 'dev', 'testKey', 'histories'].every((k) => k in j)
  } catch { return false }
}

/**
 * Make the home/web output safe to build into, before anything else is
 * written or signed. Nothing is created but the site folder itself (so the
 * site can be compared; release.mjs recreates it anyway). Refused, with the
 * output left as it was: an output inside the site or containing it, an output
 * inside the PUBLISHED tree the next release seeds from (or containing it),
 * and an output holding anything but an earlier home/web build. An earlier
 * build is removed, so a run that fails later never leaves one behind.
 */
export function prepareHomeWebOut({ site, out, published = null }) {
  mkdirSync(site, { recursive: true })
  if (within(out, site)) throw new Error(`--home-web-out ${out} is inside the site (${site}), and the site is mirrored to bento.page: put it anywhere else`)
  if (within(site, out)) throw new Error(`--home-web-out ${out} contains the site (${site}): it is emptied before every build, so it must be a folder of its own`)
  if (published && within(out, published)) throw new Error(`--home-web-out ${out} is inside the published tree (${published}), which the next release copies into the site: put it anywhere else`)
  if (published && within(published, out)) throw new Error(`--home-web-out ${out} contains the published tree (${published}): it is emptied before every build, so it must be a folder of its own`)
  if (!existsSync(out)) return
  if (!statSync(out).isDirectory()) throw new Error(`--home-web-out ${out} is not a folder`)
  if (readdirSync(out).length && !holdsEarlierBuild(out)) {
    throw new Error(`--home-web-out ${out} holds something other than an earlier home/web build (no build.json of one): it would be emptied, so pick an empty or new folder`)
  }
  rmSync(out, { recursive: true, force: true })
}

/**
 * The key check. `keyPath` is release.mjs's --key (null = the default key,
 * which is never read here). `releaseKey()` returns the public key every
 * shipped shell verifies; it is called only when a --key is given. Returns the
 * public half to build with when it is not the release key (development only).
 */
export function homeWebKey({ keyPath, releaseKey, dev }) {
  if (!keyPath) return null
  const pub = JSON.parse(readFileSync(keyPath, 'utf8')).public
  const rk = releaseKey()
  const same = !!pub && ['kty', 'crv', 'x', 'y'].every((k) => pub[k] === rk[k])
  if (!same && !dev) {
    throw new Error('--key is not the release key, so the histories it signs would not verify in a production home/web build. A rehearsal passes --home-web-dev')
  }
  return same ? null : { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }
}

/**
 * The history of every app the staged site PUBLISHES: an app is published when
 * its signed manifest is in the site. A published app without a history is
 * refused, never skipped: the library would then run none of its files.
 *
 * `pending` (an app key) is the app being released: before it is signed its
 * history may not exist yet (its first release), so it is taken when present
 * and never refused; and an empty list is then allowed. release.mjs calls it
 * so on the SEEDED tree before signing, and plainly once the release is signed.
 */
export function publishedHistories(site, apps, pending = null) {
  const out = []
  for (const app of Object.values(apps)) {
    const dir = join(site, `releases/${app.dir}`)
    if (!existsSync(join(dir, 'manifest.json'))) continue
    const history = join(dir, 'history.json')
    if (!existsSync(history) && pending && apps[pending] === app) continue
    if (!existsSync(history)) throw new Error(`${app.appId} is published (releases/${app.dir}/manifest.json) but has no releases/${app.dir}/history.json`)
    out.push({ appId: app.appId, file: history })
  }
  if (!out.length && !pending) throw new Error('the site publishes no app, so there is no history to build home/web with')
  return out
}

/** The home/web/build.mjs arguments for a release (`check`: run its checks only, write nothing). */
export function homeWebBuildArgs({ root, opts, histories, devKeyFile, check = false }) {
  const a = [join(root, 'home/web/build.mjs'), '--out', opts.out, '--frame-origin', opts.frameOrigin]
  if (check) a.push('--check')
  for (const h of histories) a.push('--history', h.file)
  if (opts.dev) a.push('--dev')
  if (devKeyFile) a.push('--key', devKeyFile)
  return a
}
