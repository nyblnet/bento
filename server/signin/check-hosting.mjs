// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The sign-in host's hosting check. Run it after EVERY deploy, against the live
// host; it reads headers and DNS, and changes nothing:
//
//   node server/signin/check-hosting.mjs
//   node server/signin/check-hosting.mjs --home https://home.bento.page
//
// Options:
//   --origin <url>     the sign-in host (default https://signin.id.bento.page)
//   --rp-origin <url>  the rp host whose /.well-known/webauthn must not exist
//                      (default https://id.bento.page; "none" to leave it out)
//   --home <url>       also check bento/home's Cross-Origin-Opener-Policy
//   --local            a plain-http local run (server/signin/local.mjs): no
//                      HSTS or DNS rows, and no rp row unless --rp-origin is given
//
// Each row is a rule a measurement showed load-bearing:
//   - every response, and so every HTML response, carries a strict CSP:
//     default-src 'none'; scripts only from 'self' or by hash (no inline, no
//     eval, no wildcard, no data:/blob:); frame-ancestors 'none'; Trusted
//     Types enforced with no policy. Plus X-Frame-Options DENY and nosniff.
//   - no COOP on the sign-in host (none, or unsafe-none); bento/home at most
//     same-origin-allow-popups. Measured in Chromium: same-origin-allow-popups
//     ON THE POPUP severs its opener exactly as same-origin does.
//   - no /.well-known/webauthn on the sign-in host or on the rp host: a file on
//     the rp host listing another origin lets that origin use, and wipe, the
//     passkeys.
//   - nothing but the host's own files is served, and there is no WILDCARD name under
//     the sign-in host or the rp host: every name under the rp can use, and
//     wipe, its passkeys. DNS cannot list explicit names (no zone transfer), so
//     this check sees wildcards only; the deploy steps (README) also list the
//     zone's records under id.bento.page from the DNS provider, by hand.
import { Resolver } from 'node:dns/promises'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const SIGNIN_ORIGIN = 'https://signin.id.bento.page'
export const RP_ORIGIN = 'https://id.bento.page'
/** The one origin the sign-in page may connect to: the directory. */
export const CONNECT = ['https://id.bento.page']

/** Problems with a CSP value, as sentences; [] when it meets the rule. */
export function cspProblems(value) {
  if (!value) return ['no Content-Security-Policy header']
  const out = []
  const dirs = new Map()
  for (const part of value.split(/[;,]/)) {
    const [name, ...tokens] = part.trim().split(/\s+/).filter(Boolean)
    if (!name) continue
    const n = name.toLowerCase()
    if (dirs.has(n)) out.push(`${n} appears twice`)
    else dirs.set(n, tokens)
  }
  const def = dirs.get('default-src')
  if (!def || def.length !== 1 || def[0] !== "'none'") out.push("default-src is not exactly 'none'")
  const script = dirs.get('script-src') || def || []
  for (const t of script) {
    if (t !== "'self'" && t !== "'none'" && !/^'sha(256|384|512)-[A-Za-z0-9+/]+={0,2}'$/.test(t)) out.push(`script-src allows ${t}`)
  }
  for (const n of ['script-src-elem', 'script-src-attr', 'worker-src', 'child-src', 'frame-src', 'object-src']) {
    for (const t of dirs.get(n) || []) if (t !== "'none'" && t !== "'self'") out.push(`${n} allows ${t}`)
  }
  const connect = dirs.get('connect-src')
  if (connect && JSON.stringify(connect) !== JSON.stringify(CONNECT)) out.push(`connect-src is not exactly ${CONNECT.join(' ')}`)
  for (const t of dirs.get('style-src') || []) if (t !== "'self'" && t !== "'none'") out.push(`style-src allows ${t}`)
  const rtt = dirs.get('require-trusted-types-for')
  if (!rtt || rtt.length !== 1 || rtt[0] !== "'script'") out.push("require-trusted-types-for is not exactly 'script'")
  const tt = dirs.get('trusted-types')
  if (!tt || tt.length !== 1 || tt[0] !== "'none'") out.push("trusted-types is not exactly 'none' (no policy)")
  const fa = dirs.get('frame-ancestors')
  if (!fa || fa.length !== 1 || fa[0] !== "'none'") out.push("frame-ancestors is not exactly 'none'")
  for (const [n, tokens] of dirs) {
    for (const t of tokens) {
      if (t === '*' || /^(https?|wss?):?$/.test(t) || /^'unsafe-/.test(t) || t === "'strict-dynamic'" || /^(data|blob|filesystem):$/.test(t)) {
        out.push(`${n} allows ${t}`)
      }
    }
  }
  return out
}

/** The opener-severing part of a COOP value: its first token, lower-cased. */
const coopValue = (h) => (h || '').split(';')[0].trim().toLowerCase()

const PROBES = [
  ['GET', '/', 200],
  ['HEAD', '/', 200],
  ['GET', '/?t=enrol&W=AAAA&label=x', 200],
  ['GET', '/signin.js', 200],
  ['GET', '/directory-client.js', 200],
  ['GET', '/signin.css', 200],
  ['GET', '/setup', 200],
  ['GET', '/reset', 200],
  ['GET', '/account', 200],
  ['GET', '/link.js', 200],
  ['GET', '/account.js', 200],
  ['GET', '/account-client.js', 200],
  ['GET', '/setup.html', 404],
  ['GET', '/account/', 404],
  ['POST', '/setup', 405],
  ['GET', '/index.html', 404],
  ['GET', '/.well-known/webauthn', 404],
  ['GET', '/.well-known/', 404],
  ['GET', '/no-such-page', 404],
  ['GET', '/no-such-page.html', 404],
  ['GET', '/enrol', 404],
  ['POST', '/', 405],
]

/**
 * Runs the rows. Returns [{ ok, row }]. `fetchImpl` and `resolver` are
 * parameters so the rig can drive this against local servers.
 */
export async function checkHosting({ origin = SIGNIN_ORIGIN, rpOrigin = RP_ORIGIN, home = null, local = false, fetchImpl = fetch, resolver = null } = {}) {
  const rows = []
  const row = (ok, text) => rows.push({ ok: !!ok, row: text })
  const get = async (method, url) => {
    try {
      return await fetchImpl(url, { method, redirect: 'manual', cache: 'no-store', body: method === 'POST' ? '{}' : undefined })
    } catch (e) {
      return { error: e }
    }
  }
  if (!local && !origin.startsWith('https://')) row(false, `${origin}: the sign-in host is checked over https (use --local for a local run)`)

  let html = 0
  for (const [method, path, want] of PROBES) {
    const r = await get(method, origin + path)
    const name = `${method} ${path}`
    if (r.error) { row(false, `${name}: no answer (${r.error.message})`); continue }
    row(r.status === want, `${name}: status ${r.status}${r.status === want ? '' : `, expected ${want}`}`)
    const type = (r.headers.get('content-type') || '').toLowerCase()
    if (type.startsWith('text/html')) html++
    const csp = cspProblems(r.headers.get('content-security-policy'))
    row(csp.length === 0, `${name}: strict CSP${csp.length ? ` (${csp.join('; ')})` : ''}`)
    if (r.headers.get('content-security-policy-report-only') && !r.headers.get('content-security-policy')) row(false, `${name}: CSP is report-only`)
    row((r.headers.get('x-frame-options') || '').toUpperCase() === 'DENY', `${name}: X-Frame-Options DENY`)
    row((r.headers.get('x-content-type-options') || '').toLowerCase() === 'nosniff', `${name}: nosniff`)
    const coop = coopValue(r.headers.get('cross-origin-opener-policy'))
    row(coop === '' || coop === 'unsafe-none', `${name}: no Cross-Origin-Opener-Policy (none, or unsafe-none)${coop ? ` (sends ${coop})` : ''}`)
    if (!local) row(/max-age=\d+/.test(r.headers.get('strict-transport-security') || ''), `${name}: Strict-Transport-Security`)
    if (path === '/' && method === 'GET') row(type.startsWith('text/html'), `${name}: is the HTML page (the positive control for the HTML rows)`)
  }
  row(html >= 1, `${html} HTML response(s) seen, each with the CSP above`)

  if (rpOrigin && rpOrigin !== 'none') {
    const r = await get('GET', rpOrigin + '/.well-known/webauthn')
    if (r.error) row(false, `${rpOrigin}/.well-known/webauthn: no answer (${r.error.message}); the rp host must answer, with a 404`)
    else row(r.status === 404 || r.status === 410, `${rpOrigin}/.well-known/webauthn: status ${r.status} (must not exist)`)
  }

  if (home) {
    const r = await get('GET', home + '/')
    if (r.error) row(false, `${home}/: no answer (${r.error.message})`)
    else {
      const coop = coopValue(r.headers.get('cross-origin-opener-policy'))
      row(coop === '' || coop === 'unsafe-none' || coop === 'same-origin-allow-popups',
        `${home}/: Cross-Origin-Opener-Policy at most same-origin-allow-popups${coop ? ` (sends ${coop})` : ' (sends none)'}`)
    }
  }

  if (!local) {
    const res = resolver || new Resolver()
    const exists = async (name) => {
      for (const kind of ['resolve4', 'resolve6', 'resolveCname']) {
        try { if ((await res[kind](name)).length) return `${kind.slice(7)} record` } catch (e) {
          if (e.code !== 'ENOTFOUND' && e.code !== 'ENODATA') return `lookup error ${e.code}`
        }
      }
      return null
    }
    for (const parent of [new URL(origin).hostname, new URL(rpOrigin && rpOrigin !== 'none' ? rpOrigin : RP_ORIGIN).hostname]) {
      const probe = `zz-${randomBytes(6).toString('hex')}.${parent}`
      const found = await exists(probe)
      row(!found, `no wildcard name under ${parent} (a random label, ${probe}: ${found || 'not found'})`)
    }
  }
  return rows
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
  const local = args.includes('--local')
  const rows = await checkHosting({
    origin: (opt('--origin') || SIGNIN_ORIGIN).replace(/\/$/, ''),
    rpOrigin: opt('--rp-origin') || (local ? 'none' : RP_ORIGIN),
    home: opt('--home') ? opt('--home').replace(/\/$/, '') : null,
    local,
  })
  for (const r of rows) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.row}`)
  if (!opt('--home')) console.log('  note  bento/home not checked; pass --home <origin> once it is hosted')
  if (!local) console.log('  note  by hand, every deploy: list the zone\'s records under id.bento.page in the DNS provider; only id.bento.page and the sign-in host may exist (DNS cannot list explicit names, so the rows above see wildcards only)')
  const bad = rows.filter((r) => !r.ok).length
  console.log(`\n${rows.length - bad}/${rows.length} hosting rows passed`)
  if (bad) process.exit(1)
}
