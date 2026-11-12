// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The hosting rules around the bento/id passkey relying party, as pure
// functions over header values, statuses and DNS records. Two checks use them:
// scripts/check-id-hosting.mjs (every host: the rp, the sign-in host,
// bento/home, the apex) and the sign-in host's own after-deploy check. One
// copy of each rule, so the two cannot drift apart.
//
// Nothing here fetches, resolves or reads a file. Every function returns a
// problem as a sentence, or false / [] when the rule holds.

export const RP = 'id.bento.page'
export const SIGNIN = `signin.${RP}`
export const HOME = 'home.bento.page'
export const APEX = 'bento.page'
/** The directory's void page: the one page on the rp host that runs script (server/directory/src/links.js VOID_PATH). */
export const VOID_PATH = '/void'

// ---- Cross-Origin-Opener-Policy ----------------------------------------------
//
// The sign-in host is a popup that bento/home opens and talks to through
// window.opener. A COOP that cuts the opener kills the protocol. Measured in
// Chromium: same-origin-allow-popups sent BY THE POPUP severs its opener exactly
// as same-origin does (it protects a page's own popups, not its tie to its
// opener). So the sign-in host sends no COOP, or unsafe-none. bento/home, the
// opener, may send same-origin-allow-popups and nothing stricter.

export const COOP_ALLOWED = {
  signin: ['', 'unsafe-none'],
  home: ['', 'unsafe-none', 'same-origin-allow-popups'],
}

/** The opener-severing part of a COOP value: its first token, lower-cased ('' when absent). */
export const coopValue = (header) => (header || '').split(';')[0].trim().toLowerCase()

/** A problem with the COOP a host sends, or false. role is 'signin' or 'home'. */
export function coopProblem(role, header) {
  const allowed = COOP_ALLOWED[role]
  if (!allowed) throw new Error(`no COOP rule for ${role}`)
  const v = coopValue(header)
  if (allowed.includes(v)) return false
  return role === 'signin'
    ? `sends Cross-Origin-Opener-Policy "${header}"; the sign-in host may send none, or unsafe-none`
    : `sends Cross-Origin-Opener-Policy "${header}"; bento/home may send at most same-origin-allow-popups`
}

// ---- Content-Security-Policy ---------------------------------------------------
//
// A response may carry several policies (several headers, which fetch joins
// with ", "). Every one is enforced, so a resource must pass all of them: one
// strict policy is enough for the rule. Directives repeated inside a policy
// keep the first (the CSP spec). A Report-Only header enforces nothing and is
// never read here.

/** Policies in a CSP header value, each a Map of directive → tokens. */
export function parseCsp(value) {
  return (value || '').split(',').map((policy) => {
    const dirs = new Map()
    for (const part of policy.split(';')) {
      const [name, ...tokens] = part.trim().split(/\s+/).filter(Boolean)
      if (name && !dirs.has(name.toLowerCase())) dirs.set(name.toLowerCase(), tokens.map((t) => t.toLowerCase()))
    }
    return dirs
  }).filter((d) => d.size)
}

const effective = (dirs, ...names) => {
  for (const n of names) if (dirs.has(n)) return dirs.get(n)
  return null
}

/**
 * Does a policy keep script to `allowed` tokens? Script elements fall back
 * script-src-elem → script-src → default-src, inline handlers
 * script-src-attr → script-src → default-src; both must hold. With no
 * directive at all, script is unrestricted.
 */
function scriptHeld(dirs, allowed) {
  for (const chain of [['script-src-elem', 'script-src', 'default-src'], ['script-src-attr', 'script-src', 'default-src']]) {
    const tokens = effective(dirs, ...chain)
    if (tokens === null || !tokens.length || !tokens.every((t) => allowed.includes(t))) return false
  }
  return true
}

/**
 * The rule for HTML on the rp host: default-src 'none', and no
 * script unless this is the void page, which may load script from 'self' only
 * (no inline, no hash, no nonce, no eval, no other host). The Permissions-Policy
 * there turns off WebAuthn get and create but NOT the Signal API, which deletes
 * passkeys with no prompt: script on the rp host is what that rule keeps out.
 */
export function rpHtmlCspProblem(value, { isVoid = false } = {}) {
  const policies = parseCsp(value)
  if (!policies.length) return 'no Content-Security-Policy header'
  const allowed = isVoid ? ["'self'", "'none'"] : ["'none'"]
  const ok = policies.some((d) => {
    const def = d.get('default-src')
    return def && def.length === 1 && def[0] === "'none'" && scriptHeld(d, allowed)
  })
  if (ok) return false
  return isVoid
    ? `CSP "${value}" is not the void page's: default-src 'none' and script from 'self' only`
    : `CSP "${value}" lets script run (only the void page may, and it is not this page): default-src 'none' and no script-src`
}

/** frame-ancestors 'none' in some policy, and X-Frame-Options DENY when asked. */
export function framingProblem(cspValue, xfo, { requireXfo = true } = {}) {
  const ok = parseCsp(cspValue).some((d) => {
    const fa = d.get('frame-ancestors')
    return fa && fa.length === 1 && fa[0] === "'none'"
  })
  if (!ok) {
    const any = parseCsp(cspValue).map((d) => d.get('frame-ancestors')).find(Boolean)
    return `frame-ancestors is ${any ? `"${any.join(' ')}"` : 'absent'}, not 'none'`
  }
  if (requireXfo && (xfo || '').trim().toUpperCase() !== 'DENY') return `X-Frame-Options is ${xfo ? `"${xfo}"` : 'absent'}, not DENY`
  return false
}

// ---- /.well-known/webauthn ---------------------------------------------------
//
// A Related Origin Requests file on the rp host listing an origin lets that
// origin create, get and Signal-wipe the rp's passkeys (measured). On the sign-in
// host the browser never fetches it, so the rule costs nothing there and is
// kept. A redirect counts as served: it points somewhere.

export const webauthnFileServed = (status) => typeof status === 'number' && status >= 200 && status < 400

// ---- names under the rp ---------------------------------------------------------
//
// Every name under id.bento.page can create, get and Signal-wipe its passkeys
// (measured for x.id.bento.page and x.signin.id.bento.page). DNS cannot list
// the names that exist (no zone transfer), so a lookup of a random label sees a
// WILDCARD only, and an explicit name such as test.id.bento.page passes it.
// Explicit names are found only in the zone's own listing, which the DNS
// provider gives its owner: every deploy lists it.

export const NO_WILDCARD = 'no wildcard name under id.bento.page or the sign-in host (DNS sees wildcards only; the zone listing covers explicit names)'
export const ZONE_LISTING_STEP = "every deploy: export the zone's records from the DNS provider (dashboard export or API) and pass them with --zone; only id.bento.page and the sign-in host may exist under id.bento.page"

/** Record types that give a name no address and hand it to no other server. */
const INERT = new Set(['TXT', 'CAA', 'MX', 'SRV', 'TLSA', 'SSHFP', 'SOA', 'PTR', 'RRSIG', 'NSEC', 'NSEC3', 'DNSKEY', 'DS', 'CERT', 'SMIMEA', 'URI', 'LOC', 'HINFO', 'NAPTR'])
const CLASSES = new Set(['IN', 'CH', 'HS', 'CS'])
const TYPE = /^([A-Z][A-Z0-9]*|TYPE\d+)$/

const norm = (n) => String(n).trim().toLowerCase().replace(/\.$/, '')
export const under = (name, parent) => name === parent || name.endsWith(`.${parent}`)

/**
 * The records in a zone listing, as [{name, type}]. Takes what a DNS provider
 * gives its owner: a BIND zone export (the dashboard's "export"), the provider
 * API's JSON (an array, or {result: [...]}), or plain "name TYPE ..." lines.
 */
export function parseZoneListing(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const j = JSON.parse(trimmed)
    const list = Array.isArray(j) ? j : j.result
    if (!Array.isArray(list)) throw new Error('a JSON zone listing is an array of records, or {result: [records]}')
    return list.map((r) => ({ name: norm(r.name), type: String(r.type || '').toUpperCase() }))
  }
  const out = []
  let origin = null, last = null, pending = ''
  for (const raw of text.split(/\r?\n/)) {
    let line = ''
    let quoted = false
    for (const ch of raw) {
      if (ch === '"') quoted = !quoted
      if (ch === ';' && !quoted) break
      line += ch
    }
    if (pending) { pending += ` ${line}`; if (!line.includes(')')) continue; line = pending; pending = '' }
    else if (line.includes('(') && !line.includes(')')) { pending = line; continue }
    if (!line.trim()) continue
    const toks = line.trim().split(/\s+/)
    if (toks[0].toUpperCase() === '$ORIGIN') { origin = norm(toks[1]); continue }
    if (toks[0].startsWith('$')) continue
    let name
    let rest
    if (/^\s/.test(line)) { name = last; rest = toks } else {
      const t = toks[0]
      name = t === '@' ? origin : t.endsWith('.') || !origin ? norm(t) : `${norm(t)}.${origin}`
      rest = toks.slice(1)
    }
    const type = rest.map((t) => t.toUpperCase()).find((t) => TYPE.test(t) && !CLASSES.has(t))
    if (!name || !type) throw new Error(`zone listing line not understood: ${raw.trim()}`)
    last = name
    out.push({ name, type })
  }
  return out
}

/**
 * Names under the rp in a zone listing (several listings when a name is
 * delegated). Returns {checked, fails}. Only the rp host and the sign-in host
 * may have a record that gives an address or delegates; a DNAME anywhere at or
 * under the rp rewrites every name below it. A listing that names no record
 * for the rp itself is not this zone's, or was cut short, and fails rather than
 * pass on nothing.
 */
export function zoneProblems(records, { rp = RP, signin = SIGNIN } = {}) {
  const rel = records.filter((r) => under(r.name, rp))
  const fails = []
  if (!rel.some((r) => r.name === rp)) fails.push(`the listing holds no record for ${rp}: it is not that zone's listing, or it is cut short`)
  const delegated = new Set()
  for (const r of rel) {
    if (r.type === 'DNAME') { fails.push(`${r.name} DNAME: it rewrites every name below it`); continue }
    if (r.name === rp || r.name === signin) { if (r.type === 'NS') delegated.add(r.name); continue }
    if (INERT.has(r.type)) continue
    fails.push(`${r.name} ${r.type}: only ${rp} and ${signin} may exist under ${rp}`)
  }
  for (const zone of delegated) {
    if (!rel.some((r) => r.name === zone && r.type === 'SOA')) fails.push(`${zone} is delegated (NS): pass that zone's own listing too, or names inside it go unseen`)
  }
  return { checked: rel.length, fails }
}
