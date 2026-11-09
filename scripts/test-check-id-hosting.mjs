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
//     same-origin-allow-popups, the sign-in host on COOP unsafe-none, a strict
//     CSP joined with a looser second policy, an apex that answers 200 HTML
//     for any path.
//   · MUTANTS: each plants one hosting defect, and must fail EXACTLY its row
//     (every other row still passes, so a row can't be failing for luck);
//     a missing CSP is named for both rows it breaks.
//   · LIVE: a host that never answers fails 'reachable' unless allowed, and a
//     vacuous row does not pass silently.
//   · ZONE: zone listings (BIND export, provider JSON) with only the rp and
//     the sign-in host pass; an explicit extra name, a wildcard, a DNAME, an
//     unlisted delegation and another zone's listing each fail zone-names. An
//     explicit name PASSES the DNS row (it sees wildcards only, the reason the
//     listing exists) and fails the zone row. A live run with no listing fails.
//   · REPO: the real tree passes the repo rows, with files actually scanned,
//     and fixture trees with an association on the apex fail them.
//   · SHARED RULES: the functions in scripts/lib/id-hosting-rules.mjs, row by
//     row, so a caller that imports them gets the same answers.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_HOSTS, ROWS, evaluate, gather, repoRows, scanApexTree, zoneRows } from './check-id-hosting.mjs'
import { coopProblem, framingProblem, parseZoneListing, rpHtmlCspProblem, webauthnFileServed, zoneProblems } from './lib/id-hosting-rules.mjs'

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
// The directory's own header set: no script at all, unframeable
const NO_SCRIPT = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
const HOME_H = { 'content-type': 'text/html', 'content-security-policy': "frame-ancestors 'none'" }

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
  w.set(`https://${H.home}/`, { status: 200, headers: HOME_H, body: '<!doctype html>' })
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
  const voidPath = opts.voidPath === undefined ? '/void' : opts.voidPath
  const obs = await gather(H, { ...fakeNet(world, seen), label: 'abc123', voidPath })
  return { rows: evaluate(obs, { live: true, voidPath, ...opts }), seen, obs }
}
const failed = (rows) => rows.filter((r) => r.fails.length).map((r) => r.id)

// ---- control --------------------------------------------------------------------
console.log('control: a conforming world')
{
  const { rows, seen, obs } = await run(goodWorld())
  ok(failed(rows).length === 0, `every row passes (failed: ${failed(rows).join(', ') || 'none'})`)
  for (const id of [...ROWS.map((x) => x.id), 'reachable']) {
    const r = rows.find((x) => x.id === id)
    ok(r && r.checked > 0, `${id} looked at something (${r?.checked})`)
  }
  ok(seen.length >= 14 && seen.every((s) => s.redirect === 'manual'), `gatherer: ${seen.length} fetches, every one with redirect "manual" (a followed redirect would hide a 3xx)`)
  for (const u of [`https://${H.rp}/.well-known/webauthn`, `https://${H.signin}/.well-known/webauthn`, `https://${H.apex}/.well-known/apple-app-site-association`, `https://${H.apex}/.well-known/assetlinks.json`, `https://${H.home}/`, `https://${H.rp}/void`, `https://${H.rp}/bento-probe-abc123`, `https://${H.rp}/v1/bento-probe-abc123`, `https://${H.rp}/v1/keys`])
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
  g.w.set(`https://${H.home}/`, { status: 200, headers: { ...HOME_H, 'cross-origin-opener-policy': 'same-origin-allow-popups' }, body: '' })
  ok(failed((await run(g)).rows).length === 0, 'home on COOP same-origin-allow-popups passes')
}
{
  const g = goodWorld()
  g.w.set(`https://${H.signin}/`, { status: 200, headers: { ...HTML_H, 'cross-origin-opener-policy': 'unsafe-none' }, body: '' })
  ok(failed((await run(g)).rows).length === 0, 'the sign-in host on COOP unsafe-none passes')
}
{
  const g = goodWorld()
  g.w.set(`https://${H.rp}/void`, { status: 200, headers: { 'content-type': 'text/html', 'content-security-policy': `default-src *; script-src * 'unsafe-inline', ${R10}`, 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', ...PP }, body: '' })
  ok(failed((await run(g)).rows).length === 0, "a strict void-page policy beside a loose one passes (every policy is enforced)")
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
  ['rp 404 page in HTML with a script-running CSP (API 404s are HTML too)', ['rp-html-csp', 'rp-api-json'], (g) => { const f = g.fallback; g.fallback = (u) => (new URL(u).host === H.rp ? { status: 404, headers: { 'content-type': 'text/html', ...PP, 'content-security-policy': "frame-ancestors 'none'; default-src 'self'; script-src 'self' 'unsafe-inline'", 'x-frame-options': 'DENY' }, body: '<p>' } : f(u)) }],
  ['rp JSON without nosniff', 'rp-nosniff', (g) => g.w.set(`https://${H.rp}/v1/keys`, { status: 200, headers: { 'content-type': 'application/json', ...PP }, body: '{}' })],
  ['rp response without Permissions-Policy', 'rp-permissions', (g) => g.w.set(`https://${H.rp}/v1/keys`, { status: 200, headers: JSON_H, body: '{}' })],
  ['rp Permissions-Policy that leaves create on', 'rp-permissions', (g) => g.w.set(`https://${H.rp}/v1/keys`, { status: 200, headers: { ...JSON_H, 'permissions-policy': 'publickey-credentials-get=()' }, body: '{}' })],
  ['sign-in host without frame-ancestors', 'no-framing', (g) => g.w.set(`https://${H.signin}/`, { status: 200, headers: { ...HTML_H, 'content-security-policy': "default-src 'none'; script-src 'self'" }, body: '' })],
  ['sign-in host frame-ancestors self', 'no-framing', (g) => g.w.set(`https://${H.signin}/`, { status: 200, headers: { ...HTML_H, 'content-security-policy': "default-src 'none'; frame-ancestors 'self'" }, body: '' })],
  ['rp void page without X-Frame-Options', 'no-framing', (g) => g.w.set(`https://${H.rp}/void`, { status: 200, headers: { 'content-type': 'text/html', 'content-security-policy': R10, 'x-content-type-options': 'nosniff', ...PP }, body: '' })],
  ['sign-in host on COOP same-origin', 'signin-no-coop', (g) => g.w.set(`https://${H.signin}/`, { status: 200, headers: { ...HTML_H, 'cross-origin-opener-policy': 'same-origin' }, body: '' })],
  ['sign-in host on COOP same-origin-allow-popups (cuts its opener too)', 'signin-no-coop', (g) => g.w.set(`https://${H.signin}/`, { status: 200, headers: { ...HTML_H, 'cross-origin-opener-policy': 'same-origin-allow-popups' }, body: '' })],
  ['sign-in host 404 on COOP same-origin-allow-popups', 'signin-no-coop', (g) => { const f = g.fallback; g.fallback = (u) => (new URL(u).host === H.signin ? { status: 404, headers: { ...HTML_H, 'cross-origin-opener-policy': 'Same-Origin-Allow-Popups' }, body: '' } : f(u)) }],
  ['home on COOP same-origin with a report-to', 'home-coop', (g) => g.w.set(`https://${H.home}/`, { status: 200, headers: { ...HOME_H, 'cross-origin-opener-policy': 'same-origin; report-to="coop"' }, body: '' })],
  ['home on COOP noopener-allow-popups', 'home-coop', (g) => g.w.set(`https://${H.home}/`, { status: 200, headers: { ...HOME_H, 'cross-origin-opener-policy': 'noopener-allow-popups' }, body: '' })],
  ['home without frame-ancestors', 'no-framing', (g) => g.w.set(`https://${H.home}/`, { status: 200, headers: { 'content-type': 'text/html' }, body: '' })],
  ["home with frame-ancestors 'self'", 'no-framing', (g) => g.w.set(`https://${H.home}/`, { status: 200, headers: { 'content-type': 'text/html', 'content-security-policy': "frame-ancestors 'self'" }, body: '' })],
  ['sign-in host on X-Frame-Options SAMEORIGIN', 'no-framing', (g) => g.w.set(`https://${H.signin}/`, { status: 200, headers: { ...HTML_H, 'x-frame-options': 'SAMEORIGIN' }, body: '' })],
  ["void page script-src 'self' 'unsafe-inline'", 'rp-html-csp', (g) => g.w.set(`https://${H.rp}/void`, { status: 200, headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'", 'x-frame-options': 'DENY', ...PP }, body: '' })],
  ['void page script by hash (inline, which the void page may not run)', 'rp-html-csp', (g) => g.w.set(`https://${H.rp}/void`, { status: 200, headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'; script-src 'self' 'sha256-AAAA'; frame-ancestors 'none'", 'x-frame-options': 'DENY', ...PP }, body: '' })],
  ["void page default-src 'self'", 'rp-html-csp', (g) => g.w.set(`https://${H.rp}/void`, { status: 200, headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; script-src 'self'; frame-ancestors 'none'", 'x-frame-options': 'DENY', ...PP }, body: '' })],
  ['void page script-src-attr opens inline handlers', 'rp-html-csp', (g) => g.w.set(`https://${H.rp}/void`, { status: 200, headers: { 'content-type': 'text/html', 'content-security-policy': `${R10}; script-src-attr 'unsafe-inline'`, 'x-frame-options': 'DENY', ...PP }, body: '' })],
  ['void page CSP only report-only', ['rp-html-csp', 'no-framing'], (g) => g.w.set(`https://${H.rp}/void`, { status: 200, headers: { 'content-type': 'text/html', 'content-security-policy-report-only': R10, 'x-frame-options': 'DENY', ...PP }, body: '' })],
  ['the named void page answers JSON 404 (gone)', 'rp-html-csp', (g) => g.w.delete(`https://${H.rp}/void`)],
  ["another rp HTML page with script-src 'self' (only the void page may run script)", 'rp-html-csp', (g) => g.w.set(`https://${H.rp}/`, { status: 200, headers: { 'content-type': 'text/html', 'content-security-policy': R10, 'x-frame-options': 'DENY', ...PP }, body: '' })],
  ['rp API answers text/plain', 'rp-api-json', (g) => g.w.set(`https://${H.rp}/v1/keys`, { status: 200, headers: { 'content-type': 'text/plain', 'x-content-type-options': 'nosniff', ...PP }, body: '{}' })],
  ['rp unknown API path answers HTML (with the strict CSP)', 'rp-api-json', (g) => g.w.set(`https://${H.rp}/v1/bento-probe-abc123`, { status: 404, headers: { 'content-type': 'text/html', 'content-security-policy': NO_SCRIPT, 'x-frame-options': 'DENY', ...PP }, body: '<p>' })],
  ['a wildcard under id.bento.page', 'no-wildcard-under-rp', (g) => g.resolves.add(`*.${H.rp}`)],
  ['www.id.bento.page resolves', 'no-wildcard-under-rp', (g) => g.resolves.add(`www.${H.rp}`)],
  ['a wildcard under the sign-in host', 'no-wildcard-under-rp', (g) => g.resolves.add(`*.${H.signin}`)],
  ['apex serves AASA webcredentials', 'apex-no-association', (g) => g.w.set(`https://${H.apex}/.well-known/apple-app-site-association`, { status: 200, headers: { 'content-type': 'application/json' }, body: '{"webcredentials":{"apps":["X.page.bento.home"]}}' })],
  ['apex serves assetlinks get_login_creds', 'apex-no-association', (g) => g.w.set(`https://${H.apex}/.well-known/assetlinks.json`, { status: 200, headers: { 'content-type': 'application/json' }, body: '[{"relation":["delegate_permission/common.get_login_creds"]}]' })],
  ['apex serves a webauthn origins list', 'apex-no-association', (g) => g.w.set(`https://${H.apex}/.well-known/webauthn`, { status: 200, headers: { 'content-type': 'application/json' }, body: '{"origins": ["https://x.example"]}' })],
  ['apex redirects the AASA to the rp', 'apex-no-association', (g) => g.w.set(`https://${H.apex}/.well-known/apple-app-site-association`, { status: 301, headers: { location: `https://${H.rp}/.well-known/apple-app-site-association` }, body: '' })],
  ['the sign-in host never answers (its COOP row refuses to pass on nothing)', ['reachable', 'signin-no-coop'], (g) => g.down.add(H.signin)],
  ['bento/home never answers', ['reachable', 'home-coop'], (g) => g.down.add(H.home)],
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
  const g = goodWorld(); g.down.add(H.signin); g.down.add(H.home)
  const f = failed((await run(g, { allowUnreachable: ['signin', 'home'] })).rows)
  ok(f.length === 0, `sign-in host and home down but allowed (not deployed yet) → no row fails (${f.join(', ') || 'none'})`)
}
{
  const g = goodWorld()
  const { rows } = await run(g, { voidPath: null })
  ok(failed(rows).length === 0 && rows.find((r) => r.id === 'rp-html-csp').checked === 0, 'no void page named and none probed → rp-html-csp has nothing to look at and may pass (the directory serves no HTML today)')
}
{
  const notLive = evaluate([], {})
  ok(failed(notLive).includes('rp-no-webauthn') && failed(notLive).includes('apex-no-association'), 'no observations → rows that must look at something fail')
}

// ---- zone listing ---------------------------------------------------------------------
console.log('zone')
const BIND_OK = `;; Domain:     bento.page.
$ORIGIN bento.page.
@	3600	IN	SOA	ns1.example. hostmaster.example. (
		2026110901 10000 2400 604800 3600 )
bento.page.	1	IN	A	192.0.2.1 ; cf_tags=cf-proxied:true
id.bento.page.	1	IN	A	192.0.2.2
id	1	IN	AAAA	2001:db8::2
signin.id.bento.page.	1	IN	CNAME	bento-id-signin.example.
_acme-challenge.id.bento.page.	300	IN	TXT	"a;b"
id.bento.page.	300	IN	CAA	0 issue "letsencrypt.org"
home.bento.page.	1	IN	CNAME	home.example.
`
const zoneFail = (listings) => zoneRows(listings, { live: true }).filter((r) => r.fails.length).map((r) => r.id)
{
  const recs = parseZoneListing(BIND_OK)
  ok(recs.length === 8 && recs.some((r) => r.name === 'id.bento.page' && r.type === 'AAAA') && recs.some((r) => r.name === 'bento.page' && r.type === 'SOA'), `BIND export parsed: 8 records, a relative name joined to $ORIGIN, a multi-line SOA (${recs.map((r) => r.name + ' ' + r.type).join(', ')})`)
  const z = zoneRows([{ label: 'bind', text: BIND_OK }], { live: true })
  ok(zoneFail([{ label: 'bind', text: BIND_OK }]).length === 0 && z.find((r) => r.id === 'zone-names').checked === 5, `a listing with only the rp and the sign-in host (and inert TXT/CAA) passes, 5 records under the rp looked at (${z.map((r) => r.fails.join('; ')).join('') || 'clean'})`)
  const api = JSON.stringify({ result: [{ name: 'id.bento.page', type: 'A' }, { name: 'signin.id.bento.page', type: 'AAAA' }, { name: 'bento.page', type: 'A' }] })
  ok(zoneFail([{ label: 'api', text: api }]).length === 0, 'provider API JSON ({result: [...]}) with only the rp and the sign-in host passes')
}
const ZONE_MUTANTS = [
  ['an explicit test.id.bento.page A', 'test.id.bento.page.\t1\tIN\tA\t192.0.2.9'],
  ['an explicit x.signin.id.bento.page CNAME', 'x.signin.id.bento.page.\t1\tIN\tCNAME\televsewhere.example.'],
  ['a wildcard *.id.bento.page A', '*.id.bento.page.\t1\tIN\tA\t192.0.2.9'],
  ['a relative www.id under $ORIGIN', 'www.id\t1\tIN\tCNAME\tbento.page.'],
  ['a DNAME on the sign-in host', 'signin.id.bento.page.\t1\tIN\tDNAME\televsewhere.example.'],
  ['an HTTPS record on an extra name', 'api.id.bento.page.\t1\tIN\tHTTPS\t1 . alpn=h2'],
  ['an unknown type on an extra name', 'odd.id.bento.page.\t1\tIN\tTYPE65534\t\\# 0'],
  ['a delegated id.bento.page whose zone is not listed', 'id.bento.page.\t1\tIN\tNS\tns.example.'],
]
for (const [name, line] of ZONE_MUTANTS) {
  const f = zoneFail([{ label: 'bind', text: `${BIND_OK}${line}\n` }])
  ok(f.length === 1 && f[0] === 'zone-names', `${name} → fails zone-names only (failed: ${f.join(', ') || 'nothing'})`)
}
{
  const parent = `${BIND_OK}id.bento.page.\t1\tIN\tNS\tns.example.\n`
  const child = 'id.bento.page. 3600 IN SOA ns.example. h.example. 1 2 3 4 5\nid.bento.page. 3600 IN NS ns.example.\nsignin.id.bento.page. 1 IN A 192.0.2.3\n'
  ok(zoneFail([{ label: 'parent', text: parent }, { label: 'child', text: child }]).length === 0, "a delegated id.bento.page passes once its own zone's listing is given too")
  const childBad = `${child}stage.id.bento.page. 1 IN A 192.0.2.4\n`
  ok(zoneFail([{ label: 'parent', text: parent }, { label: 'child', text: childBad }]).join() === 'zone-names', 'and an extra name inside the delegated zone fails it')
}
{
  const other = 'example.org. 1 IN A 192.0.2.1\nwww.example.org. 1 IN A 192.0.2.1\n'
  ok(zoneFail([{ label: 'other', text: other }]).join() === 'zone-names', "another zone's listing (nothing for id.bento.page) fails rather than pass on nothing")
  ok(zoneFail([{ label: 'junk', text: 'this is not a zone\n' }]).join() === 'zone-names', 'an unreadable listing fails')
  ok(zoneFail([]).join() === 'zone-listing', 'a live run with no --zone fails zone-listing')
  ok(zoneRows([], { live: false }).length === 0, 'a repo run with no --zone adds no zone rows')
}
{
  // C4 in one picture: an explicit name passes the DNS row and fails the zone row
  const g = goodWorld(); g.resolves.add(`test.${H.rp}`)
  const dns = failed((await run(g)).rows)
  const zone = zoneFail([{ label: 'bind', text: `${BIND_OK}test.id.bento.page. 1 IN A 192.0.2.9\n` }])
  ok(dns.length === 0 && zone.join() === 'zone-names', `an explicit test.id.bento.page: the DNS rows pass (${dns.join(', ') || 'none failed'}), the zone row fails (${zone.join(', ')})`)
}

{
  // the command line, as the deploy steps run it: --zone reaches main() and sets the exit code
  const d = mkdtempSync(join(tmpdir(), 'idzone-'))
  const good = join(d, 'good.zone'), bad = join(d, 'bad.zone')
  writeFileSync(good, BIND_OK)
  writeFileSync(bad, `${BIND_OK}test.id.bento.page.\t1\tIN\tA\t192.0.2.9\n`)
  const cli = fileURLToPath(new URL('./check-id-hosting.mjs', import.meta.url))
  const g = spawnSync(process.execPath, [cli, '--zone', good], { encoding: 'utf8' })
  ok(g.status === 0 && /ok +zone-names/.test(g.stdout), `CLI --zone with a clean listing exits 0 and prints the zone row (exit ${g.status})`)
  const b = spawnSync(process.execPath, [cli, '--zone', bad], { encoding: 'utf8' })
  ok(b.status === 1 && /FAIL +zone-names/.test(b.stdout) && b.stdout.includes('test.id.bento.page'), `CLI --zone with an extra name exits 1 and names it (exit ${b.status})`)
  rmSync(d, { recursive: true, force: true })
}

// ---- shared rules, called directly -----------------------------------------------------
console.log('shared rules')
{
  const R10v = "default-src 'none'; script-src 'self'"
  const cases = [
    [coopProblem('signin', undefined), false, 'signin, no COOP'],
    [coopProblem('signin', 'unsafe-none'), false, 'signin, unsafe-none'],
    [!!coopProblem('signin', 'same-origin-allow-popups'), true, 'signin, same-origin-allow-popups'],
    [!!coopProblem('signin', 'same-origin'), true, 'signin, same-origin'],
    [coopProblem('home', 'same-origin-allow-popups; report-to="x"'), false, 'home, same-origin-allow-popups with a report-to'],
    [!!coopProblem('home', 'same-origin'), true, 'home, same-origin'],
    [rpHtmlCspProblem(R10v, { isVoid: true }), false, 'void, R10'],
    [!!rpHtmlCspProblem(R10v), true, 'non-void, R10 (script allowed)'],
    [rpHtmlCspProblem(NO_SCRIPT), false, "non-void, default-src 'none' and nothing else"],
    [!!rpHtmlCspProblem("default-src 'none'; script-src-elem 'self'"), true, 'non-void, script-src-elem opens script'],
    [!!rpHtmlCspProblem("script-src 'self'", { isVoid: true }), true, 'void, no default-src'],
    [!!rpHtmlCspProblem("default-src 'none'; script-src 'self' https://cdn.example", { isVoid: true }), true, 'void, script from another host'],
    [!!rpHtmlCspProblem("default-src 'none'; script-src 'self' 'nonce-abc'", { isVoid: true }), true, 'void, nonce'],
    [!!rpHtmlCspProblem("default-src 'none'; script-src 'self' 'unsafe-eval'", { isVoid: true }), true, 'void, eval'],
    [!!rpHtmlCspProblem(''), true, 'no CSP'],
    [framingProblem("frame-ancestors 'none'", 'DENY'), false, "frame-ancestors 'none' + DENY"],
    [framingProblem("frame-ancestors 'none'", undefined, { requireXfo: false }), false, "home: frame-ancestors 'none' alone"],
    [!!framingProblem("frame-ancestors 'none'", undefined), true, 'XFO required and absent'],
    [!!framingProblem("frame-ancestors 'none' https://x.example", 'DENY'), true, 'frame-ancestors with a host'],
    [webauthnFileServed(404), false, 'webauthn 404'],
    [webauthnFileServed(301), true, 'webauthn redirect'],
  ]
  for (const [got, want, name] of cases) ok(got === want, `${name} → ${want ? 'a problem' : 'holds'}`)
  ok(zoneProblems([{ name: 'id.bento.page', type: 'A' }, { name: 'x.id.bento.page', type: 'TXT' }]).fails.length === 0, 'zoneProblems: an inert TXT on another name holds')
  ok(zoneProblems([{ name: 'id.bento.page', type: 'A' }, { name: 'x.id.bento.page', type: 'CNAME' }]).fails.length === 1, 'zoneProblems: a CNAME on another name fails')
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
