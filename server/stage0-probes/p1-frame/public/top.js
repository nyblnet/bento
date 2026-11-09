// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// P1 frame probe, the TOP page (a stand-in for the library).
//
// Reads a file the person picks, on this device, and posts its text to a
// sandboxed frame (allow-scripts, NO allow-same-origin: an opaque origin) on
// a different site. The frame (frame.js) boots the file's own code and reports
// what happened back by postMessage. Nothing here sends anything anywhere: the
// only requests are this page's own files (and, in "frame-site worker" mode, a
// hidden frame that installs the frame site's worker).
//
// Modes (sitting A4, the offline frame question):
//   cross-site — <iframe src=FRAME_URL sandbox=…>, served by the frame site.
//   srcdoc     — "worker-served": this page builds the frame from its OWN copy
//                of frame.js (cached by this page's worker, sw-top.js) as a
//                sandboxed srcdoc frame with a meta CSP pinning that script's
//                hash. Works offline when the worker has the files.
//   frame-sw   — the cross-site URL again, but first a hidden frame on the
//                frame site registers ITS worker (sw-frame.js), so offline the
//                frame page can come from that worker, if the browser lets a
//                worker serve a sandboxed cross-site frame. That is the question.

(() => {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const P = window.probe

  // --- where the frame lives -------------------------------------------------
  // frame-url.js: the README's Pages project, or ?frame=<url> (remembered).
  const frameUrl = window.probeFrameUrl
  const frameOrigin = new URL(frameUrl).origin

  // --- this page's worker (offline for srcdoc mode) ----------------------------
  let topSw = 'unsupported'
  if ('serviceWorker' in navigator) {
    topSw = navigator.serviceWorker.controller ? 'controlled' : 'registering'
    navigator.serviceWorker.register('/sw-top.js', { scope: '/' }).then(
      (r) => { if (!navigator.serviceWorker.controller) topSw = r.active ? 'active-not-controlling' : 'installing'; show() },
      (e) => { topSw = 'error: ' + (e && e.message); show() })
  }

  // --- state -------------------------------------------------------------------
  const run = Math.random().toString(36).slice(2, 8)
  const S = {
    mode: 'cross-site', fileOpened: false, frameReady: null, frameReadyMs: null, checks: null,
    boot: 'not started', ev: {}, violations: [], errors: [], swInstall: 'n/a', canary: false, slides: [],
  }
  let frame = null
  let openedAt = 0
  let readyTimer = 0

  const modeSel = $('mode')
  try { const m = localStorage.getItem('probe-p1-mode'); if (m) modeSel.value = m } catch { /* none */ }
  S.mode = modeSel.value
  modeSel.addEventListener('change', () => { S.mode = modeSel.value; try { localStorage.setItem('probe-p1-mode', S.mode) } catch { /* none */ } where() })
  $('frame-first-party').href = new URL('/sw-install', frameOrigin).href
  function where() {
    $('frame-where').textContent = S.mode === 'srcdoc'
      ? 'Frame: this page\'s own copy, as a sandboxed srcdoc frame (opaque origin).'
      : 'Frame site: ' + frameOrigin + ' (sandboxed, opaque origin).'
  }
  where()

  // --- the eight steps (A1) ----------------------------------------------------
  const STEPS = ['open a file', 'it shows', 'present + speaker view', 'fullscreen (F)', 'copy/paste a text box', 'print / save as PDF', 'download', 'insert image + drag a picture']
  const OBS = [null, 'boot', 'popup', 'fullscreen', 'copy', 'print', 'download', 'fileinput']
  const tbl = $('steps')
  tbl.innerHTML = '<tr><th>#</th><th>step</th><th>observed in the frame</th><th>your result</th><th>error text</th></tr>'
  STEPS.forEach((name, i) => {
    const tr = document.createElement('tr')
    tr.innerHTML = `<td>${i + 1}</td><td>${name}</td><td class="muted" data-obs="${i}">-</td>` +
      `<td><select data-step="${i}"><option value="-">-</option><option>worked</option><option>blocked</option><option>error</option></select></td>` +
      `<td><input type="text" data-err="${i}" placeholder="error text"></td>`
    tbl.appendChild(tr)
  })

  // --- picking the file ---------------------------------------------------------
  $('file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0]
    if (!f) return
    const html = await f.text()
    e.target.value = '' // so picking the same file again (another mode) opens it again
    open(html)
  })

  // Extract #bento-doc as data (never into this page's DOM).
  function docBlock(html) {
    const m = /<script\b[^>]*\bid\s*=\s*["']?bento-doc["']?[^>]*>/i.exec(html)
    if (!m) return null
    const start = m.index + m[0].length
    const end = html.toLowerCase().indexOf('</script', start)
    if (end < 0) return null
    return { start, end, text: html.slice(start, end) }
  }

  // Plain text of an element's html, for bentoAgent: tags dropped, entities left.
  const plain = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

  function prepare(html) {
    S.canary = $('canary').checked
    S.slides = []
    const b = docBlock(html)
    let doc = null
    if (b) { try { doc = JSON.parse(b.text) } catch { doc = null } }
    if (doc && Array.isArray(doc.slides)) {
      if (S.canary) {
        const first = doc.slides.find((s) => !s.stateOf) || doc.slides[0]
        if (first) {
          first.elements = first.elements || []
          first.elements.push({
            id: 'probe-canary', type: 'text', x: 40, y: 16, w: 1000, h: 56, rotation: 0, opacity: 1,
            html: 'CANARY-SLIDE-' + run, fontSize: 32, fontFamily: 'system-ui, sans-serif', fontWeight: 700,
            color: '#C0392B', align: 'left', valign: 'top', lineHeight: 1.2,
          })
        }
        // Sharing OFF (on:false), so the planted key is never used and the
        // deck never connects; any real collab block is replaced.
        doc.collab = { on: false, ownerPriv: 'CANARY-OWNERPRIV-' + run }
        html = html.slice(0, b.start) + JSON.stringify(doc).replace(/</g, '\\u003c') + html.slice(b.end)
      }
      S.slides = doc.slides.filter((s) => !s.stateOf).map((s, i) => ({
        slide: i + 1,
        text: (s.elements || []).filter((el) => el && el.type === 'text').map((el) => plain(el.html)).filter(Boolean),
      }))
    } else if (S.canary) {
      S.canary = b && !b.text.trim()
        ? 'this file has no saved document yet (a fresh shell): open it, save it, and use the saved copy'
        : 'not a readable slides deck (encrypted, or another app)'
    }
    return html
  }

  // --- window.bentoAgent (C1 question 4) ------------------------------------------
  // Built only from slide text this page already extracted. It never reads or
  // returns the document's collab block.
  const agent = Object.freeze({
    describe: () => ({ tools: [{ name: 'listSlides', description: 'List the open document\'s slides with their text. Takes no arguments.' }] }),
    listSlides: () => JSON.parse(JSON.stringify(S.slides)),
  })
  Object.defineProperty(window, 'bentoAgent', { value: agent, writable: false, configurable: false })

  // --- the frame ------------------------------------------------------------------
  const SANDBOX = 'allow-scripts allow-popups allow-modals allow-downloads allow-forms'
  const ALLOW = 'fullscreen; clipboard-write'

  async function open(html0) {
    const html = prepare(html0)
    S.fileOpened = true
    S.frameReady = null; S.frameReadyMs = null; S.checks = null; S.boot = 'waiting'; S.ev = {}; S.violations = []; S.errors = []
    if (frame) frame.remove()
    clearTimeout(readyTimer)
    frame = document.createElement('iframe')
    frame.className = 'doc'
    frame.setAttribute('sandbox', SANDBOX)
    frame.setAttribute('allow', ALLOW)
    frame.title = 'document'
    show()
    openedAt = performance.now()
    pendingHtml = html
    if (S.mode === 'srcdoc') {
      let js
      try {
        const r = await fetch('/frame.js', { cache: 'no-cache' })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        js = await r.text()
      } catch (e) { S.boot = 'fail: this page has no copy of frame.js (' + (e && e.message) + ')'; show(); return }
      const hash = await sha256b64(js)
      const csp = `default-src 'none'; script-src 'sha256-${hash}' blob:; style-src 'unsafe-inline' blob: data:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`
      frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8">' +
        `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
        '<meta name="probe-served-by" content="srcdoc"><title>document</title>' +
        '<script>' + js + '</' + 'script></head><body></body></html>'
    } else {
      if (S.mode === 'frame-sw') installFrameWorker()
      frame.src = frameUrl
    }
    $('frame-host').appendChild(frame)
    readyTimer = setTimeout(() => { if (!S.frameReady) { S.frameReady = 'no answer in 10 s'; show() } }, 10000)
    show()
  }
  let pendingHtml = ''

  async function sha256b64(text) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    let s = ''
    for (const b of new Uint8Array(d)) s += String.fromCharCode(b)
    return btoa(s)
  }

  // frame-sw mode: a hidden frame on the frame site registers that site's worker
  // (in this top site's partition). The page is static and ours.
  function installFrameWorker() {
    if (document.getElementById('sw-install')) return
    S.swInstall = 'asked'
    const f = document.createElement('iframe')
    f.id = 'sw-install'
    f.hidden = true
    f.src = new URL('/sw-install', frameOrigin).href
    document.body.appendChild(f)
    setTimeout(() => { if (S.swInstall === 'asked') { S.swInstall = 'no answer'; show() } }, 10000)
  }

  addEventListener('message', (ev) => {
    const d = ev.data
    if (!d || typeof d !== 'object') return
    const swf = document.getElementById('sw-install')
    if (swf && ev.source === swf.contentWindow && d.kind === 'probe-swinstall') { S.swInstall = d.result; show(); return }
    if (!frame || ev.source !== frame.contentWindow) return
    if (d.kind === 'probe-frame-ready') {
      clearTimeout(readyTimer)
      S.frameReady = 'yes'
      S.frameReadyMs = Math.round(performance.now() - openedAt)
      S.checks = d.checks || null
      frame.contentWindow.postMessage({ kind: 'probe-serve', html: pendingHtml }, '*')
    } else if (d.kind === 'probe-ev') {
      const k = String(d.k)
      if (k === 'boot') S.boot = d.v && d.v.ms != null ? 'ok ' + d.v.ms + 'ms' : 'fail: ' + ((d.v && d.v.fail) || '?')
      else if (k === 'csp') { if (S.violations.length < 20) S.violations.push(String(d.v)) }
      else if (k === 'error') { if (S.errors.length < 20) S.errors.push(String(d.v)) }
      else S.ev[k] = String(d.v)
    } else if (d.kind === 'probe-serve-failed') {
      S.boot = 'fail: ' + d.reason
    }
    show()
  })

  // --- rendering + the results line ----------------------------------------------
  function show() {
    $('sw-status').textContent = 'This page\'s worker: ' + topSw + (S.mode === 'frame-sw' ? ' · frame-site worker: ' + S.swInstall : '')
    if (!S.fileOpened) return
    const c = S.checks || {}
    const lines = [
      'frame ready: ' + (S.frameReady || 'waiting') + (S.frameReadyMs != null ? ' (' + S.frameReadyMs + ' ms)' : ''),
      'served by: ' + (c.servedBy || '?') + ' · frame origin: ' + (c.origin || '?'),
      'CSP: self=' + (c.self || '?') + ' blob=' + (c.blob || '?') + ' inline=' + (c.inline || '?') + ' eval=' + (c.eval || '?'),
      'storage in the frame: ' + (c.storage || '?'),
      'document boot: ' + S.boot,
      'events: ' + (Object.entries(S.ev).map(([k, v]) => k + '=' + v).join(', ') || 'none yet'),
      'CSP violations after boot: ' + S.violations.length + (S.violations.length ? ' (' + S.violations.slice(0, 3).join('; ') + ')' : ''),
      'errors: ' + S.errors.length + (S.errors.length ? ' (' + S.errors.slice(0, 2).join('; ') + ')' : ''),
    ]
    if (S.canary) lines.push('canary run: ' + run + (S.canary === true ? '' : ' (' + S.canary + ')'))
    $('observed').textContent = lines.join('\n')
    OBS.forEach((k, i) => {
      if (!k) return
      const cell = tbl.querySelector(`[data-obs="${i}"]`)
      cell.textContent = k === 'boot' ? S.boot : (S.ev[k] || (k === 'copy' && S.ev.paste ? 'paste only' : '-'))
      if (k === 'copy' && S.ev.paste) cell.textContent += ' / paste ' + S.ev.paste
      if (k === 'fileinput' && S.ev.drop) cell.textContent += ' / drop ' + S.ev.drop
    })
  }
  show()

  P.setupCopy(() => {
    const c = S.checks || {}
    const steps = STEPS.map((_, i) => {
      const r = tbl.querySelector(`[data-step="${i}"]`).value
      const err = tbl.querySelector(`[data-err="${i}"]`).value.trim()
      return (i + 1) + ':' + r + (err ? '(' + err.replace(/[,|()]+/g, ' ').replace(/\s+/g, ' ').trim() + ')' : '')
    }).join(',')
    return P.line('P1', [
      ['page', 'main'], ['ua', P.browser()], ['mode', S.mode], ['online', navigator.onLine],
      ['topsw', topSw], ['frame', S.mode === 'srcdoc' ? 'srcdoc' : frameOrigin],
      ['frame-sw', S.mode === 'frame-sw' ? S.swInstall : 'n/a'],
      ['ready', S.fileOpened ? (S.frameReady || 'waiting') + (S.frameReadyMs != null ? ' ' + S.frameReadyMs + 'ms' : '') : 'no file'],
      ['served-by', c.servedBy || '?'], ['origin', c.origin || '?'], ['storage', c.storage || '?'],
      ['csp', 'self:' + (c.self || '?') + ' blob:' + (c.blob || '?') + ' inline:' + (c.inline || '?') + ' eval:' + (c.eval || '?') + ' reported:' + (c.preViolations ?? '?')],
      ['boot', S.boot],
      ['popup', S.ev.popup || '-'], ['fullscreen', S.ev.fullscreen || '-'], ['copy', S.ev.copy || '-'], ['paste', S.ev.paste || '-'],
      ['clipboard', S.ev.clipboard || '-'], ['print', S.ev.print || '-'], ['download', S.ev.download || '-'],
      ['fileinput', S.ev.fileinput || '-'], ['drop', S.ev.drop || '-'],
      ['violations', S.violations.length + (S.violations.length ? ' ' + S.violations.slice(0, 2).join('; ') : '')],
      ['errors', S.errors.length + (S.errors.length ? ' ' + S.errors[0] : '')],
      ['canary', S.canary === true ? 'run-' + run : S.canary ? 'not planted: ' + S.canary : 'off'],
      ['steps', steps], ['notes', $('notes').value || '-'],
    ])
  })
})()
