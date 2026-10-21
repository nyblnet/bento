#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/home on iOS: the app-switcher snapshot of a sealed document shows none
 * of it (home/ios/SnapshotCover.swift).
 *
 *   node scripts/test-home-snapshot-cover.mjs
 *
 * iOS writes the app-switcher snapshot to disk, under the app's
 * Library/SplashBoard, as KTX images. This builds the app for the simulator,
 * opens a document, sends the app to the background, and reads back the
 * snapshots iOS itself wrote. ImageIO reads KTX. The document is one solid red
 * page, so the question per snapshot is how much of it is that red.
 *   - sealed (its body is a bento/enc envelope): no red in any snapshot
 *   - plain (the control): red in the snapshot, so the measurement can see
 *     content when it's there
 *   - back in the foreground, the sealed document shows again: the cover comes off
 * The sealed file is red on screen too, so "no red" can only come from the cover.
 * With the cover disabled, this measured 93% red.
 *
 * Needs Xcode and an iOS simulator; skips elsewhere. Takes a few minutes.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = 'page.bento.home'
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'pipe', maxBuffer: 1 << 26, ...opts }).toString()
try { run('xcrun', ['simctl', 'help']) } catch { console.log('home snapshot cover: SKIPPED — needs Xcode with iOS simulators.'); process.exit(0) }

const work = mkdtempSync(join(tmpdir(), 'bento-snapcover-'))
const sleep = (s) => run('sleep', [String(s)])
let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }

// an iPhone simulator: the first available one, booted
const devices = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'available', '-j'])).devices
const phone = Object.entries(devices).filter(([rt]) => rt.includes('iOS')).flatMap(([, ds]) => ds).find((d) => d.name.startsWith('iPhone'))
if (!phone) { console.error('no available iPhone simulator'); process.exit(2) }
const DEV = phone.udid
console.log(`simulator: ${phone.name} (${DEV})`)
if (phone.state !== 'Booted') { try { run('xcrun', ['simctl', 'boot', DEV]) } catch {} }
run('xcrun', ['simctl', 'bootstatus', DEV, '-b'], { timeout: 600000 })

// build and install (Debug: the rig's launch hooks exist only there)
const dd = join(work, 'dd')
const ios = join(ROOT, 'home/ios')
try { run('xcodegen', [], { cwd: ios }) } catch (e) { console.error('xcodegen failed (is it installed?): ' + (e.stderr?.toString() || e.message)); process.exit(2) }
try {
  run('xcodebuild', ['-project', 'BentoTray.xcodeproj', '-scheme', 'BentoTray', '-configuration', 'Debug',
    '-destination', `platform=iOS Simulator,id=${DEV}`, '-derivedDataPath', dd, 'CODE_SIGN_IDENTITY=-', 'build'],
  { cwd: ios, timeout: 1200000 })
} catch (e) { console.error('build failed:\n' + (e.stdout?.toString().split('\n').filter((l) => /error:/.test(l)).join('\n') || e.message)); process.exit(2) }
const prod = join(dd, 'Build/Products', readdirSync(join(dd, 'Build/Products')).find((d) => d.endsWith('-iphonesimulator')))
run('xcrun', ['simctl', 'install', DEV, join(prod, 'BentoTray.app')])
const DATA = run('xcrun', ['simctl', 'get_app_container', DEV, BUNDLE, 'data']).trim()
mkdirSync(join(DATA, 'Documents'), { recursive: true })

// the measuring tool: fraction of a picture that is the document's red
const tool = join(work, 'red')
writeFileSync(join(work, 'red.swift'), String.raw`
import Foundation
import ImageIO
import CoreGraphics
for p in CommandLine.arguments.dropFirst() {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: p) as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { print("-1"); continue }
  let w = img.width, h = img.height
  var px = [UInt8](repeating: 0, count: w * h * 4)
  let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
  var red = 0
  for i in stride(from: 0, to: px.count, by: 4) where px[i] > 200 && px[i+1] < 70 && px[i+2] < 70 { red += 1 }
  print(Double(red) / Double(w * h))
}
`)
run('swiftc', ['-O', '-o', tool, join(work, 'red.swift')])
const redOf = (files) => files.length ? run(tool, files).trim().split('\n').map(Number) : []

function doc(name, format) {
  const p = join(DATA, 'Documents', `${name}.bento.html`)
  writeFileSync(p, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Rig ${name}</title>
<script type="application/json" id="bento-doc">{"format":"${format}","docId":"rig-${name}"}</script></head>
<body style="margin:0;background:#ff0000;min-height:100vh"></body></html>`)
  return p
}

/** the scene snapshots iOS wrote after `since` (full size; the launch-image group is a different thing) */
function sceneSnapshots(since) {
  const out = []
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) { if (e.name !== 'downscaled') walk(p) } else if (p.endsWith('.ktx') && p.includes('sceneID:') && statSync(p).mtimeMs > since) out.push(p)
  } }
  const root = join(DATA, 'Library/SplashBoard')
  if (existsSync(root)) walk(root)
  return out
}

/** Wait (up to a minute) until the document is on screen: a cold simulator can
 *  take far longer than a warm one, and backgrounding before it shows would make
 *  a clean snapshot mean nothing. Returns how much of the screen is its red. */
function untilOnScreen(tag) {
  let red = 0
  for (let i = 0; i < 30 && red <= 0.5; i++) {
    sleep(2)
    const shot = join(work, `fg-${tag}-${i}.png`)
    run('xcrun', ['simctl', 'io', DEV, 'screenshot', shot])
    red = redOf([shot])[0]
  }
  return red
}

/** Wait (up to 30 s) until iOS has written its snapshots and they've stopped
 *  changing: a cold runner can take a while, and a half-written file would be
 *  read as something it isn't. */
function untilSnapshotsWritten(since) {
  let last = ''
  for (let i = 0; i < 15; i++) {
    sleep(2)
    const files = sceneSnapshots(since)
    const sig = files.map((f) => `${f}:${statSync(f).size}`).sort().join('|')
    if (files.length && sig === last) return files
    last = sig
  }
  return sceneSnapshots(since)
}

/** Open, wait for the document to show, send the app to the background, and
 *  read the snapshots iOS writes. If iOS wrote none, the whole cycle runs once
 *  more before anything is judged: no snapshot proves nothing either way. */
function background(path) {
  for (let attempt = 1; ; attempt++) {
    try { run('xcrun', ['simctl', 'terminate', DEV, BUNDLE]) } catch {}
    rmSync(join(DATA, 'Library/SplashBoard'), { recursive: true, force: true })
    const since = Date.now()
    run('xcrun', ['simctl', 'launch', DEV, BUNDLE], { env: { ...process.env, SIMCTL_CHILD_BENTO_RIG_OPEN: path } })
    const onScreen = untilOnScreen(since)
    run('xcrun', ['simctl', 'launch', DEV, 'com.apple.Preferences'])
    const files = untilSnapshotsWritten(since)
    if (files.length || attempt === 2) return { onScreen, snapshots: redOf(files), attempt }
    console.log('  (iOS wrote no snapshot yet: once more)')
  }
}

try {
  const sealedPath = doc('sealed', 'bento/enc'), plainPath = doc('plain', 'bento/slides')
  console.log('a sealed document:')
  const s = background(sealedPath)
  ok(s.onScreen > 0.5, `it is on screen while open (${(s.onScreen * 100).toFixed(0)}% red), so a clean snapshot can only come from the cover`)
  ok(s.snapshots.length > 0, `iOS wrote app-switcher snapshots (${s.snapshots.length}${s.attempt > 1 ? ', on the second try' : ''})`)
  ok(s.snapshots.length > 0 && s.snapshots.every((r) => r === 0), `none of them shows the document (${s.snapshots.map((r) => (r * 100).toFixed(1) + '%').join(', ')} red)`)
  console.log('the control, an unsealed document:')
  const p = background(plainPath)
  ok(p.onScreen > 0.5, `it is on screen while open (${(p.onScreen * 100).toFixed(0)}% red)`)
  ok(p.snapshots.some((r) => r > 0.5), `its snapshot shows it (${p.snapshots.map((r) => (r * 100).toFixed(1) + '%').join(', ')} red), so the measurement sees content when it is there`)
  console.log('back in the foreground:')
  run('xcrun', ['simctl', 'terminate', DEV, BUNDLE])
  run('xcrun', ['simctl', 'launch', DEV, BUNDLE], { env: { ...process.env, SIMCTL_CHILD_BENTO_RIG_OPEN: sealedPath } })
  untilOnScreen('again')
  run('xcrun', ['simctl', 'launch', DEV, 'com.apple.Preferences']); sleep(3)
  run('xcrun', ['simctl', 'launch', DEV, BUNDLE])
  const b = untilOnScreen('back')
  ok(b > 0.5, `the sealed document shows again once the app is active (${(b * 100).toFixed(0)}% red): the cover comes off`)
} finally {
  try { run('xcrun', ['simctl', 'terminate', DEV, BUNDLE]) } catch {}
  rmSync(work, { recursive: true, force: true })
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
