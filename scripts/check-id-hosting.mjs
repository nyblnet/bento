#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Hosting rules for the bento/id passkey relying party (rp id.bento.page).
//
//   node scripts/check-id-hosting.mjs                 # repo checks (CI)
//   node scripts/check-id-hosting.mjs --site DIR      # + a staged bento.page tree
//   node scripts/check-id-hosting.mjs --zone FILE     # + the zone's records under the rp
//   node scripts/check-id-hosting.mjs --live --zone FILE [--zone FILE2]
//                                     [--signin HOST] [--void /PATH (default /void)] [--path ROLE:/p ...]
//                                     [--allow-unreachable ROLE,ROLE]
//
// The relying party is id.bento.page (the directory host). Exactly one web
// origin runs passkey ceremonies: the sign-in host, a subdomain of the rp
// (default signin.id.bento.page, set with --signin). bento/home on
// home.bento.page asks the sign-in host through a popup. A browser lets ANY
// host under the rp, and any origin a /.well-known/webauthn file on the rp
// lists, create and use the rp's passkeys, and the Signal API can delete them
// with no prompt. The verifier's closed origin list refuses their assertions,
// but nothing refuses a deletion. So these rules are about what is SERVED.
// The rules themselves are in scripts/lib/id-hosting-rules.mjs, shared with the
// sign-in host's own check.
//
//   rp-no-webauthn       id.bento.page serves no /.well-known/webauthn
//   signin-no-webauthn   neither does the sign-in host
//   rp-html-csp          every HTML response from id.bento.page has a CSP of
//                        default-src 'none' and no script; the void page alone
//                        (/void, the directory's; --void PATH overrides) may
//                        load script from 'self' (no inline)
//   rp-api-json          every API response (/v1/, /.well-known/) from
//                        id.bento.page is JSON
//   rp-nosniff           every non-HTML response from id.bento.page is nosniff
//   rp-permissions       every response from id.bento.page sends a
//                        Permissions-Policy that turns off WebAuthn get and create
//   no-framing           frame-ancestors 'none' on every HTML response from
//                        id.bento.page (the void page too), the sign-in host and
//                        bento/home; X-Frame-Options DENY on the first two
//   signin-no-coop       the sign-in host sends no Cross-Origin-Opener-Policy,
//                        or unsafe-none (same-origin-allow-popups ON THE POPUP
//                        cuts its opener too, measured in Chromium)
//   home-coop            bento/home sends at most same-origin-allow-popups
//   no-wildcard-under-rp no wildcard name under id.bento.page or the sign-in
//                        host, and no www (a random label and www are resolved;
//                        a name that resolves fails even if nothing answers).
//                        DNS cannot list explicit names, so this sees
//                        WILDCARDS ONLY: the zone listing below finds the rest
//   apex-no-association  bento.page serves no passkey association: no AASA
//                        webcredentials, no assetlinks get_login_creds, no
//                        webauthn origins list, and no redirect to one
//   reachable            (--live) every host answered, so no row passed by
//                        default; --allow-unreachable names hosts not yet up
//   zone-names           (--zone) the zone listing names nothing under
//                        id.bento.page but id.bento.page and the sign-in host
//   zone-listing         (--live) a zone listing was given: a live run without
//                        one fails, because DNS alone cannot see explicit names
//
// Deploy steps, by hand (the maintainer's): export the zone's records from the
// DNS provider (its dashboard's export, or the API's JSON) to a file outside
// the tree, then run --live with --zone on that file. A delegated name (NS on
// id.bento.page or the sign-in host) needs that zone's listing as a second
// --zone.
//
// Repo checks (no network, run in CI): the bento.page sources and host files
// carry no association file and do not route /.well-known/; the association
// templates are the rp host's (site-src/id-host/); scripts/well-known.mjs
// names the same rp as this file. --site adds the same scan over a staged
// bento.page tree before it is published.
//
// This checks hosting; it deploys nothing and changes no DNS.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import {
  APEX, HOME, NO_WILDCARD, RP, SIGNIN, VOID_PATH, ZONE_LISTING_STEP,
  coopProblem, framingProblem, parseZoneListing, rpHtmlCspProblem, webauthnFileServed, zoneProblems,
} from './lib/id-hosting-rules.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

export { RP }
export const DEFAULT_HOSTS = { rp: RP, signin: SIGNIN, home: HOME, apex: APEX }
const ASSOC_NAMES = ['apple-app-site-association', 'assetlinks.json', 'webauthn']
const ASSOC_CONTENT = /"webcredentials"|get_login_creds|"origins"\s*:/

// ---- gathering -------------------------------------------------------------

/** The probes for a set of hosts: [{role, url}] fetched, [{role, host}] resolved only. */
export function probes(hosts, { extraPaths = [], voidPath = VOID_PATH, label = randomBytes(6).toString('hex') } = {}) {
  const miss = `/bento-probe-${label}`
  const fetches = [
    ...['/', '/.well-known/webauthn', '/.well-known/apple-app-site-association', '/.well-known/assetlinks.json', '/v1/keys', `/v1/bento-probe-${label}`, miss].map((p) => ({ role: 'rp', path: p })),
    ...(voidPath ? [{ role: 'rp', path: voidPath }] : []),
    ...['/', '/.well-known/webauthn', miss].map((p) => ({ role: 'signin', path: p })),
    { role: 'home', path: '/' },
    ...['/.well-known/apple-app-site-association', '/.well-known/assetlinks.json', '/.well-known/webauthn'].map((p) => ({ role: 'apex', path: p })),
    ...extraPaths,
  ].map(({ role, path }) => ({ role, path, url: `https://${hosts[role]}${path}` }))
  const names = [`x${label}.${hosts.rp}`, `www.${hosts.rp}`, `x${label}.${hosts.signin}`].map((host) => ({ role: 'label', host }))
  return { fetches, names }
}

/** Fetch and resolve every probe. fetchImpl/resolveImpl are seams for the rig. */
export async function gather(hosts, { fetchImpl = fetch, resolveImpl = (h) => lookup(h, { all: true }), extraPaths, voidPath, label } = {}) {
  const { fetches, names } = probes(hosts, { extraPaths, voidPath, label })
  const obs = []
  for (const p of fetches) {
    try {
      const res = await fetchImpl(p.url, { redirect: 'manual', signal: AbortSignal.timeout(15000) })
      const headers = {}
      res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })
      let body = ''
      try { body = (await res.text()).slice(0, 65536) } catch { /* */ }
      obs.push({ ...p, status: res.status, headers, body })
    } catch (e) {
      obs.push({ ...p, error: String(e?.cause?.code || e?.code || e?.name || e) })
    }
  }
  for (const n of names) {
    try {
      const a = await resolveImpl(n.host)
      const addrs = Array.isArray(a) ? a.map((x) => x.address ?? x) : [a?.address ?? a]
      obs.push({ ...n, resolved: addrs.filter(Boolean) })
    } catch (e) {
      obs.push({ ...n, resolved: [], error: String(e?.code || e) })
    }
  }
  return obs
}

// ---- rules -------------------------------------------------------------------

const isHtml = (o) => /text\/html|application\/xhtml/i.test(o.headers?.['content-type'] || '')
const isJson = (o) => /^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/i.test(o.headers?.['content-type'] || '')
const answered = (o) => typeof o.status === 'number'
const where = (o) => `${o.url}${answered(o) ? ` (${o.status})` : o.error ? ` (${o.error})` : ''}`
const at = (problem, o) => problem && `${problem} on ${where(o)}`

/** The rows, for a void page path (default the directory's /void; null: no page on the rp may run script). */
export function rows({ voidPath = VOID_PATH } = {}) {
  return [
    {
      id: 'rp-no-webauthn', title: 'id.bento.page serves no /.well-known/webauthn',
      pick: (o) => o.role === 'rp' && o.path === '/.well-known/webauthn',
      bad: (o) => webauthnFileServed(o.status) && `served ${where(o)}`,
    },
    {
      id: 'signin-no-webauthn', title: 'the sign-in host serves no /.well-known/webauthn',
      pick: (o) => o.role === 'signin' && o.path === '/.well-known/webauthn',
      bad: (o) => webauthnFileServed(o.status) && `served ${where(o)}`,
    },
    {
      id: 'rp-html-csp', roles: ['rp'], title: `every HTML response from id.bento.page has default-src 'none' (script only on the void page${voidPath ? ` ${voidPath}` : ': none named'})`, vacuousOk: !voidPath,
      pick: (o) => o.role === 'rp' && answered(o) && (isHtml(o) || (voidPath && o.path === voidPath)),
      bad: (o) => {
        const isVoid = !!voidPath && o.path === voidPath
        if (isVoid && !(o.status === 200 && isHtml(o))) return `the void page did not answer 200 HTML: ${where(o)} ${o.headers?.['content-type'] || 'no content-type'}`
        return at(rpHtmlCspProblem(o.headers['content-security-policy'], { isVoid }), o)
      },
    },
    {
      id: 'rp-api-json', roles: ['rp'], title: 'every API response from id.bento.page (/v1/, /.well-known/) is JSON',
      pick: (o) => o.role === 'rp' && answered(o) && (o.path.startsWith('/v1/') || o.path.startsWith('/.well-known/')) && o.status !== 204 && o.status !== 304,
      bad: (o) => !isJson(o) && `content-type "${o.headers['content-type'] || ''}" on ${where(o)}`,
    },
    {
      id: 'rp-nosniff', roles: ['rp'], title: 'every non-HTML response from id.bento.page is nosniff',
      pick: (o) => o.role === 'rp' && answered(o) && !isHtml(o) && o.status !== 204 && o.status !== 304,
      bad: (o) => (o.headers['x-content-type-options'] || '').toLowerCase() !== 'nosniff' && `no nosniff on ${where(o)}`,
    },
    {
      id: 'rp-permissions', roles: ['rp'], title: 'every response from id.bento.page turns WebAuthn off (Permissions-Policy)',
      pick: (o) => o.role === 'rp' && answered(o),
      bad: (o) => {
        const pp = (o.headers['permissions-policy'] || '').replace(/\s+/g, '')
        const off = (f) => pp.split(',').includes(`${f}=()`)
        return !(off('publickey-credentials-get') && off('publickey-credentials-create')) && `Permissions-Policy "${o.headers['permissions-policy'] || ''}" on ${where(o)}`
      },
    },
    {
      id: 'no-framing', title: "HTML from id.bento.page, the sign-in host and bento/home: frame-ancestors 'none' (and X-Frame-Options DENY on the first two)", vacuousOk: true,
      pick: (o) => ['rp', 'signin', 'home'].includes(o.role) && answered(o) && isHtml(o),
      bad: (o) => at(framingProblem(o.headers['content-security-policy'], o.headers['x-frame-options'], { requireXfo: o.role !== 'home' }), o),
    },
    {
      id: 'signin-no-coop', roles: ['signin'], title: 'the sign-in host sends no COOP (or unsafe-none)',
      pick: (o) => o.role === 'signin' && answered(o),
      bad: (o) => at(coopProblem('signin', o.headers['cross-origin-opener-policy']), o),
    },
    {
      id: 'home-coop', roles: ['home'], title: 'bento/home sends COOP at most same-origin-allow-popups',
      pick: (o) => o.role === 'home' && answered(o),
      bad: (o) => at(coopProblem('home', o.headers['cross-origin-opener-policy']), o),
    },
    {
      id: 'no-wildcard-under-rp', title: NO_WILDCARD,
      pick: (o) => o.role === 'label',
      bad: (o) => o.resolved.length > 0 && `${o.host} resolves (${o.resolved.join(', ')})`,
    },
    {
      id: 'apex-no-association', title: 'bento.page serves no passkey association',
      pick: (o) => o.role === 'apex',
      bad: (o) => {
        if (!answered(o)) return false
        if (o.status >= 300 && o.status < 400) return `redirects (${o.headers.location || '?'}) on ${where(o)}`
        return o.status < 300 && ASSOC_CONTENT.test(o.body || '') && `association content on ${where(o)}`
      },
    },
  ]
}
export const ROWS = rows()

/** Evaluate observations. Returns [{id, title, checked, fails[]}] plus the reachable row in live mode. */
export function evaluate(obs, { live = false, allowUnreachable = [], hosts = DEFAULT_HOSTS, voidPath = VOID_PATH } = {}) {
  const out = rows({ voidPath }).map((r) => {
    const sel = obs.filter(r.pick)
    const fails = sel.map(r.bad).filter(Boolean)
    const notes = []
    if (!sel.length && !r.vacuousOk) {
      if (live && r.roles?.every((role) => allowUnreachable.includes(role))) notes.push('nothing was checked: its host is allowed to be unreachable')
      else fails.push('nothing was checked (no probe matched): a pass here would be vacuous')
    }
    return { id: r.id, title: r.title, checked: sel.length, fails, notes }
  })
  if (live) {
    const fails = [], notes = []
    for (const role of ['rp', 'signin', 'home', 'apex']) {
      const any = obs.some((o) => o.role === role && answered(o))
      if (any) continue
      const msg = `${hosts[role]} answered no probe`
      if (allowUnreachable.includes(role)) notes.push(`${msg} (allowed: rows for it are vacuous)`)
      else fails.push(msg)
    }
    out.push({ id: 'reachable', title: 'every host answered', checked: 4, fails, notes })
  }
  return out
}

/**
 * The zone rows. `listings` is [{label, text}]: the DNS provider's export of
 * the zone (and of any delegated zone). In a live run a missing listing fails.
 */
export function zoneRows(listings, { live = false, hosts = DEFAULT_HOSTS } = {}) {
  const out = []
  if (live) out.push({ id: 'zone-listing', title: "the zone's records under id.bento.page were listed (--zone)", checked: listings.length, fails: listings.length ? [] : [`no --zone given. ${ZONE_LISTING_STEP}`] })
  if (!listings.length) return out
  const records = []
  const fails = []
  for (const l of listings) {
    try { records.push(...parseZoneListing(l.text)) } catch (e) { fails.push(`${l.label}: ${e.message}`) }
  }
  const z = zoneProblems(records, { rp: hosts.rp, signin: hosts.signin })
  out.push({ id: 'zone-names', title: `the zone listing names nothing under ${hosts.rp} but it and ${hosts.signin}`, checked: z.checked, fails: [...fails, ...z.fails] })
  return out
}

// ---- repo / staged-tree checks --------------------------------------------

function walk(dir, skip = () => false) {
  const out = []
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.name === '.git' || e.name === 'node_modules' || skip(full)) continue
    if (e.isDirectory()) out.push(...walk(full, skip))
    else out.push(full)
  }
  return out
}

/** Association files or content anywhere in a bento.page tree. Returns {checked, fails}. */
export function scanApexTree(dir, { skip = () => false, label = dir } = {}) {
  const files = walk(dir, skip)
  const fails = []
  for (const f of files) {
    const rel = relative(dir, f).split('\\').join('/')
    const name = rel.split('/').pop()
    if (/(^|\/)\.?well-known\//.test(rel) || ASSOC_NAMES.includes(name)) { fails.push(`${label}/${rel}: an association file in the bento.page tree`); continue }
    if (statSync(f).size > 4 * 1024 * 1024) continue
    const text = readFileSync(f, 'latin1')
    if (ASSOC_CONTENT.test(text)) fails.push(`${label}/${rel}: carries passkey association content`)
    if (['_headers', '_redirects'].includes(name) && /\.well-known/.test(text)) fails.push(`${label}/${rel}: routes /.well-known/ on bento.page`)
  }
  return { checked: files.length, fails }
}

/** The repo rows: run in CI with no network. */
export async function repoRows(repo = root) {
  const src = join(repo, 'site-src')
  const idHost = join(src, 'id-host')
  const apex = scanApexTree(src, { skip: (p) => p === idHost, label: 'site-src' })
  const rows = [{ id: 'apex-sources', title: 'bento.page sources carry no passkey association', checked: apex.checked, fails: apex.fails }]
  if (!apex.checked) apex.fails.push('no bento.page source file was scanned: a pass here would be vacuous')
  const tpl = join(idHost, 'well-known')
  const tplFails = ['apple-app-site-association', 'assetlinks.json'].filter((n) => !existsSync(join(tpl, n))).map((n) => `site-src/id-host/well-known/${n} is missing`)
  rows.push({ id: 'rp-templates', title: 'the association templates are the rp host\'s', checked: 2, fails: tplFails })
  const wk = join(repo, 'scripts/well-known.mjs')
  let rp = null
  try { rp = (await import(pathToFileURL(wk).href)).RP_HOST } catch (e) { rp = `unloadable: ${e.message}` }
  rows.push({ id: 'one-rp', title: 'well-known.mjs names the same rp', checked: 1, fails: rp === RP ? [] : [`well-known.mjs RP_HOST is ${rp}, this check's is ${RP}`] })
  return rows
}

// ---- cli -----------------------------------------------------------------------

function report(rows) {
  let bad = 0
  for (const r of rows) {
    const ok = !r.fails.length
    if (!ok) bad++
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${r.id.padEnd(22)} ${r.title} [${r.checked} checked]`)
    for (const f of r.fails) console.log(`        - ${f}`)
    for (const n of r.notes || []) console.log(`        · ${n}`)
  }
  return bad
}

async function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const all = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []))
  let rows = await repoRows()
  const site = arg('--site')
  if (site) {
    const s = scanApexTree(site, { label: site })
    if (!s.checked) s.fails.push(`${site} holds no files: a pass here would be vacuous`)
    rows.push({ id: 'apex-staged', title: `the staged bento.page tree carries no passkey association`, checked: s.checked, fails: s.fails })
  }
  const live = argv.includes('--live')
  const hosts = { ...DEFAULT_HOSTS, ...(arg('--signin') ? { signin: arg('--signin') } : {}) }
  const listings = all('--zone').map((f) => ({ label: f, text: readFileSync(f, 'utf8') }))
  if (live) {
    const extraPaths = all('--path').map((s) => { const [role, ...p] = s.split(':'); return { role, path: p.join(':') } })
    for (const e of extraPaths) if (!hosts[e.role] || !e.path.startsWith('/')) throw new Error(`--path wants ROLE:/path with ROLE one of ${Object.keys(hosts).join(', ')}`)
    const voidPath = arg('--void') || VOID_PATH
    if (voidPath && !voidPath.startsWith('/')) throw new Error('--void wants the void page\'s path, /...')
    const allowUnreachable = (arg('--allow-unreachable') || '').split(',').filter(Boolean)
    const obs = await gather(hosts, { extraPaths, voidPath })
    rows = rows.concat(evaluate(obs, { live: true, allowUnreachable, hosts, voidPath }))
  }
  rows = rows.concat(zoneRows(listings, { live, hosts }))
  const bad = report(rows)
  console.log(bad ? `${bad} row(s) failed` : `all ${rows.length} rows hold`)
  return bad ? 1 : 0
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(String(e?.message || e)); process.exit(2) })
}
