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
 *    tampered, a second one for the same app), and a --directory-keys file.
 *    The bento/id agent (--identity) builds in production ONLY with the
 *    kernel's pinned directory keys (kernel/src/directory-keys.ts) and only
 *    for https://home.bento.page: without pinned keys it is refused, and every
 *    seam above is still refused with --identity added. The positive
 *    production identity build runs in a scratch copy of the tree that carries
 *    a test kernel/src/directory-keys.ts (the real one waits on the
 *    directory's keys being minted). Each refusal differs from the
 *    positive control (the good release build, which succeeds) by that one
 *    input, and writes nothing. With --dev the seams still work.
 * 2. scripts/release.mjs --home-web refuses before building anything: without
 *    --frame-origin, with home/web output inside the site (a child named
 *    `..hw` included), with a signing key that is not the release key unless
 *    --home-web-dev, with BENTO_HOME_WEB_MUTANT set, and without esbuild. Once
 *    the site is seeded, and still before anything is signed, it refuses a
 *    published app with no history and a published history the build would
 *    refuse. Each such run signs nothing and leaves no earlier home/web build
 *    in the output. The history choice is also checked on staged trees.
 * 3. A rehearsal release (throwaway key, the slides shell already built, a
 *    seeded published spaces history) with --home-web --home-web-dev: the
 *    home/web build bundles the history the release just signed and the seeded
 *    one, the stale build planted in its output is gone, and nothing of it
 *    lands in the site.
 *
 * Needs esbuild (npm ci --prefix slides), a built slides shell, and Playwright
 * and Chromium for the rehearsal's pins gate (derive-pins.mjs).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, createPrivateKey, generateKeyPairSync, sign as nodeSign, webcrypto } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { APPS } from './apps.mjs'
import { homeWebBuildArgs, homeWebKey, homeWebOptions, publishedHistories } from './home-web-release.mjs'
import { releasePublicKey, verifyEnvelope } from './sign-payload.mjs'

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
// the bento/id agent: a well-formed keys file, so the refusal is the production rule, not the file
const DIR_KEYS = W('directory-keys.json', JSON.stringify({ 'dir-1': Buffer.from(await webcrypto.subtle.exportKey('raw', kp.publicKey)).toString('base64url') }))
refusal(build(['--history', REAL_HISTORY, '--identity', '--directory-keys', DIR_KEYS]), /--directory-keys[^\n]*refused in a production build/,
  '--identity with --directory-keys (a key file, not the kernel\'s pinned keys): refused without --dev')
refusal(build(['--history', REAL_HISTORY, '--directory-keys', DIR_KEYS]), /--directory-keys[^\n]*refused in a production build/,
  '--directory-keys alone: refused without --dev')
// absent field: this tree's kernel pins no directory keys yet (kernel/src/directory-keys.ts does not exist)
const kernelPins = fs.existsSync(path.join(ROOT, 'kernel/src/directory-keys.ts'))
if (!kernelPins) {
  refusal(build(['--history', REAL_HISTORY, '--identity']), /--identity: no pinned directory keys/,
    '--identity with no pinned directory keys in the kernel: refused "no pinned directory keys"')
} else console.log('  note  kernel/src/directory-keys.ts exists in this tree: the scratch-copy rows below cover its absence')
// every development seam, with --identity added: still refused, nothing written
refusal(build(['--identity']), /--history/, '--identity, no --history: refused')
refusal(build(['--history', REAL_HISTORY, '--identity', '--key', TEST_KEY]), /--key/, '--identity, --key (a test key): refused without --dev')
refusal(build(['--history', REAL_HISTORY, '--identity'], { BENTO_HOME_WEB_MUTANT: JSON.stringify({ file: 'verify.ts', from: 'x', to: 'y' }) }), /MUTANT/,
  '--identity, BENTO_HOME_WEB_MUTANT set: refused without --dev')

section('home/web/build.mjs: a production IDENTITY build, in a scratch copy whose kernel pins directory keys')
{
  // The tree build.mjs reads, copied, plus a kernel/src/directory-keys.ts of TEST keys
  // (two kids, as the real one will carry dir-1 and dir-2). Only the copy has it.
  const copy = path.join(work, 'pinned-tree')
  for (const d of ['home/web', 'home/webext/src', 'kernel/src', 'scripts/lib']) {
    fs.cpSync(path.join(ROOT, d), path.join(copy, d), { recursive: true, filter: (s) => !s.includes('node_modules') && !/[/\\](dist|\.mutant-src-|\.identity-node-)/.test(s.slice(path.join(ROOT, d).length)) })
  }
  const pub = async () => Buffer.from(await webcrypto.subtle.exportKey('raw', (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])).publicKey)).toString('base64url')
  const PINS = { 'dir-1': await pub(), 'dir-2': await pub() }
  const pinsFile = path.join(copy, 'kernel/src/directory-keys.ts')
  const writePins = (text) => fs.writeFileSync(pinsFile, text)
  writePins(`// TEST keys for test-home-web-build.mjs's scratch copy only\nexport const DIRECTORY_KEYS: Readonly<Record<string, string>> = Object.freeze(${JSON.stringify(PINS)})\n`)
  const ESB = process.env.ESBUILD || path.join(ROOT, 'slides/node_modules/.bin/esbuild')
  const pbuild = (extra, env = {}) => {
    const out = path.join(work, `pbuild-${++n}`)
    const r = spawnSync(process.execPath, [path.join(copy, 'home/web/build.mjs'), '--out', out, '--frame-origin', FRAME, ...extra],
      { encoding: 'utf8', env: { ...process.env, BENTO_HOME_WEB_MUTANT: '', ESBUILD: ESB, ...env } })
    const info = fs.existsSync(path.join(out, 'build.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'build.json'), 'utf8')) : null
    const read = (f) => fs.existsSync(path.join(out, f)) ? fs.readFileSync(path.join(out, f), 'utf8') : ''
    return { status: r.status, err: r.stderr, out, wrote: fs.existsSync(out), info, library: read('library/index.html'), headers: read('library/_headers') }
  }
  const p = pbuild(['--history', REAL_HISTORY, '--identity'])
  ok(p.status === 0 && p.info?.dev === false && p.info?.testKey === false && p.info?.identity === true,
    `production --identity with the kernel's pinned keys builds: dev:false, testKey:false, identity:true (exit ${p.status}${p.status ? ': ' + p.err.trim().split('\n').pop() : ''})`)
  ok(p.info?.directoryKeySource === 'kernel/src/directory-keys.ts' && JSON.stringify(p.info?.directoryKids) === JSON.stringify(Object.keys(PINS)),
    `build.json records the kernel's module as the key source and its kids (${p.info?.directoryKeySource}: ${p.info?.directoryKids})`)
  ok(p.library.includes(JSON.stringify(PINS)) && Object.values(PINS).every((k) => p.library.split(k).length === 2),
    "the library carries the kernel's pinned keys, byte for byte, each once")
  ok(/connect-src https:\/\/bento\.page\/releases\/ https:\/\/id\.bento\.page;/.test(p.info?.libraryPolicy ?? '') && p.headers.includes('connect-src https://bento.page/releases/ https://id.bento.page;'),
    'connect-src is exactly the release channel and the directory, in the meta policy and the header')
  ok(/frame-ancestors 'none'/.test(p.headers) && /Cross-Origin-Opener-Policy: same-origin-allow-popups/.test(p.headers) && /require-trusted-types-for 'script'; trusted-types bento-sw/.test(p.headers),
    "frame-ancestors 'none', COOP same-origin-allow-popups, Trusted Types required with the one policy")
  ok(p.library.includes('https://signin.id.bento.page') && !p.library.includes('BENTO_HOME_WEB_MUTANT'), 'the agent opens the sign-in host at its one origin')
  // bento/id's hosting rules for bento/home, offline over this build (scripts/check-home-web-hosting.mjs),
  // and each rule red on a copy of the build that breaks it
  {
    const hosting = (dir) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/check-home-web-hosting.mjs'), dir], { encoding: 'utf8' })
    const h = hosting(p.out)
    ok(h.status === 0 && /over 6 paths/.test(h.stdout), `check-home-web-hosting passes over the production identity build (exit ${h.status}: ${h.stdout.trim().split('\n').pop()})`)
    for (const [rule, edit] of [
      ['home-coop', (d) => { const f = path.join(d, 'library/_headers'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll('same-origin-allow-popups', 'same-origin')) }],
      ['home-framing', (d) => { const f = path.join(d, 'library/_headers'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll("; frame-ancestors 'none'", '')) }],
      ['home-no-webauthn', (d) => { fs.mkdirSync(path.join(d, 'library/.well-known'), { recursive: true }); fs.writeFileSync(path.join(d, 'library/.well-known/webauthn'), '{}') }],
    ]) {
      const d = path.join(work, `hosting-${rule}`)
      fs.cpSync(p.out, d, { recursive: true })
      edit(d)
      const r = hosting(d)
      ok(r.status === 1 && r.stdout.includes(`FAIL  ${rule}:`), `check-home-web-hosting: a build that breaks ${rule} fails on it (exit ${r.status})`)
    }
  }
  refusal(pbuild(['--history', REAL_HISTORY, '--identity', '--library-origin', 'https://other.example']), /production identity build is for the library at https:\/\/home\.bento\.page only/,
    'production --identity for another library origin: refused')
  refusal(pbuild(['--history', REAL_HISTORY, '--identity', '--directory-keys', DIR_KEYS]), /--directory-keys[^\n]*refused in a production build/,
    'production --identity with --directory-keys, even where the kernel pins keys: refused')
  refusal(pbuild(['--history', REAL_HISTORY, '--identity', '--key', TEST_KEY]), /--key/, 'production --identity with --key, where the kernel pins keys: refused')
  refusal(pbuild(['--identity']), /--history/, 'production --identity without --history, where the kernel pins keys: refused')
  refusal(pbuild(['--history', REAL_HISTORY, '--identity'], { BENTO_HOME_WEB_MUTANT: JSON.stringify({ file: 'verify.ts', from: 'x', to: 'y' }) }), /MUTANT/,
    'production --identity with BENTO_HOME_WEB_MUTANT, where the kernel pins keys: refused')
  // absent fields: a module that exports nothing, an empty set, no module
  writePins('export const SOMETHING_ELSE = 1\n')
  refusal(pbuild(['--history', REAL_HISTORY, '--identity']), /no pinned directory keys \(kernel\/src\/directory-keys\.ts exports no DIRECTORY_KEYS\)/, 'a kernel module without DIRECTORY_KEYS: refused "no pinned directory keys"')
  writePins('export const DIRECTORY_KEYS = {}\n')
  refusal(pbuild(['--history', REAL_HISTORY, '--identity']), /no pinned directory keys \(kernel\/src\/directory-keys\.ts pins no key\)/, 'a kernel module pinning no key: refused "no pinned directory keys"')
  writePins('export const DIRECTORY_KEYS = { "dir-1": "not-a-point" }\n')
  refusal(pbuild(['--history', REAL_HISTORY, '--identity']), /DIRECTORY_KEYS is not/, 'a kernel module pinning a malformed key: refused')
  fs.rmSync(pinsFile)
  refusal(pbuild(['--history', REAL_HISTORY, '--identity']), /no pinned directory keys \(kernel\/src\/directory-keys\.ts does not exist yet\)/, 'no kernel module: refused "no pinned directory keys"')
  const d = pbuild(['--dev', '--history', REAL_HISTORY, '--identity', '--directory-keys', DIR_KEYS])
  ok(d.status === 0 && d.info?.identity === true && d.info?.directoryKeySource === 'file', `positive control: --dev --identity --directory-keys still builds, marked as a file's keys (exit ${d.status})`)
}

section('home/web/build.mjs: a development build (--dev)')
{
  const r = build(['--dev'])
  ok(r.status === 0 && r.info?.dev === true && r.info.histories?.[0] === path.relative(ROOT, REAL_HISTORY) && /development only/.test(r.err),
    `--dev without --history bundles the frozen fixture, with a warning (exit ${r.status})`)
  const k = build(['--dev', '--key', TEST_KEY, '--history', TEST_HISTORY])
  ok(k.status === 0 && k.info?.dev === true && k.info?.testKey === true, `--dev --key with a history that key signed builds, marked testKey (exit ${k.status})`)
  refusal(build(['--dev', '--key', TEST_KEY, '--history', REAL_HISTORY]), /would refuse this history/,
    '--dev --key still refuses a history that key cannot verify')
  const id = build(['--dev', '--identity', '--directory-keys', DIR_KEYS])
  ok(id.status === 0 && id.info?.dev === true && id.info?.identity === true && /connect-src \S+ https:\/\/id\.bento\.page;/.test(id.info?.libraryPolicy ?? ''),
    `--dev --identity builds the bento/id agent, and only its policy reaches the directory (exit ${id.status})`)
  ok(good.info?.identity === false && !/id\.bento\.page/.test(good.info?.libraryPolicy ?? 'x'), 'positive control: the release build has no identity and no directory in its policy')
}

// --- 2. release.mjs: the options, and which histories ----------------------------------
section('release.mjs --home-web: refusals before anything is built or signed')
const keyFile = (name, pub) => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return W(name, JSON.stringify({ kind: 'bento-release-key-THROWAWAY', private: privateKey.export({ format: 'jwk' }), public: pub ?? publicKey.export({ format: 'jwk' }) }))
}
const THROWAWAY = keyFile('throwaway-key.json')
const LOOKS_LIKE_RELEASE = keyFile('release-public-only.json', releasePublicKey()) // the release key's PUBLIC half; never used to sign
function release(extra, outName, { published = null, env = {} } = {}) {
  const site = path.join(work, outName)
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/release.mjs'), '--app', 'slides', '--no-build', '--out', site, '--allow-missing-published', ...extra],
    { encoding: 'utf8', env: { ...process.env, BENTO_HOME_WEB_MUTANT: '', BENTO_SITE_DIR: published ?? path.join(work, 'no-such-published-tree'), ...env } })
  return { ...r, site, touched: fs.existsSync(site) }
}
/** What a release signs: if none of these exist, nothing was signed. */
const SIGNED = ['releases/slides/manifest.json', 'releases/slides/history.json', 'releases/slides/packs.json']
const signedIn = (site) => SIGNED.filter((f) => fs.existsSync(path.join(site, f)))
/** A published tree to seed from: `files` maps a path to its text. */
const publishedTree = (name, files) => {
  const dir = path.join(work, name)
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t) }
  return dir
}
const EARLIER_BUILD = { libraryOrigin: 'https://home.bento.page', frameOrigin: FRAME, dev: true, testKey: true, histories: [] }
/** An output holding an earlier development, test-key build. */
const staleOut = (name) => {
  const out = path.join(work, name)
  fs.mkdirSync(path.join(out, 'library'), { recursive: true })
  fs.writeFileSync(path.join(out, 'library/index.html'), 'STALE TEST-KEY BUILD')
  fs.writeFileSync(path.join(out, 'build.json'), JSON.stringify(EARLIER_BUILD))
  return out
}
for (const [extra, pattern, msg] of [
  [['--key', THROWAWAY, '--home-web'], /--frame-origin/, '--home-web without --frame-origin'],
  [['--key', THROWAWAY, '--home-web', '--frame-origin', '--home-web-dev'], /--frame-origin/, '--home-web whose --frame-origin is followed by another flag'],
  [['--key', THROWAWAY, '--frame-origin', FRAME], /only mean something with --home-web/, '--frame-origin without --home-web'],
]) {
  const site = `site-${++n}`
  const r = release(extra, site)
  ok(r.status !== 0 && !r.touched && pattern.test(r.stderr), `${msg}: refused before the site is touched (exit ${r.status}: ${r.stderr.trim().split('\n').pop()?.slice(0, 120)})`)
}

section('release.mjs --home-web: where the output may go (nothing signed, nothing of it removed)')
{
  // each row: [message, refusal pattern, (site) => { site?, out, keep }] where `keep` must survive
  const canary = (dir, extra = {}) => { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'CANARY'); fs.writeFileSync(f, 'keep me'); for (const [k, v] of Object.entries(extra)) fs.writeFileSync(path.join(dir, k), v); return f }
  for (const [msg, pattern, setup] of [
    ['home/web output inside the site (which is mirrored to bento.page)', /inside the site/, (site) => ({ out: path.join(site, 'home-web') })],
    ['home/web output in a child of the site named ..hw', /inside the site/, (site) => ({ out: path.join(site, '..hw') })],
    ['home/web output reaching into the site through a symlink', /inside the site/, (site) => {
      fs.mkdirSync(site, { recursive: true })
      const keep = canary(site)
      const via = path.join(work, `elsewhere-${n}`); fs.mkdirSync(via, { recursive: true }); fs.symlinkSync(site, path.join(via, 'link'))
      return { out: path.join(via, 'link', 'hw'), keep }
    }],
    ['home/web output through a symlink to a folder of the fresh site that does not exist yet', /symlink to nothing/, (site) => {
      const via = path.join(path.dirname(site), 'dg'); fs.mkdirSync(via, { recursive: true }); fs.symlinkSync(path.join(site, 'releases'), path.join(via, 'dl'))
      return { out: path.join(via, 'dl', 'hw') }
    }],
    ['home/web output that contains the site (an earlier build there too)', /contains the site/, (site) => {
      const anc = path.dirname(site)
      return { out: anc, keep: canary(anc, { 'build.json': JSON.stringify(EARLIER_BUILD) }) }
    }],
    ['home/web output holding something other than an earlier build', /holds something other/, () => {
      const out = path.join(work, `not-a-build-${n}`)
      return { out, keep: canary(out) }
    }],
    ['home/web output whose build.json is not a build\'s', /holds something other/, () => {
      const out = path.join(work, `fake-build-${n}`)
      return { out, keep: canary(out, { 'build.json': '{}' }) }
    }],
    ['home/web output inside the published tree (the next release would copy it into the site)', /inside the published tree/, (site, pub) => {
      return { out: path.join(pub, 'hw'), keep: canary(pub) }
    }],
    ['home/web output that contains the published tree', /contains the published tree/, (site, pub) => {
      const out = path.dirname(pub)
      return { out, keep: canary(out, { 'build.json': JSON.stringify(EARLIER_BUILD) }) }
    }],
  ]) {
    const name = `out-${++n}`
    const site = path.join(work, name, 'site')
    const pub = path.join(work, `pubhome-${n}`, 'published')
    fs.mkdirSync(pub, { recursive: true })
    const { out, keep } = setup(site, pub)
    const r = release([...['--key', THROWAWAY, '--home-web', '--home-web-dev', '--frame-origin', FRAME], '--home-web-out', out], path.relative(work, site), { published: pub })
    const signed = signedIn(site)
    ok(r.status !== 0 && pattern.test(r.stderr) && !signed.length && (!keep || fs.existsSync(keep)) && !fs.existsSync(path.join(out, 'library')),
      `${msg}: refused, nothing signed, nothing written there${keep ? ', and what it held survives' : ''} (exit ${r.status}: ${r.stderr.trim().split('\n').pop()?.slice(0, 110)})`)
  }
}

section('release.mjs --home-web: refusals before signing that empty the output first')
{
  const out = staleOut('key.home-web')
  const r = release(['--key', THROWAWAY, '--home-web', '--frame-origin', FRAME, '--home-web-out', out], 'site-key')
  ok(r.status !== 0 && /not the release key/.test(r.stderr) && !signedIn(r.site).length, `a signing key that is not the release key, without --home-web-dev: refused, nothing signed (exit ${r.status})`)
  ok(!fs.existsSync(out), 'the non-release-key refusal leaves no earlier (development, test-key) build in its output')
}
{
  const opt = (args) => (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : d }
  const call = (args, keyPath) => {
    const o = homeWebOptions({ args, opt: opt(args), site: path.join(work, 'site') })
    return o && { ...o, devKey: homeWebKey({ keyPath, releaseKey: releasePublicKey, dev: o.dev }) }
  }
  // a mutant may make a call throw: the row goes red, the rig never crashes
  const safe = (f) => { try { return f() } catch (e) { return { thrown: e.message } } }
  ok(safe(() => call(['--app', 'slides'])) === null, 'without --home-web, no home/web build (the release is unchanged)')
  const prod = call(['--home-web', '--frame-origin', FRAME], LOOKS_LIKE_RELEASE)
  ok(prod && prod.dev === false && prod.devKey === null && prod.out === path.join(work, 'site.home-web'),
    'positive control: the release key with --home-web gives a production build outside the site (<site>.home-web)')
  const noKey = call(['--home-web', '--frame-origin', FRAME], null)
  ok(noKey && noKey.dev === false && noKey.devKey === null, 'no --key (the default release key, never read here): a production build')
  const reh = call(['--home-web', '--home-web-dev', '--frame-origin', FRAME], THROWAWAY)
  ok(reh && reh.dev === true && reh.devKey?.x === JSON.parse(fs.readFileSync(THROWAWAY, 'utf8')).public.x && !('d' in reh.devKey),
    'a rehearsal key with --home-web-dev: a development build carrying only the PUBLIC half')
  // bento/id: an explicit opt-in, never a default (absent flag: no identity)
  const hasIdentity = (o) => homeWebBuildArgs({ root: ROOT, opts: o, histories: [] }).includes('--identity')
  ok(noKey && noKey.identity === false && !hasIdentity(noKey), 'without --home-web-identity, the home/web build has no --identity (absent flag)')
  const idp = call(['--home-web', '--frame-origin', FRAME, '--home-web-identity'], null)
  ok(idp && idp.identity === true && hasIdentity(idp) && idp.libraryOrigin === 'https://home.bento.page', '--home-web-identity adds --identity to the home/web build, for https://home.bento.page')
  let stray = ''
  try { call(['--app', 'slides', '--home-web-identity']) } catch (e) { stray = e.message }
  ok(/only mean something with --home-web/.test(stray), '--home-web-identity without --home-web: refused')
}

section('release.mjs --home-web: refusals after seeding, before anything is signed')
// The throwaway key signs a spaces history here, so the rehearsal can seed a
// published app its development build will take.
const throwPriv = createPrivateKey({ key: JSON.parse(fs.readFileSync(THROWAWAY, 'utf8')).private, format: 'jwk' })
const signThrowaway = (payload) => JSON.stringify({ payload, sig: nodeSign('sha256', Buffer.from(payload), { key: throwPriv, dsaEncoding: 'ieee-p1363' }).toString('base64') })
const SPACES_HISTORY = signThrowaway(JSON.stringify({ ...JSON.parse(realHistory.payload), app: 'bento-spaces' }))
const REHEARSE = ['--key', THROWAWAY, '--home-web', '--home-web-dev', '--frame-origin', FRAME]
for (const [name, published, env, pattern, msg, extraArgs = []] of [
  ['seed-no-history', { 'releases/spaces/manifest.json': '{}' }, {}, /bento-spaces is published .* no releases\/spaces\/history\.json/,
    'a published app (spaces) with a manifest and no history'],
  ['seed-bad-history', { 'releases/spaces/manifest.json': '{}', 'releases/spaces/history.json': JSON.stringify(realHistory) }, {}, /published history would be refused/,
    'a published history the build would refuse (not signed by the build\'s key)'],
  ['mutant-env', null, { BENTO_HOME_WEB_MUTANT: JSON.stringify({ file: 'verify.ts', from: 'x', to: 'y' }) }, /BENTO_HOME_WEB_MUTANT/,
    'BENTO_HOME_WEB_MUTANT in the environment (even for a development build)'],
  ['no-esbuild', null, { ESBUILD: path.join(work, 'no-such-esbuild') }, /esbuild/, 'esbuild missing'],
  ...(fs.existsSync(path.join(ROOT, 'kernel/src/directory-keys.ts')) ? [] : [['identity-unpinned', null, {}, /--home-web-identity: no pinned directory keys/,
    '--home-web-identity while the kernel pins no directory keys', ['--home-web-identity']]]),
]) {
  const out = staleOut(`${name}.home-web`)
  const r = release([...REHEARSE, ...extraArgs, '--home-web-out', out], `site-${name}`, { published: published && publishedTree(`published-${name}`, published), env })
  const signed = signedIn(r.site)
  ok(r.status !== 0 && pattern.test(r.stderr) && signed.length === 0,
    `${msg}: refused, nothing signed (exit ${r.status}; signed: ${signed.join(', ') || 'none'}: ${r.stderr.trim().split('\n').pop()?.slice(0, 110)})`)
  ok(!fs.existsSync(out), `${msg}: leaves no earlier (development, test-key) build in its output`)
}
{
  // positive control for the seeded check: the same command takes a good history and writes nothing
  const out = path.join(work, 'check-only')
  const hist = W('spaces-history.json', SPACES_HISTORY)
  const r = spawnSync(process.execPath, [path.join(ROOT, 'home/web/build.mjs'), '--check', '--out', out, '--frame-origin', FRAME, '--dev', '--key', W('throwaway-pub.json', JSON.stringify(JSON.parse(fs.readFileSync(THROWAWAY, 'utf8')).public)), '--history', hist],
    { encoding: 'utf8', env: { ...process.env, BENTO_HOME_WEB_MUTANT: '' } })
  ok(r.status === 0 && !fs.existsSync(out), `positive control: build.mjs --check takes a history its key signed, and writes nothing (exit ${r.status})`)
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'home/web/build.mjs'), '--check', '--out', out, '--frame-origin', FRAME, '--history', hist],
    { encoding: 'utf8', env: { ...process.env, BENTO_HOME_WEB_MUTANT: '' } })
  ok(bad.status !== 0 && /would refuse this history/.test(bad.stderr) && !fs.existsSync(out), '--check refuses the same history under the release key, and writes nothing')
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
  const firstRelease = stage('pub-e', ['releases/slides/manifest.json', 'releases/spaces/manifest.json', 'releases/spaces/history.json'])
  ok(publishedHistories(firstRelease, APPS, 'slides').map((x) => x.appId).join() === 'bento-spaces' && /bento-slides is published/.test(thrown(firstRelease)),
    'before signing, the app being released may lack its history (its first); once signed it may not')
  ok(publishedHistories(stage('pub-f', []), APPS, 'slides').length === 0, 'before signing, a site that publishes nothing yet: nothing to check, not refused')
}

// --- 3. a rehearsal release with --home-web ------------------------------------------
section('release.mjs --home-web --home-web-dev: a rehearsal (throwaway key)')
if (process.env.BENTO_HWB_NO_REHEARSAL) console.log('  note  rehearsal not run: this is a mutant copy (test-home-web-build-mutants.mjs); the plain rig runs it')
else {
  const shell = path.join(ROOT, `slides/dist-single/${APPS.slides.shell}`)
  if (!fs.existsSync(shell)) { console.error(`no built slides shell at ${shell}: cd slides && npm run build:single`); process.exit(1) }
  const hw = staleOut('rehearsal.home-web')
  const seed = publishedTree('published-rehearsal', { 'releases/spaces/manifest.json': '{}', 'releases/spaces/history.json': SPACES_HISTORY })
  const r = release([...REHEARSE, '--home-web-first', '--home-web-out', hw], 'rehearsal', { published: seed })
  if (r.status !== 0) console.log(r.stdout.split('\n').slice(-15).join('\n') + '\n' + r.stderr)
  ok(r.status === 0, `the rehearsal release with --home-web succeeds (exit ${r.status})`)
  const info = fs.existsSync(path.join(hw, 'build.json')) ? JSON.parse(fs.readFileSync(path.join(hw, 'build.json'), 'utf8')) : {}
  const signed = path.join(r.site, 'releases/slides/history.json')
  ok(info.frameOrigin === FRAME && info.dev === true && info.testKey === true, 'home/web was built for the given frame origin, marked as a development, test-key build')
  ok(JSON.stringify(info.histories) === JSON.stringify([path.relative(ROOT, signed), path.relative(ROOT, path.join(r.site, 'releases/spaces/history.json'))]),
    `it bundled the history this release signed and the seeded spaces one, and only those (${info.histories})`)
  const library = fs.existsSync(path.join(hw, 'library/index.html')) ? fs.readFileSync(path.join(hw, 'library/index.html'), 'utf8') : ''
  ok(fs.existsSync(signed) && library.includes(JSON.parse(fs.readFileSync(signed, 'utf8')).sig) && library.includes(JSON.parse(SPACES_HISTORY).sig) && !library.includes('STALE'),
    'the library page carries both signed histories byte for byte, and nothing of the stale build planted in its output')
  const siteFiles = fs.existsSync(r.site) ? execFileSync('find', [r.site, '-type', 'f'], { encoding: 'utf8' }).trim().split('\n').map((f) => path.relative(r.site, f)) : []
  ok(siteFiles.length > 10 && !siteFiles.some((f) => f !== 'releases/home-web/served.json' && (/(^|\/)(frame\.html|_headers|build\.json)$/.test(f) || f.includes('home-web') || f.startsWith('library/'))),
    `nothing of home/web is in the site but its signed release list (${siteFiles.length} files): nothing deploys it`)

  // the tripwire's release list, signed into the site with the release (sign-home-web-served.mjs)
  const listFile = path.join(r.site, 'releases/home-web/served.json')
  const throwPub = JSON.parse(fs.readFileSync(THROWAWAY, 'utf8')).public
  const listOf = (f) => { try { return verifyEnvelope(fs.readFileSync(f, 'utf8'), throwPub) } catch { return null } }
  const l1 = listOf(listFile)
  ok(l1?.type === 'bento/home-web/served' && l1.serial === 1 && l1.releases.length === 1 && l1.releases[0].origins['https://home.bento.page']?.files['/']?.sha256,
    'the first release list is in the site, signed by the release\'s key: serial 1, the library as built')
  const built = fs.readFileSync(path.join(hw, 'library/index.html'))
  ok(l1?.releases[0].origins['https://home.bento.page'].files['/'].sha256 === createHash('sha256').update(built).digest('hex'), 'and it pins the library page this release built')
  // the next release builds on the published list
  const seed2 = publishedTree('published-rehearsal-2', { 'releases/spaces/manifest.json': '{}', 'releases/spaces/history.json': SPACES_HISTORY, 'releases/home-web/served.json': fs.readFileSync(listFile, 'utf8') })
  const r2 = release([...REHEARSE, '--home-web-out', staleOut('rehearsal-2.home-web')], 'rehearsal-2', { published: seed2 })
  const l2 = listOf(path.join(r2.site, 'releases/home-web/served.json'))
  ok(r2.status === 0 && l2?.serial === 2 && l2.releases.length === 2, `the next release builds on the published list: serial 2, two releases (exit ${r2.status})`)
}

section('release.mjs --home-web: the release list, before anything is signed')
{
  const seedNoList = publishedTree('published-nolist', { 'releases/spaces/manifest.json': '{}', 'releases/spaces/history.json': SPACES_HISTORY })
  const a = release([...REHEARSE, '--home-web-out', staleOut('nolist.home-web')], 'site-nolist', { published: seedNoList })
  ok(a.status !== 0 && /--home-web-first/.test(a.stderr) && !signedIn(a.site).length, `no published list and no --home-web-first: refused, nothing signed (exit ${a.status})`)
  const seedList = publishedTree('published-haslist', { 'releases/spaces/manifest.json': '{}', 'releases/spaces/history.json': SPACES_HISTORY, 'releases/home-web/served.json': '{}' })
  // the held list is verified before signing too (security re-check N5): junk, another key, another type
  const listPayload = (extra = {}) => JSON.stringify({ type: 'bento/home-web/served', v: 1, serial: 3, at: '2026-11-01T00:00:00.000Z', releases: [], ...extra })
  const otherPriv = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
  const signOther = (payload) => JSON.stringify({ payload, sig: nodeSign('sha256', Buffer.from(payload), { key: otherPriv, dsaEncoding: 'ieee-p1363' }).toString('base64') })
  for (const [n, [label, list, pattern]] of [
    ['a published list that is junk ({})', '{}', /does not verify/],
    ['a published list signed by another key', signOther(listPayload()), /does not verify/],
    ['a published list of another type', signThrowaway(listPayload({ type: 'bento/other' })), /not a v1 bento\/home list/],
  ].entries()) {
    const seed = publishedTree(`published-list-${n}`, { 'releases/spaces/manifest.json': '{}', 'releases/spaces/history.json': SPACES_HISTORY, 'releases/home-web/served.json': list })
    const r = release([...REHEARSE, '--home-web-out', staleOut(`list-${n}.home-web`)], `site-list-${n}`, { published: seed })
    ok(r.status !== 0 && pattern.test(r.stderr) && !signedIn(r.site).length, `${label}: refused with a reason, nothing signed (exit ${r.status}: ${r.stderr.trim().split('\n').pop()?.slice(0, 100)})`)
  }
  const b = release([...REHEARSE, '--home-web-first', '--home-web-out', staleOut('haslist.home-web')], 'site-haslist', { published: seedList })
  ok(b.status !== 0 && /already published/.test(b.stderr) && !signedIn(b.site).length, `--home-web-first over a published list: refused, nothing signed (exit ${b.status})`)
  // a published tree holding no app, so no seeded history stands in the way of the check this row is about
  const seedEmpty = publishedTree('published-empty', { 'README.txt': 'nothing published yet' })
  const c = release(['--key', LOOKS_LIKE_RELEASE, '--home-web', '--home-web-dev', '--home-web-first', '--frame-origin', FRAME, '--home-web-out', staleOut('devrel.home-web')], 'site-devrel', { published: seedEmpty })
  ok(c.status !== 0 && /throwaway key only/.test(c.stderr) && !signedIn(c.site).length, `--home-web-dev with the release key: refused before signing (the list is never signed for a development build with it) (exit ${c.status})`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
