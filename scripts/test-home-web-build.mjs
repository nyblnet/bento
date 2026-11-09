#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/home in your browser: what a PRODUCTION build may carry, and how a
 * release builds it.
 *
 *   PLAYWRIGHT_MODULE=… CHROME_PATH=… node scripts/test-home-web-build.mjs
 *
 * 1. home/web/build.mjs without --dev refuses every development seam: no
 *    --history (the frozen fixture fallback), --key (a test key),
 *    BENTO_HOME_WEB_MUTANT, and a history the library would refuse (wrong key,
 *    tampered, a second one for the same app). Each refusal differs from the
 *    positive control (the good release build, which succeeds) by that one
 *    input, and writes nothing. With --dev the seams still work.
 * 2. scripts/release.mjs --home-web refuses, before building or signing
 *    anything: without --frame-origin, with home/web output inside the site,
 *    and with a signing key that is not the release key unless --home-web-dev.
 *    The history choice (every published app, refusing one without a history)
 *    is checked on staged trees.
 * 3. A rehearsal release (throwaway key, the slides shell already built) with
 *    --home-web --home-web-dev: the home/web build bundles the history the
 *    release just signed, and nothing of it lands in the site.
 *
 * Needs esbuild (npm ci --prefix slides), a built slides shell, and Playwright
 * and Chromium for the rehearsal's pins gate (derive-pins.mjs).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { generateKeyPairSync, webcrypto } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { APPS } from './apps.mjs'
import { homeWebOptions, publishedHistories } from './home-web-release.mjs'
import { releasePublicKey } from './sign-payload.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }
const section = (m) => console.log(`\n=== ${m}`)

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-home-web-build-'))
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }))

// --- fixtures ------------------------------------------------------------------
const REAL_HISTORY = path.join(ROOT, 'home/fixtures/gate1/real/slides-1.2.10/history.json')
const realHistory = JSON.parse(fs.readFileSync(REAL_HISTORY, 'utf8'))
const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const { kty, crv, x, y } = await webcrypto.subtle.exportKey('jwk', kp.publicKey)
const W = (name, text) => { const f = path.join(work, name); fs.writeFileSync(f, text); return f }
const TEST_KEY = W('test-key.json', JSON.stringify({ kty, crv, x, y }))
const sig = async (payload) => Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(payload))).toString('base64')
const TEST_HISTORY = W('history-test-key.json', JSON.stringify({ payload: realHistory.payload, sig: await sig(realHistory.payload) }))
const tamperedPayload = realHistory.payload.replace(/"version":"(\d+)\.(\d+)\.(\d+)"/, (m, a, b, c) => `"version":"${a}.${b}.${Number(c) + 1}"`)
if (tamperedPayload === realHistory.payload) throw new Error('could not tamper the fixture history')
const TAMPERED_HISTORY = W('history-tampered.json', JSON.stringify({ payload: tamperedPayload, sig: realHistory.sig }))

// --- 1. home/web/build.mjs ----------------------------------------------------------
const FRAME = 'https://frame.example.net'
let n = 0
function build(extra, env = {}) {
  const out = path.join(work, `build-${++n}`)
  const r = spawnSync(process.execPath, [path.join(ROOT, 'home/web/build.mjs'), '--out', out, '--frame-origin', FRAME, ...extra],
    { encoding: 'utf8', env: { ...process.env, BENTO_HOME_WEB_MUTANT: '', ...env } })
  const info = fs.existsSync(path.join(out, 'build.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'build.json'), 'utf8')) : null
  const library = fs.existsSync(path.join(out, 'library/index.html')) ? fs.readFileSync(path.join(out, 'library/index.html'), 'utf8') : ''
  return { status: r.status, err: r.stderr, out, wrote: fs.existsSync(out), info, library }
}
const refusal = (r, pattern, msg) => ok(r.status !== 0 && !r.wrote && pattern.test(r.err), `${msg} (exit ${r.status}, wrote ${r.wrote ? 'SOMETHING' : 'nothing'}: ${r.err.trim().split('\n').pop()?.slice(0, 140)})`)

section('home/web/build.mjs: a production build')
const good = build(['--history', REAL_HISTORY])
ok(good.status === 0 && good.info?.dev === false && good.info?.testKey === false && good.info?.mutant === null,
  `positive control: the release build (published history, release key, no --dev) succeeds (exit ${good.status}) and records dev:false, testKey:false`)
ok(good.info?.histories?.length === 1 && good.library.includes(realHistory.sig),
  'positive control: the library page carries exactly the history it was given')
refusal(build([]), /--history/, 'no --history: refused, not warned (no frozen-fixture fallback without --dev)')
refusal(build(['--history', REAL_HISTORY, '--key', TEST_KEY]), /--key/, '--key (a test key): refused without --dev')
refusal(build(['--history', TEST_HISTORY, '--key', TEST_KEY]), /--key/, '--key with a history that key signed: still refused without --dev')
refusal(build(['--history', REAL_HISTORY], { BENTO_HOME_WEB_MUTANT: JSON.stringify({ file: 'verify.ts', from: 'x', to: 'y' }) }), /MUTANT/,
  'BENTO_HOME_WEB_MUTANT set: refused without --dev')
refusal(build(['--history', TEST_HISTORY]), /would refuse this history/, 'a history signed by another key than the release key: refused')
refusal(build(['--history', TAMPERED_HISTORY]), /would refuse this history/, 'a history whose payload was changed after signing: refused')
refusal(build(['--history', REAL_HISTORY, '--history', REAL_HISTORY]), /one per app/, 'two histories for the same app: refused')
refusal(build(['--history']), /--history needs a file/, '--history without a file: refused')

section('home/web/build.mjs: a development build (--dev)')
{
  const r = build(['--dev'])
  ok(r.status === 0 && r.info?.dev === true && r.info.histories?.[0] === path.relative(ROOT, REAL_HISTORY) && /development only/.test(r.err),
    `--dev without --history bundles the frozen fixture, with a warning (exit ${r.status})`)
  const k = build(['--dev', '--key', TEST_KEY, '--history', TEST_HISTORY])
  ok(k.status === 0 && k.info?.dev === true && k.info?.testKey === true, `--dev --key with a history that key signed builds, marked testKey (exit ${k.status})`)
  refusal(build(['--dev', '--key', TEST_KEY, '--history', REAL_HISTORY]), /would refuse this history/,
    '--dev --key still refuses a history that key cannot verify')
}

// --- 2. release.mjs: the options, and which histories ----------------------------------
section('release.mjs --home-web: refusals before anything is built or signed')
const keyFile = (name, pub) => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return W(name, JSON.stringify({ kind: 'bento-release-key-THROWAWAY', private: privateKey.export({ format: 'jwk' }), public: pub ?? publicKey.export({ format: 'jwk' }) }))
}
const THROWAWAY = keyFile('throwaway-key.json')
const LOOKS_LIKE_RELEASE = keyFile('release-public-only.json', releasePublicKey()) // the release key's PUBLIC half; never used to sign
function release(extra, outName) {
  const site = path.join(work, outName)
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/release.mjs'), '--app', 'slides', '--no-build', '--out', site, '--allow-missing-published', ...extra],
    { encoding: 'utf8', env: { ...process.env, BENTO_SITE_DIR: path.join(work, 'no-such-published-tree') } })
  return { ...r, site, touched: fs.existsSync(site) }
}
for (const [extra, pattern, msg] of [
  [['--key', THROWAWAY, '--home-web'], /--frame-origin/, '--home-web without --frame-origin'],
  [['--key', THROWAWAY, '--home-web', '--frame-origin', '--home-web-dev'], /--frame-origin/, '--home-web whose --frame-origin is followed by another flag'],
  [['--key', THROWAWAY, '--frame-origin', FRAME], /only mean something with --home-web/, '--frame-origin without --home-web'],
  [['--key', THROWAWAY, '--home-web', '--home-web-dev', '--frame-origin', FRAME, '--home-web-out', 'INSIDE'], /inside the site/, 'home/web output inside the site (which is mirrored to bento.page)'],
  [['--key', THROWAWAY, '--home-web', '--frame-origin', FRAME], /not the release key/, 'a signing key that is not the release key, without --home-web-dev'],
]) {
  const site = `site-${++n}`
  const args = extra.map((a) => (a === 'INSIDE' ? path.join(work, site, 'home-web') : a))
  const r = release(args, site)
  ok(r.status !== 0 && !r.touched && pattern.test(r.stderr), `${msg}: refused before the site is touched (exit ${r.status}: ${r.stderr.trim().split('\n').pop()?.slice(0, 120)})`)
}
{
  const opt = (args) => (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : d }
  const call = (args, keyPath) => homeWebOptions({ args, opt: opt(args), site: path.join(work, 'site'), keyPath, releaseKey: releasePublicKey })
  ok(call(['--app', 'slides']) === null, 'without --home-web, no home/web build (the release is unchanged)')
  const prod = call(['--home-web', '--frame-origin', FRAME], LOOKS_LIKE_RELEASE)
  ok(prod && prod.dev === false && prod.devKey === null && prod.out === path.join(work, 'site.home-web'),
    'positive control: the release key with --home-web gives a production build outside the site (<site>.home-web)')
  const noKey = call(['--home-web', '--frame-origin', FRAME], null)
  ok(noKey && noKey.dev === false && noKey.devKey === null, 'no --key (the default release key, never read here): a production build')
  const reh = call(['--home-web', '--home-web-dev', '--frame-origin', FRAME], THROWAWAY)
  ok(reh && reh.dev === true && reh.devKey?.x === JSON.parse(fs.readFileSync(THROWAWAY, 'utf8')).public.x && !('d' in reh.devKey),
    'a rehearsal key with --home-web-dev: a development build carrying only the PUBLIC half')
}

section('which histories: every published app')
{
  const stage = (name, files) => {
    const site = path.join(work, name)
    for (const f of files) { fs.mkdirSync(path.dirname(path.join(site, f)), { recursive: true }); fs.writeFileSync(path.join(site, f), '{}') }
    return site
  }
  const one = stage('pub-a', ['releases/slides/manifest.json', 'releases/slides/history.json', 'releases/tray/manifest.json'])
  const h = publishedHistories(one, APPS)
  ok(h.length === 1 && h[0].appId === 'bento-slides', 'slides published with its history, nothing else of ours published: the slides history only')
  const two = stage('pub-b', ['releases/slides/manifest.json', 'releases/slides/history.json', 'releases/spaces/manifest.json', 'releases/spaces/history.json', 'releases/dash/history.json'])
  ok(publishedHistories(two, APPS).map((x) => x.appId).join() === 'bento-slides,bento-spaces', 'slides and spaces published: both; a history without a manifest is not a published app')
  const thrown = (site) => { try { publishedHistories(site, APPS); return '' } catch (e) { return e.message } }
  ok(/bento-spaces is published .* no releases\/spaces\/history\.json/.test(thrown(stage('pub-c', ['releases/slides/manifest.json', 'releases/slides/history.json', 'releases/spaces/manifest.json']))),
    'a published app without a history: refused, never skipped')
  ok(/publishes no app/.test(thrown(stage('pub-d', ['releases/tray/manifest.json']))), 'a site publishing none of our apps: refused')
}

// --- 3. a rehearsal release with --home-web ------------------------------------------
section('release.mjs --home-web --home-web-dev: a rehearsal (throwaway key)')
if (process.env.BENTO_HWB_NO_REHEARSAL) console.log('  note  rehearsal not run: this is a mutant copy (test-home-web-build-mutants.mjs); the plain rig runs it')
else {
  const shell = path.join(ROOT, `slides/dist-single/${APPS.slides.shell}`)
  if (!fs.existsSync(shell)) { console.error(`no built slides shell at ${shell}: cd slides && npm run build:single`); process.exit(1) }
  const hw = path.join(work, 'rehearsal.home-web')
  const r = release(['--key', THROWAWAY, '--home-web', '--home-web-dev', '--frame-origin', FRAME, '--home-web-out', hw], 'rehearsal')
  if (r.status !== 0) console.log(r.stdout.split('\n').slice(-15).join('\n') + '\n' + r.stderr)
  ok(r.status === 0, `the rehearsal release with --home-web succeeds (exit ${r.status})`)
  const info = fs.existsSync(path.join(hw, 'build.json')) ? JSON.parse(fs.readFileSync(path.join(hw, 'build.json'), 'utf8')) : {}
  const signed = path.join(r.site, 'releases/slides/history.json')
  ok(info.frameOrigin === FRAME && info.dev === true && info.testKey === true, 'home/web was built for the given frame origin, marked as a development, test-key build')
  ok(JSON.stringify(info.histories) === JSON.stringify([path.relative(ROOT, signed)]), `it bundled the history this release signed, and only that (${info.histories})`)
  const library = fs.existsSync(path.join(hw, 'library/index.html')) ? fs.readFileSync(path.join(hw, 'library/index.html'), 'utf8') : ''
  ok(fs.existsSync(signed) && library.includes(JSON.parse(fs.readFileSync(signed, 'utf8')).sig), 'the library page carries that signed history byte for byte')
  const siteFiles = fs.existsSync(r.site) ? execFileSync('find', [r.site, '-type', 'f'], { encoding: 'utf8' }).trim().split('\n').map((f) => path.relative(r.site, f)) : []
  ok(siteFiles.length > 10 && !siteFiles.some((f) => /(^|\/)(frame\.html|_headers|build\.json)$/.test(f) || f.includes('home-web') || f.startsWith('library/')),
    `nothing of home/web is in the site (${siteFiles.length} files): nothing deploys it`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
