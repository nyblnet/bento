// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The tripwire, background half: takes the content script's observation
// (tripwire-observe.js), adds what only the extension can see (the
// navigation's headers from webRequest, the worker scripts' bytes), fetches
// the signed release list, judges (tripwire-judge.js), RECORDS every verdict,
// and WARNS loudly on a mismatch. It never changes the page, its caches or its
// workers: a tripwire that repairs things also hides them.
//
// No state between messages (background.js rule 1): the headers wait in
// storage.session, the list and the record in storage.local.

import { t } from './i18n.js'
import { acceptServed, verifyServed, judge, observed, REFRESH_MS } from './tripwire-judge.js'
import { KEY, LIBRARY_ORIGIN, FRAME_ORIGINS, LIST_URL } from './tripwire-config.js'

export const LOG_KEY = 'tripwireLog'
const LIST_KEY = 'tripwireList'
const LOG_MAX = 100
const HEADERS_PREFIX = 'twh:'
const WARNED_PREFIX = 'tww:'
export const NOTE_PREFIX = 'bento-tw-'

const roleOf = (origin) => (origin === LIBRARY_ORIGIN ? 'library' : FRAME_ORIGINS.includes(origin) ? 'frame' : null)
const patterns = () => [LIBRARY_ORIGIN, ...FRAME_ORIGINS].map((o) => `${o}/*`)
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
const sha = async (buf) => hex(await crypto.subtle.digest('SHA-256', buf))
const noHash = (u) => u.split('#')[0]

/** Navigation headers, kept for the content script's report. Observing only: no blocking listener. */
function onHeaders(d) {
  if (d.type !== 'main_frame' && d.type !== 'sub_frame') return
  let origin
  try { origin = new URL(d.url).origin } catch { return }
  if (!roleOf(origin)) return
  const csp = (d.responseHeaders ?? []).filter((h) => h.name.toLowerCase() === 'content-security-policy').map((h) => h.value ?? '')
  void chrome.storage.session.set({ [`${HEADERS_PREFIX}${d.tabId}:${d.frameId}`]: { url: noHash(d.url), at: d.timeStamp, status: d.statusCode, csp } })
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
    await chrome.storage.local.set({ [LIST_KEY]: { ...r.held, fetchedAt: Date.now() } })
    return { status: 'ok', list: r.list, held: r.held }
  }
  if (r.status === 'same' && current) await chrome.storage.local.set({ [LIST_KEY]: { ...current.held, fetchedAt: Date.now() } })
  return r
}

async function record(event) {
  const log = (await chrome.storage.local.get(LOG_KEY))[LOG_KEY] ?? []
  log.unshift(event)
  await chrome.storage.local.set({ [LOG_KEY]: log.slice(0, LOG_MAX) })
}

/** Once per browser session per distinct finding: the tab and the notification. The badge, every time. */
async function warn(event, tab, kind) {
  const warned = []
  try {
    if (tab?.id != null) {
      await chrome.action.setBadgeText({ tabId: tab.id, text: '!' })
      await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#B3261E' })
      await chrome.action.setTitle({ tabId: tab.id, title: t('twBadgeTitle') })
      warned.push('badge')
    }
  } catch { /* the tab is gone */ }
  const key = `${WARNED_PREFIX}${kind}:${event.url}:${event.serial}:${event.failures.map((f) => f.rule).join(',')}`
  if ((await chrome.storage.session.get(key))[key]) return [...warned, 'repeat']
  await chrome.storage.session.set({ [key]: event.id })
  const page = chrome.runtime.getURL(`src/tripwire.html?id=${encodeURIComponent(event.id)}`)
  const loud = kind !== 'outdated'
  try {
    const title = kind === 'invalid' ? t('twListTitle') : kind === 'outdated' ? t('twOldTitle') : t('twMismatchTitle')
    const message = kind === 'invalid' ? t('twListBody') : kind === 'outdated' ? t('twOldBody') : t('twMismatchBody')
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

/**
 * One observation from tripwire-observe.js. `sender` is the browser's (its
 * url and frame cannot be forged by the page); the payload is the content
 * script's, from the isolated world.
 */
export async function tripwireObserve(sender, obs, net = (u, o) => fetch(u, o)) {
  let origin
  try { origin = new URL(sender?.url).origin } catch { return { ok: false, reason: 'no sender' } }
  const role = roleOf(origin)
  if (!role || sender.id !== chrome.runtime.id || !obs || obs.v !== 1) return { ok: false, reason: 'not watched' }
  const now = Date.now()
  const url = noHash(sender.url)

  // the navigation's headers, if webRequest saw THIS navigation (a worker's answer it does not see)
  const hk = `${HEADERS_PREFIX}${sender.tab?.id}:${sender.frameId}`
  const h = (await chrome.storage.session.get(hk))[hk]
  const fresh = h && h.url === url && h.at >= obs.timeOrigin - 1000 && h.at <= obs.timeOrigin + 120000
  if (h) await chrome.storage.session.remove(hk)
  const page = {
    role, url, size: Number(obs.size) || 0,
    scripts: Array.isArray(obs.scripts) ? obs.scripts : [],
    flags: Array.isArray(obs.flags) ? obs.flags : [],
    bytes: role === 'library' && obs.bytes?.sha256 ? { sha256: obs.bytes.sha256 } : null,
    csp: fresh ? h.csp : role === 'library' && obs.bytes ? (obs.bytes.csp == null ? [] : [obs.bytes.csp]) : null,
    cspFrom: fresh ? 'navigation' : role === 'library' && obs.bytes ? 'cache' : null,
    workers: role === 'library' && Array.isArray(obs.workers) ? [] : null,
    cache: role === 'library' && Array.isArray(obs.cache) ? obs.cache.map((c) => ({ url: String(c.url), sha256: String(c.sha256) })) : null,
    viaWorker: !!obs.viaWorker, complete: !!obs.complete, errors: Array.isArray(obs.errors) ? obs.errors.slice(0, 10) : [],
  }
  // each worker script, as the network serves it now (the installed copy is not readable)
  for (const w of role === 'library' && Array.isArray(obs.workers) ? obs.workers : []) {
    let digest = null
    try {
      if (new URL(w.scriptURL).origin === LIBRARY_ORIGIN) {
        const r = await net(w.scriptURL, { cache: 'no-store', credentials: 'omit' })
        if (r.ok) digest = await sha(await r.arrayBuffer())
      }
    } catch { /* unread: judged by URL */ }
    page.workers.push({ scriptURL: String(w.scriptURL), sha256: digest })
  }

  let current = await heldList()
  let refresh = null
  if (!current || now - (current.held.fetchedAt ?? 0) > REFRESH_MS) {
    refresh = await refreshList(net, current)
    if (refresh.status === 'ok') current = await heldList()
  }
  let v = current ? judge(page, current.list, origin, now) : null
  // a mismatch, or an older release, is checked against a fresh list before anyone is told
  if (current && v.verdict !== 'ok' && !refresh) {
    refresh = await refreshList(net, current)
    if (refresh.status === 'ok') { current = await heldList(); v = judge(page, current.list, origin, now) }
  }

  const event = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, at: new Date(now).toISOString(),
    url, origin, role, verdict: v ? v.verdict : 'unchecked', release: v?.release ?? null, failures: v?.failures ?? [],
    serial: current?.list.serial ?? null, listAt: current?.list.at ?? null,
    list: refresh ? { status: refresh.status, why: refresh.why } : { status: 'held' },
    observed: observed(page), page,
  }
  const tab = sender.tab
  event.warned = []
  if (refresh?.status === 'invalid' || refresh?.status === 'conflict') event.warned.push(...await warn({ ...event, failures: [{ rule: `list-${refresh.status}` }] }, tab, 'invalid'))
  if (v?.verdict === 'mismatch') event.warned.push(...await warn(event, tab, 'mismatch'))
  else if (v?.verdict === 'outdated' && v.notify) event.warned.push(...await warn(event, tab, 'outdated'))
  await record(event)
  return { ok: true, verdict: event.verdict, id: event.id }
}

/** Listeners that must be registered at the top level of the worker. */
export function installTripwire() {
  if (typeof chrome === 'undefined') return
  chrome.webRequest?.onHeadersReceived.addListener(onHeaders, { urls: patterns(), types: ['main_frame', 'sub_frame'] }, ['responseHeaders', 'extraHeaders'])
  chrome.notifications?.onClicked?.addListener((id) => {
    if (!id.startsWith(NOTE_PREFIX)) return
    void chrome.tabs.create({ url: chrome.runtime.getURL(`src/tripwire.html?id=${encodeURIComponent(id.slice(NOTE_PREFIX.length))}`) })
  })
}
