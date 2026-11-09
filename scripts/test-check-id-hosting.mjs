#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Rig for scripts/check-id-hosting.mjs, the hosting rules around the bento/id
// relying party (id.bento.page, its sign-in host, home.bento.page, bento.page).
//
//   node scripts/test-check-id-hosting.mjs
//
// WHAT THIS PROVES. The check's GATHERER and its RULES, together, against a
// fake network: gather() is driven through its fetch/resolve seams, so a probe
// that asks the wrong URL, follows a redirect, or loses a header fails here.
//   · CONTROL: a world that hosts everything correctly passes every row, and
//     every row that must look at something did look (checked > 0).
//   · LEGITIMATE VARIANTS that must also pass: home on COOP
//     same-origin-allow-popups, an apex that answers 200 HTML for any path.
//   · MUTANTS: each plants one hosting defect, and must fail EXACTLY its row
//     (every other row still passes, so a row can't be failing for luck);
//     a missing CSP is named for both rows it breaks.
//   · LIVE: a host that never answers fails 'reachable' unless allowed, and a
//     vacuous row does not pass silently.
//   · REPO: the real tree passes the repo rows, with files actually scanned,
//     and fixture trees with an association on the apex fail them.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_HOSTS, ROWS, evaluate, gather, repoRows, scanApexTree } from './check-id-hosting.mjs'

let failures = 0, checks = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const H = DEFAULT_HOSTS
const JSON_H = { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' }
const PP = { 'permissions-policy': 'publickey-credentials-get=(), publickey-credentials-create=()' }
const R10 = "default-src 'none'; script-src 'self'; frame-ancestors 'none'"
const HTML_H = { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': R10, 'x-frame-options': 'DENY' }

/** A conforming world: url → {status, headers, body}; anything else is a 404 of the host's kind. */
function goodWorld() {
  const w = new Map()
  const rpJson = (status, body) => ({ status, headers: { ...JSON_H, ...PP }, body: JSON.stringify(body) })
  w.set(`https://${H.rp}/`, rpJson(404, { error: 'not-found' }))
  w.set(`https://${H.rp}/v1/keys`, rpJson(200, { keys: [] }))
  w.set(`https://${H.rp}/void`, { status: 200, headers: { ...HTML_H, ...PP, 'x-content-type-options': 'nosniff' }, body: '<!doctype html><title>void</title>' })
  w.set(`https://${H.rp}/.well-known/apple-app-site-association`, rpJson(200, { webcredentials: { apps: ['AB12CD34EF.page.bento.home'] } }))
  w.set(`https://${H.rp}/.well-known/assetlinks.json`, rpJson(200, [{ relation: ['delegate_permission/common.get_login_creds'] }]))
  w.set(`https://${H.signin}/`, { status: 200, headers: HTML_H, body: '<!doctype html><title>Sign in</title>' })
  w.set(`https://${H.home}/`, { status: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html>' })
  const fallback = (url) => {
    const host = new URL(url).host
    if (host === H.rp) return rpJson(404, { error: 'not-found' })
    if (host === H.signin) return { status: 404, headers: HTML_H, body: '<!doctype html><title>404</title>' }
    return { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html><title>404 deck</title>' }
  }
  return { w, fallback, resolves: new Set(), down: new Set() }
}

function fakeNet(world, seen) {
  const fetchImpl = async (url, init) => {
    seen.push({ url, redirect: init?.redirect })
    const host = new URL(url).host
    if (world.down.has(host)) { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e }
    const r = world.w.get(url) ?? world.fallback(url)
    return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers })
  }
  const resolveImpl = async (host) => {
    if (world.resolves.has(host) || [...world.resolves].some((p) => p.startsWith('*.') && host.endsWith(p.slice(1)))) return [{ address: '192.0.2.7', family: 4 }]
    const e = new Error(`getaddrinfo ENOTFOUND ${host}`); e.code = 'ENOTFOUND'; throw e
  }
  return { fetchImpl, resolveImpl }
}

async function run(world, opts = {}) {
  const seen = []
  const obs = await gather(H, { ...fakeNet(world, seen), label: 'abc123', extraPaths: [{ role: 'rp', path: '/void' }] })
  return { rows: evaluate(obs, { live: true, ...opts }), seen, obs }
}
const failed = (rows) => rows.filter((r) => r.fails.length).map((r) => r.id)

// ---- control --------------------------------------------------------------------
console.log('control: a conforming world')
{
  const { rows, seen, obs } = await run(goodWorld())
  ok(failed(rows).length === 0, `every row passes (failed: ${failed(rows).join(', ') || 'none'})`)
  for (const id of ['rp-no-webauthn', 'signin-no-webauthn', 'rp-html-csp', 'rp-nosniff', 'rp-permissions', 'no-framing', 'no-coop-same-origin', 'only-signin-under-rp', 'apex-no-association', 'reachable']) {
    const r = rows.find((x) => x.id === id)
    ok(r && r.checked > 0, `${id} looked at something (${r?.checked})`)
  }
  ok(seen.length >= 14 && seen.every((s) => s.redirect === 'manual'), `gatherer: ${seen.length} fetches, every one with redirect "manual" (a followed redirect would hide a 3xx)`)
  for (const u of [`https://${H.rp}/.well-known/webauthn`, `https://${H.signin}/.well-known/webauthn`, `https://${H.apex}/.well-known/apple-app-site-association`, `https://${H.apex}/.well-known/assetlinks.json`, `https://${H.home}/`, `https://${H.rp}/void`, `https://${H.rp}/bento-probe-abc123`])
    ok(seen.some((s) => s.url === u), `gatherer asked ${u}`)
  const labels = obs.filter((o) => o.role === 'label').map((o) => o.host)
  ok(labels.includes(`xabc123.${H.rp}`) && labels.includes(`www.${H.rp}`) && labels.includes(`xabc123.${H.signin}`), `gatherer resolved ${labels.join(', ')}`)
  const v = obs.find((o) => o.url === `https://${H.rp}/void`)
  ok(v?.headers['content-security-policy'] === R10 && v?.headers['x-frame-options'] === 'DENY', 'gatherer keeps headers, keyed lowercase')
}

// ---- legitimate variants ---------------------------------------------------------
console.log('variants that must pass')
{
  const g = goodWorld()
  g.w.set(`https://${H.home}/`, { status: 200, headers: { 'content-type': 'text/html', 'cross-origin-opener-policy': 'same-origin-allow-popups' }, body: '' })
  ok(failed((await run(g)).rows).length === 0, 'home on COOP same-origin-allow-popups passes')
}
{
  const g = goodWorld()
  for (const p of ['apple-app-site-association', 'assetlinks.json', 'webauthn']) g.w.set(`https://${H.apex}/.well-known/${p}`, { status: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html><p>a page</p>' })
  ok(failed((await run(g)).rows).length === 0, 'an apex answering 200 HTML with no association content passes')
}

// ---- mutants: each must fail exactly its row ------------------------------------
console.log('mutants')
const rpJsonOk = { ...JSON_H, ...PP }
const MUTANTS = [
  ['rp serves /.well-known/webauthn', 'rp-no-webauthn', (g) => g.w.set(`https://${H.rp}/.well-known/webauthn`, { status: 200, headers: rpJsonOk, body: '{"origins":["https://home.bento.page"]}' })],
  ['rp redirects /.well-known/webauthn', 'rp-no-webauthn', (g) => g.w.set(`https://${H.rp}/.well-known/webauthn`, { status: 302, headers: { ...rpJsonOk, location: 'https://bento.page/x' }, body: '' })],
  ['sign-in host serves /.well-known/webauthn', 'signin-no-webauthn', (g) => g.w.set(`https://${H.signin}/.well-known/webauthn`, { status: 200, headers: { 'content-type': 'application/json' }, body: '{"origins":[]}' })],
  ['rp void page without a CSP (so no frame-ancestors either)', ['rp-html-csp', 'no-framing'], (g) => g.w.set(`https://${H.rp}/void`, { status: 200, headers: { 'content-type': 'text/html', 'x-frame-options': 'DENY', ...PP }, body: '<p>' })],
  ['rp 404 page in HTML without a CSP', 'rp-html-csp', (g) => { const f = g.fallback; g.fallback = (u) => (new URL(u).host === H.rp ? { status: 404, headers: { 'content-type': 'text/html', ...PP, 'content-security-policy': "frame-ancestors 'none'; default-src 'self'; script-src 'self' 'unsafe-inline'", 'x-frame-options': 'DENY' }, body: '<p>' } : f(u)) }],
  ['rp JSON without nosniff', 'rp-nosniff', (g) => g.w.set(`https://${H.rp}/v1/keys`, { status: 200, headers: { 'content-type': 'application/json', ...PP }, body: '{}' })],
  ['rp response without Permissions-Policy', 'rp-permissions', (g) => g.w.set(`https://${H.rp}/v1/keys`, { status: 200, headers: JSON_H, body: '{}' })],
  ['rp Permissions-Policy that leaves create on', 'rp-permissions', (g) => g.w.set(`https://${H.rp}/v1/keys`, { status: 200, headers: { ...JSON_H, 'permissions-policy': 'publickey-credentials-get=()' }, body: '{}' })],
  ['sign-in host without frame-ancestors', 'no-framing', (g) => g.w.set(`https://${H.signin}/`, { status: 200, headers: { ...HTML_H, 'content-security-policy': "default-src 'none'; script-src 'self'" }, body: '' })],
  ['sign-in host frame-ancestors self', 'no-framing', (g) => g.w.set(`https://${H.signin}/`, { status: 200, headers: { ...HTML_H, 'content-security-policy': "default-src 'none'; frame-ancestors 'self'" }, body: '' })],
  ['rp void page without X-Frame-Options', 'no-framing', (g) => g.w.set(`https://${H.rp}/void`, { status: 200, headers: { 'content-type': 'text/html', 'content-security-policy': R10, 'x-content-type-options': 'nosniff', ...PP }, body: '' })],
  ['sign-in host on COOP same-origin', 'no-coop-same-origin', (g) => g.w.set(`https://${H.signin}/`, { status: 200, headers: { ...HTML_H, 'cross-origin-opener-policy': 'same-origin' }, body: '' })],
  ['home on COOP same-origin with a report-to', 'no-coop-same-origin', (g) => g.w.set(`https://${H.home}/`, { status: 200, headers: { 'content-type': 'text/html', 'cross-origin-opener-policy': 'same-origin; report-to="coop"' }, body: '' })],
  ['a wildcard under id.bento.page', 'only-signin-under-rp', (g) => g.resolves.add(`*.${H.rp}`)],
  ['www.id.bento.page resolves', 'only-signin-under-rp', (g) => g.resolves.add(`www.${H.rp}`)],
  ['a wildcard under the sign-in host', 'only-signin-under-rp', (g) => g.resolves.add(`*.${H.signin}`)],
  ['apex serves AASA webcredentials', 'apex-no-association', (g) => g.w.set(`https://${H.apex}/.well-known/apple-app-site-association`, { status: 200, headers: { 'content-type': 'application/json' }, body: '{"webcredentials":{"apps":["X.page.bento.home"]}}' })],
  ['apex serves assetlinks get_login_creds', 'apex-no-association', (g) => g.w.set(`https://${H.apex}/.well-known/assetlinks.json`, { status: 200, headers: { 'content-type': 'application/json' }, body: '[{"relation":["delegate_permission/common.get_login_creds"]}]' })],
  ['apex serves a webauthn origins list', 'apex-no-association', (g) => g.w.set(`https://${H.apex}/.well-known/webauthn`, { status: 200, headers: { 'content-type': 'application/json' }, body: '{"origins": ["https://x.example"]}' })],
  ['apex redirects the AASA to the rp', 'apex-no-association', (g) => g.w.set(`https://${H.apex}/.well-known/apple-app-site-association`, { status: 301, headers: { location: `https://${H.rp}/.well-known/apple-app-site-association` }, body: '' })],
  ['the sign-in host never answers', 'reachable', (g) => g.down.add(H.signin)],
]
for (const [name, row, plant] of MUTANTS) {
  const g = goodWorld()
  plant(g)
  const f = failed((await run(g)).rows)
  const want = [row].flat()
  ok(f.length === want.length && want.every((w) => f.includes(w)), `${name} → fails ${want.join(' + ')} only (failed: ${f.join(', ') || 'nothing'})`)
}
const covered = new Set(MUTANTS.flatMap((m) => [m[1]].flat()))
for (const r of [...ROWS.map((x) => x.id), 'reachable']) ok(covered.has(r), `row ${r} has at least one mutant`)

// ---- live: unreachable and vacuous ------------------------------------------------
console.log('live')
{
  const g = goodWorld(); g.down.add(H.rp)
  const { rows } = await run(g)
  const f = failed(rows)
  ok(f.includes('reachable') && f.includes('rp-nosniff') && f.includes('rp-permissions'), `rp down → reachable fails, and its rows refuse to pass vacuously (${f.join(', ')})`)
  const allowed = failed((await run(g, { allowUnreachable: ['rp'] })).rows)
  ok(allowed.length === 0, `rp down but allowed → no row fails (${allowed.join(', ') || 'none'})`)
  const r2 = (await run(g, { allowUnreachable: ['rp'] })).rows.find((r) => r.id === 'reachable')
  ok(r2.notes.some((n) => n.includes(H.rp)), 'the allowance is reported, not silent')
}
{
  const notLive = evaluate([], {})
  ok(failed(notLive).includes('rp-no-webauthn') && failed(notLive).includes('apex-no-association'), 'no observations → rows that must look at something fail')
}

// ---- repo rows ----------------------------------------------------------------------
console.log('repo')
{
  const rows = await repoRows()
  ok(failed(rows).length === 0, `the real tree passes (failed: ${failed(rows).join(', ') || 'none'})`)
  ok(rows.find((r) => r.id === 'apex-sources').checked > 5, `apex sources actually scanned (${rows.find((r) => r.id === 'apex-sources').checked} files)`)
}
function fixture(files) {
  const d = mkdtempSync(join(tmpdir(), 'idhost-'))
  for (const [p, text] of Object.entries(files)) { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), text) }
  return d
}
const cleanApex = { 'index.html': '<!doctype html>', '_headers': '/*\n  Access-Control-Allow-Origin: *\n', '_redirects': '/x /x.html 200\n' }
for (const [name, extra, want] of [
  ['clean staged tree', {}, true],
  ['.well-known/apple-app-site-association', { '.well-known/apple-app-site-association': '{}' }, false],
  ['well-known/assetlinks.json (un-dotted source dir)', { 'well-known/assetlinks.json': '[]' }, false],
  ['a stray webauthn file', { 'x/webauthn': '{}' }, false],
  ['webcredentials inside another file', { 'data.json': '{"webcredentials":{}}' }, false],
  ['_redirects routing /.well-known/', { '_redirects': '/.well-known/* https://id.bento.page/.well-known/:splat 302\n' }, false],
  ['_headers naming /.well-known/', { '_headers': '/.well-known/*\n  Content-Type: application/json\n' }, false],
]) {
  const d = fixture({ ...cleanApex, ...extra })
  const s = scanApexTree(d)
  ok((s.fails.length === 0) === want && s.checked > 0, `staged tree, ${name} → ${want ? 'passes' : 'fails'} (${s.fails[0] || `${s.checked} files clean`})`)
  rmSync(d, { recursive: true, force: true })
}
{
  // the repo rows over a fixture repo: templates moved back onto the apex sources
  const d = fixture({
    'site-src/landing.html': '<!doctype html>', 'site-src/host/_headers': '/*\n',
    'site-src/well-known/apple-app-site-association': '{"webcredentials":{"apps":["__APPLE_TEAM_ID__.page.bento.home"]}}',
    'scripts/well-known.mjs': "export const RP_HOST = 'bento.page'\n",
  })
  const f = failed(await repoRows(d))
  ok(f.includes('apex-sources') && f.includes('rp-templates') && f.includes('one-rp'), `templates back on the apex, rp renamed → apex-sources, rp-templates, one-rp fail (${f.join(', ')})`)
  rmSync(d, { recursive: true, force: true })
}
{
  const d = fixture({
    'site-src/landing.html': '<!doctype html>',
    'site-src/id-host/well-known/apple-app-site-association': '{"webcredentials":{}}', 'site-src/id-host/well-known/assetlinks.json': '[{"relation":["delegate_permission/common.get_login_creds"]}]',
    'scripts/well-known.mjs': "export const RP_HOST = 'id.bento.page'\n",
  })
  const f = failed(await repoRows(d))
  ok(f.length === 0, `a fixture repo with the templates under id-host passes (failed: ${f.join(', ') || 'none'})`)
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
