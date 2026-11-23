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
//                              elements?: ['meta', 'title', …],            // documents: tag names in parse order
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
          if (!Array.isArray(f.elements) || !f.elements.every((x) => typeof x === 'string')) return `release ${i}: ${path} lists no element sequence`
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

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i])
const isPrefix = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length <= b.length && a.every((x, i) => x === b[i])
const sameScript = (seen, want) => (want.sha256 ? !seen.src && seen.sha256 === want.sha256 : seen.src === want.src)

/** The rules that say "could not tell" rather than "this is not a release" (N4: they never share a warning with the others). */
export const UNVERIFIED_RULES = new Set(['bytes-unread', 'size-unread', 'incomplete', 'cache-unread', 'workers-unread', 'worker-request-unattributed', 'page-request-unattributed'])
/** 'unverified' when every failure is one of those, else 'tampered'. Loud warnings are once per class per origin per session. */
export const classOf = (failures) => (failures.length && failures.every((f) => UNVERIFIED_RULES.has(f.rule)) ? 'unverified' : 'tampered')

/**
 * Is what the page showed so far the START of a listed document (a release
 * that is not withdrawn), with nothing else in it? The elements a prefix of
 * its sequence, every script one of its scripts in order, no flag. The last
 * script may be cut short only if it is the last thing parsed and its text is
 * an exact prefix of the listed script's (`partialOk(sha256, text)`, checked
 * by the caller against the text published beside the list): an honest IIFE
 * cut short is a syntax error if it ever runs, never someone else's code.
 */
export function cleanPrefix(obs, list, origin, partialOk = () => false) {
  if ((obs.flags ?? []).length || !Array.isArray(obs.elements)) return false
  const scripts = obs.scripts ?? []
  for (const r of list.releases) {
    if (r.withdrawn) continue
    const site = r.origins[origin]
    if (!site || site.role !== obs.role) continue
    for (const d of Object.values(site.files)) {
      if (d.kind !== 'document' || !isPrefix(obs.elements, d.elements) || scripts.length > d.scripts.length) continue
      if (obs.csp != null && (Array.isArray(obs.csp) ? obs.csp.join(', ') : obs.csp) !== (d.csp ?? '')) continue
      const ok = scripts.every((sc, i) => {
        if (sameScript(sc, d.scripts[i])) return true
        const last = i === scripts.length - 1 && obs.elements.at(-1) === 'script'
        return last && !!d.scripts[i].sha256 && obs.partial?.index === i && partialOk(d.scripts[i].sha256, obs.partial.text)
      })
      if (ok) return true
    }
  }
  return false
}

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
    if (Array.isArray(obs.elements) && !sameList(obs.elements, e.elements)) f.push({ rule: 'elements', path, got: obs.elements.length })
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

/**
 * A Refresh response header navigates with no markup to flag: never in a release (R4). Other response
 * headers but CSP and Cache-Control are not checked.
 * The navigation preload request header (Service-Worker-Navigation-Preload) is the browser's `true`
 * unless a worker set another value (navigationPreload.setHeaderValue): the honest worker never does,
 * and a value is bytes the worker sends out on every later navigation (security ruling on #983, M1).
 * Absent (no worker, or no preload): nothing to judge.
 * A Cookie on the library's navigation: the library sets none, so one is a value something on its
 * origin chose (a worker's cookieStore.set), sent out on every later request (security ruling on
 * #983, M4). Only its presence is recorded, never its value. Absent or unread: nothing to judge.
 */
export function headerFailures(obs) {
  const out = (obs.refresh ?? []).length ? [{ rule: 'refresh-header', got: obs.refresh }] : []
  if (obs.preload != null && obs.preload !== 'true') out.push({ rule: 'preload-header', got: obs.preload })
  if (obs.cookie === true) out.push({ rule: 'request-cookie' })
  return out
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
  // under a worker, unread bytes are waived only when the worker answered from somewhere webRequest did not see:
  // a navigation it saw (navigation preload) had a response the HTTP cache could have kept (security ruling #954 C2)
  if (obs.role === 'library' && (!obs.viaWorker || obs.cspFrom === 'navigation') && !obs.bytes && !obs.crossSite) out.push({ rule: 'bytes-unread' })
  if (!(obs.size > 0)) out.push({ rule: 'size-unread' })
  if (obs.complete === false) out.push({ rule: 'incomplete' })
  // the library's caches and worker registrations are always readable (empty, in stage 1): unread is no pass
  if (obs.role === 'library' && !Array.isArray(obs.cache)) out.push({ rule: 'cache-unread' })
  if (obs.role === 'library' && !Array.isArray(obs.workers)) out.push({ rule: 'workers-unread' })
  return out
}

const pathOf = (url) => { try { return new URL(url).pathname || '/' } catch { return null } }

/**
 * A request the library's own worker made (security ruling #954 C5, the cloaked
 * worker): webRequest reports it with tabId -1 and the library origin as its
 * initiator. The honest worker only fetches its precache (GET, no query, the
 * build's own files) and, once installed, nothing else of its own (navigations
 * come by navigation preload, which is the tab's request); the browser fetches
 * the worker's script itself. So the allowlist is:
 *   - GET, with no query (not even a bare `?`), on the library origin;
 *   - a path some release in the list serves there (the served files are a
 *     superset of the precache: the page, /index.html, the worker, the 404
 *     page, the manifest and icons);
 *   - a worker path (/sw.js) only as the BROWSER's worker-script fetch: type
 *     `script`, Sec-Fetch-Dest `serviceworker` (a Sec- header no script can
 *     set) and Service-Worker `script`. A worker re-fetching its own script
 *     (to launder a cloaked copy) carries none of them.
 *   - its request headers held to the honest worker's (security ruling on
 *     #983, M1: a header is bytes the worker chooses). Cookie and Referer are
 *     forbidden NAMES whose VALUES a worker still chooses (cookieStore.set,
 *     fetch's `referrer` with an unsafe-url policy; security ruling on #983,
 *     M4), and the honest worker's requests carry neither (measured, Chromium
 *     149: its precache fetches omit credentials, and the library's
 *     Referrer-Policy is no-referrer), so either one is a finding, but for
 *     the browser's own update check of the worker script, whose Referer is
 *     the script's own URL (measured: a soft update after a navigation). The other
 *     forbidden names, Sec-* and Proxy-* are the browser's: their values are
 *     its settings, or one of the few the fetch spec derives from the
 *     request's mode and destination (which requests it makes: the covert
 *     channel below). Every other header must be one the honest worker's
 *     requests carry, with the value they carry (measured, Chromium 149: the
 *     install's precache fetches and the browser's script fetch and update
 *     check): Accept `*\/*`, Service-Worker `script`, and Accept-Language and
 *     User-Agent equal to what the library's latest navigation sent
 *     (`ctx.nav`). Any other name, or another value, is a finding; so are
 *     headers that were not read, and a navigation record that is absent.
 * A request with no initiator cannot be tied to the library's worker or ruled
 * out as it: recorded as unverified, never allowed in silence.
 * `req`: { url, method, type, initiator, headers: [{ name, value }] | null }.
 * `ctx.nav`: { acceptLanguage, userAgent } from the latest library navigation, or null.
 * This does not verify bytes: a worker that keeps to these requests can still
 * pass data out through which of them it makes, and when (a covert channel),
 * and it can answer pages with what it likes without making any request.
 */
export function workerRequestFailures(req, list, origin, ctx = {}) {
  const got = { method: req?.method ?? null, url: req?.url ?? null, type: req?.type ?? null, initiator: req?.initiator ?? null }
  if (req?.initiator == null) return [{ rule: 'worker-request-unattributed', got }]
  let u
  try { u = new URL(req.url) } catch { return [{ rule: 'worker-request', why: 'unreadable URL', got }] }
  const out = []
  const why = (w) => out.push({ rule: 'worker-request', why: w, got })
  if (u.origin !== origin) why('another origin')
  if (req.method !== 'GET') why('not GET')
  if (String(req.url).split('#')[0].includes('?')) why('a query')
  const p = u.pathname || '/'
  if (!list.releases.some((r) => r.origins[origin]?.files[p] !== undefined)) why('a path no release serves')
  const h = (name) => (Array.isArray(req.headers) ? req.headers.find((x) => String(x?.name).toLowerCase() === name)?.value ?? null : null)
  const browserScript = req.type === 'script' && h('sec-fetch-dest') === 'serviceworker' && h('service-worker') === 'script'
  if (list.releases.some((r) => (r.workers ?? []).includes(p)) && !browserScript) why('the worker script, not fetched as the browser\'s worker script')
  // the browser's own update check names the script itself as its Referer (MEASURED, Chromium 149: a soft
  // update after a navigation; the install's fetch and update() carry none): its value, not the worker's
  const ownReferer = browserScript ? `${u.origin}${p}` : null
  for (const w of requestHeaderProblems(req.headers, ctx.nav, ownReferer)) why(w)
  return out
}

/**
 * Why a library PAGE's own non-document request (a tab's, not a navigation) is not the honest library's
 * (empty when it is). Security ruling on #983, M6: a cloaked worker may change an attribute value of a
 * page it answers, with no request of its own, and the BROWSER then fetches what the page names (MEASURED,
 * Chromium 149: `<link rel=manifest href="/manifest.webmanifest?s=…">` reached the server in Chrome's own
 * manifest fetch, tabId = the tab, type `other`, initiator the library origin). So the page's requests to
 * its own origin are held to the same rules as the worker's: GET, no query, a path a release serves, and
 * no Cookie or Referer (the honest page is no-referrer, and the browser's manifest fetch omits credentials).
 * Their other headers are the browser's: a page with no script of its own cannot set one.
 */
export function pageRequestFailures(req, list, origin, ctx = {}) {
  const got = { method: req?.method ?? null, url: req?.url ?? null, type: req?.type ?? null, initiator: req?.initiator ?? null }
  if (req?.initiator == null) return [{ rule: 'page-request-unattributed', got }]
  let u
  try { u = new URL(req.url) } catch { return [{ rule: 'page-request', why: 'unreadable URL', got }] }
  const out = []
  const why = (w) => out.push({ rule: 'page-request', why: w, got })
  if (u.origin !== origin) why('another origin')
  if (String(req.method) !== 'GET') why('not GET')
  // the tab's own document URL, as its navigation asked for it (`ctx.ownUrl`, from webRequest): the
  // tripwire's content script re-reads it from the HTTP cache (MEASURED: a tab `xmlhttprequest` GET of the
  // page's URL). Its query and path are the navigation's, which the worker did not choose; judged on the rest
  const own = typeof ctx.ownUrl === 'string' && String(req.url).split('#')[0] === ctx.ownUrl
  if (!own && String(req.url).split('#')[0].includes('?')) why('a query')
  const p = u.pathname || '/'
  if (!own && !list.releases.some((r) => r.origins[origin]?.files[p] !== undefined)) why('a path no release serves')
  if (!Array.isArray(req.headers)) why('its request headers were not read')
  else for (const n of ABSENT_REQUEST) if (req.headers.some((x) => String(x?.name ?? '').toLowerCase() === n)) why(`a header the honest page does not send: ${n}`)
  return out
}

// forbidden names whose values a script still chooses (cookieStore, fetch's referrer): never on the honest
// worker's requests (security ruling on #983, M4)
const ABSENT_REQUEST = new Set(['cookie', 'referer'])
// request header names no script can set (the fetch spec's other forbidden request-header names): the browser's
const FORBIDDEN_REQUEST = new Set(['accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method',
  'connection', 'content-length', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin',
  'set-cookie', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via'])
// the script-settable headers the honest worker's requests carry, each held to the value it carries (measured)
const HELD_REQUEST = new Map([['accept', ['*/*']], ['service-worker', ['script']]])
// the two the browser fills from its own settings: held to what the library's latest navigation sent
const HELD_FROM_NAV = new Map([['accept-language', 'acceptLanguage'], ['user-agent', 'userAgent']])
/**
 * Why a worker request's headers are not the honest worker's (empty when they are). `ownReferer`: on
 * the browser's own worker-script fetch, the one Referer it may carry (the script's own URL), else null.
 */
export function requestHeaderProblems(headers, nav, ownReferer = null) {
  if (!Array.isArray(headers)) return ['its request headers were not read']
  const out = []
  for (const x of headers) {
    const n = String(x?.name ?? '').toLowerCase()
    const v = String(x?.value ?? '')
    if (n === 'referer' && ownReferer != null && v === ownReferer) continue
    if (ABSENT_REQUEST.has(n)) { out.push(`a header the honest worker does not send: ${n}`); continue }
    if (FORBIDDEN_REQUEST.has(n) || n.startsWith('sec-') || n.startsWith('proxy-')) continue
    if (HELD_REQUEST.has(n)) { if (!HELD_REQUEST.get(n).includes(v)) out.push(`a header the honest worker does not send: ${n} with another value`); continue }
    if (HELD_FROM_NAV.has(n)) {
      const want = nav?.[HELD_FROM_NAV.get(n)]
      if (typeof want !== 'string') out.push(`a header with no navigation to hold it to: ${n}`)
      else if (v !== want) out.push(`a header the honest worker does not send: ${n} with another value`)
      continue
    }
    out.push(`a header the honest worker does not send: ${n}`)
  }
  return out
}

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
export function judge(obs, list, origin, now = Date.now(), partialOk = () => false) {
  if (!obs.scripts?.length && !obs.flags?.length && !listedPath(list, origin, obs.url)) {
    return { verdict: 'unlisted', release: -1, failures: [] }
  }
  // a visit cut short (closed, stopped, or a response that never ended) that is still the clean
  // start of a listed document says nothing either way: recorded quietly (N4)
  if (obs.aborted && !headerFailures(obs).length && cleanPrefix(obs, list, origin, partialOk)) return { verdict: 'incomplete', release: -1, failures: [], aborted: true }
  const global = [...markupFailures(obs), ...headerFailures(obs), ...observationFailures(obs), ...workerFailures(obs, list, origin), ...cacheFailures(obs, list, origin)]
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
 * finished): what the parse had shown so far, the elements included (N1). A
 * clean prefix of a listed document is 'incomplete', recorded quietly;
 * anything else is a mismatch.
 */
export function judgeEarly(obs, list, origin, partialOk = () => false) {
  const headers = headerFailures(obs)
  if (!headers.length && cleanPrefix(obs, list, origin, partialOk)) return { verdict: 'incomplete', release: -1, failures: [] }
  const fail = [...markupFailures(obs), ...headers]
  const docs = list.releases.filter((r) => !r.withdrawn).flatMap((r) => Object.values(r.origins[origin]?.files ?? {}).filter((d) => d.kind === 'document'))
  if (!docs.some((d) => isPrefix(obs.elements ?? [], d.elements))) fail.push({ rule: 'elements', got: (obs.elements ?? []).length })
  const inline = new Set(docs.flatMap((d) => d.scripts.filter((x) => x.sha256).map((x) => x.sha256)))
  const srcs = new Set(docs.flatMap((d) => d.scripts.filter((x) => x.src).map((x) => x.src)))
  const strange = (obs.scripts ?? []).filter((x) => (x.src != null ? !srcs.has(x.src) : !inline.has(x.sha256)))
  if (strange.length) fail.push({ rule: 'scripts', got: strange })
  if (!fail.length) fail.push({ rule: 'elements', why: 'no listed document starts this way' })
  return { verdict: 'mismatch', release: -1, failures: fail }
}

/** Which observations were actually made, for the record. A value that was not observed is NOT a pass where the page must have it (observationFailures). */
export function observed(obs) {
  return {
    bytes: !!obs.bytes, size: obs.size > 0, scripts: Array.isArray(obs.scripts), csp: obs.csp != null,
    workers: Array.isArray(obs.workers), cache: Array.isArray(obs.cache),
  }
}
