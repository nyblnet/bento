#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// One mark, two platforms. `home-icon.svg` is the SOURCE; this generates the
// Android launcher vectors and the iOS asset catalog from it so the geometry and
// the palette cannot drift.
//
//   node home/assets/make-icons.mjs          # write the generated assets
//   node home/assets/make-icons.mjs --check  # fail if they are out of date (CI)
//
// The iOS APP ICON is still a hand-exported 1024x1024 PNG — see the comment at
// the top of home-icon.svg for the command — because rasterising needs a browser
// and this script has no dependencies on purpose. Everything else iOS needs is
// vector or colour, so it is generated: the mark used by the launch screen and
// the in-app chrome, and the four brand colours as named colour sets.
//
// The colours are read OUT OF THE MARK rather than typed in again. Four hex
// values restated in a Swift file are four values that can disagree with the
// logo, and nothing would notice — the app would simply be slightly the wrong
// navy forever.
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
const IOS_ASSETS = join(here, '../ios/Assets.xcassets')

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

/** Pull the <rect>s out of a source SVG, in document order. */
function readMark(file = 'home-icon.svg') {
  const svg = readFileSync(join(here, file), 'utf8')
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
    throw new Error(`home-icon.svg: expected 5 rects (ground, tray, 3 compartments), found ${rects.length}`)
  }
  const [ground, tray, ...cells] = rects
  if (ground.w !== 32 || ground.h !== 32) {
    throw new Error('home-icon.svg: first rect should be the full-bleed 32x32 ground')
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
  GENERATED from home/assets/home-icon.svg by home/assets/make-icons.mjs.
  Do not edit: run \`node home/assets/make-icons.mjs\` instead.
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
    ...ios({ ground, tray, cells }),
  }
}

/**
 * The iOS asset catalog: the mark as a vector image set, and the brand palette
 * as named colour sets.
 *
 * The mark keeps its navy GROUND, deliberately, so one asset serves both places
 * it is used. On the navy launch screen the frame melts into the background and
 * the cream tray reads as floating; on the search screen's system background it
 * reads as the app icon. A frameless variant would vanish on white and need a
 * second asset to maintain.
 *
 * Named colour sets rather than UIColor literals in Swift: the launch screen is
 * configured from Info.plist and can only name a colour from the catalog, so the
 * catalog has to hold them anyway. Having code read the same names means the
 * launch screen and the chrome cannot end up different shades of navy.
 */
function ios({ ground, tray, cells }) {
  const asset = (obj) => JSON.stringify(obj, null, 2) + '\n'
  const info = { author: 'xcode', version: 1 }

  const note = 'GENERATED from home/assets/home-icon.svg by home/assets/make-icons.mjs.'
  const mark =
    `<!-- ${note} Do not edit. -->\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ground.w * 4}" height="${ground.h * 4}"\n` +
    `     viewBox="0 0 ${ground.w} ${ground.h}" role="img" aria-label="bento home">\n` +
    [ground, tray, ...cells].map((r) =>
      `  <rect${r.x ? ` x="${f(r.x)}"` : ''}${r.y ? ` y="${f(r.y)}"` : ''}` +
      ` width="${f(r.w)}" height="${f(r.h)}"${r.r ? ` rx="${f(r.r)}"` : ''} fill="${r.fill}"/>`
    ).join('\n') +
    '\n</svg>\n'

  // Ground is the navy, tray the cream, and the three compartments give steel,
  // peach and (again) navy. Named for what they are in the mark, so a reader can
  // point at the shape a colour came from.
  const palette = {
    BentoNavy: ground.fill,
    BentoCream: tray.fill,
    BentoSteel: cells[0].fill,
    BentoPeach: cells[1].fill,
  }

  const colorset = (hex) => asset({
    colors: [{
      color: {
        'color-space': 'srgb',
        components: {
          alpha: '1.000',
          red: `0x${hex.slice(1, 3).toUpperCase()}`,
          green: `0x${hex.slice(3, 5).toUpperCase()}`,
          blue: `0x${hex.slice(5, 7).toUpperCase()}`,
        },
      },
      idiom: 'universal',
    }],
    info,
  })

  const out = {
    [join(IOS_ASSETS, 'BentoMark.imageset', 'bento-mark.svg')]: mark,
    [join(IOS_ASSETS, 'BentoMark.imageset', 'Contents.json')]: asset({
      images: [{ filename: 'bento-mark.svg', idiom: 'universal' }],
      info,
      // Vector preserved so the launch screen and any chrome can scale it without
      // shipping a rasterised ladder of @1x/@2x/@3x.
      properties: { 'preserves-vector-representation': true },
    }),
  }
  for (const [name, hex] of Object.entries(palette)) {
    out[join(IOS_ASSETS, `${name}.colorset`, 'Contents.json')] = colorset(hex)
  }
  return out
}

/**
 * The mark as an in-app drawable, from home-logo.svg — the rounded-ground
 * version, unlike the launcher icon which is full-bleed because iOS and Android
 * both apply their own mask.
 *
 * Drawn on its own 32-unit grid rather than the 108 adaptive canvas: this one is
 * an image in a header, not an icon under a mask, so it keeps the source's own
 * proportions and needs none of the safe-zone arithmetic.
 */
function buildMark() {
  const { ground, tray, cells } = readMark('home-logo.svg')
  const shapes = [ground, tray, ...cells].map((r) => ({
    fill: r.fill,
    d: roundRect(r.x, r.y, r.w, r.h, r.r),
  }))
  return `<?xml version="1.0" encoding="utf-8"?>
<!--
  GENERATED from home/assets/home-logo.svg by home/assets/make-icons.mjs.
  Do not edit: run \`node home/assets/make-icons.mjs\` instead.

  The bento/home mark, for use inside the app. Same source as the launcher
  icon, so the two cannot drift apart.
-->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="32dp"
    android:height="32dp"
    android:viewportWidth="32"
    android:viewportHeight="32">
${shapes.map((s) => `    <path\n        android:fillColor="${s.fill}"\n        android:pathData="${s.d}" />`).join('\n')}
</vector>
`
}

const files = build()
files[join(ANDROID_RES, 'ic_home_mark.xml')] = buildMark()
const check = process.argv.includes('--check')
let stale = 0

for (const [path, content] of Object.entries(files)) {
  const current = (() => { try { return readFileSync(path, 'utf8') } catch { return null } })()
  if (current === content) continue
  stale++
  if (check) {
    console.error(`stale: ${path.replace(/.*\/home\//, 'home/')}`)
  } else {
    writeFileSync(path, content)
    console.log(`wrote: ${path.replace(/.*\/home\//, 'home/')}`)
  }
}

if (check && stale) {
  console.error(`\n${stale} generated file(s) are out of date with home-icon.svg —`)
  console.error('the Android launcher vectors and/or the iOS asset catalog.')
  console.error('Run: node home/assets/make-icons.mjs')
  process.exit(1)
}
if (!stale) console.log('mark, launcher vectors and iOS assets all match home-icon.svg')
