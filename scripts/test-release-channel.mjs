#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The release channel, rehearsed end to end with a THROWAWAY key.
//
//   node scripts/test-release-channel.mjs [--app dash] [--shell path]
//
// WHAT THIS PROVES, and why it needs a rig of its own.
//
// A release is the one pipeline that cannot be tested by running it: it SIGNS,
// and the signing key never leaves the maintainer's machine (docs/RELEASING.md),
// so CI has no key and a real release is a one-way act. `test-release-apps.mjs`
// covers the REGISTRY drifting from the tree. This covers the part after that —
// the artifacts themselves — by cutting a complete release with a key it
// generates in a temp directory and throws away:
//
//   1. the built shell satisfies the SPLICE CONTRACT (PLATFORM §2). Every
//      updater ever shipped is frozen code that splices into #bento-doc; a
//      shell that breaks that bricks self-save and self-update for files
//      already on disk. release.mjs gates this before signing, and so does this.
//   2. the manifest has the shape shipped files read: a signed envelope whose
//      payload carries { app, version, sha256, url } — with `app` matching the
//      shell's own configureApp id, and `url` under the path the shell fetches.
//      Both are silent when wrong: the file checks, verifies, and declines.
//   3. THE REFUSALS. This is the half that matters, and it is exercised against
//      kernel/src/update.ts ITSELF — the code every shipped file runs — with
//      only the embedded public key swapped for the throwaway one. A tampered
//      manifest, a manifest signed for another app, a downgrade, and a tampered
//      SHELL must each be refused. A verifier that accepts everything passes
//      every positive test there is.
//
// Nothing here reads, writes or looks for ~/.bento/release-key.json.

import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APPS, RELEASE_MARKER, tagFor } from './apps.mjs'
import { gateShell } from './shell-gate.mjs'
import { verifyEnvelope } from './sign-payload.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d }

const appKey = opt('app', 'dash')
const app = APPS[appKey]
if (!app) { console.error(`unknown --app "${appKey}"`); process.exit(1) }
const shellSrc = opt('shell', join(root, `${app.dir}/dist-single/${app.shell}`))

let failures = 0
let checks = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
async function throws(fn, match, msg) {
  let err = null
  try { await fn() } catch (e) { err = e }
  ok(!!err && new RegExp(match, 'i').test(err.message ?? String(err)),
    `${msg} (got: ${err ? String(err.message ?? err).slice(0, 80) : 'NO ERROR — accepted it'})`)
}

if (!existsSync(shellSrc)) {
  // Fail LOUD, never skip. A gate that quietly passes when the artifact is
  // missing is the exact failure shape documented in publish-site.mjs.
  console.error(`✗ no built shell at ${shellSrc}\n  Build it first:  cd ${app.dir} && npm run build:single`)
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'bento-relchan-'))
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }) } catch { /* temp */ } })

// ---- a throwaway signing key ------------------------------------------------
// Generated here, in a temp directory, used for this run and deleted with it.
// scripts/keygen.mjs writes to ~/.bento by default, which is the maintainer's
// real key — this never goes near it.
const keyPath = join(work, 'throwaway-key.json')
{
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  writeFileSync(keyPath, JSON.stringify({
    kind: 'bento-release-key-THROWAWAY',
    private: privateKey.export({ format: 'jwk' }),
    public: publicKey.export({ format: 'jwk' }),
  }))
}
const pubJwk = JSON.parse(readFileSync(keyPath, 'utf8')).public

console.log(`\n=== ${app.appId}: cutting a rehearsal release into ${work} ===\n`)

// ---- 1. the real pipeline, staged somewhere harmless ------------------------
const site = join(work, 'site')
execFileSync('node', [
  join(root, 'scripts/release.mjs'),
  '--app', appKey,
  '--no-build',                    // the shell under test is the one already built
  '--key', keyPath,
  '--out', site,
  '--allow-missing-published',     // there is no live tree in a rehearsal
], {
  stdio: ['ignore', 'pipe', 'inherit'],
  // Point the published-tree lookup at nothing, so the run cannot seed itself
  // from a real bento-site clone sitting beside the repo.
  env: { ...process.env, BENTO_SITE_DIR: join(work, 'no-such-published-tree') },
})

const stagedShell = join(site, `releases/${app.dir}/${app.shell}`)
const manifestPath = join(site, `releases/${app.dir}/manifest.json`)
ok(existsSync(stagedShell), `the release staged the shell at releases/${app.dir}/${app.shell}`)
ok(existsSync(manifestPath), `the release signed a manifest at releases/${app.dir}/manifest.json`)
ok(existsSync(join(site, `${app.dir}/index.html`)), `the live demo is staged at /${app.dir}/`)
{
  const marker = JSON.parse(readFileSync(join(site, RELEASE_MARKER), 'utf8'))
  ok(marker.app === appKey && marker.appId === app.appId,
    `the tree records WHICH app it is (publish-site reads it to name ${tagFor(app, marker.version)})`)
}

// ---- 2. the conformance gate ------------------------------------------------
// release.mjs already ran it before signing; running it again here is cheap and
// makes the NEGATIVE control below meaningful — a gate is only evidence if the
// same call refuses a shell that deserves refusing.
let gatePassed = true
try { gateShell(stagedShell) } catch (e) { gatePassed = false; console.log(`  gate said: ${e.message}`) }
ok(gatePassed, 'PLATFORM §2 conformance gate: the built shell passes')

// NEGATIVE CONTROL for the gate. Break the one thing the splice contract is
// about — the plaintext #bento-doc block, whose content may never contain a
// script-close — and the same gate must refuse it. Without this, "the gate
// passed" says nothing about whether the gate can fail.
{
  const bad = join(work, 'bad-shell.html')
  const html = readFileSync(stagedShell, 'utf8')
  writeFileSync(bad, html.replace(
    /(<script type="application\/bento\+json" id="bento-doc">)/,
    '$1{"format":"bento/dash","x":"</scr' + 'ipt><script>alert(1)</scr' + 'ipt>"}',
  ))
  let refused = false
  try { gateShell(bad) } catch { refused = true }
  ok(refused, 'NEGATIVE CONTROL: the same gate REFUSES a shell whose doc block closes its own script')
}

// ---- 3. the manifest shape --------------------------------------------------
const manifestRaw = readFileSync(manifestPath, 'utf8')
const payload = verifyEnvelope(manifestRaw, pubJwk)
ok(payload.app === app.appId,
  `the manifest is signed FOR this app (${payload.app}) — a shipped shell refuses any other`)
ok(payload.version === JSON.parse(readFileSync(join(root, `${app.dir}/package.json`), 'utf8')).version,
  `the manifest version is the app's package.json version (${payload.version})`)
ok(/^[0-9a-f]{64}$/.test(payload.sha256), 'the manifest pins a sha256 of the shell')
ok(payload.sha256 === createHash('sha256').update(readFileSync(stagedShell)).digest('hex'),
  'the pinned sha256 is the sha256 of the shell actually staged (signed bytes = served bytes)')
ok(payload.url === `https://bento.page/releases/${app.dir}/${app.shell}`,
  `the download URL is under the path the shell fetches (${payload.url})`)
ok(typeof payload.at === 'string', 'the payload is stamped with a time')

// ---- 4. the verifier every shipped file runs --------------------------------
//
// kernel/src/update.ts, copied to a temp directory with ONE edit: the embedded
// PUBLIC_KEY_JWK swapped for the throwaway public half. Everything else — the
// envelope parse, the ECDSA verify, the app-id check, the monotonicity rule,
// the sha256 pin — is the code that ships. Testing a re-implementation here
// would prove that the re-implementation works.
const kernel = join(work, 'kernel')
mkdirSync(kernel, { recursive: true })
cpSync(join(root, 'kernel/src'), kernel, { recursive: true })
{
  const p = join(kernel, 'update.ts')
  const src = readFileSync(p, 'utf8')
  const swapped = src.replace(
    /const PUBLIC_KEY_JWK = \{[\s\S]*?\} as const/,
    `const PUBLIC_KEY_JWK = ${JSON.stringify({ kty: 'EC', crv: 'P-256', x: pubJwk.x, y: pubJwk.y })} as const`,
  )
  if (swapped === src) { console.error('✗ could not swap PUBLIC_KEY_JWK — the rig cannot verify anything'); process.exit(1) }
  writeFileSync(p, swapped)
}
const kernelUpdate = await import(join(kernel, 'update.ts'))
const kernelApp = await import(join(kernel, 'app.ts'))
kernelApp.configureApp({
  appId: app.appId,
  appName: app.label,
  manifestUrl: `https://bento.page/releases/${app.dir}/manifest.json`,
})

/** Serve exactly what the staged site would serve, and nothing else. */
const serve = (routes) => {
  globalThis.fetch = async (url) => {
    const body = routes[String(url)]
    if (body === undefined) return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
    return {
      ok: true,
      status: 200,
      text: async () => (typeof body === 'string' ? body : Buffer.from(body).toString('utf8')),
      arrayBuffer: async () => (typeof body === 'string' ? Buffer.from(body, 'utf8') : body),
    }
  }
}
const MANIFEST_URL = `https://bento.page/releases/${app.dir}/manifest.json`
const shellBytes = readFileSync(stagedShell)

// The running app is APP_VERSION — '0.0.0' outside a Vite build — so the staged
// version is strictly newer and must be OFFERED.
ok(kernelUpdate.APP_VERSION === '0.0.0', 'the rig runs as version 0.0.0 (no Vite define), so the release is newer')

serve({ [MANIFEST_URL]: manifestRaw })
{
  const r = await kernelUpdate.checkForUpdates(MANIFEST_URL)
  ok(r.status === 'update' && r.release.version === payload.version,
    `ACCEPTS the correctly signed manifest and offers v${payload.version}`)
}

// NEGATIVE CONTROL 1 — the payload is tampered with (a plausible one: a
// higher version number, which is what an attacker wanting to push a shell
// would edit). The signature covers the payload's exact bytes.
{
  const env = JSON.parse(manifestRaw)
  const forged = JSON.stringify({ ...JSON.parse(env.payload), version: '99.0.0' })
  serve({ [MANIFEST_URL]: JSON.stringify({ payload: forged, sig: env.sig }) })
  const r = await kernelUpdate.checkForUpdates(MANIFEST_URL)
  ok(r.status === 'error' && /signature is INVALID/i.test(r.message),
    `NEGATIVE CONTROL: a tampered manifest payload is REFUSED (${r.status}: ${r.message?.slice(0, 40)})`)
}

// NEGATIVE CONTROL 2 — a validly signed manifest for a DIFFERENT app. The key
// is shared platform-wide, so the app id is what stops a slides release being
// spliced into a dash workbook.
{
  const otherApp = Object.values(APPS).find((a) => a.appId !== app.appId)
  execFileSync('node', [
    join(root, 'scripts/sign-release.mjs'), stagedShell,
    '--app', otherApp.appId, '--version', payload.version,
    '--url', payload.url, '--key', keyPath, '--out', join(work, 'other.json'),
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  serve({ [MANIFEST_URL]: readFileSync(join(work, 'other.json'), 'utf8') })
  const r = await kernelUpdate.checkForUpdates(MANIFEST_URL)
  ok(r.status === 'error' && /malformed/i.test(r.message),
    `NEGATIVE CONTROL: a manifest validly signed for ${otherApp.appId} is REFUSED by a ${app.appId} file`)
}

// NEGATIVE CONTROL 3 — downgrade replay. A signed, genuine, OLDER manifest
// (an attacker replaying yesterday's release to push a shell with a known bug)
// must read as "current", never as an update.
{
  execFileSync('node', [
    join(root, 'scripts/sign-release.mjs'), stagedShell,
    '--app', app.appId, '--version', '0.0.0',
    '--url', payload.url, '--key', keyPath, '--out', join(work, 'old.json'),
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  serve({ [MANIFEST_URL]: readFileSync(join(work, 'old.json'), 'utf8') })
  const r = await kernelUpdate.checkForUpdates(MANIFEST_URL)
  ok(r.status === 'current', `NEGATIVE CONTROL: an older signed manifest is not offered (${r.status})`)
}

// ---- 5. the SHELL is pinned too ---------------------------------------------
// A signature over a manifest is worth nothing if the bytes it points at are
// not checked. `fetchPinned` is the kernel's pinned fetch; `buildUpdatedFile`
// repeats the same digest comparison inline (so it can tell "download failed"
// from "download was tampered with"), and both are exercised.
const tampered = Buffer.from(shellBytes)
tampered[tampered.length - 20] = tampered[tampered.length - 20] ^ 0x01 // one bit
serve({ [payload.url]: shellBytes })
ok((await kernelUpdate.fetchPinned(payload.url, payload.sha256)) !== null,
  'the untouched shell passes its sha256 pin')
serve({ [payload.url]: tampered })
ok((await kernelUpdate.fetchPinned(payload.url, payload.sha256)) === null,
  'NEGATIVE CONTROL: a shell with ONE BIT flipped fails the pin and is not handed back')

// The same check on the path that actually rewrites the file.
serve({ [payload.url]: tampered })
await throws(
  () => kernelUpdate.buildUpdatedFile({ ...payload }, { format: 'bento/dash' }),
  'integrity check',
  'NEGATIVE CONTROL: buildUpdatedFile REFUSES the tampered shell',
)
// …and the control for the control: with the good bytes it gets PAST the
// integrity check and dies in the browser-only half (DOMParser), which is the
// only way to show in Node that the refusal above was the hash and not simply
// "this function always throws".
serve({ [payload.url]: shellBytes })
await throws(
  () => kernelUpdate.buildUpdatedFile({ ...payload }, { format: 'bento/dash' }),
  'DOMParser',
  'the untouched shell gets PAST the integrity check (and then needs a browser)',
)

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
