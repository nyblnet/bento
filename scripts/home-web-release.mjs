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

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from 'node:path'

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

/** Is `p` outside `dir`? A child named `..hw` is inside: only `..` itself, `..<sep>…` or another root is out. */
export function outside(dir, p) {
  const rel = relative(resolve(dir), resolve(p))
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)
}

/** A path as the file system resolves it: symlinks followed, and on a case-insensitive disk the stored case. The parent must exist. */
export const real = (p) => (existsSync(p) ? realpathSync.native(p) : join(realpathSync.native(dirname(p)), basename(p)))

/**
 * Make the home/web output safe to build into, before anything else is
 * written or signed. The site and the output's parent are created first, so
 * the two are compared as the file system resolves them (a symlink, or a case
 * variant on a case-insensitive disk, cannot hide one inside the other).
 * Refused: an output inside the site, an output that contains the site, and an
 * output holding anything but an earlier home/web build (a build.json). An
 * earlier build is removed, so a run that fails later never leaves one behind.
 */
export function prepareHomeWebOut({ site, out }) {
  mkdirSync(site, { recursive: true })
  mkdirSync(dirname(out), { recursive: true })
  const s = real(site), o = real(out)
  if (!outside(s, o)) throw new Error(`--home-web-out ${out} is inside the site (${s}), and the site is mirrored to bento.page: put it anywhere else`)
  if (!outside(o, s)) throw new Error(`--home-web-out ${out} contains the site (${s}): it is emptied before every build, so it must be a folder of its own`)
  if (!existsSync(o)) return
  if (!statSync(o).isDirectory()) throw new Error(`--home-web-out ${out} is not a folder`)
  const held = readdirSync(o)
  if (held.length && !held.includes('build.json')) {
    throw new Error(`--home-web-out ${out} holds something other than an earlier home/web build (no build.json): it would be emptied, so pick an empty or new folder`)
  }
  rmSync(o, { recursive: true, force: true })
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
