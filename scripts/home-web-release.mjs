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

import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve, isAbsolute } from 'node:path'

/**
 * Read release.mjs's home/web options. Returns null when --home-web is absent.
 * Throws (with the message to print) on every refusal, so release.mjs can stop
 * BEFORE it builds or signs anything.
 *
 *   --home-web               build home/web from this release's histories
 *   --frame-origin <url>     REQUIRED with --home-web; there is no default,
 *                            because the frame domain is the maintainer's to
 *                            choose and does not exist yet
 *   --home-web-out <dir>     default <site>.home-web; never inside the site,
 *                            which is mirrored to bento.page
 *   --home-web-dev           a development build (rehearsals with a throwaway
 *                            key); without it, a signing key other than the
 *                            release key is refused
 *
 * `keyPath` is release.mjs's --key (null = the default key, which is never
 * read here). `releaseKey()` returns the public key every shipped shell
 * verifies; it is called only when a --key is given.
 */
export function homeWebOptions({ args, opt, site, keyPath, releaseKey }) {
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
  const out = resolve(outArg ?? `${site}.home-web`)
  const rel = relative(resolve(site), out)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(`--home-web-out ${out} is inside the site, and the site is mirrored to bento.page: put it anywhere else`)
  }
  let devKey = null
  if (keyPath) {
    const pub = JSON.parse(readFileSync(keyPath, 'utf8')).public
    const rk = releaseKey()
    const same = !!pub && ['kty', 'crv', 'x', 'y'].every((k) => pub[k] === rk[k])
    if (!same && !dev) {
      throw new Error('--key is not the release key, so the histories it signs would not verify in a production home/web build. A rehearsal passes --home-web-dev')
    }
    if (!same) devKey = { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }
  }
  return { frameOrigin, out, dev, devKey }
}

/**
 * The history of every app the staged site PUBLISHES: an app is published when
 * its signed manifest is in the site. A published app without a history is
 * refused, never skipped: the library would then run none of its files.
 */
export function publishedHistories(site, apps) {
  const out = []
  for (const app of Object.values(apps)) {
    const dir = join(site, `releases/${app.dir}`)
    if (!existsSync(join(dir, 'manifest.json'))) continue
    const history = join(dir, 'history.json')
    if (!existsSync(history)) throw new Error(`${app.appId} is published (releases/${app.dir}/manifest.json) but has no releases/${app.dir}/history.json`)
    out.push({ appId: app.appId, file: history })
  }
  if (!out.length) throw new Error('the site publishes no app, so there is no history to build home/web with')
  return out
}

/** The home/web/build.mjs arguments for a release. */
export function homeWebBuildArgs({ root, opts, histories, devKeyFile }) {
  const a = [join(root, 'home/web/build.mjs'), '--out', opts.out, '--frame-origin', opts.frameOrigin]
  for (const h of histories) a.push('--history', h.file)
  if (opts.dev) a.push('--dev')
  if (devKeyFile) a.push('--key', devKeyFile)
  return a
}
