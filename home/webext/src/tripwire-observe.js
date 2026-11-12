// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The tripwire's eyes: a content script on bento/home's library and frame
// pages, in the ISOLATED world, from document_start. It observes; it changes
// nothing in the page, and it reports one observation to the extension, which
// judges it (tripwire.js, tripwire-judge.js).
//
// WHAT MV3 LETS AN EXTENSION SEE, measured in Chromium (rig: scripts/
// test-webext-tripwire-browser.mjs). There is no API for "the bytes this page
// was built from" (webRequest has no body in Chrome; only the debugger
// protocol does, behind a banner). So the tripwire looks four ways:
//
//  1. THE PARSE. A MutationObserver from document_start sees every element as
//     the parser inserts it, and its records are delivered before a
//     parser-inserted script runs (the microtask checkpoint before execution),
//     so the text of each <script> is read before the page's own code can
//     touch it. Whatever served the page (network, HTTP cache, a service
//     worker), this is what the browser parsed. A script whose text later
//     changes in a way that is not the parser appending more of it is flagged.
//  2. THE BYTES, from the HTTP cache: fetch(location, only-if-cached) from
//     this content script returns the navigation's own response (measured:
//     same bytes, same headers) when the browser kept it, with no new request
//     a server could answer differently. MEASURED: this fetch does NOT pass
//     through the page's service worker. Under a worker it reads what the
//     network last served (the worker's own precache fetch, say), not what
//     the worker answered; that answer is covered by 3, 4 and the parse.
//  3. THE SIZE: the navigation timing's decodedBodySize is the length of the
//     body the browser parsed, whoever served it.
//  4. THE WORKERS AND THE CACHE the library's service worker serves from: the
//     registrations' script URLs, and every Cache Storage entry, hashed.
// The navigation's own headers come from webRequest in the background
// (onHeadersReceived), which does not see a navigation a worker answered.
//
// The frame page is an opaque origin (its CSP sandbox), so it has no cache,
// no worker and no same-origin fetch: there the parse, the size and the
// headers are what is observed.
(() => {
  'use strict'
  if (globalThis.__bentoTripwire) return
  globalThis.__bentoTripwire = true

  const WAIT_MS = 30000 // a page that never finishes parsing is judged on what it parsed
  const seen = [] // script entries in insertion order
  const byEl = new Map()
  const flags = new Set()
  const FRAMEY = new Set(['iframe', 'frame', 'object', 'embed', 'applet', 'portal', 'fencedframe', 'base'])
  const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'data', 'xlink:href', 'srcdoc']

  const scriptText = (el) => el.textContent ?? ''
  function noteScript(el) {
    let e = byEl.get(el)
    const text = scriptText(el)
    if (!e) {
      e = { el, src: el.getAttribute('src'), text }
      byEl.set(el, e)
      seen.push(e)
      return
    }
    // the parser only ever APPENDS to a script it is still reading
    if (text !== e.text) {
      if (!text.startsWith(e.text)) flags.add('script-rewritten')
      e.text = text
    }
  }
  function noteElement(el) {
    const name = el.localName
    if (name === 'script') noteScript(el)
    if (FRAMEY.has(name)) flags.add(`element:${name}`)
    if (name === 'meta') {
      const eq = (el.getAttribute('http-equiv') ?? '').toLowerCase()
      if (eq && eq !== 'content-security-policy') flags.add(`meta:${eq}`)
    }
    for (const a of el.attributes ?? []) {
      const n = a.name.toLowerCase()
      if (n.startsWith('on')) flags.add(`handler:${name}.${n}`)
      if (URL_ATTRS.includes(n) && /^\s*javascript:/i.test(a.value)) flags.add(`javascript-url:${name}.${n}`)
    }
  }
  function walk(node) {
    if (node.nodeType !== 1) {
      // text arriving inside a script the parser is still reading
      const p = node.parentNode
      if (p && p.nodeType === 1 && p.localName === 'script') noteScript(p)
      return
    }
    noteElement(node)
    for (const el of node.querySelectorAll('*')) noteElement(el)
  }
  function onRecords(records) {
    for (const r of records) {
      if (r.type === 'childList') {
        for (const n of r.addedNodes) walk(n)
        if (r.target.nodeType === 1 && r.target.localName === 'script') noteScript(r.target)
      } else if (r.type === 'characterData') {
        const p = r.target.parentNode
        if (p && p.nodeType === 1 && p.localName === 'script') noteScript(p)
      } else if (r.type === 'attributes' && r.target.nodeType === 1) {
        noteElement(r.target)
      }
    }
  }
  const mo = new MutationObserver(onRecords)
  mo.observe(document, { childList: true, subtree: true, characterData: true, attributes: true })
  if (document.documentElement) walk(document.documentElement)

  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const sha = async (data) => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data))
  const cached = (url) => fetch(url, { cache: 'only-if-cached', mode: 'same-origin', credentials: 'same-origin', redirect: 'manual' })

  let sent = false
  async function report(complete) {
    if (sent) return
    sent = true
    onRecords(mo.takeRecords())
    mo.disconnect()
    const errors = []
    const opaque = self.origin === 'null'
    const scripts = []
    for (const e of seen) {
      if (e.src != null) {
        let src = e.src, h = null
        try {
          const u = new URL(e.src, location.href)
          src = u.origin === location.origin ? u.pathname : u.href
          if (!opaque && u.origin === location.origin) { const r = await cached(u.href); if (r.ok) h = await sha(await r.arrayBuffer()) }
        } catch { /* unread: judged by path only */ }
        scripts.push(h ? { src, sha256: h } : { src })
      } else scripts.push({ sha256: await sha(e.text) })
    }
    const nav = performance.getEntriesByType('navigation')[0]
    const out = {
      v: 1, complete, url: location.href.split('#')[0], timeOrigin: performance.timeOrigin,
      size: nav?.decodedBodySize ?? 0, status: nav?.responseStatus ?? 0, viaWorker: (nav?.workerStart ?? 0) > 0,
      scripts, flags: [...flags], bytes: null, workers: null, cache: null, errors,
    }
    if (!opaque) {
      try {
        const r = await cached(out.url)
        if (r.ok) out.bytes = { sha256: await sha(await r.arrayBuffer()), csp: r.headers.get('content-security-policy') }
        else errors.push(`bytes: ${r.status}`)
      } catch (e) { errors.push(`bytes: ${e?.message ?? e}`) }
      try {
        const regs = await navigator.serviceWorker.getRegistrations()
        out.workers = []
        for (const reg of regs) for (const w of [reg.installing, reg.waiting, reg.active]) if (w) out.workers.push({ scriptURL: w.scriptURL, scope: reg.scope })
      } catch (e) { errors.push(`workers: ${e?.message ?? e}`) }
      try {
        out.cache = []
        for (const name of await caches.keys()) {
          const c = await caches.open(name)
          for (const req of await c.keys()) {
            const res = await c.match(req)
            out.cache.push({ cache: name, url: req.url, sha256: res ? await sha(await res.arrayBuffer()) : '' })
            if (out.cache.length > 500) { errors.push('cache: more than 500 entries'); break }
          }
        }
      } catch (e) { out.cache = null; errors.push(`cache: ${e?.message ?? e}`) }
    }
    try { await chrome.runtime.sendMessage({ op: 'tripwire.observe', payload: out }) } catch { /* the extension is reloading */ }
  }
  // Polled as well as listened for: the page's own listener on window could stop
  // the event before it reaches ours, but it cannot stop readyState changing.
  const started = Date.now()
  const tick = setInterval(() => {
    if (document.readyState !== 'loading') { clearInterval(tick); void report(true) }
    else if (Date.now() - started > WAIT_MS) { clearInterval(tick); void report(false) }
  }, 200)
  document.addEventListener('DOMContentLoaded', () => { clearInterval(tick); void report(true) }, { once: true })
})()
