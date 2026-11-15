// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The tripwire's decisions, with no browser in them: is this release list
// genuine, and does what this browser was served match a release in it?
//
// WHAT THE TRIPWIRE IS. bento/home in the browser (home.bento.page, and its
// frame site) is code a server chooses. Nothing a web page does can pin it:
// the page can't check itself, and a service worker is not a pin. Something
// already installed can. This extension compares what the browser received
// from home.bento.page against a list of releases signed with Bento's offline
// RELEASE key (the one every shipped shell trusts, release.js RELEASE_KEY), and
// says so, loudly, when they differ. It detects; it never prevents and never
// "fixes": no reload, no cache cleared, no worker unregistered.
//
// The list is a SIGNED ENVELOPE exactly like the app manifests and histories
// (scripts/sign-payload.mjs): `{payload: "<json string>", sig: "<base64>"}`,
// ECDSA P-256 / SHA-256 over the payload string's UTF-8 bytes, P1363 form.
// Its payload is typed (`type`), so no other signed artifact (an app manifest,
// a history, a pack index), all signed by the same key, can stand in for it,
// and it can stand in for none of them (they all require `app`).
//
// Payload, version 1 (scripts/lib/home-web-served.mjs writes it):
//
//   { type: 'bento/home-web/served', v: 1,
//     serial: <integer, +1 per signing; never goes down>,
//     at: '<ISO time it was signed>',
//     releases: [ <newest first, at least one> {
//       at: '<ISO>',
//       withdrawn?: true,                // a known-bad release: serving it is a mismatch
//       workers: ['/sw.js', …],          // library paths that are service workers
//       origins: { '<origin>': { role: 'library' | 'frame',
//         files: { '<path>': { sha256, bytes, kind: 'document' | 'asset',
//                              scripts?: [{ sha256 } | { src: '<path>' }],  // documents
//                              csp?: '<the Content-Security-Policy header>',
//                              cacheControl?: '<the Cache-Control header>' } } } } } ] }
//
// A payload carrying `app` is refused, whatever else it holds: every other
// artifact the release key signs carries `app`, and this one never does.
//
// Every rule below has a name, and the browser rig has a row that only that
// rule catches, with a mutant that turns it off (scripts/test-webext-tripwire-mutants.mjs).

import { verifySigned, RELEASE_KEY } from './release.js'

export const SERVED_TYPE = 'bento/home-web/served'
export const SERVED_V = 1
/** How long an older release may still be served after a newer one is signed
 *  before the person is told (a deploy, a CDN, and a worker's 24-hour update
 *  check all lag the signing). Until then an older release is recorded only. */
export const GRACE_MS = 72 * 3600 * 1000
/** How often the list is fetched when nothing is wrong. */
export const REFRESH_MS = 24 * 3600 * 1000

const HEX = /^[0-9a-f]{64}$/
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x)
const isPath = (p) => typeof p === 'string' && p.startsWith('/') && !p.startsWith('//')
const isIso = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s))

/** What is wrong with a payload's shape, or null. Strict: a list we half-understand is not a list. */
export function servedProblem(p) {
  if (!isObj(p)) return 'not an object'
  if (p.type !== SERVED_TYPE) return `type is not ${SERVED_TYPE}`
  if ('app' in p) return 'carries app (an app artifact, not a release list)'
  if (p.v !== SERVED_V) return `version ${p.v} is not ${SERVED_V}`
  if (!Number.isSafeInteger(p.serial) || p.serial < 1) return 'serial is not a positive integer'
  if (!isIso(p.at)) return 'at is not a time'
  if (!Array.isArray(p.releases) || !p.releases.length) return 'no releases'
  for (const [i, r] of p.releases.entries()) {
    if (!isObj(r) || !isIso(r.at)) return `release ${i} has no time`
    if (r.withdrawn !== undefined && r.withdrawn !== true) return `release ${i} withdrawn is not true`
    if (!Array.isArray(r.workers) || !r.workers.every(isPath)) return `release ${i} workers are not paths`
    if (!isObj(r.origins) || !Object.keys(r.origins).length) return `release ${i} has no origins`
    for (const [o, site] of Object.entries(r.origins)) {
      let u
      try { u = new URL(o) } catch { return `release ${i}: ${o} is not an origin` }
      if (u.origin !== o) return `release ${i}: ${o} is not an origin`
      if (!isObj(site) || (site.role !== 'library' && site.role !== 'frame')) return `release ${i}: ${o} has no role`
      if (!isObj(site.files) || !Object.keys(site.files).length) return `release ${i}: ${o} has no files`
      for (const [path, f] of Object.entries(site.files)) {
        if (!isPath(path)) return `release ${i}: ${path} is not a path`
        if (!isObj(f) || !HEX.test(f.sha256 ?? '') || !Number.isSafeInteger(f.bytes) || f.bytes < 0) return `release ${i}: ${path} is not pinned`
        if (f.kind !== 'document' && f.kind !== 'asset') return `release ${i}: ${path} has no kind`
        if (f.kind === 'document') {
          if (!Array.isArray(f.scripts)) return `release ${i}: ${path} lists no scripts`
          for (const s of f.scripts) if (!isObj(s) || !(HEX.test(s.sha256 ?? '') || isPath(s.src))) return `release ${i}: ${path} has a bad script entry`
        }
        if (f.csp !== undefined && typeof f.csp !== 'string') return `release ${i}: ${path} csp is not a string`
        if (f.cacheControl !== undefined && typeof f.cacheControl !== 'string') return `release ${i}: ${path} cacheControl is not a string`
      }
    }
  }
  return null
}

/**
 * Verify an envelope as a release list. Returns the payload; throws on a bad
 * signature or a payload that is not a v1 release list. `jwk` defaults to the
 * release key; the extension passes its configured key (tripwire-config.js).
 */
export async function verifyServed(raw, jwk = RELEASE_KEY) {
  const p = await verifySigned(raw, 'bento/home release list', jwk)
  const why = servedProblem(p)
  if (why) throw new Error(`the bento/home release list is malformed (${why})`)
  return p
}

/**
 * Decide what a freshly fetched list means, given the one already held.
 *
 *   'unreadable'  not an envelope at all (a captive portal, an HTML error page):
 *                 the same as a failed fetch, nothing is said
 *   'invalid'     an envelope whose signature does not verify, or a signed
 *                 payload that is not a release list: LOUD, because the honest
 *                 channel never serves one
 *   'rollback'    a genuine list older than the one held: refused, recorded
 *   'conflict'    a different list with the held serial: refused, LOUD (only
 *                 the signing key can make one)
 *   'same'        the held list again
 *   'ok'          a newer genuine list: take it
 */
export async function acceptServed(held, raw, jwk = RELEASE_KEY) {
  let env
  try { env = JSON.parse(raw) } catch { return { status: 'unreadable' } }
  if (!isObj(env) || typeof env.payload !== 'string' || typeof env.sig !== 'string') return { status: 'unreadable' }
  let payload
  try { payload = await verifyServed(raw, jwk) } catch (e) { return { status: 'invalid', why: String(e?.message ?? e) } }
  if (held) {
    if (payload.serial < held.serial) return { status: 'rollback', serial: payload.serial }
    if (payload.serial === held.serial) {
      return held.payload === env.payload ? { status: 'same' } : { status: 'conflict', serial: payload.serial }
    }
  }
  return { status: 'ok', held: { payload: env.payload, sig: env.sig, serial: payload.serial }, list: payload }
}

// ---- judging one page --------------------------------------------------------

const join = (v) => (v == null ? null : Array.isArray(v) ? v.join(', ') : String(v))

/** The scripts the page parsed, against a document entry's list (inline by hash, external by path and bytes). */
export function scriptsMatch(seen, want, files) {
  if (!Array.isArray(seen) || seen.length !== want.length) return false
  return want.every((w, i) => {
    const s = seen[i]
    if (w.sha256) return !s.src && s.sha256 === w.sha256
    if (!s.src || s.src !== w.src) return false
    // an external script's bytes, when the page could read them, are its file's
    return s.sha256 == null || s.sha256 === files[w.src]?.sha256
  })
}

/**
 * The document rules, against one release's entries for this origin. A page
 * may be served at any path (a host's fallback serves index.html for unknown
 * paths), so it matches if ANY document entry matches every observed value.
 * Returns the failures against the closest entry ([] when one matches).
 */
export function documentFailures(obs, rel, origin) {
  const site = rel.origins?.[origin]
  if (!site || site.role !== obs.role) return [{ rule: 'page', why: `this release serves no ${obs.role} at ${origin}` }]
  let best = null
  for (const [path, e] of Object.entries(site.files)) {
    if (e.kind !== 'document') continue
    const f = []
    if (obs.bytes && obs.bytes.sha256 !== e.sha256) f.push({ rule: 'bytes', path, want: e.sha256, got: obs.bytes.sha256 })
    if (obs.size > 0 && obs.size !== e.bytes) f.push({ rule: 'size', path, want: e.bytes, got: obs.size })
    if (!scriptsMatch(obs.scripts, e.scripts, site.files)) f.push({ rule: 'scripts', path, want: e.scripts, got: obs.scripts })
    if (obs.csp != null && join(obs.csp) !== (e.csp ?? '')) f.push({ rule: 'csp', path, want: e.csp ?? '', got: join(obs.csp) })
    if (obs.cacheControl != null && e.cacheControl !== undefined && join(obs.cacheControl) !== e.cacheControl) f.push({ rule: 'cache-control', path, want: e.cacheControl, got: join(obs.cacheControl) })
    if (!f.length) return []
    if (!best || f.length < best.length) best = f
  }
  return best ?? [{ rule: 'page', why: `this release lists no document at ${origin}` }]
}

/** Markup that runs script without a <script> element: never in a release. */
export function markupFailures(obs) {
  return (obs.flags ?? []).length ? [{ rule: 'markup', got: obs.flags }] : []
}

/** Every registered worker is one some release lists, and its bytes (when fetched) are that release's. */
export function workerFailures(obs, list, origin) {
  const out = []
  for (const w of obs.workers ?? []) {
    let u
    try { u = new URL(w.scriptURL) } catch { out.push({ rule: 'worker', got: w.scriptURL }); continue }
    const listed = list.releases.filter((r) => u.origin === origin && r.workers.includes(u.pathname))
    if (!listed.length) { out.push({ rule: 'worker', why: 'not a worker any release registers', got: w.scriptURL }); continue }
    if (w.sha256 != null && !listed.some((r) => r.origins[origin]?.files[u.pathname]?.sha256 === w.sha256)) {
      out.push({ rule: 'worker-bytes', path: u.pathname, got: w.sha256 })
    }
  }
  return out
}

/** Every entry in the origin's Cache Storage is a file some release lists, byte for byte. */
export function cacheFailures(obs, list, origin) {
  const out = []
  for (const c of obs.cache ?? []) {
    let u
    try { u = new URL(c.url) } catch { out.push({ rule: 'cache', got: c.url }); continue }
    const p = u.pathname === '' ? '/' : u.pathname
    const ok = u.origin === origin && list.releases.some((r) => r.origins[origin]?.files[p]?.sha256 === c.sha256)
    if (!ok) out.push({ rule: 'cache', url: c.url, got: c.sha256 })
  }
  return out
}

/**
 * What a library or frame observation must have to be judged at all (security
 * ruling C2). The honest library sends Cache-Control: no-cache, which Chrome
 * stores, so without a worker a missing cached copy is itself evidence; a size
 * of 0 or a parse that never finished is never a pass.
 */
export function observationFailures(obs) {
  const out = []
  // a navigation another site started is cached where the content script cannot read it (measured):
  // then the bytes are not asked for, and the Cache-Control header the navigation got is (documentFailures)
  if (obs.role === 'library' && !obs.viaWorker && !obs.bytes && !obs.crossSite) out.push({ rule: 'bytes-unread' })
  if (!(obs.size > 0)) out.push({ rule: 'size-unread' })
  if (obs.complete === false) out.push({ rule: 'incomplete' })
  // the library's caches and worker registrations are always readable (empty, in stage 1): unread is no pass
  if (obs.role === 'library' && !Array.isArray(obs.cache)) out.push({ rule: 'cache-unread' })
  if (obs.role === 'library' && !Array.isArray(obs.workers)) out.push({ rule: 'workers-unread' })
  return out
}

const pathOf = (url) => { try { return new URL(url).pathname || '/' } catch { return null } }

/** Is this path one some release serves on this origin? */
export function listedPath(list, origin, url) {
  const p = pathOf(url)
  return p != null && list.releases.some((r) => r.origins[origin]?.files[p] !== undefined)
}

/**
 * The verdict for one observed page.
 *
 *   'ok'         the newest release, in every observed value
 *   'outdated'   an older release in the list, exactly; `notify` once the
 *                newest release is more than GRACE_MS old
 *   'unlisted'   a page with no script and no flag at a path no release
 *                serves (a host's 404): recorded quietly (ruling C3)
 *   'mismatch'   no release in the list, a withdrawn release, or an
 *                observation that is missing what it must have: the loud one
 *
 * `failures` are against the newest release (or the global rules).
 */
export function judge(obs, list, origin, now = Date.now()) {
  if (!obs.scripts?.length && !obs.flags?.length && !listedPath(list, origin, obs.url)) {
    return { verdict: 'unlisted', release: -1, failures: [] }
  }
  const global = [...markupFailures(obs), ...observationFailures(obs), ...workerFailures(obs, list, origin), ...cacheFailures(obs, list, origin)]
  const perRelease = list.releases.map((r) => documentFailures(obs, r, origin))
  const index = perRelease.findIndex((f) => f.length === 0)
  if (global.length || index < 0) {
    return { verdict: 'mismatch', release: index, failures: [...global, ...(index < 0 ? perRelease[0] : [])] }
  }
  if (list.releases[index].withdrawn) return { verdict: 'mismatch', release: index, failures: [{ rule: 'withdrawn', at: list.releases[index].at }] }
  if (index === 0) return { verdict: 'ok', release: 0, failures: [] }
  const newest = Date.parse(list.releases[0].at)
  return { verdict: 'outdated', release: index, failures: [], notify: now - newest > GRACE_MS }
}

/**
 * An EARLY report with no full report after it (the page left, or never
 * finished): what the parse had shown when the last script was seen. Every
 * script must be one some release that is not withdrawn lists for a document
 * on this origin, and no flag may be raised; otherwise it is a mismatch.
 * Clean but unfinished is 'incomplete', recorded quietly.
 */
export function judgeEarly(obs, list, origin) {
  const fail = [...markupFailures(obs)]
  const inline = new Set(), srcs = new Set()
  for (const r of list.releases) {
    if (r.withdrawn) continue
    for (const f of Object.values(r.origins[origin]?.files ?? {})) {
      for (const s of f.scripts ?? []) s.sha256 ? inline.add(s.sha256) : srcs.add(s.src)
    }
  }
  const strange = (obs.scripts ?? []).filter((s) => (s.src != null ? !srcs.has(s.src) : !inline.has(s.sha256)))
  if (strange.length) fail.push({ rule: 'scripts', got: strange })
  return fail.length ? { verdict: 'mismatch', release: -1, failures: fail } : { verdict: 'incomplete', release: -1, failures: [] }
}

/** Which observations were actually made, for the record. A value that was not observed is NOT a pass where the page must have it (observationFailures). */
export function observed(obs) {
  return {
    bytes: !!obs.bytes, size: obs.size > 0, scripts: Array.isArray(obs.scripts), csp: obs.csp != null,
    workers: Array.isArray(obs.workers), cache: Array.isArray(obs.cache),
  }
}
