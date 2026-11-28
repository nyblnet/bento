// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The tripwire's eyes: a content script on bento/home's library and frame
// pages, in the ISOLATED world, from document_start. It observes; it changes
// nothing in the page. It reports TWICE: an early report from inside the
// MutationObserver callback each time a script is first seen or grows, or a
// flag is raised (that message leaves BEFORE the script runs, so a script the
// observer saw cannot stop the record by navigating away, to a blob: document
// say), and a full report once the page leaves the loading state. NOT covered:
// a script inside a declarative shadow root runs before the observer can see
// it (attaching the root changes nothing the observer watches). The extension judges both (tripwire.js,
// tripwire-judge.js); an early report with no full report after it is judged
// on its own.
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
// On the LIBRARY origin it runs only in the top frame (the honest library is
// never framed: frame-ancestors 'none'), and also in a blob:/about: document
// of that origin (match_origin_as_fallback), which the honest library never
// makes: that alone is reported.
//
// The frame page is an opaque origin (its CSP sandbox), so it has no cache,
// no worker and no same-origin fetch: there the parse, the size and the
// headers are what is observed.
(() => {
  'use strict'
  if (globalThis.__bentoTripwire) return
  globalThis.__bentoTripwire = true
  const opaque = self.origin === 'null'
  // the library is a top-level page; a framed copy is somebody else's page
  if (!opaque && window !== window.top) return

  const WAIT_MS = 30000 // a page that never finishes parsing is judged on what it parsed
  // caps: an observation is bounded, and going over a cap is itself a finding
  const MAX_SCRIPTS = 64, MAX_FLAGS = 64, MAX_CACHE = 200, MAX_STR = 512, MAX_ELEMENTS = 4096, MAX_TEXT = 4 * 1024 * 1024
  // N1: the ELEMENT SEQUENCE, tag names in the order the parser inserted them (without html, head and
  // body, which it may imply). Every early report carries what is new since the last, so the extension
  // sees the parse stop matching a listed document as it happens, whatever comes next.
  const IMPLIED = new Set(['html', 'head', 'body'])
  const elements = []
  const inSeq = new WeakSet()
  let elementsSent = 0
  const seen = [] // script entries in insertion order
  const byEl = new Map()
  const flags = new Set()
  const FRAMEY = new Set(['iframe', 'frame', 'object', 'embed', 'applet', 'portal', 'fencedframe', 'base'])
  const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'data', 'xlink:href', 'srcdoc']
  const cut = (x) => String(x).slice(0, MAX_STR)
  const flag = (f) => { if (flags.size < MAX_FLAGS) flags.add(cut(f)); else flags.add('over-cap:flags') }

  // SHA-256, synchronous: the early report must leave inside the observer
  // callback, before the script it describes runs, so it cannot await
  // crypto.subtle.
  const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2])
  function sha256Sync(str) {
    const m = new TextEncoder().encode(str)
    const n = ((m.length + 9 + 63) >> 6) << 6
    const b = new Uint8Array(n); b.set(m); b[m.length] = 0x80
    const bits = m.length * 8
    const dv = new DataView(b.buffer)
    dv.setUint32(n - 8, Math.floor(bits / 0x100000000)); dv.setUint32(n - 4, bits >>> 0)
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
    const w = new Uint32Array(64)
    const r = (x, k) => (x >>> k) | (x << (32 - k))
    for (let o = 0; o < n; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4)
      for (let i = 16; i < 64; i++) {
        const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10)
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
      }
      let [a, bb, c, d, e, f, g, h] = H
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0
        const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0
      }
      H[0] += a; H[1] += bb; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h
    }
    return [...H].map((x) => x.toString(16).padStart(8, '0')).join('')
  }

  const scriptText = (el) => el.textContent ?? ''
  let dirty = false
  function noteScript(el) {
    let e = byEl.get(el)
    const text = scriptText(el)
    if (!e) {
      if (seen.length >= MAX_SCRIPTS) { flag('over-cap:scripts'); return }
      e = { el, src: el.getAttribute('src'), text }
      byEl.set(el, e)
      seen.push(e)
      dirty = true
      return
    }
    // the parser only ever APPENDS to a script it is still reading
    if (text !== e.text) {
      if (!text.startsWith(e.text)) flag('script-rewritten')
      e.text = text
      dirty = true
    }
  }
  // a shadow root (declarative or attached) hides its markup from the observer
  const shadowOf = (el) => { try { return chrome.dom?.openOrClosedShadowRoot?.(el) ?? el.shadowRoot } catch { return el.shadowRoot } }
  function noteElement(el) {
    const name = el.localName
    if (name === 'script') noteScript(el)
    if (FRAMEY.has(name)) flag(`element:${name}`)
    if (name === 'template' && (el.hasAttribute('shadowrootmode') || el.hasAttribute('shadowroot'))) flag('shadow-root')
    if (shadowOf(el)) flag('shadow-root')
    if (name === 'meta') {
      const eq = (el.getAttribute('http-equiv') ?? '').toLowerCase()
      if (eq && eq !== 'content-security-policy') flag(`meta:${eq}`)
    }
    for (const a of el.attributes ?? []) {
      const n = a.name.toLowerCase()
      if (n.startsWith('on')) flag(`handler:${name}.${n}`)
      if (URL_ATTRS.includes(n) && /^\s*javascript:/i.test(a.value)) flag(`javascript-url:${name}.${n}`)
    }
  }
  const recent = new Set() // elements added lately: a declarative shadow root is attached after its host is inserted
  // every element the observer ever walked, so a host the page removes is still checked at report time
  const walked = []
  function walk(node) {
    if (node.nodeType !== 1) {
      // text arriving inside a script the parser is still reading
      const p = node.parentNode
      if (p && p.nodeType === 1 && p.localName === 'script') noteScript(p)
      return
    }
    noteElement(node); recent.add(node); walked.push(node); sequence(node)
    for (const el of node.querySelectorAll('*')) { noteElement(el); recent.add(el); walked.push(el); sequence(el) }
  }
  function sequence(el) {
    if (inSeq.has(el) || IMPLIED.has(el.localName)) return
    inSeq.add(el)
    if (elements.length >= MAX_ELEMENTS) { flag('over-cap:elements'); return }
    elements.push(el.localName)
    dirty = true
  }
  // The last script, while it is the last thing parsed, may still be arriving: its text goes to the
  // extension as it grows, so a visit cut short mid-script can be told from a script that ran.
  let tailIndex = -1, tailSent = 0
  function tail() {
    const e = seen.at(-1)
    if (!e || e.src != null || elements.at(-1) !== 'script' || e.el !== lastScriptEl()) return null
    const i = seen.length - 1
    if (i !== tailIndex) { tailIndex = i; tailSent = 0 }
    if (e.text.length > MAX_TEXT || e.text.length === tailSent) return null
    const t = { index: i, from: tailSent, text: e.text.slice(tailSent) }
    tailSent = e.text.length
    return t
  }
  const lastScriptEl = () => { const all = document.getElementsByTagName('script'); return all[all.length - 1] }
  const scriptList = () => seen.map((e) => (e.src != null ? { src: cut(e.src) } : { sha256: sha256Sync(e.text), length: e.text.length }))
  let lastEarly = ''
  function early() {
    // leaves now, inside the observer callback, before the script just seen can run
    const payload = { v: 1, url: location.href.split('#')[0], timeOrigin: performance.timeOrigin, scripts: scriptList(), flags: [...flags], elements: elements.slice(elementsSent), elementsFrom: elementsSent, tail: tail() }
    const key = JSON.stringify(payload)
    if (key === lastEarly) return
    lastEarly = key
    elementsSent = elements.length
    try { chrome.runtime.sendMessage({ op: 'tripwire.early', payload }).catch(() => {}) } catch { /* the extension is reloading */ }
  }
  function onRecords(records) {
    const before = flags.size
    for (const r of records) {
      if (r.type === 'childList') {
        for (const n of r.addedNodes) walk(n)
        if (r.target.nodeType === 1 && r.target.localName === 'script') noteScript(r.target)
        if (r.target.nodeType === 1) recent.add(r.target)
      } else if (r.type === 'characterData') {
        const p = r.target.parentNode
        if (p && p.nodeType === 1 && p.localName === 'script') noteScript(p)
      } else if (r.type === 'attributes' && r.target.nodeType === 1) {
        noteElement(r.target)
      }
    }
    for (const el of recent) if (shadowOf(el)) flag('shadow-root')
    if (recent.size > 256) recent.clear()
    if (dirty || flags.size !== before) { dirty = false; early() }
  }
  const mo = new MutationObserver(onRecords)
  mo.observe(document, { childList: true, subtree: true, characterData: true, attributes: true })
  if (document.documentElement) walk(document.documentElement)
  // "visit started": a record exists whatever the page does next, even if nothing reaches the observer
  early()
  // A visit that ends early (closed, navigated away) is marked as such, and says what it had.
  let left = false
  addEventListener('pagehide', () => { left = true; early() }, { capture: true })
  // a document the honest library never makes: blob:, about:, data: on its origin
  if (!/^https?:$/.test(location.protocol)) { flag(`document:${location.protocol}`); early() }

  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const sha = async (data) => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data))
  // a response the server holds open never settles a cached read: every wait is bounded, generously,
  // because a busy machine is slow and a timed-out read is a finding, not a pass
  const bounded = (p, ms = 15000) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timed out')), ms))])
  const cached = (url) => bounded(fetch(url, { cache: 'only-if-cached', mode: 'same-origin', credentials: 'same-origin', redirect: 'manual' }))

  let sent = false
  async function report(complete) {
    if (sent) return
    sent = true
    onRecords(mo.takeRecords())
    mo.disconnect()
    // any shadow root on the page now, or on any element the observer ever walked (a host may be gone)
    for (const el of [...document.querySelectorAll('*'), ...walked]) if (shadowOf(el)) { flag('shadow-root'); break }
    const errors = []
    const scripts = []
    for (const e of seen) {
      if (e.src != null) {
        let src = e.src, h = null
        try {
          const u = new URL(e.src, location.href)
          src = u.origin === location.origin ? u.pathname : u.href
          if (!opaque && u.origin === location.origin) { const r = await cached(u.href); if (r.ok) h = await sha(await bounded(r.arrayBuffer())) }
        } catch { /* unread: judged by path only */ }
        scripts.push(h ? { src: cut(src), sha256: h } : { src: cut(src) })
      } else scripts.push({ sha256: await sha(e.text) })
    }
    const nav = performance.getEntriesByType('navigation')[0]
    // N4: cut short = the page was left, the parse never ended, or the response never did
    const aborted = left || !complete || (nav ? nav.responseEnd === 0 : false)
    const lastEl = seen.at(-1)
    const partial = aborted && lastEl && lastEl.src == null && elements.at(-1) === 'script' && lastEl.text.length <= MAX_TEXT
      ? { index: seen.length - 1, text: lastEl.text } : null
    const out = {
      v: 1, complete, aborted, partial, elements: elements.slice(), url: location.href.split('#')[0], timeOrigin: performance.timeOrigin,
      size: nav?.decodedBodySize ?? 0, status: nav?.responseStatus ?? 0, viaWorker: (nav?.workerStart ?? 0) > 0,
      scripts, flags: [...flags], bytes: null, workers: null, cache: null, errors,
    }
    if (!opaque && /^https?:$/.test(location.protocol)) {
      try {
        const r = await cached(out.url)
        if (r.ok) out.bytes = { sha256: await sha(await bounded(r.arrayBuffer())), csp: r.headers.get('content-security-policy') }
        else errors.push(`bytes: ${r.status}`)
      } catch (e) { errors.push(`bytes: ${e?.message ?? e}`) }
      try {
        const regs = await bounded(navigator.serviceWorker.getRegistrations())
        out.workers = []
        for (const reg of regs) for (const w of [reg.installing, reg.waiting, reg.active]) if (w && out.workers.length < 16) out.workers.push({ scriptURL: cut(w.scriptURL), scope: cut(reg.scope) })
      } catch (e) { errors.push(`workers: ${e?.message ?? e}`) }
      try {
        out.cache = []
        outer: for (const name of await bounded(caches.keys())) {
          const c = await caches.open(name)
          for (const req of await c.keys()) {
            if (out.cache.length >= MAX_CACHE) { out.flags.push('over-cap:cache'); break outer }
            const res = await c.match(req)
            out.cache.push({ cache: cut(name), url: cut(req.url), sha256: res ? await sha(await res.arrayBuffer()) : '' })
          }
        }
      } catch (e) { out.cache = null; errors.push(`cache: ${e?.message ?? e}`) }
    }
    out.errors = errors.map(cut).slice(0, 10)
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
