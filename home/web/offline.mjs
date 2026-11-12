// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Build-side half of bento/home's offline worker, kill switch and install
// (stage 3), kept apart from build.mjs so the stage-1 build stays readable.
//
// Writes, beside the library page:
//   sw.js                  the worker (src/sw.ts), its precache list and pins
//                          compiled in; the cache name is the content hash of
//                          everything it precaches
//   manifest.webmanifest   the web app manifest (install)
//   icon-192.png, icon-512.png
// and returns the _headers rules for them plus the facts rigs need.
//
// The library's CSP gains exactly three things (libraryPolicyParts): a
// worker-src naming this ONE script URL, a manifest-src naming the ONE manifest
// URL, and a Trusted Types policy name the page uses to pass that one URL to
// register(). Nothing else about the library or the frame changes.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const SW_PATH = '/sw.js'
export const MANIFEST_PATH = '/manifest.webmanifest'
const STATIC = [
  ['manifest.webmanifest', 'manifest.webmanifest'],
  ['icon-192.png', 'icons/icon-192.png'],
  ['icon-512.png', 'icons/icon-512.png'],
]

const hex = (b) => createHash('sha256').update(b).digest('hex')

/** The library CSP directives this stage replaces ('none' before it). */
export const libraryPolicyParts = (libraryOrigin) => ({
  worker: `worker-src ${libraryOrigin}${SW_PATH}`,
  manifest: `manifest-src ${libraryOrigin}${MANIFEST_PATH}`,
  trustedTypes: 'trusted-types bento-sw',
})

/** The worker's own policy: no script but itself, and fetches only to its own origin. */
export const SW_POLICY = "default-src 'none'; connect-src 'self'"

/**
 * Write the offline files into `libDir` (which already holds index.html).
 * `bundle(entry, defines)` is build.mjs's esbuild step; `libJs` is the
 * library's one script, whose sha256 is the build id the kill switch names.
 */
export function writeOffline({ here, libDir, libJs, bundle, common }) {
  for (const [to, from] of STATIC) fs.copyFileSync(path.join(here, from), path.join(libDir, to))
  const precache = [['/', 'index.html'], ...STATIC.map(([to]) => [`/${to}`, to])]
    .map(([p, f]) => ({ path: p, sha256: hex(fs.readFileSync(path.join(libDir, f))) }))
  const cache = `bento-home-${hex(precache.map((p) => `${p.path} ${p.sha256}\n`).join(''))}`
  const swJs = bundle('sw.ts', { __CACHE__: cache, __PRECACHE__: precache })
  fs.writeFileSync(path.join(libDir, 'sw.js'), swJs + '\n')
  const rules = [
    [SW_PATH, { 'Content-Security-Policy': SW_POLICY, ...common }],
    ...STATIC.map(([to]) => [`/${to}`, { ...common }]),
  ]
  return {
    rules,
    info: { build: hex(libJs), cache, precache, swBytes: Buffer.byteLength(swJs) },
  }
}
