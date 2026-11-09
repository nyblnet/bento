#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The Stage 0 device probes stay out of what ships, and need only what they say.
 *
 *   node scripts/test-home-stage0-probes.mjs
 *
 * - The sign-session probe (home/ios/Stage0SignProbe.swift) is DEBUG-only: built
 *   for a device, the Debug app carries its marker string and the Release app
 *   carries no trace of it (marker, class name, menu title). Positive control:
 *   the same Release build with the DEBUG condition forced on DOES carry it, so
 *   "absent" means excluded, not optimised away or searched for wrongly.
 * - The passkey origin probe (home/ios/Stage0/) is its own project: no file of
 *   it reaches the app in either configuration.
 * - The generated BentoTray.xcodeproj is never copied into the app (it was, on
 *   any second xcodegen run, team id and all).
 * - Entitlements as Xcode generates them: the app has none beyond its
 *   application identifier (so a free personal team can sign it for a device),
 *   and the passkey probe has exactly webcredentials:<rp id>, expanded.
 *
 * - The sign-session probe RUNS: on a simulator it opens with a test account,
 *   its first Sign goes through the real host to the session and answers reauth,
 *   and the app going to the background shows in its log.
 *
 * Needs Xcode, xcodegen and an iOS simulator runtime; skips without Xcode.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IOS = join(ROOT, 'home/ios')
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'pipe', maxBuffer: 1 << 26, ...opts }).toString()
try { run('xcodebuild', ['-version']); run('xcodegen', ['--version']) } catch { console.log('home stage0 probes: SKIPPED — needs Xcode and xcodegen.'); process.exit(0) }

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }
const work = mkdtempSync(join(tmpdir(), 'bento-stage0-'))
// A Release build checks the bundled release histories against a site clone. This rig is about
// compiled code, not histories: an empty site (no published apps) lets the build through.
mkdirSync(join(work, 'site/releases'), { recursive: true })

const C1 = 'bento-stage0-probe-c1', Q3 = 'bento-stage0-probe-q3'
const C1_TRACES = [C1, 'Stage0SignProbe', 'Stage 0: sign session', 'BENTO_RIG_STAGE0']

function build(project, scheme, config, dest, extra = []) {
  const dd = join(work, `dd-${scheme}-${config}-${dest.includes('Simulator') ? 'sim' : 'dev'}${extra.length ? '-x' : ''}`)
  try {
    run('xcodebuild', ['-project', project, '-scheme', scheme, '-configuration', config, '-destination', dest,
      '-derivedDataPath', dd, ...extra, 'build'],
    { cwd: dirname(project), timeout: 1800000, env: { ...process.env, BENTO_SITE_DIR: join(work, 'site') } })
  } catch (e) {
    console.error(`build ${scheme} ${config} failed:\n` + (e.stdout?.toString().split('\n').filter((l) => /error:/.test(l)).join('\n') || e.message))
    rmSync(work, { recursive: true, force: true })
    process.exit(2)
  }
  return dd
}
const appIn = (dd, name) => {
  const p = join(dd, 'Build/Products')
  const d = readdirSync(p).find((x) => existsSync(join(p, x, `${name}.app`)))
  return join(p, d, `${name}.app`)
}
/** every file of an app bundle, as bytes: a Debug build puts its code in BentoTray.debug.dylib */
function bundleText(app) {
  const out = []
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : out.push(readFileSync(p).toString('latin1')) } }
  walk(app)
  return out.join('\n')
}
function xcent(dd, name) {
  const found = []
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f === `${name}.app-Simulated.xcent`) found.push(p) } }
  walk(join(dd, 'Build/Intermediates.noindex'))
  if (found.length !== 1) return null
  return JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', found[0]]))
}

// --- source shape: the cheap half, which says WHY the builds below come out as they do
const probeSrc = readFileSync(join(IOS, 'Stage0SignProbe.swift'), 'utf8')
const code = probeSrc.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'))
ok(code[0]?.trim() === '#if DEBUG' && code[code.length - 1]?.trim() === '#endif' && (probeSrc.match(/#endif/g) || []).length === 1,
  'sign-session probe: the whole file is inside one #if DEBUG')
const browser = readFileSync(join(IOS, 'DocumentBrowserViewController.swift'), 'utf8')
const entry = browser.indexOf('Stage0SignProbeViewController()')
ok(entry > 0 && browser.lastIndexOf('#if DEBUG', entry) > browser.lastIndexOf('#endif', entry), 'its only entry, the browser menu item, is inside #if DEBUG')
const editor = readFileSync(join(IOS, 'EditorViewController.swift'), 'utf8')
ok(/askReauth: \{ done in Self\.promptReauth\(done\) \}/.test(editor) && /EditorViewController\.promptReauth \{/.test(probeSrc) &&
  /session: EditorViewController\.identitySession/.test(probeSrc), "the probe raises the editor's own reauth prompt and signs against the app's one session")
const spec = readFileSync(join(IOS, 'project.yml'), 'utf8')
ok(/excludes: \[[^\]]*"Stage0\/\*\*"/.test(spec), 'the app project excludes Stage0/ (the passkey probe is its own project)')
ok(!/CODE_SIGN_ENTITLEMENTS|entitlements:/.test(spec), 'the app project names no entitlements file')

// twice: a second run once picked up the first one's BentoTray.xcodeproj as a resource
run('xcodegen', ['-q'], { cwd: IOS })
run('xcodegen', ['-q'], { cwd: IOS })
run('xcodegen', ['-q'], { cwd: join(IOS, 'Stage0') })
const APP = join(IOS, 'BentoTray.xcodeproj'), P7 = join(IOS, 'Stage0/Stage0Probes.xcodeproj')
const DEVICE = 'generic/platform=iOS', SIM = 'generic/platform=iOS Simulator'
const unsigned = ['CODE_SIGNING_ALLOWED=NO']

// --- the device builds: what an iPhone would get
console.log('building the app for a device: Debug, Release, and Release with DEBUG forced on')
const dbg = bundleText(appIn(build(APP, 'BentoTray', 'Debug', DEVICE, unsigned), 'BentoTray'))
const relApp = appIn(build(APP, 'BentoTray', 'Release', DEVICE, unsigned), 'BentoTray')
const rel = bundleText(relApp)
const relDebug = bundleText(appIn(build(APP, 'BentoTray', 'Release', DEVICE, [...unsigned, 'SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG']), 'BentoTray'))

ok(dbg.includes(C1), `Debug app carries the sign-session probe (${C1})`)
for (const t of C1_TRACES) ok(!rel.includes(t), `Release app has no "${t}"`)
ok(C1_TRACES.every((t) => relDebug.includes(t)), 'control: the Release build with DEBUG forced on carries all of them, so their absence above is the #if, not the optimiser')
ok(dbg.includes('BENTO_RIG_OPEN') && !rel.includes('BENTO_RIG_OPEN'), 'the existing DEBUG rig hooks: in Debug, not in Release (same check, older code)')
ok(!readdirSync(relApp).some((f) => f.endsWith('.xcodeproj')), 'the generated project is not copied into the app (xcodegen run twice)')
ok(!dbg.includes(Q3) && !rel.includes(Q3) && !rel.includes('PasskeyProbeViewController'), 'no passkey-probe code in the app, either configuration')

// --- entitlements as Xcode generates them (a simulator build writes them out; a device build needs a team)
console.log('building for the simulator to read the generated entitlements')
const simDD = build(APP, 'BentoTray', 'Debug', SIM, ['CODE_SIGN_IDENTITY=-'])
const appEnt = xcent(simDD, 'BentoTray')
ok(appEnt && Object.keys(appEnt).join() === 'application-identifier' && /\.page\.bento\.home$/.test(appEnt['application-identifier']),
  `the app's entitlements are only its application identifier (a free personal team can sign it): ${JSON.stringify(appEnt)}`)
const p7dd = build(P7, 'PasskeyOriginProbe', 'Debug', SIM, ['CODE_SIGN_IDENTITY=-'])
const p7Ent = xcent(p7dd, 'PasskeyOriginProbe')
ok(p7Ent && JSON.stringify(p7Ent['com.apple.developer.associated-domains']) === '["webcredentials:id.bento.page"]' &&
  Object.keys(p7Ent).sort().join() === 'application-identifier,com.apple.developer.associated-domains' &&
  /\.page\.bento\.home$/.test(p7Ent['application-identifier']),
  `the passkey probe asks for exactly webcredentials:id.bento.page, as page.bento.home: ${JSON.stringify(p7Ent)}`)
const p7Info = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', join(appIn(p7dd, 'PasskeyOriginProbe'), 'Info.plist')]))
ok(p7Info.BentoProbeRPID === 'id.bento.page', `the passkey probe's rp id, expanded into the app: ${p7Info.BentoProbeRPID}`)
ok(bundleText(appIn(p7dd, 'PasskeyOriginProbe')).includes(Q3), `control: the passkey probe carries its own marker (${Q3})`)

// --- the sign-session probe runs: open it on a simulator, one Sign, then background the app
console.log('running the sign-session probe on a simulator')
const devices = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'available', '-j'])).devices
let phone = Object.entries(devices).filter(([rt]) => rt.includes('iOS')).flatMap(([, ds]) => ds).find((d) => d.name.startsWith('iPhone'))
let made = null
if (!phone) {
  // none to borrow: make one, and delete exactly that one at the end
  const types = JSON.parse(run('xcrun', ['simctl', 'list', 'devicetypes', '-j'])).devicetypes.filter((t) => t.name.startsWith('iPhone'))
  const rts = JSON.parse(run('xcrun', ['simctl', 'list', 'runtimes', 'available', '-j'])).runtimes.filter((r) => r.platform === 'iOS')
  if (!types.length || !rts.length) { console.error('no iPhone simulator, and none can be made'); process.exit(2) }
  made = run('xcrun', ['simctl', 'create', 'bento-stage0-rig', types[types.length - 1].identifier, rts[rts.length - 1].identifier]).trim()
  phone = { udid: made, name: 'bento-stage0-rig', state: 'Shutdown' }
}
const DEV = phone.udid
try {
  if (phone.state !== 'Booted') { try { run('xcrun', ['simctl', 'boot', DEV]) } catch {} }
  run('xcrun', ['simctl', 'bootstatus', DEV, '-b'], { timeout: 600000 })
  run('xcrun', ['simctl', 'install', DEV, appIn(simDD, 'BentoTray')])
  const logPath = join(work, 'stage0.log')
  const readLog = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '')
  const waitFor = (re, secs) => { for (let i = 0; i < secs * 2; i++) { if (re.test(readLog())) return true; run('sleep', ['0.5']) } return false }
  try { run('xcrun', ['simctl', 'terminate', DEV, 'page.bento.home']) } catch {}
  run('xcrun', ['simctl', 'launch', DEV, 'page.bento.home'], { env: { ...process.env, SIMCTL_CHILD_BENTO_RIG_STAGE0: logPath } })
  waitFor(/answer: /, 120)
  const first = readLog()
  ok(first.includes(C1) && /test account: present/.test(first), 'probe: opens with a test account present')
  ok(/Sign #1[\s\S]*answer: reauth/.test(first) && /re-authentication prompt raised/.test(first),
    'probe: the first Sign reaches the session through the real host and answers reauth, raising the prompt')
  run('xcrun', ['simctl', 'launch', DEV, 'com.apple.Preferences'])
  ok(waitFor(/event: scene entered background at [^;]+; session ended/, 60), 'probe: backgrounding the app is logged, with the session ended')
  console.log(readLog().replace(/^/gm, '      | '))
  try { run('xcrun', ['simctl', 'terminate', DEV, 'page.bento.home']) } catch {}
} finally {
  if (made) { try { run('xcrun', ['simctl', 'shutdown', made]) } catch {} ; try { run('xcrun', ['simctl', 'delete', made]) } catch {} }
}

rmSync(work, { recursive: true, force: true })
console.log(`\nhome stage0 probes: ${checks - failures}/${checks} passed`)
process.exit(failures ? 1 : 0)
