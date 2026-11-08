#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Does a host serve the published site, byte for byte and header for header?
//
//   node scripts/verify-site.mjs --tree ../bento-site                       # bento.page vs the tree
//   node scripts/verify-site.mjs --tree ../bento-site --candidate https://x.example [--preview]
//
// `--tree` is the published mirror (bento-site). Every file in it is fetched
// from `--base` (default https://bento.page) and, when given, `--candidate`,
// and the run FAILS on any of:
//
//   · a body whose sha256 differs from the tree's bytes (signed bytes must be
//     served bytes: a shell, manifest or pack that drifted is refused by every
//     shipped file, or worse, baked into documents saved from a download);
//   · between base and candidate: a different status, or a different value of
//     a header a client acts on (COMPARED below), including a security header
//     one host adds and the other does not, for every file, for the derived
//     URLs a static host answers (`/dir`, `/dir/`, extensionless `.html`), and
//     for the 404 page;
//   · the update path a shipped deck takes, run on each host the way a file://
//     deck runs it: `Origin: null`, every hop must carry a CORS grant, the
//     signed envelope (manifest, history, pack index) must verify against the
//     release key embedded in kernel/src/update.ts, and the shell and every
//     pack must hash to the sha256 the signature pins.
//
// Not compared, on purpose: Date, Expires, Last-Modified, ETag, Age, Vary and
// the CDN's own diagnostics. They differ between any two hosts and no client
// decision rests on them; Cache-Control (which wins over Expires) is compared.
//
// `--preview`: the candidate is a preview hostname outside the bento.page zone.
// The zone itself rewrites Cache-Control on the responses it caches (its
// browser-cache TTL), which a hostname outside it never gets, and a preview
// URL may carry `X-Robots-Tag: noindex`. Those two differences are listed as
// EXPECTED rather than failing. Run without it once the candidate is behind
// the zone, where nothing may differ.
//
// `--allow <regex>` (repeatable): a difference whose text matches is listed as
// ACCEPTED instead of failing. For a difference someone has looked at and
// decided does not matter; name each one, never a catch-all.
//
// Exit status: 0 clean, 1 any difference, 2 usage error.

import { createHash, webcrypto } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const subtle = webcrypto.subtle

/** Headers a client acts on. A difference in any of them fails the run. */
export const COMPARED = [
  'content-type',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'cache-control',
  'location',
  'content-disposition',
  'x-robots-tag',
  // security headers: none are sent today, and adding one is a separate,
  // deliberate change — never a side effect of moving hosts.
  'strict-transport-security',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
]

/** Host configuration files: read by a static host, never served by one. */
export const HOST_CONFIG = new Set(['_headers', '_redirects', '_routes.json', 'wrangler.json', 'wrangler.jsonc', 'wrangler.toml', '.assetsignore'])

/** Every file in the tree, relative, '/'-separated. `.git` is never walked. */
export function treeFiles(dir, base = dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...treeFiles(full, base))
    else out.push(full.slice(base.length + 1).split('\\').join('/'))
  }
  return out.sort()
}

/**
 * The URL paths to check, each with the tree file whose bytes a 200 must
 * carry (null = no body expectation, e.g. a redirect or the 404 probe).
 */
export function urlPlan(files) {
  const served = files.filter((f) => !HOST_CONFIG.has(f))
  const plan = served.map((f) => ({ path: '/' + f, file: f, kind: 'file' }))
  const dirs = new Set()
  for (const f of served) {
    if (f === 'index.html') plan.push({ path: '/', file: f, kind: 'index' })
    else if (f.endsWith('/index.html')) {
      const d = '/' + f.slice(0, -'/index.html'.length)
      dirs.add(d)
      plan.push({ path: d + '/', file: f, kind: 'index' })
      plan.push({ path: d, file: null, kind: 'dir-no-slash' })
    }
    if (f.endsWith('.html') && !f.endsWith('index.html')) {
      plan.push({ path: '/' + f.slice(0, -'.html'.length), file: f, kind: 'extensionless' })
    }
  }
  // directories WITHOUT an index (e.g. /releases/): whatever the host does
  // there must not change either
  const bare = new Set()
  for (const f of served) {
    const parts = f.split('/').slice(0, -1)
    for (let i = 1; i <= parts.length; i++) {
      const d = '/' + parts.slice(0, i).join('/')
      if (!dirs.has(d)) bare.add(d)
    }
  }
  for (const d of [...bare].sort()) plan.push({ path: d + '/', file: null, kind: 'dir-no-index' })
  plan.push({ path: '/__bento-verify-site-missing', file: null, kind: 'missing' })
  plan.push({ path: '/__bento-verify-site-missing/deeper.json', file: null, kind: 'missing' })
  return plan
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

/** One request, as a file:// deck makes it. Redirects are NOT followed. */
async function get(origin, path, fetchImpl) {
  const res = await fetchImpl(origin + path, { redirect: 'manual', headers: { origin: 'null' } })
  const body = Buffer.from(await res.arrayBuffer())
  const headers = {}
  for (const h of COMPARED) {
    const v = res.headers.get(h)
    if (v !== null) headers[h] = v.trim()
  }
  return { status: res.status, headers, sha: sha(body), cfCache: res.headers.get('cf-cache-status') }
}

/** Location is compared as a path on its own host, so hostnames may differ. */
function normLocation(v, origin) {
  try {
    const u = new URL(v, origin + '/')
    return u.origin === new URL(origin).origin ? u.pathname + u.search : u.href
  } catch { return v }
}

/** Cache statuses meaning the ZONE cached it — and so may have rewritten Cache-Control. */
const ZONE_CACHED = new Set(['HIT', 'MISS', 'EXPIRED', 'REVALIDATED', 'STALE', 'UPDATING'])

export function compareResponses(a, b, { aOrigin, bOrigin, preview }) {
  const fails = []
  const expected = []
  if (a.status !== b.status) fails.push(`status ${a.status} → ${b.status}`)
  if (a.status === 200 && b.status === 200 && a.sha !== b.sha) fails.push(`body sha256 ${a.sha.slice(0, 12)} → ${b.sha.slice(0, 12)}`)
  for (const h of COMPARED) {
    let va = a.headers[h]
    let vb = b.headers[h]
    if (h === 'location') {
      if (va !== undefined) va = normLocation(va, aOrigin)
      if (vb !== undefined) vb = normLocation(vb, bOrigin)
    }
    if (va === vb) continue
    const line = `${h}: ${va ?? '(absent)'} → ${vb ?? '(absent)'}`
    if (preview && h === 'cache-control' && ZONE_CACHED.has(String(a.cfCache).toUpperCase())) expected.push(line + '  [zone browser-cache TTL; preview is outside the zone]')
    else if (preview && h === 'x-robots-tag' && va === undefined && /noindex/i.test(vb ?? '')) expected.push(line + '  [preview hostname]')
    else fails.push(line)
  }
  return { fails, expected }
}

// ——— the update path ————————————————————————————————————————————————

/** The release public key, read from the kernel so this can never drift from what shipped files trust. */
export function releaseJwk(src = readFileSync(join(root, 'kernel/src/update.ts'), 'utf8')) {
  const m = /const PUBLIC_KEY_JWK = \{([^}]*)\}/.exec(src)
  if (!m) throw new Error('PUBLIC_KEY_JWK not found in kernel/src/update.ts')
  const field = (k) => (new RegExp(`\\b${k}:\\s*'([^']+)'`).exec(m[1]) ?? [])[1]
  const jwk = { kty: field('kty'), crv: field('crv'), x: field('x'), y: field('y') }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new Error('PUBLIC_KEY_JWK did not parse')
  return jwk
}

/** kernel/src/update.ts verifySigned, in node: { payload: string, sig: base64 } over ECDSA P-256/SHA-256. */
export async function verifyEnvelope(raw, jwk) {
  const { payload, sig } = JSON.parse(raw)
  if (typeof payload !== 'string' || typeof sig !== 'string') throw new Error('not a signed envelope')
  const key = await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(sig, 'base64'), new TextEncoder().encode(payload))
  if (!ok) throw new Error('signature INVALID')
  return JSON.parse(payload)
}

/**
 * fetch as a browser does from a file:// page: Origin null, CORS mode, redirects
 * followed — and EVERY hop, redirects included, must grant the null origin, or
 * the browser hands the page a network error.
 */
export async function corsFetch(url, fetchImpl, maxHops = 5) {
  const hops = []
  for (let i = 0; i <= maxHops; i++) {
    const res = await fetchImpl(url, { redirect: 'manual', headers: { origin: 'null' } })
    const acao = res.headers.get('access-control-allow-origin')
    hops.push(`${res.status} ${url}`)
    if (acao !== '*' && acao !== 'null') return { error: `no CORS grant for a file:// page (access-control-allow-origin: ${acao ?? 'absent'}) at ${res.status} ${url}`, hops }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.arrayBuffer()
      url = new URL(res.headers.get('location'), url).href
      continue
    }
    return { res, body: Buffer.from(await res.arrayBuffer()), hops, finalUrl: url }
  }
  return { error: 'too many redirects', hops }
}

/** Move an absolute bento.page URL onto the host under test (same path). */
const onHost = (url, origin) => { const u = new URL(url); return origin + u.pathname + u.search }

/** Run the update path against `origin` for every signed envelope in the tree. */
export async function checkUpdatePath(origin, tree, files, { jwk, fetchImpl }) {
  const fails = []
  const notes = []
  const envelopes = files.filter((f) => f.startsWith('releases/') && f.endsWith('.json') && !f.includes('/packs/'))
  for (const f of envelopes) {
    let local
    try { local = JSON.parse(readFileSync(join(tree, f), 'utf8')) } catch { continue }
    if (typeof local?.payload !== 'string') { notes.push(`${f}: not a signed envelope — served bytes checked only`); continue }
    const url = `${origin}/${f}`
    const r = await corsFetch(url, fetchImpl)
    if (r.error) { fails.push(`${f}: ${r.error}`); continue }
    if (!r.res.ok) { fails.push(`${f}: ${r.res.status}`); continue }
    let payload
    try { payload = await verifyEnvelope(r.body.toString('utf8'), jwk) } catch (e) { fails.push(`${f}: ${e.message}`); continue }
    if (f.endsWith('/manifest.json')) {
      if (!/^[0-9a-f]{64}$/i.test(payload.sha256 ?? '') || typeof payload.url !== 'string') { fails.push(`${f}: payload is not a release`); continue }
      const s = await corsFetch(onHost(payload.url, origin), fetchImpl)
      if (s.error) { fails.push(`${f} → shell: ${s.error}`); continue }
      if (!s.res.ok) { fails.push(`${f} → shell: ${s.res.status} ${s.finalUrl}`); continue }
      if (sha(s.body) !== payload.sha256.toLowerCase()) { fails.push(`${f} → shell: sha256 does not match the signed pin`); continue }
      if (s.hops.length > 1) notes.push(`${f} → shell reached through a redirect: ${s.hops.join(' ⇒ ')}`)
      notes.push(`${f}: ${payload.app} ${payload.version} verifies; shell matches its pin`)
    } else if (f.endsWith('/packs.json')) {
      let bad = 0
      for (const p of payload.packs ?? []) {
        const pr = await corsFetch(new URL(p.url, url).href, fetchImpl)
        if (pr.error) { fails.push(`${f} → ${p.url}: ${pr.error}`); bad++; continue }
        if (!pr.res.ok || sha(pr.body) !== String(p.sha256).toLowerCase()) { fails.push(`${f} → ${p.url}: ${pr.res.status}, sha256 ${pr.res.ok ? 'does not match the signed pin' : 'n/a'}`); bad++ }
      }
      if (!bad) notes.push(`${f}: index verifies; ${(payload.packs ?? []).length} pack(s) match their pins`)
    } else {
      notes.push(`${f}: signature verifies`)
    }
  }
  return { fails, notes }
}

// ——— the run ————————————————————————————————————————————————————————

async function pool(items, n, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]) }
  }))
  return out
}

export async function verifySite({ tree, base, candidate = null, preview = false, allow = [], jwk = releaseJwk(), fetchImpl = fetch, concurrency = 8, log = console.log }) {
  const files = treeFiles(tree)
  const plan = urlPlan(files)
  const localSha = new Map(files.map((f) => [f, sha(readFileSync(join(tree, f)))]))
  const failures = []
  const expected = []
  const hosts = candidate ? [base, candidate] : [base]

  const results = await pool(plan, concurrency, async (p) => {
    const r = {}
    for (const h of hosts) {
      try { r[h] = await get(h, p.path, fetchImpl) } catch (e) { r[h] = { error: e.message } }
    }
    return r
  })

  plan.forEach((p, i) => {
    const r = results[i]
    for (const h of hosts) {
      if (r[h].error) { failures.push(`${p.path} [${h}]: request failed: ${r[h].error}`); continue }
      // served bytes == published bytes, wherever a file is answered with 200
      if (p.file && r[h].status === 200 && r[h].sha !== localSha.get(p.file)) {
        failures.push(`${p.path} [${h}]: served sha256 ${r[h].sha.slice(0, 12)} ≠ tree ${localSha.get(p.file).slice(0, 12)} (${p.file})`)
      }
      if (p.kind === 'file' && r[h].status !== 200) failures.push(`${p.path} [${h}]: ${r[h].status} for a published file`)
    }
    if (candidate && !r[base].error && !r[candidate].error) {
      const c = compareResponses(r[base], r[candidate], { aOrigin: base, bOrigin: candidate, preview })
      for (const f of c.fails) failures.push(`${p.path}: ${f}`)
      for (const e of c.expected) expected.push(`${p.path}: ${e}`)
    }
  })

  const notes = []
  for (const h of hosts) {
    const u = await checkUpdatePath(h, tree, files, { jwk, fetchImpl })
    for (const f of u.fails) failures.push(`update path [${h}]: ${f}`)
    for (const n of u.notes) notes.push(`[${h}] ${n}`)
  }

  const accepted = failures.filter((f) => allow.some((re) => re.test(f)))
  const kept = failures.filter((f) => !accepted.includes(f))

  log(`• ${files.length} file(s) in the tree, ${plan.length} URL(s) checked on ${hosts.join(' and ')}`)
  for (const n of notes) log(`  ${n}`)
  if (expected.length) {
    log(`• ${expected.length} difference(s) EXPECTED on a preview hostname (re-run without --preview once behind the zone):`)
    for (const e of expected) log(`  ~ ${e}`)
  }
  if (accepted.length) {
    log(`• ${accepted.length} difference(s) ACCEPTED by --allow:`)
    for (const a of accepted) log(`  = ${a}`)
  }
  return { failures: kept, accepted, expected, notes, checked: plan.length }
}

// ——— CLI ————————————————————————————————————————————————————————————

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const args = process.argv.slice(2)
  const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null }
  const tree = resolve(opt('tree') ?? process.env.BENTO_SITE_DIR ?? join(root, '..', 'bento-site'))
  const trim = (u) => u?.replace(/\/+$/, '') ?? null
  const base = trim(opt('base') ?? 'https://bento.page')
  const candidate = trim(opt('candidate'))
  if (!existsSync(tree) || !statSync(tree).isDirectory() || !existsSync(join(tree, 'index.html'))) {
    console.error(`✗ --tree ${tree} is not a published site tree (no index.html)`)
    process.exit(2)
  }
  const allow = args.flatMap((a, i) => (a === '--allow' && args[i + 1] ? [new RegExp(args[i + 1])] : []))
  const { failures } = await verifySite({ tree, base, candidate, preview: args.includes('--preview'), allow })
  if (failures.length) {
    console.error(`\n✗ ${failures.length} difference(s):`)
    for (const f of failures) console.error(`  ✗ ${f}`)
    console.error('\n  A fresh publish can lag by the hosts\' cache lifetime (max-age); re-run after it before acting on body-only differences.')
    process.exit(1)
  }
  console.log(`\n✓ ${candidate ? `${candidate} serves exactly what ${base} serves, and both serve the tree` : `${base} serves the tree byte for byte`}; the update path verifies`)
}
