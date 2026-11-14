// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The tripwire, background half: takes the content script's observations
// (tripwire-observe.js), adds what only the extension can see (the
// navigation's headers from webRequest, the worker scripts' bytes), fetches
// the signed release list, judges (tripwire-judge.js), RECORDS every verdict,
// and WARNS loudly on a mismatch. It never changes the page, its caches or its
// workers: a tripwire that repairs things also hides them.
//
// Two messages per page. `tripwire.early` leaves from inside the content
// script's observer callback, before each script runs; it is held as PENDING.
// `tripwire.observe` is the full report, which settles it. A pending early
// report that no full report settles within ORPHAN_MS (the page navigated
// away, to a blob: document say, or never finished) is judged on its own
// (judgeEarly), so a page that leaves after a script the observer saw is still
// on record. A script hidden in a declarative shadow root can run before any
// early report exists; that gap is stated, not closed, here.
//
// No state between messages (background.js rule 1): headers and pending
// reports wait in storage.session, the list and the record in storage.local.
// Every read-modify-write of storage goes through ONE promise chain (`serial`),
// so concurrent pages cannot overwrite each other's records.
//
// Loud warnings (a report tab, a sticky notification) come once per origin per
// browser session: the badge and the record come every time. A page anyone can
// link to or frame must not be able to open tabs at will.

import { t } from './i18n.js'
import { acceptServed, verifyServed, judge, judgeEarly, observed, classOf, REFRESH_MS } from './tripwire-judge.js'
import { KEY, LIBRARY_ORIGIN, FRAME_ORIGINS, LIST_URL } from './tripwire-config.js'

export const LOG_KEY = 'tripwireLog'
export const LIST_KEY = 'tripwireList'
const UNCHECKED_KEY = 'tripwireUncheckedSince'
const LOG_MAX = 100
const HEADERS_PREFIX = 'twh:'
const PENDING_PREFIX = 'twp:'
const WARNED_PREFIX = 'tww:'
export const NOTE_PREFIX = 'bento-tw-'
export const ORPHAN_MS = 10000
/** How long the list may be unreachable before the person is told nothing is being checked. */
export const NEVER_MS = 3 * 24 * 3600 * 1000
// caps, again here: the content script is ours, but its numbers are the page's doing
const MAX_SCRIPTS = 64, MAX_FLAGS = 64, MAX_CACHE = 200, MAX_WORKERS = 16, MAX_STR = 512, MAX_ELEMENTS = 4096, MAX_TEXT = 4 * 1024 * 1024

const roleOf = (origin) => (origin === LIBRARY_ORIGIN ? 'library' : FRAME_ORIGINS.includes(origin) ? 'frame' : null)
const patterns = () => [LIBRARY_ORIGIN, ...FRAME_ORIGINS].map((o) => `${o}/*`)
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
const sha = async (buf) => hex(await crypto.subtle.digest('SHA-256', buf))
const noHash = (u) => String(u).split('#')[0]
const cut = (x) => String(x).slice(0, MAX_STR)
const HEX = /^[0-9a-f]{64}$/

/** Element tag names, bounded; going over the bound is a flag. */
function capElements(list, flags) {
  const src = Array.isArray(list) ? list : []
  if (src.length > MAX_ELEMENTS) flags.push('over-cap:elements')
  return src.slice(0, MAX_ELEMENTS).map((x) => String(x).slice(0, 64))
}

/**
 * The published text of a listed inline script, fetched only to check a script
 * cut short (N4). Pinned by its name: a text whose sha256 is not its name is
 * not used. Kept for the worker's lifetime.
 */
const scriptTexts = new Map()
async function listedScriptText(net, sha256) {
  if (scriptTexts.has(sha256)) return scriptTexts.get(sha256)
  let text = null
  try {
    const r = await net(new URL(`scripts/${sha256}.js`, LIST_URL).href, { cache: 'no-store', credentials: 'omit' })
    if (r.ok) { const t = await r.text(); if (await sha(new TextEncoder().encode(t)) === sha256) text = t }
  } catch { /* unread: no partial passes */ }
  if (text != null) scriptTexts.set(sha256, text)
  return text
}
/** partialOk for the judge: is `partial` an exact, strictly shorter prefix of a listed script it could be? */
async function partialChecker(net, obs, list, origin) {
  const ok = new Set()
  const p = obs.partial
  if (!p || typeof p.text !== 'string' || !Number.isSafeInteger(p.index)) return () => false
  const shas = new Set()
  for (const r of list.releases) for (const d of Object.values(r.origins[origin]?.files ?? {})) { const x = d.scripts?.[p.index]; if (x?.sha256) shas.add(x.sha256) }
  for (const h of shas) { const t = await listedScriptText(net, h); if (t != null && p.text.length < t.length && t.startsWith(p.text)) ok.add(h) }
  return (h, text) => ok.has(h) && text === p.text
}

/** One chain for every storage read-modify-write. */
let chain = Promise.resolve()
const serial = (fn) => { const r = chain.then(fn, fn); chain = r.then(() => {}, () => {}); return r }

/** The sender's role, or null. The library is judged only as a top-level page, the frame page only in a frame. */
function senderRole(sender) {
  let origin, scheme
  try { const u = new URL(sender?.url); origin = u.origin; scheme = u.protocol } catch { return null }
  // An about: (or blob:) document has no origin in its URL ("about:blank" parses to "null"); the
  // browser's sender.origin is the one it really runs in, the library's for a popup the library
  // opened. The frame page keeps its URL: it is an opaque origin by design (sender.origin "null").
  if (scheme === 'about:' || scheme === 'blob:') origin = sender.origin
  const role = roleOf(origin)
  if (!role || sender.id !== chrome.runtime.id) return null
  // the library is a top-level page (frame-ancestors 'none'); the frame page only ever runs framed
  if (role === 'library' && sender.frameId !== 0) return null
  if (role === 'frame' && sender.frameId === 0) return null
  return { role, origin }
}
const docKey = (sender, obs) => `${PENDING_PREFIX}${sender.documentId ?? `${sender.tab?.id}:${sender.frameId}:${obs?.timeOrigin}`}`

/** Bounded copies of what the page reported; going over a bound is a flag. */
function capScripts(list, flags) {
  const src = Array.isArray(list) ? list : []
  if (src.length > MAX_SCRIPTS) flags.push('over-cap:scripts')
  return src.slice(0, MAX_SCRIPTS).map((s) => (s && s.src != null
    ? (HEX.test(s.sha256 ?? '') ? { src: cut(s.src), sha256: s.sha256 } : { src: cut(s.src) })
    : { sha256: HEX.test(s?.sha256 ?? '') ? s.sha256 : '' }))
}
function capFlags(list) {
  const src = Array.isArray(list) ? list : []
  const out = src.slice(0, MAX_FLAGS).map(cut)
  if (src.length > MAX_FLAGS) out.push('over-cap:flags')
  return out
}

/** Navigation headers, kept for the content script's report. Observing only: no blocking listener. */
function onHeaders(d) {
  if (d.type !== 'main_frame' && d.type !== 'sub_frame') return
  let origin
  try { origin = new URL(d.url).origin } catch { return }
  if (!roleOf(origin)) return
  const csp = (d.responseHeaders ?? []).filter((h) => h.name.toLowerCase() === 'content-security-policy').map((h) => cut(h.value ?? ''))
  const cacheControl = (d.responseHeaders ?? []).filter((h) => h.name.toLowerCase() === 'cache-control').map((h) => cut(h.value ?? ''))
  void chrome.storage.session.set({ [`${HEADERS_PREFIX}${d.tabId}:${d.frameId}`]: { url: noHash(d.url), at: d.timeStamp, status: d.statusCode, csp, cacheControl } })
}

/**
 * Who started the navigation (its Sec-Fetch-Site). MEASURED: a navigation
 * another site started (a link, a popup) is cached under a key the content
 * script's own fetch cannot reach, so its bytes are never readable; that alone
 * must not read as tampering. Observing only.
 */
const REQUEST_PREFIX = 'twq:'
function onRequest(d) {
  if (d.type !== 'main_frame') return
  let origin
  try { origin = new URL(d.url).origin } catch { return }
  if (roleOf(origin) !== 'library') return
  const site = (d.requestHeaders ?? []).find((h) => h.name.toLowerCase() === 'sec-fetch-site')?.value ?? null
  void chrome.storage.session.set({ [`${REQUEST_PREFIX}${d.tabId}:${d.frameId}`]: { url: noHash(d.url), at: d.timeStamp, site: site == null ? null : cut(site) } })
}

/** The held list (re-verified), or null. */
async function heldList() {
  const held = (await chrome.storage.local.get(LIST_KEY))[LIST_KEY]
  if (!held?.payload) return null
  try { return { held, list: await verifyServed(JSON.stringify({ payload: held.payload, sig: held.sig }), KEY) } } catch { return null }
}

/** Fetch the list and decide what it means. Returns { status, list?, held? }. */
async function refreshList(net, current) {
  let raw
  try {
    const res = await net(LIST_URL, { cache: 'no-store', credentials: 'omit' })
    if (!res.ok) return { status: 'unreachable', why: `HTTP ${res.status}` }
    raw = await res.text()
  } catch (e) { return { status: 'unreachable', why: String(e?.message ?? e) } }
  const r = await acceptServed(current?.held ?? null, raw, KEY)
  if (r.status === 'ok') {
    await serial(() => chrome.storage.local.set({ [LIST_KEY]: { ...r.held, fetchedAt: Date.now() } }))
    return { status: 'ok', list: r.list, held: r.held }
  }
  if (r.status === 'same' && current) await serial(() => chrome.storage.local.set({ [LIST_KEY]: { ...current.held, fetchedAt: Date.now() } }))
  return r
}

/** Append to the record. If the event cannot be stored whole, a compact copy is (never nothing). */
function record(event) {
  return serial(async () => {
    const log = (await chrome.storage.local.get(LOG_KEY))[LOG_KEY] ?? []
    try {
      await chrome.storage.local.set({ [LOG_KEY]: [event, ...log].slice(0, LOG_MAX) })
    } catch {
      const { page, ...compact } = event
      compact.compact = true
      compact.failures = (event.failures ?? []).slice(0, 8).map((f) => ({ rule: f.rule }))
      await chrome.storage.local.set({ [LOG_KEY]: [compact, ...log].slice(0, LOG_MAX / 2) })
    }
  })
}

/** Has this finding been announced this session? Marks it as announced. */
const firstTime = (key) => serial(async () => {
  if ((await chrome.storage.session.get(key))[key]) return false
  await chrome.storage.session.set({ [key]: Date.now() })
  return true
})

/** The badge every time; the tab and the notification once per `onceKey` per session. */
async function warn(event, tab, kind, onceKey) {
  const warned = []
  try {
    if (tab?.id != null) {
      await chrome.action.setBadgeText({ tabId: tab.id, text: '!' })
      await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#B3261E' })
      await chrome.action.setTitle({ tabId: tab.id, title: t('twBadgeTitle') })
      warned.push('badge')
    }
  } catch { /* the tab is gone */ }
  if (!(await firstTime(`${WARNED_PREFIX}${onceKey}`))) return [...warned, 'repeat']
  const page = chrome.runtime.getURL(`src/tripwire.html?id=${encodeURIComponent(event.id)}`)
  const loud = kind === 'mismatch' || kind === 'invalid'
  try {
    const title = kind === 'invalid' ? t('twListTitle') : kind === 'outdated' ? t('twOldTitle') : kind === 'never' ? t('twNeverTitle') : t('twMismatchTitle')
    const message = kind === 'invalid' ? t('twListBody') : kind === 'outdated' ? t('twOldBody') : kind === 'never' ? t('twNeverBody') : t('twMismatchBody')
    await chrome.notifications.create(`${NOTE_PREFIX}${event.id}`, {
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'), title, message,
      requireInteraction: loud, priority: loud ? 2 : 0,
    })
    warned.push('notification')
  } catch { /* notifications off: the tab still says it */ }
  if (loud) {
    try {
      await chrome.tabs.create({ url: page, active: true, ...(tab?.id != null ? { openerTabId: tab.id, index: tab.index + 1 } : {}) })
      warned.push('tab')
    } catch { /* no window */ }
  }
  return warned
}

const newId = (now) => `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** A list could not be had: count how long, and say so once it has been too long (R3). */
async function noteUnchecked(event, tab, now) {
  const since = await serial(async () => {
    const s = (await chrome.storage.local.get(UNCHECKED_KEY))[UNCHECKED_KEY]
    if (s) return s
    await chrome.storage.local.set({ [UNCHECKED_KEY]: now })
    return now
  })
  if (now - since > NEVER_MS) event.warned.push(...await warn(event, tab, 'never', 'never'))
}

/** Settle the outcome of a judged event: record it, and warn as its verdict and list status ask. */
async function settle(event, tab, refresh, v, now) {
  event.warned = []
  if (refresh?.status === 'invalid' || refresh?.status === 'conflict') {
    event.warned.push(...await warn({ ...event, failures: [{ rule: `list-${refresh.status}` }] }, tab, 'invalid', 'list'))
  }
  // once per CLASS per origin per session (N4): a finding that only says "could not tell" never
  // silences one that says "this is not a release"
  event.class = v?.verdict === 'mismatch' ? classOf(event.failures) : null
  if (v?.verdict === 'mismatch') event.warned.push(...await warn(event, tab, 'mismatch', `loud:${event.class}:${event.origin}`))
  else if (v?.verdict === 'outdated' && v.notify) event.warned.push(...await warn(event, tab, 'outdated', `old:${event.origin}`))
  if (!v) await noteUnchecked(event, tab, now)
  else await serial(() => chrome.storage.local.remove(UNCHECKED_KEY))
  await record(event)
}

/** The held list, refreshed when missing or older than REFRESH_MS. */
async function listFor(net, now) {
  let current = await heldList()
  let refresh = null
  if (!current || now - (current.held.fetchedAt ?? 0) > REFRESH_MS) {
    refresh = await refreshList(net, current)
    if (refresh.status === 'ok') current = await heldList()
  }
  return { current, refresh }
}

/** Pending early reports no full report settled in time: judge each on its own. */
export async function sweepOrphans(net = (u, o) => fetch(u, o), now = Date.now()) {
  const due = await serial(async () => {
    const all = await chrome.storage.session.get(null)
    const keys = Object.keys(all).filter((k) => k.startsWith(PENDING_PREFIX) && typeof all[k] === 'object' && now - all[k].at >= ORPHAN_MS)
    const done = Object.keys(all).filter((k) => k.startsWith(PENDING_PREFIX) && typeof all[k] === 'number' && now - all[k] > 10 * ORPHAN_MS)
    if (keys.length || done.length) await chrome.storage.session.remove([...keys, ...done])
    return keys.map((k) => all[k])
  })
  for (const p of due) {
    const { current, refresh } = await listFor(net, now)
    const obsE = { ...p.obs, partial: p.tail ? { index: p.tail.index, text: p.tail.text } : null }
    const v = current ? judgeEarly(obsE, current.list, p.origin, await partialChecker(net, obsE, current.list, p.origin)) : null
    const event = {
      id: newId(now), at: new Date(now).toISOString(), url: p.url, origin: p.origin, role: p.role, early: true,
      verdict: v ? v.verdict : 'unchecked', release: null, failures: v?.failures ?? [],
      serial: current?.list.serial ?? null, listAt: current?.list.at ?? null,
      list: refresh ? { status: refresh.status, why: refresh.why } : { status: 'held' },
      observed: { scripts: true, flags: true, elements: true, bytes: false, size: false, csp: false, workers: false, cache: false },
      page: { ...p.obs, partial: obsE.partial ? { index: obsE.partial.index, length: obsE.partial.text.length } : null },
    }
    let tab = null
    try { tab = p.tabId != null ? await chrome.tabs.get(p.tabId) : null } catch { /* closed */ }
    await settle(event, tab ?? (p.tabId != null ? { id: p.tabId, index: p.tabIndex ?? 0 } : null), refresh, v, now)
  }
  return due.length
}

/** An early report: the parse so far, held until the full report settles it. */
export async function tripwireEarly(sender, obs) {
  const who = senderRole(sender)
  if (!who || !obs || obs.v !== 1) return { ok: false, reason: 'not watched' }
  const key = docKey(sender, obs)
  await serial(async () => {
    if ((await chrome.storage.session.get(`${key}:done`))[`${key}:done`]) return // the full report came first
    const prev = (await chrome.storage.session.get(key))[key]
    const flags = capFlags(obs.flags)
    // the element sequence arrives in pieces, in order: each report carries what is new
    let elements = prev?.obs.elements ?? []
    const delta = Array.isArray(obs.elements) ? obs.elements : []
    if (Number(obs.elementsFrom) !== elements.length) flags.push('early-gap')
    elements = capElements([...elements, ...delta], flags)
    // and the last script's text, while it may still be arriving
    let tail = prev?.tail ?? null
    const tn = obs.tail
    if (tn && Number.isSafeInteger(tn.index) && typeof tn.text === 'string') {
      const base = tail && tail.index === tn.index && tail.text.length === tn.from ? tail.text : (tn.from === 0 ? '' : null)
      tail = base == null || base.length + tn.text.length > MAX_TEXT ? null : { index: tn.index, text: base + tn.text }
    }
    const pending = {
      at: Date.now(), url: cut(noHash(sender.url)), origin: who.origin, role: who.role,
      tabId: sender.tab?.id ?? null, tabIndex: sender.tab?.index ?? 0, tail,
      obs: { role: who.role, url: cut(noHash(sender.url)), timeOrigin: Number(obs.timeOrigin) || 0, scripts: capScripts(obs.scripts, flags), flags: [...new Set([...(prev?.obs.flags ?? []), ...flags])], elements },
    }
    await chrome.storage.session.set({ [key]: pending })
  })
  setTimeout(() => { void sweepOrphans().catch(() => {}) }, ORPHAN_MS + 500)
  return { ok: true }
}

/**
 * One full observation from tripwire-observe.js. `sender` is the browser's
 * (its url and frame cannot be forged by the page); the payload is the content
 * script's, from the isolated world, bounded again here.
 */
export async function tripwireObserve(sender, obs, net = (u, o) => fetch(u, o)) {
  const who = senderRole(sender)
  if (!who || !obs || obs.v !== 1) return { ok: false, reason: 'not watched' }
  const { role, origin } = who
  const key = docKey(sender, obs)
  // settle this document's early report first, in the same chain it was written in
  await serial(() => chrome.storage.session.remove(key).then(() => chrome.storage.session.set({ [`${key}:done`]: Date.now() })))
  void sweepOrphans(net).catch(() => {})
  const now = Date.now()
  const url = cut(noHash(sender.url))

  // the navigation's headers, if webRequest saw THIS navigation (a worker's answer it does not see)
  const hk = `${HEADERS_PREFIX}${sender.tab?.id}:${sender.frameId}`
  const h = (await chrome.storage.session.get(hk))[hk]
  const fresh = h && h.url === url && h.at >= obs.timeOrigin - 1000 && h.at <= obs.timeOrigin + 120000
  if (h) await chrome.storage.session.remove(hk)
  const qk = `${REQUEST_PREFIX}${sender.tab?.id}:${sender.frameId}`
  const q = (await chrome.storage.session.get(qk))[qk]
  const crossSite = !!q && q.url === url && q.at >= obs.timeOrigin - 1000 && q.at <= obs.timeOrigin + 120000 && q.site === 'cross-site'
  if (q) await chrome.storage.session.remove(qk)
  const flags = capFlags(obs.flags)
  const scripts = capScripts(obs.scripts, flags)
  const cacheIn = role === 'library' && Array.isArray(obs.cache) ? obs.cache : null
  if (cacheIn && cacheIn.length > MAX_CACHE) flags.push('over-cap:cache')
  const workersIn = role === 'library' && Array.isArray(obs.workers) ? obs.workers : null
  if (workersIn && workersIn.length > MAX_WORKERS) flags.push('over-cap:workers')
  const page = {
    role, url, timeOrigin: Number(obs.timeOrigin) || 0, size: Number(obs.size) || 0, scripts, flags,
    elements: capElements(obs.elements, flags), aborted: obs.aborted === true,
    partial: obs.partial && Number.isSafeInteger(obs.partial.index) && typeof obs.partial.text === 'string' && obs.partial.text.length <= MAX_TEXT ? { index: obs.partial.index, text: obs.partial.text } : null,
    // a cross-site navigation's own response is not what the content script read (another, older one may be)
    bytes: role === 'library' && !crossSite && HEX.test(obs.bytes?.sha256 ?? '') ? { sha256: obs.bytes.sha256 } : null,
    csp: fresh ? h.csp : role === 'library' && obs.bytes && !crossSite ? (obs.bytes.csp == null ? [] : [cut(obs.bytes.csp)]) : null,
    cspFrom: fresh ? 'navigation' : role === 'library' && obs.bytes ? 'cache' : null,
    cacheControl: fresh && Array.isArray(h.cacheControl) ? h.cacheControl : null, crossSite,
    workers: workersIn ? [] : null,
    cache: cacheIn ? cacheIn.slice(0, MAX_CACHE).map((c) => ({ url: cut(c.url), sha256: cut(c.sha256) })) : null,
    viaWorker: !!obs.viaWorker, complete: obs.complete === true, errors: Array.isArray(obs.errors) ? obs.errors.slice(0, 10).map(cut) : [],
  }
  // each worker script, as the network serves it now (the installed copy is not readable)
  for (const w of (workersIn ?? []).slice(0, MAX_WORKERS)) {
    let digest = null
    try {
      if (new URL(w.scriptURL).origin === LIBRARY_ORIGIN) {
        const r = await net(w.scriptURL, { cache: 'no-store', credentials: 'omit' })
        if (r.ok) digest = await sha(await r.arrayBuffer())
      }
    } catch { /* unread: judged by URL */ }
    page.workers.push({ scriptURL: cut(w.scriptURL), sha256: digest })
  }

  let { current, refresh } = await listFor(net, now)
  let v = current ? judge(page, current.list, origin, now, await partialChecker(net, page, current.list, origin)) : null
  // a mismatch, or an older release, is checked against a fresh list before anyone is told
  if (current && v.verdict !== 'ok' && v.verdict !== 'unlisted' && !refresh) {
    refresh = await refreshList(net, current)
    if (refresh.status === 'ok') { current = await heldList(); v = judge(page, current.list, origin, now, await partialChecker(net, page, current.list, origin)) }
  }

  const event = {
    id: newId(now), at: new Date(now).toISOString(),
    url, origin, role, verdict: v ? v.verdict : 'unchecked', release: v?.release ?? null, failures: v?.failures ?? [],
    serial: current?.list.serial ?? null, listAt: current?.list.at ?? null,
    list: refresh ? { status: refresh.status, why: refresh.why } : { status: 'held' },
    observed: observed(page), page: { ...page, partial: page.partial ? { index: page.partial.index, length: page.partial.text.length } : null },
  }
  await settle(event, sender.tab, refresh, v, now)
  return { ok: true, verdict: event.verdict, id: event.id }
}

/** Listeners that must be registered at the top level of the worker. */
export function installTripwire() {
  if (typeof chrome === 'undefined') return
  chrome.webRequest?.onHeadersReceived.addListener(onHeaders, { urls: patterns(), types: ['main_frame', 'sub_frame'] }, ['responseHeaders', 'extraHeaders'])
  chrome.webRequest?.onSendHeaders.addListener(onRequest, { urls: patterns(), types: ['main_frame'] }, ['requestHeaders', 'extraHeaders'])
  chrome.notifications?.onClicked?.addListener((id) => {
    if (!id.startsWith(NOTE_PREFIX)) return
    void chrome.tabs.create({ url: chrome.runtime.getURL(`src/tripwire.html?id=${encodeURIComponent(id.slice(NOTE_PREFIX.length))}`) })
  })
  // a worker that restarted mid-wait still settles what was pending
  void sweepOrphans().catch(() => {})
}
