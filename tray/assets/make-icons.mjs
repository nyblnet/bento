#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// One mark, two platforms. `tray-icon.svg` is the SOURCE; this generates the
// Android launcher vectors from it so the geometry cannot drift.
//
//   node tray/assets/make-icons.mjs          # write the Android drawables
//   node tray/assets/make-icons.mjs --check  # fail if they are out of date (CI)
//
// iOS consumes the same SVG directly, as a 1024x1024 PNG export — see the
// comment at the top of tray-icon.svg for the export command. It is not
// generated here because it needs a browser to rasterise, and this script has no
// dependencies on purpose.
//
// WHY GENERATE AT ALL: Android vector drawables have no <rect>, so every rounded
// rectangle in the mark has to be re-expressed as path data. Written by hand
// that is four opaque `M…A…V…Z` strings that nobody will ever diff against the
// SVG — so a change to the mark would land on iOS and silently miss Android.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ANDROID_RES = join(here, '../android/app/src/main/res/drawable')

// The adaptive-icon canvas is 108 units with a 72-unit safe zone. The cream tray
// is drawn at 56, NOT 72: at 72 it exactly filled the visible area, so every
// launcher mask cut its corners off and the navy frame — the thing that makes
// the mark read as Bento — was never drawn at all. 56 leaves the frame visible
// under a circle mask, which is the tightest one in use.
const CANVAS = 108
const TRAY = 56

const f = (n) => +n.toFixed(2)
const roundRect = (x, y, w, h, r) =>
  `M${f(x + r)},${f(y)} H${f(x + w - r)} A${f(r)},${f(r)} 0 0 1 ${f(x + w)},${f(y + r)} ` +
  `V${f(y + h - r)} A${f(r)},${f(r)} 0 0 1 ${f(x + w - r)},${f(y + h)} ` +
  `H${f(x + r)} A${f(r)},${f(r)} 0 0 1 ${f(x)},${f(y + h - r)} ` +
  `V${f(y + r)} A${f(r)},${f(r)} 0 0 1 ${f(x + r)},${f(y)} Z`

/** Pull the <rect>s out of the source SVG, in document order. */
function readMark() {
  const svg = readFileSync(join(here, 'tray-icon.svg'), 'utf8')
  const rects = [...svg.matchAll(/<rect\b([^>]*)\/>/g)].map((m) => {
    const attr = (name) => {
      const hit = m[1].match(new RegExp(`\\b${name}="([^"]*)"`))
      return hit ? hit[1] : null
    }
    return {
      x: parseFloat(attr('x') ?? '0'), y: parseFloat(attr('y') ?? '0'),
      w: parseFloat(attr('width')), h: parseFloat(attr('height')),
      r: parseFloat(attr('rx') ?? '0'), fill: attr('fill'),
    }
  })
  // Expected shape: a full-bleed navy ground, the cream tray, then three
  // compartments. Asserted rather than assumed — if the mark is redrawn with a
  // different structure this must be revisited, not silently mis-generated.
  if (rects.length !== 5) {
    throw new Error(`tray-icon.svg: expected 5 rects (ground, tray, 3 compartments), found ${rects.length}`)
  }
  const [ground, tray, ...cells] = rects
  if (ground.w !== 32 || ground.h !== 32) {
    throw new Error('tray-icon.svg: first rect should be the full-bleed 32x32 ground')
  }
  return { ground, tray, cells }
}

function build() {
  const { ground, tray, cells } = readMark()
  // Map the SVG's 32-unit grid so the tray spans TRAY units, centred.
  const origin = (CANVAS - TRAY) / 2
  const scale = TRAY / tray.w
  const map = (v, start) => origin + (v - start) * scale

  const shapes = [
    { fill: tray.fill, d: roundRect(origin, origin, TRAY, TRAY, tray.r * scale) },
    ...cells.map((c) => ({
      fill: c.fill,
      d: roundRect(map(c.x, tray.x), map(c.y, tray.y), c.w * scale, c.h * scale, c.r * scale),
    })),
  ]

  const header = (extra) => `<?xml version="1.0" encoding="utf-8"?>
<!--
  GENERATED from tray/assets/tray-icon.svg by tray/assets/make-icons.mjs.
  Do not edit: run \`node tray/assets/make-icons.mjs\` instead.
${extra}-->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${CANVAS}dp"
    android:height="${CANVAS}dp"
    android:viewportWidth="${CANVAS}"
    android:viewportHeight="${CANVAS}">`

  const foreground = header(
`
  The navy frame is the BACKGROUND layer (@color/tray_navy) and the cream tray is
  the foreground. That split is what an adaptive icon wants: the system
  parallaxes the two against each other, and a frame drawn into the foreground
  would slide away from its own edge.
`) + '\n' +
    shapes.map((s) => `    <path\n        android:fillColor="${s.fill}"\n        android:pathData="${s.d}" />`).join('\n') +
    '\n</vector>\n'

  // Themed icons are tinted to one colour by the system, so geometry has to
  // carry the mark alone: the compartments become HOLES in the tray via evenOdd.
  const monochrome = header(
`
  The themed-icon layer (Android 13+). Colour cannot carry the mark when the
  system tints it, so the compartments are knocked out of the tray with evenOdd
  fill — the same rhythm as the full-colour icon, legible as a silhouette.
`) + `
    <path
        android:fillColor="#FFFFFF"
        android:fillType="evenOdd"
        android:pathData="${shapes.map((s) => s.d).join(' ')}" />
</vector>
`

  return {
    [join(ANDROID_RES, 'ic_launcher_foreground.xml')]: foreground,
    [join(ANDROID_RES, 'ic_launcher_monochrome.xml')]: monochrome,
  }
}

const files = build()
const check = process.argv.includes('--check')
let stale = 0

for (const [path, content] of Object.entries(files)) {
  const current = (() => { try { return readFileSync(path, 'utf8') } catch { return null } })()
  if (current === content) continue
  stale++
  if (check) {
    console.error(`stale: ${path.replace(/.*\/tray\//, 'tray/')}`)
  } else {
    writeFileSync(path, content)
    console.log(`wrote: ${path.replace(/.*\/tray\//, 'tray/')}`)
  }
}

if (check && stale) {
  console.error('\nAndroid launcher drawables are out of date with tray-icon.svg.')
  console.error('Run: node tray/assets/make-icons.mjs')
  process.exit(1)
}
if (!stale) console.log('icons up to date')
