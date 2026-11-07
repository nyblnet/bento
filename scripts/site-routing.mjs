// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Host routing files for bento.page on Cloudflare Workers static assets.
//
// The site is a plain tree of files, and GitHub Pages serves it with a few
// conveniences every published URL now depends on: `/x.html` AND `/x` both
// answer 200, `/d/` serves `d/index.html`, and `/d` redirects to `/d/`.
// Workers static assets offers those only bundled with a canonicalisation we
// cannot have: its default `html_handling` answers `/x.html` with a redirect
// to `/x`, and that would move the signed shell URL inside every shipped
// manifest (`/releases/slides/Bento_Slides.bento.html`). So the site runs with
// `html_handling = "none"` (only exact file paths match) and this module
// generates the `_redirects` that put the other forms back, one rule per HTML
// file in the tree being published. Generated, never hand-written: a gallery
// deck added later would otherwise 404 at its extensionless URL.
//
// The static files that go with it (`_headers`, `wrangler.toml`,
// `.assetsignore`) live in site-src/host/ and are copied as they are.
// publish-site.mjs calls stageHostFiles() on the tree it is about to mirror.
// GitHub Pages serves all four as inert text until the move; Workers reads
// them and serves none of them.

import { copyFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Files this module writes into the site root. */
export const HOST_FILES = ['_headers', '_redirects', 'wrangler.toml', '.assetsignore']

function walk(dir, base = dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full, base))
    else out.push(full.slice(base.length + 1).split('\\').join('/'))
  }
  return out
}

/**
 * `_redirects` for `html_handling = "none"`, from the tree's relative paths.
 *   index.html        →  `/ /index.html 200`
 *   d/index.html      →  `/d/ /d/index.html 200` and `/d /d/ 301`
 *   x.html            →  `/x /x.html 200`   (the extensionless form)
 * A 200 rule is a rewrite: the asset at the target is served at the source
 * URL. `/x.html` itself needs no rule, it is an exact file match.
 */
export function workersRedirects(files) {
  const html = files.filter((f) => f.endsWith('.html') && !HOST_FILES.includes(f)).sort()
  const lines = []
  for (const f of html) {
    if (f === 'index.html') lines.push('/ /index.html 200')
    else if (f.endsWith('/index.html')) {
      const d = '/' + f.slice(0, -'index.html'.length)
      lines.push(`${d} /${f} 200`, `${d.slice(0, -1)} ${d} 301`)
    } else lines.push(`/${f.slice(0, -'.html'.length)} /${f} 200`)
  }
  // Workers allows 2,000 static rules; fail loudly long before a silent cut-off.
  if (lines.length > 1900) throw new Error(`_redirects would have ${lines.length} rules; Workers allows 2,000`)
  return lines.join('\n') + '\n'
}

/** Write the host files into `site` (the tree publish-site.mjs mirrors). */
export function stageHostFiles(site, root) {
  for (const f of ['_headers', 'wrangler.toml', '.assetsignore']) {
    copyFileSync(join(root, 'site-src/host', f), join(site, f))
  }
  writeFileSync(join(site, '_redirects'), workersRedirects(walk(site)))
}
