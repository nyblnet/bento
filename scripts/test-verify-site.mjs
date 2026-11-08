#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Rig for scripts/verify-site.mjs, offline. Two local servers play "live" and
// "candidate" over a temporary tree that carries a manifest, a pack index and
// a pack signed with a THROWAWAY key. The live server behaves the way the
// published site does today (CORS grant everywhere, max-age=600, 301 to a
// directory's slash, extensionless .html, a 404 page without Cache-Control).
// The candidate starts identical (the positive control: it must pass, and the
// update path must actually have run) and is then mutated one way at a time;
// every mutant must fail, for the reason it was built to show.

import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { webcrypto, createHash } from 'node:crypto'
import { verifySite, urlPlan, releaseJwk, compareResponses } from './verify-site.mjs'

const subtle = webcrypto.subtle
let pass = 0
let fail = 0
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`) } else { fail++; console.log(`  ✗ ${m}`) } }
const sha = (b) => createHash('sha256').update(b).digest('hex')

// ——— a signed tree ———
const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const pub = await subtle.exportKey('jwk', kp.publicKey)
const jwk = { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }
const sign = async (obj) => {
  const payload = JSON.stringify(obj)
  const sig = Buffer.from(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(payload))).toString('base64')
  return JSON.stringify({ payload, sig }, null, 2)
}

const tree = mkdtempSync(join(tmpdir(), 'verify-site-'))
const put = (p, data) => { mkdirSync(join(tree, p, '..'), { recursive: true }); writeFileSync(join(tree, p), data) }
const shell = '<!doctype html><title>shell</title><script id="bento-doc" type="application/json">{}</script>'
const pack = JSON.stringify({ lang: 'xx', strings: {} })
put('index.html', '<!doctype html><title>landing</title>')
put('404.html', '<!doctype html><title>not found</title>')
put('hello.bento.html', shell)
put('help/index.html', '<!doctype html><title>help</title>')
put('og.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
put('CNAME', 'bento.page\n')
put('.nojekyll', '')
put('_headers', '/*\n  Access-Control-Allow-Origin: *\n') // host config: never served, never checked
put('releases/slides/Bento_Slides.bento.html', shell)
put('releases/slides/packs/bento-slides-1.0.0-xx.pack.json', pack)
put('releases/slides/manifest.json', await sign({ app: 'bento-slides', version: '1.0.0', sha256: sha(shell), url: 'https://bento.page/releases/slides/Bento_Slides.bento.html' }))
put('releases/slides/packs.json', await sign({ app: 'bento-slides', version: '1.0.0', packs: [{ lang: 'xx', url: 'packs/bento-slides-1.0.0-xx.pack.json', sha256: sha(pack) }] }))
put('releases/tray/manifest.json', JSON.stringify({ version: '1.0.0' }))

// ——— a GitHub-Pages-shaped server, with knobs ———
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' }
function site(knobs = {}) {
  return createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    let p = decodeURIComponent(u.pathname)
    const base = { 'access-control-allow-origin': '*', 'cache-control': 'max-age=600' }
    const send = (status, file, extra = {}) => {
      const ct = TYPES[extname(file)] ?? 'application/octet-stream'
      let body = readFileSync(file)
      if (knobs.tamper && file.endsWith('.bento.html')) body = Buffer.concat([body, Buffer.from(' ')])
      const h = { 'content-type': ct, ...(status === 200 ? base : {}), 'access-control-allow-origin': '*', ...extra }
      if (knobs.noAcaoJson && file.endsWith('.json')) delete h['access-control-allow-origin']
      if (knobs.nosniff) h['x-content-type-options'] = 'nosniff'
      if (knobs.cache404 && status === 404) h['cache-control'] = 'max-age=600'
      if (knobs.pngTtl && file.endsWith('.png')) { h['cache-control'] = 'max-age=14400'; h['cf-cache-status'] = 'MISS' }
      if (knobs.noindex) h['x-robots-tag'] = 'noindex'
      res.writeHead(status, h)
      res.end(body)
    }
    const redirect = (status, to, acao = true) => {
      res.writeHead(status, { location: to, 'content-type': 'text/html', ...(acao ? base : {}) })
      res.end('moved')
    }
    if (knobs.pagesHtml && p.endsWith('.html')) return redirect(308, p.slice(0, -5), !!knobs.pagesHtmlAcao)
    const f = join(tree, p)
    if (p.endsWith('/') && existsSync(join(f, 'index.html'))) return send(200, join(f, 'index.html'))
    if (existsSync(f) && statSync(f).isDirectory()) {
      if (existsSync(join(f, 'index.html'))) return redirect(301, `http://${req.headers.host}${p}/`)
      return send(404, join(tree, '404.html'))
    }
    if (existsSync(f) && !p.includes('_headers')) return send(200, f)
    if (existsSync(f + '.html')) return send(200, f + '.html')
    return send(404, join(tree, '404.html'))
  })
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)))

const live = site()
const liveUrl = await listen(live)
const quiet = () => {}
async function run(knobs, opts = {}) {
  const cand = site(knobs)
  const candUrl = await listen(cand)
  try {
    return await verifySite({ tree, base: liveUrl, candidate: candUrl, jwk, log: quiet, ...opts })
  } finally { cand.close() }
}
const has = (r, re) => r.failures.some((f) => re.test(f))

try {
  console.log('url plan')
  const plan = urlPlan(['index.html', 'help/index.html', 'hello.bento.html', 'releases/slides/manifest.json', '_headers'])
  const paths = plan.map((p) => p.path)
  ok(paths.includes('/') && paths.includes('/help/') && paths.includes('/help'), 'root and directory index, with and without the slash')
  ok(paths.includes('/hello.bento'), 'extensionless .html')
  ok(paths.includes('/releases/') && paths.includes('/releases/slides/'), 'directories without an index')
  ok(!paths.includes('/_headers'), 'host config files are not served URLs')
  ok(plan.some((p) => p.kind === 'missing'), 'a 404 probe')

  console.log('release key from the kernel')
  const real = releaseJwk()
  ok(real.kty === 'EC' && real.crv === 'P-256' && real.x.length === 43 && real.y.length === 43 && real.x !== real.y, 'PUBLIC_KEY_JWK parses to a P-256 point')

  console.log('positive control: an identical candidate')
  const same = await run({})
  ok(same.failures.length === 0, `no differences (${same.failures.join('; ') || 'none'})`)
  ok(same.notes.filter((n) => /shell matches its pin/.test(n)).length === 2, 'the update path RAN on both hosts and matched the shell pin')
  ok(same.notes.filter((n) => /1 pack\(s\) match their pins/.test(n)).length === 2, 'the pack index verified and its pack matched, on both hosts')
  ok(same.checked >= 15, `checked ${same.checked} URLs`)

  console.log('mutants')
  let r = await run({ pagesHtml: true })
  ok(has(r, /^\/hello\.bento\.html: status 200 → 308/), '.html → extensionless 308 redirect is a status difference')
  ok(has(r, /update path .*shell: no CORS grant/), 'a redirect hop without a CORS grant breaks the update path')
  r = await run({ pagesHtml: true, pagesHtmlAcao: true })
  ok(has(r, /status 200 → 308/) && !has(r, /update path/), 'with a CORS grant on the redirect the update still works — but the status difference still fails')
  r = await run({ noAcaoJson: true })
  ok(has(r, /manifest\.json: access-control-allow-origin: \* → \(absent\)/), 'a manifest without the CORS grant fails the header compare')
  ok(has(r, /update path .*manifest\.json: no CORS grant/), '… and the update path')
  r = await run({ nosniff: true })
  ok(has(r, /x-content-type-options: \(absent\) → nosniff/), 'a security header the live site does not send fails')
  r = await run({ tamper: true })
  ok(has(r, /served sha256 .* ≠ tree/), 'a one-byte shell change fails served-bytes')
  ok(has(r, /shell: sha256 does not match the signed pin/), '… and the signed pin')
  r = await run({ cache404: true })
  ok(has(r, /__bento-verify-site-missing: cache-control: \(absent\) → max-age=600/), 'a cacheable 404 is a difference')
  r = await run({ cache404: true }, { allow: [/^\/__bento-verify-site-missing: cache-control/] })
  ok(r.accepted.length === 1 && r.failures.length > 0 && r.failures.every((f) => /cache-control: \(absent\) → max-age=600/.test(f)), '--allow accepts exactly what it names; the other 404s still fail')
  r = await run({ noindex: true })
  ok(has(r, /x-robots-tag/), 'noindex fails without --preview')
  r = await run({ noindex: true }, { preview: true })
  ok(!has(r, /x-robots-tag/) && r.expected.some((e) => /x-robots-tag/.test(e)), '… and is EXPECTED with --preview')

  console.log('preview: the zone rewrites Cache-Control only on what it caches')
  const c = compareResponses(
    { status: 200, sha: 'a', headers: { 'cache-control': 'max-age=14400' }, cfCache: 'MISS' },
    { status: 200, sha: 'a', headers: { 'cache-control': 'max-age=600' }, cfCache: null },
    { aOrigin: 'https://a', bOrigin: 'https://b', preview: true })
  ok(c.fails.length === 0 && c.expected.length === 1, 'zone-cached Cache-Control difference is expected on a preview')
  const d = compareResponses(
    { status: 200, sha: 'a', headers: { 'cache-control': 'max-age=600' }, cfCache: 'DYNAMIC' },
    { status: 200, sha: 'a', headers: { 'cache-control': 'public, max-age=0, must-revalidate' }, cfCache: null },
    { aOrigin: 'https://a', bOrigin: 'https://b', preview: true })
  ok(d.fails.length === 1, 'an uncached (DYNAMIC) Cache-Control difference still fails on a preview')
  const e = compareResponses(
    { status: 301, sha: 'a', headers: { location: 'https://bento.page/help/' } },
    { status: 301, sha: 'b', headers: { location: '/help/' } },
    { aOrigin: 'https://bento.page', bOrigin: 'https://x.pages.dev', preview: false })
  ok(e.fails.length === 0, 'Location compares as a path on its own host')
  const g = compareResponses(
    { status: 301, sha: 'a', headers: { location: 'https://bento.page/help/' } },
    { status: 301, sha: 'b', headers: { location: '/help' } },
    { aOrigin: 'https://bento.page', bOrigin: 'https://x.pages.dev', preview: false })
  ok(g.fails.length === 1, '… and a different path fails')

  console.log('a tampered envelope')
  const good = readFileSync(join(tree, 'releases/slides/manifest.json'), 'utf8')
  const env = JSON.parse(good)
  env.payload = env.payload.replace('1.0.0', '9.9.9')
  writeFileSync(join(tree, 'releases/slides/manifest.json'), JSON.stringify(env))
  r = await run({})
  ok(has(r, /manifest\.json: signature INVALID/), 'a payload edited after signing fails verification')
  writeFileSync(join(tree, 'releases/slides/manifest.json'), good)
} finally {
  live.close()
  rmSync(tree, { recursive: true, force: true })
}

console.log(`\n${pass}/${pass + fail} checks passed`)
process.exit(fail ? 1 : 0)
