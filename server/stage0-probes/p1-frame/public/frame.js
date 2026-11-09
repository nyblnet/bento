// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// P1 frame probe, the FRAME's trusted script. Runs in a sandboxed frame with no
// allow-same-origin (an opaque origin), either loaded from the frame site
// (frame.html, CSP from the response header) or inlined by the top page as a
// srcdoc frame (CSP from a meta tag pinning this file's hash).
//
// 1. Measures, before any document byte exists: the frame's origin, whether
//    'self' and blob: scripts run, whether inline script and eval are refused,
//    whether storage throws, and who served the page (network / the frame
//    site's worker / srcdoc).
// 2. Tells the parent it is ready, receives ONE file's text, turns its inline
//    executable scripts into blob: scripts (the W2 pattern: the CSP refuses
//    inline), puts a small reporter first, and writes the document in.
// 3. The reporter (in the document's realm) posts events back to the parent:
//    boot, CSP violations, errors, popup, fullscreen, copy/paste, clipboard,
//    print, download, file input, drop. To the parent window only; no network.
//
// This file is inlined into a srcdoc by top.js, so it must never contain a
// literal script end tag (built by concatenation below).

(() => {
  'use strict'
  const PARENT = window.parent
  const post = (m) => { try { PARENT.postMessage(m, '*') } catch { /* parent gone */ } }
  const params = new URLSearchParams(location.search)
  const SCRIPT = 'script'
  const END = '</' + SCRIPT

  const checks = { origin: String(self.origin), servedBy: '?', self: '?', blob: '?', inline: '?', eval: '?', storage: '?' }
  const meta = document.querySelector('meta[name="probe-served-by"]')
  checks.servedBy = meta ? meta.getAttribute('content') : 'unknown'
  // Loaded by src => 'self' worked. Inlined in a srcdoc => 'self' was not used.
  checks.self = document.currentScript && document.currentScript.src ? 'ok' : 'n/a(srcdoc hash)'
  try { localStorage.setItem('probe', '1'); checks.storage = 'works' } catch (e) { checks.storage = 'throws ' + (e && e.name) }
  try { const f = new Function('return 1'); checks.eval = f() === 1 ? 'RAN' : '?' } catch { checks.eval = 'blocked' }

  function scriptRuns(make) {
    return new Promise((resolve) => {
      const key = '__probe' + Math.random().toString(36).slice(2)
      const s = document.createElement(SCRIPT)
      let done = false
      const finish = (v) => { if (!done) { done = true; resolve(v) } }
      make(s, 'window.' + key + '=1')
      s.onerror = () => finish('blocked')
      document.head.appendChild(s)
      // inline scripts run synchronously on insertion; blob ones fire load/error
      if (!s.src) finish(window[key] === 1 ? 'RAN' : 'blocked')
      else s.onload = () => finish(window[key] === 1 ? 'ok' : 'loaded-no-run')
      setTimeout(() => finish(window[key] === 1 ? 'ok' : 'timeout'), 3000)
    })
  }

  // --- WebMCP page (C2): try to register a tool inside the frame ---------------
  if (params.get('webmcp') === '1') {
    const mc = (document.modelContext && 'document.modelContext') || (navigator.modelContext && 'navigator.modelContext') || 'absent'
    let reg = 'n/a'
    const api = document.modelContext || navigator.modelContext
    const tell = () => post({ kind: 'probe-webmcp-frame', api: mc, register: reg, origin: checks.origin })
    if (api && typeof api.registerTool === 'function') {
      try {
        const r = api.registerTool({
          name: 'probe_frame_tool',
          description: 'Stage-0 probe: a tool registered INSIDE the sandboxed document frame. Returns a fixed string.',
          inputSchema: { type: 'object', properties: {} },
          execute: async () => ({ content: [{ type: 'text', text: 'probe_frame_tool answered' }] }),
        })
        Promise.resolve(r).then(() => { reg = 'ok'; tell() }, (e) => { reg = 'error: ' + (e && (e.name + ' ' + e.message)); tell() })
        reg = 'pending'
      } catch (e) { reg = 'error: ' + (e && (e.name + ' ' + e.message)) }
    } else if (api) reg = 'no registerTool'
    tell()
    document.body ? (document.body.textContent = 'WebMCP frame: ' + mc) : null
    return
  }

  // --- the reporter, written first into the document ----------------------------
  // Runs in the document's realm, before the document's own scripts.
  const REPORTER = `(function () {
  var P = window.parent, t0 = performance.now()
  function send(k, v) { try { P.postMessage({ kind: 'probe-ev', k: k, v: v }, '*') } catch (e) {} }
  document.addEventListener('securitypolicyviolation', function (e) { send('csp', e.violatedDirective + ' ' + String(e.blockedURI || '').slice(0, 60) + (e.lineNumber ? ' at line ' + e.lineNumber + ':' + e.columnNumber : '')) })
  window.addEventListener('error', function (e) { send('error', String(e.message || 'error').slice(0, 160)) })
  window.addEventListener('unhandledrejection', function (e) { var r = e.reason; send('error', 'rejection: ' + String(r && r.message || r).slice(0, 160)) })
  var wo = window.open
  window.open = function () {
    var w
    try { w = wo.apply(this, arguments) } catch (e) { send('popup', 'threw ' + e.name); throw e }
    send('popup', w ? 'opened' : 'null (blocked)')
    return w
  }
  var wp = window.print
  window.print = function () { send('print', 'print() called'); return wp.apply(this, arguments) }
  window.addEventListener('beforeprint', function () { send('print', 'beforeprint') })
  document.addEventListener('fullscreenchange', function () { send('fullscreen', document.fullscreenElement ? 'entered' : 'left') })
  document.addEventListener('fullscreenerror', function () { send('fullscreen', 'error (refused)') })
  document.addEventListener('webkitfullscreenchange', function () { send('fullscreen', document.webkitFullscreenElement ? 'entered' : 'left') })
  document.addEventListener('copy', function () { send('copy', 'event') }, true)
  document.addEventListener('cut', function () { send('copy', 'cut event') }, true)
  document.addEventListener('paste', function () { send('paste', 'event') }, true)
  if (navigator.clipboard) {
    ['writeText', 'write', 'readText', 'read'].forEach(function (m) {
      var f = navigator.clipboard[m]
      if (typeof f !== 'function') return
      navigator.clipboard[m] = function () {
        var p = f.apply(navigator.clipboard, arguments)
        p.then(function () { send('clipboard', m + ' ok') }, function (e) { send('clipboard', m + ' refused ' + (e && e.name)) })
        return p
      }
    })
  }
  var ac = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function () { if (this.download) send('download', 'anchor click'); return ac.apply(this, arguments) }
  document.addEventListener('click', function (e) { var a = e.target && e.target.closest && e.target.closest('a[download]'); if (a) send('download', 'a[download] click') }, true)
  if (typeof window.showSaveFilePicker === 'function') send('download', 'showSaveFilePicker present')
  document.addEventListener('change', function (e) { var t = e.target; if (t && t.type === 'file') send('fileinput', (t.files ? t.files.length : 0) + ' file(s) chosen') }, true)
  document.addEventListener('drop', function (e) { send('drop', (e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files.length : 0) + ' file(s) dropped') }, true)
  var n = 0, iv = setInterval(function () {
    n++
    if (window.bento && window.bento.doc) { clearInterval(iv); send('boot', { ms: Math.round(performance.now() - t0) }) }
    else if (n > 150) { clearInterval(iv); send('boot', { fail: 'no window.bento.doc after 30 s' }) }
  }, 200)
})()`

  // --- executable inline scripts -> blob: scripts ---------------------------------
  const JS_TYPES = /^(|module|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript|text\/jscript)$/i
  function attrValue(attrs, name) {
    const m = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(attrs)
    return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null
  }
  function blobURL(text) { return URL.createObjectURL(new Blob([text], { type: 'text/javascript' })) }
  function rewrite(html) {
    const lower = html.toLowerCase()
    const re = /<script\b([^>]*)>/gi
    let out = ''
    let at = 0
    let m
    let converted = 0
    while ((m = re.exec(html))) {
      const attrs = m[1]
      const bodyStart = m.index + m[0].length
      const close = lower.indexOf(END, bodyStart)
      if (close < 0) break
      const closeEnd = lower.indexOf('>', close) + 1
      re.lastIndex = closeEnd
      const type = (attrValue(attrs, 'type') || '').trim()
      if (attrValue(attrs, 'src') !== null || !JS_TYPES.test(type)) continue
      const kept = attrs.replace(/(?:^|\s)type\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '')
      out += html.slice(at, m.index) + '<' + SCRIPT + kept + (type.toLowerCase() === 'module' ? ' type="module"' : '') +
        ' src="' + blobURL(html.slice(bodyStart, close)) + '">' + END + '>'
      at = closeEnd
      converted++
    }
    out += html.slice(at)
    // the reporter goes first: after <head> if there is one, else after the doctype
    const tag = '<' + SCRIPT + ' src="' + blobURL(REPORTER) + '">' + END + '>'
    const head = /<head\b[^>]*>/i.exec(out)
    if (head) out = out.slice(0, head.index + head[0].length) + tag + out.slice(head.index + head[0].length)
    else {
      const dt = /^\s*<!doctype[^>]*>/i.exec(out)
      out = dt ? dt[0] + tag + out.slice(dt[0].length) : tag + out
    }
    return { out, converted }
  }

  let served = false
  addEventListener('message', (ev) => {
    if (served || ev.source !== PARENT) return
    const d = ev.data
    if (!d || d.kind !== 'probe-serve' || typeof d.html !== 'string') return
    served = true
    let r
    try { r = rewrite(d.html) } catch (e) { post({ kind: 'probe-serve-failed', reason: 'rewrite: ' + (e && e.message) }); return }
    if (!r.converted) { post({ kind: 'probe-serve-failed', reason: 'no executable script found in the file' }); return }
    document.open()
    document.write(r.out)
    document.close()
  })

  // The refused inline script and eval above each queue a violation event.
  // Wait for them before the document exists, or they would be counted as the
  // document's own violations.
  let preViolations = 0
  const onViolation = () => { preViolations++ }
  document.addEventListener('securitypolicyviolation', onViolation)
  Promise.all([
    scriptRuns((s, code) => { s.src = blobURL(code) }),
    scriptRuns((s, code) => { s.textContent = code }),
  ]).then(async ([blob, inline]) => {
    checks.blob = blob
    checks.inline = inline
    // Each refusal is reported once per policy that refuses it (a srcdoc frame
    // has two: the one it inherits and its own), so wait until the count
    // stops moving: at least one per refusal, then 200 ms of quiet (1.5 s cap).
    const expected = (inline === 'blocked' ? 1 : 0) + (checks.eval === 'blocked' ? 1 : 0)
    let seen = -1
    let quiet = 0
    for (let i = 0; i < 30 && (preViolations < expected || quiet < 4); i++) {
      await new Promise((r) => setTimeout(r, 50))
      if (preViolations === seen) quiet++
      else { seen = preViolations; quiet = 0 }
    }
    document.removeEventListener('securitypolicyviolation', onViolation)
    checks.preViolations = preViolations
    post({ kind: 'probe-frame-ready', checks })
  })
})()
